// The party extras on the room server (server/core.mjs + room.mjs), with fake sockets and a
// fake clock: avatars (hello, the avatar message, validation), the joker flag on stamp,
// reactions (who may send when, the limits, only to the displays and the leader, never stored
// or replayed, no state broadcast), the no-peeking guarantee for answer times, verdicts,
// streaks and statistics of the running round (every message to everybody but the leader),
// the 'party' feature flag and Discobingo rooms stored by the previous version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub, migrateState } from '../../server/room.mjs';
import { SERVER_PROTOCOL_VERSION, SERVER_FEATURES, cardsForServer, parseClientMessage, parseServerMessage, LEADER_TYPES } from '../../app/js/multi/server-protocol.js';
import { AVATARS, REACTIONS, avatarFor, REACT_GAP_MS, REACT_ROOM_MAX, REACT_ROOM_WINDOW_MS } from '../../app/js/multi/party.js';
import * as G from '../../app/js/multi/game.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 40).map((year, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year, title: `Verborgen titel ${i + 1}`, artist: `Verborgen artiest ${i + 1}`,
  previewUrl: `https://example.invalid/geheim-${i + 1}.m4a`,
}));
const PLAYERS = [['playerA1', 'Anouk', '🦄'], ['playerB1', 'Bram', 'geen'], ['playerC1', 'Cas', null]];

function setup() {
  let t = 5_000_000;
  const core = createRoomServer({ now: () => t });
  return { core, advance: (ms) => { t += ms; }, now: () => t };
}
const http = (core, method, path, body) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', body: body == null ? '' : JSON.stringify(body) });
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const p = { msgs: [], raw: [], closed: null };
  p.conn = up.attach({ send: (text) => { p.raw.push(text); p.msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)); }, close: (c) => { p.closed = c; } });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...p.msgs].reverse().find((m) => m.t === t) || null;
  p.all = (t) => p.msgs.filter((m) => m.t === t);
  p.view = () => p.last('state')?.view || null;
  return p;
}
async function partyRoom(core, { settings = {}, start = true, extra = [] } = {}) {
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings: { game: 'disco', ...settings } });
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const scr = connect(core, code);
  scr.send({ t: 'hello', v: V, code, screen: true });
  const players = [];
  for (const [id, name, avatar] of [...PLAYERS, ...extra]) {
    const p = connect(core, code);
    p.send({ t: 'hello', v: V, code, id, name, ...(avatar ? { avatar } : {}) });
    p.id = id;
    players.push(p);
  }
  await flush();
  if (start) { host.send({ t: 'start', cards: cardsForServer(cards), seed: 7 }); await flush(); }
  return { code, token, host, scr, players };
}
const song = (host) => host.last('state').lead.song;
function answerFor(view, s, right) {
  const d = view.game.disco;
  if (d.cat === 'decade') return { decade: right ? Math.floor(s.year / 10) * 10 : d.decades.find((x) => x.decade !== Math.floor(s.year / 10) * 10).decade };
  if (d.cat === 'year') return { guess: right ? s.year : s.year + 7 };
  return { text: right ? (d.cat === 'artist' ? s.artist : s.title) : 'Iets heel anders' };
}

