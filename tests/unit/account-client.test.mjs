// The app's account module (app/js/account.js): the merge rule as a pure function (table),
// and the module itself against a real Node room server on a free port (Node's own fetch and
// WebSocket), with two "devices" that each have their own localStorage: sign up, log in on a
// second device, sync playlists and the Spotify Client ID both ways (also with a conflict and
// a deletion), saving in the background with a retry, prepared rooms up to "open" on the second
// device as spelleider with the real host session, log out, and an old server / no server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startNodeServer } from '../../server/node.mjs';
import { SERVER_PROTOCOL_VERSION } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const SPOTIFY = '0123456789abcdef0123456789abcdef';

// one localStorage per device; `use(name)` switches the browser
const devices = { A: new Map(), B: new Map() };
let storage = devices.A;
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)); },
  removeItem: (k) => { storage.delete(k); },
};
globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

const account = await import('../../app/js/account.js');
const playlists = await import('../../app/js/playlists.js');
const { SERVER_OVERRIDE_KEY, SERVER_HOST_KEY, createServerHostSession } = await import('../../app/js/multi/server-session.js');
const { mergeAccountData, ACCOUNT_KEY } = account;

const get = (k) => JSON.parse(storage.get(k) ?? 'null');
const set = (k, v) => storage.set(k, JSON.stringify(v));
function use(name) { storage = devices[name]; playlists.reload(); }
const useServer = (url) => { for (const d of Object.values(devices)) d.set(SERVER_OVERRIDE_KEY, JSON.stringify(url)); };

const pl = (id, updated, name = `Lijst ${id}`, n = 2) => ({
  id, name, created: 1, updated, nextN: n + 1,
  tracks: Array.from({ length: n }, (_, i) => ({ n: i + 1, itunesId: 100 + i, title: `T${i}`, artist: `A${i}`, album: '', year: 1980 + i, yearSure: true, previewUrl: null, trackViewUrl: null })),
});

