// "Samen spelen" via a room server: the messages between the phones and the server.
// Pure, no DOM: shared by the browser (server-session.js), the Node server and the
// Cloudflare Worker (server/). The game rules stay in game.js; the views in protocol.js.
//
//   phone -> server: hello {v, code, id, token, name}
//                    answer {round, answer}, withdraw {}, leave {} (in the lobby: off the list; during a game
//                      (also on the winner screen) the seat stays and the same phone may come back with its token)
//                    mix-add {tracks} / mix-clear {}: add to / withdraw this phone's part of the
//                      "Mix van de groep" (see mix.js); every member, also the spelleider
//                    stamp {round, index} (Discobingo, after the reveal: a right player chooses or moves
//                      this round's stamp; index null takes it back)
//                    leader only: settings {patch}, start {cards, seed?, play?}, reveal {}, override {pid},
//                                 next {}, lobby {}, remove {pid},
//                                 playing {round} (Quiz: the song plays, the thinking time starts)
//                                 judge {pid, ok} (Discobingo: Goed / Fout on a doubt, or on any answer)
//                    owner or leader: close {}
//                    lead {} (take the lead: the owner always, a player when the leader is away)
//   server -> phone: welcome {v, id, token, code}, state {view, meta, lead?}, error {code, message},
//                    backup {snap} (owner only: copy of the room for a server restart)
// Plain-text "ping" / "pong" keep the connection (and a sleeping host) awake.
// meta.now is the server's clock (ms): the phones show the Quiz countdown in server time.
// The state's meta has `mix` {total, preview, sure, contributors, mine}: counts only, never titles.
// hello may carry `cid`: the phone's Spotify Client ID ('' = none). The owner's goes to everybody
// as meta.spotifyClientId (a public value, checked: 32 hex characters), so in a room only the
// spelleider has to set Spotify up. Both are optional extra fields, so the version stays 3: an
// older app simply sends no cid and ignores the extra meta field, an older server ignores cid.
//
// A display ("groot scherm", a tv that only watches) says hello {v, code, screen: true}: no id,
// no token, no name. The server answers welcome {v, code, screen: true} and from then on sends
// state {view, meta} with the public spectator view (nobody's card, answer or choice; the song
// only after the reveal) and meta.screen = true; it never sends a display a backup or lead part.
// A display may send only hello / leave / ping; anything else gets error {code: 'screen'} (the
// connection stays). At most 4 per room: a hello may carry `sid` (the display tab's random id) so a
// reconnect takes back its own slot; a fifth display takes the slot of the one heard from longest
// ago, which gets error 'screenreplaced' and is closed (a server before this answered 'screens'). Every state's meta has
// `screens`: how many displays watch. Also an optional addition, so the version stays 4: an
// older server answers a display hello (no id) with error 'bad' and closes it; /health of a
// server that knows displays lists 'screen' in `features`, so the display can tell beforehand.
//
//
// Party extras (optional additions within version 4; /health `features` lists 'party'):
//   hello may carry `avatar` (one of party.js AVATARS; else the server derives one from the id);
//   avatar {avatar}: another avatar, in the lobby only; stamp may carry `joker: true` (Discobingo:
//   the chip on an open square of another colour, spending a joker); react {emoji}: one of
//   party.js REACTIONS, from a seated player (lobby; after answering; after the reveal; winner
//   screen), rate limited, never stored: the server passes it on as react {id, name, avatar,
//   emoji, at} to the displays and the leader only (an older app ignores the unknown type).
//   Refused reactions are dropped silently. A new app must not send avatar / react to a server
//   without the 'party' feature: that one answers 'bad'.
//
// Version 2 (November 2026): the Quiz (settings questions/qtype/think, playing, the quiz part of
// the view). Version 3 (November 2026): "Mix van de groep" (mix-add, mix-clear, settings.music,
// start.play, meta.mix). Version 4 (November 2026): Discobingo (game 'disco', settings.win, stamp,
// judge, the disco part of the view). A phone with another version gets a clear message
// (health / hello / POST /rooms).

export const SERVER_PROTOCOL_VERSION = 4;
/** Optional additions within this version that the server announces in /health `features`. */
export const SERVER_FEATURES = ['screen', 'party'];
/**
 * Largest message from a phone (the deck at the start of a game), in UTF-8 bytes. A start
 * with 2000 realistic cards is about 300 kB (tests/unit/big-lists.test.mjs); fitCards keeps
 * every start below it (slimmer cards, else fewer), so the server never has to refuse one.
 */
export const MAX_CLIENT_MESSAGE = 512 * 1024;
/** Every other message is small. */
export const MAX_SMALL_MESSAGE = 16 * 1024;
/** Most songs in a room's deck: the same as a playlist's MAX_TRACKS (playlist-logic.js). */
export const MAX_CARDS = 2000;
/** A leader who is away this long may be replaced by a player. */
export const TAKEOVER_MS = 30000;
export const PING_TEXT = 'ping';
export const PONG_TEXT = 'pong';
export const CLIENT_PING_MS = 10000;
/** Nothing heard for this long: the connection is dead. */
export const STALE_MS = 25000;

const CLIENT_TYPES = ['hello', 'answer', 'withdraw', 'leave', 'settings', 'start', 'reveal', 'override', 'next', 'lobby', 'remove', 'close', 'lead', 'playing', 'mix-add', 'mix-clear', 'stamp', 'judge', 'avatar', 'react'];
const SERVER_TYPES = ['welcome', 'state', 'error', 'backup', 'react'];
export const LEADER_TYPES = ['settings', 'start', 'reveal', 'override', 'next', 'lobby', 'remove', 'playing', 'judge'];