test('avatar: bij hallo gekozen of afgeleid, wijzigen alleen in de lobby, overal te zien; de feature heet party', async () => {
  assert.ok(SERVER_FEATURES.includes('party') && SERVER_FEATURES.includes('screen'));
  const { core } = setup();
  assert.ok(http(core, 'GET', '/health').body.features.includes('party'));
  const { code, host, scr, players: [a, b, c] } = await partyRoom(core, { start: false });
  const byId = (v) => Object.fromEntries(v.players.map((p) => [p.id, p.avatar]));
  assert.deepEqual(byId(scr.view()), { playerA1: '🦄', playerB1: avatarFor('playerB1'), playerC1: avatarFor('playerC1') });
  assert.equal(a.view().you.avatar, '🦄');
  assert.equal(host.last('state').lead.room.players[0].avatar, '🦄');
  b.send({ t: 'avatar', avatar: '🐸' });
  c.send({ t: 'avatar', avatar: '<img>' });
  host.send({ t: 'avatar', avatar: '🐸' }); // the leader has no seat (not playing along)
  await flush();
  assert.equal(byId(scr.view()).playerB1, '🐸');
  assert.equal(c.last('error').code, 'avatar');
  assert.equal(c.closed, null, 'een weigering, geen verbreking');
  assert.equal(host.last('error').code, 'avatar');
  // a hello in the lobby on a known seat brings the phone's avatar along
  const a2 = connect(core, code);
  a2.send({ t: 'hello', v: V, code, id: 'playerA1', token: a.last('welcome').token, name: 'Anouk', avatar: '🐼' });
  await flush();
  assert.equal(byId(scr.view()).playerA1, '🐼');
  assert.ok(parseClientMessage(JSON.stringify({ t: 'avatar', avatar: '🐼' })));
  assert.ok(parseClientMessage(JSON.stringify({ t: 'react', emoji: '👏' })));
  assert.ok(!LEADER_TYPES.includes('avatar') && !LEADER_TYPES.includes('react'));
  // during a game: the avatar stays as it was
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 7 });
  await flush();
  b.send({ t: 'avatar', avatar: '🐙' });
  await flush();
  assert.match(b.last('error').message, /lobby/);
  const a3 = connect(core, code);
  a3.send({ t: 'hello', v: V, code, id: 'playerA1', token: a.last('welcome').token, name: 'Anouk', avatar: '🦊' });
  await flush();
  assert.equal(byId(scr.view()).playerA1, '🐼');
  assert.ok(scr.view().game.disco.progress.every((p) => AVATARS.includes(p.avatar)));
  // a late joiner with an avatar
  const late = connect(core, code);
  late.send({ t: 'hello', v: V, code, id: 'playerLate', name: 'Laat', avatar: '🐢' });
  await flush();
  assert.equal(byId(scr.view()).playerLate, '🐢');
});

test('joker via de server: stamp met joker-vlag, gecontroleerd; het aantal openbaar, "verdiend" alleen voor jezelf', async () => {
  const { core, advance } = setup();
  const { host, scr, players: [a, b] } = await partyRoom(core, { settings: { win: 'full' } });
  for (let round = 1; round <= 3; round++) {
    const v = a.view();
    a.send({ t: 'answer', round, answer: answerFor(v, song(host), true) });
    b.send({ t: 'answer', round, answer: answerFor(v, song(host), false) });
    advance(1000);
    host.send({ t: 'reveal' });
    await flush();
    if (round < 3) { host.send({ t: 'next' }); await flush(); }
  }
  const av = a.view();
  assert.equal(av.game.mine.streak, 3);
  assert.equal(av.game.mine.jokers, 1);
  assert.equal(av.game.mine.jokerEarned, true);
  assert.equal(scr.view().game.disco.progress.find((p) => p.id === 'playerA1').jokers, 1);
  assert.equal(scr.view().game.disco.progress.find((p) => p.id === 'playerA1').streak, 3);
  assert.equal(scr.view().game.mine, null);
  assert.deepEqual(scr.view().game.disco.jokerSquares, [], 'de tv heeft geen eigen kaart');
  const js = av.game.disco.jokerSquares;
  assert.ok(js.length > 0);
  a.send({ t: 'stamp', round: 3, index: js[0], joker: 'ja' });
  await flush();
  assert.equal(a.last('error').code, 'answer');
  a.send({ t: 'stamp', round: 3, index: js[0] });
  await flush();
  assert.equal(a.last('error').code, 'answer', 'zonder vlag: alleen de eigen kleur');
  b.send({ t: 'stamp', round: 3, index: js[0], joker: true });
  await flush();
  assert.equal(b.last('error').code, 'answer', 'fout antwoord: geen joker');
  a.send({ t: 'stamp', round: 3, index: js[0], joker: true });
  await flush();
  assert.equal(a.view().game.mine.jokers, 0);
  assert.equal(a.view().game.mine.jokerSpent, true);
  const res = scr.view().game.reveal.results.find((x) => x.id === 'playerA1');
  assert.equal(res.stamped, js[0]);
  assert.equal(res.jokerSpent, true);
  assert.equal(scr.view().game.disco.fastest.id, 'playerA1');
  // flipped to wrong by the host: the joker comes back (and the round's streak goes)
  host.send({ t: 'judge', pid: 'playerA1', ok: false });
  await flush();
  assert.equal(a.view().game.mine.jokers, 0, 'fout: ook de joker van deze reeks is weg');
  assert.equal(a.view().game.mine.streak, 0);
  host.send({ t: 'judge', pid: 'playerA1', ok: true });
  await flush();
  assert.equal(a.view().game.mine.jokers, 1);
  assert.equal(a.view().game.disco.choice, null);
});

