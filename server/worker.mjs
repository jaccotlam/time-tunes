// Cloudflare adapter of the room server: one Worker that serves the app (static assets
// from app/, see wrangler.jsonc) and the room server, with one Durable Object per room.
// The Durable Object uses the WebSocket Hibernation API (no cost while phones are idle) and
// keeps the room in its own SQLite-backed storage, so a room survives restarts and deploys.
//
// Configuration (wrangler.jsonc "vars" or dashboard: Settings > Variables):
//   ALLOWED_ORIGINS  comma-separated origins that may connect (default: see policy.mjs)
import { DurableObject } from 'cloudflare:workers';
import { RoomHub, randomToken } from './room.mjs';
import {
  DEFAULT_ORIGINS, parseOrigins, originAllowed, corsHeaders, rateLimiter, route, health, createOptions,
  parseJson, versionMismatch, LIMITS,
} from './policy.mjs';
import { makeCode } from '../app/js/multi/code.js';

// best effort, per Worker instance (Cloudflare can add real rate limiting rules in the dashboard)
const createLimit = rateLimiter(LIMITS.createPerIp);
const socketLimit = rateLimiter(LIMITS.socketsPerIp);

const json = (status, body, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders(origin), 'content-type': 'application/json; charset=utf-8' },
});

async function readBody(request, max) {
  const text = await request.text();
  return text.length > max ? null : text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const r = route(request.method === 'OPTIONS' ? 'GET' : request.method, url.pathname);
    const isServerPath = r.kind !== 'none' || /^\/(health|rooms)(\/|$)/.test(url.pathname);
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

    if (r.kind === 'health') return json(200, health(), origin);
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
        if (ws) ws.serializeAttachment({ connId, mid: rec.mid, lastSeen: rec.lastSeen });
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
      if (a?.connId) conns.push({ connId: a.connId, mid: a.mid, lastSeen: Date.now() });
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
