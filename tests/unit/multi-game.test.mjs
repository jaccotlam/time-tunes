import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, addPlayer, removePlayer, setSettings, startGame, submitAnswer, withdrawAnswer, allAnswered,
  reveal, overrideResult, nextRound, playAgain, backToLobby, standings, isValidRoom, normalizeAnswer,
  GameError, FREE, MAX_ROOM_PLAYERS, cleanName,
} from '../../app/js/multi/game.js';
import { checkSquare, findBingo, markCount, bestLine, lines, SQUARES } from '../../app/js/bingo.js';
import { isCorrectPlacement } from '../../app/js/logic.js';

const cards = Array.from({ length: 60 }, (_, i) => ({
  id: String(i + 1).padStart(3, '0'), year: 1960 + Math.floor(i * 1.1), title: `Liedje ${i + 1}`, artist: `Band ${i + 1}`,
}));
const songOf = (room) => room.game.songs[room.game.current];

function roomWith(names, settings = {}) {
  let r = createRoom({ code: 'ABCD', settings });
  names.forEach((n, i) => { r = addPlayer(r, { id: `p${i}`, name: n }); });
  return r;
}

/** A correct bingo answer for player `pid`, or null when no open square fits. */
function goodBingo(room, pid, prefer = () => 0) {
  const s = room.game.per[pid];
  const song = songOf(room);
  const open = s.card.map((k, i) => ({ k, i })).filter((o) => s.marks[o.i] == null)
    .filter((o) => (o.k === 'artist' || o.k === 'title') || checkSquare(o.k, song.year, song.year) === true);
  if (!open.length) return null;
  open.sort((a, b) => prefer(b.i) - prefer(a.i));
  const { k, i } = open[0];
  if (k === 'year') return { index: i, guess: song.year };
  if (k === 'artist') return { index: i, text: song.artist };
  if (k === 'title') return { index: i, text: song.title };
  return { index: i };
}
function wrongBingo(room, pid) {
  const s = room.game.per[pid];
  const song = songOf(room);
  const o = s.card.map((k, i) => ({ k, i })).find((x) => s.marks[x.i] == null && x.k !== 'artist' && x.k !== 'title' && x.k !== 'year' && checkSquare(x.k, song.year) === false);
  return o ? { index: o.i } : { pass: true };
}

test('createRoom / addPlayer: namen, terugkomen met hetzelfde id, vol', () => {
  let r = createRoom({ code: 'ABCD', host: { id: 'h', name: '  Ilse  ' } });
  assert.equal(r.players[0].name, 'Ilse');
  assert.equal(r.players[0].host, true);
  r = addPlayer(r, { id: 'a', name: 'Anouk' });
  r = addPlayer(r, { id: 'b', name: 'anouk' });
  assert.equal(r.players[2].name, 'anouk 2', 'dubbele naam krijgt een nummer');
  const again = addPlayer(r, { id: 'a', name: 'Anouk' });
  assert.equal(again.players.length, 3, 'zelfde id = zelfde speler');
  for (let i = r.players.length; i < MAX_ROOM_PLAYERS; i++) r = addPlayer(r, { id: `x${i}`, name: `X${i}` });
  assert.throws(() => addPlayer(r, { id: 'late', name: 'Laat' }), (e) => e instanceof GameError && e.code === 'full');
  assert.equal(cleanName('a\u0000b   c'), 'ab c');
  assert.equal(cleanName(''), 'Speler');
});

test('instellingen: alleen tussen potjes, waarden begrensd', () => {
  let r = roomWith(['A', 'B']);
  r = setSettings(r, { game: 'timeline', goal: 99 });
  assert.equal(r.settings.goal, 30);
  r = setSettings(r, { game: 'nonsense', size: 7 });
  assert.equal(r.settings.game, 'bingo');
  assert.equal(r.settings.size, 4);
  r = startGame(r, { cards, seed: 1 });
  assert.throws(() => setSettings(r, { size: 3 }), GameError);
});

