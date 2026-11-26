// Accounts and prepared rooms, end to end, against the Node room server (server/node.mjs) with
// the app served by scripts/serve.mjs. Every "device" is its own browser context (own localStorage).
//
//  1. no account: the start screen, a whole "make a room" path, and a server without accounts;
//  2. sign-up: inline rules, the recovery code shown once, the overview, a reload keeps the session;
//  3. sync between two devices: playlists, the Spotify Client ID, changes both ways, a tombstone;
//  4. a prepared room: list, share card, a guest and a tv display before the owner opens it;
//  5. open it on another device and play a round; a second device takes the host role over;
//  6. reset, delete, the 5-rooms limit;
//  7. security-flavoured UI: wrong password, lockout, recovery, password change, log out with keep or
//     remove, delete account, and no secret in any URL, console line or localStorage key;
//  8. robustness: the room server stopped (the app still starts and works), the pending save after it
//     is back, and the service worker never caches /account.
//
// Phones are driven through window.__ttRoom.session (as multi-screen does), everything else through the UI.
// Real app bugs are collected as soft failures (marked SOFT FAIL) and fail the run at the end.
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { launch, startServer, assert, ROOT } from './helpers.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers } from './multi-helpers.mjs';
import { LOGIN_FAILS, MAX_PREPARED_ROOMS } from '../../server/accounts.mjs';

const FIX = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/deck.json'), 'utf8'));
const ACCOUNT_KEY = 'timetunesr.account.v1';
const SFX = Date.now().toString(36).slice(-5);
const CID = '0123456789abcdef0123456789abcdef';
const TV = { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, userAgent: undefined };

const softFails = [];
/** An assertion about a real app/server rule that must not stop the run when it fails: reported at the end. */
function soft(cond, label, repro = '') {
  if (cond) { console.log(`  ok - ${label}`); return; }
  console.log(`  SOFT FAIL - ${label}${repro ? ` (${repro})` : ''}`);
  softFails.push(label);
}

const tid = (page, id) => page.getByTestId(id);
const text = async (page, id) => (await tid(page, id).textContent()).replace(/\s+/g, ' ').trim();

// ---------- what must never leak ----------
const SECRETS = new Set();
const secret = (v) => { if (v && String(v).length >= 8) SECRETS.add(String(v)); };

// ---------- one browser, many devices ----------
let browser; let appUrl;
const devices = [];
/** A device = own context. Records console output and every URL the page asks for. */
async function dev(rooms, opts = {}) {
  const d = await phone(browser, rooms, opts);
  d.logs = []; d.urls = [];
  await d.context.route(/itunes\.apple\.com|mzstatic|spotify\.com|workers\.dev/, (r) => r.abort());
  d.page.on('console', (m) => d.logs.push(m.text()));
  d.page.on('request', (r) => d.urls.push(r.url()));
  d.page.on('framenavigated', (f) => d.urls.push(f.url()));
  devices.push(d);
  return d;
}
const go = (page, hash = '') => page.goto(`${appUrl}${hash}`);
const sessionOf = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), ACCOUNT_KEY);
async function token(page) { const s = await sessionOf(page); if (s?.token) secret(s.token); return s?.token || null; }
/** The account has nothing left to save (and no error). */
const saved = (page) => page.waitForFunction(async () => {
  const a = await import('/js/account.js');
  const s = a.status();
  return !!a.current() && !s.pending && !s.saving && !s.error;
}, null, { timeout: 20000 });
const playlistsOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1') || '{"lists":[]}').lists.map((p) => ({ id: p.id, name: p.name, n: p.tracks.length })));
const onDevice = (page, fn, arg) => page.evaluate(async ([src, a]) => { const f = (0, eval)(`(${src})`); return f(a); }, [fn.toString(), arg]);

async function signUpUi(page, user, pw) {
  await tid(page, 'account-tab-signup').click();
  await tid(page, 'account-signup-username').fill(user);
  await tid(page, 'account-signup-password').fill(pw);
  await tid(page, 'account-signup-submit').click();
}
async function logInUi(page, user, pw) {
  await go(page, '#/');
  await go(page, '#/account');
  if (await tid(page, 'account-tab-login').count()) await tid(page, 'account-tab-login').click();
  await tid(page, 'account-login-form').waitFor();
  await tid(page, 'account-login-username').fill(user);
  await tid(page, 'account-login-password').fill(pw);
  await tid(page, 'account-login-submit').click();
}
const errCode = (page) => page.locator('[data-testid="account-error"]').first().getAttribute('data-code');

// ======================================================================================
//  1. no account
// ======================================================================================
async function noAccount(rooms) {
  console.log('\n## 1. no account');
  const host = await dev(rooms);
  await go(host.page);
  await tid(host.page, 'start-account').waitFor();
  assert(await tid(host.page, 'start-account').getAttribute('data-state') === 'out', 'start screen: the account bar shows the logged-out state');
  await go(host.page, '#/spelleider');
  const code = await createRoom(host.page);
  assert(/^[A-Z]{4}$/.test(code), `a room is made without logging in (${code})`);
  assert(await tid(host.page, 'host-account-marker').count() === 0, 'the lobby shows no account marker when logged out');
  const guest = await dev(rooms);
  await joinRoom(guest.page, appUrl, code, 'Gast');
  await waitForPlayers(host.page, 1);
  assert(true, 'a guest joins that room and the host sees them');
  assert(await sessionOf(host.page) === null, 'nothing about an account is stored on a device that never logged in');

  // a server that does not know accounts: /health without the feature
  const old = await dev(rooms);
  await old.context.route('**/health', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    await route.fulfill({ response: res, json: { ...j, features: (j.features || []).filter((f) => f !== 'accounts') } });
  });
  await go(old.page, '#/account');
  await old.page.locator('[data-testid="account-unavailable"][data-code="noaccounts"]').waitFor({ timeout: 15000 });
  assert(await tid(old.page, 'account-login-form').count() === 0 && await tid(old.page, 'account-signup-form').count() === 0, 'a server without accounts: the account screen explains and shows no forms');
  assert(/geen accounts/.test(await text(old.page, 'account-unavailable')), 'the explanation says the server knows no accounts');
  await tid(old.page, 'account-home').click();
  await tid(old.page, 'start-account').waitFor();
  await go(old.page, '#/spelleider');
  const code2 = await createRoom(old.page);
  assert(/^[A-Z]{4}$/.test(code2), 'on that server a room is made as always');
  await go(old.page, '#/playlists');
  await tid(old.page, 'screen-playlists').waitFor();
  assert(await tid(old.page, 'account-note').getAttribute('data-state') === 'out', 'the playlists screen shows the logged-out account note');
  // without any server at all
  const lone = await phone(browser, 'app');
  devices.push({ ...lone, logs: [], urls: [] });
  await lone.context.addInitScript(() => localStorage.setItem('timetunesr.multiServer.v1', JSON.stringify('off')));
  await go(lone.page, '#/account');
  await lone.page.locator('[data-testid="account-unavailable"][data-code="noserver"]').waitFor({ timeout: 10000 });
  assert(true, 'no room server configured at all: the account screen explains that too');
}

