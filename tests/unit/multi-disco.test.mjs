// Discobingo in the game machine (app/js/multi/game.js): rounds, answers by category, the
// host's verdicts (doubt, flips), choosing and moving the stamp, automatic placement,
// winners, late joiners, removing players, the pile running out and stored rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, addPlayer, removePlayer, setSettings, startGame, submitAnswer, withdrawAnswer, reveal, overrideResult,
  nextRound, judgeResult, stampSquare, choosableSquares, stillChoosing, undecided, standings, scoreOf, isValidRoom,
  describeAnswer, playAgain, GameError, PREFERRED_GAME, GAMES, SERVER_GAMES,
} from '../../app/js/multi/game.js';
import { viewFor } from '../../app/js/multi/protocol.js';
import {
  CENTER, LINES, openSquares, reachedGoal, stampedCount, bestSquare, bestLineCount, isValidCard, DISCO_MIN_SONGS,
} from '../../app/js/multi/disco.js';

const cards = Array.from({ length: 40 }, (_, i) => ({
  id: `s${String(i + 1).padStart(2, '0')}`, year: 1964 + i, title: `Geheime titel ${i + 1}`, artist: `Geheime artiest ${i + 1}`,
}));
const songOf = (r) => r.game.songs[r.game.current];

function discoRoom(names = ['Anouk', 'Bram', 'Cas'], settings = {}, deck = cards, seed = 11) {
  let r = createRoom({ code: 'ABCD', settings: { game: 'disco', ...settings } });
  names.forEach((n, i) => { r = addPlayer(r, { id: `p${i}`, name: n }); });
  return startGame(r, { cards: deck, seed, now: 1000 });
}

function rightAnswer(r) {
  const song = songOf(r);
  switch (r.game.disco.cat) {
    case 'decade': return { decade: Math.floor(song.year / 10) * 10 };
    case 'year': return { guess: song.year + 2 };
    case 'artist': return { text: song.artist.toUpperCase() };
    default: return { text: song.title };
  }
}
function wrongAnswer(r) {
  const song = songOf(r);
  switch (r.game.disco.cat) {
    case 'decade': return { decade: r.game.disco.decades.find((d) => d !== Math.floor(song.year / 10) * 10) };
    case 'year': return { guess: song.year + 3 };
    default: return { text: 'Iets totaal anders' };
  }
}
/** Reveal and go on until the round's category is a typed one. */
function untilTyped(r) {
  for (let i = 0; i < 8 && !['artist', 'title'].includes(r.game.disco.cat); i++) r = nextRound(reveal(r), { now: 2000 + i });
  assert.ok(['artist', 'title'].includes(r.game.disco.cat));
  return r;
}

test('instellingen: disco mag, "Winnen met" begrensd, oude standaard blijft bingo', () => {
  assert.ok(GAMES.includes('disco'));
  assert.deepEqual(SERVER_GAMES, ['quiz', 'disco']);
  assert.equal(PREFERRED_GAME, 'disco');
  let r = createRoom({ code: 'ABCD' });
  assert.equal(r.settings.game, 'bingo', 'zonder keuze (en voor oude kamers) blijft het bingo');
  assert.equal(r.settings.win, 'line1');
  r = setSettings(r, { game: 'disco', win: 'full' });
  assert.equal(r.settings.win, 'full');
  r = setSettings(r, { win: 'zeven' });
  assert.equal(r.settings.win, 'line1');
});

