// Spotify: settings, PKCE login, remote playback and every fallback, against a fake Spotify.
// All traffic to accounts.spotify.com / api.spotify.com is answered by context.route; the
// iTunes previews are faked too (silent WAV), so this suite needs no network at all.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { launch, phoneContext, startServer, assert, shot, OUT, FIXTURE_DECK } from './helpers.mjs';

export const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const ID_DQ = '0DancingQueenStudio000';
const ID_DQ_KARAOKE = '0DancingQueenKaraoke00';
const ID_DECK = '4uLU6hMCjMI75M1A2tKUQC';
const SECRET = ['Dancing Queen', 'ABBA', 'Arrival', 'SECRET TRACK NAME', 'SECRET ARTIST'];

// The fixture deck, with a fixed spotifyId on card 004.
const deck = JSON.parse(FIXTURE_DECK);
deck.cards.find((c) => c.id === '004').spotifyId = ID_DECK;
export const DECK_JSON = JSON.stringify(deck);

function silentWav(seconds = 30) {
  const samples = 8000 * seconds;
  const b = Buffer.alloc(44 + samples, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(samples, 40);
  return b;
}
export const WAV = silentWav();

/**
 * Fake Spotify with a running playback position. Like the real one: an unknown Client ID or a
 * Redirect URI that is not registered gives Spotify's own error page ("INVALID_CLIENT: …")
 * and does NOT go back to the app.
 */
export function fakeSpotify(base, { clientId = CLIENT_ID } = {}) {
  const m = {
    devices: [{ id: 'dev-phone', name: 'Pixel van Anna', type: 'Smartphone', is_active: true, is_restricted: false, volume_percent: 80 }],
    premium: true, notAllowed: false, tamperState: false,
    clientIds: [clientId], redirects: [base], // what is registered in the dashboard
    deny: false, // the user taps "Cancel"
    ownerNoPremium: false, // the owner of the Spotify app has no Premium (403 on every call)
    product: 'premium', tokenStatus: null, // e.g. 503: the token endpoint is down
    name: 'Anna Test',
    access: null, refresh: null, tokenN: 0, challenge: null,
    playing: null, // { uri, device, pos (ms), since, isPlaying }
    calls: [], searches: [],
  };
  const progress = () => (m.playing ? m.playing.pos + (m.playing.isPlaying ? Date.now() - m.playing.since : 0) : 0);
  const json = (route, status, body, headers = {}) => route.fulfill({
    status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: body == null ? '' : JSON.stringify(body),
  });
  const err = (route, status, message, reason) => json(route, status, { error: { status, message, ...(reason ? { reason } : {}) } });
  const newTokens = () => { m.tokenN++; m.access = `at-${m.tokenN}`; m.refresh = `rt-${m.tokenN}`; return { access_token: m.access, token_type: 'Bearer', scope: 'user-read-playback-state user-modify-playback-state', expires_in: 3600, refresh_token: m.refresh }; };
  const track = (id, name, artist, album) => ({ id, uri: `spotify:track:${id}`, name, duration_ms: 215000, artists: [{ name: artist }], album: { name: album } });

  async function install(ctx) {
    await ctx.route('https://accounts.spotify.com/authorize?**', (route) => {
      const u = new URL(route.request().url());
      m.calls.push({ what: 'authorize', params: Object.fromEntries(u.searchParams) });
      m.challenge = u.searchParams.get('code_challenge');
      const errorPage = (what) => route.fulfill({ status: 400, contentType: 'text/html', body: `<!doctype html><title>Error</title><body style="font:16px sans-serif;padding:24px"><h1>Oops! Something went wrong</h1><p data-testid="fake-spotify-error">INVALID_CLIENT: ${what}</p></body>` });
      if (!m.clientIds.includes(u.searchParams.get('client_id'))) return errorPage('Invalid client');
      if (!m.redirects.includes(u.searchParams.get('redirect_uri'))) return errorPage('Invalid redirect URI');
      const ok = u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('response_type') === 'code'
        && u.searchParams.get('scope') === 'user-read-playback-state user-modify-playback-state';
      const state = m.tamperState ? 'someone-else' : u.searchParams.get('state');
      const redirect = u.searchParams.get('redirect_uri');
      const target = m.deny ? `${redirect}?error=access_denied&state=${encodeURIComponent(state)}`
        : ok ? `${redirect}?code=CODE-${m.calls.length}&state=${encodeURIComponent(state)}` : `${redirect}?error=invalid_scope&state=${state}`;
      route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Spotify</title><p>Spotify (nep)</p><script>location.replace(${JSON.stringify(target)})</script>` });
    });
    await ctx.route('https://accounts.spotify.com/api/token', async (route) => {
      const req = route.request();
      const p = Object.fromEntries(new URLSearchParams(req.postData() || ''));
      m.calls.push({ what: 'token', params: p });
      if (m.tokenStatus) return json(route, m.tokenStatus, { error: 'server_error', error_description: 'Service unavailable' });
      if (p.grant_type === 'authorization_code') {
        const expect = createHash('sha256').update(p.code_verifier || '').digest('base64url');
        if (expect !== m.challenge || !m.clientIds.includes(p.client_id) || !m.redirects.includes(p.redirect_uri) || !/^CODE-/.test(p.code)) {
          return json(route, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        }
        return json(route, 200, newTokens());
      }
      if (p.grant_type === 'refresh_token') {
        if (p.refresh_token !== m.refresh || !m.clientIds.includes(p.client_id)) return json(route, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
        const t = newTokens();
        delete t.refresh_token; // Spotify may omit it: the old one must stay usable
        m.refresh = `rt-${m.tokenN - 1}`;
        return json(route, 200, t);
      }
      return json(route, 400, { error: 'unsupported_grant_type' });
    });
    await ctx.route('https://api.spotify.com/v1/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const path = u.pathname.replace('/v1', '');
      const method = req.method();
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,PUT,POST' } });
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      const call = { what: `${method} ${path}`, query: Object.fromEntries(u.searchParams), body, auth: req.headers().authorization };
      m.calls.push(call);
      if (req.headers().authorization !== `Bearer ${m.access}`) return err(route, 401, 'The access token expired');
      if (m.ownerNoPremium) return err(route, 403, 'Active premium subscription required for the owner of the app.');
      if (m.notAllowed) return err(route, 403, 'Check settings on developer.spotify.com/dashboard, the user may not be registered.');
      if (path === '/me') return json(route, 200, { id: 'anna', display_name: m.name, product: m.product });
      if (path === '/search') {
        const q = u.searchParams.get('q');
        m.searches.push({ q, limit: u.searchParams.get('limit'), market: u.searchParams.get('market'), type: u.searchParams.get('type') });
        let items = [];
        if (/Dancing Queen/i.test(q)) items = [track(ID_DQ_KARAOKE, 'Dancing Queen (Karaoke Version)', 'Karaoke Hits Band', 'Karaoke Classics'), track(ID_DQ, 'Dancing Queen', 'ABBA', 'Arrival')];
        else if (/Für Elise/.test(q)) items = [track('0FurEliseTestTrack0000', 'Für Elise', 'Ludwig van Beethoven', 'Piano')];
        else {
          const mm = q.match(/Testnummer (\d+)/);
          if (mm && mm[1] !== '3') items = [track(`0Testnummer${mm[1].padStart(2, '0')}xxxxxxxxx`.slice(0, 22), `Testnummer ${mm[1]}`, `Testartiest ${mm[1]}`, 'Album')];
        }
        return json(route, 200, { tracks: { href: '', items, limit: 10, offset: 0, total: items.length } });
      }
      if (path.startsWith('/tracks/')) return json(route, 200, track(path.split('/')[2], 'SECRET TRACK NAME', 'SECRET ARTIST', 'x'));
      if (path === '/me/player/devices') return json(route, 200, { devices: m.devices });
      if (path === '/me/player' && method === 'PUT') {
        const d = m.devices.find((x) => x.id === body?.device_ids?.[0]);
        if (!d) return err(route, 404, 'Device not found');
        m.devices.forEach((x) => { x.is_active = x === d; });
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (path === '/me/player/play') {
        if (!m.premium) return err(route, 403, 'Player command failed: Premium required', 'PREMIUM_REQUIRED');
        const id = u.searchParams.get('device_id');
        const d = id ? m.devices.find((x) => x.id === id) : m.devices.find((x) => x.is_active);
        if (!d) return err(route, 404, id ? 'Device not found' : 'Player command failed: No active device found', id ? undefined : 'NO_ACTIVE_DEVICE');
        m.devices.forEach((x) => { x.is_active = x === d; });
        m.playing = { uri: body.uris[0], device: d.id, pos: body.position_ms || 0, since: Date.now(), isPlaying: true };
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (path === '/me/player/pause') {
        if (m.playing) { m.playing.pos = progress(); m.playing.isPlaying = false; }
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (path === '/me/player/seek') {
        if (m.playing) { m.playing.pos = Number(u.searchParams.get('position_ms')); m.playing.since = Date.now(); }
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      if (path === '/me/player' && method === 'GET') {
        if (!m.playing) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
        return json(route, 200, {
          is_playing: m.playing.isPlaying, progress_ms: progress(),
          device: m.devices.find((x) => x.id === m.playing.device) || null,
          item: { ...track(m.playing.uri.split(':')[2], 'SECRET TRACK NAME', 'SECRET ARTIST', 'SECRET ALBUM'), uri: m.playing.uri },
        });
      }
      return err(route, 404, 'Service not found');
    });
  }
  const last = (what) => [...m.calls].reverse().find((c) => c.what === what);
  const count = (what) => m.calls.filter((c) => c.what === what).length;
  return { m, install, last, count };
}

// Settings screens are long: capture the whole page.
async function fullShot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: 'disabled' });
}

/** The short way through the setup help with a Client ID you already have, up to "Verbind en test". */
export async function enterClientId(page, id = CLIENT_ID) {
  await page.getByTestId('wiz-have-id').click();
  await page.getByTestId('spotify-client-id').fill(id);
  await page.getByTestId('spotify-client-save').click();
  await page.getByTestId('wiz-skip').click();
  await page.locator('[data-testid="spotify-block"][data-view="wizard-connect"]').waitFor();
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout waiting for the fake Spotify');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export default async function run() {
  const port = 8200 + Math.floor(Math.random() * 90);
  const server = await startServer(port);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const fake = fakeSpotify(base);
  try {
    const ctx = await phoneContext(browser);
    await ctx.route('**/data/deck.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: DECK_JSON }));
    await ctx.route('https://itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"resultCount":0,"results":[]}' }));
    await ctx.route('https://audio-ssl.itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
    await fake.install(ctx);
    const page = await ctx.newPage();
    await page.clock.install();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const toastText = () => page.getByTestId('toast').textContent();
    const pstate = () => page.evaluate(() => ({ ...window.__tt.player.state }));
    const domText = () => page.evaluate(() => document.documentElement.textContent);
    const noSecrets = async (label) => {
      const t = await domText();
      for (const s of SECRET) assert(!t.includes(s), `${label}: "${s}" not in the DOM`);
    };

    // --- settings, empty ---
    await page.goto(`${base}#/instellingen`);
    await page.getByTestId('screen-settings').waitFor();
    assert(await page.getByTestId('source-preview').isChecked(), 'preview is the default source');
    assert(await page.locator('[data-testid="spotify-block"][data-view="wizard-intro"]').count() === 1, 'without Client ID: the setup help starts with its intro');
    assert(await page.getByTestId('spotify-connect').count() === 0, 'no connect button without Client ID');
    await fullShot(page, '60-settings-no-client');

    // the full setup help has its own suite (spotify-setup); here the short way with a known Client ID
    await page.getByTestId('wiz-have-id').click();
    await page.getByTestId('spotify-client-id').fill('abc');
    assert(await page.getByTestId('spotify-client-save').isDisabled(), 'save disabled while the Client ID is not complete');
    await page.getByTestId('spotify-client-id').press('Enter');
    await page.waitForFunction(() => /precies 32/.test(document.querySelector('[data-testid="client-msg"]')?.textContent || ''));
    assert(true, 'invalid Client ID is refused with a clear message');
    await page.getByTestId('spotify-client-id').fill(CLIENT_ID);
    await page.getByTestId('spotify-client-save').click();
    await page.getByTestId('wiz-skip').click();
    await page.getByTestId('spotify-connect').waitFor();
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.spotify.clientId.v1'))) === CLIENT_ID, 'Client ID saved in localStorage');
    await fullShot(page, '62-settings-ready');

    // --- state check: a tampered redirect is refused ---
    fake.m.tamperState = true;
    await page.getByTestId('spotify-connect').click();
    await page.getByTestId('spotify-error').waitFor();
    assert(await page.getByTestId('spotify-error').getAttribute('data-code') === 'state' && /klopte niet/.test(await page.getByTestId('spotify-error').textContent()), 'wrong state -> refused with a message');
    assert(page.url() === `${base}#/instellingen`, `URL cleaned after refused redirect (${page.url()})`);
    assert(fake.count('token') === 0, 'no token request with a wrong state');
    fake.m.tamperState = false;

    // --- connect ---
    await page.getByTestId('spotify-connect').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="spotify-pill"]')?.textContent === 'Verbonden');
    assert(page.url() === `${base}#/instellingen`, `back on the settings screen with a clean URL (${page.url()})`);
    const auth = fake.last('authorize').params;
    assert(auth.code_challenge.length === 43 && auth.state.length >= 16, 'authorize got S256 challenge and state');
    assert(fake.last('token').params.grant_type === 'authorization_code', 'code exchanged with verifier (checked by the fake)');
    await page.locator('[data-testid="wiz-check-device"][data-ok="true"]').waitFor();
    assert(/Anna Test/.test(await page.getByTestId('wiz-check-account').textContent()), 'account name shown');
    assert(/Pixel van Anna/.test(await page.getByTestId('wiz-check-device').textContent()), 'active device chosen automatically');
    await fullShot(page, '63-settings-connected');

    // test sound
    await page.getByTestId('spotify-test').click();
    await page.waitForFunction(() => /seconden pianomuziek op Pixel van Anna/.test(document.querySelector('[data-testid="spotify-test-msg"]')?.textContent || ''));
    assert(fake.m.playing.uri === 'spotify:track:0FurEliseTestTrack0000', 'test sound plays a non-deck track');
    await page.clock.fastForward(9000);
    await page.waitForFunction(() => /Test klaar/.test(document.querySelector('[data-testid="spotify-test-msg"]')?.textContent || ''));
    assert(!fake.m.playing.isPlaying, 'test sound paused after a few seconds');
    await page.getByTestId('wiz-finish').click();
    await page.getByTestId('wiz-done').waitFor();
    assert(await page.getByTestId('source-spotify').isChecked(), '"Klaar": Spotify is the music source');
    await page.getByTestId('wiz-close').click();
    await page.getByTestId('spotify-status').waitFor();
    assert(await page.getByTestId('limit-60').isChecked(), 'overview: default playing time is 60 s');
    assert(/Anna Test/.test(await page.getByTestId('spotify-status').textContent()) && /Pixel van Anna/.test(await page.getByTestId('spotify-status').textContent()), 'overview: account and device');
    await page.getByTestId('device-list').waitFor();

    // --- play a card via Spotify ---
    await page.goto(`${base}#/c/001`);
    await page.getByTestId('screen-card').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    const play1 = fake.last('PUT /me/player/play');
    assert(play1.body.uris[0] === `spotify:track:${ID_DQ}`, `plays the studio version, not karaoke (${play1.body.uris[0]})`);
    assert(play1.query.device_id === 'dev-phone' && play1.body.position_ms === 0, 'on the chosen device from 0 ms');
    const s1 = fake.m.searches.find((s) => /Dancing Queen/.test(s.q));
    assert(s1.q === 'track:"Dancing Queen" artist:"ABBA"' && s1.limit === '10' && s1.type === 'track' && s1.market === 'NL', `search query ${s1.q}`);
    assert(/Via Spotify op Pixel van Anna/.test(await page.getByTestId('player-source').textContent()), 'player says it plays via Spotify');
    assert(await page.locator('.pv-dur').textContent() === '1:00', 'progress bar runs to 1:00');
    await page.clock.fastForward(4000);
    await page.waitForFunction(() => document.querySelector('.pv-cur').textContent !== '0:00');
    await noSecrets('card screen');
    await shot(page, '64-card-spotify-playing');

    await page.getByTestId('play-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'paused');
    assert(fake.count('PUT /me/player/pause') >= 2 && !fake.m.playing.isPlaying, 'pause pauses Spotify');
    const pausedAt = (await pstate()).currentTime;
    await page.getByTestId('play-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    const resume = fake.last('PUT /me/player/play');
    assert(Math.abs(resume.body.position_ms - pausedAt * 1000) < 600 && resume.body.position_ms > 0, `resume continues at ${resume.body.position_ms} ms`);
    await page.getByTestId('restart').click();
    await page.waitForFunction(() => window.__tt.player.state.currentTime < 1);
    assert(fake.last('PUT /me/player/seek').query.position_ms === '0', 'restart seeks to 0');

    // stops after the chosen duration
    const pausesBefore = fake.count('PUT /me/player/pause');
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'ended');
    await until(() => fake.count('PUT /me/player/pause') > pausesBefore);
    assert(fake.count('PUT /me/player/pause') > pausesBefore, 'Spotify paused after 60 s');
    assert(await page.locator('.pv-cur').textContent() === '1:00', 'progress full at 1:00');

    // leaving the screen pauses Spotify
    await page.getByTestId('play-toggle').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    assert(fake.last('PUT /me/player/play').body.position_ms === 0, 'play after "ended" starts from 0');
    const before = fake.count('PUT /me/player/pause');
    await page.getByTestId('back-home').click();
    await page.getByTestId('screen-start').waitFor();
    await page.waitForTimeout(300);
    assert(fake.count('PUT /me/player/pause') > before && !fake.m.playing.isPlaying, 'leaving the card screen pauses Spotify');

    // fixed spotifyId in the deck: no search
    const searches = fake.m.searches.length;
    await page.goto(`${base}#/c/004`);
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    assert(fake.last('PUT /me/player/play').body.uris[0] === `spotify:track:${ID_DECK}` && fake.m.searches.length === searches, 'spotifyId from deck.json used directly');
    // cached match: card 001 again needs no search
    await page.goto(`${base}#/c/001`);
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    assert(fake.m.searches.length === searches, 'match cached per card in localStorage');

    // --- expired token: 401 -> refresh -> retry ---
    fake.m.access = 'expired-elsewhere';
    const tokenCalls = fake.count('token');
    await page.goto(`${base}#/c/002`);
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    const refreshCall = fake.last('token');
    assert(fake.count('token') === tokenCalls + 1 && refreshCall.params.grant_type === 'refresh_token', 'refreshed the token after a 401');
    assert(fake.last('PUT /me/player/play').auth === `Bearer ${fake.m.access}`, 'retried with the new token');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.spotify.token.v1')));
    assert(stored.refresh_token === fake.m.refresh && stored.access_token === fake.m.access, 'kept the refresh token when Spotify did not send a new one');

    // --- no device: explanation, pick a device, plays ---
    fake.m.devices = [];
    await page.goto(`${base}#/c/005`);
    await page.getByTestId('device-sheet').waitFor();
    assert(/Open de Spotify-app op dit toestel, start even een nummer en kom terug/.test(await page.getByTestId('device-sheet').textContent()), 'no device -> explanation');
    assert(await page.getByTestId('player').getAttribute('data-status') === 'blocked', 'player waits (blocked)');
    await shot(page, '65-card-no-device');
    fake.m.devices = [{ id: 'dev-speaker', name: 'Keukenspeaker', type: 'Speaker', is_active: false, is_restricted: false }];
    await page.getByTestId('device-refresh').click();
    await page.getByTestId('device-option').waitFor();
    await shot(page, '66-card-device-picker');
    await page.getByTestId('device-option').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="player"]').dataset.status === 'playing');
    assert(fake.last('PUT /me/player/play').query.device_id === 'dev-speaker' && fake.m.playing.isPlaying, 'plays on the picked device');
    assert(await page.getByTestId('device-sheet').count() === 0, 'sheet closed');
    assert(/Keukenspeaker/.test(await page.getByTestId('player-source').textContent()), 'player shows the new device');

    // --- no match: preview ---
    await page.goto(`${base}#/c/003`);
    await page.waitForFunction(() => window.__tt.player.state.source !== 'spotify' && window.__tt.player.state.status === 'playing');
    assert(/niet gevonden op Spotify/.test(await toastText()), 'no match -> short message');
    assert(await page.evaluate(() => !document.querySelector('audio').paused), 'preview audio plays');
    assert(await page.getByTestId('player-source').isHidden(), 'no Spotify label for the preview');
    await shot(page, '67-card-no-match');

    // --- digital game also works with Spotify ---
    await page.goto(`${base}#/spel`);
    await page.getByTestId('setup-form').waitFor();
    await page.getByTestId('player-name-0').fill('A');
    await page.getByTestId('player-name-1').fill('B');
    await page.getByTestId('start-game').click();
    await page.getByTestId('start-turn').click();
    await page.locator('[data-view="place"]').waitFor();
    await page.waitForFunction(() => window.__tt.player.state.status === 'playing');
    const gs = await pstate();
    assert(gs.source === 'spotify' || gs.cardId === '003', `digital game plays via Spotify (card ${gs.cardId}, ${gs.source})`);
    // Start cards lie face up: when card 001 (Dancing Queen) is one of them its title is
    // legitimately on screen, so then only check what Spotify itself returned.
    const dealt = (await page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.game.v1')))).players.flatMap((p) => p.timeline);
    if (dealt.includes('001')) {
      const t = await domText();
      for (const s of SECRET.slice(2)) assert(!t.includes(s), `digital game: "${s}" not in the DOM`);
    } else await noSecrets('digital game');
    await page.getByTestId('back-home').click();
    await page.getByTestId('screen-start').waitFor();

    // --- no Premium: message + preview ---
    fake.m.premium = false;
    await page.goto(`${base}#/c/006`);
    await page.waitForFunction(() => window.__tt.player.state.source !== 'spotify' && window.__tt.player.state.status === 'playing');
    assert(/Premium/.test(await toastText()) && /fragment van 30 seconden/.test(await toastText()), 'no Premium -> message + preview');
    await shot(page, '68-card-no-premium');
    fake.m.premium = true;

    // --- disconnect ---
    await page.goto(`${base}#/instellingen`);
    await page.getByTestId('spotify-disconnect').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="spotify-pill"]').textContent === 'Niet verbonden');
    assert(await page.evaluate(() => localStorage.getItem('timetunesr.spotify.token.v1')) === null, 'tokens removed');
    assert(await page.getByTestId('source-note').isVisible(), 'note: Spotify chosen but not connected');
    await fullShot(page, '69-settings-disconnected');
    await page.goto(`${base}#/c/001`);
    await page.waitForFunction(() => window.__tt.player.state.source !== 'spotify' && window.__tt.player.state.status === 'playing');
    assert(/niet verbonden/.test(await toastText()), 'disconnected -> preview with message');

    // --- account not on the User Management list ---
    await page.goto(`${base}#/instellingen`);
    fake.m.notAllowed = true;
    await page.getByTestId('spotify-connect').click();
    await page.getByTestId('spotify-error').waitFor();
    assert(await page.getByTestId('spotify-error').getAttribute('data-code') === 'not-allowed' && /User Management/.test(await page.getByTestId('spotify-error').textContent()), 'not allowed in dashboard -> clear message');
    assert(await page.getByTestId('spotify-pill').textContent() === 'Niet verbonden', 'not connected after 403');
    await fullShot(page, '70-settings-not-allowed');
    fake.m.notAllowed = false;
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await ctx.close();

    // --- localhost is not accepted by Spotify ---
    const ctx2 = await phoneContext(browser);
    const p2 = await ctx2.newPage();
    await p2.goto(`http://localhost:${port}/#/instellingen`);
    await p2.getByTestId('screen-settings').waitFor();
    assert(await p2.getByTestId('spotify-env-warning').isVisible(), 'localhost: warned already before the setup starts');
    await enterClientId(p2);
    assert(await p2.getByTestId('spotify-env-warning').isVisible() && await p2.getByTestId('spotify-connect').count() === 0, 'localhost: explanation instead of a connect button');
    assert(/127\.0\.0\.1/.test(await p2.getByTestId('spotify-env-warning').textContent()), 'localhost: points to 127.0.0.1');
    await fullShot(p2, '71-settings-localhost');
    await ctx2.close();

    // --- with an active service worker the login return still works ---
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await ctx3.route('**/data/deck.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: DECK_JSON }));
    await fake.install(ctx3);
    const p3 = await ctx3.newPage();
    await p3.goto(`${base}#/instellingen`);
    await p3.evaluate(() => navigator.serviceWorker.ready);
    await p3.reload();
    await p3.waitForFunction(() => !!navigator.serviceWorker.controller);
    await enterClientId(p3);
    await p3.getByTestId('spotify-connect').click();
    await p3.waitForFunction(() => document.querySelector('[data-testid="spotify-pill"]')?.textContent === 'Verbonden', null, { timeout: 15000 });
    assert(p3.url() === `${base}#/instellingen`, 'login return works with an active service worker');
    const spotifyCached = await p3.evaluate(async () => {
      const hits = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (/spotify\.com|code=/.test(r.url)) hits.push(r.url);
      return hits;
    });
    assert(spotifyCached.length === 0, 'nothing from Spotify (or the ?code= URL) in the cache');
    await ctx3.close();
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