test('reacties: van wie en wanneer; alleen naar de schermen en de spelleider; met naam en plaatje', async () => {
  const { core, advance } = setup();
  const { code, host, scr, players: [a, b, c] } = await partyRoom(core, { start: false });
  const scr2 = connect(core, code);
  scr2.send({ t: 'hello', v: V, code, screen: true });
  await flush();
  const count = () => [host, scr, scr2, a, b, c].map((p) => p.all('react').length);
  a.send({ t: 'react', emoji: '👏' }); // lobby: yes
  await flush();
  assert.deepEqual(count(), [1, 1, 1, 0, 0, 0], 'schermen en spelleider, niet de spelers (ook niet de afzender)');
  const m = scr.last('react');
  assert.deepEqual({ ...m, at: 0 }, { t: 'react', id: 'playerA1', name: 'Anouk', avatar: '🦄', emoji: '👏', at: 0 });
  assert.ok(parseServerMessage(JSON.stringify(m)), 'een bekend berichttype voor de app');
  advance(REACT_GAP_MS);
  for (const bad of ['💩', '', null, 5, '👏👏', { e: 1 }]) b.send({ t: 'react', emoji: bad });
  host.send({ t: 'react', emoji: '👏' }); // the leader has no seat
  scr.send({ t: 'react', emoji: '👏' }); // a display only watches
  await flush();
  assert.deepEqual(count(), [1, 1, 1, 0, 0, 0], 'ongeldig of zonder plek: stil genegeerd');
  assert.equal(scr.last('error').code, 'screen');
  assert.equal(b.last('error'), null, 'een geweigerde reactie geeft geen foutmelding');
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 7 });
  await flush();
  advance(REACT_GAP_MS);
  b.send({ t: 'react', emoji: '🔥' }); // answering, not answered yet: no
  await flush();
  assert.deepEqual(count(), [1, 1, 1, 0, 0, 0], 'tijdens de vraag pas na het antwoorden');
  b.send({ t: 'answer', round: 1, answer: answerFor(b.view(), song(host), false) });
  b.send({ t: 'react', emoji: '🔥' });
  await flush();
  assert.deepEqual(count(), [2, 2, 2, 0, 0, 0]);
  b.send({ t: 'withdraw' });
  advance(REACT_GAP_MS);
  b.send({ t: 'react', emoji: '🔥' });
  await flush();
  assert.deepEqual(count(), [2, 2, 2, 0, 0, 0], 'antwoord ingetrokken: weer niet');
  host.send({ t: 'reveal' });
  await flush();
  c.send({ t: 'react', emoji: '😂' }); // revealed, also without an answer
  await flush();
  assert.deepEqual(count(), [3, 3, 3, 0, 0, 0]);
  // the leader is the one who gets them: after a take-over the new leader, not the owner
  host.conn.closed();
  advance(31000);
  a.send({ t: 'lead' });
  await flush();
  advance(REACT_GAP_MS);
  c.send({ t: 'react', emoji: '🙌' });
  await flush();
  assert.equal(a.all('react').length, 1, 'de nieuwe spelleider');
  assert.equal(scr.all('react').length, 4);
});