async function until(fn, ms = 10000, what = 'voorwaarde') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`wacht te lang op ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let srv;
let base;
before(async () => {
  srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true, iterations: 1000 });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv?.close(); });

// ---------- the merge ----------
const ids = (s) => s.playlists.map((p) => `${p.id}@${p.updated}`).sort();
const MERGE_CASES = [
  {
    name: 'leeg account: alles van dit toestel gaat naar het account',
    local: { playlists: [pl('a', 5), pl('b', 6)], spotifyClientId: SPOTIFY },
    remote: { playlists: [], spotifyClientId: '' },
    want: ['a@5', 'b@6'], spotify: SPOTIFY, localChanged: false, remoteChanged: true,
    text: ['2 playlists van dit toestel toegevoegd aan je account', 'Spotify Client ID van dit toestel bewaard in je account'],
  },
  {
    name: 'leeg toestel: alles van het account komt hierheen',
    local: { playlists: [] },
    remote: { playlists: [pl('a', 5)], spotifyClientId: SPOTIFY },
    want: ['a@5'], spotify: SPOTIFY, localChanged: true, remoteChanged: false,
    text: ['1 playlist van je account op dit toestel gezet', 'Spotify Client ID van je account op dit toestel gezet'],
  },
  {
    name: 'zelfde playlist: de nieuwste wint (hier nieuwer)',
    local: { playlists: [pl('a', 9, 'Nieuw')] }, remote: { playlists: [pl('a', 5, 'Oud')] },
    want: ['a@9'], localChanged: false, remoteChanged: true, text: ['1 playlist in je account bijgewerkt'],
  },
  {
    name: 'zelfde playlist: de nieuwste wint (account nieuwer)',
    local: { playlists: [pl('a', 5, 'Oud')] }, remote: { playlists: [pl('a', 9, 'Nieuw')] },
    want: ['a@9'], localChanged: true, remoteChanged: false, text: ['1 playlist op dit toestel bijgewerkt'],
  },
  {
    name: 'gelijk: niets te doen',
    local: { playlists: [pl('a', 5)], spotifyClientId: SPOTIFY }, remote: { playlists: [pl('a', 5)], spotifyClientId: SPOTIFY },
    want: ['a@5'], spotify: SPOTIFY, localChanged: false, remoteChanged: false, text: [],
  },
  {
    name: 'Spotify: het account wint als het er een heeft',
    local: { spotifyClientId: 'ffffffffffffffffffffffffffffffff' }, remote: { spotifyClientId: SPOTIFY },
    want: [], spotify: SPOTIFY, localChanged: true, remoteChanged: false, text: ['Spotify Client ID van je account op dit toestel gezet'],
  },
  {
    name: 'hier weggegooid (grafsteen) na de laatste wijziging: ook uit het account',
    local: { playlists: [], deleted: { a: 10 } }, remote: { playlists: [pl('a', 5), pl('b', 5)] },
    want: ['b@5'], localChanged: true, remoteChanged: true,
  },
  {
    name: 'elders weggegooid: ook van dit toestel',
    local: { playlists: [pl('a', 5)] }, remote: { playlists: [], deleted: { a: 10 } },
    want: [], localChanged: true, remoteChanged: false, text: ['1 playlist van dit toestel verwijderd (op een ander toestel weggegooid)'],
  },
  {
    name: 'na het weggooien nog gewijzigd: hij komt terug',
    local: { playlists: [pl('a', 20)] }, remote: { playlists: [], deleted: { a: 10 } },
    want: ['a@20'], localChanged: false, remoteChanged: true, deletedLeft: [],
  },
  {
    name: 'voorkeuren: het account wint per veld, dit toestel vult aan',
    local: { prefs: { hostName: 'Ilse' } }, remote: { prefs: { hostPlays: true } },
    want: [], prefs: { hostPlays: true, hostName: 'Ilse' }, localChanged: false, remoteChanged: true,
  },
  {
    name: 'rommel in de invoer valt weg',
    local: { playlists: [null, { name: 'zonder id' }, pl('a', 5)] }, remote: null,
    want: ['a@5'], localChanged: false, remoteChanged: true,
  },
];

for (const c of MERGE_CASES) {
  test(`samenvoegen: ${c.name}`, () => {
    const m = mergeAccountData(c.local, c.remote);
    assert.deepEqual(ids(m.local), c.want);
    assert.deepEqual(ids(m.remote), c.want, 'both sides end up the same');
    if ('spotify' in c) assert.equal(m.local.spotifyClientId, c.spotify);
    if ('prefs' in c) assert.deepEqual(m.remote.prefs, c.prefs);
    if ('deletedLeft' in c) assert.deepEqual(Object.keys(m.remote.deleted), c.deletedLeft);
    assert.equal(m.localChanged, c.localChanged, 'localChanged');
    assert.equal(m.remoteChanged, c.remoteChanged, 'remoteChanged');
    if (c.text) assert.deepEqual(m.text, c.text);
  });
}

// ---------- against a server ----------
test('accountmodule: geen server of een oude server zonder accounts: doet niets, breekt niets', async () => {
  use('A');
  storage.set(SERVER_OVERRIDE_KEY, JSON.stringify('off'));
  assert.equal((await account.available()).code, 'noserver');
  assert.equal((await account.logIn('ilse', 'geheim-wachtwoord')).code, 'noserver');
  assert.equal(account.current(), null);
  const old = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ ok: true, v: V, service: 'timetunesr-rooms', features: ['screen'] }));
    else { res.statusCode = 404; res.end('{"exists":false}'); }
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  storage.set(SERVER_OVERRIDE_KEY, JSON.stringify(`http://127.0.0.1:${old.address().port}`));
  const a = await account.available({ fresh: true });
  assert.equal(a.code, 'noaccounts');
  assert.match(a.message, /kent nog geen accounts/);
  const r = await account.signUp('ilse', 'geheim-wachtwoord');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'noaccounts');
  assert.equal((await account.myRooms()).code, 'noaccounts');
  assert.equal(storage.has(ACCOUNT_KEY), false);
  old.close();
});

