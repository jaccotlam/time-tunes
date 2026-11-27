// "Samen spelen": the host's game machine. Pure, no DOM, no network: the host's browser
// runs it and `npm test` checks it. Every function returns a new room object.
//
// Rhythm of a round: a song plays -> every player answers on their own phone
// ('answering') -> the host reveals ('revealed') -> next song, or the winner screen ('won').
// Four games: Bingo (claim one open square per song, or pass), Tijdlijn (place the song
// in your own timeline), Quiz (four answers per song, speed counts; room server only,
// the rules in quiz.js) and Discobingo (a disco ball picks the category, who is right
// stamps a square of it on a 5×5 card; room server only, the rules in disco.js). Players who complete a line / reach the goal in the same round
// share the win. Reuses the rules of logic.js and bingo.js.
// The Quiz runs on a clock: its transitions take `now` (server time, ms).
import { seededRandom, shuffle, isCorrectPlacement, correctSlots, DEFAULT_GOAL } from '../logic.js';
import {
  generateCard, cardSignature, checkSquare, parseYearGuess, findBingo, markCount, bestLine,
  SQUARES, SIZES, DEFAULT_SIZE,
} from '../bingo.js';
import { matchArtist, matchTitle, artistVerdict, titleVerdict } from './match.js';
import {
  normalizeQuizSettings, quizTypesFor, questionTypes, makeQuestion, quizPoints, quizRanks, questionRand,
  QUIZ_GRACE_MS, QUIZ_MIN_SONGS, LETTERS,
} from './quiz.js';
import {
  CATEGORY_KEYS, CENTER_KEY, CELLS, DISCO_MIN_SONGS, categoryOf, uniqueDiscoCard, discoSignature, freshMarks,
  stampedCount, reachedGoal, goalCells, openSquares, bestSquare, lateMarks,
  yearRight, exactRight, drawCategory, freshBag, normalizeWin, isValidCard, CENTER, WINS, squaresToGo,
  nextGoals, AUTO_REVEAL_MS, SPIN_MS, OLD_CATEGORY_KEYS,
} from './disco.js';
import { isAvatar, avatarFor, avatarOf, JOKER_EVERY, JOKER_CAP, freshStats, cleanStats, discoAwards } from './party.js';

export const MAX_ROOM_PLAYERS = 12;
export const GAMES = ['bingo', 'timeline', 'quiz', 'disco'];
/** Games that need the room server (a clock, or answers only the server may judge). */
export const SERVER_GAMES = ['quiz', 'disco'];
/**
 * The game the lobby should offer first. normalizeSettings keeps 'bingo' as its fallback, so
 * stored PeerJS rooms and settings (and an unknown value) stay what they were; a screen on the
 * server route starts a new room with this one when no game was chosen before.
 */
export const PREFERRED_GAME = 'disco';
export const MIN_GOAL = 3;
export const MAX_GOAL = 30;
/** Mark of a square stamped for free when somebody joins halfway (see lateStart). */
export const FREE = '*';
export const MAX_TEXT = 60;

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A player's name: trimmed, single spaces, no control characters, max 24 characters. */
export function cleanName(name, fallback = 'Speler') {
  // also zero-width and bidi control characters: a name must look on every screen like what it is
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || fallback;
}

/** New room in the lobby. `host` ({id, name}) when the host plays along on their own device. */
export function createRoom({ code, host = null, settings = {} }) {
  const room = {
    v: 1,
    code,
    phase: 'lobby', // lobby -> answering -> revealed -> (answering | won) ; won/lobby -> answering
    settings: normalizeSettings(settings),
    players: [],
    removed: [],
    game: null,
  };
  if (host) room.players.push({ id: String(host.id), name: cleanName(host.name, 'Spelleider'), host: true, avatar: isAvatar(host.avatar) ? host.avatar : avatarFor(host.id) });
  return room;
}

export function normalizeSettings(s = {}) {
  return {
    game: GAMES.includes(s.game) ? s.game : 'bingo',
    size: SIZES.includes(Number(s.size)) ? Number(s.size) : DEFAULT_SIZE,
    goal: Math.max(MIN_GOAL, Math.min(MAX_GOAL, Math.round(Number(s.goal) || DEFAULT_GOAL))),
    ...normalizeQuizSettings(s),
    win: normalizeWin(s.win), // Discobingo: "Eerste bingo bij" 1 lijn / 2 lijnen / volle kaart (the first goal)
    // Discobingo: everybody answered -> the reveal by itself after AUTO_REVEAL_MS (default on)
    autoReveal: s.autoReveal !== false,
    // where the songs come from: the leader's own deck, or the "Mix van de groep" (room server only)
    music: s.music === 'mix' ? 'mix' : 'deck',
  };
}

/** Change game settings (only between games). */
export function setSettings(room, patch) {
  if (room.phase !== 'lobby' && room.phase !== 'won') throw new GameError('busy', 'Het spel is al bezig.');
  return { ...room, settings: normalizeSettings({ ...room.settings, ...patch }) };
}

export const findPlayer = (room, id) => room.players.find((p) => p.id === id) || null;

/**
 * Ids come from the phones: an id like "__proto__" or "constructor" would find an inherited
 * member of a plain object (per, results, answers ...). Such ids never get in, and every
 * lookup by a client-supplied id goes through own().
 */
export const isSafeId = (id) => typeof id === 'string' && id.length > 0 && !(id in Object.prototype);
export const own = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * Somebody joins (or comes back). A known id keeps its place and stand; a new player who
 * arrives during a game gets a fair start (lateStart). Throws GameError 'removed' / 'full'.
 * `online` ({id: true}, optional): who is connected now, for the fair start (see lateStart).
 */
export function addPlayer(room, { id, name, avatar }, { online = null } = {}) {
  const pid = String(id || '');
  if (!pid || !isSafeId(pid)) throw new GameError('bad', 'Speler zonder id.');
  if (room.removed.includes(pid)) throw new GameError('removed', 'Je bent door de spelleider uit deze kamer gehaald.');
  const known = findPlayer(room, pid);
  if (known) {
    const n = cleanName(name, known.name);
    return n === known.name ? room : { ...room, players: room.players.map((p) => (p.id === pid ? { ...p, name: n } : p)) };
  }
  if (room.players.length >= MAX_ROOM_PLAYERS) throw new GameError('full', `Deze kamer is vol (${MAX_ROOM_PLAYERS} spelers).`);
  // the avatar the phone picked (from the fixed list), else a stable one derived from the id
  const player = { id: pid, name: uniqueName(room, cleanName(name, `Speler ${room.players.length + 1}`)), avatar: isAvatar(avatar) ? avatar : avatarFor(pid) };
  let next = { ...room, players: [...room.players, player] };
  if (next.game) next = lateStart(next, pid, online);
  return next;
}

/** A player picks another avatar (from the fixed list; only in the lobby, so a game's tiles stay put). */
export function setAvatar(room, pid, avatar) {
  if (!isAvatar(avatar)) throw new GameError('avatar', 'Kies een plaatje uit de lijst.');
  if (room.phase !== 'lobby') throw new GameError('avatar', 'Je plaatje kun je alleen in de lobby wijzigen.');
  if (!findPlayer(room, pid)) throw new GameError('avatar', 'Je zit niet in deze kamer.');
  if (findPlayer(room, pid).avatar === avatar) return room;
  return { ...room, players: room.players.map((p) => (p.id === pid ? { ...p, avatar } : p)) };
}

