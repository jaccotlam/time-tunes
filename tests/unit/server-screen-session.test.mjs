// The display's session (createServerScreenSession in server-session.js) against a real Node
// room server on a free port, over real WebSockets (Node's own WebSocket and fetch): it gets
// the view and meta, keeps the server's clock, never touches the spelleider's or a player's
// localStorage, comes back after a server restart once the spelleider has put the room back,
// and says it neatly when the server is too old for a display or the room has enough displays.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { startNodeServer } from '../../server/node.mjs';
import { SERVER_PROTOCOL_VERSION, cardsForServer } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;

// a browser's localStorage, recording every key that is read or written
const storage = new Map();
const touched = { get: new Set(), set: new Set(), remove: new Set() };
globalThis.localStorage = {
  getItem: (k) => { touched.get.add(k); return storage.has(k) ? storage.get(k) : null; },
  setItem: (k, v) => { touched.set.add(k); storage.set(k, String(v)); },
  removeItem: (k) => { touched.remove.add(k); storage.delete(k); },
};
globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

const { createServerScreenSession, SERVER_OVERRIDE_KEY } = await import('../../app/js/multi/server-session.js');
const useServer = (url) => storage.set(SERVER_OVERRIDE_KEY, JSON.stringify(url));

const cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, year: 1961 + i, title: `Titel ${i + 1}`, artist: `Artiest ${i + 1}`, previewUrl: `https://example.invalid/${i + 1}.m4a` }));

async function until(fn, ms = 15000, what = 'voorwaarde') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`wacht te lang op ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A plain WebSocket client in the role of the spelleider or a player. */
function member(base, code) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/rooms/${code}/ws`);
  const msgs = [];
  ws.onmessage = (e) => { if (e.data !== 'pong') msgs.push(JSON.parse(e.data)); };
  const opened = new Promise((r) => { ws.onopen = r; });
  return {
    msgs, ws,
    send: async (m) => { await opened; ws.send(JSON.stringify(m)); },
    last: (t) => [...msgs].reverse().find((m) => m.t === t) || null,
  };
}

let srv;
let base;
before(async () => {
  srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv?.close(); });

async function newRoom() {
  const r = await fetch(`${base}/rooms`, { method: 'POST', body: JSON.stringify({ v: V, id: 'owner01', name: 'Ilse', settings: { game: 'disco' } }) });
  const { code, token } = await r.json();
  const host = member(base, code);
  await host.send({ t: 'hello', v: V, code, id: 'owner01', token });
  await until(() => host.last('welcome'), 5000, 'welkom spelleider');
  return { code, token, host };
}

test('schermsessie: weergave, meta, servertijd, geen eigen sleutels in localStorage', async () => {
  useServer(base);
  const { code, host } = await newRoom();
  const a = member(base, code);
  await a.send({ t: 'hello', v: V, code, id: 'playerA1', name: 'Anouk' });
  for (const k of Object.keys(touched)) touched[k].clear();
  const s = createServerScreenSession({ code });
  let changes = 0;
  const off = s.subscribe(() => { changes++; });
  assert.equal(s.isScreen, true);
  assert.equal(s.status, 'idle');
  s.start();
  await until(() => s.online && s.view, 8000, 'scherm online');
  assert.equal(s.status, 'online');
  assert.equal(s.meta.screen, true);
  assert.equal(s.meta.screens, 1);
  assert.equal(s.view.you, null);
  assert.deepEqual(s.view.players.map((p) => p.name), ['Anouk']);
  assert.ok(Math.abs(s.serverNow() - Date.now()) < 2000);
  assert.ok(changes > 0, 'subscribe meldt veranderingen');
  await until(() => host.last('state')?.meta.screens === 1, 3000, 'spelleider ziet het scherm');
  // a game: the display follows
  await host.send({ t: 'start', cards: cardsForServer(cards), seed: 5 });
  await until(() => s.view?.phase === 'answering', 3000, 'spel gestart');
  assert.equal(s.view.game.kind, 'disco');
  assert.equal(s.view.game.mine, null);
  assert.ok(!JSON.stringify(s.received).includes('example.invalid'));
  assert.equal(s.diag.role, 'screen');
  assert.match(await s.diagText(), /Rol: groot scherm · kamer/);
  // localStorage: only the per-browser server address is read; nothing written or removed
  assert.deepEqual([...touched.get], [SERVER_OVERRIDE_KEY]);
  assert.equal(touched.set.size, 0);
  assert.equal(touched.remove.size, 0);
  // leave: the server counts one display less
  off();
  s.leave();
  await until(() => host.last('state')?.meta.screens === 0, 3000, 'scherm weg');
  host.ws.close();
  a.ws.close();
});

