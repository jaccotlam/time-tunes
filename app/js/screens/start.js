import { loadDeck } from '../deck.js';
import { icons, logoSvg, wordmark, esc } from '../ui.js';

export const name = 'start';

function installHint(install) {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return '';
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (install.prompt) {
    return `<div class="hint" data-testid="install-hint">
      <p><strong>Tip:</strong> installeer TimeTunesr als app; dan start hij schermvullend vanaf je beginscherm.</p>
      <button class="btn btn-small btn-ghost" data-testid="install-button" data-action="install">${icons.plus}<span>Installeer app</span></button>
    </div>`;
  }
  if (isIOS) {
    return `<div class="hint" data-testid="install-hint">
      <p><strong>Tip:</strong> tik in Safari op <span class="inline-ico">${icons.share}</span> <em>Deel</em> en kies <em>Zet op beginscherm</em>. Dan start TimeTunesr als app.</p>
    </div>`;
  }
  return `<div class="hint" data-testid="install-hint">
    <p><strong>Tip:</strong> zet TimeTunesr op je beginscherm via het browsermenu (<em>Toevoegen aan startscherm</em> of <em>App installeren</em>). Dan start hij schermvullend.</p>
  </div>`;
}

export function render(root, { install }) {
  root.innerHTML = `<section class="screen screen-start" data-testid="screen-start">
    <header class="hero">
      <div class="hero-logo">${logoSvg('logo logo-hero')}</div>
      <h1 class="hero-title">${wordmark()}</h1>
      <p class="tagline">Luister. Raad het jaar. Bouw je tijdlijn.</p>
    </header>
    <nav class="menu" aria-label="Hoofdmenu">
      <a class="btn btn-primary btn-xl" href="#/scan" data-testid="start-scan">${icons.scan}<span>Scan een kaart</span></a>
      <a class="btn btn-secondary btn-xl" href="#/spel" data-testid="start-digital">${icons.users}<span>Speel zonder kaarten</span></a>
      <div class="menu-row">
        <a class="btn btn-ghost" href="#/print" data-testid="start-print">${icons.print}<span>Kaarten printen</span></a>
        <a class="btn btn-ghost" href="#/regels" data-testid="start-rules">${icons.book}<span>Spelregels</span></a>
      </div>
    </nav>
    <div class="install-slot">${installHint(install)}</div>
    <p class="foot" data-testid="deck-info">&nbsp;</p>
  </section>`;

  const slot = root.querySelector('.install-slot');
  const onPrompt = () => { slot.innerHTML = installHint(install); };
  install.listeners.add(onPrompt);
  root.addEventListener('click', onClick);

  async function onClick(e) {
    const btn = e.target.closest('[data-action="install"]');
    if (!btn || !install.prompt) return;
    const p = install.prompt;
    install.prompt = null;
    p.prompt();
    try { await p.userChoice; } catch { /* ignore */ }
    slot.innerHTML = installHint(install);
  }

  loadDeck().then((deck) => {
    const info = root.querySelector('[data-testid="deck-info"]');
    if (info) info.innerHTML = `${esc(deck.cards.length)} ${deck.cards.length === 1 ? 'kaart' : 'kaarten'} in het deck · fragmenten via Apple Music`;
  }).catch(() => {
    const info = root.querySelector('[data-testid="deck-info"]');
    if (info) info.textContent = 'Kaartendeck nog niet geladen (offline?)';
  });

  return () => {
    install.listeners.delete(onPrompt);
    root.removeEventListener('click', onClick);
  };
}
