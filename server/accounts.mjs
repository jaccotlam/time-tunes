// User accounts ("gebruikers", "inloggen") for the room server, independent of where they
// are stored: the same rules run in the Node adapter (memory + optional JSON file, see
// core.mjs) and in Cloudflare (one SQLite-backed Durable Object per account, see worker.mjs).
//
// An account is one record, addressed by its normalised username:
//   { v, uid, name, key, createdAt, pw, rc, sessions: { <sha256 of secret>: { at, seen, exp } },
//     fails: { n, since, until }, rev, data, rooms: [{ code, name, at }] }
// - pw: "pbkdf2-sha256$<iterations>$<salt>$<hash>" (WebCrypto PBKDF2-SHA-256, 100 000
//   iterations: the most a Cloudflare Worker allows; ~15 ms of CPU, so on Cloudflare it runs
//   inside the account's Durable Object (30 s CPU per request) and never in the Worker itself,
//   whose Free plan allows 10 ms of CPU per request).
// - rc: the recovery code, shown once at sign-up, stored as a salted SHA-256 (it holds 80
//   random bits, a slow hash adds nothing there).
// - a session token is "tta1.<key>.<secret>": the key tells the Worker which account object to
//   ask (no global index needed), the secret (32 random bytes) is stored only as its SHA-256.
//   Sessions live 90 days after their last use (sliding), at most MAX_SESSIONS per account.
// - data: what the app syncs (Spotify Client ID, own playlists, small preferences), validated
//   field by field and capped at MAX_DATA_BYTES; `rev` goes up by one on every save, and a save
//   with an older rev is refused with the current data (the client merges and saves again).
// - rooms: the prepared rooms of this account (the room itself lives in the room server; the
//   `rooms` adapter below reaches it).
//
// Storage is a tiny interface: { load() -> record | null, save(record), remove() } (async
// allowed). Prepared rooms go through an adapter: { create(opts) -> {ok, code, room} | {ok:false, error},
// op(code, name, args) -> result }. AccountBox runs every operation of one account one at a
// time, so two requests never interleave across an `await` (PBKDF2 is async).
import { sha256Hex } from './sha256.mjs';
import { cleanPlaylist, cleanTrack, NAME_MAX, MAX_TRACKS, BUILTIN_ID } from '../app/js/playlist-logic.js';
import { cleanName as cleanPlayerName } from '../app/js/multi/game.js';

export const PBKDF2_ITERATIONS = 100000; // Cloudflare's maximum for PBKDF2 in WebCrypto
export const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 12 * 60 * 60 * 1000; // a used session is stored again at most twice a day
export const MAX_SESSIONS = 20;
export const MAX_DATA_BYTES = 1024 * 1024; // a few full playlists (a 500-song list is ~200 kB)
export const MAX_PLAYLISTS = 50;
export const MAX_PREPARED_ROOMS = 5;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/;
export const RESERVED_NAMES = [
  'admin', 'administrator', 'root', 'system', 'server', 'support', 'help', 'moderator', 'mod',
  'timetunesr', 'timetunes', 'time-tunes', 'spelleider', 'api', 'account', 'accounts', 'health',
  'rooms', 'kamer', 'me', 'null', 'undefined', 'anonymous', 'gast', 'guest',
];
export const LOGIN_FAILS = { limit: 10, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };
export const ROOM_NAME_MAX = 40;
const TOKEN_RE = /^tta1\.([a-z0-9_-]{3,24})\.([A-Za-z0-9_-]{43})$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SPOTIFY_ID_RE = /^[0-9a-f]{32}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** An error answer: { status, body: { code, message } } (Dutch message for the user). */
export const fail = (status, code, message, extra = {}) => ({ status, body: { code, message, ...extra } });
const ok = (body, status = 200) => ({ status, body });

export const MESSAGES = {
  login: 'Gebruikersnaam of wachtwoord klopt niet.',
  locked: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.',
  session: 'Je bent uitgelogd. Log opnieuw in.',
  taken: 'Deze gebruikersnaam is al bezet. Kies een andere.',
  recover: 'Gebruikersnaam of herstelcode klopt niet.',
};

