// "Mix van de groep" (app/js/multi/mix.js): choosing from the top songs, checking a
// contributed song, and building a game's songs from everybody's contributions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTopSelection, mixKey, cleanMixTrack, addToContribution, mixStats, mixMinimum, buildMix, MixError,
  MIX_PER_PLAYER, MIX_TOTAL, MIX_PER_MESSAGE, MIX_GAME_MAX, contributionTotal,
} from '../../app/js/multi/mix.js';
import { seededRandom } from '../../app/js/logic.js';

const sid = (p, i) => `${p}${String(i).padStart(21 - p.length + 1, '0')}`.slice(0, 22).padEnd(22, 'x');
let uniq = 0;
function track(p, i, extra = {}) {
  uniq++;
  return {
    spotifyId: sid(p, i), title: `${p} titel ${i}`, artist: `Artiest ${p}${i}`, year: 1970 + (i % 50),
    sure: true, itunesId: 5000 + uniq, previewUrl: `https://audio.example/${p}${i}.m4a`, ...extra,
  };
}
const list = (p, n, extra) => Array.from({ length: n }, (_, i) => track(p, i + 1, typeof extra === 'function' ? extra(i) : extra));

test('selectie uit de top: willekeurig, zonder dubbele, in de volgorde van de top', () => {
  const top = Array.from({ length: 50 }, (_, i) => ({ spotifyId: sid('t', i), title: `Nummer ${i}`, artist: `Band ${i}` }));
  top.push({ ...top[3] }); // twice in the list
  top.push({ spotifyId: sid('u', 1), title: 'Nummer 4 - Remastered 2011', artist: 'Band 4' }); // same song, other id
  const a = pickTopSelection(top, 15, seededRandom(1));
  const b = pickTopSelection(top, 15, seededRandom(2));
  assert.equal(a.length, 15);
  assert.equal(new Set(a.map((t) => t.spotifyId)).size, 15, 'geen dubbele');
  assert.notDeepEqual(a.map((t) => t.spotifyId), b.map((t) => t.spotifyId), 'niet elke keer dezelfde');
  const pos = a.map((t) => top.indexOf(t));
  assert.deepEqual(pos, pos.slice().sort((x, y) => x - y), 'volgorde van de top blijft');
  assert.equal(pickTopSelection(top.slice(0, 8), 15).length, 8, 'minder dan gevraagd: alles');
  assert.equal(pickTopSelection([], 15).length, 0);
  assert.equal(mixKey({ title: 'Africa - 2011 Remaster', artist: 'Toto, Someone' }), mixKey({ title: 'Africa', artist: 'TOTO' }));
});

test('bijdrage controleren: velden, grenzen, ongeldige weg', () => {
  const ok = cleanMixTrack({ spotifyId: 'a'.repeat(22), title: ' Hallo\u0000 ', artist: 'Band', year: 1984, sure: true, itunesId: 12, previewUrl: 'https://x.example/a.m4a', evil: '<script>' });
  assert.deepEqual(ok, { spotifyId: 'a'.repeat(22), title: 'Hallo', artist: 'Band', year: 1984, sure: true, itunesId: 12, previewUrl: 'https://x.example/a.m4a' });
  assert.equal(cleanMixTrack({ ...ok, spotifyId: 'kort' }), null, 'geen geldig Spotify-id');
  assert.equal(cleanMixTrack({ ...ok, year: 1800 }), null, 'jaar buiten bereik');
  assert.equal(cleanMixTrack({ ...ok, year: '1984x' }), null);
  assert.equal(cleanMixTrack({ ...ok, title: '' }), null, 'geen titel');
  assert.equal(cleanMixTrack([ok]), null);
  assert.equal(cleanMixTrack({ ...ok, previewUrl: 'javascript:alert(1)' }).previewUrl, undefined, 'alleen https-fragmenten');
  assert.equal(cleanMixTrack({ ...ok, sure: 'ja' }).sure, false);
  assert.equal(cleanMixTrack({ ...ok, title: 'x'.repeat(500) }).title.length, 200);

  let r = addToContribution([], [...list('a', 3), { title: 'kapot' }]);
  assert.equal(r.added, 3);
  assert.equal(r.refused, 1);
  r = addToContribution(r.list, list('a', 3));
  assert.equal(r.added, 0, 'nog eens hetzelfde sturen (na herverbinden) voegt niets toe');
  assert.equal(r.refused, 0);
  const many = list('m', MIX_PER_PLAYER + 10);
  let cur = [];
  for (let i = 0; i < many.length; i += MIX_PER_MESSAGE) cur = addToContribution(cur, many.slice(i, i + MIX_PER_MESSAGE)).list;
  assert.equal(cur.length, MIX_PER_PLAYER, `maximaal ${MIX_PER_PLAYER} per speler`);
  r = addToContribution([], list('z', MIX_PER_MESSAGE + 5));
  assert.equal(r.added, MIX_PER_MESSAGE, 'maximaal per bericht');
  assert.equal(r.refused, 5);
  r = addToContribution([], list('k', 5), { roomTotal: MIX_TOTAL - 2 });
  assert.equal(r.added, 2, `maximaal ${MIX_TOTAL} in de hele kamer`);
});

