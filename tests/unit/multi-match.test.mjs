import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchArtist, matchTitle, editDistance, allowedTypos } from '../../app/js/multi/match.js';

const ok = (r) => r.ok;

test('editDistance: invoegen, weglaten, vervangen en omwisselen tellen als één fout', () => {
  assert.equal(editDistance('queen', 'queen'), 0);
  assert.equal(editDistance('quen', 'queen'), 1);
  assert.equal(editDistance('qeeen', 'queen'), 1);
  assert.equal(editDistance('qeuen', 'queen'), 1);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(allowedTypos(4), 0);
  assert.equal(allowedTypos(8), 1);
  assert.equal(allowedTypos(14), 2);
  assert.equal(allowedTypos(30), 3);
});

test('titel: hoofdletters, accenten, leestekens en haakjes maken niet uit', () => {
  assert.ok(ok(matchTitle('dancing queen', 'Dancing Queen')));
  assert.ok(ok(matchTitle('DANCING  QUEEN!', 'Dancing Queen')));
  assert.ok(ok(matchTitle('Dont stop me now', "Don't Stop Me Now")));
  assert.ok(ok(matchTitle('Leef', 'Léef')));
  assert.ok(ok(matchTitle('Smells like teen spirit', 'Smells Like Teen Spirit (Remastered 2021)')));
  assert.ok(ok(matchTitle('Wonderwall', 'Wonderwall - Remastered')));
  assert.ok(ok(matchTitle('Let it be', 'Let It Be [Live]')));
  assert.ok(ok(matchTitle('Rockefeller Street', 'Rockefeller Street (feat. X)')));
});

test('titel: lidwoorden vooraan en "en"/"&" tellen niet', () => {
  assert.ok(ok(matchTitle('Final Countdown', 'The Final Countdown')));
  assert.ok(ok(matchTitle('the final countdown', 'Final Countdown')));
  assert.ok(ok(matchTitle('Zoutelande', 'Het Zoutelande')));
  assert.ok(ok(matchTitle('Rock and roll', 'Rock & Roll')));
  assert.ok(ok(matchTitle('Rock en roll', 'Rock & Roll')));
});

test('titel: kleine typefouten mogen, een ander nummer niet', () => {
  const r = matchTitle('Bohemian Rapsody', 'Bohemian Rhapsody');
  assert.ok(r.ok);
  assert.equal(r.doubt, true, 'goedgekeurde typefout is "twijfel" zodat de host kan kijken');
  assert.ok(ok(matchTitle('Dancing Qeen', 'Dancing Queen')));
  assert.ok(ok(matchTitle('Billie Jeans', 'Billie Jean')));
  assert.ok(!ok(matchTitle('Thriller', 'Billie Jean')));
  assert.ok(!ok(matchTitle('Dancing King', 'Dancing Queen')));
  assert.ok(!ok(matchTitle('Song 3', 'Song 2')), 'ander getal is fout');
  assert.ok(!ok(matchTitle('Testnummer 1', 'Testnummer 12')));
  assert.ok(!ok(matchTitle('1998', '1999')));
  assert.ok(!ok(matchTitle('', 'Dancing Queen')));
  assert.ok(!ok(matchTitle('   ', 'Dancing Queen')));
});

test('korte titels: geen typefout toegestaan', () => {
  assert.ok(ok(matchTitle('Hello', 'Hello')));
  assert.ok(!ok(matchTitle('Help', 'Hello')));
  assert.ok(ok(matchTitle('jump', 'Jump')));
  assert.ok(!ok(matchTitle('Jam', 'Jump')));
});

test('artiest: lidwoord, accenten, "&", en een van de artiesten is genoeg', () => {
  assert.ok(ok(matchArtist('Beatles', 'The Beatles')));
  assert.ok(ok(matchArtist('the beatles', 'Beatles')));
  assert.ok(ok(matchArtist('Beyonce', 'Beyoncé')));
  assert.ok(ok(matchArtist('simon and garfunkel', 'Simon & Garfunkel')));
  assert.ok(ok(matchArtist('Simon en Garfunkel', 'Simon & Garfunkel')));
  assert.ok(ok(matchArtist('Dua Lipa', 'Calvin Harris & Dua Lipa')));
  assert.ok(ok(matchArtist('calvin harris', 'Calvin Harris feat. Rihanna')));
  assert.ok(ok(matchArtist('Dijk', 'De Dijk')));
  assert.ok(ok(matchArtist('AC DC', 'AC/DC')));
  assert.ok(ok(matchArtist('Run DMC', 'Run-D.M.C.')));
});

test('artiest: typefouten afhankelijk van de lengte', () => {
  assert.ok(ok(matchArtist('Micheal Jackson', 'Michael Jackson')));
  assert.ok(ok(matchArtist('Madona', 'Madonna')));
  assert.ok(ok(matchArtist('Fleetwod Mac', 'Fleetwood Mac')));
  assert.ok(!ok(matchArtist('ABA', 'ABBA')), 'korte naam: precies');
  assert.ok(!ok(matchArtist('Toto', 'Tito')));
  assert.ok(!ok(matchArtist('Prince', 'Queen')));
  assert.ok(!ok(matchArtist('Madonna', 'Michael Jackson')));
  const near = matchArtist('Madnona', 'Madonna');
  assert.ok(near.ok || near.doubt, 'bijna goed is in elk geval twijfel');
});
