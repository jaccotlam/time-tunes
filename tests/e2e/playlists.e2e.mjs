// Own playlists ("Eigen playlist") on a phone, against a fake iTunes:
// create, search + add, paste a list (with a line that is not found and one doubt),
// correct a year, activate, play Tijdlijn and a Bingo turn with only own songs (no leaks),
// switch decks during a running game, print + decode a QR and play it on "another phone",
// share via link to a clean browser, export/import, a big playlist (50+ songs, split QR),
// and back to the built-in deck.
import { readFileSync } from 'node:fs';
import { launch, phoneContext, startServer, useFixtureDeck, assert, shot } from './helpers.mjs';
import { installFakeItunes, decodeQr, CATALOG } from './fake-itunes.mjs';

const L = await import(new URL('../../app/js/playlist-logic.js', import.meta.url).href);
const PLAYLIST_KEY = 'timetunesr.playlists.v1';
const GAP_KEY = 'timetunesr.itunesGap.v1';

async function newPhone(browser, { gap = 30 } = {}) {
  const ctx = await phoneContext(browser);
  await useFixtureDeck(ctx);
  const stats = await installFakeItunes(ctx);
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, [GAP_KEY, String(gap)]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  return { ctx, page, stats, errors };
}

async function holdReveal(page) {
  const box = await page.getByTestId('reveal-hold').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1750);
  await page.mouse.up();
  await page.getByTestId('answer').waitFor();
}

const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PLAYLIST_KEY);
const noHorizontalScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

