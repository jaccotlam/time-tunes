// The Deezer catalogue (read-only, no key, no login): search playlists, read a playlist's
// songs, one song's release year and a fresh 30-second preview.
//
// Transport: Deezer's API sends no CORS headers, so fetch() cannot read it. It does offer
// JSONP. A JSONP answer is a script from a third party, so it never runs in this page: it
// runs inside ONE hidden sandboxed iframe (sandbox="allow-scripts", no allow-same-origin,
// srcdoc). That frame has an opaque origin, so the script cannot touch this app's
// localStorage (Spotify and account tokens), cookies or DOM. The frame hands the answer back
// as a JSON string with postMessage; we accept messages only from that frame's window, with a
// request id we made, and treat the payload as untrusted data: every field below is
// type-checked, length-capped and rebuilt into a fresh plain object.
//
// Rate: Deezer allows 50 requests per 5 s per IP. One queue starts at most ~8 requests per
// second, and at most MAX_IN_FLIGHT wait for an answer at the same time (a slow connection
// holds the queue instead of piling up requests that all time out); the quota error (code 4,
// HTTP 200) pauses the queue and retries.
//
// The frame is not trusted for long: it is replaced after a malformed answer (wrong shape,
// too big, not JSON), after FRAME_MAX_REQUESTS requests, and after 3 timeouts in a row. Each
// request belongs to the frame it was sent to: when that frame goes, its requests fail at once.
import { MAX_TRACKS, validYear } from './playlist-logic.js';
import { cleanSpotifyTitle } from './spotify-playlists.js';

export const API = 'https://api.deezer.com';
const GAP_MS = 125; // ~8 per second: 40 per 5 s, under Deezer's 50
const TIMEOUT_MS = 12000;
const READY_TIMEOUT_MS = 8000;
const QUOTA_WAIT_MS = 5500; // Deezer's window is 5 s
const RETRIES = 4;
const PAGE = 100; // songs per page (verified to work)
const MAX_PAYLOAD = 3_000_000; // characters of JSON per answer
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MAX = 300;
const MAX_IN_FLIGHT = 6; // requests waiting for an answer at the same time
const FRAME_MAX_REQUESTS = 200; // a frame is replaced after this many requests
const FRAME_TIMEOUTS = 3; // ... or after this many timeouts in a row

/** Deezer user "Deezer Charts": the official charts as playlists (100 songs each). */
export const CHARTS = {
  nl: 1266971851, world: 3155776842, be: 1266968331, de: 1111143121, uk: 1111142221, us: 1313621735,
};

/** Quick picks for the playlist search: a chart playlist or a search term. */
export const FEATURED = Object.freeze([
  { key: 'top-nl', label: 'Top Nederland', emoji: '🇳🇱', playlistId: CHARTS.nl },
  { key: 'top-world', label: 'Top wereldwijd', emoji: '🌍', playlistId: CHARTS.world },
  { key: 'top40', label: 'Top 40', emoji: '📻', query: 'Top 40' },
  { key: 'hardcore', label: 'Hardcore', emoji: '🔨', query: 'Hardcore' },
  { key: '80s', label: 'Jaren 80', emoji: '📼', query: 'Jaren 80' },
  { key: '90s', label: 'Jaren 90', emoji: '💿', query: 'Jaren 90' },
  { key: '00s', label: 'Jaren 00', emoji: '📱', query: 'Jaren 00' },
  { key: 'nl', label: 'Nederlandstalig', emoji: '🌷', query: 'Nederlandstalig' },
  { key: 'party', label: 'Feest', emoji: '🎉', query: 'Feest' },
  { key: 'apres-ski', label: 'Après-ski', emoji: '⛷️', query: 'Après-ski' },
  { key: 'carnaval', label: 'Carnaval', emoji: '🎭', query: 'Carnaval' },
  { key: 'xmas', label: 'Kerst', emoji: '🎄', query: 'Kerst' },
  { key: 'rock', label: 'Rock', emoji: '🎸', query: 'Rock' },
  { key: 'hiphop', label: 'Hiphop', emoji: '🎤', query: 'Hiphop' },
  { key: 'disco', label: 'Disco', emoji: '🪩', query: 'Disco' },
  { key: 'foute-uur', label: 'Foute uur', emoji: '🙈', query: 'Foute uur' },
].map((f) => Object.freeze(f)));

