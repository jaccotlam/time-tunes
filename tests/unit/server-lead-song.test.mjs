// The music phone's song: every state the spelleider gets carries, in the same message, the
// round it shows and the song of exactly that round (lead.song). Checked at the RoomHub level
// (every message to the owner's connection, after a re-hello in the middle of a round and
// after next / start), for every game kind, and for the host session against a real Node
// server (currentSong() never lags behind the round the session shows, also after a reload).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomHub } from '../../server/room.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const flush = () => new Promise((r) => setTimeout(r, 10));
const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 36).map((year, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, year, title: `Titel ${i + 1}`, artist: `Artiest ${i + 1}`, previewUrl: `https://example.invalid/${i + 1}.m4a` }));

function hubWith(settings) {
  const sent = new Map(); // connId -> [message]
  let t = 1_000_000;
  const hub = new RoomHub('SONG', { send: (id, text) => { if (!sent.has(id)) sent.set(id, []); if (text !== 'pong') sent.get(id).push(JSON.parse(text)); }, now: () => t });
  const { token } = hub.create({ ownerId: 'owner01', name: 'Ilse', settings });
  const say = (conn, m) => hub.message(conn, JSON.stringify(m));
  hub.open('o1');
  say('o1', { t: 'hello', v: V, code: 'SONG', id: 'owner01', token });
  for (const [conn, id] of [['p1', 'playerA1'], ['p2', 'playerB1']]) { hub.open(conn); say(conn, { t: 'hello', v: V, code: 'SONG', id, name: id }); }
  return { hub, sent, token, say, advance: (ms) => { t += ms; } };
}

/** Every state to the owner: when it shows a running round, lead.song is that round's song. */
function checkOwnerStates(msgs, songOfRound, label) {
  for (const m of msgs) {
    if (m.t !== 'state') continue;
    const { phase, game } = m.view;
    if (!game || !['answering', 'revealed'].includes(phase)) continue;
    assert.ok(m.lead?.song, `${label}: ronde ${game.round} (${phase}) zonder lead.song`);
    assert.equal(m.lead.song.id, songOfRound[game.round], `${label}: ronde ${game.round} met het nummer van een andere ronde`);
    assert.equal(m.lead.room.game.current, m.lead.song.id, `${label}: room.game.current en lead.song horen bij elkaar`);
  }
}

for (const settings of [{ game: 'bingo', size: 3 }, { game: 'timeline', goal: 10 }, { game: 'disco' }, { game: 'quiz', questions: 6, think: 20 }]) {
  test(`muziektelefoon (${settings.game}): na een nieuwe hallo midden in een ronde en na volgende draagt de EERSTE toestand van de ronde het juiste nummer`, async () => {
    const { hub, sent, token, say } = hubWith(settings);
    await flush();
    const songOfRound = {};
    const note = () => { const g = hub.state.room.game; if (g?.current) songOfRound[g.round] = g.current; };
    say('o1', { t: 'start', cards: cardsForServer(cards), seed: 5 });
    note();
    await flush();
    for (let round = 1; round <= 4; round++) {
      // the host's tab reloads in the middle of the round: a new connection, the same owner
      const conn = `o-reload-${round}`;
      hub.open(conn);
      say(conn, { t: 'hello', v: V, code: 'SONG', id: 'owner01', token });
      await flush();
      const after = sent.get(conn);
      assert.equal(after[0].t, 'welcome', 'eerst welkom');
      const first = after.find((m) => m.t === 'state');
      assert.ok(first, 'een toestand na de hallo');
      assert.equal(first.view.game.round, round);
      assert.equal(first.lead.song?.id, songOfRound[round], 'de eerste toestand na herladen heeft het lopende nummer');
      checkOwnerStates(after, songOfRound, `herladen ronde ${round}`);
      // the round goes on from the new connection
      if (settings.game === 'quiz') say(conn, { t: 'playing', round });
      say(conn, { t: 'reveal' });
      await flush();
      const mark = after.length;
      say(conn, { t: 'next' });
      note();
      await flush();
      if (hub.state.room.phase !== 'answering') break;
      const firstNext = after.slice(mark).find((m) => m.t === 'state');
      assert.equal(firstNext.view.game.round, round + 1);
      assert.equal(firstNext.lead.song?.id, songOfRound[round + 1], 'de eerste toestand van de nieuwe ronde heeft het nieuwe nummer');
      checkOwnerStates(after, songOfRound, `volgende na ronde ${round}`);
    }
    checkOwnerStates(sent.get('o1'), songOfRound, 'eerste verbinding');
  });
}

