// Leaving and coming back on the room server (server/core.mjs + room.mjs), with fake sockets
// and a fake clock. A deliberate "leave" during a game keeps the seat (card, stamps, score,
// this round's result, the token) and the same phone comes back to it in any phase; in the
// lobby a leave takes the player off the list. Nobody who is away blocks anything; a player
// the host removed stays removed; everybody's view (and the display's) shows them offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
const settle = () => new Promise((r) => setTimeout(r, 80));
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 36).map((year, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year, title: `Verborgen titel ${i + 1}`, artist: `Verborgen artiest ${i + 1}`,
  previewUrl: `https://example.invalid/geheim-${i + 1}.m4a`,
}));
const PLAYERS = [['playerA1', 'Anouk'], ['playerB1', 'Bram'], ['playerC1', 'Cas']];

function setup() {
  let t = 3_000_000;
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
async function room(core, settings, { start = true } = {}) {
  const { code, token } = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings }).body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const scr = connect(core, code);
  scr.send({ t: 'hello', v: V, code, screen: true });
  const players = [];
  const tokens = {};
  for (const [id, name] of PLAYERS) {
    const p = connect(core, code);
    p.send({ t: 'hello', v: V, code, id, name });
    players.push(p);
  }
  await flush();
  for (const [i, [id]] of PLAYERS.entries()) tokens[id] = players[i].last('welcome').token;
  if (start) { host.send({ t: 'start', cards: cardsForServer(cards), seed: 21 }); await flush(); }
  return { code, host, scr, players, tokens, hub: core.rooms.get(code) };
}
async function back(core, code, id, token) {
  const p = connect(core, code);
  p.send({ t: 'hello', v: V, code, id, name: PLAYERS.find((x) => x[0] === id)[1], token });
  await flush();
  return p;
}
function rightAnswer(view, song) {
  const cat = view.game.disco.cat;
  return cat === 'decade' ? { decade: Math.floor(song.year / 10) * 10 } : cat === 'year' ? { guess: song.year } : { text: cat === 'artist' ? song.artist : song.title };
}
const wrongAnswer = (view) => {
  const d = view.game.disco;
  return d.cat === 'decade' ? { pass: true } : d.cat === 'year' ? { guess: 1800 + 1 } : { text: 'Zzzqqq onzin' };
};
const seatOf = (hub, id) => JSON.stringify(hub.state.room.game.per[id]);
const onlineIn = (p, id) => p.view().players.find((x) => x.id === id)?.online;

test('verlaten in de lobby: van de lijst, mag later weer meedoen', async () => {
  const { core } = setup();
  const { code, host, scr, players: [a], tokens, hub } = await room(core, { game: 'disco' }, { start: false });
  a.send({ t: 'leave' });
  await settle();
  assert.equal(a.closed, 1000);
  assert.ok(!hub.state.room.players.some((p) => p.id === 'playerA1'), 'van de lijst');
  assert.ok(!Object.hasOwn(hub.state.members, 'playerA1'));
  assert.ok(!host.view().players.some((p) => p.id === 'playerA1'));
  assert.ok(!scr.view().players.some((p) => p.id === 'playerA1'));
  // the old token is worthless now; joining again is a fresh join with a fresh token
  const again = await back(core, code, 'playerA1', tokens.playerA1);
  assert.ok(again.last('welcome').token);
  assert.notEqual(again.last('welcome').token, tokens.playerA1);
});