export default async function run() {
  const port = 8300 + Math.floor(Math.random() * 90);
  const server = await startServer(port);
  const base = server.url;
  const browser = await launch();
  try {
    const A = await newPhone(browser);
    const { page } = A;

    // ---------- start screen -> playlists ----------
    await page.goto(base);
    await page.waitForFunction(() => /Muziek: TimeTunesr-deck · 30 kaarten/.test(document.querySelector('[data-testid="deck-info"]').textContent));
    assert(true, 'start: deck line shows the built-in deck');
    await page.getByTestId('deck-info').click();
    await page.getByTestId('screen-playlists').waitFor();
    assert(await page.locator('[data-testid="deck-option"][data-deck-id="builtin"].is-active').count() === 1, 'built-in deck is active');
    await shot(page, 'pl-80-playlists-empty');

    await page.getByTestId('playlist-new-name').fill('Feest bij Sanne');
    await page.getByTestId('playlist-create').click();
    await page.getByTestId('screen-playlist').waitFor();
    const plId = await page.getByTestId('screen-playlist').getAttribute('data-id');
    assert(await page.getByTestId('pl-name').textContent() === 'Feest bij Sanne', 'playlist created and opened');
    assert(await page.getByTestId('pl-too-small').isVisible(), 'empty playlist: too-small message');

    // ---------- search: debounce, karaoke down, year from the earliest same recording ----------
    await page.getByTestId('pl-search-input').pressSequentially('abba dancing', { delay: 60 });
    await page.locator('[data-testid="pl-search-result"]').first().waitFor();
    assert(A.stats.search.length === 1 && A.stats.search[0] === 'abba dancing', `typing sends one request (${A.stats.search.join(' | ')})`);
    const ids = await page.locator('[data-testid="pl-search-result"]').evaluateAll((els) => els.map((e) => Number(e.dataset.itunesId)));
    const karaoke = CATALOG.find((s) => /Karaoke/.test(s.trackName)).trackId;
    assert(ids.at(-1) === karaoke, 'karaoke version sorted to the bottom');
    await shot(page, 'pl-81-playlist-search');
    await page.locator('[data-testid="pl-search-result"]').first().click(); // "ABBA Gold" (1992)
    await page.locator('[data-testid="pl-track"]').first().waitFor();
    let pl = (await stored(page)).lists[0];
    assert(pl.tracks[0].title === 'Dancing Queen' && pl.tracks[0].year === 1976, `compilation (1992) -> earliest same recording: ${pl.tracks[0].year}`);
    assert(await page.locator('[data-testid="pl-search-result"].is-added').count() === 1, 'added result is marked');

    await page.getByTestId('pl-search-input').fill('queen bohemian');
    await page.getByTestId('pl-search-go').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="pl-search-result"] b')].some((b) => b.textContent === 'Bohemian Rhapsody'));
    await page.locator('[data-testid="pl-search-result"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 2);

    // ---------- paste a list ----------
    await page.getByTestId('pl-tab-paste').click();
    const lines = [
      'Golden Earring - Radar Love',
      'a-ha - Take On Me, 1985',
      'Doe Maar - De Bom (1983)',
      '3. Nirvana - Smells Like Teen Spirit',
      'Whitney Houston - I Wanna Dance',
      'Onbekende Band - Bestaat Niet',
      'Earth, Wind & Fire - September',
      'Michael Jackson - Billie Jean',
      'Toto - Africa',
    ];
    await page.getByTestId('pl-paste-input').fill(lines.join('\n'));
    assert(/Zoek 9 nummers op/.test(await page.getByTestId('pl-paste-start').textContent()), 'paste: 9 lines counted');
    await page.getByTestId('pl-paste-start').click();
    await page.getByTestId('pl-paste-progress').waitFor();
    await shot(page, 'pl-82-playlist-paste-progress');
    await page.getByTestId('pl-paste-start').waitFor({ timeout: 30000 });
    const summary = await page.getByTestId('pl-paste-summary').textContent();
    assert(/8 nummers toegevoegd/.test(summary) && /1 om te controleren/.test(summary) && /1 niet gevonden/.test(summary), `paste summary: ${summary}`);
    const none = page.locator('[data-testid="pl-paste-result"][data-status="none"]');
    assert(await none.count() === 1 && /Bestaat Niet/.test(await none.textContent()), 'line that is not found is listed');
    assert(/Bestaat Niet/.test(await page.getByTestId('pl-paste-input').inputValue()), 'not-found line stays in the text box');
    const doubt = page.locator('[data-testid="pl-paste-result"][data-status="doubt"]');
    assert(/I Wanna Dance/.test(await doubt.textContent()), 'partial title is a doubt case');
    await shot(page, 'pl-83-playlist-paste-report');
    // pick the other version, then the studio version again
    const opts = await page.getByTestId('pl-paste-choice').locator('option').allTextContents();
    const liveIdx = opts.findIndex((o) => /Live/.test(o));
    const studioIdx = opts.findIndex((o) => /Who Loves Me/.test(o));
    await page.getByTestId('pl-paste-choice').selectOption(String(liveIdx));
    pl = (await stored(page)).lists[0];
    assert(pl.tracks.some((t) => /Live/.test(t.title)), 'doubt corrected to another version');
    await page.getByTestId('pl-paste-choice').selectOption(String(studioIdx));
    pl = (await stored(page)).lists[0];
    assert(pl.tracks.some((t) => /Who Loves Me/.test(t.title)) && !pl.tracks.some((t) => /Live/.test(t.title)), 'and back, without duplicates');
    const byT = (t) => pl.tracks.find((x) => x.title === t);
    assert(byT('Take On Me').year === 1985 && byT('De Bom').year === 1983, 'years from the pasted lines are used');
    assert(pl.tracks.length === 10, `10 songs now (${pl.tracks.length})`);

    // ---------- correct a year ----------
    const sept = byT('September');
    assert(sept.yearSure === false && sept.year === 1979, 'compilation-only song is marked "controleer het jaar"');
    const row = page.locator(`[data-testid="pl-track"][data-n="${sept.n}"]`);
    assert(await row.getByTestId('pl-year-warn').count() === 1, 'row shows the year warning');
    await row.getByTestId('pl-year').fill('1978');
    await row.getByTestId('pl-year').press('Enter');
    await page.waitForFunction((n) => !document.querySelector(`[data-testid="pl-track"][data-n="${n}"] [data-testid="pl-year-warn"]`), sept.n);
    pl = (await stored(page)).lists[0];
    assert(byT('September').year === 1978 && pl.tracks.find((t) => t.title === 'September').yearSure === true, 'year saved and marked as checked');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'pl-84-playlist-tracks');

    // ---------- activate ----------
    await page.getByTestId('pl-activate').click();
    await page.getByTestId('pl-is-active').waitFor();
    await page.goto(base);
    await page.waitForFunction(() => /Muziek: Feest bij Sanne · 10 nummers/.test(document.querySelector('[data-testid="deck-info"]').textContent));
    assert(true, 'start: deck line shows the own playlist');
    await shot(page, 'pl-85-start-own-playlist');
    const ownIds = new Set(pl.tracks.map((t) => t.itunesId));

    // ---------- Tijdlijn with the own playlist ----------
    await page.evaluate(() => localStorage.removeItem('timetunesr.game.v1'));
    await page.getByTestId('start-digital').click();
    await page.getByTestId('setup-form').waitFor();
    assert(/Feest bij Sanne · 10 nummers/.test(await page.getByTestId('game-deck').textContent()), 'Tijdlijn setup shows the deck');
    await page.getByTestId('player-name-0').fill('Anouk');
    await page.getByTestId('player-name-1').fill('Bram');
    for (let i = 0; i < 12; i++) await page.getByTestId('goal-minus').click();
    await shot(page, 'pl-86-game-setup-own');
    await page.getByTestId('start-game').click();
    const gstate = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.game.v1')));
    let g = await gstate();
    assert(g.deck.id === plId && Object.values(g.deck.cards).every((c) => ownIds.has(c.itunesId)), 'game keeps a copy of the own playlist only');
    let turns = 0;
    let checked = 0;
    while (turns < 40) {
      const view = await page.getByTestId('screen-game').getAttribute('data-view');
      if (view === 'won') break;
      if (view === 'handoff') { await page.getByTestId('start-turn').click(); await page.locator('[data-view="place"]').waitFor(); continue; }
      if (view === 'place') {
        g = await gstate();
        const secret = g.deck.cards[g.currentCard];
        assert(ownIds.has(secret.itunesId), `turn ${turns + 1}: song from the own playlist`);
        const dom = await page.evaluate(() => document.documentElement.textContent);
        if (dom.includes(secret.title)) throw new Error('hidden song title leaked in the DOM');
        await page.waitForFunction(() => window.__tt.player.state.status === 'playing', null, { timeout: 15000 });
        const src = await page.evaluate(() => document.querySelector('audio').src);
        assert(src.includes(`/fake/${secret.itunesId}.m4a`), 'plays the fake preview of that song');
        checked++;
        await page.getByTestId('slot-0').click();
        await page.getByTestId('confirm-place').click();
        turns++;
        continue;
      }
      if (view === 'reveal') { await page.getByTestId('next-turn').click(); continue; }
    }
    await page.getByTestId('winner').waitFor();
    assert(checked >= 1, `Tijdlijn with the own playlist ends with a winner after ${turns} turns`);

    // ---------- Bingo with the own playlist, and switching decks mid-game ----------
    await page.goto(base);
    await page.evaluate(() => { localStorage.removeItem('timetunesr.bingo.v1'); localStorage.setItem('timetunesr.bingoSeed.v1', '7'); });
    await page.getByTestId('start-bingo').click();
    await page.getByTestId('bingo-setup-form').waitFor();
    assert(/Feest bij Sanne/.test(await page.getByTestId('bingo-deck').textContent()), 'Bingo setup shows the deck');
    await page.getByTestId('bingo-player-name-0').fill('Anouk');
    await page.getByTestId('bingo-player-name-1').fill('Bram');
    await page.getByTestId('bingo-size-3').check();
    await page.getByTestId('bingo-start').click();
    await page.getByTestId('bingo-start-turn').click();
    await page.locator('[data-view="claim"]').waitFor();
    const bstate = () => page.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.bingo.v1')));
    let b = await bstate();
    const bsecret = b.deck.cards[b.currentCard];
    assert(b.deck.id === plId && ownIds.has(bsecret.itunesId) && Object.values(b.deck.cards).every((c) => ownIds.has(c.itunesId)), 'bingo uses only own songs');
    const bhtml = await page.evaluate(() => document.documentElement.outerHTML);
    assert(!bhtml.includes(bsecret.title) && !bhtml.includes(bsecret.artist), 'bingo claim screen: hidden song not in the DOM');
    const cellKey = await page.locator('[data-testid^="bingo-cell-"]').first().getAttribute('data-key');
    await page.locator('[data-testid^="bingo-cell-"]').first().click();
    if (cellKey === 'year') await page.getByTestId('bingo-year-input').fill(String(bsecret.year));
    await page.getByTestId('bingo-confirm').click();
    if (await page.getByTestId('bingo-judge-yes').count()) await page.getByTestId('bingo-judge-yes').click();
    await page.getByTestId('bingo-result').waitFor();
    assert(await page.getByTestId('answer-year').textContent() === String(bsecret.year) && await page.getByTestId('answer-title').textContent() === bsecret.title, 'bingo reveal shows the own song');

    // switch to the built-in deck while the bingo game runs
    await page.goto(`${base}#/playlists`);
    await page.locator('[data-testid="deck-pick"][data-deck-id="builtin"]').click();
    await page.locator('[data-testid="deck-option"][data-deck-id="builtin"].is-active').waitFor();
    await page.goto(`${base}#/bingo`);
    await page.getByTestId('bingo-next').click();
    await page.getByTestId('bingo-handoff').waitFor();
    assert(/speelt nog met Feest bij Sanne/.test(await page.getByTestId('bingo-deck-note').textContent()), 'running bingo game continues with its own deck after a switch');
    await shot(page, 'pl-87-bingo-other-deck');
    await page.getByTestId('bingo-start-turn').click();
    await page.locator('[data-view="claim"]').waitFor();
    b = await bstate();
    assert(ownIds.has(b.deck.cards[b.currentCard].itunesId), 'next song still from the own playlist');
    await page.goto(`${base}#/playlists`);
    await page.locator(`[data-testid="deck-pick"][data-deck-id="${plId}"]`).click();
    await page.locator(`[data-testid="deck-option"][data-deck-id="${plId}"].is-active`).waitFor();
    await shot(page, 'pl-88-playlists-overview');

    // ---------- print the own playlist; QR -> another phone ----------
    await page.goto(`${base}#/print`);
    await page.locator('[data-testid="print-front"]').first().waitFor();
    assert(await page.getByTestId('print-deck').inputValue() === plId, 'print page prints the active playlist');
    assert(await page.locator('[data-testid="print-front"]').count() === 10, '10 cards');
    assert(/Feest bij Sanne/.test(await page.locator('.sheet-label').first().textContent()), 'playlist name on the sheet');
    const firstId = await page.locator('[data-testid="print-front"]').first().getAttribute('data-card-id');
    const qrUrl = await decodeQr(page, `[data-testid="print-front"][data-card-id="${firstId}"]`);
    const code = L.decodeCardCode(qrUrl?.split('#/c/')[1]);
    const printedTrack = pl.tracks.find((t) => L.padN(t.n) === firstId);
    assert(qrUrl?.startsWith(`${base}#/c/~`) && code && code.itunesId === printedTrack.itunesId && code.year === printedTrack.year, `QR decodes to a self-contained card (${qrUrl})`);
    assert(!qrUrl.includes(String(printedTrack.year)), 'year not readable in the QR link');
    await shot(page, 'pl-89-print-own');
    // the built-in deck still prints its numbered QR codes
    await page.getByTestId('print-deck').selectOption('builtin');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="print-front"]').length === 30);
    assert(await decodeQr(page, '[data-testid="print-front"][data-card-id="001"]') === `${base}#/c/001`, 'built-in deck QR still #/c/001');

    const B = await newPhone(browser);
    await B.page.goto(qrUrl);
    await B.page.getByTestId('screen-card').waitFor();
    assert(await B.page.getByTestId('card-number').textContent() === 'Eigen kaart', 'other phone: card screen for an own card');
    await B.page.waitForFunction(() => window.__tt.player.state.status === 'playing', null, { timeout: 15000 });
    const bsrc = await B.page.evaluate(() => document.querySelector('audio').src);
    assert(bsrc.includes(`/fake/${printedTrack.itunesId}.m4a`), 'other phone plays the song (lookup by id)');
    const bdom = await B.page.evaluate(() => document.documentElement.textContent);
    assert(!bdom.includes(printedTrack.title) && !bdom.includes(String(printedTrack.year)), 'hidden while playing: no title, no year');
    await shot(B.page, 'pl-90-other-phone-card');
    await holdReveal(B.page);
    assert(await B.page.getByTestId('answer-year').textContent() === String(printedTrack.year), 'answer: year from the QR');
    assert(await B.page.getByTestId('answer-title').textContent() === printedTrack.title && await B.page.getByTestId('answer-artist').textContent() === printedTrack.artist, 'answer: title and artist from the lookup');
    await shot(B.page, 'pl-91-other-phone-answer');
    // the old numbered cards still work there
    await B.page.goto(`${base}#/c/042`.replace('042', '005'));
    await B.page.getByTestId('screen-card').waitFor();
    assert(await B.page.getByTestId('card-number').textContent() === 'Kaart 005', 'old #/c/005 still works on the other phone');
    await B.page.goto(`${base}#/c/~zzzz1`);
    await B.page.getByTestId('unknown-code').waitFor();
    assert(true, 'damaged own-card code -> clear message');

    // ---------- share via link to a clean browser ----------
    await page.goto(`${base}#/playlists/${plId}`);
    await page.getByTestId('pl-share').click();
    await page.getByTestId('pl-share-sheet').waitFor();
    const link = await page.getByTestId('pl-share-link').inputValue();
    assert(link.startsWith(`${base}#/pl/1~`), `share link (${link.length} chars)`);
    const qrLink = await decodeQr(page, '[data-testid="pl-share-qr"]');
    assert(qrLink === link, 'share QR decodes to the same link');
    await shot(page, 'pl-92-share-sheet');
    await page.getByTestId('pl-share-close').click();

    const C = await newPhone(browser);
    await C.page.goto(link);
    await C.page.getByTestId('screen-playlist-import').waitFor();
    assert(await C.page.getByTestId('pl-import-name').textContent() === 'Feest bij Sanne' && /10 nummers/.test(await C.page.getByTestId('pl-import-count').textContent()), 'clean browser: confirmation with name and count');
    assert(await C.page.evaluate((k) => localStorage.getItem(k), PLAYLIST_KEY) === null, 'nothing stored before confirming');
    await shot(C.page, 'pl-93-share-receive');
    await C.page.getByTestId('pl-import-confirm').click();
    await C.page.getByTestId('screen-playlist').waitFor();
    const cpl = (await stored(C.page)).lists[0];
    const sig = (p) => p.tracks.map((t) => `${t.itunesId}:${t.year}:${t.title}`).sort().join('|');
    assert(sig(cpl) === sig((await stored(page)).lists[0]), 'received playlist: same songs, years and titles (via batch lookup)');
    assert(C.stats.lookup.length >= 1 && C.stats.lookup[0].length === 10, 'one batch lookup for 10 ids');
    // opening the link again merges instead of duplicating
    await C.page.goto(link);
    await C.page.getByTestId('pl-import-existing').waitFor();
    await C.page.getByTestId('pl-import-confirm').click();
    await C.page.getByTestId('screen-playlist').waitFor();
    assert((await stored(C.page)).lists.length === 1 && (await stored(C.page)).lists[0].tracks.length === 10, 'second import does not duplicate');

    // ---------- export / import ----------
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('pl-export').click()]);
    const file = await download.path();
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    assert(exported.type === 'playlist' && exported.tracks.length === 10 && /\.json$/.test(download.suggestedFilename()), `export file ${download.suggestedFilename()}`);
    await C.page.goto(`${base}#/playlists`);
    await C.page.getByTestId('playlist-import-file').setInputFiles(file);
    await C.page.getByTestId('screen-playlist').waitFor();
    const clists = (await stored(C.page)).lists;
    assert(clists.length === 2 && clists[1].name === 'Feest bij Sanne (2)' && sig(clists[1]) === sig(clists[0]), 'backup imported as a new playlist (nothing overwritten)');

    // ---------- big playlist: 100 songs on 390 px, split QR ----------
    await page.evaluate(([k, id]) => {
      const s = JSON.parse(localStorage.getItem(k));
      const p = s.lists.find((x) => x.id === id);
      for (let i = 0; i < 90; i++) {
        p.tracks.push({ n: p.nextN++, itunesId: 1500000000 + i * 104729, title: `Een heel lang testnummer met een lange titel ${i + 1}`, artist: `Artiest met een lange naam ${i + 1}`, album: '', year: 1960 + (i % 60), yearSure: i % 7 !== 0, previewUrl: null, trackViewUrl: null });
      }
      localStorage.setItem(k, JSON.stringify(s));
    }, [PLAYLIST_KEY, plId]);
    await page.reload();
    await page.getByTestId('screen-playlist').waitFor();
    assert(await page.locator('[data-testid="pl-track"]').count() === 100, '100 songs listed');
    assert(await noHorizontalScroll(page), 'no horizontal scroll at 390 px with long titles');
    await page.getByTestId('pl-filter').fill('lange titel 52');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 1);
    assert(true, 'filter in a long list');
    await page.getByTestId('pl-filter').fill('');
    await page.getByTestId('pl-only-check').check();
    const nCheck = await page.locator('[data-testid="pl-track"]').count();
    assert(nCheck === 13, `only "controleer" rows (${nCheck})`);
    await page.getByTestId('pl-only-check').uncheck();
    await page.locator('[data-testid="pl-track"]').nth(20).scrollIntoViewIfNeeded();
    await shot(page, 'pl-94-playlist-long');
    await page.getByTestId('pl-share').click();
    const parts = Number(await page.getByTestId('pl-share-qr').getAttribute('data-parts'));
    assert(parts >= 2, `100 songs: QR split over ${parts} codes`);
    await shot(page, 'pl-95-share-split');
    const part1 = await decodeQr(page, '[data-testid="pl-share-qr"]');
    await page.getByTestId('pl-share-next').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="pl-share-qr"]').dataset.part === '2');
    const part2 = await decodeQr(page, '[data-testid="pl-share-qr"]');
    const d1 = L.decodeShare(part1);
    const d2 = L.decodeShare(part2);
    assert(d1 && d2 && d1.shareId === d2.shareId && d1.total === parts && d2.part === 2, 'split codes belong together');
    assert(part1.length <= 700, `each QR link at most 700 chars (${part1.length})`);
    await page.getByTestId('pl-share-close').click();

    // ---------- other paths ----------
    // too few songs: games refuse nicely
    await page.goto(`${base}#/playlists`);
    await page.getByTestId('playlist-new-name').fill('Klein');
    await page.getByTestId('playlist-create').click();
    // rename
    await page.getByTestId('pl-rename').click();
    await page.getByTestId('pl-rename-input').fill('Klein maar fijn');
    await page.getByTestId('pl-rename-save').click();
    assert(await page.getByTestId('pl-name').textContent() === 'Klein maar fijn' && (await stored(page)).lists.some((p) => p.name === 'Klein maar fijn'), 'rename saved');
    // paste can be stopped halfway: found songs stay, the rest stays in the text box
    await page.evaluate((k) => localStorage.setItem(k, '700'), GAP_KEY);
    await page.getByTestId('pl-tab-paste').click();
    await page.getByTestId('pl-paste-input').fill('Toto - Africa\nAdele - Rolling in the Deep\nDua Lipa - Levitating\nQueen - Bohemian Rhapsody');
    await page.getByTestId('pl-paste-start').click();
    await page.waitForFunction(() => /1 van 4/.test(document.querySelector('[data-testid="pl-paste-progress"]')?.textContent || ''));
    await shot(page, 'pl-82b-paste-running');
    await page.getByTestId('pl-paste-cancel').click();
    await page.getByTestId('pl-paste-start').waitFor();
    const left = await page.getByTestId('pl-paste-input').inputValue();
    const kept = (await stored(page)).lists.find((p) => p.name === 'Klein maar fijn').tracks;
    assert(kept.length >= 1 && kept.length < 4 && /Bohemian Rhapsody/.test(left) && !/Toto/.test(left), `stop: ${kept.length} kept, rest left in the box`);
    await page.evaluate((k) => localStorage.setItem(k, '30'), GAP_KEY);
    for (const t of kept.slice(1)) await page.locator(`[data-testid="pl-track"][data-n="${t.n}"] [data-testid="pl-track-remove"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="pl-track"]').length === 1);
    await page.getByTestId('pl-activate').click();
    await page.goto(`${base}#/bingo`);
    await page.evaluate(() => localStorage.removeItem('timetunesr.bingo.v1'));
    await page.reload();
    await page.getByTestId('bingo-deck-too-small').waitFor();
    assert(await page.getByTestId('bingo-start').isDisabled(), 'bingo: start disabled with 1 song, message shown');
    await page.goto(`${base}#/spel`);
    await page.evaluate(() => localStorage.removeItem('timetunesr.game.v1'));
    await page.reload();
    await page.getByTestId('deck-too-small').waitFor();
    assert(await page.getByTestId('start-game').isDisabled(), 'Tijdlijn: start disabled with 1 song, message shown');
    await shot(page, 'pl-96-game-too-small');

    // delete (confirm) and back to the built-in deck
    await page.goto(`${base}#/playlists`);
    const kleinId = (await stored(page)).lists.find((p) => p.name === 'Klein maar fijn').id;
    await page.locator(`[data-testid="playlist-open"][data-deck-id="${kleinId}"]`).click();
    await page.getByTestId('pl-delete').click();
    await page.getByTestId('screen-playlists').waitFor();
    assert(!(await stored(page)).lists.some((p) => p.id === kleinId), 'playlist deleted after confirmation');
    assert(await page.locator('[data-testid="deck-option"][data-deck-id="builtin"].is-active').count() === 1, 'deleting the active playlist falls back to the built-in deck');
    await page.goto(base);
    await page.waitForFunction(() => /Muziek: TimeTunesr-deck · 30 kaarten/.test(document.querySelector('[data-testid="deck-info"]').textContent));
    assert(true, 'start shows the built-in deck again');
    await page.goto(`${base}#/c/001`);
    await page.getByTestId('screen-card').waitFor();
    assert(await page.getByTestId('card-number').textContent() === 'Kaart 001', 'built-in card plays again');

    // settings entry
    await page.goto(`${base}#/instellingen`);
    await page.getByTestId('settings-playlists').click();
    await page.getByTestId('screen-playlists').waitFor();
    assert(true, 'settings -> playlists');

    // Apple Music says "too many requests" (429): a clear message, no crash
    C.stats.failNext = 1;
    await C.page.goto(`${base}#/playlists/${clists[0].id}`);
    await C.page.getByTestId('pl-search-input').fill('abba');
    await C.page.getByTestId('pl-search-go').click();
    await C.page.waitForFunction(() => /te veel zoekvragen/.test(document.querySelector('[data-testid="pl-search-status"]').textContent));
    assert(C.stats.rate === 1, 'rate limit (429) -> message to wait a minute');
    await shot(C.page, 'pl-97-rate-limit');

    for (const P of [A, B, C]) assert(P.errors.length === 0, `no page errors (${P.errors.join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
