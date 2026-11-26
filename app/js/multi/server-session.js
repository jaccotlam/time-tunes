// "Samen spelen" via the room server (server/): every phone, the spelleider's too, only
// opens one ordinary outgoing WebSocket to the server. The server owns the room, checks
// the answers and sends every phone only its own view (server-protocol.js).
//
// Two sessions with the same shape as the PeerJS ones (host-session.js, client-session.js),
// so the screens room-host.js / room-player.js work with either:
//   createServerHostSession()           the spelleider (or a player who took the lead)
//   createServerClientSession({code, name})  a player
// and one that exists only with the server:
//   createServerScreenSession({code})   a display ("groot scherm") that only watches
// All keep a step-by-step diagnosis (server reached, room found/made, in the room) so a
// phone never just says "verbinden…" forever.
import { MULTI_SERVER_URL } from '../../config.js';
import { store } from '../ui.js';
import {
  SERVER_PROTOCOL_VERSION, serverBases, parseServerMessage, cardsForServer, PING_TEXT, PONG_TEXT, CLIENT_PING_MS, STALE_MS,
} from './server-protocol.js';
import { playerId, JOIN_KEY, PLAYER_ID_KEY } from './client-session.js';
import { HOST_ID_KEY, MULTI_SEED_KEY } from './host-session.js';
import { getClientId } from '../spotify.js';

const spotifyClientId = () => { try { return getClientId() || ''; } catch { return ''; } };

/** Per-browser override of MULTI_SERVER_URL: an address, or "off" for the PeerJS route. */
export const SERVER_OVERRIDE_KEY = 'timetunesr.multiServer.v1';
/** The room this phone leads via the server: { code, id, token }. */
export const SERVER_HOST_KEY = 'timetunesr.multiServerHost.v1';
/** Tokens the server gave this phone, per room: { CODE: { id, token } }. */
export const TOKENS_KEY = 'timetunesr.multiTokens.v1';
/** The owner's copy of the room (to refill a restarted server): { code, snap }. */
export const BACKUP_KEY = 'timetunesr.multiServerBackup.v1';

export const WAKE_HINT_MS = 2500; // health takes longer than this: the host is probably asleep
export const WAKE_EXPECT_MS = 60000; // a sleeping free host needs about a minute
const HEALTH_TIMEOUT_MS = 90000;
const INFO_TIMEOUT_MS = 12000;
const JOIN_TIMEOUT_MS = 12000;
const BACKOFF_MS = [1000, 2000, 3000, 5000, 8000];

export function serverUrl() {
  let o = null;
  try { o = localStorage.getItem(SERVER_OVERRIDE_KEY); } catch { o = null; }
  if (o != null) {
    let v = o;
    try { v = JSON.parse(o); } catch { /* plain text */ }
    v = String(v ?? '').trim();
    if (/^(off|none|peerjs|uit)$/i.test(v)) return '';
    if (v) return v;
  }
  return String(MULTI_SERVER_URL || '').trim();
}
export const usesServer = () => !!serverBases(serverUrl());
export const serverBase = () => serverBases(serverUrl());

const tokens = () => store.get(TOKENS_KEY, {}) || {};
export function tokenFor(code, id) {
  const t = tokens()[code];
  return t && t.id === id && typeof t.token === 'string' ? t.token : null;
}
function saveToken(code, id, token) {
  const all = tokens();
  all[code] = { id, token, at: Date.now() };
  // keep the 20 most recent rooms
  const keep = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 20);
  store.set(TOKENS_KEY, Object.fromEntries(keep));
}

/** The seat this phone has in a room via the server: { code, name, id, at }. */
export const SEAT_KEY = 'timetunesr.multiSeat.v1';
/** A seat not seen for this long is forgotten (a room expires after 6 idle hours). */
export const SEAT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The room this phone can go back to ("Terug naar kamer ABCD"): { code, name, at } or null.
 * Only a seat of this phone's player id with a token from the server counts. Synchronous and
 * local: checkSeat() asks the server whether the room is still there.
 */
export function storedSeat() {
  const s = store.get(SEAT_KEY, null);
  if (!s || typeof s.code !== 'string' || typeof s.name !== 'string' || typeof s.id !== 'string') return null;
  if (s.id !== store.get(PLAYER_ID_KEY, null) || !tokenFor(s.code, s.id)) return null;
  if (!(Date.now() - (Number(s.at) || 0) < SEAT_MAX_AGE_MS)) { store.remove(SEAT_KEY); return null; }
  return { code: s.code, name: s.name, at: s.at };
}

