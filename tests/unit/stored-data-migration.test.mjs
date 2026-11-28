// v3-11 removed Deezer. The previous version (v3-10) was live for a while, so its data may be
// on phones and in accounts: playlists imported from Deezer (tracks with deezerId + isrc +
// title/artist + year, yearChecked / yearSure mixed, source { kind: 'deezer' }), the worker's
// memory, the room mix. These tests load that data as v3-10 stored it and pin the rule:
// - a track is kept when it has an itunesId or a spotifyId, or enough to find it again (an
//   ISRC, or title + artist); its deezerId is no source (carried along unused, for an app of
//   v3-10 that reads the same account);
// - such a song plays through Spotify, and with fragments only once the Apple Music match
//   found it (the counters say so);
// - a 'deezer' source reads as an ordinary saved list (no "Opnieuw ophalen");
// - both account adapters (Node: one value; Cloudflare: chunked) take the stored data and
//   saves of it, and the old-app guard (DATA_FORMAT) still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

const logic = await import('../../app/js/playlist-logic.js');
const playlists = await import('../../app/js/playlists.js');
const { readinessInfo, sourceLabel } = await import('../../app/js/screens/music-bits.js');
const { AccountBox, chunkedStore, memoryStore, needsNewFormat, DATA_FORMAT, OLD_APP_MESSAGE } = await import('../../server/accounts.mjs');
const { migrateState } = await import('../../server/room.mjs');
const { mixStats, buildMix } = await import('../../app/js/multi/mix.js');

const isrc = (n) => `SEAYD76${String(n).padStart(5, '0')}`;

