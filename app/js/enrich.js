// One app-wide background worker that finishes the songs of the stored playlists: a year for
// songs that have none, a better (original) year, and an Apple Music fragment. It replaces the
// loop that only ran while the playlist edit screen was open; screens show its progress via
// status()/subscribe().
//
// Per song, cheapest first (a song moves to the next step only when the earlier ones are done
// or do not apply):
//   1. 'dz'    no year + deezerId -> Deezer trackInfo year (fast, ~8/s); the year is "not sure"
//              (it is the date of that release: a compilation or remaster for some songs).
//   2. 'mb'    year not sure + isrc -> MusicBrainz first-release year (1/s): taken when it is
//              earlier than or equal to ours (then the year is sure); a later one is ignored.
//   3. 'apple' no itunesId -> the existing Apple Music match (fragment + pickYear) at Apple's
//              slow rate (~20/min); a song without a trustworthy match gets match: 'none'.
// The three steps use three different services with their own limits, so they run as three
// lanes side by side. A year the user typed (yearSure: true) is never overwritten.
//
// State lives on the tracks (year, yearSure, itunesId, match), so the work survives a reload.
// "Asked, nothing to gain" is remembered in localStorage (timetunesr.enrich.v1, capped): Deezer
// ids without a year and MusicBrainz answers per ISRC, so a reload does not ask again.
import * as playlistsStore from './playlists.js';
import * as deezerApi from './deezer.js';
import * as mbApi from './musicbrainz.js';
import { appleMatch as appleMatchFn } from './apple-match.js';
import { validYear, FUN_MIN } from './playlist-logic.js';
import { store as ls } from './ui.js';

const MEM_KEY = 'timetunesr.enrich.v1';
const MEM_MAX = 3000;
const CONCURRENCY = { dz: 4, mb: 1, apple: 1 };
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

const cfg = {
  idleMs: 15000, // re-scan now and then even without a kick
  flushMs: 700, // Deezer years are written in batches (one localStorage write per batch)
  emitMs: 250, // listeners hear at most ~4 updates per second
  backoffMs: 4000, // after a network error in a lane
  quotaMs: 10000, // after Deezer's quota error survived the retries
  memSaveMs: 2000,
};

let deps = { playlists: playlistsStore, deezer: deezerApi, musicbrainz: mbApi, appleMatch: appleMatchFn };
/** Tests: replace the services ({ playlists, deezer, musicbrainz, appleMatch }). */
export function _setDeps(d) { deps = { ...deps, ...d }; }
/** Tests: shorter timings. */
export function _configure(c) { Object.assign(cfg, c); }
/** Tests: forget everything in memory (call after stop()). */
export function _reset() {
  mem = null; paused.clear(); priority.length = 0; prepares.clear(); inflight.clear(); buffer.clear();
  for (const s of Object.values(skip)) s.clear();
  dzFails.clear(); appleDone.clear(); dzErrors = { streak: 0, last: null };
}

/* ---------- state ---------- */

let running = false;
let started = false;
let generation = 0; // lanes of an earlier start() end themselves
const paused = new Set(); // reasons: 'game', 'audio', 'offline', ...
const priority = []; // playlist ids, most wanted first
const prepares = new Map(); // playlist id -> number of prepare() calls waiting
const inflight = new Set(); // track keys being worked on (or waiting in the write buffer)
const skip = { dz: new Set(), mb: new Set(), apple: new Set() }; // given up for this session
const dzFails = new Map();
const appleDone = new Map(); // playlist id -> fragments searched this session
let slowCtrl = null; // aborted by pause(): MusicBrainz and Apple requests stop at once
let stopCtrl = null;
let dzErrors = { streak: 0, last: null };
let unsubStore = null;

const key = (pid, n) => `${pid}\u0000${n}`;
const posId = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const isrcOf = (v) => (typeof v === 'string' && ISRC_RE.test(v) ? v : null);

