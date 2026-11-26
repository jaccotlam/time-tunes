// Discobingo on the room server (server/core.mjs + room.mjs), with fake sockets and a fake
// clock: per-recipient views, the stamp and judge messages, the no-peeking guarantee (no
// song data and no other player's answer in any message to a player before the reveal),
// protocol version 4, rooms stored by the previous version, and the mix threshold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub, migrateState } from '../../server/room.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer, parseClientMessage, LEADER_TYPES } from '../../app/js/multi/server-protocol.js';
import { mixMinimum } from '../../app/js/multi/mix.js';
import * as G from '../../app/js/multi/game.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
// years never end in 0 or 9, so a year can not hide in a decade label ("1980–1989")
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 30).map((year, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year, title: `Verborgen titel ${i + 1}`, artist: `Verborgen artiest ${i + 1}`,
  previewUrl: `https://example.invalid/geheim-${i + 1}.m4a`, itunesId: 1000 + i,
}));

function setup() {
  let t = 7_000_000;
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
  p.view = () => p.last('state').view;
  return p;
}
async function discoRoom(core, { hostPlays = false, settings = {} } = {}) {
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', hostPlays, settings: { game: 'disco', ...settings } });
  assert.equal(res.status, 201);
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const players = [];
  for (const [id, name] of [['playerA1', 'Anouk'], ['playerB1', 'Bram'], ['playerC1', 'Cas']]) {
    const p = connect(core, code);
    p.send({ t: 'hello', v: V, code, id, name });
    players.push(p);
  }
  await flush();
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 7 });
  await flush();
  return { code, token, host, players };
}
const secretOf = (i, round) => `Geheimtekst${'ABC'[i]}${round}x`;

function answerFor(view, song, i) {
  const d = view.game.disco;
  if (d.cat === 'decade') return { decade: i === 0 ? Math.floor(song.year / 10) * 10 : d.decades[0].decade };
  if (d.cat === 'year') return { guess: i === 0 ? song.year + 1 : 1900 };
  return { text: i === 0 ? (d.cat === 'artist' ? song.artist : song.title) : secretOf(i, view.game.round) };
}

test('disco op de server: weergave per ontvanger, stempelen, oordelen, volgende ronde', async () => {
  const { core } = setup();
  const { host, players: [a, b, c] } = await discoRoom(core);
  const st = host.last('state');
  const av = a.view();
  assert.equal(av.phase, 'answering');
  assert.equal(av.settings.game, 'disco');
  assert.equal(av.settings.win, 'line1');
  const d = av.game.disco;
  assert.ok(['decade', 'artist', 'year', 'title'].includes(d.cat), 'de categorie is openbaar');
  assert.equal(d.spin, 1);
  assert.equal(d.spunAt, a.last('state').meta.now, 'servertijd van de draai (meta.now voor het klokverschil)');
  assert.equal(d.spinMs, 4000);
  assert.deepEqual(d.decades.map((x) => x.decade), [1960, 1970, 1980, 1990]);
  assert.equal(av.game.mine.card.length, 25);
  assert.equal(av.game.mine.marks[12], '*');
  assert.equal(av.game.reveal, null);
  assert.notDeepEqual(av.game.mine.card, b.view().game.mine.card, 'ieder een eigen kaart');
  assert.equal(st.lead.song.title, cards.find((x) => x.id === st.lead.room.game.current).title, 'de muziektelefoon krijgt het nummer');
  assert.equal(a.last('state').lead, undefined, 'een speler niet');
  assert.equal(st.lead.spectator.game.mine, null);
  const song = st.lead.song;
  for (const [i, p] of [a, b, c].entries()) p.send({ t: 'answer', round: 1, answer: answerFor(a.view(), song, i) });
  await flush();
  assert.ok(a.view().game.answer, 'eigen antwoord terug');
  assert.ok(host.view().players.filter((p) => p.answered).length === 3);
  a.send({ t: 'reveal' });
  await flush();
  assert.equal(a.last('error').code, 'notleader');
  host.send({ t: 'reveal' });
  await flush();
  const rv = b.view();
  assert.equal(rv.phase, 'revealed');
  assert.equal(rv.game.reveal.song.title, song.title);
  const res = Object.fromEntries(rv.game.reveal.results.map((x) => [x.id, x]));
  assert.equal(res.playerA1.verdict, 'right');
  assert.equal(res.playerB1.verdict, 'wrong');
  assert.deepEqual(rv.game.disco.pending, ['playerA1']);
  const choose = a.view().game.disco.choosable;
  assert.equal(choose.length, 6);
  assert.equal(a.view().game.disco.mustChoose, true);
  // stamp: bad index, wrong round, a player who was wrong
  a.send({ t: 'stamp', round: 1, index: 'x' });
  await flush();
  assert.equal(a.last('error').code, 'answer');
  b.send({ t: 'stamp', round: 1, index: b.view().game.mine.card.indexOf(rv.game.disco.cat) });
  await flush();
  assert.match(b.last('error').message, /goed antwoord/);
  a.send({ t: 'stamp', round: 9, index: choose[0] });
  a.send({ t: 'stamp', round: 1, index: choose[1] });
  await flush();
  assert.equal(a.view().game.disco.choice, choose[1]);
  assert.equal(a.view().game.mine.marks[choose[1]], song.year);
  a.send({ t: 'stamp', round: 1, index: choose[2] });
  await flush();
  assert.equal(a.view().game.disco.choice, choose[2], 'verplaatst');
  assert.equal(a.view().game.mine.stamped, 1);
  assert.equal(Object.fromEntries(b.view().game.reveal.results.map((x) => [x.id, x])).playerA1.stamped, choose[2]);
  // judge: only the leader; flip Bram to right
  b.send({ t: 'judge', pid: 'playerB1', ok: true });
  await flush();
  assert.equal(b.last('error').code, 'notleader');
  host.send({ t: 'judge', pid: 'playerB1', ok: 'ja' });
  await flush();
  assert.equal(host.last('error').code, 'bad');
  host.send({ t: 'judge', pid: 'playerB1', ok: true });
  await flush();
  assert.equal(b.view().game.disco.mustChoose, true);
  assert.equal(host.last('state').lead.room.game.results.playerB1.verdict, 'right');
  host.send({ t: 'next' });
  await flush();
  const nv = b.view();
  assert.equal(nv.phase, 'answering');
  assert.equal(nv.game.disco.spin, 2);
  assert.equal(nv.game.mine.stamped, 1, 'Bram automatisch geplaatst');
  assert.notEqual(nv.game.disco.cat, rv.game.disco.cat, 'nooit twee keer dezelfde categorie achter elkaar');
});

