// Accounts ("inloggen") on the room server: log in on any device and find your own
// playlists, your Spotify Client ID, a few preferences and your prepared rooms there. No DOM:
// the screens (#/account, "Mijn kamers") use this module; it talks to the server that
// server-session.js uses (MULTI_SERVER_URL or the per-browser override) and does nothing when
// there is no server or the server is older than accounts (/health `features` without
// 'accounts'): every call then answers { ok: false, code: 'noserver' | 'noaccounts', message }.
//
// Stored on this device: timetunesr.account.v1 = { username, token, server, rev, data, synced, at }
//   token  the session (sent as "Authorization: Bearer …"; logging out revokes it)
//   rev / data  the account's data as this device last saw it (for the merge)
//   synced the ids of the playlists that were in both places after the last sync, so a playlist
//          deleted here while logged in is deleted in the account too (and not uploaded again)
//
// Sync: pull() fetches the account and merges (mergeAccountData, pure and unit-tested) with
// what is on this device; push() saves this device's state, and when another device saved in
// between (409 conflict) merges with that and saves again. While logged in, startAutoSave()
// saves changes of the playlists / Spotify Client ID by itself (debounced, retried when the
// network is back), never blocking the screen. With a server that knows 'account-delta' a save
// sends only the playlists that changed (the others as stubs { id, updated, same: true }), and
// after a big save the next one waits a little longer (saveGap), so a library of 2000-song lists
// that background work keeps finishing is not sent again every few seconds.
import { store } from './ui.js';
import { serverBase, SERVER_HOST_KEY, BACKUP_KEY } from './multi/server-session.js';
import { cleanLinks, sameLinks } from './spotify-links.js';

export const ACCOUNT_KEY = 'timetunesr.account.v1';
const PLAYLISTS_KEY = 'timetunesr.playlists.v1'; // playlists.js KEY
const ACTIVE_DECK_KEY = 'timetunesr.activeDeck.v1'; // playlists.js ACTIVE_KEY
const SPOTIFY_ID_KEY = 'timetunesr.spotify.clientId.v1'; // spotify.js K.clientId
const SPOTIFY_LINKS_KEY = 'timetunesr.spotify.links.v1'; // spotify.js K.links
const HOST_NAME_KEY = 'timetunesr.multiName.v1'; // the spelleider's name (room-host.js)
const SETTINGS_KEY = 'timetunesr.multiSettings.v1'; // the lobby's last settings (server-session.js)

export const SAVE_DELAY_MS = 1500;
/** The data format this app writes (sent with every save; an app of before sends none). */
export const DATA_FORMAT = 2;
const RETRY_MS = [3000, 10000, 30000, 60000];
/** After a save of `bytes`, the next background save waits at least this long (ms). */
export const saveGap = (bytes) => Math.min(30000, Math.round((Number(bytes) || 0) / 1024) * 30);
const TIMEOUT_MS = 20000;

// ---------- the merge (pure) ----------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Merge this device's state with the account's. Both: { playlists: [...], spotifyClientId,
 * spotifyLinks?, prefs, deleted? } (deleted: { playlistId: time } tombstones). `baseIn`: the
 * account's data as this device last synced it (the common ancestor), or null on a device that
 * never synced with this account. Rules:
 * - playlists by id: in both places the newest `updated` wins (equal: the account's);
 *   only here -> uploaded; only in the account -> put on this device; a tombstone at or after
 *   a playlist's `updated` removes it on both sides (a playlist changed after it was deleted
 *   elsewhere comes back). (The `updated` stamps make this a three-way rule already.)
 * - the Spotify Client ID, the Spotify links (spotifyLinks [{ id, name }], several Spotify apps)
 *   and the preference the device keeps itself (hostName) are three-way against the base:
 *   changed only here -> this device's wins and is uploaded; changed only in the account -> the
 *   account's; changed in both -> the account's, except for the links, which are merged per
 *   link (linkMerge: the account's list and order, plus a link renamed or removed only here,
 *   plus the links added only here at the end, up to LINKS_MAX);
 * - no base (a fresh device, the first sync): the account's Client ID when it has one, else
 *   this device's; the account's links when it has a list, else this device's (an account of
 *   before, with only spotifyClientId, gets the device's list); prefs per field the account's
 *   when set, else this device's;
 * - the Client ID the host logs in with himself is always one of the links;
 * - opts.links false: the server does not keep the links (no 'account-links'): this device's
 *   list stays as it is and never counts as a change to save.
 * Returns { local, remote, localChanged, remoteChanged, summary, text } with `local` and
 * `remote` the new states (equal in content), `summary` counts and names, `text` Dutch lines
 * for the screen ("3 playlists van dit toestel toegevoegd aan je account").
 */