/* ---------- remembered answers ---------- */

let mem = null; // { dz: Set<deezerId>, mb: Map<isrc, year|0> }
let memTimer = 0;
function memory() {
  if (mem) return mem;
  const raw = ls.get(MEM_KEY, null);
  mem = { dz: new Set(), mb: new Map() };
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.dz)) for (const id of raw.dz.slice(-MEM_MAX)) { const n = posId(id); if (n) mem.dz.add(n); }
    if (raw.mb && typeof raw.mb === 'object' && !Array.isArray(raw.mb)) {
      for (const k of Object.keys(raw.mb).slice(-MEM_MAX)) {
        const y = Number(raw.mb[k]);
        if (isrcOf(k) && (y === 0 || validYear(y))) mem.mb.set(k, y);
      }
    }
  }
  return mem;
}
function saveMemorySoon() {
  if (memTimer) return;
  memTimer = setTimeout(() => {
    memTimer = 0;
    const m = memory();
    while (m.dz.size > MEM_MAX) m.dz.delete(m.dz.values().next().value);
    while (m.mb.size > MEM_MAX) m.mb.delete(m.mb.keys().next().value);
    const mb = Object.create(null);
    for (const [k, y] of m.mb) mb[k] = y;
    ls.set(MEM_KEY, { v: 1, dz: [...m.dz], mb });
  }, cfg.memSaveMs);
}

/* ---------- what a track needs ---------- */

/** MusicBrainz already answered for this ISRC and has nothing better than our year. */
function mbSettled(isrc, t) {
  const m = memory().mb;
  if (!m.has(isrc)) return false;
  const y = m.get(isrc);
  return !y || (validYear(t.year) && y > t.year);
}

/** The next step this track needs: 'dz' | 'mb' | 'apple' | null. */
export function nextStep(t, k = '') {
  if (!t) return null;
  const hasYear = validYear(t.year);
  const dzId = posId(t.deezerId);
  if (!hasYear && dzId && !memory().dz.has(dzId) && !skip.dz.has(dzId)) return 'dz';
  const isrc = isrcOf(t.isrc);
  if (isrc && !(hasYear && t.yearSure) && !skip.mb.has(isrc) && !mbSettled(isrc, t)) return 'mb';
  if (needsApple(t, k)) return 'apple';
  return null;
}

const needsApple = (t, k) => !t.itunesId && t.match !== 'none' && !!(t.title || t.artist) && !skip.apple.has(k);

/** Van der Corput order: any first part of the work is spread over the whole list. */
function spreadKey(i, bits) {
  let r = 0;
  for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
}

function activeId() {
  try { return deps.playlists.getActiveId?.() ?? null; } catch { return null; }
}

function orderedLists() {
  const lists = (deps.playlists.all?.() || []).slice();
  const act = activeId();
  const rank = (p) => {
    const i = priority.indexOf(p.id);
    if (i >= 0) return i;
    return p.id === act ? priority.length : priority.length + 1;
  };
  return lists.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
}

const blocked = (lane) => paused.size > 0 && !(lane === 'dz' && prepares.size > 0);

function pick(lane) {
  for (const p of orderedLists()) {
    if (paused.size && !prepares.has(p.id)) continue; // paused: only a playlist someone waits for
    const tracks = p.tracks || [];
    const bits = Math.max(1, Math.ceil(Math.log2(tracks.length + 1)));
    let best = null;
    let bestKey = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const k = key(p.id, t.n);
      if (inflight.has(k) || nextStep(t, k) !== lane) continue;
      const sk = spreadKey(i, bits);
      if (sk < bestKey) { bestKey = sk; best = t; }
    }
    if (best) return { pid: p.id, n: best.n, k: key(p.id, best.n), t: { ...best } };
  }
  return null;
}

const current = (pid, n) => deps.playlists.get?.(pid)?.tracks?.find((x) => x.n === n) || null;

