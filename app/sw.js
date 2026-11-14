// TimeTunesr service worker.
// Strategy: network-first (with revalidation) for the app shell and deck, so a
// new deploy is picked up on the next load whenever the phone is online; the
// cache is only a fallback for offline use. Audio and the iTunes API are
// cross-origin and are never cached here; the same goes for Spotify
// (api.spotify.com, accounts.spotify.com).
// Bump VERSION when the list below changes; old caches are removed on activate.
const VERSION = 'v3';
const CACHE = `timetunesr-shell-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'css/bingo.css',
  'js/main.js',
  'js/logic.js',
  'js/deck.js',
  'js/player.js',
  'js/scanner.js',
  'js/ui.js',
  'js/screens/start.js',
  'js/screens/scan.js',
  'js/screens/card.js',
  'js/screens/answer.js',
  'js/screens/playerview.js',
  'js/screens/game.js',
  'js/screens/print.js',
  'js/screens/rules.js',
  'js/bingo.js',
  'js/screens/bingo.js',
  'js/screens/settings.js',
  'js/screens/devices.js',
  'js/spotify.js',
  'js/spotify-match.js',
  'js/pkce.js',
  'config.js',
  'css/settings.css',
  'css/playlists.css',
  'js/playlist-logic.js',
  'js/playlists.js',
  'js/itunes.js',
  'js/spotify-playlists.js',
  'js/screens/playlists.js',
  'js/screens/playlist.js',
  'js/screens/deckline.js',
  'vendor/jsQR.js',
  'vendor/qrcode-generator.mjs',
  'data/deck.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'css/multi.css',
  'js/multi/code.js',
  'js/multi/match.js',
  'js/multi/game.js',
  'js/multi/protocol.js',
  'js/multi/transport.js',
  'js/multi/host-session.js',
  'js/multi/client-session.js',
  'js/screens/room-ui.js',
  'js/screens/room-host.js',
  'js/screens/room-player.js',
  'vendor/peerjs.min.js',
  'js/multi/server-protocol.js',
  'js/multi/server-session.js',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('timetunesr-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // audio, iTunes, Spotify: straight to network, never cached
  // Back from the Spotify login (?code=&state=): let the browser load it untouched.
  if (req.mode === 'navigate' && url.searchParams.has('state') && (url.searchParams.has('code') || url.searchParams.has('error'))) return;
  if (req.headers.has('range')) return;
  // the room server ("Samen spelen") on the same Worker: always live, never cached
  if (/^\/(health|rooms)(\/|$)/.test(url.pathname)) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const isNav = req.mode === 'navigate';
  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(isNav ? 'index.html' : req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline: fall back to cache */ }
  const cached = await cache.match(isNav ? 'index.html' : req, { ignoreSearch: isNav });
  if (cached) return cached;
  return network; // nothing cached: wait for the network after all
}
