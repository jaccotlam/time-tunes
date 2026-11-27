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

const { MusicBrainzError } = await import('../../app/js/musicbrainz.js');

/** Fake services that log every call: [lane, what]. */
function fakeServices({
  dzYear = () => 1999, mbYear = () => null, mbSearch = () => null, apple = () => null,
  dzDelay = 1, mbDelay = 1, appleDelay = 1,
} = {}) {
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
  const mbCall = async (what, arg, fn, signal) => {
    log.push([what, arg]);
    await wait(mbDelay);
    if (signal?.aborted) throw new MusicBrainzError('aborted');
    const y = fn(arg);
    if (y instanceof Error) throw y;
    return y;
  };
  const musicbrainz = {
    firstReleaseYear: (isrc, { signal } = {}) => mbCall('mb', isrc, mbYear, signal),
    searchFirstReleaseYear: ({ title, artist }, { signal } = {}) => mbCall('mbs', `${artist} - ${title}`, mbSearch, signal),
  };
  const appleMatch = async (t, { signal } = {}) => {
    log.push(['apple', t.title]);
    await wait(appleDelay);
    if (signal?.aborted) throw new MusicBrainzError('aborted');
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
const done = (pid) => () => enrich.status(pid).pending === 0;
const kinds = (sv) => sv.log.map((x) => x[0]);

test('yearPending(): a pure predicate on the stored fields', () => {
  const { yearPending, yearChecked } = enrich;
  assert.equal(yearPending({ year: 2011, yearSure: false, isrc: isrc(1), title: 'a', artist: 'b' }), true, 'catalogue year: still to check');
  assert.equal(yearPending({ year: null, yearSure: true, title: 'a', artist: 'b' }), true, 'no year yet');
  assert.equal(yearPending({ year: 2011, yearSure: false, isrc: isrc(1), yearChecked: true }), false, 'checked');
  assert.equal(yearPending({ year: 1982, yearSure: true, title: 'a', artist: 'b' }), false, 'a sure year (typed or confirmed)');
  assert.equal(yearPending({ year: 1982, yearSure: false, yearFixed: true, title: 'a', artist: 'b' }), false, 'typed by the user');
  assert.equal(yearPending({ year: 2011, yearSure: false, title: 'only a title' }), false, 'nothing to check with');
  assert.equal(yearPending(null), false);
  assert.equal(yearChecked({ year: 2011, yearSure: false, yearChecked: true }), true);
  assert.equal(yearChecked({ year: null, yearChecked: true }), false, 'checked but no year: not playable');
});

test('Deezer year and MusicBrainz run side by side; MusicBrainz earlier year wins (sure, checked); Apple last, fragment only', async () => {
  const tracks = [{ n: 1, deezerId: 11, isrc: isrc(1), title: 'Sweet Child O Mine', artist: 'Guns N Roses', year: null, yearSure: true }];
  const sv = fakeServices({ dzDelay: 30, mbDelay: 5, dzYear: () => 2018, mbYear: () => 1987, apple: () => ({ itunesId: 501, previewUrl: 'https://a/1.m4a', trackViewUrl: null, year: 1985, yearSure: true }) });
  setup([{ id: 'p1', tracks }], sv);
  await until(done('p1'), 3000, 'done');
  assert.deepEqual(kinds(sv).slice(0, 2).sort(), ['dz', 'mb'], 'both started before either finished');
  assert.equal(kinds(sv).at(-1), 'apple', 'Apple last');
  const t = tracks[0];
  assert.equal(t.year, 1987, 'MusicBrainz first release beats Deezer 2018 (also when Deezer answers later)');
  assert.equal(t.yearSure, true);
  assert.equal(t.yearChecked, true);
  assert.equal(t.itunesId, 501, 'Apple adds the fragment');
  assert.equal(enrich.yearPending(t), false);
});

test('MusicBrainz LATER than ours: ours kept, checked; not asked again after a reload', async () => {
  const tracks = [{ n: 1, deezerId: 21, isrc: isrc(2), title: 'S', artist: 'A', year: 1990, yearSure: false, match: 'none' }];
  const sv = fakeServices({ mbYear: () => 1995 });
  setup([{ id: 'p1', tracks }], sv);
  await until(done('p1'));
  assert.equal(tracks[0].year, 1990);
  assert.equal(tracks[0].yearSure, false);
  assert.equal(tracks[0].yearChecked, true);
  assert.deepEqual(kinds(sv), ['mb'], 'no search after an ISRC hit; no Deezer (has a year); match none: no Apple');
  await wait(20);
  enrich.stop();
  delete tracks[0].yearChecked; // even a store that lost the mark: the answer is remembered
  enrich._reset();
  enrich.start();
  await until(done('p1'));
  await wait(50);
  assert.equal(sv.log.length, 1, 'no new requests after the reload');
});

test('ISRC unknown (404) -> title/artist search fallback; no ISRC -> search directly', async () => {
  const tracks = [
    { n: 1, isrc: isrc(3), spotifyId: 'a'.repeat(22), title: 'Take on Me', artist: 'a-ha', year: 2010, yearSure: false, match: 'none' },
    { n: 2, spotifyId: 'b'.repeat(22), title: 'Venus', artist: 'Bananarama', year: 2017, yearSure: false, match: 'none' },
  ];
  const sv = fakeServices({ mbYear: () => null, mbSearch: (q) => (q.startsWith('a-ha') ? 1984 : 1986) });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  assert.deepEqual(sv.log.map((x) => x.join(':')).sort(), [`mb:${isrc(3)}`, 'mbs:Bananarama - Venus', 'mbs:a-ha - Take on Me']);
  const l = sv.log.map((x) => x.join(':'));
  assert.ok(l.indexOf(`mb:${isrc(3)}`) < l.indexOf('mbs:a-ha - Take on Me'), 'the ISRC first, the search after the 404');
  assert.equal(tracks[0].year, 1984);
  assert.equal(tracks[1].year, 1986);
  assert.ok(tracks.every((t) => t.yearChecked === true && t.yearSure === false), 'a search year is checked but NOT sure');
  assert.ok(tracks.every((t) => !enrich.yearPending(t) && enrich.yearChecked(t)));
});

test('a search year is only taken when EARLIER than ours; an ISRC year also when equal (and then sure)', async () => {
  const tracks = [
    { n: 1, spotifyId: 'l'.repeat(22), title: 'Later', artist: 'A', year: 1980, yearSure: false, match: 'none' },
    { n: 2, spotifyId: 'm'.repeat(22), title: 'Same', artist: 'A', year: 1982, yearSure: false, match: 'none' },
    { n: 3, spotifyId: 'o'.repeat(22), title: 'None yet', artist: 'A', year: null, yearSure: true, match: 'none' },
    { n: 4, spotifyId: 'p'.repeat(22), isrc: isrc(44), title: 'Isrc same', artist: 'A', year: 1983, yearSure: false, match: 'none' },
  ];
  const sv = fakeServices({ mbYear: () => 1983, mbSearch: (q) => ({ 'A - Later': 1985, 'A - Same': 1982, 'A - None yet': 1990 })[q] });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  assert.deepEqual(tracks.map((t) => [t.year, t.yearSure, t.yearChecked]), [
    [1980, false, true], // search later: ours stays
    [1982, false, true], // search the same: ours stays, still not sure
    [1990, false, true], // no year yet: the search year, not sure
    [1983, true, true], // ISRC lookup the same: sure
  ]);
  assert.ok(!sv.log.some((x) => x[0] === 'mbs' && x[1].includes('Isrc same')), 'ISRC hit: no search');
});

test('MusicBrainz ISRC and search answer nothing earlier -> checked right there, not sure (no wait for Apple); Apple later only LOWERS', async () => {
  const tracks = [
    { n: 1, spotifyId: 'c'.repeat(22), isrc: isrc(4), title: 'Smells Like Teen Spirit', artist: 'Nirvana', year: 2011, yearSure: false, match: 'pending' },
    { n: 2, spotifyId: 'd'.repeat(22), title: 'Alleen Op Spotify', artist: 'Testband', year: 2019, yearSure: false, match: 'pending' },
  ];
  let releaseApple;
  const appleGate = new Promise((r) => { releaseApple = r; });
  const sv = fakeServices({ apple: (t) => (t.title.startsWith('Smells') ? { itunesId: 901, previewUrl: null, trackViewUrl: null, year: 1991, yearSure: true } : null) });
  const appleInner = sv.appleMatch;
  sv.appleMatch = async (t, o) => { await appleGate; return appleInner(t, o); };
  setup([{ id: 'p', tracks }], sv);
  // the check finishes while Apple has not answered at all
  await until(() => tracks.every((t) => t.yearChecked === true), 3000, 'both checked without Apple');
  assert.equal(tracks[0].year, 2011, 'the catalogue year stays');
  assert.equal(tracks[0].yearSure, false, 'not sure');
  assert.equal(tracks[1].year, 2019);
  assert.equal(tracks[1].yearSure, false, '"controleer het jaar"');
  assert.ok(kinds(sv).includes('mb') && kinds(sv).includes('mbs'), 'ISRC lookup and the search both answered first');
  releaseApple();
  await until(done('p'));
  assert.equal(tracks[0].itunesId, 901, 'Apple adds the fragment in the background');
  assert.equal(tracks[0].year, 1991, 'and lowers the not-sure year (an earlier release of the recording)');
  assert.equal(tracks[0].yearSure, false, 'still not sure: Apple never makes a year sure');
  assert.equal(tracks[0].yearChecked, true);
  assert.equal(tracks[1].match, 'none');
  assert.equal(tracks[1].year, 2019);
});

test('Apple never raises a year and never touches a sure one', async () => {
  const tracks = [
    { n: 1, spotifyId: 'l'.repeat(22), title: 'Later', artist: 'A', year: 1980, yearSure: false, yearChecked: true, match: 'pending' },
    { n: 2, spotifyId: 'm'.repeat(22), title: 'Sure', artist: 'B', year: 1990, yearSure: true, match: 'pending' },
    { n: 3, spotifyId: 'o'.repeat(22), title: 'Same', artist: 'C', year: 1975, yearSure: false, yearChecked: true, match: 'pending' },
  ];
  const years = { Later: 1984, Sure: 1985, Same: 1975 };
  const sv = fakeServices({ apple: (t) => ({ itunesId: { Later: 601, Sure: 602, Same: 603 }[t.title], previewUrl: null, trackViewUrl: null, year: years[t.title], yearSure: true }) });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  assert.deepEqual(tracks.map((t) => [t.year, !!t.yearSure, !!t.itunesId]), [[1980, false, true], [1990, true, true], [1975, false, true]]);
});

test('prepare({ min }) needs no Apple at all: every ISRC unknown, every search empty, Apple hangs', async () => {
  const tracks = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, deezerId: 9100 + i, isrc: isrc(9100 + i), title: `nieuw ${i}`, artist: 'a', year: null, yearSure: true }));
  const sv = fakeServices({ dzYear: () => 2026 });
  sv.appleMatch = () => new Promise(() => {}); // never answers
  setup([{ id: 'new', tracks }], sv);
  const st = await enrich.prepare('new', { min: 30 });
  assert.ok(st.yearsChecked >= 30, `checked ${st.yearsChecked}`);
  assert.ok(tracks.filter((t) => t.yearChecked).every((t) => t.year === 2026 && t.yearSure === false), 'catalogue year kept, not sure');
});

