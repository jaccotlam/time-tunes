// The Quiz on the room server (server/core.mjs + room.mjs), with fake sockets and a fake
// clock: the clock starts at "playing" (or the safety net), answers after the time and a
// second answer are refused, the right answer is in no message before the reveal, the
// timer closes the question, everybody answered closes it, and a restart in the middle of
// a question puts the room back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer } from '../../app/js/multi/server-protocol.js';
import { QUIZ_START_FALLBACK_MS, QUIZ_GRACE_MS } from '../../app/js/multi/quiz.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 20));
const cards = Array.from({ length: 24 }, (_, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year: 1961 + i, title: `Geheime titel ${i + 1}`, artist: `Geheime artiest ${i + 1}`,
  previewUrl: `https://example.invalid/geheim-${i + 1}.m4a`, itunesId: 1000 + i,
}));

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
  return p;
}
async function quizRoom(core, { hostPlays = false } = {}) {
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', hostPlays, settings: { game: 'quiz', questions: 10, think: 20 } });
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
const quizOf = (p) => p.last('state').view.game.quiz;

test('quiz: klok start bij "playing", één antwoord, te laat geweigerd, iedereen klaar = onthullen', async () => {
  const { core, advance } = setup();
  const { host, players: [a, b, c] } = await quizRoom(core);
  let q = quizOf(a);
  assert.equal(a.last('state').view.phase, 'answering');
  assert.equal(q.options.length, 4);
  assert.equal(q.deadline, null, 'de klok wacht op de muziek');
  a.send({ t: 'answer', round: 1, answer: { choice: 0 } });
  await flush();
  assert.equal(a.last('error').code, 'wait');
  a.send({ t: 'playing', round: 1 });
  await flush();
  assert.equal(a.last('error').code, 'notleader', 'alleen de muziektelefoon start de klok');
  host.send({ t: 'playing', round: 1 });
  await flush();
  q = quizOf(a);
  assert.ok(q.deadline > a.last('state').meta.now, 'deadline in servertijd; meta.now voor het klokverschil');
  a.send({ t: 'answer', round: 1, answer: { choice: 1 } });
  a.send({ t: 'answer', round: 1, answer: { choice: 2 } });
  await flush();
  assert.equal(a.last('error').code, 'final', 'tweede antwoord geweigerd');
  assert.equal(quizOf(a).choice, 1);
  assert.equal(quizOf(host).answered, 1);
  b.send({ t: 'answer', round: 1, answer: { choice: 3 } });
  advance(20000 + QUIZ_GRACE_MS + 10);
  c.send({ t: 'answer', round: 1, answer: { choice: 0 } });
  await flush();
  assert.equal(c.last('error').code, 'late', 'antwoord na de tijd geweigerd');
  // the leader reveals, or the timer: here the timer (sweep = what the Node timer does)
  core.sweep();
  await flush();
  assert.equal(a.last('state').view.phase, 'revealed', 'de timer sluit de vraag');
  const rv = quizOf(a).reveal;
  assert.ok(Number.isInteger(rv.answer));
  assert.equal(rv.counts.reduce((x, y) => x + y, 0), 2);
  assert.equal(c.last('state').view.game.quiz.reveal.mine.none, true);
  // next question: everybody answers -> revealed at once, without the leader
  host.send({ t: 'next' });
  await flush();
  host.send({ t: 'playing', round: 2 });
  await flush();
  for (const p of [a, b, c]) p.send({ t: 'answer', round: 2, answer: { choice: 0 } });
  await flush();
  assert.equal(a.last('state').view.phase, 'revealed', 'iedereen heeft geantwoord: meteen onthuld');
});

test('quiz: het goede antwoord staat vóór de onthulling in geen enkel bericht naar een speler', async () => {
  const { core, advance } = setup();
  const { host, players } = await quizRoom(core);
  for (let round = 1; round <= 4; round++) {
    host.send({ t: 'playing', round });
    await flush();
    const song = host.last('state').lead.song;
    for (const p of players) {
      p.send({ t: 'answer', round, answer: { choice: round % 4 } });
      await flush();
      const before = [];
      for (const text of p.raw) {
        const m = JSON.parse(text === 'pong' ? '{}' : text);
        if (m.t === 'state' && m.view.phase === 'answering' && m.view.game.round === round) before.push(text);
      }
      assert.ok(before.length, 'berichten vóór de onthulling');
      for (const text of before) {
        assert.ok(!text.includes('"reveal":{'), 'geen onthulling');
        assert.ok(!text.includes(song.previewUrl) && !text.includes(`"${song.id}"`), 'het nummer zelf niet (de vier opties mogen de spelers zien)');
        assert.ok(!/"answer":\d/.test(text), 'geen index van het goede antwoord');
      }
    }
    advance(1000);
    if (host.last('state').view.phase !== 'revealed') host.send({ t: 'reveal' });
    await flush();
    host.send({ t: 'next' });
    await flush();
  }
});

test('quiz: vangnet start de klok zonder melding van de muziektelefoon; herstart midden in een vraag', async () => {
  const { core, advance, now } = setup();
  const { code, token, host, players: [a] } = await quizRoom(core);
  advance(QUIZ_START_FALLBACK_MS + 1);
  core.sweep();
  await flush();
  assert.ok(quizOf(a).deadline, 'de klok loopt na het vangnet');
  a.send({ t: 'answer', round: 1, answer: { choice: 2 } });
  await flush();
  // the owner's backup -> a fresh server (restart) -> restore
  const backup = host.last('backup');
  assert.ok(backup && backup.snap.room.game.kind === 'quiz');
  let t2 = now() + 60000;
  const core2 = createRoomServer({ now: () => t2 });
  const res = core2.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '1', body: JSON.stringify({ v: V, id: 'owner01', token, snap: backup.snap }) });
  assert.equal(res.status, 200);
  const h2 = connect(core2, code);
  h2.send({ t: 'hello', v: V, code, id: 'owner01', token });
  await flush();
  const st = h2.last('state');
  assert.equal(st.view.phase, 'answering', 'zelfde vraag na de herstart');
  assert.equal(st.view.game.round, 1);
  assert.equal(st.lead.spectator.game.quiz.deadline, null, 'de klok begint opnieuw zodra de muziek speelt');
  h2.send({ t: 'playing', round: 1 });
  await flush();
  assert.equal(h2.last('state').lead.spectator.game.quiz.deadline, t2 + 20000, 'weer de volle bedenktijd');
  t2 += 20000 + QUIZ_GRACE_MS + 5;
  core2.sweep();
  await flush();
  assert.equal(h2.last('state').view.phase, 'revealed');
});
