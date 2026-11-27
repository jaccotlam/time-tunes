// The ACTIVE deck: the built-in deck (app/data/deck.json) or one of the player's own
// playlists (js/playlists.js). Both come in the same shape:
// { version, country, id, name, kind: 'builtin'|'playlist', cards, byId }, every card
// { id, title, artist, year, itunesId, previewUrl, trackViewUrl, spotifyId?, deezerId?, isrc? }
// (+ `code` for playlist cards: the self-contained QR code, see playlist-logic.js).
import { padId } from './logic.js';
import { BUILTIN_ID, BUILTIN_NAME, playlistDeck, playable } from './playlist-logic.js';
import * as playlists from './playlists.js';
import * as spotify from './spotify.js';

let deckPromise = null;

/** The built-in deck from data/deck.json (loaded once). */
export function loadBuiltinDeck() {
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
        return {
          version: json?.version ?? 1, country: json?.country || 'NL',
          id: BUILTIN_ID, name: BUILTIN_NAME, kind: 'builtin', cards, byId,
        };
      })
      .catch((err) => {
        deckPromise = null; // allow retry
        throw err;
      });
  }
  return deckPromise;
}

/** The active deck (built-in or own playlist). Same shape as before, plus id/name/kind. */
export function loadDeck() {
  const id = playlists.getActiveId();
  if (id !== BUILTIN_ID) {
    const p = playlists.get(id);
    if (p) return Promise.resolve(playlistDeck(p, musicSource()));
  }
  return loadBuiltinDeck();
}

/** Name and id of the active deck without loading anything. */
export function activeDeckInfo() {
  const id = playlists.getActiveId();
  const p = id !== BUILTIN_ID ? playlists.get(id) : null;
  return p ? { id: p.id, name: p.name, kind: 'playlist' } : { id: BUILTIN_ID, name: BUILTIN_NAME, kind: 'builtin' };
}

/** Find a card by (possibly unpadded) id. */
export function findCard(deck, id) {
  if (!deck || id == null) return null;
  const s = String(id);
  return deck.byId.get(s) || deck.byId.get(padId(s)) || null;
}

/** The music source of this phone: whole songs via Spotify (chosen and connected), else the fragments. */
export function musicSource() {
  return spotify.getSettings().source === 'spotify' && spotify.isConnected() ? 'spotify' : 'preview';
}

/** Can this card be played in a game with this phone's music source? (playable() in playlist-logic.js) */
export function isPlayable(card) {
  return playable(card, musicSource());
}

/**
 * What a running game keeps of its deck, so it survives a switch to another deck:
 * { id, name, cards: { [id]: card } } with only the fields playing needs.
 */
export function deckSnapshot(deck, cards) {
  const slim = (c) => {
    const o = { id: c.id, title: c.title, artist: c.artist, year: c.year, itunesId: c.itunesId ?? null, previewUrl: c.previewUrl ?? null, trackViewUrl: c.trackViewUrl ?? null };
    if (c.spotifyId) o.spotifyId = c.spotifyId;
    if (c.deezerId) o.deezerId = c.deezerId;
    if (c.isrc) o.isrc = c.isrc;
    return o;
  };
  return { id: deck.id || BUILTIN_ID, name: deck.name || BUILTIN_NAME, cards: Object.fromEntries(cards.map((c) => [c.id, slim(c)])) };
}