test('start: 25 nummers nodig, ieder een andere geldige kaart met de ster, de categorie getrokken', () => {
  let r = createRoom({ code: 'ABCD', settings: { game: 'disco' } });
  r = addPlayer(r, { id: 'p0', name: 'A' });
  assert.throws(() => startGame(r, { cards: cards.slice(0, DISCO_MIN_SONGS - 1), seed: 1 }), (e) => e instanceof GameError && e.code === 'deck' && /25/.test(e.message));
  r = discoRoom(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
  const sigs = new Set(Object.values(r.game.per).map((s) => s.card.join()));
  assert.equal(sigs.size, 12);
  for (const s of Object.values(r.game.per)) {
    assert.ok(isValidCard(s.card));
    assert.equal(s.marks[CENTER], '*');
  }
  assert.equal(r.phase, 'answering');
  assert.equal(r.game.round, 1);
  assert.ok(['decade', 'artist', 'year', 'title'].includes(r.game.disco.cat));
  assert.equal(r.game.disco.spunAt, 1000);
  assert.deepEqual(r.game.disco.decades, [1960, 1970, 1980, 1990, 2000]);
  const same = discoRoom(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
  assert.deepEqual(same.game.per, r.game.per, 'zelfde seed, zelfde kaarten');
});

test('antwoorden per categorie: controle, wijzigen tot de onthulling, weet ik niet', () => {
  let r = discoRoom();
  const tried = new Set();
  for (let round = 0; round < 12 && r.phase === 'answering'; round++) {
    const cat = r.game.disco.cat;
    tried.add(cat);
    if (cat === 'decade') {
      assert.throws(() => submitAnswer(r, 'p0', { decade: 1930 }), /decennium/);
      assert.throws(() => submitAnswer(r, 'p0', { text: 'x' }), /decennium/);
    } else if (cat === 'year') {
      assert.throws(() => submitAnswer(r, 'p0', { guess: '84' }), /vier cijfers/);
    } else {
      assert.throws(() => submitAnswer(r, 'p0', { text: '   ' }), /Typ de/);
    }
    r = submitAnswer(r, 'p0', wrongAnswer(r));
    r = submitAnswer(r, 'p0', rightAnswer(r));
    r = submitAnswer(r, 'p1', { pass: true });
    r = submitAnswer(r, 'p2', rightAnswer(r));
    r = withdrawAnswer(r, 'p2');
    assert.equal(r.game.answers.p2, undefined);
    r = reveal(r);
    assert.equal(r.game.results.p0.verdict, 'right', `${cat}: het laatste antwoord telt`);
    assert.equal(r.game.results.p1.pass, true);
    assert.equal(r.game.results.p2.none, true);
    assert.deepEqual(stillChoosing(r.game), choosableSquares(r.game, 'p0').length ? ['p0'] : []);
    r = nextRound(r, { now: 5000 + round });
  }
  assert.equal(tried.size, 4, 'alle vier categorieën geprobeerd');
});

test('stempelen: kiezen, verplaatsen tot de volgende ronde, automatisch op het beste vakje', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = submitAnswer(r, 'p1', rightAnswer(r));
  r = reveal(r);
  const cat = r.game.disco.cat;
  const open0 = choosableSquares(r.game, 'p0');
  assert.equal(open0.length, 6);
  assert.ok(open0.every((i) => r.game.per.p0.card[i] === cat));
  const wrongCat = r.game.per.p0.card.findIndex((k, i) => k !== cat && i !== CENTER);
  assert.throws(() => stampSquare(r, 'p0', wrongCat), /open vakje/);
  assert.throws(() => stampSquare(r, 'p0', CENTER), /open vakje/);
  r = stampSquare(r, 'p0', open0[0]);
  assert.equal(r.game.per.p0.marks[open0[0]], r.game.current);
  r = stampSquare(r, 'p0', open0[1]); // moved
  assert.equal(r.game.per.p0.marks[open0[0]], null, 'het oude vakje is weer open');
  assert.equal(r.game.per.p0.marks[open0[1]], r.game.current);
  assert.equal(stampedCount(r.game.per.p0.marks), 1);
  assert.deepEqual(stillChoosing(r.game), ['p1']);
  const auto = bestSquare(r.game.prev.p1.card, r.game.prev.p1.marks, cat, 'line1');
  const song1 = r.game.current;
  r = nextRound(r, { now: 9000 });
  assert.equal(r.game.prev, null);
  assert.equal(r.game.per.p1.marks[auto], song1, 'Bram automatisch op het beste vakje');
  assert.equal(stampedCount(r.game.per.p1.marks), 1);
  assert.equal(stampedCount(r.game.per.p0.marks), 1);
  assert.equal(r.game.disco.spunAt, 9000);
  assert.throws(() => stampSquare(r, 'p0', 0), /onthulling/, 'na de volgende ronde ligt de keuze vast');
});

test('twijfel: telefoon wacht, volgende ronde geblokkeerd, Goed/Fout beslist; omdraaien neemt het stempel af of geeft het', () => {
  let r = untilTyped(discoRoom(['Anouk', 'Bram', 'Cas']));
  const song = songOf(r);
  const target = r.game.disco.cat === 'artist' ? song.artist : song.title;
  r = submitAnswer(r, 'p0', { text: target.split(' ').slice(1).join(' ') }); // a word missing: doubt
  r = submitAnswer(r, 'p1', { text: 'Rammstein' });
  r = submitAnswer(r, 'p2', { text: target });
  r = reveal(r);
  assert.equal(r.game.results.p0.verdict, 'doubt');
  assert.equal(r.game.results.p0.auto, 'doubt');
  assert.equal(r.game.results.p1.verdict, 'wrong');
  assert.equal(r.game.results.p2.verdict, 'right');
  assert.deepEqual(undecided(r.game), ['p0']);
  assert.throws(() => stampSquare(r, 'p0', choosableSquares(r.game, 'p2')[0]), /kijkt nog/);
  assert.throws(() => nextRound(r), (e) => e.code === 'doubt' && /twijfelgeval/.test(e.message));
  assert.throws(() => overrideResult(r, 'p0'), (e) => e.code === 'doubt', 'een twijfelgeval: Goed of Fout, niet omdraaien');
  const v0 = viewFor(r, 'p0', {});
  assert.equal(v0.game.disco.waitingForHost, true);
  assert.deepEqual(v0.game.disco.choosable, []);
  assert.deepEqual(v0.game.disco.doubts, ['p0']);
  r = judgeResult(r, 'p0', true);
  assert.equal(r.game.results.p0.verdict, 'right');
  assert.equal(r.game.results.p0.decided, true);
  assert.deepEqual(undecided(r.game), []);
  const sq = choosableSquares(r.game, 'p0')[0];
  r = stampSquare(r, 'p0', sq);
  assert.equal(stampedCount(r.game.per.p0.marks), 1);
  // flip to wrong: the stamp goes; flip back: may choose again (the old choice is gone)
  r = overrideResult(r, 'p0');
  assert.equal(r.game.results.p0.verdict, 'wrong');
  assert.equal(stampedCount(r.game.per.p0.marks), 0, 'fout = stempel weg');
  assert.equal(r.game.disco.choices.p0, undefined);
  r = judgeResult(r, 'p0', true);
  assert.equal(stampedCount(r.game.per.p0.marks), 0);
  assert.ok(stillChoosing(r.game).includes('p0'), 'goed = mag weer kiezen');
  // flip a right one and a wrong one
  r = overrideResult(r, 'p1');
  assert.equal(r.game.results.p1.verdict, 'right');
  assert.equal(r.game.results.p1.overridden, true);
  r = stampSquare(r, 'p2', choosableSquares(r.game, 'p2')[0]);
  r = overrideResult(r, 'p2');
  assert.equal(stampedCount(r.game.per.p2.marks), 0);
  r = overrideResult(r, 'p2');
  assert.equal(r.game.results.p2.overridden, false, 'twee keer omdraaien = het oordeel van de machine');
  assert.throws(() => judgeResult(r, 'nobody', true), /geen antwoord/);
  r = nextRound(r, { now: 7000 });
  for (const id of ['p0', 'p1', 'p2']) assert.equal(stampedCount(r.game.per[id].marks), 1, `${id}: automatisch geplaatst`);
});

/** Put player `pid` one stamp away from a line, the open square being of category `cat`. */
function oneAway(r, pid, cat) {
  const s = r.game.per[pid];
  const sq = s.card.findIndex((k) => k === cat);
  const line = LINES.find((l) => l.includes(sq));
  const marks = s.marks.slice();
  for (const i of line) if (i !== sq && marks[i] == null) marks[i] = '*';
  return { room: { ...r, game: { ...r.game, per: { ...r.game.per, [pid]: { ...s, marks } } } }, sq };
}

test('winst: wie in dezelfde ronde het doel haalt deelt; BINGO al bij het kiezen; fout gedraaid = geen winst', () => {
  let r = discoRoom(['Anouk', 'Bram', 'Cas']);
  const cat = r.game.disco.cat;
  let a; let b;
  ({ room: r, sq: a } = oneAway(r, 'p0', cat));
  ({ room: r, sq: b } = oneAway(r, 'p1', cat));
  for (const id of ['p0', 'p1', 'p2']) r = submitAnswer(r, id, rightAnswer(r));
  r = reveal(r);
  assert.deepEqual(r.game.roundWinners, [], 'nog niets gekozen');
  r = stampSquare(r, 'p0', a);
  assert.deepEqual(r.game.roundWinners, ['p0'], 'BINGO zodra het gekozen vakje het doel haalt');
  assert.equal(viewFor(r, 'p0', {}).game.mine.bingo, true);
  assert.equal(viewFor(r, 'p0', {}).game.mine.goalCells.length, 5);
  r = overrideResult(r, 'p0');
  assert.deepEqual(r.game.roundWinners, []);
  r = overrideResult(r, 'p0');
  r = stampSquare(r, 'p0', a);
  // Bram does not choose: the automatic placement finds the winning square
  r = nextRound(r, { now: 8000 });
  assert.equal(r.phase, 'won');
  assert.deepEqual(r.game.winners.sort(), ['p0', 'p1']);
  assert.ok(reachedGoal(r.game.per.p1.marks, 'line1'));
  assert.equal(r.game.per.p1.marks[b] != null, true);
  assert.equal(r.game.endedBy, 'goal');
  const st = standings(r);
  assert.ok(st.find((x) => x.id === 'p0').winner && st.find((x) => x.id === 'p1').winner && !st.find((x) => x.id === 'p2').winner);
  const again = playAgain(r, { cards, seed: 12, now: 9000 });
  assert.equal(again.phase, 'answering');
  assert.equal(stampedCount(again.game.per.p0.marks), 0);
});

test('winnen met 2 lijnen en volle kaart', () => {
  let r = discoRoom(['Anouk'], { win: 'line2' });
  assert.equal(r.game.disco.win, 'line2');
  const cat = r.game.disco.cat;
  let sq;
  ({ room: r, sq } = oneAway(r, 'p0', cat));
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = stampSquare(reveal(r), 'p0', sq);
  assert.deepEqual(r.game.roundWinners, [], 'één lijn is niet genoeg');
  r = nextRound(r, { now: 2 });
  assert.equal(r.phase, 'answering');
  let f = discoRoom(['Anouk'], { win: 'full' });
  const s = f.game.per.p0;
  const open = s.card.findIndex((k) => k === f.game.disco.cat);
  f = { ...f, game: { ...f.game, per: { p0: { ...s, marks: s.marks.map((m, i) => (i === open ? null : '*')) } } } };
  f = submitAnswer(f, 'p0', rightAnswer(f));
  f = nextRound(reveal(f), { now: 3 });
  assert.equal(f.phase, 'won', 'volle kaart');
});

test('geen open vakje van die categorie: niets te stempelen; de bal slaat een onbruikbare categorie over', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  const cat = r.game.disco.cat;
  const fill = (s, k) => ({ ...s, marks: s.marks.map((m, i) => (s.card[i] === k ? '*' : m)) });
  r = { ...r, game: { ...r.game, per: { p0: fill(r.game.per.p0, cat), p1: r.game.per.p1 } } };
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = reveal(r);
  assert.deepEqual(choosableSquares(r.game, 'p0'), []);
  assert.equal(viewFor(r, 'p0', {}).game.disco.noSquare, true);
  assert.deepEqual(stillChoosing(r.game), []);
  r = nextRound(r, { now: 1 });
  // nobody has an open 'year' square any more: it never comes up
  const per = Object.fromEntries(Object.entries(r.game.per).map(([id, s]) => [id, fill(s, 'year')]));
  r = { ...r, game: { ...r.game, per } };
  const seen = [];
  for (let i = 0; i < 10; i++) { r = nextRound(reveal(r), { now: 10 + i }); seen.push(r.game.disco.cat); }
  assert.ok(!seen.includes('year'), seen.join());
});

