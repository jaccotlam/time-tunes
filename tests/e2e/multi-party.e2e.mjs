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
import { bestSquare, LINES } from '../../app/js/multi/disco.js';
import { artistVerdict, titleVerdict } from '../../app/js/multi/match.js';
import { AVATARS, REACTIONS, REACT_GAP_MS } from '../../app/js/multi/party.js';

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
  const born = new WeakMap(); // what was on screen when a reaction first showed up
  // the steps of the prize ceremony, in the order this display showed them
  const cer = (window.__cer = []);
  setInterval(() => {
    const c = document.querySelector('[data-testid="screen-ceremony"]');
    if (!c) return;
    const key = `${c.dataset.step}|${c.dataset.award}|${c.querySelector('[data-testid="screen-award"]')?.dataset.kind ?? ''}`;
    if (cer[cer.length - 1] !== key) cer.push(key);
  }, 60);
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  setInterval(() => {
    const avoid = [...document.querySelectorAll('[data-testid="screen-qr"], .s-badge, [data-testid="screen-song"], .quiz-song, .quiz-correct')]
      .map((e) => ({ what: e.dataset.testid || e.className, ...box(e) })).filter((a) => a.w > 0 && a.h > 0);
    for (const f of document.querySelectorAll('[data-testid="screen-reaction"]')) {
      const fr = box(f.querySelector('.rx-in') || f);
      if (!(fr.w > 0)) continue;
      rx.samples++;
      rx.ids.add(f.dataset.id + f.dataset.emoji);
      if (!born.has(f)) born.set(f, new Set(avoid.map((a) => a.what)));
      for (const a of avoid) {
        const ox = Math.min(fr.r, a.r) - Math.max(fr.l, a.l);
        const oy = Math.min(fr.b, a.b) - Math.max(fr.t, a.t);
        if (ox > 2 && oy > 2) rx.overlaps.push({ what: a.what, there: born.get(f).has(a.what), from: f.dataset.from, emoji: f.dataset.emoji, ox: Math.round(ox), oy: Math.round(oy), fr, a: { l: a.l, r: a.r, t: a.t, b: a.b } });
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
/**
 * Wait until the server's own gap (REACT_GAP_MS per player) after `name`'s last reaction is
 * surely over. The server measures the gap from when IT accepted that reaction; the tv received
 * it after that (the server accepts, then sends), so the tv's receivedAt (same machine clock)
 * is at or after the accept time. A moment measured on the sending phone is NOT: with a bit of
 * latency the next frame would still land inside the server's gap.
 */
async function pastServerGap(D, name, margin = 50) {
  const at = await D.evaluate((n) => {
    const mine = (window.__ttScreen?.session?.reactions || []).filter((r) => r.name === n);
    return mine.length ? mine[mine.length - 1].receivedAt : 0;
  }, name);
  if (!at) return; // this tv saw none of theirs (a reloaded display): the callers wait for one first where it matters
  const wait = at + REACT_GAP_MS + margin - Date.now();
  if (wait > 0) await sleep(wait);
}
const countFrom = (D, name) => D.evaluate((n) => (window.__ttScreen?.session?.reactions || []).filter((r) => r.name === n).length, name);

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
  // after the gap it works again (positive control), measured from when the tv got Anouk's
  // first one (at or after the moment the server accepted it, see pastServerGap)
  await pastServerGap(D, 'Anouk');
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
  // (each round waits for the previous one to arrive and for the server's gap after it, so none
  // of the nine is dropped by the gap; 3 per ~1.6 s stays under the room's burst cap of 8 per 2 s)
  const who = [[A, 'Anouk'], [B, 'Bram'], [C, 'Cas']];
  await pastServerGap(D, 'Anouk'); // her 🙌 above
  for (let i = 0; i < 3; i++) {
    const before = await Promise.all(who.map(([, n]) => countFrom(D, n)));
    for (const [j, [P]] of who.entries()) await sendRaw(P, { t: 'react', emoji: REACTIONS[i + j] });
    await D.waitForFunction(([names, b]) => names.every((n, j) => (window.__ttScreen.session.reactions || []).filter((r) => r.name === n).length > b[j]), [who.map(([, n]) => n), before], { timeout: 8000 });
    for (const [, n] of who) await pastServerGap(D, n);
  }
  await sleep(1500);
  const rx = await D.evaluate(() => ({ n: window.__rx.samples, ov: window.__rx.overlaps }));
  assert(rx.n > 20, `the reactions of the lobby were sampled over their whole flight (${rx.n} samples)`);
  assert(rx.ov.length === 0, `a floating reaction never overlaps the QR code (${rx.ov.length} overlaps: ${JSON.stringify(rx.ov.slice(0, 2))})`);
  await shot(D, 'lobby-reactions');
}

// ======================================================================================
//  2. A whole Discobingo with the party elements
// ======================================================================================
const NAMES = ['Anouk', 'Bram', 'Cas'];
const textCat = (cat) => cat === 'artist' || cat === 'title';

/** Poll `fn` (returns null when fine, else a description of what is wrong) until it is fine. */
async function poll(what, fn, timeout = 8000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await fn();
    if (last == null) return;
    if (Date.now() - t0 > timeout) throw new Error(`ASSERT: ${what}: ${typeof last === 'string' ? last : JSON.stringify(last)}`);
    await sleep(120);
  }
}

/** What an answer of kind `how` looks like in this category. */
function answerOf(cat, song, how, round, { alt = false } = {}) {
  const real = cat === 'artist' ? song.artist : song.title;
  if (how === 'pass') return { pass: true };
  if (cat === 'exact') return { guess: how === 'wrong' ? song.year + 1 : song.year }; // exact: no margin at all
  if (cat === 'year') return { guess: how === 'wrong' ? song.year + 9 : alt ? song.year + 1 : song.year };
  return { text: how === 'wrong' ? `Raar antwoord ${round}` : how === 'doubt' ? doubtOf(cat, real) : alt ? typoOf(real) : real };
}
const sendAnswer = (P, a) => P.page.evaluate((x) => window.__ttRoom.session.answer(x), a);

/**
 * The spelleider goes on (room-next, or disco-finish on a bingo stop). When somebody online
 * still has to lay a chip the in-app dialog asks first: "Toch doorgaan".
 */
async function goOnHost(H, testid = 'room-next') {
  const waiting = ((await hspec(H)).game.disco.chips || []).filter((c) => c.state === 'choosing');
  await H.getByTestId(testid).click();
  if (waiting.length) {
    await H.getByTestId('disco-confirm').waitFor({ timeout: 5000 });
    await H.getByTestId('disco-confirm-go').click();
  }
}

/** The squares of the colour (avoid: the one that builds the least towards a line; best: the engine's best square). */
function pickSquare(view, mode, pool = null) {
  const d = view.game.disco;
  const marks = view.game.mine.marks.slice();
  if (d.choice != null) marks[d.choice] = null;
  const cand = (pool || d.choosable).slice();
  if (mode === 'best') {
    const b = bestSquare(view.game.mine.card, marks, d.cat, d.win);
    return cand.includes(b) ? b : cand[0];
  }
  let pick = null;
  let score = 99;
  for (const i of cand) {
    const s = Math.max(...LINES.filter((l) => l.includes(i)).map((l) => l.filter((j) => marks[j] != null).length + 1));
    if (s < score) { score = s; pick = i; }
  }
  return pick;
}
/** A phone stamps through its own session (and waits for the server). Returns the square, or null when it had nothing to choose. */
async function stampFast(P, mode, { joker = false } = {}) {
  try {
    await P.page.waitForFunction(() => { const d = window.__ttRoom?.session?.view?.game?.disco; return (d?.choosable?.length || 0) > 0 || d?.noSquare; }, null, { timeout: 5000 });
  } catch { return null; }
  const v = await pview(P);
  const d = v.game.disco;
  if (!d.choosable.length || d.choice != null) return null;
  const i = pickSquare(v, mode, joker ? d.jokerSquares : null);
  await P.page.evaluate(([x, j]) => window.__ttRoom.session.stamp(x, j ? { joker: true } : undefined), [i, joker]);
  await P.page.waitForFunction((x) => window.__ttRoom?.session?.view?.game?.disco?.choice === x, i, { timeout: 8000 });
  return i;
}

/** Fill in and send an answer through the phone UI (right answers only). */
async function answerUi(P, cat, song) {
  const page = P.page;
  const locked = () => page.locator('[data-testid="disco-answer-state"][data-state="locked"]').waitFor();
  if (cat === 'year' || cat === 'exact') {
    await page.getByTestId('disco-year-input').fill(String(song.year));
    await page.getByTestId('disco-lock').click();
  } else {
    await page.getByTestId('disco-text-input').fill(cat === 'artist' ? song.artist : song.title);
    await page.getByTestId('disco-lock').click();
  }
  await locked();
}

/** The rows of the tv's results table. */
const tvRows = (D) => D.evaluate(() => [...document.querySelectorAll('[data-testid="screen-result"]')].map((li) => ({
  name: li.dataset.name,
  verdict: li.dataset.verdict,
  fastest: li.dataset.fastest === 'true',
  fastMark: li.querySelectorAll('[data-testid="fastest-mark"]').length,
  streak: li.querySelector('[data-testid="streak-mark"]')?.dataset.streak ?? null,
  joker: li.querySelector('[data-testid="joker-event"]')?.dataset.joker ?? null,
  avatar: li.querySelector('[data-testid="player-avatar"]')?.dataset.avatar ?? null,
})));

/**
 * What the app may and may not tell a phone or the display while a question is open (frames
 * [from, to) of one connection): no song, no typed text of others, nothing of this round's outcome.
 */
function scanQuestion(label, frames, from, to, round, forbidden, base, { stripOwn = false } = {}) {
  let seen = 0;
  const keys = new Set();
  for (const raw of frames.slice(from, to)) {
    let m;
    try { m = JSON.parse(raw); } catch { m = null; }
    // a phone is told its own answer: that is the one thing it may hold
    let text = raw;
    if (stripOwn && m?.view?.game?.answer) { const c = JSON.parse(raw); delete c.view.game.answer; text = JSON.stringify(c); }
    for (const f of forbidden) {
      if (f && text.includes(JSON.stringify(f).slice(1, -1))) throw new Error(`ASSERT: ${label} received "${f}" before the reveal: ...${text.slice(Math.max(0, text.indexOf(f) - 100), text.indexOf(f) + 80)}...`);
    }
    if (!m) continue;
    const v = m?.view;
    if (m?.t !== 'state' || !v || v.phase !== 'answering' || v.game?.round !== round) continue;
    seen++;
    const d = v.game.disco;
    const walk = (o, path) => {
      if (Array.isArray(o)) o.forEach((x) => walk(x, path));
      else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { keys.add(k); walk(x, `${path}.${k}`); }
    };
    walk(v, 'view');
    const bad = [];
    if (v.game.reveal) bad.push('reveal');
    if (d.fastest != null) bad.push(`fastest=${JSON.stringify(d.fastest)}`);
    if ((d.jokerSquares || []).length) bad.push('jokerSquares');
    if (d.stats != null || d.awards != null) bad.push('stats/awards');
    if ((d.doubts || []).length || (d.pending || []).length) bad.push('doubts/pending');
    if (v.game.mine && (v.game.mine.jokerEarned || v.game.mine.jokerSpent)) bad.push('own joker event');
    if (d.choice != null) bad.push(`choice=${d.choice}`);
    if (base) {
      for (const p of d.progress || []) {
        const b = base[p.id];
        if (b && (b.streak !== p.streak || b.jokers !== p.jokers)) bad.push(`progress of ${p.name} is ${p.streak}/${p.jokers}, was ${b.streak}/${b.jokers} before the round`);
      }
      if (v.game.mine && base[v.you.id] && (base[v.you.id].streak !== v.game.mine.streak || base[v.you.id].jokers !== v.game.mine.jokers)) bad.push('own streak/jokers changed during the question');
    }
    if (bad.length) throw new Error(`ASSERT: ${label}: a frame of the open question (round ${round}) tells about the round: ${bad.join(', ')}`);
  }
  const hits = [...keys].filter((k) => /^(times|rightSeq|answerTimes|answeredAt|time|ms)$/i.test(k));
  if (hits.length) throw new Error(`ASSERT: ${label}: answer-time keys in the view of an open question: ${hits.join(', ')}`);
  return seen;
}

/** The final standings after a round (what the next round starts from), as every screen sees them. */
const standing = (sv) => Object.fromEntries((sv.game.disco.progress || []).map((p) => [p.id, { streak: p.streak, jokers: p.jokers, stamped: p.stamped, toGo: p.toGo, name: p.name }]));

async function newParty(browser, rooms, server, { extraDisplay = false } = {}) {
  const o = await owner(browser, rooms);
  const H = o.H;
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const D = await openDisplay(o, code);
  const A = await mkPhone(browser, rooms, 'Anouk', o.errors);
  const B = await mkPhone(browser, rooms, 'Bram', o.errors);
  const C = await mkPhone(browser, rooms, 'Cas', o.errors);
  await joinUi(A, server.url, code, 'Anouk', '🦄');
  await joinFast(B, server.url, code, 'Bram');
  await joinFast(C, server.url, code, 'Cas');
  await waitForPlayers(H, 3);
  for (const P of [A, B, C]) P.id = (await pview(P)).you.id;
  const D2 = extraDisplay ? await openDisplay(o, code) : null;
  return { o, H, D, D2, code, A, B, C, P: { Anouk: A, Bram: B, Cas: C }, server };
}

async function discoGame(browser, rooms, server) {
  console.log('\n## discobingo: streak, joker, snelste, reactions, awards');
  const R = await newParty(browser, rooms, server, { extraDisplay: true });
  const { o, H, D, D2, code, A, B, C, P } = R;
  const errs = o.errors;
  for (const p of [A, B, C]) assert(AVATARS.includes((await pview(p)).you.avatar), `${p.name} has an avatar in the room`);
  assert((await pview(A)).you.avatar === '🦄', 'Anouk has the avatar she picked on the join form');
  await H.getByTestId('room-game-disco').check().catch(() => {});
  assert((await H.locator('input[name="game"]:checked').getAttribute('value')) === 'disco', 'Discobingo is the chosen game (eerste bingo bij 1 lijn)');
  // the script times every answer itself: the spelleider reveals by hand
  await H.getByTestId('room-disco-auto').uncheck();
  await H.waitForFunction(() => window.__ttHost?.session?.room?.settings?.autoReveal === false);
  await H.getByTestId('room-start').click();

  // ----- the story: what each player does, round by round (the category comes from the seeded ball) -----
  // Anouk is right in 1-5, wrong in 6; Bram is right in 1-9; Cas is the odd one out (and the doubt).
  const X = Object.fromEntries(NAMES.map((n) => [n, { answers: 0, right: 0, doubts: 0, fastest: 0, best: 0, streak: 0, jokers: 0, wrongRounds: [] }]));
  const S = { doubtDone: false, cats: [], base: null, fastestBy: {}, wonRound: null };
  let won = false;
  for (let round = 1; round <= 36 && !won; round++) {
    // ----- the round starts -----
    await H.waitForFunction((r) => { const v = window.__ttHost?.session?.spectatorView(); return v?.phase === 'answering' && v.game.round === r; }, round, { timeout: 30000 });
    await H.waitForFunction((r) => window.__ttHost?.session?.room?.game?.round === r && !!window.__ttHost.session.currentSong(), round);
    const { song } = await serverHost(H);
    const cat = (await hspec(H)).game.disco.cat;
    S.cats.push(cat);
    const starts = { D: D.frames.length, D2: D2.frames.length, A: A.frames.length, B: B.frames.length, C: C.frames.length };
    // what each of them does this round
    const finish = round >= 11;
    const plan = {
      order: ['Anouk', 'Bram', 'Cas'],
      how: { Anouk: 'right', Bram: 'right', Cas: finish ? 'right' : 'wrong' },
      ui: false, change: null,
    };
    if (round === 2) { plan.order = ['Bram', 'Cas', 'Anouk']; plan.ui = true; }
    if (round === 3) { plan.order = ['Anouk', 'Cas', 'Bram']; plan.how.Cas = 'right'; }
    if (round === 4) { plan.order = ['Bram', 'Anouk', 'Cas']; plan.how.Cas = 'pass'; }
    if (round === 6) { plan.order = ['Bram', 'Cas', 'Anouk']; plan.how.Anouk = 'wrong'; plan.how.Cas = 'right'; }
    if (round === 7) plan.change = 'Anouk';
    if (round === 8) plan.how.Cas = 'right';
    if (round === 10) plan.how = { Anouk: 'wrong', Bram: 'wrong', Cas: 'pass' };
    if (!S.doubtDone && round >= 5 && round !== 10 && textCat(cat)) {
      plan.how.Cas = 'doubt';
      plan.order = ['Cas', ...plan.order.filter((n) => n !== 'Cas')];
      S.doubtDone = true;
      plan.doubt = true;
    }
    // the outcome of the round, counted here
    const eff = plan.change ? [...plan.order.filter((n) => n !== plan.change), plan.change] : plan.order;
    const rightNames = NAMES.filter((n) => plan.how[n] === 'right' || plan.how[n] === 'doubt');
    const fast = eff.find((n) => plan.how[n] === 'right') || null; // a doubt never wins the badge from a machine-right answer
    const fastNoMachine = eff.find((n) => plan.how[n] === 'doubt') || null;
    const expectFast = fast || fastNoMachine; // only a doubt that is made right: then it is the one made right first
    S.fastestBy[round] = expectFast;
    const earned = {};
    const before = {};
    for (const n of NAMES) {
      const x = X[n];
      before[n] = { streak: x.streak, jokers: x.jokers };
      const how = plan.how[n];
      if (how !== 'pass') x.answers++;
      if (how === 'doubt') x.doubts++;
      if (rightNames.includes(n)) {
        x.right++;
        x.streak++;
        x.best = Math.max(x.best, x.streak);
        earned[n] = x.streak % 3 === 0 && x.jokers < 2;
        if (earned[n]) x.jokers++;
      } else { x.streak = 0; earned[n] = false; }
    }
    if (expectFast) X[expectFast].fastest++;
    // (Anouk's joker of round 4 is spent after the story below; counted there)
    const typed = [];
    const own = {};

    // ----- answers, in the order they reach the server -----
    const give = async (n) => {
      const how = plan.how[n];
      const a = answerOf(cat, song, how, round);
      if (a.text) { typed.push(a.text); (own[n] ||= []).push(a.text); }
      if (n === 'Anouk' && plan.ui) return;
      await sendAnswer(P[n], a);
      await P[n].page.waitForFunction(() => window.__ttRoom.session.view.game.answer != null);
      await sleep(100);
    };
    for (const n of plan.order) {
      if (n === 'Anouk' && plan.ui) {
        // Anouk answers through the real phone UI; first she is on the question moment
        await A.page.locator('[data-testid="disco-moment"][data-moment="question"]').waitFor({ timeout: 20000 });
        assert(await A.page.getByTestId('react-bar').count() === 0, 'round 2: no reaction bar on the question moment');
        const before = (await reactionsOf(D)).length;
        await sendRaw(A, { t: 'react', emoji: '🎉' });
        await sleep(700);
        assert((await reactionsOf(D)).length === before && await D.locator('[data-testid="screen-reaction"][data-from="Anouk"]').count() === 0 && await H.locator('[data-testid="host-reaction"][data-from="Anouk"]').count() === 0,
          'a reaction sent before answering (during the question) is not delivered to the tv or the host');
        await answerUi(A, cat, song);
        if (textCat(cat)) { const t = cat === 'artist' ? song.artist : song.title; typed.push(t); (own.Anouk ||= []).push(t); }
        await A.page.locator('[data-testid="disco-moment"][data-moment="submitted"]').waitFor();
        assert(await A.page.getByTestId('react-bar').count() === 1 && await A.page.getByTestId('react-btn').count() === 6, 'round 2: the reaction bar is there on the submitted moment');
        await shot(A.page, 'submitted-react');
      } else await give(n);
    }
    if (plan.change) {
      // she changes her mind (still right): her time is the time of the last answer
      const a = answerOf(cat, song, 'right', round, { alt: true });
      if (a.text) { typed.push(a.text); (own[plan.change] ||= []).push(a.text); }
      await sendAnswer(P[plan.change], a);
      await sleep(250);
    }
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });

    // ----- everybody answered, nothing revealed: what do the screens show? -----
    {
      const dom = await D.evaluate(() => document.documentElement.outerHTML);
      const secret = [song.title, song.artist, ...typed];
      for (const t of secret) if (t && dom.includes(t)) throw new Error(`ASSERT: round ${round}: "${t}" is in the tv's DOM before the reveal`);
      for (const id of ['fastest-mark', 'joker-event', 'screen-result']) if (await D.getByTestId(id).count()) throw new Error(`ASSERT: round ${round}: the tv shows "${id}" before the reveal`);
      for (const n of ['Bram', 'Cas']) {
        const ph = await P[n].page.evaluate(() => document.documentElement.outerHTML);
        const other = [song.title, song.artist, ...typed].filter((t) => !(own[n] || []).some((m) => m.includes(t) || t.includes(m)));
        for (const t of other) if (t && ph.includes(t)) throw new Error(`ASSERT: round ${round}: "${t}" is in ${n}'s DOM before the reveal`);
        for (const id of ['disco-fastest', 'disco-streak', 'disco-joker-earned', 'disco-streak-over', 'fastest-mark', 'joker-event']) {
          if (await P[n].page.getByTestId(id).count()) throw new Error(`ASSERT: round ${round}: ${n}'s phone shows "${id}" before the reveal`);
        }
      }
    }
    const ends = { D: D.frames.length, D2: D2.frames.length, A: A.frames.length, B: B.frames.length, C: C.frames.length };
    // frames of the open question: tv, second tv, and every phone (its own typed text is its own business)
    const scanned = [
      scanQuestion('the tv', D.frames, starts.D, ends.D, round, [song.title, song.artist, ...typed], S.base),
      scanQuestion('the second tv', D2.frames, starts.D2, ends.D2, round, [song.title, song.artist, ...typed], S.base),
    ];
    for (const n of NAMES) {
      const k = n[0];
      scanned.push(scanQuestion(`${n}'s phone`, P[n].frames, starts[k], ends[k], round, [song.title, song.artist, ...typed], S.base, { stripOwn: true }));
    }
    assert(scanned.every((n) => n > 0), `round ${round} (${cat}): ${scanned.join('+')} frames of the open question on the tv, the second tv and three phones: no song, no typed text, nothing of the round's outcome`);
    if (plan.ui) {
      // R2: reactions of Anouk through the real bar, with the song still hidden
      const n0 = (await reactionsOf(D)).length;
      await A.page.locator('[data-testid="react-btn"][data-emoji="👏"]').click();
      assert(await attr(A.page, 'react-bar', 'data-cooldown') === 'true', 'the bar goes into its cool-down after a tap');
      await A.page.locator('[data-testid="react-btn"][data-emoji="😮"]').click();
      await D.locator('[data-testid="screen-reaction"][data-emoji="👏"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
      await H.locator('[data-testid="host-reaction"][data-emoji="👏"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
      const fl = await D.locator('[data-testid="screen-reaction"][data-emoji="👏"]').first().textContent();
      assert(fl.includes('Anouk') && fl.includes('🦄'), 'the reaction floats on the tv with Anouk\'s name and avatar (during the question, once she answered)');
      await sendRaw(A, { t: 'react', emoji: '😂' }); // inside the server's own gap: dropped
      await sleep(600);
      const mine = (await reactionsOf(D)).slice(n0).filter((r) => r.name === 'Anouk');
      assert(mine.length === 1 && mine[0].emoji === '👏', `the cool-down and the server's gap let exactly one of Anouk's taps through (${mine.map((r) => r.emoji).join('')})`);
      for (const n of ['Bram', 'Cas']) assert(await P[n].page.locator('[data-testid="screen-reaction"], [data-testid="host-reaction"], .rx').count() === 0, `${n}'s phone shows no floating reaction`);
    }
    // the standings the round started from
    if (!S.base) S.base = Object.fromEntries((await pview(A)).game.disco.progress.map((p) => [p.id, { streak: p.streak, jokers: p.jokers }]));

    // ----- reveal -----
    await H.getByTestId('room-reveal').click();
    for (const n of NAMES) await P[n].page.waitForFunction((r) => { const v = window.__ttRoom.session.view; return v.phase === 'revealed' && v.game.round === r; }, round, { timeout: 15000 });
    await D.waitForFunction((r) => { const v = window.__ttScreen.session.view; return v.phase === 'revealed' && v.game.round === r; }, round);
    // a doubt: the spelleider decides (Goed)
    if (plan.doubt) {
      const row = await H.locator('[data-testid="disco-regie-row"][data-name="Cas"]').getAttribute('data-row');
      assert(await attr(P.Cas.page, 'disco-verdict', 'data-verdict') === 'doubt', 'Cas\'s near-miss waits for the spelleider ("?")');
      assert((await tvRows(D)).find((r) => r.name === 'Cas').verdict === 'doubt', 'the tv shows her answer as a doubt');
      assert((await tvRows(D)).every((r) => r.fastest === (r.name === fast)), `with a doubt on the table the snelste is already ${fast}`);
      assert(await H.getByTestId('room-next').getAttribute('data-state') !== null, 'the spelleider sees "Volgend nummer" only after deciding');
      await H.getByTestId(`disco-judge-good-${row}`).click();
      await P.Cas.page.waitForFunction(() => window.__ttRoom.session.view.game.reveal.mine.correct === true);
      assert(true, `round ${round}: the spelleider makes Cas's doubt Goed`);
    }
    S.base = null; // set again at the start of the next round (from the final standings below)

    // ----- the verdicts as the marks show them -----
    const rows = await (async () => {
      let r;
      await poll(`round ${round}: tv results`, async () => { r = await tvRows(D); return r.length === 3 ? null : `${r.length} rows`; });
      return r;
    })();
    const exp = (n) => X[n];
    await poll(`round ${round} (${cat}): marks on the tv`, async () => {
      const r = await tvRows(D);
      for (const n of NAMES) {
        const row = r.find((x) => x.name === n);
        const right = rightNames.includes(n);
        const wantStreak = right && exp(n).streak >= 2 ? String(exp(n).streak) : null;
        if (row.streak !== wantStreak) return `${n}: streak mark ${row.streak}, expected ${wantStreak}`;
        if (row.fastest !== (n === expectFast) || row.fastMark !== (n === expectFast ? 1 : 0)) return `${n}: snelste ${row.fastest}/${row.fastMark}, expected ${n === expectFast}`;
        const wantJoker = earned[n] ? 'earned' : null;
        if (row.joker !== wantJoker) return `${n}: joker mark ${row.joker}, expected ${wantJoker}`;
        if (!AVATARS.includes(row.avatar)) return `${n}: avatar ${row.avatar}`;
      }
      return null;
    });
    assert(true, `round ${round} (${cat}): tv marks: ${NAMES.map((n) => `${n} ${rightNames.includes(n) ? `right 🔥${X[n].streak}` : plan.how[n]}${n === expectFast ? ' ⚡' : ''}${earned[n] ? ' +🃏' : ''}`).join(', ')}`);
    assert(rows.filter((x) => x.fastest).length === (expectFast ? 1 : 0), `round ${round}: ${expectFast ? 'exactly one' : 'no'} player has the snelste mark`);
    // the spelleider's regie shows the same marks
    assert(await H.locator('[data-testid="disco-regie"] [data-testid="fastest-mark"]').count() === (expectFast ? 1 : 0), `round ${round}: the host's regie list shows ${expectFast ? 'one' : 'no'} ⚡`);

    // ----- the phones: verdict moment (recorded), the numbers of the view -----
    for (const n of NAMES) {
      const x = X[n];
      await poll(`round ${round}: ${n}'s phone numbers`, async () => {
        const w = await pview(P[n]);
        const m = w.game.mine;
        const wantJok = x.jokers;
        if (m.streak !== x.streak) return `${n}: streak ${m.streak}, expected ${x.streak}`;
        if (m.jokers !== wantJok) return `${n}: jokers ${m.jokers}, expected ${wantJok}`;
        if (m.jokerEarned !== earned[n]) return `${n}: jokerEarned ${m.jokerEarned}, expected ${earned[n]}`;
        if ((w.game.disco.fastest?.name ?? null) !== expectFast) return `${n}: fastest in the view ${w.game.disco.fastest?.name}, expected ${expectFast}`;
        return null;
      });
    }
    const verdicts = {};
    for (const n of NAMES) {
      await poll(`round ${round}: ${n}'s verdict moment`, async () => {
        const rec = await P[n].page.evaluate((r) => window.__verdicts[r] || null, round);
        verdicts[n] = rec;
        return rec ? null : 'not seen yet';
      }, 6000).catch(async (e) => { if (n === 'Cas' && plan.doubt) return; throw e; });
    }
    for (const n of NAMES) {
      const rec = verdicts[n];
      if (!rec) continue;
      const x = X[n];
      const right = rightNames.includes(n);
      if (plan.doubt && n === 'Cas') continue; // her verdict moment is the doubt one
      assert(rec.fastest === (n === expectFast && right), `round ${round}: ${n}'s verdict ${rec.fastest ? 'shows' : 'does not show'} "Snelste!"`);
      if (right && x.streak >= 2) assert(rec.streak === String(x.streak) && rec.streakText.includes(`${x.streak} op rij`), `round ${round}: ${n}'s verdict says "${x.streak} op rij!" (${rec.streakText})`);
      else assert(rec.streak == null, `round ${round}: ${n}'s verdict has no streak flame`);
      assert(rec.joker === earned[n], `round ${round}: ${n}'s verdict ${rec.joker ? 'announces' : 'does not announce'} a new joker`);
      const wasOn = before[n].streak >= 2 && !right && plan.how[n] !== 'doubt';
      if (wasOn) assert(rec.over && rec.over.includes(`${before[n].streak} op rij`) && rec.overCount === 1, `round ${round}: ${n}'s streak of ${before[n].streak} is over: the gentle line shows once ("${rec.over}")`);
      else assert(rec.over == null, `round ${round}: ${n}'s verdict has no "reeks voorbij" line`);
    }
    // the header counter of a phone with jokers
    for (const n of NAMES) {
      await poll(`round ${round}: ${n}'s joker counter`, async () => ((await P[n].page.getByTestId('disco-jokers').getAttribute('data-jokers')) === String(X[n].jokers) ? null : `counter ${await P[n].page.getByTestId('disco-jokers').getAttribute('data-jokers')}, expected ${X[n].jokers}`));
    }
    if (round === 2) {
      // after the reveal the bar is back (the verdict moment first, then the card)
      await A.page.locator('[data-testid="disco-moment"][data-moment="choose"], [data-testid="disco-moment"][data-moment="card"]').first().waitFor({ timeout: 10000 });
      await A.page.getByTestId('react-bar').waitFor();
      assert(true, 'round 2: after the reveal the reaction bar is there again');
      for (const [pp, e] of [[B, '🙌'], [C, '🔥']]) await pp.page.evaluate((x) => window.__ttRoom.session.react(x), e);
      await D.locator('[data-testid="screen-reaction"][data-from="Cas"]').first().waitFor({ state: 'attached', timeout: 8000 });
      assert((await D.locator('[data-testid="screen-song"]').count()) === 1, 'the song card is on the tv while reactions float (the probe checks the boxes)');
    }

    // ----- stamping, and the stories of rounds 3, 4 and 8 -----
    const stamps = {};
    const stampNow = async (n, mode = 'avoid') => { stamps[n] = await stampFast(P[n], mode); };
    if (round === 8) {
      // the spelleider flips the fastest to wrong and back: the badge moves on and comes home
      const row = await H.locator('[data-testid="disco-regie-row"][data-name="Anouk"]').getAttribute('data-row');
      await H.getByTestId(`disco-flip-${row}`).click();
      await poll('round 8: the badge moves to the next right answer', async () => ((await pview(P.Bram)).game.disco.fastest?.name === 'Bram' ? null : `fastest ${(await pview(P.Bram)).game.disco.fastest?.name}`));
      await poll('round 8: tv follows', async () => { const r = await tvRows(D); return r.find((x) => x.name === 'Bram')?.fastest && !r.find((x) => x.name === 'Anouk')?.fastest && !r.find((x) => x.name === 'Anouk')?.streak ? null : JSON.stringify(r); });
      assert(true, 'round 8: Anouk flipped to wrong: ⚡ goes to Bram, her streak mark is gone');
      await H.getByTestId(`disco-flip-${row}`).click();
      await poll('round 8: and back', async () => { const r = await tvRows(D); const a = r.find((x) => x.name === 'Anouk'); return a.fastest && a.streak === String(X.Anouk.streak) && !r.find((x) => x.name === 'Bram').fastest ? null : JSON.stringify(r); });
      assert(true, 'round 8: flipped back to right: ⚡ and the streak are Anouk\'s again');
    }
    if (round === 3) {
      // Anouk stamps through the card UI; the joker she just earned can be offered at once
      await A.page.locator('[data-testid="disco-moment"][data-moment="choose"]').waitFor({ timeout: 12000 });
      assert(await A.page.getByTestId('disco-joker-toggle').count() === 1, 'round 3: the joker she just earned can be used in this very round ("Zet joker in")');
      assert(await attr(A.page, 'disco-jokers', 'data-jokers') === '1', 'her header shows 1 joker');
      const v = await pview(A);
      const pick = pickSquare(v, 'avoid');
      await A.page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${pick}"]`).click();
      await A.page.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, pick);
      assert(await attr(A.page, 'disco-choose', 'data-state') === 'chosen', 'round 3: a normal stamp, no joker used');
      assert((await pview(A)).game.mine.jokers === 1, 'she keeps her joker');
      stamps.Anouk = pick;
    } else if (round === 4) {
      await jokerStory(R, S, stamps);
    } else if (rightNames.includes('Anouk')) await stampNow('Anouk', finish ? 'best' : 'avoid');
    // Bram does not choose in round 4: the spelleider's next round places his chip
    if (rightNames.includes('Bram') && round !== 4) await stampNow('Bram', finish ? 'best' : 'avoid');
    if (rightNames.includes('Cas')) await stampNow('Cas', finish ? 'best' : 'avoid');
    // tv ranking: every 3rd round, a few seconds after the reveal: the marks on the standings
    if (round === 3) {
      await D.locator('[data-testid="screen-ranking"]').waitFor({ timeout: 16000 });
      await poll('round 3: ranking marks', async () => {
        const rk = await D.evaluate(() => [...document.querySelectorAll('[data-testid="screen-progress-row"]')].map((li) => ({
          name: li.dataset.name, streak: li.querySelector('[data-testid="streak-mark"]')?.dataset.streak ?? null, jokers: li.querySelector('[data-testid="joker-mark"]')?.dataset.jokers ?? null,
          avatar: li.querySelector('[data-testid="player-avatar"]')?.dataset.avatar ?? null,
        })));
        const g = (n) => rk.find((r) => r.name === n);
        if (rk.length !== 3) return `rows ${rk.length}`;
        for (const n of ['Anouk', 'Bram']) if (g(n).streak !== '3' || g(n).jokers !== '1') return `${n}: 🔥${g(n).streak} 🃏${g(n).jokers}`;
        if (g('Cas').streak !== null || g('Cas').jokers !== null) return 'Cas has marks';
        if (rk.some((r) => !AVATARS.includes(r.avatar))) return 'avatar missing';
        return null;
      }, 3000);
      assert(true, 'round 3: the tv ranking shows 🔥3 and a 🃏 for Anouk and Bram, nothing for Cas, with avatars');
      await shot(D, 'ranking');
    }

    // ----- the round is settled: every screen agrees; then on -----
    const sv = await sview(D);
    S.base = standing(sv) && Object.fromEntries(Object.entries(standing(sv)).map(([id, s]) => [id, { streak: s.streak, jokers: s.jokers }]));
    for (const n of NAMES) {
      const id = P[n].id;
      assert(S.base[id].streak === X[n].streak && S.base[id].jokers === X[n].jokers - (round === 4 && n === 'Anouk' ? 1 : 0), `round ${round}: standings say ${n} 🔥${S.base[id].streak} 🃏${S.base[id].jokers}`);
    }
    if (round === 4) X.Anouk.jokers--; // the joker is spent for good now
    // a bingo stops the game at once; the spelleider stops it (to the prize ceremony)
    const stopNow = !!(await hspec(H)).game.disco.bingo;
    if (stopNow) {
      won = true;
      S.wonRound = round;
      if (round <= 10) throw new Error(`ASSERT: the game ended already in round ${round} (a line too early for the script)`);
    }
    const beforeNext = { Bram: (await pview(P.Bram)).game.mine };
    if (round === 4) {
      // the automatic placement for Bram (he did not choose): his joker is not spent
      assert((await pview(P.Bram)).game.disco.choice == null, 'round 4: Bram has not chosen a square');
    }
    // the second display (and the host) saw it all
    await goOnHost(H, stopNow ? 'disco-finish' : 'room-next');
    if (round === 4) {
      await P.Bram.page.waitForFunction(() => window.__ttRoom.session.view.phase === 'answering' && window.__ttRoom.session.view.game.round === 5, null, { timeout: 15000 });
      const bv = await pview(P.Bram);
      const idx = bv.game.mine.marks.findIndex((m, i) => m != null && beforeNext.Bram.marks[i] == null);
      assert(idx >= 0 && bv.game.mine.card[idx] === cat, `round 4: the automatic placement put Bram's chip on a ${cat} square (${idx})`);
      assert(bv.game.mine.jokers === 1 && bv.game.mine.streak === 4, `round 4: the automatic placement did not spend Bram's joker (jokers ${bv.game.mine.jokers}, 🔥${bv.game.mine.streak})`);
      const av = await pview(P.Anouk);
      assert(av.game.mine.jokers === 0 && av.game.mine.card[S.jokerSq] !== cat && av.game.mine.marks[S.jokerSq] != null, 'round 4: Anouk\'s joker stays spent after the next round starts: the chip is still on the other colour');
    }
  }
  assert(won, `the game was won (round ${S.wonRound}, categories ${S.cats.join(' ')})`);
  assert(S.doubtDone, 'a doubt case was played');
  await ceremony(R, X, S);
  return R;
}

/** Round 4, Anouk through the phone UI: the joker. */
async function jokerStory(R, S, stamps) {
  const { H, D, A, B } = R;
  const page = A.page;
  await page.locator('[data-testid="disco-moment"][data-moment="choose"]').waitFor({ timeout: 15000 });
  assert(await attr(page, 'disco-jokers', 'data-jokers') === '1', 'round 4: one joker in the header');
  const toggle = page.getByTestId('disco-joker-toggle');
  assert(await toggle.getAttribute('data-on') === 'false' && await attr(page, 'disco-joker-note', 'data-state') === 'off', 'round 4: "Zet joker in" is off');
  assert(await attr(page, 'disco-choose', 'data-state') === 'choose', 'round 4: she is asked to choose a square of the round colour');
  assert(await page.locator('[data-testid="disco-card"] [data-joker="true"]').count() === 0, 'with the joker off no square is offered of another colour');
  let v = await pview(A);
  const cat = v.game.disco.cat;
  assert(v.game.disco.jokerSquares.length > 0 && v.game.disco.jokerSquares.every((i) => v.game.mine.card[i] !== cat), 'the view offers jokerSquares, all of other colours');
  await toggle.click();
  await page.locator('[data-testid="disco-joker-toggle"][data-on="true"]').waitFor();
  assert(await attr(page, 'disco-joker-note', 'data-state') === 'on' && await attr(page, 'disco-choose', 'data-state') === 'joker', 'switched on: the card says "Kies elk open vakje"');
  v = await pview(A);
  const js = v.game.disco.jokerSquares;
  const offered = await page.locator('[data-testid="disco-card"] [data-joker="true"]').evaluateAll((els) => els.map((e) => Number(e.dataset.index)));
  assert(offered.length === js.length && offered.every((i) => js.includes(i)), `the card offers ${offered.length} squares of other colours (★)`);
  assert(offered.every((i) => v.game.mine.card[i] !== cat) && v.game.disco.choosable.every((i) => !offered.includes(i)), 'none of them has the round colour');
  await shot(page, 'joker-on');
  const jokerSq = pickSquare(v, 'avoid', js);
  S.jokerSq = jokerSq;
  await page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${jokerSq}"][data-joker="true"]`).click();
  await page.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, jokerSq);
  await poll('joker placed: jokers drop', async () => ((await pview(A)).game.mine.jokers === 0 ? null : 'still 1'));
  assert(await attr(page, 'disco-choose', 'data-state') === 'joker-chosen', 'the chip lies on another colour: "Joker ingezet!"');
  assert(await attr(page, 'disco-jokers', 'data-jokers') === '0' && await page.getByTestId('disco-jokers').isHidden(), 'the header shows no jokers any more');
  assert(await page.locator(`[data-testid="disco-sq-${jokerSq}"][data-joker-chip="true"]`).count() === 1 && await page.getByTestId('disco-joker-chip').count() === 1, 'the square carries a joker chip');
  assert(await attr(page, 'disco-joker-note', 'data-state') === 'spent', 'the note says the joker is used up unless she moves back');
  await poll('tv marks the spent joker', async () => { const r = await tvRows(D); return r.find((x) => x.name === 'Anouk').joker === 'spent' ? null : JSON.stringify(r.find((x) => x.name === 'Anouk')); });
  await poll('others see 0 jokers for Anouk', async () => { const w = await pview(B); return w.game.disco.progress.find((p) => p.name === 'Anouk').jokers === 0 ? null : 'still 1'; });
  assert(true, 'the tv marks the joker as spent (ingezet) and other phones see Anouk at 0 jokers');
  await shot(D, 'joker-spent');
  // back to the round colour: the joker is back
  const back = pickSquare(await pview(A), 'avoid');
  await page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${back}"]`).click();
  await page.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, back);
  await poll('joker back', async () => ((await pview(A)).game.mine.jokers === 1 ? null : 'still 0'));
  assert(await page.getByTestId('disco-joker-chip').count() === 0 && await attr(page, 'disco-jokers', 'data-jokers') === '1', 'moving the chip back to the round colour gives the joker back (header 1, no joker chip)');
  await poll('tv: no longer spent', async () => { const r = await tvRows(D); return r.find((x) => x.name === 'Anouk').joker == null ? null : 'still spent'; });
  assert(true, 'the tv mark is gone again');
  // and use it again, now with the real toggle button
  if (await page.getByTestId('disco-joker-toggle').getAttribute('data-on') !== 'true') await page.getByTestId('disco-joker-toggle').click();
  await page.locator('[data-testid="disco-joker-toggle"][data-on="true"]').waitFor();
  await page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${jokerSq}"][data-joker="true"]`).click();
  await page.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, jokerSq);
  await poll('used again', async () => ((await pview(A)).game.mine.jokers === 0 ? null : 'still 1'));
  await poll('tv again spent', async () => ((await tvRows(D)).find((x) => x.name === 'Anouk').joker === 'spent' ? null : 'no'));
  // the toggle button with a chip on another colour: "Joker terug" takes the chip back and keeps the joker
  assert(await page.getByTestId('disco-joker-toggle').textContent().then((t) => /Joker terug/.test(t)), 'with the chip on another colour the button reads "Joker terug"');
  // the spelleider flips her to wrong: joker and chip are returned
  const row = await H.locator('[data-testid="disco-regie-row"][data-name="Anouk"]').getAttribute('data-row');
  await H.getByTestId(`disco-flip-${row}`).click();
  await poll('flip to wrong: the joker returns, the chip goes', async () => {
    const w = await pview(A);
    if (w.game.reveal.mine.correct !== false) return 'not wrong yet';
    if (w.game.mine.jokers !== 1) return `jokers ${w.game.mine.jokers}`;
    if (w.game.mine.marks[jokerSq] != null) return 'chip still there';
    if (w.game.disco.choice != null) return 'choice kept';
    return null;
  });
  assert(true, 'the spelleider flips Anouk to wrong: her joker is back (1) and the chip is off the card');
  await poll('tv after the flip', async () => { const r = await tvRows(D); const a = r.find((x) => x.name === 'Anouk'); return a.verdict === 'wrong' && a.joker == null && a.streak == null ? null : JSON.stringify(a); });
  assert(await page.getByTestId('disco-joker-chip').count() === 0, 'no joker chip on her card');
  assert((await pview(B)).game.disco.progress.find((p) => p.name === 'Anouk').streak === 0 && (await pview(B)).game.disco.progress.find((p) => p.name === 'Anouk').jokers === 1, 'other phones see Anouk at 🔥0 🃏1');
  // and back to right: streak restored, she places the joker once more
  await H.getByTestId(`disco-flip-${row}`).click();
  await poll('flip back: right again', async () => { const w = await pview(A); return w.game.reveal.mine.correct === true && w.game.mine.streak === 4 && w.game.mine.jokers === 1 ? null : `${w.game.reveal.mine.correct} 🔥${w.game.mine.streak} 🃏${w.game.mine.jokers}`; });
  assert(true, 'flipped back to right: 🔥4 and the joker still in hand (she places the chip again)');
  await page.locator('[data-testid="disco-moment"][data-moment="choose"]').waitFor();
  if (await page.getByTestId('disco-joker-toggle').getAttribute('data-on') !== 'true') await page.getByTestId('disco-joker-toggle').click();
  await page.locator('[data-testid="disco-joker-toggle"][data-on="true"]').waitFor();
  await page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${jokerSq}"][data-joker="true"]`).click();
  await page.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, jokerSq);
  await poll('placed after the flip', async () => ((await pview(A)).game.mine.jokers === 0 ? null : 'still 1'));
  await poll('tv spent after the flip', async () => { const a = (await tvRows(D)).find((x) => x.name === 'Anouk'); return a.joker === 'spent' && a.streak === '4' ? null : JSON.stringify(a); });
  assert(true, 'the joker is spent again after the flip back (tv: ingezet, 🔥4)');
  stamps.Anouk = jokerSq;
}


