// Tolerant check of a typed artist or title ("Samen spelen", Bingo squares Artiest/Titel).
// Pure, no DOM: shared by the host in the browser and `npm test`.
//
// Builds on the normalisation of spotify-match.js (accents, case, punctuation, "(...)",
// " - Remastered" suffixes, "feat. X") and adds: leading articles (the/de/het/een/...),
// "en"/"and"/"&"/"n" as one word, spaces ignored, and small typing errors
// (edit distance, more slack for longer names). The host can always overrule.
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
