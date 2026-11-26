// "Mix van de groep" on the room server (server/room.mjs + core.mjs), without network:
// contributions per player (checked and limited), only counts to the phones, the game
// built from the contributions, withdrawing, leaving, the owner's backup without other
// players' favourites, rooms stored before this feature, and the protocol version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub, migrateState } from '../../server/room.mjs';
import { SERVER_PROTOCOL_VERSION, MAX_SMALL_MESSAGE } from '../../app/js/multi/server-protocol.js';
import { MIX_PER_PLAYER } from '../../app/js/multi/mix.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  let t = 1_000_000;
  return { core: createRoomServer({ now: () => t }), advance: (ms) => { t += ms; } };
}
const http = (core, method, path, body) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', body: body == null ? '' : JSON.stringify(body) });
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const msgs = [];
  const p = { msgs, closed: null, raw: [] };
  p.conn = up.attach({ send: (text) => { p.raw.push(text); msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)); }, close: (c, reason) => { p.closed = { c, reason }; } });
  p.send = (m) => p.conn.message(typeof m === 'string' ? m : JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  return p;
}
async function room(core, { hostPlays = false, settings = { game: 'bingo', size: 3 } } = {}) {
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', hostPlays, settings });
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  await flush();
  return { code, token, host };
}
async function join(core, code, id, name) {
  const p = connect(core, code);
  p.send({ t: 'hello', v: V, code, id, name });
  await flush();
  return p;
}

let n = 0;
const tracks = (who, count, extra = {}) => Array.from({ length: count }, (_, i) => {
  n++;
  return {
    spotifyId: `${who}${String(n).padStart(8, '0')}`.padEnd(22, 'Q').slice(0, 22),
    title: `Geheim ${who} ${i + 1}`, artist: `Band ${who} ${i + 1}`, year: 1960 + i, sure: i % 3 !== 0,
    itunesId: 900000 + n, previewUrl: `https://audio.example/${who}-${i + 1}.m4a`, ...extra,
  };
});
const send = (p, list) => { for (let i = 0; i < list.length; i += 10) p.send({ t: 'mix-add', tracks: list.slice(i, i + 10) }); };
const leaks = (p, titles) => titles.filter((t) => p.raw.some((r) => r.includes(t)));

test('bijdragen: alleen aantallen naar iedereen, nooit titels; controle en limieten', async () => {
  const { core } = setup();
  const { code, host } = await room(core);
  const a = await join(core, code, 'playerA1', 'Anouk');
  const b = await join(core, code, 'playerB1', 'Bram');
  const ta = tracks('A', 12);
  const tb = tracks('B', 8);
  send(a, ta);
  send(b, tb);
  send(b, tb.slice(0, 3)); // sent again after a reconnect: no doubles
  host.send({ t: 'mix-add', tracks: tracks('H', 5) }); // the spelleider may add too
  await flush();
  const meta = (p) => p.last('state').meta.mix;
  assert.deepEqual({ ...meta(host), mine: undefined }, { total: 25, preview: 25, sure: meta(host).sure, contributors: 3, mine: undefined });
  assert.equal(meta(a).mine, 12);
  assert.equal(meta(b).mine, 8);
  assert.equal(meta(host).mine, 5);
  assert.equal(meta(a).total, 25, 'iedereen ziet hetzelfde totaal');
  const all = [...ta, ...tb].map((t) => t.title);
  for (const p of [host, a, b]) assert.deepEqual(leaks(p, all), [], 'geen enkele titel in berichten (ook niet naar de spelleider)');
  assert.deepEqual(leaks(host, ta.map((t) => t.spotifyId)), [], 'ook geen Spotify-id');
  // invalid songs are refused with a message, the rest is added
  a.send({ t: 'mix-add', tracks: [{ spotifyId: 'x', title: 'Kapot', artist: 'Y', year: 1990 }, ...tracks('A', 1)] });
  await flush();
  assert.equal(a.last('error').code, 'mix');
  assert.equal(meta(a).mine, 13);
  // per player at most MIX_PER_PLAYER
  send(a, tracks('A', MIX_PER_PLAYER));
  await flush();
  assert.equal(meta(a).mine, MIX_PER_PLAYER);
  assert.match(a.last('error').message, /maximum/);
  // too big a message is not even read
  a.send({ t: 'mix-add', tracks: tracks('A', 20, { title: 'x'.repeat(900) }) });
  await flush();
  assert.equal(a.last('error').code, 'bad', `bericht groter dan ${MAX_SMALL_MESSAGE} tekens geweigerd`);
  // only after hello
  const stranger = connect(core, code);
  stranger.send({ t: 'mix-add', tracks: tracks('S', 2) });
  assert.equal(stranger.last('error').code, 'bad');
  assert.equal(meta(host).contributors, 3);
});