/** The winner screen: the ceremony on the tv, the prizes on the phones and the host, then "Nog een potje". */
async function ceremony(R, X, S) {
  const { H, D, D2, A, B, C, P } = R;
  const errs = R.o.errors;
  console.log('  -- the ending');
  await H.locator('[data-testid="screen-room-host"][data-view="won"]').waitFor({ timeout: 15000 });
  for (const p of [A, B, C]) await p.page.locator('[data-testid="screen-room-player"][data-view="won"]').waitFor({ timeout: 15000 });
  const t0 = Date.now();
  const sv = await sview(D);
  const d = sv.game.disco;
  // ----- what the statistics say, against what this script counted -----
  const byName = Object.fromEntries(d.stats.map((s) => [s.name, s]));
  for (const n of NAMES) {
    const x = X[n];
    const s = byName[n];
    assert(s.answers === x.answers && s.right === x.right && s.doubts === x.doubts && s.fastest === x.fastest && s.best === x.best,
      `${n}: the game's statistics match the script's count (answers ${x.answers}, right ${x.right}, doubts ${x.doubts}, ⚡ ${x.fastest}, longest streak ${x.best})`);
  }
  assert(byName.Anouk.jokersUsed === 1 && byName.Bram.jokersUsed === 0 && byName.Cas.jokersUsed === 0, 'jokers used: Anouk 1, the others 0');
  // ----- the awards the script expects -----
  const winners = sv.game.winnerIds;
  const toGo = Object.fromEntries(d.progress.map((p) => [p.name, p.toGo]));
  const most = (key, min) => { const m = Math.max(...NAMES.map((n) => X[n][key])); return m >= min ? NAMES.filter((n) => X[n][key] === m) : null; };
  const want = [];
  if (most('fastest', 1)) want.push(['fastest', most('fastest', 1)]);
  if (most('best', 2)) want.push(['streak', most('best', 2)]);
  if (most('doubts', 1)) want.push(['doubts', most('doubts', 1)]);
  const share = (n) => X[n].right / X[n].answers;
  const eligible = NAMES.filter((n) => X[n].answers >= 3);
  const top = Math.max(...eligible.map(share));
  if (top >= 0.5) want.push(['sharp', eligible.filter((n) => share(n) === top)]);
  const losers = NAMES.filter((n) => !winners.includes(P[n].id) && toGo[n] > 0);
  if (losers.length) { const m = Math.min(...losers.map((n) => toGo[n])); if (m <= 2) want.push(['close', losers.filter((n) => toGo[n] === m)]); }
  const kinds = want.map(([k]) => k);
  console.log(`  (expected awards: ${want.map(([k, h]) => `${k}: ${h.join('+')}`).join(' | ')})`);
  assert(want.some(([k, h]) => k === 'fastest' && h.join() === 'Anouk'), 'Anouk was snelste most often (the script made her so)');
  assert(want.some(([k, h]) => k === 'streak' && h.join() === 'Bram') && X.Bram.best === 9, 'Bram has the longest streak (9 in a row)');
  assert(want.some(([k, h]) => k === 'doubts' && h.join() === 'Cas'), 'Cas is the one with the doubt case');
  assert(want.some(([k, h]) => k === 'sharp' && h.join() === 'Bram'), 'Bram has the highest share right');
  const check = (label, list, kindOf, holdersOf) => {
    assert(list.map(kindOf).join() === kinds.join(), `${label}: the awards in ceremony order are ${kinds.join(', ')} (got ${list.map(kindOf).join(', ')})`);
    list.forEach((a, i) => assert(holdersOf(a).split('|').sort().join() === want[i][1].slice().sort().join(), `${label}: ${kindOf(a)} goes to ${want[i][1].join(' & ')} (got ${holdersOf(a)})`));
  };
  assert(d.awards.length === want.length, `the view holds ${want.length} awards`);
  check('the view', d.awards, (a) => a.kind, (a) => a.holders.map((h) => h.name).join('|'));
  const sharpAward = d.awards.find((a) => a.kind === 'sharp');
  assert(sharpAward.value === Math.round(top * 100), `Scherpschutter: ${sharpAward.value}% right (${X.Bram.right} of ${X.Bram.answers})`);
  assert(d.awards.find((a) => a.kind === 'streak').value === 9, 'Langste reeks: 9 op rij');
  // the host tab
  await H.getByTestId('host-awards').waitFor({ timeout: 5000 });
  const hostItems = await H.locator('[data-testid="host-award"]').evaluateAll((els) => els.map((e) => ({ kind: e.dataset.kind, holders: e.dataset.holders })));
  check('the host tab', hostItems, (a) => a.kind, (a) => a.holders);
  // the phones
  for (const n of NAMES) {
    await P[n].page.getByTestId('disco-awards').waitFor({ timeout: 20000 });
    const items = await P[n].page.locator('[data-testid="disco-award"]').evaluateAll((els) => els.map((e) => ({ kind: e.dataset.kind, holders: e.dataset.holders, mine: e.dataset.mine })));
    check(`${n}'s phone`, items, (a) => a.kind, (a) => a.holders);
    const mineKinds = want.filter(([, h]) => h.includes(n)).map(([k]) => k);
    assert(items.filter((a) => a.mine === 'true').map((a) => a.kind).join() === mineKinds.join(), `${n}'s phone marks her own awards (data-mine): ${mineKinds.join(', ') || 'none'}`);
    if (mineKinds.length) {
      const line = await P[n].page.getByTestId('my-awards').textContent();
      assert(/^Jij:/.test(line.trim()) && mineKinds.every((k) => line.includes(d.awards.find((a) => a.kind === k).title)), `${n}'s phone says "${line.trim()}"`);
    } else assert(await P[n].page.getByTestId('my-awards').count() === 0, `${n} won no prize: no "Jij:" line`);
  }
  assert(await A.page.getByTestId('disco-win-step').getAttribute('data-step') === 'prizes', 'the phone shows the prizes step of the winner moment');
  await shot(A.page, 'prizes');
  // reactions on the winner moment
  assert(await A.page.getByTestId('react-bar').count() === 1, 'the reaction bar is on the winner moment');
  await pastServerGap(D, 'Anouk'); // (normally long over: no wait)
  await A.page.locator('[data-testid="react-btn"][data-emoji="🎉"]').click();
  await D.locator('[data-testid="screen-reaction"][data-emoji="🎉"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
  assert(true, 'a reaction from the winner screen floats on the tv');
  // ----- the tv ceremony -----
  const overview = D.locator('[data-testid="screen-ceremony"][data-step="overview"]');
  // a second display that watched the whole game: a reload in the middle lands on the overview
  await D2.locator('[data-testid="screen-ceremony"][data-step="award"]').waitFor({ timeout: 30000 });
  await D2.waitForFunction(() => Number(document.querySelector('[data-testid="screen-ceremony"]')?.dataset.award) >= 1, null, { timeout: 15000 });
  await D2.reload();
  await D2.locator('[data-testid="screen-ceremony"]').waitFor({ timeout: 20000 });
  assert(await D2.getByTestId('screen-ceremony').getAttribute('data-step') === 'overview', 'a display reloaded in the middle of the ceremony lands on the overview');
  await sleep(700);
  assert(await D2.getByTestId('screen-ceremony').getAttribute('data-step') === 'overview' && await D2.getByTestId('screen-award').count() === 0, 'and stays there (no replay of the awards)');
  assert(await D2.locator('[data-testid="screen-award-item"]').count() === want.length, 'the overview lists every award');
  // the first display runs the whole ceremony
  await overview.waitFor({ timeout: 40000 });
  const cer = await D.evaluate(() => window.__cer.slice());
  const steps = cer.map((c) => c.split('|'));
  assert(steps[0][0] === 'winner', `the ceremony starts with the winner (${cer[0]})`);
  assert(steps.filter((x) => x[0] === 'award').map((x) => x[2]).join() === kinds.join(), `then each award in turn: ${steps.filter((x) => x[0] === 'award').map((x) => x[2]).join(', ')}`);
  assert(steps.filter((x) => x[0] === 'award').every((x, i) => Number(x[1]) === i), 'the award steps are numbered 0, 1, 2 ...');
  assert(steps[steps.length - 1][0] === 'overview' && steps.map((x) => x[0]).join().replace(/(award,)+/g, 'award,') === 'winner,award,overview', `and ends on the overview (${steps.map((x) => x[0]).join(' > ')})`);
  const tvItems = await D.locator('[data-testid="screen-award-item"]').evaluateAll((els) => els.map((e) => ({ kind: e.dataset.kind, holders: e.dataset.holders })));
  check('the tv overview', tvItems, (a) => a.kind, (a) => a.holders);
  assert(Date.now() - t0 > 6000, 'the ceremony took its time (winner first, one award at a time)');
  await shot(D, 'overview');
  const ov = await D.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight }));
  assert(ov.sw <= ov.iw && ov.sh <= ov.ih, 'the overview fits the tv without scrollbars');
  const rx = await D.evaluate(() => ({ n: window.__rx.samples, ov: window.__rx.overlaps }));
  assert(rx.n > 0, `${rx.n} samples of floating reactions during the game`);
  // a reaction that starts while the QR code / badge / song card is on screen keeps clear of it ...
  const started = rx.ov.filter((o) => o.there);
  assert(started.length === 0, `a floating reaction that starts next to the QR code, the join badge or the song card never overlaps them (${started.length}: ${JSON.stringify(started.slice(0, 2))})`);
  // ... and so does one that is already in flight when the song card appears (the spelleider reveals)
  const inflight = rx.ov.filter((o) => !o.there);
  bug(inflight.length === 0, `a reaction already floating when the song card appears does not cross it (${inflight.length} samples, e.g. ${JSON.stringify(inflight.slice(0, 1).map((o) => ({ what: o.what, from: o.from, ox: o.ox, oy: o.oy })))})`);
  // ----- Nog een potje: the awards, streaks and jokers are gone, the avatars stay -----
  assert(await H.getByTestId('room-again').isVisible(), '"Nog een potje" is on the host tab');
  const avBefore = Object.fromEntries((await pview(A)).players.map((p) => [p.name, p.avatar]));
  await H.getByTestId('room-again').click();
  for (const n of NAMES) await P[n].page.waitForFunction(() => { const v = window.__ttRoom.session.view; return v.phase === 'answering' && v.game.round === 1; }, null, { timeout: 20000 });
  await D.waitForFunction(() => window.__ttScreen.session.view.game.round === 1 && window.__ttScreen.session.view.phase === 'answering');
  await freshCheck(R, avBefore, 'after "Nog een potje"');
  // a short second game; "Nog een potje" once more in the middle of its ceremony
  await quickGame(R, 40);
  await D.locator('[data-testid="screen-ceremony"][data-step="winner"], [data-testid="screen-ceremony"][data-step="award"]').first().waitFor({ timeout: 20000 });
  assert(await D.locator('[data-testid="screen-ceremony"]').count() === 1, 'game 2: the ceremony is running on the tv');
  await H.getByTestId('room-again').click();
  for (const n of NAMES) await P[n].page.waitForFunction(() => { const v = window.__ttRoom.session.view; return v.phase === 'answering' && v.game.round === 1; }, null, { timeout: 20000 });
  await D.waitForFunction(() => window.__ttScreen.session.view.game.round === 1 && window.__ttScreen.session.view.phase === 'answering');
  await freshCheck(R, avBefore, 'after "Nog een potje" in the middle of the ceremony');
  assert(await D.getByTestId('screen-ceremony').count() === 0 && await D.getByTestId('screen-award').count() === 0, 'the tv left the ceremony at once');
  assert(errs.length === 0, `no page errors (${errs.join('; ')})`);
}

