// The "Muziek kiezen" hub (#/playlists) and its flows, all against mocks: Deezer (JSONP in the
// sandboxed frame, answered by Playwright routes), Deezer's CDN (covers, previews), MusicBrainz
// (years), iTunes (fake-itunes.mjs) and a fake Spotify Web API. Nothing reaches a real service:
// a catch-all route (registered first, so it only sees what no mock answered) records and aborts
// every request to api.deezer.com / musicbrainz.org / itunes.apple.com / api.spotify.com, and
// the suite asserts that list stayed empty.
//
//  1  hub basics: sections, active list + Speel, saved lists (tap = active), "Zelf maken"
//  2  search: debounce, Enter, quick picks, paging, empty / error / offline + retry, pasted link,
//     hostile titles shown as plain text
//  3  the sheet: title / count / tracks, a fragment plays and stops, Esc + focus, Bewaar / Bijwerken
//  4  Speel direct (catalogue): fetch + year-check progress (503 once, ISRC 404 -> search), the
//     list becomes active, the play sheet and its three ways, "Speelt met N van M nummers"
//  5  Speel nu toch
//  6  year correctness: a re-release year replaced by the MusicBrainz year; a typed year is kept
//  7  Spotify: own playlists as cover tiles, import + play through Spotify, friendly "not yours"
//  8  from a room: Andere muziek kiezen / banner / back with the room and the player intact
//  9  the edit screen with 2000 songs (speed, status header, filter, slices, no sideways scroll)
// 10  no page errors, no request escaped the mocks
// Layout checks run at 390 px (phone) and 1280 px (laptop).
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, OUT } from './helpers.mjs';
import { installFakeItunes, silentWav } from './fake-itunes.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers } from './multi-helpers.mjs';

const WAV = silentWav(30);
const MB_GAP = 150; // ms between MusicBrainz requests while the progress is observed
const REAL_HOSTS = new Set(['api.deezer.com', 'musicbrainz.org', 'itunes.apple.com', 'api.spotify.com', 'accounts.spotify.com']);
const pad7 = (n) => String(n).padStart(7, '0');

/* ------------------------------------------------------------------------------------------
   The fake services
   ------------------------------------------------------------------------------------------ */

/** Catalogue playlists the suite knows. Any other id is a generic list of 25 songs. */
const LISTS = {
  1266971851: { title: 'Top Netherlands', by: 'Deezer Charts', n: 40, code: 'TNL' },
  7000001: { title: 'Eighties Test', by: 'DJ Test', n: 120, code: 'A01', delay: true },
  7000002: { title: 'Feestmix', by: 'Sanne', n: 60, code: 'B02' },
  7000003: { title: 'Klein feest', by: 'Bram', n: 20, code: 'T03' },
  7000010: { title: 'Bewaar mij', by: 'Radio Test', n: 12, code: 'S10' },
};
const listOf = (id) => LISTS[id] || { title: `Playlist ${id}`, by: 'Iemand', n: 25, code: 'GEN' };

const HOSTILE = [
  { id: 8100001, title: '<img src=x onerror="window.__xss=1">Boom', by: '<script>window.__xss=2</script>' },
  { id: 8100002, title: 'x"><b id="pwn">vet</b>', by: '</li></ul><h1 id="pwn2">kop</h1>' },
  { id: 8100003, title: "'; alert(1);//", by: '&lt;b&gt;ent&amp;' },
];

const trackId = (pid, k) => pid * 1000 + k + 1;
const unTrackId = (id) => ({ pid: Math.floor((id - 1) / 1000), k: (id - 1) % 1000 });

function songOf(pid, k) {
  const L = listOf(pid);
  if (L.code === 'A01' && k === 0) return { title: 'Take On Me', artist: 'a-ha' };
  return { title: `Song ${L.code}-${k + 1}`, artist: `Artiest ${k % 7}` };
}
const isrcOf = (pid, k) => `NL${listOf(pid).code}${pad7(k + 1)}`;

/** The year Deezer gives (the release it sits on: mostly a later re-release). */
function deezerYear(code, k) {
  if (code === 'A01') {
    if (k === 0) return 2011;
    if (k % 4 === 0) {
      const j = k / 4;
      if (j % 5 === 1) return 2008;
      if (j % 5 === 2) return 1990;
      return 2000 + (k % 10);
    }
  }
  return 2005 + (k % 10);
}
/** What MusicBrainz knows for the ISRC of song k of the list with this code. */
function mbRule(code, k) {
  if (code === 'A01') {
    if (k === 0) return { isrc: 1984 };
    if (k % 4 === 0) {
      const j = k / 4;
      if (j === 3) return { isrc: 1979, once503: true }; // k = 12: busy once, then an answer
      if (j % 5 === 1) return { isrc404: true, search: 1993 }; // unknown ISRC: found by the search
      if (j % 5 === 2) return { isrc: 2001 }; // later than Deezer's 1990: ours stays
      return { isrc: 1980 + (k % 10) };
    }
  }
  return { isrc: 1975 + (k % 30) };
}

export function newMocks() {
  return {
    escaped: [], // requests no mock answered (must stay empty)
    hits: { deezer: 0, musicbrainz: 0, itunes: 0, spotify: 0 },
    search: [], // { q, index } of every playlist search
    tracksReq: [], // { pid, index } of every playlist/tracks request
    trackDelayMs: 0, // delay of the tracks pages of lists with `delay`
    storing: true, // 'storing' searches fail with a Deezer error until this is false
    previews: [], // preview URLs the page fetched
    mb: { isrc: {}, fired503: new Set(), n503: 0, search: [], n404: 0 },
    spotify: { calls: [], delayMs: 0 },
  };
}

/** Registered FIRST: only sees what the mocks after it did not answer. */
async function installEscapeGuard(ctx, M) {
  await ctx.route((url) => REAL_HOSTS.has(url.hostname), (route) => {
    M.escaped.push(route.request().url());
    return route.abort();
  });
  ctx.on('request', (req) => {
    const h = new URL(req.url()).hostname;
    if (h === 'api.deezer.com') M.hits.deezer++;
    else if (h === 'musicbrainz.org') M.hits.musicbrainz++;
    else if (h === 'itunes.apple.com') M.hits.itunes++;
    else if (h === 'api.spotify.com') M.hits.spotify++;
  });
}

