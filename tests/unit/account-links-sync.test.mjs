// The account sync of the Spotify links and the Client ID as a THREE-WAY merge (account.js
// mergeAccountData with the base = the account as this device last synced it): an edit on a
// device with an account (add / rename / remove / reorder) reaches the account and survives the
// next pull; an edit on another device comes here; both at once are merged per link; a fresh
// device takes the account's. Against a real Node room server: a save right after an offline
// start keeps the links (the features are known first), and a server without 'account-links'
// settles (no save on every sync).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startNodeServer } from '../../server/node.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccc';
const D = 'dddddddddddddddddddddddddddddddd';
const LINKS_KEY = 'timetunesr.spotify.links.v1';
const CID_KEY = 'timetunesr.spotify.clientId.v1';

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
const spotify = await import('../../app/js/spotify.js');
const { SERVER_OVERRIDE_KEY } = await import('../../app/js/multi/server-session.js');
const { mergeAccountData, linkMerge, ACCOUNT_KEY } = account;

const use = (name) => { storage = devices[name]; };
const get = (k) => JSON.parse(storage.get(k) ?? 'null');
const useServer = (url) => { for (const d of Object.values(devices)) d.set(SERVER_OVERRIDE_KEY, JSON.stringify(url)); };
const ids = (list) => list.map((l) => `${l.id[0]}${l.name ? `:${l.name}` : ''}`);

let srv;
let base;
before(async () => {
  srv = await startNodeServer({ port: 0, host: '127.0.0.1', quiet: true, iterations: 1000 });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv?.close(); });

/* ---------- the merge (pure) ---------- */

const two = [{ id: A, name: 'familie' }, { id: B, name: '' }];
const acct = (links, cid = A) => ({ spotifyClientId: cid, spotifyLinks: links });

test('drieweg: alleen hier gewijzigd (toevoegen, hernoemen, weghalen, verschuiven) gaat naar het account', () => {
  for (const [why, local] of [
    ['toevoegen', [...two, { id: C, name: 'werk' }]],
    ['hernoemen', [{ id: A, name: 'gezin' }, two[1]]],
    ['weghalen', [two[0]]],
    ['verschuiven', [two[1], two[0]]],
  ]) {
    const m = mergeAccountData(acct(local, A), acct(two), acct(two));
    assert.deepEqual(m.local.spotifyLinks, local, `${why}: dit toestel houdt zijn wijziging`);
    assert.deepEqual(m.remote.spotifyLinks, local, `${why}: en het account krijgt hem`);
    assert.equal(m.localChanged, false, why);
    assert.equal(m.remoteChanged, true, why);
    // without a base (the merge as it was) the account's list won and the edit was undone
    const old = mergeAccountData(acct(local, A), acct(two));
    assert.deepEqual(old.local.spotifyLinks, two, `${why}: zonder basis (nieuw toestel) wint het account`);
  }
});

test('drieweg: alleen in het account gewijzigd komt hierheen; beide gelijk: niets te doen', () => {
  const there = [{ id: A, name: 'familie' }, { id: B, name: 'vrienden' }, { id: C, name: '' }];
  const m = mergeAccountData(acct(two), acct(there), acct(two));
  assert.deepEqual(m.local.spotifyLinks, there);
  assert.equal(m.localChanged, true);
  assert.equal(m.remoteChanged, false);
  assert.deepEqual(m.text, ['Spotify-links van je account op dit toestel gezet']);
  const same = mergeAccountData(acct(two), acct(two), acct(two));
  assert.equal(same.localChanged || same.remoteChanged, false);
});

test('drieweg: hier en in het account gewijzigd: de lijst van het account, met wat alleen hier veranderde erbij', () => {
  // here: C added, B removed, A renamed; there: D added, B renamed? no: B untouched there
  const here = [{ id: A, name: 'gezin' }, { id: C, name: 'werk' }];
  const there = [{ id: B, name: '' }, { id: A, name: 'familie' }, { id: D, name: 'club' }];
  const m = mergeAccountData(acct(here), acct(there), acct(two));
  assert.deepEqual(ids(m.local.spotifyLinks), ['a:gezin', 'd:club', 'c:werk'], 'volgorde van het account, B hier weggehaald, A hier hernoemd, C hier toegevoegd');
  assert.deepEqual(m.remote.spotifyLinks, m.local.spotifyLinks);
  assert.equal(m.localChanged && m.remoteChanged, true);
  // renamed in both places: the account's name; removed in the account: stays removed
  assert.deepEqual(ids(linkMerge([{ id: A, name: 'hier' }, two[1]], [{ id: A, name: 'daar' }], two)), ['a:daar']);
  // added here beyond the maximum: cut off at 10
  const many = Array.from({ length: 12 }, (_, i) => ({ id: (i + 1).toString(16).padStart(32, '0'), name: '' }));
  assert.equal(linkMerge(many, [two[0], { id: D, name: '' }], two).length, 10);
});

