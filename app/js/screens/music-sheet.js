// The sheet over the "Muziek kiezen" hub (#/playlists):
// - the playlist sheet: a catalogue (Deezer) or Spotify list before it is saved: cover, title,
//   maker, the first songs (catalogue songs with a 30-second listen), Speel direct / Bewaar;
// - "Speel direct": the songs are fetched (visible, stoppable), then the years are checked
//   (enrich.prepare, about one per second: the waiting moment says so and offers Speel nu toch);
// - the play sheet: "<naam> staat klaar" + "Hoe wil je spelen?".
// Opened from a room lobby (pick mode) the chosen list goes straight back to the room.
// Focus: trapped in the sheet, restored on close; Esc and the phone's back button close it.
import * as store from '../playlists.js';
import * as deezer from '../deezer.js';
import * as spl from '../spotify-playlists.js';
import * as spotify from '../spotify.js';
import * as enrich from '../enrich.js';
import * as player from '../player.js';
import { musicSource } from '../deck.js';
import { FUN_MIN, BUILTIN_ID, BUILTIN_NAME, MAX_TRACKS } from '../playlist-logic.js';
import { icons, esc, toast } from '../ui.js';
import {
  countLine, safeImage, readinessInfo, yearsWaitText, plural, clearPick, markPicked, workLine,
} from './music-bits.js';

const PREVIEW_ROWS = 30;
/** "Speel nu toch" waits at most this long for songs that have any year at all (Deezer gives them fast). */
const NOW_WAIT_MS = 15000;

