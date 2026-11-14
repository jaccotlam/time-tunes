// Reading the player's Spotify playlists for "Eigen playlist" (Web API, Development Mode).
// Since the February 2026 changes (developer.spotify.com, "February 2026 migration guide"):
// - the items endpoint is GET /playlists/{id}/items (was /tracks), each entry has `item`
//   (formerly `track`); we accept both;
// - items are only returned for playlists the user OWNS or COLLABORATES on; for other
//   playlists Spotify answers 403 (or gives metadata without items);
// - scopes: playlist-read-private (+ playlist-read-collaborative), so a player who connected
//   for playback only has to connect once more.
import * as spotify from './spotify.js';
import { spotifyYear } from './playlist-logic.js';

export const MAX_IMPORT = 500;

export class PlaylistError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const MESSAGES = {
  'not-own': 'Spotify geeft alleen de nummers van playlists die je zelf hebt gemaakt of waaraan je meewerkt. Tip: maak in Spotify een eigen playlist en zet de nummers daarin (Toevoegen aan playlist), of plak de lijst hier als tekst.',
  'not-found': 'Deze playlist bestaat niet (meer) of is niet te openen met jouw account.',
  scope: 'Om playlists te lezen moet je Spotify één keer opnieuw toestemming geven.',
  empty: 'Er staan geen nummers in deze playlist (podcasts en lokale bestanden tellen niet mee).',
};

export function errorMessage(e) {
  return MESSAGES[e?.code] || spotify.errorMessage(e);
}

/** Does the token allow reading playlists? */
export const canRead = () => spotify.isConnected() && spotify.hasScopes(spotify.PLAYLIST_SCOPES);

function mapError(e, { forItems = false } = {}) {
  if (e?.code === 'forbidden' || e?.code === 'not-allowed') return new PlaylistError(forItems ? 'not-own' : 'scope');
  if (e?.code === 'unavailable' && e.status === 404) return new PlaylistError('not-found');
  return e;
}

/** Name of a playlist, or throws PlaylistError. */
export async function playlistName(id) {
  try {
    const j = await spotify.api(`/playlists/${id}`, { query: { fields: 'name,owner(id,display_name),collaborative' } });
    return { name: j?.name || 'Spotify-playlist', owner: j?.owner?.display_name || j?.owner?.id || '' };
  } catch (e) { throw mapError(e); }
}

/** "Song - Remastered 2011" / "Song - 2009 Remaster" / "Song - Single Version" -> "Song". */
export function cleanSpotifyTitle(title) {
  const t = String(title || '').trim();
  return t.replace(/\s+-\s+(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?(?:remaster(?:ed)?|mono|stereo|single version|radio edit|album version|original mix)\b.*$/i, '').trim() || t;
}

/** One playlist entry -> { spotifyId, title, artist, album, spYear, isrc } or null (episode, local file, gone). */
export function entryToTrack(entry) {
  const t = entry?.item || entry?.track;
  if (!t || entry?.is_local || t.is_local || (t.type && t.type !== 'track') || !t.id) return null;
  return {
    spotifyId: t.id,
    title: cleanSpotifyTitle(t.name),
    artist: (t.artists || []).map((a) => a?.name).filter(Boolean).join(', '),
    album: String(t.album?.name || ''),
    spYear: spotifyYear(t.album?.release_date),
    isrc: t.external_ids?.isrc || null,
  };
}

/** All songs of a playlist (paged, max MAX_IMPORT). */
export async function playlistTracks(id, { onProgress, signal } = {}) {
  const out = [];
  let offset = 0;
  let total = null;
  for (;;) {
    if (signal?.aborted) break;
    let j;
    try {
      j = await spotify.api(`/playlists/${id}/items`, { query: { limit: 50, offset, additional_types: 'track' } });
    } catch (e) { throw mapError(e, { forItems: true }); }
    if (!j || !Array.isArray(j.items)) {
      if (offset === 0) throw new PlaylistError('not-own'); // metadata only: not the user's playlist
      break;
    }
    total = Number(j.total) || total;
    for (const entry of j.items) {
      const t = entryToTrack(entry);
      if (t && !out.some((x) => x.spotifyId === t.spotifyId)) out.push(t);
    }
    offset += j.items.length;
    onProgress?.(Math.min(offset, total || offset), total || offset);
    if (!j.next || !j.items.length || out.length >= MAX_IMPORT) break;
  }
  if (!out.length) throw new PlaylistError('empty');
  return out.slice(0, MAX_IMPORT);
}

/** The user's own and collaborative playlists: [{ id, name, count }]. */
export async function myPlaylists() {
  let me;
  try { me = await spotify.api('/me'); } catch (e) { throw mapError(e); }
  const out = [];
  let offset = 0;
  for (let page = 0; page < 4; page++) {
    let j;
    try { j = await spotify.api('/me/playlists', { query: { limit: 50, offset } }); } catch (e) { throw mapError(e); }
    for (const p of j?.items || []) {
      if (!p?.id) continue;
      if (p.owner?.id !== me?.id && !p.collaborative) continue;
      const count = Number(p.items?.total ?? p.tracks?.total);
      out.push({ id: p.id, name: p.name || 'Zonder naam', count: Number.isFinite(count) ? count : null });
    }
    offset += (j?.items || []).length;
    if (!j?.next) break;
  }
  return out;
}
