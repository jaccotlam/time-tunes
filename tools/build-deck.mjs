#!/usr/bin/env node
// Builds app/data/deck.json from tools/songs.json using the iTunes Search API.
//
//   node tools/build-deck.mjs            # build (uses tools/.cache.json, only fetches what is missing)
//   node tools/build-deck.mjs --refresh  # ignore the cache and fetch everything again
//
// Card ids are the 1-based position in songs.json ("001", "002", ...). Cards are printed with
// that number, so new songs must be APPENDED to songs.json; never reorder or delete entries in
// the middle (a song that cannot be matched leaves a gap rather than renumbering the rest).
//
// Optional per-song overrides in tools/overrides.json, keyed "Artist - Title" (as in songs.json):
//   { "itunesId": 123 }    pin an exact iTunes track (looked up via /lookup instead of searched),
//                          used where search prefers a compilation/reissue over the original album
//   { "term": "..." }      custom search term
//   { "allow": ["live"] }  allow normally-rejected version markers (live, remix, ...) for this song
//
// Node 22, no dependencies. Requests are throttled (~18/min) with retry + exponential backoff.
// Falls back to curl when Node's fetch fails (e.g. proxy not picked up).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, '..');
const SONGS = join(TOOLS, 'songs.json');
const CACHE = join(TOOLS, '.cache.json');
const MATCHES = join(TOOLS, 'matches.json');
const OVERRIDES = join(TOOLS, 'overrides.json');
const DECK = join(ROOT, 'app', 'data', 'deck.json');
const COUNTRY = 'NL';
const MIN_INTERVAL_MS = 3300; // ~18 requests/minute, under the ~20/min limit
const REFRESH = process.argv.includes('--refresh');

// ---------- cache ----------
// Only the fields the matcher needs are cached, to keep the file small.
const KEEP = ['wrapperType', 'kind', 'trackId', 'artistName', 'trackName', 'collectionName', 'collectionArtistName',
  'releaseDate', 'trackTimeMillis', 'trackExplicitness', 'previewUrl', 'trackViewUrl'];
const slim = (json) => ({ results: (json.results || []).map((r) => Object.fromEntries(KEEP.filter((k) => k in r).map((k) => [k, r[k]]))) });
const cache = !REFRESH && existsSync(CACHE)
  ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(CACHE, 'utf8'))).map(([k, v]) => [k, slim(v)]))
  : {};
const saveCache = () => writeFileSync(CACHE, JSON.stringify(cache) + '\n');

// ---------- throttled HTTP ----------
let lastRequest = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'TimeTunesr-deck-builder' } });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    // fetch may not honour HTTPS_PROXY in every setup; curl does.
    const out = execFileSync('curl', ['-sS', '-w', '\n%{http_code}', url], { encoding: 'utf8', maxBuffer: 32 << 20 });
    const i = out.lastIndexOf('\n');
    return { status: Number(out.slice(i + 1)), text: out.slice(0, i) };
  }
}

async function getJson(url) {
  if (cache[url]) return cache[url];
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    let status, text;
    try {
      ({ status, text } = await httpJson(url));
    } catch (err) {
      status = 0; text = String(err);
    }
    if (status === 200) {
      try {
        const json = slim(JSON.parse(text));
        cache[url] = json;
        saveCache();
        return json;
      } catch { /* malformed body: retry */ }
    }
    const backoff = Math.min(60000, 5000 * 2 ** attempt);
    console.warn(`  ! HTTP ${status} (attempt ${attempt + 1}), retrying in ${backoff / 1000}s`);
    await sleep(backoff);
  }
  throw new Error(`giving up on ${url}`);
}

const searchUrl = (term, limit) =>
  `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&country=${COUNTRY}&limit=${limit}`;
const lookupUrl = (id) => `https://itunes.apple.com/lookup?id=${id}&country=${COUNTRY}`;

// ---------- normalisation & matching ----------
const strip = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ø/gi, 'o');
function norm(s) {
  return strip(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const DECO_RE = /\s*[\(\[][^\)\]]*[\)\]]+|\s+-\s+.*$|\s+(?:feat\.?|ft\.)\s.*$/gi;
// title without "(Remastered 2011)", "- Radio Edit", "[feat. X]" etc.
const baseTitle = (s) => norm(s.replace(DECO_RE, ' '));
const compact = (s) => s.replace(/\s/g, '');
const decorations = (trackName) => (trackName.match(DECO_RE) || []).join(' ');

