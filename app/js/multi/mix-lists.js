// "Kies een playlist": this phone adds a random part of one or more playlists to the
// "Mix van de groep" of a server room. Runs on the phone itself:
//   1. the guest chooses lists from a PROVIDER (see below), at most MIX_LISTS_MAX,
//   2. the phone reads the songs of every chosen list and makes a plan: every list shuffled,
//      taken in turn (mix.js spreadPlan), so the part is random and spread fairly,
//   3. per song it checks the year: the year the song came with + MusicBrainz's first release
//      of the recording (by ISRC: sure; by title + artist: checked, not sure). Only songs with
//      a CHECKED year go to the room (mix.js checkedYear, the rules of enrich.js),
//   4. every checked song goes to the room at once (mix-add), not all at the end.
// MusicBrainz allows about one request per 1.1 s, so 25 songs take half a minute or so: this
// runs in the background on the guest's own phone (every guest checks in parallel) and uses
// the shared queue of musicbrainz.js (no second rate limiter). It only works in the lobby:
// when a game starts it stops (the leader's phone plays music, nobody's network is busy during
// a round) and goes on in the lobby afterwards.
// What was chosen, checked and shared is kept per room in localStorage, so leaving the screen,
// a reload or a sleeping phone goes on where it was and never sends a song twice; after a
// server restart the songs are sent again (sync). Withdraw = mix-clear.
//
// The provider (where the lists come from) is the seam for the next step. Shape:
//   {
//     lists({ signal }):  Promise<[{ id: string, title, count?, picture? (https), by? }]>
//     tracks(id, { signal, onProgress(read, total) }):
//                         Promise<[{ spotifyId?, title, artist, album?, year?, isrc? }]>
//     errorMessage(e):    Dutch text for an error of the two calls
//   }
// The app has no provider yet (v3-11 removed the public Deezer catalogue that was here), so
// createMixShare passes none, `available()` is false and no screen offers this way.
import * as mbApi from '../musicbrainz.js';
import { store as lsStore } from '../ui.js';
import { MAX_TRACKS, rateEta } from '../playlist-logic.js';
import {
  spreadPlan, checkedYear, contributionTrack, idKeys, mixKey, candidateKey,
  MIX_PER_MESSAGE, MIX_PER_PLAYER, MIX_LISTS_MAX, LIST_COUNTS, DEFAULT_LIST_COUNT, LIST_PLAN_MAX,
} from './mix.js';

/**
 * { v: 2, code, lists, count, shared, plan, checked, skipped, at } (one room at a time).
 * Version 1 (v3-10) held Deezer playlists: it is not read back (load() forgets it).
 */
export const LISTS_KEY = 'timetunesr.mixLists.v1';
const LISTS_FORMAT = 2;
const RESEND_MS = 4000;
const RETRY_MS = 3000;
const FAILS_MAX = 3; // songs in a row that could not be checked: stop and say so
const CHECKED_MAX = 1000;
const STORED_PLAN_MAX = 200;
/** First guess per checked song (MusicBrainz 1 / 1.1 s, two lookups when it does not know the ISRC); the estimate then follows the observed rate (rateEta). */
export const MS_PER_SONG = 2200;

export const EMPTY_LIST_MESSAGE = 'Deze playlist heeft geen nummers die we kunnen gebruiken.';
export const FULL_MESSAGE = `Je kunt hier maximaal ${MIX_LISTS_MAX} playlists kiezen. Haal er eerst een weg.`;
const FAILED_MESSAGE = 'De playlists konden niet worden gelezen. Probeer het zo opnieuw.';