export function mergeAccountData(localIn = {}, remoteIn = {}, baseIn = null, { links: linksKept = true } = {}) {
  const local = normalizeState(localIn);
  const remote = normalizeState(remoteIn);
  const base = baseIn && typeof baseIn === 'object' ? normalizeState(baseIn) : null;
  const deleted = { ...remote.deleted };
  for (const [id, at] of Object.entries(local.deleted)) if (!(deleted[id] >= at)) deleted[id] = at;
  const L = new Map(local.playlists.map((p) => [p.id, p]));
  const R = new Map(remote.playlists.map((p) => [p.id, p]));
  const summary = { toAccount: [], fromAccount: [], updatedHere: [], updatedThere: [], removedHere: [], removedThere: [], spotify: null, prefs: [] };
  const out = [];
  const ids = [...new Set([...R.keys(), ...L.keys()])];
  for (const id of ids) {
    const l = L.get(id);
    const r = R.get(id);
    const newest = Math.max(l?.updated || 0, r?.updated || 0);
    if (Object.hasOwn(deleted, id) && deleted[id] >= newest) {
      if (l) summary.removedHere.push(l.name);
      if (r) summary.removedThere.push(r.name);
      continue;
    }
    if (l && r) {
      if ((l.updated || 0) > (r.updated || 0)) { out.push(l); if (!same(l, r)) summary.updatedThere.push(l.name); } else { out.push(r); if (!same(l, r)) summary.updatedHere.push(r.name); }
    } else if (l) { out.push(l); summary.toAccount.push(l.name); } else { out.push(r); summary.fromAccount.push(r.name); }
  }
  // a tombstone that won is kept only while it matters: one for a playlist that came back goes
  for (const p of out) delete deleted[p.id];
  let spotifyClientId;
  let spotifyLinks;
  const prefs = { ...remote.prefs };
  if (!base) {
    // a fresh device: the account wins (as before the three-way rule)
    spotifyClientId = remote.spotifyClientId || local.spotifyClientId;
    // links: the account's list when it has one; the own Client ID is always in it (an app of
    // before may have changed only spotifyClientId: that one comes in front)
    spotifyLinks = !linksKept ? local.spotifyLinks : remote.hasLinks ? remote.spotifyLinks : local.hasLinks ? local.spotifyLinks : [];
    if (!spotifyClientId && !remote.hasLinks) spotifyLinks = [];
    for (const [k, v] of Object.entries(local.prefs)) if (prefs[k] === undefined && v !== undefined) { prefs[k] = v; summary.prefs.push(k); }
  } else {
    // changed in the account since the last sync -> the account's (also when changed here too);
    // else this device's (changed here, or not changed at all)
    spotifyClientId = remote.spotifyClientId !== base.spotifyClientId ? remote.spotifyClientId : local.spotifyClientId;
    const B = rawLinks(base);
    // an account written only by apps of before has no list: they never change it
    const R = remote.listed ? remote.list : B;
    const L = local.spotifyLinks;
    const here = !sameLinks(L, B);
    const there = !sameLinks(R, B);
    spotifyLinks = !linksKept || !there ? L : !here ? R : linkMerge(L, R, B);
    // an app of before removed its Client ID in the account: that link goes too
    if (!spotifyClientId && base.spotifyClientId && remote.spotifyClientId !== base.spotifyClientId) spotifyLinks = spotifyLinks.filter((l) => l.id !== base.spotifyClientId);
    for (const [k, v] of Object.entries(local.prefs)) {
      if (v === undefined) continue;
      if (prefs[k] === undefined || (v !== base.prefs[k] && prefs[k] === base.prefs[k])) {
        if (prefs[k] !== v) summary.prefs.push(k);
        prefs[k] = v;
      }
    }
  }
  if (spotifyClientId && !spotifyLinks.some((l) => l.id === spotifyClientId)) {
    // the Client ID changed by an app of before takes the place of the own link it replaced (as
    // setClientId does), else it comes in front
    const prev = [base?.spotifyClientId, local.spotifyClientId].find((id) => id && id !== spotifyClientId && spotifyLinks.some((l) => l.id === id) && (base || !remote.hasLinks));
    const at = prev ? spotifyLinks.findIndex((l) => l.id === prev) : -1;
    spotifyLinks = at >= 0 ? cleanLinks(spotifyLinks.map((l, i) => (i === at ? { ...l, id: spotifyClientId } : l)))
      : cleanLinks([{ id: spotifyClientId, name: '' }, ...spotifyLinks]);
  }
  // links but no own Client ID: Link 1 is the own one (as spotify.js setLinks decides)
  if (!spotifyClientId && spotifyLinks.length) spotifyClientId = spotifyLinks[0].id;
  if (spotifyClientId && spotifyClientId !== local.spotifyClientId && spotifyClientId === remote.spotifyClientId) summary.spotify = 'fromAccount';
  else if (spotifyClientId && spotifyClientId !== remote.spotifyClientId) summary.spotify = 'toAccount';
  const plain = (list) => list.length <= 1 && !list.some((l) => l.name); // nothing more than the Client ID itself
  // one link and no list in the account yet: nothing new to save (an account of before stays as it was)
  const linksChanged = linksKept && (remote.listed ? !sameLinks(remote.list, spotifyLinks) : !plain(spotifyLinks));
  if (!summary.spotify && !sameLinks(local.spotifyLinks, spotifyLinks)) summary.spotify = 'linksFromAccount';
  else if (!summary.spotify && linksChanged && !plain(spotifyLinks)) summary.spotify = 'linksToAccount';
  const merged = { playlists: out, spotifyClientId, spotifyLinks, prefs, deleted };
  // (only the host name of the prefs is kept on the device itself)
  const hostName = prefs.hostName;
  const localState = { playlists: out, spotifyClientId, spotifyLinks, prefs: { ...prefs, ...(hostName !== undefined ? { hostName } : {}) } };
  const localChanged = !sameJson(local.playlists, out) || local.spotifyClientId !== spotifyClientId || !sameLinks(local.spotifyLinks, spotifyLinks) || (hostName !== undefined && local.prefs.hostName !== hostName);
  const remoteChanged = !sameJson(remote.playlists, out) || remote.spotifyClientId !== spotifyClientId || linksChanged || !sameJson(remote.prefs, prefs) || !sameJson(remote.deleted, deleted);
  return { local: localState, remote: merged, localChanged, remoteChanged, summary, text: summaryText(summary) };
}

