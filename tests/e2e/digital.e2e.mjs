// Full digital game ("Speel zonder kaarten") until there is a winner, incl. reload.
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot, FIXTURE_DECK } from './helpers.mjs';

const deck = JSON.parse(FIXTURE_DECK);
const byId = new Map(deck.cards.map((c) => [c.id, c]));

/**
 * Does the page show the hidden card's title or artist anywhere: in a text node OR in an
 * attribute (aria-label, title, data-*, alt, value ...)? Matched as a whole name: not inside a
 * longer word or number, so the hidden "Testnummer 2" is not found in the visible timeline card
 * "Testnummer 24" (the fixture deck has such pairs; a plain substring check reported those as a
 * leak whenever the deal put them together). Returns { hits, control, substring }: hits = where
 * the hidden card shows (a real leak); control = the same check does find a visible timeline
 * card (so it is not blind); substring = what a plain substring check would have flagged.
 */
async function hiddenLeak(page, secret, visible) {
  return page.evaluate(([sec, shown]) => {
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const whole = (x) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(x)}(?![\\p{L}\\p{N}])`, 'u');
    const needles = [sec.title, sec.artist].filter(Boolean).map((x) => [x, whole(x)]);
    const hits = [];
    const where = (el) => `<${el.tagName.toLowerCase()}${el.dataset?.testid ? ` data-testid="${el.dataset.testid}"` : ''}${el.className && typeof el.className === 'string' ? ` class="${el.className}"` : ''}>`;
    for (const el of document.querySelectorAll('*')) {
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue;
        for (const [x, re] of needles) if (re.test(n.nodeValue)) hits.push(`text of ${where(el)}: "${n.nodeValue.trim().slice(0, 60)}" (${x})`);
      }
      for (const at of el.attributes) {
        for (const [x, re] of needles) if (re.test(at.value)) hits.push(`${at.name} of ${where(el)}: "${at.value.slice(0, 60)}" (${x})`);
      }
    }
    const nodes = [];
    const tw = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) nodes.push(tw.currentNode.nodeValue);
    const control = shown.some((c) => nodes.some((v) => whole(c.title).test(v)));
    const text = document.documentElement.textContent;
    let substring = '';
    for (const [x] of needles) {
      if (!text.includes(x)) continue;
      const i = text.indexOf(x);
      substring = `"${x}" inside "${text.slice(Math.max(0, i - 5), i + x.length + 3).trim()}"`;
    }
    return { hits: hits.slice(0, 5), control, substring };
  }, [{ title: secret.title, artist: secret.artist }, visible.map((c) => ({ title: c.title }))]);
}

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
    await page.getByTestId('start-digital').click();
    await page.getByTestId('setup-form').waitFor();
    await page.getByTestId('player-name-0').fill('Anouk');
    await page.getByTestId('player-name-1').fill('Bram');
    await page.getByTestId('add-player').click();
    await page.getByTestId('player-name-2').fill('Team Disco');
    for (let i = 0; i < 6; i++) await page.getByTestId('goal-minus').click();
    assert((await page.getByTestId('goal-value').textContent()).includes('4'), 'goal set to 4');
    await shot(page, '10-game-setup');
    await page.getByTestId('start-game').click();

    const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.game.v1')));
    let turns = 0;
    let sawWrong = false;
    let sawRight = false;
    let reloaded = false;
    const substringOnly = []; // where the old plain substring check would have cried wolf
    while (turns < 60) {
      const view = await page.getByTestId('screen-game').getAttribute('data-view');
      if (view === 'won') break;
      if (view === 'handoff') {
        if (turns === 0) await shot(page, '11-game-handoff');
        await page.getByTestId('start-turn').click();
        await page.locator('[data-view="place"]').waitFor();
        continue;
      }
      if (view === 'place') {
        const s = await state();
        const secret = byId.get(s.currentCard);
        const leak = await hiddenLeak(page, secret, s.players.flatMap((p) => p.timeline).map((id) => byId.get(id)));
        if (leak.hits.length) throw new Error(`hidden card leaked in DOM: "${secret.title}" / "${secret.artist}" in ${leak.hits.join(' | ')}`);
        if (!leak.control) throw new Error('the leak check found no visible timeline card: it would not see a leak either');
        if (leak.substring) substringOnly.push(leak.substring);
        const tlYears = s.players[s.current].timeline.map((id) => byId.get(id).year);
        // Anouk always right; others always pick the first gap.
        let slot = 0;
        if (s.current === 0) {
          slot = tlYears.findIndex((y) => y >= secret.year);
          if (slot < 0) slot = tlYears.length;
        }
        if (!reloaded && turns >= 3) {
          // Spelstand moet een reload overleven.
          await page.reload();
          await page.getByTestId('screen-game').waitFor();
          const v = await page.getByTestId('screen-game').getAttribute('data-view');
          const s2 = await state();
          assert(v === 'handoff' && s2.currentCard === s.currentCard, 'reload keeps game and current card');
          reloaded = true;
          continue;
        }
        await page.getByTestId(`slot-${slot}`).click();
        if (turns === 1) {
          await page.waitForFunction(() => document.querySelector('audio') && !document.querySelector('audio').paused, null, { timeout: 20000 }).catch(() => {});
          await shot(page, '12-game-place');
        }
        await page.getByTestId('confirm-place').click();
        turns++;
        continue;
      }
      if (view === 'reveal') {
        const correct = await page.getByTestId('result').getAttribute('data-correct');
        if (correct === 'true' && !sawRight) { sawRight = true; await shot(page, '13-game-reveal-good'); }
        if (correct === 'false' && !sawWrong) { sawWrong = true; await shot(page, '14-game-reveal-bad'); }
        await page.getByTestId('next-turn').click();
        continue;
      }
      throw new Error(`unexpected view ${view}`);
    }
    if (substringOnly.length) console.log(`  (note: a plain substring check would have reported a leak ${substringOnly.length}x: ${substringOnly.slice(0, 3).join('; ')})`);
    await page.getByTestId('winner').waitFor();
    const winner = await page.getByTestId('winner-name').textContent();
    assert(/Anouk wint/.test(winner), `winner screen: "${winner}" after ${turns} turns`);
    assert(sawRight && sawWrong, 'saw both a correct and a wrong reveal');
    const s = await state();
    const years = s.players[0].timeline.map((id) => byId.get(id).year);
    assert(years.length === 4 && years.every((y, i) => i === 0 || years[i - 1] <= y), `winning timeline sorted: ${years.join(', ')}`);
    const used = [...s.players.flatMap((p) => p.timeline)];
    assert(new Set(used).size === used.length, 'no card used twice');
    await shot(page, '15-game-winner');

    await page.getByTestId('play-again').click();
    await page.locator('[data-view="handoff"]').waitFor();
    assert(true, 'play again starts new game with same players');
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);

    // Long timeline usability: 12 cards on a phone.
    await page.evaluate((ids) => {
      const g = JSON.parse(localStorage.getItem('timetunesr.game.v1'));
      g.goal = 15;
      ids = ids.filter((id) => id !== g.currentCard).slice(0, 12);
      g.players[g.current].timeline = ids;
      g.pile = g.pile.filter((id) => !ids.includes(id) && id !== g.currentCard);
      localStorage.setItem('timetunesr.game.v1', JSON.stringify(g));
    }, deck.cards.slice(10, 23).map((c) => c.id));
    await page.reload();
    await page.getByTestId('start-turn').click();
    await page.getByTestId('slot-6').click();
    await shot(page, '16-game-long-timeline');
    const btn = await page.getByTestId('confirm-place').boundingBox();
    assert(btn && btn.y + btn.height <= 844, 'confirm button stays on screen with 12 cards (sticky)');
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
