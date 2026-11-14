// Service worker: app works offline after one visit, and a new deploy is picked up (no stale cache).
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { launch, assert, OUT, ROOT } from './helpers.mjs';

function serve(root, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '--port', String(port), '--host', '127.0.0.1', '--root', root], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => { if (String(d).includes('draait op')) resolve(proc); });
    proc.on('error', reject);
  });
}

export default async function run() {
  const copy = join(OUT, 'pwa-site');
  rmSync(copy, { recursive: true, force: true });
  cpSync(join(ROOT, 'app'), copy, { recursive: true });
  writeFileSync(join(copy, 'data/deck.json'), readFileSync(join(ROOT, 'tests/fixtures/deck.json')));
  const port = 9100 + Math.floor(Math.random() * 400);
  const url = `http://localhost:${port}/`;
  const server = await serve(relative(ROOT, copy), port);
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.getByTestId('screen-start').waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert(true, 'service worker installed and controlling the page');
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const c = await caches.open(keys.find((k) => k.startsWith('timetunesr-')));
      return (await c.keys()).length;
    });
    assert(cached >= 20, `app shell precached (${cached} entries)`);

    await ctx.setOffline(true);
    await page.reload();
    await page.getByTestId('screen-start').waitFor();
    await page.goto(`${url}#/c/003`);
    await page.getByTestId('screen-card').waitFor();
    await page.getByTestId('player').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'error', null, { timeout: 15000 });
    const status = await page.getByTestId('player-status').textContent();
    assert(/internetverbinding/i.test(status), `offline: app shell loads from cache, player says "${status}"`);
    await ctx.setOffline(false);

    // New deploy: change the start screen text on the server; one normal reload must show it.
    const startJs = join(copy, 'js/screens/start.js');
    writeFileSync(startJs, readFileSync(startJs, 'utf8').replace('Luister. Raad het jaar. Speel samen.', 'NIEUWE VERSIE'));
    await page.goto(url);
    await page.reload();
    await page.getByTestId('screen-start').waitFor();
    const tagline = await page.locator('.tagline').textContent();
    assert(tagline === 'NIEUWE VERSIE', 'new deploy is visible after a reload (network-first, not stuck on old cache)');
  } finally {
    await browser.close();
    server.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
