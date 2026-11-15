// The pure parts of "Spotify koppelen met je eigen Client ID" (no DOM, no storage), so they
// run in the browser and in node --test: the steps of the setup help, checking a pasted
// Client ID, the Redirect URIs to register, the link to share the setting with friends,
// and turning what Spotify answers into one clear thing to do.
//
// What real Spotify does (developer.spotify.com, checked November 2026):
// - the dashboard form "Create app" has "App name", "App description", "Website",
//   "Redirect URIs" (each added with "Add"), "Which API/SDKs are you planning to use?"
//   (tick "Web API") and the terms checkbox, then "Save"; the "Client ID" is on the app's
//   "Basic Information" page (under "Settings"), next to the "Client secret" (not needed).
// - Redirect URIs must match exactly; https, or http only for 127.0.0.1 / [::1], never localhost.
// - A wrong Client ID or an unregistered Redirect URI: Spotify shows its own error page
//   ("INVALID_CLIENT: Invalid client" / "INVALID_CLIENT: Invalid redirect URI") and does NOT
//   come back to the app. The app can only notice afterwards that the login never finished.
// - The user taps Cancel: back with ?error=access_denied.
// - Development Mode: at most 5 accounts, added under "User Management" (name + e-mail); others
//   can log in, but the Web API answers 403. The owner of the Spotify app needs Premium.
// - Playback needs Premium (403, reason PREMIUM_REQUIRED); no device: 404 NO_ACTIVE_DEVICE.

/** The wizard: five numbered steps ("stap 2 van 5"), with an intro before and "Klaar" after. */
export const STEPS = [
  { key: 'dashboard', title: 'Open het Spotify-dashboard' },
  { key: 'app', title: 'Maak een app' },
  { key: 'clientid', title: 'Plak je Client ID' },
  { key: 'users', title: 'Medespelers toevoegen', optional: true },
  { key: 'connect', title: 'Verbind en test' },
];
export const STEP_KEYS = STEPS.map((s) => s.key);
export const isStep = (k) => STEP_KEYS.includes(k);
export const stepNumber = (k) => STEP_KEYS.indexOf(k) + 1;
export const nextStep = (k) => STEP_KEYS[STEP_KEYS.indexOf(k) + 1] || 'done';
export const prevStep = (k) => (STEP_KEYS.indexOf(k) > 0 ? STEP_KEYS[STEP_KEYS.indexOf(k) - 1] : 'intro');

export const DASHBOARD_URL = 'https://developer.spotify.com/dashboard';
/** Ready-made values for the "Create app" form. */
export const APP_NAME = 'TimeTunesr';
export const APP_DESCRIPTION = 'Muziekspel voor feestjes met vrienden';

/* ---------- Client ID ---------- */

const HEX32 = /^[0-9a-f]{32}$/i;
export const looksLikeClientId = (v) => HEX32.test(String(v ?? ''));

/**
 * Clean up what the user pasted: spaces, line breaks, invisible characters and quotes go;
 * "Client ID 0123…" or a whole copied line still gives the ID when it holds exactly one.
 * Returns { value, ok, problem: null | 'empty' | 'short' | 'long' | 'chars', length }.
 */
export function cleanClientId(raw) {
  const s = String(raw ?? '');
  const compact = s.replace(/[\s​-‍⁠﻿"'`“”‘’<>]/g, '');
  if (HEX32.test(compact)) return { value: compact.toLowerCase(), ok: true, problem: null, length: 32 };
  const runs = s.match(/[0-9a-f]{32,}/gi) || [];
  const exact = runs.filter((r) => r.length === 32);
  if (exact.length === 1 && runs.length === 1) return { value: exact[0].toLowerCase(), ok: true, problem: null, length: 32 };
  if (!compact) return { value: '', ok: false, problem: 'empty', length: 0 };
  if (/[^0-9a-f]/i.test(compact)) return { value: compact, ok: false, problem: 'chars', length: compact.length };
  return { value: compact, ok: false, problem: compact.length < 32 ? 'short' : 'long', length: compact.length };
}

/** What to tell the user about a Client ID that is not right (null when it is fine). */
export function clientIdMessage(check) {
  switch (check?.problem) {
    case null: case undefined: return null;
    case 'empty': return 'Plak hier de Client ID uit je Spotify-app.';
    case 'short': return `Dit zijn ${check.length} tekens; een Client ID heeft er precies 32. Kopieer hem nog eens helemaal.`;
    case 'long': return `Dit zijn ${check.length} tekens; een Client ID heeft er precies 32. Heb je er iets bij gekopieerd?`;
    default: return 'Een Client ID bestaat alleen uit de cijfers 0-9 en de letters a-f (32 tekens). Heb je misschien iets anders gekopieerd?';
  }
}

/* ---------- Redirect URIs ---------- */

/**
 * The Redirect URIs to show: the address the app is open on first, then the other addresses
 * of this site (when the app runs on one of them). [{ uri, current }].
 */
export function redirectList(current, configured = []) {
  const norm = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return null; } };
  const cur = norm(current);
  const list = (Array.isArray(configured) ? configured : []).map(norm).filter(Boolean);
  if (!cur) return [];
  if (!list.includes(cur)) return [{ uri: cur, current: true }];
  return [cur, ...list.filter((u) => u !== cur)].filter((u, i, a) => a.indexOf(u) === i).map((uri) => ({ uri, current: uri === cur }));
}