function svg(id, w = 250) {
  const h = (Number(String(id).replace(/\D/g, '').slice(-4)) * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"><rect width="${w}" height="${w}" fill="hsl(${h},65%,48%)"/><circle cx="${w * 0.7}" cy="${w * 0.3}" r="${w * 0.15}" fill="rgba(255,255,255,.3)"/></svg>`;
}

async function installMusic(ctx, M) {
  const pic = (id) => `https://cdn-images.dzcdn.net/images/playlist/${id}/250x250-000000-80-0-0.jpg`;
  const item = (id) => { const L = listOf(id); return { id, title: L.title, nb_tracks: L.n, public: true, picture_medium: pic(id), user: { name: L.by } }; };
  const trackJson = (pid, k) => {
    const s = songOf(pid, k);
    return { id: trackId(pid, k), readable: true, title: s.title, title_short: s.title, isrc: isrcOf(pid, k), artist: { name: s.artist }, album: { title: 'Album' } };
  };

  await ctx.route('https://api.deezer.com/**', async (route) => {
    const u = new URL(route.request().url());
    const cb = u.searchParams.get('callback') || 'cb';
    const send = (j) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: `${cb}(${JSON.stringify(j)})` });
    let m;
    if (u.pathname === '/search/playlist') {
      const q = u.searchParams.get('q') || '';
      const index = Number(u.searchParams.get('index') || 0);
      const limit = Number(u.searchParams.get('limit') || 25);
      M.search.push({ q, index });
      if (/storing/i.test(q) && M.storing) return send({ error: { code: 100, message: 'down' } });
      if (/niets/i.test(q)) return send({ data: [], total: 0 });
      if (/hostiel/i.test(q)) {
        return send({ data: HOSTILE.map((h) => ({ id: h.id, title: h.title, nb_tracks: 25, public: true, picture_medium: pic(h.id), user: { name: h.by } })), total: HOSTILE.length });
      }
      const total = /top 40/i.test(q) ? 60 : 30;
      const data = [];
      for (let i = index; i < Math.min(total, index + limit); i++) {
        if (i === 0 && /top 40/i.test(q)) data.push(item(7000010));
        else data.push({ id: 8000000 + i, title: `${q} lijst ${i + 1}`, nb_tracks: 25, public: true, picture_medium: pic(8000000 + i), user: { name: `Maker ${i + 1}` } });
      }
      return send({ data, total, ...(index + limit < total ? { next: 'https://api.deezer.com/search/playlist?index=x' } : {}) });
    }
    if ((m = u.pathname.match(/^\/playlist\/(\d+)$/))) {
      const id = Number(m[1]);
      const H = HOSTILE.find((h) => h.id === id);
      if (H) return send({ id, title: H.title, nb_tracks: 25, public: true, picture_medium: pic(id), creator: { name: H.by } });
      const j = item(id);
      j.creator = j.user;
      return send(j);
    }
    if ((m = u.pathname.match(/^\/playlist\/(\d+)\/tracks$/))) {
      const pid = Number(m[1]);
      const L = listOf(pid);
      const index = Number(u.searchParams.get('index') || 0);
      const limit = Number(u.searchParams.get('limit') || 25);
      M.tracksReq.push({ pid, index });
      if (L.delay && M.trackDelayMs) await new Promise((r) => setTimeout(r, M.trackDelayMs));
      const data = [];
      for (let k = index; k < Math.min(L.n, index + limit); k++) data.push(trackJson(pid, k));
      return send({ data, total: L.n, ...(index + limit < L.n ? { next: 'x' } : {}) });
    }
    if ((m = u.pathname.match(/^\/track\/(\d+)$/))) {
      const { pid, k } = unTrackId(Number(m[1]));
      const L = listOf(pid);
      return send({ ...trackJson(pid, k), release_date: `${deezerYear(L.code, k)}-03-01`, preview: `https://cdnt-preview.dzcdn.net/api/1/1/${m[1]}.mp3?hdnea=exp=4102444800~acl=x` });
    }
    return send({ error: { code: 800, message: 'no data' } });
  });

  await ctx.route('https://cdn-images.dzcdn.net/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(route.request().url()) }));
  await ctx.route('https://i.scdn.co/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(route.request().url(), 300) }));
  await ctx.route('https://cdnt-preview.dzcdn.net/**', (route) => {
    M.previews.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV });
  });

  await ctx.route('https://musicbrainz.org/**', async (route) => {
    const u = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*' };
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (u.pathname.startsWith('/ws/2/isrc/')) {
      const isrc = u.pathname.split('/').pop();
      const code = isrc.slice(2, 5);
      const k = Number(isrc.slice(5)) - 1;
      const rule = mbRule(code, k);
      M.mb.isrc[isrc] = (M.mb.isrc[isrc] || 0) + 1;
      if (rule.once503 && !M.mb.fired503.has(isrc)) { M.mb.fired503.add(isrc); M.mb.n503++; return json(503, { error: 'busy' }); }
      if (rule.isrc404) { M.mb.n404++; return json(404, { error: 'Not Found' }); }
      const s = { title: `x`, 'first-release-date': `${rule.isrc}-04-01` };
      return json(200, { recordings: [s] });
    }
    if (u.pathname === '/ws/2/recording') {
      const q = u.searchParams.get('query') || '';
      const mm = q.match(/recording:"((?:[^"\\]|\\.)*)" AND artist:"((?:[^"\\]|\\.)*)"/);
      M.mb.search.push(q);
      if (!mm) return json(200, { recordings: [] });
      const [, title, artist] = mm;
      const tm = title.match(/^Song ([A-Z0-9]{3})-(\d+)$/);
      const rule = tm ? mbRule(tm[1], Number(tm[2]) - 1) : null;
      if (!rule?.search) return json(200, { recordings: [] });
      return json(200, { recordings: [{ title, 'artist-credit': [{ name: artist }], 'first-release-date': `${rule.search}-02-01` }] });
    }
    return json(404, { error: 'Not Found' });
  });
}

/* ---- a fake Spotify Web API (the February 2026 shape: /playlists/{id}/items with `item`) ---- */

const SP = {
  clientId: '0123456789abcdef0123456789abcdef',
  playback: 'user-read-playback-state user-modify-playback-state',
  playlistScopes: 'playlist-read-private playlist-read-collaborative',
  own: '1OwnPlaylistAbcdefghij', // 22 characters
  collab: '2CollabPlaylistAbcdefg',
  locked: '3TopFiftyNederlandAbc', // listed as the user's own, but Spotify refuses its songs
  foreign: '4SomeoneElsesListAbcd', // somebody else's: not offered at all
};
const SP_COUNT = { [SP.own]: 30, [SP.collab]: 8 };
const spTrack = (k) => ({
  type: 'track', id: `${String(k).padStart(2, '0')}SpotTrackAbcdefghijk`.slice(0, 22), name: `Spotify nummer ${k + 1}`,
  artists: [{ name: `Artiest ${k % 5}` }], album: { name: 'Album', release_date: '2015-01-01' }, external_ids: { isrc: `NLSPT${pad7(k + 1)}` },
});

async function installSpotify(ctx, M) {
  await ctx.route('https://api.spotify.com/v1/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname.replace('/v1', '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' } });
    M.spotify.calls.push(`${req.method()} ${p}`);
    if (p === '/me') return json(200, { id: 'anna', display_name: 'Anna Test' });
    if (p === '/me/playlists') {
      const img = (id) => [{ url: `https://i.scdn.co/image/${id}` }];
      return json(200, { next: null, items: [
        { id: SP.own, name: 'Mijn feestlijst', owner: { id: 'anna' }, collaborative: false, items: { total: 30 }, images: img(SP.own) },
        { id: SP.collab, name: 'Samen met Bram', owner: { id: 'bram' }, collaborative: true, items: { total: 8 }, images: img(SP.collab) },
        { id: SP.locked, name: 'Top 50 Nederland', owner: { id: 'anna' }, collaborative: false, items: { total: 50 }, images: [] },
        { id: SP.foreign, name: 'Van iemand anders', owner: { id: 'spotify' }, collaborative: false, items: { total: 99 }, images: img(SP.foreign) },
      ] });
    }
    const m = p.match(/^\/playlists\/([^/]+)\/items$/);
    if (m) {
      const id = m[1];
      if (id === SP.locked || id === SP.foreign) return json(403, { error: { status: 403, message: 'Forbidden' } });
      if (M.spotify.delayMs) await new Promise((r) => setTimeout(r, M.spotify.delayMs));
      const total = SP_COUNT[id] ?? 0;
      const off = Number(u.searchParams.get('offset')) || 0;
      const lim = Math.min(Number(u.searchParams.get('limit')) || 50, 50);
      const items = [];
      for (let k = off; k < Math.min(total, off + lim); k++) items.push({ item: spTrack(k) });
      return json(200, { items, total, offset: off, limit: lim, next: off + lim < total ? 'more' : null });
    }
    return json(404, { error: { status: 404, message: 'Service not found' } });
  });
}

/* ------------------------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------------------------ */

let checks = 0;
const check = (cond, msg) => { assert(cond, msg); checks++; };

const storedLists = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1') || '{"lists":[]}').lists);
const bySource = async (page, id) => (await storedLists(page)).find((p) => p.source && String(p.source.id) === String(id));
const activeId = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('timetunesr.activeDeck.v1')) || 'builtin'; } catch { return 'builtin'; } });
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
const text = async (page, id) => ((await page.getByTestId(id).first().textContent()) || '').replace(/\s+/g, ' ').trim();
const setGap = (page, ms) => page.evaluate((v) => localStorage.setItem('timetunesr.mbGap.v1', String(v)), ms);

