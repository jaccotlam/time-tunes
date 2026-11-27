// 2000-song playlists and the three catalogues (Apple Music, Spotify, Deezer), engine side:
// the track format (deezerId, isrc, source, yearFixed), playable() as the one rule, the
// storage size of a 2000-song list (and a full localStorage), importFromSource, old data,
// backups and share links, the Spotify ISRC match and the paged import with a fake Web API,
// the Deezer fragment in the player, a room started with 2000 cards on the real hub (message
// size, backup, restore) and account sync of big lists (chunked Durable Object storage, the
// per-value limit, delta saves). The measured numbers are printed as test diagnostics.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------- a browser, as far as these modules need one ----------
const storage = new Map();
let quota = Infinity; // characters localStorage may hold (key + value), like a real browser's limit
const used = () => [...storage].reduce((n, [k, v]) => n + k.length + v.length, 0);
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => {
    const s = String(v);
    if (used() - (storage.get(k)?.length ?? -k.length) + s.length > quota) {
      const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e;
    }
    storage.set(k, s);
  },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const toasts = [];
// a minimal audio element and toast slot for player.js / ui.js
const audio = {
  dataset: {}, attrs: {}, paused: true, currentTime: 0, duration: 30, listeners: {},
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
  setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'src' ? this.src || null : this.attrs[k] ?? null; },
  removeAttribute(k) { if (k === 'src') this.src = ''; delete this.attrs[k]; },
  load() {}, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
};
globalThis.document ??= {
  visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
  getElementById: (id) => (id === 'player' ? audio : id === 'toast' ? { dataset: {}, classList: { add() {}, remove() {} }, set textContent(v) { toasts.push(v); }, offsetWidth: 0 } : null),
  body: { appendChild: (x) => x },
};
globalThis.navigator ??= { onLine: true };

const logic = await import('../../app/js/playlist-logic.js');
const {
  MAX_TRACKS, cleanTrack, cleanPlaylist, cleanSource, migrateStore, playable, playableTotal, playlistDeck, exportPlaylist, importBackup,
  encodeShare, decodeShare, cleanIsrc, STORE_VERSION,
} = logic;
const playlists = await import('../../app/js/playlists.js');
const { MAX_IMPORT, playlistTracks } = await import('../../app/js/spotify-playlists.js');
const spotify = await import('../../app/js/spotify.js');
const { isrcMatch } = await import('../../app/js/spotify-match.js');
const player = await import('../../app/js/player.js');
const { mergeAccountData, deltaData, saveGap } = await import('../../app/js/account.js');
const {
  MAX_CARDS, MAX_CLIENT_MESSAGE, fitCards, cleanCards, utf8Length, SERVER_PROTOCOL_VERSION: V, parseClientMessage,
} = await import('../../app/js/multi/server-protocol.js');
const { createRoomServer } = await import('../../server/core.mjs');
const {
  AccountBox, chunkedStore, validateData, MAX_DATA_BYTES, MAX_PLAYLIST_BYTES, MAX_PLAYLISTS, PLAYLIST_KEY_PREFIX,
} = await import('../../server/accounts.mjs');
const { playableWith } = await import('../../app/js/multi/mix.js');

const kB = (n) => `${(n / 1024).toFixed(1)} kB`;
const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));

// realistic songs: a 10-digit Apple id, a Spotify id, an ISRC, a Deezer id, ordinary names
const spId = (i) => `${'4uLU6hMCjMI75M1A2tKUQC'.slice(0, 16)}${String(i).padStart(6, '0')}`;
const isrc = (i) => `NLA${String(10 + (i % 80)).padStart(2, '0')}${String(8000000 + i).slice(-7)}`.slice(0, 12);
const song = (i) => ({
  n: i + 1, itunesId: 1422648000 + i, spotifyId: spId(i), deezerId: 3135000 + i, isrc: isrc(i),
  title: `Liedje nummer ${i + 1} (Radio Edit)`, artist: `Artiest ${i % 300} & De Band`, album: `Album van het jaar ${1960 + (i % 60)}`,
  year: 1960 + (i % 60), yearSure: i % 3 !== 0,
});
// the same song as the live app (v3-9) stored it: with the preview and store addresses
const oldSong = (i) => ({
  n: i + 1, itunesId: 1422648000 + i, title: `Liedje nummer ${i + 1} (Radio Edit)`, artist: `Artiest ${i % 300} & De Band`, album: `Album van het jaar ${1960 + (i % 60)}`,
  year: 1960 + (i % 60), yearSure: i % 3 !== 0, spotifyId: spId(i),
  previewUrl: `https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview125/v4/3a/7b/9c/3a7b9c11-2222-3333-4444-${String(555566667777 + i)}/mzaf_${String(1234567890123456789n + BigInt(i))}.plus.aac.p.m4a`,
  trackViewUrl: `https://music.apple.com/nl/album/liedje-nummer-${i + 1}-radio-edit/1422648215?i=${1422648000 + i}&uo=4`,
});