test('Discobingo: weg tijdens het antwoorden, het spel gaat door, terug na een paar rondes op dezelfde plek', async () => {
  const { core } = setup();
  const { code, host, scr, players: [a, b, c], tokens, hub } = await room(core, { game: 'disco' });
  const cardC = hub.state.room.game.per.playerC1.card.slice();
  c.send({ t: 'leave' });
  await settle();
  assert.equal(c.closed, 1000);
  assert.ok(hub.state.room.players.some((p) => p.id === 'playerC1'), 'blijft in het spel');
  assert.equal(onlineIn(a, 'playerC1'), false, 'anderen zien Cas als offline');
  assert.equal(onlineIn(scr, 'playerC1'), false, 'het scherm ook');
  assert.equal(host.last('state').lead.spectator.players.find((p) => p.id === 'playerC1').online, false);
  assert.equal(scr.view().game.disco.progress.length, 3, 'Cas staat nog in de voortgang');
  // three rounds without Cas: reveal and next never wait for him
  for (let round = 1; round <= 3; round++) {
    const song = host.last('state').lead.song;
    a.send({ t: 'answer', round, answer: rightAnswer(a.view(), song) });
    b.send({ t: 'answer', round, answer: wrongAnswer(b.view()) });
    await flush();
    host.send({ t: 'reveal' });
    await flush();
    assert.equal(host.view().phase, 'revealed');
    assert.equal(host.view().game.reveal.results.find((r) => r.id === 'playerC1').none, true);
    host.send({ t: 'next' });
    await flush();
    assert.equal(host.last('error'), null, `ronde ${round}: niets geblokkeerd`);
  }
  assert.equal(host.view().game.round, 4);
  const seat = seatOf(hub, 'playerC1');
  // Cas comes back with his token: the same card and stamps, in the running round
  const c2 = await back(core, code, 'playerC1', tokens.playerC1);
  assert.equal(c2.last('welcome').token, undefined, 'geen nieuwe plek');
  const v = c2.view();
  assert.deepEqual(v.game.mine.card, cardC);
  assert.equal(seatOf(hub, 'playerC1'), seat);
  assert.equal(v.phase, 'answering');
  assert.equal(v.game.round, 4);
  assert.equal(onlineIn(a, 'playerC1'), true);
  // and simply plays along again: answers right, stamps
  const song = host.last('state').lead.song;
  c2.send({ t: 'answer', round: 4, answer: rightAnswer(v, song) });
  await flush();
  host.send({ t: 'reveal' });
  await flush();
  const choose = c2.view().game.disco.choosable;
  assert.ok(choose.length);
  c2.send({ t: 'stamp', round: 4, index: choose[0] });
  await flush();
  assert.equal(c2.view().game.disco.choice, choose[0]);
  assert.equal(c2.view().game.mine.stamped, JSON.parse(seat).marks.filter((m, i) => i !== 12 && m != null).length + 1);
});

test('Discobingo: weg na de onthulling met een goed antwoord (vakje nog niet gekozen): automatisch geplaatst, resultaat blijft', async () => {
  const { core } = setup();
  const { code, host, players: [a, b, c], tokens, hub } = await room(core, { game: 'disco' });
  const song = host.last('state').lead.song;
  c.send({ t: 'answer', round: 1, answer: rightAnswer(c.view(), song) });
  a.send({ t: 'answer', round: 1, answer: wrongAnswer(a.view()) });
  await flush();
  host.send({ t: 'reveal' });
  await flush();
  assert.deepEqual(host.view().game.disco.pending, ['playerC1']);
  c.send({ t: 'leave' });
  await settle();
  const res = host.view().game.reveal.results.find((r) => r.id === 'playerC1');
  assert.equal(res.verdict, 'right', 'het resultaat blijft staan');
  assert.deepEqual(host.view().game.disco.pending, ['playerC1'], 'nog "kiest" (alleen informatie)');
  host.send({ t: 'next' });
  await flush();
  assert.equal(host.last('error'), null);
  assert.equal(host.view().phase, 'answering');
  const marks = hub.state.room.game.per.playerC1.marks;
  assert.ok(marks.includes(song.id), 'automatisch afgestempeld met het nummer van ronde 1');
  const c2 = await back(core, code, 'playerC1', tokens.playerC1);
  assert.equal(c2.view().game.mine.stamped, 1);
  assert.equal(b.view().players.find((p) => p.id === 'playerC1').score, 1);
});

