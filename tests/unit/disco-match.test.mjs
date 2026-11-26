// Discobingo: the three-way verdict of a typed artist / title (match.js artistVerdict /
// titleVerdict): right, doubt (the host decides) or wrong, with the sound-alike pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artistVerdict, titleVerdict, soundKey, matchArtist, matchTitle } from '../../app/js/multi/match.js';

const A = (g, t) => artistVerdict(g, t).verdict;
const T = (g, t) => titleVerdict(g, t).verdict;

test('goed: normalisatie, kleine typefouten en klinkt hetzelfde (voorbeelden uit de spec)', () => {
  assert.equal(A('Bruce Springstein', 'Bruce Springsteen'), 'right');
  assert.equal(A('Abba', 'ABBA'), 'right');
  assert.equal(A('abba', 'ABBA'), 'right');
  assert.equal(A('Guns n Roses', "Guns N' Roses"), 'right');
  assert.equal(A('Red Hot Chilli Peppers', 'Red Hot Chili Peppers'), 'right');
  assert.equal(A('Beyonce', 'Beyoncé'), 'right');
  assert.equal(A('Micheal Jackson', 'Michael Jackson'), 'right');
  assert.equal(A('Eminen', 'Eminem'), 'right');
  assert.equal(A('the beatles', 'Beatles'), 'right');
  assert.equal(A('Simon en Garfunkel', 'Simon & Garfunkel'), 'right');
  assert.equal(A('Rihanna', 'Drake feat. Rihanna'), 'right', 'een gastartiest is genoeg');
  assert.equal(A('calvin harris', 'Calvin Harris feat. Rihanna'), 'right');
  assert.equal(A('Calvin Harris & Dua Lipa', 'Calvin Harris & Dua Lipa'), 'right');
  assert.equal(T('Bohemian Rapsody', 'Bohemian Rhapsody'), 'right');
  assert.equal(T('Final Countdown', 'The Final Countdown'), 'right');
  assert.equal(T('Smells like teen spirit', 'Smells Like Teen Spirit (Remastered 2021)'), 'right');
  assert.equal(T('Sweet Child of Mine', "Sweet Child O' Mine"), 'right');
});

test('klinkt hetzelfde: dubbele letters, ph/f, ck/k/c, y/i/ij, z/s, th/t', () => {
  assert.equal(A('Fil Collins', 'Phil Collins'), 'right');
  assert.equal(A('ABA', 'ABBA'), 'right', 'een dubbele letter maakt het niet fout');
  assert.equal(A('Mikael Jakson', 'Michael Jackson'), 'right');
  assert.equal(A('Kylie Minogue', 'Kilie Minogue'), 'right');
  assert.equal(A('Marco Borsato', 'Marko Borsatto'), 'right');
  assert.equal(A('Zeeuwse', 'Seeuwse'), 'right');
  assert.equal(T('Tunderstruck', 'Thunderstruck'), 'right');
  assert.equal(soundKey('phillippe'), soundKey('filipe'));
  assert.equal(soundKey('ijs'), soundKey('ys'));
});

test('twijfel: net te veel fouten, alleen de achternaam of een deel van de bandnaam, woord te veel of te weinig, ander getal', () => {
  assert.equal(A('Springsteen', 'Bruce Springsteen'), 'doubt', 'alleen de achternaam');
  assert.equal(A('Springstein', 'Bruce Springsteen'), 'doubt', 'achternaam met typefout');
  assert.equal(A('Stones', 'The Rolling Stones'), 'doubt');
  assert.equal(A('Jackson', 'Michael Jackson'), 'doubt');
  assert.equal(A('Toto', 'Tito'), 'doubt', 'korte naam, één letter anders');
  assert.equal(T('Crazy Little Thing', 'Crazy Little Thing Called Love'), 'doubt', 'woorden te weinig');
  assert.equal(T('Smells like spirit', 'Smells Like Teen Spirit'), 'doubt', 'woord te weinig');
  assert.equal(T('Dont stop me now please', "Don't Stop Me Now"), 'doubt', 'woord te veel');
  assert.equal(T('Bohemian Rapsodie Queen', 'Bohemian Rhapsody'), 'doubt');
  assert.equal(T('Dancing King', 'Dancing Queen'), 'doubt', 'heel slecht gespeld of verkeerd verstaan: de spelleider beslist');
  assert.equal(T('Bohemmian Rapsodiee', 'Bohemian Rhapsody'), 'doubt', 'een typefout te veel');
});

test('getallen: nooit goed bij een ander getal (twijfel mag)', () => {
  for (const [g, t] of [['1998', '1999'], ['Song 3', 'Song 2'], ['Testnummer 1', 'Testnummer 12'], ['99 Luftballons', '98 Luftballons']]) {
    assert.notEqual(T(g, t), 'right', `${g} / ${t}`);
  }
  assert.equal(T('Song 3', 'Song 2'), 'doubt');
  assert.equal(T('Song 2', 'Song 2'), 'right');
  assert.equal(A('UB 40', 'UB40'), 'right');
  assert.notEqual(A('UB 44', 'UB40'), 'right');
});

