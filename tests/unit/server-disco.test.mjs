// Discobingo on the room server (server/core.mjs + room.mjs), with fake sockets and a fake
// clock: per-recipient views, the stamp and judge messages, the no-peeking guarantee (no
// song data and no other player's answer in any message to a player before the reveal),
// protocol version 5, rooms stored by earlier versions, the mix threshold, the bingo stop
// (continue / finish), the automatic reveal on the server's clock (hold) and the chip states.
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
// years never end in 0 or 9 (kept from the decade era: a year must never hide in any label)
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
  if (d.cat === 'exact') return { guess: i === 0 ? song.year : song.year + 1 };
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
  assert.ok(['exact', 'artist', 'year', 'title'].includes(d.cat), 'de categorie is openbaar');
  assert.equal(d.spin, 1);
  assert.equal(d.spunAt, a.last('state').meta.now, 'servertijd van de draai (meta.now voor het klokverschil)');
  assert.equal(d.spinMs, 4000);
  assert.equal(d.decades, undefined, 'geen decennia meer');
  assert.equal(V, 5, 'protocol 5: "Exact jaar", de bingostop, het automatische resultaat');
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
        // (an exact year Anouk typed herself, right, comes back to her only)
        if (i !== 0 || view.game.disco.cat !== 'exact') assert.ok(!new RegExp(`\\b${song.year}\\b`).test(text), `ronde ${round}: geen jaar`);
        else assert.ok(!new RegExp(`\\b${song.year}\\b`).test(text.replace(`"answer":{"guess":${song.year}}`, '')), `ronde ${round}: geen jaar buiten het eigen antwoord`);
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
    const bingo = players[0].view().game.disco.bingo;
    if (bingo) { host.send(bingo.next.length ? { t: 'continue', win: bingo.next[0] } : { t: 'finish' }); await flush(); }
    if (players[0].view().phase !== 'answering') break;
  }
  assert.ok(typed >= 2, 'er zaten getypte rondes bij');
});

test('disco: hold, continue en finish zijn geldige berichten, alleen voor de spelleider', () => {
  for (const m of [{ t: 'hold', round: 1 }, { t: 'continue', win: 'line2' }, { t: 'finish' }]) {
    assert.ok(parseClientMessage(JSON.stringify(m)), m.t);
    assert.ok(LEADER_TYPES.includes(m.t), `${m.t} alleen de spelleider`);
  }
});

/** Everybody answers (Anouk right); returns the song. */
async function allAnswer(host, players, { except = [] } = {}) {
  const song = host.last('state').lead.song;
  const view = players[0].view();
  for (const [i, p] of players.entries()) if (!except.includes(i)) p.send({ t: 'answer', round: view.game.round, answer: answerFor(view, song, i) });
  await flush();
  return song;
}

