// Discobingo through the Node room server. Four games and two small checks:
//
//  1. the lobby: Discobingo is the default and listed first, a deck of 10 songs says
//     "nog 15 nodig (10 van 25)" and blocks the start;
//  2. a whole game with a fixed seed: the spelleider does not play (1280×720, the music
//     phone), two phones, a third joins halfway. Win with 1 line. Per round: the same category
//     on every screen, the answer form only after the ball landed, the host's music already
//     during the spin with a rising volume (and a fade-out when the round moves on), nothing
//     about the running song or another player's typed text on a phone before the reveal. The
//     four kinds of answer (Exact jaar included), a typo that is right at once, near-misses that
//     wait for the spelleider (Goed / Fout, "Beslis eerst"), flips both ways, choosing and
//     moving a square, the "nog geen fiche" dialog and the automatic placement when the
//     spelleider goes on anyway, reloads, the bingo stop ending in the prizes, "Nog een potje".
//     The automatic reveal is switched off in the lobby here (the spelleider reveals);
//  3. a short game with the spelleider playing along on a phone-sized screen;
//  4. "2 lijnen" through a fast path (answers sent through the page's own session, no waiting
//     for the ball): the bingo stop offers only "volle kaart" or stop; category balance;
//  5. the bingo stages with a tv: the automatic reveal after everybody answered (the shared
//     countdown on leader, tv and phone) and "Wacht nog", the chip states and the dialog, an away
//     player who never causes it, the end-of-fragment fade, a bingo that stops the game at once
//     on tv / phones / leader, going on for 2 lijnen, then a full card, then the prizes;
//  6. PeerJS route: Discobingo can not be chosen, with the notice.
//
// Everything is deterministic: seed 7 (timetunesr.multiSeed.v1), a fixed playlist.
import { join } from 'node:path';
import { launch, startServer, assert, OUT } from './helpers.mjs';
import { startRoomServer, startSignal, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes, silentWav } from './fake-itunes.mjs';
import { CATEGORY_KEYS, bestSquare, completeLines, LINES } from '../../app/js/multi/disco.js';
import { artistVerdict, titleVerdict } from '../../app/js/multi/match.js';

// ---------- a playlist of 30 songs with names that can be typed wrongly in every way we need ----------
const A1 = ['Blauwe', 'Gouden', 'Rode', 'Stille', 'Wilde', 'Zilveren', 'Zwarte', 'Kleine', 'Grote', 'Late'];
const A2 = ['Draaiers', 'Fietsers', 'Molens', 'Schaatsers', 'Bakkers', 'Stromen', 'Dromers', 'Zeilers', 'Vissers', 'Dansers'];
const T1 = ['Dansen', 'Zingen', 'Vliegen', 'Dromen', 'Lopen', 'Zwemmen'];
const T2 = ['onder', 'boven', 'naast', 'langs', 'tussen', 'achter', 'voorbij'];
const T3 = ['de sterren', 'het water', 'de regen', 'mijn straat', 'de maan'];
const TRACKS = Array.from({ length: 30 }, (_, i) => ({
  n: i + 1,
  itunesId: 7800000 + i,
  title: `${T1[i % 6]} ${T2[i % 7]} ${T3[i % 5]}`,
  artist: `${A1[i % 10]} ${A2[(i * 3 + Math.floor(i / 10)) % 10]}`,
  year: 1960 + ((i * 7) % 58),
  previewUrl: `https://audio-ssl.itunes.apple.com/fake/d${i}.m4a`,
}));
/** Game 5 plays to a full card: 60 songs (the same name pattern, still unique). */
const TRACKS60 = Array.from({ length: 60 }, (_, i) => ({
  n: i + 1,
  itunesId: 7900000 + i,
  title: `${T1[i % 6]} ${T2[i % 7]} ${T3[i % 5]}`,
  artist: `${A1[i % 10]} ${A2[(i * 3 + Math.floor(i / 10)) % 10]}`,
  year: 1960 + ((i * 7) % 58),
  previewUrl: `https://audio-ssl.itunes.apple.com/fake/e${i}.m4a`,
}));

const verdictFn = (kind) => (kind === 'artist' ? artistVerdict : titleVerdict);
/** A typo the matcher must accept at once: a doubled letter in the middle. */
const typoOf = (real) => { const k = Math.floor(real.length / 2); return real.slice(0, k) + real[k] + real.slice(k); };
/** A near miss: close, but not close enough for the machine, so the spelleider decides. */
function doubtOf(kind, real) {
  const w = real.split(' ');
  const tries = kind === 'artist' ? [w[w.length - 1], w[0]] : [w.slice(0, -1).join(' '), w.slice(1).join(' ')];
  return tries.find((t) => verdictFn(kind)(t, real).verdict === 'doubt') || null;
}
// the fixtures must do what the test needs from them (otherwise the test would pass for the wrong reason)
{
  assertUnique(TRACKS.map((t) => t.title), 'titles');
  assertUnique(TRACKS.map((t) => t.artist), 'artists');
  for (const t of TRACKS) {
    for (const [kind, real] of [['artist', t.artist], ['title', t.title]]) {
      if (verdictFn(kind)(typoOf(real), real).verdict !== 'right') throw new Error(`fixture: typo of "${real}" is not right`);
      if (!doubtOf(kind, real)) throw new Error(`fixture: no near-miss for "${real}"`);
      if (verdictFn(kind)('Raar antwoord 1', real).verdict !== 'wrong') throw new Error('fixture: nonsense is not wrong');
    }
  }
}
function assertUnique(list, what) { if (new Set(list).size !== list.length) throw new Error(`fixture: duplicate ${what}`); }

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: 'disabled' });
}
const pview = (p) => p.evaluate(() => window.__ttRoom?.session?.view || null);
const hspec = (p) => p.evaluate(() => window.__ttHost?.session?.spectatorView() || null);
const hown = (p) => p.evaluate(() => window.__ttHost?.session?.hostView() || null);
const hroom = (p) => p.evaluate(() => window.__ttHost?.session?.room || null);
const attr = (page, testid, name) => page.getByTestId(testid).getAttribute(name);

/**
 * In every page: record when the answer form is there while the ball has not landed, and the
 * music's volume during the spin (it fades in: silent at the start, full when the ball lands).
 */
function watcher() {
  const w = (window.__disco = { badForm: 0, sawSpin: 0, spinNoForm: 0, spinWait: 0, audioInSpin: 0, audioAfterLand: 0, spins: {}, loudAfterLand: 0 });
  setInterval(() => {
    const st = document.querySelector('[data-testid="disco-stage"]');
    if (!st) return;
    const landed = st.dataset.state === 'landed';
    const form = !!document.querySelector('[data-testid="disco-answer"]');
    const pl = document.getElementById('player');
    const playing = !!pl && !pl.paused;
    if (!landed) {
      if (st.dataset.state === 'spinning') {
        w.sawSpin++; if (!form) w.spinNoForm++; if (document.querySelector('[data-testid="disco-wait"]')) w.spinWait++;
        // per spin: the volume samples while the music already plays
        if (playing) { w.audioInSpin++; const r = st.dataset.round || '?'; (w.spins[r] ??= []).push(Math.round(pl.volume * 100) / 100); }
      }
      if (form) w.badForm++;
    } else if (playing) { w.audioAfterLand++; if (pl.volume > 0.97) w.loudAfterLand++; }
  }, 40);
}

/** A phone with fake audio, the watcher above and a log of every WebSocket frame it receives. */
async function discoPhone(browser, rooms, opts = {}, { tracks = null } = {}) {
  const p = await phone(browser, rooms, opts);
  await installFakeItunes(p.context);
  await p.context.addInitScript(watcher);
  if (tracks) {
    await p.context.addInitScript((list) => {
      if (localStorage.getItem('tt.discoInit')) return;
      localStorage.setItem('tt.discoInit', '1');
      localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'feest', name: 'Feestmix', tracks: list }] }));
      localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('feest'));
    }, tracks);
  }
  p.frames = [];
  p.page.on('websocket', (ws) => ws.on('framereceived', (f) => { if (typeof f.payload === 'string' && f.payload.length > 8) p.frames.push(f.payload); }));
  return p;
}
const HOST_TV = { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false, userAgent: undefined };

/** No frame in frames[from, to) of this phone holds one of the forbidden texts (its own answer is not counted). */
function assertNoPeek(p, from, to, forbidden, label) {
  for (const raw of p.frames.slice(from, to)) {
    let text = raw;
    try { const m = JSON.parse(raw); if (m?.view?.game?.answer) delete m.view.game.answer; text = JSON.stringify(m); } catch { /* not JSON */ }
    for (const f of forbidden) if (f && text.includes(JSON.stringify(f).slice(1, -1))) throw new Error(`ASSERT: ${label} received "${f}" before the reveal: ...${text.slice(Math.max(0, text.indexOf(f) - 120), text.indexOf(f) + 80)}...`);
  }
}

