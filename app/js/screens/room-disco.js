// "Samen spelen", Discobingo: everything people see and touch of the fourth room game.
// Used by room-host.js (the spelleider's screen, also on a laptop / tv) and room-player.js
// (the phones). Everything works on a view from multi/protocol.js (viewFor); the rules live
// in multi/disco.js and game.js, the 3D ball in discoball.js.
import { CATEGORIES, categoryOf, CENTER, WIN_LABELS, DISCO_MIN_SONGS } from '../multi/disco.js';
import { parseYearGuess } from '../bingo.js';
import { createDiscoBall } from '../discoball.js';
import { icons, esc } from '../ui.js';
import { avatarHtml, resultMarks, streakMark, jokerMark } from './party-ui.js';

// disco.js is the single source of truth for the colours: mirror them as CSS variables
// (disco.css carries the same values as a fallback for the first paint).
if (typeof document !== 'undefined') {
  for (const c of CATEGORIES) document.documentElement.style.setProperty(c.cssVar, c.color);
}

/* ---------- the four figures (own drawings: a filled mass plus 2.2 strokes on a 24 grid) ---------- */
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const FIGURES = {
  // a target with a dart in the bull's eye: exactly right (Jaartal ±2 is the hourglass)
  exact: `<circle cx="10.6" cy="13.4" r="7.9" ${S}/><circle cx="10.6" cy="13.4" r="3.9" ${S}/><circle cx="10.6" cy="13.4" r="1.5" fill="currentColor"/><path d="M11.4 12.6l8-8" ${S}/><path d="M16.2 3.4l3.4.9.9 3.4-2.1.2-.2-2.2-2.2-.2z" fill="currentColor"/>`,
  // microphone on a stand
  artist: `<rect x="8.6" y="2.6" width="6.8" height="11.6" rx="3.4" fill="currentColor"/><path d="M5.4 10.8a6.6 6.6 0 0 0 13.2 0M12 17.4v3.6M8.4 21h7.2" ${S}/>`,
  // hourglass with sand running down
  year: `<path d="M6 3.2h12M6 20.8h12M7.4 3.2c0 4.6 4.6 5.6 4.6 8.8s-4.6 4.2-4.6 8.8M16.6 3.2c0 4.6-4.6 5.6-4.6 8.8s4.6 4.2 4.6 8.8" ${S}/><path d="M9 6.6h6c-.7 1.5-3 2.3-3 3.8 0-1.5-2.3-2.3-3-3.8zM8.9 19.2c.4-2.2 3.1-3 3.1-4.6 0 1.6 2.7 2.4 3.1 4.6z" fill="currentColor"/>`,
  // one eighth note
  title: `<path d="M10.6 17.4V3.6" ${S} stroke-width="2.4"/><path d="M10.6 3.2l7.6 2.6v4.2l-7.6-2.6z" fill="currentColor"/><ellipse cx="7.4" cy="17.6" rx="3.6" ry="2.9" transform="rotate(-20 7.4 17.6)" fill="currentColor"/>`,
  free: '<path d="M12 2.6l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8l-5.8 3.3 1.4-6.4-4.9-4.4 6.5-.7z" fill="currentColor"/>',
};

/** Inline SVG figure of a category ('free' = the star in the centre). */
export function catIcon(key, cls = '') {
  return `<svg class="cat-ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${FIGURES[key] || FIGURES.free}</svg>`;
}

/** What to do for a category, in one line. */
export const INSTRUCTION = {
  exact: 'Typ het jaartal: precies goed',
  artist: 'Typ de artiest of band',
  year: 'Typ het jaartal: 2 jaar ernaast mag',
  title: 'Typ de titel van het nummer',
};
/** The one question per category (the two year categories say plainly how exact it must be). */
export const QUESTION = {
  exact: 'In welk jaar kwam dit uit? Precies goed!',
  artist: 'Wie zingt of speelt dit?',
  year: 'Uit welk jaar? 2 jaar ernaast mag',
  title: 'Hoe heet dit nummer?',
};
/** The hint under the question. */
export const HINT = { exact: 'Precies het jaar: geen marge', year: '2 jaar ernaast mag', artist: 'Kleine typefouten mogen', title: 'Kleine typefouten mogen' };
const yearCat = (cat) => cat === 'year' || cat === 'exact';
const catName = (key) => categoryOf(key)?.label || '';
const catShort = (key) => categoryOf(key)?.short || '';

/** A small coloured tag: figure + name (colour is never the only cue). */
export function catChip(key, { short = false, testid = '' } = {}) {
  return `<span class="cat-chip cat-${esc(key)}"${testid ? ` data-testid="${testid}"` : ''} data-cat="${esc(key)}">${catIcon(key)}<span>${esc(short ? catShort(key) : catName(key))}</span></span>`;
}

/** The legend of the four categories (lobby, rules). */
export function legendHtml(testid = 'room-disco-legend') {
  return `<ul class="disco-legend" data-testid="${testid}" aria-label="De vier categorieën">
    ${CATEGORIES.map((c) => `<li class="cat-${c.key}" data-cat="${c.key}"><span class="disco-legend-tile">${catIcon(c.key)}</span><span>${esc(c.label)}</span></li>`).join('')}
  </ul>`;
}

