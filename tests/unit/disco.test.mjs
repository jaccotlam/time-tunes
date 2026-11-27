// Discobingo rules (app/js/multi/disco.js): cards, lines and goals, the balanced bag, the
// automatic placement, the late joiner's head start and the decades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_KEYS, CENTER, CENTER_KEY, LINES, generateDiscoCard, isValidCard, uniqueDiscoCard, discoSignature,
  freshMarks, completeLines, reachedGoal, goalCells, stampedCount, bestSquare, openSquares, lateMarks, bestLineCount,
  drawCategory, freshBag, decadesFor, decadeLabel, decadeOf, yearRight, normalizeWin, FREE_MARK, MAX_SAME_PER_LINE,
} from '../../app/js/multi/disco.js';
import { seededRandom } from '../../app/js/logic.js';

test('categorieën: vaste sleutels en volgorde', () => {
  assert.deepEqual(CATEGORY_KEYS, ['decade', 'artist', 'year', 'title']);
  assert.equal(LINES.length, 12);
});

test('kaart: 5×5, vrije ster in het midden, 6 per categorie, nooit meer dan 2 per lijn (veel seeds)', () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const card = generateDiscoCard(seededRandom(seed));
    assert.equal(card.length, 25);
    assert.equal(card[CENTER], CENTER_KEY);
    for (const k of CATEGORY_KEYS) assert.equal(card.filter((x) => x === k).length, 6, `seed ${seed}: 6× ${k}`);
    for (const l of LINES) for (const k of CATEGORY_KEYS) assert.ok(l.filter((i) => card[i] === k).length <= MAX_SAME_PER_LINE, `seed ${seed}: spreiding`);
    assert.ok(isValidCard(card));
  }
});

test('kaart: zelfde seed = zelfde kaart; twaalf spelers krijgen allemaal een andere', () => {
  assert.deepEqual(generateDiscoCard(seededRandom(9)), generateDiscoCard(seededRandom(9)));
  const rand = seededRandom(3);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const c = uniqueDiscoCard(rand, seen);
    assert.ok(!seen.has(discoSignature(c)));
    seen.add(discoSignature(c));
  }
  assert.equal(seen.size, 12);
  const bad = generateDiscoCard(seededRandom(1));
  bad[0] = bad[0] === 'year' ? 'title' : 'year';
  assert.equal(isValidCard(bad), false, 'telling klopt niet meer');
});

test('lijnen en doelen: 1 lijn, 2 lijnen, volle kaart; het midden telt mee', () => {
  const m = freshMarks();
  assert.equal(m[CENTER], FREE_MARK);
  assert.equal(stampedCount(m), 0, 'het midden telt niet als gestempeld vakje');
  assert.equal(reachedGoal(m, 'line1'), false);
  for (const i of [10, 11, 13, 14]) m[i] = 's';
  assert.equal(completeLines(m).length, 1, 'middelste rij met de ster');
  assert.equal(reachedGoal(m, 'line1'), true);
  assert.equal(reachedGoal(m, 'line2'), false);
  assert.deepEqual(goalCells(m, 'line1'), [10, 11, 12, 13, 14]);
  for (const i of [2, 7, 17, 22]) m[i] = 's';
  assert.equal(reachedGoal(m, 'line2'), true, 'rij + kolom');
  assert.equal(reachedGoal(m, 'full'), false);
  assert.deepEqual(goalCells(m, 'full'), []);
  const full = Array(25).fill('s');
  assert.equal(reachedGoal(full, 'full'), true);
  assert.equal(goalCells(full, 'full').length, 25);
  assert.equal(normalizeWin('nonsense'), 'line1');
  assert.equal(normalizeWin('full'), 'full');
});

test('beste vakje: maakt een lijn af als dat kan, anders de volste lijn; vast; null zonder open vakje', () => {
  const card = generateDiscoCard(seededRandom(5));
  const cat = card[0] === CENTER_KEY ? card[1] : card[0];
  const marks = freshMarks();
  const open = openSquares(card, marks, cat);
  assert.equal(open.length, 6);
  const target = open[open.length - 1];
  // fill a line through target except target itself
  const line = LINES.find((l) => l.includes(target));
  for (const i of line) if (i !== target) marks[i] = 's';
  assert.equal(bestSquare(card, marks, cat, 'line1'), target, 'het vakje dat de lijn afmaakt');
  assert.equal(bestSquare(card, marks, cat, 'line1'), bestSquare(card, marks.slice(), cat, 'line1'), 'deterministisch');
  const all = marks.map((x, i) => (card[i] === cat ? 's' : x));
  assert.equal(bestSquare(card, all, cat), null);
  // without any progress: the square on most lines through the centre wins over a corner-free one
  const fresh = freshMarks();
  const pick = bestSquare(card, fresh, cat);
  assert.ok(openSquares(card, fresh, cat).includes(pick));
});

