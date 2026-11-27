// Pure matching of a deck card (title + artist from iTunes) to Spotify search results.
// No DOM, no network: shared by the app (js/spotify.js) and tools/link-spotify.mjs.
//
// Rules:
// - titles/artists are compared after normalising: accents, case, punctuation,
//   "(...)"/"[...]" parts, " - Remastered 2011"-style suffixes and "feat. X" are ignored;
// - live, karaoke, cover, remix, instrumental, ... versions get a penalty unless
//   the card title itself asks for them (e.g. "Live and Let Die");
// - on equal scores the first result (Spotify's own order) wins.

/** Version markers that make a recording a different "version" of the song. */
const VERSION_MARKERS = [
  { re: /\bkaraoke\b/g, penalty: 0.6 },
  { re: /\b(in the style of|originally performed|made famous|as made famous)\b/g, penalty: 0.6 },
  { re: /\btribute\b/g, penalty: 0.5 },
  { re: /\bcover\b/g, penalty: 0.5 },
  { re: /\binstrumental\b/g, penalty: 0.5 },
  { re: /\blive\b/g, penalty: 0.45 },
  { re: /\b(sped up|speed up|slowed|nightcore|8 bit|lullaby)\b/g, penalty: 0.5 },
  { re: /\bremix\b/g, penalty: 0.4 },
  { re: /\b(club|extended|dub|12) mix\b/g, penalty: 0.3 },
  { re: /\bacoustic\b/g, penalty: 0.3 },
  { re: /\bdemo\b/g, penalty: 0.3 },
  { re: /\bunplugged\b/g, penalty: 0.3 },
  { re: /\b(re recorded|rerecorded|re record)\b/g, penalty: 0.15 },
];

/** Accents off, lower case, "&" -> "and", apostrophes dropped. Keeps brackets and dashes. */
export function fold(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[‐-―]/g, '-');
}

const words = (s) => s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Remove "feat. X" / "ft. X" / "featuring X" (also inside brackets). */
function dropFeat(s) {
  return s
    .replace(/[([][^)\]]*\b(feat|ft|featuring|with)\b[^)\]]*[)\]]/g, ' ')
    .replace(/\s\b(feat|ft|featuring)\b\.?\s.*$/g, ' ');
}

/** Normalised title without bracket parts and " - suffix" (the core of the song title). */
export function normalizeTitle(title) {
  let s = fold(title);
  s = dropFeat(s);
  s = s.replace(/\s+-\s+.*$/, ' '); // "Song - 2011 Remaster", "Song - Live at Wembley"
  s = s.replace(/[([][^)\]]*[)\]]/g, ' ');
  const out = words(s);
  return out || words(fold(title)); // a title that is only brackets: keep its words
}

/** Normalised title including the words inside brackets (minus feat./version noise). */
function fullTitleWords(title) {
  let s = dropFeat(fold(title));
  s = s.replace(/\s+-\s+.*$/, ' ');
  return words(s);
}

/** Normalised artist name ("The Beatles" == "Beatles"). */
export function normalizeArtist(name) {
  return words(fold(name)).replace(/^the /, '');
}

/** Split "Calvin Harris & Dua Lipa feat. X" into ["calvin harris", "dua lipa", "x"]. */
export function splitArtists(artist) {
  return fold(artist)
    .split(/\s*(?:,|;|\/|\+|\s(?:and|x|vs\.?|feat\.?|ft\.?|featuring|with|en|met)\s)\s*/)
    .map(normalizeArtist)
    .filter(Boolean);
}

const tokens = (s) => s.split(' ').filter(Boolean);

