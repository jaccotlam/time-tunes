// "Mix van de groep" from public playlists ("Kies een playlist", no login): the plan a phone
// makes from its chosen Deezer playlists (uniform, spread over the lists), the checked year,
// hostile contributed songs, duplicates by ISRC / Deezer id, the room server (refuses unchecked
// and invalid songs, counts only, a game from deezer-only songs), and the phone's worker
// (multi/mix-lists.js) with a fake Deezer, MusicBrainz, room session and storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadPlan, checkedYear, cleanMixTrack, addToContribution, buildMix, mixStats, contributionTrack,
  MIX_PER_PLAYER, MIX_GAME_MAX, LIST_PLAN_MAX, DEFAULT_LIST_COUNT,
} from '../../app/js/multi/mix.js';
import { createListShare, LISTS_KEY, SPOTIFY_LINK_MESSAGE, SHORT_LINK_MESSAGE, BAD_LINK_MESSAGE } from '../../app/js/multi/mix-lists.js';
import { parsePlaylistId, FEATURED } from '../../app/js/deezer.js';
import { seededRandom } from '../../app/js/logic.js';
import { createRoomServer } from '../../server/core.mjs';
import { SERVER_PROTOCOL_VERSION, SERVER_FEATURES } from '../../app/js/multi/server-protocol.js';

const isrc = (n) => `NLA01${String(n).padStart(7, '0')}`;
const song = (list, i, extra = {}) => ({ deezerId: list * 10000 + i, isrc: isrc(list * 10000 + i), title: `Lied ${list}-${i}`, artist: `Band ${list}-${i}`, album: 'A', readable: true, ...extra });
const listOf = (id, n) => ({ id, tracks: Array.from({ length: n }, (_, i) => song(id, i + 1)) });

/* ---------- the plan ---------- */

test('plan: willekeurig (niet de eerste N), gelijk verdeeld over de lijsten, zonder dubbele', () => {
  const big = listOf(1, 1000);
  const small = listOf(2, 20);
  const plan = spreadPlan([big, small], { rand: seededRandom(3), max: 40 });
  assert.equal(plan.length, 40);
  const first20 = plan.slice(0, 20);
  assert.equal(first20.filter((t) => t.list === 1).length, 10, 'om en om: 10 uit de grote lijst');
  assert.equal(first20.filter((t) => t.list === 2).length, 10, 'en 10 uit de kleine');
  assert.ok(plan.slice(0, 25).filter((t) => t.list === 1).some((t) => t.deezerId % 10000 > 100), 'niet het begin van de grote lijst');
  // a list that runs out leaves the rest to the others
  const after = spreadPlan([big, small], { rand: seededRandom(3), max: 100 });
  assert.equal(after.filter((t) => t.list === 2).length, 20);
  assert.equal(after.filter((t) => t.list === 1).length, 80);
  // duplicates across the lists (same Deezer id, ISRC, or artist + title) count once
  const a = { id: 5, tracks: [song(5, 1), song(5, 2), song(5, 3)] };
  const b = { id: 6, tracks: [{ ...song(5, 1) }, song(6, 2, { isrc: isrc(50002) }), song(6, 3, { title: 'Lied 5-3', artist: 'BAND 5-3' })] };
  const d = spreadPlan([a, b], { rand: seededRandom(1) });
  assert.equal(d.length, 3, `drie verschillende nummers (${d.map((t) => t.title).join(', ')})`);
  assert.ok(spreadPlan([listOf(9, 5000)]).length === LIST_PLAN_MAX, `hooguit ${LIST_PLAN_MAX} kandidaten`);
  assert.deepEqual(spreadPlan([], {}), []);
  assert.deepEqual(spreadPlan([{ id: 1, tracks: [null, { deezerId: 'x' }, { deezerId: -1 }] }]), [], 'onzin uit de lijst valt weg');
});

test('plan: elk nummer van een lijst heeft dezelfde kans (uniform)', () => {
  const l = listOf(1, 40);
  const hits = new Array(40).fill(0);
  const rand = seededRandom(11);
  const runs = 4000;
  for (let r = 0; r < runs; r++) for (const t of spreadPlan([l], { rand, max: 10 })) hits[(t.deezerId % 10000) - 1]++;
  const expect = (runs * 10) / 40; // 1000
  for (const h of hits) assert.ok(Math.abs(h - expect) < expect * 0.15, `elk nummer ongeveer ${expect} keer gekozen (${Math.min(...hits)}..${Math.max(...hits)})`);
  // with two lists every song of one list is equally likely too
  const hitsB = new Array(10).fill(0);
  for (let r = 0; r < runs; r++) for (const t of spreadPlan([listOf(1, 30), listOf(2, 10)], { rand, max: 8 })) if (t.list === 2) hitsB[(t.deezerId % 10000) - 1]++;
  const eB = (runs * 4) / 10;
  for (const h of hitsB) assert.ok(Math.abs(h - eB) < eB * 0.15, `tweede lijst: uniform (${Math.min(...hitsB)}..${Math.max(...hitsB)})`);
});