// ---------- the track format ----------
test('trackformaat: deezerId, isrc, yearFixed en herkomst; een nummer blijft met elk van de drie ids', () => {
  assert.equal(MAX_TRACKS, 2000);
  assert.equal(MAX_IMPORT, MAX_TRACKS, 'Spotify-import volgt het maximum');
  assert.equal(MAX_CARDS, MAX_TRACKS, 'kamer volgt het maximum');
  const dz = cleanTrack({ deezerId: 3135556, title: 'Dancing Queen', artist: 'ABBA', year: 1976, isrc: ' se-ayd-76-01020 ' });
  assert.deepEqual(dz, { n: 0, itunesId: null, title: 'Dancing Queen', artist: 'ABBA', album: '', year: 1976, yearSure: true, deezerId: 3135556, isrc: 'SEAYD7601020' });
  assert.ok(cleanTrack({ spotifyId: spId(1) }), 'alleen Spotify');
  assert.ok(cleanTrack({ itunesId: 5 }), 'alleen Apple');
  assert.equal(cleanTrack({ isrc: 'SEAYD7601020', title: 'x' }), null, 'alleen een ISRC is niet genoeg');
  for (const bad of [-1, 0, 1.5, '12a', true, Number.MAX_SAFE_INTEGER + 2, { a: 1 }]) assert.equal(cleanTrack({ itunesId: 1, deezerId: bad }).deezerId, undefined, `deezerId ${String(bad)}`);
  assert.equal(cleanTrack({ itunesId: 1, deezerId: '77' }).deezerId, 77, 'cijfers als tekst');
  for (const bad of ['SEAYD760102', 'SEAYD76010200', '1EAYD7601020', 'SEAYD76010A0', 42, null]) assert.equal(cleanIsrc(bad), null, `isrc ${bad}`);
  assert.equal(cleanTrack({ itunesId: 1, year: 1980, yearFixed: true, yearSure: false }).yearSure, true, 'een eigen jaar is zeker');
  assert.equal(cleanTrack({ itunesId: 1, yearFixed: true }).yearFixed, undefined, 'geen jaar, niets vast');
  assert.equal(cleanTrack({ itunesId: 1, yearChecked: true }).yearChecked, true);
  for (const bad of [false, 'true', 1]) assert.equal(cleanTrack({ itunesId: 1, yearChecked: bad }).yearChecked, undefined, `yearChecked ${bad}`);
  assert.equal(migrateStore({ v: 1, lists: [{ id: 'm', name: 'M', tracks: [{ n: 1, itunesId: 1, yearChecked: true }] }] }).lists[0].tracks[0].yearChecked, true, 'blijft bij het laden');
  // old data: the addresses are dropped, everything else stays
  const old = cleanTrack(oldSong(0));
  assert.equal(old.previewUrl, undefined);
  assert.equal(old.trackViewUrl, undefined);
  assert.equal(old.itunesId, 1422648000);
  assert.equal(old.spotifyId, spId(0));
  // source
  assert.deepEqual(cleanSource({ kind: 'spotify', id: spId(3), name: '  Mijn   lijst ' }), { kind: 'spotify', id: spId(3), name: 'Mijn lijst' });
  assert.deepEqual(cleanSource({ kind: 'deezer', id: 1266971851, name: 'Top Netherlands' }), { kind: 'deezer', id: '1266971851', name: 'Top Netherlands' });
  for (const bad of [null, 'x', { kind: 'apple', id: '1' }, { kind: 'spotify', id: 'kort' }, { kind: 'deezer', id: '12a' }, { kind: 'deezer', id: -5 }, { kind: 'deezer', id: { x: 1 } }]) assert.equal(cleanSource(bad), null);
  assert.equal(cleanSource({ kind: 'deezer', id: '1', name: 'x'.repeat(500) }).name.length, 100);
  const p = cleanPlaylist({ id: 'abc', name: 'L', tracks: [song(1)], source: { kind: 'deezer', id: '1266971851', name: 'Top' } });
  assert.deepEqual(p.source, { kind: 'deezer', id: '1266971851', name: 'Top' });
  assert.equal(cleanPlaylist({ id: 'abc', name: 'L', tracks: [], source: { kind: 'evil' } }).source, undefined);
});

test('playable(): één regel voor fragmenten en Spotify', () => {
  const cases = [
    // [track, preview, spotify]
    [{ year: 1980, itunesId: 5 }, true, true],
    [{ year: 1980, deezerId: 5 }, true, true],
    [{ year: 1980, previewUrl: 'https://x.example/a.m4a' }, true, true],
    [{ year: 1980, spotifyId: spId(1) }, false, true],
    [{ year: 1980, isrc: 'SEAYD7601020' }, false, true],
    [{ year: 1980, title: 'Titel', artist: 'Artiest' }, false, true],
    [{ year: 1980, title: 'Titel' }, false, false],
    [{ itunesId: 5 }, false, false],
    [{ year: 1700, itunesId: 5 }, false, false],
    [{ year: 1980, previewUrl: 'http://x.example/a.m4a' }, false, false],
    [null, false, false],
  ];
  for (const [t, prev, sp] of cases) {
    assert.equal(playable(t, 'preview'), prev, `fragment ${JSON.stringify(t)}`);
    assert.equal(playable(t, 'spotify'), sp, `spotify ${JSON.stringify(t)}`);
    assert.equal(playableWith(t || {}, 'preview'), prev, 'mix volgt dezelfde regel');
  }
  assert.equal(playable({ year: 1980, itunesId: 5 }), true, 'standaard: fragmenten');
  const p = { tracks: [{ year: 1980, itunesId: 5 }, { year: 1980, spotifyId: spId(2) }, { year: null, itunesId: 6 }] };
  assert.equal(playableTotal(p.tracks, 'preview'), 1);
  assert.equal(playlists.playableCount(p, 'preview'), 1);
  assert.equal(playlists.playableCount(p, 'spotify'), 2);
  assert.equal(playlists.playableCount(p), 2, 'zonder bron: zoals vroeger telt een Spotify-id mee');
});

