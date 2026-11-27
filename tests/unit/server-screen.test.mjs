// The display ("groot scherm") on the room server (server/core.mjs + room.mjs), with fake
// sockets and a fake clock: hello / welcome / leave, meta.screens, a display is never a
// player (player list, "everybody answered", late start, take-over, backup), it can send no
// game message, the limit per room, broken hellos, the no-peeking guarantee in every game
// (every message a display gets before each reveal), a stored room, reconnecting and the
// Cloudflare hibernation restore (RoomHub.load with the connection attachments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub, migrateState, MAX_CONNS_PER_ROOM, MAX_SCREENS_PER_ROOM } from '../../server/room.mjs';
import { SERVER_PROTOCOL_VERSION, TAKEOVER_MS, cardsForServer } from '../../app/js/multi/server-protocol.js';
import * as G from '../../app/js/multi/game.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
const settle = () => new Promise((r) => setTimeout(r, 80)); // core.mjs closes a socket 50 ms after its last message
// years never end in 0 or 9, so a year can not hide in a decade label ("1980–1989")
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 36).map((year, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year, title: `Verborgen titel ${i + 1}`, artist: `Verborgen artiest ${i + 1}`,
  previewUrl: `https://example.invalid/geheim-${i + 1}.m4a`, itunesId: 1000 + i,
}));
const PLAYERS = [['playerA1', 'Anouk'], ['playerB1', 'Bram'], ['playerC1', 'Cas']];

function setup() {
  let t = 9_000_000;
  const core = createRoomServer({ now: () => t });
  return { core, advance: (ms) => { t += ms; }, now: () => t };
}
const http = (core, method, path, body) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', body: body == null ? '' : JSON.stringify(body) });
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const p = { msgs: [], raw: [], closed: null };
  p.conn = up.attach({ send: (text) => { p.raw.push(text); p.msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)); }, close: (c, reason) => { p.closed = { c, reason }; } });
  p.send = (m) => p.conn.message(typeof m === 'string' ? m : JSON.stringify(m));
  p.last = (t) => [...p.msgs].reverse().find((m) => m.t === t) || null;
  p.all = (t) => p.msgs.filter((m) => m.t === t);
  p.view = () => p.last('state')?.view || null;
  p.meta = () => p.last('state')?.meta || null;
  return p;
}
const screen = (core, code, extra = {}) => {
  const s = connect(core, code);
  s.send({ t: 'hello', v: V, code, screen: true, ...extra });
  return s;
};
async function room(core, settings, { start = true, screenFirst = true } = {}) {
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings });
  assert.equal(res.status, 201);
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const scr = screenFirst ? screen(core, code) : null;
  const players = [];
  for (const [id, name] of PLAYERS) {
    const p = connect(core, code);
    p.send({ t: 'hello', v: V, code, id, name });
    players.push(p);
  }
  await flush();
  if (start) {
    host.send({ t: 'start', cards: cardsForServer(cards), seed: 11 });
    await flush();
  }
  return { code, token, host, scr, players };
}

test('scherm: hallo zonder id, welkom, publieke weergave, meta.screens; weg = één minder', async () => {
  const { core } = setup();
  const { code, host, scr, players: [a] } = await room(core, { game: 'disco' }, { start: false });
  const w = scr.last('welcome');
  assert.deepEqual(w, { t: 'welcome', v: V, code, screen: true }, 'geen id, geen token');
  const st = scr.last('state');
  assert.equal(st.lead, undefined, 'geen leidersdeel');
  assert.equal(st.view.you, null);
  assert.equal(st.view.game, null);
  assert.deepEqual(st.view.players.map((p) => p.name), ['Anouk', 'Bram', 'Cas']);
  assert.ok(st.view.players.every((p) => p.online));
  assert.equal(st.meta.screen, true);
  assert.equal(st.meta.you, null);
  assert.equal(st.meta.owner, false);
  assert.equal(st.meta.leader, false);
  assert.equal(st.meta.leaderOnline, true);
  assert.equal(st.meta.leaderName, 'Ilse');
  assert.equal(st.meta.mix.mine, 0);
  assert.equal(st.meta.screens, 1);
  assert.equal(host.meta().screens, 1, 'de spelleider ziet dat er een scherm is');
  assert.equal(a.meta().screens, 1);
  assert.equal(host.meta().screen, undefined);
  assert.deepEqual(st.view, host.last('state').lead.spectator, 'precies de toeschouwersweergave van de spelleider');
  assert.equal(scr.all('backup').length, 0);
  // a second display, then one leaves, the other closes
  const s2 = screen(core, code);
  await flush();
  assert.equal(host.meta().screens, 2);
  s2.send({ t: 'leave' });
  await settle();
  assert.equal(s2.closed?.c, 1000);
  assert.equal(host.meta().screens, 1);
  scr.conn.closed();
  await flush();
  assert.equal(host.meta().screens, 0);
  assert.equal(a.meta().screens, 0);
  // the same display connection saying hello twice stays one display
  const s3 = screen(core, code);
  s3.send({ t: 'hello', v: V, code, screen: true });
  await flush();
  assert.equal(s3.all('welcome').length, 2);
  assert.equal(host.meta().screens, 1);
});