test('plan: wat al nagekeken is blijft vooraan in zijn lijst', () => {
  const a = listOf(1, 50);
  const b = listOf(2, 50);
  const first = { 1: [10037, 10005, 10012] };
  const plan = spreadPlan([a, b], { rand: seededRandom(5), first });
  assert.deepEqual(plan.filter((t) => t.list === 1).slice(0, 3).map((t) => t.deezerId), [10037, 10005, 10012]);
  assert.equal(plan[0].list, 1);
  assert.equal(plan[1].list, 2, 'en nog steeds om en om');
});

test('nagekeken jaartal: dezelfde regels als de jaartalcontrole van de app', () => {
  assert.deepEqual(checkedYear(2011, { via: 'isrc', year: 1985 }), { year: 1985, sure: true }, 'ISRC eerder dan de heruitgave: zeker');
  assert.deepEqual(checkedYear(null, { via: 'isrc', year: 1985 }), { year: 1985, sure: true });
  assert.deepEqual(checkedYear(1985, { via: 'isrc', year: 1985 }), { year: 1985, sure: true });
  assert.deepEqual(checkedYear(1980, { via: 'isrc', year: 1985 }), { year: 1980, sure: false }, 'MusicBrainz later: Deezer blijft, niet zeker');
  assert.deepEqual(checkedYear(2011, { via: 'search', year: 1986 }), { year: 1986, sure: false }, 'gevonden via zoeken: nooit zeker');
  assert.deepEqual(checkedYear(1984, { via: 'search', year: 1986 }), { year: 1984, sure: false });
  assert.equal(checkedYear(2011, null), null, 'niets gevonden: niet nagekeken, niet gedeeld');
  assert.equal(checkedYear(2011, { via: 'isrc', year: 1066 }), null);
  assert.equal(checkedYear(2011, { via: 'gok', year: 1990 }), null);
});

/* ---------- contributed songs: checks, duplicates ---------- */

const dzTrack = (n, extra = {}) => ({ deezerId: 7_000_000 + n, isrc: isrc(n), title: `Lijst ${n}`, artist: `Groep ${n}`, year: 1970 + (n % 40), sure: n % 2 === 0, checked: true, ...extra });

test('bijdrage uit een playlist: deezerId, ISRC, nagekeken; vijandige invoer valt weg', () => {
  const ok = cleanMixTrack(dzTrack(1, { isrc: 'nla010000001 ' }));
  assert.deepEqual(ok, { deezerId: 7_000_001, isrc: 'NLA010000001', title: 'Lijst 1', artist: 'Groep 1', year: 1971, sure: false });
  assert.equal(cleanMixTrack(dzTrack(1, { checked: undefined })), null, 'zonder nagekeken jaartal: geweigerd');
  assert.equal(cleanMixTrack(dzTrack(1, { checked: 'true' })), null);
  for (const bad of ['7000001', 1.5, -3, 0, 2 ** 60, null, {}, []]) assert.equal(cleanMixTrack(dzTrack(1, { deezerId: bad })), null, `deezerId ${JSON.stringify(bad)}`);
  assert.equal(cleanMixTrack(dzTrack(1, { isrc: 'NL-A01-00-00001' })).isrc, undefined, 'ongeldige ISRC weg, nummer blijft');
  assert.equal(cleanMixTrack(dzTrack(1, { isrc: 'X'.repeat(5000) })).isrc, undefined);
  assert.equal(cleanMixTrack(dzTrack(1, { isrc: 12 })).isrc, undefined);
  assert.equal(cleanMixTrack(dzTrack(1, { title: { toString: () => 'x' } })), null, 'titel moet tekst zijn');
  assert.equal(cleanMixTrack(dzTrack(1, { title: 'é'.repeat(100000) })).title.length, 200, 'enorme titel ingekort');
  assert.equal(cleanMixTrack(dzTrack(1, { year: [1984] })), null);
  assert.equal(cleanMixTrack(dzTrack(1, { year: true })), null);
  assert.equal(cleanMixTrack(dzTrack(1, { previewUrl: 'http://x.example/a.mp3' })).previewUrl, undefined);
  // prototype keys (JSON from the network): never a field through __proto__
  const proto = JSON.parse('{"__proto__":{"deezerId":5,"checked":true,"spotifyId":"aaaaaaaaaaaaaaaaaaaaaa"},"title":"T","artist":"A","year":1990}');
  assert.equal(cleanMixTrack(proto), null, '__proto__ geeft geen id');
  const proto2 = JSON.parse('{"deezerId":5,"title":"T","artist":"A","year":1990,"__proto__":{"checked":true}}');
  assert.equal(cleanMixTrack(proto2), null, '__proto__ geeft geen "nagekeken"');
  assert.equal(Object.prototype.checked, undefined);
  // a Spotify favourite still needs nothing more
  assert.ok(cleanMixTrack({ spotifyId: 'a'.repeat(22), title: 'T', artist: 'A', year: 1990 }));
  assert.equal(contributionTrack({ deezerId: 5, isrc: isrc(5), title: 'T', artist: 'A', year: 1990, yearSure: true, checked: true }).checked, true);
});

