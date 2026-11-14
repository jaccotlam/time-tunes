// Settings (#/instellingen): music source, Spotify connection, device and playing time.
import * as spotify from '../spotify.js';
import * as player from '../player.js';
import { loopbackVersion } from '../pkce.js';
import { icons, esc, toast } from '../ui.js';
import { deviceListHtml, NO_DEVICE_HELP } from './devices.js';

export const name = 'settings';

const TEST_SECONDS = 8;

const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const copyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

export function render(root) {
  let devices = null; // null = not loaded yet
  let devicesBusy = false;
  let devicesMsg = '';
  let clientMsg = '';
  let test = { busy: false, msg: '', timer: 0, kind: '' };
  const userOpen = {}; // <details> the user opened or closed: keep that across re-renders
  const isOpen = (key, def) => ((userOpen[key] ?? def) ? 'open' : '');

  function envWarning(problem) {
    if (problem === 'localhost') {
      const alt = loopbackVersion(location.href);
      return `<div class="warn set-warn" data-testid="spotify-env-warning">
        <p><strong>Spotify accepteert “localhost” niet als terugkeeradres.</strong></p>
        <p>Open de app via <a href="${esc(alt)}">${esc(new URL(alt).host)}</a> en registreer in het Spotify-dashboard het adres dat daar bij Redirect-URI staat.</p>
      </div>`;
    }
    return `<div class="warn set-warn" data-testid="spotify-env-warning">
      <p><strong>Inloggen bij Spotify kan niet op dit adres.</strong></p>
      <p>Spotify werkt alleen als de app via <b>https</b> geopend is (bijvoorbeeld op GitHub Pages), of op de computer zelf via <b>http://127.0.0.1</b>. Via een gewoon http-adres in het thuisnetwerk lukt het niet. De fragmenten van 30 seconden werken wel.</p>
    </div>`;
  }

  function statusHtml(st) {
    if (st.busy === 'connecting') return '<p class="set-status" data-testid="spotify-status">Bezig met verbinden…</p>';
    if (!st.connected) return '<p class="set-status muted" data-testid="spotify-status">Speel hele nummers via de Spotify-app op je telefoon of een speaker.</p>';
    const who = st.profile?.name ? `Verbonden als <b>${esc(st.profile.name)}</b>.` : 'Verbonden met Spotify.';
    const dev = st.device ? `Speelt af op <b>${esc(st.device.name)}</b>.` : 'Nog geen apparaat gekozen.';
    return `<p class="set-status" data-testid="spotify-status">${who} ${dev}</p>`;
  }

  function limitHtml(limit) {
    const opt = (v, label) => `<label class="seg-opt"><input type="radio" name="limit" value="${v}" data-testid="limit-${v}" ${limit === v ? 'checked' : ''}><span>${label}</span></label>`;
    return `<fieldset class="set-field">
      <legend>Afspeelduur per kaart</legend>
      <div class="seg" role="radiogroup">${opt(30, '30 s')}${opt(60, '60 s')}${opt(0, 'Heel nummer')}</div>
      <p class="small muted">Daarna pauzeert Spotify vanzelf. Geldt alleen voor Spotify; fragmenten duren altijd 30 seconden.</p>
    </fieldset>`;
  }

  function devicesHtml(st) {
    let body;
    if (devices === null) body = '<p class="small muted">Apparaten worden opgezocht…</p>';
    else if (!devices.length) body = `<p class="set-empty" data-testid="device-empty">Geen apparaat gevonden. ${esc(NO_DEVICE_HELP)}</p>`;
    else body = deviceListHtml(devices, st.device?.id);
    return `<div class="set-field">
      <div class="set-row"><span class="set-label">Apparaat</span>
        <button class="btn btn-small btn-ghost" type="button" data-act="devices" data-testid="spotify-devices-refresh" ${devicesBusy ? 'disabled' : ''}>${icons.restart}<span>${devicesBusy ? 'Zoeken…' : 'Zoek opnieuw'}</span></button>
      </div>
      ${body}
      ${devicesMsg ? `<p class="set-error" data-testid="device-msg">${esc(devicesMsg)}</p>` : ''}
    </div>`;
  }

  function ownerHtml(st, problem) {
    const own = spotify.getClientId();
    const def = spotify.defaultClientId();
    const uri = spotify.redirectUri();
    return `<details class="set-sub" data-testid="spotify-owner" ${isOpen('spotify-owner', !st.connected)}>
      <summary>Spotify-app van de eigenaar</summary>
      <label class="set-field" for="client-id">
        <span class="set-label">Client ID</span>
        <span class="set-inline">
          <input id="client-id" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false"
            value="${esc(own)}" placeholder="32 tekens" data-testid="spotify-client-id">
          <button class="btn btn-small btn-ghost" type="button" data-act="save-client" data-testid="spotify-client-save">Bewaar</button>
        </span>
        <span class="small muted">${def ? 'Standaard ingevuld door de eigenaar van deze site.' : 'Wordt alleen op dit toestel bewaard. De eigenaar kan hem ook vast invullen in <code>config.js</code>.'}</span>
        ${clientMsg ? `<span class="set-error" data-testid="client-msg">${esc(clientMsg)}</span>` : ''}
      </label>
      <div class="set-field">
        <span class="set-label">Redirect-URI <span class="muted small">(precies zo registreren)</span></span>
        <span class="set-inline">
          <code class="set-code" data-testid="spotify-redirect-uri">${esc(uri)}</code>
          <button class="btn btn-small btn-ghost" type="button" data-act="copy" data-testid="copy-redirect-uri" aria-label="Kopieer de Redirect-URI">${copyIcon}<span>Kopieer</span></button>
        </span>
        ${problem ? '<span class="small muted">Dit adres accepteert Spotify niet; zie de melding hierboven.</span>' : ''}
      </div>
    </details>`;
  }

  function helpHtml() {
    return `<details class="set-help" data-testid="spotify-help" ${isOpen('spotify-help', false)}>
      <summary>Zo koppel je Spotify, stap voor stap</summary>
      <p>Dit regelt de eigenaar van de app één keer. Daarna kunnen maximaal vijf mensen met hun eigen Spotify-account spelen.</p>
      <ol>
        <li>Ga op een computer naar <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> en log in met je Spotify-account (Premium nodig).</li>
        <li>Kies <em>Create app</em>. Vul een naam in (bijvoorbeeld <em>TimeTunesr</em>) en een korte omschrijving.</li>
        <li>Plak bij <em>Redirect URIs</em> precies het adres dat hierboven bij <b>Redirect-URI</b> staat (met de kopieerknop) en klik op <em>Add</em>.</li>
        <li>Vink bij de vraag welke API's je gebruikt <b>Web API</b> aan, ga akkoord met de voorwaarden en klik op <em>Save</em>.</li>
        <li>Open de app in het dashboard, ga naar <em>Settings</em> en kopieer de <b>Client ID</b>. Plak die hierboven en tik op <em>Bewaar</em>. (De <em>Client secret</em> heb je niet nodig.)</li>
        <li>Spelen er anderen met hun eigen account? Voeg ze toe onder <em>User Management</em> met naam en het e-mailadres van hun Spotify-account. Dat kan voor maximaal 5 mensen.</li>
        <li>Tik op <em>Verbind met Spotify</em>, log in en geef toestemming. Kies daarna een apparaat en test het geluid.</li>
      </ol>
      <h3>Goed om te weten</h3>
      <ul>
        <li>Zowel de eigenaar als elke speler heeft <b>Spotify Premium</b> nodig om nummers vanuit een andere app te starten.</li>
        <li>TimeTunesr speelt niet zelf, maar bedient de Spotify-app. <b>Laat de Spotify-app op het toestel openstaan</b> (of kies een speaker). Wordt er niets gevonden? Open Spotify, start even een nummer en kom terug.</li>
        <li>Op het vergrendelscherm, in de meldingen en in de Spotify-app zelf staan titel en artiest. <b>Dus niet spieken!</b> Leg de telefoon met het scherm naar beneden.</li>
        <li>Wordt een nummer niet gevonden op Spotify, of lukt afspelen niet, dan hoor je automatisch het fragment van 30 seconden.</li>
        <li>Op een iPhone heeft de app op het beginscherm een eigen opslag. Verbind daarom vanuit de app zelf, niet vanuit Safari.</li>
      </ul>
    </details>`;
  }

  function draw() {
    const st = spotify.getStatus();
    const settings = spotify.getSettings();
    const problem = spotify.environmentProblem();
    const hasClient = !!spotify.getClientId();
    const focusId = document.activeElement?.dataset?.testid;

    let action = '';
    if (st.connected) {
      action = `<button class="btn btn-secondary" type="button" data-act="test" data-testid="spotify-test" ${test.busy ? 'disabled' : ''}>${icons.play}<span>${test.busy ? 'Test loopt…' : 'Test het geluid'}</span></button>
      ${test.msg ? `<p class="set-test ${test.kind === 'error' ? 'set-error' : ''}" data-testid="spotify-test-msg" role="status">${esc(test.msg)}</p>` : ''}`;
    } else if (problem) {
      action = '';
    } else if (!hasClient) {
      action = '<p class="set-empty" data-testid="spotify-needs-client">Om te verbinden is eerst een <b>Client ID</b> nodig. Vul die hieronder in; de uitleg onderaan vertelt waar je hem vindt.</p>';
    } else {
      action = `<button class="btn btn-primary btn-xl" type="button" data-act="connect" data-testid="spotify-connect" ${st.busy ? 'disabled' : ''}>${spotifyIcon}<span>${st.busy ? 'Bezig met verbinden…' : 'Verbind met Spotify'}</span></button>`;
    }

    const sourceNote = settings.source === 'spotify' && !st.connected
      ? '<p class="set-note" data-testid="source-note">Verbind hieronder met Spotify. Tot dan hoor je fragmenten van 30 seconden.</p>' : '';

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
      </section>

      <section class="set-card" aria-labelledby="set-spotify" data-testid="spotify-block" data-connected="${st.connected}">
        <div class="set-head">
          <h2 id="set-spotify">${spotifyIcon}<span>Spotify</span></h2>
          <span class="pill ${st.connected ? 'pill-on' : ''}" data-testid="spotify-pill">${st.connected ? 'Verbonden' : 'Niet verbonden'}</span>
        </div>
        ${problem ? envWarning(problem) : ''}
        ${statusHtml(st)}
        ${st.error && !st.connected ? `<p class="set-error" data-testid="spotify-error" role="alert">${esc(spotify.errorMessage(st.error))}</p>` : ''}
        ${st.connected ? devicesHtml(st) : ''}
        ${action}
        ${limitHtml(settings.limit)}
        ${ownerHtml(st, problem)}
        ${st.connected ? `<button class="btn btn-ghost btn-small set-disconnect" type="button" data-act="disconnect" data-testid="spotify-disconnect">${icons.close}<span>Verbreek verbinding met Spotify</span></button>` : ''}
      </section>

      ${helpHtml()}

      <a class="btn btn-ghost" href="#/" data-testid="settings-home">${icons.home}<span>Naar start</span></a>
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
      if (!chosen) {
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

  // Keep scroll position when re-rendering after async work.
  function redraw() {
    if (!root.isConnected || root.dataset.route !== name) return;
    const y = window.scrollY;
    draw();
    window.scrollTo(0, y);
  }

  async function runTest() {
    if (test.busy) return;
    player.stop();
    clearTimeout(test.timer);
    test = { busy: true, msg: 'Testgeluid wordt gestart…', timer: 0, kind: '' };
    redraw();
    try {
      const uri = await spotify.findTestTrack();
      const d = await spotify.play(uri, 0);
      test.msg = `Je hoort nu ${TEST_SECONDS} seconden pianomuziek op ${d.name}. Niets te horen? Kijk naar het volume op dat apparaat.`;
      test.timer = setTimeout(() => {
        spotify.pause().catch(() => {});
        test.busy = false;
        test.msg = 'Test klaar. Werkte het? Dan kun je spelen.';
        redraw();
      }, TEST_SECONDS * 1000);
      redraw();
      return;
    } catch (e) {
      test.kind = 'error';
      test.msg = spotify.errorMessage(e);
      if (e.code === 'no-device') devices = e.devices || [];
    }
    test.busy = false;
    redraw();
  }

  async function copyRedirect() {
    const uri = spotify.redirectUri();
    let ok = false;
    try { await navigator.clipboard.writeText(uri); ok = true; } catch { /* fallback below */ }
    if (!ok) {
      const code = root.querySelector('[data-testid="spotify-redirect-uri"]');
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    toast(ok ? 'Redirect-URI gekopieerd' : 'Kopiëren lukte niet; selecteer het adres en kopieer het zelf.', { ms: 2200 });
  }

  function saveClient(fromButton = false) {
    const input = root.querySelector('[data-testid="spotify-client-id"]');
    const v = input.value.trim();
    if (!fromButton && v === spotify.getClientId()) return;
    if (v && !spotify.looksLikeClientId(v)) {
      clientMsg = 'Dit lijkt geen Client ID: die bestaat uit 32 cijfers en letters (a-f).';
      redraw();
      return;
    }
    clientMsg = '';
    spotify.setClientId(v);
    toast(v ? 'Client ID bewaard' : 'Client ID gewist', { ms: 1800 });
  }

  async function onClick(e) {
    const opt = e.target.closest('[data-device-id]');
    if (opt && devices) {
      const d = devices.find((x) => x.id === opt.dataset.deviceId);
      if (d) {
        spotify.setDevice(d);
        try { await spotify.transfer(d.id, false); } catch { /* playing later will tell */ }
      }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'connect') {
      spotify.clearError();
      try { await spotify.connect('#/instellingen'); } catch (err) { toast(spotify.errorMessage(err), { kind: 'warn', ms: 5000 }); redraw(); }
    } else if (act === 'disconnect') {
      clearTimeout(test.timer);
      if (test.busy) spotify.pause().catch(() => {});
      test = { busy: false, msg: '', timer: 0, kind: '' };
      devices = null;
      spotify.disconnect();
    } else if (act === 'devices') loadDevices();
    else if (act === 'test') runTest();
    else if (act === 'copy') copyRedirect();
    else if (act === 'save-client') saveClient(true);
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === 'source') spotify.setSettings({ source: t.value === 'spotify' ? 'spotify' : 'preview' });
    else if (t.name === 'limit') spotify.setSettings({ limit: Number(t.value) });
    else if (t.matches('[data-testid="spotify-client-id"]')) saveClient();
  }
  function onKey(e) {
    if (e.key === 'Enter' && e.target.matches('[data-testid="spotify-client-id"]')) { e.preventDefault(); saveClient(true); }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  const onToggle = (e) => { if (e.target.dataset?.testid) userOpen[e.target.dataset.testid] = e.target.open; };
  root.addEventListener('toggle', onToggle, true);
  const unsub = spotify.subscribe((reason) => {
    if (reason === 'connected') { devices = null; loadDevices(); }
    redraw();
  });

  draw();
  if (spotify.isConnected()) loadDevices();

  return () => {
    unsub();
    clearTimeout(test.timer);
    if (test.busy) spotify.pause().catch(() => {});
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('toggle', onToggle, true);
  };
}