/** A list as v3-10 stored it right after a Deezer import plus some background work. */
function v310List() {
  return {
    id: 'pdz1x', name: 'Top Nederland', created: 1764200000000, updated: 1764200600000, nextN: 8,
    source: { kind: 'deezer', id: '1266971851', name: 'Top Netherlands' },
    tracks: [
      // year from Deezer (a re-release), check still to run
      { n: 1, itunesId: null, title: 'Dancing Queen', artist: 'ABBA', album: 'Gold', year: 2011, yearSure: false, deezerId: 3135556, isrc: isrc(1) },
      // checked by ISRC: sure
      { n: 2, itunesId: null, title: 'Take on Me', artist: 'a-ha', album: 'Hunting High and Low', year: 1984, yearSure: true, deezerId: 664107, isrc: isrc(2), yearChecked: true },
      // checked by search: not sure; no ISRC
      { n: 3, itunesId: null, title: 'Venus', artist: 'Bananarama', album: '', year: 1986, yearSure: false, deezerId: 917353, yearChecked: true },
      // already matched at Apple Music by v3-10: has a fragment
      { n: 4, itunesId: 1440650428, title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', year: 1975, yearSure: true, deezerId: 9997018, isrc: isrc(4), yearChecked: true },
      // Apple found nothing for it
      { n: 5, itunesId: null, title: 'Obscuur', artist: 'Lokale Band', album: '', year: 1999, yearSure: false, deezerId: 12345, yearChecked: true, match: 'none' },
      // no year came yet
      { n: 6, itunesId: null, title: 'Zonder jaar', artist: 'X', album: '', year: null, yearSure: true, deezerId: 222, isrc: isrc(6) },
      // only a Deezer id: nothing to find it by any more
      { n: 7, itunesId: null, title: '', artist: '', album: '', year: 1990, yearSure: true, deezerId: 333 },
    ],
  };
}

test('opslag van v3-10 (Deezer-import) laadt: nummers blijven, geen herkomst meer, de tellers zeggen de waarheid', () => {
  storage.clear();
  storage.set(playlists.KEY, JSON.stringify({ v: 1, lists: [v310List()] }));
  storage.set(playlists.ACTIVE_KEY, JSON.stringify('pdz1x'));
  playlists.reload();
  const p = playlists.get('pdz1x');
  assert.ok(p, 'de lijst laadt');
  assert.equal(playlists.getActiveId(), 'pdz1x', 'en blijft de actieve lijst');
  assert.deepEqual(p.tracks.map((t) => t.n), [1, 2, 3, 4, 5, 6], 'alles blijft, behalve het nummer met alleen een Deezer-id');
  assert.equal(p.source, undefined, "een 'deezer'-herkomst: een gewone bewaarde lijst");
  assert.equal(sourceLabel(p), 'eigen');
  assert.equal(playlists.findBySource('deezer', '1266971851'), null);
  assert.equal(p.tracks[0].deezerId, 3135556, 'deezerId gaat ongebruikt mee (voor een app van v3-10)');
  assert.deepEqual(p.tracks.map((t) => logic.yearPending(t)), [true, false, false, false, false, true]);
  // fragments: only the song with an Apple Music id; Spotify: every song with a year
  const preview = playlists.deckCounts(p, 'preview');
  const spotify = playlists.deckCounts(p, 'spotify');
  assert.equal(preview.inDeck, 1, 'een deezerId is geen fragment');
  assert.equal(spotify.inDeck, 5, 'via Spotify: op ISRC of op titel en artiest');
  assert.equal(spotify.noYear, 1);
  const info = readinessInfo({ counts: preview, source: 'preview', spotifyPlayable: spotify.inDeck, status: { appleTodo: 4, appleDone: 0 }, spotifyConnected: false });
  assert.match(info.text, /speelt via Spotify/, `wat er werkelijk kan: ${info.text}`);
  assert.equal(info.action, 'connect');
  // the deck a game gets: no deezerId, the ISRC for Spotify
  const deck = logic.playlistDeck(p, 'spotify');
  assert.equal(deck.cards.length, 5);
  assert.ok(deck.cards.every((c) => !('deezerId' in c) && !/deezer/.test(c.trackViewUrl || '')));
  assert.equal(deck.cards.find((c) => c.title === 'Dancing Queen').isrc, isrc(1));
  // a change writes the list back without crashing, with the deezerId still there
  assert.ok(playlists.fixYear('pdz1x', 1, 1976));
  const raw = JSON.parse(storage.get(playlists.KEY)).lists[0];
  assert.equal(raw.source, undefined);
  assert.equal(raw.tracks[0].year, 1976);
  assert.equal(raw.tracks[0].deezerId, 3135556);
  // the Apple Music match later: the song gets its fragment
  playlists.updateTrack('pdz1x', 3, { itunesId: 1440831577 });
  assert.equal(playlists.deckCounts(playlists.get('pdz1x'), 'preview').inDeck, 2);
});

test('een nummer blijft met een Apple- of Spotify-id, een ISRC of titel + artiest; een deezerId alleen is niet genoeg', () => {
  const keep = [{ itunesId: 1 }, { spotifyId: '4uLU6hMCjMI75M1A2tKUQC' }, { isrc: isrc(1) }, { title: 'T', artist: 'A' }, { deezerId: 5, title: 'T', artist: 'A' }, { deezerId: 5, isrc: isrc(2) }];
  for (const t of keep) assert.ok(logic.cleanTrack(t), JSON.stringify(t));
  for (const t of [{ deezerId: 5 }, { deezerId: 5, title: 'T' }, { title: 'T' }, {}]) assert.equal(logic.cleanTrack(t), null, JSON.stringify(t));
  assert.equal(logic.playable({ deezerId: 5, year: 1990, isrc: isrc(2) }, 'preview'), false);
  assert.equal(logic.playable({ deezerId: 5, year: 1990, isrc: isrc(2) }, 'spotify'), true);
  assert.equal(logic.cleanSource({ kind: 'deezer', id: '1266971851', name: 'Top' }), null);
  assert.equal(logic.legacySource({ kind: 'deezer', id: '1266971851', name: 'Top' }), true);
  assert.equal(logic.legacySource({ kind: 'deezer', id: 'x' }), false);
  // a backup file of v3-10
  const back = logic.importBackup({ app: 'TimeTunesr', type: 'playlist', v: 1, ...v310List() })[0];
  assert.equal(back.tracks.length, 6);
  assert.equal(back.source, undefined);
});

/** Cloudflare's Durable Object storage as far as chunkedStore uses it. */
function fakeDoStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { if (Array.isArray(k)) return new Map(k.filter((x) => map.has(x)).map((x) => [x, structuredClone(map.get(x))])); return map.has(k) ? structuredClone(map.get(k)) : undefined; },
    async put(k, v) { const e = typeof k === 'string' ? { [k]: v } : k; for (const [kk, vv] of Object.entries(e)) map.set(kk, structuredClone(vv)); },
    async delete(keys) { for (const kk of [].concat(keys)) map.delete(kk); },
    async deleteAll() { map.clear(); },
  };
}

