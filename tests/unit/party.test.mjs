// The party extras in the game machine (game.js, protocol.js, party.js): avatars, the
// Discobingo streak, jokers, "snelste", the statistics and the awards. Everything is rebuilt
// from the snapshot taken at the reveal, so flips, decided doubts, moved chips, players who
// leave or come back, late joiners and "Nog een potje" can never leave it adrift; a fuzz run
// of random games checks the invariants against an independent recomputation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, addPlayer, removePlayer, startGame, submitAnswer, withdrawAnswer, reveal, overrideResult, nextRound,
  judgeResult, stampSquare, choosableSquares, jokerSquares, discoOutcome, fastestOf, discoSummary, setAvatar, playAgain,
  isValidRoom, backToLobby, withoutAnswerTimes, GameError, inBingoStop, finishGame, continueGame,
} from '../../app/js/multi/game.js';
import { nextGoals } from '../../app/js/multi/disco.js';
import { viewFor } from '../../app/js/multi/protocol.js';
import {
  AVATARS, REACTIONS, isAvatar, avatarFor, avatarOf, discoAwards, JOKER_CAP, JOKER_EVERY, AWARD_KINDS,
} from '../../app/js/multi/party.js';
import { CENTER, openSquares, CATEGORY_KEYS, squaresToGo, stampedCount } from '../../app/js/multi/disco.js';
import { seededRandom } from '../../app/js/logic.js';

const cards = Array.from({ length: 40 }, (_, i) => ({
  id: `s${String(i + 1).padStart(2, '0')}`, year: 1964 + i, title: `Geheime titel ${i + 1}`, artist: `Geheime artiest ${i + 1}`,
}));
const songOf = (r) => r.game.songs[r.game.current];

function discoRoom(names = ['Anouk', 'Bram', 'Cas'], settings = {}, seed = 11) {
  let r = createRoom({ code: 'ABCD', settings: { game: 'disco', ...settings } });
  names.forEach((n, i) => { r = addPlayer(r, { id: `p${i}`, name: n }); });
  return startGame(r, { cards, seed, now: 1000 });
}
/** This round's category forced (tests that need a typed round or a certain colour). */
const withCat = (r, cat) => ({ ...r, game: { ...r.game, disco: { ...r.game.disco, cat } } });

function answerOf(r, kind) {
  const song = songOf(r);
  const cat = r.game.disco.cat;
  if (kind === 'pass') return { pass: true };
  if (kind === 'doubt') {
    assert.ok(['artist', 'title'].includes(cat), 'een twijfel kan alleen bij artiest of titel');
    return { text: (cat === 'artist' ? song.artist : song.title).split(' ').slice(1).join(' ') };
  }
  const right = kind === 'right';
  switch (cat) {
    case 'exact': return { guess: right ? song.year : song.year + 1 };
    case 'year': return { guess: right ? song.year : song.year + 5 };
    case 'artist': return { text: right ? song.artist : 'Iets totaal anders' };
    default: return { text: right ? song.title : 'Iets totaal anders' };
  }
}
/** One round: plan {pid: 'right'|'wrong'|'pass'|'doubt'} (left out = no answer), answers at increasing times. */
function round(r, plan, { t0 = 10000, cat = null } = {}) {
  if (cat) r = withCat(r, cat);
  let t = t0;
  for (const [pid, kind] of Object.entries(plan)) r = submitAnswer(r, pid, answerOf(r, kind), { now: t += 100 });
  return reveal(r, { now: t + 1000 });
}
const fun = (r, pid) => r.game.per[pid];
/** Squares of another colour than the round's that are open for `pid` (from the snapshot). */
const otherSquares = (r, pid) => r.game.prev[pid].card.map((k, i) => i).filter((i) => r.game.prev[pid].marks[i] == null && r.game.prev[pid].card[i] !== r.game.disco.cat && i !== CENTER);

/* ---------- avatars ---------- */

test('avatars: vaste lijst van ~30, geen vlaggen, huidskleuren of samengestelde emoji; stabiel afgeleid van het id', () => {
  assert.ok(AVATARS.length >= 28 && AVATARS.length <= 32);
  assert.equal(new Set(AVATARS).size, AVATARS.length);
  for (const a of [...AVATARS, ...REACTIONS.filter((x) => x !== '❤️')]) {
    const cps = [...a].map((c) => c.codePointAt(0));
    assert.equal(cps.length, 1, `${a}: één teken`);
    assert.ok(!(cps[0] >= 0x1f1e6 && cps[0] <= 0x1f1ff), 'geen vlag');
    assert.ok(!(cps[0] >= 0x1f3fb && cps[0] <= 0x1f3ff), 'geen huidskleur');
  }
  assert.equal(REACTIONS.length, 6);
  assert.equal(avatarFor('playerA1'), avatarFor('playerA1'));
  assert.ok(isAvatar(avatarFor('x')) && isAvatar(avatarFor('')));
  assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarFor)).size > 3, 'verschillende ids, verschillende plaatjes');
  assert.equal(avatarOf({ id: 'q', avatar: '<b>' }), avatarFor('q'), 'een vervalst plaatje wordt nooit getoond');
});

