// v3-11 removed Deezer ("Haal Deezer er uit"): no file under app/ may still name a Deezer host,
// and nothing may still load the removed modules. Comments about the data migration may say
// "Deezer" (playlist-logic.js explains what v3-10 stored); a host name may not appear at all.
// The e2e suites check the same in a real browser (fake-itunes.mjs records any request to a
// Deezer host and the suites assert there was none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const app = join(root, 'app');

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}
const textFiles = files(app).filter((p) => /\.(js|mjs|css|html|json|webmanifest|txt|svg)$/.test(p) && !p.includes(`${join('app', 'vendor')}`));

test('geen bestand in app/ noemt deezer.com of dzcdn.net', () => {
  const hits = [];
  for (const p of textFiles) {
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/deezer\.com|dzcdn\.net|api\.deezer|deezer\.page\.link|dzr\.page\.link/gi)) hits.push(`${relative(root, p)}: ${m[0]}`);
  }
  assert.deepEqual(hits, []);
});

test('de weggehaalde onderdelen zijn echt weg (bestanden, imports, precache, functies)', () => {
  assert.equal(existsSync(join(app, 'js', 'deezer.js')), false);
  const sw = readFileSync(join(app, 'sw.js'), 'utf8');
  assert.doesNotMatch(sw, /deezer/i, 'niet in de precache');
  assert.match(sw, /const VERSION = 'v3-11';/);
  const bad = [/from ['"][./]*deezer\.js['"]/, /import\(['"][./]*deezer\.js['"]\)/, /setDeezerPreview/, /\bFEATURED\b/, /deezerItems/, /deezerUrl/, /SERVER_FEATURES = \[[^\]]*mix-playlists/, /data-testid="pl-quick/, /sheet-listen/, /pl-search-note/];
  const hits = [];
  for (const p of textFiles.filter((x) => /\.(js|mjs|html|css)$/.test(x))) {
    const text = readFileSync(p, 'utf8');
    for (const re of bad) if (re.test(text)) hits.push(`${relative(root, p)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('waar "Deezer" nog in app/ staat, gaat het over de gegevens van v3-10 (de overgang)', () => {
  const hits = [];
  for (const p of textFiles) {
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/deezer/i.test(line)) return;
      // the stored field of v3-10 and its legacy helpers, or a comment that says v3-10 / v3-11
      const ok = /v3-1[01]/.test(line) || /deezerId|legacySource|'deezer'|Deezer import|Deezer-import|from Deezer|imported from Deezer/.test(line);
      if (!ok) hits.push(`${relative(root, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});
