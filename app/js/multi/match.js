// Tolerant check of a typed artist or title ("Samen spelen", Bingo squares Artiest/Titel).
// Pure, no DOM: shared by the host in the browser and `npm test`.
//
// Builds on the normalisation of spotify-match.js (accents, case, punctuation, "(...)",
// " - Remastered" suffixes, "feat. X") and adds: leading articles (the/de/het/een/...),
// "en"/"and"/"&"/"n" as one word, spaces ignored, and small typing errors
// (edit distance, more slack for longer names). The host can always overrule.
//
// Discobingo uses a three-way verdict (artistVerdict / titleVerdict): 'right', 'doubt' (the
// host decides) or 'wrong'. On top of the rules above it has a sound-alike pass (doubled
// letters, ph/f, ck/k/c, y/i/ij, z/s, th/t ...) and calls near misses, part of a name or a
// title with a word missing or extra a doubt: rather a doubt too many than a wrong rejection.
// matchArtist / matchTitle stay as they were for classic room Bingo.
import { fold, normalizeTitle, normalizeArtist, splitArtists } from '../spotify-match.js';

const ARTICLES = new Set(['the', 'a', 'an', 'de', 'het', 'een', 't', 'le', 'la', 'les', 'el', 'die', 'der', 'das']);
const AND_WORDS = new Set(['and', 'en', 'n', 'und', 'et', 'y']);

const words = (s) => String(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Words without a leading article, with every "and"-word unified. */
function canon(normalized) {
  const ws = words(normalized).split(' ').filter(Boolean).map((w) => (AND_WORDS.has(w) ? 'and' : w));
  while (ws.length > 1 && ARTICLES.has(ws[0])) ws.shift();
  return ws.join(' ');
}

const compact = (s) => s.replace(/ /g, '');

/**
 * Edit distance (optimal string alignment): insert, delete, replace and swapping two
 * neighbouring letters ("teh" -> "the") each count as one typo.
 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How many typing errors a name of this length may contain. */
export function allowedTypos(length) {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  if (length <= 14) return 2;
  return 3;
}

const numbers = (s) => (s.match(/\d+/g) || []).join(' ');

function compare(guessForms, targetForms) {
  let best = { ok: false, distance: Infinity, score: 0 };
  for (const t of targetForms) {
    const tc = compact(t);
    if (!tc) continue;
    for (const g of guessForms) {
      const gc = compact(g);
      if (!gc) continue;
      const d = editDistance(gc, tc);
      // a typo is fine, another number is not ("1999" is not "1998", "Song 2" is not "Song 3")
      const ok = d <= allowedTypos(tc.length) && numbers(g) === numbers(t);
      const score = 1 - d / Math.max(gc.length, tc.length);
      if ((ok && !best.ok) || (ok === best.ok && d < best.distance)) best = { ok, distance: d, score };
    }
  }
  return best;
}

/** Possible spellings of a song title: the core title and the title including bracket words. */
function titleForms(title) {
  const core = canon(normalizeTitle(title));
  const full = canon(fold(title).replace(/\s\b(feat|ft|featuring)\b\.?\s.*$/, ' ').replace(/\s+-\s+.*$/, ' '));
  return [...new Set([core, full].filter(Boolean))];
}

/**
 * Does the typed `guess` match the song title? Returns
 * { ok, doubt, score }: `doubt` marks near misses and accepted typos, so the host can look twice.
 */
export function matchTitle(guess, title) {
  const g = String(guess ?? '').trim();
  if (!g) return { ok: false, doubt: false, score: 0 };
  return verdict(compare(titleForms(g), titleForms(title)));
}

/** Possible spellings of an artist: the whole credit and every single artist in it. */
function artistForms(artist) {
  const whole = canon(normalizeArtist(artist));
  const parts = splitArtists(artist).map(canon);
  return [...new Set([whole, ...parts].filter(Boolean))];
}

/** Does the typed `guess` match the artist (the full credit or one of the named artists)? */
export function matchArtist(guess, artist) {
  const g = String(guess ?? '').trim();
  if (!g) return { ok: false, doubt: false, score: 0 };
  const r = compare([canon(normalizeArtist(g))], artistForms(artist));
  return verdict(r);
}

function verdict(r) {
  const doubt = r.ok ? r.distance > 0 : r.score >= 0.6;
  return { ok: r.ok, doubt, score: Math.round(r.score * 100) / 100 };
}

/* ---------- three-way verdict (Discobingo) ---------- */

/**
 * Sound-alike key of a compact spelling: letters that sound the same in Dutch / English
 * names are unified, doubled letters collapsed ("Chilli" = "Chili", "Phil" = "Fil").
 */
export function soundKey(s) {
  return String(s)
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/kh/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/ij/g, 'i')
    .replace(/y/g, 'i')
    .replace(/z/g, 's')
    .replace(/dt\b|d$/g, 't')
    .replace(/(.)\1+/g, '$1');
}