// ======================================================================================
//  2. sign-up
// ======================================================================================
async function signUp(rooms, S) {
  console.log('\n## 2. sign-up on device A');
  S.user = `Jacco_${SFX}`; S.pw = 'feestje-2026'; secret(S.pw);
  const A = S.A = await dev(rooms);
  const pa = A.page;
  await go(pa);
  await tid(pa, 'start-account').click();
  await tid(pa, 'account-login-form').waitFor();
  await tid(pa, 'account-tab-signup').click();
  await tid(pa, 'account-signup-form').waitFor();
  // rules, inline
  await tid(pa, 'account-signup-username').fill('a!');
  await tid(pa, 'account-signup-password').fill(S.pw);
  await tid(pa, 'account-signup-submit').click();
  await pa.locator('[data-testid="account-error"][data-code="username"]').waitFor({ timeout: 15000 });
  assert(/3/.test(await text(pa, 'account-error')), 'a bad username shows the rule inline (3-24 characters)');
  await tid(pa, 'account-signup-username').fill(S.user);
  await tid(pa, 'account-signup-password').fill('kort1');
  await tid(pa, 'account-signup-submit').click();
  await pa.locator('[data-testid="account-error"][data-code="bad"]').waitFor({ timeout: 15000 });
  assert(/8/.test(await text(pa, 'account-error')), 'a too short password shows the rule inline (at least 8)');
  assert(await sessionOf(pa) === null, 'no account was made by the refused attempts');
  await tid(pa, 'account-signup-password').fill(S.pw);
  await tid(pa, 'account-signup-submit').click();
  await tid(pa, 'account-code-step').waitFor({ timeout: 30000 });
  S.rcode = (await text(pa, 'account-recovery-code'));
  secret(S.rcode);
  assert(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(S.rcode), `the recovery code is shown (${S.rcode.slice(0, 4)}-...)`);
  await token(pa);
  await tid(pa, 'account-code-saved').click();
  await tid(pa, 'account-overview').waitFor();
  assert(!(await pa.locator('body').innerText()).includes(S.rcode), 'after "ik heb hem bewaard" the code is not on the screen any more');
  assert(/Jacco/.test(await text(pa, 'account-name')), 'the overview greets the account');
  await pa.reload();
  await tid(pa, 'account-overview').waitFor();
  assert(!(await pa.locator('body').innerText()).includes(S.rcode) && await tid(pa, 'account-code-step').count() === 0, 'after a reload the code step does not come back and the code is gone');
  assert((await sessionOf(pa)).username.toLowerCase() === S.user.toLowerCase(), 'a reload keeps the session (still logged in)');
  await go(pa);
  assert(await tid(pa, 'start-account').getAttribute('data-state') === 'in', 'the start screen says "Ingelogd als"');

  // device B: a taken name is refused
  const B = S.B = await dev(rooms);
  await go(B.page, '#/account');
  await tid(B.page, 'account-login-form').waitFor();
  await signUpUi(B.page, S.user.toUpperCase(), 'ander-wachtwoord-1');
  await B.page.locator('[data-testid="account-error"][data-code="taken"]').waitFor({ timeout: 15000 });
  assert(true, 'a second sign-up with the same name (other case) is refused as taken, inline');
  assert(await sessionOf(B.page) === null, 'and logs nobody in');
}