test('fout: duidelijk iets anders (ook de klankregels maken dat niet goed)', () => {
  const wrong = [
    ['A', 'Prince', 'Queen'], ['A', 'Madonna', 'Michael Jackson'], ['A', 'Nirvana', 'Madonna'], ['A', 'Coldplay', 'Queen'],
    ['A', 'Kiss', 'Queen'], ['A', 'Adele', 'Abba'], ['A', 'Shakira', 'Rihanna'], ['A', 'Sting', 'Stromae'], ['A', 'Blur', 'Oasis'],
    ['A', 'The', 'The Beatles'], ['A', 'U2', 'UB40'], ['A', 'Cher', 'Shaggy'], ['A', 'Doe Maar', 'De Dijk'],
    ['T', 'Thriller', 'Billie Jean'], ['T', 'Jam', 'Jump'], ['T', 'Love', 'Crazy Little Thing Called Love'], ['T', 'You', 'I Will Always Love You'],
    ['T', 'Yesterday', 'Let It Be'], ['T', 'Imagine', 'Hello'], ['T', 'Zoutelande', 'Wonderwall'], ['T', 'Africa', 'Hotel California'],
    ['A', '', 'Queen'], ['A', '   ', 'Queen'], ['T', '!!!', 'Hello'],
  ];
  for (const [k, g, t] of wrong) assert.equal((k === 'A' ? A : T)(g, t), 'wrong', `${g} / ${t}`);
});

test('vorm van het oordeel; matchArtist / matchTitle blijven zoals ze waren', () => {
  const r = artistVerdict('Stones', 'The Rolling Stones');
  assert.deepEqual(Object.keys(r).sort(), ['doubt', 'ok', 'score', 'verdict']);
  assert.equal(r.ok, false);
  assert.equal(r.doubt, true);
  assert.ok(r.score >= 0 && r.score <= 1);
  assert.equal(artistVerdict('Abba', 'ABBA').ok, true);
  // classic room Bingo keeps its own (stricter) rule for short names
  assert.equal(matchArtist('ABA', 'ABBA').ok, false);
  assert.deepEqual(Object.keys(matchTitle('x', 'y')).sort(), ['doubt', 'ok', 'score']);
});

test('een deel van een duo of band met & / and / en / + / , is hooguit twijfel; een gastartiest is goed', () => {
  for (const [g, t] of [
    ['Wind', 'Earth, Wind & Fire'], ['Fire', 'Earth, Wind & Fire'], ['Earth', 'Earth, Wind & Fire'], ['Sons', 'Mumford & Sons'],
    ['Mumford', 'Mumford & Sons'], ['Gang', 'Kool & The Gang'], ['Kool', 'Kool & The Gang'], ['Oates', 'Hall & Oates'],
    ['Young', 'Crosby, Stills, Nash & Young'], ['Machine', 'Florence + The Machine'], ['Revolution', 'Prince & The Revolution'],
    ['Simon', 'Simon & Garfunkel'], ['Queen', 'Queen & David Bowie'], ['Dua Lipa', 'Calvin Harris & Dua Lipa'],
  ]) assert.equal(A(g, t), 'doubt', `${g} / ${t}`);
  assert.equal(A('Earth Wind and Fire', 'Earth, Wind & Fire'), 'right', 'de hele naam');
  assert.equal(A('Hall en Oates', 'Hall & Oates'), 'right');
  assert.equal(A('Florence and the Machine', 'Florence + The Machine'), 'right');
  assert.equal(A('Rihanna', 'Drake feat. Rihanna'), 'right');
  assert.equal(A('Drake', 'Drake feat. Rihanna'), 'right');
  assert.equal(A('Rihanna', 'Drake ft. Rihanna & Future'), 'right');
  assert.equal(A('Rihanna', 'Drake'), 'wrong');
  assert.equal(matchArtist('Wind', 'Earth, Wind & Fire').ok, true, 'klassieke Bingo blijft zoals hij was');
});

test('lidwoorden: een typefout in het lidwoord is goed; een gewoon woord weglaten is twijfel', () => {
  assert.equal(T('LaeBamba', 'La Bamba'), 'right');
  assert.equal(T('Lq Bamba', 'La Bamba'), 'right');
  assert.equal(T('Bamba', 'La Bamba'), 'doubt');
  assert.equal(T('Young', 'Die Young'), 'doubt');
  assert.equal(T('Another Day', 'Die Another Day'), 'doubt');
  assert.equal(T('Whiter Shade of Pale', 'A Whiter Shade of Pale'), 'right', 'lang genoeg: het lidwoord telt niet');
  assert.equal(T('Final Countdown', 'The Final Countdown'), 'right');
  assert.equal(T('The Final Countdown', 'Final Countdown'), 'right');
  assert.equal(T('Zoutelande', 'Het Zoutelande'), 'right');
  assert.equal(A('Beatles', 'The Beatles'), 'right');
  assert.equal(A('Dijk', 'De Dijk'), 'right');
  assert.equal(A('Ha', 'A-ha'), 'doubt');
  assert.equal(A('aha', 'A-ha'), 'right');
});