test('disco: automatisch naar het resultaat: 4 s na het laatste antwoord, gedeeld moment, stopt vanzelf, Wacht nog', async () => {
  const { core, advance, now } = setup();
  const { code, host, players: [a, b, c] } = await discoRoom(core);
  const hub = core.rooms.get(code);
  advance(5000); // the ball has landed
  await allAnswer(host, [a, b, c], { except: [2] });
  assert.equal(a.view().game.disco.autoAt, null, 'Cas nog niet');
  c.send({ t: 'answer', round: 1, answer: { pass: true } });
  await flush();
  const at = a.view().game.disco.autoAt;
  assert.equal(at, now() + 4000, 'vier seconden na het laatste antwoord');
  assert.equal(a.view().game.disco.autoMs, 4000);
  for (const p of [b, c]) assert.equal(p.view().game.disco.autoAt, at, 'hetzelfde moment op elke telefoon');
  assert.equal(host.last('state').lead.spectator.game.disco.autoAt, at, 'en bij de spelleider / tv');
  assert.equal(hub.nextTick(), at, 'het alarm (Cloudflare) staat op dat moment');
  // changing an answer restarts nothing
  advance(1000);
  b.send({ t: 'answer', round: 1, answer: { pass: true } });
  await flush();
  assert.equal(a.view().game.disco.autoAt, at);
  // a withdrawn answer stops it; answering again starts a fresh countdown
  c.send({ t: 'withdraw' });
  await flush();
  assert.equal(a.view().game.disco.autoAt, null);
  c.send({ t: 'answer', round: 1, answer: { pass: true } });
  await flush();
  const at2 = a.view().game.disco.autoAt;
  assert.equal(at2, now() + 4000);
  // not yet ... then the tick reveals, exactly once
  advance(3999);
  hub.tick();
  await flush();
  assert.equal(a.view().phase, 'answering');
  advance(1);
  hub.tick();
  await flush();
  assert.equal(a.view().phase, 'revealed', 'vanzelf onthuld, net als Onthul');
  assert.equal(a.view().game.reveal.mine.verdict, 'right');
  const round = a.view().game.round;
  hub.tick();
  await flush();
  assert.equal(a.view().game.round, round, 'nooit twee keer');
  host.send({ t: 'reveal' });
  await flush();
  assert.equal(host.last('error').code, 'phase', 'Onthul daarna: er valt niets meer te onthullen');
  // round 2: "Wacht nog" stops it for this round only
  host.send({ t: 'next' });
  await flush();
  if (a.view().game.disco.bingo) { host.send({ t: 'continue', win: 'line2' }); await flush(); }
  advance(5000);
  await allAnswer(host, [a, b, c]);
  assert.ok(a.view().game.disco.autoAt);
  a.send({ t: 'hold', round: a.view().game.round });
  await flush();
  assert.equal(a.last('error').code, 'notleader');
  host.send({ t: 'hold', round: a.view().game.round });
  await flush();
  assert.equal(a.view().game.disco.autoAt, null);
  assert.equal(a.view().game.disco.autoHeld, true);
  advance(8000);
  hub.tick();
  await flush();
  assert.equal(a.view().phase, 'answering', 'Wacht nog: de spelleider onthult zelf');
  host.send({ t: 'reveal' });
  await flush();
  assert.equal(a.view().phase, 'revealed');
  // "Wacht nog" tapped just after the reveal (same round, phase already revealed): no error toast
  const errorsBefore = host.msgs.filter((m) => m.t === 'error').length;
  host.send({ t: 'hold', round: a.view().game.round });
  await flush();
  assert.equal(host.msgs.filter((m) => m.t === 'error').length, errorsBefore, 'te laat voor Wacht nog: stil genegeerd');
  assert.equal(a.view().phase, 'revealed');
});

test('disco: automatisch resultaat stopt als iemand zonder antwoord (terug)komt; afwezig telt niet; uit in de lobby', async () => {
  const { core, advance } = setup();
  const { code, host, players: [a, b, c] } = await discoRoom(core);
  const hub = core.rooms.get(code);
  advance(5000);
  // Cas goes away: Anouk and Bram answering is everybody
  c.conn.closed();
  await flush();
  await allAnswer(host, [a, b], {});
  const at = a.view().game.disco.autoAt;
  assert.ok(at, 'wie weg is, wordt niet afgewacht');
  // Cas comes back without an answer: the countdown stops
  const c2 = connect(core, code);
  c2.send({ t: 'hello', v: V, code, id: 'playerC1', token: c.last('welcome').token });
  await flush();
  assert.equal(c2.view().game.disco.autoAt, null);
  assert.equal(a.view().game.disco.autoAt, null);
  advance(10000);
  hub.tick();
  await flush();
  assert.equal(a.view().phase, 'answering');
  // the leader goes away: the server reveals by itself all the same (the reveal never waits for a phone)
  c2.send({ t: 'answer', round: 1, answer: { pass: true } });
  await flush();
  host.conn.closed();
  await flush();
  advance(4000);
  hub.tick();
  await flush();
  assert.equal(a.view().phase, 'revealed', 'ook als de spelleider even weg is');
  // the lobby setting off: no countdown at all
  const { core: core2, advance: adv2 } = setup();
  const r2 = await discoRoom(core2, { settings: { autoReveal: false } });
  adv2(5000);
  await allAnswer(r2.host, r2.players);
  assert.equal(r2.players[0].view().settings.autoReveal, false);
  assert.equal(r2.players[0].view().game.disco.autoAt, null);
});