async function waitRound(page, round, isHost = false) {
  await page.waitForFunction(([r, h]) => {
    const v = h ? window.__ttHost?.session?.spectatorView() : window.__ttRoom?.session?.view;
    return v?.phase === 'answering' && v.game.round === r;
  }, [round, isHost], { timeout: 30000 });
}
// on a phone the ball is only on screen while it spins (moment "spin"); the stage element stays in the page
const landed = (page) => page.locator('[data-testid="disco-stage"][data-state="landed"]').waitFor({ state: 'attached', timeout: 15000 });
/** A phone's current full-screen moment (spin | splash | question | submitted | verdict | choose | card | bingo | winner). */
const momentOf = (page) => page.getByTestId('disco-moment').getAttribute('data-moment');
/** Phone: open the menu sheet on one of its pages, run fn, close it again. */
async function inSheet(page, item, fn) {
  await page.getByTestId('disco-menu').click();
  await page.getByTestId(item).click();
  try { return await fn(); } finally { await page.getByTestId('disco-sheet-close').click(); await page.locator('.ph-sheet-wrap:not(.is-open)').waitFor({ state: 'attached' }); }
}
const stageCat = (page) => page.getByTestId('disco-stage').getAttribute('data-cat');

/** Fill in and send an answer on `page` (scope: '' for a phone, '[data-testid="host-own"] ' for the spelleider's own panel). */
async function answer(page, scope, cat, song, how, round) {
  const q = (id) => page.locator(`${scope}[data-testid="${id}"]`);
  const locked = (state) => page.locator(`${scope}[data-testid="disco-answer-state"][data-state="${state}"]`).waitFor();
  if (how === 'pass') { await q('disco-pass').click(); await locked('pass'); return null; }
  let text;
  if (cat === 'exact') {
    // exact: one year off is already wrong
    text = String(how === 'wrong' ? song.year + 1 : song.year);
    await q('disco-year-input').fill(text);
  } else if (cat === 'year') {
    text = String(how === 'wrong' ? song.year + 6 : how === 'near' ? song.year - 2 : song.year);
    await q('disco-year-input').fill(text);
  } else {
    const real = cat === 'artist' ? song.artist : song.title;
    text = how === 'wrong' ? `Raar antwoord ${round}` : how === 'doubt' ? doubtOf(cat, real) : how === 'typo' ? typoOf(real) : real;
    await q('disco-text-input').fill(text);
  }
  await q('disco-lock').click();
  await locked('locked');
  return text;
}

/** The phone taps a square of the round's category (the best one, or another: move) and waits for the server. */
async function stamp(page, { host = false, move = false } = {}) {
  const v = host ? await hown(page) : await pview(page);
  const d = v.game.disco;
  if (!d.choosable.length) return null;
  const marks = v.game.mine.marks.slice();
  if (d.choice != null) marks[d.choice] = null;
  const best = bestSquare(v.game.mine.card, marks, d.cat, d.win);
  const pick = move ? d.choosable.find((i) => i !== best) ?? best : best;
  const card = host ? '[data-testid="host-disco-card"]' : '[data-testid="disco-card"]';
  await page.locator(`${card} [data-testid="disco-sq-${pick}"]`).click();
  await page.waitForFunction(([i, h]) => {
    const w = h ? window.__ttHost?.session?.hostView() : window.__ttRoom?.session?.view;
    return w?.game?.disco?.choice === i;
  }, [pick, host]);
  return pick;
}
const sq = (page, i, card = 'disco-card') => page.locator(`[data-testid="${card}"] [data-testid="disco-sq-${i}"]`);
const rowOf = async (H, name) => Number(await H.locator(`[data-testid="disco-regie-row"][data-name="${name}"]`).getAttribute('data-row'));
const verdictOnPhone = (page, v) => page.locator(`[data-testid="disco-verdict"][data-verdict="${v}"]`).waitFor({ timeout: 10000 });
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Everything the in-page watcher saw. */
const watched = (page) => page.evaluate(() => ({ ...window.__disco }));

/** Lobby: switch "Automatisch naar het resultaat" off (the spelleider reveals by hand in this game). */
async function autoOff(H) {
  const box = H.getByTestId('room-disco-auto');
  assert(await box.isChecked(), 'the lobby: "Automatisch naar het resultaat als iedereen geantwoord heeft" is on by default');
  await box.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await box.uncheck();
  await H.waitForFunction(() => window.__ttHost?.session?.room?.settings?.autoReveal === false);
}

/**
 * The spelleider goes on (`testid`: room-next, disco-go-line2 / -full, disco-finish). When an
 * online player still has to lay a chip, the in-app dialog names them: `wait` taps "Wacht nog"
 * and returns false; otherwise "Toch doorgaan". Away players never cause it.
 */
async function goOn(H, testid = 'room-next', { wait = false, shotName = '' } = {}) {
  const chips = (await hspec(H)).game.disco.chips || [];
  const waiting = chips.filter((c) => c.state === 'choosing').map((c) => c.name);
  await H.getByTestId(testid).click();
  if (!waiting.length) {
    assert(await H.getByTestId('disco-confirm').count() === 0, `nobody online left to choose: no dialog (${testid})`);
    return true;
  }
  const dlg = H.getByTestId('disco-confirm');
  await dlg.waitFor({ timeout: 5000 });
  const text = await H.getByTestId('disco-confirm-text').textContent();
  assert(waiting.every((n) => text.includes(n)) && /nog geen fiche gelegd\. Toch doorgaan\?/.test(text) && /automatisch gelegd/.test(text), `the dialog names who still chooses: "${text}"`);
  assert(await H.evaluate(() => document.activeElement?.dataset?.testid) === 'disco-confirm-wait', 'the dialog has the focus on "Wacht nog" (keyboard)');
  if (shotName) await shot(H, shotName);
  if (wait) {
    await H.getByTestId('disco-confirm-wait').click();
    await dlg.waitFor({ state: 'detached' });
    return false;
  }
  await H.getByTestId('disco-confirm-go').click();
  await dlg.waitFor({ state: 'detached' });
  return true;
}

/** The room's lobby: Discobingo first and selected, then (what the spelleider picks) a start. */
async function lobbyChecks(browser, rooms, server) {
  // a deck of 10 songs: the lobby says what is missing and does not start
  const small = await discoPhone(browser, rooms, { seed: 7 }, { tracks: TRACKS.slice(0, 10) });
  await small.page.goto(`${server.url}#/spelleider`);
  const code = await createRoom(small.page);
  const P = (await discoPhone(browser, rooms)).page;
  await joinRoom(P, server.url, code, 'Anouk', { via: 'link' });
  await waitForPlayers(small.page, 1);
  const first = await small.page.locator('input[name="game"]').first().getAttribute('value');
  assert(first === 'disco', 'the lobby lists Discobingo first');
  assert(await small.page.getByTestId('room-game-disco').isChecked(), 'the lobby starts on Discobingo (nothing stored)');
  assert((await hroom(small.page)).settings.game === 'disco', 'the room on the server is a Discobingo room (the app asks for it itself)');
  await P.waitForFunction(() => /Discobingo/.test(document.querySelector('[data-testid="room-wait"]')?.textContent || '') && /1 lijn/.test(document.querySelector('[data-testid="room-wait"]').textContent));
  assert(true, 'the player sees "Discobingo (winnen met 1 lijn)" in the waiting room');
  await small.page.getByTestId('room-disco-settings').waitFor();
  const need = small.page.getByTestId('room-disco-need');
  await need.waitFor();
  assert(await need.getAttribute('data-missing') === '15', 'a deck of 10 songs: 15 missing');
  assert(/minstens 25 nummers nodig: nog 15 \(10 van 25\)/.test(await need.textContent()), `message: "${(await need.textContent()).trim()}"`);
  assert(await small.page.getByTestId('room-start').isDisabled(), 'start is disabled with too few songs');
  for (const w of ['line1', 'line2', 'full']) await small.page.getByTestId(`room-disco-win-${w}`).waitFor();
  assert(await small.page.getByTestId('room-disco-win-line1').isChecked(), '"1 lijn" is the default win');
  await shot(small.page, 'disco-01-host-lobby-too-few');
  await small.context.close();
  await P.context().close();
}

