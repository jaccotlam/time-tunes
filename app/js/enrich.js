// One app-wide background worker that finishes the songs of the stored playlists: a year for
// songs that have none, the CHECKED (original) year, and an Apple Music fragment. It replaces
// the loop that only ran while the playlist edit screen was open; screens show its progress
// via status()/subscribe().
//
// Why the year check matters: Deezer's release_date and Spotify's album year are the date of
// the release a track sits on (a remaster, a compilation): for older songs often decades off
// (measured: "Sweet Child O' Mine" 2018, "Take on Me" 2010). MusicBrainz's first-release-date
// of the recording was right for 17 of 18. The game asks "Jaartal (±2)" and "Exact jaar", so a
// catalogue year only counts once it has been checked.
//
// Lanes (three services with their own limits, running side by side):
//   'dz'    no year + deezerId -> Deezer trackInfo year (fast, ~8/s), "not sure". A provisional
//           year: something to show; it does NOT make the year checked.
//   'mb'    the year check (1 request / 1.1 s): MusicBrainz by ISRC; when MusicBrainz does not
//           know the ISRC (or there is none) a recording search on title + artist, accepting
//           only recordings that clearly are this song by this artist. A year earlier than or
//           equal to ours is taken (sure); a later one leaves ours. Either way: checked.
//           It does not wait for the Deezer year (both lanes work on the same songs at once).
//   'apple' no itunesId -> the existing Apple Music match (fragment, and pickYear as the LAST
//           resort for the year when MusicBrainz found nothing); match: 'none' when no match.
//           For a song whose year is already checked it only adds the fragment.
// A year the user typed (yearFixed, or yearSure on a valid year) is never touched.
//
// State on the track (survives reloads, readable by other code through yearPending()):
//   yearChecked: true  the year check has finished for this track (found or not).
//   yearSure: true     (with a valid year) the year is trusted: typed, or confirmed.
// "Asked, nothing better" is also remembered in localStorage (timetunesr.enrich.v1, capped):
// Deezer ids without a year, MusicBrainz answers per ISRC and per title+artist search.
import * as playlistsStore from './playlists.js';
import * as deezerApi from './deezer.js';
import * as mbApi from './musicbrainz.js';
import { searchKey } from './musicbrainz.js';
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
  checkedHere.clear(); dzFails.clear(); appleDone.clear();
  dzErrors = { streak: 0, last: null }; mbErrors = { streak: 0, last: null };
}

/* ---------- state ---------- */

let running = false;
let started = false;
let generation = 0; // lanes of an earlier start() end themselves
const paused = new Set(); // reasons: 'game', 'audio', 'offline', ...
const priority = []; // playlist ids, most wanted first
const prepares = new Map(); // playlist id -> number of prepare() calls waiting
const inflight = new Set(); // `${lane}|${trackKey}` being worked on (or waiting in the write buffer)
const skip = { dz: new Set(), mb: new Set(), apple: new Set() }; // given up for this session
const checkedHere = new Set(); // track keys checked this session (if the store does not keep yearChecked)
const dzFails = new Map();
const appleDone = new Map(); // playlist id -> fragments searched this session
let slowCtrl = null; // aborted by pause(): MusicBrainz and Apple requests stop at once
let stopCtrl = null;
let dzErrors = { streak: 0, last: null };
let mbErrors = { streak: 0, last: null };
let unsubStore = null;

const key = (pid, n) => `${pid}\u0000${n}`;
const posId = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const isrcOf = (v) => (typeof v === 'string' && ISRC_RE.test(v) ? v : null);
const hasText = (v) => typeof v === 'string' && v.trim() !== '';

/* ---------- the year state of a track (pure) ---------- */

/**
 * True while the year check still has to run for this track: not typed by the user, not
 * already trusted (yearSure on a valid year), not marked yearChecked, and there is something
 * to check with (an ISRC, or title + artist). Pure: reads only the stored fields.
 */
export function yearPending(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.yearFixed === true || t.yearChecked === true) return false;
  if (t.yearSure === true && validYear(Number(t.year))) return false;
  return !!(isrcOf(t.isrc) || (hasText(t.title) && hasText(t.artist)));
}

/** A year that can be played with: valid and no longer waiting for the check. */
export const yearChecked = (t) => !!t && validYear(Number(t.year)) && !yearPending(t);

