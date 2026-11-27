// "Mix van de groep" from chosen playlists ("Kies een playlist"): the plan a phone makes from
// its lists (uniform, spread over the lists), the checked year, hostile contributed songs,
// duplicates by ISRC / Spotify id, the room server (refuses unchecked and invalid songs, also
// the Deezer-only songs an app of v3-10 may still send; counts only; a game from ISRC-only
// songs), and the phone's worker (multi/mix-lists.js) with a fake list provider (the seam for
// the next step: the app itself has none yet), MusicBrainz, room session and storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadPlan, checkedYear, cleanMixTrack, addToContribution, buildMix, mixStats, contributionTrack, candidateKey,
  MIX_PER_PLAYER, MIX_GAME_MAX, LIST_PLAN_MAX, DEFAULT_LIST_COUNT, MIX_LISTS_MAX,
} from '../../app/js/multi/mix.js';
import { createListShare, LISTS_KEY, FULL_MESSAGE, EMPTY_LIST_MESSAGE } from '../../app/js/multi/mix-lists.js';
import { seededRandom } from '../../app/js/logic.js';
import { createRoomServer } from '../../server/core.mjs';
import { SERVER_PROTOCOL_VERSION, SERVER_FEATURES, MIX_LISTS_FEATURE } from '../../app/js/multi/server-protocol.js';

const isrc = (n) => `NLA01${String(n).padStart(7, '0')}`;
const spid = (n) => `sp${String(n).padStart(20, '0')}`;
// a song of a list as a provider gives it (n: only for the tests, to tell the songs apart)
const song = (list, i, extra = {}) => ({ n: list * 10000 + i, spotifyId: spid(list * 10000 + i), isrc: isrc(list * 10000 + i), title: `Lied ${list}-${i}`, artist: `Band ${list}-${i}`, album: 'A', year: 2025, ...extra });
const listOf = (id, n) => ({ id: String(id), tracks: Array.from({ length: n }, (_, i) => song(id, i + 1)) });
const fromList = (t) => Math.floor(t.n / 10000);

/* ---------- the plan ---------- */

test('plan: willekeurig (niet de eerste N), gelijk verdeeld over de lijsten, zonder dubbele', () => {
  const big = listOf(1, 1000);
  const small = listOf(2, 20);
  const plan = spreadPlan([big, small], { rand: seededRandom(3), max: 40 });
  assert.equal(plan.length, 40);
  const first20 = plan.slice(0, 20);
  assert.equal(first20.filter((t) => t.list === '1').length, 10, 'om en om: 10 uit de grote lijst');
  assert.equal(first20.filter((t) => t.list === '2').length, 10, 'en 10 uit de kleine');
  assert.ok(plan.slice(0, 25).filter((t) => t.list === '1').some((t) => t.n % 10000 > 100), 'niet het begin van de grote lijst');
  // a list that runs out leaves the rest to the others
  const after = spreadPlan([big, small], { rand: seededRandom(3), max: 100 });
  assert.equal(after.filter((t) => t.list === '2').length, 20);
  assert.equal(after.filter((t) => t.list === '1').length, 80);
  // duplicates across the lists (same Spotify id, ISRC, or artist + title) count once
  const a = { id: '5', tracks: [song(5, 1), song(5, 2), song(5, 3)] };
  const b = { id: '6', tracks: [{ ...song(5, 1) }, song(6, 2, { isrc: isrc(50002) }), song(6, 3, { title: 'Lied 5-3', artist: 'BAND 5-3' })] };
  const d = spreadPlan([a, b], { rand: seededRandom(1) });
  assert.equal(d.length, 3, `drie verschillende nummers (${d.map((t) => t.title).join(', ')})`);
  assert.ok(spreadPlan([listOf(9, 5000)]).length === LIST_PLAN_MAX, `hooguit ${LIST_PLAN_MAX} kandidaten`);
  assert.deepEqual(spreadPlan([], {}), []);
  assert.deepEqual(spreadPlan([{ id: '1', tracks: [null, { deezerId: 5, title: 'x' }, { title: 'x' }, { title: '', artist: '', isrc: isrc(1) }, { title: 5, artist: 'y' }] }]), [], 'onzin (en een nummer zonder titel en artiest) valt weg');
  assert.equal(spreadPlan([{ id: '1', tracks: [{ title: 'Alleen', artist: 'Tekst' }] }]).length, 1, 'titel + artiest is genoeg: Spotify zoekt het');
});