test('a failed MusicBrainz request is not an answer: the year stays pending (Apple does not finish it)', async () => {
  const tracks = [{ n: 1, spotifyId: 'p'.repeat(22), isrc: isrc(31), title: 'x', artist: 'y', year: 2001, yearSure: false, match: 'pending' }];
  const sv = fakeServices({ mbYear: () => new MusicBrainzError('unavailable'), apple: () => ({ itunesId: 31, previewUrl: null, trackViewUrl: null, year: 1999, yearSure: true }) });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  assert.equal(enrich.yearPending(tracks[0]), true, 'still pending');
  assert.equal(tracks[0].yearChecked, undefined);
  assert.equal(tracks[0].itunesId, 31, 'Apple still adds the fragment');
  assert.equal(tracks[0].year, 1999, 'and may lower the not-sure year');
  assert.equal(tracks[0].yearSure, false);
});

test('Apple: songs without a Deezer preview first', async () => {
  const tracks = [
    ...Array.from({ length: 3 }, (_, i) => ({ n: i + 1, deezerId: 9300 + i, title: `dz${i}`, artist: 'a', year: 1990, yearSure: true, match: 'pending' })),
    ...Array.from({ length: 3 }, (_, i) => ({ n: i + 4, spotifyId: String(i + 5).repeat(22), title: `sp${i}`, artist: 'a', year: 1990, yearSure: true, match: 'pending' })),
  ];
  const sv = fakeServices({ apple: () => null });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  const order = sv.log.filter((x) => x[0] === 'apple').map((x) => x[1]);
  assert.deepEqual(order.slice(0, 3).sort(), ['sp0', 'sp1', 'sp2'], `Spotify-only songs first (${order})`);
});