function normalizeState(s) {
  return {
    playlists: Array.isArray(s?.playlists) ? s.playlists.filter((p) => p && typeof p.id === 'string') : [],
    spotifyClientId: typeof s?.spotifyClientId === 'string' ? s.spotifyClientId.toLowerCase() : '',
    // the list as it is in effect: the Client ID alone when there is no list (yet)
    spotifyLinks: effectiveLinks(s),
    hasLinks: cleanLinks(s?.spotifyLinks).length > 0,
    // the list exactly as stored (an account written only by apps of before has none: listed false)
    listed: Array.isArray(s?.spotifyLinks),
    list: cleanLinks(s?.spotifyLinks),
    prefs: s?.prefs && typeof s.prefs === 'object' ? { ...s.prefs } : {},
    deleted: s?.deleted && typeof s.deleted === 'object' ? { ...s.deleted } : {},
  };
}
function effectiveLinks(s) {
  const cid = typeof s?.spotifyClientId === 'string' ? s.spotifyClientId.toLowerCase() : '';
  const list = cleanLinks(s?.spotifyLinks);
  return cid && !list.some((l) => l.id === cid) ? cleanLinks([{ id: cid, name: '' }, ...list]) : list;
}
/** The links of a synced state as stored (the Client ID alone when it has no list). */
const rawLinks = (n) => (n.listed ? n.list : n.spotifyClientId ? [{ id: n.spotifyClientId, name: '' }] : []);

/**
 * Both this device and the account changed the links since the last sync (base): the account's
 * list in its order, where a link that only this device renamed gets this device's name and a
 * link that only this device removed goes; then the links only this device added, at the end,
 * up to LINKS_MAX. A link the account removed stays removed; one renamed in both places keeps
 * the account's name. Deterministic: the same three lists always give the same result.
 */