test('plan: elk nummer van een lijst heeft dezelfde kans (uniform)', () => {
  const l = listOf(1, 40);
  const hits = new Array(40).fill(0);
  const rand = seededRandom(11);
  const runs = 4000;
  for (let r = 0; r < runs; r++) for (const t of spreadPlan([l], { rand, max: 10 })) hits[(t.n % 10000) - 1]++;
  const expect = (runs * 10) / 40; // 1000
  for (const h of hits) assert.ok(Math.abs(h - expect) < expect * 0.15, `elk nummer ongeveer ${expect} keer gekozen (${Math.min(...hits)}..${Math.max(...hits)})`);
  // with two lists every song of one list is equally likely too
  const hitsB = new Array(10).fill(0);
  for (let r = 0; r < runs; r++) for (const t of spreadPlan([listOf(1, 30), listOf(2, 10)], { rand, max: 8 })) if (t.list === '2') hitsB[(t.n % 10000) - 1]++;
  const eB = (runs * 4) / 10;
  for (const h of hitsB) assert.ok(Math.abs(h - eB) < eB * 0.15, `tweede lijst: uniform (${Math.min(...hitsB)}..${Math.max(...hitsB)})`);
});

test('plan: wat al nagekeken is blijft vooraan in zijn lijst', () => {
  const a = listOf(1, 50);
  const b = listOf(2, 50);
  const first = { 1: [10037, 10005, 10012].map((n) => candidateKey(song(1, n - 10000))) };
  const plan = spreadPlan([a, b], { rand: seededRandom(5), first });
  assert.deepEqual(plan.filter((t) => t.list === '1').slice(0, 3).map((t) => t.n), [10037, 10005, 10012]);
  assert.equal(plan[0].list, '1');
  assert.equal(plan[1].list, '2', 'en nog steeds om en om');
  assert.equal(candidateKey({ isrc: isrc(1), title: 'x', artist: 'y' }), `i:${isrc(1)}`, 'zonder Spotify-id: de ISRC');
  assert.equal(candidateKey({ title: 'x', artist: 'y' }).startsWith('k:'), true, 'anders titel en artiest');
  assert.equal(candidateKey({ deezerId: 5 }), '');
});

test('nagekeken jaartal: dezelfde regels als de jaartalcontrole van de app', () => {
  assert.deepEqual(checkedYear(2011, { via: 'isrc', year: 1985 }), { year: 1985, sure: true }, 'ISRC eerder dan de heruitgave: zeker');
  assert.deepEqual(checkedYear(null, { via: 'isrc', year: 1985 }), { year: 1985, sure: true });
  assert.deepEqual(checkedYear(1985, { via: 'isrc', year: 1985 }), { year: 1985, sure: true });
  assert.deepEqual(checkedYear(1980, { via: 'isrc', year: 1985 }), { year: 1980, sure: false }, 'MusicBrainz later: het jaar van de catalogus blijft, niet zeker');
  assert.deepEqual(checkedYear(2011, { via: 'search', year: 1986 }), { year: 1986, sure: false }, 'gevonden via zoeken: nooit zeker');
  assert.deepEqual(checkedYear(1984, { via: 'search', year: 1986 }), { year: 1984, sure: false });
  assert.deepEqual(checkedYear(2011, null), { year: 2011, sure: false }, 'MusicBrainz antwoordde zonder jaar (ISRC en zoeken): nagekeken, het jaar van de catalogus blijft, niet zeker');
  assert.equal(checkedYear(null, null), null, 'ook geen jaar van de catalogus: niets om mee te spelen');
  assert.deepEqual(checkedYear(2011, { via: 'isrc', year: 1066 }), { year: 2011, sure: false }, 'een onzinjaar telt als geen antwoord');
  assert.equal(checkedYear(2011, { via: 'gok', year: 1990 }), null);
});

/* ---------- contributed songs: checks, duplicates ---------- */

// a song as a phone shares it from a playlist: ISRC, checked year, no Spotify id
const ckTrack = (n, extra = {}) => ({ isrc: isrc(n), title: `Lijst ${n}`, artist: `Groep ${n}`, year: 1970 + (n % 40), sure: n % 2 === 0, checked: true, ...extra });

