// Audio playback for 30-second iTunes previews.
// For every card we first look up a fresh previewUrl (preview links can
// expire); when that fails we fall back to the previewUrl stored in the deck.

const LOOKUP_TIMEOUT_MS = 4500;
const lookupCache = new Map();
const listeners = new Set();

let audio = null;
let token = 0;
let wantPlay = false;
let unlocked = false;

export const state = {
  status: 'idle', // idle | loading | ready | blocked | playing | paused | ended | error
  error: null, // 'offline' | 'unavailable'
  cardId: null,
  currentTime: 0,
  duration: 30,
  source: null, // 'lookup' | 'deck'
};

function el() {
  if (!audio) {
    audio = document.getElementById('player') || document.body.appendChild(document.createElement('audio'));
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.addEventListener('timeupdate', () => update({ currentTime: audio.currentTime }));
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) update({ duration: audio.duration });
    });
    audio.addEventListener('playing', () => { if (isCurrent()) update({ status: 'playing', error: null }); });
    audio.addEventListener('pause', () => {
      if (isCurrent() && state.status === 'playing') update({ status: audio.ended ? 'ended' : 'paused' });
    });
    audio.addEventListener('ended', () => { if (isCurrent()) update({ status: 'ended', currentTime: state.duration }); });
    audio.addEventListener('error', () => {
      if (!isCurrent() || !audio.getAttribute('src')) return;
      // The deck URL may still work when the fresh one failed (or vice versa).
      if (state.source === 'lookup' && currentCard?.previewUrl && audio.src !== currentCard.previewUrl) {
        state.source = 'deck';
        const shouldPlay = wantPlay || state.status === 'playing';
        audio.src = currentCard.previewUrl;
        audio.load();
        if (shouldPlay) play();
        return;
      }
      update({ status: 'error', error: navigator.onLine === false ? 'offline' : 'unavailable' });
    });
  }
  return audio;
}

let currentCard = null;
const isCurrent = () => !!currentCard && el().dataset.card === currentCard.id;

function update(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

async function lookupPreview(card) {
  if (!card.itunesId) return null;
  if (lookupCache.has(card.itunesId)) return lookupCache.get(card.itunesId);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(card.itunesId)}&country=NL`;
    const res = await fetch(url, { signal: ctrl?.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const hit = (json.results || []).find((r) => r.previewUrl) || null;
    const out = hit ? { previewUrl: hit.previewUrl, trackViewUrl: hit.trackViewUrl } : null;
    if (out) lookupCache.set(card.itunesId, out);
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve and set the audio source for a card. Resolves when src is set. */
export async function load(card, { autoplay = false } = {}) {
  const a = el();
  const my = ++token;
  wantPlay = autoplay;
  currentCard = card;
  a.pause();
  a.removeAttribute('src');
  a.dataset.card = card.id;
  update({ status: 'loading', error: null, cardId: card.id, currentTime: 0, duration: 30, source: null });
  const fresh = await lookupPreview(card);
  if (my !== token) return false;
  const url = fresh?.previewUrl || card.previewUrl;
  if (!url) {
    update({ status: 'error', error: navigator.onLine === false ? 'offline' : 'unavailable' });
    return false;
  }
  a.src = url;
  a.load();
  update({ status: 'ready', source: fresh ? 'lookup' : 'deck' });
  if (wantPlay) play();
  return true;
}

/**
 * Start playback. Call this directly from a click handler: iOS only allows
 * audio after a user gesture.
 */
export function play() {
  const a = el();
  if (!currentCard) return Promise.resolve(false);
  if (!a.getAttribute('src') || state.status === 'loading') {
    wantPlay = true; // load() will call play() once the source is known
    return Promise.resolve(false);
  }
  wantPlay = false;
  if (state.status === 'error') {
    a.load();
    update({ status: 'ready', error: null });
  }
  if (state.status === 'ended') a.currentTime = 0;
  let p;
  try { p = a.play(); } catch (e) { p = Promise.reject(e); }
  return Promise.resolve(p).then(() => true).catch((err) => {
    if (err && err.name === 'NotAllowedError') update({ status: 'blocked' });
    else if (err && err.name === 'AbortError') { /* src changed meanwhile */ }
    else update({ status: 'error', error: navigator.onLine === false ? 'offline' : 'unavailable' });
    return false;
  });
}

export function pause() {
  wantPlay = false;
  if (audio) audio.pause();
}

export function toggle() {
  if (state.status === 'playing') { pause(); return Promise.resolve(false); }
  return play();
}

export function restart() {
  const a = el();
  try { a.currentTime = 0; } catch { /* not seekable yet */ }
  update({ currentTime: 0 });
  return play();
}

/** Stop and forget the current card. */
export function stop() {
  token++;
  wantPlay = false;
  currentCard = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    delete audio.dataset.card;
    try { audio.load(); } catch { /* ignore */ }
  }
  update({ status: 'idle', error: null, cardId: null, currentTime: 0 });
}

/** Warm up the trackViewUrl lookup for the answer screen. */
export function freshInfo(card) {
  return card?.itunesId ? lookupCache.get(card.itunesId) || null : null;
}

// A tiny silent WAV, played once inside the first user gesture so that iOS
// lets the same <audio> element start later without a new tap.
function silentWav() {
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  let bin = '';
  new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export function unlock() {
  if (unlocked) return;
  const a = el();
  if (a.getAttribute('src')) { unlocked = true; return; }
  unlocked = true;
  try {
    a.src = silentWav();
    const p = a.play();
    Promise.resolve(p).then(() => {
      if (!currentCard) { a.pause(); a.removeAttribute('src'); }
    }).catch(() => { unlocked = false; });
  } catch { unlocked = false; }
}
