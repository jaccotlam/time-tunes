// "Samen spelen", player side (#/kamer, #/kamer/ABCD): join with a room code or link,
// then play on your own phone. Everything shown comes from the host (multi/protocol.js
// viewFor); before the reveal nothing about the running song reaches this phone.
import { normalizeCode } from '../multi/code.js';
import { createClientSession, storedJoin, forgetJoin } from '../multi/client-session.js';
import { cleanName } from '../multi/game.js';
import { usesServer, createServerClientSession, wakeServer, SERVER_HOST_KEY } from '../multi/server-session.js';
import { ERROR_TITLES } from '../multi/server-protocol.js';
import { createMixShare, forgetMixShare } from '../multi/mix-share.js';
import { mixBlockHtml, mixServerOnlyHtml, mixKey, onMixChange } from './room-mix.js';
import { icons, esc, toast, vibrate, store } from '../ui.js';
import {
  patch, connBadge, playersHtml, standingsHtml, answerPanelHtml, answerController, myResultHtml, songHtml,
  roundResultsHtml, winnerHtml, confettiHtml, viewBingoCard, viewTimeline, gameName,
  keepAwake, diagHtml, diagKey, diagVisible, leaderAwayHtml,
  quizQuestionHtml, quizRevealHtml, quizPodiumHtml, quizLeft, tickQuizClocks,
} from './room-ui.js';
import {
  createDiscoStage, discoController, discoAnswerHtml, discoCardHtml, cardStatsHtml, spinWaitHtml, discoMyResultHtml,
  discoResultsHtml, discoProgressHtml, discoRoundTitle,
} from './room-disco.js';
import { codeFieldHtml, onCodeInput, caretToEnd, createJoinHero, lobbyWaitHtml, lobbyPlayersHtml } from './room-join.js';

export const name = 'room-player';
const NAME_KEY = 'timetunesr.multiName.v1';

