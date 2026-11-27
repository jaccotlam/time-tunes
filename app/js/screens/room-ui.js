// "Samen spelen": rendering shared by the host screen (room-host.js) and the player
// screen (room-player.js). Everything here works on a player view from multi/protocol.js
// (viewFor), so the host's own panel looks and behaves exactly like a player's phone.
import qrcode from '../../vendor/qrcode-generator.mjs';
import { SQUARES, YEAR_MARGIN, parseYearGuess } from '../bingo.js';
import { FREE } from '../multi/game.js';
import { joinUrl } from '../multi/code.js';
import { icons, esc } from '../ui.js';
import { bingoCardHtml } from './bingo.js';
import { answerHtml } from './answer.js';
import { avatarHtml } from './party-ui.js';

/** Base URL of the app (without hash), for the join link. */
export function appBase() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}
export const roomLink = (code) => joinUrl(appBase(), code);

/** QR code as an SVG (white quiet zone, scales to any size). */
export function qrSvg(text, { margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const size = n + margin * 2;
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR-code om mee te doen"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/**
 * Replace the inner HTML of `el` only when it changed, and keep focus and caret on the
 * element with the same data-testid (so typing is never interrupted by an update).
 */
export function patch(el, html) {
  if (!el || el.__html === html) return false;
  const active = document.activeElement;
  const keep = active && el.contains(active) ? active.dataset?.testid : null;
  const sel = keep && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  el.innerHTML = html;
  el.__html = html;
  if (keep) {
    const again = el.querySelector(`[data-testid="${keep}"]`);
    if (again) {
      again.focus({ preventScroll: true });
      if (sel && again.setSelectionRange) { try { again.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } }
    }
  }
  return true;
}

const STATUS_TEXT = {
  idle: 'Verbinden…',
  connecting: 'Verbinden…',
  online: 'Verbonden',
  reconnecting: 'Verbinding kwijt, opnieuw proberen…',
  notfound: 'Kamer niet gevonden, opnieuw proberen…',
  taken: 'Kamer wordt hersteld…',
  closed: 'Niet verbonden',
  waking: 'Server wordt wakker…',
  unreachable: 'Server niet bereikbaar, opnieuw proberen…',
};

/** Small connection badge: data-state = connecting | online | reconnecting | notfound | taken | closed. */
export function connBadge(status, text) {
  const s = status || 'connecting';
  return `<span class="conn" data-testid="conn-status" data-state="${esc(s)}" role="status"><i aria-hidden="true"></i><span>${esc(text || STATUS_TEXT[s] || s)}</span></span>`;
}

/** Players as chips: online dot, "answered" tick, score. */
export function playersHtml(view, { host = false, removable = false } = {}) {
  const answering = view.phase === 'answering';
  return `<ul class="room-players" data-testid="room-players" aria-label="Spelers">
    ${view.players.map((p, i) => {
    const state = !p.online ? 'offline' : answering && p.playing ? (p.answered ? 'answered' : 'thinking') : 'online';
    const label = !p.online ? 'offline' : answering && p.playing ? (p.answered ? 'heeft geantwoord' : 'denkt na') : 'online';
    return `<li class="rp is-${state}${view.you && p.id === view.you.id ? ' is-you' : ''}" data-testid="room-player-${i}" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-online="${p.online}" data-answered="${p.answered}">
      <span class="rp-dot" aria-hidden="true">${state === 'answered' ? icons.check : ''}</span>
      ${avatarHtml(p, { cls: 'rp-av' })}
      <span class="rp-name">${esc(p.name)}${p.host ? ' <small>(spelleider)</small>' : ''}${view.you && p.id === view.you.id && !host ? ' <small>(jij)</small>' : ''}</span>
      <span class="rp-state">${label}</span>
      ${view.game && p.playing ? `<b class="rp-score" title="score">${p.score}</b>` : ''}
      ${removable && !p.host ? `<button type="button" class="icon-btn rp-remove" data-action="remove" data-id="${esc(p.id)}" data-name="${esc(p.name)}" aria-label="Verwijder ${esc(p.name)}" data-testid="room-remove-${i}">${icons.close}</button>` : ''}
    </li>`;
  }).join('')}
  </ul>`;
}

/** Tussenstand: name + score, best first. */
export function standingsHtml(view) {
  const g = view.game;
  const list = view.players.filter((p) => p.playing).slice().sort((a, b) => b.score - a.score);
  const unit = g.kind === 'bingo' || g.kind === 'disco' ? 'vakjes' : g.kind === 'quiz' ? 'punten' : `van ${g.goal}`;
  const winners = new Set(g.winnerIds || []);
  const roundWinners = new Set(g.reveal?.roundWinners || []);
  return `<ol class="ranking room-standings" data-testid="room-standings" aria-label="Tussenstand">
    ${list.map((p) => `<li class="${winners.has(p.id) || roundWinners.has(p.name) ? 'is-winner' : ''}" data-name="${esc(p.name)}">${avatarHtml(p, { cls: 'rk-av' })}<span>${esc(p.name)}</span><b>${p.score}</b><small>${unit}</small></li>`).join('')}
  </ol>`;
}

/* ---------- answering: the player's own card / timeline ---------- */

/** Local (not yet sent) choice of the player: { index, guess, text } or { slot }. */
export function emptyChoice() { return { index: null, guess: '', text: '', slot: null }; }

/** The answer the local choice would send, or null when it is not complete. */
export function choiceToAnswer(view, choice) {
  const g = view.game;
  if (!g?.mine) return null;
  if (g.kind === 'bingo') {
    if (choice.index == null) return null;
    const key = g.mine.card[choice.index];
    if (key === 'year') return parseYearGuess(choice.guess) == null ? null : { index: choice.index, guess: choice.guess };
    if (key === 'artist' || key === 'title') return choice.text.trim() ? { index: choice.index, text: choice.text.trim() } : null;
    return { index: choice.index };
  }
  return choice.slot == null ? null : { slot: choice.slot };
}

const sameAnswer = (a, b) => !!a && !!b && JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
const normalizeForCompare = (a) => (a.pass ? { pass: true } : a.slot != null ? { slot: a.slot } : { index: a.index, guess: a.guess != null ? Number(a.guess) : undefined, text: a.text || undefined });

/** Short text for a sent answer. */
export function answerText(view, a) {
  if (!a) return '';
  if (a.pass) return 'Je past deze ronde';
  if (view.game.kind === 'timeline') return slotLabel(view.game.mine.timeline.map((c) => c.year), a.slot);
  const key = view.game.mine.card[a.index];
  const sq = SQUARES[key];
  if (key === 'year') return `${sq.label}: ${a.guess}`;
  if (key === 'artist' || key === 'title') return `${sq.label}: “${a.text}”`;
  return sq.label;
}

export function slotLabel(years, i) {
  if (years.length === 0) return 'Hier';
  if (i === 0) return `Vóór ${years[0]}`;
  if (i === years.length) return `Na ${years[years.length - 1]}`;
  return `Tussen ${years[i - 1]} en ${years[i]}`;
}

function marksForCard(mine) {
  const years = { [FREE]: 'vrij' };
  const marks = mine.marks.map((m, i) => (m == null ? null : `m${i}`));
  mine.marks.forEach((m, i) => { if (m != null) years[`m${i}`] = m === FREE ? 'vrij' : m; });
  return { marks, years };
}

/** A player's bingo card from a view (optionally selectable / with highlights). */
export function viewBingoCard(view, { selectable = false, selected = null, highlight = null, testid = 'bingo-card' } = {}) {
  const g = view.game;
  const { marks, years } = marksForCard(g.mine);
  return bingoCardHtml({ name: view.you?.name || '', card: g.mine.card, marks }, g.size, {
    selectable, selected, highlight, years, winLine: g.mine.winLine, testid,
  });
}

/** A player's timeline from a view; with `selectable` every gap is a button. */
export function viewTimeline(items, { selectable = false, selected = null, locked = null, highlight = null, name = '' } = {}) {
  const years = items.map((c) => c.year);
  const parts = [];
  const gap = (i) => {
    if (!selectable) return '';
    const sel = selected === i;
    const lock = locked === i;
    return `<li class="gap ${sel ? 'is-selected' : ''} ${lock ? 'is-locked' : ''}">
      <button type="button" class="gap-btn" data-action="slot" data-slot="${i}" data-testid="slot-${i}" aria-pressed="${sel}">
        ${sel || lock
    ? `<span class="mystery">${icons.music}<span><b>${lock && !sel ? 'Vastgezet' : 'Dit nummer'}</b><small>${esc(slotLabel(years, i))}</small></span></span>`
    : `<span class="gap-plus">${icons.plus}</span><span class="gap-text">${esc(slotLabel(years, i))}</span>`}
      </button>
    </li>`;
  };
  items.forEach((c, i) => {
    parts.push(gap(i));
    const isNew = highlight != null && highlight === i;
    parts.push(`<li class="tl-card ${isNew ? 'is-new' : ''}" data-testid="tl-card">
      <span class="tl-year">${esc(c.year)}</span>
      <span class="tl-meta"><span class="tl-artist">${esc(c.artist)}</span><span class="tl-title">${esc(c.title)}</span></span>
    </li>`);
  });
  parts.push(gap(items.length));
  return `<ol class="timeline ${selectable ? 'is-selectable' : ''}" data-testid="timeline" aria-label="Tijdlijn${name ? ` van ${esc(name)}` : ''}">${parts.join('')}</ol>`;
}

/**
 * The answering panel: own card/timeline, the choice, "Zet vast" and (bingo) "Pas".
 * data-state on [data-testid=answer-state]: none | changed | locked.
 */
export function answerPanelHtml(view, choice, { sending = false } = {}) {
  const g = view.game;
  if (!g?.mine) return '<p class="muted" data-testid="answer-none">Je doet vanaf de volgende ronde mee.</p>';
  const sent = g.answer;
  const proposed = choiceToAnswer(view, choice);
  const changed = !!proposed && !sameAnswer(proposed, sent);
  const state = sent && !changed ? 'locked' : changed ? 'changed' : 'none';
  let body;
  let detail = '';
  if (g.kind === 'bingo') {
    const sel = choice.index ?? (sent && !sent.pass ? sent.index : null);
    body = viewBingoCard(view, { selectable: true, selected: sel });
    if (choice.index != null) {
      const key = g.mine.card[choice.index];
      const sq = SQUARES[key];
      if (key === 'year') {
        detail = `<div class="ra-detail" data-testid="answer-detail"><label for="ra-year">Welk jaar? <span class="muted">(±${YEAR_MARGIN} is goed)</span></label>
          <input id="ra-year" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="bv. 1987" value="${esc(choice.guess)}" data-testid="answer-year-input" autocomplete="off" enterkeyhint="done"></div>`;
      } else if (key === 'artist' || key === 'title') {
        detail = `<div class="ra-detail" data-testid="answer-detail"><label for="ra-text">${key === 'artist' ? 'Wie is de artiest?' : 'Hoe heet het nummer?'}</label>
          <input id="ra-text" type="text" maxlength="60" placeholder="${key === 'artist' ? 'Typ de artiest' : 'Typ de titel'}" value="${esc(choice.text)}" data-testid="answer-text-input" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done">
          <small class="muted">Kleine typefouten zijn niet erg.</small></div>`;
      } else {
        detail = `<p class="ra-detail" data-testid="answer-detail">Je kiest <b>${esc(sq.label)}</b> <span class="muted">(${esc(sq.range || sq.sub)})</span>.</p>`;
      }
    }
  } else {
    const sel = choice.slot;
    body = viewTimeline(g.mine.timeline, { selectable: true, selected: sel, locked: sent && sel == null ? sent.slot : null, name: view.you?.name });
  }
  const lockLabel = sending ? 'Versturen…' : state === 'locked' ? 'Vastgezet' : !proposed ? (g.kind === 'bingo' ? (choice.index == null ? 'Kies een vakje' : 'Vul je antwoord in') : 'Kies een plek') : sent ? 'Wijzig mijn antwoord' : 'Zet vast';
  const stateText = state === 'locked'
    ? `<b>Vastgezet:</b> ${esc(answerText(view, sent))}. <span class="muted">Wijzigen kan tot de onthulling.</span>`
    : state === 'changed' && sent ? `Nog vastgezet: ${esc(answerText(view, sent))}. <span class="muted">Tik op wijzigen om dit te vervangen.</span>`
      : g.kind === 'bingo' ? 'Kies één open vakje dat bij dit nummer past, of pas.' : 'Waar hoort dit nummer in jouw tijdlijn? Oud boven, nieuw onder.';
  const tooFewOpen = g.kind === 'bingo';
  return `<div class="ra" data-testid="play-panel" data-kind="${g.kind}">
    <p class="ra-state" data-testid="answer-state" data-state="${state}">${state === 'locked' ? icons.check : ''}<span>${stateText}</span></p>
    ${body}
    ${detail}
    <div class="ra-actions">
      <button class="btn btn-primary btn-xl" type="button" data-action="lock" data-testid="answer-lock" ${proposed && changed && !sending ? '' : 'disabled'}>${icons.check}<span>${lockLabel}</span></button>
      ${tooFewOpen ? `<button class="btn btn-ghost btn-small" type="button" data-action="pass" data-testid="answer-pass" ${sent?.pass ? 'disabled' : ''}>Pas deze ronde</button>` : ''}
    </div>
  </div>`;
}

/**
 * Handles taps and typing in the answering panel (both screens).
 * getView(): current view; send(answer): lock the answer; refresh(): re-render the panel.
 * Returns { choice, key(), onClick(e) -> handled?, onInput(e), onKeyDown(e), reset() }.
 */
export function answerController({ getView, send, refresh }) {
  let choice = emptyChoice();
  let round = null;
  const ctl = {
    get choice() { return choice; },
    /** Reset the local choice when a new round starts. */
    sync() {
      const v = getView();
      const r = v?.game && v.phase === 'answering' ? `${v.game.kind}:${v.game.round}` : null;
      if (r !== round) { round = r; choice = emptyChoice(); }
    },
    /** Everything the panel's markup depends on, except what is being typed. */
    key() {
      const v = getView();
      const g = v?.game;
      return JSON.stringify([v?.phase, g?.kind, g?.round, g?.mine, g?.answer, choice.index, choice.slot]);
    },
    onClick(e) {
      const a = e.target.closest('[data-action]');
      if (!a) return false;
      const v = getView();
      if (!v?.game?.mine || v.phase !== 'answering') return false;
      const act = a.dataset.action;
      if (act === 'cell') {
        const i = Number(a.dataset.index);
        if (v.game.mine.marks[i] != null) return true;
        if (choice.index !== i) choice = { ...choice, index: i, guess: '', text: '' };
        refresh();
        const inp = document.querySelector('[data-testid="answer-year-input"], [data-testid="answer-text-input"]');
        if (inp) inp.focus({ preventScroll: false });
        return true;
      }
      if (act === 'slot') {
        choice = { ...choice, slot: Number(a.dataset.slot) };
        refresh();
        return true;
      }
      if (act === 'lock') {
        const ans = choiceToAnswer(v, choice);
        if (ans) {
          send(ans);
          if (v.game.kind === 'timeline') choice = { ...choice, slot: null };
        }
        return true;
      }
      if (act === 'pass') {
        choice = emptyChoice();
        send({ pass: true });
        return true;
      }
      return false;
    },
    onInput(e) {
      const t = e.target;
      if (t.matches('[data-testid="answer-year-input"]')) {
        const clean = t.value.replace(/\D/g, '').slice(0, 4);
        if (clean !== t.value) t.value = clean;
        choice = { ...choice, guess: clean };
      } else if (t.matches('[data-testid="answer-text-input"]')) {
        choice = { ...choice, text: t.value };
      } else return;
      // update the button and state line in place: re-rendering would close the phone's keyboard
      const v = getView();
      const panel = t.closest('[data-testid="play-panel"]');
      if (!panel || !v) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = answerPanelHtml(v, choice);
      for (const id of ['answer-lock', 'answer-state']) {
        const fresh = tmp.querySelector(`[data-testid="${id}"]`);
        const cur = panel.querySelector(`[data-testid="${id}"]`);
        if (fresh && cur) cur.replaceWith(fresh);
      }
    },
    onKeyDown(e) {
      if (e.key === 'Enter' && e.target.matches('[data-testid="answer-year-input"], [data-testid="answer-text-input"]')) {
        e.preventDefault();
        e.target.closest('[data-testid="play-panel"]')?.querySelector('[data-testid="answer-lock"]')?.click();
      }
    },
  };
  return ctl;
}

/* ---------- after the reveal ---------- */

/** Own outcome of the round. */
export function myResultHtml(view) {
  const r = view.game.reveal?.mine;
  if (!r) return '';
  const song = view.game.reveal.song;
  let text;
  let cls;
  if (r.none) { text = 'Je hebt niet geantwoord'; cls = 'is-none'; } else if (r.pass) { text = 'Je hebt gepast'; cls = 'is-none'; } else if (r.correct) { text = view.game.kind === 'bingo' ? 'Goed! Vakje afgestempeld' : 'Goed! De kaart is van jou'; cls = 'is-good'; } else { text = view.game.kind === 'bingo' ? 'Helaas, het vakje blijft open' : 'Helaas, de kaart gaat weg'; cls = 'is-bad'; }
  let explain = '';
  if (!r.none && !r.pass) {
    if (view.game.kind === 'bingo' && r.key === 'year') explain = `Jij zei ${esc(r.guess)}; het is ${esc(song.year)}.`;
    else if (r.typed) explain = `Jij typte “${esc(r.text)}”.${r.overridden ? ' De spelleider heeft het oordeel omgedraaid.' : ''}`;
    else if (view.game.kind === 'timeline' && !r.correct && r.correctSlots?.length) explain = `Hij hoorde ${esc(slotLabel(view.game.reveal.before?.map((c) => c.year) || [], r.correctSlots[0]).toLowerCase())}.`;
    else if (view.game.kind === 'timeline' && view.game.reveal.before) explain = `Jij koos: ${esc(slotLabel(view.game.reveal.before.map((c) => c.year), r.slot).toLowerCase())}.`;
    else if (r.label) explain = `Jij koos ${esc(r.label)}.`;
    if (r.overridden && !r.typed) explain += ' De spelleider heeft het oordeel omgedraaid.';
  }
  const icon = cls === 'is-good' ? icons.check : cls === 'is-bad' ? icons.cross : '';
  return `<div class="result room-result ${cls}" data-testid="my-result" data-correct="${r.none || r.pass ? 'none' : r.correct}">
    ${icon ? `<span class="result-icon">${icon}</span>` : ''}<span class="result-text">${esc(text)}</span>
  </div>${explain ? `<p class="result-explain" data-testid="my-result-explain">${explain}</p>` : ''}`;
}

/** The revealed song (same answer card as elsewhere in the app). */
export function songHtml(view) {
  const s = view.game.reveal?.song;
  if (!s) return '';
  const by = Array.isArray(s.by) && s.by.length
    ? `<p class="mix-by" data-testid="room-song-by">Uit de favorieten van <b>${s.by.map(esc).join(' &amp; ')}</b></p>` : '';
  return answerHtml({ year: s.year, artist: s.artist, title: s.title }) + by;
}

/** Who had it right this round (players see everybody's outcome after the reveal). */
export function roundResultsHtml(view, { host = false } = {}) {
  const rs = view.game.reveal?.results || [];
  return `<ul class="round-results" data-testid="room-results">
    ${rs.map((r, i) => {
    const state = r.none ? 'none' : r.pass ? 'pass' : r.correct ? 'good' : 'bad';
    return `<li class="rr is-${state}" data-testid="room-result-${i}" data-name="${esc(r.name)}" data-correct="${r.none || r.pass ? 'none' : r.correct}">
      <span class="rr-icon" aria-hidden="true">${state === 'good' ? icons.check : state === 'bad' ? icons.cross : '–'}</span>
      <span class="rr-name">${avatarHtml(r, { cls: 'rr-av' })}${esc(r.name)}</span>
      <span class="rr-label">${esc(r.label)}</span>
      ${host && r.canOverride ? `<button type="button" class="btn btn-small btn-ghost rr-flip${r.doubt ? ' is-doubt' : ''}" data-action="override" data-id="${esc(r.id)}" data-testid="room-override-${i}" aria-label="Oordeel omdraaien voor ${esc(r.name)}">${r.correct ? 'Toch fout' : 'Toch goed'}</button>` : ''}
    </li>`;
  }).join('')}
  </ul>`;
}

/** Winner block for both screens. */
export function winnerHtml(view) {
  const g = view.game;
  const names = g.winners;
  const title = names.length === 1 ? `${esc(names[0])} wint!` : `Gedeelde winst: ${names.map(esc).join(' & ')}`;
  const why = g.endedBy === 'pile'
    ? 'De nummers zijn op: de hoogste score wint.'
    : g.kind === 'bingo' ? 'Als eerste een volle rij, kolom of diagonaal.'
      : g.kind === 'disco' ? (g.disco?.win === 'full' ? 'Als eerste de hele kaart vol.' : `Als eerste ${g.disco?.win === 'line2' ? '2 lijnen' : '1 lijn'} vol.`)
        : `Als eerste ${g.goal} kaarten op de juiste plek.`;
  // the winners' avatars (from the players list: the names alone do not say who is who)
  const ids = g.winnerIds || [];
  const avs = ids.map((id) => view.players?.find((p) => p.id === id)).filter(Boolean);
  return `<div class="winner" data-testid="room-winner">
    <span class="winner-trophy">${icons.trophy}</span>
    ${avs.length ? `<span class="winner-avs" data-testid="winner-avatars">${avs.map((p) => avatarHtml(p, { cls: 'winner-av' })).join('')}</span>` : ''}
    <h2 class="winner-name" data-testid="room-winner-name">${title}</h2>
    <p class="muted">${why}</p>
  </div>`;
}

export function confettiHtml() {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return '';
  return `<div class="confetti" aria-hidden="true">${Array.from({ length: 36 }, () => `<i style="--x:${(Math.random() * 100).toFixed(1)}%;--d:${(2.4 + Math.random() * 2.2).toFixed(2)}s;--dl:${(-Math.random() * 4).toFixed(2)}s;--r:${Math.round(360 + Math.random() * 720)}deg"></i>`).join('')}</div>`;
}

/**
 * Ask the phone to keep the screen on while a room screen is open (Screen Wake Lock;
 * silently ignored where unsupported). The lock drops when the page is hidden, so it is
 * requested again when the page comes back. Returns a function that releases it.
 */
export function keepAwake() {
  let lock = null;
  let on = true;
  const request = async () => {
    if (!on || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    try { lock = await navigator.wakeLock.request('screen'); } catch { lock = null; }
    if (!on && lock) lock.release().catch(() => {});
  };
  const onVisible = () => { if (document.visibilityState === 'visible') request(); };
  document.addEventListener('visibilitychange', onVisible);
  request();
  return () => {
    on = false;
    document.removeEventListener('visibilitychange', onVisible);
    if (lock) lock.release().catch(() => {});
  };
}

/** Name of the game for titles. */
export const gameName = (kind) => (kind === 'timeline' ? 'Tijdlijn' : kind === 'quiz' ? 'Quiz' : kind === 'disco' ? 'Discobingo' : 'Bingo');

/* ---------- room server: step-by-step diagnosis, leader away ---------- */

/** Show the steps (instead of a bare spinner) once something fails or takes a while. */
export function diagVisible(diag, status) {
  if (!diag) return false;
  if (status === 'online') return false;
  if (diag.waking) return true;
  if (Object.values(diag.steps).some((s) => s.state === 'fail')) return true;
  return Date.now() - diag.started > 4000;
}

function stepAdvice(key, step, { role, code }) {
  const c = step.code || '';
  if (key === 'server') {
    if (c === 'offline') return 'Je telefoon heeft geen internet. Zet wifi of mobiele data aan.';
    if (c === 'timeout') return 'De server reageert niet. Misschien slaapt hij nog of ligt hij plat. We blijven het proberen.';
    if (c === 'version') return 'De server en deze app passen niet bij elkaar. Ververs de pagina.';
    return 'De server is niet bereikbaar. Controleer je internet. Lukt het op wifi niet, probeer dan mobiele data (of andersom).';
  }
  if (key === 'room') {
    if (c === 'notfound') {
      return role === 'host'
        ? 'De kamer staat niet meer op de server. Maak een nieuwe kamer.'
        : `Er is geen kamer met code ${code}. Klopt de code? Staat het scherm van de spelleider nog aan? We blijven zoeken.`;
    }
    if (c === 'ratelimit') return 'Te veel nieuwe kamers in korte tijd. Wacht een paar minuten.';
    return role === 'host' ? 'De server kon geen kamer maken. We proberen het opnieuw.' : 'De kamer kon niet worden opgezocht. We proberen het opnieuw.';
  }
  if (c === 'token') return 'Deze plek in de kamer hoort bij een ander toestel.';
  if (/^ws-/.test(c)) return 'De server is bereikt, maar de live-verbinding lukt niet. Sommige netwerken (school, werk, hotel) blokkeren dat: probeer mobiele data.';
  return 'Binnenkomen in de kamer lukte niet. We proberen het opnieuw.';
}

/**
 * Steps of connecting: server reached, room found/made, in the room (✓ / ✗ / …), with in plain
 * Dutch what to do, a wake-up bar for a sleeping server and "Kopieer diagnose".
 */
export function diagHtml(diag, { role = 'player', code = '' } = {}) {
  const labels = { server: 'Server bereikt', room: role === 'host' ? 'Kamer gemaakt' : `Kamer ${code} gevonden`, join: 'In de kamer' };
  const now = Date.now();
  let advice = '';
  const rows = ['server', 'room', 'join'].map((k) => {
    const st = diag.steps[k];
    const mark = st.state === 'ok' ? icons.check : st.state === 'fail' ? icons.cross : st.state === 'busy' ? '<i class="diag-spin" aria-hidden="true"></i>' : '';
    const secs = (st.state === 'busy' || st.retrying) && st.t0 ? Math.floor((now - st.t0) / 1000) : null;
    const word = st.retrying && st.state === 'fail' ? 'mislukt · opnieuw…' : ({ ok: 'gelukt', fail: 'mislukt', busy: 'bezig', idle: 'nog niet' }[st.state] || '');
    if (st.state === 'fail' && !advice) advice = stepAdvice(k, st, { role, code });
    return `<li class="diag-step is-${st.state}" data-testid="diag-step-${k}" data-state="${st.state}"${st.code ? ` data-code="${esc(st.code)}"` : ''}>
      <span class="diag-mark" aria-hidden="true">${mark}</span>
      <span class="diag-label">${esc(labels[k])}</span>
      <span class="diag-word">${word}${secs != null && secs >= 2 ? ` · ${secs} s` : ''}</span>
    </li>`;
  }).join('');
  let wake = '';
  if (diag.waking) {
    const secs = Math.floor((now - diag.waking.since) / 1000);
    const pct = Math.min(95, Math.round((secs / 60) * 100));
    wake = `<div class="wake" data-testid="server-waking">
      <p><b>Server wordt wakker…</b> Hij sliep omdat er een tijdje niemand speelde. Dat duurt meestal minder dan een minuut.</p>
      <div class="wake-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      <p class="muted small">${secs} s</p>
    </div>`;
  }
  return `<section class="diag" data-testid="conn-diag" aria-label="Verbinding">
    ${wake}
    <ol class="diag-steps">${rows}</ol>
    ${advice ? `<p class="diag-advice" data-testid="diag-advice">${esc(advice)}</p>` : ''}
    <div class="diag-actions">
      <button class="btn btn-small btn-ghost" type="button" data-action="retry" data-testid="diag-retry">${icons.restart}<span>Nu opnieuw</span></button>
      <button class="btn btn-small btn-ghost" type="button" data-action="copy-diag" data-testid="diag-copy">${icons.share}<span>Kopieer diagnose</span></button>
    </div>
  </section>`;
}

/** Key for redrawing the diagnosis (changes every second while something is busy). */
export function diagKey(diag) {
  if (!diag) return '';
  const busy = Object.values(diag.steps).some((s) => s.state === 'busy' || s.retrying) || diag.waking;
  return JSON.stringify([diag.steps, !!diag.waking, busy ? Math.floor(Date.now() / 1000) : 0]);
}

/**
 * "De spelleider is even weg" (+ after a while: take the lead). A prepared room whose owner has
 * not opened it yet is no trouble: guests are simply early (a calm line, no take-over); where
 * the server allows no take-over (meta.takeover false, takeoverMs null) none is offered or counted down.
 */
export function leaderAwayHtml(meta, { awayMs }) {
  if (meta?.waitingForOwner) {
    return `<div class="leader-away is-waiting" data-testid="waiting-for-owner" role="status">
    <p><span class="lobby-dots" aria-hidden="true"><i></i><i></i><i></i></span><span><b>De spelleider opent de kamer zo.</b> Je bent er vroeg bij!</span></p>
  </div>`;
  }
  if (meta?.takeover === false || !Number.isFinite(meta?.takeoverMs)) {
    return `<div class="leader-away" data-testid="room-leader-away" data-can-take="false">
    <p><b>De spelleider is even weg.</b> Je blijft in de kamer; het spel gaat verder zodra hij terug is.</p>
  </div>`;
  }
  const left = Math.max(0, Math.ceil((meta.takeoverMs - awayMs) / 1000));
  const can = left === 0;
  return `<div class="leader-away" data-testid="room-leader-away" data-can-take="${can}">
    <p><b>De spelleider is even weg.</b> ${can
    ? 'Komt hij niet terug? Dan kun jij de leiding overnemen: de muziek speelt dan op jouw telefoon.'
    : 'Je blijft in de kamer; het spel gaat verder zodra hij terug is.'}</p>
    ${can
    ? `<button class="btn btn-primary" type="button" data-action="takeover" data-testid="room-takeover">${icons.music}<span>Neem de leiding over</span></button>`
    : `<p class="muted small" data-testid="room-takeover-wait">Over ${left} s kun je zo nodig de leiding overnemen.</p>`}
  </div>`;
}

/* ---------- Quiz ---------- */

const LETTER = ['A', 'B', 'C', 'D'];
const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;
const QTYPE_LABEL = { mix: 'jaar, artiest en titel door elkaar', year: 'jaartallen', artist: 'artiesten', title: 'titels' };

/** "10 vragen, 20 s bedenktijd, …" for the lobby of a player. */
export const quizSettingsText = (s) => `${s.questions} vragen, ${s.think} s bedenktijd, ${QTYPE_LABEL[s.qtype] || QTYPE_LABEL.mix}`;

/** Seconds left on the quiz clock (server time), or null while the clock waits for the music. */
export function quizLeft(q, serverNow) {
  if (!q?.deadline) return null;
  return Math.max(0, Math.ceil((q.deadline - serverNow) / 1000));
}

function clockHtml(q, serverNow) {
  const left = quizLeft(q, serverNow);
  const pct = left == null ? 100 : Math.max(0, Math.min(100, ((q.deadline - serverNow) / (q.think * 1000)) * 100));
  return `<div class="quiz-clock${left == null ? ' is-waiting' : ''}${left != null && left <= 5 ? ' is-low' : ''}" data-testid="quiz-timer" data-deadline="${q.deadline || ''}" data-think="${q.think}" data-left="${left ?? ''}" role="timer" aria-live="off">
    <span class="quiz-clock-bar" aria-hidden="true"><i style="width:${pct.toFixed(1)}%"></i></span>
    <b class="quiz-clock-num">${left == null ? '…' : left}</b>
  </div>`;
}

/** Keep every quiz clock on the page running between redraws (no re-render, so no lost taps). Returns true when one ran out. */
export function tickQuizClocks(root, serverNow) {
  let expired = false;
  for (const el of root.querySelectorAll('[data-testid="quiz-timer"][data-deadline]')) {
    const deadline = Number(el.dataset.deadline);
    if (!deadline) continue;
    const ms = deadline - serverNow;
    const left = Math.max(0, Math.ceil(ms / 1000));
    if (String(left) !== el.dataset.left) {
      el.dataset.left = String(left);
      el.querySelector('.quiz-clock-num').textContent = String(left);
      el.classList.toggle('is-low', left <= 5);
      if (left === 0) expired = true;
    }
    const bar = el.querySelector('.quiz-clock-bar i');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (ms / (Number(el.dataset.think) * 1000)) * 100)).toFixed(1)}%`;
  }
  return expired;
}

/**
 * The question with its four answers. `selectable`: this phone answers (a player, or the
 * spelleider who plays along); otherwise it only shows (the spelleider's big screen).
 */
export function quizQuestionHtml(view, { selectable = false, serverNow = Date.now(), sending = false, testid = 'quiz-question', own = false } = {}) {
  const g = view.game;
  const q = g.quiz;
  const started = !!q.deadline;
  const left = quizLeft(q, serverNow);
  const chosen = q.choice;
  const open = selectable && !!g.mine && started && left > 0 && chosen == null && !sending;
  let state = '';
  if (selectable) {
    if (!g.mine) state = '<p class="quiz-state" data-testid="quiz-state" data-state="none">Je doet vanaf de volgende vraag mee.</p>';
    else if (chosen != null) state = `<p class="quiz-state is-locked" data-testid="quiz-state" data-state="locked">${icons.check}<span>Je antwoord staat vast: <b>${LETTER[chosen]}</b>. Wacht op de anderen…</span></p>`;
    else if (sending) state = '<p class="quiz-state" data-testid="quiz-state" data-state="sending">Versturen…</p>';
    else if (!started) state = '<p class="quiz-state" data-testid="quiz-state" data-state="waiting">Luister… de klok start zodra de muziek speelt.</p>';
    else if (left === 0) state = '<p class="quiz-state" data-testid="quiz-state" data-state="late">De tijd is om.</p>';
    else state = '<p class="quiz-state" data-testid="quiz-state" data-state="open">Kies snel: hoe sneller goed, hoe meer punten.</p>';
  }
  return `<section class="quiz-q${own ? ' is-own' : ''}" data-testid="${testid}" data-type="${esc(q.type)}" data-round="${g.round}">
    ${own ? '' : `<div class="quiz-top">
      <p class="quiz-num" data-testid="quiz-num">Vraag ${g.round} van ${q.total}</p>
      ${clockHtml(q, serverNow)}
    </div>
    <h2 class="quiz-prompt" data-testid="quiz-prompt">${esc(q.prompt)}</h2>`}
    <div class="quiz-options${selectable ? '' : ' is-show'}">
      ${q.options.map((o, i) => `${selectable ? `<button type="button" class="quiz-opt${chosen === i ? ' is-chosen' : ''}" data-action="quiz-pick" data-choice="${i}" data-testid="quiz-option-${i}" ${open ? '' : 'disabled'} aria-pressed="${chosen === i}">` : `<div class="quiz-opt" data-testid="quiz-show-option-${i}">`}
        <span class="quiz-letter" aria-hidden="true">${LETTER[i]}</span><span class="quiz-text">${esc(o)}</span>${selectable ? '</button>' : '</div>'}`).join('')}
    </div>
    ${own ? '' : `<p class="quiz-answered muted" data-testid="quiz-answered" data-done="${q.answered}" data-total="${q.playing}">${q.answered} van ${q.playing} ${q.playing === 1 ? 'heeft' : 'hebben'} geantwoord</p>`}
    ${state}
  </section>`;
}

/** Who climbed this question (only the climbers: the screen stays calm). */
function riseHtml(r) {
  if (r.prevRank == null || r.prevRank <= r.rank) return '';
  return `<small class="quiz-rise is-up" data-testid="quiz-rise" title="${r.prevRank - r.rank} ${r.prevRank - r.rank === 1 ? 'plek' : 'plekken'} gestegen">▲ ${r.prevRank - r.rank}</small>`;
}

/** Ranking with shared places ("2." twice when equal). */
export function quizRankingHtml(view, { limit = Infinity, testid = 'quiz-ranking', points = true } = {}) {
  const list = (view.game.quiz.ranking || []).slice(0, limit);
  const me = view.you?.id;
  return `<ol class="quiz-rank" data-testid="${testid}">
    ${list.map((r) => `<li class="${r.id === me ? 'is-you' : ''}" data-name="${esc(r.name)}" data-rank="${r.rank}" data-score="${r.score}">
      <span class="quiz-rank-place">${r.rank}.</span>${avatarHtml(r, { cls: 'qr-av' })}<span class="quiz-rank-name">${esc(r.name)}${r.id === me ? ' <small>(jij)</small>' : ''}</span>
      ${riseHtml(r)}${points && r.points ? `<small class="quiz-rank-plus">+${r.points}</small>` : ''}<b>${r.score}</b></li>`).join('')}
  </ol>`;
}

/** After a question: the right answer, how many chose what, the own result (on a phone that plays). */
export function quizRevealHtml(view, { host = false, onlyMine = false } = {}) {
  const g = view.game;
  const q = g.quiz;
  const rv = q.reveal;
  if (!rv) return '';
  const max = Math.max(1, ...rv.counts);
  const mine = rv.mine;
  let own = '';
  if (mine) {
    const cls = mine.none ? 'is-none' : mine.correct ? 'is-good' : 'is-bad';
    const text = mine.none ? 'Geen antwoord: 0 punten' : mine.correct ? `Goed! +${mine.points} punten` : 'Helaas, fout: 0 punten';
    own = `<div class="result room-result ${cls}" data-testid="quiz-my-result" data-correct="${mine.none ? 'none' : mine.correct}" data-points="${mine.points}">
      ${mine.correct ? `<span class="result-icon">${icons.check}</span>` : !mine.none ? `<span class="result-icon">${icons.cross}</span>` : ''}<span class="result-text">${esc(text)}</span></div>
      <p class="result-explain" data-testid="quiz-my-rank" data-rank="${mine.rank}">Je staat <b>${mine.rank}e</b>${mine.prevRank && mine.prevRank > mine.rank ? ` (was ${mine.prevRank}e)` : ''} met ${plural(g.mine?.score ?? 0, 'punt', 'punten')}.</p>`;
  }
  if (onlyMine) return own;
  return `${own}
    <section class="quiz-reveal" data-testid="quiz-reveal">
      <p class="quiz-num">Vraag ${g.round} van ${q.total} · ${esc(q.prompt)}</p>
      <p class="quiz-correct" data-testid="quiz-correct" data-answer="${rv.answer}"><span class="quiz-letter">${LETTER[rv.answer]}</span><b>${esc(q.options[rv.answer])}</b></p>
      ${g.reveal?.song ? `<p class="quiz-song" data-testid="quiz-song">${esc(g.reveal.song.artist)} · ${esc(g.reveal.song.title)} · ${esc(g.reveal.song.year)}</p>` : ''}
      ${g.reveal?.song?.by?.length ? `<p class="mix-by" data-testid="room-song-by">Uit de favorieten van <b>${g.reveal.song.by.map(esc).join(' &amp; ')}</b></p>` : ''}
      <ul class="quiz-dist" aria-label="Zoveel spelers kozen elk antwoord">
        ${q.options.map((o, i) => `<li class="${i === rv.answer ? 'is-right' : ''}${mine && mine.choice === i ? ' is-mine' : ''}" data-testid="quiz-count-${i}" data-count="${rv.counts[i]}">
          <span class="quiz-letter">${LETTER[i]}</span><span class="quiz-dist-text">${esc(o)}</span>
          <span class="quiz-dist-bar" aria-hidden="true"><i style="width:${Math.round((rv.counts[i] / max) * 100)}%"></i></span><b>${rv.counts[i]}</b></li>`).join('')}
      </ul>
    </section>
    <h2 class="room-h">Tussenstand</h2>
    ${quizRankingHtml(view, { limit: host ? 6 : Infinity })}`;
}

/** The end: podium for the top three (shared places together) and the whole ranking. */
export function quizPodiumHtml(view) {
  const list = view.game.quiz.ranking || [];
  const me = list.find((r) => r.id === view.you?.id);
  const steps = [2, 1, 3].map((place) => {
    const who = list.filter((r) => r.rank === place);
    return `<div class="podium-step is-p${place}" data-testid="quiz-podium-${place}" data-names="${esc(who.map((r) => r.name).join('|'))}">
      <span class="podium-names">${who.length ? who.map((r) => `${avatarHtml(r, { cls: 'podium-av' })}<b>${esc(r.name)}</b><small>${r.score}</small>`).join('') : '<small>—</small>'}</span>
      <span class="podium-block">${place}</span></div>`;
  }).join('');
  const w = view.game.winners;
  return `<div class="winner quiz-end" data-testid="quiz-end">
      <span class="winner-trophy">${icons.trophy}</span>
      <h2 class="winner-name" data-testid="room-winner-name">${w.length === 1 ? `${esc(w[0])} wint de quiz!` : `Gedeelde winst: ${w.map(esc).join(' & ')}`}</h2>
      ${me ? `<p class="room-you-won" data-testid="quiz-my-place" data-rank="${me.rank}">Jij bent ${me.rank}e met ${plural(me.score, 'punt', 'punten')}.</p>` : ''}
    </div>
    <div class="podium" data-testid="quiz-podium">${steps}</div>
    <h2 class="room-h">Eindstand</h2>
    ${quizRankingHtml(view, { testid: 'quiz-final-ranking', points: false })}`;
}
