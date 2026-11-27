// "Really random" (multi/order.js): every card of a big deck equally likely early in a game,
// a deck bigger than a room takes is sampled (not cut), a new game in the same room first
// plays the songs that were not played yet, artists are spread without losing a card, the
// seed comes from crypto, and the played history never reaches a player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderSongs, spreadArtists, songKey, artistKey, markPlayed, nextGame, emptyHistory, cleanHistory, gameSeed, HISTORY_MAX, SPREAD_GAP,
} from '../../app/js/multi/order.js';
import { seededRandom, shuffle } from '../../app/js/logic.js';
import { fitCards, MAX_CARDS, SERVER_PROTOCOL_VERSION as V } from '../../app/js/multi/server-protocol.js';
import { createRoomServer } from '../../server/core.mjs';
import { createGame } from '../../app/js/logic.js';
import { buildMix } from '../../app/js/multi/mix.js';

const deck = (n, artists = 300) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, year: 1960 + (i % 60), title: `Liedje ${i}`, artist: `Artiest ${i % artists}`, itunesId: 1000 + i }));
const byId = (cards) => Object.fromEntries(cards.map((c) => [c.id, c]));

test('willekeurig: over veel spellen komt elke kaart van 2000 even vaak bij de eerste 30', (t) => {
  const cards = deck(2000);
  const songs = byId(cards);
  const ids = cards.map((c) => c.id);
  const GAMES = 4000;
  const hits = new Map(ids.map((id) => [id, 0]));
  for (let s = 1; s <= GAMES; s++) {
    for (const id of orderSongs(ids, songs, { rand: seededRandom(s * 2654435761) }).slice(0, 30)) hits.set(id, hits.get(id) + 1);
  }
  const expected = (GAMES * 30) / 2000; // 60
  const counts = [...hits.values()];
  const chi = counts.reduce((x, c) => x + ((c - expected) ** 2) / expected, 0);
  // chi-square with 1999 degrees of freedom: mean 1999, sd ~63; far outside means a bias
  t.diagnostic(`eerste 30 over ${GAMES} spellen: verwacht ${expected} per kaart, min ${Math.min(...counts)}, max ${Math.max(...counts)}, chi² ${chi.toFixed(0)} (df 1999)`);
  assert.ok(chi < 1999 + 6 * 63, `chi² ${chi}`);
  const head = ids.slice(0, 200).reduce((x, id) => x + hits.get(id), 0) / 200;
  const tail = ids.slice(-200).reduce((x, id) => x + hits.get(id), 0) / 200;
  assert.ok(Math.abs(head - tail) < expected * 0.15, `begin van de lijst ${head} vs eind ${tail}`);
});

test('een deck groter dan een kamer neemt: een eerlijke steekproef, niet de eerste 2000', () => {
  const cards = deck(3000);
  const seen = new Map(cards.map((c) => [c.id, 0]));
  const RUNS = 300;
  for (let r = 0; r < RUNS; r++) {
    const f = fitCards(cards, { rand: seededRandom(r + 7) });
    assert.equal(f.cards.length, MAX_CARDS);
    assert.equal(f.cut, 1000);
    for (const c of f.cards) seen.set(c.id, seen.get(c.id) + 1);
  }
  const late = cards.slice(2000).reduce((x, c) => x + seen.get(c.id), 0) / 1000;
  const early = cards.slice(0, 1000).reduce((x, c) => x + seen.get(c.id), 0) / 1000;
  assert.ok(late > RUNS * 0.6 && early < RUNS * 0.73, `kaart 2001-3000 doet mee (${late}), kaart 1-1000 niet altijd (${early})`);
});

test('artiesten verspreid: niets kwijt of dubbel, vast per seed, één artiest doet niets', () => {
  for (let s = 1; s <= 50; s++) {
    const cards = deck(200, 4 + (s % 7));
    const songs = byId(cards);
    const a = orderSongs(cards.map((c) => c.id), songs, { rand: seededRandom(s) });
    const b = orderSongs(cards.map((c) => c.id), songs, { rand: seededRandom(s) });
    assert.deepEqual(a, b, 'deterministisch');
    assert.deepEqual([...a].sort(), cards.map((c) => c.id).sort(), 'zelfde kaarten');
    // with 4+ artists a clash within the gap can be avoided nearly everywhere (a plain shuffle: ~100)
    const clashesOf = (l) => {
      let n = 0;
      for (let i = 1; i < l.length; i++) for (let k = Math.max(0, i - SPREAD_GAP); k < i; k++) if (artistKey(songs[l[i]]) === artistKey(songs[l[k]])) n++;
      return n;
    };
    const plain = clashesOf(shuffle(cards.map((c) => c.id), seededRandom(s)));
    assert.ok(clashesOf(a) < plain / 5, `seed ${s}: ${clashesOf(a)} keer dezelfde artiest kort na elkaar (gewoon geschud: ${plain})`);
  }
  const one = deck(50, 1);
  const list = one.map((c) => ({ ...c }));
  assert.deepEqual(spreadArtists(list).map((c) => c.id), list.map((c) => c.id), 'één artiest: niets te doen');
  assert.equal(artistKey({ artist: 'Beyoncé feat. Jay-Z' }), artistKey({ artist: 'BEYONCE' }), 'hoofdartiest, hoofdletters en accenten tellen niet');
  assert.equal(songKey({ title: 'Song - 2011 Remaster', artist: 'The Band' }), songKey({ title: 'Song', artist: 'band' }));
});

