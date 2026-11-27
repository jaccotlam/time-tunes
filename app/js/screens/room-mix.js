// "Mix van de groep" in a server room: the counts everybody sees (never titles) and the
// panel on every phone (players and the spelleider): "Kies een playlist" (public Deezer
// playlists, no login) and "Doe mijn favorieten erbij" (Spotify top songs, with a login).
// Used by room-player.js and room-host.js; the work itself is in multi/mix-share.js and
// multi/mix-lists.js. Everything from Deezer is escaped here (it is plain text from outside).
import { icons, esc } from '../ui.js';
import { RANGES, SHARE_COUNTS, mixMinimum, rangeLabel, LIST_COUNTS, MIX_LISTS_MAX } from '../multi/mix.js';
import { FEATURED } from '../deezer.js';
import * as top from '../spotify-top.js';
import * as spotify from '../spotify.js';
import { setupHintHtml } from './devices.js';

const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;

export const CONSENT = 'Je deelt een deel van je meest geluisterde nummers met deze kamer; de anderen zien ze pas als ze gespeeld worden.';
export const LISTS_CONSENT = 'Je deelt willekeurige nummers uit de playlists die je kiest met deze kamer; de anderen zien de nummers pas als ze gespeeld worden.';

/** "Mix van de groep: 38 nummers van 3 spelers". */
export function mixCountsText(mix) {
  const total = mix?.total || 0;
  const n = mix?.contributors || 0;
  if (!total) return 'Mix van de groep: nog geen nummers';
  return `Mix van de groep: ${plural(total, 'nummer', 'nummers')} van ${plural(n, 'speler', 'spelers')}`;
}

export function mixCountsHtml(mix) {
  return `<p class="mix-counts" data-testid="mix-counts" data-total="${mix?.total || 0}" data-preview="${mix?.preview || 0}" data-contributors="${mix?.contributors || 0}">${icons.users}<span>${esc(mixCountsText(mix))}</span></p>`;
}

/** What redraws the panel: everything it shows. */
export function mixKey(ms, meta, extra = null) {
  if (!ms) return '';
  const s = ms.state;
  const l = ms.lists?.state;
  const lk = l ? [l.view, l.phase, l.error, l.lists.map((x) => x.id), l.shared.length, l.skipped, l.count, l.read,
    Math.ceil((ms.lists.eta() || 0) / 5), l.searching, l.searchError, l.resultsFor, l.results.map((x) => x.id), l.next, l.linkKind, l.adding, ms.listsOffered()] : null;
  return JSON.stringify([s.phase, s.error, s.done, s.total, s.tracks.length, s.skipped, s.range, s.count, meta?.mix, ms.problem(), lk, extra]);
}

const musicIcon = icons.music;
/** A playlist's cover (Deezer CDN only, see deezer.js), else a music note. */
function coverHtml(p) {
  return p.picture
    ? `<img class="mix-cover" src="${esc(p.picture)}" alt="" width="48" height="48" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="mix-cover mix-cover-none" aria-hidden="true">${musicIcon}</span>`;
}
function listSubHtml(p) {
  const bits = [];
  if (p.count != null) bits.push(plural(p.count, 'nummer', 'nummers'));
  if (p.by) bits.push(`door ${esc(p.by)}`);
  return bits.join(' · ');
}