test('reacties: per speler 1 per 1,5 s, per kamer een plafond; nooit bewaard, geen nieuwe stand, niet herhaald', async () => {
  const { core, advance } = setup();
  const extra = Array.from({ length: 8 }, (_, i) => [`playerX${i}`, `Extra ${i}`, AVATARS[i]]);
  const { code, host, scr, players } = await partyRoom(core, { start: false, extra });
  const hub = core.rooms.get(code);
  let saves = 0;
  hub.deps.save = () => { saves++; };
  const states = () => [host, scr, ...players].reduce((n, p) => n + p.all('state').length, 0);
  const before = { saves, states: states(), snap: JSON.stringify(hub.snapshot()) };
  const [a] = players;
  a.send({ t: 'react', emoji: '👏' });
  advance(REACT_GAP_MS - 100);
  a.send({ t: 'react', emoji: '🔥' });
  await flush();
  assert.equal(scr.all('react').length, 1, 'te snel: weg');
  advance(100);
  a.send({ t: 'react', emoji: '🔥' });
  await flush();
  assert.equal(scr.all('react').length, 2);
  // 11 players at once: the room's cap (the window still holds Anouk's last one)
  advance(REACT_ROOM_WINDOW_MS);
  for (const p of players) p.send({ t: 'react', emoji: '🎉' });
  await flush();
  assert.equal(scr.all('react').length, 2 + REACT_ROOM_MAX);
  advance(REACT_ROOM_WINDOW_MS);
  players.at(-1).send({ t: 'react', emoji: '🎉' });
  await flush();
  assert.equal(scr.all('react').length, 3 + REACT_ROOM_MAX, 'na het venster weer');
  assert.equal(saves, before.saves, 'niets bewaard');
  assert.equal(states(), before.states, 'geen nieuwe stand naar wie dan ook');
  assert.equal(JSON.stringify(hub.snapshot()).replace(/"lastActive":\d+/, ''), before.snap.replace(/"lastActive":\d+/, ''), 'de opgeslagen kamer is gelijk');
  assert.ok(!JSON.stringify(hub.snapshot()).includes('🔥'), 'geen reactie in de kamer');
  // a display that comes later: welcome and the state, no reaction from before
  const late = connect(core, code);
  late.send({ t: 'hello', v: V, code, screen: true });
  await flush();
  assert.deepEqual(late.msgs.map((m) => m.t), ['welcome', 'state']);
  // the per-connection message limit still applies to a flood of reactions
  for (let i = 0; i < 90; i++) a.send({ t: 'react', emoji: '👏' });
  await flush();
  assert.equal(a.last('error').code, 'ratelimit');
});

test('niet spieken: vóór de onthulling geen antwoordtijd, oordeel, reeks- of jokerwijziging, snelste of statistiek voor wie niet leidt', async () => {
  const { core, advance, now } = setup();
  const { host, scr, players } = await partyRoom(core, { settings: { win: 'full' } });
  const watchers = [scr, ...players];
  const times = [];
  for (let round = 1; round <= 9; round++) {
    const marks = watchers.map((p) => p.raw.length);
    const view = players[0].view();
    assert.equal(view.phase, 'answering');
    const s = song(host);
    const fun = (v) => JSON.stringify({ mine: v.game.mine && [v.game.mine.streak, v.game.mine.jokers], p: v.game.disco.progress.map((x) => [x.id, x.streak, x.jokers]) });
    const startFun = watchers.map((p) => fun(p.view()));
    for (const [i, p] of players.entries()) {
      advance(1237 + i * 311 + round); // distinct times that are not in any other number
      times.push(now());
      // Anouk always right (a streak, jokers), Bram right on odd rounds, Cas changes his mind
      p.send({ t: 'answer', round, answer: answerFor(view, s, i === 0 || (i === 1 && round % 2 === 1)) });
      if (i === 2) { advance(7); times.push(now()); p.send({ t: 'answer', round, answer: answerFor(view, s, true) }); }
    }
    await flush();
    for (const [i, p] of watchers.entries()) {
      const msgs = p.raw.slice(marks[i]).filter((x) => x !== 'pong');
      assert.ok(msgs.length, 'berichten vóór de onthulling');
      for (const text of msgs) {
        const m = JSON.parse(text);
        if (m.meta) delete m.meta.now; // the server's clock is public (the countdown); the answer time is not
        const plain = JSON.stringify(m);
        for (const t of times) assert.ok(!plain.includes(String(t)), `ronde ${round}: geen antwoordtijd`);
        for (const key of ['"times"', '"rightSeq"', '"seq"', '"verdict"', '"auto"', '"jokerEarned":true', '"jokerSpent":true', '"stats":{', '"awards":[']) assert.ok(!plain.includes(key), `ronde ${round}: niets van ${key}`);
        if (m.t !== 'state') continue;
        const d = m.view.game.disco;
        assert.equal(d.fastest, null);
        assert.equal(m.view.game.reveal, null);
        assert.deepEqual(d.jokerSquares, []);
        assert.equal(fun(m.view), startFun[i], `ronde ${round}: reeks en jokers staan stil tot de onthulling`);
      }
    }
    advance(500);
    host.send({ t: 'reveal' });
    await flush();
    assert.equal(scr.view().game.disco.fastest?.id, 'playerA1', 'na de onthulling: Anouk was steeds de snelste');
    host.send({ t: 'next' });
    await flush();
  }
  assert.equal(players[0].view().game.mine.jokers, 2);
  assert.equal(players[0].view().game.mine.streak, 9);
});

