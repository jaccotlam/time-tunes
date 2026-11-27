// Several Spotify "links" (Client IDs): the list's validation (app and servers), the "not
// registered" detection, the room server (hello / links / link messages, meta, leader only,
// stored and loaded again), the account data (strict server check, merge with old data),
// tokens per Client ID on the phone (spotify.js), and the guests' Spotify playlists provider
// for the playlist worker (mix-spotify.js + mix-lists.js, with the fragment rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLinks, cleanLinkName, notRegistered, linkCounts, linkCountsText, linkLabel, LINKS_MAX, LINK_NAME_MAX } from '../../app/js/spotify-links.js';
import { createRoomServer } from '../../server/core.mjs';
import { RoomHub, migrateState } from '../../server/room.mjs';
import { validateData } from '../../server/accounts.mjs';
import { mergeAccountData } from '../../app/js/account.js';
import { SERVER_PROTOCOL_VERSION, SERVER_FEATURES, LINKS_FEATURE, parseClientMessage } from '../../app/js/multi/server-protocol.js';
import { spotifyListProvider } from '../../app/js/multi/mix-spotify.js';
import { createListShare } from '../../app/js/multi/mix-lists.js';
import { seededRandom } from '../../app/js/logic.js';

const L1 = '11111111111111111111111111111111';
const L2 = '22222222222222222222222222222222';
const L3 = 'abcdefabcdefabcdefabcdefabcdefab';
const hex = (i) => i.toString(16).padStart(32, '0');

/* ---------- the list ---------- */

test('links: alleen geldige Client IDs, elk één keer, namen kort en gewoon, hooguit 10', () => {
  assert.deepEqual(cleanLinks([{ id: L1.toUpperCase(), name: '  familie  ' }, { id: L2 }]), [{ id: L1, name: 'familie' }, { id: L2, name: '' }]);
  assert.deepEqual(cleanLinks(null), []);
  assert.deepEqual(cleanLinks('x'), []);
  const hostile = cleanLinks([
    null, 5, 'abc', [L1], { id: 'BQDs9xY7-token' }, { id: `secret:${L1}` }, { id: `${L1}0` }, { id: { toString: () => L1 } },
    { id: L1, name: '<img src=x onerror=alert(1)>' }, { id: L1.toUpperCase(), name: 'dubbel' },
    JSON.parse(`{"__proto__": {"id": "${L2}"}, "name": "proto"}`), { id: L3, name: 'a\u0000b\nc‮d​'.repeat(10) },
  ]);
  assert.deepEqual(hostile.map((l) => l.id), [L1, L3], 'tokens, secrets, verkeerde lengte, objecten en __proto__ vallen weg; dubbele tellen één keer');
  assert.ok(!/[<>]/.test(hostile[0].name), 'geen HTML-tekens');
  assert.ok(hostile[1].name.length <= LINK_NAME_MAX && !/[\u0000-\u001f‮​]/.test(hostile[1].name), 'een regel gewone tekst');
  assert.equal(cleanLinks(Array.from({ length: 30 }, (_, i) => ({ id: hex(i + 1) }))).length, LINKS_MAX, 'hooguit 10');
  assert.equal(cleanLinkName('x'.repeat(50)).length, LINK_NAME_MAX);
  assert.equal(cleanLinkName(42), '');
  assert.equal(linkLabel(1, 'vrienden'), 'Link 2 · vrienden');
  assert.equal(linkLabel(0), 'Link 1');
});

test('"staat niet op de lijst": een 403 na het inloggen, behalve Premium of een ontbrekende scope', () => {
  assert.equal(notRegistered({ code: 'not-allowed' }), true);
  assert.equal(notRegistered({ status: 403, detail: { where: 'GET /me', status: 403, message: 'User not registered in the Developer Dashboard' } }), true);
  assert.equal(notRegistered({ status: 403, detail: { where: 'GET /me', status: 403, message: 'Iets heel anders' } }), true, 'de eerste aanroep (GET /me): elke tekst');
  assert.equal(notRegistered({ where: 'GET /me/top/tracks', status: 403, message: 'user may not be registered' }), true, 'de tekst zegt het');
  assert.equal(notRegistered({ status: 403, detail: { where: 'GET /me', status: 403, reason: 'PREMIUM_REQUIRED', message: 'Premium required' } }), false, 'Premium: een ander probleem');
  assert.equal(notRegistered({ status: 403, detail: { where: 'GET /me', status: 403, message: 'The owner of this app needs Premium' } }), false);
  assert.equal(notRegistered({ status: 403, detail: { where: 'GET /me/top/tracks', status: 403, message: 'Insufficient client scope' } }), false, 'een ontbrekende scope: opnieuw toestemming, niet een andere link');
  assert.equal(notRegistered({ status: 403, detail: { where: 'PUT /me/player/play', status: 403, message: 'Forbidden' } }), false);
  assert.equal(notRegistered({ status: 401 }), false);
  assert.equal(notRegistered({ code: 'premium' }), false);
  assert.equal(notRegistered(null), false);
});

