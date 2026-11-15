// "Mijn meest geluisterd" on one phone: an own playlist from the player's Spotify top songs
// (GET /me/top/tracks, scope user-top-read), against a fake Spotify and a fake iTunes for
// the fragment + year in the background. Covers: giving permission once more (back on the
// same screen, then filled right away), the three periods, a song without an Apple Music
// match, Spotify's remaster year corrected through Apple Music, the quick start on the
// playlists screen, and no Client ID.
import { launch, phoneContext, startServer, useFixtureDeck, assert, OUT } from './helpers.mjs';
import { join } from 'node:path';
import { installFakeItunes, byTitle } from './fake-itunes.mjs';

/** Whole-page screenshot (new screens are reviewed in full, at 390 px). */
async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const PLAYBACK = 'user-read-playback-state user-modify-playback-state';
const TOP = 'user-top-read';

const trk = (id, name, artist, album, date) => ({ type: 'track', id: id.padEnd(22, 'x'), name, artists: [{ name: artist }], album: { name: album, release_date: date }, external_ids: { isrc: 'NL0000000000' }, is_local: false });
export const TOP_TRACKS = {
  medium_term: [
    trk('0TotoAfrica', 'Africa', 'Toto', 'Toto IV', '1982-04-08'),
    trk('0NirvanaTeen', 'Smells Like Teen Spirit - Remastered 2021', 'Nirvana', 'Nevermind (Remastered)', '2011-09-23'),
    trk('0OnlyOnSpotify', 'Alleen Op Spotify', 'Testband', 'Demo', '2019'),
    trk('0EarthSeptember', 'September', 'Earth, Wind & Fire', 'The Best Of Earth, Wind & Fire Vol. 1', '1978-11-23'),
    trk('0BillieJean', 'Billie Jean', 'Michael Jackson', 'Thriller 25 Super Deluxe Edition', '2008-02-08'),
  ],
  short_term: [
    trk('0DuaLevitating', 'Levitating', 'Dua Lipa', 'Future Nostalgia', '2020-03-27'),
    trk('0AdeleRolling', 'Rolling in the Deep', 'Adele', '21', '2011-01-24'),
    trk('0TotoAfrica', 'Africa', 'Toto', 'Toto IV', '1982-04-08'),
  ],
  long_term: [
    trk('0AbbaDancing', 'Dancing Queen', 'ABBA', 'ABBA Gold: Greatest Hits', '1992-09-21'),
    trk('0QueenBohemian', 'Bohemian Rhapsody', 'Queen', 'A Night At The Opera (2011 Remaster)', '1975-11-21'),
  ],
};

