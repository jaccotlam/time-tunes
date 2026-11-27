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
// Pure logic with injected timers and APIs, so `npm test` drives it with fakes.

/** The fade-out at the end of a round's music (ms). */
export const FADE_OUT_MS = 1200;
/** At most this many Spotify requests in one fade (info and restore included). */
export const SPOTIFY_MAX_REQUESTS = 6;
/** Longest a volume call may hold up the start of the song (ms). */
export const VOLUME_WAIT_MS = 400;
/** Audio fades step this often (ms). */
export const AUDIO_STEP_MS = 50;

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
export function createSpotifyFader(api, { timers = realTimers } = {}) {
  let saved = null; // the user's own volume, while we changed it
  let lowered = false;
  let op = 0;
  let requests = 0;
  let cooldownUntil = 0; // after a 429: no fades until then

  const sleep = (ms) => new Promise((r) => timers.set(r, ms));
  const call = (fn) => { requests++; return fn(); };
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
      try { await call(() => api.setVolume(target, { keepalive })); saved = null; return; } catch (e) {
        // a 429 says how long to wait; anything else: try again shortly
        const ms = e?.code === 'rate' && Number(e.retryAfter) > 0 ? e.retryAfter * 1000 : 800;
        if (attempt < 2) await sleep(Math.min(ms, 5000));
      }
    }
    // could not put it back: remember, so the next restore() (pause, leaving) tries again
    lowered = true;
  }

  async function info() {
    try { return await wait(call(() => api.info()), VOLUME_WAIT_MS, timers); } catch (e) { rateLimited(e); return null; }
  }

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
      const d = lowered ? { volume: saved, supports: true } : await info();
      if (my !== op) return false; // stopped (or a newer fade) meanwhile: that one decides
      if (!d?.supports || !Number.isFinite(d.volume) || d.volume <= 0) { go(); return false; }
      if (!lowered) saved = Math.round(d.volume);
      const full = saved;
      const low = Math.max(1, Math.round(full * 0.1));
      try {
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
          if (v === full) { lowered = false; saved = null; }
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
      const d = lowered ? { volume: saved, supports: true } : await info();
      if (my !== op) return false;
      if (!d?.supports || !Number.isFinite(d.volume) || d.volume <= 0) { await stop(); return false; }
      if (!lowered) saved = Math.round(d.volume);
      const full = saved;
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
 * The music of a Discobingo round on the leader's device, with fades. `player`: player.js
 * (state, subscribe, play, audioElement); `spotifyApi`: { info, setVolume, pause }.
 *   fadeInPlay(ms): start the loaded song now, silent, at full volume after ms.
 *   fadeOutThen(fn, ms): fade the playing song out, then fn() (stop / pause); at once when
 *     nothing plays. Returns a Promise.
 * By itself: the last FADE_OUT_MS of a fragment or of the Spotify play limit fade out, and
 * whatever stops the music otherwise (the leader's own pause, an error, leaving) puts the
 * user's Spotify volume back at once. destroy() puts everything back.
 */
export function createRoundMusic({ player, spotifyApi, timers = realTimers, win = typeof window !== 'undefined' ? window : null }) {
  const audio = createAudioFader(() => player.audioElement(), { timers });
  const sp = createSpotifyFader(spotifyApi, { timers });
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
