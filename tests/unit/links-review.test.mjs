// Fixes from the review of the Spotify links: the room's per-link usage (linkUse) never goes
// stale and stays bounded; meta.play follows the phone that actually plays (the leader, also
// after a take-over); a guest's playlist part follows a change of meta.play (tops up the
// fragments, or shares the songs it had held back); link names drop every invisible character
// and are cut by code point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub } from '../../server/room.mjs';
import { resetPrepared } from '../../server/prepared.mjs';
import { SERVER_PROTOCOL_VERSION } from '../../app/js/multi/server-protocol.js';
import { createListShare } from '../../app/js/multi/mix-lists.js';
import { cleanLinkName, LINK_NAME_MAX } from '../../app/js/spotify-links.js';
import { seededRandom } from '../../app/js/logic.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const L1 = '11111111111111111111111111111111';
const L2 = '22222222222222222222222222222222';
const flush = () => new Promise((r) => setTimeout(r, 20));
const http = (core, method, path, body) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', body: body == null ? '' : JSON.stringify(body) });
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const p = { msgs: [] };
  p.conn = up.attach({ send: (text) => { if (text !== 'pong') p.msgs.push(JSON.parse(text)); }, close: () => {} });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...p.msgs].reverse().find((m) => m.t === t) || null;
  return p;
}
function setup() {
  let t = 5_000_000;
  const core = createRoomServer({ now: () => t });
  const { code, token } = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings: { game: 'disco', music: 'mix' } }).body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: L1, links: [{ id: L1, name: 'familie' }, { id: L2, name: '' }], play: 'spotify' });
  return { core, code, token, host, hub: core.rooms.get(code), advance: (ms) => { t += ms; } };
}
const join = async (core, code, id) => { const p = connect(core, code); p.send({ t: 'hello', v: V, code, id, name: id }); await flush(); return p; };

/* ---------- linkUse ---------- */

test('linkUse: weg met het lid (verlaten, verwijderd), leeg na het hergebruiken van een klaargezette kamer, begrensd en opgeschoond bij het laden', async () => {
  const { core, code, host, hub } = setup();
  const a = await join(core, code, 'anouk001');
  const b = await join(core, code, 'bram0001');
  a.send({ t: 'link', i: 0 });
  b.send({ t: 'link', i: 1 });
  await flush();
  assert.deepEqual(host.last('state').meta.linkUse, [1, 1]);
  a.send({ t: 'leave' });
  host.send({ t: 'remove', pid: 'bram0001' });
  await flush();
  assert.deepEqual(hub.state.linkUse, {}, 'who left or was removed is not kept');
  // a reused prepared room: last week's guest comes back and must report again
  const c = await join(core, code, 'cas00001');
  c.send({ t: 'link', i: 0 });
  await flush();
  hub.state.prepared = { name: 'Feest', hostPlays: false, music: 'mix' };
  resetPrepared(hub);
  assert.deepEqual(hub.state.linkUse, {}, 'reset: no counts of the previous party');
  const c2 = await join(core, code, 'cas00001');
  assert.equal(c2.last('state').meta.myLink, null, 'the phone is not told it reported already');
  // join / report / leave with fresh ids: the stored record does not grow
  for (let i = 0; i < 40; i++) {
    const p = await join(core, code, `gast${String(i).padStart(4, '0')}`);
    p.send({ t: 'link', i: i % 2 });
    p.send({ t: 'leave' });
  }
  await flush();
  assert.ok(Object.keys(hub.state.linkUse).length <= 1, `bounded (${Object.keys(hub.state.linkUse).length})`);
  // a stored record of before (stale ids, too many): pruned to the members on load
  const snap = JSON.parse(JSON.stringify(hub.snapshot()));
  snap.linkUse = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`oud${String(i).padStart(5, '0')}`, L1]));
  snap.linkUse.cas00001 = L2;
  const again = new RoomHub(code, {});
  again.load(snap);
  assert.deepEqual(again.state.linkUse, { cas00001: L2 });
});

/* ---------- meta.play follows the phone that plays ---------- */

