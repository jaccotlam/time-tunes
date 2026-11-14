// Bouwt kaartjes met de print-opmaak van de app zelf (voorkant met QR, achterkant met antwoord).
import { sheetsHtml } from '../js/screens/print.js';

let deckPromise = null;
export function loadDeck() {
  deckPromise ||= fetch('../data/deck.json').then((r) => r.json()).then((json) => new Map(json.cards.map((c) => [String(c.id), c])));
  return deckPromise;
}

/** { front, back } als HTML, exact zoals de app ze op het printvel zet. */
export function faces(card, baseUrl) {
  const tmp = document.createElement('div');
  tmp.innerHTML = sheetsHtml([card], baseUrl);
  const front = tmp.querySelector(`.pc-front[data-card-id="${card.id}"]`).outerHTML;
  const back = tmp.querySelector(`.pc-back[data-card-id="${card.id}"]`).outerHTML;
  return { front, back };
}
