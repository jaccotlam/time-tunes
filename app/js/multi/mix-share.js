// "Doe mijn favorieten erbij": this phone adds a part of its owner's most played Spotify
// songs to the "Mix van de groep" of a server room. Runs on the phone itself:
//   1. log in at Spotify when needed (scope user-top-read; back in the same room afterwards),
//   2. fetch the top 50 of the chosen period and pick `count` of them at random,
//   3. per song look up the Apple Music fragment and the best year (throttled iTunes queue),
//   4. send every song to the room as soon as it is ready (mix-add), not all at the end.
// Progress is kept in localStorage, so a reload (or the Spotify login) goes on where it was,
// and after a server restart the songs are sent again. Withdraw = mix-clear.
// The other way in, "Kies een playlist" (public Deezer playlists, no login), is mix-lists.js:
// it lives inside this object (api.lists), so the screens keep one mix object per room. A phone
// takes part one way at a time: favourites or playlists (one withdraw takes out either).
import * as spotify from '../spotify.js';
import * as top from '../spotify-top.js';
import { appleMatch } from '../apple-match.js';
import { store } from '../ui.js';
import { createListShare, forgetMixLists } from './mix-lists.js';
import {
  pickTopSelection, contributionTrack, TOP_POOL, DEFAULT_RANGE, DEFAULT_SHARE_COUNT, SHARE_COUNTS, validRange, MIX_PER_MESSAGE,
} from './mix.js';

/** { code, member, range, count, tracks (sent), todo (still to look up), skipped, at } */
export const SHARE_KEY = 'timetunesr.mixShare.v1';
/** Set right before the Spotify login: { code, range, count, at } (sessionStorage). */
export const INTENT_KEY = 'timetunesr.mixIntent';
const PREF_KEY = 'timetunesr.mixChoice.v1';
const RESEND_MS = 4000;
const INTENT_MAX_MS = 30 * 60 * 1000;

const readIntent = () => { try { return JSON.parse(sessionStorage.getItem(INTENT_KEY) || 'null'); } catch { return null; } };
const writeIntent = (v) => { try { if (v) sessionStorage.setItem(INTENT_KEY, JSON.stringify(v)); else sessionStorage.removeItem(INTENT_KEY); } catch { /* ignore */ } };

/** Forget this phone's part (left the room, removed). */
export function forgetMixShare(code) {
  const s = store.get(SHARE_KEY, null);
  if (!code || s?.code === code) store.remove(SHARE_KEY);
  const i = readIntent();
  if (i && (!code || i.code === code)) writeIntent(null);
  forgetMixLists(code);
}

/** The choice of period and number the player made last time. */
export function sharePrefs() {
  const p = store.get(PREF_KEY, null) || {};
  return {
    range: validRange(p.range) ? p.range : DEFAULT_RANGE,
    count: SHARE_COUNTS.includes(p.count) ? p.count : DEFAULT_SHARE_COUNT,
  };
}

/**
 * session: the room session (server-session.js) with mixAdd(tracks), mixClear(), online.
 * memberId(): this phone's id in the room. returnHash: where Spotify sends us back to.
 * onChange(): redraw. inLobby(): is the room in the lobby (the playlists are only checked then).
 */
