// "Samen spelen": the messages between the host and the players. Pure, no DOM.
//
// Star shape: every player only talks to the host.
//   player -> host: hello {v, playerId, name, room}, answer {round, answer}, withdraw {round},
//                   leave {}, pong {}
//   host -> player: welcome {v, playerId}, state {view}, error {code, message}, ping {}
// The host sends every player only that player's own view (viewFor). Before the reveal the
// view holds nothing about the running song: no id, no title, artist or year. Answers are
// judged on the host.
import { SQUARES } from '../bingo.js';
import { describeAnswer, scoreOf, FREE, choosableSquares, undecided, stillChoosing, own } from './game.js';
import { PROMPTS } from './quiz.js';
import { decadeLabel, goalCells, completeLines, reachedGoal, stampedCount, bestLineCount, squaresToGo, SPIN_MS } from './disco.js';

/** Bump when old and new apps can not understand each other any more. */
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_CHARS = 64 * 1024;
const CLIENT_TYPES = ['hello', 'answer', 'withdraw', 'leave', 'pong'];
const HOST_TYPES = ['welcome', 'state', 'error', 'ping'];

/** Parse an incoming message (string or object). Returns null when it is not a valid message. */
export function parseMessage(raw, { from = 'player' } = {}) {
  let m = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_MESSAGE_CHARS) return null;
    try { m = JSON.parse(raw); } catch { return null; }
  }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;
  const types = from === 'player' ? CLIENT_TYPES : HOST_TYPES;
  return types.includes(m.t) ? m : null;
}

export const encode = (msg) => JSON.stringify(msg);

export function helloMessage({ playerId, name, room }) {
  return { t: 'hello', v: PROTOCOL_VERSION, playerId, name, room };
}

/** What the host answers to a hello from another protocol version. */
export function versionError(theirs) {
  const older = Number(theirs) < PROTOCOL_VERSION;
  return {
    t: 'error',
    code: 'version',
    v: PROTOCOL_VERSION,
    message: older
      ? 'Jouw app is ouder dan die van de spelleider. Ververs de pagina (of sluit de app en open hem opnieuw) en doe dan weer mee.'
      : 'De spelleider heeft een oudere versie van de app. Vraag de spelleider de pagina te verversen.',
  };
}

const songInfo = (s) => ({ year: s.year, artist: s.artist, title: s.title });

/**
 * The state one player gets to see. `presence`: {playerId: true|false} (online or not).
 * Nothing about the running song is in here until the host has revealed it.
 */
