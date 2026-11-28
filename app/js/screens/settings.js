// Settings (#/instellingen, #/instellingen/spotify): music source, the playlists entry and
// Spotify. Spotify with an OWN Client ID: a step-by-step setup help (one step at a time, can be
// interrupted and resumed), errors that explain themselves with a button to the right step,
// and for who is connected a compact overview with sharing the setting with the group.
import * as spotify from '../spotify.js';
import * as player from '../player.js';
import { loopbackVersion } from '../pkce.js';
import { icons, esc, toast } from '../ui.js';
import { deviceListHtml, NO_DEVICE_HELP } from './devices.js';
import { activeDeckInfo } from '../deck.js';
import { qrSvg, defaultBaseUrl } from './print.js';
import { SPOTIFY_APP_URLS } from '../../config.js';
import {
  STEPS, isStep, stepNumber, nextStep, prevStep, DASHBOARD_URL, APP_NAME, APP_DESCRIPTION,
  cleanClientId, clientIdMessage, redirectList, shareLink, explain, errorDetails,
} from '../spotify-setup.js';
import { accountNoteHtml, settingsAccountHtml, onLogInOut } from './account-bits.js';
import { linkLabel, cleanLinkName, LINKS_MAX, LINK_NAME_MAX, LINK_USERS_MAX } from '../spotify-links.js';

export const name = 'settings';

const TEST_SECONDS = 8;
const APP_URLS_KEY = 'timetunesr.spotifyAppUrls.v1';

const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const copyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const pasteIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="5" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 5V3.5h6V5M9 12h6M9 16h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const extIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The addresses of this site (config.js, or per browser for tests). */
function appUrls() {
  try {
    const o = JSON.parse(localStorage.getItem(APP_URLS_KEY) || 'null');
    if (Array.isArray(o) && o.every((x) => typeof x === 'string')) return o;
  } catch { /* ignore */ }
  return SPOTIFY_APP_URLS;
}