/* ---------- sharing with the regular group ---------- */

export const SHARE_ROUTE = '#/spotify-delen/';
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

/** Link to give a friend this Spotify setting: <base>#/spotify-delen/<clientId>?van=<name>. */
export function shareLink(base, clientId, name = '') {
  if (!looksLikeClientId(clientId)) return null;
  const b = String(base || '').replace(/#.*$/, '');
  const n = cleanName(name);
  return `${b}${SHARE_ROUTE}${clientId.toLowerCase()}${n ? `?van=${encodeURIComponent(n)}` : ''}`;
}

/** Read a share link's hash ("#/spotify-delen/<id>?van=…"). Null when it is no valid one. */
export function parseShareHash(hash) {
  const m = String(hash || '').match(/^#\/spotify-delen\/([0-9a-fA-F]{32})\/?(?:\?(.*))?$/);
  if (!m) return null;
  let from = '';
  try { from = cleanName(new URLSearchParams(m[2] || '').get('van') || ''); } catch { from = ''; }
  return { clientId: m[1].toLowerCase(), from };
}

/* ---------- what Spotify answered -> one code ---------- */

const PREMIUM = /premium/i;
const OWNER = /owner|eigenaar/i;
const NOT_ALLOWED = /regist|developer\.spotify\.com|dashboard|user management|allow ?list|not.{0,20}allow|whitelist/i;

/** Spotify's redirect came back with ?error=… */
export function codeForCallback(error, description = '') {
  if (error === 'access_denied') return 'denied';
  if (/redirect/i.test(`${error} ${description}`)) return 'redirect';
  return 'client';
}

/** The token endpoint said no. phase: 'code' (just logged in) or 'refresh'. */
export function codeForToken(status, json = {}, phase = 'code') {
  const err = String(json?.error || '');
  const desc = String(json?.error_description || '');
  if (status === 429) return 'rate';
  if (status === 403) return PREMIUM.test(desc) ? (OWNER.test(desc) ? 'owner-premium' : 'premium') : 'not-allowed';
  if (status >= 500) return 'unavailable';
  if (/redirect/i.test(desc)) return 'redirect';
  if (err === 'invalid_grant') return 'session';
  if (err === 'invalid_client' && phase === 'refresh') return 'session';
  return 'client';
}

/** A Web API call failed (status, the parsed body or null, the raw text). where: '/me', '/me/player/play', … */
export function codeForApi(status, json, text = '', where = '') {
  const reason = String(json?.error?.reason || '');
  const msg = String(json?.error?.message || json?.error_description || text || '');
  if (status === 401) return 'session';
  if (status === 403) {
    if (reason === 'PREMIUM_REQUIRED' || PREMIUM.test(msg)) return OWNER.test(msg) ? 'owner-premium' : 'premium';
    if (NOT_ALLOWED.test(msg)) return 'not-allowed';
    if (where === '/me') return 'not-allowed'; // reading your own profile is never refused otherwise
    return 'forbidden';
  }
  if (status === 404 && (reason === 'NO_ACTIVE_DEVICE' || /device/i.test(msg))) return 'no-device';
  if (status === 429) return 'rate';
  return 'unavailable';
}

/* ---------- one code -> what the user does about it ---------- */

/**
 * For every failure: a title, one sentence with the thing to do, and the wizard step that
 * fixes it (null: nothing to fix in the setup). Unknown codes get the general explanation.
 */
export const EXPLAIN = {
  redirect: {
    title: 'Het adres van de app staat niet in je Spotify-app',
    text: 'Spotify laat je alleen inloggen op een adres dat precies zo bij “Redirect URIs” staat. Kopieer het adres in stap 2 opnieuw, voeg het toe met “Add” en tik op “Save”.',
    step: 'app', button: 'Naar stap 2: het adres',
  },
  client: {
    title: 'Spotify kent deze Client ID niet',
    text: 'Kijk of je de “Client ID” goed hebt geplakt (niet de “Client secret”) en of het adres van de app bij “Redirect URIs” staat.',
    step: 'clientid', button: 'Naar stap 3: de Client ID',
  },
  'not-allowed': {
    title: 'Dit Spotify-account mag (nog) niet meedoen',
    text: 'Je Spotify-app laat alleen accounts toe die erin staan onder “User Management” (maximaal 5). Log in met het account waarmee je de app maakte, of voeg dit account daar toe.',
    step: 'users', button: 'Naar stap 4: accounts toevoegen',
  },
  premium: {
    title: 'Spotify Premium nodig',
    text: 'Hele nummers afspelen via TimeTunesr kan alleen met Spotify Premium. Zonder Premium speel je gewoon met de fragmenten van 30 seconden.',
    step: null,
  },
  'owner-premium': {
    title: 'De maker van de Spotify-app heeft geen Premium',
    text: 'Spotify werkt alleen als het account waarmee de Spotify-app is gemaakt Premium heeft. Neem Premium op dat account, of laat iemand met Premium de app maken.',
    step: null,
  },
  denied: {
    title: 'Je hebt geen toestemming gegeven',
    text: 'Er is niets gekoppeld. Probeer het opnieuw en tik bij Spotify op “Akkoord” (Agree).',
    step: 'connect', button: 'Opnieuw inloggen',
  },
  session: {
    title: 'Je Spotify-sessie is verlopen',
    text: 'Log opnieuw in. Je Client ID en je andere instellingen blijven bewaard.',
    step: 'connect', button: 'Opnieuw inloggen',
  },
  state: {
    title: 'Inloggen is niet goed afgerond',
    text: 'De terugkeer van Spotify klopte niet (bijvoorbeeld een oude of dubbele poging). Probeer het nog een keer.',
    step: 'connect', button: 'Opnieuw inloggen',
  },
  'no-device': {
    title: 'Geen Spotify-apparaat gevonden',
    text: 'Open de Spotify-app op deze telefoon, start even een nummer en kom terug. Of kies een speaker met Spotify.',
    step: 'connect', button: 'Zoek opnieuw',
  },
  rate: {
    title: 'Spotify krijgt even te veel verzoeken',
    text: 'Wacht een minuutje en probeer het opnieuw.',
    step: 'connect', button: 'Probeer opnieuw',
  },
  offline: {
    title: 'Geen verbinding met Spotify',
    text: 'Controleer je internetverbinding en probeer het opnieuw.',
    step: 'connect', button: 'Probeer opnieuw',
  },
  unknown: {
    title: 'Er ging iets mis bij Spotify',
    text: 'Probeer het opnieuw. Lukt het niet, kopieer dan de foutdetails en stuur ze naar wie je helpt.',
    step: 'connect', button: 'Probeer opnieuw',
  },
};
export const explain = (code) => EXPLAIN[code] || EXPLAIN.unknown;

/** Plain text for "Kopieer foutdetails": no tokens, no names. */
export function errorDetails({ code, detail, appVersion, redirectUri, clientId, userAgent, at } = {}) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const lines = [
    'TimeTunesr – Spotify-foutdetails',
    `Tijd: ${new Date(at || Date.now()).toISOString()}`,
    `Fout: ${code || 'onbekend'}`,
    d.where ? `Bij: ${d.where}` : '',
    d.status ? `HTTP-status: ${d.status}` : '',
    d.reason ? `Reden: ${d.reason}` : '',
    d.message ? `Melding van Spotify: ${String(d.message).slice(0, 300)}` : '',
    redirectUri ? `Redirect URI: ${redirectUri}` : '',
    clientId ? `Client ID: ${String(clientId).slice(0, 6)}…${String(clientId).slice(-4)}` : 'Client ID: (geen)',
    appVersion ? `App: ${appVersion}` : '',
    userAgent ? `Browser: ${userAgent}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
