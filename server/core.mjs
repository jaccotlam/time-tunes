// The room server for one process (Node), independent of the HTTP/WebSocket library:
// rooms in memory, the small HTTP API, origin checks and rate limits. server/node.mjs
// plugs it into `http` + `ws`; the unit tests drive it with fake sockets.
// (The Cloudflare adapter, server/worker.mjs, uses RoomHub and policy.mjs directly: one
// Durable Object per room.)
//
// Accounts (accounts.mjs, account-http.mjs) live in memory here, and with `accountsFile` also
// on disk, so they and the prepared rooms survive a restart: one small JSON file per account
// and per prepared room in the folder `<accountsFile>.d/` (a-<hex of the name>.json,
// r-<CODE>.json), each written atomically (temp file + rename) and asynchronously a moment
// after it changed; only what changed is written. `accountsFile` itself is a marker { v: 2 };
// an older single file ({ v: 1, accounts, rooms }) is still read and moved into the folder.
// A write that fails (a full disk, data that can not become JSON) never stops the server: it
// is logged once and tried again later. Without a file a restart loses every account and
// prepared room. http() answers the room routes synchronously as before; an /account route
// answers with a Promise of the same { status, headers, body }.
import * as nodeFs from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { RoomHub, PREPARED_IDLE_MS } from './room.mjs';
import { AccountBox, memoryStore, dataQuota, byteLength, PBKDF2_ITERATIONS } from './accounts.mjs';
import { accountRoute, handleAccount, accountLimiters } from './account-http.mjs';
import { prepareRoom, preparedOp } from './prepared.mjs';
import {
  LIMITS, DEFAULT_ORIGINS, parseOrigins, originAllowed, corsHeaders, rateLimiter, route, health, createOptions,
  parseJson, versionMismatch, seatQuery,
} from './policy.mjs';
import { makeFreshCode } from '../app/js/multi/code.js';

/** Run a room handler; an exception stays in that room (logged), it never takes the process down. */
function safely(what, fn) {
  try { return fn(); } catch (e) { console.error(`room ${what} failed:`, e?.stack || e); return undefined; }
}

/** Wait before writing what changed (ms), and before trying a failed write again (doubling up to RETRY_MAX_MS). */
export const WRITE_DELAY_MS = 200;
export const RETRY_MS = 5000;
export const RETRY_MAX_MS = 60_000;

const hex = (s) => Buffer.from(String(s), 'utf8').toString('hex');
const unhex = (h) => Buffer.from(h, 'hex').toString('utf8');

