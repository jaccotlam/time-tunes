// Small account pieces that other screens show (start screen, Instellingen, playlists, the
// spelleider lobby), and the start-up wiring of the sync. Everything here reads the local
// session synchronously (account.current()), so no screen ever waits for the network to draw.
import * as account from '../account.js';
import { usesServer } from '../multi/server-session.js';
import { esc, toast, store } from '../ui.js';

const ico = (body) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
export const personIcon = ico('<circle cx="12" cy="8.5" r="3.8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4.5 20c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
export const cloudIcon = ico('<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.4 9.1 4.75 4.75 0 0 0 7 18.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>');
export const doorIcon = ico('<path d="M4 6.5V18a1.5 1.5 0 0 0 1.5 1.5H12M4 6.5A1.5 1.5 0 0 1 5.5 5H12M9 12h11M16.5 8.5 20 12l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');

/** Days a prepared room stays ready after its last use (server/room.mjs PREPARED_IDLE_MS). */
export const PREPARED_DAYS = 30;

let lastPull = null; // { ok, code, message, text, at } of the last pull this page did
let notice = null; // why this device was logged out by something else (shown once on #/account)
const listeners = new Set();
const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };

/** fn(ev) after anything account-related changed here (log in / out, a sync, saving, an error). */
export function onAccountChange(fn) {
  const own = () => fn({ type: 'local' });
  listeners.add(own);
  const off = account.subscribe(fn);
  return () => { listeners.delete(own); off(); };
}

/** fn() only when somebody logs in or out on this device (screens that just show a note). */
export function onLogInOut(fn) {
  return account.subscribe((ev) => { if (ev.type === 'login' || ev.type === 'logout') fn(ev); });
}

/**
 * App start: when somebody is logged in on this device, fetch the account and merge it, then
 * save changes by themselves. Never awaited by the app, so it starts at once and works offline
 * (a failed pull is shown on the account screen; saving retries when the network is back).
 */
export function initAccount() {
  account.subscribe(onEvent);
  if (!account.current()) return;
  syncNow().finally(() => { account.startAutoSave(); });
}

function onEvent(ev) {
  if (ev.type === 'login') { notice = null; account.startAutoSave(); }
  if (ev.type === 'logout' && ev.reason === 'session') {
    // the server no longer knows this device's session: the password changed elsewhere, or
    // "overal uitloggen" on another device. What is on this device stays.
    notice = { kind: 'session', message: 'Je bent op dit toestel uitgelogd: je wachtwoord is gewijzigd of je bent op een ander toestel overal uitgelogd. Je playlists blijven op dit toestel staan. Log opnieuw in om verder te gaan met je account.' };
    toast('Je bent uitgelogd. Log opnieuw in om je account te gebruiken.', { kind: 'warn', ms: 6000 });
    lastPull = null;
  }
}

/** Pull now (account screen, retry button). Remembers the outcome for the account screen. */
export async function syncNow() {
  const r = await account.pull();
  lastPull = { ...r, at: Date.now() };
  emit();
  return r;
}
export const lastSync = () => lastPull;

/** A message about a logout that this device did not ask for (once). */
export function takeNotice() { const n = notice; notice = null; return n; }
export function setNotice(n) { notice = n; }

/** The account's data as this device last saw it (after the last sync), or null. */
export function accountData() {
  const s = store.get(account.ACCOUNT_KEY, null);
  return s && typeof s === 'object' ? s.data || null : null;
}

/** Can accounts be offered at all on this device (a room server is set)? Sync, no network. */
export const accountsPossible = () => !!account.current() || usesServer();

/* ---------- pieces for other screens ---------- */

/** Start screen: "Inloggen" or "Ingelogd als …" (with Mijn kamers). */
export function accountChipHtml() {
  const me = account.current();
  if (!me && !usesServer()) return '';
  if (me) {
    return `<a class="acct-bar is-in" href="#/account" data-testid="start-account" data-state="in">
      <span class="acct-avatar" aria-hidden="true">${esc(initial(me.username))}</span>
      <span class="acct-bar-text"><b>Ingelogd als <span data-testid="start-account-name">${esc(me.username)}</span></b><small>Je account en Mijn kamers</small></span>
      <span class="acct-bar-go" aria-hidden="true">›</span></a>`;
  }
  return `<a class="acct-bar" href="#/account" data-testid="start-account" data-state="out">
    <span class="acct-avatar is-out" aria-hidden="true">${personIcon}</span>
    <span class="acct-bar-text"><b>Inloggen</b><small>Je playlists, Spotify en klaargezette kamers op elk toestel</small></span>
    <span class="acct-bar-go" aria-hidden="true">›</span></a>`;
}

