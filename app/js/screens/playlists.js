// "Muziek kiezen" (#/playlists): the hub for the music. Top to bottom: what plays now (Speel),
// search a playlist in the public Deezer catalogue (quick picks, covers, paste a link), the
// player's own Spotify playlists, the saved lists (the built-in deck and own playlists: a tap
// makes one active), and making / restoring a list. A playlist opens in a sheet
// (music-sheet.js: Speel direct / Bewaar). Opened from a room lobby (pick mode) the choice goes
// straight back to that room. Also receives shared links (#/pl/<payload>).
import * as store from '../playlists.js';
import * as itunes from '../itunes.js';
import * as deezer from '../deezer.js';
import * as spl from '../spotify-playlists.js';
import * as enrich from '../enrich.js';
import { loadBuiltinDeck, musicSource } from '../deck.js';
import {
  BUILTIN_ID, BUILTIN_NAME, NAME_MAX, MIN_TRACKS, readiness, decodeShare, importBackup,
} from '../playlist-logic.js';
import { icons, esc, toast } from '../ui.js';
import * as spotify from '../spotify.js';
import * as top from '../spotify-top.js';
import { TOP_AUTO_KEY, TOP_DEFAULT_COUNT } from './playlist.js';
import { DEFAULT_RANGE } from '../multi/mix.js';
import { accountNoteHtml, onLogInOut } from './account-bits.js';
import { createMusicSheet, coverHtml, noteIcon } from './music-sheet.js';
import {
  readPick, clearPick, markPicked, isPlaylistLink, countLine, readinessInfo, workLine, sourceLabel,
} from './music-bits.js';

export const name = 'playlists';

const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;
const uploadIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19.5h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const editIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const searchIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
const starIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

const SEARCH_DEBOUNCE_MS = 550;
const SEARCH_PAGE = 24;

/* The last search and the Spotify playlists stay while the app is open (back from a sheet or the
   edit screen shows the same results). */
let lastSearch = null; // { q, items, total, next }
let spCache = null; // { items, at }