// ======================================================================================
//  Game 1: the whole game, one line wins
// ======================================================================================
async function wholeGame(browser, rooms, server) {
  const host = await discoPhone(browser, rooms, { seed: 7, ...HOST_TV }, { tracks: TRACKS });
  const H = host.page;
  const pages = [H];
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const anouk = await discoPhone(browser, rooms);
  const bram = await discoPhone(browser, rooms, { viewport: { width: 360, height: 740 } });
  const A = anouk.page;
  const B = bram.page;
  pages.push(A, B);
  await joinRoom(A, server.url, code, 'Anouk', { via: 'link' });
  await joinRoom(B, server.url, code, 'Bram', { via: 'link' });
  await waitForPlayers(H, 2);
  assert(await H.getByTestId('room-game-disco').isChecked() && (await hroom(H)).settings.game === 'disco', 'the room is set to Discobingo by default');
  await shot(H, 'disco-02-host-lobby');
  await autoOff(H);
  await shot(A, 'disco-03-player-lobby');

  let cas = null;
  let C = null;
  const phones = () => [anouk, bram, ...(cas ? [cas] : [])];
  const mark = () => new Map([...phones()].map((p) => [p, p.frames.length]));
  let from = mark();
  await H.getByTestId('room-start').click();

  const kinds = new Set();
  const cats = [];
  const S = { typo: false, goodDoubt: false, badDoubt: false, flipOff: false, flipGrant: false, moved: false, reloadAnswering: false, reloadRevealed: false, auto: 0, near: false, fadeOut: false, dialog: false, exactShot: false };
  let last = 0;
  for (let round = 1; round <= 30; round++) {
    last = round;
    await Promise.all([waitRound(H, round, true), ...phones().map((p) => waitRound(p.page, round))]);
    if (round === 1) {
      // the ball is still spinning: no question yet, the music already starts, quietly
      for (const [pg, who] of [[A, 'Anouk'], [B, 'Bram'], [H, 'host']]) await pg.locator('[data-testid="disco-stage"][data-state="spinning"]').waitFor({ timeout: 3000 });
      assert(await A.getByTestId('disco-answer').count() === 0 && await A.getByTestId('disco-wait').isVisible(), 'round 1: while the ball spins the phone shows no answer form, only "de discobal kiest de vraag"');
      await H.waitForFunction(() => { const p = document.getElementById('player'); return p && !p.paused && p.volume < 0.6 && document.querySelector('[data-testid="disco-stage"]')?.dataset.state === 'spinning'; }, null, { timeout: 4000 });
      assert(true, 'round 1: the spelleider\'s music already plays while the ball spins, still soft (fade-in)');
      assert(await A.evaluate(() => { const p = document.getElementById('player'); return !p || p.paused; }), 'a phone never plays the music');
      assert(await attr(A, 'disco-category', 'data-cat') === '', 'round 1: no category named before the ball has landed');
      await shot(A, 'disco-04-player-spinning');
      await shot(H, 'disco-05-host-spinning');
    }
    await Promise.all([landed(H), ...phones().map((p) => landed(p.page))]);
    const view = await pview(A);
    const cat = view.game.disco.cat;
    cats.push(cat);
    const seen = [await stageCat(H), await stageCat(A), await stageCat(B), ...(cas ? [await stageCat(C)] : []), await attr(H, 'disco-category', 'data-cat'), await attr(A, 'disco-category', 'data-cat'), await attr(B, 'disco-category', 'data-cat')];
    assert(seen.every((c) => c === cat) && (await hspec(H)).game.disco.cat === cat && (await pview(B)).game.disco.cat === cat, `round ${round}: ${cat} on the host, both phones and in the views`);
    // the answer form of this category and only that one
    for (const pg of [A, B]) {
      await pg.getByTestId('disco-answer').waitFor();
      const form = { year: await pg.getByTestId('disco-year-input').count(), text: await pg.getByTestId('disco-text-input').count(), decade: await pg.locator('[data-testid^="disco-decade-"]').count() };
      const want = { year: cat === 'year' || cat === 'exact', text: cat === 'artist' || cat === 'title' };
      assert(!form.decade && !!form.year === want.year && !!form.text === want.text, `round ${round}: the ${cat} form on ${pg === A ? 'Anouk' : 'Bram'}'s phone (${JSON.stringify(form)})`);
      if (want.year) {
        const hint = await pg.getByTestId('disco-hint').textContent();
        assert(cat === 'exact' ? /Precies/.test(hint) && !/ernaast/.test(hint) : /2 jaar ernaast mag/.test(hint), `round ${round}: the ${cat} hint says how exact ("${hint}")`);
      }
    }
    kinds.add(cat);
    await H.waitForFunction(() => document.getElementById('player') && !document.getElementById('player').paused && document.getElementById('player').volume > 0.97, null, { timeout: 8000 });
    assert(true, `round ${round}: the music plays at full volume on the spelleider's phone once the ball landed`);
    const { song } = await serverHost(H);
    assert(TRACKS.some((t) => t.itunesId === song.itunesId), `round ${round}: "${song.title}" from the playlist`);
    if (cas) { await C.getByTestId('disco-answer').waitFor(); await answer(C, '', cat, song, 'pass', round); }

    // ----- what the phones answer -----
    const typed = cat === 'artist' || cat === 'title';
    const aHow = typed && !S.typo ? 'typo' : cat === 'year' && !S.near ? 'near' : 'right';
    let bHow;
    if (cat === 'exact') bHow = !S.flipGrant ? 'wrong' : 'pass';
    else if (typed) bHow = !S.goodDoubt || !S.badDoubt ? 'doubt' : 'wrong';
    else bHow = round % 2 ? 'wrong' : 'pass';
    if (cat === 'exact' && !kinds.has('q-exact')) { kinds.add('q-exact'); await shot(B, 'disco-07c-player360-question-exact'); }
    const aText = await answer(A, '', cat, song, aHow, round);
    const bText = await answer(B, '', cat, song, bHow, round);
    if (aHow === 'typo') S.typo = true;
    if (aHow === 'near') S.near = true;
    if (round === 1) await shot(A, `disco-06-player-answer-${cat}`);
    if (!kinds.has(`shot-${cat}`)) { kinds.add(`shot-${cat}`); await shot(B, `disco-07-player360-answer-${cat}`); }

    // ----- reload while answering: same round, ball already landed, the answer is still there -----
    if (!S.reloadAnswering && round === 2) {
      S.reloadAnswering = true;
      const t0 = Date.now();
      await B.reload();
      await B.locator('[data-testid="screen-room-player"][data-view="answering"]').waitFor({ timeout: 20000 });
      await B.locator('[data-testid="disco-stage"][data-state="landed"]').waitFor({ state: 'attached', timeout: 4000 });
      await B.locator('[data-testid="disco-moment"][data-moment="submitted"]').waitFor({ timeout: 4000 });
      assert(Date.now() - t0 < 6000 && await B.getByTestId('disco-answer-state').isVisible(), 'reload while answering: no new spin, no splash: straight back to "antwoord binnen"');
      await B.getByTestId('disco-edit').click();
      assert(await B.getByTestId('disco-answer').isVisible() && await momentOf(B) === 'question', 'reload while answering: "Wijzig" brings the answer form back');
      // the form comes back filled in with what was sent: send the same again (or "Weet ik niet" again)
      await B.getByTestId(bHow === 'pass' ? 'disco-pass' : 'disco-lock').click();
      await B.locator('[data-testid="disco-moment"][data-moment="submitted"]').waitFor();
      const st = await attr(B, 'disco-answer-state', 'data-state');
      assert(st === (bHow === 'pass' ? 'pass' : 'locked'), `reload while answering: the answer is still there (${st})`);
      assert((await pview(B)).game.round === round, 'reload while answering: same round');
      await shot(B, 'disco-08-player360-reload-answering');
    }

    // ----- no peeking: nothing of the song, nothing of the others' typed text, before the reveal -----
    const cut = new Map(phones().map((p) => [p, p.frames.length]));
    for (const p of phones()) {
      const other = [aText, bText].filter((t) => t && !/^\d+$/.test(t) && !(p === anouk && t === aText) && !(p === bram && t === bText));
      assertNoPeek(p, from.get(p) ?? 0, cut.get(p), [song.title, song.artist, ...other], `${p === anouk ? 'Anouk' : p === bram ? 'Bram' : 'Cas'} (round ${round})`);
    }
    assert(true, `round ${round}: before the reveal no frame holds the song's title/artist or another player's typed text`);

    // ----- reveal -----
    await H.getByTestId('room-reveal').click();
    await Promise.all([H.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor(), ...phones().map((p) => p.page.locator('[data-testid="screen-room-player"][data-view="revealed"]').waitFor())]);
    await A.getByTestId('disco-verdict').waitFor();
    if (typed) {
      const results = await inSheet(A, 'disco-menu-answers', () => A.getByTestId('disco-results').textContent());
      assert(results.includes(bText) && results.includes(aText), `round ${round}: after the reveal everybody sees what everybody typed (menu: Wat iedereen antwoordde)`);
    }
    const aV = await attr(A, 'disco-verdict', 'data-verdict');
    assert(aV === 'right', `round ${round}: Anouk's ${aHow} answer ${aText ?? ''} is right (${aV})`);
    if (aHow === 'typo') {
      const sv = await hspec(H);
      const r = sv.game.reveal.results.find((x) => x.name === 'Anouk');
      assert(r.verdict === 'right' && !r.decided && !r.overridden, `a small typo ("${aText}") is judged right automatically, without the spelleider`);
    }
    if (round === 1) { await shot(A, 'disco-09-player-revealed'); await shot(H, 'disco-10-host-revealed'); }
    if (cat === 'exact' && !S.exactShot) {
      // the exact year: Anouk's exact year is right, Bram one year off is wrong (the machine decides)
      S.exactShot = true;
      const rs = (await hspec(H)).game.reveal.results;
      const ra = rs.find((x) => x.name === 'Anouk');
      assert(ra.verdict === 'right' && ra.auto === 'right' && ra.cat === 'exact', 'Exact jaar: the exact year is right, decided by the machine');
      if (bHow === 'wrong') assert(rs.find((x) => x.name === 'Bram').auto === 'wrong', 'Exact jaar: one year off is wrong (no margin, never a doubt)');
      await verdictOnPhone(B, bHow === 'wrong' ? 'wrong' : 'pass');
      await shot(B, 'disco-07b-player360-exact-verdict');
    }

    // ----- Bram: wrong, pass, or a doubt -----
    if (bHow === 'wrong') await verdictOnPhone(B, 'wrong');
    if (bHow === 'pass') await verdictOnPhone(B, 'pass');
    if (bHow === 'doubt') {
      const good = !S.goodDoubt;
      await verdictOnPhone(B, 'doubt');
      assert(/De spelleider kijkt naar je antwoord/.test(await B.getByTestId('disco-verdict').textContent()), `round ${round}: Bram's near miss "${bText}" shows the waiting state "de spelleider kijkt naar je antwoord"`);
      assert(await B.getByTestId('disco-choose').count() === 0 && (await pview(B)).game.disco.waitingForHost === true, 'no stamp to choose while the spelleider is still deciding');
      const rowB = await rowOf(H, 'Bram');
      assert(await attr(H, 'disco-regie', 'data-doubts') === '1' && await H.getByTestId(`disco-judge-good-${rowB}`).isVisible() && await H.getByTestId(`disco-judge-bad-${rowB}`).isVisible(), 'the regie has the doubt on top with Goed / Fout');
      const next = H.getByTestId('room-next');
      assert(await next.getAttribute('data-state') === 'doubts' && /Beslis eerst \(1\)/.test(await next.textContent()), 'the main button reads "Beslis eerst (1)"');
      if (good) await shot(H, 'disco-11-host-regie-doubt');
      const before = (await hroom(H)).game.round;
      await next.click();
      await sleep(700);
      const after = await hroom(H);
      assert(after.phase === 'revealed' && after.game.round === before && await H.getByTestId('room-next').getAttribute('data-state') === 'doubts', 'tapping it does not move on: the spelleider must decide first');
      const seenOnA = await inSheet(A, 'disco-menu-answers', async () => (await attr(A, 'disco-results', 'data-testid')) === 'disco-results' && await A.locator('[data-testid^="disco-result-"][data-name="Bram"]').getAttribute('data-verdict'));
      assert(seenOnA === 'doubt', 'the other phones see "twijfel" for Bram');
      await H.getByTestId(good ? `disco-judge-good-${rowB}` : `disco-judge-bad-${rowB}`).click();
      await verdictOnPhone(B, good ? 'right' : 'wrong');
      assert(/spelleider/.test(await B.getByTestId('disco-verdict-explain').textContent()), `Bram is told the spelleider ruled it ${good ? 'right' : 'wrong'}`);
      await H.waitForFunction(() => document.querySelector('[data-testid="room-next"]')?.dataset.state !== 'doubts');
      assert(true, `${good ? 'Goed' : 'Fout'}: the doubt is gone from the button`);
      if (good) {
        S.goodDoubt = true;
        assert(await attr(B, 'disco-choose', 'data-state') === 'choose', 'Goed: Bram may choose a square');
        await H.locator('[data-testid="disco-chip-row"][data-name="Bram"][data-state="choosing"]').waitFor({ timeout: 5000 });
        assert(/kiezen nog|kiest nog/.test(await H.getByTestId('disco-chips-summary').textContent()), 'the spelleider sees that Bram (and Anouk) still have to choose: "… kiezen nog"');
        await shot(B, 'disco-12-player360-doubt-right');
      } else {
        S.badDoubt = true;
        assert(await B.getByTestId('disco-choose').count() === 0 && (await pview(B)).game.disco.choice == null && (await pview(B)).game.disco.choosable.length === 0, 'Fout: nothing to choose, no stamp for Bram');
      }
    }

    // ----- a flip that grants: Bram's wrong exact year becomes right -----
    if (cat === 'exact' && bHow === 'wrong') {
      const rowB = await rowOf(H, 'Bram');
      await H.getByTestId(`disco-flip-${rowB}`).click();
      await verdictOnPhone(B, 'right');
      assert(await attr(B, 'disco-choose', 'data-state') === 'choose', 'a flip to right: Bram may choose a square');
      const placed = await stamp(B);
      assert(placed != null && await sq(B, placed).getAttribute('data-stamped') === 'true', `Bram chooses square ${placed} and it is stamped`);
      S.flipGrant = true;
    }

    // ----- Anouk chooses: first another square, then moves it -----
    const dv = (await pview(A)).game.disco;
    if (dv.choosable.length) {
      if (!S.moved && dv.choosable.length > 1) {
        const first = await stamp(A, { move: true });
        assert(await sq(A, first).getAttribute('data-stamped') === 'true' && await sq(A, first).getAttribute('data-chosen') === 'true', `Anouk stamps square ${first}`);
        const stampedBefore = (await pview(A)).game.mine.stamped;
        await shot(A, 'disco-13-player-stamped');
        const second = await stamp(A);
        assert(first !== second && await sq(A, first).getAttribute('data-stamped') === 'false' && await sq(A, second).getAttribute('data-stamped') === 'true' && (await pview(A)).game.mine.stamped === stampedBefore, `the stamp moves from ${first} to ${second}: one stamp, not two`);
        S.moved = true;
      } else await stamp(A);
    }

    // ----- a flip that takes a stamp away (and back): Anouk's year -----
    if (cat === 'year' && !S.flipOff) {
      const rowA = await rowOf(H, 'Anouk');
      const v0 = await pview(A);
      const idx = v0.game.disco.choice;
      const stamped0 = v0.game.mine.stamped;
      await H.getByTestId(`disco-flip-${rowA}`).click();
      await verdictOnPhone(A, 'wrong');
      const v1 = await pview(A);
      assert(v1.game.mine.stamped === stamped0 - 1 && v1.game.disco.choice == null && await sq(A, idx).getAttribute('data-stamped') === 'false', 'a flip to fout takes this round\'s stamp off Anouk\'s card');
      assert(await A.getByTestId('disco-choose').count() === 0, 'and she can not choose a square any more');
      await shot(A, 'disco-14-player-flipped-wrong');
      await H.getByTestId(`disco-flip-${rowA}`).click();
      await verdictOnPhone(A, 'right');
      assert(await attr(A, 'disco-choose', 'data-state') === 'choose', 'flipped back to goed: she chooses again');
      await stamp(A);
      assert((await pview(A)).game.mine.stamped === stamped0, 'and the stamp is back');
      S.flipOff = true;
    }

    // ----- reload after the reveal: the verdict and the chosen square are still there -----
    if (!S.reloadRevealed && round >= 2 && (await pview(A)).game.disco.choice != null) {
      S.reloadRevealed = true;
      const before = await pview(A);
      await A.reload();
      await A.locator('[data-testid="screen-room-player"][data-view="revealed"]').waitFor({ timeout: 20000 });
      await A.getByTestId('disco-verdict').waitFor();
      const after = await pview(A);
      assert(after.game.disco.choice === before.game.disco.choice && after.game.mine.stamped === before.game.mine.stamped && await sq(A, after.game.disco.choice).getAttribute('data-chosen') === 'true', 'reload after the reveal: verdict and chosen square are still there');
      assert(await attr(A, 'disco-verdict', 'data-verdict') === 'right', 'reload after the reveal: still "goed"');
      await shot(A, 'disco-15-player-reload-revealed');
    }

    // ----- somebody joins halfway, between two rounds -----
    if (round === 2) {
      const [va, vb] = [await pview(A), await pview(B)];
      cas = await discoPhone(browser, rooms, { viewport: { width: 360, height: 740 } });
      C = cas.page;
      pages.push(C);
      await C.goto(`${server.url}#/kamer/${code}`);
      await C.getByTestId('join-name').fill('Cas');
      await C.getByTestId('join-submit').click();
      await C.locator('[data-testid="screen-room-player"][data-view="revealed"]').waitFor({ timeout: 20000 });
      await waitForPlayers(H, 3);
      const vc = await pview(C);
      const behind = Math.min(va.game.mine.stamped, vb.game.mine.stamped);
      const perLine = Math.max(...LINES.map((l) => l.filter((i) => vc.game.mine.marks[i] != null).length));
      assert(vc.game.mine.stamped === behind && perLine <= 3, `late joiner Cas: a fresh card with ${vc.game.mine.stamped} free stamps (the one furthest behind has ${behind}), at most 3 in a line`);
      assert(CATEGORY_KEYS.every((k) => vc.game.mine.card.filter((x) => x === k).length === 6) && vc.game.mine.card.join() !== va.game.mine.card.join(), 'his own card: 6 of each category, different from Anouk\'s');
      await shot(C, 'disco-16-player360-late-joiner');
      from = mark(); // Cas has no frames of the rounds before
    }

    // ----- the spelleider moves on; right answers without a chosen square are placed automatically -----
    const vb0 = await pview(B);
    const bAuto = vb0.game.reveal.mine.correct && vb0.game.disco.choice == null && !vb0.game.disco.noSquare && !vb0.game.disco.waitingForHost;
    const marks0 = vb0.game.mine.marks.slice();
    const wantAuto = bAuto ? bestSquare(vb0.game.mine.card, marks0, vb0.game.disco.cat, vb0.game.disco.win) : null;
    if (round === 1) await shot(H, 'disco-17-host-revealed-regie');
    const stop = (await hspec(H)).game.disco.bingo;
    if (stop) {
      // a bingo stops the game at once: the leader decides. Not every scenario has been played
      // yet: go on for the next goal; otherwise stop, to the prizes
      const names = stop.winners.map((w) => w.name);
      assert(await H.getByTestId('room-next').count() === 0, `round ${round}: a bingo: no "Draai de discobal" any more`);
      await H.getByTestId('disco-bingo-stop').waitFor();
      const said = await H.getByTestId('disco-bingo-names').textContent();
      assert(names.every((n) => said.includes(n)) && said.includes(stop.win === 'line1' ? '1 lijn' : '2 lijnen'), `the leader sees "${said.trim()}"`);
      for (const w of names) {
        const pg = w === 'Anouk' ? A : w === 'Bram' ? B : C;
        await pg.locator('[data-testid="disco-moment"][data-moment="bingo"]').waitFor({ timeout: 5000 });
      }
      assert(true, `the phone of ${names.join(' & ')} shows BINGO! as soon as the square completes the goal`);
      assert(await H.locator(`[data-testid^="disco-progress-"][data-name="${names[0]}"]`).first().getAttribute('data-bingo') === 'true', 'the host\'s progress list marks the winner with BINGO');
      for (const w of stop.next) assert(await H.getByTestId(`disco-go-${w}`).isVisible(), `the leader may go on for ${w}`);
      if (!S.stopShot) { S.stopShot = true; await shot(names[0] === 'Anouk' ? A : B, 'disco-18-player-bingo'); await shot(H, 'disco-19-host-bingo'); }
      from = mark();
      const done = S.typo && S.near && S.goodDoubt && S.badDoubt && S.flipOff && S.flipGrant && S.moved && S.reloadAnswering && S.reloadRevealed && S.fadeOut && S.dialog && S.exactShot;
      if (!done && stop.next.length) {
        S.wentOn = (S.wentOn || 0) + 1;
        await goOn(H, `disco-go-${stop.next[0]}`);
        await H.waitForFunction(([r, w]) => { const sx = window.__ttHost.session; const b2 = sx.spectatorView()?.game?.disco?.bingo; return sx.room.game.round > r || (b2 && b2.win !== w); }, [round, stop.win], { timeout: 15000 });
        assert((await hroom(H)).phase !== 'won', 'going on: the game goes on with the higher goal');
        if ((await hspec(H)).game.disco.bingo) { await goOn(H, 'disco-finish'); await H.waitForFunction(() => window.__ttHost.session.room.phase === 'won', null, { timeout: 15000 }); }
      } else {
        await goOn(H, 'disco-finish');
        await H.waitForFunction(() => window.__ttHost.session.room.phase === 'won', null, { timeout: 15000 });
      }
    } else {
      const nextBtn = H.getByTestId('room-next');
      const state = await nextBtn.getAttribute('data-state');
      const label = (await nextBtn.textContent()).trim();
      assert(state === 'spin' && /Draai de discobal/.test(label), `round ${round}: the button reads "Draai de discobal" (${label})`);
      from = mark();
      const oldCard = await H.evaluate(() => document.getElementById('player')?.dataset.card);
      // Bram still has to choose: the dialog first (once "Wacht nog", then "Toch doorgaan")
      if (bAuto && !S.dialog) {
        S.dialog = true;
        assert(await goOn(H, 'room-next', { wait: true, shotName: 'disco-17b-host-dialog' }) === false, '"Wacht nog": nothing happens');
        assert((await hroom(H)).phase === 'revealed' && (await hroom(H)).game.round === round, '"Wacht nog": still this round');
      }
      await goOn(H);
      if (!S.fadeOut && oldCard) {
        // the song of the round fades out before the next one starts (no hard cut)
        await H.waitForFunction((c) => { const p = document.getElementById('player'); return p.dataset.card === c && !p.paused && p.volume < 0.9 && p.volume > 0; }, oldCard, { timeout: 4000 });
        S.fadeOut = true;
        assert(true, 'going on: the round\'s song fades out before the next one');
      }
      await H.waitForFunction((r) => { const s = window.__ttHost.session; return s.room.phase === 'won' || s.room.game.round > r; }, round, { timeout: 15000 });
    }
    if (bAuto) {
      const vb1 = await pview(B);
      const now = vb1.game.mine.marks;
      const added = now.map((m, i) => (m != null && marks0[i] == null ? i : -1)).filter((i) => i >= 0);
      assert(added.length === 1 && added[0] === wantAuto, `moving on placed Bram's right answer on the best square (${wantAuto}) by itself`);
      S.auto++;
    }
    if ((await hroom(H)).phase === 'won') break;
  }
  assert(S.auto >= 1, 'at least one automatic placement was checked');
  assert(S.typo && S.near && S.goodDoubt && S.badDoubt && S.flipOff && S.flipGrant && S.moved && S.reloadAnswering && S.reloadRevealed && S.fadeOut && S.dialog && S.exactShot, `every scenario happened (${JSON.stringify(S)})`);
  assert(['exact', 'artist', 'year', 'title'].every((k) => kinds.has(k)), `the four kinds of answer were played (${cats.join(', ')})`);
  assert(cats.every((c, i) => i === 0 || c !== cats[i - 1]), `never the same category twice in a row (${cats.join(', ')})`);
  assert(CATEGORY_KEYS.every((k) => cats.slice(0, 4).includes(k)), 'the first four rounds hold every category once');

  // ----- the ball and the music: what the watchers saw over the whole game -----
  for (const [pg, who, isHost] of [[H, 'host', true], [A, 'Anouk', false], [B, 'Bram', false]]) {
    const w = await watched(pg);
    assert(w.badForm === 0, `${who}: the answer form never showed before the ball landed`);
    if (isHost) {
      // the fade-in: the music plays during the spin, its volume rises, and it is full after landing
      const rising = Object.values(w.spins).filter((s) => s.length >= 4 && s[s.length - 1] > s[0] + 0.2 && s[0] < 0.5);
      assert(w.audioInSpin > 0 && rising.length >= 1 && w.loudAfterLand > 0, `host: music during the spin with a rising volume (${JSON.stringify(Object.values(w.spins).slice(0, 2).map((s) => [s[0], s[s.length - 1], s.length]))}), full volume after landing (${w.loudAfterLand})`);
    } else assert(await pg.evaluate(() => !document.getElementById('player')?.dataset?.card), `${who}: a phone never loads a song`);
    assert(w.sawSpin > 0 && w.spinNoForm > 0, `${who}: saw the ball spinning (${w.sawSpin} samples) without a form`);
  }

  // ----- the result -----
  await H.locator('[data-testid="screen-room-host"][data-view="won"]').waitFor();
  for (const p of phones()) await p.page.locator('[data-testid="screen-room-player"][data-view="won"]').waitFor();
  const winners = (await hspec(H)).game.winners;
  assert(winners.includes('Anouk'), `Anouk wins after ${last} rounds (${winners.join(' & ')}; went on ${S.wentOn || 0}×)`);
  assert(/Anouk/.test(await H.getByTestId('room-winner-name').textContent()) && /Anouk/.test(await A.getByTestId('room-winner-name').textContent()) && /Anouk/.test(await B.getByTestId('room-winner-name').textContent()), 'the winner is shown on the host and on every phone');
  assert(await A.getByTestId('room-you-won').isVisible(), 'Anouk is congratulated');
  const lines = (await pview(A)).game.mine.lines;
  assert(lines >= 1 && completeLines((await pview(A)).game.mine.marks).length >= 1, `Anouk has ${lines} full line(s)`);
  const stages = (await hspec(H)).game.disco.stages;
  assert(stages.length === 1 + (S.wentOn || 0) && stages[0].win === 'line1', `the stages of the game: ${stages.map((x) => `${x.win}: ${x.names.join(' & ')}`).join(' · ')}`);
  await shot(H, 'disco-20-host-won');
  await shot(A, 'disco-21-player-won');

  // ----- no frame ever held leader data or playback fields -----
  for (const p of phones()) {
    const all = p.frames.join('\n');
    assert(!all.includes('"lead":') && !all.includes('previewUrl') && !all.includes('itunesId'), 'a phone never got the leader\'s data or playback fields');
  }

  // ----- Nog een potje: a fresh round 1, fresh cards -----
  await H.getByTestId('room-again').click();
  await waitRound(A, 1);
  await landed(A);
  const fresh = await pview(A);
  assert(fresh.game.round === 1 && fresh.game.mine.stamped === 0, `"Nog een potje": round 1, an empty card (round ${fresh.game.round}, ${fresh.game.mine.stamped} stamped)`);
  assert(pages.every((p) => !p.errors.length), `no page errors (${pages.flatMap((p) => p.errors).join('; ')})`);
  await Promise.all([host, anouk, bram, ...(cas ? [cas] : [])].map((p) => p.context.close()));
  return cats;
}

