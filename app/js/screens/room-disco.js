// "Samen spelen", Discobingo: everything people see and touch of the fourth room game.
// Used by room-host.js (the spelleider's screen, also on a laptop / tv) and room-player.js
// (the phones). Everything works on a view from multi/protocol.js (viewFor); the rules live
// in multi/disco.js and game.js, the 3D ball in discoball.js.
import { CATEGORIES, categoryOf, CENTER, WIN_LABELS, DISCO_MIN_SONGS, decadeLabel } from '../multi/disco.js';
import { parseYearGuess } from '../bingo.js';
import { createDiscoBall } from '../discoball.js';
import { icons, esc } from '../ui.js';

// disco.js is the single source of truth for the colours: mirror them as CSS variables
// (disco.css carries the same values as a fallback for the first paint).
if (typeof document !== 'undefined') {
  for (const c of CATEGORIES) document.documentElement.style.setProperty(c.cssVar, c.color);
}

/* ---------- the four figures (own drawings: a filled mass plus 2.2 strokes on a 24 grid) ---------- */
const S = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const FIGURES = {
  // calendar: rings, header bar, two days
  decade: `<rect x="3.5" y="5" width="17" height="15.5" rx="2.6" ${S}/><path d="M3.5 10.2h17M8 3v4M16 3v4" ${S}/><rect x="6.6" y="12.9" width="4.2" height="4.4" rx="1" fill="currentColor"/><rect x="13.2" y="12.9" width="4.2" height="4.4" rx="1" fill="currentColor"/>`,
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
  decade: 'Kies het decennium',
  artist: 'Typ de artiest of band',
  year: 'Typ het jaartal: 2 jaar ernaast mag',
  title: 'Typ de titel van het nummer',
};
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

/* ---------- lobby ---------- */

