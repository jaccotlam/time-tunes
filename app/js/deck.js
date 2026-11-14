// Loads app/data/deck.json once and indexes it by card id.
import { padId } from './logic.js';

let deckPromise = null;

export function loadDeck() {
  if (!deckPromise) {
    deckPromise = fetch('data/deck.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        const cards = (Array.isArray(json?.cards) ? json.cards : [])
          .filter((c) => c && c.id != null)
          .map((c) => ({ ...c, id: String(c.id), year: Number(c.year) }));
        cards.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
        const byId = new Map(cards.map((c) => [c.id, c]));
        return { version: json?.version ?? 1, country: json?.country || 'NL', cards, byId };
      })
      .catch((err) => {
        deckPromise = null; // allow retry
        throw err;
      });
  }
  return deckPromise;
}

/** Find a card by (possibly unpadded) id. */
export function findCard(deck, id) {
  if (!deck || id == null) return null;
  const s = String(id);
  return deck.byId.get(s) || deck.byId.get(padId(s)) || null;
}
