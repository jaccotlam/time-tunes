// Shared answer card + hold-to-reveal button.
import { esc, icons, reducedMotion } from '../ui.js';

export const HOLD_MS = 1500;

export function answerHtml(card, trackViewUrl) {
  const link = trackViewUrl || card.trackViewUrl;
  return `<div class="answer-card" data-testid="answer-card">
    <div class="answer-year" id="ans-title" data-testid="answer-year">${esc(card.year)}</div>
    <div class="answer-artist" data-testid="answer-artist">${esc(card.artist)}</div>
    <div class="answer-title" data-testid="answer-title">${esc(card.title)}</div>
    ${link ? `<a class="answer-link" href="${esc(link)}" target="_blank" rel="noopener" data-testid="answer-apple-music">${icons.music}<span>Open in Apple Music</span></a>` : ''}
  </div>`;
}

/**
 * Make `btn` fire `onDone` only after being held for HOLD_MS.
 * Works with touch, mouse and keyboard (hold Space/Enter).
 */
export function setupHoldButton(btn, onDone) {
  let start = 0;
  let raf = 0;
  const fill = btn.querySelector('.hold-fill');
  const set = (p) => { btn.style.setProperty('--p', String(p)); if (fill) fill.style.transform = `scaleX(${p})`; };

  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD_MS);
    set(reducedMotion() ? (p < 1 ? 0.5 : 1) : p);
    if (p >= 1) { finish(); return; }
    raf = requestAnimationFrame(tick);
  };
  const begin = (e) => {
    if (start) return;
    if (e && e.type === 'pointerdown') {
      if (e.button > 0) return;
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    start = performance.now();
    btn.classList.add('holding');
    raf = requestAnimationFrame(tick);
  };
  const cancel = () => {
    if (!start) return;
    start = 0;
    cancelAnimationFrame(raf);
    btn.classList.remove('holding');
    set(0);
  };
  const finish = () => {
    start = 0;
    cancelAnimationFrame(raf);
    btn.classList.remove('holding');
    set(0);
    onDone();
  };
  const onKeyDown = (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); begin(); }
    else if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  };
  const onKeyUp = (e) => { if (e.key === ' ' || e.key === 'Enter') cancel(); };
  const noMenu = (e) => e.preventDefault();
  const onClick = (e) => e.preventDefault();

  btn.addEventListener('pointerdown', begin);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('lostpointercapture', cancel);
  btn.addEventListener('keydown', onKeyDown);
  btn.addEventListener('keyup', onKeyUp);
  btn.addEventListener('blur', cancel);
  btn.addEventListener('contextmenu', noMenu);
  btn.addEventListener('click', onClick);
  return () => {
    cancel();
    btn.removeEventListener('pointerdown', begin);
    btn.removeEventListener('pointerup', cancel);
    btn.removeEventListener('pointercancel', cancel);
    btn.removeEventListener('lostpointercapture', cancel);
    btn.removeEventListener('keydown', onKeyDown);
    btn.removeEventListener('keyup', onKeyUp);
    btn.removeEventListener('blur', cancel);
    btn.removeEventListener('contextmenu', noMenu);
    btn.removeEventListener('click', onClick);
  };
}
