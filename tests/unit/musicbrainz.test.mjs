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
