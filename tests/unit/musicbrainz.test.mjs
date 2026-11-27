// MusicBrainz first-release year (app/js/musicbrainz.js) with a fake fetch: no network.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as mb from '../../app/js/musicbrainz.js';

const tick = () => new Promise((r) => setImmediate(r));
async function advance(ms, step = 50) {
  await tick();
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await tick(); }
}
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fake(answer) {
  const calls = [];
  mb.setFetch(async (url, opts) => { calls.push({ url, at: Date.now(), opts }); return answer(url, calls.length); });
  return calls;
}

beforeEach(() => mb._reset({ gap: 0 }));

test('earliest valid year over the recordings', async () => {
  const calls = fake(() => res(200, { isrc: 'GBAYE0601498', recordings: [
    { title: 'Remaster', 'first-release-date': '2011-09-23' },
    { title: 'Original', 'first-release-date': '1975-10-31' },
    { title: 'Month only', 'first-release-date': '1976-02' },
    { title: 'leeg', 'first-release-date': '' },
    { title: 'onzin', 'first-release-date': 1066 },
    { title: 'te vroeg', 'first-release-date': '1066-01-01' },
  ] }));
  assert.equal(await mb.firstReleaseYear('gbaye0601498'), 1975);
  assert.equal(calls[0].url, 'https://musicbrainz.org/ws/2/isrc/GBAYE0601498?fmt=json');
  assert.equal(calls[0].opts.credentials, 'omit');
  assert.equal(await mb.firstReleaseYear('GBAYE0601498'), 1975, 'cached');
  assert.equal(calls.length, 1);
});

test('404, no dates, invalid ISRCs -> null', async () => {
  const calls = fake((url) => (url.includes('NLA011111111') ? res(404, { error: 'Not Found' }) : res(200, { recordings: [{ title: 'x' }] })));
  assert.equal(await mb.firstReleaseYear('NLA011111111'), null);
  assert.equal(await mb.firstReleaseYear('NLA012222222'), null);
  assert.equal(await mb.firstReleaseYear('nonsense'), null);
  assert.equal(await mb.firstReleaseYear('NL0000000000/../x'), null);
  assert.equal(await mb.firstReleaseYear(null), null);
  assert.equal(calls.length, 2, 'invalid ISRCs are never asked');
});

test('hostile answers: wrong types, __proto__, huge bodies, broken JSON', async () => {
  fake(() => res(200, '{"__proto__":{"recordings":[{"first-release-date":"1950"}]}}'));
  assert.equal(await mb.firstReleaseYear('NLA010000001'), null, 'inherited recordings are not used');
  assert.equal({}.recordings, undefined);
  fake(() => res(200, { recordings: 'many' }));
  assert.equal(await mb.firstReleaseYear('NLA010000002'), null);
  fake(() => res(200, { recordings: [null, 3, 'x', { 'first-release-date': ['1980'] }, { 'first-release-date': '1980-01-01<script>' }] }));
  assert.equal(await mb.firstReleaseYear('NLA010000003'), null);
  fake(() => res(200, 'x'.repeat(1_000_001)));
  await assert.rejects(mb.firstReleaseYear('NLA010000004'), { code: 'unavailable' });
  fake(() => res(200, '{broken'));
  await assert.rejects(mb.firstReleaseYear('NLA010000005'), { code: 'unavailable' });
  fake(() => res(500, 'oops'));
  await assert.rejects(mb.firstReleaseYear('NLA010000006'), { code: 'unavailable' });
  mb.setFetch(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(mb.firstReleaseYear('NLA010000007'), (e) => e instanceof mb.MusicBrainzError && e.code === 'unavailable');
  await assert.rejects(mb.firstReleaseYear('NLA010000008', { signal: AbortSignal.abort() }), { code: 'aborted' });
});

test('queue: one request per 1.1 s', async () => {
  mb._reset(); // the real gap
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  try {
    const calls = fake(() => res(200, { recordings: [{ 'first-release-date': '1990' }] }));
    const all = Promise.all(['NLA010000011', 'NLA010000012', 'NLA010000013', 'NLA010000014'].map((i) => mb.firstReleaseYear(i)));
    await advance(5000);
    assert.deepEqual(await all, [1990, 1990, 1990, 1990]);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 1100, `gap ${calls[i].at - calls[i - 1].at}`);
  } finally { mock.timers.reset(); }
});

test('503 backs off and retries, then gives up', async () => {
  mb._reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 6_000_000 });
  try {
    let n = 0;
    const calls = fake(() => (++n <= 2 ? res(503, 'slow down') : res(200, { recordings: [{ 'first-release-date': '1984-06-01' }] })));
    const p = mb.firstReleaseYear('NLA010000021');
    await advance(15000, 100);
    assert.equal(await p, 1984);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].at - calls[0].at >= 3000, `backed off (${calls[1].at - calls[0].at} ms)`);
    assert.ok(calls[2].at - calls[1].at >= 6000, 'longer the second time');

    fake(() => res(503, 'slow down'));
    const q = mb.firstReleaseYear('NLA010000022').catch((e) => e);
    await advance(40000, 200);
    assert.equal((await q).code, 'unavailable');
  } finally { mock.timers.reset(); }
});