export function viewFor(room, pid, presence = {}) {
  const g = room.game;
  const me = room.players.find((p) => p.id === pid) || null;
  const revealed = room.phase === 'revealed' || (room.phase === 'won' && g?.results);
  const view = {
    v: PROTOCOL_VERSION,
    code: room.code,
    phase: room.phase,
    settings: { ...room.settings },
    you: me ? { id: me.id, name: me.name, host: !!me.host } : null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      host: !!p.host,
      online: p.id === pid ? true : !!presence[p.id],
      answered: room.phase === 'answering' && !!g?.answers[p.id],
      playing: !!g?.per[p.id],
      score: g ? scoreOf(g, p.id) : 0,
    })),
    game: null,
  };
  if (!g) return view;
  const mineState = own(g.per, pid);
  const game = {
    kind: g.kind,
    round: g.round,
    size: g.size,
    goal: g.goal,
    left: g.pile.length,
    mine: null,
    answer: null,
    reveal: null,
    winners: room.phase === 'won' ? g.winners.map((id) => nameOf(room, id)) : [],
    winnerIds: room.phase === 'won' ? g.winners.slice() : [],
    endedBy: room.phase === 'won' ? g.endedBy : null,
  };
  if (g.kind === 'quiz') {
    game.quiz = quizView(room, pid, revealed);
    if (mineState) game.mine = { score: mineState.score, streak: mineState.streak, right: mineState.right, rank: game.quiz.rankOf };
    delete game.quiz.rankOf;
  }
  if (g.kind === 'disco') game.disco = discoView(room, pid, revealed);
  if (mineState && g.kind !== 'quiz') {
    if (g.kind === 'disco') {
      game.mine = {
        card: mineState.card.slice(),
        // stamped squares show the year of the song that stamped them; '*' = free (centre, late start)
        marks: mineState.marks.map((m) => (m == null ? null : m === FREE ? FREE : g.songs[m]?.year ?? FREE)),
        goalCells: goalCells(mineState.marks, g.disco.win),
        lines: completeLines(mineState.marks).length,
        stamped: stampedCount(mineState.marks),
        bingo: reachedGoal(mineState.marks, g.disco.win),
        winLine: g.winLines?.[pid] || null,
      };
    } else if (g.kind === 'bingo') {
      game.mine = {
        card: mineState.card.slice(),
        // stamped squares show the year of the song that stamped them (never the running song before the reveal)
        marks: mineState.marks.map((m) => (m == null ? null : m === FREE ? FREE : g.songs[m]?.year ?? FREE)),
        winLine: g.winLines?.[pid] || null,
      };
    } else {
      game.mine = { timeline: mineState.timeline.map((id) => songInfo(g.songs[id])) };
    }
    if (room.phase === 'answering' && own(g.answers, pid)) game.answer = { ...g.answers[pid] };
  }
  if (revealed && g.current && g.results) {
    const r = own(g.results, pid) || null;
    const cur = g.songs[g.current];
    game.reveal = {
      // a song from the "Mix van de groep" says whose favourite it was (names only, after the reveal)
      song: Array.isArray(cur.by) && cur.by.length ? { ...songInfo(cur), by: cur.by.map(String).slice(0, 13) } : songInfo(cur),
      mine: r ? { ...r, label: describeAnswer(g, pid, answerFromResult(r)) } : null,
      // before the reveal: what the timeline / card looked like when you answered
      before: g.kind === 'timeline' && g.prev?.[pid] ? g.prev[pid].timeline.map((id) => songInfo(g.songs[id])) : null,
      results: room.players.filter((p) => g.results[p.id]).map((p) => ({
        id: p.id,
        name: p.name,
        correct: !!g.results[p.id].correct,
        none: !!g.results[p.id].none,
        pass: !!g.results[p.id].pass,
        label: describeAnswer(g, p.id, answerFromResult(g.results[p.id]), { forOwner: true }),
        ...(g.kind === 'disco' ? discoResult(g, p.id) : {}),
      })),
      roundWinners: g.roundWinners.map((id) => nameOf(room, id)),
    };
  }
  view.game = game;
  return view;
}

/**
 * The quiz part of a view: the question and its four answers (everybody may see those),
 * the clock (server time), how many answered; which answer is right only after the reveal.
 */
function quizView(room, pid, revealed) {
  const g = room.game;
  const Q = g.quiz;
  const q = Q.q;
  const ids = room.players.map((p) => p.id).filter((id) => g.per[id]);
  const scores = Object.fromEntries(ids.map((id) => [id, g.per[id].score]));
  const rankNow = Object.fromEntries(ids.map((id) => [id, 1 + ids.filter((o) => scores[o] > scores[id]).length]));
  const out = {
    round: g.round,
    total: Q.total,
    think: Q.think,
    qtype: Q.qtype,
    onlyYears: !Q.available?.artist && !Q.available?.title,
    type: q?.type || null,
    prompt: q ? PROMPTS[q.type] : '',
    options: q && room.phase !== 'won' ? q.options.slice() : [],
    startedAt: room.phase === 'answering' ? Q.startedAt : null,
    deadline: room.phase === 'answering' ? Q.deadline : null,
    answered: room.phase === 'answering' ? ids.filter((id) => g.answers[id]).length : 0,
    playing: ids.length,
    choice: room.phase === 'answering' && g.answers[pid] ? g.answers[pid].choice : null,
    reveal: null,
    ranking: null,
    rankOf: rankNow[pid] || null,
  };
  if (revealed || room.phase === 'won') {
    out.ranking = room.players.filter((p) => g.per[p.id]).map((p) => ({
      id: p.id,
      name: p.name,
      score: scores[p.id],
      rank: rankNow[p.id],
      prevRank: Q.prevRanks?.[p.id] ?? null,
      points: room.phase === 'revealed' ? g.results?.[p.id]?.points || 0 : 0,
      right: g.per[p.id].right || 0,
    })).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }
  if (revealed && room.phase === 'revealed' && q) {
    const r = g.results?.[pid];
    out.reveal = {
      answer: q.answer,
      counts: (Q.counts || q.options.map(() => 0)).slice(),
      mine: r ? { choice: r.choice ?? null, correct: !!r.correct, none: !!r.none, points: r.points || 0, rank: rankNow[pid], prevRank: Q.prevRanks?.[pid] ?? null } : null,
      last: g.round >= Q.total || !g.pile.length,
    };
  }
  return out;
}