// ---------- storage ----------
test('opslag: bytes per nummer voor en na, een lijst van 2000 nummers', (t) => {
  const oldOne = bytes(oldSong(10));
  const newOne = bytes(cleanTrack(oldSong(10)));
  const full = bytes(cleanTrack(song(10)));
  t.diagnostic(`bytes per opgeslagen nummer: oud (v3-9, met preview- en winkeladres) ${oldOne}, nu ${newOne}, nu met Spotify + Deezer + ISRC ${full}`);
  assert.ok(newOne < oldOne * 0.6, 'flink kleiner');
  const list = cleanPlaylist({ id: 'groot', name: 'Groot', tracks: Array.from({ length: 2000 }, (_, i) => song(i)) });
  assert.equal(list.tracks.length, 2000);
  const oldList = { id: 'groot', name: 'Groot', tracks: Array.from({ length: 2000 }, (_, i) => oldSong(i)) };
  t.diagnostic(`2000 nummers in localStorage: oud ${kB(bytes(oldList))}, nu ${kB(bytes(list))} (met alle drie de ids)`);
  assert.ok(bytes(list) < 500 * 1024);
  assert.ok(bytes(list) < MAX_PLAYLIST_BYTES / 2, 'ruim binnen de grens van het account');
  // more than 2000: capped
  assert.equal(cleanPlaylist({ id: 'x', name: 'x', tracks: Array.from({ length: 2100 }, (_, i) => song(i)) }).tracks.length, 2000);
});

test('opslag: oude gegevens laden, 2000 nummers bewaren, en een volle opslag geeft een duidelijke melding', () => {
  storage.clear();
  // what the live version (v3-9) stored: 500 songs with addresses, an old list without ids
  storage.set(playlists.KEY, JSON.stringify({ v: 1, lists: [{ id: 'oud', name: 'Oud', created: 1, updated: 2, nextN: 501, tracks: Array.from({ length: 500 }, (_, i) => oldSong(i)) }] }));
  playlists.reload();
  assert.equal(playlists.get('oud').tracks.length, 500);
  assert.equal(playlists.get('oud').tracks[0].previewUrl, undefined);
  assert.equal(playlistDeck(playlists.get('oud')).cards[0].trackViewUrl, 'https://music.apple.com/nl/song/1422648000', 'winkellink afgeleid');
  // 2000 songs in one go
  const p = playlists.create('Groot');
  const res = playlists.addTracks(p.id, Array.from({ length: 2001 }, (_, i) => song(i)));
  assert.equal(res.added.length, 2000);
  assert.equal(res.full, true);
  assert.equal(JSON.parse(storage.get(playlists.KEY)).lists[1].tracks.length, 2000);
  // duplicates by any id
  const again = playlists.addTracks(p.id, [{ deezerId: 3135000 + 7, title: 'x' }, { isrc: isrc(8), spotifyId: spId(99999) }]);
  assert.equal(again.duplicates, 2);
  // a full browser storage: nothing half-done, a message, the list as it was stored
  const before = storage.get(playlists.KEY);
  quota = used() + 50;
  const heard = [];
  const off = playlists.subscribe((r) => heard.push(r));
  const small = playlists.create('Past niet');
  assert.equal(small, null);
  assert.equal(playlists.lastWriteError(), 'storage');
  assert.ok(heard.includes('storage-full'));
  assert.equal(playlists.all().length, 2, 'teruggezet');
  const upd = playlists.updateTrack('oud', 1, { title: 'x'.repeat(200) });
  assert.equal(upd, null);
  assert.notEqual(playlists.get('oud').tracks[0].title, 'x'.repeat(200));
  assert.equal(storage.get(playlists.KEY), before, 'opslag onaangeroerd');
  assert.match(playlists.STORAGE_FULL_MESSAGE, /opslag van deze browser is vol/);
  quota = Infinity;
  assert.ok(playlists.create('Nu wel'));
  assert.equal(playlists.lastWriteError(), null);
  off();
});