function uniqueName(room, name) {
  const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name.slice(0, 21)} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** The host removes a player. Their id can not come back into this room. */
export function removePlayer(room, id) {
  const p = findPlayer(room, id);
  if (!p) return room;
  if (p.host) throw new GameError('host', 'De spelleider kan zichzelf niet verwijderen.');
  const next = { ...room, players: room.players.filter((x) => x.id !== id), removed: [...room.removed, id] };
  if (next.game) {
    const g = { ...next.game };
    const drop = (obj) => { if (!obj) return obj; const o = { ...obj }; delete o[id]; return o; };
    g.per = drop(g.per);
    g.answers = drop(g.answers);
    g.prev = drop(g.prev);
    g.results = drop(g.results);
    g.roundWinners = (g.roundWinners || []).filter((x) => x !== id);
    if (g.disco) g.disco = { ...g.disco, choices: drop(g.disco.choices), times: drop(g.disco.times), placed: drop(g.disco.placed) };
    g.winners = (g.winners || []).filter((x) => x !== id);
    if (g.winLines) g.winLines = drop(g.winLines);
    next.game = g;
    // the snelste of this round may have been the one who goes: rebuild the round without them
    if (g.kind === 'disco' && next.phase === 'revealed' && g.prev && g.results) return applyResults(next);
  }
  return next;
}

/** Cards that can be played: a year, and (for the host's player) an id. */
export function playableCards(cards) {
  return (cards || []).filter((c) => c && c.id != null && Number.isFinite(Number(c.year)));
}

/**
 * Start a game with everybody in the room. `cards`: full deck cards (id, year, title, artist,
 * previewUrl ...); they are kept in the state so a reload can go on even when the deck changes.
 */
export function startGame(room, { cards, seed = Date.now(), now = Date.now(), pool = null }) {
  if (!room.players.length) throw new GameError('empty', 'Er doet nog niemand mee.');
  const valid = playableCards(cards).map((c) => ({ ...c, id: String(c.id), year: Number(c.year) }));
  const { game: kind, size, goal } = room.settings;
  if (kind === 'quiz') return startQuiz(room, valid, seed, now, pool);
  if (kind === 'disco' && valid.length < DISCO_MIN_SONGS) throw new GameError('deck', `Voor Discobingo zijn minstens ${DISCO_MIN_SONGS} nummers nodig.`);
  if (valid.length < room.players.length + 2) throw new GameError('deck', 'Er staan te weinig kaarten in het deck.');
  const rand = seededRandom(seed >>> 0);
  const songs = Object.fromEntries(valid.map((c) => [c.id, c]));
  const pile = shuffle(valid.map((c) => c.id), rand);
  const per = {};
  if (kind === 'bingo') {
    const seen = new Set();
    for (const p of room.players) {
      let card;
      for (let guard = 0; guard < 500; guard++) {
        card = generateCard(size, rand);
        if (!seen.has(cardSignature(card))) break;
      }
      seen.add(cardSignature(card));
      per[p.id] = { card, marks: Array(size * size).fill(null) };
    }
  } else if (kind === 'disco') {
    const seen = new Set();
    for (const p of room.players) {
      const card = uniqueDiscoCard(rand, seen);
      seen.add(discoSignature(card));
      per[p.id] = { card, marks: freshMarks(), ...freshFun() };
    }
  } else {
    for (const p of room.players) per[p.id] = { timeline: [pile.shift()] };
  }
  const game = {
    kind, seed: seed >>> 0, size: kind === 'disco' ? 5 : size, goal: kind === 'disco' ? null : goal, songs, pile, per,
    round: 0, current: null, answers: {}, results: null, prev: null,
    roundWinners: [], winners: [], winLines: {}, endedBy: null, joins: 0,
  };
  if (kind === 'disco') {
    game.disco = {
      win: room.settings.win, // the goal that counts now; a bingo may raise it (continueGame)
      stages: [], // goals already won: [{ win, winners: [ids], round }]
      ...freshBag(),
      cat: null, spunAt: null, choices: {},
      times: {}, seq: 0, judged: 0, fastest: null,
      placed: {}, placeSeq: 0, // the order in which chips were laid this round (who called bingo first)
      autoAt: null, hold: false, // the automatic reveal (server time) and "Wacht nog" for this round
    };
  }
  return startRound({ ...room, game, phase: 'answering' }, { now });
}

/** Draw the next song. Ends the game when the songs run out. */
export function startRound(room, { now = Date.now() } = {}) {
  const g = room.game;
  if (!g) throw new GameError('nogame', 'Er is geen spel bezig.');
  if (g.kind === 'quiz') return startQuizRound(room, now);
  if (!g.pile.length) return finishByPile(room);
  const pile = g.pile.slice();
  const current = pile.shift();
  const game = { ...g, pile, current, round: g.round + 1, answers: {}, results: null, prev: null, roundWinners: [], winLines: {} };
  if (g.kind === 'disco') game.disco = spinBall(g, now);
  return { ...room, phase: 'answering', game };
}

/**
 * Discobingo: the ball picks this round's category from the balanced bag, skipping a
 * category nobody who takes part has an open square of. `spunAt` (server time) lets a phone
 * that loads later skip the animation.
 */
function spinBall(g, now) {
  const usable = (cat) => Object.values(g.per).some((s) => openSquares(s.card, s.marks, cat).length > 0);
  const { cat, state } = drawCategory(g.disco, g.seed, usable);
  return {
    ...g.disco, bag: state.bag, last: state.last, fills: state.fills, drawn: state.drawn, cat, spunAt: now, choices: {}, times: {}, fastest: null,
    placed: {}, placeSeq: 0, autoAt: null, hold: false,
  };
}

/**
 * Fair start for somebody who joins a running game: as far as the player who is furthest
 * behind among those online now (`online`; everybody when nobody is or it is not given),
 * never close to winning. Bingo: a new card with that many squares stamped for
 * free, never more than size-2 in one line. Tijdlijn: that many cards from the pile.
 */