test('spel uit de groepsmix: te weinig -> uitleg; daarna alleen bijgedragen nummers en niets lekt', async () => {
  const { core } = setup();
  const { code, host } = await room(core, { settings: { game: 'bingo', size: 3 } });
  const a = await join(core, code, 'playerA1', 'Anouk');
  const b = await join(core, code, 'playerB1', 'Bram');
  host.send({ t: 'settings', patch: { music: 'mix' } });
  await flush();
  assert.equal(a.last('state').view.settings.music, 'mix', 'spelers zien welke muziek er gekozen is');
  const ta = tracks('A', 4);
  send(a, ta);
  await flush();
  host.send({ t: 'start', cards: [], seed: 7, play: 'preview' });
  await flush();
  assert.equal(host.last('error').code, 'mix');
  assert.match(host.last('error').message, /nog 6 nodig/);
  assert.equal(host.last('state').view.phase, 'lobby');
  const tb = [...tracks('B', 6), ...tracks('Bx', 3, { previewUrl: undefined, itunesId: undefined })];
  send(b, tb);
  await flush();
  // the leader's own deck is ignored when the mix is chosen
  host.send({ t: 'start', cards: [{ id: 'eigen', year: 1999, title: 'Eigen deck', artist: 'X' }], seed: 7, play: 'preview' });
  await flush();
  const st = host.last('state');
  assert.equal(st.view.phase, 'answering');
  const song = st.lead.song;
  const contributed = new Map([...ta, ...tb].map((t) => [t.spotifyId, t]));
  assert.ok(contributed.has(song.spotifyId), `het nummer komt uit de bijdragen (${song.title})`);
  assert.ok(song.previewUrl || song.itunesId, 'fragment-bron: alleen nummers met een fragment');
  assert.equal(st.lead.room.game.left + 1, 10, '10 speelbare nummers (3 zonder fragment vallen af)');
  // nothing about songs that are not played yet, to anybody
  const unplayed = [...contributed.values()].filter((t) => t.spotifyId !== song.spotifyId).map((t) => t.title);
  for (const p of [host, a, b]) assert.deepEqual(leaks(p, unplayed), [], 'geen titel van een nog niet gespeeld nummer');
  for (const p of [a, b]) assert.deepEqual(leaks(p, [song.title, song.previewUrl]), [], 'het lopende nummer alleen naar de muziektelefoon');
  // reveal: whose favourite it was
  a.send({ t: 'answer', round: 1, answer: { pass: true } });
  host.send({ t: 'reveal' });
  await flush();
  const rv = a.last('state').view.game.reveal.song;
  assert.equal(rv.title, song.title);
  assert.deepEqual(rv.by, [contributed.get(song.spotifyId).title.includes(' A ') ? 'Anouk' : 'Bram']);
  // the backup to the owner holds no favourites: the room in the lobby
  const backup = host.last('backup');
  assert.ok(backup, 'eigenaar krijgt een back-up');
  assert.equal(backup.snap.room.phase, 'lobby');
  assert.equal(backup.snap.room.game, null);
  assert.equal(JSON.stringify(backup).includes(song.title), false);
  assert.equal(backup.snap.mix, undefined);
  // Spotify as the music source: songs without a fragment are fine too
  host.send({ t: 'lobby' });
  await flush();
  host.send({ t: 'start', cards: [], seed: 8, play: 'spotify' });
  await flush();
  assert.equal(host.last('state').lead.room.game.left + 1, 13, 'Spotify-bron: alle 13 nummers');
});

