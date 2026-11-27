// Discobingo: squaresToGo (how many squares a player still needs for the goal), checked
// against a brute-force search, and the pure rules around a player who is away: nothing
// waits for them (automatic placement, the Quiz round end), a next game gives them a card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squaresToGo, reachedGoal, freshMarks, CENTER, CELLS, WINS, FREE_MARK } from '../../app/js/multi/disco.js';
import { seededRandom } from '../../app/js/logic.js';
import * as G from '../../app/js/multi/game.js';
import { viewFor } from '../../app/js/multi/protocol.js';

const marksWith = (cells) => { const m = freshMarks(); for (const i of cells) m[i] = 'x'; return m; };

/** Smallest number of extra stamps that reaches the goal, by trying every set up to `max` squares (-1: more). */
function bruteToGo(marks, win, max = 4) {
  const open = marks.map((m, i) => (m == null ? i : -1)).filter((i) => i >= 0);
  if (reachedGoal(marks, win)) return 0;
  const tryK = (k, from, chosen) => {
    if (chosen.length === k) { const m = marks.slice(); for (const i of chosen) m[i] = 'x'; return reachedGoal(m, win); }
    for (let n = from; n < open.length; n++) { chosen.push(open[n]); if (tryK(k, n + 1, chosen)) return true; chosen.pop(); }
    return false;
  };
  for (let k = 1; k <= max; k++) if (tryK(k, 0, [])) return k;
  return -1;
}

test('squaresToGo: lege kaart, middenster telt mee', () => {
  const m = freshMarks();
  assert.equal(m[CENTER], FREE_MARK);
  assert.equal(squaresToGo(m, 'line1'), 4, 'een lijn door het midden: 4 open');
  assert.equal(squaresToGo(m, 'line2'), 8, 'twee lijnen door het midden delen de ster');
  assert.equal(squaresToGo(m, 'full'), CELLS - 1);
  const none = Array(CELLS).fill(null);
  assert.equal(squaresToGo(none, 'line1'), 5);
  assert.equal(squaresToGo(none, 'line2'), 9, 'twee lijnen kruisen in één vakje');
  assert.equal(squaresToGo(none, 'full'), 25);
});

test('squaresToGo: overlappende lijnen tellen een gedeeld vakje één keer', () => {
  // row 0 has 4 of 5; the main diagonal shares cell 0 and holds the centre
  const m = marksWith([0, 1, 2, 3, 6, 18]);
  assert.equal(squaresToGo(m, 'line1'), 1);
  // row 0 (open: 4) + diagonal 0-6-12-18-24 (open: 24) = 2, nothing cheaper
  assert.equal(squaresToGo(m, 'line2'), 2);
  // one line complete: line1 = 0, line2 = the cheapest other line
  const one = marksWith([0, 1, 2, 3, 4]);
  assert.equal(squaresToGo(one, 'line1'), 0);
  assert.equal(squaresToGo(one, 'line2'), 3, 'een diagonaal of de middelste kolom: 3 open (ster en rij 0 delen)');
  // two complete lines
  const two = marksWith([0, 1, 2, 3, 4, 5, 10, 15, 20]);
  assert.equal(squaresToGo(two, 'line2'), 0);
  assert.ok(reachedGoal(two, 'line2'));
});

test('squaresToGo: volle kaart en bijna vol', () => {
  const full = Array(CELLS).fill('x');
  for (const w of WINS) assert.equal(squaresToGo(full, w), 0);
  const almost = full.slice();
  almost[7] = null;
  assert.equal(squaresToGo(almost, 'full'), 1);
  assert.equal(squaresToGo(almost, 'line1'), 0);
  assert.equal(squaresToGo(almost, 'line2'), 0);
});