/** The picker: search by name, quick picks, results, a pasted link (one step on its own). */
function listPickerHtml(l) {
  const results = l.searching && !l.results.length
    ? '<p class="mix-note" data-testid="mix-lists-searching" role="status">Zoeken bij Deezer…</p>'
    : l.searchError ? `<p class="set-error" data-testid="mix-lists-search-error" role="alert">${esc(l.searchError)}</p>`
      : l.resultsFor && !l.results.length ? `<p class="mix-note" data-testid="mix-lists-none">Niets gevonden voor “${esc(l.resultsFor)}”. Probeer een ander woord.</p>`
        : l.results.length ? `<p class="small muted mix-results-for">Playlists bij Deezer voor “${esc(l.resultsFor)}”: tik er een aan.</p>
          <ul class="mix-results" data-testid="mix-lists-results">${l.results.map((p) => {
    const chosen = l.lists.some((x) => x.id === p.id);
    const busy = l.adding === p.id;
    return `<li><button class="mix-result${chosen ? ' is-chosen' : ''}" type="button" data-mix-action="lists-add" data-id="${p.id}" data-testid="mix-lists-result" ${chosen || busy ? 'disabled' : ''}>
              ${coverHtml(p)}<span class="mix-list-txt"><b>${esc(p.title)}</b><small>${listSubHtml(p)}</small></span>
              <span class="mix-result-go">${chosen ? `${icons.check}<span>gekozen</span>` : busy ? '<span>…</span>' : `${icons.plus}<span>Kies</span>`}</span>
            </button></li>`;
  }).join('')}</ul>
          ${l.next != null ? `<button class="btn btn-ghost btn-small" type="button" data-mix-action="lists-more" data-testid="mix-lists-more" ${l.searching ? 'disabled' : ''}>Meer playlists</button>` : ''}` : '';
  return `<div class="mix-pick" data-testid="mix-lists-picker">
      <div class="mix-pick-head">
        <button class="btn btn-ghost btn-small" type="button" data-mix-action="lists-close" data-testid="mix-lists-back">${icons.back}<span>Terug</span></button>
        <h2 class="room-h">Kies een playlist</h2>
      </div>
      <p class="small muted mix-pick-consent" data-testid="mix-lists-consent">${esc(LISTS_CONSENT)}</p>
      <form class="mix-search-form" data-mix-form="search" role="search">
        <label class="pl-label mix-search-label" for="mix-lists-q">Zoek een playlist</label>
        <div class="mix-search">
        <input id="mix-lists-q" type="search" name="q" data-mix-field="q" data-testid="mix-lists-q" value="${esc(l.q)}" placeholder="top 40, jaren 90, hardcore…" autocomplete="off" enterkeyhint="search" maxlength="100">
        <button class="btn btn-primary btn-small" type="submit" data-testid="mix-lists-search">Zoek</button>
        </div>
      </form>
      <div class="mix-quick" data-testid="mix-lists-quick" role="group" aria-label="Snel kiezen">${FEATURED.map((f) => `<button class="mix-chip" type="button" data-mix-action="lists-quick" data-key="${esc(f.key)}" data-testid="mix-lists-quick-${esc(f.key)}"><span aria-hidden="true">${esc(f.emoji)}</span>${esc(f.label)}</button>`).join('')}</div>
      <div class="mix-results-box" aria-live="polite">${results}</div>
      <form class="mix-link" data-mix-form="link">
        <label class="pl-label" for="mix-lists-link">Of plak een link naar een Deezer-playlist</label>
        <div class="mix-link-row">
          <input id="mix-lists-link" type="url" name="link" data-mix-field="link" data-testid="mix-lists-link" value="${esc(l.link)}" inputmode="url" placeholder="deezer.com/…/playlist/…" autocomplete="off" maxlength="500">
          <button class="btn btn-secondary btn-small" type="submit" data-testid="mix-lists-add-link" ${l.adding ? 'disabled' : ''}>Voeg toe</button>
        </div>
      </form>
      ${l.linkMsg ? `<p class="${l.linkKind === 'spotify' || l.linkKind === 'short' ? 'mix-explain' : 'set-error'}" data-testid="mix-lists-link-msg" data-kind="${esc(l.linkKind)}" role="alert">${esc(l.linkMsg)}</p>` : ''}
      <label class="pl-label mix-count-pick">Hoeveel nummers deel je?
        <select data-mix="list-count" data-testid="mix-lists-count">${LIST_COUNTS.map((n) => `<option value="${n}" ${n === l.count ? 'selected' : ''}>${n} nummers</option>`).join('')}</select></label>
    </div>`;
}

