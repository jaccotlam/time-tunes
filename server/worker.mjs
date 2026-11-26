// Cloudflare adapter of the room server: one Worker that serves the app (static assets
// from app/, see wrangler.jsonc) and the room server, with one Durable Object per room.
// The Durable Object uses the WebSocket Hibernation API (no cost while phones are idle) and
// keeps the room in its own SQLite-backed storage, so a room survives restarts and deploys.
//
// Accounts: one Durable Object per account (class Account, binding ACCOUNTS), addressed by the
// normalised username; a session token carries that name, so the Worker finds the object
// without any index. The password hashing (PBKDF2, ~15 ms CPU) runs inside that object, never
// in the Worker (10 ms CPU per request on the Free plan). The account object reaches its
// prepared rooms through the Room objects (prepCreate / prepOp, see prepared.mjs).
//
// Configuration (wrangler.jsonc "vars" or dashboard: Settings > Variables):
//   ALLOWED_ORIGINS  comma-separated origins that may connect (default: see policy.mjs)
import { DurableObject } from 'cloudflare:workers';
import { RoomHub, randomToken } from './room.mjs';
import { AccountBox } from './accounts.mjs';
import { accountRoute, handleAccount, accountLimiters, accountBodyMax } from './account-http.mjs';
import { prepareRoom, preparedOp } from './prepared.mjs';
import {
  DEFAULT_ORIGINS, parseOrigins, originAllowed, corsHeaders, rateLimiter, route, health, createOptions,
  parseJson, versionMismatch, LIMITS, seatQuery,
} from './policy.mjs';
import { makeCode } from '../app/js/multi/code.js';

// best effort, per Worker instance (Cloudflare can add real rate limiting rules in the dashboard)
const createLimit = rateLimiter(LIMITS.createPerIp);
const socketLimit = rateLimiter(LIMITS.socketsPerIp);
const accountLimits = accountLimiters();

const json = (status, body, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders(origin), 'content-type': 'application/json; charset=utf-8' },
});

async function readBody(request, max) {
  const text = await request.text();
  return text.length > max ? null : text;
}