test('schermsessie: te veel schermen = nette melding; onbekende kamer = wachten', async () => {
  useServer(base);
  const { code, host } = await newRoom();
  const many = [];
  for (let i = 0; i < 4; i++) { const s = createServerScreenSession({ code }); s.start(); many.push(s); }
  await until(() => many.every((s) => s.online), 8000, 'vier schermen');
  const fifth = createServerScreenSession({ code });
  fifth.start();
  await until(() => fifth.error, 8000, 'vijfde scherm geweigerd');
  assert.equal(fifth.error.code, 'screens');
  assert.equal(fifth.status, 'closed');
  for (const s of many) s.destroy();
  const none = createServerScreenSession({ code: 'BCDF' });
  none.start();
  await until(() => none.status === 'notfound', 8000, 'kamer niet gevonden');
  assert.equal(none.error, null, 'geen fout: het scherm blijft wachten');
  none.destroy();
  fifth.destroy();
  host.ws.close();
});

test('schermsessie: na een herstart van de server wacht het scherm en komt terug als de spelleider de kamer terugzet', async () => {
  const { code, token, host } = await newRoom();
  const snap = (await until(() => host.last('backup'), 3000, 'back-up')).snap;
  // a second server that will "restart" on its own port
  let s2 = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = s2.port;
  const b2 = `http://127.0.0.1:${port}`;
  await fetch(`${b2}/rooms/${code}/restore`, { method: 'POST', body: JSON.stringify({ v: V, id: 'owner01', token, snap }) });
  useServer(b2);
  const s = createServerScreenSession({ code });
  s.start();
  await until(() => s.online && s.view, 8000, 'scherm online');
  await s2.close();
  await until(() => s.status !== 'online', 8000, 'verbinding weg');
  s2 = await startNodeServer({ port, host: '127.0.0.1', quiet: true });
  await until(() => s.status === 'notfound', 15000, 'kamer weg na herstart');
  const r = await fetch(`${b2}/rooms/${code}/restore`, { method: 'POST', body: JSON.stringify({ v: V, id: 'owner01', token, snap }) });
  assert.equal(r.status, 200);
  await until(() => s.online, 15000, 'scherm terug');
  assert.equal(s.meta.restored, true);
  assert.equal(s.error, null);
  s.destroy();
  await s2.close();
  host.ws.close();
});

/** A server of before the display: /health without features; a hello without id gets 'bad'. */
async function oldServer({ features }) {
  const http = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.url === '/health') res.end(JSON.stringify({ ok: true, v: V, service: 'timetunesr-rooms', ...(features ? { features } : {}) }));
    else res.end(JSON.stringify({ exists: true, phase: 'lobby', players: 0, leaderOnline: true }));
  });
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'hello' && !m.id) { ws.send(JSON.stringify({ t: 'error', code: 'bad', message: 'Onbekende speler.' })); setTimeout(() => ws.close(4000, 'bad'), 50); }
  }));
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${http.address().port}`, close: () => { for (const c of wss.clients) c.terminate(); return new Promise((r) => http.close(r)); } };
}

test('schermsessie: een oudere server (zonder groot scherm) geeft een nette melding', async () => {
  // its /health does not list 'screen': the display does not even try
  const o1 = await oldServer({ features: null });
  useServer(o1.url);
  const s = createServerScreenSession({ code: 'BCDF' });
  s.start();
  await until(() => s.error, 8000, 'melding');
  assert.equal(s.error.code, 'noscreen');
  assert.match(s.error.message, /kent het grote scherm nog niet/);
  s.destroy();
  await o1.close();
  // a server that says it does but answers the hello like the old one: the same message
  const o2 = await oldServer({ features: ['screen'] });
  useServer(o2.url);
  const s2 = createServerScreenSession({ code: 'BCDF' });
  s2.start();
  await until(() => s2.error, 8000, 'melding');
  assert.equal(s2.error.code, 'noscreen');
  s2.destroy();
  await o2.close();
  // no server configured at all
  useServer('off');
  const s3 = createServerScreenSession({ code: 'BCDF' });
  s3.start();
  assert.equal(s3.error.code, 'noserver');
  assert.equal(s3.status, 'closed');
});