/** A fresh game: no streaks, jokers, awards anywhere; the avatars are the same. */
async function freshCheck(R, avBefore, label) {
  const { H, D, A, B, C, P } = R;
  for (const n of NAMES) {
    const v = await pview(P[n]);
    assert(v.game.mine.streak === 0 && v.game.mine.jokers === 0 && v.game.mine.stamped === 0, `${label}: ${n} starts at 🔥0 🃏0 with an empty card`);
    assert(v.game.disco.awards == null && v.game.disco.stats == null && v.game.disco.progress.every((p) => p.streak === 0 && p.jokers === 0), `${label}: ${n}'s view holds no awards, no stats, nobody has a streak or joker`);
    assert(v.players.find((p) => p.name === n).avatar === avBefore[n], `${label}: ${n} keeps her avatar`);
  }
  assert(await A.page.getByTestId('disco-jokers').isHidden(), `${label}: no joker counter on the phone`);
  assert(await D.getByTestId('streak-mark').count() === 0 && await D.getByTestId('joker-mark').count() === 0 && await D.getByTestId('screen-awards').count() === 0, `${label}: no marks, no awards on the tv`);
  assert(await H.getByTestId('host-awards').count() === 0, `${label}: no awards on the host tab`);
}

/** Play rounds fast (everybody right, best squares) until somebody wins and the winner screen is up. */
async function quickGame(R, max = 30) {
  const { H, D, A, B, C, P } = R;
  for (let round = 1; round <= max; round++) {
    await H.waitForFunction((r) => { const v = window.__ttHost?.session?.spectatorView(); return v?.phase === 'answering' && v.game.round === r; }, round, { timeout: 30000 });
    await H.waitForFunction((r) => window.__ttHost?.session?.room?.game?.round === r && !!window.__ttHost.session.currentSong(), round);
    const { song } = await serverHost(H);
    const cat = (await hspec(H)).game.disco.cat;
    for (const n of NAMES) { await sendAnswer(P[n], answerOf(cat, song, 'right', round)); await P[n].page.waitForFunction(() => window.__ttRoom.session.view.game.answer != null); await sleep(60); }
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });
    await H.getByTestId('room-reveal').click();
    for (const n of NAMES) await P[n].page.waitForFunction((r) => { const v = window.__ttRoom.session.view; return v.phase === 'revealed' && v.game.round === r; }, round, { timeout: 15000 });
    for (const n of NAMES) await stampFast(P[n], 'best');
    const stop = !!(await hspec(H)).game.disco.bingo;
    await goOnHost(H, stop ? 'disco-finish' : 'room-next');
    if (stop) { await H.locator('[data-testid="screen-room-host"][data-view="won"]').waitFor({ timeout: 15000 }); return round; }
  }
  throw new Error('ASSERT: the quick game never ended');
}