test('a full localStorage: the worker stops (no more requests), says so in status(), resumes when a write fits again', async () => {
  const tracks = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, deezerId: 9400 + i, title: `t${i}`, artist: 'a', year: null, yearSure: true, match: 'none' }));
  const store = fakeStore([{ id: 'p', tracks }]);
  let full = true;
  let failures = 0;
  let lastError = null;
  let messages = 0;
  const orig = store.updateTracks;
  const origOne = store.updateTrack;
  store.updateTrack = (...a) => { lastError = null; return origOne(...a); }; // the player's own change fits
  store.writeFailures = () => failures;
  store.lastWriteError = () => lastError;
  store.updateTracks = (id, changes) => {
    if (full) { failures++; lastError = 'storage'; if (failures === 1) messages++; return 0; } // nothing stored
    lastError = null;
    return orig(id, changes);
  };
  const sv = fakeServices({ dzYear: () => 1999 });
  enrich._setDeps({ playlists: store, ...sv });
  enrich.start();
  await until(() => enrich.status('p').storageFull, 3000, 'stopped for storage');
  const asked = sv.log.length;
  await wait(200);
  assert.equal(sv.log.length, asked, `no further network calls after the failure (${asked})`);
  assert.equal(failures, 1, 'one failed write, not one per attempt');
  assert.equal(messages, 1, 'one message');
  assert.equal(enrich.status('p').working, false);
  await assert.rejects(enrich.prepare('p', { min: 5 }), (e) => e.code === 'storage' && /opslag/.test(enrich.errorMessage(e)));
  // the player frees space: a write that fits (any playlist change) lets the worker go on
  full = false;
  store.updateTrack('p', 20, { title: 't19' });
  await until(() => tracks.every((t) => t.year === 1999), 3000, 'the rest after space was freed');
  assert.equal(enrich.status('p').storageFull, false);
});

