// Bingo ("alleen de app"): one phone is passed around, every player has an own bingo card.
import {
  createBingo, startBingoTurn, claimSquare, judgeClaim, nextBingoPlayer, isValidBingoState,
  canClaim, parseYearGuess, markCount, bestLine, SQUARES, SIZES, DEFAULT_SIZE, YEAR_MARGIN,
  MIN_PLAYERS, MAX_PLAYERS,
} from '../bingo.js';
import * as player from '../player.js';
import { icons, esc, store, vibrate, reducedMotion, toast } from '../ui.js';
import { playerViewHtml, mountPlayerView } from './playerview.js';
import { answerHtml } from './answer.js';
import { isPlayable, deckSnapshot } from '../deck.js';
import { deckLineHtml, deckLabel } from './deckline.js';

export const name = 'bingo';

export const BINGO_KEY = 'timetunesr.bingo.v1';
const SETUP_KEY = 'timetunesr.bingoSetup.v1';
/** Optional fixed seed (integer) for a predictable game: same cards and song order every time. */
export const SEED_KEY = 'timetunesr.bingoSeed.v1';

/** One bingo card as a grid. Used here and on the winner screen. */
export function bingoCardHtml(p, size, { selectable = false, selected = null, highlight = null, winLine = null, years = {}, testid = 'bingo-card' } = {}) {
  const cells = p.card.map((key, i) => {
    const sq = SQUARES[key];
    const stamped = p.marks[i] != null;
    const isSel = selected === i;
    const isWin = !!winLine && winLine.includes(i);
    const state = stamped ? 'stamped' : isSel ? 'selected' : 'open';
    const stamp = stamped
      ? `<span class="bc-done"><span class="bc-stamp" aria-hidden="true">${icons.check}</span><span class="bc-year">${esc(years[p.marks[i]] ?? '')}</span></span>`
      : '';
    const inner = `<span class="bc-label">${esc(sq.short || sq.label)}</span><span class="bc-sub">${esc(sq.sub)}</span>${stamp}`;
    const cls = `bc kind-${sq.kind} is-${state}${highlight === i ? ' is-last' : ''}${isWin ? ' is-win' : ''}`;
    const attrs = `data-testid="bingo-cell-${i}" data-index="${i}" data-key="${key}" data-state="${state}"${isWin ? ' data-win="true"' : ''}`;
    const aria = `${sq.label}${stamped ? ', afgestempeld' : ''}`;
    if (selectable && !stamped) {
      return `<button type="button" class="${cls}" data-action="cell" ${attrs} aria-pressed="${isSel}" aria-label="${esc(aria)}">${inner}</button>`;
    }
    return `<div class="${cls}" ${attrs} aria-label="${esc(aria)}">${inner}</div>`;
  }).join('');
  return `<div class="bingo-card size-${size}${selectable ? ' is-selectable' : ''}" data-testid="${testid}" role="group" aria-label="Bingokaart van ${esc(p.name)}" style="--n:${size}">${cells}</div>`;
}

