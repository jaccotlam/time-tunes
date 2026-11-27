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
/**
 * Most songs a played history remembers (the oldest games are forgotten first). 1500 keys of
 * ~11 characters are ~30 kB of JSON: small next to a 2000-card game in the room's stored value.
 */
export const HISTORY_MAX = 1500;
/** A history key: a short hash of the song's text key (hashKey). */
const HASH_RE = /^[0-9a-z]{1,11}$/;

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
 * The text that identifies a song across games and lists: artist + title (normalised), else
 * an id. Never the card's position. (Histories stored before the hashes used it as the key.)
 */
export function songText(song) {
  const title = normalizeTitle(String(song?.title || ''));
  const artist = artistKey(song);
  if (title && artist) return `${artist}|${title}`.slice(0, 120);
  if (song?.spotifyId) return `s:${song.spotifyId}`;
  if (song?.itunesId) return `a:${song.itunesId}`;
  if (song?.deezerId) return `d:${song.deezerId}`;
  return `c:${String(song?.id ?? '')}`;
}

/**
 * A short stable hash of a text key (cyrb53: 53 bits, base 36, at most 11 characters). Two
 * different songs share one only by chance (about 1 in 10^12 per pair): then a fresh song
 * merely counts as played. A text key always holds '|' or ':', so it never looks like a hash.
 */
export function hashKey(text) {
  const str = String(text);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The key of a song in a played history: the hash of songText (same song, same key). */
export const songKey = (song) => hashKey(songText(song));

/** An empty played history: { n: games started, keys: { songKey: number of the game } }. */
export const emptyHistory = () => ({ n: 0, keys: {} });

const validGame = (v, n) => Number.isInteger(v) && v >= 0 && v <= n;

/** Already a clean history (hash keys, valid game numbers, not too many)? Then it is used as it is. */
function isClean(h, max) {
  if (!h || typeof h !== 'object' || Array.isArray(h) || !Number.isInteger(h.n) || h.n < 0 || !h.keys || typeof h.keys !== 'object' || Array.isArray(h.keys)) return false;
  if (Object.getPrototypeOf(h.keys) !== Object.prototype && Object.getPrototypeOf(h.keys) !== null) return false;
  let count = 0;
  for (const k in h.keys) {
    if (!Object.hasOwn(h.keys, k) || ++count > max || !HASH_RE.test(k) || !validGame(h.keys[k], h.n)) return false;
  }
  return true;
}

/** Keep the `max` most recent entries (highest game number); insertion order follows the game number. */
function newest(entries, max) {
  entries.sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(entries.length > max ? entries.slice(entries.length - max) : entries);
}

/**
 * A played history from storage / a backup, checked (anything else: empty). A clean one comes
 * back as the same object (no copy). An old one with text keys ("artist|title") is converted
 * to hash keys; more than HISTORY_MAX keeps the newest games.
 */
export function cleanHistory(h, max = HISTORY_MAX) {
  if (isClean(h, max)) return h;
  if (!h || typeof h !== 'object' || Array.isArray(h) || !Number.isInteger(h.n) || h.n < 0 || !h.keys || typeof h.keys !== 'object' || Array.isArray(h.keys)) return emptyHistory();
  const keys = new Map();
  let seen = 0;
  for (const [k, v] of Object.entries(h.keys)) {
    if (++seen > 20000) break; // a forged history can not keep the server busy
    if (typeof k !== 'string' || k.length > 120 || k === '__proto__' || !validGame(v, h.n)) continue;
    const key = HASH_RE.test(k) ? k : hashKey(k);
    if (!(keys.get(key) >= v)) keys.set(key, v);
  }
  return { n: h.n, keys: newest([...keys], max) };
}

/** A new game starts: its number (the songs it plays are marked with it). */
export function nextGame(history) {
  const h = cleanHistory(history);
  return { n: h.n + 1, keys: h.keys };
}

/**
 * These songs were played in the current game (history.n). Bounded (`max`): the oldest go
 * first. Nothing new: the same (clean) object comes back, nothing is copied.
 */
export function markPlayed(history, songs, max = HISTORY_MAX) {
  const h = cleanHistory(history, Math.max(max, HISTORY_MAX));
  const add = [];
  for (const s of songs || []) {
    if (!s) continue;
    const k = songKey(s);
    if (h.keys[k] !== h.n && !add.includes(k)) add.push(k);
  }
  if (!add.length && Object.keys(h.keys).length <= max) return h;
  const keys = { ...h.keys };
  for (const k of add) {
    delete keys[k]; // re-insert: insertion order follows the game number
    keys[k] = h.n;
  }
  const entries = Object.entries(keys);
  return { n: h.n, keys: entries.length > max ? newest(entries, max) : keys };
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
