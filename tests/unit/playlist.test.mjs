import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine, parseLines, rankSearch, matchLine, pickYear, trackFromItunes, isCompilationAlbum,
  encodeCardCode, decodeCardCode, encodeShare, decodeShare, parseSpotifyPlaylistId, spotifyYear,
  migrateStore, cleanPlaylist, playlistDeck, exportPlaylist, importBackup, readiness, MIN_TRACKS, STORE_VERSION,
} from '../../app/js/playlist-logic.js';
import { parseCardId, normalizeCardInput, cardUrl } from '../../app/js/logic.js';

const r = (trackId, artistName, trackName, collectionName, year, extra = {}) => ({
  wrapperType: 'track', kind: 'song', trackId, artistName, trackName, collectionName,
  releaseDate: `${year}-01-01T12:00:00Z`, previewUrl: `https://audio.example/${trackId}.m4a`, trackViewUrl: `https://music.apple.com/nl/x?i=${trackId}`, ...extra,
});

test('parseLine: artiest - titel met optioneel jaartal', () => {
  assert.deepEqual(parseLine('ABBA - Dancing Queen'), { raw: 'ABBA - Dancing Queen', artist: 'ABBA', title: 'Dancing Queen', year: null, query: 'ABBA Dancing Queen' });
  assert.equal(parseLine('Queen - Bohemian Rhapsody, 1975').year, 1975);
  assert.equal(parseLine('Queen - Bohemian Rhapsody, 1975').title, 'Bohemian Rhapsody');
  assert.equal(parseLine('Queen - Bohemian Rhapsody (1975)').year, 1975);
  assert.equal(parseLine('Queen - Bohemian Rhapsody [1975]').year, 1975);
  assert.equal(parseLine('Prince - 1999').title, '1999', 'jaartal als titel blijft titel');
  assert.equal(parseLine('Prince - 1999').year, null);
  assert.equal(parseLine('Prince - 1999 (1982)').year, 1982);
  assert.equal(parseLine('Doe Maar – De Bom').artist, 'Doe Maar');
  assert.equal(parseLine('3. Doe Maar - De Bom').artist, 'Doe Maar', 'nummering weg');
  assert.equal(parseLine('- Doe Maar - De Bom').artist, 'Doe Maar', 'opsommingsteken weg');
  assert.equal(parseLine('Golden Earring\tRadar Love').title, 'Radar Love');
  assert.equal(parseLine('ABBA-Waterloo').title, 'Waterloo');
  assert.equal(parseLine('a-ha - Take On Me').artist, 'a-ha', 'streepje in de naam');
  assert.equal(parseLine('Jay-Z - Run-DMC - Walk This Way').title, 'Run-DMC - Walk This Way');
  const loose = parseLine('bohemian rhapsody queen');
  assert.equal(loose.artist, null);
  assert.equal(loose.query, 'bohemian rhapsody queen');
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('---'), null);
  assert.equal(parseLine('X - Y, 1066').year, null, 'onzinjaar wordt genegeerd');
});