test('dubbele nummers: ook herkend aan ISRC en Deezer-id (binnen een speler en tussen spelers)', () => {
  let r = addToContribution([], [dzTrack(1), dzTrack(2)]);
  assert.equal(r.added, 2);
  r = addToContribution(r.list, [dzTrack(1, { deezerId: 9_000_001 }), dzTrack(2, { isrc: isrc(777) }), dzTrack(3)]);
  assert.equal(r.added, 1, 'zelfde ISRC (andere Deezer-id) of zelfde Deezer-id (andere ISRC): niet nog eens');
  assert.equal(r.refused, 0);
  const contrib = {
    a: { tracks: [dzTrack(1), dzTrack(2), dzTrack(3)] },
    b: { tracks: [dzTrack(1, { deezerId: 8_000_001, title: 'Lijst 1 (Remastered)' }), dzTrack(5, { deezerId: 7_000_002, isrc: undefined }), dzTrack(6)] },
    c: { tracks: [{ spotifyId: 'c'.repeat(22), isrc: isrc(3), title: 'Iets anders', artist: 'Ander', year: 1990, sure: true, itunesId: 4 }] },
  };
  const stats = mixStats(contrib);
  assert.equal(stats.total, 4, `1 (ISRC), 2 (Deezer-id) en 3 (ISRC, ook via Spotify) tellen één keer: ${stats.total}`);
  assert.equal(stats.preview, 4, 'een Deezer-id is genoeg voor een fragment');
  const cards = buildMix(contrib, { seed: 3, need: 1, names: { a: 'Anouk', b: 'Bram', c: 'Cas' } });
  assert.equal(cards.length, 4);
  const one = cards.find((c) => c.deezerId === 7_000_001);
  assert.deepEqual(one.by, ['Anouk', 'Bram'], 'iedere bijdrager blijft genoemd');
  const three = cards.find((c) => c.deezerId === 7_000_003);
  assert.deepEqual(three.from, ['a', 'c']);
  assert.ok(cards.every((c) => c.deezerId || c.spotifyId));
  assert.ok(cards.filter((c) => !c.spotifyId).every((c) => c.deezerId && !c.previewUrl), 'kaart: deezerId, nooit een opgeslagen fragmentadres');
  assert.equal(three.isrc, isrc(3), 'zonder Spotify-id gaat de ISRC mee (Spotify zoekt er dan op)');
  assert.ok(cards.filter((c) => c.spotifyId).every((c) => !('isrc' in c)), 'met een Spotify-id blijft de ISRC thuis');
});

