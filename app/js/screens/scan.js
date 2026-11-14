import { parseCardId, normalizeCardInput } from '../logic.js';
import { findCard } from '../deck.js';
import { startScanner, cameraSupport } from '../scanner.js';
import { icons, toast, vibrate, esc } from '../ui.js';
import * as player from '../player.js';

export const name = 'scan';

const MESSAGES = {
  insecure: {
    title: 'Camera niet beschikbaar',
    text: 'De camera werkt alleen via een beveiligde verbinding (https). Typ hieronder het kaartnummer, of open de app via de https-link.',
  },
  unsupported: {
    title: 'Geen camera-ondersteuning',
    text: 'Deze browser kan de camera niet gebruiken. Typ hieronder het nummer dat op de kaart staat, of scan de QR-code met de gewone camera-app.',
  },
  denied: {
    title: 'Geen toegang tot de camera',
    text: 'Je hebt de camera geweigerd. Sta cameratoegang toe in de instellingen van je browser, of typ hieronder het kaartnummer.',
  },
  nocamera: {
    title: 'Geen camera gevonden',
    text: 'Er is geen camera gevonden. Typ hieronder het nummer dat op de kaart staat.',
  },
  busy: {
    title: 'Camera is bezet',
    text: 'Een andere app gebruikt de camera. Sluit die app en probeer opnieuw, of typ het kaartnummer.',
  },
  failed: {
    title: 'Camera starten mislukt',
    text: 'De camera kon niet worden gestart. Probeer opnieuw of typ het kaartnummer.',
  },
};

export function render(root, { deck, navigate }) {
  player.stop();
  root.innerHTML = `<section class="screen screen-scan" data-testid="screen-scan">
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
      <h1 class="topbar-title">Scan een kaart</h1>
      <span class="topbar-spacer"></span>
    </header>
    <div class="viewfinder" data-state="starting" data-testid="viewfinder">
      <video class="vf-video" playsinline muted autoplay aria-hidden="true"></video>
      <div class="vf-frame" aria-hidden="true"><i></i><i></i><i></i><i></i><b class="vf-laser"></b></div>
      <div class="vf-status" data-testid="scan-status">Camera wordt gestart…</div>
      <div class="vf-error" data-testid="camera-error" hidden>
        <h2 class="vf-error-title"></h2>
        <p class="vf-error-text"></p>
        <button class="btn btn-small btn-ghost" data-action="retry" data-testid="camera-retry">${icons.restart}<span>Camera opnieuw proberen</span></button>
      </div>
    </div>
    <p class="scan-help">Richt de camera op de QR-code van een kaart. Het nummer start vanzelf, zonder titel of jaartal te verklappen.</p>
    <form class="manual" data-testid="manual-form" autocomplete="off">
      <label for="manual-id">${icons.keypad}<span>Of typ het kaartnummer</span></label>
      <div class="manual-row">
        <input id="manual-id" name="id" inputmode="numeric" enterkeyhint="go" maxlength="12" placeholder="bv. 042" data-testid="manual-input" aria-describedby="manual-msg">
        <button class="btn btn-primary" type="submit" data-testid="manual-submit">${icons.play}<span>Speel</span></button>
      </div>
      <p id="manual-msg" class="manual-msg" data-testid="manual-msg" role="alert"></p>
    </form>
  </section>`;

  const vf = root.querySelector('.viewfinder');
  const video = root.querySelector('video');
  const status = root.querySelector('.vf-status');
  const errBox = root.querySelector('.vf-error');
  const form = root.querySelector('form');
  const input = form.querySelector('input');
  const msg = form.querySelector('.manual-msg');

  let ctrl = null;
  let alive = true;
  let lastText = '';
  let lastAt = 0;

  function showError(code) {
    const m = MESSAGES[code] || MESSAGES.failed;
    vf.dataset.state = 'error';
    vf.dataset.error = code;
    errBox.hidden = false;
    errBox.querySelector('.vf-error-title').textContent = m.title;
    errBox.querySelector('.vf-error-text').textContent = m.text;
    errBox.querySelector('[data-action="retry"]').hidden = code === 'insecure' || code === 'unsupported';
    status.hidden = true;
  }

  function openCard(card) {
    vibrate(40);
    if (ctrl) { ctrl.stop(); ctrl = null; }
    navigate(`#/c/${card.id}`);
  }

  function onResult(text) {
    const now = Date.now();
    if (text === lastText && now - lastAt < 2500) return;
    lastText = text;
    lastAt = now;
    const id = parseCardId(text);
    if (!id) {
      toast('Deze QR-code hoort niet bij TimeTunesr.', { kind: 'warn' });
      vibrate([30, 60, 30]);
      return;
    }
    const card = findCard(deck, id);
    if (!card) {
      toast(`Kaart ${id} staat niet in dit deck.`, { kind: 'warn' });
      vibrate([30, 60, 30]);
      return;
    }
    openCard(card);
  }

  async function start() {
    vf.dataset.state = 'starting';
    errBox.hidden = true;
    status.hidden = false;
    status.textContent = 'Camera wordt gestart…';
    const support = cameraSupport();
    if (support !== 'ok') { showError(support); return; }
    try {
      const c = await startScanner(video, onResult);
      if (!alive) { c.stop(); return; }
      ctrl = c;
      vf.dataset.state = 'scanning';
      vf.dataset.detector = c.kind;
      document.documentElement.dataset.scanDetector = c.kind;
      status.textContent = 'Zoeken naar een QR-code…';
    } catch (err) {
      if (alive) showError(err.code || 'failed');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = normalizeCardInput(input.value);
    if (!id) {
      msg.textContent = 'Typ het nummer dat op de kaart staat, bijvoorbeeld 42.';
      input.focus();
      return;
    }
    const card = findCard(deck, id);
    if (!card) {
      msg.innerHTML = `Kaart <strong>${esc(id)}</strong> staat niet in dit deck (${deck.cards.length} ${deck.cards.length === 1 ? 'kaart' : 'kaarten'}).`;
      input.select();
      return;
    }
    msg.textContent = '';
    player.unlock();
    openCard(card);
  });
  errBox.querySelector('[data-action="retry"]').addEventListener('click', () => start());

  start();

  return () => {
    alive = false;
    if (ctrl) ctrl.stop();
  };
}