test('avatars: bij binnenkomst gekozen of afgeleid, alleen in de lobby te wijzigen, overal in de weergave', () => {
  let r = createRoom({ code: 'ABCD', host: { id: 'host1', name: 'Ilse' }, settings: { game: 'disco' } });
  assert.equal(r.players[0].avatar, avatarFor('host1'));
  r = addPlayer(r, { id: 'p0', name: 'Anouk', avatar: '🦄' });
  r = addPlayer(r, { id: 'p1', name: 'Bram', avatar: 'kat' });
  r = addPlayer(r, { id: 'p2', name: 'Cas', avatar: AVATARS[0] + AVATARS[1] });
  assert.equal(r.players[1].avatar, '🦄');
  assert.equal(r.players[2].avatar, avatarFor('p1'), 'ongeldig: afgeleid');
  assert.equal(r.players[3].avatar, avatarFor('p2'));
  r = addPlayer(r, { id: 'p0', name: 'Anouk', avatar: '🐸' });
  assert.equal(r.players[1].avatar, '🦄', 'terugkomen verandert het plaatje niet (dat doet setAvatar)');
  assert.throws(() => setAvatar(r, 'p0', 'kat'), (e) => e instanceof GameError && e.code === 'avatar');
  assert.throws(() => setAvatar(r, 'nobody', '🐸'), (e) => e.code === 'avatar');
  r = setAvatar(r, 'p0', '🐸');
  assert.equal(r.players[1].avatar, '🐸');
  assert.equal(setAvatar(r, 'p0', '🐸'), r, 'hetzelfde: niets verandert');
  r = startGame(r, { cards, seed: 3, now: 1 });
  assert.throws(() => setAvatar(r, 'p0', '🦊'), /lobby/);
  r = round(r, { p0: 'right', p1: 'wrong' });
  for (const who of ['p0', 'p1', 'host1', '!spectator']) {
    const v = viewFor(r, who, {});
    assert.equal(v.players.find((p) => p.id === 'p0').avatar, '🐸');
    assert.ok(v.players.every((p) => isAvatar(p.avatar)));
    assert.ok(v.game.disco.progress.every((p) => isAvatar(p.avatar)));
    assert.ok(v.game.reveal.results.every((p) => isAvatar(p.avatar)));
  }
  assert.equal(viewFor(r, 'p0', {}).you.avatar, '🐸');
  // the quiz ranking too
  let q = createRoom({ code: 'ABCD', settings: { game: 'quiz' } });
  q = addPlayer(q, { id: 'p0', name: 'A', avatar: '🐙' });
  q = startGame(q, { cards, seed: 1, now: 1 });
  q = reveal(q, { now: 2 });
  assert.equal(viewFor(q, 'p0', {}).game.quiz.ranking[0].avatar, '🐙');
});

/* ---------- streak ---------- */

test('reeks: goed telt op, fout / weet ik niet / geen antwoord stopt hem; omdraaien rekent opnieuw', () => {
  let r = discoRoom();
  r = round(r, { p0: 'right', p1: 'right', p2: 'right' });
  assert.deepEqual(['p0', 'p1', 'p2'].map((p) => fun(r, p).streak), [1, 1, 1]);
  r = nextRound(r, { now: 2 });
  r = round(r, { p0: 'right', p1: 'wrong', p2: 'pass' });
  assert.deepEqual(['p0', 'p1', 'p2'].map((p) => fun(r, p).streak), [2, 0, 0]);
  const v = viewFor(r, '!spectator', {});
  assert.equal(v.game.reveal.results.find((x) => x.id === 'p0').streak, 2);
  assert.equal(v.game.disco.progress.find((x) => x.id === 'p0').streak, 2);
  assert.equal(viewFor(r, 'p0', {}).game.mine.streak, 2);
  // the host flips: the streak follows the verdict as it is now, in both directions
  r = overrideResult(r, 'p0');
  assert.equal(fun(r, 'p0').streak, 0);
  r = overrideResult(r, 'p0');
  assert.equal(fun(r, 'p0').streak, 2);
  r = overrideResult(r, 'p1');
  assert.equal(fun(r, 'p1').streak, 2, 'fout omgedraaid naar goed: reeks loopt door');
  r = nextRound(r, { now: 3 });
  // p0 does not answer (away): no streak kept
  r = round(r, { p1: 'right' });
  assert.equal(fun(r, 'p0').streak, 0, 'weg geweest = geen reeks');
  assert.equal(fun(r, 'p1').streak, 3);
  assert.equal(fun(r, 'p0').stats.best, 2, 'de langste reeks blijft staan');
  assert.equal(fun(r, 'p1').stats.best, 3);
});