// Version markers in the track-name decorations that mean "not the original recording".
const BAD = ['karaoke', 'tribute', 'cover', 'live', 'remix', 'rmx', 'mix', 'remake', 're recorded', 'rerecorded',
  'rerecord', 're record', 'instrumental', 'in style of', 'made famous', 'originally performed', 'acoustic', 'demo',
  'rehearsal', 'piano', 'pianoforte', 'orchestral', 'symphonic', 'sped up', 'slowed', 'lullaby', 'rendition', 'medley',
  'reprise', 'unplugged', 'session', 'take', 'a cappella', 'acapella', 'extended', 'dub', 'nightcore', 'bootleg',
  'workout', 'lofi', 'taylor s version', 'new version', 'ai version', 'cover version', 'without rap', 'clean'];
// Album-level markers (album names like "Live at Wembley", "... (Sped Up Version) - Single").
const BAD_ALBUM = ['karaoke', 'tribute', 'live', 'covers', 'in style of', 'made famous', 'originally performed',
  'lullaby', 'lullabies', 'instrumental', 'instrumentals', 'remix', 'remixes', 'remixed', 'mixes', 'remake', 'rmx',
  'unplugged', 'acoustic', 'symphonic', 'orchestral', 'sped up', 'slowed', 'bootleg', 'workout', 'lofi', 'piano',
  'string quartet', 'yn it frysk'];
const COMPILATION = /\b(hits|best|greatest|collection|essential|essentials|anthology|gold|golden|ultimate|top 40|top 2000|now|100|party|classics|het beste|mooiste|compilation|jaren|decade|feest|pure|keep calm|number ones|50|signature box|forty licks|soul queen|body by jake|invigorator)\b/;
// Decoration words that do not change the recording ("Single Version", "2011 Remaster", "feat. X", ...).
const HARMLESS = new Set(['remaster', 'remastered', 'digital', 'digitally', 'single', 'album', 'version', 'original',
  'edit', 'radio', '7', 'stereo', 'full', 'length', 'lp', 'from', 'soundtrack', 'mono', 'b', 'side', 'bonus', 'track']);

function badMarkers(song, r, allow) {
  const own = ` ${norm(song.title)} `; // words that are part of the real title never count ("Live and Let Die")
  const has = (hay, b) => hay.includes(` ${b} `) && !own.includes(` ${b} `) && !allow.includes(b);
  const trackHay = ` ${norm(decorations(r.trackName))} `;
  const albumHay = ` ${norm(r.collectionName || '')} `;
  return [...BAD.filter((b) => has(trackHay, b)), ...BAD_ALBUM.filter((b) => has(albumHay, b))];
}

// Words in the track-name decorations that are neither part of the source title nor harmless.
function unexplainedDecoration(song, r) {
  const deco = decorations(r.trackName)
    .replace(/[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]/gi, ' ') // credited guests
    .replace(/\s+(?:feat\.?|ft\.)\s.*$/i, ' ')
    .replace(/[\(\[][^\)\]]*\bfrom\b[^\)\]]*[\)\]]/gi, ' '); // (From "Saturday Night Fever")
  const own = new Set(norm(song.title).split(' '));
  return norm(deco).split(' ').filter((w) => w && !own.has(w) && !HARMLESS.has(w) && !/^(19|20)\d\d$/.test(w));
}

function artistOk(song, r) {
  const a = compact(norm(song.artist));
  const b = compact(norm(r.artistName));
  if (!a || !b) return false;
  if (a === b || b.includes(a) || a.includes(b)) return true;
  // "Calvin Harris & Dua Lipa" vs "Calvin Harris, Dua Lipa": first credited artist matches
  const first = (s) => compact(norm(strip(s).split(/\s*(?:&|,| x | and | feat\.?| ft\.?| with )\s*/i)[0]));
  return first(song.artist) === first(r.artistName) || b.includes(first(song.artist));
}

function titleScore(song, r) {
  const want = compact(baseTitle(song.title));
  const fullWant = compact(norm(song.title));
  const got = compact(baseTitle(r.trackName));
  const fullGot = compact(norm(r.trackName));
  if (!got) return 0;
  if (got === want || fullGot === fullWant || got === fullWant || fullGot === want) return 3;
  if ((want.length >= 4 && got.startsWith(want)) || (got.length >= 4 && want.startsWith(got))) return 1;
  return 0;
}

