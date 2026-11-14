// Stap 2: bedien de echte app in real time en neem het telefoonscherm op.
// - Chromium met nep-camera (de filmpjes uit 1-camera.mjs) en echte fragmenten (via de proxy).
// - Het scherm komt als verliesvrije PNG-frames binnen via de CDP-screencast (scherp, ~30 fps),
//   elk met een tijdstempel. Geluid wordt niet opgenomen.
// - events.json legt vast wanneer elke scène begon en waar/wanneer er getikt is; daarmee
//   tekent 3-render.mjs het decor (ondertitels, tafel, tik-indicator) er precies gelijk mee op.
import { copyFileSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, TMP, PUBLIC_URL, TABLE, DIGITAL, PHONE, FPS } from './config.mjs';
import { startServer, launch, ensureDir, sleep } from './lib.mjs';
import { camFile } from './1-camera.mjs';
import { SCENES } from './stage/scenes.js';
import { createGame, correctSlots, shuffle, seededRandom } from '../app/js/logic.js';

const deckCards = JSON.parse(readFileSync(join(ROOT, 'app/data/deck.json'), 'utf8')).cards
  .map((c) => ({ ...c, id: String(c.id), year: Number(c.year) }))
  .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const byId = new Map(deckCards.map((c) => [c.id, c]));
const playable = deckCards.filter((c) => Number.isFinite(c.year) && (c.previewUrl || c.itunesId));

/**
 * De digitale modus schudt met een seed uit Math.random(). We zoeken een seed waarbij de eerste
 * vier kaarten bekende nummers zijn met een duidelijk jaarverschil, zodat "goed" en "fout"
 * in één oogopslag te volgen zijn. De opname geeft die seed als eerste Math.random()-waarde.
 */
function findSeed() {
  const known = new Set(DIGITAL.known);
  for (let seed = 1; seed < 500000; seed++) {
    const g = createGame({ names: DIGITAL.names, goal: 10, cards: playable.map((c) => ({ id: c.id, year: c.year })), seed });
    const ids = [g.players[0].timeline[0], g.players[1].timeline[0], g.pile[0], g.pile[1]];
    if (!ids.every((id) => known.has(id))) continue;
    const [s0, d0, s1, d1] = ids.map((id) => byId.get(id).year);
    if (s1 - s0 < 8 || d0 - d1 < 8) continue; // Sanne: later nummer (legt het erna), Daan: ouder nummer (legt het er ten onrechte na)
    return { seed, ids };
  }
  throw new Error('Geen geschikte seed gevonden; pas DIGITAL.known aan.');
}

/** Spelstand "Sanne heeft zojuist haar tiende kaart goed gelegd" voor de sprong naar het einde. */
function wonState() {
  const years = Object.fromEntries(playable.map((c) => [c.id, c.year]));
  const sortTl = (ids) => [...ids].sort((a, b) => years[a] - years[b]);
  const sanne = sortTl([...DIGITAL.nearWin.sanne, DIGITAL.nearWin.card]);
  const daan = sortTl(DIGITAL.nearWin.daan);
  const used = new Set([...sanne, ...daan]);
  const pile = shuffle(playable.map((c) => c.id).filter((id) => !used.has(id)), seededRandom(2024)).slice(0, 120);
  const before = sanne.filter((id) => id !== DIGITAL.nearWin.card).map((id) => years[id]);
  const slots = correctSlots(before, years[DIGITAL.nearWin.card]);
  return {
    v: 1, goal: 10, current: 0, pile, years, phase: 'won', round: DIGITAL.nearWin.round, currentCard: null, winners: [0],
    players: [{ name: DIGITAL.names[0], timeline: sanne }, { name: DIGITAL.names[1], timeline: daan }],
    last: { player: 0, cardId: DIGITAL.nearWin.card, slot: slots[0], correct: true, correctSlots: slots },
  };
}