export function linkMerge(local, remote, base) {
  const B = new Map(cleanLinks(base).map((l) => [l.id, l]));
  const L = new Map(cleanLinks(local).map((l) => [l.id, l]));
  const R = cleanLinks(remote);
  const out = [];
  for (const r of R) {
    const b = B.get(r.id);
    const l = L.get(r.id);
    const untouchedThere = b && b.name === r.name;
    if (untouchedThere && !l) continue; // removed here only
    out.push(untouchedThere && l && l.name !== b.name ? { id: r.id, name: l.name } : r);
  }
  for (const l of L.values()) if (!B.has(l.id) && !R.some((r) => r.id === l.id)) out.push(l); // added here
  return cleanLinks(out);
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const same = (a, b) => sameJson(a, b);

/** Dutch lines for what a merge did ([] when nothing changed). */
export function summaryText(s) {
  const lines = [];
  if (s.toAccount.length) lines.push(`${plural(s.toAccount.length, 'playlist', 'playlists')} van dit toestel toegevoegd aan je account`);
  if (s.fromAccount.length) lines.push(`${plural(s.fromAccount.length, 'playlist', 'playlists')} van je account op dit toestel gezet`);
  if (s.updatedHere.length) lines.push(`${plural(s.updatedHere.length, 'playlist', 'playlists')} op dit toestel bijgewerkt`);
  if (s.updatedThere.length) lines.push(`${plural(s.updatedThere.length, 'playlist', 'playlists')} in je account bijgewerkt`);
  if (s.removedHere.length) lines.push(`${plural(s.removedHere.length, 'playlist', 'playlists')} van dit toestel verwijderd (op een ander toestel weggegooid)`);
  if (s.spotify === 'fromAccount') lines.push('Spotify Client ID van je account op dit toestel gezet');
  if (s.spotify === 'toAccount') lines.push('Spotify Client ID van dit toestel bewaard in je account');
  if (s.spotify === 'linksFromAccount') lines.push('Spotify-links van je account op dit toestel gezet');
  if (s.spotify === 'linksToAccount') lines.push('Spotify-links van dit toestel bewaard in je account');
  return lines;
}

// ---------- this device's state ----------
function readLocal() {
  const raw = store.get(PLAYLISTS_KEY, null);
  const playlists = Array.isArray(raw?.lists) ? raw.lists : Array.isArray(raw) ? raw : [];
  const sp = store.get(SPOTIFY_ID_KEY, '');
  const hostName = store.get(HOST_NAME_KEY, '');
  const spotifyClientId = typeof sp === 'string' && /^[0-9a-f]{32}$/i.test(sp.trim()) ? sp.trim().toLowerCase() : '';
  // the device's links (spotify.js K.links): only stored once there is more than the Client ID
  // itself; the merge adds the Client ID when it is not in it (normalizeState)
  const spotifyLinks = cleanLinks(store.get(SPOTIFY_LINKS_KEY, null));
  return {
    playlists,
    spotifyClientId,
    spotifyLinks,
    prefs: typeof hostName === 'string' && hostName.trim() ? { hostName: hostName.trim() } : {},
  };
}

/** Put a merged state on this device (and tell playlists.js / spotify.js, when the app has loaded them). */
async function writeLocal(state, before) {
  if (!sameJson(before.playlists, state.playlists)) {
    store.set(PLAYLISTS_KEY, { v: 1, lists: state.playlists });
    try { (await import('./playlists.js')).reload(); } catch { /* not in this page */ }
  }
  if (state.spotifyClientId !== before.spotifyClientId || !sameLinks(state.spotifyLinks, effectiveLinks(before))) {
    const links = cleanLinks(state.spotifyLinks);
    const own = links.findIndex((l) => l.id === state.spotifyClientId);
    try {
      const sp = await import('./spotify.js');
      if (links.length) sp.setLinks(links, { own: own >= 0 ? own : null });
      if (sp.getClientId() !== state.spotifyClientId) sp.setClientId(state.spotifyClientId);
    } catch {
      store.set(SPOTIFY_ID_KEY, state.spotifyClientId);
      if (links.length > 1 || links.some((l) => l.name)) store.set(SPOTIFY_LINKS_KEY, links); else store.remove(SPOTIFY_LINKS_KEY);
    }
  }
  if (state.prefs.hostName && store.get(HOST_NAME_KEY, '') !== state.prefs.hostName) store.set(HOST_NAME_KEY, state.prefs.hostName);
}

// ---------- session ----------
const listeners = new Set();
/** fn({ type, ... }): 'login' | 'logout' {reason} | 'sync' {text} | 'saving' | 'saved' | 'error' {code, message} | 'change'. */
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch (e) { console.error(e); } } }

/**
 * The stored session, but only for the server it was made on: with another server configured
 * now (the per-browser override) this device counts as logged out there, and the token is never
 * sent to it. The stored session stays (switching back logs in again).
 */