test('drieweg: de eigen Client ID en de naam van de spelleider', () => {
  // changed here only: uploaded (before: the account's always won)
  let m = mergeAccountData({ spotifyClientId: B, spotifyLinks: two }, acct(two, A), acct(two, A));
  assert.equal(m.remote.spotifyClientId, B);
  assert.equal(m.remoteChanged, true);
  assert.equal(m.localChanged, false);
  // changed in the account only: comes here
  m = mergeAccountData({ spotifyClientId: A, spotifyLinks: two }, acct(two, B), acct(two, A));
  assert.equal(m.local.spotifyClientId, B);
  assert.equal(m.localChanged, true);
  // both: the account's
  m = mergeAccountData({ spotifyClientId: C, spotifyLinks: [...two, { id: C, name: '' }] }, acct(two, B), acct(two, A));
  assert.equal(m.local.spotifyClientId, B);
  assert.ok(m.local.spotifyLinks.some((l) => l.id === C), 'the link added here stays');
  // an app of before changed only spotifyClientId (no list in the account): it takes the place of the own link
  m = mergeAccountData({ spotifyClientId: A, spotifyLinks: two }, { spotifyClientId: C }, { spotifyClientId: A });
  assert.deepEqual(ids(m.local.spotifyLinks), ['c:familie', 'b']);
  // a single Client ID typed on a device with an account of before: uploaded, kept after the next pull
  m = mergeAccountData({ spotifyClientId: C }, { spotifyClientId: A }, { spotifyClientId: A });
  assert.equal(m.remote.spotifyClientId, C);
  assert.equal(m.remoteChanged, true);
  // the spelleider's name: changed here -> account; changed there -> here
  m = mergeAccountData({ prefs: { hostName: 'Ilse B' } }, { prefs: { hostName: 'Ilse' } }, { prefs: { hostName: 'Ilse' } });
  assert.equal(m.remote.prefs.hostName, 'Ilse B');
  assert.equal(m.remoteChanged, true);
  m = mergeAccountData({ prefs: { hostName: 'Ilse' } }, { prefs: { hostName: 'Ilse C' } }, { prefs: { hostName: 'Ilse' } });
  assert.equal(m.local.prefs.hostName, 'Ilse C');
  assert.equal(m.localChanged, true);
  // a fresh device (no base): the account wins as before
  m = mergeAccountData({ spotifyClientId: C, spotifyLinks: [{ id: C, name: 'x' }, { id: D, name: '' }] }, acct(two, A), null);
  assert.deepEqual(m.local.spotifyLinks, two);
  assert.equal(m.local.spotifyClientId, A);
});

test('drieweg: een server zonder links (opts.links false): de lijst van dit toestel blijft en telt niet als wijziging', () => {
  const m = mergeAccountData({ spotifyClientId: A, spotifyLinks: two }, { spotifyClientId: A }, { spotifyClientId: A }, { links: false });
  assert.deepEqual(m.local.spotifyLinks, two);
  assert.equal(m.remoteChanged, false, 'nothing to save: the server can not keep it anyway');
  assert.equal(m.localChanged, false);
});

/* ---------- against a server ---------- */

test('opslaan na een start zonder netwerk: de links gaan mee (eerst weten wat de server kan)', async () => {
  // this process has never asked /health: the session was made "earlier", then the app started offline
  useServer(base);
  use('A');
  const signup = await (await fetch(`${base}/account/signup`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ username: 'offline1', password: 'geheim-wachtwoord' }) })).json();
  assert.ok(signup.token);
  const now = await (await fetch(`${base}/account`, { headers: { authorization: `Bearer ${signup.token}` } })).json();
  storage.set(ACCOUNT_KEY, JSON.stringify({ username: 'offline1', token: signup.token, server: base, rev: now.rev, data: now.data, synced: [], at: Date.now() }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await account.pull()).ok, false, 'offline: the pull fails, /health was never answered');
  globalThis.fetch = realFetch;
  // the network is back; the host sets two links and the save goes out
  spotify.setLinks([{ id: A, name: 'familie' }, { id: B, name: 'vrienden' }]);
  const r = await account.push();
  assert.equal(r.ok, true, JSON.stringify(r));
  const acc = await account.fetchAccount();
  assert.deepEqual(ids(acc.data.spotifyLinks), ['a:familie', 'b:vrienden'], 'the links are in the account');
  await account.logOut();
  for (const d of Object.values(devices)) for (const k of [...d.keys()]) if (k !== SERVER_OVERRIDE_KEY) d.delete(k);
});