test('meta.play: de telefoon die speelt (de spelleider), ook na het overnemen; een speler kan de links niet zetten', async () => {
  const { core, code, host, hub, advance } = setup();
  const a = await join(core, code, 'anouk001');
  assert.equal(a.last('state').meta.play, 'spotify');
  // the owner switches to fragments in the lobby (links message without a list change)
  host.send({ t: 'links', links: [{ id: L1, name: 'familie' }, { id: L2, name: '' }], play: 'preview' });
  await flush();
  assert.equal(a.last('state').meta.play, 'preview');
  // a player may not set the links nor the way of playing while he does not lead
  a.send({ t: 'links', links: [{ id: L2 }], play: 'spotify' });
  await flush();
  assert.equal(a.last('error')?.code, 'notleader');
  assert.equal(a.last('state').meta.play, 'preview');
  // a game runs (a take-over needs one), the owner goes away, Anouk takes the lead
  hub.state.room = { ...hub.state.room, settings: { ...hub.state.room.settings, music: 'deck' } };
  host.send({ t: 'start', cards: Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 10}`, year: 1961 + i, title: `T${i}`, artist: `A${i}`, previewUrl: `https://example.invalid/${i}.m4a` })), seed: 3 });
  await flush();
  host.conn.closed();
  advance(31000);
  a.send({ t: 'lead' });
  await flush();
  assert.equal(hub.state.leaderId, 'anouk001');
  // Anouk's phone (now a host session) says hello with ITS way of playing: Spotify
  const a2 = connect(core, code);
  a2.send({ t: 'hello', v: V, code, id: 'anouk001', token: a.last('welcome').token, links: [{ id: L2 }], play: 'spotify' });
  await flush();
  const b = await join(core, code, 'bram0001');
  assert.equal(b.last('state').meta.play, 'spotify', 'the leader\'s phone plays: its way counts');
  assert.deepEqual(b.last('state').meta.spotifyLinks.map((l) => l.id), [L1, L2], 'the links stay the owner\'s');
  // Anouk's phone changes to fragments: her links message counts for play only
  a2.send({ t: 'links', links: [{ id: L2 }], play: 'preview' });
  await flush();
  assert.equal(b.last('state').meta.play, 'preview');
  assert.deepEqual(b.last('state').meta.spotifyLinks.map((l) => l.id), [L1, L2]);
});

test('meta.play: de eigenaar neemt de leiding terug: weer zijn eigen manier van spelen', async () => {
  const { core, code, token, host, hub, advance } = setup();
  const a = await join(core, code, 'anouk001');
  hub.state.room = { ...hub.state.room, settings: { ...hub.state.room.settings, music: 'deck' } };
  host.send({ t: 'start', cards: Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 10}`, year: 1961 + i, title: `T${i}`, artist: `A${i}`, previewUrl: `https://example.invalid/${i}.m4a` })), seed: 3 });
  await flush();
  host.conn.closed();
  advance(31000);
  a.send({ t: 'lead' });
  await flush();
  const a2 = connect(core, code);
  a2.send({ t: 'hello', v: V, code, id: 'anouk001', token: a.last('welcome').token, play: 'preview' });
  await flush();
  assert.equal(a2.last('state').meta.play, 'preview');
  const h2 = connect(core, code);
  h2.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: L1, links: [{ id: L1, name: 'familie' }, { id: L2, name: '' }], play: 'spotify' });
  h2.send({ t: 'lead' });
  await flush();
  assert.equal(hub.state.leaderId, 'owner01');
  assert.equal(a2.last('state').meta.play, 'spotify');
});

/* ---------- the guest's playlist part follows meta.play ---------- */

const spid = (n) => `sp${String(n).padStart(20, '0')}`;
function memStore() {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; }, remove: (k) => m.delete(k) };
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 2)); } };
/** A room that behaves like the server: duplicates are ignored, mix-clear empties. */
function fakeRoom(play) {
  const s = { online: true, room: [], adds: 0, meta: { mix: { mine: 0 }, play } };
  const key = (t) => t.spotifyId;
  s.mixAdd = (ts) => { for (const t of ts) { s.adds++; if (!s.room.some((x) => key(x) === key(t))) s.room.push(t); } s.meta.mix.mine = s.room.length; return true; };
  s.mixClear = () => { s.room = []; s.meta.mix.mine = 0; return true; };
  return s;
}
const provider = {
  lists: async () => [{ id: 'own1', title: 'Mijn feest', count: 40 }],
  tracks: async () => Array.from({ length: 40 }, (_, i) => ({ spotifyId: spid(i), title: `Lied ${i}`, artist: `Band ${i}`, year: 1980 + (i % 30), isrc: `NLA01${String(i).padStart(7, '0')}` })),
  errorMessage: () => 'fout',
};
const musicbrainz = { errorMessage: () => 'mb', firstReleaseYear: async (c) => 1970 + (Number(c.slice(5)) % 30), searchFirstReleaseYear: async () => null };

