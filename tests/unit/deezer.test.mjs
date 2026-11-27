// Deezer catalogue (app/js/deezer.js) with a fake transport: no network in these tests.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as dz from '../../app/js/deezer.js';

const tick = () => new Promise((r) => setImmediate(r));
async function advance(ms, step = 25) {
  await tick();
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await tick(); }
}

/** A fake transport answering from a function; records every call. */
function fake(answer) {
  const calls = [];
  dz.setTransport(async (path, query, opts) => {
    calls.push({ path, query: { ...query }, at: Date.now(), opts });
    return answer(path, query, calls.length);
  });
  return calls;
}

beforeEach(() => { dz._reset({ gap: 0 }); });

const track = (id, extra = {}) => ({
  id, readable: true, title: `Song ${id}`, title_short: `Song ${id}`, title_version: '', isrc: `NLA01${String(id).padStart(7, '0')}`,
  duration: 200, preview: `https://cdnt-preview.dzcdn.net/api/1/1/x/${id}.mp3?hdnea=exp=${Math.floor(Date.now() / 1000) + 3600}~acl=x`,
  artist: { id: 1, name: 'Artiest' }, album: { id: 2, title: 'Album', cover_small: 'https://cdn-images.dzcdn.net/images/cover/a/56x56.jpg' }, type: 'track', ...extra,
});

test('searchPlaylists: parses, validates and pages', async () => {
  const calls = fake(() => ({
    data: [
      { id: 908622995, title: 'Top 40 NL', nb_tracks: 40, picture_medium: 'https://cdn-images.dzcdn.net/images/playlist/abc/250x250-000000-80-0-0.jpg', user: { name: 'Radio' }, public: true },
      { id: '1234', title: 'Als tekst-id', nb_tracks: 10, user: { name: 'X' } },
      { id: 908622995, title: 'dubbel' },
      { id: 5, title: 'privé', public: false },
      { id: -3, title: 'negatief' },
      { id: 1.5, title: 'kommagetal' },
      { id: 2 ** 60, title: 'te groot' },
      { id: '12abc', title: 'rommel' },
      null, 'tekst', [1, 2],
    ],
    total: 300,
    next: 'https://api.deezer.com/search/playlist?q=top&index=25',
  }));
  const r = await dz.searchPlaylists('  top 40 ', { limit: 25 });
  assert.equal(calls[0].path, '/search/playlist');
  assert.deepEqual(calls[0].query, { q: 'top 40', index: 0, limit: 25 });
  assert.deepEqual(r.items.map((i) => i.id), [908622995, 1234]);
  assert.deepEqual(r.items[0], { id: 908622995, title: 'Top 40 NL', count: 40, by: 'Radio', picture: 'https://cdn-images.dzcdn.net/images/playlist/abc/250x250-000000-80-0-0.jpg' });
  assert.equal(r.items[1].picture, null);
  assert.equal(r.total, 300);
  assert.equal(r.next, 11, 'next index = index + what came back');
  assert.deepEqual(await dz.searchPlaylists('   '), { items: [], total: 0, next: null }, 'empty search: no request');
  assert.equal(calls.length, 1);
});

test('searchPlaylists: the last page has next null', async () => {
  fake(() => ({ data: [{ id: 1, title: 'a' }], total: 26 }));
  assert.equal((await dz.searchPlaylists('x', { index: 25 })).next, null);
});