/** Copy text; true when it worked (Clipboard API, else the old way). */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function render(root, { params = [] } = {}) {
  let devices = null; // null = not loaded yet
  let devicesBusy = false;
  let devicesMsg = '';
  let test = { busy: false, msg: '', timer: 0, kind: '', ok: false };
  let clientDraft = null; // what is typed in the Client ID field (kept across redraws)
  let shareOpen = false;
  let shareFor = null; // the link (Client ID) the share sheet is for; null = the own one
  let linkAdd = { open: false, id: '', name: '', msg: '' }; // "Link toevoegen"
  let resumed = false;

  // A finished setup ("Klaar") shows the overview the next time.
  const start = spotify.getSetup();
  if (start?.step === 'done') spotify.setSetup(null);
  else if (start && Date.now() - (start.at || 0) > 60_000 && start.step !== 'intro') resumed = true;

  /* ---------- small parts ---------- */

  function envWarning(problem) {
    if (problem === 'localhost') {
      const alt = loopbackVersion(location.href);
      return `<div class="warn set-warn" data-testid="spotify-env-warning">
        <p><strong>Spotify accepteert “localhost” niet als terugkeeradres.</strong></p>
        <p>Open de app via <a href="${esc(alt)}">${esc(new URL(alt).host)}</a> en registreer in het Spotify-dashboard het adres dat daar bij Redirect URIs staat.</p>
      </div>`;
    }
    return `<div class="warn set-warn" data-testid="spotify-env-warning">
      <p><strong>Inloggen bij Spotify kan niet op dit adres.</strong></p>
      <p>Spotify werkt alleen als de app via <b>https</b> geopend is (bijvoorbeeld op GitHub Pages), of op de computer zelf via <b>http://127.0.0.1</b>. Via een gewoon http-adres in het thuisnetwerk lukt het niet. De fragmenten van 30 seconden werken wel.</p>
    </div>`;
  }

  function limitHtml(limit) {
    const opt = (v, label) => `<label class="seg-opt"><input type="radio" name="limit" value="${v}" data-testid="limit-${v}" ${limit === v ? 'checked' : ''}><span>${label}</span></label>`;
    return `<fieldset class="set-field">
      <legend>Afspeelduur per kaart</legend>
      <div class="seg" role="radiogroup">${opt(30, '30 s')}${opt(60, '60 s')}${opt(0, 'Heel nummer')}</div>
      <p class="small muted">Daarna pauzeert Spotify vanzelf. Geldt alleen voor Spotify; fragmenten duren altijd 30 seconden.</p>
    </fieldset>`;
  }

  function devicesHtml(st, { compact = false } = {}) {
    let body;
    if (devices === null) body = '<p class="small muted">Apparaten worden opgezocht…</p>';
    else if (!devices.length) body = `<p class="set-empty" data-testid="device-empty">Geen apparaat gevonden. ${esc(NO_DEVICE_HELP)}</p>`;
    else body = deviceListHtml(devices, st.device?.id);
    const refresh = `<button class="btn btn-small btn-ghost" type="button" data-act="devices" data-testid="spotify-devices-refresh" ${devicesBusy ? 'disabled' : ''}>${icons.restart}<span>${devicesBusy ? 'Zoeken…' : 'Zoek opnieuw'}</span></button>`;
    return `<div class="set-field">
      ${compact ? '' : `<div class="set-row"><span class="set-label">Afspeelapparaat</span>${refresh}</div>`}
      ${body}
      ${compact ? `<div>${refresh}</div>` : ''}
      ${devicesMsg ? `<p class="set-error" data-testid="device-msg">${esc(devicesMsg)}</p>` : ''}
    </div>`;
  }

  function testHtml() {
    return `<button class="btn btn-secondary" type="button" data-act="test" data-testid="spotify-test" ${test.busy ? 'disabled' : ''}>${icons.play}<span>${test.busy ? 'Test loopt…' : 'Test het geluid'}</span></button>
      ${test.msg ? `<p class="set-test ${test.kind === 'error' ? 'set-error' : ''}" data-testid="spotify-test-msg" role="status">${esc(test.msg)}</p>` : ''}`;
  }

  const copyBtn = (key, value, label, testid) => `<button class="btn btn-small btn-ghost wiz-copy" type="button" data-copy="${esc(key)}" data-value="${esc(value)}" data-label="${esc(label)}" data-testid="${esc(testid)}" aria-label="${esc(label)}: ${esc(value)}">${copyIcon}<span>Kopieer</span></button>`;

  /** The error of the last attempt, explained, with a button to the step that fixes it. */
  function errorHtml(st, setup) {
    if (!st.error || st.connected) return '';
    const shared = setup?.mode === 'shared';
    const x = explain(st.error);
    let text = x.text;
    let step = x.step;
    let button = x.button;
    if (shared && st.error === 'not-allowed') {
      text = `Vraag ${setup.from ? esc(setup.from) : 'wie de instelling deelde'} om jouw Spotify-account toe te voegen in de Spotify-app, onder “User Management” (maximaal 5). Probeer het daarna opnieuw.`;
      step = 'connect'; button = 'Opnieuw inloggen';
    } else if (shared && ['client', 'redirect'].includes(st.error)) {
      text = `${x.text} Dat regelt ${setup.from ? esc(setup.from) : 'wie de instelling deelde'} in de eigen Spotify-app; of stel Spotify zelf in.`;
      step = 'own'; button = 'Zelf instellen';
    } else text = esc(text);
    return `<div class="set-alert" data-testid="spotify-error" data-code="${esc(st.error)}" role="alert">
      <p class="set-alert-title" data-testid="spotify-error-title">${esc(x.title)}</p>
      <p>${text}</p>
      <div class="set-alert-actions">
        ${step && step !== 'connect' ? `<button class="btn btn-small btn-primary" type="button" data-act="goto" data-step="${esc(step)}" data-testid="wiz-error-go">${esc(button)}</button>` : ''}
        <button class="btn btn-small btn-ghost" type="button" data-act="copy-details" data-testid="wiz-error-copy">${copyIcon}<span>Kopieer foutdetails</span></button>
      </div>
    </div>`;
  }

  /** A login that never came back (Spotify's own error page): ask what the user saw. */
  function unfinishedHtml() {
    if (!spotify.unfinishedLogin()) return '';
    return `<div class="set-alert" data-testid="wiz-unfinished" role="alert">
      <p class="set-alert-title">Je vorige inlogpoging is niet afgerond</p>
      <p>Wat zag je bij Spotify?</p>
      <div class="stack">
        <button class="btn btn-small btn-ghost wiz-choice" type="button" data-act="unfinished" data-step="app" data-testid="wiz-unfinished-redirect"><span>“INVALID_CLIENT: Invalid redirect URI”</span></button>
        <button class="btn btn-small btn-ghost wiz-choice" type="button" data-act="unfinished" data-step="clientid" data-testid="wiz-unfinished-client"><span>“INVALID_CLIENT: Invalid client”</span></button>
        <button class="btn btn-small btn-ghost wiz-choice" type="button" data-act="unfinished" data-step="connect" data-testid="wiz-unfinished-retry"><span>Iets anders, of ik ging zelf terug</span></button>
      </div>
    </div>`;
  }

  /* ---------- the wizard ---------- */

  function headHtml(step, setup) {
    if (setup?.mode === 'shared') {
      return `<div class="wiz-head" data-testid="wiz-head" data-step="${step}">
        <p class="wiz-count">Nog één stap</p>
        <h3 class="wiz-title">Log in bij Spotify</h3>
      </div>`;
    }
    const n = stepNumber(step);
    const bars = STEPS.map((s, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
    return `<div class="wiz-head" data-testid="wiz-head" data-step="${step}">
      <div class="wiz-bar" aria-hidden="true">${bars}</div>
      <p class="wiz-count" data-testid="wiz-progress">Stap ${n} van ${STEPS.length}</p>
      <h3 class="wiz-title">${esc(STEPS[n - 1].title)}${STEPS[n - 1].optional ? ' <small>(kan ook later)</small>' : ''}</h3>
    </div>`;
  }

  function navHtml(step, { next = true, nextLabel = 'Volgende', nextDisabled = false, skip = false } = {}) {
    return `<div class="wiz-nav">
      ${next ? `<button class="btn btn-primary btn-xl" type="button" data-act="next" data-testid="wiz-next" ${nextDisabled ? 'disabled' : ''}><span>${esc(nextLabel)}</span></button>` : ''}
      ${skip ? '<button class="btn btn-ghost" type="button" data-act="next" data-testid="wiz-skip"><span>Sla over</span></button>' : ''}
      <div class="wiz-nav-row">
        <button class="btn btn-small btn-ghost" type="button" data-act="prev" data-testid="wiz-prev">${icons.back}<span>Vorige</span></button>
        <button class="btn btn-small btn-ghost" type="button" data-act="later" data-testid="wiz-later"><span>Later verder</span></button>
      </div>
    </div>`;
  }

  function introHtml(problem) {
    return `<div class="wiz" data-testid="wiz" data-step="intro">
      <div class="wiz-intro" data-testid="wiz-intro">
        <p class="wiz-lead">Speel <b>hele nummers</b> in plaats van fragmenten van 30 seconden, via de Spotify-app op je telefoon of een speaker.</p>
        <ul class="wiz-needs">
          <li>${icons.check}<span>Je hebt <b>Spotify Premium</b> nodig.</span></li>
          <li>${icons.check}<span>Het kost <b>±5 minuten</b>, en maar één keer.</span></li>
          <li>${icons.check}<span>Je maakt bij Spotify een eigen, gratis “app” aan: een soort sleutel. De koppelhulp wijst je elke stap.</span></li>
        </ul>
        <p class="small muted">Liever niet? Dan speel je gewoon met de fragmenten; daarvoor heb je geen account nodig.</p>
      </div>
      ${problem ? envWarning(problem) : ''}
      <button class="btn btn-primary btn-xl" type="button" data-act="begin" data-testid="wiz-start">${spotifyIcon}<span>Begin met koppelen</span></button>
      <button class="btn btn-ghost btn-small wiz-link" type="button" data-act="goto" data-step="clientid" data-testid="wiz-have-id"><span>Ik heb al een Client ID</span></button>
    </div>`;
  }

  function dashboardHtml(setup) {
    return `<p>Open het dashboard van Spotify en log in met je <b>Spotify-account met Premium</b>. Vraagt Spotify om de voorwaarden te accepteren, doe dat dan.</p>
      <a class="btn btn-secondary btn-xl" href="${DASHBOARD_URL}" target="_blank" rel="noopener" data-act="opened" data-testid="wiz-open-dashboard">${extIcon}<span>Open het Spotify-dashboard</span></a>
      <p class="warn small" data-testid="wiz-come-back">Het dashboard opent in een <b>nieuw tabblad</b>. Kom daarna terug naar <b>dít tabblad</b>: hier staat de volgende stap klaar.</p>
      ${setup?.opened ? '<p class="small muted" data-testid="wiz-opened">Ben je ingelogd in het dashboard? Ga dan verder.</p>' : ''}
      ${navHtml('dashboard', { nextLabel: 'Ik ben ingelogd: volgende' })}`;
  }

  function uriRowsHtml() {
    const list = redirectList(spotify.redirectUri(), appUrls());
    const first = list[0];
    const others = list.slice(1);
    return `<button class="wiz-uri" type="button" data-copy="uri" data-value="${esc(first.uri)}" data-label="Redirect URI" data-testid="copy-redirect-uri" aria-label="Kopieer de Redirect URI ${esc(first.uri)}">
        <code data-testid="spotify-redirect-uri">${esc(first.uri)}</code>
        <span class="wiz-uri-tap">${copyIcon}<span>Tik om te kopiëren</span></span>
      </button>
      ${others.length ? `<p class="small" data-testid="spotify-help-both-uris">TimeTunesr staat ook op ${others.length === 1 ? 'een ander adres' : 'andere adressen'}. Speel je (of een medespeler) daar ook, voeg ${others.length === 1 ? 'dat' : 'die'} dan ook toe; dan werkt inloggen overal:</p>
        <ul class="wiz-uri-list" data-testid="wiz-uri-list">${others.map((u, i) => `<li><button class="wiz-uri wiz-uri-small" type="button" data-copy="uri-${i + 1}" data-value="${esc(u.uri)}" data-label="Redirect URI" data-testid="wiz-copy-uri-${i + 1}" aria-label="Kopieer de Redirect URI ${esc(u.uri)}">
          <code>${esc(u.uri)}</code><span class="wiz-uri-tap">${copyIcon}<span>Tik om te kopiëren</span></span></button></li>`).join('')}</ul>` : ''}`;
  }

  function appHtml(problem) {
    const row = (label, body) => `<div class="wiz-f"><span class="wiz-f-label">“${esc(label)}”</span><div class="wiz-f-body">${body}</div></div>`;
    return `<p>Tik in het dashboard op <b>“Create app”</b>. Vul het formulier zo in:</p>
      ${problem ? envWarning(problem) : ''}
      <div class="wiz-form" data-testid="wiz-form">
        ${row('App name', `<span class="wiz-val">${esc(APP_NAME)}</span>${copyBtn('name', APP_NAME, 'App name', 'wiz-copy-name')}`)}
        ${row('App description', `<span class="wiz-val">${esc(APP_DESCRIPTION)}</span>${copyBtn('desc', APP_DESCRIPTION, 'App description', 'wiz-copy-desc')}`)}
        ${row('Website', '<span class="wiz-hint">mag leeg blijven</span>')}
        ${row('Redirect URIs', `<span class="wiz-hint"><b>Het belangrijkste.</b> Plak dit adres en tik op <b>“Add”</b>:</span>${uriRowsHtml()}`)}
        ${row('Which API/SDKs are you planning to use?', '<span class="wiz-check">☑</span><span>Vink <b>“Web API”</b> aan</span>')}
        ${row('I understand and agree with Spotify\'s Developer Terms of Service…', '<span class="wiz-check">☑</span><span>Vink de voorwaarden aan</span>')}
        <div class="wiz-f wiz-f-save"><span class="wiz-save">Save</span><span class="wiz-hint">Tik onderaan op “Save”.</span></div>
      </div>
      <p class="small muted">Het adres moet <b>precies</b> zo in Spotify staan, met de schuine streep aan het eind.</p>
      ${navHtml('app', { nextLabel: 'App gemaakt: volgende' })}`;
  }

  function clientIdHtml() {
    const value = clientDraft ?? spotify.getClientId();
    const check = cleanClientId(value);
    const msg = value ? clientIdMessage(check) : null;
    return `<p>Je ziet nu je nieuwe app. Tik rechtsboven op <b>“Settings”</b>. Bovenaan die pagina staat <b>“Client ID”</b>: een rij van 32 cijfers en letters. Kopieer die en plak hem hier.</p>
      <p class="warn small" data-testid="wiz-secret-note">Niet de <b>“Client secret”</b>: die heb je niet nodig en deel je met niemand.</p>
      <label class="set-field" for="client-id">
        <span class="set-label">Client ID</span>
        <span class="set-inline">
          <input id="client-id" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false"
            value="${esc(value)}" placeholder="32 tekens, bv. 1a2b3c…" data-testid="spotify-client-id">
          <button class="btn btn-small btn-ghost" type="button" data-act="paste" data-testid="wiz-paste">${pasteIcon}<span>Plak</span></button>
        </span>
        <span class="wiz-cid-msg ${check.ok ? 'is-ok' : msg ? 'set-error' : ''}" data-testid="client-msg" data-ok="${check.ok}" role="status">${check.ok ? '✓ Ziet er goed uit: 32 tekens.' : msg ? esc(msg) : ''}</span>
      </label>
      <div class="wiz-nav">
        <button class="btn btn-primary btn-xl" type="button" data-act="save-client" data-testid="spotify-client-save" ${check.ok ? '' : 'disabled'}><span>Bewaar en ga verder</span></button>
        <div class="wiz-nav-row">
          <button class="btn btn-small btn-ghost" type="button" data-act="prev" data-testid="wiz-prev">${icons.back}<span>Vorige</span></button>
          <button class="btn btn-small btn-ghost" type="button" data-act="later" data-testid="wiz-later"><span>Later verder</span></button>
        </div>
      </div>`;
  }

  function usersHtml() {
    return `<div class="wiz-users" data-testid="wiz-users">
      <p>Logt een vriend met <b>zijn eigen Spotify-account</b> in via jouw instelling? Bijvoorbeeld om in een kamer zijn favorieten te delen. Zet hem dan in je Spotify-app. Jijzelf hoeft er niet in.</p>
      <ol class="wiz-ol">
        <li>Open je app in het dashboard en tik op <b>“Settings”</b>.</li>
        <li>Kies het tabblad <b>“User Management”</b>.</li>
        <li>Vul zijn naam en het <b>e-mailadres van zijn Spotify-account</b> in en tik op de knop om hem toe te voegen (<b>“Add user”</b>).</li>
      </ol>
      <p class="small muted">Spotify staat maximaal <b>5 accounts</b> toe. Dit kan ook later.</p>
      <p class="small" data-testid="wiz-links-note"><b>Meer dan 5 mensen?</b> Maak in het dashboard nog een app (met hetzelfde adres bij Redirect URIs): dat is <b>Link 2</b>. Elke link is een eigen Spotify-app met plek voor 5 mensen. Voeg hem na de koppelhulp toe bij Instellingen → Spotify → <b>Spotify-links</b>. In een kamer kiest iedereen dan zelf “link 1 of link 2”.</p>
    </div>
    ${navHtml('users', { nextLabel: 'Klaar: volgende', skip: true })}`;
  }

  function checksHtml(st) {
    const prem = st.profile?.product && st.profile.product !== 'premium';
    const dev = st.device;
    const devState = devices === null || devicesBusy ? 'busy' : dev && devices.some((d) => d.id === dev.id) ? 'ok' : 'todo';
    const soundState = test.ok ? 'ok' : test.kind === 'error' ? 'bad' : test.busy ? 'busy' : 'todo';
    const mark = (s) => (s === 'ok' ? icons.check : s === 'bad' ? icons.cross : s === 'busy' ? '<span class="wiz-spin" aria-hidden="true"></span>' : '<span class="wiz-dot" aria-hidden="true"></span>');
    const all = devState === 'ok' && test.ok && !prem;
    return `<ul class="wiz-checks" data-testid="wiz-checks">
        <li class="is-${prem ? 'bad' : 'ok'}" data-testid="wiz-check-account" data-ok="${!prem}">${mark(prem ? 'bad' : 'ok')}<div>
          <b>Verbonden${st.profile?.name ? ` als ${esc(st.profile.name)}` : ''}</b>
          ${prem ? `<p class="set-error" data-testid="wiz-no-premium">${esc(explain('premium').text)}</p>` : ''}</div></li>
        <li class="is-${devState}" data-testid="wiz-check-device" data-ok="${devState === 'ok'}">${mark(devState)}<div>
          <b>${devState === 'ok' ? `Afspeelapparaat: ${esc(dev.name)}` : devState === 'busy' ? 'Afspeelapparaat zoeken…' : 'Kies een afspeelapparaat'}</b>
          ${devState === 'ok' && devices?.length < 2 ? '' : devicesHtml(st, { compact: true })}</div></li>
        <li class="is-${soundState}" data-testid="wiz-check-sound" data-ok="${test.ok}">${mark(soundState)}<div>
          <b>${test.ok ? 'Testgeluid gespeeld' : 'Testgeluid'}</b>
          ${test.ok ? `<p class="small muted"><span data-testid="spotify-test-msg">${esc(test.msg)}</span> Niets gehoord? Kijk naar het volume op dat apparaat.</p>` : `<p class="small muted">Je hoort ${TEST_SECONDS} seconden pianomuziek op het gekozen apparaat.</p>${testHtml()}`}</div></li>
      </ul>
      ${all ? `<button class="btn btn-primary btn-xl" type="button" data-act="finish" data-testid="wiz-finish">${icons.check}<span>Klaar: gebruik Spotify</span></button>`
    : '<p class="small muted" data-testid="wiz-checks-todo">Als alles een vinkje heeft, ben je klaar.</p>'}`;
  }

  function connectHtml(st, setup, problem) {
    if (st.connected) return checksHtml(st);
    const shared = setup?.mode === 'shared';
    return `${shared ? `<p data-testid="wiz-shared-intro">Je gebruikt de Spotify-instelling${setup.from ? ` van <b>${esc(setup.from)}</b>` : ''}. Log in met <b>je eigen Spotify-account</b> (Premium nodig).</p>
        ${st.error === 'not-allowed' ? '' : `<p class="warn small" data-testid="wiz-shared-note">Dat lukt alleen als ${setup.from ? esc(setup.from) : 'die persoon'} jouw Spotify-account heeft toegevoegd onder “User Management” (maximaal 5).</p>`}`
    : '<p>Tik op de knop en log in met je <b>Spotify-account met Premium</b>. Geef toestemming; je komt daarna vanzelf hier terug en de app test of alles werkt.</p>'}
      ${problem ? envWarning(problem) : ''}
      ${unfinishedHtml()}
      ${errorHtml(st, setup)}
      ${problem ? '' : `<button class="btn btn-primary btn-xl" type="button" data-act="connect" data-testid="spotify-connect" ${st.busy ? 'disabled' : ''}>${spotifyIcon}<span>${st.busy ? 'Bezig met verbinden…' : 'Log in bij Spotify'}</span></button>`}
      <div class="wiz-know" data-testid="wiz-invalid-hint">
        <p><b>Zie je bij Spotify een pagina met “INVALID_CLIENT”?</b> Dan klopt de Client ID of het adres niet. Ga met de terugknop terug naar deze app; dan helpen we je verder.</p>
        <p data-testid="wiz-ios-note"><b>${isIos() ? 'Op je iPhone' : 'Op een iPhone'}:</b> de app op je beginscherm en Safari bewaren alles apart. Koppel daarom in de omgeving waarin je speelt.</p>
      </div>`;
  }

  function doneHtml(st) {
    return `<div class="wiz-done" data-testid="wiz-done">
        <span class="wiz-done-mark">${icons.check}</span>
        <h3>Klaar — Spotify is nu je muziekbron</h3>
        <p>Kaarten en spellen spelen nu hele nummers via Spotify${st.device ? ` op <b>${esc(st.device.name)}</b>` : ''}. Laat de Spotify-app openstaan, en leg de telefoon met het scherm naar beneden: daar staat de titel.</p>
      </div>
      <a class="btn btn-primary btn-xl" href="#/" data-testid="wiz-home">${icons.home}<span>Naar start</span></a>
      <button class="btn btn-ghost" type="button" data-act="share" data-testid="spotify-share-open">${icons.users}<span>Deel met je vaste groep</span></button>
      <button class="btn btn-ghost btn-small" type="button" data-act="to-preview" data-testid="wiz-back-preview"><span>Toch liever fragmenten van 30 seconden</span></button>
      <button class="btn btn-ghost btn-small" type="button" data-act="close-wizard" data-testid="wiz-close"><span>Sluit de koppelhulp</span></button>`;
  }

  function wizardHtml(step, st, setup, problem) {
    if (step === 'intro') return introHtml(problem);
    if (step === 'done') return `<div class="wiz" data-testid="wiz" data-step="done">${doneHtml(st)}</div>`;
    let body = '';
    if (step === 'dashboard') body = dashboardHtml(setup);
    else if (step === 'app') body = appHtml(problem);
    else if (step === 'clientid') body = clientIdHtml();
    else if (step === 'users') body = usersHtml();
    else {
      const shared = setup?.mode === 'shared';
      body = `${connectHtml(st, setup, problem)}
        <div class="wiz-nav-row">
          ${shared ? '<button class="btn btn-small btn-ghost" type="button" data-act="goto" data-step="own" data-testid="wiz-own"><span>Liever zelf instellen</span></button>'
    : `<button class="btn btn-small btn-ghost" type="button" data-act="prev" data-testid="wiz-prev">${icons.back}<span>Vorige</span></button>`}
          <button class="btn btn-small btn-ghost" type="button" data-act="later" data-testid="wiz-later"><span>Later verder</span></button>
        </div>`;
    }
    return `<div class="wiz" data-testid="wiz" data-step="${step}">
      ${resumed ? '<p class="wiz-resumed" data-testid="wiz-resumed">Welkom terug! Je gaat verder waar je gebleven was.</p>' : ''}
      ${headHtml(step, setup)}
      <div class="wiz-body" data-testid="wiz-step-${step}">${body}</div>
    </div>`;
  }

  /** Not in the help, Client ID known, not connected (e.g. after "Verbreek verbinding"). */
  function reconnectHtml(st, problem) {
    return `<p class="set-status muted" data-testid="spotify-status">Je Spotify-instelling staat klaar. Log in om hele nummers te spelen.</p>
      ${problem ? envWarning(problem) : ''}
      ${unfinishedHtml()}
      ${errorHtml(st, null)}
      ${problem ? '' : `<button class="btn btn-primary btn-xl" type="button" data-act="connect" data-testid="spotify-connect" ${st.busy ? 'disabled' : ''}>${spotifyIcon}<span>${st.busy ? 'Bezig met verbinden…' : 'Verbind met Spotify'}</span></button>`}
      ${linksHtml()}
      <div class="set-actions">
        <button class="btn btn-ghost btn-small" type="button" data-act="redo" data-testid="spotify-redo"><span>Opnieuw instellen</span></button>
        <button class="btn btn-ghost btn-small" type="button" data-act="forget-client" data-testid="spotify-forget-client"><span>Wis Client ID</span></button>
      </div>`;
  }

  const shortId = (id) => `${id.slice(0, 6)}…${id.slice(-4)}`;

  /**
   * "Spotify-links": the host's Spotify apps (one Client ID each, 5 people per app). Link 1 is
   * the existing Client ID; more can be added, named, moved and removed; per link the share
   * link / QR; with more than one the host picks the one he logs in with himself.
   */
  function linksHtml() {
    const links = spotify.getLinks();
    if (!links.length) return '';
    const own = spotify.ownLinkIndex();
    const many = links.length > 1;
    const rows = links.map((l, i) => `<li class="sp-link" data-testid="spotify-link-row" data-index="${i}" data-id="${esc(l.id)}">
        <div class="sp-link-head">
          <b class="sp-link-no">Link ${i + 1}</b>
          <code class="sp-link-id" title="Client ID">${esc(shortId(l.id))}</code>
          ${many && i === own ? '<span class="pill pill-on" data-testid="spotify-link-own">jij logt hiermee in</span>' : ''}
        </div>
        <input class="sp-link-name" type="text" maxlength="${LINK_NAME_MAX}" autocomplete="off" value="${esc(l.name)}" placeholder="Naam, bv. familie (mag leeg)"
          data-link-name="${esc(l.id)}" data-testid="spotify-link-name" aria-label="Naam van link ${i + 1}">
        <div class="sp-link-actions">
          ${many ? `<button class="btn btn-small btn-ghost" type="button" data-act="link-up" data-id="${esc(l.id)}" data-testid="spotify-link-up" ${i === 0 ? 'disabled' : ''} aria-label="Link ${i + 1} omhoog">↑</button>
          <button class="btn btn-small btn-ghost" type="button" data-act="link-down" data-id="${esc(l.id)}" data-testid="spotify-link-down" ${i === links.length - 1 ? 'disabled' : ''} aria-label="Link ${i + 1} omlaag">↓</button>` : ''}
          <button class="btn btn-small btn-ghost" type="button" data-act="link-share" data-id="${esc(l.id)}" data-testid="spotify-link-share">${icons.share}<span>Deel</span></button>
          ${many ? `<button class="btn btn-small btn-ghost" type="button" data-act="link-remove" data-id="${esc(l.id)}" data-testid="spotify-link-remove" aria-label="Haal link ${i + 1} weg">${icons.close}<span>Weg</span></button>` : ''}
        </div>
      </li>`).join('');
    const ownPick = many ? `<label class="pl-label sp-own-link">Ik log zelf in via
        <select data-testid="spotify-own-link" data-own-link>${links.map((l, i) => `<option value="${i}" ${i === own ? 'selected' : ''}>${esc(linkLabel(i, l.name))}</option>`).join('')}</select></label>` : '';
    const check = cleanClientId(linkAdd.id);
    const dup = check.ok && links.some((l) => l.id === check.value);
    const add = links.length >= LINKS_MAX
      ? `<p class="small muted" data-testid="spotify-links-full">Je hebt het maximum van ${LINKS_MAX} links.</p>`
      : !linkAdd.open
        ? `<button class="btn btn-small btn-secondary" type="button" data-act="link-add" data-testid="spotify-link-add">${icons.plus}<span>Link toevoegen</span></button>`
        : `<div class="sp-link-new" data-testid="spotify-link-new">
            <p class="small">Maak in het <a href="${DASHBOARD_URL}" target="_blank" rel="noopener">Spotify-dashboard</a> nog een app, precies zoals in stap 2 van de koppelhulp (hetzelfde adres bij Redirect URIs), en plak hier zijn Client ID.</p>
            <label class="pl-label">Client ID van Link ${links.length + 1}
              <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(linkAdd.id)}" placeholder="32 tekens" data-testid="spotify-link-new-id"></label>
            <label class="pl-label">Naam (mag leeg)
              <input type="text" maxlength="${LINK_NAME_MAX}" autocomplete="off" value="${esc(linkAdd.name)}" placeholder="bv. vrienden" data-testid="spotify-link-new-name"></label>
            ${linkAdd.msg || (linkAdd.id && (!check.ok || dup)) ? `<p class="set-error" data-testid="spotify-link-new-msg" role="alert">${esc(linkAdd.msg || (dup ? 'Deze Client ID staat er al in.' : clientIdMessage(check)))}</p>` : ''}
            <div class="set-actions">
              <button class="btn btn-small btn-primary" type="button" data-act="link-save" data-testid="spotify-link-new-save">${icons.check}<span>Bewaar link</span></button>
              <button class="btn btn-small btn-ghost" type="button" data-act="link-cancel" data-testid="spotify-link-new-cancel"><span>Annuleer</span></button>
            </div>
          </div>`;
    return `<div class="set-field sp-links" data-testid="spotify-links" data-count="${links.length}">
        <span class="set-label">Spotify-links</span>
        <p class="small" data-testid="spotify-links-explain">Elke link is een eigen Spotify-app met plek voor ${LINK_USERS_MAX} mensen. Voeg in het Spotify-dashboard bij die app (User Management) de mensen toe die via deze link mogen koppelen.${many ? ' In een kamer kiest iedereen zelf via welke link hij koppelt.' : ' Meer mensen? Voeg een tweede link toe.'}</p>
        <ol class="sp-link-list">${rows}</ol>
        ${ownPick}
        ${add}
      </div>`;
  }

  function overviewHtml(st, settings) {
    const who = st.profile?.name ? `Verbonden als <b>${esc(st.profile.name)}</b>.` : 'Verbonden met Spotify.';
    const dev = st.device ? `Speelt af op <b>${esc(st.device.name)}</b>.` : 'Nog geen apparaat gekozen.';
    const borrowed = spotify.connectedClientId() && spotify.connectedClientId() !== spotify.getClientId();
    return `<p class="set-status" data-testid="spotify-status">${who} ${dev}</p>
      ${borrowed ? '<p class="small muted" data-testid="spotify-borrowed">Ingelogd via de Spotify-instelling van een spelleider.</p>' : ''}
      <p class="set-line" data-testid="spotify-source-line">Muziekbron: <b>${settings.source === 'spotify' ? 'Spotify' : 'fragmenten van 30 seconden'}</b>
        ${settings.source === 'spotify' ? '' : '<button class="btn btn-small btn-secondary" type="button" data-act="use-spotify" data-testid="spotify-use">Gebruik Spotify</button>'}</p>
      ${devicesHtml(st)}
      ${testHtml()}
      ${limitHtml(settings.limit)}
      ${spotify.getClientId() ? linksHtml() : ''}
      <div class="set-actions">
        ${borrowed ? '' : `<button class="btn btn-ghost btn-small" type="button" data-act="share" data-testid="spotify-share-open">${icons.users}<span>Deel met je groep</span></button>`}
        <button class="btn btn-ghost btn-small" type="button" data-act="redo" data-testid="spotify-redo">${icons.restart}<span>${borrowed ? 'Eigen Spotify instellen' : 'Opnieuw instellen'}</span></button>
      </div>
      <button class="btn btn-ghost btn-small set-disconnect" type="button" data-act="disconnect" data-testid="spotify-disconnect">${icons.close}<span>Verbreek verbinding met Spotify</span></button>`;
  }

  function shareSheetHtml(st) {
    const links = spotify.getLinks();
    const li = shareFor ? links.findIndex((l) => l.id === shareFor) : -1;
    const cid = li >= 0 ? links[li].id : spotify.getClientId() || spotify.connectedClientId();
    const link = shareLink(defaultBaseUrl(), cid, st.profile?.name || '');
    if (!link) return '';
    return `<div class="sheet-backdrop" data-testid="spotify-share-sheet" data-id="${esc(cid)}">
      <div class="sheet pl-share sp-share" role="dialog" aria-modal="true" aria-labelledby="sp-share-title">
        <h2 id="sp-share-title">${li >= 0 && links.length > 1 ? `Deel ${esc(linkLabel(li, links[li].name))}` : 'Deel je Spotify-instelling'}</h2>
        <p class="small">Vrienden die deze code scannen of de link openen, hoeven alleen nog in te loggen bij Spotify. Ze krijgen eerst de vraag of ze hem willen overnemen.</p>
        <div class="pl-qr" data-testid="spotify-share-qr">${qrSvg(link)}</div>
        <label class="pl-label" for="sp-share-link">Link</label>
        <div class="pl-search"><input id="sp-share-link" type="text" readonly value="${esc(link)}" data-testid="spotify-share-link">
          <button class="btn btn-primary btn-small" type="button" data-copy="share" data-value="${esc(link)}" data-label="Link" data-testid="spotify-share-copy">Kopieer</button></div>
        ${navigator.share ? `<button class="btn btn-ghost btn-small" type="button" data-act="share-native" data-testid="spotify-share-native">${icons.share}<span>Stuur via…</span></button>` : ''}
        <p class="warn small" data-testid="spotify-share-users">Belangrijk: zet hun Spotify-account eerst in je Spotify-app onder <b>“User Management”</b> (maximaal 5 accounts). Anders laat Spotify hen niet toe.</p>
        <button class="btn btn-ghost btn-small" type="button" data-act="goto" data-step="users" data-testid="spotify-share-howto"><span>Hoe voeg ik iemand toe?</span></button>
        <p class="small muted">Spelen jullie samen in een kamer? Dan is delen niet nodig: de kamer geeft jouw instelling vanzelf door.</p>
        <button class="btn btn-ghost" type="button" data-act="share-close" data-testid="spotify-share-close">${icons.close}<span>Sluiten</span></button>
      </div>
    </div>`;
  }

  /* ---------- the screen ---------- */

  /** Which Spotify view: a wizard step, the overview, or reconnect. */
  function currentView(st) {
    const setup = spotify.getSetup();
    if (setup && (isStep(setup.step) || setup.step === 'intro' || setup.step === 'done')) return { kind: 'wizard', step: setup.step, setup };
    if (st.connected) return { kind: 'overview', setup: null };
    if (spotify.getClientId()) return { kind: 'reconnect', setup: null };
    return { kind: 'wizard', step: 'intro', setup: null };
  }

  function draw() {
    const st = spotify.getStatus();
    const settings = spotify.getSettings();
    const problem = spotify.environmentProblem();
    const view = currentView(st);
    const focusId = document.activeElement?.dataset?.testid;

    let body;
    if (view.kind === 'overview') body = overviewHtml(st, settings);
    else if (view.kind === 'reconnect') body = reconnectHtml(st, problem);
    else body = wizardHtml(view.step, st, view.setup, problem);

    const sourceNote = settings.source === 'spotify' && !st.connected
      ? '<p class="set-note" data-testid="source-note">Spotify is nog niet verbonden. Tot dan hoor je fragmenten van 30 seconden.</p>' : '';

    root.innerHTML = `<section class="screen screen-settings" data-testid="screen-settings">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
        <h1 class="topbar-title">Instellingen</h1>
        <span class="topbar-spacer"></span>
      </header>

      <section class="set-card" aria-labelledby="set-source">
        <h2 id="set-source">Muziekbron</h2>
        <div class="choices" role="radiogroup" aria-labelledby="set-source">
          <label class="choice"><input type="radio" name="source" value="preview" data-testid="source-preview" ${settings.source === 'preview' ? 'checked' : ''}>
            <span><b>Fragment van 30 seconden</b><small>Geen account nodig. Via Apple Music.</small></span></label>
          <label class="choice"><input type="radio" name="source" value="spotify" data-testid="source-spotify" ${settings.source === 'spotify' ? 'checked' : ''}>
            <span><b>Spotify</b><small>Hele nummers, Spotify Premium nodig.</small></span></label>
        </div>
        ${sourceNote}
        ${!st.connected && view.kind === 'wizard' && view.step === 'intro' ? '<a class="sp-hint" href="#spotify" data-act="to-spotify" data-testid="spotify-setup-hint"><span class="sp-hint-dot" aria-hidden="true"></span><span>Hele nummers? Koppel je eigen Spotify in ±5 minuten</span><span class="sp-hint-go" aria-hidden="true">›</span></a>' : ''}
      </section>

      <section class="set-card" aria-labelledby="set-music" data-testid="settings-music">
        <h2 id="set-music">${icons.music}<span>Muziek</span></h2>
        <p>Je speelt met <b data-testid="settings-deck-name">${esc(activeDeckInfo().name)}</b>. Maak een eigen playlist met je eigen nummers, of kies een andere.</p>
        <a class="btn btn-ghost" href="#/playlists" data-testid="settings-playlists">${icons.music}<span>Eigen playlists</span></a>
      </section>

      <section class="set-card" id="spotify" aria-labelledby="set-spotify" data-testid="spotify-block" data-connected="${st.connected}" data-view="${view.kind === 'wizard' ? `wizard-${view.step}` : view.kind}">
        <div class="set-head">
          <h2 id="set-spotify">${spotifyIcon}<span>Spotify</span></h2>
          <span class="pill ${st.connected ? 'pill-on' : ''}" data-testid="spotify-pill">${st.connected ? 'Verbonden' : 'Niet verbonden'}</span>
        </div>
        ${body}
        ${accountNoteHtml('spotify')}
      </section>
      ${settingsAccountHtml()}

      <a class="btn btn-ghost" href="#/" data-testid="settings-home">${icons.home}<span>Naar start</span></a>
      ${shareOpen ? shareSheetHtml(st) : ''}
    </section>`;
    if (focusId) root.querySelector(`[data-testid="${focusId}"]`)?.focus({ preventScroll: true });
  }

  async function loadDevices() {
    if (!spotify.isConnected() || devicesBusy) return;
    devicesBusy = true;
    devicesMsg = '';
    redraw();
    try {
      devices = await spotify.getDevices();
      const chosen = spotify.getDevice();
      if (!chosen || !devices.some((d) => d.id === chosen.id)) {
        const pick = devices.find((d) => d.active) || (devices.length === 1 ? devices[0] : null);
        if (pick) spotify.setDevice(pick);
      }
    } catch (e) {
      devices = devices || [];
      devicesMsg = spotify.errorMessage(e);
    }
    devicesBusy = false;
    redraw();
  }

  // Keep the scroll position when re-rendering after async work.
  function redraw() {
    if (!root.isConnected || root.dataset.route !== name) return;
    const y = window.scrollY;
    draw();
    window.scrollTo(0, y);
  }

  function scrollToSpotify() {
    root.querySelector('[data-testid="spotify-block"]')?.scrollIntoView({ block: 'start' });
  }

  /** Show a step and bring it into view. */
  function go(step) {
    if (step === 'own') spotify.setSetup({ step: 'intro', mode: 'own', from: '' });
    else spotify.setSetup({ step });
    resumed = false;
    draw();
    scrollToSpotify();
  }

  async function runTest() {
    if (test.busy) return;
    player.stop();
    clearTimeout(test.timer);
    test = { busy: true, msg: 'Testgeluid wordt gestart…', timer: 0, kind: '', ok: false };
    redraw();
    try {
      const uri = await spotify.findTestTrack();
      const d = await spotify.play(uri, 0);
      test.ok = true;
      test.msg = `Je hoort nu ${TEST_SECONDS} seconden pianomuziek op ${d.name}.`;
      test.timer = setTimeout(() => {
        spotify.pause().catch(() => {});
        test.busy = false;
        test.msg = `Test klaar: er speelde pianomuziek op ${d.name}. Werkte het? Dan kun je spelen.`;
        redraw();
      }, TEST_SECONDS * 1000);
      redraw();
      return;
    } catch (e) {
      test.kind = 'error';
      if (e.code === 'premium') test.msg = 'Dat lukte niet: Spotify Premium nodig.';
      else if (e.code === 'no-device' || e.code === 'owner-premium') test.msg = `${explain(e.code).title}. ${explain(e.code).text}`;
      else test.msg = spotify.errorMessage(e);
      if (e.code === 'no-device') { devices = e.devices || []; spotify.setDevice(null); }
    }
    test.busy = false;
    redraw();
  }

  async function onCopy(btn) {
    const ok = await copyText(btn.dataset.value || '');
    const label = btn.dataset.label || 'Tekst';
    toast(ok ? `${label} gekopieerd` : 'Kopiëren lukte niet; houd de tekst ingedrukt en kopieer hem zelf.', { ms: 2200 });
    if (!ok) return;
    btn.dataset.copied = 'true';
    const target = btn.querySelector('.wiz-uri-tap > span') || btn.querySelector(':scope > span:last-child') || btn;
    const old = target.textContent;
    target.textContent = 'Gekopieerd ✓';
    setTimeout(() => { if (btn.isConnected) { target.textContent = old; delete btn.dataset.copied; } }, 2500);
  }

  /** Update the Client ID message and button while typing (no redraw: keeps the cursor). */
  function onClientInput(input) {
    clientDraft = input.value;
    const check = cleanClientId(input.value);
    const msg = root.querySelector('[data-testid="client-msg"]');
    const save = root.querySelector('[data-testid="spotify-client-save"]');
    if (save) save.disabled = !check.ok;
    if (!msg) return;
    // only nag about the length once the user stopped typing a full ID
    const text = check.ok ? '✓ Ziet er goed uit: 32 tekens.' : (input.value && (check.length >= 32 || check.problem === 'chars') ? clientIdMessage(check) : '');
    msg.textContent = text || '';
    msg.className = `wiz-cid-msg ${check.ok ? 'is-ok' : text ? 'set-error' : ''}`;
    msg.dataset.ok = String(check.ok);
  }

  async function paste() {
    const input = root.querySelector('[data-testid="spotify-client-id"]');
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { text = ''; }
    if (!text) {
      toast('Plakken lukt hier niet met de knop. Houd het invoerveld ingedrukt en kies “Plakken”.', { kind: 'warn', ms: 4500 });
      input?.focus();
      return;
    }
    const check = cleanClientId(text);
    clientDraft = check.ok ? check.value : text.trim();
    redraw();
  }

  function saveClient() {
    const input = root.querySelector('[data-testid="spotify-client-id"]');
    const check = cleanClientId(input ? input.value : clientDraft);
    if (!check.ok) {
      clientDraft = input?.value ?? clientDraft;
      redraw();
      return;
    }
    clientDraft = null;
    spotify.clearError();
    spotify.setClientId(check.value);
    toast('Client ID bewaard', { ms: 1800 });
    go(spotify.getSetup()?.mode === 'shared' ? 'connect' : 'users');
  }

  async function connect() {
    spotify.clearError();
    spotify.clearUnfinishedLogin();
    if (spotify.getSetup()) spotify.setSetup({ step: 'connect' }); // back from Spotify: the checks
    try { await spotify.connect(location.hash.startsWith('#/instellingen') ? location.hash : '#/instellingen'); } catch (err) {
      toast(spotify.errorMessage(err), { kind: 'warn', ms: 5000 });
      redraw();
    }
  }

  function saveNewLink() {
    const idEl = root.querySelector('[data-testid="spotify-link-new-id"]');
    const nameEl = root.querySelector('[data-testid="spotify-link-new-name"]');
    linkAdd.id = idEl ? idEl.value : linkAdd.id;
    linkAdd.name = nameEl ? nameEl.value : linkAdd.name;
    const check = cleanClientId(linkAdd.id);
    const links = spotify.getLinks();
    linkAdd.msg = !check.ok ? clientIdMessage(check) || 'Plak hier de Client ID van de nieuwe Spotify-app.'
      : links.some((l) => l.id === check.value) ? 'Deze Client ID staat er al in.'
        : links.length >= LINKS_MAX ? `Je hebt het maximum van ${LINKS_MAX} links.` : '';
    if (linkAdd.msg) { redraw(); return; }
    spotify.setLinks([...links, { id: check.value, name: cleanLinkName(linkAdd.name) }]);
    toast(`${linkLabel(links.length, cleanLinkName(linkAdd.name))} bewaard`, { ms: 2200 });
    linkAdd = { open: false, id: '', name: '', msg: '' };
    redraw();
  }

  function moveLink(id, by) {
    const links = spotify.getLinks();
    const i = links.findIndex((l) => l.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= links.length) return;
    [links[i], links[j]] = [links[j], links[i]];
    spotify.setLinks(links);
  }

  function finish() {
    spotify.setSettings({ source: 'spotify' });
    spotify.setSetup({ step: 'done' });
    draw();
    scrollToSpotify();
  }

  async function copyDetails() {
    const st = spotify.getStatus();
    const text = errorDetails({
      code: st.error, detail: st.detail, redirectUri: spotify.redirectUri(), clientId: spotify.getClientId(), userAgent: navigator.userAgent,
    });
    const ok = await copyText(text);
    toast(ok ? 'Foutdetails gekopieerd' : 'Kopiëren lukte niet.', { ms: 2200 });
  }

  async function onClick(e) {
    const copyBtnEl = e.target.closest('[data-copy]');
    if (copyBtnEl) { onCopy(copyBtnEl); return; }
    const opt = e.target.closest('[data-device-id]');
    if (opt && devices) {
      const d = devices.find((x) => x.id === opt.dataset.deviceId);
      if (d) {
        spotify.setDevice(d);
        try { await spotify.transfer(d.id, false); } catch { /* playing later will tell */ }
      }
      return;
    }
    if (e.target.classList?.contains('sheet-backdrop')) { shareOpen = false; draw(); return; }
    const el = e.target.closest('[data-act]');
    const act = el?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'to-spotify': e.preventDefault(); scrollToSpotify(); break;
      case 'begin': go('dashboard'); break;
      case 'opened': spotify.setSetup({ opened: true }); setTimeout(redraw, 50); break; // the link opens itself
      case 'next': {
        const cur = spotify.getSetup()?.step || 'intro';
        go(cur === 'intro' ? 'dashboard' : nextStep(cur));
        break;
      }
      case 'prev': {
        const cur = spotify.getSetup()?.step || 'intro';
        go(prevStep(cur));
        break;
      }
      case 'later':
        toast('Je voortgang is bewaard. Kom terug via Instellingen → Spotify.', { ms: 3500 });
        location.hash = '#/';
        break;
      case 'goto': {
        const step = el.dataset.step;
        shareOpen = false;
        if (step === 'connect') { spotify.clearError(); if (spotify.getSetup()) go('connect'); else redraw(); break; }
        spotify.clearError();
        go(step);
        break;
      }
      case 'unfinished': {
        const step = el.dataset.step;
        spotify.clearUnfinishedLogin();
        if (step === 'connect') { redraw(); break; }
        go(step);
        break;
      }
      case 'paste': paste(); break;
      case 'save-client': saveClient(); break;
      case 'connect': connect(); break;
      case 'finish': finish(); break;
      case 'to-preview':
        spotify.setSettings({ source: 'preview' });
        toast('Je speelt weer met fragmenten van 30 seconden. Spotify blijft gekoppeld.', { ms: 3000 });
        break;
      case 'use-spotify': spotify.setSettings({ source: 'spotify' }); break;
      case 'close-wizard': spotify.setSetup(null); draw(); scrollToSpotify(); break;
      case 'redo':
        spotify.clearError();
        spotify.setSetup({ step: 'intro', mode: 'own', from: '' });
        draw();
        scrollToSpotify();
        break;
      case 'forget-client':
        spotify.setClientId('');
        spotify.clearError();
        toast('Client ID gewist', { ms: 1800 });
        break;
      case 'disconnect':
        clearTimeout(test.timer);
        if (test.busy) spotify.pause().catch(() => {});
        test = { busy: false, msg: '', timer: 0, kind: '', ok: false };
        devices = null;
        spotify.disconnect();
        break;
      case 'devices': loadDevices(); break;
      case 'test': runTest(); break;
      case 'copy-details': copyDetails(); break;
      case 'share': shareOpen = true; shareFor = null; draw(); break;
      case 'share-close': shareOpen = false; shareFor = null; draw(); break;
      case 'link-share': shareOpen = true; shareFor = el.dataset.id; draw(); break;
      case 'link-add': linkAdd = { open: true, id: '', name: '', msg: '' }; redraw(); root.querySelector('[data-testid="spotify-link-new-id"]')?.focus(); break;
      case 'link-cancel': linkAdd = { open: false, id: '', name: '', msg: '' }; redraw(); break;
      case 'link-save': saveNewLink(); break;
      case 'link-up': case 'link-down': moveLink(el.dataset.id, act === 'link-up' ? -1 : 1); break;
      case 'link-remove': {
        const links = spotify.getLinks();
        const i = links.findIndex((l) => l.id === el.dataset.id);
        if (i < 0 || links.length < 2) break;
        spotify.setLinks(links.filter((l) => l.id !== el.dataset.id));
        toast(`${linkLabel(i, links[i].name)} weggehaald`, { ms: 2200 });
        break;
      }
      case 'share-native': {
        const link = root.querySelector('[data-testid="spotify-share-link"]')?.value;
        if (link) navigator.share({ title: 'TimeTunesr: Spotify-instelling', text: 'Speel hele nummers in TimeTunesr met mijn Spotify-instelling:', url: link }).catch(() => {});
        break;
      }
      default: break;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset?.linkName) { spotify.renameLink(t.dataset.linkName, t.value); return; }
    if (t.matches?.('[data-own-link]')) { spotify.setLinks(spotify.getLinks(), { own: Number(t.value) }); toast('Je logt voortaan zelf in via deze link. Log daarna opnieuw in bij Spotify als dat gevraagd wordt.', { ms: 3500 }); return; }
    if (t.name === 'source') spotify.setSettings({ source: t.value === 'spotify' ? 'spotify' : 'preview' });
    else if (t.name === 'limit') spotify.setSettings({ limit: Number(t.value) });
  }
  function onInput(e) {
    if (e.target.matches('[data-testid="spotify-client-id"]')) onClientInput(e.target);
    if (e.target.matches('[data-testid="spotify-link-new-id"]')) linkAdd.id = e.target.value;
    if (e.target.matches('[data-testid="spotify-link-new-name"]')) linkAdd.name = e.target.value;
  }
  function onKey(e) {
    if (e.key === 'Enter' && e.target.matches('[data-testid="spotify-client-id"]')) { e.preventDefault(); saveClient(); }
    if (e.key === 'Enter' && e.target.matches('[data-testid^="spotify-link-new-"]')) { e.preventDefault(); saveNewLink(); }
    if (e.key === 'Enter' && e.target.dataset?.linkName) { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape' && shareOpen) { shareOpen = false; draw(); }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  const unsub = spotify.subscribe((reason) => {
    if (reason === 'connected') {
      devices = null;
      test = { busy: false, msg: '', timer: 0, kind: '', ok: false };
      loadDevices();
    }
    if (reason === 'disconnected') devices = null;
    redraw();
  });

  // the account lines follow a log-in / log-out (the Client ID itself arrives via spotify.subscribe)
  const offAccount = onLogInOut(() => redraw());

  draw();
  if (spotify.isConnected()) loadDevices();
  if (params[0] === 'spotify') requestAnimationFrame(scrollToSpotify);

  return () => {
    unsub();
    offAccount();
    clearTimeout(test.timer);
    if (test.busy) spotify.pause().catch(() => {});
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKey);
  };
}