/** The body as text, but never more than `max` bytes read: null when it is (or says it is) larger. */
async function readCapped(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* gone */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const r = route(request.method === 'OPTIONS' ? 'GET' : request.method, url.pathname);
    const acct = accountRoute(request.method === 'OPTIONS' ? 'GET' : request.method, url.pathname);
    const isServerPath = r.kind !== 'none' || !!acct || /^\/(health|rooms)(\/|$)/.test(url.pathname);
    if (!isServerPath) {
      // everything else is the app itself
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Niet gevonden', { status: 404 });
    }
    const origin = request.headers.get('origin') || '';
    const allowed = parseOrigins(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS);
    if (!originAllowed(origin, allowed)) return json(403, { error: 'origin', message: 'Dit adres mag deze server niet gebruiken.' }, null);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    const ip = request.headers.get('cf-connecting-ip') || '?';

    if (acct) {
      if (!env.ACCOUNTS) return json(404, { code: 'noaccounts', message: 'Deze server kent geen accounts.' }, origin);
      // per Worker instance (best effort), like the other limits here; the real protection is a
      // Cloudflare rate-limiting rule for /account/* in the dashboard
      const text = await readCapped(request, accountBodyMax(request.method, url.pathname));
      if (text == null) return json(413, { code: 'size', message: 'Dit verzoek is te groot.' }, origin);
      const out = await handleAccount(
        { method: request.method, path: url.pathname, auth: request.headers.get('authorization') || '', ip, body: text },
        { boxFor: (key) => ({ call: (op, args) => env.ACCOUNTS.getByName(key).call(key, op, args) }), limiters: accountLimits },
      );
      return json(out.status, out.body, origin);
    }
    if (r.kind === 'health') return json(200, health({ accounts: !!env.ACCOUNTS }), origin);
    if (r.kind === 'badcode' || r.kind === 'none') return json(404, { exists: false, error: 'notfound' }, origin);
    if (r.kind === 'create') {
      const text = await readBody(request, 4096);
      const opts = text == null ? null : createOptions(parseJson(text));
      if (!opts) return json(400, { error: 'bad' }, origin);
      if (opts.versionMismatch) return json(409, versionMismatch, origin);
      if (!createLimit.allow(ip)) return json(429, { error: 'ratelimit', message: 'Te veel nieuwe kamers. Wacht een paar minuten.' }, origin);
      for (let i = 0; i < 12; i++) {
        const code = makeCode();
        const out = await env.ROOMS.getByName(code).create(code, opts);
        if (out.ok) return json(201, { code: out.code, token: out.token }, origin);
        if (out.error !== 'taken') return json(400, { error: out.error || 'bad' }, origin);
      }
      return json(503, { error: 'full', message: 'Geen vrije kamercode gevonden. Probeer het opnieuw.' }, origin);
    }
    if (r.kind === 'info') {
      const info = await env.ROOMS.getByName(r.code).info(r.code);
      return json(info.exists ? 200 : 404, info, origin);
    }
    if (r.kind === 'seat') {
      const text = await readBody(request, 4096);
      const q = seatQuery(text == null ? null : parseJson(text));
      return json(200, { seat: await env.ROOMS.getByName(r.code).seat(r.code, q) }, origin);
    }
    if (r.kind === 'restore') {
      const text = await readBody(request, LIMITS.maxBody);
      const b = text == null ? null : parseJson(text);
      if (!b || typeof b !== 'object') return json(400, { error: 'bad' }, origin);
      if (Number(b.v) !== versionMismatch.v) return json(409, versionMismatch, origin);
      const out = await env.ROOMS.getByName(r.code).restore(r.code, b);
      return out.ok ? json(200, { code: r.code, restored: out.restored }, origin) : json(out.error === 'taken' ? 409 : 400, { error: out.error }, origin);
    }
    if (r.kind === 'ws') {
      if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return json(426, { error: 'upgrade', message: 'Verwacht een WebSocket.' }, origin);
      if (!socketLimit.allow(ip)) return json(429, { error: 'ratelimit' }, origin);
      const fwd = new Request(request);
      fwd.headers.set('x-room-code', r.code);
      return env.ROOMS.getByName(r.code).fetch(fwd);
    }
    return json(404, { error: 'notfound' }, origin);
  },
};

const TICK_MS = 15000;