test('reeks: een twijfel breekt of verlengt hem niet tot de spelleider beslist', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  r = nextRound(round(r, { p0: 'right', p1: 'right' }), { now: 2 });
  r = round(r, { p0: 'doubt', p1: 'right' }, { cat: 'title' });
  assert.equal(r.game.results.p0.verdict, 'doubt');
  assert.equal(fun(r, 'p0').streak, 1, 'onbeslist: zoals hij was');
  assert.equal(viewFor(r, 'p0', {}).game.mine.streak, 1);
  assert.equal(fun(r, 'p0').stats.doubts, 1);
  assert.equal(fun(r, 'p0').stats.answers, 2);
  assert.equal(fun(r, 'p0').stats.right, 1);
  r = judgeResult(r, 'p0', true);
  assert.equal(fun(r, 'p0').streak, 2);
  assert.equal(fun(r, 'p0').stats.right, 2);
  r = judgeResult(r, 'p0', false);
  assert.equal(fun(r, 'p0').streak, 0);
  assert.equal(fun(r, 'p0').stats.doubts, 1, 'een twijfelgeval blijft een twijfelgeval');
});

/* ---------- jokers ---------- */

/** p0 right for `n` rounds in a row (everything else wrong), chip placed automatically. */
function streakOf(n, r = discoRoom(['Anouk', 'Bram'])) {
  for (let i = 0; i < n; i++) {
    r = round(r, { p0: 'right', p1: 'wrong' });
    if (i < n - 1) r = nextRound(r, { now: 100 + i });
  }
  return r;
}

test('joker: verdiend bij een reeks van 3, 6, 9 …; hooguit 2 in de hand; "verdiend" alleen in die ronde', () => {
  let r = streakOf(2, discoRoom(['Anouk', 'Bram'], { win: 'full' }));
  assert.equal(fun(r, 'p0').jokers, 0);
  r = nextRound(r, { now: 1 });
  r = round(r, { p0: 'right' });
  assert.equal(fun(r, 'p0').streak, JOKER_EVERY);
  assert.equal(fun(r, 'p0').jokers, 1);
  const mine = viewFor(r, 'p0', {}).game.mine;
  assert.equal(mine.jokers, 1);
  assert.equal(mine.jokerEarned, true);
  assert.equal(viewFor(r, '!spectator', {}).game.disco.progress.find((x) => x.id === 'p0').jokers, 1, 'het aantal is openbaar (tv)');
  assert.equal(viewFor(r, 'p1', {}).game.reveal.results.find((x) => x.id === 'p0').jokerEarned, true);
  r = nextRound(r, { now: 2 });
  assert.equal(viewFor(r, 'p0', {}).game.mine.jokerEarned, false, 'de volgende ronde niet meer');
  assert.equal(viewFor(r, 'p0', {}).game.mine.jokers, 1);
  r = streakOf(3, r);
  assert.equal(fun(r, 'p0').jokers, 2);
  r = streakOf(3, nextRound(r, { now: 3 }));
  assert.equal(fun(r, 'p0').streak, 9);
  assert.equal(fun(r, 'p0').jokers, JOKER_CAP, 'nooit meer dan 2');
  assert.equal(discoOutcome(r.game, 'p0').earned, false, 'met 2 in de hand niets verdiend');
  assert.equal(viewFor(r, 'p0', {}).game.mine.jokerEarned, false);
});

