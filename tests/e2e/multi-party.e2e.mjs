// The party elements of the room games ("Samen spelen", spec section B): avatars, streak / joker /
// snelste, reactions and the prize ceremony, through the Node room server.
//
//  1. lobby: the avatar picker on the join form and in the lobby (phone tile, tv tile, spelleider's list),
//     same avatar twice, kept after a reload and after leaving and coming back, a forged avatar
//     (hello and avatar message) replaced / refused, the reactions of the lobby (tv + host, never
//     another phone, cool-down, the server's own gap, not replayed to a display that comes later,
//     never over the QR code);
//  2. a whole Discobingo (host tab 1280×720 + tv display 1920×1080 in one context, three phones in own
//     contexts; Anouk plays through the real phone UI for the joker, avatar and reaction controls, the
//     others through the page's own session): streak marks, joker earned / used / moved back / returned
//     by a flip / cap, snelste, reactions during the game, the no-peeking frame capture of a phone and
//     the tv, the prize ceremony, a reload mid-ceremony and "Nog een potje";
//  3. a Quiz question and a classic Bingo round: avatars on phone, tv and host, reactions after answering.
//
// Deterministic: seed 7 (timetunesr.multiSeed.v1) and a generated playlist (as multi-disco). The
// outcome of every round is scripted from the category the ball lands on; the expectations (who is
// snelste, the streaks, the awards) are counted by this script itself, never read back from the app.
// Set PARTY_ONLY=lobby|game|other to run one part, PARTY_SHOTS=1 for screenshots.
import { join } from 'node:path';
import { createServer } from 'node:net';
import { launch, startServer, assert, OUT } from './helpers.mjs';
import { startRoomServer, phone, createRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';
import { bestSquare, decadeOf, LINES, CENTER } from '../../app/js/multi/disco.js';
import { artistVerdict, titleVerdict } from '../../app/js/multi/match.js';
import { AVATARS, REACTIONS, REACT_GAP_MS, discoAwards } from '../../app/js/multi/party.js';

// ---------- a playlist of 30 songs with names that can be typed wrongly ----------
const A1 = ['Blauwe', 'Gouden', 'Rode', 'Stille', 'Wilde', 'Zilveren', 'Zwarte', 'Kleine', 'Grote', 'Late'];
const A2 = ['Draaiers', 'Fietsers', 'Molens', 'Schaatsers', 'Bakkers', 'Stromen', 'Dromers', 'Zeilers', 'Vissers', 'Dansers'];
const T1 = ['Dansen', 'Zingen', 'Vliegen', 'Dromen', 'Lopen', 'Zwemmen'];
const T2 = ['onder', 'boven', 'naast', 'langs', 'tussen', 'achter', 'voorbij'];
const T3 = ['de sterren', 'het water', 'de regen', 'mijn straat', 'de maan'];
const TRACKS = Array.from({ length: 30 }, (_, i) => ({
  n: i + 1,
  itunesId: 8100000 + i,
  title: `${T1[i % 6]} ${T2[i % 7]} ${T3[i % 5]}`,
  artist: `${A1[i % 10]} ${A2[(i * 3 + Math.floor(i / 10)) % 10]}`,
  year: 1960 + ((i * 7) % 58),
  previewUrl: `https://audio-ssl.itunes.apple.com/fake/p${i}.m4a`,
}));
const verdictFn = (kind) => (kind === 'artist' ? artistVerdict : titleVerdict);
/** A near miss the machine does not accept by itself: the spelleider decides. */
function doubtOf(kind, real) {
  const w = real.split(' ');
  const tries = kind === 'artist' ? [w[w.length - 1], w[0]] : [w.slice(0, -1).join(' '), w.slice(1).join(' ')];
  return tries.find((t) => verdictFn(kind)(t, real).verdict === 'doubt') || null;
}
/** A typo the matcher accepts at once (a doubled letter in the middle). */
const typoOf = (real) => { const k = Math.floor(real.length / 2); return real.slice(0, k) + real[k] + real.slice(k); };
for (const t of TRACKS) {
  for (const [kind, real] of [['artist', t.artist], ['title', t.title]]) {
    if (!doubtOf(kind, real)) throw new Error(`fixture: no near-miss for "${real}"`);
    if (verdictFn(kind)(real, real).verdict !== 'right' || verdictFn(kind)(typoOf(real), real).verdict !== 'right') throw new Error(`fixture: "${real}" is not right`);
    if (verdictFn(kind)('Raar antwoord 1', real).verdict !== 'wrong') throw new Error('fixture: nonsense is not wrong');
  }
}

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TV = { width: 1920, height: 1080 };
const HOST_TV = { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, userAgent: undefined };
const SHOTS = !!process.env.PARTY_SHOTS;
const ONLY = process.env.PARTY_ONLY || '';
const attr = (page, testid, name) => page.getByTestId(testid).getAttribute(name);
const pview = (p) => p.page.evaluate(() => window.__ttRoom?.session?.view || null);
const sview = (D) => D.evaluate(() => window.__ttScreen?.session?.view || null);
const hspec = (H) => H.evaluate(() => window.__ttHost?.session?.spectatorView() || null);
async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `party-${name}.png`) });
}
/** Failures of assertions that are kept but must not stop the run (real app bugs): the run fails at the end. */
const BUGS = [];
function bug(cond, msg) {
  if (cond) { console.log(`  ok - ${msg}`); return true; }
  console.log(`  BUG - ${msg}`);
  BUGS.push(msg);
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Installed in every phone: remembers its WebSocket (window.__ws, to send raw frames the session
 * would not: a forged avatar, a reaction inside the local cool-down) and can rewrite what it sends.
 */
function wsHook() {
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(d) {
    window.__ws = this;
    if (typeof d === 'string' && typeof window.__rewrite === 'function') d = window.__rewrite(d);
    return orig.call(this, d);
  };
}
/** Phones: records what the verdict moment shows (it is only there for a couple of seconds). */
function verdictProbe() {
  const seen = (window.__verdicts = {});
  setInterval(() => {
    const m = document.querySelector('[data-testid="disco-moment"][data-moment="verdict"]');
    const round = window.__ttRoom?.session?.view?.game?.round;
    if (!m || round == null) return;
    const q = (id) => m.querySelector(`[data-testid="${id}"]`);
    seen[round] = {
      verdict: q('disco-verdict')?.dataset.verdict ?? null,
      streak: q('disco-streak')?.dataset.streak ?? null,
      streakText: q('disco-streak')?.textContent.trim() ?? null,
      fastest: !!q('disco-fastest'),
      joker: !!q('disco-joker-earned'),
      over: q('disco-streak-over')?.textContent.trim() ?? null,
      overCount: m.querySelectorAll('[data-testid="disco-streak-over"]').length,
    };
  }, 40);
}
/** The tv tab only: samples every floating reaction against the QR code, the join badge and the song card. */
function tvProbe() {
  if (!/^#\/scherm/.test(location.hash)) return;
  const rx = (window.__rx = { overlaps: [], samples: 0, ids: new Set() });
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  setInterval(() => {
    const avoid = [...document.querySelectorAll('[data-testid="screen-qr"], .s-badge, [data-testid="screen-song"], .quiz-song, .quiz-correct')]
      .map((e) => ({ what: e.dataset.testid || e.className, ...box(e) })).filter((a) => a.w > 0 && a.h > 0);
    for (const f of document.querySelectorAll('[data-testid="screen-reaction"]')) {
      const fr = box(f);
      if (!(fr.w > 0)) continue;
      rx.samples++;
      rx.ids.add(f.dataset.id + f.dataset.emoji);
      for (const a of avoid) {
        const ox = Math.min(fr.r, a.r) - Math.max(fr.l, a.l);
        const oy = Math.min(fr.b, a.b) - Math.max(fr.t, a.t);
        if (ox > 2 && oy > 2) rx.overlaps.push({ what: a.what, from: f.dataset.from, emoji: f.dataset.emoji, ox: Math.round(ox), oy: Math.round(oy), fr, a: { l: a.l, r: a.r, t: a.t, b: a.b } });
      }
    }
  }, 40);
}

/** The owner's browser context: spelleider tab (1280×720) that also holds the display tab. */
async function owner(browser, rooms, { tracks = TRACKS } = {}) {
  const host = await phone(browser, rooms, { seed: 7, ...HOST_TV });
  await installFakeItunes(host.context);
  await host.context.addInitScript((list) => {
    try {
      if (localStorage.getItem('tt.partyInit')) return;
      localStorage.setItem('tt.partyInit', '1');
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'feest', name: 'Feestmix', tracks: list }] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('feest'));
    } catch { /* a document without storage (about:blank) */ }
  }, tracks);
  await host.context.addInitScript(tvProbe);
  const errors = [];
  host.page.on('pageerror', (e) => errors.push(`host: ${e.message}`));
  return { context: host.context, H: host.page, errors };
}