export function render(root, { params, navigate }) {
  const urlCode = normalizeCode(params?.[0] || '');
  // with a room server every phone talks to the server; without one, straight to the host (PeerJS)
  const viaServer = usesServer();
  if (viaServer) wakeServer(); // a sleeping free server starts waking up while the name is typed
  const join = storedJoin();
  let session = null;
  let unsub = null;
  let viewName = null;
  let joinError = '';
  let lastPhaseKey = '';
  let ms = null; // "Doe mijn favorieten erbij" (room server only)
  const regions = {};
  const keys = {};

  const ctl = answerController({
    getView: () => session?.view,
    send: (ans) => { session.answer(ans); vibrate(20); },
    refresh: () => draw(),
  });
  // Discobingo: the answer form of the round's category, and the disco ball (lives outside the patched regions)
  const dctl = discoController({
    getView: () => session?.view,
    send: (ans) => { session.answer(ans); vibrate(20); },
    refresh: () => draw(),
    sending: () => !!session?.pending,
  });
  let stage = null;
  const isDisco = () => session?.view?.game?.kind === 'disco';
  // the idle disco ball over the join form, "verbinden" and the lobby (one ball, moved between views)
  let hero = null;
  const heroViews = ['join', 'connecting', 'lobby'];
  const seenPlayers = new Set(); // lobby tiles already shown (new ones pop in)
  // what is typed in the join form, so a redraw (an error) keeps it
  const draft = {
    code: urlCode || join?.code || '',
    name: (join && (!urlCode || join.code === urlCode) ? join.name : store.get(NAME_KEY, '')) || '',
  };
  let shake = false;

  function start(code, nm) {
    session = viaServer ? createServerClientSession({ code, name: nm }) : createClientSession({ code, name: nm });
    unsub = session.subscribe(() => {
      const n = session.takeNotice();
      if (n) toast(n.message, { kind: 'warn' });
      if (session.meta?.leader && !session.meta.owner) { becomeLeader(); return; }
      ms?.sync(session.meta);
      draw();
    });
    if (viaServer) {
      const s = session;
      ms = createMixShare({ code, memberId: () => s.playerId, session: s, returnHash: `#/kamer/${code}`, onChange: () => draw() });
    }
    session.start();
    draw();
  }

  /** This phone took the lead: run the room from the spelleider screen (same place, same card). */
  function becomeLeader() {
    const ident = session.leadIdentity();
    if (!ident.token) return;
    store.set(SERVER_HOST_KEY, ident);
    unsub?.();
    ms?.destroy();
    ms = null;
    session.destroy();
    session = null;
    navigate('#/spelleider');
  }

  /** Seconds the leader has been away, counted on this phone from the server's figure. */
  let awayBase = null;
  function leaderAway() {
    const m = session?.meta;
    if (!viaServer || !m || m.leader || m.leaderOnline || session.status !== 'online') { awayBase = null; return null; }
    const key = `${m.leaderId}|${m.leaderAwayMs}`;
    if (!awayBase || awayBase.key !== key) awayBase = { key, at: Date.now() - m.leaderAwayMs };
    return Date.now() - awayBase.at;
  }

  function currentView() {
    if (!session) return 'join';
    if (session.error) return 'error';
    const v = session.view;
    if (!v) return 'connecting';
    return v.phase; // lobby | answering | revealed | won
  }

  function skeleton(vn) {
    stage?.destroy();
    stage = null;
    const withHero = heroViews.includes(vn);
    if (hero && !withHero) { hero.destroy(); hero = null; } // the game screens bring their own ball
    const code = session?.code || urlCode || '';
    root.innerHTML = `<section class="screen screen-room view-${vn}${withHero ? ' has-hero' : ''}" data-testid="screen-room-player" data-view="${vn}" data-code="${esc(code)}">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
        <h1 class="topbar-title">${session ? `Kamer <span class="room-code-inline" data-testid="room-code">${esc(code)}</span>` : 'Doe mee'}</h1>
        ${session && !session.error ? '<button class="btn btn-small btn-ghost" type="button" data-action="leave" data-testid="room-leave">Verlaat</button>' : '<span class="topbar-spacer"></span>'}
      </header>
      <div class="room-status" data-region="status"></div>
      ${withHero ? '<div class="join-hero" data-slot="hero"></div>' : ''}
      <div data-region="round"></div>
      <div class="disco-stage-host" data-region="stage"></div>
      <div class="room-main" data-region="main"></div>
      <div class="room-side" data-region="players"></div>
      <div class="room-mix" data-region="mix"></div>
    </section>`;
    regions.stage = root.querySelector('[data-region="stage"]');
    for (const k of ['status', 'round', 'main', 'players', 'mix']) { regions[k] = root.querySelector(`[data-region="${k}"]`); keys[k] = null; }
    if (withHero) {
      if (!hero) hero = createJoinHero();
      hero.place(root.querySelector('[data-slot="hero"]'));
    }
    const h = root.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function region(name, key, build) {
    if (keys[name] === key) return;
    keys[name] = key;
    patch(regions[name], build());
  }

  function draw() {
    const vn = currentView();
    if (vn !== viewName) { viewName = vn; skeleton(vn); window.scrollTo(0, 0); }
    ctl.sync();
    dctl.sync();
    const v = session?.view;
    const phaseKey = v ? `${v.phase}:${v.game?.round}` : '';
    if (phaseKey !== lastPhaseKey) {
      if (lastPhaseKey && v?.phase === 'revealed') vibrate(v.game.reveal?.mine?.correct ? [40, 40, 80] : [60]);
      if (lastPhaseKey && v?.phase === 'answering') vibrate(30);
      lastPhaseKey = phaseKey;
    }
    const st = session ? session.status : null;
    const away = leaderAway();
    const showDiag = viaServer && session && !session.error && vn !== 'connecting' && diagVisible(session.diag, st);
    const extraKey = viaServer ? JSON.stringify([away == null ? null : Math.min(Math.floor(away / 1000), 999), showDiag ? diagKey(session.diag) : '']) : '';
    region('status', JSON.stringify([st, vn, session?.error?.code, extraKey]), () => (session && !session.error ? statusHtml(st, away, showDiag) : ''));
    region('players', JSON.stringify([vn, v?.players, v?.you?.id]), () => (v && !['join', 'error', 'connecting'].includes(vn)
      ? vn === 'lobby' ? lobbyPlayersHtml(v, seenPlayers) : `<h2 class="room-h">Spelers</h2>${playersHtml(v)}` : ''));
    const landed = syncStage(v, vn);
    // Discobingo: the round line sits above the ball
    region('round', isDisco() && (vn === 'answering' || vn === 'revealed') ? `${v.game.round}|${v.game.disco.win}` : '', () => (isDisco() && (vn === 'answering' || vn === 'revealed') ? discoRoundTitle(v) : ''));
    const build = { join: joinHtml, connecting: connectingHtml, error: errorHtml, lobby: lobbyHtml, answering: answeringHtml, revealed: revealedHtml, won: wonHtml }[vn];
    const quiz = v?.game?.kind === 'quiz';
    const now = serverNow();
    const mainKey = vn === 'answering' && isDisco() ? `d|${dctl.key()}|${landed}|${!!session.pending}`
      : vn === 'answering' && quiz
      ? JSON.stringify(['q', v.game.round, v.game.quiz.options, v.game.quiz.choice, !!v.game.quiz.deadline, quizLeft(v.game.quiz, now) > 0, !!session.pending, v.game.quiz.answered, !!v.game.mine])
      : vn === 'answering' ? `a|${ctl.key()}|${!!session.pending}` : JSON.stringify([vn, joinError, v?.game, v?.settings, v?.you, session?.error, st === 'notfound', vn === 'connecting' && session?.diag ? [st, diagKey(session.diag)] : '']);
    region('main', mainKey, build);
    if (vn === 'join') afterJoinDraw();
    const inRoom = v && ['lobby', 'answering', 'revealed', 'won'].includes(vn);
    region('mix', inRoom ? `${vn === 'lobby'}|${v.settings.music}|${viaServer ? mixKey(ms, session.meta) : 'p2p'}` : '', () => {
      if (!inRoom) return '';
      if (!viaServer || !ms) return vn === 'lobby' ? mixServerOnlyHtml() : '';
      return mixBlockHtml(ms, session.meta, { inGame: vn !== 'lobby', music: v.settings.music });
    });
  }

  function serverNow() { return session?.serverNow ? session.serverNow() : Date.now(); }

  /** Discobingo: the ball spins once per round, then the question appears. Returns: has it landed? */
  function syncStage(v, vn) {
    const el = regions.stage;
    if (!el) return true;
    if (!(isDisco() && (vn === 'answering' || vn === 'revealed'))) {
      if (stage) { stage.destroy(); stage = null; }
      return true;
    }
    if (!stage) stage = createDiscoStage(el, { onLand: () => { if (session?.view?.phase === 'answering') vibrate(30); draw(); } });
    stage.sync(v.game.disco, { now: serverNow(), phase: v.phase, round: v.game.round });
    return stage.landed;
  }

  function statusHtml(st, away, showDiag) {
    let out = connBadge(st);
    if (away != null) out += leaderAwayHtml(session.meta, { awayMs: away });
    if (showDiag) out += diagHtml(session.diag, { role: 'player', code: session.code });
    return out;
  }

  // ---------- views ----------
  function joinHtml() {
    const fromLink = !!urlCode && draft.code === urlCode;
    return `<form class="join-form" data-testid="join-form" autocomplete="off" novalidate>
      ${codeFieldHtml(draft.code, { fromLink })}
      <div class="join-field">
        <label class="join-label" for="join-name">Jouw naam</label>
        <input id="join-name" class="join-name" type="text" name="name" maxlength="24" placeholder="Bijvoorbeeld Sam" value="${esc(draft.name)}" data-testid="join-name" autocomplete="nickname" autocapitalize="words" enterkeyhint="go">
      </div>
      <p class="warn join-error" data-testid="join-error" role="alert" ${joinError ? '' : 'hidden'}>${esc(joinError)}</p>
      <button class="btn btn-primary btn-xl join-submit" type="submit" data-testid="join-submit">${icons.users}<span>Doe mee</span></button>
      <p class="muted small center join-note">Je speelt op je eigen telefoon; de muziek komt uit de speaker van de spelleider.</p>
      ${viaServer ? '' : '<p class="muted small center p2p-note" data-testid="multi-p2p-note">Er is geen server ingesteld: je telefoon verbindt rechtstreeks met die van de spelleider. Op sommige netwerken lukt dat niet.</p>'}
    </form>`;
  }

  /** After the join form was (re)drawn: focus where the guest has to type, shake a wrong code. */
  let joinFocused = false;
  function afterJoinDraw() {
    const boxes = root.querySelector('.code-boxes');
    if (shake && boxes) {
      shake = false;
      boxes.classList.remove('is-shake');
      void boxes.offsetWidth; // restart the animation
      boxes.classList.add('is-shake');
    }
    if (joinFocused) return;
    joinFocused = true;
    // from the QR code / link: the code is there, the name is what is left
    // (after the router has put focus on the title)
    if (urlCode && draft.code === urlCode) {
      setTimeout(() => {
        const a = document.activeElement;
        if (viewName === 'join' && (!a || a === document.body || a.matches('h1, h2'))) root.querySelector('[data-testid="join-name"]')?.focus({ preventScroll: true });
      }, 0);
    }
  }

  function connectingHtml() {
    if (session.isServer) return serverConnectingHtml();
    const nf = session.status === 'notfound';
    return `<div class="room-wait" data-testid="room-connecting">
      <div class="room-spinner" aria-hidden="true"></div>
      <h2>${nf ? `Kamer ${esc(session.code)} niet gevonden` : `Verbinden met kamer ${esc(session.code)}…`}</h2>
      <p class="muted">${nf ? 'Klopt de code? Staat het scherm van de spelleider nog aan? We blijven het proberen.' : 'Even geduld, je telefoon zoekt de spelleider.'}</p>
      <div class="stack">
        <button class="btn btn-ghost" type="button" data-action="retry" data-testid="room-retry">${icons.restart}<span>Nu opnieuw proberen</span></button>
        ${nf ? `<button class="btn btn-ghost" type="button" data-action="other-code" data-testid="room-other-code">${icons.back}<span>Andere code</span></button>` : ''}
      </div>
    </div>`;
  }

  /** Via the server: what works and what does not, step by step. */
  function serverConnectingHtml() {
    const st = session.status;
    const nf = st === 'notfound';
    const lost = nf && session.wasInRoom;
    const show = diagVisible(session.diag, st);
    const down = st === 'unreachable';
    const title = lost ? `Kamer ${esc(session.code)} is even weg`
      : nf ? `Kamer ${esc(session.code)} niet gevonden`
        : st === 'waking' ? `Kamer ${esc(session.code)} openen…`
          : down ? 'Server niet bereikbaar'
            : `Verbinden met kamer ${esc(session.code)}…`;
    const sub = lost ? 'Waarschijnlijk is de server opnieuw gestart. Zodra de spelleider de app weer open heeft, zet die de kamer terug en ga je vanzelf verder.'
      : nf ? 'Klopt de code? We blijven zoeken.'
        : st === 'waking' ? 'Even geduld: de server start op.'
          : down ? 'We blijven het proberen. Hieronder staat wat er misgaat en wat je kunt doen.'
            : 'Even geduld, je telefoon zoekt de kamer.';
    return `<div class="room-wait" data-testid="room-connecting" data-state="${esc(st)}">
      ${show ? '' : '<div class="room-spinner" aria-hidden="true"></div>'}
      <h2>${title}</h2>
      <p class="muted">${sub}</p>
      ${show ? diagHtml(session.diag, { role: 'player', code: session.code }) : `<div class="stack"><button class="btn btn-ghost" type="button" data-action="retry" data-testid="room-retry">${icons.restart}<span>Nu opnieuw proberen</span></button></div>`}
      ${nf ? `<div class="stack"><button class="btn btn-ghost" type="button" data-action="other-code" data-testid="room-other-code">${icons.back}<span>Andere code</span></button></div>` : ''}
    </div>`;
  }

  function errorHtml() {
    const e = session.error;
    const title = { ...ERROR_TITLES, version: 'Andere versie van de app', removed: 'Je bent verwijderd', closed: 'De kamer is gesloten', full: 'De kamer is vol', room: 'Kamer bestaat niet meer', replaced: 'Je speelt elders verder' }[e.code] || 'Dat lukte niet';
    return `<div class="room-wait room-error" data-testid="room-error" data-code="${esc(e.code)}">
      <h2>${esc(title)}</h2>
      <p>${esc(e.message || '')}</p>
      <div class="stack">
        ${e.code === 'version' ? `<button class="btn btn-primary" type="button" data-action="reload" data-testid="room-reload">${icons.restart}<span>Pagina verversen</span></button>` : ''}
        ${e.code === 'replaced' ? `<button class="btn btn-primary" type="button" data-action="reload" data-testid="room-reload">${icons.restart}<span>Toch hier verder spelen</span></button>` : ''}
        ${!['version', 'replaced'].includes(e.code) ? `<button class="btn btn-primary" type="button" data-action="other-code" data-testid="room-other-code">${icons.users}<span>Andere kamer</span></button>` : ''}
        <a class="btn btn-ghost" href="#/" data-testid="room-home">${icons.home}<span>Naar start</span></a>
      </div>
    </div>`;
  }

  function lobbyHtml() {
    return lobbyWaitHtml(session.view);
  }

  function roundTitle(v) {
    const g = v.game;
    if (g.kind === 'quiz') return `<p class="room-round" data-testid="room-round"><b>Quiz</b> · vraag ${g.round} van ${g.quiz.total}${g.mine ? ` · <span data-testid="quiz-my-score">${g.mine.score} punten</span>` : ''}</p>`;
    return `<p class="room-round" data-testid="room-round"><b>${esc(gameName(g.kind))}</b> · ronde ${g.round}${g.kind === 'timeline' ? ` · doel ${g.goal}` : ''}</p>`;
  }

  function answeringHtml() {
    const v = session.view;
    if (v.game.kind === 'disco') {
      const landed = stage ? stage.landed : true;
      return `${landed ? `<div class="listen-hint" data-testid="listen-hint">${icons.music}<span>Luister naar de muziek bij de spelleider.</span></div>
      ${discoAnswerHtml(v, dctl.local, { sending: !!session.pending })}` : spinWaitHtml()}
      ${v.game.mine ? `<h2 class="room-h">Jouw kaart</h2>${discoCardHtml(v.game.mine, { cat: landed ? v.game.disco.cat : null, name: v.you?.name })}${cardStatsHtml(v.game.mine, v.game.disco.win)}` : ''}`;
    }
    if (v.game.kind === 'quiz') {
      return `${roundTitle(v)}
      <div class="listen-hint" data-testid="listen-hint">${icons.music}<span>Luister naar de muziek bij de spelleider.</span></div>
      ${quizQuestionHtml(v, { selectable: true, serverNow: serverNow(), sending: !!session.pending })}`;
    }
    return `${roundTitle(v)}
      <div class="listen-hint" data-testid="listen-hint">${icons.music}<span>Luister naar de muziek bij de spelleider.</span></div>
      ${answerPanelHtml(v, ctl.choice, { sending: !!session.pending })}`;
  }

  function ownAfter(v) {
    const g = v.game;
    if (!g.mine) return '';
    if (g.kind === 'disco') {
      const d = g.disco;
      const choosing = v.phase === 'revealed' && g.reveal?.mine?.correct && !d.waitingForHost && d.choosable.length > 0;
      return `${discoCardHtml(g.mine, { mode: choosing ? 'choose' : 'show', choosable: d.choosable, choice: d.choice, cat: d.cat, name: v.you?.name })}${cardStatsHtml(g.mine, d.win)}`;
    }
    if (g.kind === 'bingo') {
      const r = g.reveal?.mine;
      return viewBingoCard(v, { highlight: r && !r.none && !r.pass ? r.index : null });
    }
    const song = g.reveal?.song;
    const idx = song && g.reveal?.mine?.correct ? g.mine.timeline.findIndex((c) => c.year === song.year && c.title === song.title && c.artist === song.artist) : null;
    return `<details class="final-tl" ${g.mine.timeline.length <= 6 ? 'open' : ''}><summary>Jouw tijdlijn · ${g.mine.timeline.length} van ${g.goal}</summary>${viewTimeline(g.mine.timeline, { highlight: idx })}</details>`;
  }

  function revealedHtml() {
    const v = session.view;
    if (v.game.kind === 'disco') {
      return `${discoMyResultHtml(v)}
      ${ownAfter(v)}
      ${songHtml(v)}
      <h2 class="room-h">Wat zei iedereen?</h2>
      ${discoResultsHtml(v)}
      <h2 class="room-h">Voortgang</h2>
      ${discoProgressHtml(v)}
      <p class="muted center" data-testid="room-next-wait">Wacht tot de spelleider de discobal weer laat draaien…</p>`;
    }
    if (v.game.kind === 'quiz') {
      return `${roundTitle(v)}${quizRevealHtml(v)}
      <p class="muted center" data-testid="room-next-wait">${v.game.quiz.reveal?.last ? 'Dat was de laatste vraag. Zo komt het podium…' : 'Wacht op de volgende vraag…'}</p>`;
    }
    const rw = v.game.reveal?.roundWinners || [];
    return `${roundTitle(v)}
      ${myResultHtml(v)}
      ${songHtml(v)}
      ${rw.length ? `<p class="room-bingo-call" data-testid="room-round-winners">${v.game.kind === 'bingo' ? 'Bingo' : 'Doel gehaald'}: ${rw.map(esc).join(' & ')}!</p>` : ''}
      ${ownAfter(v)}
      <h2 class="room-h">Deze ronde</h2>
      ${roundResultsHtml(v)}
      <h2 class="room-h">Tussenstand</h2>
      ${standingsHtml(v)}
      <p class="muted center" data-testid="room-next-wait">Wacht op het volgende nummer…</p>`;
  }

  function wonHtml() {
    const v = session.view;
    if (v.game.kind === 'quiz') return `${confettiHtml()}${quizPodiumHtml(v)}<p class="muted center">Wacht tot de spelleider een nieuwe quiz start.</p>`;
    const me = v.you && v.game.winnerIds.includes(v.you.id);
    return `${confettiHtml()}
      ${winnerHtml(v)}
      ${me ? '<p class="room-you-won" data-testid="room-you-won">Gefeliciteerd, jij hebt gewonnen!</p>' : ''}
      ${v.game.kind === 'disco' ? discoProgressHtml(v) : standingsHtml(v)}
      ${ownAfter(v)}
      <p class="muted center">Wacht tot de spelleider een nieuw potje start.</p>`;
  }

  // ---------- events ----------
  function onSubmit(e) {
    if (!e.target.matches('.join-form')) return;
    e.preventDefault();
    const f = e.target;
    draft.code = f.code.value;
    draft.name = f.name.value;
    const code = normalizeCode(f.code.value);
    const nm = cleanName(f.name.value, '');
    if (!code) { joinError = 'Vul de kamercode in: 4 letters, bijvoorbeeld KMRT.'; shake = true; keys.main = null; draw(); root.querySelector('[data-testid="join-code"]')?.focus(); return; }
    if (!nm) { joinError = 'Vul je naam in.'; keys.main = null; draw(); root.querySelector('[data-testid="join-name"]')?.focus(); return; }
    joinError = '';
    store.set(NAME_KEY, nm);
    store.set('timetunesr.multiJoin.v1', { code, name: nm });
    if (urlCode !== code) { navigate(`#/kamer/${code}`); return; }
    start(code, nm);
  }

  function onClick(e) {
    const pick = e.target.closest('[data-action="quiz-pick"]');
    if (pick && root.contains(pick)) {
      if (!pick.disabled && session?.view?.game?.kind === 'quiz') { session.answer({ choice: Number(pick.dataset.choice) }); vibrate(20); }
      return;
    }
    const sq = e.target.closest('[data-action="disco-stamp"]');
    if (sq && root.contains(sq)) {
      const v = session?.view;
      if (v?.phase === 'revealed' && v.game?.kind === 'disco' && Number(sq.dataset.index) !== v.game.disco.choice) { session.stamp(Number(sq.dataset.index)); vibrate(25); }
      return;
    }
    if (isDisco()) { if (dctl.onClick(e)) return; } else if (session?.view && session.view.game?.kind !== 'quiz' && ctl.onClick(e)) return;
    const a = e.target.closest('[data-action]');
    if (!a || !root.contains(a)) return;
    switch (a.dataset.action) {
      case 'leave':
        if (!window.confirm('Wil je de kamer verlaten? Je kunt later opnieuw meedoen, maar met een nieuwe kaart.')) return;
        forgetMixShare(session.code);
        ms?.destroy();
        ms = null;
        session.leave();
        setTimeout(() => navigate('#/'), 250); // let the goodbye reach the host first
        break;
      case 'retry': session?.retry(); break;
      case 'mix-share': ms?.share(); break;
      case 'mix-withdraw': ms?.withdraw(); break;
      case 'takeover': session?.takeOver?.(); break;
      case 'copy-diag':
        session?.copyDiag?.().then((ok) => toast(ok ? 'Diagnose gekopieerd. Plak hem in een bericht.' : 'Kopiëren lukte niet.', { kind: ok ? 'info' : 'warn' }));
        break;
      case 'reload': location.reload(); break;
      case 'other-code':
        if (session) { ms?.destroy(); ms = null; session.destroy(); unsub?.(); session = null; }
        forgetJoin();
        navigate('#/kamer');
        break;
      default:
    }
  }

  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  const onInput = (e) => {
    if (!session && joinError && e.target.closest?.('.join-form')) {
      joinError = ''; // typing again: the old complaint goes (without a redraw, the keyboard stays)
      const el = root.querySelector('[data-testid="join-error"]');
      if (el) el.hidden = true;
    }
    if (!session && e.target.matches?.('[data-testid="join-code"]')) {
      const before = draft.code.length;
      const c = onCodeInput(e.target);
      draft.code = c.value;
      // all four letters (typed or pasted) and a real code: on to the name
      if (before < 4 && c.value.length === 4 && !c.bad) e.target.form?.querySelector('[data-testid="join-name"]')?.focus();
      return;
    }
    if (!session && e.target.matches?.('[data-testid="join-name"]')) { draft.name = e.target.value; return; }
    return isDisco() ? dctl.onInput(e) : ctl.onInput(e);
  };
  // the code cells show the text from the start: the (invisible) caret stays at the end
  const onFocusIn = (e) => { if (e.target.matches?.('[data-testid="join-code"]')) caretToEnd(e.target); };
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('pointerup', onFocusIn);
  const onKeyDown = (e) => (isDisco() ? dctl.onKeyDown(e) : ctl.onKeyDown(e));
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeyDown);
  const onChange = (e) => { if (onMixChange(ms, e)) draw(); };
  root.addEventListener('change', onChange);

  const releaseAwake = keepAwake();
  // Back in the same room (reload, phone woke up, link opened again): join without asking.
  if (join && (urlCode ? join.code === urlCode : false)) start(join.code, join.name);
  else draw();

  // for tests / debugging: what this phone received from the host
  window.__ttRoom = { get session() { return session; } };
  // connection steps and the leader-away countdown count seconds
  const ticker = viaServer ? setInterval(() => { if (session && !session.error && (session.status !== 'online' || leaderAway() != null)) draw(); }, 1000) : 0;
  // the quiz clock runs on screen between server messages; when it runs out the buttons close
  const quizTicker = viaServer ? setInterval(() => {
    if (session?.view?.game?.kind !== 'quiz' || session.view.phase !== 'answering') return;
    if (tickQuizClocks(root, serverNow())) draw();
  }, 250) : 0;

  return () => {
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKeyDown);
    root.removeEventListener('focusin', onFocusIn);
    root.removeEventListener('pointerup', onFocusIn);
    stage?.destroy();
    hero?.destroy();
    hero = null;
    root.removeEventListener('change', onChange);
    releaseAwake();
    clearInterval(ticker);
    clearInterval(quizTicker);
    unsub?.();
    ms?.destroy();
    session?.destroy();
  };
}