test('volgorde: de spelleider krijgt per verandering precies één toestand, op dezelfde beurt als de spelers', async () => {
  const { hub, sent, say } = hubWith({ game: 'bingo', size: 3 });
  await flush();
  say('o1', { t: 'start', cards: cardsForServer(cards), seed: 5 });
  await flush();
  const marks = Object.fromEntries([...sent].map(([id, l]) => [id, l.length]));
  say('o1', { t: 'reveal' });
  await flush();
  say('o1', { t: 'next' });
  await flush();
  const states = (id) => sent.get(id).slice(marks[id]).filter((m) => m.t === 'state');
  assert.equal(states('o1').length, 2, 'onthullen + volgende');
  assert.equal(states('p1').length, 2);
  assert.deepEqual(states('o1').map((m) => [m.view.phase, m.view.game.round]), states('p1').map((m) => [m.view.phase, m.view.game.round]));
  assert.ok(hub.state.room.game.round === 2);
});

// ---------- the host session over real WebSockets ----------
const storage = new Map();
globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

test('hostsessie: currentSong() hoort altijd bij de ronde die de sessie toont, ook direct na herladen', async () => {
  const { startNodeServer } = await import('../../server/node.mjs');
  const S = await import('../../app/js/multi/server-session.js');
  const srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true });
  const base = `http://127.0.0.1:${srv.port}`;
  storage.set(S.SERVER_OVERRIDE_KEY, JSON.stringify(base));
  const until = async (fn, what, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`wacht op ${what}`); await new Promise((r) => setTimeout(r, 10)); } };
  const truth = {}; // round -> song id, from the server itself
  const problems = []; // the session catches errors in listeners: collect them here
  let checked = 0;
  const watch = (s, label) => s.subscribe(() => { try { check(s, label); } catch (e) { problems.push(e.message); } });
  const check = (s, label) => {
    const r = s.room;
    const sv = s.spectatorView();
    if (!r?.game || !['answering', 'revealed'].includes(r.phase)) return;
    const hub = srv.core.rooms.get(s.code);
    const g = hub?.state?.room?.game;
    if (g?.round === r.game.round && g.current) truth[g.round] = g.current;
    assert.ok(s.currentSong(), `${label}: ronde ${r.game.round} zonder nummer`);
    assert.equal(s.currentSong().id, r.game.current, `${label}: nummer en ronde uit één bericht`);
    assert.equal(sv.game.round, r.game.round, `${label}: de weergave en de samenvatting tonen dezelfde ronde`);
    if (truth[r.game.round]) assert.equal(s.currentSong().id, truth[r.game.round], `${label}: het nummer van deze ronde`);
    checked++;
  };
  try {
    const host = S.createServerHostSession();
    host.create({ hostPlays: false, hostName: 'Ilse' });
    watch(host, 'host');
    await until(() => host.room && host.code, 'kamer');
    const code = host.code;
    const ws = [];
    for (const id of ['playerA1', 'playerB1']) {
      const w = new WebSocket(`${base.replace('http', 'ws')}/rooms/${code}/ws`);
      await new Promise((r) => { w.onopen = r; });
      w.send(JSON.stringify({ t: 'hello', v: V, code, id, name: id }));
      ws.push(w);
    }
    await until(() => host.room.players.length === 2, 'spelers');
    host.setSettings({ game: 'bingo', size: 3 });
    await until(() => host.room.settings.game === 'bingo', 'bingo');
    host.start(cards);
    for (let round = 1; round <= 3; round++) {
      await until(() => host.room?.phase === 'answering' && host.room.game.round === round, `ronde ${round}`);
      host.reveal();
      await until(() => host.room.phase === 'revealed', 'onthuld');
      host.next();
    }
    await until(() => host.room?.phase === 'answering' && host.room.game.round === 4, 'ronde 4');
    // "reload": this session goes, a new one resumes from the stored identity
    host.destroy();
    const again = S.createServerHostSession();
    let firstAnswering = null;
    again.subscribe(() => { if (!firstAnswering && again.room?.phase === 'answering') firstAnswering = { round: again.room.game.round, song: again.currentSong()?.id }; });
    watch(again, 'herladen');
    assert.equal(again.resume(), true);
    await until(() => firstAnswering, 'herladen: ronde');
    assert.deepEqual(firstAnswering, { round: 4, song: srv.core.rooms.get(code).state.room.game.current }, 'de eerste toestand na herladen heeft het lopende nummer');
    again.destroy();
    for (const w of ws) w.close();
    assert.deepEqual(problems, []);
    assert.ok(checked >= 8, `genoeg toestanden gecontroleerd (${checked})`);
  } finally {
    await srv.close();
  }
});
