// Node: the accounts and prepared rooms on disk (server/core.mjs), against a fake file system:
// a write that fails (data that can not become JSON, a full disk) never stops the server and is
// tried again; only what changed is written, in the background (temp file + rename), one file
// per account / prepared room; an old single file ({ v: 1, accounts, rooms }) still loads and
// moves into the folder. And the data budget: lower, a limit per address, and a full server
// never stops anybody from keeping or shrinking their data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { LIMITS } from '../../server/policy.mjs';
import { dataQuota } from '../../server/accounts.mjs';

const ORIGIN = 'http://localhost:8080';
const PW = 'geheim-wachtwoord-1';
const FILE = '/data/accounts.json';
const DIR = `${FILE}.d`;
const hex = (s) => Buffer.from(s).toString('hex');

/** An in-memory file system with the calls core.mjs uses; `fail` makes the next writes throw. */
function fakeFs(files = {}) {
  const f = { files: new Map(Object.entries(files)), dirs: new Set(['/data']), log: [], failWrites: 0 };
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const write = (p, text, opts) => {
    if (f.failWrites > 0) { f.failWrites--; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }
    f.files.set(p, { text: String(text), mode: opts?.mode });
  };
  Object.assign(f, {
    readFileSync: (p) => { if (!f.files.has(p)) throw enoent(p); return f.files.get(p).text; },
    readdirSync: (d) => {
      if (!f.dirs.has(d)) throw enoent(d);
      return [...f.files.keys()].filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/')).map((p) => p.slice(d.length + 1));
    },
    mkdirSync: (d) => { f.dirs.add(d); },
    writeFileSync: (p, text, opts) => { f.log.push(['writeSync', p]); write(p, text, opts); },
    renameSync: (a, b) => { if (!f.files.has(a)) throw enoent(a); f.files.set(b, f.files.get(a)); f.files.delete(a); f.log.push(['rename', b]); },
    unlinkSync: (p) => { if (!f.files.delete(p)) throw enoent(p); f.log.push(['unlink', p]); },
    promises: {
      mkdir: async (d) => { f.dirs.add(d); },
      writeFile: async (p, text, opts) => { await new Promise((r) => setImmediate(r)); f.log.push(['write', p]); write(p, text, opts); },
      unlink: async (p) => { if (!f.files.delete(p)) throw enoent(p); f.log.push(['unlink', p]); },
    },
  });
  f.json = (p) => JSON.parse(f.files.get(p).text);
  f.names = () => [...f.files.keys()].sort();
  return f;
}

