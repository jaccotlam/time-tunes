// App bootstrap: hash router, service worker, install prompt.
import { loadDeck } from './deck.js';
import * as player from './player.js';
import { esc, icons } from './ui.js';
import * as startScreen from './screens/start.js';
import * as scanScreen from './screens/scan.js';
import * as cardScreen from './screens/card.js';
import * as gameScreen from './screens/game.js';
import * as printScreen from './screens/print.js';
import * as rulesScreen from './screens/rules.js';
import * as bingoScreen from './screens/bingo.js';
import * as settingsScreen from './screens/settings.js';
import * as spotify from './spotify.js';
import * as playlistsScreen from './screens/playlists.js';
import * as playlistScreen from './screens/playlist.js';
import * as roomHostScreen from './screens/room-host.js';
import * as roomPlayerScreen from './screens/room-player.js';

const routes = [
  { re: /^#?\/?$/, screen: startScreen, needsDeck: false },
  { re: /^#\/scan\/?$/, screen: scanScreen, needsDeck: true },
  { re: /^#\/c\/(~?[0-9A-Za-z]+)\/?$/, screen: cardScreen, needsDeck: true },
  { re: /^#\/spel\/?$/, screen: gameScreen, needsDeck: true },
  { re: /^#\/print(?:\/([A-Za-z0-9_-]+))?\/?$/, screen: printScreen, needsDeck: true },
  { re: /^#\/regels\/?$/, screen: rulesScreen, needsDeck: false },
  { re: /^#\/bingo\/?$/, screen: bingoScreen, needsDeck: true },
  { re: /^#\/instellingen\/?$/, screen: settingsScreen, needsDeck: false },
  { re: /^#\/playlists\/?$/, screen: playlistsScreen, needsDeck: false },
  { re: /^#\/playlists\/([A-Za-z0-9_-]+)\/?$/, screen: playlistScreen, needsDeck: false },
  { re: /^#\/pl\/(.+)$/, screen: playlistsScreen, needsDeck: false },
  { re: /^#\/spelleider\/?$/, screen: roomHostScreen, needsDeck: true },
  { re: /^#\/kamer(?:\/([A-Za-z]{4}))?\/?$/, screen: roomPlayerScreen, needsDeck: false },
];

const root = document.getElementById('app');
let cleanup = null;
let renderSeq = 0;

export const install = { prompt: null, listeners: new Set() };
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  install.prompt = e;
  install.listeners.forEach((fn) => fn());
});

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  const match = routes.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (e) { console.error(e); }
  }
  cleanup = null;
  if (!match) { navigate('#/'); return; }

  let deck = null;
  if (match.r.needsDeck) {
    try {
      deck = await loadDeck();
    } catch {
      if (seq !== renderSeq) return;
      renderDeckError();
      return;
    }
    if (seq !== renderSeq) return;
  } else {
    loadDeck().catch(() => {});
  }
  root.dataset.route = match.r.screen.name;
  document.body.dataset.route = match.r.screen.name;
  window.scrollTo(0, 0);
  cleanup = match.r.screen.render(root, { deck, params: match.m.slice(1), navigate, install });
  const h = root.querySelector('h1, h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}

function renderDeckError() {
  root.innerHTML = `<section class="screen screen-center" data-testid="screen-deck-error">
    <div class="panel">
      <h1>Kaarten niet geladen</h1>
      <p>Het kaartendeck kon niet worden geladen. Controleer je internetverbinding en probeer het opnieuw.</p>
      <div class="stack">
        <button class="btn btn-primary" data-testid="deck-retry" id="retry">${icons.restart}<span>Opnieuw proberen</span></button>
        <a class="btn btn-ghost" href="#/">${icons.home}<span>Naar start</span></a>
      </div>
    </div>
  </section>`;
  root.querySelector('#retry').addEventListener('click', () => route());
}

// iOS: unlock audio inside the first real user gesture.
const unlockOnce = () => {
  player.unlock();
  window.removeEventListener('pointerdown', unlockOnce, true);
  window.removeEventListener('keydown', unlockOnce, true);
};
window.addEventListener('pointerdown', unlockOnce, true);
window.addEventListener('keydown', unlockOnce, true);

// Back from the Spotify login (?code=..&state=..): cleans the URL before routing.
spotify.handleRedirect();

window.addEventListener('hashchange', route);
route();

// Service worker: network-first app shell, so updates always win when online.
if ('serviceWorker' in navigator && window.isSecureContext && !/[?&]nosw\b/.test(location.search)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (reg && reg.update) reg.update().catch(() => {});
    }).catch((err) => console.warn('Service worker niet geregistreerd:', err));
  });
}

window.addEventListener('offline', () => document.body.classList.add('is-offline'));
window.addEventListener('online', () => document.body.classList.remove('is-offline'));
if (navigator.onLine === false) document.body.classList.add('is-offline');

// expose for debugging / e2e
window.__tt = { navigate, player, esc, spotify };
