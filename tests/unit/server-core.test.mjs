// Room server core (server/core.mjs + server/room.mjs) without any network: fake sockets
// and a fake clock. Checks rooms, joining, tokens, what a player may see, the leader
// going away / being replaced, limits, origins, protocol version and expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub, ROOM_IDLE_MS, UNCLAIMED_MS, MAX_CONNS_PER_ROOM, RATE_MAX_MESSAGES } from '../../server/room.mjs';
import { originAllowed, parseOrigins, route } from '../../server/policy.mjs';
import { sha256Hex } from '../../server/sha256.mjs';
import {
  SERVER_PROTOCOL_VERSION, TAKEOVER_MS, STALE_MS, MAX_SMALL_MESSAGE, cleanCards, cardsForServer, serverBases, parseClientMessage,
} from '../../app/js/multi/server-protocol.js';
import { MAX_ROOM_PLAYERS } from '../../app/js/multi/game.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const cards = Array.from({ length: 40 }, (_, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year: 1961 + i, title: `Geheime titel ${i + 1}`, artist: `Geheime artiest ${i + 1}`,
  previewUrl: `https://example.invalid/geheim-${i + 1}.m4a`, itunesId: 1000 + i, trackViewUrl: 'https://x.invalid/no',
}));
const flush = () => new Promise((r) => setTimeout(r, 20));
const settle = () => new Promise((r) => setTimeout(r, 80)); // core.mjs closes a socket 50 ms after its last message

function setup(opts = {}) {
  let t = 1_000_000;
  const core = createRoomServer({ now: () => t, ...opts });
  return { core, advance: (ms) => { t += ms; }, now: () => t };
}

function http(core, method, path, body, { origin = ORIGIN, ip = '10.0.0.1' } = {}) {
  const r = core.http({ method, path, origin, ip, body: body == null ? '' : JSON.stringify(body) });
  return r;
}

function connect(core, code, { origin = ORIGIN, ip = '10.0.0.2' } = {}) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin, ip });
  if (!up.ok) return { refused: up };
  const msgs = [];
  const p = { msgs, closed: null };
  p.conn = up.attach({ send: (text) => msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)), close: (c, reason) => { p.closed = { c, reason }; } });
  p.send = (m) => p.conn.message(typeof m === 'string' ? m : JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  p.all = (t) => msgs.filter((m) => m.t === t);
  return p;
}

async function newRoom(core, { hostPlays = false, settings = { game: 'bingo', size: 3 } } = {}) {
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', hostPlays, settings });
  assert.equal(res.status, 201);
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  await flush();
  assert.equal(host.last('welcome')?.id, 'owner01');
  return { code, token, host };
}

async function join(core, code, id, name, token) {
  const p = connect(core, code);
  p.send({ t: 'hello', v: V, code, id, name, ...(token ? { token } : {}) });
  await flush();
  return p;
}