test('hostile payloads: HTML stays text, wrong types, huge strings, __proto__, foreign URLs', async () => {
  const huge = 'A'.repeat(100000);
  const payload = JSON.parse(JSON.stringify({
    data: [
      { id: 1, title: '<img src=x onerror=alert(1)>', nb_tracks: '12', user: { name: { evil: true } }, picture_medium: 'javascript:alert(1)' },
      { id: 2, title: huge, nb_tracks: -4, user: { name: `x\u0000y‮z${huge}` }, picture_medium: 'http://cdn-images.dzcdn.net/a.jpg' },
      { id: 3, title: ['array'], picture_medium: 'https://cdn-images.dzcdn.net.evil.example/a.jpg' },
      { id: 4, title: 'ok', picture_medium: 'https://evil-dzcdn.net/a.jpg' },
      { id: 5, title: 'ok', picture_medium: 'https://user:pw@cdn-images.dzcdn.net/a.jpg' },
    ],
    total: 'veel',
  }).replace('"id":4', '"__proto__":{"title":"vergiftigd","polluted":true},"id":4'));
  fake(() => payload);
  const r = await dz.searchPlaylists('x');
  const [a, b, c, d, e] = r.items;
  assert.equal(a.title, '<img src=x onerror=alert(1)>', 'kept as plain text (screens escape it)');
  assert.equal(a.count, null, 'a string count is not a number');
  assert.equal(a.by, '');
  assert.equal(a.picture, null, 'javascript: URL refused');
  assert.equal(b.title.length, 120, 'title capped');
  assert.ok(b.by.length <= 80 && !/[\u0000‮]/.test(b.by), 'control/bidi characters out, capped');
  assert.equal(b.count, null);
  assert.equal(b.picture, null, 'http refused');
  assert.equal(c.title, 'Deezer-playlist', 'non-string title -> fallback');
  assert.equal(c.picture, null, 'look-alike host refused');
  assert.equal(d.title, 'ok');
  assert.equal(d.picture, null);
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(Object.getPrototypeOf(d), Object.prototype);
  assert.equal(e.picture, null, 'credentials in URL refused');
  assert.equal(r.total, 5, 'bad total -> what came back');
});

test('answers that are not what we asked for are refused', async () => {
  for (const bad of [null, 'string', 42, [1, 2], { data: 'x' }, { data: { 0: 1 } }]) {
    fake(() => bad);
    await assert.rejects(dz.searchPlaylists('x'), (e) => e instanceof dz.DeezerError && e.code === 'unavailable', JSON.stringify(bad));
  }
  fake(() => ({ id: 999, title: 'andere playlist' }));
  await assert.rejects(dz.playlistInfo(5), { code: 'unavailable' }, 'an answer about another id');
});

test('Deezer errors map to codes; 800 is notfound', async () => {
  fake(() => ({ error: { type: 'DataException', message: 'no data', code: 800 } }));
  await assert.rejects(dz.playlistInfo(1), { code: 'notfound' });
  fake(() => ({ error: { type: 'ParameterException', code: 500 } }));
  await assert.rejects(dz.playlistInfo(1), { code: 'unavailable' });
  fake(() => ({ error: 'weird' }));
  await assert.rejects(dz.playlistInfo(1), { code: 'unavailable' });
  await assert.rejects(dz.playlistInfo('nope'), { code: 'notfound' }, 'bad id: no request');
  dz.setTransport(async () => { throw new TypeError('boom'); });
  await assert.rejects(dz.playlistInfo(1), { code: 'unavailable' });
  dz.setTransport(async () => { throw new dz.DeezerError('timeout'); });
  await assert.rejects(dz.playlistInfo(1), { code: 'timeout' });
  assert.match(dz.errorMessage({ code: 'quota' }), /te veel/);
  assert.equal(dz.errorMessage({ code: 'x' }), dz.MESSAGES.unavailable);
  for (const c of ['offline', 'timeout', 'quota', 'notfound', 'unavailable']) assert.ok(dz.MESSAGES[c], c);
});

test('playlistInfo', async () => {
  const calls = fake(() => ({ id: 1266971851, title: 'Top Netherlands', nb_tracks: 100, picture_medium: 'https://cdn-images.dzcdn.net/images/playlist/f/250x250.jpg', creator: { id: 637006841, name: 'Deezer Charts' }, public: true }));
  assert.deepEqual(await dz.playlistInfo('1266971851'), { id: 1266971851, title: 'Top Netherlands', count: 100, by: 'Deezer Charts', picture: 'https://cdn-images.dzcdn.net/images/playlist/f/250x250.jpg' });
  assert.equal(calls[0].path, '/playlist/1266971851');
});