/**
 * Forget the seat (of room `code`, or any). The token stays: joining that room again later
 * with this phone still lands on the same seat, if the room still has it.
 */
export function forgetSeat(code = null) {
  const s = store.get(SEAT_KEY, null);
  if (s && (code == null || s.code === code)) store.remove(SEAT_KEY);
}

/** Like storedSeat(), but asks the server: a room it does not know (404) forgets the seat. Async. */
export async function checkSeat() {
  const seat = storedSeat();
  const base = serverBase();
  if (!seat || !base) return seat;
  const r = await request(`${base.http}/rooms/${seat.code}`);
  if (r.status === 404) { forgetSeat(seat.code); return null; }
  return seat; // there, or the server is not reachable now: keep it
}

function saveSeat(code, id, name) {
  store.set(SEAT_KEY, { code, name, id, at: Date.now() });
}

export function storedServerHost() {
  const h = store.get(SERVER_HOST_KEY, null);
  return h && typeof h.code === 'string' && typeof h.id === 'string' && typeof h.token === 'string' ? h : null;
}

/** Wake a sleeping server early (start screen, join form): fire and forget. */
let lastWake = 0;
export function wakeServer() {
  const base = serverBase();
  if (!base || Date.now() - lastWake < 60000) return;
  lastWake = Date.now();
  fetch(`${base.http}/health`, { cache: 'no-store', mode: 'cors' }).catch(() => {});
}

// ---------- HTTP ----------
async function request(url, { method = 'GET', body, timeout = INFO_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      cache: 'no-store',
      mode: 'cors',
      signal: ctl.signal,
      // text/plain: a "simple" request, no extra preflight round trip
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'text/plain;charset=UTF-8' } } : {}),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const code = ctl.signal.aborted ? 'timeout' : (navigator.onLine === false ? 'offline' : 'network');
    return { ok: false, status: 0, data: null, code, message: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- diagnosis ----------
const STEP_KEYS = ['server', 'room', 'join'];

export function newDiag(role, base) {
  return {
    role,
    server: base?.http || '',
    started: Date.now(),
    attempts: 0,
    waking: null, // { since } while a slow health check runs
    steps: Object.fromEntries(STEP_KEYS.map((k) => [k, { state: 'idle' }])),
    log: [],
  };
}

function appVersion() {
  return (async () => {
    try {
      const keys = await caches.keys();
      const k = keys.find((x) => /^timetunesr-shell-/.test(x));
      if (k) return k.replace('timetunesr-shell-', '');
    } catch { /* no cache api */ }
    try {
      const t = await (await fetch('sw.js', { cache: 'no-store' })).text();
      const m = t.match(/VERSION\s*=\s*'([^']+)'/);
      if (m) return m[1];
    } catch { /* offline */ }
    return '?';
  })();
}

