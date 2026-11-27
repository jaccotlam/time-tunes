// "Groot scherm" (#/scherm/CODE): the display-only tv screen of a room, through the Node room server.
//
//  1. the owner's set-up: ONE browser context, two tabs: the spelleider (1280×720) and the display
//     (1920×1080) opened through the host's "Open het grote scherm" link; phones in own contexts.
//     The display writes nothing to localStorage and leaves the host's identity keys as they were;
//     reloading either tab brings each back in its own role; the host tab shows "Groot scherm
//     verbonden" while a display is up;
//  2. the lobby on the display: code, QR, join link, players popping in, offline marks, the game label;
//  3. a whole Discobingo game followed on the display (moments spin > listen > answers > ranking,
//     answered counts, the reveal, doubts that flip live, "close" / bingo / won rankings, no scrollbars
//     at 1920×1080 and 1280×720);
//  4. no peeking: every frame the display receives and its DOM before each reveal;
//  5. a player who leaves on purpose (session.leave()) and comes back two rounds later;
//  6. robustness: a room that does not exist, the code prompt, the 5th display, the PeerJS route,
//     a room server killed and restarted in the middle of a game;
//  7. a Quiz question and a classic Bingo round on the generic screens.
//
// The phones are driven through their page's own session (window.__ttRoom.session: answer / stamp /
// leave), never through the phone UI (which is being redesigned); the host tab and the display are
// used through their UI. Deterministic: seed 7 (timetunesr.multiSeed.v1), a generated playlist.
import { join } from 'node:path';
import { launch, startServer, assert, OUT } from './helpers.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';
import { bestSquare } from '../../app/js/multi/disco.js';
import { artistVerdict, titleVerdict } from '../../app/js/multi/match.js';

// ---------- a playlist of 30 songs with names that can be typed wrongly ----------
const A1 = ['Blauwe', 'Gouden', 'Rode', 'Stille', 'Wilde', 'Zilveren', 'Zwarte', 'Kleine', 'Grote', 'Late'];
const A2 = ['Draaiers', 'Fietsers', 'Molens', 'Schaatsers', 'Bakkers', 'Stromen', 'Dromers', 'Zeilers', 'Vissers', 'Dansers'];
const T1 = ['Dansen', 'Zingen', 'Vliegen', 'Dromen', 'Lopen', 'Zwemmen'];
const T2 = ['onder', 'boven', 'naast', 'langs', 'tussen', 'achter', 'voorbij'];
const T3 = ['de sterren', 'het water', 'de regen', 'mijn straat', 'de maan'];
const TRACKS = Array.from({ length: 30 }, (_, i) => ({
  n: i + 1,
  itunesId: 7900000 + i,
  title: `${T1[i % 6]} ${T2[i % 7]} ${T3[i % 5]}`,
  artist: `${A1[i % 10]} ${A2[(i * 3 + Math.floor(i / 10)) % 10]}`,
  year: 1960 + ((i * 7) % 58),
  previewUrl: `https://audio-ssl.itunes.apple.com/fake/s${i}.m4a`,
}));
const verdictFn = (kind) => (kind === 'artist' ? artistVerdict : titleVerdict);
/** A near miss the machine does not accept by itself: the spelleider decides. */
function doubtOf(kind, real) {
  const w = real.split(' ');
  const tries = kind === 'artist' ? [w[w.length - 1], w[0]] : [w.slice(0, -1).join(' '), w.slice(1).join(' ')];
  return tries.find((t) => verdictFn(kind)(t, real).verdict === 'doubt') || null;
}
for (const t of TRACKS) {
  for (const [kind, real] of [['artist', t.artist], ['title', t.title]]) {
    if (!doubtOf(kind, real)) throw new Error(`fixture: no near-miss for "${real}"`);
    if (verdictFn(kind)(real, real).verdict !== 'right') throw new Error(`fixture: "${real}" is not right`);
  }
}

// ---------- small helpers ----------
/** Failures of assertions that are kept but must not stop the run (real app bugs): the run fails at the end. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TV = { width: 1920, height: 1080 };
const HOST_TV = { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, userAgent: undefined };
const attr = (page, testid, name) => page.getByTestId(testid).getAttribute(name);
const pview = (p) => p.page.evaluate(() => window.__ttRoom?.session?.view || null);
const sview = (D) => D.evaluate(() => window.__ttScreen?.session?.view || null);
const hspec = (H) => H.evaluate(() => window.__ttHost?.session?.spectatorView() || null);
const ID_KEYS = ['timetunesr.multiHostId.v1', 'timetunesr.multiServerHost.v1', 'timetunesr.multiTokens.v1', 'timetunesr.multiPlayerId.v1',
  'timetunesr.multiJoin.v1', 'timetunesr.multiSeat.v1', 'timetunesr.multiServer.v1', 'timetunesr.multiSeed.v1'];
const identity = (p) => p.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), ID_KEYS);
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `screen-${name}.png`), animations: 'disabled' });
}

/**
 * In the display tab only (hash #/scherm…): count every localStorage write, a log of the
 * display's moments per round, and a check that nothing of the running song is in its DOM.
 * Registered last, so the test's own set-up writes (seed, server) are not counted.
 */
function displayGuard() {
  if (!/^#\/scherm/.test(location.hash)) return;
  const writes = (window.__lsWrites = []);
  const sp = Storage.prototype;
  for (const m of ['setItem', 'removeItem', 'clear']) {
    const orig = sp[m];
    sp[m] = function guarded(...a) {
      let mine = false;
      try { mine = this === window.localStorage; } catch { /* no access to storage here */ }
      if (mine) writes.push([m, String(a[0])]);
      return orig.apply(this, a);
    };
  }
  window.__guard = true;
  const log = (window.__log = []);
  const leaks = (window.__leaks = []);
  window.__secret = null;
  window.__badSpin = [];
  let last = '';
  setInterval(() => {
    const el = document.querySelector('[data-testid="screen-display"]');
    const v = window.__ttScreen?.session?.view;
    if (!el || !v) return;
    const key = `${v.game?.round ?? '-'}|${el.dataset.phase}|${el.dataset.moment || ''}`;
    if (key !== last) { last = key; log.push(key); }
    if (el.dataset.moment === 'spin') {
      const c = document.querySelector('[data-testid="disco-category"]')?.dataset.cat;
      if (c) window.__badSpin.push(c);
    }
  }, 30);
  setInterval(() => {
    const s = window.__secret;
    const v = window.__ttScreen?.session?.view;
    if (!s || !v || v.phase !== 'answering' || v.game?.round !== s.round) return;
    const html = document.documentElement.outerHTML;
    for (const t of s.list) if (t && html.includes(t)) leaks.push(`round ${s.round}: "${t}"`);
  }, 120);
}

/** The owner's browser context: spelleider tab (1280×720) that will also hold the display tab. */
async function owner(browser, rooms) {
  const host = await phone(browser, rooms, { seed: 7, ...HOST_TV });
  await installFakeItunes(host.context);
  await host.context.addInitScript((tracks) => {
    try {
      if (localStorage.getItem('tt.screenInit')) return;
      localStorage.setItem('tt.screenInit', '1');
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'feest', name: 'Feestmix', tracks }] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('feest'));
    } catch { /* a document without storage (about:blank) */ }
  }, TRACKS);
  await host.context.addInitScript(displayGuard);
  return { context: host.context, H: host.page, errors: [], lsWrites: [] };
}