export class DeezerError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = 'DeezerError';
    this.code = code; // offline | timeout | quota | notfound | unavailable | aborted
    Object.assign(this, extra);
  }
}

export const MESSAGES = {
  offline: 'Geen internetverbinding. Controleer je verbinding en probeer het opnieuw.',
  timeout: 'Deezer reageert niet. Probeer het zo nog eens.',
  quota: 'Deezer krijgt even te veel vragen van dit toestel. Wacht een paar seconden en probeer het opnieuw.',
  notfound: 'Deze playlist of dit nummer bestaat niet (meer) bij Deezer.',
  unavailable: 'Deezer is even niet bereikbaar of gaf een onverwacht antwoord. Probeer het later opnieuw.',
  aborted: 'Gestopt.',
};
export const errorMessage = (e) => MESSAGES[e?.code] || MESSAGES.unavailable;

/* ---------- validation of untrusted answers ---------- */

const has = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
/** Own property only: never a value inherited through a `__proto__` key or a polluted prototype. */
const own = (o, k) => (has(o, k) ? o[k] : undefined);
const isObj = (o) => o != null && typeof o === 'object' && !Array.isArray(o);

/** Positive safe integer (a number, or a string of digits), else null. */
export function posId(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Plain one-line text, control characters out, capped. Not escaped: screens escape on output. */
export function text(v, max = 200) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

const nonNegInt = (v, max = 10_000_000) => (Number.isSafeInteger(v) && v >= 0 ? Math.min(v, max) : null);

/** https URL on Deezer's CDN (*.dzcdn.net), else null: previews and pictures only come from there. */
export function dzUrl(v) {
  if (typeof v !== 'string' || v.length > 1200) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!u.hostname.endsWith('.dzcdn.net')) return null;
  return u.href;
}

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
export function cleanIsrc(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return ISRC_RE.test(s) ? s : null;
}

/** Year of a Deezer date ("1982-04-08"; "0000-00-00" when unknown), else null. */
export function dateYear(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})(?:-\d{2}(?:-\d{2})?)?$/);
  const y = m ? Number(m[1]) : NaN;
  return validYear(y) ? y : null;
}

/** "Song (Remastered 2011)", "Song - 2011 Remaster" -> "Song" (like cleanSpotifyTitle). */
export function cleanTitle(title) {
  const t = cleanSpotifyTitle(title);
  const out = t.replace(/\s*[([](?:\d{4}\s+)?(?:digital(?:ly)?\s+)?(?:remaster(?:ed)?|remastered version|mono|stereo|single version|radio edit|album version|original mix)\b[^)\]]*[)\]]\s*$/i, '').trim();
  return out || t;
}

function cleanPlaylistItem(p) {
  if (!isObj(p)) return null;
  const id = posId(own(p, 'id'));
  if (!id || own(p, 'public') === false) return null;
  const user = own(p, 'user') ?? own(p, 'creator');
  return {
    id,
    title: text(own(p, 'title'), 120) || 'Deezer-playlist',
    count: nonNegInt(own(p, 'nb_tracks'), 1_000_000),
    by: isObj(user) ? text(own(user, 'name'), 80) : '',
    picture: dzUrl(own(p, 'picture_medium')) || dzUrl(own(p, 'picture_big')) || null,
  };
}

function cleanTrackItem(t) {
  if (!isObj(t)) return null;
  const deezerId = posId(own(t, 'id'));
  if (!deezerId || own(t, 'readable') === false) return null;
  const artist = own(t, 'artist');
  const album = own(t, 'album');
  const title = cleanTitle(text(own(t, 'title_short'), 200) || text(own(t, 'title'), 200));
  if (!title) return null;
  return {
    deezerId,
    title,
    artist: isObj(artist) ? text(own(artist, 'name'), 200) : '',
    album: isObj(album) ? text(own(album, 'title'), 200) : '',
    isrc: cleanIsrc(own(t, 'isrc')),
    readable: true,
  };
}

/* ---------- queue ---------- */

let gapMs = GAP_MS;
let maxInFlight = MAX_IN_FLIGHT;
let nextAt = 0;
let pausedUntil = 0;
let pumping = false;
let inFlight = 0; // requests handed to the transport that have not settled yet
const waiters = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const abortError = () => new DeezerError('aborted');

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (waiters.length && inFlight < maxInFlight) {
      const wait = Math.max(nextAt, pausedUntil) - Date.now();
      if (wait > 0) { await sleep(wait); continue; }
      if (inFlight >= maxInFlight) break;
      const w = waiters.shift();
      nextAt = Date.now() + gapMs;
      inFlight++; // released by done() in request()
      w.resolve();
    }
  } finally { pumping = false; }
}

