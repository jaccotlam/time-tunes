// Prepared rooms ("een kamer helemaal klaarzetten"): a room made by an account, days before
// the party. It is an ordinary RoomHub room with one extra part in its state:
//   state.prepared = { account, name, music, play, hostPlays, createdAt }
// - account: the uid of the account that owns it (never sent to any phone)
// - name: the room's public name (lobby, big screen, join page: info() and meta.roomName)
// - music: 'deck' | 'mix' | a playlist id of the account (the room's settings.music is 'mix'
//   or 'deck'; which deck is the host screen's business); play: 'preview' | 'spotify'
// It lives PREPARED_IDLE_MS (30 days) after its last activity (room.mjs, idleLimit), and the
// owner's rights come from the account: open() gives the device that asks a fresh owner token
// (the old owner connection gets the usual "replaced"). Closing it from the host screen empties
// it instead of ending it (resetPrepared): the code stays valid until the account deletes it.
// Used by core.mjs (Node) and worker.mjs (the Room Durable Object); the account side is in
// accounts.mjs. Every function returns { ok: true, room? , ... } or { ok: false, error, message? }.
import * as G from '../app/js/multi/game.js';
import { randomToken, hashToken, PREPARED_IDLE_MS } from './room.mjs';

export const isPrepared = (hub) => !!hub?.state?.prepared;

/** What "Mijn kamers" shows of a prepared room (the account's own view, never a player's details). */
export function preparedSummary(hub) {
  const s = hub.state;
  const p = s.prepared;
  const r = s.room;
  return {
    code: hub.code,
    name: p.name,
    settings: { ...r.settings },
    music: p.music,
    play: p.play,
    hostPlays: !!p.hostPlays,
    hostName: s.ownerName,
    phase: r.phase,
    players: r.players.filter((x) => !x.host).length,
    leaderOnline: hub.online(s.leaderId),
    createdAt: p.createdAt,
    lastActive: s.lastActive,
    expiresAt: s.lastActive + PREPARED_IDLE_MS,
  };
}

const ownerIdNew = () => `a${randomToken(9).replace(/[^A-Za-z0-9]/g, 'x')}`;

/** A new prepared room in this (empty) hub. opts: { account, name, settings, music, play, hostPlays, hostName }. */
export function prepareRoom(hub, opts) {
  if (hub.exists()) return { ok: false, error: 'taken' };
  const music = opts.music || 'deck';
  hub.create({
    ownerId: ownerIdNew(),
    name: opts.hostName || 'Spelleider',
    hostPlays: !!opts.hostPlays,
    settings: { ...(opts.settings || {}), music: music === 'mix' ? 'mix' : 'deck' },
  }); // the token it returns is not used: the owner gets one with open()
  const s = hub.state;
  s.prepared = { account: String(opts.account), name: opts.name, music, play: opts.play === 'spotify' ? 'spotify' : 'preview', hostPlays: !!opts.hostPlays, createdAt: s.createdAt };
  hub.persist();
  return { ok: true, room: preparedSummary(hub) };
}

/** Throw the connections out of the room (players, displays, the owner), with a message. */
function kickAll(hub, code, message) {
  for (const connId of [...hub.conns.keys()]) {
    hub.sendTo(connId, { t: 'error', code, message });
    hub.deps.drop?.(connId, 4000, code);
  }
  hub.conns.clear();
}

/**
 * Empty a prepared room for another party: players, game, mix and connections go; code,
 * name, settings, music, the host's name and the owner's token stay.
 */
export function resetPrepared(hub, code = 'closed', message = 'De spelleider heeft de kamer leeggemaakt voor een nieuw potje.') {
  const s = hub.state;
  const t = hub.now();
  kickAll(hub, code, message);
  const owner = s.members[s.ownerId];
  const room = G.createRoom({ code: hub.code, host: s.prepared.hostPlays ? { id: s.ownerId, name: s.ownerName } : null, settings: s.room.settings });
  const next = { ...s, lastActive: t, leaderId: s.ownerId, leaderAwaySince: t, members: { [s.ownerId]: owner }, room, mix: {}, away: {} };
  delete next.restoredAt;
  hub.state = next;
  hub.mixVersion++;
  hub.mixCache = null;
  hub.backupKey = '';
  hub.persist();
  hub.deps.wake?.(null);
}