/* ---------- remembered answers ---------- */

let mem = null; // { dz: Set<deezerId>, mb: Map<isrc, year|0>, ms: Map<searchKey, year|0> }
let memTimer = 0;
function memory() {
  if (mem) return mem;
  const raw = ls.get(MEM_KEY, null);
  mem = { dz: new Set(), mb: new Map(), ms: new Map() };
  const yearOk = (y) => y === 0 || validYear(y);
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.dz)) for (const id of raw.dz.slice(-MEM_MAX)) { const n = posId(id); if (n) mem.dz.add(n); }
    for (const [field, valid] of [['mb', isrcOf], ['ms', (k) => typeof k === 'string' && k.length <= 160 && k.includes('|')]]) {
      const o = raw[field];
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      for (const k of Object.keys(o).slice(-MEM_MAX)) {
        const y = Number(o[k]);
        if (valid(k) && typeof o[k] === 'number' && yearOk(y)) mem[field].set(k, y);
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
    const out = { v: 1, dz: [...m.dz] };
    for (const field of ['mb', 'ms']) {
      while (m[field].size > MEM_MAX) m[field].delete(m[field].keys().next().value);
      const o = Object.create(null);
      for (const [k, y] of m[field]) o[k] = y;
      out[field] = o;
    }
    ls.set(MEM_KEY, out);
  }, cfg.memSaveMs);
}

/* ---------- what a track needs ---------- */

const pendingHere = (t, k) => yearPending(t) && !checkedHere.has(k);

/**
 * Where the MusicBrainz check stands for this track: 'todo' (a request is needed), 'failed'
 * (MusicBrainz failed this session), or { year } (answered; year null when it found nothing).
 */
function mbState(t, k) {
  const m = memory();
  const isrc = isrcOf(t.isrc);
  if (isrc && !m.mb.has(isrc)) return skip.mb.has(k) ? 'failed' : 'todo';
  const byIsrc = isrc ? m.mb.get(isrc) : 0;
  if (byIsrc) return { year: byIsrc };
  const sk = hasText(t.title) && hasText(t.artist) ? searchKey({ title: t.title, artist: t.artist }) : null;
  if (sk && !m.ms.has(sk)) return skip.mb.has(k) ? 'failed' : 'todo';
  return { year: (sk && m.ms.get(sk)) || null };
}

const dzNeeded = (t) => {
  const id = posId(t.deezerId);
  return !validYear(t.year) && !!id && !memory().dz.has(id) && !skip.dz.has(id);
};
const appleOk = (t, k) => !t.itunesId && t.match !== 'none' && (hasText(t.title) || hasText(t.artist)) && !skip.apple.has(k);

/** The lanes that have work for this track now (dz and mb may both). */
export function lanesFor(t, k = '') {
  if (!t) return [];
  const out = [];
  const dz = dzNeeded(t);
  if (dz) out.push('dz');
  if (pendingHere(t, k)) {
    const s = mbState(t, k);
    if (s === 'todo') out.push('mb');
    else if (s === 'failed') { if (appleOk(t, k)) out.push('apple'); } // fragment only, the year stays pending
    else if (s.year) out.push('mb'); // apply / finish from the answer we have (no request)
    else if (!dz) out.push(appleOk(t, k) ? 'apple' : 'mb'); // nothing at MusicBrainz: Apple last, else finish
  } else if (appleOk(t, k)) out.push('apple');
  return out;
}

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

// paused: only the year lanes for a playlist someone waits for (prepare) go on
const blocked = (lane) => paused.size > 0 && !(lane !== 'apple' && prepares.size > 0);
const busyOn = (k) => ['dz', 'mb', 'apple'].some((l) => inflight.has(`${l}|${k}`));