export function render(root, { params, navigate }) {
  if (params[0]) return renderImport(root, params[0], navigate);

  let builtinCount = null;
  let alive = true;
  let pick = readPick();
  const search = {
    q: lastSearch?.q || '', items: lastSearch?.items || [], total: lastSearch?.total || 0, next: lastSearch?.next ?? null,
    busy: false, more: false, error: '', ctrl: null, timer: 0, done: !!lastSearch,
  };
  const sp = { busy: false, error: '' };

  root.innerHTML = `<section class="screen screen-playlists" data-testid="screen-playlists">
    <header class="topbar">
      <a class="icon-btn" href="${pick ? '#/spelleider' : '#/'}" aria-label="${pick ? 'Terug naar de kamer' : 'Terug naar start'}" data-testid="back-home" data-act="${pick ? 'pick-back' : ''}">${icons.back}</a>
      <h1 class="topbar-title">Muziek kiezen</h1>
      <span class="topbar-spacer"></span>
    </header>
    <div data-slot="pick"></div>
    <div class="music-layout">
      <section class="music-now" data-slot="current" aria-label="Nu gekozen"></section>
      <section class="set-card music-find" data-testid="pl-search" aria-labelledby="pl-find-title">
        <h2 id="pl-find-title">${searchIcon}<span>Zoek een playlist</span></h2>
        <form class="pl-search music-find-form" role="search" autocomplete="off" data-testid="pl-find-form">
          <input type="search" name="q" value="${esc(search.q)}" placeholder="Zoek een playlist: top 40, jaren 90, hardcore…" aria-label="Zoek een playlist" data-testid="pl-search-input" enterkeyhint="search" autocapitalize="off" spellcheck="false" maxlength="200">
          <button class="btn btn-primary btn-small" type="submit" aria-label="Zoek" data-testid="pl-search-go">${searchIcon}</button>
        </form>
        <div class="quick-row" role="group" aria-label="Snel kiezen">
          ${deezer.FEATURED.map((f) => `<button type="button" class="quick-pick" data-act="quick" data-key="${esc(f.key)}" data-testid="pl-quick-${esc(f.key)}"><span aria-hidden="true">${esc(f.emoji)}</span>${esc(f.label)}</button>`).join('')}
        </div>
        <p class="small muted music-find-note" data-testid="pl-search-note">Zoeken gaat via de openbare catalogus van Deezer. Afspelen doe je met je eigen Spotify of met fragmenten.</p>
        <div class="music-results" data-slot="results"></div>
      </section>
      <section class="set-card music-spotify" data-slot="spotify" aria-labelledby="sp-title"></section>
      <section class="set-card music-saved" aria-labelledby="saved-title">
        <h2 id="saved-title">${starIcon}<span>Bewaard</span></h2>
        <ul class="pl-decks" data-testid="deck-list" data-slot="saved"></ul>
        ${accountNoteHtml('playlists')}
      </section>
      <section class="set-card music-make" aria-labelledby="make-title">
        <h2 id="make-title">Zelf maken of terugzetten</h2>
        <form class="pl-new" data-testid="playlist-new-form" autocomplete="off">
          <label class="pl-label" for="pl-new-name">Eigen playlist maken</label>
          <div class="pl-search">
            <input id="pl-new-name" type="text" name="name" maxlength="${NAME_MAX}" placeholder="Naam, bv. Feestje" data-testid="playlist-new-name" enterkeyhint="done">
            <button class="btn btn-primary btn-small" type="submit" data-testid="playlist-create">${icons.plus}<span>Maak</span></button>
          </div>
          <p class="small muted">Daarna voeg je nummers toe: zoeken, een lijst plakken of een Spotify-playlist overnemen.</p>
        </form>
        <div class="pl-backup">
          <p class="pl-label">Back-up terugzetten</p>
          <p class="small muted">Een bestand dat je eerder met <em>Exporteer</em> hebt bewaard. Er komt een nieuwe playlist bij; er wordt niets overschreven.</p>
          <label class="btn btn-ghost btn-small pl-file">${uploadIcon}<span>Kies een bestand</span>
            <input type="file" accept=".json,application/json" data-testid="playlist-import-file" class="sr-only"></label>
        </div>
      </section>
    </div>
    <a class="btn btn-ghost" href="#/" data-testid="playlists-home">${icons.home}<span>Naar start</span></a>
    <div data-slot="sheet"></div>
  </section>`;

  const slot = (k) => root.querySelector(`[data-slot="${k}"]`);
  const sheet = createMusicSheet({ slot: slot('sheet'), navigate, getPick: () => pick });

  /* ---------- pick mode ---------- */
  function drawPick() {
    slot('pick').innerHTML = pick ? `<div class="music-pick" data-testid="music-pick-banner" role="status">
        <span class="music-pick-ico" aria-hidden="true">${icons.users}</span>
        <p>Je kiest muziek voor kamer <b>${esc(pick.code)}</b>. Tik op een bewaarde lijst of kies <b>Speel direct</b> bij een playlist; daarna ga je terug naar de kamer.</p>
        <button class="btn btn-secondary btn-small" type="button" data-act="pick-back" data-testid="music-pick-back">${icons.back}<span>Terug naar de kamer</span></button>
      </div>` : '';
  }

  /** Pick mode: this list is the room's music now; back to the lobby. */
  function pickDone(id) {
    const p = store.get(id);
    store.setActive(p ? id : BUILTIN_ID);
    const code = pick.code;
    clearPick();
    markPicked(code);
    pick = null;
    toast(`Muziek voor kamer ${code}: “${p ? p.name : BUILTIN_NAME}”.`, { ms: 2600 });
    navigate('#/spelleider');
  }

  /* ---------- Nu gekozen ---------- */
  function listInfo(p) {
    const src = musicSource();
    const counts = store.deckCounts(p, src);
    const status = enrich.status(p.id);
    const info = readinessInfo({ counts, source: src, spotifyPlayable: store.deckCounts(p, 'spotify').inDeck, status, playNow: p.playNow === true });
    return { counts, status, info, work: workLine(status) };
  }

  function drawCurrent() {
    const id = store.getActiveId();
    const p = id === BUILTIN_ID ? null : store.get(id);
    let line;
    let tone = 'ok';
    let count;
    if (p) {
      const { info, work } = listInfo(p);
      line = work && info.tone !== 'busy' ? `${info.text} ${work}.` : info.text;
      tone = info.tone;
      count = `${plural(p.tracks.length, 'nummer', 'nummers')} · ${sourceLabel(p) === 'eigen' ? 'eigen playlist' : `uit ${sourceLabel(p)}`}`;
    } else {
      count = `${builtinCount == null ? '…' : plural(builtinCount, 'kaart', 'kaarten')} · ingebouwd`;
      line = 'Klaar om te spelen, ook met geprinte kaartjes.';
    }
    slot('current').innerHTML = `<div class="music-current" data-testid="music-current" data-deck-id="${esc(id)}">
        <span class="cover cover-md is-current" aria-hidden="true">${noteIcon}</span>
        <div class="music-current-text">
          <p class="ms-kicker">Nu gekozen</p>
          <p class="music-current-name"><b data-testid="music-current-name">${esc(p ? p.name : BUILTIN_NAME)}</b></p>
          <p class="small muted">${esc(count)}</p>
          <p class="small music-ready is-${tone}" data-testid="music-current-ready">${esc(line)}</p>
        </div>
        <div class="music-current-acts">
          <button class="btn btn-primary" type="button" data-act="${pick ? 'pick-current' : 'play-current'}" data-testid="music-play">${icons.play}<span>${pick ? 'Kies deze' : 'Speel'}</span></button>
          ${p ? `<a class="btn btn-ghost btn-small" href="#/playlists/${esc(p.id)}" data-testid="music-current-open">${editIcon}<span>Bekijk</span></a>` : ''}
        </div>
      </div>`;
  }

  /* ---------- search ---------- */
  function resultsHtml() {
    if (search.error) {
      return `<p class="set-error" role="alert" data-testid="pl-search-error">${esc(search.error)}</p>
        <button class="btn btn-ghost btn-small" type="button" data-act="search-retry" data-testid="pl-search-retry">${icons.restart}<span>Probeer opnieuw</span></button>`;
    }
    if (search.busy && !search.items.length) return '<p class="pl-status small" role="status" data-testid="pl-search-status">Zoeken…</p>';
    if (!search.done) return '';
    if (!search.items.length) {
      return `<p class="set-empty" data-testid="pl-search-empty">Niets gevonden voor “${esc(search.q)}”. Probeer een ander woord, zoals ‘top 40’, ‘jaren 80’ of de naam van een artiest.</p>`;
    }
    const cards = search.items.map((it, i) => {
      const saved = store.findBySource('deezer', String(it.id));
      return `<li><button type="button" class="pl-card" data-act="open-result" data-i="${i}" data-testid="pl-result" data-id="${esc(it.id)}">
          ${coverHtml(it.picture, 'cover-card')}
          <span class="pl-card-text"><b>${esc(it.title)}</b><small>${esc(countLine(it.count, it.by))}</small>${saved ? '<span class="pill pill-saved">Bewaard</span>' : ''}</span>
        </button></li>`;
    }).join('');
    return `<p class="pl-status small" role="status" data-testid="pl-search-status">${plural(search.total, 'playlist', 'playlists')} voor “${esc(search.q)}”</p>
      <ul class="pl-cards" data-testid="pl-results">${cards}</ul>
      ${search.next != null ? `<button class="btn btn-ghost btn-small music-more" type="button" data-act="more" data-testid="pl-results-more" ${search.more ? 'disabled' : ''}>${search.more ? 'Laden…' : 'Meer laden'}</button>` : ''}`;
  }

  function drawResults() {
    const box = slot('results');
    const a = document.activeElement;
    const focusKey = a && box.contains(a) ? (a.dataset.testid === 'pl-result' ? `r${a.dataset.i}` : a.dataset.testid) : null;
    box.innerHTML = resultsHtml();
    if (focusKey) {
      const el = focusKey.startsWith('r') && /^r\d+$/.test(focusKey) ? box.querySelector(`[data-testid="pl-result"][data-i="${focusKey.slice(1)}"]`) : box.querySelector(`[data-testid="${CSS.escape(focusKey)}"]`);
      (el || box.querySelector('[data-testid="pl-result"]'))?.focus({ preventScroll: true });
    }
  }

  function remember() { lastSearch = search.done && !search.error ? { q: search.q, items: search.items, total: search.total, next: search.next } : lastSearch; }

  async function runSearch(raw, { append = false } = {}) {
    clearTimeout(search.timer);
    const q = String(raw ?? '').trim();
    if (!append && isPlaylistLink(q)) {
      const id = deezer.parsePlaylistId(q);
      if (id) { sheet.openSource({ kind: 'deezer', id, name: '', count: null, by: '', picture: null }); return; }
    }
    if (!append) {
      if (q.length < 2) { search.ctrl?.abort(); Object.assign(search, { q, items: [], total: 0, next: null, done: false, error: '', busy: false }); lastSearch = null; drawResults(); return; }
      if (q === search.q && search.done && !search.error) return;
    }
    search.ctrl?.abort();
    const ctrl = new AbortController();
    search.ctrl = ctrl;
    if (append) search.more = true;
    else Object.assign(search, { q, busy: true, error: '', items: [], total: 0, next: null, done: false });
    drawResults();
    try {
      if (globalThis.navigator?.onLine === false) throw new deezer.DeezerError('offline');
      const r = await deezer.searchPlaylists(search.q, { index: append ? search.next : 0, limit: SEARCH_PAGE, signal: ctrl.signal });
      if (!alive || ctrl !== search.ctrl) return;
      const seen = new Set(search.items.map((x) => x.id));
      search.items = append ? [...search.items, ...r.items.filter((x) => !seen.has(x.id))] : r.items;
      search.total = Math.max(r.total, search.items.length);
      search.next = r.next;
      search.done = true;
    } catch (e) {
      if (!alive || ctrl !== search.ctrl || e?.code === 'aborted') return;
      if (append) toast(deezer.errorMessage(e), { kind: 'warn', ms: 4000 });
      else { search.error = deezer.errorMessage(e); search.done = false; }
    } finally {
      if (ctrl === search.ctrl) { search.busy = false; search.more = false; }
    }
    remember();
    drawResults();
  }

  function quick(key) {
    const f = deezer.FEATURED.find((x) => x.key === key);
    if (!f) return;
    if (f.playlistId) { sheet.openSource({ kind: 'deezer', id: f.playlistId, name: '', placeholder: f.label, count: null, by: '', picture: null }); return; }
    const input = root.querySelector('[data-testid="pl-search-input"]');
    input.value = f.query;
    runSearch(f.query);
  }

  /* ---------- Van Spotify ---------- */
  async function loadSpotify(force = false) {
    if (sp.busy || !spl.canRead()) return;
    if (spCache && !force) return;
    sp.busy = true; sp.error = '';
    drawSpotify();
    try {
      const items = await spl.myPlaylists();
      spCache = { items, at: Date.now() };
    } catch (e) {
      sp.error = spl.errorMessage(e);
    } finally {
      sp.busy = false;
    }
    if (alive) drawSpotify();
  }

  function drawSpotify() {
    const box = slot('spotify');
    const a = document.activeElement;
    const keep = a && box.contains(a) ? a.dataset.testid : null;
    const keepId = a?.dataset?.id;
    const topTile = `<li><button type="button" class="sp-tile is-top" data-act="top-create" data-testid="playlist-top-create">
        <span class="cover cover-tile is-top" aria-hidden="true">${spotifyIcon}</span>
        <span class="sp-tile-text"><b>Mijn meest geluisterd</b><small>je top ${TOP_DEFAULT_COUNT} van het afgelopen half jaar</small></span></button></li>`;
    let body;
    if (!spotify.getClientId()) {
      body = `<p class="small muted" data-testid="sp-no-client">Spotify is op dit toestel nog niet ingesteld. Dat doe je bij <a href="#/instellingen/spotify">Instellingen</a>; daarna staan je playlists hier.</p>
        <ul class="sp-tiles" data-testid="sp-lists">${topTile}</ul>`;
    } else if (!spl.canRead()) {
      body = `<p class="small muted">${spotify.isConnected() ? 'Je bent verbonden met Spotify. Geef één keer toestemming om je playlists te tonen; je komt daarna hier terug.' : 'Log in bij Spotify en kies uit je eigen playlists; je komt daarna hier terug.'}</p>
        <button class="btn btn-secondary" type="button" data-act="sp-connect" data-testid="sp-connect">${spotifyIcon}<span>Toon mijn Spotify-playlists</span></button>
        <ul class="sp-tiles" data-testid="sp-lists">${topTile}</ul>`;
    } else {
      const items = spCache?.items || [];
      const tiles = items.map((p) => {
        const saved = store.findBySource('spotify', p.id);
        return `<li><button type="button" class="sp-tile" data-act="open-sp" data-id="${esc(p.id)}" data-testid="sp-list">
          ${coverHtml(p.picture, 'cover-tile')}
          <span class="sp-tile-text"><b>${esc(p.name)}</b><small>${p.count != null ? plural(p.count, 'nummer', 'nummers') : 'playlist'}${saved ? ' · bewaard' : ''}</small></span></button></li>`;
      }).join('');
      body = `${sp.error ? `<p class="set-error" role="alert" data-testid="sp-error">${esc(sp.error)}</p>` : ''}
        ${sp.busy && !spCache ? '<p class="small muted" role="status" data-testid="sp-loading">Je playlists ophalen…</p>' : ''}
        <ul class="sp-tiles" data-testid="sp-lists">${topTile}${tiles}</ul>
        ${spCache && !items.length && !sp.busy ? '<p class="set-empty small">Geen eigen of gezamenlijke playlists gevonden.</p>' : ''}`;
    }
    box.innerHTML = `<div class="set-head"><h2 id="sp-title">${spotifyIcon}<span>Van Spotify</span></h2>
        ${spl.canRead() ? `<button class="btn btn-ghost btn-small" type="button" data-act="sp-refresh" data-testid="sp-refresh" ${sp.busy ? 'disabled' : ''}>${icons.restart}<span>${sp.busy ? 'Bezig…' : 'Ververs'}</span></button>` : ''}</div>
      ${body}
      <details class="sp-tip" data-testid="sp-tip">
        <summary>Staat de lijst die je zoekt er niet bij?</summary>
        <p class="small">Staat de lijst van iemand anders of van Spotify zelf (bv. Top 50 Nederland)? Spotify geeft apps alleen je eigen playlists. Zo maak je hem van jou: open de lijst in Spotify → ⋯ → <em>Toevoegen aan andere playlist</em> → <em>Nieuwe playlist</em>. Daarna staat hij hier${spl.canRead() ? ' (tik op Ververs)' : ''}.</p>
        <p class="small muted">Of zoek hem hierboven in de catalogus: daar staan ook de hitlijsten.</p>
      </details>`;
    if (keep) (box.querySelector(`[data-testid="${CSS.escape(keep)}"]${keepId ? `[data-id="${CSS.escape(keepId)}"]` : ''}`) || box.querySelector(`[data-testid="${CSS.escape(keep)}"]`))?.focus({ preventScroll: true });
  }

  /* ---------- Bewaard ---------- */
  function deckRow({ id, title, sub, warn = '', status = '', active, edit = false }) {
    return `<li class="pl-deck${active ? ' is-active' : ''}" data-testid="deck-option" data-deck-id="${esc(id)}">
      <button type="button" class="pl-pick" data-act="activate" data-id="${esc(id)}" data-testid="deck-pick" data-deck-id="${esc(id)}" aria-pressed="${active}">
        <span class="pl-radio" aria-hidden="true">${active ? icons.check : ''}</span>
        <span class="pl-pick-text"><b>${esc(title)}</b><small>${sub}</small>
          ${status ? `<small class="pl-work" data-testid="deck-status">${esc(status)}</small>` : ''}
          ${warn ? `<small class="pl-warn-txt" data-testid="deck-too-small">${warn}</small>` : ''}</span>
        ${active ? '<span class="pill pill-on">Actief</span>' : ''}
      </button>
      ${edit ? `<a class="icon-btn" href="#/playlists/${esc(id)}" aria-label="Bewerk ${esc(title)}" data-testid="playlist-open" data-deck-id="${esc(id)}">${editIcon}</a>` : ''}
    </li>`;
  }

  function drawSaved() {
    const box = slot('saved');
    const a = document.activeElement;
    const keep = a && box.contains(a) ? `[data-testid="${a.dataset.testid}"][data-deck-id="${CSS.escape(a.dataset.deckId || '')}"]` : null;
    const active = store.getActiveId();
    const rows = [deckRow({
      id: BUILTIN_ID, title: BUILTIN_NAME, active: active === BUILTIN_ID,
      sub: `${builtinCount == null ? '…' : plural(builtinCount, 'kaart', 'kaarten')} · ingebouwd, ook als geprinte kaartjes`,
    })];
    const src = musicSource();
    for (const p of store.all()) {
      const n = store.playableCount(p, src);
      const r = readiness(n);
      let warn = '';
      if (!r.timeline) warn = `Te weinig om te spelen (Tijdlijn ${MIN_TRACKS.timeline}, Bingo ${MIN_TRACKS.bingo})`;
      else if (!r.bingo) warn = `Genoeg voor Tijdlijn; Bingo vraagt er ${MIN_TRACKS.bingo}`;
      const status = workLine(enrich.status(p.id), { short: true });
      // a catalogue list that is still being finished is not "too small": it is busy
      if (status && !r.timeline && p.source) warn = '';
      rows.push(deckRow({ id: p.id, title: p.name, active: active === p.id, sub: `${plural(p.tracks.length, 'nummer', 'nummers')} · ${sourceLabel(p) === 'eigen' ? 'eigen playlist' : sourceLabel(p)}`, warn, status, edit: true }));
    }
    box.innerHTML = rows.join('');
    if (keep) box.querySelector(keep)?.focus({ preventScroll: true });
  }

  function drawAll() {
    drawPick();
    drawCurrent();
    drawResults();
    drawSpotify();
    drawSaved();
  }

  /* ---------- actions ---------- */
  async function importFile(file) {
    let json;
    try { json = JSON.parse(await file.text()); } catch { toast('Dit bestand is geen TimeTunesr-back-up.', { kind: 'warn' }); return; }
    const lists = importBackup(json);
    if (!lists.length) { toast('Geen playlist met nummers gevonden in dit bestand.', { kind: 'warn' }); return; }
    const total = lists.reduce((s, p) => s + p.tracks.length, 0);
    const names = lists.map((p) => `“${p.name}”`).join(', ');
    if (!window.confirm(`${lists.length === 1 ? 'Playlist' : 'Playlists'} ${names} (${plural(total, 'nummer', 'nummers')}) toevoegen aan dit toestel?`)) return;
    let last = null;
    for (const p of lists) {
      last = store.create(p.name, { tracks: p.tracks, nextN: p.nextN });
      if (!last) { toast('Opslaan lukte niet: de opslag van de browser is vol.', { kind: 'warn', ms: 5000 }); break; }
    }
    if (last) {
      toast(`${plural(lists.length, 'playlist', 'playlists')} teruggezet.`, { ms: 2400 });
      if (lists.length === 1) navigate(`#/playlists/${last.id}`);
      else drawAll();
    }
  }

  /** One tap: a new playlist filled with the top songs (via the Spotify login when needed). */
  function topCreate() {
    if (!spotify.getClientId()) { toast(top.MESSAGES['no-client'], { kind: 'warn', ms: 7000 }); return; }
    const problem = spotify.environmentProblem();
    if (problem && !top.canRead()) { toast(spotify.errorMessage(problem), { kind: 'warn', ms: 6000 }); return; }
    const p = store.create('Mijn meest geluisterd');
    if (!p) { toast('Opslaan lukte niet: de opslag van de browser is vol of uitgeschakeld.', { kind: 'warn', ms: 5000 }); return; }
    try { sessionStorage.setItem(TOP_AUTO_KEY, JSON.stringify({ id: p.id, range: DEFAULT_RANGE, count: TOP_DEFAULT_COUNT })); } catch { /* ignore */ }
    if (top.canRead()) { navigate(`#/playlists/${p.id}`); return; }
    spotify.connect(`#/playlists/${p.id}`, { top: true }).catch((err) => {
      toast(top.errorMessage(err), { kind: 'warn', ms: 6000 });
      navigate(`#/playlists/${p.id}`);
    });
  }

  function spConnect() {
    spotify.connect('#/playlists', { playlists: true }).catch((err) => toast(spotify.errorMessage(err), { kind: 'warn', ms: 6000 }));
  }

  function onClick(e) {
    const a = e.target.closest('[data-act]');
    if (!a || !root.contains(a) || slot('sheet').contains(a)) return;
    switch (a.dataset.act) {
      case 'top-create': topCreate(); break;
      case 'pick-back':
        e.preventDefault();
        clearPick();
        pick = null;
        navigate('#/spelleider');
        break;
      case 'pick-current': pickDone(store.getActiveId()); break;
      case 'play-current': sheet.openPlay(store.getActiveId()); break;
      case 'quick': quick(a.dataset.key); break;
      case 'more': if (search.next != null && !search.more) runSearch(search.q, { append: true }); break;
      case 'search-retry': { const q = search.q; search.q = ''; runSearch(q); break; }
      case 'open-result': {
        const it = search.items[Number(a.dataset.i)];
        if (it) sheet.openSource({ kind: 'deezer', id: it.id, name: it.title, count: it.count, by: it.by, picture: it.picture });
        break;
      }
      case 'open-sp': {
        const it = spCache?.items?.find((x) => x.id === a.dataset.id);
        if (it) sheet.openSource({ kind: 'spotify', id: it.id, name: it.name, count: it.count, by: '', picture: it.picture });
        break;
      }
      case 'sp-connect': spConnect(); break;
      case 'sp-refresh': loadSpotify(true); break;
      case 'activate': {
        const id = store.setActive(a.dataset.id);
        if (pick) { pickDone(id); return; }
        const p = store.get(id);
        toast(`Je speelt nu met ${p ? `“${p.name}”` : 'het TimeTunesr-deck'}.`, { ms: 2200 });
        drawCurrent();
        drawSaved();
        root.querySelector(`[data-testid="deck-pick"][data-deck-id="${CSS.escape(id)}"]`)?.focus();
        break;
      }
      default:
    }
  }

  function onSubmit(e) {
    if (e.target.matches('[data-testid="pl-find-form"]')) {
      e.preventDefault();
      const q = e.target.elements.q.value;
      if (q.trim() === search.q && search.error) search.q = '';
      runSearch(q);
      return;
    }
    if (!e.target.matches('[data-testid="playlist-new-form"]')) return;
    e.preventDefault();
    const nm = e.target.elements.name.value.trim();
    if (!nm) { e.target.elements.name.focus(); toast('Geef je playlist eerst een naam.', { kind: 'warn' }); return; }
    const p = store.create(nm);
    if (!p) { toast('Opslaan lukte niet: de opslag van de browser is vol of uitgeschakeld.', { kind: 'warn', ms: 5000 }); return; }
    navigate(`#/playlists/${p.id}`);
  }

  function onInput(e) {
    if (!e.target.matches('[data-testid="pl-search-input"]')) return;
    clearTimeout(search.timer);
    const v = e.target.value;
    // a pasted link opens at once; typing waits for a short pause
    search.timer = setTimeout(() => runSearch(v), isPlaylistLink(v) ? 0 : SEARCH_DEBOUNCE_MS);
  }

  function onChange(e) {
    if (e.target.matches('[data-testid="playlist-import-file"]') && e.target.files?.[0]) {
      importFile(e.target.files[0]);
      e.target.value = '';
    }
  }
  const onImgError = (e) => { if (e.target?.tagName === 'IMG' && root.contains(e.target)) e.target.remove(); };

  drawAll();
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('error', onImgError, true);
  const unsub = store.subscribe(() => {
    if (!alive) return;
    drawCurrent(); drawSaved(); drawResults(); drawSpotify();
    sheet.refresh();
  });
  // the background work (years, fragments): the status lines follow, at most twice a second
  let bgTimer = 0;
  const unsubEnrich = enrich.subscribe(() => {
    if (!alive || bgTimer) return;
    bgTimer = setTimeout(() => { bgTimer = 0; if (alive) { drawCurrent(); drawSaved(); } }, 500);
  });
  const unsubSp = spotify.subscribe(() => { if (!alive) return; drawSpotify(); if (spl.canRead() && !spCache) loadSpotify(); });
  const offAccount = onLogInOut(() => { if (alive) drawAll(); });
  loadBuiltinDeck().then((d) => { builtinCount = d.cards.length; if (alive) { drawCurrent(); drawSaved(); } }).catch(() => {});
  if (spl.canRead()) loadSpotify();

  return () => {
    alive = false;
    clearTimeout(search.timer);
    clearTimeout(bgTimer);
    search.ctrl?.abort();
    sheet.destroy();
    unsub();
    unsubEnrich();
    unsubSp();
    offAccount();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('error', onImgError, true);
  };
}

