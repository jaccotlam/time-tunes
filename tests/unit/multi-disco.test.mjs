// Discobingo in the game machine (app/js/multi/game.js): rounds, answers by category, the
// host's verdicts (doubt, flips), choosing and moving the stamp, automatic placement,
// winners, the bingo stop (going on for 2 lines / a full card, or stopping), the automatic
// reveal, late joiners, removing players, the pile running out and stored rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, addPlayer, removePlayer, setSettings, startGame, submitAnswer, withdrawAnswer, reveal, overrideResult,
  nextRound, judgeResult, stampSquare, choosableSquares, stillChoosing, undecided, standings, scoreOf, isValidRoom,
  describeAnswer, playAgain, GameError, PREFERRED_GAME, GAMES, SERVER_GAMES,
  continueGame, finishGame, inBingoStop, autoRevealDue, armAutoReveal, autoRevealNow, holdAutoReveal, discoNextEvent, migrateRoom,
} from '../../app/js/multi/game.js';
import { viewFor } from '../../app/js/multi/protocol.js';
import {
  CENTER, LINES, openSquares, reachedGoal, stampedCount, bestSquare, bestLineCount, isValidCard, DISCO_MIN_SONGS,
  completeLines, SPIN_MS, AUTO_REVEAL_MS,
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
    case 'exact': return { guess: song.year };
    case 'year': return { guess: song.year + 2 };
    case 'artist': return { text: song.artist.toUpperCase() };
    default: return { text: song.title };
  }
}
function wrongAnswer(r) {
  const song = songOf(r);
  switch (r.game.disco.cat) {
    case 'exact': return { guess: song.year + 1 }; // one year off: wrong, no margin
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
  assert.equal(r.settings.autoReveal, true, 'automatisch naar het resultaat: standaard aan');
  r = setSettings(r, { game: 'disco', win: 'full' });
  assert.equal(r.settings.win, 'full');
  r = setSettings(r, { win: 'zeven' });
  assert.equal(r.settings.win, 'line1');
  r = setSettings(r, { autoReveal: false });
  assert.equal(r.settings.autoReveal, false);
  r = setSettings(r, { autoReveal: 'ja' });
  assert.equal(r.settings.autoReveal, true, 'alleen false zet het uit');
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
  assert.ok(['exact', 'artist', 'year', 'title'].includes(r.game.disco.cat));
  assert.equal(r.game.disco.spunAt, 1000);
  assert.equal(r.game.disco.decades, undefined, 'geen decennia meer');
  assert.deepEqual(r.game.disco.stages, []);
  assert.equal(r.game.disco.autoAt, null);
  const same = discoRoom(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
  assert.deepEqual(same.game.per, r.game.per, 'zelfde seed, zelfde kaarten');
});

test('antwoorden per categorie: controle, wijzigen tot de onthulling, weet ik niet', () => {
  let r = discoRoom();
  const tried = new Set();
  for (let round = 0; round < 12 && r.phase === 'answering'; round++) {
    const cat = r.game.disco.cat;
    tried.add(cat);
    if (cat === 'exact' || cat === 'year') {
      assert.throws(() => submitAnswer(r, 'p0', { guess: '84' }), /vier cijfers/);
      assert.throws(() => submitAnswer(r, 'p0', { decade: 1980 }), /vier cijfers/, 'een decennium is geen antwoord meer');
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
    if (cat === 'exact') assert.equal(r.game.results.p0.auto, 'right', 'exact jaar: de machine beslist');
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
  assert.ok(inBingoStop(r), 'bingo stopt het spel meteen');
  assert.throws(() => nextRound(r, { now: 8000 }), (e) => e.code === 'bingo', 'geen volgend nummer tijdens de bingostop');
  // Bram does not choose: stopping places his chip automatically, and it wins too
  r = finishGame(r);
  assert.equal(r.phase, 'won');
  assert.deepEqual(r.game.winners, ['p0', 'p1'], 'wie eerst bingo had eerst');
  assert.ok(reachedGoal(r.game.per.p1.marks, 'line1'));
  assert.equal(r.game.per.p1.marks[b] != null, true);
  assert.equal(r.game.endedBy, 'goal');
  assert.deepEqual(r.game.disco.stages, [{ win: 'line1', winners: ['p0', 'p1'], round: 1 }]);
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
  assert.ok(inBingoStop(f), 'volle kaart: het automatische fiche maakt bingo, het spel stopt');
  assert.throws(() => continueGame(f, 'full', { now: 4 }), (e) => e.code === 'answer' && /volle kaart/.test(e.message), 'na een volle kaart kan alleen stoppen');
  assert.deepEqual(viewFor(f, 'p0', {}).game.disco.bingo.next, []);
  f = finishGame(f);
  assert.equal(f.phase, 'won', 'volle kaart');
});

/** A card for `pid` with the given cells stamped (free marks) and everything else open. */
function withMarks(r, pid, cells) {
  const s = r.game.per[pid];
  const marks = s.marks.map((m, i) => (i === CENTER || cells.includes(i) ? '*' : null));
  return { ...r, game: { ...r.game, per: { ...r.game.per, [pid]: { ...s, marks } } } };
}
/** An open square of category `cat` on `pid`'s card and a line through it, the rest of that line stamped. */
function lineFor(r, pid, cat, avoid = []) {
  const s = r.game.per[pid];
  for (const l of LINES) {
    const cand = l.filter((i) => s.card[i] === cat && !avoid.includes(i));
    if (cand.length) return { line: l, sq: cand[0] };
  }
  return null;
}

test('bingostop: meteen, fiche ligt vast, oordeel omdraaien maakt het ongedaan, anderen mogen nog leggen', () => {
  let r = discoRoom(['Anouk', 'Bram', 'Cas']);
  const cat = r.game.disco.cat;
  const A = lineFor(r, 'p0', cat);
  const B = lineFor(r, 'p1', cat);
  r = withMarks(r, 'p0', A.line.filter((i) => i !== A.sq));
  r = withMarks(r, 'p1', B.line.filter((i) => i !== B.sq));
  for (const id of ['p0', 'p1', 'p2']) r = submitAnswer(r, id, rightAnswer(r));
  r = reveal(r);
  assert.ok(!inBingoStop(r));
  r = stampSquare(r, 'p0', A.sq);
  assert.ok(inBingoStop(r), 'de chip die de lijn maakt stopt het spel');
  assert.throws(() => stampSquare(r, 'p0', null), (e) => e.code === 'final', 'een bingo-fiche gaat niet terug');
  const other = choosableSquares(r.game, 'p0').find((i) => i !== A.sq);
  if (other != null) assert.throws(() => stampSquare(r, 'p0', other), (e) => e.code === 'final', 'en verplaatst niet');
  // the view: on every screen the same bingo, with the winner's card and line for the tv
  const sv = viewFor(r, '!spectator', {});
  assert.equal(sv.game.disco.bingo.win, 'line1');
  assert.deepEqual(sv.game.disco.bingo.next, ['line2', 'full']);
  assert.deepEqual(sv.game.disco.bingo.winners.map((w) => w.name), ['Anouk']);
  assert.deepEqual(sv.game.disco.bingo.winners[0].cells, [...A.line].sort((x, y) => x - y));
  assert.equal(sv.game.disco.bingo.winners[0].card.length, 25);
  // fairness: Bram, also right this round, lays his chip during the stop and joins the winners
  r = stampSquare(r, 'p1', B.sq);
  assert.deepEqual(r.game.roundWinners, ['p0', 'p1'], 'de eerste eerst, Bram erbij');
  // the leader flips Anouk to wrong: her chip goes, only Bram's bingo stays
  r = judgeResult(r, 'p0', false);
  assert.deepEqual(r.game.roundWinners, ['p1']);
  r = judgeResult(r, 'p1', false);
  assert.ok(!inBingoStop(r), 'geen bingo meer: terug naar de gewone onthulling');
  assert.equal(viewFor(r, '!spectator', {}).game.disco.bingo, null);
  r = judgeResult(r, 'p1', true);
  assert.deepEqual(r.game.roundWinners, [], 'goed gedraaid: Bram kiest opnieuw');
  r = stampSquare(r, 'p1', B.sq);
  assert.ok(inBingoStop(r));
});

test('doorgaan na een bingo: 1 lijn -> 2 lijnen -> volle kaart -> stoppen; etappes per doel', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  // round 1: Anouk makes one line
  let cat = r.game.disco.cat;
  const A = lineFor(r, 'p0', cat);
  r = withMarks(r, 'p0', A.line.filter((i) => i !== A.sq));
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = submitAnswer(r, 'p1', rightAnswer(r));
  r = stampSquare(reveal(r), 'p0', A.sq);
  assert.ok(inBingoStop(r));
  assert.throws(() => continueGame(r, 'line1', { now: 5 }), (e) => e.code === 'answer', 'niet terug naar 1 lijn');
  assert.ok(stillChoosing(r.game).includes('p1'));
  r = continueGame(r, 'line2', { now: 5000 });
  assert.equal(r.phase, 'answering', 'volgende ronde');
  assert.equal(r.game.round, 2);
  assert.equal(r.game.disco.win, 'line2');
  assert.equal(r.settings.win, 'line1', 'de lobby-instelling blijft het eerste doel');
  assert.deepEqual(r.game.disco.stages, [{ win: 'line1', winners: ['p0'], round: 1 }]);
  assert.ok(r.game.per.p1.marks.some((m, i) => i !== CENTER && m != null), 'Bram kreeg zijn fiche automatisch');
  const v = viewFor(r, 'p0', {});
  assert.deepEqual(v.game.disco.stages, [{ win: 'line1', ids: ['p0'], names: ['Anouk'], round: 1 }]);
  assert.equal(v.game.disco.progress.find((p) => p.id === 'p0').toGo > 0, true, 'voortgang telt naar 2 lijnen');
  assert.equal(v.game.mine.bingo, false);
  // round 2: Anouk completes a second line
  cat = r.game.disco.cat;
  const have = completeLines(r.game.per.p0.marks)[0];
  const L = LINES.filter((l) => l !== have && l.some((i) => r.game.per.p0.card[i] === cat && r.game.per.p0.marks[i] == null))[0];
  const sq = L.find((i) => r.game.per.p0.card[i] === cat && r.game.per.p0.marks[i] == null);
  r = withMarks(r, 'p0', [...have, ...L.filter((i) => i !== sq)]);
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = stampSquare(reveal(r), 'p0', sq);
  assert.ok(inBingoStop(r), '2 lijnen: weer een bingostop');
  assert.deepEqual(viewFor(r, 'p0', {}).game.disco.bingo.next, ['full']);
  r = continueGame(r, 'full', { now: 6000 });
  assert.equal(r.game.disco.win, 'full');
  assert.equal(r.game.disco.stages.length, 2);
  // round 3: a full card for Bram
  cat = r.game.disco.cat;
  const bsq = r.game.per.p1.card.findIndex((k, i) => k === cat && r.game.per.p1.marks[i] == null);
  r = withMarks(r, 'p1', Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== bsq));
  r = submitAnswer(r, 'p1', rightAnswer(r));
  r = stampSquare(reveal(r), 'p1', bsq);
  assert.ok(inBingoStop(r));
  assert.deepEqual(viewFor(r, 'p1', {}).game.disco.bingo.next, [], 'volle kaart: alleen stoppen');
  r = finishGame(r);
  assert.equal(r.phase, 'won');
  assert.deepEqual(r.game.winners, ['p0', 'p1']);
  assert.deepEqual(r.game.disco.stages.map((s) => [s.win, s.winners]), [['line1', ['p0']], ['line2', ['p0']], ['full', ['p1']]]);
  const w = viewFor(r, 'p0', {});
  assert.deepEqual(w.game.winners, ['Anouk', 'Bram']);
  assert.ok(w.game.disco.awards.length > 0, 'de prijsuitreiking');
});

test('doorgaan terwijl iemand het nieuwe doel al haalt: meteen de volgende bingostop', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  const cat = r.game.disco.cat;
  // Anouk's one chip completes two lines at once (a row and a column through the same square)
  const s = r.game.per.p0;
  const sq = s.card.findIndex((k, i) => k === cat && LINES.filter((l) => l.includes(i)).length >= 2);
  const two = LINES.filter((l) => l.includes(sq)).slice(0, 2);
  r = withMarks(r, 'p0', [...new Set(two.flat())].filter((i) => i !== sq));
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = stampSquare(reveal(r), 'p0', sq);
  assert.ok(inBingoStop(r));
  assert.equal(completeLines(r.game.per.p0.marks).length >= 2, true);
  r = continueGame(r, 'line2', { now: 7000 });
  assert.equal(r.phase, 'revealed', 'geen volgend nummer: Anouk heeft al 2 lijnen');
  assert.ok(inBingoStop(r));
  assert.equal(r.game.disco.win, 'line2');
  assert.deepEqual(r.game.roundWinners, ['p0']);
  assert.equal(r.game.round, 1);
  r = continueGame(r, 'full', { now: 7001 });
  assert.equal(r.phase, 'answering');
  assert.deepEqual(r.game.disco.stages.map((x) => x.win), ['line1', 'line2']);
});

