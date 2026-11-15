// "Mix van de groep" when only the spelleider has set Spotify up: the room passes the
// spelleider's Client ID on to the players (meta.spotifyClientId), so players without any
// setting of their own can still log in for "Doe mijn favorieten erbij". A player with an own
// Client ID uses his own. A room whose spelleider has none explains it (and points the
// spelleider to the setup help); once the spelleider sets it up, the players can go on.
// And an OLD app (the version before this change, from git) against the new server: it joins,
// plays and shares as before. Node room server, phones of 390 px, fake Spotify + iTunes.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, startServer, assert, OUT, ROOT } from './helpers.mjs';
import { startRoomServer, createRoom, joinRoom, waitForPlayers } from './multi-helpers.mjs';
import { mixPhone, ACCOUNTS, PLAYBACK, TOP, shareFavourites, waitShared } from './multi-mix.e2e.mjs';

const HOST_CID = '0123456789abcdef0123456789abcdef';
const OWN_CID = 'cafebabecafebabecafebabecafebabe';
/** The last commit before the leader's Client ID went through the room (for the old-app check). */
const OLD_REF = 'eef2730';

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}
const authorizes = (p) => p.sp.calls.filter((c) => c.what === 'authorize');
const contributors = (page) => page.evaluate(() => Number(document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors || 0));

