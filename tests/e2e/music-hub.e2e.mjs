// The "Muziek kiezen" hub (#/playlists) and its flows, all against mocks: a fake Spotify Web API
// (fake-spotify.mjs: the user's own playlists with covers and songs with ISRCs), MusicBrainz
// (years) and iTunes (fake-itunes.mjs). Nothing reaches a real service: a catch-all route
// (registered first, so it only sees what no mock answered) records and aborts every request
// to musicbrainz.org / itunes.apple.com / api.spotify.com, and a Deezer guard (fake-itunes.mjs)
// records and aborts any request to a Deezer host; the suite asserts both lists stayed empty.
// (v3-11 removed the playlist search in the Deezer catalogue: the hub has no search section.)
//
//  1  hub basics: sections (and no search section any more), active list + Speel, saved lists
//     (tap = active), "Zelf maken", the Spotify playlists as cover tiles
//  2  the sheet of a Spotify playlist: title / count / songs, Esc + focus, Bewaar / Bijwerken,
//     a list Spotify will not hand over
//  3  Speel direct: fetch + year-check progress (503 once, ISRC 404 -> search), the list becomes
//     active, the play sheet and its three ways, "Speelt met N van M nummers"
//  4  year correctness: Spotify's album year 2011 replaced by the MusicBrainz year 1984
//  5  Speel nu toch
//  6  a typed year is never overwritten
//  7  a list a v3-10 Deezer import left in localStorage: an ordinary saved list, no crash
//  8  layout at 1280 px
//  9  the edit screen with 2000 songs (speed, status header, filter, slices, no sideways scroll)
// 10  from a room: Andere muziek kiezen / banner / back with the room and the player intact
// 11  no page errors, no request escaped the mocks, no Deezer request
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, OUT } from './helpers.mjs';
import { installFakeItunes, guardDeezer } from './fake-itunes.mjs';
import { installFakeSpotify, spTrack, spotifyLogin, SP_PLAYBACK } from './fake-spotify.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers } from './multi-helpers.mjs';

const MB_GAP = 150; // ms between MusicBrainz requests while the progress is observed
const REAL_HOSTS = new Set(['musicbrainz.org', 'itunes.apple.com', 'api.spotify.com', 'accounts.spotify.com']);
const pad7 = (n) => String(n).padStart(7, '0');
const pid = (s) => s.replace(/[^0-9A-Za-z]/g, '').padEnd(22, 'x').slice(0, 22);

/* ------------------------------------------------------------------------------------------
   The fake services
   ------------------------------------------------------------------------------------------ */

const L = {
  eighties: { id: pid('1EightiesTest'), name: 'Eighties Test', code: 'A01', n: 120 },
  feest: { id: pid('2Feestmix'), name: 'Feestmix', code: 'B02', n: 60 },
  klein: { id: pid('3KleinFeest'), name: 'Klein feest', code: 'T03', n: 20 },
  bewaar: { id: pid('4BewaarMij'), name: 'Bewaar mij', code: 'S10', n: 12 },
  bram: { id: pid('5SamenMetBram'), name: 'Samen met Bram', code: 'C04', n: 8, owner: 'bram', collaborative: true },
  locked: { id: pid('6TopFiftyNederland'), name: 'Top 50 Nederland', code: 'L06', n: 50, forbidden: true, cover: false },
  foreign: { id: pid('7VanIemandAnders'), name: 'Van iemand anders', code: 'F07', n: 9, owner: 'spotify' },
};

function songOf(code, k) {
  if (code === 'A01' && k === 0) return { title: 'Take On Me', artist: 'a-ha' };
  return { title: `Song ${code}-${k + 1}`, artist: `Artiest ${k % 7}` };
}
/** The year Spotify gives (the album the song sits on: mostly a later re-release). */
function spotifyYear(code, k) {
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
      if (j % 5 === 2) return { isrc: 2001 }; // later than Spotify's 1990: ours stays
      return { isrc: 1980 + (k % 10) };
    }
  }
  return { isrc: 1975 + (k % 30) };
}
const isrcOf = (code, k) => `NL${code}${pad7(k + 1)}`;

function spotifyLists() {
  const out = {};
  for (const l of Object.values(L)) {
    out[l.id] = {
      name: l.name, owner: l.owner, collaborative: l.collaborative, forbidden: l.forbidden, cover: l.cover,
      tracks: Array.from({ length: l.n }, (_, k) => spTrack({ id: `${l.code}T${String(k).padStart(5, '0')}`, ...songOf(l.code, k), date: `${spotifyYear(l.code, k)}-03-01`, isrc: isrcOf(l.code, k) })),
    };
  }
  return out;
}

