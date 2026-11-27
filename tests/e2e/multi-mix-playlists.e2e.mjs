// "Mix van de groep" from PUBLIC playlists, without logging in ("Kies een playlist"), through
// the Node room server. Deezer and MusicBrainz are mocked with Playwright routes (JSONP for
// the sandboxed Deezer frame, as in deezer-transport.e2e.mjs; JSON with CORS for MusicBrainz):
// - Anouk (360×740) finds "Jaren 90 Feest" by searching and adds "Hardcore Classics" with a
//   quick pick: two playlists; her phone reads them, checks the years and shares one by one
//   (progress "x van 25 nummers nagekeken en gedeeld"); only songs with a checked year go;
// - Bram pastes a Spotify link (explained), then a deezer.com link; halfway he leaves the room
//   screen and comes back: the playlist, the shared songs and the progress are still there and
//   no song is sent twice;
// - the spelleider's lobby says what helps while the mix is too small, then shows the counts
//   (never a title); she starts Discobingo with the mix: songs of both guests come up, and her
//   phone plays a deezer-only song through the fragment player (a Deezer preview).
import { launch, startServer, assert, OUT } from './helpers.mjs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes, silentWav } from './fake-itunes.mjs';

const SHOTS = process.env.MIX_SHOTS || OUT;
mkdirSync(SHOTS, { recursive: true });
async function shot(page, name, { full = false } = {}) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full, animations: 'disabled' });
}
/** Scroll the mix panel into view and take a phone-sized screenshot of what a guest sees. */
async function panelShot(page, name) {
  await page.evaluate(() => document.querySelector('[data-testid="mix-panel"]')?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(250);
  await shot(page, name);
}

const PHONE = { viewport: { width: 360, height: 740 } };
const WAV = silentWav(3);
const COVER = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250"><rect width="250" height="250" fill="hsl(${hue},70%,45%)"/><text x="125" y="150" font-size="110" text-anchor="middle" fill="#fff">♫</text></svg>`;
const WORDS = ['Polder', 'Duin', 'Gracht', 'Molen', 'Tulp', 'Kade', 'Haven', 'Storm', 'Brug', 'Sluis', 'Dijk', 'Wad', 'Meeuw', 'Anker', 'Toren', 'Plein'];

/** The fake catalogue: three public playlists (id -> songs) and one private list. */
const LISTS = {
  901: { title: 'Jaren 90 Feest', by: 'Feestcommissie', n: 30, hue: 330 },
  902: { title: 'Hardcore Classics', by: 'Gabber Gert', n: 12, hue: 200 },
  903: { title: 'Bram zijn feestlijst', by: 'Bram', n: 20, hue: 40 },
  904: { title: 'Jaren 90 Nederlandstalig', by: 'Radio X', n: 15, hue: 100 },
};
const songs = new Map(); // deezerId -> song
for (const [lid, l] of Object.entries(LISTS)) {
  l.songs = [];
  for (let i = 1; i <= l.n; i++) {
    const id = Number(lid) * 1000 + i;
    const w = WORDS[(i + Number(lid)) % WORDS.length];
    // MusicBrainz: most ISRCs known (original year); every 6th unknown: then a search, which
    // finds every 12th; the others have no checkable year and must not be shared
    const kind = i % 6 !== 0 ? 'isrc' : i % 12 === 0 ? 'search' : 'none';
    const s = { id, list: Number(lid), title: `${w}lied ${lid}-${i}`, artist: `De ${w}s ${lid}`, isrc: `NLDA0${String(id).padStart(7, '0')}`, year: 1965 + ((i * 7 + Number(lid)) % 40), kind };
    l.songs.push(s);
    songs.set(id, s);
  }
}

const jsonp = (cb, data) => `${/^dzcb[0-9a-z]+$/.test(cb) ? cb : 'cb'}(${JSON.stringify(data)})`;
const plItem = (id) => ({ id: Number(id), title: LISTS[id].title, nb_tracks: LISTS[id].n, public: true, picture_medium: `https://cdn-images.dzcdn.net/images/playlist/${id}/250x250-000000-80-0-0.jpg`, user: { name: LISTS[id].by } });
const dzTrack = (s) => ({ id: s.id, readable: true, title: s.title, title_short: s.title, isrc: s.isrc, duration: 200, artist: { name: s.artist }, album: { title: `${s.title} (Best of)` } });

/** Deezer, MusicBrainz and the preview / cover CDNs for one browser context. */
async function fakeCatalogue(ctx, { mbDelay = 0 } = {}) {
  const stats = { search: [], tracksPages: 0, track: [], mb: [], previews: 0 };
  await ctx.route('https://api.deezer.com/**', (route) => {
    const u = new URL(route.request().url());
    const cb = u.searchParams.get('callback') || 'cb';
    const p = u.pathname;
    let data = { error: { type: 'DataException', message: 'no data', code: 800 } };
    if (p === '/search/playlist') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      stats.search.push(q);
      const ids = q.includes('jaren 90') ? ['901', '904'] : q.includes('hardcore') ? ['902'] : [];
      data = { data: ids.map(plItem), total: ids.length };
    } else if (/^\/playlist\/\d+$/.test(p)) {
      const id = p.split('/')[2];
      if (id === '666') data = { error: { type: 'DataException', message: 'no data', code: 800 } }; // private / gone
      else if (LISTS[id]) data = { ...plItem(id), creator: { name: LISTS[id].by } };
    } else if (/^\/playlist\/\d+\/tracks$/.test(p)) {
      const id = p.split('/')[2];
      stats.tracksPages++;
      const index = Number(u.searchParams.get('index')) || 0;
      const limit = Number(u.searchParams.get('limit')) || 25;
      const all = LISTS[id]?.songs || [];
      const page = all.slice(index, index + limit).map(dzTrack);
      data = { data: page, total: all.length, ...(index + limit < all.length ? { next: `https://api.deezer.com/playlist/${id}/tracks?index=${index + limit}` } : {}) };
    } else if (/^\/track\/\d+$/.test(p)) {
      const s = songs.get(Number(p.split('/')[2]));
      stats.track.push(s?.id);
      // the catalogue year is a re-release year (2014): only MusicBrainz knows the original
      if (s) data = { ...dzTrack(s), release_date: '2014-05-02', preview: `https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/${s.id}.mp3?hdnea=exp=1999999999~acl=x` };
    }
    return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: jsonp(cb, data) });
  });
  await ctx.route('https://musicbrainz.org/**', async (route) => {
    const u = new URL(route.request().url());
    if (mbDelay) await new Promise((r) => setTimeout(r, mbDelay));
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (u.pathname.startsWith('/ws/2/isrc/')) {
      const code = u.pathname.split('/').pop();
      stats.mb.push(code);
      const s = [...songs.values()].find((x) => x.isrc === code);
      if (!s || s.kind !== 'isrc') return json(404, { error: 'Not Found' });
      return json(200, { isrc: code, recordings: [{ title: s.title, 'first-release-date': `${s.year}-03-01` }] });
    }
    if (u.pathname === '/ws/2/recording') {
      const q = u.searchParams.get('query') || '';
      stats.mb.push(`search:${q}`);
      const s = [...songs.values()].find((x) => q.includes(`"${x.title}"`));
      if (!s || s.kind !== 'search') return json(200, { recordings: [] });
      return json(200, { recordings: [{ title: s.title, 'first-release-date': `${s.year}-01-01`, 'artist-credit': [{ name: s.artist }] }] });
    }
    return json(404, { error: 'Not Found' });
  });
  await ctx.route('https://cdnt-preview.dzcdn.net/**', (route) => { stats.previews++; return route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }); });
  await ctx.route('https://cdn-images.dzcdn.net/**', (route) => {
    const id = (route.request().url().match(/playlist\/(\d+)\//) || [])[1];
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: COVER(LISTS[id]?.hue ?? 0) });
  });
  return stats;
}

