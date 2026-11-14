// Hidden playback screen for one physical card (#/c/<id>).
import { findCard } from '../deck.js';
import * as player from '../player.js';
import { icons, esc, vibrate } from '../ui.js';
import { playerViewHtml, mountPlayerView } from './playerview.js';
import { setupHoldButton, answerHtml } from './answer.js';
import { decodeCardCode, isCardCode } from '../playlist-logic.js';
import { lookupOne } from '../itunes.js';

export const name = 'card';

/**
 * A card of an own playlist (#/c/~<code>): the code holds the iTunes id and the year,
 * so it plays on any phone. Title and artist come from the active deck when it has
 * this song, else from an iTunes lookup.
 */
function codeCard(deck, code) {
  const d = decodeCardCode(code);
  if (!d) return null;
  const own = deck?.cards.find((c) => Number(c.itunesId) === d.itunesId);
  return {
    ...(own || {}), id: code, itunesId: d.itunesId, year: d.year, // the year on the printed card wins
    title: own?.title || '', artist: own?.artist || '', code, known: !!own,
  };
}

export function render(root, { deck, params }) {
  const fromCode = isCardCode(params[0]);
  const card = fromCode ? codeCard(deck, params[0]) : findCard(deck, params[0]);
  if (!card) {
    player.stop();
    root.innerHTML = `<section class="screen screen-center" data-testid="screen-unknown-card">
      <div class="panel">
        <h1>Onbekende kaart</h1>
        ${fromCode
    ? '<p data-testid="unknown-code">Deze QR-code van een eigen kaart is beschadigd of onvolledig. Scan hem nog eens, iets rechter of met meer licht.</p>'
    : `<p>Kaart <strong>${esc(params[0])}</strong> staat niet in ${deck?.kind === 'playlist' ? `de playlist “${esc(deck.name)}”` : 'dit deck'}. Misschien hoort de kaart bij een andere playlist of versie van het spel, of is het nummer verkeerd getypt.</p>`}
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
      <h1 class="topbar-title"><span class="chip" data-testid="card-number">${fromCode ? 'Eigen kaart' : `Kaart ${esc(card.id)}`}</span></h1>
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

  let lookupFailed = false;
  function showAnswer() {
    vibrate(60);
    const fresh = player.freshInfo(card);
    const unknown = fromCode && !card.title && !card.artist;
    const shown = unknown ? { ...card, artist: lookupFailed ? '' : 'Titel wordt opgehaald…' } : card;
    slot.innerHTML = `<div class="sheet-backdrop" data-testid="answer">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ans-title">
        ${answerHtml(shown, fresh?.trackViewUrl)}
        ${unknown && lookupFailed ? '<p class="small muted" data-testid="answer-no-title">Titel en artiest konden niet worden opgehaald (geen verbinding met Apple Music). Het jaartal klopt wel.</p>' : ''}
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

  let alive = true;
  if (fromCode && !card.known) {
    // Another phone's card: look the song up first (title for the answer, preview for playing).
    lookupOne(card.itunesId).then((r) => {
      if (!alive) return;
      if (r) {
        Object.assign(card, { title: r.trackName || '', artist: r.artistName || '', previewUrl: r.previewUrl || null, trackViewUrl: r.trackViewUrl || null });
        player.prime(card.itunesId, r);
      } else lookupFailed = true;
      if (slot.querySelector('[data-testid="answer"]')) showAnswer();
      if (player.state.cardId !== card.id || player.state.status === 'idle' || player.state.status === 'error') player.load(card, { autoplay: true });
    });
  } else if (player.state.cardId !== card.id || player.state.status === 'idle' || player.state.status === 'error') {
    player.load(card, { autoplay: true });
  }

  return () => {
    alive = false;
    unmountPv();
    unhold();
    document.removeEventListener('keydown', onKey);
    slot.removeEventListener('click', onSlotClick);
    player.stop();
  };
}