test('accountmodule: aanmelden, tweede toestel, playlists en Spotify Client ID beide kanten op, conflict, weggooien', async () => {
  useServer(base);
  await account.available({ fresh: true });
  // device A: one playlist and a Spotify Client ID before there is an account
  use('A');
  set('timetunesr.playlists.v1', { v: 1, lists: [pl('pA', 1000, 'Feest')] });
  set('timetunesr.spotify.clientId.v1', SPOTIFY);
  const s = await account.signUp('Ilse', 'geheim-wachtwoord');
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.match(s.recoveryCode, /^[2-9A-Z]{4}-/);
  assert.deepEqual(s.sync.text, ['1 playlist van dit toestel toegevoegd aan je account', 'Spotify Client ID van dit toestel bewaard in je account']);
  assert.deepEqual(account.current(), { username: 'Ilse', server: base });
  assert.equal(JSON.stringify(get(ACCOUNT_KEY)).includes('geheim-wachtwoord'), false, 'no password on the device');

  // device B: an own playlist, then log in
  use('B');
  set('timetunesr.playlists.v1', { v: 1, lists: [pl('pB', 2000, 'Kerst')] });
  const events = [];
  const off = account.subscribe((e) => events.push(e.type));
  const l = await account.logIn('ilse', 'geheim-wachtwoord');
  assert.equal(l.ok, true);
  assert.deepEqual(l.sync.text, ['1 playlist van dit toestel toegevoegd aan je account', '1 playlist van je account op dit toestel gezet', 'Spotify Client ID van je account op dit toestel gezet']);
  assert.deepEqual(playlists.all().map((p) => p.id).sort(), ['pA', 'pB'], 'playlists.js sees them at once');
  assert.equal(get('timetunesr.spotify.clientId.v1'), SPOTIFY);
  assert.deepEqual(events.slice(0, 2), ['login', 'sync']);
  off();

  // A changes its playlist and saves; B saves something too with an old rev: merged, nothing lost
  use('A');
  playlists.rename('pA', 'Feest 2');
  const pa = await account.push();
  assert.equal(pa.ok, true);
  use('B');
  playlists.rename('pB', 'Kerst 2');
  const pb = await account.push();
  assert.equal(pb.ok, true, JSON.stringify(pb));
  assert.deepEqual(playlists.all().map((p) => p.name).sort(), ['Feest 2', 'Kerst 2'], 'the conflict merged A\'s change in');
  use('A');
  const pull = await account.pull();
  assert.equal(pull.ok, true);
  // A already got pB with its own save (that one met B's login: a conflict, merged); now B's rename
  assert.deepEqual(pull.text, ['1 playlist op dit toestel bijgewerkt']);
  assert.deepEqual(playlists.all().map((p) => p.name).sort(), ['Feest 2', 'Kerst 2']);

  // B throws a playlist away: after a pull A has it no more (and nobody uploads it again)
  use('B');
  playlists.remove('pA');
  assert.equal((await account.push()).ok, true);
  use('A');
  const p2 = await account.pull();
  assert.deepEqual(p2.text, ['1 playlist van dit toestel verwijderd (op een ander toestel weggegooid)']);
  assert.deepEqual(playlists.all().map((p) => p.id), ['pB']);
  use('B');
  assert.deepEqual((await account.pull()).text, []);
});

test('accountmodule: opslaan op de achtergrond met vertraging, opnieuw proberen als de server weg was', async () => {
  use('A');
  useServer(base);
  const seen = [];
  const off = account.subscribe((e) => seen.push(e.type));
  // the server can not be reached for a moment (the network fails)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  playlists.create('Onderweg', { tracks: pl('x', 1).tracks });
  account.scheduleSave(10);
  await until(() => seen.includes('error'), 5000, 'fout bij opslaan');
  assert.equal(account.status().pending, true, 'kept for later');
  globalThis.fetch = realFetch;
  const r = await account.flush();
  assert.equal(r.ok, true);
  assert.equal(account.status().pending, false);
  use('B');
  await account.pull();
  assert.ok(playlists.all().some((p) => p.name === 'Onderweg'));
  off();
});