export function render(root, { deck }) {
  const playable = deck.cards.filter(isPlayable);
  let game = restore();
  let view = null; // 'setup' | 'handoff' | 'claim' | 'reveal' | 'won'
  let selected = null;
  let yearGuess = '';
  let unmountPv = null;
  const setup = loadSetup();

  function restore() {
    const s = store.get(BINGO_KEY);
    if (!isValidBingoState(s)) return null;
    const ids = [...s.pile, ...(s.currentCard ? [s.currentCard] : []), ...(s.last ? [s.last.cardId] : [])];
    // Games keep their own copy of the cards (s.deck), so switching decks does not break them.
    const has = s.deck?.cards ? (id) => !!s.deck.cards[id] : (id) => deck.byId.has(id);
    if (!ids.every(has)) {
      store.remove(BINGO_KEY);
      setTimeout(() => toast('Het vorige bingopotje paste niet bij deze muziek en is gestopt.', { kind: 'warn', ms: 4500 }), 0);
      return null;
    }
    return s;
  }
  function save() {
    if (game) store.set(BINGO_KEY, game);
    else store.remove(BINGO_KEY);
  }
  function loadSetup() {
    const s = store.get(SETUP_KEY, null);
    const names = Array.isArray(s?.names) && s.names.length >= MIN_PLAYERS
      ? s.names.slice(0, MAX_PLAYERS).map(String) : ['', ''];
    const size = SIZES.includes(s?.size) ? s.size : DEFAULT_SIZE;
    return { names, size };
  }
  function saveSetup() { store.set(SETUP_KEY, { names: setup.names, size: setup.size }); }
  const card = (id) => game?.deck?.cards?.[id] || deck.byId.get(id);

  function draw(next) {
    if (unmountPv) { unmountPv(); unmountPv = null; }
    if (next) view = next;
    else if (!game) view = 'setup';
    else if (game.phase === 'won') view = 'won';
    else if (game.phase === 'reveal' || game.phase === 'judge') view = 'reveal';
    else if (view !== 'claim') view = 'handoff';

    const html = { setup: setupHtml, handoff: handoffHtml, claim: claimHtml, reveal: revealHtml, won: wonHtml }[view]();
    root.innerHTML = `<section class="screen screen-bingo view-${view}" data-testid="screen-bingo" data-view="${view}"${game ? ` data-phase="${game.phase}"` : ''}>${html}</section>`;
    if (view === 'claim' || view === 'reveal') unmountPv = mountPlayerView(root);
    const h = root.querySelector('h1, h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  // ---------- views ----------
  function topbar(title) {
    return `<header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
      <h1 class="topbar-title">${title}</h1>
      ${game && game.phase !== 'won'
    ? '<button class="btn btn-small btn-ghost" type="button" data-action="quit" data-testid="bingo-quit">Stoppen</button>'
    : '<span class="topbar-spacer"></span>'}
    </header>`;
  }

  function progressHtml() {
    const total = game.size * game.size;
    return `<ol class="bingo-progress" data-testid="bingo-progress" aria-label="Voortgang">
      ${game.players.map((p, i) => `<li class="bp ${i === game.current && game.phase !== 'won' ? 'is-current' : ''}" data-testid="bingo-progress-${i}">
        <span class="bp-grid" style="--n:${game.size}" aria-hidden="true">${p.marks.map((m) => `<i class="${m != null ? 'on' : ''}"></i>`).join('')}</span>
        <span class="bp-text"><span class="bp-name">${esc(p.name)}</span>
        <span class="bp-count"><b>${markCount(p.marks)}</b>/${total} · rij ${bestLine(p.marks, game.size)}/${game.size}</span></span>
      </li>`).join('')}
    </ol>`;
  }

  function setupHtml() {
    const tooSmall = playable.length < setup.names.length * 3;
    return `${topbar('Bingo')}
      <p class="lead">Iedereen krijgt een eigen bingokaart. Hoor je een fragment, claim dan één vakje dat erbij past. Goed? Afgestempeld. Wie het eerst een volle rij, kolom of diagonaal heeft, roept <b>bingo</b>.</p>
      ${deckLineHtml(deck, { testid: 'bingo-deck', count: playable.length })}
      <form class="setup bingo-setup" data-testid="bingo-setup-form" autocomplete="off">
        <fieldset>
          <legend>Spelers of teams <span class="muted">(${MIN_PLAYERS}–${MAX_PLAYERS})</span></legend>
          <ol class="player-list">
            ${setup.names.map((n, i) => `<li class="player-row">
              <span class="player-num" aria-hidden="true">${i + 1}</span>
              <input type="text" maxlength="24" value="${esc(n)}" placeholder="Speler ${i + 1}" aria-label="Naam speler ${i + 1}" data-index="${i}" data-testid="bingo-player-name-${i}" enterkeyhint="next">
              <button class="icon-btn" type="button" data-action="remove-player" data-index="${i}" aria-label="Verwijder speler ${i + 1}" data-testid="bingo-remove-player-${i}" ${setup.names.length <= MIN_PLAYERS ? 'disabled' : ''}>${icons.close}</button>
            </li>`).join('')}
          </ol>
          <button class="btn btn-ghost btn-small" type="button" data-action="add-player" data-testid="bingo-add-player" ${setup.names.length >= MAX_PLAYERS ? 'disabled' : ''}>${icons.plus}<span>Speler toevoegen</span></button>
        </fieldset>
        <fieldset>
          <legend>Kaart</legend>
          <div class="size-pick" role="radiogroup" aria-label="Formaat van de kaart">
            ${[[3, 'Snel potje', '9 vakjes'], [4, 'Standaard', '16 vakjes']].map(([n, t, sub]) => `<label class="size-opt">
              <input type="radio" name="size" value="${n}" ${setup.size === n ? 'checked' : ''} data-testid="bingo-size-${n}">
              <span class="size-box"><b>${n}×${n}</b><span>${t}</span><small>${sub}</small></span>
            </label>`).join('')}
          </div>
        </fieldset>
        <details class="bingo-legend">
          <summary>Welke vakjes zijn er?</summary>
          <ul>
            <li><span class="dot kind-period"></span><b>Periode</b>, bv. <em>Vóór 2000</em>: ruim, dus makkelijk.</li>
            <li><span class="dot kind-decade"></span><b>Decennium</b>, bv. <em>Jaren 80</em>.</li>
            <li><span class="dot kind-year"></span><b>Jaar ±2</b>: typ een jaartal; maximaal ${YEAR_MARGIN} jaar ernaast is goed.</li>
            <li><span class="dot kind-artist"></span><b>Artiest</b> of <b>Titel</b>: zeg het hardop, de groep beslist na de onthulling.</li>
          </ul>
        </details>
        ${tooSmall ? `<p class="warn" data-testid="bingo-deck-too-small">Er staan te weinig speelbare ${deck.kind === 'playlist' ? `nummers in “${esc(deck.name)}”` : 'kaarten in het deck'} voor ${setup.names.length} spelers: ${playable.length}, en Bingo vraagt er minstens ${setup.names.length * 3}. <a href="#/playlists">Kies andere muziek</a> of speel met minder spelers.</p>` : ''}
        <button class="btn btn-primary btn-xl" type="submit" data-testid="bingo-start" ${tooSmall ? 'disabled' : ''}>${icons.play}<span>Deel de kaarten uit</span></button>
      </form>`;
  }

  function handoffHtml() {
    const p = game.players[game.current];
    const open = p.marks.filter((m) => m == null).length;
    const note = game.deck && game.deck.id !== deck.id
      ? `<p class="small muted deck-note" data-testid="bingo-deck-note">Dit potje speelt nog met <b>${esc(game.deck.name)}</b>. Nieuwe potjes gebruiken ${esc(deckLabel(deck))}.</p>` : '';
    return `${topbar(`Bingo · ronde ${game.round}`)}
      ${progressHtml()}
      ${note}
      <div class="handoff" data-testid="bingo-handoff">
        <p class="handoff-kicker">Geef de telefoon aan</p>
        <h2 class="handoff-name" data-testid="bingo-current-player">${esc(p.name)}</h2>
        <p class="muted">Nog ${open} open ${open === 1 ? 'vakje' : 'vakjes'} op je kaart. Luister, en kies daarna één vakje.</p>
        <button class="btn btn-primary btn-xl" type="button" data-action="listen" data-testid="bingo-start-turn">${icons.play}<span>Start het fragment</span></button>
      </div>`;
  }

  function selectionHtml(p) {
    if (selected == null) return '<p class="bingo-pick muted" data-testid="bingo-selection">Tik een open vakje aan.</p>';
    const key = p.card[selected];
    const sq = SQUARES[key];
    if (key === 'year') {
      return `<div class="bingo-pick bingo-year" data-testid="bingo-selection">
        <label for="bingo-year">Welk jaar? <span class="muted">(±${YEAR_MARGIN} is goed)</span></label>
        <input id="bingo-year" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="bv. 1987" value="${esc(yearGuess)}" data-testid="bingo-year-input" autocomplete="off">
      </div>`;
    }
    const say = key === 'artist' ? 'Zeg nu hardop wie de artiest is.' : key === 'title' ? 'Zeg nu hardop hoe het nummer heet.' : '';
    return `<p class="bingo-pick" data-testid="bingo-selection">Je claimt <b>${esc(sq.label)}</b>.${say ? ` ${say}` : ''}</p>`;
  }

  function confirmLabel(p) {
    if (selected == null) return 'Kies eerst een vakje';
    if (p.card[selected] === 'year' && parseYearGuess(yearGuess) == null) return 'Vul een jaartal in';
    return 'Claim dit vakje';
  }

  function claimHtml() {
    const p = game.players[game.current];
    const ok = selected != null && canClaim(game, selected, yearGuess);
    return `${topbar(`Bingo · ronde ${game.round}`)}
      <div class="place-player">${playerViewHtml({ compact: true })}</div>
      <h2 class="place-title"><span data-testid="bingo-current-player">${esc(p.name)}</span>, welk vakje claim je?</h2>
      ${bingoCardHtml(p, game.size, { selectable: true, selected, years: game.years })}
      ${selectionHtml(p)}
      <div class="sticky-cta">
        <button class="btn btn-primary btn-xl" type="button" data-action="confirm" data-testid="bingo-confirm" ${ok ? '' : 'disabled'}>
          ${icons.check}<span>${confirmLabel(p)}</span>
        </button>
      </div>`;
  }

  function explain(last, c) {
    const sq = SQUARES[last.key];
    if (last.key === 'year') {
      const diff = Math.abs(last.guess - c.year);
      return `Je zei <b>${esc(last.guess)}</b>; het nummer is uit <b>${esc(c.year)}</b> (${diff === 0 ? 'precies goed' : `${diff} jaar ernaast`}).`;
    }
    if (sq.kind === 'artist' || sq.kind === 'title') return `Je claimde <b>${esc(sq.label)}</b>.`;
    return `Je claimde <b>${esc(sq.label)}</b> (${esc(sq.range || sq.sub)}); het nummer is uit <b>${esc(c.year)}</b>.`;
  }

  function revealHtml() {
    const last = game.last;
    const c = card(last.cardId);
    const p = game.players[last.player];
    const judging = game.phase === 'judge';
    const sq = SQUARES[last.key];
    const won = game.phase === 'won';
    const nextIdx = (game.current + 1) % game.players.length;
    let banner;
    if (judging) {
      banner = `<div class="result is-judge" data-testid="bingo-result" data-correct="pending">
        <span class="result-text">Wat vindt de groep?</span></div>`;
    } else {
      banner = `<div class="result ${last.correct ? 'is-good' : 'is-bad'}" data-testid="bingo-result" data-correct="${last.correct}">
        <span class="result-icon">${last.correct ? icons.check : icons.cross}</span>
        <span class="result-text">${won ? 'BINGO!' : last.correct ? 'Goed!' : 'Helaas, fout'}</span>
      </div>`;
    }
    const judge = judging ? `<div class="bingo-judge">
        <p>${esc(p.name)} claimde <b>${esc(sq.label)}</b>. Was ${sq.kind === 'artist' ? 'de genoemde artiest' : 'de genoemde titel'} goed?</p>
        <div class="bingo-judge-btns">
          <button class="btn btn-good" type="button" data-action="judge-yes" data-testid="bingo-judge-yes">${icons.check}<span>Goed geraden</span></button>
          <button class="btn btn-bad" type="button" data-action="judge-no" data-testid="bingo-judge-no">${icons.cross}<span>Niet goed</span></button>
        </div>
      </div>` : '';
    return `${topbar(`Bingo · ronde ${game.round}`)}
      ${banner}
      ${answerHtml(c)}
      ${judge}
      ${judging ? '' : `<p class="result-explain" data-testid="bingo-result-explain">${explain(last, c)} ${last.correct ? (won ? `${esc(p.name)} heeft een volle lijn!` : 'Het vakje is afgestempeld.') : 'Het vakje blijft open.'}</p>`}
      ${judging ? '' : bingoCardHtml(p, game.size, { highlight: last.index, years: game.years, winLine: won ? game.winLine : null })}
      <div class="place-player">${playerViewHtml({ compact: true })}</div>
      ${judging ? '' : `<div class="sticky-cta">
        <button class="btn btn-primary btn-xl" type="button" data-action="next" data-testid="bingo-next">
          ${won ? `${icons.trophy}<span>Naar de uitslag</span>` : `${icons.users}<span>Volgende: ${esc(game.players[nextIdx].name)}</span>`}
        </button>
      </div>`}`;
  }

  function wonHtml() {
    const winners = game.winners.map((i) => game.players[i].name);
    const byPile = game.endedBy === 'pile';
    const title = winners.length === 1 ? `${esc(winners[0])} ${byPile ? 'wint!' : 'heeft bingo!'}` : `Gedeelde winst: ${winners.map(esc).join(' & ')}`;
    const ranking = game.players.map((p, i) => ({ p, i, n: markCount(p.marks) })).sort((a, b) => b.n - a.n);
    const w = game.winners[0];
    const confetti = reducedMotion() ? '' : `<div class="confetti" aria-hidden="true">${Array.from({ length: 40 }, () => `<i style="--x:${(Math.random() * 100).toFixed(1)}%;--d:${(2.4 + Math.random() * 2.2).toFixed(2)}s;--dl:${(-Math.random() * 4).toFixed(2)}s;--r:${Math.round(360 + Math.random() * 720)}deg"></i>`).join('')}</div>`;
    return `${topbar('Einde spel')}
      ${confetti}
      <div class="winner" data-testid="bingo-winner">
        <span class="winner-trophy">${icons.trophy}</span>
        <h2 class="winner-name" data-testid="bingo-winner-name">${title}</h2>
        <p class="muted">${byPile ? 'De muziek is op: wie de meeste vakjes heeft, wint.' : 'Als eerste een volle rij, kolom of diagonaal.'}</p>
      </div>
      ${bingoCardHtml(game.players[w], game.size, { winLine: game.winLine, years: game.years, testid: 'bingo-winner-card' })}
      <ol class="ranking" data-testid="bingo-ranking">
        ${ranking.map(({ p, i, n }) => `<li class="${game.winners.includes(i) ? 'is-winner' : ''}"><span>${esc(p.name)}</span><b>${n}</b></li>`).join('')}
      </ol>
      <div class="bingo-all">
        <h3>Kaarten van iedereen</h3>
        ${game.players.map((p, i) => `<details class="final-tl" data-testid="bingo-card-of-${i}">
          <summary>${esc(p.name)} · ${markCount(p.marks)} ${markCount(p.marks) === 1 ? 'vakje' : 'vakjes'}</summary>
          ${bingoCardHtml(p, game.size, { years: game.years, winLine: i === w ? game.winLine : null, testid: `bingo-card-${i}` })}
        </details>`).join('')}
      </div>
      <div class="stack">
        <button class="btn btn-primary btn-xl" type="button" data-action="again" data-testid="bingo-again">${icons.restart}<span>Nog een potje</span></button>
        <button class="btn btn-ghost" type="button" data-action="new-setup" data-testid="bingo-new-players">${icons.users}<span>Andere spelers</span></button>
        <a class="btn btn-ghost" href="#/">${icons.home}<span>Naar start</span></a>
      </div>`;
  }

  // ---------- actions ----------
  function readNames() {
    root.querySelectorAll('.player-list input').forEach((inp) => {
      setup.names[Number(inp.dataset.index)] = inp.value;
    });
    const size = root.querySelector('input[name="size"]:checked');
    if (size) setup.size = Number(size.value);
  }

  function newGame() {
    const fixed = store.get(SEED_KEY, null);
    const seed = Number.isInteger(fixed) ? fixed >>> 0 : (Math.random() * 2 ** 32) >>> 0;
    try {
      game = createBingo({
        names: setup.names, size: setup.size, seed,
        cards: playable.map((c) => ({ id: c.id, year: c.year })),
      });
      game.deck = deckSnapshot(deck, playable);
    } catch (e) {
      toast(e.message, { kind: 'warn' });
      return;
    }
    save();
    beginTurn();
  }

  function beginTurn() {
    game = startBingoTurn(game);
    save();
    selected = null;
    yearGuess = '';
    if (game.phase === 'won') { player.stop(); draw('won'); return; }
    player.load(card(game.currentCard)); // prefetch while the phone is passed on
    draw('handoff');
  }

  function updateConfirm() {
    const btn = root.querySelector('[data-testid="bingo-confirm"]');
    if (!btn) return;
    const p = game.players[game.current];
    btn.disabled = !(selected != null && canClaim(game, selected, yearGuess));
    btn.querySelector('span').textContent = confirmLabel(p);
  }

  function afterResult() {
    save();
    if (game.phase === 'judge') { vibrate(30); draw('reveal'); return; }
    vibrate(game.last.correct ? [40, 40, 80] : [120]);
    draw('reveal');
  }

  function onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a || !root.contains(a)) return;
    const act = a.dataset.action;
    if (act.startsWith('pv-')) return; // handled by the player view
    switch (act) {
      case 'add-player':
        readNames();
        if (setup.names.length < MAX_PLAYERS) setup.names.push('');
        saveSetup(); draw('setup');
        root.querySelector(`[data-testid="bingo-player-name-${setup.names.length - 1}"]`)?.focus();
        break;
      case 'remove-player':
        readNames();
        if (setup.names.length > MIN_PLAYERS) setup.names.splice(Number(a.dataset.index), 1);
        saveSetup(); draw('setup');
        break;
      case 'listen':
        player.play(); // inside the tap: allowed on iOS
        selected = null;
        yearGuess = '';
        draw('claim');
        window.scrollTo(0, 0);
        break;
      case 'cell': {
        const i = Number(a.dataset.index);
        if (game.players[game.current].marks[i] != null) return;
        selected = i;
        vibrate(15);
        const y = window.scrollY;
        draw('claim');
        window.scrollTo(0, y);
        const inp = root.querySelector('[data-testid="bingo-year-input"]');
        if (inp) { inp.focus({ preventScroll: true }); inp.scrollIntoView?.({ block: 'nearest' }); }
        else root.querySelector(`[data-index="${i}"]`)?.focus({ preventScroll: true });
        break;
      }
      case 'confirm':
        if (selected == null || !canClaim(game, selected, yearGuess)) return;
        game = claimSquare(game, selected, yearGuess);
        selected = null;
        yearGuess = '';
        afterResult();
        window.scrollTo(0, 0);
        break;
      case 'judge-yes':
      case 'judge-no':
        game = judgeClaim(game, act === 'judge-yes');
        afterResult();
        break;
      case 'next':
        player.stop();
        if (game.phase === 'won') { draw('won'); window.scrollTo(0, 0); break; }
        game = nextBingoPlayer(game);
        save();
        if (game.phase === 'won') { draw('won'); break; }
        beginTurn();
        window.scrollTo(0, 0);
        break;
      case 'quit':
        if (window.confirm('Weet je zeker dat je dit potje wilt stoppen? De stand gaat verloren.')) {
          player.stop();
          game = null; save(); draw('setup');
        }
        break;
      case 'again':
        newGame();
        break;
      case 'new-setup':
        game = null; save(); draw('setup');
        break;
      default:
    }
  }

  function onSubmit(e) {
    if (!e.target.matches('.bingo-setup')) return;
    e.preventDefault();
    readNames();
    saveSetup();
    newGame();
  }
  function onInput(e) {
    if (e.target.matches('.player-list input')) { readNames(); saveSetup(); }
    if (e.target.matches('[data-testid="bingo-year-input"]')) {
      yearGuess = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (e.target.value !== yearGuess) e.target.value = yearGuess;
      updateConfirm();
    }
  }
  function onChange(e) {
    if (e.target.name === 'size') { readNames(); saveSetup(); }
  }
  function onKeyDown(e) {
    if (e.key === 'Enter' && e.target.matches('[data-testid="bingo-year-input"]')) {
      e.preventDefault();
      root.querySelector('[data-testid="bingo-confirm"]')?.click();
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKeyDown);

  if (game && game.phase === 'turn') {
    if (!game.currentCard) beginTurn();
    else { player.load(card(game.currentCard)); draw('handoff'); }
  } else {
    if (game && game.last && (game.phase === 'reveal' || game.phase === 'judge')) player.load(card(game.last.cardId));
    draw(game ? null : 'setup');
  }

  return () => {
    if (unmountPv) unmountPv();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKeyDown);
    player.stop();
  };
}
