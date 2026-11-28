// Spotify logins per link on the phone (spotify.js) and the guest's link chooser (mix-share.js),
// from the review of the links: a refresh that finishes after a switch of link never overwrites
// the login in use; removing a link forgets only that link's login; Client IDs in one case;
// a token of before v3-11 is adopted; a friend's shared setting ADDS a link; a refused link is
// forgotten; the playlists and top-songs calls give the friendly "not on this link" step; the
// link index is reported again when the room's list changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const sp = await import('../../app/js/spotify.js');
const { createMixShare, LINK_KEY } = await import('../../app/js/multi/mix-share.js');
const { spotifyListProvider } = await import('../../app/js/multi/mix-spotify.js');

const L1 = '11111111111111111111111111111111';
const L2 = '22222222222222222222222222222222';
const L3 = 'abcdefabcdefabcdefabcdefabcdefab';
const K = { cid: 'timetunesr.spotify.clientId.v1', token: 'timetunesr.spotify.token.v1', tokens: 'timetunesr.spotify.tokens.v1', links: 'timetunesr.spotify.links.v1' };
const SCOPES = 'user-read-playback-state user-modify-playback-state user-top-read playlist-read-private playlist-read-collaborative';
const tok = (cid, at, exp = Date.now() + 3600e3) => ({ access_token: at, refresh_token: `r-${at}`, expires_at: exp, scope: SCOPES, ...(cid ? { clientId: cid } : {}) });
const get = (k) => JSON.parse(mem.get(k) ?? 'null');
const set = (k, v) => mem.set(k, JSON.stringify(v));
const reset = () => mem.clear();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('verversen terwijl de telefoon van link wisselt: de nieuwe token van app A komt bij de bewaarde, nooit over die van B', async () => {
  reset();
  set(K.cid, L1);
  sp.setLinks([{ id: L1, name: '' }, { id: L2, name: '' }]);
  set(K.token, tok(L1, 'a-old', Date.now() - 1000)); // expired: the next call refreshes
  set(K.tokens, { [L2]: tok(L2, 'b-1') });
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('accounts.spotify.com')) { await gate; return json(200, { access_token: 'a-new', expires_in: 3600, refresh_token: 'r-a2' }); }
    seen.push(opts.headers.Authorization);
    return json(200, { id: 'me' });
  };
  const call = sp.api('/me');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sp.useClientToken(L2), true, 'switch to link 2 while A refreshes');
  release();
  await call;
  assert.equal(get(K.token).access_token, 'b-1', 'the login in use (B) stays');
  assert.equal(get(K.tokens)[L1].access_token, 'a-new', 'A\'s fresh token is kept for A');
  assert.deepEqual(seen, ['Bearer a-new'], 'and A\'s call went out with A\'s token');
  delete globalThis.fetch;
});

test('een link weghalen: alleen de login van die link gaat; de eigen link weghalen wist de andere logins niet', () => {
  reset();
  set(K.cid, L1);
  sp.setLinks([{ id: L1, name: '' }, { id: L2, name: '' }, { id: L3, name: '' }]);
  set(K.token, tok(L1, 'a'));
  set(K.tokens, { [L2]: tok(L2, 'b'), [L3]: tok(L3, 'c') });
  sp.setLinks(sp.getLinks().filter((l) => l.id !== L3));
  assert.deepEqual(Object.keys(get(K.tokens)), [L2], 'link 3\'s login is forgotten');
  // the own link (1) goes and link 2 becomes the own one: its kept login is used, nothing else lost
  set(K.tokens, { [L2]: tok(L2, 'b'), [L3]: tok(L3, 'c') }); // (link 3's of a guest's room: no link here, but kept)
  sp.setLinks([{ id: L2, name: '' }]);
  assert.equal(sp.connectedClientId(), L2);
  assert.deepEqual(Object.keys(get(K.tokens)).sort(), [L3], 'link 1 (removed) has no login left, link 3\'s (no link of this host before either) stays');
  // the own link replaced by one without a login: the current login is put aside, not wiped with all others
  sp.setLinks([{ id: L2, name: '' }, { id: L1, name: '' }]);
  set(K.tokens, { [L3]: tok(L3, 'c') });
  sp.setLinks(sp.getLinks(), { own: 1 });
  assert.equal(sp.isConnected(), false);
  assert.deepEqual(Object.keys(get(K.tokens)).sort(), [L2, L3], 'link 2\'s login is kept for later');
});

test('Client IDs in één schrijfwijze: hoofdletters opgeslagen worden kleine letters, één bewaarde login per app', () => {
  reset();
  set(K.cid, L3.toUpperCase());
  assert.equal(sp.getClientId(), L3);
  assert.equal(get(K.cid), L3, 'migrated');
  set(K.token, tok(L1, 'a'));
  set(K.tokens, { [L3.toUpperCase()]: tok(L3.toUpperCase(), 'c') });
  assert.equal(sp.useClientToken(L3), true);
  assert.equal(sp.connectedClientId(), L3);
  assert.deepEqual(Object.keys(get(K.tokens)), [L1]);
  sp.setClientId(L2.toUpperCase());
  assert.equal(get(K.cid), L2);
});

