// Gentle music fades for a Discobingo round on the spelleider's device: the song starts while
// the disco ball spins (silent at the start of the spin, full volume when it lands) and stops
// with a short fade-out instead of a hard cut. Two sources, as in player.js:
//  - fragments (<audio>): the element's volume, in small timer steps (also in a background
//    tab, unlike requestAnimationFrame). Where the platform ignores `audio.volume` (iOS Safari)
//    nothing fades: the music simply starts and stops as before.
//  - Spotify: the device volume through the Web API, in a few steps (at most 6 requests per
//    fade), only when the device supports it, and ALWAYS back to the volume the user had: after
//    a fade-out has paused the music, on an error, a 429, a pause, an interrupted fade and when
//    the screen is left. A volume call never delays the song by more than a moment.
//    While the volume is lowered, the user's own volume (and the device) is also kept in
//    localStorage (VOLUME_MARKER_KEY): a tab that is killed mid-fade never fires 'pagehide', so
//    the next time the round music starts (recoverSpotifyVolume) that volume comes back once.
//    Volume calls go out one after the other: a restore is never overtaken by a "low" still on
//    its way.
// Pure logic with injected timers and APIs, so `npm test` drives it with fakes.

/** The fade-out at the end of a round's music (ms). */
export const FADE_OUT_MS = 1200;
/** At most this many Spotify requests in one fade (info and restore included). */
export const SPOTIFY_MAX_REQUESTS = 6;
/** Longest a volume call may hold up the start of the song (ms). */
export const VOLUME_WAIT_MS = 400;
/** Audio fades step this often (ms). */
export const AUDIO_STEP_MS = 50;

/** localStorage: { volume, deviceId, at } while fade.js has the user's Spotify volume lowered. */
export const VOLUME_MARKER_KEY = 'timetunesr.spotifyVolume.v1';
/** A marker older than this is forgotten without touching the volume (ms). */
export const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest a volume call waits for the one before it (ms): a request that hangs blocks nothing. */
export const VOLUME_CHAIN_WAIT_MS = 3000;