export function lateStart(room, pid, online = null) {
  const g = room.game;
  if (g.kind === 'quiz') { // a late player starts at 0 points
    const per = { ...g.per, [pid]: { score: 0, streak: 0, right: 0 } };
    const prev = g.prev ? { ...g.prev, [pid]: { score: 0, streak: 0, right: 0 } } : g.prev;
    return { ...room, game: { ...g, per, prev } };
  }
  const others = room.players.filter((p) => p.id !== pid && g.per[p.id]);
  // "furthest behind" among who is there now: a seat kept by somebody who left early does not
  // hold every late joiner back at nothing (nobody online: everybody counts)
  const here = online ? others.filter((p) => own(online, p.id)) : [];
  const ref = here.length ? here : others;
  const per = { ...g.per };
  const joins = (g.joins || 0) + 1;
  const rand = seededRandom((g.seed + joins * 7919) >>> 0);
  let pile = g.pile;
  if (g.kind === 'disco') {
    // a fresh card with as many free stamps as the one furthest behind (centre not counted)
    const card = uniqueDiscoCard(rand, new Set(others.map((p) => discoSignature(g.per[p.id].card))));
    const behind = ref.length ? Math.min(...ref.map((p) => stampedCount(g.per[p.id].marks))) : 0;
    per[pid] = { card, marks: lateMarks(behind, rand), ...freshFun() }; // no streak, no jokers: a fresh start
  } else if (g.kind === 'bingo') {
    const sigs = new Set(others.map((p) => cardSignature(g.per[p.id].card)));
    let card;
    for (let guard = 0; guard < 500; guard++) {
      card = generateCard(g.size, rand);
      if (!sigs.has(cardSignature(card))) break;
    }
    const marks = Array(g.size * g.size).fill(null);
    const behind = ref.length ? Math.min(...ref.map((p) => markCount(g.per[p.id].marks))) : 0;
    const cells = shuffle(marks.map((_, i) => i), rand);
    let given = 0;
    for (const i of cells) {
      if (given >= behind) break;
      marks[i] = FREE;
      if (bestLine(marks, g.size) > g.size - 2) { marks[i] = null; continue; }
      given++;
    }
    per[pid] = { card, marks };
  } else {
    const behind = ref.length ? Math.min(...ref.map((p) => g.per[p.id].timeline.length)) : 1;
    const n = Math.max(1, Math.min(behind, g.goal - 2, pile.length));
    pile = pile.slice();
    const timeline = pile.splice(0, n).sort((a, b) => g.songs[a].year - g.songs[b].year);
    per[pid] = { timeline };
  }
  const prev = g.prev ? { ...g.prev, [pid]: clonePer(per[pid]) } : g.prev;
  return { ...room, game: { ...g, per, pile, prev, joins } };
}

// Discobingo's streak, jokers and statistics travel with the card (a stored room without them gets zeros)
const clonePer = (s) => (s.card
  ? { card: s.card, marks: s.marks.slice(), ...(s.stats || s.streak != null || s.jokers != null ? discoFun(s) : {}) }
  : s.timeline ? { timeline: s.timeline.slice() } : { ...s });

const freshFun = () => ({ streak: 0, jokers: 0, stats: freshStats() });

/** Discobingo: a player's streak, jokers and statistics, cleaned (missing = 0; jokers never above the cap). */
export function discoFun(s) {
  const n = (v, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : 0);
  return { streak: n(s?.streak, 100000), jokers: n(s?.jokers, JOKER_CAP), stats: cleanStats(s?.stats) };
}

/**
 * Check and normalise an answer. Bingo: {pass: true} or {index, guess?, text?};
 * Tijdlijn: {slot}. Throws GameError 'answer' when it is not a valid answer right now.
 */
