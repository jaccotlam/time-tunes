// Smoke test against the REAL iTunes Search API and real previews (needs internet; not part
// of `npm run test:e2e`). Run: node tests/e2e/playlists-live.e2e.mjs
// search -> add -> year; paste 3 lines (one nonsense); activate; play a card; play a
// printed own-card code (#/c/~...) in a clean browser.
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot } from './helpers.mjs';

const L = await import(new URL('../../app/js/playlist-logic.js', import.meta.url).href);

export default async function run() {
  const server = await startServer(8300 + Math.floor(Math.random() * 90));
  const base = server.url;
  const browser = await launch();
  try {
    const ctx = await phoneContext(browser);
    await useFixtureDeck(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    const itunesCalls = [];
    page.on('request', (r) => { if (r.url().startsWith('https://itunes.apple.com/')) itunesCalls.push(r.url()); });

    await page.goto(`${base}#/playlists`);
    await page.getByTestId('playlist-new-name').fill('Live test');
    await page.getByTestId('playlist-create').click();
    await page.getByTestId('pl-search-input').fill('queen bohemian rhapsody');
    await page.getByTestId('pl-search-go').click();
    await page.locator('[data-testid="pl-search-result"]').first().waitFor({ timeout: 20000 });
    const n = await page.locator('[data-testid="pl-search-result"]').count();
    const first = await page.locator('[data-testid="pl-search-result"]').first().textContent();
    assert(/Bohemian Rhapsody/.test(first) && /Queen/.test(first), `real search: ${n} results, first "${first.replace(/\s+/g, ' ').trim()}"`);
    await shot(page, 'live-01-search');
    await page.locator('[data-testid="pl-search-result"]').first().click();
    await page.locator('[data-testid="pl-track"]').first().waitFor();
    let pl = (await page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')))).lists[0];
    console.log(`  info - added: ${pl.tracks[0].artist} - ${pl.tracks[0].title} (${pl.tracks[0].album}), year ${pl.tracks[0].year}, sure=${pl.tracks[0].yearSure}`);
    assert(pl.tracks[0].year === 1975, `year chosen for Bohemian Rhapsody: ${pl.tracks[0].year}`);

    await page.getByTestId('pl-tab-paste').click();
    await page.getByTestId('pl-paste-input').fill('ABBA - Dancing Queen\nDoe Maar - De Bom\nXqzzt Vlorp - Blarg Snorf');
    await page.getByTestId('pl-paste-start').click();
    await page.getByTestId('pl-paste-start').waitFor({ timeout: 60000 });
    const summary = await page.getByTestId('pl-paste-summary').textContent();
    console.log(`  info - paste: ${summary}`);
    pl = (await page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')))).lists[0];
    for (const t of pl.tracks) console.log(`  info -   ${t.artist} - ${t.title} [${t.album}] ${t.year}${t.yearSure ? '' : ' (controleer)'}`);
    assert(/1 niet gevonden/.test(summary) && pl.tracks.length === 3, 'paste: 2 found, nonsense line not found');
    await shot(page, 'live-02-paste');

    await page.getByTestId('pl-activate').click();
    const abba = pl.tracks.find((t) => /Dancing Queen/.test(t.title));
    await page.goto(`${base}#/c/${L.padN(abba.n)}`);
    await page.getByTestId('screen-card').waitFor();
    await page.waitForFunction(() => window.__tt.player.state.status === 'playing', null, { timeout: 20000 });
    const src = await page.evaluate(() => document.querySelector('audio').src);
    assert(/^https:\/\/audio-ssl\.itunes\.apple\.com\//.test(src), 'own playlist card plays a real preview');
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 1, null, { timeout: 15000 });
    assert(true, 'audio is advancing');

    // printed own-card code in a clean browser
    const code = L.encodeCardCode(abba.itunesId, abba.year);
    const ctx2 = await phoneContext(browser);
    await useFixtureDeck(ctx2);
    const p2 = await ctx2.newPage();
    await p2.goto(`${base}#/c/${code}`);
    await p2.getByTestId('screen-card').waitFor();
    await p2.waitForFunction(() => window.__tt.player.state.status === 'playing', null, { timeout: 20000 });
    assert(true, `clean browser plays #/c/${code} (lookup by id)`);
    const box = await p2.getByTestId('reveal-hold').boundingBox();
    await p2.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p2.mouse.down(); await p2.waitForTimeout(1750); await p2.mouse.up();
    await p2.getByTestId('answer').waitFor();
    const ans = `${await p2.getByTestId('answer-year').textContent()} ${await p2.getByTestId('answer-artist').textContent()} - ${await p2.getByTestId('answer-title').textContent()}`;
    assert(/Dancing Queen/.test(ans) && ans.startsWith(String(abba.year)), `answer: ${ans}`);
    await shot(p2, 'live-03-other-phone-answer');
    console.log(`  info - iTunes requests from the playlist page: ${itunesCalls.length}`);
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
