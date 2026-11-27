// Spotify connection: PKCE login, tokens, devices and remote playback through the
// Web API on one of the user's Spotify Connect devices (needs Spotify Premium).
// Nothing from Spotify (title, artist, cover) is ever shown: the player stays hidden.
import { SPOTIFY_CLIENT_ID } from '../config.js';
import { store, toast } from './ui.js';
import * as pkce from './pkce.js';
import { bestMatch, searchQueries, isSpotifyId } from './spotify-match.js';
import { codeForApi, codeForToken, codeForCallback, looksLikeClientId as isClientId } from './spotify-setup.js';

const API = 'https://api.spotify.com/v1';
export const SCOPES = 'user-read-playback-state user-modify-playback-state';
/** Extra scopes to read the user's own (and collaborative) playlists, asked for only when importing. */
export const PLAYLIST_SCOPES = 'playlist-read-private playlist-read-collaborative';
/** Extra scope to read the user's most played songs (GET /me/top/tracks), asked for only when needed. */
export const TOP_SCOPES = 'user-top-read';
const MARKET = 'NL'; // with a user token Spotify uses the user's own country instead
const NO_MATCH_RETRY_MS = 3 * 24 * 3600 * 1000;
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

const K = {
  settings: 'timetunesr.settings.v1',
  clientId: 'timetunesr.spotify.clientId.v1',
  token: 'timetunesr.spotify.token.v1',
  pending: 'timetunesr.spotify.pending.v1',
  device: 'timetunesr.spotify.device.v1',
  profile: 'timetunesr.spotify.profile.v1',
  matches: 'timetunesr.spotify.matches.v1',
  extraScopes: 'timetunesr.spotify.playlistScopes.v1',
  topScopes: 'timetunesr.spotify.topScopes.v1',
  setup: 'timetunesr.spotify.setup.v1',
};

/**
 * Scopes to ask for: playback, plus playlist reading once the player wanted to import a
 * playlist, plus top songs once the player wanted to use those (each asked for only then).
 */
const wantedScopes = () => [
  SCOPES,
  store.get(K.extraScopes, false) === true ? PLAYLIST_SCOPES : '',
  store.get(K.topScopes, false) === true ? TOP_SCOPES : '',
].filter(Boolean).join(' ');

/** Does the current token carry all of these (space-separated) scopes? */
export function hasScopes(scopes) {
  const have = new Set(String(readToken()?.scope || '').split(/\s+/));
  return String(scopes).split(/\s+/).filter(Boolean).every((x) => have.has(x));
}

/* ---------- settings ---------- */

export const LIMITS = [30, 60, 0]; // seconds; 0 = whole song
export const DEFAULT_LIMIT = 60;

export function getSettings() {
  const s = store.get(K.settings, {}) || {};
  return {
    source: s.source === 'spotify' ? 'spotify' : 'preview',
    limit: LIMITS.includes(s.limit) ? s.limit : DEFAULT_LIMIT,
  };
}

export function setSettings(patch) {
  store.set(K.settings, { ...getSettings(), ...patch });
  emit('settings');
}

export function getClientId() {
  const own = store.get(K.clientId, '');
  return (typeof own === 'string' && own.trim()) || SPOTIFY_CLIENT_ID || '';
}
export const defaultClientId = () => SPOTIFY_CLIENT_ID || '';

/** Save a Client ID typed by the user; empty (or the default) falls back to config.js. */
export function setClientId(value) {
  const v = String(value || '').trim();
  const prev = getClientId();
  if (!v || v === SPOTIFY_CLIENT_ID) store.remove(K.clientId);
  else store.set(K.clientId, v);
  const tokenApp = readToken()?.clientId || prev;
  if (isConnected() && tokenApp !== getClientId()) disconnect({ quiet: true }); // tokens belong to one app
  emit('settings');
}

export const looksLikeClientId = (v) => isClientId(String(v || '').trim());

/** The Client ID the current login belongs to (own, config.js or a room's), or null. */
export const connectedClientId = () => readToken()?.clientId || null;

/* ---------- the setup help (wizard) ---------- */

/**
 * Where the step-by-step help is: { step, mode: 'own' | 'shared', from?, testOk?, at } or null
 * (not started / finished). Kept in localStorage so it can be interrupted and resumed, also
 * across the Spotify login.
 */