test('joker: inzetten op een andere kleur, terugzetten, terugnemen en fout gedraaid geven hem terug; nooit automatisch', () => {
  let r = streakOf(3);
  assert.equal(fun(r, 'p0').jokers, 1);
  const own = choosableSquares(r.game, 'p0');
  const other = otherSquares(r, 'p0');
  assert.deepEqual(jokerSquares(r.game, 'p0'), other, 'de joker van deze ronde mag meteen');
  assert.deepEqual(viewFor(r, 'p0', {}).game.disco.jokerSquares, other);
  assert.deepEqual(viewFor(r, 'p1', {}).game.disco.jokerSquares, [], 'fout: geen joker');
  assert.throws(() => stampSquare(r, 'p0', other[0]), (e) => e.code === 'answer', 'zonder joker-vlag: alleen de eigen kleur');
  assert.throws(() => stampSquare(r, 'p0', CENTER, { joker: true }), /open vakje/);
  r = stampSquare(r, 'p0', other[0], { joker: true });
  assert.equal(fun(r, 'p0').marks[other[0]], r.game.current);
  assert.equal(fun(r, 'p0').jokers, 0);
  assert.equal(fun(r, 'p0').stats.jokersUsed, 1);
  assert.equal(viewFor(r, 'p0', {}).game.mine.jokerSpent, true);
  assert.equal(viewFor(r, '!spectator', {}).game.reveal.results.find((x) => x.id === 'p0').jokerSpent, true);
  assert.equal(viewFor(r, '!spectator', {}).game.reveal.results.find((x) => x.id === 'p0').stamped, other[0]);
  // moved back to the round's colour (with or without the flag): returned
  r = stampSquare(r, 'p0', own[0], { joker: true });
  assert.equal(fun(r, 'p0').jokers, 1);
  assert.equal(fun(r, 'p0').marks[other[0]], null);
  assert.equal(fun(r, 'p0').stats.jokersUsed, 0);
  r = stampSquare(r, 'p0', other[1], { joker: true });
  assert.equal(fun(r, 'p0').jokers, 0);
  r = stampSquare(r, 'p0', null);
  assert.equal(fun(r, 'p0').jokers, 1, 'teruggenomen');
  // flipped to wrong after the joker was spent: chip and joker back; right again: choose again
  r = stampSquare(r, 'p0', other[1], { joker: true });
  r = overrideResult(r, 'p0');
  assert.equal(fun(r, 'p0').jokers, 0, 'fout: reeks weg, dus ook de joker van deze ronde');
  assert.equal(stampedCount(fun(r, 'p0').marks), stampedCount(r.game.prev.p0.marks));
  r = overrideResult(r, 'p0');
  assert.equal(fun(r, 'p0').jokers, 1);
  assert.equal(r.game.disco.choices.p0, undefined);
  // no choice at the end of the round: placed on the round's colour, the joker stays
  r = nextRound(r, { now: 50 });
  assert.equal(fun(r, 'p0').jokers, 1, 'automatisch plaatsen zet nooit een joker in');
  assert.ok(stampedCount(fun(r, 'p0').marks) > stampedCount(discoRoom(['Anouk', 'Bram']).game.per.p0.marks));
});

test('joker: een eerder verdiende joker op een andere kleur; zonder joker geweigerd; ook als de eigen kleur vol is', () => {
  let r = streakOf(3);
  r = nextRound(r, { now: 1 });
  r = round(r, { p0: 'wrong', p1: 'right' });
  assert.equal(fun(r, 'p0').jokers, 1, 'een joker blijft na een fout antwoord');
  assert.deepEqual(jokerSquares(r.game, 'p0'), [], 'maar alleen inzetten met een goed antwoord');
  assert.throws(() => stampSquare(r, 'p1', otherSquares(r, 'p1')[0], { joker: true }), (e) => e.code === 'joker');
  r = nextRound(r, { now: 2 });
  // the round's colour has no open square left on p0's card: the joker can still go elsewhere
  const cat = r.game.disco.cat;
  const s = r.game.per.p0;
  const marks = s.marks.map((m, i) => (s.card[i] === cat ? '*' : m));
  r = { ...r, game: { ...r.game, per: { ...r.game.per, p0: { ...s, marks } } } };
  r = round(r, { p0: 'right' });
  assert.deepEqual(choosableSquares(r.game, 'p0'), []);
  assert.equal(viewFor(r, 'p0', {}).game.disco.noSquare, true);
  const other = jokerSquares(r.game, 'p0');
  assert.ok(other.length > 0);
  r = stampSquare(r, 'p0', other[0], { joker: true });
  assert.equal(fun(r, 'p0').jokers, 0);
  // a card with no open square at all: nothing to choose, the joker stays
  const full = r.game.prev.p0.card.map((k, i) => (i === other[0] ? null : '*'));
  let r2 = nextRound(stampSquare(r, 'p0', null), { now: 3 });
  r2 = { ...r2, game: { ...r2.game, per: { ...r2.game.per, p0: { ...r2.game.per.p0, marks: full.map((m, i) => (i === other[0] ? '*' : m)), jokers: 1 } } } };
  r2 = round(r2, { p0: 'right' });
  assert.deepEqual(jokerSquares(r2.game, 'p0'), []);
  assert.throws(() => stampSquare(r2, 'p0', 0, { joker: true }), /open vakje/);
});

test('joker en reeks na weggaan, terugkomen, verwijderen, laat instappen en nog een potje', () => {
  let r = streakOf(3, discoRoom(['Anouk', 'Bram', 'Cas']));
  r = nextRound(r, { now: 1 });
  // p0 is away for a round (no answer): streak gone, joker kept
  r = round(r, { p1: 'right' });
  assert.equal(fun(r, 'p0').streak, 0);
  assert.equal(fun(r, 'p0').jokers, 1);
  r = addPlayer(r, { id: 'p0', name: 'Anouk' }); // back on the same seat
  assert.equal(fun(r, 'p0').jokers, 1);
  // a late joiner during the reveal: a fresh start, also in the snapshot
  r = addPlayer(r, { id: 'late', name: 'Laat' });
  assert.deepEqual([fun(r, 'late').streak, fun(r, 'late').jokers], [0, 0]);
  r = stampSquare(r, 'p1', choosableSquares(r.game, 'p1')[0]);
  assert.deepEqual([fun(r, 'late').streak, fun(r, 'late').jokers, fun(r, 'late').stats.answers], [0, 0, 0], 'herberekenen houdt de nieuwe bij nul');
  r = removePlayer(r, 'p2');
  assert.equal(r.game.per.p2, undefined);
  r = nextRound(r, { now: 2 });
  r = round(r, { p0: 'right', late: 'right' });
  assert.equal(fun(r, 'late').streak, 1);
  // a new game: everything from zero
  r = playAgain({ ...r, phase: 'won' }, { cards, seed: 5, now: 9 });
  for (const id of Object.keys(r.game.per)) assert.deepEqual([fun(r, id).streak, fun(r, id).jokers, fun(r, id).stats.right], [0, 0, 0]);
});