/** Click "Open het grote scherm" and return the new tab (frames of its WebSocket are collected). */
async function openDisplay(o, code) {
  const link = o.H.getByTestId('host-open-screen');
  const href = await link.getAttribute('href');
  assert(/#\/scherm\/[A-Z]{4}$/.test(href) && href.endsWith(`#/scherm/${code}`), `"Open het grote scherm" links to #/scherm/${code} (${href})`);
  assert(await link.getAttribute('target') === '_blank', 'the link opens a new tab (target _blank)');
  const frames = [];
  const onPage = (pg) => {
    pg.on('websocket', (ws) => ws.on('framereceived', (f) => { if (typeof f.payload === 'string') frames.push(f.payload); }));
    pg.on('pageerror', (e) => o.errors.push(`display: ${e.message}`));
  };
  o.context.on('page', onPage);
  const [D] = await Promise.all([o.context.waitForEvent('page'), link.click()]);
  o.context.off('page', onPage);
  D.frames = frames;
  await D.setViewportSize(TV);
  await D.locator('[data-testid="screen-display"][data-status="online"]').waitFor({ timeout: 20000 });
  return D;
}
/** Collect the display's localStorage writes (it is about to reload or close). */
async function takeWrites(o, D) {
  const w = await D.evaluate(() => ({ guard: !!window.__guard, writes: window.__lsWrites || [] })).catch(() => null);
  if (w) { o.lsWrites.push(...w.writes); return w.guard; }
  return null;
}

function assertNeverLeaks(frames, label) {
  assert(frames.length > 5, `${label}: the display received ${frames.length} frames`);
  for (const raw of frames) {
    for (const bad of ['"lead":', 'previewUrl', 'itunesId']) {
      if (raw.includes(bad)) throw new Error(`ASSERT: ${label}: a frame holds ${bad}: ...${raw.slice(Math.max(0, raw.indexOf(bad) - 80), raw.indexOf(bad) + 80)}...`);
    }
  }
  assert(true, `${label}: no frame ever held "lead", previewUrl or itunesId`);
}
/** No frame in frames[from, to) holds one of the forbidden texts. */
function assertNoPeek(frames, from, to, forbidden, label) {
  assert(to - from > 0, `${label}: frames to check (${to - from})`);
  for (const raw of frames.slice(from, to)) {
    for (const f of forbidden) {
      if (f && raw.includes(JSON.stringify(f).slice(1, -1))) throw new Error(`ASSERT: ${label}: the display received "${f}" before the reveal: ...${raw.slice(Math.max(0, raw.indexOf(f) - 100), raw.indexOf(f) + 80)}...`);
    }
  }
  assert(true, `${label}: ${to - from} frames before the reveal hold neither the song nor typed answers`);
}
async function assertDomClean(D, forbidden, label) {
  const html = await D.evaluate(() => document.documentElement.outerHTML);
  for (const f of forbidden) if (f && html.includes(f)) throw new Error(`ASSERT: ${label}: "${f}" is in the display's DOM before the reveal`);
  assert(true, `${label}: the display's DOM holds neither the song nor typed answers`);
}

/** No scrollbars at 1920×1080 and 1280×720; the display goes back to 1920×1080. */
async function noScroll(D, label) {
  for (const size of [TV, { width: 1280, height: 720 }]) {
    await D.setViewportSize(size);
    await D.waitForTimeout(250);
    const r = await D.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth }));
    assert(r.sh <= r.ih && r.sw <= r.iw, `${label} at ${size.width}×${size.height}: no scrollbars (scroll ${r.sw}×${r.sh} in ${r.iw}×${r.ih})`);
  }
  await D.setViewportSize(TV);
}

async function waitCount(D, done, total, timeout = 10000) {
  try {
    await D.waitForFunction(([d, t]) => {
      const e = document.querySelector('[data-testid="screen-count"]');
      return !!e && Number(e.dataset.done) === d && Number(e.dataset.total) === t;
    }, [done, total], { timeout });
  } catch (e) {
    const now = await D.evaluate(() => ({ count: { ...document.querySelector('[data-testid="screen-count"]')?.dataset }, players: window.__ttScreen.session.view.players.map((p) => `${p.name}:${p.online ? 'on' : 'off'}:${p.playing ? 'play' : '-'}:${p.answered ? 'ans' : '-'}`) }));
    throw new Error(`ASSERT: the display's "x van y" is not ${done} van ${total}: ${JSON.stringify(now)}`);
  }
}
const waitDisplayRound = (D, round, phase) => D.waitForFunction(([r, ph]) => {
  const v = window.__ttScreen?.session?.view;
  return v?.phase === ph && v.game?.round === r;
}, [round, phase], { timeout: 30000 });
const tile = (D, name, a, v) => D.locator(`[data-testid="screen-player"][data-name="${name}"][data-${a}="${v}"]`).waitFor({ timeout: 10000 });
const send = (p, ans) => p.page.evaluate((a) => window.__ttRoom.session.answer(a), ans);