test('playlistTracks: pages, cleans titles, drops unreadable and duplicates, caps at max', async () => {
  const all = [];
  for (let i = 1; i <= 230; i++) all.push(track(i));
  all[3] = track(4, { readable: false });
  all[5] = track(2); // same Deezer id as #2
  all[6] = track(7, { isrc: all[0].isrc }); // same recording as #1
  all[7] = track(8, { title: 'Bohemian Rhapsody (Remastered 2011)', title_short: 'Bohemian Rhapsody', title_version: '(Remastered 2011)' });
  all[8] = track(9, { title: 'Wonderwall - Remastered', title_short: 'Wonderwall - Remastered' });
  all[9] = track(10, { title_short: 'Heroes (2017 Remaster)' });
  all[10] = track(11, { title_short: '', title: '' });
  all[11] = track(12, { isrc: 'nla011234567' });
  all[12] = track(13, { isrc: 'bad' });
  const calls = fake((path, q) => {
    const page = all.slice(q.index, q.index + q.limit);
    return { data: page, total: all.length, ...(q.index + q.limit < all.length ? { next: 'https://api.deezer.com/...' } : {}) };
  });
  const progress = [];
  const out = await dz.playlistTracks(77, { onProgress: (n, t) => progress.push([n, t]) });
  assert.deepEqual(calls.map((c) => c.query.index), [0, 100, 200]);
  assert.ok(calls.every((c) => c.path === '/playlist/77/tracks' && c.query.limit === 100));
  assert.equal(out.length, 230 - 4, 'unreadable, two duplicates and one without a title left out');
  const by = (id) => out.find((t) => t.deezerId === id);
  assert.equal(by(4), undefined);
  assert.equal(by(7), undefined);
  assert.equal(by(11), undefined);
  assert.equal(by(8).title, 'Bohemian Rhapsody');
  assert.equal(by(9).title, 'Wonderwall');
  assert.equal(by(10).title, 'Heroes');
  assert.equal(by(12).isrc, 'NLA011234567', 'ISRC upper-cased');
  assert.equal(by(13).isrc, null);
  assert.deepEqual(by(1), { deezerId: 1, title: 'Song 1', artist: 'Artiest', album: 'Album', isrc: 'NLA010000001', readable: true });
  assert.deepEqual(progress.at(-1), [230, 230]);
  const capped = await dz.playlistTracks(77, { max: 50 });
  assert.equal(capped.length, 50);
});

test('trackInfo: year from release_date, fresh preview only from the Deezer CDN', async () => {
  fake((path) => {
    const id = Number(path.split('/')[2]);
    if (id === 1) return { ...track(1), release_date: '1982-04-08' };
    if (id === 2) return { ...track(2), release_date: '0000-00-00', album: { title: 'X', release_date: '1975-11-21' } };
    if (id === 3) return { ...track(3), release_date: 'gisteren', preview: 'https://evil.example/a.mp3' };
    return { error: { code: 800 } };
  });
  const a = await dz.trackInfo(1);
  assert.equal(a.year, 1982);
  assert.equal(a.isrc, 'NLA010000001');
  assert.match(a.preview, /^https:\/\/cdnt-preview\.dzcdn\.net\//);
  assert.equal((await dz.trackInfo(2)).year, 1975, 'album date when the track has none');
  const c = await dz.trackInfo(3);
  assert.equal(c.year, null);
  assert.equal(c.preview, null);
  await assert.rejects(dz.trackInfo(4), { code: 'notfound' });
});

test('trackPreview: cached ~10 minutes, null on any failure, never rejects', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    const calls = fake((path) => (path === '/track/9' ? { error: { code: 800 } } : track(Number(path.split('/')[2]))));
    const p = dz.trackPreview(5);
    await advance(50);
    const url = await p;
    assert.match(url, /cdnt-preview\.dzcdn\.net/);
    assert.equal(await dz.trackPreview(5), url);
    assert.equal(calls.length, 1, 'second time from the cache');
    mock.timers.tick(11 * 60 * 1000);
    const p2 = dz.trackPreview(5);
    await advance(50);
    await p2;
    assert.equal(calls.length, 2, 'after 10 minutes: fetched again');
    const p3 = dz.trackPreview(9);
    await advance(50);
    assert.equal(await p3, null);
    assert.equal(await dz.trackPreview('kapot'), null);
  } finally { mock.timers.reset(); }
});

test('queue: at most ~8 requests per second', async () => {
  dz._reset(); // the real gap
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const calls = fake(() => ({ id: 1, title: 'x' }));
    const all = Promise.all(Array.from({ length: 20 }, () => dz.playlistInfo(1)));
    await advance(3000);
    await all;
    assert.equal(calls.length, 20);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 125, `gap ${calls[i].at - calls[i - 1].at}`);
    const in5s = calls.filter((c) => c.at - calls[0].at < 5000).length;
    assert.ok(in5s <= 41, `no more than ~40 in 5 s (${in5s})`);
  } finally { mock.timers.reset(); }
});

