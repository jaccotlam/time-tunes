// "Doe mijn favorieten erbij": this phone adds a part of its owner's most played Spotify
// songs to the "Mix van de groep" of a server room. Runs on the phone itself:
//   1. log in at Spotify when needed (scope user-top-read; back in the same room afterwards),
//   2. fetch the top 50 of the chosen period and pick `count` of them at random,
//   3. per song look up the Apple Music fragment and the best year (throttled iTunes queue),
//   4. send every song to the room as soon as it is ready (mix-add), not all at the end.
// Progress is kept in localStorage, so a reload (or the Spotify login) goes on where it was,
// and after a server restart the songs are sent again. Withdraw = mix-clear.
// The other way in, "Kies uit mijn playlists", is mix-lists.js: it lives inside this object
// (api.lists), so the screens keep one mix object per room. A phone takes part one way at a
// time: favourites or playlists (one withdraw takes out either; both together would have to
// share MIX_PER_PLAYER and could send the same song twice, so the panel offers one at a time).
// It needs a `listProvider` (the guest's own Spotify playlists, mix-spotify.js) and a server
// with the 'mix-lists' feature.
//
// Which Spotify app ("link", spotify-links.js) a guest logs in with: the room passes the
// spelleider's links on (meta.spotifyLinks; an older server only meta.spotifyClientId). With
// one link (or none of the room's and an own setup) nothing is asked, as before. With two or
// more the phone asks once, "Via welke link heeft de spelleider je toegevoegd?", and
// remembers the answer for that room (an own Spotify setup is one more choice). Right after
// the login spotify.js makes one API call (GET /me); an account that is not on that link's
// user list gets 403 there, and this panel says so kindly, with the other links to try. One
// login asks for everything the guest's part needs (top songs and reading playlists). A
// phone that logged in through a link tells the room its index (session.reportLink), so the
// spelleider sees per link how many people used it.
import * as spotify from '../spotify.js';
import * as top from '../spotify-top.js';
import { appleMatch } from '../apple-match.js';
import { store } from '../ui.js';
import { createListShare, forgetMixLists } from './mix-lists.js';
import {
  pickTopSelection, contributionTrack, TOP_POOL, DEFAULT_RANGE, DEFAULT_SHARE_COUNT, SHARE_COUNTS, validRange, MIX_PER_MESSAGE,
} from './mix.js';
import { MIX_LISTS_FEATURE } from './server-protocol.js';
import { cleanLinks, linkLabel, notRegistered } from '../spotify-links.js';

/** { code, member, range, count, tracks (sent), todo (still to look up), skipped, at } */
export const SHARE_KEY = 'timetunesr.mixShare.v1';
/** Set right before the Spotify login: { code, range, count, at } (sessionStorage). */
export const INTENT_KEY = 'timetunesr.mixIntent';
const PREF_KEY = 'timetunesr.mixChoice.v1';
/** The link this phone chose for a room: { code, id (Client ID), verified, at } (one room at a time). */
export const LINK_KEY = 'timetunesr.mixLink.v1';
const OWN = 'own';
/** What one login asks for in a room: the top songs and reading the own playlists. */
const ROOM_SCOPES = `${spotify.TOP_SCOPES} ${spotify.PLAYLIST_SCOPES}`;
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
  const l = store.get(LINK_KEY, null);
  if (!code || l?.code === code) store.remove(LINK_KEY);
  forgetMixLists(code);
}

/**
 * The links of a room (meta): the spelleider's list, or (a server or spelleider app of before)
 * its single Client ID. [{ id, name }].
 */
export function roomLinks(meta) {
  const list = cleanLinks(meta?.spotifyLinks);
  if (list.length) return list;
  const c = meta?.spotifyClientId;
  return spotify.looksLikeClientId(c) ? [{ id: String(c).toLowerCase(), name: '' }] : [];
}

