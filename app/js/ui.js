// Small DOM helpers shared by all screens.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = 0;
export function toast(message, { kind = 'info', ms = 3200 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth; // restart transition
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, ms);
}

export function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ }
}

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Safe localStorage wrapper: storage can be missing or throw (private mode). */
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

// Inline SVG icons (stroke-based, currentColor).
const svg = (body, extra = '') =>
  `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ${extra}>${body}</svg>`;
export const icons = {
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/>'),
  restart: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  back: svg('<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  scan: svg('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 12h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  users: svg('<circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="9" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M17 14c2.2 0 3.7 1.4 4.2 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  print: svg('<path d="M7 9V4h10v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="3.5" y="9" width="17" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  book: svg('<path d="M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 6v13.5" stroke="currentColor" stroke-width="2"/>'),
  share: svg('<path d="M12 15V4M8 7.5L12 3.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v7A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  plus: svg('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
  minus: svg('<path d="M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  cross: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>'),
  keypad: svg('<g fill="currentColor"><circle cx="6" cy="6" r="1.8"/><circle cx="12" cy="6" r="1.8"/><circle cx="18" cy="6" r="1.8"/><circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/><circle cx="6" cy="18" r="1.8"/><circle cx="12" cy="18" r="1.8"/><circle cx="18" cy="18" r="1.8"/></g>'),
  music: svg('<path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/>'),
  trophy: svg('<path d="M7 4h10v5a5 5 0 0 1-10 0z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3.5M8 20.5h8M9.5 17.5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  home: svg('<path d="M4 11l8-6.5 8 6.5M6.5 9.5V19h11V9.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
};

/** Brand logo: a record whose label is a clock face. */
export function logoSvg(cls = 'logo') {
  return `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs><radialGradient id="lg-disc" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#3b2453"/><stop offset="1" stop-color="#120820"/></radialGradient></defs>
  <circle cx="60" cy="60" r="56" fill="url(#lg-disc)" stroke="#ffc649" stroke-width="3"/>
  <g fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="1.4">
    <circle cx="60" cy="60" r="48"/><circle cx="60" cy="60" r="42"/><circle cx="60" cy="60" r="36"/>
  </g>
  <path d="M24 44a40 40 0 0 1 22-20" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="3" stroke-linecap="round"/>
  <circle cx="60" cy="60" r="27" fill="#ffc649"/>
  <g stroke="#170b24" stroke-width="2.6" stroke-linecap="round">
    <path d="M60 37v4M60 79v4M37 60h4M79 60h4"/>
  </g>
  <path d="M60 60V45M60 60l10 7" stroke="#ff5d73" stroke-width="4.2" stroke-linecap="round" fill="none"/>
  <circle cx="60" cy="60" r="3.6" fill="#170b24"/>
</svg>`;
}

export function wordmark() {
  return '<span class="wordmark" aria-label="TimeTunesr"><span class="wm-time">Time</span><span class="wm-tunes">Tunes</span><span class="wm-r">r</span></span>';
}

/** Equalizer bars animation (pure CSS). */
export function equalizer(cls = '') {
  return `<div class="eq ${cls}" aria-hidden="true">${'<i></i>'.repeat(7)}</div>`;
}
