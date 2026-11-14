// Start -> scan screen (no camera) -> manual card number -> hidden player -> hold to reveal.
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, FIXTURE_DECK } from './helpers.mjs';

export default async function run() {
  const server = await startServer();
  const browser = await launch();
  try {
    const ctx = await phoneContext(browser);
    await useFixtureDeck(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(server.url);
    await page.getByTestId('screen-start').waitFor();
    await page.waitForFunction(() => /kaarten in het deck/.test(document.querySelector('[data-testid="deck-info"]').textContent));
    await shot(page, '01-start');

    await page.getByTestId('start-scan').click();
    await page.getByTestId('screen-scan').waitFor();
    // Headless Chromium without a fake camera: expect a friendly camera error + manual entry.
    await page.getByTestId('camera-error').waitFor({ timeout: 10000 });
    const errTitle = await page.locator('.vf-error-title').textContent();
    assert(errTitle.length > 0, `camera error shown: "${errTitle}"`);
    await shot(page, '02-scan-no-camera');

    await page.getByTestId('manual-input').fill('999');
    await page.getByTestId('manual-submit').click();
    const msg = await page.getByTestId('manual-msg').textContent();
    assert(/staat niet in dit deck/.test(msg), 'unknown card number gives message');

    await page.getByTestId('manual-input').fill('1');
    await page.getByTestId('manual-submit').click();
    await page.getByTestId('screen-card').waitFor();
    assert(page.url().endsWith('#/c/001'), 'navigated to #/c/001');

    const card = JSON.parse(FIXTURE_DECK).cards[0];
    const domText = await page.evaluate(() => document.documentElement.textContent);
    for (const secret of [card.title, card.artist, String(card.year)]) {
      assert(!domText.includes(secret), `hidden screen does not contain "${secret}"`);
    }

    // Audio must really load and play (fresh iTunes lookup or deck fallback).
    await page.waitForFunction(() => {
      const a = document.querySelector('audio');
      return a && a.currentTime > 0.5 && !a.paused;
    }, null, { timeout: 25000 });
    const audioInfo = await page.evaluate(() => {
      const a = document.querySelector('audio');
      return { src: a.currentSrc, t: a.currentTime, d: a.duration, source: window.__tt.player.state.source };
    });
    assert(/audio-ssl\.itunes\.apple\.com/.test(audioInfo.src), `audio from iTunes (${audioInfo.source}) at ${audioInfo.t.toFixed(1)}s of ${audioInfo.d.toFixed(1)}s`);
    assert(await page.getByTestId('player').getAttribute('data-status') === 'playing', 'player UI shows playing');
    await page.waitForTimeout(800);
    await shot(page, '03-card-playing');

    // pause / restart
    await page.getByTestId('play-toggle').click();
    await page.waitForFunction(() => document.querySelector('audio').paused);
    assert(true, 'pause works');
    await page.getByTestId('restart').click();
    await page.waitForFunction(() => { const a = document.querySelector('audio'); return !a.paused && a.currentTime < 3; });
    assert(true, 'restart plays from start');

    // A short tap must NOT reveal the answer.
    await page.getByTestId('reveal-hold').click();
    await page.waitForTimeout(300);
    assert(await page.getByTestId('answer').count() === 0, 'short tap does not reveal');

    // Hold for 1.7 s reveals.
    const box = await page.getByTestId('reveal-hold').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1750);
    await page.mouse.up();
    await page.getByTestId('answer').waitFor();
    assert(await page.getByTestId('answer-year').textContent() === String(card.year), 'answer shows year');
    assert(await page.getByTestId('answer-artist').textContent() === card.artist, 'answer shows artist');
    assert(await page.getByTestId('answer-title').textContent() === card.title, 'answer shows title');
    assert(/music\.apple\.com/.test(await page.getByTestId('answer-apple-music').getAttribute('href')), 'Apple Music link');
    await shot(page, '04-card-answer');
    await page.getByTestId('answer-close').click();
    assert(await page.getByTestId('answer').count() === 0, 'answer can be hidden again');

    // Direct open via QR URL in a fresh page: autoplay blocked -> big play button.
    const ctx2 = await phoneContext(browser);
    await useFixtureDeck(ctx2);
    const p2 = await ctx2.newPage();
    await p2.goto(`${server.url}#/c/005`);
    await p2.getByTestId('screen-card').waitFor();
    const st = await p2.getByTestId('player').getAttribute('data-status');
    assert(['loading', 'ready', 'playing', 'blocked'].includes(st), `deep link opens hidden player (status ${st})`);
    await p2.goto(`${server.url}#/c/777`);
    await p2.getByTestId('screen-unknown-card').waitFor();
    assert(true, 'unknown card deep link shows friendly screen');
    await shot(p2, '05-unknown-card');
    await ctx2.close();

    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);

    // Like iOS Safari: play() without a user gesture is refused. Headless Chromium's own
    // autoplay policy is not usable here (Playwright's evaluate() counts as a user gesture),
    // so the page only allows play() after a real (trusted) tap.
    const ctx3 = await phoneContext(browser);
    await useFixtureDeck(ctx3);
    await ctx3.addInitScript(() => {
      let tapped = false;
      window.addEventListener('pointerdown', (e) => { if (e.isTrusted) tapped = true; }, true);
      const orig = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function play() {
        if (!tapped) return Promise.reject(new DOMException('gesture required', 'NotAllowedError'));
        return orig.call(this);
      };
    });
    const p3 = await ctx3.newPage();
    await p3.goto(`${server.url}#/c/001`);
    await p3.getByTestId('play-big').waitFor({ timeout: 20000 });
    assert(await p3.getByTestId('player').getAttribute('data-status') === 'blocked', 'autoplay refused -> big play button shown');
    await shot(p3, '06-card-autoplay-blocked');
    await p3.getByTestId('play-big').click();
    await p3.waitForFunction(() => { const a = document.querySelector('audio'); return a.currentTime > 0.3 && !a.paused; }, null, { timeout: 20000 });
    assert(await p3.getByTestId('play-big').isHidden(), 'tap on Speel af starts the fragment');
    await ctx3.close();
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