test('tellen per link: alleen leden, op Client ID (verschuiven telt goed)', () => {
  const links = [{ id: L1, name: 'familie' }, { id: L2, name: '' }];
  const use = { a: L1, b: L2, c: L2, gone: L1, x: 'onzin' };
  assert.deepEqual(linkCounts(links, use, ['a', 'b', 'c']), [1, 2]);
  assert.deepEqual(linkCounts([links[1], links[0]], use, ['a', 'b', 'c']), [2, 1]);
  assert.deepEqual(linkCounts(links, null), [0, 0]);
  assert.equal(linkCountsText(links, [3, 1]), 'Link 1 · familie: 3 van 5 · Link 2: 1 van 5');
});

/* ---------- the room server ---------- */

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 30));
const http = (core, method, path, body) => core.http({ method, path, origin: ORIGIN, ip: '10.0.0.1', body: body == null ? '' : JSON.stringify(body) });
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const p = { msgs: [], raw: [] };
  p.conn = up.attach({ send: (text) => { p.raw.push(text); p.msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)); }, close: () => {} });
  p.send = (m) => p.conn.message(typeof m === 'string' ? m : JSON.stringify(m));
  p.last = (t) => [...p.msgs].reverse().find((m) => m.t === t) || null;
  return p;
}

test('kamer: de links van de spelleider in de meta, alleen de eigenaar bepaalt ze, tellen per link alleen voor de spelleider', async () => {
  assert.ok(SERVER_FEATURES.includes(LINKS_FEATURE));
  const core = createRoomServer({});
  assert.ok(http(core, 'GET', '/health').body.features.includes('links'), '/health');
  const { code, token } = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', settings: { game: 'bingo', size: 3 } }).body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: L1, links: [{ id: L1, name: 'familie' }, { id: L2.toUpperCase(), name: 'vrienden <b>' }, { id: L1 }, { id: 'nee' }], play: 'preview' });
  await flush();
  const a = connect(core, code);
  a.send({ t: 'hello', v: V, code, id: 'anouk001', name: 'Anouk' });
  const b = connect(core, code);
  b.send({ t: 'hello', v: V, code, id: 'bram0001', name: 'Bram' });
  await flush();
  const m = a.last('state').meta;
  assert.deepEqual(m.spotifyLinks, [{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden b' }], 'gecontroleerd, zonder dubbele');
  assert.equal(m.spotifyClientId, L1, 'en de eerste als spotifyClientId voor oudere telefoons');
  assert.equal(m.play, 'preview');
  assert.equal(m.myLink, null);
  assert.equal('linkUse' in m, false, 'een speler ziet geen tellingen');
  assert.deepEqual(host.last('state').meta.linkUse, [0, 0]);
  // a phone says it logged in through link 2; nonsense is ignored
  b.send({ t: 'link', i: 1 });
  a.send({ t: 'link', i: 7 });
  a.send({ t: 'link', i: '0' });
  a.send({ t: 'link', i: -1 });
  await flush();
  assert.deepEqual(host.last('state').meta.linkUse, [0, 1]);
  assert.equal(b.last('state').meta.myLink, 1, 'de telefoon weet dat de kamer het weet');
  a.send({ t: 'link', i: 0 });
  await flush();
  assert.deepEqual(host.last('state').meta.linkUse, [1, 1]);
  assert.ok(!host.raw.some((r) => r.includes('anouk001') && r.includes('linkUse') && /"linkUse":\{/.test(r)), 'alleen aantallen, nooit wie');
  // a player can not set the links
  a.send({ t: 'links', links: [{ id: L3 }] });
  await flush();
  assert.equal(a.last('error')?.code, 'notleader');
  a.send({ t: 'hello', v: V, code, id: 'anouk001', token: a.last('welcome').token, name: 'Anouk', links: [{ id: L3 }], cid: L3 });
  await flush();
  assert.deepEqual(host.last('state').meta.spotifyLinks.map((l) => l.id), [L1, L2], 'alleen de eigenaar');
  // the owner changes them in the lobby (reordered: the counts follow the Client IDs)
  host.send({ t: 'links', links: [{ id: L2, name: 'vrienden' }, { id: L1, name: 'familie' }, { id: L3, name: 'werk' }], play: 'spotify' });
  await flush();
  const hm = host.last('state').meta;
  assert.deepEqual(hm.spotifyLinks.map((l) => l.id), [L2, L1, L3]);
  assert.deepEqual(hm.linkUse, [1, 1, 0]);
  assert.equal(hm.play, 'spotify');
  assert.equal(hm.spotifyClientId, L2);
  // a player who leaves in the lobby does not count any more
  a.send({ t: 'leave' });
  await flush();
  assert.deepEqual(host.last('state').meta.linkUse, [1, 0, 0]);
  // stored with the room and loaded again (checked again: a hostile stored value is dropped)
  const snap = JSON.parse(JSON.stringify(core.rooms.get(code).snapshot()));
  snap.spotifyLinks.push({ id: 'x"><script>' });
  snap.linkUse.__evil = 'x';
  snap.play = 'deezer';
  const again = new RoomHub(code, {});
  again.load(snap);
  const lm = again.meta('owner01');
  assert.deepEqual(lm.spotifyLinks.map((l) => l.id), [L2, L1, L3]);
  assert.equal(lm.play, null);
  assert.deepEqual(lm.linkUse, [1, 0, 0]);
  // an owner app of before the links (only cid): the list follows that one
  host.send({ t: 'hello', v: V, code, id: 'owner01', token, cid: L3 });
  await flush();
  assert.deepEqual(host.last('state').meta.spotifyLinks, [{ id: L3, name: '' }]);
  // a room stored before the links still loads
  delete snap.spotifyLinks; delete snap.linkUse; delete snap.play;
  const legacy = new RoomHub(code, {});
  legacy.load(migrateState(snap));
  assert.deepEqual(legacy.meta('owner01').spotifyLinks, [{ id: L2, name: '' }], 'oude kamer: de enige Client ID is de enige link');
  assert.ok(parseClientMessage(JSON.stringify({ t: 'link', i: 0 })) && parseClientMessage(JSON.stringify({ t: 'links', links: [] })));
});

/* ---------- the account ---------- */

test('account: Spotify-links streng gecontroleerd door de server', () => {
  assert.deepEqual(validateData({ spotifyLinks: [{ id: L1.toUpperCase(), name: ' familie ' }, { id: L2 }] }).value.spotifyLinks, [{ id: L1, name: 'familie' }, { id: L2, name: '' }]);
  for (const [why, v] of [
    ['geen lijst', { spotifyLinks: 'x' }],
    ['meer dan 10', { spotifyLinks: Array.from({ length: 11 }, (_, i) => ({ id: hex(i + 1) })) }],
    ['dubbel', { spotifyLinks: [{ id: L1 }, { id: L1.toUpperCase() }] }],
    ['token', { spotifyLinks: [{ id: 'BQDs9xY7tokenTokenTokenTokenTokenTokenToken' }] }],
    ['secret erbij', { spotifyLinks: [{ id: L1, secret: 'abc' }] }],
    ['__proto__', JSON.parse(`{"spotifyLinks":[{"id":"${L1}","__proto__":{"x":1}}]}`)],
    ['naam geen tekst', { spotifyLinks: [{ id: L1, name: 5 }] }],
  ]) assert.ok(validateData(v).error, `geweigerd: ${why}`);
});

test('account: samenvoegen van de links, ook met gegevens van vóór de links', () => {
  // an account of before (only the Client ID) and this device with two links: the list goes up
  let m = mergeAccountData({ spotifyClientId: L1, spotifyLinks: [{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }] }, { spotifyClientId: L1 });
  assert.deepEqual(m.remote.spotifyLinks.map((l) => l.id), [L1, L2]);
  assert.equal(m.remoteChanged, true);
  assert.equal(m.localChanged, false);
  // the account has a list: it wins
  m = mergeAccountData({ spotifyClientId: L1 }, { spotifyClientId: L1, spotifyLinks: [{ id: L1, name: 'a' }, { id: L3, name: 'b' }] });
  assert.deepEqual(m.local.spotifyLinks.map((l) => l.id), [L1, L3]);
  assert.equal(m.localChanged, true);
  // one link without a name and an account of before: nothing to save (the account stays as it was)
  m = mergeAccountData({ spotifyClientId: L1 }, { spotifyClientId: L1 });
  assert.equal(m.remoteChanged, false);
  assert.equal(m.localChanged, false);
  // an app of before changed only spotifyClientId in the account: it takes the place of the own link
  m = mergeAccountData({ spotifyClientId: L1, spotifyLinks: [{ id: L1, name: 'familie' }, { id: L2, name: '' }] }, { spotifyClientId: L3 });
  assert.equal(m.local.spotifyClientId, L3);
  assert.deepEqual(m.local.spotifyLinks, [{ id: L3, name: 'familie' }, { id: L2, name: '' }]);
  // the own Client ID is always one of the links
  m = mergeAccountData({}, { spotifyClientId: L2, spotifyLinks: [{ id: L1, name: '' }] });
  assert.ok(m.local.spotifyLinks.some((l) => l.id === L2));
});

/* ---------- tokens per Client ID on the phone ---------- */

test('telefoon: logins per Client ID; wisselen van link gooit geen werkende login weg', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const sp = await import('../../app/js/spotify.js');
  const tok = (cid, at) => ({ access_token: at, refresh_token: 'r', expires_at: Date.now() + 3600e3, scope: 'user-top-read', clientId: cid });
  mem.set('timetunesr.spotify.clientId.v1', JSON.stringify(L1));
  assert.deepEqual(sp.getLinks(), [{ id: L1, name: '' }], 'één Client ID: Link 1');
  sp.setLinks([{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }, { id: L2 }, { id: 'nee' }]);
  assert.deepEqual(sp.getLinks().map((l) => l.id), [L1, L2]);
  assert.equal(sp.ownLinkIndex(), 0);
  sp.setLinks(sp.getLinks(), { own: 1 });
  assert.equal(sp.getClientId(), L2, 'de enkele Client ID volgt de eigen link');
  sp.setLinks(sp.getLinks(), { own: 0 });
  // logged in with link 1; a kept login of link 2 is used (and link 1's kept in turn)
  mem.set('timetunesr.spotify.token.v1', JSON.stringify(tok(L1, 'at-1')));
  mem.set('timetunesr.spotify.tokens.v1', JSON.stringify({ [L2]: tok(L2, 'at-2') }));
  assert.equal(sp.hasClientToken(L2), true);
  assert.equal(sp.useClientToken(L2), true);
  assert.equal(sp.connectedClientId(), L2);
  assert.equal(JSON.parse(mem.get('timetunesr.spotify.tokens.v1'))[L1].access_token, 'at-1', 'de login van link 1 blijft bewaard');
  assert.equal(sp.useClientToken(L3), false, 'geen login voor een andere app: niets verandert');
  assert.equal(sp.connectedClientId(), L2);
  sp.useClientToken(L1);
  assert.equal(sp.connectedClientId(), L1);
  // renaming, removing the own link: the next one becomes the own one
  sp.renameLink(L2, 'nieuw <b>');
  assert.equal(sp.getLinks()[1].name, 'nieuw b');
  sp.setLinks([{ id: L2, name: 'nieuw' }]);
  assert.equal(sp.getClientId(), L2);
  assert.equal(sp.connectedClientId(), L2, 'de bewaarde login van de nieuwe eigen link wordt gebruikt');
  // "Verbreek verbinding": every kept login goes too
  sp.disconnect({ quiet: true });
  assert.equal(mem.has('timetunesr.spotify.tokens.v1'), false);
  assert.equal(sp.isConnected(), false);
  delete globalThis.localStorage;
});

/* ---------- the guests' own Spotify playlists ---------- */

const spid = (n) => `sp${String(n).padStart(20, '0')}`;
const isrc = (n) => `NLA01${String(n).padStart(7, '0')}`;
function memStore() {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; }, remove: (k) => m.delete(k) };
}
function fakeSession(play) {
  const s = { online: true, sent: [], meta: { mix: { mine: 0 }, play } };
  s.mixAdd = (t) => { s.sent.push(...t); s.meta.mix.mine += t.length; return true; };
  s.mixClear = () => { s.sent = []; s.meta.mix.mine = 0; return true; };
  return s;
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 2)); } };

