// Shared helpers for the Playwright end-to-end scripts (run with `npm run test:e2e`).
// Screenshots, fake-camera videos and the PDF go to $E2E_OUT (default: <tmp>/timetunesr-e2e).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const OUT = process.env.E2E_OUT || join(tmpdir(), 'timetunesr-e2e');
mkdirSync(OUT, { recursive: true });
export const FIXTURE_DECK = readFileSync(join(ROOT, 'tests/fixtures/deck.json'), 'utf8');

/** Start the static server on a free port; resolves with { url, stop }. */
export function startServer(port = 8000 + Math.floor(Math.random() * 900)) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '--port', String(port), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => {
      if (String(d).includes('draait op')) resolve({ url: `http://localhost:${port}/`, stop: () => proc.kill() });
    });
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}

/** Launch Chromium; routes external traffic through the sandbox proxy when present. */
export function launch(args = [], { autoplay = true } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    args: [...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []), ...args],
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
  });
}

/** Phone-sized context (deviceScaleFactor 1 keeps screenshots small). */
export function phoneContext(browser, extra = {}) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: 'nl-NL',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    serviceWorkers: 'block',
    ...extra,
  });
}

/** Serve the test fixture instead of app/data/deck.json (which another process may be rewriting). */
export async function useFixtureDeck(target) {
  await target.route('**/data/deck.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: FIXTURE_DECK,
  }));
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ok - ${msg}`);
}

export async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  // animations: 'disabled' jumps finite CSS animations (the screen fade-in) to their end state: no sleep needed
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  return path;
}