export function newMocks() {
  return {
    escaped: [], // requests no mock answered (must stay empty)
    deezer: [], // requests to a Deezer host (must stay empty)
    hits: { musicbrainz: 0, itunes: 0, spotify: 0 },
    mb: { isrc: {}, fired503: new Set(), n503: 0, search: [], n404: 0 },
    spotify: [],
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
    if (h === 'musicbrainz.org') M.hits.musicbrainz++;
    else if (h === 'itunes.apple.com') M.hits.itunes++;
    else if (h === 'api.spotify.com') M.hits.spotify++;
  });
}

async function installMusicBrainz(ctx, M) {
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
      return json(200, { recordings: [{ title: 'x', 'first-release-date': `${rule.isrc}-04-01` }] });
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
const tile = (page, l) => page.locator(`[data-testid="sp-list"][data-id="${l.id}"]`);

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

async function newPage(ctx, errors, label) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return page;
}

/** A context with all mocks; Spotify logged in (with the playlist permission) and the music source. */
async function musicCtx(browser, M, { w = 390, h = 800, mobile = true, source = 'spotify', scope } = {}) {
  const ctx = mobile
    ? await phoneContext(browser, { viewport: { width: w, height: h } })
    : await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'nl-NL', serviceWorkers: 'block' });
  await wireMocks(ctx, M);
  await spotifyLogin(ctx, { source, ...(scope ? { scope } : {}) });
  return ctx;
}
async function wireMocks(ctx, M, { fixture = true } = {}) {
  await installEscapeGuard(ctx, M);
  if (fixture) await useFixtureDeck(ctx);
  await installFakeItunes(ctx);
  await guardDeezer(ctx, M); // the Deezer guard of every context reports into M.deezer
  await installMusicBrainz(ctx, M);
  const sp = await installFakeSpotify(ctx, spotifyLists());
  M.spotify.push(sp);
  return sp;
}

/* ------------------------------------------------------------------------------------------ */

