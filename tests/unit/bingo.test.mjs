import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SQUARES, MIX, lines, isBalanced, generateCard, generateCards, cardSignature, checkSquare, parseYearGuess,
  findBingo, markCount, bestLine, createBingo, startBingoTurn, canClaim, claimSquare, judgeClaim,
  nextBingoPlayer, isValidBingoState,
} from '../../app/js/bingo.js';
import { seededRandom } from '../../app/js/logic.js';

const cards = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1).padStart(3, '0'), year: 1960 + i }));

test('lines: rijen, kolommen en twee diagonalen', () => {
  assert.equal(lines(3).length, 8);
  assert.equal(lines(4).length, 10);
  assert.deepEqual(lines(3)[6], [0, 4, 8]);
  assert.deepEqual(lines(3)[7], [2, 4, 6]);
  assert.deepEqual(lines(4)[4], [0, 4, 8, 12]);
});

test('checkSquare per vakjestype', () => {
  assert.equal(checkSquare('d60', 1954), true);
  assert.equal(checkSquare('d60', 1969), true);
  assert.equal(checkSquare('d60', 1970), false);
  assert.equal(checkSquare('d80', 1985), true);
  assert.equal(checkSquare('d80', 1990), false);
  assert.equal(checkSquare('d10', 2024), true);
  assert.equal(checkSquare('d10', 2009), false);
  assert.equal(checkSquare('pre80', 1979), true);
  assert.equal(checkSquare('pre80', 1980), false);
  assert.equal(checkSquare('pre00', 1999), true);
  assert.equal(checkSquare('from90', 1990), true);
  assert.equal(checkSquare('from00', 1999), false);
  assert.equal(checkSquare('year', 1985, 1983), true);
  assert.equal(checkSquare('year', 1985, 1987), true);
  assert.equal(checkSquare('year', 1985, 1982), false);
  assert.equal(checkSquare('year', 1985, null), false);
  assert.equal(checkSquare('artist', 1985), null);
  assert.equal(checkSquare('title', 1985), null);
});

test('parseYearGuess accepteert alleen een jaartal', () => {
  assert.equal(parseYearGuess('1987'), 1987);
  assert.equal(parseYearGuess(' 2001 '), 2001);
  assert.equal(parseYearGuess('87'), null);
  assert.equal(parseYearGuess('19a7'), null);
  assert.equal(parseYearGuess('1850'), null);
  assert.equal(parseYearGuess(''), null);
});

test('generateCard: juiste mix, evenwichtig, deterministisch met seed', () => {
  for (const size of [3, 4]) {
    for (let seed = 1; seed <= 200; seed++) {
      const card = generateCard(size, seededRandom(seed));
      assert.equal(card.length, size * size);
      assert.ok(isBalanced(card, size), `kaart ${seed} evenwichtig`);
      const kinds = {};
      for (const k of card) kinds[SQUARES[k].kind] = (kinds[SQUARES[k].kind] || 0) + 1;
      assert.deepEqual(kinds, Object.fromEntries(Object.entries(MIX[size]).filter(([, v]) => v > 0)));
      // geen lijn met alleen makkelijke vakjes
      for (const line of lines(size)) assert.ok(line.some((i) => SQUARES[card[i]].tier >= 2));
    }
    assert.deepEqual(generateCard(size, seededRandom(5)), generateCard(size, seededRandom(5)));
  }
  assert.throws(() => generateCard(5));
});

test('generateCards: 30 unieke kaarten, zelfde seed geeft zelfde reeks', () => {
  for (const size of [3, 4]) {
    const a = generateCards(30, size, 123);
    assert.equal(new Set(a.map(cardSignature)).size, 30);
    assert.deepEqual(a, generateCards(30, size, 123));
    assert.notDeepEqual(a, generateCards(30, size, 124));
  }
});

test('findBingo, markCount en bestLine', () => {
  const m = Array(16).fill(null);
  assert.equal(findBingo(m, 4), null);
  [0, 5, 10].forEach((i) => { m[i] = 'x'; });
  assert.equal(findBingo(m, 4), null);
  assert.equal(bestLine(m, 4), 3);
  m[15] = 'x';
  assert.deepEqual(findBingo(m, 4), [0, 5, 10, 15]);
  assert.equal(markCount(m), 4);
  const col = Array(9).fill(null);
  [1, 4, 7].forEach((i) => { col[i] = 'y'; });
  assert.deepEqual(findBingo(col, 3), [1, 4, 7]);
});

test('createBingo: verschillende kaarten per speler, validatie', () => {
  const g = createBingo({ names: ['Ann', '', 'Cas', 'Dirk'], size: 4, cards, seed: 3 });
  assert.equal(g.players[1].name, 'Speler 2');
  assert.equal(new Set(g.players.map((p) => cardSignature(p.card))).size, 4);
  assert.ok(g.players.every((p) => p.marks.length === 16 && p.marks.every((x) => x === null)));
  assert.equal(new Set(g.pile).size, cards.length);
  assert.ok(isValidBingoState(g));
  assert.ok(!isValidBingoState({ ...g, size: 5 }));
  assert.ok(!isValidBingoState({}));
  assert.throws(() => createBingo({ names: ['solo'], cards }));
  assert.throws(() => createBingo({ names: Array(9).fill('x'), cards }));
  // zelfde seed -> zelfde potje
  assert.deepEqual(createBingo({ names: ['A', 'B'], cards, seed: 9 }), createBingo({ names: ['A', 'B'], cards, seed: 9 }));
});