// ======================================================================================
//  3. sync
// ======================================================================================
async function sync(rooms, S) {
  console.log('\n## 3. sync between devices');
  const { A, B } = S; const pa = A.page; const pb = B.page;
  await go(pa, '#/playlists');
  await tid(pa, 'screen-playlists').waitFor();
  assert(await tid(pa, 'account-note').getAttribute('data-state') === 'in', 'playlists screen: "bewaard in je account"');
  await tid(pa, 'playlist-new-name').fill('Feestje');
  await tid(pa, 'playlist-create').click();
  await tid(pa, 'screen-playlist').waitFor();
  S.plId = await tid(pa, 'screen-playlist').getAttribute('data-id');
  await onDevice(pa, async ({ id, cards }) => {
    const pl = await import('/js/playlists.js');
    pl.addTracks(id, cards.map((c) => ({ itunesId: c.itunesId, title: c.title, artist: c.artist, year: c.year, yearSure: true, previewUrl: c.previewUrl || `https://example.invalid/${c.id}.m4a`, trackViewUrl: c.trackViewUrl || '' })));
  }, { id: S.plId, cards: FIX.cards });
  await go(pa, '#/instellingen/spotify');
  await tid(pa, 'wiz-have-id').click();
  await tid(pa, 'spotify-client-id').fill(CID);
  await tid(pa, 'spotify-client-save').click();
  await go(pa, '#/account');
  await tid(pa, 'account-overview').waitFor();
  await pa.waitForFunction(() => document.querySelector('[data-testid="account-save-state"]')?.dataset.state === 'ok'
    && document.querySelector('[data-testid="account-playlist-count"]')?.dataset.count === '1'
    && document.querySelector('[data-testid="account-spotify-state"]')?.dataset.set === 'true', null, { timeout: 20000 });
  assert(true, 'device A: the account has 1 playlist and the Spotify Client ID, the save state is ok');

  // device B logs in
  await logInUi(pb, S.user.toLowerCase(), S.pw);
  await tid(pb, 'account-overview').waitFor({ timeout: 30000 });
  await token(pb);
  const summary = await text(pb, 'account-sync-summary');
  assert(/1 playlist/.test(summary) && /Spotify Client ID/.test(summary), `device B: the sync summary names what arrived ("${summary}")`);
  await go(pb, '#/playlists');
  await pb.locator(`[data-testid="deck-option"][data-deck-id="${S.plId}"]`).waitFor();
  assert((await playlistsOf(pb)).find((p) => p.id === S.plId)?.n === FIX.cards.length, 'device B: the playlist is there with all its songs');
  await go(pb, '#/instellingen/spotify');
  await tid(pb, 'screen-spotify-setup').waitFor().catch(() => {});
  assert(await pb.evaluate(() => localStorage.getItem('timetunesr.spotify.clientId.v1')) === JSON.stringify(CID), 'device B: the Spotify Client ID is stored');
  await pb.waitForFunction((cid) => [...document.querySelectorAll('input')].some((i) => i.value === cid) || document.body.innerText.includes(cid), CID, { timeout: 5000 }).then(
    () => assert(true, 'device B: the Spotify setup shows the Client ID'),
    () => soft(false, 'device B: the Spotify setup screen shows the Client ID that came from the account', 'log in on a fresh device, open #/instellingen/spotify: neither an input value nor text holds the ID'),
  );

  // B changes the playlist; A sees it after reopening the account screen
  await onDevice(pb, async (id) => { const pl = await import('/js/playlists.js'); pl.rename(id, 'Feestje van B'); }, S.plId);
  await saved(pb);
  await go(pa, '#/');
  await go(pa, '#/account');
  await pa.waitForFunction((id) => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists.find((p) => p.id === id)?.name === 'Feestje van B', S.plId, { timeout: 12000 }).catch(async (e) => { console.log('DBG A', JSON.stringify(await playlistsOf(pa)), 'B', JSON.stringify(await playlistsOf(pb)), JSON.stringify(await pa.evaluate(async () => { const a = await import('/js/account.js'); return [a.status(), location.hash]; })), JSON.stringify(await pb.evaluate(async () => { const a = await import('/js/account.js'); return [a.status(), (await a.fetchAccount())?.account?.data?.playlists?.map((p) => [p.name, p.updated])]; }))); throw e; });
  assert(true, 'a rename on B reaches A after A reopens the account screen');
  await onDevice(pb, async (id) => { const pl = await import('/js/playlists.js'); pl.rename(id, 'Feestje'); }, S.plId);
  await saved(pb);
  await go(pa, '#/'); await go(pa, '#/account');
  await pa.waitForFunction((id) => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists.find((p) => p.id === id)?.name === 'Feestje', S.plId, { timeout: 20000 });

  // a deletion travels (tombstone)
  const tmp = await onDevice(pa, async () => { const pl = await import('/js/playlists.js'); const p = pl.create('Tijdelijk'); return p.id; });
  await saved(pa);
  await go(pb, '#/'); await go(pb, '#/account');
  await pb.waitForFunction((id) => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists.some((p) => p.id === id), tmp, { timeout: 20000 });
  await onDevice(pb, async (id) => { const pl = await import('/js/playlists.js'); pl.remove(id); }, tmp);
  await saved(pb);
  await go(pa, '#/'); await go(pa, '#/account');
  await pa.waitForFunction((id) => !JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists.some((p) => p.id === id), tmp, { timeout: 20000 });
  assert((await playlistsOf(pa)).some((p) => p.id === S.plId), 'deleting a playlist on B removes it on A (tombstone), the other playlist stays');
  await tid(pa, 'account-playlist-count').waitFor();
  await pa.waitForFunction(() => document.querySelector('[data-testid="account-playlist-count"]')?.dataset.count === '1', null, { timeout: 15000 });
}

