// Stap 1 van de Discobingo-video: bedien de echte app in real time en neem de schermen op.
// Een spelleider (laptop/tv, 1280 x 720) en twee spelers (telefoons, 390 x 850), elk een eigen browsercontext,
// echt met elkaar verbonden via de kamerserver (server/node.mjs). Per scherm komen verliesvrije PNG-frames
// binnen (../lib.mjs: capturePage) en events.json legt vast wanneer wat gebeurt: de montagelijst (edit),
// de tikken en de kaders. render.mjs maakt daar de video van.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, TV, PHONE, SEED, PLAYERS, SCRIPT, PUBLIC_URL } from './config.mjs';
import { startServer, launch, ensureDir, sleep, aliasPublic, capturePage } from '../lib.mjs';
import { serveDisco, fakeMusic } from './common.mjs';
import { simulate, winLineOf, fnFor } from './plan.mjs';
import { startRoomServer, phone as multiPhone, waitForPlayers } from '../../tests/e2e/multi-helpers.mjs';
import { artistVerdict, titleVerdict } from '../../app/js/multi/match.js';
import { decadeOf } from '../../app/js/multi/disco.js';

const USER_AGENT_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const USER_AGENT_TV = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TITLE_SECONDS = 3.6;
const END_SECONDS = 6.5;

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
  void artistVerdict; void titleVerdict;

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
      return { key, page: p.page, dims };
    };
    const host = await dev('host', TV, { seed: SEED, isMobile: false, hasTouch: false, userAgent: USER_AGENT_TV });
    const pa = await dev('a', PHONE, { userAgent: USER_AGENT_PHONE });
    const pb = await dev('b', PHONE, { userAgent: USER_AGENT_PHONE });
    const devs = [host, pa, pb];
    const players = [pa, pb];
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
    const seg = (id, opts = {}) => { ev.edit.push({ id, r0: rel(), speed: 1, ...opts }); console.log(`${rel().toFixed(2).padStart(7)}  ${id ?? '(wegknippen)'}${opts.speed ? ` x${opts.speed}` : ''}`); };
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
    const highlight = async (d, locator, from, to, pad = 6) => {
      const b = await locator.boundingBox();
      ev.highlights.push({ dev: d.key, t0: rel() + from, t1: rel() + to, x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad });
    };
    const type = async (d, testid, text) => {
      await tap(d, testid, { lead: 0.4 });
      await d.page.keyboard.type(text, { delay: 85 });
      await hold(0.3);
    };
    const locked = (d) => d.page.locator('[data-testid="disco-answer-state"][data-state="locked"]').waitFor({ timeout: 10000 });
    const pageText = (d) => d.page.evaluate(() => document.body.innerText);
    /** Tijdens het draaien en luisteren mag er niets van het nummer op een scherm staan. */
    const assertHidden = async (song, what) => {
      for (const d of devs) {
        const text = await pageText(d);
        for (const secret of [song.title, song.artist]) if (text.includes(secret)) problems.push(`antwoord zichtbaar voor de onthulling (${d.key}, ${what}): "${secret}"`);
        const y = new RegExp(`(^|[^0-9])${song.year}([^0-9]|$)`);
        const typed = Object.values(SCRIPT).flatMap((r) => Object.values(r)).map(String);
        if (y.test(text.replace(/\b(1980|1990|2014|2020)\b/g, '')) && !typed.includes(String(song.year))) {
          // het jaartal van een eerder gestempeld vakje kan toevallig gelijk zijn; alleen melden als het niet op de kaart staat
          const onCard = await d.page.evaluate((yr) => [...document.querySelectorAll('[data-testid^="disco-sq-"]')].some((e) => e.dataset.year === String(yr)), song.year);
          if (!onCard) problems.push(`jaartal zichtbaar voor de onthulling (${d.key}, ${what})`);
        }
      }
    };
    const hostSong = () => host.page.evaluate(() => window.__ttHost?.session?.currentSong() || null);
    const waitRound = (d, round) => d.page.waitForFunction(([r, isHost]) => {
      const v = isHost ? window.__ttHost?.session?.spectatorView() : window.__ttRoom?.session?.view;
      return v?.phase === 'answering' && v.game.round === r;
    }, [round, d === host], { timeout: 30000 });
    const landedAll = () => Promise.all(devs.map((d) => d.page.locator('[data-testid="disco-stage"][data-state="landed"]').waitFor({ timeout: 15000 })));
    const playing = () => host.page.waitForFunction(() => { const a = document.getElementById('player'); return a && !a.paused; }, null, { timeout: 8000 })
      .catch(() => problems.push('de muziek speelt niet bij de spelleider'));
    const view = (d) => d.page.evaluate(() => window.__ttRoom.session.view);
    const checkSong = async (i) => {
      const s = await hostSong();
      const want = sim.rounds[i].song;
      if (!s || String(s.id) !== String(want.id)) throw new Error(`ronde ${i + 1}: ander nummer dan gepland (${s?.id} in plaats van ${want.id})`);
      return s;
    };
    /** Welke velden van het vakje zijn aan te tikken: eerst de verwachte, anders het eerste open vakje van die kleur. */
    const choosable = async (d) => (await view(d)).game.disco.choosable;
    const stamp = async (d, i) => {
      await tap(d, d.page.locator(`[data-testid="disco-card"] [data-testid="disco-sq-${i}"]`), { lead: 0.45 });
      await d.page.waitForFunction((x) => window.__ttRoom.session.view.game.disco.choice === x, i, { timeout: 8000 });
    };
    const reveal = async () => {
      await tap(host, 'room-reveal', { lead: 0.5 });
      await Promise.all(devs.map((d) => d.page.locator(`[data-testid="screen-room-${d === host ? 'host' : 'player'}"][data-view="revealed"]`).waitFor({ timeout: 15000 })));
    };
    const nextRound = async (round) => {
      await tap(host, 'room-next', { lead: 0.5 });
      await host.page.waitForFunction((r) => { const s = window.__ttHost.session; return s.room.phase === 'won' || s.room.game.round > r; }, round, { timeout: 15000 });
    };

    // =============== het draaiboek ===============
    // titel: alleen het decor (geen opname nodig)
    ev.edit.push({ id: 'title', dur: TITLE_SECONDS });

    // --- 1. kamer maken en meedoen ---
    seg('room');
    await hold(0.7);
    await tap(host, 'start-host', { lead: 0.5 });
    await host.page.getByTestId('host-setup-form').waitFor();
    await hold(0.9);
    await tap(host, 'host-create', { lead: 0.5 });
    await host.page.locator('[data-testid="screen-room-host"][data-view="lobby"]').waitFor();
    await host.page.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 20000 });
    const code = (await host.page.getByTestId('room-code-big').textContent()).trim();
    ev.code = code;
    console.log('kamercode:', code);
    if ((await host.page.getByTestId('room-link').textContent()).trim() !== `${PUBLIC_URL}#/kamer/${code}`) problems.push('de link in de lobby is niet het publieke adres');
    await hold(1.3);
    await Promise.all(players.map(async (p, i) => {
      await hold(i * 0.7);
      await tap(p, 'start-join', { lead: 0.45 });
      await p.page.getByTestId('join-form').waitFor();
      await hold(0.3);
      await tap(p, 'join-code', { lead: 0.35 });
      await p.page.keyboard.type(code, { delay: 110 });
      await hold(0.2);
      await tap(p, 'join-name', { lead: 0.35 });
      await p.page.keyboard.type(PLAYERS[i], { delay: 70 });
      await hold(0.25);
      await tap(p, 'join-submit', { lead: 0.45 });
      await p.page.locator('[data-testid="screen-room-player"][data-view="lobby"]').waitFor({ timeout: 20000 });
    }));
    await waitForPlayers(host.page, 2);
    await hold(1.2);

    // --- 2. de lobby: Discobingo en "Winnen met" ---
    seg('lobby');
    if (!(await host.page.getByTestId('room-game-disco').isChecked())) problems.push('Discobingo staat niet standaard aan');
    await scrollTo(host, Math.max(0, (await topOf(host.page.getByTestId('room-disco-settings'))) - 330), 900);
    await hold(0.4);
    await highlight(host, host.page.getByTestId('room-disco-settings'), 0.2, 3.6, 8);
    await hold(3.6);
    if ((await host.page.getByTestId('room-disco-win-line1').isChecked?.().catch(() => true)) === false) problems.push('"Winnen met: 1 lijn" staat niet aan');
    await hold(0.4);

    // --- 3. de discobal ---
    await scrollTo(host, 0, 400);
    seg('spin');
    mark('start');
    // de bal is het paradepaardje: tijdens het draaien de beelden van de screencast zelf (30+ per seconde),
    // anders haalt een screenshot per scherm maar zo'n 14 per seconde (zie capturePage in ../lib.mjs)
    const smooth = (m) => Promise.all(devs.map((d) => d.cap.setMode(m)));
    await hold(0.3);
    await tap(host, 'room-start', { lead: 0.5 });
    await smooth('cast');
    await Promise.all(devs.map((d) => d.page.locator(`[data-testid="screen-room-${d === host ? 'host' : 'player'}"][data-view="answering"]`).waitFor({ timeout: 15000 })));
    mark('spinStart');
    await waitRound(host, 1);
    let song = await checkSong(0);
    await assertHidden(song, 'bal draait');
    await landedAll();
    mark('landed');
    await hold(2.2);
    await smooth('shot');
    await playing();
    await assertHidden(song, 'bal staat stil');

    // --- 4. de eigen kaart ---
    seg('card');
    await Promise.all(players.map(async (p) => scrollTo(p, Math.max(0, (await topOf(p.page.getByTestId('disco-card'))) - 100), 900)));
    await hold(0.5);
    for (const p of players) await highlight(p, p.page.getByTestId('disco-card'), 0.1, 5.0, 4);
    await hold(4.8);
    await assertHidden(song, 'kaart');

    // --- 5. antwoorden ---
    seg('answer');
    await Promise.all(players.map((p) => scrollTo(p, 0, 700)));
    await hold(0.9);
    await type(pa, 'disco-text-input', SCRIPT.r1.anouk);
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await hold(0.5);
    await type(pb, 'disco-text-input', SCRIPT.r1.bram);
    await tap(pb, 'disco-lock', { lead: 0.4 });
    await locked(pb);
    await host.page.waitForFunction(() => /2 van 2|Iedereen is klaar/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    await assertHidden(song, 'antwoorden');
    await hold(1.1);

    // --- 6. onthulling en een vakje kiezen ---
    seg('reveal');
    await hold(0.3);
    await reveal();
    mark('revealed');
    await hold(1.4);
    const verdictA = await pa.page.getByTestId('disco-verdict').getAttribute('data-verdict');
    if (verdictA !== 'right') problems.push(`Anouks typfout is ${verdictA} in plaats van goed`);
    const avoid = line.artist;
    const first = (await choosable(pa)).find((i) => i !== avoid);
    await stamp(pa, first);
    await hold(1.5);
    await stamp(pa, avoid);
    await hold(2.2);

    // --- 7. twijfel: de spelleider beslist ---
    seg('doubt');
    const verdictB = await pb.page.getByTestId('disco-verdict').getAttribute('data-verdict');
    if (verdictB !== 'doubt') problems.push(`Brams antwoord is ${verdictB} in plaats van twijfel`);
    await highlight(host, host.page.getByTestId('disco-doubts'), 0.2, 4.2, 6);
    await hold(3.6);
    const row = await host.page.locator('[data-testid="disco-doubts"] [data-testid="disco-regie-row"]').first().getAttribute('data-row');
    await tap(host, `disco-judge-good-${row}`, { lead: 0.6 });
    await pb.page.locator('[data-testid="disco-verdict"][data-verdict="right"]').waitFor({ timeout: 8000 });
    await hold(1.0);
    await stamp(pb, (await choosable(pb))[0]);
    await hold(1.6);
    await nextRound(1);

    // --- 8. jaartal ---
    seg('year', { speed: 2 });
    await smooth('cast');
    await Promise.all(devs.map((d) => waitRound(d, 2)));
    song = await checkSong(1);
    await landedAll();
    await hold(0.4);
    await smooth('shot');
    mark('landed2');
    seg('year');
    await playing();
    await assertHidden(song, 'ronde 2');
    await hold(0.6);
    await type(pa, 'disco-year-input', SCRIPT.r2.anouk);
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await type(pb, 'disco-year-input', SCRIPT.r2.bram);
    await tap(pb, 'disco-lock', { lead: 0.4 });
    await locked(pb);
    await hold(0.6);
    await reveal();
    await hold(1.1);
    if ((await pa.page.getByTestId('disco-verdict').getAttribute('data-verdict')) !== 'right') problems.push('jaartal 2 ernaast is niet goed gerekend');
    await stamp(pa, line.year);
    await hold(1.0);
    await nextRound(2);

    // --- 9. even later: ronde 3 snel ---
    seg('later', { speed: 3, label: 'Even later…' });
    await Promise.all(devs.map((d) => waitRound(d, 3)));
    song = await checkSong(2);
    await landedAll();
    await playing();
    await assertHidden(song, 'ronde 3');
    await hold(0.5);
    await type(pa, 'disco-text-input', SCRIPT.r3.anouk);
    await tap(pa, 'disco-lock', { lead: 0.4 });
    await locked(pa);
    await tap(pb, 'disco-pass', { lead: 0.4 });
    await hold(0.6);
    await reveal();
    await hold(1.0);
    await stamp(pa, line.title);
    await hold(1.0);
    await nextRound(3);
    await Promise.all(devs.map((d) => waitRound(d, 4)));
    song = await checkSong(3);

    // --- 10. ronde 4: decennium en bingo ---
    seg('bingo', { speed: 2 });
    await smooth('cast');
    await landedAll();
    await hold(0.4);
    await smooth('shot');
    seg('bingo');
    await playing();
    await assertHidden(song, 'ronde 4');
    await hold(0.5);
    await tap(pa, `disco-decade-${SCRIPT.r4.anouk}`, { lead: 0.45 });
    await locked(pa);
    await tap(pb, `disco-decade-${SCRIPT.r4.bram}`, { lead: 0.45 });
    await locked(pb);
    await hold(0.5);
    await reveal();
    await hold(1.3);
    await stamp(pa, line.decade);
    await pa.page.getByTestId('disco-bingo').waitFor({ timeout: 8000 });
    mark('bingo');
    await hold(3.8);
    const label = (await host.page.getByTestId('room-next').textContent()).trim();
    console.log('knop van de spelleider:', label);
    await tap(host, 'room-next', { lead: 0.6 });
    await Promise.all(devs.map((d) => d.page.locator(`[data-testid="screen-room-${d === host ? 'host' : 'player'}"][data-view="won"]`).waitFor({ timeout: 15000 })));
    mark('won');

    // --- 11. uitslag ---
    seg('win');
    await smooth('cast');
    await hold(5.0);
    ev.duration = rel();
    for (const c of captures) await c.stop();
    ev.edit.push({ id: 'end', dur: END_SECONDS });
    // beelden van de screenshot- en de screencast-modus kunnen elkaar om een paar ms inhalen: op tijd sorteren
    ev.frames = Object.fromEntries(devs.map((d) => [d.key, [...d.cap.frames].sort((x, y) => x[0] - y[0])]));
    ev.config = { TV, PHONE, SEED, PUBLIC_URL };
    for (const d of devs) {
      if (await d.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) problems.push(`${d.key}: pagina breder dan het scherm`);
    }
    // hoe vloeiend is de bal? aantal beelden per seconde van elk scherm tijdens het draaien van ronde 1
    for (const k of ['host', 'a', 'b']) {
      const f = ev.frames[k].filter(([t]) => t >= ev.marks.spinStart + 0.3 && t < ev.marks.landed);
      console.log(`beelden per seconde tijdens het draaien (${k}): ${(f.length / Math.max(0.1, ev.marks.landed - ev.marks.spinStart - 0.3)).toFixed(1)}`);
    }
    if (problems.length) throw new Error(`Opname afgekeurd:\n- ${problems.join('\n- ')}`);
    writeFileSync(join(TMP, 'events.json'), JSON.stringify(ev));
    console.log(`opname klaar: ${ev.duration.toFixed(1)} s, frames: ${Object.entries(ev.frames).map(([k, f]) => `${k} ${f.length}`).join(', ')}`);
    return ev;
  } finally {
    for (const c of captures) await c.stop().catch(() => {});
    await browser.close();
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