function setup(fs, opts = {}) {
  const errors = [];
  const core = createRoomServer({ now: () => 1_800_000_000_000, iterations: 1000, accountsFile: FILE, fs, writeDelay: 1, retryDelay: 5, logError: (...a) => errors.push(a.join(' ')), ...opts });
  const call = (method, path, body, { token, ip = '10.0.0.1' } = {}) => core.http({ method, path, origin: ORIGIN, ip, auth: token ? `Bearer ${token}` : '', body: body == null ? '' : JSON.stringify(body) });
  return { core, call, errors };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(call, username, ip) {
  const r = await call('POST', '/account/signup', { username, password: PW }, { ip });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token;
}
const playlist = (id, n, pad = 0) => ({
  id, name: `Lijst ${id}`, created: 1, updated: 2, nextN: n + 1,
  tracks: Array.from({ length: n }, (_, i) => ({ n: i + 1, itunesId: 100 + i, title: `T${i}${'x'.repeat(pad)}`, artist: `A${i}`, album: '', year: 1980 + (i % 40), yearSure: true, previewUrl: `https://x.example/${i}.m4a`, trackViewUrl: null })),
});

test('een schrijffout (gegevens die geen JSON worden, een volle schijf) laat de server niet vallen: één keer gemeld, later opnieuw', async () => {
  const fs = fakeFs();
  const { core, call, errors } = setup(fs);
  const a = await signup(call, 'Anouk');
  const b = await signup(call, 'Bram');
  await core.settle();
  assert.ok(fs.files.has(`${DIR}/a-${hex('anouk')}.json`) && fs.files.has(`${DIR}/a-${hex('bram')}.json`));
  // Anouk's record can not become JSON (as a string beyond V8's maximum length could not)
  assert.equal((await call('POST', '/account/data', { rev: 1, data: { playlists: [playlist('p1', 3)] } }, { token: a })).status, 200);
  const broken = { ...core.accounts.get('anouk'), toJSON() { throw new RangeError('Invalid string length'); } };
  core.accounts.set('anouk', broken);
  assert.equal((await call('POST', '/account/data', { rev: 1, data: { playlists: [playlist('b1', 3)] } }, { token: b })).status, 200);
  assert.doesNotThrow(() => core.flush(), 'flush never throws (a timer callback that throws would end the process)');
  await wait(80); // a few retries in the background
  await core.settle();
  assert.equal(errors.length, 1, `logged once (${errors.join(' | ')})`);
  assert.match(errors[0], /Invalid string length/);
  assert.equal((await call('GET', '/health')).status, 200, 'the server still serves');
  assert.equal(fs.json(`${DIR}/a-${hex('bram')}.json`).rec.data.playlists[0].id, 'b1', 'the other accounts are written');
  // Anouk's data becomes writable again: the retry writes it
  core.accounts.set('anouk', { ...broken, toJSON: undefined });
  await wait(150);
  await core.settle();
  assert.equal(fs.json(`${DIR}/a-${hex('anouk')}.json`).rec.data.playlists[0].id, 'p1', 'written by a later retry');
  // the disk is full for a while: logged once, tried again, then it works
  fs.failWrites = 3;
  assert.equal((await call('POST', '/account/data', { rev: 2, data: { playlists: [playlist('q1', 2)] } }, { token: a })).status, 200);
  const before = errors.length;
  await wait(300);
  await core.settle();
  assert.equal(errors.length - before, 1, `one message for a run of failures (${errors.slice(before).join(' | ')})`);
  assert.equal(fs.json(`${DIR}/a-${hex('anouk')}.json`).rec.data.playlists[0].id, 'q1', 'written once the disk had room again');
  assert.ok(!fs.names().some((n) => n.endsWith('.tmp')), `no temp file left (${fs.names()})`);
});

test('alleen wat veranderde wordt geschreven, op de achtergrond (tijdelijk bestand + hernoemen), één bestand per account', async () => {
  const fs = fakeFs();
  const { core, call } = setup(fs);
  const tokens = [];
  for (const n of ['Anouk', 'Bram', 'Cas', 'Daan']) tokens.push(await signup(call, n));
  await core.settle();
  fs.log.length = 0;
  const r = await call('POST', '/account/data', { rev: 1, data: { playlists: [playlist('p1', 50)] } }, { token: tokens[2] });
  assert.equal(r.status, 200);
  await core.settle();
  const writes = fs.log.filter((x) => x[0] === 'write' || x[0] === 'writeSync');
  assert.equal(writes.length, 1, `one file written (${JSON.stringify(fs.log)})`);
  assert.equal(writes[0][0], 'write', 'asynchronously, not with writeFileSync');
  assert.match(writes[0][1], new RegExp(`^${DIR}/a-${hex('cas')}\\.json\\.\\d+\\.\\d+\\.tmp$`));
  assert.deepEqual(fs.log.find((x) => x[0] === 'rename'), ['rename', `${DIR}/a-${hex('cas')}.json`]);
  assert.equal(fs.files.get(`${DIR}/a-${hex('cas')}.json`).mode, 0o600);
  // a deleted account: its file goes
  const d = await call('POST', '/account/delete', { password: PW }, { token: tokens[3] });
  assert.equal(d.status, 200);
  await core.settle();
  assert.ok(!fs.files.has(`${DIR}/a-${hex('daan')}.json`));
  // a restart reads the folder
  const two = setup(fs);
  assert.deepEqual([...two.core.accounts.keys()].sort(), ['anouk', 'bram', 'cas']);
  assert.equal((await two.call('GET', '/account', null, { token: tokens[2] })).body.data.playlists[0].id, 'p1');
});

test('een oud bestand ({ v: 1, accounts, rooms }) laadt nog en gaat over naar de map; daarna is het een merkteken', async () => {
  const fs = fakeFs();
  const { core, call } = setup(fs);
  const token = await signup(call, 'Ilse');
  await call('POST', '/account/data', { rev: 1, data: { playlists: [playlist('p1', 3)] } }, { token });
  await core.settle();
  // the same data as the single file of the version before
  const rec = core.accounts.get('ilse');
  const old = fakeFs({ [FILE]: { text: JSON.stringify({ v: 1, accounts: { ilse: rec, gone: rec }, rooms: {} }), mode: 0o600 } });
  const one = setup(old);
  assert.equal((await one.call('GET', '/account', null, { token })).body.data.playlists[0].id, 'p1', 'the old file loads');
  await one.core.settle();
  assert.deepEqual(old.json(FILE), { v: 2, dir: 'accounts.json.d' }, 'the old file became a marker');
  assert.ok(old.files.has(`${DIR}/a-${hex('ilse')}.json`) && old.files.has(`${DIR}/a-${hex('gone')}.json`));
  // an account deleted after the move stays deleted (the marker holds no accounts any more)
  const g = await one.call('POST', '/account/delete', { password: PW }, { token: (await one.call('POST', '/account/login', { username: 'gone', password: PW })).body.token });
  assert.equal(g.status, 200);
  await one.core.settle();
  const two = setup(old);
  assert.deepEqual([...two.core.accounts.keys()], ['ilse']);
});

test('databudget: lager (een map op één schijf, alles in het geheugen), een grens per adres, en nooit een blokkade voor wie niet groeit', async () => {
  assert.ok(LIMITS.maxAccountData <= 128 * 1024 * 1024 && LIMITS.maxAccountData >= 64 * 1024 * 1024, `budget ${LIMITS.maxAccountData}`);
  assert.ok(LIMITS.accountGrowthPerIp.limit < LIMITS.maxAccountData / 2);
  // the quota itself
  let t = 0;
  const q = dataQuota(1000, { growthPerIp: { limit: 300, windowMs: 100 }, now: () => t });
  assert.equal(q.check('a', 200, 'ip1'), null);
  q.set('a', 200, 'ip1');
  assert.equal(q.check('b', 150, 'ip1'), 'ip', 'one address: at most 300 per window');
  assert.equal(q.check('b', 150, 'ip2'), null);
  q.set('b', 100, 'ip1');
  assert.equal(q.check('a', 50, 'ip1'), null, 'shrinking always fits');
  t = 200;
  assert.equal(q.check('c', 290, 'ip1'), null, 'a new window');
  q.set('c', 700, 'ip3');
  assert.equal(q.total, 1000);
  assert.equal(q.check('d', 1, 'ip4'), 'full');
  assert.equal(q.check('a', 200, 'ip1'), null, 'full: the same size still fits');
  // through the server: a flood from one address stops at the per-address limit, others go on
  const big = { playlists: [playlist('big', 300, 40)] };
  const probe = setup(fakeFs());
  assert.equal((await probe.call('POST', '/account/data', { rev: 1, data: big }, { token: await signup(probe.call, 'probe') })).status, 200);
  const size = Buffer.byteLength(JSON.stringify(probe.core.accounts.get('probe').data)); // as the quota counts it
  const fs = fakeFs();
  const { call } = setup(fs, { limits: { maxAccountData: 10 * size, accountGrowthPerIp: { limit: Math.round(2.5 * size), windowMs: 60_000 } } });
  const flood = [];
  for (const n of ['flood1', 'flood2', 'flood3']) flood.push(await signup(call, n, '10.6.6.6'));
  assert.equal((await call('POST', '/account/data', { rev: 1, data: big }, { token: flood[0], ip: '10.6.6.6' })).status, 200);
  const r2 = await call('POST', '/account/data', { rev: 1, data: big }, { token: flood[1], ip: '10.6.6.6' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const r3 = await call('POST', '/account/data', { rev: 1, data: big }, { token: flood[2], ip: '10.6.6.6' });
  assert.equal(r3.status, 429, 'over the limit of this address');
  assert.equal(r3.body.code, 'ratelimit');
  const other = await signup(call, 'Anouk', '10.0.0.7');
  assert.equal((await call('POST', '/account/data', { rev: 1, data: big }, { token: other, ip: '10.0.0.7' })).status, 200, 'another address still saves');
  // the flooder may still keep or shrink what it has
  assert.equal((await call('POST', '/account/data', { rev: 2, data: { playlists: [playlist('small', 2)] } }, { token: flood[0], ip: '10.6.6.6' })).status, 200);
});
