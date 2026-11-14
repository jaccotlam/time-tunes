// Digital mode ("Speel zonder kaarten"): one phone is passed around.
import {
  createGame, startTurn, placeCard, nextPlayer, isValidGameState, cardsNeeded,
  MIN_PLAYERS, MAX_PLAYERS, DEFAULT_GOAL,
} from '../logic.js';
import * as player from '../player.js';
import { icons, esc, store, vibrate, reducedMotion, toast } from '../ui.js';
import { playerViewHtml, mountPlayerView } from './playerview.js';
import { answerHtml } from './answer.js';

export const name = 'game';

const GAME_KEY = 'timetunesr.game.v1';
const SETUP_KEY = 'timetunesr.setup.v1';

export function render(root, { deck }) {
  const playable = deck.cards.filter((c) => Number.isFinite(c.year) && (c.previewUrl || c.itunesId));
  let game = restore();
  let view = null; // 'setup' | 'handoff' | 'place' | 'reveal' | 'won'
  let selectedSlot = null;
  let unmountPv = null;
  const setup = loadSetup();

  function restore() {
    const s = store.get(GAME_KEY);
    if (!isValidGameState(s)) return null;
    const ids = [...s.pile, ...s.players.flatMap((p) => p.timeline), ...(s.currentCard ? [s.currentCard] : [])];
    if (!ids.every((id) => deck.byId.has(id))) { store.remove(GAME_KEY); return null; }
    return s;
  }
  function save() {
    if (game) store.set(GAME_KEY, game);
    else store.remove(GAME_KEY);
  }
  function loadSetup() {
    const s = store.get(SETUP_KEY, null);
    const names = Array.isArray(s?.names) && s.names.length >= MIN_PLAYERS
      ? s.names.slice(0, MAX_PLAYERS).map(String) : ['', ''];
    const goal = Number.isInteger(s?.goal) ? s.goal : DEFAULT_GOAL;
    return { names, goal };
  }

  function card(id) { return deck.byId.get(id); }

  function draw(next) {
    if (unmountPv) { unmountPv(); unmountPv = null; }
    if (next) view = next;
    else if (!game) view = 'setup';
    else if (game.phase === 'won') view = 'won';
    else if (game.phase === 'reveal') view = 'reveal';
    else if (view !== 'place') view = 'handoff';

    const html = {
      setup: setupHtml, handoff: handoffHtml, place: placeHtml, reveal: revealHtml, won: wonHtml,
    }[view]();
    root.innerHTML = `<section class="screen screen-game view-${view}" data-testid="screen-game" data-view="${view}">${html}</section>`;
    if (view === 'place' || view === 'reveal') unmountPv = mountPlayerView(root);
    const h = root.querySelector('h1, h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    window.scrollTo(0, 0);
    if (view === 'place' && selectedSlot != null) scrollToSlot(selectedSlot);
  }

  // ---------- views ----------
  function topbar(title) {
    return `<header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
      <h1 class="topbar-title">${title}</h1>
      ${game && game.phase !== 'won'
    ? `<button class="btn btn-small btn-ghost" type="button" data-action="quit" data-testid="quit-game">Stoppen</button>`
    : '<span class="topbar-spacer"></span>'}
    </header>`;
  }

  function scoreboard() {
    return `<ol class="scoreboard" data-testid="scoreboard" aria-label="Tussenstand">
      ${game.players.map((p, i) => `<li class="score ${i === game.current && game.phase !== 'won' ? 'is-current' : ''}" data-testid="score-${i}">
        <span class="score-name">${esc(p.name)}</span>
        <span class="score-count"><b>${p.timeline.length}</b>/${game.goal}</span>
      </li>`).join('')}
    </ol>`;
  }

  function setupHtml() {
    const tooSmall = playable.length < cardsNeeded(setup.names.length);
    return `${topbar('Speel zonder kaarten')}
      <p class="lead">Eén telefoon gaat rond. De app speelt een geheim fragment; jij kiest waar het in jouw tijdlijn hoort. Wie als eerste het doel haalt, wint.</p>
      <form class="setup" data-testid="setup-form" autocomplete="off">
        <fieldset>
          <legend>Spelers of teams <span class="muted">(${MIN_PLAYERS}–${MAX_PLAYERS})</span></legend>
          <ol class="player-list">
            ${setup.names.map((n, i) => `<li class="player-row">
              <span class="player-num" aria-hidden="true">${i + 1}</span>
              <input type="text" maxlength="24" value="${esc(n)}" placeholder="Speler ${i + 1}" aria-label="Naam speler ${i + 1}" data-index="${i}" data-testid="player-name-${i}" enterkeyhint="next">
              <button class="icon-btn" type="button" data-action="remove-player" data-index="${i}" aria-label="Verwijder speler ${i + 1}" data-testid="remove-player-${i}" ${setup.names.length <= MIN_PLAYERS ? 'disabled' : ''}>${icons.close}</button>
            </li>`).join('')}
          </ol>
          <button class="btn btn-ghost btn-small" type="button" data-action="add-player" data-testid="add-player" ${setup.names.length >= MAX_PLAYERS ? 'disabled' : ''}>${icons.plus}<span>Speler toevoegen</span></button>
        </fieldset>
        <fieldset>
          <legend>Doel</legend>
          <div class="stepper">
            <button class="icon-btn" type="button" data-action="goal-minus" aria-label="Minder kaarten" data-testid="goal-minus">${icons.minus}</button>
            <output data-testid="goal-value" aria-live="polite"><b>${setup.goal}</b> kaarten</output>
            <button class="icon-btn" type="button" data-action="goal-plus" aria-label="Meer kaarten" data-testid="goal-plus">${icons.plus}</button>
          </div>
          <p class="muted small">De startkaart telt mee.</p>
        </fieldset>
        ${tooSmall ? `<p class="warn" data-testid="deck-too-small">Er staan maar ${playable.length} speelbare kaarten in het deck; dat is te weinig voor ${setup.names.length} spelers.</p>` : ''}
        <button class="btn btn-primary btn-xl" type="submit" data-testid="start-game" ${tooSmall ? 'disabled' : ''}>${icons.play}<span>Start het spel</span></button>
      </form>`;
  }

  function handoffHtml() {
    const p = game.players[game.current];
    return `${topbar(`Ronde ${game.round}`)}
      ${scoreboard()}
      <div class="handoff" data-testid="handoff">
        <p class="handoff-kicker">Geef de telefoon aan</p>
        <h2 class="handoff-name" data-testid="current-player">${esc(p.name)}</h2>
        <p class="muted">Jouw tijdlijn: ${p.timeline.length} ${p.timeline.length === 1 ? 'kaart' : 'kaarten'} · nog ${Math.max(0, game.goal - p.timeline.length)} te gaan</p>
        <button class="btn btn-primary btn-xl" type="button" data-action="listen" data-testid="start-turn">${icons.play}<span>Start het fragment</span></button>
      </div>`;
  }

  function slotLabel(years, i) {
    if (years.length === 0) return 'Hier plaatsen';
    if (i === 0) return `Vóór ${years[0]}`;
    if (i === years.length) return `Na ${years[years.length - 1]}`;
    return `Tussen ${years[i - 1]} en ${years[i]}`;
  }

  function timelineHtml(pIdx, { selectable = false, highlight = null } = {}) {
    const tl = game.players[pIdx].timeline;
    const years = tl.map((id) => card(id).year);
    const parts = [];
    const gap = (i) => {
      if (!selectable) return '';
      const sel = selectedSlot === i;
      return `<li class="gap ${sel ? 'is-selected' : ''}">
        <button type="button" class="gap-btn" data-action="slot" data-slot="${i}" data-testid="slot-${i}" aria-pressed="${sel}">
          ${sel
    ? `<span class="mystery">${icons.music}<span><b>Dit nummer</b><small>${esc(slotLabel(years, i))}</small></span></span>`
    : `<span class="gap-plus">${icons.plus}</span><span class="gap-text">${esc(slotLabel(years, i))}</span>`}
        </button>
      </li>`;
    };
    tl.forEach((id, i) => {
      parts.push(gap(i));
      const c = card(id);
      parts.push(`<li class="tl-card ${highlight === id ? 'is-new' : ''}" data-testid="tl-card">
        <span class="tl-year">${esc(c.year)}</span>
        <span class="tl-meta"><span class="tl-artist">${esc(c.artist)}</span><span class="tl-title">${esc(c.title)}</span></span>
      </li>`);
    });
    parts.push(gap(tl.length));
    return `<ol class="timeline ${selectable ? 'is-selectable' : ''}" data-testid="timeline" aria-label="Tijdlijn van ${esc(game.players[pIdx].name)}">${parts.join('')}</ol>`;
  }

  function placeHtml() {
    const p = game.players[game.current];
    return `${topbar(`Ronde ${game.round}`)}
      <div class="place-player">${playerViewHtml({ compact: true })}</div>
      <h2 class="place-title"><span data-testid="current-player">${esc(p.name)}</span>, waar hoort dit nummer?</h2>
      <p class="muted small">Oud bovenaan, nieuw onderaan. Kies een plek en bevestig.</p>
      ${timelineHtml(game.current, { selectable: true })}
      <div class="sticky-cta">
        <button class="btn btn-primary btn-xl" type="button" data-action="confirm" data-testid="confirm-place" ${selectedSlot == null ? 'disabled' : ''}>
          ${icons.check}<span>${selectedSlot == null ? 'Kies eerst een plek' : 'Leg hem hier'}</span>
        </button>
      </div>`;
  }

  function where(years, slots) {
    const s = slots[0];
    return slotLabel(years, s).replace(/^V/, 'v').replace(/^T/, 't').replace(/^N/, 'n');
  }

  function revealHtml() {
    const last = game.last;
    const c = card(last.cardId);
    const p = game.players[last.player];
    const nextIdx = (game.current + 1) % game.players.length;
    const yearsBefore = p.timeline.filter((id) => id !== last.cardId).map((id) => card(id).year);
    return `${topbar(`Ronde ${game.round}`)}
      <div class="result ${last.correct ? 'is-good' : 'is-bad'}" data-testid="result" data-correct="${last.correct}">
        <span class="result-icon">${last.correct ? icons.check : icons.cross}</span>
        <span class="result-text">${last.correct ? 'Goed gegokt!' : 'Helaas, fout!'}</span>
      </div>
      ${answerHtml(c)}
      <p class="result-explain" data-testid="result-explain">${last.correct
    ? `De kaart blijft in de tijdlijn van ${esc(p.name)}.`
    : `Hij hoorde ${esc(where(yearsBefore, last.correctSlots))}. De kaart gaat weg.`}
        ${esc(p.name)} heeft nu <b>${p.timeline.length}</b> van ${game.goal} kaarten.</p>
      <div class="place-player">${playerViewHtml({ compact: true })}</div>
      ${timelineHtml(last.player, { highlight: last.correct ? last.cardId : null })}
      <div class="sticky-cta">
        <button class="btn btn-primary btn-xl" type="button" data-action="next" data-testid="next-turn">
          ${icons.users}<span>Volgende: ${esc(game.players[nextIdx].name)}</span>
        </button>
      </div>`;
  }

  function wonHtml() {
    const ranking = game.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.timeline.length - a.timeline.length);
    const winners = game.winners.map((i) => game.players[i].name);
    const title = winners.length === 1 ? `${esc(winners[0])} wint!` : `Gedeelde winst: ${winners.map(esc).join(' & ')}`;
    const confetti = reducedMotion() ? '' : `<div class="confetti" aria-hidden="true">${Array.from({ length: 40 }, () => `<i style="--x:${(Math.random() * 100).toFixed(1)}%;--d:${(2.4 + Math.random() * 2.2).toFixed(2)}s;--dl:${(-Math.random() * 4).toFixed(2)}s;--r:${Math.round(360 + Math.random() * 720)}deg"></i>`).join('')}</div>`;
    return `${topbar('Einde spel')}
      ${confetti}
      <div class="winner" data-testid="winner">
        <span class="winner-trophy">${icons.trophy}</span>
        <h2 class="winner-name" data-testid="winner-name">${title}</h2>
        <p class="muted">${game.endedBy === 'pile' ? 'De kaarten zijn op: de langste tijdlijn wint.' : `Als eerste ${game.goal} kaarten op de juiste plek.`}</p>
      </div>
      <ol class="ranking" data-testid="ranking">
        ${ranking.map((p) => `<li class="${game.winners.includes(p.i) ? 'is-winner' : ''}"><span>${esc(p.name)}</span><b>${p.timeline.length}</b></li>`).join('')}
      </ol>
      <details class="final-tl">
        <summary>Tijdlijn van ${esc(game.players[game.winners[0]].name)}</summary>
        ${timelineHtml(game.winners[0])}
      </details>
      <div class="stack">
        <button class="btn btn-primary btn-xl" type="button" data-action="again" data-testid="play-again">${icons.restart}<span>Nog een potje</span></button>
        <button class="btn btn-ghost" type="button" data-action="new-setup" data-testid="new-players">${icons.users}<span>Andere spelers</span></button>
        <a class="btn btn-ghost" href="#/">${icons.home}<span>Naar start</span></a>
      </div>`;
  }

  // ---------- actions ----------
  function readNames() {
    root.querySelectorAll('.player-list input').forEach((inp) => {
      setup.names[Number(inp.dataset.index)] = inp.value;
    });
  }
  function saveSetup() { store.set(SETUP_KEY, { names: setup.names, goal: setup.goal }); }

  function newGame() {
    try {
      game = createGame({
        names: setup.names, goal: setup.goal,
        cards: playable.map((c) => ({ id: c.id, year: c.year })),
        seed: (Math.random() * 2 ** 32) >>> 0,
      });
    } catch (e) {
      toast(e.message, { kind: 'warn' });
      return;
    }
    selectedSlot = null;
    save();
    beginTurn();
  }

  function beginTurn() {
    game = startTurn(game);
    save();
    if (game.phase === 'won') { player.stop(); draw('won'); return; }
    player.load(card(game.currentCard)); // prefetch while the phone is passed on
    selectedSlot = null;
    draw('handoff');
  }

  function scrollToSlot(i) {
    const el = root.querySelector(`[data-slot="${i}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a || !root.contains(a)) return;
    const act = a.dataset.action;
    if (act.startsWith('pv-')) return; // handled by player view
    switch (act) {
      case 'add-player':
        readNames();
        if (setup.names.length < MAX_PLAYERS) setup.names.push('');
        saveSetup(); draw('setup');
        root.querySelector(`[data-testid="player-name-${setup.names.length - 1}"]`)?.focus();
        break;
      case 'remove-player':
        readNames();
        if (setup.names.length > MIN_PLAYERS) setup.names.splice(Number(a.dataset.index), 1);
        saveSetup(); draw('setup');
        break;
      case 'goal-minus':
      case 'goal-plus':
        readNames();
        setup.goal = Math.max(2, Math.min(30, setup.goal + (act === 'goal-plus' ? 1 : -1)));
        saveSetup(); draw('setup');
        break;
      case 'listen':
        player.play(); // inside the tap: allowed on iOS
        selectedSlot = null;
        draw('place');
        break;
      case 'slot': {
        selectedSlot = Number(a.dataset.slot);
        vibrate(15);
        const y = window.scrollY;
        draw('place');
        window.scrollTo(0, y);
        root.querySelector(`[data-slot="${selectedSlot}"]`)?.focus({ preventScroll: true });
        break;
      }
      case 'confirm':
        if (selectedSlot == null) return;
        game = placeCard(game, selectedSlot);
        selectedSlot = null;
        save();
        vibrate(game.last.correct ? [40, 40, 80] : [120]);
        draw(game.phase === 'won' ? 'won' : 'reveal');
        if (game.phase === 'won') player.stop();
        break;
      case 'next':
        player.stop();
        game = nextPlayer(game);
        save();
        if (game.phase === 'won') { draw('won'); break; }
        beginTurn();
        break;
      case 'quit':
        if (window.confirm('Weet je zeker dat je dit spel wilt stoppen? De stand gaat verloren.')) {
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
    if (!e.target.matches('.setup')) return;
    e.preventDefault();
    readNames();
    saveSetup();
    newGame();
  }
  function onInput(e) {
    if (e.target.matches('.player-list input')) { readNames(); saveSetup(); }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);

  if (game && game.phase === 'turn') {
    if (!game.currentCard) { beginTurn(); } else { player.load(card(game.currentCard)); draw('handoff'); }
  } else {
    if (game && game.phase === 'reveal' && game.last) player.load(card(game.last.cardId));
    draw(game ? null : 'setup');
  }

  return () => {
    if (unmountPv) unmountPv();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    player.stop();
  };
}