/** What a phone sends for `how` in a Discobingo round of category `cat`. */
function discoAnswer(cat, song, how, round) {
  if (how === 'pass') return { pass: true };
  if (cat === 'exact') return { guess: how === 'wrong' ? song.year + 1 : song.year };
  if (cat === 'year') return { guess: how === 'wrong' ? song.year + 8 : song.year };
  const real = cat === 'artist' ? song.artist : song.title;
  return { text: how === 'wrong' ? `Raar antwoord ${round}` : how === 'doubt' ? doubtOf(cat, real) : real };
}
/** A right answer: stamp the best square of the round's category (and wait for the server). */
async function stampBest(p) {
  try {
    await p.page.waitForFunction(() => { const d = window.__ttRoom?.session?.view?.game?.disco; return (d?.choosable?.length || 0) > 0 || d?.noSquare; }, null, { timeout: 5000 });
  } catch { return null; }
  const v = await pview(p);
  const d = v.game.disco;
  if (!d.choosable?.length || d.choice != null) return null;
  const marks = v.game.mine.marks.slice();
  const pick = bestSquare(v.game.mine.card, marks, d.cat, d.win);
  const i = d.choosable.includes(pick) ? pick : d.choosable[0];
  await p.page.evaluate((x) => window.__ttRoom.session.stamp(x), i);
  await p.page.waitForFunction((x) => window.__ttRoom?.session?.view?.game?.disco?.choice === x, i, { timeout: 8000 });
  return i;
}
const verdictWord = { right: 'right', wrong: 'wrong', pass: 'pass', doubt: 'doubt' };

