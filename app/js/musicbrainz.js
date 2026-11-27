// MusicBrainz: the ORIGINAL release year of a recording, by ISRC. Deezer and Spotify give the
// date of the release a track sits on (often a compilation or remaster); MusicBrainz's
// "first-release-date" of the recording is the first time it came out.
// The API sends CORS headers, so plain fetch works. Limit: 1 request per second per client
// (503 when over it): one queue with a 1.1 s gap; a 503 pauses it and retries.
import { validYear } from './playlist-logic.js';
import { titleScore, artistScore, versionPenalty, fold, normalizeTitle } from './spotify-match.js';
import { store } from './ui.js';

const ROOT = 'https://musicbrainz.org/ws/2/';
const BASE = `${ROOT}isrc/`;
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

export const MESSAGES = {
  offline: 'Geen internetverbinding. Controleer je verbinding en probeer het opnieuw.',
  timeout: 'MusicBrainz (voor de jaartallen) reageert niet. Probeer het zo nog eens.',
  unavailable: 'MusicBrainz (voor de jaartallen) is even niet bereikbaar of erg druk. Probeer het later opnieuw.',
  aborted: 'Gestopt.',
};
export const errorMessage = (e) => MESSAGES[e?.code] || MESSAGES.unavailable;

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
const searchCache = new Map(); // search key -> year | null

/** Tests: reset queue and cache; optionally another gap. */
export function _reset({ gap: g = null } = {}) { gapOverride = g; nextAt = 0; chain = Promise.resolve(); cache.clear(); searchCache.clear(); }

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

const yearOfDate = (d) => {
  if (typeof d !== 'string') return null;
  const m = d.match(/^(\d{4})(?:-\d{2}(?:-\d{2})?)?$/);
  const y = m ? Number(m[1]) : NaN;
  return validYear(y) ? y : null;
};

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

/** GET through the queue; 503/429 back off and retry. Resolves { status: 200, json } | { status: 404 }. */
async function getJson(url, signal) {
  for (let attempt = 0; ; attempt++) {
    const r = await throttled(() => getOnce(url, signal), signal);
    if (r.status !== 503) return r;
    if (attempt >= RETRIES) throw new MusicBrainzError('unavailable', { status: 503 });
    nextAt = Math.max(nextAt, Date.now() + BACKOFF_MS * (attempt + 1));
  }
}

function remember(map, k, year) {
  map.set(k, year);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
  return year;
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
  const r = await getJson(`${BASE}${code}?fmt=json`, signal);
  return remember(cache, code, r.status === 404 ? null : earliestYear(r.json));
}

/* ---------- search by title + artist ---------- */

const MAX_FIELD = 100;
const txt = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD) : '');
/** Inside a Lucene phrase only the quote and the backslash need escaping. */
const phrase = (v) => `"${v.replace(/[\\"]/g, '\\$&')}"`;

/** The title to search for: no "- Remastered 2011", no "(feat. X)" / "(Live)" parts. */
export function searchTitle(title) {
  const t = txt(title);
  const core = t.replace(/\s+-\s+.*$/, '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return core || t;
}
/** The main artist to search for ("Calvin Harris, Dua Lipa" -> "Calvin Harris"). */
export function searchArtist(artist) {
  const a = txt(artist);
  return a.split(/\s*(?:,|;|\/|\s(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s)\s*/i)[0].trim() || a;
}

/** Key under which a search is remembered (the same song asked twice is asked once). */
export function searchKey({ title, artist } = {}) {
  // the whole title: "Take On Me (2017 Acoustic)" is another question than "Take On Me"
  const t = normalizeTitle(searchTitle(title)) ? fold(txt(title)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
  const a = fold(searchArtist(artist)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t && a ? `${a}|${t}`.slice(0, 160) : null;
}

/** Names in a recording's artist credit. */
function creditNames(rec) {
  const credit = has(rec, 'artist-credit') && Array.isArray(rec['artist-credit']) ? rec['artist-credit'].slice(0, 10) : [];
  const out = [];
  for (const c of credit) {
    if (has(c, 'name') && typeof c.name === 'string') out.push(c.name.slice(0, MAX_FIELD));
    else if (has(c, 'artist') && has(c.artist, 'name') && typeof c.artist.name === 'string') out.push(c.artist.name.slice(0, MAX_FIELD));
  }
  return out;
}

/**
 * Only recordings that are clearly this song by this artist (not a cover, live take or remix)
 * count; their earliest first-release-date wins. Pure: exported for the tests.
 */
export function earliestMatchingYear(json, { title, artist }) {
  const recs = has(json, 'recordings') && Array.isArray(json.recordings) ? json.recordings.slice(0, 50) : [];
  const want = txt(title);
  let best = null;
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue;
    const name = has(r, 'title') && typeof r.title === 'string' ? r.title.slice(0, 200) : '';
    const dis = has(r, 'disambiguation') && typeof r.disambiguation === 'string' ? r.disambiguation.slice(0, 100) : '';
    const names = creditNames(r);
    if (!name || !names.length) continue;
    if (titleScore(want, name) < 0.9) continue;
    if (artistScore(txt(artist), names.map((n) => ({ name: n }))) < 0.85) continue;
    // "live", "remix", "acoustic", "karaoke"... in the title or MusicBrainz's disambiguation
    if (versionPenalty(want, { name: `${name}${dis ? ` (${dis})` : ''}`, artists: names.map((n) => ({ name: n })), album: { name: '' } }).penalty >= 0.2) continue;
    const y = yearOfDate(has(r, 'first-release-date') ? r['first-release-date'] : null);
    if (y != null && (best == null || y < best)) best = y;
  }
  return best;
}

/**
 * The first release year found by a recording search on title + artist (for songs without an
 * ISRC, or with one MusicBrainz does not know), or null. Same queue and errors as
 * firstReleaseYear.
 */
export async function searchFirstReleaseYear({ title, artist } = {}, { signal } = {}) {
  const t = searchTitle(title);
  const a = searchArtist(artist);
  const k = searchKey({ title, artist });
  if (!t || !a || !k) return null;
  if (searchCache.has(k)) return searchCache.get(k);
  const query = `recording:${phrase(t)} AND artist:${phrase(a)}`;
  const r = await getJson(`${ROOT}recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`, signal);
  return remember(searchCache, k, r.status === 404 ? null : earliestMatchingYear(r.json, { title, artist }));
}