test('prijsuitreiking op de server: na de winst bij spelers, spelleider en tv gelijk', async () => {
  const { core, advance } = setup();
  const { host, scr, players: [a, b] } = await partyRoom(core);
  for (let round = 1; round <= 30 && a.view().phase === 'answering'; round++) {
    const v = a.view();
    a.send({ t: 'answer', round, answer: answerFor(v, song(host), true) });
    advance(100);
    b.send({ t: 'answer', round, answer: answerFor(v, song(host), round % 3 === 0) });
    host.send({ t: 'reveal' });
    await flush();
    assert.equal(scr.view().game.disco.awards, null);
    host.send({ t: 'next' });
    await flush();
  }
  assert.equal(a.view().phase, 'won');
  const d = scr.view().game.disco;
  assert.ok(d.awards.length >= 2);
  assert.deepEqual(a.view().game.disco.awards, d.awards);
  assert.deepEqual(host.last('state').lead.spectator.game.disco.awards, d.awards);
  assert.equal(d.awards[0].kind, 'fastest');
  assert.deepEqual(d.awards[0].holders.map((h) => h.id), ['playerA1']);
  assert.equal(d.stats.find((x) => x.id === 'playerA1').avatar, '🦄');
  // Nog een potje: from zero again
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 8 });
  await flush();
  assert.equal(a.view().game.mine.streak, 0);
  assert.equal(a.view().game.disco.awards, null);
});

test('een Discobingo-kamer van de vorige versie (geen plaatjes, reeksen, tijden) laadt en speelt verder', () => {
  let room = G.createRoom({ code: 'KMRT', settings: { game: 'disco' } });
  room = G.addPlayer(room, { id: 'playerA1', name: 'Anouk' });
  room = G.addPlayer(room, { id: 'playerB1', name: 'Bram' });
  room = G.startGame(room, { cards, seed: 3, now: 1 });
  const s = room.game.songs[room.game.current];
  const cat = room.game.disco.cat;
  const ans = cat === 'decade' ? { decade: Math.floor(s.year / 10) * 10 } : cat === 'year' ? { guess: s.year } : { text: cat === 'artist' ? s.artist : s.title };
  room = G.submitAnswer(room, 'playerA1', ans, { now: 2 });
  room = G.reveal(room, { now: 3 });
  const stored = JSON.parse(JSON.stringify({ v: 1, code: 'KMRT', createdAt: 1, lastActive: 1, claimed: true, ownerId: 'owner01', ownerName: 'Ilse', leaderId: 'owner01', leaderAwaySince: 1, members: { owner01: { th: 'a'.repeat(64) }, playerA1: { th: 'b'.repeat(64) }, playerB1: { th: 'c'.repeat(64) } }, room }));
  for (const p of stored.room.players) delete p.avatar;
  for (const k of ['per', 'prev']) for (const x of Object.values(stored.room.game[k])) { delete x.streak; delete x.jokers; delete x.stats; }
  for (const k of ['times', 'seq', 'judged', 'fastest']) delete stored.room.game.disco[k];
  const sent = [];
  const hub = new RoomHub('KMRT', { send: (id, text) => sent.push([id, text]), now: () => 4 });
  hub.load(migrateState(stored));
  assert.ok(G.isValidRoom(hub.state.room));
  const v = hub.stateFor('playerA1', {}).view;
  assert.equal(v.players[0].avatar, avatarFor('playerA1'));
  assert.equal(v.game.mine.streak, 0);
  assert.equal(v.game.disco.fastest, null);
  const scr = hub.stateForScreen({}).view;
  assert.deepEqual(scr.game.disco.progress.map((p) => [p.streak, p.jokers]), [[0, 0], [0, 0]]);
  hub.state.room = G.nextRound(hub.state.room, { now: 5 });
  assert.equal(hub.state.room.game.per.playerA1.streak, 1, 'de ronde telt mee');
  assert.equal(hub.state.room.game.per.playerA1.stats.fastest, 0, 'zonder bewaarde tijd: geen snelste');
  assert.equal(hub.summary(true).players[0].avatar, avatarFor('playerA1'));
  assert.ok(REACTIONS.length === 6);
});