/** A request of ours has settled: room for the next one. */
function release() {
  inFlight = Math.max(0, inFlight - 1);
  pump();
}

/** Requests waiting for an answer now (tests). */
export const inFlightCount = () => inFlight;

/** Wait for our turn (urgent: ahead of the background work, e.g. a preview at play time). */
function slot(signal, urgent = false) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const w = {
      resolve: () => { signal?.removeEventListener?.('abort', onAbort); resolve(); },
    };
    const onAbort = () => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(abortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (urgent) waiters.unshift(w); else waiters.push(w);
    pump();
  });
}

/** Milliseconds until the queue runs again after a quota error (0 when it runs). */
export const pausedFor = () => Math.max(0, pausedUntil - Date.now());

/* ---------- JSONP in a sandboxed frame ---------- */

// Runs in the sandbox (opaque origin). It loads the JSONP script and returns the answer as a
// JSON string, so whatever the remote script does, the page only ever receives plain text.
const FRAME_SCRIPT = `(function () {
  var MAX = ${MAX_PAYLOAD};
  addEventListener('message', function (ev) {
    if (ev.source !== parent) return;
    var m = ev.data;
    if (!m || m.tt !== 'dz-req' || typeof m.id !== 'string' || typeof m.url !== 'string' || !/^dzcb[0-9a-z]{6,40}$/.test(m.cb)) return;
    var target = ev.origin && ev.origin !== 'null' ? ev.origin : '*';
    // only Deezer's API, whatever the message says (defence in depth: only the parent sends these)
    if (m.url.length > 2000 || m.url.indexOf('${API}/') !== 0) { parent.postMessage({ tt: 'dz-res', id: m.id, ok: false, data: 'url' }, target); return; }
    var done = false;
    var s = document.createElement('script');
    function reply(ok, data) {
      if (done) return;
      done = true;
      try { delete window[m.cb]; } catch (e) { window[m.cb] = undefined; }
      if (s.parentNode) s.parentNode.removeChild(s);
      parent.postMessage({ tt: 'dz-res', id: m.id, ok: ok, data: data }, target);
    }
    window[m.cb] = function (d) {
      var json;
      try { json = JSON.stringify(d); } catch (e) { reply(false, 'json'); return; }
      if (typeof json !== 'string' || json.length > MAX) { reply(false, 'size'); return; }
      reply(true, json);
    };
    s.onload = function () { setTimeout(function () { reply(false, 'nocallback'); }, 0); };
    s.onerror = function () { reply(false, 'network'); };
    s.src = m.url;
    document.head.appendChild(s);
  });
  parent.postMessage({ tt: 'dz-ready' }, '*');
})();`;

let frame = null; // the current frame: { el, win, ready, pending: Map, sent, timeouts, dead }
const frames = new Set(); // every frame still in the page (the current one, and retired ones finishing their requests)
const pending = new Map(); // id -> { frame, resolve, reject }
let listening = false;

/** Tests: the frame script, to run in a fake sandbox. */
export const _FRAME_SCRIPT = FRAME_SCRIPT;