test('doorgaan / stoppen: alleen bij een bingo, en niet met open twijfelgevallen', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = reveal(r);
  assert.throws(() => continueGame(r, 'line2'), (e) => e.code === 'phase');
  assert.throws(() => finishGame(r), (e) => e.code === 'phase');
  r = untilTyped(nextRound(r, { now: 3 }));
  const cat = r.game.disco.cat;
  const A = lineFor(r, 'p0', cat);
  r = withMarks(r, 'p0', A.line.filter((i) => i !== A.sq));
  const song = songOf(r);
  r = submitAnswer(r, 'p0', rightAnswer(r));
  // Bram types something only the leader can judge
  const real = cat === 'artist' ? song.artist : song.title;
  r = submitAnswer(r, 'p1', { text: real.split(' ').slice(0, -1).join(' ') || `${real}x` });
  r = stampSquare(reveal(r), 'p0', A.sq);
  assert.ok(inBingoStop(r));
  if (undecided(r.game).length) {
    assert.throws(() => continueGame(r, 'line2'), (e) => e.code === 'doubt');
    assert.throws(() => finishGame(r), (e) => e.code === 'doubt');
    r = judgeResult(r, 'p1', false);
  }
  assert.equal(finishGame(r).phase, 'won');
});

test('automatisch naar het resultaat: iedereen online geantwoord, gedeeld moment, stopt vanzelf, Wacht nog', () => {
  let r = discoRoom(['Anouk', 'Bram', 'Cas']);
  const on = { p0: true, p1: true }; // Cas is away: never waited for
  const landed = 1000 + SPIN_MS;
  assert.equal(autoRevealDue(r, on), false, 'nog niemand');
  r = submitAnswer(r, 'p0', rightAnswer(r), { now: 1500 });
  assert.equal(armAutoReveal(r, 1500, on), r, 'niet iedereen: niets');
  r = submitAnswer(r, 'p1', { pass: true }, { now: 1600 });
  assert.equal(autoRevealDue(r, on), true, '"weet ik niet" telt als antwoord');
  r = armAutoReveal(r, 1600, on);
  assert.equal(r.game.disco.autoAt, landed + AUTO_REVEAL_MS, 'nooit voor de bal geland is');
  assert.equal(discoNextEvent(r), landed + AUTO_REVEAL_MS);
  const later = armAutoReveal(r, 9000, on);
  assert.equal(later, r, 'zolang het geldt verandert er niets');
  // changing an answer restarts nothing
  r = submitAnswer(r, 'p0', wrongAnswer(r), { now: 6000 });
  r = armAutoReveal(r, 6000, on);
  assert.equal(r.game.disco.autoAt, landed + AUTO_REVEAL_MS);
  assert.equal(autoRevealNow(r, landed + AUTO_REVEAL_MS - 1, on), false);
  assert.equal(autoRevealNow(r, landed + AUTO_REVEAL_MS, on), true);
  // Cas comes back online without an answer: the countdown stops
  const back = armAutoReveal(r, 7000, { ...on, p2: true });
  assert.equal(back.game.disco.autoAt, null);
  assert.equal(autoRevealNow(back, 99999, { ...on, p2: true }), false);
  // a withdrawn answer stops it too; answering again starts a fresh one
  let w = armAutoReveal(withdrawAnswer(r, 'p1'), 7000, on);
  assert.equal(w.game.disco.autoAt, null);
  w = armAutoReveal(submitAnswer(w, 'p1', { pass: true }, { now: 7100 }), 7100, on);
  assert.equal(w.game.disco.autoAt, 7100 + AUTO_REVEAL_MS);
  // "Wacht nog": off for this round only
  const held = holdAutoReveal(r);
  assert.equal(held.game.disco.autoAt, null);
  assert.equal(held.game.disco.hold, true);
  assert.equal(armAutoReveal(held, 9000, on).game.disco.autoAt, null);
  assert.equal(viewFor(held, 'p0', on).game.disco.autoHeld, true);
  const next = nextRound(reveal(held), { now: 20000 });
  assert.equal(next.game.disco.hold, false, 'volgende ronde weer aan');
  assert.equal(next.game.disco.autoAt, null);
  assert.throws(() => holdAutoReveal(reveal(r)), (e) => e.code === 'phase');
  // the lobby setting off: never
  let off = discoRoom(['Anouk'], { autoReveal: false });
  off = submitAnswer(off, 'p0', { pass: true });
  assert.equal(autoRevealDue(off, { p0: true }), false);
  // nobody online: never
  assert.equal(autoRevealDue(r, {}), false);
  // the view: the moment and its length while answering, nothing after the reveal
  const v = viewFor(r, 'p1', on).game.disco;
  assert.equal(v.autoAt, landed + AUTO_REVEAL_MS);
  assert.equal(v.autoMs, AUTO_REVEAL_MS);
  assert.equal(viewFor(reveal(r), 'p1', on).game.disco.autoAt, null);
});