test('importFromSource: eerste keer een nieuwe lijst, daarna dezelfde lijst bijwerken met behoud van eigen jaren', () => {
  storage.clear();
  playlists.reload();
  const src = { kind: 'spotify', id: spId(424242), name: 'Feest 2026' };
  const first = Array.from({ length: 1500 }, (_, i) => ({ spotifyId: spId(i), title: `T${i}`, artist: 'A', album: '', spYear: 1990 + (i % 30), yearSure: false, isrc: i % 2 ? isrc(i) : null }));
  const a = playlists.importFromSource(src, first);
  assert.equal(a.created, true);
  assert.equal(a.added, 1500);
  assert.equal(a.playlist.name, 'Feest 2026');
  assert.deepEqual(a.playlist.source, src);
  assert.equal(a.playlist.tracks[0].year, 1990, 'jaar van Spotify (spYear)');
  assert.equal(playlists.playableCount(a.playlist, 'spotify'), 1500, 'meteen speelbaar via Spotify');
  // the player fixes a year, background work fills an Apple id and tries to change that year
  const id = a.playlist.id;
  assert.equal(playlists.fixYear(id, 1, 1975).yearFixed, true);
  playlists.updateTrack(id, 1, { itunesId: 99, year: 1999, yearSure: false });
  assert.equal(playlists.get(id).tracks[0].year, 1975, 'eigen jaar blijft');
  assert.equal(playlists.get(id).tracks[0].itunesId, 99);
  assert.equal(playlists.updateTracks(id, [{ n: 2, patch: { year: 1960, yearSure: true } }, { n: 3, patch: { deezerId: 5 } }, { n: 99999, patch: {} }]), 2, 'veel wijzigingen in één keer');
  playlists.rename(id, 'Mijn eigen naam');
  // the same source again, with 600 new songs and an ISRC for an old one
  const second = [...first.slice(0, 1400).map((t, i) => (i === 0 ? { ...t, spYear: 2001, isrc: isrc(0) } : t)),
    ...Array.from({ length: 600 }, (_, i) => ({ spotifyId: spId(5000 + i), title: `N${i}`, artist: 'B', spYear: 2000, yearSure: false }))];
  const b = playlists.importFromSource({ ...src, name: 'Feest 2026 (nieuw)' }, second);
  assert.equal(b.created, false);
  assert.equal(b.playlist.id, id, 'zelfde playlist, geen dubbele');
  assert.equal(b.duplicates, 1400);
  assert.equal(b.added, 500, 'tot het maximum');
  assert.equal(b.full, true);
  assert.equal(b.playlist.tracks.length, MAX_TRACKS);
  assert.equal(b.playlist.name, 'Mijn eigen naam', 'eigen naam blijft');
  assert.equal(b.playlist.source.name, 'Feest 2026 (nieuw)');
  const t1 = b.playlist.tracks.find((x) => x.n === 1);
  assert.equal(t1.year, 1975, 'eigen jaar blijft bij opnieuw ophalen');
  assert.equal(t1.isrc, isrc(0), 'lege velden aangevuld');
  assert.equal(playlists.all().length, 1);
  assert.equal(playlists.findBySource('spotify', spId(424242)).id, id);
  // a Deezer source of the same name is another playlist
  const d = playlists.importFromSource({ kind: 'deezer', id: 1266971851, name: 'Feest 2026' }, [{ deezerId: 1, title: 'x', artist: 'y', year: 2020 }]);
  assert.equal(d.created, true);
  assert.equal(d.playlist.name, 'Feest 2026', 'de eerste heet nu anders');
  assert.equal(playlists.importFromSource({ kind: 'nope', id: 1 }, []).error, 'source');
});

test('back-up en deellink: nieuwe velden mee, oude bestanden en links blijven werken', () => {
  const p = cleanPlaylist({ id: 'x', name: 'Mix', source: { kind: 'deezer', id: '3155776842', name: 'Top' }, tracks: [{ ...song(0), yearChecked: true }, { ...song(1), yearFixed: true }, { n: 3, deezerId: 77, title: 'Alleen Deezer', artist: 'Z', year: 1999 }] });
  const file = JSON.parse(JSON.stringify(exportPlaylist(p)));
  const back = importBackup(file)[0];
  assert.deepEqual(back.source, p.source);
  assert.equal(back.tracks[0].isrc, song(0).isrc);
  assert.equal(back.tracks[0].deezerId, song(0).deezerId);
  assert.equal(back.tracks[1].yearFixed, true);
  assert.equal(back.tracks[0].yearChecked, true, 'back-up houdt yearChecked');
  assert.equal(back.tracks[2].deezerId, 77);
  // a backup of the live version
  const oldFile = { app: 'TimeTunesr', type: 'playlist', v: STORE_VERSION, name: 'Oud', tracks: [{ n: 1, itunesId: 9, title: 'T', artist: 'A', album: '', year: 1971, yearSure: false }] };
  assert.equal(importBackup(oldFile)[0].tracks[0].itunesId, 9);
  assert.equal(migrateStore({ v: 1, lists: [oldFile] }).lists[0].tracks.length, 1);
  // share: as before by default (Apple ids only), Deezer-only songs with deezer: true
  const plain = encodeShare(p, { shareId: 'abcd' });
  assert.equal(plain.shared, 2);
  assert.equal(plain.skipped, 1);
  assert.match(plain.payloads[0], /^1~abcd~1~1~[A-Za-z0-9_-]+~[0-9a-z.]+$/, 'zelfde vorm als vroeger');
  const withDz = encodeShare(p, { shareId: 'abcd', deezer: true });
  assert.equal(withDz.shared, 3);
  const dec = decodeShare(withDz.payloads[0]);
  assert.deepEqual(dec.deezerItems, [{ deezerId: 77, year: 1999 }]);
  assert.equal(dec.items.length, 2);
  // a link of the live version
  const live = '1~k3x9a~1~1~RmVlc3Q~nhwphc0g.nhwphd0k';
  assert.equal(decodeShare(live).items.length, 2);
  assert.deepEqual(decodeShare(live).deezerItems, []);
  // 2000 songs: one link, and QR parts of 700 characters
  const big = cleanPlaylist({ id: 'b', name: 'Groot', tracks: Array.from({ length: 2000 }, (_, i) => song(i)) });
  const link = encodeShare(big, { shareId: 'abcd' });
  assert.equal(link.payloads.length, 1);
  assert.equal(decodeShare(link.payloads[0]).items.length, 2000);
  const parts = encodeShare(big, { shareId: 'abcd', maxLen: 650 });
  assert.ok(parts.payloads.every((x) => x.length <= 650));
  assert.equal(parts.payloads.map(decodeShare).reduce((n, d) => n + d.items.length, 0), 2000);
});