const readSession = () => {
  const s = store.get(ACCOUNT_KEY, null);
  if (!s || typeof s.username !== 'string' || typeof s.token !== 'string') return null;
  return typeof s.server === 'string' && s.server === serverBase()?.http ? s : null;
};
const writeSession = (s) => store.set(ACCOUNT_KEY, s);

/** Who is logged in on this device: { username, server } or null. Synchronous, local. */
export function current() {
  const s = readSession();
  return s ? { username: s.username, server: s.server || null } : null;
}

const state = { saving: false, pending: false, lastSync: 0, error: null };
/** For the screen: { loggedIn, saving, pending, lastSync, error }. */
export const status = () => ({ loggedIn: !!readSession(), ...state });

// ---------- HTTP ----------
let healthCache = null; // { base, at, result, features }

/** Can this device use accounts? { ok } or { ok: false, code: 'noserver' | 'noaccounts' | 'offline', message }. */
export async function available({ fresh = false } = {}) {
  const base = serverBase();
  if (!base) return { ok: false, code: 'noserver', message: 'Er is geen server ingesteld voor samen spelen, dus inloggen kan hier niet.' };
  if (!fresh && healthCache?.base === base.http && Date.now() - healthCache.at < 60000) return healthCache.result;
  const r = await request('GET', '/health');
  let result;
  if (r.ok) result = Array.isArray(r.data?.features) && r.data.features.includes('accounts') ? { ok: true } : { ok: false, code: 'noaccounts', message: 'Deze server kent nog geen accounts. Werk de server bij om in te loggen.' };
  else result = { ok: false, code: r.code || 'offline', message: 'De server is niet bereikbaar. Probeer het zo opnieuw.' };
  if (r.ok) healthCache = { base: base.http, at: Date.now(), result, features: Array.isArray(r.data?.features) ? r.data.features : [] };
  return result;
}

/**
 * Does the server keep the Spotify links (health 'account-links')? An older one refuses the
 * field. Only asked after guard() (settle), so the features of this server are known: a save
 * never leaves the links out just because the health check had not been done yet.
 */
const linksSaves = () => healthCache?.base === serverBase()?.http && !!healthCache.features?.includes('account-links');
/** Without 'account-links' a save leaves the list out (the server keeps spotifyClientId as before). */
const forServer = (data, keep = linksSaves()) => { if (keep) return data; const { spotifyLinks, ...rest } = data; return rest; };

/** Does the server take a save with stubs for unchanged playlists (health 'account-delta')? */
const deltaSaves = () => healthCache?.base === serverBase()?.http && !!healthCache.features?.includes('account-delta');

/**
 * The data to send: every playlist that the account has exactly like this (`known`: the
 * account's data as this device last got it, same rev) becomes a stub { id, updated, same }.
 */
export function deltaData(data, known) {
  const have = new Map((known?.playlists || []).map((p) => [p.id, p]));
  return {
    ...data,
    playlists: (data.playlists || []).map((p) => {
      const k = have.get(p.id);
      return k && k.updated === p.updated && sameJson(k, p) ? { id: p.id, updated: p.updated, same: true } : p;
    }),
  };
}

