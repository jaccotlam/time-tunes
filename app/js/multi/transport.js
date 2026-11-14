// "Samen spelen": the connection layer. A small interface around PeerJS (WebRTC data
// channels, vendor/peerjs.min.js), so it can be swapped for something else later:
//
//   const host = createHostTransport({ code, on })   // on: { status, open, message, close }
//   host.start(); host.send(connId, msg); host.drop(connId); host.retry(); host.destroy();
//   const client = createClientTransport({ code, on }) // on: { status, open, message, close }
//   client.start(); client.send(msg); client.retry(); client.destroy();
//
// Status values: 'connecting' | 'online' | 'reconnecting' | 'notfound' | 'taken' | 'closed'.
// Both sides reconnect by themselves with back-off; retry() skips the wait (used on
// visibilitychange / online). Messages are JSON strings (protocol.js).
import { MULTI_SIGNAL, MULTI_ICE_SERVERS, MULTI_PEER_PREFIX } from '../../config.js';
import { peerIdForCode } from './code.js';
import { encode } from './protocol.js';

/** localStorage override of the config (tests, or trying another broker): JSON with host/port/path/secure/key/iceServers/prefix. */
export const SIGNAL_OVERRIDE_KEY = 'timetunesr.multiSignal.v1';
export const BACKOFF_MS = [800, 1500, 3000, 5000, 8000, 12000];

export function signalConfig() {
  let override = null;
  try { override = JSON.parse(localStorage.getItem(SIGNAL_OVERRIDE_KEY) || 'null'); } catch { override = null; }
  const base = { ...MULTI_SIGNAL, iceServers: MULTI_ICE_SERVERS, prefix: MULTI_PEER_PREFIX };
  return override && typeof override === 'object' ? { ...base, ...override } : base;
}

function peerOptions(cfg) {
  const o = { host: cfg.host, port: Number(cfg.port), path: cfg.path || '/', secure: !!cfg.secure, key: cfg.key || 'peerjs', debug: 0 };
  if (Array.isArray(cfg.iceServers)) o.config = { iceServers: cfg.iceServers };
  return o;
}