test('eerlijk verdeeld blijft eerlijk, ook met playlists', () => {
  const many = (p, n) => Array.from({ length: n }, (_, i) => dzTrack(p * 1000 + i));
  const contrib = { a: { tracks: many(1, MIX_PER_PLAYER) }, b: { tracks: many(2, 10) }, c: { tracks: many(3, MIX_PER_PLAYER) } };
  const cards = buildMix(contrib, { seed: 9, need: 25, max: 30 });
  const per = (pid) => cards.filter((c) => c.from[0] === pid).length;
  assert.equal(cards.length, 30);
  assert.equal(per('b'), 10, 'wie weinig heeft, geeft alles');
  assert.equal(per('a'), 10);
  assert.equal(per('c'), 10, 'wie veel heeft, krijgt dezelfde quota');
  const big = buildMix(contrib, { seed: 9, need: 1 });
  assert.ok(big.length <= MIX_GAME_MAX);
  // sure years first within a player
  const mixed = { a: { tracks: [...many(4, 20).map((t) => ({ ...t, sure: false })), ...many(5, 5).map((t) => ({ ...t, sure: true }))] } };
  const five = buildMix(mixed, { seed: 1, need: 1, max: 5 });
  assert.ok(five.every((c) => !c.unsure), 'zekere jaartallen eerst');
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
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...p.msgs].reverse().find((m) => m.t === t) || null;
  return p;
}

test('server: kondigt de playlists aan, weigert niet-nagekeken en kapotte nummers, alleen aantallen', async () => {
  assert.ok(SERVER_FEATURES.includes('mix-playlists'));
  const core = createRoomServer({ now: () => 1_000_000 });
  assert.ok(http(core, 'GET', '/health').body.features.includes('mix-playlists'), '/health: feature mix-playlists');
  const res = http(core, 'POST', '/rooms', { v: V, id: 'owner01', name: 'Ilse', hostPlays: false, settings: { game: 'bingo', size: 3 } });
  const { code, token } = res.body;
  const host = connect(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const a = connect(core, code);
  a.send({ t: 'hello', v: V, code, id: 'playerA1', name: 'Anouk' });
  const b = connect(core, code);
  b.send({ t: 'hello', v: V, code, id: 'playerB1', name: 'Bram' });
  await flush();
  host.send({ t: 'settings', patch: { music: 'mix' } });
  const ta = Array.from({ length: 6 }, (_, i) => dzTrack(100 + i));
  const tb = Array.from({ length: 6 }, (_, i) => dzTrack(200 + i));
  a.send({ t: 'mix-add', tracks: [...ta, { ...dzTrack(150), checked: false }, { ...dzTrack(151), deezerId: '7000151' }, { ...dzTrack(152), title: '' }] });
  b.send({ t: 'mix-add', tracks: [...tb, ta[0], { ...ta[1], deezerId: 7_999_999 }] }); // two of Anouk's songs too
  await flush();
  assert.equal(a.last('error').code, 'mix', 'niet-nagekeken / ongeldige nummers: geweigerd met uitleg');
  const meta = (p) => p.last('state').meta.mix;
  assert.equal(meta(a).mine, 6);
  assert.equal(meta(b).mine, 8);
  assert.equal(meta(host).total, 12, 'dubbele (zelfde Deezer-id of ISRC) tellen één keer');
  const titles = [...ta, ...tb].map((t) => t.title);
  for (const p of [host, a, b]) assert.deepEqual(titles.filter((t) => p.raw.some((r) => r.includes(t))), [], 'geen titel naar wie dan ook');
  assert.equal(host.raw.some((r) => r.includes(String(ta[0].deezerId))), false, 'ook geen Deezer-id');
  // a game from deezer-only songs: the music phone gets the deezerId (fragment via Deezer)
  host.send({ t: 'start', cards: [], seed: 4, play: 'preview' });
  await flush();
  const st = host.last('state');
  assert.equal(st.view.phase, 'answering');
  const s1 = st.lead.song;
  assert.ok(Number.isSafeInteger(s1.deezerId) && !s1.spotifyId && !s1.previewUrl, `het nummer heeft alleen een Deezer-id (${JSON.stringify(s1)})`);
  assert.equal(st.lead.room.game.left + 1, 12);
  const unplayed = titles.filter((t) => t !== s1.title);
  for (const p of [a, b]) assert.deepEqual(unplayed.filter((t) => p.raw.some((r) => r.includes(t))), [], 'tijdens het spel: niets van nog niet gespeelde nummers');
  for (const p of [a, b]) assert.equal(p.raw.some((r) => r.includes(s1.title)), false, 'het lopende nummer alleen naar de muziektelefoon');
});

/* ---------- the phone's worker (mix-lists.js) ---------- */

function memStore() {
  const m = new Map();
  return {
    m,
    get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f),
    set: (k, v) => { m.set(k, JSON.stringify(v)); return true; },
    remove: (k) => { m.delete(k); },
  };
}
function fakeSession() {
  const s = { online: true, sent: [], clears: 0, meta: { mix: { mine: 0 } } };
  s.mixAdd = (tracks) => { s.sent.push(...tracks); s.meta.mix.mine += tracks.length; return true; };
  s.mixClear = () => { s.clears++; s.sent = []; s.meta.mix.mine = 0; return true; };
  return s;
}
/** Deezer + MusicBrainz fakes: years per id; song i of a list: no year when i % 5 === 0. */
function fakes({ lists, mbFail = 0 } = {}) {
  const calls = { tracks: [], info: [], mb: [], search: [] };
  const all = new Map();
  for (const l of lists) for (const t of l.tracks) all.set(t.deezerId, t);
  let fail = mbFail;
  const deezer = {
    FEATURED,
    parsePlaylistId,
    errorMessage: () => 'Deezer-fout',
    searchPlaylists: async (q) => ({ items: lists.map((l) => ({ id: l.id, title: `Lijst ${l.id} ${q}`, count: l.tracks.length, by: 'Iemand', picture: null })), next: null }),
    playlistInfo: async (id) => { const l = lists.find((x) => x.id === id); if (!l) throw Object.assign(new Error('nf'), { code: 'notfound' }); return { id, title: `Lijst ${id}`, count: l.tracks.length, by: 'X', picture: null }; },
    playlistTracks: async (id) => { calls.tracks.push(id); return lists.find((l) => l.id === id).tracks; },
    trackInfo: async (id) => { calls.info.push(id); const t = all.get(id); return { ...t, year: 2025, preview: null }; },
  };
  const musicbrainz = {
    errorMessage: () => 'MusicBrainz-fout',
    firstReleaseYear: async (code) => {
      calls.mb.push(code);
      await new Promise((r) => setTimeout(r, 1));
      if (fail > 0) { fail--; throw Object.assign(new Error('x'), { code: 'unavailable' }); }
      const n = Number(code.slice(5)) % 10000;
      return n % 5 === 0 ? null : 1960 + n;
    },
    searchFirstReleaseYear: async ({ title }) => { calls.search.push(title); return null; },
  };
  return { deezer, musicbrainz, calls };
}
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 2)); }
};