/* ---------- snelste ---------- */

test('snelste: het vroegste goede antwoord op de servertijd; wijzigen zet de tijd opnieuw; gelijke ms: wie eerst binnen was', () => {
  let r = discoRoom();
  r = submitAnswer(r, 'p0', answerOf(r, 'right'), { now: 500 });
  r = submitAnswer(r, 'p1', answerOf(r, 'wrong'), { now: 100 });
  r = submitAnswer(r, 'p2', answerOf(r, 'right'), { now: 600 });
  r = submitAnswer(r, 'p0', answerOf(r, 'right'), { now: 700 }); // changed (the same answer again): a new time
  assert.equal(fastestOf(reveal(r).game), 'p2');
  r = withdrawAnswer(r, 'p2');
  r = submitAnswer(r, 'p2', answerOf(r, 'right'), { now: 800 });
  let rv = reveal(r);
  assert.equal(rv.game.disco.fastest, 'p0');
  const v = viewFor(rv, '!spectator', {});
  assert.deepEqual(v.game.disco.fastest, { id: 'p0', name: 'Anouk', avatar: avatarFor('p0') });
  assert.deepEqual(v.game.reveal.results.map((x) => x.fastest), [true, false, false]);
  assert.equal(fun(rv, 'p0').stats.fastest, 1);
  // the same ms: the one that arrived first
  let t = discoRoom();
  t = submitAnswer(t, 'p1', answerOf(t, 'right'), { now: 300 });
  t = submitAnswer(t, 'p0', answerOf(t, 'right'), { now: 300 });
  assert.equal(fastestOf(reveal(t).game), 'p1');
  // the holder flipped to wrong: the next right one by time
  rv = overrideResult(rv, 'p0');
  assert.equal(rv.game.disco.fastest, 'p2');
  assert.equal(fun(rv, 'p0').stats.fastest, 0);
  assert.equal(fun(rv, 'p2').stats.fastest, 1);
  // the holder removed: rebuilt without them
  rv = overrideResult(rv, 'p0');
  rv = removePlayer(rv, 'p0');
  assert.equal(rv.game.disco.fastest, 'p2');
  // nobody right: no badge
  let w = discoRoom();
  w = submitAnswer(w, 'p0', answerOf(w, 'wrong'), { now: 1 });
  assert.equal(reveal(w).game.disco.fastest, null);
  assert.equal(viewFor(reveal(w), 'p0', {}).game.disco.fastest, null);
});

test('snelste: een twijfel die later goed wordt neemt de badge niet af; zonder houder krijgt de eerst goedgekeurde hem', () => {
  let r = withCat(discoRoom(), 'title');
  r = submitAnswer(r, 'p0', answerOf(r, 'doubt'), { now: 100 });
  r = submitAnswer(r, 'p1', answerOf(r, 'right'), { now: 200 });
  r = submitAnswer(r, 'p2', answerOf(r, 'wrong'), { now: 50 });
  r = reveal(r);
  assert.equal(r.game.disco.fastest, 'p1');
  r = judgeResult(r, 'p0', true); // earlier, but decided later
  assert.equal(r.game.disco.fastest, 'p1', 'Bram houdt hem');
  r = overrideResult(r, 'p2'); // wrong flipped to right, earliest of all
  assert.equal(r.game.disco.fastest, 'p1', 'ook een omgedraaid fout antwoord niet');
  assert.equal(fun(r, 'p1').stats.fastest, 1);
  assert.equal(fun(r, 'p0').stats.fastest + fun(r, 'p2').stats.fastest, 0);
  // Bram flipped to wrong: the first one the host made right (Anouk) gets it
  r = overrideResult(r, 'p1');
  assert.equal(r.game.disco.fastest, 'p0');
  // two doubts, nobody right by the machine: the first one decided keeps it
  let d = withCat(discoRoom(), 'title');
  d = submitAnswer(d, 'p0', answerOf(d, 'doubt'), { now: 100 });
  d = submitAnswer(d, 'p1', answerOf(d, 'doubt'), { now: 50 });
  d = reveal(d);
  assert.equal(d.game.disco.fastest, null, 'onbeslist: nog niemand');
  d = judgeResult(d, 'p0', true);
  assert.equal(d.game.disco.fastest, 'p0');
  d = judgeResult(d, 'p1', true);
  assert.equal(d.game.disco.fastest, 'p0', 'Bram was eerder, maar werd later goedgekeurd');
  d = judgeResult(d, 'p0', true); // Goed again: keeps its place
  assert.equal(d.game.disco.fastest, 'p0');
  d = judgeResult(d, 'p0', false);
  assert.equal(d.game.disco.fastest, 'p1');
  d = judgeResult(d, 'p0', true);
  assert.equal(d.game.disco.fastest, 'p1', 'opnieuw goedgekeurd: achteraan');
});

