// Importing a Spotify playlist into an own playlist, against a fake Spotify Web API
// (shape of the February 2026 API: GET /playlists/{id}/items, entries with `item`)
// and a fake iTunes for the preview match in the background.
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot } from './helpers.mjs';
import { installFakeItunes, byTitle } from './fake-itunes.mjs';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const OWN = '1OwnPlaylistAbcdefghij'; // 22 chars
const COLLAB = '2CollabPlaylistAbcdefg';
const OTHER = '3OthersPlaylistAbcdefg';
const PLAYBACK = 'user-read-playback-state user-modify-playback-state';
const PLAYLIST_SCOPES = 'playlist-read-private playlist-read-collaborative';

const trk = (id, name, artist, album, date) => ({ type: 'track', id, name, artists: [{ name: artist }], album: { name: album, release_date: date, release_date_precision: date.length === 4 ? 'year' : 'day' }, is_local: false });
const ENTRIES = [
  { item: trk('0TotoAfricaxxxxxxxxxxx', 'Africa', 'Toto', 'Toto IV', '1982-04-08') },
  { item: trk('0NirvanaTeenSpiritxxxx', 'Smells Like Teen Spirit - Remastered 2021', 'Nirvana', 'Nevermind (Remastered)', '2011-09-23') },
  { item: { type: 'episode', id: '0Episodexxxxxxxxxxxxxx', name: 'Een podcast' } },
  { track: trk('0OnlyOnSpotifyxxxxxxxx', 'Alleen Op Spotify', 'Testband', 'Demo', '2019') }, // old field name
  { is_local: true, item: { type: 'track', id: null, name: 'Lokaal bestand', is_local: true, artists: [], album: {} } },
  { item: trk('0EarthWindFireSeptxxxx', 'September', 'Earth, Wind & Fire', 'The Best Of Earth, Wind & Fire Vol. 1', '1978-11-23') },
];

