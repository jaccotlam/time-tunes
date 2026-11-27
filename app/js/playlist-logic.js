// Pure logic for own playlists ("Eigen playlist"). No DOM, no network: shared
// between the browser and the Node test runner (`npm test`).
//
// - parse pasted lines ("Artiest - Titel, 1987")
// - rank iTunes search results (karaoke/tribute/cover versions down) and match a line
// - choose the year of a song (earliest release of the same recording)
// - self-contained card codes for printed QR codes (#/c/~<code>)
// - compact share links (#/pl/<payload>), split into parts for QR codes
// - storage format (versioned) and the playlist -> deck conversion
// - which cards can be played with which music source (playable)
//
// A stored track comes from up to three catalogues: Apple Music (`itunesId`, the 30-second
// fragments and the printed QR codes), Spotify (`spotifyId`, whole songs) and Deezer
// (`deezerId`, fragments too). `isrc` identifies the recording itself and finds the song on
// Spotify when there is no `spotifyId`. Preview addresses and store links are NOT stored: a
// preview is looked up fresh at play time (Apple's and Deezer's links expire) and a store link
// follows from the id. That keeps a 2000-song list near 400 kB in localStorage.
import { scoreTrack, titleScore, artistScore, versionPenalty, fold } from './spotify-match.js';

export const STORE_VERSION = 1;
export const BUILTIN_ID = 'builtin';
export const BUILTIN_NAME = 'TimeTunesr-deck';
/** Most songs in one playlist (Spotify import, paste, backups, the account, a room's deck). */
export const MAX_TRACKS = 2000;
export const NAME_MAX = 40;
export const YEAR_MIN = 1900;
export const YEAR_MAX = 2099;

/**
 * Minimum number of playable songs per game (with the minimum of 2 players).
 * Tijdlijn: one start card per player + one to play (logic.cardsNeeded).
 * Bingo: 3 per player (screens/bingo.js). Scanning cards works with any number.
 * FUN_MIN: below this the games end quickly because the music runs out.
 */
export const MIN_TRACKS = { timeline: 3, bingo: 6 };
export const FUN_MIN = 30;

/** What a playlist with `count` playable songs is good for. */
export function readiness(count) {
  const n = Number(count) || 0;
  return {
    timeline: n >= MIN_TRACKS.timeline,
    bingo: n >= MIN_TRACKS.bingo,
    fun: n >= FUN_MIN,
    missing: Math.max(0, MIN_TRACKS.bingo - n),
  };
}

const thisYear = () => new Date().getFullYear();
export const validYear = (y) => Number.isInteger(y) && y >= YEAR_MIN && y <= Math.max(YEAR_MAX, thisYear() + 1);

/** Music sources a phone can play with: 30-second fragments, or whole songs through Spotify. */
export const SOURCES = ['preview', 'spotify'];

const posInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d{1,16}$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
const hasText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * THE answer to "can this card / track be played with this music source?" (counters,
 * readiness checks before a game, the deck builder, the room's deck, the group mix).
 * Every card needs a year (it has to be placed). Then:
 * - 'preview' (fragments): an Apple Music id or a Deezer id (the player looks the 30-second
 *   preview up fresh), or a stored previewUrl (built-in deck, group mix);
 * - 'spotify': any song: a Spotify id, an ISRC or a title plus artist to search for (and when
 *   Spotify finds nothing the player falls back to the fragment).
 */
export function playable(t, source = 'preview') {
  if (!t || typeof t !== 'object' || !validYear(Number(t.year))) return false;
  const fragment = posInt(t.itunesId) || posInt(t.deezerId) || (typeof t.previewUrl === 'string' && /^https:\/\//.test(t.previewUrl));
  if (source !== 'spotify') return fragment;
  return fragment || isSpId(t.spotifyId) || isIsrc(t.isrc) || (hasText(t.title) && hasText(t.artist));
}

/** How many tracks of a playlist (or any list of cards) can be played with this source. */
export const playableTotal = (tracks, source = 'preview') => (tracks || []).reduce((n, t) => n + (playable(t, source) ? 1 : 0), 0);

/* ---------- pasted lines ---------- */

const SEPARATORS = [' - ', ' – ', ' — ', '\t', ' | ', ' -- '];

/**
 * Parse one pasted line: "Artiest - Titel", optionally followed by ", 1987",
 * "(1987)" or "[1987]". Leading list markers ("1.", "-", "•") are ignored.
 * Returns null for empty lines, else { raw, artist, title, year, query }.
 * Without a separator artist/title are null and `query` is the whole line.
 */
export function parseLine(line) {
  let s = String(line ?? '').replace(/\s+$/, '').replace(/^\s+/, '');
  if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
  const raw = s;
  s = s.replace(/^(?:\d{1,4}\s*[.)]\s+|[-*•·–]\s+)/u, '');
  let year = null;
  const ym = s.match(/(?:\s*[([]\s*(\d{4})\s*[)\]]|\s*[,;]\s*(\d{4}))\s*$/);
  if (ym) {
    const y = Number(ym[1] || ym[2]);
    if (validYear(y)) { year = y; s = s.slice(0, ym.index); }
  }
  let artist = null;
  let title = null;
  for (const sep of SEPARATORS) {
    const i = s.indexOf(sep);
    if (i > 0) { artist = s.slice(0, i).trim(); title = s.slice(i + sep.length).trim(); break; }
  }
  if (artist == null) {
    // "ABBA-Waterloo": one bare dash
    const parts = s.split('-');
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) { artist = parts[0].trim(); title = parts[1].trim(); }
  }
  if (artist != null && (!artist || !title)) { artist = null; title = null; }
  const query = (artist ? `${artist} ${title}` : s).replace(/[()[\]"]/g, ' ').replace(/\s+/g, ' ').trim();
  return { raw, artist, title, year, query };
}

/** All non-empty lines of a pasted text, without exact duplicates. */
export function parseLines(text, max = MAX_TRACKS) {
  const seen = new Set();
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const p = parseLine(line);
    if (!p) continue;
    const key = fold(p.query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- iTunes results ---------- */

/** iTunes result -> the Spotify-like shape spotify-match.js scores. */
export function itunesToTrack(r) {
  return { name: r?.trackName || '', artists: [{ name: r?.artistName || '' }], album: { name: r?.collectionName || '' } };
}

export function itunesYear(r) {
  const y = Number.parseInt(String(r?.releaseDate || '').slice(0, 4), 10);
  return validYear(y) ? y : null;
}

/** Artists and albums that are almost never the original recording. */
const JUNK_ARTIST = /\b(karaoke|tribute|sound ?alike|soundalike|in the style of|made famous|cover band|covers|party band|hits band|studio (all ?stars|band|musicians|group)|countdown singers|musical mania|the hit crew|starlite|singers unlimited|various artists|lullaby|piano tribute|ameritz|zoom karaoke|sing ?king|8-bit|vitamin string|twinkle)\b/;
const JUNK_ALBUM = /\b(karaoke|tribute|in the style of|made famous|originally performed|sing like|backing track|instrumental versions?|lullaby|8-bit|piano versions?)\b/;

/** 0 (fine) .. 1 (junk): karaoke, tribute, covers, live and remix versions the search did not ask for. */
export function junkPenalty(r, wanted = '') {
  if (!r || (r.kind && r.kind !== 'song')) return 1;
  const artist = fold(r.artistName);
  const album = fold(r.collectionName);
  let p = versionPenalty(wanted, itunesToTrack(r)).penalty;
  if (JUNK_ARTIST.test(artist)) p += 0.8;
  if (JUNK_ALBUM.test(album) && !JUNK_ALBUM.test(fold(wanted))) p += 0.6;
  return Math.min(1, p);
}

/**
 * Search results in a useful order: real recordings first (iTunes' own order),
 * karaoke/tribute/cover/live versions after. Adds `junk` (0..1) to every result.
 */
export function rankSearch(results, wanted = '') {
  return (results || [])
    .filter((r) => r && r.trackId && (!r.kind || r.kind === 'song'))
    .map((r, index) => ({ r, index, junk: junkPenalty(r, wanted) }))
    .sort((a, b) => (a.junk >= 0.4) - (b.junk >= 0.4) || a.junk - b.junk || a.index - b.index)
    .map(({ r, junk }) => ({ ...r, junk }));
}

const COMPILATION = /\b(greatest|best of|the best|very best|hits|collection|anthology|essential|essentials|gold|platinum|ultimate|singles|compilation|remaster(ed)?|deluxe|anniversary|edition|top ?\d+|jaren|decade|now that|the \d0s|\d0s|\d0's|box set|years|definitive|classics|favourites|favorites|legends|love songs|party|sampler)\b/;
export const isCompilationAlbum = (name) => COMPILATION.test(fold(name));

/** Same recording of the same song by the same artist (not a live/remix/karaoke version). */
export function sameRecording(a, b) {
  const t = titleScore(a.trackName, b.trackName);
  const ar = artistScore(a.artistName, [{ name: b.artistName }]);
  return t >= 0.9 && ar >= 0.85 && junkPenalty(b, a.trackName) < 0.2;
}

/**
 * The year of a song. iTunes and Spotify often give the year of a re-release or
 * compilation, so take the earliest release year among the results that are
 * clearly the same recording by the same artist.
 * `chosen`: the iTunes result the player picked. `results`: other search results.
 * `extraYears`: years from elsewhere for the same recording (e.g. Spotify's album date).
 * Returns { year, sure } where sure=false means "controleer het jaar".
 */
export function pickYear(chosen, results = [], extraYears = []) {
  const same = [chosen, ...(results || []).filter((r) => r && r.trackId !== chosen.trackId && sameRecording(chosen, r))];
  const candidates = same.map((r) => ({ year: itunesYear(r), album: r.collectionName || '' })).filter((c) => c.year);
  for (const y of extraYears || []) if (validYear(y)) candidates.push({ year: y, album: '', extra: true });
  if (!candidates.length) return { year: null, sure: false };
  const year = Math.min(...candidates.map((c) => c.year));
  const atYear = candidates.filter((c) => c.year === year);
  const original = atYear.some((c) => !c.extra && !isCompilationAlbum(c.album));
  const agree = new Set(atYear.map((c) => (c.extra ? '~extra' : fold(c.album)))).size >= 2;
  const sure = (original || agree) && validYear(year);
  return { year, sure };
}

/**
 * Match a parsed line against iTunes search results.
 * Returns { status: 'found'|'doubt'|'none', best, score, alternatives }.
 * `found`: confident match; `doubt`: something similar, let the player check.
 */
export function matchLine(parsed, results) {
  const ranked = rankSearch(results, parsed?.title || parsed?.query || '');
  if (!ranked.length) return { status: 'none', best: null, score: 0, alternatives: [] };
  let scored;
  if (parsed.artist) {
    scored = ranked.map((r, i) => {
      const t = itunesToTrack(r);
      const a = scoreTrack({ title: parsed.title, artist: parsed.artist }, t);
      const b = scoreTrack({ title: parsed.artist, artist: parsed.title }, t); // "Titel - Artiest"
      const s = a.score >= b.score ? a : b;
      return { r, i, score: Math.max(0, s.score - r.junk * 0.5), title: s.title, artist: s.artist };
    });
  } else {
    // no separator: trust iTunes' order, but never sure
    scored = ranked.map((r, i) => ({ r, i, score: Math.max(0, 0.7 - i * 0.02 - r.junk * 0.5), title: 0.8, artist: 0.8 }));
  }
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  const top = scored[0];
  let status = 'none';
  if (parsed.artist && top.score >= 0.85 && top.title >= 0.8 && top.artist >= 0.6) status = 'found';
  else if (top.score >= 0.45) status = 'doubt';
  return {
    status,
    best: status === 'none' ? null : top.r,
    score: Math.round(top.score * 1000) / 1000,
    alternatives: scored.filter((x) => x.score >= 0.3 || (x.title >= 0.5 && x.artist >= 0.5)).slice(0, 6).map((x) => x.r),
  };
}

/** Track for a playlist from an iTunes result (+ the other results to choose the year). */
export function trackFromItunes(r, results = [], { year = null, extraYears = [] } = {}) {
  const picked = pickYear(r, results, extraYears);
  const own = validYear(year) ? year : null;
  return {
    itunesId: Number(r.trackId),
    title: String(r.trackName || ''),
    artist: String(r.artistName || ''),
    album: String(r.collectionName || ''),
    year: own ?? picked.year,
    yearSure: own != null ? true : picked.sure,
    previewUrl: r.previewUrl || null,
    trackViewUrl: r.trackViewUrl || null,
  };
}

/* ---------- card codes (#/c/~<code>) ---------- */

const CODE_SPAN = 400; // years 1800..2199
const CODE_BASE = 1800;
const shiftOf = (id) => ((id % CODE_SPAN) * 7919 + 13) % CODE_SPAN;
const checkOf = (v) => ((v % 1009) % 36).toString(36);
const MAX_ITUNES_ID = Math.floor(Number.MAX_SAFE_INTEGER / CODE_SPAN);

/**
 * Self-contained code for a printed card of an own playlist: the iTunes id plus
 * the year, lightly scrambled so the year cannot be read in the address bar.
 * Base36 plus one check character, prefixed with "~": e.g. "~1x2b3c4d5e".
 */
export function encodeCardCode(itunesId, year) {
  const id = Number(itunesId);
  const y = Number(year);
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ITUNES_ID) throw new Error('ongeldig iTunes-id');
  if (!Number.isInteger(y) || y < CODE_BASE || y >= CODE_BASE + CODE_SPAN) throw new Error('ongeldig jaar');
  const v = id * CODE_SPAN + ((y - CODE_BASE + shiftOf(id)) % CODE_SPAN);
  return `~${v.toString(36)}${checkOf(v)}`;
}

/** Inverse of encodeCardCode: { itunesId, year } or null for anything else. */
export function decodeCardCode(code) {
  const m = String(code ?? '').trim().toLowerCase().match(/^~([0-9a-z]{2,12})([0-9a-z])$/);
  if (!m) return null;
  const v = Number.parseInt(m[1], 36);
  if (!Number.isSafeInteger(v) || checkOf(v) !== m[2]) return null;
  const itunesId = Math.floor(v / CODE_SPAN);
  if (itunesId <= 0) return null;
  const year = ((v % CODE_SPAN) - shiftOf(itunesId) + CODE_SPAN) % CODE_SPAN + CODE_BASE;
  return { itunesId, year };
}

export const isCardCode = (id) => typeof id === 'string' && id.startsWith('~');

/* ---------- share links (#/pl/<payload>) ---------- */

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const itemCode = (t) => `${Number(t.itunesId).toString(36)}${(t.year - YEAR_MIN).toString(36).padStart(2, '0')}`;

/** Random id that ties the parts of one shared playlist together. */
export function newShareId(rand = Math.random) {
  return Array.from({ length: 6 }, () => Math.floor(rand() * 36).toString(36)).join('');
}

/**
 * Compact share payloads for a playlist: only iTunes id + year per song, plus the
 * name. Format: "1~<shareId>~<part>~<total>~<name base64url>~<id36 year36>.<...>".
 * With `maxLen` the songs are split over several payloads of at most maxLen chars
 * (for QR codes); without it there is one payload. Songs without an iTunes id or
 * year cannot be shared this way and are skipped (`skipped` in the result).
 * `deezer: true` also takes songs that only have a Deezer id: they go in an extra last field
 * "~d<id36 year36>.<...>" (an app of before Deezer refuses such a link as invalid instead of
 * reading wrong songs). The receiving side must then look those up at Deezer (deezerItems).
 */
export function encodeShare({ name, tracks }, { maxLen = Infinity, shareId = newShareId(), deezer = false } = {}) {
  const ok = (tracks || []).filter((t) => Number.isSafeInteger(Number(t.itunesId)) && Number(t.itunesId) > 0 && validYear(t.year));
  const dz = deezer ? (tracks || []).filter((t) => !(Number(t.itunesId) > 0) && posInt(t.deezerId) && validYear(t.year)) : [];
  const items = [...ok.map(itemCode), ...dz.map((t) => `d${Number(t.deezerId).toString(36)}${(t.year - YEAR_MIN).toString(36).padStart(2, '0')}`)];
  const nm = b64urlEncode(String(name || 'Playlist').slice(0, NAME_MAX));
  const head = (p, n) => `1~${shareId}~${p}~${n}~${nm}~`;
  const room = maxLen - head(99, 99).length - (dz.length ? 3 : 0);
  if (room < 14) throw new Error('maxLen te klein');
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const it of items) {
    const add = it.length + (cur.length ? 1 : 0);
    if (cur.length && len + add > room) { chunks.push(cur); cur = []; len = 0; }
    len += it.length + (cur.length ? 1 : 0);
    cur.push(it);
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  const body = (c) => {
    const a = c.filter((x) => x[0] !== 'd');
    const d = c.filter((x) => x[0] === 'd').map((x) => x.slice(1));
    return a.join('.') + (d.length ? `~d${d.join('.')}` : '');
  };
  return {
    payloads: chunks.map((c, i) => head(i + 1, chunks.length) + body(c)),
    shared: ok.length + dz.length,
    skipped: (tracks || []).length - ok.length - dz.length,
  };
}

function shareItems(field, key, seen) {
  const out = [];
  for (const it of field ? field.split('.') : []) {
    if (it.length < 3) return null;
    const id = Number.parseInt(it.slice(0, -2), 36);
    const year = Number.parseInt(it.slice(-2), 36) + YEAR_MIN;
    if (!Number.isSafeInteger(id) || id <= 0 || !validYear(year)) return null;
    if (seen.has(`${key}${id}`)) continue;
    seen.add(`${key}${id}`);
    out.push({ [key]: id, year });
  }
  return out;
}

/**
 * Parse a share payload (or a whole link containing #/pl/...). Null when invalid.
 * { shareId, part, total, name, items: [{ itunesId, year }], deezerItems: [{ deezerId, year }] }
 */
export function decodeShare(input) {
  let s = String(input ?? '').trim();
  const at = s.indexOf('#/pl/');
  if (at >= 0) s = s.slice(at + 5);
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  const m = s.match(/^1~([0-9a-z]{4,12})~(\d{1,3})~(\d{1,3})~([A-Za-z0-9_-]*)~([0-9a-z.]*)(?:~d([0-9a-z.]*))?$/);
  if (!m) return null;
  const part = Number(m[2]);
  const total = Number(m[3]);
  if (part < 1 || total < 1 || part > total) return null;
  let name;
  try { name = b64urlDecode(m[4]).slice(0, NAME_MAX); } catch { return null; }
  const seen = new Set();
  const items = shareItems(m[5], 'itunesId', seen);
  const deezerItems = shareItems(m[6] || '', 'deezerId', seen);
  if (!items || !deezerItems) return null;
  return { shareId: m[1], part, total, name: name || 'Gedeelde playlist', items, deezerItems };
}

/* ---------- Spotify playlist links ---------- */

/** Playlist id from an open.spotify.com link, a spotify:playlist: URI or a bare id. */
export function parseSpotifyPlaylistId(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:user\/[^/]+\/)?playlist\/|spotify:(?:user:[^:]+:)?playlist:)([0-9A-Za-z]{22})/)
    || s.match(/^([0-9A-Za-z]{22})$/);
  return m ? m[1] : null;
}

/** Year from Spotify's album.release_date ("1981", "1981-12", "1981-12-03"). */
export function spotifyYear(date) {
  const y = Number.parseInt(String(date || '').slice(0, 4), 10);
  return validYear(y) ? y : null;
}

/* ---------- storage ---------- */

const str = (v, max = 200) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
function isSpId(id) { return typeof id === 'string' && /^[0-9A-Za-z]{22}$/.test(id); }

/** An ISRC: 2 letters (country), 3 letters/digits (registrant), 7 digits (year + number). */
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
function isIsrc(v) { return typeof v === 'string' && ISRC_RE.test(v); }
/** An ISRC from any catalogue ("usrc17607839", "US-RC1-76-07839") in its plain form, or null. */
export function cleanIsrc(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase().replace(/[\s-]/g, '');
  return ISRC_RE.test(s) ? s : null;
}

/** Store links follow from the ids (so they are never stored). */
export const appleMusicUrl = (itunesId) => (posInt(itunesId) ? `https://music.apple.com/nl/song/${Number(itunesId)}` : null);
export const deezerUrl = (deezerId) => (posInt(deezerId) ? `https://www.deezer.com/track/${Number(deezerId)}` : null);

const SOURCE_KINDS = ['spotify', 'deezer'];
export const SOURCE_NAME_MAX = 100;
/**
 * Where a playlist came from: { kind: 'spotify' | 'deezer', id, name } (id always a string:
 * a Spotify playlist id of 22 characters, a Deezer playlist number). Null when invalid.
 */
export function cleanSource(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src) || !SOURCE_KINDS.includes(src.kind)) return null;
  const id = typeof src.id === 'number' ? String(src.id) : src.id;
  if (typeof id !== 'string') return null;
  if (src.kind === 'spotify' && !isSpId(id)) return null;
  if (src.kind === 'deezer' && !(/^\d{1,16}$/.test(id) && posInt(id))) return null;
  const name = String(src.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, SOURCE_NAME_MAX);
  return { kind: src.kind, id: src.kind === 'deezer' ? String(Number(id)) : id, name };
}