// ---------- small helpers ----------
const enc = new TextEncoder();
const b64url = (bytes) => {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s) => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export const byteLength = (s) => enc.encode(s).length;

/** Constant-time comparison of two strings (or byte arrays): the time does not depend on where they differ. */
export function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Does this value (parsed JSON) hold a key like "__proto__" anywhere? Such data is refused. */
export function hasBadKeys(v, depth = 0) {
  if (depth > 12) return true;
  if (!v || typeof v !== 'object') return false;
  for (const k of Object.keys(v)) {
    if (BAD_KEYS.has(k)) return true;
    if (hasBadKeys(v[k], depth + 1)) return true;
  }
  return false;
}

// ---------- username / password ----------
export const normalizeUsername = (name) => String(name ?? '').trim().toLowerCase();

/** null when the username may be used, else the Dutch reason. */
export function usernameProblem(name) {
  const s = String(name ?? '').trim();
  if (s.length < 3) return 'Een gebruikersnaam heeft minstens 3 tekens.';
  if (s.length > 24) return 'Een gebruikersnaam heeft hoogstens 24 tekens.';
  if (!USERNAME_RE.test(s)) return 'Gebruik alleen letters (zonder accenten), cijfers, _ en -.';
  if (RESERVED_NAMES.includes(s.toLowerCase())) return 'Deze gebruikersnaam is niet beschikbaar. Kies een andere.';
  return null;
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Een wachtwoord heeft minstens ${PASSWORD_MIN} tekens.`;
  if (pw.length > PASSWORD_MAX) return `Een wachtwoord heeft hoogstens ${PASSWORD_MAX} tekens.`;
  return null;
}

async function pbkdf2(password, salt, iterations) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** "pbkdf2-sha256$<iterations>$<salt>$<hash>" */
export async function hashPassword(password, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

const DUMMY_SALT = new Uint8Array(16);
/** Check a password against a stored hash (constant-time compare). No stored hash: the same work, false. */
export async function verifyPassword(password, stored, { iterations = PBKDF2_ITERATIONS } = {}) {
  const m = /^pbkdf2-sha256\$(\d{1,6})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(String(stored || ''));
  const it = m ? Math.min(Number(m[1]), PBKDF2_ITERATIONS) : iterations;
  const hash = await pbkdf2(String(password ?? ''), m ? unb64url(m[2]) : DUMMY_SALT, it || 1);
  return !!m && timingSafeEqual(hash, unb64url(m[3]));
}

// ---------- recovery code / tokens ----------
const RC_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
/** "ABCD-EFGH-JKMN-PQRS": 16 characters of 31 (~79 bits). */
export function newRecoveryCode() {
  const b = randomBytes(16);
  const chars = [...b].map((x) => RC_ALPHABET[x % RC_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
export const cleanRecoveryCode = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const recoveryHash = (uid, code) => sha256Hex(`timetunesr-recovery:${uid}:${cleanRecoveryCode(code)}`);
const sessionHash = (secret) => sha256Hex(`timetunesr-session:${secret}`);

export function makeToken(key) {
  const secret = b64url(randomBytes(32));
  return { token: `tta1.${key}.${secret}`, secret };
}
/** "tta1.<key>.<secret>" -> { key, secret } or null (also for an Authorization header "Bearer …"). */
export function parseToken(value) {
  const s = String(value ?? '').trim().replace(/^Bearer\s+/i, '');
  const m = TOKEN_RE.exec(s);
  return m ? { key: m[1], secret: m[2] } : null;
}

// ---------- account data ----------
const ALLOWED_PLAYLIST = ['id', 'name', 'created', 'updated', 'nextN', 'tracks', 'shareId', 'partsSeen', 'partsTotal'];
const TRACK_STRINGS = ['title', 'artist', 'album'];
const okTime = (v) => Number.isFinite(v) && v >= 0 && v < 1e14;

/** One playlist in the app's own format, checked field by field. Returns { value } or { error }. */
export function validatePlaylist(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'Een playlist is geen object.' };
  if (typeof p.id !== 'string' || !PLAYLIST_ID_RE.test(p.id) || p.id === BUILTIN_ID) return { error: 'Een playlist heeft een ongeldige id.' };
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > NAME_MAX) return { error: `De playlist "${String(p.name ?? '').slice(0, 40)}" heeft een ongeldige naam.` };
  if (!okTime(p.updated) || (p.created != null && !okTime(p.created))) return { error: `De playlist "${p.name}" heeft een ongeldige datum.` };
  if (p.nextN != null && !(Number.isInteger(p.nextN) && p.nextN > 0)) return { error: `De playlist "${p.name}" is beschadigd.` };
  if (!Array.isArray(p.tracks) || p.tracks.length > MAX_TRACKS) return { error: `De playlist "${p.name}" heeft te veel of ongeldige nummers.` };
  const seen = new Set();
  for (const t of p.tracks) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: `Een nummer in "${p.name}" is ongeldig.` };
    if (!(Number.isInteger(t.n) && t.n > 0) || seen.has(t.n)) return { error: `Een nummer in "${p.name}" heeft een ongeldig kaartnummer.` };
    seen.add(t.n);
    for (const k of TRACK_STRINGS) if (t[k] != null && (typeof t[k] !== 'string' || t[k].length > 200)) return { error: `Een nummer in "${p.name}" is ongeldig.` };
    if (t.year != null && !Number.isInteger(t.year)) return { error: `Een nummer in "${p.name}" heeft een ongeldig jaar.` };
    for (const k of ['previewUrl', 'trackViewUrl']) if (t[k] != null && (typeof t[k] !== 'string' || !/^https:\/\/[^\s"'<>]{4,600}$/.test(t[k]))) return { error: `Een nummer in "${p.name}" heeft een ongeldig adres.` };
    if (!cleanTrack(t)) return { error: `Een nummer in "${p.name}" kan nergens worden afgespeeld.` };
  }
  if (p.shareId != null && (typeof p.shareId !== 'string' || !/^[0-9a-z]{4,12}$/.test(p.shareId))) return { error: `De playlist "${p.name}" is beschadigd.` };
  // known fields only: anything else is dropped (never stored)
  const known = Object.fromEntries(ALLOWED_PLAYLIST.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  const value = cleanPlaylist(known);
  value.updated = p.updated;
  return { value };
}

export function validatePrefs(p) {
  if (p == null) return { value: {} };
  if (typeof p !== 'object' || Array.isArray(p)) return { error: 'Ongeldige voorkeuren.' };
  const out = {};
  if (p.hostName != null) {
    if (typeof p.hostName !== 'string' || p.hostName.length > 60) return { error: 'Ongeldige naam als spelleider.' };
    const n = cleanPlayerName(p.hostName, '');
    if (n) out.hostName = n;
  }
  if (p.hostPlays != null) {
    if (typeof p.hostPlays !== 'boolean') return { error: 'Ongeldige voorkeur voor meespelen.' };
    out.hostPlays = p.hostPlays;
  }
  if (p.music != null) {
    if (!musicOk(p.music)) return { error: 'Ongeldige muziekkeuze.' };
    out.music = p.music;
  }
  return { value: out };
}

const musicOk = (m) => m === 'deck' || m === 'mix' || (typeof m === 'string' && PLAYLIST_ID_RE.test(m) && m !== BUILTIN_ID);

/**
 * The part of the data a save sends (any of the sections), checked. Returns { value } (only
 * the sections that were sent) or { error }. The Spotify value must be a Client ID (32
 * hexadecimal characters, the form the app checks): a token or anything else is refused.
 */
export function validateData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: 'Ongeldige gegevens.' };
  if (hasBadKeys(d)) return { error: 'Ongeldige gegevens.' };
  const out = {};
  for (const k of Object.keys(d)) if (!['spotifyClientId', 'playlists', 'deleted', 'prefs'].includes(k)) return { error: `Onbekend onderdeel "${k.slice(0, 30)}".` };
  if ('spotifyClientId' in d) {
    const v = d.spotifyClientId;
    if (v === '' || v == null) out.spotifyClientId = '';
    else if (typeof v === 'string' && SPOTIFY_ID_RE.test(v.toLowerCase())) out.spotifyClientId = v.toLowerCase();
    else return { error: 'Dit is geen Spotify Client ID (32 tekens, 0-9 en a-f). Een wachtwoord, secret of token wordt nooit bewaard.' };
  }
  if ('playlists' in d) {
    if (!Array.isArray(d.playlists) || d.playlists.length > MAX_PLAYLISTS) return { error: `Hoogstens ${MAX_PLAYLISTS} playlists.` };
    const ids = new Set();
    out.playlists = [];
    for (const p of d.playlists) {
      const r = validatePlaylist(p);
      if (r.error) return r;
      if (ids.has(r.value.id)) return { error: 'Twee playlists hebben dezelfde id.' };
      ids.add(r.value.id);
      out.playlists.push(r.value);
    }
  }
  if ('deleted' in d) {
    const del = d.deleted;
    if (!del || typeof del !== 'object' || Array.isArray(del)) return { error: 'Ongeldige gegevens.' };
    const entries = Object.entries(del);
    if (entries.length > 500) return { error: 'Ongeldige gegevens.' };
    out.deleted = {};
    for (const [id, at] of entries) {
      if (!PLAYLIST_ID_RE.test(id) || !okTime(at)) return { error: 'Ongeldige gegevens.' };
      out.deleted[id] = at;
    }
  }
  if ('prefs' in d) {
    const r = validatePrefs(d.prefs);
    if (r.error) return r;
    out.prefs = r.value;
  }
  return { value: out };
}

export const emptyData = () => ({ spotifyClientId: '', playlists: [], deleted: {}, prefs: {} });

// ---------- prepared rooms (the options; the room server keeps the room itself) ----------
export const cleanRoomName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);

/**
 * Options of a prepared room from the app: { name, settings, music, play, hostPlays, hostName }.
 * `partial` (an edit): only the fields that were sent. Returns { value } or { error }.
 */
export function validateRoomOptions(o, { partial = false } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || hasBadKeys(o)) return { error: 'Ongeldige kamer.' };
  const out = {};
  if (!partial || 'name' in o) {
    const n = cleanRoomName(o.name);
    if (typeof o.name !== 'string' || !n) return { error: 'Geef de kamer een naam.' };
    if (o.name.trim().length > ROOM_NAME_MAX) return { error: `Een kamernaam heeft hoogstens ${ROOM_NAME_MAX} tekens.` };
    out.name = n;
  }
  if (!partial || 'settings' in o) {
    if (o.settings != null && (typeof o.settings !== 'object' || Array.isArray(o.settings))) return { error: 'Ongeldige spelinstellingen.' };
    out.settings = o.settings || {};
  }
  if (!partial || 'music' in o) {
    const m = o.music ?? 'deck';
    if (!musicOk(m)) return { error: 'Kies de muziek: het TimeTunesr-deck, een eigen playlist of de mix van de groep.' };
    out.music = m;
  }
  if (!partial || 'play' in o) out.play = o.play === 'spotify' ? 'spotify' : 'preview';
  if (!partial || 'hostPlays' in o) out.hostPlays = o.hostPlays === true;
  if (!partial || 'hostName' in o) out.hostName = cleanPlayerName(typeof o.hostName === 'string' ? o.hostName : '', 'Spelleider');
  return { value: out };
}

// ---------- failure counters (per account in the record, per unknown name / per IP in memory) ----------
/** Counts failures in a window; blocked() while the count is over the limit (until the lock ends). */
export function failCounter({ limit, windowMs, lockMs = windowMs, now = Date.now, maxKeys = 10000 }) {
  const map = new Map();
  const cur = (key) => {
    const t = now();
    const f = map.get(key);
    if (!f) return null;
    if (f.until && t >= f.until) { map.delete(key); return null; }
    if (!f.until && t - f.since > windowMs) { map.delete(key); return null; }
    return f;
  };
  return {
    blocked: (key) => !!cur(key)?.until,
    fail(key) {
      const t = now();
      let f = cur(key);
      if (!f) {
        if (map.size >= maxKeys) map.clear();
        f = { n: 0, since: t, until: 0 };
        map.set(key, f);
      }
      if (++f.n >= limit) f.until = t + lockMs;
    },
    reset: (key) => { map.delete(key); },
  };
}

// ---------- one account ----------
/** What the account remembers of a prepared room, enough to make it again when it is gone. */
const roomOptions = (room) => ({
  settings: room.settings || {}, music: room.music, play: room.play, hostPlays: !!room.hostPlays, hostName: room.hostName,
});

export class AccountBox {
  /**
   * key: the normalised username; store: { load, save, remove }; rooms: the prepared-room
   * adapter (optional); opts: { now, iterations, log }.
   */
  constructor(key, store, rooms = null, { now = Date.now, iterations = PBKDF2_ITERATIONS, log = () => {} } = {}) {
    this.key = key;
    this.store = store;
    this.rooms = rooms;
    this.now = now;
    this.iterations = iterations;
    this.log = log;
    this.rec = undefined; // undefined = not loaded yet, null = no account
    this.chain = Promise.resolve();
    // failures for a name without an account (not stored: nothing to keep), so an unknown name
    // gets locked exactly like a real one and a lock tells nothing
    this.ghostFails = { n: 0, since: 0, until: 0 };
  }

  /** Run one operation (op name -> method) after the ones before it. Always resolves { status, body }. */
  call(op, args = {}) {
    const run = async () => {
      if (!OPS.includes(op)) return fail(404, 'notfound', 'Onbekend verzoek.');
      try {
        if (this.rec === undefined) this.rec = (await this.store.load()) || null;
        return await this[`op_${op}`](args);
      } catch (e) {
        console.error('account operation failed:', op, e?.message || e); // never args: they hold passwords
        return fail(500, 'server', 'Er ging iets mis op de server. Probeer het opnieuw.');
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async persist() { await this.store.save(this.rec); }

  exists() { return !!this.rec; }

  // ----- failures (lockout) -----
  failsOf() { return this.rec ? (this.rec.fails ||= { n: 0, since: 0, until: 0 }) : this.ghostFails; }
  locked() {
    const f = this.failsOf();
    return !!f.until && this.now() < f.until;
  }
  async addFail() {
    const f = this.failsOf();
    const t = this.now();
    if ((f.until && t >= f.until) || t - f.since > LOGIN_FAILS.windowMs) { f.n = 0; f.since = t; f.until = 0; }
    f.n++;
    if (f.n >= LOGIN_FAILS.limit) f.until = t + LOGIN_FAILS.lockMs;
    if (this.rec) await this.persist();
  }
  async clearFails() {
    const f = this.failsOf();
    if (!f.n && !f.until) return;
    f.n = 0; f.since = 0; f.until = 0;
    if (this.rec) await this.persist();
  }

  // ----- sessions -----
  newSession() {
    const t = this.now();
    const { token, secret } = makeToken(this.key);
    const s = (this.rec.sessions ||= {});
    s[sessionHash(secret)] = { at: t, seen: t, exp: t + SESSION_MS };
    const ids = Object.keys(s);
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => s[a].seen - s[b].seen);
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete s[id];
    }
    return token;
  }

  dropExpired() {
    const t = this.now();
    let n = 0;
    for (const [id, s] of Object.entries(this.rec?.sessions || {})) if (!(s.exp > t)) { delete this.rec.sessions[id]; n++; }
    return n;
  }

  /** The session of this secret (sliding expiry), or null. */
  async session(secret) {
    if (!this.rec || typeof secret !== 'string') return null;
    const h = sessionHash(secret);
    const s = this.rec.sessions || {};
    let found = null;
    for (const id of Object.keys(s)) if (timingSafeEqual(id, h)) found = id; // compare every one, same time
    const t = this.now();
    if (!found) return null;
    if (!(s[found].exp > t)) { delete s[found]; await this.persist(); return null; }
    if (t - s[found].seen > SESSION_TOUCH_MS) {
      s[found].seen = t;
      s[found].exp = t + SESSION_MS;
      this.dropExpired();
      await this.persist();
    }
    return found;
  }

  async authed(args, fn) {
    const sid = await this.session(args.secret);
    if (!sid) return fail(401, 'session', MESSAGES.session);
    return fn(sid);
  }

  profile() {
    const r = this.rec;
    return { username: r.name, createdAt: r.createdAt, sessions: Object.keys(r.sessions || {}).length, rooms: (r.rooms || []).length };
  }

  // ----- operations -----
  async op_signup({ username, password }) {
    const problem = usernameProblem(username) || passwordProblem(password);
    if (problem) return fail(400, 'bad', problem);
    if (normalizeUsername(username) !== this.key) return fail(400, 'bad', 'Ongeldige gebruikersnaam.');
    if (this.rec) return fail(409, 'taken', MESSAGES.taken);
    const t = this.now();
    const uid = `u${b64url(randomBytes(12))}`;
    const recoveryCode = newRecoveryCode();
    this.rec = {
      v: 1,
      uid,
      name: String(username).trim(),
      key: this.key,
      createdAt: t,
      pw: await hashPassword(password, { iterations: this.iterations }),
      rc: recoveryHash(uid, recoveryCode),
      sessions: {},
      fails: { n: 0, since: 0, until: 0 },
      rev: 1,
      data: emptyData(),
      rooms: [],
    };
    if (this.ghostFails.until && t < this.ghostFails.until) this.rec.fails = { ...this.ghostFails };
    const token = this.newSession();
    await this.persist();
    return ok({ token, recoveryCode, account: this.profile() }, 201);
  }

  async op_login({ password }) {
    if (this.locked()) return fail(429, 'locked', MESSAGES.locked);
    // an unknown name costs the same PBKDF2 work as a real one
    const good = await verifyPassword(password, this.rec?.pw, { iterations: this.iterations });
    if (!good || !this.rec) { await this.addFail(); return fail(401, 'login', MESSAGES.login); }
    await this.clearFails();
    this.dropExpired();
    const token = this.newSession();
    await this.persist();
    return ok({ token, account: this.profile() });
  }

  async op_recover({ recoveryCode, password }) {
    const problem = passwordProblem(password);
    if (problem) return fail(400, 'bad', problem);
    if (this.locked()) return fail(429, 'locked', MESSAGES.locked);
    const good = !!this.rec && timingSafeEqual(recoveryHash(this.rec.uid, recoveryCode), this.rec.rc || '');
    if (!good) { await this.addFail(); return fail(401, 'recover', MESSAGES.recover); }
    // a new password, every session ends, and the used code is replaced by a new one
    const next = newRecoveryCode();
    this.rec.pw = await hashPassword(password, { iterations: this.iterations });
    this.rec.rc = recoveryHash(this.rec.uid, next);
    this.rec.sessions = {};
    this.rec.fails = { n: 0, since: 0, until: 0 };
    const token = this.newSession();
    await this.persist();
    return ok({ token, recoveryCode: next, account: this.profile() });
  }

  op_logout(args) {
    return this.authed(args, async (sid) => {
      delete this.rec.sessions[sid];
      await this.persist();
      return ok({ ok: true });
    });
  }

  op_logoutAll(args) {
    return this.authed(args, async () => {
      const n = Object.keys(this.rec.sessions).length;
      this.rec.sessions = {};
      await this.persist();
      return ok({ ok: true, revoked: n });
    });
  }

  op_password(args) {
    return this.authed(args, async (sid) => {
      const problem = passwordProblem(args.newPassword);
      if (problem) return fail(400, 'bad', problem);
      if (this.locked()) return fail(429, 'locked', MESSAGES.locked);
      if (!(await verifyPassword(args.password, this.rec.pw, { iterations: this.iterations }))) {
        await this.addFail();
        return fail(401, 'password', 'Je huidige wachtwoord klopt niet.');
      }
      this.rec.pw = await hashPassword(args.newPassword, { iterations: this.iterations });
      // every other device is logged out; this one stays
      const keep = this.rec.sessions[sid];
      const revoked = Object.keys(this.rec.sessions).length - 1;
      this.rec.sessions = { [sid]: keep };
      this.rec.fails = { n: 0, since: 0, until: 0 };
      await this.persist();
      return ok({ ok: true, revoked });
    });
  }

  op_get(args) {
    return this.authed(args, async () => ok({ account: this.profile(), rev: this.rec.rev, data: this.rec.data }));
  }

  op_save(args) {
    return this.authed(args, async () => {
      if (!Number.isInteger(args.rev)) return fail(400, 'bad', 'Geef de versie (rev) van je gegevens mee.');
      if (args.rev !== this.rec.rev) {
        return fail(409, 'conflict', 'Je account is intussen op een ander toestel gewijzigd.', { rev: this.rec.rev, data: this.rec.data });
      }
      const r = validateData(args.data);
      if (r.error) return fail(400, 'data', r.error);
      const next = { ...emptyData(), ...this.rec.data, ...r.value };
      // a tombstone older than 180 days is forgotten
      const cutoff = this.now() - 180 * 24 * 60 * 60 * 1000;
      next.deleted = Object.fromEntries(Object.entries(next.deleted || {}).filter(([, at]) => at > cutoff));
      if (byteLength(JSON.stringify(next)) > MAX_DATA_BYTES) return fail(413, 'size', `Je gegevens zijn te groot om te bewaren (meer dan ${Math.round(MAX_DATA_BYTES / 1024)} kB). Maak een playlist kleiner of verwijder er een.`);
      this.rec.data = next;
      this.rec.rev++;
      await this.persist();
      return ok({ rev: this.rec.rev, data: this.rec.data });
    });
  }

  op_delete(args) {
    return this.authed(args, async () => {
      if (this.locked()) return fail(429, 'locked', MESSAGES.locked);
      if (!(await verifyPassword(args.password, this.rec.pw, { iterations: this.iterations }))) {
        await this.addFail();
        return fail(401, 'password', 'Je wachtwoord klopt niet.');
      }
      let rooms = 0;
      for (const r of this.rec.rooms || []) {
        try { const out = await this.rooms?.op(r.code, 'delete', { account: this.rec.uid }); if (out?.ok) rooms++; } catch { /* the room goes by itself later */ }
      }
      this.rec = null;
      await this.store.remove();
      return ok({ ok: true, rooms });
    });
  }

  // ----- prepared rooms -----
  ownRoom(code) { return (this.rec.rooms || []).find((r) => r.code === code) || null; }

  op_rooms(args) {
    return this.authed(args, async () => {
      const out = [];
      for (const ref of this.rec.rooms || []) out.push(await this.roomSummary(ref));
      return ok({ rooms: out, max: MAX_PREPARED_ROOMS });
    });
  }

  async roomSummary(ref) {
    let s = null;
    try { s = await this.rooms?.op(ref.code, 'summary', { account: this.rec.uid }); } catch { s = null; }
    if (s?.ok) {
      if (s.room.name !== ref.name) { ref.name = s.room.name; ref.options = roomOptions(s.room); await this.persist(); }
      return { ...s.room, exists: true };
    }
    // gone (expired, or the server lost it): "Nog een keer gebruiken" makes it again with this code when it is free
    return { code: ref.code, name: ref.name, exists: false, createdAt: ref.at };
  }

  op_roomCreate(args) {
    return this.authed(args, async () => {
      if (!this.rooms) return fail(501, 'norooms', 'Deze server kan geen kamers klaarzetten.');
      if ((this.rec.rooms || []).length >= MAX_PREPARED_ROOMS) return fail(409, 'limit', `Je kunt hoogstens ${MAX_PREPARED_ROOMS} kamers klaarzetten. Verwijder er eerst een.`);
      const v = validateRoomOptions(args.room);
      if (v.error) return fail(400, 'bad', v.error);
      const out = await this.rooms.create({ ...v.value, account: this.rec.uid });
      if (!out?.ok) return fail(out?.status || 503, out?.error || 'full', out?.message || 'Er kon nu geen kamer worden gemaakt. Probeer het opnieuw.');
      (this.rec.rooms ||= []).push({ code: out.room.code, name: out.room.name, at: this.now(), options: roomOptions(out.room) });
      await this.persist();
      return ok({ room: { ...out.room, exists: true } }, 201);
    });
  }

  roomOp(args, name, extra = {}) {
    return this.authed(args, async () => {
      const ref = this.ownRoom(String(args.code || ''));
      // a code that is not this account's: the same answer as an unknown one
      if (!ref) return fail(404, 'notfound', 'Deze kamer staat niet bij jouw kamers.');
      const out = await this.rooms?.op(ref.code, name, { account: this.rec.uid, ...extra });
      if (out?.ok) {
        if (out.room) { ref.name = out.room.name; ref.options = roomOptions(out.room); await this.persist(); }
        const { ok: _ok, ...rest } = out;
        return ok(out.room ? { ...rest, room: { ...out.room, exists: true } } : rest);
      }
      if (out?.error === 'gone' && name === 'reset') {
        // the room is gone: make it again with the same code (when nobody else has it now)
        const opts = { settings: {}, music: 'deck', play: 'preview', hostPlays: false, hostName: 'Spelleider', ...(ref.options || {}) };
        const again = await this.rooms.create({ ...opts, name: ref.name, account: this.rec.uid, code: ref.code });
        if (again?.ok) { ref.options = roomOptions(again.room); await this.persist(); return ok({ room: { ...again.room, exists: true }, recreated: true }); }
        return fail(409, 'gone', 'Deze kamercode is niet meer vrij. Verwijder de kamer en zet een nieuwe klaar.');
      }
      if (out?.error === 'gone') return fail(410, 'gone', 'Deze kamer bestaat niet meer (verlopen). Kies "Nog een keer gebruiken" of verwijder hem.');
      return fail(out?.status || 400, out?.error || 'bad', out?.message || 'Dat lukte niet.');
    });
  }

  op_roomEdit(args) {
    const v = validateRoomOptions(args.patch, { partial: true });
    if (v.error) return this.authed(args, async () => fail(400, 'bad', v.error));
    return this.roomOp(args, 'edit', { patch: v.value });
  }
  op_roomReset(args) { return this.roomOp(args, 'reset'); }
  op_roomOpen(args) { return this.roomOp(args, 'open'); }

  op_roomDelete(args) {
    return this.authed(args, async () => {
      const ref = this.ownRoom(String(args.code || ''));
      if (!ref) return fail(404, 'notfound', 'Deze kamer staat niet bij jouw kamers.');
      try { await this.rooms?.op(ref.code, 'delete', { account: this.rec.uid }); } catch { /* gone already */ }
      this.rec.rooms = this.rec.rooms.filter((r) => r !== ref);
      await this.persist();
      this.log('unprepare', ref.code);
      return ok({ ok: true });
    });
  }
}

const OPS = ['signup', 'login', 'recover', 'logout', 'logoutAll', 'password', 'get', 'save', 'delete', 'rooms', 'roomCreate', 'roomEdit', 'roomReset', 'roomOpen', 'roomDelete'];
export const ACCOUNT_OPS = OPS.slice();

/** A store in memory (tests, Node without a file): { load, save, remove } over one map entry. */
export function memoryStore(map, key, onChange = () => {}) {
  return {
    load: async () => (map.has(key) ? structuredClone(map.get(key)) : null),
    save: async (rec) => { map.set(key, structuredClone(rec)); onChange(); },
    remove: async () => { map.delete(key); onChange(); },
  };
}