test('laat instappen: nieuwe kaart met zoveel gratis vakjes als wie het verst achter ligt; verwijderen', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  for (let i = 0; i < 6; i++) {
    r = submitAnswer(r, 'p0', rightAnswer(r));
    r = submitAnswer(r, 'p1', rightAnswer(r));
    r = nextRound(reveal(r), { now: 100 + i });
    if (r.phase !== 'answering') break;
  }
  const behind = Math.min(stampedCount(r.game.per.p0.marks), stampedCount(r.game.per.p1.marks));
  assert.ok(behind >= 3);
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = reveal(r);
  r = addPlayer(r, { id: 'late', name: 'Laatkomer' });
  const s = r.game.per.late;
  assert.ok(isValidCard(s.card));
  assert.ok(!['p0', 'p1'].some((id) => r.game.per[id].card.join() === s.card.join()));
  assert.equal(stampedCount(s.marks), Math.min(stampedCount(r.game.prev.p0.marks), stampedCount(r.game.prev.p1.marks), stampedCount(r.game.per.p1.marks)));
  assert.ok(bestLineCount(s.marks) <= 3);
  assert.ok(r.game.prev.late, 'ook in de momentopname van deze ronde');
  r = stampSquare(r, 'p0', choosableSquares(r.game, 'p0')[0]);
  assert.equal(stampedCount(r.game.per.late.marks), stampedCount(s.marks), 'herberekenen houdt de gratis vakjes');
  assert.ok(viewFor(r, 'late', {}).game.mine.card.length === 25);
  // remove a player while their stamp choice is open
  r = removePlayer(r, 'p0');
  assert.equal(r.game.per.p0, undefined);
  assert.equal(r.game.disco.choices.p0, undefined);
  assert.equal(r.game.results.p0, undefined);
  r = nextRound(r, { now: 999 });
  assert.equal(r.phase, 'answering');
  assert.ok(isValidRoom(r));
});

