// "Mix van de groep": every phone in a server room may add a part of its owner's most
// played Spotify songs; at the start the server builds the game's songs from those
// contributions. Pure, no DOM, no network: shared by the phones (screens/room-*.js,
// mix-share.js) and the room server (server/room.mjs), and checked by `npm test`.
//
// Rules for building the mix (buildMix):
// - only songs the music phone can play: with the fragment source a song needs an Apple
//   Music match (previewUrl or itunesId), with the Spotify source a spotifyId is enough;
// - duplicates (same spotifyId, or the same artist + title after normalising) count once
//   and keep every contributor ("favoriet van Sam & Lisa");
// - fair: everybody gets the same quota (MIX_GAME_MAX / contributors); a player with fewer
//   songs simply gives fewer. The quota only grows when the game would otherwise be short;
// - within a player's songs the ones with a sure year go first (a year from Apple Music
//   that is clearly the original), so unsure years are left out first;
// - shuffled with the game seed (predictable for tests with a fixed seed).
import { seededRandom, shuffle } from '../logic.js';
import { normalizeTitle, normalizeArtist, splitArtists } from '../spotify-match.js';
import { DISCO_MIN_SONGS } from './disco.js';

/** Most songs one phone may add to a room (Spotify gives at most 50 top songs per call). */
export const MIX_PER_PLAYER = 50;
/** Most songs in one room's mix together. */
export const MIX_TOTAL = 400;
/** Most songs in one mix-add message. */
export const MIX_PER_MESSAGE = 25;
/** Most songs in the pile of one game from the mix. */
export const MIX_GAME_MAX = 80;

/** What a phone may choose: period (Spotify time_range) and how many of its top songs to share. */
export const RANGES = [
  { key: 'short_term', label: 'Laatste weken', sub: 'ongeveer 4 weken' },
  { key: 'medium_term', label: 'Laatste half jaar', sub: 'ongeveer 6 maanden' },
  { key: 'long_term', label: 'Langste tijd', sub: 'een jaar of langer' },
];
export const DEFAULT_RANGE = 'medium_term';
export const SHARE_COUNTS = [10, 15, 25];
export const DEFAULT_SHARE_COUNT = 15;
/** Top songs fetched to choose from (the maximum Spotify gives in one call). */
export const TOP_POOL = 50;

export const validRange = (r) => RANGES.some((x) => x.key === r);
export const rangeLabel = (r) => (RANGES.find((x) => x.key === r) || RANGES[1]).label;

/**
 * A random choice of `count` songs from the top list (so it is not the same every
 * evening), without duplicates, in the top list's order.
 */
export function pickTopSelection(tracks, count, rand = Math.random) {
  const seen = new Set();
  const uniq = [];
  for (const t of tracks || []) {
    if (!t) continue;
    const k = mixKey(t);
    if (!k || seen.has(k) || seen.has(`s:${t.spotifyId}`)) continue;
    seen.add(k);
    if (t.spotifyId) seen.add(`s:${t.spotifyId}`);
    uniq.push(t);
  }
  const n = Math.max(0, Math.min(Number(count) || 0, uniq.length));
  if (n >= uniq.length) return uniq;
  const chosen = new Set(shuffle(uniq.map((_, i) => i), rand).slice(0, n));
  return uniq.filter((_, i) => chosen.has(i));
}

const keys = new WeakMap(); // the server works the counts out often: normalise every song once

/** Key for "the same song": normalised main artist + core title. */
export function mixKey(t) {
  if (t && typeof t === 'object' && keys.has(t)) return keys.get(t);
  const title = normalizeTitle(t?.title || '');
  const artist = splitArtists(t?.artist || '')[0] || normalizeArtist(t?.artist || '');
  const k = title ? `${artist}|${title}` : '';
  if (t && typeof t === 'object') keys.set(t, k);
  return k;
}

