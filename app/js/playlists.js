// Own playlists in localStorage + which deck is active.
// Data: timetunesr.playlists.v1 = { v: 1, lists: [{ id, name, created, updated, nextN, tracks }] }
//       timetunesr.activeDeck.v1 = 'builtin' | <playlist id>
//       a playlist may carry source: { kind: 'spotify' | 'deezer', id, name } (where it was imported from)
// Every track: { n, itunesId, spotifyId?, deezerId?, isrc?, title, artist, album, year, yearSure, yearFixed?, match? }
// (see cleanTrack in playlist-logic.js; old data with previewUrl / trackViewUrl still loads).
// `n` is the card number of the track within its playlist (stable, never reused).
// Every change is written at once; when localStorage is full the change is undone (the list
// stays as it was stored), the operation reports `error: 'storage'`, subscribers hear
// 'storage-full' and the player sees STORAGE_FULL_MESSAGE: never a silent loss.
import { store, toast } from './ui.js';
import {
  migrateStore, cleanPlaylist, cleanTrack, cleanName, cleanSource, BUILTIN_ID, STORE_VERSION, MAX_TRACKS, validYear,
  playableTotal,
} from './playlist-logic.js';

export const KEY = 'timetunesr.playlists.v1';
export const ACTIVE_KEY = 'timetunesr.activeDeck.v1';

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(reason) {
  for (const fn of listeners) { try { fn(reason); } catch (e) { console.error(e); } }
}

let cache = null;
function read() {
  if (!cache) {
    cache = migrateStore(store.get(KEY, null));
  }
  return cache;
}
/** Re-read storage (another tab, a test, or an import). */
export function reload() { cache = null; emit('reload'); }

export const STORAGE_FULL_MESSAGE = 'De opslag van deze browser is vol: de wijziging is niet bewaard. Verwijder een playlist die je niet meer gebruikt (of maak hem kleiner) en probeer het opnieuw.';

let lastError = null;
/** 'storage' after a write that did not fit, null after one that did. */
export const lastWriteError = () => lastError;

/** Write everything; on a full storage roll the in-memory state back to what is stored. */
function write(reason = 'change') {
  const ok = store.set(KEY, { v: STORE_VERSION, lists: read().lists });
  if (!ok) {
    lastError = 'storage';
    cache = null; // back to what storage still holds: nothing half-done stays in memory
    try { toast(STORAGE_FULL_MESSAGE, { kind: 'warn', ms: 8000 }); } catch { /* no page (tests) */ }
    emit('storage-full');
    emit('reload'); // screens draw the list again as it is stored
    return false;
  }
  lastError = null;
  emit(reason);
  return true;
}

globalThis.window?.addEventListener?.('storage', (e) => { if (e.key === KEY || e.key === ACTIVE_KEY) reload(); });

export const all = () => read().lists;
export const get = (id) => read().lists.find((p) => p.id === id) || null;

