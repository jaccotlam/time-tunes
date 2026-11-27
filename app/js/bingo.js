// Pure logic for TimeTunesr Bingo. No DOM access: shared between the browser
// (app and print page) and the Node test runner (`npm test`).
import { seededRandom, shuffle, MIN_PLAYERS, MAX_PLAYERS } from './logic.js';
import { orderSongs } from './multi/order.js';

export { MIN_PLAYERS, MAX_PLAYERS };
export const SIZES = [3, 4];
export const DEFAULT_SIZE = 4;
export const YEAR_MARGIN = 2;

/**
 * All square types. `tier`: 1 = makkelijk (ruime periode), 2 = gemiddeld,
 * 3 = moeilijk. `check(year, guess)` returns true/false, or null when the group
 * has to judge (artist / title).
 */
export const SQUARES = {
  d60: { kind: 'decade', label: 'Jaren 60 of ouder', short: 'Jaren 60', sub: 'of ouder', range: 't/m 1969', tier: 2, check: (y) => y < 1970 },
  d70: { kind: 'decade', label: 'Jaren 70', sub: '1970–1979', tier: 2, check: (y) => y >= 1970 && y < 1980 },
  d80: { kind: 'decade', label: 'Jaren 80', sub: '1980–1989', tier: 2, check: (y) => y >= 1980 && y < 1990 },
  d90: { kind: 'decade', label: 'Jaren 90', sub: '1990–1999', tier: 2, check: (y) => y >= 1990 && y < 2000 },
  d00: { kind: 'decade', label: 'Jaren 00', sub: '2000–2009', tier: 2, check: (y) => y >= 2000 && y < 2010 },
  d10: { kind: 'decade', label: 'Jaren 10 of nieuwer', short: 'Jaren 10', sub: 'of nieuwer', range: 'vanaf 2010', tier: 2, check: (y) => y >= 2010 },
  pre80: { kind: 'period', label: 'Vóór 1980', sub: 't/m 1979', tier: 1, check: (y) => y < 1980 },
  pre00: { kind: 'period', label: 'Vóór 2000', sub: 't/m 1999', tier: 1, check: (y) => y < 2000 },
  from90: { kind: 'period', label: 'Vanaf 1990', sub: '1990 of later', tier: 1, check: (y) => y >= 1990 },
  from00: { kind: 'period', label: 'Vanaf 2000', sub: '2000 of later', tier: 1, check: (y) => y >= 2000 },
  year: { kind: 'year', label: 'Jaar ±2', sub: 'noem het jaartal', tier: 3, check: (y, g) => Number.isInteger(g) && Math.abs(g - y) <= YEAR_MARGIN },
  artist: { kind: 'artist', label: 'Artiest', sub: 'noem de artiest', tier: 2, check: () => null },
  title: { kind: 'title', label: 'Titel', sub: 'noem de titel', tier: 2, check: () => null },
};
export const DECADES = ['d60', 'd70', 'd80', 'd90', 'd00', 'd10'];
export const PERIODS = ['pre80', 'pre00', 'from90', 'from00'];

/**
 * How many squares of each kind a card gets. Tuned with a simulation against
 * app/data/deck.json (players who place ~60% of the songs in the right decade):
 * a 4-player game on 4×4 ends after 8 rounds on average (10% of games within
 * 6, 90% within 10, never before round 4); 3×3 after about 4 rounds.
 */
export const MIX = {
  3: { period: 2, decade: 4, year: 1, artist: 1, title: 1 },
  4: { period: 4, decade: 6, year: 2, artist: 2, title: 2 },
};

/** Row, column and diagonal index lists of an n×n grid. */
export function lines(size) {
  const out = [];
  for (let r = 0; r < size; r++) out.push(Array.from({ length: size }, (_, c) => r * size + c));
  for (let c = 0; c < size; c++) out.push(Array.from({ length: size }, (_, r) => r * size + c));
  out.push(Array.from({ length: size }, (_, i) => i * size + i));
  out.push(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)));
  return out;
}

/** Max. easy (period) squares per row/column/diagonal. */
export const MAX_EASY_PER_LINE = { 3: 1, 4: 1 };

/**
 * A layout is fair when every row, column and diagonal mixes easy and harder
 * squares: at most MAX_EASY_PER_LINE period squares, at most one "Jaar ±2",
 * and never the same group-judged square (Artiest/Titel) twice.
 */
export function isBalanced(card, size) {
  return lines(size).every((line) => {
    const keys = line.map((i) => card[i]);
    const tier = (t) => keys.filter((k) => SQUARES[k].tier === t).length;
    const count = (k) => keys.filter((x) => x === k).length;
    return tier(1) <= MAX_EASY_PER_LINE[size] && tier(3) <= 1 && count('artist') <= 1 && count('title') <= 1;
  });
}

