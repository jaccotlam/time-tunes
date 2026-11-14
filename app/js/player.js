// Playback for the hidden player. Two sources behind one interface:
// - 'preview' (default): 30-second iTunes previews in the <audio> element. For every
//   card we first look up a fresh previewUrl (preview links can expire); when that
//   fails we fall back to the previewUrl stored in the deck.
// - 'spotify': the whole song on the user's Spotify Connect device (js/spotify.js),
//   stopped after the chosen duration. Any Spotify failure falls back to the preview.
// Screens only use load/play/pause/toggle/restart/stop/subscribe/state, whatever the source.
import * as spotify from './spotify.js';
import { toast } from './ui.js';

const LOOKUP_TIMEOUT_MS = 4500;
const lookupCache = new Map();
const listeners = new Set();

let audio = null;
let token = 0;
let wantPlay = false;
let unlocked = false;

export const state = {
  status: 'idle', // idle | loading | ready | blocked | playing | paused | ended | error
  error: null, // 'offline' | 'unavailable' | 'spotify-device' (status 'blocked': pick a device)
  cardId: null,
  currentTime: 0,
  duration: 30,
  source: null, // 'lookup' | 'deck' | 'spotify'
  device: null, // name of the Spotify device that plays (never anything about the song)
  devices: [], // with error 'spotify-device': devices Spotify reported (may be empty)
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

/**
 * Prepare a card (and start it when autoplay is set). Resolves when the source is
 * known: true when something can play, false when it failed or was superseded.
 */
export function load(card, { autoplay = false } = {}) {
  releaseSpotify();
  if (wantsSpotify()) return loadSpotify(card, { autoplay });
  mode = 'preview';
  return loadPreview(card, { autoplay });
}

async function loadPreview(card, { autoplay = false } = {}) {
  const a = el();
  const my = ++token;
  wantPlay = autoplay;
  currentCard = card;
  a.pause();
  a.removeAttribute('src');
  a.dataset.card = card.id;
  update({ status: 'loading', error: null, cardId: card.id, currentTime: 0, duration: 30, source: null, device: null, devices: [] });
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
  if (mode === 'spotify') return spPlay();
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
  if (mode === 'spotify') { spPause(); return; }
  if (audio) audio.pause();
}

export function toggle() {
  if (state.status === 'playing') { pause(); return Promise.resolve(false); }
  return play();
}

export function restart() {
  if (mode === 'spotify' && currentCard) return spRestart();
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
  releaseSpotify();
  mode = 'preview';
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    delete audio.dataset.card;
    try { audio.load(); } catch { /* ignore */ }
  }
  update({ status: 'idle', error: null, cardId: null, currentTime: 0, device: null, devices: [] });
}