test('een token van vóór v3-11 (zonder clientId) wordt overgenomen onder de eigen Client ID en gaat bij wisselen niet verloren', () => {
  reset();
  set(K.cid, L1);
  sp.setLinks([{ id: L1, name: '' }, { id: L2, name: '' }]);
  set(K.token, tok(null, 'old'));
  set(K.tokens, { [L2]: tok(L2, 'b') });
  assert.equal(sp.useClientToken(L2), true);
  assert.equal(get(K.tokens)[L1]?.access_token, 'old', 'kept under link 1');
  assert.equal(sp.useClientToken(L1), true);
  assert.equal(get(K.token).access_token, 'old');
});

test('een gedeelde instelling van een vriend VOEGT een link toe (alle links blijven) en wordt de eigen login', () => {
  reset();
  set(K.cid, L1);
  sp.setLinks([{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }]);
  assert.equal(sp.addLink(L3, { name: 'Sam' }), 'added');
  assert.deepEqual(sp.getLinks(), [{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }, { id: L3, name: 'Sam' }]);
  assert.equal(sp.getClientId(), L3);
  assert.equal(sp.addLink(L1), 'known');
  assert.equal(sp.getLinks().length, 3);
  assert.equal(sp.getClientId(), L1);
  sp.setLinks(Array.from({ length: 10 }, (_, i) => ({ id: (i + 1).toString(16).padStart(32, '0') })));
  assert.equal(sp.addLink(L3), 'full');
  assert.equal(sp.getLinks().length, 10);
  assert.equal(sp.addLink('geen-id'), 'bad');
});

/* ---------- the guest's link chooser ---------- */

function fakeSession(links) {
  const s = { online: true, reports: [], meta: { spotifyLinks: links, mix: { mine: 0 }, myLink: null, play: 'spotify' } };
  s.reportLink = (i) => { s.reports.push(i); return true; };
  s.mixAdd = () => true;
  s.mixClear = () => true;
  s.supports = () => true;
  return s;
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

test('kiezen van link: 403 op de favorieten of op de eigen playlists (terwijl /me 200 gaf) geeft "je staat niet op deze link"; de geweigerde link wordt vergeten', async () => {
  reset();
  const links = [{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }];
  const session = fakeSession(links);
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/me') return json(200, { id: 'gast', display_name: 'Gast' });
    return json(403, { error: { status: 403, message: 'Forbidden' } });
  };
  // the guest chose link 1 earlier and is logged in through it (and through link 2, kept)
  set(LINK_KEY, { code: 'ROOM', id: L1, verified: true, at: Date.now() });
  set(K.token, tok(L1, 'a'));
  set(K.tokens, { [L2]: tok(L2, 'b') });
  const ms = createMixShare({ code: 'ROOM', memberId: () => 'gast0001', session, returnHash: '#/kamer/ROOM', onChange() {}, listProvider: spotifyListProvider() });
  ms.share();
  await until(() => ms.linkState().step === 'refused');
  assert.equal(ms.linkState().refused.id, L1);
  assert.equal(ms.state.phase, 'idle', 'no technical error');
  assert.equal(get(LINK_KEY), null, 'the refused choice is forgotten: after a reload the guest is asked again');
  assert.equal(get(K.tokens)[L1], undefined, 'and its useless login too');
  assert.equal(ms.linkState().chosen, null);
  assert.equal(get(K.tokens)[L2].access_token, 'b', 'link 2\'s login stays');
  // the guest picks link 2 and wants their playlists: 403 there too
  ms.cancelLink();
  set(LINK_KEY, { code: 'ROOM', id: L2, verified: true, at: Date.now() });
  ms.openLists();
  await until(() => ms.linkState().step === 'refused');
  assert.equal(ms.linkState().refused.id, L2, 'the playlists path has the same friendly step');
  assert.equal(ms.lists.state.pickError, '', 'not a generic error');
  ms.destroy();
  delete globalThis.fetch;
});

test('kiezen van link: de index wordt opnieuw gemeld als de lijst van de kamer verandert', () => {
  reset();
  const session = fakeSession([{ id: L1, name: '' }, { id: L2, name: '' }]);
  set(LINK_KEY, { code: 'ROOM', id: L2, verified: true, at: Date.now() });
  const ms = createMixShare({ code: 'ROOM', memberId: () => 'gast0001', session, returnHash: '#/kamer/ROOM', onChange() {} });
  ms.sync(session.meta);
  assert.deepEqual(session.reports, [1]);
  // the leader reordered before the report arrived: the room counted link 1 (index 1 of the new list)
  session.meta = { ...session.meta, spotifyLinks: [{ id: L2, name: '' }, { id: L1, name: '' }], myLink: 1 };
  ms.sync(session.meta);
  assert.deepEqual(session.reports, [1, 0], 'reported again at once, with the index in the new list');
  ms.destroy();
});