// ======================================================================================
//  Game 2: the spelleider plays along on a phone-sized screen (a few rounds)
// ======================================================================================
async function hostPlaysGame(browser, rooms, server) {
  const host = await discoPhone(browser, rooms, { seed: 11 }, { tracks: TRACKS });
  const H = host.page;
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H, { hostPlays: true, name: 'Ilse' });
  const bram = await discoPhone(browser, rooms);
  const B = bram.page;
  await joinRoom(B, server.url, code, 'Bram', { via: 'link' });
  await waitForPlayers(H, 2);
  assert(await H.getByTestId('room-game-disco').isChecked(), 'the host who plays along also gets Discobingo by default');
  await autoOff(H);
  await H.getByTestId('room-start').click();
  let stamps = 0;
  for (let round = 1; round <= 3; round++) {
    await waitRound(B, round);
    await H.waitForFunction((r) => { const v = window.__ttHost.session.hostView(); return v?.phase === 'answering' && v.game.round === r; }, round, { timeout: 30000 });
    await H.locator('[data-testid="host-own"] [data-testid="disco-answer"]').waitFor({ timeout: 15000 });
    const own = '[data-testid="host-own"] ';
    const cat = (await hown(H)).game.disco.cat;
    assert(await H.locator(`${own}[data-testid="disco-answer"]`).getAttribute('data-cat') === cat, `round ${round}: Ilse's own form is for ${cat}`);
    assert(await noScroll(H), `round ${round}: no horizontal scroll on the spelleider's phone while answering`);
    const { song } = await serverHost(H);
    await answer(H, own, cat, song, round === 2 ? 'wrong' : 'right', round);
    await answer(B, '', cat, song, 'pass', round);
    if (round === 1) await shot(H, 'disco-22-host-plays-answering');
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor();
    await H.getByTestId('room-reveal').click();
    await H.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
    await H.locator('[data-testid="host-own"] [data-testid="disco-verdict"]').waitFor();
    assert(await H.getByTestId('disco-regie').isVisible() && await noScroll(H), `round ${round}: the regie and the own result fit a phone`);
    if (round !== 2) {
      assert(await attr(H, 'disco-verdict', 'data-verdict') === 'right' && await attr(H, 'disco-choose', 'data-state') === 'choose', 'Ilse is right and may choose a square');
      await stamp(H, { host: true });
      stamps++;
      assert((await hown(H)).game.mine.stamped === stamps, `Ilse's card on the phone-sized screen: ${stamps} stamped`);
      if (round === 1) await shot(H, 'disco-23-host-plays-revealed');
    } else {
      assert(await attr(H, 'disco-verdict', 'data-verdict') === 'wrong', 'a wrong answer of the spelleider is wrong');
      // the spelleider judges her own answer too: flip it
      const rowI = await rowOf(H, 'Ilse');
      await H.getByTestId(`disco-flip-${rowI}`).click();
      await H.locator('[data-testid="host-own"] [data-testid="disco-verdict"][data-verdict="right"]').waitFor();
      await stamp(H, { host: true });
      stamps++;
      assert((await hown(H)).game.mine.stamped === stamps, 'the spelleider can overrule her own answer and stamp');
    }
    await H.getByTestId('room-next').click();
  }
  assert(host.page.errors.length === 0 && B.errors.length === 0, 'no page errors');
  await host.context.close();
  await bram.context.close();
}

