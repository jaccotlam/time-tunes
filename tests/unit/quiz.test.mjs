// Quiz (app/js/multi/quiz.js + the quiz part of game.js): questions with a seeded RNG
// (distractors, no doubles, a deck that is too small), points, the end of a question,
// joining late and the ranking with shared places.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeQuestion, yearOptions, quizTypesFor, questionTypes, quizPoints, quizRanks, normalizeQuizSettings,
  QUIZ_BASE, QUIZ_SPEED, QUIZ_STREAK_MAX, QUIZ_GRACE_MS,
} from '../../app/js/multi/quiz.js';
import * as G from '../../app/js/multi/game.js';
import { seededRandom } from '../../app/js/logic.js';

const deck = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, year: 1960 + i * 2, title: `Lied ${String.fromCharCode(65 + (i % 26))}${i}`, artist: `Artiest ${i % 12}` }));

test('jaarvraag: vier verschillende jaren, het goede erbij, nooit in de toekomst, afleiders op verschillende afstanden', () => {
  for (let seed = 1; seed < 200; seed++) {
    const r = seededRandom(seed);
    const opts = yearOptions(1984, r, 2026);
    assert.equal(opts.length, 4);
    assert.equal(new Set(opts).size, 4, 'nooit dubbel');
    assert.ok(opts.includes(1984));
    assert.deepEqual(opts, opts.slice().sort((a, b) => a - b), 'jaren op volgorde');
    const d = opts.filter((y) => y !== 1984).map((y) => Math.abs(y - 1984)).sort((a, b) => a - b);
    assert.ok(d[0] <= 3 && d[1] >= 4 && d[1] <= 8 && d[2] >= 9 && d[2] <= 15, `afstanden ${d}`);
  }
  for (let seed = 1; seed < 50; seed++) assert.ok(yearOptions(2025, seededRandom(seed), 2026).every((y) => y <= 2026), 'niet in de toekomst');
  const q = makeQuestion(deck, deck[5], 'year', seededRandom(3), 2026);
  assert.equal(q.type, 'year');
  assert.equal(q.options[q.answer], String(deck[5].year));
});

test('artiest- en titelvraag: het goede plus drie afleiders uit het deck, geen dubbelen, niet dezelfde artiest, liefst dezelfde periode', () => {
  for (let seed = 1; seed < 100; seed++) {
    const song = deck[10 + (seed % 10)];
    const a = makeQuestion(deck, song, 'artist', seededRandom(seed));
    assert.equal(a.type, 'artist');
    assert.equal(a.options[a.answer], song.artist);
    assert.equal(new Set(a.options).size, 4);
    assert.equal(a.options.filter((o) => o === song.artist).length, 1, 'geen afleider van dezelfde artiest');
    const t = makeQuestion(deck, song, 'title', seededRandom(seed));
    assert.equal(t.options[t.answer], song.title);
    assert.equal(new Set(t.options).size, 4);
    const years = t.options.map((o) => deck.find((c) => c.title === o).year);
    assert.ok(years.every((y) => Math.abs(y - song.year) <= 10), `afleiders uit ongeveer dezelfde periode (${years} bij ${song.year})`);
  }
  // the same seed gives the same question
  assert.deepEqual(makeQuestion(deck, deck[3], 'title', seededRandom(9)), makeQuestion(deck, deck[3], 'title', seededRandom(9)));
});

test('te klein deck: alleen jaarvragen', () => {
  const small = [
    { id: '1', year: 1980, title: 'Een', artist: 'X' }, { id: '2', year: 1981, title: 'Twee', artist: 'X' },
    { id: '3', year: 1982, title: 'Drie', artist: 'Y' }, { id: '4', year: 1983, title: 'Vier', artist: 'The Y' },
  ];
  assert.deepEqual(quizTypesFor(small), { year: true, artist: false, title: true });
  assert.equal(makeQuestion(small, small[0], 'artist', seededRandom(1)).type, 'year', 'artiestvraag wordt jaarvraag');
  const types = questionTypes('mix', 9, quizTypesFor(small), seededRandom(1));
  assert.ok(!types.includes('artist'));
  const mix = questionTypes('mix', 9, quizTypesFor(deck), seededRandom(2));
  for (const t of ['year', 'artist', 'title']) assert.equal(mix.filter((x) => x === t).length, 3, 'mix: om de beurt');
  assert.deepEqual(normalizeQuizSettings({ questions: 7, qtype: 'x', think: 99 }), { questions: 10, qtype: 'mix', think: 20 });
});

test('punten: goed = basis + snelheid, reeksbonus begrensd; ranglijst met gedeelde plek', () => {
  assert.equal(quizPoints(0, 20), QUIZ_BASE + QUIZ_SPEED);
  assert.equal(quizPoints(20000, 20), QUIZ_BASE);
  assert.equal(quizPoints(10000, 20), QUIZ_BASE + QUIZ_SPEED / 2);
  assert.ok(quizPoints(2000, 20) > quizPoints(15000, 20), 'sneller = meer');
  assert.equal(quizPoints(0, 20, 2) - quizPoints(0, 20, 0), 100);
  assert.equal(quizPoints(0, 20, 99) - quizPoints(0, 20, 0), QUIZ_STREAK_MAX);
  assert.deepEqual(quizRanks({ a: 900, b: 1500, c: 900, d: 0 }), { a: 2, b: 1, c: 2, d: 4 });
});

function quizRoom(players = ['p1', 'p2', 'p3'], settings = {}) {
  let r = G.createRoom({ code: 'ABCD', settings: { game: 'quiz', questions: 10, qtype: 'mix', think: 20, ...settings } });
  for (const id of players) r = G.addPlayer(r, { id, name: id.toUpperCase() });
  return r;
}