/** Skip Spotify for the current card and play its 30-second preview instead. */
export function usePreview() {
  if (!currentCard) return Promise.resolve(false);
  const card = currentCard;
  releaseSpotify();
  mode = 'preview';
  return loadPreview(card, { autoplay: true });
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

/* ---------- Spotify source ---------- */

const POLL_MS = 3000;
const GRACE_MS = 2500; // ignore playback-state polls right after a command (Spotify lags)

let mode = 'preview'; // source of the current card: 'preview' | 'spotify'
let sp = newSp();
let offReason = null; // after premium/session/not-allowed failures: skip Spotify until something changes
let warnedNotConnected = false;

function newSp() {
  return { uri: null, durationMs: null, started: false, playing: false, busy: false, retried: false, cmd: 0, startPos: 0, startedAt: 0, grace: 0, tick: 0, poll: 0 };
}

spotify.subscribe((reason) => {
  if (reason === 'connected' || reason === 'settings' || reason === 'disconnected') { offReason = null; warnedNotConnected = false; }
});

function wantsSpotify() {
  if (spotify.getSettings().source !== 'spotify') return false;
  if (!spotify.isConnected()) {
    if (!warnedNotConnected) {
      warnedNotConnected = true;
      toast('Spotify is gekozen, maar niet verbonden. Je hoort fragmenten van 30 seconden. Verbind via Instellingen.', { kind: 'warn', ms: 5000 });
    }
    return false;
  }
  return !offReason;
}

/** Playing time for this card in seconds (setting: 30 s, 60 s or the whole song). */
function spDuration() {
  const limit = spotify.getSettings().limit;
  const full = sp.durationMs ? sp.durationMs / 1000 : 0;
  if (limit) return full ? Math.min(limit, full) : limit;
  return full || 0;
}

const spNow = () => (sp.playing ? sp.startPos + (performance.now() - sp.startedAt) / 1000 : state.currentTime);

function stopClock() {
  sp.playing = false;
  clearInterval(sp.tick);
  clearInterval(sp.poll);
}

function startClock(pos) {
  stopClock();
  sp.playing = true;
  sp.startPos = pos;
  sp.startedAt = performance.now();
  sp.grace = performance.now() + GRACE_MS;
  sp.tick = setInterval(onTick, 250);
  sp.poll = setInterval(pollState, POLL_MS);
}

function onTick() {
  if (!sp.playing) return;
  const t = spNow();
  const d = state.duration;
  if (d > 0 && t >= d) { finishSpotify(); return; }
  update({ currentTime: t });
}

/** The chosen duration is over: pause Spotify and show "ended". */
function finishSpotify() {
  stopClock();
  sp.cmd++;
  update({ status: 'ended', currentTime: state.duration });
  spotify.pause().catch(() => {});
}

async function pollState() {
  if (!sp.playing || performance.now() < sp.grace) return;
  const my = token;
  const cmd = sp.cmd;
  let s;
  try { s = await spotify.playbackState(); } catch { return; }
  if (my !== token || cmd !== sp.cmd || !sp.playing || performance.now() < sp.grace) return;
  const same = !!s && s.uri === sp.uri;
  if (same && s.durationMs && !sp.durationMs) {
    sp.durationMs = s.durationMs;
    update({ duration: spDuration() });
  }
  if (!same || !s.isPlaying) {
    // paused in the Spotify app, another song started, or the track ended by itself
    const t = same ? s.progressMs / 1000 : spNow();
    stopClock();
    const atEnd = (state.duration > 0 && t >= state.duration - 1) || (same && s.progressMs === 0);
    update({ status: atEnd ? 'ended' : 'paused', currentTime: atEnd ? state.duration : t });
    return;
  }
  sp.startPos = s.progressMs / 1000;
  sp.startedAt = performance.now();
}

/** Pause Spotify if this card started it, and forget the Spotify state. */
function releaseSpotify() {
  if (sp.started && (sp.playing || sp.busy)) spotify.pause().catch(() => {});
  stopClock();
  sp = newSp();
}

async function loadSpotify(card, { autoplay = false } = {}) {
  const a = el();
  const my = ++token;
  mode = 'spotify';
  wantPlay = autoplay;
  currentCard = card;
  a.pause();
  a.removeAttribute('src');
  delete a.dataset.card;
  const limit = spotify.getSettings().limit;
  update({
    status: 'loading', error: null, cardId: card.id, currentTime: 0, duration: limit || 30,
    source: 'spotify', device: spotify.getDevice()?.name || null, devices: [],
  });
  let track;
  try {
    track = await spotify.resolveTrack(card, { wantDuration: !limit });
  } catch (e) {
    if (my !== token) return false;
    return fallbackToPreview(card, e);
  }
  if (my !== token) return false;
  if (!track) return fallbackToPreview(card, new spotify.SpotifyError('no-match'));
  sp.uri = track.uri;
  sp.durationMs = track.durationMs || null;
  update({ status: 'ready', duration: spDuration() || limit || 30 });
  if (wantPlay) return spPlay();
  return true;
}

/** Spotify could not play this card: load the 30-second preview instead and say so briefly. */
function fallbackToPreview(card, err) {
  const code = err?.code || 'unavailable';
  if (['premium', 'session', 'not-allowed', 'not-connected'].includes(code)) offReason = code;
  if (code === 'no-match') {
    toast('Dit nummer is niet gevonden op Spotify. Je hoort het fragment van 30 seconden.', { kind: 'warn', ms: 4500 });
  } else if (code !== 'offline') {
    toast(`${spotify.errorMessage(err)} Je hoort nu het fragment van 30 seconden.`, { kind: 'warn', ms: 6000 });
  }
  const autoplay = wantPlay || sp.busy || state.status === 'blocked';
  stopClock();
  sp = newSp();
  mode = 'preview';
  return loadPreview(card, { autoplay });
}

async function spPlay(fromStart = false) {
  if (sp.busy) return false;
  if (state.status === 'loading' || !sp.uri) { wantPlay = true; return false; }
  wantPlay = false;
  const my = token;
  const cmd = ++sp.cmd;
  const pos = fromStart || state.status === 'ended' ? 0 : Math.max(0, state.currentTime);
  sp.busy = true;
  update({ status: 'loading', error: null, devices: [], currentTime: pos });
  try {
    const device = await spotify.play(sp.uri, pos * 1000);
    if (my !== token) return false;
    sp.busy = false;
    sp.started = true;
    if (cmd !== sp.cmd) { spotify.pause().catch(() => {}); return false; } // paused meanwhile
    startClock(pos);
    update({ status: 'playing', error: null, device: device?.name || null });
    return true;
  } catch (e) {
    if (my !== token) return false;
    if (e.code === 'no-device') {
      sp.busy = false;
      update({ status: 'blocked', error: 'spotify-device', devices: e.devices || [] });
      return false;
    }
    if (e.code === 'rate' && e.retryAfter && e.retryAfter <= 3 && !sp.retried) {
      sp.retried = true;
      await new Promise((r) => setTimeout(r, e.retryAfter * 1000));
      if (my !== token) return false;
      sp.busy = false;
      update({ status: 'ready' });
      return spPlay(fromStart);
    }
    return fallbackToPreview(currentCard, e);
  }
}

function spPause() {
  sp.cmd++;
  if (sp.busy) { sp.busy = false; update({ status: 'paused' }); return; } // spPlay sees cmd changed
  if (!sp.playing) {
    if (state.status === 'loading') wantPlay = false;
    return;
  }
  const t = spNow();
  stopClock();
  update({ status: 'paused', currentTime: t });
  spotify.pause().catch((e) => {
    if (e.code === 'offline') toast(spotify.errorMessage(e), { kind: 'warn' });
  });
}

function spRestart() {
  if (sp.playing) {
    sp.cmd++;
    startClock(0);
    update({ currentTime: 0 });
    spotify.seek(0).catch(() => {});
    return Promise.resolve(true);
  }
  update({ currentTime: 0 });
  return spPlay(true);
}

// Leaving the app while Spotify plays: stop the song (keepalive survives the unload).
window.addEventListener('pagehide', () => {
  if (mode === 'spotify' && sp.playing) spotify.pause({ keepalive: true }).catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mode === 'spotify' && sp.playing) {
    sp.grace = 0;
    pollState();
  }
});
