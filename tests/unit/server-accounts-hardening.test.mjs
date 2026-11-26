// Hardening of the accounts after a security review: the client address behind proxies, the
// limiter maps under a flood of keys, separate caps for prepared rooms and accounts (Node),
// nothing reaches an account object for a forged token or a blocked address, owner tokens of
// prepared rooms rotated on "log out everywhere" / password change / recovery, the login lock
// not stopping a valid session or a recovery, invisible characters in names, body limits read
// before the body, and the app never sending its token to another server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import { createRoomServer } from '../../server/core.mjs';
import { startNodeServer, clientAddress } from '../../server/node.mjs';
import { rateLimiter } from '../../server/policy.mjs';
import { failCounter, cleanRoomName, RECOVER_FAILS } from '../../server/accounts.mjs';
import { handleAccount, accountLimiters, ACCOUNT_LIMITS, tooDeep } from '../../server/account-http.mjs';
import { cleanName } from '../../app/js/multi/game.js';
import { SERVER_PROTOCOL_VERSION } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const PW = 'geheim-wachtwoord-1';
const flush = () => new Promise((r) => setTimeout(r, 80));

function setup(opts = {}) {
  let t = 1_800_000_000_000;
  const core = createRoomServer({ now: () => t, iterations: 1000, ...opts });
  const call = (method, path, body, { token, ip = '10.0.0.1', raw } = {}) => core.http({ method, path, origin: ORIGIN, ip, auth: token ? `Bearer ${token}` : '', body: raw ?? (body == null ? '' : JSON.stringify(body)) });
  return { core, call, advance: (ms) => { t += ms; } };
}
const signup = async (call, username, ip = '10.0.0.1') => {
  const r = await call('POST', '/account/signup', { username, password: PW }, { ip });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.9' });
  const msgs = [];
  const p = { msgs };
  p.conn = up.attach({ send: (text) => msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)), close: () => {} });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  return p;
}

test('clientadres: X-Forwarded-For alleen met TRUST_PROXY, en dan de laatste vertrouwde stap', () => {
  assert.equal(clientAddress({ forwardedFor: '1.2.3.4', remote: '9.9.9.9' }), '9.9.9.9', 'default: the socket');
  assert.equal(clientAddress({ forwardedFor: 'gelogen, 5.6.7.8', remote: '10.0.0.1', trustProxy: 1 }), '5.6.7.8');
  assert.equal(clientAddress({ forwardedFor: 'a, b, 5.6.7.8, 10.1.1.1', remote: '10.0.0.1', trustProxy: '2' }), '5.6.7.8');
  assert.equal(clientAddress({ forwardedFor: '5.6.7.8', remote: '10.0.0.1', trustProxy: 3 }), '5.6.7.8');
  assert.equal(clientAddress({ forwardedFor: '', remote: '10.0.0.1', trustProxy: 1 }), '10.0.0.1');
});

test('Node-server: een zelfgeschreven X-Forwarded-For omzeilt de limieten niet', async () => {
  const srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true, iterations: 1000, trustProxy: 0 });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await post('/account/signup', { username: `spam${i}abc`, password: 'longpassword1' }, { 'x-forwarded-for': `10.1.${i}.1` })).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429, 429]);
    const fails = {};
    for (let i = 0; i < 40; i++) {
      const r = await post('/account/login', { username: `ghost${i}xyz`, password: 'x' }, { 'x-forwarded-for': `10.2.${i}.1` });
      fails[r.status] = (fails[r.status] || 0) + 1;
    }
    assert.deepEqual(fails, { 401: 30, 429: 10 });
  } finally { await srv.close(); }
});