test('telefoon: kiest, kijkt na, deelt alleen nagekeken nummers, één voor één', async () => {
  const lists = [listOf(1, 60), listOf(2, 8)];
  const f = fakes({ lists });
  const store = memStore();
  const session = fakeSession();
  let draws = 0;
  const ls = createListShare({ code: 'ABCD', session, onChange: () => draws++, deps: { ...f, store, rand: seededRandom(2), wait: async () => {} } });
  assert.equal(ls.state.count, DEFAULT_LIST_COUNT);
  ls.open();
  ls.search('jaren 90');
  await until(() => ls.state.results.length === 2);
  ls.add(1);
  await until(() => ls.state.phase === 'checking' || ls.state.phase === 'done');
  ls.open();
  ls.pasted('https://www.deezer.com/nl/playlist/2?utm=x');
  await until(() => ls.state.phase === 'done');
  assert.deepEqual(ls.state.lists.map((l) => l.id), [1, 2]);
  assert.equal(ls.state.shared.length, 25);
  assert.equal(session.sent.length, 25, 'precies wat gedeeld is, staat in de kamer');
  assert.ok(session.sent.every((t) => t.checked === true && t.deezerId && t.isrc && Number.isInteger(t.year)), 'alleen nagekeken nummers, met Deezer-id en ISRC');
  assert.ok(session.sent.every((t) => (t.deezerId % 10000) % 5 !== 0), 'zonder gevonden jaartal: niet gedeeld');
  assert.ok(session.sent.every((t) => t.sure === true && t.year === 1960 + (t.deezerId % 10000)), 'jaar van MusicBrainz (ISRC), zeker');
  const fromSmall = session.sent.filter((t) => Math.floor(t.deezerId / 10000) === 2).length;
  assert.ok(fromSmall >= 6, `ook uit de kleine lijst (${fromSmall} van de 6 met een jaartal)`);
  assert.ok(f.calls.search.length > 0, 'zonder ISRC-jaar: zoeken op titel en artiest');
  const saved = store.get(LISTS_KEY);
  assert.equal(saved.code, 'ABCD');
  assert.equal(saved.shared.length, 25);
  assert.ok(draws > 25, 'voortgang op het scherm');
  ls.destroy();
});