function score(song, r) {
  const allow = song.allow || [];
  if (r.wrapperType !== 'track' || r.kind !== 'song' || !r.previewUrl) return null;
  if (!artistOk(song, r)) return null;
  const t = titleScore(song, r);
  if (!t) return null;
  if (badMarkers(song, r, allow).length) return null;
  let s = t * 10;
  const relYear = r.releaseDate ? Number(r.releaseDate.slice(0, 4)) : 9999;
  const dy = relYear - song.year;
  if (dy >= 0 && dy <= 1) s += 12; // original single/album release
  else if (dy > 1) s -= Math.min(10, dy / 3); // later reissue/compilation: mild penalty
  else s -= 5; // release before the song's year is suspicious
  const coll = norm(r.collectionName || '');
  if (r.collectionArtistName && /various/i.test(r.collectionArtistName)) s -= 8;
  if (COMPILATION.test(coll)) s -= 6;
  if (/\b(soundtrack|motion picture|colonna sonora)\b/.test(coll) && !/soundtrack|motion picture/i.test(r.trackName)) s -= 3;
  if (/\bsingle\b/.test(coll) || compact(coll) === compact(baseTitle(song.title))) s += 1;
  if (/remaster/i.test(r.trackName)) s -= 0.5;
  if (/\b(edit|short|radio)\b/i.test(r.trackName) && !/\b(edit|short|radio)\b/i.test(song.title)) s -= 2;
  s -= 15 * Math.min(1, unexplainedDecoration(song, r).length);
  if (compact(norm(r.artistName)) === compact(norm(song.artist))) s += 2;
  if (r.trackExplicitness === 'cleaned') s -= 1;
  return s;
}

async function findMatch(song) {
  if (song.itunesId) {
    const j = await getJson(lookupUrl(song.itunesId));
    const r = j.results?.[0];
    return r?.previewUrl ? { r, s: 99, via: 'pinned' } : null;
  }
  const terms = [song.term || `${song.artist} ${song.title}`];
  if (!song.term) terms.push(`${song.title} ${song.artist.split(/\s*(?:&|,| feat)/)[0]}`, song.title);
  let best = null;
  for (const term of terms) {
    const j = await getJson(searchUrl(term, term === song.title ? 50 : 25));
    for (const r of j.results || []) {
      const s = score(song, r);
      if (s !== null && (!best || s > best.s)) best = { r, s, via: term };
    }
    if (best) return best;
  }
  return null;
}

// ---------- main ----------
const overrides = existsSync(OVERRIDES) ? JSON.parse(readFileSync(OVERRIDES, 'utf8')) : {};
const songs = JSON.parse(readFileSync(SONGS, 'utf8')).map((s) => ({ ...s, ...overrides[`${s.artist} - ${s.title}`] }));
const cards = [];
const skipped = [];
const log = [];
const seenIds = new Set();

for (const [i, song] of songs.entries()) {
  const id = String(i + 1).padStart(3, '0');
  let m;
  try {
    m = await findMatch(song);
    if (m && m.via === 'pinned' && !artistOk(song, m.r)) throw new Error(`pinned itunesId ${song.itunesId} is by ${m.r.artistName}`);
  } catch (err) {
    skipped.push({ id, ...song, reason: err.message });
    continue;
  }
  if (!m) {
    skipped.push({ id, ...song, reason: 'no reliable match with previewUrl' });
    console.log(`${id} SKIP  ${song.artist} - ${song.title}`);
    continue;
  }
  const r = m.r;
  if (seenIds.has(r.trackId)) {
    skipped.push({ id, ...song, reason: `duplicate itunesId ${r.trackId}` });
    continue;
  }
  seenIds.add(r.trackId);
  const relYear = r.releaseDate?.slice(0, 4);
  const exact = compact(norm(r.artistName)) === compact(norm(song.artist)) && compact(norm(r.trackName)) === compact(norm(song.title));
  log.push({ id, artist: song.artist, title: song.title, year: song.year, itunesId: r.trackId, artistName: r.artistName,
    trackName: r.trackName, collectionName: r.collectionName, releaseYear: relYear, score: Math.round(m.s * 10) / 10, exact });
  console.log(`${id} ${exact ? 'ok   ' : 'DIFF '} ${song.artist} - ${song.title} (${song.year})  =>  ${r.artistName} - ${r.trackName} [${r.collectionName}, ${relYear}]`);
  cards.push({
    id,
    title: song.title,
    artist: song.artist,
    year: song.year,
    itunesId: r.trackId,
    previewUrl: r.previewUrl,
    trackViewUrl: r.trackViewUrl,
  });
}

saveCache();
writeFileSync(DECK, JSON.stringify({ version: 1, country: COUNTRY, cards }, null, 2) + '\n');
writeFileSync(MATCHES, JSON.stringify(log, null, 1) + '\n');

console.log(`\nWrote ${cards.length} cards to ${DECK} (match log: ${MATCHES})`);
if (skipped.length) {
  console.log(`Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  ${s.id} ${s.artist} - ${s.title} (${s.year}): ${s.reason}`);
}