test('scherm: geen speler: spelerslijst, iedereen-geantwoord, instappen, overnemen en back-up blijven gelijk', async () => {
  const { core, advance } = setup();
  // lobby: not in the player list, not in the room info, not a member
  const { code, host, players } = await room(core, { game: 'quiz', questions: 5, think: 20 }, { start: false });
  assert.equal(host.last('state').lead.room.players.length, 3);
  assert.equal(http(core, 'GET', `/rooms/${code}`).body.players, 3);
  const hub = core.rooms.get(code);
  assert.deepEqual(Object.keys(hub.state.members).sort(), ['owner01', 'playerA1', 'playerB1', 'playerC1']);
  assert.deepEqual(Object.keys(hub.presence()).sort(), ['owner01', 'playerA1', 'playerB1', 'playerC1'], 'een scherm is niet "online" als speler');
  const backup = host.last('backup').snap;
  assert.deepEqual(Object.keys(backup.members).sort(), ['owner01', 'playerA1', 'playerB1', 'playerC1']);
  assert.ok(!JSON.stringify(backup).includes('screen'), 'het scherm staat niet in de back-up');
  // Quiz: everybody online answered closes the question; the display does not hold it open
  host.send({ t: 'start', cards: cardsForServer(cards), seed: 3 });
  await flush();
  host.send({ t: 'playing', round: 1 });
  await flush();
  for (const p of players) p.send({ t: 'answer', round: 1, answer: { choice: 0 } });
  await flush();
  assert.equal(players[0].view().phase, 'revealed', 'meteen onthuld, het scherm telt niet mee');
  // a display arriving during a game gets no late start
  const per = Object.keys(hub.state.room.game.per).sort();
  const late = screen(core, code);
  await flush();
  assert.deepEqual(Object.keys(hub.state.room.game.per).sort(), per);
  assert.equal(late.view().game.mine, null);
  assert.equal(late.view().game.quiz.choice, null);
  // take-over: the leader goes, a display stays; the display can not lead, a player can after 30 s
  host.conn.closed();
  await flush();
  assert.equal(late.meta().leaderOnline, false, 'het scherm houdt de spelleider niet online');
  late.send({ t: 'lead' });
  await flush();
  assert.equal(late.last('error').code, 'screen');
  assert.equal(hub.state.leaderId, 'owner01');
  advance(TAKEOVER_MS + 1000);
  players[0].send({ t: 'lead' });
  await flush();
  assert.equal(hub.state.leaderId, 'playerA1');
  assert.equal(late.meta().leaderName, 'Anouk');
  assert.equal(late.last('state').lead, undefined);
  assert.equal(late.all('backup').length, 0);
});