test('minimum per spel', () => {
  assert.equal(mixMinimum({ game: 'bingo', size: 3 }, 2), 10);
  assert.equal(mixMinimum({ game: 'bingo', size: 4 }, 3), 16);
  assert.equal(mixMinimum({ game: 'quiz', questions: 15 }, 3), 10, 'quiz: tien vragen');
  assert.equal(mixMinimum({ game: 'timeline', goal: 10 }, 3), 13);
  assert.equal(mixMinimum({ game: 'bingo', size: 3 }, 12), 14, 'nooit minder dan spelers + 2');
});

test('groepsmix: eerlijk verdeeld, ontdubbeld, zekere jaren eerst, geschud en voorspelbaar', () => {
  const contrib = {
    anna: { tracks: list('anna', 50) },
    bram: { tracks: list('bram', 10) },
    cas: { tracks: [...list('cas', 30, (i) => ({ sure: i >= 20 }))] }, // 20 unsure, 10 sure
  };
  // a song both Anna and Bram added (same id), and one with the same artist+title but another id
  contrib.bram.tracks.push({ ...contrib.anna.tracks[0] });
  contrib.cas.tracks.push({ ...contrib.anna.tracks[1], spotifyId: 'Z'.repeat(22), title: `${contrib.anna.tracks[1].title} - Remastered 2011` });
  const names = { anna: 'Anna', bram: 'Bram', cas: 'Cas' };
  const cards = buildMix(contrib, { seed: 7, need: 10, names });
  assert.equal(cards.length, Math.min(MIX_GAME_MAX, 27 + 10 + 27), 'quotum ceil(80/3)=27: Anna 27, Bram 10, Cas 27');
  const from = (p) => cards.filter((c) => c.from[0] === p).length;
  assert.equal(from('bram'), 10 + 0, 'Bram geeft al zijn eigen nummers (de dubbele telt bij Anna)');
  assert.ok(from('anna') <= 27 && from('cas') <= 27, `niemand boven het quotum (${from('anna')}, ${from('cas')})`);
  assert.equal(new Set(cards.map((c) => c.spotifyId)).size, cards.length, 'geen dubbele id');
  assert.equal(new Set(cards.map((c) => mixKey(c))).size, cards.length, 'geen dubbele artiest+titel');
  const shared = cards.find((c) => c.spotifyId === contrib.anna.tracks[0].spotifyId);
  if (shared) assert.deepEqual(shared.by, ['Anna', 'Bram'], 'dubbel nummer: van allebei');
  // the same rule, but with a deck so small that the shared song is always picked (no conditional)
  const dup = buildMix({ anna: { tracks: list('d', 3) }, bram: { tracks: [...list('d', 1), ...list('e', 2)] } }, { seed: 7, need: 5, names: { anna: 'Anna', bram: 'Bram' } });
  assert.equal(dup.length, 5);
  assert.deepEqual(dup.find((c) => c.spotifyId === list('d', 1)[0].spotifyId)?.by, ['Anna', 'Bram'], 'dubbel nummer: van allebei');
  const casCards = cards.filter((c) => c.from[0] === 'cas');
  assert.ok(casCards.filter((c) => !c.unsure).length >= 10, 'Cas: alle zekere jaren zitten erin');
  assert.equal(casCards.length, 27);
  assert.deepEqual(buildMix(contrib, { seed: 7, need: 10, names }).map((c) => c.spotifyId), cards.map((c) => c.spotifyId), 'zelfde zaad = zelfde lijst');
  assert.notDeepEqual(buildMix(contrib, { seed: 8, need: 10, names }).map((c) => c.spotifyId), cards.map((c) => c.spotifyId));
  assert.ok(cards.every((c) => /^m\d+$/.test(c.id) && c.year && c.title && c.artist));

  // a small game: the quota of the less-than-cap case
  const few = buildMix({ a: { tracks: list('p', 40) }, b: { tracks: list('q', 4) } }, { seed: 1, need: 10, max: 20 });
  assert.equal(few.length, 14, 'quotum 10 per speler: a 10, b 4 (niet aangevuld tot 20, want 14 is genoeg)');
  assert.equal(few.filter((c) => c.from[0] === 'b').length, 4, 'wie weinig heeft, doet volledig mee');
  // quota grows when the game would otherwise be short
  const grow = buildMix({ a: { tracks: list('r', 30) }, b: { tracks: list('s', 2) } }, { seed: 1, need: 25, max: 30 });
  assert.ok(grow.length >= 25, `quotum groeit tot het minimum gehaald is (${grow.length})`);
});

test('groepsmix: alleen speelbare nummers per muziekbron; te weinig nummers geeft een uitleg', () => {
  const contrib = { a: { tracks: [...list('a', 6), ...list('n', 6, { itunesId: undefined, previewUrl: undefined })] } };
  const spotifyCards = buildMix(contrib, { source: 'spotify', need: 10 });
  assert.equal(spotifyCards.length, 12, 'Spotify-bron: ook nummers zonder fragment');
  assert.throws(() => buildMix(contrib, { source: 'preview', need: 10 }), (e) => e instanceof MixError && e.have === 6 && e.need === 10 && /Te weinig/.test(e.message));
  const prev = buildMix(contrib, { source: 'preview', need: 5 });
  assert.ok(prev.every((c) => c.previewUrl || c.itunesId), 'fragment-bron: alleen met Apple Music-match');
  assert.throws(() => buildMix({}, { need: 1 }), MixError);
  assert.deepEqual(mixStats(contrib), { total: 12, preview: 6, sure: 12, contributors: 1 });
  assert.equal(contributionTotal(contrib), 12);
});