// ======================================================================================
//  The big game: lobby, a whole Discobingo, the leaver, the code prompt, 5 displays
// ======================================================================================
async function mainGame(browser, rooms, server) {
  const o = await owner(browser, rooms);
  const H = o.H;
  o.context.on('page', (pg) => { if (pg !== H) pg.on('dialog', (d) => d.accept()); });
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const idBefore = await identity(H);
  assert(!!idBefore['timetunesr.multiServerHost.v1'] && !!idBefore['timetunesr.multiHostId.v1'], 'the host tab has stored its identity (server host key, host id)');

  // ----- host tab: the screen box -----
  await H.getByTestId('host-screenbox').waitFor();
  assert(await H.getByTestId('host-share').isVisible() && /#\/scherm\/[A-Z]{4}/.test(await H.getByTestId('host-screen-link').textContent()), 'the host tab offers "Deel" and a copyable link to the display');
  assert(await H.getByTestId('host-screen-connected').count() === 0, 'no display yet: no "Groot scherm verbonden"');
  const hostLink = (await H.getByTestId('room-link').textContent()).trim();

  // ----- the display opens (own tab, same browser) -----
  let D = await openDisplay(o, code);
  await H.getByTestId('host-screen-connected').waitFor({ timeout: 10000 });
  assert(await attr(H, 'host-screen-connected', 'data-count') === '1', 'the host tab shows "Groot scherm verbonden" (1)');
  assert(await D.evaluate(() => window.innerWidth) === 1920 && await H.evaluate(() => window.innerWidth) === 1280, 'host tab 1280 wide, display 1920 wide');
  assert((await D.getByTestId('screen-display').getAttribute('data-phase')) === 'lobby' && (await D.getByTestId('screen-display').getAttribute('data-code')) === code, 'the display is on the lobby of the room');

  // ----- lobby on the display -----
  assert((await D.getByTestId('screen-code').textContent()).replace(/\s/g, '') === code, `the display shows the code ${code}`);
  const qr = D.getByTestId('screen-qr');
  const qbox = await qr.boundingBox();
  assert(await qr.locator('svg path').count() > 0 && qbox.width >= 300 && qbox.height >= 300, `a big QR code (${Math.round(qbox.width)}×${Math.round(qbox.height)})`);
  assert(await attr(D, 'screen-join-url', 'data-url') === hostLink, `the display's join link equals the room link (${hostLink})`);
  assert(await D.getByTestId('screen-empty').isVisible() && await attr(D, 'screen-count', 'data-count') === '0', 'no players yet: "Nog niemand binnen"');
  assert(await D.getByTestId('screen-fullscreen').count() === 1 && await D.getByTestId('screen-code-form').count() === 0, 'the display has a fullscreen button and no code form, no controls');
  await shot(D, '01-lobby-empty');
  // the display must not write to localStorage: a probe proves that the guard sees writes
  const probe = await D.evaluate(() => { localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); const n = window.__lsWrites.length; window.__lsWrites.length = 0; return n; });
  assert(probe === 2, 'control: the localStorage guard in the display tab sees writes');

  // ----- reload the display, reload the host: each comes back in its own role -----
  await takeWrites(o, D);
  await D.reload();
  await D.locator('[data-testid="screen-display"][data-status="online"][data-phase="lobby"]').waitFor({ timeout: 20000 });
  assert(await D.getByTestId('screen-code').count() === 1 && await D.getByTestId('room-player').count() === 0, 'reloaded display: still the display of the room (no player, no host)');
  await H.reload();
  await H.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 20000 });
  await H.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 20000 });
  assert((await H.getByTestId('room-code-big').textContent()).trim() === code, 'reloaded host tab: the same room, as the spelleider');
  await H.getByTestId('host-screen-connected').waitFor({ timeout: 10000 });
  assert(await attr(H, 'host-screen-connected', 'data-count') === '1', 'after both reloads the host still sees the display (1)');

  // ----- closing the display tab: the indicator goes away; open it again -----
  const guardOk = await takeWrites(o, D);
  assert(guardOk === true, 'the display tab had the localStorage guard');
  await D.close();
  await H.getByTestId('host-screen-connected').waitFor({ state: 'detached', timeout: 10000 });
  assert(true, 'the display tab closed: "Groot scherm verbonden" is gone');
  D = await openDisplay(o, code);
  await H.getByTestId('host-screen-connected').waitFor({ timeout: 10000 });

  // ----- players join: they appear on the display -----
  const joined = {};
  const join = async (name, opts = {}) => {
    const p = await phone(browser, rooms, opts);
    p.page.on('pageerror', (e) => o.errors.push(`${name}: ${e.message}`));
    await joinRoom(p.page, server.url, code, name, { via: 'link' });
    joined[name] = p;
    return p;
  };
  const A = await join('Anouk');
  await tile(D, 'Anouk', 'online', 'true');
  assert(await attr(D, 'screen-count', 'data-count') === '1' && await D.getByTestId('screen-empty').count() === 0, 'Anouk joins: "1 speler binnen", the empty hint is gone');
  const B = await join('Bram');
  const C = await join('Cas');
  const Dk = await join('Dirk');
  await waitForPlayers(H, 4);
  await D.waitForFunction(() => document.querySelector('[data-testid="screen-count"]')?.dataset.count === '4', null, { timeout: 10000 });
  assert(await D.getByTestId('screen-player').count() === 4 && /4 spelers binnen/.test(await D.getByTestId('screen-count').textContent()), 'four names on the display: "4 spelers binnen"');
  await Dk.context.close(); // the phone dies
  await tile(D, 'Dirk', 'online', 'false');
  await D.waitForFunction(() => document.querySelector('[data-testid="screen-count"]')?.dataset.offline === '1', null, { timeout: 10000 });
  assert(/1 offline/.test(await D.getByTestId('screen-count').textContent()) && await D.locator('[data-testid="screen-player"][data-online="true"]').count() === 3, 'Dirk went offline: marked offline on the display, the others online');

  // the chosen game follows the host's choice
  const gameLabels = [['bingo', 'Bingo'], ['timeline', 'Tijdlijn'], ['quiz', 'Quiz'], ['disco', 'Discobingo']];
  for (const [val, label] of gameLabels) {
    const radio = H.getByTestId(`room-game-${val}`);
    await radio.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await radio.check();
    await D.locator(`[data-testid="screen-game"][data-game="${val}"]`).waitFor({ timeout: 10000 });
    assert((await D.getByTestId('screen-game').textContent()).includes(label), `the host picks ${label}: the display says ${label} (${(await D.getByTestId('screen-game').textContent()).trim()})`);
  }
  assert(/eerste bingo bij 1 lijn/.test(await D.getByTestId('screen-game').textContent()), 'Discobingo on the display: "eerste bingo bij 1 lijn"');
  // this game reveals by hand (the automatic reveal has its own game in multi-disco.e2e.mjs)
  await H.getByTestId('room-disco-auto').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await H.getByTestId('room-disco-auto').uncheck();
  await D.waitForFunction(() => window.__ttScreen?.session?.view?.settings?.autoReveal === false, null, { timeout: 10000 });
  await shot(D, '02-lobby-players');
  await noScroll(D, 'lobby');

  // ----- the game -----
  const S = { goodDoubt: false, badDoubt: false, reasons: new Set(), returned: false, left: false, cats: [], doubtShown: false };
  let leaverBefore = null;
  const reloadRound = 1;
  let from = D.frames.length;
  await H.getByTestId('room-start').click();
  let finished = false;
  for (let round = 1; round <= 12 && !finished; round++) {
    await H.waitForFunction((r) => { const v = window.__ttHost?.session?.spectatorView(); return v?.phase === 'answering' && v.game.round === r; }, round, { timeout: 30000 });
    const { song } = await serverHost(H);
    const cat = (await hspec(H)).game.disco.cat;
    S.cats.push(cat);
    await D.evaluate(([r, l]) => { window.__secret = { round: r, list: l }; }, [round, [song.title, song.artist]]);
    await waitDisplayRound(D, round, 'answering');

    // Cas comes back (two rounds after leaving)
    if (round === 4 && S.left) {
      await C.page.goto('about:blank');
      await C.page.goto(`${server.url}#/kamer/${code}`);
      const t0 = Date.now();
      for (;;) {
        if (await C.page.evaluate(() => !!window.__ttRoom?.session?.view?.game?.mine)) break;
        const back = C.page.getByTestId('room-back-to-seat'); // the join page may offer "Terug naar kamer"
        if (await back.count() && await back.isVisible().catch(() => false)) await back.click().catch(() => {});
        if (Date.now() - t0 > 20000) throw new Error('ASSERT: Cas did not get back into the room (#/kamer/CODE after leaving)');
        await sleep(200);
      }
      await C.page.waitForFunction((r) => window.__ttRoom.session.view.game.round === r && window.__ttRoom.session.view.phase === 'answering', round, { timeout: 15000 });
      const after = await pview(C);
      assert(JSON.stringify(after.game.mine.card) === leaverBefore.card && JSON.stringify(after.game.mine.marks) === leaverBefore.marks,
        `Cas is back (round ${round}): the same card and the same stamps as when she left`);
      await tile(D, 'Cas', 'online', 'true');
      S.returned = true;
    }
    const casOnline = round !== 3 || !S.left || S.returned; // Cas is away in round 3 only
    let total0 = casOnline ? 3 : 2;

    // the display: spin, then listen with the category of the host
    await D.locator('[data-testid="screen-display"][data-moment="listen"]').waitFor({ timeout: 15000 });
    const hostCat = await attr(H, 'disco-category', 'data-cat');
    assert(await attr(D, 'disco-category', 'data-cat') === cat && hostCat === cat, `round ${round}: category ${cat} on the display and on the host`);
    assert(await D.getByTestId('screen-listen').isVisible(), `round ${round}: "Luister…" on the display`);
    await waitCount(D, 0, total0);

    // ----- answers -----
    const hows = { Anouk: 'right' };
    if (['artist', 'title'].includes(cat)) hows.Bram = !S.goodDoubt ? 'doubt' : !S.badDoubt ? 'doubt' : 'wrong';
    else hows.Bram = round % 2 ? 'wrong' : 'right';
    hows.Cas = round === 1 ? 'right' : 'pass';
    const typed = [];
    const give = async (p, name) => {
      const ans = discoAnswer(cat, song, hows[name], round);
      if (ans.text) typed.push(ans.text);
      await send(p, ans);
      if (ans.text) await D.evaluate((t) => window.__secret.list.push(t), ans.text);
    };
    await give(A, 'Anouk');
    await waitCount(D, 1, total0);
    await tile(D, 'Anouk', 'answered', 'true');
    assert(/1 van \d+ heeft geantwoord/.test((await D.getByTestId('screen-count').textContent()).replace(/\s+/g, ' ')), `round ${round}: "1 van ${total0} heeft geantwoord" follows Anouk's answer`);
    if (round === reloadRound) {
      await shot(D, '03-listen');
      await noScroll(D, 'listen');
      // reload the display in the middle of a question: it lands on the right moment, no spin again
      await takeWrites(o, D);
      await D.reload();
      await D.locator('[data-testid="screen-display"][data-status="online"][data-moment="listen"]').waitFor({ timeout: 20000 });
      await D.evaluate(([r, l]) => { window.__secret = { round: r, list: l }; }, [round, [song.title, song.artist, ...typed]]);
      await waitCount(D, 1, total0);
      await tile(D, 'Anouk', 'answered', 'true');
      assert(true, 'reloaded display (while listening): straight back on "Luister…" with 1 answered');
    }
    if (round === 2) {
      // Cas leaves on purpose while the question is open
      leaverBefore = await pview(C).then((v) => ({ card: JSON.stringify(v.game.mine.card), marks: JSON.stringify(v.game.mine.marks) }));
      assert(leaverBefore.marks.replace(/null|\[|\]|,/g, '') !== '', 'Cas has stamps from round 1 (to compare after coming back)');
      const res = await C.page.evaluate(() => window.__ttRoom.session.leave());
      assert(res?.seat === true, 'leaving during a game keeps the seat (leave() says seat: true)');
      S.left = true;
      await tile(D, 'Cas', 'online', 'false');
      total0 = 2;
      // the count follows presence at once: an away player is never somebody the room waits for
      await waitCount(D, 1, 2, 4000);
      assert(true, 'Cas left: offline on the display and "1 van 2" (only online players count)');
    } else if (casOnline && round !== 2) {
      await give(C, 'Cas');
      await waitCount(D, 2, total0);
    }
    await give(B, 'Bram');
    await waitCount(D, total0, total0);
    assert(await D.locator('.s-count.is-all').count() === 1 && /Iedereen heeft geantwoord/.test(await D.getByTestId('screen-count').textContent()), `round ${round}: everybody online has answered: "Iedereen heeft geantwoord!"`);
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 8000 });
    assert(true, `round ${round}: the host's Onthul is ready (players who are away do not block it)`);

    // ----- no peeking before the reveal -----
    const forb = [song.title, song.artist, ...typed];
    assertNoPeek(D.frames, from, D.frames.length, forb, `round ${round}`);
    await assertDomClean(D, forb, `round ${round}`);

    // ----- reveal -----
    await H.getByTestId('room-reveal').click();
    await waitDisplayRound(D, round, 'revealed');
    const sg = D.getByTestId('screen-song');
    await sg.waitFor();
    const st = (await sg.textContent()).replace(/\s+/g, ' ');
    assert(st.includes(song.title) && st.includes(song.artist) && st.includes(String(song.year)), `round ${round}: the display shows the song: ${song.year} · ${song.artist} · ${song.title}`);
    assert(await sg.locator('[data-testid="answer-year"]').count() === 1 && await sg.locator('[data-testid="answer-artist"]').count() === 1 && await sg.locator('[data-testid="answer-title"]').count() === 1, `round ${round}: year, artist and title blocks`);
    await D.getByTestId('screen-results').waitFor();
    for (const nm of ['Anouk', 'Bram']) {
      const exp = verdictWord[hows[nm]];
      await D.locator(`[data-testid="screen-result"][data-name="${nm}"][data-verdict="${exp}"]`).waitFor({ timeout: 8000 });
    }
    assert(true, `round ${round}: verdicts on the display: Anouk ${hows.Anouk}, Bram ${hows.Bram}`);
    if (round === 1) { await shot(D, '04-answers'); await noScroll(D, 'answers'); }

    // ----- a doubt: shown as doubt, flips live when the host judges -----
    if (hows.Bram === 'doubt') {
      assert(await attr(D, 'screen-results', 'data-doubts') === '1' && /twijfelgeval/.test(await D.getByTestId('screen-pending').textContent()), `round ${round}: a doubt on the display: "de spelleider beslist over een twijfelgeval"`);
      assert(await D.locator('[data-testid="screen-result"][data-name="Bram"] .sr-verdict').textContent().then((t) => /Twijfel/.test(t)), 'Bram\'s row says Twijfel');
      await sleep(600);
      assert(await attr(D, 'screen-display', 'data-moment') === 'answers', 'no ranking while a doubt is open');
      const good = !S.goodDoubt;
      const rowOf = Number(await H.locator('[data-testid="disco-regie-row"][data-name="Bram"]').getAttribute('data-row'));
      await H.getByTestId(`disco-judge-${good ? 'good' : 'bad'}-${rowOf}`).click();
      await D.locator(`[data-testid="screen-result"][data-name="Bram"][data-verdict="${good ? 'right' : 'wrong'}"][data-judged="true"]`).waitFor({ timeout: 8000 });
      assert(await attr(D, 'screen-results', 'data-doubts') === '0', `the host says ${good ? 'Goed' : 'Fout'}: the display flips Bram's doubt to ${good ? 'right' : 'wrong'} live`);
      if (good) { S.goodDoubt = true; hows.Bram = 'right'; } else { S.badDoubt = true; hows.Bram = 'wrong'; }
      S.doubtShown = true;
    }

    // ----- right answers choose a square -----
    const stamped = {};
    for (const [nm, p] of [['Anouk', A], ['Bram', B], ['Cas', C]]) {
      if (hows[nm] !== 'right' || (nm === 'Cas' && S.left && !S.returned)) continue;
      stamped[nm] = await stampBest(p);
    }
    // (a chip that makes bingo switches the display to the bingo stop instead)
    if (stamped.Anouk != null) await D.locator('[data-testid="screen-result"][data-name="Anouk"][data-stamp="stamped"], [data-testid="screen-bingo"]').first().waitFor({ timeout: 8000 });
    assert(stamped.Anouk != null, `round ${round}: Anouk stamped square ${stamped.Anouk}, the display says "afgestempeld"`);

    // ----- the ranking moment: when it gets exciting, at a bingo, every third round -----
    const sv = await sview(D);
    const prog = sv.game.disco.progress;
    const bingoNow = prog.some((p) => p.bingo) || (sv.game.reveal.roundWinners || []).length > 0;
    const closeNow = prog.filter((p) => !p.bingo && p.toGo === 1).map((p) => p.name);
    const reason = bingoNow ? 'bingo' : closeNow.length ? 'close' : round % 3 === 0 ? 'round' : '';
    if (bingoNow) {
      // a bingo stops the game: BINGO on the display at once, with the winner's card and line
      await D.locator('[data-testid="screen-display"][data-moment="bingo"]').waitFor({ timeout: 8000 });
      const bn = sv.game.disco.bingo.winners[0].name;
      assert(new RegExp(`${bn} heeft 1 lijn`).test(await D.getByTestId('screen-bingo-who').textContent()), `round ${round}: the display says "${bn} heeft 1 lijn"`);
      assert(await D.locator('[data-testid="screen-bingo-card-0"] [data-goal="true"]').count() >= 5, 'the winning line is lit on the winner\'s card on the display');
      assert(/doorgaan voor 2 lijnen of een volle kaart, of stoppen/.test(await D.getByTestId('screen-bingo-next').textContent()), 'the display says what the leader may choose');
      assert(await H.getByTestId('room-next').count() === 0 && await H.getByTestId('disco-finish').isVisible(), 'the host: no next song, but the bingo choices');
      await shot(D, '05-bingo-stop');
      await noScroll(D, 'bingo stop');
      S.reasons.add('bingo');
    } else if (reason && !S.reasons.has(reason)) {
      S.reasons.add(reason);
      await D.locator('[data-testid="screen-display"][data-moment="ranking"]').waitFor({ timeout: 16000 });
      const rk = D.getByTestId('screen-ranking');
      assert(await rk.getAttribute('data-reason') === reason, `round ${round}: the ranking moment arrives with reason "${reason}"`);
      assert(await D.getByTestId('screen-progress-row').count() === prog.length, 'the ranking lists everybody');
      if (reason === 'close') {
        const row = D.locator(`[data-testid="screen-progress-row"][data-name="${closeNow[0]}"]`);
        assert(await row.getAttribute('data-close') === 'true' && await row.getAttribute('data-togo') === '1', `"Spannend!": ${closeNow[0]} is one square from the goal and highlighted`);
        assert(/nog 1 vakje nodig/.test(await rk.textContent()), 'the headline says "nog 1 vakje nodig"');
      }
      if (reason === 'bingo') {
        const bn = prog.find((p) => p.bingo)?.name;
        assert(await D.locator(`[data-testid="screen-progress-row"][data-name="${bn}"]`).getAttribute('data-bingo') === 'true', `BINGO: ${bn} is marked in the ranking`);
      }
      await shot(D, `05-ranking-${reason}`);
      await noScroll(D, `ranking (${reason})`);
    } else if (!reason) {
      assert(await attr(D, 'screen-display', 'data-moment') === 'answers', `round ${round}: nothing exciting: the answers stay, no ranking`);
    }

    // ----- next round (or the end) -----
    // the sampled moments of this round: spin > listen while answering, answers (> ranking) after the reveal
    const log = await D.evaluate(() => window.__log.splice(0));
    const mine = log.filter((l) => l.startsWith(`${round}|`));
    const answering = mine.filter((l) => l.includes('|answering|')).map((l) => l.split('|')[2]);
    const revealed = mine.filter((l) => l.includes('|revealed|')).map((l) => l.split('|')[2]);
    const seqOk = (seq, want) => JSON.stringify(seq.filter((x, i) => x && seq.indexOf(x) === i)) === JSON.stringify(want);
    if (round !== reloadRound) assert(seqOk(answering, ['spin', 'listen']), `round ${round}: the display's moments while the song plays: ${answering.join(' > ')} (spin > listen)`);
    else assert(answering.includes('listen') && !answering.includes('ranking') && !answering.includes('answers'), `round ${round}: the display's moments while the song plays: ${answering.join(' > ')}`);
    assert(revealed[0] === 'answers' && !revealed.slice(1).some((m) => m !== 'ranking' && m !== 'answers' && m !== 'bingo'), `round ${round}: after the reveal: ${revealed.join(' > ')} (answers first, ranking or the bingo after)`);
    assert(!answering.includes('ranking'), `round ${round}: no ranking while a song plays`);
    from = D.frames.length;
    // going on while an online player still has to lay a chip: the dialog first ("Toch doorgaan")
    const waitingNow = ((await sview(D)).game.disco.chips || []).filter((c) => c.state === 'choosing').length;
    await H.getByTestId(bingoNow ? 'disco-finish' : 'room-next').click();
    if (waitingNow) { await H.getByTestId('disco-confirm').waitFor({ timeout: 5000 }); await H.getByTestId('disco-confirm-go').click(); }
    if (bingoNow) {
      // "Stop: naar de prijsuitreiking"
      finished = true;
      await D.locator('[data-testid="screen-display"][data-phase="won"]').waitFor({ timeout: 10000 });
    }
  }
  assert(finished, 'the game ended with a bingo');
  assert(S.reasons.has('bingo') && S.reasons.has('close'), `rankings seen on the display: ${[...S.reasons].join(', ')} (close and bingo)`);
  assert(S.goodDoubt && S.badDoubt, 'both a doubt that became Goed and one that became Fout were followed live');
  assert(S.returned, 'Cas left in round 2 and came back in round 4');
  const bad = await D.evaluate(() => ({ spin: window.__badSpin, leaks: window.__leaks }));
  assert(bad.spin.length === 0, `no category named while the ball is still spinning (${bad.spin.join(',')})`);
  assert(bad.leaks.length === 0, `the DOM of the display never held the running song or typed text (${bad.leaks.join('; ')})`);

  // ----- the winner -----
  await D.getByTestId('screen-winner').waitFor({ timeout: 10000 });
  assert((await attr(D, 'screen-winner', 'data-names')).split('|').includes('Anouk'), 'the winner screen names Anouk');
  assert(await attr(D, 'screen-ranking', 'data-reason') === 'won' && await D.locator('[data-testid="screen-progress-row"][data-name="Anouk"][data-bingo="true"]').count() === 1, 'the winner screen has the final ranking with Anouk\'s BINGO');
  assert(await attr(D, 'screen-display', 'data-phase') === 'won', 'the display is in phase won');
  await shot(D, '06-won');
  await noScroll(D, 'won');
  assertNeverLeaks(D.frames, 'the whole game');

  // ----- robustness on the finished room -----
  // a display on a room that does not exist: waits and keeps asking
  const plain = await phone(browser, rooms, { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, userAgent: undefined });
  const X = plain.page;
  let asked = 0;
  X.on('request', (r) => { if (/\/rooms\/ZZZZ(\?|$)/.test(r.url())) asked++; });
  await X.goto(`${server.url}#/scherm/ZZZZ`);
  await X.getByTestId('screen-waiting').waitFor({ timeout: 15000 });
  assert(await X.getByTestId('screen-error').count() === 0, 'a display on a room that does not exist: "Wachten op kamer ZZZZ", no error');
  const t0 = Date.now();
  while (asked < 3 && Date.now() - t0 < 12000) await sleep(200);
  assert(asked >= 3, `the display keeps retrying (${asked} requests in ${Math.round((Date.now() - t0) / 1000)} s)`);
  // #/scherm: the code prompt
  await X.goto(`${server.url}#/scherm`);
  await X.getByTestId('screen-code-form').waitFor();
  assert(await X.getByTestId('screen-display').getAttribute('data-status') === 'prompt', '#/scherm shows the code prompt');
  await X.getByTestId('screen-code-input').fill(code.toLowerCase());
  await X.getByTestId('screen-code-submit').click();
  // (online can come a moment before the first state: wait for the phase too)
  await X.locator(`[data-testid="screen-display"][data-code="${code}"][data-status="online"][data-phase="won"]`).waitFor({ timeout: 15000 });
  assert(X.url().endsWith(`#/scherm/${code}`) && await attr(X, 'screen-display', 'data-phase') === 'won', 'typing the code goes to the display of that room (here: the finished game)');
  // the 4th and 5th display
  const more = [];
  for (let i = 0; i < 2; i++) {
    const pg = await plain.context.newPage();
    await pg.goto(`${server.url}#/scherm/${code}`);
    await pg.locator(`[data-testid="screen-display"][data-code="${code}"][data-status="online"]`).waitFor({ timeout: 15000 });
    more.push(pg);
  }
  // (after the game the host tab no longer shows the screen box: ask the session's meta, which is what it shows)
  await H.waitForFunction(() => window.__ttHost.session.meta?.screens === 4, null, { timeout: 10000 });
  assert(true, 'four displays: the room server counts 4 screens (meta.screens)');
  // a 5th display: the room server lets the display it heard from longest ago make room (it is told:
  // "Een ander scherm kijkt nu mee", error screenreplaced); there are never more than 4
  const fifth = await plain.context.newPage();
  await fifth.goto(`${server.url}#/scherm/${code}`);
  await fifth.locator(`[data-testid="screen-display"][data-code="${code}"][data-status="online"]`).waitFor({ timeout: 15000 });
  const olds = [['the owner\'s', D], ['typed', X], ['second', more[0]], ['third', more[1]]];
  const errCode = (pg) => pg.evaluate(() => document.querySelector('[data-testid="screen-error"]')?.dataset.code || '');
  let gone = [];
  const t1 = Date.now();
  while (gone.length < 1 && Date.now() - t1 < 10000) { gone = []; for (const [nm, pg] of olds) if (await errCode(pg)) gone.push([nm, pg]); await sleep(200); }
  assert(gone.length === 1 && await errCode(gone[0][1]) === 'screenreplaced', `the 5th display takes a slot: exactly one older display (${gone.map((g) => g[0]).join(', ')}) shows "screenreplaced"`);
  assert(await attr(fifth, 'screen-display', 'data-status') === 'online' && await H.evaluate(() => window.__ttHost.session.meta?.screens) === 4, 'the 5th display is online and the room still counts 4 screens');
  assert(/4/.test(await gone[0][1].getByTestId('screen-error').textContent()), 'the replaced display says that 4 can watch at the same time');
  if (gone[0][1] === D) { await takeWrites(o, D); await D.reload(); } // the owner\'s own display was the quiet one: bring it back
  await D.locator(`[data-testid="screen-display"][data-code="${code}"][data-status="online"]`).waitFor({ timeout: 15000 });
  await plain.context.close();
  await H.waitForFunction(() => window.__ttHost.session.meta?.screens === 1, null, { timeout: 10000 });
  assert(true, 'the extra displays closed: back to 1');

  // ----- the display's whole life: no localStorage writes, the host's identity untouched -----
  await takeWrites(o, D);
  assert(o.lsWrites.length === 0, `the display tabs made zero localStorage writes (${JSON.stringify(o.lsWrites)})`);
  await D.close();
  await H.waitForFunction(() => window.__ttHost.session.meta?.screens === 0, null, { timeout: 10000 });
  const idAfter = await identity(H);
  assert(JSON.stringify(idAfter) === JSON.stringify(idBefore), 'the host\'s stored identity keys are byte-identical before and after the display\'s life');
  for (const nm of ['Anouk', 'Bram']) {
    const pid = await joined[nm].page.evaluate(() => localStorage.getItem('timetunesr.multiPlayerId.v1'));
    assert(!!pid, `${nm}'s player id is untouched`);
  }
  assert(o.errors.length === 0, `no page errors (${o.errors.join('; ')})`);
  await o.context.close();
  for (const p of Object.values(joined)) await p.context.close().catch(() => {});
}

