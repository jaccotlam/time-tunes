// The music fades of a Discobingo round (app/js/fade.js), with fake timers, a fake <audio>
// element and a fake Spotify API: the ramp, the iOS fallback, the request budget, a 429,
// failing calls, interrupted fades, and that the user's Spotify volume always comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ramp, volumeWorks, createAudioFader, createSpotifyFader, createRoundMusic, FADE_OUT_MS, SPOTIFY_MAX_REQUESTS, VOLUME_WAIT_MS,
} from '../../app/js/fade.js';

/** Manual clock: set/clear/now plus advance(ms), which runs what is due and lets promises settle. */
function fakeTimers() {
  let t = 0;
  let seq = 0;
  const q = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    set: (fn, ms) => { const id = ++seq; q.set(id, { at: t + Math.max(0, ms), fn }); return id; },
    clear: (id) => { q.delete(id); },
    now: () => t,
    async advance(ms, step = 10) {
      const end = t + ms;
      while (t < end) {
        await tick();
        t = Math.min(end, t + step);
        for (const [id, x] of [...q].sort((a, b) => a[1].at - b[1].at)) if (x.at <= t && q.has(id)) { q.delete(id); x.fn(); await tick(); }
      }
      for (let i = 0; i < 5; i++) await tick();
    },
  };
}
const audioEl = (works = true) => {
  let v = 1;
  return { get volume() { return v; }, set volume(x) { if (works) v = x; }, log: [] };
};
/** A Spotify device with a volume; `fail(n)` lets the next calls fail; `rate` answers 429. */
function fakeSpotify({ volume = 64, supports = true } = {}) {
  const s = { volume, supports, calls: [], failNext: 0, rateNext: 0, retryAfter: 1, infoFails: false, slowInfo: false, paused: 0 };
  s.api = {
    info: () => { s.calls.push('info'); if (s.infoFails) return Promise.reject(new Error('x')); if (s.slowInfo) return new Promise(() => {}); return Promise.resolve({ volume: s.volume, supports: s.supports }); },
    setVolume: (v) => {
      s.calls.push(v);
      if (s.rateNext > 0) { s.rateNext--; return Promise.reject(Object.assign(new Error('rate'), { code: 'rate', retryAfter: s.retryAfter })); }
      if (s.failNext > 0) { s.failNext--; return Promise.reject(Object.assign(new Error('x'), { code: 'unavailable' })); }
      s.volume = v;
      return Promise.resolve(null);
    },
    pause: () => { s.paused++; return Promise.resolve(null); },
  };
  s.volumes = () => s.calls.filter((c) => typeof c === 'number');
  return s;
}

test('ramp: gelijke stappen, laatste precies het doel, afbreken', async () => {
  const tm = fakeTimers();
  const seen = [];
  const r = ramp({ from: 0, to: 1, ms: 1000, steps: 4, apply: (v) => seen.push(v), timers: tm });
  await tm.advance(1000);
  assert.deepEqual(seen, [0.25, 0.5, 0.75, 1]);
  assert.equal(await r.done, true);
  const seen2 = [];
  const r2 = ramp({ from: 1, to: 0, ms: 1000, steps: 10, apply: (v) => seen2.push(v), timers: tm });
  await tm.advance(250);
  r2.cancel();
  await tm.advance(1000);
  assert.equal(await r2.done, false);
  assert.ok(seen2.length < 5 && seen2.at(-1) > 0, 'afgebroken: geen verdere stappen');
  const seen3 = [];
  ramp({ from: 0, to: 1, ms: 0, steps: 5, apply: (v) => seen3.push(v), timers: tm });
  assert.deepEqual(seen3, [1], 'geen tijd: meteen het doel');
});

test('fragment: van stil naar vol tijdens de draai, en weer naar stil; iOS (volume werkt niet) = geen fade', async () => {
  const tm = fakeTimers();
  const a = audioEl();
  assert.equal(volumeWorks(a), true);
  const f = createAudioFader(() => a, { timers: tm });
  f.fadeIn(4000);
  assert.ok(a.volume < 0.05, 'stil aan het begin van de draai');
  await tm.advance(2000);
  assert.ok(a.volume > 0.4 && a.volume < 0.6, `halverwege half (${a.volume})`);
  await tm.advance(2100);
  assert.equal(a.volume, 1, 'vol als de bal landt');
  const out = f.fadeOut(1200);
  await tm.advance(600);
  assert.ok(a.volume < 0.6 && a.volume > 0.3);
  await tm.advance(700);
  assert.equal(await out, true);
  assert.equal(a.volume, 0);
  f.reset();
  assert.equal(a.volume, 1, 'terug op vol voor het volgende nummer');
  // interrupted fade-in: reset puts it at full volume
  f.fadeIn(4000);
  await tm.advance(500);
  f.reset();
  await tm.advance(4000);
  assert.equal(a.volume, 1);
  const ios = audioEl(false);
  assert.equal(volumeWorks(ios), false);
  const g = createAudioFader(() => ios, { timers: tm });
  assert.equal(await g.fadeIn(4000), false);
  assert.equal(ios.volume, 1, 'iOS: gewoon vol, niets kapot');
  assert.equal(await g.fadeOut(1200), false);
});