function pickKeys(size, rand) {
  const mix = MIX[size];
  const keys = [];
  keys.push(...shuffle(PERIODS, rand).slice(0, mix.period));
  const decades = [];
  while (decades.length < mix.decade) decades.push(...shuffle(DECADES, rand));
  keys.push(...decades.slice(0, mix.decade));
  for (const k of ['year', 'artist', 'title']) for (let i = 0; i < mix[k]; i++) keys.push(k);
  return keys;
}

/** Which limit group a square counts towards inside one line. */
const groupOf = (key) => (SQUARES[key].tier === 1 ? 'easy' : SQUARES[key].tier === 3 ? 'hard' : key === 'artist' || key === 'title' ? key : null);

/** One random, balanced bingo card (array of square keys, row by row). */
export function generateCard(size = DEFAULT_SIZE, rand = Math.random) {
  if (!SIZES.includes(size)) throw new Error('Kies 3×3 of 4×4.');
  const keys = pickKeys(size, rand);
  const limits = { easy: MAX_EASY_PER_LINE[size], hard: 1, artist: 1, title: 1 };
  const allLines = lines(size);
  const cellLines = Array.from({ length: size * size }, (_, i) => allLines.filter((l) => l.includes(i)));
  // Constrained squares first (random cell that keeps every line within its limit), decades fill the rest.
  const constrained = keys.filter((k) => groupOf(k));
  const free = keys.filter((k) => !groupOf(k));
  for (let attempt = 0; attempt < 500; attempt++) {
    const card = Array(size * size).fill(null);
    let ok = true;
    for (const key of shuffle(constrained, rand)) {
      const g = groupOf(key);
      const options = card.map((k, i) => i).filter((i) => card[i] == null &&
        cellLines[i].every((l) => l.filter((j) => card[j] && groupOf(card[j]) === g).length < limits[g]));
      if (!options.length) { ok = false; break; }
      card[options[Math.floor(rand() * options.length)]] = key;
    }
    if (!ok) continue;
    const rest = shuffle(free, rand);
    for (let i = 0; i < card.length; i++) if (card[i] == null) card[i] = rest.pop();
    if (isBalanced(card, size)) return card;
  }
  throw new Error('Kon geen evenwichtige bingokaart maken.');
}

export const cardSignature = (card) => card.join(',');

/** `count` different cards from one seed (same seed -> same cards). */
export function generateCards(count, size = DEFAULT_SIZE, seed = Date.now()) {
  const rand = seededRandom(seed);
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < count && guard++ < count * 200) {
    const card = generateCard(size, rand);
    const sig = cardSignature(card);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(card);
  }
  if (out.length < count) throw new Error('Kon niet genoeg verschillende bingokaarten maken.');
  return out;
}

/** Does a claim on square `key` hold for a song from `year`? null = group decides. */
export function checkSquare(key, year, guess) {
  const sq = SQUARES[key];
  if (!sq) return false;
  return sq.check(Number(year), guess == null || guess === '' ? null : Number(guess));
}

/** A typed year is usable when it is a whole number between 1900 and 2100. */
export function parseYearGuess(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1900 && n <= 2100 ? n : null;
}

/** First complete line on `marks` (array of stamped card ids / null), or null. */
export function findBingo(marks, size) {
  return lines(size).find((line) => line.every((i) => marks[i] != null)) || null;
}

export const markCount = (marks) => marks.filter((m) => m != null).length;

/** Most squares stamped in any single line (for the progress overview). */
export function bestLine(marks, size) {
  return Math.max(...lines(size).map((line) => line.filter((i) => marks[i] != null).length));
}

/**
 * Create a new bingo game.
 * @param {{names: string[], size?: number, cards: {id:string, year:number}[], seed?: number}} opts
 */
export function createBingo({ names, size = DEFAULT_SIZE, cards, seed = Date.now() }) {
  const cleanNames = (names || []).map((n, i) => (String(n || '').trim() || `Speler ${i + 1}`).slice(0, 24));
  if (cleanNames.length < MIN_PLAYERS || cleanNames.length > MAX_PLAYERS) {
    throw new Error(`Kies ${MIN_PLAYERS} tot ${MAX_PLAYERS} spelers.`);
  }
  const n = SIZES.includes(Number(size)) ? Number(size) : DEFAULT_SIZE;
  const valid = (cards || []).filter((c) => c && c.id != null && Number.isFinite(c.year));
  if (valid.length < cleanNames.length) throw new Error('Er staan te weinig kaarten in het deck.');
  const rand = seededRandom(seed);
  const grids = [];
  const seen = new Set();
  for (let guard = 0; grids.length < cleanNames.length && guard < 1000; guard++) {
    const g = generateCard(n, rand);
    if (seen.has(cardSignature(g))) continue;
    seen.add(cardSignature(g));
    grids.push(g);
  }
  return {
    v: 1,
    game: 'bingo',
    size: n,
    seed,
    players: cleanNames.map((name, i) => ({ name, card: grids[i], marks: Array(n * n).fill(null) })),
    current: 0,
    round: 1,
    pile: orderSongs(valid.map((c) => c.id), Object.fromEntries(valid.map((c) => [c.id, c])), { rand, history }),
    years: Object.fromEntries(valid.map((c) => [c.id, c.year])),
    phase: 'turn', // 'turn' -> 'reveal' (-> 'judge' -> 'reveal') -> 'turn' | 'won'
    currentCard: null,
    last: null,
    winners: [],
    winLine: null,
  };
}