export const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** A Spotify Client ID: 32 hexadecimal characters. */
export const SPOTIFY_CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

/** Parse a message from a phone (string). Null when it is not a valid message. */
export function parseClientMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CLIENT_MESSAGE || utf8Length(raw) > MAX_CLIENT_MESSAGE) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !CLIENT_TYPES.includes(m.t)) return null;
  if (m.t !== 'start' && raw.length > MAX_SMALL_MESSAGE) return null;
  return m;
}

/** Parse a message from the server. Null when it is not a valid message. */
export function parseServerMessage(raw) {
  if (typeof raw !== 'string') return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  return m && typeof m === 'object' && SERVER_TYPES.includes(m.t) ? m : null;
}

/** UTF-8 length of a string (what a WebSocket frame carries), without building the bytes. */
export function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) { n += 4; i++; } else n += 3;
  }
  return n;
}

const CARD_FIELDS = ['id', 'year', 'title', 'artist', 'previewUrl', 'itunesId', 'spotifyId', 'deezerId', 'isrc'];

/**
 * Only what the server needs to run a game and the music phone needs to play a song (the
 * ISRC only serves to find a song on Spotify, so it stays home when there is a Spotify id).
 */
export function cardsForServer(cards) {
  return (cards || []).map((c) => {
    const o = {};
    for (const k of CARD_FIELDS) if (c[k] != null && c[k] !== '') o[k] = c[k];
    if (o.spotifyId) delete o.isrc;
    return o;
  });
}

/**
 * The cards of a start message that fits in `maxBytes` (the whole message, `extra` = the
 * rest of it): as they are when they fit; else without the previewUrl of cards that have an
 * id to look it up with, and titles / artists of at most 100 characters; else only as many
 * cards as fit (a fair random part when `rand` is given). Returns { cards, cut } (cut: how
 * many were left out).
 */
export function fitCards(cards, { maxBytes = MAX_CLIENT_MESSAGE - 4096, extra = 200, rand = Math.random } = {}) {
  let list = cardsForServer((cards || []).slice(0, MAX_CARDS));
  const size = (l) => utf8Length(JSON.stringify(l)) + extra;
  if (size(list) <= maxBytes) return { cards: list, cut: Math.max(0, (cards || []).length - list.length) };
  list = list.map((c) => {
    const o = { ...c };
    if (o.itunesId || o.deezerId) delete o.previewUrl;
    if (typeof o.title === 'string') o.title = o.title.slice(0, 100);
    if (typeof o.artist === 'string') o.artist = o.artist.slice(0, 100);
    return o;
  });
  if (size(list) <= maxBytes) return { cards: list, cut: Math.max(0, (cards || []).length - list.length) };
  // still too big: a random part of the cards, as many as fit
  const order = list.map((c, i) => [rand(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const keep = new Set();
  let used = 2 + extra;
  for (const i of order) {
    const b = utf8Length(JSON.stringify(list[i])) + 1;
    if (used + b > maxBytes) continue;
    used += b;
    keep.add(i);
  }
  const out = list.filter((_, i) => keep.has(i));
  return { cards: out, cut: (cards || []).length - out.length };
}

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');

/** Server side: check and trim the cards a leader sent. Returns a clean array (invalid cards dropped). */
export function cleanCards(cards) {
  if (!Array.isArray(cards)) return [];
  const out = [];
  const seen = new Set();
  for (const c of cards.slice(0, MAX_CARDS)) {
    if (!c || typeof c !== 'object') continue;
    const id = str(c.id, 40);
    const year = Number(c.year);
    if (!id || seen.has(id) || !Number.isInteger(year) || year < 1800 || year > 2200) continue;
    seen.add(id);
    const o = { id, year, title: str(c.title, 200), artist: str(c.artist, 200) };
    if (typeof c.previewUrl === 'string' && /^https:\/\/[^\s"'<>]{4,600}$/.test(c.previewUrl)) o.previewUrl = c.previewUrl;
    if (Number.isSafeInteger(Number(c.itunesId)) && Number(c.itunesId) > 0) o.itunesId = Number(c.itunesId);
    if (typeof c.spotifyId === 'string' && /^[A-Za-z0-9]{10,40}$/.test(c.spotifyId)) o.spotifyId = c.spotifyId;
    if (Number.isSafeInteger(c.deezerId) && c.deezerId > 0) o.deezerId = c.deezerId;
    if (typeof c.isrc === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(c.isrc)) o.isrc = c.isrc;
    out.push(o);
  }
  return out;
}

/** Messages the user may see for server error codes (the server sends its own text too). */
export const ERROR_TITLES = {
  version: 'Andere versie van de app',
  removed: 'Je bent verwijderd',
  closed: 'De kamer is gesloten',
  full: 'De kamer is vol',
  room: 'Kamer bestaat niet meer',
  notfound: 'Kamer niet gevonden',
  replaced: 'Je speelt elders verder',
  token: 'Deze plek hoort bij een ander toestel',
  expired: 'De kamer is verlopen',
  busy: 'De kamer is te druk',
  ratelimit: 'Te veel berichten',
  mix: 'Mix van de groep',
  screen: 'Groot scherm',
  screens: 'Te veel grote schermen',
  screenreplaced: 'Een ander scherm kijkt nu mee',
  noscreen: 'Server kent het grote scherm niet',
  noserver: 'Geen server voor samen spelen',
};

/** Base addresses for a configured server ("https://x.y", "wss://x.y/", "x.y") -> { http, ws } or null. */
export function serverBases(url) {
  let s = String(url || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return null;
  const rest = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return { http: `${secure ? 'https' : 'http'}://${rest}`, ws: `${secure ? 'wss' : 'ws'}://${rest}` };
}