test('disco: het automatische resultaat overleeft een slapend / herladen Durable Object (opgeslagen moment, alarm)', async () => {
  const { core, advance, now } = setup();
  const { code, host, players } = await discoRoom(core);
  const hub = core.rooms.get(code);
  advance(5000);
  await allAnswer(host, players);
  const at = hub.state.room.game.disco.autoAt;
  assert.equal(at, now() + 4000);
  // the object hibernates: only the stored state and the open connections come back
  const stored = JSON.parse(JSON.stringify(hub.snapshot()));
  const conns = [...hub.conns].map(([connId, c2]) => ({ connId, mid: c2.mid, lastSeen: now() }));
  let t = now();
  const sent = [];
  const fresh = new RoomHub(code, { now: () => t, send: (id, text) => sent.push(text) });
  fresh.load(stored, conns);
  assert.equal(fresh.nextTick(), at, 'het alarm vindt het moment terug');
  t = at;
  fresh.tick();
  assert.equal(fresh.state.room.phase, 'revealed', 'het alarm onthult');
  t += 10;
  fresh.tick();
  assert.equal(fresh.state.room.phase, 'revealed');
  assert.equal(fresh.state.room.game.round, 1);
});

test('disco: bingo stopt het spel meteen; doorgaan voor 2 lijnen, dan een volle kaart, dan de prijsuitreiking', async () => {
  const { core, advance } = setup();
  const { code, token, host, players: [a, b, c] } = await discoRoom(core);
  const hub = core.rooms.get(code);
  const scr = connect(core, code);
  scr.send({ t: 'hello', v: V, code, screen: true });
  await flush();
  // give Anouk four squares of a line through an open square of the round's colour
  const room = hub.state.room;
  const cat = room.game.disco.cat;
  const card = room.game.per.playerA1.card;
  const { LINES } = await import('../../app/js/multi/disco.js');
  const line = LINES.find((l) => l.some((i) => card[i] === cat));
  const sq = line.find((i) => card[i] === cat);
  const marks = room.game.per.playerA1.marks.map((m, i) => (line.includes(i) && i !== sq ? '*' : m));
  hub.state.room = { ...room, game: { ...room.game, per: { ...room.game.per, playerA1: { ...room.game.per.playerA1, marks } } } };
  advance(5000);
  await allAnswer(host, [a, b, c]);
  host.send({ t: 'reveal' });
  await flush();
  assert.equal(scr.view().game.disco.bingo, null);
  const chips = host.last('state').lead.spectator.game.disco.chips;
  assert.deepEqual(chips.map((x) => [x.name, x.state]), [['Anouk', 'choosing']], 'de spelleider ziet wie nog kiest');
  a.send({ t: 'stamp', round: 1, index: sq });
  await flush();
  for (const v of [scr.view(), a.view(), b.view(), host.last('state').lead.spectator]) {
    assert.equal(v.game.disco.bingo.winners[0].name, 'Anouk', 'bingo meteen op elk scherm');
    assert.deepEqual(v.game.disco.bingo.next, ['line2', 'full']);
  }
  assert.deepEqual(scr.view().game.disco.bingo.winners[0].cells, [...line].sort((x, y) => x - y), 'de winnende lijn op de tv');
  assert.equal(scr.view().game.disco.chips[0].state, 'placed');
  // the chip is final; no next song until the leader decides
  a.send({ t: 'stamp', round: 1, index: null });
  await flush();
  assert.equal(a.last('error').code, 'final');
  host.send({ t: 'next' });
  await flush();
  assert.equal(host.last('error').code, 'bingo');
  b.send({ t: 'continue', win: 'line2' });
  await flush();
  assert.equal(b.last('error').code, 'notleader');
  host.send({ t: 'continue', win: 'line1' });
  await flush();
  assert.equal(host.last('error').code, 'answer');
  // a backup during the stop: a restored server shows the same stop
  const snap = host.last('backup').snap;
  const core2 = createRoomServer({ now: () => 9_000_000 });
  const res = core2.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '1', body: JSON.stringify({ v: V, id: 'owner01', token, snap }) });
  assert.equal(res.status, 200);
  assert.ok(G.inBingoStop(core2.rooms.get(code).state.room), 'na een herstart van de server staat de bingo er nog');
  host.send({ t: 'continue', win: 'line2' });
  await flush();
  assert.equal(a.view().phase, 'answering');
  assert.equal(a.view().game.disco.win, 'line2');
  assert.equal(a.view().settings.win, 'line1');
  assert.deepEqual(a.view().game.disco.stages, [{ win: 'line1', ids: ['playerA1'], names: ['Anouk'], round: 1 }]);
  assert.equal(scr.view().game.disco.bingo, null);
  // to the end: Anouk always right, the automatic chips; on every bingo go on, then stop
  for (let round = 2; round < 40 && a.view().phase !== 'won'; round++) {
    advance(5000);
    await allAnswer(host, [a, b, c]);
    host.send({ t: 'reveal' });
    await flush();
    host.send({ t: 'next' });
    await flush();
    const bingo = scr.view().game.disco.bingo;
    if (bingo) { host.send(bingo.next.length ? { t: 'continue', win: bingo.next[0] } : { t: 'finish' }); await flush(); }
  }
  assert.equal(a.view().phase, 'won');
  const st = scr.view().game.disco.stages;
  assert.deepEqual(st.map((x) => x.win), ['line1', 'line2', 'full'], 'drie etappes');
  assert.ok(scr.view().game.disco.awards.length > 0);
  assert.ok(scr.view().game.winners.includes('Anouk'));
});