function pick(lane) {
  for (const p of orderedLists()) {
    if (paused.size && !prepares.has(p.id)) continue;
    const tracks = p.tracks || [];
    const bits = Math.max(1, Math.ceil(Math.log2(tracks.length + 1)));
    let best = null;
    let bestKey = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const k = key(p.id, t.n);
      // the Deezer year and the MusicBrainz check may run for the same song at once
      if (inflight.has(`${lane}|${k}`) || (lane !== 'dz' && (inflight.has(`mb|${k}`) || inflight.has(`apple|${k}`)))) continue;
      if (!lanesFor(t, k).includes(lane)) continue;
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
  for (const { n, patch } of list) {
    // a store that does not keep yearChecked (yet): remember it for this session, never loop
    if (patch.yearChecked && current(pid, n)?.yearChecked !== true) checkedHere.add(key(pid, n));
  }
}

/** Write the buffered Deezer years (re-checked against the track as it is now). */
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  const byPid = new Map();
  for (const [k, w] of buffer) {
    buffer.delete(k);
    inflight.delete(`dz|${k}`);
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
  // only when the track still has no year (MusicBrainz or the user may have been first)
  writeLater(job.k, { pid: job.pid, n: job.n, patch, check: (cur) => !validYear(cur.year) });
  return true; // stays in flight until the batch is written
}

async function stepMusicBrainz(job, signal) {
  const m = memory();
  let s = mbState(job.t, job.k);
  if (s === 'todo') {
    try {
      const isrc = isrcOf(job.t.isrc);
      if (isrc && !m.mb.has(isrc)) {
        const y = await deps.musicbrainz.firstReleaseYear(isrc, { signal });
        m.mb.set(isrc, validYear(y) ? y : 0);
        saveMemorySoon();
      }
      s = mbState(job.t, job.k);
      if (s === 'todo') { // MusicBrainz does not know the ISRC (or there is none): search
        const y = await deps.musicbrainz.searchFirstReleaseYear({ title: job.t.title, artist: job.t.artist }, { signal });
        m.ms.set(searchKey({ title: job.t.title, artist: job.t.artist }), validYear(y) ? y : 0);
        saveMemorySoon();
        s = mbState(job.t, job.k);
      }
    } catch (e) {
      if (e?.code === 'aborted' || signal.aborted) return false;
      mbErrors = { streak: mbErrors.streak + 1, last: e };
      skip.mb.add(job.k); // try again in a later session
      emitSoon();
      await sleep(cfg.backoffMs);
      return false;
    }
    mbErrors = { streak: 0, last: null };
  }
  if (typeof s !== 'object') return false;
  const cur = current(job.pid, job.n);
  if (!cur || !pendingHere(cur, job.k)) return false; // typed by the user meanwhile, or done
  let patch;
  if (validYear(s.year) && (!validYear(cur.year) || s.year <= cur.year)) patch = { year: s.year, yearSure: true, yearChecked: true };
  else if (validYear(s.year)) patch = { yearChecked: true }; // MusicBrainz says later: ours stays
  else if (dzNeeded(cur) || appleOk(cur, job.k)) return false; // nothing found: Deezer / Apple first
  else patch = { yearChecked: true }; // nothing found anywhere: checked, "controleer het jaar"
  writeNow(job.pid, [{ n: job.n, patch }]);
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
  // the year is only Apple's business when the check is still open and MusicBrainz answered
  // without a year (Apple is the last resort); a checked or typed year is never touched
  const yearTurn = pendingHere(cur, job.k) && mbState(cur, job.k) !== 'failed' && !dzNeeded(cur);
  const yearMaybe = pendingHere(cur, job.k); // MusicBrainz failed this session: improve, not finish
  let patch;
  if (hit && Number.isSafeInteger(hit.itunesId) && hit.itunesId > 0 && !tracks.some((x) => x.itunesId === hit.itunesId && x.n !== job.n)) {
    patch = { itunesId: hit.itunesId, previewUrl: hit.previewUrl || null, trackViewUrl: hit.trackViewUrl || null, match: undefined };
    if (yearMaybe && validYear(hit.year) && (!validYear(cur.year) || hit.year <= cur.year)) {
      patch.year = hit.year;
      patch.yearSure = yearTurn ? !!hit.yearSure : false; // MusicBrainz still has to look at it
    }
  } else {
    patch = { match: 'none' };
  }
  if (yearTurn) patch.yearChecked = true;
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
    const fk = `${name}|${job.k}`;
    inflight.add(fk);
    let keep = false;
    // a prepare() someone waits for is not stopped by a pause
    const signal = name === 'dz' || (name === 'mb' && prepares.has(job.pid)) ? stopCtrl.signal : slowCtrl.signal;
    try {
      keep = await STEPS[name](job, signal);
    } catch (e) {
      console.error(e);
    } finally {
      if (!keep) inflight.delete(fk);
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

/** Dutch message for an error from prepare() (Deezer or MusicBrainz). */
export function errorMessage(e) {
  if (e instanceof mbApi.MusicBrainzError || e?.name === 'MusicBrainzError') return mbApi.errorMessage(e);
  return deezerApi.errorMessage(e);
}

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
 * { total, ready, yearsChecked, yearsPending, yearsMissing, yearsUnsure, fragmentsMissing,
 *   working, pending, appleTodo, appleDone, paused }
 * ready: songs with a year (provisional or checked); yearsChecked: songs with a year whose
 * check is finished (playable for "Jaartal"/"Exact jaar"); yearsPending: songs whose check
 * still has to run; fragmentsMissing: no itunesId and no deezerId; working: background work is
 * going on for it now; pending: songs with any step still to do; appleTodo/appleDone: the
 * Apple Music fragment search ("Fragmenten zoeken bij Apple Music: x van y").
 */
export function status(playlistId) {
  const p = deps.playlists.get?.(playlistId);
  const out = {
    total: 0, ready: 0, yearsChecked: 0, yearsPending: 0, yearsMissing: 0, yearsUnsure: 0, fragmentsMissing: 0,
    working: false, pending: 0, appleTodo: 0, appleDone: appleDone.get(playlistId) || 0, paused: paused.size > 0,
  };
  if (!p) return out;
  let busy = false;
  for (const t of p.tracks || []) {
    const k = key(p.id, t.n);
    const hasYear = validYear(t.year);
    const pend = pendingHere(t, k);
    out.total++;
    if (hasYear) { out.ready++; if (!t.yearSure) out.yearsUnsure++; } else out.yearsMissing++;
    if (pend) out.yearsPending++;
    else if (hasYear) out.yearsChecked++;
    if (!t.itunesId && !posId(t.deezerId)) out.fragmentsMissing++;
    if (busyOn(k)) { busy = true; out.pending++; } else if (lanesFor(t, k).length) out.pending++;
    if (appleOk(t, k)) out.appleTodo++;
  }
  out.working = running && out.pending > 0 && (busy || !paused.size || prepares.has(p.id));
  return out;
}

/** Year work still possible for songs of this playlist whose year is not checked. */
function yearWorkLeft(pid) {
  const p = deps.playlists.get?.(pid);
  return (p?.tracks || []).some((t) => {
    const k = key(pid, t.n);
    if (!pendingHere(t, k) && validYear(t.year)) return false;
    if (busyOn(k)) return true;
    const lanes = lanesFor(t, k);
    // Apple counts only where it finishes the year check (not a fragment-only search)
    return lanes.includes('dz') || lanes.includes('mb') || (lanes.includes('apple') && pendingHere(t, k) && mbState(t, k) !== 'failed');
  });
}

/**
 * For "play at once" with a catalogue list: resolves with status(playlistId) as soon as at
 * least `min` songs have a CHECKED year (or no more years can be checked: look at
 * `yearsChecked`), while the rest goes on in the background. The Deezer year and the
 * MusicBrainz check run side by side, in a spread order for big lists. Works while the worker
 * is paused (only for this list). Rejects with a DeezerError or MusicBrainzError (offline |
 * timeout | quota | unavailable | aborted; Dutch text: errorMessage(e)) when the services keep
 * failing first. onProgress(status): `ready` = years fetched, `yearsChecked` = years checked.
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
    mbErrors = { streak: 0, last: null };
    const check = () => {
      if (finished) return;
      const st = status(playlistId);
      try { onProgress?.(st); } catch (e) { console.error(e); }
      if (st.yearsChecked >= Math.max(0, Number(min) || 0) || !yearWorkLeft(playlistId)) { finish(resolve, st); return; }
      if (globalThis.navigator?.onLine === false) { finish(reject, new deezerApi.DeezerError('offline')); return; }
      for (const err of [dzErrors, mbErrors]) {
        if (err.streak >= 3 && err.last) { finish(reject, err.last instanceof Error ? err.last : new deezerApi.DeezerError('unavailable')); return; }
      }
    };
    unsub = subscribe(check);
    prioritise(playlistId);
    check();
  });
}
