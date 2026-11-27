// Print page: QR codes render, decode back to the expected URL, backs are mirrored, PDF renders.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/** Number of pages in a PDF written by Chromium. */
const pdfPages = (path) => (readFileSync(path, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, OUT } from './helpers.mjs';

/** Decode the QR svg of the given front card inside the page with the vendored jsQR. */
async function decodeFront(page, id) {
  return page.evaluate(async (cardId) => {
    if (!window.jsQR) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/jsQR.js'; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const svg = document.querySelector(`[data-testid="print-front"][data-card-id="${cardId}"] svg.qr`);
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode();
    const size = 400;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size);
    const hit = window.jsQR(data.data, size, size);
    return hit ? hit.data : null;
  }, id);
}

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
    await page.getByTestId('start-print').click();
    await page.getByTestId('screen-print').waitFor();
    await page.locator('[data-testid="print-front"]').first().waitFor();

    const fronts = await page.locator('[data-testid="print-front"]').count();
    const sheets = await page.locator('[data-testid="print-sheet"]').count();
    assert(fronts === 30 && sheets === 6, `all 30 cards on 3 sheet pairs (fronts ${fronts}, pages ${sheets})`);
    const base = await page.getByTestId('print-base-url').inputValue();
    assert(base === server.url, `default base URL is current location (${base})`);
    const decoded = await decodeFront(page, '001');
    assert(decoded === `${server.url}#/c/001`, `QR 001 decodes to ${decoded}`);
    await shot(page, '20-print');

    // Mirroring: first row of the back sheet must be 003, 002, 001.
    const backRow = await page.locator('[data-side="back"]').first().locator('.pc').evaluateAll((els) => els.slice(0, 3).map((e) => e.dataset.cardId));
    assert(backRow.join(',') === '003,002,001', `backs mirrored per row: ${backRow.join(',')}`);

    // Custom base URL + range.
    await page.getByTestId('print-base-url').fill('https://user.github.io/time-tunes/');
    await page.getByTestId('print-range').check();
    await page.getByTestId('print-from').fill('13');
    await page.getByTestId('print-to').fill('14');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="print-front"]').length === 2);
    const n = await page.locator('[data-testid="print-front"]').count();
    assert(n === 2, `range 13-14 gives 2 cards (${n})`);
    const lastBack = await page.locator('[data-side="back"] .pc').evaluateAll((els) => els.slice(0, 3).map((e) => e.dataset.cardId || '-'));
    assert(lastBack.join(',') === '-,014,013', `partial row mirrored with empty slot: ${lastBack.join(',')}`);
    const d2 = await decodeFront(page, '013');
    assert(d2 === 'https://user.github.io/time-tunes/#/c/013', `custom base QR decodes to ${d2}`);
    assert(/1 vel/.test(await page.getByTestId('print-summary').textContent()), 'summary shows 1 sheet');

    // Print layout as PDF (A4).
    await page.getByTestId('print-all').check();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="print-front"]').length > 2);
    await page.emulateMedia({ media: 'print' });
    const pdfPath = join(OUT, 'cards.pdf');
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
    await page.emulateMedia({ media: 'screen' });
    assert(pdfPages(pdfPath) === 6, `card PDF has 6 pages (${pdfPages(pdfPath)}) at ${pdfPath}`);

    // Bingokaarten: uniek, genummerd, 2 per A4.
    await page.getByTestId('print-kind-bingo').check();
    await page.locator('[data-testid="print-bingo-card"]').first().waitFor();
    assert(await page.getByTestId('print-base-url').isHidden(), 'base URL field hidden for bingo cards');
    assert((await page.locator('[data-testid="print-front"]').count()) === 0, 'no music cards in bingo mode');
    await page.getByTestId('print-bingo-count').fill('40');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="print-bingo-card"]').length === 30);
    let sigs = await page.locator('[data-testid="print-bingo-card"]').evaluateAll((els) => els.map((e) => [e.dataset.cardNo, e.dataset.signature]));
    assert(sigs.length === 30 && new Set(sigs.map((s) => s[1])).size === 30, `count is capped at 30 and all cards differ (${sigs.length})`);
    assert(sigs.map((s) => s[0]).join(',') === Array.from({ length: 30 }, (_, i) => i + 1).join(','), 'bingo cards numbered 1..30');
    assert((await page.locator('[data-testid="print-bingo-sheet"]').count()) === 15, '30 bingo cards on 15 sheets');
    await page.getByTestId('print-bingo-count').fill('7');
    await page.getByTestId('print-bingo-size-3').check();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="print-bingo-card"]').length === 7 && document.querySelector('[data-testid="print-bingo-card"]').dataset.signature.split(',').length === 9);
    sigs = await page.locator('[data-testid="print-bingo-card"]').evaluateAll((els) => els.map((e) => e.dataset.signature.split(',').length));
    assert(sigs.length === 7 && sigs.every((n) => n === 9), '7 cards of 3×3');
    assert(/7<\/b> bingokaarten 3×3 · 4 vellen/.test(await page.getByTestId('print-summary').innerHTML()), 'summary: 7 cards, 4 sheets');
    const before = await page.locator('[data-testid="print-bingo-card"]').first().getAttribute('data-signature');
    await page.getByTestId('print-bingo-reshuffle').click();
    const after = await page.locator('[data-testid="print-bingo-card"]').first().getAttribute('data-signature');
    assert(before !== after, 'reshuffle makes other cards');
    await shot(page, '23-print-bingo');
    await page.emulateMedia({ media: 'print' });
    const bingoPdf = join(OUT, 'bingo-cards.pdf');
    await page.pdf({ path: bingoPdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
    await page.emulateMedia({ media: 'screen' });
    assert(pdfPages(bingoPdf) === 4, `bingo PDF has 4 pages for 7 cards (${pdfPages(bingoPdf)})`);
    const overflow = await page.locator('.bk').evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1).length);
    assert(overflow === 0, 'bingo cards fit their half page');
    await page.getByTestId('print-kind-cards').check();
    await page.locator('[data-testid="print-front"]').first().waitFor();
    assert((await page.locator('[data-testid="print-front"]').count()) === 30, 'switching back shows the music cards again');

    // Desktop-sized preview screenshot of a sheet.
    const desk = await browser.newContext({ viewport: { width: 1100, height: 1300 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await useFixtureDeck(desk);
    const p2 = await desk.newPage();
    await p2.goto(`${server.url}#/print`);
    await p2.locator('[data-testid="print-front"]').first().waitFor();
    await p2.locator('[data-side="front"]').first().screenshot({ path: join(OUT, '21-print-sheet-front.png') });
    await p2.locator('[data-side="back"]').first().screenshot({ path: join(OUT, '22-print-sheet-back.png') });
    await p2.getByTestId('print-kind-bingo').check();
    await p2.locator('[data-testid="print-bingo-sheet"]').first().screenshot({ path: join(OUT, '24-print-bingo-sheet-4x4.png') });
    await desk.close();

    // Reset stored base URL so other runs start clean.
    await page.getByTestId('print-base-reset').click();
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