export function cleanName(name, fallback = 'Mijn playlist') {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || fallback;
}

/**
 * One stored track, sanitised. Returns null when it cannot be played anywhere (no Apple Music,
 * Spotify or Deezer id). Format: { n, itunesId, title, artist, album, year, yearSure,
 * spotifyId?, deezerId?, isrc?, yearFixed?, yearChecked?, match? }. `yearFixed`: the player typed
 * this year (background work never changes it). `yearChecked`: the background year check
 * (enrich.js) has finished for this track (only ever true). Old data with previewUrl / trackViewUrl loads; those two
 * are dropped (looked up fresh / derived, see the top of this file).
 */
export function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const itunesId = Number(t.itunesId ?? t.trackId);
  const out = {
    n: Number.isInteger(t.n) && t.n > 0 ? t.n : 0,
    itunesId: Number.isSafeInteger(itunesId) && itunesId > 0 ? itunesId : null,
    title: str(t.title ?? t.trackName),
    artist: str(t.artist ?? t.artistName),
    album: str(t.album ?? t.collectionName),
    year: validYear(Number(t.year)) ? Number(t.year) : null,
    yearSure: t.yearSure !== false,
  };
  if (isSpId(t.spotifyId)) out.spotifyId = t.spotifyId;
  if (posInt(t.deezerId)) out.deezerId = Number(t.deezerId);
  const isrc = cleanIsrc(t.isrc);
  if (isrc) out.isrc = isrc;
  if (t.yearFixed === true && out.year != null) { out.yearFixed = true; out.yearSure = true; }
  if (t.yearChecked === true) out.yearChecked = true;
  if (['pending', 'none'].includes(t.match)) out.match = t.match;
  if (!out.itunesId && !out.spotifyId && !out.deezerId) return null;
  return out;
}