// ---------- Spotify (fake Web API through fetch) ----------
const realFetch = globalThis.fetch;
function fakeSpotify(handler) {
  storage.set('timetunesr.spotify.token.v1', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3, scope: 'playlist-read-private', clientId: '0123456789abcdef0123456789abcdef' }));
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const out = await handler(u);
    if (out?.status) return new Response(JSON.stringify(out.body || {}), { status: out.status, headers: out.headers || {} });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const spTrack = (id, name, artist, extra = {}) => ({ id, uri: `spotify:track:${id}`, name, artists: [{ name: artist }], album: { name: 'Album', release_date: '1976-08-15' }, duration_ms: 230000, type: 'track', ...extra });

test('Spotify: eerst exact op ISRC, dan titel en artiest; een ander nummer onder dezelfde ISRC telt niet', async () => {
  storage.clear();
  const calls = fakeSpotify((u) => {
    const q = u.searchParams.get('q') || '';
    if (q === 'isrc:SEAYD7601020') return { tracks: { items: [spTrack('a'.repeat(22), 'Dancing Queen', 'ABBA')] } };
    if (q === 'isrc:GBUM71029604') return { tracks: { items: [spTrack('b'.repeat(22), 'Iets heel anders', 'Niemand')] } };
    if (q.startsWith('track:"Bohemian Rhapsody"')) return { tracks: { items: [spTrack('c'.repeat(22), 'Bohemian Rhapsody', 'Queen')] } };
    return { tracks: { items: [] } };
  });
  try {
    const r1 = await spotify.resolveTrack({ id: '001', title: 'Dancing Queen', artist: 'ABBA', year: 1976, isrc: 'SEAYD7601020', deezerId: 5 });
    assert.equal(r1.id, 'a'.repeat(22));
    assert.equal(calls.length, 1, 'één zoekvraag');
    const r2 = await spotify.resolveTrack({ id: '002', title: 'Bohemian Rhapsody', artist: 'Queen', year: 1975, isrc: 'GBUM71029604' });
    assert.equal(r2.id, 'c'.repeat(22), 'ander nummer onder de ISRC: zoeken op titel');
    // cached per card
    const n = calls.length;
    assert.equal((await spotify.resolveTrack({ id: '001', title: 'Dancing Queen', artist: 'ABBA', year: 1976, isrc: 'SEAYD7601020', deezerId: 5 })).id, 'a'.repeat(22));
    assert.equal(calls.length, n);
    // a card without title / artist takes the ISRC hit
    assert.equal(isrcMatch({}, [spTrack('d'.repeat(22), 'X', 'Y')]).id, 'd'.repeat(22));
    assert.equal(isrcMatch({ title: 'A', artist: 'B' }, [spTrack('d'.repeat(22), 'X', 'Y', { is_playable: false })]), null);
    // a spotifyId still wins without any search
    assert.equal((await spotify.resolveTrack({ id: '003', spotifyId: 'e'.repeat(22), title: 'x', artist: 'y' })).id, 'e'.repeat(22));
    assert.equal(calls.length, n);
  } finally { globalThis.fetch = realFetch; }
});