/** Plain-text diagnosis to paste in a message: no names or other personal data. */
export async function diagText(diag, { status, code } = {}) {
  const lines = [];
  const step = (k, label) => {
    const s = diag.steps[k];
    const state = { ok: 'ok', fail: 'FOUT', busy: 'bezig', idle: '-' }[s.state] || s.state;
    lines.push(`${label}: ${state}${s.ms != null ? ` (${s.ms} ms)` : ''}${s.code ? ` [${s.code}]` : ''}`);
  };
  lines.push('TimeTunesr diagnose (samen spelen)');
  lines.push(`App: ${await appVersion()} · protocol ${SERVER_PROTOCOL_VERSION}`);
  lines.push(`Browser: ${navigator.userAgent}`);
  lines.push(`Online volgens browser: ${navigator.onLine ? 'ja' : 'nee'}`);
  lines.push(`Server: ${diag.server || '(geen)'}`);
  lines.push(`Rol: ${{ host: 'spelleider', screen: 'groot scherm' }[diag.role] || 'speler'}${code ? ` · kamer ${code}` : ''}`);
  lines.push(`Status: ${status || '?'} · pogingen: ${diag.attempts} · sinds start: ${Math.round((Date.now() - diag.started) / 1000)} s`);
  step('server', '1. Server bereikt');
  step('room', diag.role === 'host' ? '2. Kamer gemaakt/gevonden' : '2. Kamer gevonden');
  step('join', '3. In de kamer');
  if (diag.log.length) {
    lines.push('Laatste gebeurtenissen:');
    for (const e of diag.log.slice(-8)) lines.push(`  +${Math.round((e.at - diag.started) / 100) / 10}s ${e.what}`);
  }
  lines.push(`Tijd: ${new Date().toISOString()}`);
  return lines.join('\n');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

// ---------- the connection ----------
/**
 * Keeps one room connection alive: health -> room -> WebSocket + hello, again with back-off
 * after any failure. hooks:
 *   hello()                  -> the hello message (id, token, name)
 *   roomCheck(diag)          -> async: true when the room is there (host: create/restore here)
 *   healthCheck(data)        -> (optional) a fatal error {code, message} when this server can not serve us
 *   onMessage(m), onStatus(), onWelcome(m), onFatal(error)
 */
function createLink({ role, code: initialCode, hooks }) {
  const base = serverBase();
  const diag = newDiag(role, base);
  let code = initialCode;
  let ws = null;
  let status = 'connecting';
  let attempt = 0;
  let timer = 0;
  let pingTimer = 0;
  let watchdog = 0;
  let lastMsg = 0;
  let welcomed = false;
  let destroyed = false;
  let everOnline = false;
  let running = false;

  const log = (what) => { diag.log.push({ at: Date.now(), what }); if (diag.log.length > 40) diag.log.shift(); };
  const setStatus = (s) => { if (status !== s) { status = s; log(`status ${s}`); } hooks.onStatus?.(); };
  const setStep = (k, state, extra = {}) => {
    const s = diag.steps[k];
    // a retry keeps showing the last outcome (no flicker between "mislukt" and "bezig")
    if (state === 'busy') diag.steps[k] = s.state === 'fail' || (s.state === 'ok' && k !== 'join') ? { ...s, t0: Date.now(), retrying: true } : { state, t0: Date.now() };
    else diag.steps[k] = { state, ms: s.t0 ? Date.now() - s.t0 : s.ms, code: extra.code || null };
    if (state === 'fail') log(`${k} fout ${extra.code || ''}`);
    hooks.onStatus?.();
  };

  function schedule(ms) {
    clearTimeout(timer);
    if (destroyed) return;
    timer = setTimeout(run, ms ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
  }

  function closeWs() {
    clearInterval(pingTimer);
    if (ws) {
      const w = ws;
      ws = null;
      w.onopen = w.onmessage = w.onclose = w.onerror = null;
      try { w.close(); } catch { /* ignore */ }
    }
    welcomed = false;
  }

  async function run() {
    if (destroyed || running) return;
    running = true;
    clearTimeout(timer);
    closeWs();
    diag.attempts++;
    attempt++;
    setStatus(everOnline ? 'reconnecting' : 'connecting');
    try {
      // 1. the server answers (a sleeping free host can take a minute: "server wordt wakker")
      setStep('server', 'busy');
      const wakeTimer = setTimeout(() => { diag.waking = { since: diag.steps.server.t0 }; setStatus('waking'); }, WAKE_HINT_MS);
      const h = await request(`${base.http}/health`, { timeout: HEALTH_TIMEOUT_MS });
      clearTimeout(wakeTimer);
      diag.waking = null;
      if (destroyed) return;
      if (!h.ok || !h.data?.ok) {
        setStep('server', 'fail', { code: h.code || (h.status ? `http-${h.status}` : 'network') });
        setStatus(everOnline ? 'reconnecting' : 'unreachable');
        schedule();
        return;
      }
      if (Number(h.data.v) !== SERVER_PROTOCOL_VERSION) {
        setStep('server', 'fail', { code: 'version' });
        hooks.onFatal?.({ code: 'version', message: Number(h.data.v) > SERVER_PROTOCOL_VERSION ? 'De server is nieuwer dan deze app. Ververs de pagina (of sluit de app en open hem opnieuw).' : 'De server is ouder dan deze app. Probeer het over een paar minuten opnieuw.' });
        return;
      }
      const unfit = hooks.healthCheck?.(h.data);
      if (unfit) { setStep('server', 'fail', { code: unfit.code }); hooks.onFatal?.(unfit); return; }
      setStep('server', 'ok');
      // 2. the room exists (host: made or put back here)
      setStep('room', 'busy');
      const room = await hooks.roomCheck(diag);
      if (destroyed) return;
      if (!room.ok) {
        setStep('room', 'fail', { code: room.code });
        if (room.fatal) { hooks.onFatal?.(room.fatal); return; }
        setStatus(room.code === 'notfound' ? 'notfound' : everOnline ? 'reconnecting' : 'connecting');
        schedule(room.code === 'notfound' ? 4000 : undefined);
        return;
      }
      if (room.code) code = room.code;
      setStep('room', 'ok');
      // 3. into the room over the WebSocket
      setStep('join', 'busy');
      openSocket();
    } finally {
      running = false;
    }
  }

  function openSocket() {
    let w;
    try { w = new WebSocket(`${base.ws}/rooms/${code}/ws`); } catch (e) {
      setStep('join', 'fail', { code: 'ws-error' });
      schedule();
      return;
    }
    ws = w;
    const joinTimer = setTimeout(() => {
      if (ws === w && !welcomed) { setStep('join', 'fail', { code: 'ws-timeout' }); closeWs(); setStatus(everOnline ? 'reconnecting' : 'connecting'); schedule(); }
    }, JOIN_TIMEOUT_MS);
    w.onopen = () => {
      if (ws !== w) return;
      lastMsg = Date.now();
      log('ws open');
      w.send(JSON.stringify(hooks.hello(code)));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws === w && w.readyState === 1) { try { w.send(PING_TEXT); } catch { /* ignore */ } } }, CLIENT_PING_MS);
    };
    w.onmessage = (ev) => {
      if (ws !== w) return;
      lastMsg = Date.now();
      if (ev.data === PONG_TEXT) return;
      const m = parseServerMessage(ev.data);
      if (!m) return;
      if (m.t === 'welcome') {
        clearTimeout(joinTimer);
        welcomed = true;
        everOnline = true;
        attempt = 0;
        setStep('join', 'ok');
        setStatus('online');
        hooks.onWelcome?.(m);
        return;
      }
      if (m.t === 'error' && !welcomed) {
        clearTimeout(joinTimer);
        setStep('join', 'fail', { code: m.code });
      }
      hooks.onMessage(m);
    };
    w.onclose = (ev) => {
      if (ws !== w) return;
      clearTimeout(joinTimer);
      log(`ws dicht ${ev.code}`);
      if (!welcomed && diag.steps.join.state === 'busy') setStep('join', 'fail', { code: `ws-${ev.code || 'closed'}` });
      ws = null;
      welcomed = false;
      clearInterval(pingTimer);
      if (destroyed) return;
      hooks.onClose?.();
      setStatus(everOnline ? 'reconnecting' : 'connecting');
      schedule(everOnline && attempt <= 1 ? 300 : undefined);
    };
    w.onerror = () => { /* onclose follows */ };
  }

  watchdog = setInterval(() => {
    if (status === 'online' && ws && Date.now() - lastMsg > STALE_MS) { log('stil: opnieuw verbinden'); closeWs(); hooks.onClose?.(); attempt = 0; run(); }
  }, 2000);

  const api = {
    diag,
    get code() { return code; },
    get status() { return status; },
    get online() { return status === 'online' && welcomed; },
    start() { run(); },
    send(msg) {
      if (!ws || ws.readyState !== 1 || !welcomed) return false;
      try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); return true; } catch { return false; }
    },
    /** Reconnect now (page visible again, network back, "probeer opnieuw"). */
    retry({ force = false } = {}) {
      if (destroyed) return;
      if (!force && status === 'online' && Date.now() - lastMsg < 6000) return;
      attempt = 0;
      closeWs();
      run();
    },
    stop(final = 'closed') {
      destroyed = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      closeWs();
      status = final;
    },
  };
  return api;
}