export async function record() {
  const phoneDir = join(TMP, 'phone');
  rmSync(phoneDir, { recursive: true, force: true });
  ensureDir(phoneDir);
  const camCurrent = join(ensureDir(join(TMP, 'camera')), 'current.mjpeg');
  copyFileSync(camFile(TABLE.good), camCurrent);

  const { seed, ids: seedIds } = findSeed();
  console.log(`digitale modus: seed ${seed} ->`, seedIds.map((id) => `${byId.get(id).year} ${byId.get(id).artist}`).join(' | '));

  const server = await startServer();
  const browser = await launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${camCurrent}`]);
  const problems = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: PHONE.scale, isMobile: true, hasTouch: true,
      locale: 'nl-NL', serviceWorkers: 'block', permissions: ['camera'],
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    });
    await ctx.addInitScript(({ s, base }) => {
      const real = Math.random.bind(Math);
      let first = true;
      Math.random = () => { if (first) { first = false; return (s + 0.5) / 4294967296; } return real(); };
      try { localStorage.setItem('timetunesr.printBase.v1', JSON.stringify(base)); } catch { /* geen opslag */ }
    }, { s: seed, base: PUBLIC_URL });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`paginafout: ${e.message}`));
    await page.goto(server.url);
    await page.getByTestId('screen-start').waitFor();
    await page.getByTestId('deck-info').filter({ hasText: 'kaarten in het deck' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await sleep(600);

    // ---------- opname van het scherm ----------
    const cdp = await ctx.newCDPSession(page);
    const frames = [];
    const writes = [];
    let last = -1; let pending = null; let timer = null;
    const keep = (f) => {
      const name = `f${String(frames.length).padStart(6, '0')}.png`;
      frames.push([f.t, name]);
      writes.push(writeFile(join(phoneDir, name), Buffer.from(f.data, 'base64')));
      last = f.t;
    };
    cdp.on('Page.screencastFrame', (ev) => {
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      const f = { t: ev.metadata.timestamp, data: ev.data };
      clearTimeout(timer);
      if (f.t - last >= 1 / FPS - 0.004) { pending = null; keep(f); } else {
        // sneller dan 30 fps: sla over, maar bewaar altijd het laatste beeld van een beweging
        pending = f;
        timer = setTimeout(() => { if (pending) { keep(pending); pending = null; } }, 45);
      }
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await sleep(400);

    const T0 = Date.now() / 1000;
    const rel = () => Date.now() / 1000 - T0;
    const ev = { scenes: [], marks: {}, taps: [], drags: [], cuts: [], highlights: [], digital: { turns: [], scores: [], winner: null } };
    const known = new Set(SCENES.map((s) => s.id));
    const scene = (id) => {
      if (!known.has(id)) throw new Error(`onbekende scène ${id}`);
      ev.scenes.push({ id, t: rel() });
      console.log(`${rel().toFixed(2).padStart(7)}  ${id}`);
    };
    const mark = (name) => { ev.marks[name] = rel(); };
    const hold = (s) => sleep(s * 1000);
    const holdUntil = (t) => sleep(Math.max(0, (t - rel()) * 1000));

    /** Tik op een element; de tik-indicator verschijnt `lead` seconden eerder. */
    async function tap(target, { lead = 0.5 } = {}) {
      const loc = typeof target === 'string' ? page.getByTestId(target) : target;
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      const box = await loc.boundingBox();
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      if (y < 0 || y > PHONE.height) throw new Error(`doel van de tik staat buiten beeld (${target})`);
      const e = { t: rel() + lead, x, y, lead };
      ev.taps.push(e);
      await sleep(lead * 1000);
      e.t = rel();
      await page.touchscreen.tap(x, y);
    }
    /** Vloeiend scrollen, met een vinger-indicator die omhoog/omlaag veegt. */
    async function scrollTo(y, dur = 0.9) {
      const y0 = await page.evaluate(() => window.scrollY);
      const dy = y - y0;
      const from = dy > 0 ? 640 : 260;
      const e = { t0: rel() + 0.3, t1: rel() + 0.3 + dur, x: 300, y0: from, y1: from - Math.sign(dy) * Math.min(420, Math.abs(dy)) };
      ev.drags.push(e);
      await sleep(300);
      e.t0 = rel(); e.t1 = e.t0 + dur;
      await page.evaluate(({ to, ms }) => new Promise((res) => {
        const a = window.scrollY; const t0 = performance.now();
        const io = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - ((-2 * p + 2) ** 3) / 2);
        (function step() {
          const p = Math.min(1, (performance.now() - t0) / ms);
          window.scrollTo(0, a + (to - a) * io(p));
          if (p < 1) requestAnimationFrame(step); else res();
        }());
      }), { to: y, ms: dur * 1000 });
    }
    const playing = async (what) => {
      await page.waitForFunction(() => window.__tt.player.state.status === 'playing', null, { timeout: 8000 })
        .catch(() => { throw new Error(`fragment speelt niet (${what}); opname afgebroken`); });
    };
    /** Tijdens het verborgen afspelen mag er niets van het antwoord op het scherm staan. */
    const assertHidden = async (id) => {
      const text = await page.evaluate(() => document.body.innerText);
      const c = byId.get(id);
      for (const secret of [c.title, c.artist, String(c.year)]) {
        if (text.includes(secret)) problems.push(`antwoord zichtbaar tijdens verborgen afspelen van kaart ${id}: "${secret}"`);
      }
    };
    const gameState = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.game.v1')));
    const logScores = (g) => ev.digital.scores.push({ t: rel(), goal: g.goal, values: g.players.map((p) => p.timeline.length) });
    /** Kies in de digitale modus bewust een goede of een foute plek voor de huidige kaart. */
    async function pickSlot(wantCorrect) {
      const g = await gameState();
      const years = g.players[g.current].timeline.map((id) => g.years[id]);
      const good = correctSlots(years, g.years[g.currentCard]);
      const all = years.map((_, i) => i).concat(years.length);
      const options = all.filter((i) => good.includes(i) === wantCorrect);
      if (!options.length) throw new Error('geen passende plek voor deze beurt');
      return options[options.length - 1];
    }

    // ================= het draaiboek =================
    scene('title'); await hold(3.2);
    scene('intro'); await hold(6.4);

    // --- spelen met kaarten ---
    scene('s1'); await hold(2.9);
    await tap('start-scan');
    scene('s2');
    await page.locator('[data-testid="viewfinder"][data-state="scanning"]').waitFor({ timeout: 8000 });
    await page.waitForURL(new RegExp(`#/c/${TABLE.good}$`), { timeout: 15000 });
    scene('s3');
    await page.getByTestId('screen-card').waitFor();
    await playing(`kaart ${TABLE.good}`);
    await assertHidden(TABLE.good);
    await holdUntil(ev.scenes.at(-1).t + 5.6);
    scene('s4'); await hold(5.4);
    scene('s5'); await hold(3.9);
    scene('s5good'); await hold(3.0);
    await assertHidden(TABLE.good);

    scene('s5next');
    copyFileSync(camFile(TABLE.bad), camCurrent); // de "camera" ziet nu de volgende kaart
    await hold(0.4);
    await tap('next-card');
    mark('scanTapB');
    await page.waitForURL(new RegExp(`#/c/${TABLE.bad}$`), { timeout: 15000 });
    mark('detectB');
    await playing(`kaart ${TABLE.bad}`);
    await assertHidden(TABLE.bad);
    await holdUntil(ev.marks.detectB + 2.8);
    scene('s5bad'); await hold(3.8);
    scene('s6'); await hold(4.5);
    await assertHidden(TABLE.bad);
    await tap('back-home'); // terug naar het startscherm
    await hold(0.35);

    // --- zonder kaarten ---
    scene('d1'); await hold(1.5);
    await tap('start-digital');
    await page.locator('[data-testid="screen-game"][data-view="setup"]').waitFor();
    mark('setup');
    await hold(0.5);
    for (const [i, name] of DIGITAL.names.entries()) {
      await tap(`player-name-${i}`, { lead: 0.35 });
      await page.keyboard.type(name, { delay: 75 });
      mark(`name${i}`);
      await hold(0.15);
    }
    await tap('start-game');
    await page.locator('[data-testid="screen-game"][data-view="handoff"]').waitFor();
    let g = await gameState();
    logScores(g);
    ev.digital.turns.push({ t: rel(), player: g.current });
    await hold(1.2);
    await tap('start-turn');
    scene('d2');
    await page.locator('[data-testid="screen-game"][data-view="place"]').waitFor();
    await playing('digitale beurt 1');
    await holdUntil(ev.scenes.at(-1).t + 2.6);
    await tap(`slot-${await pickSlot(true)}`);
    await hold(0.8);
    await tap('confirm-place');
    scene('d3');
    await page.locator('[data-testid="result"][data-correct="true"]').waitFor({ timeout: 3000 });
    logScores(await gameState());
    await hold(4.0);

    scene('d3next');
    await tap('next-turn', { lead: 0.4 });
    await page.locator('[data-testid="screen-game"][data-view="handoff"]').waitFor();
    g = await gameState();
    ev.digital.turns.push({ t: rel(), player: g.current });
    await hold(1.0);
    await tap('start-turn', { lead: 0.4 });
    await page.locator('[data-testid="screen-game"][data-view="place"]').waitFor();
    await playing('digitale beurt 2');
    await hold(1.1);
    await tap(`slot-${await pickSlot(false)}`, { lead: 0.4 });
    await hold(0.7);
    await tap('confirm-place', { lead: 0.4 });
    scene('d3bad');
    await page.locator('[data-testid="result"][data-correct="false"]').waitFor({ timeout: 3000 });
    logScores(await gameState());
    await hold(3.5);

    if (DIGITAL.showWinner) {
      // sprong in de tijd: de telefoon toont "Even later…" terwijl de eindstand wordt klaargezet
      const cut = { t0: rel(), t1: 0 };
      ev.cuts.push(cut);
      await hold(0.35);
      const won = wonState();
      await page.evaluate((state) => {
        localStorage.setItem('timetunesr.game.v1', JSON.stringify(state));
        window.__tt.navigate('#/spel');
      }, won);
      await page.locator('[data-testid="screen-game"][data-view="won"]').waitFor({ timeout: 3000 });
      await holdUntil(cut.t0 + 0.95);
      scene('d3win');
      cut.t1 = rel() + 0.35;
      ev.digital.scores.push({ t: cut.t1 - 0.3, goal: won.goal, values: won.players.map((p) => p.timeline.length) });
      ev.digital.winner = { t: cut.t1 - 0.3, player: 0 };
      await hold(3.6);
    }

    // --- zelf printen ---
    await tap('back-home', { lead: 0.4 });
    await page.getByTestId('screen-start').waitFor();
    scene('p1'); await hold(0.9);
    await tap('start-print');
    await page.locator('[data-testid="print-sheet"]').first().waitFor({ timeout: 10000 });
    if (await page.getByTestId('print-base-warn').isVisible()) problems.push('printscherm toont een waarschuwing over het adres');
    const tops = await page.evaluate(() => [...document.querySelectorAll('[data-testid="print-sheet"]')].slice(0, 2)
      .map((e) => Math.round(e.getBoundingClientRect().top + window.scrollY)));
    await hold(0.8);
    await scrollTo(tops[0] - 64, 0.9);
    mark('printFront');
    await hold(1.5);
    scene('p2');
    await hold(0.5);
    await scrollTo(tops[1] - 64, 0.9);
    mark('printBack');
    await hold(2.5);

    // --- slot ---
    await scrollTo(0, 0.5);
    await tap('back-home', { lead: 0.35 });
    await page.getByTestId('screen-start').waitFor();
    scene('outro');
    // de tip over het beginscherm in de app krijgt een kader zodra de tekst ernaast erover gaat
    const hint = await page.getByTestId('install-hint').boundingBox();
    if (hint) ev.highlights.push({ t0: rel() + 1.5, t1: rel() + 5.3, ...hint });
    await hold(5.6);
    scene('end'); await hold(3.0);
    ev.duration = rel();

    await cdp.send('Page.stopScreencast');
    clearTimeout(timer);
    await Promise.all(writes);
    ev.frames = frames.map(([t, name]) => [Number((t - T0).toFixed(4)), name]);
    ev.config = { TABLE, DIGITAL, PUBLIC_URL, PHONE };
    ev.seed = seed;
    if (await page.evaluate(() => document.body.classList.contains('is-offline'))) problems.push('app meldde "offline"');
    if (problems.length) throw new Error(`Opname afgekeurd:\n- ${problems.join('\n- ')}`);
    writeFileSync(join(TMP, 'events.json'), JSON.stringify(ev));
    const fps = frames.length / ev.duration;
    console.log(`opname klaar: ${ev.duration.toFixed(1)} s, ${frames.length} telefoonframes (${fps.toFixed(1)} fps gemiddeld) -> ${join(TMP, 'events.json')}`);
    return ev;
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  record().catch((e) => { console.error(e.message || e); process.exit(1); });
}
