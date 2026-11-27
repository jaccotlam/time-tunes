// The deck rule for songs whose year is still being checked (playlist-logic deckTracks /
// yearPending, playlists.deckCounts / setPlayNow) and the guard against an app of before
// (v3-9) overwriting playlists of the new format in the account (accounts.mjs, format 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

const { yearPending, deckTracks, playlistDeck, cleanPlaylist, FUN_MIN } = await import('../../app/js/playlist-logic.js');
const playlists = await import('../../app/js/playlists.js');
const enrich = await import('../../app/js/enrich.js');
const { createRoomServer } = await import('../../server/core.mjs');
const { needsNewFormat, DATA_FORMAT } = await import('../../server/accounts.mjs');
const account = await import('../../app/js/account.js');

const sp = (i) => `4uLU6hMCjMI75M1A${String(i).padStart(6, '0')}`;
// a Spotify import: catalogue years, not checked yet
const pending = (i) => ({ n: i + 1, spotifyId: sp(i), title: `T${i}`, artist: `A${i}`, year: 1980, yearSure: false });
const ready = (i) => ({ ...pending(i), yearChecked: true });

test('yearPending: één waarheidstabel, gelijk aan die van enrich.js', () => {
  const table = [
    [{ title: 'a', artist: 'b', year: 1980, yearSure: false }, true],
    [{ isrc: 'SEAYD7601020', year: 1980, yearSure: false }, true],
    [{ title: 'a', artist: 'b', year: null }, true],
    [{ title: 'a', artist: 'b', year: 1980, yearSure: true }, false],
    [{ title: 'a', artist: 'b', year: null, yearSure: true }, true],
    [{ title: 'a', artist: 'b', year: 1980, yearSure: false, yearChecked: true }, false],
    [{ title: 'a', artist: 'b', year: 1980, yearSure: false, yearFixed: true }, false],
    [{ title: 'a', artist: '', year: 1980, yearSure: false }, false],
    [{ title: ' ', artist: 'b', year: 1980, yearSure: false }, false],
    [null, false],
  ];
  for (const [t, want] of table) {
    assert.equal(yearPending(t), want, JSON.stringify(t));
    assert.equal(enrich.yearPending(t), want, `enrich.js: ${JSON.stringify(t)}`);
  }
});

test('deck: niet nagekeken jaren wachten zolang er FUN_MIN klaar zijn; Speel nu toch; met de hand gemaakt ongemoeid', () => {
  const big = { id: 'x', name: 'X', tracks: [...Array.from({ length: FUN_MIN }, (_, i) => ready(i)), ...Array.from({ length: 70 }, (_, i) => pending(100 + i))] };
  const d = deckTracks(big, 'spotify');
  assert.equal(d.tracks.length, FUN_MIN);
  assert.equal(d.held.length, 70);
  assert.equal(playlistDeck(big).cards.length, FUN_MIN, 'het deck (spel, kamer, print) volgt dezelfde regel');
  // one ready song fewer than FUN_MIN: everybody plays, as before
  const few = { ...big, tracks: big.tracks.slice(1) };
  assert.equal(deckTracks(few, 'spotify').tracks.length, few.tracks.length);
  assert.equal(deckTracks(few, 'spotify').held.length, 0);
  // playNow: all
  assert.equal(deckTracks({ ...big, playNow: true }, 'spotify').tracks.length, 100);
  // the source counts: a fragment game only counts songs with a fragment
  assert.equal(deckTracks(big, 'preview').tracks.length, 0);
  // hand made (Apple search with a sure year, a typed year, a pasted year): nothing waits
  const hand = { id: 'h', name: 'H', tracks: Array.from({ length: 50 }, (_, i) => ({ n: i + 1, itunesId: 10 + i, title: `T${i}`, artist: 'A', year: 1990, yearSure: true, ...(i % 2 ? { yearFixed: true } : {}) })) };
  assert.equal(playlistDeck(hand, 'preview').cards.length, 50);
  assert.equal(deckTracks(hand, 'preview').held.length, 0);
  assert.equal(cleanPlaylist({ ...big, playNow: true }).playNow, true);
  assert.equal(cleanPlaylist({ ...big, playNow: 'ja' }).playNow, undefined);
});