const randomId = (n = 16) => {
  const c = globalThis.crypto;
  if (c?.getRandomValues) return Array.from(c.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('');
  return Array.from({ length: n }, () => Math.floor(Math.random() * 36).toString(36)).join('');
};

const REASONS = ['json', 'size', 'nocallback', 'network', 'url'];

function onMessage(ev) {
  let f = null;
  for (const x of frames) if (ev.source === x.win) { f = x; break; }
  if (!f) return; // only our frames
  const m = ev.data;
  if (isObj(m) && m.tt === 'dz-ready' && Object.keys(m).length === 1) { f.markReady?.(); return; }
  const p = isObj(m) && typeof m.id === 'string' ? pending.get(m.id) : null;
  if (isObj(m) && m.tt === 'dz-res' && typeof m.id === 'string' && !p) return; // late (timed out) or a guess: nothing to answer
  if (p && p.frame !== f) return; // an answer for another frame's request
  // from here on the message must be exactly what FRAME_SCRIPT sends; anything else means the
  // frame is not ours any more (a hostile remote script): it goes, with its open requests
  const bad = (reason) => { p?.reject(new DeezerError('unavailable', { reason })); destroyFrame(f, 'unavailable'); };
  if (!p || m.tt !== 'dz-res' || typeof m.ok !== 'boolean') { bad('message'); return; }
  if (m.ok !== true) {
    if (!REASONS.includes(m.data)) { bad('message'); return; }
    p.reject(new DeezerError(m.data === 'network' && globalThis.navigator?.onLine === false ? 'offline' : 'unavailable', { reason: m.data }));
    return;
  }
  if (typeof m.data !== 'string' || m.data.length > MAX_PAYLOAD) { bad('payload'); return; }
  let json;
  try { json = JSON.parse(m.data); } catch { bad('payload'); return; }
  f.timeouts = 0;
  p.resolve(json);
}

/** Remove a frame; its open requests fail at once (with `code`). */
function destroyFrame(f = frame, code = 'unavailable') {
  if (!f || f.dead) return;
  f.dead = true;
  frames.delete(f);
  if (frame === f) frame = null;
  if (f.el?.parentNode) f.el.parentNode.removeChild(f.el);
  f.failReady?.();
  for (const p of [...f.pending.values()]) p.reject(new DeezerError(code, { reason: 'frame' }));
}

/** A frame that has answered enough: new requests go to a fresh one; it leaves once its own are done. */
function retire(f) {
  if (frame === f) frame = null;
  if (!f.open) destroyFrame(f);
}

function getFrame() {
  if (frame && !frame.dead && frame.sent < FRAME_MAX_REQUESTS) return frame;
  if (frame) retire(frame);
  if (!listening) { window.addEventListener('message', onMessage); listening = true; }
  const el = document.createElement('iframe');
  el.setAttribute('sandbox', 'allow-scripts');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('tabindex', '-1');
  el.setAttribute('title', 'Deezer');
  el.dataset.testid = 'deezer-frame';
  el.referrerPolicy = 'no-referrer';
  el.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  el.srcdoc = `<!doctype html><meta charset="utf-8"><title>dz</title><script>${FRAME_SCRIPT}</script>`;
  const f = { el, win: null, markReady: null, failReady: null, ready: null, pending: new Map(), sent: 0, open: 0, timeouts: 0, dead: false };
  f.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DeezerError('unavailable', { reason: 'frame' })), READY_TIMEOUT_MS);
    f.markReady = () => { clearTimeout(t); f.markReady = null; f.failReady = null; resolve(); };
    f.failReady = () => { clearTimeout(t); f.markReady = null; f.failReady = null; reject(new DeezerError('unavailable', { reason: 'frame' })); };
  });
  f.ready.catch(() => destroyFrame(f));
  frame = f;
  frames.add(f);
  document.body.appendChild(el);
  f.win = el.contentWindow;
  return f;
}

/** Build the API URL for path + query (only for our own known paths and parameters). */
export function apiUrl(path, query = {}, extra = {}) {
  if (typeof path !== 'string' || !/^\/[a-z]+(?:\/\d{1,16})?(?:\/[a-z]+)?$/.test(path)) throw new DeezerError('unavailable', { reason: 'path' });
  const u = new URL(API + path);
  for (const [k, v] of Object.entries({ ...query, ...extra })) if (v != null) u.searchParams.set(k, String(v));
  return u.href;
}

/** The real transport: JSONP inside the sandboxed frame. fn(path, query, { signal }) -> json. */
export async function jsonpTransport(path, query = {}, { signal } = {}) {
  if (typeof document === 'undefined') throw new DeezerError('unavailable', { reason: 'nodom' });
  if (globalThis.navigator?.onLine === false) throw new DeezerError('offline');
  const id = randomId();
  const cb = `dzcb${randomId(12)}`;
  const url = apiUrl(path, query, { output: 'jsonp', callback: cb });
  const f = getFrame();
  f.sent++; // counted when chosen: a frame takes at most FRAME_MAX_REQUESTS
  f.open++; // this request still needs the frame (a retired frame stays until it is 0)
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    f.open--;
    if (!f.dead && frame !== f && !f.open) destroyFrame(f); // a retired frame, done
  };
  try { await f.ready; } catch (e) { close(); throw e; }
  if (f.dead) { close(); throw new DeezerError('unavailable', { reason: 'frame' }); }
  return new Promise((resolve, reject) => {
    let timer = 0;
    const finish = (fn, v) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      pending.delete(id);
      f.pending.delete(id);
      close();
      fn(v);
    };
    const onAbort = () => finish(reject, abortError());
    timer = setTimeout(() => {
      const err = new DeezerError(globalThis.navigator?.onLine === false ? 'offline' : 'timeout');
      // a frame that keeps timing out may be wedged by a remote script: start a fresh one (its
      // other requests fail now too; a timeout of an older frame never counts against this one)
      if (!f.dead && ++f.timeouts >= FRAME_TIMEOUTS) { finish(reject, err); destroyFrame(f, 'timeout'); return; }
      finish(reject, err);
    }, TIMEOUT_MS);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const entry = { frame: f, resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) };
    pending.set(id, entry);
    f.pending.set(id, entry);
    f.win.postMessage({ tt: 'dz-req', id, url, cb }, '*'); // opaque origin: '*' is the only target that reaches it
  });
}