const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
const ctrl = /[\u0000-\u001f\u007f]/g;
const text = (v, max) => (typeof v === 'string' ? v.replace(ctrl, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Server side: check one contributed song. Returns a clean
 * { spotifyId, title, artist, year, sure, itunesId?, previewUrl? } or null.
 */
export function cleanMixTrack(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const spotifyId = typeof t.spotifyId === 'string' && SPOTIFY_ID.test(t.spotifyId) ? t.spotifyId : null;
  const title = text(t.title, 200);
  const artist = text(t.artist, 200);
  const year = Number(t.year);
  if (!spotifyId || !title || !artist || !Number.isInteger(year) || year < 1900 || year > 2100) return null;
  const out = { spotifyId, title, artist, year, sure: t.sure === true };
  const id = Number(t.itunesId);
  if (Number.isSafeInteger(id) && id > 0) out.itunesId = id;
  if (typeof t.previewUrl === 'string' && /^https:\/\/[^\s"'<>]{4,600}$/.test(t.previewUrl)) out.previewUrl = t.previewUrl;
  return out;
}

/** Can the music phone play this song with `source` ('preview' | 'spotify')? */
export const playableWith = (t, source) => (source === 'spotify' ? !!t.spotifyId : !!(t.previewUrl || t.itunesId));

/**
 * Add songs to one player's contribution. `list`: the current songs. Returns
 * { list, added, refused } (refused: over the per-player or room limit, or invalid).
 */
export function addToContribution(list, incoming, { roomTotal = 0 } = {}) {
  const next = (list || []).slice();
  const ids = new Set(next.map((t) => t.spotifyId));
  let added = 0;
  let refused = 0;
  let total = roomTotal;
  for (const raw of Array.isArray(incoming) ? incoming.slice(0, MIX_PER_MESSAGE) : []) {
    const t = cleanMixTrack(raw);
    if (!t) { refused++; continue; }
    if (ids.has(t.spotifyId)) continue; // sent twice (a reconnect): fine
    if (next.length >= MIX_PER_PLAYER || total >= MIX_TOTAL) { refused++; continue; }
    next.push(t);
    ids.add(t.spotifyId);
    added++;
    total++;
  }
  if (Array.isArray(incoming) && incoming.length > MIX_PER_MESSAGE) refused += incoming.length - MIX_PER_MESSAGE;
  return { list: next, added, refused };
}

/** Number of songs in all contributions together. */
export const contributionTotal = (contrib) => Object.values(contrib || {}).reduce((n, c) => n + (c?.tracks?.length || 0), 0);

/** Songs of all contributions without duplicates: [{ track, from: [pid] }] (first contributor first). */
function unique(contrib, order) {
  const byKey = new Map();
  const out = [];
  for (const pid of order) {
    for (const t of contrib[pid]?.tracks || []) {
      const k1 = `s:${t.spotifyId}`;
      const k2 = mixKey(t);
      const hit = byKey.get(k1) || (k2 && byKey.get(k2));
      if (hit) { if (!hit.from.includes(pid)) hit.from.push(pid); continue; }
      const e = { track: t, from: [pid] };
      byKey.set(k1, e);
      if (k2) byKey.set(k2, e);
      out.push(e);
    }
  }
  return out;
}

/**
 * Counts for the screens (never titles): { total, preview, sure, contributors }.
 * `total`: different songs, `preview`: of those with an Apple Music fragment.
 */
export function mixStats(contrib) {
  const order = Object.keys(contrib || {}).filter((pid) => contrib[pid]?.tracks?.length).sort();
  const u = unique(contrib || {}, order);
  return {
    total: u.length,
    preview: u.filter((e) => playableWith(e.track, 'preview')).length,
    sure: u.filter((e) => e.track.sure).length,
    contributors: order.length,
  };
}

/**
 * How many songs a game from the mix needs at least. Bingo: enough rounds for somebody
 * to complete a line (3×3: 10, 4×4: 16); Discobingo 25. Tijdlijn: one start card per player plus the
 * goal. Never less than the game machine itself asks for (players + 2).
 */
export function mixMinimum(settings = {}, players = 1) {
  const n = Math.max(1, Number(players) || 1);
  if (settings.game === 'quiz') return Math.min(Number(settings.questions) || 10, 10); // Quiz: ten questions
  if (settings.game === 'disco') return Math.max(n + 2, DISCO_MIN_SONGS); // Discobingo: one song per square
  if (settings.game === 'timeline') return Math.max(n + 2, (Number(settings.goal) || 10) + n);
  return Math.max(n + 2, Number(settings.size) === 3 ? 10 : 16);
}

export class MixError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * Build the songs of a game from the contributions.
 * contrib: { pid: { tracks: [...] } }, names: { pid: name }.
 * Options: seed, source ('preview' | 'spotify'), need (minimum, see mixMinimum), max.
 * Returns cards { id: 'm1'.., year, title, artist, spotifyId, itunesId?, previewUrl?, from, by }.
 * Throws MixError 'mix' (with `have` and `need`) when there are too few songs.
 */
export function buildMix(contrib, { seed = 1, source = 'preview', need = 1, max = MIX_GAME_MAX, names = {} } = {}) {
  const rand = seededRandom(((seed >>> 0) ^ 0x5bd1e995) >>> 0);
  const order = Object.keys(contrib || {}).sort();
  const all = unique(contrib || {}, order).filter((e) => playableWith(e.track, source));
  // per player: own songs (first contributor), sure years first, each group shuffled
  const lists = order.map((pid) => {
    const mine = all.filter((e) => e.from[0] === pid);
    return [...shuffle(mine.filter((e) => e.track.sure), rand), ...shuffle(mine.filter((e) => !e.track.sure), rand)];
  }).filter((l) => l.length);
  const have = all.length;
  const cap = Math.max(1, Math.min(max, MIX_TOTAL));
  if (have < need || !lists.length) {
    throw new MixError('mix', `Te weinig nummers in de mix van de groep: ${have} van de minstens ${need}.`, { have, need });
  }
  const longest = Math.max(...lists.map((l) => l.length));
  let picked = [];
  for (let q = Math.ceil(cap / lists.length); ; q++) {
    picked = [];
    // round robin: one song per player per turn, until everybody's quota is used
    for (let turn = 0; turn < q && picked.length < cap; turn++) {
      for (const l of lists) if (turn < l.length && picked.length < cap) picked.push(l[turn]);
    }
    if (picked.length >= Math.min(need, cap) || q >= longest) break;
  }
  const cards = shuffle(picked, rand).map((e, i) => {
    const t = e.track;
    const c = { id: `m${i + 1}`, year: t.year, title: t.title, artist: t.artist, spotifyId: t.spotifyId, from: e.from.slice(), by: e.from.map((pid) => names[pid] || 'Speler') };
    if (t.itunesId) c.itunesId = t.itunesId;
    if (t.previewUrl) c.previewUrl = t.previewUrl;
    if (!t.sure) c.unsure = true;
    return c;
  });
  return cards;
}

/** Track of a contribution, as a phone builds it (after the Apple Music match). */
export function contributionTrack({ spotifyId, title, artist, year, yearSure, itunesId, previewUrl }) {
  const t = { spotifyId, title, artist, year, sure: !!yearSure };
  if (itunesId) t.itunesId = itunesId;
  if (previewUrl) t.previewUrl = previewUrl;
  return t;
}