/** "Jouw playlists voor deze kamer": the chosen lists, the progress, what is shared. */
function listHomeHtml(ms, meta, { inGame }) {
  const l = ms.lists.state;
  const mine = meta?.mix?.mine ?? 0;
  const lobby = !inGame;
  const items = `<ul class="mix-lists" data-testid="mix-lists-mine">${l.lists.map((p) => `<li class="mix-list" data-testid="mix-lists-item" data-id="${p.id}">
      ${coverHtml(p)}<span class="mix-list-txt"><b>${esc(p.title)}</b><small>${listSubHtml(p)}</small></span>
      ${lobby ? `<button class="icon-btn mix-list-x" type="button" data-mix-action="lists-remove" data-id="${p.id}" data-testid="mix-lists-remove" aria-label="Haal ${esc(p.title)} weg">${icons.close}</button>` : ''}
    </li>`).join('')}</ul>`;
  let progress = '';
  const n = l.shared.length;
  if (l.phase === 'reading') {
    progress = `<div class="pl-progress" data-testid="mix-lists-progress" data-phase="reading" role="status">
        <div class="pl-bar" aria-hidden="true"><i style="width:${l.readTotal ? Math.min(100, Math.round((l.read / l.readTotal) * 100)) : 10}%"></i></div>
        <p class="small">De playlist${l.lists.length === 1 ? '' : 's'} lezen bij Deezer…${l.read ? ` ${l.read} nummers` : ''}</p></div>`;
  } else if (l.phase === 'checking') {
    const eta = ms.lists.eta();
    progress = `<div class="pl-progress" data-testid="mix-lists-progress" data-phase="checking" data-shared="${n}" data-target="${l.count}" role="status">
        <div class="pl-bar" aria-hidden="true"><i style="width:${Math.round((n / l.count) * 100)}%"></i></div>
        <p><b data-testid="mix-lists-progress-text">${n} van ${l.count} nummers nagekeken en gedeeld</b></p>
        <p class="small muted">Van elk nummer zoekt je telefoon het echte jaartal op${eta ? `, nog ongeveer ${eta < 60 ? `${Math.max(5, Math.ceil(eta / 5) * 5)} seconden` : `${Math.ceil(eta / 60)} minuten`}` : ''}. Laat dit scherm open; de nummers gaan vanzelf naar de kamer.</p></div>`;
  } else if (l.phase === 'waiting') {
    progress = `<p class="mix-note" data-testid="mix-lists-waiting">${n ? `${plural(n, 'nummer', 'nummers')} gedeeld. ` : ''}Tijdens het potje wacht het nakijken even; in de lobby gaat het verder.</p>`;
  }
  const done = n || l.phase === 'done' ? `<p class="mix-done" data-testid="mix-done" data-mine="${mine}">${icons.check}<span>Je deelt <b>${plural(mine, 'nummer', 'nummers')}</b> met deze kamer${l.phase === 'checking' || l.phase === 'reading' ? ' (er komen er nog bij)' : ''}.</span></p>` : '';
  const skipped = l.phase === 'done' && l.skipped ? `<p class="small muted" data-testid="mix-lists-skipped">${plural(l.skipped, 'nummer doet', 'nummers doen')} niet mee: geen jaartal dat we konden nakijken.</p>` : '';
  const short = l.phase === 'done' && n < l.count ? `<p class="small muted" data-testid="mix-lists-short">Meer nummers met een nagekeken jaartal stonden er niet in. Kies er gerust nog een playlist bij.</p>` : '';
  const err = l.phase === 'error' ? `<p class="set-error" data-testid="mix-lists-error" role="alert">${esc(l.error)}</p>
      <button class="btn btn-secondary btn-small" type="button" data-mix-action="lists-retry" data-testid="mix-lists-retry">Probeer opnieuw</button>` : '';
  const own = n ? `<details class="mix-mine" data-testid="mix-mine-list"><summary>Bekijk jouw nummers (alleen op dit toestel)</summary>
        <ul>${l.shared.map((t) => `<li><b>${esc(t.title)}</b> · ${esc(t.artist)} · ${esc(t.year)}${t.yearSure ? '' : ' <small class="pl-warn-txt">jaar niet zeker</small>'}</li>`).join('')}</ul></details>` : '';
  const more = lobby && l.lists.length < MIX_LISTS_MAX
    ? `<button class="btn btn-secondary btn-small" type="button" data-mix-action="lists-open" data-testid="mix-lists-add">${icons.plus}<span>Nog een playlist</span></button>` : '';
  return `<h2 class="room-h">Jouw playlists voor deze kamer</h2>
    ${inGame ? '<p class="small muted" data-testid="mix-next-game">Nummers die je nu deelt, doen mee vanaf het volgende potje. Playlists kiezen of weghalen kan weer in de lobby.</p>' : ''}
    ${items}${progress}${done}${skipped}${short}${err}${own}
    <div class="mix-actions">${more}
      <button class="btn btn-ghost btn-small" type="button" data-action="mix-withdraw" data-testid="mix-withdraw">${icons.close}<span>Trek mijn bijdrage in</span></button>
    </div>`;
}