test('scherm: kan geen spelberichten sturen (nette weigering, verbinding blijft, kamer ongewijzigd)', async () => {
  const { core } = setup();
  const { code, scr, players: [a] } = await room(core, { game: 'disco' });
  const hub = core.rooms.get(code);
  const before = JSON.stringify(hub.state);
  const msgs = [
    { t: 'answer', round: 1, answer: { guess: '1960' } }, { t: 'withdraw' }, { t: 'settings', patch: { game: 'quiz' } },
    { t: 'start', cards: cardsForServer(cards) }, { t: 'reveal' }, { t: 'override', pid: 'playerA1' }, { t: 'next' }, { t: 'lobby' },
    { t: 'remove', pid: 'playerA1' }, { t: 'close' }, { t: 'lead' }, { t: 'playing', round: 1 }, { t: 'mix-add', tracks: [] },
    { t: 'mix-clear' }, { t: 'stamp', round: 1, index: 3 }, { t: 'judge', pid: 'playerA1', ok: true },
    { t: 'hold', round: 1 }, { t: 'continue', win: 'line2' }, { t: 'finish' },
  ];
  for (const m of msgs) {
    const n = scr.all('error').length;
    scr.send(m);
    await flush();
    assert.equal(scr.all('error').length, n + 1, `${m.t} geweigerd`);
    assert.equal(scr.last('error').code, 'screen');
  }
  scr.send({ t: 'hello', v: V, code, id: 'playerZ1', name: 'Zwartrijder' });
  await flush();
  assert.equal(scr.last('error').code, 'screen', 'een scherm wordt geen speler');
  assert.equal(scr.closed, null, 'de verbinding blijft');
  assert.equal(JSON.stringify(hub.state), before, 'niets veranderd');
  assert.equal(hub.state.room.players.length, 3);
  // and a player's connection can not turn into a display
  a.send({ t: 'hello', v: V, code, screen: true });
  await flush();
  assert.equal(a.last('error').code, 'screen');
  assert.equal(hub.screenCount(), 1);
  // pings are answered
  scr.send('ping');
  assert.equal(scr.raw.at(-1), 'pong');
});

test(`scherm: hoogstens ${MAX_SCREENS_PER_ROOM} per kamer: een nieuw scherm neemt de plek van het stilste over; schermen tellen mee voor de verbindingslimiet`, async () => {
  const { core, advance } = setup();
  const { code, host, scr } = await room(core, { game: 'bingo' }, { start: false });
  const more = [scr];
  for (let i = 1; i < MAX_SCREENS_PER_ROOM; i++) { advance(1000); more.push(screen(core, code)); }
  await flush();
  assert.equal(host.meta().screens, MAX_SCREENS_PER_ROOM);
  // everybody but the first one pings now: the first is heard from longest ago
  advance(5000);
  for (const d of more.slice(1)) d.send('ping');
  const states = host.all('state').length;
  const extra = screen(core, code);
  await settle();
  assert.ok(extra.last('welcome'), 'het nieuwe scherm komt erin');
  assert.equal(extra.view().phase, 'lobby');
  assert.equal(more[0].last('error').code, 'screenreplaced', 'het stilste scherm hoort waarom');
  assert.equal(more[0].closed?.c, 4001);
  assert.ok(more.slice(1).every((d) => d.closed == null), 'de andere blijven');
  assert.equal(host.meta().screens, MAX_SCREENS_PER_ROOM);
  assert.equal(host.all('state').length, states, 'het aantal bleef gelijk: niemand anders krijgt een nieuwe toestand');
  // connection limit: displays count, and a full room refuses a display as well
  const hub = core.rooms.get(code);
  const open = [];
  while (hub.conns.size < MAX_CONNS_PER_ROOM) open.push(connect(core, code));
  const over = connect(core, code);
  assert.equal(over.last('error').code, 'busy');
});

test('scherm: sid: een stil weggevallen tv neemt bij terugkomst zijn eigen plek terug; herhaalde hallo stuurt niets naar anderen', async () => {
  const { core, advance } = setup();
  const { code, host, players: [a] } = await room(core, { game: 'disco' }, { start: false, screenFirst: false });
  const hub = core.rooms.get(code);
  // four displays (tabs t0..t3) drop silently: no close, their slots stay until STALE_MS
  const tabs = ['tabZero000', 'tabOne0000', 'tabTwo0000', 'tabThree00'];
  const dead = tabs.map((sid) => screen(core, code, { sid }));
  await flush();
  assert.equal(hub.screenCount(), 4);
  advance(10000);
  host.send('ping');
  // tab 2 reconnects: its own old slot goes, nobody else is pushed out
  const back = screen(core, code, { sid: 'tabTwo0000' });
  await settle();
  assert.ok(back.last('welcome'));
  assert.equal(back.last('error'), null);
  assert.equal(dead[2].last('error').code, 'screenreplaced');
  assert.ok([0, 1, 3].every((i) => dead[i].closed == null));
  assert.equal(hub.screenCount(), 4);
  // a sid of the wrong form is ignored (that display just takes the stalest slot)
  const odd = screen(core, code, { sid: '__proto__' });
  await settle();
  assert.ok(odd.last('welcome'));
  assert.equal(dead[0].last('error').code, 'screenreplaced');
  // a repeated hello on the same connection: a welcome and a state for that display only
  const n = a.msgs.filter((m) => m.t === 'state').length;
  for (let i = 0; i < 70; i++) back.send({ t: 'hello', v: V, code, screen: true, sid: 'tabTwo0000' });
  await flush();
  assert.equal(a.msgs.filter((m) => m.t === 'state').length, n, 'geen nieuwe toestand naar spelers');
  assert.equal(back.all('welcome').length, 71);
  assert.equal(hub.screenCount(), 4);
});

