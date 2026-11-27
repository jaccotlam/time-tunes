// "Kies een playlist": this phone adds a random part of one or more PUBLIC Deezer playlists
// to the "Mix van de groep" of a server room, without any login. Runs on the phone itself:
//   1. the guest finds a playlist (search by name, a quick pick, or a pasted deezer.com link;
//      a Spotify link gets an explanation: Spotify gives apps no songs of other people's lists),
//   2. the phone reads the songs of every chosen list (deezer.js) and makes a plan: every list
//      shuffled, taken in turn (mix.js spreadPlan), so the part is random and spread fairly,
//   3. per song it checks the year: Deezer's year of the release + MusicBrainz's first release
//      of the recording (by ISRC: sure; by title + artist: checked, not sure). Only songs with
//      a CHECKED year go to the room (mix.js checkedYear, the rules of enrich.js),
//   4. every checked song goes to the room at once (mix-add), not all at the end.
// MusicBrainz allows about one request per 1.1 s, so 25 songs take half a minute or so: this
// runs in the background on the guest's own phone (every guest checks in parallel) and uses
// the shared queues of deezer.js / musicbrainz.js (no second rate limiter). It only works in
// the lobby: when a game starts it stops (the leader's phone plays music, nobody's network is
// busy during a round) and goes on in the lobby afterwards.
// What was chosen, checked and shared is kept per room in localStorage, so leaving the screen,
// a reload or a sleeping phone goes on where it was and never sends a song twice; after a
// server restart the songs are sent again (sync). Withdraw = mix-clear.
import * as deezerApi from '../deezer.js';
import * as mbApi from '../musicbrainz.js';
import { store as lsStore } from '../ui.js';
import { MAX_TRACKS } from '../playlist-logic.js';
import {
  spreadPlan, checkedYear, contributionTrack, idKeys, mixKey,
  MIX_PER_MESSAGE, MIX_PER_PLAYER, MIX_LISTS_MAX, LIST_COUNTS, DEFAULT_LIST_COUNT, LIST_PLAN_MAX,
} from './mix.js';

/** { v, code, lists, count, shared, plan, checked, skipped, at } (one room at a time). */
export const LISTS_KEY = 'timetunesr.mixLists.v1';
const RESEND_MS = 4000;
const RETRY_MS = 3000;
const FAILS_MAX = 3; // songs in a row that could not be checked: stop and say so
const CHECKED_MAX = 1000;
const STORED_PLAN_MAX = 200;
const SEARCH_LIMIT = 12;
/** About one checked song per this many ms (MusicBrainz 1 / 1.1 s, sometimes two lookups). */
export const MS_PER_SONG = 1300;

export const SPOTIFY_LINK_MESSAGE = 'Spotify laat apps andermans playlists niet lezen. Zoek de lijst hierboven op naam of plak een Deezer-link.';
export const SHORT_LINK_MESSAGE = 'Dit is een korte Deezer-link. Open hem eerst in je browser of in de Deezer-app en kopieer dan het adres waar /playlist/ in staat.';
export const BAD_LINK_MESSAGE = 'Dit is geen Deezer-playlistlink. Een goede link ziet er zo uit: deezer.com/nl/playlist/1266971851';
export const EMPTY_LIST_MESSAGE = 'Deze playlist heeft geen nummers die we kunnen gebruiken.';
export const PRIVATE_MESSAGE = 'Deze playlist is niet openbaar of bestaat niet (meer) bij Deezer.';
export const FULL_MESSAGE = `Je kunt hier maximaal ${MIX_LISTS_MAX} playlists kiezen. Haal er eerst een weg.`;

const isSpotifyLink = (s) => /(^|\b)(open\.spotify\.com|spotify\.link|spotify:)/i.test(s);
const isShortDeezer = (s) => /(link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)/i.test(s);
const looksLikeLink = (s) => /^(https?:\/\/|www\.|[a-z0-9.-]+\.(com|link|page)\/|deezer:|spotify:)/i.test(s.trim());
const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const posId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const validY = (y) => Number.isInteger(y) && y >= 1900 && y <= 2100;