// ======================================================================================
//  A Quiz question on the display
// ======================================================================================
async function quizOnDisplay(browser, rooms, server) {
  const o = await owner(browser, rooms);
  const H = o.H;
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const D = await openDisplay(o, code);
  const names = ['Anouk', 'Bram'];
  const ps = [];
  for (const nm of names) { const p = await phone(browser, rooms); await joinRoom(p.page, server.url, code, nm, { via: 'link' }); ps.push(p); }
  await waitForPlayers(H, 2);
  await H.getByTestId('room-game-quiz').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await H.getByTestId('room-game-quiz').check();
  await D.locator('[data-testid="screen-game"][data-game="quiz"]').waitFor();
  const from = D.frames.length;
  await H.getByTestId('room-start').click();
  await D.waitForFunction(() => { const v = window.__ttScreen?.session?.view; return v?.phase === 'answering' && v.game?.quiz?.deadline; }, null, { timeout: 30000 });
  const { song } = await serverHost(H);
  await D.getByTestId('quiz-prompt').waitFor();
  assert(await D.locator('[data-testid^="quiz-show-option-"]').count() === 4, 'Quiz: the question with four options on the display');
  assert(await D.locator('[data-testid^="quiz-option-"]').count() === 0, 'the display has no answer buttons');
  assert(await attr(D, 'quiz-answered', 'data-done') === '0' && await attr(D, 'quiz-answered', 'data-total') === '2', 'Quiz: "0 van 2 hebben geantwoord"');
  const q = (await pview(ps[0])).game.quiz;
  const want = q.type === 'year' ? String(song.year) : q.type === 'artist' ? song.artist : song.title;
  const right = q.options.indexOf(want);
  assert(right >= 0, `Quiz: the right answer is among the options (${q.options.join(' | ')})`);
  await noScroll(D, 'quiz question');
  await send(ps[0], { choice: right });
  await D.waitForFunction(() => document.querySelector('[data-testid="quiz-answered"]')?.dataset.done === '1', null, { timeout: 8000 });
  assert(/1 van 2 hebben geantwoord/.test((await D.getByTestId('quiz-answered').textContent()).replace(/\s+/g, ' ')), 'Quiz: "1 van 2 hebben geantwoord" follows the answer');
  // nothing about the answer before the reveal
  for (const raw of D.frames.slice(from)) {
    let m = null;
    try { m = JSON.parse(raw); } catch { continue; }
    if (m.t !== 'state' || m.view?.phase !== 'answering') continue;
    if (m.view.game?.reveal || m.view.game?.quiz?.reveal || /"answer":\d/.test(raw)) throw new Error(`ASSERT: Quiz: the right answer reached the display before the reveal: ${raw.slice(0, 200)}`);
  }
  assert(await D.getByTestId('quiz-correct').count() === 0 && await D.locator('.quiz-opt.is-right').count() === 0 && await D.getByTestId('screen-song').count() === 0, 'Quiz: no right answer and no song in the DOM before the reveal');
  assertNeverLeaks(D.frames, 'Quiz');
  await send(ps[1], { choice: (right + 1) % 4 }); // the last one: the server reveals at once
  await waitDisplayRound(D, 1, 'revealed');
  await D.getByTestId('quiz-reveal').waitFor();
  assert(await attr(D, 'quiz-correct', 'data-answer') === String(right) && (await D.getByTestId('quiz-correct').textContent()).includes(want), `Quiz reveal: the right answer is shown (${want})`);
  assert(await attr(D, `quiz-count-${right}`, 'data-count') === '1' && await attr(D, `quiz-count-${(right + 1) % 4}`, 'data-count') === '1', 'Quiz reveal: one answer for the right option, one for the wrong');
  const text = (await D.locator('[data-testid="screen-display"]').innerText()).replace(/\s+/g, ' ');
  assert(text.includes('Anouk') && text.includes('Bram') && text.includes(song.artist), 'Quiz reveal: the ranking with both names and the song');
  await shot(D, '07-quiz-reveal');
  await noScroll(D, 'quiz reveal');
  assert(o.errors.length === 0, `no page errors (${o.errors.join('; ')})`);
  await o.context.close();
  for (const p of ps) await p.context.close();
}

