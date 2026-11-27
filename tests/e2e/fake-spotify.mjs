// A small fake Spotify Web API for the music e2e suites (the February 2026 shape:
// GET /me/playlists with `items.total`, GET /playlists/{id}/items with entries in `item`),
// plus the bits of the player API a round touches (one speaker). Predictable, counted, no network.

export const SP_CLIENT_ID = '0123456789abcdef0123456789abcdef';
export const SP_PLAYBACK = 'user-read-playback-state user-modify-playback-state';
export const SP_PLAYLIST_SCOPES = 'playlist-read-private playlist-read-collaborative';

/** A Spotify track object (22-character id from `id`; release_date gives the album year). */
export const spTrack = ({ id, title, artist, album = 'Album', date = '2015-01-01', isrc = null }) => ({
  type: 'track', id: String(id).replace(/[^0-9A-Za-z]/g, '').padEnd(22, 'x').slice(0, 22), uri: `spotify:track:${id}`, name: title,
  artists: [{ name: artist }], album: { name: album, release_date: date, release_date_precision: date.length === 4 ? 'year' : 'day' },
  external_ids: isrc ? { isrc } : {}, duration_ms: 200000, is_local: false, is_playable: true,
});

/**
 * Serve `lists` ({ [id]: { name, owner = 'anna', collaborative, tracks: [spTrack], cover, forbidden } })
 * as the user's playlists. stats: { calls, delayMs } (delayMs slows the pages of songs down).
 */
export async function installFakeSpotify(ctx, lists) {
  const stats = { calls: [], delayMs: 0 };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await ctx.route('https://i.scdn.co/**', (route) => {
    const h = [...route.request().url()].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="hsl(${h},62%,46%)"/><circle cx="210" cy="90" r="45" fill="rgba(255,255,255,.3)"/></svg>` });
  });
  await ctx.route('https://api.spotify.com/v1/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' } });
    const u = new URL(req.url());
    const p = u.pathname.replace('/v1', '');
    stats.calls.push(`${req.method()} ${p}`);
    if (p === '/me') return json(route, 200, { id: 'anna', display_name: 'Anna Test', product: 'premium' });
    if (p === '/me/playlists') {
      return json(route, 200, {
        next: null,
        items: Object.entries(lists).map(([id, l]) => ({
          id, name: l.name, owner: { id: l.owner || 'anna' }, collaborative: !!l.collaborative,
          items: { total: l.total ?? l.tracks.length }, images: l.cover === false ? [] : [{ url: `https://i.scdn.co/image/${id}` }],
        })),
      });
    }
    const m = p.match(/^\/playlists\/([^/]+)(\/items)?$/);
    if (m) {
      const l = lists[m[1]];
      if (!l) return json(route, 404, { error: { status: 404, message: 'Resource not found' } });
      if (!m[2]) return json(route, 200, { name: l.name, owner: { id: l.owner || 'anna' } });
      if (l.forbidden) return json(route, 403, { error: { status: 403, message: 'Forbidden' } });
      if (stats.delayMs) await new Promise((r) => setTimeout(r, stats.delayMs));
      const off = Number(u.searchParams.get('offset')) || 0;
      const lim = Math.min(Number(u.searchParams.get('limit')) || 50, 50);
      const items = l.tracks.slice(off, off + lim).map((t) => ({ item: t }));
      return json(route, 200, { items, total: l.tracks.length, offset: off, limit: lim, next: off + lim < l.tracks.length ? 'more' : null });
    }
    // the player API a round touches: one speaker that plays whatever it is asked
    const device = { id: 'dev1', name: 'Woonkamer', type: 'Speaker', is_active: true, volume_percent: 60, supports_volume: true };
    if (p === '/me/player/devices') return json(route, 200, { devices: [device] });
    if (p === '/me/player' && req.method() === 'GET') return json(route, 200, { device, is_playing: true, progress_ms: 1000, item: null });
    if (p === '/search') return json(route, 200, { tracks: { items: [] } });
    if (p.startsWith('/me/player')) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    return json(route, 404, { error: { status: 404, message: 'Service not found' } });
  });
  return stats;
}

/** Before the app loads: a Spotify login (with these scopes), optionally Spotify as the music source. */
export async function spotifyLogin(ctx, { scope = `${SP_PLAYBACK} ${SP_PLAYLIST_SCOPES}`, source = null } = {}) {
  await ctx.addInitScript(([cid, sc, src]) => {
    try { localStorage.getItem('x'); } catch { return; }
    if (sessionStorage.getItem('__ttSpotifySeeded')) return;
    sessionStorage.setItem('__ttSpotifySeeded', '1');
    localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid));
    localStorage.setItem('timetunesr.spotify.token.v1', JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600e3, scope: sc, clientId: cid }));
    if (src) localStorage.setItem('timetunesr.settings.v1', JSON.stringify({ source: src, limit: 60 }));
  }, [SP_CLIENT_ID, scope, source]);
}