test('disco: een spel van vóór "Exact jaar" (Decennium) gaat netjes terug naar de lobby, ook uit een back-up', async () => {
  const { core } = setup();
  const { code, token, host } = await discoRoom(core);
  const snap = host.last('backup').snap;
  const old = JSON.parse(JSON.stringify(snap));
  const g = old.room.game;
  for (const s of Object.values(g.per)) s.card = s.card.map((k) => (k === 'exact' ? 'decade' : k));
  g.disco.decades = [1960, 1970];
  // the stored state of the Durable Object (or the Node accounts file)
  const state = migrateState({ v: 1, code, createdAt: 1, lastActive: 1, claimed: true, ownerId: 'owner01', ownerName: 'Ilse', leaderId: 'owner01', leaderAwaySince: 1, members: old.members, room: old.room });
  assert.equal(state.room.phase, 'lobby');
  assert.equal(state.room.game, null);
  assert.equal(state.room.players.length, old.room.players.length, 'de spelers blijven');
  assert.ok(G.isValidRoom(state.room));
  // the owner's backup after a server restart: restored, in the lobby
  const core2 = createRoomServer({ now: () => 1 });
  const res = core2.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '1', body: JSON.stringify({ v: V, id: 'owner01', token, snap: old }) });
  assert.equal(res.status, 200);
  assert.equal(core2.rooms.get(code).state.room.phase, 'lobby');
  // an old app (protocol 4) against this server: the clear "ververs de pagina"
  const p = connect(core, code);
  p.send({ t: 'hello', v: 4, code, id: 'playerZ1', name: 'Oud' });
  await flush();
  assert.equal(p.last('error').code, 'version');
  assert.match(p.last('error').message, /Ververs de pagina/);
  const created = http(core, 'POST', '/rooms', { v: 4, id: 'owner02', name: 'Oud', settings: { game: 'disco' } });
  assert.notEqual(created.status, 201, 'een oude app maakt geen kamer');
});