/** The first step: "Kies een playlist" (no login). */
function listStartHtml(inGame) {
  if (inGame) return '<p class="small muted" data-testid="mix-lists-later">Een playlist kiezen voor de mix kan in de lobby, tussen de potjes door.</p>';
  return `<div class="mix-way" data-testid="mix-lists-start">
      <button class="btn btn-primary" type="button" data-mix-action="lists-open" data-testid="mix-lists-open">${musicIcon}<span>Kies een playlist</span></button>
      <p class="small muted">Zonder inloggen: zoek een openbare playlist (Top 40, jaren 90, hardcore…) of plak een Deezer-link. Meer dan één mag.</p>
    </div>`;
}

/**
 * The panel of this phone. ms: createMixShare(); meta: the server's meta (mix counts);
 * inGame: a game is running (new songs count from the next game).
 */
export function mixPanelHtml(ms, meta, { inGame = false, leader = false } = {}) {
  const s = ms.state;
  const offered = !!ms.listsOffered?.();
  const mode = ms.mode?.() || null;
  if (mode === 'lists') {
    const l = ms.lists.state;
    const body = l.view === 'pick' && !inGame ? listPickerHtml(l) : listHomeHtml(ms, meta, { inGame });
    return `<section class="mix-panel" data-testid="mix-panel" data-mode="lists" data-phase="${esc(l.phase)}" data-view="${esc(inGame ? 'home' : l.view)}">${body}</section>`;
  }
  if (offered && mode === null && ms.lists.state.view === 'pick' && !inGame) {
    return `<section class="mix-panel" data-testid="mix-panel" data-mode="lists" data-phase="idle" data-view="pick">${listPickerHtml(ms.lists.state)}</section>`;
  }
  const mineOnServer = meta?.mix?.mine ?? 0;
  const problem = ms.problem();
  const source = ms.clientSource?.() || null;
  let body;
  if (problem === 'no-client') {
    body = leader
      ? `<p class="mix-note" data-testid="mix-no-client">Om favorieten uit Spotify te delen, stel jij als spelleider één keer Spotify in (±5 minuten). Daarna kan iedereen in de kamer meedoen zonder zelf iets in te stellen.</p>
        ${setupHintHtml('mix-setup-hint', 'Open de Spotify-koppelhulp')}`
      : `<p class="mix-note" data-testid="mix-no-client">De spelleider heeft Spotify nog niet ingesteld. Zodra dat gebeurd is (bij Instellingen, ±5 minuten), kun je hier je favorieten delen; zelf hoef je niets in te stellen.</p>
        ${setupHintHtml('mix-setup-hint', 'Of koppel je eigen Spotify')}`;
  } else if (problem && s.phase === 'idle') {
    body = `<p class="mix-note" data-testid="mix-env">${esc(spotify.errorMessage(problem))}</p>`;
  } else if (s.phase === 'connecting') {
    body = '<p class="mix-note" data-testid="mix-connecting" role="status">Inloggen bij Spotify…</p>';
  } else if (s.phase === 'fetching') {
    body = `<p class="mix-note" data-testid="mix-fetching" role="status">Je meest geluisterde nummers ophalen bij Spotify (${esc(rangeLabel(s.range).toLowerCase())})…</p>`;
  } else if (s.phase === 'matching' || s.phase === 'done') {
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
    const running = s.phase === 'matching';
    body = `${running ? `<div class="pl-progress" data-testid="mix-progress" data-done="${s.done}" data-total="${s.total}" role="status">
        <div class="pl-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
        <p class="small">Fragment en jaartal zoeken bij Apple Music: ${s.done} van ${s.total} · ${plural(s.tracks.length, 'nummer', 'nummers')} gedeeld</p>
      </div>` : ''}
      <p class="mix-done" data-testid="mix-done" data-mine="${mineOnServer}">${icons.check}<span>Je deelt <b>${plural(mineOnServer, 'nummer', 'nummers')}</b> met deze kamer${running ? ' (er komen er nog bij)' : ''}.</span></p>
      ${s.skipped ? `<p class="small muted">${plural(s.skipped, 'nummer doet', 'nummers doen')} niet mee: geen jaartal gevonden.</p>` : ''}
      ${s.tracks.length ? `<details class="mix-mine" data-testid="mix-mine-list"><summary>Bekijk jouw nummers (alleen op dit toestel)</summary>
        <ul>${s.tracks.map((t) => `<li><b>${esc(t.title)}</b> · ${esc(t.artist)} · ${esc(t.year)}${t.yearSure ? '' : ' <small class="pl-warn-txt">jaar onzeker</small>'}${t.previewUrl || t.itunesId ? '' : ' <small class="muted">alleen via Spotify</small>'}</li>`).join('')}</ul></details>` : ''}
      <div class="mix-actions">
        <button class="btn btn-ghost btn-small" type="button" data-action="mix-withdraw" data-testid="mix-withdraw">${icons.close}<span>Trek mijn bijdrage in</span></button>
      </div>`;
  } else {
    const opt = (list, cur, label) => list.map((v) => `<option value="${esc(v.key ?? v)}" ${String(v.key ?? v) === String(cur) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
    body = `<p class="mix-consent" data-testid="mix-consent">${esc(CONSENT)}</p>
      <div class="mix-form">
        <label class="pl-label">Periode
          <select data-testid="mix-range" data-mix="range">${opt(RANGES, s.range, (r) => r.label)}</select></label>
        <label class="pl-label">Aantal
          <select data-testid="mix-count" data-mix="count">${opt(SHARE_COUNTS, s.count, (n) => `${n} nummers`)}</select></label>
      </div>
      ${s.error ? `<p class="set-error" data-testid="mix-error" role="alert">${esc(s.error)}</p>` : ''}
      <button class="btn btn-secondary" type="button" data-action="mix-share" data-testid="mix-share">${spotifyIcon}<span>${s.phase === 'error' ? 'Probeer opnieuw' : 'Doe mijn favorieten erbij'}</span></button>
      <p class="small muted" data-testid="mix-login-note" data-client="${esc(source || '')}">De app kiest willekeurig ${s.count} nummers uit je top 50 bij Spotify, zoekt bij Apple Music het fragment en het jaartal op en stuurt ze naar de kamer zodra ze klaar zijn. ${source === 'room' && !leader
    ? 'Je logt zelf in bij Spotify, via de Spotify-instelling van de spelleider. Die moet jouw Spotify-account eerst toevoegen onder “User Management” in het Spotify-dashboard (maximaal 5 accounts).'
    : 'Je logt zelf in bij Spotify, via je eigen Spotify-instelling. Logt iemand anders hier in, dan moet dat account in jouw Spotify-app staan onder “User Management” (maximaal 5 accounts).'}</p>`;
  }
  if (s.error && s.phase !== 'error' && s.phase !== 'idle') body += `<p class="set-error" data-testid="mix-error" role="alert">${esc(s.error)}</p>`;
  const lists = offered && mode === null ? listStartHtml(inGame) : '';
  return `<section class="mix-panel" data-testid="mix-panel" data-mode="${mode === 'top' ? 'top' : ''}" data-phase="${esc(s.phase)}">
    ${lists ? `<h2 class="room-h">Doe mee met de mix</h2>${lists}<h3 class="mix-sub">Of je eigen favorieten uit Spotify <small class="muted">(met inloggen)</small></h3>` : '<h2 class="room-h">Jouw favorieten</h2>'}
    ${inGame ? '<p class="small muted" data-testid="mix-next-game">Nummers die je nu deelt, doen mee vanaf het volgende potje.</p>' : ''}
    ${body}
  </section>`;
}

/** Lobby (and during a game, folded away): counts + this phone's panel. */
export function mixBlockHtml(ms, meta, { inGame = false, music = 'deck', leader = false, shortage = null, gameLabel = '' } = {}) {
  const head = `${mixCountsHtml(meta?.mix)}${music === 'mix' ? `<span class="pill pill-on" data-testid="mix-chosen">${inGame ? 'speelt nu' : 'gekozen'}</span>` : ''}`;
  // the spelleider's lobby: what helps when the mix is still too small to start
  const help = leader && !inGame && shortage?.missing > 0
    ? `<p class="mix-help" data-testid="mix-help" data-missing="${shortage.missing}">${icons.users}<span>Nog ${plural(shortage.missing, 'nummer', 'nummers')} nodig${gameLabel ? ` voor ${esc(gameLabel)}` : ''}. ${ms.listsOffered?.()
      ? '<b>Laat iedereen een playlist kiezen</b> op de eigen telefoon (zonder inloggen), of de Spotify-favorieten delen.'
      : 'Laat spelers op hun eigen telefoon <b>Doe mijn favorieten erbij</b> kiezen.'}</span></p>` : '';
  if (!inGame) return `<div class="mix-block" data-testid="mix-block"><div class="mix-head">${head}</div>${help}${mixPanelHtml(ms, meta, { inGame, leader })}</div>`;
  const open = ['connecting', 'fetching', 'matching', 'error'].includes(ms.state.phase) || ms.lists?.state.phase === 'error';
  return `<details class="mix-block" data-testid="mix-block" ${open ? 'open' : ''}>
    <summary><span class="mix-head">${head}</span><small class="mix-tap muted">${ms.mode?.() === 'lists' ? 'Tik hier om je playlists en je bijdrage te zien.' : 'Tik hier om (ook) je eigen favorieten te delen of in te trekken.'}</small></summary>
    ${mixPanelHtml(ms, meta, { inGame, leader })}
  </details>`;
}

/** Without a room server (PeerJS): explain that the mix needs the server. */
export function mixServerOnlyHtml() {
  return '<p class="muted small mix-note" data-testid="mix-server-only">Mix van de groep (ieders playlists of meest geluisterde nummers) werkt alleen via de kamerserver, niet bij rechtstreeks verbinden.</p>';
}

/** How many songs the leader's choice still needs (0 = enough). */
export function mixShortage(mix, settings, players, source) {
  const have = source === 'spotify' ? mix?.total || 0 : mix?.preview || 0;
  const need = mixMinimum(settings, players);
  return { have, need, missing: Math.max(0, need - have) };
}

/** Handle a change of the period / number selects. True when handled. */
export function onMixChange(ms, e) {
  const t = e.target;
  if (!ms || !t.matches?.('[data-mix]')) return false;
  if (t.dataset.mix === 'list-count') { ms.lists.setCount(Number(t.value)); return true; }
  ms.setChoice(t.dataset.mix === 'range' ? { range: t.value } : { count: Number(t.value) });
  return true;
}

/**
 * The playlist picker's own events on a room screen (root): taps on [data-mix-action], the two
 * forms, typing (kept without a redraw, so the keyboard stays) and a pasted link (added at
 * once). getMs(): the screen's current mix object. Returns a function that removes them.
 */
export function bindMixPanel(root, getMs) {
  const scrollToPanel = () => requestAnimationFrame(() => {
    root.querySelector('[data-testid="mix-panel"]')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  });
  const onClick = (e) => {
    const a = e.target.closest?.('[data-mix-action]');
    const ms = getMs();
    if (!a || !root.contains(a) || !ms?.lists) return;
    e.preventDefault();
    const l = ms.lists;
    switch (a.dataset.mixAction) {
      case 'lists-open': l.open(); scrollToPanel(); break;
      case 'lists-close': l.close(); scrollToPanel(); break;
      case 'lists-quick': l.quick(a.dataset.key); break;
      case 'lists-more': l.more(); break;
      case 'lists-add': l.add(a.dataset.id); scrollToPanel(); break;
      case 'lists-remove': l.remove(a.dataset.id); break;
      case 'lists-retry': l.retry(); break;
      default:
    }
  };
  const onSubmit = (e) => {
    const f = e.target.closest?.('form[data-mix-form]');
    const ms = getMs();
    if (!f || !ms?.lists) return;
    e.preventDefault();
    const input = f.querySelector('[data-mix-field]');
    input?.blur(); // the keyboard goes away: the results are under it
    if (f.dataset.mixForm === 'search') ms.lists.search(input?.value || '');
    else ms.lists.pasted(input?.value || '');
  };
  const onInput = (e) => {
    const t = e.target;
    if (!t.matches?.('[data-mix-field]')) return;
    getMs()?.lists?.typed(t.dataset.mixField, t.value);
  };
  const onPaste = (e) => {
    const t = e.target;
    if (!t.matches?.('[data-mix-field="link"]')) return;
    setTimeout(() => { if (t.isConnected && t.value.trim()) getMs()?.lists?.pasted(t.value); }, 0);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('paste', onPaste);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('paste', onPaste);
  };
}