async function fakeSpotify(ctx, base) {
  const m = { calls: [], scope: PLAYBACK, access: 'at-1' };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await ctx.route('https://accounts.spotify.com/authorize?**', (route) => {
    const u = new URL(route.request().url());
    m.calls.push({ what: 'authorize', scope: u.searchParams.get('scope'), redirect: u.searchParams.get('redirect_uri') });
    const target = `${base}?code=CODE-1&state=${encodeURIComponent(u.searchParams.get('state'))}`;
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><p>Spotify (nep)</p><script>location.replace(${JSON.stringify(target)})</script>` });
  });
  await ctx.route('https://accounts.spotify.com/api/token', (route) => {
    m.scope = m.calls.filter((c) => c.what === 'authorize').at(-1)?.scope || PLAYBACK;
    m.access = 'at-2';
    return json(route, 200, { access_token: m.access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', scope: m.scope });
  });
  await ctx.route('https://api.spotify.com/v1/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' } });
    const u = new URL(req.url());
    const path = u.pathname.replace('/v1', '');
    m.calls.push({ what: `${req.method()} ${path}`, query: Object.fromEntries(u.searchParams) });
    if (req.headers().authorization !== `Bearer ${m.access}`) return json(route, 401, { error: { status: 401, message: 'The access token expired' } });
    if (path === '/me') return json(route, 200, { id: 'anna', display_name: 'Anna Test', product: 'premium' });
    if (path === '/me/top/tracks') {
      if (!m.scope.includes(TOP)) return json(route, 403, { error: { status: 403, message: 'Insufficient client scope' } });
      const items = (TOP_TRACKS[u.searchParams.get('time_range')] || []).slice(0, Number(u.searchParams.get('limit')) || 20);
      return json(route, 200, { items, total: items.length, limit: items.length, offset: 0, next: null, href: u.href, previous: null });
    }
    return json(route, 404, { error: { status: 404, message: 'Service not found' } });
  });
  return m;
}

const lists = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists);

export default async function run() {
  const port = 8300 + Math.floor(Math.random() * 90);
  const server = await startServer(port);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  try {
    const ctx = await phoneContext(browser);
    await useFixtureDeck(ctx);
    const itunes = await installFakeItunes(ctx);
    const sp = await fakeSpotify(ctx, base);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());

    await page.goto(base);
    await page.evaluate(([cid, scope]) => {
      localStorage.setItem('timetunesr.itunesGap.v1', '30');
      localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid));
      localStorage.setItem('timetunesr.spotify.token.v1', JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_at: Date.now() + 3600e3, scope, clientId: cid }));
    }, [CLIENT_ID, PLAYBACK]);
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('playlist-new-name').fill('Mijn top');
    await page.getByTestId('playlist-create').click();
    await page.getByTestId('screen-playlist').waitFor();
    const plId = await page.getByTestId('screen-playlist').getAttribute('data-id');

    // the Spotify tab still opens on "take over a playlist" (unchanged), "Mijn meest geluisterd" next to it
    await page.getByTestId('pl-tab-spotify').click();
    await page.getByTestId('pl-spotify-scope').waitFor();
    assert(await page.getByTestId('pl-sp-mode-playlist').getAttribute('aria-pressed') === 'true', 'Spotify tab: playlist mode first, as before');
    await page.getByTestId('pl-sp-mode-top').click();
    await page.getByTestId('pl-top-scope').waitFor();
    assert(/heruitgave/.test(await page.getByTestId('pl-top-note').textContent()), 'the note explains re-release years and the Apple Music check');
    await shot(page, 'pl-top-01-scope');

    // permission once more: back on the same screen and tab, filled right away
    await page.getByTestId('pl-top-connect').click();
    await page.waitForURL(`${base}#/playlists/${plId}`);
    const auth = sp.calls.find((c) => c.what === 'authorize');
    assert(auth.scope === `${PLAYBACK} ${TOP}` && auth.redirect === base, `re-connect asks for user-top-read (${auth.scope})`);
    await page.getByTestId('pl-top-status').waitFor();
    await page.waitForFunction(() => /toegevoegd/.test(document.querySelector('[data-testid="pl-top-status"]')?.textContent || ''));
    assert(await page.getByTestId('pl-sp-mode-top').getAttribute('aria-pressed') === 'true', 'back on "Mijn meest geluisterd"');
    let call = sp.calls.find((c) => c.what === 'GET /me/top/tracks');
    assert(call.query.time_range === 'medium_term' && call.query.limit === '30', `default: last half year, 30 songs (${JSON.stringify(call.query)})`);
    await page.waitForFunction(() => !document.querySelector('[data-testid="pl-match-status"]'), null, { timeout: 20000 });
    let pl = (await lists(page)).find((p) => p.id === plId);
    const t = (title) => pl.tracks.find((x) => x.title.startsWith(title));
    assert(pl.tracks.length === 5, `5 top songs in the playlist (${pl.tracks.map((x) => x.title).join(', ')})`);
    assert(t('Africa').itunesId === byTitle('Africa').trackId && t('Africa').spotifyId.startsWith('0TotoAfrica') && t('Africa').year === 1982, 'Toto: spotifyId + Apple Music fragment, 1982');
    assert(t('Smells Like').title === 'Smells Like Teen Spirit' && t('Smells Like').year === 1991, `Nirvana: Spotify's remaster (2011) corrected to ${t('Smells Like').year} via Apple Music`);
    assert(t('Billie Jean').year === 1982, `Billie Jean: deluxe edition 2008 -> ${t('Billie Jean').year}`);
    assert(!t('Alleen Op Spotify').itunesId && t('Alleen Op Spotify').year === 2019 && t('Alleen Op Spotify').yearSure === false, 'song without an Apple Music match: Spotify year, "controleer het jaar", only via Spotify');
    await page.locator('[data-testid="pl-spotify-only"]').waitFor();
    assert(itunes.search.length >= 5, `background iTunes searches (${itunes.search.length})`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'pl-top-02-filled');

    // the other periods and numbers
    await page.getByTestId('pl-top-range').selectOption('short_term');
    await page.getByTestId('pl-top-count').selectOption('20');
    await page.getByTestId('pl-top-import').click();
    await page.waitForFunction(() => /laatste weken\) toegevoegd/.test(document.querySelector('[data-testid="pl-top-status"]')?.textContent || ''));
    call = sp.calls.filter((c) => c.what === 'GET /me/top/tracks').at(-1);
    assert(call.query.time_range === 'short_term' && call.query.limit === '20', 'last weeks, 20 songs');
    assert(/2 nummers .*\(1 stonden er al in\)/.test(await page.getByTestId('pl-top-status').textContent()), 'Africa was already there: counted, not added twice');
    await page.getByTestId('pl-top-range').selectOption('long_term');
    await page.getByTestId('pl-top-import').click();
    await page.waitForFunction(() => /langste tijd\) toegevoegd/.test(document.querySelector('[data-testid="pl-top-status"]')?.textContent || ''));
    assert(sp.calls.filter((c) => c.what === 'GET /me/top/tracks').at(-1).query.time_range === 'long_term', 'longest time');
    await page.waitForFunction(() => !document.querySelector('[data-testid="pl-match-status"]'), null, { timeout: 20000 });
    pl = (await lists(page)).find((p) => p.id === plId);
    assert(pl.tracks.length === 9, `9 songs after three periods (${pl.tracks.length})`);
    assert(t('Dancing Queen').year === 1976 && t('Dancing Queen').yearSure === true, 'Dancing Queen: compilation 1992 on Spotify -> 1976 (Arrival), sure');
    await shot(page, 'pl-top-03-periods');

    // quick start on the playlists screen: one tap, a new playlist filled (permission is there now)
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('playlist-top-create').waitFor();
    await shot(page, 'pl-top-04-quick');
    await page.getByTestId('playlist-top-create').click();
    await page.getByTestId('screen-playlist').waitFor();
    const quickId = await page.getByTestId('screen-playlist').getAttribute('data-id');
    assert(quickId !== plId && (await page.getByTestId('pl-name').textContent()) === 'Mijn meest geluisterd', 'quick start: new playlist "Mijn meest geluisterd"');
    await page.waitForFunction(() => /toegevoegd/.test(document.querySelector('[data-testid="pl-top-status"]')?.textContent || ''));
    await page.waitForFunction(() => !document.querySelector('[data-testid="pl-match-status"]'), null, { timeout: 20000 });
    assert((await lists(page)).find((p) => p.id === quickId).tracks.length === 5, 'quick start: filled with the 5 top songs');

    // a phone that never connected: the quick start goes through the Spotify login and back
    await page.evaluate(() => { localStorage.removeItem('timetunesr.spotify.token.v1'); localStorage.removeItem('timetunesr.spotify.topScopes.v1'); });
    const before = sp.calls.filter((c) => c.what === 'authorize').length;
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('playlist-top-create').click();
    await page.waitForFunction(() => /^#\/playlists\/p/.test(location.hash) && /toegevoegd/.test(document.querySelector('[data-testid="pl-top-status"]')?.textContent || ''), null, { timeout: 20000 });
    assert(sp.calls.filter((c) => c.what === 'authorize').length === before + 1 && sp.calls.filter((c) => c.what === 'authorize').at(-1).scope === `${PLAYBACK} ${TOP}`, 'not connected: login with user-top-read, back and filled');

    // no Client ID on this site: an explanation instead of a broken button
    await page.evaluate(() => { localStorage.removeItem('timetunesr.spotify.clientId.v1'); localStorage.removeItem('timetunesr.spotify.token.v1'); });
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('playlist-top-create').click();
    await page.waitForFunction(() => /Koppel je eigen Spotify/.test(document.getElementById('toast')?.textContent || ''));
    assert(await page.getByTestId('screen-playlists').count() === 1, 'no Client ID: stays on the list, with a message');
    await page.goto(`${base}#/playlists/${plId}`);
    await page.getByTestId('pl-tab-spotify').click();
    await page.getByTestId('pl-sp-mode-top').click();
    await page.getByTestId('pl-top-no-client').waitFor();
    assert(/koppelhulp/.test(await page.getByTestId('pl-top-no-client').textContent()), 'no Client ID: explained in the tab');
    assert(await page.getByTestId('pl-setup-hint').getAttribute('href') === '#/instellingen/spotify', 'one line to the setup help: "Hele nummers? Koppel je eigen Spotify in ±5 minuten"');
    await shot(page, 'pl-top-05-no-client');
    await page.getByTestId('pl-setup-hint').click();
    await page.locator('[data-testid="spotify-block"][data-view="wizard-intro"]').waitFor();
    assert(true, 'the line leads to the setup help');
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
