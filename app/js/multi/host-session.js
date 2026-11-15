// "Samen spelen": the host's session. Owns the room (multi/game.js), keeps it in
// localStorage so a reload restores the same room code and stand, talks to the players
// through the transport and sends every player only their own view (protocol.js).
import * as G from './game.js';
import { viewFor, parseMessage, versionError, PROTOCOL_VERSION } from './protocol.js';
import { makeFreshCode, isValidCode } from './code.js';
import { createHostTransport } from './transport.js';
import { store } from '../ui.js';

export const HOST_KEY = 'timetunesr.multiHost.v1';
export const HOST_ID_KEY = 'timetunesr.multiHostId.v1';
/** Optional fixed seed for a predictable game (tests, video): same as bingoSeed for the pass-the-phone game. */
export const MULTI_SEED_KEY = 'timetunesr.multiSeed.v1';
export const PING_MS = 4000;
export const STALE_MS = 13000;

const randomId = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

export function storedRoom() {
  const r = store.get(HOST_KEY, null);
  return G.isValidRoom(r) && isValidCode(r.code) ? r : null;
}

export function createHostSession() {
  let room = storedRoom();
  let transport = null;
  let status = 'idle';
  let fresh = false; // created in this page and never online: a taken code means "pick another"
  const tried = [];
  const conns = new Map(); // connId -> { pid, lastSeen }
  const listeners = new Set();
  let pingTimer = 0;
  let takenTimer = 0;
  let pending = false;
  let destroyed = false;

  const hostId = () => {
    let id = store.get(HOST_ID_KEY, null);
    if (typeof id !== 'string') { id = randomId('h'); store.set(HOST_ID_KEY, id); }
    return id;
  };

  function presence() {
    const out = {};
    for (const c of conns.values()) if (c.pid) out[c.pid] = true;
    for (const p of room?.players || []) if (p.host) out[p.id] = true;
    return out;
  }

  function emit() {
    for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } }
  }

  /** Save, notify the screen and (batched) send every connected player their view. */
  function changed() {
    if (room) store.set(HOST_KEY, room);
    emit();
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; broadcast(); });
  }

  function broadcast() {
    if (!transport || !room) return;
    const pres = presence();
    for (const [connId, c] of conns) {
      if (c.pid) transport.send(connId, { t: 'state', view: viewFor(room, c.pid, pres) });
    }
  }

  function connFor(pid) {
    for (const [id, c] of conns) if (c.pid === pid) return id;
    return null;
  }

  function onMessage(connId, raw) {
    const c = conns.get(connId);
    if (!c) return;
    c.lastSeen = Date.now();
    const m = parseMessage(raw, { from: 'player' });
    if (!m) return;
    if (m.t === 'pong') return;
    if (m.t === 'hello') {
      if (Number(m.v) !== PROTOCOL_VERSION) {
        transport.send(connId, versionError(m.v));
        setTimeout(() => transport?.drop(connId), 300);
        return;
      }
      if (m.room && m.room !== room.code) {
        transport.send(connId, { t: 'error', code: 'room', message: 'Deze kamer bestaat niet meer.' });
        setTimeout(() => transport?.drop(connId), 300);
        return;
      }
      const pid = typeof m.playerId === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(m.playerId) ? m.playerId : null;
      if (!pid || G.findPlayer(room, pid)?.host) { transport.send(connId, { t: 'error', code: 'bad', message: 'Onbekende speler.' }); return; }
      try {
        room = G.addPlayer(room, { id: pid, name: m.name });
      } catch (e) {
        transport.send(connId, { t: 'error', code: e.code || 'bad', message: e.message });
        setTimeout(() => transport?.drop(connId), 300);
        return;
      }
      const old = connFor(pid);
      if (old && old !== connId) {
        // same player id on a new connection: a reconnect, or the same game open in a second tab
        transport.send(old, { t: 'error', code: 'replaced', message: 'Je speelt in een ander venster of op een ander toestel verder.' });
        conns.get(old).pid = null;
        setTimeout(() => { transport?.drop(old); conns.delete(old); }, 200);
      }
      c.pid = pid;
      transport.send(connId, { t: 'welcome', v: PROTOCOL_VERSION, playerId: pid, code: room.code });
      changed();
      return;
    }
    if (!c.pid || !G.findPlayer(room, c.pid)) return;
    if (m.t === 'answer') {
      if (room.game && m.round !== room.game.round) return; // an answer for an earlier song
      try { room = G.submitAnswer(room, c.pid, m.answer); } catch (e) {
        transport.send(connId, { t: 'error', code: e.code || 'answer', message: e.message });
        return;
      }
      changed();
    } else if (m.t === 'withdraw') {
      room = G.withdrawAnswer(room, c.pid);
      changed();
    } else if (m.t === 'leave') {
      // leaving by choice: gone from the room, but may join again later
      room = G.removePlayer(room, c.pid);
      room = { ...room, removed: room.removed.filter((id) => id !== c.pid) };
      c.pid = null;
      transport.drop(connId);
      conns.delete(connId);
      changed();
    }
  }

  function heartbeat() {
    const now = Date.now();
    for (const [connId, c] of [...conns]) {
      if (now - c.lastSeen > STALE_MS) {
        conns.delete(connId);
        transport?.drop(connId);
        if (c.pid) changed();
        continue;
      }
      transport?.send(connId, { t: 'ping' });
    }
  }

  function openTransport() {
    if (destroyed || !room) return;
    if (transport) transport.destroy();
    conns.clear();
    const code = room.code;
    transport = createHostTransport({
      code,
      on: {
        status: (s) => {
          if (transport && code !== room?.code) return;
          status = s;
          if (s === 'online') fresh = false;
          if (s === 'taken') onTaken();
          emit();
        },
        open: (connId) => { conns.set(connId, { pid: null, lastSeen: Date.now() }); },
        message: onMessage,
        close: (connId) => {
          const c = conns.get(connId);
          conns.delete(connId);
          if (c?.pid) changed();
        },
      },
    });
    transport.start();
  }

  function onTaken() {
    clearTimeout(takenTimer);
    if (fresh && (room.players.filter((p) => !p.host).length === 0)) {
      // a brand-new room whose code exists already: choose another code
      tried.push(room.code);
      room = { ...room, code: makeFreshCode(tried) };
      store.set(HOST_KEY, room);
      emit();
      openTransport();
      return;
    }
    // our own room after a reload: the broker still remembers the old page for a moment
    takenTimer = setTimeout(() => { if (!destroyed) transport?.retry(); }, 3000);
  }

  const onVisible = () => { if (document.visibilityState === 'visible') transport?.retry(); };
  const onOnline = () => transport?.retry();

  const api = {
    get room() { return room; },
    get status() { return status; },
    get hostPlayerId() { return room?.players.find((p) => p.host)?.id || null; },
    presence,
    /** View for the host's own player panel (or null when the host does not play). */
    hostView() {
      const id = api.hostPlayerId;
      return id ? viewFor(room, id, presence()) : null;
    },
    /** What every player sees about the room (no own card): the host screen's lists. */
    spectatorView() { return room ? viewFor(room, '__host__', presence()) : null; },
    /** The running song, for the hidden player on this device. */
    currentSong() { return room?.game?.current ? room.game.songs[room.game.current] || null : null; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Resume the stored room (after a reload). */
    resume() {
      if (!room) return false;
      openTransport();
      return true;
    },
    create({ hostPlays = false, hostName = '' } = {}) {
      fresh = true;
      room = G.createRoom({
        code: makeFreshCode(tried),
        host: hostPlays ? { id: hostId(), name: hostName || 'Spelleider' } : null,
        settings: store.get('timetunesr.multiSettings.v1', {}) || {},
      });
      changed();
      openTransport();
    },
    setSettings(patch) {
      room = G.setSettings(room, patch);
      store.set('timetunesr.multiSettings.v1', room.settings);
      changed();
    },
    start(cards) {
      const fixed = store.get(MULTI_SEED_KEY, null);
      const seed = Number.isInteger(fixed) ? fixed >>> 0 : (Math.random() * 2 ** 32) >>> 0;
      room = room.phase === 'won' ? G.playAgain(room, { cards, seed }) : G.startGame(room, { cards, seed });
      changed();
    },
    answer(answer) {
      room = G.submitAnswer(room, api.hostPlayerId, answer);
      changed();
    },
    reveal() { room = G.reveal(room); changed(); },
    override(pid) { room = G.overrideResult(room, pid); changed(); },
    next() { room = G.nextRound(room); changed(); },
    toLobby() { room = G.backToLobby(room); changed(); },
    remove(pid) {
      const connId = connFor(pid);
      room = G.removePlayer(room, pid);
      if (connId) {
        transport.send(connId, { t: 'error', code: 'removed', message: 'De spelleider heeft je uit de kamer gehaald.' });
        conns.get(connId).pid = null;
        setTimeout(() => transport?.drop(connId), 300);
      }
      changed();
    },
    /** Close the room for everybody and forget it. */
    close() {
      if (transport) {
        for (const [connId, c] of conns) if (c.pid) transport.send(connId, { t: 'error', code: 'closed', message: 'De spelleider heeft de kamer gesloten.' });
      }
      const t = transport;
      transport = null;
      setTimeout(() => t?.destroy(), 300);
      room = null;
      store.remove(HOST_KEY);
      status = 'closed';
      emit();
    },
    retry() { transport?.retry(); },
    /** Leave the screen: stop networking but keep the room for later. */
    destroy() {
      destroyed = true;
      clearInterval(pingTimer);
      clearTimeout(takenTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      transport?.destroy();
      transport = null;
      listeners.clear();
    },
  };

  pingTimer = setInterval(heartbeat, PING_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  return api;
}
