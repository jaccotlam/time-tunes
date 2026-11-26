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
  proposedAnswer, sameAnswer, verdictOf, winText,
} from './room-disco.js';
import { patch, winnerHtml, confettiHtml, leaderAwayHtml, diagHtml } from './room-ui.js';
import { icons, esc, vibrate } from '../ui.js';

const SPLASH_MS = 1100;
const VERDICT_MS = 2300;
const TOAST_MS = 3800;
const SEEN_KEY = 'timetunesr.discoSeen.v1'; // sessionStorage: { k, v, bingo } of the running round
const TOAST_KEY = 'timetunesr.discoToast.v1'; // sessionStorage: { r, ids } of the last "spannend" toast

const ss = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/** The one short question line per category. */
const QUESTION = {
  decade: 'Uit welke jaren is dit?',
  artist: 'Wie zingt of speelt dit?',
  year: 'Uit welk jaar?',
  title: 'Hoe heet dit nummer?',
};
const HINT = { year: '2 jaar ernaast mag', artist: 'Kleine typefouten mogen', title: 'Kleine typefouten mogen' };

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
export function createDiscoPhone({ getSession, send, stamp, leave, mixHtml = () => null, serverNow = () => Date.now() }) {
  let el = null;
  const parts = {};
  let stage = null;
  let momentId = null;
  let moment = null;
  const partKeys = {};
  let splash = { k: null, until: 0 };
  let edit = null; // round key while "Wijzig" is open
  let local = { k: null, value: null, decade: null };
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

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
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
      if (seen.k !== k) seen = { k, v: null, bingo: false };
      if (seen.v !== vv) {
        seen.v = vv;
        ss.set(SEEN_KEY, seen);
        shown = { k, v: vv, until: Date.now() + VERDICT_MS };
        if (vv !== 'doubt') later(draw, VERDICT_MS + 30);
        vibrate(vv === 'right' ? [30, 50, 30] : vv === 'wrong' ? [90] : 20);
      }
      if (vv === 'doubt') return 'verdict';
      if (shown.k === k && shown.v === vv && Date.now() < shown.until) return 'verdict';
    }
    if (g.mine?.bingo && !(seen.k === k && seen.bingo)) return 'bingo';
    if (g.reveal?.mine?.correct && !d.waitingForHost && d.choosable?.length) return 'choose';
    return 'card';
  }

  /* ---------- mount ---------- */
  function html(code) {
    return `<section class="screen ph" data-testid="screen-room-player" data-view="answering" data-code="${esc(code)}" data-moment="">
      <header class="ph-bar">
        <span class="ph-code" data-testid="room-code" aria-label="Kamercode">${esc(code)}</span>
        <span class="conn ph-conn" data-testid="conn-status" data-state="connecting" role="status"><i aria-hidden="true"></i><span class="sr-only">Verbinden…</span></span>
        <span class="ph-round" data-testid="room-round"></span>
        <button class="ph-menu-btn" type="button" data-action="ph-menu" data-testid="disco-menu" aria-label="Menu" aria-haspopup="dialog" aria-expanded="false">${dots}</button>
      </header>
      <div class="ph-banner" data-region="status"></div>
      <div class="ph-stage">
        <div class="ph-ball" aria-hidden="false"></div>
        <div class="ph-moment-host"></div>
      </div>
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
    parts.toast = el.querySelector('.ph-toast');
    parts.wrap = el.querySelector('.ph-sheet-wrap');
    parts.sheet = el.querySelector('.ph-sheet');
    parts.status = el.querySelector('[data-region="status"]');
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
      if (m === 'bingo' && !lastBingo) vibrate([60, 40, 60, 40, 220]);
      lastBingo = m === 'bingo';
      parts.host.innerHTML = skeletonHtml(m, v, vv, first);
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
    drawSheet(v);
    excitement(v, m);
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
    const fx = m === 'bingo' || m === 'winner' ? confettiHtml()
      : m === 'verdict' && vv === 'right' ? '<div class="ph-burst" aria-hidden="true"></div>' : '';
    const cls = m === 'verdict' ? ` is-${vv}` : '';
    const tap = m === 'verdict' && vv !== 'doubt' ? ' data-action="ph-next"' : m === 'bingo' ? ' data-action="ph-bingo-done"' : '';
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
          ${discoCardHtml(g.mine, { testid: 'disco-bingo-card', name: v.you?.name })}`,
        foot: `<p class="ph-line" data-testid="disco-bingo-wait">De spelleider gaat zo naar de uitslag.</p>
          <button class="btn btn-ghost ph-small-btn" type="button" data-action="ph-bingo-done" data-testid="disco-bingo-card-btn">${gridIco}<span>Bekijk je kaart</span></button>`,
      };
    },
    winner(v) {
      const g = v.game;
      const me = v.you && (g.winnerIds || []).includes(v.you.id);
      const prog = (g.disco?.progress || []);
      const mine = prog.find((p) => p.id === v.you?.id);
      const place = mine ? 1 + prog.filter((p) => better(p, mine)).length : null;
      return {
        main: `<div class="ph-winner${me ? ' is-me' : ''}">${winnerHtml(v)}</div>
          ${me ? '<p class="ph-won-you" data-testid="room-you-won">Gefeliciteerd, jij hebt gewonnen!</p>' : ''}
          ${mine && !me ? `<p class="ph-line ph-place" data-testid="disco-place">Jij: ${place}e plaats · ${mine.stamped} ${mine.stamped === 1 ? 'vakje' : 'vakjes'} · ${mine.lines} ${mine.lines === 1 ? 'lijn' : 'lijnen'}</p>` : ''}`,
        foot: `<button class="btn btn-ghost ph-small-btn" type="button" data-action="ph-sheet" data-page="stand" data-testid="disco-winner-stand">${icons.trophy}<span>Bekijk de stand</span></button>
          <p class="ph-line ph-calm" data-testid="room-next-wait"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>Wachten op een nieuw potje…</p>`,
      };
    },
  };

  function questionHead(cat) {
    return `<div class="ph-qhead cat-${esc(cat)}" data-testid="disco-category-head"><span class="ph-qhead-ico">${catIcon(cat)}</span><b>${esc(catName(cat))}</b></div>`;
  }

  function questionParts(v) {
    const g = v.game;
    const d = g.disco;
    const cat = d.cat;
    const k = rk(v);
    if (local.k !== k) local = { k, value: null, decade: null };
    const sent = sentAnswer(v);
    const sending = !!getSession()?.pending;
    let input;
    if (cat === 'decade') {
      const pick = local.decade ?? sent?.decade ?? null;
      input = `<div class="ph-decades" role="group" aria-label="Decennium">${d.decades.map((x) => {
        const on = pick === x.decade;
        return `<button type="button" class="ph-dec${on ? ' is-on' : ''}" data-action="ph-decade" data-decade="${x.decade}" data-testid="disco-decade-${x.decade}" aria-pressed="${on}"><b>${esc(x.label)}</b><small>${esc(x.sub)}</small></button>`;
      }).join('')}</div>`;
    } else if (cat === 'year') {
      const val = local.value ?? (sent?.guess != null ? String(sent.guess) : '');
      input = `<input id="ph-input" class="ph-input ph-year" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="19··" value="${esc(val)}" data-testid="disco-year-input" aria-label="Jaartal" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">`;
    } else {
      const val = local.value ?? (sent?.text ?? '');
      input = `<input id="ph-input" class="ph-input" type="text" maxlength="60" placeholder="${cat === 'artist' ? 'Artiest of band' : 'Titel'}" value="${esc(val)}" data-testid="disco-text-input" aria-label="${cat === 'artist' ? 'Artiest of band' : 'Titel'}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="send">`;
    }
    const hint = HINT[cat];
    return {
      keys: { main: JSON.stringify([k, cat, d.decades, sent, edit === k, sending, local.decade]) },
      head: questionHead(cat),
      main: `<div class="ph-q disco-answer" data-testid="disco-answer" data-cat="${esc(cat)}">
        <label class="ph-q-line" for="ph-input">${esc(QUESTION[cat])}</label>
        ${hint ? `<p class="ph-q-hint" data-testid="disco-hint">${esc(hint)}</p>` : ''}
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
    if (cat === 'decade') {
      const pick = local.decade ?? sentAnswer(v)?.decade ?? null;
      return pick == null ? null : { decade: pick };
    }
    const sent = sentAnswer(v);
    const val = local.value ?? (cat === 'year' ? (sent?.guess != null ? String(sent.guess) : '') : sent?.text ?? '');
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
    const words = sent?.pass ? 'Weet ik niet' : sent?.decade != null ? `${answerWords(sent).replace(/ \(.*\)$/, '')}` : sent?.guess != null ? String(sent.guess) : sent?.text != null ? `“${sent.text}”` : '';
    return {
      head: questionHead(cat),
      main: `<div class="ph-sub">
        <span class="ph-sub-check" aria-hidden="true">${icons.check}</span>
        <p class="ph-kicker">${sent?.pass ? 'Doorgegeven' : 'Antwoord binnen'}</p>
        <p class="ph-sub-answer${sent?.pass ? ' is-pass' : ''}" data-testid="disco-answer-state" data-state="${sent?.pass ? 'pass' : 'locked'}">${esc(words)}</p>
        <div class="ph-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      </div>`,
      foot: `<p class="ph-count${all ? ' is-all' : ''}" data-testid="disco-answered" data-answered="${answered}" data-total="${total}">${all ? 'Iedereen heeft geantwoord!' : `${answered} van ${total} ${total === 1 ? 'heeft' : 'hebben'} geantwoord`}</p>
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
    return t;
  }

  function verdictParts(v) {
    const g = v.game;
    const r = g.reveal.mine;
    const vv = myVerdict(v);
    const word = { right: 'GOED!', wrong: 'HELAAS', doubt: '?', pass: 'Jammer', none: 'Te laat' }[vv];
    const sub = { right: '', wrong: '', doubt: 'De spelleider kijkt naar je antwoord…', pass: 'Je wist het niet', none: 'Je hebt niet geantwoord' }[vv];
    const explain = explainText(r, vv);
    return {
      main: `<div class="ph-verdict" data-testid="disco-verdict" data-verdict="${vv}" role="status">
          <span class="ph-v-word">${esc(word)}</span>${sub ? `<span class="ph-v-sub">${esc(sub)}</span>` : ''}
        </div>
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
    const choosing = revealed && r?.correct && !d.waitingForHost && d.choosable.length > 0;
    const pill = vv ? `<span class="ph-pill is-${vv}" data-testid="disco-verdict" data-verdict="${vv}">${vv === 'right' ? `${icons.check}<span>Goed!</span>` : vv === 'wrong' ? `${icons.cross}<span>Helaas</span>` : vv === 'pass' ? '<span>Weet ik niet</span>' : vv === 'none' ? '<span>Geen antwoord</span>' : '<span>Twijfel</span>'}</span>` : '';
    let line = '';
    if (g.mine.bingo) line = `<p class="ph-instr is-bingo" data-testid="disco-choose" data-state="bingo"><b class="ph-bingo-badge" data-testid="disco-bingo">BINGO!</b><span>${d.choice != null && d.choosable.length > 1 ? 'Verplaatsen kan nog' : `Je hebt ${esc(winText(win))}`}</span></p>`;
    else if (choosing && d.choice == null) line = `<p class="ph-instr is-todo" data-testid="disco-choose" data-state="choose"><span>Kies een</span> ${catChip(d.cat)} <span>vakje</span></p>`;
    else if (choosing) line = `<p class="ph-instr is-done" data-testid="disco-choose" data-state="chosen">${icons.check}<span>Fiche gezet! Ander vakje? Tik erop.</span></p>`;
    else if (revealed && r?.correct && d.noSquare) line = `<p class="ph-instr" data-testid="disco-choose" data-state="nosquare"><span>Geen open</span> ${catChip(d.cat, { short: true })} <span>vakje meer</span></p>`;
    else if (revealed && r) line = '<p class="ph-instr is-none" data-testid="disco-nothing">Geen vakje deze ronde</p>';
    else if (revealed) line = '<p class="ph-instr is-none" data-testid="disco-nothing">Welkom! Je doet mee vanaf de volgende ronde.</p>';
    const explain = r && (r.overridden || (r.decided && r.auto === 'doubt')) ? `<p class="ph-explain-small" data-testid="disco-verdict-explain">${esc(explainText(r, vv))}</p>` : '';
    const n = myToGo(v);
    const togo = n != null && n > 0 ? `<p class="ph-togo${n === 1 ? ' is-hot' : ''}" data-testid="disco-togo" data-togo="${n}">${esc(toGoText(n, win))}</p>` : '';
    const wait = v.phase === 'answering'
      ? ''
      : `<p class="ph-line ph-calm" data-testid="room-next-wait"><span class="ph-dots" aria-hidden="true"><i></i><i></i><i></i></span>${g.mine.bingo ? 'De spelleider gaat zo naar de uitslag…' : 'Wachten op de volgende ronde…'}</p>`;
    return {
      head: `<div class="ph-cardhead${pill ? '' : ' no-pill'}">${pill}${line}</div>${explain}`,
      main: `<div class="ph-cardbox">${discoCardHtml(g.mine, { mode: choosing ? 'choose' : 'show', choosable: d.choosable || [], choice: d.choice, cat: choosing ? d.cat : null, name: v.you?.name })}</div>`,
      foot: `${togo}${wait}`,
    };
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
    if (!sent || !sameAnswer(ans, sent) || (ans.decade != null && sent.decade !== ans.decade)) send(ans);
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
      return `${sheetHead('Mijn kaart')}<div class="ph-sheet-card">${g.mine ? discoCardHtml(g.mine, { testid: 'disco-sheet-card', cat: landed ? g.disco.cat : null, name: v.you?.name }) : ''}</div>
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
        <span class="ph-stand-name"><span>${esc(p.name)}${you ? ' <small>(jij)</small>' : ''}${online.get(p.id) === false ? ' <small>(even weg)</small>' : ''}</span><small class="ph-stand-sub">${p.stamped} ${p.stamped === 1 ? 'vakje' : 'vakjes'} · ${p.lines} ${p.lines === 1 ? 'lijn' : 'lijnen'}</small></span>
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
    if (toastQueue && !['verdict', 'splash', 'bingo', 'spin', 'question'].includes(m)) {
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
    const v = view();
    const act = a.dataset.action;
    switch (act) {
      case 'ph-menu': if (sheet) closeSheet(); else openSheet('menu'); return true;
      case 'ph-close': closeSheet(); draw(); return true;
      case 'ph-sheet': if (a.dataset.page === 'stand' && !sheet) { openSheet('stand'); return true; } sheet = a.dataset.page; draw(); parts.sheet.querySelector('button')?.focus({ preventScroll: true }); return true;
      case 'ph-leave-yes': closeSheet(); leave(); return true;
      case 'ph-next': shown.until = 0; draw(); return true;
      case 'ph-bingo-done': if (v) { seen = { ...seen, k: rk(v), bingo: true }; ss.set(SEEN_KEY, seen); } draw(); return true;
      case 'ph-decade':
        if (v?.phase === 'answering') { local = { ...local, k: rk(v), decade: Number(a.dataset.decade) }; vibrate(8); draw(); }
        return true;
      case 'ph-lock': if (!a.disabled) submit(); return true;
      case 'ph-pass':
        if (v?.phase === 'answering' && v.game.mine) { edit = null; local = { k: rk(v), value: null, decade: null }; send({ pass: true }); vibrate(15); document.activeElement?.blur?.(); draw(); }
        return true;
      case 'ph-edit':
        if (v?.phase === 'answering') { edit = rk(v); local = { k: rk(v), value: null, decade: null }; draw(); }
        return true;
      case 'disco-stamp':
        if (v?.phase === 'revealed' && Number(a.dataset.index) !== v.game.disco.choice) { stamp(Number(a.dataset.index)); vibrate(25); }
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