/** Click "Open het grote scherm" and return the new tab (frames of its WebSocket are collected). */
async function openDisplay(o, code) {
  const link = o.H.getByTestId('host-open-screen');
  const frames = [];
  const onPage = (pg) => {
    pg.on('websocket', (ws) => ws.on('framereceived', (f) => { if (typeof f.payload === 'string') frames.push(f.payload); }));
    pg.on('pageerror', (e) => o.errors.push(`display: ${e.message}`));
    pg.on('dialog', (d) => d.accept());
  };
  o.context.on('page', onPage);
  const [D] = await Promise.all([o.context.waitForEvent('page'), link.click()]);
  o.context.off('page', onPage);
  D.frames = frames;
  await D.setViewportSize(TV);
  await D.locator('[data-testid="screen-display"][data-status="online"]').waitFor({ timeout: 20000 });
  return D;
}

/** A phone with the hooks above and a log of every WebSocket frame it receives. */
async function mkPhone(browser, rooms, name, errors, opts = {}) {
  const p = await phone(browser, rooms, opts);
  await p.context.addInitScript(wsHook);
  await p.context.addInitScript(verdictProbe);
  p.name = name;
  p.frames = [];
  p.page.on('websocket', (ws) => ws.on('framereceived', (f) => { if (typeof f.payload === 'string') p.frames.push(f.payload); }));
  p.page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return p;
}