test('Spotify-playlists van een gast: alleen eigen lijsten, verdeeld over de lijsten, gemaximeerd; fragment nodig bij fragmenten', async () => {
  const lists = { own1: 60, collab: 30 };
  const read = [];
  const provider = spotifyListProvider({
    // spotify-playlists.js myPlaylists already filters to own + collaborative lists
    myPlaylists: async () => [{ id: 'own1', name: 'Mijn feest', count: 60, picture: 'https://i.scdn.co/x' }, { id: 'collab', name: 'Samen', count: 30, picture: null }],
    playlistTracks: async (id, { max }) => {
      read.push([id, max]);
      return Array.from({ length: lists[id] }, (_, i) => {
        const n = (id === 'own1' ? 10000 : 20000) + i;
        return { spotifyId: spid(n), title: `Lied ${n}`, artist: `Band ${n}`, album: 'A', spYear: 2020, isrc: isrc(n) };
      });
    },
    errorMessage: () => 'fout',
  });
  const items = await provider.lists();
  assert.deepEqual(items.map((p) => [p.id, p.title, p.count]), [['own1', 'Mijn feest', 60], ['collab', 'Samen', 30]]);
  const t = await provider.tracks('own1', {});
  assert.equal(t[0].year, 2020, 'het jaar van Spotify gaat mee als catalogusjaar');
  assert.ok(read[0][1] >= 2000, 'per lijst gemaximeerd (MAX_TRACKS)');

  const musicbrainz = { errorMessage: () => 'mb', firstReleaseYear: async (c) => 1970 + (Number(c.slice(5)) % 30), searchFirstReleaseYear: async () => null };
  // fragments: Apple Music has every song except those ending in 3
  const asked = [];
  const apple = async ({ title }) => { asked.push(title); return title.endsWith('3') ? null : { itunesId: 1000 + asked.length, previewUrl: `https://audio-ssl.itunes.apple.com/x/${asked.length}.m4a` }; };
  const session = fakeSession('preview');
  const ls = createListShare({ code: 'ABCD', session, provider, needFragment: () => session.meta.play !== 'spotify', deps: { musicbrainz, apple, store: memStore(), rand: seededRandom(3), wait: async () => {} } });
  ls.open();
  await until(() => ls.state.choices.length === 2);
  ls.setCount(25);
  ls.add('own1');
  await until(() => ls.state.phase === 'done' || ls.state.phase === 'checking');
  ls.open();
  await until(() => !ls.state.loading);
  ls.add('collab');
  await until(() => ls.state.phase === 'done');
  assert.equal(ls.state.shared.length, 25);
  assert.ok(session.sent.every((x) => x.previewUrl && x.itunesId && x.checked && x.spotifyId), 'met fragmenten: alleen nummers met een fragment');
  assert.ok(ls.state.noFragment > 0, `zonder fragment weggelaten en geteld (${ls.state.noFragment})`);
  const fromCollab = session.sent.filter((x) => Number(x.spotifyId.slice(2)) >= 20000).length;
  assert.ok(fromCollab >= 10 && fromCollab <= 15, `verdeeld over de lijsten (${fromCollab} van 25 uit de tweede)`);
  ls.destroy();

  // with Spotify playing (meta.play 'spotify') no Apple lookups at all
  asked.length = 0;
  const s2 = fakeSession('spotify');
  const ls2 = createListShare({ code: 'EFGH', session: s2, provider, needFragment: () => s2.meta.play !== 'spotify', deps: { musicbrainz, apple, store: memStore(), rand: seededRandom(5), wait: async () => {} } });
  ls2.open();
  await until(() => ls2.state.choices.length === 2);
  ls2.setCount(15);
  ls2.add('own1');
  await until(() => ls2.state.phase === 'done');
  assert.equal(s2.sent.length, 15);
  assert.equal(asked.length, 0, 'via Spotify: de Spotify-id is genoeg');
  assert.ok(s2.sent.every((x) => !x.previewUrl), 'en geen fragment-adressen');
  ls2.destroy();
});
