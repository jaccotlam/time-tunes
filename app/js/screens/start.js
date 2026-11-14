import { loadDeck, activeDeckInfo } from '../deck.js';
import { deckLineHtml } from './deckline.js';
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

// Local icons (kept here so ui.js stays untouched).
const ico = (body) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const gridIcon = ico('<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/>');
const timelineIcon = ico('<path d="M3 12h18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4" y="5" width="4.5" height="5" rx="1" fill="currentColor"/><rect x="9.8" y="14" width="4.5" height="5" rx="1" fill="currentColor"/><rect x="15.5" y="5" width="4.5" height="5" rx="1" fill="currentColor"/>');
const gearIcon = ico('<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
const cardsIcon = ico('<rect x="3" y="6" width="11" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" transform="rotate(-8 8.5 13)"/><rect x="10" y="4" width="11" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>');
const phoneIcon = ico('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');

function entry({ href, testid, icon, title, text, cls = '' }) {
  return `<a class="entry ${cls}" href="${href}" data-testid="${testid}">
    <span class="entry-ico">${icon}</span>
    <span class="entry-text"><b>${title}</b><small>${text}</small></span>
  </a>`;
}

export function render(root, { install }) {
  root.innerHTML = `<section class="screen screen-start" data-testid="screen-start">
    <header class="hero hero-compact">
      <div class="hero-logo">${logoSvg('logo logo-hero')}</div>
      <div class="hero-words">
        <h1 class="hero-title">${wordmark()}</h1>
        <p class="tagline">Luister. Raad het jaar. Speel samen.</p>
      </div>
    </header>
    <nav class="modes" aria-label="Hoofdmenu">
      <section class="mode mode-cards" data-testid="mode-cards" aria-labelledby="mode-cards-title">
        <h2 class="mode-title" id="mode-cards-title">${cardsIcon}<span>Met kaartjes</span><small>geprinte kaarten met QR-code</small></h2>
        ${entry({ href: '#/scan', testid: 'start-scan', icon: icons.scan, title: 'Scan een kaart', text: 'De app speelt het fragment, de kaart verklapt het antwoord. Voor Tijdlijn én Bingo.', cls: 'entry-primary' })}
        ${entry({ href: '#/print', testid: 'start-print', icon: icons.print, title: 'Kaarten printen', text: 'Muziekkaartjes en bingokaarten om zelf te printen.' })}
      </section>
      <section class="mode mode-app" data-testid="mode-app" aria-labelledby="mode-app-title">
        <h2 class="mode-title" id="mode-app-title">${phoneIcon}<span>Alleen de app</span><small>geen kaartjes nodig, geef de telefoon door</small></h2>
        ${entry({ href: '#/spel', testid: 'start-digital', icon: timelineIcon, title: 'Tijdlijn', text: 'Leg elk nummer op de goede plek in je eigen tijdlijn.', cls: 'entry-app' })}
        ${entry({ href: '#/bingo', testid: 'start-bingo', icon: gridIcon, title: 'Bingo', text: 'Claim vakjes op je eigen bingokaart. Eerst een volle rij wint.', cls: 'entry-app' })}
      </section>
    </nav>
    <div class="start-links">
      <a class="btn btn-small btn-ghost" href="#/regels" data-testid="start-rules">${icons.book}<span>Spelregels</span></a>
      <a class="btn btn-small btn-ghost" href="#/instellingen" data-testid="start-settings">${gearIcon}<span>Instellingen</span></a>
    </div>
    <div class="install-slot">${installHint(install)}</div>
    <div class="deck-slot">${deckLineHtml({ kind: activeDeckInfo().kind, name: activeDeckInfo().name, cards: [] }, { testid: 'deck-info', count: '…' })}</div><p class="foot"><span class="version" data-testid="app-version">v2</span></p>
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
    const info = root.querySelector('.deck-slot');
    if (info) info.innerHTML = deckLineHtml(deck, { testid: 'deck-info' });
  }).catch(() => {
    const info = root.querySelector('[data-testid="deck-info"] .deck-line-text');
    if (info) info.textContent = 'Kaartendeck nog niet geladen (offline?)';
  });

  return () => {
    install.listeners.delete(onPrompt);
    root.removeEventListener('click', onClick);
  };
}