/** The app as it was at OLD_REF, served on its own port. Null when git can not give it. */
async function startOldApp() {
  const dir = mkdtempSync(join(tmpdir(), 'tt-oldapp-'));
  try {
    execSync(`git archive --format=tar ${OLD_REF} app | tar -x -C "${dir}"`, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const port = 8500 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '--port', String(port), '--host', '127.0.0.1', '--root', join(dir, 'app')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('draait op')) resolve(); });
    proc.on('exit', (c) => reject(new Error(`old app server exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const base = server.url.replace('localhost', '127.0.0.1');
  const browser = await launch();
  const all = [];
  let old = null;
  try {
    // ---------- only the spelleider has a Client ID ----------
    const host = await mixPhone(browser, rooms, base, ACCOUNTS.ilse, { seed: 7, clientId: HOST_CID, token: `${PLAYBACK} ${TOP}` });
    const H = host.page;
    all.push(H);
    await H.goto(`${base}#/spelleider`);
    const code = await createRoom(H);
    const anouk = await mixPhone(browser, rooms, base, ACCOUNTS.anouk, { clientId: false });
    const bram = await mixPhone(browser, rooms, base, ACCOUNTS.bram, { clientId: false });
    const A = anouk.page;
    const B = bram.page;
    all.push(A, B);
    await joinRoom(A, base, code, 'Anouk', { via: 'code' });
    await joinRoom(B, base, code, 'Bram', { via: 'link' });
    await waitForPlayers(H, 2);
    for (const [pg, nm] of [[A, 'Anouk'], [B, 'Bram']]) {
      await pg.getByTestId('mix-share').waitFor();
      assert(await pg.getByTestId('mix-login-note').getAttribute('data-client') === 'room', `${nm} has no Client ID of her/his own, yet can share: the room passes the spelleider's`);
      assert(await pg.evaluate(() => localStorage.getItem('timetunesr.spotify.clientId.v1')) === null, `${nm}: nothing stored as an own setting`);
    }
    assert(/User Management/.test(await A.getByTestId('mix-login-note').textContent()), 'the note says the spelleider must add the account under User Management');
    await shot(A, 'leader-01-player-room-client');

    await shareFavourites(A);
    await A.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await waitShared(A, 10);
    assert(authorizes(anouk).at(-1).clientId === HOST_CID, 'Anouk logs in with the spelleider\'s Client ID');
    await shareFavourites(B);
    await B.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await waitShared(B, 10);
    assert(authorizes(bram).at(-1).clientId === HOST_CID, 'Bram too');
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '2', null, { timeout: 20000 });
    assert(true, 'both players contributed their favourites, only the spelleider set Spotify up');
    const tok = await A.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.spotify.token.v1')));
    assert(tok.clientId === HOST_CID, 'the login remembers its Client ID (token refresh goes to the right Spotify app)');
    await shot(A, 'leader-02-player-shared');

    // ---------- a player with an own Client ID uses his own ----------
    const cas = await mixPhone(browser, rooms, base, { top: ACCOUNTS.ilse.top.slice(0, 8) }, { clientId: OWN_CID });
    const C = cas.page;
    all.push(C);
    await joinRoom(C, base, code, 'Cas', { via: 'link' });
    await C.getByTestId('mix-share').waitFor();
    assert(await C.getByTestId('mix-login-note').getAttribute('data-client') === 'own', 'Cas has an own setting: the note says so');
    await shareFavourites(C);
    await C.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await waitShared(C, 8);
    assert(authorizes(cas).at(-1).clientId === OWN_CID, 'Cas logs in with his own Client ID, not the spelleider\'s');
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '3', null, { timeout: 20000 });

    // ---------- a room whose spelleider has no Client ID ----------
    const host2 = await mixPhone(browser, rooms, base, ACCOUNTS.ilse, { clientId: false });
    const H2 = host2.page;
    all.push(H2);
    await H2.goto(`${base}#/spelleider`);
    const code2 = await createRoom(H2);
    const dirk = await mixPhone(browser, rooms, base, ACCOUNTS.bram, { clientId: false });
    const D = dirk.page;
    all.push(D);
    await joinRoom(D, base, code2, 'Dirk', { via: 'link' });
    await D.getByTestId('mix-no-client').waitFor();
    assert(/spelleider heeft Spotify nog niet ingesteld/.test(await D.getByTestId('mix-no-client').textContent()) && await D.getByTestId('mix-share').count() === 0, 'player: "De spelleider heeft Spotify nog niet ingesteld", no broken button');
    await H2.getByTestId('mix-no-client').waitFor();
    assert(/stel jij als spelleider één keer Spotify in/.test(await H2.getByTestId('mix-no-client').textContent()), 'spelleider: set Spotify up once, then everybody can join in');
    assert(await H2.getByTestId('mix-setup-hint').getAttribute('href') === '#/instellingen/spotify', 'spelleider: one line to the setup help');
    await shot(D, 'leader-03-player-no-client');
    await shot(H2, 'leader-04-host-no-client');
    // the spelleider sets it up (here: straight into storage) and comes back to the room
    await H2.getByTestId('mix-setup-hint').click();
    await H2.locator('[data-testid="spotify-block"][data-view="wizard-intro"]').waitFor();
    await H2.evaluate((cid) => localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid)), HOST_CID);
    await H2.goto(`${base}#/spelleider`);
    await H2.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 20000 });
    await D.getByTestId('mix-share').waitFor({ timeout: 20000 });
    assert(await D.getByTestId('mix-login-note').getAttribute('data-client') === 'room', 'once the spelleider has a Client ID, the waiting player can share right away');

    // ---------- an old app (before this change) against the new server ----------
    old = await startOldApp();
    if (!old) assert(true, `old app (${OLD_REF}) not in this git checkout: check skipped`);
    else {
      const ev = await mixPhone(browser, rooms, old.url, { top: ACCOUNTS.anouk.top.slice(0, 6) }, { clientId: OWN_CID });
      const E = ev.page;
      all.push(E);
      await joinRoom(E, old.url, code, 'Eva', { via: 'link' });
      await waitForPlayers(H, 4);
      assert(true, 'old app joins a room of the new server (same protocol version, no message about versions)');
      await E.getByTestId('mix-share').waitFor();
      await shareFavourites(E);
      await E.waitForURL(`${old.url}#/kamer/${code}`, { timeout: 20000 });
      await waitShared(E, 6);
      await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '4', null, { timeout: 20000 });
      assert(authorizes(ev).at(-1).clientId === OWN_CID, 'old app shares its favourites as before (own Client ID)');
      // the old app as spelleider: its hello has no cid; new players get the clear explanation
      const oldHost = await mixPhone(browser, rooms, old.url, ACCOUNTS.ilse, { clientId: OWN_CID });
      all.push(oldHost.page);
      await oldHost.page.goto(`${old.url}#/spelleider`);
      const code3 = await createRoom(oldHost.page);
      const fien = await mixPhone(browser, rooms, base, ACCOUNTS.bram, { clientId: false });
      all.push(fien.page);
      await joinRoom(fien.page, base, code3, 'Fien', { via: 'link' });
      await fien.page.getByTestId('mix-no-client').waitFor();
      await waitForPlayers(oldHost.page, 1);
      assert(true, 'old app as spelleider on the new server: room works, a new player without Client ID gets the explanation');
      // a short game in the old leader's room: nothing broke
      await oldHost.page.getByTestId('room-size-3').check();
      await oldHost.page.getByTestId('room-start').click();
      await fien.page.locator('[data-testid="play-panel"]').waitFor({ timeout: 20000 });
      assert(true, 'and a game starts in it');
    }
    assert(await contributors(H) === (old ? 4 : 3), 'room counts are right');
    assert(all.every((p) => !p.errors.length), `no page errors (${all.flatMap((p) => p.errors).join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
    old?.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