/** What a list looks like on the phone (and in storage): only plain, capped fields. */
function listMeta(p) {
  const id = posId(p?.id);
  if (!id) return null;
  return {
    id,
    title: cut(p.title, 120) || 'Deezer-playlist',
    count: Number.isSafeInteger(p.count) && p.count >= 0 ? p.count : null,
    by: cut(p.by, 80),
    picture: typeof p.picture === 'string' && /^https:\/\/[a-z0-9.-]+\.dzcdn\.net\//i.test(p.picture) ? p.picture.slice(0, 600) : null,
  };
}
/** A candidate of the plan, compact for storage. */
const packCand = (c) => ({ d: c.deezerId, i: c.isrc || null, t: cut(c.title, 160), a: cut(c.artist, 160), l: c.list });
const unpackCand = (c) => (posId(c?.d) ? { deezerId: c.d, isrc: typeof c.i === 'string' ? c.i : null, title: cut(c.t, 160), artist: cut(c.a, 160), list: posId(c.l) } : null);

/** Forget this phone's playlists for the room (left the room, closed it). */
export function forgetMixLists(code, store = lsStore) {
  const s = store.get(LISTS_KEY, null);
  if (!code || s?.code === code) store.remove(LISTS_KEY);
}

/**
 * session: the room session with mixAdd(tracks), mixClear(), online, meta.
 * inLobby(): may the phone work now (the room is in the lobby)?
 * onChange(): redraw. deps (tests): { deezer, musicbrainz, store, rand, wait }.
 */
