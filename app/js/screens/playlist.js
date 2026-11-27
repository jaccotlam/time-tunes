// One own playlist (#/playlists/<id>): add songs (search, paste a list, Spotify),
// correct years, activate, share, export, print, delete.
import * as store from '../playlists.js';
import * as itunes from '../itunes.js';
import * as spotify from '../spotify.js';
import * as spl from '../spotify-playlists.js';
import * as top from '../spotify-top.js';
import * as enrich from '../enrich.js';
import { RANGES, DEFAULT_RANGE, rangeLabel } from '../multi/mix.js';
import {
  parseLines, rankSearch, matchLine, trackFromItunes, itunesYear, readiness, validYear, padN,
  encodeShare, newShareId, exportPlaylist, MIN_TRACKS, MAX_TRACKS, NAME_MAX, parseSpotifyPlaylistId, FUN_MIN, yearPending,
} from '../playlist-logic.js';
import { icons, esc, toast } from '../ui.js';
import { musicSource } from '../deck.js';
import { qrSvg, defaultBaseUrl } from './print.js';
import { setupHintHtml } from './devices.js';
import { accountNoteHtml } from './account-bits.js';
import { readinessInfo, workLine, rowMark, sourceLabel } from './music-bits.js';
import { fetchAndImport, importMessage } from './music-sheet.js';
import { errorMessage as deezerMessage } from '../deezer.js';

export const name = 'playlist';

const SEARCH_DEBOUNCE_MS = 700;
/** Rows drawn at once; the rest of a long list follows in slices (a 2000-song list stays smooth). */
const ROWS_FIRST = 150;
const ROWS_SLICE = 400;
const SEARCH_LIMIT = 25;
/** Longest share URL that still makes a QR code that a phone camera reads from a screen. */
export const QR_MAX = 700;
const QR_MAX_PARTS = 8;
const PRINT_BASE_KEY = 'timetunesr.printBase.v1';
const TAB_KEY = 'timetunesr.playlistTab';
/** Spotify tab: 'playlist' (take over a playlist) or 'top' (my most played songs); kept over the Spotify login. */
const SP_MODE_KEY = 'timetunesr.playlistSpMode';
/** Set by "Maak een playlist van mijn meest geluisterde nummers": { id, range, count } -> fill right away. */
export const TOP_AUTO_KEY = 'timetunesr.playlistTopAuto';
export const TOP_COUNTS = [20, 30, 50];
export const TOP_DEFAULT_COUNT = 30;
const TOP_PREF_KEY = 'timetunesr.topChoice.v1';

const searchIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
const editIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const downloadIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19.5h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const trashIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const listIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.5" fill="currentColor"/><circle cx="4.5" cy="12" r="1.5" fill="currentColor"/><circle cx="4.5" cy="18" r="1.5" fill="currentColor"/></svg>';

const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;

/** Base URL for links and QR codes: the print address when the owner set one (hosted app). */
export function shareBase() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PRINT_BASE_KEY) || 'null'); } catch { /* ignore */ }
  return (typeof saved === 'string' && /^https?:\/\//.test(saved) ? saved : defaultBaseUrl()).split('#')[0];
}
const isLocalBase = (b) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(b);