test('disco: twijfel blokkeert de volgende ronde tot de spelleider Goed of Fout kiest', async () => {
  const { core } = setup();
  const { host, players: [a, b] } = await discoRoom(core);
  for (let round = 1; round < 9; round++) {
    const v = a.view();
    if (['artist', 'title'].includes(v.game.disco.cat)) break;
    host.send({ t: 'reveal' });
    await flush();
    host.send({ t: 'next' });
    await flush();
  }
  const v = a.view();
  assert.ok(['artist', 'title'].includes(v.game.disco.cat));
  const song = host.last('state').lead.song;
  const full = v.game.disco.cat === 'artist' ? song.artist : song.title;
  a.send({ t: 'answer', round: v.game.round, answer: { text: full.split(' ').slice(1).join(' ') } });
  b.send({ t: 'answer', round: v.game.round, answer: { text: full } });
  await flush();
  host.send({ t: 'reveal' });
  await flush();
  assert.equal(a.view().game.disco.waitingForHost, true);
  assert.deepEqual(host.last('state').lead.spectator.game.disco.doubts, ['playerA1']);
  const lr = host.last('state').lead.room.game.results.playerA1;
  assert.equal(lr.verdict, 'doubt');
  assert.equal(lr.doubt, true);
  host.send({ t: 'next' });
  await flush();
  assert.equal(host.last('error').code, 'doubt');
  assert.match(host.last('error').message, /Beslis eerst/);
  host.send({ t: 'override', pid: 'playerA1' });
  await flush();
  assert.equal(host.last('error').code, 'doubt');
  host.send({ t: 'judge', pid: 'playerA1', ok: false });
  await flush();
  assert.equal(a.view().game.disco.waitingForHost, false);
  host.send({ t: 'override', pid: 'playerA1' }); // flip: right after all
  await flush();
  assert.equal(a.view().game.disco.mustChoose, true);
  host.send({ t: 'next' });
  await flush();
  assert.equal(a.view().phase, 'answering');
  assert.equal(a.view().game.mine.stamped, 1);
});

test('disco: niet spieken: vóór de onthulling geen titel, artiest of jaar en geen antwoorden van anderen', async () => {
  const { core } = setup();
  const { host, players } = await discoRoom(core);
  let typed = 0;
  for (let round = 1; round <= 10; round++) {
    const marks = players.map((p) => p.raw.length);
    const song = host.last('state').lead.song;
    const view = players[0].view();
    assert.equal(view.game.round, round);
    if (['artist', 'title'].includes(view.game.disco.cat)) typed++;
    for (const [i, p] of players.entries()) p.send({ t: 'answer', round, answer: answerFor(view, song, i) });
    await flush();
    for (const [i, p] of players.entries()) {
      const before = p.raw.slice(marks[i]);
      assert.ok(before.length, 'berichten vóór de onthulling');
      for (const text of before) {
        if (text === 'pong') continue;
        // Anouk typed the right answer herself: her own answer comes back to her (only to her)
        if (i !== 0 || !['artist', 'title'].includes(view.game.disco.cat)) assert.ok(!text.includes(song.title) && !text.includes(song.artist), `ronde ${round}: geen titel/artiest`);
        assert.ok(!new RegExp(`\\b${song.year}\\b`).test(text), `ronde ${round}: geen jaar`);
        assert.ok(!text.includes(song.previewUrl) && !text.includes(`"${song.id}"`), 'geen fragment of id');
        assert.ok(!text.includes('"reveal":{'));
        for (const j of [0, 1, 2]) if (j !== i) assert.ok(!text.includes(secretOf(j, round)), `ronde ${round}: geen antwoord van een ander`);
      }
    }
    host.send({ t: 'reveal' });
    await flush();
    // after the reveal everybody sees what everybody typed
    if (['artist', 'title'].includes(view.game.disco.cat)) {
      const res = players[0].view().game.reveal.results;
      assert.equal(res.find((x) => x.id === 'playerB1').text, secretOf(1, round));
    }
    host.send({ t: 'next' });
    await flush();
    if (players[0].view().phase !== 'answering') break;
  }
  assert.ok(typed >= 2, 'er zaten getypte rondes bij');
});

