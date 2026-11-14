// Through the room server: with an own playlist active, the spelleider's app sends that
// playlist to the server at the start, and every song of the game comes from it.
import { startServer, launch, assert } from './helpers.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';

const TRACKS = [
  [6800311742, 'Dancing Queen', 'ABBA', 1976], [1440763833, 'Gold Digger', 'Kanye West', 2005],
  [1308586364, 'Back for Good', 'Take That', 1995], [1322068804, 'Mambo No. 5 (A Little Bit Of...)', 'Lou Bega', 1999],
  [268284600, '...Baby One More Time', 'Britney Spears', 1998], [1440741632, 'In the Summertime', 'Mungo Jerry', 1970],
].map(([itunesId, title, artist, year], i) => ({ n: i + 1, itunesId, title, artist, year }));

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const browser = await launch();
  try {
    const host = await phone(browser, rooms, { seed: 7 });
    await host.context.addInitScript((tracks) => {
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'demo', name: 'Feestje', tracks }] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('demo'));
    }, TRACKS);
    await host.page.goto(server.url + '#/spelleider');
    const code = await createRoom(host.page);
    const a = await phone(browser, rooms);
    await joinRoom(a.page, server.url, code, 'Anouk', { via: 'code' });
    await waitForPlayers(host.page, 1);
    await host.page.getByTestId('room-game-timeline').click();
    await host.page.getByTestId('room-start').click();
    const ids = new Set(TRACKS.map((t) => t.itunesId));
    const titles = new Set(TRACKS.map((t) => t.title));
    for (let round = 1; round <= 3; round++) {
      await host.page.locator('[data-testid="screen-room-host"][data-view="answering"]').waitFor();
      await a.page.waitForFunction((r) => window.__ttRoom.session.view?.game?.round === r, round);
      const { song } = await serverHost(host.page);
      assert(ids.has(song.itunesId) && titles.has(song.title), `round ${round}: "${song.title}" comes from the own playlist`);
      const v = await a.page.evaluate(() => window.__ttRoom.session.view);
      assert(v.game.mine.timeline.every((c) => titles.has(c.title)), `round ${round}: the player's timeline holds only playlist songs`);
      await host.page.getByTestId('room-reveal').click();
      await host.page.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
      await host.page.getByTestId('room-next').click();
    }
    assert(host.page.errors.length === 0 && a.page.errors.length === 0, `no page errors (${[...host.page.errors, ...a.page.errors].join('|')})`);
  } finally {
    await browser.close(); server.stop(); await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