test('fiches na de onthulling: gelegd / kiest nog / weg / twijfel, voor de spelleider en de tv', () => {
  let r = untilTyped(discoRoom(['Anouk', 'Bram', 'Cas', 'Dirk']));
  const song = songOf(r);
  const cat = r.game.disco.cat;
  const real = cat === 'artist' ? song.artist : song.title;
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = submitAnswer(r, 'p1', rightAnswer(r));
  r = submitAnswer(r, 'p2', rightAnswer(r));
  r = submitAnswer(r, 'p3', { text: real.split(' ').slice(0, -1).join(' ') });
  assert.deepEqual(viewFor(r, '!spectator', {}).game.disco.chips, [], 'voor de onthulling: niets');
  r = reveal(r);
  r = stampSquare(r, 'p0', choosableSquares(r.game, 'p0')[0]);
  const on = { p0: true, p1: true, p3: true };
  const chips = viewFor(r, '!spectator', on).game.disco.chips;
  const st = Object.fromEntries(chips.map((c) => [c.id, c.state]));
  assert.equal(st.p0, 'placed');
  assert.equal(st.p1, 'choosing');
  assert.equal(st.p2, 'away', 'offline: wordt automatisch gelegd');
  if (r.game.results.p3.verdict === 'doubt') assert.equal(st.p3, 'doubt');
  assert.ok(chips.every((c) => c.name && 'online' in c));
});