export function render(root, { params, navigate }) {
  const id = params[0];
  let pl = store.get(id);
  if (!pl) {
    root.innerHTML = `<section class="screen screen-center" data-testid="screen-playlist-missing">
      <div class="panel"><h1>Playlist niet gevonden</h1>
        <p>Deze playlist bestaat niet (meer) op dit toestel.</p>
        <div class="stack"><a class="btn btn-primary" href="#/playlists" data-testid="pl-missing-back">${listIcon}<span>Naar je playlists</span></a></div>
      </div></section>`;
    return null;
  }

  let alive = true;
  let tab = 'search';
  let spMode = 'playlist';
  let topAuto = null; // { range, count }: fill from the top songs as soon as Spotify allows it
  try { // back from the Spotify permission page: open the Spotify tab again
    if (sessionStorage.getItem(TAB_KEY) === 'spotify') tab = 'spotify';
    sessionStorage.removeItem(TAB_KEY);
    if (sessionStorage.getItem(SP_MODE_KEY) === 'top') spMode = 'top';
    sessionStorage.removeItem(SP_MODE_KEY);
    const auto = JSON.parse(sessionStorage.getItem(TOP_AUTO_KEY) || 'null');
    if (auto && auto.id === id) { topAuto = auto; tab = 'spotify'; spMode = 'top'; }
  } catch { /* ignore */ }
  const topPref = (() => {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(TOP_PREF_KEY) || 'null'); } catch { /* ignore */ }
    return {
      range: RANGES.some((r) => r.key === p?.range) ? p.range : DEFAULT_RANGE,
      count: TOP_COUNTS.includes(p?.count) ? p.count : TOP_DEFAULT_COUNT,
    };
  })();
  const tp = {
    busy: false, status: '', error: '',
    range: RANGES.some((r) => r.key === topAuto?.range) ? topAuto.range : topPref.range,
    count: TOP_COUNTS.includes(topAuto?.count) ? topAuto.count : topPref.count,
  };
  let renaming = false;
  const refresh = { busy: false, status: '', ctrl: null }; // "Opnieuw ophalen" of a list with a source
  let filter = '';
  let onlyCheck = false;
  const search = { q: '', last: '', results: [], status: '', busy: false, ctrl: null, timer: 0 };
  const paste = { running: false, ctrl: null, done: 0, total: 0, added: 0, doubts: [], none: [], status: '', waitUntil: 0 };
  const sp = { busy: false, status: '', list: null, error: '' };
  let shareState = null; // { payloads, part, skipped, link }

  root.innerHTML = `<section class="screen screen-playlist" data-testid="screen-playlist" data-id="${esc(id)}">
    <header class="topbar">
      <a class="icon-btn" href="#/playlists" aria-label="Terug naar je playlists" data-testid="pl-back">${icons.back}</a>
      <h1 class="topbar-title">Playlist</h1>
      <span class="topbar-spacer"></span>
    </header>
    <div class="pl-head" data-slot="head"></div>
    <section class="set-card pl-add" aria-labelledby="pl-add-title">
      <h2 id="pl-add-title">Nummers toevoegen</h2>
      <div class="seg pl-tabs" role="tablist" aria-label="Manier van toevoegen">
        ${[['search', 'Zoeken'], ['paste', 'Plak lijst'], ['spotify', 'Spotify']].map(([k, label]) => `<button type="button" role="tab" class="seg-btn" data-act="tab" data-tab="${k}" data-testid="pl-tab-${k}" aria-selected="${k === tab}">${label}</button>`).join('')}
      </div>
      <div class="pl-pane" data-slot="pane"></div>
    </section>
    <section class="pl-list-wrap" aria-labelledby="pl-list-title" data-slot="list"></section>
    <section class="set-card pl-more" aria-label="Delen en meer">
      <h2>Delen en back-up</h2>
      <div class="pl-more-grid">
        <button class="btn btn-ghost btn-small" type="button" data-act="share" data-testid="pl-share">${icons.share}<span>Delen</span></button>
        <a class="btn btn-ghost btn-small" href="#/print/${esc(id)}" data-testid="pl-print">${icons.print}<span>Printen</span></a>
        <button class="btn btn-ghost btn-small" type="button" data-act="export" data-testid="pl-export">${downloadIcon}<span>Exporteren</span></button>
        <button class="btn btn-ghost btn-small pl-danger" type="button" data-act="delete" data-testid="pl-delete">${trashIcon}<span>Verwijderen</span></button>
      </div>
      ${accountNoteHtml('playlists')}
      <p class="small muted"><b>Delen</b>: een link of QR-code voor een ander toestel. <b>Printen</b>: muziekkaartjes waarvan de QR-code op elke telefoon werkt. <b>Exporteren</b>: een back-upbestand (.json) om later terug te zetten.</p>
    </section>
    <div class="answer-slot" data-slot="sheet"></div>
  </section>`;

  const slot = (k) => root.querySelector(`[data-slot="${k}"]`);
  const fresh = () => { pl = store.get(id); return pl; };

  /* ---------- head ---------- */
  function counts() {
    const src = musicSource();
    const deck = store.deckCounts(pl, src);
    const spOnly = pl.tracks.filter((t) => !t.itunesId && !t.deezerId && t.spotifyId && t.match !== 'pending').length;
    return { src, deck, playable: deck.inDeck, spOnly, total: pl.tracks.length, bg: enrich.status(id), spPlayable: store.deckCounts(pl, 'spotify').inDeck };
  }

  /**
   * The status header: how the list plays now (one line, instead of a tag on every row), what
   * the background work is doing, and what the player can do (connect Spotify, fetch again).
   */
  function statusHtml(c) {
    const info = readinessInfo({ counts: c.deck, source: c.src, spotifyPlayable: c.spPlayable, status: c.bg, playNow: pl.playNow === true });
    const r = readiness(c.playable);
    let main;
    if (info.action || info.tone === 'busy') main = `<p class="pl-status-main is-${info.tone}" data-testid="${r.timeline ? 'pl-ready' : 'pl-too-small'}">${esc(info.text)}</p>`;
    else if (!r.timeline) main = `<p class="warn small" data-testid="pl-too-small">Nog te weinig nummers om te spelen: Tijdlijn vraagt er minstens ${MIN_TRACKS.timeline}, Bingo ${MIN_TRACKS.bingo}. Scannen met geprinte kaartjes kan altijd.</p>`;
    else if (!r.bingo) main = `<p class="warn small" data-testid="pl-too-small">Genoeg voor Tijdlijn. Voor Bingo zijn er minstens ${MIN_TRACKS.bingo} nodig: nog ${plural(r.missing, 'nummer', 'nummers')}.</p>`;
    else main = `<p class="pl-status-main is-ok" data-testid="pl-ready">${esc(info.text)}${r.fun ? '' : ` Met ${FUN_MIN} of meer nummers duren de potjes langer.`}</p>`;
    // one progress line while the background worker runs (the Apple Music line keeps its own id)
    const work = workLine(c.bg);
    const apple = c.bg.appleTodo && /^Fragmenten/.test(work);
    const workHtml = work ? `<p class="pl-matching small" data-testid="${apple ? 'pl-match-status' : 'pl-work-status'}" role="status">${esc(work)}…</p>`
      : '';
    const appleHtml = c.bg.appleTodo && !apple ? `<p class="pl-matching small" data-testid="pl-match-status">Fragmenten zoeken… ${c.bg.appleDone} van ${c.bg.appleDone + c.bg.appleTodo}</p>` : '';
    const notes = [];
    if (c.spOnly) notes.push(`<span data-testid="pl-spotify-only">${plural(c.spOnly, 'nummer speelt', 'nummers spelen')} alleen via Spotify</span>`);
    if (pl.source) notes.push(`<span data-testid="pl-source">uit ${esc(sourceLabel(pl))}${pl.source.name && pl.source.name !== pl.name ? `: ${esc(pl.source.name)}` : ''}</span>`);
    const acts = [];
    if (info.action === 'connect') acts.push('<a class="btn btn-secondary btn-small" href="#/instellingen/spotify" data-testid="pl-connect">Verbind Spotify</a>');
    if (pl.source) acts.push(`<button class="btn btn-ghost btn-small" type="button" data-act="refresh-source" data-testid="pl-refresh-source" ${refresh.busy ? 'disabled' : ''}>${icons.restart}<span>${refresh.busy ? 'Bezig…' : 'Opnieuw ophalen'}</span></button>`);
    return `<div class="pl-status-line" data-testid="pl-status-line">
        ${main}${workHtml}${appleHtml}
        ${notes.length ? `<p class="small muted">${notes.join(' · ')}</p>` : ''}
        ${refresh.status ? `<p class="small" role="status" data-testid="pl-refresh-status">${esc(refresh.status)}</p>` : ''}
        ${acts.length ? `<div class="pl-status-acts">${acts.join('')}</div>` : ''}
      </div>`;
  }

  function drawHead() {
    const c = counts();
    const active = store.getActiveId() === id;
    const meta = [plural(c.total, 'nummer', 'nummers')];
    slot('head').innerHTML = `
      ${renaming ? `<form class="pl-rename" data-testid="pl-rename-form" autocomplete="off">
          <input type="text" name="name" maxlength="${NAME_MAX}" value="${esc(pl.name)}" aria-label="Naam van de playlist" data-testid="pl-rename-input" enterkeyhint="done">
          <button class="btn btn-primary btn-small" type="submit" data-testid="pl-rename-save">${icons.check}<span>Bewaar</span></button>
        </form>`
    : `<div class="pl-title-row"><h2 class="pl-name" data-testid="pl-name">${esc(pl.name)}</h2>
          <button class="icon-btn" type="button" data-act="rename" aria-label="Naam wijzigen" data-testid="pl-rename">${editIcon}</button></div>`}
      <p class="pl-meta" data-testid="pl-meta">${meta.join(' · ')}</p>
      ${statusHtml(c)}
      ${active
    ? '<p class="pl-active" data-testid="pl-is-active"><span class="pill pill-on">Actief</span> Je speelt nu met deze playlist.</p>'
    : !c.total ? '' : `<button class="btn btn-secondary" type="button" data-act="activate" data-testid="pl-activate">${icons.play}<span>Speel met deze playlist</span></button>`}`;
    if (renaming) {
      const inp = slot('head').querySelector('input');
      inp.focus();
      inp.select();
    }
  }

  /** Background redraw of the head: not while renaming, and the focused button keeps its focus. */
  function drawHeadKeep() {
    if (renaming) return;
    const head = slot('head');
    const a = document.activeElement;
    const tid = a && head.contains(a) ? a.dataset.testid : null;
    drawHead();
    if (tid) head.querySelector(`[data-testid="${CSS.escape(tid)}"]`)?.focus({ preventScroll: true });
  }

  /** "Opnieuw ophalen": the source list again (new songs are added, fixes stay). */
  async function refreshSource() {
    const src = pl.source;
    if (!src || refresh.busy) return;
    if (src.kind === 'spotify' && !spl.canRead()) {
      refresh.status = 'Om de Spotify-playlist opnieuw op te halen moet de app je playlists mogen lezen: kies hieronder de tab Spotify en geef toestemming.';
      drawHeadKeep();
      return;
    }
    refresh.busy = true;
    refresh.ctrl = new AbortController();
    refresh.status = 'Nummers ophalen…';
    drawHeadKeep();
    try {
      const { res } = await fetchAndImport({ kind: src.kind, id: src.id, name: src.name || pl.name, count: null }, {
        signal: refresh.ctrl.signal,
        onProgress: (read, total) => { refresh.status = `Nummers ophalen… ${read} van ${total}`; if (alive) drawHeadKeep(); },
      });
      if (!alive) return;
      refresh.status = res.error ? (res.error === 'storage' ? store.STORAGE_FULL_MESSAGE : 'Opnieuw ophalen lukte niet.') : importMessage(res);
      if (!res.error) { toast(refresh.status, { ms: 3000 }); enrich.prioritise(id); }
    } catch (e) {
      if (!alive || e?.code === 'aborted') return;
      refresh.status = src.kind === 'spotify' ? spl.errorMessage(e) : deezerMessage(e);
    } finally {
      refresh.busy = false;
    }
    fresh(); drawHeadKeep(); drawList();
  }

  /* ---------- tabs ---------- */
  function drawPane() {
    root.querySelectorAll('[data-act="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const pane = slot('pane');
    pane.dataset.pane = tab;
    if (tab === 'search') {
      pane.innerHTML = `<form class="pl-search" data-testid="pl-search-form" role="search" autocomplete="off">
          <input type="search" name="q" value="${esc(search.q)}" placeholder="Artiest, titel of allebei" aria-label="Zoek een nummer" data-testid="pl-search-input" enterkeyhint="search" autocapitalize="off" spellcheck="false">
          <button class="btn btn-primary btn-small" type="submit" aria-label="Zoek" data-testid="pl-search-go">${searchIcon}</button>
        </form>
        <p class="pl-status small" data-testid="pl-search-status" role="status"></p>
        <ul class="pl-results" data-testid="pl-search-results"></ul>`;
      drawResults();
    } else if (tab === 'paste') {
      drawPaste(true);
    } else {
      drawSpotify();
    }
  }

  /* ---------- search ---------- */
  const hasTrack = (itunesId) => fresh().tracks.some((t) => t.itunesId === itunesId);

  function drawResults() {
    if (tab !== 'search') return;
    const st = slot('pane').querySelector('[data-testid="pl-search-status"]');
    const ul = slot('pane').querySelector('[data-testid="pl-search-results"]');
    if (!st || !ul) return;
    st.textContent = search.status;
    st.classList.toggle('is-error', /niet|fout|wacht|geen verbinding/i.test(search.status) && !search.busy);
    ul.innerHTML = search.results.map((r, i) => {
      const added = hasTrack(Number(r.trackId));
      const y = itunesYear(r);
      return `<li><button type="button" class="pl-result${r.junk >= 0.4 ? ' is-junk' : ''}${added ? ' is-added' : ''}" data-act="add-result" data-i="${i}" data-testid="pl-search-result" data-itunes-id="${esc(r.trackId)}" ${added ? 'aria-disabled="true"' : ''}>
        <span class="pl-r-main"><b>${esc(r.trackName)}</b><span>${esc(r.artistName)}</span><small>${esc(r.collectionName || '')}${y ? ` · ${y}` : ''}</small></span>
        <span class="pl-r-add" aria-hidden="true">${added ? icons.check : icons.plus}</span>
        <span class="sr-only">${added ? 'Staat al in de playlist' : 'Voeg toe'}</span>
      </button></li>`;
    }).join('');
  }

  async function runSearch(q) {
    q = q.trim();
    clearTimeout(search.timer);
    if (q.length < 2) { search.status = q ? 'Typ minstens twee letters.' : ''; search.results = []; drawResults(); return; }
    if (q === search.last && search.results.length) return;
    search.ctrl?.abort();
    const ctrl = new AbortController();
    search.ctrl = ctrl;
    search.busy = true;
    search.status = itunes.pausedFor() > 0 ? 'Even wachten: Apple Music wil niet te veel zoekvragen tegelijk…' : 'Zoeken…';
    drawResults();
    try {
      const raw = await itunes.search(q, { limit: SEARCH_LIMIT, signal: ctrl.signal });
      if (!alive || ctrl !== search.ctrl) return;
      search.last = q;
      search.results = rankSearch(raw, q);
      search.status = search.results.length
        ? `${plural(search.results.length, 'resultaat', 'resultaten')}. Tik op een nummer om het toe te voegen.`
        : `Niets gevonden voor “${q}”. Probeer de artiest en een deel van de titel.`;
    } catch (e) {
      if (!alive || ctrl !== search.ctrl || e.code === 'aborted') return;
      search.status = itunes.errorMessage(e);
    } finally {
      if (ctrl === search.ctrl) search.busy = false;
    }
    drawResults();
  }

  function addResult(i) {
    const r = search.results[i];
    if (!r || hasTrack(Number(r.trackId))) return;
    const t = trackFromItunes(r, search.results);
    const res = store.addTracks(id, [t]);
    if (res.full) { toast(`Een playlist kan maximaal ${MAX_TRACKS} nummers hebben.`, { kind: 'warn' }); return; }
    if (!res.added.length) return;
    const a = res.added[0];
    toast(a.yearSure ? `Toegevoegd: ${a.title} (${a.year})` : `Toegevoegd: ${a.title}. Controleer het jaar (${a.year ?? 'onbekend'}).`, { ms: 2600, kind: a.yearSure ? 'info' : 'warn' });
    fresh();
    drawHead(); drawResults(); drawList();
  }

  /* ---------- paste ---------- */
  function drawPaste(full = false) {
    if (tab !== 'paste') return;
    const pane = slot('pane');
    if (full || !pane.querySelector('textarea')) {
      pane.innerHTML = `<label class="pl-label" for="pl-paste">Plak of typ een lijst, één nummer per regel:</label>
        <textarea id="pl-paste" rows="6" data-testid="pl-paste-input" spellcheck="false" autocapitalize="off" placeholder="ABBA - Dancing Queen&#10;Queen - Bohemian Rhapsody, 1975&#10;Doe Maar - De Bom (1983)"></textarea>
        <p class="small muted">Vorm: <b>Artiest - Titel</b>, eventueel met het jaartal erachter (<em>, 1975</em> of <em>(1975)</em>). Zonder jaartal zoekt de app het jaar zelf op. Apple Music staat ongeveer 20 zoekvragen per minuut toe, dus een lange lijst duurt even.</p>
        <div data-slot="paste-run"></div>`;
    }
    pane.querySelector('textarea').readOnly = paste.running;
    const n = parseLines(pane.querySelector('textarea').value).length;
    const run = pane.querySelector('[data-slot="paste-run"]');
    const pct = paste.total ? Math.round((paste.done / paste.total) * 100) : 0;
    const waiting = paste.waitUntil > Date.now();
    run.innerHTML = `${paste.running ? `<div class="pl-progress" data-testid="pl-paste-progress" role="status">
          <div class="pl-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
          <div class="pl-progress-row"><span>${waiting ? esc(paste.status) : `${paste.done} van ${paste.total} opgezocht · ${plural(paste.added, 'toegevoegd', 'toegevoegd')}`}</span>
          <button class="btn btn-ghost btn-small" type="button" data-act="paste-cancel" data-testid="pl-paste-cancel">${icons.close}<span>Stop</span></button></div>
        </div>`
    : `<button class="btn btn-primary" type="button" data-act="paste-start" data-testid="pl-paste-start" ${n ? '' : 'disabled'}>${searchIcon}<span>${n ? `Zoek ${plural(n, 'nummer', 'nummers')} op` : 'Zoek op'}</span></button>
        ${n > 8 ? `<p class="small muted">Duurt ongeveer ${Math.max(1, Math.round((n * 3.1) / 60))} ${Math.round((n * 3.1) / 60) > 1 ? 'minuten' : 'minuut'}. Je kunt tussendoor stoppen; wat gevonden is, blijft bewaard.</p>` : ''}`}
      ${paste.total ? reportHtml() : ''}`;
  }

  function reportHtml() {
    const parts = [`<b>${plural(paste.added, 'nummer', 'nummers')} toegevoegd</b>`];
    if (paste.doubts.length) parts.push(`${paste.doubts.length} om te controleren`);
    if (paste.none.length) parts.push(`${paste.none.length} niet gevonden`);
    const doubt = paste.doubts.map((d, i) => `<li class="pl-pr is-doubt" data-testid="pl-paste-result" data-status="doubt">
        <span class="pl-pr-line">“${esc(d.line)}”</span>
        <label class="pl-pr-pick"><span>Toegevoegd als:</span>
          <select data-act="paste-choice" data-i="${i}" data-testid="pl-paste-choice">
            ${d.alternatives.map((r, j) => `<option value="${j}" ${j === d.chosen ? 'selected' : ''}>${esc(r.artistName)} – ${esc(r.trackName)}${itunesYear(r) ? ` (${itunesYear(r)})` : ''}</option>`).join('')}
            <option value="-1" ${d.chosen === -1 ? 'selected' : ''}>Niet toevoegen</option>
          </select></label>
      </li>`).join('');
    const none = paste.none.map((d, i) => `<li class="pl-pr is-none" data-testid="pl-paste-result" data-status="none">
        <span class="pl-pr-line">“${esc(d.line)}”</span>
        <span class="pl-pr-why">${esc(d.why || 'Niet gevonden bij Apple Music.')}</span>
        <button class="btn btn-ghost btn-small" type="button" data-act="paste-search" data-i="${i}" data-testid="pl-paste-search">${searchIcon}<span>Zoek zelf</span></button>
      </li>`).join('');
    return `<div class="pl-report" data-testid="pl-paste-report">
      <p data-testid="pl-paste-summary">${parts.join(' · ')}${paste.running ? '' : '.'}</p>
      ${doubt || none ? `<ul class="pl-pr-list">${doubt}${none}</ul>` : ''}
    </div>`;
  }

  async function searchWithRetry(q, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await itunes.search(q, { limit: 15, signal });
      } catch (e) {
        if (e.code === 'aborted' || attempt >= 2 || !['rate', 'unreachable'].includes(e.code)) throw e;
        const wait = e.code === 'rate' ? Math.max(itunes.pausedFor(), 5000) : 20000;
        paste.waitUntil = Date.now() + wait;
        paste.status = e.code === 'rate' ? 'Apple Music vraagt om even te wachten (te veel zoekvragen). We gaan zo verder…' : 'Apple Music reageert even niet. We proberen het zo opnieuw…';
        drawPaste();
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new itunes.ItunesError('aborted')); }, { once: true });
        });
        paste.waitUntil = 0;
      }
    }
  }

  async function startPaste() {
    const ta = slot('pane').querySelector('textarea');
    const lines = parseLines(ta.value);
    if (!lines.length || paste.running) return;
    Object.assign(paste, { running: true, ctrl: new AbortController(), done: 0, total: lines.length, added: 0, doubts: [], none: [], status: '', waitUntil: 0 });
    const signal = paste.ctrl.signal;
    drawPaste();
    let i = 0;
    for (; i < lines.length; i++) {
      if (!alive || signal.aborted) break;
      const line = lines[i];
      let results;
      try {
        results = await searchWithRetry(line.query, signal);
      } catch (e) {
        if (e.code === 'aborted') break;
        paste.none.push({ line: line.raw, query: line.query, why: itunes.errorMessage(e) });
        paste.done++;
        drawPaste();
        continue;
      }
      const m = matchLine(line, results);
      if (m.best) {
        const t = trackFromItunes(m.best, results, { year: line.year });
        const res = store.addTracks(id, [t]);
        if (res.full) { paste.none.push({ line: line.raw, query: line.query, why: `De playlist is vol (max. ${MAX_TRACKS}).` }); }
        else if (res.added.length) {
          paste.added++;
          if (m.status === 'doubt') {
            paste.doubts.push({ line: line.raw, n: res.added[0].n, year: line.year, results, alternatives: m.alternatives.length ? m.alternatives : [m.best], chosen: Math.max(0, m.alternatives.indexOf(m.best)) });
          }
        } else if (res.duplicates) {
          paste.added += 0; // already in the playlist: fine
        }
      } else {
        paste.none.push({ line: line.raw, query: line.query });
      }
      paste.done++;
      fresh();
      drawHead(); drawList(); drawPaste();
    }
    // Lines not looked up (stopped) and lines not found stay in the box, to try again.
    const rest = lines.slice(paste.done).map((l) => l.raw);
    const keep = [...paste.none.map((d) => d.line), ...rest];
    paste.running = false;
    if (alive) {
      const area = slot('pane').querySelector('textarea');
      if (area) area.value = keep.join('\n');
      if (rest.length) toast(`Gestopt. ${plural(paste.added, 'nummer', 'nummers')} toegevoegd; de rest staat nog in het tekstvak.`, { ms: 4000 });
      fresh(); drawHead(); drawList(); drawPaste();
    }
  }

  function pasteChoice(i, value) {
    const d = paste.doubts[i];
    if (!d) return;
    const v = Number(value);
    if (v === d.chosen) return;
    if (v === -1) {
      store.removeTrack(id, d.n);
    } else {
      const r = d.alternatives[v];
      const t = trackFromItunes(r, d.results, { year: d.year });
      if (fresh().tracks.some((x) => x.n === d.n)) {
        if (!store.replaceTrack(id, d.n, t)) { toast('Dat nummer staat al in de playlist.', { kind: 'warn' }); drawPaste(); return; }
      } else {
        const res = store.addTracks(id, [t]);
        if (res.added[0]) d.n = res.added[0].n;
      }
    }
    d.chosen = v;
    fresh(); drawHead(); drawList(); drawPaste();
  }

  /* ---------- Spotify ---------- */
  function drawSpotify() {
    if (tab !== 'spotify') return;
    const pane = slot('pane');
    const modes = `<div class="seg pl-sp-modes" role="group" aria-label="Wat neem je over uit Spotify?">
        <button type="button" class="seg-btn" data-act="sp-mode" data-mode="playlist" data-testid="pl-sp-mode-playlist" aria-pressed="${spMode === 'playlist'}">Playlist overnemen</button>
        <button type="button" class="seg-btn" data-act="sp-mode" data-mode="top" data-testid="pl-sp-mode-top" aria-pressed="${spMode === 'top'}">Mijn meest geluisterd</button>
      </div>`;
    pane.innerHTML = modes + (spMode === 'top' ? topHtml() : playlistPaneHtml());
  }

  function topHtml() {
    const note = `<p class="small muted pl-sp-note" data-testid="pl-top-note">Spotify kent je meest geluisterde nummers per periode. Het jaartal van Spotify is soms dat van een heruitgave of verzamelalbum; daarom zoekt de app elk nummer ook op bij Apple Music, voor het fragment én het vroegste jaar. Twijfel? Dan staat er <b>controleer het jaar</b>. Wat Apple Music niet heeft, speelt alleen via Spotify. Zolang de Spotify-app van de eigenaar in Development Mode staat, moet jouw account daar zijn toegevoegd (maximaal 5).</p>`;
    if (!top.canRead()) {
      if (!spotify.getClientId()) return `<p class="set-empty" data-testid="pl-top-no-client">${esc(top.MESSAGES['no-client'])}</p>${setupHintHtml('pl-setup-hint')}${note}`;
      const connected = spotify.isConnected();
      return `<p class="set-empty" data-testid="pl-top-scope">${connected
        ? 'Je bent verbonden met Spotify, maar de app mag je meest geluisterde nummers nog niet lezen. Geef daarvoor één keer opnieuw toestemming; je komt daarna hier terug.'
        : 'Log in bij Spotify om je meest geluisterde nummers op te halen. Je komt daarna hier terug.'}</p>
        ${tp.error ? `<p class="set-error" data-testid="pl-top-error" role="alert">${esc(tp.error)}</p>` : ''}
        <button class="btn btn-primary" type="button" data-act="top-connect" data-testid="pl-top-connect">${spotifyIcon}<span>${connected ? 'Geef toestemming' : 'Log in bij Spotify'}</span></button>${note}`;
    }
    const opt = (list, cur, label) => list.map((v) => `<option value="${esc(v.key ?? v)}" ${String(v.key ?? v) === String(cur) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
    return `<form class="pl-top" data-testid="pl-top-form" autocomplete="off">
        <div class="pl-top-row">
          <label class="pl-label">Periode
            <select name="range" data-testid="pl-top-range" ${tp.busy ? 'disabled' : ''}>${opt(RANGES, tp.range, (r) => r.label)}</select></label>
          <label class="pl-label">Aantal
            <select name="count" data-testid="pl-top-count" ${tp.busy ? 'disabled' : ''}>${opt(TOP_COUNTS, tp.count, (n) => `${n} nummers`)}</select></label>
        </div>
        <button class="btn btn-primary" type="submit" data-testid="pl-top-import" ${tp.busy ? 'disabled' : ''}>${spotifyIcon}<span>${tp.busy ? 'Bezig…' : 'Haal mijn top op'}</span></button>
      </form>
      ${tp.status ? `<p class="pl-status small" data-testid="pl-top-status" role="status">${esc(tp.status)}</p>` : ''}
      ${tp.error ? `<p class="set-error" data-testid="pl-top-error" role="alert">${esc(tp.error)}</p>` : ''}
      ${note}`;
  }

  async function topImport() {
    if (tp.busy) return;
    tp.busy = true; tp.error = ''; tp.status = `Je meest geluisterde nummers ophalen (${rangeLabel(tp.range).toLowerCase()})…`;
    try { localStorage.setItem(TOP_PREF_KEY, JSON.stringify({ range: tp.range, count: tp.count })); } catch { /* ignore */ }
    drawSpotify();
    try {
      const tracks = await top.topTracks({ range: tp.range, limit: tp.count });
      if (!alive) return;
      const res = store.addTracks(id, tracks.map((t) => ({
        spotifyId: t.spotifyId, title: t.title, artist: t.artist, album: t.album, year: t.spYear, yearSure: false, match: 'pending',
      })));
      tp.status = `${plural(res.added.length, 'nummer', 'nummers')} uit je meest geluisterde (${rangeLabel(tp.range).toLowerCase()}) toegevoegd${res.duplicates ? ` (${res.duplicates} stonden er al in)` : ''}${res.full ? `; de playlist is vol (max. ${MAX_TRACKS})` : ''}. Fragmenten en jaartallen worden nu opgezocht.`;
      fresh(); drawHead(); drawList();
      enrich.prioritise(id);
    } catch (e) {
      if (!alive) return;
      tp.status = '';
      tp.error = top.errorMessage(e);
    } finally {
      tp.busy = false;
      if (alive) drawSpotify();
    }
  }

  function topConnect() {
    try {
      sessionStorage.setItem(TAB_KEY, 'spotify');
      sessionStorage.setItem(SP_MODE_KEY, 'top');
      sessionStorage.setItem(TOP_AUTO_KEY, JSON.stringify({ id, range: tp.range, count: tp.count }));
    } catch { /* ignore */ }
    spotify.connect(`#/playlists/${id}`, { top: true }).catch((err) => {
      try { sessionStorage.removeItem(TOP_AUTO_KEY); } catch { /* ignore */ }
      tp.error = top.errorMessage(err);
      drawSpotify();
    });
  }

  /** Back from the Spotify login (or from the quick start on the playlists screen): fill right away. */
  function maybeAutoTop() {
    if (!topAuto || !alive) return;
    const st = spotify.getStatus();
    if (st.busy === 'connecting') return; // the token exchange is still running
    topAuto = null;
    try { sessionStorage.removeItem(TOP_AUTO_KEY); } catch { /* ignore */ }
    if (top.canRead()) { topImport(); return; }
    if (st.error) { tp.error = top.errorMessage({ code: st.error }); drawSpotify(); }
  }

  function playlistPaneHtml() {
    const limits = `<p class="small muted pl-sp-note" data-testid="pl-spotify-limits">Spotify geeft alleen de nummers van playlists die je <b>zelf hebt gemaakt of waaraan je meewerkt</b>; playlists van anderen (ook die van Spotify zelf) kan de app niet lezen. Voor de fragmenten van 30 seconden zoekt de app elk nummer daarna op bij Apple Music; wat daar niet te vinden is, speelt alleen via Spotify.</p>`;
    if (!spotify.isConnected()) {
      return `<p class="set-empty" data-testid="pl-spotify-off">Om een Spotify-playlist over te nemen, koppel je eerst Spotify bij <a href="#/instellingen" data-testid="pl-spotify-settings">Instellingen</a>.</p>${spotify.getClientId() ? '' : setupHintHtml('pl-setup-hint')}${limits}`;
    }
    if (!spl.canRead()) {
      return `<p class="set-empty" data-testid="pl-spotify-scope">Je bent verbonden met Spotify, maar de app mag je playlists nog niet lezen. Geef daarvoor één keer opnieuw toestemming; je komt daarna hier terug.</p>
        <button class="btn btn-primary" type="button" data-act="sp-connect" data-testid="pl-spotify-connect">${spotifyIcon}<span>Geef toestemming voor playlists</span></button>${limits}`;
    }
    return `<form class="pl-search" data-testid="pl-spotify-form" autocomplete="off">
        <input type="text" name="link" placeholder="Link van een Spotify-playlist" aria-label="Link of ID van de Spotify-playlist" data-testid="pl-spotify-input" autocapitalize="off" spellcheck="false" ${sp.busy ? 'disabled' : ''}>
        <button class="btn btn-primary btn-small" type="submit" data-testid="pl-spotify-import" ${sp.busy ? 'disabled' : ''}>Haal op</button>
      </form>
      <p class="small muted">In Spotify: <em>Delen → Link naar playlist kopiëren</em>, en hier plakken.</p>
      <button class="btn btn-ghost btn-small" type="button" data-act="sp-mine" data-testid="pl-spotify-mine" ${sp.busy ? 'disabled' : ''}>${listIcon}<span>Kies uit mijn playlists</span></button>
      ${sp.status ? `<p class="pl-status small" data-testid="pl-spotify-status" role="status">${esc(sp.status)}</p>` : ''}
      ${sp.error ? `<p class="set-error" data-testid="pl-spotify-error" role="alert">${esc(sp.error)}</p>` : ''}
      ${sp.list ? (sp.list.length ? `<ul class="pl-sp-list" data-testid="pl-spotify-list">${sp.list.map((p) => `<li><button type="button" class="pl-result" data-act="sp-pick" data-sp-id="${esc(p.id)}" data-testid="pl-spotify-option">
          <span class="pl-r-main"><b>${esc(p.name)}</b>${p.count != null ? `<small>${plural(p.count, 'nummer', 'nummers')}</small>` : ''}</span><span class="pl-r-add" aria-hidden="true">${icons.plus}</span></button></li>`).join('')}</ul>`
    : '<p class="set-empty">Geen eigen of gezamenlijke playlists gevonden.</p>') : ''}
      ${limits}`;
  }

  async function spotifyImport(input) {
    const pid = parseSpotifyPlaylistId(input);
    if (!pid) { sp.error = 'Dit is geen link naar een Spotify-playlist. Kopieer in Spotify de link via Delen.'; drawSpotify(); return; }
    sp.busy = true; sp.error = ''; sp.status = 'Playlist ophalen bij Spotify…'; drawSpotify();
    try {
      const meta = await spl.playlistName(pid).catch((e) => { if (e.code === 'scope' || e.code === 'not-found' || e.code === 'session') throw e; return { name: 'Spotify-playlist' }; });
      const tracks = await spl.playlistTracks(pid, {
        onProgress: (n, total) => { sp.status = `Nummers ophalen: ${n} van ${total}…`; drawSpotify(); },
      });
      if (!alive) return;
      const res = store.addTracks(id, tracks.map((t) => ({
        spotifyId: t.spotifyId, title: t.title, artist: t.artist, album: t.album, year: t.spYear, yearSure: false, match: 'pending',
      })));
      sp.status = `${plural(res.added.length, 'nummer', 'nummers')} uit “${meta.name}” toegevoegd${res.duplicates ? ` (${res.duplicates} stonden er al in)` : ''}${res.full ? `; de playlist is vol (max. ${MAX_TRACKS})` : ''}. De fragmenten worden nu opgezocht.`;
      sp.list = null;
      fresh(); drawHead(); drawList();
      enrich.prioritise(id);
    } catch (e) {
      if (!alive) return;
      sp.status = '';
      sp.error = spl.errorMessage(e);
    } finally {
      sp.busy = false;
      if (alive) drawSpotify();
    }
  }

  async function spotifyMine() {
    sp.busy = true; sp.error = ''; sp.status = 'Je playlists ophalen…'; drawSpotify();
    try {
      sp.list = await spl.myPlaylists();
      sp.status = '';
    } catch (e) {
      sp.status = '';
      sp.error = spl.errorMessage(e);
    } finally {
      sp.busy = false;
      if (alive) drawSpotify();
    }
  }

  /* ---------- background: years and fragments (app-wide worker in enrich.js) ---------- */
  // The worker writes to the store; redraw at most every ~0.5 s so a long list stays smooth.
  let bgTimer = 0;
  const unsubEnrich = enrich.subscribe(() => {
    if (!alive || bgTimer) return;
    bgTimer = setTimeout(() => {
      bgTimer = 0;
      if (!alive || !fresh()) return;
      drawHeadKeep(); drawList({ patch: true });
    }, 400);
  });

  /* ---------- track list ---------- */
  let listGen = 0; // a newer drawList stops the slices of an older one
  /** A row only gets a mark where the player can do something (see rowMark in music-bits.js). */
  const markOf = (t) => rowMark(t, { pending: yearPending(t), fromSource: !!pl.source });
  const rowKey = (t) => `${t.n}|${t.year}|${markOf(t)}|${t.title}|${t.artist}`;

  function trackRow(t) {
    const yearOk = validYear(t.year);
    const mark = markOf(t);
    const tags = [];
    if (mark === 'missing') tags.push('<span class="pl-tag is-warn" data-testid="pl-year-warn">vul het jaar in</span>');
    else if (mark === 'unsure') tags.push('<span class="pl-tag is-soft" data-testid="pl-year-warn" title="Het jaartal is niet zeker: controleer het">jaar?</span>');
    return `<li class="pl-track${mark === 'missing' ? ' is-check' : mark === 'unsure' ? ' is-unsure' : ''}" data-testid="pl-track" data-n="${t.n}">
      <span class="pl-num" aria-hidden="true">${padN(t.n)}</span>
      <span class="pl-info"><b class="pl-title">${esc(t.title || 'Onbekende titel')}</b><span class="pl-artist">${esc(t.artist || 'Onbekende artiest')}</span>${tags.length ? `<span class="pl-tags">${tags.join('')}</span>` : ''}</span>
      <input class="pl-year" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${yearOk ? t.year : ''}" placeholder="jaar" aria-label="Jaar van ${esc(t.title)}" data-testid="pl-year" data-n="${t.n}">
      <button class="icon-btn pl-x" type="button" data-act="remove-track" data-n="${t.n}" aria-label="Verwijder ${esc(t.title)}" data-testid="pl-track-remove">${icons.close}</button>
    </li>`;
  }

  let drawn = null; // { keys: Map<n, rowKey>, order: 'n,n,...' } of the rows on screen
  function drawList({ patch = false } = {}) {
    const list = slot('list');
    const total = pl.tracks.length;
    const needle = filter.trim().toLowerCase();
    const shown = pl.tracks
      .filter((t) => !onlyCheck || markOf(t))
      .filter((t) => !needle || `${t.title} ${t.artist} ${t.year ?? ''}`.toLowerCase().includes(needle));
    const nCheck = pl.tracks.filter((t) => markOf(t)).length;
    // background updates: only the rows that changed are drawn again (a 2000-song list stays calm)
    const order = shown.map((t) => t.n).join(',');
    if (patch && drawn && drawn.order === order && list.querySelector('.pl-list-head') && drawn.complete) {
      const ol = list.querySelector('[data-testid="pl-tracks"]');
      for (const t of shown) {
        const k = rowKey(t);
        if (drawn.keys.get(t.n) === k) continue;
        const li = ol.querySelector(`[data-testid="pl-track"][data-n="${t.n}"]`);
        if (!li || li.contains(document.activeElement)) continue; // never under the player's fingers
        li.outerHTML = trackRow(t);
        drawn.keys.set(t.n, k);
      }
      updateOnly(list, nCheck);
      return;
    }
    const focus = document.activeElement;
    const keepFilterFocus = focus?.dataset?.testid === 'pl-filter';
    const caret = keepFilterFocus ? focus.selectionStart : 0;
    if (!list.querySelector('.pl-list-head') || (total > 10) !== !!list.querySelector('[data-testid="pl-filter"]')) {
      list.innerHTML = `<div class="pl-list-head">
          <h2 id="pl-list-title" data-testid="pl-count"></h2>
          ${total > 10 ? `<input type="search" class="pl-filter" placeholder="Zoek in de lijst" aria-label="Zoek in de lijst" data-testid="pl-filter" value="${esc(filter)}">` : ''}
        </div>
        <label class="pl-only" data-slot="only" data-testid="pl-filter-unsure"><input type="checkbox" data-act="only-check" data-testid="pl-only-check"> <span></span></label>
        <ol class="pl-tracks" data-testid="pl-tracks"></ol>
        <p class="set-empty" data-slot="empty" hidden></p>`;
    }
    updateOnly(list, nCheck);
    // 2000 rows: the first ones at once, the rest in slices after it, so a change never blocks the screen
    const rows = shown.slice().reverse();
    const ol = list.querySelector('[data-testid="pl-tracks"]');
    const gen = ++listGen;
    drawn = { order, keys: new Map(), complete: rows.length <= ROWS_FIRST };
    const rowsHtml = (part) => part.map((t) => { drawn.keys.set(t.n, rowKey(t)); return trackRow(t); }).join('');
    ol.innerHTML = rowsHtml(rows.slice(0, ROWS_FIRST));
    let at = ROWS_FIRST;
    const more = () => {
      if (gen !== listGen || !alive || at >= rows.length) return;
      ol.insertAdjacentHTML('beforeend', rowsHtml(rows.slice(at, at + ROWS_SLICE)));
      at += ROWS_SLICE;
      if (at >= rows.length) drawn.complete = true;
      setTimeout(more, 0);
    };
    if (at < rows.length) setTimeout(more, 0);
    const empty = list.querySelector('[data-slot="empty"]');
    empty.hidden = shown.length > 0;
    empty.textContent = total ? 'Geen nummers die hierbij passen.' : 'Nog geen nummers. Zoek hierboven een nummer of plak een lijst.';
    if (keepFilterFocus) {
      const f = list.querySelector('[data-testid="pl-filter"]');
      f?.focus(); f?.setSelectionRange(caret, caret);
    }
  }

  function updateOnly(list, nCheck) {
    list.querySelector('[data-testid="pl-count"]').textContent = pl.tracks.length ? `Nummers (${pl.tracks.length})` : 'Nummers';
    const only = list.querySelector('[data-slot="only"]');
    only.hidden = !nCheck && !onlyCheck;
    only.querySelector('input').checked = onlyCheck;
    only.querySelector('span').textContent = `Toon alleen twijfeljaren (${nCheck})`;
  }

  function setYear(input) {
    const n = Number(input.dataset.n);
    const t = fresh().tracks.find((x) => x.n === n);
    if (!t) return;
    const v = input.value.trim();
    const y = Number(v);
    if (!validYear(y)) {
      input.value = validYear(t.year) ? t.year : '';
      if (v) toast(`Vul een jaartal in tussen 1900 en ${new Date().getFullYear()}.`, { kind: 'warn' });
      return;
    }
    if (y === t.year && t.yearSure) return;
    store.fixYear(id, n, y); // the player's own year: background work never changes it
    fresh();
    const li = input.closest('.pl-track');
    if (li) li.outerHTML = trackRow(fresh().tracks.find((x) => x.n === n));
    drawHead();
    if (drawn) drawn.keys.set(n, rowKey(fresh().tracks.find((x) => x.n === n)));
    updateOnly(slot('list'), pl.tracks.filter((x) => markOf(x)).length);
    toast(`Jaar opgeslagen: ${y}`, { ms: 1600 });
  }

  /* ---------- share ---------- */
  function shareHtml() {
    const s = shareState;
    const qr = s.qrParts;
    let qrBlock;
    if (!qr) {
      qrBlock = `<p class="set-empty" data-testid="pl-share-noqr">Deze playlist is te groot voor QR-codes. Stuur de link (bijvoorbeeld via een berichtenapp) naar het andere toestel.</p>`;
    } else {
      const part = s.part;
      qrBlock = `<div class="pl-qr" data-testid="pl-share-qr" data-part="${part + 1}" data-parts="${qr.length}">${qrSvg(qr[part], { ecl: 'L' })}</div>
        ${qr.length > 1 ? `<div class="pl-qr-nav">
          <button class="icon-btn" type="button" data-act="share-prev" aria-label="Vorige code" data-testid="pl-share-prev" ${part === 0 ? 'disabled' : ''}>${icons.back}</button>
          <span data-testid="pl-share-part">Code ${part + 1} van ${qr.length}</span>
          <button class="icon-btn pl-flip" type="button" data-act="share-next" aria-label="Volgende code" data-testid="pl-share-next" ${part === qr.length - 1 ? 'disabled' : ''}>${icons.back}</button>
        </div>
        <p class="small muted">De playlist is verdeeld over ${qr.length} codes. Scan ze allemaal met hetzelfde toestel; elke code voegt een deel toe.</p>` : ''}`;
    }
    return `<div class="sheet-backdrop" data-testid="pl-share-sheet">
      <div class="sheet pl-share" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <h2 id="share-title">Deel “${esc(pl.name)}”</h2>
        <p class="small">Scan de code met de camera van een andere telefoon, of stuur de link. Het andere toestel vraagt eerst of de playlist erbij mag.</p>
        ${qrBlock}
        <label class="pl-label" for="share-link">Link</label>
        <div class="pl-search"><input id="share-link" type="text" readonly value="${esc(s.link)}" data-testid="pl-share-link">
          <button class="btn btn-primary btn-small" type="button" data-act="share-copy" data-testid="pl-share-copy">Kopieer</button></div>
        ${navigator.share ? `<button class="btn btn-ghost btn-small" type="button" data-act="share-native" data-testid="pl-share-native">${icons.share}<span>Stuur via…</span></button>` : ''}
        ${s.skipped ? `<p class="warn small" data-testid="pl-share-skipped">${plural(s.skipped, 'nummer gaat', 'nummers gaan')} niet mee: zonder Apple Music-fragment of zonder jaar.</p>` : ''}
        ${isLocalBase(s.base) ? '<p class="warn small">Let op: dit is een lokaal adres. Een ander toestel kan het alleen openen in hetzelfde netwerk.</p>' : ''}
        <button class="btn btn-ghost" type="button" data-act="share-close" data-testid="pl-share-close">${icons.close}<span>Sluiten</span></button>
      </div>
    </div>`;
  }

  function openShare() {
    const base = shareBase();
    const prefix = `${base}#/pl/`;
    if (!pl.shareId) store.patchPlaylist(id, { shareId: newShareId() });
    const sid = fresh().shareId;
    const one = encodeShare(pl, { shareId: sid });
    if (!one.shared) { toast('Er zijn nog geen nummers om te delen.', { kind: 'warn' }); return; }
    let qrParts = null;
    if (prefix.length + one.payloads[0].length <= QR_MAX) qrParts = one.payloads.map((p) => prefix + p);
    else {
      const split = encodeShare(pl, { shareId: sid, maxLen: QR_MAX - prefix.length });
      if (split.payloads.length <= QR_MAX_PARTS) qrParts = split.payloads.map((p) => prefix + p);
    }
    shareState = { link: prefix + one.payloads[0], qrParts, part: 0, skipped: one.skipped, base };
    slot('sheet').innerHTML = shareHtml();
    slot('sheet').querySelector('[data-act="share-close"]').focus();
  }

  async function copyLink() {
    const input = slot('sheet').querySelector('[data-testid="pl-share-link"]');
    let ok = false;
    try { await navigator.clipboard.writeText(shareState.link); ok = true; } catch { /* fallback */ }
    if (!ok) { input.select(); try { ok = document.execCommand('copy'); } catch { ok = false; } }
    toast(ok ? 'Link gekopieerd' : 'Kopiëren lukte niet; selecteer de link en kopieer hem zelf.', { ms: 2200 });
  }

  /* ---------- export ---------- */
  function exportFile() {
    const data = JSON.stringify(exportPlaylist(pl), null, 1);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    const slug = pl.name.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'playlist';
    a.href = URL.createObjectURL(blob);
    a.download = `timetunesr-${slug}.json`;
    a.dataset.testid = 'pl-export-link';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Back-up gedownload', { ms: 2000 });
  }

  /* ---------- events ---------- */
  function onClick(e) {
    const a = e.target.closest('[data-act]');
    if (!a || !root.contains(a)) return;
    const act = a.dataset.act;
    switch (act) {
      case 'tab':
        if (tab === a.dataset.tab) return;
        tab = a.dataset.tab;
        drawPane();
        if (tab === 'search') slot('pane').querySelector('input')?.focus();
        break;
      case 'add-result': addResult(Number(a.dataset.i)); break;
      case 'paste-start': startPaste(); break;
      case 'paste-cancel': paste.ctrl?.abort(); break;
      case 'paste-search': {
        const d = paste.none[Number(a.dataset.i)];
        tab = 'search';
        search.q = d?.query || '';
        drawPane();
        runSearch(search.q);
        break;
      }
      case 'sp-connect':
        try { sessionStorage.setItem(TAB_KEY, 'spotify'); } catch { /* ignore */ }
        spotify.connect(`#/playlists/${id}`, { playlists: true }).catch((err) => toast(spotify.errorMessage(err), { kind: 'warn', ms: 5000 }));
        break;
      case 'sp-mine': spotifyMine(); break;
      case 'sp-mode':
        if (spMode === a.dataset.mode) return;
        spMode = a.dataset.mode === 'top' ? 'top' : 'playlist';
        drawSpotify();
        break;
      case 'top-connect': topConnect(); break;
      case 'sp-pick': spotifyImport(a.dataset.spId); break;
      case 'remove-track': {
        const n = Number(a.dataset.n);
        const t = fresh().tracks.find((x) => x.n === n);
        if (!t) return;
        store.removeTrack(id, n);
        fresh(); drawHead(); drawList(); drawResults();
        toast(`Verwijderd: ${t.title}`, { ms: 1800 });
        break;
      }
      case 'rename': renaming = true; drawHead(); break;
      case 'refresh-source': refreshSource(); break;
      case 'activate':
        store.setActive(id);
        toast(`Je speelt nu met “${pl.name}”.`, { ms: 2400 });
        drawHead();
        break;
      case 'share': openShare(); break;
      case 'share-close': slot('sheet').innerHTML = ''; shareState = null; break;
      case 'share-prev': case 'share-next':
        shareState.part = Math.max(0, Math.min(shareState.qrParts.length - 1, shareState.part + (act === 'share-next' ? 1 : -1)));
        slot('sheet').innerHTML = shareHtml();
        slot('sheet').querySelector(`[data-act="${act}"]:not(:disabled)`)?.focus();
        break;
      case 'share-copy': copyLink(); break;
      case 'share-native':
        navigator.share({ title: `TimeTunesr: ${pl.name}`, url: shareState.link }).catch(() => {});
        break;
      case 'export': exportFile(); break;
      case 'delete':
        if (window.confirm(`Playlist “${pl.name}” met ${plural(pl.tracks.length, 'nummer', 'nummers')} verwijderen? Dit kan niet ongedaan worden gemaakt.`)) {
          const nm = pl.name;
          alive = false;
          store.remove(id);
          toast(`“${nm}” is verwijderd.`, { ms: 2400 });
          navigate('#/playlists');
        }
        break;
      default:
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    if (f.matches('[data-testid="pl-search-form"]')) runSearch(f.elements.q.value);
    else if (f.matches('[data-testid="pl-spotify-form"]')) spotifyImport(f.elements.link.value);
    else if (f.matches('[data-testid="pl-top-form"]')) topImport();
    else if (f.matches('[data-testid="pl-rename-form"]')) {
      store.rename(id, f.elements.name.value);
      renaming = false;
      fresh(); drawHead();
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.matches('[data-testid="pl-search-input"]')) {
      search.q = t.value;
      clearTimeout(search.timer);
      search.timer = setTimeout(() => runSearch(search.q), SEARCH_DEBOUNCE_MS);
    } else if (t.matches('[data-testid="pl-paste-input"]')) {
      if (!paste.running) drawPaste();
    } else if (t.matches('[data-testid="pl-filter"]')) {
      filter = t.value;
      drawList();
    } else if (t.matches('[data-testid="pl-year"]')) {
      const v = t.value.replace(/\D/g, '').slice(0, 4);
      if (v !== t.value) t.value = v;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.matches('[data-testid="pl-year"]')) setYear(t);
    else if (t.matches('[data-act="paste-choice"]')) pasteChoice(Number(t.dataset.i), t.value);
    else if (t.matches('[data-act="only-check"]')) { onlyCheck = t.checked; drawList(); }
    else if (t.matches('[data-testid="pl-top-range"]')) tp.range = t.value;
    else if (t.matches('[data-testid="pl-top-count"]')) tp.count = Number(t.value) || TOP_DEFAULT_COUNT;
  }

  function onKey(e) {
    if (e.key === 'Enter' && e.target.matches('[data-testid="pl-year"]')) { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') {
      if (shareState) { slot('sheet').innerHTML = ''; shareState = null; }
      else if (renaming) { renaming = false; drawHead(); }
    }
  }

  function onSheetClick(e) {
    if (e.target.classList.contains('sheet-backdrop')) { slot('sheet').innerHTML = ''; shareState = null; }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onKey);
  slot('sheet').addEventListener('click', onSheetClick);
  const unsub = store.subscribe((reason) => {
    if (!alive || reason !== 'reload') return;
    if (!fresh()) { navigate('#/playlists'); return; }
    drawHead(); drawList();
  });
  const unsubSp = spotify.subscribe(() => {
    if (!alive) return;
    if (topAuto) maybeAutoTop();
    if (tab === 'spotify') drawSpotify();
  });

  drawHead();
  drawPane();
  drawList();
  enrich.prioritise(id);
  maybeAutoTop();

  return () => {
    alive = false;
    unsub();
    unsubSp();
    clearTimeout(search.timer);
    search.ctrl?.abort();
    paste.ctrl?.abort();
    refresh.ctrl?.abort();
    unsubEnrich();
    clearTimeout(bgTimer);
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKey);
  };
}