export function normalizeAnswer(room, pid, answer) {
  const g = room.game;
  if (!g || room.phase !== 'answering') throw new GameError('late', 'Je kunt nu niet (meer) antwoorden.');
  const mine = own(g.per, pid);
  if (!mine) throw new GameError('answer', 'Je doet niet mee aan dit spel.');
  const a = answer && typeof answer === 'object' ? answer : {};
  if (g.kind === 'disco') return normalizeDiscoAnswer(g, a);
  if (g.kind === 'bingo') {
    if (a.pass === true) return { pass: true };
    const index = Number(a.index);
    if (!Number.isInteger(index) || index < 0 || index >= mine.card.length) throw new GameError('answer', 'Kies een vakje.');
    if (mine.marks[index] != null) throw new GameError('answer', 'Dat vakje is al afgestempeld.');
    const key = mine.card[index];
    if (key === 'year') {
      const guess = parseYearGuess(a.guess);
      if (guess == null) throw new GameError('answer', 'Vul een jaartal in (vier cijfers).');
      return { index, guess };
    }
    if (key === 'artist' || key === 'title') {
      const text = String(a.text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      if (!text) throw new GameError('answer', key === 'artist' ? 'Typ de artiest.' : 'Typ de titel.');
      return { index, text };
    }
    return { index };
  }
  const slot = Number(a.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > mine.timeline.length) throw new GameError('answer', 'Kies een plek in je tijdlijn.');
  return { slot };
}

const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** Discobingo: {pass: true}, or by the round's category {guess} (a year: Jaartal and Exact jaar) or {text}. */
function normalizeDiscoAnswer(g, a) {
  if (a.pass === true) return { pass: true };
  const cat = g.disco.cat;
  if (cat === 'year' || cat === 'exact') {
    const guess = parseYearGuess(a.guess);
    if (guess == null) throw new GameError('answer', 'Vul een jaartal in (vier cijfers).');
    return { guess };
  }
  const text = cleanText(a.text);
  if (!text) throw new GameError('answer', cat === 'artist' ? 'Typ de artiest of band.' : 'Typ de titel.');
  return { text };
}

/** Store (or replace) a player's answer for the running round. */
export function submitAnswer(room, pid, answer, { now = Date.now() } = {}) {
  if (room.game?.kind === 'quiz') return submitQuizAnswer(room, pid, answer, now);
  const a = normalizeAnswer(room, pid, answer);
  const g = room.game;
  if (g.kind === 'disco') {
    // the server's time of the final answer (for "snelste"), kept apart from the answer itself:
    // the answer goes back to its phone, the time goes to nobody. `n` orders answers of the same ms.
    const seq = (g.disco.seq || 0) + 1;
    const disco = { ...g.disco, seq, times: { ...(g.disco.times || {}), [pid]: { at: Number(now) || 0, n: seq } } };
    return { ...room, game: { ...g, answers: { ...g.answers, [pid]: a }, disco } };
  }
  return { ...room, game: { ...g, answers: { ...g.answers, [pid]: a } } };
}

/** Take an answer back (still allowed until the reveal). */
export function withdrawAnswer(room, pid) {
  if (room.phase !== 'answering' || !own(room.game?.answers, pid)) return room;
  if (room.game.kind === 'quiz') throw new GameError('final', 'In de quiz kun je je antwoord niet meer wijzigen.');
  const answers = { ...room.game.answers };
  delete answers[pid];
  if (room.game.kind === 'disco' && room.game.disco.times) {
    const times = { ...room.game.disco.times };
    delete times[pid];
    return { ...room, game: { ...room.game, answers, disco: { ...room.game.disco, times } } };
  }
  return { ...room, game: { ...room.game, answers } };
}

/** Everybody who takes part in the running game has answered. */
export function allAnswered(room, ids = room.players.map((p) => p.id)) {
  const g = room.game;
  if (!g || room.phase !== 'answering') return false;
  const active = ids.filter((id) => g.per[id]);
  return active.length > 0 && active.every((id) => g.answers[id]);
}

/** Judge one answer against the current song (before any host override). */
export function judgeAnswer(game, pid, answer) {
  const song = game.songs[game.current];
  const mine = game.prev?.[pid] || game.per[pid];
  if (!answer) return { none: true, correct: false };
  if (game.kind === 'disco') return judgeDisco(game, song, answer);
  if (game.kind === 'bingo') {
    if (answer.pass) return { pass: true, correct: false };
    const key = mine.card[answer.index];
    if (key === 'artist' || key === 'title') {
      const m = key === 'artist' ? matchArtist(answer.text, song.artist) : matchTitle(answer.text, song.title);
      return { key, index: answer.index, text: answer.text, correct: m.ok, typed: true, doubt: m.doubt, auto: m.ok };
    }
    const correct = checkSquare(key, song.year, key === 'year' ? answer.guess : null) === true;
    return { key, index: answer.index, ...(key === 'year' ? { guess: answer.guess } : {}), correct };
  }
  const years = mine.timeline.map((id) => game.songs[id].year);
  return {
    slot: answer.slot,
    correct: isCorrectPlacement(years, answer.slot, song.year),
    correctSlots: correctSlots(years, song.year),
  };
}

/**
 * Discobingo: `auto` is the machine's verdict ('right' | 'doubt' | 'wrong', a doubt only for
 * typed answers), `verdict` the one that counts now (the host may decide a doubt or flip it).
 */
function judgeDisco(game, song, answer) {
  if (answer.pass) return { pass: true, correct: false, verdict: null };
  const cat = game.disco.cat;
  let auto;
  const r = { cat };
  // Exact jaar: the machine decides, never a doubt (no margin at all)
  if (cat === 'exact') { r.guess = answer.guess; auto = exactRight(answer.guess, song.year) ? 'right' : 'wrong'; }
  else if (cat === 'year') { r.guess = answer.guess; auto = yearRight(answer.guess, song.year) ? 'right' : 'wrong'; }
  else {
    r.text = answer.text;
    r.typed = true;
    auto = (cat === 'artist' ? artistVerdict(answer.text, song.artist) : titleVerdict(answer.text, song.title)).verdict;
  }
  return { ...r, auto, verdict: auto, correct: auto === 'right', doubt: auto === 'doubt', decided: false, overridden: false };
}

/** The host reveals the song: every answer is judged and the cards/timelines updated. */
export function reveal(room, { now = Date.now() } = {}) {
  if (room.phase !== 'answering') throw new GameError('phase', 'Er valt niets te onthullen.');
  const g = room.game;
  if (g.kind === 'quiz') return revealQuiz(room, now);
  const prev = Object.fromEntries(Object.entries(g.per).map(([id, s]) => [id, clonePer(s)]));
  const withPrev = { ...g, prev };
  const results = {};
  for (const id of Object.keys(g.per)) results[id] = judgeAnswer(withPrev, id, g.answers[id]);
  return applyResults({ ...room, phase: 'revealed', game: { ...withPrev, results } });
}

/** Rebuild this round's outcome from the snapshot taken at the reveal. */
function applyResults(room) {
  const g = room.game;
  if (g.kind === 'disco') return applyDisco(room);
  const per = {};
  const roundWinners = [];
  const winLines = {};
  for (const [id, before] of Object.entries(g.prev)) {
    const s = clonePer(before);
    const r = g.results[id];
    if (r?.correct) {
      if (g.kind === 'bingo') s.marks[r.index] = g.current;
      else s.timeline.splice(r.slot, 0, g.current);
    }
    per[id] = s;
    if (g.kind === 'bingo') {
      const line = r?.correct ? findBingo(s.marks, g.size) : null;
      if (line) { roundWinners.push(id); winLines[id] = line; }
    } else if (r?.correct && s.timeline.length >= g.goal) roundWinners.push(id);
  }
  return { ...room, game: { ...g, per, roundWinners, winLines } };
}

/**
 * Discobingo: rebuild this round's outcome from the snapshot taken at the reveal (g.prev) and
 * the verdicts and choices as they are now, so a flip, a decided doubt, a moved chip, a player
 * who left or came back can never leave the cards, streaks, jokers or statistics adrift.
 */
function applyDisco(room) {
  const g = room.game;
  const fastest = fastestOf(g);
  const per = {};
  const roundWinners = [];
  const winLines = {};
  for (const id of Object.keys(g.prev)) {
    const o = discoOutcome(g, id, fastest);
    per[id] = o.state;
    // Bingo stop: this round's chip brought the player to the goal that counts now (also right
    // after continueGame raised it: a chip that made 2 lines at once is then the next bingo).
    // A card that already met the goal before this round never counts again.
    if (reachedGoal(o.state.marks, g.disco.win) && !reachedGoal(g.prev[id].marks, g.disco.win)) { roundWinners.push(id); winLines[id] = goalCells(o.state.marks, g.disco.win); }
  }
  // the first chip that made bingo first (the tv shows that one at once and adds the others)
  const placed = isObj(g.disco.placed) ? g.disco.placed : {};
  const at = (id) => (Number.isFinite(own(placed, id)) ? placed[id] : 0);
  roundWinners.sort((a, b) => at(a) - at(b));
  return { ...room, game: { ...g, per, roundWinners, winLines, disco: { ...g.disco, fastest } } };
}

/** Discobingo: is the game in a bingo stop (revealed, and somebody meets the goal that counts now)? */
export const inBingoStop = (room) => room?.game?.kind === 'disco' && room.phase === 'revealed' && (room.game.roundWinners || []).length > 0;

/**
 * Discobingo: one player's round, from the snapshot `g.prev[id]`. Right: the streak grows and
 * a streak of 3, 6, 9 ... earns a joker (unless 2 are in hand already; usable at once). An
 * undecided doubt keeps the streak as it was; anything else (wrong, pass, no answer, away)
 * ends it. The chip stamps the chosen square when it is open and of the round's colour, or of
 * another colour when a joker is available (that one is then spent). Returns
 * { state, stamped, earned, spent, available, right }.
 */
export function discoOutcome(g, id, fastest = g.disco?.fastest ?? null) {
  const before = g.prev[id];
  const f = discoFun(before);
  const r = own(g.results, id);
  const right = !!r?.correct;
  const open = r?.verdict === 'doubt';
  const streak = right ? f.streak + 1 : open ? f.streak : 0;
  const earned = right && streak % JOKER_EVERY === 0 && f.jokers < JOKER_CAP;
  const available = f.jokers + (earned ? 1 : 0);
  const marks = before.marks.slice();
  const at = own(g.disco.choices, id);
  let stamped = null;
  let spent = false;
  if (right && Number.isInteger(at) && at >= 0 && at < CELLS && marks[at] == null && before.card[at] !== CENTER_KEY) {
    if (before.card[at] === g.disco.cat) stamped = at;
    else if (available >= 1) { stamped = at; spent = true; }
  }
  if (stamped != null) marks[stamped] = g.current;
  const st = f.stats;
  const answered = !!r && !r.none && !r.pass;
  const stats = {
    answers: st.answers + (answered ? 1 : 0),
    right: st.right + (right ? 1 : 0),
    doubts: st.doubts + (r?.auto === 'doubt' ? 1 : 0),
    fastest: st.fastest + (fastest === id ? 1 : 0),
    best: Math.max(st.best, streak),
    jokersUsed: st.jokersUsed + (spent ? 1 : 0),
  };
  return { state: { card: before.card, marks, streak, jokers: available - (spent ? 1 : 0), stats }, stamped, earned, spent, available, right };
}

/**
 * Discobingo: who gets "⚡ Snelste" this round. The earliest right answer by the server's time
 * of the final answer (the same ms: the one that arrived first). The answers the machine judged
 * right come first; an answer the host made right (a doubt decided Goed, a wrong one flipped)
 * only gets it when no answer the machine judged right is left, and then the one made right
 * first: so a later decision of the host never takes the badge from somebody who had it.
 * An answer without a recorded time (a room stored before this existed) can not be the fastest.
 */
export function fastestOf(g) {
  if (g?.kind !== 'disco' || !g.results || !g.prev) return null;
  const times = isObj(g.disco.times) ? g.disco.times : {};
  const t = (id) => own(times, id);
  const ids = Object.keys(g.results).filter((id) => g.results[id]?.correct && own(g.prev, id) && Number.isFinite(t(id)?.at));
  const byTime = (a, b) => t(a).at - t(b).at || (t(a).n || 0) - (t(b).n || 0) || (a < b ? -1 : a > b ? 1 : 0);
  const machine = ids.filter((id) => g.results[id].auto === 'right').sort(byTime);
  if (machine.length) return machine[0];
  const seq = (id) => (Number.isFinite(g.results[id].rightSeq) ? g.results[id].rightSeq : Infinity);
  const host = ids.filter((id) => g.results[id].auto !== 'right').sort((a, b) => seq(a) - seq(b) || byTime(a, b));
  return host[0] ?? null;
}

/** Discobingo: the open squares of another colour a right player may put the chip on with a joker (none without one). */
export function jokerSquares(game, pid) {
  if (game?.kind !== 'disco' || !own(game.results, pid)?.correct || !own(game.prev, pid) || !Array.isArray(game.prev[pid]?.marks)) return [];
  if (discoOutcome(game, pid).available < 1) return [];
  const before = game.prev[pid];
  return before.card.map((k, i) => i).filter((i) => before.marks[i] == null && before.card[i] !== game.disco.cat && before.card[i] !== CENTER_KEY);
}

/**
 * Discobingo: everybody's statistics over the game and the awards they give (see party.js
 * discoAwards): for the winner screen. `toGo`: squares still needed for the goal.
 */
export function discoSummary(room) {
  const g = room.game;
  if (g?.kind !== 'disco') return { stats: [], awards: [] };
  const players = room.players.filter((p) => Array.isArray(own(g.per, p.id)?.marks)).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: avatarOf(p),
    stats: discoFun(g.per[p.id]).stats,
    winner: (g.winners || []).includes(p.id),
    toGo: squaresToGo(g.per[p.id].marks, g.disco.win),
  }));
  return { stats: players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, ...p.stats })), awards: discoAwards(players) };
}