test('links bewerken op een toestel met een account: bereikt het account, blijft na de volgende pull, tweede toestel krijgt het', async () => {
  useServer(base);
  use('A');
  spotify.setLinks([{ id: A, name: 'familie' }, { id: B, name: '' }]);
  assert.equal((await account.signUp('links1', 'geheim-wachtwoord')).ok, true);
  assert.deepEqual(ids((await account.fetchAccount()).data.spotifyLinks), ['a:familie', 'b']);
  const steps = [
    ['toevoegen', () => spotify.setLinks([...spotify.getLinks(), { id: C, name: 'werk' }]), ['a:familie', 'b', 'c:werk']],
    ['hernoemen', () => spotify.renameLink(A, 'gezin'), ['a:gezin', 'b', 'c:werk']],
    ['verschuiven', () => spotify.setLinks([spotify.getLinks()[2], spotify.getLinks()[0], spotify.getLinks()[1]]), ['c:werk', 'a:gezin', 'b']],
    ['weghalen', () => spotify.setLinks(spotify.getLinks().filter((l) => l.id !== B)), ['c:werk', 'a:gezin']],
  ];
  for (const [why, edit, want] of steps) {
    use('A');
    edit();
    assert.equal((await account.push()).ok, true, why);
    assert.deepEqual(ids((await account.fetchAccount()).data.spotifyLinks), want, `${why}: in het account`);
    assert.equal((await account.pull()).ok, true);
    assert.deepEqual(ids(spotify.getLinks()), want, `${why}: blijft na de volgende pull`);
  }
  // the own link was A all along (it moved, it stays the own one)
  assert.equal(spotify.getClientId(), A);
  // a second device logs in: it gets the list
  use('B');
  assert.equal((await account.logIn('links1', 'geheim-wachtwoord')).ok, true);
  assert.deepEqual(ids(spotify.getLinks()), ['c:werk', 'a:gezin']);
  // both edit before they sync: A adds D, B renames C; both survive
  use('A');
  spotify.setLinks([...spotify.getLinks(), { id: D, name: 'club' }]);
  use('B');
  spotify.renameLink(C, 'kantoor');
  assert.equal((await account.push()).ok, true);
  use('A');
  assert.equal((await account.push()).ok, true, 'a conflict, merged three-way');
  assert.deepEqual(ids(spotify.getLinks()), ['c:kantoor', 'a:gezin', 'd:club']);
  use('B');
  assert.equal((await account.pull()).ok, true);
  assert.deepEqual(ids(spotify.getLinks()), ['c:kantoor', 'a:gezin', 'd:club']);
  // the single Client ID (the own link) chosen on B reaches A
  spotify.setLinks(spotify.getLinks(), { own: 2 });
  assert.equal((await account.push()).ok, true);
  use('A');
  assert.equal((await account.pull()).ok, true);
  assert.equal(spotify.getClientId(), D);
  assert.equal(get(CID_KEY), D);
  for (const n of ['A', 'B']) { use(n); await account.logOut(); }
});

test('een server zonder links (geen account-links): na de eerste sync wordt niet steeds opnieuw opgeslagen', async () => {
  // a proxy in front of the real server whose /health leaves 'account-links' out
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(`${base}${req.url}`, { method: req.method, headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), 'content-type': req.headers['content-type'] || 'text/plain' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    let text = await r.text();
    if (req.url === '/health') { const j = JSON.parse(text); j.features = j.features.filter((f) => f !== 'account-links'); text = JSON.stringify(j); }
    res.writeHead(r.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    res.end(text);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  useServer(url);
  use('A');
  for (const k of [...storage.keys()]) if (k !== SERVER_OVERRIDE_KEY) storage.delete(k);
  spotify.setLinks([{ id: A, name: 'familie' }, { id: B, name: 'vrienden' }]);
  assert.equal((await account.signUp('oudeserver', 'geheim-wachtwoord')).ok, true);
  const rev1 = (await account.fetchAccount()).rev;
  assert.equal((await account.pull()).ok, true);
  assert.equal((await account.pull()).ok, true);
  assert.equal((await account.push()).ok, true);
  const acc = await account.fetchAccount();
  assert.equal(acc.rev, rev1, 'no save on every sync');
  assert.equal('spotifyLinks' in acc.data, false, 'the list never went to that server');
  assert.deepEqual(ids(spotify.getLinks()), ['a:familie', 'b:vrienden'], 'and stays on this device');
  await account.logOut();
  proxy.close();
});