test('disco: protocolversie 4; de vorige app krijgt een nette melding', async () => {
  const { core } = setup();
  assert.ok(V >= 4);
  assert.equal(http(core, 'POST', '/rooms', { v: 3, id: 'owner01' }).status, 409);
  const { code } = await discoRoom(core);
  const old = connect(core, code);
  old.send({ t: 'hello', v: 3, code, id: 'playerOld', name: 'Oud' });
  await flush();
  assert.equal(old.last('error').code, 'version');
  assert.ok(parseClientMessage(JSON.stringify({ t: 'stamp', round: 1, index: 3 })));
  assert.ok(parseClientMessage(JSON.stringify({ t: 'judge', pid: 'x', ok: true })));
  assert.ok(LEADER_TYPES.includes('judge') && !LEADER_TYPES.includes('stamp'));
});

test('disco: een kamer opgeslagen door de vorige versie laadt (zonder settings.win) en speelt verder', () => {
  // a stored Bingo room of protocol 3, in the middle of a round
  let room = G.createRoom({ code: 'KMRT', settings: { game: 'bingo', size: 3 } });
  room = G.addPlayer(room, { id: 'playerA1', name: 'Anouk' });
  room = G.startGame(room, { cards, seed: 3 });
  room = G.reveal(room);
  delete room.settings.win;
  const stored = { v: 1, code: 'KMRT', createdAt: 1, lastActive: 1, claimed: true, ownerId: 'owner01', ownerName: 'Ilse', leaderId: 'owner01', leaderAwaySince: 1, members: { owner01: { th: 'a'.repeat(64) }, playerA1: { th: 'b'.repeat(64) } }, room };
  const sent = [];
  const hub = new RoomHub('KMRT', { send: (id, text) => sent.push([id, text]), now: () => 2 });
  hub.load(migrateState(JSON.parse(JSON.stringify(stored))));
  assert.equal(hub.state.room.settings.win, 'line1');
  assert.equal(hub.state.room.settings.size, 3, 'de rest blijft');
  assert.equal(hub.state.room.phase, 'revealed');
  assert.ok(G.isValidRoom(hub.state.room));
  hub.state.room = G.nextRound(hub.state.room);
  assert.equal(hub.state.room.phase, 'answering');
  // a lobby room of the previous version can switch to Discobingo
  const lobby = migrateState({ ...JSON.parse(JSON.stringify(stored)), room: { ...G.backToLobby(room), settings: { game: 'bingo', size: 4, goal: 10, questions: 10, qtype: 'mix', think: 20, music: 'deck' } } });
  assert.equal(G.setSettings(lobby.room, { game: 'disco' }).settings.game, 'disco');
});

test('disco: 25 nummers nodig, ook bij de Mix van de groep (de lobby zegt hoeveel nog)', async () => {
  assert.equal(mixMinimum({ game: 'disco' }, 3), 25);
  assert.equal(mixMinimum({ game: 'disco' }, 12), 25);
  const { core } = setup();
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings: { game: 'disco', music: 'mix' } });
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const a = connect(core, code);
  a.send({ t: 'hello', v: V, code, id: 'playerA1', name: 'Anouk' });
  await flush();
  host.send({ t: 'start', cards: [], seed: 1 });
  await flush();
  assert.equal(host.last('error').code, 'mix');
  assert.match(host.last('error').message, /nog 25 nodig/);
  host.send({ t: 'settings', patch: { music: 'deck' } });
  await flush();
  host.send({ t: 'start', cards: cardsForServer(cards.slice(0, 24)), seed: 1 });
  await flush();
  assert.match(host.last('error').message, /minstens 25/);
});

test('disco: de spelleider speelt mee en laat instappen tijdens het spel', async () => {
  const { core } = setup();
  const { code, host } = await discoRoom(core, { hostPlays: true, settings: { win: 'full' } });
  const hv = host.view();
  assert.equal(hv.game.mine.card.length, 25, 'eigen kaart voor de meespelende spelleider');
  assert.equal(hv.game.disco.win, 'full');
  host.send({ t: 'reveal' });
  await flush();
  host.send({ t: 'next' });
  await flush();
  const late = connect(core, code);
  late.send({ t: 'hello', v: V, code, id: 'playerLate', name: 'Laat' });
  await flush();
  const lv = late.view();
  assert.equal(lv.game.mine.card.length, 25);
  assert.equal(lv.game.mine.stamped, 0, 'zoveel als wie het verst achter ligt');
  assert.ok(lv.game.disco.progress.some((p) => p.id === 'playerLate'));
});