export const winText = (win) => (win === 'full' ? 'een volle kaart' : win === 'line2' ? '2 lijnen' : '1 lijn');
/** "1 lijn", "2 lijnen", "Volle kaart" (labels of the stages). */
export const winLabel = (win) => WIN_LABELS[win] || WIN_LABELS.line1;
/** "Anouk", "Anouk en Bram", "Anouk, Bram en Cas". */
export const namesText = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`);

/* ---------- lobby ---------- */

/** "Eerste bingo bij", the automatic reveal, the explanation and the legend; `need` = songs still missing (own music). */
export function discoLobbyHtml(settings, { have = 0, mix = false } = {}) {
  const missing = Math.max(0, DISCO_MIN_SONGS - have);
  return `<div class="room-sub room-disco-settings" data-testid="room-disco-settings">
    <p class="disco-explain" data-testid="room-disco-explain">Een discobal kiest per nummer de vraag. Goed? Dan stempel je zelf een vakje van die kleur af op je 5×5-kaart.</p>
    ${legendHtml()}
    <p class="room-label">Eerste bingo bij</p>
    <div class="seg room-seg" role="radiogroup" aria-label="Eerste bingo bij">${Object.keys(WIN_LABELS).map((w) => `<label class="seg-opt"><input type="radio" name="win" value="${w}" ${settings.win === w ? 'checked' : ''} data-testid="room-disco-win-${w}"><span>${esc(WIN_LABELS[w])}</span></label>`).join('')}</div>
    <p class="muted small">Een lijn is een rij, kolom of diagonaal; de ster in het midden telt mee. Bij een bingo stopt het spel; jij kiest dan: doorgaan voor 2 lijnen of een volle kaart, of stoppen.</p>
    <label class="check-row room-disco-auto"><input type="checkbox" name="autoReveal" ${settings.autoReveal !== false ? 'checked' : ''} data-testid="room-disco-auto"><span>Automatisch naar het resultaat als iedereen geantwoord heeft <small class="muted">(na 4 seconden)</small></span></label>
    ${!mix && missing ? `<p class="warn small" data-testid="room-disco-need" data-missing="${missing}">Voor Discobingo zijn minstens ${DISCO_MIN_SONGS} nummers nodig: nog ${missing} (${have} van ${DISCO_MIN_SONGS}). Kies een grotere playlist of de Mix van de groep.</p>` : ''}
  </div>`;
}

/* ---------- the disco ball with the category banner ---------- */

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function bannerHtml(key) {
  if (!key) {
    return `<div class="disco-banner-in is-spinning"><p class="disco-banner-kicker">De discobal draait…</p><p class="disco-banner-name">Welke vraag wordt het?</p></div>`;
  }
  return `<div class="disco-banner-in cat-${esc(key)}">
    <span class="disco-banner-ico">${catIcon(key)}</span>
    <span class="disco-banner-text"><span class="disco-banner-name">${esc(catName(key))}</span><span class="disco-banner-how">${esc(INSTRUCTION[key] || '')}</span></span>
  </div>`;
}

/**
 * The ball and the banner in `el` (an element no region patch touches, so the canvas lives on).
 * sync() spins once per round: towards the landing time spunAt + spinMs (server clock), so
 * every screen lands together; a round that is already under way (reload, a late screen)
 * shows the landed ball at once. A mere re-render never spins again. `onLand` fires when
 * the ball has landed (the screens then show the question and start the music).
 */
export function createDiscoStage(el, { big = false, onLand = null } = {}) {
  el.innerHTML = `<div class="disco-stage${big ? ' is-big' : ''}" data-testid="disco-stage" data-state="idle">
    <div class="disco-ball-box" data-testid="disco-ball"></div>
    <div class="disco-banner" data-testid="disco-category" data-cat="" aria-live="polite">${bannerHtml(null)}</div>
  </div>`;
  const root = el.firstElementChild;
  const banner = root.querySelector('.disco-banner');
  const ball = createDiscoBall(root.querySelector('.disco-ball-box'), { categories: CATEGORIES, size: 'auto', turnWhenLanded: big });
  let doneFor = null;
  let landed = false;
  let timers = [];
  const clear = () => { for (const t of timers) clearTimeout(t); timers = []; };
  function setLanded(key, { quiet = false } = {}) {
    if (landed) return;
    landed = true;
    clear();
    root.dataset.state = 'landed';
    root.dataset.cat = key;
    banner.dataset.cat = key;
    banner.innerHTML = bannerHtml(key);
    // quiet = shown at once inside sync(): the caller is drawing already, no callback
    if (!quiet) { root.classList.add('just-landed'); onLand?.(key); }
  }
  return {
    get landed() { return landed; },
    get ball() { return ball; },
    /** d = view.game.disco, now = server time, phase = room phase. */
    sync(d, { now, phase, round }) {
      if (!d?.cat) return;
      const key = `${round}:${d.cat}`;
      root.dataset.phase = phase;
      // revealed while the ball still spun (an early Onthul): it lands at once
      if (key === doneFor && phase !== 'answering' && !landed) { clear(); ball.show(d.cat); setLanded(d.cat, { quiet: true }); return; }
      if (key === doneFor) return;
      doneFor = key;
      landed = false;
      clear();
      root.classList.remove('just-landed');
      root.dataset.round = String(round);
      root.dataset.phase = phase;
      // clamped: a wrong clock offset or a spunAt in the future must never hide the question for long
      const spinMs = d.spinMs || 4000;
      const left = phase === 'answering' && Number.isFinite(d.spunAt) ? Math.min(spinMs, Math.max(0, d.spunAt + spinMs - now)) : 0;
      if (left < 900) { ball.show(d.cat); setLanded(d.cat, { quiet: true }); return; }
      root.dataset.state = 'spinning';
      root.dataset.cat = '';
      banner.dataset.cat = '';
      banner.innerHTML = bannerHtml(null);
      const go = () => ball.spinTo(d.cat, { duration: left }).then((ok) => { if (ok && doneFor === key) setLanded(d.cat); }).catch(() => setLanded(d.cat));
      // reduced motion: the ball only fades (600 ms), timed to end when the others land
      if (reducedMotion()) { ball.idle(); timers.push(setTimeout(go, Math.max(0, left - 600))); } else go();
      timers.push(setTimeout(() => { if (doneFor === key) { ball.show(d.cat); setLanded(d.cat); } }, left + 700)); // safety net
    },
    destroy() { clear(); ball.destroy(); el.innerHTML = ''; },
  };
}

/** Has the ball of the running round landed (by the server clock)? */
export function discoLandedAt(d) {
  return Number.isFinite(d?.spunAt) ? d.spunAt + (d.spinMs || 4000) : 0;
}

/* ---------- the 5×5 card ---------- */

/**
 * A card from `mine` (view.game.mine). mode 'choose': the `choosable` squares are buttons
 * (tap = stamp, tap another = move), the rest is dimmed; `choice` = this round's stamp.
 */
export function discoCardHtml(mine, { mode = 'show', choosable = [], choice = null, cat = null, testid = 'disco-card', name = '', joker = [], jokerChips = [] } = {}) {
  const goal = new Set(mine.goalCells || []);
  const can = new Set(choosable);
  // with the joker switched on: open squares of another colour are buttons too (a distinct look)
  const jok = new Set(mode === 'choose' ? joker : []);
  const starred = new Set(jokerChips);
  const cells = mine.card.map((key, i) => {
    const mark = mine.marks[i];
    const stamped = mark != null;
    const free = i === CENTER;
    const year = stamped && mark !== '*' ? String(mark) : '';
    const chosen = choice === i;
    const isJoker = jok.has(i) && !can.has(i);
    const isBtn = mode === 'choose' && (can.has(i) || isJoker || chosen);
    const dim = mode === 'choose' && !isBtn && !free && (stamped ? false : key !== cat || !can.size);
    const star = stamped && !free && starred.has(i);
    // while answering: the open squares the round's category could stamp
    const now = mode === 'show' && cat && key === cat && !stamped;
    const cls = ['dq', `cat-${key}`, stamped ? 'is-stamped' : 'is-open', goal.has(i) ? 'is-goal' : '', can.has(i) ? 'is-choosable' : '', chosen ? 'is-chosen' : '', dim ? 'is-dim' : '', free ? 'is-free' : '', now ? 'is-now' : '', isJoker ? 'is-joker' : '', star ? 'is-joker-chip' : ''].filter(Boolean).join(' ');
    const label = free ? 'Vrij vakje (ster)' : `${catName(key)}${stamped ? `, afgestempeld${star ? ' met je joker' : ''}` : can.has(i) ? ', tik om af te stempelen' : isJoker ? ', tik om hier je joker in te zetten' : ''}`;
    // a stamped square carries a plain round game chip: no year, no number (data-year stays for tests)
    const inner = `<span class="dq-ico">${catIcon(key)}</span>${stamped && !free ? `<span class="dq-stamp dq-chip${star ? ' is-joker' : ''}" aria-hidden="true"${star ? ' data-testid="disco-joker-chip"' : ''}></span>` : ''}${isJoker ? '<span class="dq-joker" aria-hidden="true">★</span>' : ''}`;
    const attrs = `class="${cls}" data-testid="disco-sq-${i}" data-index="${i}" data-cat="${esc(key)}" data-stamped="${stamped}" data-year="${esc(year)}" data-choosable="${can.has(i)}" data-chosen="${chosen}" data-goal="${goal.has(i)}" data-joker="${isJoker}"${star ? ' data-joker-chip="true"' : ''}`;
    return isBtn
      ? `<button type="button" ${attrs} data-action="disco-stamp" aria-pressed="${chosen}" aria-label="${esc(label)}">${inner}</button>`
      : `<div ${attrs} role="img" aria-label="${esc(label)}">${inner}</div>`;
  }).join('');
  return `<div class="disco-card${mode === 'choose' ? ' is-choosing' : ''}${mine.bingo ? ' is-bingo' : ''}" data-testid="${testid}" data-mode="${mode}" data-stamped="${mine.stamped}" data-lines="${mine.lines}" data-bingo="${!!mine.bingo}" aria-label="Kaart${name ? ` van ${esc(name)}` : ''}">${cells}</div>`;
}

/** "3 lijnen · 9 vakjes" under a card. */
export function cardStatsHtml(mine, win) {
  return `<p class="disco-card-stats muted small" data-testid="disco-card-stats">${mine.stamped} afgestempeld · ${mine.lines} ${mine.lines === 1 ? 'lijn' : 'lijnen'} vol${mine.bingo ? '' : ` (doel: ${esc(winText(win))})`}</p>`;
}

/* ---------- answering ---------- */

/** Literal text of an answer ({guess} | {text} | {pass}). */
export function answerWords(a) {
  if (!a) return '';
  if (a.pass) return 'Weet ik niet';
  if (a.guess != null) return String(a.guess);
  if (a.text != null) return `“${a.text}”`;
  return '';
}

/** Typed text the way the server cleans it (game.js cleanText): no control characters, single spaces. */
const cleanTyped = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

export function proposedAnswer(cat, value) {
  const v = String(value ?? '');
  if (yearCat(cat)) { const g = parseYearGuess(v); return g == null ? null : { guess: g }; }
  if (cat === 'artist' || cat === 'title') { const t = cleanTyped(v); return t ? { text: t } : null; }
  return null;
}
export const sameAnswer = (a, b) => !!a && !!b && !a.pass && !b.pass && (a.guess != null ? Number(a.guess) === Number(b.guess) : a.text != null && cleanTyped(b.text) === cleanTyped(a.text));

/**
 * The answer form of the round's category. `local` = { value } (what is typed, null = take
 * the sent answer). data-state on [data-testid=disco-answer-state]: none | changed | locked | pass.
 */
export function discoAnswerHtml(view, local, { sending = false } = {}) {
  const g = view.game;
  if (!g?.mine) return '<p class="muted" data-testid="answer-none">Je doet vanaf de volgende ronde mee.</p>';
  const d = g.disco;
  const cat = d.cat;
  const sent = g.answer || null;
  const typed = yearCat(cat) || cat === 'artist' || cat === 'title';
  const value = local.value != null ? local.value : sent && !sent.pass ? (yearCat(cat) ? String(sent.guess ?? '') : sent.text ?? '') : '';
  const proposed = typed ? proposedAnswer(cat, value) : null;
  const changed = !!proposed && !sameAnswer(proposed, sent);
  const state = sent?.pass && !changed ? 'pass' : sent && !changed ? 'locked' : changed ? 'changed' : 'none';
  const stateText = state === 'locked' ? `<b>Vastgezet:</b> ${esc(answerWords(sent))}. <span class="muted">Wijzigen kan tot de onthulling.</span>`
    : state === 'pass' ? '<b>Je weet het niet.</b> <span class="muted">Toch een idee? Je kunt antwoorden tot de onthulling.</span>'
      : state === 'changed' && sent && !sent.pass ? `Nog vastgezet: ${esc(answerWords(sent))}. <span class="muted">Tik op <em>Wijzig mijn antwoord</em> om dit te vervangen.</span>`
        : esc(INSTRUCTION[cat] || '');
  let body = '';
  if (yearCat(cat)) {
    body = `<div class="disco-field"><label for="disco-year">${esc(QUESTION[cat])}</label>
      <input id="disco-year" class="disco-year-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="bv. 1987" value="${esc(value)}" data-testid="disco-year-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
      <small class="muted" data-testid="disco-hint">${esc(HINT[cat])}.</small></div>`;
  } else {
    body = `<div class="disco-field"><label for="disco-text">${cat === 'artist' ? 'Wie zingt of speelt dit?' : 'Hoe heet dit nummer?'}</label>
      <input id="disco-text" type="text" maxlength="60" placeholder="${cat === 'artist' ? 'Typ de artiest of band' : 'Typ de titel'}" value="${esc(value)}" data-testid="disco-text-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
      <small class="muted" data-testid="disco-hint">Kleine typefouten zijn niet erg. Twijfelgeval? Dan beslist de spelleider.</small></div>`;
  }
  const lockLabel = sending ? 'Versturen…' : state === 'locked' ? 'Vastgezet' : !proposed ? (yearCat(cat) ? 'Vul een jaartal in' : 'Typ je antwoord') : sent && !sent.pass ? 'Wijzig mijn antwoord' : 'Zet vast';
  return `<div class="ra disco-answer cat-${esc(cat)}" data-testid="disco-answer" data-cat="${esc(cat)}">
    <p class="ra-state" data-testid="disco-answer-state" data-state="${state}">${state === 'locked' ? icons.check : ''}<span>${stateText}</span></p>
    ${body}
    <div class="ra-actions">
      ${typed ? `<button class="btn btn-primary btn-xl" type="button" data-action="disco-lock" data-testid="disco-lock" ${proposed && changed && !sending ? '' : 'disabled'}>${icons.check}<span>${lockLabel}</span></button>` : ''}
      <button class="btn btn-ghost btn-small" type="button" data-action="disco-pass" data-testid="disco-pass" ${sent?.pass || sending ? 'disabled' : ''}>Weet ik niet</button>
    </div>
  </div>`;
}

/**
 * Taps and typing in the answer form (both screens). getView(): the own view; send(answer);
 * refresh(): redraw. Returns { local, sync(), key(), onClick(e) -> handled?, onInput(e), onKeyDown(e) }.
 */
export function discoController({ getView, send, refresh, sending = () => false }) {
  let local = { value: null };
  let round = null;
  const ctl = {
    get local() { return local; },
    sync() {
      const v = getView();
      const r = v?.game?.kind === 'disco' && v.phase === 'answering' ? v.game.round : null;
      if (r !== round) { round = r; local = { value: null }; }
    },
    key() {
      const v = getView();
      const g = v?.game;
      return JSON.stringify([v?.phase, g?.round, g?.disco?.cat, g?.answer, !!g?.mine, g?.mine?.marks]);
    },
    onClick(e) {
      const a = e.target.closest('[data-action]');
      if (!a) return false;
      const v = getView();
      if (v?.game?.kind !== 'disco' || v.phase !== 'answering' || !v.game.mine) return false;
      const act = a.dataset.action;
      if (act === 'disco-pass') { local = { value: null }; send({ pass: true }); return true; }
      if (act === 'disco-lock') {
        const ans = proposedAnswer(v.game.disco.cat, local.value ?? '');
        if (ans) send(ans);
        return true;
      }
      return false;
    },
    onInput(e) {
      const t = e.target;
      if (t.matches('[data-testid="disco-year-input"]')) {
        const clean = t.value.replace(/\D/g, '').slice(0, 4);
        if (clean !== t.value) t.value = clean;
        local = { value: clean };
      } else if (t.matches('[data-testid="disco-text-input"]')) {
        local = { value: t.value };
      } else return;
      // only the button and the state line change: a re-render would close the phone's keyboard
      const v = getView();
      const panel = t.closest('[data-testid="disco-answer"]');
      if (!panel || !v) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = discoAnswerHtml(v, local, { sending: sending() });
      for (const id of ['disco-lock', 'disco-answer-state']) {
        const fresh = tmp.querySelector(`[data-testid="${id}"]`);
        const cur = panel.querySelector(`[data-testid="${id}"]`);
        if (fresh && cur) cur.replaceWith(fresh);
      }
    },
    onKeyDown(e) {
      if (e.key === 'Enter' && e.target.matches('[data-testid="disco-year-input"], [data-testid="disco-text-input"]')) {
        e.preventDefault();
        e.target.closest('[data-testid="disco-answer"]')?.querySelector('[data-testid="disco-lock"]')?.click();
      }
    },
    refresh,
  };
  return ctl;
}

/** Before the ball has landed: what the phone shows instead of the question. */
export function spinWaitHtml() {
  return `<div class="listen-hint disco-wait" data-testid="disco-wait">${icons.music}<span>De discobal kiest de vraag. Zo meteen begint de muziek.</span></div>`;
}

/* ---------- after the reveal ---------- */

const VERDICT = {
  right: { word: 'Goed', icon: () => icons.check },
  wrong: { word: 'Fout', icon: () => icons.cross },
  doubt: { word: 'Twijfel', icon: () => '?' },
};

/** Literal answer of a result entry (reveal.results[]). */
export function resultWords(r) {
  if (r.none) return 'geen antwoord';
  if (r.pass) return 'weet ik niet';
  if (r.guess != null) return String(r.guess);
  if (r.text != null) return `“${r.text}”`;
  return r.label || '';
}
export const verdictOf = (r) => (r.none ? 'none' : r.pass ? 'pass' : r.verdict || (r.correct ? 'right' : 'wrong'));

/** Own outcome on a phone: the verdict, then what to do with the card. */
export function discoMyResultHtml(view) {
  const g = view.game;
  const r = g.reveal?.mine;
  if (!r || !g.mine) return '';
  const d = g.disco;
  const v = d.waitingForHost ? 'doubt' : verdictOf(r);
  const text = { none: 'Je hebt niet geantwoord', pass: 'Je wist het niet', doubt: 'De spelleider kijkt naar je antwoord…', right: 'Goed!', wrong: 'Helaas, fout' }[v];
  const cls = v === 'right' ? 'is-good' : v === 'wrong' ? 'is-bad' : v === 'doubt' ? 'is-doubt' : 'is-none';
  let explain = '';
  if (!r.none && !r.pass) {
    explain = `Jij zei ${esc(resultWords(r))}.`;
    if (r.decided && r.auto === 'doubt' && v !== 'doubt') explain += ` De spelleider keurde het ${v === 'right' ? 'goed' : 'af'}.`;
    else if (r.overridden) explain += ' De spelleider heeft het oordeel omgedraaid.';
    else if (v === 'doubt') explain += ' Bijna goed, of net niet? Dat beslist de spelleider zo.';
  }
  const icon = v === 'right' ? icons.check : v === 'wrong' ? icons.cross : '';
  return `<div class="result room-result disco-verdict ${cls}" data-testid="disco-verdict" data-verdict="${v}">
    ${icon ? `<span class="result-icon">${icon}</span>` : v === 'doubt' ? '<span class="result-icon disco-doubt-ico" aria-hidden="true">?</span>' : ''}<span class="result-text">${esc(text)}</span>
  </div>${explain ? `<p class="result-explain" data-testid="disco-verdict-explain">${explain}</p>` : ''}
  ${chooseHtml(view)}`;
}

/** "Kies een Titel vakje", "geen open vakje van deze kleur", BINGO! */
function chooseHtml(view) {
  const g = view.game;
  const d = g.disco;
  const r = g.reveal?.mine;
  if (!r?.correct || d.waitingForHost) return '';
  const cat = d.cat;
  if (isWinner(view)) {
    return `<p class="disco-bingo" data-testid="disco-bingo" role="status">BINGO!</p>
      <p class="disco-choose" data-testid="disco-choose" data-state="bingo">Je hebt ${esc(winText(d.win))}. Je fiche ligt vast; het spel staat stil tot de spelleider kiest.</p>`;
  }
  if (d.noSquare) return `<p class="disco-choose is-none" data-testid="disco-choose" data-state="nosquare">${catChip(cat)} <span>Geen open vakje van deze kleur meer: je hoeft niets af te stempelen.</span></p>`;
  if (d.choice == null) return `<p class="disco-choose is-todo" data-testid="disco-choose" data-state="choose"><span>Kies zelf een</span> ${catChip(cat)} <span>vakje op je kaart</span></p>`;
  return `<p class="disco-choose is-done" data-testid="disco-choose" data-state="chosen">${icons.check}<span>Fiche gelegd. Liever een ander ${esc(catShort(cat).toLowerCase())}-vakje? Tik erop.</span></p>`;
}

/** Is the viewer one of the winners of the running bingo stop? */
export const isWinner = (view) => !!view.you && !!(view.game?.disco?.bingo?.winners || []).some((w) => w.id === view.you.id);

/* ---------- chips after the reveal: who has laid one ---------- */

const CHIP_WORD = { placed: 'fiche gelegd ✓', choosing: 'kiest nog…', away: 'weg: wordt automatisch gelegd', doubt: 'spelleider beslist' };

/**
 * Who may still lay a chip, from view.game.disco.chips: { total, waiting (names of online
 * players still choosing), away, doubts, all (nobody online left to wait for) }.
 */
export function chipSummary(d) {
  const chips = d?.chips || [];
  const waiting = chips.filter((c) => c.state === 'choosing').map((c) => c.name);
  const away = chips.filter((c) => c.state === 'away').map((c) => c.name);
  const doubts = chips.filter((c) => c.state === 'doubt').length;
  return { total: chips.length, waiting, away, doubts, all: waiting.length === 0 && doubts === 0 };
}

/** The summary line: green "Iedereen heeft een fiche gelegd" or "2 van 5 kiezen nog". */
export function chipSummaryHtml(d, { testid = 'disco-chips-summary' } = {}) {
  const s = chipSummary(d);
  if (!s.total) return `<p class="disco-chips-sum is-none" data-testid="${testid}" data-waiting="0" data-total="0">Niemand hoeft deze ronde een fiche te leggen.</p>`;
  const text = s.waiting.length
    ? `${s.waiting.length} van ${s.total} ${s.waiting.length === 1 ? 'kiest' : 'kiezen'} nog`
    : s.doubts ? (s.doubts === 1 ? 'Nog één twijfelgeval' : `Nog ${s.doubts} twijfelgevallen`) : 'Iedereen heeft een fiche gelegd';
  const extra = s.away.length && !s.waiting.length ? ` <small>(${esc(namesText(s.away))} ${s.away.length === 1 ? 'is' : 'zijn'} weg: automatisch)</small>` : '';
  return `<p class="disco-chips-sum${s.all ? ' is-all' : ' is-wait'}" data-testid="${testid}" data-waiting="${s.waiting.length}" data-total="${s.total}" role="status">${s.all ? icons.check : '<span class="disco-chips-dot" aria-hidden="true"></span>'}<span>${esc(text)}${extra}</span></p>`;
}

/** For the leader: everybody who lays a chip this round with their state, and the summary. */
export function chipsHtml(view, { testid = 'disco-chips' } = {}) {
  const d = view.game.disco;
  const chips = d.chips || [];
  if (!chips.length) return '';
  return `<section class="disco-chips" data-testid="${testid}" aria-label="Fiches">
    ${chipSummaryHtml(d)}
    <ul class="disco-chips-list">${chips.map((c) => `<li class="dc is-${esc(c.state)}" data-testid="disco-chip-row" data-name="${esc(c.name)}" data-state="${esc(c.state)}">
      ${avatarHtml(c, { cls: 'dc-av' })}<span class="dc-name">${esc(c.name)}</span><span class="dc-state">${esc(CHIP_WORD[c.state] || '')}</span>
    </li>`).join('')}</ul>
  </section>`;
}

/**
 * The confirmation before going on while online players still choose (an in-app dialog,
 * keyboard friendly: focus on "Wacht nog", Escape = Wacht nog, Tab stays inside).
 * Resolves true for "Toch doorgaan".
 */
export function confirmGoOn(names, { host = document.body } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'disco-confirm-wrap';
    wrap.innerHTML = `<div class="disco-confirm" role="alertdialog" aria-modal="true" aria-labelledby="disco-confirm-t" aria-describedby="disco-confirm-d" data-testid="disco-confirm">
      <h2 id="disco-confirm-t" class="disco-confirm-h">Nog niet iedereen heeft een fiche gelegd</h2>
      <p id="disco-confirm-d" data-testid="disco-confirm-text">${esc(namesText(names))} ${names.length === 1 ? 'heeft' : 'hebben'} nog geen fiche gelegd. Toch doorgaan? ${names.length === 1 ? 'Die wordt' : 'Hun fiche wordt'} dan automatisch gelegd.</p>
      <div class="disco-confirm-actions">
        <button type="button" class="btn btn-primary" data-testid="disco-confirm-wait">Wacht nog</button>
        <button type="button" class="btn btn-ghost" data-testid="disco-confirm-go">Toch doorgaan</button>
      </div>
    </div>`;
    const done = (ok) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      try { prev?.focus?.({ preventScroll: true }); } catch { /* gone */ }
      resolve(ok);
    };
    const btns = () => [...wrap.querySelectorAll('button')];
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
      if (e.key === 'Tab') {
        const [a, b] = btns();
        e.preventDefault();
        (document.activeElement === a ? b : a).focus();
      }
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) { done(false); return; }
      const t = e.target.closest('button');
      if (t) done(t.dataset.testid === 'disco-confirm-go');
    });
    document.addEventListener('keydown', onKey, true);
    host.appendChild(wrap);
    btns()[0].focus();
  });
}

/* ---------- the automatic reveal: a subtle shared countdown ---------- */

/** "Resultaat over 4…" with a thin bar, timed by the server's autoAt (tickAutoTimers keeps it running). */
export function autoTimerHtml(d, now, { testid = 'disco-auto' } = {}) {
  if (!Number.isFinite(d?.autoAt)) return '';
  const ms = d.autoMs || 4000;
  const left = Math.max(0, d.autoAt - now);
  return `<div class="disco-auto" data-testid="${testid}" data-auto-at="${d.autoAt}" data-auto-ms="${ms}" role="timer" aria-live="off">
    <span class="disco-auto-bar" aria-hidden="true"><i style="transform:scaleX(${(left / ms).toFixed(3)})"></i></span>
    <span class="disco-auto-text">${autoText(left)}</span>
  </div>`;
}
const autoText = (left) => (left > 0 ? `Resultaat over <b>${Math.min(9, Math.ceil(left / 1000))}</b>…` : 'Resultaat…');

/** Move every countdown in `root` on to `now` (server time). */
export function tickAutoTimers(root, now) {
  for (const el of root.querySelectorAll('[data-auto-at]')) {
    const at = Number(el.dataset.autoAt);
    const ms = Number(el.dataset.autoMs) || 4000;
    const left = Math.max(0, at - now);
    const bar = el.querySelector('.disco-auto-bar i');
    if (bar) bar.style.transform = `scaleX(${(left / ms).toFixed(3)})`;
    const t = el.querySelector('.disco-auto-text');
    const html = autoText(left);
    if (t && t.innerHTML !== html) t.innerHTML = html;
  }
}

/* ---------- the bingo stop ---------- */

/** A winner's card from view.game.disco.bingo.winners[] (the winning cells lit). */
export function winnerCardHtml(w, { testid = 'disco-winner-card' } = {}) {
  const stamped = w.marks.filter((m, i) => i !== CENTER && m != null).length;
  return discoCardHtml({ card: w.card, marks: w.marks, goalCells: w.cells, stamped, lines: 0, bingo: true }, { testid, name: w.name });
}

/** "Anouk heeft 1 lijn" / "Anouk en Bram hebben 2 lijnen". */
export function bingoWhoText(b) {
  const names = (b?.winners || []).map((w) => w.name);
  return `${namesText(names)} ${names.length === 1 ? 'heeft' : 'hebben'} ${winText(b?.win)}`;
}

/** The leader's bingo stop: who, which goal, their card(s), and what may still happen this round. */
export function bingoStopHtml(view) {
  const d = view.game.disco;
  const b = d.bingo;
  if (!b) return '';
  return `<section class="disco-stop" data-testid="disco-bingo-stop" data-win="${esc(b.win)}" data-n="${b.winners.length}" role="status">
    <p class="disco-stop-word" aria-hidden="true">BINGO!</p>
    <h2 class="disco-stop-who" data-testid="disco-bingo-names">${esc(bingoWhoText(b))}!</h2>
    <p class="disco-stop-sub">Het spel staat stil. ${b.next.length ? 'Kies hieronder: doorgaan of stoppen.' : 'De hele kaart is vol: naar de prijsuitreiking.'}</p>
    <div class="disco-stop-cards">${b.winners.map((w, i) => `<figure class="disco-stop-card" data-testid="disco-bingo-winner" data-name="${esc(w.name)}">${winnerCardHtml(w, { testid: `disco-winner-card-${i}` })}<figcaption>${avatarHtml(w, { cls: 'dsc-av' })}<span>${esc(w.name)}</span></figcaption></figure>`).join('')}</div>
  </section>`;
}

/** The leader's choices on a bingo stop (only those that make sense). */
export function bingoChoicesHtml(view) {
  const d = view.game.disco;
  const b = d.bingo;
  const doubts = (d.doubts || []).length;
  if (doubts) {
    return `<div class="sticky-cta"><button class="btn btn-primary btn-xl is-doubts" type="button" data-action="disco-doubts" data-testid="room-next" data-state="doubts" data-doubts="${doubts}">${icons.eye}<span>${esc(`Beslis eerst (${doubts})`)}</span></button></div>`;
  }
  const go = (win, label) => `<button class="btn btn-primary btn-xl" type="button" data-action="disco-continue" data-win="${win}" data-testid="disco-go-${win}">${icons.restart}<span>${esc(label)}</span></button>`;
  return `<div class="sticky-cta disco-choices" data-testid="disco-bingo-choices">
    ${b.next.includes('line2') ? go('line2', 'Ga door voor 2 lijnen') : ''}
    ${b.next.includes('full') ? go('full', 'Ga door voor een volle kaart') : ''}
    <button class="btn ${b.next.length ? 'btn-ghost' : 'btn-primary btn-xl'}" type="button" data-action="disco-finish" data-testid="disco-finish">${icons.trophy}<span>Stop: naar de prijsuitreiking</span></button>
  </div>`;
}

/** The stages won so far ("1 lijn: Anouk · 2 lijnen: Bram"); empty before the first bingo. */
export function stagesHtml(d, { testid = 'disco-stages' } = {}) {
  const st = d?.stages || [];
  if (!st.length) return '';
  return `<ol class="disco-stages" data-testid="${testid}" aria-label="Gewonnen etappes">${st.map((s) => `<li data-win="${esc(s.win)}"><b>${esc(winLabel(s.win))}</b><span>${esc(namesText(s.names))}</span></li>`).join('')}</ol>`;
}

/** What everybody answered (the typed text too: part of the fun). */
export function discoResultsHtml(view) {
  const rs = view.game.reveal?.results || [];
  const pending = new Set(view.game.disco?.pending || []);
  return `<ul class="disco-results" data-testid="disco-results">
    ${rs.map((r, i) => {
    const v = verdictOf(r);
    const vd = VERDICT[v];
    const extra = v === 'right' ? (r.noSquare ? 'geen vakje meer' : r.stamped != null ? 'afgestempeld' : pending.has(r.id) ? 'kiest een vakje' : '') : v === 'doubt' ? 'spelleider beslist' : '';
    return `<li class="dr is-${v}${view.you && r.id === view.you.id ? ' is-you' : ''}" data-testid="disco-result-${i}" data-name="${esc(r.name)}" data-verdict="${v}">
      <span class="dr-icon" aria-hidden="true">${vd ? vd.icon() : '–'}</span>
      <span class="dr-name">${avatarHtml(r, { cls: 'dr-av' })}<span class="dr-name-t">${esc(r.name)}${view.you && r.id === view.you.id ? ' <small>(jij)</small>' : ''}</span>${resultMarks(r)}</span>
      <span class="dr-answer">${esc(resultWords(r))}</span>
      <span class="dr-verdict">${vd ? vd.word : ''}${r.overridden || (r.decided && r.auto === 'doubt') ? ' <small>(spelleider)</small>' : ''}${extra ? `<small>${esc(extra)}</small>` : ''}</span>
    </li>`;
  }).join('')}
  </ul>`;
}

/**
 * The spelleider's control ("regie") after the reveal: undecided doubts on top with big
 * Goed / Fout, every other non-empty answer flippable with one tap, who still chooses.
 */
export function regieHtml(view) {
  const g = view.game;
  const d = g.disco;
  const rs = (g.reveal?.results || []).map((r, i) => ({ ...r, i }));
  const doubts = rs.filter((r) => r.verdict === 'doubt');
  const others = rs.filter((r) => r.verdict !== 'doubt' && !r.none && !r.pass);
  const empty = rs.filter((r) => r.none || r.pass);
  const doubtRow = (r) => `<li class="rg is-doubt" data-testid="disco-regie-row" data-row="${r.i}" data-id="${esc(r.id)}" data-name="${esc(r.name)}" data-verdict="doubt">
      <div class="rg-who"><b class="rg-name">${avatarHtml(r, { cls: 'rg-av' })}<span class="rg-name-t">${esc(r.name)}</span>${resultMarks(r)}</b><span class="rg-answer">${esc(resultWords(r))}</span></div>
      <div class="rg-judge">
        <button type="button" class="btn btn-good" data-action="disco-judge" data-id="${esc(r.id)}" data-ok="1" data-testid="disco-judge-good-${r.i}" aria-label="Goed voor ${esc(r.name)}">${icons.check}<span>Goed</span></button>
        <button type="button" class="btn btn-bad" data-action="disco-judge" data-id="${esc(r.id)}" data-ok="0" data-testid="disco-judge-bad-${r.i}" aria-label="Fout voor ${esc(r.name)}">${icons.cross}<span>Fout</span></button>
      </div>
    </li>`;
  const row = (r) => {
    const v = r.verdict || (r.correct ? 'right' : 'wrong');
    const note = r.overridden ? 'omgedraaid' : r.decided && r.auto === 'doubt' ? 'door jou beslist' : '';
    const stamp = v === 'right' ? (r.noSquare ? 'geen vakje meer' : r.stamped != null ? 'afgestempeld' : (d.pending || []).includes(r.id) ? 'kiest een vakje' : '') : '';
    return `<li class="rg is-${v}" data-testid="disco-regie-row" data-row="${r.i}" data-id="${esc(r.id)}" data-name="${esc(r.name)}" data-verdict="${v}">
      <span class="rg-icon" aria-hidden="true">${v === 'right' ? icons.check : icons.cross}</span>
      <div class="rg-who"><b class="rg-name">${avatarHtml(r, { cls: 'rg-av' })}<span class="rg-name-t">${esc(r.name)}</span>${resultMarks(r)}</b><span class="rg-answer">${esc(resultWords(r))}</span>
        <small class="rg-note">${v === 'right' ? 'Goed' : 'Fout'}${note ? ` · ${note}` : ''}${stamp ? ` · ${stamp}` : ''}</small></div>
      <button type="button" class="btn btn-small btn-ghost rg-flip" data-action="disco-judge" data-id="${esc(r.id)}" data-ok="${v === 'right' ? 0 : 1}" data-testid="disco-flip-${r.i}" aria-label="${v === 'right' ? 'Toch fout' : 'Toch goed'} voor ${esc(r.name)}">${v === 'right' ? 'Toch fout' : 'Toch goed'}</button>
    </li>`;
  };
  return `<section class="regie" data-testid="disco-regie" data-doubts="${doubts.length}" aria-label="Regie">
    <h2 class="room-h regie-h">Regie <span class="muted">· ${catChip(d.cat, { short: true })}</span></h2>
    ${doubts.length ? `<div class="regie-doubts" data-testid="disco-doubts" id="disco-doubts" tabindex="-1">
      <p class="regie-doubt-head"><b>${doubts.length === 1 ? 'Twijfelgeval' : `${doubts.length} twijfelgevallen`}:</b> goed of fout? Jij beslist.</p>
      <ul class="regie-list">${doubts.map(doubtRow).join('')}</ul></div>` : ''}
    ${others.length ? `<ul class="regie-list" data-testid="disco-regie-list">${others.map(row).join('')}</ul>` : ''}
    ${empty.length ? `<p class="regie-empty muted small" data-testid="disco-regie-empty">${empty.map((r) => `${esc(r.name)} (${r.pass ? 'weet ik niet' : 'geen antwoord'})`).join(', ')}</p>` : ''}
    ${!rs.length ? '<p class="muted">Niemand deed mee deze ronde.</p>' : ''}
    ${chipsHtml(view)}
    <p class="muted small">Tik op <em>Toch goed</em> of <em>Toch fout</em> om een oordeel om te draaien; dat kan tot de volgende ronde.</p>
  </section>`;
}

/** Everybody's progress: stamped squares, full lines, who has bingo. */
export function discoProgressHtml(view, { testid = 'disco-progress' } = {}) {
  const g = view.game;
  const list = (g.disco?.progress || []).slice().sort((a, b) => (b.bingo - a.bingo) || (b.lines - a.lines) || (b.stamped - a.stamped) || (b.best - a.best) || a.name.localeCompare(b.name));
  const winners = new Set(g.winnerIds || []);
  return `<ol class="disco-progress" data-testid="${testid}" aria-label="Voortgang">
    ${list.map((p, i) => `<li class="${p.bingo || winners.has(p.id) ? 'is-bingo' : ''}${view.you && p.id === view.you.id ? ' is-you' : ''}" data-testid="${testid}-${i}" data-name="${esc(p.name)}" data-stamped="${p.stamped}" data-lines="${p.lines}" data-best="${p.best}" data-bingo="${p.bingo}">
      <span class="dp-name">${avatarHtml(p, { cls: 'dp-av' })}<span class="dp-name-t">${esc(p.name)}${view.you && p.id === view.you.id ? ' <small>(jij)</small>' : ''}</span>${view.phase === 'won' ? '' : `${streakMark(p.streak)}${jokerMark(p.jokers)}`}</span>
      <span class="dp-bar" aria-hidden="true"><i style="width:${Math.round((Math.max(0, Math.min(p.best, 5) - 1) / 4) * 100)}%"></i></span>
      <span class="dp-nums">${p.bingo ? '<b class="dp-bingo">BINGO</b>' : `${p.best === 4 ? '<em class="dp-almost">bijna!</em> ' : ''}`}<b>${p.stamped}</b> ${p.stamped === 1 ? 'vakje' : 'vakjes'} · ${p.lines} ${p.lines === 1 ? 'lijn' : 'lijnen'}</span>
    </li>`).join('')}
  </ol>`;
}

/** Round title on a phone. */
export function discoRoundTitle(view) {
  const g = view.game;
  return `<p class="room-round" data-testid="room-round"><b>Discobingo</b> · ronde ${g.round} · doel: ${esc(winText(g.disco.win))}</p>`;
}

/** The main button after the reveal: draai / beslis eerst (n) / nummers op (a bingo stop has its own choices). */
export function nextButtonHtml(view, { left = 1 } = {}) {
  const d = view.game.disco;
  if (d.bingo) return bingoChoicesHtml(view);
  const doubts = (d.doubts || []).length;
  const state = doubts ? 'doubts' : left ? 'spin' : 'pile';
  const label = { doubts: `Beslis eerst (${doubts})`, spin: 'Draai de discobal', pile: 'Nummers op: naar de uitslag' }[state];
  const icon = state === 'doubts' ? icons.eye : state === 'spin' ? icons.restart : icons.trophy;
  return `<div class="sticky-cta">
    <button class="btn btn-primary btn-xl${state === 'doubts' ? ' is-doubts' : ''}" type="button" data-action="${state === 'doubts' ? 'disco-doubts' : 'next'}" data-testid="room-next" data-state="${state}" data-doubts="${doubts}">${icon}<span>${esc(label)}</span></button>
  </div>`;
}

/** Why somebody won (winner block). */
export function discoWhy(view) {
  const g = view.game;
  if (g.endedBy === 'pile') return 'De nummers zijn op: wie de meeste vakjes heeft afgestempeld, wint.';
  const st = g.disco?.stages || [];
  if (st.length > 1) return st.map((s) => `${winLabel(s.win)}: ${namesText(s.names)}`).join(' · ');
  return g.disco?.win === 'full' ? 'Als eerste de hele kaart vol.' : `Als eerste ${winText(g.disco?.win)} vol.`;
}