export default async function run() {
  const web = await startServer(8100 + Math.floor(Math.random() * 400));
  const base = web.url;
  const browser = await launch();
  const M = newMocks();
  const errors = [];
  let rs = null;
  // besides the route guards (M.deezer), the main page records every Deezer host it even tries
  const deezerSeen = [];
  try {
    /* ============================ 1 + 2: hub, sheet (phone) ============================ */
    const ctx = await musicCtx(browser, M);
    const page = await newPage(ctx, errors, 'phone');
    page.on('request', (r) => { if (/deezer|dzcdn/i.test(new URL(r.url()).hostname)) deezerSeen.push(r.url()); });
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
    for (const [id, what] of [['sp-lists', 'Van Spotify'], ['sp-tip', 'the Spotify tip'], ['deck-list', 'Bewaard'], ['playlist-new-form', 'Zelf maken'], ['playlist-import-file', 'Back-up terugzetten']]) {
      check(await page.getByTestId(id).count() === 1, `section / element present: ${what}`);
    }
    check(await page.locator('[data-testid="pl-search"], [data-testid="pl-search-input"], [data-testid="pl-search-note"], [data-testid^="pl-quick-"], [data-testid="pl-result"]').count() === 0, 'no playlist search, no quick picks, no catalogue note any more');
    check(!/Deezer|catalogus/i.test(await page.locator('[data-testid="screen-playlists"]').innerText()), 'the hub does not mention Deezer or a catalogue');
    // the Spotify playlists as cover tiles (own and shared; somebody else's not)
    await tile(page, L.eighties).waitFor();
    const names = (await page.getByTestId('sp-list').allTextContents()).map((n) => n.replace(/\s+/g, ' ').trim());
    check(names.length === 6 && names.some((n) => /Samen met Bram/.test(n)) && !names.some((n) => /Van iemand anders/.test(n)), `own and shared playlists appear as tiles, somebody else's does not (${names.join(' | ')})`);
    check(/120 nummers/.test(await tile(page, L.eighties).textContent()), 'a tile says how many songs');
    check(await tile(page, L.eighties).locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 'a tile shows the playlist cover');
    check(await page.getByTestId('playlist-top-create').count() === 1, '"Mijn meest geluisterd" is offered next to the playlists');
    await page.getByTestId('sp-tip').locator('summary').click();
    check(/Toevoegen aan andere playlist/.test(await text(page, 'sp-tip')) && /Top 50 Nederland/.test(await text(page, 'sp-tip')) && !/catalogus/.test(await text(page, 'sp-tip')), 'the tip explains how to make somebody else\'s list your own');
    await page.getByTestId('sp-tip').locator('summary').click();
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

    console.log('# 2 the sheet');
    await tile(page, L.bewaar).click();
    await page.getByTestId('sheet-playlist').waitFor();
    check(await page.getByTestId('sheet-title').textContent() === 'Bewaar mij' && /12 nummers/.test(await text(page, 'sheet-count')), 'the sheet: title and number of songs');
    check(/Jouw Spotify-playlist/.test(await page.locator('.ms-sheet .ms-kicker').first().textContent()), 'the sheet says it is the user\'s Spotify playlist');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length === 12);
    check(/Song S10-1/.test(await page.getByTestId('sheet-track').first().textContent()) && /Artiest 0/.test(await page.getByTestId('sheet-track').first().textContent()), 'the first songs are listed with title and artist');
    check(await page.locator('[data-testid="sheet-listen"]').count() === 0, 'no fragment buttons in the sheet');
    check(await page.locator('.ms-sheet').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; }) && await noSideScroll(page), 'the sheet fits the screen width');
    await shot(page, 'muziek-04-sheet-390');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    check(await page.evaluate((id) => document.activeElement?.dataset.testid === 'sp-list' && document.activeElement.dataset.id === id, L.bewaar.id), 'Esc closes the sheet and the focus returns to the tile that opened it');
    // Bewaar: saved, not active
    await tile(page, L.bewaar).click();
    await page.getByTestId('sheet-playlist').waitFor();
    check(/Bewaar/.test(await text(page, 'sheet-save')) && await page.getByTestId('sheet-existing').count() === 0, 'a new list offers "Bewaar"');
    await page.getByTestId('sheet-save').click();
    await page.getByTestId('sheet-saved').waitFor();
    check(/Bewaard: “Bewaar mij” \(12 nummers\)/.test(await text(page, 'sheet-saved')), 'Bewaar says it was saved');
    const saved = await bySource(page, L.bewaar.id);
    check(!!saved && saved.tracks.length === 12 && saved.source.kind === 'spotify' && saved.tracks.every((t) => t.spotifyId && t.isrc && !('deezerId' in t)), 'the list is stored with its Spotify source and 12 songs (Spotify id + ISRC)');
    check(await activeId(page) === 'builtin', 'Bewaar does not make the list active');
    check(/Spotify/.test(await page.locator('[data-testid="deck-pick"]').filter({ hasText: 'Bewaar mij' }).textContent()), 'it shows under Bewaard with a Spotify mark');
    check(await page.getByTestId('sheet-save').evaluate((b) => /Bijwerken/.test(b.textContent)) && await page.getByTestId('sheet-existing').count() === 1, 'the sheet now offers "Bijwerken" and says it is already saved');
    await page.getByTestId('sheet-save').click();
    await page.waitForFunction(() => /Bijgewerkt/.test(document.querySelector('[data-testid="sheet-saved"]')?.textContent || ''));
    check(/Bijgewerkt: “Bewaar mij” had alle nummers al/.test(await text(page, 'sheet-saved')), 'saving the same list again says it was updated');
    check((await storedLists(page)).filter((p) => p.source?.id === L.bewaar.id).length === 1, 'and does not make a second copy');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    check(/bewaard/.test(await tile(page, L.bewaar).textContent()), 'the tile is marked "bewaard"');
    // a list Spotify will not hand over: the friendly message
    await tile(page, L.locked).click();
    await page.getByTestId('sheet-error').waitFor();
    check(/zelf hebt gemaakt of waaraan je meewerkt/.test(await text(page, 'sheet-error')), 'a playlist that is not the user\'s own: the friendly message');
    await page.keyboard.press('Escape');
    await page.getByTestId('sheet-playlist').waitFor({ state: 'detached' });

    /* ============================ 3: Speel direct ============================ */
    console.log('# 3 Speel direct');
    M.spotify.at(-1).delayMs = 250; // long enough for the fetch progress to be seen
    await tile(page, L.eighties).click();
    await page.getByTestId('sheet-playlist').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length === 30);
    check(/120 nummers/.test(await text(page, 'sheet-count')) && /… en nog 90 nummers/.test(await page.locator('.ms-rest').textContent()), 'the sheet previews 30 songs and says how many more');
    await startSampler(page);
    const t0 = Date.now();
    await page.getByTestId('sheet-play-now').click();
    await page.getByTestId('sheet-progress').waitFor();
    await page.getByTestId('play-sheet').waitFor({ timeout: 120000 });
    M.spotify.at(-1).delayMs = 0;
    const spent = Date.now() - t0;
    const smp = await samples(page);
    const fetchCounts = smp.counts.filter((c) => c.startsWith('fetch:')).map((c) => c.slice(6));
    const yearCounts = smp.counts.filter((c) => c.startsWith('years:')).map((c) => Number(c.slice(6).split(' van ')[0]));
    console.log(`    phases ${smp.phases.join(' > ')}; fetch ${fetchCounts.join(', ')}; years ${yearCounts.join(',')}; ${spent} ms`);
    check(smp.phases[0] === 'fetch' && smp.phases.includes('years'), 'progress: first the songs are fetched, then the years are checked');
    check(fetchCounts.some((c) => / van 120$/.test(c)), `fetch progress counts out of 120 ("${fetchCounts.join('", "')}")`);
    check(yearCounts.length >= 4 && yearCounts.every((n, i) => i === 0 || n >= yearCounts[i - 1]) && Math.max(...yearCounts) >= 15 && smp.counts.some((c) => /^years:\d+ van 30$/.test(c)), `the year-check progress counts up out of 30 (${yearCounts.join(',')})`);
    check(M.mb.n503 === 1 && Object.values(M.mb.isrc).some((n) => n >= 2), 'MusicBrainz answered 503 once and the app tried that song again');
    check(M.mb.n404 >= 1 && M.mb.search.length >= 1, 'songs MusicBrainz did not know by ISRC were looked up by title and artist');
    await setGap(page, 600000); // freeze the rest of the check; the play screens pause the worker anyway
    const eighties = await bySource(page, L.eighties.id);
    check(!!eighties && eighties.tracks.length === 120 && await activeId(page) === eighties.id, 'Speel direct: the 120 songs are stored and the list is now active');
    check(/Eighties Test/.test(await text(page, 'sheet-title')) && /staat klaar/.test(await text(page, 'sheet-title')), 'the play sheet says "Eighties Test staat klaar"');
    check(/Hoe wil je spelen\?/.test(await page.locator('[data-testid="play-sheet"] .ms-how').textContent()), 'with "Hoe wil je spelen?"');
    const done = await text(page, 'play-done');
    check(/^\d+ nummers nagekeken, de rest komt vanzelf\.$/.test(done) && Number(done.split(' ')[0]) >= 30, `the check is announced in one line ("${done}")`);
    check(await page.getByTestId('play-room').isVisible() && await page.getByTestId('play-timeline').isVisible() && await page.getByTestId('play-bingo').isVisible() && await page.getByTestId('play-list').isVisible() && await page.getByTestId('play-print').isVisible(), 'three ways to play, plus "Bekijk de lijst" and "Kaartjes printen"');
    check(/Speelt met \d+ van 120 nummers; van \d+ andere wordt het jaartal nog nagekeken/.test(await text(page, 'play-ready')), `the play sheet is honest: only the checked songs play for now ("${await text(page, 'play-ready')}")`);
    await shot(page, 'muziek-05-play-sheet-390');
    check(await noSideScroll(page), 'play sheet: no sideways scrolling at 390 px');
    const st = await bySource(page, L.eighties.id);
    const t = (n) => st.tracks.find((x) => x.n === n);
    check(t(5).yearChecked === true && t(5).year === 1993 && t(5).yearSure === false, `an ISRC MusicBrainz does not know: the search year 1993, checked but not sure (${t(5).year}, sure=${t(5).yearSure})`);
    check(t(13).yearChecked === true && t(13).year === 1979 && t(13).yearSure === true, 'the song that got 503 once ends with its MusicBrainz year 1979');
    const nChecked = st.tracks.filter((x) => x.yearChecked).length;
    check(nChecked >= 30 && nChecked < 120, `${nChecked} of 120 songs are checked, the rest follows in the background`);

    // ---- each way leads to the right screen with this list ----
    await page.getByTestId('play-timeline').click();
    await page.getByTestId('game-deck').waitFor();
    const deckLine = await text(page, 'game-deck');
    const cnt = await page.evaluate(async () => {
      const store = await import('./js/playlists.js');
      const deck = await import('./js/deck.js');
      const p = store.get(store.getActiveId());
      return { name: p.name, source: deck.musicSource(), ...store.deckCounts(p, deck.musicSource()) };
    });
    check(cnt.source === 'spotify', 'the music source is Spotify');
    check(/Eighties Test/.test(deckLine) && deckLine.includes(`${cnt.inDeck} nummers`), `Tijdlijn: the setup names the list and counts its songs ("${deckLine}")`);
    const held = await text(page, 'deck-held');
    check(cnt.held > 0 && held === `Speelt met ${cnt.inDeck} van 120 nummers; van ${cnt.held + cnt.noYear} andere wordt het jaartal nog ${cnt.noYear ? 'opgezocht of nagekeken' : 'nagekeken'}.`, `Tijdlijn: "${held}" matches the deck rule (${cnt.inDeck} in, ${cnt.held} held back)`);
    check(cnt.inDeck >= 30 && cnt.held > 0 && cnt.inDeck + cnt.held === 120, `the deck rule holds back songs still waiting for their year (${cnt.inDeck} in, ${cnt.held} held)`);
    await shot(page, 'muziek-06-tijdlijn-held');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    check(await text(page, 'music-current-name') === 'Eighties Test' && /120 nummers · uit Spotify/.test(await page.getByTestId('music-current').textContent()), 'back at the hub: Nu gekozen shows the list, its count and its source');
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

    /* ============================ 4: year correctness ============================ */
    console.log('# 4 year correctness');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 120);
    const row1 = page.locator('[data-testid="pl-track"][data-n="1"]');
    check(await row1.locator('.pl-title').textContent() === 'Take On Me' && await row1.getByTestId('pl-year').inputValue() === '1984', 'the edit screen shows Take On Me as 1984 (Spotify\'s album said 2011, MusicBrainz 1984)');
    const take = (await bySource(page, L.eighties.id)).tracks.find((x) => x.n === 1);
    check(take.year === 1984 && take.yearSure === true && take.yearChecked === true, 'and so does the stored list: 1984, sure and checked');
    check(await page.getByTestId('pl-source').count() === 1 && /uit Spotify/.test(await text(page, 'pl-source')) && await page.getByTestId('pl-refresh-source').count() === 1, 'a Spotify list has its source line and "Opnieuw ophalen"');

    /* ============================ 5: Speel nu toch ============================ */
    console.log('# 5 Speel nu toch');
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('music-current').waitFor();
    await tile(page, L.feest).click();
    await page.getByTestId('sheet-playlist').waitFor();
    await page.getByTestId('sheet-play-now').click();
    await page.locator('[data-testid="sheet-progress"][data-phase="years"]').waitFor();
    check(await page.getByTestId('sheet-play-anyway').isVisible() && /Speel nu toch/.test(await text(page, 'sheet-play-anyway')), 'while the years are checked there is always "Speel nu toch"');
    check(/niet alle jaartallen zijn dan nagekeken; bij oudere nummers kan er het jaar van een heruitgave staan/i.test(`${await text(page, 'sheet-progress')} ${await page.locator('.ms-honest').textContent()}`), 'with the honest line about re-release years');
    await shot(page, 'muziek-07-years-progress');
    await page.getByTestId('sheet-play-anyway').click();
    await page.getByTestId('play-sheet').waitFor({ timeout: 60000 });
    const feest = await bySource(page, L.feest.id);
    check(feest.playNow === true && await activeId(page) === feest.id, 'Speel nu toch: plays at once, the list is active and remembers the choice');
    check(await page.getByTestId('play-honest').isVisible() && /Niet alle jaartallen zijn nagekeken; bij oudere nummers/.test(await text(page, 'play-honest')), 'the play sheet carries the honest line');
    const feestCounts = await page.evaluate(async () => {
      const store = await import('./js/playlists.js');
      const deck = await import('./js/deck.js');
      const p = store.get(store.getActiveId());
      return { ...store.deckCounts(p, deck.musicSource()), checked: p.tracks.filter((x) => x.yearChecked).length };
    });
    check(feestCounts.held === 0 && feestCounts.inDeck === 60 && feestCounts.inDeck > feestCounts.checked, `the deck contains the unchecked songs too (${feestCounts.inDeck} of ${feestCounts.total} play, only ${feestCounts.checked} checked)`);
    check(/van 60 nummers; niet alle jaartallen zijn al nagekeken/.test(await text(page, 'play-ready')), 'and the readiness line says so');

    /* ============================ 6: a typed year is never overwritten ============================ */
    console.log('# 6 a typed year');
    await setGap(page, 40);
    await page.reload(); // a fresh MusicBrainz queue (the previous one waits 10 minutes)
    await page.getByTestId('music-current').waitFor();
    await page.evaluate(async () => { (await import('./js/enrich.js')).pause('e2e'); });
    await tile(page, L.klein).click();
    await page.getByTestId('sheet-playlist').waitFor();
    await page.getByTestId('sheet-save').click();
    await page.getByTestId('sheet-saved').waitFor();
    await page.keyboard.press('Escape');
    const klein = await bySource(page, L.klein.id);
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
      return p && p.tracks.every((x) => x.yearChecked || x.yearFixed);
    }, klein.id, { timeout: 60000 });
    const k2 = (await storedLists(page)).find((p) => p.id === klein.id);
    const t3 = k2.tracks.find((x) => x.n === 3);
    check(t3.year === 1999 && t3.yearFixed === true && t3.yearSure === true, 'the background check finished and kept the typed year (1999, yearFixed)');
    check(k2.tracks.filter((x) => x.n !== 3).every((x) => x.year === mbRule('T03', x.n - 1).isrc && x.yearSure === true), 'all other songs got their MusicBrainz year');
    check(await page.locator('[data-testid="pl-track"][data-n="3"] [data-testid="pl-year"]').inputValue() === '1999', 'the edit screen still shows 1999');
    await ctx.close();

    /* ============================ 7: a list a v3-10 Deezer import left ============================ */
    console.log('# 7 data of v3-10 (a Deezer import)');
    const vctx = await musicCtx(browser, M, { source: null });
    await vctx.addInitScript(() => {
      try { localStorage.getItem('x'); } catch { return; }
      if (localStorage.getItem('__seededV310')) return;
      localStorage.setItem('__seededV310', '1');
      localStorage.setItem('timetunesr.mbGap.v1', '600000');
      const tracks = [
        { n: 1, itunesId: null, title: 'Dancing Queen', artist: 'ABBA', album: 'Gold', year: 2011, yearSure: false, deezerId: 3135556, isrc: 'SEAYD7601020' },
        { n: 2, itunesId: null, title: 'Take On Me', artist: 'a-ha', album: '', year: 1984, yearSure: true, deezerId: 664107, isrc: 'NOAHA8500001', yearChecked: true, match: 'none' },
        { n: 3, itunesId: 7100000005, title: 'Bohemian Rhapsody', artist: 'Queen', album: '', year: 1975, yearSure: true, deezerId: 9997018, yearChecked: true },
        { n: 4, itunesId: null, title: 'Obscuur', artist: 'Lokale Band', album: '', year: 1999, yearSure: false, deezerId: 12345, yearChecked: true, match: 'none' },
        { n: 5, itunesId: null, title: '', artist: '', album: '', year: 1990, yearSure: true, deezerId: 333 },
      ];
      const pl = { id: 'pdz310', name: 'Top Nederland', created: Date.now(), updated: Date.now(), nextN: 6, tracks, source: { kind: 'deezer', id: '1266971851', name: 'Top Netherlands' } };
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [pl] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify(pl.id));
    });
    const vp = await newPage(vctx, errors, 'v3-10');
    vp.setDefaultTimeout(30000);
    await vp.goto(`${base}#/playlists`);
    await vp.getByTestId('music-current').waitFor();
    check(await text(vp, 'music-current-name') === 'Top Nederland' && /4 nummers · eigen playlist/.test(await vp.getByTestId('music-current').textContent()), `the list loads as an ordinary list of its own, still active ("${(await vp.getByTestId('music-current').textContent()).replace(/\s+/g, ' ').trim()}")`);
    check(/eigen playlist/.test(await vp.locator('[data-testid="deck-pick"][data-deck-id="pdz310"]').textContent()) && !/Deezer/i.test(await vp.locator('[data-testid="screen-playlists"]').innerText()), 'under Bewaard: "eigen playlist", no Deezer mark');
    check(/speelt via Spotify/.test(await text(vp, 'music-current-ready')), `with fragments only 1 song can play: the line says it plays through Spotify ("${await text(vp, 'music-current-ready')}")`);
    await vp.goto(`${base}#/playlists/pdz310`);
    await vp.getByTestId('pl-status-line').waitFor();
    await vp.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 4);
    check(await vp.getByTestId('pl-refresh-source').count() === 0 && await vp.getByTestId('pl-source').count() === 0, 'no "Opnieuw ophalen" and no source line for it');
    // (a song the Apple Music match is still looking for, match 'pending', is not counted yet)
    const spOnly = (await storedLists(vp)).find((p) => p.id === 'pdz310').tracks.filter((x) => !x.itunesId && x.match !== 'pending').length;
    check(spOnly >= 2 && new RegExp(`^${spOnly} nummers spelen alleen via Spotify$`).test(await text(vp, 'pl-spotify-only')), `the songs without an Apple Music id are counted as "alleen via Spotify" ("${await text(vp, 'pl-spotify-only')}", ${spOnly} stored)`);
    await vp.locator('[data-testid="pl-track"][data-n="1"] [data-testid="pl-year"]').fill('1976');
    await vp.locator('[data-testid="pl-track"][data-n="1"] [data-testid="pl-year"]').press('Enter');
    await vp.waitForFunction(() => /Jaar opgeslagen: 1976/.test(document.getElementById('toast')?.textContent || ''));
    const v = (await storedLists(vp)).find((p) => p.id === 'pdz310');
    check(v.tracks.length === 4 && !v.source && v.tracks[0].year === 1976 && v.tracks[0].deezerId === 3135556, 'a change is stored: no source any more, the songs keep their (unused) deezerId');
    await shot(vp, 'muziek-08-v310-list');
    await vctx.close();

    /* ============================ 8: layout at 1280 px ============================ */
    console.log('# 8 layout at 1280 px');
    const dctx = await musicCtx(browser, M, { w: 1280, h: 800, mobile: false });
    const dp = await newPage(dctx, errors, 'desktop');
    dp.setDefaultTimeout(30000);
    await dp.goto(`${base}#/playlists`);
    await dp.getByTestId('music-current').waitFor();
    await tile(dp, L.eighties).waitFor();
    check(await noSideScroll(dp), 'hub: no sideways scrolling at 1280 px');
    const cols = await dp.getByTestId('sp-list').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
    const rows = await dp.getByTestId('sp-list').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    check(cols >= 3 && rows >= 2, `on a laptop the Spotify covers sit in a grid (${cols} columns, ${rows} rows), not a sideways row`);
    const spBox = await dp.locator('.music-spotify').boundingBox();
    const savedBox = await dp.locator('.music-saved').boundingBox();
    check(spBox.x < savedBox.x && spBox.width > savedBox.width, 'two columns: the Spotify covers on the left (wider), Bewaard on the right');
    await shot(dp, 'muziek-09-hub-1280');
    await tile(dp, L.bewaar).click();
    await dp.getByTestId('sheet-playlist').waitFor();
    await dp.waitForFunction(() => document.querySelectorAll('[data-testid="sheet-track"]').length === 12);
    await dp.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
    const box = await dp.locator('.ms-sheet').evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: window.innerWidth, h: window.innerHeight }; });
    check(box.l >= 0 && box.r <= box.w && box.t >= 0 && box.b <= box.h + 1, `the sheet fits inside a 1280x800 window (${Math.round(box.l)}..${Math.round(box.r)} x ${Math.round(box.t)}..${Math.round(box.b)})`);
    await shot(dp, 'muziek-10-sheet-1280');
    await dp.keyboard.press('Escape');
    await dp.getByTestId('sheet-playlist').waitFor({ state: 'detached' });
    await dp.getByTestId('music-play').click();
    await dp.getByTestId('play-sheet').waitFor();
    check(await dp.locator('.ms-sheet').evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth) && await noSideScroll(dp), 'play sheet: fits a 1280 px window');
    await shot(dp, 'muziek-11-play-sheet-1280');
    await dctx.close();

    // connected for playback only: one button asks for the playlist permission
    const pctx = await musicCtx(browser, M, { scope: SP_PLAYBACK, source: null });
    const pp = await newPage(pctx, errors, 'scope');
    await pp.goto(`${base}#/playlists`);
    await pp.getByTestId('sp-connect').waitFor();
    check(/Toon mijn Spotify-playlists/.test(await text(pp, 'sp-connect')) && await pp.getByTestId('sp-list').count() === 0 && await pp.getByTestId('playlist-top-create').count() === 1, 'connected without the playlist permission: one button "Toon mijn Spotify-playlists" (and Mijn meest geluisterd)');
    await pctx.close();

    /* ============================ 9: the edit screen with 2000 songs ============================ */
    console.log('# 9 edit screen with 2000 songs');
    for (const [w, mobile] of [[390, true], [1280, false]]) {
      const bctx = await musicCtx(browser, M, { w, h: 800, mobile, source: null });
      await bctx.addInitScript((srcId) => {
        try { localStorage.getItem('x'); } catch { return; }
        if (localStorage.getItem('__seeded')) return;
        localStorage.setItem('__seeded', '1');
        localStorage.setItem('timetunesr.mbGap.v1', '600000');
        const names = [['Doe Maar', 'De Bom'], ['a-ha', 'Take On Me'], ['Toto', 'Africa'], ['Queen', 'Bohemian Rhapsody'], ['Racoon', 'Love You More'], ['Kate Bush', 'Running Up That Hill']];
        const tracks = [];
        for (let i = 0; i < 2000; i++) {
          const [artist, title] = names[i % names.length];
          const t = { n: i + 1, itunesId: null, spotifyId: `BIG${String(i).padStart(5, '0')}`.padEnd(22, 'x'), isrc: `NLA20${String(i + 1).padStart(7, '0')}`, title: i < names.length ? title : `${title} ${Math.floor(i / names.length)}`, artist, album: '', year: 1970 + (i % 50), yearSure: false };
          if (i < 1200) { t.yearChecked = true; t.yearSure = i % 9 !== 0; }
          if (i % 97 === 5) t.year = null;
          tracks.push(t);
        }
        const pl = { id: 'pbig2000', name: 'Alle hits van toen', created: Date.now(), updated: Date.now(), nextN: 2001, tracks, source: { kind: 'spotify', id: srcId, name: 'Alle hits van toen (2000)' } };
        localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [pl] }));
        localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify(pl.id));
      }, pid('9AlleHitsVanToen'));
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

    /* ============================ 10: from a room ============================ */
    console.log('# 10 from a room');
    rs = await startRoomServer();
    const H = await phone(browser, rs, { viewport: { width: 390, height: 800 } });
    await wireMocks(H.context, M, { fixture: false });
    await spotifyLogin(H.context, { source: 'spotify' });
    H.page.on('pageerror', (e) => errors.push(`host: ${e.message}`));
    H.page.setDefaultTimeout(30000);
    const host = H.page;
    await host.goto(base);
    await setGap(host, 40);
    await host.goto(`${base}#/spelleider`);
    const code = await createRoom(host);
    const P = await phone(browser, rs, { viewport: { width: 390, height: 800 } });
    await installEscapeGuard(P.context, M);
    await installFakeItunes(P.context);
    await guardDeezer(P.context, M);
    P.page.on('pageerror', (e) => errors.push(`player: ${e.message}`));
    await joinRoom(P.page, base, code, 'Sanne');
    await waitForPlayers(host, 1);
    await P.page.evaluate(() => {
      window.__away = false;
      const look = () => { if (document.querySelector('[data-testid="room-leader-away"], [data-testid="waiting-for-owner"]') || /spelleider is even weg/i.test(document.body.innerText)) window.__away = true; };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
      setInterval(look, 200);
    });
    await host.getByTestId('room-music').waitFor();
    await host.evaluate(() => { window.__ttHost.session.__mark = 'same'; });
    check(/TimeTunesr-deck/.test(await text(host, 'room-music-name')), 'the lobby starts with the built-in deck');
    // the group mix offers the guests' own Spotify playlists again (multi-links: "Kies uit mijn playlists")
    check(/Kies uit mijn playlists/.test(await host.getByTestId('mix-lists-open').textContent()), 'the lobby offers "Kies uit mijn playlists" for the group mix (own Spotify playlists, no catalogue search)');
    await host.getByTestId('room-music-other').scrollIntoViewIfNeeded();
    await shot(host, 'muziek-16-lobby-music');
    await host.getByTestId('room-music-other').click();
    await host.getByTestId('music-pick-banner').waitFor();
    check((await text(host, 'music-pick-banner')).includes(`kamer ${code}`) && await host.getByTestId('music-pick-back').isVisible(), `Andere muziek kiezen opens the hub with the banner for room ${code} and "Terug naar de kamer"`);
    check(/Kies/.test(await text(host, 'music-play')), 'in pick mode the main button says "Kies deze"');
    await shot(host, 'muziek-17-pick-banner');
    await tile(host, L.bram).click();
    await host.getByTestId('sheet-playlist').waitFor();
    check(/Kies en speel direct/.test(await text(host, 'sheet-play-now')) && new RegExp(`kamer ${code}`).test(await host.locator('.ms-why').textContent()), 'the sheet in pick mode says the list becomes the room\'s music');
    await host.getByTestId('sheet-play-now').click();
    await host.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 90000 });
    check(await host.getByTestId('screen-room-host').getAttribute('data-code') === code, `back in the lobby of the same room ${code}`);
    check(await host.evaluate(() => window.__ttHost.session.__mark) === 'same', 'it is the very same live session (not a new connection)');
    await waitForPlayers(host, 1);
    check(/Samen met Bram/.test(await text(host, 'room-music-name')), `the lobby shows the new list ("${await text(host, 'room-music-name')}")`);
    check(await P.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').count() === 1, 'the joined player is still in the lobby');
    await shot(host, 'muziek-18-lobby-after');
    await host.getByTestId('room-music-other').click();
    await host.locator('[data-testid="deck-pick"][data-deck-id="builtin"]').click();
    await host.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    check(/TimeTunesr-deck/.test(await text(host, 'room-music-name')) && await host.getByTestId('screen-room-host').getAttribute('data-code') === code, 'tapping a saved list in pick mode returns to the lobby with that list');
    await host.getByTestId('room-music-other').click();
    await host.getByTestId('music-pick-banner').waitFor();
    await host.getByTestId('music-pick-back').click();
    await host.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    check(await host.getByTestId('screen-room-host').getAttribute('data-code') === code && await host.evaluate(() => window.__ttHost.session.__mark) === 'same', '"Terug naar de kamer" without choosing returns to the same live room');
    check(/TimeTunesr-deck/.test(await text(host, 'room-music-name')), 'and the music is unchanged');
    await waitForPlayers(host, 1);
    check(await P.page.evaluate(() => window.__away) === false && await P.page.locator('[data-testid="room-leader-away"]').count() === 0, 'the player was never shown the "spelleider is even weg" state');
    check(await P.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').count() === 1, 'the player is still connected in the lobby at the end');

    /* ============================ 11: errors and escaped requests ============================ */
    console.log('# 11 clean run');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    check(M.escaped.length === 0, `no request reached a real MusicBrainz / iTunes / Spotify (${M.escaped.slice(0, 3).join(', ')})`);
    check(M.deezer.length === 0 && deezerSeen.length === 0, `the app never asked a Deezer host anything (${[...M.deezer, ...deezerSeen].slice(0, 3).join(', ')})`);
    check(M.hits.musicbrainz > 20 && M.hits.spotify > 10, `the mocks were in use (musicbrainz ${M.hits.musicbrainz}, spotify ${M.hits.spotify}, itunes ${M.hits.itunes})`);
    console.log(`\n${checks} checks passed`);
  } finally {
    await browser.close();
    try { await rs?.stop(); } catch { /* ignore */ }
    web.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