test('bingo: ronde, antwoorden, wijzigen, onthullen, afstempelen', () => {
  let r = startGame(roomWith(['Anouk', 'Bram', 'Cas'], { game: 'bingo', size: 3 }), { cards, seed: 42 });
  assert.equal(r.phase, 'answering');
  assert.equal(r.game.round, 1);
  assert.notEqual(r.game.per.p0.card.join(), r.game.per.p1.card.join(), 'iedereen een eigen kaart');
  const good = goodBingo(r, 'p0');
  const bad = wrongBingo(r, 'p1');
  r = submitAnswer(r, 'p0', { pass: true });
  r = submitAnswer(r, 'p0', good); // wijzigen mag tot de onthulling
  r = submitAnswer(r, 'p1', bad);
  assert.equal(allAnswered(r), false, 'Cas heeft nog niet geantwoord');
  r = submitAnswer(r, 'p2', { pass: true });
  assert.equal(allAnswered(r), true);
  r = withdrawAnswer(r, 'p2');
  assert.equal(allAnswered(r), false);
  const cur = r.game.current;
  r = reveal(r); // Cas antwoordde niet: de ronde gaat gewoon door
  assert.equal(r.phase, 'revealed');
  assert.equal(r.game.results.p0.correct, true);
  assert.equal(r.game.per.p0.marks[good.index], cur);
  assert.equal(r.game.results.p1.correct, false);
  assert.equal(markCount(r.game.per.p1.marks), 0);
  assert.equal(r.game.results.p2.none, true);
  assert.throws(() => submitAnswer(r, 'p2', { pass: true }), (e) => e.code === 'late', 'na de onthulling geen antwoorden meer');
  r = nextRound(r);
  assert.equal(r.phase, 'answering');
  assert.equal(r.game.round, 2);
  assert.deepEqual(r.game.answers, {});
});

test('bingo: ongeldige antwoorden worden geweigerd', () => {
  const r = startGame(roomWith(['A', 'B'], { game: 'bingo', size: 4 }), { cards, seed: 3 });
  const card = r.game.per.p0.card;
  const yearIdx = card.indexOf('year');
  assert.throws(() => normalizeAnswer(r, 'p0', { index: 99 }), GameError);
  assert.throws(() => normalizeAnswer(r, 'p0', { index: yearIdx }), /jaartal/);
  assert.deepEqual(normalizeAnswer(r, 'p0', { index: yearIdx, guess: '1984' }), { index: yearIdx, guess: 1984 });
  const artistIdx = card.indexOf('artist');
  assert.throws(() => normalizeAnswer(r, 'p0', { index: artistIdx, text: '  ' }), /artiest/);
  assert.equal(normalizeAnswer(r, 'p0', { index: artistIdx, text: 'x'.repeat(200) }).text.length, 60);
  assert.throws(() => normalizeAnswer(r, 'nobody', { pass: true }), GameError);
});

test('bingo: getypte artiest met typefout wordt goedgekeurd; host draait een oordeel om', () => {
  let r = startGame(roomWith(['A', 'B'], { game: 'bingo', size: 4 }), { cards, seed: 9 });
  const song = songOf(r);
  const ai = r.game.per.p0.card.indexOf('artist');
  const ti = r.game.per.p1.card.indexOf('title');
  r = submitAnswer(r, 'p0', { index: ai, text: song.artist.toLowerCase().replace('band', 'bnad') });
  r = submitAnswer(r, 'p1', { index: ti, text: 'Iets heel anders' });
  r = reveal(r);
  assert.equal(r.game.results.p0.correct, true, 'typefout goedgekeurd');
  assert.equal(r.game.results.p0.typed, true);
  assert.equal(r.game.results.p1.correct, false);
  assert.equal(r.game.per.p1.marks[ti], null);
  r = overrideResult(r, 'p1');
  assert.equal(r.game.results.p1.correct, true);
  assert.equal(r.game.results.p1.overridden, true);
  assert.equal(r.game.per.p1.marks[ti], r.game.current, 'omgedraaid oordeel stempelt af');
  r = overrideResult(r, 'p0');
  assert.equal(r.game.per.p0.marks[ai], null, 'en terug: vakje weer open');
  r = overrideResult(r, 'p0');
  assert.equal(r.game.per.p0.marks[ai], r.game.current);
});