test('scherm: kapotte en vreemde hallo\'s', async () => {
  const { core } = setup();
  const { code, host } = await room(core, { game: 'disco' }, { start: false, screenFirst: false });
  const hub = core.rooms.get(code);
  const members = () => Object.keys(hub.state.members).sort();
  const m0 = members();
  // not a display: screen must be exactly true; without an id that is a broken player hello
  for (const bad of [{ screen: 'true' }, { screen: 1 }, { screen: {} }, { screen: [true] }]) {
    const s = connect(core, code);
    s.send({ t: 'hello', v: V, code, ...bad });
    await flush();
    assert.equal(s.last('error').code, 'bad');
    assert.equal(s.last('welcome'), null);
  }
  // "__proto__" as a key does not make a display (JSON makes it an own property)
  const proto = connect(core, code);
  proto.send(`{"t":"hello","v":${V},"code":"${code}","__proto__":{"screen":true}}`);
  await flush();
  assert.equal(proto.last('error').code, 'bad');
  // a display with an id / token / name: those are ignored, it stays a display
  for (const id of ['__proto__', 'constructor', 'playerA1', 'owner01']) {
    const s = screen(core, code, { id, name: 'Kaper', token: 'x'.repeat(32) });
    await flush();
    assert.deepEqual(s.last('welcome'), { t: 'welcome', v: V, code, screen: true });
    s.send({ t: 'leave' });
    await flush();
  }
  assert.deepEqual(members(), m0, 'niemand toegevoegd');
  assert.equal(hub.state.room.players.length, 3);
  // version, another room, an unknown room: the same answers a player gets
  const old = screen(core, code, { v: 3 });
  await flush();
  assert.equal(old.last('error').code, 'version');
  const other = connect(core, code);
  other.send({ t: 'hello', v: V, code: 'ZZZZ', screen: true });
  await flush();
  assert.equal(other.last('error').code, 'room');
  const none = screen(core, 'BCDF');
  await flush();
  assert.equal(none.last('error').code, 'notfound');
  assert.equal(host.meta().screens, 0);
  assert.equal(hub.screenCount(), 0);
});

/**
 * Plays `rounds` rounds of a game with a display watching and checks every message the
 * display got from the previous "next" (or the start) up to the reveal: nothing of the running
 * song, nobody's answer. `answer(i, view, song, round)` -> the answer of player i (or null).
 */
