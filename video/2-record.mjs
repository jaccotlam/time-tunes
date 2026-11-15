// Stap 2: bedien de echte app in real time en neem de telefoonschermen op.
// - Chromium met nep-camera (de filmpjes uit 1-camera.mjs) en echte fragmenten (via de proxy).
// - Elk scherm komt als verliesvrije PNG-frames op ware pixelgrootte binnen (lib.mjs: capturePage),
//   elk met een tijdstempel. Geluid wordt niet opgenomen.
// - Vier telefoons: de hoofdtelefoon (links in beeld) en voor "Ieder een eigen telefoon" een
//   spelleider en twee spelers, elk in een eigen browsercontext en echt met elkaar verbonden via
//   een lokale PeerJS-server (tests/e2e/multi-helpers.mjs).
// - events.json legt vast wanneer elke scène begon en waar/wanneer er getikt is; daarmee
//   tekent 3-render.mjs het decor (ondertitels, tafel, tik-indicator) er precies gelijk mee op.
//
// Tijdens het bouwen kun je een deel opnemen: TT_ONLY=multi,playlist node video/2-record.mjs
// (delen: cards, print, digital, bingo, multi, music, playlist; titel, intro en slot horen er altijd bij).
import { copyFileSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, VIDEO_DIR, TMP, PUBLIC_URL, TABLE, DIGITAL, BINGO, PRINT_BINGO, MULTI, PLAYLIST, PHONE, SMALL_PHONE } from './config.mjs';
import { startServer, launch, ensureDir, sleep, aliasPublic, capturePage } from './lib.mjs';
import { camFile } from './1-camera.mjs';
import { SCENES } from './stage/scenes.js';
import { createGame, correctSlots } from '../app/js/logic.js';
import { createBingo, checkSquare, findBingo, generateCards, cardSignature } from '../app/js/bingo.js';
import { CODE_ALPHABET } from '../app/js/multi/code.js';
import { startSignal, phone as multiPhone, waitForPlayers, hostRoom } from '../tests/e2e/multi-helpers.mjs';

const deckCards = JSON.parse(readFileSync(join(ROOT, 'app/data/deck.json'), 'utf8')).cards
  .map((c) => ({ ...c, id: String(c.id), year: Number(c.year) }))
  .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const byId = new Map(deckCards.map((c) => [c.id, c]));