async function fakeSpotify(ctx, base) {
  const m = { calls: [], scope: PLAYBACK, access: 'at-1' };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await ctx.route('https://accounts.spotify.com/authorize?**', (route) => {
    const u = new URL(route.request().url());
    m.calls.push({ what: 'authorize', scope: u.searchParams.get('scope') });
    const target = `${base}?code=CODE-1&state=${encodeURIComponent(u.searchParams.get('state'))}`;
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><p>Spotify (nep)</p><script>location.replace(${JSON.stringify(target)})</script>` });
  });
  await ctx.route('https://accounts.spotify.com/api/token', (route) => {
    m.scope = m.calls.at(-1)?.scope || PLAYBACK;
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
    const canRead = m.scope.includes('playlist-read-private');
    if (path === '/me') return json(route, 200, { id: 'anna', display_name: 'Anna Test', product: 'premium' });
    if (path === '/me/playlists') {
      if (!canRead) return json(route, 403, { error: { status: 403, message: 'Insufficient client scope' } });
      return json(route, 200, { items: [
        { id: OWN, name: 'Mijn feestlijst', owner: { id: 'anna' }, collaborative: false, items: { total: 6 } },
        { id: COLLAB, name: 'Samen met Bram', owner: { id: 'bram' }, collaborative: true, items: { total: 3 } },
        { id: OTHER, name: 'Top 50 Nederland', owner: { id: 'spotify' }, collaborative: false, items: { total: 50 } },
      ], next: null, total: 3 });
    }
    const pm = path.match(/^\/playlists\/([^/]+)(\/items)?$/);
    if (pm) {
      if (!canRead) return json(route, 403, { error: { status: 403, message: 'Insufficient client scope' } });
      const [, id, items] = pm;
      if (![OWN, COLLAB, OTHER].includes(id)) return json(route, 404, { error: { status: 404, message: 'Resource not found' } });
      if (!items) return json(route, 200, { name: { [OWN]: 'Mijn feestlijst', [COLLAB]: 'Samen met Bram', [OTHER]: 'Top 50 Nederland' }[id], owner: { id: 'x' } });
      if (id === OTHER) return json(route, 403, { error: { status: 403, message: 'Forbidden' } });
      const offset = Number(u.searchParams.get('offset')) || 0;
      const limit = 4; // small pages to test paging
      const page = ENTRIES.slice(offset, offset + limit);
      return json(route, 200, { items: page, total: ENTRIES.length, offset, limit, next: offset + limit < ENTRIES.length ? 'more' : null });
    }
    return json(route, 404, { error: { status: 404, message: 'Service not found' } });
  });
  return m;
}

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
    await page.getByTestId('playlist-new-name').fill('Van Spotify');
    await page.getByTestId('playlist-create').click();
    await page.getByTestId('screen-playlist').waitFor();
    const plId = await page.getByTestId('screen-playlist').getAttribute('data-id');

    // connected for playback only: ask once more, with the playlist scopes
    await page.getByTestId('pl-tab-spotify').click();
    await page.getByTestId('pl-spotify-scope').waitFor();
    assert(/zelf hebt gemaakt of waaraan je meewerkt/.test(await page.getByTestId('pl-spotify-limits').textContent()), 'limits explained in the app');
    await shot(page, 'pl-sp-01-scope');
    await page.getByTestId('pl-spotify-connect').click();
    await page.waitForURL(`${base}#/playlists/${plId}`);
    await page.getByTestId('pl-spotify-input').waitFor();
    const auth = sp.calls.find((c) => c.what === 'authorize');
    assert(auth.scope === `${PLAYBACK} ${PLAYLIST_SCOPES}`, `re-connect asks for the playlist scopes (${auth.scope})`);
    assert(await page.getByTestId('pl-tab-spotify').getAttribute('aria-selected') === 'true', 'back on the Spotify tab');

    // a playlist of someone else: explained, nothing added
    await page.getByTestId('pl-spotify-input').fill(`https://open.spotify.com/playlist/${OTHER}?si=abc`);
    await page.getByTestId('pl-spotify-import').click();
    await page.getByTestId('pl-spotify-error').waitFor();
    assert(/zelf hebt gemaakt/.test(await page.getByTestId('pl-spotify-error').textContent()), 'playlist of someone else: clear message (403)');
    await shot(page, 'pl-sp-02-not-own');
    await page.getByTestId('pl-spotify-input').fill('https://open.spotify.com/track/abc');
    await page.getByTestId('pl-spotify-import').click();
    assert(/geen link naar een Spotify-playlist/.test(await page.getByTestId('pl-spotify-error').textContent()), 'not a playlist link: message');

    // choose from own + collaborative playlists
    await page.getByTestId('pl-spotify-mine').click();
    await page.getByTestId('pl-spotify-list').waitFor();
    const names = await page.getByTestId('pl-spotify-option').allTextContents();
    assert(names.length === 2 && /Mijn feestlijst/.test(names[0]) && /Samen met Bram/.test(names[1]), 'list shows own and collaborative playlists only');
    await shot(page, 'pl-sp-03-mine');
    await page.getByTestId('pl-spotify-option').first().click();
    await page.getByTestId('pl-spotify-status').waitFor();
    await page.waitForFunction(() => /uit “Mijn feestlijst” toegevoegd/.test(document.querySelector('[data-testid="pl-spotify-status"]')?.textContent || ''));
    const itemCalls = sp.calls.filter((c) => c.what === `GET /playlists/${OWN}/items`);
    assert(itemCalls.length === 2 && itemCalls[1].query.offset === '4', 'items read via /playlists/{id}/items, paged');
    // background match with Apple Music
    await page.waitForFunction(() => !document.querySelector('[data-testid="pl-match-status"]'), null, { timeout: 20000 });
    const pl = (await page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')))).lists.find((p) => p.id === plId);
    const t = (title) => pl.tracks.find((x) => x.title.startsWith(title));
    assert(t('Smells Like').title === 'Smells Like Teen Spirit', 'Spotify "- Remastered 2021" suffix dropped from the title');
    assert(pl.tracks.length === 4, `4 songs (episode and local file skipped): ${pl.tracks.map((x) => x.title).join(', ')}`);
    assert(t('Africa').itunesId === byTitle('Africa').trackId && t('Africa').spotifyId === '0TotoAfricaxxxxxxxxxxx' && t('Africa').year === 1982, 'Toto: iTunes match + spotifyId, year 1982');
    assert(t('Smells Like').itunesId === byTitle('Smells Like Teen Spirit').trackId && t('Smells Like').year === 1991, `Nirvana: remaster 2011 on Spotify -> ${t('Smells Like').year} via iTunes`);
    assert(!t('Alleen Op Spotify').itunesId && t('Alleen Op Spotify').spotifyId, 'song without iTunes match keeps its spotifyId');
    assert(t('September').yearSure === false, 'compilation dates only: "controleer het jaar"');
    await page.locator('[data-testid="pl-spotify-only"]').waitFor();
    assert(itunes.search.length >= 4, `background iTunes searches (${itunes.search.length})`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'pl-sp-04-imported');
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