/** The room as it goes into the owner's backup: during a question nobody gets the answer times. */
export function withoutAnswerTimes(room) {
  const g = room?.game;
  if (g?.kind !== 'disco' || room.phase !== 'answering' || !g.disco?.times) return room;
  return { ...room, game: { ...g, disco: { ...g.disco, times: {} } } };
}

/** Host overrules one verdict (typed Artiest/Titel answers, or any other answer in doubt). */
export function overrideResult(room, pid) {
  if (room.phase !== 'revealed') throw new GameError('phase', 'Je kunt alleen na de onthulling een oordeel omdraaien.');
  if (room.game.kind === 'quiz') throw new GameError('answer', 'In de quiz beslist de klok: er valt niets om te draaien.');
  const r = own(room.game.results, pid);
  if (!r || r.none || r.pass) throw new GameError('answer', 'Deze speler heeft geen antwoord om te beoordelen.');
  if (room.game.kind === 'disco') {
    if (r.verdict === 'doubt') throw new GameError('doubt', 'Twijfelgeval: kies Goed of Fout.');
    return judgeResult(room, pid, r.verdict !== 'right');
  }
  const flipped = { ...r, correct: !r.correct, overridden: !r.overridden };
  return applyResults({ ...room, game: { ...room.game, results: { ...room.game.results, [pid]: flipped } } });
}

/**
 * Discobingo: the host's verdict on one answer: Goed (`ok` true) or Fout. Decides a doubt,
 * or flips any other verdict, as often as wanted until the next round. Wrong takes this
 * round's stamp away; right lets the player choose a square.
 */
export function judgeResult(room, pid, ok) {
  if (room.phase !== 'revealed') throw new GameError('phase', 'Je kunt alleen na de onthulling een oordeel geven.');
  const g = room.game;
  if (g.kind !== 'disco') return overrideResult(room, pid);
  const r = own(g.results, pid);
  if (!r || r.none || r.pass) throw new GameError('answer', 'Deze speler heeft geen antwoord om te beoordelen.');
  const verdict = ok ? 'right' : 'wrong';
  const next = { ...r, verdict, correct: ok, decided: true, overridden: r.auto !== 'doubt' && verdict !== r.auto };
  // the order in which the host made answers right (for "snelste", see fastestOf); Goed on one
  // that is right already keeps its place
  let judged = g.disco.judged || 0;
  if (ok && !(r.correct && Number.isFinite(r.rightSeq))) next.rightSeq = ++judged;
  if (!ok) delete next.rightSeq;
  const choices = { ...g.disco.choices };
  if (!ok) delete choices[pid];
  return applyResults({ ...room, game: { ...g, results: { ...g.results, [pid]: next }, disco: { ...g.disco, choices, judged } } });
}

/** Discobingo: the squares a player may stamp this round (open squares of the category; none unless right). */
export function choosableSquares(game, pid) {
  const r = own(game?.results, pid);
  const before = own(game?.prev, pid);
  if (game?.kind !== 'disco' || !r?.correct || !Array.isArray(before?.card) || !Array.isArray(before?.marks)) return [];
  return openSquares(before.card, before.marks, game.disco.cat);
}

/**
 * Discobingo: a right player chooses (or moves) this round's stamp; `index` null takes the
 * choice back. With `joker` the chip may go on an open square of another colour too, when the
 * player has a joker (it is spent only while the chip lies there, see discoOutcome).
 */
export function stampSquare(room, pid, index, { joker = false } = {}) {
  const g = room.game;
  if (g?.kind !== 'disco') throw new GameError('answer', 'Dit kan alleen bij Discobingo.');
  if (room.phase !== 'revealed') throw new GameError('phase', 'Je kunt alleen na de onthulling een vakje afstempelen.');
  const r = own(g.results, pid);
  if (!r) throw new GameError('answer', 'Je doet niet mee aan dit spel.');
  if (r.verdict === 'doubt') throw new GameError('doubt', 'De spelleider kijkt nog naar je antwoord.');
  if (!r.correct) throw new GameError('answer', 'Alleen met een goed antwoord mag je een vakje afstempelen.');
  // a chip that made bingo is final (only the leader's verdict can still undo it, see judgeResult)
  if ((g.roundWinners || []).includes(pid)) throw new GameError('final', 'Je fiche maakte bingo: die ligt vast.');
  const choices = { ...g.disco.choices };
  if (index == null) delete choices[pid];
  else {
    const at = Number(index);
    if (!choosableSquares(g, pid).includes(at)) {
      if (!joker) throw new GameError('answer', `Kies een open vakje: ${categoryOf(g.disco.cat).short.toLowerCase()}.`);
      if (discoOutcome(g, pid).available < 1) throw new GameError('joker', 'Je hebt geen joker om in te zetten.');
      if (!jokerSquares(g, pid).includes(at)) throw new GameError('answer', 'Kies een open vakje.');
    }
    choices[pid] = at;
  }
  const placeSeq = (g.disco.placeSeq || 0) + 1;
  const placed = { ...(isObj(g.disco.placed) ? g.disco.placed : {}), [pid]: placeSeq };
  return applyResults({ ...room, game: { ...g, disco: { ...g.disco, choices, placed, placeSeq } } });
}