test('Spotify: fade-in in een paar stappen, nooit meer dan 6 verzoeken, het nummer start meteen, volume terug zoals het was', async () => {
  const tm = fakeTimers();
  const s = fakeSpotify({ volume: 64 });
  const f = createSpotifyFader(s.api, { timers: tm });
  let started = 0;
  const p = f.fadeIn(4000, () => { started++; });
  await tm.advance(50);
  assert.equal(started, 1, 'het nummer start na de eerste (snelle) volumestap');
  assert.ok(s.volume <= 10, 'zacht aan het begin');
  await tm.advance(4200);
  assert.equal(await p, true);
  assert.equal(s.volume, 64, 'precies het volume van de gebruiker');
  assert.ok(s.calls.length <= SPOTIFY_MAX_REQUESTS, `${s.calls.length} verzoeken`);
  assert.equal(f.lowered, false);
  // fade-out: down, pause, then the user's volume again
  const o = f.fadeOut(FADE_OUT_MS, s.api.pause);
  await tm.advance(FADE_OUT_MS + 200);
  assert.equal(await o, true);
  assert.equal(s.paused, 1);
  assert.equal(s.volume, 64, 'na de pauze weer het eigen volume');
  assert.ok(f.requests <= SPOTIFY_MAX_REQUESTS);
  const vols = s.volumes();
  assert.ok(vols.slice(-4, -1).every((v, i, xs) => i === 0 || v < xs[i - 1]), `omlaag in stappen ${vols}`);
});

test('Spotify: geen volume-ondersteuning of een falende info = geen fade, het nummer start gewoon', async () => {
  const tm = fakeTimers();
  for (const setup of [(s) => { s.supports = false; }, (s) => { s.infoFails = true; }, (s) => { s.slowInfo = true; }]) {
    const s = fakeSpotify();
    setup(s);
    const f = createSpotifyFader(s.api, { timers: tm });
    let started = 0;
    const p = f.fadeIn(4000, () => { started++; });
    await tm.advance(VOLUME_WAIT_MS + 50);
    assert.equal(started, 1, 'het nummer start (hooguit even later)');
    assert.equal(await p, false);
    assert.deepEqual(s.volumes(), [], 'het volume blijft onaangeroerd');
    const o = f.fadeOut(1200, s.api.pause);
    await tm.advance(1500);
    await o;
    assert.equal(s.paused, 1, 'zonder fade gewoon pauze');
    assert.equal(s.volume, 64);
  }
});

test('Spotify: falende of 429-volumestap -> het eigen volume komt terug; daarna even geen fades', async () => {
  const tm = fakeTimers();
  // the very first step fails: the song starts at once, the volume is put back
  let s = fakeSpotify({ volume: 80 });
  let f = createSpotifyFader(s.api, { timers: tm });
  s.failNext = 1;
  let started = 0;
  let p = f.fadeIn(4000, () => { started++; });
  await tm.advance(3000);
  assert.equal(started, 1);
  assert.equal(await p, false);
  assert.equal(s.volume, 80, 'nooit lager dan voorheen');
  assert.equal(f.lowered, false);
  // a 429 halfway: stop stepping, restore (after its Retry-After), no fade for a while
  s = fakeSpotify({ volume: 50 });
  f = createSpotifyFader(s.api, { timers: tm });
  p = f.fadeIn(3000, () => {});
  await tm.advance(1100);
  s.rateNext = 2; // the step fails, the first restore try too
  s.retryAfter = 30;
  await tm.advance(7000);
  assert.equal(await p, false);
  assert.equal(s.volume, 50, 'na de 429 toch weer het eigen volume');
  const before = s.calls.length;
  const p2 = f.fadeIn(3000, () => {});
  await tm.advance(100);
  assert.equal(await p2, false, 'vlak na een 429: geen fade');
  assert.equal(s.calls.length, before, 'en geen verzoeken');
});

