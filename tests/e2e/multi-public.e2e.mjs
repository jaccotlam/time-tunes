// Smoke test of "Samen spelen" through the real, free public PeerJS broker (0.peerjs.com):
// host + 1 player, one Bingo round. Not part of `npm run test:e2e` because it depends on an
// outside service without guarantees; run it with `npm run test:e2e:public`.
import { launch, startServer, assert, shot } from './helpers.mjs';
import { phone, createRoom, joinRoom, waitForPlayers } from './multi-helpers.mjs';

export default async function run() {
  const server = await startServer();
  const browser = await launch();
  try {
    const host = await phone(browser, null, { seed: 7 }); // null: no override, the app's own config (0.peerjs.com)
    const H = host.page;
    await H.goto(`${server.url}#/spelleider`);
    const cfg = await H.evaluate(async () => (await import('./js/multi/transport.js')).signalConfig());
    assert(cfg.host === '0.peerjs.com', `uses the public broker (${cfg.host})`);
    const t0 = Date.now();
    const code = await createRoom(H);
    assert(true, `room ${code} registered on the public broker in ${Date.now() - t0} ms`);
    const P = (await phone(browser, null)).page;
    const t1 = Date.now();
    await joinRoom(P, server.url, code, 'Sam');
    await waitForPlayers(H, 1);
    assert(true, `player connected over WebRTC in ${Date.now() - t1} ms`);
    await H.getByTestId('room-game-bingo').check();
    await H.getByTestId('room-start').click();
    await P.locator('[data-testid="play-panel"]').waitFor({ timeout: 20000 });
    await P.getByTestId('answer-pass').click();
    await P.locator('[data-testid="answer-state"][data-state="locked"]').waitFor({ timeout: 20000 });
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 20000 });
    await H.getByTestId('room-reveal').click();
    await P.locator('[data-testid="screen-room-player"][data-view="revealed"]').waitFor({ timeout: 20000 });
    assert(await P.getByTestId('answer-card').count() === 1, 'one round over the public broker: answer reached the host, reveal reached the player');
    await shot(P, '90-multi-public-player');
    await H.getByTestId('host-close').click();
    const errors = [...H.errors, ...P.errors];
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
