// "Samen spelen": the host's game machine. Pure, no DOM, no network: the host's browser
// runs it and `npm test` checks it. Every function returns a new room object.
//
// Rhythm of a round: a song plays -> every player answers on their own phone
// ('answering') -> the host reveals ('revealed') -> next song, or the winner screen ('won').
// Two games: Bingo (claim one open square per song, or pass) and Tijdlijn (place the song
// in your own timeline). Players who complete a line / reach the goal in the same round
// share the win. Reuses the rules of logic.js and bingo.js.
import { seededRandom, shuffle, isCorrectPlacement, correctSlots, DEFAULT_GOAL } from '../logic.js';
import {
  generateCard, cardSignature, checkSquare, parseYearGuess, findBingo, markCount, bestLine,
  SQUARES, SIZES, DEFAULT_SIZE,
} from '../bingo.js';
import { matchArtist, matchTitle } from './match.js';

export const MAX_ROOM_PLAYERS = 12;
export const GAMES = ['bingo', 'timeline'];
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
  };
}

/** Change game settings (only between games). */
export function setSettings(room, patch) {
  if (room.phase !== 'lobby' && room.phase !== 'won') throw new GameError('busy', 'Het spel is al bezig.');
  return { ...room, settings: normalizeSettings({ ...room.settings, ...patch }) };
}

export const findPlayer = (room, id) => room.players.find((p) => p.id === id) || null;

/**
 * Somebody joins (or comes back). A known id keeps its place and stand; a new player who
 * arrives during a game gets a fair start (lateStart). Throws GameError 'removed' / 'full'.
 */
export function addPlayer(room, { id, name }) {
  const pid = String(id || '');
  if (!pid) throw new GameError('bad', 'Speler zonder id.');
  if (room.removed.includes(pid)) throw new GameError('removed', 'Je bent door de spelleider uit deze kamer gehaald.');
  const known = findPlayer(room, pid);
  if (known) {
    const n = cleanName(name, known.name);
    return n === known.name ? room : { ...room, players: room.players.map((p) => (p.id === pid ? { ...p, name: n } : p)) };
  }
  if (room.players.length >= MAX_ROOM_PLAYERS) throw new GameError('full', `Deze kamer is vol (${MAX_ROOM_PLAYERS} spelers).`);
  const player = { id: pid, name: uniqueName(room, cleanName(name, `Speler ${room.players.length + 1}`)) };
  let next = { ...room, players: [...room.players, player] };
  if (next.game) next = lateStart(next, pid);
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
export function startGame(room, { cards, seed = Date.now() }) {
  if (!room.players.length) throw new GameError('empty', 'Er doet nog niemand mee.');
  const valid = playableCards(cards).map((c) => ({ ...c, id: String(c.id), year: Number(c.year) }));
  const { game: kind, size, goal } = room.settings;
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
  } else {
    for (const p of room.players) per[p.id] = { timeline: [pile.shift()] };
  }
  const game = {
    kind, seed: seed >>> 0, size, goal, songs, pile, per,
    round: 0, current: null, answers: {}, results: null, prev: null,
    roundWinners: [], winners: [], winLines: {}, endedBy: null, joins: 0,
  };
  return startRound({ ...room, game, phase: 'answering' });
}

/** Draw the next song. Ends the game when the songs run out. */
export function startRound(room) {
  const g = room.game;
  if (!g) throw new GameError('nogame', 'Er is geen spel bezig.');
  if (!g.pile.length) return finishByPile(room);
  const pile = g.pile.slice();
  const current = pile.shift();
  return {
    ...room,
    phase: 'answering',
    game: { ...g, pile, current, round: g.round + 1, answers: {}, results: null, prev: null, roundWinners: [], winLines: {} },
  };
}

/**
 * Fair start for somebody who joins a running game: as far as the player who is furthest
 * behind (never close to winning). Bingo: a new card with that many squares stamped for
 * free, never more than size-2 in one line. Tijdlijn: that many cards from the pile.
 */