test('limiet-tabellen: een vloed van nieuwe sleutels zet niemands teller terug', () => {
  let t = 0;
  const lim = rateLimiter({ limit: 2, windowMs: 60000, now: () => t, maxKeys: 100 });
  lim.allow('boef'); lim.allow('boef');
  assert.equal(lim.allow('boef'), false);
  for (let i = 0; i < 1000; i++) { t += 1; lim.allow(`k${i}`); }
  assert.ok(lim.size <= 100);
  // the flood evicted the oldest entries, not everything: the newest are still counted
  assert.equal(lim.allow('k999'), true);
  assert.equal(lim.allow('k999'), false);
  const fc = failCounter({ limit: 2, windowMs: 60000, now: () => t, maxKeys: 100 });
  for (let i = 0; i < 200; i++) fc.fail(`x${i}`);
  fc.fail('boef'); fc.fail('boef');
  for (let i = 0; i < 50; i++) fc.fail(`y${i}`);
  assert.equal(fc.blocked('boef'), true, 'a key just locked stays locked');
});

test('Node: klaargezette kamers hebben een eigen maximum en verdringen gewone kamers nooit; maximum aantal accounts', async () => {
  const { call } = setup({ limits: { maxRooms: 3, maxPreparedRooms: 4, maxAccounts: 2 } });
  const a = await signup(call, 'vulA', '10.0.0.1');
  const b = await signup(call, 'vulB', '10.0.0.2');
  const third = await call('POST', '/account/signup', { username: 'vulC', password: PW }, { ip: '10.0.0.3' });
  assert.equal(third.status, 503);
  assert.equal(third.body.code, 'full');
  const made = [];
  for (const tok of [a.token, a.token, b.token, b.token, b.token]) made.push((await call('POST', '/account/rooms', { name: 'Feest' }, { token: tok })).status);
  assert.deepEqual(made, [201, 201, 201, 201, 503]);
  // normal rooms: all 3 still possible
  for (let i = 0; i < 3; i++) assert.equal(call('POST', '/rooms', { v: V, id: `owner0${i}`, name: 'X' }, { ip: `10.5.0.${i}` }).status, 201);
  const fourth = call('POST', '/rooms', { v: V, id: 'owner09', name: 'X' }, { ip: '10.5.0.9' });
  assert.equal(fourth.status, 503);
  assert.equal(fourth.body.error, 'full');
});

test('worker-kant: vervalste tokens bereiken na de limiet geen account-object meer; misvormde nooit', async () => {
  const limiters = accountLimiters();
  let calls = 0;
  const boxFor = () => ({ call: async () => { calls++; return { status: 401, body: { code: 'session', message: 'x' } }; } });
  const rnd = (i) => `naam${i.toString(36)}xx`;
  const statuses = {};
  for (let i = 0; i < 500; i++) {
    const out = await handleAccount({ method: 'GET', path: '/account', auth: `Bearer tta1.${rnd(i)}.${'A'.repeat(43)}`, ip: '1.2.3.4', body: '' }, { boxFor, limiters });
    statuses[out.status] = (statuses[out.status] || 0) + 1;
  }
  assert.equal(calls, ACCOUNT_LIMITS.failsPerIp.limit, 'only until the address is blocked');
  assert.equal(statuses[429], 500 - calls);
  // malformed and reserved-name tokens: refused without any object
  const l2 = accountLimiters();
  calls = 0;
  for (const auth of ['Bearer kapot', 'Bearer tta1.admin.' + 'A'.repeat(43), 'Bearer tta1.ab.' + 'A'.repeat(43), '']) {
    const out = await handleAccount({ method: 'GET', path: '/account', auth, ip: '1.2.3.5', body: '' }, { boxFor, limiters: l2 });
    assert.equal(out.status, 401);
  }
  assert.equal(calls, 0);
  // successful logins count too (each one costs PBKDF2 in the object)
  const l3 = accountLimiters();
  let logins = 0;
  const ok = () => ({ call: async () => { logins++; return { status: 200, body: { token: 'x' } }; } });
  for (let i = 0; i < 100; i++) await handleAccount({ method: 'POST', path: '/account/login', auth: '', ip: '1.2.3.6', body: JSON.stringify({ username: 'mijnnaam', password: 'x' }) }, { boxFor: ok, limiters: l3 });
  assert.equal(logins, ACCOUNT_LIMITS.hashPerIp.limit);
  // every account request per address
  const l4 = accountLimiters();
  let n = 0;
  const fine = () => ({ call: async () => { n++; return { status: 200, body: {} }; } });
  for (let i = 0; i < 200; i++) await handleAccount({ method: 'GET', path: '/account', auth: `Bearer tta1.mijnnaam.${'A'.repeat(43)}`, ip: '1.2.3.7', body: '' }, { boxFor: fine, limiters: l4 });
  assert.equal(n, ACCOUNT_LIMITS.requestsPerIp.limit);
});