export function cleanPlaylist(p, i = 0) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(p.id) && p.id !== BUILTIN_ID ? p.id : `pl${i + 1}x${Date.now().toString(36)}`;
  const tracks = [];
  const used = new Set();
  let next = Number.isInteger(p.nextN) && p.nextN > 0 ? p.nextN : 1;
  for (const raw of Array.isArray(p.tracks) ? p.tracks : []) {
    const t = cleanTrack(raw);
    if (!t) continue;
    if (!t.n || used.has(t.n)) t.n = 0;
    else used.add(t.n);
    tracks.push(t);
    if (tracks.length >= MAX_TRACKS) break;
  }
  next = Math.max(next, ...[...used].map((n) => n + 1), 1);
  for (const t of tracks) if (!t.n) { t.n = next++; used.add(t.n); }
  const out = {
    id,
    name: cleanName(p.name),
    created: Number(p.created) || Date.now(),
    updated: Number(p.updated) || Number(p.created) || Date.now(),
    nextN: next,
    tracks,
  };
  if (typeof p.shareId === 'string' && /^[0-9a-z]{4,12}$/.test(p.shareId)) out.shareId = p.shareId;
  if (Array.isArray(p.partsSeen)) out.partsSeen = p.partsSeen.filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
  if (Number.isInteger(p.partsTotal) && p.partsTotal > 0) out.partsTotal = p.partsTotal;
  const source = cleanSource(p.source);
  if (source) out.source = source;
  return out;
}

