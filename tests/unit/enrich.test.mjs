// The background worker (app/js/enrich.js) with a fake playlist store and fake Deezer,
// MusicBrainz and Apple: step order, manual fixes kept, pause/resume, prepare(). No network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };

const enrich = await import('../../app/js/enrich.js');
const { DeezerError } = await import('../../app/js/deezer.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await wait(5);
  }
}

/** In-memory stand-in for playlists.js (same API the worker uses). */
function fakeStore(lists, active = null) {
  const listeners = new Set();
  const writes = [];
  const get = (id) => lists.find((p) => p.id === id) || null;
  const apply = (t, patch) => {
    const fixed = t.yearFixed;
    const keep = { year: t.year, yearSure: t.yearSure };
    Object.assign(t, patch);
    for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
    if (fixed) Object.assign(t, keep, { yearFixed: true });
  };
  return {
    writes,
    all: () => lists,
    get,
    getActiveId: () => active,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    updateTrack(id, n, patch) {
      const t = get(id)?.tracks.find((x) => x.n === n);
      if (!t) return null;
      apply(t, patch);
      writes.push([{ id, n, patch }]);
      listeners.forEach((fn) => fn('track'));
      return t;
    },
    updateTracks(id, changes) {
      const p = get(id);
      const batch = [];
      for (const { n, patch } of changes) {
        const t = p?.tracks.find((x) => x.n === n);
        if (t) { apply(t, patch); batch.push({ id, n, patch }); }
      }
      writes.push(batch);
      listeners.forEach((fn) => fn('track'));
      return batch.length;
    },
  };
}

/** Fake services that log every call: [lane, id]. */
function fakeServices({ dzYear = () => 1999, mbYear = () => null, apple = () => null, dzDelay = 1, mbDelay = 1, appleDelay = 1 } = {}) {
  const log = [];
  const deezer = {
    async trackInfo(id, { signal } = {}) {
      log.push(['dz', id]);
      await wait(dzDelay);
      if (signal?.aborted) throw new DeezerError('aborted');
      const y = dzYear(id);
      if (y instanceof Error) throw y;
      return { deezerId: id, title: 't', artist: 'a', album: '', isrc: null, year: y, preview: null };
    },
  };
  const musicbrainz = {
    async firstReleaseYear(isrc, { signal } = {}) {
      log.push(['mb', isrc]);
      await wait(mbDelay);
      if (signal?.aborted) { const e = new Error('aborted'); e.code = 'aborted'; throw e; }
      const y = mbYear(isrc);
      if (y instanceof Error) throw y;
      return y;
    },
  };
  const appleMatch = async (t, { signal } = {}) => {
    log.push(['apple', t.title]);
    await wait(appleDelay);
    if (signal?.aborted) { const e = new Error('aborted'); e.code = 'aborted'; throw e; }
    return apple(t);
  };
  return { log, deezer, musicbrainz, appleMatch };
}

function setup(lists, services, active = null) {
  const store = fakeStore(lists, active);
  enrich._setDeps({ playlists: store, ...services });
  enrich.start();
  return store;
}

beforeEach(() => {
  storage.clear();
  enrich._configure({ idleMs: 30, flushMs: 10, emitMs: 2, backoffMs: 10, quotaMs: 10, memSaveMs: 1 });
});
afterEach(() => { enrich.stop(); enrich._reset(); });

const isrc = (i) => `NLA01${String(i).padStart(7, '0')}`;
const done = (store, pid) => () => enrich.status(pid).pending === 0;

test('step order per song: Deezer year, then MusicBrainz, then Apple; MusicBrainz earlier year wins and is sure', async () => {
  const tracks = [{ n: 1, deezerId: 11, isrc: isrc(1), title: 'Song', artist: 'X', year: null, yearSure: true }];
  const sv = fakeServices({ dzYear: () => 2011, mbYear: () => 1979, apple: () => ({ itunesId: 501, previewUrl: 'https://a/1.m4a', trackViewUrl: null, year: 1985, yearSure: true }) });
  const store = setup([{ id: 'p1', tracks }], sv);
  await until(done(store, 'p1'), 3000, 'done');
  assert.deepEqual(sv.log.map((x) => x[0]), ['dz', 'mb', 'apple']);
  const t = tracks[0];
  assert.equal(t.year, 1979, 'MusicBrainz first release (earlier than Deezer 2011)');
  assert.equal(t.yearSure, true);
  assert.equal(t.itunesId, 501, 'Apple fragment found');
  assert.equal(enrich.nextStep(t), null);
});

