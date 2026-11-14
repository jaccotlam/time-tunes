// Screenshots of the static screens (start, rules) + basic PWA checks.
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot } from './helpers.mjs';

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
    await shot(page, '00-start');
    for (const id of ['start-scan', 'start-digital', 'start-print', 'start-rules', 'start-bingo', 'start-settings']) {
      assert(await page.getByTestId(id).isVisible(), `start button ${id} visible`);
    }
    // De vier hoofdingangen staan zonder scrollen in beeld (390×844), verdeeld over twee manieren van spelen.
    const bottoms = await page.evaluate(() => ['start-scan', 'start-print', 'start-digital', 'start-bingo']
      .map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().bottom));
    assert(bottoms.every((b) => b <= 844), `four main entries above the fold (lowest at ${Math.round(Math.max(...bottoms))}px)`);
    assert(await page.locator('[data-testid="mode-cards"] [data-testid="start-scan"], [data-testid="mode-cards"] [data-testid="start-print"]').count() === 2, 'scan + print under "Met kaartjes"');
    assert(await page.locator('[data-testid="mode-app"] [data-testid="start-digital"], [data-testid="mode-app"] [data-testid="start-bingo"]').count() === 2, 'Tijdlijn + Bingo under "Alleen de app"');
    assert((await page.getByTestId('start-settings').getAttribute('href')) === '#/instellingen', 'settings link points to #/instellingen');
    assert((await page.getByTestId('app-version').textContent()).trim() === 'v2', 'version label v2');
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(scrollW <= 390, `no horizontal scroll (${scrollW})`);
    await page.getByTestId('start-rules').click();
    await page.getByTestId('screen-rules').waitFor();
    await shot(page, '40-rules');
    for (const id of ['rules-modes', 'rules-timeline', 'rules-bingo']) assert(await page.getByTestId(id).count() === 1, `rules section ${id}`);
    await page.getByTestId('back-home').click();
    await page.getByTestId('screen-start').waitFor();

    const manifest = await (await page.request.get(`${server.url}manifest.webmanifest`)).json();
    assert(manifest.start_url === './' && manifest.icons.length >= 3, 'manifest uses relative start_url and has icons');
    for (const icon of manifest.icons) {
      const r = await page.request.get(`${server.url}${icon.src}`);
      assert(r.ok(), `icon ${icon.src} served`);
    }
    // No absolute paths in the app shell (needed for GitHub Pages subfolders).
    const html = await (await page.request.get(server.url)).text();
    assert(!/(href|src)="\//.test(html), 'index.html only uses relative paths');
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