test('Spotify-import: 2000 nummers in pagina\'s van 50, een paar tegelijk, met voortgang, 429 wacht', async () => {
  storage.clear();
  const TOTAL = 2150; // more items than the maximum, with some that are no song
  let rated = false;
  let inFlight = 0;
  let maxInFlight = 0;
  fakeSpotify(async (u) => {
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    assert.equal(limit, 50);
    if (offset === 100 && !rated) { rated = true; return { status: 429, headers: { 'Retry-After': '0' }, body: { error: { status: 429, message: 'rate' } } }; }
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const items = [];
    for (let i = offset; i < Math.min(TOTAL, offset + limit); i++) {
      if (i % 97 === 5) items.push({ is_local: true, item: { id: null, name: 'lokaal' } });
      else if (i % 101 === 7) items.push({ item: { id: `ep${i}`, type: 'episode' } });
      else items.push({ item: spTrack(spId(i % 2100), `Song ${i}`, 'Band', { external_ids: { isrc: i % 2 ? isrc(i) : undefined } }) });
    }
    return { items, total: TOTAL, next: offset + limit < TOTAL ? 'more' : null };
  });
  try {
    const progress = [];
    const t0 = Date.now();
    const tracks = await playlistTracks('x'.repeat(22), { onProgress: (n, total) => progress.push([n, total]) });
    assert.equal(tracks.length, 2000);
    assert.equal(new Set(tracks.map((t) => t.spotifyId)).size, 2000);
    assert.equal(tracks[0].title, 'Song 0', 'volgorde van de playlist');
    assert.ok(tracks.some((t) => t.isrc) && tracks.every((t) => t.isrc === null || /^[A-Z]{2}/.test(t.isrc)));
    assert.equal(tracks[0].spYear, 1976);
    assert.ok(progress.length > 5 && progress.at(-1)[1] === TOTAL);
    assert.ok(maxInFlight > 1, 'pagina\'s tegelijk');
    assert.ok(rated, '429 gezien en opnieuw geprobeerd');
    assert.ok(Date.now() - t0 < 5000);
  } finally { globalThis.fetch = realFetch; }
});

// ---------- the player: a Deezer fragment ----------
test('speler: fragment via Deezer (trackPreview) voor een kaart zonder Apple-id; Apple eerst wanneer er een is', async () => {
  storage.clear();
  const asked = [];
  player.setDeezerPreview(async (id) => { asked.push(id); return id === 404 ? null : `https://cdnt-preview.dzcdn.net/api/1/1/${id}.mp3?hdnea=exp=1`; });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'itunes.apple.com') return new Response(JSON.stringify({ results: [{ trackId: 1, previewUrl: 'https://audio.example/apple.m4a', trackViewUrl: 'https://music.apple.com/x' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    assert.equal(await player.load({ id: '001', title: 'x', artist: 'y', year: 1980, deezerId: 3135556 }), true);
    assert.equal(audio.src, 'https://cdnt-preview.dzcdn.net/api/1/1/3135556.mp3?hdnea=exp=1');
    assert.deepEqual(asked, [3135556]);
    assert.equal(await player.load({ id: '002', title: 'x', artist: 'y', year: 1980, itunesId: 1, deezerId: 7 }), true);
    assert.equal(audio.src, 'https://audio.example/apple.m4a');
    assert.deepEqual(asked, [3135556], 'Apple had er een: Deezer niet gevraagd');
    assert.equal(await player.load({ id: '003', title: 'x', artist: 'y', year: 1980, deezerId: 404 }), false, 'geen fragment: geen afspelen');
    assert.equal(player.state.status, 'error');
    // without the Deezer module (not there yet / failing) nothing breaks
    player.setDeezerPreview(async () => { throw new Error('kapot'); });
    assert.equal(await player.load({ id: '004', title: 'x', artist: 'y', year: 1980, deezerId: 9 }), false);
    player.setDeezerPreview(null); // back to the default (dynamic import of js/deezer.js)
  } finally { globalThis.fetch = realFetch; player.stop(); }
});

// ---------- a room with 2000 cards ----------
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
function wsClient(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const msgs = [];
  const sizes = [];
  const p = { msgs, closed: null };
  p.conn = up.attach({ send: (text) => { sizes.push(text.length); msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)); }, close: (c, reason) => { p.closed = { c, reason }; } });
  p.raw = (text) => p.conn.message(text);
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  p.lastSize = (t) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return sizes[i]; return 0; };
  return p;
}