test('quizverloop: klok, één antwoord, te laat, punten, laat instappen, ronde-einde, podium', () => {
  const t0 = 1_000_000;
  let r = G.startGame(quizRoom(), { cards: deck, seed: 7, now: t0 });
  const g = r.game;
  assert.equal(g.kind, 'quiz');
  assert.equal(g.quiz.total, 10);
  assert.equal(g.pile.length, 9);
  assert.throws(() => G.submitAnswer(r, 'p1', { choice: 0 }, { now: t0 + 100 }), /klok start/, 'vóór de muziek: wachten');
  assert.equal(G.quizNextEvent(r, 6000), t0 + 6000, 'vangnet voor de klok');
  r = G.startQuizClock(r, t0 + 1000);
  assert.equal(r.game.quiz.deadline, t0 + 21000);
  assert.equal(G.startQuizClock(r, t0 + 5000).game.quiz.startedAt, t0 + 1000, 'de klok start maar één keer');
  const right = r.game.quiz.q.answer;
  const wrong = (right + 1) % 4;
  r = G.submitAnswer(r, 'p1', { choice: right }, { now: t0 + 2000 }); // fast and right
  assert.throws(() => G.submitAnswer(r, 'p1', { choice: wrong }, { now: t0 + 2500 }), /al geantwoord/, 'niet te wijzigen');
  assert.throws(() => G.withdrawAnswer(r, 'p1'), /niet meer wijzigen/);
  r = G.submitAnswer(r, 'p2', { choice: wrong }, { now: t0 + 3000 });
  assert.throws(() => G.submitAnswer(r, 'p3', { choice: right }, { now: t0 + 21000 + QUIZ_GRACE_MS + 1 }), /tijd is om/);
  assert.throws(() => G.submitAnswer(r, 'p3', { choice: 7 }, { now: t0 + 4000 }), /Kies/);
  assert.equal(G.quizRoundOver(r, t0 + 5000), false, 'p3 heeft nog niet geantwoord');
  assert.equal(G.quizRoundOver(r, t0 + 5000, { p1: true, p2: true }), true, 'wie offline is, wordt niet afgewacht');
  assert.equal(G.quizRoundOver(r, t0 + 21000 + QUIZ_GRACE_MS + 1), true, 'tijd om');
  // somebody joins halfway: 0 points, may answer
  r = G.addPlayer(r, { id: 'p4', name: 'Laat' });
  assert.deepEqual(r.game.per.p4, { score: 0, streak: 0, right: 0 });
  r = G.reveal(r, { now: t0 + 22000 });
  assert.equal(r.phase, 'revealed');
  assert.equal(r.game.results.p1.points, quizPoints(1000, 20, 0));
  assert.equal(r.game.results.p2.points, 0);
  assert.equal(r.game.results.p3.none, true);
  assert.equal(r.game.quiz.counts[right], 1);
  assert.equal(G.scoreOf(r.game, 'p1'), quizPoints(1000, 20, 0));
  assert.equal(r.game.quiz.ranks.p1, 1);
  assert.equal(r.game.quiz.ranks.p2, 2, 'gelijke stand (0) = gedeelde plek');
  assert.equal(r.game.quiz.ranks.p3, 2);
  assert.ok(G.isValidRoom(r));
  assert.throws(() => G.overrideResult(r, 'p1'), /klok/);
  // the other questions: p1 and p2 always right at the same speed -> streak bonus, p1 stays first
  let now = t0 + 30000;
  for (let i = 2; i <= 10; i++) {
    r = G.nextRound(r, { now });
    assert.equal(r.phase, 'answering');
    assert.equal(r.game.round, i);
    r = G.startQuizClock(r, now);
    for (const id of ['p1', 'p2']) r = G.submitAnswer(r, id, { choice: r.game.quiz.q.answer }, { now: now + 4000 });
    r = G.reveal(r, { now: now + 5000 });
    now += 30000;
  }
  assert.equal(r.game.results.p1.points, quizPoints(4000, 20, 9), 'reeksbonus');
  r = G.nextRound(r, { now });
  assert.equal(r.phase, 'won', 'na de laatste vraag: podium');
  assert.equal(r.game.endedBy, 'quiz');
  assert.deepEqual(r.game.winners, ['p1']);
  const st = G.standings(r);
  assert.equal(st[0].id, 'p1');
  // a fresh quiz with the same players
  r = G.playAgain(r, { cards: deck, seed: 8, now });
  assert.equal(r.phase, 'answering');
  assert.equal(r.game.per.p1.score, 0);
});

test('quiz met weinig nummers en gelijke winst', () => {
  const four = deck.slice(0, 4);
  assert.throws(() => G.startGame(quizRoom(), { cards: deck.slice(0, 3), seed: 1, now: 0 }), /minstens 4/);
  let r = G.startGame(quizRoom(['a', 'b']), { cards: four, seed: 1, now: 0 });
  assert.equal(r.game.quiz.total, 4, 'niet meer vragen dan nummers');
  for (let i = 0; i < 4; i++) {
    r = G.startQuizClock(r, i * 100000);
    for (const id of ['a', 'b']) r = G.submitAnswer(r, id, { choice: r.game.quiz.q.answer }, { now: i * 100000 + 1000 });
    r = G.reveal(r, { now: i * 100000 + 2000 });
    r = G.nextRound(r, { now: i * 100000 + 3000 });
  }
  assert.equal(r.phase, 'won');
  assert.deepEqual(r.game.winners.sort(), ['a', 'b'], 'gedeelde winst');
});