/* ---------- writing ---------- */

const buffer = new Map(); // key -> { pid, n, patch, check }
let flushTimer = 0;

function writeLater(k, w) {
  buffer.set(k, w);
  if (!flushTimer) flushTimer = setTimeout(flush, cfg.flushMs);
}

function writeNow(pid, list) {
  if (!list.length) return;
  if (typeof deps.playlists.updateTracks === 'function') deps.playlists.updateTracks(pid, list);
  else for (const { n, patch } of list) deps.playlists.updateTrack(pid, n, patch);
}

/** Write the buffered Deezer years (re-checked against the track as it is now). */
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  const byPid = new Map();
  for (const [k, w] of buffer) {
    buffer.delete(k);
    inflight.delete(k);
    const cur = current(w.pid, w.n);
    if (!cur || !w.check(cur)) continue;
    if (!byPid.has(w.pid)) byPid.set(w.pid, []);
    byPid.get(w.pid).push({ n: w.n, patch: w.patch });
  }
  for (const [pid, list] of byPid) writeNow(pid, list);
  emitSoon();
  kick();
}

/* ---------- the steps ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stepDeezer(job, signal) {
  const dzId = posId(job.t.deezerId);
  let info;
  try {
    info = await deps.deezer.trackInfo(dzId, { signal });
  } catch (e) {
    if (e?.code === 'aborted') return false;
    if (e?.code === 'notfound') { memory().dz.add(dzId); saveMemorySoon(); return false; }
    dzErrors = { streak: dzErrors.streak + 1, last: e };
    const f = (dzFails.get(dzId) || 0) + 1;
    dzFails.set(dzId, f);
    if (f >= 2) skip.dz.add(dzId);
    emitSoon();
    await sleep(e?.code === 'quota' ? cfg.quotaMs : cfg.backoffMs);
    return false;
  }
  dzErrors = { streak: 0, last: null };
  if (!validYear(info?.year)) { memory().dz.add(dzId); saveMemorySoon(); return false; }
  const patch = { year: info.year, yearSure: false };
  if (!isrcOf(job.t.isrc) && isrcOf(info.isrc)) patch.isrc = info.isrc;
  writeLater(job.k, { pid: job.pid, n: job.n, patch, check: (cur) => !validYear(cur.year) });
  return true; // stays in flight until the batch is written
}

async function stepMusicBrainz(job, signal) {
  const isrc = isrcOf(job.t.isrc);
  const m = memory().mb;
  let y;
  if (m.has(isrc)) y = m.get(isrc) || null;
  else {
    try {
      y = await deps.musicbrainz.firstReleaseYear(isrc, { signal });
    } catch (e) {
      if (e?.code === 'aborted') return false;
      skip.mb.add(isrc); // try again in a later session
      await sleep(cfg.backoffMs);
      return false;
    }
    m.set(isrc, validYear(y) ? y : 0);
    saveMemorySoon();
  }
  const cur = current(job.pid, job.n);
  if (!cur || (validYear(cur.year) && cur.yearSure)) return false; // the user typed a year meanwhile
  if (validYear(y) && (!validYear(cur.year) || y <= cur.year)) {
    writeNow(job.pid, [{ n: job.n, patch: { year: y, yearSure: true } }]);
  }
  return false;
}

async function stepApple(job, signal) {
  let hit = null;
  try {
    hit = await deps.appleMatch({ title: job.t.title, artist: job.t.artist, year: job.t.year }, { signal });
  } catch (e) {
    if (e?.code === 'aborted' || signal.aborted) return false;
    hit = null;
  }
  if (signal.aborted) return false;
  const cur = current(job.pid, job.n);
  if (!cur || cur.itunesId) return false;
  const tracks = deps.playlists.get(job.pid)?.tracks || [];
  let patch;
  if (hit && Number.isSafeInteger(hit.itunesId) && hit.itunesId > 0 && !tracks.some((x) => x.itunesId === hit.itunesId && x.n !== job.n)) {
    patch = { itunesId: hit.itunesId, previewUrl: hit.previewUrl || null, trackViewUrl: hit.trackViewUrl || null, match: undefined };
    // a year the user typed, or one MusicBrainz confirmed, stays
    if (!(validYear(cur.year) && cur.yearSure)) {
      const year = validYear(hit.year) ? hit.year : cur.year;
      patch.year = validYear(year) ? year : null;
      patch.yearSure = validYear(hit.year) ? !!hit.yearSure : false;
    }
  } else {
    patch = { match: 'none' };
  }
  writeNow(job.pid, [{ n: job.n, patch }]);
  appleDone.set(job.pid, (appleDone.get(job.pid) || 0) + 1);
  return false;
}

const STEPS = { dz: stepDeezer, mb: stepMusicBrainz, apple: stepApple };

/* ---------- lanes ---------- */