test('playlists van een gast: van Spotify naar fragmenten na het delen: de fragmenten worden aangevuld, nooit dubbel', async () => {
  const apple = async ({ title }) => (title.endsWith('3') ? null : { itunesId: 7, previewUrl: `https://audio-ssl.itunes.apple.com/x/${encodeURIComponent(title)}.m4a` });
  const session = fakeRoom('spotify');
  const store = memStore();
  const mk = () => createListShare({ code: 'PLAY', session, provider, needFragment: () => session.meta.play !== 'spotify', deps: { musicbrainz, apple, store, rand: seededRandom(4), wait: async () => {} } });
  const ls = mk();
  ls.open();
  await until(() => ls.state.choices.length === 1);
  ls.setCount(15);
  ls.add('own1');
  await until(() => ls.state.phase === 'done');
  assert.equal(session.room.length, 15);
  assert.ok(session.room.every((t) => !t.previewUrl), 'Spotify: no fragments looked up');
  // the leader switches to fragments: the next room state tells the phone
  session.meta = { ...session.meta, play: 'preview' };
  ls.sync(session.meta);
  await until(() => ls.state.phase === 'done' && session.room.length === 15 && session.room.every((t) => t.previewUrl));
  assert.ok(session.room.every((t) => t.previewUrl && t.itunesId), 'every song in the room now has a fragment');
  assert.equal(new Set(session.room.map((t) => t.spotifyId)).size, session.room.length, 'never a song twice');
  assert.ok(ls.state.noFragment > 0, 'those without a fragment are left out and counted');
  ls.destroy();
  // back to Spotify: the held-back songs come back (no Apple lookup needed); a new phone object (reload) knows the mode
  const ls2 = mk();
  session.meta = { ...session.meta, play: 'spotify' };
  ls2.setCount(25);
  ls2.sync(session.meta);
  await until(() => ls2.state.phase === 'done' && session.room.length === 25);
  assert.equal(ls2.state.noFragment, 0);
  assert.equal(new Set(session.room.map((t) => t.spotifyId)).size, 25);
  ls2.destroy();
});

test('playlists van een gast: met fragmenten gedeeld, dan Spotify: de achtergehouden nummers worden alsnog gedeeld', async () => {
  const apple = async ({ title }) => (Number(title.split(' ')[1]) % 2 ? null : { itunesId: 9, previewUrl: 'https://audio-ssl.itunes.apple.com/x/y.m4a' });
  const session = fakeRoom('preview');
  const ls = createListShare({ code: 'PLAY2', session, provider, needFragment: () => session.meta.play !== 'spotify', deps: { musicbrainz, apple, store: memStore(), rand: seededRandom(8), wait: async () => {} } });
  ls.open();
  await until(() => ls.state.choices.length === 1);
  ls.setCount(25);
  ls.add('own1');
  await until(() => ls.state.phase === 'done');
  assert.equal(session.room.length, 20, 'only the 20 with a fragment');
  assert.equal(ls.state.noFragment, 20);
  session.meta = { ...session.meta, play: 'spotify' };
  ls.sync(session.meta);
  await until(() => ls.state.phase === 'done' && session.room.length === 25);
  assert.equal(new Set(session.room.map((t) => t.spotifyId)).size, 25, 'topped up, never twice');
  ls.destroy();
});

/* ---------- names ---------- */

test('linknamen: ook U+061C, U+2060–U+2064 en U+00AD eruit; ingekort per teken (geen half emoji)', () => {
  assert.equal(cleanLinkName('fa؜mi⁠l⁡i⁢e⁣⁤­'), 'familie');
  const v = cleanLinkName(`${'a'.repeat(LINK_NAME_MAX - 1)}😀😀`);
  assert.equal([...v].length, LINK_NAME_MAX);
  assert.ok(v.endsWith('😀'), 'the last character is whole');
  assert.ok(!/[\uD800-\uDBFF]$/.test(v), 'no lone surrogate');
  assert.equal(cleanLinkName('😀'.repeat(30)), '😀'.repeat(LINK_NAME_MAX));
});
