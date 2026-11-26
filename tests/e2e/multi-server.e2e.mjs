// "Samen spelen" through the room server (server/node.mjs) instead of PeerJS: a spelleider
// and several phones (separate browser contexts, 390 px), all with only an outgoing
// WebSocket to the server (cross-origin: app on localhost, server on 127.0.0.1).
// Bingo to a win, Tijdlijn to a shared win, reloads, the spelleider's page gone while a new
// player joins, taking the lead after the time-out (and back), a server restart in the
// middle of a game, an unreachable server / wrong code with the step-by-step diagnosis and
// "Kopieer diagnose", a sleeping server, and checks that no player ever receives the song
// before the reveal.
import { launch, startServer, assert, shot } from './helpers.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { checkSquare } from '../../app/js/bingo.js';
import { createServer } from 'node:net';

const SEED = 7;
const view = (page) => page.evaluate(() => window.__ttRoom?.session?.view || null);
const received = (page) => page.evaluate(() => window.__ttRoom?.session?.received || []);
const has = (text, needle) => new RegExp(`${String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(text);
const song = async (host) => (await serverHost(host)).song;
/** Click "Kopieer diagnose" and read what landed on the clipboard. */
async function copyDiag(page) {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByTestId('diag-copy').click();
  for (let i = 0; i < 50; i++) {
    const t = await page.evaluate(() => navigator.clipboard.readText());
    if (t) return t;
    await page.waitForTimeout(100);
  }
  return '';
}

async function waitView(page, v, timeout = 20000) {
  await page.locator(`[data-view="${v}"]`).first().waitFor({ timeout });
}
async function waitRound(page, round, timeout = 20000) {
  await page.waitForFunction((r) => window.__ttRoom?.session?.view?.game?.round === r && window.__ttRoom.session.view.phase === 'answering', round, { timeout });
  await page.locator('[data-testid="play-panel"]').waitFor({ timeout });
}
async function waitHostView(page, v, timeout = 20000) {
  await page.locator(`[data-testid="screen-room-host"][data-view="${v}"]`).waitFor({ timeout });
}

async function bingoAnswer(page, a, scope = '') {
  const q = (id) => page.locator(`${scope} [data-testid="${id}"]`.trim());
  if (a.pass) await q('answer-pass').click();
  else {
    await q(`bingo-cell-${a.index}`).click();
    if (a.guess != null) await q('answer-year-input').fill(String(a.guess));
    if (a.text != null) await q('answer-text-input').fill(a.text);
    await q('answer-lock').click();
  }
  await page.locator(`${scope} [data-testid="answer-state"][data-state="locked"]`.trim()).waitFor({ timeout: 15000 });
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
  if (o.k === 'year') return { index: o.i, guess: s.year + 1 };
  if (o.k === 'artist') return { index: o.i, text: s.artist };
  if (o.k === 'title') return { index: o.i, text: s.title };
  return { index: o.i };
}

/** Nothing about the running song on the player's phone: DOM and every message received. */
async function assertNoSpoiler(page, s, label) {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  for (const secret of [s.title, s.artist]) if (has(html, secret)) throw new Error(`${label}: "${secret}" in the DOM before the reveal`);
  const msgs = await received(page);
  const all = JSON.stringify(msgs);
  if (all.includes(s.previewUrl)) throw new Error(`${label}: preview URL reached a player`);
  if (all.includes('"lead":') || msgs.some((m) => m.t === 'backup')) throw new Error(`${label}: leader data or backup reached a player`);
  const v = await view(page);
  for (const m of msgs.filter((x) => x.t === 'state' && x.view?.phase === 'answering' && x.view?.game?.round === v.game.round)) {
    const t = JSON.stringify(m);
    if (has(t, s.title) || has(t, s.artist) || t.includes(`"${s.id}"`)) throw new Error(`${label}: song in a message before the reveal`);
    if (t.includes('"reveal":{')) throw new Error(`${label}: reveal block before the reveal`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const browser = await launch();
  const pages = [];
  const contexts = [];
  const mk = async (opts) => { const p = await phone(browser, rooms, opts); pages.push(p.page); contexts.push(p.context); return p; };
  try {
    // ---------- room, joining by code and by link ----------
    const host = await mk({ seed: SEED });
    let H = host.page;
    await H.goto(`${server.url}#/spelleider`);
    assert(await H.getByTestId('multi-p2p-note').count() === 0, 'with a server: no PeerJS warning on the setup screen');
    const code = await createRoom(H);
    assert(/^[A-HJKMNP-Z]{4}$/.test(code), `room ${code} made by the server`);
    assert((await serverHost(H)).meta.leader === true, 'the spelleider leads');
    const A = (await mk()).page;
    const B = (await mk()).page;
    await joinRoom(A, server.url, code, 'Anouk', { via: 'code' });
    assert(true, 'Anouk joins with the code');
    await joinRoom(B, server.url, code, 'Bram', { via: 'link' });
    assert(true, 'Bram joins through the link');
    await waitForPlayers(H, 2);
    assert(await A.evaluate(() => window.__ttRoom.session.isServer === true), 'the player talks to the server');

    // ---------- Bingo to a win ----------
    await H.getByTestId('room-game-bingo').check(); // the lobby now starts on Discobingo
    await H.getByTestId('room-size-3').check();
    await A.waitForFunction(() => window.__ttRoom.session.view?.settings.size === 3);
    await H.getByTestId('room-start').click();
    await waitHostView(H, 'answering');
    for (const p of [A, B]) await waitRound(p, 1);
    let s = await song(H);
    assert(s && s.title && s.previewUrl, 'the music phone (spelleider) has the running song');
    for (const [p, n] of [[A, 'Anouk'], [B, 'Bram']]) await assertNoSpoiler(p, s, n);
    assert(true, 'round 1: nothing about the song reaches a player (DOM, messages)');
    const hostHtml = await H.evaluate(() => document.querySelector('#app').outerHTML);
    assert(!has(hostHtml, s.title) && !has(hostHtml, s.artist), 'the host screen does not show the song either');
    await bingoAnswer(A, goodBingo(await view(A), s));
    await bingoAnswer(B, { pass: true });
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor();
    await H.getByTestId('room-reveal').click();
    await waitView(A, 'revealed');
    assert((await A.getByTestId('my-result').getAttribute('data-correct')) === 'true', 'Anouk right in round 1');
    assert((await A.getByTestId('answer-title').textContent()).trim() === s.title, 'after the reveal the players see the song');
    await H.getByTestId('room-next').click();

    // round 2: Bram locks an answer and reloads; then the host reloads
    for (const p of [A, B]) await waitRound(p, 2);
    s = await song(H);
    const bBefore = await view(B);
    await bingoAnswer(B, { pass: true });
    await B.reload();
    await waitRound(B, 2);
    const bAfter = await view(B);
    assert(bAfter.game.mine.card.join() === bBefore.game.mine.card.join() && bAfter.you.name === 'Bram', 'player reload: same place, same card');
    assert((await B.locator('[data-testid="answer-state"]').getAttribute('data-state')) === 'locked', 'player reload: locked answer still there');
    await assertNoSpoiler(B, s, 'Bram after reload');
    await H.reload();
    await waitHostView(H, 'answering');
    assert((await H.getByTestId('room-code').textContent()).trim() === code, 'host reload: same room');
    await waitForPlayers(H, 2);
    await H.waitForFunction(() => Number(document.querySelector('[data-testid="room-answered"]')?.dataset.done) >= 1);
    assert(true, 'host reload: answers kept');
    assert((await song(H))?.id === s.id, 'host reload: the music phone gets the running song again');
    await bingoAnswer(A, goodBingo(await view(A), s));
    await H.getByTestId('room-reveal').click();
    await waitHostView(H, 'revealed');
    await H.getByTestId('room-next').click();

    for (let round = 3; round < 40; round++) {
      await H.waitForFunction(() => ['answering', 'won'].includes(document.querySelector('[data-testid="screen-room-host"]').dataset.view));
      if ((await H.getByTestId('screen-room-host').getAttribute('data-view')) === 'won') break;
      await waitRound(A, round);
      s = await song(H);
      if (round === 3) await assertNoSpoiler(A, s, 'Anouk round 3');
      await bingoAnswer(A, goodBingo(await view(A), s));
      await H.getByTestId('room-reveal').click();
      await waitHostView(H, 'revealed');
      await H.getByTestId('room-next').click();
    }
    await waitHostView(H, 'won');
    await waitView(A, 'won');
    await waitView(B, 'won');
    assert(/Anouk wint/.test(await H.getByTestId('room-winner-name').textContent()), 'bingo: Anouk wins (host)');
    assert(/Anouk wint/.test(await B.getByTestId('room-winner-name').textContent()), 'bingo: Bram sees the winner');

    // ---------- Tijdlijn to a shared win ----------
    await H.getByTestId('room-to-lobby').click();
    await waitHostView(H, 'lobby');
    await H.getByTestId('room-game-timeline').check();
    for (let i = 0; i < 6; i++) await H.getByTestId('room-goal-minus').click();
    await H.waitForFunction(() => /4/.test(document.querySelector('[data-testid="room-goal-value"]').textContent));
    await H.getByTestId('room-start').click();
    for (let r = 1; r <= 4; r++) {
      await H.waitForFunction(() => ['answering', 'won'].includes(document.querySelector('[data-testid="screen-room-host"]').dataset.view));
      if ((await H.getByTestId('screen-room-host').getAttribute('data-view')) === 'won') break;
      for (const p of [A, B]) await waitRound(p, r);
      s = await song(H);
      if (r === 1) for (const [p, n] of [[A, 'Anouk'], [B, 'Bram']]) await assertNoSpoiler(p, s, `${n} (tijdlijn)`);
      for (const p of [A, B]) {
        const v = await view(p);
        const years = v.game.mine.timeline.map((c) => c.year);
        let slot = years.findIndex((y) => y > s.year);
        if (slot < 0) slot = years.length;
        await p.getByTestId(`slot-${slot}`).click();
        await p.getByTestId('answer-lock').click();
        await p.locator('[data-testid="answer-state"][data-state="locked"]').waitFor();
      }
      await H.getByTestId('room-reveal').click();
      await waitView(A, 'revealed');
      await H.getByTestId('room-next').click();
    }
    await waitHostView(H, 'won');
    const shared = await H.getByTestId('room-winner-name').textContent();
    assert(/Gedeelde winst/.test(shared) && /Anouk/.test(shared) && /Bram/.test(shared), `tijdlijn: shared win "${shared}"`);

    // ---------- the spelleider's page is gone; a new player joins anyway ----------
    await H.getByTestId('room-to-lobby').click();
    await waitHostView(H, 'lobby');
    await H.getByTestId('room-game-bingo').check();
    await H.getByTestId('room-size-3').check();
    await H.getByTestId('room-start').click();
    for (const p of [A, B]) await waitRound(p, 1);
    await H.close();
    await A.getByTestId('room-leader-away').waitFor({ timeout: 15000 });
    assert(true, 'players see "de spelleider is even weg"');
    await shot(A, '90-server-leader-away');
    const C = (await mk()).page;
    await joinRoom(C, server.url, code, 'Cas', { via: 'code' }).catch(() => {});
    await waitRound(C, 1);
    assert(true, 'a new player joins while the spelleider\'s page is gone');
    assert((await view(C)).game.mine, 'and gets a card in the running game');
    await bingoAnswer(A, { pass: true });
    assert(true, 'players can still answer while the spelleider is away');
    // the spelleider comes back
    H = await host.context.newPage();
    pages.push(H);
    H.errors = [];
    H.on('pageerror', (e) => H.errors.push(e.message));
    H.on('dialog', (d) => d.accept());
    await H.goto(`${server.url}#/spelleider`);
    await waitHostView(H, 'answering');
    await waitForPlayers(H, 3);
    await A.getByTestId('room-leader-away').waitFor({ state: 'detached', timeout: 15000 });
    assert(true, 'spelleider back: same room, 3 players, the "away" note is gone');
    await H.waitForFunction(() => Number(document.querySelector('[data-testid="room-answered"]')?.dataset.done) >= 1);
    assert(true, 'answers given while the spelleider was away are there');

    // ---------- taking the lead after the time-out ----------
    await H.close();
    await A.getByTestId('room-takeover-wait').waitFor({ timeout: 15000 });
    await A.getByTestId('room-takeover').waitFor({ timeout: 45000 });
    await shot(A, '91-server-takeover');
    assert(true, 'after the time-out a player may take the lead');
    await A.getByTestId('room-takeover').click();
    await A.locator('[data-testid="screen-room-host"]').waitFor({ timeout: 15000 });
    await waitHostView(A, 'answering');
    await A.getByTestId('room-reveal').waitFor();
    const lead = await serverHost(A);
    assert(lead.meta.leader === true && lead.song?.title, 'Anouk leads now; the music plays on her phone');
    assert(await A.getByTestId('host-own').count() === 1, 'Anouk keeps playing with her own card on the spelleider screen');
    await B.locator('[data-testid="room-leader-away"]').waitFor({ state: 'detached', timeout: 15000 });
    await bingoAnswer(B, { pass: true });
    await bingoAnswer(C, { pass: true });
    await A.getByTestId('room-reveal').click();
    await waitView(B, 'revealed');
    assert(true, 'the new leader reveals; players see the result');
    await A.getByTestId('room-next').click();
    await waitRound(B, 2);
    // the owner comes back: sees who leads, takes it back
    H = await host.context.newPage();
    pages.push(H);
    H.errors = [];
    H.on('pageerror', (e) => H.errors.push(e.message));
    H.on('dialog', (d) => d.accept());
    await H.goto(`${server.url}#/spelleider`);
    await H.getByTestId('room-lead-elsewhere').waitFor({ timeout: 20000 });
    assert(/Anouk/.test(await H.getByTestId('room-lead-elsewhere').textContent()), 'the spelleider sees that Anouk leads');
    assert(await H.getByTestId('room-reveal').count() === 0, 'and has no Onthul button meanwhile');
    await shot(H, '92-server-lead-elsewhere');
    await H.getByTestId('room-reclaim').click();
    await H.getByTestId('room-reveal').waitFor({ timeout: 15000 });
    await A.locator('[data-testid="screen-room-player"]').waitFor({ timeout: 15000 });
    await waitRound(A, 2);
    assert(true, 'the spelleider takes the lead back; Anouk is a player again in the same round');

    // ---------- the server restarts during a game ----------
    s = await song(H);
    const aCard = (await view(A)).game.mine.card.join();
    await bingoAnswer(A, { pass: true });
    await rooms.restart();
    assert(true, 'server killed and started again (all rooms in memory gone)');
    await H.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 30000 });
    await waitForPlayers(H, 3);
    for (const p of [A, B, C]) await waitRound(p, 2, 30000);
    assert((await view(A)).game.mine.card.join() === aCard, 'after the restart: same room, same round, same card');
    assert((await song(H))?.id === s.id, 'after the restart: same song');
    await H.waitForFunction(() => Number(document.querySelector('[data-testid="room-answered"]')?.dataset.done) >= 1, null, { timeout: 15000 });
    assert(true, 'after the restart: an answer given just before it is given again by the phone');
    await H.getByTestId('room-reveal').click();
    await waitView(A, 'revealed');
    assert(true, 'the game goes on after the restart');

    // ---------- unreachable server / wrong code: explanation per step ----------
    const deadPort = await freePort();
    const dead = await phone(browser, { kind: 'server', url: `http://127.0.0.1:${deadPort}` }, { permissions: ['clipboard-read', 'clipboard-write'] });
    pages.push(dead.page); contexts.push(dead.context);
    const D = dead.page;
    const t0 = Date.now();
    await D.goto(`${server.url}#/kamer`);
    await D.getByTestId('join-code').fill(code);
    await D.getByTestId('join-name').fill('Geheimenaam');
    await D.getByTestId('join-submit').click();
    await D.locator('[data-testid="diag-step-server"][data-state="fail"]').waitFor({ timeout: 8000 });
    await D.getByTestId('diag-advice').waitFor();
    assert(Date.now() - t0 < 8000, `unreachable server explained within ${Math.round((Date.now() - t0) / 100) / 10} s`);
    await shot(D, '93-server-unreachable');
    const text = await copyDiag(D);
    assert(/Server bereikt: FOUT/.test(text) && text.includes(`http://127.0.0.1:${deadPort}`) && /Browser: /.test(text) && /App: /.test(text), 'Kopieer diagnose: server, browser, app version, step 1 failed');
    assert(!text.includes('Geheimenaam'), 'diagnosis holds no name');
    const wrong = await mk({ permissions: ['clipboard-read', 'clipboard-write'] });
    const W = wrong.page;
    const bad = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const t1 = Date.now();
    await W.goto(`${server.url}#/kamer`);
    await W.getByTestId('join-code').fill(bad);
    await W.getByTestId('join-name').fill('Wim');
    await W.getByTestId('join-submit').click();
    await W.locator('[data-testid="diag-step-room"][data-state="fail"][data-code="notfound"]').waitFor({ timeout: 8000 });
    assert(Date.now() - t1 < 8000 && (await W.locator('[data-testid="diag-step-server"]').getAttribute('data-state')) === 'ok', 'wrong code: server ok, room not found, within seconds');
    assert(/Klopt de code/.test(await W.getByTestId('diag-advice').textContent()), 'wrong code: plain advice');
    const t2 = await copyDiag(W);
    assert(/2\. Kamer gevonden: FOUT .*\[notfound\]/.test(t2) && /1\. Server bereikt: ok/.test(t2), 'diagnosis per step for a wrong code');
    await shot(W, '94-server-wrong-code');

    // ---------- a sleeping server: "server wordt wakker…" ----------
    const sleepy = await mk();
    const Z = sleepy.page;
    let slowUntil = 0; // the "sleeping host" answers /health only after this moment
    await sleepy.context.route('**/health', async (route) => {
      const wait = slowUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await route.continue();
    });
    await Z.goto(`${server.url}#/kamer/${code}`);
    await Z.getByTestId('join-name').fill('Zoë');
    slowUntil = Date.now() + 7000;
    await Z.getByTestId('join-submit').click();
    await Z.getByTestId('server-waking').waitFor({ timeout: 8000 });
    await Z.waitForTimeout(1500);
    await shot(Z, '95-server-waking');
    assert(true, 'slow server: "Server wordt wakker…" with progress');
    await waitView(Z, 'revealed', 30000);
    assert(true, 'and the player gets in once it is awake');

    // ---------- protocol version ----------
    const reply = await B.evaluate(async ([url, roomCode]) => new Promise((resolve) => {
      const ws = new WebSocket(`${url.replace('http', 'ws')}/rooms/${roomCode}/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 0, code: roomCode, id: 'oldapp123', name: 'Oud' }));
      ws.onmessage = (e) => { if (e.data !== 'pong') { resolve(JSON.parse(e.data)); ws.close(); } };
      setTimeout(() => resolve(null), 8000);
    }), [rooms.url, code]);
    assert(reply?.t === 'error' && reply.code === 'version' && /Ververs/.test(reply.message), 'an old app gets a clear version message');

    // ---------- leak check over everything the players received ----------
    for (const [p, n] of [[A, 'Anouk'], [B, 'Bram'], [C, 'Cas']]) {
      const msgs = await received(p);
      const t = JSON.stringify(msgs);
      if (t.includes('"lead":') || msgs.some((m) => m.t === 'backup' || m.t === 'welcome' && m.owner)) throw new Error(`${n} got leader data`);
      if (/previewUrl|itunesId|spotifyId/.test(t)) throw new Error(`${n} got playback fields`);
    }
    assert(true, 'no player ever received leader data, backups or playback fields');

    const errors = pages.flatMap((p) => p.errors || []);
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
    for (const p of [A, B, D, W]) {
      const w = await p.evaluate(() => document.documentElement.scrollWidth);
      if (w > 390) throw new Error(`horizontal scroll (${w}px)`);
    }
    assert(true, 'no horizontal scroll on 390 px');
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