const digitsOff = (s) => s.replace(/\d+/g, '');

/** Does one typed word stand for one word of the name (a small typo or sound-alike allowed)? */
const sameWord = (g, t) => editDistance(g, t) <= allowedTypos(t.length) || soundKey(g) === soundKey(t);

/** Every word of `small` matches its own word of `big`. */
function wordsInside(small, big) {
  const pool = big.slice();
  for (const w of small) {
    const at = pool.findIndex((t) => sameWord(w, t));
    if (at < 0) return false;
    pool.splice(at, 1);
  }
  return true;
}

function judgePair(g, t, kind) {
  const gc = compact(g);
  const tc = compact(t);
  if (!gc || !tc) return { verdict: 'wrong', score: 0 };
  const d = editDistance(gc, tc);
  const tol = allowedTypos(tc.length);
  const sameNumbers = numbers(g) === numbers(t);
  const score = Math.max(1 - d / Math.max(gc.length, tc.length), 1 - editDistance(soundKey(gc), soundKey(tc)) / Math.max(soundKey(gc).length, soundKey(tc).length));
  // right: equal after normalising, a small typo, or it sounds the same; never another number
  if (sameNumbers && (d <= tol || soundKey(gc) === soundKey(tc))) return { verdict: 'right', score: 1 - d / Math.max(gc.length, tc.length) };
  // another number on the same words ("Song 2" / "Song 3", "1999" / "1998"): the host decides
  if (!sameNumbers && editDistance(digitsOff(gc), digitsOff(tc)) <= tol) return { verdict: 'doubt', score };
  // one typo too many
  if (d <= tol + 1) return { verdict: 'doubt', score };
  // only a part of the name, or a word missing / extra
  const gw = g.split(' ').filter(Boolean);
  const tw = t.split(' ').filter(Boolean);
  if (gw.length < tw.length && wordsInside(gw, tw)) {
    const longest = Math.max(...gw.map((w) => w.length));
    const enough = kind === 'artist' ? longest >= 4 || gc.length * 2 >= tc.length : tw.length - gw.length <= 1 || gc.length * 2 >= tc.length;
    if (enough) return { verdict: 'doubt', score };
  }
  if (gw.length > tw.length && gw.length - tw.length <= 2 && wordsInside(tw, gw)) return { verdict: 'doubt', score };
  // clearly the same thing, spelled very badly (short names: at most one letter off)
  if (score >= 0.6 && (tc.length > 5 || d <= 1)) return { verdict: 'doubt', score };
  return { verdict: 'wrong', score };
}

const RANK = { right: 2, doubt: 1, wrong: 0 };

function threeWay(guessForms, targetForms, kind) {
  let best = { verdict: 'wrong', score: 0 };
  for (const t of targetForms) {
    for (const g of guessForms) {
      const r = judgePair(g, t, kind);
      if (RANK[r.verdict] > RANK[best.verdict] || (r.verdict === best.verdict && r.score > best.score)) best = r;
    }
  }
  const verdict = best.verdict;
  return { verdict, ok: verdict === 'right', doubt: verdict === 'doubt', score: Math.round(Math.max(0, best.score) * 100) / 100 };
}

/** Three-way verdict of a typed artist: { verdict: 'right'|'doubt'|'wrong', ok, doubt, score }. */
export function artistVerdict(guess, artist) {
  const g = String(guess ?? '').trim();
  if (!g) return { verdict: 'wrong', ok: false, doubt: false, score: 0 };
  return threeWay([canon(normalizeArtist(g))], artistForms(artist), 'artist');
}

/** Three-way verdict of a typed title: { verdict: 'right'|'doubt'|'wrong', ok, doubt, score }. */
export function titleVerdict(guess, title) {
  const g = String(guess ?? '').trim();
  if (!g) return { verdict: 'wrong', ok: false, doubt: false, score: 0 };
  return threeWay(titleForms(g), titleForms(title), 'title');
}