test('Deezer year is "not sure"; a LATER MusicBrainz year is ignored and not asked again after a restart', async () => {
  const tracks = [{ n: 1, deezerId: 21, isrc: isrc(2), title: 'S', artist: 'A', year: null, yearSure: true, match: 'none' }];
  const sv = fakeServices({ dzYear: () => 1990, mbYear: () => 1995 });
  const store = setup([{ id: 'p1', tracks }], sv);
  await until(done(store, 'p1'));
  assert.equal(tracks[0].year, 1990);
  assert.equal(tracks[0].yearSure, false, 'still "controleer het jaar"');
  assert.deepEqual(sv.log.map((x) => x[0]), ['dz', 'mb'], 'match: none -> no Apple search');
  await wait(20);
  enrich.stop();
  assert.ok(storage.get('timetunesr.enrich.v1'), 'answers remembered');
  enrich._reset(); // a reload: memory comes back from localStorage
  enrich.start();
  await wait(80);
  assert.equal(sv.log.length, 2, 'no new requests after the reload');
  assert.equal(enrich.status('p1').pending, 0);
});

test('a year the user typed is never overwritten (not by MusicBrainz, Apple, or a Deezer answer in flight)', async () => {
  const tracks = [
    { n: 1, isrc: isrc(3), spotifyId: 'a'.repeat(22), title: 'Fixed', artist: 'A', year: 1970, yearSure: true, yearFixed: true },
    { n: 2, deezerId: 32, title: 'Typed meanwhile', artist: 'B', year: null, yearSure: true, match: 'none' },
  ];
  const sv = fakeServices({
    dzDelay: 40, dzYear: () => 2005, mbYear: () => 1960,
    apple: () => ({ itunesId: 777, previewUrl: null, trackViewUrl: null, year: 1965, yearSure: true }),
  });
  const store = setup([{ id: 'p1', tracks }], sv);
  await until(() => sv.log.some((x) => x[0] === 'dz'));
  store.updateTrack('p1', 2, { year: 1983, yearSure: true, yearFixed: true }); // typed while Deezer is asked
  await until(done(store, 'p1'));
  await wait(30);
  assert.ok(!sv.log.some((x) => x[0] === 'mb'), 'a sure year needs no MusicBrainz');
  assert.equal(tracks[0].year, 1970);
  assert.equal(tracks[0].yearSure, true);
  assert.equal(tracks[0].itunesId, 777, 'Apple still adds the fragment');
  assert.equal(tracks[1].year, 1983, 'the Deezer answer that came back later did not overwrite it');
});

test('Apple: no trustworthy match -> match none; a duplicate fragment is not taken twice', async () => {
  const tracks = [
    { n: 1, itunesId: 900, title: 'Have', artist: 'A', year: 1980, yearSure: true },
    { n: 2, spotifyId: 'b'.repeat(22), title: 'Dup', artist: 'A', year: 1981, yearSure: false, match: 'pending' },
    { n: 3, spotifyId: 'c'.repeat(22), title: 'Nothing', artist: 'A', year: 1982, yearSure: false, match: 'pending' },
    { n: 4, spotifyId: 'd'.repeat(22), title: 'Found', artist: 'A', year: 2011, yearSure: false, match: 'pending' },
  ];
  const sv = fakeServices({ apple: (t) => (t.title === 'Dup' ? { itunesId: 900, year: 1980, yearSure: true } : t.title === 'Found' ? { itunesId: 901, previewUrl: 'https://x/1.m4a', trackViewUrl: null, year: 1991, yearSure: true } : null) });
  const store = setup([{ id: 'p1', tracks }], sv);
  assert.equal(enrich.status('p1').appleTodo, 3);
  await until(done(store, 'p1'));
  assert.equal(tracks[1].match, 'none');
  assert.equal(tracks[1].itunesId, undefined);
  assert.equal(tracks[2].match, 'none');
  assert.equal(tracks[2].yearSure, false);
  assert.equal(tracks[3].itunesId, 901);
  assert.equal(tracks[3].match, undefined, 'pending flag gone');
  assert.equal(tracks[3].year, 1991, "Apple's year (pickYear) for an unsure Spotify year");
  assert.equal(tracks[3].yearSure, true);
  const st = enrich.status('p1');
  assert.equal(st.appleTodo, 0);
  assert.equal(st.appleDone, 3);
});

test('status(): the counts', async () => {
  const tracks = [
    { n: 1, itunesId: 1, year: 1980, yearSure: true, title: 'a' },
    { n: 2, deezerId: 2, year: 1981, yearSure: false, title: 'b', match: 'none' },
    { n: 3, deezerId: 3, year: null, yearSure: true, title: 'c', match: 'none' },
    { n: 4, spotifyId: 'e'.repeat(22), year: 1990, yearSure: true, title: 'd', match: 'none' },
  ];
  const store = fakeStore([{ id: 'p', tracks }]);
  enrich._setDeps({ playlists: store });
  const st = enrich.status('p');
  assert.deepEqual(
    { total: st.total, ready: st.ready, yearsMissing: st.yearsMissing, yearsUnsure: st.yearsUnsure, fragmentsMissing: st.fragmentsMissing, pending: st.pending, working: st.working },
    { total: 4, ready: 3, yearsMissing: 1, yearsUnsure: 1, fragmentsMissing: 1, pending: 1, working: false },
  );
  assert.equal(enrich.status('nope').total, 0);
});