test('Spotify song checked by MusicBrainz: Apple only adds the fragment, never a later (or other) year', async () => {
  const tracks = [{ n: 1, spotifyId: 'e'.repeat(22), isrc: isrc(5), title: 'Like a Prayer', artist: 'Madonna', year: 2005, yearSure: false, match: 'pending' }];
  const sv = fakeServices({ mbYear: () => 1989, apple: () => ({ itunesId: 77, previewUrl: null, trackViewUrl: null, year: 2009, yearSure: true }) });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  assert.deepEqual(kinds(sv), ['mb', 'apple']);
  assert.equal(tracks[0].year, 1989);
  assert.equal(tracks[0].itunesId, 77);
});

test('a year the user typed is never touched (not by MusicBrainz, Apple, or a Deezer answer in flight)', async () => {
  const tracks = [
    { n: 1, isrc: isrc(6), spotifyId: 'f'.repeat(22), title: 'Fixed', artist: 'A', year: 1970, yearSure: true, yearFixed: true },
    { n: 2, deezerId: 32, isrc: isrc(7), title: 'Typed meanwhile', artist: 'B', year: null, yearSure: true, match: 'none' },
  ];
  const sv = fakeServices({
    dzDelay: 40, mbDelay: 40, dzYear: () => 2005, mbYear: () => 1960,
    apple: () => ({ itunesId: 777, previewUrl: null, trackViewUrl: null, year: 1965, yearSure: true }),
  });
  const store = setup([{ id: 'p1', tracks }], sv);
  await until(() => sv.log.some((x) => x[0] === 'dz') && sv.log.some((x) => x[0] === 'mb'));
  store.updateTrack('p1', 2, { year: 1983, yearSure: true, yearFixed: true }); // typed while both are asked
  await until(done('p1'));
  await wait(60);
  assert.ok(!sv.log.some((x) => x[1] === isrc(6)), 'a typed year needs no check');
  assert.equal(tracks[0].year, 1970);
  assert.equal(tracks[0].itunesId, 777, 'Apple still adds the fragment');
  assert.equal(tracks[1].year, 1983, 'neither the late Deezer nor the late MusicBrainz answer overwrote it');
});

