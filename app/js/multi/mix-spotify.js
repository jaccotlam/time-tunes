// "Kies uit mijn playlists": the provider of the guests' playlist worker (mix-lists.js) that
// reads the guest's OWN Spotify playlists. Spotify's Web API (Development Mode, since the
// February 2026 changes) only gives the songs of playlists the user owns or collaborates on,
// so only those are offered (spotify-playlists.js myPlaylists: at most 200 lists, covers over
// https). The login itself (which link, the scopes) is done by mix-share.js before the picker
// opens; this module only reads.
import * as sp from '../spotify-playlists.js';
import { MAX_TRACKS } from '../playlist-logic.js';

/** Most songs read from one playlist (the worker samples from these, spread over the lists). */
export const LIST_READ_MAX = MAX_TRACKS;

/**
 * The provider: { lists, tracks, errorMessage } (shape: see the top of mix-lists.js).
 * deps (tests): { myPlaylists, playlistTracks, errorMessage } in place of spotify-playlists.js.
 */
export function spotifyListProvider(deps = {}) {
  const myPlaylists = deps.myPlaylists || sp.myPlaylists;
  const playlistTracks = deps.playlistTracks || sp.playlistTracks;
  const message = deps.errorMessage || sp.errorMessage;
  return {
    kind: 'spotify',
    async lists() {
      const items = await myPlaylists();
      // myPlaylists already keeps only own and collaborative lists; the worker cleans the fields
      return (Array.isArray(items) ? items : []).map((p) => ({
        id: p.id, title: p.name, count: Number.isSafeInteger(p.count) ? p.count : null, picture: p.picture || null,
      }));
    },
    async tracks(id, { signal, onProgress } = {}) {
      const list = await playlistTracks(id, { signal, onProgress, max: LIST_READ_MAX });
      return (Array.isArray(list) ? list : []).map((t) => ({
        spotifyId: t.spotifyId, title: t.title, artist: t.artist, album: t.album, year: t.spYear ?? null, isrc: t.isrc || null,
      }));
    },
    errorMessage(e) { return message(e); },
  };
}