/**
 * Read whatever is in storage and return the current format { v, lists }.
 * Accepts: the current format, a bare array of playlists (older/hand-made data)
 * and an exported backup ({ type: 'playlist' } or { type: 'playlists' }).
 */
export function migrateStore(raw) {
  let lists = [];
  if (Array.isArray(raw)) lists = raw;
  else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.lists)) lists = raw.lists;
    else if (Array.isArray(raw.playlists)) lists = raw.playlists;
    else if (Array.isArray(raw.tracks)) lists = [raw];
  }
  const out = [];
  const ids = new Set();
  lists.forEach((p, i) => {
    const c = cleanPlaylist(p, i);
    if (!c) return;
    while (ids.has(c.id)) c.id += 'x';
    ids.add(c.id);
    out.push(c);
  });
  return { v: STORE_VERSION, lists: out };
}

export const padN = (n) => String(n).padStart(3, '0');

/**
 * A playlist as a deck, in the same format as data/deck.json:
 * { id, name, kind, cards, byId } with cards { id, title, artist, year, itunesId,
 * previewUrl (null: looked up at play time), trackViewUrl (derived), spotifyId?, deezerId?,
 * isrc?, code? }. Songs without a year are left out.
 */
export function playlistDeck(p) {
  const cards = (p?.tracks || [])
    .filter((t) => validYear(t.year))
    .map((t) => {
      const c = {
        id: padN(t.n), title: t.title, artist: t.artist, year: t.year,
        itunesId: t.itunesId || null, previewUrl: null, trackViewUrl: appleMusicUrl(t.itunesId) || deezerUrl(t.deezerId),
      };
      if (t.spotifyId) c.spotifyId = t.spotifyId;
      if (t.deezerId) c.deezerId = t.deezerId;
      if (t.isrc) c.isrc = t.isrc;
      if (t.itunesId) c.code = encodeCardCode(t.itunesId, t.year);
      return c;
    });
  cards.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return {
    version: 1, country: 'NL', id: p.id, name: p.name, kind: 'playlist',
    cards, byId: new Map(cards.map((c) => [c.id, c])),
  };
}

/** Backup file content for one playlist. */
export function exportPlaylist(p) {
  return {
    app: 'TimeTunesr', type: 'playlist', v: STORE_VERSION, exported: new Date().toISOString(),
    name: p.name,
    ...(p.source ? { source: p.source } : {}),
    tracks: p.tracks.map(({ n, itunesId, spotifyId, deezerId, isrc, yearFixed, yearChecked, title, artist, album, year, yearSure }) => ({
      n, itunesId, ...(spotifyId ? { spotifyId } : {}), ...(deezerId ? { deezerId } : {}), ...(isrc ? { isrc } : {}),
      title, artist, album, year, yearSure, ...(yearFixed ? { yearFixed } : {}), ...(yearChecked ? { yearChecked } : {}),
    })),
  };
}

/** Parse a backup file (one playlist or several). Returns an array of clean playlists. */
export function importBackup(json) {
  if (!json || typeof json !== 'object') return [];
  const lists = json.type === 'playlist' || (!json.lists && Array.isArray(json.tracks)) ? [json] : (json.lists || json.playlists || []);
  return lists.map((p, i) => cleanPlaylist({ ...p, id: undefined }, i)).filter((p) => p && p.tracks.length);
}