const ico = (body) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
export const noteIcon = ico('<path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/>');
const phonesIcon = ico('<rect x="2.5" y="5" width="8.5" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8.5" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 17h2.5M16 15h2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
const timelineIcon = ico('<path d="M3 12h18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4" y="5" width="4.5" height="5" rx="1" fill="currentColor"/><rect x="9.8" y="14" width="4.5" height="5" rx="1" fill="currentColor"/><rect x="15.5" y="5" width="4.5" height="5" rx="1" fill="currentColor"/>');
const gridIcon = ico('<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" stroke="currentColor" stroke-width="1.6"/>');
const saveIcon = ico('<path d="M6 3.5h12v17l-6-4.2-6 4.2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>');

/** A cover box (fixed ratio, neutral placeholder; the image only when it is https). */
export function coverHtml(url, cls = '') {
  const src = safeImage(url);
  return `<span class="cover ${cls}" aria-hidden="true">${noteIcon}${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
}

/** Catalogue / Spotify songs -> the input of store.importFromSource (years are guesses until checked). */
function toImport(kind, tracks) {
  if (kind === 'deezer') {
    return tracks.map((t) => ({ deezerId: t.deezerId, title: t.title, artist: t.artist, album: t.album, isrc: t.isrc || undefined, yearSure: false }));
  }
  return tracks.map((t) => ({ spotifyId: t.spotifyId, title: t.title, artist: t.artist, album: t.album, spYear: t.spYear, isrc: t.isrc || undefined, yearSure: false }));
}

const errorText = (kind, e) => (kind === 'deezer' ? deezer.errorMessage(e) : spl.errorMessage(e));
const aborted = (e, signal) => signal?.aborted || e?.code === 'aborted';

/**
 * Fetch all songs of a source list and store them (a new list, or the same list updated).
 * Returns { res, longer } (longer: the source has more songs than MAX_TRACKS) or throws.
 * Shared with the edit screen's "Opnieuw ophalen".
 */
export async function fetchAndImport(src, { signal, onProgress } = {}) {
  let tracks;
  if (src.kind === 'deezer') tracks = await deezer.playlistTracks(Number(src.id), { signal, onProgress });
  else tracks = await spl.playlistTracks(src.id, { signal, onProgress });
  if (signal?.aborted) throw new deezer.DeezerError('aborted');
  const res = store.importFromSource({ kind: src.kind, id: src.id, name: src.name }, toImport(src.kind, tracks));
  const longer = src.kind === 'spotify' ? (tracks.capped ? tracks.total : 0) : (Number(src.count) > MAX_TRACKS ? src.count : 0);
  return { res, longer };
}

/** "Bewaard: X" / "Bijgewerkt: 12 nieuwe nummers" for an import result. */
export function importMessage(res) {
  if (res.created) return `Bewaard: “${res.playlist.name}” (${plural(res.playlist.tracks.length, 'nummer', 'nummers')}).`;
  return res.added ? `Bijgewerkt: ${plural(res.added, 'nieuw nummer', 'nieuwe nummers')} in “${res.playlist.name}”.` : `Bijgewerkt: “${res.playlist.name}” had alle nummers al.`;
}

export function createMusicSheet({ slot, navigate, getPick }) {
  let st = null;
  let lastFocus = null;
  let pushed = false;
  let gen = 0;
  let offPlayer = null;
  let offEnrich = null;

  const sheetEl = () => slot.querySelector('.sheet');
  const isOpen = () => !!st;

  /* ---------- open / close ---------- */

  function open(state) {
    if (!st) {
      lastFocus = document.activeElement;
      try { history.pushState({ ttSheet: true }, ''); pushed = true; } catch { pushed = false; }
      document.body.classList.add('has-sheet');
    } else stopWork();
    gen++;
    st = { listening: null, ...state };
    if (!offPlayer) offPlayer = player.subscribe(() => { if (st?.listening) drawTracks(); });
    if (!offEnrich) {
      offEnrich = enrich.subscribe(() => {
        const box = st?.view === 'play' ? slot.querySelector('[data-slot="ready"]') : null;
        if (box) keepFocus(() => { box.innerHTML = readyHtml(); });
      });
    }
    draw();
    focusFirst();
  }

  function stopWork() {
    st?.run?.ctrl?.abort();
    st?.loadCtrl?.abort();
    if (st?.nowTimer) clearTimeout(st.nowTimer);
    if (st?.etaTimer) { clearInterval(st.etaTimer); st.etaTimer = null; }
    if (st?.listening) { player.stop(); st.listening = null; }
  }

  /** Close the sheet. fromHistory: the back button already went back. */
  function close({ fromHistory = false, keepFocus = false } = {}) {
    if (!st) return;
    stopWork();
    st = null;
    gen++;
    slot.innerHTML = '';
    document.body.classList.remove('has-sheet');
    offPlayer?.(); offPlayer = null;
    offEnrich?.(); offEnrich = null;
    if (pushed && !fromHistory) { pushed = false; try { history.back(); } catch { /* ignore */ } }
    pushed = false;
    if (!keepFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus?.();
    lastFocus = null;
  }

  /** Leave the hub for another screen (the sheet's history entry is replaced, not stacked). */
  function leave(hash) {
    const wasPushed = pushed;
    pushed = false;
    close({ fromHistory: true, keepFocus: true });
    if (wasPushed) {
      try { location.replace(new URL(hash, location.href).href); return; } catch { /* fall back */ }
    }
    navigate(hash);
  }

  const onPop = () => { if (st) { pushed = false; close({ fromHistory: true }); } };
  window.addEventListener('popstate', onPop);

  /* ---------- drawing ---------- */

  function headHtml({ small = false } = {}) {
    const s = st.src;
    const kicker = s.kind === 'deezer' ? 'Playlist uit de catalogus' : 'Jouw Spotify-playlist';
    const longer = Number(s.count) > MAX_TRACKS ? ` · De eerste ${MAX_TRACKS} nummers` : '';
    return `<header class="ms-head${small ? ' is-small' : ''}">
      ${coverHtml(s.picture, small ? 'cover-md' : 'cover-lg')}
      <div class="ms-head-text">
        <p class="ms-kicker">${kicker}</p>
        <h2 id="sheet-title" data-testid="sheet-title">${esc(s.name || s.placeholder || 'Playlist')}</h2>
        <p class="ms-sub" data-testid="sheet-count">${esc(countLine(s.count, s.by))}${longer}</p>
      </div>
      <button class="icon-btn ms-close" type="button" data-act="sheet-close" data-testid="sheet-close" aria-label="Sluiten">${icons.close}</button>
    </header>`;
  }

  function trackRowsHtml() {
    const p = st.preview;
    if (p.error) return `<p class="set-error" role="alert" data-testid="sheet-error">${esc(p.error)} <button class="linklike" type="button" data-act="sheet-reload" data-testid="sheet-reload">Opnieuw</button></p>`;
    if (!p.tracks) return '<p class="muted small ms-loading" data-testid="sheet-loading">Nummers laden…</p>';
    if (!p.tracks.length) return '<p class="set-empty">Er staan geen speelbare nummers in deze lijst.</p>';
    const playing = player.state.status === 'playing' || player.state.status === 'loading';
    const rows = p.tracks.map((t, i) => {
      const on = st.listening === t.deezerId && playing;
      const listen = t.deezerId ? `<button class="icon-btn ms-listen${on ? ' is-on' : ''}" type="button" data-act="sheet-listen" data-i="${i}" aria-pressed="${on}" aria-label="${on ? 'Stop' : 'Luister naar'} ${esc(t.title)}" data-testid="sheet-listen">${on ? icons.pause : icons.play}</button>` : '';
      return `<li class="ms-track" data-testid="sheet-track"><span class="ms-num" aria-hidden="true">${i + 1}</span><span class="ms-t"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>${listen}</li>`;
    }).join('');
    const total = Number(st.src.count);
    const rest = Number.isInteger(total) && total > p.tracks.length ? `<p class="muted small ms-rest">… en nog ${Math.min(total, MAX_TRACKS) - p.tracks.length} nummers.</p>` : '';
    return `<ol class="ms-tracks" aria-label="De eerste nummers">${rows}</ol>${rest}`;
  }

  function drawTracks() {
    const box = slot.querySelector('[data-slot="tracks"]');
    if (box) keepFocus(() => { box.innerHTML = trackRowsHtml(); });
  }

  function listHtml() {
    const s = st.src;
    const have = store.findBySource(s.kind, s.id);
    const pick = getPick();
    return `${headHtml()}
      ${have ? `<p class="ms-note" data-testid="sheet-existing">Staat al bij Bewaard (${plural(have.tracks.length, 'nummer', 'nummers')}). Speel direct en Bijwerken halen nieuwe nummers erbij; jaartallen die je zelf hebt verbeterd blijven staan.</p>` : ''}
      ${st.saved ? `<p class="ms-done" role="status" data-testid="sheet-saved">${esc(st.saved)}</p>` : ''}
      <div class="ms-actions">
        <button class="btn btn-primary btn-xl" type="button" data-act="sheet-play-now" data-testid="sheet-play-now">${icons.play}<span>${pick ? 'Kies en speel direct' : 'Speel direct'}</span></button>
        <button class="btn btn-ghost" type="button" data-act="sheet-save" data-testid="sheet-save">${have ? icons.restart : saveIcon}<span>${have ? 'Bijwerken' : 'Bewaar'}</span></button>
      </div>
      <p class="small muted ms-why">${pick ? `De lijst wordt de muziek van kamer <b>${esc(pick.code)}</b>. ` : ''}Speel direct haalt de nummers op en kijkt eerst de jaartallen na (ongeveer een halve minuut), zodat Jaartal ±2 en Exact jaar eerlijk blijven.</p>
      <div class="ms-list" data-slot="tracks">${trackRowsHtml()}</div>`;
  }

  function stepsHtml(phase) {
    const order = ['fetch', 'years', 'done'];
    const at = phase === 'now' ? 1 : phase === 'error' ? Math.max(0, order.indexOf(st.run.failedAt || 'fetch')) : order.indexOf(phase);
    const names = ['Nummers ophalen', 'Jaartallen nakijken', 'Spelen'];
    return `<ol class="ms-steps" aria-hidden="true">${names.map((n, i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}"><span>${i < at ? icons.check : i + 1}</span>${n}</li>`).join('')}</ol>`;
  }

  function progressHtml() {
    const r = st.run;
    const pct = (a, b) => (b ? Math.max(3, Math.min(100, Math.round((a / b) * 100))) : 3);
    if (r.phase === 'fetch') {
      const txt = r.total ? `${r.read} van ${r.total}` : '';
      return `<p class="ms-step"><b>Nummers ophalen…</b> <span data-testid="sheet-progress-count">${txt}</span></p>
        <div class="pl-bar" aria-hidden="true"><i style="width:${pct(r.read, r.total)}%"></i></div>
        <p class="small muted">${st.src.kind === 'deezer' ? 'Uit de openbare catalogus van Deezer.' : 'Uit jouw Spotify.'}</p>`;
    }
    if (r.phase === 'years' || r.phase === 'now') {
      const s = r.status || {};
      const checked = Math.min(s.yearsChecked || 0, r.min);
      if (r.phase === 'now') {
        const have = Math.min(s.ready || 0, r.min);
        return `<p class="ms-step"><b>Jaartallen ophalen…</b> <span data-testid="sheet-progress-count">${have} van ${r.min}</span></p>
          <div class="pl-bar" aria-hidden="true"><i style="width:${pct(have, r.min)}%"></i></div>
          <p class="small muted">Je speelt zo met alle nummers die al een jaartal hebben. Niet alle jaartallen zijn nagekeken; bij oudere nummers kan er het jaar van een heruitgave staan.</p>`;
      }
      const wait = yearsWaitText({ done: Math.max(0, (r.lastChecked ?? 0) - (r.c0 ?? 0)), left: r.min - checked, startedAt: r.t0 || Date.now(), lastAt: r.lastAt || r.t0 });
      return `<p class="ms-step"><b>Jaartallen nakijken…</b> <span data-testid="sheet-progress-count">${checked} van ${r.min}</span> <span class="muted" data-testid="sheet-eta">· ${esc(wait)}</span></p>
        <div class="pl-bar" aria-hidden="true"><i style="width:${pct(checked, r.min)}%"></i></div>
        <p class="small muted">Catalogi geven bij oudere nummers vaak het jaar van een heruitgave. Daarom kijkt de app elk jaartal na bij MusicBrainz, ongeveer één per seconde. Bij ${r.min} nagekeken nummers start het spel vanzelf; de rest gaat op de achtergrond door.</p>`;
    }
    if (r.phase === 'error') {
      return `<p class="set-error" role="alert" data-testid="sheet-run-error">${esc(r.error)}</p>`;
    }
    return '';
  }

  function runHtml() {
    const r = st.run;
    const title = st.src ? headHtml({ small: true }) : `<header class="ms-head is-small"><span class="cover cover-md" aria-hidden="true">${noteIcon}</span><div class="ms-head-text"><p class="ms-kicker">Bewaarde playlist</p><h2 id="sheet-title" data-testid="sheet-title">${esc(r.name)}</h2></div>
      <button class="icon-btn ms-close" type="button" data-act="sheet-close" data-testid="sheet-close" aria-label="Sluiten">${icons.close}</button></header>`;
    const canNow = r.pid && (r.phase === 'years' || (r.phase === 'error' && r.failedAt === 'years'));
    return `${title}
      ${stepsHtml(r.phase)}
      <div class="ms-progress" data-testid="sheet-progress" data-phase="${r.phase}" role="status" aria-live="polite" data-slot="progress">${progressHtml()}</div>
      <div class="ms-actions">
        ${r.phase === 'error' ? `<button class="btn btn-primary" type="button" data-act="sheet-retry" data-testid="sheet-retry">${icons.restart}<span>Probeer opnieuw</span></button>` : ''}
        ${canNow ? `<button class="btn btn-secondary" type="button" data-act="sheet-anyway" data-testid="sheet-play-anyway">${icons.play}<span>Speel nu toch</span></button>
          <p class="small muted ms-honest">Speel nu toch: niet alle jaartallen zijn dan nagekeken; bij oudere nummers kan er het jaar van een heruitgave staan.</p>` : ''}
        <button class="btn btn-ghost btn-small" type="button" data-act="sheet-stop" data-testid="sheet-stop">${icons.close}<span>Stop</span></button>
      </div>`;
  }

  /** How the chosen list plays now (+ the way out when it cannot), redrawn while work goes on. */
  function readyHtml() {
    const { pid } = st.play;
    const p = pid === BUILTIN_ID ? null : store.get(pid);
    const src = musicSource();
    let info;
    if (p) {
      const counts = store.deckCounts(p, src);
      const spCounts = store.deckCounts(p, 'spotify');
      info = readinessInfo({ counts, source: src, spotifyPlayable: spCounts.inDeck, status: enrich.status(pid), playNow: p.playNow === true, spotifyConnected: spotify.isConnected() });
    } else info = { text: 'Klaar: het ingebouwde deck, ook als geprinte kaartjes.', tone: 'ok', action: null };
    // "Speelt met 33 van 120; van 87 andere wordt het jaartal nog ..." already says that the check runs
    const work = p && info.tone !== 'busy' ? workLine(enrich.status(pid), { source: src }) : '';
    const action = info.action === 'connect' || info.action === 'source'
      ? `<a class="btn btn-secondary btn-small" href="#/instellingen/spotify" data-act="go" data-testid="play-connect">${info.action === 'source' ? 'Kies Spotify' : 'Verbind Spotify'}</a>`
      : info.action === 'wait' ? '<button class="btn btn-secondary btn-small" type="button" data-act="play-wait" data-testid="play-wait">Wacht op de jaartallen</button>' : '';
    return `<div class="ms-ready is-${info.tone}" data-testid="play-ready"><p>${esc(info.text)}${work ? ` <span class="muted">${esc(work)}.</span>` : ''}</p>${action}</div>
      ${p?.playNow && (enrich.status(pid).yearsPending || 0) > 0 ? '<p class="small muted ms-honest" data-testid="play-honest">Niet alle jaartallen zijn nagekeken; bij oudere nummers kan er het jaar van een heruitgave staan.</p>' : ''}`;
  }

  function playHtml() {
    const { pid } = st.play;
    const p = pid === BUILTIN_ID ? null : store.get(pid);
    const name = p ? p.name : BUILTIN_NAME;
    const choice = (href, testid, icon, title, sub, cls = '') => `<a class="ms-choice ${cls}" href="${href}" data-act="go" data-testid="${testid}"><span class="ms-choice-ico">${icon}</span><span class="ms-choice-text"><b>${title}</b><small>${sub}</small></span></a>`;
    return `<header class="ms-head is-small">
        ${coverHtml(st.play.picture, 'cover-md')}
        <div class="ms-head-text"><p class="ms-kicker">Muziek gekozen</p><h2 id="sheet-title" data-testid="sheet-title"><span class="ms-name">${esc(name)}</span> staat klaar</h2></div>
        <button class="icon-btn ms-close" type="button" data-act="sheet-close" data-testid="sheet-close" aria-label="Sluiten">${icons.close}</button>
      </header>
      ${st.play.done ? `<p class="ms-done" data-testid="play-done">${esc(st.play.done)}</p>` : ''}
      <div data-slot="ready">${readyHtml()}</div>
      <h3 class="ms-how">Hoe wil je spelen?</h3>
      <div class="ms-choices">
        ${choice('#/spelleider', 'play-room', phonesIcon, 'Samen spelen', 'ieder op een eigen telefoon: Discobingo, quiz, Bingo of Tijdlijn', 'is-main')}
        ${choice('#/spel', 'play-timeline', timelineIcon, 'Op één toestel — Tijdlijn', 'geef de telefoon door en leg elk nummer op zijn plek')}
        ${choice('#/bingo', 'play-bingo', gridIcon, 'Op één toestel — Bingo', 'ieder een eigen bingokaart, eerst een volle rij')}
      </div>
      <p class="ms-links">${p ? `<a href="#/playlists/${esc(pid)}" data-act="go" data-testid="play-list">Bekijk de lijst</a><span aria-hidden="true"> · </span>` : ''}<a href="#/print${p ? `/${esc(pid)}` : ''}" data-act="go" data-testid="play-print">Kaartjes printen</a></p>`;
  }

  function keepFocus(fn) {
    const a = document.activeElement;
    const key = a && slot.contains(a) ? a.dataset.testid : null;
    const idx = key ? [...slot.querySelectorAll(`[data-testid="${key}"]`)].indexOf(a) : -1;
    fn();
    if (key) {
      const again = slot.querySelectorAll(`[data-testid="${CSS.escape(key)}"]`)[Math.max(0, idx)] || slot.querySelector(`[data-testid="${CSS.escape(key)}"]`);
      if (again) again.focus({ preventScroll: true });
      else focusFirst();
    }
  }

  function draw() {
    if (!st) return;
    const testid = st.view === 'play' ? 'play-sheet' : 'sheet-playlist';
    const body = st.view === 'list' ? listHtml() : st.view === 'run' ? runHtml() : playHtml();
    keepFocus(() => {
      let el = sheetEl();
      if (!el) {
        // built once per opening: redraws replace the content only (no new entry animation)
        slot.innerHTML = '<div class="sheet-backdrop ms-backdrop" data-act="sheet-backdrop"><div class="sheet ms-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"></div></div>';
        el = sheetEl();
      }
      el.dataset.testid = testid;
      el.dataset.view = st.view;
      el.dataset.kind = st.src?.kind || 'saved';
      el.innerHTML = body;
    });
  }

  /** Progress only (keeps the buttons and their focus as they are). */
  function drawProgress() {
    const box = slot.querySelector('[data-slot="progress"]');
    if (!box || !st?.run) { draw(); return; }
    if (box.dataset.phase !== st.run.phase) { draw(); return; }
    box.innerHTML = progressHtml();
  }

  function focusFirst() {
    const el = sheetEl();
    if (!el) return;
    const target = el.querySelector('[data-testid="sheet-play-now"], [data-testid="play-room"], [data-testid="sheet-stop"]') || el.querySelector('button, a[href]');
    target?.focus({ preventScroll: true });
  }

  /* ---------- the playlist sheet ---------- */

  async function loadPreview() {
    const my = gen;
    const s = st.src;
    st.loadCtrl?.abort();
    const ctrl = new AbortController();
    st.loadCtrl = ctrl;
    st.preview = { tracks: null, error: '' };
    drawTracks();
    try {
      if (s.kind === 'deezer' && (!s.name || s.count == null)) {
        const info = await deezer.playlistInfo(Number(s.id), { signal: ctrl.signal });
        if (my !== gen) return;
        Object.assign(s, { name: s.name || info.title || s.placeholder || '', count: info.count, by: s.by || info.by, picture: s.picture || info.picture });
        draw();
      }
      const tracks = s.kind === 'deezer'
        ? await deezer.playlistTracks(Number(s.id), { max: PREVIEW_ROWS, signal: ctrl.signal })
        : await spl.playlistTracks(s.id, { max: PREVIEW_ROWS, signal: ctrl.signal });
      if (my !== gen || ctrl.signal.aborted) return;
      st.preview = { tracks: tracks.slice(0, PREVIEW_ROWS), error: '' };
    } catch (e) {
      if (my !== gen || aborted(e, ctrl.signal)) return;
      st.preview = { tracks: [], error: errorText(s.kind, e) };
      if (s.kind === 'deezer' && e?.code === 'notfound' && !s.name) s.name = 'Playlist niet gevonden';
    }
    if (my === gen) draw();
  }

  function openSource(src) {
    open({ view: 'list', src: { ...src, id: String(src.id) }, preview: { tracks: null, error: '' } });
    loadPreview();
  }

  function listen(i) {
    const t = st.preview?.tracks?.[i];
    if (!t?.deezerId) return;
    const on = st.listening === t.deezerId && (player.state.status === 'playing' || player.state.status === 'loading');
    if (on) { player.stop(); st.listening = null; drawTracks(); return; }
    st.listening = t.deezerId;
    player.load({ id: `dz${t.deezerId}`, deezerId: t.deezerId, itunesId: null, previewUrl: null, title: t.title, artist: t.artist }, { autoplay: true, preview: true });
    drawTracks();
  }

  /* ---------- Speel direct / Bewaar ---------- */

  async function run(mode) {
    if (!st?.src) return;
    if (st.listening) { player.stop(); st.listening = null; }
    const my = gen;
    const ctrl = new AbortController();
    st.view = 'run';
    st.run = { mode, phase: 'fetch', read: 0, total: Number(st.src.count) || 0, ctrl, pid: null, min: FUN_MIN };
    draw();
    focusFirst();
    let out;
    try {
      out = await fetchAndImport(st.src, {
        signal: ctrl.signal,
        onProgress: (read, total) => { if (my === gen && st?.run) { st.run.read = read; st.run.total = total; drawProgress(); } },
      });
    } catch (e) {
      if (my !== gen || aborted(e, ctrl.signal)) return;
      st.run.phase = 'error'; st.run.failedAt = 'fetch'; st.run.error = errorText(st.src.kind, e);
      draw(); focusFirst();
      return;
    }
    if (my !== gen) return;
    const { res, longer } = out;
    if (res.error || !res.playlist) {
      st.run.phase = 'error'; st.run.failedAt = 'fetch';
      st.run.error = res.error === 'storage' ? store.STORAGE_FULL_MESSAGE : 'Deze lijst kon niet worden bewaard.';
      draw(); focusFirst();
      return;
    }
    const pid = res.playlist.id;
    let msg = importMessage(res);
    if (longer) msg += ` De lijst heeft ${longer} nummers; de eerste ${MAX_TRACKS} zijn bewaard.`;
    enrich.prioritise(pid);
    if (mode === 'save') {
      toast(msg, { ms: 3200 });
      st.view = 'list'; st.run = null; st.saved = msg;
      draw(); focusFirst();
      return;
    }
    if (!res.created) toast(msg, { ms: 2600 });
    st.picture = st.src.picture;
    checkYears(pid, my);
  }

  /** Step 2: wait for checked years (or Speel nu toch), then play. */
  function checkYears(pid, my = gen) {
    const p = store.get(pid);
    if (!p) return;
    const min = Math.max(1, Math.min(FUN_MIN, p.tracks.length));
    const ctrl = new AbortController();
    const s0 = enrich.status(pid);
    const now = Date.now();
    // the estimate comes from the rate seen from here on (t0, c0); lastAt: the last new checked song
    st.run = { ...(st.run || { mode: 'play' }), phase: 'years', pid, min, name: p.name, ctrl, status: s0, failedAt: null, t0: now, c0: s0.yearsChecked || 0, lastChecked: s0.yearsChecked || 0, lastAt: now };
    st.view = 'run';
    draw(); focusFirst();
    // the line moves on between progress events (the countdown, or "reageert traag")
    if (st.etaTimer) clearInterval(st.etaTimer);
    st.etaTimer = setInterval(() => { if (my === gen && st?.run?.phase === 'years') drawProgress(); else if (st?.etaTimer) { clearInterval(st.etaTimer); st.etaTimer = null; } }, 1000);
    enrich.prepare(pid, {
      min, signal: ctrl.signal,
      onProgress: (s) => {
        if (my !== gen || !st?.run || st.run.pid !== pid) return;
        st.run.status = s;
        if ((s.yearsChecked || 0) > st.run.lastChecked) { st.run.lastChecked = s.yearsChecked; st.run.lastAt = Date.now(); }
        if (st.run.phase === 'now') nowCheck();
        else drawProgress();
      },
    }).then((s) => {
      if (my !== gen || !st?.run || st.run.pid !== pid) return;
      const n = s.yearsChecked;
      const done = s.yearsPending > 0 ? `${plural(n, 'nummer', 'nummers')} nagekeken, de rest komt vanzelf.` : `${plural(n, 'jaartal', 'jaartallen')} nagekeken.`;
      finishPlay(pid, st.run.phase === 'now' ? '' : done);
    }).catch((e) => {
      if (my !== gen || !st?.run || st.run.pid !== pid || aborted(e, ctrl.signal)) return;
      if (st.run.phase === 'now') { finishPlay(pid, ''); return; }
      st.run.phase = 'error'; st.run.failedAt = 'years'; st.run.error = `${enrich.errorMessage(e)} Je kunt het opnieuw proberen of nu toch spelen.`;
      draw(); focusFirst();
    });
  }

  /** "Speel nu toch": every song with a year plays; wait a moment for those years (Deezer is fast). */
  function playAnyway() {
    const r = st.run;
    if (!r?.pid) return;
    store.setPlayNow(r.pid, true);
    if (r.phase === 'error') { finishPlay(r.pid, ''); return; }
    r.phase = 'now';
    r.nowUntil = Date.now() + NOW_WAIT_MS;
    st.nowTimer = setTimeout(() => { if (st?.run?.phase === 'now') finishPlay(r.pid, ''); }, NOW_WAIT_MS);
    draw(); focusFirst();
    nowCheck();
  }

  function nowCheck() {
    const r = st?.run;
    if (!r || r.phase !== 'now') return;
    const p = store.get(r.pid);
    const s = r.status || enrich.status(r.pid);
    const c = p ? store.deckCounts(p, musicSource()) : null;
    if (!p || c.inDeck >= r.min || (s.yearsMissing || 0) === 0 || s.ready >= r.min) { finishPlay(r.pid, ''); return; }
    drawProgress();
  }

  function finishPlay(pid, done) {
    if (!st) return;
    if (st.nowTimer) { clearTimeout(st.nowTimer); st.nowTimer = null; }
    if (st.etaTimer) { clearInterval(st.etaTimer); st.etaTimer = null; }
    // the year check goes on in the background (prepare is only the waiting moment)
    st.run?.ctrl?.abort();
    const p = store.get(pid);
    store.setActive(p ? pid : BUILTIN_ID);
    if (p) enrich.prioritise(pid);
    const pick = getPick();
    if (pick) {
      clearPick();
      markPicked(pick.code);
      toast(`Muziek voor kamer ${pick.code}: “${p ? p.name : BUILTIN_NAME}”.`, { ms: 2600 });
      leave(pick.back);
      return;
    }
    const picture = st.picture || st.src?.picture || null;
    st.view = 'play';
    st.run = null;
    st.play = { pid: p ? pid : BUILTIN_ID, done, picture };
    draw(); focusFirst();
  }

  /** "Speel" on the current list (Nu gekozen): first the years when too few are checked. */
  function openPlay(pid, { picture = null } = {}) {
    const p = pid === BUILTIN_ID ? null : store.get(pid);
    open({ view: 'play', src: null, play: { pid: p ? pid : BUILTIN_ID, done: '', picture }, picture });
    if (p && needsYears(p)) checkYears(pid);
  }

  function needsYears(p) {
    if (p.playNow) return false;
    const st2 = enrich.status(p.id);
    const c = store.deckCounts(p, musicSource());
    return st2.yearsPending > 0 && c.inDeck < Math.min(FUN_MIN, c.total) && st2.pending > 0;
  }

  /* ---------- events ---------- */

  function onClick(e) {
    const a = e.target.closest('[data-act]');
    if (!a || !slot.contains(a) || !st) return;
    const act = a.dataset.act;
    if (act === 'sheet-backdrop') { if (e.target === a && st.view !== 'run') close(); return; }
    switch (act) {
      case 'sheet-close': close(); break;
      case 'sheet-reload': loadPreview(); break;
      case 'sheet-listen': listen(Number(a.dataset.i)); break;
      case 'sheet-play-now': run('play'); break;
      case 'sheet-save': run('save'); break;
      case 'sheet-anyway': playAnyway(); break;
      case 'sheet-retry':
        if (st.run?.failedAt === 'years' && st.run.pid) checkYears(st.run.pid);
        else if (st.src) run(st.run?.mode || 'play');
        break;
      case 'sheet-stop':
        stopWork();
        if (st.src) { st.view = 'list'; st.run = null; draw(); focusFirst(); } else close();
        break;
      case 'play-wait': if (st.play?.pid && st.play.pid !== BUILTIN_ID) checkYears(st.play.pid); break;
      case 'go': e.preventDefault(); leave(a.getAttribute('href')); break;
      default:
    }
  }

  function onKey(e) {
    if (!st) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (st.view === 'run') { stopWork(); if (st.src) { st.view = 'list'; st.run = null; draw(); focusFirst(); } else close(); } else close();
      return;
    }
    if (e.key !== 'Tab') return;
    const el = sheetEl();
    if (!el) return;
    const items = [...el.querySelectorAll('button:not(:disabled), a[href], input, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  // covers that fail to load: the placeholder stays
  const onImgError = (e) => { if (e.target?.tagName === 'IMG') e.target.remove(); };

  slot.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  slot.addEventListener('error', onImgError, true);

  return {
    isOpen,
    openSource,
    openPlay,
    close,
    /** Redraw after outside changes (store / Spotify). */
    refresh: () => { if (st && st.view !== 'run') draw(); },
    destroy() {
      stopWork();
      st = null;
      offPlayer?.(); offPlayer = null;
      offEnrich?.(); offEnrich = null;
      document.body.classList.remove('has-sheet');
      window.removeEventListener('popstate', onPop);
      slot.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      slot.removeEventListener('error', onImgError, true);
    },
  };
}