let wakers = [];
function kick() { const w = wakers; wakers = []; w.forEach((fn) => fn()); }
function idle() {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { wakers = wakers.filter((f) => f !== done); resolve(); }, cfg.idleMs);
    wakers.push(done);
  });
}

async function lane(name, gen) {
  while (running && gen === generation) {
    if (blocked(name)) { await idle(); continue; }
    const job = pick(name);
    if (!job) { await idle(); continue; }
    inflight.add(job.k);
    let keep = false;
    const signal = name === 'dz' ? stopCtrl.signal : slowCtrl.signal;
    try {
      keep = await STEPS[name](job, signal);
    } catch (e) {
      console.error(e);
    } finally {
      if (!keep) inflight.delete(job.k);
    }
    emitSoon();
  }
}

/* ---------- control ---------- */

/** Start the worker (idempotent). The app calls this once at startup. */
export function start() {
  if (running) return;
  running = true;
  generation++;
  stopCtrl = new AbortController();
  slowCtrl = new AbortController();
  if (!started) {
    started = true;
    const w = globalThis.window;
    w?.addEventListener?.('online', () => resume('offline'));
    w?.addEventListener?.('offline', () => pause('offline'));
    if (globalThis.navigator?.onLine === false) paused.add('offline');
  }
  unsubStore = deps.playlists.subscribe?.(() => { kick(); emitSoon(); }) || null;
  for (const [name, n] of Object.entries(CONCURRENCY)) for (let i = 0; i < n; i++) lane(name, generation);
}

/** Stop the worker (tests; also drops what is in flight). */
export function stop() {
  running = false;
  stopCtrl?.abort();
  slowCtrl?.abort();
  unsubStore?.();
  unsubStore = null;
  flush();
  kick();
}

/**
 * Pause the background work (e.g. while a round is played: no competing for the network).
 * Several reasons can hold a pause at once; work goes on when all are resumed. MusicBrainz and
 * Apple requests in flight are stopped; a prepare() someone waits for still gets its years.
 */
export function pause(reason = 'game') {
  const was = paused.size;
  paused.add(String(reason));
  if (!was && slowCtrl) { slowCtrl.abort(); slowCtrl = new AbortController(); }
  emitSoon();
}

export function resume(reason = 'game') {
  if (!paused.delete(String(reason))) return;
  emitSoon();
  kick();
}

export const isPaused = () => paused.size > 0;

/** Do this playlist first (e.g. the one on screen, or one just imported). */
export function prioritise(playlistId) {
  if (typeof playlistId !== 'string') return;
  const i = priority.indexOf(playlistId);
  if (i >= 0) priority.splice(i, 1);
  priority.unshift(playlistId);
  if (priority.length > 20) priority.length = 20;
  start();
  kick();
}
export const prioritize = prioritise;

/* ---------- progress ---------- */

const listeners = new Set();
let emitTimer = 0;
/** fn() is called (at most ~4 times per second) when the progress of any playlist changes. */
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emitSoon() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = 0;
    for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } }
  }, cfg.emitMs);
}

