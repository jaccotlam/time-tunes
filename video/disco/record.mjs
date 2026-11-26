// Stap 1 van de Discobingo-video: bedien de echte app in real time en neem de schermen op.
// Vier echte schermen, echt met elkaar verbonden via de kamerserver (server/node.mjs):
//   - tab 1, de spelleider (laptop, 1280 x 720)   - tab 2, het grote scherm (#/scherm/CODE, tv, 1280 x 720; dit is
//     echt de tweede tab van dezelfde browser, geopend met de knop "Open het grote scherm")
//   - twee telefoons (390 x 850): Anouk en Bram, elk een eigen browsercontext.
// Per scherm komen verliesvrije frames binnen (../lib.mjs: capturePage) en events.json legt vast wanneer wat gebeurt:
// de montagelijst (edit, met de opstelling per stuk), de tikken en de kaders. render.mjs maakt daar de video van.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, TV, PHONE, SEED, PLAYERS, SCRIPT, PUBLIC_URL } from './config.mjs';
import { startServer, launch, ensureDir, sleep, aliasPublic, capturePage } from '../lib.mjs';
import { serveDisco, fakeMusic } from './common.mjs';
import { simulate, winLineOf, fnFor } from './plan.mjs';
import { startRoomServer, phone as multiPhone, waitForPlayers } from '../../tests/e2e/multi-helpers.mjs';
import { decadeOf } from '../../app/js/multi/disco.js';

const USER_AGENT_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const USER_AGENT_TV = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TITLE_SECONDS = 3.6;
const END_SECONDS = 8;