export function getSetup() {
  const s = store.get(K.setup, null);
  return s && typeof s.step === 'string' ? s : null;
}
export function setSetup(patch) {
  if (patch === null) store.remove(K.setup);
  else store.set(K.setup, { mode: 'own', ...(getSetup() || {}), ...patch, at: Date.now() });
  emit('setup');
}

/**
 * A login that was started but never came back: Spotify's own error page for a wrong Client ID
 * or Redirect URI does not return to the app (or the user went back). { clientId, redirectUri, at } or null.
 */
export function unfinishedLogin() {
  if (status.busy) return null;
  const p = store.get(K.pending, null);
  if (!p || typeof p.at !== 'number' || Date.now() - p.at > PENDING_MAX_AGE_MS) return null;
  return { clientId: p.clientId || '', redirectUri: p.redirectUri || '', at: p.at };
}
export function clearUnfinishedLogin() {
  store.remove(K.pending);
  emit('status');
}

export function redirectUri() {
  return pkce.redirectUriFor(location.href);
}

/** Why connecting cannot work on this address: null | 'localhost' | 'insecure'. */
export function environmentProblem() {
  const p = pkce.redirectProblem(location.href);
  if (p) return p;
  if (!globalThis.crypto?.subtle) return 'insecure';
  return null;
}

/* ---------- status + events ---------- */

// busy: 'connecting' | null; error: code of the last failure; detail: what Spotify said (for "Kopieer foutdetails")
const status = { busy: null, error: null, detail: null };
const listeners = new Set();

function emit(reason) {
  for (const fn of listeners) {
    try { fn(reason); } catch (e) { console.error(e); }
  }
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getStatus() {
  return {
    connected: isConnected(),
    busy: status.busy,
    error: status.error,
    detail: status.detail,
    profile: store.get(K.profile, null),
    device: getDevice(),
  };
}
export function clearError() { status.error = null; status.detail = null; emit('status'); }

// Back from Spotify's own error page with the browser's back button: the page can come back
// from the back/forward cache with "connecting…" still on. That login is not running any more.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && status.busy === 'connecting') { status.busy = null; emit('status'); }
  });
}

/* ---------- errors ---------- */

export class SpotifyError extends Error {
  constructor(code, extra = {}) {
    super(MESSAGES[code] || code);
    this.name = 'SpotifyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const MESSAGES = {
  'no-client': 'Er is nog geen Spotify Client ID ingevuld.',
  localhost: 'Spotify accepteert “localhost” niet als terugkeeradres. Open de app via 127.0.0.1.',
  insecure: 'Inloggen bij Spotify kan alleen via een beveiligd adres (https).',
  state: 'De terugkeer van Spotify klopte niet (de beveiligingscode wijkt af). Probeer opnieuw te verbinden.',
  denied: 'Je hebt bij Spotify geen toestemming gegeven. Er is niets gekoppeld.',
  client: 'Spotify kent deze Client ID of Redirect-URI niet. Controleer beide in het Spotify-dashboard.',
  session: 'Je Spotify-sessie is verlopen of ingetrokken. Verbind opnieuw via Instellingen.',
  premium: 'Voor hele nummers via Spotify is Spotify Premium nodig.',
  'not-allowed': 'Dit Spotify-account is niet toegelaten in deze Spotify-app. Wie de app maakte, moet het toevoegen onder User Management in het Spotify-dashboard (maximaal 5 accounts).',
  forbidden: 'Spotify weigert deze opdracht. Kies eventueel een ander apparaat.',
  'no-device': 'Geen Spotify-apparaat gevonden. Open de Spotify-app op dit toestel, start even een nummer en kom terug.',
  redirect: 'Spotify kent het adres van deze app niet: zet het precies zo bij “Redirect URIs” in je Spotify-app.',
  'owner-premium': 'De Spotify-app werkt alleen als het account waarmee hij gemaakt is Spotify Premium heeft.',
  rate: 'Spotify krijgt even te veel verzoeken. Wacht een momentje en probeer het opnieuw.',
  offline: 'Geen internetverbinding met Spotify.',
  'no-match': 'Dit nummer is niet gevonden op Spotify.',
  unavailable: 'Spotify reageert nu niet goed. Probeer het later opnieuw.',
  'not-connected': 'Spotify is niet verbonden.',
};
export const errorMessage = (err) => MESSAGES[err?.code || err] || MESSAGES.unavailable;

const offlineError = () => new SpotifyError('offline');

/* ---------- tokens ---------- */

function readToken() {
  const t = store.get(K.token, null);
  return t && typeof t.access_token === 'string' ? t : null;
}
export const isConnected = () => !!readToken();

function saveToken(json, prev) {
  store.set(K.token, {
    access_token: json.access_token,
    refresh_token: json.refresh_token || prev?.refresh_token || null,
    expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || prev?.scope || wantedScopes(),
    clientId: prev?.clientId || getClientId(),
  });
}

async function tokenRequest(body, phase = 'code') {
  let res;
  try {
    res = await fetch(pkce.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
    });
  } catch { throw offlineError(); }
  let json = {};
  try { json = await res.json(); } catch { /* not json */ }
  if (res.ok && json.access_token) return json;
  throw new SpotifyError(codeForToken(res.status, json, phase), { // invalid_client, redirect mismatch, ...
    retryAfter: Number(res.headers.get('Retry-After')) || null,
    detail: { where: 'token', status: res.status, message: [json.error, json.error_description].filter(Boolean).join(': ') },
  });
}