/**
 * What a guest can log in through: every link of the room ("Link 1 · familie"), and this
 * phone's own Spotify setup when it is not one of them. [{ key, id, index, label }].
 */
export function linkChoices(links, ownId = '') {
  const out = cleanLinks(links).map((l, i) => ({ key: l.id, id: l.id, index: i, label: linkLabel(i, l.name) }));
  const own = String(ownId || '').toLowerCase();
  if (spotify.looksLikeClientId(own) && !out.some((c) => c.id === own)) out.push({ key: OWN, id: own, index: -1, label: 'Mijn eigen Spotify' });
  return out;
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
 * listProvider: the lists for "Kies een playlist" (mix-lists.js), or null (not offered).
 */
export function createMixShare({ code, memberId, session, returnHash, onChange, inLobby = () => true, listProvider = null, leader = false }) {
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
  // the link step: null | 'choose' ("Via welke link…") | 'refused' ("Je staat niet op Link 1")
  const ln = { step: null, want: 'top', refused: null };
  let lastReport = 0;
  const emit = () => { if (alive) { try { onChange?.(); } catch (e) { console.error(e); } } };
  // The Spotify app to log in with. One link in the room (or none): this phone's own Client ID
  // when it has one, else the spelleider's that the room passes on, so only the spelleider sets
  // it up. Two or more: the one the guest chose ("link 1 of link 2").
  const links = () => roomLinks(session.meta);
  const roomClientId = () => links()[0]?.id || '';
  const choices = () => linkChoices(links(), spotify.getClientId());
  /** Does this phone have to choose a link (the room offers two or more)? The spelleider never does. */
  const asks = () => !leader && links().length >= 2;
  const picked = () => {
    const p = store.get(LINK_KEY, null);
    return p && p.code === code ? p : null;
  };
  /** The chosen link (a choice that still exists), or the one this phone is logged in with already. */
  const chosen = () => {
    const list = choices();
    const p = picked();
    const hit = p && list.find((c) => c.id === p.id);
    if (hit) return hit;
    const cur = spotify.connectedClientId()?.toLowerCase();
    return cur && spotify.hasScopes(ROOM_SCOPES) ? list.find((c) => c.id === cur) || null : null;
  };
  const clientId = () => (asks() ? chosen()?.id || '' : spotify.getClientId() || roomClientId());
  const scopesFor = (want) => (want === 'lists' ? spotify.PLAYLIST_SCOPES : spotify.TOP_SCOPES);
  /** Logged in with the right app and the scopes for `want` ('top' | 'lists')? */
  const ready = (want) => {
    if (!spotify.isConnected() || !spotify.hasScopes(scopesFor(want))) return false;
    if (!asks()) return true; // as before: whatever this phone is logged in with
    return spotify.connectedClientId()?.toLowerCase() === chosen()?.id;
  };
  /** The login went through (one API call answered): remember it, and tell the room which link. */
  function verified(cid) {
    const id = String(cid || '').toLowerCase();
    if (!id) return;
    store.set(LINK_KEY, { code, id, verified: true, at: Date.now() });
    report(true);
  }
  let reportedFor = ''; // the room's list the last report was made against (an index is only valid for one list)
  let reportAgain = 0;
  function report(force = false) {
    const p = picked();
    if (!p?.verified || !session.online || typeof session.reportLink !== 'function') return;
    const list = links();
    const i = list.findIndex((l) => l.id === p.id);
    if (i < 0 || session.meta?.myLink === i) return;
    // the leader reordered the links since the last report (it may have reached the room with the
    // old order and counted the wrong link): report at once
    const key = JSON.stringify(list.map((l) => l.id));
    if (!force && key === reportedFor && Date.now() - lastReport < RESEND_MS) {
      clearTimeout(reportAgain); // no further state may come: look again when the gap is over
      reportAgain = setTimeout(() => { if (alive) report(); }, RESEND_MS);
      return;
    }
    lastReport = Date.now();
    reportedFor = key;
    session.reportLink(i);
  }

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
      if (asks() && notRegistered(e, { anyForbidden: true })) { refuse('top', spotify.connectedClientId()); return; }
      st.phase = 'error';
      st.error = top.errorMessage(e);
      emit();
      return;
    }
    if (!alive) return;
    verified(spotify.connectedClientId());
    st.tracks = [];
    st.skipped = 0;
    resyncAt = null;
    lookUp(pickTopSelection(list, st.count));
  }

  /** The guest wants to take part ('top' | 'lists'): the link question first when the room has several. */
  function begin(want) {
    ln.want = want;
    if (asks() && !chosen()) { ln.step = 'choose'; ln.refused = null; emit(); return; }
    go(want);
  }

  /** Logged in with the right link already (or a login of it kept from before): go on; else log in with it. */
  function go(want) {
    const cid = clientId();
    if (want === 'top' && st.tracks.length) { // sharing again: the old part goes first
      session.mixClear();
      st.tracks = [];
      st.skipped = 0;
      store.remove(SHARE_KEY);
    }
    if (asks() && cid) spotify.useClientToken(cid);
    if (ready(want)) {
      if (spotify.connectedClientId()) verified(spotify.connectedClientId());
      proceed(want);
      return;
    }
    login(want, cid);
  }

  function proceed(want) {
    if (want === 'lists') { st.phase = 'idle'; st.error = ''; lists.open(); emit(); return; }
    run();
  }

  function login(want, cid) {
    if (!cid) { st.phase = want === 'lists' ? 'idle' : 'error'; st.error = top.MESSAGES['no-client']; emit(); return; }
    writeIntent({ code, want, range: st.range, count: st.count, ...(asks() ? { cid } : {}), at: Date.now() });
    st.phase = 'connecting';
    st.error = '';
    emit();
    // one login for everything the guest's part needs: the top songs and the own playlists
    spotify.connect(returnHash, { top: true, playlists: true, clientId: asks() ? cid : roomClientId(), exact: asks(), quiet: asks() }).catch((err) => {
      writeIntent(null);
      st.phase = want === 'lists' ? 'idle' : 'error';
      st.error = top.errorMessage(err);
      emit();
    });
  }

  /** The account is not on this link's user list: the friendly step with the other links. */
  function refuse(want, cid) {
    ln.step = 'refused';
    ln.want = want;
    ln.refused = String(cid || '').toLowerCase() || null;
    // forget the refused choice: after a reload the guest is asked again (never sent to that login again)
    const p = picked();
    if (p && p.id === ln.refused) store.remove(LINK_KEY);
    // and its login (it would count as "the link this phone uses" otherwise): the other links' logins stay
    if (ln.refused) spotify.dropClientToken(ln.refused);
    st.phase = 'idle';
    st.error = '';
    emit();
  }

  const lists = createListShare({
    code, session, provider: listProvider, onChange: () => emit(), inLobby,
    // with the 30-second fragments every song needs an Apple Music fragment (meta.play of the room;
    // unknown, from an older server: look it up, then the song works both ways)
    needFragment: () => session.meta?.play !== 'spotify',
    // the own playlists answered 403 for this account (it is not on the link it chose): the same
    // friendly "not on this link" step as the top songs
    onError: (e) => {
      if (!asks() || !notRegistered(e, { anyForbidden: true })) return false;
      refuse('lists', spotify.connectedClientId());
      return true;
    },
  });
  const api = {
    get state() { return st; },
    /** "Kies een playlist" (mix-lists.js). */
    lists,
    /** Is "Kies een playlist" offered: a provider here and a server that takes such songs ('mix-lists')? */
    listsOffered() { return (lists.available() && !!session.supports?.(MIX_LISTS_FEATURE)) || lists.active(); },
    /** Which way this phone takes part: 'lists' | 'top' | null (not yet). */
    mode() {
      if (lists.active()) return 'lists';
      if (st.tracks.length || ['connecting', 'fetching', 'matching', 'done'].includes(st.phase)) return 'top';
      return null;
    },
    /** 'own' | 'room' | 'links' | null: whose Spotify app this phone logs in with ('links': the guest chooses one of the room's). */
    clientSource() { return asks() ? 'links' : spotify.getClientId() ? 'own' : roomClientId() ? 'room' : null; },
    /** Can this phone log in at Spotify at all? null, or the reason why not. */
    problem() {
      if (top.canRead() && !asks()) return null;
      if (!asks() && !clientId()) return 'no-client';
      if (asks() && !choices().length) return 'no-client';
      return spotify.isConnected() ? null : spotify.environmentProblem();
    },
    /**
     * The link step for the panel: { step: null | 'choose' | 'refused', want, choices, chosen,
     * refused (the choice that said no), others (the choices to try instead) }.
     */
    linkState() {
      const list = choices();
      const refused = ln.refused ? list.find((c) => c.id === ln.refused) || { key: ln.refused, id: ln.refused, index: -1, label: 'deze link' } : null;
      return { step: ln.step, want: ln.want, choices: list, chosen: chosen(), asks: asks(), refused, others: refused ? list.filter((c) => c.id !== refused.id) : list };
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
      if (!top.canRead() && !clientId() && !asks()) { st.phase = 'error'; st.error = top.MESSAGES['no-client']; emit(); return; }
      begin('top');
    },
    /** "Kies uit mijn playlists": log in first when needed (the same link question), then the picker. */
    openLists() {
      if (['connecting', 'fetching', 'matching'].includes(st.phase) || !api.listsOffered()) return;
      begin('lists');
    },
    /** The guest tapped a link ("Link 2 · vrienden", or "Mijn eigen Spotify"): log in with it. */
    chooseLink(key) {
      const c = choices().find((x) => x.key === key || x.id === key);
      if (!c) return;
      store.set(LINK_KEY, { code, id: c.id, verified: false, at: Date.now() });
      ln.step = null;
      ln.refused = null;
      go(ln.want);
    },
    /** "Probeer opnieuw" after "Je staat niet op …": the same link once more (the spelleider may have added you meanwhile). */
    retryLink() {
      const id = ln.refused;
      ln.step = null;
      ln.refused = null;
      if (id) store.set(LINK_KEY, { code, id, verified: false, at: Date.now() });
      go(ln.want);
    },
    /** Close the link question without choosing. */
    cancelLink() { ln.step = null; ln.refused = null; emit(); },
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
      report();
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
      clearTimeout(reportAgain);
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
      const want = intent.want === 'lists' ? 'lists' : 'top';
      ln.want = want;
      const sp = spotify.getStatus();
      if (sp.busy === 'connecting') { st.phase = 'connecting'; return; }
      writeIntent(null);
      const cid = typeof intent.cid === 'string' ? intent.cid.toLowerCase() : '';
      const ok = cid
        ? spotify.connectedClientId()?.toLowerCase() === cid && spotify.hasScopes(scopesFor(want)) && !(sp.error && sp.failedClientId?.toLowerCase() === cid)
        : want === 'lists' ? ready('lists') : top.canRead();
      if (ok) {
        if (cid) store.set(LINK_KEY, { code, id: cid, verified: false, at: Date.now() });
        verified(spotify.connectedClientId());
        if (want === 'lists') { st.phase = 'idle'; lists.open(); return; }
        run();
        return;
      }
      st.phase = want === 'lists' ? 'idle' : 'error';
      // (cid: the guest chose a link, so the room had several; its state may not be here yet)
      if (cid && notRegistered({ code: sp.error })) { refuse(want, cid); return; }
      if (sp.error) st.error = top.errorMessage({ code: sp.error });
      else if (st.phase === 'error') st.phase = 'idle';
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
