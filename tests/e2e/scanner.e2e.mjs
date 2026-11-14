// Camera scanner with a fake camera (ffmpeg-made video of a printed card).
// - jsQR path: BarcodeDetector removed from the page (as on iOS Safari)
// - native path: real BarcodeDetector if this Chromium has one, else a stub to test the wiring
// - foreign QR code: friendly toast, stays on the scanner
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, OUT } from './helpers.mjs';

async function makeVideo(browser, server, text, name) {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(server.url);
  const png = join(OUT, `${name}.png`);
  await page.evaluate(async (t) => {
    const { qrSvg } = await import('./js/screens/print.js');
    document.body.innerHTML = `<div id="card" style="width:420px;height:420px;background:#fff;display:grid;place-items:center;border-radius:24px">
      <div style="width:300px;height:300px">${qrSvg(t)}</div></div>`;
    document.body.style.cssText = 'margin:0;background:#2b2033;display:grid;place-items:center;height:600px';
  }, text);
  await page.locator('#card').screenshot({ path: png });
  await ctx.close();
  const y4m = join(OUT, `${name}.y4m`);
  execFileSync('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '2', '-r', '10',
    '-vf', 'scale=380:380,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=0x3a2a44,format=yuv420p', join(y4m)]);
  return y4m;
}

const cameraArgs = (file) => ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`];

async function scanWith(server, video, { disableNative = false, stubNative = null } = {}) {
  const browser = await launch(cameraArgs(video));
  const ctx = await phoneContext(browser, { permissions: ['camera'] });
  await useFixtureDeck(ctx);
  if (disableNative) await ctx.addInitScript(() => { delete window.BarcodeDetector; });
  if (stubNative) {
    await ctx.addInitScript((value) => {
      window.BarcodeDetector = class {
        static async getSupportedFormats() { return ['qr_code']; }
        constructor() { this.n = 0; }
        async detect() { this.n += 1; return this.n > 3 ? [{ rawValue: value }] : []; }
      };
    }, stubNative);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.url}#/scan`);
  return { browser, page, errors };
}

export default async function run() {
  const server = await startServer();
  const prep = await launch();
  const good = await makeVideo(prep, server, `${server.url}#/c/007`, 'fake-cam-card-007');
  const foreign = await makeVideo(prep, server, 'https://example.com/niet-van-ons', 'fake-cam-foreign');
  await prep.close();
  try {
    // 1. jsQR path (no BarcodeDetector, like iOS Safari)
    {
      const { browser, page, errors } = await scanWith(server, good, { disableNative: true });
      await page.waitForURL(/#\/c\/007$/, { timeout: 15000 });
      assert(await page.evaluate(() => document.documentElement.dataset.scanDetector) === 'jsqr', 'jsQR detector was used');
      await page.getByTestId('screen-card').waitFor();
      assert(true, 'jsQR scan of fake camera opens hidden player for card 007');
      const live = await page.evaluate(() => document.querySelectorAll('video').length);
      assert(live === 0, 'camera view removed after scan');
      assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
      await browser.close();
    }
    // 2. native BarcodeDetector path
    {
      const probe = await launch(cameraArgs(good));
      const p = await (await phoneContext(probe)).newPage();
      await p.goto(server.url);
      const hasNative = await p.evaluate(async () => 'BarcodeDetector' in window
        && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code'));
      await probe.close();
      const { browser, page } = await scanWith(server, good, hasNative ? {} : { stubNative: `${server.url}#/c/003` });
      await page.waitForURL(hasNative ? /#\/c\/007$/ : /#\/c\/003$/, { timeout: 15000 });
      assert(await page.evaluate(() => document.documentElement.dataset.scanDetector) === 'native', `native detector path used (${hasNative ? 'real BarcodeDetector' : 'stubbed: this Chromium has no BarcodeDetector'})`);
      assert(true, 'native path navigates to the card');
      await browser.close();
    }
    // 3. foreign QR code -> toast, stay on scanner
    {
      const { browser, page } = await scanWith(server, foreign, { disableNative: true });
      await page.locator('[data-state="scanning"]').waitFor({ timeout: 15000 });
      await page.getByTestId('toast').filter({ hasText: 'hoort niet bij TimeTunesr' }).waitFor({ timeout: 15000 });
      assert(page.url().endsWith('#/scan'), 'foreign QR shows toast and keeps scanning');
      await shot(page, '30-scan-camera-foreign-qr');
      await browser.close();
    }
    // 4. camera denied by the user (stubbed: headless Chromium cannot show a real permission prompt)
    {
      const browser = await launch();
      const ctx = await phoneContext(browser);
      await useFixtureDeck(ctx);
      await ctx.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
      const page = await ctx.newPage();
      await page.goto(`${server.url}#/scan`);
      await page.getByTestId('camera-error').waitFor({ timeout: 15000 });
      const code = await page.getByTestId('viewfinder').getAttribute('data-error');
      assert(code === 'denied', `camera refused -> error "${code}"`);
      assert(await page.getByTestId('manual-input').isVisible(), 'manual entry offered');
      await shot(page, '32-scan-denied');
      await page.getByTestId('manual-input').fill('12');
      await page.getByTestId('manual-input').press('Enter');
      await page.waitForURL(/#\/c\/012$/);
      assert(true, 'manual entry with Enter opens card 012');
      await browser.close();
    }
  } finally {
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