// ======================================================================================
//  3. Quiz and Bingo
// ======================================================================================
async function otherGames(R, { fresh = false } = {}) {
  console.log('\n## quiz and classic bingo');
  const { H, D, A, B, C, P } = R;
  const errs = R.o.errors;
  if (!fresh) {
    await H.evaluate(() => window.__ttHost.session.toLobby());
    await H.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 15000 });
  }
  const avs = {};
  for (const n of NAMES) avs[n] = (await pview(P[n])).you.avatar;
  const avatarsOn = async (page, label, sel = '[data-testid="player-avatar"]') => {
    const have = await page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.dataset.avatar), sel);
    for (const n of NAMES) assert(have.includes(avs[n]), `${label}: ${n}'s avatar ${avs[n]} is shown`);
  };
  await H.getByTestId('room-game-quiz').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await H.getByTestId('room-game-quiz').check();
  await D.locator('[data-testid="screen-game"][data-game="quiz"]').waitFor({ timeout: 10000 });
  await H.getByTestId('room-start').click();
  for (const n of NAMES) await P[n].page.waitForFunction(() => window.__ttRoom.session.view?.phase === 'answering' && window.__ttRoom.session.view.game.kind === 'quiz', null, { timeout: 20000 });
  await A.page.waitForFunction(() => !!window.__ttRoom.session.view.game.quiz.deadline, null, { timeout: 20000 });
  // the bar is not on the question; after answering it is
  assert(await A.page.getByTestId('react-bar').count() === 0, 'quiz: no reaction bar on the open question');
  await A.page.getByTestId('quiz-option-0').click();
  await A.page.getByTestId('react-bar').waitFor({ timeout: 10000 });
  assert(await A.page.getByTestId('react-btn').count() === 6, 'quiz: after answering the reaction bar is there');
  await avatarsOn(D, 'quiz, tv (answering)');
  await avatarsOn(H, 'quiz, host (answering)');
  await A.page.locator('[data-testid="react-btn"][data-emoji="🔥"]').click();
  await D.locator('[data-testid="screen-reaction"][data-emoji="🔥"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
  await H.locator('[data-testid="host-reaction"][data-emoji="🔥"]').first().waitFor({ state: 'attached', timeout: 8000 });
  assert(await B.page.locator('[data-testid="screen-reaction"], .rx').count() === 0, 'quiz: the reaction floats on the tv and the host tab, not on another phone');
  for (const n of ['Bram', 'Cas']) { await P[n].page.evaluate(() => window.__ttRoom.session.answer({ choice: 1 })); }
  await H.getByTestId('room-reveal').click().catch(() => {});
  for (const n of NAMES) await P[n].page.waitForFunction(() => window.__ttRoom.session.view.phase === 'revealed', null, { timeout: 30000 });
  await sleep(500);
  await avatarsOn(A.page, 'quiz, phone (after the reveal)');
  await avatarsOn(D, 'quiz, tv (after the reveal)');
  await avatarsOn(H, 'quiz, host (after the reveal)');
  assert(await A.page.getByTestId('react-bar').count() === 1, 'quiz: the bar is there after the reveal');
  await H.evaluate(() => window.__ttHost.session.toLobby());
  await H.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor({ timeout: 15000 });

  // ----- classic Bingo -----
  await H.getByTestId('room-game-bingo').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await H.getByTestId('room-game-bingo').check();
  await D.locator('[data-testid="screen-game"][data-game="bingo"]').waitFor({ timeout: 10000 });
  await H.getByTestId('room-start').click();
  for (const n of NAMES) await P[n].page.waitForFunction(() => window.__ttRoom.session.view?.phase === 'answering' && window.__ttRoom.session.view.game.kind === 'bingo', null, { timeout: 20000 });
  assert(await A.page.getByTestId('react-bar').count() === 0, 'bingo: no reaction bar before answering');
  await A.page.evaluate(() => window.__ttRoom.session.answer({ pass: true }));
  await A.page.getByTestId('react-bar').waitFor({ timeout: 10000 });
  assert(true, 'bingo: after answering the bar is there');
  await pastServerGap(D, 'Anouk'); // her 🔥 of the quiz (normally long over: no wait)
  await A.page.locator('[data-testid="react-btn"][data-emoji="😮"]').click();
  await D.locator('[data-testid="screen-reaction"][data-emoji="😮"][data-from="Anouk"]').first().waitFor({ state: 'attached', timeout: 8000 });
  await H.locator('[data-testid="host-reaction"][data-emoji="😮"]').first().waitFor({ state: 'attached', timeout: 8000 });
  assert(true, 'bingo: the reaction floats on the tv and the host tab');
  await avatarsOn(D, 'bingo, tv (answering)');
  await avatarsOn(H, 'bingo, host (answering)');
  for (const n of ['Bram', 'Cas']) await P[n].page.evaluate(() => window.__ttRoom.session.answer({ pass: true }));
  await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });
  await H.getByTestId('room-reveal').click();
  for (const n of NAMES) await P[n].page.waitForFunction(() => window.__ttRoom.session.view.phase === 'revealed', null, { timeout: 15000 });
  await sleep(500);
  await avatarsOn(D, 'bingo, tv (after the reveal)');
  await avatarsOn(H, 'bingo, host (after the reveal)');
  await avatarsOn(A.page, 'bingo, phone (after the reveal)');
  assert(await A.page.getByTestId('react-bar').count() === 1, 'bingo: the bar is there after the reveal');
  assert(errs.length === 0, `no page errors (${errs.join('; ')})`);
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
    if (!ONLY || ONLY === 'game' || ONLY === 'other') {
      let R = null;
      if (!ONLY || ONLY === 'game') R = await discoGame(browser, rooms, server);
      if (!ONLY || ONLY === 'other') {
        const fresh = !R;
        R ||= await newParty(browser, rooms, server);
        await otherGames(R, { fresh });
      }
      if (R) { for (const p of [R.A, R.B, R.C]) await p.context.close(); await R.o.context.close(); }
    }
    if (BUGS.length) throw new Error(`${BUGS.length} app bug(s) found by this suite:\n - ${BUGS.join('\n - ')}`);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