test('bingo: eerste volle lijn wint; twee in dezelfde ronde delen de winst', () => {
  let r = startGame(roomWith(['A', 'B', 'C'], { game: 'bingo', size: 3 }), { cards, seed: 5 });
  let rounds = 0;
  // A en B spelen perfect en kiezen hetzelfde soort vakjes; C past altijd.
  while (r.phase !== 'won' && rounds < 50) {
    for (const pid of ['p0', 'p1']) {
      const line = (i) => Math.max(...lines(3).filter((l) => l.includes(i)).map((l) => l.filter((j) => r.game.per[pid].marks[j] != null).length));
      const a = goodBingo(r, pid, line);
      r = submitAnswer(r, pid, a || { pass: true });
    }
    r = submitAnswer(r, 'p2', { pass: true });
    r = reveal(r);
    r = nextRound(r);
    rounds++;
  }
  assert.equal(r.phase, 'won');
  assert.equal(r.game.endedBy, 'goal');
  assert.ok(r.game.winners.length >= 1 && !r.game.winners.includes('p2'));
  for (const w of r.game.winners) assert.ok(findBingo(r.game.per[w].marks, 3), `${w} heeft een volle lijn`);

  // Gedeelde winst geforceerd: twee spelers met een bijna volle lijn stempelen in dezelfde ronde af.
  let s = startGame(roomWith(['A', 'B'], { game: 'bingo', size: 3 }), { cards, seed: 11 });
  const year = songOf(s).year;
  for (const pid of ['p0', 'p1']) {
    const per = s.game.per[pid];
    const line = lines(3).find((l) => l.some((i) => checkSquare(per.card[i], year, year) === true && per.card[i] !== 'year'));
    const target = line.find((i) => checkSquare(per.card[i], year, year) === true && per.card[i] !== 'year');
    const marks = per.marks.slice();
    for (const i of line) if (i !== target) marks[i] = '001';
    s = { ...s, game: { ...s.game, per: { ...s.game.per, [pid]: { ...per, marks } } } };
    s = submitAnswer(s, pid, { index: target });
  }
  s = reveal(s);
  assert.deepEqual(s.game.roundWinners.sort(), ['p0', 'p1']);
  assert.equal(s.phase, 'revealed', 'host ziet eerst de onthulling');
  s = nextRound(s);
  assert.equal(s.phase, 'won');
  assert.deepEqual(s.game.winners.sort(), ['p0', 'p1'], 'gedeelde winst');
  assert.ok(standings(s).filter((x) => x.winner).length === 2);
});

test('tijdlijn: plek kiezen, goed = kaart erbij, doel halen, gedeelde winst', () => {
  let r = startGame(roomWith(['A', 'B', 'C'], { game: 'timeline', goal: 4 }), { cards, seed: 21 });
  assert.equal(r.game.per.p0.timeline.length, 1);
  let rounds = 0;
  while (r.phase !== 'won' && rounds < 40) {
    const song = songOf(r);
    for (const pid of ['p0', 'p1', 'p2']) {
      const years = r.game.per[pid].timeline.map((id) => r.game.songs[id].year);
      let slot = years.findIndex((y) => y > song.year);
      if (slot < 0) slot = years.length;
      if (pid === 'p2') {
        // C kiest steeds een foute plek (of antwoordt niet als elke plek goed is)
        const wrong = [0, years.length].find((x) => !isCorrectPlacement(years, x, song.year));
        if (wrong != null) r = submitAnswer(r, pid, { slot: wrong });
        continue;
      }
      r = submitAnswer(r, pid, { slot });
    }
    r = reveal(r);
    for (const pid of ['p0', 'p1']) assert.equal(r.game.results[pid].correct, true);
    r = nextRound(r);
    rounds++;
  }
  assert.equal(r.phase, 'won');
  assert.equal(rounds, 3, 'van 1 naar 4 kaarten in 3 rondes');
  assert.deepEqual(r.game.winners.sort(), ['p0', 'p1'], 'A en B halen het doel in dezelfde ronde');
  assert.ok(r.game.per.p0.timeline.length === 4);
  const ys = r.game.per.p0.timeline.map((id) => r.game.songs[id].year);
  assert.deepEqual(ys, ys.slice().sort((a, b) => a - b), 'tijdlijn blijft op volgorde');
});

test('tijdlijn: foute plek = kaart weg, goede plekken bekend', () => {
  let r = startGame(roomWith(['A', 'B'], { game: 'timeline' }), { cards, seed: 2 });
  const song = songOf(r);
  const start = r.game.songs[r.game.per.p0.timeline[0]].year;
  const wrong = song.year < start ? 1 : 0;
  r = submitAnswer(r, 'p0', { slot: wrong });
  r = reveal(r);
  assert.equal(r.game.results.p0.correct, song.year === start);
  if (song.year !== start) {
    assert.equal(r.game.per.p0.timeline.length, 1);
    assert.deepEqual(r.game.results.p0.correctSlots, [1 - wrong]);
  }
  assert.throws(() => normalizeAnswer(nextRound(r), 'p0', { slot: 5 }), GameError);
});