test('Apple: a duplicate fragment is not taken twice', async () => {
  const tracks = [
    { n: 1, itunesId: 900, title: 'Have', artist: 'A', year: 1980, yearSure: true },
    { n: 2, spotifyId: 'g'.repeat(22), title: 'Dup', artist: 'A', year: 1981, yearSure: true, match: 'pending' },
  ];
  const sv = fakeServices({ apple: () => ({ itunesId: 900, year: 1980, yearSure: true }) });
  setup([{ id: 'p1', tracks }], sv);
  assert.equal(enrich.status('p1').appleTodo, 1);
  await until(done('p1'));
  assert.equal(tracks[1].match, 'none');
  assert.equal(tracks[1].itunesId, undefined);
  assert.equal(enrich.status('p1').appleDone, 1);
});

test('status(): the counts', () => {
  const tracks = [
    { n: 1, itunesId: 1, year: 1980, yearSure: true, title: 'a', artist: 'x' },
    { n: 2, deezerId: 2, year: 1981, yearSure: false, title: 'b', artist: 'x', match: 'none' },
    { n: 3, deezerId: 3, year: null, yearSure: true, title: 'c', artist: 'x', match: 'none' },
    { n: 4, spotifyId: 'h'.repeat(22), year: 1990, yearSure: false, yearChecked: true, title: 'd', artist: 'x', match: 'none' },
  ];
  enrich._setDeps({ playlists: fakeStore([{ id: 'p', tracks }]) });
  const st = enrich.status('p');
  const pickKeys = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
  assert.deepEqual(pickKeys(st, ['total', 'ready', 'yearsChecked', 'yearsPending', 'yearsMissing', 'yearsUnsure', 'fragmentsMissing', 'working']),
    { total: 4, ready: 3, yearsChecked: 2, yearsPending: 2, yearsMissing: 1, yearsUnsure: 2, fragmentsMissing: 1, working: false });
  assert.equal(enrich.status('nope').total, 0);
});

test('writes of Deezer years are batched (one store write per batch)', async () => {
  const tracks = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, deezerId: 1000 + i, title: `t${i}`, year: null, yearSure: true, match: 'none' }));
  enrich._configure({ flushMs: 30 });
  const store = setup([{ id: 'p1', tracks }], fakeServices());
  await until(done('p1'));
  assert.ok(tracks.every((t) => t.year === 1999 && t.yearSure === false));
  assert.ok(store.writes.length < 20, `${store.writes.length} writes for 40 songs`);
});

test('the active playlist goes first, then the one asked for comes before everything', async () => {
  const mk = (id, base) => ({ id, tracks: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, deezerId: base + i, title: 'x', year: null, yearSure: true, match: 'none' })) });
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
  assert.equal(ids.slice(0, lastB).filter((id) => id < 200).length, 0, 'b (asked for) before a');
});

test('pause() stops new work (and Apple/MusicBrainz in flight); resume() continues', async () => {
  const tracks = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, spotifyId: String(i).repeat(22), title: `s${i}`, artist: 'a', year: 1990, yearSure: true, match: 'pending' }));
  const sv = fakeServices({ appleDelay: 30, apple: () => null });
  setup([{ id: 'p1', tracks }], sv);
  await until(() => sv.log.length === 1);
  enrich.pause('game');
  assert.equal(enrich.isPaused(), true);
  await wait(120);
  assert.equal(sv.log.length, 1, 'nothing new while paused');
  assert.equal(tracks[0].match, 'pending', 'the aborted search is not marked "none"');
  assert.equal(enrich.status('p1').working, false);
  enrich.pause('audio');
  enrich.resume('game');
  await wait(60);
  assert.equal(sv.log.length, 1, 'still paused for the other reason');
  enrich.resume('audio');
  await until(done('p1'));
  assert.ok(tracks.every((t) => t.match === 'none'));
});

