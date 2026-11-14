// iTunes Search API (search + lookup), throttled to stay under Apple's limit of
// roughly 20 requests per minute. Every request of the playlist screens goes
// through one queue; a 403/429 pauses the queue for a minute.
import { store } from './ui.js';

const BASE = 'https://itunes.apple.com';
const COUNTRY = 'NL';
const TIMEOUT_MS = 8000;
/** Tests can lower the gap: localStorage['timetunesr.itunesGap.v1'] = 50 (ms). */
const GAP_KEY = 'timetunesr.itunesGap.v1';
const DEFAULT_GAP_MS = 3100;
const PAUSE_MS = 60_000;
export const LOOKUP_BATCH = 150;

export class ItunesError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = 'ItunesError';
    this.code = code; // 'rate' | 'offline' | 'unreachable' | 'http' | 'aborted'
    Object.assign(this, extra);
  }
}

export const MESSAGES = {
  rate: 'Apple Music krijgt even te veel zoekvragen van dit toestel. Wacht een minuut en probeer het opnieuw.',
  offline: 'Geen internetverbinding. Controleer je verbinding en probeer het opnieuw.',
  unreachable: 'Apple Music is even niet bereikbaar, misschien door te veel zoekvragen. Wacht een minuut en probeer het opnieuw.',
  http: 'Apple Music gaf een fout. Probeer het later opnieuw.',
  aborted: 'Gestopt.',
};
export const errorMessage = (e) => MESSAGES[e?.code] || MESSAGES.http;

const gap = () => {
  const g = Number(store.get(GAP_KEY, null));
  return Number.isFinite(g) && g >= 0 ? g : DEFAULT_GAP_MS;
};

let nextAt = 0;
let pausedUntil = 0;
let chain = Promise.resolve();

/** Milliseconds until the queue is free again after a 403/429 (0 when not paused). */
export const pausedFor = () => Math.max(0, pausedUntil - Date.now());

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new ItunesError('aborted')); return; }
  const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
  const onAbort = () => { clearTimeout(t); reject(new ItunesError('aborted')); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/** Run `fn` when it is our turn in the queue (respecting the gap and a pause). */
function throttled(fn, signal) {
  const run = async () => {
    if (signal?.aborted) throw new ItunesError('aborted');
    if (pausedFor() > 0) throw new ItunesError('rate', { waitMs: pausedFor() });
    await sleep(nextAt - Date.now(), signal);
    nextAt = Date.now() + gap();
    return fn();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

async function getJson(url, signal) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl?.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(url, { signal: ctrl?.signal, cache: 'no-store' });
  } catch {
    if (signal?.aborted) throw new ItunesError('aborted');
    // Apple answers its rate limit without CORS headers: then fetch fails like offline.
    throw new ItunesError(navigator.onLine === false ? 'offline' : 'unreachable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
  if (res.status === 403 || res.status === 429) {
    pausedUntil = Date.now() + PAUSE_MS;
    throw new ItunesError('rate', { waitMs: PAUSE_MS });
  }
  if (!res.ok) throw new ItunesError('http', { status: res.status });
  try { return await res.json(); } catch { throw new ItunesError('http'); }
}

/** Songs matching `term` (iTunes order). */
export function search(term, { limit = 25, signal } = {}) {
  const q = String(term || '').trim();
  if (!q) return Promise.resolve([]);
  const url = `${BASE}/search?term=${encodeURIComponent(q)}&entity=song&country=${COUNTRY}&limit=${limit}`;
  return throttled(() => getJson(url, signal), signal).then((j) => (Array.isArray(j?.results) ? j.results : []));
}

/** Look up songs by iTunes id (batches of LOOKUP_BATCH). Resolves with a Map id -> result. */
export async function lookup(ids, { signal, onProgress } = {}) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const out = new Map();
  for (let i = 0; i < list.length; i += LOOKUP_BATCH) {
    const chunk = list.slice(i, i + LOOKUP_BATCH);
    const url = `${BASE}/lookup?id=${chunk.join(',')}&country=${COUNTRY}`;
    const j = await throttled(() => getJson(url, signal), signal);
    for (const r of j?.results || []) if (r && r.trackId && (!r.kind || r.kind === 'song')) out.set(Number(r.trackId), r);
    onProgress?.(Math.min(list.length, i + chunk.length), list.length);
  }
  return out;
}

/**
 * Lookup for one song, outside the queue (used when a card is opened: the
 * player needs it right away). Resolves with the result or null.
 */
export async function lookupOne(itunesId) {
  try {
    const j = await getJson(`${BASE}/lookup?id=${encodeURIComponent(itunesId)}&country=${COUNTRY}`);
    return (j?.results || []).find((r) => Number(r.trackId) === Number(itunesId)) || null;
  } catch { return null; }
}
