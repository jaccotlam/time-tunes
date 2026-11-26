// A player's session (createServerClientSession in server-session.js) leaving and coming back,
// against a real Node room server over real WebSockets: Verlaat during a game keeps the seat
// (storedSeat), a new session on that seat gets the same card and stamps; Verlaat in the lobby,
// being removed and a room the server does not know forget the seat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNodeServer } from '../../server/node.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const S = await import('../../app/js/multi/server-session.js');
const { createServerClientSession, storedSeat, forgetSeat, checkSeat, tokenFor, SERVER_OVERRIDE_KEY, SEAT_KEY } = S;
const { PLAYER_ID_KEY } = await import('../../app/js/multi/client-session.js');

const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 30).map((year, i) => ({ id: `c${i + 1}`, year, title: `Titel ${i + 1}`, artist: `Artiest ${i + 1}`, previewUrl: `https://example.invalid/${i + 1}.m4a` }));

async function until(fn, ms = 10000, what = 'voorwaarde') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`wacht te lang op ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function member(base, code) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/rooms/${code}/ws`);
  const msgs = [];
  ws.onmessage = (e) => { if (e.data !== 'pong') msgs.push(JSON.parse(e.data)); };
  const opened = new Promise((r) => { ws.onopen = r; });
  return { msgs, ws, send: async (m) => { await opened; ws.send(JSON.stringify(m)); }, last: (t) => [...msgs].reverse().find((m) => m.t === t) || null };
}

let srv;
let base;
before(async () => {
  srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
  storage.set(SERVER_OVERRIDE_KEY, JSON.stringify(base));
});
after(async () => { await srv?.close(); });

async function discoRoom() {
  const { code, token } = await (await fetch(`${base}/rooms`, { method: 'POST', body: JSON.stringify({ v: V, id: 'owner01', name: 'Ilse', settings: { game: 'disco' } }) })).json();
  const host = member(base, code);
  await host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const other = member(base, code);
  await other.send({ t: 'hello', v: V, code, id: 'playerB1', name: 'Bram' });
  await until(() => host.last('welcome') && other.last('welcome'), 5000, 'welkom');
  return { code, host, other, close: () => { host.ws.close(); other.ws.close(); } };
}

test('stoel: Verlaat tijdens het spel houdt de plek; terug met een nieuwe sessie = zelfde kaart en stempels', async () => {
  storage.delete(SEAT_KEY);
  const { code, host, close } = await discoRoom();
  const s = createServerClientSession({ code, name: 'Anouk' });
  s.start();
  await until(() => s.online && s.view, 8000, 'speler online');
  assert.equal(s.keepsSeat, false, 'in de lobby');
  assert.deepEqual(storedSeat(), { code, name: 'Anouk', at: storedSeat().at });
  await host.send({ t: 'start', cards: cardsForServer(cards), seed: 3 });
  await until(() => s.view?.phase === 'answering', 5000, 'spel');
  // a right answer and a stamp in round 1
  const song = (await until(() => host.last('state')?.lead?.song, 3000, 'nummer'));
  const cat = s.view.game.disco.cat;
  s.answer(cat === 'decade' ? { decade: Math.floor(song.year / 10) * 10 } : cat === 'year' ? { guess: song.year } : { text: cat === 'artist' ? song.artist : song.title });
  await until(() => s.view.game.answer, 3000, 'antwoord');
  await host.send({ t: 'reveal' });
  await until(() => s.view.phase === 'revealed', 3000, 'onthuld');
  s.stamp(s.view.game.disco.choosable[0]);
  await until(() => s.view.game.disco.choice != null, 3000, 'gestempeld');
  const card = s.view.game.mine.card.slice();
  const marks = JSON.stringify(s.view.game.mine.marks);
  assert.equal(s.keepsSeat, true);
  assert.deepEqual(s.leave(), { seat: true });
  await until(() => host.last('state')?.view.players.find((p) => p.name === 'Anouk')?.online === false, 3000, 'weg');
  const seat = storedSeat();
  assert.equal(seat.code, code);
  assert.equal(seat.name, 'Anouk');
  // the game goes on: next round
  await host.send({ t: 'next' });
  await until(() => host.last('state')?.view.game.round === 2, 3000, 'ronde 2');
  // "Terug naar kamer": a new session with the seat's code and name
  assert.ok(await checkSeat(), 'de kamer is er nog');
  const s2 = createServerClientSession({ code: seat.code, name: seat.name });
  s2.start();
  await until(() => s2.online && s2.view?.game, 8000, 'terug');
  assert.deepEqual(s2.view.game.mine.card, card);
  assert.equal(JSON.stringify(s2.view.game.mine.marks), marks);
  assert.equal(s2.view.game.round, 2);
  assert.equal(s2.view.players.filter((p) => p.name === 'Anouk').length, 1, 'geen tweede Anouk');
  // back to the lobby; Verlaat there gives the seat up
  await host.send({ t: 'lobby' });
  await until(() => s2.view.phase === 'lobby', 3000, 'lobby');
  assert.equal(s2.keepsSeat, false);
  assert.deepEqual(s2.leave(), { seat: false });
  assert.equal(storedSeat(), null);
  await until(() => !host.last('state')?.view.players.some((p) => p.name === 'Anouk'), 3000, 'van de lijst');
  close();
});