let libPromise = null;
/** Load vendor/peerjs.min.js once (only screens of "Samen spelen" need it). */
export function loadPeerLib() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/peerjs.min.js';
      s.async = true;
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS niet geladen')));
      s.onerror = () => { libPromise = null; s.remove(); reject(new Error('PeerJS niet geladen')); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

const delay = (attempt) => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
const NETWORK_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected', 'webrtc'];

/**
 * Host side: claims the peer id of the room and accepts connections from players.
 * on.status(status, detail), on.open(connId), on.message(connId, raw), on.close(connId)
 */
export function createHostTransport({ code, on }) {
  const cfg = signalConfig();
  const id = peerIdForCode(code, cfg.prefix);
  const conns = new Map();
  let peer = null;
  let destroyed = false;
  let attempt = 0;
  let timer = 0;
  let status = 'idle';
  let seq = 0;

  const setStatus = (s, detail) => { status = s; on.status?.(s, detail); };

  function schedule(fn) {
    clearTimeout(timer);
    timer = setTimeout(fn, delay(attempt++));
  }

  async function start() {
    if (destroyed) return;
    clearTimeout(timer);
    setStatus(status === 'online' || status === 'reconnecting' ? 'reconnecting' : 'connecting');
    let Peer;
    try { Peer = await loadPeerLib(); } catch { setStatus('reconnecting'); schedule(start); return; }
    if (destroyed) return;
    if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
    const p = new Peer(id, peerOptions(cfg));
    peer = p;
    p.on('open', () => {
      if (p !== peer) return;
      attempt = 0;
      setStatus('online');
    });
    p.on('connection', (conn) => {
      const connId = `c${++seq}`;
      conn.on('open', () => { conns.set(connId, conn); on.open?.(connId); });
      conn.on('data', (d) => on.message?.(connId, d));
      const gone = () => {
        if (!conns.has(connId)) return;
        conns.delete(connId);
        on.close?.(connId);
      };
      conn.on('close', gone);
      conn.on('error', gone);
      conn.on('iceStateChanged', (s) => { if (s === 'failed' || s === 'closed') { try { conn.close(); } catch { /* ignore */ } gone(); } });
    });
    p.on('disconnected', () => {
      // lost the broker; open data channels keep working. Reconnect for new players.
      if (p !== peer || destroyed) return;
      setStatus('reconnecting');
      schedule(() => { if (p === peer && !p.destroyed) { try { p.reconnect(); } catch { start(); } } else start(); });
    });
    p.on('error', (e) => {
      if (p !== peer || destroyed) return;
      if (e.type === 'unavailable-id') {
        // somebody (often our own previous page, not yet timed out) holds this room's id
        setStatus('taken');
        try { p.destroy(); } catch { /* ignore */ }
        peer = null;
        return;
      }
      if (e.type === 'peer-unavailable') return;
      if (NETWORK_ERRORS.includes(e.type) || p.destroyed) {
        setStatus('reconnecting', e.type);
        schedule(start);
      }
    });
  }

  return {
    get status() { return status; },
    start,
    /** Try again now (e.g. the page became visible again). */
    retry() {
      if (destroyed) return;
      if (!peer || peer.destroyed || status === 'taken') { attempt = 0; start(); return; }
      if (peer.disconnected) { attempt = 0; clearTimeout(timer); try { peer.reconnect(); } catch { start(); } }
    },
    send(connId, msg) {
      const c = conns.get(connId);
      if (!c || !c.open) return false;
      try { c.send(typeof msg === 'string' ? msg : encode(msg)); return true; } catch { return false; }
    },
    drop(connId) {
      const c = conns.get(connId);
      conns.delete(connId);
      if (c) { try { c.close(); } catch { /* ignore */ } }
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      for (const c of conns.values()) { try { c.close(); } catch { /* ignore */ } }
      conns.clear();
      if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
      peer = null;
      setStatus('closed');
    },
  };
}

/**
 * Player side: connects to the host of room `code` and keeps trying.
 * on.status(status, detail), on.open(), on.message(raw), on.close()
 */
export function createClientTransport({ code, on }) {
  const cfg = signalConfig();
  const hostId = peerIdForCode(code, cfg.prefix);
  let peer = null;
  let conn = null;
  let destroyed = false;
  let attempt = 0;
  let timer = 0;
  let status = 'idle';
  let everOnline = false;

  const setStatus = (s, detail) => { status = s; on.status?.(s, detail); };

  function schedule(fn) {
    clearTimeout(timer);
    timer = setTimeout(fn, delay(attempt++));
  }

  function lost(reason) {
    if (destroyed) return;
    if (conn) { const c = conn; conn = null; try { c.close(); } catch { /* ignore */ } on.close?.(); }
    setStatus(reason === 'notfound' ? 'notfound' : everOnline ? 'reconnecting' : 'connecting', reason);
    schedule(connect);
  }

  function connect() {
    if (destroyed) return;
    clearTimeout(timer);
    if (!peer || peer.destroyed) { startPeer(); return; }
    if (peer.disconnected) {
      try { peer.reconnect(); } catch { startPeer(); }
      return; // 'open' fires again -> connect()
    }
    if (!peer.open) return; // still opening: 'open' -> connect()
    if (conn) { try { conn.close(); } catch { /* ignore */ } conn = null; }
    const c = peer.connect(hostId, { reliable: true });
    conn = c;
    const openTimer = setTimeout(() => { if (conn === c && !c.open) lost('timeout'); }, 12000);
    c.on('open', () => {
      clearTimeout(openTimer);
      if (conn !== c) return;
      attempt = 0;
      everOnline = true;
      setStatus('online');
      on.open?.();
    });
    c.on('data', (d) => { if (conn === c) on.message?.(d); });
    const gone = () => { clearTimeout(openTimer); if (conn === c) lost('closed'); };
    c.on('close', gone);
    c.on('error', gone);
    c.on('iceStateChanged', (s) => { if (s === 'failed' || s === 'closed') gone(); });
  }

  async function startPeer() {
    let Peer;
    try { Peer = await loadPeerLib(); } catch { lost('lib'); return; }
    if (destroyed) return;
    if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
    const p = new Peer(peerOptions(cfg));
    peer = p;
    p.on('open', () => { if (p === peer) connect(); });
    p.on('disconnected', () => {
      // the broker is gone; an open data channel to the host keeps working
      if (p !== peer || destroyed) return;
      if (!conn || !conn.open) lost('broker');
    });
    p.on('error', (e) => {
      if (p !== peer || destroyed) return;
      if (e.type === 'peer-unavailable') { lost('notfound'); return; }
      if (NETWORK_ERRORS.includes(e.type) || e.type === 'server-error' || p.destroyed) {
        if (!conn || !conn.open) { if (p.destroyed) peer = null; lost(e.type); }
      }
    });
  }

  return {
    get status() { return status; },
    start() { setStatus('connecting'); connect(); },
    /** Connection looks dead (no heartbeat) or page woke up: reconnect now. */
    retry({ force = false } = {}) {
      if (destroyed) return;
      if (!force && conn && conn.open) return;
      attempt = 0;
      lost('retry');
      clearTimeout(timer);
      connect();
    },
    send(msg) {
      if (!conn || !conn.open) return false;
      try { conn.send(typeof msg === 'string' ? msg : encode(msg)); return true; } catch { return false; }
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      if (conn) { try { conn.close(); } catch { /* ignore */ } }
      conn = null;
      if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
      peer = null;
      setStatus('closed');
    },
  };
}