/** Sørensen–Dice coefficient on word tokens (0..1). */
export function dice(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let hit = 0;
  for (const t of A) {
    const i = pool.indexOf(t);
    if (i >= 0) { hit++; pool.splice(i, 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

function similar(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ca = a.replace(/ /g, '');
  const cb = b.replace(/ /g, '');
  if (ca === cb) return 1; // "Go-Go" vs "GoGo", "Run D.M.C." vs "Run DMC"
  return dice(a, b);
}

export function titleScore(cardTitle, trackTitle) {
  const core = similar(normalizeTitle(cardTitle), normalizeTitle(trackTitle));
  const full = similar(fullTitleWords(cardTitle), fullTitleWords(trackTitle));
  return Math.max(core, full);
}

export function artistScore(cardArtist, trackArtists) {
  const names = (trackArtists || []).map((a) => normalizeArtist(typeof a === 'string' ? a : a?.name)).filter(Boolean);
  if (!names.length) return 0;
  const whole = normalizeArtist(cardArtist);
  if (names.includes(whole) || similar(whole, names.join(' ')) === 1) return 1;
  const parts = splitArtists(cardArtist);
  if (!parts.length) return 0;
  const best = (p) => Math.max(...names.map((n) => similar(p, n)));
  const primary = best(parts[0]);
  const rest = parts.slice(1).map(best);
  const restAvg = rest.length ? rest.reduce((x, y) => x + y, 0) / rest.length : 1;
  // the main artist counts most; missing guest artists cost a little.
  // Only a later artist matches ("Paul McCartney & Wings" -> "Wings"): acceptable, not sure.
  const other = rest.length ? Math.max(...rest) * 0.7 : 0;
  return Math.max(0, Math.min(1, Math.max(primary * (0.85 + 0.15 * restAvg), other)));
}

const count = (re, s) => (s.match(re) || []).length;

/** Penalty for live/karaoke/cover/... versions the card did not ask for. */
export function versionPenalty(cardTitle, track) {
  const want = words(fold(cardTitle));
  const got = words(fold(track?.name));
  const album = words(fold(track?.album?.name));
  const artists = words(fold((track?.artists || []).map((a) => a?.name || a).join(' ')));
  let penalty = 0;
  const flags = [];
  for (const { re, penalty: p } of VERSION_MARKERS) {
    const inWant = count(re, want);
    const extra = count(re, got) > inWant
      || (count(re, album) > inWant && /live|karaoke|tribute|cover|instrumental|style|performed|famous/.test(re.source))
      || (count(re, artists) > 0 && /karaoke|tribute|style|performed|famous|cover/.test(re.source));
    if (extra) {
      penalty += p;
      flags.push(re.source.replace(/\\b|\(|\)|\/g/g, '').split('|')[0]);
    }
  }
  return { penalty: Math.min(1, penalty), flags };
}

/**
 * Score one Spotify track object against a card.
 * Returns { score, title, artist, penalty, flags } with all numbers in 0..1.
 */
export function scoreTrack(card, track) {
  const title = titleScore(card.title, track?.name);
  const artist = artistScore(card.artist, track?.artists);
  const { penalty, flags } = versionPenalty(card.title, track);
  const score = Math.max(0, 0.55 * title + 0.45 * artist - penalty);
  return { score: Math.round(score * 1000) / 1000, title, artist, penalty, flags };
}

export const MIN_TITLE = 0.75;
export const MIN_ARTIST = 0.6;
export const MIN_SCORE = 0.7;
/** Below this the tool reports the match as "doubtful" for a manual check. */
export const SURE_SCORE = 0.9;

/** Every candidate with its score, best first (stable: Spotify's order breaks ties). */
export function rankTracks(card, tracks) {
  return (tracks || [])
    .filter((t) => t && t.id && t.is_playable !== false)
    .map((track, index) => ({ track, index, ...scoreTrack(card, track) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Pick the best Spotify track for a card, or null when nothing is trustworthy.
 * Result: { id, uri, durationMs, score, sure, ...details }.
 */
export function bestMatch(card, tracks) {
  const ranked = rankTracks(card, tracks);
  const top = ranked[0];
  if (!top || top.title < MIN_TITLE || top.artist < MIN_ARTIST || top.score < MIN_SCORE) return null;
  return {
    id: top.track.id,
    uri: top.track.uri || `spotify:track:${top.track.id}`,
    durationMs: Number(top.track.duration_ms) || null,
    score: top.score,
    sure: top.score >= SURE_SCORE,
    title: top.title,
    artist: top.artist,
    flags: top.flags,
  };
}

/** Below these an ISRC hit is "clearly another song" (wrong data at one of the catalogues). */
export const ISRC_MIN_TITLE = 0.4;
export const ISRC_MIN_ARTIST = 0.3;

/**
 * The track an exact ISRC search (q=isrc:XXX) found for a card, or null. An ISRC names one
 * recording, so the hit is taken unless its title or artist is clearly another song; a card
 * without title / artist takes the first playable hit. Same result shape as bestMatch.
 */
export function isrcMatch(card, tracks) {
  const list = (tracks || []).filter((t) => t && isSpotifyId(t.id) && t.is_playable !== false);
  if (!list.length) return null;
  const known = !!(String(card?.title || '').trim() && String(card?.artist || '').trim());
  const ranked = known ? rankTracks(card, list).filter((r) => r.title >= ISRC_MIN_TITLE && r.artist >= ISRC_MIN_ARTIST) : list.map((track) => ({ track, score: 1, title: 1, artist: 1 }));
  const top = ranked[0];
  if (!top) return null;
  return {
    id: top.track.id,
    uri: top.track.uri || `spotify:track:${top.track.id}`,
    durationMs: Number(top.track.duration_ms) || null,
    score: top.score,
    sure: true,
    title: top.title,
    artist: top.artist,
    via: 'isrc',
  };
}

const q = (s) => String(s).replace(/["]/g, ' ').replace(/\s+/g, ' ').trim();

/** Search queries for a card, strict first: field filters, then plain words. */
export function searchQueries(card) {
  const title = q(String(card.title).replace(/[([][^)\]]*[)\]]/g, ' ')) || q(card.title);
  const primary = q(String(card.artist).split(/\s*(?:,|;|\/|\s(?:&|and|x|vs\.?|feat\.?|ft\.?|featuring|with)\s)\s*/i)[0]) || q(card.artist);
  const plainTitle = q(card.title.replace(/[()[\]]/g, ' '));
  return [
    `track:"${title}" artist:"${primary}"`,
    `${plainTitle} ${q(card.artist)}`,
  ];
}

/** Valid Spotify track id (base62, 22 chars). */
export const isSpotifyId = (id) => typeof id === 'string' && /^[0-9A-Za-z]{22}$/.test(id);