function lifecycle(retry) {
  const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
  const onOnline = () => retry();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}

const FATAL = ['version', 'removed', 'closed', 'full', 'room', 'bad', 'replaced', 'token', 'expired', 'busy', 'ratelimit'];

// ---------- player ----------
export function createServerClientSession({ code, name }) {
  const id = playerId();
  store.set(JOIN_KEY, { code, name });
  let view = null;
  let meta = null;
  let error = null;
  let notice = null;
  let pendingAnswer = null;
  let lastSent = null; // { round, answer }: resent when a restarted server lost it
  let lastStep = ''; // phase + round of the last state (the seat's "last seen")
  let clock = 0; // server time - this phone's time (Quiz countdown)
  const listeners = new Set();
  const received = [];
  const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } } };

  const link = createLink({
    role: 'player',
    code,
    hooks: {
      hello: () => ({ t: 'hello', v: SERVER_PROTOCOL_VERSION, code, id, name, ...(tokenFor(code, id) ? { token: tokenFor(code, id) } : {}) }),
      roomCheck: async () => {
        const r = await request(`${serverBase().http}/rooms/${code}`);
        if (r.ok && r.data?.exists) return { ok: true };
        if (r.status === 404) return { ok: false, code: 'notfound' };
        return { ok: false, code: r.code || (r.status ? `http-${r.status}` : 'network') };
      },
      onWelcome: (m) => { if (m.token) saveToken(code, id, m.token); saveSeat(code, id, name); emit(); },
      onStatus: () => emit(),
      onClose: () => emit(),
      onFatal: (e) => fatal(e),
      onMessage: (m) => {
        if (received.length < 2000) received.push(m);
        if (m.t === 'error') {
          if (m.code === 'notfound') { link.retry({ force: true }); return; }
          if (FATAL.includes(m.code)) { fatal({ code: m.code, message: m.message }); return; }
          pendingAnswer = null;
          notice = { message: m.message || 'Dat lukte niet.' };
          emit();
          return;
        }
        if (m.t === 'state' && m.view) {
          const step = `${m.view.phase}:${m.view.game?.round ?? ''}`;
          if (step !== lastStep && link.online) { lastStep = step; saveSeat(code, id, name); } // still seen
          view = m.view;
          meta = m.meta || null;
          if (Number.isFinite(meta?.now)) clock = meta.now - Date.now();
          const g = view.game;
          const quiz = g?.kind === 'quiz'; // one answer, sent once: never repeated
          if (pendingAnswer && (!g || view.phase !== 'answering' || g.round !== pendingAnswer.round || g.answer || g.quiz?.choice != null)) pendingAnswer = null;
          else if (pendingAnswer && !quiz) link.send({ t: 'answer', round: pendingAnswer.round, answer: pendingAnswer.answer });
          // a restarted server may have lost this round's answer: give it again
          if (!quiz && !pendingAnswer && lastSent && g && view.phase === 'answering' && g.round === lastSent.round && !g.answer && g.mine) {
            link.send({ t: 'answer', round: lastSent.round, answer: lastSent.answer });
            lastSent = null;
          }
          emit();
        }
      },
    },
  });

  function fatal(e) {
    error = e;
    if (['removed', 'closed', 'room', 'expired'].includes(e.code)) store.remove(JOIN_KEY);
    if (['removed', 'closed', 'room', 'expired', 'token'].includes(e.code)) forgetSeat(code); // the server says: no seat (any more)
    link.stop('closed');
    emit();
  }

  const offLifecycle = lifecycle(() => { if (!error) link.retry(); });
  let ticker = 0;

  const api = {
    isServer: true,
    code,
    name,
    playerId: id,
    get view() { return view; },
    get meta() { return meta; },
    get status() { return error ? 'closed' : link.status; },
    get error() { return error; },
    get pending() { return pendingAnswer; },
    /** The server's clock now (ms), corrected for this phone's clock. */
    serverNow: () => Date.now() + clock,
    get received() { return received; },
    get diag() { return link.diag; },
    get wasInRoom() { return !!tokenFor(code, id); },
    takeNotice() { const n = notice; notice = null; return n; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      link.start();
      // the leader-away countdown on screen needs a tick now and then
      ticker = setInterval(() => { if (meta && !meta.leaderOnline) emit(); }, 1000);
    },
    answer(answer) {
      if (!view?.game) return;
      pendingAnswer = { round: view.game.round, answer };
      lastSent = { ...pendingAnswer };
      link.send({ t: 'answer', round: view.game.round, answer });
      emit();
    },
    /** Discobingo, after the reveal: stamp (or move the stamp to) square `index`; null takes it back. */
    stamp(index) { if (view?.game) link.send({ t: 'stamp', round: view.game.round, index }); },
    /** The leader is away long enough: this phone takes the lead (and plays the music). */
    takeOver() { link.send({ t: 'lead' }); },
    /** "Mix van de groep": add songs to / withdraw this phone's part. False when offline. */
    mixAdd(tracks) { return link.send({ t: 'mix-add', tracks }); },
    mixClear() { return link.send({ t: 'mix-clear' }); },
    get online() { return link.online; },
    /**
     * Does Verlaat keep this phone's seat? True during a game (also on the winner screen):
     * the server keeps card, stamps and score, and the phone may come back (storedSeat()).
     * False in the lobby (and before the first state): leaving takes the player off the list.
     */
    get keepsSeat() { return !!view?.game && view.phase !== 'lobby'; },
    /** Verlaat. Returns { seat }: whether this phone can come back to its seat (see keepsSeat). */
    leave() {
      const seat = api.keepsSeat;
      link.send({ t: 'leave' });
      if (seat) saveSeat(code, id, name);
      else { store.remove(JOIN_KEY); forgetSeat(code); }
      setTimeout(() => api.destroy(), 200);
      return { seat };
    },
    retry() { link.retry({ force: true }); },
    copyDiag: async () => copyText(await diagText(link.diag, { status: api.status, code })),
    diagText: () => diagText(link.diag, { status: api.status, code }),
    /** Hand this phone's place over to the host screen (after taking the lead). */
    leadIdentity: () => ({ code, id, token: tokenFor(code, id) }),
    destroy() {
      clearInterval(ticker);
      offLifecycle();
      link.stop('closed');
      listeners.clear();
    },
  };
  return api;
}