test('squaresToGo = brute force, en 0 precies bij het doel (willekeurige kaarten)', () => {
  const rand = seededRandom(42);
  for (let n = 0; n < 400; n++) {
    const m = freshMarks();
    const stamps = 8 + Math.floor(rand() * 14);
    for (let k = 0; k < stamps; k++) m[Math.floor(rand() * CELLS)] = 'x';
    for (const win of WINS) {
      const t = squaresToGo(m, win);
      assert.equal(t === 0, reachedGoal(m, win), `0 <=> doel (${win})`);
      const b = bruteToGo(m, win);
      if (b >= 0) assert.equal(t, b, `${win}: ${m.map((x) => (x ? 1 : 0)).join('')}`);
      else assert.ok(t > 4);
    }
  }
});

// ---------- the machine with a player who is away ----------
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 30).map((year, i) => ({ id: `c${i + 1}`, year, title: `Titel ${i + 1}`, artist: `Artiest ${i + 1}` }));
function discoRoom() {
  let room = G.createRoom({ code: 'TEST', settings: { game: 'disco' } });
  for (const [id, name] of [['pA', 'Anouk'], ['pB', 'Bram'], ['pC', 'Cas']]) room = G.addPlayer(room, { id, name });
  return G.startGame(room, { cards, seed: 9, now: 1 });
}
function rightAnswer(room) {
  const g = room.game;
  const song = g.songs[g.current];
  const cat = g.disco.cat;
  return cat === 'exact' || cat === 'year' ? { guess: song.year } : { text: cat === 'artist' ? song.artist : song.title };
}

test('afwezig: een goed antwoord zonder gekozen vakje wordt bij "volgende" automatisch geplaatst', () => {
  let room = discoRoom();
  room = G.submitAnswer(room, 'pC', rightAnswer(room)); // Cas answers, then goes away (no stamp choice)
  room = G.reveal(room);
  assert.deepEqual(G.stillChoosing(room.game), ['pC']);
  const before = G.scoreOf(room.game, 'pC');
  room = G.nextRound(room, { now: 2 });
  assert.equal(room.phase, 'answering', 'niet geblokkeerd');
  assert.equal(G.scoreOf(room.game, 'pC'), before + 1, 'automatisch gestempeld');
  // the views show progress with toGo for everybody, also with Cas away (presence false)
  for (const who of ['pA', 'pC', '!spectator']) {
    const v = viewFor(room, who, { pA: true, pB: true });
    assert.equal(v.game.disco.progress.length, 3);
    for (const p of v.game.disco.progress) assert.ok(Number.isInteger(p.toGo) && p.toGo >= 0 && p.toGo <= 4);
    assert.equal(v.players.find((p) => p.id === 'pC').online, who === 'pC');
  }
});

test('afwezig: Quiz-ronde eindigt als iedereen die er is geantwoord heeft; volgende spel geeft ook de afwezige een kaart', () => {
  let room = G.createRoom({ code: 'TEST', settings: { game: 'quiz', questions: 5 } });
  for (const [id, name] of [['pA', 'Anouk'], ['pB', 'Bram'], ['pC', 'Cas']]) room = G.addPlayer(room, { id, name });
  room = G.startGame(room, { cards, seed: 2, now: 1 });
  room = G.startQuizClock(room, 10);
  room = G.submitAnswer(room, 'pA', { choice: 0 }, { now: 11 });
  room = G.submitAnswer(room, 'pB', { choice: 1 }, { now: 12 });
  assert.equal(G.quizRoundOver(room, 13, { pA: true, pB: true }), true, 'Cas is weg: niet wachten');
  assert.equal(G.quizRoundOver(room, 13, { pA: true, pB: true, pC: true }), false);
  // a finished disco game: playAgain deals everybody on the list a card, also who is away
  let d = discoRoom();
  d = { ...d, phase: 'won', game: { ...d.game, winners: ['pA'] } };
  const again = G.playAgain(d, { cards, seed: 4, now: 5 });
  assert.deepEqual(Object.keys(again.game.per).sort(), ['pA', 'pB', 'pC']);
});