const playable = deckCards.filter((c) => Number.isFinite(c.year) && (c.previewUrl || c.itunesId));
/** Een waarde voor Math.random() waarmee de app precies deze zaaiwaarde kiest: (x * 2^32) >>> 0 === seed. */
const randomFor = (seed) => (seed + 0.5) / 4294967296;
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const ALL_PARTS = ['cards', 'print', 'digital', 'bingo', 'multi', 'music', 'playlist'];
const ONLY = (process.env.TT_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (part) => ONLY.length === 0 || ONLY.includes(part);

/**
 * Tijdlijn (alleen de app) schudt met een seed uit Math.random(). We zoeken een seed waarbij de twee
 * startkaarten en het eerste nummer bekend zijn en het eerste nummer duidelijk later is dan Sannes
 * startkaart, zodat "goed" in één oogopslag te volgen is. De opname levert die seed aan Math.random().
 */
function findSeed() {
  const known = new Set(DIGITAL.known);
  const taken = new Set([BINGO.nearWin.card, TABLE.good, TABLE.bad]); // niet twee keer hetzelfde nummer in de video
  for (let seed = 1; seed < 500000; seed++) {
    const g = createGame({ names: DIGITAL.names, goal: 10, cards: playable.map((c) => ({ id: c.id, year: c.year })), seed });
    const ids = [g.players[0].timeline[0], g.players[1].timeline[0], g.pile[0]];
    if (!ids.every((id) => known.has(id)) || ids.some((id) => taken.has(id))) continue;
    const [s0, , s1] = ids.map((id) => byId.get(id).year);
    if (s1 - s0 < 8) continue; // Sanne krijgt een later nummer en legt het na haar startkaart
    return { seed, ids };
  }
  throw new Error('Geen geschikte seed gevonden; pas DIGITAL.known aan.');
}

/**
 * Het bingopotje dat de app met BINGO.seed uitdeelt, vooraf nagerekend met de logica van de app zelf.
 * Controleert dat het draaiboek klopt: beurt 1 is goed, de sprong levert precies één ontbrekend vakje op.
 */
function planBingo() {
  const g = createBingo({ names: BINGO.names, size: BINGO.size, seed: BINGO.seed, cards: playable.map((c) => ({ id: c.id, year: c.year })) });
  const [sanne, daan] = g.players.map((p) => p.card);
  const cell = (card, key) => { const i = card.indexOf(key); if (i < 0) throw new Error(`bingokaart mist het vakje ${key}; pas BINGO in config.mjs aan`); return i; };
  const song = g.pile[0];
  const plan = { song, cards: [sanne, daan], first: cell(sanne, BINGO.first.key), win: cell(sanne, BINGO.nearWin.claim) };
  const year = (id) => byId.get(id).year;
  if (checkSquare(BINGO.first.key, year(song)) !== true) throw new Error('BINGO: de eerste claim is niet goed');
  const marks = Array(sanne.length).fill(null);
  marks[plan.first] = song;
  for (const [key, id] of Object.entries(BINGO.nearWin.sanne)) {
    if (checkSquare(key, year(id)) !== true) throw new Error(`BINGO.nearWin: kaart ${id} past niet bij ${key}`);
    marks[cell(sanne, key)] = id;
  }
  for (const [key, id] of Object.entries(BINGO.nearWin.daan)) {
    if (checkSquare(key, year(id)) !== true) throw new Error(`BINGO.nearWin: kaart ${id} past niet bij ${key}`);
    cell(daan, key);
  }
  if (findBingo(marks, BINGO.size)) throw new Error('BINGO.nearWin: Sanne heeft al bingo');
  if (checkSquare(BINGO.nearWin.claim, year(BINGO.nearWin.card)) !== true) throw new Error('BINGO.nearWin: de winnende claim is niet goed');
  marks[plan.win] = BINGO.nearWin.card;
  if (!findBingo(marks, BINGO.size)) throw new Error('BINGO.nearWin: de winnende claim maakt geen volle lijn');
  return plan;
}

/** Spelstand "een paar rondes later": Sanne is aan de beurt en mist nog één vakje voor een volle rij. */
function nearWinState(live) {
  const s = structuredClone(live);
  const put = (p, marks) => { for (const [key, id] of Object.entries(marks)) s.players[p].marks[s.players[p].card.indexOf(key)] = id; };
  put(0, BINGO.nearWin.sanne);
  put(1, BINGO.nearWin.daan);
  const used = new Set([...s.players.flatMap((p) => p.marks.filter(Boolean)), BINGO.nearWin.card]);
  return {
    ...s, pile: s.pile.filter((id) => !used.has(id)), current: 0, round: BINGO.nearWin.round, phase: 'turn',
    currentCard: BINGO.nearWin.card, last: null, winners: [], winLine: null,
  };
}

export async function record() {
  const phoneDir = join(TMP, 'phone');
  rmSync(phoneDir, { recursive: true, force: true });
  ensureDir(phoneDir);
  const camCurrent = join(ensureDir(join(TMP, 'camera')), 'current.mjpeg');
  copyFileSync(camFile(TABLE.good), camCurrent);

  const { seed, ids: seedIds } = findSeed();
  const say = (id) => `${byId.get(id).year} ${byId.get(id).artist}`;
  console.log(`tijdlijn in de app: seed ${seed} ->`, seedIds.map(say).join(' | '));
  const plan = planBingo();
  console.log(`bingo: seed ${BINGO.seed} ->`, say(plan.song), '| daarna', say(BINGO.nearWin.card));
  const printSignature = cardSignature(generateCards(8, PRINT_BINGO.size, PRINT_BINGO.seed)[0]);

  const server = await startServer();
  const signal = want('multi') ? await startSignal() : null;
  const browser = await launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${camCurrent}`]);
  const problems = [];
  const captures = [];
  try {
    // ---------- de hoofdtelefoon ----------
    const ctx = await browser.newContext({
      viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: PHONE.scale, isMobile: true, hasTouch: true,
      locale: 'nl-NL', serviceWorkers: 'block', permissions: ['camera'], userAgent: USER_AGENT,
    });
    const APP = await aliasPublic(ctx, server); // de lokale app, in beeld onder het publieke adres
    // De opname zet vlak voor een tik een waarde klaar in window.__ttRandom; de app gebruikt die als
    // zaaiwaarde (Tijdlijn, bingokaarten op het printscherm, kamercode). Anders is Math.random() gewoon willekeurig.
    const seedable = () => {
      const real = Math.random.bind(Math);
      const queue = [];
      window.__ttRandom = queue;
      Math.random = () => (queue.length ? queue.shift() : real());
    };
    await ctx.addInitScript(seedable);
    await ctx.addInitScript(({ bingoSeed, bingoSetup, playlists }) => {
      try {
        if (localStorage.getItem('timetunesr.video.v3')) return; // alleen bij de eerste keer laden
        localStorage.setItem('timetunesr.video.v3', '1');
        localStorage.setItem('timetunesr.bingoSeed.v1', String(bingoSeed));
        localStorage.setItem('timetunesr.bingoSetup.v1', JSON.stringify(bingoSetup)); // namen staan al ingevuld (dat tikken zag je bij Tijdlijn)
        localStorage.setItem('timetunesr.playlists.v1', JSON.stringify(playlists));
        localStorage.setItem('timetunesr.itunesGap.v1', '30');
      } catch { /* geen opslag */ }
    }, {
      bingoSeed: BINGO.seed, bingoSetup: { names: BINGO.names, size: BINGO.size },
      playlists: { v: 1, lists: [{ id: PLAYLIST.id, name: PLAYLIST.name, nextN: PLAYLIST.tracks.length + 1, tracks: PLAYLIST.tracks }] },
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`paginafout: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(APP);
    await page.getByTestId('screen-start').waitFor();
    await page.getByTestId('deck-info').filter({ hasText: `${deckCards.length} kaarten` }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    /**
     * Haal voor de nummers die in de video starten nu alvast de verse fragment-link op (dezelfde
     * iTunes-lookup die de app per kaart doet) en laad het fragment in de browsercache. In de video
     * krijgt de app het antwoord op die lookup meteen terug, zodat het afspeelscherm niet onnodig lang
     * op "Fragment wordt geladen…" staat en Apples limiet op zoekvragen de opname niet kan breken.
     */
    async function warmUp(context, onPage, cards) {
      const got = await onPage.evaluate(async (list) => Promise.all(list.map(async (c) => {
        let url = c.previewUrl; let body = null;
        try {
          const res = await fetch(`https://itunes.apple.com/lookup?id=${c.itunesId}&country=NL`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
          const text = await res.text();
          const hit = (JSON.parse(text).results || []).find((r) => r.previewUrl);
          if (res.ok && hit) { url = hit.previewUrl; body = text; }
        } catch { /* dan de link uit het deck */ }
        const loaded = await new Promise((done) => {
          const a = new Audio();
          a.preload = 'auto'; a.muted = true;
          a.oncanplaythrough = () => done(true); a.onerror = () => done(false);
          setTimeout(() => done(false), 8000);
          a.src = url;
        });
        return { id: String(c.itunesId), body, loaded };
      })), cards.map((c) => ({ itunesId: c.itunesId, previewUrl: c.previewUrl })));
      const answers = new Map(got.filter((g) => g.body).map((g) => [g.id, g.body]));
      await context.route('https://itunes.apple.com/lookup?**', (route) => {
        const body = answers.get(new URL(route.request().url()).searchParams.get('id'));
        if (!body) return route.continue();
        return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body });
      });
      return `${got.filter((g) => g.loaded).length}/${got.length} geladen, ${answers.size}/${got.length} met verse link`;
    }
    console.log('fragmenten:', await warmUp(ctx, page, [TABLE.good, TABLE.bad, seedIds[2], plan.song, BINGO.nearWin.card].map((id) => byId.get(id))));

    // De zoekvraag van "Eigen playlist" wordt nu alvast aan iTunes gesteld; in de video krijgt de app
    // dat antwoord meteen terug. Apple staat maar ±20 zoekvragen per minuut toe: mislukt het (te veel
    // vragen, geen internet), dan dient het bewaarde antwoord in itunes-zoekresultaat.json.
    if (want('playlist')) {
      const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(PLAYLIST.query)}&entity=song&country=NL&limit=25`;
      let body = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
          return res.ok ? await res.text() : null;
        } catch { return null; }
      }, searchUrl);
      try { if (!(JSON.parse(body).results.length > 0)) body = null; } catch { body = null; }
      console.log(`zoekresultaat voor "${PLAYLIST.query}": ${body ? 'vers van iTunes' : 'bewaard antwoord (iTunes gaf nu geen antwoord)'}`);
      body ||= readFileSync(join(VIDEO_DIR, 'itunes-zoekresultaat.json'), 'utf8');
      await ctx.route('https://itunes.apple.com/search?**', async (route) => {
        if (!decodeURIComponent(route.request().url()).includes(`term=${PLAYLIST.query}`)) return route.continue();
        await sleep(450); // zo lang doet iTunes er ongeveer over
        return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body });
      });
    }

    // ---------- de drie telefoons van "Ieder een eigen telefoon" ----------
    const main = { key: 'main', page, dims: PHONE };
    const trio = [];
    if (want('multi')) {
      for (const [i, key] of ['host', 'a', 'b'].entries()) {
        const p = await multiPhone(browser, signal, {
          seed: i === 0 ? MULTI.seed : null, fixtureDeck: false,
          viewport: { width: SMALL_PHONE.width, height: SMALL_PHONE.height }, deviceScaleFactor: SMALL_PHONE.scale,
        });
        await aliasPublic(p.context, server);
        await p.context.addInitScript(seedable);
        p.page.on('pageerror', (e) => problems.push(`paginafout (${key}): ${e.message}`));
        trio.push({ key, page: p.page, dims: SMALL_PHONE });
      }
      await Promise.all(trio.map(async (p) => {
        await p.page.goto(APP);
        await p.page.getByTestId('deck-info').filter({ hasText: `${deckCards.length} kaarten` }).waitFor();
        await p.page.evaluate(() => document.fonts.ready);
      }));
      // het toestel van de spelleider speelt de muziek: het eerste nummer van het potje alvast laden
      if (byId.has(MULTI.firstSong)) console.log('fragment spelleider:', await warmUp(trio[0].page.context(), trio[0].page, [byId.get(MULTI.firstSong)]));
    }
    const [host, pa, pb] = trio;
    await sleep(600);

    // ---------- opname van de schermen ----------
    let T0 = Date.now() / 1000;
    const rel = () => Date.now() / 1000 - T0;
    for (const p of [main, ...trio]) {
      p.cap = await capturePage(p.page, join(phoneDir, p.key), 'f', rel);
      captures.push(p.cap);
      if (p !== main) p.cap.pause(); // pas opnemen als ze in beeld komen
    }
    await sleep(300);
    // de video begint hier: wat er al is opgenomen, is het beginbeeld (t = 0)
    T0 = Date.now() / 1000;
    for (const c of captures) for (const f of c.frames) f[0] = 0;

    const ev = {
      scenes: [], marks: {}, taps: [], drags: [], cuts: [], highlights: [],
      digital: { turns: [], scores: [] },
      bingo: { size: BINGO.size, names: BINGO.names, cards: plan.cards, years: {}, snaps: [] },
      multi: { code: MULTI.code, host: MULTI.host, names: MULTI.names },
      print: { bingo: PRINT_BINGO },
    };
    const known = new Set(SCENES.map((s) => s.id));
    const scene = (id) => {
      if (!known.has(id)) throw new Error(`onbekende scène ${id}`);
      ev.scenes.push({ id, t: rel() });
      console.log(`${rel().toFixed(2).padStart(7)}  ${id}`);
    };
    const mark = (name, dt = 0) => { ev.marks[name] = rel() + dt; };
    const hold = (s) => sleep(s * 1000);
    const holdUntil = (t) => sleep(Math.max(0, (t - rel()) * 1000));

    /** Tik op een element; de tik-indicator verschijnt `lead` seconden eerder. `on` = welke telefoon. */
    async function tap(target, { lead = 0.5, on = main } = {}) {
      const loc = typeof target === 'string' ? on.page.getByTestId(target) : target;
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      const box = await loc.boundingBox();
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      if (y < 0 || y > on.dims.height || x < 0 || x > on.dims.width) throw new Error(`doel van de tik staat buiten beeld (${target})`);
      const e = { t: rel() + lead, x, y, lead, phone: on.key };
      ev.taps.push(e);
      await sleep(lead * 1000);
      e.t = rel();
      await on.page.touchscreen.tap(x, y);
    }
    /** Het zichtbare vak van een keuzerondje (het rondje zelf is onzichtbaar of klein). */
    const optionOf = (testid, on = main) => on.page.locator(`label:has([data-testid="${testid}"])`);
    /** Vloeiend scrollen, met een vinger-indicator die omhoog/omlaag veegt. */
    async function scrollTo(y, dur = 0.9) {
      const y0 = await page.evaluate(() => window.scrollY);
      const dy = y - y0;
      if (Math.abs(dy) < 2) return;
      const from = dy > 0 ? 640 : 260;
      const e = { t0: rel() + 0.3, t1: rel() + 0.3 + dur, x: 300, y0: from, y1: from - Math.sign(dy) * Math.min(420, Math.abs(dy)), phone: 'main' };
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
    const pageTop = (locator) => locator.evaluate((e) => Math.round(e.getBoundingClientRect().top + window.scrollY));
    const playing = async (what, on = main) => {
      await on.page.waitForFunction(() => window.__tt.player.state.status === 'playing', null, { timeout: 8000 })
        .catch(() => { throw new Error(`fragment speelt niet (${what}); opname afgebroken`); });
    };
    /**
     * Tijdens het verborgen afspelen mag er niets van het antwoord op het scherm staan. `year: false`
     * slaat het jaartal over waar de eigen tijdlijn (met jaartallen van andere kaarten) in beeld is.
     */
    const assertHidden = async (c, { year = true, on = main } = {}) => {
      const text = await on.page.evaluate(() => document.body.innerText);
      for (const secret of [c.title, c.artist, ...(year ? [String(c.year)] : [])]) {
        if (text.includes(secret)) problems.push(`antwoord zichtbaar tijdens verborgen afspelen (${on.key}, ${c.artist}): "${secret}"`);
      }
      if (await on.page.getByTestId('answer-card').count()) problems.push(`antwoordkaart zichtbaar tijdens verborgen afspelen (${on.key}, ${c.artist})`);
    };
    /** Kader om een onderdeel van het scherm van de hoofdtelefoon, van `from` tot `to` seconden vanaf nu. */
    const highlight = async (locator, from, to) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error('onderdeel voor het kader niet gevonden');
      ev.highlights.push({ t0: rel() + from, t1: rel() + to, ...box });
    };
    const home = async (lead = 0.4) => {
      await tap('back-home', { lead });
      await page.getByTestId('screen-start').waitFor();
    };
    const gameState = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.game.v1')));
    const logScores = (g) => ev.digital.scores.push({ t: rel(), goal: g.goal, values: g.players.map((p) => p.timeline.length) });
    const bingoState = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.bingo.v1')));
    /** Leg de stand van Sannes bingokaart vast; het decor tekent de kaart hiermee groot na. */
    async function snap(extra = {}) {
      const b = await bingoState();
      for (const p of b.players) for (const id of p.marks) if (id) ev.bingo.years[id] = b.years[id];
      ev.bingo.snaps.push({ t: rel(), marks: b.players.map((p) => p.marks), winLine: b.winLine, selected: null, ...extra });
      return b;
    }

    // ================= het draaiboek =================
    scene('title'); await hold(2.7);
    scene('intro'); await hold(4.7);
    // drie manieren: het startscherm heeft er een blok voor elk
    scene('modes');
    await highlight(page.getByTestId('mode-cards'), 0.5, 1.9);
    await highlight(page.getByTestId('mode-app'), 1.9, 3.3);
    await highlight(page.getByTestId('mode-multi'), 3.3, 4.8);
    mark('modeCards', 0.5); mark('modeApp', 1.9); mark('modeMulti', 3.3);
    await hold(4.9);

    // --- met kaartjes: Tijdlijn ---
    if (want('cards')) {
      scene('s1'); await hold(2.3);
      await tap('start-scan');
      scene('s2');
      await main.cap.setMode('cast'); // het scanscherm: vloeiend camerabeeld gaat voor (zie capturePage)
      await page.locator('[data-testid="viewfinder"][data-state="scanning"]').waitFor({ timeout: 8000 });
      await page.waitForURL(new RegExp(`#/c/${TABLE.good}$`), { timeout: 15000 });
      scene('s3');
      await page.getByTestId('screen-card').waitFor();
      await main.cap.setMode('shot');
      await playing(`kaart ${TABLE.good}`);
      mark('playA');
      await assertHidden(byId.get(TABLE.good));
      await holdUntil(ev.scenes.at(-1).t + 4.3);
      scene('s4'); await hold(5.0);
      scene('s5'); await hold(3.3);
      scene('s5good'); await hold(2.6);
      await assertHidden(byId.get(TABLE.good));

      scene('s5next');
      copyFileSync(camFile(TABLE.bad), camCurrent); // de "camera" ziet nu de volgende kaart
      await hold(0.3);
      await tap('next-card', { lead: 0.45 });
      mark('scanTapB');
      await main.cap.setMode('cast');
      await page.waitForURL(new RegExp(`#/c/${TABLE.bad}$`), { timeout: 15000 });
      mark('detectB');
      await page.getByTestId('screen-card').waitFor();
      await main.cap.setMode('shot');
      await playing(`kaart ${TABLE.bad}`);
      mark('playB');
      await assertHidden(byId.get(TABLE.bad));
      await holdUntil(ev.marks.detectB + 2.7);
      scene('s5bad'); await hold(3.6);
      scene('s6'); await hold(4.2);
      await assertHidden(byId.get(TABLE.bad));
      await home(0.45);
      await hold(0.3);
    }

    // --- met kaartjes: zelf printen ---
    if (want('print')) {
      scene('p1'); await hold(0.6);
      await page.evaluate((v) => window.__ttRandom.push(v), randomFor(PRINT_BINGO.seed)); // vaste bingokaarten op het printscherm
      await tap('start-print', { lead: 0.45 });
      await page.locator('[data-testid="print-sheet"]').first().waitFor({ timeout: 10000 });
      if (await page.getByTestId('print-base-warn').isVisible()) problems.push('printscherm toont een waarschuwing over het adres');
      if ((await page.getByTestId('print-base-url').inputValue()) !== PUBLIC_URL) problems.push('printscherm gebruikt niet het publieke adres voor de QR-codes');
      await hold(0.6);
      await scrollTo(await pageTop(page.getByTestId('print-sheet').first()) - 64, 0.8); // voorkant helemaal, daaronder het begin van de achterkant
      mark('printFront');
      await hold(2.3);
      scene('p2');
      await scrollTo(0, 0.6);
      await tap(optionOf('print-kind-bingo'), { lead: 0.45 });
      await page.getByTestId('print-bingo-sheet').first().waitFor({ timeout: 5000 });
      if (await page.getByTestId('print-bingo-card').first().getAttribute('data-signature') !== printSignature) {
        throw new Error('Printscherm: andere bingokaarten dan verwacht (zaaiwaarde niet gebruikt?)');
      }
      await hold(0.4);
      await scrollTo(await pageTop(page.getByTestId('print-bingo-sheet').first()) - 64, 0.8);
      mark('printBingo');
      await hold(2.3);
      await scrollTo(0, 0.3);
      await home(0.35);
      await hold(0.2);
    }

    // --- alleen de app: Tijdlijn ---
    if (want('digital')) {
      scene('d1'); await hold(1.0);
      await page.evaluate((v) => window.__ttRandom.push(v), randomFor(seed)); // de zaaiwaarde voor dit potje
      await tap('start-digital');
      await page.locator('[data-testid="screen-game"][data-view="setup"]').waitFor();
      mark('setup');
      await hold(0.45);
      for (const [i, name] of DIGITAL.names.entries()) {
        await tap(`player-name-${i}`, { lead: 0.35 });
        await page.keyboard.type(name, { delay: 65 });
        mark(`name${i}`);
        await hold(0.15);
      }
      await tap('start-game', { lead: 0.45 });
      await page.locator('[data-testid="screen-game"][data-view="handoff"]').waitFor();
      const g = await gameState();
      if ([g.players[0].timeline[0], g.players[1].timeline[0], g.currentCard || g.pile[0]].join() !== seedIds.join()) {
        throw new Error('Tijdlijn: de app deelde andere kaarten uit dan verwacht (zaaiwaarde niet gebruikt?)');
      }
      logScores(g);
      ev.digital.turns.push({ t: rel(), player: g.current });
      await hold(0.8);
      await tap('start-turn', { lead: 0.45 });
      scene('d2');
      await page.locator('[data-testid="screen-game"][data-view="place"]').waitFor();
      await playing('tijdlijn in de app');
      await assertHidden(byId.get(seedIds[2]), { year: false });
      await holdUntil(ev.scenes.at(-1).t + 2.2);
      {
        const now = await gameState();
        const years = now.players[now.current].timeline.map((id) => now.years[id]);
        const good = correctSlots(years, now.years[now.currentCard]);
        await tap(`slot-${good[good.length - 1]}`);
      }
      await hold(0.7);
      await assertHidden(byId.get(seedIds[2]), { year: false });
      await tap('confirm-place', { lead: 0.45 });
      scene('d3');
      await page.locator('[data-testid="result"][data-correct="true"]').waitFor({ timeout: 3000 });
      logScores(await gameState());
      await hold(2.9);
      await home();
      await hold(0.2);
    }

    // --- alleen de app: Bingo ---
    if (want('bingo')) {
      scene('b1'); await hold(0.7);
      await tap('start-bingo', { lead: 0.45 });
      await page.locator('[data-testid="screen-bingo"][data-view="setup"]').waitFor();
      mark('bingoSetup');
      if ((await page.getByTestId('bingo-player-name-0').inputValue()) !== BINGO.names[0] || !(await page.getByTestId(`bingo-size-${BINGO.size}`).isChecked())) {
        throw new Error('Bingo: namen of kaartformaat staan niet klaar');
      }
      await hold(1.0);
      await tap('bingo-start', { lead: 0.45 });
      await page.getByTestId('bingo-handoff').waitFor();
      mark('bingoDeal');
      let b = await snap();
      if (b.seed !== BINGO.seed || b.size !== BINGO.size || b.currentCard !== plan.song
        || b.players.map((p) => p.card.join()).join('|') !== plan.cards.map((c) => c.join()).join('|')) {
        throw new Error('Bingo: de app deelde andere kaarten of nummers uit dan verwacht');
      }
      await hold(0.8);
      await tap('bingo-start-turn', { lead: 0.45 });
      await page.locator('[data-testid="screen-bingo"][data-view="claim"]').waitFor();
      await playing('bingo, beurt 1');
      await assertHidden(byId.get(plan.song));
      await hold(1.0);
      scene('b2');
      await hold(1.1);
      await tap(`bingo-cell-${plan.first}`, { lead: 0.45 });
      await snap({ selected: plan.first });
      await hold(0.8);
      await assertHidden(byId.get(plan.song));
      await tap('bingo-confirm', { lead: 0.45 });
      scene('b2good');
      await page.locator('[data-testid="bingo-result"][data-correct="true"]').waitFor({ timeout: 3000 });
      await snap();
      if (await page.getByTestId(`bingo-cell-${plan.first}`).getAttribute('data-state') !== 'stamped') problems.push('bingo: goed geclaimd vakje is niet afgestempeld');
      await hold(3.1);

      {
        // sprong in de tijd: de telefoon toont "Even later…" terwijl de stand van een paar rondes later
        // wordt klaargezet en Sannes fragment start
        const cut = { t0: rel(), t1: 0 };
        ev.cuts.push(cut);
        await hold(0.35);
        const near = nearWinState(await bingoState());
        await page.evaluate((state) => {
          localStorage.setItem('timetunesr.bingo.v1', JSON.stringify(state));
          window.__tt.navigate('#/');
        }, near);
        await page.getByTestId('screen-start').waitFor();
        await page.evaluate(() => window.__tt.navigate('#/bingo'));
        await page.getByTestId('bingo-current-player').filter({ hasText: BINGO.names[0] }).waitFor({ timeout: 3000 });
        await page.getByTestId('bingo-handoff').waitFor();
        scene('b3');
        await snap();
        await page.getByTestId('bingo-start-turn').tap();
        await page.locator('[data-testid="screen-bingo"][data-view="claim"]').waitFor();
        await playing('bingo, winnende beurt');
        await holdUntil(cut.t0 + 1.25);
        cut.t1 = rel() + 0.3;
      }
      await assertHidden(byId.get(BINGO.nearWin.card));
      await hold(1.3);
      await tap(`bingo-cell-${plan.win}`, { lead: 0.45 });
      await snap({ selected: plan.win });
      await hold(0.8);
      await assertHidden(byId.get(BINGO.nearWin.card));
      await tap('bingo-confirm', { lead: 0.45 });
      await page.locator('[data-testid="screen-bingo"][data-phase="won"] [data-testid="bingo-result"][data-correct="true"]').waitFor({ timeout: 3000 });
      mark('bingoWin');
      b = await snap();
      if ((await page.locator('[data-testid="bingo-card"] [data-win="true"]').count()) !== BINGO.size || !b.winLine) problems.push('bingo: de winnende lijn is niet gemarkeerd');
      await hold(2.8);
      await home();
      await hold(0.2);
    }

    // --- ieder een eigen telefoon ---
    if (want('multi')) {
      const phones = [host, pa, pb];
      const players = [pa, pb];
      scene('m1');
      mark('trioIn');
      for (const p of phones) p.cap.resume();
      await hold(1.7); // de drie telefoons schuiven in beeld
      main.cap.pause();
      await tap('start-host', { on: host });
      await host.page.getByTestId('host-setup-form').waitFor();
      await hold(0.8);
      await host.page.evaluate((vals) => window.__ttRandom.push(...vals),
        [...MULTI.code].map((ch) => (CODE_ALPHABET.indexOf(ch) + 0.5) / CODE_ALPHABET.length)); // de kamercode (zie config.mjs)
      await tap('host-create', { on: host });
      await host.page.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
      await host.page.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 20000 });
      mark('roomOpen');
      const code = (await host.page.getByTestId('room-code-big').textContent()).trim();
      if (code !== MULTI.code) throw new Error(`Kamer: code ${code} in plaats van ${MULTI.code}`);
      if ((await host.page.getByTestId('room-link').textContent()).trim() !== `${PUBLIC_URL}#/kamer/${code}`) problems.push('kamer: de link in de lobby is niet het publieke adres');
      if (await host.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) problems.push('kamer: de lobby is breder dan het scherm (QR-code valt buiten beeld)');
      await hold(1.5);

      scene('m2');
      await hold(0.5);
      await Promise.all(players.map(async (p, i) => {
        await hold(i * 0.55);
        await tap('start-join', { on: p, lead: 0.45 });
        await p.page.getByTestId('join-form').waitFor();
        await hold(0.35);
        await tap('join-code', { on: p, lead: 0.35 });
        await p.page.keyboard.type(code, { delay: 110 });
        await hold(0.2);
        await tap('join-name', { on: p, lead: 0.35 });
        await p.page.keyboard.type(MULTI.names[i], { delay: 70 });
        await hold(0.25);
        await tap('join-submit', { on: p, lead: 0.45 });
        await p.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
      }));
      await waitForPlayers(host.page, players.length);
      mark('joined');
      for (const p of players) {
        if ((await p.page.getByTestId('room-code').textContent()).trim() !== code) problems.push(`kamer: ${p.key} zit niet in kamer ${code}`);
      }
      await hold(1.3);

      scene('m3');
      await hold(0.3);
      await tap(optionOf(`room-size-${MULTI.size}`, host), { on: host, lead: 0.45 });
      await hold(0.5);
      await tap('room-start', { on: host, lead: 0.45 });
      await host.page.locator('[data-testid="screen-room-host"][data-view="answering"]').waitFor();
      await Promise.all(players.map((p) => p.page.locator('[data-testid="play-panel"]').waitFor()));
      await playing('samen spelen', host);
      mark('roundStart');
      const room = await hostRoom(host.page);
      const song = room.game.songs[room.game.current];
      if (!song?.title || !Number.isFinite(song.year)) throw new Error('Samen spelen: het lopende nummer is niet te lezen uit de spelstand');
      console.log(`samen spelen: ${song.year} ${song.artist} - ${song.title}${String(song.id) === MULTI.firstSong ? '' : ' (niet het verwachte nummer: pas MULTI.firstSong aan)'}`);
      for (const p of phones) await assertHidden(song, { on: p });
      await hold(1.3);
      // Anouk kiest een vakje dat klopt, Bram een vakje dat niet klopt: zo zie je straks beide uitkomsten.
      const views = await Promise.all(players.map((p) => p.page.evaluate(() => window.__ttRoom.session.view.game.mine)));
      const pick = (mine, correct, prefer) => {
        const open = mine.card.map((k, i) => ({ k, i })).filter((o) => mine.marks[o.i] == null && !['artist', 'title', 'year'].includes(o.k)
          && checkSquare(o.k, song.year) === correct);
        open.sort((x, y) => (prefer.indexOf(x.k) + 99) % 99 - (prefer.indexOf(y.k) + 99) % 99);
        if (!open.length) throw new Error('Samen spelen: geen passend vakje op de bingokaart');
        return open[0].i;
      };
      const cells = [pick(views[0], true, ['d10', 'd00', 'd90', 'd80', 'd70', 'd60']), pick(views[1], false, ['pre00', 'pre80', 'd80', 'd90'])];
      await Promise.all(players.map(async (p, i) => {
        await hold(i * 0.8);
        await tap(`bingo-cell-${cells[i]}`, { on: p, lead: 0.45 });
        await hold(0.7);
        await tap('answer-lock', { on: p, lead: 0.45 });
        await p.page.locator('[data-testid="answer-state"][data-state="locked"]').waitFor({ timeout: 15000 });
      }));
      await host.page.waitForFunction((n) => Number(document.querySelector('[data-testid="room-answered"]')?.dataset.done) >= n, players.length, { timeout: 15000 });
      mark('allAnswered');
      for (const p of phones) await assertHidden(song, { on: p });
      await hold(1.2);

      scene('m4');
      await hold(0.4);
      await tap('room-reveal', { on: host });
      await host.page.locator('[data-testid="screen-room-host"][data-view="revealed"]').waitFor();
      await Promise.all(players.map((p) => p.page.locator('[data-testid="screen-room-player"][data-view="revealed"]').waitFor({ timeout: 15000 })));
      mark('revealed');
      const results = await Promise.all(players.map((p) => p.page.getByTestId('my-result').getAttribute('data-correct')));
      if (results.join() !== 'true,false') problems.push(`samen spelen: uitslag ${results.join()} in plaats van goed/fout`);
      for (const p of phones) {
        if (!(await p.page.evaluate((t) => document.body.innerText.includes(t), song.title))) problems.push(`samen spelen: ${p.key} toont het antwoord niet na de onthulling`);
      }
      if ((await host.page.getByTestId('room-standings').count()) !== 1) problems.push('samen spelen: geen tussenstand bij de spelleider');
      ev.multi.song = { title: song.title, artist: song.artist, year: song.year };
      await hold(3.9);
      mark('trioOut');
      main.cap.resume();
      await hold(0.9); // de drie telefoons schuiven weg, de hoofdtelefoon komt terug
      for (const p of phones) p.cap.pause();
    }

    // --- de muziek: fragment of Spotify (alleen het instellingenscherm, geen verbinding) ---
    if (want('music') || want('playlist')) {
      scene('set1'); await hold(0.7);
      await tap('start-settings', { lead: 0.45 });
      await page.getByTestId('screen-settings').waitFor();
      mark('settings');
      if (await page.getByTestId('spotify-env-warning').count()) problems.push('instellingenscherm toont een waarschuwing over het adres');
      if (!(await page.getByTestId('source-preview').isChecked())) problems.push('muziekbron staat niet op het fragment van 30 seconden');
      await highlight(optionOf('source-preview'), 0.4, 2.4);
      await highlight(optionOf('source-spotify'), 2.4, 4.5);
      mark('srcPreview', 0.4); mark('srcSpotify', 2.4);
      await hold(4.6);
    }

    // --- eigen playlist ---
    if (want('playlist')) {
      scene('pl1');
      await tap('settings-playlists', { lead: 0.5 });
      await page.getByTestId('screen-playlists').waitFor();
      await hold(0.7);
      await tap(page.locator(`[data-testid="playlist-open"][data-deck-id="${PLAYLIST.id}"]`), { lead: 0.45 });
      await page.getByTestId('screen-playlist').waitFor();
      mark('playlistOpen');
      await hold(0.6);
      await tap('pl-search-input', { lead: 0.4 });
      await page.keyboard.type(PLAYLIST.query, { delay: 60 });
      await tap('pl-search-go', { lead: 0.35 });
      const first = page.getByTestId('pl-search-result').first();
      await first.waitFor({ timeout: 20000 });
      mark('results');
      const found = (await first.innerText()).replace(/\s+/g, ' ');
      if (!found.startsWith(`${PLAYLIST.expect.title} ${PLAYLIST.expect.artist}`) || !found.includes(String(PLAYLIST.expect.year))) {
        throw new Error(`Eigen playlist: het eerste zoekresultaat is "${found}"`);
      }
      await hold(0.8);
      await tap(first, { lead: 0.5 });
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="pl-track"]').length === n, PLAYLIST.tracks.length + 1, { timeout: 8000 });
      mark('added');
      await hold(1.1);

      scene('pl2');
      await scrollTo(await pageTop(page.getByTestId('pl-tracks')) - 96, 0.9);
      const years = page.getByTestId('pl-year');
      const yFirst = await years.first().boundingBox(); const yLast = await years.last().boundingBox();
      const added = await page.getByTestId('pl-track').filter({ hasText: PLAYLIST.expect.title }).getByTestId('pl-year').inputValue();
      if (added !== String(PLAYLIST.expect.year)) problems.push(`eigen playlist: jaartal ${added} bij het toegevoegde nummer`);
      if (yLast.y + yLast.height > PHONE.height) problems.push('eigen playlist: de lijst met nummers past niet in beeld');
      ev.highlights.push({ t0: rel() + 0.4, t1: rel() + 2.9, x: yFirst.x - 4, y: yFirst.y - 4, width: yFirst.width + 8, height: yLast.y + yLast.height - yFirst.y + 8 });
      mark('years', 0.4);
      await hold(2.5);

      scene('pl3');
      await scrollTo(0, 0.7);
      await tap('pl-activate', { lead: 0.5 });
      await page.getByTestId('pl-is-active').waitFor({ timeout: 5000 });
      mark('active');
      await hold(1.6);
      await tap('pl-back', { lead: 0.4 });
      await page.getByTestId('screen-playlists').waitFor();
      await hold(0.5);
      await home(0.4);
    } else if (want('music')) {
      await home(0.4);
    }

    // --- slot ---
    scene('outro');
    // onderaan het startscherm staan de tip over het beginscherm en de gekozen muziek
    await page.getByTestId('deck-info').filter({ hasText: want('playlist') ? PLAYLIST.name : 'TimeTunesr-deck' }).waitFor();
    await scrollTo(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight), 0.7);
    await highlight(page.getByTestId('install-hint'), 0.5, 3.3);
    await hold(3.5);
    scene('end'); await hold(3.2);
    ev.duration = rel();

    for (const c of captures) await c.stop();
    ev.frames = Object.fromEntries([main, ...trio].map((p) => [p.key, p.cap.frames]));
    ev.config = { TABLE, DIGITAL, BINGO, MULTI, PLAYLIST, PUBLIC_URL, PHONE, SMALL_PHONE };
    ev.seed = seed;
    ev.only = ONLY;
    if (await page.evaluate(() => document.body.classList.contains('is-offline'))) problems.push('app meldde "offline"');
    if (problems.length) throw new Error(`Opname afgekeurd:\n- ${problems.join('\n- ')}`);
    writeFileSync(join(TMP, 'events.json'), JSON.stringify(ev));
    const n = Object.entries(ev.frames).map(([k, f]) => `${k} ${f.length}`).join(', ');
    if (ev.marks.playA) console.log(`wachttijd tot het fragment speelt: kaart 1 ${(ev.marks.playA - ev.scenes.find((s) => s.id === 's3').t).toFixed(2)} s, kaart 2 ${(ev.marks.playB - ev.marks.detectB).toFixed(2)} s`);
    console.log(`opname klaar: ${ev.duration.toFixed(1)} s, telefoonframes: ${n} -> ${join(TMP, 'events.json')}`);
    return ev;
  } finally {
    for (const c of captures) await c.stop().catch(() => {});
    await browser.close();
    server.stop();
    if (signal) await signal.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // process.exit: de lokale verbindingsserver houdt het proces anders open
  record().then(() => process.exit(0), (e) => { console.error(e.message || e); process.exit(1); });
}