/** An edit from "Mijn kamers". patch: any of { name, settings, music, play, hostPlays, hostName } (already checked). */
function editPrepared(hub, patch) {
  const s = hub.state;
  const p = s.prepared;
  const lobby = s.room.phase === 'lobby' || s.room.phase === 'won';
  const gameChange = 'settings' in patch || 'music' in patch || ('hostPlays' in patch && !!patch.hostPlays !== !!p.hostPlays);
  if (gameChange && !lobby) return { ok: false, status: 409, error: 'busy', message: 'Het spel in deze kamer is bezig. Pas de instellingen aan als het potje klaar is.' };
  if ('hostPlays' in patch && !!patch.hostPlays !== !!p.hostPlays && s.room.phase !== 'lobby') return { ok: false, status: 409, error: 'busy', message: 'Meespelen kan alleen veranderen als de kamer in de lobby is.' };
  let room = s.room;
  if ('settings' in patch || 'music' in patch) {
    const music = 'music' in patch ? patch.music : p.music;
    room = G.setSettings(room, { ...('settings' in patch ? patch.settings : {}), music: music === 'mix' ? 'mix' : 'deck' });
  }
  if ('hostName' in patch) {
    s.ownerName = patch.hostName;
    room = { ...room, players: room.players.map((x) => (x.id === s.ownerId ? { ...x, name: patch.hostName } : x)) };
  }
  if ('hostPlays' in patch && !!patch.hostPlays !== !!p.hostPlays) {
    room = patch.hostPlays
      // the host's seat exactly as a new room makes it (whatever fields game.js gives a host)
      ? { ...room, players: [...G.createRoom({ code: hub.code, host: { id: s.ownerId, name: s.ownerName } }).players, ...room.players.filter((x) => x.id !== s.ownerId)] }
      : { ...room, players: room.players.filter((x) => x.id !== s.ownerId) };
  }
  s.room = room;
  s.prepared = {
    ...p,
    ...('name' in patch ? { name: patch.name } : {}),
    ...('music' in patch ? { music: patch.music } : {}),
    ...('play' in patch ? { play: patch.play } : {}),
    ...('hostPlays' in patch ? { hostPlays: !!patch.hostPlays } : {}),
  };
  s.lastActive = hub.now();
  hub.changed(); // the lobby (and the big screen) see the new name and settings at once
  return { ok: true, room: preparedSummary(hub) };
}

/**
 * This device becomes the room's spelleider: a fresh owner token (the old one stops working),
 * the old owner connection is told "replaced", and the lead goes back to the owner.
 * Returns what the host session stores: { code, id, token }.
 */
function openPrepared(hub) {
  const s = hub.state;
  const token = randomToken();
  s.members[s.ownerId] = { th: hashToken(token) };
  for (const [connId, c] of [...hub.conns]) {
    if (c.mid !== s.ownerId) continue;
    hub.sendTo(connId, { t: 'error', code: 'replaced', message: 'Je speelt in een ander venster of op een ander toestel verder.' });
    hub.conns.delete(connId);
    hub.deps.drop?.(connId, 4001, 'replaced');
  }
  const t = hub.now();
  s.leaderId = s.ownerId;
  s.leaderAwaySince = t;
  s.lastActive = t;
  hub.backupKey = '';
  hub.changed();
  return { ok: true, code: hub.code, id: s.ownerId, token, room: preparedSummary(hub) };
}

/**
 * The account logged out everywhere, changed its password or was recovered: the owner token
 * nobody should hold any more is replaced by one nobody knows, and an owner connection that is
 * open now is closed ('token': the host session forgets the room; Mijn kamers > Open makes a
 * device the spelleider again). Players, game and settings stay.
 */
function rotateOwner(hub) {
  const s = hub.state;
  s.members[s.ownerId] = { th: hashToken(randomToken()) };
  for (const [connId, c] of [...hub.conns]) {
    if (c.mid !== s.ownerId) continue;
    hub.sendTo(connId, { t: 'error', code: 'token', message: 'Je account is op een ander toestel uitgelogd of het wachtwoord is gewijzigd. Open de kamer opnieuw via Mijn kamers.' });
    hub.conns.delete(connId);
    hub.deps.drop?.(connId, 4000, 'token');
    hub.markAway?.(s.ownerId);
  }
  if (s.leaderId === s.ownerId) s.leaderAwaySince = hub.now();
  hub.backupKey = '';
  hub.changed();
  return { ok: true };
}

/** One operation of the owning account on its room: 'summary' | 'edit' | 'reset' | 'open' | 'rotate' | 'delete'. */
export function preparedOp(hub, name, args = {}) {
  const s = hub.state;
  // not there, or somebody else's (also a normal room that got this code later): "gone"
  if (!s?.prepared || s.prepared.account !== String(args.account || '')) return { ok: false, error: 'gone' };
  try {
    switch (name) {
      case 'summary': return { ok: true, room: preparedSummary(hub) };
      case 'edit': return editPrepared(hub, args.patch || {});
      case 'reset': resetPrepared(hub); return { ok: true, room: preparedSummary(hub) };
      case 'open': return openPrepared(hub);
      case 'rotate': return rotateOwner(hub);
      case 'delete': hub.shutdown('closed', 'Deze kamer is opgeheven door de spelleider.'); return { ok: true };
      default: return { ok: false, error: 'bad' };
    }
  } catch (e) {
    if (e instanceof G.GameError) return { ok: false, status: 409, error: e.code || 'bad', message: e.message };
    throw e;
  }
}