export function createRoomServer({
  origins = DEFAULT_ORIGINS, now = Date.now, limits = {}, log = () => {}, accountsFile = '', iterations = PBKDF2_ITERATIONS, accountLimits = {},
  fs = nodeFs, writeDelay = WRITE_DELAY_MS, retryDelay = RETRY_MS, logError = (...a) => console.error(...a),
} = {}) {
  const L = { ...LIMITS, ...limits };
  const allowed = parseOrigins(origins);
  const rooms = new Map(); // code -> RoomHub
  const sockets = new Map(); // connId -> { code, socket }
  const createLimit = rateLimiter({ ...L.createPerIp, now });
  const requestLimit = rateLimiter({ ...L.requestsPerIp, now });
  const socketLimit = rateLimiter({ ...L.socketsPerIp, now });
  let seq = 0;

  // ---------- accounts + prepared rooms (persisted with accountsFile) ----------
  const accounts = new Map(); // key -> record
  const boxes = new Map(); // key -> AccountBox
  const preparedStates = new Map(); // code -> state of a prepared room (the hub's own object)
  const limiters = accountLimiters({ now, limits: accountLimits });
  // the synced data of all accounts lives in this process: one budget for all of them, and a
  // limit on how much one address may add per day (one flood must not fill it for everybody)
  const quota = dataQuota(L.maxAccountData, { growthPerIp: L.accountGrowthPerIp, now });

  // ---------- the files: one per account / prepared room, only what changed ----------
  const dir = accountsFile ? `${accountsFile}.d` : '';
  const fileOf = (id) => join(dir, id.startsWith('a:') ? `a-${hex(id.slice(2))}.json` : `r-${id.slice(2)}.json`);
  const dirty = new Set(); // 'a:<key>' | 'r:<code>': written at the next write
  const writing = new Set(); // ids an asynchronous write is busy with
  const version = new Map(); // path -> number of the latest write started (an older one never renames over it)
  let legacy = false; // the marker file still has to replace an old single file
  let writeTimer = 0;
  let busy = false;
  let failing = false; // logged once until a write works again
  let retryMs = retryDelay;
  let tmpSeq = 0;

  /** The text of one entry (null: it is gone, remove the file). Throws when it can not become JSON. */
  const textOf = (id) => {
    if (id.startsWith('a:')) {
      const k = id.slice(2);
      return accounts.has(k) ? JSON.stringify({ v: 2, key: k, rec: accounts.get(k) }) : null;
    }
    const code = id.slice(2);
    return preparedStates.has(code) ? JSON.stringify({ v: 2, code, state: preparedStates.get(code) }) : null;
  };
  const markerText = () => JSON.stringify({ v: 2, dir: basename(dir) });
  const failed = (what, e) => {
    if (!failing) logError(`accounts file not written (${what}):`, e?.message || e);
    failing = true;
  };
  const tmpOf = (path) => `${path}.${process.pid}.${++tmpSeq}.tmp`;
  const bump = (path) => { const v = (version.get(path) || 0) + 1; version.set(path, v); return v; };

  /** Write one entry at once (shutdown, tests). */
  function writeSync(id, path = fileOf(id)) {
    const text = id === 'marker' ? markerText() : textOf(id);
    bump(path);
    if (text == null) { try { fs.unlinkSync(path); } catch (e) { if (e?.code !== 'ENOENT') throw e; } return; }
    const tmp = tmpOf(path);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, path); // atomic: a crash leaves the old file or the new one, never half
  }

  /** Write one entry without blocking the server: the text now, the file in the background. */
  async function writeAsync(id, path = fileOf(id)) {
    const text = id === 'marker' ? markerText() : textOf(id);
    const v = bump(path);
    if (text == null) { try { await fs.promises.unlink(path); } catch (e) { if (e?.code !== 'ENOENT') throw e; } return; }
    const tmp = tmpOf(path);
    await fs.promises.writeFile(tmp, text, { mode: 0o600 });
    // a newer write of the same file (flush) went first: this older text must not replace it
    if (version.get(path) !== v) { try { await fs.promises.unlink(tmp); } catch { /* ignore */ } return; }
    fs.renameSync(tmp, path); // sync and right after the check: nothing can come in between
  }

  const scheduleWrite = (ms = writeDelay) => {
    if (!accountsFile || writeTimer || busy) return;
    writeTimer = setTimeout(() => { writeTimer = 0; writeSoon(); }, ms);
    writeTimer.unref?.();
  };
  const mark = (id) => { if (!accountsFile) return; dirty.add(id); scheduleWrite(); };

  async function writeSoon() {
    if (busy || !accountsFile) return;
    busy = true;
    let ok = true;
    try {
      try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { failed('folder', e); ok = false; }
      if (ok) {
        const ids = [...dirty];
        dirty.clear();
        for (const id of ids) {
          writing.add(id);
          try { await writeAsync(id); } catch (e) { ok = false; dirty.add(id); failed(id.startsWith('a:') ? 'an account' : 'a room', e); }
          writing.delete(id);
        }
        // every entry of an old single file is in the folder now: that file becomes the marker
        if (ok && legacy) { try { await writeAsync('marker', accountsFile); legacy = false; } catch (e) { ok = false; failed('marker', e); } }
      }
    } finally { busy = false; }
    if (ok) {
      failing = false;
      retryMs = retryDelay;
      if (dirty.size) scheduleWrite();
    } else {
      scheduleWrite(retryMs); // try again later; the server keeps serving meanwhile
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }

  /** Write everything that changed now, synchronously (Node: before the process stops). Never throws. */
  function writeNow() {
    clearTimeout(writeTimer);
    writeTimer = 0;
    if (!accountsFile) return;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { failed('folder', e); return; }
    let ok = true;
    for (const id of new Set([...dirty, ...writing])) {
      try { writeSync(id); dirty.delete(id); } catch (e) { ok = false; dirty.add(id); failed(id.startsWith('a:') ? 'an account' : 'a room', e); }
    }
    if (ok && legacy) { try { writeSync('marker', accountsFile); legacy = false; } catch (e) { ok = false; failed('marker', e); } }
    if (ok) failing = false;
    else scheduleWrite(retryMs);
  }

  const roomsAdapter = {
    async create(opts) {
      const code = opts.code || makeFreshCode([...rooms.keys()]);
      if (rooms.get(code)?.exists()) return { ok: false, error: 'taken' };
      // prepared rooms have a cap of their own: they live 30 days and must never crowd out normal rooms
      if (preparedStates.size >= L.maxPreparedRooms) return { ok: false, status: 503, error: 'full', message: 'De server is vol. Probeer het later opnieuw.' };
      const out = prepareRoom(hubFor(code), opts);
      if (!out.ok) { if (!rooms.get(code)?.exists()) rooms.delete(code); return out; }
      log('prepare', code);
      return out;
    },
    async op(code, name, args) {
      const hub = rooms.get(code);
      if (!hub) return { ok: false, error: 'gone' };
      const out = preparedOp(hub, name, args);
      if (!hub.exists()) rooms.delete(code);
      return out;
    },
  };

  /** Rooms in memory that are not prepared ones (those count against maxPreparedRooms). */
  const normalRooms = () => rooms.size - preparedStates.size;

  function boxFor(key) {
    let box = boxes.get(key);
    if (!box) {
      if (boxes.size > 5000) for (const [k, b] of boxes) if (!b.rec && !b.locked()) boxes.delete(k);
      box = new AccountBox(key, memoryStore(accounts, key, () => mark(`a:${key}`)), roomsAdapter, { now, iterations, log, quota });
      boxes.set(key, box);
    }
    return box;
  }

  function makeHub(code) {
    let timer = 0;
    const hub = new RoomHub(code, {
        now,
        // only a prepared room is kept (in the accounts file); a normal room stays memory only
        save: (snap) => {
          if (snap?.prepared) preparedStates.set(code, snap);
          else if (!preparedStates.delete(code)) return;
          mark(`r:${code}`);
        },
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

  // the files of an earlier run: accounts, and the prepared rooms that have not expired
  if (accountsFile) {
    const savedAccounts = new Map();
    const savedRooms = new Map();
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') logError('accounts file not read:', e?.message || e); }
    // an old single file (v1): everything in it moves to the folder at the first write
    if (saved && (saved.accounts || saved.rooms)) {
      legacy = true;
      for (const [k, rec] of Object.entries(saved.accounts || {})) { savedAccounts.set(k, rec); dirty.add(`a:${k}`); }
      for (const [code, st] of Object.entries(saved.rooms || {})) { savedRooms.set(code, st); dirty.add(`r:${code}`); }
    }
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (e?.code !== 'ENOENT') logError('accounts folder not read:', e?.message || e); }
    for (const name of names) {
      const m = /^(a|r)-([0-9a-f]+|[A-Z]{4})\.json$/.exec(name);
      if (!m) { if (/\.tmp$/.test(name)) { try { fs.unlinkSync(join(dir, name)); } catch { /* ignore */ } } continue; }
      let j;
      try { j = JSON.parse(fs.readFileSync(join(dir, name), 'utf8')); } catch (e) { logError('accounts file not read:', name, e?.message || e); continue; }
      // a file of the folder is newer than the old single file (written after it)
      if (m[1] === 'a' && typeof j?.key === 'string' && j.key === unhex(m[2])) { savedAccounts.set(j.key, j.rec); dirty.delete(`a:${j.key}`); }
      if (m[1] === 'r' && j?.code === m[2]) { savedRooms.set(j.code, j.state); dirty.delete(`r:${j.code}`); }
    }
    for (const [k, rec] of savedAccounts) {
      if (!rec || typeof rec !== 'object') { dirty.delete(`a:${k}`); continue; }
      accounts.set(k, rec);
      if (rec.data) quota.set(k, byteLength(JSON.stringify(rec.data)));
    }
    for (const [code, st] of savedRooms) {
      if (!st?.prepared || !(now() - (Number(st.lastActive) || 0) < PREPARED_IDLE_MS)) {
        // expired: its file goes at the next write
        dirty.add(`r:${code}`);
        continue;
      }
      const hub = hubFor(code);
      hub.load(st);
      preparedStates.set(code, hub.state);
    }
    if (dirty.size || legacy) scheduleWrite();
  }

  /** req: { method, path, origin, ip, body } -> { status, headers, body } */
  function http(req) {
    const origin = req.origin || '';
    if (!originAllowed(origin, allowed)) return json(403, { error: 'origin', message: 'Dit adres mag deze server niet gebruiken.' }, null);
    if (req.method === 'OPTIONS') return { status: 204, headers: corsHeaders(origin), body: null };
    if (!requestLimit.allow(req.ip || '?')) return json(429, { error: 'ratelimit', message: 'Te veel verzoeken. Wacht even.' }, origin);
    const acct = accountRoute(req.method, req.path);
    if (acct) {
      if (acct.op === 'signup' && accounts.size >= L.maxAccounts) {
        return Promise.resolve(json(503, { code: 'full', message: 'De server is vol: er kunnen geen accounts meer bij. Probeer het later opnieuw.' }, origin));
      }
      // a save learns the address it came from (the per-address growth limit of the quota)
      const ip = req.ip || '?';
      const boxWithIp = (key) => { const box = boxFor(key); return { call: (op, args) => box.call(op, op === 'save' ? { ...args, ip } : args) }; };
      return handleAccount(req, { boxFor: boxWithIp, limiters, log }).then((out) => json(out.status, out.body, origin));
    }
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
      if (normalRooms() >= L.maxRooms) return json(503, { error: 'full', message: 'De server is vol. Probeer het later opnieuw.' }, origin);
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
    if (r.kind === 'seat') {
      if (String(req.body || '').length > 4096) return json(413, { error: 'size' }, origin);
      const q = seatQuery(parseJson(req.body));
      return json(200, { seat: !!rooms.get(r.code)?.hasSeat(q.id, q.token) }, origin);
    }
    if (r.kind === 'restore') {
      if (String(req.body || '').length > L.maxBody) return json(413, { error: 'size' }, origin);
      const b = parseJson(req.body);
      if (!b || typeof b !== 'object') return json(400, { error: 'bad' }, origin);
      if (Number(b.v) !== versionMismatch.v) return json(409, versionMismatch, origin);
      if (!rooms.has(r.code) && normalRooms() >= L.maxRooms) return json(503, { error: 'full' }, origin);
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
    /** Write what changed now, synchronously (Node: before the process stops). */
    flush: writeNow,
    /** Tests: let a background write that is due run now; resolves when nothing is being written. */
    async settle() { if (writeTimer) { clearTimeout(writeTimer); writeTimer = 0; await writeSoon(); } while (busy) await new Promise((r) => setTimeout(r, 1)); },
    get rooms() { return rooms; },
    get accounts() { return accounts; },
    stats: () => ({ rooms: rooms.size, sockets: sockets.size }),
  };
}
