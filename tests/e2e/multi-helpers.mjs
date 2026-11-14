// Helpers for "Samen spelen" scripts: a local PeerJS signalling server and phones that
// use it. Also meant for the explainer-video script (host and players side by side):
//
//   const signal = await startSignal();                 // local broker on 127.0.0.1
//   const server = await startServer();                 // the app (helpers.mjs)
//   const browser = await launch();
//   const host = await phone(browser, signal, { seed: 7 });   // fixed seed = predictable game
//   await host.page.goto(`${server.url}#/spelleider`);
//   const code = await createRoom(host.page);           // returns the room code
//   const anouk = await phone(browser, signal);
//   await joinRoom(anouk.page, server.url, code, 'Anouk');
import { createServer } from 'node:net';
import { phoneContext, useFixtureDeck } from './helpers.mjs';

export const SIGNAL_KEY = 'timetunesr.multiSignal.v1';
export const SEED_KEY = 'timetunesr.multiSeed.v1';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Local PeerJS server (npm package "peer"). Resolves with { port, config, stop }. */
export async function startSignal() {
  const { PeerServer } = await import('peer');
  const port = await freePort();
  const path = '/tt';
  const server = await new Promise((resolve) => {
    PeerServer({ port, host: '127.0.0.1', path, allow_discovery: false }, (httpServer) => resolve(httpServer));
  });
  return {
    port,
    // what the app reads from localStorage[SIGNAL_KEY]; iceServers [] = only local candidates (no STUN/TURN needed on one machine)
    config: { host: '127.0.0.1', port, path, secure: false, key: 'peerjs', iceServers: [] },
    stop: () => new Promise((r) => { try { server.close?.(() => r()); } catch { r(); } setTimeout(r, 300); }),
  };
}

/**
 * A phone (own browser context = own localStorage = own player id) that uses `signal`.
 * Options: seed (fixed game seed for the host), fixtureDeck (default true), extra context options.
 */
export async function phone(browser, signal, { seed = null, fixtureDeck = true, ...extra } = {}) {
  const context = await phoneContext(browser, extra);
  if (fixtureDeck) await useFixtureDeck(context);
  await context.addInitScript(([key, cfg, seedKey, s]) => {
    try {
      if (cfg) localStorage.setItem(key, JSON.stringify(cfg));
      if (s != null) localStorage.setItem(seedKey, String(s));
    } catch { /* ignore */ }
  }, [SIGNAL_KEY, signal ? signal.config : null, SEED_KEY, seed]);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return { context, page };
}

/** On #/spelleider: create a room (optionally playing along) and return its code. */
export async function createRoom(page, { hostPlays = false, name = '' } = {}) {
  await page.getByTestId('host-setup-form').waitFor();
  if (hostPlays) {
    await page.getByTestId('host-plays').check();
    await page.getByTestId('host-name').fill(name);
  }
  await page.getByTestId('host-create').click();
  await page.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
  await page.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 20000 });
  return (await page.getByTestId('room-code-big').textContent()).trim();
}

/** Join from the start page with the code (via = 'code') or straight through the link (via = 'link'). */
export async function joinRoom(page, baseUrl, code, name, { via = 'code' } = {}) {
  if (via === 'link') await page.goto(`${baseUrl}#/kamer/${code}`);
  else {
    await page.goto(baseUrl);
    await page.getByTestId('start-join').click();
    await page.getByTestId('join-code').fill(code.toLowerCase());
  }
  await page.getByTestId('join-name').fill(name);
  await page.getByTestId('join-submit').click();
  await page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
}

/** Wait until the host lists `n` players online. */
export async function waitForPlayers(hostPage, n) {
  await hostPage.waitForFunction((count) => document.querySelectorAll('[data-testid^="room-player-"][data-online="true"]').length >= count, n, { timeout: 20000 });
}

/** The host's room state (from its localStorage). */
export const hostRoom = (hostPage) => hostPage.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.multiHost.v1')));
