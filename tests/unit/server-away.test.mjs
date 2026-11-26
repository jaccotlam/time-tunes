// Players who are away, after an independent review: the fair start of a late joiner looks at
// who is online, "x van y" counts only who is there, a full room gives up the seat of somebody
// away long enough (or who left on purpose), an away player's doubt waits for exactly one tap
// of the spelleider, and POST /rooms/CODE/seat tells a phone (and only a phone with the
// token) whether it still has its seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { AWAY_SEAT_MS } from '../../server/room.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer } from '../../app/js/multi/server-protocol.js';
import * as G from '../../app/js/multi/game.js';
import { viewFor } from '../../app/js/multi/protocol.js';
import { stampedCount } from '../../app/js/multi/disco.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
const settle = () => new Promise((r) => setTimeout(r, 80));
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 36).map((year, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, year, title: `Titel ${i + 1}`, artist: `Artiest ${i + 1}` }));

function setup() {
  let t = 4_000_000;
  const core = createRoomServer({ now: () => t });
  return { core, advance: (ms) => { t += ms; } };
}
const http = (core, method, path, body) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', body: body == null ? '' : JSON.stringify(body) });
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const p = { msgs: [], closed: null };
  p.conn = up.attach({ send: (text) => { if (text !== 'pong') p.msgs.push(JSON.parse(text)); }, close: (c) => { p.closed = c; } });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...p.msgs].reverse().find((m) => m.t === t) || null;
  p.view = () => p.last('state')?.view || null;
  return p;
}
async function hello(core, code, id, name, token) {
  const p = connect(core, code);
  p.send({ t: 'hello', v: V, code, id, name, ...(token ? { token } : {}) });
  await flush();
  return p;
}
async function room(core, settings, ids = ['playerA1', 'playerB1', 'playerC1']) {
  const { code, token } = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings }).body;
  const host = await hello(core, code, 'owner01', 'Ilse', token);
  const players = {};
  for (const id of ids) players[id] = await hello(core, code, id, id.slice(0, -1));
  return { code, token, host, players, hub: core.rooms.get(code) };
}

// ---------- 1. the fair start of a late joiner ----------
test('laat instappen: "het verst achter" telt alleen wie online is (alle drie de spellen); niemand online = iedereen', () => {
  for (const kind of ['disco', 'bingo', 'timeline']) {
    let r = G.createRoom({ code: 'TEST', settings: { game: kind, size: 3, goal: 10 } });
    for (const id of ['pA', 'pB', 'pC']) r = G.addPlayer(r, { id, name: id });
    r = G.startGame(r, { cards, seed: 5, now: 1 });
    const g = r.game;
    // B and C made progress, A (away) has nothing
    const per = { ...g.per };
    for (const id of ['pB', 'pC']) {
      if (kind === 'timeline') per[id] = { timeline: [...per[id].timeline, ...g.pile.slice(0, 3)] };
      else {
        const marks = per[id].marks.slice();
        let n = 0;
        for (let i = 0; i < marks.length && n < 3; i++) if (marks[i] == null && i !== 0 && i !== 6) { marks[i] = 'c001'; n++; }
        per[id] = { ...per[id], marks };
      }
    }
    r = { ...r, game: { ...g, per, pile: kind === 'timeline' ? g.pile.slice(3) : g.pile } };
    const score = (room, id) => (kind === 'timeline' ? room.game.per[id].timeline.length : kind === 'disco' ? stampedCount(room.game.per[id].marks) : room.game.per[id].marks.filter((m) => m != null).length);
    const withOnline = G.addPlayer(r, { id: 'pL', name: 'Laat' }, { online: { pB: true, pC: true } });
    const minHere = Math.min(score(r, 'pB'), score(r, 'pC'));
    assert.equal(score(withOnline, 'pL'), kind === 'timeline' ? Math.min(minHere, 8) : minHere, `${kind}: zo ver als wie er is`);
    const nobody = G.addPlayer(r, { id: 'pL', name: 'Laat' }, { online: {} });
    const old = G.addPlayer(r, { id: 'pL', name: 'Laat' });
    assert.deepEqual(nobody.game.per.pL, old.game.per.pL, `${kind}: niemand online = zoals vroeger (iedereen telt)`);
    assert.equal(score(old, 'pL'), kind === 'timeline' ? 1 : 0, `${kind}: met de afwezige meegerekend: niets`);
  }
});

test('laat instappen op de server: een vertrokken speler met 0 stempels houdt de nieuwkomer niet op 0', async () => {
  const { core } = setup();
  const { code, host, players, hub } = await room(core, { game: 'disco' });
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 11 });
  await flush();
  const g = () => hub.state.room.game;
  for (const id of ['playerB1', 'playerC1']) for (let i = 0; i < 8; i++) if (g().per[id].marks[i] == null) g().per[id].marks[i] = 'c001';
  players.playerA1.send({ t: 'leave' });
  await settle();
  await hello(core, code, 'late0001', 'Laat');
  assert.equal(stampedCount(g().per.late0001.marks), Math.min(stampedCount(g().per.playerB1.marks), stampedCount(g().per.playerC1.marks)));
  assert.ok(stampedCount(g().per.late0001.marks) > 0);
});