async function noPeeking(settings, { rounds, answer, secrets = () => [], forbid = [], songFields = true }) {
  const { core } = setup();
  const { host, scr, players } = await room(core, settings);
  let mark = 0;
  let checked = 0;
  for (let round = 1; round <= rounds; round++) {
    const song = host.last('state').lead.song;
    assert.ok(song, 'de muziektelefoon heeft het nummer');
    if (settings.game === 'quiz') { host.send({ t: 'playing', round }); await flush(); }
    const typed = [];
    for (const [i, p] of players.entries()) {
      const a = answer(i, p.view(), song, round);
      if (a) { p.send({ t: 'answer', round, answer: a }); typed.push(...secrets(a)); }
    }
    await flush();
    const sv = scr.view();
    assert.equal(sv.phase, 'answering');
    assert.equal(sv.game.round, round);
    assert.deepEqual(sv, host.last('state').lead.spectator, 'het scherm = de toeschouwersweergave');
    assert.equal(sv.players.filter((p) => p.answered).length, players.filter((p) => p.view().game.answer || p.view().game.quiz?.choice != null).length, 'wie al geantwoord heeft');
    const before = scr.raw.slice(mark);
    assert.ok(before.length, 'berichten vóór de onthulling');
    for (const text of before) {
      if (text === 'pong') continue;
      checked++;
      if (songFields) {
        assert.ok(!text.includes(song.title) && !text.includes(song.artist), `ronde ${round}: geen titel/artiest`);
        assert.ok(!new RegExp(`\\b${song.year}\\b`).test(text), `ronde ${round}: geen jaar`);
      }
      assert.ok(!text.includes(song.previewUrl) && !text.includes(`"${song.id}"`), `ronde ${round}: geen fragment of id`);
      assert.ok(!text.includes('itunes') && !text.includes(String(song.itunesId)), 'geen iTunes-id');
      assert.ok(!text.includes('"reveal":{'), 'geen onthulling');
      assert.ok(!text.includes('"lead"') && !text.includes('"backup"'), 'geen leidersdeel, geen back-up');
      for (const s of typed) assert.ok(!text.includes(s), `ronde ${round}: geen getypt antwoord (${s})`);
      for (const re of forbid) assert.ok(!re.test(text), `ronde ${round}: niet ${re}`);
    }
    host.send({ t: 'reveal' });
    await flush();
    // after the reveal the display sees the song and everybody's results, as the players do
    const rv = scr.view();
    if (rv.phase === 'revealed') {
      assert.equal(rv.game.reveal.song.title, song.title);
      assert.equal(rv.game.reveal.song.year, song.year);
      assert.deepEqual(rv.game.reveal.results, players[0].view().game.reveal.results);
      assert.equal(rv.game.reveal.mine, null);
      assert.ok(!JSON.stringify(scr.msgs).includes(song.previewUrl), 'het fragment nooit');
    }
    mark = scr.raw.length;
    host.send({ t: 'next' });
    await flush();
    // Discobingo: a bingo stops the game; go on for the next goal (or stop after a full card)
    const bingo = scr.view().game?.disco?.bingo;
    if (bingo) { host.send(bingo.next.length ? { t: 'continue', win: bingo.next[0] } : { t: 'finish' }); await flush(); }
    if (scr.view().phase !== 'answering') break;
  }
  assert.ok(checked >= rounds, 'genoeg berichten gecontroleerd');
  return { scr, host, players };
}
const secretOf = (i, round) => `Geheimtekst${'ABC'[i]}${round}x`;

test('scherm: niet spieken bij Discobingo (categorie, draai, voortgang, wie geantwoord heeft; na onthullen alles)', async () => {
  let typedRounds = 0;
  const { scr } = await noPeeking({ game: 'disco' }, {
    rounds: 10,
    answer: (i, view, song, round) => {
      const d = view.game.disco;
      if (i === 0) typedRounds += ['artist', 'title'].includes(d.cat) ? 1 : 0;
      if (d.cat === 'exact' || d.cat === 'year') return { guess: 1900 + i };
      return { text: secretOf(i, round) };
    },
    secrets: (a) => (a.text ? [a.text] : []),
  });
  assert.ok(typedRounds >= 2, 'er zaten getypte rondes bij');
  const d = scr.view().game.disco;
  for (const k of ['cat', 'spin', 'spunAt', 'spinMs', 'win', 'stages', 'bingo', 'autoAt', 'autoMs', 'autoHeld', 'chips', 'progress', 'pending', 'doubts']) assert.ok(k in d, `disco.${k}`);
  assert.ok(!('decades' in d), 'geen decennia meer');
  assert.equal(d.choice, null);
  assert.deepEqual(d.choosable, []);
  assert.equal(d.mustChoose, false);
  assert.equal(d.progress.length, 3);
  assert.ok(Number.isFinite(scr.meta().now));
});

test('scherm: niet spieken bij Bingo (getypte antwoorden pas bij de onthulling)', async () => {
  let typed = 0;
  await noPeeking({ game: 'bingo', size: 3 }, {
    rounds: 8,
    answer: (i, view, song, round) => {
      const card = view.game.mine.card;
      const at = card.findIndex((k) => k === 'artist' || k === 'title');
      if (at < 0 || i === 2) return { pass: true };
      typed++;
      return { index: at, text: secretOf(i, round) };
    },
    secrets: (a) => (a.text ? [a.text] : []),
    forbid: [/"index":\d/],
  });
  assert.ok(typed >= 2, 'er zijn antwoorden getypt');
});