/**
 * Progress of one playlist:
 * { total, ready, yearsMissing, yearsUnsure, fragmentsMissing, working,
 *   pending, appleTodo, appleDone, paused }
 * ready: songs with a year; fragmentsMissing: no itunesId and no deezerId; working: background
 * work is going on for it now; pending: songs with a step still to do; appleTodo/appleDone:
 * the Apple Music fragment search (for "Fragmenten zoeken bij Apple Music: x van y").
 */
export function status(playlistId) {
  const p = deps.playlists.get?.(playlistId);
  const out = {
    total: 0, ready: 0, yearsMissing: 0, yearsUnsure: 0, fragmentsMissing: 0, working: false,
    pending: 0, appleTodo: 0, appleDone: appleDone.get(playlistId) || 0, paused: paused.size > 0,
  };
  if (!p) return out;
  let busy = false;
  for (const t of p.tracks || []) {
    const k = key(p.id, t.n);
    out.total++;
    if (validYear(t.year)) { out.ready++; if (!t.yearSure) out.yearsUnsure++; } else out.yearsMissing++;
    if (!t.itunesId && !posId(t.deezerId)) out.fragmentsMissing++;
    if (inflight.has(k)) { busy = true; out.pending++; } else if (nextStep(t, k)) out.pending++;
    if (needsApple(t, k)) out.appleTodo++;
  }
  out.working = running && out.pending > 0 && (busy || !paused.size || prepares.has(p.id));
  return out;
}

/** Year work (Deezer / MusicBrainz) still possible for songs of this playlist without a year. */
function yearWorkLeft(pid) {
  const p = deps.playlists.get?.(pid);
  return (p?.tracks || []).some((t) => {
    if (validYear(t.year)) return false;
    const k = key(pid, t.n);
    const s = nextStep(t, k);
    return inflight.has(k) || s === 'dz' || s === 'mb';
  });
}

/**
 * For "play at once" with a catalogue list: resolves with status(playlistId) as soon as at
 * least `min` songs have a year (or no more years can be found quickly: check `ready`), while
 * the rest goes on in the background. Works while the worker is paused (only for this list).
 * Rejects with a DeezerError (offline | timeout | quota | unavailable | aborted) when Deezer
 * keeps failing before enough years are in. onProgress(status) on every change.
 */
export function prepare(playlistId, { min = FUN_MIN, signal, onProgress } = {}) {
  start();
  return new Promise((resolve, reject) => {
    let unsub = null;
    let finished = false;
    const finish = (fn, v) => {
      if (finished) return;
      finished = true;
      unsub?.();
      signal?.removeEventListener?.('abort', onAbort);
      const c = (prepares.get(playlistId) || 1) - 1;
      if (c > 0) prepares.set(playlistId, c); else prepares.delete(playlistId);
      kick();
      fn(v);
    };
    const onAbort = () => finish(reject, new deezerApi.DeezerError('aborted'));
    if (signal?.aborted) { reject(new deezerApi.DeezerError('aborted')); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    prepares.set(playlistId, (prepares.get(playlistId) || 0) + 1);
    dzErrors = { streak: 0, last: null }; // only failures from now on count
    const check = () => {
      if (finished) return;
      const st = status(playlistId);
      try { onProgress?.(st); } catch (e) { console.error(e); }
      if (st.ready >= Math.max(0, Number(min) || 0) || !yearWorkLeft(playlistId)) { finish(resolve, st); return; }
      if (globalThis.navigator?.onLine === false) { finish(reject, new deezerApi.DeezerError('offline')); return; }
      if (dzErrors.streak >= 3 && dzErrors.last) finish(reject, dzErrors.last instanceof Error ? dzErrors.last : new deezerApi.DeezerError('unavailable'));
    };
    unsub = subscribe(check);
    prioritise(playlistId);
    check();
  });
}