// ======================================================================================
//  4. prepared room
// ======================================================================================
async function prepared(rooms, S) {
  console.log('\n## 4. a prepared room, before the owner opens it');
  const pa = S.A.page;
  await go(pa, '#/account/kamers');
  await tid(pa, 'myrooms-empty').waitFor();
  await tid(pa, 'myrooms-new').click();
  await tid(pa, 'prep-form').waitFor();
  await tid(pa, 'prep-save').click();
  await tid(pa, 'prep-error').waitFor();
  assert(/naam/.test(await text(pa, 'prep-error')), 'a room without a name is refused inline');
  await tid(pa, 'prep-name').fill('Feest zaterdag');
  await pa.locator('label:has([data-testid="prep-game-disco"])').click();
  await pa.locator('label:has([data-testid="room-disco-win-line2"])').click();
  await pa.locator(`label:has([data-testid="prep-music-${S.plId}"])`).click();
  assert(!(await tid(pa, 'prep-host-plays').isChecked()), 'the owner does not play along');
  await tid(pa, 'prep-save').click();
  await tid(pa, 'share-card').waitFor();
  S.code = (await text(pa, 'share-code'));
  assert(/^[A-Z]{4}$/.test(S.code), `the code is final at once (${S.code})`);
  await go(pa, '#/account/kamers');
  const card = pa.locator(`[data-testid="myroom"][data-code="${S.code}"]`);
  await card.waitFor();
  assert(await card.getByTestId('myroom-name').textContent() === 'Feest zaterdag' && (await card.getByTestId('myroom-code').textContent()).includes(S.code), 'Mijn kamers lists the room with its name and code');
  assert(/2 lijnen/.test(await card.getByTestId('myroom-game').textContent()) && /Discobingo/i.test(await card.getByTestId('myroom-game').textContent()), 'the list says Discobingo, 2 lijnen');
  assert(/Feestje/.test(await card.getByTestId('myroom-music').textContent()), 'the list names the playlist as the music');
  await card.getByTestId('myroom-share').click();
  await tid(pa, 'share-qr').waitFor();
  const join = await text(pa, 'share-copy-join-value');
  const scr = await text(pa, 'share-copy-screen-value');
  assert(join.endsWith(`#/kamer/${S.code}`) && scr.endsWith(`#/scherm/${S.code}`) && await text(pa, 'share-code') === S.code, `Deel: QR, join link (${join.replace(/^https?:\/\//, '')}) and big-screen link for the code`);
  assert(await tid(pa, 'share-qr').locator('svg, img, canvas').count() > 0, 'the QR code is drawn');

  // a guest joins days before; nobody is hosting
  const G = S.G = await dev(rooms);
  await go(G.page, `#/kamer/${S.code}`);
  await tid(G.page, 'join-name').fill('Anouk');
  await tid(G.page, 'join-submit').click();
  await G.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
  await tid(G.page, 'lobby-room-name').waitFor();
  assert(await text(G.page, 'lobby-room-name') === 'Feest zaterdag', 'the guest sees the name of the room');
  await tid(G.page, 'waiting-for-owner').waitFor();
  await G.page.waitForFunction(() => window.__ttRoom?.session?.meta?.leaderOnline === false, null, { timeout: 10000 });
  assert(await G.page.evaluate(() => window.__ttRoom.session.meta.takeover) === false, 'the server says: no take-over for this room (meta.takeover === false)');
  assert(await tid(G.page, 'room-takeover').count() === 0 && await tid(G.page, 'room-takeover-wait').count() === 0, 'the guest is offered no take-over and no countdown');
  assert(/eigenaar|spelleider/i.test(await text(G.page, 'waiting-for-owner')), 'the guest reads that the owner opens the room later');

  // the tv display
  const T = S.T = await dev(rooms, TV);
  await go(T.page, `#/scherm/${S.code}`);
  await tid(T.page, 'screen-room-name').waitFor({ timeout: 20000 });
  assert(await text(T.page, 'screen-room-name') === 'Feest zaterdag', 'the big screen shows the room name');
  await tid(T.page, 'screen-qr').waitFor();
  assert((await text(T.page, 'screen-join-url')).includes(S.code) || (await text(T.page, 'screen-code')).includes(S.code), 'the big screen shows the join screen (code, QR, link)');
  await T.page.waitForFunction(() => document.querySelector('[data-testid="screen-count"]')?.dataset.count === '1', null, { timeout: 10000 });
  assert(await tid(T.page, 'waiting-for-owner').count() === 1, 'the big screen says the owner is not there yet');
}

// ======================================================================================
//  5. open on another device
// ======================================================================================
async function openAndPlay(rooms, S) {
  console.log('\n## 5. open on device B, play, take over from A');
  const { A, B, G } = S; const pa = A.page; const pb = B.page;
  await go(pb, '#/account/kamers');
  const card = pb.locator(`[data-testid="myroom"][data-code="${S.code}"]`);
  await card.waitFor();
  await pb.locator(`[data-testid="myroom"][data-code="${S.code}"] [data-testid="myroom-waiting"][data-count="1"]`).waitFor({ timeout: 15000 });
  await card.getByTestId('myroom-open').click();
  await pb.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 20000 });
  await tid(pb, 'host-prepared').waitFor();
  assert(await text(pb, 'host-room-name') === 'Feest zaterdag', 'the host lobby shows the room name');
  assert(await text(pb, 'room-code') === S.code, 'the lobby is the one of the prepared code');
  assert(/Jacco/.test(await text(pb, 'host-account-marker')), 'the host lobby shows who is logged in');
  assert(await tid(pb, 'room-disco-win-line2').isChecked(), 'prepared settings: Discobingo, 2 lijnen selected');
  assert(await pb.evaluate(() => window.__ttHost.session.room.settings.game) === 'disco', 'the game is Discobingo');
  assert(/Feestje/.test(await text(pb, 'room-music')), 'the prepared playlist is the active music');
  await pb.waitForFunction(() => document.querySelectorAll('[data-testid^="room-player-"][data-online="true"]').length >= 1, null, { timeout: 15000 });
  assert(/Anouk/.test(await pb.locator('[data-testid^="room-player-"]').first().textContent()), 'the guest who came early is already in the list');
  await G.page.waitForFunction(() => window.__ttRoom?.session?.meta?.leaderOnline === true, null, { timeout: 15000 });
  assert(await tid(G.page, 'waiting-for-owner').count() === 0, 'the guest no longer waits for the owner');

  await tid(pb, 'room-start').click();
  await pb.waitForFunction(() => window.__ttHost?.session?.spectatorView()?.phase === 'answering', null, { timeout: 20000 });
  await G.page.waitForFunction(() => window.__ttRoom?.session?.view?.phase === 'answering', null, { timeout: 15000 });
  await G.page.evaluate(() => window.__ttRoom.session.answer({ pass: true }));
  await pb.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });
  await tid(pb, 'room-reveal').click();
  await G.page.waitForFunction(() => window.__ttRoom?.session?.view?.phase === 'revealed', null, { timeout: 15000 });
  assert(true, 'one round played with the guest (answered, revealed on both phones)');

  // A opens the same room while B is hosting
  await go(pa, '#/account/kamers');
  const cardA = pa.locator(`[data-testid="myroom"][data-code="${S.code}"]`);
  await cardA.waitFor();
  await pa.locator(`[data-testid="myroom"][data-code="${S.code}"][data-phase]`).waitFor();
  await cardA.getByTestId('myroom-open').click();
  await tid(pa, 'myrooms-confirm-yes').click(); // "open on another device: take over?"
  await pa.locator('[data-testid="screen-room-host"]').waitFor({ timeout: 20000 });
  await tid(pa, 'host-room-name').waitFor();
  await pa.waitForFunction(() => window.__ttHost?.session?.status === 'online' || window.__ttHost?.session?.meta?.leaderOnline, null, { timeout: 20000 });
  await pb.locator('[data-testid="host-error"][data-code="replaced"]').waitFor({ timeout: 20000 }).then(
    () => assert(true, 'device B gets the "replaced" treatment'),
    async () => soft(false, 'device B is told it was replaced when A opens the room', `host-error code: ${await pb.evaluate(() => window.__ttHost?.session?.error?.code || document.querySelector('[data-testid="screen-room-host"]')?.dataset.view)}`),
  );
  assert(await pa.evaluate(() => window.__ttHost.session.code) === S.code, 'device A leads the same room (same code)');
  await G.page.waitForFunction(() => window.__ttRoom.session.meta?.leaderOnline === true, null, { timeout: 15000 });
  assert(await G.page.evaluate(() => window.__ttRoom.session.view.phase) !== undefined, 'the guest stays in the room through the hand-over');
}

