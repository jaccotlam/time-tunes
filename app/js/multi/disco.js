// "Discobingo": the fourth game of "Samen spelen" (room server only). Pure, no DOM, no
// network: the rules the server uses (via game.js) and `npm test` checks.
//
// Every player has a 5×5 card of categories with a free star in the centre. Each round a
// disco ball picks one category (balanced, see drawCategory); everybody answers that
// question about the song; who is right stamps one open square of that category on their
// own card. Win with 1 line, 2 lines or a full card (lines: rows, columns, diagonals).
import { seededRandom, shuffle } from '../logic.js';
import { YEAR_MARGIN } from '../bingo.js';

/** The categories, in this order everywhere. `color` is the single source of truth (CSS mirrors it as `cssVar`). */
export const CATEGORIES = [
  // the two year categories must never be confused: other colour, figure, name and hint
  { key: 'exact', label: 'Exact jaar', short: 'Exact jaar', color: '#4fb3ff', cssVar: '--cat-exact' },
  { key: 'artist', label: 'Artiest / band', short: 'Artiest', color: '#ff5fa8', cssVar: '--cat-artist' },
  { key: 'year', label: 'Jaartal (±2)', short: 'Jaartal', color: '#ffc649', cssVar: '--cat-year' },
  { key: 'title', label: 'Titel', short: 'Titel', color: '#2ed3c0', cssVar: '--cat-title' },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const categoryOf = (key) => CATEGORIES.find((c) => c.key === key) || null;

export const SIZE = 5;
export const CELLS = SIZE * SIZE;
/** The free star in the middle: stamped from the start, of no category. */
export const CENTER = 12;
export const CENTER_KEY = 'free';
export const PER_CATEGORY = 6;
/** No row, column or diagonal holds more than this many squares of one category. */
export const MAX_SAME_PER_LINE = 2;
/** Songs needed to start a game (one per square, so a full card is possible). */
export const DISCO_MIN_SONGS = 25;
/** How long the ball spins on the phones (ms); a phone that loads later than this skips the animation. */
export const SPIN_MS = 4000;
/** "Eerste bingo bij": 1 line (default), 2 lines, full card; after a bingo the leader may go on to a higher goal. */
export const WINS = ['line1', 'line2', 'full'];
export const DEFAULT_WIN = 'line1';
export const WIN_LABELS = { line1: '1 lijn', line2: '2 lijnen', full: 'Volle kaart' };
/** A late joiner never gets more than this many stamped squares in one line. */
export const LATE_MAX_PER_LINE = 3;
/** Value of a mark stamped for free (the centre, a late joiner's head start); same as game.js FREE. */
export const FREE_MARK = '*';

/** The 12 lines of the card (5 rows, 5 columns, 2 diagonals), as lists of cell indices. */
export const LINES = (() => {
  const out = [];
  for (let r = 0; r < SIZE; r++) out.push(Array.from({ length: SIZE }, (_, c) => r * SIZE + c));
  for (let c = 0; c < SIZE; c++) out.push(Array.from({ length: SIZE }, (_, r) => r * SIZE + c));
  out.push(Array.from({ length: SIZE }, (_, i) => i * SIZE + i));
  out.push(Array.from({ length: SIZE }, (_, i) => i * SIZE + (SIZE - 1 - i)));
  return out;
})();
const CELL_LINES = Array.from({ length: CELLS }, (_, i) => LINES.filter((l) => l.includes(i)));

export const normalizeWin = (w) => (WINS.includes(w) ? w : DEFAULT_WIN);
/** After a bingo on goal `win`: the goals the game may go on with (2 lines after 1, a full card after 1 or 2). */
export const nextGoals = (win) => WINS.slice(WINS.indexOf(normalizeWin(win)) + 1);
/** How long "everybody answered" waits before the reveal happens by itself (ms, server clock). */
export const AUTO_REVEAL_MS = 4000;
/** Keys of categories that no longer exist (a room stored before "Exact jaar" replaced "Decennium"). */
export const OLD_CATEGORY_KEYS = ['decade'];

/* ---------- card ---------- */

/** Does a card keep the spread rule (at most 2 of a category per line) and the counts? */
export function isValidCard(card) {
  if (!Array.isArray(card) || card.length !== CELLS || card[CENTER] !== CENTER_KEY) return false;
  for (const k of CATEGORY_KEYS) if (card.filter((x) => x === k).length !== PER_CATEGORY) return false;
  return LINES.every((l) => CATEGORY_KEYS.every((k) => l.filter((i) => card[i] === k).length <= MAX_SAME_PER_LINE));
}

/**
 * One random card (array of 25 category keys, row by row, 'free' in the centre). A depth
 * first fill with a random order of cells and categories: always finds a card, quickly.
 */
export function generateDiscoCard(rand = Math.random) {
  const card = Array(CELLS).fill(null);
  card[CENTER] = CENTER_KEY;
  const left = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, PER_CATEGORY]));
  const order = shuffle(Array.from({ length: CELLS }, (_, i) => i).filter((i) => i !== CENTER), rand);
  const fits = (i, k) => CELL_LINES[i].every((l) => l.filter((j) => card[j] === k).length < MAX_SAME_PER_LINE);
  let steps = 0;
  const fill = (n) => {
    if (n === order.length) return true;
    if (++steps > 20000) return false; // never seen; a fresh order below
    const i = order[n];
    for (const k of shuffle(CATEGORY_KEYS, rand)) {
      if (!left[k] || !fits(i, k)) continue;
      card[i] = k; left[k]--;
      if (fill(n + 1)) return true;
      card[i] = null; left[k]++;
    }
    return false;
  };
  if (fill(0)) return card;
  return generateDiscoCard(rand);
}

