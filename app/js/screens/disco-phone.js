// Discobingo on a player's phone: one full-screen moment at a time.
//
//   spin -> splash -> question -> submitted -> verdict -> choose | card -> (bingo) -> winner
//
// room-player.js hands the screen to this module while a Discobingo game runs (answering,
// revealed, won); the join form and the lobby stay there. The moment is derived from the
// server's view plus a little local state: when the ball landed here (the splash), which
// verdict this phone already showed for this round (kept in sessionStorage, so a reload does
// not replay it), whether "Wijzig" was tapped. A reload or reconnect therefore lands on the
// right moment for the phase without replaying animations that are long past.
// Persistent chrome is a slim bar (code, connection dot, round, menu); everything else
// (Stand, Mijn kaart, Wat iedereen antwoordde, Mix van de groep, Verlaat) lives in a bottom
// sheet. Styles: css/disco-phone.css.
import { categoryOf, squaresToGo } from '../multi/disco.js';
import {
  createDiscoStage, discoCardHtml, catIcon, catChip, answerWords, resultWords, discoResultsHtml,
  proposedAnswer, sameAnswer, verdictOf, winText, QUESTION, HINT, isWinner, autoTimerHtml, tickAutoTimers,
  bingoWhoText, winnerCardHtml, stagesHtml,
} from './room-disco.js';
import { patch, winnerHtml, confettiHtml, leaderAwayHtml, diagHtml } from './room-ui.js';
import { icons, esc, vibrate } from '../ui.js';
import { avatarHtml, streakMark, jokerMark, awardsListHtml, myAwardsLine } from './party-ui.js';

const SPLASH_MS = 1100;
const VERDICT_MS = 2300;
const TOAST_MS = 3800;
const SEEN_KEY = 'timetunesr.discoSeen.v1'; // sessionStorage: { k, v, bingo } of the running round
const TOAST_KEY = 'timetunesr.discoToast.v1'; // sessionStorage: { r, ids } of the last "spannend" toast
const STREAK_KEY = 'timetunesr.discoStreak.v1'; // sessionStorage: { k, n } the streak going into the running round ("Reeks voorbij")
const WIN_KEY = 'timetunesr.discoWin.v1'; // sessionStorage: the game end whose celebration was shown (a reload goes to the prizes)
const CHIPS_KEY = 'timetunesr.discoJokerChips.v1'; // localStorage: { sig, r: {round: index} } chips placed with a joker on this card
/** The verdict stays longer when there is something to celebrate (a streak, a joker, snelste). */
const VERDICT_EXTRA_MS = 1500;
/** The winner celebration on its own, before the prizes join it. */
const WIN_CELEBRATE_MS = 3200;
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const ss = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const yearCat = (cat) => cat === 'year' || cat === 'exact';

const CONN_TEXT = {
  idle: 'Verbinden…',
  connecting: 'Verbinden…',
  reconnecting: 'Verbinding kwijt, opnieuw proberen…',
  notfound: 'Kamer even weg, opnieuw proberen…',
  closed: 'Niet verbonden',
  waking: 'Server wordt wakker…',
  unreachable: 'Server niet bereikbaar, opnieuw proberen…',
};

const dots = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2.1" fill="currentColor"/><circle cx="12" cy="12" r="2.1" fill="currentColor"/><circle cx="19" cy="12" r="2.1" fill="currentColor"/></svg>';
const gridIco = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="currentColor"><rect x="3.5" y="3.5" width="4.6" height="4.6" rx="1.2"/><rect x="9.7" y="3.5" width="4.6" height="4.6" rx="1.2"/><rect x="15.9" y="3.5" width="4.6" height="4.6" rx="1.2"/><rect x="3.5" y="9.7" width="4.6" height="4.6" rx="1.2"/><circle cx="12" cy="12" r="2.6"/><rect x="15.9" y="9.7" width="4.6" height="4.6" rx="1.2"/><rect x="3.5" y="15.9" width="4.6" height="4.6" rx="1.2"/><rect x="9.7" y="15.9" width="4.6" height="4.6" rx="1.2"/><rect x="15.9" y="15.9" width="4.6" height="4.6" rx="1.2"/></g></svg>';
const chatIco = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5H4.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const exitIco = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10 4.5H5.5v15H10M14 8l4 4-4 4M18 12H9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const catName = (key) => categoryOf(key)?.label || '';
const catShort = (key) => categoryOf(key)?.short || '';

/** "Nog 2 voor een lijn" / "Nog 1 vakje voor bingo!" */
export function toGoText(n, win) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n <= 0) return 'BINGO!';
  if (n === 1) return 'Nog 1 vakje voor bingo!';
  return `Nog ${n} voor ${win === 'full' ? 'een volle kaart' : win === 'line2' ? '2 lijnen' : 'een lijn'}`;
}

/**
 * getSession(): the player session; send(answer), stamp(index), leave(): the actions;
 * mixHtml(): the mix panel (or null when there is none); serverNow(): server clock.
 */