test('playlists.js: deckCounts, setPlayNow (gaat vanzelf uit als alles nagekeken is)', () => {
  storage.clear();
  playlists.reload();
  const p = playlists.create('Lijst');
  playlists.addTracks(p.id, [...Array.from({ length: 40 }, (_, i) => ready(i)), ...Array.from({ length: 10 }, (_, i) => pending(100 + i))]);
  assert.deepEqual(playlists.deckCounts(playlists.get(p.id), 'spotify'), { total: 50, playable: 50, inDeck: 40, held: 10, noYear: 0 });
  assert.equal(playlists.setPlayNow(p.id, true), true);
  assert.deepEqual(playlists.deckCounts(playlists.get(p.id), 'spotify'), { total: 50, playable: 50, inDeck: 50, held: 0, noYear: 0 });
  assert.equal(JSON.parse(storage.get(playlists.KEY)).lists[0].playNow, true, 'bewaard');
  // the background check finishes the last ones: playNow switches itself off
  const left = playlists.get(p.id).tracks.filter((t) => yearPending(t)).map((t) => ({ n: t.n, patch: { yearChecked: true } }));
  playlists.updateTracks(p.id, left.slice(0, 9));
  assert.equal(playlists.get(p.id).playNow, true);
  playlists.updateTracks(p.id, left.slice(9));
  assert.equal(playlists.get(p.id).playNow, undefined);
  assert.equal(playlists.setPlayNow(p.id, false), true);
});

// ---------- the account: an app of before ----------
const ORIGIN = 'http://localhost:8080';
test('account: een oude app (zonder format) mag playlists van het nieuwe formaat niet inkorten, weglaten of weggooien', async () => {
  const core = createRoomServer({ iterations: 1000 });
  const call = (method, path, body, token) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', auth: token ? `Bearer ${token}` : '', body: body == null ? '' : JSON.stringify(body) });
  const up = await call('POST', '/account/signup', { username: 'Oud', password: 'geheim-wachtwoord-1' });
  const token = up.body.token;
  const big = cleanPlaylist({ id: 'g', name: 'Groot', created: 1, updated: 5, tracks: Array.from({ length: 2000 }, (_, i) => ({ n: i + 1, itunesId: 1000 + i, title: `T${i}`, artist: 'A', year: 1990, yearSure: true })) });
  const small = cleanPlaylist({ id: 's', name: 'Klein', created: 1, updated: 5, tracks: [{ n: 1, itunesId: 5, title: 'x', artist: 'y', year: 1990 }] });
  assert.ok(needsNewFormat(big) && !needsNewFormat(small));
  const s1 = await call('POST', '/account/data', { rev: 1, data: { playlists: [big, small] }, format: DATA_FORMAT }, token);
  assert.equal(s1.status, 200);
  const rev = s1.body.rev;
  const stored = s1.body.data.playlists;
  const refused = [
    ['ingekort tot 500', { playlists: [{ ...stored[0], updated: 9, tracks: stored[0].tracks.slice(0, 500) }, stored[1]] }],
    ['weggelaten', { playlists: [stored[1]] }],
    ['weggegooid', { playlists: [stored[1]], deleted: { g: 99 } }],
  ];
  for (const [why, data] of refused) {
    const r = await call('POST', '/account/data', { rev, data }, token);
    assert.equal(r.status, 400, why);
    assert.equal(r.body.code, 'oldapp', why);
    assert.match(r.body.message, /Ververs de app/);
  }
  const g = await call('GET', '/account', null, token);
  assert.equal(g.body.rev, rev, 'niets bewaard');
  assert.equal(g.body.data.playlists[0].tracks.length, 2000);
  // what an old app may still do: change its own small list, keep the big one as it is, prefs
  const ok = await call('POST', '/account/data', { rev, data: { playlists: [stored[0], { ...stored[1], name: 'Klein 2', updated: 9 }], prefs: { hostName: 'Ilse' } } }, token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  const ok2 = await call('POST', '/account/data', { rev: ok.body.rev, data: { prefs: { hostPlays: true } } }, token);
  assert.equal(ok2.status, 200);
  // the new app says its format with every save
  assert.equal(account.DATA_FORMAT, DATA_FORMAT);
  const n = await call('POST', '/account/data', { rev: ok2.body.rev, data: { playlists: [{ ...stored[0], updated: 10, tracks: stored[0].tracks.slice(0, 500) }] }, format: DATA_FORMAT }, token);
  assert.equal(n.status, 200, 'de nieuwe app mag dat wel');
});