test('Spotify: onderbroken fade (pauze, weggaan) zet het volume meteen terug; nooit op 0 achtergelaten', async () => {
  const tm = fakeTimers();
  const s = fakeSpotify({ volume: 70 });
  const f = createSpotifyFader(s.api, { timers: tm });
  f.fadeIn(4000, () => {});
  await tm.advance(500);
  assert.ok(s.volume < 70);
  f.interrupt();
  await tm.advance(50);
  assert.equal(s.volume, 70);
  await tm.advance(5000);
  assert.equal(s.volume, 70, 'de afgebroken fade zet daarna niets meer');
  // a fade-out interrupted halfway (the leader leaves the screen)
  const o = f.fadeOut(1200, s.api.pause);
  await tm.advance(450);
  assert.ok(s.volume < 70);
  f.interrupt({ keepalive: true });
  await tm.advance(2000);
  assert.equal(await o, false);
  assert.equal(s.volume, 70);
  // a restore that fails is tried again by the next one
  f.fadeIn(4000, () => {});
  await tm.advance(200);
  s.failNext = 3;
  f.interrupt();
  await tm.advance(3000);
  assert.equal(f.lowered, true, 'nog niet terug: onthouden');
  f.restore();
  await tm.advance(50);
  assert.equal(s.volume, 70);
  assert.equal(f.lowered, false);
});

/** A fake player.js: state, subscribe, play, pause, audioElement. */
function fakePlayer(source = 'lookup') {
  const subs = new Set();
  const a = audioEl();
  const p = {
    state: { status: 'ready', source, cardId: 'c1', currentTime: 0, duration: 30 },
    plays: 0,
    audioElement: () => a,
    subscribe(fn) { subs.add(fn); fn(p.state); return () => subs.delete(fn); },
    set(patch) { Object.assign(p.state, patch); for (const fn of subs) fn(p.state); },
    play() { p.plays++; p.set({ status: 'playing' }); return Promise.resolve(true); },
    pause() { p.set({ status: 'paused' }); },
    stop() { p.set({ status: 'idle', cardId: null }); },
  };
  return { p, a };
}

test('ronde-muziek: start stil tijdens de draai, fade aan het eind van het fragment, fade-out bij stoppen', async () => {
  const tm = fakeTimers();
  const { p, a } = fakePlayer();
  const s = fakeSpotify();
  const m = createRoundMusic({ player: p, spotifyApi: s.api, timers: tm, win: null });
  m.fadeInPlay(3500);
  assert.equal(p.plays, 1, 'het nummer speelt al tijdens de draai');
  assert.ok(a.volume < 0.05, 'stil');
  await tm.advance(3600);
  assert.equal(a.volume, 1);
  // the last 1.2 s of the fragment
  p.set({ currentTime: 29 });
  await tm.advance(500);
  assert.ok(a.volume < 1, 'zachter aan het eind');
  await tm.advance(800);
  p.set({ status: 'ended', currentTime: 30 });
  await tm.advance(50);
  assert.equal(a.volume, 1, 'na het einde weer vol voor het volgende');
  // a stop with a fade (next round, a bingo): first the fade, then the stop
  p.set({ status: 'playing', cardId: 'c2', currentTime: 5 });
  let stopped = false;
  const out = m.fadeOutThen(() => { stopped = true; p.stop(); }, 1200);
  await tm.advance(600);
  assert.equal(stopped, false);
  assert.ok(a.volume < 0.7);
  await tm.advance(800);
  await out;
  assert.equal(stopped, true);
  assert.equal(a.volume, 1);
  // nothing plays: at once
  let now = false;
  await m.fadeOutThen(() => { now = true; });
  assert.equal(now, true);
  m.destroy();
});

test('ronde-muziek met Spotify: de eigen pauze van de spelleider zet het volume meteen terug', async () => {
  const tm = fakeTimers();
  const { p } = fakePlayer('spotify');
  const s = fakeSpotify({ volume: 55 });
  const m = createRoundMusic({ player: p, spotifyApi: s.api, timers: tm, win: null });
  m.fadeInPlay(4000);
  await tm.advance(800);
  assert.equal(p.plays, 1);
  assert.ok(s.volume < 55);
  p.pause(); // the leader's own pause (immediate, no fade)
  await tm.advance(100);
  assert.equal(s.volume, 55, 'pauze: terug op het eigen volume');
  await tm.advance(5000);
  assert.equal(s.volume, 55);
  // the play limit: a fade-out, pause, then the user's volume
  p.set({ status: 'playing', cardId: 'c3', currentTime: 28.6, duration: 30 });
  await tm.advance(2000);
  assert.ok(s.paused >= 1);
  assert.equal(s.volume, 55);
  // leaving the screen in the middle of a fade-in
  m.fadeInPlay(4000);
  await tm.advance(500);
  m.destroy();
  await tm.advance(100);
  assert.equal(s.volume, 55, 'weg van het scherm: het eigen volume');
});