/** Discobingo: players whose verdict the host still has to give. */
export const undecided = (game) => (game?.kind === 'disco' && game.results
  ? Object.keys(game.results).filter((id) => game.results[id]?.verdict === 'doubt') : []);

/** Discobingo: right players who have not chosen a square yet (and have one to choose). */
export const stillChoosing = (game) => (game?.kind === 'disco' && game.results
  ? Object.keys(game.results).filter((id) => game.results[id]?.correct && !Number.isInteger(own(game.disco.choices, id)) && choosableSquares(game, id).length)
  : []);

/**
 * After a reveal: the next song (Bingo / Tijdlijn: the winner screen when somebody won this
 * round). Discobingo: a bingo stop has to be decided first (continueGame / finishGame); the
 * right answers without a chosen square get the best square automatically (the only moment
 * the app places a chip for somebody), and when that makes bingo the game stops there.
 */
export function nextRound(room, { now = Date.now() } = {}) {
  if (room.phase !== 'revealed') throw new GameError('phase', 'Onthul eerst het nummer.');
  const g = room.game;
  if (g.kind === 'quiz') return startQuizRound(room, now);
  if (g.kind === 'disco') {
    if (inBingoStop(room)) throw new GameError('bingo', 'Bingo! Kies eerst: doorgaan of stoppen.');
    const next = autoPlace(room);
    if (inBingoStop(next)) return next; // an automatic chip made bingo: the game stops here
    return startRound(next, { now });
  }
  if (g.roundWinners.length) {
    return { ...room, phase: 'won', game: { ...g, winners: g.roundWinners.slice(), endedBy: 'goal' } };
  }
  return startRound(room, { now });
}

/** Discobingo: refuse while doubts are open; then the best square for everybody who still chooses. */
function autoPlace(room) {
  const g = room.game;
  const open = undecided(g);
  if (open.length) throw new GameError('doubt', open.length === 1 ? 'Beslis eerst over het twijfelgeval.' : `Beslis eerst over de ${open.length} twijfelgevallen.`);
  const left = stillChoosing(g);
  if (!left.length) return room;
  const choices = { ...g.disco.choices };
  const placed = { ...(isObj(g.disco.placed) ? g.disco.placed : {}) };
  let placeSeq = g.disco.placeSeq || 0;
  for (const id of left) {
    choices[id] = bestSquare(g.prev[id].card, g.prev[id].marks, g.disco.cat, g.disco.win);
    placed[id] = ++placeSeq;
  }
  return applyResults({ ...room, game: { ...g, disco: { ...g.disco, choices, placed, placeSeq } } });
}

/** Discobingo: the stage just won ({ win, winners, round }), for the list of stages. */
const stageOf = (g) => ({ win: g.disco.win, winners: g.roundWinners.slice(), round: g.round });

/**
 * Discobingo, on a bingo stop: go on for a higher goal (`win`: 'line2' after 1 line, 'full'
 * after 1 or 2 lines). Cards and chips stay; the stage is recorded ("1 lijn: Anouk"). Who
 * still chooses gets the best square (as at the next round); when somebody then meets the
 * new goal, that is the next bingo stop at once, otherwise the next song starts.
 */
export function continueGame(room, win, { now = Date.now() } = {}) {
  const g = room.game;
  if (g?.kind !== 'disco') throw new GameError('answer', 'Dit kan alleen bij Discobingo.');
  if (!inBingoStop(room)) throw new GameError('phase', 'Er is geen bingo om op door te gaan.');
  if (!nextGoals(g.disco.win).includes(win)) throw new GameError('answer', g.disco.win === 'full' ? 'Na een volle kaart is het spel uit.' : 'Kies 2 lijnen of een volle kaart.');
  const open = undecided(g);
  if (open.length) throw new GameError('doubt', open.length === 1 ? 'Beslis eerst over het twijfelgeval.' : `Beslis eerst over de ${open.length} twijfelgevallen.`);
  const stages = [...(Array.isArray(g.disco.stages) ? g.disco.stages : []), stageOf(g)];
  let next = applyResults({ ...room, game: { ...g, disco: { ...g.disco, win, stages } } });
  next = autoPlace(next);
  if (inBingoStop(next)) return next;
  return startRound(next, { now });
}

/**
 * Discobingo, on a bingo stop: stop, to the prize ceremony. Who still chooses gets the best
 * square first (it may make them a winner of this bingo too); the winners are everybody who
 * won a stage, in order.
 */
export function finishGame(room) {
  if (room.game?.kind !== 'disco') throw new GameError('answer', 'Dit kan alleen bij Discobingo.');
  if (!inBingoStop(room)) throw new GameError('phase', 'Er is geen bingo: het spel loopt nog.');
  const next = autoPlace(room);
  const g = next.game;
  const stages = [...(Array.isArray(g.disco.stages) ? g.disco.stages : []), stageOf(g)];
  const winners = [...new Set(stages.flatMap((s) => s.winners))].filter((id) => own(g.per, id));
  return { ...next, phase: 'won', game: { ...g, winners, endedBy: 'goal', disco: { ...g.disco, stages } } };
}

/* ---------- Discobingo: the automatic reveal ---------- */

/**
 * Everybody who can answer has answered: the online players who take part (`online`
 * {id: true}; the same "everybody" as "x van y hebben geantwoord"), at least one of them.
 * Off when the lobby setting is off or the leader tapped "Wacht nog" this round.
 */
export function autoRevealDue(room, online = {}) {
  const g = room?.game;
  if (g?.kind !== 'disco' || room.phase !== 'answering' || room.settings?.autoReveal === false || g.disco?.hold) return false;
  const here = Object.keys(g.per).filter((id) => own(online, id));
  return here.length > 0 && here.every((id) => own(g.answers, id));
}

/**
 * Start or stop the shared countdown: `disco.autoAt` = the server time of the automatic reveal
 * (AUTO_REVEAL_MS after everybody answered, never before the ball has landed). Kept while the
 * condition holds (a changed answer restarts nothing); cleared as soon as it does not.
 */
export function armAutoReveal(room, now, online = {}) {
  const g = room?.game;
  if (g?.kind !== 'disco' || !g.disco) return room;
  const due = autoRevealDue(room, online);
  const cur = Number.isFinite(g.disco.autoAt) ? g.disco.autoAt : null;
  if (due && cur == null) {
    const landed = (Number(g.disco.spunAt) || 0) + SPIN_MS;
    return { ...room, game: { ...g, disco: { ...g.disco, autoAt: Math.max(now, landed) + AUTO_REVEAL_MS } } };
  }
  if (!due && cur != null) return { ...room, game: { ...g, disco: { ...g.disco, autoAt: null } } };
  return room;
}

/** Is the automatic reveal of the running round due now? */
export const autoRevealNow = (room, now, online = {}) => autoRevealDue(room, online) && Number.isFinite(room.game.disco.autoAt) && now >= room.game.disco.autoAt;

/** "Wacht nog": no automatic reveal in this round any more (the leader reveals by hand). */
export function holdAutoReveal(room) {
  const g = room.game;
  if (g?.kind !== 'disco' || room.phase !== 'answering') throw new GameError('phase', 'Er loopt geen vraag.');
  if (g.disco.hold) return room;
  return { ...room, game: { ...g, disco: { ...g.disco, hold: true, autoAt: null } } };
}