test('intrekken en weggaan: aantallen omlaag, niet gespeelde nummers uit het lopende spel', async () => {
  const { core } = setup();
  const { code, host } = await room(core, { settings: { game: 'timeline', goal: 5 } });
  const a = await join(core, code, 'playerA1', 'Anouk');
  const b = await join(core, code, 'playerB1', 'Bram');
  host.send({ t: 'settings', patch: { music: 'mix' } });
  const ta = tracks('A', 10);
  const tb = tracks('B', 10);
  send(a, ta);
  send(b, tb);
  await flush();
  host.send({ t: 'start', cards: [], seed: 3, play: 'preview' });
  await flush();
  const left = host.last('state').lead.room.game.left;
  assert.equal(left, 20 - 2 - 1, '20 nummers: 2 startkaarten, 1 speelt');
  a.send({ t: 'mix-clear' });
  await flush();
  assert.equal(a.last('state').meta.mix.mine, 0);
  assert.equal(host.last('state').meta.mix.contributors, 1);
  const hub = core.rooms.get(code);
  const g = hub.snapshot().room.game;
  assert.ok(g.pile.every((id) => !g.songs[id].from.includes('playerA1')), 'Anouks niet gespeelde nummers zijn uit de stapel');
  assert.ok(host.last('state').lead.room.game.left < left);
  assert.ok(hub.snapshot().room.game.songs[g.current], 'het lopende nummer blijft');
  // Bram leaves during the game: he keeps his seat, so his part stays in this game
  const pile = hub.snapshot().room.game.pile.slice();
  b.send({ t: 'leave' });
  await flush();
  assert.equal(host.last('state').meta.mix.total, 10);
  assert.deepEqual(hub.snapshot().room.game.pile, pile, 'de stapel blijft zoals hij was');
  // in the lobby a leave withdraws the part (as before)
  host.send({ t: 'lobby' });
  await flush();
  const b2 = connect(core, code);
  b2.send({ t: 'hello', v: V, code, id: 'playerB1', name: 'Bram', token: b.last('welcome').token }); // back on his seat
  await flush();
  assert.ok(b2.last('welcome'));
  b2.send({ t: 'leave' });
  await flush();
  assert.equal(host.last('state').meta.mix.total, 0);
  assert.deepEqual(hub.snapshot().mix, {});
});

test('opgeslagen kamer van vóór de groepsmix werkt verder; herstart zet de bijdragen niet in de back-up', async () => {
  const saved = [];
  const hub = new RoomHub('KMRT', { save: (s) => saved.push(s && JSON.parse(JSON.stringify(s))), send: () => {} });
  hub.create({ ownerId: 'owner01', name: 'Ilse' });
  const old = JSON.parse(JSON.stringify(saved.at(-1)));
  delete old.mix; // the shape of protocol 1
  old.room.settings = { game: 'bingo', size: 4, goal: 10 }; // without `music`
  const fresh = new RoomHub('KMRT', { save: () => {}, send: () => {} });
  fresh.load(old, []);
  assert.deepEqual(fresh.snapshot().mix, {}, 'lege mix erbij');
  assert.equal(migrateState(null), null);
  const meta = fresh.meta('owner01');
  assert.deepEqual(meta.mix, { total: 0, preview: 0, sure: 0, contributors: 0, mine: 0 });
});

test('protocolversie 3 (of hoger): een oudere app (versie 2, of 1) krijgt een nette melding', async () => {
  const { core } = setup();
  assert.ok(V >= 3);
  assert.equal(http(core, 'GET', '/health').body.v, V);
  assert.equal(http(core, 'POST', '/rooms', { v: 2, id: 'owner01' }).status, 409);
  assert.equal(http(core, 'POST', '/rooms', { v: 1, id: 'owner01' }).status, 409);
  const { code } = await room(core);
  const old = connect(core, code);
  old.send({ t: 'hello', v: 2, code, id: 'oldapp12', name: 'Oud' });
  assert.equal(old.last('error').code, 'version');
  assert.match(old.last('error').message, /Ververs/);
});