export const discoSignature = (card) => card.join(',');

/** A card that differs from every signature in `taken` (a Set). */
export function uniqueDiscoCard(rand, taken = new Set()) {
  let card;
  for (let guard = 0; guard < 500; guard++) {
    card = generateDiscoCard(rand);
    if (!taken.has(discoSignature(card))) break;
  }
  return card;
}

/** Fresh marks: nothing stamped but the free centre. */
export function freshMarks() {
  const m = Array(CELLS).fill(null);
  m[CENTER] = FREE_MARK;
  return m;
}

/* ---------- lines and goals ---------- */

/** Every complete line on `marks` (stamped = not null). */
export const completeLines = (marks) => LINES.filter((l) => l.every((i) => marks[i] != null));

/** Stamped squares, the free centre not counted (the score when the songs run out). */
export const stampedCount = (marks) => marks.reduce((n, m, i) => n + (i !== CENTER && m != null ? 1 : 0), 0);

/** Most stamped squares in any one line (the centre counts). */
export const bestLineCount = (marks) => Math.max(...LINES.map((l) => l.filter((i) => marks[i] != null).length));

/** How many lines a goal needs (full card: all 12). */
export const linesNeeded = (win) => (win === 'line2' ? 2 : win === 'full' ? LINES.length : 1);

/** Has this card reached the goal? */
export function reachedGoal(marks, win) {
  if (win === 'full') return marks.every((m) => m != null);
  return completeLines(marks).length >= linesNeeded(win);
}

/**
 * The smallest number of squares a player still has to stamp to reach the goal (0 = reached).
 * 1 line: the open squares of the line with the fewest of them. 2 lines: the
 * cheapest pair of different lines, a square two lines share counted once (exact: all 66
 * pairs). Full card: every open square. The centre star and free stamps count as stamped.
 */
export function squaresToGo(marks, win) {
  const open = (i) => marks[i] == null;
  if (win === 'full') return marks.reduce((n, _, i) => n + (open(i) ? 1 : 0), 0);
  const gaps = LINES.map((l) => l.filter(open));
  if (win !== 'line2') return Math.min(...gaps.map((g) => g.length));
  let best = Infinity;
  for (let a = 0; a < gaps.length; a++) {
    for (let b = a + 1; b < gaps.length; b++) {
      const n = gaps[a].length + gaps[b].filter((i) => !gaps[a].includes(i)).length;
      if (n < best) best = n;
    }
  }
  return best;
}

/**
 * The cells to light up for a goal reached (or progress made): the complete lines, all
 * cells for a full card. Empty when nothing is complete.
 */
export function goalCells(marks, win) {
  if (win === 'full') return reachedGoal(marks, win) ? Array.from({ length: CELLS }, (_, i) => i) : [];
  return [...new Set(completeLines(marks).flat())].sort((a, b) => a - b);
}

/** Open squares of a category on a card. */
export const openSquares = (card, marks, cat) => card.map((k, i) => i).filter((i) => card[i] === cat && marks[i] == null);