/** When the server must look at the room again for the automatic reveal, or null. */
export function discoNextEvent(room) {
  const g = room?.game;
  return g?.kind === 'disco' && room.phase === 'answering' && Number.isFinite(g.disco?.autoAt) ? g.disco.autoAt : null;
}

/**
 * A room stored before "Exact jaar" replaced "Decennium" (cards, the bag or the round with a
 * 'decade'): a game in progress can not go on with the new rules, so it goes back to the lobby
 * (players, settings and the room itself stay). Anything else comes back unchanged.
 */
export function migrateRoom(room) {
  const g = room?.game;
  if (!g || g.kind !== 'disco' || !isObj(g.disco)) return room;
  const old = (k) => OLD_CATEGORY_KEYS.includes(k);
  const cards = [...Object.values(isObj(g.per) ? g.per : {}), ...Object.values(isObj(g.prev) ? g.prev : {})];
  const stale = old(g.disco.cat) || old(g.disco.last) || (Array.isArray(g.disco.bag) && g.disco.bag.some(old))
    || cards.some((s) => Array.isArray(s?.card) && s.card.some(old));
  return stale ? { ...room, phase: 'lobby', game: null } : room;
}

export function scoreOf(game, pid) {
  const s = own(game?.per, pid);
  if (!s) return 0;
  if (game.kind === 'disco') return stampedCount(s.marks);
  if (s.card) return markCount(s.marks);
  return s.timeline ? s.timeline.length : Number(s.score) || 0;
}

/** Songs ran out: highest score wins (ties share). */
export function finishByPile(room) {
  const g = room.game;
  const ids = room.players.map((p) => p.id).filter((id) => g.per[id]);
  const best = Math.max(0, ...ids.map((id) => scoreOf(g, id)));
  const winners = ids.filter((id) => scoreOf(g, id) === best);
  return { ...room, phase: 'won', game: { ...g, current: null, winners, endedBy: g.kind === 'quiz' ? 'quiz' : 'pile', answers: {} } };
}

/* ---------- Quiz (room server only; the clock is the server's) ---------- */

/** pool: other songs for wrong artist / title answers (a quiz from the mix); default the quiz's own songs. */
function startQuiz(room, valid, seed, now, pool = null) {
  const { questions, qtype, think } = room.settings;
  if (valid.length < QUIZ_MIN_SONGS) throw new GameError('deck', `Voor de quiz zijn minstens ${QUIZ_MIN_SONGS} nummers nodig.`);
  const rand = seededRandom(seed >>> 0);
  const songs = Object.fromEntries(valid.map((c) => [c.id, c]));
  const total = Math.min(questions, valid.length);
  const pile = shuffle(valid.map((c) => c.id), rand).slice(0, total);
  const others = Array.isArray(pool) && pool.length
    ? shuffle(playableCards(pool), rand).slice(0, 400).map((c, i) => ({ id: `pool${i}`, title: String(c.title || ''), artist: String(c.artist || ''), year: Number(c.year) }))
    : null;
  const available = quizTypesFor(others ? [...valid, ...others] : valid);
  const types = questionTypes(qtype, total, available, rand);
  const per = Object.fromEntries(room.players.map((p) => [p.id, { score: 0, streak: 0, right: 0 }]));
  const game = {
    kind: 'quiz', seed: seed >>> 0, size: null, goal: null, songs, pile, per,
    round: 0, current: null, answers: {}, results: null, prev: null,
    roundWinners: [], winners: [], winLines: {}, endedBy: null, joins: 0,
    quiz: { total, think, qtype, types, available, pool: others, q: null, openedAt: null, startedAt: null, deadline: null, ranks: null, prevRanks: null, counts: null },
  };
  return startQuizRound({ ...room, game, phase: 'answering' }, now);
}

const quizScores = (g) => Object.fromEntries(Object.entries(g.per).map(([id, s]) => [id, s.score]));

/** The next question (or the podium after the last one). The clock waits for the music (startQuizClock). */
function startQuizRound(room, now) {
  const g = room.game;
  if (!g.pile.length) return finishByPile({ ...room, game: { ...g, quiz: { ...g.quiz, q: g.quiz.q, deadline: null } } });
  const pile = g.pile.slice();
  const current = pile.shift();
  const round = g.round + 1;
  const type = g.quiz.types[round - 1] || 'year';
  const q = makeQuestion(g.quiz.pool || Object.values(g.songs), g.songs[current], type, questionRand(g.seed, round));
  const scores = quizScores(g);
  // places before this question (to show who climbs); nothing to climb while everybody is level
  const prevRanks = new Set(Object.values(scores)).size > 1 ? quizRanks(scores) : null;
  return {
    ...room,
    phase: 'answering',
    game: {
      ...g, pile, current, round, answers: {}, results: null, prev: null, roundWinners: [], winLines: {},
      quiz: { ...g.quiz, q, openedAt: now, startedAt: null, deadline: null, prevRanks, counts: null },
    },
  };
}

/** The music plays (or the safety net): the thinking time starts now. */
export function startQuizClock(room, now = Date.now()) {
  const g = room.game;
  if (g?.kind !== 'quiz' || room.phase !== 'answering' || g.quiz.startedAt != null) return room;
  return { ...room, game: { ...g, quiz: { ...g.quiz, startedAt: now, deadline: now + g.quiz.think * 1000 } } };
}

function submitQuizAnswer(room, pid, answer, now) {
  const g = room.game;
  if (room.phase !== 'answering') throw new GameError('late', 'Je kunt nu niet (meer) antwoorden.');
  if (!own(g.per, pid)) throw new GameError('answer', 'Je doet niet mee aan deze quiz.');
  if (g.quiz.startedAt == null) throw new GameError('wait', 'Even wachten: de klok start zodra de muziek speelt.');
  if (now > g.quiz.deadline + QUIZ_GRACE_MS) throw new GameError('late', 'De tijd is om.');
  if (own(g.answers, pid)) throw new GameError('final', 'Je hebt al geantwoord; in de quiz kun je dat niet wijzigen.');
  const choice = Number(answer?.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= g.quiz.q.options.length) throw new GameError('answer', 'Kies een van de vier antwoorden.');
  return { ...room, game: { ...g, answers: { ...g.answers, [pid]: { choice, at: Math.min(now, g.quiz.deadline) } } } };
}

/** Is the question over: everybody who takes part and is online has answered, or the time is up? */
export function quizRoundOver(room, now, online = null) {
  const g = room.game;
  if (g?.kind !== 'quiz' || room.phase !== 'answering' || g.quiz.startedAt == null) return false;
  if (now > g.quiz.deadline + QUIZ_GRACE_MS) return true;
  const active = Object.keys(g.per).filter((id) => !online || online[id]);
  return active.length > 0 && active.every((id) => g.answers[id]);
}

/** When the server must look at the question again (clock start safety net, deadline), or null. */
export function quizNextEvent(room, fallbackMs) {
  const g = room.game;
  if (g?.kind !== 'quiz' || room.phase !== 'answering') return null;
  if (g.quiz.startedAt == null) return (g.quiz.openedAt || 0) + fallbackMs;
  return g.quiz.deadline + QUIZ_GRACE_MS + 1;
}