test('prepare(): resolves on CHECKED years (not merely fetched), from all over the list; the rest goes on', async () => {
  const tracks = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, deezerId: 5000 + i, isrc: isrc(5000 + i), title: `t${i}`, artist: 'a', year: null, yearSure: true, match: 'none' }));
  const sv = fakeServices({ dzDelay: 2, mbDelay: 8, dzYear: (id) => 2000 + (id % 20), mbYear: (i) => 1960 + (Number(i.slice(-3)) % 30) });
  setup([{ id: 'big', tracks }], sv);
  const progress = [];
  const st = await enrich.prepare('big', { min: 12, onProgress: (s) => progress.push([s.ready, s.yearsChecked]) });
  assert.ok(st.yearsChecked >= 12, `checked ${st.yearsChecked}`);
  assert.ok(st.yearsChecked < 200, 'resolved before the whole list was checked');
  assert.ok(progress.some(([ready, checked]) => ready > checked), 'onProgress reports fetched and checked years separately');
  const before = progress.filter(([, c]) => c < 12);
  assert.ok(before.length > 0 && before.some(([r]) => r >= 12), 'it did not resolve on fetched (unchecked) Deezer years');
  const got = tracks.map((t, i) => (t.yearChecked ? i : -1)).filter((i) => i >= 0);
  const quarters = [0, 1, 2, 3].map((q) => got.filter((i) => Math.floor(i / 50) === q).length);
  assert.ok(quarters.every((n) => n >= 2), `a fair sample of the list (${quarters})`);
  assert.ok(sv.log.findIndex((x) => x[0] === 'mb') < sv.log.filter((x) => x[0] === 'dz').length, 'MusicBrainz started before all Deezer years were in');
  await until(() => tracks.every((t) => t.yearChecked), 8000, 'the rest in the background');
});

test('prepare(): works while paused (only for that list), short lists, resolves at once when ready', async () => {
  const mk = (id, base, n) => ({ id, tracks: Array.from({ length: n }, (_, i) => ({ n: i + 1, deezerId: base + i, isrc: isrc(base + i), title: 'x', artist: 'y', year: null, yearSure: true, match: 'none' })) });
  const lists = [mk('other', 100, 5), mk('want', 200, 8)];
  const sv = fakeServices({ mbYear: () => 1980 });
  enrich.pause('game');
  setup(lists, sv);
  const st = await enrich.prepare('want', { min: 30 });
  assert.equal(st.yearsChecked, 8, 'fewer songs than min: resolves when nothing more can be checked');
  assert.ok(sv.log.every((x) => (x[0] === 'dz' ? x[1] >= 200 : Number(x[1].slice(-3)) >= 200)), 'the other list waits for the pause');
  assert.equal((await enrich.prepare('want', { min: 5 })).yearsChecked, 8);
  enrich.resume('game');
  await until(() => enrich.status('other').pending === 0);
});

test('prepare(): rejects when Deezer or MusicBrainz keeps failing; abort', async () => {
  const tracks = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, deezerId: 7000 + i, title: 'x', year: null, yearSure: true, match: 'none' }));
  setup([{ id: 'p', tracks }], fakeServices({ dzYear: () => new DeezerError('unavailable') }));
  await assert.rejects(enrich.prepare('p', { min: 10 }), (e) => e instanceof DeezerError && e.code === 'unavailable');
  const ctrl = new AbortController();
  const p = enrich.prepare('p', { min: 10, signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, { code: 'aborted' });
  enrich.stop(); enrich._reset();
  const t2 = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, isrc: isrc(i), title: `x${i}`, artist: 'y', year: 2001, yearSure: false, match: 'none' }));
  setup([{ id: 'q', tracks: t2 }], fakeServices({ mbYear: () => new MusicBrainzError('unavailable') }));
  const e = await enrich.prepare('q', { min: 10 }).catch((x) => x);
  assert.ok(e instanceof MusicBrainzError && e.code === 'unavailable');
  assert.match(enrich.errorMessage(e), /MusicBrainz/);
  assert.match(enrich.errorMessage(new DeezerError('quota')), /Deezer/);
  assert.ok(t2.every((t) => !t.yearChecked), 'a failure never counts as checked');
});