// ======================================================================================
//  A classic Bingo round on the display, with the room server killed and restarted in the middle
// ======================================================================================
async function bingoOnDisplay(browser, rooms, server) {
  const o = await owner(browser, rooms);
  const H = o.H;
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const D = await openDisplay(o, code);
  const ps = [];
  for (const nm of ['Anouk', 'Bram']) { const p = await phone(browser, rooms); await joinRoom(p.page, server.url, code, nm, { via: 'link' }); ps.push(p); }
  const [A, B] = ps;
  await waitForPlayers(H, 2);
  const radio = H.getByTestId('room-game-bingo');
  await radio.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await radio.check();
  await D.locator('[data-testid="screen-game"][data-game="bingo"]').waitFor();
  const from = D.frames.length;
  await H.getByTestId('room-start').click();
  await waitDisplayRound(D, 1, 'answering');
  await D.getByTestId('screen-listen').waitFor();
  assert(await attr(D, 'screen-display', 'data-game') === 'bingo' && /Bingo/.test(await D.getByTestId('screen-game').textContent()), 'classic Bingo: the display follows the game');
  await waitCount(D, 0, 2);
  const { song } = await serverHost(H);
  const v = await pview(A);
  const card = v.game.mine.card;
  let ans = { pass: true };
  let exp = 'pass';
  const ai = card.indexOf('artist');
  const ti = card.indexOf('title');
  if (ai >= 0) { ans = { index: ai, text: song.artist }; exp = 'right'; } else if (ti >= 0) { ans = { index: ti, text: song.title }; exp = 'right'; }
  await send(A, ans);
  await waitCount(D, 1, 2);
  await send(B, { pass: true });
  await waitCount(D, 2, 2);
  assert(true, 'Bingo: "2 van 2" follows the answers on the display');
  assertNoPeek(D.frames, from, D.frames.length, [song.title, song.artist, ans.text], 'Bingo');
  await assertDomClean(D, [song.title, song.artist], 'Bingo');
  assertNeverLeaks(D.frames, 'Bingo');
  await noScroll(D, 'bingo listen');

  // ----- the room server dies and comes back: the display waits, the spelleider restores the room -----
  await rooms.stop();
  await D.locator('[data-testid="screen-status"]').waitFor({ timeout: 20000 });
  assert(true, 'server down: the display shows a small status ("verbinding kwijt"), not a broken screen');
  assert(await D.getByTestId('screen-code').count() === 0 && await D.getByTestId('screen-listen').count() === 1, 'the game stays on screen while the server is away');
  await rooms.start();
  await H.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 40000 });
  await D.locator('[data-testid="screen-display"][data-status="online"]').waitFor({ timeout: 40000 });
  await waitDisplayRound(D, 1, 'answering');
  await waitCount(D, 2, 2);
  assert(await D.getByTestId('screen-status').count() === 0, 'server restarted and restored by the spelleider: the display is back in the same round with both answers');

  // ----- reveal -----
  await H.getByTestId('room-reveal').click();
  await waitDisplayRound(D, 1, 'revealed');
  const sg = (await D.getByTestId('screen-song').textContent()).replace(/\s+/g, ' ');
  assert(sg.includes(song.title) && sg.includes(song.artist) && sg.includes(String(song.year)), 'Bingo reveal: the song on the display');
  await D.locator(`[data-testid="screen-result"][data-name="Anouk"][data-verdict="${exp}"]`).waitFor({ timeout: 8000 });
  await D.locator('[data-testid="screen-result"][data-name="Bram"][data-verdict="pass"]').waitFor({ timeout: 8000 });
  assert(await D.getByTestId('screen-standings').isVisible(), `Bingo reveal: results (Anouk ${exp}, Bram pass) and the standings`);
  await shot(D, '08-bingo-reveal');
  await noScroll(D, 'bingo reveal');
  assertNeverLeaks(D.frames, 'Bingo (with a server restart)');
  assert(o.errors.length === 0, `no page errors (${o.errors.join('; ')})`);
  await o.context.close();
  for (const p of ps) await p.context.close();
}

// ======================================================================================
//  PeerJS route (no server configured): the display needs the room server
// ======================================================================================
async function peerRoute(browser, server) {
  const p = await phone(browser, null, { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, userAgent: undefined });
  await p.page.goto(`${server.url}#/scherm/ABCD`);
  await p.page.locator('[data-testid="screen-error"][data-code="noserver"]').waitFor({ timeout: 10000 });
  assert(/kamerserver/.test(await p.page.getByTestId('screen-error').textContent()), 'PeerJS route: the display says it needs the room server');
  await p.page.goto(`${server.url}#/scherm`);
  await p.page.locator('[data-testid="screen-error"][data-code="noserver"]').waitFor({ timeout: 10000 });
  assert(await p.page.getByTestId('screen-code-form').count() === 0, 'PeerJS route: #/scherm has no code form, only the message');
  await p.context.close();
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const browser = await launch();
  try {
    await mainGame(browser, rooms, server);
    await quizOnDisplay(browser, rooms, server);
    await peerRoute(browser, server);
    await bingoOnDisplay(browser, rooms, server);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