// ---------- 3. "x van y" ----------
test('Quiz: "x van y" telt alleen wie er is; de teller haalt "iedereen" ook als iemand weg is', async () => {
  const { core } = setup();
  const { host, players, hub } = await room(core, { game: 'quiz', questions: 5, think: 20 });
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 3 });
  await flush();
  host.send({ t: 'playing', round: 1 });
  await flush();
  players.playerC1.conn.closed(); // away (closed tab)
  players.playerA1.send({ t: 'answer', round: 1, answer: { choice: 0 } });
  await flush();
  const q = host.last('state').lead.spectator.game.quiz;
  assert.equal(q.playing, 2, 'Cas is weg');
  assert.equal(q.answered, 1);
  assert.equal(players.playerA1.view().game.quiz.playing, 2);
  const sp = host.last('state').lead.spectator.players.filter((p) => p.playing && p.online);
  assert.equal(sp.length, q.playing, 'de spelerslijst en de teller zijn het eens');
  players.playerB1.send({ t: 'answer', round: 1, answer: { choice: 1 } });
  await flush();
  assert.equal(hub.state.room.phase, 'revealed', 'iedereen die er is heeft geantwoord');
  // pure: the player's own count includes themself; an empty presence = only the viewer
  const v = viewFor(hub.state.room, 'playerA1', {});
  assert.equal(v.game.quiz.playing, 1);
});

// ---------- 4. a full room and away seats ----------
test('volle kamer: de plek van wie het langst weg is (bewust vertrokken of > 2 min offline) gaat naar de nieuwkomer', async () => {
  const { core, advance } = setup();
  const ids = Array.from({ length: G.MAX_ROOM_PLAYERS }, (_, i) => `player${String(i).padStart(2, '0')}x`);
  const { code, host, players, hub } = await room(core, { game: 'disco' }, ids);
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 1 });
  await flush();
  const tokens = Object.fromEntries(ids.map((id) => [id, players[id].last('welcome').token]));
  assert.equal(hub.state.room.players.length, 12);
  // full, nobody away: refused as before
  assert.equal((await hello(core, code, 'newbie01', 'Nieuw')).last('error').code, 'full');
  // a closed tab, only just: not given up
  players.player00x.conn.closed();
  advance(30000);
  host.send({ t: 'settings', patch: {} });
  assert.equal((await hello(core, code, 'newbie01', 'Nieuw')).last('error').code, 'full', 'net weg: plek blijft');
  // two left on purpose: the one who left first loses the seat
  players.player05x.send({ t: 'leave' });
  advance(1000);
  players.player07x.send({ t: 'leave' });
  await settle();
  const n1 = await hello(core, code, 'newbie01', 'Nieuw');
  assert.ok(n1.last('welcome'), 'binnen');
  assert.ok(!hub.state.room.players.some((p) => p.id === 'player05x'), 'de eerst vertrokken plek is weg');
  assert.ok(hub.state.room.players.some((p) => p.id === 'player07x'));
  assert.ok(hub.state.room.players.some((p) => p.id === 'player00x'), 'wie net offline is blijft');
  assert.equal(hub.state.room.players.length, 12);
  // the closed tab after more than 2 minutes: it is now the longest away
  advance(AWAY_SEAT_MS);
  const n2 = await hello(core, code, 'newbie02', 'Nieuw2');
  assert.ok(n2.last('welcome'));
  assert.ok(!hub.state.room.players.some((p) => p.id === 'player00x'));
  // never somebody online, never the owner: the room is full of online players now (but 07 left)
  const n3 = await hello(core, code, 'newbie03', 'Nieuw3');
  assert.ok(n3.last('welcome'), '07 was vertrokken');
  assert.equal((await hello(core, code, 'newbie04', 'Nieuw4')).last('error').code, 'full', 'alleen nog online spelers: vol');
  // who lost the seat comes back with the old token: an unknown seat, so a fresh join if there is room
  assert.equal((await hello(core, code, 'player05x', 'Terug', tokens.player05x)).last('error').code, 'full');
  players.player09x.send({ t: 'leave' });
  await settle();
  const r5 = await hello(core, code, 'player05x', 'Terug', tokens.player05x);
  assert.ok(r5.last('welcome').token, 'een nieuwe plek met een nieuw token');
  assert.equal(r5.view().game.mine.card.length, 25);
  assert.equal(hub.state.room.players.length, 12);
});

