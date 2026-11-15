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
//
// The same through the room server (server/node.mjs) instead of PeerJS:
//   const rooms = await startRoomServer();              // Node room server on 127.0.0.1
//   const host = await phone(browser, rooms, { seed: 7 });
//   ... createRoom / joinRoom / waitForPlayers work the same way.
// phone(browser, signal | null) always uses the PeerJS route (also now that app/config.js has
// a server address); phone(browser, 'app') leaves the app's own configuration alone.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { phoneContext, useFixtureDeck, ROOT } from './helpers.mjs';

export const SIGNAL_KEY = 'timetunesr.multiSignal.v1';
export const SEED_KEY = 'timetunesr.multiSeed.v1';
export const SERVER_KEY = 'timetunesr.multiServer.v1';

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
 * The Node room server (server/node.mjs) as a child process on a free port, so a test can
 * stop and restart it. Resolves with { kind: 'server', url, port, stop(), restart(), start() }.
 */
export async function startRoomServer({ port = null, origins = null } = {}) {
  const p = port || await freePort();
  let proc = null;
  const rs = {
    kind: 'server',
    port: p,
    url: `http://127.0.0.1:${p}`,
    start() {
      return new Promise((resolve, reject) => {
        proc = spawn(process.execPath, [join(ROOT, 'server/node.mjs')], {
          env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', ...(origins ? { ALLOWED_ORIGINS: origins } : {}) },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        const onData = (d) => { if (String(d).includes('luistert op poort')) { proc.stdout.off('data', onData); resolve(rs); } };
        proc.stdout.on('data', onData);
        proc.on('error', reject);
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!proc || proc.exitCode != null) { resolve(); return; }
        proc.once('exit', () => resolve());
        proc.kill('SIGKILL'); // like a crash or a host restart: everything in memory is gone
      });
    },
    async restart() { await rs.stop(); return rs.start(); },
  };
  return rs.start();
}

/**
 * A phone (own browser context = own localStorage = own player id).
 * `transport`: a PeerJS signal from startSignal() (or null: PeerJS with the app's broker),
 * a room server from startRoomServer(), or 'app' (the app's own configuration).
 * Options: seed (fixed game seed for the host), fixtureDeck (default true), extra context options.
 */
export async function phone(browser, signal, { seed = null, fixtureDeck = true, ...extra } = {}) {
  const context = await phoneContext(browser, extra);
  if (fixtureDeck) await useFixtureDeck(context);
  const viaServer = signal && signal.kind === 'server';
  const serverValue = signal === 'app' ? null : viaServer ? signal.url : 'off';
  await context.addInitScript(([key, cfg, seedKey, s, serverKey, server]) => {
    try {
      if (cfg) localStorage.setItem(key, JSON.stringify(cfg));
      if (s != null) localStorage.setItem(seedKey, String(s));
      if (server) localStorage.setItem(serverKey, JSON.stringify(server));
    } catch { /* ignore */ }
  }, [SIGNAL_KEY, signal && !viaServer && signal !== 'app' ? signal.config : null, SEED_KEY, seed, SERVER_KEY, serverValue]);
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

/** Via the room server: what the spelleider's screen knows (room summary, running song, meta). */
export const serverHost = (hostPage) => hostPage.evaluate(() => {
  const s = window.__ttHost?.session;
  return s ? { room: s.room, song: s.currentSong(), meta: s.meta, status: s.status, code: s.code } : null;
});