export function lateStart(room, pid) {
  const g = room.game;
  const others = room.players.filter((p) => p.id !== pid && g.per[p.id]);
  const per = { ...g.per };
  const joins = (g.joins || 0) + 1;
  const rand = seededRandom((g.seed + joins * 7919) >>> 0);
  let pile = g.pile;
  if (g.kind === 'bingo') {
    const sigs = new Set(others.map((p) => cardSignature(g.per[p.id].card)));
    let card;
    for (let guard = 0; guard < 500; guard++) {
      card = generateCard(g.size, rand);
      if (!sigs.has(cardSignature(card))) break;
    }
    const marks = Array(g.size * g.size).fill(null);
    const behind = others.length ? Math.min(...others.map((p) => markCount(g.per[p.id].marks))) : 0;
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
    const behind = others.length ? Math.min(...others.map((p) => g.per[p.id].timeline.length)) : 1;
    const n = Math.max(1, Math.min(behind, g.goal - 2, pile.length));
    pile = pile.slice();
    const timeline = pile.splice(0, n).sort((a, b) => g.songs[a].year - g.songs[b].year);
    per[pid] = { timeline };
  }
  const prev = g.prev ? { ...g.prev, [pid]: clonePer(per[pid]) } : g.prev;
  return { ...room, game: { ...g, per, pile, prev, joins } };
}

const clonePer = (s) => (s.card ? { card: s.card, marks: s.marks.slice() } : { timeline: s.timeline.slice() });

/**
 * Check and normalise an answer. Bingo: {pass: true} or {index, guess?, text?};
 * Tijdlijn: {slot}. Throws GameError 'answer' when it is not a valid answer right now.
 */
export function normalizeAnswer(room, pid, answer) {
  const g = room.game;
  if (!g || room.phase !== 'answering') throw new GameError('late', 'Je kunt nu niet (meer) antwoorden.');
  const mine = g.per[pid];
  if (!mine) throw new GameError('answer', 'Je doet niet mee aan dit spel.');
  const a = answer && typeof answer === 'object' ? answer : {};
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

/** Store (or replace) a player's answer for the running round. */
export function submitAnswer(room, pid, answer) {
  const a = normalizeAnswer(room, pid, answer);
  return { ...room, game: { ...room.game, answers: { ...room.game.answers, [pid]: a } } };
}

/** Take an answer back (still allowed until the reveal). */
export function withdrawAnswer(room, pid) {
  if (room.phase !== 'answering' || !room.game?.answers[pid]) return room;
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

/** The host reveals the song: every answer is judged and the cards/timelines updated. */
export function reveal(room) {
  if (room.phase !== 'answering') throw new GameError('phase', 'Er valt niets te onthullen.');
  const g = room.game;
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
  const r = room.game.results?.[pid];
  if (!r || r.none || r.pass) throw new GameError('answer', 'Deze speler heeft geen antwoord om te beoordelen.');
  const flipped = { ...r, correct: !r.correct, overridden: !r.overridden };
  return applyResults({ ...room, game: { ...room.game, results: { ...room.game.results, [pid]: flipped } } });
}

/** After a reveal: to the winner screen when somebody won this round, otherwise the next song. */
export function nextRound(room) {
  if (room.phase !== 'revealed') throw new GameError('phase', 'Onthul eerst het nummer.');
  const g = room.game;
  if (g.roundWinners.length) {
    return { ...room, phase: 'won', game: { ...g, winners: g.roundWinners.slice(), endedBy: 'goal' } };
  }
  return startRound(room);
}

export function scoreOf(game, pid) {
  const s = game?.per?.[pid];
  if (!s) return 0;
  return s.card ? markCount(s.marks) : s.timeline.length;
}

/** Songs ran out: highest score wins (ties share). */
export function finishByPile(room) {
  const g = room.game;
  const ids = room.players.map((p) => p.id).filter((id) => g.per[id]);
  const best = Math.max(0, ...ids.map((id) => scoreOf(g, id)));
  const winners = ids.filter((id) => scoreOf(g, id) === best);
  return { ...room, phase: 'won', game: { ...g, current: null, winners, endedBy: 'pile', answers: {} } };
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

/** Shape check for a room restored from localStorage. */
export function isValidRoom(r) {
  if (!r || r.v !== 1 || typeof r.code !== 'string' || !Array.isArray(r.players) || !Array.isArray(r.removed)) return false;
  if (!['lobby', 'answering', 'revealed', 'won'].includes(r.phase)) return false;
  if (!r.players.every((p) => p && typeof p.id === 'string' && typeof p.name === 'string')) return false;
  if (r.phase === 'lobby') return true;
  const g = r.game;
  if (!g || !GAMES.includes(g.kind) || !g.songs || !Array.isArray(g.pile) || !g.per) return false;
  if ((r.phase === 'answering' || r.phase === 'revealed') && !g.songs[g.current]) return false;
  if (r.phase === 'revealed' && (!g.results || !g.prev)) return false;
  return Object.values(g.per).every((s) => (g.kind === 'bingo'
    ? Array.isArray(s.card) && Array.isArray(s.marks) && s.card.length === g.size * g.size && s.card.every((k) => SQUARES[k])
    : Array.isArray(s.timeline) && s.timeline.every((id) => g.songs[id])));
}

