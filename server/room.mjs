// One "Samen spelen" room on the server, independent of the transport (Node `ws` or a
// Cloudflare Durable Object). The game rules come from app/js/multi/game.js and the views
// from app/js/multi/protocol.js: the same code the phones use, never a copy.
//
// The hub talks to its adapter through a few functions:
//   send(connId, text)            send a text frame to one connection
//   drop(connId, code, reason)    close one connection
//   attach(connId, rec)           (optional) the connection's record changed (CF: serializeAttachment)
//   save(snapshot | null)         (optional) persist the room (CF: Durable Object storage); null = deleted
//   now()                         clock (tests use a fake one)
//   lastSeen(connId)              (optional) extra "last heard" time (CF: auto-answered pings)
//   wake(at | null)               (optional) call tick() at that time (Node: a timer; CF uses nextTick() for its alarm)
// The Quiz runs on the server's clock: the thinking time starts at "playing" from the music phone
// (or QUIZ_START_FALLBACK_MS after the question, as a safety net) and the question closes when
// everybody online has answered, when the time is up (tick) or when the leader reveals.
import * as G from '../app/js/multi/game.js';
import { viewFor } from '../app/js/multi/protocol.js';
import {
  SERVER_PROTOCOL_VERSION, TAKEOVER_MS, STALE_MS, PING_TEXT, PONG_TEXT, LEADER_TYPES, ID_RE, TOKEN_RE, SPOTIFY_CLIENT_ID_RE,
  parseClientMessage, cleanCards,
} from '../app/js/multi/server-protocol.js';
import { startQuizClock, quizRoundOver, quizNextEvent } from '../app/js/multi/game.js';
import { QUIZ_START_FALLBACK_MS } from '../app/js/multi/quiz.js';
import {
  addToContribution, contributionTotal, mixStats, mixMinimum, buildMix, MixError, MIX_PER_PLAYER,
} from '../app/js/multi/mix.js';
import { sha256Hex } from './sha256.mjs';

export const ROOM_IDLE_MS = 6 * 60 * 60 * 1000; // a room with no activity for 6 hours expires
export const UNCLAIMED_MS = 30 * 60 * 1000; // a created room nobody ever connected to
export const MAX_CONNS_PER_ROOM = 40;
export const RATE_WINDOW_MS = 10000;
export const RATE_MAX_MESSAGES = 80; // per connection per window (pings excluded)
export const RATE_MAX_PINGS = 30;
const SPECTATOR = '!spectator';

/**
 * Stored state of a room (Durable Object storage / memory). Rooms stored before the
 * "Mix van de groep" (protocol 1) have no `mix`: they get an empty one. Rooms stored before
 * Discobingo (protocol 3) have no `settings.win`: their settings are normalised (the missing
 * value gets its default, every other value stays). Nothing else changes.
 */
export function migrateState(state) {
  if (!state || typeof state !== 'object') return null;
  if (!state.mix || typeof state.mix !== 'object' || Array.isArray(state.mix)) state.mix = {};
  if (state.room && typeof state.room === 'object') state.room = withSettings(state.room);
  return state;
}

const withSettings = (room) => ({ ...room, settings: G.normalizeSettings(room.settings || {}) });