function findIndex(p, pred) {
  return p.card.findIndex((k, i) => p.marks[i] == null && pred(k));
}

test('claim: goed stempelt, fout blijft open, ±2 met jaartal, groepsoordeel', () => {
  let g = createBingo({ names: ['A', 'B'], size: 4, cards, seed: 11 });
  g = startBingoTurn(g);
  const year = g.years[g.currentCard];
  const p = g.players[0];
  // jaar ±2 zonder geldig jaartal mag niet
  const yi = findIndex(p, (k) => k === 'year');
  assert.equal(canClaim(g, yi, ''), false);
  assert.throws(() => claimSquare(g, yi, '12'));
  const good = claimSquare(g, yi, String(year + 2));
  assert.equal(good.last.correct, true);
  assert.equal(good.players[0].marks[yi], g.currentCard);
  assert.equal(good.phase, 'reveal');
  const bad = claimSquare(g, yi, String(year + 3));
  assert.equal(bad.last.correct, false);
  assert.equal(bad.players[0].marks[yi], null);
  // stempel kan niet nog eens geclaimd worden
  let n = startBingoTurn(nextBingoPlayer(nextBingoPlayer(good)));
  assert.equal(n.current, 0);
  assert.equal(n.round, 2);
  assert.equal(canClaim(n, yi, '1990'), false);
  // artiest: groep beslist
  const ai = findIndex(n.players[0], (k) => k === 'artist');
  const j = claimSquare(n, ai);
  assert.equal(j.phase, 'judge');
  assert.equal(j.last.correct, null);
  assert.ok(isValidBingoState(j));
  const yes = judgeClaim(j, true);
  assert.equal(yes.last.correct, true);
  assert.equal(yes.players[0].marks[ai], n.currentCard);
  const no = judgeClaim(j, false);
  assert.equal(no.players[0].marks[ai], null);
  assert.throws(() => judgeClaim(yes, true));
});

test('volledig potje: speler die alles goed heeft wint met een volle lijn', () => {
  let g = createBingo({ names: ['A', 'B', 'C'], size: 3, cards, seed: 42 });
  const seen = new Set();
  let guard = 0;
  while (g.phase !== 'won' && guard++ < 100) {
    g = startBingoTurn(g);
    if (g.phase === 'won') break;
    assert.ok(!seen.has(g.currentCard));
    seen.add(g.currentCard);
    const year = g.years[g.currentCard];
    const p = g.players[g.current];
    let idx;
    if (g.current === 0) {
      // A kiest een vakje dat klopt (artiest/titel: groep zegt goed)
      idx = findIndex(p, (k) => checkSquare(k, year, year) !== false);
    } else {
      idx = findIndex(p, (k) => checkSquare(k, year, year + 10) === false);
      if (idx < 0) idx = findIndex(p, () => true);
    }
    g = claimSquare(g, idx, String(g.current === 0 ? year : year + 10));
    if (g.phase === 'judge') g = judgeClaim(g, g.last.player === 0);
    if (g.phase !== 'won') g = nextBingoPlayer(g);
  }
  assert.equal(g.phase, 'won');
  assert.deepEqual(g.winners, [0]);
  assert.ok(g.winLine.every((i) => g.players[0].marks[i] != null));
});

test('muziek op: meeste vakjes wint (gelijk = gedeeld)', () => {
  let g = createBingo({ names: ['A', 'B'], size: 4, cards: cards.slice(0, 4), seed: 1 });
  let guard = 0;
  while (g.phase !== 'won' && guard++ < 20) {
    g = startBingoTurn(g);
    if (g.phase === 'won') break;
    const p = g.players[g.current];
    const idx = findIndex(p, (k) => k === 'artist');
    g = judgeClaim(claimSquare(g, idx), true);
    if (g.phase !== 'won') g = nextBingoPlayer(g);
  }
  assert.equal(g.phase, 'won');
  assert.equal(g.endedBy, 'pile');
  assert.deepEqual(g.winners, [0, 1]);
});

test('echte deck: alle kaarten passen in minstens één decennium en periode-check klopt', () => {
  const deck = JSON.parse(readFileSync(new URL('../../app/data/deck.json', import.meta.url), 'utf8'));
  for (const c of deck.cards) {
    const decades = ['d60', 'd70', 'd80', 'd90', 'd00', 'd10'].filter((k) => checkSquare(k, c.year));
    assert.equal(decades.length, 1, `${c.id} (${c.year}) valt in precies één decennium`);
  }
});
