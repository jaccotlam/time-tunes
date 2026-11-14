// Hidden playback screen for one physical card (#/c/<id>).
import { findCard } from '../deck.js';
import * as player from '../player.js';
import { icons, esc, vibrate } from '../ui.js';
import { playerViewHtml, mountPlayerView } from './playerview.js';
import { setupHoldButton, answerHtml } from './answer.js';

export const name = 'card';

export function render(root, { deck, params }) {
  const card = findCard(deck, params[0]);
  if (!card) {
    player.stop();
    root.innerHTML = `<section class="screen screen-center" data-testid="screen-unknown-card">
      <div class="panel">
        <h1>Onbekende kaart</h1>
        <p>Kaart <strong>${esc(params[0])}</strong> staat niet in dit deck. Misschien hoort de kaart bij een andere versie van het spel, of is het nummer verkeerd getypt.</p>
        <div class="stack">
          <a class="btn btn-primary" href="#/scan" data-testid="unknown-scan">${icons.scan}<span>Andere kaart scannen</span></a>
          <a class="btn btn-ghost" href="#/">${icons.home}<span>Naar start</span></a>
        </div>
      </div>
    </section>`;
    return null;
  }

  root.innerHTML = `<section class="screen screen-card" data-testid="screen-card" data-card-id="${esc(card.id)}">
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
      <h1 class="topbar-title"><span class="chip" data-testid="card-number">Kaart ${esc(card.id)}</span></h1>
      <span class="topbar-spacer"></span>
    </header>
    <p class="card-lead">Welk jaar? Leg de kaart in je tijdlijn, of claim een vakje op je bingokaart.</p>
    ${playerViewHtml()}
    <div class="card-actions">
      <a class="btn btn-primary btn-xl" href="#/scan" data-testid="next-card">${icons.scan}<span>Volgende kaart scannen</span></a>
      <button class="hold-btn" type="button" data-testid="reveal-hold" aria-describedby="hold-help">
        <span class="hold-fill" aria-hidden="true"></span>
        <span class="hold-label">${icons.eye}<span>Toon antwoord</span></span>
      </button>
      <p id="hold-help" class="hold-help">Houd de knop 1,5 seconde ingedrukt. Kijk liever op de achterkant van de kaart.</p>
    </div>
    <div class="answer-slot" data-testid="answer-slot"></div>
  </section>`;

  const unmountPv = mountPlayerView(root);
  const slot = root.querySelector('.answer-slot');

  function showAnswer() {
    vibrate(60);
    const fresh = player.freshInfo(card);
    slot.innerHTML = `<div class="sheet-backdrop" data-testid="answer">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ans-title">
        ${answerHtml(card, fresh?.trackViewUrl)}
        <button class="btn btn-ghost" type="button" data-action="hide-answer" data-testid="answer-close">${icons.close}<span>Verberg antwoord</span></button>
      </div>
    </div>`;
    slot.querySelector('[data-action="hide-answer"]').focus();
  }
  const onSlotClick = (e) => {
    if (e.target.closest('[data-action="hide-answer"]') || e.target.classList.contains('sheet-backdrop')) {
      slot.innerHTML = '';
    }
  };
  slot.addEventListener('click', onSlotClick);
  const onKey = (e) => { if (e.key === 'Escape') slot.innerHTML = ''; };
  document.addEventListener('keydown', onKey);
  const unhold = setupHoldButton(root.querySelector('.hold-btn'), showAnswer);

  if (player.state.cardId !== card.id || player.state.status === 'idle' || player.state.status === 'error') {
    player.load(card, { autoplay: true });
  }

  return () => {
    unmountPv();
    unhold();
    document.removeEventListener('keydown', onKey);
    slot.removeEventListener('click', onSlotClick);
    player.stop();
  };
}