test('oude kamer met "Decennium": een lopend spel gaat terug naar de lobby, de rest blijft', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  const old = { ...r, game: { ...r.game, disco: { ...r.game.disco, cat: 'decade', decades: [1960, 1970] } } };
  const m = migrateRoom(old);
  assert.equal(m.phase, 'lobby');
  assert.equal(m.game, null);
  assert.deepEqual(m.players, r.players);
  assert.deepEqual(m.settings, r.settings);
  const p0 = r.game.per.p0;
  const oldCard = { ...r, game: { ...r.game, per: { ...r.game.per, p0: { ...p0, card: p0.card.map((k) => (k === 'exact' ? 'decade' : k)) } } } };
  assert.equal(migrateRoom(oldCard).phase, 'lobby');
  assert.equal(isValidRoom(oldCard), false, 'zonder migratie is hij ongeldig');
  assert.equal(migrateRoom(r), r, 'een nieuwe kamer blijft zoals hij is');
  const lobby = createRoom({ code: 'ABCD', settings: { game: 'disco' } });
  assert.equal(migrateRoom(lobby), lobby);
  r = submitAnswer(r, 'p0', rightAnswer(r));
  const shown = reveal(r);
  assert.equal(migrateRoom(shown), shown, 'ook na de onthulling');
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

test('ids als "__proto__" / "constructor": nooit een speler, nooit een oordeel of stempel', () => {
  let r = discoRoom(['Anouk']);
  for (const id of ['__proto__', 'constructor', 'toString']) assert.throws(() => addPlayer(r, { id, name: 'x' }), (e) => e instanceof GameError && e.code === 'bad');
  r = reveal(submitAnswer(r, 'p0', rightAnswer(r)));
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => judgeResult(r, id, true), (e) => e instanceof GameError);
    assert.throws(() => overrideResult(r, id), (e) => e instanceof GameError);
    assert.throws(() => stampSquare(r, id, 0), (e) => e instanceof GameError);
    assert.deepEqual(choosableSquares(r.game, id), []);
    assert.equal(removePlayer(r, id), r);
    assert.equal(scoreOf(r.game, id), 0);
  }
  // a results entry without a snapshot / card (a broken state) does not break the helpers or the view
  const odd = { ...r, game: { ...r.game, results: { ...r.game.results, ghost: { correct: true, verdict: 'right' } } } };
  assert.deepEqual(choosableSquares(odd.game, 'ghost'), []);
  assert.ok(!stillChoosing(odd.game).includes('ghost'));
  assert.doesNotThrow(() => viewFor(odd, 'p0', {}));
});