for (const [adapter, makeStore] of [['Node (één waarde)', () => memoryStore(new Map(), 'ilse')], ['Cloudflare (in stukken)', () => chunkedStore(fakeDoStorage())]]) {
  test(`account, ${adapter}: opgeslagen v3-10-gegevens laden en blijven te bewaren; de bewaking van oude apps werkt`, async () => {
    const store = makeStore();
    const box = new AccountBox('ilse', store, null, { iterations: 1000 });
    const up = await box.call('signup', { username: 'Ilse', password: 'geheim-wachtwoord-1' });
    assert.equal(up.status, 201);
    const secret = up.body.token.split('.')[2];
    // what an app of v3-10 saves (format 2): the list as it stored it, Deezer source included
    const list = v310List();
    const s1 = await box.call('save', { secret, rev: 1, data: { playlists: [list] }, format: DATA_FORMAT });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const stored = s1.body.data.playlists[0];
    assert.equal(stored.source, undefined, 'de Deezer-herkomst valt weg');
    assert.equal(stored.tracks.length, 6, 'het nummer met alleen een Deezer-id valt weg, de rest blijft');
    assert.equal(stored.tracks[0].deezerId, 3135556, 'deezerId blijft (een app van v3-10 houdt het nummer dan)');
    assert.equal(needsNewFormat(stored), true, 'een app van vóór v3-10 mag deze lijst niet overschrijven');
    // a reload (evicted object / restarted server) gives the same, and saving it again works
    const box2 = new AccountBox('ilse', store, null, { iterations: 1000 });
    const g = await box2.call('get', { secret });
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.data.playlists, s1.body.data.playlists);
    const again = { ...g.body.data.playlists[0], updated: g.body.data.playlists[0].updated + 1, name: 'Top NL' };
    const s2 = await box2.call('save', { secret, rev: g.body.rev, data: { playlists: [again] }, format: DATA_FORMAT });
    assert.equal(s2.status, 200, JSON.stringify(s2.body));
    // the same save from an app of v3-10 that still has the source: taken as well
    const s3 = await box2.call('save', { secret, rev: s2.body.rev, data: { playlists: [{ ...list, updated: again.updated + 1 }] }, format: DATA_FORMAT });
    assert.equal(s3.status, 200, JSON.stringify(s3.body));
    // an app of before (no format): may not touch it
    const old = await box2.call('save', { secret, rev: s3.body.rev, data: { playlists: [{ ...s3.body.data.playlists[0], tracks: s3.body.data.playlists[0].tracks.slice(0, 2), updated: again.updated + 5 }] } });
    assert.equal(old.status, 400);
    assert.equal(old.body.code, 'oldapp');
    assert.equal(old.body.message, OLD_APP_MESSAGE);
    // still strict: a broken deezerId, or a broken source, is refused
    const bad1 = await box2.call('save', { secret, rev: s3.body.rev, data: { playlists: [{ ...list, tracks: [{ n: 1, title: 'T', artist: 'A', deezerId: -3 }] }] }, format: DATA_FORMAT });
    assert.equal(bad1.status, 400);
    const bad2 = await box2.call('save', { secret, rev: s3.body.rev, data: { playlists: [{ ...list, source: { kind: 'deezer', id: 'abc' } }] }, format: DATA_FORMAT });
    assert.equal(bad2.status, 400);
  });
}

test('kamer: een mix die een server van v3-10 bewaarde (nummers uit Deezer-playlists) laadt zonder Deezer', () => {
  const sp = (n) => ({ spotifyId: `${'4uLU6hMCjMI75M1A'}${String(n).padStart(6, '0')}`, title: `Fav ${n}`, artist: 'A', year: 1990 + n, sure: true });
  const state = migrateState({
    code: 'ABCD',
    room: null,
    mix: {
      anouk: { at: 1, tracks: [sp(1), sp(2)] },
      bram: { at: 2, tracks: [{ deezerId: 5, title: 'Alleen Deezer', artist: 'B', year: 1980, sure: false }, { deezerId: 6, isrc: isrc(6), title: 'Met ISRC', artist: 'B', year: 1981, sure: true }] },
      cas: { at: 3, tracks: [{ deezerId: 7, title: 'Weg', artist: 'C', year: 1982, sure: true }] },
    },
  });
  assert.deepEqual(Object.keys(state.mix).sort(), ['anouk', 'bram'], 'wie alleen Deezer-nummers had, valt weg');
  assert.deepEqual(state.mix.anouk.tracks, [sp(1), sp(2)], 'favorieten blijven zoals ze waren');
  assert.deepEqual(state.mix.bram.tracks, [{ title: 'Met ISRC', artist: 'B', year: 1981, sure: true, isrc: isrc(6) }]);
  assert.equal(mixStats(state.mix).total, 3);
  const cards = buildMix(state.mix, { seed: 1, need: 1, source: 'spotify' });
  assert.ok(cards.every((c) => !('deezerId' in c)));
});