test('parseLines: lege regels en dubbelen weg', () => {
  const lines = parseLines('ABBA - Waterloo\n\n  \nabba - waterloo\nQueen - Radio Ga Ga, 1984\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].year, 1984);
});

test('rankSearch: karaoke en tribute naar beneden', () => {
  const res = [
    r(1, 'Karaoke Hits Band', 'Dancing Queen (Karaoke Version)', 'Karaoke Classics', 2015),
    r(2, 'ABBA', 'Dancing Queen', 'Arrival', 1976),
    r(3, 'The ABBA Tribute Band', 'Dancing Queen', 'A Tribute to ABBA', 2010),
    r(4, 'ABBA', 'Dancing Queen (Live)', 'Live at Wembley Arena', 2014),
    { kind: 'music-video', trackId: 5, artistName: 'ABBA', trackName: 'Dancing Queen' },
  ];
  const ranked = rankSearch(res, 'Dancing Queen');
  assert.equal(ranked[0].trackId, 2);
  assert.ok(!ranked.some((x) => x.trackId === 5), 'geen video');
  assert.ok(ranked.find((x) => x.trackId === 1).junk >= 0.5);
  assert.ok(ranked.find((x) => x.trackId === 3).junk >= 0.5);
  assert.deepEqual(ranked.map((x) => x.trackId).slice(-2).sort(), [1, 3]);
});

test('matchLine: gevonden, twijfel en niet gevonden', () => {
  const res = [r(10, 'Karaoke Hits Band', 'Dancing Queen', 'Karaoke', 2015), r(11, 'ABBA', 'Dancing Queen', 'Arrival', 1976)];
  const m = matchLine(parseLine('ABBA - Dancing Queen'), res);
  assert.equal(m.status, 'found');
  assert.equal(m.best.trackId, 11);
  const swapped = matchLine(parseLine('Dancing Queen - ABBA'), res);
  assert.equal(swapped.best.trackId, 11, 'titel en artiest omgedraaid');
  const doubt = matchLine(parseLine('ABBA - Dancing Quen'), [r(11, 'ABBA', 'Dancing Queen (Remastered)', 'Arrival', 1976)]);
  assert.ok(['doubt', 'found'].includes(doubt.status));
  const other = matchLine(parseLine('Doe Maar - De Bom'), [r(20, 'Andere Artiest', 'Iets Anders', 'X', 1999)]);
  assert.equal(other.status, 'none');
  assert.equal(matchLine(parseLine('Doe Maar - De Bom'), []).status, 'none');
  const loose = matchLine(parseLine('de bom doe maar'), [r(21, 'Doe Maar', 'De Bom', 'Lijf aan Lijf', 1983)]);
  assert.equal(loose.status, 'doubt', 'zonder scheidingsteken nooit zeker');
});

test('pickYear: vroegste jaar van dezelfde opname, verzamelalbums en twijfel', () => {
  const orig = r(1, 'Queen', 'Bohemian Rhapsody', 'A Night At The Opera', 1975);
  const comp = r(2, 'Queen', 'Bohemian Rhapsody', 'Greatest Hits', 1981);
  const remaster = r(3, 'Queen', 'Bohemian Rhapsody (Remastered 2011)', 'A Night At The Opera (2011 Remaster)', 2011);
  const live = r(4, 'Queen', 'Bohemian Rhapsody (Live Aid)', 'Live Aid', 1985);
  const cover = r(5, 'Panic! At The Disco', 'Bohemian Rhapsody', 'Suicide Squad', 1960);
  // gekozen: de verzamel-versie; het vroegste jaar komt van het originele album
  const y = pickYear(comp, [orig, remaster, live, cover]);
  assert.deepEqual(y, { year: 1975, sure: true });
  // alleen een verzamelalbum: jaar wel, maar onzeker
  assert.deepEqual(pickYear(comp, [cover, live]), { year: 1981, sure: false });
  // twee verzamelalbums met hetzelfde jaar zijn het eens: zeker genoeg
  const comp2 = r(6, 'Queen', 'Bohemian Rhapsody', 'The Platinum Collection', 1981);
  assert.equal(pickYear(comp, [comp2]).sure, true);
  // een jaar van buiten (Spotify) telt mee; alleen zeker als een tweede bron het bevestigt
  assert.deepEqual(pickYear(comp, [], [1975]), { year: 1975, sure: false });
  assert.deepEqual(pickYear(comp, [], [1981]), { year: 1981, sure: true });
  assert.equal(isCompilationAlbum('ABBA Gold: Greatest Hits'), true);
  assert.equal(isCompilationAlbum('Arrival'), false);
  const t = trackFromItunes(comp, [orig]);
  assert.equal(t.year, 1975);
  assert.equal(t.itunesId, 2);
  assert.equal(trackFromItunes(comp, [orig], { year: 1999 }).year, 1999, 'opgegeven jaar wint');
  assert.equal(trackFromItunes(comp, [orig], { year: 1999 }).yearSure, true);
});

test('kaartcode: iTunes-id en jaar heen en terug, jaar niet leesbaar', () => {
  for (const [id, year] of [[1422648513, 1976], [1, 1900], [6781027645, 1975], [999999999999, 2099], [123, 1800]]) {
    const code = encodeCardCode(id, year);
    assert.match(code, /^~[0-9a-z]+$/);
    assert.deepEqual(decodeCardCode(code), { itunesId: id, year });
    assert.ok(!code.includes(String(year)), `jaar ${year} niet leesbaar in ${code}`);
  }
  const code = encodeCardCode(1422648513, 1976);
  assert.ok(code.length <= 12, `kort: ${code}`);
  // verkeerd getypt / beschadigd: controleteken
  const bad = code.slice(0, -1) + (code.at(-1) === 'a' ? 'b' : 'a');
  assert.equal(decodeCardCode(bad), null);
  assert.equal(decodeCardCode('042'), null);
  assert.equal(decodeCardCode('~'), null);
  assert.equal(decodeCardCode(null), null);
  assert.throws(() => encodeCardCode(0, 1976));
  assert.throws(() => encodeCardCode(5, 2300));
  // naastliggende jaren geven geen naastliggende codes die het jaar verraden
  assert.notEqual(encodeCardCode(1000, 1980).slice(0, -1), encodeCardCode(1001, 1980).slice(0, -1));
});

test('QR-parser: oude #/c/042 blijft werken, eigen kaart #/c/~code ook', () => {
  assert.equal(parseCardId('https://user.github.io/time-tunes/#/c/042'), '042');
  const code = encodeCardCode(1422648513, 1976);
  const url = cardUrl('https://user.github.io/time-tunes/', code);
  assert.equal(url, `https://user.github.io/time-tunes/#/c/${code}`);
  assert.equal(parseCardId(url), code);
  assert.deepEqual(decodeCardCode(parseCardId(url)), { itunesId: 1422648513, year: 1976 });
  assert.equal(normalizeCardInput(url), code);
  assert.equal(normalizeCardInput('42'), '042');
  assert.equal(parseCardId('https://x/#/c/~'), null);
});

test('deel-link: coderen en decoderen, splitsen voor QR', () => {
  const tracks = Array.from({ length: 120 }, (_, i) => ({ itunesId: 1400000000 + i * 7919, year: 1960 + (i % 60) }));
  tracks.push({ itunesId: null, spotifyId: '4uLU6hMCjMI75M1A2tKUQC', year: 1980 });
  const one = encodeShare({ name: 'Feestje bij Ö & Ü', tracks }, { shareId: 'abc123' });
  assert.equal(one.payloads.length, 1);
  assert.equal(one.shared, 120);
  assert.equal(one.skipped, 1);
  const d = decodeShare(`https://x.y/app/#/pl/${one.payloads[0]}`);
  assert.equal(d.name, 'Feestje bij Ö & Ü');
  assert.equal(d.shareId, 'abc123');
  assert.equal(d.part, 1);
  assert.equal(d.total, 1);
  assert.deepEqual(d.items, tracks.slice(0, 120));
  assert.ok(one.payloads[0].length < 120 * 11 + 40, `compact (${one.payloads[0].length} tekens)`);

  const parts = encodeShare({ name: 'Groot', tracks }, { maxLen: 400, shareId: 'zz9' + 'abc' });
  assert.ok(parts.payloads.length > 1);
  assert.ok(parts.payloads.every((p) => p.length <= 400));
  const back = parts.payloads.map(decodeShare);
  assert.ok(back.every((p, i) => p.part === i + 1 && p.total === parts.payloads.length && p.shareId === 'zz9abc'));
  assert.deepEqual(back.flatMap((p) => p.items), tracks.slice(0, 120));

  assert.equal(decodeShare('onzin'), null);
  assert.equal(decodeShare('1~abc123~2~1~QQ~abc12'), null, 'deel groter dan totaal');
  assert.equal(decodeShare('1~abc123~1~1~QQ~!!'), null);
  const empty = encodeShare({ name: 'Leeg', tracks: [] });
  assert.deepEqual(decodeShare(empty.payloads[0]).items, []);
});

test('Spotify-links en releasedatum', () => {
  assert.equal(parseSpotifyPlaylistId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('https://open.spotify.com/intl-nl/playlist/37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId(' 37i9dQZF1DXcBWIGoYBM5M '), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parseSpotifyPlaylistId('https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M'), null);
  assert.equal(parseSpotifyPlaylistId('nope'), null);
  assert.equal(spotifyYear('1981-12'), 1981);
  assert.equal(spotifyYear('0000'), null);
});

test('opslag: migratie, opschonen, dubbele nummers, deck-formaat', () => {
  assert.deepEqual(migrateStore(null), { v: STORE_VERSION, lists: [] });
  assert.deepEqual(migrateStore('kapot'), { v: STORE_VERSION, lists: [] });
  // losse array (oud/handgemaakt) met rommel
  const m = migrateStore([
    { id: 'a', name: '  Feest  ', tracks: [
      { itunesId: 5, title: 'X', artist: 'Y', year: 1980 },
      { trackId: '6', trackName: 'Z', artistName: 'W', year: '1990' },
      { title: 'zonder id' },
      { n: 1, itunesId: 7, title: 'dubbel n', year: 3000 },
    ] },
    { id: 'a', name: '', tracks: [] },
    'rommel',
    { id: 'builtin', name: 'mag niet' },
  ]);
  assert.equal(m.lists.length, 3);
  assert.equal(m.lists[0].name, 'Feest');
  assert.equal(m.lists[1].name, 'Mijn playlist');
  assert.notEqual(m.lists[0].id, m.lists[1].id, 'id uniek');
  assert.notEqual(m.lists[2].id, 'builtin');
  const t = m.lists[0].tracks;
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => x.itunesId), [5, 6, 7]);
  assert.equal(t[1].year, 1990);
  assert.equal(t[2].year, null, 'ongeldig jaar weg');
  assert.equal(new Set(t.map((x) => x.n)).size, 3, 'kaartnummers uniek');
  assert.ok(m.lists[0].nextN > Math.max(...t.map((x) => x.n)));
  // huidige vorm blijft gelijk
  const again = migrateStore({ v: 1, lists: m.lists });
  assert.deepEqual(again, migrateStore(again));

  const deck = playlistDeck(m.lists[0]);
  assert.equal(deck.kind, 'playlist');
  assert.equal(deck.cards.length, 2, 'zonder jaar niet in het deck');
  const c = deck.byId.get(deck.cards[0].id);
  assert.deepEqual(Object.keys(c).sort(), ['artist', 'code', 'id', 'itunesId', 'previewUrl', 'title', 'trackViewUrl', 'year'].sort());
  assert.deepEqual(decodeCardCode(c.code), { itunesId: c.itunesId, year: c.year });
  assert.match(c.id, /^\d{3}$/);
});

test('export en import van een back-up', () => {
  const p = cleanPlaylist({ id: 'x', name: 'Back-up', tracks: [{ itunesId: 9, title: 'T', artist: 'A', year: 1971, yearSure: false, spotifyId: '4uLU6hMCjMI75M1A2tKUQC' }] });
  const file = JSON.parse(JSON.stringify(exportPlaylist(p)));
  assert.equal(file.type, 'playlist');
  const back = importBackup(file);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Back-up');
  assert.equal(back[0].tracks[0].yearSure, false);
  assert.equal(back[0].tracks[0].spotifyId, '4uLU6hMCjMI75M1A2tKUQC');
  assert.deepEqual(importBackup({ foo: 1 }), []);
  assert.deepEqual(importBackup(null), []);
});

test('minimum per spelvorm', () => {
  assert.deepEqual(readiness(2), { timeline: false, bingo: false, fun: false, missing: MIN_TRACKS.bingo - 2 });
  assert.equal(readiness(3).timeline, true);
  assert.equal(readiness(5).bingo, false);
  assert.equal(readiness(6).bingo, true);
  assert.equal(readiness(40).fun, true);
});
