// The player's most played songs on Spotify ("een soort Wrapped"): GET /me/top/tracks
// (Web API, scope user-top-read). Per the Spotify reference (checked November 2026):
// time_range short_term (about 4 weeks) | medium_term (about 6 months) | long_term (about a
// year or longer), limit 1..50, offset. Track objects have id, name, artists, album
// (release_date, name) and external_ids; `popularity` is deprecated and not used.
// In Development Mode only accounts the owner added under User Management may use the app
// (at most 5); Spotify answers 403 for everybody else.
import * as spotify from './spotify.js';
import { entryToTrack } from './spotify-playlists.js';
import { TOP_POOL, validRange, DEFAULT_RANGE } from './multi/mix.js';

export class TopError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const MESSAGES = {
  scope: 'Om je meest geluisterde nummers te lezen moet je Spotify één keer (opnieuw) toestemming geven.',
  empty: 'Spotify heeft nog geen meest geluisterde nummers voor deze periode. Kies een langere periode, of luister eerst wat meer.',
  'no-client': 'Op deze TimeTunesr-site is nog geen Spotify Client ID ingesteld. De eigenaar van de site zet die in app/config.js (SPOTIFY_CLIENT_ID); zie de uitleg in README.md bij “Spotify koppelen”.',
  'not-allowed': 'Dit Spotify-account is (nog) niet toegelaten in de Spotify-app van de eigenaar. Vraag de eigenaar je toe te voegen onder User Management in het Spotify-dashboard (maximaal 5 gebruikers in Development Mode).',
};

export function errorMessage(e) {
  return MESSAGES[e?.code] || spotify.errorMessage(e);
}

/** Does the token allow reading the top songs? */
export const canRead = () => spotify.isConnected() && spotify.hasScopes(spotify.TOP_SCOPES);

/**
 * The user's top songs for `range`: [{ spotifyId, title, artist, album, spYear, isrc }],
 * best first, at most `limit` (max 50). Throws TopError / SpotifyError.
 */
export async function topTracks({ range = DEFAULT_RANGE, limit = TOP_POOL } = {}) {
  const n = Math.max(1, Math.min(50, Number(limit) || TOP_POOL));
  let j;
  try {
    j = await spotify.api('/me/top/tracks', { query: { time_range: validRange(range) ? range : DEFAULT_RANGE, limit: n, offset: 0 } });
  } catch (e) {
    if (e?.code === 'forbidden') throw new TopError('scope');
    throw e;
  }
  const out = [];
  for (const t of Array.isArray(j?.items) ? j.items : []) {
    const x = entryToTrack({ item: t });
    if (x && !out.some((y) => y.spotifyId === x.spotifyId)) out.push(x);
  }
  if (!out.length) throw new TopError('empty');
  return out.slice(0, n);
}