test('policy: routes, origins, adressen', () => {
  assert.deepEqual(route('GET', '/health'), { kind: 'health' });
  assert.deepEqual(route('POST', '/rooms'), { kind: 'create' });
  assert.deepEqual(route('GET', '/rooms/abcd'), { kind: 'info', code: 'ABCD' });
  assert.deepEqual(route('GET', '/rooms/ABCD/ws'), { kind: 'ws', code: 'ABCD' });
  assert.deepEqual(route('POST', '/rooms/ABCD/restore'), { kind: 'restore', code: 'ABCD' });
  assert.equal(route('GET', '/rooms/ABIO').kind, 'badcode');
  assert.equal(route('GET', '/index.html').kind, 'none');
  const o = parseOrigins('');
  assert.ok(originAllowed('https://jaccotlam.github.io', o));
  assert.ok(originAllowed('https://time-tunes.jaccotlam.workers.dev', o));
  assert.ok(originAllowed('http://localhost:8123', o));
  assert.ok(originAllowed('http://127.0.0.1:5000', o));
  assert.ok(originAllowed('', o), 'geen Origin (geen webpagina) mag');
  assert.ok(!originAllowed('https://evil.example', o));
  assert.ok(!originAllowed('http://localhost.evil.example', o));
  assert.ok(!originAllowed('https://jaccotlam.github.io.evil.example', o));
  assert.ok(originAllowed('https://a.b', parseOrigins('https://a.b, https://c.d')));
  assert.deepEqual(serverBases('https://time-tunes.jaccotlam.workers.dev/'), { http: 'https://time-tunes.jaccotlam.workers.dev', ws: 'wss://time-tunes.jaccotlam.workers.dev' });
  assert.deepEqual(serverBases('http://127.0.0.1:8787'), { http: 'http://127.0.0.1:8787', ws: 'ws://127.0.0.1:8787' });
  assert.equal(serverBases(''), null);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('kaarten: alleen nodige velden, ongeldige weg', () => {
  const c = cardsForServer(cards)[0];
  assert.ok(!('trackViewUrl' in c));
  const clean = cleanCards([...cards, { id: 'x', year: 'nope' }, { id: 'c001', year: 1990 }, { id: 'y', year: 1990, previewUrl: 'javascript:alert(1)' }, null]);
  assert.equal(clean.length, 41);
  assert.ok(!('previewUrl' in clean.at(-1)));
  assert.equal(parseClientMessage(JSON.stringify({ t: 'answer', x: 'y'.repeat(MAX_SMALL_MESSAGE) })), null, 'groot bericht alleen voor start');
  assert.ok(parseClientMessage(JSON.stringify({ t: 'start', cards: 'y'.repeat(MAX_SMALL_MESSAGE) })));
});

test('http: health, kamer maken, opvragen, origin en versie', () => {
  const { core } = setup();
  assert.equal(http(core, 'GET', '/health').body.ok, true);
  assert.equal(http(core, 'GET', '/health').body.v, V, 'health meldt de protocolversie');
  assert.equal(http(core, 'GET', '/health').headers['access-control-allow-origin'], ORIGIN);
  assert.equal(http(core, 'OPTIONS', '/rooms').status, 204);
  assert.equal(http(core, 'POST', '/rooms', { v: V, id: 'owner01' }, { origin: 'https://evil.example' }).status, 403);
  assert.equal(http(core, 'POST', '/rooms', { v: V + 1, id: 'owner01' }).status, 409, 'andere protocolversie');
  assert.equal(http(core, 'POST', '/rooms', { v: V, id: 'x' }).status, 400, 'ongeldig id');
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01' });
  assert.equal(res.status, 201);
  assert.match(res.body.code, /^[A-HJKMNP-Z]{4}$/);
  assert.match(res.body.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(http(core, 'GET', `/rooms/${res.body.code}`).body.exists, true);
  assert.equal(http(core, 'GET', `/rooms/${res.body.code.toLowerCase()}`).status, 200);
  const other = res.body.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  assert.equal(http(core, 'GET', `/rooms/${other}`).status, 404);
  assert.equal(core.upgrade({ path: `/rooms/${res.body.code}/ws`, origin: 'https://evil.example', ip: '1' }).status, 403, 'WebSocket van een vreemde site geweigerd');
});

test('meedoen, token: kapen mislukt, terugkomen lukt', async () => {
  const { core } = setup();
  const { code } = await newRoom(core);
  const a = await join(core, code, 'playerA1', 'Anouk');
  const w = a.last('welcome');
  assert.equal(w.id, 'playerA1');
  assert.match(w.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(a.last('state').view.you.name, 'Anouk');
  // somebody else claims Anouk's id without (or with a wrong) token
  const thief = await join(core, code, 'playerA1', 'Dief');
  assert.equal(thief.last('error').code, 'token');
  const thief2 = await join(core, code, 'playerA1', 'Dief', 'A'.repeat(32));
  assert.equal(thief2.last('error').code, 'token');
  await settle();
  assert.ok(thief.closed && thief2.closed, 'kaper wordt afgesloten');
  assert.equal(a.closed, null, 'Anouk blijft verbonden');
  // the owner's place can not be taken either
  const thief3 = await join(core, code, 'owner01', 'Dief');
  assert.equal(thief3.last('error').code, 'token');
  // Anouk comes back (reload) with her token: same place, no new token
  const a2 = await join(core, code, 'playerA1', 'Anouk', w.token);
  assert.equal(a2.last('welcome').token, undefined);
  assert.equal(a.last('error').code, 'replaced', 'oude verbinding wordt vervangen');
  assert.equal(a2.last('state').view.players.filter((p) => p.name.startsWith('Anouk')).length, 1);
  // wrong room code in hello / unknown room
  const x = connect(core, code);
  x.send({ t: 'hello', v: V, code: 'QQQQ', id: 'playerX1', name: 'X' });
  assert.equal(x.last('error').code, 'room');
  const y = connect(core, code === 'QQQQ' ? 'RRRR' : 'QQQQ');
  y.send({ t: 'hello', v: V, id: 'playerY1', name: 'Y' });
  assert.equal(y.last('error').code, 'notfound');
});

test('protocolversie: andere app krijgt nette melding, komt niet in de kamer', async () => {
  const { core } = setup();
  const { code, host } = await newRoom(core);
  const old = connect(core, code);
  old.send({ t: 'hello', v: V - 1, code, id: 'oldapp12', name: 'Oud' });
  assert.equal(old.last('error').code, 'version');
  assert.match(old.last('error').message, /Ververs/);
  await flush();
  assert.ok(!host.last('state').view.players.some((p) => p.name === 'Oud'));
});

/** Play: start a bingo game with two players. */
async function bingoRoom(core) {
  const r = await newRoom(core);
  const a = await join(core, r.code, 'playerA1', 'Anouk');
  const b = await join(core, r.code, 'playerB1', 'Bram');
  r.host.send({ t: 'start', cards: cardsForServer(cards), seed: 7 });
  await flush();
  return { ...r, a, b };
}

test('vóór de onthulling: spelers zien niets van het nummer, alleen de muziektelefoon krijgt het', async () => {
  const { core } = setup();
  const { host, a, b } = await bingoRoom(core);
  const hs = host.last('state');
  assert.equal(hs.view.phase, 'answering');
  const song = hs.lead.song;
  assert.ok(song && song.title && song.previewUrl, 'spelleider (muziek) krijgt het lopende nummer');
  assert.ok(!('trackViewUrl' in song));
  assert.equal(hs.lead.room.game.current, song.id);
  for (const p of [a, b]) {
    const text = JSON.stringify(p.msgs);
    for (const secret of [song.title, song.artist, song.previewUrl, `"${song.id}"`]) assert.ok(!text.includes(secret), `speler krijgt ${secret} niet`);
    assert.equal(p.last('state').lead, undefined, 'speler krijgt geen leidersgegevens');
    assert.equal(p.all('backup').length, 0, 'speler krijgt geen back-up');
  }
  // no songs from the pile in the leader's messages either: only the running one
  const leaderText = JSON.stringify(host.msgs.filter((m) => m.t !== 'backup'));
  const future = cards.filter((c) => c.id !== song.id && leaderText.includes(c.title));
  assert.equal(future.length, 0, 'geen toekomstige nummers naar de muziektelefoon');
  // answers and reveal
  const card = a.last('state').view.game.mine.card;
  a.send({ t: 'answer', round: 1, answer: { index: card.indexOf('artist'), text: song.artist } });
  b.send({ t: 'answer', round: 1, answer: { pass: true } });
  await flush();
  assert.equal(host.last('state').lead.spectator.players.filter((p) => p.answered).length, 2);
  // a player can not reveal
  a.send({ t: 'reveal' });
  assert.equal(a.last('error').code, 'notleader');
  host.send({ t: 'reveal' });
  await flush();
  const av = a.last('state').view;
  assert.equal(av.phase, 'revealed');
  assert.equal(av.game.reveal.song.title, song.title, 'na de onthulling wel');
  assert.equal(av.game.reveal.mine.correct, true);
  assert.ok(!JSON.stringify(a.msgs).includes(song.previewUrl), 'preview-URL nooit naar een speler');
  host.send({ t: 'next' });
  await flush();
  assert.equal(a.last('state').view.game.round, 2);
});

test('spelleider weg: spelers blijven, nieuwe speler kan meedoen, leiding overnemen na 30 s, eigenaar neemt terug', async () => {
  const { core, advance } = setup();
  const { code, token, host, a, b } = await bingoRoom(core);
  host.conn.closed();
  await flush();
  const meta = a.last('state').meta;
  assert.equal(meta.leaderOnline, false);
  assert.equal(meta.leaderId, 'owner01');
  assert.equal(a.closed, null);
  const c = await join(core, code, 'playerC1', 'Cas');
  assert.ok(c.last('welcome'), 'nieuwe speler doet mee terwijl de spelleider weg is');
  assert.ok(c.last('state').view.game.mine, 'en krijgt een kaart');
  a.send({ t: 'lead' });
  assert.equal(a.last('error').code, 'wait', 'nog niet: misschien komt hij terug');
  advance(TAKEOVER_MS + 1000);
  a.send({ t: 'lead' });
  await flush();
  const st = a.last('state');
  assert.equal(st.meta.leader, true, 'Anouk heeft de leiding');
  assert.ok(st.lead.song?.title, 'en de muziek speelt nu bij haar');
  assert.equal(b.last('state').meta.leaderName, 'Anouk');
  assert.equal(b.last('state').lead, undefined);
  // the owner comes back: sees who leads, may take it back
  const h2 = await join(core, code, 'owner01', '', token);
  const hs = h2.last('state');
  assert.equal(hs.meta.leader, false);
  assert.equal(hs.lead.song, null, 'eigenaar zonder leiding krijgt het nummer niet');
  assert.equal(hs.lead.room.game.current, null);
  b.send({ t: 'lead' });
  assert.equal(b.last('error').code, 'leaderonline', 'Anouk is er: niet overnemen');
  h2.send({ t: 'lead' });
  await flush();
  assert.equal(h2.last('state').meta.leader, true);
  assert.equal(a.last('state').meta.leader, false);
  assert.equal(a.last('state').lead, undefined, 'Anouk is weer gewone speler');
});

test('eigenaar krijgt een back-up; na een herstart zet hij de kamer terug en spelers komen terug met hun token', async () => {
  const s1 = setup();
  const { code, token, host, a } = await bingoRoom(s1.core);
  const snap = host.last('backup').snap;
  assert.ok(snap.room.game.songs, 'back-up met nummers');
  assert.ok(Object.values(snap.members).every((m) => /^[0-9a-f]{64}$/.test(m.th) && !m.token), 'tokens alleen als hash');
  assert.ok(!JSON.stringify(snap).includes(a.last('welcome').token), 'geen token van een speler in de back-up');
  const aToken = a.last('welcome').token;
  const aCard = a.last('state').view.game.mine.card.join();
  // "restart": a fresh server knows nothing
  const s2 = setup();
  const lost = connect(s2.core, code);
  lost.send({ t: 'hello', v: V, code, id: 'playerA1', token: aToken, name: 'Anouk' });
  assert.equal(lost.last('error').code, 'notfound');
  assert.equal(http(s2.core, 'POST', `/rooms/${code}/restore`, { v: V, id: 'owner01', token: 'B'.repeat(32), snap }).status, 400, 'zonder het juiste token geen herstel');
  assert.equal(http(s2.core, 'POST', `/rooms/${code}/restore`, { v: V, id: 'playerA1', token: aToken, snap }).status, 400, 'een speler kan niet herstellen');
  const res = http(s2.core, 'POST', `/rooms/${code}/restore`, { v: V, id: 'owner01', token, snap });
  assert.equal(res.status, 200);
  assert.equal(res.body.restored, true);
  assert.equal(http(s2.core, 'POST', `/rooms/${code}/restore`, { v: V, id: 'owner01', token, snap }).body.restored, false, 'twee keer is onschuldig');
  const a2 = await join(s2.core, code, 'playerA1', 'Anouk', aToken);
  assert.ok(a2.last('welcome'));
  assert.equal(a2.last('state').view.game.mine.card.join(), aCard, 'zelfde kaart na herstel');
  const thief = await join(s2.core, code, 'playerA1', 'Dief', 'C'.repeat(32));
  assert.equal(thief.last('error').code, 'token');
});

test('limieten: vol, te veel berichten, te veel verbindingen, te veel kamers', async () => {
  const { core } = setup();
  const { code } = await newRoom(core);
  const ps = [];
  for (let i = 0; i < MAX_ROOM_PLAYERS; i++) ps.push(await join(core, code, `player${String(i).padStart(3, '0')}`, `P${i}`));
  assert.ok(ps.every((p) => p.last('welcome')));
  const extra = await join(core, code, 'playerXXX', 'Te veel');
  assert.equal(extra.last('error').code, 'full');
  // flood
  const p = ps[0];
  for (let i = 0; i < RATE_MAX_MESSAGES + 5; i++) p.send({ t: 'withdraw' });
  assert.equal(p.last('error').code, 'ratelimit');
  await settle();
  assert.ok(p.closed);
  // pings are answered and do not count as messages
  const q = ps[1];
  q.send('ping');
  assert.equal(q.msgs.at(-1), 'pong');
  // too many connections to one room
  const hub = core.rooms.get(code);
  const opened = [];
  while (hub.conns.size < MAX_CONNS_PER_ROOM) opened.push(connect(core, code, { ip: `10.1.0.${opened.length}` }));
  const over = connect(core, code, { ip: '10.2.0.1' });
  assert.equal(over.last('error').code, 'busy');
  // too many rooms / creations per ip
  const small = setup({ limits: { maxRooms: 2 } });
  assert.equal(http(small.core, 'POST', '/rooms', { v: V, id: 'owner01' }).status, 201);
  assert.equal(http(small.core, 'POST', '/rooms', { v: V, id: 'owner02' }).status, 201);
  assert.equal(http(small.core, 'POST', '/rooms', { v: V, id: 'owner03' }).status, 503);
  const rl = setup();
  let last;
  for (let i = 0; i < 40; i++) last = http(rl.core, 'POST', '/rooms', { v: V, id: `owner${100 + i}` });
  assert.equal(last.status, 429, 'te veel kamers vanaf één adres');
  assert.equal(http(rl.core, 'POST', '/rooms', { v: V, id: 'owner999' }, { ip: '10.9.9.9' }).status, 201, 'ander adres mag wel');
});

test('verlopen: ongebruikte kamer na 30 min, inactieve kamer na 6 uur; dode verbindingen worden opgeruimd', async () => {
  const { core, advance } = setup();
  const unused = http(core, 'POST', '/rooms', { v: V, id: 'owner01' }).body.code;
  const { code, host } = await newRoom(core);
  const a = await join(core, code, 'playerA1', 'Anouk');
  advance(UNCLAIMED_MS + 1000);
  host.send('ping'); a.send('ping');
  core.sweep();
  assert.equal(http(core, 'GET', `/rooms/${unused}`).status, 404, 'ongebruikte kamer verlopen');
  assert.equal(http(core, 'GET', `/rooms/${code}`).status, 200, 'gebruikte kamer blijft');
  // Anouk's phone goes silent (locked), the host keeps pinging
  advance(STALE_MS + 1000);
  host.send('ping');
  core.sweep();
  await settle();
  assert.ok(a.closed, 'stille verbinding opgeruimd');
  assert.equal(host.last('state').lead.spectator.players.find((p) => p.name === 'Anouk').online, false);
  for (let t = 0; t < ROOM_IDLE_MS; t += STALE_MS - 1000) { advance(STALE_MS - 1000); host.send('ping'); core.sweep(); }
  advance(60000);
  core.sweep();
  assert.equal(host.last('error').code, 'expired');
  assert.equal(http(core, 'GET', `/rooms/${code}`).status, 404);
});

test('RoomHub: spelleider-acties alleen voor de leider; sluiten door eigenaar', async () => {
  const sent = [];
  const hub = new RoomHub('ABCD', { send: (id, text) => sent.push([id, text]), drop: () => {} });
  const { token } = hub.create({ ownerId: 'owner01', hostPlays: true, name: 'Ilse' });
  hub.open('h');
  hub.message('h', JSON.stringify({ t: 'hello', v: V, code: 'ABCD', id: 'owner01', token }));
  hub.open('a');
  hub.message('a', JSON.stringify({ t: 'hello', v: V, code: 'ABCD', id: 'playerA1', name: 'Anouk' }));
  hub.message('a', JSON.stringify({ t: 'settings', patch: { game: 'timeline' } }));
  assert.equal(JSON.parse(sent.at(-1)[1]).code, 'notleader');
  hub.message('a', JSON.stringify({ t: 'close' }));
  assert.ok(hub.exists(), 'speler kan de kamer niet sluiten');
  hub.message('h', JSON.stringify({ t: 'remove', pid: 'owner01' }));
  assert.equal(JSON.parse(sent.at(-1)[1]).code, 'host');
  hub.message('h', JSON.stringify({ t: 'close' }));
  assert.ok(!hub.exists());
  assert.ok(sent.some(([id, text]) => id === 'a' && JSON.parse(text).code === 'closed'));
});