test('telefoon: terugkomen gaat verder, stuurt niets twee keer; tijdens een potje wacht hij', async () => {
  const lists = [listOf(1, 80)];
  const f = fakes({ lists });
  const store = memStore();
  const session = fakeSession();
  let lobby = true;
  const mk = () => createListShare({ code: 'ABCD', session, inLobby: () => lobby, deps: { ...f, store, rand: seededRandom(4), wait: async () => {} } });
  let ls = mk();
  ls.add(1);
  await until(() => ls.state.shared.length >= 5);
  ls.destroy(); // the screen closes halfway
  const sentBefore = session.sent.length;
  const mbBefore = f.calls.mb.length;
  ls = mk();
  assert.equal(ls.state.lists.length, 1, 'de gekozen playlist is onthouden');
  assert.equal(ls.state.shared.length, sentBefore);
  assert.equal(ls.state.phase, 'waiting');
  ls.sync(session.meta);
  await until(() => ls.state.phase === 'done');
  assert.equal(session.sent.length, 25);
  assert.equal(new Set(session.sent.map((t) => t.deezerId)).size, 25, 'geen nummer twee keer gestuurd');
  assert.equal(f.calls.tracks.length, 1, 'de playlist is niet opnieuw gelezen');
  assert.ok(f.calls.mb.length - mbBefore <= 25 - sentBefore + 8, 'en wat al nagekeken was, niet opnieuw nagekeken');
  // the server lost everything (restart): sent again by itself
  session.sent = [];
  session.meta.mix.mine = 0;
  await new Promise((r) => setTimeout(r, 10));
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000; // past the "still on its way" window
  try { ls.sync(session.meta); } finally { Date.now = realNow; }
  assert.equal(session.sent.length, 25, 'na een herstart van de server opnieuw gestuurd');
  // a game starts: the walker stops, in the lobby it goes on
  ls.setCount(50);
  lobby = false;
  ls.sync(session.meta);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ls.state.phase, 'waiting', 'tijdens het potje wordt er niets nagekeken');
  const during = session.sent.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.sent.length, during);
  lobby = true;
  ls.sync(session.meta);
  await until(() => ls.state.phase === 'done');
  assert.ok(ls.state.shared.length > 25 && ls.state.shared.length <= MIX_PER_PLAYER, `in de lobby verder tot meer (${ls.state.shared.length})`);
  ls.destroy();
});

test('telefoon: playlist weghalen, intrekken, links en fouten', async () => {
  const lists = [listOf(1, 40), listOf(2, 40)];
  const f = fakes({ lists, mbFail: 3 });
  const store = memStore();
  const session = fakeSession();
  const ls = createListShare({ code: 'WXYZ', session, deps: { ...f, store, rand: seededRandom(6), wait: async () => {} } });
  ls.pasted('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(ls.state.linkMsg, SPOTIFY_LINK_MESSAGE, 'Spotify-link: uitleg');
  ls.pasted('https://link.deezer.com/s/30abcDEF');
  assert.equal(ls.state.linkMsg, SHORT_LINK_MESSAGE);
  ls.pasted('hallo daar');
  assert.equal(ls.state.linkMsg, BAD_LINK_MESSAGE);
  ls.search('https://open.spotify.com/playlist/xyz');
  assert.equal(ls.state.linkKind, 'spotify', 'ook in het zoekveld');
  assert.equal(ls.state.lists.length, 0);
  ls.add(1);
  await until(() => ls.state.phase === 'error');
  assert.equal(ls.state.error, 'MusicBrainz-fout', 'drie keer mislukt: stopt met uitleg');
  ls.retry();
  await until(() => ls.state.phase === 'done');
  ls.add(2);
  await until(() => ls.state.phase === 'done' && ls.state.lists.length === 2);
  assert.equal(session.clears, 1, 'een playlist erbij: de kamer krijgt de nieuwe verdeling');
  assert.ok(session.sent.some((t) => Math.floor(t.deezerId / 10000) === 2) && session.sent.some((t) => Math.floor(t.deezerId / 10000) === 1), 'uit allebei');
  ls.remove(2);
  await until(() => ls.state.phase === 'done' && ls.state.lists.length === 1);
  assert.equal(session.clears, 2);
  assert.ok(session.sent.length === 25 && session.sent.every((t) => Math.floor(t.deezerId / 10000) === 1), 'alleen nog nummers uit de eerste lijst');
  ls.remove(1);
  assert.equal(session.clears, 3, 'laatste playlist weg: bijdrage weg');
  assert.equal(ls.state.phase, 'idle');
  assert.equal(store.get(LISTS_KEY), null, 'en niets meer op dit toestel');
  ls.destroy();
});