// ---------- spelleider ----------
export function createServerHostSession() {
  let ident = storedServerHost(); // { code, id, token }
  let link = null;
  let st = null; // last state message { view, meta, lead }
  let notice = null;
  let error = null;
  let creating = null; // { hostPlays, hostName } while a new room is being made
  let clock = 0; // server time - this phone's time (Quiz countdown)
  let lostLead = false;
  let closing = false;
  let offLifecycle = null;
  const received = []; // every message from the server (tests check that nothing leaks)
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } } };

  const ownerId = () => {
    let id = store.get(HOST_ID_KEY, null);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(id)) { id = `h${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`; store.set(HOST_ID_KEY, id); }
    return id;
  };

  function forget() {
    store.remove(SERVER_HOST_KEY);
    const b = store.get(BACKUP_KEY, null);
    if (b && ident && b.code === ident.code) store.remove(BACKUP_KEY);
  }

  function connect() {
    link?.stop();
    error = null;
    lostLead = false;
    closing = false;
    link = createLink({
      role: 'host',
      code: ident?.code || null,
      hooks: {
        // cid: this phone's Spotify Client ID (a public value, '' = none); the server passes the
        // owner's on to the players, so only the spelleider has to set Spotify up
        hello: (code) => ({ t: 'hello', v: SERVER_PROTOCOL_VERSION, code, id: ident.id, token: ident.token, cid: spotifyClientId() }),
        roomCheck: async () => {
          const base = serverBase().http;
          if (!ident) {
            // a new room
            const id = ownerId();
            const r = await request(`${base}/rooms`, { method: 'POST', body: { v: SERVER_PROTOCOL_VERSION, id, name: creating?.hostName || '', hostPlays: !!creating?.hostPlays, settings: store.get('timetunesr.multiSettings.v1', {}) || {} } });
            if (r.status === 201 && r.data?.code) {
              ident = { code: r.data.code, id, token: r.data.token };
              store.set(SERVER_HOST_KEY, ident);
              return { ok: true, code: ident.code };
            }
            if (r.status === 409) return { ok: false, code: 'version', fatal: { code: 'version', message: r.data?.message || 'Ververs de pagina.' } };
            return { ok: false, code: r.data?.error || r.code || `http-${r.status}` };
          }
          const r = await request(`${base}/rooms/${ident.code}`);
          if (r.ok && r.data?.exists) return { ok: true, code: ident.code };
          if (r.status === 404) {
            // gone from the server (restart): put it back from this phone's copy
            const b = store.get(BACKUP_KEY, null);
            if (b?.code === ident.code && b.snap) {
              const rr = await request(`${base}/rooms/${ident.code}/restore`, { method: 'POST', timeout: 30000, body: { v: SERVER_PROTOCOL_VERSION, id: ident.id, token: ident.token, snap: b.snap } });
              if (rr.ok) { link.diag.log.push({ at: Date.now(), what: 'kamer teruggezet' }); return { ok: true, code: ident.code }; }
              return { ok: false, code: `restore-${rr.data?.error || rr.status}`, fatal: rr.status === 400 ? { code: 'room', message: 'De kamer is weg en kon niet worden teruggezet. Maak een nieuwe kamer.' } : null };
            }
            return { ok: false, code: 'notfound', fatal: { code: 'room', message: 'Deze kamer bestaat niet meer op de server (verlopen of de server is opnieuw gestart). Maak een nieuwe kamer.' } };
          }
          return { ok: false, code: r.code || `http-${r.status}` };
        },
        onWelcome: () => { creating = null; emit(); },
        onStatus: () => emit(),
        onClose: () => emit(),
        onFatal: (e) => fatal(e),
        onMessage: (m) => {
          if (closing) return;
          if (received.length < 3000) received.push(m);
          if (m.t === 'backup' && m.snap && ident && m.snap.code === ident.code) { store.set(BACKUP_KEY, { code: ident.code, snap: m.snap }); return; }
          if (m.t === 'error') {
            if (m.code === 'notfound') { link.retry({ force: true }); return; }
            if (FATAL.includes(m.code)) { fatal({ code: m.code, message: m.message }); return; }
            notice = { message: m.message || 'Dat lukte niet.' };
            emit();
            return;
          }
          if (m.t === 'state') {
            st = m;
            if (Number.isFinite(m.meta?.now)) clock = m.meta.now - Date.now();
            if (!m.lead) lostLead = true; // a player who led and handed it back
            emit();
          }
        },
      },
    });
    link.start();
    offLifecycle?.();
    offLifecycle = lifecycle(() => { if (!error) link?.retry(); });
    emit();
  }

  function fatal(e) {
    error = e;
    st = null;
    creating = null;
    if (['closed', 'room', 'expired', 'removed', 'token'].includes(e.code)) { forget(); ident = null; }
    link?.stop('closed');
    emit();
  }

  const send = (msg) => {
    if (!link?.send(msg)) throw new Error('Even geen verbinding met de server. Probeer het zo opnieuw.');
  };

  const api = {
    isServer: true,
    /** Room summary for the screen (no future songs). Null before the first state. */
    get room() { return st?.lead?.room || null; },
    get status() { return error ? 'closed' : link ? link.status : 'idle'; },
    get error() { return error; },
    get meta() { return st?.meta || null; },
    get diag() { return link?.diag || null; },
    get code() { return ident?.code || link?.code || null; },
    /** Busy making or reconnecting to a room (show the steps, not the setup form). */
    get connecting() { return !!link && !st?.lead && !error && (!!ident || !!creating); },
    get lostLead() { return lostLead; },
    get hostPlayerId() { return st?.view?.you?.id || null; },
    presence() { return {}; },
    hostView() { return st?.view?.you ? st.view : null; },
    spectatorView() { return st?.lead?.spectator || null; },
    currentSong() { return st?.lead?.song || null; },
    takeNotice() { const n = notice; notice = null; return n; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    resume() {
      if (!ident) return false;
      connect();
      return true;
    },
    create({ hostPlays = false, hostName = '' } = {}) {
      ident = null;
      store.remove(SERVER_HOST_KEY);
      creating = { hostPlays, hostName };
      st = null;
      connect();
    },
    setSettings(patch) {
      const s = { ...(api.room?.settings || {}), ...patch };
      store.set('timetunesr.multiSettings.v1', s);
      send({ t: 'settings', patch });
    },
    /** Start a game: with `mix` the server takes the songs from the "Mix van de groep" (play: the music source here). */
    start(cards, { mix = false, play = 'preview' } = {}) {
      const fixed = store.get(MULTI_SEED_KEY, null);
      // with the mix the own music still goes along: a quiz takes its wrong answers from it
      send({ t: 'start', cards: cardsForServer(cards), mix, play, ...(Number.isInteger(fixed) ? { seed: fixed >>> 0 } : {}) });
    },
    mixAdd(tracks) { return !!link?.send({ t: 'mix-add', tracks }); },
    mixClear() { return !!link?.send({ t: 'mix-clear' }); },
    get online() { return !!link?.online; },
    get received() { return received; },
    /** This phone's member id in the room (for its own part of the mix). */
    get memberId() { return ident?.id || null; },
    answer(answer) {
      const g = st?.view?.game;
      if (!g) return;
      send({ t: 'answer', round: g.round, answer });
    },
    /** Discobingo: the spelleider playing along stamps a square of their own card. */
    stamp(index) { const g = st?.view?.game; if (g) send({ t: 'stamp', round: g.round, index }); },
    /** Discobingo: Goed (ok true) or Fout on a player's answer (a doubt, or a flip). */
    judge(pid, ok) { send({ t: 'judge', pid, ok: !!ok }); },
    reveal() { send({ t: 'reveal' }); },
    /** Quiz: the song plays on this phone, the thinking time may start. */
    quizPlaying(round) { return !!link?.send({ t: 'playing', round }); },
    serverNow: () => Date.now() + clock,
    override(pid) { send({ t: 'override', pid }); },
    next() { send({ t: 'next' }); },
    toLobby() { send({ t: 'lobby' }); },
    remove(pid) { send({ t: 'remove', pid }); },
    /** The owner takes the lead back. */
    reclaim() { send({ t: 'lead' }); },
    close() {
      closing = true;
      link?.send({ t: 'close' });
      forget();
      ident = null;
      st = null;
      const l = link;
      link = null;
      setTimeout(() => l?.stop('closed'), 300);
      emit();
    },
    /** Stop leading here without closing (a player hands the screen back). */
    forget() { forget(); ident = null; },
    retry() { if (error && ident) connect(); else link?.retry({ force: true }); },
    copyDiag: async () => (link ? copyText(await diagText(link.diag, { status: api.status, code: api.code })) : false),
    diagText: () => (link ? diagText(link.diag, { status: api.status, code: api.code }) : Promise.resolve('')),
    destroy() {
      offLifecycle?.();
      link?.stop();
      link = null;
      listeners.clear();
    },
  };
  return api;
}