function newId() {
  let id;
  do { id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`; } while (get(id));
  return id;
}

/** A name that is not used yet ("Feest", "Feest (2)", ...). */
export function uniqueName(name) {
  const base = cleanName(name);
  const taken = new Set(all().map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base.slice(0, 34)} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

export function create(name, extra = {}) {
  const p = cleanPlaylist({ ...extra, id: newId(), name: uniqueName(name), created: Date.now(), tracks: extra.tracks || [] });
  read().lists.push(p);
  if (!write('create')) return null;
  return p;
}

export function rename(id, name) {
  const p = get(id);
  if (!p) return false;
  p.name = cleanName(name, p.name);
  p.updated = Date.now();
  return write('rename');
}

export function remove(id) {
  const lists = read().lists;
  const i = lists.findIndex((p) => p.id === id);
  if (i < 0) return false;
  lists.splice(i, 1);
  if (getActiveId() === id) setActive(BUILTIN_ID);
  return write('remove');
}

const sameTrack = (a, b) => (a.itunesId && b.itunesId && a.itunesId === b.itunesId)
  || (a.spotifyId && b.spotifyId && a.spotifyId === b.spotifyId)
  || (a.deezerId && b.deezerId && a.deezerId === b.deezerId)
  || (a.isrc && b.isrc && a.isrc === b.isrc);

/** Lookup of the tracks of a playlist by every id (fast duplicate checks for 2000 songs). */
function trackIndex(tracks) {
  const m = new Map();
  const put = (t) => {
    if (t.itunesId) m.set(`a${t.itunesId}`, t);
    if (t.spotifyId) m.set(`s${t.spotifyId}`, t);
    if (t.deezerId) m.set(`d${t.deezerId}`, t);
    if (t.isrc) m.set(`i${t.isrc}`, t);
  };
  for (const t of tracks) put(t);
  return {
    find: (t) => (t.itunesId && m.get(`a${t.itunesId}`)) || (t.spotifyId && m.get(`s${t.spotifyId}`))
      || (t.deezerId && m.get(`d${t.deezerId}`)) || (t.isrc && m.get(`i${t.isrc}`)) || null,
    put,
  };
}

/**
 * Add tracks (duplicates are skipped). Returns { added: [tracks], duplicates, full, error? }
 * (error 'storage': nothing was added because the browser storage is full).
 */
export function addTracks(id, tracks) {
  const p = get(id);
  if (!p) return { added: [], duplicates: 0, full: false };
  const added = [];
  let duplicates = 0;
  let full = false;
  const index = trackIndex(p.tracks);
  for (const raw of tracks || []) {
    const t = cleanTrack(raw);
    if (!t) continue;
    if (index.find(t)) { duplicates++; continue; }
    if (p.tracks.length >= MAX_TRACKS) { full = true; break; }
    t.n = p.nextN++;
    p.tracks.push(t);
    index.put(t);
    added.push(t);
  }
  if (added.length) {
    p.updated = Date.now();
    if (!write('tracks')) return { added: [], duplicates, full, error: 'storage' };
  }
  return { added, duplicates, full };
}

function applyPatch(t, n, patch) {
  const next = cleanTrack({ ...t, ...patch, n });
  if (!next) return null;
  if (patch && 'year' in patch && validYear(Number(patch.year)) && !('yearSure' in patch)) next.yearSure = true;
  // a year the player typed stays: background work (enrich) never overwrites it
  if (t.yearFixed && patch?.yearFixed === undefined && validYear(t.year)) { next.year = t.year; next.yearSure = true; next.yearFixed = true; }
  Object.keys(t).forEach((k) => delete t[k]);
  Object.assign(t, next);
  return t;
}

/**
 * Change fields of one track (cleanTrack rules). A year the player fixed (fixYear) is kept
 * unless the patch says yearFixed: false. Null when not found / not valid / not stored.
 */
export function updateTrack(id, n, patch) {
  const p = get(id);
  const t = p?.tracks.find((x) => x.n === n);
  if (!t || !cleanTrack({ ...t, ...patch, n })) return null;
  applyPatch(t, n, patch);
  p.updated = Date.now();
  if (!write('track')) return null;
  return get(id)?.tracks.find((x) => x.n === n) || null;
}

/**
 * Many track changes with one write (background work on big lists): [{ n, patch }].
 * Returns the number of tracks changed (0 when nothing was stored).
 */
export function updateTracks(id, changes) {
  const p = get(id);
  if (!p) return 0;
  const byN = new Map(p.tracks.map((t) => [t.n, t]));
  let changed = 0;
  for (const { n, patch } of changes || []) {
    const t = byN.get(n);
    if (!t || !cleanTrack({ ...t, ...patch, n })) continue;
    const before = JSON.stringify(t);
    applyPatch(t, n, patch);
    if (JSON.stringify(t) !== before) changed++;
  }
  if (!changed) return 0;
  p.updated = Date.now();
  return write('track') ? changed : 0;
}

/** The player typed this year: it is sure and background work never changes it again. */
export function fixYear(id, n, year) {
  if (!validYear(Number(year))) return null;
  return updateTrack(id, n, { year: Number(year), yearSure: true, yearFixed: true });
}

/** Replace a track by another song (keeps its card number). */
export function replaceTrack(id, n, track) {
  const p = get(id);
  const i = p ? p.tracks.findIndex((x) => x.n === n) : -1;
  const t = cleanTrack(track);
  if (i < 0 || !t) return null;
  if (p.tracks.some((x, j) => j !== i && sameTrack(x, t))) return null;
  t.n = n;
  p.tracks[i] = t;
  p.updated = Date.now();
  return write('track') ? t : null;
}

export function removeTrack(id, n) {
  const p = get(id);
  if (!p) return false;
  const i = p.tracks.findIndex((x) => x.n === n);
  if (i < 0) return false;
  p.tracks.splice(i, 1);
  p.updated = Date.now();
  return write('track');
}

/** Set fields on the playlist itself (shareId, partsSeen, ...). */
export function patchPlaylist(id, patch) {
  const p = get(id);
  if (!p) return false;
  Object.assign(p, patch, { updated: Date.now() });
  if ('source' in (patch || {})) { const src = cleanSource(patch.source); if (src) p.source = src; else delete p.source; }
  return write('change');
}

/** The playlist imported from this source (kind + id), or null. */
export function findBySource(kind, sourceId) {
  const src = cleanSource({ kind, id: sourceId, name: '' });
  if (!src) return null;
  return read().lists.find((p) => p.source?.kind === src.kind && p.source.id === src.id) || null;
}

/**
 * Import a Spotify or Deezer playlist: the first time a new playlist (named after the source,
 * remembering `source`), the next time the SAME playlist is updated: new songs are added,
 * songs already there keep their card number, year and the player's fixes; only empty fields
 * (an ISRC, a Spotify / Deezer id, a missing year) are filled in. Songs that left the source
 * stay. `tracks`: anything cleanTrack takes ({ spotifyId | deezerId, title, artist, album,
 * year (or spYear), yearSure, isrc }). Pass yearSure: false for a year that is a guess.
 * Returns { playlist, added, duplicates, created, full, error? } (error 'storage' / 'source').
 */
export function importFromSource({ kind, id, name } = {}, tracks = []) {
  const source = cleanSource({ kind, id, name });
  if (!source) return { playlist: null, added: 0, duplicates: 0, created: false, full: false, error: 'source' };
  const clean = [];
  for (const raw of tracks || []) {
    const t = cleanTrack(raw && raw.year == null && raw.spYear != null ? { ...raw, year: raw.spYear } : raw);
    if (t) clean.push(t);
  }
  let p = findBySource(source.kind, source.id);
  const created = !p;
  if (created) {
    // the new list is made in memory and written once, together with its songs
    p = cleanPlaylist({ id: newId(), name: uniqueName(source.name || (source.kind === 'spotify' ? 'Spotify-playlist' : 'Deezer-playlist')), created: Date.now(), tracks: [], source });
    read().lists.push(p);
  }
  const index = trackIndex(p.tracks);
  let added = 0;
  let duplicates = 0;
  let full = false;
  let touched = created;
  for (const t of clean) {
    const have = index.find(t);
    if (have) {
      duplicates++;
      for (const k of ['spotifyId', 'deezerId', 'isrc', 'itunesId']) if (t[k] && !have[k]) { have[k] = t[k]; touched = true; }
      if (!have.album && t.album) { have.album = t.album; touched = true; }
      if (!validYear(have.year) && validYear(t.year)) { have.year = t.year; have.yearSure = t.yearSure; touched = true; }
      index.put(have);
      continue;
    }
    if (p.tracks.length >= MAX_TRACKS) { full = true; continue; }
    t.n = p.nextN++;
    p.tracks.push(t);
    index.put(t);
    added++;
    touched = true;
  }
  if (source.name && p.source?.name !== source.name) { p.source = { ...source }; touched = true; }
  if (touched) {
    p.updated = Date.now();
    if (!write(created ? 'create' : 'tracks')) return { playlist: null, added: 0, duplicates, created: false, full, error: 'storage' };
  }
  return { playlist: get(p.id), added, duplicates, created, full };
}

export function findByShareId(shareId) {
  return read().lists.find((p) => p.shareId === shareId) || null;
}

/* ---------- active deck ---------- */

export function getActiveId() {
  const id = store.get(ACTIVE_KEY, BUILTIN_ID);
  if (typeof id !== 'string' || (id !== BUILTIN_ID && !get(id))) return BUILTIN_ID;
  return id;
}

export function setActive(id) {
  const v = id && id !== BUILTIN_ID && get(id) ? id : BUILTIN_ID;
  store.set(ACTIVE_KEY, v);
  emit('active');
  return v;
}

/**
 * Playable songs of a playlist with this music source ('preview' | 'spotify'; see
 * playable() in playlist-logic.js). Without a source: playable with either one (as before,
 * where a Spotify id counted too); screens pass deck.musicSource().
 */
export function playableCount(p, source) {
  const tracks = p?.tracks || [];
  if (source) return playableTotal(tracks, source);
  return playableTotal(tracks, 'spotify');
}