export function createMixShare({ code, memberId, session, returnHash, onChange, inLobby = () => true }) {
  let alive = true;
  let ctrl = null;
  let lastSend = 0;
  let resyncAt = null; // server count at the last full resend
  let recheck = 0;
  const st = {
    phase: 'idle', // idle | connecting | fetching | matching | done | error
    error: '',
    ...sharePrefs(),
    total: 0,
    done: 0,
    tracks: [],
    skipped: 0,
  };
  const emit = () => { if (alive) { try { onChange?.(); } catch (e) { console.error(e); } } };
  // The Spotify app to log in with: this phone's own Client ID when it has one, else the
  // spelleider's that the room passes on (meta.spotifyClientId), so only the spelleider sets it up.
  const roomClientId = () => {
    const c = session.meta?.spotifyClientId;
    return spotify.looksLikeClientId(c) ? c : '';
  };
  const clientId = () => spotify.getClientId() || roomClientId();
  const mine = () => {
    const s = store.get(SHARE_KEY, null);
    return s && s.code === code && s.member === memberId() ? s : null;
  };
  const save = (todo) => store.set(SHARE_KEY, {
    code, member: memberId(), range: st.range, count: st.count, tracks: st.tracks, todo, skipped: st.skipped, at: Date.now(),
  });

  function send(tracks) {
    if (!tracks.length) return true;
    let ok = true;
    for (let i = 0; i < tracks.length; i += MIX_PER_MESSAGE) {
      ok = session.mixAdd(tracks.slice(i, i + MIX_PER_MESSAGE).map(contributionTrack)) && ok;
    }
    lastSend = Date.now();
    return ok;
  }

  async function lookUp(todo) {
    st.phase = 'matching';
    st.total = st.tracks.length + st.skipped + todo.length;
    st.done = st.tracks.length + st.skipped;
    save(todo);
    emit();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    const rest = todo.slice();
    while (rest.length && alive && !signal.aborted) {
      const t = rest[0];
      let hit = null;
      try {
        hit = await appleMatch({ title: t.title, artist: t.artist, year: t.spYear }, { signal });
      } catch (e) {
        if (e.code === 'aborted') return;
      }
      if (!alive || signal.aborted) return;
      rest.shift();
      const year = hit?.year ?? t.spYear;
      if (!year) st.skipped++;
      else {
        const track = {
          spotifyId: t.spotifyId, title: t.title, artist: t.artist, year,
          yearSure: !!hit?.yearSure, itunesId: hit?.itunesId || null, previewUrl: hit?.previewUrl || null,
        };
        st.tracks.push(track);
        send([track]); // right away: nobody waits for the whole list
      }
      st.done++;
      save(rest);
      emit();
    }
    if (!alive || signal.aborted) return;
    st.phase = 'done';
    save([]);
    emit();
  }

  async function run() {
    st.phase = 'fetching';
    st.error = '';
    emit();
    let list;
    try {
      list = await top.topTracks({ range: st.range, limit: TOP_POOL });
    } catch (e) {
      if (!alive) return;
      st.phase = 'error';
      st.error = top.errorMessage(e);
      emit();
      return;
    }
    if (!alive) return;
    st.tracks = [];
    st.skipped = 0;
    resyncAt = null;
    lookUp(pickTopSelection(list, st.count));
  }

  const lists = createListShare({ code, session, onChange: () => emit(), inLobby });
  const api = {
    get state() { return st; },
    /** "Kies een playlist" (mix-lists.js). */
    lists,
    /** Does the room server take songs from playlists (feature 'mix-playlists')? */
    listsOffered() { return !!session.supports?.('mix-playlists') || lists.active(); },
    /** Which way this phone takes part: 'lists' | 'top' | null (not yet). */
    mode() {
      if (lists.active()) return 'lists';
      if (st.tracks.length || ['connecting', 'fetching', 'matching', 'done'].includes(st.phase)) return 'top';
      return null;
    },
    /** 'own' | 'room' | null: whose Spotify app this phone logs in with. */
    clientSource() { return spotify.getClientId() ? 'own' : roomClientId() ? 'room' : null; },
    /** Can this phone log in at Spotify at all? null, or the reason why not. */
    problem() {
      if (top.canRead()) return null;
      if (!clientId()) return 'no-client';
      return spotify.environmentProblem();
    },
    setChoice({ range, count }) {
      if (validRange(range)) st.range = range;
      if (SHARE_COUNTS.includes(Number(count))) st.count = Number(count);
      store.set(PREF_KEY, { range: st.range, count: st.count });
      emit();
    },
    /** "Doe mijn favorieten erbij". */
    share() {
      if (['connecting', 'fetching', 'matching'].includes(st.phase) || lists.active()) return;
      store.set(PREF_KEY, { range: st.range, count: st.count });
      if (!top.canRead() && !clientId()) { st.phase = 'error'; st.error = top.MESSAGES['no-client']; emit(); return; }
      if (st.tracks.length) { // sharing again: the old part goes first
        session.mixClear();
        st.tracks = [];
      }
      if (top.canRead()) { run(); return; }
      writeIntent({ code, range: st.range, count: st.count, at: Date.now() });
      st.phase = 'connecting';
      st.error = '';
      emit();
      spotify.connect(returnHash, { top: true, clientId: roomClientId() }).catch((err) => {
        writeIntent(null);
        st.phase = 'error';
        st.error = top.errorMessage(err);
        emit();
      });
    },
    /** Take this phone's songs out of the room again. */
    withdraw() {
      if (!session.mixClear()) {
        st.error = 'Even geen verbinding met de kamer. Probeer het zo opnieuw.';
        emit();
        return;
      }
      ctrl?.abort();
      store.remove(SHARE_KEY);
      Object.assign(st, { phase: 'idle', error: '', total: 0, done: 0, tracks: [], skipped: 0 });
      resyncAt = null;
      lists.reset();
      emit();
    },
    /** Every new room state: send the songs again when the server lost them (restart). */
    sync(meta) {
      lists.sync(meta);
      const server = meta?.mix?.mine;
      if (!alive || !Number.isInteger(server) || !session.online) return;
      if (!['matching', 'done'].includes(st.phase) || !st.tracks.length) return;
      if (server >= st.tracks.length || resyncAt === server) return;
      if (Date.now() - lastSend < RESEND_MS) { // songs may still be on their way: look again in a moment
        clearTimeout(recheck);
        recheck = setTimeout(() => api.sync(session.meta), RESEND_MS);
        return;
      }
      resyncAt = server;
      send(st.tracks);
    },
    destroy() {
      alive = false;
      clearTimeout(recheck);
      ctrl?.abort();
      lists.destroy();
      offSp();
    },
  };

  // after the Spotify login (or a reload): go on where we were
  function resume() {
    const intent = readIntent();
    if (intent && intent.code === code && Date.now() - (intent.at || 0) < INTENT_MAX_MS) {
      if (validRange(intent.range)) st.range = intent.range;
      if (SHARE_COUNTS.includes(intent.count)) st.count = intent.count;
      const sp = spotify.getStatus();
      if (sp.busy === 'connecting') { st.phase = 'connecting'; return; }
      writeIntent(null);
      if (top.canRead()) { run(); return; }
      if (sp.error) { st.phase = 'error'; st.error = top.errorMessage({ code: sp.error }); }
      return;
    }
    const saved = mine();
    if (!saved) return;
    st.range = validRange(saved.range) ? saved.range : st.range;
    st.count = SHARE_COUNTS.includes(saved.count) ? saved.count : st.count;
    st.tracks = Array.isArray(saved.tracks) ? saved.tracks : [];
    st.skipped = Number(saved.skipped) || 0;
    const todo = Array.isArray(saved.todo) ? saved.todo : [];
    if (todo.length) lookUp(todo);
    else if (st.tracks.length) { st.phase = 'done'; st.total = st.tracks.length + st.skipped; st.done = st.total; }
  }

  const offSp = spotify.subscribe(() => {
    if (!alive || st.phase !== 'connecting') return;
    resume();
    emit();
  });
  resume();
  return api;
}
