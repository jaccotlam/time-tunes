// Reading the player's Spotify playlists for "Eigen playlist" (Web API, Development Mode).
// Since the February 2026 changes (developer.spotify.com, "February 2026 migration guide"):
// - the items endpoint is GET /playlists/{id}/items (was /tracks), each entry has `item`
//   (formerly `track`); we accept both;
// - items are only returned for playlists the user OWNS or COLLABORATES on; for other
//   playlists Spotify answers 403 (or gives metadata without items);
// - scopes: playlist-read-private (+ playlist-read-collaborative), so a player who connected
//   for playback only has to connect once more.
// - pages hold at most 50 items (the documented maximum of `limit`); after the first page (which
//   gives `total`) the next pages are fetched PAGE_PARALLEL at a time, a 429 waits Retry-After.
import * as spotify from './spotify.js';
import { spotifyYear, cleanIsrc, MAX_TRACKS } from './playlist-logic.js';

export const MAX_IMPORT = MAX_TRACKS;
export const PAGE_SIZE = 50;
const PAGE_PARALLEL = 3;
const RATE_TRIES = 3;

export class PlaylistError extends Error {
  // cause: the SpotifyError behind it (status, what Spotify said), for spotify-links.js notRegistered
  constructor(code, cause = null) { super(code); this.code = code; if (cause) this.cause = cause; }
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
  if (e?.code === 'forbidden' || e?.code === 'not-allowed') return new PlaylistError(forItems ? 'not-own' : 'scope', e);
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
    isrc: cleanIsrc(t.external_ids?.isrc),
  };
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** One page of a playlist's items (a 429 waits Retry-After, a few times). */
async function itemsPage(id, offset, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await spotify.api(`/playlists/${id}/items`, { query: { limit: PAGE_SIZE, offset, additional_types: 'track' } });
    } catch (e) {
      if (e?.code === 'rate' && attempt < RATE_TRIES - 1 && !signal?.aborted) { await sleep(Math.min(30, e.retryAfter || 2) * 1000, signal); continue; }
      throw mapError(e, { forItems: true });
    }
  }
}

/**
 * All songs of a playlist (paged, max `max` = MAX_IMPORT), in playlist order, without
 * duplicates. A longer list gives its first `max` songs and the array carries capped: true and
 * total (say so with cappedMessage). onProgress(itemsRead, total). Every track: see entryToTrack (year from Spotify,
 * ISRC when Spotify gives one).
 */
export async function playlistTracks(id, { onProgress, signal, max = MAX_IMPORT } = {}) {
  const out = [];
  const seen = new Set();
  const take = (j) => {
    for (const entry of j.items) {
      const t = entryToTrack(entry);
      if (t && !seen.has(t.spotifyId) && out.length < max) { seen.add(t.spotifyId); out.push(t); }
    }
  };
  const first = await itemsPage(id, 0, signal);
  if (!first || !Array.isArray(first.items)) throw new PlaylistError('not-own'); // metadata only: not the user's playlist
  const total = Number(first.total) || first.items.length;
  take(first);
  let read = first.items.length;
  onProgress?.(Math.min(read, total), total);
  let more = !!first.next && first.items.length > 0;
  let offset = read;
  while (more && out.length < max && !signal?.aborted) {
    // the next few pages at the same time; entries that are no song (episodes, local files) do not count
    const offsets = [];
    for (let i = 0; i < PAGE_PARALLEL && offset + i * PAGE_SIZE < total; i++) offsets.push(offset + i * PAGE_SIZE);
    if (!offsets.length) break;
    const pages = await Promise.all(offsets.map((o) => itemsPage(id, o, signal)));
    for (const j of pages) {
      if (!j || !Array.isArray(j.items) || !j.items.length) { more = false; break; }
      take(j);
      read += j.items.length;
      if (!j.next) { more = false; break; }
    }
    offset = offsets[offsets.length - 1] + PAGE_SIZE;
    onProgress?.(Math.min(read, total), total);
  }
  if (!out.length) throw new PlaylistError('empty');
  // Spotify pages the list from the top: a longer list can only be read up to the maximum
  if (out.length >= max && read < total) { out.capped = true; out.total = total; }
  return out;
}

/** The honest line for a list longer than the maximum (playlistTracks result has `capped`). */
export const cappedMessage = (total, max = MAX_IMPORT) => `Deze playlist heeft ${total} nummers; alleen de eerste ${max} zijn opgehaald (Spotify geeft de lijst van boven naar beneden). Bij het spelen komt elk van deze ${max} even vaak aan de beurt.`;

/** Cover of a playlist: the first image when it is an https URL (shown with referrerpolicy no-referrer), else null. */
function coverOf(p) {
  const url = Array.isArray(p?.images) ? p.images.find((im) => typeof im?.url === 'string')?.url : null;
  return typeof url === 'string' && url.length < 1200 && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

/** The user's own and collaborative playlists: [{ id, name, count, picture }] (picture: https or null). */
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
      out.push({ id: p.id, name: p.name || 'Zonder naam', count: Number.isFinite(count) ? count : null, picture: coverOf(p) });
    }
    offset += (j?.items || []).length;
    if (!j?.next) break;
  }
  return out;
}