test('volle kamer: de spelleider die meespeelt en een afwezige spelleider worden nooit opgegeven', async () => {
  const { core, advance } = setup();
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', hostPlays: true, settings: { game: 'disco' } }).body;
  const host = await hello(core, res.code, 'owner01', 'Ilse', res.token);
  const hub = core.rooms.get(res.code);
  for (let i = 0; i < 11; i++) await hello(core, res.code, `player${String(i).padStart(2, '0')}y`, `P${i}`);
  assert.equal(hub.state.room.players.length, 12);
  host.conn.closed();
  advance(AWAY_SEAT_MS + 1000);
  assert.equal((await hello(core, res.code, 'newbie01', 'Nieuw')).last('error').code, 'full');
  assert.ok(hub.state.room.players.some((p) => p.id === 'owner01'));
});

// ---------- 5. a doubt of an away player ----------
test('twijfel van een afwezige: spelleider ziet hem, één tik Goed/Fout, daarna werkt "volgende"; verder wacht niets', async () => {
  const { core } = setup();
  const { host, players, hub } = await room(core, { game: 'disco' });
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 11 });
  await flush();
  host.send({ t: 'reveal' });
  await flush();
  // Bram's answer is a doubt (forced: the judging itself is tested elsewhere), then he leaves
  const g = hub.state.room.game;
  hub.state.room = { ...hub.state.room, game: { ...g, results: { ...g.results, playerB1: { cat: g.disco.cat, text: 'iets', typed: true, auto: 'doubt', verdict: 'doubt', correct: false, doubt: true, decided: false, overridden: false } } } };
  players.playerB1.send({ t: 'leave' });
  await settle();
  const st = host.last('state');
  assert.deepEqual(st.lead.spectator.game.disco.doubts, ['playerB1'], 'de regie toont de twijfel');
  assert.equal(st.lead.room.game.results.playerB1.doubt, true);
  assert.equal(st.lead.spectator.players.find((p) => p.id === 'playerB1').online, false);
  host.send({ t: 'next' });
  await flush();
  assert.equal(host.last('error').code, 'doubt', 'de spelleider houdt de regie');
  host.send({ t: 'judge', pid: 'playerB1', ok: false });
  await flush();
  assert.deepEqual(host.last('state').lead.spectator.game.disco.doubts, []);
  const errs = host.msgs.filter((m) => m.t === 'error').length;
  host.send({ t: 'next' });
  await flush();
  assert.equal(host.msgs.filter((m) => m.t === 'error').length, errs, 'geen fout meer');
  assert.equal(hub.state.room.phase, 'answering');
  assert.equal(hub.state.room.game.round, 2);
});

// ---------- 6. POST /rooms/CODE/seat ----------
test('POST /rooms/CODE/seat: ja alleen met het juiste token; een nieuwe kamer met dezelfde code zegt nee', async () => {
  const { core } = setup();
  const { code, players } = await room(core, { game: 'disco' });
  const token = players.playerA1.last('welcome').token;
  const ask = (c, body) => http(core, 'POST', `/rooms/${c}/seat`, body);
  assert.deepEqual(ask(code, { id: 'playerA1', token }).body, { seat: true });
  assert.equal(ask(code, { id: 'playerA1', token }).status, 200);
  assert.deepEqual(ask(code, { id: 'playerA1', token: 'x'.repeat(32) }).body, { seat: false }, 'fout token');
  assert.deepEqual(ask(code, { id: 'playerA1' }).body, { seat: false });
  assert.deepEqual(ask(code, { id: '__proto__', token }).body, { seat: false });
  assert.deepEqual(ask(code, null).body, { seat: false });
  assert.deepEqual(ask('BCDF', { id: 'playerA1', token }).body, { seat: false }, 'onbekende kamer: ook gewoon nee');
  assert.equal(ask('BCDF', { id: 'playerA1', token }).status, 200);
  // a closed room whose code comes back for a new room: the old token has no seat there
  const hub = core.rooms.get(code);
  hub.shutdown('closed', 'dicht');
  core.rooms.delete(code);
  core.rooms.set(code, core.rooms.get(code) || (await (async () => { const h = new (hub.constructor)(code, {}); h.create({ ownerId: 'strange1', name: 'Vreemd' }); return h; })()));
  assert.deepEqual(ask(code, { id: 'playerA1', token }).body, { seat: false });
  // leaving during a game keeps the seat: still yes
  const { code: c2, host: h2, players: p2 } = await room(core, { game: 'disco' });
  h2.send({ t: 'start', cards: cardsForServer(cards), seed: 2 });
  await flush();
  const t2 = p2.playerB1.last('welcome').token;
  p2.playerB1.send({ t: 'leave' });
  await settle();
  assert.deepEqual(ask(c2, { id: 'playerB1', token: t2 }).body, { seat: true });
});