// ======================================================================================
//  Game 3: "2 lijnen" to the end through the fast path
// ======================================================================================
async function twoLines(browser, rooms, server, firstCats) {
  const host = await discoPhone(browser, rooms, { seed: 7, ...HOST_TV }, { tracks: TRACKS });
  const H = host.page;
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const p = await discoPhone(browser, rooms);
  const P = p.page;
  await joinRoom(P, server.url, code, 'Anouk', { via: 'link' });
  await waitForPlayers(H, 1);
  await autoOff(H);
  await H.getByTestId('room-disco-win-line2').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await H.getByTestId('room-disco-win-line2').check();
  await P.waitForFunction(() => window.__ttRoom.session.view?.settings.win === 'line2');
  assert(/2 lijnen/.test(await P.getByTestId('room-wait').textContent()), 'the player sees "eerste bingo bij 2 lijnen" in the lobby');
  await H.getByTestId('room-start').click();
  const cats = [];
  let lastLines = 0;
  for (let round = 1; round <= 30; round++) {
    await waitRound(P, round);
    const v = await pview(P);
    const cat = v.game.disco.cat;
    cats.push(cat);
    if (v.game.disco.win !== 'line2') throw new Error('ASSERT: the goal of the game is not 2 lijnen');
    if (round === 1) assert(true, 'the goal of the game is 2 lijnen');
    // the phone can hear of the new round before the spelleider's screen does: read this round's song, not the last one
    await H.waitForFunction((r) => window.__ttHost?.session?.room?.game?.round === r && !!window.__ttHost.session.currentSong(), round);
    const { song } = await serverHost(H);
    const ans = cat === 'exact' || cat === 'year' ? { guess: String(song.year) } : { text: cat === 'artist' ? song.artist : song.title };
    // fast path: no waiting for the ball, the answer goes through the phone's own session
    await P.evaluate((a) => window.__ttRoom.session.answer(a), ans);
    await P.waitForFunction(() => window.__ttRoom.session.view.game.answer != null);
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });
    await H.getByTestId('room-reveal').click();
    await P.waitForFunction(() => window.__ttRoom.session.view.phase === 'revealed');
    const r = await pview(P);
    assert(r.game.reveal.mine.verdict === 'right' && r.game.disco.choosable.length > 0, `fast round ${round} (${cat}): right, a square to choose`);
    const best = bestSquare(r.game.mine.card, r.game.mine.marks, cat, 'line2');
    await P.evaluate((i) => window.__ttRoom.session.stamp(i), best);
    await P.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, best);
    const after = await pview(P);
    if (after.game.mine.lines >= 2) {
      await H.getByTestId('disco-bingo-choices').waitFor();
      assert(await H.getByTestId('disco-go-full').isVisible() && await H.getByTestId('disco-go-line2').count() === 0 && await H.getByTestId('room-next').count() === 0, `round ${round}: two full lines: a bingo stop that offers a full card or stop (no 2 lijnen again)`);
      assert(after.game.mine.bingo === true && after.game.mine.winLine != null, 'the second line makes BINGO');
      await H.getByTestId('disco-finish').click();
      break;
    }
    lastLines = after.game.mine.lines;
    assert(after.game.mine.bingo === false && await H.getByTestId('room-next').getAttribute('data-state') === 'spin', `round ${round}: ${after.game.mine.lines} line(s) is not enough for 2 lijnen, the game goes on`);
    await H.getByTestId('room-next').click();
  }
  await H.locator('[data-testid="screen-room-host"][data-view="won"]').waitFor({ timeout: 15000 });
  await P.locator('[data-testid="screen-room-player"][data-view="won"]').waitFor({ timeout: 15000 });
  const fin = await pview(P);
  assert(cats.length >= 8 && fin.game.mine.lines >= 2 && /Anouk/.test(await P.getByTestId('room-winner-name').textContent()), `2 lijnen played to the end: won after ${cats.length} rounds with ${fin.game.mine.lines} lines`);
  assert(/2 lijnen/.test(await P.getByTestId('room-winner-name').locator('xpath=..').textContent()), 'the winner block says why: 2 lijnen vol');

  // ----- balance: the first 8 rounds hold every category exactly twice, never the same one twice in a row -----
  const first8 = cats.slice(0, 8);
  assert(CATEGORY_KEYS.every((k) => first8.filter((c) => c === k).length === 2), `the first 8 rounds: every category exactly twice (${first8.join(', ')})`);
  assert(cats.every((c, i) => i === 0 || c !== cats[i - 1]), `never the same category twice in a row (${cats.join(', ')})`);
  const n = Math.min(firstCats.length, cats.length);
  assert(firstCats.slice(0, n).join() === cats.slice(0, n).join(), `same seed, same categories: ${cats.slice(0, n).join(', ')}`);
  assert(host.page.errors.length === 0 && P.errors.length === 0, 'no page errors');
  await host.context.close();
  await p.context.close();
}

