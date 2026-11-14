import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCardId, normalizeCardInput, padId, cardUrl, isCorrectPlacement, correctSlots,
  shuffle, seededRandom, createGame, startTurn, placeCard, nextPlayer, isValidGameState,
} from '../../app/js/logic.js';

const cards = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1).padStart(3, '0'), year: 1960 + i }));

test('parseCardId haalt het id uit allerlei QR-teksten', () => {
  assert.equal(parseCardId('https://user.github.io/time-tunes/#/c/042'), '042');
  assert.equal(parseCardId('http://localhost:8080/#/c/7'), '7');
  assert.equal(parseCardId('https://x.y/index.html?a=1#/c/A1b'), 'A1b');
  assert.equal(parseCardId('#/c/120'), '120');
  assert.equal(parseCardId('https://example.com/'), null);
  assert.equal(parseCardId('#/c/'), null);
  assert.equal(parseCardId(null), null);
});

test('normalizeCardInput en padId', () => {
  assert.equal(normalizeCardInput('42'), '042');
  assert.equal(normalizeCardInput(' 7 '), '007');
  assert.equal(normalizeCardInput('#042'), '042');
  assert.equal(normalizeCardInput('0042'), '042');
  assert.equal(normalizeCardInput('https://a.b/#/c/5'), '005');
  assert.equal(normalizeCardInput(''), null);
  assert.equal(normalizeCardInput('4-2'), null);
  assert.equal(padId('1234'), '1234');
  assert.equal(padId('0'), '000');
});

test('cardUrl plakt de hash achter de basis-URL', () => {
  assert.equal(cardUrl('https://user.github.io/time-tunes/', '042'), 'https://user.github.io/time-tunes/#/c/042');
  assert.equal(cardUrl('https://user.github.io/time-tunes/#/print', '001'), 'https://user.github.io/time-tunes/#/c/001');
});

test('isCorrectPlacement: grenzen, midden en gelijke jaren', () => {
  const years = [1970, 1980, 1990];
  assert.equal(isCorrectPlacement(years, 0, 1965), true);
  assert.equal(isCorrectPlacement(years, 0, 1975), false);
  assert.equal(isCorrectPlacement(years, 1, 1975), true);
  assert.equal(isCorrectPlacement(years, 3, 2000), true);
  assert.equal(isCorrectPlacement(years, 3, 1985), false);
  // gelijk jaar telt aan beide kanten als goed
  assert.equal(isCorrectPlacement(years, 1, 1980), true);
  assert.equal(isCorrectPlacement(years, 2, 1980), true);
  assert.equal(isCorrectPlacement(years, 0, 1970), true);
  assert.equal(isCorrectPlacement(years, 4, 2000), false);
  assert.equal(isCorrectPlacement(years, -1, 1960), false);
  assert.equal(isCorrectPlacement([], 0, 1999), true);
  assert.deepEqual(correctSlots(years, 1980), [1, 2]);
  assert.deepEqual(correctSlots([1980, 1980], 1980), [0, 1, 2]);
});

test('shuffle is een permutatie en deterministisch met seed', () => {
  const ids = cards.map((c) => c.id);
  const a = shuffle(ids, seededRandom(1));
  const b = shuffle(ids, seededRandom(1));
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), [...ids].sort());
  assert.notDeepEqual(a, ids);
});

test('createGame: startkaarten, unieke stapel, validatie', () => {
  const g = createGame({ names: ['Ann', '', 'Cas'], goal: 5, cards, seed: 3 });
  assert.equal(g.players.length, 3);
  assert.equal(g.players[1].name, 'Speler 2');
  assert.ok(g.players.every((p) => p.timeline.length === 1));
  const all = [...g.pile, ...g.players.flatMap((p) => p.timeline)];
  assert.equal(new Set(all).size, cards.length);
  assert.throws(() => createGame({ names: ['solo'], cards }));
  assert.throws(() => createGame({ names: Array(9).fill('x'), cards }));
  assert.throws(() => createGame({ names: ['a', 'b'], cards: cards.slice(0, 2) }));
  assert.ok(isValidGameState(g));
  assert.ok(!isValidGameState({}));
});

test('beurt: goed blijft liggen, fout gaat weg, volgende speler', () => {
  let g = createGame({ names: ['A', 'B'], goal: 3, cards, seed: 9 });
  g = startTurn(g);
  const id = g.currentCard;
  const tl = g.players[0].timeline;
  const year = g.years[id];
  const goodSlot = year >= g.years[tl[0]] ? 1 : 0;
  const after = placeCard(g, goodSlot);
  assert.equal(after.last.correct, true);
  assert.equal(after.players[0].timeline.length, 2);
  assert.equal(after.phase, 'reveal');
  const n = nextPlayer(after);
  assert.equal(n.current, 1);
  let g2 = startTurn(n);
  const y2 = g2.years[g2.currentCard];
  const badSlot = y2 >= g2.years[g2.players[1].timeline[0]] ? 0 : 1;
  // badSlot is fout tenzij het jaar gelijk is (komt in deze fixture niet voor)
  const res = placeCard(g2, badSlot);
  assert.equal(res.last.correct, false);
  assert.equal(res.players[1].timeline.length, 1);
  assert.ok(!res.pile.includes(g2.currentCard));
  assert.equal(nextPlayer(res).round, 2);
});

test('volledig spel eindigt met winnaar en zonder herhaalde kaarten', () => {
  let g = createGame({ names: ['A', 'B', 'C'], goal: 4, cards, seed: 42 });
  const seen = new Set(g.players.flatMap((p) => p.timeline));
  let guard = 0;
  while (g.phase !== 'won' && guard++ < 200) {
    g = startTurn(g);
    if (g.phase === 'won') break;
    assert.ok(!seen.has(g.currentCard), 'kaart mag niet herhaald worden');
    seen.add(g.currentCard);
    const p = g.players[g.current];
    const years = p.timeline.map((id) => g.years[id]);
    // speler A raadt altijd goed, de rest altijd links
    const slot = g.current === 0 ? correctSlots(years, g.years[g.currentCard])[0] : 0;
    g = placeCard(g, slot);
    if (g.phase !== 'won') g = nextPlayer(g);
  }
  assert.equal(g.phase, 'won');
  assert.deepEqual(g.winners, [0]);
  assert.equal(g.players[0].timeline.length, 4);
  const years = g.players[0].timeline.map((id) => g.years[id]);
  assert.deepEqual(years, [...years].sort((a, b) => a - b));
});

test('lege stapel: langste tijdlijn wint', () => {
  let g = createGame({ names: ['A', 'B'], goal: 50, cards: cards.slice(0, 4), seed: 1 });
  let guard = 0;
  while (g.phase !== 'won' && guard++ < 20) {
    g = startTurn(g);
    if (g.phase === 'won') break;
    const years = g.players[g.current].timeline.map((id) => g.years[id]);
    g = placeCard(g, correctSlots(years, g.years[g.currentCard])[0]);
    g = nextPlayer(g);
  }
  assert.equal(g.phase, 'won');
  assert.equal(g.endedBy, 'pile');
  assert.deepEqual(g.winners, [0, 1]); // allebei 2 kaarten: gedeelde winst
});