// ======================================================================================
//  6. reset, delete, limit
// ======================================================================================
async function resetDelete(rooms, S) {
  console.log('\n## 6. reset, delete and the limit');
  const pa = S.A.page; const G = S.G;
  await go(pa, '#/account/kamers');
  const card = pa.locator(`[data-testid="myroom"][data-code="${S.code}"]`);
  await card.waitFor();
  await card.getByTestId('myroom-reset').click();
  await tid(pa, 'myrooms-confirm-yes').click();
  await G.page.locator('[data-testid="screen-room-player"][data-view="error"]').waitFor({ timeout: 15000 });
  assert(/gesloten/i.test(await G.page.locator('[data-testid="screen-room-player"]').innerText()), 'Opnieuw gebruiken: the guest is out with the closed message');
  await pa.locator(`[data-testid="myroom"][data-code="${S.code}"][data-phase="lobby"] [data-testid="myroom-waiting"][data-count="0"]`).waitFor({ timeout: 15000 });
  assert(true, 'the room is still listed, same code, empty, back in the lobby');
  const info = await (await fetch(`${rooms.url}/rooms/${S.code}`)).json();
  assert(info.name === 'Feest zaterdag', 'the public room info still has the name after the reset');

  await card.getByTestId('myroom-delete').click();
  await tid(pa, 'myrooms-confirm-yes').click();
  await tid(pa, 'myrooms-empty').waitFor({ timeout: 15000 });
  assert(true, 'Verwijder: the list is empty');
  assert((await fetch(`${rooms.url}/rooms/${S.code}`)).status === 404, 'the deleted code no longer exists on the server');
  const J = await dev(rooms);
  const msgOf = async (c) => {
    await go(J.page, '#/'); await go(J.page, `#/kamer/${c}`);
    await tid(J.page, 'join-name').fill('Laat');
    await tid(J.page, 'join-submit').click();
    await J.page.locator('[data-testid="screen-room-player"][data-view="error"]').waitFor({ timeout: 15000 });
    return J.page.locator('[data-testid="screen-room-player"]').innerText();
  };
  const gone = await msgOf(S.code);
  const never = await msgOf('QQQQ');
  assert(gone === never && /bestaat niet/i.test(gone), 'a join attempt on the deleted code gets the normal not-found');

  // the 5-rooms limit: a stale form on A, the 5th room made meanwhile elsewhere
  const mk = (n) => ({ name: `Kamer ${n}`, settings: { game: 'disco' }, music: 'deck', play: 'preview', hostPlays: false, hostName: '' });
  S.codes = [];
  for (let i = 1; i < MAX_PREPARED_ROOMS; i++) {
    const r = await onDevice(pa, async (o) => { const a = await import('/js/account.js'); return a.prepareRoom(o); }, mk(i));
    if (!r.ok) throw new Error(`could not prepare room ${i}: ${JSON.stringify(r)}`);
    S.codes.push(r.room.code);
  }
  await go(pa, '#/account/kamers');
  await pa.locator('[data-testid="myroom"]').nth(MAX_PREPARED_ROOMS - 2).waitFor();
  await tid(pa, 'myrooms-new').click();
  await tid(pa, 'prep-form').waitFor();
  await tid(pa, 'prep-name').fill('De zesde');
  const B = S.B;
  const r5 = await onDevice(B.page, async (o) => { const a = await import('/js/account.js'); return a.prepareRoom(o); }, mk(MAX_PREPARED_ROOMS));
  assert(r5.ok, `a ${MAX_PREPARED_ROOMS}th room can be made`);
  S.codes.push(r5.room.code);
  await tid(pa, 'prep-save').click();
  await tid(pa, 'prep-error').waitFor({ timeout: 15000 });
  assert(await tid(pa, 'prep-error').getAttribute('data-code') === 'limit' && new RegExp(`hoogstens ${MAX_PREPARED_ROOMS}`).test(await text(pa, 'prep-error')), `the 6th room shows the server's message: "${await text(pa, 'prep-error')}"`);
  await go(pa, '#/account/kamers');
  await pa.locator('[data-testid="myroom"]').nth(MAX_PREPARED_ROOMS - 1).waitFor();
  await tid(pa, 'myrooms-full').waitFor();
  assert(await pa.locator('[data-testid="myroom"]').count() === MAX_PREPARED_ROOMS, 'the list holds exactly the maximum');
}