export function createListShare({ code, session, onChange, inLobby = () => true, deps = {} }) {
  const dz = deps.deezer || deezerApi;
  const mb = deps.musicbrainz || mbApi;
  const store = deps.store || lsStore;
  const rand = deps.rand || Math.random;
  const wait = deps.wait || ((ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  }));

  let alive = true;
  let gen = 0; // every rebuild / stop starts a new generation: an older walk stops by itself
  let walking = false;
  let ctrl = null;
  let searchCtrl = null;
  let lastSend = 0;
  let resyncAt = null;
  let recheck = 0;
  let plan = []; // candidates still to look at, in order
  let checked = []; // [deezerId, year | 0, sure 0|1, listId]: what this phone already decided
  const tracksOf = new Map(); // listId -> songs read this session
  const info = new Map(); // deezerId -> Promise of trackInfo (looked up a little ahead)

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
    // the picker
    q: '',
    link: '',
    results: [],
    resultsFor: '',
    next: null,
    searching: false,
    searchError: '',
    linkMsg: '',
    linkKind: '', // spotify | short | bad | private | empty | full | error
    adding: 0,
    stale: false, // the lists changed and the plan is not made yet
  };
  const emit = () => { if (alive) { try { onChange?.(); } catch (e) { console.error(e); } } };

  /* ---------- storage ---------- */
  function save() {
    if (!st.lists.length) { forgetMixLists(code, store); return; }
    store.set(LISTS_KEY, {
      v: 1,
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
    if (!s || s.code !== code || s.v !== 1 || !Array.isArray(s.lists)) return false;
    st.lists = s.lists.map(listMeta).filter(Boolean).slice(0, MIX_LISTS_MAX);
    if (!st.lists.length) return false;
    st.count = LIST_COUNTS.includes(s.count) ? s.count : DEFAULT_LIST_COUNT;
    st.shared = (Array.isArray(s.shared) ? s.shared : []).filter((t) => posId(t?.deezerId) && validY(t.year)).slice(0, MIX_PER_PLAYER);
    plan = (Array.isArray(s.plan) ? s.plan : []).map(unpackCand).filter(Boolean);
    checked = (Array.isArray(s.checked) ? s.checked : []).filter((c) => Array.isArray(c) && posId(c[0])).slice(-CHECKED_MAX);
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
  const known = (d) => {
    for (let i = checked.length - 1; i >= 0; i--) if (checked[i][0] === d) return checked[i];
    return null;
  };
  function lookAhead(c, signal) {
    if (!info.has(c.deezerId)) {
      const p = dz.trackInfo(c.deezerId, { signal }).catch((e) => ({ error: e }));
      info.set(c.deezerId, p);
      while (info.size > 20) info.delete(info.keys().next().value);
    }
    return info.get(c.deezerId);
  }
  /** { year, sure, isrc } with a checked year, or null (nothing checkable). Rejects on MusicBrainz trouble. */
  async function check(c, signal) {
    for (const n of plan.slice(1, 3)) if (!known(n.deezerId)) lookAhead(n, signal);
    const d = await lookAhead(c, signal);
    info.delete(c.deezerId);
    if (d?.error?.code === 'aborted' || signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
    if (d?.error?.code === 'notfound') return null; // gone from Deezer: nothing to play either
    const dzYear = d && !d.error && validY(d.year) ? d.year : null;
    const isrc = c.isrc || (d && !d.error ? d.isrc : null) || null;
    let found = null;
    if (isrc) {
      const y = await mb.firstReleaseYear(isrc, { signal });
      if (validY(y)) found = { via: 'isrc', year: y };
    }
    if (!found) {
      const y = await mb.searchFirstReleaseYear({ title: c.title, artist: c.artist }, { signal });
      if (validY(y)) found = { via: 'search', year: y };
    }
    const r = checkedYear(dzYear, found);
    return r ? { ...r, isrc } : null;
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
    emit();
    try {
      while (alive && my === gen && st.shared.length < st.count && plan.length) {
        if (!inLobby()) { st.phase = 'waiting'; emit(); return; }
        const c = plan[0];
        let r;
        const k = known(c.deezerId);
        if (k) r = k[1] ? { year: k[1], sure: k[2] === 1, isrc: c.isrc } : null;
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
          checked.push([c.deezerId, r ? r.year : 0, r?.sure ? 1 : 0, c.list]);
        }
        fails = 0;
        plan.shift();
        if (r) {
          const t = {
            deezerId: c.deezerId, isrc: r.isrc || null, title: c.title, artist: c.artist, year: r.year, yearSure: r.sure, checked: true, l: c.list,
          };
          const have = sharedKeys();
          if (![...idKeys(t), mixKey(t)].some((x) => x && have.has(x))) {
            st.shared.push(t);
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
      walking = false;
      if (alive && my !== gen) Promise.resolve().then(walk); // a rebuild came in meanwhile
    }
  }

  function stop() {
    gen++;
    ctrl?.abort();
    ctrl = null;
    info.clear();
  }

  /** The chosen lists changed (or the number): read them, make a new plan, share again. */
  async function rebuild() {
    stop();
    const my = gen;
    if (!st.lists.length) { reset(); return; }
    if (!inLobby()) { st.phase = 'waiting'; save(); emit(); return; }
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
          const tracks = await dz.playlistTracks(l.id, {
            max: MAX_TRACKS,
            signal,
            onProgress: (n) => { if (my === gen) { st.read = base + n; emit(); } },
          });
          tracksOf.set(l.id, tracks);
        }
        lists.push({ id: l.id, tracks: tracksOf.get(l.id) });
      }
    } catch (e) {
      if (signal.aborted || my !== gen || e?.code === 'aborted') return;
      st.phase = 'error';
      st.error = e?.code === 'notfound' ? PRIVATE_MESSAGE : dz.errorMessage(e);
      save();
      emit();
      return;
    }
    if (my !== gen) return;
    ctrl = null;
    // what this phone checked before stays first in its list: changing the lists keeps most
    // of the songs shared already (they are a random part of that list anyway)
    const first = {};
    for (const [d, , , l] of checked) (first[l] ||= []).push(d);
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
  function setLinkMsg(kind, msg) { st.linkKind = kind; st.linkMsg = msg; }

  async function runSearch(fn, label) {
    searchCtrl?.abort();
    const sc = (searchCtrl = new AbortController());
    st.searching = true;
    st.searchError = '';
    st.resultsFor = label;
    st.results = [];
    st.next = null;
    emit();
    try {
      const r = await fn(sc.signal);
      if (sc.signal.aborted) return;
      st.results = r.items.map(listMeta).filter(Boolean);
      st.next = r.next;
    } catch (e) {
      if (sc.signal.aborted || e?.code === 'aborted') return;
      st.searchError = e?.code === 'notfound' ? PRIVATE_MESSAGE : dz.errorMessage(e);
    } finally {
      if (searchCtrl === sc) { st.searching = false; emit(); }
    }
  }

  async function addById(id) {
    if (st.lists.some((l) => l.id === id)) { st.view = 'home'; emit(); return; }
    if (st.lists.length >= MIX_LISTS_MAX) { setLinkMsg('full', FULL_MESSAGE); emit(); return; }
    st.adding = id;
    emit();
    let meta = st.results.find((r) => r.id === id) || null;
    if (!meta) {
      try {
        meta = listMeta(await dz.playlistInfo(id));
      } catch (e) {
        st.adding = 0;
        setLinkMsg(e?.code === 'notfound' ? 'private' : 'error', e?.code === 'notfound' ? PRIVATE_MESSAGE : dz.errorMessage(e));
        emit();
        return;
      }
    }
    st.adding = 0;
    if (!meta || meta.count === 0) { setLinkMsg('empty', EMPTY_LIST_MESSAGE); emit(); return; }
    if (st.lists.length >= MIX_LISTS_MAX) { setLinkMsg('full', FULL_MESSAGE); emit(); return; }
    st.lists = [...st.lists, meta];
    st.view = 'home';
    st.link = '';
    setLinkMsg('', '');
    rebuild();
  }

  /** A pasted link (or bare id): Deezer -> add; Spotify / short links / anything else -> explained. */
  function pasted(text) {
    const s = String(text || '').trim().slice(0, 500);
    st.link = s;
    if (!s) { setLinkMsg('', ''); emit(); return; }
    if (isSpotifyLink(s)) { setLinkMsg('spotify', SPOTIFY_LINK_MESSAGE); emit(); return; }
    const id = dz.parsePlaylistId(s);
    if (id) { setLinkMsg('', ''); addById(id); return; }
    setLinkMsg(isShortDeezer(s) ? 'short' : 'bad', isShortDeezer(s) ? SHORT_LINK_MESSAGE : BAD_LINK_MESSAGE);
    emit();
  }

  const api = {
    get state() { return st; },
    /** Seconds still to go (estimate), or 0. */
    eta() {
      if (st.phase !== 'checking') return 0;
      return Math.ceil(((st.count - st.shared.length) * MS_PER_SONG) / 1000);
    },
    open() { st.view = 'pick'; setLinkMsg('', ''); emit(); },
    close() { searchCtrl?.abort(); st.view = 'home'; st.searching = false; setLinkMsg('', ''); emit(); },
    /** Typing in the fields: kept for redraws, no redraw itself (the keyboard stays). */
    typed(field, value) { if (field === 'q') st.q = String(value).slice(0, 100); else if (field === 'link') st.link = String(value).slice(0, 500); },
    search(q) {
      const term = String(q ?? st.q).trim().slice(0, 100);
      st.q = term;
      if (!term) return;
      // a link in the search field: treat it as a pasted link
      if (looksLikeLink(term)) { pasted(term); return; }
      setLinkMsg('', '');
      runSearch((signal) => dz.searchPlaylists(term, { limit: SEARCH_LIMIT, signal }), term);
    },
    quick(key) {
      const f = dz.FEATURED.find((x) => x.key === key);
      if (!f) return;
      setLinkMsg('', '');
      if (f.playlistId) {
        st.q = '';
        runSearch(async (signal) => ({ items: [await dz.playlistInfo(f.playlistId, { signal })], next: null }), f.label);
      } else {
        st.q = f.query;
        runSearch((signal) => dz.searchPlaylists(f.query, { limit: SEARCH_LIMIT, signal }), f.label);
      }
    },
    more() {
      if (st.next == null || st.searching || !st.q) return;
      const term = st.q;
      const index = st.next;
      const before = st.results;
      runSearch((signal) => dz.searchPlaylists(term, { index, limit: SEARCH_LIMIT, signal }), st.resultsFor).then(() => {
        const ids = new Set(before.map((r) => r.id));
        st.results = [...before, ...st.results.filter((r) => !ids.has(r.id))];
        emit();
      });
    },
    pasted,
    add(id) { const n = posId(Number(id)); if (n) addById(n); },
    remove(id) {
      const n = posId(Number(id));
      if (!n || !st.lists.some((l) => l.id === n)) return;
      st.lists = st.lists.filter((l) => l.id !== n);
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
      searchCtrl?.abort();
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