/** The marker in localStorage (missing, blocked or full storage: nothing happens). */
export const localMarker = {
  get() {
    try { const v = JSON.parse(globalThis.localStorage?.getItem(VOLUME_MARKER_KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
  },
  set(v) { try { globalThis.localStorage?.setItem(VOLUME_MARKER_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { globalThis.localStorage?.removeItem(VOLUME_MARKER_KEY); } catch { /* ignore */ } },
};

const realTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t),
  now: () => Date.now(),
};

/**
 * A linear ramp: apply(v) from `from` to `to` in `steps` equal steps over `ms` (the last one
 * exactly `to`). Returns { done: Promise<boolean> (true = finished, false = cancelled), cancel() }.
 */
export function ramp({ from, to, ms, steps, apply, timers = realTimers }) {
  const n = Math.max(1, Math.round(steps));
  let timer = null;
  let over = false;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const step = (k) => {
    if (over) return;
    const v = k >= n ? to : from + ((to - from) * k) / n;
    try { apply(v, k, n); } catch { /* a failed step must not stop the ramp */ }
    if (k >= n) { over = true; resolve(true); return; }
    timer = timers.set(() => step(k + 1), Math.max(0, ms / n));
  };
  if (ms <= 0) step(n); else step(1);
  return {
    done,
    cancel() { if (over) return; over = true; if (timer != null) timers.clear(timer); resolve(false); },
  };
}

/** Does this media element really change its volume (iOS Safari keeps it at 1)? */
export function volumeWorks(audio) {
  try {
    const was = audio.volume;
    audio.volume = was > 0.5 ? 0.25 : 0.75;
    const ok = Math.abs(audio.volume - (was > 0.5 ? 0.25 : 0.75)) < 0.01;
    audio.volume = was;
    return ok;
  } catch { return false; }
}

/**
 * Fades of an <audio> element. getAudio(): the element. fadeIn(ms): volume 0 now, up to 1 over
 * ms; fadeOut(ms) -> Promise<boolean>: down to 0 (resolves when done; false when cancelled);
 * reset(): cancel and full volume again. Nothing happens where the volume does not work.
 */
export function createAudioFader(getAudio, { timers = realTimers } = {}) {
  let cur = null;
  let works = null;
  const can = (a) => { if (works == null) works = !!a && volumeWorks(a); return works; };
  const cancel = () => { cur?.cancel(); cur = null; };
  const run = (a, from, to, ms) => {
    cancel();
    const r = ramp({ from, to, ms, steps: Math.max(1, Math.round(ms / AUDIO_STEP_MS)), timers, apply: (v) => { a.volume = Math.min(1, Math.max(0, v)); } });
    cur = r;
    r.done.then(() => { if (cur === r) cur = null; });
    return r.done;
  };
  return {
    get active() { return !!cur; },
    get supported() { const a = getAudio(); return can(a); },
    fadeIn(ms) {
      const a = getAudio();
      if (!can(a)) return Promise.resolve(false);
      a.volume = 0;
      return run(a, 0, 1, ms);
    },
    fadeOut(ms = FADE_OUT_MS) {
      const a = getAudio();
      if (!can(a)) return Promise.resolve(false);
      return run(a, a.volume, 0, ms);
    },
    reset() {
      cancel();
      const a = getAudio();
      if (a && can(a)) a.volume = 1;
    },
  };
}

const wait = (p, ms, timers) => new Promise((resolve, reject) => {
  const t = timers.set(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
  Promise.resolve(p).then((v) => { timers.clear(t); resolve(v); }, (e) => { timers.clear(t); reject(e); });
});

/**
 * Fades of the user's Spotify device. api: { info() -> Promise<{ volume, supports } | null>,
 * setVolume(percent, { keepalive }) -> Promise }. The volume the user had is remembered before
 * the first change and put back whenever the fade ends, fails or is interrupted.
 *   fadeIn(ms, start): lower the volume (if it can), call start() (the song; always called, at
 *     once when a volume call fails), then step back up to the user's volume by the end of ms.
 *   fadeOut(ms, pause): step down, await pause(), then the user's volume again.
 *   restore({ keepalive }): put the user's volume back now (idempotent).
 * `requests` counts the volume API calls of the running fade (tests: never more than 6).
 */
export function createSpotifyFader(api, { timers = realTimers, marker = localMarker, ready = null } = {}) {
  let saved = null; // the user's own volume, while we changed it
  let deviceId = null; // the device it belongs to (for the marker)
  let lowered = false;
  let op = 0;
  let requests = 0;
  let cooldownUntil = 0; // after a 429: no fades until then
  let chain = Promise.resolve(); // the volume calls, one after the other

  const sleep = (ms) => new Promise((r) => timers.set(r, ms));
  /** One volume call, after the one before it has settled (or VOLUME_CHAIN_WAIT_MS passed). */
  const call = (fn) => {
    requests++;
    const before = chain;
    const run = new Promise((resolve) => {
      const t = timers.set(resolve, VOLUME_CHAIN_WAIT_MS);
      before.then(() => { timers.clear(t); resolve(); });
    }).then(fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  /** The user's volume is about to be lowered: remember it outside this page too. */
  const mark = () => { try { marker?.set({ volume: saved, deviceId, at: timers.now() }); } catch { /* ignore */ } };
  const unmark = () => { try { marker?.clear(); } catch { /* ignore */ } };
  const rateLimited = (e) => {
    if (e?.code !== 'rate') return false;
    cooldownUntil = timers.now() + (Number(e.retryAfter) > 0 ? e.retryAfter * 1000 : 2000);
    return true;
  };

  async function restore({ keepalive = false } = {}) {
    if (!lowered || saved == null) { lowered = false; return; }
    const target = saved;
    lowered = false; // at once: a second restore (pause + fade end) sends nothing
    for (let attempt = 0; attempt < 3; attempt++) {
      // the page is going away (keepalive): send at once, do not wait for a call still on its
      // way; the marker stays, so the next start checks the volume once more
      const send = () => api.setVolume(target, { keepalive });
      try {
        if (keepalive) { requests++; await send(); } else await call(send);
        saved = null;
        if (!keepalive) unmark();
        return;
      } catch (e) {
        // a 429 says how long to wait; anything else: try again shortly
        const ms = e?.code === 'rate' && Number(e.retryAfter) > 0 ? e.retryAfter * 1000 : 800;
        if (attempt < 2) await sleep(Math.min(ms, 5000));
      }
    }
    // could not put it back: remember, so the next restore() (pause, leaving) tries again
    lowered = true;
  }

  async function info() {
    try { requests++; return await wait(api.info(), VOLUME_WAIT_MS, timers); } catch (e) { rateLimited(e); return null; }
  }
  /** A start-up recovery (recoverSpotifyVolume) runs first: never measure the volume before it is back. */
  const settled = async () => { if (ready) { try { await ready; } catch { /* ignore */ } } };
  const remember = (d) => { if (!lowered) { saved = Math.round(d.volume); deviceId = typeof d.deviceId === 'string' ? d.deviceId : null; } };

  return {
    get lowered() { return lowered; },
    get saved() { return saved; },
    get requests() { return requests; },
    restore,
    /** Stop any fade and put the user's volume back (a pause, leaving the screen, an error). */
    interrupt(opts) { op++; return restore(opts); },
    async fadeIn(ms, start) {
      const my = ++op;
      requests = 0;
      let started = false;
      const go = () => { if (!started) { started = true; try { start(); } catch { /* the player reports its own errors */ } } };
      if (timers.now() < cooldownUntil) { go(); return false; }
      const t0 = timers.now();
      await settled();
      if (my !== op) return false;
      const d = lowered ? { volume: saved, supports: true } : await info();
      if (my !== op) return false; // stopped (or a newer fade) meanwhile: that one decides
      if (!d?.supports || !Number.isFinite(d.volume) || d.volume <= 0) { go(); return false; }
      remember(d);
      const full = saved;
      const low = Math.max(1, Math.round(full * 0.1));
      try {
        if (!lowered) mark();
        lowered = true;
        await wait(call(() => api.setVolume(low)), VOLUME_WAIT_MS, timers);
      } catch (e) {
        rateLimited(e);
        go();
        await restore();
        return false;
      }
      go();
      if (my !== op) return false;
      // up in steps: 40% / 70% / the user's volume, spread over what is left of the spin
      const left = Math.max(0, ms - (timers.now() - t0));
      const levels = [0.4, 0.7, 1];
      for (let k = 0; k < levels.length; k++) {
        await sleep(left / levels.length);
        if (my !== op) return false; // interrupted: whoever interrupted restores
        if (requests >= SPOTIFY_MAX_REQUESTS) break;
        const v = k === levels.length - 1 ? full : Math.max(low, Math.round(full * levels[k]));
        try {
          await call(() => api.setVolume(v));
          if (v === full) { lowered = false; saved = null; unmark(); }
        } catch (e) {
          rateLimited(e);
          await restore();
          return false;
        }
      }
      if (lowered) await restore();
      return my === op;
    },
    async fadeOut(ms = FADE_OUT_MS, pause = async () => {}) {
      const my = ++op;
      requests = 0;
      const stop = async () => { try { await pause(); } catch { /* paused or gone: the volume comes back anyway */ } };
      if (timers.now() < cooldownUntil) { await stop(); await restore(); return false; }
      await settled();
      if (my !== op) return false;
      const d = lowered ? { volume: saved, supports: true } : await info();
      if (my !== op) return false;
      if (!d?.supports || !Number.isFinite(d.volume) || d.volume <= 0) { await stop(); return false; }
      remember(d);
      const full = saved;
      if (!lowered) mark();
      lowered = true;
      // down in three steps, then pause, then the user's volume again (info + 3 + restore <= 6)
      const levels = [0.6, 0.3, 0.05];
      for (const f of levels) {
        if (my !== op) return false;
        try { await call(() => api.setVolume(Math.max(0, Math.round(full * f)))); } catch (e) { rateLimited(e); break; }
        await sleep(ms / levels.length);
      }
      if (my !== op) return false;
      await stop();
      await restore();
      return true;
    },
  };
}

/**
 * A tab that died while fade.js had the Spotify volume lowered: put the user's volume back,
 * once. Only with a marker (else the volume is never touched), only on the same device (still
 * the active one), never above the saved volume (the user may have turned it up or down since:
 * a volume at or above it stays). The marker goes when it is used up, when the device is
 * another one, or when it is older than MARKER_MAX_AGE_MS; it stays when Spotify can not be
 * asked now (no device, an error), for the next time. Resolves 'restored' | 'kept' | 'none'
 * | 'later'. api: { info() -> { volume, supports, deviceId }, setVolume(percent) }.
 */
export async function recoverSpotifyVolume(api, { marker = localMarker, now = Date.now } = {}) {
  let m;
  try { m = marker?.get(); } catch { m = null; }
  if (!m) return 'none';
  const target = Math.round(Number(m.volume));
  if (!Number.isFinite(target) || target <= 0 || target > 100 || typeof m.deviceId !== 'string' || !m.deviceId
    || !(now() - (Number(m.at) || 0) < MARKER_MAX_AGE_MS)) { marker.clear(); return 'none'; }
  let d;
  try { d = await api.info(); } catch { return 'later'; }
  if (!d) return 'later';
  if (d.deviceId !== m.deviceId || !d.supports || !Number.isFinite(d.volume)) { marker.clear(); return 'none'; }
  if (d.volume >= target) { marker.clear(); return 'kept'; }
  try { await api.setVolume(target); } catch { return 'later'; }
  marker.clear();
  return 'restored';
}

/**
 * The music of a Discobingo round on the leader's device, with fades. `player`: player.js
 * (state, subscribe, play, audioElement); `spotifyApi`: { info, setVolume, pause }.
 *   fadeInPlay(ms): start the loaded song now, silent, at full volume after ms.
 *   fadeOutThen(fn, ms): fade the playing song out, then fn() (stop / pause); at once when
 *     nothing plays. Returns a Promise.
 * By itself: the last FADE_OUT_MS of a fragment or of the Spotify play limit fade out, and
 * whatever stops the music otherwise (the leader's own pause, an error, leaving) puts the
 * user's Spotify volume back at once. destroy() puts everything back.
 */
export function createRoundMusic({ player, spotifyApi, timers = realTimers, win = typeof window !== 'undefined' ? window : null, marker = localMarker }) {
  const audio = createAudioFader(() => player.audioElement(), { timers });
  // a volume left low by a tab that died mid-fade comes back first (only with Spotify connected:
  // without a marker nothing is asked); the first fade waits for it
  const recovered = marker?.get?.() ? recoverSpotifyVolume(spotifyApi, { marker, now: timers.now }).catch(() => 'later') : null;
  const sp = createSpotifyFader(spotifyApi, { timers, marker, ready: recovered });
  let outBusy = null; // a fade-out of ours is running (the guard below keeps out of its way)
  let endFor = null; // the card whose end-of-play fade has started
  const isSp = () => player.state.source === 'spotify';
  const STOPPED = ['paused', 'idle', 'ended', 'error', 'blocked'];
  const off = player.subscribe((st) => {
    if (!outBusy && STOPPED.includes(st.status)) {
      if (sp.lowered) sp.interrupt();
      if (audio.active || st.status === 'ended' || st.status === 'idle') audio.reset();
    }
    // the end of the fragment / of the play limit: a fade instead of a cut
    const left = st.duration - st.currentTime;
    if (st.status === 'playing' && !outBusy && st.cardId && endFor !== st.cardId && st.duration > 2 && left > 0 && left <= (FADE_OUT_MS + (isSp() ? 400 : 0)) / 1000) {
      endFor = st.cardId;
      const run = isSp() ? sp.fadeOut(FADE_OUT_MS, () => spotifyApi.pause()) : audio.fadeOut(Math.max(200, left * 1000 - 80));
      // the 'ended' that follows finds no fade running and puts the volume back for the next song
      outBusy = run.finally(() => { outBusy = null; if (player.state.status !== 'playing') audio.reset(); });
    }
  });
  const onHide = () => { if (sp.lowered) sp.restore({ keepalive: true }); };
  win?.addEventListener?.('pagehide', onHide);
  return {
    audio,
    spotify: sp,
    get fading() { return !!outBusy; },
    fadeInPlay(ms) {
      endFor = null;
      if (isSp()) return sp.fadeIn(ms, () => player.play());
      audio.fadeIn(ms);
      return player.play();
    },
    fadeOutThen(fn, ms = FADE_OUT_MS) {
      const st = player.state;
      if (st.status !== 'playing' || outBusy) {
        // nothing audible (or already fading): no fade; a running one finishes first
        const p = outBusy ? outBusy.then(() => fn()) : Promise.resolve().then(() => fn());
        return p.finally(() => audio.reset());
      }
      const run = isSp() ? sp.fadeOut(ms, () => spotifyApi.pause()) : audio.fadeOut(ms);
      outBusy = run.then(() => fn()).catch(() => fn()).finally(() => { audio.reset(); outBusy = null; });
      return outBusy;
    },
    destroy() {
      off();
      win?.removeEventListener?.('pagehide', onHide);
      sp.interrupt();
      audio.reset();
    },
  };
}