// ======================================================================================
//  Game 5: the bingo stages with a tv, the automatic reveal, chips and the dialog
// ======================================================================================
async function bingoStages(browser, rooms, server) {
  const host = await discoPhone(browser, rooms, { seed: 7, ...HOST_TV, viewport: { width: 1280, height: 800 } }, { tracks: TRACKS60 });
  const H = host.page;
  // short fragments (9 s, the fake audio can not seek): the fade at the end comes within a round
  await host.context.route('https://audio-ssl.itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav(9) }));
  await H.goto(`${server.url}#/spelleider`);
  const code = await createRoom(H);
  const tv = await discoPhone(browser, rooms, { ...HOST_TV });
  const D = tv.page;
  await D.goto(`${server.url}#/scherm/${code}`);
  const anouk = await discoPhone(browser, rooms, { viewport: { width: 360, height: 740 } });
  const bram = await discoPhone(browser, rooms, { viewport: { width: 360, height: 740 } });
  const A = anouk.page;
  const B = bram.page;
  await joinRoom(A, server.url, code, 'Anouk', { via: 'link' });
  await joinRoom(B, server.url, code, 'Bram', { via: 'link' });
  await waitForPlayers(H, 2);
  assert(await H.getByTestId('room-disco-auto').isChecked() && (await hroom(H)).settings.autoReveal === true, 'the automatic reveal is on by default');
  await H.getByTestId('room-start').click();
  const dview = (pg) => pg.evaluate(() => window.__ttScreen?.session?.view || null);
  const songOf = async (round) => {
    await H.waitForFunction((r) => window.__ttHost?.session?.room?.game?.round === r && !!window.__ttHost.session.currentSong(), round, { timeout: 30000 });
    return (await serverHost(H)).song;
  };
  const rightFor = (cat, song) => (cat === 'exact' || cat === 'year' ? { guess: String(song.year) } : { text: cat === 'artist' ? song.artist : song.title });
  const fastAnswer = async (P, round, ans) => {
    await P.waitForFunction((r) => window.__ttRoom?.session?.view?.game?.round === r && window.__ttRoom.session.view.phase === 'answering', round, { timeout: 30000 });
    await P.evaluate((a) => window.__ttRoom.session.answer(a), ans);
    await P.waitForFunction(() => window.__ttRoom.session.view.game.answer != null);
  };
  /** Anouk lays her chip on the best square (with a joker on another colour when hers is full). */
  const stampBest = async () => {
    const v = await pview(A);
    const d = v.game.disco;
    let at = null;
    let joker = false;
    if (d.choosable.length) at = bestSquare(v.game.mine.card, v.game.mine.marks, d.cat, d.win);
    else if ((d.jokerSquares || []).length) {
      // the joker square that helps most: the best square of its own colour
      const js = d.jokerSquares;
      at = js.map((i) => bestSquare(v.game.mine.card, v.game.mine.marks, v.game.mine.card[i], d.win)).find((i) => js.includes(i)) ?? js[0];
      joker = true;
    }
    if (at == null) return null;
    await A.evaluate(([i, j]) => window.__ttRoom.session.stamp(i, j ? { joker: true } : undefined), [at, joker]);
    await A.waitForFunction((i) => window.__ttRoom.session.view.game.disco.choice === i, at);
    return at;
  };

  // ----- round 1: everybody answers -> the shared countdown -> the reveal by itself -----
  await Promise.all([waitRound(H, 1, true), waitRound(A, 1), waitRound(B, 1)]);
  await Promise.all([landed(H), landed(A), landed(B)]);
  let song = await songOf(1);
  let cat = (await pview(A)).game.disco.cat;
  await answer(A, '', cat, song, 'right', 1);
  assert(await H.getByTestId('disco-auto').count() === 0, 'one of two answered: no countdown yet');
  await answer(B, '', cat, song, 'right', 1);
  await H.getByTestId('disco-auto').waitFor({ timeout: 5000 });
  const t0 = Date.now();
  await D.getByTestId('screen-auto').waitFor({ timeout: 5000 });
  await A.getByTestId('disco-auto').waitFor({ timeout: 5000 });
  const ats = [(await hspec(H)).game.disco.autoAt, (await pview(A)).game.disco.autoAt, (await pview(B)).game.disco.autoAt, (await dview(D)).game.disco.autoAt];
  assert(ats.every((x) => Number.isFinite(x) && x === ats[0]), `one shared moment on the server clock for leader, phones and tv (${ats.join(', ')})`);
  assert(/Resultaat over/.test(await H.getByTestId('disco-auto').textContent()) && await H.getByTestId('disco-hold').isVisible(), 'the leader: "Resultaat over …" and "Wacht nog"');
  await shot(H, 'disco-30-host-countdown');
  await shot(D, 'disco-31-tv-countdown');
  await shot(A, 'disco-32-player360-countdown');
  await Promise.all([H, A, B, D].map((pg) => pg.waitForFunction(() => {
    const v = window.__ttHost?.session?.spectatorView() || window.__ttRoom?.session?.view || window.__ttScreen?.session?.view;
    return v?.phase === 'revealed';
  }, null, { timeout: 10000 })));
  const waited = Date.now() - t0;
  assert(waited >= 2500 && waited < 8000, `nobody tapped Onthul: revealed by itself after the countdown (${waited} ms)`);

  // ----- chips: who has laid one; the dialog before going on -----
  await A.locator('[data-testid="disco-moment"][data-moment="choose"]').waitFor({ timeout: 8000 });
  assert(/Kies zelf een/.test(await A.getByTestId('disco-choose').textContent()), 'the phone asks plainly: "Kies zelf een … vakje"');
  await stamp(A);
  assert(/Fiche gelegd/.test(await A.getByTestId('disco-choose').textContent()), 'the phone confirms: "Fiche gelegd!"');
  const sum = H.getByTestId('disco-chips-summary');
  await H.locator('[data-testid="disco-chips-summary"][data-waiting="1"]').waitFor();
  assert(/1 van 2 kiest nog/.test(await sum.textContent()), `the leader: "1 van 2 kiest nog" (${(await sum.textContent()).trim()})`);
  assert(await H.locator('[data-testid="disco-chip-row"][data-name="Anouk"]').getAttribute('data-state') === 'placed' && await H.locator('[data-testid="disco-chip-row"][data-name="Bram"]').getAttribute('data-state') === 'choosing', 'the leader sees Anouk "fiche gelegd ✓" and Bram "kiest nog…"');
  await D.locator('[data-testid="screen-chips-summary"][data-waiting="1"]').waitFor();
  assert(/Bram/.test(await D.getByTestId('screen-pending').textContent()), 'the tv says the same: Bram still chooses');
  await shot(H, 'disco-33-host-chips');
  await shot(D, 'disco-34-tv-chips');
  assert(await goOn(H, 'room-next', { wait: true, shotName: 'disco-35-host-dialog' }) === false, '"Wacht nog" keeps the round');
  await stamp(B);
  await H.locator('[data-testid="disco-chips-summary"].is-all').waitFor();
  assert(/Iedereen heeft een fiche gelegd/.test(await sum.textContent()), 'the summary turns green: "Iedereen heeft een fiche gelegd"');
  await D.locator('[data-testid="screen-chips-summary"].is-all').waitFor();
  await shot(H, 'disco-36-host-chips-all');
  await goOn(H);

  // ----- round 2: "Wacht nog", and the fade at the end of the fragment -----
  await Promise.all([waitRound(H, 2, true), waitRound(A, 2)]);
  song = await songOf(2);
  cat = (await pview(A)).game.disco.cat;
  await fastAnswer(A, 2, rightFor(cat, song));
  await fastAnswer(B, 2, { pass: true });
  await H.getByTestId('disco-hold').waitFor({ timeout: 8000 });
  await H.getByTestId('disco-hold').click();
  await H.getByTestId('disco-auto-held').waitFor();
  await A.waitForFunction(() => window.__ttRoom.session.view.game.disco.autoAt === null && window.__ttRoom.session.view.game.disco.autoHeld === true);
  assert(await D.getByTestId('screen-auto').count() === 0, '"Wacht nog": the countdown is gone on the tv too');
  // the end of the (here 9-second) fragment fades out instead of a cut
  await H.waitForFunction(() => { const p = document.getElementById('player'); return !p.paused && p.volume > 0.97 && p.duration > 8; }, null, { timeout: 10000 });
  await H.waitForFunction(() => { const p = document.getElementById('player'); return !p.paused && p.volume < 0.85 && p.currentTime > p.duration - 1.5; }, null, { timeout: 10000 });
  await H.waitForFunction(() => { const p = document.getElementById('player'); return p.ended || p.paused; }, null, { timeout: 5000 });
  await H.waitForFunction(() => document.getElementById('player').volume === 1, null, { timeout: 3000 });
  assert(true, 'the end of the fragment fades out, and the volume is back to full for the next song');
  await sleep(5000); // longer than the countdown would have taken: "Wacht nog" really holds
  assert((await hroom(H)).phase === 'answering', '"Wacht nog": no automatic reveal in this round');
  await H.getByTestId('room-reveal').click();
  await H.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
  await stampBest();
  await goOn(H);

  // ----- round 3: Bram is right and then away: no dialog, his chip is placed automatically -----
  await Promise.all([waitRound(H, 3, true), waitRound(A, 3), waitRound(B, 3)]);
  song = await songOf(3);
  cat = (await pview(A)).game.disco.cat;
  await fastAnswer(A, 3, rightFor(cat, song));
  await fastAnswer(B, 3, rightFor(cat, song));
  await H.getByTestId('room-reveal').click();
  await H.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
  const bramBefore = (await hspec(H)).game.disco.progress.find((p) => p.name === 'Bram').stamped;
  await B.goto('about:blank');
  await H.locator('[data-testid="disco-chip-row"][data-name="Bram"][data-state="away"]').waitFor({ timeout: 10000 });
  await stampBest();
  await goOn(H); // asserts: no dialog for somebody who is away
  await waitRound(H, 4, true);
  assert((await hspec(H)).game.disco.progress.find((p) => p.name === 'Bram').stamped === bramBefore + 1, 'Bram was away: his chip was placed automatically when the leader went on');
  await B.goto(`${server.url}#/kamer/${code}`);
  await B.waitForFunction(() => !!window.__ttRoom?.session?.view?.game?.mine, null, { timeout: 20000 });

  // ----- on to a full card: every bingo stops the game; go on for 2 lijnen, then a full card, then stop -----
  const wins = [];
  let over = false;
  for (let round = 4; round <= 60 && !over; round++) {
    await waitRound(H, round, true);
    song = await songOf(round);
    cat = (await hspec(H)).game.disco.cat;
    await fastAnswer(A, round, rightFor(cat, song));
    await fastAnswer(B, round, { pass: true });
    await H.getByTestId('room-reveal').click();
    await A.waitForFunction(() => window.__ttRoom.session.view.phase === 'revealed', null, { timeout: 10000 });
    await stampBest();
    // the leader's screen has heard of the chip too (a bingo, or Anouk no longer choosing)
    await H.waitForFunction(() => { const d = window.__ttHost.session.spectatorView()?.game?.disco; return d && (d.bingo || (d.chips || []).every((c) => c.name !== 'Anouk' || c.state !== 'choosing')); }, null, { timeout: 10000 });
    for (;;) {
      const b = (await hspec(H)).game.disco.bingo;
      if (!b) { await goOn(H); break; }
      if (!wins.includes(b.win)) {
        wins.push(b.win);
        const n = wins.length;
        // at once on every screen
        await H.getByTestId('disco-bingo-stop').waitFor();
        await D.getByTestId('screen-bingo').waitFor({ timeout: 5000 });
        await A.locator('[data-testid="disco-moment"][data-moment="bingo"]').waitFor({ timeout: 5000 });
        await B.locator('[data-testid="disco-moment"][data-moment="stop"]').waitFor({ timeout: 5000 });
        const who = await D.getByTestId('screen-bingo-who').textContent();
        assert(/Anouk heeft/.test(who) && who.includes({ line1: '1 lijn', line2: '2 lijnen', full: 'volle kaart' }[b.win]), `bingo ${n} (${b.win}) on the tv: "${who.trim()}"`);
        const lit = await D.locator('[data-testid="screen-bingo-card-0"] [data-goal="true"]').count();
        assert(lit >= (b.win === 'full' ? 25 : b.win === 'line2' ? 9 : 5), `the tv lights the winning line(s) on Anouk's card (${lit} squares)`);
        assert(/Anouk/.test(await B.getByTestId('disco-stop-who').textContent()), 'Bram\'s phone switches to the BINGO of Anouk');
        assert(await H.getByTestId('room-next').count() === 0, 'no next song until the leader decides');
        const offered = { line2: await H.getByTestId('disco-go-line2').count(), full: await H.getByTestId('disco-go-full').count(), stop: await H.getByTestId('disco-finish').count() };
        const want = { line1: { line2: 1, full: 1, stop: 1 }, line2: { line2: 0, full: 1, stop: 1 }, full: { line2: 0, full: 0, stop: 1 } }[b.win];
        assert(JSON.stringify(offered) === JSON.stringify(want), `bingo on ${b.win}: the leader is offered ${JSON.stringify(offered)}`);
        await H.waitForFunction(() => document.getElementById('player').paused, null, { timeout: 5000 });
        assert(true, 'the music fades out and stops at the bingo');
        if (n === 1) {
          await shot(H, 'disco-40-host-bingo-stop');
          await shot(D, 'disco-41-tv-bingo');
          await shot(A, 'disco-42-player360-bingo');
          await shot(B, 'disco-43-player360-bingo-other');
        }
        if (b.win === 'full') await shot(D, 'disco-44-tv-bingo-full');
      }
      const choice = b.next.includes('line2') ? 'disco-go-line2' : b.next.includes('full') ? 'disco-go-full' : 'disco-finish';
      await goOn(H, choice);
      await H.waitForFunction(([r, w]) => {
        const s = window.__ttHost.session;
        const v = s.spectatorView();
        return s.room.phase === 'won' || s.room.game.round > r || (v?.game?.disco?.bingo && v.game.disco.bingo.win !== w);
      }, [round, b.win], { timeout: 15000 });
      if ((await hroom(H)).phase === 'won') { over = true; break; }
      if ((await hspec(H)).phase === 'answering') {
        const goal = (await hspec(H)).game.disco.win;
        assert(goal === { 'disco-go-line2': 'line2', 'disco-go-full': 'full' }[choice], `going on: the goal is now ${goal}`);
        await D.locator('[data-testid="screen-game"]', { hasText: goal === 'full' ? 'volle kaart' : '2 lijnen' }).waitFor({ timeout: 5000 });
        break;
      }
    }
  }
  assert(JSON.stringify(wins) === JSON.stringify(['line1', 'line2', 'full']), `three bingo stops: ${wins.join(', ')}`);
  // ----- the prize ceremony: winners per stage -----
  await D.getByTestId('screen-winner').waitFor({ timeout: 10000 });
  await H.locator('[data-testid="screen-room-host"][data-view="won"]').waitFor();
  const st = (await dview(D)).game.disco.stages;
  assert(JSON.stringify(st.map((s) => [s.win, s.names])) === JSON.stringify([['line1', ['Anouk']], ['line2', ['Anouk']], ['full', ['Anouk']]]), `the stages: ${JSON.stringify(st)}`);
  assert(/1 lijn/.test(await D.getByTestId('screen-stages').textContent()) && /Volle kaart/.test(await H.getByTestId('host-stages').textContent()), 'tv and leader list the winners per stage');
  await D.getByTestId('screen-ceremony').waitFor();
  await shot(D, 'disco-45-tv-won-stages');
  await shot(H, 'disco-46-host-won-stages');
  assert([H, D, A, B].every((p) => !p.errors.length), `no page errors (${[H, D, A, B].flatMap((p) => p.errors).join('; ')})`);
  await Promise.all([host, tv, anouk, bram].map((p) => p.context.close()));
}

export default async function run() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const browser = await launch();
  try {
    // DISCO_GAME=5 runs only the bingo stages (while working on them)
    if (process.env.DISCO_GAME !== '5') {
      await lobbyChecks(browser, rooms, server);
      const cats = await wholeGame(browser, rooms, server);
      await hostPlaysGame(browser, rooms, server);
      await twoLines(browser, rooms, server, cats);
    }
    await bingoStages(browser, rooms, server);
  } finally {
    await browser.close();
    server.stop();
    await rooms.stop();
  }

  // ---------- PeerJS route: Discobingo needs the server ----------
  const signal = await startSignal();
  const server2 = await startServer();
  const browser2 = await launch();
  try {
    const host = await phone(browser2, signal);
    await host.page.goto(`${server2.url}#/spelleider`);
    await createRoom(host.page);
    await host.page.getByTestId('room-disco-server-only').waitFor();
    assert(await host.page.getByTestId('room-game-disco').isDisabled(), 'PeerJS route: Discobingo can not be chosen');
    assert(/werken alleen via de kamerserver/.test(await host.page.getByTestId('room-quiz-server-only').textContent()), 'PeerJS route: the notice says "werken alleen via de kamerserver"');
    assert(!(await host.page.getByTestId('room-game-disco').isChecked()) && await host.page.getByTestId('room-game-bingo').isChecked(), 'PeerJS route: the room plays classic Bingo instead');
  } finally {
    await browser2.close();
    server2.stop();
    await signal.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
