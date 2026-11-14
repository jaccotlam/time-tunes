// Samen spelen draws its songs from the ACTIVE deck: with an own playlist active,
// a room only ever plays songs from that playlist.
import { startServer, launch, assert } from './helpers.mjs';
import { startSignal, phone, createRoom, joinRoom, waitForPlayers, hostRoom } from './multi-helpers.mjs';

const TRACKS = [
  [6800311742, 'Dancing Queen', 'ABBA', 1976], [1440763833, 'Gold Digger', 'Kanye West', 2005],
  [1308586364, 'Back for Good', 'Take That', 1995], [1322068804, 'Mambo No. 5 (A Little Bit Of...)', 'Lou Bega', 1999],
  [268284600, '...Baby One More Time', 'Britney Spears', 1998], [1440741632, 'In the Summertime', 'Mungo Jerry', 1970],
].map(([itunesId, title, artist, year], i) => ({ n: i + 1, itunesId, title, artist, year }));

export default async function run() {
  const signal = await startSignal();
  const server = await startServer();
  const browser = await launch();
  try {
    const host = await phone(browser, signal, { seed: 7 });
    await host.context.addInitScript((tracks) => {
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'demo', name: 'Feestje', tracks }] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('demo'));
    }, TRACKS);
    await host.page.goto(server.url + '#/spelleider');
    const code = await createRoom(host.page, { hostPlays: false });
    const a = await phone(browser, signal);
    await joinRoom(a.page, server.url, code, 'Anouk', { via: 'code' });
    await waitForPlayers(host.page, 1);
    await host.page.getByTestId('room-game-bingo').click();
    await host.page.getByTestId('room-size-3').click();
    await host.page.getByTestId('room-start').click();
    await host.page.locator('[data-testid="screen-room-host"][data-view="answering"]').waitFor();
    const room = await hostRoom(host.page);
    const songs = Object.values(room.game.songs);
    const ids = new Set(TRACKS.map((t) => t.itunesId));
    assert(songs.length > 0 && songs.length <= TRACKS.length, `room has ${songs.length} songs from the playlist`);
    assert(songs.every((s) => ids.has(s.itunesId)), 'every song in the room comes from the own playlist');
    assert(host.page.errors.length === 0 && a.page.errors.length === 0, `no page errors (${[...host.page.errors, ...a.page.errors].join('|')})`);
  } finally {
    await browser.close(); server.stop(); await signal.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
