// "Quiz": the third game of "Samen spelen" (room server only). Pure, no DOM, no network:
// the rules the server uses (via game.js) and `npm test` checks.
//
// A song plays hidden on the music phone; every phone gets the same question with four
// answers: the year, the artist or the title. One answer per player, not to be changed;
// a right answer is worth QUIZ_BASE points plus a speed bonus (up to QUIZ_SPEED), plus a
// small bonus for a streak of right answers. After the last question: podium.
import { seededRandom, shuffle } from '../logic.js';
import { normalizeTitle, normalizeArtist, splitArtists } from '../spotify-match.js';

export const QUIZ_TYPES = ['mix', 'year', 'artist', 'title'];
export const QUIZ_COUNTS = [10, 15, 20];
export const QUIZ_TIMES = [15, 20, 30];
export const DEFAULT_QUIZ = { questions: 10, qtype: 'mix', think: 20 };
/** Fewest songs a quiz can be played with. */
export const QUIZ_MIN_SONGS = 4;
export const QUIZ_BASE = 500;
export const QUIZ_SPEED = 500;
export const QUIZ_STREAK_STEP = 50;
export const QUIZ_STREAK_MAX = 200;
/** The clock starts when the music phone says the song plays; without that message after this long anyway. */
export const QUIZ_START_FALLBACK_MS = 6000;
/** Answers that arrive a little after the deadline (network) still count. */
export const QUIZ_GRACE_MS = 800;
export const LETTERS = ['A', 'B', 'C', 'D'];

export const PROMPTS = {
  year: 'Uit welk jaar is dit nummer?',
  artist: 'Wie is de artiest?',
  title: 'Hoe heet dit nummer?',
};

const artistKey = (a) => splitArtists(a || '')[0] || normalizeArtist(a || '');
const titleKey = (t) => normalizeTitle(t || '');

/** Which kinds of question does this deck allow? Artist / title need four different ones. */
export function quizTypesFor(cards) {
  const artists = new Set((cards || []).map((c) => artistKey(c.artist)).filter(Boolean));
  const titles = new Set((cards || []).map((c) => titleKey(c.title)).filter(Boolean));
  return { year: true, artist: artists.size >= 4, title: titles.size >= 4 };
}

/**
 * The kind of every question: `qtype` for all of them, or with 'mix' year / artist / title
 * in turns (shuffled per three). Kinds the deck does not allow become year questions.
 */
export function questionTypes(qtype, total, available, rand = Math.random) {
  const ok = (t) => t === 'year' || available[t];
  const out = [];
  while (out.length < total) {
    const block = qtype === 'mix' ? shuffle(['year', 'artist', 'title'], rand) : [qtype];
    for (const t of block) if (out.length < total) out.push(ok(t) ? t : 'year');
  }
  return out;
}

/** Three wrong years: one close (1–3), one further (4–8), one far (9–15); never double, never in the future. */
export function yearOptions(year, rand = Math.random, maxYear = new Date().getFullYear()) {
  const y = Number(year);
  const used = new Set([y]);
  const pick = (lo, hi) => {
    for (let guard = 0; guard < 40; guard++) {
      const d = lo + Math.floor(rand() * (hi - lo + 1));
      const sign = rand() < 0.5 ? -1 : 1;
      for (const s of [sign, -sign]) {
        const c = y + s * d;
        if (c >= 1900 && c <= maxYear && !used.has(c)) { used.add(c); return c; }
      }
    }
    for (let d = 1; d < 200; d++) for (const c of [y - d, y + d]) if (c >= 1900 && c <= maxYear && !used.has(c)) { used.add(c); return c; }
    return null;
  };
  const wrong = [pick(1, 3), pick(4, 8), pick(9, 15)].filter((x) => x != null);
  return [y, ...wrong].sort((a, b) => a - b);
}

/** Three other songs of the deck for an artist / title question: other artist (or title), about the same period first. */
function distractors(cards, song, kind, rand) {
  const key = kind === 'artist' ? (c) => artistKey(c.artist) : (c) => titleKey(c.title);
  const own = key(song);
  const ownArtist = artistKey(song.artist);
  const seen = new Set([own]);
  const pool = shuffle((cards || []).filter((c) => c && c.id !== song.id && key(c) && !seen.has(key(c))
    && (kind !== 'artist' || artistKey(c.artist) !== ownArtist)), rand);
  const out = [];
  for (const span of [5, 10, 20, Infinity]) {
    for (const c of pool) {
      if (out.length >= 3) break;
      if (Math.abs(Number(c.year) - Number(song.year)) > span || seen.has(key(c))) continue;
      seen.add(key(c));
      out.push(kind === 'artist' ? c.artist : c.title);
    }
  }
  return out;
}

/**
 * The question for one song: { type, options: [4 strings], answer: index }.
 * Years in order, artists / titles shuffled. Falls back to a year question when the deck
 * has too few different artists / titles.
 */
export function makeQuestion(cards, song, type, rand = Math.random, maxYear) {
  if (type === 'artist' || type === 'title') {
    const wrong = distractors(cards, song, type, rand);
    if (wrong.length === 3) {
      const right = type === 'artist' ? song.artist : song.title;
      const options = shuffle([right, ...wrong], rand);
      return { type, options, answer: options.indexOf(right) };
    }
  }
  const years = yearOptions(song.year, rand, maxYear);
  return { type: 'year', options: years.map(String), answer: years.indexOf(Number(song.year)) };
}

/** Points for a right answer after `elapsedMs` of `thinkS` seconds, with `streak` right answers before it. */
export function quizPoints(elapsedMs, thinkS, streak = 0) {
  const t = Math.max(1, thinkS * 1000);
  const frac = Math.min(1, Math.max(0, elapsedMs / t));
  const speed = Math.round(QUIZ_SPEED * (1 - frac));
  const bonus = Math.min(QUIZ_STREAK_MAX, QUIZ_STREAK_STEP * Math.max(0, streak));
  return QUIZ_BASE + speed + bonus;
}

/** Ranks with shared places: { id: rank } (1 = first; equal scores share the place). */
export function quizRanks(scores) {
  const list = Object.entries(scores || {});
  return Object.fromEntries(list.map(([id, s]) => [id, 1 + list.filter(([, o]) => o > s).length]));
}

/** Random generator for question `round` of a game with `seed` (the same on every replay). */
export const questionRand = (seed, round) => seededRandom(((seed >>> 0) + Math.imul(round + 1, 0x9e3779b1)) >>> 0);

export function normalizeQuizSettings(s = {}) {
  return {
    questions: QUIZ_COUNTS.includes(Number(s.questions)) ? Number(s.questions) : DEFAULT_QUIZ.questions,
    qtype: QUIZ_TYPES.includes(s.qtype) ? s.qtype : DEFAULT_QUIZ.qtype,
    think: QUIZ_TIMES.includes(Number(s.think)) ? Number(s.think) : DEFAULT_QUIZ.think,
  };
}