let refreshing = null;
async function refresh() {
  const t = readToken();
  if (!t?.refresh_token) { dropSession('session'); throw new SpotifyError('session'); }
  if (!refreshing) {
    refreshing = tokenRequest(pkce.refreshRequestBody({ clientId: t.clientId || getClientId(), refreshToken: t.refresh_token }), 'refresh')
      .then((json) => { saveToken(json, t); })
      .catch((e) => {
        const code = ['client', 'redirect'].includes(e.code) ? 'session' : e.code;
        if (['session', 'not-allowed', 'owner-premium'].includes(code)) dropSession(code, e.detail);
        throw code === e.code ? e : new SpotifyError('session', { detail: e.detail });
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function accessToken() {
  const t = readToken();
  if (!t) throw new SpotifyError('not-connected');
  if (!t.expires_at || t.expires_at - 60_000 < Date.now()) {
    await refresh();
    return readToken().access_token;
  }
  return t.access_token;
}

function dropSession(code, detail = null) {
  store.remove(K.token);
  store.remove(K.profile);
  status.error = code || null;
  status.detail = detail;
  emit('disconnected');
}

/* ---------- Web API ---------- */

/** Call the Web API with automatic token refresh (once) on 401. */
export async function api(path, { method = 'GET', query, body, keepalive = false, retried = false } = {}) {
  const token = await accessToken();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      keepalive,
    });
  } catch { throw offlineError(); }
  if (res.status === 401 && !retried) {
    // another request may have refreshed meanwhile: then just retry with the new token
    if (readToken()?.access_token === token) await refresh();
    return api(path, { method, query, body, keepalive, retried: true });
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (res.ok) return json;

  const detail = {
    where: `${method} ${path}`, status: res.status, reason: String(json?.error?.reason || ''),
    message: String(json?.error?.message || json?.error_description || text || '').slice(0, 300),
  };
  const code = codeForApi(res.status, json, text, path);
  if (code === 'session') { dropSession('session', detail); throw new SpotifyError('session', { detail }); }
  throw new SpotifyError(code, { status: res.status, detail, retryAfter: code === 'rate' ? Number(res.headers.get('Retry-After')) || null : null });
}

/* ---------- login ---------- */

/** Start the PKCE login; the browser leaves for accounts.spotify.com. */
export async function connect(returnHash = location.hash || '#/', { playlists = false, top = false, clientId: borrowed = '' } = {}) {
  // borrowed: a room's Client ID (the spelleider's), used when this phone has none of its own
  const clientId = getClientId() || (isClientId(borrowed) ? borrowed : '');
  if (!clientId) throw new SpotifyError('no-client');
  const problem = environmentProblem();
  if (problem) throw new SpotifyError(problem);
  if (playlists) store.set(K.extraScopes, true);
  if (top) store.set(K.topScopes, true);
  const verifier = pkce.randomString(64);
  const state = pkce.randomString(32);
  const challenge = await pkce.codeChallenge(verifier);
  const uri = redirectUri();
  store.set(K.pending, { state, verifier, clientId, redirectUri: uri, returnHash, at: Date.now() });
  status.busy = 'connecting';
  status.error = null;
  status.detail = null;
  emit('status');
  location.assign(pkce.authorizeUrl({ clientId, redirectUri: uri, state, challenge, scope: wantedScopes() }));
}

/**
 * Handle Spotify's redirect back (?code=..&state=.. before the hash). Call once at
 * start-up, before routing: it cleans the URL synchronously (history.replaceState)
 * and returns a promise for the token exchange, or null when this is no callback.
 */
export function handleRedirect() {
  const cb = pkce.parseCallback(location.search);
  if (!cb) return null;
  const pending = store.get(K.pending, null);
  store.remove(K.pending);

  const params = new URLSearchParams(location.search);
  ['code', 'state', 'error', 'error_description'].forEach((k) => params.delete(k));
  const rest = params.toString();
  const back = (pending && typeof pending.returnHash === 'string' && pending.returnHash.startsWith('#'))
    ? pending.returnHash : '#/instellingen';
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${back}`);

  const fail = (code, detail = null) => {
    status.busy = null;
    status.error = code;
    status.detail = detail;
    emit('status'); // the settings screen shows the message
    if (!back.startsWith('#/instellingen')) toast(errorMessage(code), { kind: 'warn', ms: 6000 });
    return Promise.resolve(false);
  };
  if (!pending || pending.state !== cb.state || Date.now() - (pending.at || 0) > PENDING_MAX_AGE_MS) return fail('state');
  if (cb.error) {
    const desc = new URLSearchParams(location.search).get('error_description') || '';
    return fail(codeForCallback(cb.error, desc), { where: 'authorize', message: [cb.error, desc].filter(Boolean).join(': ') });
  }

  status.busy = 'connecting';
  status.error = null;
  emit('status');
  return tokenRequest(pkce.tokenRequestBody({
    clientId: pending.clientId, code: cb.code, redirectUri: pending.redirectUri, verifier: pending.verifier,
  }))
    .then(async (json) => {
      saveToken(json, { clientId: pending.clientId });
      await loadProfile();
      status.busy = null;
      emit('connected');
      toast('Verbonden met Spotify', { ms: 2600 });
      return true;
    })
    .catch((e) => {
      if (isConnected()) dropSession(e.code, e.detail); // e.g. token fine, but the account is not allowed
      return fail(e.code || 'unavailable', e.detail || null);
    });
}

async function loadProfile() {
  try {
    const me = await api('/me');
    store.set(K.profile, { name: me?.display_name || me?.id || null, product: me?.product || null });
  } catch (e) {
    // A Development-Mode app answers 403 for accounts that are not on its User Management list
    // (and for everybody when the owner of the Spotify app has no Premium).
    if (['not-allowed', 'owner-premium'].includes(e.code)) throw e;
  }
}

/** Forget tokens (and the chosen device); the Spotify app permission stays until revoked at Spotify. */
export function disconnect({ quiet = false } = {}) {
  store.remove(K.token);
  store.remove(K.profile);
  store.remove(K.device);
  status.error = null;
  status.detail = null;
  status.busy = null;
  emit('disconnected');
  if (!quiet) toast('Verbinding met Spotify verbroken', { ms: 2400 });
}

/* ---------- devices ---------- */

export function getDevice() {
  const d = store.get(K.device, null);
  return d && typeof d.id === 'string' ? d : null;
}
export function setDevice(d) {
  if (d) store.set(K.device, { id: d.id, name: d.name || 'Spotify-apparaat', type: d.type || '' });
  else store.remove(K.device);
  emit('device');
}

/** Controllable Spotify Connect devices: [{ id, name, type, active }]. */
export async function getDevices() {
  const j = await api('/me/player/devices');
  return (j?.devices || [])
    .filter((d) => d && d.id && !d.is_restricted)
    .map((d) => ({ id: d.id, name: d.name || 'Spotify-apparaat', type: d.type || '', active: !!d.is_active }));
}

const chooseDevice = (list, preferId) =>
  list.find((d) => d.id === preferId) || list.find((d) => d.active) || (list.length === 1 ? list[0] : null);

/* ---------- playback ---------- */

/**
 * Play one track on the chosen (or active) device from `positionMs`.
 * Throws SpotifyError('no-device', { devices }) when no device can be used.
 * Resolves with the device that plays.
 */
export async function play(uri, positionMs = 0) {
  const body = { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) };
  let device = getDevice();
  if (!device) {
    const list = await getDevices();
    device = chooseDevice(list, null);
    if (!device) throw new SpotifyError('no-device', { devices: list });
    setDevice(device);
  }
  try {
    await api('/me/player/play', { method: 'PUT', query: { device_id: device.id }, body });
    return device;
  } catch (e) {
    if (e.code !== 'no-device') throw e;
  }
  // The device was asleep or is gone: look again, wake it with a transfer, retry once.
  const list = await getDevices();
  const again = chooseDevice(list, device.id);
  if (!again) throw new SpotifyError('no-device', { devices: list });
  try { await transfer(again.id); } catch { /* the play call below decides */ }
  setDevice(again);
  try {
    await api('/me/player/play', { method: 'PUT', query: { device_id: again.id }, body });
  } catch (e) {
    if (e.code === 'no-device') throw new SpotifyError('no-device', { devices: list });
    throw e;
  }
  return again;
}

export function transfer(deviceId, playNow = false) {
  return api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play: playNow } });
}

export function pause({ keepalive = false } = {}) {
  const d = getDevice();
  return api('/me/player/pause', { method: 'PUT', query: d ? { device_id: d.id } : {}, keepalive });
}

export function seek(positionMs) {
  const d = getDevice();
  return api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(positionMs)), ...(d ? { device_id: d.id } : {}) } });
}

/**
 * The volume of the device that plays (or the chosen one): { volume, supports } or null.
 * `supports` is Spotify's supports_volume: only then may fade.js change it.
 */
export async function volumeInfo() {
  const j = await api('/me/player');
  let d = j?.device || null;
  if (!d) {
    const id = getDevice()?.id;
    const list = (await api('/me/player/devices'))?.devices || [];
    d = list.find((x) => x?.id === id) || list.find((x) => x?.is_active) || null;
  }
  if (!d) return null;
  const volume = Number(d.volume_percent);
  return { volume, supports: d.supports_volume !== false && Number.isFinite(volume) };
}

/** Set the device volume (0-100). Used for the fades of fade.js, which always puts the user's volume back. */
export function setVolume(percent, { keepalive = false } = {}) {
  const d = getDevice();
  const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return api('/me/player/volume', { method: 'PUT', query: { volume_percent: v, ...(d ? { device_id: d.id } : {}) }, keepalive });
}

/** Current playback: { isPlaying, progressMs, uri, durationMs, deviceId } or null. */
export async function playbackState() {
  const j = await api('/me/player');
  if (!j) return null;
  return {
    isPlaying: !!j.is_playing,
    progressMs: Number(j.progress_ms) || 0,
    uri: j.item?.uri || null,
    durationMs: Number(j.item?.duration_ms) || null,
    deviceId: j.device?.id || null,
  };
}

/* ---------- card -> track ---------- */

const cacheKey = (card) => String(card.itunesId ?? `${card.title}|${card.artist}`);

/**
 * The Spotify track for a card: { id, uri, durationMs } or null (no reliable match).
 * Uses card.spotifyId when present, else searches with the user's token and caches
 * the result per card id in localStorage.
 */
export async function resolveTrack(card, { wantDuration = false } = {}) {
  if (isSpotifyId(card.spotifyId)) {
    let durationMs = null;
    if (wantDuration) {
      try { durationMs = Number((await api(`/tracks/${card.spotifyId}`))?.duration_ms) || null; } catch { /* optional */ }
    }
    return { id: card.spotifyId, uri: `spotify:track:${card.spotifyId}`, durationMs };
  }
  const cache = store.get(K.matches, {}) || {};
  const hit = cache[card.id];
  if (hit && hit.k === cacheKey(card)) {
    if (isSpotifyId(hit.id)) return { id: hit.id, uri: `spotify:track:${hit.id}`, durationMs: hit.ms || null };
    if (hit.none && Date.now() - (hit.t || 0) < NO_MATCH_RETRY_MS) return null;
  }
  let match = null;
  for (const q of searchQueries(card)) {
    const j = await api('/search', { query: { q, type: 'track', limit: 10, market: MARKET } });
    match = bestMatch(card, j?.tracks?.items);
    if (match) break;
  }
  const fresh = store.get(K.matches, {}) || {};
  fresh[card.id] = match
    ? { k: cacheKey(card), id: match.id, ms: match.durationMs || 0, t: Date.now() }
    : { k: cacheKey(card), none: true, t: Date.now() };
  store.set(K.matches, fresh);
  return match ? { id: match.id, uri: match.uri, durationMs: match.durationMs } : null;
}

/** For the "Test het geluid" button: a neutral piece of music that is not in the deck. */
export async function findTestTrack() {
  const j = await api('/search', { query: { q: 'Für Elise Beethoven', type: 'track', limit: 1, market: MARKET } });
  const t = j?.tracks?.items?.[0];
  if (!t?.uri) throw new SpotifyError('unavailable');
  return t.uri;
}