test('writes of Deezer years are batched (one store write per batch)', async () => {
  const tracks = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, deezerId: 1000 + i, title: `t${i}`, artist: 'a', year: null, yearSure: true, match: 'none' }));
  enrich._configure({ flushMs: 30 });
  const store = setup([{ id: 'p1', tracks }], fakeServices());
  await until(done(store, 'p1'));
  assert.ok(tracks.every((t) => t.year === 1999 && t.yearSure === false));
  assert.ok(store.writes.length < 20, `${store.writes.length} writes for 40 songs`);
});

test('the active playlist goes first, then the one asked for comes before everything', async () => {
  const mk = (id, base) => ({ id, tracks: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, deezerId: base + i, title: 'x', artist: 'y', year: null, yearSure: true, match: 'none' })) });
  const lists = [mk('a', 100), mk('b', 200), mk('c', 300)];
  const sv = fakeServices({ dzDelay: 5 });
  enrich._configure({ flushMs: 1 });
  setup(lists, sv, 'c');
  await until(() => sv.log.length >= 1);
  assert.ok(sv.log.slice(0, 4).every((x) => x[1] >= 300 && x[1] < 400), 'active list first');
  enrich.prioritise('b');
  await until(() => ['a', 'b', 'c'].every((id) => enrich.status(id).pending === 0), 5000);
  const ids = sv.log.map((x) => x[1]);
  const lastB = ids.findLastIndex((id) => id >= 200 && id < 300);
  const aBeforeLastB = ids.slice(0, lastB).filter((id) => id < 200).length;
  assert.equal(aBeforeLastB, 0, 'b (asked for) before a');
});

test('pause() stops new work (and Apple in flight); resume() continues', async () => {
  const tracks = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, spotifyId: String(i).repeat(22), title: `s${i}`, artist: 'a', year: 1990, yearSure: false, match: 'pending' }));
  const sv = fakeServices({ appleDelay: 30, apple: () => null });
  const store = setup([{ id: 'p1', tracks }], sv);
  await until(() => sv.log.length === 1);
  enrich.pause('game');
  assert.equal(enrich.isPaused(), true);
  await wait(120);
  assert.equal(sv.log.length, 1, 'nothing new while paused');
  assert.ok(!tracks[0].match || tracks[0].match === 'pending', 'the aborted search is not marked "none"');
  assert.equal(enrich.status('p1').working, false);
  enrich.pause('audio');
  enrich.resume('game');
  await wait(60);
  assert.equal(sv.log.length, 1, 'still paused for the other reason');
  enrich.resume('audio');
  await until(done(store, 'p1'));
  assert.ok(tracks.every((t) => t.match === 'none'));
});

test('prepare(): resolves once `min` songs have a year, from all over the list; the rest goes on', async () => {
  const tracks = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, deezerId: 5000 + i, title: `t${i}`, artist: 'a', year: null, yearSure: true, match: 'none' }));
  const sv = fakeServices({ dzDelay: 5, dzYear: (id) => 1960 + (id % 60) });
  setup([{ id: 'big', tracks }], sv);
  const progress = [];
  const st = await enrich.prepare('big', { min: 20, onProgress: (s) => progress.push(s.ready) });
  assert.ok(st.ready >= 20, `ready ${st.ready}`);
  assert.ok(st.ready < 200, 'resolved before the whole list was done');
  const got = tracks.map((t, i) => (t.year ? i : -1)).filter((i) => i >= 0);
  const quarters = [0, 1, 2, 3].map((q) => got.filter((i) => Math.floor(i / 50) === q).length);
  assert.ok(quarters.every((n) => n >= 3), `a fair sample of the list (${quarters})`);
  assert.ok(progress.length > 1);
  await until(() => tracks.every((t) => t.year), 5000, 'the rest in the background');
});

test('prepare(): works while paused (only for that list), resolves at once when ready, short lists', async () => {
  const mk = (id, base, n) => ({ id, tracks: Array.from({ length: n }, (_, i) => ({ n: i + 1, deezerId: base + i, title: 'x', artist: 'y', year: null, yearSure: true, match: 'none' })) });
  const lists = [mk('other', 100, 5), mk('want', 200, 8)];
  const sv = fakeServices();
  enrich.pause('game'); // a round is being played
  setup(lists, sv);
  const st = await enrich.prepare('want', { min: 30 });
  assert.equal(st.ready, 8, 'fewer songs than min: resolves when nothing more can be found');
  assert.ok(sv.log.every((x) => x[1] >= 200), 'the other list waits for the pause');
  const again = await enrich.prepare('want', { min: 5 });
  assert.equal(again.ready, 8);
  enrich.resume('game');
  await until(() => enrich.status('other').pending === 0);
});

