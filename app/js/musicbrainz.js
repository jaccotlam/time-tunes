// MusicBrainz: the ORIGINAL release year of a recording, by ISRC. Deezer and Spotify give the
// date of the release a track sits on (often a compilation or remaster); MusicBrainz's
// "first-release-date" of the recording is the first time it came out.
// The API sends CORS headers, so plain fetch works. Limit: 1 request per second per client
// (503 when over it): one queue with a 1.1 s gap; a 503 pauses it and retries.
import { validYear } from './playlist-logic.js';
import { store } from './ui.js';

const BASE = 'https://musicbrainz.org/ws/2/isrc/';
const DEFAULT_GAP_MS = 1100;
/** Tests can lower the gap: localStorage['timetunesr.mbGap.v1'] = 20 (ms). */
const GAP_KEY = 'timetunesr.mbGap.v1';
const TIMEOUT_MS = 10000;
const BACKOFF_MS = 3000;
const RETRIES = 3;
const MAX_BODY = 1_000_000;
const CACHE_MAX = 3000;
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export class MusicBrainzError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = 'MusicBrainzError';
    this.code = code; // offline | timeout | unavailable | aborted
    Object.assign(this, extra);
  }
}

let fetchFn = (...a) => globalThis.fetch(...a);
/** Replace fetch (tests). Null restores the global fetch. */
export function setFetch(fn) { fetchFn = typeof fn === 'function' ? fn : (...a) => globalThis.fetch(...a); }

let gapOverride = null;
const gap = () => {
  if (gapOverride != null) return gapOverride;
  // (Number(null) is 0: an unset key must not mean "no gap")
  const raw = store.get(GAP_KEY, null);
  const g = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
  return Number.isFinite(g) && g >= 0 ? g : DEFAULT_GAP_MS;
};

let nextAt = 0;
let chain = Promise.resolve();
const cache = new Map(); // ISRC -> year | null

/** Tests: reset queue and cache; optionally another gap. */
export function _reset({ gap: g = null } = {}) { gapOverride = g; nextAt = 0; chain = Promise.resolve(); cache.clear(); }

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new MusicBrainzError('aborted')); return; }
  const onAbort = () => { clearTimeout(t); reject(new MusicBrainzError('aborted')); };
  const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

function throttled(fn, signal) {
  const run = async () => {
    await sleep(nextAt - Date.now(), signal);
    nextAt = Date.now() + gap();
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const has = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** Earliest valid year over the recordings' first-release-date ("1982", "1982-04", "1982-04-08"). */
export function earliestYear(json) {
  const recs = has(json, 'recordings') && Array.isArray(json.recordings) ? json.recordings.slice(0, 200) : [];
  let best = null;
  for (const r of recs) {
    const d = has(r, 'first-release-date') ? r['first-release-date'] : null;
    if (typeof d !== 'string') continue;
    const m = d.match(/^(\d{4})(?:-\d{2}(?:-\d{2})?)?$/);
    const y = m ? Number(m[1]) : NaN;
    if (validYear(y) && (best == null || y < best)) best = y;
  }
  return best;
}

async function getOnce(url, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 404) return { status: 404 };
    if (res.status === 503 || res.status === 429) return { status: 503 };
    if (!res.ok) throw new MusicBrainzError('unavailable', { status: res.status });
    const body = await res.text();
    if (typeof body !== 'string' || body.length > MAX_BODY) throw new MusicBrainzError('unavailable');
    try { return { status: 200, json: JSON.parse(body) }; } catch { throw new MusicBrainzError('unavailable'); }
  } catch (e) {
    if (signal?.aborted) throw new MusicBrainzError('aborted');
    if (e instanceof MusicBrainzError) throw e;
    if (ctrl.signal.aborted) throw new MusicBrainzError('timeout');
    throw new MusicBrainzError(globalThis.navigator?.onLine === false ? 'offline' : 'unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * The first release year of the recording with this ISRC, or null (unknown ISRC: 404, or no
 * usable date). Rejects with MusicBrainzError (offline | timeout | unavailable | aborted)
 * when it could not be asked: then the caller may try again later.
 */
export async function firstReleaseYear(isrc, { signal } = {}) {
  const code = typeof isrc === 'string' ? isrc.trim().toUpperCase() : '';
  if (!ISRC_RE.test(code)) return null;
  if (cache.has(code)) return cache.get(code);
  const url = `${BASE}${code}?fmt=json`;
  for (let attempt = 0; ; attempt++) {
    const r = await throttled(() => getOnce(url, signal), signal);
    if (r.status === 503) {
      if (attempt >= RETRIES) throw new MusicBrainzError('unavailable', { status: 503 });
      nextAt = Math.max(nextAt, Date.now() + BACKOFF_MS * (attempt + 1));
      continue;
    }
    const year = r.status === 404 ? null : earliestYear(r.json);
    cache.set(code, year);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return year;
  }
}