/** Draw the next song for the current player. */
export function startBingoTurn(state) {
  if (state.phase === 'won' || state.currentCard) return state;
  if (state.pile.length === 0) return finishBingoByEmptyPile(state);
  const pile = state.pile.slice();
  const currentCard = pile.shift();
  return { ...state, pile, currentCard, phase: 'turn', last: null };
}

/** Can the current player claim square `index` (open, and a valid guess for "Jaar ±2")? */
export function canClaim(state, index, guess) {
  if (state.phase !== 'turn' || !state.currentCard) return false;
  const p = state.players[state.current];
  if (!Number.isInteger(index) || index < 0 || index >= p.card.length) return false;
  if (p.marks[index] != null) return false;
  if (p.card[index] === 'year' && parseYearGuess(guess) == null) return false;
  return true;
}

function applyResult(state, correct) {
  const last = { ...state.last, correct };
  let players = state.players;
  let { phase, winners, winLine } = state;
  phase = 'reveal';
  if (correct) {
    players = state.players.map((pl, i) => {
      if (i !== last.player) return pl;
      const marks = pl.marks.slice();
      marks[last.index] = last.cardId;
      return { ...pl, marks };
    });
    const line = findBingo(players[last.player].marks, state.size);
    if (line) { phase = 'won'; winners = [last.player]; winLine = line; }
  }
  return { ...state, players, last, phase, winners, winLine };
}

/**
 * Claim square `index` for the current song. Year-based squares are decided at
 * once; artist/title squares go to phase 'judge' until the group decides.
 */
export function claimSquare(state, index, guess) {
  if (!canClaim(state, index, guess)) throw new Error('Dit vakje kun je nu niet kiezen.');
  const p = state.players[state.current];
  const key = p.card[index];
  const year = state.years[state.currentCard];
  const g = key === 'year' ? parseYearGuess(guess) : null;
  const last = { player: state.current, cardId: state.currentCard, index, key, guess: g, correct: null };
  const base = { ...state, currentCard: null, last };
  const verdict = checkSquare(key, year, g);
  if (verdict === null) return { ...base, phase: 'judge' };
  return applyResult(base, verdict);
}

/** The group's verdict on an artist/title claim. */
export function judgeClaim(state, ok) {
  if (state.phase !== 'judge' || !state.last) throw new Error('Er valt niets te beoordelen.');
  return applyResult(state, !!ok);
}

/** Next player after a reveal; ends the game when the songs are used up. */
export function nextBingoPlayer(state) {
  if (state.phase === 'won') return state;
  const current = (state.current + 1) % state.players.length;
  const round = current === 0 ? state.round + 1 : state.round;
  const s = { ...state, current, round, phase: 'turn', last: null, currentCard: null };
  if (s.pile.length === 0) return finishBingoByEmptyPile(s);
  return s;
}

/** Songs ran out: most stamped squares wins (ties share). */
export function finishBingoByEmptyPile(state) {
  const counts = state.players.map((p) => markCount(p.marks));
  const best = Math.max(...counts);
  const winners = counts.map((c, i) => (c === best ? i : -1)).filter((i) => i >= 0);
  return { ...state, phase: 'won', winners, winLine: null, currentCard: null, endedBy: 'pile' };
}

/** Shape check for a state restored from storage. */
export function isValidBingoState(s) {
  return !!(
    s && s.v === 1 && s.game === 'bingo' && SIZES.includes(s.size) &&
    Array.isArray(s.players) && s.players.length >= MIN_PLAYERS && s.players.length <= MAX_PLAYERS &&
    s.players.every((p) => p && typeof p.name === 'string' && Array.isArray(p.card) && Array.isArray(p.marks) &&
      p.card.length === s.size * s.size && p.marks.length === p.card.length && p.card.every((k) => SQUARES[k])) &&
    Array.isArray(s.pile) && s.years && typeof s.years === 'object' &&
    Number.isInteger(s.current) && s.current >= 0 && s.current < s.players.length &&
    ['turn', 'judge', 'reveal', 'won'].includes(s.phase) &&
    (s.phase !== 'judge' && s.phase !== 'reveal' ? true : !!s.last)
  );
}