test('Discobingo: twijfel van iemand die weg is = één tik Goed/Fout van de spelleider, daarna niets meer', async () => {
  const { core } = setup();
  const { host, players: [, , c], hub } = await room(core, { game: 'disco' });
  // find a typed round
  for (let round = 1; round < 12; round++) {
    const v = c.view();
    if (['artist', 'title'].includes(v.game.disco.cat)) {
      const song = host.last('state').lead.song;
      const truth = v.game.disco.cat === 'artist' ? song.artist : song.title;
      c.send({ t: 'answer', round, answer: { text: `${truth.slice(0, -3)}xq` } }); // close: a doubt
      await flush();
      host.send({ t: 'reveal' });
      await flush();
      const r = host.view().game.reveal.results.find((x) => x.id === 'playerC1');
      if (r.verdict !== 'doubt') { host.send({ t: 'next' }); await flush(); continue; }
      c.send({ t: 'leave' });
      await settle();
      host.send({ t: 'next' });
      await flush();
      assert.equal(host.last('error').code, 'doubt', 'de spelleider beslist eerst');
      host.send({ t: 'judge', pid: 'playerC1', ok: true });
      await flush();
      host.send({ t: 'next' });
      await flush();
      assert.equal(host.view().phase, 'answering', 'één tik en door');
      assert.equal(hub.state.room.game.per.playerC1.marks.filter((m) => m && m !== '*').length, 1, 'goed: automatisch gestempeld');
      return;
    }
    host.send({ t: 'reveal' });
    await flush();
    host.send({ t: 'next' });
    await flush();
  }
  assert.fail('geen twijfelgeval gevonden');
});

test('Discobingo: weg op het winnaarsscherm; volgende spel krijgt ook hij een kaart; terug in het nieuwe spel', async () => {
  const { core } = setup();
  const { code, host, players: [a, , c], tokens, hub } = await room(core, { game: 'disco' });
  // play until somebody wins (Anouk always right, stamps the best square automatically)
  for (let round = 1; round < 40 && host.view().phase !== 'won'; round++) {
    a.send({ t: 'answer', round, answer: rightAnswer(a.view(), host.last('state').lead.song) });
    await flush();
    host.send({ t: 'reveal' });
    await flush();
    host.send({ t: 'next' });
    await flush();
  }
  assert.equal(host.view().phase, 'won');
  const seat = seatOf(hub, 'playerC1');
  c.send({ t: 'leave' });
  await settle();
  assert.equal(seatOf(hub, 'playerC1'), seat, 'plek blijft op het winnaarsscherm');
  const c2 = await back(core, code, 'playerC1', tokens.playerC1);
  assert.equal(c2.view().phase, 'won');
  assert.deepEqual(c2.view().game.winners, ['Anouk']);
  c2.send({ t: 'leave' });
  await settle();
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 5 });
  await flush();
  assert.equal(host.view().phase, 'answering');
  assert.ok(hub.state.room.game.per.playerC1, 'ook een kaart voor wie weg is');
  const c3 = await back(core, code, 'playerC1', tokens.playerC1);
  assert.equal(c3.view().game.mine.card.length, 25);
  assert.equal(c3.view().game.round, 1);
});

test('verwijderd blijft verwijderd, ook als hij weg was; de spelleider kan een afwezige verwijderen', async () => {
  const { core } = setup();
  const { code, host, scr, players: [, , c], tokens, hub } = await room(core, { game: 'disco' });
  c.send({ t: 'leave' });
  await settle();
  host.send({ t: 'remove', pid: 'playerC1' });
  await flush();
  assert.ok(!hub.state.room.players.some((p) => p.id === 'playerC1'));
  assert.equal(scr.view().game.disco.progress.length, 2);
  const c2 = await back(core, code, 'playerC1', tokens.playerC1);
  assert.equal(c2.last('error').code, 'removed');
  assert.equal(c2.last('welcome'), null);
});

