// The HTTP side of the accounts (accounts.mjs), shared by both adapters: routes, body
// checks, the per-IP limits and which account object a request goes to. The adapter only
// supplies boxFor(key) -> { call(op, args) } (Node: an AccountBox in memory; Cloudflare: the
// account's Durable Object) and turns { status, body } into a response with the server's CORS
// headers (policy.mjs). All answers are JSON; errors are { code, message } (Dutch message).
//
//   POST /account/signup            {username, password}             -> 201 {token, recoveryCode, account}
//   POST /account/login             {username, password}             -> 200 {token, account}
//   POST /account/recover           {username, recoveryCode, password} -> 200 {token, recoveryCode, account}
//   POST /account/logout            (Bearer)                         -> 200 {ok}
//   POST /account/logout-all        (Bearer)                         -> 200 {ok, revoked}
//   POST /account/password          (Bearer) {password, newPassword}  -> 200 {ok, revoked}
//   GET  /account                   (Bearer)                         -> 200 {account, rev, data}
//   POST /account/data              (Bearer) {rev, data}             -> 200 {rev, data} | 409 {code:'conflict', rev, data}
//   POST /account/delete            (Bearer) {password}              -> 200 {ok, rooms}
//   GET  /account/rooms             (Bearer)                         -> 200 {rooms, max}
//   POST /account/rooms             (Bearer) {name, settings, music, play, hostPlays, hostName} -> 201 {room}
//   POST /account/rooms/CODE        (Bearer) {any of those fields}   -> 200 {room}
//   POST /account/rooms/CODE/reset  (Bearer)                         -> 200 {room, recreated?}
//   POST /account/rooms/CODE/open   (Bearer)                         -> 200 {code, id, token, room}
//   POST /account/rooms/CODE/delete (Bearer)                         -> 200 {ok}
// Bearer = header "Authorization: Bearer tta1.<username>.<secret>".
import {
  normalizeUsername, usernameProblem, parseToken, failCounter, fail, MESSAGES, MAX_DATA_BYTES, USERNAME_RE,
} from './accounts.mjs';
import { rateLimiter } from './policy.mjs';
import { isValidCode } from '../app/js/multi/code.js';

export const ACCOUNT_LIMITS = {
  signupPerIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  failsPerIp: { limit: 30, windowMs: 15 * 60 * 1000 },
  smallBody: 8 * 1024,
  dataBody: Math.ceil(MAX_DATA_BYTES * 1.5), // the data plus JSON overhead; the account checks the real size
};

const NO_TOKEN = ['signup', 'login', 'recover'];

/** Which account endpoint is this? -> { op, code? } (op null: an unknown /account path), or null when not an account path. */
export function accountRoute(method, pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (!/^\/account(\/|$)/.test(p)) return null;
  const POST = method === 'POST';
  const GET = method === 'GET';
  const simple = {
    '/account/signup': POST && 'signup',
    '/account/login': POST && 'login',
    '/account/recover': POST && 'recover',
    '/account/logout': POST && 'logout',
    '/account/logout-all': POST && 'logoutAll',
    '/account/password': POST && 'password',
    '/account': GET && 'get',
    '/account/data': POST && 'save',
    '/account/delete': POST && 'delete',
    '/account/rooms': (GET && 'rooms') || (POST && 'roomCreate'),
  };
  if (Object.hasOwn(simple, p)) return { op: simple[p] || null };
  const m = p.match(/^\/account\/rooms\/([A-Za-z]{4})(?:\/(reset|open|delete))?$/);
  if (m && POST && isValidCode(m[1].toUpperCase())) {
    return { op: m[2] ? { reset: 'roomReset', open: 'roomOpen', delete: 'roomDelete' }[m[2]] : 'roomEdit', code: m[1].toUpperCase() };
  }
  return { op: null };
}

/** The per-IP limits of one adapter (per process on Node, per Worker instance on Cloudflare). */
export function accountLimiters({ now = Date.now, limits = {} } = {}) {
  const L = { ...ACCOUNT_LIMITS, ...limits };
  return {
    L,
    signup: rateLimiter({ ...L.signupPerIp, now }),
    fails: failCounter({ ...L.failsPerIp, now }),
  };
}

function parseBody(text) {
  if (text == null || text === '') return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * Handle one account request. req: { method, path, auth, ip, body } (body: the text, already
 * size-checked against maxBody(op) by the adapter or here). ctx: { boxFor(key), limiters, log }.
 * Resolves { status, body }.
 */
export async function handleAccount(req, { boxFor, limiters, log = () => {} }) {
  const r = accountRoute(req.method, req.path);
  if (!r?.op) return fail(404, 'notfound', 'Onbekend verzoek.');
  const { L } = limiters;
  const max = r.op === 'save' ? L.dataBody : L.smallBody;
  if (String(req.body ?? '').length > max) return fail(413, 'size', 'Dit verzoek is te groot.');
  const body = parseBody(req.body);
  if (!body) return fail(400, 'bad', 'Ongeldig verzoek.');
  const ip = req.ip || '?';
  const str = (v) => (typeof v === 'string' ? v : '');

  let key;
  let args;
  if (NO_TOKEN.includes(r.op)) {
    if (limiters.fails.blocked(ip)) return fail(429, 'ratelimit', 'Te veel mislukte pogingen vanaf dit netwerk. Probeer het over een kwartier opnieuw.');
    const username = str(body.username);
    if (r.op === 'signup') {
      const problem = usernameProblem(username);
      if (problem) return fail(400, 'username', problem);
      if (!limiters.signup.allow(ip)) return fail(429, 'ratelimit', 'Te veel nieuwe accounts vanaf dit netwerk. Probeer het later opnieuw.');
    } else if (!USERNAME_RE.test(username.trim())) {
      // a name that can not exist: the same answer as a wrong password
      limiters.fails.fail(ip);
      return r.op === 'login' ? fail(401, 'login', MESSAGES.login) : fail(401, 'recover', MESSAGES.recover);
    }
    key = normalizeUsername(username);
    args = { username, password: str(body.password), recoveryCode: str(body.recoveryCode) };
  } else {
    const t = parseToken(req.auth);
    if (!t) return fail(401, 'session', MESSAGES.session);
    key = t.key;
    args = { secret: t.secret };
    if (r.op === 'password') Object.assign(args, { password: str(body.password), newPassword: str(body.newPassword) });
    if (r.op === 'delete') args.password = str(body.password);
    if (r.op === 'save') Object.assign(args, { rev: body.rev, data: body.data });
    if (r.op === 'roomCreate') args.room = body;
    if (r.code) args.code = r.code;
    if (r.op === 'roomEdit') args.patch = body;
  }
  const out = await boxFor(key).call(r.op, args);
  if (out.status === 401 && ['login', 'recover', 'password'].includes(out.body?.code)) limiters.fails.fail(ip);
  log('account', r.op, out.status); // never the name, a password or a token
  return out;
}
