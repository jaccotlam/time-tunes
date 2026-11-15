// The Quiz through the Node room server: a spelleider who plays along (with an own playlist
// as the music) and three players, each in their own browser context at 390 px, plus a
// fourth who joins halfway. A whole quiz of 10 questions with year, artist and title
// questions: fast / slow / wrong / no answer give the expected points, a question where
// nobody taps closes by the server's timer, a player reloads in the middle of a question
// (same question, the remaining time, his answer still there), nothing about the right
// answer reaches a phone before the reveal, podium at the end. The spelleider's screen is
// also shown at 1280×720 (laptop / tv). Last: the PeerJS route says the quiz needs the server.
import { join } from 'node:path';
import { launch, startServer, assert, OUT } from './helpers.mjs';
import { startRoomServer, startSignal, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';
import { QUIZ_BASE, QUIZ_SPEED } from '../../app/js/multi/quiz.js';

const THINK = 15;
const TRACKS = [
  ['Zomeravond', 'De Dijkmannen', 1971], ['Regenjas', 'Polderpop', 1975], ['Havenlicht', 'Kadegeluid', 1979], ['Molenwiek', 'Wieken & Co', 1983],
  ['Duinpad', 'Strandtent', 1986], ['Stormvloed', 'Hoogwater', 1989], ['Tulpenveld', 'Bollenstreek', 1992], ['Grachtengordel', 'Amsterdamse Jongens', 1995],
  ['Fietsbel', 'Tweewielers', 1998], ['Brugwachter', 'Sluiswachters', 2001], ['Wadlopen', 'Noorderzon', 2004], ['Vuurtoren', 'Kustwacht', 2008],
].map(([title, artist, year], i) => ({ n: i + 1, itunesId: 7700000 + i, title, artist, year, previewUrl: `https://audio-ssl.itunes.apple.com/fake/q${i}.m4a` }));

async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}
/** A lobby option: scrolled to the middle first, so the sticky start button does not cover it. */
async function segCheck(page, testid) {
  const el = page.getByTestId(testid);
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await el.check();
}
const view = (page) => page.evaluate(() => window.__ttRoom?.session?.view || null);
const received = (page) => page.evaluate(() => window.__ttRoom?.session?.received || []);