async function recordOnce() {
  const phoneDir = join(TMP, 'phone');
  rmSync(phoneDir, { recursive: true, force: true });
  ensureDir(phoneDir);

  // ---- draaiboek nagerekend met de regels van de app ----
  const sim = simulate(SEED, PLAYERS);
  const cats = sim.rounds.map((r) => r.cat);
  console.log('plan:', sim.rounds.map((r) => `${r.cat} ${r.song.artist} - ${r.song.title} (${r.song.year})`).join(' | '));
  if (cats.join() !== 'artist,year,title,decade') throw new Error(`Andere categorieën dan verwacht (${cats}); pas SEED of het draaiboek aan`);
  const line = winLineOf(sim.cards[0]);
  if (!line) throw new Error('Anouk heeft geen lijn door de ster met alle vier de kleuren');
  const [r1, r2, r3, r4] = sim.rounds.map((r) => r.song);
  const check = (cat, typed, song, want) => {
    const v = fnFor(cat)(typed, cat === 'artist' ? song.artist : song.title).verdict;
    if (v !== want) throw new Error(`"${typed}" geeft ${v} in plaats van ${want}`);
  };
  check('artist', SCRIPT.r1.anouk, r1, 'right'); check('artist', SCRIPT.r1.bram, r1, 'doubt'); check('title', SCRIPT.r3.anouk, r3, 'right');
  if (Math.abs(Number(SCRIPT.r2.anouk) - r2.year) > 2 || Math.abs(Number(SCRIPT.r2.bram) - r2.year) <= 2) throw new Error('jaartallen van ronde 2 kloppen niet met het draaiboek');
  if (decadeOf(r4.year) !== SCRIPT.r4.anouk) throw new Error('decennium van ronde 4 klopt niet');

  const server = await startServer();
  const rooms = await startRoomServer({ origins: `${new URL(PUBLIC_URL).origin},http://127.0.0.1:*` });
  const browser = await launch();
  const problems = [];
  const captures = [];
  try {
    const dev = async (key, dims, opts = {}) => {
      const p = await multiPhone(browser, rooms, {
        fixtureDeck: false, viewport: { width: dims.width, height: dims.height }, deviceScaleFactor: dims.scale, ...opts,
      });
      await aliasPublic(p.context, server);
      await fakeMusic(p.context);
      p.page.on('pageerror', (e) => problems.push(`paginafout (${key}): ${e.message}`));
      return { key, page: p.page, context: p.context, dims };
    };
    const host = await dev('host', TV, { seed: SEED, isMobile: false, hasTouch: false, userAgent: USER_AGENT_TV });
    const pa = await dev('a', PHONE, { userAgent: USER_AGENT_PHONE });
    const pb = await dev('b', PHONE, { userAgent: USER_AGENT_PHONE });
    const devs = [host, pa, pb]; // het grote scherm (tv) komt erbij zodra de spelleider het opent
    const players = [pa, pb];
    let tv = null;
    await Promise.all(devs.map(async (d) => {
      await d.page.goto(PUBLIC_URL);
      await d.page.getByTestId('screen-start').waitFor();
      await d.page.evaluate(() => document.fonts.ready);
    }));
    await sleep(500);

    // ---- opname van de schermen ----
    let T0 = Date.now() / 1000;
    const rel = () => Date.now() / 1000 - T0;
    for (const d of devs) { d.cap = await capturePage(d.page, join(phoneDir, d.key), 'f', rel, { castFormat: 'jpeg' }); captures.push(d.cap); }
    // De opname begint hier: het laatste beeld van de voorbereiding is het beginbeeld (t = 0). Even pauzeren,
    // zodat er geen beeld met de oude klok meer onderweg is (onder druk duurt de voorbereiding soms tientallen seconden).
    for (const c of captures) c.pause();
    await sleep(700);
    T0 = Date.now() / 1000;
    for (const c of captures) { c.frames.splice(0, c.frames.length - 1); c.frames[0][0] = 0; c.resetClock(); c.resume(); }
    await sleep(200);

    const ev = { edit: [], taps: [], highlights: [], marks: {}, players: PLAYERS, code: null };
    let layout = 'tabs';
    /** Een nieuw stuk van de montagelijst: scène-id, opstelling van de schermen en eventueel een snelheid. */
    const seg = (id, opts = {}) => {
      layout = opts.layout || layout;
      ev.edit.push({ id, r0: rel(), speed: 1, ...opts, layout });
      console.log(`${rel().toFixed(2).padStart(7)}  ${id}${opts.speed ? ` x${opts.speed}` : ''}  [${layout}]`);
    };
    const mark = (name) => { ev.marks[name] = rel(); };
    const hold = (s) => sleep(s * 1000);

    async function tap(d, target, { lead = 0.5 } = {}) {
      const loc = typeof target === 'string' ? d.page.getByTestId(target) : target;
      await loc.waitFor({ state: 'visible', timeout: 10000 });
      const box = await loc.boundingBox();
      const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      if (y < 0 || y > d.dims.height || x < 0 || x > d.dims.width) throw new Error(`doel van de tik staat buiten beeld (${d.key}: ${target})`);
      const e = { t: rel() + lead, x, y, lead, dev: d.key };
      ev.taps.push(e);
      await sleep(lead * 1000);
      e.t = rel();
      if (d === host) await d.page.mouse.click(x, y); else await d.page.touchscreen.tap(x, y);
    }
    /** Vloeiend scrollen (zonder vinger: de beweging is te zien aan de pagina zelf). */
    const scrollTo = (d, y, ms = 800) => d.page.evaluate(({ to, dur }) => new Promise((res) => {
      const a = window.scrollY; const t0 = performance.now();
      const io = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - ((-2 * p + 2) ** 3) / 2);
      (function step() {
        const p = Math.min(1, (performance.now() - t0) / dur);
        window.scrollTo(0, a + (to - a) * io(p));
        if (p < 1) requestAnimationFrame(step); else res();
      }());
    }), { to: y, dur: ms });
    const topOf = (loc) => loc.evaluate((e) => Math.round(e.getBoundingClientRect().top + window.scrollY));
    /** Scroll tot het doel midden in beeld staat (alleen als het er nu niet in past). */
    const reach = async (d, loc) => {
      await loc.waitFor({ state: 'attached', timeout: 10000 });
      const b = await loc.boundingBox();
      if (b && b.y >= 60 && b.y + b.height <= d.dims.height - 60) return;
      await scrollTo(d, Math.max(0, (await topOf(loc)) - d.dims.height / 2 + b.height / 2), 700);
      await hold(0.2);
    };
    const highlight = async (d, locator, from, to, pad = 6) => {
      const b = await locator.boundingBox();
      ev.highlights.push({ dev: d.key, t0: rel() + from, t1: rel() + to, x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad });
    };
    const type = async (d, testid, text) => {
      await tap(d, testid, { lead: 0.4 });
      await d.page.keyboard.type(text, { delay: 85 });
      await hold(0.3);
    };
    const pageText = (d) => d.page.evaluate(() => document.body.innerText);
    /** Tijdens het draaien en luisteren mag er niets van het nummer op een scherm staan (ook niet op de tv). */
    const assertHidden = async (song, what) => {
      for (const d of devs) {
        const text = await pageText(d);
        for (const secret of [song.title, song.artist]) if (text.includes(secret)) problems.push(`antwoord zichtbaar voor de onthulling (${d.key}, ${what}): "${secret}"`);
        const y = new RegExp(`(^|[^0-9])${song.year}([^0-9]|$)`);
        const typed = Object.values(SCRIPT).flatMap((r) => Object.values(r)).map(String);
        if (y.test(text) && !typed.includes(String(song.year))) {
          // het jaartal van een eerder gestempeld vakje kan toevallig gelijk zijn; alleen melden als het niet op de kaart staat
          const onCard = await d.page.evaluate((yr) => [...document.querySelectorAll('[data-testid^="disco-sq-"]')].some((e) => e.dataset.year === String(yr)), song.year);
          if (!onCard) problems.push(`jaartal zichtbaar voor de onthulling (${d.key}, ${what})`);
        }
      }
    };
    const viewOf = (d) => d.page.evaluate(() => (window.__ttRoom ? window.__ttRoom.session.view : window.__ttScreen ? window.__ttScreen.session.view : window.__ttHost?.session?.spectatorView()));
    const hostSong = () => host.page.evaluate(() => window.__ttHost?.session?.currentSong() || null);
    const waitRound = (d, round) => d.page.waitForFunction((r) => {
      const v = window.__ttHost ? window.__ttHost.session.spectatorView() : window.__ttScreen ? window.__ttScreen.session.view : window.__ttRoom?.session?.view;
      return v?.phase === 'answering' && v.game.round === r;
    }, round, { timeout: 30000 });
    const everyone = () => devs;
    const landedAll = () => Promise.all([
      ...[host, pa, pb].map((d) => d.page.locator('[data-testid="disco-stage"][data-state="landed"]').waitFor({ timeout: 15000 })),
      tv.page.locator('[data-testid="screen-display"][data-moment="listen"]').waitFor({ timeout: 15000 }),
    ]);
    const moment = (d, m) => d.page.locator(`[data-testid="disco-moment"][data-moment="${m}"]`).waitFor({ timeout: 15000 });
    const playing = () => host.page.waitForFunction(() => { const a = document.getElementById('player'); return a && !a.paused; }, null, { timeout: 8000 })
      .catch(() => problems.push('de muziek speelt niet bij de spelleider'));
    const checkSong = async (i) => {
      const s = await hostSong();
      const want = sim.rounds[i].song;
      if (!s || String(s.id) !== String(want.id)) throw new Error(`ronde ${i + 1}: ander nummer dan gepland (${s?.id} in plaats van ${want.id})`);
      return s;
    };
    const choosable = async (d) => (await viewOf(d)).game.disco.choosable;
    const stamp = async (d, i) => {
      await tap(d, d.page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${i}"]`), { lead: 0.45 });
      await d.page.waitForFunction((x) => window.__ttRoom.session.view.game.disco.choice === x, i, { timeout: 8000 });
    };
    const locked = (d) => moment(d, 'submitted');
    /** Alle schermen schakelen voor de bal (en het winnaarscherm) naar de beelden van de screencast zelf. */
    const smooth = (m) => Promise.all(devs.map((d) => d.cap.setMode(m)));
    const reveal = async () => {
      await tap(host, 'room-reveal', { lead: 0.5 });
      await Promise.all([
        ...[host, pa, pb].filter((d) => d !== pb || !pb.away).map((d) => d.page.locator(`[data-testid="screen-room-${d === host ? 'host' : 'player'}"][data-view="revealed"]`).waitFor({ timeout: 15000 })),
        tv.page.locator('[data-testid="screen-display"][data-phase="revealed"]').waitFor({ timeout: 15000 }),
      ]);
    };
    const nextRound = async (round) => {
      await reach(host, host.page.getByTestId('room-next'));
      await tap(host, 'room-next', { lead: 0.5 });
      await host.page.waitForFunction((r) => { const s = window.__ttHost.session; return s.room.phase === 'won' || s.room.game.round > r; }, round, { timeout: 15000 });
    };

    // =============== het draaiboek ===============
    // titel: alleen het decor (geen opname nodig)
    ev.edit.push({ id: 'title', dur: TITLE_SECONDS, layout });

    // --- 1. kamer maken (tab 1) ---
    seg('room', { layout: 'tabs' });
    await hold(0.8);
    await tap(host, 'start-host', { lead: 0.5 });
    await host.page.getByTestId('host-setup-form').waitFor();
    await hold(1.0);
    await tap(host, 'host-create', { lead: 0.5 });
    await host.page.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    await host.page.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 20000 });
    const code = (await host.page.getByTestId('room-code-big').textContent()).trim();
    ev.code = code;
    console.log('kamercode:', code);
    if ((await host.page.getByTestId('room-link').textContent()).trim() !== `${PUBLIC_URL}#/kamer/${code}`) problems.push('de link in de lobby is niet het publieke adres');
    await hold(1.6);

    // --- 2. het grote scherm in een tweede tab ---
    seg('tabs', { layout: 'tabs' });
    const openBtn = host.page.getByTestId('host-open-screen');
    await reach(host, openBtn);
    await highlight(host, openBtn, 0.1, 3.4, 8);
    await hold(2.2);
    const href = await openBtn.getAttribute('href');
    if (!href.endsWith(`#/scherm/${code}`)) problems.push(`"Open het grote scherm" wijst naar ${href}`);
    const opened = host.context.waitForEvent('page');
    await tap(host, openBtn, { lead: 0.6 });
    const tvPage = await opened;
    await tvPage.setViewportSize({ width: TV.width, height: TV.height });
    tvPage.on('pageerror', (e) => problems.push(`paginafout (tv): ${e.message}`));
    await tvPage.locator('[data-testid="screen-display"][data-status="online"][data-phase="lobby"]').waitFor({ timeout: 20000 });
    await tvPage.evaluate(() => document.fonts.ready);
    tv = { key: 'tv', page: tvPage, context: host.context, dims: TV };
    devs.push(tv);
    tv.cap = await capturePage(tvPage, join(phoneDir, 'tv'), 'f', rel, { castFormat: 'jpeg' });
    captures.push(tv.cap);
    mark('tvOpen');
    await hold(0.5);
    await host.page.locator('[data-testid="host-screen-connected"]').waitFor({ timeout: 10000 });
    if (!(await tvPage.getByTestId('screen-code').getAttribute('aria-label')).replace(/\s/g, '').endsWith(code) || !(await tvPage.getByTestId('screen-qr').isVisible())) problems.push('de tv toont de code of de QR-code niet');
    await hold(4.2);

    // --- 3. meedoen: code en QR op de tv, de nieuwe meedoen-pagina op de telefoon ---
    seg('join', { layout: 'play' });
    await hold(1.0);
    const joiner = async (p, i) => {
      await tap(p, 'start-join', { lead: 0.45 });
      await p.page.getByTestId('join-form').waitFor();
      await hold(0.5);
      await tap(p, 'join-code', { lead: 0.35 });
      await p.page.keyboard.type(code, { delay: 150 });
      await hold(0.5);
      await tap(p, 'join-name', { lead: 0.35 });
      await p.page.keyboard.type(PLAYERS[i], { delay: 90 });
      await hold(0.4);
      await tap(p, 'join-submit', { lead: 0.45 });
      await p.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
    };
    await joiner(pa, 0);
    await hold(1.6);
    await joiner(pb, 1);
    await waitForPlayers(host.page, 2);
    await tv.page.waitForFunction(() => document.querySelector('[data-testid="screen-count"]')?.dataset.count === '2', null, { timeout: 10000 });
    await hold(2.4);

    // --- 4. de discobal ---
    seg('spin', { layout: 'play' });
    mark('start');
    const startBtn = host.page.getByTestId('room-start');
    await reach(host, startBtn);
    await highlight(host, startBtn, 0.1, 1.2, 8);
    await hold(0.6);
    await smooth('cast');
    await tap(host, 'room-start', { lead: 0.6 });
    await tv.page.locator('[data-testid="screen-display"][data-phase="answering"]').waitFor({ timeout: 15000 });
    mark('spinStart');
    await Promise.all(devs.map((d) => waitRound(d, 1)));
    let song = await checkSong(0);
    await assertHidden(song, 'bal draait');
    await landedAll();
    mark('landed');
    await hold(2.4);
    await smooth('shot');
    await playing();
    await assertHidden(song, 'bal staat stil');

    // --- 5. antwoorden: een vraag, een invulveld, Indienen ---
    seg('answer', { layout: 'play' });
    await moment(pa, 'question');
    await hold(0.9);
    await type(pa, 'disco-text-input', SCRIPT.r1.anouk);
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await hold(1.3);
    await moment(pb, 'question');
    await type(pb, 'disco-text-input', SCRIPT.r1.bram);
    await tap(pb, 'disco-lock', { lead: 0.4 });
    await locked(pb);
    await tv.page.waitForFunction(() => document.querySelector('[data-testid="screen-count"]')?.dataset.done === '2', null, { timeout: 8000 }).catch(() => problems.push('de tv toont niet dat iedereen heeft geantwoord'));
    await assertHidden(song, 'antwoorden');
    await hold(1.6);

    // --- 6. onthullen, het oordeel, een vakje kiezen ---
    seg('reveal', { layout: 'play' });
    await hold(0.2);
    await reveal();
    mark('revealed');
    await hold(1.8);
    const verdictA = await pa.page.getByTestId('disco-verdict').getAttribute('data-verdict');
    if (verdictA !== 'right') problems.push(`Anouks typfout is ${verdictA} in plaats van goed`);
    if (!(await tv.page.getByTestId('screen-song').isVisible())) problems.push('de tv toont het nummer niet na de onthulling');
    await hold(2.2);
    seg('chip', { layout: 'play' });
    await moment(pa, 'choose');
    await hold(0.8);
    const first = (await choosable(pa)).find((i) => i !== line.artist);
    await stamp(pa, first);
    await hold(1.6);
    await stamp(pa, line.artist);
    await hold(2.0);

    // --- 7. twijfel: de spelleider beslist (tab 1 groot) ---
    seg('doubt', { layout: 'host' });
    const verdictB = await pb.page.getByTestId('disco-verdict').getAttribute('data-verdict');
    if (verdictB !== 'doubt') problems.push(`Brams antwoord is ${verdictB} in plaats van twijfel`);
    const doubts = host.page.getByTestId('disco-doubts');
    await reach(host, doubts);
    await hold(0.5);
    await highlight(host, doubts, 0.2, 4.2, 6);
    await hold(4.0);
    const row = await host.page.locator('[data-testid="disco-doubts"] [data-testid="disco-regie-row"]').first().getAttribute('data-row');
    await tap(host, `disco-judge-good-${row}`, { lead: 0.7 });
    await pb.page.locator('[data-testid="disco-verdict"][data-verdict="right"]').waitFor({ timeout: 8000 });
    await tv.page.waitForFunction(() => document.querySelector('[data-testid="screen-results"]')?.dataset.doubts === '0', null, { timeout: 8000 }).catch(() => {});
    await hold(2.6);
    await moment(pb, 'choose');
    await stamp(pb, (await choosable(pb))[0]);
    await hold(1.2);
    await nextRound(1);

    // --- 8. jaartal: 2 ernaast mag ---
    seg('year', { layout: 'play', speed: 2 });
    await smooth('cast');
    await Promise.all(devs.map((d) => waitRound(d, 2)));
    song = await checkSong(1);
    await landedAll();
    await hold(0.4);
    await smooth('shot');
    mark('landed2');
    seg('year', { layout: 'play' });
    await playing();
    await assertHidden(song, 'ronde 2');
    await moment(pa, 'question');
    await hold(0.6);
    await type(pa, 'disco-year-input', SCRIPT.r2.anouk);
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await moment(pb, 'question');
    await type(pb, 'disco-year-input', SCRIPT.r2.bram);
    await tap(pb, 'disco-lock', { lead: 0.4 });
    await locked(pb);
    await hold(0.5);
    await reveal();
    await hold(0.6);
    if ((await pa.page.getByTestId('disco-verdict').getAttribute('data-verdict')) !== 'right') problems.push('jaartal 2 ernaast is niet goed gerekend');
    await hold(2.4);
    await moment(pa, 'choose');
    await stamp(pa, line.year);
    await hold(1.4);
    await nextRound(2);

    // --- 9. weggaan en terugkomen: Bram verlaat de kamer midden in ronde 3 ---
    seg('leave', { layout: 'leave', speed: 2 });
    await smooth('cast');
    await Promise.all(devs.map((d) => waitRound(d, 3)));
    song = await checkSong(2);
    await landedAll();
    await hold(0.3);
    await smooth('shot');
    seg('leave', { layout: 'leave' });
    await playing();
    await assertHidden(song, 'ronde 3');
    await moment(pb, 'question');
    await hold(1.0);
    await tap(pb, 'disco-menu', { lead: 0.5 });
    await hold(0.9);
    await tap(pb, 'room-leave', { lead: 0.5 });
    await hold(0.9);
    await tap(pb, 'disco-leave-yes', { lead: 0.6 });
    pb.away = true;
    await tv.page.locator('[data-testid="screen-player"][data-name="Bram"][data-online="false"]').waitFor({ timeout: 10000 }).catch(() => problems.push('de tv toont Bram niet als weg'));
    await pb.page.getByTestId('room-back-to-seat').waitFor({ timeout: 10000 });
    await hold(2.4);
    // het spel wacht niet: Anouk antwoordt alleen, de spelleider onthult
    seg('leave', { layout: 'play' });
    await moment(pa, 'question');
    await type(pa, 'disco-text-input', SCRIPT.r3.anouk);
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await hold(1.4);
    await reveal();
    mark('revealed3');
    await hold(1.2);

    // --- 10. Bram komt terug ---
    seg('back', { layout: 'leave' });
    await hold(0.8);
    await tap(pb, 'room-back-to-seat', { lead: 0.6 });
    await pb.page.waitForFunction(() => !!window.__ttRoom?.session?.view?.game?.mine, null, { timeout: 15000 });
    pb.away = false;
    await tv.page.locator('[data-testid="screen-player"][data-name="Bram"][data-online="true"]').waitFor({ timeout: 10000 }).catch(() => problems.push('Bram is op de tv niet terug'));
    await hold(3.2);
    const cardB = await pb.page.evaluate(() => JSON.stringify(window.__ttRoom.session.view.game.mine.card));
    void cardB;

    // --- 11. spannend: de stand op de tv ---
    seg('close', { layout: 'play' });
    await moment(pa, 'choose').catch(() => {});
    await hold(0.8);
    await stamp(pa, line.title);
    await hold(1.4);
    await tv.page.locator('[data-testid="screen-display"][data-moment="ranking"]').waitFor({ timeout: 20000 });
    mark('ranking');
    const reason = await tv.page.getByTestId('screen-ranking').getAttribute('data-reason');
    if (reason !== 'close') problems.push(`de stand op de tv komt door "${reason}" in plaats van "close"`);
    await hold(4.6);
    await nextRound(3);

    // --- 12. de laatste ronde: bingo ---
    seg('bingo', { layout: 'play', speed: 2 });
    await smooth('cast');
    await Promise.all(devs.map((d) => waitRound(d, 4)));
    song = await checkSong(3);
    await landedAll();
    await hold(0.4);
    await smooth('shot');
    seg('bingo', { layout: 'play' });
    await playing();
    await assertHidden(song, 'ronde 4');
    await moment(pa, 'question');
    await hold(0.5);
    await tap(pa, `disco-decade-${SCRIPT.r4.anouk}`, { lead: 0.45 });
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await moment(pb, 'question');
    await tap(pb, `disco-decade-${SCRIPT.r4.bram}`, { lead: 0.45 });
    await tap(pb, 'disco-lock', { lead: 0.4 });
    await locked(pb);
    await hold(0.5);
    await reveal();
    await hold(1.0);
    await moment(pa, 'choose');
    await hold(0.8);
    await stamp(pa, line.decade);
    await pa.page.getByTestId('disco-bingo').first().waitFor({ timeout: 8000 });
    mark('bingo');
    await hold(4.2);
    await reach(host, host.page.getByTestId('room-next'));
    console.log('knop van de spelleider:', (await host.page.getByTestId('room-next').textContent()).trim());
    await tap(host, 'room-next', { lead: 0.6 });
    await Promise.all(everyone().map((d) => d.page.locator(d === tv ? '[data-testid="screen-display"][data-phase="won"]' : `[data-testid="screen-room-${d === host ? 'host' : 'player'}"][data-view="won"]`).waitFor({ timeout: 15000 })));
    mark('won');

    // --- 13. de winnaar ---
    seg('win', { layout: 'play' });
    await smooth('cast');
    await hold(6.0);
    ev.duration = rel();
    for (const c of captures) await c.stop();
    ev.edit.push({ id: 'end', dur: END_SECONDS, layout });
    // beelden van de screenshot- en de screencast-modus kunnen elkaar om een paar ms inhalen: op tijd sorteren
    ev.frames = Object.fromEntries(devs.map((d) => [d.key, [...d.cap.frames].sort((x, y) => x[0] - y[0])]));
    ev.config = { TV, PHONE, SEED, PUBLIC_URL };
    for (const d of devs) {
      if (await d.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) problems.push(`${d.key}: pagina breder dan het scherm`);
    }
    // hoe vloeiend is de bal? aantal beelden per seconde van elk scherm tijdens het draaien van ronde 1
    for (const k of ['host', 'tv', 'a', 'b']) {
      const f = ev.frames[k].filter(([t]) => t >= ev.marks.spinStart + 0.3 && t < ev.marks.landed);
      console.log(`beelden per seconde tijdens het draaien (${k}): ${(f.length / Math.max(0.1, ev.marks.landed - ev.marks.spinStart - 0.3)).toFixed(1)}`);
    }
    if (problems.length) throw new Error(`Opname afgekeurd:\n- ${problems.join('\n- ')}`);
    writeFileSync(join(TMP, 'events.json'), JSON.stringify(ev));
    console.log(`opname klaar: ${ev.duration.toFixed(1)} s, frames: ${Object.entries(ev.frames).map(([k, f]) => `${k} ${f.length}`).join(', ')}`);
    return ev;
  } catch (e) {
    console.error('FOUT:', e.message);
    throw e;
  } finally {
    for (const c of captures) await Promise.race([c.stop().catch(() => {}), sleep(5000)]);
    await Promise.race([browser.close().catch(() => {}), sleep(10000)]);
    server.stop();
    await rooms.stop();
  }
}

/** Een opname die met `retry` afbreekt, wordt opnieuw geprobeerd (hoogstens acht keer). */
export async function record() {
  for (let attempt = 1; ; attempt++) {
    try { return await recordOnce(); } catch (e) {
      if (!e.retry || attempt >= 8) throw e;
      console.log(`${e.message}: opnieuw (poging ${attempt + 1})`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  record().then(() => process.exit(0), (e) => { console.error(e.message || e); process.exit(1); });
}