export function randomToken(bytes = 24) {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const hashToken = (t) => sha256Hex(`timetunesr:${t}`);

function versionText(theirs) {
  return Number(theirs) < SERVER_PROTOCOL_VERSION
    ? 'Jouw app is ouder dan die van de server. Ververs de pagina (of sluit de app en open hem opnieuw) en doe dan weer mee.'
    : 'De server heeft een oudere versie dan jouw app. Probeer het over een paar minuten opnieuw.';
}

/** Check a backup copy of a room (from the owner's phone) before it is restored. */
export function validSnapshot(snap, code) {
  if (!snap || typeof snap !== 'object' || snap.v !== 1 || snap.code !== code) return false;
  if (!G.isValidRoom(snap.room) || snap.room.code !== code) return false;
  if (typeof snap.ownerId !== 'string' || !ID_RE.test(snap.ownerId)) return false;
  if (!snap.members || typeof snap.members !== 'object') return false;
  const ids = Object.keys(snap.members);
  if (ids.length > G.MAX_ROOM_PLAYERS + 1 || !snap.members[snap.ownerId]) return false;
  if (!ids.every((id) => ID_RE.test(id) && /^[0-9a-f]{64}$/.test(snap.members[id]?.th || ''))) return false;
  return snap.room.players.every((p) => snap.members[p.id]);
}

/**
 * After a server restart in the middle of a quiz question: the question starts again with
 * the full thinking time once the music phone reports the music; everybody answers again
 * (the clock of the old answers is gone, so their speed can not be judged fairly).
 */
export function restartQuizQuestion(room, now) {
  const g = room?.game;
  if (g?.kind !== 'quiz' || room.phase !== 'answering') return room;
  return { ...room, game: { ...g, answers: {}, quiz: { ...g.quiz, openedAt: now, startedAt: null, deadline: null } } };
}

export class RoomHub {
  constructor(code, deps = {}) {
    this.code = code;
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.state = null;
    this.conns = new Map(); // connId -> { mid, lastSeen, win, count, pings }
    this.dirty = false;
    this.backupKey = '';
    this.mixVersion = 0;
    this.mixCache = null;
  }

  // ---------- lifecycle ----------
  exists() { return !!this.state; }

  /** A fresh room for its owner. Returns { code, token } (the owner's secret). */
  create({ ownerId, name = '', hostPlays = false, settings = {} }) {
    if (this.state) throw Object.assign(new Error('taken'), { code: 'taken' });
    if (!ID_RE.test(String(ownerId || ''))) throw Object.assign(new Error('bad id'), { code: 'bad' });
    const token = randomToken();
    const ownerName = G.cleanName(name, 'Spelleider');
    const t = this.now();
    this.state = {
      v: 1,
      code: this.code,
      createdAt: t,
      lastActive: t,
      claimed: false,
      ownerId,
      ownerName,
      leaderId: ownerId,
      leaderAwaySince: t,
      members: { [ownerId]: { th: hashToken(token) } },
      room: G.createRoom({ code: this.code, host: hostPlays ? { id: ownerId, name: ownerName } : null, settings }),
      mix: {}, // "Mix van de groep": { memberId: { at, tracks } }, never sent to any phone
    };
    this.persist();
    return { code: this.code, token };
  }

  /** Bring a room back from the owner's backup after a server restart. */
  restore(snap, { id, token }) {
    const ok = (s) => s.ownerId === id && typeof token === 'string' && s.members[id]?.th === hashToken(token);
    if (this.state) {
      if (ok(this.state)) return { code: this.code, restored: false };
      throw Object.assign(new Error('taken'), { code: 'taken' });
    }
    if (!validSnapshot(snap, this.code) || !ok(snap)) throw Object.assign(new Error('bad snapshot'), { code: 'bad' });
    const t = this.now();
    const members = Object.fromEntries(Object.entries(snap.members).map(([k, m]) => [k, { th: m.th }]));
    this.state = {
      v: 1,
      code: this.code,
      createdAt: Number(snap.createdAt) || t,
      lastActive: t,
      claimed: true,
      ownerId: snap.ownerId,
      ownerName: G.cleanName(snap.ownerName, 'Spelleider'),
      leaderId: members[snap.leaderId] ? snap.leaderId : snap.ownerId,
      leaderAwaySince: t,
      members,
      room: restartQuizQuestion(withSettings(snap.room), t),
      restoredAt: t,
      mix: {}, // contributions are not in the backup: the phones send them again
    };
    this.persist();
    return { code: this.code, restored: true };
  }

  /** Public facts for GET /rooms/CODE. */
  info() {
    const s = this.state;
    if (!s) return { exists: false };
    return { exists: true, phase: s.room.phase, players: s.room.players.length, leaderOnline: this.online(s.leaderId) };
  }

  snapshot() { return this.state; }

  /** Load the persisted state (CF: after the object was evicted) and the open connections. */
  load(state, conns = []) {
    this.state = migrateState(state);
    for (const c of conns) this.conns.set(c.connId, { mid: c.mid || null, lastSeen: c.lastSeen || this.now(), win: this.now(), count: 0, pings: 0 });
  }

  persist() { this.deps.save?.(this.state ? this.state : null); }

  // ---------- connections ----------
  open(connId) {
    if (this.conns.size >= MAX_CONNS_PER_ROOM) {
      this.sendTo(connId, { t: 'error', code: 'busy', message: 'Er zijn te veel verbindingen met deze kamer.' });
      this.deps.drop?.(connId, 1013, 'busy');
      return false;
    }
    const t = this.now();
    this.conns.set(connId, { mid: null, lastSeen: t, win: t, count: 0, pings: 0 });
    this.attach(connId);
    return true;
  }

  attach(connId) {
    const c = this.conns.get(connId);
    if (c) this.deps.attach?.(connId, { mid: c.mid, lastSeen: c.lastSeen });
  }

  close(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    if (c.mid && this.state) {
      if (c.mid === this.state.leaderId && !this.online(c.mid)) {
        this.state.leaderAwaySince = this.now();
        this.persist();
      }
      this.quizCheck(); // the question does not wait for somebody who dropped out
      this.changed();
    }
  }

  /** Quiz: close the question when everybody online has answered or the time is up. */
  quizCheck() {
    const s = this.state;
    if (!s || s.room.game?.kind !== 'quiz') return false;
    if (!quizRoundOver(s.room, this.now(), this.presence())) return false;
    s.room = G.reveal(s.room, { now: this.now() });
    return true;
  }

  online(mid) {
    for (const c of this.conns.values()) if (c.mid === mid) return true;
    return false;
  }

  presence() {
    const out = {};
    for (const c of this.conns.values()) if (c.mid) out[c.mid] = true;
    return out;
  }

  sendTo(connId, msg) { this.deps.send?.(connId, typeof msg === 'string' ? msg : JSON.stringify(msg)); }

  fatal(connId, code, message) {
    this.sendTo(connId, { t: 'error', code, message });
    const c = this.conns.get(connId);
    this.conns.delete(connId);
    this.deps.drop?.(connId, 4000, code);
    if (c?.mid && this.state) this.changed();
  }

  // ---------- messages ----------
  message(connId, raw) {
    const c = this.conns.get(connId);
    if (!c) return;
    const t = this.now();
    c.lastSeen = t;
    if (t - c.win > RATE_WINDOW_MS) { c.win = t; c.count = 0; c.pings = 0; }
    const text = typeof raw === 'string' ? raw : null;
    if (text === PING_TEXT) {
      if (++c.pings > RATE_MAX_PINGS) { this.fatal(connId, 'ratelimit', 'Te veel berichten. Ververs de pagina.'); return; }
      this.sendTo(connId, PONG_TEXT);
      return;
    }
    if (++c.count > RATE_MAX_MESSAGES) { this.fatal(connId, 'ratelimit', 'Te veel berichten. Ververs de pagina.'); return; }
    const m = parseClientMessage(text);
    if (!m) { this.sendTo(connId, { t: 'error', code: 'bad', message: 'Onbekend bericht.' }); return; }
    if (m.t === 'hello') { this.hello(connId, m); return; }
    if (!this.state) { this.fatal(connId, 'notfound', 'Deze kamer bestaat niet (meer).'); return; }
    if (!c.mid || !this.state.members[c.mid]) { this.sendTo(connId, { t: 'error', code: 'bad', message: 'Zeg eerst hallo.' }); return; }
    this.state.lastActive = t;
    try {
      this.action(connId, c.mid, m);
    } catch (e) {
      if (e instanceof G.GameError) this.sendTo(connId, { t: 'error', code: e.code || 'bad', message: e.message });
      else throw e;
    }
  }

  hello(connId, m) {
    const c = this.conns.get(connId);
    if (Number(m.v) !== SERVER_PROTOCOL_VERSION) { this.fatal(connId, 'version', versionText(m.v)); return; }
    const s = this.state;
    if (!s) { this.fatal(connId, 'notfound', 'Deze kamer bestaat niet (meer).'); return; }
    if (m.code && m.code !== this.code) { this.fatal(connId, 'room', 'Deze kamer bestaat niet meer.'); return; }
    const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
    if (!id) { this.fatal(connId, 'bad', 'Onbekende speler.'); return; }
    let token;
    if (s.members[id]) {
      if (typeof m.token !== 'string' || !TOKEN_RE.test(m.token) || hashToken(m.token) !== s.members[id].th) {
        this.fatal(connId, 'token', 'Deze plek in de kamer hoort bij een ander toestel. Doe mee met een andere naam of vraag de spelleider om hulp.');
        return;
      }
    } else {
      if (s.room.removed.includes(id)) { this.fatal(connId, 'removed', 'Je bent door de spelleider uit deze kamer gehaald.'); return; }
      try {
        s.room = G.addPlayer(s.room, { id, name: m.name });
      } catch (e) {
        this.fatal(connId, e.code || 'bad', e.message);
        return;
      }
      token = randomToken();
      s.members[id] = { th: hashToken(token) };
    }
    // the same phone on a new connection (reconnect, second tab): the old one goes
    for (const [other, oc] of this.conns) {
      if (other !== connId && oc.mid === id) {
        this.sendTo(other, { t: 'error', code: 'replaced', message: 'Je speelt in een ander venster of op een ander toestel verder.' });
        this.conns.delete(other);
        this.deps.drop?.(other, 4001, 'replaced');
      }
    }
    c.mid = id;
    this.attach(connId);
    // the owner's Spotify Client ID goes to the players (a public value; only the form is checked).
    // No cid field (an older app): keep what there is; '' = the owner has none (any more).
    if (id === s.ownerId && typeof m.cid === 'string') {
      if (SPOTIFY_CLIENT_ID_RE.test(m.cid)) s.spotifyClientId = m.cid.toLowerCase();
      else if (m.cid === '') delete s.spotifyClientId;
    }
    s.claimed = true;
    s.lastActive = this.now();
    if (id === s.leaderId) s.leaderAwaySince = null;
    else if (m.name && s.room.players.some((p) => p.id === id)) s.room = G.addPlayer(s.room, { id, name: m.name }); // name update
    this.sendTo(connId, { t: 'welcome', v: SERVER_PROTOCOL_VERSION, id, code: this.code, ...(token ? { token } : {}), owner: id === s.ownerId });
    this.backupKey = ''; // a (re)connected owner gets a fresh backup
    this.changed();
  }

  action(connId, mid, m) {
    const s = this.state;
    const isLeader = mid === s.leaderId;
    if (LEADER_TYPES.includes(m.t) && !isLeader) {
      this.sendTo(connId, { t: 'error', code: 'notleader', message: 'Alleen de spelleider kan dat doen.' });
      return;
    }
    const r = s.room;
    switch (m.t) {
      case 'answer':
        if (r.game && m.round !== r.game.round) return; // an answer for an earlier song
        s.room = G.submitAnswer(r, mid, m.answer, { now: this.now() });
        this.quizCheck();
        break;
      case 'playing':
        if (r.game?.kind === 'quiz' && m.round === r.game.round) s.room = startQuizClock(r, this.now());
        break;
      case 'withdraw': s.room = G.withdrawAnswer(r, mid); break;
      case 'stamp': {
        if (!r.game || m.round !== r.game.round) return; // a choice for an earlier round
        const index = m.index === null ? null : Number.isInteger(m.index) && m.index >= 0 && m.index < 25 ? m.index : undefined;
        if (index === undefined) throw new G.GameError('answer', 'Kies een vakje.');
        s.room = G.stampSquare(r, mid, index);
        break;
      }
      case 'judge': {
        if (typeof m.ok !== 'boolean' || typeof m.pid !== 'string') throw new G.GameError('bad', 'Kies Goed of Fout.');
        s.room = G.judgeResult(r, m.pid, m.ok);
        break;
      }
      case 'settings': s.room = G.setSettings(r, m.patch && typeof m.patch === 'object' ? m.patch : {}); break;
      case 'start': {
        if (r.phase !== 'lobby' && r.phase !== 'won') throw new G.GameError('busy', 'Het spel is al bezig.');
        const seed = Number.isInteger(m.seed) ? m.seed >>> 0 : (Math.random() * 2 ** 32) >>> 0;
        const mix = r.settings.music === 'mix';
        const cards = mix ? this.mixCards({ seed, play: m.play }) : cleanCards(m.cards);
        // a quiz from the mix takes its wrong artists / titles from the leader's own music, never
        // from other players' favourites (those would show up before they are played)
        const pool = mix && r.settings.game === 'quiz' ? cleanCards(m.cards) : null;
        const now = this.now();
        s.room = r.phase === 'won' ? G.playAgain(r, { cards, seed, now, pool }) : G.startGame(r, { cards, seed, now, pool });
        if (mix) s.room = { ...s.room, game: { ...s.room.game, mix: true, play: m.play === 'spotify' ? 'spotify' : 'preview' } };
        break;
      }
      case 'mix-add': {
        const cur = s.mix[mid]?.tracks || [];
        const out = addToContribution(cur, m.tracks, { roomTotal: contributionTotal(s.mix) });
        if (out.added) { s.mix[mid] = { at: this.now(), tracks: out.list }; this.mixVersion++; }
        if (out.refused) {
          this.sendTo(connId, { t: 'error', code: 'mix', message: out.list.length >= MIX_PER_PLAYER ? `Je deelt al het maximum van ${MIX_PER_PLAYER} nummers.` : 'Niet alle nummers konden worden toegevoegd (ongeldig, of de mix van deze kamer is vol).' });
        }
        if (!out.added) return;
        break;
      }
      case 'mix-clear': {
        if (!s.mix[mid]) return;
        this.dropContribution(mid);
        break;
      }
      case 'reveal': s.room = G.reveal(r, { now: this.now() }); break;
      case 'override': s.room = G.overrideResult(r, String(m.pid || '')); break;
      case 'next': s.room = G.nextRound(r, { now: this.now() }); break;
      case 'lobby': s.room = G.backToLobby(r); break;
      case 'remove': {
        const pid = String(m.pid || '');
        if (pid === s.ownerId || pid === mid) throw new G.GameError('host', 'De spelleider kan zichzelf niet verwijderen.');
        s.room = G.removePlayer(r, pid);
        delete s.members[pid];
        this.dropContribution(pid);
        for (const [other, oc] of [...this.conns]) {
          if (oc.mid === pid) {
            this.sendTo(other, { t: 'error', code: 'removed', message: 'De spelleider heeft je uit de kamer gehaald.' });
            this.conns.delete(other);
            this.deps.drop?.(other, 4000, 'removed');
          }
        }
        break;
      }
      case 'leave': {
        if (mid === s.ownerId) return; // the owner closes the room instead
        s.room = G.removePlayer(r, mid);
        s.room = { ...s.room, removed: s.room.removed.filter((x) => x !== mid) }; // may join again later
        delete s.members[mid];
        this.dropContribution(mid);
        if (s.leaderId === mid) { s.leaderId = s.ownerId; s.leaderAwaySince = this.online(s.ownerId) ? null : this.now(); }
        this.conns.delete(connId);
        this.deps.drop?.(connId, 1000, 'leave');
        break;
      }
      case 'lead': {
        if (isLeader) break;
        if (mid !== s.ownerId) {
          if (!s.room.players.some((p) => p.id === mid)) throw new G.GameError('lead', 'Alleen een speler kan de leiding overnemen.');
          if (this.online(s.leaderId)) throw new G.GameError('leaderonline', 'De spelleider is er weer.');
          const away = this.now() - (s.leaderAwaySince ?? this.now());
          if (away < TAKEOVER_MS) throw new G.GameError('wait', `Wacht nog ${Math.ceil((TAKEOVER_MS - away) / 1000)} s: misschien komt de spelleider terug.`);
        }
        s.leaderId = mid;
        s.leaderAwaySince = null;
        break;
      }
      case 'close': {
        if (mid !== s.ownerId && !isLeader) throw new G.GameError('notleader', 'Alleen de spelleider kan de kamer sluiten.');
        this.shutdown('closed', 'De spelleider heeft de kamer gesloten.');
        return;
      }
      default: return;
    }
    this.changed();
  }

  /** Songs for a game from the "Mix van de groep" (throws a GameError when there are too few). */
  mixCards({ seed, play }) {
    const s = this.state;
    const names = Object.fromEntries(Object.keys(s.mix).map((pid) => [pid, s.room.players.find((p) => p.id === pid)?.name || (pid === s.ownerId ? s.ownerName : 'Speler')]));
    try {
      return buildMix(s.mix, {
        seed,
        source: play === 'spotify' ? 'spotify' : 'preview',
        need: mixMinimum(s.room.settings, s.room.players.length),
        names,
      });
    } catch (e) {
      if (e instanceof MixError) {
        const left = e.need - e.have;
        throw new G.GameError('mix', `Te weinig nummers in de mix van de groep: nog ${left} nodig (${e.have} van ${e.need}).`);
      }
      throw e;
    }
  }

  /**
   * A member withdraws (or leaves): forget the songs, and take the ones nobody else added
   * out of a running game from the mix (songs already played stay where they are).
   */
  dropContribution(mid) {
    const s = this.state;
    if (!s.mix[mid]) return;
    delete s.mix[mid];
    this.mixVersion++;
    const g = s.room.game;
    if (!g?.mix) return;
    const songs = { ...g.songs };
    const pile = [];
    for (const id of g.pile) {
      const c = songs[id];
      if (c?.from?.includes(mid)) {
        if (c.from.length === 1) { delete songs[id]; continue; }
        const keep = c.from.map((f, i) => [f, c.by?.[i]]).filter(([f]) => f !== mid);
        songs[id] = { ...c, from: keep.map((x) => x[0]), by: keep.map((x) => x[1] || 'Speler') };
      }
      pile.push(id);
    }
    s.room = { ...s.room, game: { ...g, songs, pile } };
  }

  /** Close the room for everybody and forget it. */
  shutdown(code, message) {
    for (const connId of [...this.conns.keys()]) {
      this.sendTo(connId, { t: 'error', code, message });
      this.deps.drop?.(connId, 4000, code);
    }
    this.conns.clear();
    this.state = null;
    this.persist();
  }

  // ---------- state to the phones ----------
  changed() {
    if (!this.state) return;
    this.persist();
    this.deps.wake?.(quizNextEvent(this.state.room, QUIZ_START_FALLBACK_MS));
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => { this.dirty = false; this.broadcast(); });
  }

  meta(mid) {
    const s = this.state;
    const leader = s.room.players.find((p) => p.id === s.leaderId);
    const leaderOnline = this.online(s.leaderId);
    return {
      you: mid,
      owner: mid === s.ownerId,
      leader: mid === s.leaderId,
      leaderId: s.leaderId,
      leaderName: leader?.name || s.ownerName,
      leaderIsOwner: s.leaderId === s.ownerId,
      leaderOnline,
      leaderAwayMs: leaderOnline ? 0 : Math.max(0, this.now() - (s.leaderAwaySince ?? this.now())),
      takeoverMs: TAKEOVER_MS,
      restored: !!s.restoredAt,
      now: this.now(), // the server's clock, for the Quiz countdown
      // "Mix van de groep": counts only, never a title
      mix: { ...this.mixCounts(), mine: s.mix[mid]?.tracks?.length || 0 },
      // the spelleider's Spotify Client ID, so players can log in for "Doe mijn favorieten erbij"
      spotifyClientId: typeof s.spotifyClientId === 'string' && SPOTIFY_CLIENT_ID_RE.test(s.spotifyClientId) ? s.spotifyClientId : null,
    };
  }

  /** Counts of the mix, worked out again only when a contribution changed. */
  mixCounts() {
    if (!this.mixCache || this.mixCache.version !== this.mixVersion || this.mixCache.state !== this.state.mix) {
      this.mixCache = { version: this.mixVersion, state: this.state.mix, stats: mixStats(this.state.mix) };
    }
    return this.mixCache.stats;
  }

  /** What the leader's screen needs to run the room (no future songs, the running one only for the music phone). */
  summary(forLeader) {
    const r = this.state.room;
    const g = r.game;
    return {
      v: 1,
      code: r.code,
      phase: r.phase,
      settings: { ...r.settings },
      players: r.players.map((p) => ({ id: p.id, name: p.name, host: !!p.host })),
      removed: [],
      game: g ? {
        kind: g.kind,
        round: g.round,
        size: g.size,
        goal: g.goal,
        left: g.pile.length,
        current: forLeader ? g.current : null,
        results: g.results ? Object.fromEntries(Object.entries(g.results).map(([id, x]) => [id, {
          none: !!x.none, pass: !!x.pass, correct: !!x.correct, doubt: !!x.doubt, typed: !!x.typed, overridden: !!x.overridden,
          ...(g.kind === 'disco' ? { verdict: x.verdict ?? null, decided: !!x.decided } : {}),
        }])) : null,
        roundWinners: g.roundWinners.slice(),
        winners: (g.winners || []).slice(),
      } : null,
    };
  }

  stateFor(mid, pres) {
    const s = this.state;
    const r = s.room;
    const msg = { t: 'state', view: viewFor(r, mid, pres), meta: this.meta(mid) };
    if (mid === s.ownerId || mid === s.leaderId) {
      const isLeader = mid === s.leaderId;
      const g = r.game;
      msg.lead = {
        room: this.summary(isLeader),
        spectator: viewFor(r, SPECTATOR, pres),
        // the music phone (and only that one) gets the running song before the reveal
        song: isLeader && g && (r.phase === 'answering' || r.phase === 'revealed') && g.current ? { ...g.songs[g.current] } : null,
      };
    }
    return msg;
  }

  broadcast() {
    if (!this.state) return;
    const pres = this.presence();
    let ownerConn = null;
    for (const [connId, c] of this.conns) {
      if (!c.mid) continue;
      this.sendTo(connId, this.stateFor(c.mid, pres));
      if (c.mid === this.state.ownerId) ownerConn = connId;
    }
    if (ownerConn) this.maybeBackup(ownerConn);
  }

  /** The owner's phone keeps a copy of the room, so a restarted server can be refilled. */
  maybeBackup(connId) {
    const s = this.state;
    const g = s.room.game;
    const key = JSON.stringify([s.room.phase, g?.round, g?.seed, s.room.players.map((p) => p.id), s.room.removed.length, s.room.settings, s.leaderId, g?.results && Object.values(g.results).map((x) => x.verdict ?? x.correct), g?.disco?.choices]);
    if (key === this.backupKey) return;
    this.backupKey = key;
    // A game from the mix holds other players' favourites: those never go to the owner's
    // phone. Its backup is the room in the lobby (after a restore the phones send their
    // contributions again and the leader starts a new game).
    const room = g?.mix ? G.backToLobby(s.room) : s.room;
    const snap = { v: 1, code: s.code, createdAt: s.createdAt, ownerId: s.ownerId, ownerName: s.ownerName, leaderId: s.leaderId, members: s.members, room };
    this.sendTo(connId, { t: 'backup', snap });
  }

  // ---------- time ----------
  /** Housekeeping: drop dead connections, let an idle room expire. Returns { expired }. */
  tick() {
    const t = this.now();
    for (const [connId, c] of [...this.conns]) {
      const seen = Math.max(c.lastSeen, this.deps.lastSeen?.(connId) || 0);
      if (t - seen > STALE_MS) {
        this.conns.delete(connId);
        this.deps.drop?.(connId, 4002, 'stale');
        if (c.mid && this.state) {
          if (c.mid === this.state.leaderId && !this.online(c.mid)) { this.state.leaderAwaySince = t; this.persist(); }
          this.changed();
        }
      }
    }
    const s = this.state;
    if (!s) return { expired: false, empty: true };
    // Quiz: the safety net for the clock start, and the end of the thinking time
    const g = s.room.game;
    if (g?.kind === 'quiz' && s.room.phase === 'answering') {
      let moved = false;
      if (g.quiz.startedAt == null && t >= (g.quiz.openedAt || 0) + QUIZ_START_FALLBACK_MS) { s.room = startQuizClock(s.room, t); moved = true; }
      if (this.quizCheck()) moved = true;
      if (moved) this.changed();
    }
    const limit = s.claimed ? ROOM_IDLE_MS : UNCLAIMED_MS;
    if (t - s.lastActive > limit) {
      this.shutdown('expired', 'Deze kamer is verlopen omdat er lang niet gespeeld is. Maak een nieuwe kamer.');
      return { expired: true };
    }
    // leader away: the phones count down to "take over" themselves; a fresh state tells them the server's view
    return { expired: false };
  }

  /** When tick() must run next (CF alarm). */
  nextTick() {
    const s = this.state;
    if (!s) return null;
    const quiz = quizNextEvent(s.room, QUIZ_START_FALLBACK_MS);
    if (quiz != null) return Math.min(quiz, this.conns.size ? this.now() + 15000 : quiz);
    if (this.conns.size) return this.now() + 15000;
    return s.lastActive + (s.claimed ? ROOM_IDLE_MS : UNCLAIMED_MS) + 1000;
  }
}