let transport = jsonpTransport;
/** Replace the transport (tests): fn(path, query, { signal }) -> Promise<json>. Null restores JSONP. */
export function setTransport(fn) { transport = typeof fn === 'function' ? fn : jsonpTransport; }

/** Tests: reset the queue and caches; optionally another gap between requests. */
export function _reset({ gap = GAP_MS, inFlight: cap = MAX_IN_FLIGHT } = {}) {
  gapMs = gap; maxInFlight = cap; nextAt = 0; pausedUntil = 0; waiters.length = 0; inFlight = 0; previews.clear();
  for (const f of [...frames]) destroyFrame(f);
}

/**
 * One API call through the queue: retries on Deezer's quota (code 4) and "busy" (700)
 * errors, maps the rest to DeezerError. Resolves with the (still untrusted) JSON object.
 */
export async function request(path, query = {}, { signal, urgent = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    await slot(signal, urgent);
    let j;
    try {
      j = await transport(path, query, { signal });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      if (e instanceof DeezerError) throw e;
      throw new DeezerError(globalThis.navigator?.onLine === false ? 'offline' : 'unavailable');
    } finally {
      release();
    }
    if (!isObj(j)) throw new DeezerError('unavailable', { reason: 'shape' });
    const err = own(j, 'error');
    if (err === undefined) return j;
    const code = isObj(err) ? Number(own(err, 'code')) : NaN;
    if ((code === 4 || code === 700) && attempt < RETRIES) {
      const wait = QUOTA_WAIT_MS * (attempt + 1) + Math.floor(Math.random() * 500);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      continue;
    }
    if (code === 4) throw new DeezerError('quota');
    if (code === 800) throw new DeezerError('notfound');
    throw new DeezerError('unavailable', { deezerCode: Number.isFinite(code) ? code : null });
  }
}

const dataOf = (j) => {
  const d = own(j, 'data');
  if (!Array.isArray(d)) throw new DeezerError('unavailable', { reason: 'shape' });
  return d;
};

/* ---------- API ---------- */

/** Search public playlists: { items: [{ id, title, count, by, picture }], total, next }. */
export async function searchPlaylists(q, { index = 0, limit = 25, signal } = {}) {
  const term = text(q, 100);
  if (!term) return { items: [], total: 0, next: null };
  const idx = Number.isSafeInteger(index) && index >= 0 ? Math.min(index, 10000) : 0;
  const lim = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 25;
  const j = await request('/search/playlist', { q: term, index: idx, limit: lim }, { signal });
  const data = dataOf(j).slice(0, lim);
  const seen = new Set();
  const items = [];
  for (const p of data) {
    const c = cleanPlaylistItem(p);
    if (c && !seen.has(c.id)) { seen.add(c.id); items.push(c); }
  }
  const total = nonNegInt(own(j, 'total')) ?? idx + data.length;
  const next = data.length && typeof own(j, 'next') === 'string' && idx + data.length < total ? idx + data.length : null;
  return { items, total, next };
}

const checkId = (id) => {
  const n = posId(id);
  if (!n) throw new DeezerError('notfound');
  return n;
};

/** One playlist's name, size, maker and cover: { id, title, count, by, picture }. */
export async function playlistInfo(id, { signal } = {}) {
  const pid = checkId(id);
  const j = await request(`/playlist/${pid}`, {}, { signal });
  const c = cleanPlaylistItem({ ...pickKeys(j, ['id', 'title', 'nb_tracks', 'picture_medium', 'picture_big', 'creator']), public: true });
  if (!c || c.id !== pid) throw new DeezerError('unavailable', { reason: 'shape' });
  return c;
}