// ---------- groot scherm ----------
/**
 * A display ("groot scherm", #/scherm/CODE): watches room `code` and sends nothing but hello,
 * leave and ping. Not a player and never the leader: no id, no token, no name, and it reads
 * or writes none of the spelleider's or a player's keys in localStorage (a display often runs
 * in a second tab of the spelleider's browser). Same reconnect / back-off / ping / diagnosis as
 * a player; a room that is not (or no longer) there is waited for (status 'notfound'), so a
 * display comes back by itself once the spelleider has put a restarted server's room back.
 */
export function createServerScreenSession({ code }) {
  let view = null;
  let meta = null;
  let error = null;
  let notice = null;
  let clock = 0; // server time - this device's time (spin of the ball, Quiz countdown)
  const listeners = new Set();
  const received = [];
  const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } } };

  const base = serverBase();
  let link = null;
  const makeLink = () => createLink({
    role: 'screen',
    code,
    hooks: {
      hello: () => ({ t: 'hello', v: SERVER_PROTOCOL_VERSION, code, screen: true }),
      healthCheck: (data) => (Array.isArray(data?.features) && data.features.includes('screen') ? null : NO_SCREEN),
      roomCheck: async () => {
        const r = await request(`${base.http}/rooms/${code}`);
        if (r.ok && r.data?.exists) return { ok: true };
        if (r.status === 404) return { ok: false, code: 'notfound' };
        return { ok: false, code: r.code || (r.status ? `http-${r.status}` : 'network') };
      },
      onWelcome: () => emit(),
      onStatus: () => emit(),
      onClose: () => emit(),
      onFatal: (e) => fatal(e),
      onMessage: (m) => {
        if (received.length < 3000) received.push(m);
        if (m.t === 'error') {
          if (m.code === 'notfound') { link.retry({ force: true }); return; }
          // a server of before the display answers its hello (no id) with 'bad'
          if (m.code === 'bad' && !link.online) { fatal(NO_SCREEN); return; }
          if (FATAL.includes(m.code) || m.code === 'screens') { fatal({ code: m.code, message: m.message }); return; }
          notice = { message: m.message || 'Dat lukte niet.' };
          emit();
          return;
        }
        if (m.t === 'state' && m.view) {
          view = m.view;
          meta = m.meta || null;
          if (Number.isFinite(meta?.now)) clock = meta.now - Date.now();
          emit();
        }
      },
    },
  });
  function connect() {
    link?.stop();
    error = null;
    link = makeLink();
    link.start();
    emit();
  }

  function fatal(e) {
    error = e;
    link?.stop('closed');
    emit();
  }

  let offLifecycle = () => {};
  let ticker = 0;

  const api = {
    isServer: true,
    isScreen: true,
    code,
    /** The public view of the room (protocol.js viewFor for a spectator). Null before the first state. */
    get view() { return view; },
    /** meta: leader, leaderOnline, leaderAwayMs, now, mix counts, screens; `screen: true`, `you: null`. */
    get meta() { return meta; },
    get status() { return error ? 'closed' : link ? link.status : 'idle'; },
    get error() { return error; },
    get online() { return !!link?.online; },
    /** The server's clock now (ms), corrected for this device's clock. */
    serverNow: () => Date.now() + clock,
    get received() { return received; },
    get diag() { return link?.diag || null; },
    takeNotice() { const n = notice; notice = null; return n; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      if (!base) { error = { code: 'noserver', message: 'Het grote scherm werkt alleen met de server voor samen spelen.' }; emit(); return; }
      connect();
      offLifecycle = lifecycle(() => { if (!error) link?.retry(); });
      // the leader-away time on screen needs a tick now and then
      ticker = setInterval(() => { if (meta && !meta.leaderOnline) emit(); }, 1000);
    },
    /** Try again now ("Probeer opnieuw"): after a fatal error with a fresh connection. */
    retry() {
      if (!base) return;
      if (error || !link) { connect(); return; }
      link.retry({ force: true });
    },
    copyDiag: async () => (link ? copyText(await diagText(link.diag, { status: api.status, code })) : false),
    diagText: () => (link ? diagText(link.diag, { status: api.status, code }) : Promise.resolve('')),
    /** Stop watching (the server counts one display less right away). */
    leave() {
      link?.send({ t: 'leave' });
      setTimeout(() => api.destroy(), 200);
    },
    destroy() {
      clearInterval(ticker);
      offLifecycle();
      link?.stop('closed');
      listeners.clear();
    },
  };
  return api;
}

const NO_SCREEN = { code: 'noscreen', message: 'Deze server kent het grote scherm nog niet. Werk de server bij, of volg het spel op een telefoon.' };