test('Deezer notfound / no year is remembered; a MusicBrainz failure is not remembered as an answer', async () => {
  const tracks = [
    { n: 1, deezerId: 81, title: 'gone', year: null, yearSure: true, match: 'none' },
    { n: 2, deezerId: 82, title: 'no date', year: null, yearSure: true, match: 'none' },
    { n: 3, isrc: isrc(9), spotifyId: 'i'.repeat(22), title: 'mb down', artist: 'a', year: 1999, yearSure: false, match: 'none' },
  ];
  const sv = fakeServices({ dzYear: (id) => (id === 81 ? new DeezerError('notfound') : null), mbYear: () => new MusicBrainzError('unavailable') });
  setup([{ id: 'p', tracks }], sv);
  await until(done('p'));
  await wait(40);
  assert.deepEqual(sv.log.map((x) => x.join(':')).sort(), ['dz:81', 'dz:82', `mb:${isrc(9)}`]);
  assert.equal(tracks[2].yearChecked, undefined);
  assert.equal(enrich.yearPending(tracks[2]), true, 'still pending: retried in a later session');
  enrich.stop();
  const memRaw = JSON.parse(storage.get('timetunesr.enrich.v1'));
  assert.deepEqual(memRaw.dz.sort(), [81, 82]);
  assert.equal(memRaw.mb[isrc(9)], undefined);
});

test('hostile memory in localStorage is ignored', async () => {
  storage.set('timetunesr.enrich.v1', JSON.stringify({ v: 1, dz: ['x', -1, 1e300, 5], mb: { NOTANISRC: 1990, [isrc(1)]: 'abc', [isrc(2)]: 1975 }, ms: { nobar: 1980, 'a|b': '1970', ['x|'.repeat(100)]: 1960 } }).replace('"mb":{', '"mb":{"__proto__":{"x":1},'));
  const tracks = [{ n: 1, isrc: isrc(2), spotifyId: 'j'.repeat(22), title: 'x', artist: 'y', year: 1980, yearSure: false, match: 'none' }];
  const sv = fakeServices();
  setup([{ id: 'p', tracks }], sv);
  await until(() => tracks[0].yearChecked === true);
  assert.equal(tracks[0].year, 1975, 'remembered MusicBrainz year applied without a request');
  assert.equal(sv.log.length, 0);
  assert.equal({}.x, undefined);
});

test('a store that drops yearChecked: no endless loop, checked for this session', async () => {
  const tracks = [{ n: 1, spotifyId: 'k'.repeat(22), title: 'x', artist: 'y', year: 1980, yearSure: false, match: 'none' }];
  const store = fakeStore([{ id: 'p', tracks }]);
  const orig = store.updateTracks;
  store.updateTracks = (id, changes) => orig(id, changes.map(({ n, patch }) => ({ n, patch: { ...patch, yearChecked: undefined } })));
  const sv = fakeServices();
  enrich._setDeps({ playlists: store, ...sv });
  enrich.start();
  await until(done('p'));
  await wait(80);
  assert.equal(sv.log.length, 1, 'searched once');
  assert.equal(store.writes.length, 1, 'written once');
  assert.equal(enrich.status('p').yearsChecked, 1);
});

test('with the real playlist store (playlists.js): checked years written, a fixed year kept', async () => {
  const store = await import('../../app/js/playlists.js');
  store.reload();
  const p = store.create('Deezer test');
  assert.ok(p, 'playlist made');
  store.addTracks(p.id, [
    { deezerId: 91, isrc: isrc(91), title: 'Een', artist: 'A', year: null, yearSure: false, match: 'none' },
    { deezerId: 92, isrc: isrc(92), title: 'Twee', artist: 'B', year: null, yearSure: false, match: 'none' },
  ]);
  const stored = store.get(p.id).tracks;
  assert.equal(stored[0].deezerId, 91, 'deezerId stored (part A)');
  const sv = fakeServices({ dzYear: () => 2001, mbYear: (i) => (i === isrc(91) ? 1977 : null), dzDelay: 20, mbDelay: 20 });
  enrich._setDeps({ playlists: store, ...sv });
  enrich.start();
  await until(() => sv.log.some((x) => x[1] === 92));
  store.fixYear(p.id, stored[1].n, 1988);
  await until(() => enrich.status(p.id).pending === 0, 3000);
  await wait(30);
  const [a, b] = store.get(p.id).tracks;
  assert.equal(a.year, 1977);
  assert.equal(a.yearSure, true);
  assert.equal(b.year, 1988, 'the fixed year stays');
  assert.equal(enrich.status(p.id).yearsChecked, 2);
  const saved = JSON.parse(storage.get('timetunesr.playlists.v1')).lists.find((x) => x.id === p.id);
  assert.equal(saved.tracks[0].year, 1977, 'written to localStorage');
});
