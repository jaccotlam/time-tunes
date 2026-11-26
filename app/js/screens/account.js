// Account (#/account, #/account/nieuw, #/account/vergeten): log in or make an account (with
// the one-time recovery code), recover a forgotten password with that code, and when logged in
// an overview: what is in the account, the saving state, Mijn kamers, change the password, log
// out (keep or remove the account's data on this device), log out everywhere, delete the
// account. Without a room server with accounts the screen explains that instead of showing
// forms; the rest of the app does not depend on any of this.
import * as account from '../account.js';
import { copyText } from '../multi/server-session.js';
import { icons, esc, toast } from '../ui.js';
import {
  syncNow, lastSync, takeNotice, setNotice, accountData, initial, personIcon, cloudIcon, doorIcon,
  onAccountChange,
} from './account-bits.js';

export const name = 'account';

const keyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const trashIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const roomIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20V8.5L12 4l8 4.5V20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="9" y="12" width="6" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dayFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
/** "vandaag om 14:32", "gisteren om 09:10", "3 dec. om 20:00". */
export function whenText(t) {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  const day = days === 0 ? 'vandaag' : days === 1 ? 'gisteren' : dayFmt.format(d);
  return `${day} om ${timeFmt.format(d)}`;
}

/** Which field an error of the server belongs to (so it is shown and announced right there). */
const FIELD_OF = { username: 'username', taken: 'username', bad: 'password', recover: 'code', password: 'password' };

/** What the overview shows right after a log-in that went through another route (recovery). */
let carry = null;

