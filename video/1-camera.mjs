// Stap 1: maak de nep-camerabeelden. Per kaart een filmpje (MJPEG, 1280x720, 30 fps) waarin
// een geprinte TimeTunesr-kaart het beeld in schuift. Chromium speelt dit af als "camera"
// (--use-file-for-fake-video-capture). De kaart is de echte printopmaak van de app.
import { join } from 'node:path';
import { TMP, PUBLIC_URL, TABLE, FPS } from './config.mjs';
import { startServer, launch, serveStage, ensureDir, ffmpegPipe } from './lib.mjs';

export const CAM_SECONDS = 9;
export const camFile = (id) => join(ensureDir(join(TMP, 'camera')), `kaart-${id}.mjpeg`);
/**
 * Wanneer de kaart in beeld schuift (in0), stil ligt (in1) en scherp is (sharp), in seconden
 * na het starten van de camera. De eerste kaart komt rustig in beeld, zodat er tijd is om de
 * ondertitel te lezen; de tweede kaart gaat vlotter.
 */
export const FILMS = [
  { id: TABLE.good, in0: 2.6, in1: 3.7, sharp: 4.4 },
  { id: TABLE.bad, in0: 0.7, in1: 1.5, sharp: 2.0 },
];

export async function makeCameraFilms(films = FILMS) {
  const server = await startServer();
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await serveStage(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { throw e; });
    for (const { id, in0, in1, sharp } of films) {
      await page.goto(`${server.url}__video/camera.html?card=${id}&base=${encodeURIComponent(PUBLIC_URL)}&in0=${in0}&in1=${in1}&sharp=${sharp}`);
      await page.waitForFunction(() => window.camReady === true);
      const out = camFile(id);
      const enc = ffmpegPipe(['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
        '-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p', '-f', 'mjpeg', out]);
      const n = CAM_SECONDS * FPS;
      for (let i = 0; i < n; i++) {
        await page.evaluate((t) => window.renderCam(t), i / FPS);
        await enc.write(await page.screenshot({ type: 'png' }));
      }
      await enc.end();
      console.log(`camera: ${out} (${n} frames)`);
    }
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  makeCameraFilms().catch((e) => { console.error(e); process.exit(1); });
}
