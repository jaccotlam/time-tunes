// Renders app/icons/icon.svg to the PNG icons (dev-only; needs Playwright).
// Usage: npm run icons
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = fileURLToPath(new URL('../app/icons/', import.meta.url));
const svg = await readFile(`${dir}icon.svg`, 'utf8');
// Full-bleed variant (no rounded corners) for maskable / iOS icons.
const square = svg.replace(/ rx="112"/g, '');

const targets = [
  { file: 'icon-192.png', size: 192, src: svg },
  { file: 'icon-512.png', size: 512, src: svg },
  { file: 'icon-maskable-512.png', size: 512, src: square },
  { file: 'apple-touch-icon.png', size: 180, src: square },
  { file: 'favicon-32.png', size: 32, src: svg },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${t.src.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `)}</body></html>`);
  await page.screenshot({ path: `${dir}${t.file}`, omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log('wrote', t.file);
}
await browser.close();