/** Poll the sheet's progress block into window.__samples (phases and the "x van y" counts, in order). */
const startSampler = (page) => page.evaluate(() => {
  clearInterval(window.__sampler);
  window.__samples = { phases: [], counts: [] };
  window.__sampler = setInterval(() => {
    const p = document.querySelector('[data-testid="sheet-progress"]');
    if (!p) return;
    const s = window.__samples;
    const ph = p.dataset.phase;
    if (s.phases[s.phases.length - 1] !== ph) s.phases.push(ph);
    const c = p.querySelector('[data-testid="sheet-progress-count"]')?.textContent.trim();
    if (c) { const key = `${ph}:${c}`; if (s.counts[s.counts.length - 1] !== key) s.counts.push(key); }
  }, 25);
});
const samples = (page) => page.evaluate(() => { clearInterval(window.__sampler); return window.__samples; });

/** A search through the field (the debounce runs). */
async function searchFor(page, q) {
  const input = page.getByTestId('pl-search-input');
  await input.fill(q);
  return input;
}

async function newPage(ctx, errors, label) {
  const page = await ctx.newPage();
  // (the opaque-origin Deezer frame makes Playwright's own init scripts complain about
  // serviceWorker / localStorage access: that is the test harness, not the app)
  page.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin'/.test(e.message)) errors.push(`${label}: ${e.message}`); });
  page.on('dialog', (d) => d.accept());
  return page;
}

async function phoneCtx(browser, M, { w = 390, h = 800, mobile = true } = {}) {
  const ctx = mobile
    ? await phoneContext(browser, { viewport: { width: w, height: h } })
    : await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'nl-NL', serviceWorkers: 'block' });
  await installEscapeGuard(ctx, M);
  await useFixtureDeck(ctx);
  await installFakeItunes(ctx);
  await installMusic(ctx, M);
  return ctx;
}

/* ------------------------------------------------------------------------------------------ */