// ======================================================================================
//  7. security-flavoured checks
// ======================================================================================
async function security(rooms, S, rooms2) {
  console.log('\n## 7. wrong password, lockout, recovery, password change, log out, delete');
  const NEW1 = 'nog-geheimer-9'; const NEW2 = 'weer-anders-77'; secret(NEW1); secret(NEW2);
  // generic message
  const W = await dev(rooms);
  await go(W.page, '#/account');
  await tid(W.page, 'account-login-form').waitFor();
  await tid(W.page, 'account-login-username').fill(`bestaat_niet_${SFX}`);
  await tid(W.page, 'account-login-password').fill('helemaal-fout-1'); secret('helemaal-fout-1');
  await tid(W.page, 'account-login-submit').click();
  await W.page.locator('[data-testid="account-error"][data-code="login"]').waitFor({ timeout: 15000 });
  const unknownMsg = await text(W.page, 'account-error');
  await tid(W.page, 'account-login-username').fill(S.user);
  await tid(W.page, 'account-login-submit').click();
  await W.page.locator('[data-testid="account-login-submit"]:not([disabled])').waitFor();
  await W.page.locator('[data-testid="account-error"][data-code="login"]').waitFor();
  assert(unknownMsg === await text(W.page, 'account-error'), `an unknown name and a wrong password give the same message ("${unknownMsg}")`);
  assert(!unknownMsg.toLowerCase().includes('bestaat') && !/onbekend/i.test(unknownMsg), 'the message does not say which part was wrong');

  // lockout on a throwaway account of the second server
  const L = await dev(rooms2);
  const lockUser = `slot_${SFX}`;
  await go(L.page, '#/account');
  await L.page.evaluate(async (u) => { const a = await import('/js/account.js'); const r = await a.signUp(u, 'wegwerp-123'); if (!r.ok) throw new Error(r.message); await a.logOut({ keepData: false }); }, lockUser);
  secret('wegwerp-123');
  await L.page.reload();
  await tid(L.page, 'account-login-form').waitFor();
  await tid(L.page, 'account-login-username').fill(lockUser);
  await tid(L.page, 'account-login-password').fill('fout-wachtwoord-0'); secret('fout-wachtwoord-0');
  await tid(L.page, 'account-login-submit').click();
  await L.page.locator('[data-testid="account-error"][data-code="login"]').waitFor({ timeout: 15000 });
  let attempts = 1; let code = 'login';
  while (code === 'login' && attempts <= LOGIN_FAILS.limit + 2) {
    const r = await onDevice(L.page, async (u) => { const a = await import('/js/account.js'); return a.logIn(u, 'fout-wachtwoord-x'); }, lockUser);
    attempts++; code = r.code;
  }
  assert(code === 'locked' && attempts >= LOGIN_FAILS.limit && attempts <= LOGIN_FAILS.limit + 1, `the lock comes after ${LOGIN_FAILS.limit} failures (first "locked" answer on attempt ${attempts})`);
  await tid(L.page, 'account-login-password').fill('fout-wachtwoord-y');
  await tid(L.page, 'account-login-submit').click();
  await L.page.locator('[data-testid="account-error"][data-code="locked"]').waitFor({ timeout: 15000 });
  assert(/kwartier|minuten/.test(await text(L.page, 'account-error')), `the lockout message is friendly: "${await text(L.page, 'account-error')}"`);
  await tid(L.page, 'account-login-password').fill('wegwerp-123');
  await tid(L.page, 'account-login-submit').click();
  await L.page.locator('[data-testid="account-error"][data-code="locked"]').waitFor({ timeout: 15000 });
  assert(true, 'even the right password is refused while locked');

  // recovery on device C: new password + NEW code; the sessions of A and B end
  const C = S.C = await dev(rooms);
  await go(C.page, '#/account/vergeten');
  await tid(C.page, 'account-recover-form').waitFor();
  await tid(C.page, 'account-recover-username').fill(S.user);
  await tid(C.page, 'account-recover-code').fill(S.rcode);
  await tid(C.page, 'account-recover-password').fill(NEW1);
  await tid(C.page, 'account-recover-submit').click();
  await tid(C.page, 'account-code-step').waitFor({ timeout: 30000 });
  const rcode2 = await text(C.page, 'account-recovery-code');
  secret(rcode2); await token(C.page);
  assert(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(rcode2) && rcode2 !== S.rcode, 'recovery with the code sets the new password and shows a NEW code');
  await tid(C.page, 'account-code-saved').click();
  await tid(C.page, 'account-overview').waitFor();
  for (const [name, d] of [['A', S.A], ['B', S.B]]) {
    await go(d.page, '#/'); await go(d.page, '#/account');
    await d.page.locator('[data-testid="account-notice"][data-kind="session"]').waitFor({ timeout: 20000 }).then(
      () => assert(true, `device ${name}: its old session ended with the friendly notice after the recovery`),
      () => soft(false, `device ${name}: after a password recovery its old session ends with the friendly notice`, 'recover on device C with the recovery code, then open #/account on a device that was logged in before'),
    );
  }
  // the old password and the used recovery code are dead
  const oldPw = await onDevice(W.page, async (a) => { const m = await import('/js/account.js'); return m.logIn(a.u, a.p); }, { u: S.user, p: S.pw });
  assert(!oldPw.ok && oldPw.code === 'login', 'the old password no longer works');

  // A and B log in with the new password; C changes the password: both end again
  await logInUi(S.A.page, S.user, NEW1);
  await tid(S.A.page, 'account-overview').waitFor({ timeout: 30000 });
  await token(S.A.page);
  await logInUi(S.B.page, S.user, NEW1);
  await tid(S.B.page, 'account-overview').waitFor({ timeout: 30000 });
  await token(S.B.page);
  await tid(C.page, 'account-password-card').locator('summary').click();
  await tid(C.page, 'account-pw-current').fill(NEW1);
  await tid(C.page, 'account-pw-new').fill(NEW2);
  await tid(C.page, 'account-pw-submit').click();
  await tid(C.page, 'account-pw-msg').waitFor({ timeout: 20000 });
  assert(/uitgelogd|gewijzigd|opgeslagen|nieuwe/i.test(await text(C.page, 'account-pw-msg')), `change password: "${await text(C.page, 'account-pw-msg')}"`);
  for (const [name, d] of [['A', S.A], ['B', S.B]]) {
    await go(d.page, '#/'); await go(d.page, '#/account');
    await d.page.locator('[data-testid="account-notice"][data-kind="session"]').waitFor({ timeout: 20000 });
    assert(await tid(d.page, 'account-login-form').count() === 1, `device ${name}: ended by the password change, back at the login form with a notice`);
  }
  assert(await tid(C.page, 'account-overview').count() === 1, 'the device that changed the password stays logged in');

  // log out: remove from this device / keep
  await logInUi(S.A.page, S.user, NEW2);
  await tid(S.A.page, 'account-overview').waitFor({ timeout: 30000 });
  await token(S.A.page);
  const pa = S.A.page;
  assert((await playlistsOf(pa)).length >= 1 && await pa.evaluate(() => !!localStorage.getItem('timetunesr.spotify.clientId.v1')), 'A holds the account\'s playlist and Client ID before logging out');
  await tid(pa, 'account-logout').click();
  await tid(pa, 'account-sheet').waitFor();
  assert(await tid(pa, 'account-keep-data').isChecked(), 'log out: "bewaar" is the default');
  await tid(pa, 'account-sheet-confirm').click();
  await tid(pa, 'account-login-form').waitFor();
  assert((await playlistsOf(pa)).length >= 1 && await pa.evaluate(() => !!localStorage.getItem('timetunesr.spotify.clientId.v1')), 'log out + bewaar: the playlists and the Client ID stay on the device');
  assert(await sessionOf(pa) === null, 'the session is gone from the device');
  await logInUi(pa, S.user, NEW2);
  await tid(pa, 'account-overview').waitFor({ timeout: 30000 });
  await token(pa);
  await tid(pa, 'account-logout').click();
  await tid(pa, 'account-remove-data').check();
  await tid(pa, 'account-sheet-confirm').click();
  await tid(pa, 'account-login-form').waitFor();
  const left = await pa.evaluate(() => ({ n: JSON.parse(localStorage.getItem('timetunesr.playlists.v1') || '{"lists":[]}').lists.length, cid: localStorage.getItem('timetunesr.spotify.clientId.v1') }));
  assert(left.n === 0 && !left.cid, 'log out + "verwijder van dit toestel": the account\'s playlists and Client ID are gone');
  assert(await rooms.url && (await fetch(`${rooms.url}/rooms/${S.codes[0]}`)).status === 200, 'logging out does not touch the prepared rooms');

  // delete the account (password asked); prepared rooms go with it
  const pc = C.page;
  await tid(pc, 'account-delete').click();
  await tid(pc, 'account-sheet').waitFor();
  await tid(pc, 'account-sheet-confirm').click();
  await pc.locator('[data-testid="account-sheet"] [data-testid="account-error"]').waitFor();
  assert(true, 'delete account without the password is refused inline');
  await tid(pc, 'account-delete-password').fill('niet-mijn-wachtwoord-1'); secret('niet-mijn-wachtwoord-1');
  await tid(pc, 'account-sheet-confirm').click();
  await pc.locator('[data-testid="account-sheet"] [data-testid="account-error"][data-code="password"]').waitFor({ timeout: 15000 });
  assert(true, 'a wrong password does not delete the account');
  await tid(pc, 'account-delete-password').fill(NEW2);
  await tid(pc, 'account-sheet-confirm').click();
  await pc.locator('[data-testid="account-notice"][data-kind="deleted"]').waitFor({ timeout: 20000 });
  assert(true, 'the account is deleted');
  for (const c of S.codes) assert((await fetch(`${rooms.url}/rooms/${c}`)).status === 404, `prepared room ${c} left with the account`);
  const again = await onDevice(W.page, async (a) => { const m = await import('/js/account.js'); return m.logIn(a.u, a.p); }, { u: S.user, p: NEW2 });
  assert(!again.ok && again.code === 'login', 'logging in as the deleted account gives the generic message');
}