/* ---------- receiving a shared playlist (#/pl/<payload>) ---------- */

function renderImport(root, payload, navigate) {
  const share = decodeShare(payload);
  let alive = true;
  let busy = false;
  let progress = '';
  const ctrl = new AbortController();

  function draw(extra = '') {
    if (!share) {
      root.innerHTML = `<section class="screen screen-center" data-testid="screen-playlist-import">
        <div class="panel"><h1>Link werkt niet</h1>
          <p data-testid="pl-import-invalid">Deze deel-link is beschadigd of onvolledig. Vraag de afzender om de link opnieuw te sturen.</p>
          <div class="stack"><a class="btn btn-primary" href="#/playlists">Naar je playlists</a></div></div></section>`;
      return;
    }
    const existing = store.findByShareId(share.shareId);
    const seen = existing?.partsSeen || [];
    const partTxt = share.total > 1 ? ` · code ${share.part} van ${share.total}` : '';
    const already = existing && share.total > 1 && seen.includes(share.part);
    root.innerHTML = `<section class="screen screen-center" data-testid="screen-playlist-import">
      <div class="panel pl-import">
        <h1>Playlist ontvangen</h1>
        <p class="pl-import-name"><b data-testid="pl-import-name">${esc(share.name)}</b><br><span class="muted" data-testid="pl-import-count">${plural(share.items.length, 'nummer', 'nummers')}${partTxt}</span></p>
        ${existing ? `<p class="small" data-testid="pl-import-existing">Je hebt deze playlist al: <b>${esc(existing.name)}</b> (${plural(existing.tracks.length, 'nummer', 'nummers')}). ${already ? 'Deze code is al eerder gescand.' : 'Nieuwe nummers komen erbij; jaren die je zelf hebt aangepast blijven staan.'}</p>`
    : '<p class="small">De titels worden opgehaald bij Apple Music. Je huidige muziek verandert niet: je kiest daarna zelf of je met deze playlist speelt.</p>'}
        ${progress ? `<p class="small" data-testid="pl-import-progress" role="status">${esc(progress)}</p>` : ''}
        ${extra}
        <div class="stack">
          <button class="btn btn-primary btn-xl" type="button" data-act="import" data-testid="pl-import-confirm" ${busy ? 'disabled' : ''}>${icons.plus}<span>${existing ? 'Voeg toe aan mijn playlist' : 'Zet op dit toestel'}</span></button>
          <a class="btn btn-ghost" href="#/" data-testid="pl-import-cancel">${icons.close}<span>Niet nu</span></a>
        </div>
      </div>
    </section>`;
  }

  async function doImport() {
    if (busy) return;
    busy = true;
    progress = 'Titels ophalen bij Apple Music…';
    draw();
    let found;
    try {
      found = await itunes.lookup(share.items.map((i) => i.itunesId), {
        signal: ctrl.signal,
        onProgress: (n, total) => { progress = `Titels ophalen: ${n} van ${total}…`; if (alive) draw(); },
      });
    } catch (e) {
      if (!alive || e.code === 'aborted') return;
      busy = false;
      progress = '';
      draw(`<p class="set-error" role="alert" data-testid="pl-import-error">${esc(itunes.errorMessage(e))}</p>`);
      return;
    }
    if (!alive) return;
    const tracks = [];
    let missing = 0;
    for (const it of share.items) {
      const r = found.get(it.itunesId);
      if (!r) { missing++; continue; }
      tracks.push({
        itunesId: it.itunesId, title: r.trackName, artist: r.artistName, album: r.collectionName || '',
        year: it.year, yearSure: true, previewUrl: r.previewUrl || null, trackViewUrl: r.trackViewUrl || null,
      });
    }
    let p = store.findByShareId(share.shareId);
    let added;
    if (p) {
      added = store.addTracks(p.id, tracks).added.length;
    } else {
      p = store.create(share.name, { tracks, shareId: share.shareId });
      if (!p) { busy = false; progress = ''; draw('<p class="set-error" role="alert">Opslaan lukte niet: de opslag van de browser is vol of uitgeschakeld.</p>'); return; }
      added = p.tracks.length;
    }
    const seen = [...new Set([...(store.get(p.id).partsSeen || []), share.part])];
    store.patchPlaylist(p.id, { partsSeen: seen, partsTotal: share.total });
    const left = share.total > 1 ? share.total - seen.filter((n) => n <= share.total).length : 0;
    let msg = `${plural(added, 'nummer', 'nummers')} toegevoegd aan “${p.name}”.`;
    if (missing) msg += ` ${plural(missing, 'nummer is', 'nummers zijn')} niet (meer) beschikbaar bij Apple Music.`;
    if (left) msg += ` Scan nog ${plural(left, 'code', 'codes')} voor de rest.`;
    toast(msg, { ms: 5000, kind: missing ? 'warn' : 'info' });
    navigate(`#/playlists/${p.id}`);
  }

  const onClick = (e) => { if (e.target.closest('[data-act="import"]')) doImport(); };
  draw();
  root.addEventListener('click', onClick);
  return () => {
    alive = false;
    ctrl.abort();
    root.removeEventListener('click', onClick);
  };
}