async function request(method, path, { body, token, timeout = TIMEOUT_MS } = {}) {
  const base = serverBase();
  if (!base) return { ok: false, status: 0, code: 'noserver', data: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    // the token only ever goes to the server it came from (readSession checks it too)
    if (token && store.get(ACCOUNT_KEY, null)?.server !== base.http) return { ok: false, status: 0, code: 'loggedout', data: null };
    const headers = {};
    if (body !== undefined) headers['content-type'] = token ? 'application/json' : 'text/plain;charset=UTF-8'; // no preflight without a token
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base.http}${path}`, {
      method, cache: 'no-store', mode: 'cors', signal: ctl.signal, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data, code: data?.code };
  } catch {
    const offline = globalThis.navigator?.onLine === false;
    return { ok: false, status: 0, data: null, code: ctl.signal.aborted ? 'timeout' : offline ? 'offline' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const NETWORK = { code: 'network', message: 'Geen verbinding met de server. Probeer het zo opnieuw.' };
const failOf = (r) => ({ ok: false, code: r.data?.code || r.code || `http-${r.status}`, message: r.data?.message || NETWORK.message, status: r.status });

/** An authenticated call; a session the server no longer knows logs this device out (keeping the data). */
async function authed(method, path, body) {
  const s = readSession();
  if (!s) return { ok: false, code: 'loggedout', message: 'Je bent niet ingelogd.' };
  const r = await request(method, path, { body, token: s.token });
  if (r.status === 401 && r.data?.code === 'session') { endSession('session'); return failOf(r); }
  return r.ok ? { ok: true, ...r.data } : failOf(r);
}

function endSession(reason) {
  store.remove(ACCOUNT_KEY);
  clearTimeout(saveTimer);
  state.pending = false;
  emit({ type: 'logout', reason });
}

async function guard() {
  const a = await available();
  return a.ok ? null : a;
}

// ---------- logging in ----------
async function begin(path, body, { firstSync = true } = {}) {
  const no = await guard();
  if (no) return no;
  const r = await request('POST', path, { body });
  if (!r.ok) return failOf(r);
  writeSession({ username: r.data.account?.username || body.username, token: r.data.token, server: serverBase()?.http || null, rev: 0, data: null, synced: [], at: Date.now() });
  emit({ type: 'login', username: r.data.account?.username });
  const sync = firstSync ? await pull() : null;
  return { ok: true, username: r.data.account?.username, ...(r.data.recoveryCode ? { recoveryCode: r.data.recoveryCode } : {}), sync };
}

/** Make an account. { ok, username, recoveryCode (show it once!), sync } or { ok: false, code, message }. */
export const signUp = (username, password) => begin('/account/signup', { username, password });
/** { ok, username, sync: { ok, text, summary } } */
export const logIn = (username, password) => begin('/account/login', { username, password });
/** Forgotten password: a new password with the recovery code. { ok, username, recoveryCode (the NEW one), sync }. */
export const recover = (username, recoveryCode, password) => begin('/account/recover', { username, recoveryCode, password });

/** The account's playlists on this device: those of the last sync (and the Spotify Client ID when it is the account's). */
function removeAccountData() {
  const s = readSession();
  const ids = new Set((s?.data?.playlists || []).map((p) => p.id));
  const raw = store.get(PLAYLISTS_KEY, null);
  if (raw?.lists) store.set(PLAYLISTS_KEY, { v: 1, lists: raw.lists.filter((p) => !ids.has(p.id)) });
  if (ids.has(store.get(ACTIVE_DECK_KEY, ''))) store.remove(ACTIVE_DECK_KEY);
  if (s?.data?.spotifyClientId && store.get(SPOTIFY_ID_KEY, '') === s.data.spotifyClientId) store.remove(SPOTIFY_ID_KEY);
  if (Array.isArray(s?.data?.spotifyLinks) && s.data.spotifyLinks.length && sameLinks(store.get(SPOTIFY_LINKS_KEY, null), s.data.spotifyLinks)) store.remove(SPOTIFY_LINKS_KEY);
  import('./playlists.js').then((m) => m.reload()).catch(() => {});
}

/** Log out here. keepData false: the account's playlists (and Spotify Client ID) leave this device too. */
export async function logOut({ keepData = true } = {}) {
  if (!readSession()) return { ok: true };
  if (state.pending) await flush();
  const r = await authed('POST', '/account/logout');
  if (!keepData) removeAccountData();
  if (readSession()) endSession('logout');
  return { ok: true, revoked: r.ok }; // logged out here even when the server could not be reached
}

/** Log out on every device (this one too). */
export async function logOutEverywhere({ keepData = true } = {}) {
  const r = await authed('POST', '/account/logout-all');
  if (!r.ok) return r;
  if (!keepData) removeAccountData();
  if (readSession()) endSession('logout');
  return { ok: true, revoked: r.revoked };
}

/** { ok, revoked } (the other devices are logged out) */
export const changePassword = (password, newPassword) => authed('POST', '/account/password', { password, newPassword });

/** Delete the account and its prepared rooms. keepData: what is on this device stays (default). */
export async function deleteAccount(password, { keepData = true } = {}) {
  const r = await authed('POST', '/account/delete', { password });
  if (!r.ok) return r;
  if (!keepData) removeAccountData();
  if (readSession()) endSession('deleted');
  return { ok: true, rooms: r.rooms };
}

/** Profile and data as the server has them: { ok, account: { username, createdAt, sessions, rooms }, rev, data }. */
export const fetchAccount = () => authed('GET', '/account');

// ---------- sync ----------
/** The local tombstones: playlists that were synced and are not on this device any more. */
function localDeleted(s, local) {
  const here = new Set(local.playlists.map((p) => p.id));
  const t = Date.now();
  return Object.fromEntries((s.synced || []).filter((id) => !here.has(id)).map((id) => [id, t]));
}

/** Merge `remote` ({rev, data}) with this device and save the result where needed. */
async function settle(remote, { tries = 3 } = {}) {
  // the server's features decide what a save may carry (the links): know them first
  const no = await guard();
  if (no) return no;
  const keepLinks = linksSaves();
  let s = readSession();
  let rem = remote;
  // the common ancestor for the three-way merge: the account as this device last synced it,
  // then (after a conflict) the account state this device just merged with
  let base = s?.data || null;
  for (let i = 0; i < tries && s; i++) {
    const local = readLocal();
    const m = mergeAccountData({ ...local, deleted: localDeleted(s, local) }, rem.data, base, { links: keepLinks });
    await writeLocal(m.local, local);
    let rev = rem.rev;
    let data = forServer(m.remote, keepLinks); // what the account holds after this (no links on a server without them)
    if (m.remoteChanged) {
      const delta = deltaSaves();
      // format: this app knows the playlist format of 2026-11 (2000 songs, ISRC, yearChecked ...): the
      // server lets only such an app overwrite playlists that need it (DATA_FORMAT in accounts.mjs)
      const body = delta ? { rev, data: forServer(deltaData(m.remote, rem.data), keepLinks), delta: true, format: DATA_FORMAT } : { rev, data: forServer(m.remote, keepLinks), format: DATA_FORMAT };
      lastSent = { at: Date.now(), bytes: JSON.stringify(body).length };
      const r = await authed('POST', '/account/data', body);
      if (!r.ok && r.code === 'conflict' && r.status === 409) {
        // another device saved in between: merge with that and try again
        const fresh = await authed('GET', '/account');
        if (!fresh.ok) return fresh;
        base = rem.data;
        rem = { rev: fresh.rev, data: fresh.data };
        continue;
      }
      if (!r.ok) return r;
      rev = r.rev;
      data = r.delta ? forServer(m.remote, keepLinks) : r.data;
    }
    s = readSession();
    if (!s) return { ok: false, code: 'loggedout', message: 'Je bent niet ingelogd.' };
    writeSession({ ...s, rev, data, synced: data.playlists.map((p) => p.id), at: Date.now() });
    state.lastSync = Date.now();
    state.error = null;
    emit({ type: 'sync', text: m.text, summary: m.summary });
    return { ok: true, text: m.text, summary: m.summary, rev };
  }
  return { ok: false, code: 'conflict', message: 'Je account werd steeds tegelijk op een ander toestel gewijzigd. Probeer het zo opnieuw.' };
}

/** Fetch the account and merge it with this device (app start, account screen). { ok, text, summary } */
export async function pull() {
  if (!readSession()) return { ok: false, code: 'loggedout', message: 'Je bent niet ingelogd.' };
  const no = await guard();
  if (no) return no;
  const r = await authed('GET', '/account');
  if (!r.ok) return r;
  return settle({ rev: r.rev, data: r.data });
}

/** Save this device's state to the account now (merging when another device saved in between). */
export async function push() {
  const s = readSession();
  if (!s) return { ok: false, code: 'loggedout', message: 'Je bent niet ingelogd.' };
  if (!s.data) return pull();
  return settle({ rev: s.rev, data: s.data });
}

// ---------- saving in the background ----------
let saveTimer = 0;
let retry = 0;
let saving = null;
let lastSent = { at: 0, bytes: 0 }; // the last save that went out (for saveGap)

/** Something changed on this device: save it a moment later (and again later when that fails). */
export function scheduleSave(delay = SAVE_DELAY_MS) {
  if (!readSession()) return;
  state.pending = true;
  clearTimeout(saveTimer);
  const wait = Math.max(delay, lastSent.at + saveGap(lastSent.bytes) - Date.now());
  saveTimer = setTimeout(() => { flush(); }, wait);
}

/** Save now when there is something to save. Resolves when done (or failed: then it is retried later). */
export async function flush() {
  clearTimeout(saveTimer);
  if (saving) return saving;
  if (!state.pending || !readSession()) return { ok: true };
  state.saving = true;
  state.pending = false;
  emit({ type: 'saving' });
  saving = push().then((r) => {
    state.saving = false;
    saving = null;
    if (r.ok) { retry = 0; emit({ type: 'saved', text: r.text }); return r; }
    if (r.code === 'loggedout' || r.code === 'session') return r;
    state.error = { code: r.code, message: r.message };
    emit({ type: 'error', code: r.code, message: r.message });
    if (['network', 'timeout', 'offline', 'conflict'].includes(r.code) || r.status >= 500 || r.status === 429) {
      state.pending = true;
      saveTimer = setTimeout(() => { flush(); }, RETRY_MS[Math.min(retry++, RETRY_MS.length - 1)]);
    }
    return r;
  });
  return saving;
}

let autoOff = null;
/**
 * Save changes by itself while logged in: playlists (playlists.js) and the Spotify Client ID
 * (spotify.js), and once more when the network comes back. Call once at app start (after
 * pull()). Returns a function that stops it.
 */
export async function startAutoSave() {
  if (autoOff) return autoOff;
  const offs = [];
  try { const pl = await import('./playlists.js'); offs.push(pl.subscribe(() => scheduleSave())); } catch { /* not here */ }
  try { const sp = await import('./spotify.js'); offs.push(sp.subscribe((reason) => { if (reason === 'settings') scheduleSave(); })); } catch { /* not here */ }
  const online = () => { if (state.pending) flush(); };
  globalThis.window?.addEventListener?.('online', online);
  offs.push(() => globalThis.window?.removeEventListener?.('online', online));
  autoOff = () => { for (const f of offs) f(); autoOff = null; };
  return autoOff;
}

// ---------- prepared rooms ----------
/** { ok, rooms: [room], max } — room: see prepareRoom. A room that expired has exists: false. */
export async function myRooms() {
  const no = await guard();
  return no || authed('GET', '/account/rooms');
}

/**
 * Set a room up in advance. opts: { name, settings: {game, win, size, goal, ...}, music:
 * 'deck' | 'mix' | <playlist id>, play: 'preview' | 'spotify', hostPlays, hostName }.
 * { ok, room: { code, name, settings, music, play, hostPlays, hostName, phase, players,
 * leaderOnline, createdAt, lastActive, expiresAt, exists } } or { ok: false, code ('limit', ...), message }.
 */
export async function prepareRoom(opts) {
  const no = await guard();
  return no || authed('POST', '/account/rooms', opts);
}

/** Change name / settings / music / play / hostPlays / hostName (game settings only between games). { ok, room } */
export const updateRoom = (code, patch) => authed('POST', `/account/rooms/${encodeURIComponent(code)}`, patch);
/** "Nog een keer gebruiken": players and game out, code and settings stay (a gone room comes back when its code is free). { ok, room, recreated? } */
export const resetRoom = (code) => authed('POST', `/account/rooms/${encodeURIComponent(code)}/reset`);
/** { ok } */
export const deleteRoom = (code) => authed('POST', `/account/rooms/${encodeURIComponent(code)}/delete`);

/**
 * Become the spelleider of a prepared room on this device. Stores the host identity the way
 * server-session.js keeps it (timetunesr.multiServerHost.v1) and the room's settings as the
 * lobby's settings, and selects the room's playlist as the active deck when it is on this
 * device. The host screen then calls createServerHostSession().resume().
 * { ok, code, room, music: { kind: 'deck' | 'mix' | 'playlist', id?, missing? }, play, hostPlays, hostName }
 */
export async function openRoom(code) {
  const r = await authed('POST', `/account/rooms/${encodeURIComponent(code)}/open`);
  if (!r.ok) return r;
  const b = store.get(BACKUP_KEY, null);
  if (b && b.code === r.code) store.remove(BACKUP_KEY); // a copy with the old owner token is of no use
  store.set(SERVER_HOST_KEY, { code: r.code, id: r.id, token: r.token });
  store.set(SETTINGS_KEY, r.room.settings);
  if (r.room.hostName) store.set(HOST_NAME_KEY, r.room.hostName);
  let music = { kind: r.room.music === 'mix' ? 'mix' : 'deck' };
  if (r.room.music !== 'mix' && r.room.music !== 'deck') {
    const lists = store.get(PLAYLISTS_KEY, null)?.lists || [];
    const here = lists.some((p) => p.id === r.room.music);
    music = { kind: 'playlist', id: r.room.music, missing: !here };
    if (here) {
      store.set(ACTIVE_DECK_KEY, r.room.music);
      try { (await import('./playlists.js')).reload(); } catch { /* not here */ }
    }
  } else if (r.room.music === 'deck') {
    store.set(ACTIVE_DECK_KEY, 'builtin');
  }
  return { ok: true, code: r.code, room: r.room, music, play: r.room.play, hostPlays: r.room.hostPlays, hostName: r.room.hostName };
}