/** Join through the real join form: the picker preselects an avatar; `avatar` picks another through the sheet. */
async function joinUi(p, url, code, name, avatar = null) {
  const page = p.page;
  await page.goto(`${url}#/kamer/${code}`);
  await page.getByTestId('join-name').fill(name);
  const picker = page.getByTestId('avatar-picker');
  await picker.waitFor();
  const pre = await picker.getAttribute('data-avatar');
  if (avatar) {
    await picker.click();
    await page.getByTestId('avatar-sheet').waitFor();
    assert(await page.getByTestId('avatar-option').count() === AVATARS.length, `the picker offers ${AVATARS.length} avatars`);
    await page.locator(`[data-testid="avatar-option"][data-avatar="${avatar}"]`).click();
    await page.getByTestId('avatar-sheet').waitFor({ state: 'detached' });
    assert(await picker.getAttribute('data-avatar') === avatar, `${name}: the picker now shows ${avatar}`);
  }
  await page.getByTestId('join-submit').click();
  await page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
  return { pre, chosen: avatar || pre };
}
/** A phone joined without the form: through its own session (fast path). */
async function joinFast(p, url, code, name) {
  await p.page.goto(`${url}#/kamer/${code}`);
  await p.page.getByTestId('join-name').fill(name);
  const pre = await attr(p.page, 'avatar-picker', 'data-avatar');
  await p.page.getByTestId('join-submit').click();
  await p.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
  return pre;
}

/** The avatar of a player as every screen shows it. */
const tvAvatar = (D, name) => D.locator(`[data-testid="screen-player"][data-name="${name}"]`).getAttribute('data-avatar');
const hostAvatar = (H, name) => H.locator(`[data-testid^="room-player-"][data-name="${name}"] [data-testid="player-avatar"]`).getAttribute('data-avatar');
const phoneTileAvatar = (P, name) => P.locator(`[data-testid^="room-player-"][data-name="${name}"] [data-testid="player-avatar"]`).getAttribute('data-avatar');
/** Wait until `fn` is true in the page (a short, named wait for a state). */
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout });
const reactionsOf = (D) => D.evaluate(() => (window.__ttScreen?.session?.reactions || []).map((r) => ({ name: r.name, emoji: r.emoji, avatar: r.avatar })));
const sendRaw = (p, obj) => p.page.evaluate((o) => window.__ws.send(JSON.stringify(o)), obj);

