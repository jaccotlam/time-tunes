// "Samen spelen": a player's session. A fixed player id in localStorage means a reload
// (or a phone that wakes up) comes back into the same game with the same card/timeline.
// Reconnects by itself: back-off in the transport, a heartbeat watchdog here, and an
// immediate retry when the page becomes visible or the network comes back.
import { parseMessage, helloMessage, PROTOCOL_VERSION } from './protocol.js';
import { createClientTransport } from './transport.js';
import { store } from '../ui.js';

export const PLAYER_ID_KEY = 'timetunesr.multiPlayerId.v1';
export const JOIN_KEY = 'timetunesr.multiJoin.v1';
/** No message from the host for this long while "online": the connection is dead, reconnect. */
export const SILENCE_MS = 12000;
const FATAL = ['version', 'removed', 'closed', 'full', 'room', 'bad', 'replaced'];

export function playerId() {
  let id = store.get(PLAYER_ID_KEY, null);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
    id = `p${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    store.set(PLAYER_ID_KEY, id);
  }
  return id;
}

/** The room this phone joined last ({code, name}) or null. */
export const storedJoin = () => {
  const j = store.get(JOIN_KEY, null);
  return j && typeof j.code === 'string' && typeof j.name === 'string' ? j : null;
};
export const forgetJoin = () => store.remove(JOIN_KEY);

export function createClientSession({ code, name }) {
  const id = playerId();
  store.set(JOIN_KEY, { code, name });
  let view = null;
  let status = 'connecting';
  let error = null; // { code, message } after a fatal error (version, removed, closed, ...)
  let notice = null; // { message } non-fatal (answer refused)
  let lastMsg = 0;
  let pendingAnswer = null; // { round, answer } not yet confirmed by the host
  let welcomed = false;
  const listeners = new Set();
  const received = []; // every message from the host (tests check what a player got)

  const emit = () => { for (const fn of listeners) { try { fn(api); } catch (e) { console.error(e); } } };

  const transport = createClientTransport({
    code,
    on: {
      status: (s) => { status = s; if (s !== 'online') welcomed = false; emit(); },
      open: () => {
        lastMsg = Date.now();
        transport.send(helloMessage({ playerId: id, name, room: code }));
      },
      message: (raw) => {
        lastMsg = Date.now();
        const m = parseMessage(raw, { from: 'host' });
        if (!m) return;
        if (received.length < 2000) received.push(m);
        if (m.t === 'ping') { transport.send({ t: 'pong' }); return; }
        if (m.t === 'welcome') {
          welcomed = true;
          if (Number(m.v) !== PROTOCOL_VERSION) fatal({ code: 'version', message: 'De spelleider gebruikt een andere versie van de app. Ververs allebei de pagina.' });
          return;
        }
        if (m.t === 'error') {
          if (FATAL.includes(m.code)) { fatal({ code: m.code, message: m.message }); return; }
          pendingAnswer = null;
          notice = { message: m.message || 'Dat lukte niet.' };
          emit();
          return;
        }
        if (m.t === 'state' && m.view) {
          if (Number(m.view.v) !== PROTOCOL_VERSION) { fatal({ code: 'version', message: 'De spelleider gebruikt een andere versie van de app. Ververs allebei de pagina.' }); return; }
          view = m.view;
          const g = view.game;
          if (pendingAnswer && (!g || view.phase !== 'answering' || g.round !== pendingAnswer.round || g.answer)) {
            // confirmed, or the round is over
            pendingAnswer = null;
          } else if (pendingAnswer && welcomed) {
            transport.send({ t: 'answer', round: pendingAnswer.round, answer: pendingAnswer.answer });
          }
          emit();
        }
      },
      close: () => emit(),
    },
  });

  function fatal(e) {
    error = e;
    if (['removed', 'closed', 'room'].includes(e.code)) store.remove(JOIN_KEY);
    transport.destroy();
    status = 'closed';
    emit();
  }

  const watchdog = setInterval(() => {
    if (status === 'online' && Date.now() - lastMsg > SILENCE_MS) transport.retry({ force: true });
  }, 2000);
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || error) return;
    if (status !== 'online' || Date.now() - lastMsg > 6000) transport.retry({ force: status === 'online' });
  };
  const onOnline = () => { if (!error) transport.retry(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);

  const api = {
    code,
    name,
    playerId: id,
    get view() { return view; },
    get status() { return status; },
    get error() { return error; },
    get pending() { return pendingAnswer; },
    get received() { return received; },
    takeNotice() { const n = notice; notice = null; return n; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() { transport.start(); },
    answer(answer) {
      if (!view?.game) return;
      pendingAnswer = { round: view.game.round, answer };
      transport.send({ t: 'answer', round: view.game.round, answer });
      emit();
    },
    /** Leave the room for good (by choice). */
    leave() {
      transport.send({ t: 'leave' });
      store.remove(JOIN_KEY);
      setTimeout(() => api.destroy(), 200);
    },
    retry() { transport.retry({ force: true }); },
    destroy() {
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      transport.destroy();
      listeners.clear();
    },
  };
  return api;
}
