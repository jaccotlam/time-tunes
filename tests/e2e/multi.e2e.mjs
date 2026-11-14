// "Samen spelen": one host + several phones (separate browser contexts) over a local
// PeerJS signalling server. Bingo to a win (typed answers, override, reload of a player and
// of the host, a player who drops out, late join, removal), then Tijdlijn to a shared win,
// and checks that nothing about the running song reaches a player before the reveal.
import { launch, startServer, assert, shot } from './helpers.mjs';
import { startSignal, phone, createRoom, joinRoom, waitForPlayers, hostRoom } from './multi-helpers.mjs';
import { checkSquare, findBingo } from '../../app/js/bingo.js';

const SEED = 7;
const view = (page) => page.evaluate(() => window.__ttRoom?.session?.view || null);
const received = (page) => page.evaluate(() => window.__ttRoom?.session?.received || []);
const song = async (host) => { const r = await hostRoom(host); return r.game.songs[r.game.current]; };
const has = (text, needle) => new RegExp(`${String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(text);

async function waitView(page, v, timeout = 20000) {
  await page.locator(`[data-view="${v}"]`).first().waitFor({ timeout });
}
async function waitRound(page, round) {
  await page.waitForFunction((r) => window.__ttRoom?.session?.view?.game?.round === r && window.__ttRoom.session.view.phase === 'answering', round, { timeout: 20000 });
  await page.locator('[data-testid="play-panel"]').waitFor();
}
async function waitAnswered(host, n) {
  await host.waitForFunction((count) => Number(document.querySelector('[data-testid="room-answered"]')?.dataset.done) >= count, n, { timeout: 20000 });
}

/** Lock a bingo answer on a player's phone: {index, guess?, text?} or {pass:true}. */
async function bingoAnswer(page, a) {
  if (a.pass) {
    await page.getByTestId('answer-pass').click();
  } else {
    await page.getByTestId(`bingo-cell-${a.index}`).click();
    if (a.guess != null) await page.getByTestId('answer-year-input').fill(String(a.guess));
    if (a.text != null) await page.getByTestId('answer-text-input').fill(a.text);
    await page.getByTestId('answer-lock').click();
  }
  await page.locator('[data-testid="answer-state"][data-state="locked"]').waitFor({ timeout: 15000 });
}

/** A correct bingo answer for this view and song (prefers the square that brings a line closest). */
function goodBingo(v, s, { typo = false } = {}) {
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
  if (o.k === 'year') return { index: o.i, guess: s.year + 1 };
  if (o.k === 'artist') return { index: o.i, text: typo ? s.artist.replace('artiest', 'artist') : s.artist };
  if (o.k === 'title') return { index: o.i, text: typo ? s.title.replace('nummer', 'numer') : s.title };
  return { index: o.i };
}

/** The song must not be anywhere on the player's phone: DOM and every received message. */
async function assertNoSpoiler(page, s, label) {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const v = await view(page);
  const msgs = JSON.stringify(await received(page));
  for (const secret of [s.title, s.artist]) {
    if (has(html, secret)) throw new Error(`${label}: "${secret}" in the DOM before the reveal`);
  }
  // titles/artists of songs that were revealed earlier may be in messages; the current one never
  const lastState = (await received(page)).filter((m) => m.t === 'state').map((m) => JSON.stringify(m.view));
  const sinceRound = lastState.filter((x) => x.includes(`"round":${v.game.round}`) && x.includes('"phase":"answering"'));
  for (const m of sinceRound) {
    if (has(m, s.title) || has(m, s.artist) || m.includes(s.id) || m.includes(s.previewUrl)) throw new Error(`${label}: song in a message before the reveal`);
    if (m.includes('"reveal":{')) throw new Error(`${label}: reveal block before the reveal`);
  }
  if (msgs.includes(s.previewUrl)) throw new Error(`${label}: preview URL reached a player`);
  // the year may only show up as part of the player's own, earlier revealed cards
  const own = v.game.kind === 'timeline' ? v.game.mine.timeline.map((c) => c.year) : v.game.mine.marks.filter((m) => typeof m === 'number');
  // (square labels such as "Vóór 2000 · t/m 1999" are fixed texts, not about this song)
  const text = await page.evaluate(() => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll('.bc-label, .bc-sub, [data-testid="answer-detail"]').forEach((e) => e.remove());
    return c.textContent;
  });
  if (text.includes(String(s.year)) && !own.includes(s.year)) {
    // decade labels like "1980–1989" contain years; only a bare match of the song year counts
    const bare = new RegExp(`(^|[^0-9–-])${s.year}([^0-9–-]|$)`).test(text);
    if (bare) throw new Error(`${label}: year ${s.year} visible before the reveal`);
  }
}

export default async function run() {
  const signal = await startSignal();
  const server = await startServer();
  const browser = await launch();
  const pages = [];
  try {
    // ---------- room + joining ----------
    const host = await phone(browser, signal, { seed: SEED });
    pages.push(host.page);
    const H = host.page;
    // Start screen: the third way to play, and every main entry still above the fold on 390×844.
    await H.goto(server.url);
    await H.getByTestId('mode-multi').waitFor();
    const bottoms = await H.evaluate(() => ['start-scan', 'start-print', 'start-digital', 'start-bingo', 'start-host', 'start-join']
      .map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().bottom));
    assert(bottoms.every((b) => b <= 844), `all six main entries above the fold (lowest at ${Math.round(Math.max(...bottoms))}px)`);
    assert((await H.getByTestId('start-host').getAttribute('href')) === '#/spelleider' && (await H.getByTestId('start-join').getAttribute('href')) === '#/kamer', 'start-host / start-join links');
    await shot(H, '69-multi-start');
    await H.getByTestId('start-rules').click();
    await H.getByTestId('screen-rules').waitFor();
    assert(await H.getByTestId('rules-multi').count() === 1, 'rules explain playing on own phones');
    await H.goto(`${server.url}#/spelleider`);
    await shot(H, '70-multi-host-setup');
    const code = await createRoom(H);
    assert(/^[A-HJKMNP-Z]{4}$/.test(code), `room created with code ${code}`);
    const qrHref = await H.getByTestId('room-qr').getAttribute('href');
    assert(qrHref.endsWith(`#/kamer/${code}`), `QR/link points to #/kamer/${code}`);

    const A = (await phone(browser, signal)).page; pages.push(A);
    const B = (await phone(browser, signal)).page; pages.push(B);
    const C = await phone(browser, signal); pages.push(C.page);
    await joinRoom(A, server.url, code, 'Anouk', { via: 'code' });
    assert(true, 'Anouk joins with the code from the start screen (typed in lower case)');
    await B.goto(`${server.url}#/kamer/${code}`);
    assert((await B.getByTestId('join-code').inputValue()) === code, 'link pre-fills the code');
    await B.getByTestId('join-name').fill('Bram');
    await B.getByTestId('join-submit').click();
    await waitView(B, 'lobby');
    assert(true, 'Bram joins through the link');
    await joinRoom(C.page, server.url, code, 'Cas');
    await waitForPlayers(H, 3);
    assert(await H.locator('[data-testid^="room-player-"]').count() === 3, 'host lists 3 players');
    await shot(H, '71-multi-host-lobby');
    await shot(A, '72-multi-player-lobby');

    // ---------- Bingo ----------
    await H.getByTestId('room-size-3').check();
    await A.waitForFunction(() => window.__ttRoom.session.view?.settings.size === 3);
    assert(true, 'settings reach the players (3×3)');
    await H.getByTestId('room-start').click();
    await waitView(H, 'answering');
    for (const p of [A, B, C.page]) await waitRound(p, 1);
    let s = await song(H);
    for (const [p, n] of [[A, 'Anouk'], [B, 'Bram'], [C.page, 'Cas']]) await assertNoSpoiler(p, s, n);
    assert(true, 'round 1: title/artist/year not in the DOM nor in the messages of any player');
    const va = await view(A);
    const vb = await view(B);
    assert(va.game.mine.card.join() !== vb.game.mine.card.join(), 'every player has an own card');
    await shot(H, '73-multi-host-answering');

    // Round 1: Anouk types the artist with a typo, Bram types a wrong title, Cas passes.
    const aIdx = va.game.mine.card.indexOf('artist');
    await bingoAnswer(A, { index: aIdx, text: s.artist.replace('artiest', 'artist').toLowerCase() });
    await shot(A, '74-multi-player-locked');
    // changing is allowed until the reveal: pick another square, then back to the artist
    const other = va.game.mine.card.findIndex((k) => k !== 'artist' && k !== 'title' && k !== 'year');
    await bingoAnswer(A, { index: other });
    await H.waitForFunction((i) => JSON.parse(localStorage.getItem('timetunesr.multiHost.v1')).game.answers[Object.keys(JSON.parse(localStorage.getItem('timetunesr.multiHost.v1')).game.answers)[0]]?.index === i, other);
    await bingoAnswer(A, { index: aIdx, text: s.artist.replace('artiest', 'artist').toLowerCase() });
    assert(true, 'answer can be changed until the reveal');
    const bTitle = vb.game.mine.card.indexOf('title');
    await B.getByTestId(`bingo-cell-${bTitle}`).click();
    await B.getByTestId('answer-text-input').fill('Iets heel anders');
    await shot(B, '75-multi-player-typing');
    await B.getByTestId('answer-lock').click();
    await B.locator('[data-testid="answer-state"][data-state="locked"]').waitFor();
    await bingoAnswer(C.page, { pass: true });
    await waitAnswered(H, 3);
    assert((await H.getByTestId('room-reveal').getAttribute('data-ready')) === 'true', 'reveal button lights up when everybody answered');
    await shot(H, '76-multi-host-all-answered');
    for (const [p, n] of [[A, 'Anouk'], [B, 'Bram']]) await assertNoSpoiler(p, s, `${n} after locking`);
    await H.getByTestId('room-reveal').click();
    await waitView(A, 'revealed');
    await waitView(B, 'revealed');
    assert((await A.getByTestId('my-result').getAttribute('data-correct')) === 'true', 'typed artist with a typo is approved automatically');
    assert((await B.getByTestId('my-result').getAttribute('data-correct')) === 'false', 'wrong typed title is rejected');
    assert((await A.getByTestId('answer-title').textContent()).trim() === s.title, 'after the reveal the players see the song');
    await shot(H, '77-multi-host-revealed');
    await shot(A, '78-multi-player-revealed');
    const bRow = H.locator('[data-testid^="room-result-"][data-name="Bram"]');
    const bRowId = await bRow.getAttribute('data-testid');
    await H.getByTestId(bRowId.replace('room-result-', 'room-override-')).click();
    await B.locator('[data-testid="my-result"][data-correct="true"]').waitFor();
    assert(true, 'host turns Bram\'s verdict around with one tap; Bram sees it');
    assert(await B.locator(`[data-testid="bingo-cell-${bTitle}"][data-state="stamped"]`).count() === 1, 'overridden answer stamps the square');
    await H.getByTestId('room-next').click();

    // Round 2: Cas drops out (phone gone); the host can still reveal and go on.
    for (const p of [A, B]) await waitRound(p, 2);
    await C.context.close();
    s = await song(H);
    await bingoAnswer(A, goodBingo(await view(A), s));
    await bingoAnswer(B, { pass: true });
    await H.locator('[data-testid^="room-player-"][data-name="Cas"][data-online="false"]').waitFor({ timeout: 25000 });
    assert(true, 'host sees Cas offline');
    assert((await H.getByTestId('room-reveal').getAttribute('data-ready')) === 'true', 'an offline player does not block the round');
    await shot(H, '79-multi-host-offline');
    await H.getByTestId('room-reveal').click();
    await waitView(A, 'revealed');
    const casRemove = await H.locator('[data-testid^="room-player-"][data-name="Cas"]').getAttribute('data-testid');
    await H.getByTestId(casRemove.replace('room-player-', 'room-remove-')).click();
    await H.waitForFunction(() => ![...document.querySelectorAll('[data-testid^="room-player-"]')].some((e) => e.dataset.name === 'Cas'));
    assert((await hostRoom(H)).players.length === 2, 'host removed Cas');
    await H.getByTestId('room-next').click();

    // Round 3: Bram locks an answer and reloads his page: back with his own card and answer.
    for (const p of [A, B]) await waitRound(p, 3);
    s = await song(H);
    const bBefore = await view(B);
    const bAns = goodBingo(bBefore, s);
    await bingoAnswer(B, bAns.pass ? { pass: true } : bAns);
    await B.reload();
    await waitRound(B, 3);
    const bAfter = await view(B);
    assert(bAfter.game.mine.card.join() === bBefore.game.mine.card.join() && bAfter.you.name === 'Bram', 'player reload: same player, same card');
    assert((await B.locator('[data-testid="answer-state"]').getAttribute('data-state')) === 'locked', 'player reload: locked answer is still there');
    await assertNoSpoiler(B, s, 'Bram after reload');
    await bingoAnswer(A, goodBingo(await view(A), s));
    await H.getByTestId('room-reveal').click();
    await waitView(A, 'revealed');
    await H.getByTestId('room-next').click();

    // Round 4: Dirk joins late; the host reloads in the middle of the round.
    for (const p of [A, B]) await waitRound(p, 4);
    const D = await phone(browser, signal); pages.push(D.page);
    await joinRoom(D.page, server.url, code, 'Dirk', { via: 'link' }).catch(async () => {
      // during a game the player lands in 'answering', not in the lobby
    });
    await waitRound(D.page, 4);
    const vd = await view(D.page);
    const vaNow = await view(A);
    const vbNow = await view(B);
    const marks = (v) => v.game.mine.marks.filter((m) => m != null).length;
    assert(marks(vd) <= Math.min(marks(vaNow), marks(vbNow)) && !findBingo(vd.game.mine.marks, 3), `late join: fair start (${marks(vd)} free squares, never more than the last player, no line)`);
    assert(vd.game.mine.marks.every((m) => m == null || m === '*'), 'late join: only free squares');
    await shot(D.page, '80-multi-player-late-join');
    s = await song(H);
    await bingoAnswer(A, goodBingo(await view(A), s));
    await H.reload();
    await waitView(H, 'answering');
    assert((await H.getByTestId('room-code').textContent()).trim() === code, 'host reload: same room code');
    await waitForPlayers(H, 3);
    assert(true, 'host reload: all players come back by themselves');
    await H.waitForFunction(() => Number(document.querySelector('[data-testid="room-answered"]')?.dataset.done) >= 1);
    assert(true, 'host reload: the answers given before the reload are kept');
    await bingoAnswer(B, { pass: true });
    await bingoAnswer(D.page, { pass: true });
    await H.getByTestId('room-reveal').click();
    await waitView(A, 'revealed');
    await H.getByTestId('room-next').click();

    // Play on: Anouk plays perfectly until she has bingo, the others pass.
    let round = 5;
    for (; round < 40; round++) {
      await H.waitForFunction(() => ['answering', 'won'].includes(document.querySelector('[data-testid="screen-room-host"]').dataset.view));
      if ((await H.getByTestId('screen-room-host').getAttribute('data-view')) === 'won') break;
      await waitRound(A, round);
      s = await song(H);
      await bingoAnswer(A, goodBingo(await view(A), s));
      await H.getByTestId('room-reveal').click();
      await waitView(H, 'revealed');
      await H.getByTestId('room-next').click();
    }
    await waitView(H, 'won');
    await waitView(A, 'won');
    await waitView(B, 'won');
    const winner = await H.getByTestId('room-winner-name').textContent();
    assert(/Anouk wint/.test(winner), `bingo winner on the host: "${winner}"`);
    assert(/Anouk wint/.test(await B.getByTestId('room-winner-name').textContent()), 'players see the winner');
    assert(await A.getByTestId('room-you-won').count() === 1, 'Anouk sees that she won');
    await shot(H, '81-multi-host-won');
    await shot(A, '82-multi-player-won');

    // Remove an online player: Dirk gets a clear message.
    const dRemove = await H.locator('[data-testid^="room-player-"][data-name="Dirk"]').getAttribute('data-testid');
    await H.getByTestId(dRemove.replace('room-player-', 'room-remove-')).click();
    await D.page.locator('[data-testid="room-error"][data-code="removed"]').waitFor({ timeout: 15000 });
    assert(true, 'removed player sees "Je bent verwijderd"');
    await shot(D.page, '83-multi-player-removed');

    // ---------- Tijdlijn: Anouk and Bram both perfect -> shared win ----------
    await H.getByTestId('room-to-lobby').click();
    await waitView(H, 'lobby');
    await H.getByTestId('room-game-timeline').check();
    for (let i = 0; i < 6; i++) await H.getByTestId('room-goal-minus').click();
    const goal = Number((await H.getByTestId('room-goal-value').textContent()).match(/\d+/)[0]);
    assert(goal === 4, `goal set to ${goal}`);
    await H.getByTestId('room-start').click();
    for (let r = 1; r <= goal; r++) {
      await H.waitForFunction(() => ['answering', 'won'].includes(document.querySelector('[data-testid="screen-room-host"]').dataset.view));
      if ((await H.getByTestId('screen-room-host').getAttribute('data-view')) === 'won') break;
      for (const p of [A, B]) await waitRound(p, r);
      s = await song(H);
      if (r === 1) {
        for (const [p, n] of [[A, 'Anouk'], [B, 'Bram']]) await assertNoSpoiler(p, s, `${n} (tijdlijn)`);
        assert(true, 'tijdlijn: song not in DOM/messages before the reveal');
      }
      for (const p of [A, B]) {
        const v = await view(p);
        const years = v.game.mine.timeline.map((c) => c.year);
        let slot = years.findIndex((y) => y > s.year);
        if (slot < 0) slot = years.length;
        await p.getByTestId(`slot-${slot}`).click();
        if (r === 1 && p === A) await shot(A, '84-multi-player-timeline');
        await p.getByTestId('answer-lock').click();
        await p.locator('[data-testid="answer-state"][data-state="locked"]').waitFor();
      }
      await H.getByTestId('room-reveal').click();
      await waitView(A, 'revealed');
      assert((await A.getByTestId('my-result').getAttribute('data-correct')) === 'true', `tijdlijn round ${r}: Anouk right`);
      if (r === 1) await shot(A, '85-multi-player-timeline-revealed');
      await H.getByTestId('room-next').click();
    }
    await waitView(H, 'won');
    const shared = await H.getByTestId('room-winner-name').textContent();
    assert(/Gedeelde winst/.test(shared) && /Anouk/.test(shared) && /Bram/.test(shared), `tijdlijn: shared win "${shared}"`);
    await waitView(B, 'won');
    await shot(H, '86-multi-host-shared-win');
    await shot(B, '87-multi-player-shared-win');

    // Nog een potje: same players, fresh timelines.
    await H.getByTestId('room-again').click();
    for (const p of [A, B]) await waitRound(p, 1);
    assert((await view(A)).game.mine.timeline.length === 1, 'Nog een potje: same players, new timeline of 1 card');

    // ---------- host plays along ----------
    await H.getByTestId('host-close').click();
    await A.locator('[data-testid="room-error"][data-code="closed"]').waitFor({ timeout: 15000 });
    assert(true, 'closing the room tells the players');
    await waitView(H, 'setup');
    // "Code already exists": somebody else holds room AAAA on the broker; the host's first draw is AAAA.
    const squatted = await A.evaluate((cfg) => new Promise((resolve) => {
      const p = new window.Peer('timetunesr-kamer-AAAA', { host: cfg.host, port: cfg.port, path: cfg.path, secure: false, key: cfg.key, config: { iceServers: [] } });
      p.on('open', () => resolve(true));
      p.on('error', () => resolve(false));
    }), signal.config);
    assert(squatted, 'another peer holds room code AAAA');
    await H.evaluate(() => { const orig = Math.random; let n = 0; Math.random = () => (n++ < 4 ? 0 : orig()); });
    const code2 = await createRoom(H, { hostPlays: true, name: 'Ilse' });
    assert(code2 !== 'AAAA' && /^[A-Z]{4}$/.test(code2), `code taken -> the host picks another code (${code2})`);
    const E = (await phone(browser, signal)).page; pages.push(E);
    await joinRoom(E, server.url, code2, 'Eva');
    await waitForPlayers(H, 2);
    await H.getByTestId('room-game-bingo').check();
    await H.getByTestId('room-size-3').check();
    await H.getByTestId('room-start').click();
    await H.getByTestId('host-own').waitFor();
    s = await song(H);
    const hv = await H.evaluate(() => window.__ttHost.session.hostView());
    const hostHtml = await H.evaluate(() => document.querySelector('#app').outerHTML);
    assert(!has(hostHtml, s.title) && !has(hostHtml, s.artist), 'host screen does not show the song before the reveal');
    const hAns = goodBingo(hv, s);
    if (hAns.pass) await H.getByTestId('answer-pass').click();
    else {
      await H.getByTestId(`bingo-cell-${hAns.index}`).click();
      if (hAns.guess != null) await H.getByTestId('answer-year-input').fill(String(hAns.guess));
      if (hAns.text != null) await H.getByTestId('answer-text-input').fill(hAns.text);
      await H.getByTestId('answer-lock').click();
    }
    await H.locator('[data-testid="host-own"] [data-testid="answer-state"][data-state="locked"]').waitFor();
    await shot(H, '88-multi-host-plays-answering');
    await waitRound(E, 1);
    await E.locator('[data-testid="room-player-0"][data-answered="true"]').waitFor();
    assert(true, 'host plays along: own panel, players see that the host answered');
    await bingoAnswer(E, { pass: true });
    await H.getByTestId('room-reveal').click();
    await H.locator('[data-testid="host-own"] [data-testid="my-result"]').waitFor();
    assert((await H.locator('[data-testid="host-own"] [data-testid="my-result"]').getAttribute('data-correct')) === 'true', 'host\'s own answer is judged like a player\'s');
    await shot(H, '89-multi-host-plays-revealed');

    // Version check: an app with another protocol version gets a clear message, no game state.
    const reply = await E.evaluate(async ([cfg, roomCode]) => {
      const { PROTOCOL_VERSION } = await import('./js/multi/protocol.js');
      return new Promise((resolve) => {
        const peer = new window.Peer({ host: cfg.host, port: cfg.port, path: cfg.path, secure: false, key: cfg.key, config: { iceServers: [] } });
        peer.on('open', () => {
          const c = peer.connect(`timetunesr-kamer-${roomCode}`, { reliable: true });
          c.on('open', () => c.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION - 1, playerId: 'oldapp123', name: 'Oud' })));
          c.on('data', (d) => { resolve(JSON.parse(d)); peer.destroy(); });
        });
        setTimeout(() => resolve(null), 15000);
      });
    }, [signal.config, code2]);
    assert(reply && reply.t === 'error' && reply.code === 'version' && /Ververs/.test(reply.message), `old app gets a version message: "${reply?.message}"`);
    assert(!(await hostRoom(H)).players.some((p) => p.name === 'Oud'), 'old app is not added to the room');

    const errors = pages.flatMap((p) => p.errors || []);
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
    for (const p of [H, A, B]) {
      const w = await p.evaluate(() => document.documentElement.scrollWidth);
      if (w > 390) throw new Error(`horizontal scroll (${w}px)`);
    }
    assert(true, 'no horizontal scroll on 390 px');
  } finally {
    await browser.close();
    server.stop();
    await signal.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