/** One room. Its id is derived from the room code (getByName). */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = null;
    // answered by Cloudflare itself: the object can stay asleep while phones keep the line open
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const [code, state] = await Promise.all([ctx.storage.get('code'), ctx.storage.get('room')]);
      if (code) this.makeHub(code, state);
    });
  }

  sockets() {
    const out = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.connId) out.set(a.connId, ws);
    }
    return out;
  }

  makeHub(code, state = null) {
    if (this.hub) return this.hub;
    const hub = new RoomHub(code, {
      send: (connId, text) => { try { this.sockets().get(connId)?.send(text); } catch { /* gone */ } },
      drop: (connId, c, reason) => { try { this.sockets().get(connId)?.close(c, reason); } catch { /* gone */ } },
      attach: (connId, rec) => {
        const ws = this.sockets().get(connId);
        // a display ("groot scherm") keeps `screen` here: after hibernation it is a display again
        if (ws) ws.serializeAttachment({ connId, mid: rec.mid, lastSeen: rec.lastSeen, ...(rec.screen ? { screen: true, ...(rec.sid ? { sid: rec.sid } : {}) } : {}) });
      },
      save: (snap) => {
        if (snap) this.ctx.storage.put('room', snap);
        else this.ctx.storage.delete('room');
      },
      lastSeen: (connId) => {
        const ws = this.sockets().get(connId);
        const ts = ws ? this.ctx.getWebSocketAutoResponseTimestamp(ws) : null;
        return ts ? ts.getTime() : 0;
      },
    });
    const conns = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.connId) conns.push({ connId: a.connId, mid: a.mid, screen: a.screen === true, sid: a.sid, lastSeen: Date.now() });
    }
    hub.load(state, conns);
    this.hub = hub;
    if (!this.code) { this.code = code; this.ctx.storage.put('code', code); }
    return hub;
  }

  async schedule() {
    const next = this.hub?.nextTick();
    if (next == null) { await this.ctx.storage.deleteAlarm(); return; }
    const when = this.hub.conns.size ? Math.min(next, Date.now() + TICK_MS) : next;
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > when || (!this.hub.conns.size && cur < when - 60000)) await this.ctx.storage.setAlarm(when);
  }

  async create(code, opts) {
    const hub = this.makeHub(code);
    if (hub.exists()) return { ok: false, error: 'taken' };
    try {
      const out = hub.create(opts);
      await this.schedule();
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: e.code || 'bad' };
    }
  }

  async info(code) {
    return this.makeHub(code).info();
  }

  async seat(code, q) {
    return !!this.makeHub(code).hasSeat(q.id, q.token);
  }

  async restore(code, body) {
    const hub = this.makeHub(code);
    try {
      const out = hub.restore(body.snap, { id: body.id, token: body.token });
      await this.schedule();
      return { ok: true, restored: out.restored };
    } catch (e) {
      return { ok: false, error: e.code || 'bad' };
    }
  }

  /** A prepared room for an account (only the Account object calls this). */
  async prepCreate(code, opts) {
    const hub = this.makeHub(code);
    const out = prepareRoom(hub, opts);
    await this.schedule();
    return out;
  }

  /** An account's operation on its prepared room: summary / edit / reset / open / delete. */
  async prepOp(code, name, args) {
    if (!this.hub?.exists()) return { ok: false, error: 'gone' };
    const out = preparedOp(this.hub, name, args);
    if (!this.hub.exists()) {
      // deleted: forget everything this object stored (the sockets were told and closed)
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.hub = null;
      this.code = null;
      return out;
    }
    await this.schedule();
    return out;
  }

  async fetch(request) {
    const code = request.headers.get('x-room-code');
    const hub = this.makeHub(code);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const connId = randomToken(9);
    server.serializeAttachment({ connId, mid: null, lastSeen: Date.now() });
    hub.open(connId);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment();
    if (!a?.connId || !this.hub) { try { ws.close(4003, 'unknown'); } catch { /* ignore */ } return; }
    // the hub already rolls a failed message back; this is the last net for the object itself
    try { this.hub.message(a.connId, typeof message === 'string' ? message : null); } catch (e) { console.error('room message failed', e?.stack || e); }
    await this.schedule();
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    if (a?.connId && this.hub) this.hub.close(a.connId);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    await this.schedule();
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a?.connId && this.hub) this.hub.close(a.connId);
  }

  async alarm() {
    if (!this.hub) return;
    let expired = false;
    try { ({ expired } = this.hub.tick()); } catch (e) { console.error('room tick failed', e?.stack || e); }
    if (expired || !this.hub.exists()) {
      if (!this.hub.conns.size) { await this.ctx.storage.deleteAll(); this.hub = null; this.code = null; return; }
    }
    await this.schedule();
  }
}

/** The prepared rooms of an account, as the Account object reaches them: through the Room objects. */
function roomsFor(env) {
  return {
    async create(opts) {
      if (opts.code) return env.ROOMS.getByName(opts.code).prepCreate(opts.code, opts);
      for (let i = 0; i < 12; i++) {
        const code = makeCode();
        const out = await env.ROOMS.getByName(code).prepCreate(code, opts);
        if (out.ok || out.error !== 'taken') return out;
      }
      return { ok: false, status: 503, error: 'full', message: 'Geen vrije kamercode gevonden. Probeer het opnieuw.' };
    },
    op: (code, name, args) => env.ROOMS.getByName(code).prepOp(code, name, args),
  };
}

/**
 * One account (its id is derived from the normalised username: getByName). Its record is one
 * value in the object's SQLite-backed storage; an unknown name stores nothing at all.
 */
export class Account extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.box = null;
  }

  async call(key, op, args) {
    if (!this.box) {
      const store = {
        load: () => this.ctx.storage.get('account'),
        save: (rec) => this.ctx.storage.put('account', rec),
        remove: () => this.ctx.storage.deleteAll(),
      };
      this.box = new AccountBox(key, store, roomsFor(this.env));
    }
    if (this.box.key !== key) return { status: 400, body: { code: 'bad', message: 'Ongeldig verzoek.' } };
    return this.box.call(op, args);
  }
}
