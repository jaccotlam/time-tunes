// Stap 3: teken de video frame voor frame en zet hem om naar MP4.
// Het decor (stage/stage.html) is een pure functie van de tijd; per frame wordt het juiste
// telefoonbeeld uit de opname erin gezet en een verliesvrije screenshot van 1920x1080 gemaakt.
// Dat is trager dan Playwrights recordVideo, maar haarscherp en precies 30 fps.
import { rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, FPS, VIDEO, OUT_FILE } from './config.mjs';
import { startServer, launch, serveStage, ensureDir, ffmpeg, ffmpegPipe } from './lib.mjs';

async function openStage(browser, server) {
  const ctx = await browser.newContext({ viewport: VIDEO, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await serveStage(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('fout in het decor:', e.message); process.exitCode = 1; });
  await page.goto(`${server.url}__video/stage.html`);
  await page.waitForFunction(() => window.stageReady === true, null, { timeout: 30000 });
  return page;
}

/** Losse beelden (voor het nakijken van de vormgeving): node 3-render.mjs --still 12.5 --still 40 */
export async function stills(times) {
  const server = await startServer();
  const browser = await launch();
  try {
    const page = await openStage(browser, server);
    const warnings = await page.evaluate(() => window.stageWarnings);
    for (const w of warnings) console.warn('LET OP:', w);
    const dir = ensureDir(join(TMP, 'stills'));
    for (const t of times) {
      await page.evaluate((x) => window.renderFrame(x), t);
      const file = join(dir, `still-${t.toFixed(2).padStart(6, '0')}.png`);
      await page.screenshot({ path: file, type: 'png' });
      console.log(file);
    }
  } finally { await browser.close(); server.stop(); }
}

// H.264, yuv420p, 30 fps; zonder geluidsspoor (de fragmenten uit de app mogen niet mee).
const X264 = ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-r', String(FPS), '-an'];

export async function render({ workers = 3 } = {}) {
  const events = JSON.parse(readFileSync(join(TMP, 'events.json'), 'utf8'));
  const total = Math.round(events.duration * FPS);
  const dir = join(TMP, 'segments');
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const server = await startServer();
  const browser = await launch();
  const started = Date.now();
  const per = Math.ceil(total / workers);
  const segments = Array.from({ length: workers }, (_, w) => join(dir, `deel-${w}.mp4`));
  try {
    let done = 0;
    // Elke worker tekent een aaneengesloten stuk van de video en stuurt de screenshots direct naar ffmpeg.
    await Promise.all(segments.map(async (file, w) => {
      const page = await openStage(browser, server);
      if (w === 0) for (const msg of await page.evaluate(() => window.stageWarnings)) console.warn('LET OP:', msg);
      const cdp = await page.context().newCDPSession(page);
      const enc = ffmpegPipe(['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', ...X264, file]);
      for (let i = w * per; i < Math.min(total, (w + 1) * per); i++) {
        await page.evaluate((t) => window.renderFrame(t), i / FPS);
        // optimizeForSpeed: zelfde pixels, veel snellere (minder gecomprimeerde) PNG
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        await enc.write(Buffer.from(data, 'base64'));
        done += 1;
        if (done % 300 === 0) console.log(`  ${done}/${total} frames (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      }
      await enc.end();
    }));
  } finally { await browser.close(); server.stop(); }

  const list = join(dir, 'lijst.txt');
  writeFileSync(list, segments.map((f) => `file '${f}'\n`).join(''));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', OUT_FILE]);
  const mb = statSync(OUT_FILE).size / 1e6;
  console.log(`video: ${OUT_FILE} (${(total / FPS).toFixed(1)} s, ${total} frames, ${mb.toFixed(1)} MB)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const times = args.flatMap((a, i) => (a === '--still' ? [Number(args[i + 1])] : []));
  (times.length ? stills(times) : render()).catch((e) => { console.error(e); process.exit(1); });
}
