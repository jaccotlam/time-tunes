// Shared rules of the room server for both adapters: allowed origins, CORS, simple rate
// limits, request routing and the JSON answers of the small HTTP API.
//
//   GET  /health                 -> { ok, v, service }
//   POST /rooms                  -> { code, token }      body { v, id, name?, hostPlays?, settings? }
//   POST /rooms/CODE/restore     -> { code, restored }   body { v, id, token, snap }
//   GET  /rooms/CODE             -> { exists, phase, players, leaderOnline } (404 when unknown)
//   GET  /rooms/CODE/ws          -> WebSocket (Upgrade)
import { SERVER_PROTOCOL_VERSION, MAX_CLIENT_MESSAGE } from '../app/js/multi/server-protocol.js';
import { isValidCode } from '../app/js/multi/code.js';

export const SERVICE = 'timetunesr-rooms';
export const DEFAULT_ORIGINS = [
  'https://jaccotlam.github.io',
  'https://time-tunes.jaccotlam.workers.dev',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

/** "a,b c" or an array -> list of origin patterns ("*" as port or as whole entry). */
export function parseOrigins(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(value ?? '').trim();
  return s ? s.split(/[\s,]+/).filter(Boolean) : DEFAULT_ORIGINS.slice();
}

/**
 * Is a browser on `origin` allowed? A request without Origin (not from a web page: curl,
 * a health check) is allowed: an Origin check only protects against other web sites.
 */
export function originAllowed(origin, patterns = DEFAULT_ORIGINS) {
  if (!origin) return true;
  const o = String(origin).toLowerCase().replace(/\/+$/, '');
  return patterns.some((p) => {
    const pat = p.toLowerCase().replace(/\/+$/, '');
    if (pat === '*') return true;
    if (pat.endsWith(':*')) {
      const base = pat.slice(0, -2);
      return o === base || (o.startsWith(`${base}:`) && /^\d{1,5}$/.test(o.slice(base.length + 1)));
    }
    return o === pat;
  });
}

export function corsHeaders(origin) {
  const h = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin) {
    h['access-control-allow-origin'] = origin;
    h.vary = 'Origin';
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-max-age'] = '600';
  }
  return h;
}

/** Fixed-window counter per key (an IP address): allow(key) -> true while under the limit. */
export function rateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10000 }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      let h = hits.get(key);
      if (!h || t - h.start > windowMs) {
        if (hits.size >= maxKeys) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear();
        h = { start: t, n: 0 };
        hits.set(key, h);
      }
      h.n++;
      return h.n <= limit;
    },
  };
}

export const LIMITS = {
  createPerIp: { limit: 30, windowMs: 10 * 60 * 1000 },
  requestsPerIp: { limit: 300, windowMs: 60 * 1000 },
  socketsPerIp: { limit: 60, windowMs: 60 * 1000 },
  maxBody: MAX_CLIENT_MESSAGE * 4, // a restore holds the whole room including its songs
  maxRooms: 1000, // Node: rooms in memory at the same time
};

/** Which endpoint is this? -> { kind: 'health'|'create'|'restore'|'info'|'ws'|'none', code? } */
export function route(method, pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/health' && (method === 'GET' || method === 'HEAD')) return { kind: 'health' };
  if (p === '/rooms' && method === 'POST') return { kind: 'create' };
  let m = p.match(/^\/rooms\/([A-Za-z]{4})(\/ws|\/restore)?$/);
  if (m) {
    const code = m[1].toUpperCase();
    if (!isValidCode(code)) return { kind: 'badcode' };
    if (!m[2] && method === 'GET') return { kind: 'info', code };
    if (m[2] === '/ws' && method === 'GET') return { kind: 'ws', code };
    if (m[2] === '/restore' && method === 'POST') return { kind: 'restore', code };
  }
  m = p.match(/^\/rooms(\/|$)/);
  if (m) return { kind: 'badcode' };
  return { kind: 'none' };
}

export const health = () => ({ ok: true, v: SERVER_PROTOCOL_VERSION, service: SERVICE });

/** Body of POST /rooms -> options for RoomHub.create, or null. */
export function createOptions(body) {
  if (!body || typeof body !== 'object') return null;
  if (Number(body.v) !== SERVER_PROTOCOL_VERSION) return { versionMismatch: true };
  return {
    ownerId: String(body.id || ''),
    name: typeof body.name === 'string' ? body.name : '',
    hostPlays: body.hostPlays === true,
    settings: body.settings && typeof body.settings === 'object' ? body.settings : {},
  };
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export const versionMismatch = {
  error: 'version',
  message: 'De server en de app hebben een andere versie. Ververs de pagina.',
  v: SERVER_PROTOCOL_VERSION,
};