/* ---------- statistics and awards ---------- */

const P = (id, stats, extra = {}) => ({ id, name: id.toUpperCase(), avatar: avatarFor(id), stats, winner: false, toGo: 3, ...extra });

test('prijzen: volgorde, gedeelde houders, minimums, overslaan wat niemand verdiende, deterministisch', () => {
  const players = [
    P('a', { answers: 10, right: 8, doubts: 2, fastest: 3, best: 5, jokersUsed: 1 }, { winner: true, toGo: 0 }),
    P('b', { answers: 10, right: 4, doubts: 2, fastest: 3, best: 2, jokersUsed: 0 }, { toGo: 1 }),
    P('c', { answers: 5, right: 4, doubts: 0, fastest: 0, best: 5, jokersUsed: 0 }, { toGo: 1 }),
    P('d', { answers: 2, right: 2, doubts: 0, fastest: 0, best: 2, jokersUsed: 0 }, { toGo: 2 }),
  ];
  const aw = discoAwards(players);
  assert.deepEqual(aw.map((x) => x.kind), AWARD_KINDS);
  const by = Object.fromEntries(aw.map((x) => [x.kind, x]));
  assert.deepEqual(by.fastest.holders.map((h) => h.id), ['a', 'b'], 'gelijk = gedeeld');
  assert.equal(by.fastest.title, 'Snelste vingers');
  assert.deepEqual(by.streak.holders.map((h) => h.id), ['a', 'c']);
  assert.equal(by.streak.value, 5);
  assert.deepEqual(by.doubts.holders.map((h) => h.id), ['a', 'b']);
  assert.deepEqual(by.sharp.holders.map((h) => h.id), ['a', 'c'], '8/10 = 4/5; Daan heeft te weinig antwoorden');
  assert.equal(by.sharp.value, 80);
  assert.deepEqual(by.close.holders.map((h) => h.id), ['b', 'c'], 'de winnaar niet');
  assert.equal(by.close.value, 1);
  assert.ok(aw.every((x) => x.emoji && x.title && x.text && x.holders.every((h) => isAvatar(h.avatar))));
  assert.deepEqual(discoAwards(players), aw, 'deterministisch');
  assert.deepEqual(discoAwards(JSON.parse(JSON.stringify(players))), aw);
  // nobody earned anything: no awards at all
  const zero = [P('a', {}, { winner: true, toGo: 0 }), P('b', {}, { toGo: 7 })];
  assert.deepEqual(discoAwards(zero), []);
  // minimums: a streak of 1, a share below half, 3 squares to go
  const low = [P('a', { answers: 4, right: 1, best: 1 }, { toGo: 3 }), P('b', { answers: 3, right: 1, best: 1 }, { toGo: 3 })];
  assert.deepEqual(discoAwards(low), []);
  assert.deepEqual(discoAwards([]), []);
  assert.deepEqual(discoAwards(null), []);
});

test('statistieken en prijzen in de weergave zodra er gewonnen is (spelers, spelleider, tv), niet eerder', () => {
  let r = discoRoom(['Anouk', 'Bram']);
  for (let i = 0; i < 40 && r.phase !== 'won'; i++) {
    const t = 1000 * i;
    r = submitAnswer(r, 'p0', answerOf(r, 'right'), { now: t + 1 });
    r = submitAnswer(r, 'p1', answerOf(r, i % 2 ? 'right' : 'wrong'), { now: t + 2 });
    r = reveal(r, { now: t + 3 });
    assert.equal(viewFor(r, 'p0', {}).game.disco.awards, null);
    assert.equal(viewFor(r, 'p0', {}).game.disco.stats, null);
    r = nextRound(r, { now: t + 4 });
    if (inBingoStop(r)) {
      assert.equal(viewFor(r, 'p0', {}).game.disco.awards, null, 'tijdens de bingostop nog geen prijzen');
      r = finishGame(r);
    }
  }
  assert.equal(r.phase, 'won');
  const s = discoSummary(r);
  const a = s.stats.find((x) => x.id === 'p0');
  assert.equal(a.right, a.answers);
  assert.equal(a.fastest, a.answers, 'Anouk was steeds de eerste');
  assert.equal(a.best, a.answers);
  for (const who of ['p0', 'p1', '!spectator']) {
    const d = viewFor(r, who, {}).game.disco;
    assert.deepEqual(d.stats, s.stats);
    assert.deepEqual(d.awards, s.awards);
  }
  const kinds = s.awards.map((x) => x.kind);
  assert.ok(kinds.includes('fastest') && kinds.includes('streak') && kinds.includes('sharp'));
  assert.ok(!kinds.includes('doubts'), 'geen twijfelgevallen: geen twijfelkoning');
  assert.equal(squaresToGo(r.game.per.p0.marks, 'line1'), 0);
});