function revealQuiz(room, now) {
  const g = room.game;
  const q = g.quiz.q;
  const started = g.quiz.startedAt ?? now;
  const prev = Object.fromEntries(Object.entries(g.per).map(([id, s]) => [id, { ...s }]));
  const per = {};
  const results = {};
  const counts = q.options.map(() => 0);
  for (const [id, s] of Object.entries(g.per)) {
    const a = g.answers[id];
    if (!a) { results[id] = { none: true, correct: false, points: 0 }; per[id] = { ...s, streak: 0 }; continue; }
    counts[a.choice]++;
    const correct = a.choice === q.answer;
    const ms = Math.max(0, a.at - started);
    const points = correct ? quizPoints(ms, g.quiz.think, s.streak) : 0;
    results[id] = { choice: a.choice, correct, points, ms };
    per[id] = { score: s.score + points, streak: correct ? s.streak + 1 : 0, right: s.right + (correct ? 1 : 0) };
  }
  const ranks = quizRanks(Object.fromEntries(Object.entries(per).map(([id, s]) => [id, s.score])));
  return {
    ...room,
    phase: 'revealed',
    game: { ...g, per, prev, results, roundWinners: [], quiz: { ...g.quiz, ranks, counts, revealedAt: now } },
  };
}

/** Same players, new game (new cards / timelines). */
export function playAgain(room, opts) {
  return startGame({ ...room, game: null, phase: 'lobby' }, opts);
}

/** Stop the game and go back to the lobby (players stay). */
export function backToLobby(room) {
  return { ...room, phase: 'lobby', game: null };
}

/** Ranking of the running/finished game, best first. */
export function standings(room) {
  const g = room.game;
  if (!g) return [];
  return room.players
    .filter((p) => g.per[p.id])
    .map((p) => ({ id: p.id, name: p.name, score: scoreOf(g, p.id), winner: (g.winners || []).includes(p.id) || (room.phase === 'revealed' && g.roundWinners.includes(p.id)) }))
    .sort((a, b) => b.score - a.score);
}

/** Short Dutch description of an answer ("Jaren 80", "Jaar ±2: 1984", "plek 3"). */
export function describeAnswer(game, pid, answer, { forOwner = true } = {}) {
  if (!answer) return 'geen antwoord';
  if (answer.pass) return 'gepast';
  if (game.kind === 'quiz') return answer.choice != null ? `${LETTERS[answer.choice]}: ${game.quiz?.q?.options?.[answer.choice] ?? '?'}` : 'geen antwoord';
  if (game.kind === 'disco') {
    if (answer.guess != null) return `${game.disco?.cat === 'exact' ? 'Exact jaar' : 'Jaartal'}: ${answer.guess}`;
    const cat = categoryOf(game.disco?.cat);
    return answer.text != null ? `${cat ? cat.short : 'Antwoord'}: “${answer.text}”` : '?';
  }
  if (game.kind === 'bingo') {
    const mine = game.prev?.[pid] || game.per[pid];
    const key = mine?.card[answer.index];
    const sq = SQUARES[key];
    if (!sq) return '?';
    if (key === 'year') return `${sq.label}: ${answer.guess}`;
    if (key === 'artist' || key === 'title') return forOwner ? `${sq.label}: “${answer.text}”` : sq.label;
    return sq.label;
  }
  return `plek ${answer.slot + 1}`;
}

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/**
 * Discobingo: a stored or restored game must be one the views can render: valid cards,
 * marks of 25 known values, choices and results of players in the game.
 */
function isValidDisco(r, g) {
  const d = g.disco;
  if (!isObj(d) || !WINS.includes(d.win)) return false;
  if (d.stages != null && !(Array.isArray(d.stages) && d.stages.every((x) => isObj(x) && WINS.includes(x.win) && Array.isArray(x.winners)))) return false;
  if (!Array.isArray(d.bag) || !d.bag.every((k) => CATEGORY_KEYS.includes(k))) return false;
  if ((r.phase === 'answering' || r.phase === 'revealed') && !CATEGORY_KEYS.includes(d.cat)) return false;
  const ids = new Set(r.players.map((p) => p.id));
  const card = (s) => isObj(s) && isValidCard(s.card) && Array.isArray(s.marks) && s.marks.length === CELLS && s.marks[CENTER] != null
    && s.marks.every((m) => m === null || m === FREE || (typeof m === 'string' && Object.hasOwn(g.songs, m)));
  const ofPlayers = (o) => isObj(o) && Object.keys(o).every((id) => ids.has(id));
  if (!ofPlayers(g.per) || !Object.values(g.per).every(card)) return false;
  if (!ofPlayers(d.choices) || !Object.values(d.choices).every((i) => Number.isInteger(i) && i >= 0 && i < CELLS)) return false;
  // answer times (for "snelste"): optional, a room stored before them has none
  if (d.times != null && (!ofPlayers(d.times) || !Object.values(d.times).every((x) => isObj(x) && Number.isFinite(x.at)))) return false;
  if (d.fastest != null && !ids.has(d.fastest)) return false;
  if (g.answers != null && !ofPlayers(g.answers)) return false;
  if (r.phase === 'revealed' || (r.phase === 'won' && g.results)) {
    if (!ofPlayers(g.prev) || !Object.values(g.prev).every(card)) return false;
    if (!ofPlayers(g.results) || !Object.values(g.results).every((x) => isObj(x) && [undefined, null, 'right', 'wrong', 'doubt'].includes(x.verdict))) return false;
  }
  return true;
}

/** Shape check for a room restored from localStorage. */
export function isValidRoom(r) {
  if (!r || r.v !== 1 || typeof r.code !== 'string' || !Array.isArray(r.players) || !Array.isArray(r.removed)) return false;
  if (!['lobby', 'answering', 'revealed', 'won'].includes(r.phase)) return false;
  if (!r.players.every((p) => p && isSafeId(p.id) && typeof p.name === 'string')) return false;
  if (r.phase === 'lobby') return true;
  const g = r.game;
  if (!g || !GAMES.includes(g.kind) || !g.songs || !Array.isArray(g.pile) || !g.per) return false;
  if ((r.phase === 'answering' || r.phase === 'revealed') && !g.songs[g.current]) return false;
  if (r.phase === 'revealed' && (!g.results || !g.prev)) return false;
  if (g.kind === 'quiz') {
    const q = g.quiz;
    if (!q || !Number.isInteger(q.total) || !Number.isFinite(q.think) || !Array.isArray(q.types)) return false;
    if ((r.phase === 'answering' || r.phase === 'revealed') && (!q.q || !Array.isArray(q.q.options) || !Number.isInteger(q.q.answer))) return false;
    return Object.values(g.per).every((s) => s && Number.isFinite(s.score) && Number.isFinite(s.streak));
  }
  if (g.kind === 'disco') return isValidDisco(r, g);
  return Object.values(g.per).every((s) => (g.kind === 'bingo'
    ? Array.isArray(s.card) && Array.isArray(s.marks) && s.card.length === g.size * g.size && s.card.every((k) => SQUARES[k])
    : Array.isArray(s.timeline) && s.timeline.every((id) => g.songs[id])));
}

