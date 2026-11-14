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
import { describeAnswer, scoreOf, FREE } from './game.js';

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
  const mineState = g.per[pid];
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
  if (mineState) {
    if (g.kind === 'bingo') {
      game.mine = {
        card: mineState.card.slice(),
        // stamped squares show the year of the song that stamped them (never the running song before the reveal)
        marks: mineState.marks.map((m) => (m == null ? null : m === FREE ? FREE : g.songs[m]?.year ?? FREE)),
        winLine: g.winLines?.[pid] || null,
      };
    } else {
      game.mine = { timeline: mineState.timeline.map((id) => songInfo(g.songs[id])) };
    }
    if (room.phase === 'answering' && g.answers[pid]) game.answer = { ...g.answers[pid] };
  }
  if (revealed && g.current && g.results) {
    const r = g.results[pid] || null;
    game.reveal = {
      song: songInfo(g.songs[g.current]),
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
      })),
      roundWinners: g.roundWinners.map((id) => nameOf(room, id)),
    };
  }
  view.game = game;
  return view;
}

const nameOf = (room, id) => room.players.find((p) => p.id === id)?.name || '?';

/** Reconstruct the given answer from a judged result (for describeAnswer). */
export function answerFromResult(r) {
  if (!r || r.none) return null;
  if (r.pass) return { pass: true };
  if (r.slot != null) return { slot: r.slot };
  return { index: r.index, guess: r.guess, text: r.text };
}

/** Label of a bingo square for the UI. */
export const squareLabel = (key) => SQUARES[key]?.label || '?';