export default async function run() {
  const web = await startServer(8100 + Math.floor(Math.random() * 400));
  const base = web.url;
  const browser = await launch();
  const M = newMocks();
  const errors = [];
  let rs = null;
  try {
    /* ============================ 1 + 2 + 3: hub, search, sheet (phone) ============================ */
    const ctx = await phoneCtx(browser, M);
    const page = await newPage(ctx, errors, 'phone');
    page.setDefaultTimeout(30000);
    await page.goto(base);
    await setGap(page, MB_GAP);
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();

    console.log('# 1 hub basics (390 px)');
    check(await page.getByTestId('screen-playlists').isVisible(), 'the hub opens at #/playlists');
    check((await text(page, 'music-current-name')).includes('TimeTunesr'), 'Nu gekozen: the built-in deck is the active list');
    check(await page.getByTestId('music-play').isVisible() && /Speel/.test(await text(page, 'music-play')), 'a primary "Speel" button');
    check((await text(page, 'music-current-ready')).length > 5, 'a short readiness line under the active list');
    for (const [id, what] of [['pl-search', 'Zoek een playlist'], ['pl-search-input', 'the search field'], ['pl-quick-top-nl', 'the quick pick Top Nederland'], ['pl-search-note', 'the catalogue note'], ['sp-tip', 'the Spotify tip'], ['deck-list', 'Bewaard'], ['playlist-new-form', 'Zelf maken']]) {
      check(await page.getByTestId(id).count() === 1, `section / element present: ${what}`);
    }
    check(/Deezer/.test(await text(page, 'pl-search-note')) && /Spotify/.test(await text(page, 'pl-search-note')), 'one calm line says where the search comes from and how it plays');
    check(await page.locator('[data-testid^="pl-quick-"]').count() === 16, 'all 16 quick picks are there');
    check(await page.getByTestId('pl-search-input').getAttribute('placeholder') === 'Zoek een playlist: top 40, jaren 90, hardcore…', 'search placeholder as briefed');
    check(await noSideScroll(page), 'hub: no sideways scrolling at 390 px');
    await shot(page, 'muziek-01-hub-390');
    // Speel on the built-in deck: the play sheet with the three ways
    await page.getByTestId('music-play').click();
    await page.getByTestId('play-sheet').waitFor();
    check(await page.getByTestId('play-room').isVisible() && await page.getByTestId('play-timeline').isVisible() && await page.getByTestId('play-bingo').isVisible(), 'Speel: the play sheet offers samen / Tijdlijn / Bingo');
    await page.keyboard.press('Escape');
    await page.getByTestId('play-sheet').waitFor({ state: 'detached' });
    // "Zelf maken": the form still creates a list
    await page.getByTestId('playlist-new-name').fill('Zelf lijstje');
    await page.getByTestId('playlist-create').click();
    await page.getByTestId('screen-playlist').waitFor();
    const ownId = await page.getByTestId('screen-playlist').getAttribute('data-id');
    check(!!ownId && (await storedLists(page)).some((p) => p.id === ownId && p.name === 'Zelf lijstje'), '"Zelf maken" creates a list and opens its edit screen');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    const mine = page.locator(`[data-testid="deck-pick"][data-deck-id="${ownId}"]`);
    check(await mine.count() === 1, 'the new list shows up under Bewaard');
    await mine.click();
    check(await page.locator(`[data-testid="deck-pick"][data-deck-id="${ownId}"]`).getAttribute('aria-pressed') === 'true' && (await text(page, 'music-current-name')) === 'Zelf lijstje', 'a tap on a saved list makes it the active one (card and Nu gekozen follow)');
    check(await activeId(page) === ownId, 'the active list is stored');
    await page.locator('[data-testid="deck-pick"][data-deck-id="builtin"]').click();
    check(await activeId(page) === 'builtin' && (await text(page, 'music-current-name')).includes('TimeTunesr'), 'a tap on the built-in deck switches back');

    console.log('# 2 search');
    // typing: nothing happens before the pause, one search after it
    M.search.length = 0;
    await searchFor(page, 'top 40');
    check(M.search.length === 0, 'typing does not search before the short pause');
    await page.getByTestId('pl-result').first().waitFor();
    check(M.search.length === 1 && M.search[0].q === 'top 40', 'one search after the pause');
    check(await page.getByTestId('pl-result').count() === 24, 'the first page has 24 playlists');
    const r0 = page.getByTestId('pl-result').first();
    check(/Bewaar mij/.test(await r0.textContent()) && /12 nummers · door Radio Test/.test(await r0.textContent()), 'a result shows title, number of songs and maker');
    check(await r0.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 'a result shows its cover');
    check(/60 playlists voor “top 40”/.test(await text(page, 'pl-search-status')), 'the result count line');
    // paging
    await page.getByTestId('pl-results-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-result"]').length === 48);
    await page.getByTestId('pl-results-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-result"]').length === 60);
    const ids = await page.getByTestId('pl-result').evaluateAll((els) => els.map((e) => e.dataset.id));
    check(new Set(ids).size === 60, 'Meer laden: 24 + 24 + 12 results, no duplicates');
    check(await page.getByTestId('pl-results-more').count() === 0, 'no "Meer laden" after the last page');
    check(M.search.map((s) => s.index).join(',') === '0,24,48', 'the pages were asked at index 0, 24, 48');
    check(await noSideScroll(page), 'results: no sideways scrolling at 390 px');
    await page.getByTestId('pl-search').scrollIntoViewIfNeeded();
    await shot(page, 'muziek-02-results-390');
    // Enter searches at once and only once
    M.search.length = 0;
    await page.getByTestId('pl-search-input').fill('jaren 90');
    await page.getByTestId('pl-search-input').press('Enter');
    await page.waitForFunction(() => /voor “jaren 90”/.test(document.querySelector('[data-testid="pl-search-status"]')?.textContent || ''));
    await page.waitForTimeout(800); // the debounce timer of the same text must not fire a second search
    check(M.search.length === 1 && M.search[0].q === 'jaren 90', 'Enter searches at once, and the pause does not search it again');
    // quick picks
    await page.getByTestId('pl-quick-hardcore').click();
    await page.waitForFunction(() => /voor “Hardcore”/.test(document.querySelector('[data-testid="pl-search-status"]')?.textContent || ''));
    check(await page.getByTestId('pl-search-input').inputValue() === 'Hardcore' && M.search.at(-1).q === 'Hardcore', 'a quick pick with a query fills the field and searches');
    await page.getByTestId('pl-quick-top-nl').click();
    await page.getByTestId('sheet-playlist').waitFor();
    check(/Top/.test(await text(page, 'sheet-title')), 'a quick pick with a playlist opens that list at once (no search)');
    await page.waitForFunction(() => /Top Netherlands/.test(document.querySelector('[data-testid="sheet-title"]')?.textContent || ''));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length > 0);
    check(/40 nummers · door Deezer Charts/.test(await text(page, 'sheet-count')), 'the quick-pick sheet fills in the real name, count and maker');
    check(M.search.at(-1).q === 'Hardcore', 'the playlist quick pick did not start a search');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    // empty
    await searchFor(page, 'niets te vinden');
    await page.getByTestId('pl-search-empty').waitFor();
    check(/Niets gevonden voor “niets te vinden”/.test(await text(page, 'pl-search-empty')), 'empty result: a clear message');
    // a Deezer error, then retry
    await searchFor(page, 'storing');
    await page.getByTestId('pl-search-error').waitFor();
    check(/Deezer is even niet bereikbaar/.test(await text(page, 'pl-search-error')), 'a Deezer error: the Dutch message');
    await shot(page, 'muziek-03-search-error');
    M.storing = false;
    await page.getByTestId('pl-search-retry').click();
    await page.getByTestId('pl-result').first().waitFor();
    check(await page.getByTestId('pl-search-error').count() === 0 && await page.getByTestId('pl-result').count() > 0, 'Probeer opnieuw: the retry gets the results');
    // offline, then retry
    await ctx.setOffline(true);
    await searchFor(page, 'offline lijstje');
    await page.getByTestId('pl-search-error').waitFor();
    check(/Geen internetverbinding/.test(await text(page, 'pl-search-error')), 'offline: the "geen internetverbinding" message');
    await ctx.setOffline(false);
    await page.getByTestId('pl-search-retry').click();
    await page.getByTestId('pl-result').first().waitFor();
    check(M.search.at(-1).q === 'offline lijstje' && await page.getByTestId('pl-result').count() === 24, 'back online: Probeer opnieuw searches again and shows the results');
    // hostile titles
    await searchFor(page, 'hostiel');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-result"]').length === 3);
    const rtxt = await page.getByTestId('pl-results').textContent();
    check(rtxt.includes('<img src=x onerror="window.__xss=1">Boom') && rtxt.includes('<script>window.__xss=2</script>') && rtxt.includes('x"><b id="pwn">vet</b>'), 'hostile titles and makers are shown as plain text');
    check(await page.locator('#pwn, #pwn2, [data-testid="pl-results"] script, [data-testid="pl-results"] img[onerror], [data-testid="pl-results"] h1').count() === 0, 'no element was injected by a hostile title or maker');
    check(await page.evaluate(() => window.__xss) === undefined, 'no script ran');
    await page.getByTestId('pl-result').nth(1).click();
    await page.getByTestId('sheet-playlist').waitFor();
    check(await text(page, 'sheet-title') === 'x"><b id="pwn">vet</b>' && await page.locator('.ms-sheet #pwn, .ms-sheet #pwn2').count() === 0, 'the sheet shows a hostile title as plain text too');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    // a pasted deezer.com link opens that list (and nothing is searched)
    M.search.length = 0;
    await page.getByTestId('pl-search-input').fill('https://www.deezer.com/nl/playlist/7000010?utm_source=deezer');
    await page.getByTestId('sheet-playlist').waitFor();
    await page.waitForFunction(() => /Bewaar mij/.test(document.querySelector('[data-testid="sheet-title"]')?.textContent || ''));
    check(M.search.length === 0, 'a pasted deezer.com playlist link opens that list at once');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });

    console.log('# 3 the sheet');
    await searchFor(page, 'top 40');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-result"]').length === 24 && /voor “top 40”/.test(document.querySelector('[data-testid="pl-search-status"]')?.textContent || ''));
    await page.getByTestId('pl-result').first().click();
    await page.getByTestId('sheet-playlist').waitFor();
    check(await page.getByTestId('sheet-title').textContent() === 'Bewaar mij' && /12 nummers · door Radio Test/.test(await text(page, 'sheet-count')), 'the sheet: title, number of songs, maker');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length === 12);
    check(/Song S10-1/.test(await page.getByTestId('sheet-track').first().textContent()) && /Artiest 0/.test(await page.getByTestId('sheet-track').first().textContent()), 'the first songs are listed with title and artist');
    check(await page.getByTestId('sheet-listen').count() === 12, 'every catalogue song has a listen button');
    check(await page.locator('.ms-sheet').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; }) && await noSideScroll(page), 'the sheet fits the screen width');
    await shot(page, 'muziek-04-sheet-390');
    // a fragment plays through the normal player, one at a time
    await page.getByTestId('sheet-listen').nth(2).click();
    await page.waitForFunction(() => /cdnt-preview\.dzcdn\.net\/api\/1\/1\/\d+\.mp3/.test(document.querySelector('audio')?.src || ''));
    const src2 = await page.evaluate(() => document.querySelector('audio').src);
    check(src2.includes(String(trackId(7000010, 2))), `▶ plays the fragment of that song (audio src ${src2.slice(0, 60)}…)`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-listen"]')[2]?.getAttribute('aria-pressed') === 'true');
    check(true, 'the playing song is marked');
    await page.getByTestId('sheet-listen').nth(4).click();
    await page.waitForFunction((id) => document.querySelector('audio')?.src.includes(String(id)), trackId(7000010, 4));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-listen"][aria-pressed="true"]').length === 1 && document.querySelectorAll('[data-testid="sheet-listen"]')[4].getAttribute('aria-pressed') === 'true');
    check(true, 'only one song plays at a time');
    check(M.previews.length >= 2 && M.previews.every((u) => u.startsWith('https://cdnt-preview.dzcdn.net/')), 'the previews came from the (mocked) Deezer CDN');
    // Esc closes, stops the audio and gives the focus back to the result
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    check(await page.evaluate(() => { const a = document.querySelector('audio'); return a.paused && !a.getAttribute('src'); }), 'closing the sheet stops the fragment');
    check(await page.evaluate(() => document.activeElement?.dataset.testid === 'pl-result' && document.activeElement.dataset.id === '7000010'), 'Esc closes the sheet and the focus returns to the result that opened it');
    // Bewaar: saved, not active
    await page.getByTestId('pl-result').first().click();
    await page.getByTestId('sheet-playlist').waitFor();
    check(/Bewaar/.test(await text(page, 'sheet-save')) && await page.getByTestId('sheet-existing').count() === 0, 'a new list offers "Bewaar"');
    await page.getByTestId('sheet-save').click();
    await page.getByTestId('sheet-saved').waitFor();
    check(/Bewaard: “Bewaar mij” \(12 nummers\)/.test(await text(page, 'sheet-saved')), 'Bewaar says it was saved');
    const saved = await bySource(page, 7000010);
    check(!!saved && saved.tracks.length === 12 && saved.source.kind === 'deezer', 'the list is stored with its source and 12 songs');
    check(await activeId(page) === 'builtin', 'Bewaar does not make the list active');
    check(/Bewaar mij/.test(await page.locator('[data-testid="deck-pick"]').filter({ hasText: 'Bewaar mij' }).textContent()) && /Deezer/.test(await page.locator('[data-testid="deck-pick"]').filter({ hasText: 'Bewaar mij' }).textContent()), 'it shows under Bewaard with a Deezer mark');
    check(await page.getByTestId('sheet-save').evaluate((b) => /Bijwerken/.test(b.textContent)) && await page.getByTestId('sheet-existing').count() === 1, 'the sheet now offers "Bijwerken" and says it is already saved');
    await page.getByTestId('sheet-save').click();
    await page.waitForFunction(() => /Bijgewerkt/.test(document.querySelector('[data-testid="sheet-saved"]')?.textContent || ''));
    check(/Bijgewerkt: “Bewaar mij” had alle nummers al/.test(await text(page, 'sheet-saved')), 'saving the same list again says it was updated');
    check((await storedLists(page)).filter((p) => p.source && p.source.id === '7000010').length === 1 && (await bySource(page, 7000010)).id === saved.id, 'and does not make a second copy');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    check(/Bewaard/.test(await page.getByTestId('pl-result').first().textContent()), 'the result card is marked "Bewaard"');

    /* ============================ 4: Speel direct (catalogue) ============================ */
    console.log('# 4 Speel direct');
    M.trackDelayMs = 350;
    await page.getByTestId('pl-search-input').fill('https://www.deezer.com/nl/playlist/7000001');
    await page.getByTestId('sheet-playlist').waitFor();
    await page.waitForFunction(() => /Eighties Test/.test(document.querySelector('[data-testid="sheet-title"]')?.textContent || '') && document.querySelectorAll('[data-testid="sheet-track"]').length === 30);
    check(/120 nummers · door DJ Test/.test(await text(page, 'sheet-count')), 'a pasted link: the sheet has the name, 120 songs and the maker');
    check(/… en nog 90 nummers/.test(await page.locator('.ms-rest').textContent()), 'the sheet previews 30 songs and says how many more');
    await startSampler(page);
    const t0 = Date.now();
    await page.getByTestId('sheet-play-now').click();
    await page.getByTestId('sheet-progress').waitFor();
    await page.getByTestId('play-sheet').waitFor({ timeout: 120000 });
    const spent = Date.now() - t0;
    const smp = await samples(page);
    const fetchCounts = smp.counts.filter((c) => c.startsWith('fetch:')).map((c) => c.slice(6));
    const yearCounts = smp.counts.filter((c) => c.startsWith('years:')).map((c) => Number(c.slice(6).split(' van ')[0]));
    console.log(`    phases ${smp.phases.join(' > ')}; fetch ${fetchCounts.join(', ')}; years ${yearCounts.join(',')}; ${spent} ms`);
    check(smp.phases[0] === 'fetch' && smp.phases.includes('years'), 'progress: first the songs are fetched, then the years are checked');
    check(fetchCounts.includes('0 van 120') && fetchCounts.includes('100 van 120'), `fetch progress counts up ("${fetchCounts.join('", "')}")`);
    check(yearCounts.length >= 4 && yearCounts.every((n, i) => i === 0 || n >= yearCounts[i - 1]) && Math.max(...yearCounts) >= 15 && smp.counts.some((c) => /^years:\d+ van 30$/.test(c)), `the year-check progress counts up out of 30 (${yearCounts.join(',')})`);
    check(M.mb.n503 === 1 && Object.values(M.mb.isrc).some((n) => n >= 2), 'MusicBrainz answered 503 once and the app tried that song again');
    check(M.mb.n404 >= 1 && M.mb.search.length >= 1, 'songs MusicBrainz did not know by ISRC were looked up by title and artist');
    await setGap(page, 600000); // freeze the rest of the check; the play screens pause the worker anyway
    const eighties = await bySource(page, 7000001);
    check(!!eighties && eighties.tracks.length === 120 && await activeId(page) === eighties.id, 'Speel direct: the 120 songs are stored and the list is now active');
    check(/Eighties Test/.test(await text(page, 'sheet-title')) && /staat klaar/.test(await text(page, 'sheet-title')), 'the play sheet says "Eighties Test staat klaar"');
    check(/Hoe wil je spelen\?/.test(await page.locator('[data-testid="play-sheet"] .ms-how').textContent()), 'with "Hoe wil je spelen?"');
    const done = await text(page, 'play-done');
    check(/^\d+ nummers nagekeken, de rest komt vanzelf\.$/.test(done) && Number(done.split(' ')[0]) >= 30, `the check is announced in one line ("${done}")`);
    check(await page.getByTestId('play-room').isVisible() && await page.getByTestId('play-timeline').isVisible() && await page.getByTestId('play-bingo').isVisible() && await page.getByTestId('play-list').isVisible() && await page.getByTestId('play-print').isVisible(), 'three ways to play, plus "Bekijk de lijst" and "Kaartjes printen"');
    check(/Speelt met \d+ van 120 nummers; de rest wordt nog nagekeken/.test(await text(page, 'play-ready')), 'the play sheet is honest: only the checked songs play for now');
    await shot(page, 'muziek-05-play-sheet-390');
    check(await noSideScroll(page), 'play sheet: no sideways scrolling at 390 px');
    // year check results of the first 30 songs (the multiples of 4: the worker spreads over the list)
    const st = await bySource(page, 7000001);
    const t = (n) => st.tracks.find((x) => x.n === n);
    check(t(5).yearChecked === true && t(5).year === 1993 && t(5).yearSure === false, `an ISRC MusicBrainz does not know: the search year 1993, checked but not sure (${t(5).year}, sure=${t(5).yearSure})`);
    check(t(13).yearChecked === true && t(13).year === 1979 && t(13).yearSure === true, 'the song that got 503 once ends with its MusicBrainz year 1979');
    const nChecked = st.tracks.filter((x) => x.yearChecked).length;
    check(nChecked >= 30 && nChecked < 120, `${nChecked} of 120 songs are checked, the rest follows in the background`);

    // ---- each way leads to the right screen with this list ----
    await page.getByTestId('play-timeline').click();
    await page.getByTestId('game-deck').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="screen-game"]') || document.querySelector('[data-testid="setup-form"]'));
    const deckLine = await text(page, 'game-deck');
    const cnt = await page.evaluate(async () => {
      const store = await import('./js/playlists.js');
      const deck = await import('./js/deck.js');
      const p = store.get(store.getActiveId());
      return { name: p.name, ...store.deckCounts(p, deck.musicSource()) };
    });
    check(/Eighties Test/.test(deckLine) && deckLine.includes(`${cnt.inDeck} nummers`), `Tijdlijn: the setup names the list and counts its songs ("${deckLine}")`);
    const held = await text(page, 'deck-held');
    check(cnt.held > 0 && held === `Speelt met ${cnt.inDeck} van 120 nummers; de rest wordt nog nagekeken.`, `Tijdlijn: "${held}" matches the deck rule (${cnt.inDeck} in, ${cnt.held} held back)`);
    check(cnt.inDeck >= 30 && cnt.held > 0 && cnt.inDeck + cnt.held <= 120, `the deck rule holds back songs still waiting for their year (${cnt.inDeck} in, ${cnt.held} held, ${120 - cnt.inDeck - cnt.held} without any year yet)`);
    await page.getByTestId('start-game').click();
    await page.getByTestId('handoff').waitFor();
    check(await page.getByTestId('current-player').isVisible(), 'a solo Tijdlijn with this list starts');
    await shot(page, 'muziek-06-tijdlijn-held');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    check(await text(page, 'music-current-name') === 'Eighties Test' && /120 nummers · uit Deezer/.test(await page.getByTestId('music-current').textContent()), 'back at the hub: Nu gekozen shows the list, its count and its source');
    await page.getByTestId('music-play').click();
    await page.getByTestId('play-bingo').click();
    await page.getByTestId('bingo-deck').waitFor();
    check(/Eighties Test/.test(await text(page, 'bingo-deck')) && /Speelt met \d+ van 120 nummers/.test(await text(page, 'deck-held')), 'Bingo: the setup names the same list and shows the same note');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    await page.getByTestId('music-play').click();
    await page.getByTestId('play-room').click();
    await page.getByTestId('screen-room-host').waitFor();
    check(await page.evaluate(() => location.hash) === '#/spelleider', 'Samen spelen leads to the room host screen');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    await page.getByTestId('music-play').click();
    await page.getByTestId('play-print').click();
    await page.waitForFunction((id) => location.hash === `#/print/${id}`, eighties.id);
    check(true, 'Kaartjes printen leads to the print screen of this list');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    await page.getByTestId('music-play').click();
    await page.getByTestId('play-list').click();
    await page.getByTestId('pl-status-line').waitFor();
    check(await page.evaluate(() => location.hash) === `#/playlists/${eighties.id}` && (await page.getByTestId('screen-playlist').getAttribute('data-id')) === eighties.id, 'Bekijk de lijst leads to the edit screen of this list');

    /* ============================ 6a: year correctness (the re-release year) ============================ */
    console.log('# 6 year correctness');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 120);
    const row1 = page.locator('[data-testid="pl-track"][data-n="1"]');
    check(await row1.locator('.pl-title').textContent() === 'Take On Me' && await row1.getByTestId('pl-year').inputValue() === '1984', 'the edit screen shows Take On Me as 1984 (catalogue said 2011, MusicBrainz 1984)');
    const take = (await bySource(page, 7000001)).tracks.find((x) => x.n === 1);
    check(take.year === 1984 && take.yearSure === true && take.yearChecked === true, 'and so does the stored list: 1984, sure and checked');
    check(await page.getByTestId('pl-source').count() === 1 && await page.getByTestId('pl-refresh-source').count() === 1, 'a list with a source has its source line and "Opnieuw ophalen"');

    /* ============================ 5: Speel nu toch ============================ */
    console.log('# 5 Speel nu toch');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    await page.getByTestId('pl-search-input').fill('https://www.deezer.com/en/playlist/7000002');
    await page.getByTestId('sheet-playlist').waitFor();
    await page.waitForFunction(() => /Feestmix/.test(document.querySelector('[data-testid="sheet-title"]')?.textContent || ''));
    M.trackDelayMs = 0;
    await page.getByTestId('sheet-play-now').click();
    await page.locator('[data-testid="sheet-progress"][data-phase="years"]').waitFor();
    check(await page.getByTestId('sheet-play-anyway').isVisible() && /Speel nu toch/.test(await text(page, 'sheet-play-anyway')), 'while the years are checked there is always "Speel nu toch"');
    check(/niet alle jaartallen zijn dan nagekeken; bij oudere nummers kan er het jaar van een heruitgave staan/i.test(await text(page, 'sheet-progress') + ' ' + await page.locator('.ms-honest').textContent()), 'with the honest line about re-release years');
    await shot(page, 'muziek-07-years-progress');
    await page.getByTestId('sheet-play-anyway').click();
    await page.getByTestId('play-sheet').waitFor({ timeout: 60000 });
    const feest = await bySource(page, 7000002);
    check(feest.playNow === true && await activeId(page) === feest.id, 'Speel nu toch: plays at once, the list is active and remembers the choice');
    check(await page.getByTestId('play-honest').isVisible() && /Niet alle jaartallen zijn nagekeken; bij oudere nummers/.test(await text(page, 'play-honest')), 'the play sheet carries the honest line');
    const feestCounts = await page.evaluate(async () => {
      const store = await import('./js/playlists.js');
      const deck = await import('./js/deck.js');
      const p = store.get(store.getActiveId());
      return { ...store.deckCounts(p, deck.musicSource()), checked: p.tracks.filter((t) => t.yearChecked).length };
    });
    check(feestCounts.held === 0 && feestCounts.inDeck >= 30 && feestCounts.inDeck > feestCounts.checked, `the deck contains the unchecked songs too (${feestCounts.inDeck} of ${feestCounts.total} play, only ${feestCounts.checked} checked)`);
    check(/van 60 nummers; niet alle jaartallen zijn al nagekeken/.test(await text(page, 'play-ready')), 'and the readiness line says so');

    /* ============================ 6b: a typed year is never overwritten ============================ */
    await setGap(page, 40);
    await page.reload(); // a fresh MusicBrainz queue (the previous one waits 10 minutes)
    await page.getByTestId('music-current').waitFor();
    await page.evaluate(async () => { (await import('./js/enrich.js')).pause('e2e'); });
    await page.getByTestId('pl-search-input').fill('https://www.deezer.com/nl/playlist/7000003');
    await page.getByTestId('sheet-playlist').waitFor();
    await page.waitForFunction(() => /Klein feest/.test(document.querySelector('[data-testid="sheet-title"]')?.textContent || ''));
    await page.getByTestId('sheet-save').click();
    await page.getByTestId('sheet-saved').waitFor();
    await page.keyboard.press('Escape');
    const klein = await bySource(page, 7000003);
    check(!!klein && klein.tracks.length === 20 && klein.tracks.every((x) => !x.yearChecked), 'a saved list starts unchecked (the background work is paused for this step)');
    await page.goto(`${base}#/playlists/${klein.id}`);
    await page.getByTestId('pl-status-line').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 20);
    const yin = page.locator('[data-testid="pl-track"][data-n="3"] [data-testid="pl-year"]');
    const mbYear = mbRule('T03', 2).isrc; // what MusicBrainz will say for song 3
    await yin.fill('1999');
    await yin.press('Enter');
    await page.waitForFunction(() => /Jaar opgeslagen: 1999/.test(document.getElementById('toast')?.textContent || ''));
    check(mbYear !== 1999, `(MusicBrainz will say ${mbYear} for that song, not the typed 1999)`);
    await page.evaluate(async () => { (await import('./js/enrich.js')).resume('e2e'); });
    await page.waitForFunction((id) => {
      const p = JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists.find((x) => x.id === id);
      return p && p.tracks.every((t) => t.yearChecked || t.yearFixed);
    }, klein.id, { timeout: 60000 });
    const k2 = (await storedLists(page)).find((p) => p.id === klein.id);
    const t3 = k2.tracks.find((x) => x.n === 3);
    check(t3.year === 1999 && t3.yearFixed === true && t3.yearSure === true, 'the background check finished and kept the typed year (1999, yearFixed)');
    check(k2.tracks.filter((x) => x.n !== 3).every((x) => x.year === mbRule('T03', x.n - 1).isrc && x.yearSure === true), 'all other songs got their MusicBrainz year');
    check(await page.locator('[data-testid="pl-track"][data-n="3"] [data-testid="pl-year"]').inputValue() === '1999', 'the edit screen still shows 1999');
    await ctx.close();

    /* ============================ layout at 1280 px ============================ */
    console.log('# layout at 1280 px');
    const dctx = await phoneCtx(browser, M, { w: 1280, h: 800, mobile: false });
    const dp = await newPage(dctx, errors, 'desktop');
    dp.setDefaultTimeout(30000);
    await dp.goto(`${base}#/playlists`);
    await dp.getByTestId('music-current').waitFor();
    check(await noSideScroll(dp), 'hub: no sideways scrolling at 1280 px');
    await shot(dp, 'muziek-08-hub-1280');
    await searchFor(dp, 'top 40');
    await dp.getByTestId('pl-result').first().waitFor();
    check(await noSideScroll(dp), 'results: no sideways scrolling at 1280 px');
    const cols = await dp.getByTestId('pl-result').evaluateAll((els) => new Set(els.slice(0, 12).map((e) => Math.round(e.getBoundingClientRect().left))).size);
    check(cols >= 2, `on a laptop the results sit in a grid (${cols} columns)`);
    await dp.getByTestId('pl-search').scrollIntoViewIfNeeded();
    await shot(dp, 'muziek-09-results-1280');
    await dp.getByTestId('pl-result').first().click();
    await dp.getByTestId('sheet-playlist').waitFor();
    await dp.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length === 12);
    await dp.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
    const box = await dp.locator('.ms-sheet').evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: window.innerWidth, h: window.innerHeight }; });
    check(box.l >= 0 && box.r <= box.w && box.t >= 0 && box.b <= box.h + 1, `the sheet fits inside a 1280x800 window (${Math.round(box.l)}..${Math.round(box.r)} x ${Math.round(box.t)}..${Math.round(box.b)})`);
    check(await noSideScroll(dp), 'sheet: no sideways scrolling at 1280 px');
    await shot(dp, 'muziek-10-sheet-1280');
    await dp.keyboard.press('Escape');
    await dp.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    await dp.getByTestId('music-play').click();
    await dp.getByTestId('play-sheet').waitFor();
    check(await dp.locator('.ms-sheet').evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth) && await noSideScroll(dp), 'play sheet: fits a 1280 px window');
    await shot(dp, 'muziek-11-play-sheet-1280');
    await dctx.close();

    /* ============================ 7: Spotify ============================ */
    console.log('# 7 Spotify');
    const sctx = await phoneCtx(browser, M);
    await installSpotify(sctx, M);
    const sp = await newPage(sctx, errors, 'spotify');
    sp.setDefaultTimeout(30000);
    await sp.goto(base);
    await sp.evaluate(([cid, scope, gap]) => {
      localStorage.setItem('timetunesr.mbGap.v1', String(gap));
      localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid));
      localStorage.setItem('timetunesr.spotify.token.v1', JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600e3, scope, clientId: cid }));
    }, [SP.clientId, SP.playback, 40]);
    await sp.goto(`${base}#/playlists`);
    await sp.reload();
    await sp.getByTestId('sp-connect').waitFor();
    check(/Toon mijn Spotify-playlists/.test(await text(sp, 'sp-connect')) && await sp.getByTestId('sp-list').count() === 0, 'connected without the playlist permission: one button "Toon mijn Spotify-playlists"');
    // now with the playlist permission and Spotify as the music source
    await sp.evaluate(([cid, scope]) => {
      localStorage.setItem('timetunesr.spotify.token.v1', JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600e3, scope, clientId: cid }));
      localStorage.setItem('timetunesr.settings.v1', JSON.stringify({ source: 'spotify', limit: 60 }));
    }, [SP.clientId, `${SP.playback} ${SP.playlistScopes}`]);
    await sp.reload();
    await sp.getByTestId('sp-list').first().waitFor();
    const names = await sp.getByTestId('sp-list').allTextContents();
    check(names.length === 3 && /Mijn feestlijst/.test(names[0]) && /30 nummers/.test(names[0]) && /Samen met Bram/.test(names[1]), `own and shared playlists appear as tiles, somebody else's does not (${names.map((n) => n.replace(/\s+/g, ' ').trim()).join(' | ')})`);
    check(await sp.getByTestId('sp-list').first().locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 'a tile shows the playlist cover');
    check(await sp.getByTestId('playlist-top-create').count() === 1, '"Mijn meest geluisterd" is offered next to the playlists');
    await sp.getByTestId('sp-tip').locator('summary').click();
    check(/Toevoegen aan andere playlist/.test(await text(sp, 'sp-tip')) && /Top 50 Nederland/.test(await text(sp, 'sp-tip')), 'the tip explains how to make somebody else\'s list your own');
    check(await noSideScroll(sp), 'Spotify section: no sideways scrolling at 390 px');
    await sp.locator('.music-spotify').scrollIntoViewIfNeeded();
    await shot(sp, 'muziek-12-spotify-tiles');
    // a list Spotify will not hand over: the friendly message
    await sp.getByTestId('sp-list').nth(2).click();
    await sp.getByTestId('sheet-playlist').waitFor();
    await sp.getByTestId('sheet-error').waitFor();
    check(/zelf hebt gemaakt of waaraan je meewerkt/.test(await text(sp, 'sheet-error')), 'a playlist that is not the user\'s own: the friendly message');
    await shot(sp, 'muziek-13-spotify-not-own');
    await sp.keyboard.press('Escape');
    await sp.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    // import an own list and play it through Spotify
    await sp.getByTestId('sp-list').first().click();
    await sp.getByTestId('sheet-playlist').waitFor();
    await sp.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length === 30);
    check(/Jouw Spotify-playlist/.test(await sp.locator('.ms-sheet .ms-kicker').first().textContent()) && await sp.getByTestId('sheet-listen').count() === 0, 'the Spotify sheet lists the songs (no fragment buttons: they are not catalogue songs)');
    M.spotify.delayMs = 300; // long enough for the progress to be seen
    await startSampler(sp);
    await sp.getByTestId('sheet-play-now').click();
    await sp.getByTestId('play-sheet').waitFor({ timeout: 90000 });
    const ssm = await samples(sp);
    check(ssm.phases[0] === 'fetch' && ssm.phases.includes('years'), `Spotify import shows progress (${ssm.phases.join(' > ')})`);
    const own = await bySource(sp, SP.own);
    check(!!own && own.source.kind === 'spotify' && own.tracks.length === 30 && own.tracks.every((x) => x.spotifyId), 'the Spotify list is imported with its 30 songs');
    check(own.tracks.every((x) => x.yearChecked && x.year >= 1975 && x.year < 2015), 'the years were checked at MusicBrainz (Spotify\'s album year 2015 is replaced)');
    check(await activeId(sp) === own.id, 'and it is the active list');
    check(/Klaar om te spelen via Spotify/.test(await text(sp, 'play-ready')), `playable through Spotify at once ("${await text(sp, 'play-ready')}")`);
    await shot(sp, 'muziek-14-spotify-play-sheet');
    await sctx.close();

    /* ============================ 9: the edit screen with 2000 songs ============================ */
    console.log('# 9 edit screen with 2000 songs');
    for (const [w, mobile] of [[390, true], [1280, false]]) {
      const bctx = await phoneCtx(browser, M, { w, h: 800, mobile });
      await bctx.addInitScript(() => {
        try { localStorage.getItem('x'); } catch { return; } // the sandboxed Deezer frame has no storage
        if (localStorage.getItem('__seeded')) return;
        localStorage.setItem('__seeded', '1');
        localStorage.setItem('timetunesr.mbGap.v1', '600000');
        const names = [['Doe Maar', 'De Bom'], ['a-ha', 'Take On Me'], ['Toto', 'Africa'], ['Queen', 'Bohemian Rhapsody'], ['Racoon', 'Love You More'], ['Kate Bush', 'Running Up That Hill']];
        const tracks = [];
        for (let i = 0; i < 2000; i++) {
          const [artist, title] = names[i % names.length];
          const t = { n: i + 1, itunesId: null, deezerId: 20000001 + i, isrc: `NLA20${String(i + 1).padStart(7, '0')}`, title: i < names.length ? title : `${title} ${Math.floor(i / names.length)}`, artist, album: '', year: 1970 + (i % 50), yearSure: false };
          if (i < 1200) { t.yearChecked = true; t.yearSure = i % 9 !== 0; }
          if (i % 97 === 5) t.year = null;
          tracks.push(t);
        }
        const pl = { id: 'pbig2000', name: 'Alle hits van toen', created: Date.now(), updated: Date.now(), nextN: 2001, tracks, source: { kind: 'deezer', id: '2000', name: 'Alle hits van toen (2000)' } };
        localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [pl] }));
        localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify(pl.id));
      });
      const bp = await newPage(bctx, errors, `big${w}`);
      bp.setDefaultTimeout(30000);
      await bp.goto(`${base}#/playlists`);
      await bp.getByTestId('music-current').waitFor();
      check(await text(bp, 'music-current-name') === 'Alle hits van toen' && /2000 nummers/.test(await bp.getByTestId('music-current').textContent()), `${w}px: the hub shows the 2000-song list as the active one`);
      const t1 = Date.now();
      await bp.goto(`${base}#/playlists/pbig2000`);
      await bp.getByTestId('pl-status-line').waitFor();
      const firstRows = Date.now() - t1;
      await bp.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length >= 100);
      const early = await bp.getByTestId('pl-track').count();
      await bp.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 2000, null, { timeout: 30000 });
      const allRows = Date.now() - t1;
      console.log(`    ${w}px: status header + first rows after ${firstRows} ms (${early} rows when first looked), all 2000 rows after ${allRows} ms`);
      check(firstRows < 5000, `${w}px: the edit screen opens fast (status header after ${firstRows} ms, bound 5000)`);
      check(allRows < 20000, `${w}px: all 2000 rows arrived in slices (after ${allRows} ms, bound 20000)`);
      check(/Speelt met|Klaar|Jaartallen|Te weinig|Deze lijst/.test(await text(bp, 'pl-status-line')) && /Alle hits van toen \(2000\)/.test(await text(bp, 'pl-source')), `${w}px: the status header says how the list plays and where it came from`);
      check(await bp.getByTestId('pl-work-status').count() <= 1 && await bp.locator('.pl-tag:text("fragment")').count() === 0, `${w}px: no "fragment zoeken" tag on any row`);
      check(await noSideScroll(bp), `${w}px: no sideways scrolling with 2000 rows`);
      check(await bp.getByTestId('pl-tracks').evaluate((ol) => ol.scrollWidth <= ol.clientWidth + 1), `${w}px: the list itself does not overflow`);
      await bp.screenshot({ path: `${OUT}/muziek-15-edit-2000-${w}.png`, animations: 'disabled' });
      // the doubt filter
      const label = await text(bp, 'pl-filter-unsure');
      const nDoubt = Number(label.match(/\((\d+)\)/)[1]);
      check(/Toon alleen twijfeljaren/.test(label) && nDoubt > 0 && nDoubt < 2000, `${w}px: "${label}"`);
      await bp.getByTestId('pl-only-check').check();
      await bp.waitForFunction((n) => document.querySelectorAll('[data-testid="pl-track"]').length === n, nDoubt, { timeout: 20000 });
      check(await bp.getByTestId('pl-track').count() === nDoubt, `${w}px: the filter leaves exactly the ${nDoubt} rows with a doubtful or missing year`);
      check(await bp.getByTestId('pl-year-warn').count() === nDoubt, `${w}px: and each of them carries a mark`);
      await bp.getByTestId('pl-only-check').uncheck();
      await bp.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 2000, null, { timeout: 20000 });
      check(true, `${w}px: switching the filter off brings all 2000 rows back`);
      await bctx.close();
    }

    /* ============================ 8: from a room ============================ */
    console.log('# 8 from a room');
    rs = await startRoomServer();
    const H = await phone(browser, rs, { viewport: { width: 390, height: 800 } });
    await installEscapeGuard(H.context, M);
    await installFakeItunes(H.context);
    await installMusic(H.context, M);
    H.page.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin'/.test(e.message)) errors.push(`host: ${e.message}`); });
    H.page.setDefaultTimeout(30000);
    const host = H.page;
    await host.goto(base);
    await setGap(host, 40);
    await host.goto(`${base}#/spelleider`);
    const code = await createRoom(host);
    const P = await phone(browser, rs, { viewport: { width: 390, height: 800 } });
    await installEscapeGuard(P.context, M);
    await installFakeItunes(P.context);
    P.page.on('pageerror', (e) => { if (!/sandboxed and lacks the 'allow-same-origin'/.test(e.message)) errors.push(`player: ${e.message}`); });
    await joinRoom(P.page, base, code, 'Sanne');
    await waitForPlayers(host, 1);
    // the player records whether the "spelleider is even weg" state ever shows
    await P.page.evaluate(() => {
      window.__away = false;
      const look = () => { if (document.querySelector('[data-testid="room-leader-away"], [data-testid="waiting-for-owner"]') || /spelleider is even weg/i.test(document.body.innerText)) window.__away = true; };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
      setInterval(look, 200);
    });
    await host.getByTestId('room-music').waitFor();
    await host.evaluate(() => { window.__ttHost.session.__mark = 'same'; });
    check(/TimeTunesr-deck/.test(await text(host, 'room-music-name')), 'the lobby starts with the built-in deck');
    await host.getByTestId('room-music-other').scrollIntoViewIfNeeded();
    await shot(host, 'muziek-16-lobby-music');
    await host.getByTestId('room-music-other').click();
    await host.getByTestId('music-pick-banner').waitFor();
    check((await text(host, 'music-pick-banner')).includes(`kamer ${code}`) && await host.getByTestId('music-pick-back').isVisible(), `Andere muziek kiezen opens the hub with the banner for room ${code} and "Terug naar de kamer"`);
    check(/Kies/.test(await text(host, 'music-play')), 'in pick mode the main button says "Kies deze"');
    await shot(host, 'muziek-17-pick-banner');
    await host.getByTestId('pl-quick-top-nl').click();
    await host.getByTestId('sheet-playlist').waitFor();
    await host.waitForFunction(() => /Top Netherlands/.test(document.querySelector('[data-testid="sheet-title"]')?.textContent || ''));
    check(/Kies en speel direct/.test(await text(host, 'sheet-play-now')) && new RegExp(`kamer ${code}`).test(await host.locator('.ms-why').textContent()), 'the sheet in pick mode says the list becomes the room\'s music');
    await host.getByTestId('sheet-play-now').click();
    await host.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 90000 });
    check(await host.getByTestId('screen-room-host').getAttribute('data-code') === code, `back in the lobby of the same room ${code}`);
    check(await host.evaluate(() => window.__ttHost.session.__mark) === 'same', 'it is the very same live session (not a new connection)');
    await waitForPlayers(host, 1);
    check(/Top Netherlands/.test(await text(host, 'room-music-name')), `the lobby shows the new list ("${await text(host, 'room-music-name')}")`);
    check(await P.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').count() === 1, 'the joined player is still in the lobby');
    await shot(host, 'muziek-18-lobby-after');
    // a saved list, from the hub's own card
    await host.getByTestId('room-music-other').click();
    await host.locator('[data-testid="deck-pick"][data-deck-id="builtin"]').click();
    await host.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    check(/TimeTunesr-deck/.test(await text(host, 'room-music-name')) && await host.getByTestId('screen-room-host').getAttribute('data-code') === code, 'tapping a saved list in pick mode returns to the lobby with that list');
    // Terug naar de kamer without choosing
    await host.getByTestId('room-music-other').click();
    await host.getByTestId('music-pick-banner').waitFor();
    await host.getByTestId('music-pick-back').click();
    await host.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    check(await host.getByTestId('screen-room-host').getAttribute('data-code') === code && await host.evaluate(() => window.__ttHost.session.__mark) === 'same', '"Terug naar de kamer" without choosing returns to the same live room');
    check(/TimeTunesr-deck/.test(await text(host, 'room-music-name')), 'and the music is unchanged');
    await waitForPlayers(host, 1);
    check(await P.page.evaluate(() => window.__away) === false && await P.page.locator('[data-testid="room-leader-away"]').count() === 0, 'the player was never shown the "spelleider is even weg" state');
    check(await P.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').count() === 1, 'the player is still connected in the lobby at the end');

    /* ============================ 10: errors and escaped requests ============================ */
    console.log('# 10 clean run');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    check(M.escaped.length === 0, `no request reached a real Deezer / MusicBrainz / iTunes / Spotify (${M.escaped.slice(0, 3).join(', ')})`);
    check(M.hits.deezer > 20 && M.hits.musicbrainz > 20 && M.hits.spotify > 3, `the mocks were in use (deezer ${M.hits.deezer}, musicbrainz ${M.hits.musicbrainz}, spotify ${M.hits.spotify}, itunes ${M.hits.itunes})`);
    console.log(`\n${checks} checks passed`);
  } finally {
    await browser.close();
    try { await rs?.stop(); } catch { /* ignore */ }
    web.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