test('laat instappen: eerlijke startpositie, nooit bijna-bingo', () => {
  // Tijdlijn: zo ver als wie het verst achter ligt.
  let r = startGame(roomWith(['A', 'B'], { game: 'timeline', goal: 10 }), { cards, seed: 8 });
  r = { ...r, game: { ...r.game, per: { p0: { timeline: r.game.per.p0.timeline.concat(r.game.pile.slice(0, 4)).sort((a, b) => r.game.songs[a].year - r.game.songs[b].year) }, p1: { timeline: r.game.per.p1.timeline.concat(r.game.pile.slice(4, 6)).sort((a, b) => r.game.songs[a].year - r.game.songs[b].year) } }, pile: r.game.pile.slice(6) } };
  const pileBefore = r.game.pile.length;
  r = addPlayer(r, { id: 'late', name: 'Laatkomer' });
  assert.equal(r.game.per.late.timeline.length, 3, 'zo lang als de kortste tijdlijn (3)');
  assert.equal(r.game.pile.length, pileBefore - 3);
  const ys = r.game.per.late.timeline.map((id) => r.game.songs[id].year);
  assert.deepEqual(ys, ys.slice().sort((a, b) => a - b));
  assert.ok(!r.game.per.late.timeline.includes(r.game.current), 'nooit het lopende nummer');
  r = submitAnswer(r, 'late', { slot: 0 });
  r = reveal(r);
  assert.ok(r.game.results.late, 'laatkomer doet meteen mee in deze ronde');

  // Instappen tijdens de onthulling: telt vanaf de volgende ronde mee, stand blijft intact.
  r = addPlayer(r, { id: 'late2', name: 'Nog later' });
  r = overrideResult(r, 'late');
  assert.ok(r.game.per.late2, 'blijft bestaan na herberekenen');

  // Bingo: gratis vakjes tot de achterste speler, maar nooit een bijna volle lijn.
  let b = startGame(roomWith(['A', 'B'], { game: 'bingo', size: 4 }), { cards, seed: 4 });
  const fill = (marks, n) => marks.map((m, i) => (i < n ? '001' : m));
  b = { ...b, game: { ...b.game, per: { p0: { ...b.game.per.p0, marks: fill(b.game.per.p0.marks, 7) }, p1: { ...b.game.per.p1, marks: fill(b.game.per.p1.marks, 5) } } } };
  b = addPlayer(b, { id: 'late', name: 'Laat' });
  const lm = b.game.per.late.marks;
  assert.ok(markCount(lm) <= 5 && markCount(lm) >= 4, `gratis vakjes: ${markCount(lm)}`);
  assert.ok(lm.every((m) => m == null || m === FREE));
  assert.ok(bestLine(lm, 4) <= 2, 'nooit dichter dan 2 bij bingo');
  assert.ok(b.game.per.late.card.every((k) => SQUARES[k]));
});

test('speler verwijderen: weg uit de stand, kan niet terug', () => {
  let r = startGame(roomWith(['A', 'B', 'C'], { game: 'bingo', size: 3 }), { cards, seed: 6 });
  r = submitAnswer(r, 'p1', { pass: true });
  r = removePlayer(r, 'p1');
  assert.equal(r.players.length, 2);
  assert.equal(r.game.per.p1, undefined);
  assert.equal(r.game.answers.p1, undefined);
  assert.throws(() => addPlayer(r, { id: 'p1', name: 'B' }), (e) => e.code === 'removed');
  r = reveal(r);
  assert.equal(r.game.results.p1, undefined);
  const h = createRoom({ code: 'ABCD', host: { id: 'h', name: 'H' } });
  assert.throws(() => removePlayer(h, 'h'), GameError);
});

test('nummers op: hoogste score wint; nog een potje; terug naar de lobby; herstellen', () => {
  const few = cards.slice(0, 6);
  let r = startGame(roomWith(['A', 'B'], { game: 'timeline', goal: 30 }), { cards: few, seed: 1 });
  let guard = 0;
  while (r.phase !== 'won' && guard++ < 20) {
    r = reveal(r);
    r = nextRound(r);
  }
  assert.equal(r.phase, 'won');
  assert.equal(r.game.endedBy, 'pile');
  assert.deepEqual(r.game.winners.sort(), ['p0', 'p1'], 'niemand antwoordde: gelijkspel');
  assert.ok(isValidRoom(JSON.parse(JSON.stringify(r))));
  const again = playAgain(r, { cards, seed: 2 });
  assert.equal(again.phase, 'answering');
  assert.equal(again.game.round, 1);
  assert.equal(again.players.length, 2);
  const lobby = backToLobby(again);
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.game, null);
  assert.ok(isValidRoom(lobby));
  assert.ok(!isValidRoom({ ...again, phase: 'nonsense' }));
  assert.ok(!isValidRoom(null));
});