test('kamer: starten met 2000 kaarten (berichtgrootte), back-up en herstel; te groot geeft een melding, geen verbroken verbinding', async (t) => {
  const now = 5_000_000;
  const core = createRoomServer({ now: () => now });
  const res = core.http({ method: 'POST', path: '/rooms', origin: ORIGIN, ip: '10.0.0.1', body: JSON.stringify({ v: V, id: 'owner01', name: 'Ilse', settings: { game: 'timeline' } }) });
  const { code, token } = res.body;
  const host = wsClient(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const a = wsClient(core, code);
  a.send({ t: 'hello', v: V, code, id: 'playerA1', name: 'Sam' });
  const b = wsClient(core, code);
  b.send({ t: 'hello', v: V, code, id: 'playerB1', name: 'Lisa' });
  await flush();
  // the deck of a 2000-song playlist, as the host screen hands it to the session
  const deck = playlistDeck(cleanPlaylist({ id: 'g', name: 'Groot', tracks: Array.from({ length: 2000 }, (_, i) => song(i)) }));
  const fit = fitCards(deck.cards);
  assert.equal(fit.cut, 0);
  const msg = JSON.stringify({ t: 'start', cards: fit.cards, mix: false, play: 'preview' });
  t.diagnostic(`startbericht met 2000 kaarten (Apple + Spotify + Deezer): ${kB(utf8Length(msg))} (grens ${kB(MAX_CLIENT_MESSAGE)})`);
  assert.ok(utf8Length(msg) < MAX_CLIENT_MESSAGE * 0.75);
  assert.ok(parseClientMessage(msg));
  host.raw(msg);
  await flush();
  const lead = host.last('state');
  assert.equal(lead.lead.room.phase, 'answering', JSON.stringify(host.last('error')));
  const songNow = lead.lead.song;
  assert.ok(songNow.deezerId && songNow.itunesId && songNow.spotifyId, 'de muziektelefoon krijgt alle ids');
  assert.equal(songNow.isrc, undefined, 'ISRC alleen zonder Spotify-id');
  const backupSize = host.lastSize('backup');
  t.diagnostic(`back-up van de kamer naar de telefoon van de eigenaar: ${kB(backupSize)}; staat van een speler: ${kB(a.lastSize('state'))}`);
  assert.ok(backupSize < 2 * MAX_CLIENT_MESSAGE, 'past in een herstelverzoek (maxBody)');
  // restore on a fresh server (restart)
  const snap = host.last('backup').snap;
  const core2 = createRoomServer({ now: () => now });
  const body = JSON.stringify({ v: V, id: 'owner01', token, snap });
  const r = core2.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '10.0.0.1', body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restored, true);
  // a deck that does not fit: the server says so and keeps the connection
  const huge = JSON.stringify({ t: 'start', cards: Array.from({ length: 2000 }, (_, i) => ({ id: `x${i}`, year: 1990, title: 'é'.repeat(200), artist: 'ü'.repeat(200) })) });
  assert.ok(utf8Length(huge) > MAX_CLIENT_MESSAGE);
  host.raw(huge);
  await flush();
  assert.equal(host.last('error').code, 'deck');
  assert.match(host.last('error').message, /te groot/);
  assert.equal(host.closed, null, 'verbinding blijft');
  // fitCards makes even that deck fit: slimmer cards, then a fair part
  const f2 = fitCards(JSON.parse(huge).cards);
  assert.ok(f2.cut > 0 && f2.cards.length + f2.cut === 2000);
  assert.ok(utf8Length(JSON.stringify({ t: 'start', cards: f2.cards, mix: false, play: 'preview' })) <= MAX_CLIENT_MESSAGE);
  assert.ok(f2.cards.every((c) => c.title.length <= 100));
  // the server keeps the new ids and drops broken ones
  const clean = cleanCards([{ id: '1', year: 1980, deezerId: 5, isrc: 'SEAYD7601020' }, { id: '2', year: 1980, deezerId: '5', isrc: 'kapot' }]);
  assert.deepEqual(clean.map((c) => [c.deezerId, c.isrc]), [[5, 'SEAYD7601020'], [undefined, undefined]]);
});

// ---------- accounts with big lists ----------
/** A Durable Object storage as far as chunkedStore uses it, with Cloudflare's 2 MiB per value. */
function fakeDoStorage() {
  const map = new Map();
  const writes = [];
  const check = (k, v) => { const n = bytes(v) + Buffer.byteLength(k); if (n > 2 * 1024 * 1024) throw new RangeError(`Values cannot be larger than 2 MiB (${n})`); };
  return {
    map, writes,
    async get(k) { if (Array.isArray(k)) { if (k.length > 128) throw new Error('max 128 keys'); return new Map(k.filter((x) => map.has(x)).map((x) => [x, structuredClone(map.get(x))])); } return map.has(k) ? structuredClone(map.get(k)) : undefined; },
    async put(k, v) {
      const entries = typeof k === 'string' ? { [k]: v } : k;
      if (Object.keys(entries).length > 128) throw new Error('max 128 keys');
      for (const [kk, vv] of Object.entries(entries)) check(kk, vv);
      for (const [kk, vv] of Object.entries(entries)) { map.set(kk, structuredClone(vv)); writes.push(kk); }
    },
    async delete(keys) { for (const kk of [].concat(keys)) map.delete(kk); },
    async deleteAll() { map.clear(); },
  };
}
const bigList = (id, updated, n = 2000) => cleanPlaylist({ id, name: `Lijst ${id}`, created: 1, updated, tracks: Array.from({ length: n }, (_, i) => song(i)) });