/** "Winnen met", the explanation and the legend; `need` = songs still missing (own music). */
export function discoLobbyHtml(settings, { have = 0, mix = false } = {}) {
  const missing = Math.max(0, DISCO_MIN_SONGS - have);
  return `<div class="room-sub room-disco-settings" data-testid="room-disco-settings">
    <p class="disco-explain" data-testid="room-disco-explain">Een discobal kiest per nummer de vraag. Goed? Dan stempel je zelf een vakje van die kleur af op je 5×5-kaart.</p>
    ${legendHtml()}
    <p class="room-label">Winnen met</p>
    <div class="seg room-seg" role="radiogroup" aria-label="Winnen met">${Object.keys(WIN_LABELS).map((w) => `<label class="seg-opt"><input type="radio" name="win" value="${w}" ${settings.win === w ? 'checked' : ''} data-testid="room-disco-win-${w}"><span>${esc(WIN_LABELS[w])}</span></label>`).join('')}</div>
    <p class="muted small">Een lijn is een rij, kolom of diagonaal; de ster in het midden telt mee.</p>
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
      if (key === doneFor) return;
      doneFor = key;
      landed = false;
      clear();
      root.classList.remove('just-landed');
      root.dataset.round = String(round);
      root.dataset.phase = phase;
      const left = phase === 'answering' && Number.isFinite(d.spunAt) ? d.spunAt + (d.spinMs || 4000) - now : 0;
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
export function discoCardHtml(mine, { mode = 'show', choosable = [], choice = null, cat = null, testid = 'disco-card', name = '' } = {}) {
  const goal = new Set(mine.goalCells || []);
  const can = new Set(choosable);
  const cells = mine.card.map((key, i) => {
    const mark = mine.marks[i];
    const stamped = mark != null;
    const free = i === CENTER;
    const year = stamped && mark !== '*' ? String(mark) : '';
    const chosen = choice === i;
    const isBtn = mode === 'choose' && (can.has(i) || chosen);
    const dim = mode === 'choose' && !isBtn && !free && (stamped ? false : key !== cat || !can.size);
    // while answering: the open squares the round's category could stamp
    const now = mode === 'show' && cat && key === cat && !stamped;
    const cls = ['dq', `cat-${key}`, stamped ? 'is-stamped' : 'is-open', goal.has(i) ? 'is-goal' : '', can.has(i) ? 'is-choosable' : '', chosen ? 'is-chosen' : '', dim ? 'is-dim' : '', free ? 'is-free' : '', now ? 'is-now' : ''].filter(Boolean).join(' ');
    const label = free ? 'Vrij vakje (ster)' : `${catName(key)}${stamped ? `, afgestempeld${year ? ` met een nummer uit ${year}` : ''}` : can.has(i) ? ', tik om af te stempelen' : ''}`;
    const inner = `<span class="dq-ico">${catIcon(key)}</span>${stamped && !free ? `<span class="dq-stamp" aria-hidden="true"><span class="dq-stamp-in">${year ? `<b>${esc(year)}</b>` : icons.check}</span></span>` : ''}`;
    const attrs = `class="${cls}" data-testid="disco-sq-${i}" data-index="${i}" data-cat="${esc(key)}" data-stamped="${stamped}" data-year="${esc(year)}" data-choosable="${can.has(i)}" data-chosen="${chosen}" data-goal="${goal.has(i)}"`;
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

/** Literal text of an answer ({decade} | {guess} | {text} | {pass}). */
export function answerWords(a) {
  if (!a) return '';
  if (a.pass) return 'Weet ik niet';
  if (a.decade != null) return `${decadeLabel(a.decade).label} (${decadeLabel(a.decade).sub})`;
  if (a.guess != null) return String(a.guess);
  if (a.text != null) return `“${a.text}”`;
  return '';
}

function proposedAnswer(cat, value) {
  const v = String(value ?? '');
  if (cat === 'year') { const g = parseYearGuess(v); return g == null ? null : { guess: g }; }
  if (cat === 'artist' || cat === 'title') { const t = v.trim(); return t ? { text: t } : null; }
  return null;
}
const sameAnswer = (a, b) => !!a && !!b && !a.pass && !b.pass && (a.guess != null ? Number(a.guess) === Number(b.guess) : a.text != null && String(b.text ?? '').trim() === String(a.text).trim());

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
  const typed = cat === 'year' || cat === 'artist' || cat === 'title';
  const value = local.value != null ? local.value : sent && !sent.pass ? (cat === 'year' ? String(sent.guess ?? '') : sent.text ?? '') : '';
  const proposed = typed ? proposedAnswer(cat, value) : null;
  const changed = !!proposed && !sameAnswer(proposed, sent);
  const state = sent?.pass && !changed ? 'pass' : sent && !changed ? 'locked' : changed ? 'changed' : 'none';
  const stateText = state === 'locked' ? `<b>Vastgezet:</b> ${esc(answerWords(sent))}. <span class="muted">Wijzigen kan tot de onthulling.</span>`
    : state === 'pass' ? '<b>Je weet het niet.</b> <span class="muted">Toch een idee? Antwoorden kan tot de onthulling.</span>'
      : state === 'changed' && sent && !sent.pass ? `Nog vastgezet: ${esc(answerWords(sent))}. <span class="muted">Tik op wijzigen om dit te vervangen.</span>`
        : esc(INSTRUCTION[cat] || '');
  let body = '';
  if (cat === 'decade') {
    body = `<div class="disco-decades" role="group" aria-label="Decennium">${d.decades.map((x) => {
      const on = sent?.decade === x.decade;
      return `<button type="button" class="disco-dec${on ? ' is-on' : ''}" data-action="disco-decade" data-decade="${x.decade}" data-testid="disco-decade-${x.decade}" aria-pressed="${on}" ${sending ? 'disabled' : ''}><b>${esc(x.label)}</b><small>${esc(x.sub)}</small></button>`;
    }).join('')}</div>`;
  } else if (cat === 'year') {
    body = `<div class="disco-field"><label for="disco-year">Uit welk jaar is dit nummer?</label>
      <input id="disco-year" class="disco-year-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="bv. 1987" value="${esc(value)}" data-testid="disco-year-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
      <small class="muted" data-testid="disco-hint">2 jaar ernaast mag.</small></div>`;
  } else {
    body = `<div class="disco-field"><label for="disco-text">${cat === 'artist' ? 'Wie zingt of speelt dit?' : 'Hoe heet dit nummer?'}</label>
      <input id="disco-text" type="text" maxlength="60" placeholder="${cat === 'artist' ? 'Typ de artiest of band' : 'Typ de titel'}" value="${esc(value)}" data-testid="disco-text-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
      <small class="muted" data-testid="disco-hint">Kleine typefouten zijn niet erg. Twijfelgeval? Dan beslist de spelleider.</small></div>`;
  }
  const lockLabel = sending ? 'Versturen…' : state === 'locked' ? 'Vastgezet' : !proposed ? (cat === 'year' ? 'Vul een jaartal in' : 'Typ je antwoord') : sent && !sent.pass ? 'Wijzig mijn antwoord' : 'Zet vast';
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
      return JSON.stringify([v?.phase, g?.round, g?.disco?.cat, g?.disco?.decades, g?.answer, !!g?.mine, g?.mine?.marks]);
    },
    onClick(e) {
      const a = e.target.closest('[data-action]');
      if (!a) return false;
      const v = getView();
      if (v?.game?.kind !== 'disco' || v.phase !== 'answering' || !v.game.mine) return false;
      const act = a.dataset.action;
      if (act === 'disco-decade') { if (!a.disabled) send({ decade: Number(a.dataset.decade) }); return true; }
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
  if (r.decade != null) return decadeLabel(r.decade).label;
  if (r.guess != null) return String(r.guess);
  if (r.text != null) return `“${r.text}”`;
  return r.label || '';
}
const verdictOf = (r) => (r.none ? 'none' : r.pass ? 'pass' : r.verdict || (r.correct ? 'right' : 'wrong'));

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
  if (g.mine.bingo) {
    return `<p class="disco-bingo" data-testid="disco-bingo" role="status">BINGO!</p>
      <p class="disco-choose" data-testid="disco-choose" data-state="bingo">Je hebt ${esc(winText(d.win))}. ${d.choice != null && d.choosable.length > 1 ? 'Verplaatsen kan nog.' : ''} De spelleider gaat zo naar de uitslag.</p>`;
  }
  if (d.noSquare) return `<p class="disco-choose is-none" data-testid="disco-choose" data-state="nosquare">${catChip(cat)} <span>Geen open vakje van deze kleur meer: je hoeft niets af te stempelen.</span></p>`;
  if (d.choice == null) return `<p class="disco-choose is-todo" data-testid="disco-choose" data-state="choose"><span>Kies een</span> ${catChip(cat)} <span>vakje op je kaart</span></p>`;
  return `<p class="disco-choose is-done" data-testid="disco-choose" data-state="chosen">${icons.check}<span>Afgestempeld. Liever een ander ${esc(catShort(cat).toLowerCase())}-vakje? Tik erop.</span></p>`;
}

/** What everybody answered (the typed text too: part of the fun). */
export function discoResultsHtml(view) {
  const rs = view.game.reveal?.results || [];
  const pending = new Set(view.game.disco?.pending || []);
  return `<ul class="disco-results" data-testid="disco-results">
    ${rs.map((r, i) => {
    const v = verdictOf(r);
    const vd = VERDICT[v];
    const extra = v === 'right' ? (r.noSquare ? 'geen vakje meer' : r.stamped != null ? 'stempelt' : pending.has(r.id) ? 'kiest een vakje' : '') : v === 'doubt' ? 'spelleider beslist' : '';
    return `<li class="dr is-${v}${view.you && r.id === view.you.id ? ' is-you' : ''}" data-testid="disco-result-${i}" data-name="${esc(r.name)}" data-verdict="${v}">
      <span class="dr-icon" aria-hidden="true">${vd ? vd.icon() : '–'}</span>
      <span class="dr-name">${esc(r.name)}${view.you && r.id === view.you.id ? ' <small>(jij)</small>' : ''}</span>
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
  const pendingNames = (d.pending || []).map((id) => rs.find((r) => r.id === id)?.name).filter(Boolean);
  const doubtRow = (r) => `<li class="rg is-doubt" data-testid="disco-regie-row" data-row="${r.i}" data-id="${esc(r.id)}" data-name="${esc(r.name)}" data-verdict="doubt">
      <div class="rg-who"><b class="rg-name">${esc(r.name)}</b><span class="rg-answer">${esc(resultWords(r))}</span></div>
      <div class="rg-judge">
        <button type="button" class="btn btn-good" data-action="disco-judge" data-id="${esc(r.id)}" data-ok="1" data-testid="disco-judge-good-${r.i}" aria-label="Goed voor ${esc(r.name)}">${icons.check}<span>Goed</span></button>
        <button type="button" class="btn btn-bad" data-action="disco-judge" data-id="${esc(r.id)}" data-ok="0" data-testid="disco-judge-bad-${r.i}" aria-label="Fout voor ${esc(r.name)}">${icons.cross}<span>Fout</span></button>
      </div>
    </li>`;
  const row = (r) => {
    const v = r.verdict || (r.correct ? 'right' : 'wrong');
    const note = r.overridden ? 'omgedraaid' : r.decided && r.auto === 'doubt' ? 'door jou beslist' : '';
    const stamp = v === 'right' ? (r.noSquare ? 'geen vakje meer' : r.stamped != null ? 'vakje gekozen' : (d.pending || []).includes(r.id) ? 'kiest nog' : '') : '';
    return `<li class="rg is-${v}" data-testid="disco-regie-row" data-row="${r.i}" data-id="${esc(r.id)}" data-name="${esc(r.name)}" data-verdict="${v}">
      <span class="rg-icon" aria-hidden="true">${v === 'right' ? icons.check : icons.cross}</span>
      <div class="rg-who"><b class="rg-name">${esc(r.name)}</b><span class="rg-answer">${esc(resultWords(r))}</span>
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
    ${empty.length ? `<p class="regie-empty muted small" data-testid="disco-regie-empty">${empty.map((r) => `${esc(r.name)} (${r.pass ? 'weet het niet' : 'geen antwoord'})`).join(', ')}</p>` : ''}
    ${!rs.length ? '<p class="muted">Niemand deed mee deze ronde.</p>' : ''}
    <p class="regie-pending small" data-testid="disco-pending" data-count="${pendingNames.length}">${pendingNames.length
    ? `Kiest nog een vakje: <b>${pendingNames.map(esc).join(', ')}</b>. Draai je door, dan zet de app het op het beste vakje.`
    : doubts.length ? '' : 'Iedereen met een goed antwoord heeft gestempeld.'}</p>
    <p class="muted small">Tik op <em>Toch goed</em> of <em>Toch fout</em> om een oordeel om te draaien; dat kan tot je verder draait.</p>
  </section>`;
}

/** Everybody's progress: stamped squares, full lines, who has bingo. */
export function discoProgressHtml(view, { testid = 'disco-progress' } = {}) {
  const g = view.game;
  const list = (g.disco?.progress || []).slice().sort((a, b) => (b.bingo - a.bingo) || (b.lines - a.lines) || (b.stamped - a.stamped) || (b.best - a.best) || a.name.localeCompare(b.name));
  const winners = new Set(g.winnerIds || []);
  return `<ol class="disco-progress" data-testid="${testid}" aria-label="Voortgang">
    ${list.map((p, i) => `<li class="${p.bingo || winners.has(p.id) ? 'is-bingo' : ''}${view.you && p.id === view.you.id ? ' is-you' : ''}" data-testid="${testid}-${i}" data-name="${esc(p.name)}" data-stamped="${p.stamped}" data-lines="${p.lines}" data-best="${p.best}" data-bingo="${p.bingo}">
      <span class="dp-name">${esc(p.name)}${view.you && p.id === view.you.id ? ' <small>(jij)</small>' : ''}</span>
      <span class="dp-bar" aria-hidden="true"><i style="width:${Math.round((Math.max(0, Math.min(p.best, 5) - 1) / 4) * 100)}%"></i></span>
      <span class="dp-nums">${p.bingo ? '<b class="dp-bingo">BINGO</b>' : `${p.best === 4 ? '<em class="dp-almost">bijna!</em> ' : ''}`}<b>${p.stamped}</b> ${p.stamped === 1 ? 'vakje' : 'vakjes'} · ${p.lines} ${p.lines === 1 ? 'lijn' : 'lijnen'}</span>
    </li>`).join('')}
  </ol>`;
}

/** Round title on a phone. */
export function discoRoundTitle(view) {
  const g = view.game;
  return `<p class="room-round" data-testid="room-round"><b>Discobingo</b> · ronde ${g.round} · winnen met ${esc(winText(g.disco.win))}</p>`;
}

/** The main button after the reveal: draai / beslis eerst (n) / naar de uitslag. */
export function nextButtonHtml(view, { left = 1 } = {}) {
  const d = view.game.disco;
  const doubts = (d.doubts || []).length;
  const won = (view.game.reveal?.roundWinners || []).length > 0 || (d.progress || []).some((p) => p.bingo);
  const state = doubts ? 'doubts' : won ? 'won' : left ? 'spin' : 'pile';
  const label = { doubts: `Beslis eerst (${doubts})`, won: 'Naar de uitslag', spin: 'Draai de discobal', pile: 'Nummers op: uitslag' }[state];
  const icon = state === 'doubts' ? icons.eye : state === 'spin' ? icons.restart : icons.trophy;
  return `<div class="sticky-cta">
    <button class="btn btn-primary btn-xl${state === 'doubts' ? ' is-doubts' : ''}" type="button" data-action="${state === 'doubts' ? 'disco-doubts' : 'next'}" data-testid="room-next" data-state="${state}" data-doubts="${doubts}">${icon}<span>${esc(label)}</span></button>
  </div>`;
}

/** Why somebody won (winner block). */
export function discoWhy(view) {
  const g = view.game;
  if (g.endedBy === 'pile') return 'De nummers zijn op: wie de meeste vakjes heeft afgestempeld, wint.';
  return `Als eerste ${winText(g.disco?.win)} vol op de kaart.`;
}
