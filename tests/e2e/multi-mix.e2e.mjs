// "Mix van de groep" through the Node room server: a spelleider and two players on their own
// phones (separate browser contexts, 390 px), each with an own fake Spotify account (top
// songs) and a fake iTunes. Both players and the spelleider add their favourites (Bram first
// has to log in: Spotify login and back into the same room on the same place), everybody sees
// only counts, the spelleider picks "Mix van de groep", a full game of Bingo (30-second
// fragments) and then Tijdlijn (whole songs via Spotify, so songs without a fragment play too);
// only contributed songs come up and nothing leaks to anybody before it is played. Then:
// withdrawing, too few songs, a Spotify account that is not admitted (403), a phone without an
// own Client ID using the spelleider's (more in multi-mix-leader), and
// the PeerJS route (only works with the server).
import { launch, startServer, assert, OUT } from './helpers.mjs';
import { join } from 'node:path';
import { startRoomServer, startSignal, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';
import { checkSquare } from '../../app/js/bingo.js';

/** Whole-page screenshot (new screens are reviewed in full, at 390 px). */
async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

export const CLIENT_ID = '0123456789abcdef0123456789abcdef';
export const PLAYBACK = 'user-read-playback-state user-modify-playback-state';
export const TOP = 'user-top-read';
const WORDS = ['Zomer', 'Regen', 'Haven', 'Molen', 'Duin', 'Storm', 'Tulp', 'Gracht', 'Kade', 'Polder', 'Vuurtoren', 'Klomp',
  'Fiets', 'Brug', 'Sluis', 'Dijk', 'Wad', 'Kwelder', 'Schip', 'Anker', 'Meeuw', 'Ijs', 'Schaats', 'Kerk', 'Toren', 'Plein',
  'Markt', 'Bakker', 'Kaas', 'Haring', 'Stroop', 'Wafel'];
const SONGS = WORDS.map((w, i) => ({
  i, title: `${w} Avond`, artist: `De ${w}mannen`, year: 1962 + i,
  spotifyId: `0${w}Mix`.padEnd(22, 'q').slice(0, 22),
  // Spotify sometimes has a remaster date; Apple Music has the original year
  spDate: i % 3 === 0 ? `${2009 + (i % 7)}-06-01` : `${1962 + i}-03-01`,
}));
const NOT_ON_APPLE = new Set([18, 19, 30, 31]);
let nextId = 8800000001;
const CATALOG = SONGS.filter((s) => !NOT_ON_APPLE.has(s.i)).map((s) => {
  const trackId = nextId++;
  return {
    wrapperType: 'track', kind: 'song', trackId, artistName: s.artist, trackName: s.title, collectionName: `${s.title} (Single)`,
    releaseDate: `${s.year}-03-01T12:00:00Z`, previewUrl: `https://audio-ssl.itunes.apple.com/fake/${trackId}.m4a`,
    trackViewUrl: `https://music.apple.com/nl/album/fake/1?i=${trackId}`,
  };
});
export const ACCOUNTS = {
  ilse: { top: SONGS.slice(0, 12) },
  anouk: { top: SONGS.slice(8, 20) }, // 8..11 also with Ilse: one song, more fans
  bram: { top: SONGS.slice(20, 32) },
  cas: { top: SONGS.slice(0, 5), notAllowed: true },
};
const spTrack = (s) => ({ type: 'track', id: s.spotifyId, uri: `spotify:track:${s.spotifyId}`, name: s.title, duration_ms: 200000, artists: [{ name: s.artist }], album: { name: `${s.title} (Remastered)`, release_date: s.spDate }, external_ids: { isrc: 'NL0000000001' }, is_local: false });

/** A fake Spotify for one phone (its own account). */
async function fakeSpotify(ctx, base, account) {
  const m = { calls: [], scope: account.scope || PLAYBACK, access: 'at-1', plays: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: body == null ? '' : JSON.stringify(body) });
  await ctx.route('https://accounts.spotify.com/authorize?**', (route) => {
    const u = new URL(route.request().url());
    m.calls.push({ what: 'authorize', scope: u.searchParams.get('scope'), redirect: u.searchParams.get('redirect_uri'), clientId: u.searchParams.get('client_id') });
    const target = `${base}?code=CODE-1&state=${encodeURIComponent(u.searchParams.get('state'))}`;
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><p>Spotify (nep)</p><script>location.replace(${JSON.stringify(target)})</script>` });
  });
  await ctx.route('https://accounts.spotify.com/api/token', (route) => {
    m.scope = m.calls.filter((c) => c.what === 'authorize').at(-1)?.scope || m.scope;
    m.access = 'at-2';
    return json(route, 200, { access_token: m.access, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', scope: m.scope });
  });
  await ctx.route('https://api.spotify.com/v1/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,PUT,POST' } });
    const u = new URL(req.url());
    const path = u.pathname.replace('/v1', '');
    m.calls.push({ what: `${req.method()} ${path}`, query: Object.fromEntries(u.searchParams) });
    if (req.headers().authorization !== `Bearer ${m.access}`) return json(route, 401, { error: { status: 401, message: 'The access token expired' } });
    if (account.notAllowed) return json(route, 403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } });
    if (path === '/me') return json(route, 200, { id: 'acc', display_name: 'Test', product: 'premium' });
    if (path === '/me/top/tracks') {
      if (!m.scope.includes(TOP)) return json(route, 403, { error: { status: 403, message: 'Insufficient client scope' } });
      const items = account.top.slice(0, Number(u.searchParams.get('limit')) || 20).map(spTrack);
      return json(route, 200, { items, total: items.length, limit: 50, offset: 0, next: null });
    }
    if (path === '/me/player/devices') return json(route, 200, { devices: [{ id: 'dev-speaker', name: 'Speaker', type: 'Speaker', is_active: true, is_restricted: false }] });
    if (path === '/me/player/play') { m.plays.push(JSON.parse(req.postData() || '{}')); return json(route, 204, null); }
    if (path === '/me/player/pause' || path === '/me/player/seek' || path === '/me/player') {
      if (req.method() === 'GET') { const last = m.plays.at(-1); return json(route, 200, { is_playing: true, progress_ms: 1000, item: last ? { uri: last.uris[0], duration_ms: 200000 } : null, device: { id: 'dev-speaker' } }); }
      return json(route, 204, null);
    }
    const tm = path.match(/^\/tracks\/(\w+)$/);
    if (tm) return json(route, 200, { id: tm[1], duration_ms: 200000 });
    return json(route, 404, { error: { status: 404, message: 'Service not found' } });
  });
  return m;
}

/** A phone with an own Spotify account (optionally already logged in with these scopes). */
export async function mixPhone(browser, rooms, base, account, { seed = null, token = null, clientId = true, gap = 30 } = {}) {
  const p = await phone(browser, rooms, { seed });
  await installFakeItunes(p.context, { catalog: CATALOG });
  p.sp = await fakeSpotify(p.context, base, { ...account, scope: token || PLAYBACK });
  await p.context.addInitScript(([cid, tok, g]) => {
    try {
      if (localStorage.getItem('timetunesr.e2eInit')) return; // only once: later loads keep what the app stored
      localStorage.setItem('timetunesr.e2eInit', '1');
      localStorage.setItem('timetunesr.itunesGap.v1', String(g));
      if (cid) localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid));
      if (tok) localStorage.setItem('timetunesr.spotify.token.v1', JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_at: Date.now() + 3600e3, scope: tok, clientId: cid }));
    } catch { /* ignore */ }
  }, [typeof clientId === 'string' ? clientId : clientId ? CLIENT_ID : null, token, gap]);
  return p;
}

const received = (page) => page.evaluate(() => window.__ttRoom?.session?.received || window.__ttHost?.session?.received || []);
const view = (page) => page.evaluate(() => window.__ttRoom?.session?.view || null);
const counts = async (page) => {
  const el = page.getByTestId('mix-counts');
  return { total: Number(await el.getAttribute('data-total')), contributors: Number(await el.getAttribute('data-contributors')), text: await el.textContent() };
};
export const myShared = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.mixShare.v1') || 'null')?.tracks || []);

export async function shareFavourites(page, { count = '10' } = {}) {
  await page.getByTestId('mix-count').selectOption(count);
  await page.getByTestId('mix-share').click();
}
export async function waitShared(page, n, timeout = 30000) {
  await page.locator(`[data-testid="mix-panel"][data-phase="done"] [data-testid="mix-done"][data-mine="${n}"]`).waitFor({ timeout });
}

function goodBingo(v, s) {
  const { card, marks } = v.game.mine;
  const n = v.game.size;
  const lines = [];
  for (let r = 0; r < n; r++) lines.push([...Array(n)].map((_, c) => r * n + c));
  for (let c = 0; c < n; c++) lines.push([...Array(n)].map((_, r) => r * n + c));
  lines.push([...Array(n)].map((_, i) => i * n + i), [...Array(n)].map((_, i) => i * n + n - 1 - i));
  const score = (i) => Math.max(...lines.filter((l) => l.includes(i)).map((l) => l.filter((j) => marks[j] != null).length));
  const open = card.map((k, i) => ({ k, i })).filter((o) => marks[o.i] == null)
    .filter((o) => o.k === 'artist' || o.k === 'title' || checkSquare(o.k, s.year, s.year) === true)
    .sort((a, b) => score(b.i) - score(a.i));
  const o = open[0];
  if (!o) return { pass: true };
  if (o.k === 'year') return { index: o.i, guess: s.year };
  if (o.k === 'artist') return { index: o.i, text: s.artist };
  if (o.k === 'title') return { index: o.i, text: s.title };
  return { index: o.i };
}
async function bingoAnswer(page, a) {
  if (a.pass) await page.getByTestId('answer-pass').click();
  else {
    await page.getByTestId(`bingo-cell-${a.index}`).click();
    if (a.guess != null) await page.getByTestId('answer-year-input').fill(String(a.guess));
    if (a.text != null) await page.getByTestId('answer-text-input').fill(a.text);
    await page.getByTestId('answer-lock').click();
  }
  await page.locator('[data-testid="answer-state"][data-state="locked"]').waitFor({ timeout: 15000 });
}
async function timelineAnswer(page, s) {
  const v = await view(page);
  const slot = v.game.mine.timeline.filter((c) => c.year <= s.year).length;
  await page.getByTestId(`slot-${slot}`).click();
  await page.getByTestId('answer-lock').click();
  await page.locator('[data-testid="answer-state"][data-state="locked"]').waitFor({ timeout: 15000 });
}

/**
 * Leak check: no contributed song in any message to this phone unless it may know it:
 * the music phone the songs played so far plus the running one, a player the songs played
 * (and revealed) before plus the cards in their own timeline.
 */
async function assertNoLeak(page, all, allowed, label) {
  const text = JSON.stringify(await received(page));
  const bad = [...all].filter((t) => !allowed.has(t) && text.includes(JSON.stringify(t)));
  if (bad.length) throw new Error(`${label}: favourites of others in a message before they were played: ${bad.join(', ')}`);
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const base = server.url.replace('localhost', '127.0.0.1'); // Spotify only accepts 127.0.0.1 for local testing
  const browser = await launch();
  const all = [];
  try {
    // ---------- room: spelleider Ilse (does not play), Anouk (logged in), Bram (not yet) ----------
    const host = await mixPhone(browser, rooms, base, ACCOUNTS.ilse, { seed: 7, token: `${PLAYBACK} ${TOP}` });
    const H = host.page;
    all.push(H);
    await H.goto(`${base}#/spelleider`);
    const code = await createRoom(H);
    const anouk = await mixPhone(browser, rooms, base, ACCOUNTS.anouk, { token: `${PLAYBACK} ${TOP}`, gap: 500 }); // slow Apple Music: progress visible
    const bram = await mixPhone(browser, rooms, base, ACCOUNTS.bram);
    const A = anouk.page;
    const B = bram.page;
    all.push(A, B);
    await joinRoom(A, base, code, 'Anouk', { via: 'code' });
    await joinRoom(B, base, code, 'Bram', { via: 'link' });
    await waitForPlayers(H, 2);
    await H.getByTestId('room-game-bingo').check(); // the lobby now starts on Discobingo
    assert(/nog geen nummers/.test((await counts(H)).text), 'lobby: "Mix van de groep: nog geen nummers"');
    assert(await H.getByTestId('room-music-mix').isDisabled(), 'Mix van de groep can not be chosen yet');
    assert(Number(await H.getByTestId('room-mix-need').getAttribute('data-missing')) === 16, 'Bingo 4×4 needs 16 songs: the lobby says how many are missing');
    await H.getByTestId('room-size-3').check();
    await H.locator('[data-testid="room-mix-need"][data-missing="10"]').waitFor();
    const consent = await A.getByTestId('mix-consent').textContent();
    assert(consent === 'Je deelt een deel van je meest geluisterde nummers met deze kamer; de anderen zien ze pas als ze gespeeld worden.', 'consent text on the player\'s phone');
    await shot(A, 'mix-01-player-lobby');
    await shot(H, 'mix-02-host-lobby-empty');

    // ---------- Anouk shares (already logged in): progress, songs arrive one by one ----------
    await shareFavourites(A);
    await A.getByTestId('mix-progress').waitFor({ timeout: 10000 });
    await H.waitForFunction(() => Number(document.querySelector('[data-testid="mix-counts"]')?.dataset.total) > 0, null, { timeout: 20000 });
    assert(await A.locator('[data-testid="mix-panel"][data-phase="matching"]').count() === 1, 'the first songs reach the room while Anouk\'s phone is still looking up the rest (progress bar)');
    await shot(A, 'mix-03-player-progress');
    await waitShared(A, 10);
    assert(anouk.sp.calls.some((c) => c.what === 'GET /me/top/tracks' && c.query.limit === '50' && c.query.time_range === 'medium_term'), 'top 50 of the last half year fetched, 10 chosen from it');
    const sharedA = await myShared(A);
    assert(sharedA.length === 10, 'Anouk shares 10 songs');
    const withPreview = sharedA.filter((t) => t.previewUrl).length;
    const orig = (t) => SONGS.find((x) => x.spotifyId === t.spotifyId);
    assert(withPreview >= 8 && sharedA.filter((t) => t.previewUrl).every((t) => t.year === orig(t).year && t.itunesId), `fragments and original years from Apple Music (${withPreview} with a fragment; remaster years on Spotify corrected)`);
    assert(sharedA.filter((t) => !t.previewUrl).every((t) => t.yearSure === false && t.year === Number(orig(t).spDate.slice(0, 4))), 'without Apple Music: Spotify\'s year, marked unsure');
    await shot(A, 'mix-04-player-done');

    // ---------- Bram must log in first: Spotify and back into the same room, same place ----------
    const bramId = await B.evaluate(() => window.__ttRoom.session.playerId);
    await B.getByTestId('mix-range').selectOption('short_term');
    await shareFavourites(B);
    await B.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    const auth = bram.sp.calls.find((c) => c.what === 'authorize');
    assert(auth && auth.scope.includes(TOP) && auth.redirect === base, `Bram logs in at Spotify with user-top-read (${auth?.scope})`);
    await B.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
    await waitShared(B, 10);
    assert(await B.evaluate(() => window.__ttRoom.session.playerId) === bramId, 'back in the same room on the same place (same player id)');
    assert(bram.sp.calls.some((c) => c.what === 'GET /me/top/tracks' && c.query.time_range === 'short_term'), 'his choice of period survived the login');
    await waitForPlayers(H, 2);
    assert(await H.locator('[data-testid^="room-player-"]').count() === 2, 'no second Bram in the room');

    // ---------- the spelleider shares too ----------
    await shareFavourites(H);
    await waitShared(H, 10);
    const sharedB = await myShared(B);
    const sharedH = await myShared(H);
    const contributed = new Map([...sharedA, ...sharedB, ...sharedH].map((t) => [t.spotifyId, t]));
    const titles = new Set([...contributed.values()].map((t) => t.title));
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '3', null, { timeout: 20000 });
    const ch = await counts(H);
    const ca = await counts(A);
    const cb = await counts(B);
    assert(ch.total === titles.size && ca.total === ch.total && cb.total === ch.total, `everybody sees the same count: ${ch.text} (duplicates counted once)`);
    assert(/Mix van de groep: \d+ nummers van 3 spelers/.test(ca.text), `counts only: "${ca.text}"`);
    const others = (mine) => [...titles].filter((t) => !mine.some((x) => x.title === t));
    for (const [pg, mine, nm] of [[A, sharedA, 'Anouk'], [B, sharedB, 'Bram'], [H, sharedH, 'spelleider']]) {
      const html = await pg.evaluate(() => document.documentElement.outerHTML);
      const seen = others(mine).filter((t) => html.includes(t));
      assert(!seen.length, `${nm}: no titles of the others on screen (${seen.join(', ')})`);
      await assertNoLeak(pg, others(mine), new Set(), `${nm} (lobby)`);
    }
    assert(true, 'lobby: no favourite of anybody else in any message to the players or to the spelleider');
    await shot(H, 'mix-05-host-lobby-counts');

    // ---------- the Node server restarts (memory gone): the spelleider's phone puts the room back,
    // the phones send their favourites again by themselves ----------
    await rooms.restart();
    await H.waitForFunction(() => window.__ttHost.session.meta?.restored === true && window.__ttHost.session.online, null, { timeout: 45000 });
    await H.waitForFunction((n) => { const m = window.__ttHost.session.meta?.mix; return m && m.contributors === 3 && m.total === n; }, ch.total, { timeout: 45000 });
    await A.waitForFunction(() => window.__ttRoom.session.meta?.restored === true && window.__ttRoom.session.online, null, { timeout: 45000 });
    await B.waitForFunction(() => window.__ttRoom.session.meta?.restored === true && window.__ttRoom.session.online, null, { timeout: 45000 });
    assert(true, `after a server restart (room put back by the spelleider's phone) all ${ch.total} songs of the 3 phones are back: sent again automatically`);

    // ---------- Bingo from the mix (30-second fragments) ----------
    await H.getByTestId('room-game-bingo').check(); // the lobby now starts on Discobingo
    await H.getByTestId('room-music-mix').check();
    await A.getByTestId('room-music-is-mix').waitFor();
    await H.getByTestId('room-mix-ok').waitFor();
    await shot(H, 'mix-06-host-mix-chosen');
    await H.getByTestId('room-start').click();
    const played = new Set();
    let round = 0;
    let previewOnly = true;
    for (;;) {
      await H.locator('[data-testid="screen-room-host"][data-view="answering"], [data-testid="screen-room-host"][data-view="won"]').first().waitFor({ timeout: 20000 });
      if (await H.locator('[data-testid="screen-room-host"][data-view="won"]').count()) break;
      round++;
      await A.waitForFunction((r) => window.__ttRoom.session.view?.game?.round === r, round, { timeout: 20000 });
      await B.waitForFunction((r) => window.__ttRoom.session.view?.game?.round === r, round, { timeout: 20000 });
      const { song } = await serverHost(H);
      assert(contributed.has(song.spotifyId) && contributed.get(song.spotifyId).title === song.title, `Bingo round ${round}: "${song.title}" is a contributed song`);
      if (!song.previewUrl && !song.itunesId) previewOnly = false;
      await assertNoLeak(H, titles, new Set([...played, song.title]), `spelleider, round ${round}`);
      await assertNoLeak(A, titles, played, `Anouk, round ${round}`);
      await assertNoLeak(B, titles, played, `Bram, round ${round}`);
      played.add(song.title);
      await bingoAnswer(A, goodBingo(await view(A), song));
      await bingoAnswer(B, goodBingo(await view(B), song));
      if (round === 1) { await shot(H, 'mix-07a-host-answering'); await shot(A, 'mix-07b-player-answering'); }
      await H.getByTestId('room-reveal').click();
      await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 20000 });
      const by = await A.getByTestId('room-song-by').textContent();
      assert(/Uit de favorieten van /.test(by), `reveal says whose favourite it was (${by})`);
      if (round === 1) await shot(A, 'mix-07-player-reveal-by');
      await H.getByTestId('room-next').click();
      if (round > 30) throw new Error('Bingo does not end');
    }
    assert(previewOnly, 'fragment source: only songs with an Apple Music fragment were in the game');
    assert(await A.getByTestId('room-winner').count() === 1, `Bingo from the mix played to the end (${round} rounds)`);

    // ---------- Tijdlijn from the mix, whole songs via Spotify on the spelleider's phone ----------
    await H.getByTestId('room-to-lobby').click();
    await H.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    await H.getByTestId('room-game-timeline').check();
    for (let i = 0; i < 5; i++) await H.getByTestId('room-goal-minus').click();
    await H.locator('[data-testid="room-goal-value"] b', { hasText: '5' }).waitFor();
    await H.evaluate(() => window.__tt.spotify.setSettings({ source: 'spotify' }));
    await H.getByTestId('room-game-bingo').check(); // redraw the lobby with the new source …
    await H.getByTestId('room-game-timeline').check(); // … and back
    const spotifyHave = Number(await H.getByTestId('room-mix-have').getAttribute('data-have'));
    assert(spotifyHave === titles.size, `Spotify source: all ${spotifyHave} songs count, also those without a fragment`);
    await H.getByTestId('room-start').click();
    // songs of the Bingo game stay "known": they were played and revealed
    round = 0;
    for (;;) {
      await H.locator('[data-testid="screen-room-host"][data-view="answering"], [data-testid="screen-room-host"][data-view="won"]').first().waitFor({ timeout: 20000 });
      if (await H.locator('[data-testid="screen-room-host"][data-view="won"]').count()) break;
      round++;
      await A.waitForFunction((r) => window.__ttRoom.session.view?.game?.round === r, round, { timeout: 20000 });
      await B.waitForFunction((r) => window.__ttRoom.session.view?.game?.round === r, round, { timeout: 20000 });
      const { song, room } = await serverHost(H);
      if (round === 1) assert(room.game.left + 3 === titles.size, `the game holds every contributed song (${room.game.left + 3})`);
      assert(contributed.has(song.spotifyId), `Tijdlijn round ${round}: "${song.title}" is a contributed song`);
      for (let i = 0; i < 50 && !host.sp.plays.some((p) => p.uris?.[0] === `spotify:track:${song.spotifyId}`); i++) await H.waitForTimeout(100);
      assert(host.sp.plays.some((p) => p.uris?.[0] === `spotify:track:${song.spotifyId}`), `round ${round}: the spelleider's phone plays spotify:track:${song.spotifyId}`);
      const own = async (pg) => new Set((await view(pg)).game.mine.timeline.map((c) => c.title));
      await assertNoLeak(H, titles, new Set([...played, song.title]), `spelleider, Tijdlijn round ${round}`);
      await assertNoLeak(A, titles, new Set([...played, ...(await own(A))]), `Anouk, Tijdlijn round ${round}`);
      await assertNoLeak(B, titles, new Set([...played, ...(await own(B))]), `Bram, Tijdlijn round ${round}`);
      played.add(song.title);
      await timelineAnswer(A, song);
      await timelineAnswer(B, song);
      await H.getByTestId('room-reveal').click();
      await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 20000 });
      await H.getByTestId('room-next').click();
      if (round > 30) throw new Error('Tijdlijn does not end');
    }
    assert(/Gedeelde winst/.test(await A.getByTestId('room-winner-name').textContent()), `Tijdlijn from the mix played to a shared win (${round} rounds)`);
    await shot(H, 'mix-08-host-timeline-won');
    const allMsgs = JSON.stringify(await received(A)) + JSON.stringify(await received(B));
    assert(!allMsgs.includes('"lead":') && !allMsgs.includes('"backup"'), 'players never got leader data or a backup');
    const backups = (await received(H)).filter((m) => m.t === 'backup');
    assert(backups.every((b) => !b.snap.room.game?.mix), 'the backup on the spelleider\'s phone never holds a game from the mix');

    // ---------- a Quiz from the mix: questions about contributed songs, wrong answers from the leader's own music ----------
    await H.getByTestId('room-to-lobby').click();
    await H.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    await H.getByTestId('room-game-quiz').check();
    await H.getByTestId('room-quiz-settings').waitFor();
    assert(/Mix van de groep/.test(await H.getByTestId('room-quiz-summary').textContent()), 'quiz lobby: music is the Mix van de groep, wrong answers from the own music');
    await H.getByTestId('room-start').click();
    const knownQ = new Set(played);
    for (let round = 1; round <= 10; round++) {
      await A.waitForFunction((r) => { const v = window.__ttRoom.session.view; return v?.phase === 'answering' && v.game.round === r && v.game.quiz.deadline; }, round, { timeout: 30000 });
      const { song } = await serverHost(H);
      assert(contributed.has(song.spotifyId), `Quiz question ${round}: about the contributed "${song.title}"`);
      const q = (await view(A)).game.quiz;
      const leak = q.options.filter((o) => titles.has(o) && o !== song.title && !knownQ.has(o));
      assert(!leak.length, `question ${round} (${q.type}): no favourite of somebody else among the answers (${q.options.join(' | ')})`);
      knownQ.add(song.title);
      for (const pg of [A, B]) await pg.getByTestId('quiz-option-0').click();
      await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 15000 });
      if (round === 1) assert(await A.getByTestId('room-song-by').count() === 1, 'quiz reveal: whose favourite it was');
      await H.getByTestId('room-next').click();
    }
    await A.getByTestId('quiz-podium').waitFor({ timeout: 15000 });
    assert(true, 'a whole quiz from the Mix van de groep, with podium');

    // ---------- withdraw ----------
    await H.evaluate(() => window.__tt.spotify.setSettings({ source: 'preview' }));
    await H.getByTestId('room-to-lobby').click();
    await H.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    const before = (await counts(B)).total;
    await A.getByTestId('mix-withdraw').click();
    await A.getByTestId('mix-share').waitFor();
    await B.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '2', null, { timeout: 20000 });
    assert((await counts(B)).total < before, `Anouk withdraws: ${before} -> ${(await counts(B)).total} songs, 2 players`);
    assert(await A.evaluate(() => localStorage.getItem('timetunesr.mixShare.v1')) === null, 'nothing of it stays on her phone either');

    // ---------- too few songs: explained, start disabled ----------
    await H.getByTestId('mix-withdraw').click();
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '1', null, { timeout: 20000 });
    await H.getByTestId('room-game-bingo').check();
    await H.getByTestId('room-size-4').check();
    await H.locator('[data-testid="room-mix-need"]', { hasText: '4×4' }).waitFor();
    const need = await H.getByTestId('room-mix-need').textContent();
    assert(/Te weinig nummers in de mix/.test(need) && /minstens 16/.test(need), `too few for Bingo 4×4: "${need.trim()}"`);
    assert(await H.getByTestId('room-start').isDisabled(), 'start is disabled');
    await shot(H, 'mix-09-host-too-few');

    // ---------- an account the owner did not admit (Development Mode): 403 -> clear message ----------
    const cas = await mixPhone(browser, rooms, base, ACCOUNTS.cas);
    const C = cas.page;
    all.push(C);
    await joinRoom(C, base, code, 'Cas', { via: 'link' });
    await shareFavourites(C);
    await C.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await C.getByTestId('mix-error').waitFor({ timeout: 20000 });
    const err = await C.getByTestId('mix-error').textContent();
    assert(/niet toegelaten/.test(err) && /User Management/.test(err), `not admitted (403): "${err}"`);
    assert(await C.locator('[data-testid="screen-room-player"][data-view="lobby"]').count() === 1, 'Cas is still in the room');
    await shot(C, 'mix-10-player-not-allowed');

    // ---------- no Client ID on this phone: the spelleider's comes with the room ----------
    // (a room whose spelleider has none, and old apps: suite multi-mix-leader)
    const dirk = await mixPhone(browser, rooms, base, ACCOUNTS.ilse, { clientId: false });
    const D = dirk.page;
    all.push(D);
    await joinRoom(D, base, code, 'Dirk', { via: 'link' });
    await D.getByTestId('mix-share').waitFor();
    assert(await D.getByTestId('mix-no-client').count() === 0 && await D.getByTestId('mix-login-note').getAttribute('data-client') === 'room', 'no own Client ID: "Doe mijn favorieten erbij" works with the spelleider\'s');
    await shot(D, 'mix-11-player-room-client');

    assert(all.every((p) => !p.errors.length), `no page errors (${all.flatMap((p) => p.errors).join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }

  // ---------- the PeerJS route: the mix needs the server ----------
  const signal = await startSignal();
  const server2 = await startServer();
  const browser2 = await launch();
  try {
    const host = await phone(browser2, signal);
    await host.page.goto(`${server2.url}#/spelleider`);
    const code = await createRoom(host.page);
    await host.page.getByTestId('mix-server-only').waitFor();
    const p = await phone(browser2, signal);
    await joinRoom(p.page, server2.url, code, 'Eva');
    await p.page.getByTestId('mix-server-only').waitFor();
    assert(await host.page.getByTestId('room-music-mix').count() === 0, 'PeerJS route: no mix choice, "werkt alleen via de kamerserver"');
  } finally {
    await browser2.close();
    server2.stop();
    await signal.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