const rec = (title, artist, date, extra = {}) => ({ title, 'first-release-date': date, 'artist-credit': [{ name: artist, artist: { name: artist } }], ...extra });

test('searchFirstReleaseYear: the query, and only clearly matching recordings count', async () => {
  const calls = fake(() => res(200, { count: 7, recordings: [
    rec('Take on Me', 'a-ha', '1985-06-01'),
    rec('Take On Me', 'a‐ha', '1984-10-19'),
    rec('Take on Me', 'a-ha', '1983-01-01', { disambiguation: 'live, 2010-12-04: Oslo Spektrum' }),
    rec('Take on Me (MTV Unplugged)', 'a-ha', '1980-01-01'),
    rec('Take on Me', 'Weezer', '1970-01-01'),
    rec('Take on Me', 'Karaoke Hits Band', '1960-01-01'),
    rec('Take Me Home', 'a-ha', '1950-01-01'),
  ] }));
  assert.equal(await mb.searchFirstReleaseYear({ title: 'Take on Me - 2016 Remaster', artist: 'a-ha, Somebody' }), 1984,
    'the original (1984); not the live take, unplugged version, the cover, karaoke or another song');
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://musicbrainz.org/ws/2/recording');
  assert.equal(u.searchParams.get('query'), 'recording:"Take on Me" AND artist:"a-ha"');
  assert.equal(u.searchParams.get('fmt'), 'json');
  assert.equal(u.searchParams.get('limit'), '10');
  assert.equal(await mb.searchFirstReleaseYear({ title: 'Take on Me - 2016 Remaster', artist: 'a-ha, Somebody' }), 1984);
  assert.equal(calls.length, 1, 'cached');
});

test('searchFirstReleaseYear: a wrong-song answer is ignored; quotes escaped; nothing to search -> null', async () => {
  const calls = fake(() => res(200, { recordings: [rec('Flashdance... What a Feeling (Remix)', 'Irene Cara', '1990'), rec('Flash', 'Queen', '1980')] }));
  assert.equal(await mb.searchFirstReleaseYear({ title: 'Flashdance... What a Feeling', artist: 'Irene Cara' }), null);
  await mb.searchFirstReleaseYear({ title: 'Say "Hi" \\ now', artist: 'X' });
  assert.equal(new URL(calls[1].url).searchParams.get('query'), 'recording:"Say \\"Hi\\" \\\\ now" AND artist:"X"');
  assert.equal(await mb.searchFirstReleaseYear({ title: '', artist: 'X' }), null);
  assert.equal(await mb.searchFirstReleaseYear({ title: 'Y' }), null);
  assert.equal(calls.length, 2);
});

test('searchFirstReleaseYear: hostile shapes are ignored', async () => {
  fake(() => res(200, { recordings: [
    { title: 'Song', 'first-release-date': '1980', 'artist-credit': 'Band' },
    { title: ['Song'], 'first-release-date': '1981', 'artist-credit': [{ name: 'Band' }] },
    { title: 'Song', 'first-release-date': 1982, 'artist-credit': [{ name: 'Band' }] },
    { title: 'Song', 'first-release-date': '1983', 'artist-credit': [{ name: { x: 1 } }] },
    null, 7,
    { title: 'Song', 'first-release-date': '1999-05-05', 'artist-credit': [{ name: 'Band' }] },
  ] }));
  assert.equal(await mb.searchFirstReleaseYear({ title: 'Song', artist: 'Band' }), 1999);
});

test('searchFirstReleaseYear: 503 backs off and retries in the same 1.1 s queue as the ISRC lookups', async () => {
  mb._reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 7_000_000 });
  try {
    let n = 0;
    const calls = fake((url) => (url.includes('/recording?') && ++n === 1 ? res(503, 'busy') : url.includes('/isrc/') ? res(404, {}) : res(200, { recordings: [rec('Venus', 'Bananarama', '1986-05-01')] })));
    const a = mb.firstReleaseYear('NLA010000031');
    const b = mb.searchFirstReleaseYear({ title: 'Venus', artist: 'Bananarama' });
    await advance(15000, 100);
    assert.equal(await a, null);
    assert.equal(await b, 1986);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].at - calls[0].at >= 1100, 'one queue for both');
    assert.ok(calls[2].at - calls[1].at >= 3000, 'backed off after the 503');
  } finally { mock.timers.reset(); }
});

test('MESSAGES: Dutch text per code', () => {
  for (const c of ['offline', 'timeout', 'unavailable', 'aborted']) assert.ok(mb.MESSAGES[c], c);
  assert.equal(mb.errorMessage({ code: 'weird' }), mb.MESSAGES.unavailable);
});