test('bijdrage uit een playlist: ISRC of Spotify-id, nagekeken; vijandige invoer en Deezer-nummers (v3-10) vallen weg', () => {
  const ok = cleanMixTrack(ckTrack(1, { isrc: 'nla010000001 ' }));
  assert.deepEqual(ok, { isrc: 'NLA010000001', title: 'Lijst 1', artist: 'Groep 1', year: 1971, sure: false });
  assert.equal(cleanMixTrack(ckTrack(1, { checked: undefined })), null, 'zonder nagekeken jaartal: geweigerd');
  assert.equal(cleanMixTrack(ckTrack(1, { checked: 'true' })), null);
  for (const bad of ['NL-A01-00-00001', 'X'.repeat(5000), 12, null]) assert.equal(cleanMixTrack(ckTrack(1, { isrc: bad })), null, `zonder Spotify-id is een geldige ISRC nodig (${String(bad).slice(0, 20)})`);
  assert.equal(cleanMixTrack(ckTrack(1, { isrc: 'kapot', spotifyId: 'a'.repeat(22) })).isrc, undefined, 'met een Spotify-id: ongeldige ISRC weg, nummer blijft');
  // what an app of v3-10 sends from its Deezer search: only a Deezer id is not enough, and a deezerId never goes along
  assert.equal(cleanMixTrack({ deezerId: 7_000_001, title: 'T', artist: 'A', year: 1990, sure: true, checked: true }), null);
  assert.deepEqual(Object.keys(cleanMixTrack({ ...ckTrack(2), deezerId: 7_000_002 })).sort(), ['artist', 'isrc', 'sure', 'title', 'year']);
  assert.equal(cleanMixTrack(ckTrack(1, { title: { toString: () => 'x' } })), null, 'titel moet tekst zijn');
  assert.equal(cleanMixTrack(ckTrack(1, { title: 'é'.repeat(100000) })).title.length, 200, 'enorme titel ingekort');
  assert.equal(cleanMixTrack(ckTrack(1, { year: [1984] })), null);
  assert.equal(cleanMixTrack(ckTrack(1, { year: true })), null);
  assert.equal(cleanMixTrack(ckTrack(1, { previewUrl: 'http://x.example/a.mp3' })).previewUrl, undefined);
  // prototype keys (JSON from the network): never a field through __proto__
  const proto = JSON.parse('{"__proto__":{"isrc":"NLA010000005","checked":true,"spotifyId":"aaaaaaaaaaaaaaaaaaaaaa"},"title":"T","artist":"A","year":1990}');
  assert.equal(cleanMixTrack(proto), null, '__proto__ geeft geen id');
  const proto2 = JSON.parse('{"isrc":"NLA010000005","title":"T","artist":"A","year":1990,"__proto__":{"checked":true}}');
  assert.equal(cleanMixTrack(proto2), null, '__proto__ geeft geen "nagekeken"');
  assert.equal(Object.prototype.checked, undefined);
  // a Spotify favourite still needs nothing more
  assert.ok(cleanMixTrack({ spotifyId: 'a'.repeat(22), title: 'T', artist: 'A', year: 1990 }));
  const ct = contributionTrack({ spotifyId: 'b'.repeat(22), isrc: isrc(5), title: 'T', artist: 'A', year: 1990, yearSure: true, checked: true });
  assert.deepEqual(ct, { title: 'T', artist: 'A', year: 1990, sure: true, spotifyId: 'b'.repeat(22), isrc: isrc(5), checked: true });
});

test('dubbele nummers: ook herkend aan ISRC en Spotify-id (binnen een speler en tussen spelers)', () => {
  let r = addToContribution([], [ckTrack(1), ckTrack(2)]);
  assert.equal(r.added, 2);
  r = addToContribution(r.list, [ckTrack(1, { title: 'Lijst 1 (Remastered)' }), ckTrack(2, { spotifyId: 'z'.repeat(22) }), ckTrack(3)]);
  assert.equal(r.added, 1, 'zelfde ISRC: niet nog eens');
  assert.equal(r.refused, 0);
  const contrib = {
    a: { tracks: [ckTrack(1), ckTrack(2), ckTrack(3)].map(cleanMixTrack) },
    b: { tracks: [ckTrack(1, { title: 'Lijst 1 (Remastered)' }), ckTrack(6)].map(cleanMixTrack) },
    c: { tracks: [{ spotifyId: 'c'.repeat(22), isrc: isrc(3), title: 'Iets anders', artist: 'Ander', year: 1990, sure: true, itunesId: 4 }] },
  };
  const stats = mixStats(contrib);
  assert.equal(stats.total, 4, `1 (ISRC) en 3 (ISRC, ook via Spotify) tellen één keer: ${stats.total}`);
  assert.equal(stats.preview, 0, 'zonder Apple Music-fragment telt een nummer niet bij de fragmenten');
  assert.throws(() => buildMix(contrib, { seed: 3, need: 1 }), /Te weinig/, 'met fragmenten: niets te spelen');
  const cards = buildMix(contrib, { seed: 3, need: 1, source: 'spotify', names: { a: 'Anouk', b: 'Bram', c: 'Cas' } });
  assert.equal(cards.length, 4);
  const one = cards.find((c) => c.isrc === isrc(1));
  assert.deepEqual(one.by, ['Anouk', 'Bram'], 'iedere bijdrager blijft genoemd');
  const three = cards.find((c) => c.isrc === isrc(3));
  assert.deepEqual(three.from, ['a', 'c']);
  assert.ok(cards.every((c) => (c.isrc || c.spotifyId) && !('deezerId' in c) && !c.previewUrl), 'kaart: ISRC (Spotify zoekt erop), nooit een deezerId');
  assert.ok(cards.filter((c) => c.spotifyId).every((c) => !('isrc' in c)), 'met een Spotify-id blijft de ISRC thuis');
});