async function quizPhone(browser, rooms, opts) {
  const p = await phone(browser, rooms, opts);
  await installFakeItunes(p.context);
  return p;
}
/** Wait until the question `round` runs on this phone (the clock started). */
async function waitQuestion(page, round, timeout = 30000) {
  await page.waitForFunction((r) => { const v = window.__ttRoom?.session?.view; return v?.phase === 'answering' && v.game.round === r && v.game.quiz.deadline; }, round, { timeout });
  await page.locator(`[data-testid="quiz-question"][data-round="${round}"]`).waitFor({ timeout });
}
async function hostQuestion(H, round, timeout = 30000) {
  await H.waitForFunction((r) => { const s = window.__ttHost?.session; const q = s?.spectatorView()?.game?.quiz; return s.room?.phase === 'answering' && s.room.game.round === r && q?.deadline; }, round, { timeout });
}
/** Index of the right option, worked out from the song the music phone plays (the test knows the playlist). */
async function rightIndex(H, P) {
  const { song } = await serverHost(H);
  const q = (await view(P)).game.quiz;
  const want = q.type === 'year' ? String(song.year) : q.type === 'artist' ? song.artist : song.title;
  const i = q.options.indexOf(want);
  if (i < 0) throw new Error(`right answer "${want}" not among ${q.options.join(' | ')}`);
  return i;
}
async function pick(page, i, scope = '') {
  await page.locator(`${scope} [data-testid="quiz-option-${i}"]`.trim()).click();
  // locked, or (the last one to answer) the server reveals at once
  await page.locator(`${scope} [data-testid="quiz-state"][data-state="locked"], [data-view="revealed"]`.trim()).first().waitFor({ timeout: 10000 });
}
async function mine(page) { return (await view(page)).game.quiz.reveal?.mine; }
/** No phone gets the right answer before the reveal: no reveal block, no answer index, never the song itself. */
async function assertNoAnswer(page, round, song, label) {
  for (const m of await received(page)) {
    if (m.t !== 'state' || m.view?.phase !== 'answering' || m.view.game?.round !== round) continue;
    const t = JSON.stringify(m);
    if (t.includes('"reveal":{') || /"answer":\d/.test(t)) throw new Error(`${label}: right answer before the reveal (round ${round})`);
    if (t.includes(song.previewUrl) || t.includes('"lead":')) throw new Error(`${label}: the song reached a player (round ${round})`);
  }
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const browser = await launch();
  const pages = [];
  try {
    const host = await quizPhone(browser, rooms, { seed: 7 });
    await host.context.addInitScript((tracks) => {
      if (localStorage.getItem('tt.quizInit')) return;
      localStorage.setItem('tt.quizInit', '1');
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'feest', name: 'Verjaardag', tracks }] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('feest'));
    }, TRACKS);
    const H = host.page;
    pages.push(H);
    await H.goto(`${server.url}#/spelleider`);
    const code = await createRoom(H, { hostPlays: true, name: 'Ilse' });
    const players = [];
    for (const nm of ['Anouk', 'Bram', 'Cas']) {
      const p = await quizPhone(browser, rooms);
      await joinRoom(p.page, server.url, code, nm, { via: 'link' });
      players.push(p.page);
      pages.push(p.page);
    }
    const [A, B, C] = players;
    await waitForPlayers(H, 4);

    // ---------- lobby: Quiz with its settings ----------
    await H.getByTestId('room-game-quiz').check();
    await H.getByTestId('room-quiz-settings').waitFor();
    await segCheck(H, 'room-quiz-time-15');
    await H.locator('[data-testid="room-quiz-time-15"]:checked').waitFor();
    await segCheck(H, 'room-quiz-count-10');
    await segCheck(H, 'room-quiz-type-mix');
    assert(/Verjaardag/.test(await H.getByTestId('room-quiz-summary').textContent()), 'the quiz plays the spelleider\'s own playlist');
    await A.waitForFunction(() => /Quiz/.test(document.querySelector('[data-testid="room-wait"]')?.textContent || '') && /15 s/.test(document.querySelector('[data-testid="room-wait"]').textContent));
    assert(true, 'players see "Quiz (10 vragen, 15 s bedenktijd, …)" in the lobby');
    await shot(H, 'quiz-01-host-lobby');
    await H.getByTestId('room-start').click();

    const types = new Set();
    const titles = new Set(TRACKS.map((t) => t.previewUrl));
    let dirk = null;
    for (let round = 1; round <= 10; round++) {
      await hostQuestion(H, round);
      for (const p of players) await waitQuestion(p, round);
      const q = (await view(A)).game.quiz;
      types.add(q.type);
      const right = await rightIndex(H, A);
      const wrong = (right + 1) % 4;
      const { song } = await serverHost(H);
      assert(titles.has(song.previewUrl), `question ${round} (${q.type}): "${song.title}" from the playlist; options ${q.options.join(' | ')}`);
      for (const p of players) await assertNoAnswer(p, round, song, 'player');
      if (round === 1) {
        await shot(A, 'quiz-02-player-question');
        await pick(A, right); // fast and right
        await pick(C, wrong); // wrong
        await pick(H, right, '[data-testid="host-own"]'); // the spelleider plays along
        await shot(H, 'quiz-03-host-question');
        await H.setViewportSize({ width: 1280, height: 720 });
        await shot(H, 'quiz-04-host-wide-question');
        await H.setViewportSize({ width: 390, height: 844 });
        await B.waitForTimeout(5000);
        await pick(B, right); // slow but right: last one, so the server reveals at once
        await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 10000 });
        const [ma, mb, mc, mh] = [await mine(A), await mine(B), await mine(C), (await H.evaluate(() => window.__ttHost.session.hostView().game.quiz.reveal.mine))];
        assert(ma.correct && mb.correct && !mc.correct && mh.correct, 'everybody answered: revealed without "Onthul"');
        assert(ma.points > mb.points && mb.points >= QUIZ_BASE && ma.points <= QUIZ_BASE + QUIZ_SPEED, `fast right ${ma.points} > slow right ${mb.points} >= ${QUIZ_BASE}`);
        assert(mc.points === 0 && (await view(C)).game.quiz.reveal.mine.none === false, 'wrong: 0 points');
        const counts = (await view(A)).game.quiz.reveal.counts;
        assert(counts[right] === 3 && counts[wrong] === 1, `distribution of the answers: ${counts}`);
        assert(await A.getByTestId('quiz-my-rank').getAttribute('data-rank') === '1', 'Anouk sees she is first');
        await shot(A, 'quiz-05-player-reveal');
        await shot(C, 'quiz-06-player-reveal-wrong');
        await H.setViewportSize({ width: 1280, height: 720 });
        await shot(H, 'quiz-07-host-wide-reveal');
        await H.setViewportSize({ width: 390, height: 844 });
        await shot(H, 'quiz-08-host-reveal');
      } else if (round === 2) {
        // nobody taps: the server's timer closes the question
        const t0 = Date.now();
        await shot(B, 'quiz-09-player-clock');
        await A.locator('[data-view="revealed"]').first().waitFor({ timeout: (THINK + 8) * 1000 });
        const took = (Date.now() - t0) / 1000;
        assert(took >= THINK - 3, `time ran out after ~${Math.round(took)} s (no taps, no "Onthul")`);
        for (const p of [A, B, C]) { const m = await mine(p); assert(m.none && m.points === 0, 'no answer: 0 points'); }
      } else if (round === 3) {
        // Cas answers and reloads: same question, his answer, the clock goes on
        await pick(C, right);
        await C.waitForTimeout(2200);
        const leftBefore = Number(await C.getByTestId('quiz-timer').getAttribute('data-left'));
        await C.reload();
        await waitQuestion(C, 3);
        await C.locator('[data-testid="quiz-state"][data-state="locked"]').waitFor();
        const leftAfter = Number(await C.getByTestId('quiz-timer').getAttribute('data-left'));
        assert(leftAfter < 15 && leftAfter <= leftBefore && leftAfter > 0, `after a reload: same question, answer still locked, ${leftAfter} s left (was ${leftBefore})`);
        await pick(A, right);
        await pick(B, wrong);
        await pick(H, right, '[data-testid="host-own"]');
        await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 10000 });
        assert((await mine(C)).correct && (await mine(C)).points > 0, 'his answer counted');
        // somebody joins halfway (between two questions): starts at 0
        dirk = await quizPhone(browser, rooms);
        const D = dirk.page;
        await D.goto(`${server.url}#/kamer/${code}`);
        await D.getByTestId('join-name').fill('Dirk');
        await D.getByTestId('join-submit').click();
        await D.locator('[data-testid="screen-room-player"][data-view="revealed"]').waitFor({ timeout: 20000 });
        pages.push(D);
        assert((await view(D)).game.mine.score === 0, 'Dirk joins halfway with 0 points');
      } else if (round === 4) {
        await waitQuestion(dirk.page, 4);
        players.push(dirk.page);
        for (const p of [A, B, C, dirk.page]) await pick(p, right);
        await pick(H, right, '[data-testid="host-own"]');
        await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 10000 });
        assert((await mine(dirk.page)).correct, 'Dirk scores on his first question');
      } else {
        for (const p of players) await pick(p, p === C ? wrong : right);
        await pick(H, right, '[data-testid="host-own"]');
        await A.locator('[data-view="revealed"]').first().waitFor({ timeout: 10000 });
      }
      await H.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
      if (round < 10) assert(/Volgende vraag/.test(await H.getByTestId('room-next').textContent()), `after question ${round}: "Volgende vraag"`);
      else assert(/podium/.test(await H.getByTestId('room-next').textContent()), 'after the last question: "Naar het podium"');
      await H.getByTestId('room-next').click();
    }
    assert(types.has('year') && types.has('artist') && types.has('title'), `all three kinds of question came up (${[...types].join(', ')})`);

    // ---------- podium ----------
    await A.getByTestId('quiz-podium').waitFor({ timeout: 15000 });
    await H.getByTestId('quiz-podium').waitFor();
    const ranking = await A.locator('[data-testid="quiz-final-ranking"] li').evaluateAll((els) => els.map((e) => ({ name: e.dataset.name, rank: Number(e.dataset.rank), score: Number(e.dataset.score) })));
    assert(ranking.length === 5 && ranking[0].rank === 1, `final ranking of 5: ${ranking.map((r) => `${r.rank}. ${r.name} ${r.score}`).join(', ')}`);
    assert(ranking.every((r, i) => i === 0 || r.score <= ranking[i - 1].score), 'ranked by points');
    const cas = ranking.find((r) => r.name === 'Cas');
    assert(cas.rank >= 4, 'Cas, mostly wrong, is at the bottom');
    assert(/Jij bent \de/.test(await A.getByTestId('quiz-my-place').textContent()), 'every phone shows its own place');
    assert(await H.getByTestId('room-again').textContent().then((t) => /Nog een quiz/.test(t)), 'the spelleider can start "Nog een quiz"');
    await shot(A, 'quiz-10-player-podium');
    await shot(H, 'quiz-11-host-podium');
    await H.setViewportSize({ width: 1280, height: 720 });
    await shot(H, 'quiz-12-host-wide-podium');
    await H.setViewportSize({ width: 390, height: 844 });
    assert(pages.every((p) => !p.errors.length), `no page errors (${pages.flatMap((p) => p.errors).join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }

  // ---------- PeerJS route: the quiz needs the server ----------
  const signal = await startSignal();
  const server2 = await startServer();
  const browser2 = await launch();
  try {
    const host = await phone(browser2, signal);
    await host.page.goto(`${server2.url}#/spelleider`);
    await createRoom(host.page);
    await host.page.getByTestId('room-quiz-server-only').waitFor();
    assert(await host.page.getByTestId('room-game-quiz').isDisabled(), 'PeerJS route: Quiz can not be chosen, "werkt alleen via de kamerserver"');
  } finally {
    await browser2.close();
    server2.stop();
    await signal.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
