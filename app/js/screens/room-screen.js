// "Groot scherm" (#/scherm/ABCD): a display-only screen for a tv or a laptop next to the room.
// It watches the room through the room server (multi/server-session.js
// createServerScreenSession) and shows what the whole room may see: the join screen with the
// big QR code in the lobby, the disco ball and the category, who has answered, the song and
// everybody's answers after the reveal, now and then the ranking, the winner. No controls (only
// fullscreen and, when the line is gone, "Nu opnieuw"), no login, never music, and it writes
// nothing to localStorage, so it can run in a second tab next to the spelleider's tab.
import { CATEGORIES } from '../multi/disco.js';
import { createServerScreenSession, usesServer } from '../multi/server-session.js';
import { ERROR_TITLES } from '../multi/server-protocol.js';
import { normalizeCode } from '../multi/code.js';
import { createDiscoBall } from '../discoball.js';
import { icons, esc } from '../ui.js';
import {
  patch, qrSvg, roomLink, appBase, keepAwake, diagHtml, diagKey, diagVisible, confettiHtml, songHtml, gameName,
  quizQuestionHtml, quizRevealHtml, quizPodiumHtml, tickQuizClocks, quizSettingsText, standingsHtml, winnerHtml,
} from './room-ui.js';
import { createDiscoStage, catChip, catIcon, resultWords, winText } from './room-disco.js';
import { avatarOf } from '../multi/party.js';
import { avatarHtml, resultMarks, streakMark, jokerMark, createFloatLayer, awardsListHtml, awardSpotHtml } from './party-ui.js';

export const name = 'room-screen';

const IDLE_CURSOR_MS = 3000;
/** After a reveal the answers come first; the ranking follows as its own moment (when it is due). */
const RANKING_AFTER_MS = 9000;
const RANKING_AFTER_BINGO_MS = 6000;
/** Joined (or reloaded) in the middle of a reveal: we do not know when it began, so a short wait. */
const RANKING_AFTER_LOAD_MS = 3000;
/** The ranking slides in every this many rounds (and whenever it is exciting). */
const RANKING_EVERY = 3;

const fsIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const tvIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="4.5" width="19" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20.5h8M12 17v3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;
/** "Anouk", "Anouk en Bram", "Anouk, Bram en Cas" (escaped, in <b>). */
const namesList = (names) => {
  const b = names.map((n) => `<b>${esc(n)}</b>`);
  return b.length <= 1 ? b.join('') : `${b.slice(0, -1).join(', ')} en ${b[b.length - 1]}`;
};
/** The address people type: the app without "https://" and without the hash. */
const shortAddress = () => appBase().replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Tile colours: the four category colours plus the app's coral and purple, by name. */
const TILE_COLORS = ['#4fb3ff', '#ff5fa8', '#ffc649', '#2ed3c0', '#ff8a5c', '#b98cff'];
function colorFor(nm) {
  let h = 0;
  for (const ch of String(nm)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}
/** The prize ceremony after a won Discobingo: the winner on its own, then each award, then the overview that stays. */
const CEREMONY_WINNER_MS = 6000;
const CEREMONY_AWARD_MS = 4800;

/** What the settings of a game read like: "winnen met 1 lijn", "4×4", "doel 10 kaarten", "10 vragen, …". */
function settingsText(s) {
  if (!s) return '';
  if (s.game === 'disco') return `winnen met ${winText(s.win)}`;
  if (s.game === 'bingo') return `kaart van ${s.size}×${s.size}, eerst een volle rij`;
  if (s.game === 'quiz') return quizSettingsText(s);
  return `doel ${s.goal} kaarten op je tijdlijn`;
}

/* ---------- Discobingo progress: who is close (toGo from the engine, else a line1 fallback) ---------- */

/** Squares still needed for the goal; null when the view does not say (older server, line2/full). */
function toGoOf(p, win) {
  if (Number.isFinite(p.toGo)) return p.toGo;
  if (p.bingo) return 0;
  if (win === 'line1' && Number.isFinite(p.best)) return Math.max(0, 5 - p.best);
  return null;
}
const closeOnes = (d) => (d?.progress || []).filter((p) => !p.bingo && toGoOf(p, d.win) === 1);

function sortedProgress(d) {
  const tg = (p) => { const t = toGoOf(p, d.win); return t == null ? 99 : t; };
  return (d?.progress || []).slice().sort((a, b) => (b.bingo - a.bingo) || (tg(a) - tg(b)) || (b.lines - a.lines)
    || (b.stamped - a.stamped) || (b.best - a.best) || a.name.localeCompare(b.name));
}

/** The ranking as its own moment: headline + everybody's squares and lines, the close ones lit. */
function rankingHtml(v, { reason, limit = 12 } = {}) {
  const g = v.game;
  const d = g.disco;
  const winners = new Set(g.winnerIds || []);
  const list = sortedProgress(d);
  const close = new Set(closeOnes(d).map((p) => p.id));
  const bingo = list.filter((p) => p.bingo || winners.has(p.id));
  let head;
  if (reason === 'won') head = '';
  else if (reason === 'bingo') head = `<span class="sk-kick is-bingo">BINGO!</span> ${namesList(bingo.map((p) => p.name))} ${bingo.length === 1 ? 'heeft' : 'hebben'} ${esc(winText(d.win))}`;
  else if (reason === 'close') { const c = list.filter((p) => close.has(p.id)); head = `<span class="sk-kick">Spannend!</span> ${namesList(c.map((p) => p.name))} ${c.length === 1 ? 'heeft' : 'hebben'} nog 1 vakje nodig`; } else head = `<span class="sk-kick is-calm">De stand</span> na ronde ${g.round}`;
  const shown = list.slice(0, limit);
  const rows = shown.map((p, i) => {
    const t = toGoOf(p, d.win);
    const isBingo = p.bingo || winners.has(p.id);
    const isClose = close.has(p.id);
    const badge = isBingo ? '<b class="sk-badge is-bingo">BINGO</b>' : isClose ? '<b class="sk-badge is-close">nog 1!</b>' : t != null ? `<small class="sk-togo">nog ${t}</small>` : '';
    const dots = Array.from({ length: 5 }, (_, k) => `<i class="${k < Math.min(5, p.best) ? 'on' : ''}"></i>`).join('');
    return `<li class="sk-row${isBingo ? ' is-bingo' : ''}${isClose ? ' is-close' : ''}" style="--i:${i}" data-testid="screen-progress-row" data-name="${esc(p.name)}" data-stamped="${p.stamped}" data-lines="${p.lines}" data-best="${p.best}" data-togo="${t ?? ''}" data-bingo="${!!isBingo}" data-close="${isClose}">
      <span class="sk-place">${i + 1}</span>
      <span class="sk-name">${avatarHtml(p, { cls: 'sk-av' })}<span class="sk-name-t">${esc(p.name)}</span>${reason === 'won' ? '' : `${streakMark(p.streak)}${jokerMark(p.jokers)}`}</span>
      <span class="sk-dots" aria-label="Beste lijn: ${p.best} van 5">${dots}</span>
      <span class="sk-nums"><b>${p.stamped}</b> ${p.stamped === 1 ? 'vakje' : 'vakjes'} · <b>${p.lines}</b> ${p.lines === 1 ? 'lijn' : 'lijnen'}</span>
      <span class="sk-end">${badge}</span>
    </li>`;
  }).join('');
  const more = list.length > shown.length ? `<p class="sk-more">en nog ${list.length - shown.length}</p>` : '';
  return `<section class="sk${list.length > 6 ? ' is-two' : ''}" data-testid="screen-ranking" data-reason="${esc(reason)}" data-n="${list.length}">
    ${head ? `<h2 class="sk-h">${head}</h2>` : ''}
    <ol class="sk-list">${rows}</ol>${more}
  </section>`;
}

/* ---------- after the reveal: everybody's answers ---------- */

const verdictOf = (r) => (r.none ? 'none' : r.pass ? 'pass' : r.verdict || (r.correct ? 'right' : 'wrong'));
const VERDICT_WORD = { right: 'Goed', wrong: 'Fout', doubt: 'Twijfel', none: '', pass: '' };

function discoAnswersHtml(v, { flash = true } = {}) {
  const g = v.game;
  const d = g.disco;
  const rs = g.reveal?.results || [];
  // an away player with a right answer may still be listed as choosing: the host's next round places it
  const away = new Set(v.players.filter((p) => !p.online).map((p) => p.id));
  const pending = new Set((d.pending || []).filter((id) => !away.has(id)));
  const doubts = rs.filter((r) => verdictOf(r) === 'doubt').length;
  const rows = rs.map((r) => {
    const vd = verdictOf(r);
    let note = '';
    let stamp = '';
    if (vd === 'doubt') note = 'de spelleider beslist…';
    else if (vd === 'right') {
      stamp = r.noSquare ? 'nosquare' : r.stamped != null ? 'stamped' : pending.has(r.id) ? 'choosing' : '';
      note = { nosquare: 'geen vakje meer', stamped: 'afgestempeld', choosing: 'kiest een vakje…' }[stamp] || '';
    }
    const judged = r.overridden || (r.decided && r.auto === 'doubt');
    const icon = vd === 'right' ? icons.check : vd === 'wrong' ? icons.cross : vd === 'doubt' ? '?' : '–';
    return `<li class="sr is-${vd}${r.fastest ? ` is-fast${flash ? ' is-flash' : ''}` : ''}" data-testid="screen-result" data-name="${esc(r.name)}" data-verdict="${vd}" data-stamp="${stamp}" data-judged="${!!judged}" data-fastest="${!!r.fastest}">
      <span class="sr-icon" aria-hidden="true">${icon}</span>
      <span class="sr-name">${avatarHtml(r, { cls: 'sr-av' })}<span class="sr-name-t">${esc(r.name)}</span>${resultMarks(r)}</span>
      <span class="sr-answer">${esc(resultWords(r))}</span>
      <span class="sr-verdict">${VERDICT_WORD[vd]}${judged ? ' <small>door de spelleider</small>' : ''}${note ? `<small class="sr-note">${esc(note)}</small>` : ''}</span>
    </li>`;
  }).join('');
  const pendingNames = [...pending].map((id) => rs.find((r) => r.id === id)?.name).filter(Boolean);
  return `<section class="sa${rs.length > 6 ? ' is-two' : ''}" data-testid="screen-results" data-doubts="${doubts}" data-n="${rs.length}">
    <h2 class="sa-h">Wie zat goed? ${catChip(d.cat, { short: true })}</h2>
    ${rs.length ? `<ul class="sa-list">${rows}</ul>` : '<p class="sa-empty">Niemand deed mee deze ronde.</p>'}
    <p class="sa-foot" data-testid="screen-pending" data-count="${pendingNames.length}">${doubts ? `${icons.eye}<span>De spelleider beslist over ${doubts === 1 ? 'een twijfelgeval' : `${doubts} twijfelgevallen`}…</span>`
    : pendingNames.length ? `<span>Kiest nog een vakje: ${namesList(pendingNames)}</span>` : rs.some((r) => verdictOf(r) === 'right') ? `${icons.check}<span>Iedereen met een goed antwoord heeft gestempeld.</span>` : ''}</p>
  </section>`;
}

/** Bingo / Tijdlijn after the reveal: who had it right. */
function plainAnswersHtml(v) {
  const rs = v.game.reveal?.results || [];
  const rw = v.game.reveal?.roundWinners || [];
  const rows = rs.map((r) => {
    const vd = verdictOf(r);
    const icon = vd === 'right' ? icons.check : vd === 'wrong' ? icons.cross : '–';
    return `<li class="sr is-${vd}" data-testid="screen-result" data-name="${esc(r.name)}" data-verdict="${vd}">
      <span class="sr-icon" aria-hidden="true">${icon}</span>
      <span class="sr-name">${avatarHtml(r, { cls: 'sr-av' })}<span class="sr-name-t">${esc(r.name)}</span></span>
      <span class="sr-answer">${esc(r.none ? 'geen antwoord' : r.pass ? 'gepast' : r.label || '')}</span>
      <span class="sr-verdict">${VERDICT_WORD[vd]}${r.overridden ? ' <small>door de spelleider</small>' : ''}</span>
    </li>`;
  }).join('');
  return `${rw.length ? `<p class="sg-call" data-testid="screen-round-winners">${v.game.kind === 'bingo' ? 'Bingo' : 'Doel gehaald'}: ${namesList(rw)}!</p>` : ''}
    <section class="sa${rs.length > 6 ? ' is-two' : ''}" data-testid="screen-results" data-n="${rs.length}">
      <h2 class="sa-h">Wie zat goed?</h2>
      ${rs.length ? `<ul class="sa-list">${rows}</ul>` : '<p class="sa-empty">Niemand deed mee deze ronde.</p>'}
    </section>`;
}

/* ---------- small pieces ---------- */

function listenHtml(text = 'Luister…') {
  return `<div class="sl-listen" data-testid="screen-listen"><span class="eqz" aria-hidden="true">${'<i></i>'.repeat(9)}</span><span class="sl-listen-text">${esc(text)}</span></div>`;
}

function answeredHtml(v) {
  // players who are away keep their seat but are never someone the room waits for
  const playing = v.players.filter((p) => p.playing && p.online);
  const done = playing.filter((p) => p.answered).length;
  const all = playing.length > 0 && done === playing.length;
  return `<p class="s-count${all ? ' is-all' : ''}" data-testid="screen-count" data-done="${done}" data-total="${playing.length}">${all
    ? `${icons.check}<span>Iedereen heeft geantwoord!</span>`
    : `<span><b>${done}</b> van <b>${playing.length}</b> ${done === 1 ? 'heeft' : 'hebben'} geantwoord</span>`}</p>`;
}

function joinBadgeHtml(code) {
  return `<div class="s-badge" data-testid="screen-join-badge">
    <span class="s-badge-text"><span>Doe mee</span><b>${esc(code)}</b></span>
    <span class="s-badge-qr">${qrSvg(roomLink(code), { margin: 1 })}</span>
  </div>`;
}

function titleHtml(v) {
  const g = v.game;
  const k = g.kind;
  let rest = '';
  if (v.phase === 'won') rest = 'uitslag';
  else if (k === 'quiz') rest = `vraag ${g.round} van ${g.quiz?.total ?? '?'}`;
  else if (k === 'disco') rest = `ronde ${g.round} · winnen met ${esc(winText(g.disco?.win))}`;
  else if (k === 'bingo') rest = `ronde ${g.round} · ${g.size}×${g.size}`;
  else rest = `ronde ${g.round} · doel ${g.goal}`;
  return `<p class="s-title" data-testid="screen-game" data-game="${esc(k)}"><b class="s-title-game${k === 'disco' ? ' is-disco' : ''}">${esc(gameName(k))}</b><span>${rest}</span></p>`;
}

/**
 * Player tiles, updated in place (keyed by id): a tile that is already there keeps its DOM, so
 * its pop-in or light-up animation never replays on a redraw. New tiles pop in (with a burst
 * when `burst`); answering lights a tile up once.
 */
function syncTiles(ul, players, { game = false, burst = false } = {}) {
  const have = new Map();
  for (const li of ul.querySelectorAll(':scope > li[data-id]')) have.set(li.dataset.id, li);
  let prev = null;
  for (const p of players) {
    let li = have.get(p.id);
    if (li) have.delete(p.id);
    else {
      li = document.createElement('li');
      li.className = 'st';
      li.dataset.testid = 'screen-player';
      li.dataset.id = p.id;
      li.innerHTML = `<span class="st-av" aria-hidden="true"></span><span class="st-name"></span><span class="st-tag"></span>${burst ? `<span class="st-burst" aria-hidden="true">${'<i></i>'.repeat(8)}</span>` : ''}`;
      if (burst) { li.classList.add('is-new'); li.addEventListener('animationend', (e) => { if (e.target === li) li.classList.remove('is-new'); }); }
      if (burst) setTimeout(() => li.querySelector('.st-burst')?.remove(), 1600);
    }
    const answered = game && p.playing && !!p.answered;
    if (li.__name !== p.name) {
      li.__name = p.name;
      li.dataset.name = p.name;
      li.style.setProperty('--tc', colorFor(p.name));
      li.querySelector('.st-name').textContent = p.name;
    }
    const av = avatarOf(p);
    if (li.__av !== av) {
      // a new avatar (picked in the lobby) gets a little pop
      if (li.__av) { li.classList.remove('av-swap'); void li.offsetWidth; li.classList.add('av-swap'); }
      li.__av = av;
      li.dataset.avatar = av;
      const el = li.querySelector('.st-av');
      el.textContent = av;
      el.dataset.testid = 'player-avatar';
      el.dataset.avatar = av;
    }
    const tag = !p.online ? 'offline' : game && !p.playing ? 'doet zo mee' : p.host ? 'spelleider' : '';
    if (li.__tag !== tag) { li.__tag = tag; li.querySelector('.st-tag').textContent = tag; }
    li.dataset.online = String(!!p.online);
    li.dataset.answered = String(answered);
    li.classList.toggle('is-offline', !p.online);
    li.classList.toggle('is-waiting', game && !p.playing);
    if (li.__answered === false && answered) { li.classList.remove('just-lit'); void li.offsetWidth; li.classList.add('just-lit'); }
    li.__answered = answered;
    li.classList.toggle('is-lit', answered);
    if ((prev ? prev.nextElementSibling : ul.firstElementChild) !== li) ul.insertBefore(li, prev ? prev.nextElementSibling : ul.firstElementChild);
    prev = li;
  }
  for (const li of have.values()) li.remove();
  // the grid gets denser as the room fills up (12 names must fit)
  const n = players.length;
  ul.dataset.n = String(n);
  ul.style.setProperty('--cols', String(game ? (n <= 3 ? Math.max(1, n) : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5) : (n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5)));
}

/* ---------- #/scherm without a code: a small prompt ---------- */

function renderPrompt(root, navigate, raw) {
  const ok = usesServer();
  root.innerHTML = `<section class="scr scr-prompt" data-testid="screen-display" data-phase="none" data-status="prompt" data-game="">
    ${bgHtml()}
    <main class="s-body"><div class="scr-center">
      <div class="scr-ball-sm" data-ball></div>
      <h1 class="scr-h1">${tvIcon}<span>Groot scherm</span></h1>
      ${ok ? `<p class="scr-p">Zet de kamer groot op een tv of laptop. Vul de code in die op het scherm van de spelleider staat.</p>
      <form class="scr-form" data-testid="screen-code-form" autocomplete="off">
        <input class="scr-code-input" name="code" maxlength="4" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="ABCD" aria-label="Kamercode" data-testid="screen-code-input" value="${esc(raw ? String(raw).toUpperCase().slice(0, 4) : '')}">
        <button class="btn btn-primary btn-xl" type="submit" data-testid="screen-code-submit">${tvIcon}<span>Toon de kamer</span></button>
      </form>
      <p class="scr-hint" data-testid="screen-code-hint" aria-live="polite">${raw ? 'Die code klopt niet: een kamercode heeft 4 letters.' : ''}</p>`
    : noServerHtml()}
      <a class="btn btn-ghost" href="#/" data-testid="screen-home">${icons.home}<span>Naar start</span></a>
    </div></main>
  </section>`;
  const prev = document.title;
  document.title = 'Groot scherm · TimeTunesr';
  const ballEl = root.querySelector('[data-ball]');
  const ball = createDiscoBall(ballEl, { categories: CATEGORIES, size: 'auto' });
  ball.idle();
  const form = root.querySelector('form');
  const onSubmit = (e) => {
    e.preventDefault();
    const c = normalizeCode(form.code.value);
    if (!c) { root.querySelector('[data-testid="screen-code-hint"]').textContent = 'Een kamercode heeft 4 letters, bijvoorbeeld KDFM.'; form.code.focus(); return; }
    navigate(`#/scherm/${c}`);
  };
  form?.addEventListener('submit', onSubmit);
  if (form) setTimeout(() => form.code.focus({ preventScroll: true }), 50);
  return () => { form?.removeEventListener('submit', onSubmit); ball.destroy(); document.title = prev; };
}

function noServerHtml() {
  return `<div class="scr-msg-box" data-testid="screen-error" data-code="noserver">
    <h2>${esc(ERROR_TITLES.noserver)}</h2>
    <p>Het grote scherm volgt de kamer via de kamerserver. Hier is geen server ingesteld (de telefoons verbinden rechtstreeks met elkaar); volg het spel dan op het toestel van de spelleider.</p>
  </div>`;
}

function bgHtml() {
  return `<div class="scr-bg" aria-hidden="true"><i class="sb-glow"></i><i class="sb-beams"></i></div>`;
}

/* ---------- the display ---------- */

export function render(root, { params, navigate }) {
  document.documentElement.classList.add('tt-screen');
  const raw = params?.[0];
  const code = raw ? normalizeCode(raw) : null;
  if (!code) {
    const off = renderPrompt(root, navigate, raw);
    return () => { off(); document.documentElement.classList.remove('tt-screen'); };
  }

  const prevTitle = document.title;
  document.title = `Groot scherm · ${code}`;
  const session = createServerScreenSession({ code });
  let mode = null;
  const regions = {};
  const keys = {};
  let stage = null; // Discobingo: the ball + category (createDiscoStage: the same server-timed spin as everywhere)
  let ball = null; // lobby / waiting: the idle ball
  let tiles = null;
  let seenPlayers = null; // ids seen in the lobby: who is new gets a burst
  let reveal = { key: '', at: 0, loaded: false }; // when this screen saw the reveal of a round
  let loadedKey = null; // the round that was already revealed when this screen came in ('' = none)
  let flashFor = null; // the round whose answers already flashed "⚡ Snelste"
  let sawLive = false; // this display saw the game running (came in at the end, or reloaded: the ceremony goes to its overview)
  let cer = { k: null, start: 0, timer: 0, stepKey: '' }; // the prize ceremony of the won game
  // reactions float up from the bottom, never across the song or a QR code
  const floats = createFloatLayer(document.body, {
    avoid: () => {
      const rects = [...root.querySelectorAll('[data-testid="screen-qr"], .s-badge, [data-testid="screen-song"], .quiz-song, .quiz-correct, [data-testid="room-winner-name"], .aw-spot-title')].map((e) => e.getBoundingClientRect());
      // while a round is answered, the column where the song (or the quiz answer) will appear at
      // the reveal stays free too, so a float already in the air never has to cross it
      if (session.view?.phase === 'answering') {
        const body = root.querySelector('.s-body')?.getBoundingClientRect();
        if (body) rects.push(new DOMRect(body.left, body.top, body.width * (mode === 'quiz' ? 0.56 : 0.5), body.height));
      }
      return rects;
    },
  });
  const offReact = session.onReaction?.((r) => { if (mode && mode !== 'error' && mode !== 'boot') floats.push(r); });

  function modeFor() {
    if (session.error) return 'error';
    const v = session.view;
    if (!v) return 'boot';
    if (v.phase === 'lobby' || !v.game) return 'lobby';
    if (v.phase === 'won') return 'won';
    return v.game.kind === 'disco' ? 'disco' : v.game.kind === 'quiz' ? 'quiz' : 'game';
  }

  function skeleton(m) {
    stage?.destroy(); stage = null;
    ball?.destroy(); ball = null;
    tiles = null;
    for (const k of Object.keys(regions)) delete regions[k];
    const top = ['disco', 'quiz', 'game', 'won'].includes(m)
      ? `<header class="s-top"><div data-region="title"></div><div data-region="ticker" class="s-top-mid"></div><div data-region="badge"></div></header>` : '';
    const link = roomLink(code);
    const body = {
      error: '<div class="scr-center" data-region="main"></div>',
      boot: '<div class="scr-center"><div class="scr-ball-sm" data-fixed="ball"></div><div data-region="main" class="scr-boot"></div></div>',
      lobby: `<div class="sl">
          <div class="sl-join">
            <p class="sl-kicker">Doe mee!</p>
            <div class="sl-qr" data-testid="screen-qr" role="img" aria-label="QR-code: ${esc(link)}">${qrSvg(link, { margin: 3 })}</div>
            <p class="sl-how">Scan de QR-code of ga naar <b data-testid="screen-join-url" data-url="${esc(link)}">${esc(shortAddress())}</b> en vul de code in.</p>
          </div>
          <div class="sl-side">
            <div class="sl-head">
              <div class="sl-code-box">
                <p class="sl-kicker">Kamercode</p>
                <p class="sl-code" data-testid="screen-code" aria-label="Kamercode ${[...code].join(' ')}">${[...code].map((ch, i) => `<span style="--i:${i}">${esc(ch)}</span>`).join('')}</p>
              </div>
              <div class="sl-ball" data-fixed="ball"></div>
            </div>
            <div data-region="game"></div>
            <div class="sl-players">
              <div data-region="count"></div>
              <ul class="st-grid" data-testid="screen-players" data-fixed="tiles"></ul>
              <div data-region="empty"></div>
            </div>
            <p class="sl-foot" data-region="foot"></p>
          </div>
        </div>`,
      disco: `<div class="sd">
          <div class="sd-show"><div class="sd-stage" data-fixed="stage"></div><div data-region="song" class="sd-song"></div></div>
          <div class="sd-side">
            <div class="sd-play"><div data-region="listen"></div><ul class="st-grid is-game" data-testid="screen-players" data-fixed="tiles"></ul></div>
            <div class="sd-after" data-region="after"></div>
          </div>
        </div>`,
      quiz: `<div class="sq">
          <div data-region="quiz" class="sq-main"></div>
          <ul class="st-grid is-game is-strip" data-testid="screen-players" data-fixed="tiles"></ul>
        </div>`,
      game: `<div class="sg">
          <div class="sg-play"><div data-region="listen"></div><ul class="st-grid is-game" data-testid="screen-players" data-fixed="tiles"></ul></div>
          <div class="sg-after" data-region="after"></div>
        </div>`,
      won: '<div class="sw" data-region="main"></div>',
    }[m];
    root.innerHTML = `<section class="scr is-m-${m}${idle ? ' is-idle' : ''}" data-testid="screen-display" data-code="${esc(code)}">
      ${bgHtml()}
      ${top}
      <main class="s-body">${body}</main>
      <div class="s-status" data-region="status"></div>
      <button class="scr-fs" type="button" data-action="fullscreen" data-testid="screen-fullscreen" aria-label="Schermvullend" title="Schermvullend">${fsIcon}</button>
    </section>`;
    for (const el of root.querySelectorAll('[data-region]')) { regions[el.dataset.region] = el; keys[el.dataset.region] = null; }
    const fixed = (k) => root.querySelector(`[data-fixed="${k}"]`);
    if (fixed('ball')) { ball = createDiscoBall(fixed('ball'), { categories: CATEGORIES, size: 'auto' }); ball.idle(); }
    if (fixed('stage')) stage = createDiscoStage(fixed('stage'), { big: true, onLand: () => draw() });
    tiles = fixed('tiles');
    seenPlayers = m === 'lobby' ? null : seenPlayers;
    updateFs();
    const h = root.querySelector('h1, h2');
    if (h) h.setAttribute('tabindex', '-1');
  }

  function region(nm, key, build) {
    if (!regions[nm] || keys[nm] === key) return false;
    keys[nm] = key;
    patch(regions[nm], build());
    return true;
  }

  /** Discobingo after the reveal: the answers first, now and then the ranking as its own moment. */
  function discoMoment(v) {
    const d = v.game.disco;
    if (v.phase === 'answering') return stage && !stage.landed ? 'spin' : 'listen';
    const k = `${v.game.round}:${d.cat}`;
    if (reveal.key !== k) reveal = { key: k, at: Date.now(), loaded: k === loadedKey };
    const doubts = (d.doubts || []).length;
    const bingo = (d.progress || []).some((p) => p.bingo) || (v.game.reveal?.roundWinners || []).length > 0;
    const reason = bingo ? 'bingo' : closeOnes(d).length ? 'close' : v.game.round % RANKING_EVERY === 0 ? 'round' : '';
    if (!reason || doubts) return 'answers';
    const wait = reveal.loaded ? RANKING_AFTER_LOAD_MS : bingo ? RANKING_AFTER_BINGO_MS : RANKING_AFTER_MS;
    return Date.now() - reveal.at >= wait ? `ranking:${reason}` : 'answers';
  }

  /** Redraw, then let floats in the air step aside from whatever appeared (the song card at the reveal ...). */
  function draw() {
    drawScreen();
    floats.recheck();
  }

  function drawScreen() {
    if (!regions || !root.isConnected) return;
    const m = modeFor();
    if (m !== mode) { mode = m; skeleton(m); }
    const v = session.view;
    if (v?.game && v.phase !== 'won' && v.phase !== 'lobby') sawLive = true;
    if (v && loadedKey == null) loadedKey = v.phase === 'revealed' && v.game?.disco ? `${v.game.round}:${v.game.disco.cat}` : '';
    const el = root.querySelector('[data-testid="screen-display"]');
    if (!el) return;
    el.dataset.phase = v?.phase || 'none';
    el.dataset.status = session.error ? 'error' : session.status;
    el.dataset.game = v ? (v.game?.kind || v.settings?.game || '') : '';
    el.dataset.leaderAway = String(!!(session.meta && !session.meta.leaderOnline));
    drawStatus(v);
    if (m === 'error') { region('main', JSON.stringify([session.error]), errorHtml); return; }
    if (m === 'boot') { region('main', JSON.stringify([session.status, diagVisible(session.diag, session.status) ? diagKey(session.diag) : '']), bootHtml); return; }
    if (m === 'lobby') { drawLobby(v); return; }
    region('title', JSON.stringify([v.phase, v.game.kind, v.game.round, v.game.quiz?.total, v.game.disco?.win, v.game.size, v.game.goal]), () => titleHtml(v));
    region('badge', code, () => joinBadgeHtml(code));
    if (m === 'disco') drawDisco(v);
    else if (m === 'quiz') drawQuiz(v);
    else if (m === 'game') drawGame(v);
    else if (m === 'won') drawWon(v);
  }

  function drawStatus(v) {
    const st = session.status;
    const meta = session.meta;
    let html = '';
    if (v && !session.error && st !== 'online') {
      const text = { notfound: 'De kamer is even weg. Wachten tot de spelleider terug is…', waking: 'Server wordt wakker…', unreachable: 'Server niet bereikbaar, opnieuw proberen…' }[st] || 'Verbinding kwijt, opnieuw verbinden…';
      const show = diagVisible(session.diag, st);
      html = `<div class="s-pill is-warn" data-testid="screen-status" data-state="${esc(st)}" role="status"><i aria-hidden="true"></i><span>${esc(text)}</span>${show ? `<button class="btn btn-small btn-ghost" type="button" data-action="retry" data-testid="screen-retry">${icons.restart}<span>Nu opnieuw</span></button>` : ''}</div>`;
    } else if (v && meta && !meta.leaderOnline && v.phase !== 'lobby') {
      html = `<div class="s-pill" data-testid="screen-leader-away" role="status"><i aria-hidden="true"></i><span>De spelleider is even weg. Het spel gaat zo verder.</span></div>`;
    } else if (v && meta && !meta.leaderOnline && !meta.waitingForOwner) {
      // (a prepared room the owner has not opened yet is not "away": the lobby's foot line says it calmly)
      html = `<div class="s-pill" data-testid="screen-leader-away" role="status"><i aria-hidden="true"></i><span>De spelleider is even weg.</span></div>`;
    }
    region('status', html, () => html);
  }

  function errorHtml() {
    const e = session.error;
    if (e.code === 'noserver') return noServerHtml();
    const title = ERROR_TITLES[e.code] || 'Dat lukte niet';
    const msg = e.message || 'Het grote scherm kon de kamer niet volgen.';
    const canRetry = e.code !== 'closed' && e.code !== 'expired' && e.code !== 'room';
    return `<div class="scr-msg-box" data-testid="screen-error" data-code="${esc(e.code)}">
      <h2>${esc(title)}</h2>
      <p>${esc(msg)}</p>
      <div class="scr-actions">
        ${canRetry ? `<button class="btn btn-primary" type="button" data-action="retry" data-testid="screen-retry">${icons.restart}<span>Probeer opnieuw</span></button>` : ''}
        <a class="btn btn-ghost" href="#/scherm" data-testid="screen-other-code">${tvIcon}<span>Andere kamercode</span></a>
      </div>
    </div>`;
  }

  function bootHtml() {
    const st = session.status;
    if (st === 'notfound') {
      return `<div class="scr-wait" data-testid="screen-waiting">
        <h1 class="scr-h1">Wachten op kamer <span class="scr-code-inline">${esc(code)}</span>…</h1>
        <p class="scr-p">Maak de kamer op het toestel van de spelleider (<b>Maak een kamer</b>), of controleer de code. Dit scherm zoekt vanzelf verder.</p>
        <a class="btn btn-ghost btn-small" href="#/scherm" data-testid="screen-other-code">Andere kamercode</a>
      </div>`;
    }
    if (diagVisible(session.diag, st)) {
      return `<div class="scr-wait" data-testid="screen-connecting" data-state="${esc(st)}">
        <h1 class="scr-h1">${st === 'unreachable' ? 'Server niet bereikbaar' : st === 'waking' ? 'Server wordt wakker…' : `Verbinden met kamer ${esc(code)}…`}</h1>
        ${diagHtml(session.diag, { role: 'screen', code })}
      </div>`;
    }
    return `<div class="scr-wait" data-testid="screen-connecting" data-state="${esc(st)}">
      <h1 class="scr-h1">Verbinden met kamer <span class="scr-code-inline">${esc(code)}</span>…</h1>
      <p class="scr-p">Even geduld.</p>
    </div>`;
  }

  function drawLobby(v) {
    const s = v.settings;
    region('game', JSON.stringify([s, session.meta?.mix?.total, session.meta?.roomName]), () => `${session.meta?.roomName ? `<p class="sl-room-name" data-testid="screen-room-name">${esc(session.meta.roomName)}</p>` : ''}<div class="sl-game" data-testid="screen-game" data-game="${esc(s.game)}">
      <span class="sl-game-name${s.game === 'disco' ? ' is-disco' : ''}">${esc(gameName(s.game))}</span>
      <span class="sl-game-set">${esc(settingsText(s))}${s.music === 'mix' ? ' · Mix van de groep' : ''}</span>
      ${s.game === 'disco' ? `<span class="sl-cats" aria-hidden="true">${CATEGORIES.map((c) => `<span class="sl-cat cat-${c.key}">${catIcon(c.key)}</span>`).join('')}</span>` : ''}
    </div>`);
    const wait = !!session.meta?.waitingForOwner;
    region('foot', String(wait), () => (wait
      ? `${icons.music}<span data-testid="waiting-for-owner">De spelleider opent de kamer zo. Wie er al is, staat al op het scherm.</span>`
      : `${icons.music}<span>De muziek komt van de spelleider. Het spel begint zodra hij op <b>Start</b> tikt.</span>`));
    const n = v.players.length;
    const off = v.players.filter((p) => !p.online).length;
    region('count', JSON.stringify([n, off]), () => `<h2 class="sl-h" data-testid="screen-count" data-count="${n}" data-offline="${off}">${n ? `<b>${n}</b> ${n === 1 ? 'speler' : 'spelers'} binnen` : 'Wie doet er mee?'}${off ? `<small>${off} offline</small>` : ''}</h2>`);
    region('empty', String(n === 0), () => (n === 0 ? `<div class="sl-empty" data-testid="screen-empty"><span class="sl-ghost"></span><span class="sl-ghost"></span><span class="sl-ghost"></span><p>Nog niemand binnen. Wie is de eerste?</p></div>` : ''));
    // the first list after (re)loading appears without bursts; everybody after that gets one
    const burstOk = seenPlayers != null;
    if (!seenPlayers) seenPlayers = new Set();
    const fresh = v.players.filter((p) => !seenPlayers.has(p.id));
    for (const p of v.players) seenPlayers.add(p.id);
    syncTiles(tiles, v.players, { game: false, burst: burstOk && fresh.length > 0 });
  }

  function drawDisco(v) {
    const g = v.game;
    stage?.sync(g.disco, { now: session.serverNow(), phase: v.phase, round: g.round });
    const moment = discoMoment(v);
    const el = root.querySelector('.sd');
    el.dataset.phase = v.phase;
    el.dataset.moment = moment.split(':')[0];
    root.querySelector('[data-testid="screen-display"]').dataset.moment = moment.split(':')[0];
    const close = closeOnes(g.disco);
    region('ticker', JSON.stringify([v.phase, moment, close.map((p) => p.name)]), () => (v.phase === 'answering' && moment === 'listen' && close.length
      ? `<p class="s-ticker" data-testid="screen-ticker"><span class="s-ticker-kick">Bijna bingo</span><span>${namesList(close.map((p) => p.name))} ${close.length === 1 ? 'heeft' : 'hebben'} nog 1 vakje nodig</span></p>` : ''));
    if (v.phase === 'answering') {
      region('song', '', () => '');
      region('after', '', () => '');
      region('listen', JSON.stringify([moment, g.round, v.players.map((p) => [p.answered, p.playing, p.online])]), () => (moment === 'spin'
        ? '' : `${listenHtml()}${answeredHtml(v)}`));
      syncTiles(tiles, v.players, { game: true, burst: true });
      return;
    }
    region('song', JSON.stringify([g.reveal?.song]), () => `<div data-testid="screen-song">${songHtml(v)}</div>`);
    region('listen', '', () => '');
    const reason = moment.startsWith('ranking') ? moment.split(':')[1] : '';
    // "⚡ Snelste" flashes once, when the answers of a round first appear (not on every later stamp)
    const fk = `${g.round}:${g.disco.cat}`;
    region('after', JSON.stringify([moment, g.reveal, g.disco]), () => {
      const flash = !reason && flashFor !== fk;
      if (!reason) flashFor = fk;
      return reason ? rankingHtml(v, { reason }) : discoAnswersHtml(v, { flash });
    });
  }

  function drawQuiz(v) {
    const g = v.game;
    const q = g.quiz;
    const now = session.serverNow();
    if (v.phase === 'answering') {
      region('quiz', JSON.stringify([v.phase, g.round, q.options, q.deadline, q.answered, q.playing]), () => `${quizQuestionHtml(v, { serverNow: now })}${q.deadline ? '' : listenHtml('Luister… de klok start zodra de muziek speelt')}`);
      tiles.hidden = false;
      syncTiles(tiles, v.players, { game: true, burst: true });
    } else {
      region('quiz', JSON.stringify([v.phase, g.round, q, g.reveal?.song]), () => `<div class="sq-rev">${quizRevealHtml(v)}</div>`);
      tiles.hidden = true;
    }
  }

  function drawGame(v) {
    const g = v.game;
    const el = root.querySelector('.sg');
    el.dataset.phase = v.phase;
    if (v.phase === 'answering') {
      region('after', '', () => '');
      region('listen', JSON.stringify([g.round, v.players.map((p) => [p.answered, p.playing, p.online])]), () => `${listenHtml(g.kind === 'bingo' ? 'Luister… en kies een vakje op je kaart' : 'Luister… waar hoort dit nummer in je tijdlijn?')}${answeredHtml(v)}`);
      syncTiles(tiles, v.players, { game: true, burst: true });
      return;
    }
    region('listen', '', () => '');
    region('after', JSON.stringify([g.reveal, v.players]), () => `<div class="sg-song" data-testid="screen-song">${songHtml(v)}</div>
      <div class="sg-res">${plainAnswersHtml(v)}<section class="sa-stand" data-testid="screen-standings"><h2 class="sa-h">Tussenstand</h2>${standingsHtml(v)}</section></div>`);
  }

  /**
   * The prize ceremony of a won Discobingo with awards: { step: winner | award | overview, idx,
   * awards }, or null. Timed from when this display saw the game being won; a display that came
   * in at the end (a reload) goes straight to the overview, never a replay.
   */
  function ceremony(v) {
    const awards = v.game.kind === 'disco' ? v.game.disco?.awards || [] : [];
    if (!awards.length) return null;
    const k = JSON.stringify([v.game.winnerIds, v.game.round, awards.map((a) => a.kind)]);
    if (cer.k !== k) { clearTimeout(cer.timer); cer = { k, start: sawLive ? Date.now() : -Infinity, timer: 0, stepKey: '' }; }
    const t = Date.now() - cer.start;
    const n = awards.length;
    let step = 'overview';
    let idx = -1;
    let next = null;
    if (t < CEREMONY_WINNER_MS) { step = 'winner'; next = CEREMONY_WINNER_MS - t; } else if (t < CEREMONY_WINNER_MS + n * CEREMONY_AWARD_MS) {
      step = 'award';
      idx = Math.floor((t - CEREMONY_WINNER_MS) / CEREMONY_AWARD_MS);
      next = CEREMONY_WINNER_MS + (idx + 1) * CEREMONY_AWARD_MS - t;
    }
    if (next != null && !cer.timer) cer.timer = setTimeout(() => { cer.timer = 0; draw(); }, next + 20);
    return { step, idx, awards };
  }

  function drawWon(v) {
    const g = v.game;
    const c = ceremony(v);
    // the confetti lives inside the winner block (behind it); a redraw restarts it only when the result changes
    const fresh = region('main', JSON.stringify([g.winners, g.quiz?.ranking, g.disco?.progress, g.disco?.awards, v.players]), () => confettiHtml() + (() => {
      const names = g.winners || [];
      if (g.kind === 'quiz') return `<div class="sw-quiz" data-testid="screen-winner" data-names="${esc(names.join('|'))}">${quizPodiumHtml(v)}</div>`;
      const win = names.length ? winnerHtml(v) : '<div class="winner" data-testid="room-winner"><h2 class="winner-name" data-testid="room-winner-name">Het spel is afgelopen</h2></div>';
      const rank = g.kind === 'disco' ? rankingHtml(v, { reason: 'won', limit: 10 }) : `<section class="sa-stand" data-testid="screen-standings"><h2 class="sa-h">Eindstand</h2>${standingsHtml(v)}</section>`;
      return `<div class="sw-in${c ? ' has-cer' : ''}" data-testid="screen-winner" data-names="${esc(names.join('|'))}"${c ? ` data-step="${c.step}"` : ''}>
        <div class="sw-hero">${g.kind === 'disco' && names.length && g.endedBy !== 'pile' ? '<p class="sw-bingo" aria-hidden="true">BINGO!</p>' : ''}${win}<p class="sw-next">Nog een potje? De spelleider start zo.</p></div>
        <div class="sw-rank">${rank}</div>
        ${c ? `<div class="sw-cer" data-testid="screen-ceremony" data-step="${c.step}" data-award="${c.idx}" data-n="${c.awards.length}"><div class="sw-cer-in"></div></div>` : ''}
      </div>`;
    })());
    if (!c) return;
    // the steps only change the side of the stage: the winner (and its confetti) stays as it is
    const key = `${c.step}|${c.idx}|${JSON.stringify(c.awards)}`;
    if (!fresh && cer.stepKey === key) return;
    cer.stepKey = key;
    const inEl = root.querySelector('.sw-in');
    const stage = root.querySelector('[data-testid="screen-ceremony"]');
    if (!inEl || !stage) return;
    inEl.dataset.step = c.step;
    stage.dataset.step = c.step;
    stage.dataset.award = String(c.idx);
    patch(stage.firstElementChild, c.step === 'award' ? awardSpotHtml(c.awards[c.idx], c.idx, c.awards.length)
      : c.step === 'overview' ? `<section class="sw-prizes" data-testid="screen-awards-box"><h2 class="sa-h sw-prizes-h"><span aria-hidden="true">🏅</span> Prijzen</h2>${awardsListHtml(c.awards, { testid: 'screen-awards', itemTestid: 'screen-award-item', cls: 'is-tv' })}</section>` : '');
  }

  // ---------- fullscreen, the idle cursor ----------
  const fsEnabled = () => !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  function updateFs() {
    const b = root.querySelector('[data-testid="screen-fullscreen"]');
    if (b) b.hidden = !fsEnabled() || !!document.fullscreenElement;
  }
  let idleTimer = 0;
  let idle = false; // no mouse for a while: the cursor and the fullscreen button hide (kept over a rebuild)
  function wake() {
    idle = false;
    root.querySelector('.scr')?.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idle = true; root.querySelector('.scr')?.classList.add('is-idle'); }, IDLE_CURSOR_MS);
  }

  function onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a || !root.contains(a)) return;
    if (a.dataset.action === 'fullscreen') { document.documentElement.requestFullscreen?.().catch(() => {}); return; }
    if (a.dataset.action === 'retry') { session.retry(); draw(); return; }
    if (a.dataset.action === 'copy-diag') session.copyDiag?.();
  }
  root.addEventListener('click', onClick);
  document.addEventListener('fullscreenchange', updateFs);
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('keydown', wake);

  const releaseAwake = keepAwake();
  const unsub = session.subscribe(() => draw());
  draw();
  session.start();
  wake();
  // seconds for the diagnosis, and the ranking moment after a reveal (the display is passive: timers)
  const ticker = setInterval(() => {
    if (session.diag && diagVisible(session.diag, session.status)) draw();
    else if (mode === 'disco' && session.view?.phase === 'revealed') draw();
  }, 1000);
  const quizTicker = setInterval(() => {
    if (mode === 'quiz' && session.view?.phase === 'answering') tickQuizClocks(root, session.serverNow());
  }, 250);

  window.__ttScreen = { get session() { return session; } };

  return () => {
    root.removeEventListener('click', onClick);
    document.removeEventListener('fullscreenchange', updateFs);
    window.removeEventListener('pointermove', wake);
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
    clearTimeout(idleTimer);
    clearInterval(ticker);
    clearInterval(quizTicker);
    clearTimeout(cer.timer);
    offReact?.();
    floats.destroy();
    releaseAwake();
    unsub();
    stage?.destroy();
    ball?.destroy();
    session.leave(); // the server counts one display less right away
    document.documentElement.classList.remove('tt-screen');
    document.title = prevTitle;
    delete window.__ttScreen;
  };
}