test('beschrijving, geldige kamer en weergave na de onthulling', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  assert.ok(isValidRoom(r));
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, disco: null } }));
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, per: { p0: { card: [], marks: [] } } } }));
  const p0 = r.game.per.p0;
  const withPer = (s0) => ({ ...r, game: { ...r.game, per: { ...r.game.per, p0: s0 } } });
  assert.ok(!isValidRoom(withPer({ ...p0, card: p0.card.map((k, i) => (i === 0 ? 'year' : k)) })), 'kaart buiten de regels');
  assert.ok(!isValidRoom(withPer({ ...p0, marks: p0.marks.map((m, i) => (i === 0 ? 'onbekend-nummer' : m)) })), 'stempel van een onbekend nummer');
  assert.ok(!isValidRoom(withPer({ ...p0, marks: p0.marks.map((m, i) => (i === CENTER ? null : m)) })), 'midden niet gestempeld');
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, disco: { ...r.game.disco, choices: { p0: 25 } } } }));
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, disco: { ...r.game.disco, choices: { nobody: 1 } } } }));
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, per: { ...r.game.per, stranger: p0 } } }), 'kaart van iemand die niet meedoet');
  assert.ok(!isValidRoom({ ...r, players: [...r.players, { id: '__proto__', name: 'x' }] }));
  const g = r.game;
  assert.equal(describeAnswer({ ...g, disco: { ...g.disco, cat: 'exact' } }, 'p0', { guess: 1984 }), 'Exact jaar: 1984');
  assert.equal(describeAnswer({ ...g, disco: { ...g.disco, cat: 'year' } }, 'p0', { guess: 1984 }), 'Jaartal: 1984');
  assert.ok(!isValidRoom({ ...r, game: { ...r.game, disco: { ...r.game.disco, stages: [{ win: 'zeven', winners: [] }] } } }), 'etappe met een onbekend doel');
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

