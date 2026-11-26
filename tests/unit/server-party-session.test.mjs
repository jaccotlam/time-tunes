// The party extras through the sessions of server-session.js against a real Node room server
// over real WebSockets: a player's avatar (at the join and setAvatar), react() with its own
// cool-down, reactions arriving at the host session and the display session (onReaction,
// reactions) and not at the player, stamp(index, { joker }) on the wire, and a server without
// the 'party' feature: nothing is sent that it would answer with a fatal 'bad'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { startNodeServer } from '../../server/node.mjs';
import { SERVER_PROTOCOL_VERSION } from '../../app/js/multi/server-protocol.js';
import { REACT_GAP_MS } from '../../app/js/multi/party.js';

const V = SERVER_PROTOCOL_VERSION;
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const S = await import('../../app/js/multi/server-session.js');

const YEARS = Array.from({ length: 60 }, (_, i) => 1961 + i).filter((y) => y % 10 !== 0 && y % 10 !== 9);
const cards = YEARS.slice(0, 30).map((year, i) => ({ id: `c${i + 1}`, year, title: `Titel ${i + 1}`, artist: `Artiest ${i + 1}`, previewUrl: `https://example.invalid/${i + 1}.m4a` }));

async function until(fn, what = 'voorwaarde', ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`wacht te lang op ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function member(base, code) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/rooms/${code}/ws`);
  const msgs = [];
  ws.onmessage = (e) => { if (e.data !== 'pong') msgs.push(JSON.parse(e.data)); };
  const opened = new Promise((r) => { ws.onopen = r; });
  return { msgs, ws, send: async (m) => { await opened; ws.send(JSON.stringify(m)); }, last: (t) => [...msgs].reverse().find((m) => m.t === t) || null };
}

let srv;
let base;
before(async () => {
  srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
  storage.set(S.SERVER_OVERRIDE_KEY, JSON.stringify(base));
});
after(async () => { await srv?.close(); });

test('sessies: plaatje kiezen, reageren, reacties bij spelleider en groot scherm, joker-vlag op het lijntje', async () => {
  storage.set(S.SERVER_OVERRIDE_KEY, JSON.stringify(base));
  storage.set(S.AVATAR_KEY, JSON.stringify('🐼')); // the spelleider's own pick on this device
  storage.set('timetunesr.multiSettings.v1', JSON.stringify({ game: 'disco' }));
  const host = S.createServerHostSession();
  const done = [host];
  try {
    host.create({ hostPlays: true, hostName: 'Ilse' });
    await until(() => host.room && host.code && host.online, 'kamer');
    const code = host.code;
    const screen = S.createServerScreenSession({ code });
    done.push(screen);
    screen.start();
    await until(() => screen.online && screen.view, 'scherm');
    const got = { host: [], screen: [] };
    host.onReaction((r) => got.host.push(r));
    const off = screen.onReaction((r) => got.screen.push(r));
    // a player picks the unicorn when joining
    storage.delete(S.AVATAR_KEY);
    const p = S.createServerClientSession({ code, name: 'Anouk', avatar: '🦄' });
    done.push(p);
    p.start();
    await until(() => p.online && p.view, 'speler');
    assert.equal(S.storedAvatar(), '🦄', 'onthouden voor de volgende keer');
    assert.equal(p.avatar, '🦄');
    assert.equal(p.supports('party'), true);
    await until(() => screen.view.players.find((x) => x.id === p.playerId)?.avatar === '🦄', 'plaatje op het scherm');
    assert.equal(screen.view.players.find((x) => x.host).avatar, '🐼', 'de hallo van de spelleider neemt het bewaarde plaatje mee');
    assert.equal(p.setAvatar('kat'), false);
    assert.equal(p.setAvatar('🐸'), true);
    await until(() => screen.view.players.find((x) => x.id === p.playerId)?.avatar === '🐸', 'nieuw plaatje');
    assert.equal(host.setAvatar('🐙'), true);
    await until(() => screen.view.players.find((x) => x.host)?.avatar === '🐙', 'plaatje spelleider');
    // reactions: to the host session and the display, not to the player
    assert.equal(p.react('💩'), false);
    assert.equal(p.react('👏'), true);
    assert.equal(p.react('🔥'), false, 'eigen afkoeltijd');
    await until(() => got.screen.length === 1 && got.host.length === 1, 'reactie aangekomen');
    assert.deepEqual({ ...got.screen[0], at: 0, receivedAt: 0 }, { id: p.playerId, name: 'Anouk', avatar: '🐸', emoji: '👏', at: 0, receivedAt: 0 });
    assert.equal(screen.reactions.length, 1);
    assert.equal(host.reactions.at(-1).emoji, '👏');
    assert.ok(!p.received.some((m) => m.t === 'react'), 'de speler krijgt geen reacties');
    await sleep(REACT_GAP_MS + 50);
    assert.equal(host.react('🎉'), true, 'de meespelende spelleider mag ook');
    await until(() => got.screen.length === 2, 'reactie spelleider');
    assert.equal(got.host.length, 2, 'ook terug bij de spelleider zelf (die is het grote scherm-in-het-klein)');
    off();
    // the joker flag goes over the wire: without a joker the server says so
    host.start(cards);
    await until(() => p.view?.phase === 'answering' && host.room?.phase === 'answering', 'spel');
    host.reveal();
    await until(() => p.view.phase === 'revealed', 'onthuld');
    p.stamp(0, { joker: true });
    const n = await until(() => p.takeNotice(), 'melding');
    assert.match(n.message, /joker|vakje/);
    assert.equal(p.status, 'online', 'een gewone weigering');
  } finally {
    for (const x of done) x.destroy();
  }
});

test('sessies: een server zonder de party-feature krijgt geen avatar- of reactiebericht', async () => {
  const seen = [];
  const http = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.url === '/health') res.end(JSON.stringify({ ok: true, v: V, service: 'timetunesr-rooms', features: ['screen'] }));
    else if (req.url === '/rooms/ABCD') res.end(JSON.stringify({ exists: true }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    seen.push(m.t);
    if (m.t === 'hello') {
      ws.send(JSON.stringify({ t: 'welcome', v: V, id: m.id, code: 'ABCD', token: 'x'.repeat(20) }));
      ws.send(JSON.stringify({ t: 'state', view: { phase: 'lobby', game: null, players: [] }, meta: {} }));
    }
  }));
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  storage.set(S.SERVER_OVERRIDE_KEY, JSON.stringify(`http://127.0.0.1:${http.address().port}`));
  try {
    const p = S.createServerClientSession({ code: 'ABCD', name: 'Anouk', avatar: '🦄' });
    p.start();
    await until(() => p.online && p.view, 'oude server');
    assert.equal(p.supports('party'), false);
    assert.equal(p.setAvatar('🐸'), false);
    assert.equal(p.react('👏'), false);
    await sleep(100);
    assert.deepEqual(seen, ['hello'], 'alleen de hallo (een oude server negeert het extra veld avatar)');
    assert.equal(p.status, 'online');
    p.destroy();
  } finally {
    storage.set(S.SERVER_OVERRIDE_KEY, JSON.stringify(base));
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => http.close(r));
  }
});
