// The room server for one process (Node), independent of the HTTP/WebSocket library:
// rooms in memory, the small HTTP API, origin checks and rate limits. server/node.mjs
// plugs it into `http` + `ws`; the unit tests drive it with fake sockets.
// (The Cloudflare adapter, server/worker.mjs, uses RoomHub and policy.mjs directly: one
// Durable Object per room.)
import { RoomHub } from './room.mjs';
import {
  LIMITS, DEFAULT_ORIGINS, parseOrigins, originAllowed, corsHeaders, rateLimiter, route, health, createOptions,
  parseJson, versionMismatch,
} from './policy.mjs';
import { makeFreshCode } from '../app/js/multi/code.js';

/** Run a room handler; an exception stays in that room (logged), it never takes the process down. */
function safely(what, fn) {
  try { return fn(); } catch (e) { console.error(`room ${what} failed:`, e?.stack || e); return undefined; }
}

export function createRoomServer({ origins = DEFAULT_ORIGINS, now = Date.now, limits = {}, log = () => {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const allowed = parseOrigins(origins);
  const rooms = new Map(); // code -> RoomHub
  const sockets = new Map(); // connId -> { code, socket }
  const createLimit = rateLimiter({ ...L.createPerIp, now });
  const requestLimit = rateLimiter({ ...L.requestsPerIp, now });
  const socketLimit = rateLimiter({ ...L.socketsPerIp, now });
  let seq = 0;

  function makeHub(code) {
    let timer = 0;
    const hub = new RoomHub(code, {
        now,
        // Quiz: look at the question again right when its clock says so
        wake: (at) => {
          clearTimeout(timer);
          if (at == null) return;
          timer = setTimeout(() => safely('tick', () => hub.tick()), Math.max(0, at - now()) + 5);
          timer.unref?.();
        },
        send: (connId, text) => { try { sockets.get(connId)?.socket.send(text); } catch { /* gone */ } },
        drop: (connId, c, reason) => {
          const s = sockets.get(connId);
          sockets.delete(connId);
          // let a last message (error) leave before the socket closes
          if (s) setTimeout(() => { try { s.socket.close(c, reason); } catch { /* ignore */ } }, 50);
        },
      });
    return hub;
  }

  function hubFor(code) {
    let hub = rooms.get(code);
    if (!hub) { hub = makeHub(code); rooms.set(code, hub); }
    return hub;
  }

  const json = (status, body, origin) => ({ status, headers: { ...corsHeaders(origin), 'content-type': 'application/json; charset=utf-8' }, body });

  /** req: { method, path, origin, ip, body } -> { status, headers, body } */
  function http(req) {
    const origin = req.origin || '';
    if (!originAllowed(origin, allowed)) return json(403, { error: 'origin', message: 'Dit adres mag deze server niet gebruiken.' }, null);
    if (req.method === 'OPTIONS') return { status: 204, headers: corsHeaders(origin), body: null };
    if (!requestLimit.allow(req.ip || '?')) return json(429, { error: 'ratelimit', message: 'Te veel verzoeken. Wacht even.' }, origin);
    const r = route(req.method, req.path);
    if (r.kind === 'health') return json(200, { ...health(), rooms: rooms.size }, origin);
    if (r.kind === 'badcode') return json(404, { exists: false, error: 'notfound' }, origin);
    if (r.kind === 'info') {
      const hub = rooms.get(r.code);
      const info = hub ? hub.info() : { exists: false };
      return json(info.exists ? 200 : 404, info, origin);
    }
    if (r.kind === 'create') {
      if (String(req.body || '').length > 4096) return json(413, { error: 'size' }, origin);
      const opts = createOptions(parseJson(req.body));
      if (!opts) return json(400, { error: 'bad' }, origin);
      if (opts.versionMismatch) return json(409, versionMismatch, origin);
      if (!createLimit.allow(req.ip || '?')) return json(429, { error: 'ratelimit', message: 'Te veel nieuwe kamers. Wacht een paar minuten.' }, origin);
      if (rooms.size >= L.maxRooms) return json(503, { error: 'full', message: 'De server is vol. Probeer het later opnieuw.' }, origin);
      const code = makeFreshCode([...rooms.keys()]);
      try {
        const out = hubFor(code).create(opts);
        log('create', code);
        return json(201, out, origin);
      } catch (e) {
        rooms.delete(code);
        return json(400, { error: e.code || 'bad' }, origin);
      }
    }
    if (r.kind === 'restore') {
      if (String(req.body || '').length > L.maxBody) return json(413, { error: 'size' }, origin);
      const b = parseJson(req.body);
      if (!b || typeof b !== 'object') return json(400, { error: 'bad' }, origin);
      if (Number(b.v) !== versionMismatch.v) return json(409, versionMismatch, origin);
      if (!rooms.has(r.code) && rooms.size >= L.maxRooms) return json(503, { error: 'full' }, origin);
      const fresh = !rooms.has(r.code);
      try {
        const out = hubFor(r.code).restore(b.snap, { id: b.id, token: b.token });
        log('restore', r.code, out.restored);
        return json(200, out, origin);
      } catch (e) {
        if (fresh) rooms.delete(r.code);
        return json(e.code === 'taken' ? 409 : 400, { error: e.code || 'bad' }, origin);
      }
    }
    return json(404, { error: 'notfound' }, origin);
  }

  /**
   * A WebSocket wants to connect to room `code`. Call before accepting the upgrade:
   * returns { ok: false, status, reason } (refuse) or { ok: true, attach(socket) }.
   * attach(socket) with socket = { send(text), close(code, reason) } returns
   * { message(text), closed() } for the adapter to call.
   */
  function upgrade({ path, origin, ip }) {
    if (!originAllowed(origin, allowed)) return { ok: false, status: 403, reason: 'origin' };
    const r = route('GET', path);
    if (r.kind !== 'ws') return { ok: false, status: 404, reason: 'notfound' };
    if (!socketLimit.allow(ip || '?')) return { ok: false, status: 429, reason: 'ratelimit' };
    return {
      ok: true,
      attach(socket) {
        const connId = `s${++seq}`;
        sockets.set(connId, { code: r.code, socket });
        // an unknown room: the hub answers the hello with "notfound" (a browser can not read an HTTP error of an upgrade)
        const hub = rooms.get(r.code) || makeHub(r.code);
        hub.open(connId);
        return {
          message: (text) => { if (sockets.has(connId)) safely('message', () => hub.message(connId, text)); },
          closed: () => { sockets.delete(connId); safely('close', () => hub.close(connId)); },
        };
      },
    };
  }

  /** Housekeeping, every few seconds: dead connections, expired rooms. */
  function sweep() {
    for (const [code, hub] of [...rooms]) {
      const { expired } = safely('tick', () => hub.tick()) || {};
      if (expired || !hub.exists()) { rooms.delete(code); log('expire', code); }
    }
  }

  return {
    http,
    upgrade,
    sweep,
    get rooms() { return rooms; },
    stats: () => ({ rooms: rooms.size, sockets: sockets.size }),
  };
}