/** A phone with the fake catalogue; records every mix-add it sends (WebSocket frames). */
async function listPhone(browser, rooms, { seed = null, gap = 20, mbDelay = 0, size = PHONE } = {}) {
  const p = await phone(browser, rooms, { seed, ...size });
  await installFakeItunes(p.context);
  p.stats = await fakeCatalogue(p.context, { mbDelay });
  await p.context.addInitScript((g) => {
    try {
      if (localStorage.getItem('timetunesr.e2eInit')) return;
      localStorage.setItem('timetunesr.e2eInit', '1');
      localStorage.setItem('timetunesr.mbGap.v1', String(g)); // MusicBrainz' 1.1 s gap, shortened for the test
    } catch { /* ignore */ }
  }, gap);
  p.sentAdds = [];
  p.page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const t = typeof f.payload === 'string' ? f.payload : '';
    if (!t.includes('"mix-add"')) return;
    try { p.sentAdds.push(...JSON.parse(t).tracks); } catch { /* ignore */ }
  }));
  return p;
}

const counts = async (page) => {
  const el = page.getByTestId('mix-counts');
  return { total: Number(await el.getAttribute('data-total')), preview: Number(await el.getAttribute('data-preview')), contributors: Number(await el.getAttribute('data-contributors')), text: await el.textContent() };
};
const shared = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.mixLists.v1') || 'null')?.shared || []);
const received = (page) => page.evaluate(() => window.__ttRoom?.session?.received || window.__ttHost?.session?.received || []);
async function waitListsDone(page, n, timeout = 40000) {
  await page.locator(`[data-testid="mix-panel"][data-mode="lists"][data-phase="done"] [data-testid="mix-done"][data-mine="${n}"]`).waitFor({ timeout });
}
/** No guest's song in any message to this phone unless it may know it (played already). */
async function assertNoLeak(page, titles, allowed, label) {
  const text = JSON.stringify(await received(page));
  const bad = [...titles].filter((t) => !allowed.has(t) && text.includes(JSON.stringify(t)));
  if (bad.length) throw new Error(`${label}: songs of others in a message before they were played: ${bad.slice(0, 5).join(', ')}`);
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const base = server.url;
  const browser = await launch();
  const pages = [];
  try {
    // ---------- the room: spelleider Ilse (does not play), guests Anouk and Bram ----------
    const host = await listPhone(browser, rooms, { seed: 11 });
    const H = host.page;
    pages.push(H);
    await H.goto(`${base}#/spelleider`);
    const code = await createRoom(H);
    const anouk = await listPhone(browser, rooms);
    const bram = await listPhone(browser, rooms, { gap: 120, mbDelay: 60 }); // slower: time to leave halfway
    const A = anouk.page;
    const B = bram.page;
    pages.push(A, B);
    await joinRoom(A, base, code, 'Anouk', { via: 'link' });
    await joinRoom(B, base, code, 'Bram', { via: 'link' });
    await waitForPlayers(H, 2);
    assert(await H.getByTestId('room-game-disco').isChecked(), 'the room starts on Discobingo');
    await H.getByTestId('mix-help').waitFor();
    const help = await H.getByTestId('mix-help').textContent();
    assert(/Nog 25 nummers nodig voor Discobingo/.test(help) && /Laat iedereen een playlist kiezen/.test(help), `the spelleider's lobby says what helps: "${help.trim()}"`);
    await shot(H, 'mixpl-01-host-lobby-help', { full: true });

    // ---------- Anouk: "Kies een playlist", search by name ----------
    await A.getByTestId('mix-lists-open').waitFor();
    await panelShot(A, 'mixpl-02-player-lobby');
    await A.getByTestId('mix-lists-open').click();
    await A.getByTestId('mix-lists-picker').waitFor();
    assert(/de anderen zien de nummers pas als ze gespeeld worden/.test(await A.getByTestId('mix-lists-consent').textContent()), 'one line of consent in the picker');
    assert(await A.locator('[data-testid^="mix-lists-quick-"]').count() === 16, 'the quick picks (Top Nederland, Top 40, Hardcore, Jaren 90 …)');
    await panelShot(A, 'mixpl-03-player-picker');
    await A.getByTestId('mix-lists-q').fill('jaren 90');
    await A.getByTestId('mix-lists-search').click();
    await A.locator('[data-testid="mix-lists-result"]').first().waitFor();
    const resultsText = await A.getByTestId('mix-lists-results').textContent();
    assert(/Jaren 90 Feest/.test(resultsText) && /30 nummers/.test(resultsText) && /Feestcommissie/.test(resultsText), 'results with title, count and maker');
    const cover = A.locator('[data-testid="mix-lists-result"] img').first();
    assert(await cover.getAttribute('loading') === 'lazy' && await cover.getAttribute('referrerpolicy') === 'no-referrer', 'covers: lazy, no referrer');
    await A.waitForFunction(() => [...document.querySelectorAll('[data-testid="mix-lists-result"] img')].every((i) => i.complete && i.naturalWidth > 0));
    await panelShot(A, 'mixpl-04-player-results');
    await A.locator('[data-testid="mix-lists-result"][data-id="901"]').click();
    await A.locator('[data-testid="mix-panel"][data-mode="lists"][data-view="home"]').waitFor();
    await A.locator('[data-testid="mix-lists-item"][data-id="901"]').waitFor();
    await A.getByTestId('mix-lists-progress').waitFor({ timeout: 10000 });
    await A.locator('[data-testid="mix-lists-progress"][data-phase="checking"]').waitFor({ timeout: 10000 });
    await panelShot(A, 'mixpl-05-player-progress');
    await H.waitForFunction(() => Number(document.querySelector('[data-testid="mix-counts"]')?.dataset.total) > 0, null, { timeout: 20000 });
    assert(true, 'the first songs reach the room while Anouk\'s phone is still checking the rest');
    // a second playlist: a quick pick
    await A.getByTestId('mix-lists-add').click();
    await A.getByTestId('mix-lists-quick-hardcore').click();
    await A.locator('[data-testid="mix-lists-result"][data-id="902"]').click();
    await A.locator('[data-testid="mix-lists-item"][data-id="902"]').waitFor();
    await waitListsDone(A, 25);
    const sharedA = await shared(A);
    assert(sharedA.length === 25, `Anouk shares 25 songs (${sharedA.length})`);
    const fromA = (lid) => sharedA.filter((t) => songs.get(t.deezerId).list === lid).length;
    assert(fromA(902) >= 9 && fromA(901) >= 12, `spread over her two playlists (Jaren 90: ${fromA(901)}, Hardcore: ${fromA(902)} of its 11 checkable)`);
    assert(sharedA.every((t) => songs.get(t.deezerId).kind !== 'none'), 'only songs with a checked year are shared');
    assert(sharedA.every((t) => t.year === songs.get(t.deezerId).year), 'the original year (MusicBrainz), not the re-release year 2014');
    assert(sharedA.filter((t) => songs.get(t.deezerId).kind === 'isrc').every((t) => t.yearSure) && sharedA.filter((t) => songs.get(t.deezerId).kind === 'search').every((t) => !t.yearSure), 'ISRC: sure; found by search: not sure');
    assert(new Set(sharedA.map((t) => t.deezerId)).size === 25 && sharedA.some((t) => t.deezerId % 1000 > 15 && songs.get(t.deezerId).list === 901), 'a random part (not the first songs of the list), no duplicates');
    await panelShot(A, 'mixpl-06-player-done');

    // ---------- Bram: a Spotify link is explained; a Deezer link works ----------
    await B.getByTestId('mix-lists-open').click();
    await B.getByTestId('mix-lists-link').fill('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc');
    await B.getByTestId('mix-lists-add-link').click();
    await B.locator('[data-testid="mix-lists-link-msg"][data-kind="spotify"]').waitFor();
    const msg = await B.getByTestId('mix-lists-link-msg').textContent();
    assert(msg === 'Spotify laat apps andermans playlists niet lezen. Zoek de lijst hierboven op naam of plak een Deezer-link.', `a pasted Spotify link: "${msg}"`);
    await B.evaluate(() => document.querySelector('[data-testid="mix-lists-link"]').scrollIntoView({ block: 'center' }));
    await shot(B, 'mixpl-07-player-spotify-link');
    await B.getByTestId('mix-lists-link').fill('https://www.deezer.com/nl/playlist/666');
    await B.getByTestId('mix-lists-add-link').click();
    await B.locator('[data-testid="mix-lists-link-msg"][data-kind="private"]').waitFor();
    assert(true, 'a private or deleted playlist: explained');
    await B.getByTestId('mix-lists-link').fill('https://www.deezer.com/nl/playlist/903?utm_source=deezer');
    await B.getByTestId('mix-lists-add-link').click();
    await B.locator('[data-testid="mix-lists-item"][data-id="903"]').waitFor();
    await B.locator('[data-testid="mix-lists-progress"][data-phase="checking"]').waitFor({ timeout: 10000 });
    await B.waitForFunction(() => (JSON.parse(localStorage.getItem('timetunesr.mixLists.v1') || 'null')?.shared?.length || 0) >= 4, null, { timeout: 20000 });

    // ---------- Bram leaves the room screen halfway and comes back ----------
    const before = await shared(B);
    const bramId = await B.evaluate(() => window.__ttRoom.session.playerId);
    await B.goto(`${base}#/`);
    await B.getByTestId('start-join').waitFor();
    await B.waitForTimeout(800);
    await B.goto(`${base}#/kamer/${code}`);
    await B.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
    assert(await B.evaluate(() => window.__ttRoom.session.playerId) === bramId, 'back in the room on the same place');
    await B.locator('[data-testid="mix-lists-item"][data-id="903"]').waitFor();
    assert(true, 'his playlist is still chosen');
    await waitListsDone(B, 18);
    const sharedB = await shared(B);
    assert(before.every((t) => sharedB.some((x) => x.deezerId === t.deezerId)), `what he shared before leaving (${before.length}) is still his part`);
    assert(sharedB.length === 18, `Bram shares the 18 checkable songs of his 20-song list (${sharedB.length})`);
    const sentIds = bram.sentAdds.map((t) => t.deezerId);
    assert(sentIds.length === 18 && new Set(sentIds).size === 18, `no song was sent twice (${sentIds.length} sent, ${new Set(sentIds).size} different)`);
    assert(bram.sentAdds.every((t) => t.checked === true && !t.spotifyId && t.deezerId && t.isrc), 'mix-add: deezerId + isrc + checked, no Spotify id');
    await panelShot(B, 'mixpl-08-player-back-done');

    // ---------- the spelleider: counts only, never a title ----------
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '2', null, { timeout: 20000 });
    const c = await counts(H);
    assert(c.total === 43 && c.preview === 43, `the lobby counts ${c.total} songs of 2 players, all playable as fragments (${c.text})`);
    assert(await H.getByTestId('mix-help').count() === 0, 'enough songs: the help line is gone');
    const titlesA = new Set(sharedA.map((t) => t.title));
    const titlesB = new Set(sharedB.map((t) => t.title));
    const all = new Set([...titlesA, ...titlesB]);
    await assertNoLeak(H, all, new Set(), 'spelleider (lobby)');
    await assertNoLeak(A, titlesB, new Set(), 'Anouk (lobby)');
    await assertNoLeak(B, titlesA, new Set(), 'Bram (lobby)');
    const html = await H.evaluate(() => document.documentElement.outerHTML);
    assert(![...all].some((t) => html.includes(t)), 'no title of a guest on the spelleider\'s screen');
    assert(true, 'lobby: counts only, no title in any message or on any other screen');

    // ---------- Discobingo with the mix ----------
    await H.getByTestId('room-music-mix').check();
    await H.getByTestId('room-mix-ok').waitFor();
    await shot(H, 'mixpl-09-host-mix-chosen', { full: true });
    await H.getByTestId('room-start').click();
    const seenBy = new Set();
    const played = new Set();
    let deezerPlayed = 0;
    for (let round = 1; round <= 14 && !(seenBy.has('Anouk') && seenBy.has('Bram') && round > 3); round++) {
      await H.locator('[data-testid="screen-room-host"][data-view="answering"]').waitFor({ timeout: 20000 });
      await A.waitForFunction((r) => window.__ttRoom.session.view?.game?.round === r, round, { timeout: 20000 });
      const { song } = await serverHost(H);
      assert(song && songs.has(song.deezerId) && songs.get(song.deezerId).title === song.title, `round ${round}: "${song?.title}" comes from a guest's playlist`);
      assert(!song.spotifyId && !song.itunesId && !song.previewUrl, `round ${round}: a deezer-only song (no Apple, no Spotify id)`);
      for (const b of song.by || []) seenBy.add(b);
      await assertNoLeak(A, titlesB, played, `Anouk, round ${round}`);
      await assertNoLeak(B, titlesA, played, `Bram, round ${round}`);
      await assertNoLeak(H, all, new Set([...played, song.title]), `spelleider, round ${round}`);
      // the spelleider's phone plays the song through the fragment player: a fresh Deezer preview
      await H.waitForFunction((id) => {
        const el = document.getElementById('player');
        return el && el.src.includes(`/${id}.mp3`) && el.src.startsWith('https://cdnt-preview.dzcdn.net/');
      }, song.deezerId, { timeout: 15000 });
      await H.waitForFunction(() => !document.getElementById('player').paused, null, { timeout: 15000 });
      deezerPlayed++;
      if (round === 1) { await shot(H, 'mixpl-10-host-playing'); await shot(A, 'mixpl-11-player-round'); }
      played.add(song.title);
      await H.getByTestId('room-reveal').click();
      await H.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor({ timeout: 20000 });
      await H.getByTestId('room-next').click();
      await H.waitForFunction((r) => (window.__ttHost.session.room?.game?.round || 0) > r || window.__ttHost.session.room?.phase === 'won', round, { timeout: 20000 });
    }
    assert(seenBy.has('Anouk') && seenBy.has('Bram'), `songs of both guests were played (${[...seenBy].join(', ')})`);
    assert(deezerPlayed >= 3 && host.stats.previews >= 3, `the spelleider's phone played ${deezerPlayed} deezer-only songs as fragments (Deezer previews)`);
    assert(anouk.stats.previews === 0 && bram.stats.previews === 0, 'the guests\' phones play nothing');

    // during the game nothing is checked; the panel is folded away and read-only
    await A.evaluate(() => window.scrollTo(0, 0));
    assert(await A.locator('[data-testid="mix-lists-remove"]').count() === 0 && await A.locator('[data-testid="mix-lists-open"]').count() === 0, 'during a game: no choosing or removing playlists');

    // ---------- withdraw, and choose again ----------
    await H.evaluate(() => window.__ttHost.session.toLobby());
    await B.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
    await B.getByTestId('mix-withdraw').click();
    await B.getByTestId('mix-lists-open').waitFor();
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '1', null, { timeout: 20000 });
    assert(await B.evaluate(() => localStorage.getItem('timetunesr.mixLists.v1')) === null, 'Bram withdraws: out of the room and off his phone');
    await B.getByTestId('mix-lists-open').click();
    await B.getByTestId('mix-lists-quick-hardcore').click();
    await B.locator('[data-testid="mix-lists-result"][data-id="902"]').click();
    await waitListsDone(B, 11);
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '2', null, { timeout: 20000 });
    const c2 = await counts(H);
    assert(c2.total === 25, `he chose again (Hardcore Classics, also on Anouk's list): duplicates count once (${c2.text})`);

    // Playwright's own serviceWorkers: 'block' probe fails inside the sandboxed Deezer frame (see deezer-transport.e2e.mjs)
    const errs = pages.flatMap((p) => p.errors).filter((e) => !/Service worker is disabled because the context is sandboxed/.test(e));
    assert(!errs.length, `no page errors (${errs.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