test('doorgaan en dan zijn de nummers op: wie een etappe won, wint (op volgorde); de rest volgt in de stand', () => {
  let r = discoRoom(['Anouk', 'Bram'], {}, cards.slice(0, 25));
  // round 1: Anouk makes one line; the leader goes on for 2 lines
  const A = lineFor(r, 'p0', r.game.disco.cat);
  r = withMarks(r, 'p0', A.line.filter((i) => i !== A.sq));
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = stampSquare(reveal(r), 'p0', A.sq);
  assert.ok(inBingoStop(r));
  r = continueGame(r, 'line2', { now: 5000 });
  const anouk = scoreOf(r.game, 'p0');
  // from now on only Bram is right: he stamps more squares than Anouk, but never 2 lines
  let rounds = 0;
  while (r.phase === 'answering') {
    rounds++;
    if (scoreOf(r.game, 'p1') <= anouk + 1) r = submitAnswer(r, 'p1', rightAnswer(r));
    r = reveal(r);
    assert.ok(!inBingoStop(r), 'nobody reaches 2 lines');
    r = nextRound(r, { now: 6000 + rounds });
  }
  assert.equal(r.phase, 'won');
  assert.ok(scoreOf(r.game, 'p1') > scoreOf(r.game, 'p0'), `Bram has more squares (${scoreOf(r.game, 'p1')} vs ${scoreOf(r.game, 'p0')})`);
  assert.deepEqual(r.game.winners, ['p0'], 'the stage winner wins, not the most squares');
  assert.equal(r.game.endedBy, 'goal', 'shown as after "Stop"');
  assert.equal(r.game.disco.win, 'line1', 'won with the last stage reached');
  assert.deepEqual(r.game.disco.stages.map((s) => [s.win, s.winners]), [['line1', ['p0']]]);
  const w = viewFor(r, 'p1', {});
  assert.deepEqual(w.game.winners, ['Anouk']);
  assert.deepEqual(w.game.disco.stages.map((s) => s.names), [['Anouk']]);
  assert.ok(w.game.disco.awards.length > 0, 'the prize ceremony');
});

test('nummers op na doorgaan, maar de etappewinnaar is weg: dan de meeste vakjes', () => {
  let r = discoRoom(['Anouk', 'Bram', 'Cas'], {}, cards.slice(0, 25));
  const A = lineFor(r, 'p0', r.game.disco.cat);
  r = withMarks(r, 'p0', A.line.filter((i) => i !== A.sq));
  r = submitAnswer(r, 'p0', rightAnswer(r));
  r = stampSquare(reveal(r), 'p0', A.sq);
  r = continueGame(r, 'line2', { now: 5000 });
  r = removePlayer(r, 'p0');
  let rounds = 0;
  while (r.phase === 'answering') {
    rounds++;
    if (rounds <= 2) r = submitAnswer(r, 'p1', rightAnswer(r));
    r = nextRound(reveal(r), { now: 6000 + rounds });
  }
  assert.equal(r.game.endedBy, 'pile');
  assert.deepEqual(r.game.winners, ['p1']);
});