test('laat instappen: zoveel gratis vakjes, nooit meer dan 3 in één lijn (midden telt mee)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const n = seed % 9;
    const m = lateMarks(n, seededRandom(seed));
    assert.equal(stampedCount(m), n, `seed ${seed}`);
    assert.ok(bestLineCount(m) <= 3);
    assert.equal(m[CENTER], FREE_MARK);
  }
});

test('decennia en jaartal ±2', () => {
  assert.deepEqual(decadesFor([1984, 1961, 2003]), [1960, 1970, 1980, 1990, 2000], 'zonder gaten, van oud naar nieuw');
  assert.deepEqual(decadesFor([]), []);
  assert.equal(decadeOf(1989), 1980);
  assert.deepEqual(decadeLabel(1980), { decade: 1980, label: 'Jaren 80', sub: '1980–1989' });
  assert.equal(decadeLabel(2000).label, 'Jaren 00');
  assert.equal(decadeLabel(2010).label, 'Jaren 10');
  assert.deepEqual(decadeLabel(1900), { decade: 1900, label: '1900–1909', sub: '' }, 'vóór 1930: geen botsing met de jaren 00');
  assert.equal(decadeLabel(1920).label, '1920–1929');
  assert.equal(decadeLabel(1930).label, 'Jaren 30');
  const labels = decadesFor([1900, 2029]).map((d) => decadeLabel(d).label);
  assert.equal(new Set(labels).size, labels.length, 'nooit twee knoppen met hetzelfde opschrift');
  assert.ok(yearRight(1982, 1984) && yearRight(1986, 1984));
  assert.ok(!yearRight(1981, 1984) && !yearRight(1987, 1984));
});

function draws(n, seed, usable = () => true, state = freshBag()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = drawCategory(state, seed, usable);
    out.push(r.cat);
    state = r.state;
  }
  return { out, state };
}
const counts = (list) => Object.fromEntries(CATEGORY_KEYS.map((k) => [k, list.filter((x) => x === k).length]));

test('zak: na 4, 8, 12 … rondes elke categorie even vaak; nooit twee keer dezelfde achter elkaar', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { out } = draws(40, seed);
    for (let i = 1; i < out.length; i++) assert.notEqual(out[i], out[i - 1], `seed ${seed}: herhaling bij ronde ${i + 1}`);
    for (let k = 4; k <= 40; k += 4) assert.deepEqual(Object.values(counts(out.slice(0, k))), [k / 4, k / 4, k / 4, k / 4], `seed ${seed} na ${k}`);
  }
  assert.deepEqual(draws(20, 7).out, draws(20, 7).out, 'zelfde seed = zelfde volgorde');
  assert.notDeepEqual(draws(20, 7).out, draws(20, 8).out);
});

test('zak: een categorie zonder open vakje wordt overgeslagen en komt meteen terug zodra het weer kan', () => {
  for (let seed = 1; seed <= 100; seed++) {
    let st = freshBag();
    const seq = [];
    // rounds 1-12: nobody has a 'year' square open
    for (let i = 0; i < 12; i++) { const r = drawCategory(st, seed, (k) => k !== 'year'); seq.push(r.cat); st = r.state; }
    assert.ok(!seq.includes('year'), `seed ${seed}`);
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
    const c = counts(seq);
    assert.ok(Math.max(c.decade, c.artist, c.title) - Math.min(c.decade, c.artist, c.title) <= 1, `seed ${seed}: de andere drie in balans ${JSON.stringify(c)}`);
    // 'year' usable again: it is owed, so it comes within the next two rounds
    const next = [];
    for (let i = 0; i < 2; i++) { const r = drawCategory(st, seed); next.push(r.cat); st = r.state; }
    assert.ok(next.includes('year'), `seed ${seed}: jaartal komt terug ${next}`);
    assert.ok(st.bag.length <= 8, 'de zak blijft klein');
  }
});

test('zak: alleen de vorige is bruikbaar -> toch die; niets bruikbaar -> toch een categorie', () => {
  let st = drawCategory(freshBag(), 1, (k) => k === 'title').state;
  assert.equal(st.last, 'title');
  const again = drawCategory(st, 1, (k) => k === 'title');
  assert.equal(again.cat, 'title', 'liever een herhaling dan een dode ronde');
  const any = drawCategory(st, 1, () => false);
  assert.ok(CATEGORY_KEYS.includes(any.cat));
  assert.notEqual(any.cat, 'title', 'zonder bruikbare categorie nog steeds geen herhaling');
});