test('disco: stamp en judge zijn geldige berichten; judge is alleen voor de spelleider', () => {
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

const PROTO_IDS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const roomState = (core, code) => JSON.stringify(core.rooms.get(code).snapshot());

test('disco: player ids als "__proto__" / "constructor" veranderen niets en laten de server leven', async () => {
  const { core } = setup();
  const { code, host, players: [a] } = await discoRoom(core);
  const song = host.last('state').lead.song;
  a.send({ t: 'answer', round: 1, answer: { decade: Math.floor(song.year / 10) * 10, guess: String(song.year), text: song.title } });
  await flush();
  host.send({ t: 'reveal' });
  await flush();
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  try {
    for (const pid of PROTO_IDS) {
      const before = roomState(core, code);
      for (const m of [{ t: 'judge', pid, ok: true }, { t: 'judge', pid, ok: false }, { t: 'override', pid }, { t: 'remove', pid }]) {
        host.send(m);
        await flush();
        assert.equal(roomState(core, code), before, `${m.t} ${pid}: kamer onveranderd`);
      }
      assert.equal(host.last('error')?.code, 'answer', `${pid}: geweigerd als speler zonder antwoord`);
      // such an id can not join either
      const p = connect(core, code);
      p.send({ t: 'hello', v: V, code, id: pid, name: 'X' });
      await flush();
      assert.ok(p.last('error'), `hello als ${pid} geweigerd`);
      assert.equal(roomState(core, code), before);
      a.send({ t: 'stamp', round: 1, index: pid });
      a.send({ t: 'answer', round: 1, answer: { [pid]: 1 } });
      a.send({ t: 'mix-add', tracks: { [pid]: 1 } });
      await flush();
    }
  } finally { console.error = orig; }
  assert.deepEqual(errors, [], 'geen onverwachte fout op de server');
  // still alive: a normal judgement and the next round work
  host.send({ t: 'judge', pid: 'playerB1', ok: true });
  await flush();
  host.send({ t: 'next' });
  await flush();
  assert.equal(a.view().phase, 'answering');
  assert.equal(a.view().game.round, 2);
});

test('disco: een fout buiten de spelregels zet de kamer terug, wordt niet bewaard en de server blijft leven', async () => {
  const { core } = setup();
  const { code, host, players: [a] } = await discoRoom(core);
  const hub = core.rooms.get(code);
  const before = roomState(core, code);
  const logs = [];
  const orig = console.error;
  console.error = (...x) => logs.push(x.join(' '));
  try {
    // a bug in a handler: it changes the state and then throws
    const action = hub.action;
    hub.action = function broken() { this.state.room = { ...this.state.room, phase: 'kapot' }; throw new TypeError('boem'); };
    a.send({ t: 'withdraw' });
    await flush();
    hub.action = action;
    assert.equal(roomState(core, code), before, 'teruggezet');
    assert.equal(a.last('error').code, 'bad');
    // a handler that leaves a state no view can render: also rolled back
    hub.action = function poison() { const g = this.state.room.game; this.state.room = { ...this.state.room, game: { ...g, per: { ...g.per, playerA1: { card: null } } } }; this.changed(); };
    a.send({ t: 'withdraw' });
    await flush();
    hub.action = action;
    assert.equal(roomState(core, code), before, 'niet te tonen stand: teruggezet');
    // a broken state that is already there: the broadcast logs instead of throwing
    const good = hub.state.room;
    hub.state.room = { ...good, game: { ...good.game, per: { ...good.game.per, playerA1: { card: null } } } };
    hub.changed();
    await flush();
    hub.state.room = good;
  } finally { console.error = orig; }
  assert.ok(logs.some((l) => /rolled back/.test(l)));
  assert.ok(logs.some((l) => /failed/.test(l)));
  host.send({ t: 'reveal' });
  await flush();
  assert.equal(a.view().phase, 'revealed', 'de kamer speelt gewoon verder');
});

test('disco: willekeurige kapotte berichten van spelleider en spelers gooien nooit een fout', async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const vals = [0, 1, 12, 24, 25, -1, 1.5, NaN, null, true, false, '', 'x', '1980', ...PROTO_IDS, 'playerA1', 'playerB1', 'owner01', '!spectator',
    [], [1], {}, { decade: 1980 }, { guess: '1985' }, { text: 'abc' }, { pass: true }, { text: { a: 1 } }, { decade: '1980' }, 'a'.repeat(3000), 1e9,
    'line1', 'line2', 'full', { autoReveal: false }];
  const types = ['answer', 'withdraw', 'settings', 'reveal', 'override', 'next', 'lobby', 'remove', 'lead', 'playing', 'stamp', 'judge', 'mix-add', 'mix-clear', 'start', 'hold', 'continue', 'finish'];
  const logs = [];
  const orig = console.error;
  console.error = (...x) => logs.push(x.join(' '));
  try {
    for (let run = 0; run < 6; run++) {
      const { core } = setup();
      const { host, players } = await discoRoom(core);
      const conns = [host, ...players];
      for (let i = 0; i < 200; i++) {
        const c = pick(conns);
        const m = { t: pick(types) };
        for (const k of ['round', 'answer', 'pid', 'ok', 'index', 'patch', 'tracks', 'win']) if (rnd() < 0.5) m[k] = pick(vals);
        if ((m.t === 'stamp' || m.t === 'answer') && rnd() < 0.7) m.round = c.last('state')?.view?.game?.round ?? 1;
        if (m.t === 'remove' || m.t === 'lobby' || m.t === 'start') { if (rnd() < 0.8) continue; }
        c.send(m);
        if (rnd() < 0.2) host.send({ t: pick(['reveal', 'next']) });
        if (rnd() < 0.1) await flush();
      }
      await flush();
      for (const c of conns) assert.ok(c.last('state'), 'elke telefoon heeft een stand');
    }
  } finally { console.error = orig; }
  assert.deepEqual(logs, [], 'alleen gewone weigeringen (GameError), nooit een andere fout');
});

test('disco: een vervalste back-up met een kapotte kaart of keuze wordt niet teruggezet', async () => {
  const { core } = setup();
  const { code, token, host } = await discoRoom(core);
  const snap = host.last('backup').snap;
  assert.ok(G.isValidRoom(snap.room));
  const forge = (fn) => { const s = JSON.parse(JSON.stringify(snap)); fn(s.room.game); return s; };
  const bad = [
    forge((g) => { g.per.playerA1.card[0] = 'nonsense'; }),
    forge((g) => { g.per.playerA1.marks = g.per.playerA1.marks.slice(0, 24); }),
    forge((g) => { g.per.playerA1.marks[0] = { x: 1 }; }),
    forge((g) => { g.disco.choices = { playerA1: 99 }; }),
    forge((g) => { g.disco.choices = JSON.parse('{"__proto__": 3}'); }),
    forge((g) => { g.per = JSON.parse(JSON.stringify(g.per).replace('"playerA1"', '"__proto__"')); }),
    forge((g) => { g.disco.cat = 'nope'; }),
    forge((g) => { g.disco.win = 'all'; }),
  ];
  for (const s of bad) {
    assert.equal(G.isValidRoom(s.room), false);
    const core2 = createRoomServer({ now: () => 1 });
    const res = core2.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '1', body: JSON.stringify({ v: V, id: 'owner01', token, snap: s }) });
    assert.equal(res.status, 400);
  }
  const core3 = createRoomServer({ now: () => 1 });
  const ok = core3.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '1', body: JSON.stringify({ v: V, id: 'owner01', token, snap }) });
  assert.equal(ok.status, 200, 'de echte back-up wel');
});