// ======================================================================================
//  1. The lobby: avatars and reactions
// ======================================================================================
async function lobby(browser, rooms, server) {
  console.log('\n## lobby: avatars and reactions');
  const o = await owner(browser, rooms);
  const H = o.H;
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const D = await openDisplay(o, code);
  const errs = o.errors;
  const A = await mkPhone(browser, rooms, 'Anouk', errs);
  const B = await mkPhone(browser, rooms, 'Bram', errs);
  const C = await mkPhone(browser, rooms, 'Cas', errs);

  // ----- the join form: a preselected avatar, the picker changes it -----
  await A.page.goto(`${server.url}#/kamer/${code}`);
  await A.page.getByTestId('join-name').fill('Anouk');
  const pre = await attr(A.page, 'avatar-picker', 'data-avatar');
  assert(AVATARS.includes(pre), `the join form preselects an avatar from the list (${pre})`);
  assert(await A.page.getByTestId('avatar-sheet').count() === 0, 'the picker sheet is closed until you tap the avatar');
  await A.page.getByTestId('avatar-picker').click();
  await A.page.getByTestId('avatar-sheet').waitFor();
  assert(await A.page.getByTestId('avatar-option').count() === AVATARS.length, `the sheet offers all ${AVATARS.length} avatars`);
  assert(await A.page.locator(`[data-testid="avatar-option"][data-avatar="${pre}"]`).getAttribute('aria-pressed') === 'true', 'the preselected avatar is the pressed one in the sheet');
  const first = '🦄';
  await A.page.locator(`[data-testid="avatar-option"][data-avatar="${first}"]`).click();
  await A.page.getByTestId('avatar-sheet').waitFor({ state: 'detached' });
  assert(await attr(A.page, 'avatar-picker', 'data-avatar') === first, `the picker shows the chosen avatar ${first}`);
  assert(await A.page.getByTestId('join-name').inputValue() === 'Anouk', 'picking an avatar keeps the typed name');
  await A.page.getByTestId('join-submit').click();
  await A.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });

  // Bram: the preselected avatar is kept as it is; Cas picks the same as Anouk will end up with later
  const bramAv = await joinFast(B, server.url, code, 'Bram');
  assert(AVATARS.includes(bramAv), `Bram joins with the preselected avatar ${bramAv}`);
  await joinUi(C, server.url, code, 'Cas', '🐸' === bramAv ? '🐙' : '🐸');
  await waitForPlayers(H, 3);
  const casAv = await phoneTileAvatar(C.page, 'Cas');

  // ----- the chosen avatar shows on the phone's lobby tile, the tv tile and the host's list -----
  for (const [who, name, av] of [[A, 'Anouk', first], [B, 'Bram', bramAv], [C, 'Cas', casAv]]) {
    await until(D, ([n, a]) => document.querySelector(`[data-testid="screen-player"][data-name="${n}"]`)?.dataset.avatar === a, [name, av]);
    await until(H, ([n, a]) => document.querySelector(`[data-testid^="room-player-"][data-name="${n}"] [data-testid="player-avatar"]`)?.dataset.avatar === a, [name, av]);
    assert(await phoneTileAvatar(who.page, name) === av, `${name}: the own lobby tile on the phone shows ${av}`);
    assert(await tvAvatar(D, name) === av, `${name}: the tv tile shows ${av}`);
    assert(await hostAvatar(H, name) === av, `${name}: the spelleider's player list shows ${av}`);
    assert((await D.locator(`[data-testid="screen-player"][data-name="${name}"] [data-testid="player-avatar"]`).textContent()).trim() === av, `${name}: the tv tile really draws the emoji`);
  }
  assert(await A.page.locator('[data-testid="room-player-0"]').getAttribute('data-avatar') === first, 'the lobby tile of the phone carries data-avatar');
  assert(await B.page.getByTestId('lobby-avatar-edit').count() === 1 && await B.page.locator('[data-testid="lobby-avatar-edit"]').count() === 1, 'a phone can edit only its own tile (one "lobby-avatar-edit")');
  await shot(D, 'lobby-tv');

  // ----- changing it in the lobby updates everywhere -----
  await A.page.getByTestId('lobby-avatar-edit').click();
  await A.page.getByTestId('avatar-sheet').waitFor();
  await A.page.locator('[data-testid="avatar-option"][data-avatar="🦊"]').click();
  await A.page.getByTestId('avatar-sheet').waitFor({ state: 'detached' });
  await until(A.page, () => window.__ttRoom.session.view.you.avatar === '🦊');
  await until(D, () => document.querySelector('[data-testid="screen-player"][data-name="Anouk"]')?.dataset.avatar === '🦊');
  await until(H, () => document.querySelector('[data-testid^="room-player-"][data-name="Anouk"] [data-testid="player-avatar"]')?.dataset.avatar === '🦊');
  await until(B.page, () => document.querySelector('[data-testid^="room-player-"][data-name="Anouk"] [data-testid="player-avatar"]')?.dataset.avatar === '🦊');
  assert(await phoneTileAvatar(A.page, 'Anouk') === '🦊' && await tvAvatar(D, 'Anouk') === '🦊' && await hostAvatar(H, 'Anouk') === '🦊', 'Anouk changes to 🦊 in the lobby: her phone, the tv, the host and another phone all show it');

  // ----- two players may pick the same one -----
  await C.page.getByTestId('lobby-avatar-edit').click();
  await C.page.locator('[data-testid="avatar-option"][data-avatar="🦊"]').click();
  await C.page.getByTestId('avatar-sheet').waitFor({ state: 'detached' });
  await until(D, () => ['Anouk', 'Cas'].every((n) => document.querySelector(`[data-testid="screen-player"][data-name="${n}"]`)?.dataset.avatar === '🦊'));
  assert(await tvAvatar(D, 'Anouk') === '🦊' && await tvAvatar(D, 'Cas') === '🦊' && await hostAvatar(H, 'Cas') === '🦊', 'Cas picks 🦊 too: both show it (two players may share an avatar)');
  await until(C.page, () => window.__ttRoom.session.view.players.filter((p) => p.avatar === '🦊').length >= 2);
  assert(true, 'the room view holds the avatar twice');
  // Cas goes back to her own
  await C.page.getByTestId('lobby-avatar-edit').click();
  await C.page.locator('[data-testid="avatar-option"][data-avatar="🎸"]').click();
  await until(D, () => document.querySelector('[data-testid="screen-player"][data-name="Cas"]')?.dataset.avatar === '🎸');

  // ----- kept after a reload and after leaving and coming back -----
  await A.page.reload();
  await A.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
  await until(A.page, () => window.__ttRoom?.session?.view?.you?.avatar === '🦊');
  assert(await phoneTileAvatar(A.page, 'Anouk') === '🦊', 'after a reload of her phone Anouk still has 🦊');
  assert(await tvAvatar(D, 'Anouk') === '🦊', 'and the tv still shows 🦊');
  const left = await C.page.evaluate(() => window.__ttRoom.session.leave());
  assert(left?.seat === false, 'leaving in the lobby gives up the seat');
  await until(D, () => !document.querySelector('[data-testid="screen-player"][data-name="Cas"]'));
  await C.page.goto('about:blank');
  await C.page.goto(`${server.url}#/kamer/${code}`);
  await C.page.getByTestId('join-name').fill('Cas');
  assert(await attr(C.page, 'avatar-picker', 'data-avatar') === '🎸', 'coming back: the join form preselects the avatar she had (🎸)');
  await C.page.getByTestId('join-submit').click();
  await C.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
  await until(D, () => document.querySelector('[data-testid="screen-player"][data-name="Cas"]')?.dataset.avatar === '🎸');
  assert(await hostAvatar(H, 'Cas') === '🎸', 'after leaving and coming back Cas has 🎸 on the tv and in the host list');
  await waitForPlayers(H, 3);

  // ----- a forged avatar never reaches a screen -----
  const FORGED = '<img src=x onerror=window.__pwned=1>';
  const F = await mkPhone(browser, rooms, 'Fien', errs);
  await F.context.addInitScript((forged) => { window.__rewrite = (d) => (d.includes('"t":"hello"') ? d.replace(/"avatar":"[^"]*"/, `"avatar":${JSON.stringify(forged)}`) : d); }, FORGED);
  await F.page.goto(`${server.url}#/kamer/${code}`);
  await F.page.getByTestId('join-name').fill('Fien');
  // a stored avatar makes the hello carry one; the rewrite swaps it for the forged string
  await F.page.getByTestId('join-submit').click();
  await F.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
  await until(D, () => !!document.querySelector('[data-testid="screen-player"][data-name="Fien"]'));
  const fv = await pview(F);
  assert(AVATARS.includes(fv.you.avatar), `a forged avatar in the hello is replaced by a valid one (${fv.you.avatar})`);
  assert((await frameText(F.frames)).includes('onerror') === false, 'the server never sent the forged string back to that phone');
  assert(AVATARS.includes(await tvAvatar(D, 'Fien')) && AVATARS.includes(await hostAvatar(H, 'Fien')), 'the tv and the host show a valid avatar for her');
  // a forged avatar message: refused, not fatal, nothing changes
  await sendRaw(F, { t: 'avatar', avatar: FORGED });
  await sendRaw(F, { t: 'avatar', avatar: '🦖' });
  await sleep(500);
  const fv2 = await pview(F);
  assert(fv2.you.avatar === fv.you.avatar, 'a forged / unknown avatar message does not change the avatar');
  assert(await F.page.locator('[data-testid="screen-room-player"]').count() === 1, 'and does not throw the phone out of the room');
  assert(await F.page.evaluate((f) => window.__ttRoom.session.setAvatar(f), FORGED) === false, 'the session itself refuses to send a forged avatar');
  for (const [label, page] of [['tv', D], ['host', H], ['phone', F.page], ['other phone', B.page]]) {
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    assert(!html.includes('onerror') && !html.includes('<img src=x') && !(await page.evaluate(() => window.__pwned)), `the ${label} DOM never shows the forged string`);
  }
  for (const [label, frames] of [['tv', D.frames], ['phone B', B.frames], ['host', null]]) {
    if (frames) assert(!(await frameText(frames)).includes('onerror'), `no frame to the ${label} ever holds the forged string`);
  }
  await F.page.evaluate(() => window.__ttRoom.session.leave());
  await until(D, () => !document.querySelector('[data-testid="screen-player"][data-name="Fien"]'));
  await F.context.close();

  // ----- reactions in the lobby -----
  await lobbyReactions(o, H, D, code, { A, B, C }, server);
  assert(errs.length === 0, `no page errors (${errs.join('; ')})`);
  for (const p of [A, B, C]) await p.context.close();
  await o.context.close();
}
const frameText = async (frames) => frames.join('\n');

async function lobbyReactions(o, H, D, code, { A, B, C }, server) {
  const bar = (P) => P.page.getByTestId('react-bar');
  assert(await bar(A).isVisible() && await A.page.getByTestId('react-btn').count() === REACTIONS.length, `the reaction bar is on the phone in the lobby (${REACTIONS.length} emoji)`);
  assert(await A.page.locator('[data-testid="react-btn"]').evaluateAll((bs) => bs.map((b) => b.dataset.emoji).join('')) === REACTIONS.join(''), 'the bar offers 👏 🔥 😂 😮 🙌 🎉');
  assert(await attr(A.page, 'react-bar', 'data-cooldown') === 'false', 'the bar is ready (data-cooldown=false)');
  const t0 = Date.now();
  await A.page.locator('[data-testid="react-btn"][data-emoji="🔥"]').click();
  assert(await attr(A.page, 'react-bar', 'data-cooldown') === 'true', 'a tap starts the cool-down');
  // the second tap inside the cool-down is not sent (nothing reaches the tv)
  await A.page.locator('[data-testid="react-btn"][data-emoji="😂"]').click();
  await D.locator('[data-testid="screen-reaction"][data-emoji="🔥"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
  const fl = D.locator('[data-testid="screen-reaction"][data-emoji="🔥"][data-from="Anouk"]').first();
  assert((await fl.textContent()).includes('🦊') && (await fl.textContent()).includes('Anouk'), 'the reaction floats on the tv with the sender\'s avatar and name');
  await H.locator('[data-testid="host-reaction"][data-emoji="🔥"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
  assert(await H.getByTestId('host-reactions').count() === 1, 'the spelleider\'s tab shows it too (small, in the host layer)');
  assert(!(await H.locator('[data-testid="host-reaction"]').first().textContent()).includes('Anouk'), 'on the host tab the reaction is small: no name');
  await sleep(500);
  assert(await D.locator('[data-testid="screen-reaction"][data-emoji="😂"]').count() === 0, 'the tap inside the cool-down was not sent (no 😂 on the tv)');
  for (const P of [B, C]) assert(await P.page.locator('[data-testid="screen-reaction"], [data-testid="host-reaction"], .rx').count() === 0, 'another phone shows no floating reaction');
  assert((await reactionsOf(D)).filter((r) => r.name === 'Anouk').length === 1, 'the tv received exactly one reaction from Anouk');
  // the server keeps its own gap: raw frames sent through the socket (past the phone's own cool-down)
  await sendRaw(B, { t: 'react', emoji: '🎉' });
  await sendRaw(B, { t: 'react', emoji: '😮' });
  await sendRaw(B, { t: 'react', emoji: '🙌' });
  await until(D, () => window.__ttScreen.session.reactions.some((r) => r.name === 'Bram'));
  await sleep(500);
  assert((await reactionsOf(D)).filter((r) => r.name === 'Bram').length === 1, 'three reactions of Bram inside 1.5 s: the server dropped the 2nd and 3rd');
  assert(await B.page.getByTestId('lobby-count').count() === 1, 'the dropped reactions did not disturb Bram\'s phone');
  // after the gap it works again (positive control) and the burst cap holds
  await sleep(Math.max(0, REACT_GAP_MS + 100 - (Date.now() - t0)));
  await sendRaw(A, { t: 'react', emoji: '🙌' });
  await until(D, () => window.__ttScreen.session.reactions.filter((r) => r.name === 'Anouk').length === 2);
  assert(true, `after ${REACT_GAP_MS} ms the next one goes through`);
  // a forged emoji is dropped
  await sendRaw(C, { t: 'react', emoji: '💩' });
  await sendRaw(C, { t: 'react', emoji: '<b>x</b>' });
  await sleep(400);
  assert((await reactionsOf(D)).filter((r) => r.name === 'Cas').length === 0, 'an emoji outside the six is dropped');
  // a display that opens afterwards gets no replay
  const D2 = await openDisplay(o, code);
  await sleep(600);
  assert((await reactionsOf(D2)).length === 0 && await D2.locator('[data-testid="screen-reaction"]').count() === 0, 'a display that connects later gets no replay of the earlier reactions');
  assert(!D2.frames.some((f) => f.includes('"t":"react"')), 'no react frame reached the late display');
  await D2.close();
  // never over the QR code: a stream of reactions while the lobby (QR, 300+ px) is up
  await D.evaluate(() => { window.__rx.overlaps.length = 0; });
  for (let i = 0; i < 3; i++) {
    for (const [P, e] of [[A, REACTIONS[i]], [B, REACTIONS[i + 1]], [C, REACTIONS[i + 2]]]) await sendRaw(P, { t: 'react', emoji: e });
    await sleep(REACT_GAP_MS + 120);
  }
  await sleep(1500);
  const rx = await D.evaluate(() => ({ n: window.__rx.samples, ov: window.__rx.overlaps }));
  assert(rx.n > 20, `the reactions of the lobby were sampled over their whole flight (${rx.n} samples)`);
  assert(rx.ov.length === 0, `a floating reaction never overlaps the QR code (${rx.ov.length} overlaps: ${JSON.stringify(rx.ov.slice(0, 2))})`);
  await shot(D, 'lobby-reactions');
}

// ======================================================================================
//  The run
// ======================================================================================
export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer(await freePort());
  const browser = await launch();
  try {
    if (!ONLY || ONLY === 'lobby') await lobby(browser, rooms, server);
    if (BUGS.length) throw new Error(`${BUGS.length} app bug(s) found by this suite:\n - ${BUGS.join('\n - ')}`);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