function pickKeys(o, keys) {
  const out = {};
  for (const k of keys) if (has(o, k)) out[k] = o[k];
  return out;
}

/**
 * All songs of a playlist (paged, at most `max`): [{ deezerId, title, artist, album, isrc,
 * readable }]. Unreadable songs and duplicates (same Deezer id or ISRC) are left out.
 * onProgress(read, total) after every page.
 */
export async function playlistTracks(id, { max = MAX_TRACKS, onProgress, signal } = {}) {
  const pid = checkId(id);
  const cap = Number.isSafeInteger(max) && max > 0 ? max : MAX_TRACKS;
  const out = [];
  const ids = new Set();
  const isrcs = new Set();
  let index = 0;
  let total = null;
  for (let page = 0; page < Math.ceil(cap / PAGE) + 10; page++) {
    const j = await request(`/playlist/${pid}/tracks`, { index, limit: PAGE }, { signal });
    const data = dataOf(j).slice(0, PAGE * 2);
    total = nonNegInt(own(j, 'total')) ?? total;
    for (const raw of data) {
      const t = cleanTrackItem(raw);
      if (!t || ids.has(t.deezerId) || (t.isrc && isrcs.has(t.isrc))) continue;
      ids.add(t.deezerId);
      if (t.isrc) isrcs.add(t.isrc);
      out.push(t);
      if (out.length >= cap) break;
    }
    index += data.length;
    onProgress?.(Math.min(index, total ?? index, cap), Math.min(total ?? index, cap));
    if (out.length >= cap || !data.length || typeof own(j, 'next') !== 'string' || (total != null && index >= total)) break;
  }
  return out;
}

/** One song: { deezerId, title, artist, album, isrc, year, preview } (year: of this release). */
export async function trackInfo(id, { signal, urgent = false } = {}) {
  const tid = checkId(id);
  const j = await request(`/track/${tid}`, {}, { signal, urgent });
  const t = cleanTrackItem({ ...pickKeys(j, ['id', 'title', 'title_short', 'artist', 'album', 'isrc']), readable: true });
  if (!t || t.deezerId !== tid) throw new DeezerError('unavailable', { reason: 'shape' });
  const album = own(j, 'album');
  const year = dateYear(own(j, 'release_date')) ?? (isObj(album) ? dateYear(own(album, 'release_date')) : null);
  const preview = dzUrl(own(j, 'preview'));
  if (preview) rememberPreview(tid, preview);
  return { deezerId: t.deezerId, title: t.title, artist: t.artist, album: t.album, isrc: t.isrc, year, preview };
}

/* ---------- previews ---------- */

const previews = new Map(); // deezerId -> { url, at }

/** The expiry in Deezer's signed preview URL (hdnea=exp=<unix seconds>~...), in ms; else null. */
function previewExpiry(url) {
  const m = /[?&]hdnea=exp=(\d{9,11})/.exec(url);
  return m ? Number(m[1]) * 1000 : null;
}

function rememberPreview(id, url) {
  previews.delete(id);
  previews.set(id, { url, at: Date.now() });
  while (previews.size > PREVIEW_CACHE_MAX) previews.delete(previews.keys().next().value);
}

/**
 * A fresh https preview URL (30 s mp3) for the player, or null. Never store it: the token in
 * the URL expires. Cached in memory for 10 minutes (less when the token runs out sooner).
 * Goes ahead of the background work in the queue. Never rejects.
 */
export async function trackPreview(id) {
  const tid = posId(id);
  if (!tid) return null;
  const c = previews.get(tid);
  if (c) {
    const exp = previewExpiry(c.url);
    if (Date.now() - c.at < PREVIEW_TTL_MS && (exp == null || exp - Date.now() > 60_000)) return c.url;
    previews.delete(tid);
  }
  try {
    const t = await trackInfo(tid, { urgent: true });
    return t.preview || null;
  } catch {
    return null;
  }
}

/* ---------- links ---------- */

/** Playlist id from a deezer.com playlist link (any language path), a deezer:// link or a bare id. */
export function parsePlaylistId(input) {
  const s = String(input ?? '').trim().slice(0, 500);
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d{1,16})(?:[/?#].*)?$/i)
    || s.match(/^deezer:\/\/(?:www\.deezer\.com\/)?playlist\/(\d{1,16})$/i)
    || s.match(/^(\d{1,16})$/);
  return m ? posId(m[1]) : null;
}