test('spelleider (een speler die de leiding nam) verlaat tijdens het spel: leiding terug naar de eigenaar, plek blijft', async () => {
  const { core, advance } = setup();
  const { code, host, players: [a], tokens, hub } = await room(core, { game: 'disco' });
  host.conn.closed();
  advance(31000);
  a.send({ t: 'lead' });
  await flush();
  assert.equal(hub.state.leaderId, 'playerA1');
  a.send({ t: 'leave' });
  await settle();
  assert.equal(hub.state.leaderId, 'owner01');
  assert.ok(hub.state.room.game.per.playerA1);
  const a2 = await back(core, code, 'playerA1', tokens.playerA1);
  assert.equal(a2.view().game.mine.card.length, 25);
  assert.equal(a2.last('state').lead, undefined, 'geen leider meer');
});

test('Quiz: weg tijdens een vraag = de vraag wacht niet; terug met dezelfde score', async () => {
  const { core } = setup();
  const { code, host, players: [a, b, c], tokens, hub } = await room(core, { game: 'quiz', questions: 5, think: 20 });
  host.send({ t: 'playing', round: 1 });
  await flush();
  a.send({ t: 'answer', round: 1, answer: { choice: 0 } });
  b.send({ t: 'answer', round: 1, answer: { choice: 1 } });
  await flush();
  assert.equal(host.view().phase, 'answering', 'Cas is er nog: wachten');
  c.send({ t: 'leave' });
  await settle();
  assert.equal(host.view().phase, 'revealed', 'Cas weg: meteen onthuld');
  const score = hub.state.room.game.per.playerC1;
  assert.ok(score);
  host.send({ t: 'next' });
  await flush();
  const c2 = await back(core, code, 'playerC1', tokens.playerC1);
  assert.equal(c2.view().game.round, 2);
  assert.deepEqual(hub.state.room.game.per.playerC1, score);
});

test('Bingo en Tijdlijn: verlaten tijdens het spel houdt kaart en tijdlijn', async () => {
  for (const settings of [{ game: 'bingo', size: 3 }, { game: 'timeline', goal: 10 }]) {
    const { core } = setup();
    const { code, host, players: [a, , c], tokens, hub } = await room(core, settings);
    const seat = seatOf(hub, 'playerC1');
    c.send({ t: 'leave' });
    await settle();
    a.send({ t: 'answer', round: 1, answer: settings.game === 'bingo' ? { pass: true } : { slot: 0 } });
    await flush();
    host.send({ t: 'reveal' });
    await flush();
    host.send({ t: 'next' });
    await flush();
    assert.equal(host.last('error'), null);
    assert.equal(seatOf(hub, 'playerC1'), seat, settings.game);
    const c2 = await back(core, code, 'playerC1', tokens.playerC1);
    assert.ok(c2.view().game.mine, `${settings.game}: eigen kaart/tijdlijn terug`);
  }
});

test('een gesloten tab en een weggevallen verbinding: ook plek houden en terugkomen (zoals al zo was)', async () => {
  const { core, advance } = setup();
  const { code, host, players: [a, b], tokens, hub } = await room(core, { game: 'disco' });
  const seatA = seatOf(hub, 'playerA1');
  a.conn.closed(); // tab closed
  advance(30000);
  host.conn.message('ping'); // the host is alive
  core.sweep(); // b's connection went silent (no pings): dropped as stale
  await settle();
  assert.equal(onlineIn(host, 'playerA1'), false);
  assert.equal(b.closed, 4002);
  const a2 = await back(core, code, 'playerA1', tokens.playerA1);
  assert.equal(seatOf(hub, 'playerA1'), seatA);
  assert.ok(a2.view().game.mine);
  const b2 = await back(core, code, 'playerB1', tokens.playerB1);
  assert.ok(b2.view().game.mine);
});