test('geschiedenis: niet gespeelde nummers eerst, dan de oudste; begrensd; seed uit crypto', () => {
  const cards = deck(40, 40);
  const songs = byId(cards);
  let h = nextGame(emptyHistory());
  h = markPlayed(h, cards.slice(0, 10)); // game 1 played 0..9
  h = nextGame(h);
  h = markPlayed(h, cards.slice(10, 20)); // game 2 played 10..19
  const order = orderSongs(cards.map((c) => c.id), songs, { rand: seededRandom(3), history: h });
  const idx = (id) => Number(id.slice(1));
  assert.ok(order.slice(0, 20).every((id) => idx(id) >= 20), 'eerst de 20 nooit gespeelde');
  assert.ok(order.slice(20, 30).every((id) => idx(id) < 10), 'dan die van het oudste spel');
  assert.ok(order.slice(30).every((id) => idx(id) >= 10 && idx(id) < 20), 'dan die van het laatste spel');
  // bounded
  let big = nextGame(emptyHistory());
  big = markPlayed(big, deck(HISTORY_MAX + 500, 9999));
  assert.equal(Object.keys(big.keys).length, HISTORY_MAX);
  assert.deepEqual(cleanHistory({ n: 1, keys: { __proto__: 1, x: 'y', ok: 1 } }).keys, { ok: 1 });
  assert.deepEqual(cleanHistory('rommel'), emptyHistory());
  const seeds = new Set(Array.from({ length: 100 }, gameSeed));
  assert.ok(seeds.size > 95 && [...seeds].every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32));
  // solo: createGame takes the history too
  const g = createGame({ names: ['A', 'B'], cards, seed: 9, history: h });
  const dealt = [...g.players.flatMap((p) => p.timeline), ...g.pile];
  assert.ok(dealt.slice(0, 20).every((id) => idx(id) >= 20), 'solo: ook eerst nieuwe nummers');
  // mix: songs not played yet first per player
  const contrib = { p1: { tracks: cards.slice(0, 30).map((c, i) => ({ spotifyId: `${'a'.repeat(16)}${String(i).padStart(6, '0')}`, title: c.title, artist: c.artist, year: c.year, sure: true, itunesId: c.itunesId })) } };
  const mix = buildMix(contrib, { seed: 4, need: 5, max: 10, history: h });
  assert.ok(mix.every((c) => idx(cards.find((x) => x.title === c.title).id) >= 20), 'mix: eerst niet gespeelde');
});

// ---------- the room server: rematch without repeats, history stays on the server ----------
const ORIGIN = 'http://localhost:8080';
const flush = () => new Promise((r) => setTimeout(r, 15));
function ws(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.2' });
  const msgs = [];
  const p = { msgs };
  p.conn = up.attach({ send: (text) => msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)), close: () => {} });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  return p;
}

test('kamer: een nieuw potje speelt eerst de nummers die nog niet gespeeld zijn; de geschiedenis blijft op de server', async () => {
  const now = 7_000_000;
  const core = createRoomServer({ now: () => now });
  const res = core.http({ method: 'POST', path: '/rooms', origin: ORIGIN, ip: '10.0.0.1', body: JSON.stringify({ v: V, id: 'owner01', name: 'Ilse', settings: { game: 'bingo', size: 3 } }) });
  const { code, token } = res.body;
  const host = ws(core, code);
  host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  const a = ws(core, code);
  a.send({ t: 'hello', v: V, code, id: 'playerA1', name: 'Sam' });
  const b = ws(core, code);
  b.send({ t: 'hello', v: V, code, id: 'playerB1', name: 'Lisa' });
  await flush();
  const cards = deck(30, 30).map((c) => ({ ...c, id: c.id.replace('c', '0') }));
  const playGame = async (rounds) => {
    host.send({ t: 'start', cards });
    await flush();
    const seen = [];
    for (let r = 0; r < rounds; r++) {
      const st = host.last('state');
      assert.ok(st.lead?.song, JSON.stringify(host.last('error')));
      seen.push(st.lead.song.title);
      host.send({ t: 'reveal' });
      await flush();
      if (r === rounds - 1) break; // the next song is never drawn
      host.send({ t: 'next' });
      await flush();
    }
    host.send({ t: 'lobby' });
    await flush();
    return seen;
  };
  const g1 = await playGame(12);
  const g2 = await playGame(12);
  assert.deepEqual(g2.filter((x) => g1.includes(x)), [], `g1 ${g1} / g2 ${g2}`);
  assert.equal(g2.filter((x) => g1.includes(x)).length, 0, 'potje 2: geen enkel nummer van potje 1 (er waren nog 18 ongespeelde)');
  const g3 = await playGame(10);
  assert.deepEqual(g3.slice(0, 6).filter((x) => g1.includes(x) || g2.includes(x)), [], 'potje 3: eerst de laatste 6 ongespeelde');
  assert.ok(g3.slice(6).every((x) => g1.includes(x)), 'daarna die van het oudste potje');
  // the history never reaches a player (no peeking): only server state and the owner's backup
  const playerText = JSON.stringify([...a.msgs, ...b.msgs]);
  assert.ok(!playerText.includes('"played"') && !playerText.includes('artiest 1|'), 'geen geschiedenis bij een speler');
  const snap = host.last('backup').snap;
  assert.equal(snap.played.n, 3);
  assert.ok(Object.keys(snap.played.keys).length >= 30 - 2);
  // after a Node restart (restore from the owner's backup) the history is still there
  const core2 = createRoomServer({ now: () => now });
  const r = core2.http({ method: 'POST', path: `/rooms/${code}/restore`, origin: ORIGIN, ip: '10.0.0.1', body: JSON.stringify({ v: V, id: 'owner01', token, snap }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.restored, true);
});