/* ---------- stored rooms ---------- */

test('een kamer van de vorige versie (zonder plaatjes, reeksen, jokers, tijden) laadt en speelt verder', () => {
  let r = discoRoom();
  r = round(r, { p0: 'right', p1: 'wrong' });
  // strip everything this version added
  const old = JSON.parse(JSON.stringify(r));
  for (const p of old.players) delete p.avatar;
  for (const k of ['per', 'prev']) for (const s of Object.values(old.game[k])) { delete s.streak; delete s.jokers; delete s.stats; }
  for (const k of ['times', 'seq', 'judged', 'fastest']) delete old.game.disco[k];
  assert.ok(isValidRoom(old));
  const v = viewFor(old, 'p0', {});
  assert.equal(v.players[0].avatar, avatarFor('p0'));
  assert.equal(v.game.mine.streak, 0);
  assert.equal(v.game.mine.jokers, 0);
  assert.equal(v.game.disco.fastest, null);
  let n = stampSquare(old, 'p0', choosableSquares(old.game, 'p0')[0]);
  assert.equal(n.game.per.p0.streak, 1, 'herberekend uit de momentopname');
  assert.equal(n.game.disco.fastest, null, 'zonder tijd geen snelste');
  n = nextRound(n, { now: 5 });
  n = round(n, { p0: 'right' });
  assert.equal(n.game.per.p0.streak, 2);
  assert.equal(n.game.disco.fastest, 'p0');
  // a forged stored room: absurd numbers are cleaned, a bad times map is refused
  const forged = JSON.parse(JSON.stringify(r));
  forged.game.per.p0.jokers = 99;
  forged.game.per.p0.streak = -4;
  assert.equal(viewFor(forged, 'p0', {}).game.mine.jokers, JOKER_CAP);
  assert.equal(viewFor(forged, 'p0', {}).game.mine.streak, 0);
  forged.game.disco.times = JSON.parse('{"__proto__": {"at": 1}}');
  assert.equal(isValidRoom(forged), false);
  // the owner's backup during a question carries no answer times
  let q = discoRoom();
  q = submitAnswer(q, 'p0', answerOf(q, 'right'), { now: 77 });
  assert.deepEqual(withoutAnswerTimes(q).game.disco.times, {});
  const rq = reveal(q);
  assert.equal(withoutAnswerTimes(rq), rq, 'na de onthulling blijft alles');
  assert.ok(isValidRoom(backToLobby(q)));
});

/* ---------- fuzz ---------- */