export function createDiscoPhone({ getSession, send, stamp, leave, mixHtml = () => null, serverNow = () => Date.now(), reactBar = null }) {
  let el = null;
  const parts = {};
  let stage = null;
  let momentId = null;
  let moment = null;
  const partKeys = {};
  let splash = { k: null, until: 0 };
  let edit = null; // round key while "Wijzig" is open
  let local = { k: null, value: null };
  let shown = { k: null, v: null, until: 0 }; // the verdict on screen
  let seen = ss.get(SEEN_KEY) || {};
  let sheet = null; // null | 'menu' | 'stand' | 'card' | 'answers' | 'mix' | 'leave'
  let sheetClear = 0;
  let toastSeen = ss.get(TOAST_KEY) || { r: null, ids: '' };
  let toastQueue = null;
  let toastTimer = 0;
  const timers = new Set();
  let focusFor = null;
  let lastBingo = false;
  let phaseKey = null;
  let streakIn = ss.get(STREAK_KEY) || { k: null, n: 0 }; // the streak this phone saw going into the round
  let jok = { k: null, on: false }; // "Zet joker in" switched on for this round
  let win = { k: null, until: 0 }; // the winner celebration (then the prizes)
  let reactOn = null;
  let sawPlay = false; // this page saw the game running (not only its end, as after a reload)

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  // the shared countdown to the automatic reveal moves on between server messages
  const autoTick = setInterval(() => { if (el) tickAutoTimers(el, serverNow()); }, 250);
  const view = () => getSession()?.view || null;
  const rk = (v) => `${v.code}|${v.game?.disco?.spunAt ?? ''}|${v.game?.round ?? ''}`;

  function sentAnswer(v) {
    const g = v.game;
    if (g.answer) return g.answer;
    const p = getSession()?.pending;
    return p && p.round === g.round ? p.answer : null;
  }
  function myVerdict(v) {
    const r = v.game.reveal?.mine;
    if (!r) return null;
    return v.game.disco.waitingForHost ? 'doubt' : verdictOf(r);
  }
  function myToGo(v) {
    const g = v.game;
    if (!g.mine) return null;
    const p = (g.disco.progress || []).find((x) => x.id === v.you?.id);
    return Number.isFinite(p?.toGo) ? p.toGo : squaresToGo(g.mine.marks, g.disco.win);
  }

  /* ---------- which moment is it ---------- */
  function momentOf(v) {
    const g = v.game;
    const d = g.disco;
    if (v.phase === 'won') return 'winner';
    const k = rk(v);
    if (v.phase === 'answering') {
      if (stage && !stage.landed) return 'spin';
      if (splash.k === k && Date.now() < splash.until) return 'splash';
      if (!g.mine) return 'card';
      if (sentAnswer(v) && edit !== k) return 'submitted';
      return 'question';
    }
    // revealed
    const vv = g.mine ? myVerdict(v) : null;
    if (vv) {
      if (seen.k !== k) seen = { k, v: null, bingo: false, stop: null };
      if (seen.v !== vv) {
        seen.v = vv;
        ss.set(SEEN_KEY, seen);
        const x = verdictExtras(v, vv);
        const ms = VERDICT_MS + (x.fast || x.streak || x.joker ? VERDICT_EXTRA_MS : 0);
        shown = { k, v: vv, until: Date.now() + ms };
        if (vv !== 'doubt') later(draw, ms + 30);
        vibrate(vv === 'right' ? [30, 50, 30] : vv === 'wrong' ? [90] : 20);
      }
    }
    // a bingo stops the game on every phone at once: the winner gets the BINGO moment, who may
    // still lay a chip this round chooses first, everybody else sees who has bingo
    const b = d.bingo;
    if (b) {
      if (seen.k !== k) seen = { k, v: vv, bingo: false, stop: null };
      if (isWinner(v)) return seen.bingo ? 'card' : 'bingo';
      if (vv === 'doubt') return 'verdict';
      const choosing = !!g.reveal?.mine?.correct && !d.waitingForHost && d.choice == null && (d.choosable?.length > 0 || jokerActive(v));
      if (choosing) return 'choose';
      return seen.stop === b.win ? 'card' : 'stop';
    }
    if (vv === 'doubt') return 'verdict';
    if (vv && shown.k === k && shown.v === vv && Date.now() < shown.until) return 'verdict';
    if (g.reveal?.mine?.correct && !d.waitingForHost && (d.choosable?.length || jokerActive(v))) return 'choose';
    return 'card';
  }

  /* ---------- the joker (Discobingo) ---------- */
  /** Does the own chip of this round lie on a square of another colour (a joker in use)? */
  function chipOnJoker(v) {
    const g = v.game;
    const d = g.disco;
    return v.phase === 'revealed' && !!g.reveal?.mine?.correct && Number.isInteger(d.choice) && !!g.mine && g.mine.card[d.choice] !== d.cat;
  }
  /** The card shows the joker squares: switched on here, or the chip already lies on one. */
  function jokerActive(v) {
    const d = v.game.disco;
    if (!(d.jokerSquares || []).length || d.waitingForHost) return false;
    return (jok.k === rk(v) && jok.on) || chipOnJoker(v);
  }
  /** Squares that carry a chip placed with a joker (this round, and earlier rounds this phone saw). */
  function jokerChips(v) {
    const g = v.game;
    if (!g.mine) return [];
    const sig = g.mine.card.join(',');
    let rec = ls.get(CHIPS_KEY);
    if (!rec || rec.sig !== sig || typeof rec.r !== 'object' || !rec.r) rec = { sig, r: {} };
    if (v.phase === 'revealed') {
      const d = g.disco;
      const want = chipOnJoker(v) && g.mine.marks[d.choice] != null ? d.choice : null;
      const had = rec.r[g.round] ?? null;
      if (want !== had) {
        if (want == null) delete rec.r[g.round]; else rec.r[g.round] = want;
        ls.set(CHIPS_KEY, rec);
      }
    }
    return Object.values(rec.r).filter((i) => Number.isInteger(i) && g.mine.marks[i] != null);
  }
  /** The streak going into this round (kept while answering; null when this phone did not see it). */
  function streakBefore(v) {
    return streakIn.k === rk(v) ? streakIn.n : null;
  }
  /** What there is to celebrate on the verdict (or the streak that just ended). */
  function verdictExtras(v, vv) {
    const g = v.game;
    const fast = !!v.you && g.disco.fastest?.id === v.you.id;
    const st = g.mine?.streak || 0;
    const before = streakBefore(v);
    return {
      fast: vv === 'right' && fast,
      streak: vv === 'right' && st >= 2 ? st : 0,
      joker: vv === 'right' && !!g.mine?.jokerEarned,
      over: ['wrong', 'pass', 'none'].includes(vv) && before != null && before >= 2 ? before : 0,
    };
  }

  /* ---------- mount ---------- */
  function html(code) {
    return `<section class="screen ph" data-testid="screen-room-player" data-view="answering" data-code="${esc(code)}" data-moment="">
      <header class="ph-bar">
        <span class="ph-code" data-testid="room-code" aria-label="Kamercode">${esc(code)}</span>
        <span class="conn ph-conn" data-testid="conn-status" data-state="connecting" role="status"><i aria-hidden="true"></i><span class="sr-only">Verbinden…</span></span>
        <span class="ph-round" data-testid="room-round"></span>
        <span class="ph-jokers" data-testid="disco-jokers" data-jokers="0" hidden></span>
        <button class="ph-menu-btn" type="button" data-action="ph-menu" data-testid="disco-menu" aria-label="Menu" aria-haspopup="dialog" aria-expanded="false">${dots}</button>
      </header>
      <div class="ph-banner" data-region="status"></div>
      <div class="ph-stage">
        <div class="ph-ball" aria-hidden="false"></div>
        <div class="ph-fx" aria-hidden="true"></div>
        <div class="ph-moment-host"></div>
      </div>
      <div class="ph-react" data-part="react" hidden></div>
      <div class="ph-toast" data-testid="disco-toast" role="status" aria-live="polite" hidden></div>
      <div class="ph-sheet-wrap">
        <div class="ph-scrim" data-action="ph-close"></div>
        <section class="ph-sheet" data-testid="disco-sheet" data-page="" role="dialog" aria-modal="true" aria-label="Menu"></section>
      </div>
    </section>`;
  }

  function mount(section) {
    el = section;
    parts.bar = el.querySelector('.ph-bar');
    parts.conn = el.querySelector('.ph-conn');
    parts.round = el.querySelector('.ph-round');
    parts.menuBtn = el.querySelector('.ph-menu-btn');
    parts.ball = el.querySelector('.ph-ball');
    parts.host = el.querySelector('.ph-moment-host');
    parts.fx = el.querySelector('.ph-fx');
    parts.toast = el.querySelector('.ph-toast');
    parts.wrap = el.querySelector('.ph-sheet-wrap');
    parts.sheet = el.querySelector('.ph-sheet');
    parts.status = el.querySelector('[data-region="status"]');
    parts.jokers = el.querySelector('.ph-jokers');
    parts.react = el.querySelector('.ph-react');
    reactOn = null;
    momentId = null;
    moment = null;
    sheet = null;
    phaseKey = null;
  }

  function onLandLive() {
    const v = view();
    if (!v || v.phase !== 'answering') { draw(); return; }
    splash = { k: rk(v), until: Date.now() + SPLASH_MS };
    vibrate(25);
    later(draw, SPLASH_MS + 30);
    draw();
  }

  /* ---------- draw ---------- */
  function draw() {
    const s = getSession();
    const v = s?.view;
    if (!el || !v?.game || v.game.kind !== 'disco') return;
    const g = v.game;
    const d = g.disco;
    el.dataset.view = v.phase;
    // the reveal and a new spin are moments nobody should miss: the menu steps aside (not mid-mix or mid-leave)
    const pk = `${v.phase}|${g.round}`;
    if (phaseKey && pk !== phaseKey && sheet && !['mix', 'leave'].includes(sheet)) closeSheet();
    phaseKey = pk;
    if (v.phase !== 'won' && d?.cat) {
      if (!stage) stage = createDiscoStage(parts.ball, { onLand: onLandLive });
      stage.sync(d, { now: serverNow(), phase: v.phase, round: g.round });
    }
    if (v.phase === 'answering' && g.mine && streakIn.k !== rk(v)) { streakIn = { k: rk(v), n: g.mine.streak || 0 }; ss.set(STREAK_KEY, streakIn); }
    if (jok.k !== rk(v)) jok = { k: rk(v), on: false };
    if (v.phase !== 'won') sawPlay = true;
    const m = momentOf(v);
    const cat = v.phase === 'won' ? '' : d.cat || '';
    el.dataset.moment = m;
    el.dataset.cat = cat;
    bar(v, s.status);
    const vv = m === 'verdict' ? myVerdict(v) : '';
    const id = `${m}|${vv}|${rk(v)}`;
    if (id !== momentId) {
      const first = momentId == null;
      momentId = id;
      moment = m;
      if ((m === 'bingo' || m === 'stop') && !lastBingo) vibrate(m === 'bingo' ? [60, 40, 60, 40, 220] : [40, 40, 40]);
      lastBingo = m === 'bingo' || m === 'stop';
      parts.host.innerHTML = skeletonHtml(m, v, vv, first);
      // confetti on its own layer under the moment: it never falls over text or buttons
      parts.fx.innerHTML = m === 'bingo' || m === 'stop' || m === 'winner' ? confettiHtml() : '';
      for (const k of Object.keys(partKeys)) delete partKeys[k];
      for (const p of ['head', 'main', 'foot']) parts[p] = parts.host.querySelector(`[data-part="${p}"]`);
    }
    const built = BUILD[m](v);
    for (const p of ['head', 'main', 'foot']) {
      const h = built[p] || '';
      // a part may name its own key: the question's field must not be re-rendered while typing
      const key = built.keys?.[p] ?? h;
      if (parts[p] && partKeys[p] !== key) { partKeys[p] = key; patch(parts[p], h); }
    }
    if (m === 'question') focusQuestion(v);
    drawReact(v, m);
    drawSheet(v);
    excitement(v, m);
  }

  /** The reaction bar: from the submitted moment on and after the reveal (never on the question). */
  function drawReact(v, m) {
    const s = getSession();
    const on = !!reactBar && !!s?.supports?.('party') && !!v.you && (m === 'submitted' || m === 'winner' || (v.phase === 'revealed' && (m === 'card' || m === 'choose')));
    if (on === reactOn) return;
    reactOn = on;
    el.dataset.react = on ? 'on' : 'off';
    parts.react.hidden = !on;
    parts.react.innerHTML = on ? reactBar.html({ cls: 'ph-rxbar' }) : '';
  }

  function bar(v, st) {
    const online = st === 'online';
    const state = st || 'connecting';
    if (parts.conn.dataset.state !== state) {
      parts.conn.dataset.state = state;
      parts.conn.lastElementChild.textContent = online ? 'Verbonden' : CONN_TEXT[state] || state;
    }
    const r = v.phase === 'won' ? 'uitslag' : `ronde ${v.game.round}`;
    if (parts.round.textContent !== r) parts.round.textContent = r;
    // the jokers in hand (as they stand: during a question up to the last round)
    const n = v.phase === 'won' ? 0 : v.game.mine?.jokers || 0;
    if (parts.jokers.dataset.jokers !== String(n)) {
      const more = Number(parts.jokers.dataset.jokers) < n;
      parts.jokers.dataset.jokers = String(n);
      parts.jokers.hidden = n < 1;
      parts.jokers.innerHTML = n ? `${'<i class="ph-joker-chip" aria-hidden="true">🃏</i>'.repeat(n)}<span class="sr-only">${n === 1 ? '1 joker' : `${n} jokers`}</span>` : '';
      parts.jokers.setAttribute('aria-label', n === 1 ? 'Je hebt 1 joker' : `Je hebt ${n} jokers`);
      if (more) { parts.jokers.classList.remove('is-new'); void parts.jokers.offsetWidth; parts.jokers.classList.add('is-new'); }
    }
  }

  /** The banner over the current moment: connection trouble, leader away, the diagnosis. */
  function statusHtml(st, away, showDiag, meta, diag, code) {
    let out = '';
    if (st && st !== 'online') out += `<p class="ph-banner-conn" data-state="${esc(st)}"><i aria-hidden="true"></i><span>${esc(CONN_TEXT[st] || st)}</span></p>`;
    if (away != null) out += leaderAwayHtml(meta, { awayMs: away });
    if (showDiag) out += diagHtml(diag, { role: 'player', code });
    return out;
  }

  function skeletonHtml(m, v, vv, first) {
    // first paint after a reload: no entrance animation, the moment is simply there
    const enter = first ? '' : ' is-enter';
    const fx = m === 'verdict' && vv === 'right' ? '<div class="ph-burst" aria-hidden="true"></div>' : '';
    const cls = m === 'verdict' ? ` is-${vv}` : '';
    const tap = m === 'verdict' && vv !== 'doubt' ? ' data-action="ph-next"' : m === 'bingo' ? ' data-action="ph-bingo-done"' : m === 'stop' ? ' data-action="ph-stop-done"' : '';
    return `<div class="ph-moment ph-m-${m}${cls}${enter}" data-testid="disco-moment" data-moment="${m}"${tap}>
      ${fx}<div class="ph-part ph-head" data-part="head"></div><div class="ph-part ph-main" data-part="main"></div><div class="ph-part ph-foot" data-part="foot"></div>
    </div>`;
  }

  /* ---------- the moments ---------- */
  const BUILD = {
    spin() {
      return { foot: '<p class="ph-spin-text" data-testid="disco-wait"><b>De discobal draait…</b><span>Welke vraag wordt het?</span></p>' };
    },
    splash(v) {
      const cat = v.game.disco.cat;
      return { main: `<div class="ph-splash cat-${esc(cat)}" data-testid="disco-splash" data-cat="${esc(cat)}"><span class="ph-splash-ico">${catIcon(cat)}</span><b class="ph-splash-name">${esc(catName(cat))}</b></div>` };
    },
    question: questionParts,
    submitted: submittedParts,
    verdict: verdictParts,
    choose: cardParts,
    card: cardParts,
    bingo(v) {
      const g = v.game;
      return {
        main: `<p class="ph-bingo-word" data-testid="disco-bingo" role="status">BINGO!</p>
          <p class="ph-bingo-sub">Je hebt ${esc(winText(g.disco.win))}!</p>
          ${discoCardHtml(g.mine, { testid: 'disco-bingo-card', name: v.you?.name, jokerChips: jokerChips(v) })}`,
        foot: `<p class="ph-line" data-testid="disco-bingo-wait">Je fiche ligt vast. Het spel staat stil: de spelleider kiest of het doorgaat.</p>
          <button class="btn btn-ghost ph-small-btn" type="button" data-action="ph-bingo-done" data-testid="disco-bingo-card-btn">${gridIco}<span>Bekijk je kaart</span></button>`,
      };
    },
    /** Somebody else has bingo: the game stops here too, with who and their card. */
    stop(v) {
      const b = v.game.disco.bingo;
      const first = b?.winners?.[0];
      return {
        keys: { main: JSON.stringify([b]) },
        main: `<p class="ph-bingo-word is-other" data-testid="disco-stop-word" role="status">BINGO!</p>
          <p class="ph-bingo-sub" data-testid="disco-stop-who">${esc(bingoWhoText(b))}</p>
          ${first ? `<div class="ph-stop-card">${winnerCardHtml(first, { testid: 'disco-stop-card' })}</div>` : ''}`,
        foot: `<p class="ph-line ph-calm" data-testid="disco-stop-wait"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>Het spel staat stil. De spelleider kiest: doorgaan of stoppen.</p>
          <button class="btn btn-ghost ph-small-btn" type="button" data-action="ph-stop-done" data-testid="disco-stop-card-btn">${gridIco}<span>Bekijk je kaart</span></button>`,
      };
    },
    winner(v) {
      const g = v.game;
      const me = v.you && (g.winnerIds || []).includes(v.you.id);
      const prog = (g.disco?.progress || []);
      const mine = prog.find((p) => p.id === v.you?.id);
      const place = mine ? 1 + prog.filter((p) => better(p, mine)).length : null;
      const awards = g.disco?.awards || [];
      // the celebration first; then the prizes join it (straight away after a reload)
      const prizes = awards.length && winStep(v) === 'prizes';
      return {
        keys: { main: JSON.stringify([g.winners, me, mine, prizes, awards]) },
        main: `<div class="ph-winner${me ? ' is-me' : ''}${prizes ? ' is-compact' : ''}" data-testid="disco-win-step" data-step="${prizes ? 'prizes' : 'winner'}">${winnerHtml(v)}</div>
          ${me ? '<p class="ph-won-you" data-testid="room-you-won">Gefeliciteerd, jij hebt gewonnen!</p>' : ''}
          ${(g.disco?.stages || []).length > 1 ? stagesHtml(g.disco, { testid: 'disco-win-stages' }) : ''}
          ${mine && !me ? `<p class="ph-line ph-place" data-testid="disco-place">Jij: ${place}e plaats · ${mine.stamped} ${mine.stamped === 1 ? 'vakje' : 'vakjes'} · ${mine.lines} ${mine.lines === 1 ? 'lijn' : 'lijnen'}</p>` : ''}
          ${prizes ? `<section class="ph-prizes" data-testid="disco-prizes" aria-label="Prijzen"><h2 class="ph-prizes-h"><span aria-hidden="true">🏅</span> Prijzen</h2>${myAwardsLine(awards, v.you?.id)}${awardsListHtml(awards, { you: v.you?.id, testid: 'disco-awards', itemTestid: 'disco-award', cls: 'is-phone' })}</section>` : ''}`,
        foot: `<button class="btn btn-ghost ph-small-btn" type="button" data-action="ph-sheet" data-page="stand" data-testid="disco-winner-stand">${icons.trophy}<span>Bekijk de stand</span></button>
          <p class="ph-line ph-calm" data-testid="room-next-wait"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>Wachten op een nieuw potje…</p>`,
      };
    },
  };

  /** The winner moment: 'winner' (the celebration, once, live) or 'prizes'. */
  function winStep(v) {
    const k = `${v.code}|${(v.game.winnerIds || []).join(',')}|${v.game.round}`;
    if (win.k !== k) {
      const seenWin = ss.get(WIN_KEY) === k;
      // a phone that saw the game being won celebrates first; a reload goes straight to the prizes
      win = { k, until: seenWin || !sawPlay ? 0 : Date.now() + WIN_CELEBRATE_MS };
      ss.set(WIN_KEY, k);
      if (win.until) later(draw, WIN_CELEBRATE_MS + 30);
    }
    return Date.now() < win.until ? 'winner' : 'prizes';
  }

  function questionHead(cat) {
    return `<div class="ph-qhead cat-${esc(cat)}" data-testid="disco-category-head"><span class="ph-qhead-ico">${catIcon(cat)}</span><b>${esc(catName(cat))}</b></div>`;
  }

  function questionParts(v) {
    const g = v.game;
    const d = g.disco;
    const cat = d.cat;
    const k = rk(v);
    if (local.k !== k) local = { k, value: null };
    const sent = sentAnswer(v);
    const sending = !!getSession()?.pending;
    let input;
    if (yearCat(cat)) {
      const val = local.value ?? (sent?.guess != null ? String(sent.guess) : '');
      input = `<input id="ph-input" class="ph-input ph-year" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="19··" value="${esc(val)}" data-testid="disco-year-input" aria-label="${cat === 'exact' ? 'Exact jaar' : 'Jaartal'}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">`;
    } else {
      const val = local.value ?? (sent?.text ?? '');
      input = `<input id="ph-input" class="ph-input" type="text" maxlength="60" placeholder="${cat === 'artist' ? 'Artiest of band' : 'Titel'}" value="${esc(val)}" data-testid="disco-text-input" aria-label="${cat === 'artist' ? 'Artiest of band' : 'Titel'}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">`;
    }
    const hint = HINT[cat];
    return {
      keys: { main: JSON.stringify([k, cat, sent, edit === k, sending]) },
      head: questionHead(cat),
      main: `<div class="ph-q disco-answer" data-testid="disco-answer" data-cat="${esc(cat)}">
        <label class="ph-q-line" for="ph-input">${esc(QUESTION[cat])}</label>
        ${hint ? `<p class="ph-q-hint${cat === 'exact' ? ' is-exact' : ''}" data-testid="disco-hint">${esc(hint)}</p>` : ''}
        ${input}
        ${stateLine(v, sent)}
        ${lockButton(v, sending)}
        <button class="ph-pass" type="button" data-action="ph-pass" data-testid="disco-pass" ${sent?.pass && edit !== k ? 'disabled' : ''}>Weet ik niet</button>
      </div>`,
      foot: '<p class="ph-listen" data-testid="listen-hint"><span class="ph-eq is-small" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>Luister naar de muziek</p>',
    };
  }

  /** While "Wijzig" is open: what is in now. */
  function stateLine(v, sent) {
    const editing = edit === rk(v) && sent;
    const proposed = currentProposal(v);
    const state = !editing ? 'none' : sent.pass ? 'pass' : proposed && !sameAnswer(proposed, sent) ? 'changed' : 'locked';
    return `<p class="ph-q-now" data-testid="disco-answer-state" data-state="${state}"${editing ? '' : ' hidden'}>${editing ? `Nu ingediend: <b>${esc(answerWords(sent))}</b>` : ''}</p>`;
  }
  function currentProposal(v) {
    const cat = v.game.disco.cat;
    const sent = sentAnswer(v);
    const val = local.value ?? (yearCat(cat) ? (sent?.guess != null ? String(sent.guess) : '') : sent?.text ?? '');
    return proposedAnswer(cat, val);
  }
  function lockButton(v, sending) {
    const ok = !!currentProposal(v) && !sending;
    return `<button class="btn btn-primary btn-xl ph-lock" type="button" data-action="ph-lock" data-testid="disco-lock" ${ok ? '' : 'disabled'}>${sending ? 'Versturen…' : 'Indienen'}</button>`;
  }

  function counts(v) {
    // only players who are here count: an away phone is never somebody we wait for
    const here = v.players.filter((p) => p.playing && p.online);
    return { answered: here.filter((p) => p.answered).length, total: here.length };
  }

  function submittedParts(v) {
    const cat = v.game.disco.cat;
    const sent = sentAnswer(v);
    const { answered, total } = counts(v);
    const all = total > 0 && answered >= total;
    const words = sent?.pass ? 'Weet ik niet' : sent?.guess != null ? String(sent.guess) : sent?.text != null ? `“${sent.text}”` : '';
    const d = v.game.disco;
    return {
      // the countdown key is its own moment on the server clock: a redraw does not restart it
      keys: { foot: JSON.stringify([answered, total, sent?.pass, d.autoAt]) },
      head: questionHead(cat),
      main: `<div class="ph-sub">
        <span class="ph-sub-check" aria-hidden="true">${icons.check}</span>
        <p class="ph-kicker">${sent?.pass ? 'Doorgegeven' : 'Antwoord binnen'}</p>
        <p class="ph-sub-answer${sent?.pass ? ' is-pass' : ''}" data-testid="disco-answer-state" data-state="${sent?.pass ? 'pass' : 'locked'}">${esc(words)}</p>
        <div class="ph-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      </div>`,
      foot: `<p class="ph-count${all ? ' is-all' : ''}" data-testid="disco-answered" data-answered="${answered}" data-total="${total}">${all ? 'Iedereen heeft geantwoord!' : `${answered} van ${total} ${total === 1 ? 'heeft' : 'hebben'} geantwoord`}</p>
        ${autoTimerHtml(d, serverNow(), { testid: 'disco-auto' })}
        <button class="ph-edit" type="button" data-action="ph-edit" data-testid="disco-edit">${sent?.pass ? 'Toch een idee?' : 'Wijzig'}</button>`,
    };
  }

  function songHtml(v, cls = '') {
    const s = v.game.reveal?.song;
    if (!s) return '';
    const by = Array.isArray(s.by) && s.by.length ? `<small class="ph-song-by" data-testid="room-song-by">uit de favorieten van ${s.by.map(esc).join(' &amp; ')}</small>` : '';
    return `<div class="ph-song ${cls}" data-testid="disco-song"><b class="ph-song-year">${esc(s.year)}</b><span class="ph-song-artist">${esc(s.artist)}</span><span class="ph-song-title">${esc(s.title)}</span>${by}</div>`;
  }

  function explainText(r, vv) {
    if (!r || r.none || r.pass) return '';
    let t = `Jij zei ${resultWords(r)}.`;
    if (r.decided && r.auto === 'doubt' && vv !== 'doubt') t += ` De spelleider keurde het ${vv === 'right' ? 'goed' : 'af'}.`;
    else if (r.overridden) t += ' De spelleider heeft het oordeel omgedraaid.';
    else if (r.cat === 'exact' && vv === 'wrong') t += ' Bij Exact jaar moet het precies kloppen.';
    return t;
  }

  function verdictParts(v) {
    const g = v.game;
    const r = g.reveal.mine;
    const vv = myVerdict(v);
    const word = { right: 'GOED!', wrong: 'HELAAS', doubt: '?', pass: 'Jammer', none: 'Te laat' }[vv];
    const sub = { right: '', wrong: '', doubt: 'De spelleider kijkt naar je antwoord…', pass: 'Je wist het niet', none: 'Je hebt niet geantwoord' }[vv];
    const explain = explainText(r, vv);
    const x = verdictExtras(v, vv);
    // the flame grows with the streak (capped, so 10 in a row still fits)
    const flame = x.streak ? `<div class="ph-streak" data-testid="disco-streak" data-streak="${x.streak}" style="--s:${Math.min(1 + (x.streak - 2) * 0.18, 2).toFixed(2)}"><span class="ph-flame" aria-hidden="true">🔥</span><b>${x.streak} op rij!</b></div>` : '';
    const fast = x.fast ? '<p class="ph-fast" data-testid="disco-fastest"><span aria-hidden="true">⚡</span><b>Snelste!</b><span>Als eerste goed</span></p>' : '';
    const joker = x.joker ? '<div class="ph-joker-won" data-testid="disco-joker-earned" role="status"><span class="ph-joker-card" aria-hidden="true">🃏</span><span class="ph-joker-won-text"><b>Joker verdiend!</b><small>Zet hem in op elke kleur.</small></span></div>' : '';
    const over = x.over ? `<p class="ph-streak-over" data-testid="disco-streak-over">Reeks voorbij <small>(${x.over} op rij, mooi!)</small></p>` : '';
    const extras = flame || fast || joker || over ? `<div class="ph-extras">${flame}${fast}${joker}${over}</div>` : '';
    return {
      main: `<div class="ph-verdict" data-testid="disco-verdict" data-verdict="${vv}" role="status">
          <span class="ph-v-word">${esc(word)}</span>${sub ? `<span class="ph-v-sub">${esc(sub)}</span>` : ''}
        </div>
        ${extras}
        ${explain || vv === 'doubt' ? `<p class="ph-v-explain" data-testid="disco-verdict-explain">${esc(explain || 'Bijna goed, of net niet? Dat beslist de spelleider zo.')}${vv === 'doubt' && explain ? ' Bijna goed, of net niet? Dat beslist de spelleider zo.' : ''}</p>` : ''}
        ${songHtml(v)}`,
      foot: vv === 'doubt' ? '<p class="ph-line ph-calm"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>Even geduld…</p>' : '<p class="ph-tap">Tik om verder te gaan</p>',
    };
  }

  /** Choose (a right answer with open squares) and the resting card. */
  function cardParts(v) {
    const g = v.game;
    const d = g.disco;
    const win = d.win;
    if (!g.mine) {
      return { main: '<p class="ph-line ph-big" data-testid="answer-none">Je doet vanaf de volgende ronde mee.</p>', foot: '<p class="ph-line ph-calm" data-testid="room-next-wait"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>Wachten op de volgende ronde…</p>' };
    }
    const revealed = v.phase === 'revealed';
    const r = revealed ? g.reveal?.mine : null;
    const vv = r ? myVerdict(v) : null;
    const jokerOn = revealed && jokerActive(v);
    const onJoker = revealed && chipOnJoker(v);
    const choosing = revealed && r?.correct && !d.waitingForHost && (d.choosable.length > 0 || jokerOn);
    // the joker can be used: right, decided, a joker in hand (jokerSquares is empty otherwise)
    const canJoker = revealed && r?.correct && !d.waitingForHost && (d.jokerSquares || []).length > 0 && (!g.mine.bingo || onJoker);
    const pill = vv ? `<span class="ph-pill is-${vv}" data-testid="disco-verdict" data-verdict="${vv}">${vv === 'right' ? `${icons.check}<span>Goed!</span>` : vv === 'wrong' ? `${icons.cross}<span>Helaas</span>` : vv === 'pass' ? '<span>Weet ik niet</span>' : vv === 'none' ? '<span>Geen antwoord</span>' : '<span>Twijfel</span>'}</span>` : '';
    let line = '';
    const winner = revealed && isWinner(v);
    if (winner) line = `<p class="ph-instr is-bingo" data-testid="disco-choose" data-state="bingo"><b class="ph-bingo-badge" data-testid="disco-bingo">BINGO!</b><span>Je hebt ${esc(winText(win))}</span></p>`;
    else if (choosing && d.choice == null && jokerOn) line = '<p class="ph-instr is-todo is-joker" data-testid="disco-choose" data-state="joker"><span class="ph-joker-ico" aria-hidden="true">🃏</span><span>Kies zelf een open vakje</span></p>';
    else if (choosing && d.choice == null) line = `<p class="ph-instr is-todo" data-testid="disco-choose" data-state="choose"><span>Kies zelf een</span> ${catChip(d.cat)} <span>vakje</span></p>`;
    else if (choosing && onJoker) line = '<p class="ph-instr is-done is-joker" data-testid="disco-choose" data-state="joker-chosen"><span class="ph-joker-ico" aria-hidden="true">🃏</span><span>Joker ingezet!</span></p>';
    else if (choosing) line = `<p class="ph-instr is-done" data-testid="disco-choose" data-state="chosen">${icons.check}<span>Fiche gelegd! Ander vakje? Tik erop.</span></p>`;
    else if (revealed && r?.correct && d.noSquare) line = `<p class="ph-instr" data-testid="disco-choose" data-state="nosquare"><span>Geen open</span> ${catChip(d.cat, { short: true })} <span>vakje meer</span></p>`;
    else if (revealed && r) line = '<p class="ph-instr is-none" data-testid="disco-nothing">Geen vakje deze ronde</p>';
    else if (revealed) line = '<p class="ph-instr is-none" data-testid="disco-nothing">Welkom! Je doet mee vanaf de volgende ronde.</p>';
    const explain = r && (r.overridden || (r.decided && r.auto === 'doubt')) ? `<p class="ph-explain-small" data-testid="disco-verdict-explain">${esc(explainText(r, vv))}</p>` : '';
    const n = myToGo(v);
    const togo = n != null && n > 0 ? `<p class="ph-togo${n === 1 ? ' is-hot' : ''}" data-testid="disco-togo" data-togo="${n}">${esc(toGoText(n, win))}</p>` : '';
    // a bingo stop: who has it, on top of the card (who may still lay a chip does that now)
    const stop = revealed && d.bingo && !winner
      ? `<p class="ph-stop-line" data-testid="disco-stop-banner"><b>BINGO</b> <span>${esc(bingoWhoText(d.bingo))}.${choosing && d.choice == null ? ' Leg nog je fiche!' : ''}</span></p>` : '';
    const wait = v.phase === 'answering'
      ? ''
      : `<p class="ph-line ph-calm" data-testid="room-next-wait"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>${d.bingo ? 'Het spel staat stil: de spelleider kiest of het doorgaat…' : 'Wachten op de volgende ronde…'}</p>`;
    const joker = canJoker ? jokerHtml(v, { on: jokerOn, onJoker }) : '';
    return {
      head: `${stop}<div class="ph-cardhead${pill ? '' : ' no-pill'}">${pill}${line}</div>${explain}`,
      main: `<div class="ph-cardbox${joker ? ' has-joker' : ''}">${discoCardHtml(g.mine, { mode: choosing ? 'choose' : 'show', choosable: d.choosable || [], joker: jokerOn ? d.jokerSquares : [], jokerChips: jokerChips(v), choice: d.choice, cat: choosing ? d.cat : null, name: v.you?.name })}</div>`,
      // the joker control takes the place of the waiting line (the round is not over while it is there)
      foot: joker ? `${togo}${joker}` : `${togo}${wait}`,
    };
  }

  /** "Zet joker in": the switch and, plainly, what it costs. */
  function jokerHtml(v, { on, onJoker }) {
    const d = v.game.disco;
    const n = v.game.mine.jokers + (onJoker ? 1 : 0); // a joker in use is still yours until the next round
    const label = onJoker ? 'Joker terug' : on ? 'Joker uit' : 'Zet joker in';
    const note = onJoker
      ? (d.choosable.length
        ? `Je joker is weg zodra de volgende ronde begint; verplaats je fiche terug naar ${catChip(d.cat, { short: true })} om hem te houden.`
        : 'Je joker is weg zodra de volgende ronde begint; tik op <b>Joker terug</b> om hem te houden.')
      : on ? 'Elk open vakje mag nu (★). Ligt je fiche op een andere kleur als de volgende ronde begint, dan is je joker op.'
        : `Je hebt ${n === 1 ? 'een joker' : `${n} jokers`}: daarmee mag je fiche op elke kleur.`;
    return `<div class="ph-joker${on ? ' is-on' : ''}" data-testid="disco-joker">
      <button type="button" class="ph-joker-btn" data-action="ph-joker" data-testid="disco-joker-toggle" data-on="${on}" aria-pressed="${on}"><span class="ph-joker-card is-small" aria-hidden="true">🃏</span><span>${label}</span></button>
      <p class="ph-joker-note" data-testid="disco-joker-note" data-state="${onJoker ? 'spent' : on ? 'on' : 'off'}">${note}</p>
    </div>`;
  }

  /* ---------- the question: focus and typing ---------- */
  function focusQuestion(v) {
    const k = `${rk(v)}|${edit === rk(v)}`;
    if (focusFor === k) return;
    focusFor = k;
    const input = parts.main?.querySelector('#ph-input');
    if (!input) return;
    // the typed categories go straight to the keyboard (the field sits in the upper half)
    later(() => { if (input.isConnected && document.activeElement !== input) { input.focus({ preventScroll: true }); try { const n = input.value.length; input.setSelectionRange(n, n); } catch { /* ignore */ } } }, 60);
  }

  function refreshLock() {
    const v = view();
    const q = parts.main?.querySelector('[data-testid="disco-answer"]');
    if (!v || !q) return;
    const sending = !!getSession()?.pending;
    const tmp = document.createElement('div');
    tmp.innerHTML = `${lockButton(v, sending)}${stateLine(v, sentAnswer(v))}`;
    for (const id of ['disco-lock', 'disco-answer-state']) {
      const fresh = tmp.querySelector(`[data-testid="${id}"]`);
      const cur = q.querySelector(`[data-testid="${id}"]`);
      if (fresh && cur && fresh.outerHTML !== cur.outerHTML) cur.replaceWith(fresh);
    }
  }

  function submit() {
    const v = view();
    if (!v || v.phase !== 'answering' || !v.game.mine) return;
    const ans = currentProposal(v);
    if (!ans) return;
    const sent = sentAnswer(v);
    edit = null;
    if (!sent || !sameAnswer(ans, sent)) send(ans);
    vibrate(15);
    document.activeElement?.blur?.();
    draw();
  }

  /* ---------- the sheet ---------- */
  function openSheet(page) {
    clearTimeout(sheetClear);
    sheet = page;
    parts.wrap.classList.add('is-open');
    parts.menuBtn.setAttribute('aria-expanded', 'true');
    document.activeElement?.blur?.();
    draw();
    parts.sheet.querySelector('button')?.focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!sheet) return;
    sheet = null;
    parts.wrap.classList.remove('is-open');
    parts.menuBtn.setAttribute('aria-expanded', 'false');
    parts.sheet.dataset.page = '';
    // the content leaves after the slide-out (no hidden copies of testids hang around)
    sheetClear = setTimeout(() => { if (!sheet) { parts.sheet.innerHTML = ''; parts.sheet.__html = null; } }, 320);
  }

  function drawSheet(v) {
    if (!sheet) return;
    if (sheet === 'answers' && !v.game.reveal) sheet = 'menu';
    parts.sheet.dataset.page = sheet;
    patch(parts.sheet, sheetHtml(v, sheet));
  }

  function sheetHead(title, back = true) {
    return `<div class="ph-sheet-head">
      ${back ? `<button class="icon-btn ph-sheet-back" type="button" data-action="ph-sheet" data-page="menu" data-testid="disco-sheet-back" aria-label="Terug">${icons.back}</button>` : '<span class="ph-sheet-grip" aria-hidden="true"></span>'}
      <h2 class="ph-sheet-title">${esc(title)}</h2>
      <button class="icon-btn ph-sheet-close" type="button" data-action="ph-close" data-testid="disco-sheet-close" aria-label="Sluiten">${icons.close}</button>
    </div>`;
  }

  function sheetHtml(v, page) {
    const g = v.game;
    if (page === 'menu') {
      const mix = mixHtml() != null;
      const item = (id, pg, ico, label, sub = '') => `<li><button class="ph-item" type="button" data-action="ph-sheet" data-page="${pg}" data-testid="${id}">${ico}<span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></button></li>`;
      const n = myToGo(v);
      return `${sheetHead(`Kamer ${v.code}`, false)}
        <ul class="ph-menu" data-testid="disco-menu-list">
          ${item('disco-menu-stand', 'stand', icons.trophy, 'Stand', 'Wie is er het dichtst bij?')}
          ${g.mine ? item('disco-menu-card', 'card', gridIco, 'Mijn kaart', n ? toGoText(n, g.disco.win) : '') : ''}
          ${g.reveal ? item('disco-menu-answers', 'answers', chatIco, 'Wat iedereen antwoordde', 'Deze ronde') : ''}
          ${mix ? item('disco-menu-mix', 'mix', icons.users, 'Mix van de groep', 'Favorieten delen') : ''}
          ${item('room-leave', 'leave', exitIco, 'Verlaat')}
        </ul>`;
    }
    if (page === 'stand') return `${sheetHead('Stand')}${standHtml(v)}`;
    if (page === 'card') {
      const n = myToGo(v);
      const landed = v.phase === 'answering' && stage?.landed;
      return `${sheetHead('Mijn kaart')}<div class="ph-sheet-card">${g.mine ? discoCardHtml(g.mine, { testid: 'disco-sheet-card', cat: landed ? g.disco.cat : null, name: v.you?.name, jokerChips: jokerChips(v) }) : ''}</div>
        <p class="ph-togo${n === 1 ? ' is-hot' : ''}">${esc(n ? toGoText(n, g.disco.win) : g.mine?.bingo ? 'BINGO!' : '')}</p>`;
    }
    if (page === 'answers') {
      // an away player still listed as choosing is not somebody we wait for: the server places their chip
      const online = new Set(v.players.filter((p) => p.online).map((p) => p.id));
      const tv = { ...v, game: { ...g, disco: { ...g.disco, pending: (g.disco.pending || []).filter((id) => online.has(id)) } } };
      return `${sheetHead('Wat iedereen antwoordde')}${songHtml(v, 'is-small')}${discoResultsHtml(tv)}`;
    }
    if (page === 'mix') return `${sheetHead('Mix van de groep')}<div class="ph-sheet-mix">${mixHtml() || ''}</div>`;
    if (page === 'leave') {
      const keeps = !!getSession()?.keepsSeat;
      return `<div class="ph-leave" data-testid="disco-leave-confirm">
        <h2 class="ph-sheet-title">Kamer verlaten?</h2>
        <p>${keeps
    ? `Het spel gaat gewoon door. Je plek blijft bewaard: je kaart en je fiches. Terugkomen kan op deze telefoon met <b>Terug naar kamer ${esc(v.code)}</b>.`
    : 'Je verlaat de kamer.'}</p>
        <button class="btn btn-primary btn-xl" type="button" data-action="ph-close" data-testid="disco-leave-no">Blijf spelen</button>
        <button class="btn btn-ghost" type="button" data-action="ph-leave-yes" data-testid="disco-leave-yes">${exitIco}<span>Ja, verlaat de kamer</span></button>
      </div>`;
    }
    return '';
  }

  function standHtml(v) {
    const g = v.game;
    const list = (g.disco.progress || []).slice().sort(compare);
    const online = new Map(v.players.map((p) => [p.id, p.online]));
    const winners = new Set(g.winnerIds || []);
    return `<ol class="ph-stand" data-testid="disco-stand">${list.map((p, i) => {
      const rank = 1 + list.filter((q) => better(q, p)).length;
      const you = v.you && p.id === v.you.id;
      const togo = Number.isFinite(p.toGo) ? p.toGo : null;
      const right = p.bingo || winners.has(p.id) ? '<b class="ph-stand-bingo">BINGO</b>'
        : togo === 1 ? '<b class="ph-stand-hot">nog 1!</b>' : togo != null ? `<span class="ph-stand-togo">nog ${togo}</span>` : '';
      return `<li class="${you ? 'is-you' : ''}${online.get(p.id) === false ? ' is-away' : ''}${togo === 1 ? ' is-hot' : ''}" data-testid="disco-stand-${i}" data-name="${esc(p.name)}" data-togo="${togo ?? ''}" data-stamped="${p.stamped}" data-bingo="${!!p.bingo}">
        <span class="ph-stand-rank">${rank}</span>
        ${avatarHtml(p, { cls: 'ph-stand-av' })}
        <span class="ph-stand-name"><span>${esc(p.name)}${you ? ' <small>(jij)</small>' : ''}${online.get(p.id) === false ? ' <small>(even weg)</small>' : ''}</span><small class="ph-stand-sub">${p.stamped} ${p.stamped === 1 ? 'vakje' : 'vakjes'} · ${p.lines} ${p.lines === 1 ? 'lijn' : 'lijnen'}${v.phase === 'won' ? '' : ` ${streakMark(p.streak)}${jokerMark(p.jokers)}`}</small></span>
        ${right}
      </li>`;
    }).join('')}</ol>`;
  }

  /* ---------- "spannend": once per round, when somebody gets one square from the goal ---------- */
  function excitement(v, m) {
    const g = v.game;
    if (v.phase === 'won') return;
    const ones = (g.disco.progress || []).filter((p) => p.toGo === 1 && !p.bingo);
    const ids = ones.map((p) => p.id).sort().join(',');
    const r = rk(v);
    if (ids && toastSeen.r !== r && toastSeen.ids !== ids && ones.some((p) => !toastSeen.ids.split(',').includes(p.id))) {
      toastSeen = { r, ids };
      ss.set(TOAST_KEY, toastSeen);
      const me = ones.find((p) => p.id === v.you?.id);
      const others = ones.filter((p) => p.id !== v.you?.id).map((p) => p.name);
      toastQueue = me ? (others.length ? `Spannend! Jij en ${others.join(' en ')} hebben nog 1 vakje nodig` : 'Spannend! Jij hebt nog 1 vakje nodig voor bingo')
        : `Spannend: ${others.join(' en ')} ${others.length === 1 ? 'heeft' : 'hebben'} nog 1 vakje nodig`;
    } else if (!ids && toastSeen.ids) {
      toastSeen = { r: toastSeen.r, ids: '' };
      ss.set(TOAST_KEY, toastSeen);
    }
    // never over the big moments; it waits for a calm one
    if (g.disco.bingo) toastQueue = null; // a bingo says it all: no stale "spannend" over it
    if (toastQueue && !['verdict', 'splash', 'bingo', 'stop', 'spin', 'question'].includes(m)) {
      const text = toastQueue;
      toastQueue = null;
      const t = parts.toast;
      t.textContent = text;
      t.hidden = false;
      t.classList.remove('is-on');
      void t.offsetWidth;
      t.classList.add('is-on');
      vibrate([20, 60, 20]);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.classList.remove('is-on'); setTimeout(() => { if (!t.classList.contains('is-on')) t.hidden = true; }, 300); }, TOAST_MS);
    }
  }

  /* ---------- events ---------- */
  function onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a || !el?.contains(a)) return false;
    if (a.dataset.action === 'react') return reactBar ? reactBar.onClick(e) : false;
    const v = view();
    const act = a.dataset.action;
    switch (act) {
      case 'ph-menu': if (sheet) closeSheet(); else openSheet('menu'); return true;
      case 'ph-close': closeSheet(); draw(); return true;
      case 'ph-sheet': if (a.dataset.page === 'stand' && !sheet) { openSheet('stand'); return true; } sheet = a.dataset.page; draw(); parts.sheet.querySelector('button')?.focus({ preventScroll: true }); return true;
      case 'ph-leave-yes': closeSheet(); leave(); return true;
      case 'ph-next': shown.until = 0; draw(); return true;
      case 'ph-bingo-done': if (v) { seen = { ...seen, k: rk(v), bingo: true }; ss.set(SEEN_KEY, seen); } draw(); return true;
      case 'ph-stop-done': if (v?.game?.disco?.bingo) { seen = { ...seen, k: rk(v), stop: v.game.disco.bingo.win }; ss.set(SEEN_KEY, seen); } draw(); return true;
      case 'ph-lock': if (!a.disabled) submit(); return true;
      case 'ph-pass':
        if (v?.phase === 'answering' && v.game.mine) { edit = null; local = { k: rk(v), value: null }; send({ pass: true }); vibrate(15); document.activeElement?.blur?.(); draw(); }
        return true;
      case 'ph-edit':
        if (v?.phase === 'answering') { edit = rk(v); local = { k: rk(v), value: null }; draw(); }
        return true;
      case 'disco-stamp':
        if (v?.phase === 'revealed' && Number(a.dataset.index) !== v.game.disco.choice) {
          // a square of another colour goes with the joker; one of the round's colour is a normal stamp
          stamp(Number(a.dataset.index), a.dataset.joker === 'true' ? { joker: true } : undefined);
          vibrate(a.dataset.joker === 'true' ? [20, 40, 20] : 25);
        }
        return true;
      case 'ph-joker':
        if (v?.phase === 'revealed') {
          if (chipOnJoker(v)) { stamp(null); jok = { k: rk(v), on: false }; } // the chip comes back: the joker stays
          else jok = { k: rk(v), on: !(jok.k === rk(v) && jok.on) };
          vibrate(15);
          draw();
        }
        return true;
      default: return false;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (!el?.contains(t)) return;
    if (t.matches('[data-testid="disco-year-input"]')) {
      const clean = t.value.replace(/\D/g, '').slice(0, 4);
      if (clean !== t.value) t.value = clean;
      local = { ...local, value: clean };
    } else if (t.matches('[data-testid="disco-text-input"]')) local = { ...local, value: t.value };
    else return;
    // only the button changes: a re-render would close the phone's keyboard
    refreshLock();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && sheet) { closeSheet(); draw(); return; }
    if (e.key === 'Enter' && e.target.matches?.('#ph-input')) { e.preventDefault(); submit(); }
  }

  return {
    html,
    mount,
    draw,
    statusHtml,
    onClick,
    onInput,
    onKeyDown,
    get moment() { return moment; },
    get sheet() { return sheet; },
    destroy() {
      clearInterval(autoTick);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      clearTimeout(toastTimer);
      clearTimeout(sheetClear);
      stage?.destroy();
      stage = null;
      el = null;
    },
  };
}

/* ranking: bingo first, then fewest to go, then most stamped */
function compare(a, b) {
  return (b.bingo - a.bingo) || ((a.toGo ?? 99) - (b.toGo ?? 99)) || (b.lines - a.lines) || (b.stamped - a.stamped) || a.name.localeCompare(b.name);
}
function better(a, b) {
  return (a.bingo && !b.bingo) || (a.bingo === b.bingo && ((a.toGo ?? 99) < (b.toGo ?? 99) || ((a.toGo ?? 99) === (b.toGo ?? 99) && (a.lines > b.lines || (a.lines === b.lines && a.stamped > b.stamped)))));
}
