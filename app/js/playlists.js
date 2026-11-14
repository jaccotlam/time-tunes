// Own playlists in localStorage + which deck is active.
// Data: timetunesr.playlists.v1 = { v: 1, lists: [{ id, name, created, updated, nextN, tracks }] }
//       timetunesr.activeDeck.v1 = 'builtin' | <playlist id>
// Every track: { n, itunesId, spotifyId?, title, artist, album, year, yearSure, previewUrl, trackViewUrl, match? }
// `n` is the card number of the track within its playlist (stable, never reused).
import { store } from './ui.js';
import {
  migrateStore, cleanPlaylist, cleanTrack, cleanName, BUILTIN_ID, STORE_VERSION, MAX_TRACKS, validYear,
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

function write(reason = 'change') {
  const ok = store.set(KEY, { v: STORE_VERSION, lists: read().lists });
  emit(reason);
  return ok;
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
  if (!write('create')) { read().lists.pop(); return null; }
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
  || (a.spotifyId && b.spotifyId && a.spotifyId === b.spotifyId);

/** Add tracks (duplicates are skipped). Resolves with { added: [tracks], duplicates, full }. */
export function addTracks(id, tracks) {
  const p = get(id);
  if (!p) return { added: [], duplicates: 0, full: false };
  const added = [];
  let duplicates = 0;
  let full = false;
  for (const raw of tracks || []) {
    const t = cleanTrack(raw);
    if (!t) continue;
    if (p.tracks.some((x) => sameTrack(x, t))) { duplicates++; continue; }
    if (p.tracks.length >= MAX_TRACKS) { full = true; break; }
    t.n = p.nextN++;
    p.tracks.push(t);
    added.push(t);
  }
  if (added.length) { p.updated = Date.now(); write('tracks'); }
  return { added, duplicates, full };
}

export function updateTrack(id, n, patch) {
  const p = get(id);
  const t = p?.tracks.find((x) => x.n === n);
  if (!t) return null;
  const next = cleanTrack({ ...t, ...patch, n });
  if (!next) return null;
  if (patch && 'year' in patch && validYear(Number(patch.year)) && !('yearSure' in patch)) next.yearSure = true;
  Object.keys(t).forEach((k) => delete t[k]);
  Object.assign(t, next);
  p.updated = Date.now();
  write('track');
  return t;
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
  write('track');
  return t;
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
  return write('change');
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

/** Playable songs of a playlist: a year plus an iTunes id (or a Spotify id). */
export function playableCount(p) {
  return (p?.tracks || []).filter((t) => validYear(t.year) && (t.itunesId || t.spotifyId)).length;
}