test('stoel: verwijderd = vergeten; een kamer die de server niet kent = vergeten, het token blijft', async () => {
  storage.delete(SEAT_KEY);
  const { code, host, close } = await discoRoom();
  const s = createServerClientSession({ code, name: 'Cas' });
  s.start();
  await until(() => s.online, 8000, 'online');
  assert.equal(storedSeat()?.code, code);
  const id = storage.get(PLAYER_ID_KEY) && JSON.parse(storage.get(PLAYER_ID_KEY));
  await host.send({ t: 'remove', pid: id });
  await until(() => s.error, 5000, 'verwijderd');
  assert.equal(s.error.code, 'removed');
  assert.equal(storedSeat(), null);
  s.destroy();
  // a seat in a room the server does not know (any more): checkSeat forgets it; the token stays
  storage.set(SEAT_KEY, JSON.stringify({ code: 'BCDF', name: 'Cas', id, at: Date.now() }));
  const tokens = JSON.parse(storage.get('timetunesr.multiTokens.v1') || '{}');
  tokens.BCDF = { id, token: 'x'.repeat(32), at: Date.now() };
  storage.set('timetunesr.multiTokens.v1', JSON.stringify(tokens));
  assert.equal(storedSeat()?.code, 'BCDF');
  assert.equal(await checkSeat(), null);
  assert.equal(storedSeat(), null);
  assert.ok(tokenFor('BCDF', id), 'het token blijft (een herstarte server kan de kamer nog terugkrijgen)');
  // forgetSeat(code) only forgets that room; a seat without a token or of another id does not count
  storage.set(SEAT_KEY, JSON.stringify({ code: 'BCDF', name: 'Cas', id, at: Date.now() }));
  forgetSeat('ZZZZ');
  assert.ok(storedSeat());
  forgetSeat('BCDF');
  assert.equal(storedSeat(), null);
  storage.set(SEAT_KEY, JSON.stringify({ code: 'BCDF', name: 'Cas', id: 'iemandAnders', at: Date.now() }));
  assert.equal(storedSeat(), null);
  storage.set(SEAT_KEY, JSON.stringify({ code: 'BCDF', name: 'Cas', id, at: Date.now() - 7 * 3600e3 }));
  assert.equal(storedSeat(), null, 'te oud');
  close();
});

test('stoel: checkSeat vraagt de server naar dit id + token: een vreemde kamer met dezelfde code = vergeten', async () => {
  storage.delete(SEAT_KEY);
  const { RoomHub } = await import('../../server/room.mjs');
  const { code, host, close } = await discoRoom();
  const s = createServerClientSession({ code, name: 'Dirk' });
  s.start();
  await until(() => s.online, 8000, 'online');
  await host.send({ t: 'start', cards: cardsForServer(cards), seed: 8 });
  await until(() => s.view?.phase === 'answering', 5000, 'spel');
  assert.deepEqual(s.leave(), { seat: true });
  await until(() => host.last('state')?.view.players.find((p) => p.name === 'Dirk')?.online === false, 3000, 'Dirk weg');
  assert.equal((await checkSeat())?.code, code, 'de server kent deze plek');
  // the room goes, a stranger's new room gets the same code
  srv.core.rooms.get(code).shutdown('closed', 'dicht');
  const stranger = new RoomHub(code, {});
  stranger.create({ ownerId: 'strange1', name: 'Vreemd', settings: { game: 'disco' } });
  srv.core.rooms.set(code, stranger);
  assert.equal(await checkSeat(), null, 'geen "Terug naar kamer" naar een vreemde kamer');
  assert.equal(storedSeat(), null);
  close();
});

test('stoel: na Verlaat in de lobby zet een laat binnenkomend bericht de plek niet terug', async () => {
  storage.delete(SEAT_KEY);
  const { code, host, close } = await discoRoom();
  const s = createServerClientSession({ code, name: 'Eva' });
  s.start();
  await until(() => s.online && s.view, 8000, 'online');
  // the spelleider starts the game at the moment Eva taps Verlaat in the lobby: the state of the
  // new phase arrives after leave()
  await host.send({ t: 'start', cards: cardsForServer(cards), seed: 4 });
  assert.deepEqual(s.leave(), { seat: false });
  await until(() => host.last('state')?.view.phase === 'answering', 3000, 'spel gestart'); // the late state is on its way ...
  await sleep(150); // ... and had time to arrive at the session
  assert.equal(storedSeat(), null, 'Verlaat blijft Verlaat');
  close();
});
