// Full bingo game ("Alleen de app") on a phone until somebody has bingo, incl. reload and leak checks.
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, FIXTURE_DECK } from './helpers.mjs';

const deck = JSON.parse(FIXTURE_DECK);
const byId = new Map(deck.cards.map((c) => [c.id, c]));
const SEED = 7; // vaste zaaiwaarde: zelfde kaarten en zelfde volgorde van nummers

export default async function run() {
  const server = await startServer();
  const browser = await launch();
  try {
    const ctx = await phoneContext(browser);
    await useFixtureDeck(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());

    await page.goto(server.url);
    await page.evaluate((seed) => {
      localStorage.removeItem('timetunesr.bingo.v1');
      localStorage.setItem('timetunesr.bingoSeed.v1', String(seed));
    }, SEED);
    await page.getByTestId('start-bingo').click();
    await page.getByTestId('bingo-setup-form').waitFor();
    await page.getByTestId('bingo-player-name-0').fill('Anouk');
    await page.getByTestId('bingo-player-name-1').fill('Bram');
    await page.getByTestId('bingo-size-4').check();
    await shot(page, '50-bingo-setup');
    await page.getByTestId('bingo-start').click();
    await page.getByTestId('bingo-handoff').waitFor();
    await shot(page, '51-bingo-handoff');

    // Bingo logic straight from the app (same module as the page uses).
    const B = await import(new URL('../../app/js/bingo.js', import.meta.url).href);
    const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.bingo.v1')));
    const s0 = await state();
    assert(s0.seed === SEED && s0.size === 4, 'game uses the fixed seed and 4×4');
    assert(B.cardSignature(s0.players[0].card) !== B.cardSignature(s0.players[1].card), 'players get different cards');

    const covered = new Set(); // decade, period, year, judge-yes, judge-no
    let sawGood = false; let sawBad = false; let reloaded = false; let turns = 0; let checkedSize = false;
    while (turns < 60) {
      const view = await page.getByTestId('screen-bingo').getAttribute('data-view');
      if (view === 'won') break;
      if (view === 'handoff') {
        await page.getByTestId('bingo-start-turn').click();
        await page.locator('[data-view="claim"]').waitFor();
        continue;
      }
      if (view === 'claim') {
        const s = await state();
        const secret = byId.get(s.currentCard);
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        if (html.includes(secret.title) || html.includes(secret.artist) || html.includes(`data-card-id="${secret.id}"`)) {
          throw new Error('hidden song leaked in DOM');
        }
        if ((await page.getByTestId('answer-card').count()) !== 0) throw new Error('answer card visible before reveal');
        if (turns === 0) assert(true, 'claim screen: title, artist and card id of the hidden song are not in the DOM');
        if (!checkedSize) {
          const boxes = await page.locator('[data-testid^="bingo-cell-"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.width, r.height, r.right]));
          assert(boxes.length === 16 && boxes.every(([w, h, right]) => w >= 44 && h >= 44 && right <= 390), `4×4 cells are tappable on 390px (min ${Math.min(...boxes.map((b) => Math.min(b[0], b[1]))).toFixed(0)}px)`);
          checkedSize = true;
        }
        if (!reloaded && turns === 3) {
          await page.reload();
          await page.getByTestId('screen-bingo').waitFor();
          const v = await page.getByTestId('screen-bingo').getAttribute('data-view');
          const s2 = await state();
          assert(v === 'handoff' && s2.currentCard === s.currentCard && s2.current === s.current, 'reload mid-game keeps the game, player and hidden song');
          reloaded = true;
          continue;
        }
        const year = secret.year;
        const p = s.players[s.current];
        const open = p.card.map((k, i) => ({ k, i, kind: B.SQUARES[k].kind })).filter((o) => p.marks[o.i] == null);
        let pick; let guess = null; let judge = null;
        if (s.current === 0) {
          // Anouk speelt goed: kiest een vakje dat klopt, eerst soorten die nog niet getest zijn, anders naar de beste lijn.
          const ok = open.filter((o) => B.checkSquare(o.k, year, year) !== false);
          const fresh = ok.filter((o) => !covered.has(o.kind === 'artist' || o.kind === 'title' ? 'judge-yes' : o.kind));
          const lineScore = (i) => Math.max(...B.lines(4).filter((l) => l.includes(i)).map((l) => l.filter((j) => p.marks[j] != null).length));
          const pool = fresh.length ? fresh : ok;
          pick = pool.sort((a, b) => lineScore(b.i) - lineScore(a.i))[0] || open[0];
          guess = year + 1; judge = true;
        } else {
          // Bram zit er steeds naast: liefst artiest/titel (groep zegt "Niet goed"), anders ±2 met een fout jaartal.
          pick = open.find((o) => o.kind === 'artist' || o.kind === 'title') || open.find((o) => o.k === 'year') ||
            open.find((o) => B.checkSquare(o.k, year) === false) || open[0];
          guess = year + 9; judge = false;
        }
        await page.getByTestId(`bingo-cell-${pick.i}`).click();
        if (pick.k === 'year') {
          if (!(await page.getByTestId('bingo-confirm').isDisabled())) throw new Error('confirm enabled without a year');
          await page.getByTestId('bingo-year-input').fill(String(guess));
        }
        if (turns === 1) {
          await page.waitForFunction(() => document.querySelector('audio') && !document.querySelector('audio').paused, null, { timeout: 20000 }).catch(() => {});
          await shot(page, '52-bingo-claim');
        }
        await page.getByTestId('bingo-confirm').click();
        await page.locator('[data-view="reveal"]').waitFor();
        if (pick.kind === 'artist' || pick.kind === 'title') {
          const pending = (await page.getByTestId('bingo-result').getAttribute('data-correct')) === 'pending';
          if (!pending) throw new Error(`${pick.kind} claim should wait for the group`);
          if (!covered.has('pending')) { assert(true, `${pick.kind} claim waits for the group verdict`); covered.add('pending'); }
          if (!covered.has('judge-yes') && !covered.has('judge-no')) await shot(page, '53-bingo-judge');
          await page.getByTestId(judge ? 'bingo-judge-yes' : 'bingo-judge-no').click();
          covered.add(judge ? 'judge-yes' : 'judge-no');
        }
        const correct = await page.getByTestId('bingo-result').getAttribute('data-correct');
        const expected = pick.kind === 'artist' || pick.kind === 'title' ? judge : B.checkSquare(pick.k, year, pick.k === 'year' ? guess : null);
        if (String(expected) !== correct) throw new Error(`claim ${pick.k} for ${year} (guess ${guess}) shows ${correct}, expected ${expected}`);
        if (correct === 'true') {
          if (pick.kind !== 'artist' && pick.kind !== 'title') covered.add(pick.kind);
          const st = await page.getByTestId(`bingo-cell-${pick.i}`).getAttribute('data-state');
          if (st !== 'stamped') throw new Error('correct claim not stamped');
          if (!sawGood) { sawGood = true; await shot(page, '54-bingo-reveal-good'); }
        } else {
          const st = await page.getByTestId(`bingo-cell-${pick.i}`).getAttribute('data-state');
          if (st !== 'open') throw new Error('wrong claim did not stay open');
          if (pick.k === 'year') covered.add('year-wrong');
          if (!sawBad) { sawBad = true; await shot(page, '55-bingo-reveal-bad'); }
        }
        turns++;
        await page.getByTestId('bingo-next').click();
        continue;
      }
      throw new Error(`unexpected view ${view}`);
    }
    await page.getByTestId('bingo-winner').waitFor();
    const winner = await page.getByTestId('bingo-winner-name').textContent();
    assert(/Anouk heeft bingo/.test(winner), `winner screen: "${winner}" after ${turns} turns`);
    assert(sawGood && sawBad, 'saw both a correct and a wrong claim');
    for (const k of ['decade', 'period', 'year', 'judge-yes', 'judge-no']) assert(covered.has(k), `square type covered: ${k}`);
    const s = await state();
    const win = await page.locator('[data-testid="bingo-winner-card"] [data-win="true"]').count();
    assert(win === 4 && s.winLine.length === 4, `winning line of 4 highlighted (${win})`);
    assert((await page.locator('[data-testid^="bingo-card-of-"]').count()) === 2, 'all players\' cards can be viewed');
    await shot(page, '56-bingo-winner');

    // Herladen op het winnaarsscherm blijft het winnaarsscherm.
    await page.reload();
    await page.getByTestId('bingo-winner').waitFor();
    assert(true, 'winner screen survives reload');

    await page.getByTestId('bingo-again').click();
    await page.getByTestId('bingo-handoff').waitFor();
    const again = await state();
    assert(again.players.every((p) => p.marks.every((m) => m == null)) && again.players[0].name === 'Anouk', 'Nog een potje: same players, empty cards');
    await page.getByTestId('bingo-quit').click();
    await page.getByTestId('bingo-setup-form').waitFor();
    assert(await page.evaluate(() => localStorage.getItem('timetunesr.bingo.v1') === null), 'Stoppen clears the stored game');

    // Losse sleutels: het tijdlijnspel blijft onaangeroerd.
    assert(await page.evaluate(() => localStorage.getItem('timetunesr.game.v1') === null), 'bingo does not touch the timeline game state');

    // 3×3 kaart: snel potje start ook.
    await page.getByTestId('bingo-size-3').check();
    await page.getByTestId('bingo-start').click();
    await page.getByTestId('bingo-start-turn').click();
    assert((await page.locator('[data-testid^="bingo-cell-"]').count()) === 9, '3×3 card has 9 squares');
    await page.evaluate(() => { localStorage.removeItem('timetunesr.bingo.v1'); localStorage.removeItem('timetunesr.bingoSeed.v1'); });
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