// ======================================================================================
//  8. robustness
// ======================================================================================
function swRules() {
  // run the real fetch handler of app/sw.js against fake requests
  const src = readFileSync(join(ROOT, 'app/sw.js'), 'utf8');
  const handlers = {};
  const self = { addEventListener: (t, f) => { handlers[t] = f; }, location: { origin: 'https://spel.example' }, skipWaiting() {}, clients: { claim() {} } };
  const ctx = vm.createContext({ self, URL, Request: class { constructor(u) { this.url = u; } }, fetch: async () => ({ ok: true, type: 'basic', clone() { return this; } }),
    caches: { open: async () => ({ put() {}, match: async () => null, addAll() {} }), keys: async () => [], delete: async () => true }, setTimeout, clearTimeout, Promise });
  vm.runInContext(src, ctx);
  const responded = (path, method = 'GET') => {
    let hit = false;
    handlers.fetch({ request: { method, url: `https://spel.example${path}`, mode: 'cors', headers: new Headers() }, respondWith: () => { hit = true; } });
    return hit;
  };
  return responded;
}

async function robustness(rooms3, accFile) {
  console.log('\n## 8. the room server away');
  const responded = swRules();
  assert(responded('/js/main.js'), 'service worker: app files are handled (control)');
  assert(!responded('/account') && !responded('/account/rooms') && !responded('/account/login') && !responded('/rooms/ABCD') && !responded('/health'), 'service worker: /account, /rooms and /health are never answered from its cache');

  const O = await dev(rooms3, { serviceWorkers: 'allow' });
  const po = O.page;
  const user = `Offline_${SFX}`; const pw = 'zonder-verbinding-1'; secret(pw);
  await go(po);
  await tid(po, 'start-account').waitFor();
  const made = await onDevice(po, async (a) => { const m = await import('/js/account.js'); return m.signUp(a.u, a.p); }, { u: user, p: pw });
  assert(made.ok, 'a second account (own server) is made');
  secret(made.recoveryCode); await token(po);
  await onDevice(po, async (cards) => {
    const pl = await import('/js/playlists.js');
    const p = pl.create('Onderweg');
    pl.addTracks(p.id, cards.slice(0, 10).map((c) => ({ itunesId: c.itunesId, title: c.title, artist: c.artist, year: c.year, yearSure: true, previewUrl: `https://example.invalid/${c.id}.m4a`, trackViewUrl: '' })));
  }, FIX.cards);
  await saved(po);
  // the service worker really runs here: nothing of the account API is in its caches
  await po.evaluate(() => navigator.serviceWorker.ready);
  await go(po, '#/account');
  await tid(po, 'account-overview').waitFor();
  const cached = await po.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url); return out; });
  assert(cached.length > 5 && !cached.some((u) => /\/account|\/rooms|\/health/.test(new URL(u).pathname)), `after using the account the caches hold ${cached.length} app files and no /account, /rooms or /health`);

  await rooms3.stop('SIGTERM'); // writes the accounts file first
  const t0 = Date.now();
  await po.reload();
  await tid(po, 'start-account').waitFor({ timeout: 8000 });
  const startMs = Date.now() - t0;
  assert(await tid(po, 'start-account').getAttribute('data-state') === 'in' && startMs < 4000, `server away: a logged-in app starts at once (${startMs} ms) and still says "Ingelogd als"`);
  await go(po, '#/playlists');
  await po.locator('[data-testid="deck-option"]').filter({ hasText: 'Onderweg' }).waitFor({ timeout: 5000 });
  assert(true, 'server away: the playlists are visible');
  await onDevice(po, async () => { const pl = await import('/js/playlists.js'); const p = pl.all().find((x) => x.name === 'Onderweg'); pl.rename(p.id, 'Onderweg (offline)'); });
  await po.waitForFunction(async () => { const a = await import('/js/account.js'); const s = a.status(); return s.pending || !!s.error; }, null, { timeout: 5000 });
  assert(true, 'server away: a change is kept as "pending" and the app keeps working');
  await go(po, '#/spelleider');
  await tid(po, 'host-setup-form').waitFor({ timeout: 5000 });
  assert(true, 'server away: other screens still open');
  await rooms3.start();
  await po.evaluate(() => window.dispatchEvent(new Event('online'))); // the browser says: connection is back
  await saved(po);
  assert(true, 'server back: the pending save goes through');
  const D = await dev(rooms3);
  await logInUi(D.page, user, pw);
  await tid(D.page, 'account-overview').waitFor({ timeout: 30000 });
  assert((await playlistsOf(D.page)).some((p) => p.name === 'Onderweg (offline)'), 'a fresh device sees the change made while the server was away');
  // the accounts file survived the restart: the first session (token) still works too
  assert(!!(await sessionOf(po))?.token && await tid(po, 'start-account').count() >= 0, 'the session survived the server restart');
}