const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const listId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const validY = (y) => Number.isInteger(y) && y >= 1900 && y <= 2100;
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** What a list looks like on the phone (and in storage): only plain, capped fields. */
function listMeta(p) {
  const id = listId(p?.id);
  if (!id) return null;
  return {
    id,
    title: cut(p.title, 120) || 'Playlist',
    count: Number.isSafeInteger(p.count) && p.count >= 0 ? p.count : null,
    by: cut(p.by, 80),
    picture: typeof p.picture === 'string' && /^https:\/\/[^\s"'<>]{4,600}$/.test(p.picture) ? p.picture : null,
  };
}
/** A song of a list as the plan keeps it (plain, capped fields). */
function cleanCand(t) {
  if (!t || typeof t !== 'object') return null;
  const c = { title: cut(t.title, 160).trim(), artist: cut(t.artist, 160).trim() };
  if (typeof t.spotifyId === 'string' && SPOTIFY_ID.test(t.spotifyId)) c.spotifyId = t.spotifyId;
  if (typeof t.isrc === 'string' && ISRC.test(t.isrc)) c.isrc = t.isrc;
  const y = Number(t.year);
  if (validY(y)) c.year = y;
  return c.title && c.artist && candidateKey(c) ? c : null;
}
/** A candidate of the plan, compact for storage. */
const packCand = (c) => ({ s: c.spotifyId || null, i: c.isrc || null, t: c.title, a: c.artist, y: c.year || null, l: c.list });
const unpackCand = (c) => {
  const t = cleanCand({ spotifyId: c?.s, isrc: c?.i, title: c?.t, artist: c?.a, year: c?.y });
  return t && listId(c?.l) ? { ...t, list: c.l } : null;
};
const sharedOk = (t) => t && (typeof t.spotifyId === 'string' || typeof t.isrc === 'string') && validY(t.year) && typeof t.title === 'string';

/** Forget this phone's playlists for the room (left the room, closed it). */
export function forgetMixLists(code, store = lsStore) {
  const s = store.get(LISTS_KEY, null);
  if (!code || s?.code === code) store.remove(LISTS_KEY);
}

/**
 * session: the room session with mixAdd(tracks), mixClear(), online, meta.
 * provider: where the lists come from (see the top of this file), or null (none: nothing offered).
 * inLobby(): may the phone work now (the room is in the lobby)?
 * onChange(): redraw. deps (tests): { musicbrainz, store, rand, wait }.
 */
export function createListShare({ code, session, provider = null, onChange, inLobby = () => true, deps = {} }) {
  const mb = deps.musicbrainz || mbApi;
  const store = deps.store || lsStore;
  const rand = deps.rand || Math.random;
  const wait = deps.wait || ((ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  }));
  const failText = (e) => { try { return provider?.errorMessage?.(e) || FAILED_MESSAGE; } catch { return FAILED_MESSAGE; } };

  let alive = true;
  let gen = 0; // every rebuild / stop starts a new generation: an older walk stops by itself
  let walking = false;
  let ctrl = null;
  let pickCtrl = null;
  let lastSend = 0;
  let resyncAt = null;
  let recheck = 0;
  let plan = []; // candidates still to look at, in order
  let checked = []; // [candidateKey, year | 0, sure 0|1, listId]: what this phone already decided
  let pace = null; // { t0, n0, n, last }: songs shared since this walk started, for an honest estimate
  const tracksOf = new Map(); // listId -> songs read this session

  const st = {
    view: 'home', // home | pick
    phase: 'idle', // idle | reading | checking | waiting (a game runs) | done | error
    error: '',
    lists: [],
    count: DEFAULT_LIST_COUNT,
    shared: [],
    skipped: 0,
    read: 0, // songs read while reading the lists
    readTotal: 0,
    // the picker: the provider's lists
    choices: [],
    loading: false,
    pickError: '',
    pickMsg: '',
    adding: '',
    stale: false, // the lists changed and the plan is not made yet
  };
  const emit = () => { if (alive) { try { onChange?.(); } catch (e) { console.error(e); } } };

  /* ---------- storage ---------- */
  function save() {
    if (!st.lists.length) { forgetMixLists(code, store); return; }
    store.set(LISTS_KEY, {
      v: LISTS_FORMAT,
      code,
      lists: st.lists,
      count: st.count,
      shared: st.shared,
      plan: plan.slice(0, STORED_PLAN_MAX).map(packCand),
      checked: checked.slice(-CHECKED_MAX),
      skipped: st.skipped,
      stale: st.stale,
      at: Date.now(),
    });
  }
  function load() {
    const s = store.get(LISTS_KEY, null);
    if (s && s.code === code && s.v !== LISTS_FORMAT) { forgetMixLists(code, store); return false; } // v3-10: Deezer lists
    if (!s || s.code !== code || !Array.isArray(s.lists)) return false;
    st.lists = s.lists.map(listMeta).filter(Boolean).slice(0, MIX_LISTS_MAX);
    if (!st.lists.length) return false;
    st.count = LIST_COUNTS.includes(s.count) ? s.count : DEFAULT_LIST_COUNT;
    st.shared = (Array.isArray(s.shared) ? s.shared : []).filter(sharedOk).slice(0, MIX_PER_PLAYER);
    plan = (Array.isArray(s.plan) ? s.plan : []).map(unpackCand).filter(Boolean);
    checked = (Array.isArray(s.checked) ? s.checked : []).filter((c) => Array.isArray(c) && typeof c[0] === 'string').slice(-CHECKED_MAX);
    st.skipped = Number.isSafeInteger(s.skipped) && s.skipped >= 0 ? s.skipped : 0;
    st.stale = s.stale === true;
    return true;
  }

  /* ---------- sending ---------- */
  function send(tracks) {
    if (!tracks.length) return true;
    let ok = true;
    for (let i = 0; i < tracks.length; i += MIX_PER_MESSAGE) {
      ok = session.mixAdd(tracks.slice(i, i + MIX_PER_MESSAGE).map(contributionTrack)) && ok;
    }
    lastSend = Date.now();
    return ok;
  }

  /* ---------- the year check of one song ---------- */
  const known = (k) => {
    for (let i = checked.length - 1; i >= 0; i--) if (checked[i][0] === k) return checked[i];
    return null;
  };
  /** { year, sure } with a checked year, or null (nothing checkable). Rejects on MusicBrainz trouble. */
  async function check(c, signal) {
    let found = null;
    if (c.isrc) {
      const y = await mb.firstReleaseYear(c.isrc, { signal });
      if (validY(y)) found = { via: 'isrc', year: y };
    }
    if (!found) {
      const y = await mb.searchFirstReleaseYear({ title: c.title, artist: c.artist }, { signal });
      if (validY(y)) found = { via: 'search', year: y };
    }
    return checkedYear(c.year ?? null, found);
  }

  const sharedKeys = () => new Set(st.shared.flatMap((t) => [...idKeys(t), mixKey(t)]).filter(Boolean));

  /** Work through the plan until the phone shares `count` songs (only in the lobby). */
  async function walk() {
    if (walking || !alive || st.phase === 'reading') return;
    if (!inLobby()) { if (['checking', 'reading'].includes(st.phase)) { st.phase = 'waiting'; emit(); } return; }
    walking = true;
    const my = gen;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    let fails = 0;
    st.phase = 'checking';
    st.error = '';
    const t0 = Date.now();
    pace = { t0, n0: st.shared.length, n: st.shared.length, last: t0 };
    // the estimate moves on between songs (a countdown, or "MusicBrainz reageert traag…")
    let shown = '';
    const tick = setInterval(() => {
      const k = `${Math.ceil(api.eta() / 5)}|${api.etaStalled()}`;
      if (k !== shown) { shown = k; emit(); }
    }, 1000);
    emit();
    try {
      while (alive && my === gen && st.shared.length < st.count && plan.length) {
        if (!inLobby()) { st.phase = 'waiting'; emit(); return; }
        const c = plan[0];
        const ck = candidateKey(c);
        let r;
        const k = known(ck);
        if (k) r = k[1] ? { year: k[1], sure: k[2] === 1 } : null;
        else {
          try {
            r = await check(c, signal);
          } catch (e) {
            if (signal.aborted || my !== gen || e?.code === 'aborted') return;
            fails++;
            if (fails >= FAILS_MAX) {
              st.phase = 'error';
              st.error = mb.errorMessage(e);
              save();
              emit();
              return;
            }
            await wait(RETRY_MS * fails, signal);
            continue; // the same song again
          }
          if (signal.aborted || my !== gen) return;
          checked.push([ck, r ? r.year : 0, r?.sure ? 1 : 0, c.list]);
        }
        fails = 0;
        plan.shift();
        if (r) {
          const t = { title: c.title, artist: c.artist, year: r.year, yearSure: r.sure, checked: true, l: c.list };
          if (c.spotifyId) t.spotifyId = c.spotifyId;
          if (c.isrc) t.isrc = c.isrc;
          const have = sharedKeys();
          if (![...idKeys(t), mixKey(t)].some((x) => x && have.has(x))) {
            st.shared.push(t);
            if (pace) { pace.n++; pace.last = Date.now(); }
            send([t]); // right away: nobody waits for the whole list
          }
        } else st.skipped++;
        save();
        emit();
      }
      if (alive && my === gen) {
        st.phase = 'done';
        save();
        emit();
      }
    } finally {
      clearInterval(tick);
      walking = false;
      if (alive && my !== gen) Promise.resolve().then(walk); // a rebuild came in meanwhile
    }
  }

  function stop() {
    gen++;
    ctrl?.abort();
    ctrl = null;
  }

  /** The chosen lists changed (or the number): read them, make a new plan, share again. */
  async function rebuild() {
    stop();
    const my = gen;
    if (!st.lists.length) { reset(); return; }
    if (!inLobby()) { st.phase = 'waiting'; save(); emit(); return; }
    if (!provider) { st.phase = 'error'; st.error = FAILED_MESSAGE; emit(); return; }
    st.phase = 'reading';
    st.stale = true; // until the new plan is made (a reload reads the lists again)
    st.error = '';
    st.read = 0;
    st.readTotal = st.lists.reduce((n, l) => n + (l.count || 0), 0);
    emit();
    const signal = (ctrl = new AbortController()).signal;
    const lists = [];
    try {
      for (const l of st.lists) {
        if (!tracksOf.has(l.id)) {
          const base = st.read;
          const tracks = await provider.tracks(l.id, {
            signal,
            onProgress: (n) => { if (my === gen) { st.read = base + n; emit(); } },
          });
          tracksOf.set(l.id, (Array.isArray(tracks) ? tracks : []).slice(0, MAX_TRACKS).map(cleanCand).filter(Boolean));
        }
        lists.push({ id: l.id, tracks: tracksOf.get(l.id) });
      }
    } catch (e) {
      if (signal.aborted || my !== gen || e?.code === 'aborted') return;
      st.phase = 'error';
      st.error = failText(e);
      save();
      emit();
      return;
    }
    if (my !== gen) return;
    ctrl = null;
    // what this phone checked before stays first in its list: changing the lists keeps most
    // of the songs shared already (they are a random part of that list anyway)
    const first = {};
    for (const [k, , , l] of checked) (first[l] ||= []).push(k);
    plan = spreadPlan(lists, { rand, max: LIST_PLAN_MAX, first });
    st.stale = false;
    st.phase = 'checking';
    // start over in the room: the new plan decides which songs belong to this phone's part
    if (st.shared.length) session.mixClear();
    st.shared = [];
    st.skipped = 0;
    resyncAt = null;
    save();
    walk();
  }

  function reset() {
    stop();
    plan = [];
    Object.assign(st, { phase: 'idle', error: '', lists: [], shared: [], skipped: 0, read: 0, readTotal: 0, stale: false });
    resyncAt = null;
    forgetMixLists(code, store);
  }

  /* ---------- the picker ---------- */
  async function loadChoices() {
    if (!provider) return;
    pickCtrl?.abort();
    const pc = (pickCtrl = new AbortController());
    st.loading = true;
    st.pickError = '';
    emit();
    try {
      const items = await provider.lists({ signal: pc.signal });
      if (pc.signal.aborted) return;
      st.choices = (Array.isArray(items) ? items : []).map(listMeta).filter(Boolean);
    } catch (e) {
      if (pc.signal.aborted || e?.code === 'aborted') return;
      st.pickError = failText(e);
    } finally {
      if (pickCtrl === pc) { st.loading = false; emit(); }
    }
  }

  function addById(id) {
    if (st.lists.some((l) => l.id === id)) { st.view = 'home'; emit(); return; }
    if (st.lists.length >= MIX_LISTS_MAX) { st.pickMsg = FULL_MESSAGE; emit(); return; }
    const meta = st.choices.find((r) => r.id === id) || null;
    if (!meta) return;
    if (meta.count === 0) { st.pickMsg = EMPTY_LIST_MESSAGE; emit(); return; }
    st.lists = [...st.lists, meta];
    st.view = 'home';
    st.pickMsg = '';
    rebuild();
  }

  const api = {
    get state() { return st; },
    /** Is there a provider to choose lists from? (none yet in this version) */
    available() { return !!provider; },
    /** Seconds still to go (estimate from the rate observed so far), or 0. */
    eta() {
      if (st.phase !== 'checking' || !pace) return 0;
      return rateEta({ done: pace.n - pace.n0, left: st.count - st.shared.length, startedAt: pace.t0, lastAt: pace.last, firstGuessMs: MS_PER_SONG }).sec;
    },
    /** No new song checked for 10 s: the screen says MusicBrainz is slow instead of counting down. */
    etaStalled() {
      if (st.phase !== 'checking' || !pace) return false;
      return rateEta({ done: pace.n - pace.n0, left: st.count - st.shared.length, startedAt: pace.t0, lastAt: pace.last }).stalled;
    },
    open() { if (!provider) return; st.view = 'pick'; st.pickMsg = ''; emit(); loadChoices(); },
    close() { pickCtrl?.abort(); st.view = 'home'; st.loading = false; st.pickMsg = ''; emit(); },
    add(id) { const v = listId(String(id ?? '')); if (v) addById(v); },
    remove(id) {
      const v = listId(String(id ?? ''));
      if (!v || !st.lists.some((l) => l.id === v)) return;
      st.lists = st.lists.filter((l) => l.id !== v);
      if (!st.lists.length) { if (st.shared.length) session.mixClear(); reset(); emit(); return; }
      rebuild();
    },
    setCount(n) {
      const c = Number(n);
      if (!LIST_COUNTS.includes(c) || c === st.count) return;
      st.count = c;
      if (!st.lists.length) { emit(); return; }
      if (st.shared.length > c) { rebuild(); return; } // fewer: the plan decides again (checked songs are instant)
      save();
      if (st.phase === 'done' && plan.length) walk(); else emit();
    },
    retry() { if (st.phase === 'error') { if (st.stale || !plan.length) rebuild(); else walk(); } },
    /** Does this phone take part with playlists (chosen, or still to finish)? */
    active() { return st.lists.length > 0; },
    /** Withdraw: the caller sends mix-clear; here everything of the lists is forgotten. */
    reset() { reset(); emit(); },
    /** Every new room state: go on in the lobby, stop during a game, send again after a server restart. */
    sync(meta) {
      if (!alive) return;
      const lobby = inLobby();
      if (!lobby && (walking || st.phase === 'reading')) { stop(); st.phase = 'waiting'; emit(); }
      else if (lobby && st.phase === 'waiting') { if (st.stale || (!plan.length && !st.shared.length)) rebuild(); else walk(); }
      const server = meta?.mix?.mine;
      if (!Number.isInteger(server) || !session.online || !st.shared.length) return;
      if (server >= st.shared.length || resyncAt === server) return;
      if (Date.now() - lastSend < RESEND_MS) { // songs may still be on their way: look again in a moment
        clearTimeout(recheck);
        recheck = setTimeout(() => api.sync(session.meta), RESEND_MS);
        return;
      }
      resyncAt = server;
      send(st.shared);
    },
    destroy() {
      alive = false;
      clearTimeout(recheck);
      stop();
      pickCtrl?.abort();
    },
  };

  // back on this screen (reload, came back, phone woke up): go on where it was
  if (load()) {
    // walk() / rebuild() start with the first room state in the lobby (sync)
    if (st.stale || (!plan.length && !st.shared.length)) st.phase = 'waiting'; // read the lists again
    else st.phase = st.shared.length >= st.count || !plan.length ? 'done' : 'waiting';
  }
  return api;
}
