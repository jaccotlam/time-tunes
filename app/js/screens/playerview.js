// Hidden-song player UI: animation, play/pause, restart and progress.
// Never shows title, artist or year.
import * as player from '../player.js';
import { icons, fmtTime, equalizer } from '../ui.js';

const ERRORS = {
  offline: 'Geen internetverbinding. Het fragment kan niet worden geladen.',
  unavailable: 'Dit fragment is nu niet beschikbaar. Probeer het opnieuw of kies een andere kaart.',
};

export function playerViewHtml({ compact = false } = {}) {
  return `<div class="pv ${compact ? 'pv-compact' : ''}" data-status="loading" data-testid="player">
    <div class="pv-visual">
      <div class="vinyl" aria-hidden="true">
        <div class="vinyl-disc"></div><span class="vinyl-label"><b>?</b></span>
      </div>
      ${equalizer('pv-eq')}
      <button class="pv-bigplay" type="button" data-action="pv-play" data-testid="play-big" hidden>
        ${icons.play}<span>Speel af</span>
      </button>
    </div>
    <div class="pv-body">
      <div class="pv-progress" aria-hidden="true"><div class="pv-bar"><i class="pv-fill"></i></div>
        <div class="pv-times"><span class="pv-cur">0:00</span><span class="pv-dur">0:30</span></div>
      </div>
      <div class="pv-controls">
        <button class="icon-btn pv-restart" type="button" data-action="pv-restart" aria-label="Opnieuw vanaf het begin" data-testid="restart">${icons.restart}</button>
        <button class="pv-toggle" type="button" data-action="pv-toggle" aria-label="Afspelen" data-testid="play-toggle">
          <span class="when-paused">${icons.play}</span><span class="when-playing">${icons.pause}</span>
        </button>
        <span class="pv-placeholder" aria-hidden="true"></span>
      </div>
      <p class="pv-status" data-testid="player-status" role="status"></p>
    </div>
  </div>`;
}

/** Wire a rendered player view to the shared audio player. Returns cleanup. */
export function mountPlayerView(container) {
  const pv = container.querySelector('.pv');
  const fill = pv.querySelector('.pv-fill');
  const cur = pv.querySelector('.pv-cur');
  const dur = pv.querySelector('.pv-dur');
  const statusEl = pv.querySelector('.pv-status');
  const big = pv.querySelector('.pv-bigplay');
  const toggle = pv.querySelector('.pv-toggle');

  const onClick = (e) => {
    const a = e.target.closest('[data-action]');
    if (!a || !pv.contains(a)) return;
    if (a.dataset.action === 'pv-toggle') player.toggle();
    else if (a.dataset.action === 'pv-play') player.play();
    else if (a.dataset.action === 'pv-restart') player.restart();
  };
  pv.addEventListener('click', onClick);

  const unsub = player.subscribe((s) => {
    pv.dataset.status = s.status;
    const d = s.duration || 30;
    const pct = Math.max(0, Math.min(100, (s.currentTime / d) * 100));
    fill.style.width = `${pct}%`;
    cur.textContent = fmtTime(s.currentTime);
    dur.textContent = fmtTime(d);
    big.hidden = s.status !== 'blocked';
    toggle.setAttribute('aria-label', s.status === 'playing' ? 'Pauzeren' : 'Afspelen');
    let text = '';
    if (s.status === 'loading') text = 'Fragment wordt geladen…';
    else if (s.status === 'ready') text = 'Klaar. Tik op afspelen.';
    else if (s.status === 'blocked') text = 'Tik op Speel af om het fragment te starten.';
    else if (s.status === 'paused') text = 'Gepauzeerd';
    else if (s.status === 'ended') text = 'Fragment afgelopen. Nog een keer? Tik op afspelen.';
    else if (s.status === 'error') text = ERRORS[s.error] || ERRORS.unavailable;
    else if (s.status === 'playing') text = 'Luister goed…';
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', s.status === 'error');
  });

  return () => {
    unsub();
    pv.removeEventListener('click', onClick);
  };
}