test('fuzz: willekeurige spellen houden jokers, reeksen, stempels en prijzen kloppend', () => {
  const seen = { spent: 0, earned: 0, won: 0, fastest: 0, awards: 0 };
  for (let run = 0; run < 60; run++) {
    const rand = seededRandom(run * 7919 + 1);
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    let r = discoRoom(['A', 'B', 'C', 'D'].slice(0, 2 + (run % 3)), { win: pick(['line1', 'line2', 'full']) }, run + 1);
    // the independent model: streak and jokers per player, from the final verdict of every round
    let model = Object.fromEntries(Object.keys(r.game.per).map((id) => [id, { streak: 0, jokers: 0, best: 0, used: 0 }]));
    let t = 1;
    let late = 0;
    for (let step = 0; step < 400; step++) {
      const ids = Object.keys(r.game.per);
      const act = rand();
      try {
        if (r.phase === 'answering') {
          if (act < 0.7) {
            const id = pick(ids);
            const cat = r.game.disco.cat;
            const kind = pick(['right', 'right', 'wrong', 'pass', ...(['artist', 'title'].includes(cat) ? ['doubt'] : [])]);
            r = submitAnswer(r, id, answerOf(r, kind), { now: t += Math.floor(rand() * 3) });
          } else if (act < 0.75) r = withdrawAnswer(r, pick(ids));
          else if (act < 0.78 && late < 2) r = addPlayer(r, { id: `late${late++}`, name: 'Laat' });
          else r = reveal(r, { now: t++ });
        } else if (r.phase === 'revealed') {
          if (act < 0.25) r = judgeResult(r, pick(ids), rand() < 0.6);
          else if (act < 0.55) {
            const id = pick(ids);
            const joker = rand() < 0.5;
            const js = jokerSquares(r.game, id);
            const at = rand() < 0.1 ? null : js.length && rand() < 0.5 ? pick(js) : Math.floor(rand() * 25);
            r = stampSquare(r, id, at, { joker });
          } else if (act < 0.58 && ids.length > 2) {
            const id = pick(ids);
            r = removePlayer(r, id);
            delete model[id];
          } else {
            // the round ends: the model takes the final verdicts and where the chips lie
            const before = r;
            // a bingo stop: go on for a higher goal or stop (both end the round), else the next round
            if (inBingoStop(r)) {
              const goals = nextGoals(r.game.disco.win);
              r = goals.length && rand() < 0.6 ? continueGame(r, pick(goals), { now: t++ }) : finishGame(r);
            } else r = nextRound(r, { now: t++ });
            // an automatic chip that made bingo keeps the round open (the stop): it ends later
            const ended = !(r.phase === 'revealed' && r.game.round === before.game.round);
            const cur = before.game.current;
            for (const id of ended ? Object.keys(before.game.prev) : []) {
              const m = (model[id] ??= { streak: 0, jokers: 0, best: 0, used: 0 });
              const right = !!before.game.results[id]?.correct;
              m.streak = right ? m.streak + 1 : 0;
              m.best = Math.max(m.best, m.streak);
              if (right && m.streak % JOKER_EVERY === 0 && m.jokers < JOKER_CAP) m.jokers++;
              // where the chip lay at the end of the round: of another colour = a joker spent
              const at = r.game.per[id] ? r.game.per[id].marks.indexOf(cur) : -1;
              const spent = at >= 0 && before.game.prev[id].card[at] !== before.game.disco.cat;
              if (spent) { m.jokers--; m.used++; seen.spent++; }
            }
          }
        } else if (r.phase === 'won') {
          const a = discoSummary(r);
          seen.won++;
          seen.awards += a.awards.length;
          assert.deepEqual(discoSummary(JSON.parse(JSON.stringify(r))), a, 'prijzen deterministisch');
          assert.ok(a.awards.every((x) => x.holders.length > 0));
          assert.equal(new Set(a.awards.map((x) => x.kind)).size, a.awards.length, 'elke prijs hooguit één keer');
          r = playAgain(r, { cards, seed: run + step, now: t++ });
          model = Object.fromEntries(Object.keys(r.game.per).map((id) => [id, { streak: 0, jokers: 0, best: 0, used: 0 }]));
          late = 0;
        }
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
      }
      // invariants, after every step
      assert.ok(isValidRoom(r), `run ${run} stap ${step}: geldige kamer`);
      for (const [id, s] of Object.entries(r.game.per)) {
        assert.ok(Number.isInteger(s.jokers) && s.jokers >= 0 && s.jokers <= JOKER_CAP, 'jokers binnen 0..2');
        if (r.phase === 'answering') {
          const m = model[id] || { streak: 0, jokers: 0, best: 0, used: 0 };
          assert.equal(s.streak, m.streak, `run ${run} stap ${step}: reeks van ${id} = herberekening`);
          assert.equal(s.jokers, m.jokers, `run ${run} stap ${step}: jokers van ${id}`);
          assert.equal(s.stats.best, m.best);
          assert.equal(s.stats.jokersUsed, m.used);
        }
      }
      if (r.phase === 'revealed') {
        for (const id of Object.keys(r.game.prev)) {
          const o = discoOutcome(r.game, id);
          const at = r.game.per[id].marks.findIndex((x) => x === r.game.current);
          const otherColour = at >= 0 && r.game.prev[id].card[at] !== r.game.disco.cat;
          assert.equal(otherColour, o.spent, 'een fiche op een andere kleur heeft altijd een joker achter zich');
          if (otherColour) assert.ok(o.available >= 1 && r.game.per[id].jokers === o.available - 1);
          if (o.earned) seen.earned++;
          assert.ok(at < 0 || r.game.results[id]?.correct, 'alleen goed = een fiche');
        }
        const f = r.game.disco.fastest;
        if (f) { assert.ok(r.game.results[f]?.correct, 'snelste is altijd goed'); seen.fastest++; }
      }
      for (const id of [...Object.keys(r.game.per), '!spectator']) JSON.stringify(viewFor(r, id, {}));
    }
  }
  if (process.env.FUZZ_LOG) console.log(seen);
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `de fuzz kwam langs: ${k}`);
});

test('ids als "__proto__" krijgen geen joker, tijd of plaatje', () => {
  let r = discoRoom();
  for (const id of ['__proto__', 'constructor']) {
    assert.throws(() => submitAnswer(r, id, answerOf(r, 'right')), GameError);
    assert.throws(() => setAvatar(r, id, '🐸'), GameError);
  }
  r = reveal(r);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(jokerSquares(r.game, id), []);
    assert.throws(() => stampSquare(r, id, 0, { joker: true }), GameError);
  }
  assert.equal(fastestOf(r.game), null);
  assert.ok(CATEGORY_KEYS.includes(r.game.disco.cat));
  assert.ok(openSquares(r.game.per.p0.card, r.game.per.p0.marks, r.game.disco.cat).length);
});