test('account: een paar lijsten van 2000 nummers synchroniseren, in stukken opgeslagen (Durable Object), alleen wat veranderde', async (t) => {
  const kv = fakeDoStorage();
  const box = new AccountBox('ilse', chunkedStore(kv), null, { iterations: 1000 });
  const up = await box.call('signup', { username: 'Ilse', password: 'geheim-wachtwoord-1' });
  assert.equal(up.status, 201);
  const secret = up.body.token.split('.')[2];
  const lists = Array.from({ length: 5 }, (_, i) => bigList(`p${i}`, 10 + i));
  lists[0].tracks[0].yearChecked = true;
  const data = { playlists: lists };
  t.diagnostic(`5 lijsten van 2000 nummers: ${kB(bytes(data))} (grens per account ${kB(MAX_DATA_BYTES)}, per playlist ${kB(MAX_PLAYLIST_BYTES)}, hoogstens ${MAX_PLAYLISTS} playlists)`);
  const s1 = await box.call('save', { secret, rev: 1, data });
  assert.equal(s1.status, 200, JSON.stringify(s1.body).slice(0, 300));
  assert.equal(s1.body.data.playlists.length, 5);
  const biggest = Math.max(...[...kv.map.entries()].map(([k, v]) => bytes(v) + k.length));
  t.diagnostic(`grootste waarde in de Durable Object: ${kB(biggest)} (Cloudflare: 2048 kB)`);
  assert.ok(kv.map.has('account') && kv.map.has(`${PLAYLIST_KEY_PREFIX}p0`));
  assert.ok(!kv.map.get('account').data.playlists, 'de record zelf zonder playlists');
  // a reload (evicted object) gives the same
  const box2 = new AccountBox('ilse', chunkedStore(kv), null, { iterations: 1000 });
  const g = await box2.call('get', { secret });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.data.playlists, s1.body.data.playlists);
  assert.equal(g.body.data.playlists[0].tracks[0].yearChecked, true, 'yearChecked gaat mee met het account');
  assert.ok(validateData({ playlists: [{ ...bigList('y', 1, 1), tracks: [{ ...song(0), yearChecked: 'ja' }] }] }).error, 'yearChecked alleen als boolean');
  // a delta save: one playlist changed, the others as stubs; only that one is written
  kv.writes.length = 0;
  const changed = { ...lists[2], updated: 99, name: 'Anders' };
  const sent = deltaData({ ...g.body.data, playlists: [...g.body.data.playlists.slice(0, 2), changed, ...g.body.data.playlists.slice(3)] }, g.body.data);
  assert.equal(sent.playlists.filter((p) => p.same).length, 4);
  t.diagnostic(`opslaan na één wijziging: ${kB(bytes({ rev: 2, data: sent, delta: true }))} verstuurd in plaats van ${kB(bytes({ rev: 2, data: { playlists: [...lists.slice(0, 2), changed, ...lists.slice(3)] } }))}`);
  const s2 = await box2.call('save', { secret, rev: 2, data: sent, delta: true });
  assert.equal(s2.status, 200, JSON.stringify(s2.body).slice(0, 300));
  assert.deepEqual(s2.body, { rev: 3, delta: true }, 'antwoord zonder de gegevens');
  assert.deepEqual(kv.writes.sort(), ['account', `${PLAYLIST_KEY_PREFIX}p2`]);
  const g2 = await new AccountBox('ilse', chunkedStore(kv), null, { iterations: 1000 }).call('get', { secret });
  assert.equal(g2.body.data.playlists[2].name, 'Anders');
  assert.equal(g2.body.data.playlists[0].tracks.length, 2000);
  // a stub for a version the account does not have: conflict with the current data (the client merges)
  const stale = await box2.call('save', { secret, rev: 3, data: { playlists: [{ id: 'p0', updated: 1, same: true }] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'conflict');
  // a deleted playlist goes from the storage too
  const s3 = await box2.call('save', { secret, rev: 3, data: { playlists: g2.body.data.playlists.slice(1).map((p) => ({ id: p.id, updated: p.updated, same: true })) } });
  assert.equal(s3.status, 200);
  assert.ok(!kv.map.has(`${PLAYLIST_KEY_PREFIX}p0`));
  // a record of before (everything in one value) loads and is split by the next save
  const legacy = fakeDoStorage();
  const rec = structuredClone(kv.map.get('account'));
  rec.data = { ...rec.data, playlists: [bigList('oud', 5, 500)] };
  delete rec.data.playlistIds;
  await legacy.put('account', rec);
  const box3 = new AccountBox('ilse', chunkedStore(legacy), null, { iterations: 1000 });
  const g3 = await box3.call('get', { secret });
  assert.equal(g3.status, 200);
  assert.equal(g3.body.data.playlists[0].tracks.length, 500);
  const s4 = await box3.call('save', { secret, rev: g3.body.rev, data: { prefs: { hostName: 'Ilse' } } });
  assert.equal(s4.status, 200);
  assert.ok(legacy.map.has(`${PLAYLIST_KEY_PREFIX}oud`) && Array.isArray(legacy.map.get('account').data.playlistIds));
  // validation stays strict: 2001 songs, or a playlist over MAX_PLAYLIST_BYTES
  assert.ok(validateData({ playlists: [{ ...bigList('z', 1), tracks: [...bigList('z', 1).tracks, { ...song(2000), n: 2001 }] }] }).error);
  assert.ok(saveGap(450 * 1024) >= 10000 && saveGap(450 * 1024) <= 30000 && saveGap(2000) < 1000, 'na een grote opslag wacht de volgende');
});

test('account: het samenvoegen houdt de nieuwe velden en de herkomst', () => {
  const p = bigList('a', 5, 3);
  p.source = { kind: 'spotify', id: spId(1), name: 'X' };
  const m = mergeAccountData({ playlists: [p] }, { playlists: [] });
  assert.deepEqual(m.remote.playlists[0].source, p.source);
  assert.equal(m.remote.playlists[0].tracks[0].deezerId, song(0).deezerId);
});