/**
 * The square that helps most towards the goal, deterministic: the one that completes the
 * most lines, then the one in the fullest line, then the most progress over its lines,
 * then the lowest index. Null when no square of the category is open.
 */
export function bestSquare(card, marks, cat, win = DEFAULT_WIN) {
  const open = openSquares(card, marks, cat);
  let best = null;
  let bestKey = null;
  for (const i of open) {
    const after = marks.slice();
    after[i] = FREE_MARK;
    const counts = CELL_LINES[i].map((l) => l.filter((j) => after[j] != null).length);
    const key = [
      reachedGoal(after, win) ? 1 : 0,
      counts.filter((c) => c === SIZE).length,
      Math.max(...counts),
      counts.reduce((s, c) => s + c * c, 0),
    ];
    if (!bestKey || compareKeys(key, bestKey) > 0) { best = i; bestKey = key; }
  }
  return best;
}
function compareKeys(a, b) {
  for (let n = 0; n < a.length; n++) if (a[n] !== b[n]) return a[n] - b[n];
  return 0;
}

/**
 * Head start for a late joiner: `count` free stamps on random cells besides the centre,
 * never more than LATE_MAX_PER_LINE stamped in one line (the centre counts).
 */
export function lateMarks(count, rand) {
  const marks = freshMarks();
  let given = 0;
  for (const i of shuffle(Array.from({ length: CELLS }, (_, x) => x).filter((x) => x !== CENTER), rand)) {
    if (given >= count) break;
    marks[i] = FREE_MARK;
    if (bestLineCount(marks) > LATE_MAX_PER_LINE) { marks[i] = null; continue; }
    given++;
  }
  return marks;
}

/* ---------- years ---------- */

/** Jaartal: 2 years either side is still right. */
export const yearRight = (guess, year) => Number.isInteger(guess) && Math.abs(guess - Number(year)) <= YEAR_MARGIN;
/** Exact jaar: the release year itself, no margin. */
export const exactRight = (guess, year) => Number.isInteger(guess) && guess === Number(year);

/* ---------- balanced choice of the category ---------- */

/** The empty bag at the start of a game. */
export const freshBag = () => ({ bag: [], last: null, fills: 0, drawn: 0 });

function refill(state, seed) {
  const rand = seededRandom(((seed >>> 0) ^ Math.imul(state.fills + 1, 0x9e3779b1)) >>> 0);
  const set = shuffle(CATEGORY_KEYS, rand);
  // never the same category twice in a row, also across a refill
  if (set[0] === state.last) [set[0], set[1]] = [set[1], set[0]];
  return { ...state, bag: [...state.bag, ...set], fills: state.fills + 1 };
}

/**
 * Draw the category of the next round. `usable(key)`: does somebody who takes part still
 * have an open square of it? A shuffle bag of the four categories, drawn without
 * replacement and refilled when empty, never the same one twice in a row; an unusable
 * category is skipped but stays in the bag (so it comes first once it is usable again,
 * and the balance holds as well as possible). Returns { cat, state }.
 */
export function drawCategory(state, seed, usable = () => true) {
  let s = state && Array.isArray(state.bag) ? { ...state, bag: state.bag.slice() } : freshBag();
  if (!s.bag.length) s = refill(s, seed);
  const pick = (allowLast) => s.bag.findIndex((k) => usable(k) && (allowLast || k !== s.last));
  let at = pick(false);
  if (at < 0 && CATEGORY_KEYS.some((k) => k !== s.last && usable(k))) {
    // the bag holds only categories nobody can use: add a fresh set, the old ones stay owed
    s = refill(s, seed);
    at = pick(false);
  }
  if (at < 0 && s.last && usable(s.last)) {
    // only the last one is usable: a repeat is better than a dead round
    at = pick(true);
    if (at < 0) { s = refill(s, seed); at = pick(true); }
  }
  if (at < 0) at = Math.max(0, s.bag.findIndex((k) => k !== s.last)); // nothing usable at all: any
  const cat = s.bag[at];
  s.bag.splice(at, 1);
  // keep the bag small: at most two of a category owed
  const seen = {};
  s.bag = s.bag.filter((k) => (seen[k] = (seen[k] || 0) + 1) <= 2);
  return { cat, state: { ...s, last: cat, drawn: s.drawn + 1 } };
}
