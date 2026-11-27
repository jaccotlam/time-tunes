// "Muziek: <deck> · N nummers — wijzig": shown on the start screen and in the game setups.
import { esc } from '../ui.js';
import * as playlists from '../playlists.js';
import { musicSource } from '../deck.js';
import { heldText } from './music-bits.js';

const musicIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function deckLabel(deck) {
  return deck?.kind === 'playlist' ? deck.name : 'TimeTunesr-deck';
}

/** Count text: "170 kaarten" for the built-in deck, "24 nummers" for a playlist. */
export function deckCount(deck, n = deck?.cards?.length ?? 0) {
  if (deck?.kind === 'playlist') return `${n} ${n === 1 ? 'nummer' : 'nummers'}`;
  return `${n} ${n === 1 ? 'kaart' : 'kaarten'}`;
}

/**
 * Where a game starts: "Speelt met 33 van 120 nummers; van 87 andere wordt het jaartal nog opgezocht
 * of nagekeken" while songs of a catalogue list wait for their year check (the deck rule in
 * playlist-logic.js), else ''.
 */
export function heldNoteHtml(deck) {
  if (deck?.kind !== 'playlist') return '';
  const p = playlists.get(deck.id);
  if (!p) return '';
  const c = playlists.deckCounts(p, musicSource());
  if (!c.held) return '';
  return `<p class="deck-held small" data-testid="deck-held">${esc(heldText(c))}</p>`;
}

/** A tappable line that leads to the playlist screen (+ the note above when songs are held back). */
export function deckLineHtml(deck, { testid = 'game-deck', count } = {}) {
  return `<a class="deck-line" href="#/playlists" data-testid="${testid}" data-deck-kind="${esc(deck?.kind || 'builtin')}">
    ${musicIcon}<span class="deck-line-text"><span class="deck-line-label">Muziek:</span> <b class="deck-line-name">${esc(deckLabel(deck))}</b><span class="deck-line-count"> · ${esc(deckCount(deck, count))}</span></span><span class="deck-line-change">wijzig</span>
  </a>${heldNoteHtml(deck)}`;
}