export function render(root, { params = [], navigate }) {
  let alive = true;
  let tab = params[0] === 'nieuw' ? 'signup' : 'login';
  const recoverMode = params[0] === 'vergeten';
  let avail = null; // result of account.available() (logged out only)
  let busy = false;
  let err = null; // { form, field, code, message }
  let fresh = null; // { code, kind: 'signup' | 'recover' } — the recovery code step
  let welcome = carry; // { kind, sync } shown on the overview right after logging in
  carry = null;
  let byeNote = takeNotice(); // a logout this device did not ask for, or what just happened
  let sheet = null; // 'logout' | 'everywhere' | 'delete'
  let sheetErr = null;
  let rooms = null; // { ok, rooms, max } for the overview
  let pulling = false;
  const vals = { username: '', password: '', code: '', newPassword: '' };

  const loggedIn = () => !!account.current();

  /* ---------- logged out ---------- */

  function pwField({ id, name: nm, label, auto, testid, hint = '', value = '' }) {
    const e = err && err.field === nm ? err : null;
    return `<div class="acct-field">
      <label for="${id}">${label}</label>
      <div class="acct-pw">
        <input id="${id}" type="password" name="${nm}" autocomplete="${auto}" minlength="8" maxlength="200" required value="${esc(value)}"
          data-testid="${testid}" ${e ? `aria-invalid="true" aria-describedby="${id}-err"` : hint ? `aria-describedby="${id}-hint"` : ''}>
        <button type="button" class="acct-eye" data-act="toggle-pw" data-for="${id}" aria-pressed="false" aria-label="Toon wachtwoord" data-testid="${testid}-toggle">${icons.eye}<span>Toon</span></button>
      </div>
      ${e ? `<p class="acct-err" id="${id}-err" data-testid="account-error" data-code="${esc(e.code)}" role="alert">${esc(e.message)}</p>` : hint ? `<p class="acct-hint" id="${id}-hint">${hint}</p>` : ''}
    </div>`;
  }

  function textField({ id, name: nm, label, auto, testid, hint = '', value = '', extra = '' }) {
    const e = err && err.field === nm ? err : null;
    return `<div class="acct-field">
      <label for="${id}">${label}</label>
      <input id="${id}" type="text" name="${nm}" autocomplete="${auto}" autocapitalize="none" spellcheck="false" required value="${esc(value)}" ${extra}
        data-testid="${testid}" ${e ? `aria-invalid="true" aria-describedby="${id}-err"` : hint ? `aria-describedby="${id}-hint"` : ''}>
      ${e ? `<p class="acct-err" id="${id}-err" data-testid="account-error" data-code="${esc(e.code)}" role="alert">${esc(e.message)}</p>` : hint ? `<p class="acct-hint" id="${id}-hint">${hint}</p>` : ''}
    </div>`;
  }

  /** An error that belongs to the whole form (wrong login, locked, no connection). */
  const formErr = (form) => (err && err.form === form && !err.field
    ? `<p class="acct-err acct-err-form" data-testid="account-error" data-code="${esc(err.code)}" role="alert">${esc(err.message)}</p>` : '');

  function serverWarn() {
    if (!avail || avail.ok || ['noserver', 'noaccounts'].includes(avail.code)) return '';
    return `<p class="warn small" data-testid="account-server-warn" role="status">De server is nu niet bereikbaar. Inloggen lukt zodra er weer verbinding is. <button type="button" class="linklike" data-act="recheck" data-testid="account-recheck">Opnieuw proberen</button></p>`;
  }

  function unavailableHtml() {
    const noserver = avail.code === 'noserver';
    return `<div class="panel acct-unavail" data-testid="account-unavailable" data-code="${esc(avail.code)}">
      <h2>${noserver ? 'Inloggen kan hier niet' : 'Deze server kent nog geen accounts'}</h2>
      <p>${esc(avail.message)}</p>
      <p class="muted">Een account is handig om je playlists, je Spotify-instelling en een klaargezette kamer op elk toestel te hebben. Zonder account werkt alles gewoon: je playlists en instellingen blijven op dit toestel.</p>
      <div class="stack"><a class="btn btn-primary" href="#/" data-testid="account-home">${icons.home}<span>Naar start</span></a></div>
    </div>`;
  }

  function authHtml() {
    if (avail && !avail.ok && ['noserver', 'noaccounts'].includes(avail.code)) return unavailableHtml();
    const login = tab === 'login';
    return `${byeNote ? `<p class="acct-notice" data-testid="account-notice" data-kind="${esc(byeNote.kind)}" role="status">${esc(byeNote.message)}</p>` : ''}
      <p class="lead acct-lead">Met een account staan je playlists, je Spotify-instelling en je klaargezette kamers op elk toestel waar je inlogt. Zonder account werkt alles gewoon.</p>
      ${serverWarn()}
      <div class="acct-tabs" role="tablist" aria-label="Inloggen of account maken">
        <button type="button" role="tab" id="acct-tab-login" class="acct-tab" aria-selected="${login}" aria-controls="acct-panel" data-act="tab" data-tab="login" data-testid="account-tab-login" ${login ? '' : 'tabindex="-1"'}>Inloggen</button>
        <button type="button" role="tab" id="acct-tab-signup" class="acct-tab" aria-selected="${!login}" aria-controls="acct-panel" data-act="tab" data-tab="signup" data-testid="account-tab-signup" ${login ? 'tabindex="-1"' : ''}>Account maken</button>
      </div>
      <div id="acct-panel" role="tabpanel" aria-labelledby="acct-tab-${tab}">
      ${login ? `<form class="acct-form" data-form="login" data-testid="account-login-form" method="post" action="#" novalidate>
          ${formErr('login')}
          ${textField({ id: 'acct-login-user', name: 'username', label: 'Gebruikersnaam', auto: 'username', testid: 'account-login-username', value: vals.username, extra: 'maxlength="24"' })}
          ${pwField({ id: 'acct-login-pw', name: 'password', label: 'Wachtwoord', auto: 'current-password', testid: 'account-login-password', value: vals.password })}
          <button class="btn btn-primary btn-xl" type="submit" data-testid="account-login-submit" ${busy ? 'disabled' : ''}>${doorIcon}<span>${busy ? 'Bezig met inloggen…' : 'Log in'}</span></button>
          <a class="acct-forgot" href="#/account/vergeten" data-testid="account-forgot">Wachtwoord vergeten?</a>
        </form>`
    : `<form class="acct-form" data-form="signup" data-testid="account-signup-form" method="post" action="#" novalidate>
          ${formErr('signup')}
          ${textField({ id: 'acct-signup-user', name: 'username', label: 'Kies een gebruikersnaam', auto: 'username', testid: 'account-signup-username', value: vals.username, hint: '3 tot 24 tekens: letters, cijfers, _ of -. Hoofdletters maken niet uit.', extra: 'maxlength="24"' })}
          ${pwField({ id: 'acct-signup-pw', name: 'password', label: 'Kies een wachtwoord', auto: 'new-password', testid: 'account-signup-password', hint: 'Minstens 8 tekens.', value: vals.password })}
          <button class="btn btn-primary btn-xl" type="submit" data-testid="account-signup-submit" ${busy ? 'disabled' : ''}>${personIcon}<span>${busy ? 'Account wordt gemaakt…' : 'Maak mijn account'}</span></button>
          <p class="small muted">Geen e-mailadres nodig. Je krijgt straks één <b>herstelcode</b>: daarmee zet je een vergeten wachtwoord opnieuw. Bewaar hem goed, er is geen andere manier.</p>
        </form>`}
      </div>`;
  }

  function recoverHtml() {
    if (avail && !avail.ok && ['noserver', 'noaccounts'].includes(avail.code)) return unavailableHtml();
    return `<p class="lead acct-lead">Wachtwoord vergeten? Met de herstelcode die je kreeg toen je je account maakte, kies je een nieuw wachtwoord.</p>
      ${serverWarn()}
      <form class="acct-form" data-form="recover" data-testid="account-recover-form" method="post" action="#" novalidate>
        ${formErr('recover')}
        ${textField({ id: 'acct-rec-user', name: 'username', label: 'Gebruikersnaam', auto: 'username', testid: 'account-recover-username', value: vals.username, extra: 'maxlength="24"' })}
        ${textField({ id: 'acct-rec-code', name: 'code', label: 'Herstelcode', auto: 'off', testid: 'account-recover-code', value: vals.code, hint: 'Vier groepjes van vier tekens, bv. ABCD-EFGH-JKLM-NPQR.', extra: 'maxlength="40" autocapitalize="characters"' })}
        ${pwField({ id: 'acct-rec-pw', name: 'newPassword', label: 'Nieuw wachtwoord', auto: 'new-password', testid: 'account-recover-password', hint: 'Minstens 8 tekens.', value: vals.newPassword })}
        <button class="btn btn-primary btn-xl" type="submit" data-testid="account-recover-submit" ${busy ? 'disabled' : ''}>${keyIcon}<span>${busy ? 'Bezig…' : 'Zet nieuw wachtwoord'}</span></button>
        <a class="acct-forgot" href="#/account" data-testid="account-back-login">Terug naar inloggen</a>
      </form>`;
  }

  /** The recovery code, once, on its own step. */
  function codeHtml() {
    const again = fresh.kind === 'recover';
    return `<div class="acct-code-step" data-testid="account-code-step" data-kind="${fresh.kind}">
      <span class="acct-code-mark" aria-hidden="true">${keyIcon}</span>
      <h2 id="acct-code-title">${again ? 'Je nieuwe herstelcode' : 'Bewaar je herstelcode'}</h2>
      <p>${again ? 'Je wachtwoord is gewijzigd. Je oude herstelcode werkt niet meer; dit is de nieuwe.' : 'Je account is gemaakt. Ben je je wachtwoord ooit kwijt, dan kom je alleen met deze code weer binnen.'} Hij wordt <b>maar één keer</b> getoond.</p>
      <p class="acct-code" data-testid="account-recovery-code" aria-label="Herstelcode ${esc([...fresh.code].join(' '))}">${esc(fresh.code)}</p>
      <button class="btn btn-secondary" type="button" data-act="copy-code" data-testid="account-copy-code">${icons.share}<span>Kopieer de code</span></button>
      <p class="small muted">Zet hem bijvoorbeeld in je wachtwoordmanager of maak er een foto van.</p>
      <button class="btn btn-primary btn-xl" type="button" data-act="code-saved" data-testid="account-code-saved">${icons.check}<span>Ik heb hem bewaard</span></button>
    </div>`;
  }

  /* ---------- logged in ---------- */

  function syncLines(sync) {
    if (!sync) return '';
    if (!sync.ok) return `<p class="acct-sync is-warn" data-testid="account-sync-summary" data-ok="false">Je account kon nog niet worden opgehaald: ${esc(sync.message || 'geen verbinding')}. Het wordt opnieuw geprobeerd.</p>`;
    const lines = sync.text?.length ? sync.text : ['Je account en dit toestel waren al gelijk.'];
    return `<div class="acct-sync" data-testid="account-sync-summary" data-ok="true" role="status">
      ${cloudIcon}<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  }

  /** What is in the account, and whether everything is saved. */
  function stateHtml() {
    const st = account.status();
    const d = accountData();
    const lp = lastSync();
    const lists = d?.playlists?.length ?? null;
    const sp = !!d?.spotifyClientId;
    let save;
    if (st.saving || pulling) save = `<p class="acct-save" data-testid="account-save-state" data-state="saving" role="status"><span class="acct-spin" aria-hidden="true"></span>${pulling ? 'Je account wordt opgehaald…' : 'Bezig met bewaren…'}</p>`;
    else if (st.error || (lp && !lp.ok && lp.code !== 'loggedout')) {
      const e = st.error || lp;
      save = `<div class="acct-save is-error" data-testid="account-save-state" data-state="error" role="alert">
        <p><b>${st.error ? 'Nog niet bewaard.' : 'Niet bijgewerkt.'}</b> ${esc(e.message || 'Geen verbinding met de server.')}</p>
        <button class="btn btn-small btn-ghost" type="button" data-act="retry" data-testid="account-retry">${icons.restart}<span>Opnieuw</span></button></div>`;
    } else if (st.pending) save = '<p class="acct-save" data-testid="account-save-state" data-state="pending" role="status">Wijzigingen worden zo bewaard…</p>';
    else save = `<p class="acct-save is-ok" data-testid="account-save-state" data-state="ok" role="status">${icons.check}<span>${st.lastSync ? `Alles bewaard, bijgewerkt ${esc(whenText(st.lastSync))}` : 'Alles bewaard'}</span></p>`;
    return `<ul class="acct-facts">
        <li data-testid="account-playlist-count" data-count="${lists ?? ''}">${icons.music}<span><b>${lists == null ? 'Playlists' : plural(lists, 'playlist', 'playlists')}</b>${lists == null ? ' nog niet opgehaald' : ''}</span><a href="#/playlists" class="acct-facts-go">Bekijk</a></li>
        <li data-testid="account-spotify-state" data-set="${sp}">${spotifyIcon}<span><b>Spotify Client ID</b> ${sp ? 'ingesteld' : 'nog niet ingesteld'}</span><a href="#/instellingen/spotify" class="acct-facts-go">${sp ? 'Bekijk' : 'Instellen'}</a></li>
      </ul>${save}`;
  }

  function roomsHtml() {
    if (!rooms) return '<p class="muted small" data-testid="account-rooms-count">Je kamers worden opgehaald…</p>';
    if (!rooms.ok) return `<p class="muted small" data-testid="account-rooms-count">${esc(rooms.message || 'Je kamers konden niet worden opgehaald.')}</p>`;
    const n = rooms.rooms.length;
    return `<p data-testid="account-rooms-count" data-count="${n}">${n ? `${plural(n, 'kamer', 'kamers')} klaargezet (van de ${rooms.max}): ${rooms.rooms.slice(0, 3).map((r) => `<b>${esc(r.name)}</b> <span class="acct-code-chip">${esc(r.code)}</span>`).join(', ')}${n > 3 ? ' …' : ''}`
      : `Zet een kamer dagen van tevoren klaar: naam, spel, muziek, de code en de QR-code liggen dan al vast. Op de dag zelf tik je op <b>Open</b>, op elk toestel.`}</p>`;
  }

  function overviewHtml() {
    const me = account.current();
    return `<div class="acct-overview" data-testid="account-overview">
      <div class="acct-who">
        <span class="acct-avatar acct-avatar-lg" aria-hidden="true">${esc(initial(me.username))}</span>
        <div><p class="acct-who-kicker">Ingelogd als</p><p class="acct-who-name" data-testid="account-name">${esc(me.username)}</p></div>
      </div>
      ${welcome ? syncLines(welcome.sync) : ''}
      <section class="set-card" aria-labelledby="acct-in-title">
        <h2 id="acct-in-title">${cloudIcon}<span>In je account</span></h2>
        <div data-slot="state">${stateHtml()}</div>
      </section>
      <section class="set-card acct-rooms-card" aria-labelledby="acct-rooms-title">
        <h2 id="acct-rooms-title">${roomIcon}<span>Mijn kamers</span></h2>
        <div data-slot="rooms">${roomsHtml()}</div>
        <div class="acct-row">
          <a class="btn btn-primary" href="#/account/kamers" data-testid="account-rooms-link">${roomIcon}<span>Mijn kamers</span></a>
          <a class="btn btn-ghost" href="#/account/kamers/nieuw" data-testid="account-prepare-link">${icons.plus}<span>Klaarzetten</span></a>
        </div>
      </section>
      <details class="set-card acct-details" data-testid="account-password-card">
        <summary><h2>${keyIcon}<span>Wachtwoord wijzigen</span></h2></summary>
        <form class="acct-form" data-form="password" data-testid="account-password-form" method="post" action="#" novalidate>
          <input type="text" name="username" autocomplete="username" value="${esc(me.username)}" hidden readonly>
          ${formErr('password')}
          ${pwField({ id: 'acct-pw-cur', name: 'password', label: 'Huidig wachtwoord', auto: 'current-password', testid: 'account-pw-current' })}
          ${pwField({ id: 'acct-pw-new', name: 'newPassword', label: 'Nieuw wachtwoord', auto: 'new-password', testid: 'account-pw-new', hint: 'Minstens 8 tekens. Op je andere toestellen word je daarna uitgelogd.' })}
          <button class="btn btn-primary" type="submit" data-testid="account-pw-submit" ${busy ? 'disabled' : ''}>${keyIcon}<span>Wijzig wachtwoord</span></button>
          <div data-slot="pw-msg"></div>
        </form>
      </details>
      <section class="set-card acct-out" aria-labelledby="acct-out-title">
        <h2 id="acct-out-title">${doorIcon}<span>Uitloggen</span></h2>
        <div class="acct-row">
          <button class="btn btn-ghost" type="button" data-act="sheet" data-sheet="logout" data-testid="account-logout">${doorIcon}<span>Log uit</span></button>
          <button class="btn btn-ghost" type="button" data-act="sheet" data-sheet="everywhere" data-testid="account-logout-all"><span>Log overal uit</span></button>
        </div>
        <p class="small muted">Overal uitloggen helpt als je ergens bent ingelogd op een toestel dat niet van jou is.</p>
        <button class="btn btn-small btn-ghost acct-danger" type="button" data-act="sheet" data-sheet="delete" data-testid="account-delete">${trashIcon}<span>Verwijder mijn account</span></button>
      </section>
    </div>`;
  }

  function keepChoiceHtml() {
    return `<fieldset class="acct-keep">
      <legend>Wat doen we met je playlists en je Spotify Client ID op dit toestel?</legend>
      <label class="choice"><input type="radio" name="keep" value="keep" checked data-testid="account-keep-data">
        <span><b>Laat ze op dit toestel staan</b><small>Handig als dit je eigen telefoon is.</small></span></label>
      <label class="choice"><input type="radio" name="keep" value="remove" data-testid="account-remove-data">
        <span><b>Haal ze van dit toestel af</b><small>Voor een toestel van een ander. ${sheet === 'delete' ? '' : 'In je account blijven ze bewaard.'}</small></span></label>
    </fieldset>`;
  }

  function sheetHtml() {
    if (!sheet) return '';
    const d = accountData();
    const lists = d?.playlists?.length || 0;
    const n = rooms?.ok ? rooms.rooms.length : null;
    const title = { logout: 'Uitloggen op dit toestel', everywhere: 'Overal uitloggen', delete: 'Account verwijderen' }[sheet];
    let body = '';
    if (sheet === 'logout') body = `<p>Je account blijft bestaan; je logt alleen hier uit.</p>${keepChoiceHtml()}`;
    if (sheet === 'everywhere') body = `<p>Je wordt op <b>alle toestellen</b> uitgelogd, ook hier. Daarna log je opnieuw in met je wachtwoord.</p>${keepChoiceHtml()}`;
    if (sheet === 'delete') {
      body = `<p>Dit kan niet ongedaan worden gemaakt. Weg gaan:</p>
        <ul class="acct-gone" data-testid="account-delete-what">
          <li>je account <b>${esc(account.current()?.username || '')}</b> en je wachtwoord;</li>
          <li>wat erin bewaard is: ${plural(lists, 'playlist', 'playlists')} en je Spotify Client ID;</li>
          <li>${n == null ? 'je klaargezette kamers' : plural(n, 'klaargezette kamer', 'klaargezette kamers')}: hun codes en links werken daarna niet meer.</li>
        </ul>
        ${keepChoiceHtml()}
        <form class="acct-form" data-form="delete" method="post" action="#" novalidate>
          <input type="text" name="username" autocomplete="username" value="${esc(account.current()?.username || '')}" hidden readonly>
          ${sheetErr ? `<p class="acct-err" data-testid="account-error" data-code="${esc(sheetErr.code)}" role="alert">${esc(sheetErr.message)}</p>` : ''}
          <div class="acct-field"><label for="acct-del-pw">Je wachtwoord, ter bevestiging</label>
            <div class="acct-pw"><input id="acct-del-pw" type="password" name="password" autocomplete="current-password" required data-testid="account-delete-password">
              <button type="button" class="acct-eye" data-act="toggle-pw" data-for="acct-del-pw" aria-pressed="false" aria-label="Toon wachtwoord" data-testid="account-delete-password-toggle">${icons.eye}<span>Toon</span></button></div></div>
        </form>`;
    } else if (sheetErr) body += `<p class="acct-err" data-testid="account-error" data-code="${esc(sheetErr.code)}" role="alert">${esc(sheetErr.message)}</p>`;
    const confirm = { logout: 'Log uit', everywhere: 'Log overal uit', delete: 'Verwijder mijn account' }[sheet];
    return `<div class="sheet-backdrop" data-act="sheet-close" data-testid="account-sheet" data-kind="${sheet}">
      <div class="sheet acct-sheet" role="dialog" aria-modal="true" aria-labelledby="acct-sheet-title">
        <h2 id="acct-sheet-title">${esc(title)}</h2>
        ${body}
        <button class="btn ${sheet === 'delete' ? 'btn-danger' : 'btn-primary'} btn-xl" type="button" data-act="sheet-confirm" data-testid="account-sheet-confirm" ${busy ? 'disabled' : ''}>${sheet === 'delete' ? trashIcon : doorIcon}<span>${busy ? 'Even geduld…' : confirm}</span></button>
        <button class="btn btn-ghost" type="button" data-act="sheet-close" data-testid="account-sheet-cancel">${icons.close}<span>Annuleer</span></button>
      </div>
    </div>`;
  }

  /* ---------- drawing ---------- */

  function draw({ focus = true } = {}) {
    if (!alive) return;
    let body;
    let title = 'Account';
    if (fresh) { body = codeHtml(); title = 'Herstelcode'; } else if (loggedIn()) body = overviewHtml();
    else if (recoverMode) { body = recoverHtml(); title = 'Wachtwoord vergeten'; } else body = authHtml();
    root.innerHTML = `<section class="screen screen-account" data-testid="screen-account" data-view="${fresh ? 'code' : loggedIn() ? 'overview' : recoverMode ? 'recover' : tab}">
      <header class="topbar">
        <a class="icon-btn" href="${recoverMode && !loggedIn() && !fresh ? '#/account' : '#/'}" aria-label="${recoverMode && !loggedIn() ? 'Terug naar inloggen' : 'Naar start'}" data-testid="back-home">${recoverMode && !loggedIn() ? icons.back : icons.home}</a>
        <h1 class="topbar-title">${title}</h1>
        <span class="topbar-spacer"></span>
      </header>
      ${body}
      <div data-slot="sheet">${sheetHtml()}</div>
    </section>`;
    if (focus) focusFirstProblem();
  }

  /** After an error: the field with the problem gets the focus (its message is announced). */
  function focusFirstProblem() {
    const bad = root.querySelector('[aria-invalid="true"]');
    if (bad) { bad.focus(); return; }
    const sheetEl = root.querySelector('.acct-sheet');
    if (sheetEl) { (sheetEl.querySelector('input:not([hidden])') || sheetEl.querySelector('button'))?.focus(); return; }
    if (fresh) { root.querySelector('[data-testid="account-copy-code"]')?.focus(); }
  }

  const slot = (k) => root.querySelector(`[data-slot="${k}"]`);
  function drawState() { const s = slot('state'); if (s) s.innerHTML = stateHtml(); }
  function drawRooms() { const s = slot('rooms'); if (s) s.innerHTML = roomsHtml(); }
  function drawSheet() {
    const s = slot('sheet');
    if (!s) return;
    s.innerHTML = sheetHtml();
    focusFirstProblem();
  }

  /* ---------- actions ---------- */

  async function checkAvailable(fresh2 = false) {
    avail = await account.available({ fresh: fresh2 });
    if (alive && !loggedIn() && !fresh) draw({ focus: false });
  }

  async function loadOverview() {
    pulling = true;
    drawState();
    const r = await syncNow();
    pulling = false;
    if (!alive) return;
    if (!loggedIn()) { draw(); return; } // the session ended on the server
    drawState();
    rooms = await account.myRooms();
    if (alive) { drawRooms(); if (sheet === 'delete') drawSheet(); }
    return r;
  }

  function readForm(f) {
    for (const k of Object.keys(vals)) if (f.elements[k]) vals[k] = f.elements[k].value;
  }

  function fail(form, r) {
    const field = FIELD_OF[r.code] || null;
    // a wrong current password while changing it belongs to the "current" field
    err = { form, field: form === 'recover' && r.code === 'bad' ? 'newPassword' : form === 'password' && r.code === 'bad' ? 'newPassword' : field, code: r.code, message: r.message || 'Dat lukte niet.' };
  }

  async function submitAuth(form) {
    const f = root.querySelector(`[data-form="${form}"]`);
    readForm(f);
    err = null;
    const u = vals.username.trim();
    if (!u) { err = { form, field: 'username', code: 'empty', message: 'Vul je gebruikersnaam in.' }; draw(); return; }
    if (form === 'recover' && !vals.code.trim()) { err = { form, field: 'code', code: 'empty', message: 'Vul je herstelcode in.' }; draw(); return; }
    const pw = form === 'recover' ? vals.newPassword : vals.password;
    if (!pw) { err = { form, field: form === 'recover' ? 'newPassword' : 'password', code: 'empty', message: 'Vul je wachtwoord in.' }; draw(); return; }
    if (form !== 'login' && pw.length < 8) { err = { form, field: form === 'recover' ? 'newPassword' : 'password', code: 'bad', message: 'Een wachtwoord heeft minstens 8 tekens.' }; draw(); return; }
    busy = true;
    draw({ focus: false });
    let r;
    if (form === 'login') r = await account.logIn(u, pw);
    else if (form === 'signup') r = await account.signUp(u, pw);
    else r = await account.recover(u, vals.code.trim(), pw);
    busy = false;
    if (!alive) return;
    if (!r.ok) {
      fail(form, r);
      if (['noserver', 'noaccounts'].includes(r.code)) avail = r;
      draw();
      return;
    }
    vals.password = ''; vals.newPassword = ''; vals.code = '';
    byeNote = null;
    welcome = { kind: form, sync: r.sync };
    if (r.recoveryCode) { fresh = { code: r.recoveryCode, kind: form === 'recover' ? 'recover' : 'signup' }; draw(); return; }
    toast(`Welkom terug, ${r.username}!`, { ms: 2200 });
    afterLogin();
  }

  function afterLogin() {
    fresh = null;
    if (recoverMode) { carry = welcome; navigate('#/account'); return; } // the overview on its own route
    draw();
    root.querySelector('h1')?.focus();
    rooms = null;
    account.myRooms().then((r) => { rooms = r; if (alive) drawRooms(); });
  }

  async function submitPassword() {
    const f = root.querySelector('[data-form="password"]');
    const cur = f.elements.password.value;
    const next = f.elements.newPassword.value;
    err = null;
    if (!cur) { err = { form: 'password', field: 'password', code: 'empty', message: 'Vul je huidige wachtwoord in.' }; } else if (next.length < 8) { err = { form: 'password', field: 'newPassword', code: 'bad', message: 'Een wachtwoord heeft minstens 8 tekens.' }; }
    if (err) { redrawPassword(cur, next); return; }
    busy = true;
    f.querySelector('[type="submit"]').disabled = true;
    const r = await account.changePassword(cur, next);
    busy = false;
    if (!alive) return;
    if (!r.ok) {
      if (!loggedIn()) { draw(); return; }
      err = { form: 'password', field: r.code === 'password' || r.code === 'login' ? 'password' : r.code === 'bad' ? 'newPassword' : null, code: r.code, message: r.message };
      redrawPassword(cur, next);
      return;
    }
    redrawPassword('', '');
    const n = r.revoked || 0;
    const msg = slot('pw-msg');
    if (msg) msg.innerHTML = (`<p class="acct-ok" data-testid="account-pw-msg" role="status">${icons.check}<span>Je wachtwoord is gewijzigd.${n ? ` Op ${plural(n, 'ander toestel', 'andere toestellen')} ben je nu uitgelogd.` : ''}</span></p>`);
  }

  /** Redraw only the password card (the rest of the overview stays as it is). */
  function redrawPassword(cur, next) {
    const card = root.querySelector('[data-testid="account-password-card"]');
    if (!card) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = overviewHtml();
    const fresh2 = tmp.querySelector('[data-testid="account-password-card"]');
    fresh2.open = true;
    card.replaceWith(fresh2);
    const f = fresh2.querySelector('form');
    f.elements.password.value = cur;
    f.elements.newPassword.value = next;
    err = null;
    (fresh2.querySelector('[aria-invalid="true"]') || null)?.focus();
  }

  async function confirmSheet() {
    const keepData = root.querySelector('input[name="keep"]:checked')?.value !== 'remove';
    sheetErr = null;
    if (sheet === 'delete') {
      const pw = root.querySelector('[data-testid="account-delete-password"]')?.value || '';
      if (!pw) { sheetErr = { code: 'empty', message: 'Vul je wachtwoord in om je account te verwijderen.' }; drawSheet(); restoreKeep(keepData); return; }
      busy = true; drawSheet(); restoreKeep(keepData);
      const r = await account.deleteAccount(pw, { keepData });
      busy = false;
      if (!alive) return;
      if (!r.ok) { sheetErr = { code: r.code, message: r.message }; drawSheet(); restoreKeep(keepData); return; }
      sheet = null;
      byeNote = { kind: 'deleted', message: `Je account is verwijderd${r.rooms ? `, met ${plural(r.rooms, 'klaargezette kamer', 'klaargezette kamers')}` : ''}. ${keepData ? 'Wat op dit toestel stond, staat er nog.' : 'Je playlists van het account zijn ook van dit toestel gehaald.'}` };
      welcome = null;
      draw();
      return;
    }
    busy = true; drawSheet(); restoreKeep(keepData);
    const r = sheet === 'everywhere' ? await account.logOutEverywhere({ keepData }) : await account.logOut({ keepData });
    busy = false;
    if (!alive) return;
    if (!r.ok) { sheetErr = { code: r.code, message: r.message }; drawSheet(); restoreKeep(keepData); return; }
    const all = sheet === 'everywhere';
    sheet = null;
    welcome = null;
    byeNote = { kind: all ? 'everywhere' : 'logout', message: `${all ? 'Je bent op al je toestellen uitgelogd.' : 'Je bent uitgelogd.'} ${keepData ? 'Je playlists en instellingen blijven op dit toestel staan.' : 'De playlists en de Spotify Client ID van je account zijn van dit toestel gehaald; in je account staan ze nog.'}` };
    tab = 'login';
    draw();
  }

  /** Keep the radio choice across a redraw of the sheet. */
  function restoreKeep(keep) {
    const r = root.querySelector(`input[name="keep"][value="${keep ? 'keep' : 'remove'}"]`);
    if (r) r.checked = true;
  }

  function onClick(e) {
    const a = e.target.closest('[data-act]');
    if (!a || !root.contains(a)) return;
    const act = a.dataset.act;
    switch (act) {
      case 'tab':
        if (tab === a.dataset.tab) return;
        readForm(root.querySelector('form'));
        tab = a.dataset.tab;
        err = null;
        draw({ focus: false });
        root.querySelector(`[data-testid="account-tab-${tab}"]`)?.focus();
        break;
      case 'toggle-pw': {
        const input = root.querySelector(`#${a.dataset.for}`);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        a.setAttribute('aria-pressed', String(show));
        a.setAttribute('aria-label', show ? 'Verberg wachtwoord' : 'Toon wachtwoord');
        a.querySelector('span').textContent = show ? 'Verberg' : 'Toon';
        break;
      }
      case 'recheck': checkAvailable(true); break;
      case 'copy-code':
        copyText(fresh?.code || '').then((ok) => toast(ok ? 'Herstelcode gekopieerd.' : 'Kopiëren lukte niet. Schrijf hem over.', { kind: ok ? 'info' : 'warn' }));
        break;
      case 'code-saved': afterLogin(); break;
      case 'retry':
        if (account.status().error) { account.scheduleSave(0); drawState(); } else loadOverview();
        break;
      case 'sheet':
        sheet = a.dataset.sheet;
        sheetErr = null;
        drawSheet();
        break;
      case 'sheet-close':
        if (a.classList.contains('sheet-backdrop') && e.target !== a) return;
        if (busy) return;
        sheet = null;
        drawSheet();
        root.querySelector('[data-testid="account-logout"]')?.focus();
        break;
      case 'sheet-confirm': confirmSheet(); break;
      default:
    }
  }

  function onSubmit(e) {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    if (busy) return;
    const form = f.dataset.form;
    if (form === 'password') submitPassword();
    else if (form === 'delete') confirmSheet();
    else submitAuth(form);
  }

  function onKey(e) {
    if (e.key === 'Escape' && sheet && !busy) { sheet = null; drawSheet(); return; }
    // arrow keys move between the two tabs (WAI-ARIA tabs)
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.matches?.('[role="tab"]')) {
      e.preventDefault();
      const other = tab === 'login' ? 'signup' : 'login';
      root.querySelector(`[data-testid="account-tab-${other}"]`)?.click();
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKey);
  const off = onAccountChange((ev) => {
    if (!alive) return;
    if (ev.type === 'logout' && ev.reason === 'session') {
      // logged out by another device while this screen is open
      byeNote = takeNotice() || byeNote;
      sheet = null; welcome = null; fresh = null;
      draw();
      return;
    }
    if (['saving', 'saved', 'error', 'sync', 'local'].includes(ev.type) && loggedIn() && !fresh) drawState();
  });

  draw();
  if (loggedIn()) loadOverview();
  else checkAvailable();

  return () => {
    alive = false;
    off();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('keydown', onKey);
    setNotice(null);
  };
}

const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
