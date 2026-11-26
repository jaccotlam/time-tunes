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
  stampedCount, reachedGoal, goalCells, openSquares, bestSquare, lateMarks, decadeOf, decadeLabel, decadesFor,
  yearRight, drawCategory, freshBag, normalizeWin, isValidCard, CENTER, WINS,
} from './disco.js';

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
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
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
  if (host) room.players.push({ id: String(host.id), name: cleanName(host.name, 'Spelleider'), host: true });
  return room;
}

export function normalizeSettings(s = {}) {
  return {
    game: GAMES.includes(s.game) ? s.game : 'bingo',
    size: SIZES.includes(Number(s.size)) ? Number(s.size) : DEFAULT_SIZE,
    goal: Math.max(MIN_GOAL, Math.min(MAX_GOAL, Math.round(Number(s.goal) || DEFAULT_GOAL))),
    ...normalizeQuizSettings(s),
    win: normalizeWin(s.win), // Discobingo: "Winnen met" 1 lijn / 2 lijnen / volle kaart
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
export function addPlayer(room, { id, name }, { online = null } = {}) {
  const pid = String(id || '');
  if (!pid || !isSafeId(pid)) throw new GameError('bad', 'Speler zonder id.');
  if (room.removed.includes(pid)) throw new GameError('removed', 'Je bent door de spelleider uit deze kamer gehaald.');
  const known = findPlayer(room, pid);
  if (known) {
    const n = cleanName(name, known.name);
    return n === known.name ? room : { ...room, players: room.players.map((p) => (p.id === pid ? { ...p, name: n } : p)) };
  }
  if (room.players.length >= MAX_ROOM_PLAYERS) throw new GameError('full', `Deze kamer is vol (${MAX_ROOM_PLAYERS} spelers).`);
  const player = { id: pid, name: uniqueName(room, cleanName(name, `Speler ${room.players.length + 1}`)) };
  let next = { ...room, players: [...room.players, player] };
  if (next.game) next = lateStart(next, pid, online);
  return next;
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
    if (g.disco) g.disco = { ...g.disco, choices: drop(g.disco.choices) };
    g.winners = (g.winners || []).filter((x) => x !== id);
    if (g.winLines) g.winLines = drop(g.winLines);
    next.game = g;
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
      per[p.id] = { card, marks: freshMarks() };
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
      win: room.settings.win,
      decades: decadesFor(valid.map((c) => c.year)),
      ...freshBag(),
      cat: null, spunAt: null, choices: {},
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
  return { ...g.disco, bag: state.bag, last: state.last, fills: state.fills, drawn: state.drawn, cat, spunAt: now, choices: {} };
}

/**
 * Fair start for somebody who joins a running game: as far as the player who is furthest
 * behind (never close to winning). Bingo: a new card with that many squares stamped for
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
    per[pid] = { card, marks: lateMarks(behind, rand) };
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

const clonePer = (s) => (s.card ? { card: s.card, marks: s.marks.slice() } : s.timeline ? { timeline: s.timeline.slice() } : { ...s });

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

/** Discobingo: {pass: true}, or by the round's category {decade}, {guess} (a year) or {text}. */
function normalizeDiscoAnswer(g, a) {
  if (a.pass === true) return { pass: true };
  const cat = g.disco.cat;
  if (cat === 'decade') {
    const decade = Number(a.decade);
    if (!g.disco.decades.includes(decade)) throw new GameError('answer', 'Kies een decennium.');
    return { decade };
  }
  if (cat === 'year') {
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
  return { ...room, game: { ...room.game, answers: { ...room.game.answers, [pid]: a } } };
}

/** Take an answer back (still allowed until the reveal). */
export function withdrawAnswer(room, pid) {
  if (room.phase !== 'answering' || !own(room.game?.answers, pid)) return room;
  if (room.game.kind === 'quiz') throw new GameError('final', 'In de quiz kun je je antwoord niet meer wijzigen.');
  const answers = { ...room.game.answers };
  delete answers[pid];
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
  if (cat === 'decade') { r.decade = answer.decade; auto = decadeOf(song.year) === answer.decade ? 'right' : 'wrong'; }
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
  const per = {};
  const roundWinners = [];
  const winLines = {};
  for (const [id, before] of Object.entries(g.prev)) {
    const s = clonePer(before);
    const r = g.results[id];
    if (g.kind === 'disco') {
      // a right answer stamps the square its player chose (if it is still a valid choice)
      const at = g.disco.choices?.[id];
      if (r?.correct && Number.isInteger(at) && s.card[at] === g.disco.cat && s.marks[at] == null) s.marks[at] = g.current;
      per[id] = s;
      if (r?.correct && s.marks[at] === g.current && reachedGoal(s.marks, g.disco.win)) { roundWinners.push(id); winLines[id] = goalCells(s.marks, g.disco.win); }
      continue;
    }
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
  const choices = { ...g.disco.choices };
  if (!ok) delete choices[pid];
  return applyResults({ ...room, game: { ...g, results: { ...g.results, [pid]: next }, disco: { ...g.disco, choices } } });
}

/** Discobingo: the squares a player may stamp this round (open squares of the category; none unless right). */
export function choosableSquares(game, pid) {
  const r = own(game?.results, pid);
  const before = own(game?.prev, pid);
  if (game?.kind !== 'disco' || !r?.correct || !Array.isArray(before?.card) || !Array.isArray(before?.marks)) return [];
  return openSquares(before.card, before.marks, game.disco.cat);
}

/** Discobingo: a right player chooses (or moves) this round's stamp; `index` null takes the choice back. */
export function stampSquare(room, pid, index) {
  const g = room.game;
  if (g?.kind !== 'disco') throw new GameError('answer', 'Dit kan alleen bij Discobingo.');
  if (room.phase !== 'revealed') throw new GameError('phase', 'Je kunt alleen na de onthulling een vakje afstempelen.');
  const r = own(g.results, pid);
  if (!r) throw new GameError('answer', 'Je doet niet mee aan dit spel.');
  if (r.verdict === 'doubt') throw new GameError('doubt', 'De spelleider kijkt nog naar je antwoord.');
  if (!r.correct) throw new GameError('answer', 'Alleen met een goed antwoord mag je een vakje afstempelen.');
  const choices = { ...g.disco.choices };
  if (index == null) delete choices[pid];
  else {
    const at = Number(index);
    if (!choosableSquares(g, pid).includes(at)) throw new GameError('answer', `Kies een open vakje: ${categoryOf(g.disco.cat).short.toLowerCase()}.`);
    choices[pid] = at;
  }
  return applyResults({ ...room, game: { ...g, disco: { ...g.disco, choices } } });
}

/** Discobingo: players whose verdict the host still has to give. */
export const undecided = (game) => (game?.kind === 'disco' && game.results
  ? Object.keys(game.results).filter((id) => game.results[id]?.verdict === 'doubt') : []);

/** Discobingo: right players who have not chosen a square yet (and have one to choose). */
export const stillChoosing = (game) => (game?.kind === 'disco' && game.results
  ? Object.keys(game.results).filter((id) => game.results[id]?.correct && !Number.isInteger(own(game.disco.choices, id)) && choosableSquares(game, id).length)
  : []);

/** After a reveal: to the winner screen when somebody won this round, otherwise the next song. */
export function nextRound(room, { now = Date.now() } = {}) {
  if (room.phase !== 'revealed') throw new GameError('phase', 'Onthul eerst het nummer.');
  let g = room.game;
  if (g.kind === 'quiz') return startQuizRound(room, now);
  if (g.kind === 'disco') {
    const open = undecided(g);
    if (open.length) throw new GameError('doubt', open.length === 1 ? 'Beslis eerst over het twijfelgeval.' : `Beslis eerst over de ${open.length} twijfelgevallen.`);
    // right answers without a chosen square: the best square, automatically
    const choices = { ...g.disco.choices };
    for (const id of stillChoosing(g)) choices[id] = bestSquare(g.prev[id].card, g.prev[id].marks, g.disco.cat, g.disco.win);
    room = applyResults({ ...room, game: { ...g, disco: { ...g.disco, choices } } });
    g = room.game;
  }
  if (g.roundWinners.length) {
    return { ...room, phase: 'won', game: { ...g, winners: g.roundWinners.slice(), endedBy: 'goal' } };
  }
  return startRound(room, { now });
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
    if (answer.decade != null) return decadeLabel(answer.decade).label;
    if (answer.guess != null) return `Jaartal: ${answer.guess}`;
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
  if (!isObj(d) || !WINS.includes(d.win) || !Array.isArray(d.decades) || !d.decades.every(Number.isInteger)) return false;
  if (!Array.isArray(d.bag) || !d.bag.every((k) => CATEGORY_KEYS.includes(k))) return false;
  if ((r.phase === 'answering' || r.phase === 'revealed') && !CATEGORY_KEYS.includes(d.cat)) return false;
  const ids = new Set(r.players.map((p) => p.id));
  const card = (s) => isObj(s) && isValidCard(s.card) && Array.isArray(s.marks) && s.marks.length === CELLS && s.marks[CENTER] != null
    && s.marks.every((m) => m === null || m === FREE || (typeof m === 'string' && Object.hasOwn(g.songs, m)));
  const ofPlayers = (o) => isObj(o) && Object.keys(o).every((id) => ids.has(id));
  if (!ofPlayers(g.per) || !Object.values(g.per).every(card)) return false;
  if (!ofPlayers(d.choices) || !Object.values(d.choices).every((i) => Number.isInteger(i) && i >= 0 && i < CELLS)) return false;
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

