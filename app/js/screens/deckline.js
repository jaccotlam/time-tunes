// "Muziek: <deck> · N nummers — wijzig": shown on the start screen and in the game setups.
import { esc } from '../ui.js';

const musicIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function deckLabel(deck) {
  return deck?.kind === 'playlist' ? deck.name : 'TimeTunesr-deck';
}

/** Count text: "170 kaarten" for the built-in deck, "24 nummers" for a playlist. */
export function deckCount(deck, n = deck?.cards?.length ?? 0) {
  if (deck?.kind === 'playlist') return `${n} ${n === 1 ? 'nummer' : 'nummers'}`;
  return `${n} ${n === 1 ? 'kaart' : 'kaarten'}`;
}

/** A tappable line that leads to the playlist screen. */
export function deckLineHtml(deck, { testid = 'game-deck', count } = {}) {
  return `<a class="deck-line" href="#/playlists" data-testid="${testid}" data-deck-kind="${esc(deck?.kind || 'builtin')}">
    ${musicIcon}<span class="deck-line-text"><span class="deck-line-label">Muziek:</span> <b class="deck-line-name">${esc(deckLabel(deck))}</b><span class="deck-line-count"> · ${esc(deckCount(deck, count))}</span></span><span class="deck-line-change">wijzig</span>
  </a>`;
}