test('eigenaarstoken van klaargezette kamers wordt vervangen bij overal uitloggen, wachtwoord wijzigen en herstel', async () => {
  const { call, core } = setup();
  const a = await signup(call, 'alice');
  const room = (await call('POST', '/account/rooms', { name: 'Feest' }, { token: a.token })).body.room;
  const open = async (token) => (await call('POST', `/account/rooms/${room.code}/open`, null, { token })).body;
  const hello = async (o) => { const h = connect(core, room.code); h.send({ t: 'hello', v: V, code: room.code, id: o.id, token: o.token }); await flush(); return h; };
  // log out everywhere
  let o = await open(a.token);
  let h = await hello(o);
  assert.equal(h.last('welcome').owner, true);
  await call('POST', '/account/logout-all', null, { token: a.token });
  await flush();
  assert.equal(h.last('error')?.code, 'token', 'the open owner connection is closed');
  assert.equal((await hello(o)).last('error')?.code, 'token', 'the old token does not work');
  // password change: the device that changed it opens the room again with its session
  const t2 = (await call('POST', '/account/login', { username: 'alice', password: PW })).body.token;
  o = await open(t2);
  h = await hello(o);
  assert.equal((await call('POST', '/account/password', { password: PW, newPassword: 'tweede-wachtwoord' }, { token: t2 })).status, 200);
  await flush();
  assert.equal(h.last('error')?.code, 'token');
  assert.equal((await hello(o)).last('error')?.code, 'token');
  const again = await open(t2);
  assert.equal((await hello(again)).last('welcome')?.owner, true, 'opening again works (the session stayed valid)');
  // recovery
  o = again;
  const r = await call('POST', '/account/recover', { username: 'alice', recoveryCode: a.recoveryCode, password: 'derde-wachtwoord' });
  assert.equal(r.status, 200);
  assert.equal((await hello(o)).last('error')?.code, 'token');
  // players and settings were never touched
  assert.equal(core.rooms.get(room.code).state.prepared.name, 'Feest');
});