test('queue: quota error (code 4) pauses the whole queue and retries; gives up with quota', async () => {
  dz._reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  try {
    let n = 0;
    const calls = fake(() => (++n <= 2 ? { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } : { id: 1, title: 'ok' }));
    const p = dz.playlistInfo(1);
    await advance(20000, 100);
    assert.equal((await p).title, 'ok');
    assert.equal(calls.length, 3);
    assert.ok(calls[1].at - calls[0].at >= 5500, `waited after the first quota error (${calls[1].at - calls[0].at} ms)`);
    assert.ok(calls[2].at - calls[1].at >= 11000, 'waited longer the second time');

    fake(() => ({ error: { code: 4, message: 'Quota limit exceeded' } }));
    const q = dz.playlistInfo(1);
    const seen = q.catch((e) => e);
    await advance(90000, 250);
    const e = await seen;
    assert.equal(e.code, 'quota');
  } finally { mock.timers.reset(); }
});

test('AbortSignal: a waiting request leaves the queue', async () => {
  dz._reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3_000_000 });
  try {
    const calls = fake(() => ({ id: 1, title: 'x' }));
    const ctrl = new AbortController();
    const a = dz.playlistInfo(1);
    const b = dz.playlistInfo(1, { signal: ctrl.signal });
    const bErr = b.catch((e) => e);
    ctrl.abort();
    await advance(500);
    await a;
    assert.equal((await bErr).code, 'aborted');
    assert.equal(calls.length, 1, 'the aborted one never went out');
    await assert.rejects(dz.searchPlaylists('x', { signal: AbortSignal.abort() }), { code: 'aborted' });
  } finally { mock.timers.reset(); }
});

test('parsePlaylistId', () => {
  assert.equal(dz.parsePlaylistId('https://www.deezer.com/nl/playlist/1266971851'), 1266971851);
  assert.equal(dz.parsePlaylistId('https://www.deezer.com/playlist/3155776842?utm_source=deezer&utm_content=playlist'), 3155776842);
  assert.equal(dz.parsePlaylistId('deezer.com/en/playlist/123/'), 123);
  assert.equal(dz.parsePlaylistId('deezer://www.deezer.com/playlist/42'), 42);
  assert.equal(dz.parsePlaylistId(' 908622995 '), 908622995);
  assert.equal(dz.parsePlaylistId('https://www.deezer.com/nl/album/302127'), null);
  assert.equal(dz.parsePlaylistId('https://evil.example/playlist/1'), null);
  assert.equal(dz.parsePlaylistId('https://www.deezer.com.evil.example/playlist/1'), null);
  assert.equal(dz.parsePlaylistId('0'), null);
  assert.equal(dz.parsePlaylistId('99999999999999999'), null);
  assert.equal(dz.parsePlaylistId(null), null);
});

test('FEATURED: the quick picks of the spec', () => {
  const labels = dz.FEATURED.map((f) => f.label);
  for (const l of ['Top Nederland', 'Top wereldwijd', 'Top 40', 'Hardcore', 'Jaren 80', 'Jaren 90', 'Jaren 00', 'Nederlandstalig', 'Feest', 'Après-ski', 'Carnaval', 'Kerst', 'Rock', 'Hiphop', 'Disco', 'Foute uur']) assert.ok(labels.includes(l), l);
  assert.equal(dz.FEATURED.find((f) => f.key === 'top-nl').playlistId, 1266971851);
  assert.equal(dz.FEATURED.find((f) => f.key === 'top-world').playlistId, 3155776842);
  assert.ok(dz.FEATURED.every((f) => f.key && f.label && f.emoji && ((f.playlistId > 0) !== !!f.query)));
  assert.equal(new Set(dz.FEATURED.map((f) => f.key)).size, dz.FEATURED.length);
});

test('apiUrl only builds our own paths; JSONP transport needs a page', async () => {
  assert.equal(dz.apiUrl('/search/playlist', { q: 'a&b', limit: 5 }, { output: 'jsonp', callback: 'dzcbabc123' }), 'https://api.deezer.com/search/playlist?q=a%26b&limit=5&output=jsonp&callback=dzcbabc123');
  assert.throws(() => dz.apiUrl('//evil.example/x'));
  assert.throws(() => dz.apiUrl('/playlist/1/../../x'));
  dz.setTransport(null);
  await assert.rejects(dz.playlistInfo(1), { code: 'unavailable' }, 'no DOM in node: refused, no network');
});