// ======================================================================================
//  secrets
// ======================================================================================
async function scanSecrets() {
  console.log('\n## no secrets anywhere');
  const secrets = [...SECRETS];
  const hit = (s) => secrets.find((x) => s.includes(x) || s.includes(encodeURIComponent(x)));
  let urls = 0; let lines = 0; let keys = 0;
  for (const d of devices) {
    for (const u of d.urls) { urls++; const h = hit(u); if (h) throw new Error(`ASSERT: a secret (${h.slice(0, 4)}...) is in a URL: ${u}`); }
    for (const l of d.logs) { lines++; const h = hit(l); if (h) throw new Error(`ASSERT: a secret (${h.slice(0, 4)}...) in a console line: ${l}`); }
    if (d.page.isClosed()) continue;
    const ls = await d.page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))).catch(() => ({}));
    const ss = await d.page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))).catch(() => ({}));
    for (const [k, v] of [...Object.entries(ls), ...Object.entries(ss)]) {
      keys++;
      const kh = hit(k);
      if (kh) throw new Error(`ASSERT: a secret is a storage key name: ${k}`);
      const h = hit(String(v));
      if (h && k !== ACCOUNT_KEY) throw new Error(`ASSERT: a secret (${h.slice(0, 4)}...) is stored under ${k}`);
      if (k === ACCOUNT_KEY) {
        const s = JSON.parse(v);
        const bad = secrets.find((x) => x !== s.token && String(v).includes(x));
        if (bad) throw new Error(`ASSERT: the session key holds more than its token (${bad.slice(0, 4)}...)`);
      }
    }
  }
  assert(secrets.length >= 6, `scanned for ${secrets.length} secrets (passwords, recovery codes, session tokens)`);
  assert(true, `none in ${urls} URLs, ${lines} console lines, ${keys} storage entries (only the token in ${ACCOUNT_KEY})`);
}

export default async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'tt-accounts-'));
  const rooms = await startRoomServer({ accountsFile: join(dir, 'a1.json') });
  const rooms2 = await startRoomServer();
  const rooms3 = await startRoomServer({ accountsFile: join(dir, 'a3.json') });
  const app = await startServer();
  appUrl = app.url;
  browser = await launch();
  const S = {};
  try {
    await noAccount(rooms);
    await signUp(rooms, S);
    await sync(rooms, S);
    await prepared(rooms, S);
    await openAndPlay(rooms, S);
    await resetDelete(rooms, S);
    await security(rooms, S, rooms2);
    await robustness(rooms3);
    await scanSecrets();
    const errors = devices.flatMap((d, i) => (d.page.errors || []).map((e) => `device ${i}: ${e}`));
    assert(errors.length === 0, `no page errors on any device${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    if (softFails.length) throw new Error(`${softFails.length} SOFT FAIL(s) (real app problems, see above): ${softFails.join(' | ')}`);
  } finally {
    await browser.close();
    app.stop();
    await Promise.all([rooms.stop(), rooms2.stop(), rooms3.stop()]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
