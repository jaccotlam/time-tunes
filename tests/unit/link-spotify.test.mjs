// tools/link-spotify.mjs against a local fake Spotify (no network, no real keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../../tools/link-spotify.mjs', import.meta.url));
const ID_A = 'A'.repeat(22);
const ID_A_LIVE = 'L'.repeat(22);
const ID_B = 'B'.repeat(22);

const deck = {
  version: 1,
  country: 'NL',
  cards: [
    { id: '001', title: 'Dancing Queen', artist: 'ABBA', year: 1976, itunesId: 1, previewUrl: 'x' },
    { id: '002', title: 'Live and Let Die', artist: 'Paul McCartney & Wings', year: 1973, itunesId: 2, previewUrl: 'x' },
    { id: '003', title: 'Onbekend Liedje', artist: 'Niemand', year: 1990, itunesId: 3, previewUrl: 'x' },
    { id: '004', title: 'Al Gekoppeld', artist: 'Iemand', year: 1980, itunesId: 4, spotifyId: 'C'.repeat(22) },
  ],
};

function fakeSpotify() {
  const log = [];
  let rateLimited = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/token') {
      assert.equal(req.headers.authorization, `Basic ${Buffer.from('cid:secret').toString('base64')}`);
      return send(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname === '/v1/search') {
      assert.equal(req.headers.authorization, 'Bearer tok');
      assert.equal(url.searchParams.get('limit'), '10');
      assert.equal(url.searchParams.get('type'), 'track');
      if (!rateLimited) { rateLimited = true; return send(429, { error: { status: 429 } }, { 'retry-after': '1' }); }
      const q = url.searchParams.get('q');
      const t = (id, name, artists, album) => ({ id, uri: `spotify:track:${id}`, name, artists: artists.map((n) => ({ name: n })), album: { name: album }, duration_ms: 1000 });
      if (/Dancing Queen/.test(q)) return send(200, { tracks: { items: [t(ID_A_LIVE, 'Dancing Queen - Live', ['ABBA'], 'ABBA Live'), t(ID_A, 'Dancing Queen', ['ABBA'], 'Arrival')] } });
      if (/Live and Let Die/.test(q)) return send(200, { tracks: { items: [t(ID_B, 'Live And Let Die - 2018 Remaster', ['Wings'], 'Wings Greatest')] } });
      return send(200, { tracks: { items: [t('D'.repeat(22), 'Iets Anders', ['Niemand Anders'], 'x')] } });
    }
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, port: server.address().port })));
}

function runTool(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('link-spotify: zonder sleutels een duidelijke melding', async () => {
  const r = await runTool(['--dry-run'], { SPOTIFY_CLIENT_ID: '', SPOTIFY_CLIENT_SECRET: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /SPOTIFY_CLIENT_ID/);
});

test('link-spotify: dry-run, 429, twijfelgevallen en schrijven', async () => {
  const fake = await fakeSpotify();
  const dir = mkdtempSync(join(tmpdir(), 'tt-link-'));
  const deckPath = join(dir, 'deck.json');
  const reportPath = join(dir, 'report.json');
  writeFileSync(deckPath, `${JSON.stringify(deck, null, 2)}\n`);
  const env = {
    SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'secret',
    SPOTIFY_API_BASE: `http://127.0.0.1:${fake.port}/v1`, SPOTIFY_ACCOUNTS_BASE: `http://127.0.0.1:${fake.port}`,
  };
  try {
    const dry = await runTool(['--dry-run', '--deck', deckPath, '--delay', '0', '--report', reportPath], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stderr, /429/);
    assert.equal(readFileSync(deckPath, 'utf8'), `${JSON.stringify(deck, null, 2)}\n`, 'dry-run leaves deck.json alone');
    assert.match(dry.stdout, /Zeker: 1 {2}Twijfel: 1 {2}Geen match: 1 {2}Al gekoppeld: 1/);
    assert.match(dry.stdout, /002 {2}Paul McCartney & Wings - Live and Let Die/);
    assert.match(dry.stdout, /003 {2}Niemand - Onbekend Liedje .*niets gevonden/);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.cards.find((c) => c.id === '001').spotify.id, ID_A, 'studio version beats the live one');
    assert.ok(fake.log.some((l) => l.includes('market=NL')));

    const real = await runTool(['--deck', deckPath, '--delay', '0', '--sure-only'], env);
    assert.equal(real.code, 0, real.stderr);
    const out = JSON.parse(readFileSync(deckPath, 'utf8'));
    assert.deepEqual(Object.keys(out.cards[0]), ['id', 'title', 'artist', 'year', 'itunesId', 'spotifyId', 'previewUrl']);
    assert.equal(out.cards[0].spotifyId, ID_A);
    assert.equal(out.cards[1].spotifyId, undefined, '--sure-only skips the doubtful match');
    assert.equal(out.cards[2].spotifyId, undefined);
    assert.equal(out.cards[3].spotifyId, 'C'.repeat(22), 'existing ids are kept');

    const all = await runTool(['--deck', deckPath, '--delay', '0'], env);
    assert.equal(all.code, 0, all.stderr);
    assert.equal(JSON.parse(readFileSync(deckPath, 'utf8')).cards[1].spotifyId, ID_B);
  } finally {
    fake.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
