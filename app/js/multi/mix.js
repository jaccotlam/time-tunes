// "Mix van de groep": every phone in a server room may add songs to the room: a part of its
// owner's most played Spotify songs ("Doe mijn favorieten erbij"), or a random part of one or
// more public Deezer playlists ("Kies een playlist", no login). At the start the server builds
// the game's songs from those contributions. Pure, no DOM, no network: shared by the phones
// (screens/room-*.js, mix-share.js, mix-lists.js) and the room server (server/room.mjs), and
// checked by `npm test`.
//
// Rules for building the mix (buildMix):
// - only songs the music phone can play (playable() in playlist-logic.js): with the fragment
//   source a song needs an Apple Music match (previewUrl or itunesId) or a Deezer id, with the
//   Spotify source any song will do (spotifyId, ISRC or title + artist search);
// - duplicates (same spotifyId, deezerId or ISRC, or the same artist + title after
//   normalising) count once and keep every contributor ("favoriet van Sam & Lisa");
// - fair: everybody gets the same quota (MIX_GAME_MAX / contributors); a player with fewer
//   songs simply gives fewer. The quota only grows when the game would otherwise be short;
// - within a player's songs the ones with a sure year go first (a year from Apple Music
//   that is clearly the original, or MusicBrainz by ISRC), so unsure years are left out first;
// - shuffled with the game seed (predictable for tests with a fixed seed).
import { seededRandom, shuffle } from '../logic.js';
import { normalizeTitle, normalizeArtist, splitArtists } from '../spotify-match.js';
import { DISCO_MIN_SONGS } from './disco.js';
import { playable } from '../playlist-logic.js';
import { cleanHistory, songKey } from './order.js';

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
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const ctrl = /[\u0000-\u001f\u007f]/g;
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max * 4).replace(ctrl, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Own property only: a `__proto__` key in the JSON (or a polluted prototype) never counts. */
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const isrcOf = (v) => (typeof v === 'string' && v.length <= 20 && ISRC.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null);

/**
 * Server side: check one contributed song. Returns a clean
 * { spotifyId?, deezerId?, isrc?, title, artist, year, sure, itunesId?, previewUrl? } or null.
 * A song needs a Spotify id (favourites) or a Deezer id (a playlist). A song from a catalogue
 * (no Spotify id) only counts when the phone checked its year (`checked: true`): catalogue
 * years are often the year of a re-release, and the game asks for the original year.
 */
export function cleanMixTrack(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const sp = own(t, 'spotifyId');
  const spotifyId = typeof sp === 'string' && SPOTIFY_ID.test(sp) ? sp : null;
  const deezerId = posInt(own(t, 'deezerId'));
  const title = text(own(t, 'title'), 200);
  const artist = text(own(t, 'artist'), 200);
  const yv = own(t, 'year');
  const year = typeof yv === 'number' || typeof yv === 'string' ? Number(yv) : NaN;
  if ((!spotifyId && !deezerId) || !title || !artist || !Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (!spotifyId && own(t, 'checked') !== true) return null;
  const out = { title, artist, year, sure: own(t, 'sure') === true };
  if (spotifyId) out.spotifyId = spotifyId;
  if (deezerId) out.deezerId = deezerId;
  const isrc = isrcOf(own(t, 'isrc'));
  if (isrc) out.isrc = isrc;
  const id = Number(own(t, 'itunesId'));
  if (Number.isSafeInteger(id) && id > 0) out.itunesId = id;
  const pv = own(t, 'previewUrl');
  if (typeof pv === 'string' && /^https:\/\/[^\s"'<>]{4,600}$/.test(pv)) out.previewUrl = pv;
  return out;
}

/** The ids that make two songs "the same recording": s:spotifyId, d:deezerId, i:isrc. */
export function idKeys(t) {
  const k = [];
  if (t?.spotifyId) k.push(`s:${t.spotifyId}`);
  if (t?.deezerId) k.push(`d:${t.deezerId}`);
  if (t?.isrc) k.push(`i:${t.isrc}`);
  return k;
}

/** Can the music phone play this song with `source` ('preview' | 'spotify')? The one rule: playable() in playlist-logic.js. */
export const playableWith = (t, source) => playable(t, source);

/**
 * Add songs to one player's contribution. `list`: the current songs. Returns
 * { list, added, refused } (refused: over the per-player or room limit, or invalid).
 */
export function addToContribution(list, incoming, { roomTotal = 0 } = {}) {
  const next = (list || []).slice();
  const ids = new Set(next.flatMap(idKeys));
  let added = 0;
  let refused = 0;
  let total = roomTotal;
  for (const raw of Array.isArray(incoming) ? incoming.slice(0, MIX_PER_MESSAGE) : []) {
    const t = cleanMixTrack(raw);
    if (!t) { refused++; continue; }
    const keys = idKeys(t);
    if (keys.some((k) => ids.has(k))) continue; // sent twice (a reconnect), or the same recording: fine
    if (next.length >= MIX_PER_PLAYER || total >= MIX_TOTAL) { refused++; continue; }
    next.push(t);
    for (const k of keys) ids.add(k);
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
      const keys = idKeys(t);
      const k2 = mixKey(t);
      if (k2) keys.push(k2);
      const hit = keys.map((k) => byKey.get(k)).find(Boolean);
      if (hit) {
        if (!hit.from.includes(pid)) hit.from.push(pid);
        for (const k of keys) if (!byKey.has(k)) byKey.set(k, hit); // Spotify + Deezer of one song: both ids now known
        continue;
      }
      const e = { track: t, from: [pid] };
      for (const k of keys) byKey.set(k, e);
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
 * Returns cards { id: 'm1'.., year, title, artist, spotifyId?, deezerId?, isrc?, itunesId?, previewUrl?, from, by, unsure? }.
 * Throws MixError 'mix' (with `have` and `need`) when there are too few songs.
 */
export function buildMix(contrib, { seed = 1, source = 'preview', need = 1, max = MIX_GAME_MAX, names = {}, history = null } = {}) {
  const rand = seededRandom(((seed >>> 0) ^ 0x5bd1e995) >>> 0);
  const order = Object.keys(contrib || {}).sort();
  const all = unique(contrib || {}, order).filter((e) => playableWith(e.track, source));
  // per player: own songs (first contributor), songs not played in this room yet first (history,
  // order.js), then sure years first, each group shuffled
  const h = history ? cleanHistory(history) : null;
  const playedIn = (e) => (h ? h.keys[songKey(e.track)] ?? -1 : -1);
  const lists = order.map((pid) => {
    const mine = all.filter((e) => e.from[0] === pid);
    const games = [...new Set(mine.map(playedIn))].sort((a, b) => a - b);
    return games.flatMap((gi) => {
      const part = mine.filter((e) => playedIn(e) === gi);
      return [...shuffle(part.filter((e) => e.track.sure), rand), ...shuffle(part.filter((e) => !e.track.sure), rand)];
    });
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
    const c = { id: `m${i + 1}`, year: t.year, title: t.title, artist: t.artist, from: e.from.slice(), by: e.from.map((pid) => names[pid] || 'Speler') };
    if (t.spotifyId) c.spotifyId = t.spotifyId;
    if (t.deezerId) c.deezerId = t.deezerId; // fragment via Deezer (player.js), or Spotify by ISRC / title
    if (t.isrc && !t.spotifyId) c.isrc = t.isrc;
    if (t.itunesId) c.itunesId = t.itunesId;
    if (t.previewUrl) c.previewUrl = t.previewUrl;
    if (!t.sure) c.unsure = true;
    return c;
  });
  return cards;
}

/**
 * Track of a contribution, as a phone sends it: after the Apple Music match (favourites), or
 * after the year check (a playlist: deezerId, isrc, `checked`).
 */
export function contributionTrack({ spotifyId, deezerId, isrc, title, artist, year, yearSure, itunesId, previewUrl, checked }) {
  const t = { title, artist, year, sure: !!yearSure };
  if (spotifyId) t.spotifyId = spotifyId;
  if (deezerId) t.deezerId = deezerId;
  if (isrc) t.isrc = isrc;
  if (itunesId) t.itunesId = itunesId;
  if (previewUrl) t.previewUrl = previewUrl;
  if (checked) t.checked = true;
  return t;
}

/* ---------- "Kies een playlist": what a phone takes from its chosen playlists ---------- */

/** Most playlists one phone may choose for one room. */
export const MIX_LISTS_MAX = 5;
/** How many songs a phone shares from its playlists (at most MIX_PER_PLAYER). */
export const LIST_COUNTS = [15, 25, 50];
export const DEFAULT_LIST_COUNT = 25;
/** Candidates a phone keeps in its plan (more than enough: most songs get a checked year). */
export const LIST_PLAN_MAX = 400;

/**
 * The order in which a phone checks the songs of its chosen playlists: every list shuffled on
 * its own (uniform: not the first N), then taken in turn, one song per list per turn, so with
 * several lists every list gets an equal share (a 2000-song list does not drown a short one;
 * a list that runs out leaves the rest to the others). Duplicates across the lists (same
 * Deezer id, ISRC, or artist + title) count once. `first`: per list the Deezer ids already
 * decided earlier (checked songs stay first, so changing the lists keeps most of what was
 * shared). lists: [{ id, tracks: [{ deezerId, isrc, title, artist }] }].
 * Returns [{ ...track, list: id }], at most `max`.
 */
export function spreadPlan(lists, { rand = Math.random, max = LIST_PLAN_MAX, first = {} } = {}) {
  const queues = (lists || []).map((l) => {
    const tracks = (l?.tracks || []).filter((t) => t && posInt(t.deezerId));
    const pre = new Map((first[l?.id] || []).map((d, i) => [d, i]));
    const known = tracks.filter((t) => pre.has(t.deezerId)).sort((a, b) => pre.get(a.deezerId) - pre.get(b.deezerId));
    const rest = shuffle(tracks.filter((t) => !pre.has(t.deezerId)), rand);
    return { id: l?.id, list: [...known, ...rest], at: 0 };
  });
  const seen = new Set();
  const out = [];
  for (let busy = true; busy && out.length < max;) {
    busy = false;
    for (const q of queues) {
      while (q.at < q.list.length && out.length < max) {
        const t = q.list[q.at++];
        busy = true;
        const keys = [`d:${t.deezerId}`, ...(t.isrc ? [`i:${t.isrc}`] : []), mixKey(t)].filter((k) => k && k !== 'd:');
        if (keys.some((k) => seen.has(k))) continue; // a duplicate does not use this list's turn
        for (const k of keys) seen.add(k);
        out.push({ ...t, list: q.id });
        break;
      }
    }
  }
  return out;
}

/**
 * The checked year of a catalogue song (the same rules as the app-wide year check, enrich.js):
 * dz = the year of the Deezer release (often a re-release), mb = { via: 'isrc'|'search', year }
 * from MusicBrainz (the first release of the recording). By ISRC and not later than Deezer's:
 * that year, sure. By search (a search can be a few years off): that year when earlier, not
 * sure. MusicBrainz later than Deezer: Deezer's year stays, checked but not sure. MusicBrainz
 * found nothing: null (not checked, so the song is not shared).
 */
export function checkedYear(dz, mb) {
  const ok = (y) => Number.isInteger(y) && y >= 1900 && y <= 2100;
  const d = ok(dz) ? dz : null;
  const y = ok(mb?.year) ? mb.year : null;
  if (y == null) return null;
  if (mb.via === 'isrc') return d == null || y <= d ? { year: y, sure: true } : { year: d, sure: false };
  if (mb.via === 'search') return d == null || y < d ? { year: y, sure: false } : { year: d, sure: false };
  return null;
}