test('scherm: niet spieken bij Tijdlijn (geen plek van een ander vóór de onthulling)', async () => {
  await noPeeking({ game: 'timeline', goal: 10 }, {
    rounds: 6,
    answer: (i) => (i === 2 ? null : { slot: 0 }),
    forbid: [/"slot":/, /"timeline":/],
  });
});

test('scherm: niet spieken bij de Quiz (vraag en opties wel, goede antwoord en keuzes niet)', async () => {
  const { scr } = await noPeeking({ game: 'quiz', questions: 6, think: 20 }, {
    rounds: 6,
    // two of three answer, so the leader's reveal (not "everybody answered") ends the question
    answer: (i, view, song, round) => (i === 2 ? null : { choice: (round + i) % 4 }),
    forbid: [/"answer":\d/, /"choice":\d/, /"counts":/],
    songFields: false, // the four options may hold the title / artist / year: everybody sees those
  });
  const q = scr.last('state').view.game.quiz;
  for (const k of ['round', 'total', 'think', 'qtype', 'type', 'prompt', 'options', 'startedAt', 'deadline', 'answered', 'playing', 'ranking']) assert.ok(k in q, `quiz.${k}`);
});

test('scherm: Quiz-weergave tijdens een vraag: klok, aantallen; na de onthulling antwoord, tellingen en stand', async () => {
  const { core } = setup();
  const { host, scr, players: [a, b] } = await room(core, { game: 'quiz', questions: 5, think: 20 });
  host.send({ t: 'playing', round: 1 });
  await flush();
  a.send({ t: 'answer', round: 1, answer: { choice: 1 } });
  await flush();
  let q = scr.view().game.quiz;
  assert.equal(q.options.length, 4);
  assert.ok(q.prompt);
  assert.equal(q.deadline, q.startedAt + 20000);
  assert.equal(q.answered, 1);
  assert.equal(q.playing, 3);
  assert.equal(q.reveal, null);
  assert.equal(q.ranking, null);
  b.send({ t: 'answer', round: 1, answer: { choice: 2 } });
  host.send({ t: 'reveal' });
  await flush();
  q = scr.view().game.quiz;
  assert.ok(Number.isInteger(q.reveal.answer));
  assert.equal(q.reveal.counts.reduce((x, y) => x + y, 0), 2);
  assert.equal(q.reveal.mine, null);
  assert.equal(q.ranking.length, 3);
});

test('scherm: een kamer opgeslagen door de vorige versie laadt; het scherm komt erbij', async () => {
  let room = G.createRoom({ code: 'KMRT', settings: { game: 'disco' } });
  room = G.addPlayer(room, { id: 'playerA1', name: 'Anouk' });
  room = G.startGame(room, { cards, seed: 3 });
  const stored = { v: 1, code: 'KMRT', createdAt: 1, lastActive: 1, claimed: true, ownerId: 'owner01', ownerName: 'Ilse', leaderId: 'owner01', leaderAwaySince: 1, members: { owner01: { th: 'a'.repeat(64) }, playerA1: { th: 'b'.repeat(64) } }, room, mix: {} };
  const sent = [];
  const hub = new RoomHub('KMRT', { send: (id, text) => sent.push([id, text]), now: () => 2 });
  hub.load(migrateState(JSON.parse(JSON.stringify(stored))));
  hub.open('d1');
  hub.message('d1', JSON.stringify({ t: 'hello', v: V, code: 'KMRT', screen: true }));
  await flush();
  const msgs = sent.filter(([id]) => id === 'd1').map(([, t]) => JSON.parse(t));
  assert.equal(msgs[0].t, 'welcome');
  const st = msgs.find((m) => m.t === 'state');
  assert.equal(st.view.phase, 'answering');
  assert.equal(st.view.game.kind, 'disco');
  assert.equal(st.meta.screens, 1);
  assert.equal(hub.state.room.players.length, 1);
});