test('nummers op: meeste gestempelde vakjes wint (gelijk = gedeeld), het midden telt niet', () => {
  let r = discoRoom(['Anouk', 'Bram'], {}, cards.slice(0, 25));
  let rounds = 0;
  while (r.phase === 'answering') {
    rounds++;
    if (rounds <= 2) r = submitAnswer(r, 'p0', rightAnswer(r));
    r = nextRound(reveal(r), { now: rounds });
  }
  assert.equal(rounds, 25);
  assert.equal(r.phase, 'won');
  assert.equal(r.game.endedBy, 'pile');
  assert.deepEqual(r.game.winners, ['p0']);
  assert.equal(scoreOf(r.game, 'p0'), 2);
  assert.equal(scoreOf(r.game, 'p1'), 0);
});

test('beschrijving, geldige kamer en weergave na de onthulling', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  assert.ok(isValidRoom(r));
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, disco: null } }));
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, per: { p0: { card: [], marks: [] } } } }));
  const g = r.game;
  assert.equal(describeAnswer({ ...g, disco: { ...g.disco, cat: 'decade' } }, 'p0', { decade: 1980 }), 'Jaren 80');
  assert.equal(describeAnswer({ ...g, disco: { ...g.disco, cat: 'year' } }, 'p0', { guess: 1984 }), 'Jaartal: 1984');
  assert.equal(describeAnswer({ ...g, disco: { ...g.disco, cat: 'artist' } }, 'p0', { text: 'Queen' }), 'Artiest: “Queen”');
  assert.equal(describeAnswer(g, 'p0', { pass: true }), 'gepast');
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = submitAnswer(r, 'p1', wrongAnswer(r));
  r = reveal(r);
  const v = viewFor(r, 'p1', {});
  const res = Object.fromEntries(v.game.reveal.results.map((x) => [x.id, x]));
  assert.equal(res.p0.verdict, 'right');
  assert.equal(res.p1.verdict, 'wrong');
  assert.equal(res.p0.cat, r.game.disco.cat);
  assert.ok(res.p0.label.length > 0);
  assert.equal(v.game.disco.mustChoose, false);
  assert.deepEqual(v.game.disco.pending, ['p0']);
  assert.deepEqual(viewFor(r, 'p0', {}).game.disco.choosable, openSquares(r.game.prev.p0.card, r.game.prev.p0.marks, r.game.disco.cat));
});
