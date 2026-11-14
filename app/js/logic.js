// Pure game logic for TimeTunesr. No DOM access: this module is shared
// between the browser and the Node test runner (`npm test`).

/** Matches the card id in a scanned QR text such as https://x.y/app/#/c/042 */
export const CARD_HASH_RE = /#\/c\/([0-9A-Za-z]+)/;

/**
 * Extract the card id from any scanned text. Returns null when the text
 * does not contain a TimeTunesr card link.
 */
export function parseCardId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(CARD_HASH_RE);
  return m ? m[1] : null;
}

/**
 * Normalise what a person typed as card number: "42", " 042 ", "#42" -> "042".
 * Also accepts a full card URL. Returns null for empty / invalid input.
 */
export function normalizeCardInput(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const fromUrl = parseCardId(s);
  if (fromUrl) return padId(fromUrl);
  const cleaned = s.replace(/^#/, '').replace(/\s+/g, '');
  if (!/^[0-9A-Za-z]+$/.test(cleaned)) return null;
  return padId(cleaned);
}

/** Pad purely numeric ids to three digits ("7" -> "007"); others unchanged. */
export function padId(id) {
  const s = String(id);
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '').padStart(3, '0') : s;
}

/** Build the URL that goes into a card's QR code. */
export function cardUrl(baseUrl, id) {
  const base = String(baseUrl || '').split('#')[0];
  return `${base}#/c/${id}`;
}

/**
 * Is `year` correctly placed in gap `slot` of a chronologically sorted list of
 * years? Gap 0 is before the first card, gap years.length after the last one.
 * An equal year next to a neighbour counts as correct on both sides.
 */
export function isCorrectPlacement(years, slot, year) {
  if (!Number.isInteger(slot) || slot < 0 || slot > years.length) return false;
  const left = slot > 0 ? years[slot - 1] : -Infinity;
  const right = slot < years.length ? years[slot] : Infinity;
  return left <= year && year <= right;
}

/** All gaps in which `year` would be correct (useful to show after a miss). */
export function correctSlots(years, year) {
  const out = [];
  for (let i = 0; i <= years.length; i++) if (isCorrectPlacement(years, i, year)) out.push(i);
  return out;
}

/** Small deterministic PRNG (mulberry32) so games can be reproduced in tests. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffle(items, rand = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const DEFAULT_GOAL = 10;

/** Minimum number of cards needed for a digital game. */
export function cardsNeeded(playerCount) {
  return playerCount + 1;
}

/**
 * Create a new digital game.
 * @param {{names: string[], goal?: number, cards: {id:string, year:number}[], seed?: number}} opts
 */
export function createGame({ names, goal = DEFAULT_GOAL, cards, seed = Date.now() }) {
  const cleanNames = (names || []).map((n, i) => (String(n || '').trim() || `Speler ${i + 1}`).slice(0, 24));
  if (cleanNames.length < MIN_PLAYERS || cleanNames.length > MAX_PLAYERS) {
    throw new Error(`Kies ${MIN_PLAYERS} tot ${MAX_PLAYERS} spelers.`);
  }
  const g = Math.max(2, Math.min(50, Math.round(Number(goal) || DEFAULT_GOAL)));
  const valid = (cards || []).filter((c) => c && c.id != null && Number.isFinite(c.year));
  if (valid.length < cardsNeeded(cleanNames.length)) {
    throw new Error('Er staan te weinig kaarten in het deck voor dit aantal spelers.');
  }
  const years = Object.fromEntries(valid.map((c) => [c.id, c.year]));
  const pile = shuffle(valid.map((c) => c.id), seededRandom(seed));
  const players = cleanNames.map((name) => ({ name, timeline: [pile.shift()] }));
  for (const p of players) p.timeline.sort((a, b) => years[a] - years[b]);
  return {
    v: 1,
    goal: g,
    players,
    current: 0,
    pile,
    years,
    phase: 'turn', // 'turn' -> 'reveal' -> ('turn' | 'won')
    round: 1,
    currentCard: null,
    last: null,
    winners: [],
  };
}

/** Draw the next unused card for the current player. Pure: returns a new state. */
export function startTurn(state) {
  if (state.phase === 'won') return state;
  if (state.currentCard) return state;
  if (state.pile.length === 0) return finishByEmptyPile(state);
  const pile = state.pile.slice();
  const currentCard = pile.shift();
  return { ...state, pile, currentCard, phase: 'turn', last: null };
}

export function yearsOf(state, timeline) {
  return timeline.map((id) => state.years[id]);
}

/**
 * Place the current card in gap `slot` of the current player's timeline.
 * Returns the new state with `last` describing the outcome; phase becomes
 * 'reveal' (or 'won' when the goal is reached).
 */
export function placeCard(state, slot) {
  if (state.phase !== 'turn' || !state.currentCard) throw new Error('Er is geen kaart om te plaatsen.');
  const p = state.players[state.current];
  const years = yearsOf(state, p.timeline);
  const year = state.years[state.currentCard];
  const correct = isCorrectPlacement(years, slot, year);
  const players = state.players.map((pl, i) => {
    if (i !== state.current || !correct) return pl;
    const timeline = pl.timeline.slice();
    timeline.splice(slot, 0, state.currentCard);
    return { ...pl, timeline };
  });
  const last = {
    player: state.current,
    cardId: state.currentCard,
    slot,
    correct,
    correctSlots: correctSlots(years, year),
  };
  const next = { ...state, players, currentCard: null, last, phase: 'reveal' };
  if (correct && players[state.current].timeline.length >= state.goal) {
    return { ...next, phase: 'won', winners: [state.current] };
  }
  return next;
}

/** Move on to the next player after a reveal. */
export function nextPlayer(state) {
  if (state.phase === 'won') return state;
  const current = (state.current + 1) % state.players.length;
  const round = current === 0 ? state.round + 1 : state.round;
  const s = { ...state, current, round, phase: 'turn', last: null };
  if (s.pile.length === 0) return finishByEmptyPile(s);
  return s;
}

/** When the deck runs out, the longest timeline(s) win. */
export function finishByEmptyPile(state) {
  const best = Math.max(...state.players.map((p) => p.timeline.length));
  const winners = state.players.map((p, i) => (p.timeline.length === best ? i : -1)).filter((i) => i >= 0);
  return { ...state, phase: 'won', winners, currentCard: null, endedBy: 'pile' };
}

/** Basic shape check for a state restored from storage. */
export function isValidGameState(s) {
  return !!(
    s && s.v === 1 && Array.isArray(s.players) && s.players.length >= MIN_PLAYERS &&
    s.players.every((p) => p && typeof p.name === 'string' && Array.isArray(p.timeline)) &&
    Array.isArray(s.pile) && s.years && typeof s.years === 'object' &&
    Number.isInteger(s.current) && s.current >= 0 && s.current < s.players.length &&
    ['turn', 'reveal', 'won'].includes(s.phase)
  );
}
