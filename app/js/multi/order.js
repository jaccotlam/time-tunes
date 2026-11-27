// The order of the songs in a game: truly random, fresh songs first, artists spread.
// Pure, no DOM: used by game.js (room server and the phone that hosts a room), the solo games
// (logic.js createGame through the screens) and checked by `npm test` (tests/unit/order.test.mjs).
//
// Rules (in this order):
// 1. Every card of the deck can come up: a deck is never cut to "the first N" on the way to a
//    game (a deck too big for one start message is a uniform random sample: fitCards).
// 2. A uniform shuffle (Fisher-Yates) with the game's seed (gameSeed: crypto.getRandomValues).
// 3. Fresh first: with a played history (songs of earlier games in this room / on this phone)
//    the songs that were NOT played come first; then the played ones, those of the oldest game
//    first. The shuffle order is kept inside each group.
// 4. Artists spread: a song whose (primary, normalised) artist was one of the previous
//    SPREAD_GAP songs is swapped with the first later song of the same group that does not
//    clash; when there is none it stays. Deterministic, ends, and keeps the permutation.
import { seededRandom, shuffle } from '../logic.js';
import { normalizeTitle, splitArtists, fold } from '../spotify-match.js';

export const SPREAD_GAP = 3;
/** Most songs a played history remembers (the oldest games are forgotten first). */
export const HISTORY_MAX = 4000;

/** A random 32-bit seed: crypto.getRandomValues when there is one, else Math.random. */
export function gameSeed() {
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] >>> 0;
  } catch {
    return (Math.random() * 2 ** 32) >>> 0;
  }
}

/** The artist that counts for spreading: the first one named, case and accents ignored. */
export const artistKey = (song) => splitArtists(String(song?.artist || ''))[0] || fold(song?.artist || '');

/**
 * A key of a song that stays the same across games and lists: artist + title (normalised),
 * else an id. Never the card's position.
 */
export function songKey(song) {
  const title = normalizeTitle(String(song?.title || ''));
  const artist = artistKey(song);
  if (title && artist) return `${artist}|${title}`.slice(0, 120);
  if (song?.spotifyId) return `s:${song.spotifyId}`;
  if (song?.itunesId) return `a:${song.itunesId}`;
  if (song?.deezerId) return `d:${song.deezerId}`;
  return `c:${String(song?.id ?? '')}`;
}

/** An empty played history: { n: games started, keys: { songKey: number of the game } }. */
export const emptyHistory = () => ({ n: 0, keys: {} });

/** A played history from storage / a backup, checked (anything else: empty). */
export function cleanHistory(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h) || !Number.isInteger(h.n) || h.n < 0 || !h.keys || typeof h.keys !== 'object' || Array.isArray(h.keys)) return emptyHistory();
  const keys = {};
  let count = 0;
  for (const [k, v] of Object.entries(h.keys)) {
    if (count >= HISTORY_MAX) break;
    if (typeof k !== 'string' || k.length > 120 || k === '__proto__' || !Number.isInteger(v) || v < 0 || v > h.n) continue;
    keys[k] = v;
    count++;
  }
  return { n: h.n, keys };
}

/** A new game starts: its number (the songs it plays are marked with it). */
export function nextGame(history) {
  const h = cleanHistory(history);
  return { ...h, n: h.n + 1 };
}

/** These songs were played in the current game (history.n). Bounded (`max`): the oldest go first. */
export function markPlayed(history, songs, max = HISTORY_MAX) {
  const h = cleanHistory(history);
  const keys = { ...h.keys };
  let changed = false;
  for (const s of songs || []) {
    if (!s) continue;
    const k = songKey(s);
    if (keys[k] === h.n) continue;
    delete keys[k]; // re-insert: insertion order follows the game number
    keys[k] = h.n;
    changed = true;
  }
  if (!changed) return h;
  const entries = Object.entries(keys);
  if (entries.length > max) {
    entries.sort((a, b) => a[1] - b[1]);
    return { n: h.n, keys: Object.fromEntries(entries.slice(entries.length - max)) };
  }
  return { n: h.n, keys };
}

/**
 * Spread artists in a list of songs (in place on a copy): see rule 4. `groupOf(song)` keeps a
 * swap inside one group (fresh / played per game). Returns a new array, same songs.
 */
export function spreadArtists(list, { gap = SPREAD_GAP, groupOf = () => 0 } = {}) {
  const a = list.slice();
  const art = a.map(artistKey);
  const grp = a.map(groupOf);
  const clashes = (i, at) => {
    for (let k = Math.max(0, at - gap); k < at; k++) if (art[k] && art[k] === art[i]) return true;
    return false;
  };
  for (let i = 1; i < a.length; i++) {
    if (!clashes(i, i)) continue;
    for (let j = i + 1; j < a.length; j++) {
      if (grp[j] !== grp[i] || clashes(j, i)) continue;
      [a[i], a[j]] = [a[j], a[i]];
      [art[i], art[j]] = [art[j], art[i]];
      [grp[i], grp[j]] = [grp[j], grp[i]];
      break;
    }
  }
  return a;
}

/**
 * The order of a game's songs: ids of `songs` (cards by id) shuffled with `rand`, the unplayed
 * ones of `history` first (rule 3), artists spread (rule 4). Returns the ids.
 */
export function orderSongs(ids, songs, { rand = Math.random, history = null } = {}) {
  const shuffled = shuffle(ids, rand);
  const h = history ? cleanHistory(history) : null;
  const groupOf = (id) => {
    if (!h) return 0;
    const g = h.keys[songKey(songs[id])];
    return g === undefined ? -1 : g; // -1: never played, comes first
  };
  const groups = new Map();
  for (const id of shuffled) {
    const g = groupOf(id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(id);
  }
  const ordered = [...groups.keys()].sort((x, y) => x - y).flatMap((g) => groups.get(g));
  const spread = spreadArtists(ordered.map((id) => ({ id, artist: songs[id]?.artist, g: groupOf(id) })), { groupOf: (x) => x.g });
  return spread.map((x) => x.id);
}

/** A uniform random sample of `n` items (order random too). */
export function sample(items, n, rand = Math.random) {
  const list = items || [];
  if (list.length <= n) return shuffle(list, rand);
  return shuffle(list, rand).slice(0, n);
}

/** Seeded helper for callers that only have a seed. */
export const randFor = (seed) => seededRandom(seed >>> 0);