export const initial = (name) => ([...String(name || '').trim()][0] || '?').toUpperCase();

/**
 * One line in the playlists screens and the Spotify setup: logged in, it says this is kept in
 * the account; logged out, one gentle hint (not a nag) that an account keeps it on every device.
 */
export function accountNoteHtml(kind) {
  const me = account.current();
  const what = kind === 'spotify' ? 'je Spotify Client ID' : 'je playlists';
  if (me) {
    const text = kind === 'spotify'
      ? 'Je Client ID wordt bewaard in je account: op een ander toestel log je in en hij staat er al.'
      : 'Je playlists worden bewaard in je account: log op een ander toestel in en ze staan er ook.';
    return `<p class="acct-note is-in" data-testid="account-note" data-state="in">${cloudIcon}<span>${text} <span class="muted">(${esc(me.username)})</span></span></p>`;
  }
  if (!usesServer()) return '';
  return `<p class="acct-note" data-testid="account-note" data-state="out">${cloudIcon}<span>Met een <a href="#/account" data-testid="account-note-link">account</a> staat ${what} op elk toestel.</span></p>`;
}

/** Instellingen: a card with the account (one line and a button). */
export function settingsAccountHtml() {
  const me = account.current();
  if (!me && !usesServer()) return '';
  return `<section class="set-card acct-set" aria-labelledby="set-account" data-testid="settings-account" data-state="${me ? 'in' : 'out'}">
    <h2 id="set-account">${personIcon}<span>Account</span></h2>
    ${me ? `<p>Ingelogd als <b data-testid="settings-account-name">${esc(me.username)}</b>. Je playlists, je Spotify Client ID en je klaargezette kamers staan in je account.</p>
      <a class="btn btn-ghost" href="#/account" data-testid="settings-account-link">${personIcon}<span>Naar je account</span></a>`
    : `<p>Log in om je playlists en je Spotify-instelling op elk toestel te hebben, en om een kamer van tevoren klaar te zetten. Zonder account werkt alles gewoon.</p>
      <a class="btn btn-ghost" href="#/account" data-testid="settings-account-link">${personIcon}<span>Inloggen of account maken</span></a>`}
  </section>`;
}

/** Spelleider, before the room is made: who is logged in, and the way to a prepared room. */
export function hostSetupAccountHtml() {
  const me = account.current();
  if (!me) return '';
  return `<p class="acct-host-setup" data-testid="host-account-setup">${personIcon}<span>Ingelogd als <b>${esc(me.username)}</b>. Een kamer die je van tevoren hebt klaargezet open je via <a href="#/account/kamers" data-testid="host-my-rooms">Mijn kamers</a>.</span></p>`;
}

/**
 * Spelleider lobby: a prepared room's name (it stays ready, emptying keeps the code) and the
 * "Ingelogd als …" marker. '' for a normal room of somebody who is not logged in.
 */
export function hostLobbyAccountHtml({ roomName = '' } = {}) {
  const me = account.current();
  const marker = me ? `<span class="acct-marker" data-testid="host-account-marker">${personIcon}<span>Ingelogd als <b>${esc(me.username)}</b></span></span>` : '';
  if (roomName) {
    return `<div class="prep-banner" data-testid="host-prepared">
      <p class="prep-banner-kicker">Klaargezette kamer</p>
      <p class="prep-banner-name" data-testid="host-room-name">${esc(roomName)}</p>
      <p class="prep-banner-text">Deze kamer blijft ${PREPARED_DAYS} dagen na het laatste gebruik klaarstaan, met dezelfde code. <b>Leegmaken</b> (rechtsboven) haalt iedereen eruit; de kamer blijft in Mijn kamers.</p>
      ${marker}
    </div>`;
  }
  return marker ? `<p class="acct-marker-row">${marker}</p>` : '';
}