test('loginblokkade houdt een geldige sessie en een herstel met de juiste code niet tegen; herstel heeft een eigen teller', async () => {
  const { call, advance } = setup();
  const v = await signup(call, 'victim', '5.5.5.5');
  for (let i = 0; i < 10; i++) await call('POST', '/account/login', { username: 'VICTIM', password: `wrong-${i}` }, { ip: `6.6.6.${i}` });
  assert.equal((await call('POST', '/account/login', { username: 'victim', password: PW }, { ip: '5.5.5.5' })).body.code, 'locked');
  // a valid session: password change works
  const pc = await call('POST', '/account/password', { password: PW, newPassword: 'nieuw-wachtwoord1' }, { token: v.token });
  assert.equal(pc.status, 200, JSON.stringify(pc.body));
  // wrong current passwords with a session have their own limit
  for (let i = 0; i < 10; i++) await call('POST', '/account/password', { password: `fout-${i}xxx`, newPassword: 'x-wachtwoord1' }, { token: v.token, ip: `6.7.0.${i}` });
  assert.equal((await call('POST', '/account/password', { password: 'nieuw-wachtwoord1', newPassword: 'x-wachtwoord1' }, { token: v.token })).body.code, 'locked');
  // recovery with the right code works while the login is locked
  const rc = await call('POST', '/account/recover', { username: 'victim', recoveryCode: v.recoveryCode, password: 'brandnewpw1' }, { ip: '5.5.5.5' });
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  // wrong codes lock only recovery, not logging in
  for (let i = 0; i < RECOVER_FAILS.limit; i++) await call('POST', '/account/recover', { username: 'victim', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', password: 'whatever12' }, { ip: `6.8.0.${i}` });
  assert.equal((await call('POST', '/account/recover', { username: 'victim', recoveryCode: rc.body.recoveryCode, password: 'whatever12' }, { ip: '5.5.5.6' })).body.code, 'locked');
  assert.equal((await call('POST', '/account/login', { username: 'victim', password: 'brandnewpw1' }, { ip: '5.5.5.7' })).status, 200);
  // delete with a valid session while the login is locked
  for (let i = 0; i < 10; i++) await call('POST', '/account/login', { username: 'victim', password: `wrong-${i}` }, { ip: `6.9.0.${i}` });
  const dl = await call('POST', '/account/delete', { password: 'brandnewpw1' }, { token: rc.body.token });
  assert.equal(dl.status, 200);
  advance(1);
});

test('namen: geen onzichtbare tekens of tekst-omkering (kamernaam en spelersnaam)', async () => {
  const sneaky = 'Fe​est‮ za⁦terdag﻿‏';
  assert.equal(cleanRoomName(sneaky), 'Feest zaterdag');
  assert.equal(cleanName('‮Ilse‍'), 'Ilse');
  assert.equal(cleanName('​​', 'Speler'), 'Speler');
  const { call } = setup();
  const a = await signup(call, 'alice');
  const r = await call('POST', '/account/rooms', { name: sneaky, hostName: '‮Ilse' }, { token: a.token });
  assert.equal(r.body.room.name, 'Feest zaterdag');
  assert.equal(r.body.room.hostName, 'Ilse');
  assert.equal((await call('POST', '/account/rooms', { name: '​‮' }, { token: a.token })).status, 400);
});

test('lichamen: grootte gecontroleerd voor het lezen, diepe nesting geweigerd', async () => {
  assert.equal(tooDeep('{"a":"[[[[[[[[[[[[[[[[[[[[[[[["}', 16), false, 'brackets in a string do not count');
  assert.equal(tooDeep('['.repeat(17) + ']'.repeat(17), 16), true);
  const { call } = setup();
  const deep = await call('POST', '/account/login', null, { raw: `{"username":${'['.repeat(40)}${']'.repeat(40)}}` });
  assert.equal(deep.status, 400);
  const big = await call('POST', '/account/login', null, { raw: JSON.stringify({ username: 'ilse', password: 'x'.repeat(ACCOUNT_LIMITS.authBody) }) });
  assert.equal(big.status, 413);
  // the Node adapter answers on Content-Length alone, without waiting for the body
  const srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true, iterations: 1000 });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/account/login', headers: { 'content-length': String(10 * 1024 * 1024), origin: ORIGIN } }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.write('{'); // only one byte of the announced 10 MB
      setTimeout(() => reject(new Error('no answer before the body')), 3000);
    });
    assert.equal(status, 413);
  } finally { await srv.close(); }
});

test('app: het token gaat nooit naar een andere server dan die van de sessie', async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
  const seen = [];
  const other = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/health' ? JSON.stringify({ ok: true, v: V, features: ['screen', 'accounts'] }) : '{}');
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const account = await import('../../app/js/account.js');
  const { SERVER_OVERRIDE_KEY } = await import('../../app/js/multi/server-session.js');
  const otherUrl = `http://127.0.0.1:${other.address().port}`;
  storage.set(account.ACCOUNT_KEY, JSON.stringify({ username: 'ilse', token: `tta1.ilse.${'A'.repeat(43)}`, server: 'https://time-tunes.example', rev: 1, data: null, synced: [] }));
  storage.set(SERVER_OVERRIDE_KEY, JSON.stringify(otherUrl));
  assert.equal(account.current(), null, 'logged out for this server');
  for (const r of [await account.pull(), await account.myRooms(), await account.openRoom('ABCD'), await account.logOut()]) assert.equal(r.ok === true && r.revoked === true, false);
  assert.deepEqual(seen.filter((x) => x.auth), [], 'no token reached the other server');
  assert.ok(storage.has(account.ACCOUNT_KEY), 'the session for the first server stays');
  other.close();
});