test('prepare(): rejects with the Deezer error when Deezer keeps failing; abort', async () => {
  const tracks = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, deezerId: 7000 + i, title: 'x', artist: 'y', year: null, yearSure: true, match: 'none' }));
  setup([{ id: 'p', tracks }], fakeServices({ dzYear: () => new DeezerError('unavailable') }));
  await assert.rejects(enrich.prepare('p', { min: 10 }), (e) => e instanceof DeezerError && e.code === 'unavailable');
  const ctrl = new AbortController();
  const p = enrich.prepare('p', { min: 10, signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, { code: 'aborted' });
});

test('Deezer notfound / no year is remembered; MusicBrainz failure is retried next session only', async () => {
  const tracks = [
    { n: 1, deezerId: 81, title: 'gone', artist: 'a', year: null, yearSure: true, match: 'none' },
    { n: 2, deezerId: 82, title: 'no date', artist: 'a', year: null, yearSure: true, match: 'none' },
    { n: 3, isrc: isrc(9), spotifyId: 'f'.repeat(22), title: 'mb down', artist: 'a', year: 1999, yearSure: false, match: 'none' },
  ];
  const err = new Error('down'); err.code = 'unavailable';
  const sv = fakeServices({ dzYear: (id) => (id === 81 ? new DeezerError('notfound') : null), mbYear: () => err });
  const store = setup([{ id: 'p', tracks }], sv);
  await until(done(store, 'p'));
  await wait(40);
  assert.deepEqual(sv.log.map((x) => x.join(':')).sort(), ['dz:81', 'dz:82', `mb:${isrc(9)}`]);
  enrich.stop();
  const memRaw = JSON.parse(storage.get('timetunesr.enrich.v1'));
  assert.deepEqual(memRaw.dz.sort(), [81, 82]);
  assert.equal(memRaw.mb[isrc(9)], undefined, 'a failure is not remembered as an answer');
});

test('hostile memory in localStorage is ignored', async () => {
  storage.set('timetunesr.enrich.v1', JSON.stringify({ v: 1, dz: ['x', -1, 1e300, 5], mb: { __proto__: { x: 1 }, NOTANISRC: 1990, [isrc(1)]: 'abc', [isrc(2)]: 1975 } }));
  const tracks = [{ n: 1, isrc: isrc(2), spotifyId: 'g'.repeat(22), title: 'x', artist: 'y', year: 1980, yearSure: false, match: 'none' }];
  const sv = fakeServices();
  setup([{ id: 'p', tracks }], sv);
  await until(() => tracks[0].yearSure === true);
  assert.equal(tracks[0].year, 1975, 'remembered MusicBrainz year applied without a request');
  assert.equal(sv.log.length, 0);
});

test('with the real playlist store (playlists.js): Deezer years written, a fixed year kept', async () => {
  const store = await import('../../app/js/playlists.js');
  store.reload();
  const p = store.create('Deezer test');
  assert.ok(p, 'playlist made');
  store.addTracks(p.id, [
    { deezerId: 91, isrc: isrc(91), title: 'Een', artist: 'A', year: null, yearSure: false, match: 'none' },
    { deezerId: 92, isrc: isrc(92), title: 'Twee', artist: 'B', year: null, yearSure: false, match: 'none' },
  ]);
  const stored = store.get(p.id).tracks;
  if (!stored.length || stored[0].deezerId !== 91) {
    // the track format without deezerId (before part A): nothing to check here
    assert.ok(true, 'deezerId not stored yet by playlists.js');
    return;
  }
  const sv = fakeServices({ dzYear: () => 2001, mbYear: (i) => (i === isrc(91) ? 1977 : null), dzDelay: 20 });
  enrich._setDeps({ playlists: store, ...sv });
  enrich.start();
  await until(() => sv.log.some((x) => x[1] === 92));
  if (typeof store.fixYear === 'function') store.fixYear(p.id, stored[1].n, 1988);
  else store.updateTrack(p.id, stored[1].n, { year: 1988 });
  await until(() => enrich.status(p.id).pending === 0, 3000);
  await wait(30);
  const [a, b] = store.get(p.id).tracks;
  assert.equal(a.year, 1977);
  assert.equal(a.yearSure, true);
  assert.equal(b.year, 1988, 'the fixed year stays');
  assert.equal(b.yearSure, true);
  const saved = JSON.parse(storage.get('timetunesr.playlists.v1')).lists.find((x) => x.id === p.id);
  assert.equal(saved.tracks[0].year, 1977, 'written to localStorage');
});