test('eerlijk verdeeld blijft eerlijk, ook met playlists', () => {
  const many = (p, n) => Array.from({ length: n }, (_, i) => ckTrack(p * 1000 + i));
  const contrib = { a: { tracks: many(1, MIX_PER_PLAYER) }, b: { tracks: many(2, 10) }, c: { tracks: many(3, MIX_PER_PLAYER) } };
  const cards = buildMix(contrib, { seed: 9, need: 25, max: 30, source: 'spotify' });
  const per = (pid) => cards.filter((c) => c.from[0] === pid).length;
  assert.equal(cards.length, 30);
  assert.equal(per('b'), 10, 'wie weinig heeft, geeft alles');
  assert.equal(per('a'), 10);
  assert.equal(per('c'), 10, 'wie veel heeft, krijgt dezelfde quota');
  const big = buildMix(contrib, { seed: 9, need: 1, source: 'spotify' });
  assert.ok(big.length <= MIX_GAME_MAX);
  // sure years first within a player
  const mixed = { a: { tracks: [...many(4, 20).map((t) => ({ ...t, sure: false })), ...many(5, 5).map((t) => ({ ...t, sure: true }))] } };
  const five = buildMix(mixed, { seed: 1, need: 1, max: 5, source: 'spotify' });
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

test('server: kondigt de playlists aan (mix-lists, niet meer mix-playlists), weigert niet-nagekeken, kapotte en Deezer-nummers, alleen aantallen', async () => {
  assert.equal(MIX_LISTS_FEATURE, 'mix-lists');
  assert.ok(SERVER_FEATURES.includes('mix-lists'));
  assert.ok(!SERVER_FEATURES.includes('mix-playlists'), 'een app van v3-10 biedt zijn Deezer-zoeken dan niet meer aan');
  const core = createRoomServer({ now: () => 1_000_000 });
  const features = http(core, 'GET', '/health').body.features;
  assert.ok(features.includes('mix-lists') && !features.includes('mix-playlists'), '/health');
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
  const ta = Array.from({ length: 6 }, (_, i) => ckTrack(100 + i));
  const tb = Array.from({ length: 6 }, (_, i) => ckTrack(200 + i));
  // as an app of v3-10 sends a song of its Deezer search: refused, the rest of the message counts
  const v310 = { deezerId: 7_000_150, title: 'Van Deezer', artist: 'X', year: 1990, sure: true, checked: true };
  a.send({ t: 'mix-add', tracks: [...ta, { ...ckTrack(150), checked: false }, { ...ckTrack(151), isrc: '7000151' }, { ...ckTrack(152), title: '' }, v310] });
  b.send({ t: 'mix-add', tracks: [...tb, ta[0], { ...ta[1], title: 'Ander' }] }); // two of Anouk's songs too
  await flush();
  assert.equal(a.last('error').code, 'mix', 'niet-nagekeken / ongeldige nummers: geweigerd met uitleg');
  assert.equal(a.closed, undefined);
  const meta = (p) => p.last('state').meta.mix;
  assert.equal(meta(a).mine, 6);
  assert.equal(meta(b).mine, 8);
  assert.equal(meta(host).total, 12, 'dubbele (zelfde ISRC) tellen één keer');
  const titles = [...ta, ...tb].map((t) => t.title);
  for (const p of [host, a, b]) assert.deepEqual(titles.filter((t) => p.raw.some((r) => r.includes(t))), [], 'geen titel naar wie dan ook');
  assert.equal(host.raw.some((r) => r.includes(ta[0].isrc)), false, 'ook geen ISRC');
  // a game from ISRC-only songs, played through Spotify: the music phone gets the ISRC
  host.send({ t: 'start', cards: [], seed: 4, play: 'spotify' });
  await flush();
  const st = host.last('state');
  assert.equal(st.view.phase, 'answering', JSON.stringify(host.last('error')));
  const s1 = st.lead.song;
  assert.ok(s1.isrc && !s1.spotifyId && !s1.previewUrl && !('deezerId' in s1), `het nummer heeft een ISRC (${JSON.stringify(s1)})`);
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
/** A list provider and MusicBrainz fakes: years per ISRC; song i of a list: no year when i % 5 === 0. */
function fakes({ lists, mbFail = 0, failLists = false } = {}) {
  const calls = { lists: 0, tracks: [], mb: [], search: [] };
  let fail = mbFail;
  const provider = {
    errorMessage: () => 'Lijst-fout',
    lists: async () => { calls.lists++; if (failLists) throw new Error('weg'); return lists.map((l) => ({ id: l.id, title: `Lijst ${l.id}`, count: l.tracks.length, by: 'Iemand', picture: 'javascript:alert(1)' })); },
    tracks: async (id) => { calls.tracks.push(id); return lists.find((l) => l.id === id).tracks; },
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
  return { provider, deps: { musicbrainz }, calls };
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
  const ls = createListShare({ code: 'ABCD', session, provider: f.provider, onChange: () => draws++, deps: { ...f.deps, store, rand: seededRandom(2), wait: async () => {} } });
  assert.equal(ls.state.count, DEFAULT_LIST_COUNT);
  assert.equal(ls.available(), true);
  ls.open();
  await until(() => ls.state.choices.length === 2);
  assert.ok(ls.state.choices.every((c) => c.picture === null), 'alleen https-hoezen');
  ls.add('1');
  await until(() => ls.state.phase === 'checking' || ls.state.phase === 'done');
  ls.open();
  await until(() => ls.state.choices.length === 2 && !ls.state.loading);
  ls.add('2');
  await until(() => ls.state.phase === 'done');
  assert.deepEqual(ls.state.lists.map((l) => l.id), ['1', '2']);
  assert.equal(ls.state.shared.length, 25);
  assert.equal(session.sent.length, 25, 'precies wat gedeeld is, staat in de kamer');
  assert.ok(session.sent.every((t) => t.checked === true && t.spotifyId && t.isrc && Number.isInteger(t.year) && !('deezerId' in t)), 'alleen nagekeken nummers, met Spotify-id en ISRC');
  const nOf = (t) => Number(t.isrc.slice(5));
  const noMb = (t) => (nOf(t) % 10000) % 5 === 0; // MusicBrainz answers without a year
  assert.ok(session.sent.some(noMb), 'MusicBrainz antwoordde zonder jaartal (ISRC en zoeken): toch nagekeken en gedeeld');
  assert.ok(session.sent.filter(noMb).every((t) => t.sure === false && t.year === 2025), 'dan met het jaar van de catalogus, niet zeker (zoals enrich.js: geen wachten op Apple)');
  assert.ok(session.sent.filter((t) => !noMb(t)).every((t) => t.sure === true && t.year === 1960 + (nOf(t) % 10000)), 'jaar van MusicBrainz (ISRC), zeker');
  const fromSmall = session.sent.filter((t) => Math.floor(nOf(t) / 10000) === 2).length;
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
  const mk = () => createListShare({ code: 'ABCD', session, provider: f.provider, inLobby: () => lobby, deps: { ...f.deps, store, rand: seededRandom(4), wait: async () => {} } });
  let ls = mk();
  ls.open();
  await until(() => ls.state.choices.length === 1);
  ls.add('1');
  await until(() => ls.state.shared.length >= 5);
  ls.destroy(); // the screen closes halfway
  const sentBefore = session.sent.length;
  const mbBefore = f.calls.mb.length;
  assert.equal(store.get(LISTS_KEY).v, 2);
  ls = mk();
  assert.equal(ls.state.lists.length, 1, 'de gekozen playlist is onthouden');
  assert.equal(ls.state.shared.length, sentBefore);
  assert.equal(ls.state.phase, 'waiting');
  ls.sync(session.meta);
  await until(() => ls.state.phase === 'done');
  assert.equal(session.sent.length, 25);
  assert.equal(new Set(session.sent.map((t) => t.isrc)).size, 25, 'geen nummer twee keer gestuurd');
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

test('telefoon: playlist weghalen, intrekken, grenzen en fouten; geen provider: niets aangeboden; oude Deezer-gegevens weg', async () => {
  // no provider (the app as it is now): nothing to choose, nothing breaks
  const store0 = memStore();
  store0.set(LISTS_KEY, { v: 1, code: 'WXYZ', lists: [{ id: 1266971851, title: 'Top Nederland', count: 100, by: 'Deezer', picture: null }], count: 25, shared: [{ deezerId: 5, title: 'T', artist: 'A', year: 1990 }], plan: [], checked: [], skipped: 0 });
  const none = createListShare({ code: 'WXYZ', session: fakeSession(), deps: { store: store0 } });
  assert.equal(none.available(), false);
  assert.equal(none.active(), false, 'de Deezer-lijsten van v3-10 doen niet meer mee');
  assert.equal(store0.get(LISTS_KEY), null, 'en zijn van dit toestel af');
  none.open();
  assert.equal(none.state.view, 'home', 'zonder provider opent er niets');
  none.destroy();

  const lists = [listOf(1, 40), listOf(2, 40), { id: 'leeg', tracks: [] }];
  const f = fakes({ lists, mbFail: 3 });
  const store = memStore();
  const session = fakeSession();
  const ls = createListShare({ code: 'WXYZ', session, provider: f.provider, deps: { ...f.deps, store, rand: seededRandom(6), wait: async () => {} } });
  ls.open();
  await until(() => ls.state.choices.length === 3);
  ls.add('leeg');
  assert.equal(ls.state.pickMsg, EMPTY_LIST_MESSAGE);
  ls.add('bestaat-niet');
  assert.equal(ls.state.lists.length, 0);
  ls.add('1');
  await until(() => ls.state.phase === 'error');
  assert.equal(ls.state.error, 'MusicBrainz-fout', 'drie keer mislukt: stopt met uitleg');
  ls.retry();
  await until(() => ls.state.phase === 'done');
  ls.open();
  await until(() => !ls.state.loading);
  ls.add('2');
  await until(() => ls.state.phase === 'done' && ls.state.lists.length === 2);
  assert.equal(session.clears, 1, 'een playlist erbij: de kamer krijgt de nieuwe verdeling');
  const listOfSent = (t) => Math.floor(Number(t.isrc.slice(5)) / 10000);
  assert.ok(session.sent.some((t) => listOfSent(t) === 2) && session.sent.some((t) => listOfSent(t) === 1), 'uit allebei');
  ls.remove('2');
  await until(() => ls.state.phase === 'done' && ls.state.lists.length === 1);
  assert.equal(session.clears, 2);
  assert.ok(session.sent.length === 25 && session.sent.every((t) => listOfSent(t) === 1), 'alleen nog nummers uit de eerste lijst');
  ls.remove('1');
  assert.equal(session.clears, 3, 'laatste playlist weg: bijdrage weg');
  assert.equal(ls.state.phase, 'idle');
  assert.equal(store.get(LISTS_KEY), null, 'en niets meer op dit toestel');
  ls.destroy();
  // at most MIX_LISTS_MAX lists; a provider that fails says so
  const many = Array.from({ length: MIX_LISTS_MAX + 1 }, (_, i) => listOf(i + 1, 3));
  const f2 = fakes({ lists: many });
  const ls2 = createListShare({ code: 'WXYZ', session: fakeSession(), provider: f2.provider, inLobby: () => false, deps: { ...f2.deps, store: memStore() } });
  ls2.open();
  await until(() => ls2.state.choices.length === many.length);
  for (const l of many) { ls2.open(); ls2.add(l.id); }
  assert.equal(ls2.state.lists.length, MIX_LISTS_MAX);
  assert.equal(ls2.state.pickMsg, FULL_MESSAGE);
  ls2.destroy();
  const f3 = fakes({ lists, failLists: true });
  const ls3 = createListShare({ code: 'WXYZ', session: fakeSession(), provider: f3.provider, deps: { ...f3.deps, store: memStore() } });
  ls3.open();
  await until(() => ls3.state.pickError === 'Lijst-fout');
  ls3.destroy();
});
