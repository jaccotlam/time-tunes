// Discobingo rules (app/js/multi/disco.js): cards, lines and goals, the balanced bag, the
// automatic placement, the late joiner's head start, the two year checks and the goals after a bingo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_KEYS, CENTER, CENTER_KEY, LINES, generateDiscoCard, isValidCard, uniqueDiscoCard, discoSignature,
  freshMarks, completeLines, reachedGoal, goalCells, stampedCount, bestSquare, openSquares, lateMarks, bestLineCount,
  drawCategory, freshBag, yearRight, exactRight, normalizeWin, FREE_MARK, MAX_SAME_PER_LINE, CATEGORIES, nextGoals,
  AUTO_REVEAL_MS, OLD_CATEGORY_KEYS,
} from '../../app/js/multi/disco.js';
import { seededRandom } from '../../app/js/logic.js';

test('categorieën: vaste sleutels en volgorde', () => {
  assert.deepEqual(CATEGORY_KEYS, ['exact', 'artist', 'year', 'title']);
  assert.equal(LINES.length, 12);
  assert.deepEqual(OLD_CATEGORY_KEYS, ['decade']);
  // four clearly different colours; the two year categories never share a colour, name or css variable
  assert.equal(new Set(CATEGORIES.map((c) => c.color)).size, 4);
  const exact = CATEGORIES.find((c) => c.key === 'exact');
  const year = CATEGORIES.find((c) => c.key === 'year');
  assert.equal(exact.label, 'Exact jaar');
  assert.notEqual(exact.color, year.color);
  assert.notEqual(exact.short, year.short);
  assert.equal(exact.cssVar, '--cat-exact');
});

test('doelen na een bingo: 1 lijn -> 2 lijnen of vol; 2 lijnen -> vol; vol is het eind', () => {
  assert.deepEqual(nextGoals('line1'), ['line2', 'full']);
  assert.deepEqual(nextGoals('line2'), ['full']);
  assert.deepEqual(nextGoals('full'), []);
  assert.deepEqual(nextGoals('onzin'), ['line2', 'full'], 'onbekend = 1 lijn');
  assert.equal(AUTO_REVEAL_MS, 4000);
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

test('jaartal ±2 en exact jaar (geen marge)', () => {
  assert.ok(yearRight(1982, 1984) && yearRight(1986, 1984));
  assert.ok(!yearRight(1981, 1984) && !yearRight(1987, 1984));
  assert.ok(exactRight(1984, 1984) && exactRight(1984, '1984'));
  assert.ok(!exactRight(1983, 1984) && !exactRight(1985, 1984), 'één jaar ernaast is fout');
  assert.ok(!exactRight('1984', 1984) && !exactRight(null, 1984), 'alleen een geheel getal');
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
    assert.ok(Math.max(c.exact, c.artist, c.title) - Math.min(c.exact, c.artist, c.title) <= 1, `seed ${seed}: de andere drie in balans ${JSON.stringify(c)}`);
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
