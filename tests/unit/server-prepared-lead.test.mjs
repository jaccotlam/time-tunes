// Who may lead a prepared room (server/room.mjs leadLocked, prepared.mjs): in the lobby only
// the account's device (no take-over offer, `lead` refused, meta says the room waits for its
// owner); during a running game the take-over works as in any room; a normal room unchanged.
// And a recovery lifts the login lock at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { LOGIN_FAILS } from '../../server/accounts.mjs';
import { SERVER_PROTOCOL_VERSION, TAKEOVER_MS } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const PW = 'geheim-wachtwoord-1';
const flush = () => new Promise((r) => setTimeout(r, 80));
const cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, year: 1970 + i, title: `T${i}`, artist: `A${i}` }));

function setup() {
  let t = 1_800_000_000_000;
  const core = createRoomServer({ now: () => t, iterations: 1000 });
  const call = (method, path, body, { token, ip = '10.0.0.1' } = {}) => core.http({ method, path, origin: ORIGIN, ip, auth: token ? `Bearer ${token}` : '', body: body == null ? '' : JSON.stringify(body) });
  return { core, call, advance: (ms) => { t += ms; } };
}
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.9' });
  const msgs = [];
  const p = { msgs };
  p.conn = up.attach({ send: (text) => msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)), close: () => {} });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  return p;
}
async function preparedRoom() {
  const S = setup();
  const a = (await S.call('POST', '/account/signup', { username: 'ilse', password: PW })).body;
  const room = (await S.call('POST', '/account/rooms', { name: 'Feest zaterdag', settings: { game: 'bingo', size: 3 }, hostPlays: false }, { token: a.token })).body.room;
  return { ...S, token: a.token, code: room.code };
}
async function guest(core, code, id = 'gast0001') {
  const g = connect(core, code);
  g.send({ t: 'hello', v: V, code, id, name: 'Gast' });
  await flush();
  return g;
}

test('klaargezette kamer, nog niet geopend: gasten wachten in de lobby, niemand kan de leiding nemen', async () => {
  const { core, code, advance } = await preparedRoom();
  const g = await guest(core, code);
  assert.equal(g.last('welcome')?.id, 'gast0001', 'a guest can join and wait');
  const scr = connect(core, code);
  scr.send({ t: 'hello', v: V, code, screen: true });
  await flush();
  assert.equal(scr.last('welcome')?.screen, true, 'a display can watch the waiting lobby');
  const m = g.last('state').meta;
  assert.equal(m.prepared, true);
  assert.equal(m.waitingForOwner, true);
  assert.equal(m.takeover, false);
  assert.equal(m.takeoverMs, null);
  assert.equal(scr.last('state').meta.waitingForOwner, true);
  advance(TAKEOVER_MS * 10);
  g.send({ t: 'lead' });
  await flush();
  assert.equal(g.last('error')?.code, 'lead');
  assert.match(g.last('error').message, /klaargezet/);
  assert.equal(core.rooms.get(code).state.leaderId === 'gast0001', false);
});

test('klaargezette kamer: eigenaar opent (normaal), en ook als hij in de lobby weggaat geen overname', async () => {
  const { core, call, code, token, advance } = await preparedRoom();
  const g = await guest(core, code);
  const o = (await call('POST', `/account/rooms/${code}/open`, null, { token })).body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: o.id, token: o.token });
  await flush();
  let m = g.last('state').meta;
  assert.equal(m.waitingForOwner, false);
  assert.equal(m.leaderOnline, true);
  assert.equal(host.last('state').meta.leader, true);
  // the owner's device goes away in the lobby
  host.conn.closed();
  await flush();
  m = g.last('state').meta;
  assert.equal(m.waitingForOwner, true);
  assert.equal(m.takeover, false);
  advance(TAKEOVER_MS + 5000);
  g.send({ t: 'lead' });
  await flush();
  assert.equal(g.last('error')?.code, 'lead');
});

test('klaargezette kamer met een lopend spel: overnemen zoals altijd, de eigenaar pakt de leiding terug', async () => {
  const { core, call, code, token, advance } = await preparedRoom();
  const g = await guest(core, code);
  const o = (await call('POST', `/account/rooms/${code}/open`, null, { token })).body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: o.id, token: o.token });
  await flush();
  host.send({ t: 'start', cards });
  await flush();
  assert.equal(core.rooms.get(code).state.room.phase, 'answering');
  host.conn.closed(); // the host's phone dies mid-game
  await flush();
  const m = g.last('state').meta;
  assert.equal(m.takeover, true);
  assert.equal(m.takeoverMs, TAKEOVER_MS);
  assert.equal(m.waitingForOwner, false);
  advance(TAKEOVER_MS + 1000);
  g.send({ t: 'lead' });
  await flush();
  assert.equal(g.last('state').meta.leader, true, 'the guest took over');
  const back = connect(core, code);
  back.send({ t: 'hello', v: V, code, id: o.id, token: o.token });
  await flush();
  back.send({ t: 'lead' });
  await flush();
  assert.equal(back.last('state').meta.leader, true, 'the owner takes it back');
});

test('gewone kamer (zonder account): overnemen in de lobby zoals altijd', async () => {
  const { core, advance } = setup();
  const res = core.http({ method: 'POST', path: '/rooms', origin: ORIGIN, ip: '10.0.0.1', body: JSON.stringify({ v: V, id: 'owner01', name: 'Ilse' }) });
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const g = await guest(core, code);
  host.conn.closed();
  await flush();
  const m = g.last('state').meta;
  assert.equal(m.prepared, false);
  assert.equal(m.waitingForOwner, false);
  assert.equal(m.takeover, true);
  assert.equal(m.takeoverMs, TAKEOVER_MS);
  assert.equal(m.roomName, undefined);
  advance(TAKEOVER_MS + 1000);
  g.send({ t: 'lead' });
  await flush();
  assert.equal(g.last('state').meta.leader, true);
});

test('herstel met de code heft de loginblokkade meteen op', async () => {
  const { call } = setup();
  const a = (await call('POST', '/account/signup', { username: 'ilse', password: PW })).body;
  for (let i = 0; i < LOGIN_FAILS.limit; i++) await call('POST', '/account/login', { username: 'ilse', password: `fout-${i}xx` }, { ip: `10.4.0.${i}` });
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: PW }, { ip: '10.5.0.1' })).body.code, 'locked');
  const r = await call('POST', '/account/recover', { username: 'ilse', recoveryCode: a.recoveryCode, password: 'nieuw-wachtwoord' }, { ip: '10.5.0.2' });
  assert.equal(r.status, 200);
  const l = await call('POST', '/account/login', { username: 'ilse', password: 'nieuw-wachtwoord' }, { ip: '10.5.0.3' });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  // and the count starts at zero: one wrong try does not lock again
  await call('POST', '/account/login', { username: 'ilse', password: 'weer-fout1' }, { ip: '10.5.0.4' });
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: 'nieuw-wachtwoord' }, { ip: '10.5.0.5' })).status, 200);
});