test('quiz uit de groepsmix: vragen over bijgedragen nummers, foute antwoorden uit de eigen muziek van de spelleider', async () => {
  const { core } = setup();
  const { code, host } = await room(core, { settings: { game: 'quiz', questions: 10, qtype: 'title', think: 20 } });
  const a = await join(core, code, 'playerA1', 'Anouk');
  const b = await join(core, code, 'playerB1', 'Bram');
  host.send({ t: 'settings', patch: { music: 'mix' } });
  const ta = tracks('QA', 8);
  const tb = tracks('QB', 8);
  send(a, ta);
  send(b, tb);
  await flush();
  const deck = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, year: 1970 + i, title: `Eigen deck ${i}`, artist: `Deckband ${i}`, previewUrl: `https://example.invalid/d${i}.m4a` }));
  host.send({ t: 'start', cards: deck, mix: true, seed: 5, play: 'preview' });
  await flush();
  assert.equal(host.last('state').view.phase, 'answering');
  const contributed = new Map([...ta, ...tb].map((t) => [t.title, t]));
  const deckTitles = new Set(deck.map((d) => d.title));
  for (let round = 1; round <= 5; round++) {
    const song = host.last('state').lead.song;
    assert.ok(contributed.has(song.title), `vraag ${round} gaat over een bijgedragen nummer`);
    const q = a.last('state').view.game.quiz;
    assert.equal(q.type, 'title');
    const others = q.options.filter((o) => o !== song.title);
    assert.equal(others.length, 3);
    assert.ok(others.every((o) => deckTitles.has(o)), `foute antwoorden uit de eigen muziek, nooit andermans favorieten (${others})`);
    host.send({ t: 'reveal' });
    await flush();
    assert.deepEqual(a.last('state').view.game.reveal.song.by.length, 1, 'bij de onthulling: wiens favoriet');
    host.send({ t: 'next' });
    await flush();
  }
});

test('Spotify Client ID van de spelleider gaat naar de spelers; vorm gecontroleerd; oude apps blijven werken', async () => {
  const CID = '0123456789abcdef0123456789abcdef';
  const { core } = setup();
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings: { game: 'bingo', size: 3 } });
  const { code, token } = res.body;
  // an older app: no cid in hello; nothing breaks, no Client ID in the room
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  await flush();
  const old = await join(core, code, 'oldapp01', 'Oud');
  assert.equal(old.last('welcome').v, V, 'oude app zonder cid komt gewoon binnen');
  assert.equal(old.last('state').meta.spotifyClientId, null);
  // the owner's (new) app sends its Client ID: everybody gets it
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: CID.toUpperCase() });
  await flush();
  assert.equal(old.last('state').meta.spotifyClientId, CID, 'spelers krijgen de Client ID van de spelleider (kleine letters)');
  assert.equal(host.last('state').meta.spotifyClientId, CID);
  // a player's cid never replaces the owner's
  const p = connect(core, code);
  p.send({ t: 'hello', v: V, code, id: 'playerX1', name: 'X', cid: 'ffffffffffffffffffffffffffffffff' });
  await flush();
  assert.equal(p.last('state').meta.spotifyClientId, CID, 'alleen de spelleider bepaalt de Client ID van de kamer');
  // nonsense is ignored, an older hello (no cid) keeps it, '' clears it
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: '"><img src=x onerror=alert(1)>' });
  await flush();
  assert.equal(old.last('state').meta.spotifyClientId, CID, 'ongeldige vorm genegeerd');
  assert.ok(!old.raw.some((r) => r.includes('onerror')), 'een ongeldige waarde komt bij niemand terecht');
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  await flush();
  assert.equal(old.last('state').meta.spotifyClientId, CID, 'hello zonder cid (oudere app) laat hem staan');
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: '' });
  await flush();
  assert.equal(old.last('state').meta.spotifyClientId, null, 'lege cid: de spelleider heeft er geen (meer)');
  // stored with the room (Cloudflare: Durable Object storage), and a room stored before this feature still loads
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: CID });
  await flush();
  const snap = JSON.parse(JSON.stringify(core.rooms.get(code).snapshot()));
  assert.equal(snap.spotifyClientId, CID, 'opgeslagen bij de kamer');
  const again = new RoomHub(code, {});
  again.load(snap);
  assert.equal(again.meta('oldapp01').spotifyClientId, CID, 'na laden uit de opslag nog steeds doorgegeven');
  delete snap.spotifyClientId;
  delete snap.mix;
  const legacy = new RoomHub(code, {});
  legacy.load(migrateState(snap));
  assert.equal(legacy.meta('oldapp01').spotifyClientId, null, 'oude opgeslagen kamer: geen Client ID, verder werkt alles');
});