/**
 * The Discobingo part of a view. The category is public from the start of the round; the
 * literal answers of others only come with the reveal (in reveal.results).
 */
function discoView(room, pid, revealed) {
  const g = room.game;
  const D = g.disco;
  const live = room.phase === 'answering' || room.phase === 'revealed';
  const shown = revealed && room.phase === 'revealed';
  const r = own(g.results, pid);
  // a card without marks (a broken state) is left out rather than breaking every view
  const ids = room.players.map((p) => p.id).filter((id) => Array.isArray(own(g.per, id)?.marks));
  return {
    cat: live ? D.cat : null,
    spin: g.round, // a new value = a new spin of the ball
    spunAt: live ? D.spunAt : null, // server time (compare with meta.now): an old spin is not animated again
    spinMs: SPIN_MS,
    win: D.win,
    decades: D.decades.map(decadeLabel),
    // after the reveal: my stamp choice and where I may put it
    choice: shown && Number.isInteger(own(D.choices, pid)) ? D.choices[pid] : null,
    choosable: shown ? choosableSquares(g, pid) : [],
    mustChoose: shown ? stillChoosing(g).includes(pid) : false,
    waitingForHost: shown && r?.verdict === 'doubt',
    noSquare: shown && !!r?.correct && !choosableSquares(g, pid).length,
    pending: shown ? stillChoosing(g) : [],
    doubts: shown ? undecided(g) : [],
    // everybody's progress (no song data in it)
    progress: ids.map((id) => {
      const m = g.per[id].marks;
      // toGo: squares still to stamp for the goal (0 = reached; 1 = "spannend")
      return { id, name: nameOf(room, id), stamped: stampedCount(m), lines: completeLines(m).length, best: bestLineCount(m), bingo: reachedGoal(m, D.win), toGo: squaresToGo(m, D.win) };
    }),
  };
}

/** Discobingo fields of one entry in reveal.results: the literal answer, the verdicts and the stamp. */
function discoResult(g, id) {
  const r = g.results[id];
  const at = own(g.disco.choices, id);
  const stamped = r.correct && Number.isInteger(at) && own(g.per, id)?.marks?.[at] === g.current ? at : null;
  return {
    cat: r.cat ?? g.disco.cat,
    verdict: r.verdict ?? null, // 'right' | 'wrong' | 'doubt' | null (no answer / pass)
    auto: r.auto ?? null,
    decided: !!r.decided,
    overridden: !!r.overridden,
    doubt: r.verdict === 'doubt',
    text: r.text ?? null,
    guess: r.guess ?? null,
    decade: r.decade ?? null,
    stamped,
    noSquare: !!r.correct && !choosableSquares(g, id).length,
  };
}

const nameOf = (room, id) => room.players.find((p) => p.id === id)?.name || '?';

/** Reconstruct the given answer from a judged result (for describeAnswer). */
export function answerFromResult(r) {
  if (!r || r.none) return null;
  if (r.pass) return { pass: true };
  if (r.slot != null) return { slot: r.slot };
  if (r.choice != null) return { choice: r.choice };
  if (r.decade != null) return { decade: r.decade };
  if (r.cat) return { guess: r.guess, text: r.text };
  return { index: r.index, guess: r.guess, text: r.text };
}

/** Label of a bingo square for the UI. */
export const squareLabel = (key) => SQUARES[key]?.label || '?';
