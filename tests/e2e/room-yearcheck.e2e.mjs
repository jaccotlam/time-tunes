// The year check goes on in the room LOBBY. The spelleider makes a room, picks a Deezer list
// through "Andere muziek kiezen" (the hub: search, the sheet, "Kies en speel direct"), comes
// back to the lobby with only part of the songs checked, and while the room waits the
// background worker (enrich.js) keeps checking: the lobby's "Speelt met N van M nummers" grows
// live, the game starts with the songs checked up to that moment (and their CHECKED years),
// and during the round the worker waits again. Deezer and MusicBrainz are mocked (as in
// deezer-transport.e2e.mjs); MusicBrainz answers only as many songs as the test allows, so
// every step is deterministic.
import { launch, startServer, assert } from './helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers } from './multi-helpers.mjs';

const N = 60; // songs in the Deezer list (more than FUN_MIN = 30, so unchecked ones are held back)
const LIST_ID = 908622995;
const dzId = (i) => 3100000 + i;
const isrcOf = (i) => `NLB01${String(9000000 + i).padStart(7, '0')}`;
const mbYear = (i) => 1950 + i; // the checked (first release) year
const DZ_YEAR = 2015; // what Deezer says: the remaster

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const browser = await launch();
  try {
    const host = await phone(browser, rooms, { seed: 11 });
    await installFakeItunes(host.context);
    await host.context.addInitScript(() => { localStorage.setItem('timetunesr.mbGap.v1', '0'); });

    // Deezer: one search result, its songs, a year per song (the remaster's)
    await host.context.route('https://api.deezer.com/**', (route) => {
      const u = new URL(route.request().url());
      const cb = u.searchParams.get('callback');
      let data;
      if (u.pathname === '/search/playlist') {
        data = { data: [{ id: LIST_ID, title: 'Feest Classics', nb_tracks: N, public: true, user: { name: 'Deezer' } }], total: 1 };
      } else if (u.pathname === `/playlist/${LIST_ID}`) {
        data = { id: LIST_ID, title: 'Feest Classics', nb_tracks: N, creator: { name: 'Deezer' } };
      } else if (u.pathname === `/playlist/${LIST_ID}/tracks`) {
        data = { data: Array.from({ length: N }, (_, i) => ({ id: dzId(i), readable: true, title: `Klassieker ${i}`, title_short: `Klassieker ${i}`, isrc: isrcOf(i), artist: { name: `Band ${i}` }, album: { title: 'Remastered' } })), total: N };
      } else {
        const m = u.pathname.match(/^\/track\/(\d+)$/);
        const i = m ? Number(m[1]) - 3100000 : -1;
        data = i >= 0 && i < N
          ? { id: dzId(i), readable: true, title: `Klassieker ${i}`, title_short: `Klassieker ${i}`, isrc: isrcOf(i), release_date: `${DZ_YEAR}-01-01`, preview: `https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/${i}.mp3?hdnea=exp=1999999999~acl=x`, artist: { name: `Band ${i}` }, album: { title: 'Remastered' } }
          : { error: { code: 800, message: 'no data' } };
      }
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: `${cb}(${JSON.stringify(data)})` });
    });

    // MusicBrainz: answers only `allow` songs; later requests wait until the test allows more
    let allow = 0;
    let answered = 0;
    const held = [];
    const mbAsked = [];
    const answer = (route, isrc) => {
      const i = Number(isrc.slice(5)) - 9000000;
      answered++;
      const body = i >= 0 && i < N ? { recordings: [{ 'first-release-date': `${mbYear(i)}-05-01` }] } : { error: 'Not Found' };
      return route.fulfill({ status: i >= 0 && i < N ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) }).catch(() => {});
    };
    const release = () => { while (held.length && answered < allow) { const h = held.shift(); answer(h.route, h.isrc); } };
    await host.context.route('https://musicbrainz.org/**', (route) => {
      const u = new URL(route.request().url());
      const isrc = u.pathname.startsWith('/ws/2/isrc/') ? u.pathname.split('/').pop() : '';
      mbAsked.push({ isrc, at: Date.now() });
      if (!isrc) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"recordings":[]}' });
      if (answered < allow) return answer(route, isrc);
      held.push({ route, isrc });
      return undefined;
    });
    const allowUpTo = (n) => { allow = n; release(); };

    // what the spelleider's phone sends at the start
    const starts = [];
    host.page.on('websocket', (ws) => ws.on('framesent', (f) => {
      try { const m = JSON.parse(f.payload); if (m && m.t === 'start') starts.push(m); } catch { /* ping */ }
    }));

    await host.page.goto(`${server.url}#/spelleider`);
    const code = await createRoom(host.page);
    const a = await phone(browser, rooms);
    await joinRoom(a.page, server.url, code, 'Anouk');
    await waitForPlayers(host.page, 1);
    await host.page.getByTestId('room-game-timeline').click();

    // "Andere muziek kiezen" -> the hub -> search -> the sheet -> "Kies en speel direct"
    allowUpTo(34);
    await host.page.getByTestId('room-music-other').click();
    await host.page.getByTestId('screen-playlists').waitFor();
    await host.page.getByTestId('music-pick-banner').waitFor();
    await host.page.getByTestId('pl-search-input').fill('feest classics');
    await host.page.getByTestId('pl-search-go').click();
    await host.page.getByTestId('pl-result').first().click();
    await host.page.getByTestId('sheet-play-now').click();
    // the waiting moment ends at 30 checked years; then the phone is back in the room
    await host.page.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 60000 });
    const inDeck = async () => {
      const t = await host.page.getByTestId('deck-held').textContent().catch(() => '');
      const m = String(t).match(/Speelt met (\d+) van (\d+) nummers/);
      return m ? { n: Number(m[1]), of: Number(m[2]) } : null;
    };
    await host.page.waitForFunction(() => /Speelt met \d+ van 60/.test(document.querySelector('[data-testid="deck-held"]')?.textContent || ''), null, { timeout: 30000 });
    // all songs have their Deezer year now: what is in the deck is exactly what MusicBrainz answered
    await host.page.waitForFunction(() => /Speelt met 34 van 60/.test(document.querySelector('[data-testid="deck-held"]')?.textContent || ''), null, { timeout: 30000 });
    const first = await inDeck();
    assert(first.n === 34 && first.of === N, `back in the lobby: "Speelt met ${first.n} van ${first.of}"`);
    assert(!(await host.page.evaluate(() => window.__tt.enrich.isPaused())), 'the year check is not paused in the lobby');
    assert(/34 nummers/.test(await host.page.getByTestId('room-music-name').textContent()), 'the music line counts 34 songs');

    // while the room waits, more years get checked: the lobby's count grows live
    allowUpTo(41);
    await host.page.waitForFunction(() => /Speelt met 41 van 60/.test(document.querySelector('[data-testid="deck-held"]')?.textContent || ''), null, { timeout: 30000 });
    allowUpTo(47);
    await host.page.waitForFunction(() => /Speelt met 47 van 60/.test(document.querySelector('[data-testid="deck-held"]')?.textContent || ''), null, { timeout: 30000 });
    assert(/47 nummers/.test(await host.page.getByTestId('room-music-name').textContent()), 'the count in the lobby grew from 34 to 41 to 47 while the room waited');

    // start: the game gets the 47 checked songs, with their checked years
    await host.page.getByTestId('room-start').click();
    await host.page.locator('[data-testid="screen-room-host"][data-view="answering"]').waitFor();
    assert(starts.length === 1, `one start message (${starts.length})`);
    const sent = starts[0].cards;
    const idx = (c) => Number(c.title.replace('Klassieker ', ''));
    assert(sent.length === 47, `the start sends the 47 checked songs (${sent.length})`);
    assert(sent.every((c) => Number(c.year) === mbYear(idx(c))), 'every song plays with its checked (MusicBrainz) year, not Deezer\'s remaster year');
    const song = await host.page.evaluate(() => window.__ttHost.session.currentSong());
    assert(song && Number(song.year) === mbYear(idx(song)) && sent.some((c) => c.title === song.title), `the first song is one of them ("${song?.title}", ${song?.year})`);

    // during the round the worker waits: no MusicBrainz request while a round is in progress
    assert(await host.page.evaluate(() => window.__tt.enrich.isPaused()), 'the year check pauses during a round');
    const askedAtStart = mbAsked.length;
    allowUpTo(Infinity); // (a request the pause stopped is asked again later)
    await host.page.waitForTimeout(1500);
    assert(mbAsked.length === askedAtStart, `no new year checks during the round (${mbAsked.length - askedAtStart} asked)`);
    const during = await host.page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.playlists.v1')).lists[0].tracks.filter((t) => t.yearChecked).length);
    assert(during === 47, `the checked songs stay at 47 during the round (${during})`);

    // the winner screen / back in the lobby: the check goes on, the next game has them all
    await host.page.getByTestId('room-reveal').click();
    await host.page.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
    assert(await host.page.evaluate(() => window.__tt.enrich.isPaused()), 'still paused while the round is revealed');
    await host.page.evaluate(() => window.__ttHost.session.toLobby());
    await host.page.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    await host.page.waitForFunction(() => !document.querySelector('[data-testid="deck-held"]') && /60 nummers/.test(document.querySelector('[data-testid="room-music-name"]')?.textContent || ''), null, { timeout: 30000 });
    assert(true, 'back in the lobby the rest is checked: all 60 songs play, the note is gone');

    // a player's phone keeps pausing the worker (as before)
    assert(await a.page.evaluate(() => window.__tt.enrich.isPaused()), "a player's phone pauses the background work on the room screen");
    assert(host.page.errors.length === 0 && a.page.errors.length === 0, `no page errors (${[...host.page.errors, ...a.page.errors].join(' | ')})`);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