test('accountmodule: kamer klaarzetten, op het tweede toestel openen als spelleider, speler erbij, opnieuw gebruiken', async () => {
  useServer(base);
  use('A');
  const pid = playlists.all()[0].id;
  const r = await account.prepareRoom({ name: 'Feest zaterdag', settings: { game: 'disco', win: 'full' }, music: pid, play: 'preview', hostPlays: true, hostName: 'Ilse' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const code = r.room.code;
  const list = await account.myRooms();
  assert.deepEqual(list.rooms.map((x) => x.code), [code]);
  assert.equal(list.max, 5);
  assert.equal((await account.updateRoom(code, { name: 'Feest zondag' })).room.name, 'Feest zondag');

  // device B opens it and becomes the spelleider with the ordinary host session
  use('B');
  const o = await account.openRoom(code);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.music, { kind: 'playlist', id: pid, missing: false });
  assert.equal(get('timetunesr.activeDeck.v1'), pid, 'the room\'s playlist is the active deck');
  assert.equal(get('timetunesr.multiSettings.v1').win, 'full');
  assert.equal(get(SERVER_HOST_KEY).code, code);
  const host = createServerHostSession();
  assert.equal(host.resume(), true);
  await until(() => host.room, 8000, 'spelleider in de kamer');
  assert.equal(host.room.settings.game, 'disco');
  assert.equal(host.meta.roomName, 'Feest zondag');
  assert.deepEqual(host.room.players.map((p) => p.name), ['Ilse'], 'plays along');

  // a guest joins
  const ws = new WebSocket(`${base.replace('http', 'ws')}/rooms/${code}/ws`);
  const msgs = [];
  ws.onmessage = (e) => { if (e.data !== 'pong') msgs.push(JSON.parse(e.data)); };
  await new Promise((res) => { ws.onopen = res; });
  ws.send(JSON.stringify({ t: 'hello', v: V, code, id: 'gast0001', name: 'Sanne' }));
  await until(() => host.room?.players.length === 2, 5000, 'speler in de lobby');
  assert.equal(msgs.find((m) => m.t === 'state').meta.roomName, 'Feest zondag', 'the guest sees the name');

  // "Nog een keer gebruiken"
  const reset = await account.resetRoom(code);
  assert.equal(reset.ok, true);
  assert.equal(reset.room.code, code);
  await until(() => msgs.some((m) => m.t === 'error' && m.code === 'closed'), 5000, 'speler eruit');
  assert.equal((await account.myRooms()).rooms[0].players, 0);
  host.destroy();
  ws.close();
  assert.equal((await account.deleteRoom(code)).ok, true);
  assert.deepEqual((await account.myRooms()).rooms, []);
});

test('accountmodule: uitloggen (met of zonder de gegevens), overal uitloggen, wachtwoord wijzigen, account verwijderen', async () => {
  useServer(base);
  use('A');
  const tokenA = get(ACCOUNT_KEY).token;
  const ch = await account.changePassword('geheim-wachtwoord', 'nieuw-wachtwoord');
  assert.equal(ch.ok, true);
  assert.equal(ch.revoked, 1, 'device B is logged out');
  use('B');
  const events = [];
  const off = account.subscribe((e) => events.push(e));
  const p = await account.pull();
  assert.equal(p.ok, false);
  assert.equal(account.current(), null, 'a session the server no longer knows ends here too');
  assert.equal(events.find((e) => e.type === 'logout')?.reason, 'session');
  assert.ok(playlists.all().length > 0, 'the data stays on the device');
  off();
  // B logs in again and out without keeping the account's data
  assert.equal((await account.logIn('ilse', 'nieuw-wachtwoord')).ok, true);
  const tokenB = get(ACCOUNT_KEY).token;
  set('timetunesr.playlists.v1', { v: 1, lists: [...get('timetunesr.playlists.v1').lists, pl('eigen', 1, 'Alleen hier')] });
  playlists.reload();
  const out = await account.logOut({ keepData: false });
  assert.equal(out.ok, true);
  assert.deepEqual(playlists.all().map((x) => x.id), ['eigen'], 'only what was never in the account stays');
  assert.equal(storage.has('timetunesr.spotify.clientId.v1'), false);
  const gone = await fetch(`${base}/account`, { headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(gone.status, 401, 'the token is revoked on the server');
  // A: log out everywhere, then the account goes
  use('A');
  assert.equal(get(ACCOUNT_KEY).token, tokenA);
  assert.equal((await account.logOutEverywhere()).ok, true);
  assert.equal(account.current(), null);
  assert.equal((await account.logIn('ilse', 'nieuw-wachtwoord')).ok, true);
  assert.equal((await account.deleteAccount('verkeerd-wachtwoord')).ok, false);
  const d = await account.deleteAccount('nieuw-wachtwoord');
  assert.equal(d.ok, true);
  assert.equal(account.current(), null);
  assert.equal((await account.logIn('ilse', 'nieuw-wachtwoord')).code, 'login');
});