test('scherm: opnieuw verbinden (net weg, ververst) en een herstarte Node-server: het scherm komt terug', async () => {
  const { core } = setup();
  const { code, token, host, scr } = await room(core, { game: 'disco' });
  scr.conn.closed();
  const back = screen(core, code);
  await flush();
  assert.equal(host.meta().screens, 1);
  assert.equal(back.view().game.kind, 'disco');
  // a restarted server: the display finds no room (it waits), the owner puts it back, the display comes back
  const snap = host.last('backup').snap;
  const { core: fresh } = setup();
  const lost = screen(fresh, code);
  await flush();
  assert.equal(lost.last('error').code, 'notfound');
  const r = http(fresh, 'POST', `/rooms/${code}/restore`, { v: V, id: 'owner01', token, snap });
  assert.equal(r.status, 200);
  const again = screen(fresh, code);
  await flush();
  assert.equal(again.view().game.kind, 'disco');
  assert.equal(again.meta().leaderOnline, false, 'de spelleider is nog niet terug');
  assert.equal(again.meta().restored, true);
});

test('scherm: Cloudflare-hibernation: de verbinding is na het wakker worden nog steeds een scherm', async () => {
  const sent = [];
  const attached = {};
  let t = 1000;
  const deps = { send: (id, text) => sent.push([id, text]), attach: (id, rec) => { attached[id] = rec; }, now: () => t };
  const hub = new RoomHub('HBRN', deps);
  const { token } = hub.create({ ownerId: 'owner01', name: 'Ilse', settings: { game: 'disco' } });
  hub.open('o1');
  hub.message('o1', JSON.stringify({ t: 'hello', v: V, code: 'HBRN', id: 'owner01', token }));
  hub.open('d1');
  hub.message('d1', JSON.stringify({ t: 'hello', v: V, code: 'HBRN', screen: true }));
  await flush();
  assert.deepEqual(attached.d1, { mid: null, lastSeen: t, screen: true }, 'het scherm staat in de attachment');
  assert.deepEqual(attached.o1, { mid: 'owner01', lastSeen: t }, 'spelers houden hun attachment zoals het was');
  // the object sleeps and wakes: a new hub from storage + the sockets' attachments (worker.mjs makeHub)
  t += 60000;
  const sent2 = [];
  const hub2 = new RoomHub('HBRN', { ...deps, send: (id, text) => sent2.push([id, text]) });
  const conns = Object.entries(JSON.parse(JSON.stringify(attached))).map(([connId, a]) => ({ connId, mid: a.mid, screen: a.screen === true, lastSeen: t }));
  // a forged attachment with both a member id and screen stays the member
  conns.push({ connId: 'x1', mid: 'owner01', screen: true, lastSeen: t });
  hub2.load(JSON.parse(JSON.stringify(hub.snapshot())), conns);
  assert.equal(hub2.screenCount(), 1);
  assert.deepEqual(Object.keys(hub2.presence()), ['owner01']);
  hub2.message('o1', JSON.stringify({ t: 'settings', patch: { win: 'line2' } }));
  await flush();
  const toScreen = sent2.filter(([id]) => id === 'd1').map(([, s]) => JSON.parse(s));
  assert.equal(toScreen.at(-1).t, 'state');
  assert.equal(toScreen.at(-1).meta.screen, true);
  assert.equal(toScreen.at(-1).meta.screens, 1);
  assert.equal(toScreen.at(-1).view.settings.win, 'line2');
  hub2.message('d1', JSON.stringify({ t: 'start', cards: cardsForServer(cards) }));
  assert.equal(JSON.parse(sent2.at(-1)[1]).code, 'screen', 'ook na het wakker worden geen spelberichten');
  hub2.close('d1');
  await flush();
  assert.equal(hub2.screenCount(), 0);
  const last = sent2.filter(([id]) => id === 'o1').map(([, s]) => JSON.parse(s)).filter((m) => m.t === 'state').at(-1);
  assert.equal(last.meta.screens, 0);
});

test('scherm: dode schermverbinding wordt opgeruimd; een scherm alleen houdt een kamer niet levend', async () => {
  const { core, advance } = setup();
  const { code, host } = await room(core, { game: 'bingo' }, { start: false });
  const hub = core.rooms.get(code);
  const lastActive = hub.state.lastActive;
  for (const p of [host]) p.conn.closed();
  advance(10000);
  const late = screen(core, code);
  await flush();
  assert.equal(hub.state.lastActive, lastActive, 'een scherm is geen activiteit');
  advance(30000);
  core.sweep();
  await settle();
  assert.equal(hub.screenCount(), 0, 'stil scherm opgeruimd');
  assert.equal(late.closed?.c, 4002);
});
