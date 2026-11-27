// Songs played on this phone, per deck (the built-in deck or a playlist id), so the next game
// with the same music starts with the songs that were not played yet (multi/order.js).
// localStorage: timetunesr.played.v1 = { [deckId]: { n, keys: { songKey: game number } } },
// at most LOCAL_DECKS decks and LOCAL_MAX songs per deck (the oldest go first). Used by the
// solo games and by a room that this phone hosts itself (no server); a server room keeps its
// own history on the server.
import { store } from './ui.js';
import { cleanHistory, nextGame, markPlayed, emptyHistory } from './multi/order.js';

export const KEY = 'timetunesr.played.v1';
export const LOCAL_MAX = 800;
export const LOCAL_DECKS = 4;

function readAll() {
  const all = store.get(KEY, null);
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

/** The history of this deck (for the order of a new game). */
export function historyFor(deckId) {
  const all = readAll();
  return Object.hasOwn(all, String(deckId)) ? cleanHistory(all[String(deckId)]) : emptyHistory();
}

function save(deckId, h) {
  const all = readAll();
  const id = String(deckId);
  delete all[id];
  all[id] = h; // the most recent deck last
  const ids = Object.keys(all);
  for (const old of ids.slice(0, Math.max(0, ids.length - LOCAL_DECKS))) delete all[old];
  store.set(KEY, all); // a full storage only loses this convenience
}

/** A new game with this deck begins. */
export function startedGame(deckId) { save(deckId, nextGame(historyFor(deckId))); }

/** This song (card with title / artist) was played in the current game of this deck. */
export function playedSong(deckId, card) {
  if (!card) return;
  const h = historyFor(deckId);
  if (!h.n) return;
  save(deckId, markPlayed(h, [card], LOCAL_MAX));
}
