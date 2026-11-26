// "Samen spelen", host side (#/spelleider): make a room, show the code + QR, play the
// hidden song on this device (on a speaker), reveal, judge, next song. The host may play
// along on the same device; that panel is built from the same player view as a phone.
import * as player from '../player.js';
import { playableCards, PREFERRED_GAME } from '../multi/game.js';
import { DISCO_MIN_SONGS } from '../multi/disco.js';
import { createHostSession, storedRoom } from '../multi/host-session.js';
import { usesServer, createServerHostSession, storedServerHost } from '../multi/server-session.js';
import { DEFAULT_GOAL } from '../logic.js';
import { QUIZ_COUNTS, QUIZ_TIMES, QUIZ_MIN_SONGS, quizTypesFor } from '../multi/quiz.js';
import * as spotify from '../spotify.js';
import { createMixShare, forgetMixShare } from '../multi/mix-share.js';
import {
  mixBlockHtml, mixServerOnlyHtml, mixKey, onMixChange, mixShortage,
} from './room-mix.js';
import { icons, esc, toast, vibrate, store } from '../ui.js';
import { playerViewHtml, mountPlayerView } from './playerview.js';
import {
  patch, connBadge, playersHtml, standingsHtml, answerPanelHtml, answerController, myResultHtml, songHtml,
  roundResultsHtml, winnerHtml, confettiHtml, viewBingoCard, viewTimeline, gameName, qrSvg, roomLink,
  keepAwake, diagHtml, diagKey, diagVisible,
  quizQuestionHtml, quizRevealHtml, quizPodiumHtml, quizLeft, tickQuizClocks,
} from './room-ui.js';
import {
  createDiscoStage, discoLandedAt, discoController, discoAnswerHtml, discoCardHtml, cardStatsHtml, spinWaitHtml,
  discoMyResultHtml, regieHtml, discoProgressHtml, nextButtonHtml, discoLobbyHtml,
} from './room-disco.js';

export const name = 'room-host';
const HOST_NAME_KEY = 'timetunesr.multiName.v1';
const SETTINGS_KEY = 'timetunesr.multiSettings.v1';
/** A laptop or tv: the big ball keeps turning while the song plays. */
const wide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 900px)').matches;

export function render(root, { deck, navigate }) {
  const cards = playableCards(deck.cards.filter((c) => c.previewUrl || c.itunesId || c.spotifyId));
  // with a room server the server holds the room; without one this phone does (PeerJS)
  const viaServer = usesServer();
  let session = viaServer ? createServerHostSession() : createHostSession();
  let unsub = session.subscribe(() => {
    const n = session.takeNotice?.();
    if (n) toast(n.message, { kind: 'warn' });
    if (session.lostLead) { handBack(); return; }
    ms?.sync(session.meta);
    draw();
  });
  /** Music source of this phone: whole songs via Spotify, or the 30-second fragments. */
  const playSource = () => (spotify.getSettings().source === 'spotify' && spotify.isConnected() ? 'spotify' : 'preview');

  /** The own mix panel belongs to this room and this phone's place in it. */
  function ensureMix() {
    if (!viaServer || !session) return;
    const code = session.code;
    const id = session.memberId;
    const key = code && id ? `${code}|${id}` : '';
    if (key === msFor) return;
    ms?.destroy();
    ms = null;
    msFor = key;
    if (!key) return;
    const s = session;
    ms = createMixShare({ code, memberId: () => s.memberId, session: s, returnHash: '#/spelleider', onChange: () => draw() });
  }
  let viewName = null;
  let drawnKind = '';
  let unmountPv = null;
  let loadedFor = null; // "round:cardId" loaded in the hidden player
  let startedHere = false; // a round started by a tap on this page may autoplay
  let sheetOpen = false;
  let ms = null; // this phone's own "Doe mijn favorieten erbij" (room server only)
  let msFor = '';
  const regions = {};
  const keys = {};

  const ctl = answerController({
    getView: () => session.hostView(),
    send: (ans) => {
      try { session.answer(ans); vibrate(20); } catch (e) { toast(e.message, { kind: 'warn' }); }
    },
    refresh: () => draw(),
  });
  // Discobingo: the spelleider's own answer form (playing along), the disco ball, the delayed music start
  const dctl = discoController({
    getView: () => session.hostView(),
    send: (ans) => {
      try { session.answer(ans); vibrate(20); } catch (e) { toast(e.message, { kind: 'warn' }); }
    },
    refresh: () => draw(),
  });
  let stage = null;
  let discoPlayFor = null; // "round:songId" that starts playing once the ball has landed
  /** Discobingo is running (not the lobby). */
  const inDisco = () => session?.room?.game?.kind === 'disco' && session.room.phase !== 'lobby';

  const spectator = () => session.spectatorView();
  /** A quiz is running (not the lobby). */
  const inQuiz = () => session?.room?.game?.kind === 'quiz' && session.room.phase !== 'lobby';
  const serverNow = () => (session?.serverNow ? session.serverNow() : Date.now());
  const quizTypes = quizTypesFor(cards);
  let reportedFor = { key: '', at: 0 }; // when this phone last told the server that the music plays
  let quizSending = null; // round of an own quiz answer on its way
  /** Via the server: may this phone run the room (reveal, next ...)? */
  const leads = () => !viaServer || !!session.meta?.leader;

  function currentView() {
    const r = session.room;
    if (!r && viaServer && session.connecting) return 'connecting';
    return r ? r.phase : 'setup';
  }

  /** A player who took the lead and lost it again goes back to the player screen. */
  function handBack() {
    const code = session.code;
    session.forget?.();
    navigate(code ? `#/kamer/${code}` : '#/kamer');
  }

  function skeleton(vn) {
    if (unmountPv) { unmountPv(); unmountPv = null; }
    stage?.destroy();
    stage = null;
    for (const k of Object.keys(regions)) delete regions[k];
    const r = session.room;
    const code = r?.code || session.code || '';
    const quit = r ? '<button class="btn btn-small btn-ghost" type="button" data-action="close-room" data-testid="host-close">Sluiten</button>' : '<span class="topbar-spacer"></span>';
    let body = {
      setup: '<div data-region="main"></div>',
      connecting: '<div data-region="main"></div>',
      lobby: `<div data-region="status"></div><div data-region="join"></div><div data-region="players"></div><div data-region="main"></div><div data-region="mix"></div><div data-region="cta"></div>`,
      answering: `<div data-region="status"></div><div data-region="quiz"></div>
        <div class="place-player" data-region="pv">${playerViewHtml({ compact: true })}</div>
        <div data-region="players"></div><div data-region="own"></div><div data-region="mix"></div><div data-region="cta"></div>`,
      revealed: `<div data-region="status"></div><div data-region="main"></div>
        <div class="place-player" data-region="pv">${playerViewHtml({ compact: true })}</div>
        <div data-region="own"></div><div data-region="players"></div><div data-region="mix"></div><div data-region="cta"></div>`,
      won: '<div data-region="status"></div><div data-region="main"></div><div data-region="players"></div><div data-region="mix"></div>',
    }[vn];
    const quiz = r?.game?.kind === 'quiz' && vn !== 'lobby';
    const disco = r?.game?.kind === 'disco' && vn !== 'lobby';
    // Discobingo: on a laptop / tv the ball (and the song after the reveal) on the left, the controls on the right
    const pv = `<div class="place-player" data-region="pv">${playerViewHtml({ compact: true })}</div>`;
    const discoBody = {
      answering: `<div data-region="status"></div>
        <div class="disco-host">
          <div class="disco-host-show"><div class="disco-stage-host" data-region="stage"></div><div data-region="song"></div><div data-region="progress"></div></div>
          <div class="disco-host-ctl">${pv}<div data-region="players"></div><div data-region="own"></div><div data-region="mix"></div><div data-region="cta"></div></div>
        </div>`,
      revealed: `<div data-region="status"></div>
        <div class="disco-host">
          <div class="disco-host-show"><div class="disco-stage-host" data-region="stage"></div><div data-region="song"></div><div data-region="progress"></div></div>
          <div class="disco-host-ctl"><div data-region="main"></div>${pv}<div data-region="own"></div><div data-region="players"></div><div data-region="mix"></div><div data-region="cta"></div></div>
        </div>`,
    }[vn];
    if (disco && discoBody) body = discoBody;
    document.body.classList.toggle('tt-quiz', quiz); // wide screens: the quiz big enough to read from the couch
    document.body.classList.toggle('tt-disco', disco);
    root.innerHTML = `<section class="screen screen-room screen-room-host view-${vn}${quiz ? ' is-quiz' : ''}${disco ? ' is-disco' : ''}" data-testid="screen-room-host" data-view="${vn}" data-code="${esc(code)}">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
        <h1 class="topbar-title">${r || vn === 'connecting' ? `Kamer <span class="room-code-inline" data-testid="room-code">${esc(code)}</span>` : 'Maak een kamer'}</h1>
        ${quit}
      </header>
      ${body}
      <div data-region="sheet"></div>
    </section>`;
    for (const el of root.querySelectorAll('[data-region]')) { regions[el.dataset.region] = el; keys[el.dataset.region] = null; }
    if (regions.pv) unmountPv = mountPlayerView(regions.pv);
    const h = root.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function region(nm, key, build) {
    if (!regions[nm] || keys[nm] === key) return;
    keys[nm] = key;
    patch(regions[nm], build());
  }

  /** Discobingo: the ball spins once per round on this screen too. Returns: has it landed? */
  function syncStage(vn) {
    const sv = spectator();
    if (!regions.stage || !inDisco() || !sv?.game?.disco || (vn !== 'answering' && vn !== 'revealed')) return true;
    if (!stage) stage = createDiscoStage(regions.stage, { big: wide(), onLand: () => draw() });
    stage.sync(sv.game.disco, { now: serverNow(), phase: session.room.phase, round: sv.game.round });
    return stage.landed;
  }
  const discoLanded = () => (stage ? stage.landed : serverNow() >= discoLandedAt(spectator()?.game?.disco));

  /** Keep the hidden player on the running song. */
  function syncAudio() {
    const r = session.room;
    const g = r?.game;
    const song = g && r.phase !== 'won' && r.phase !== 'lobby' ? session.currentSong() : null;
    if (!song) {
      if (loadedFor) { player.stop(); loadedFor = null; }
      discoPlayFor = null;
      return;
    }
    const k = `${g.round}:${song.id}`;
    if (k === loadedFor) {
      // Discobingo: the music starts when the ball has landed (the round was started by a tap here)
      if (discoPlayFor === k && discoLanded()) { discoPlayFor = null; player.play(); }
      return;
    }
    loadedFor = k;
    if (g.kind === 'disco' && r.phase === 'answering') {
      // load now (so it is ready), play once the ball lands; the tap that started the round unlocked the audio
      player.load(song, { autoplay: false });
      discoPlayFor = startedHere ? k : null;
      startedHere = false;
      if (discoPlayFor && discoLanded()) { discoPlayFor = null; player.play(); }
      return;
    }
    discoPlayFor = null;
    player.load(song, { autoplay: startedHere });
    if (startedHere) player.play(); // inside the tap where possible (iOS)
    startedHere = false;
  }

  function draw() {
    const vn = currentView();
    const kind = session.room?.game?.kind || '';
    if (vn !== viewName || kind !== drawnKind) { viewName = vn; drawnKind = kind; skeleton(vn); window.scrollTo(0, 0); }
    const landed = syncStage(vn);
    syncAudio();
    ctl.sync();
    dctl.sync();
    const r = session.room;
    root.querySelector('[data-testid="screen-room-host"]').dataset.code = r?.code || session.code || '';
    const codeEl = root.querySelector('[data-testid="room-code"]');
    if (codeEl && r && codeEl.textContent !== r.code) codeEl.textContent = r.code;
    if (vn === 'connecting') { region('main', `c|${session.code}|${diagKey(session.diag)}|${session.status}`, connectingHtml); return; }
    if (!r) { region('main', `setup|${viaServer ? session.error?.message || '' : ''}`, setupHtml); return; }
    const sv = spectator();
    const m = session.meta;
    const serverKey = viaServer ? JSON.stringify([m?.leader, m?.leaderName, m?.owner, diagVisible(session.diag, session.status) ? diagKey(session.diag) : '']) : '';
    region('status', JSON.stringify([session.status, r.code, r.phase, r.game?.round, r.game?.kind, serverKey]), () => statusHtml(sv));
    region('join', JSON.stringify([r.code]), () => joinBoxHtml(r.code));
    region('players', JSON.stringify([sv.players, r.phase]), () => playersBlock(sv));
    region('sheet', JSON.stringify([sheetOpen, r.code]), () => (sheetOpen ? sheetHtml(r.code) : ''));
    // a spelleider screen that does not lead (somebody took over) does not play the music;
    // Discobingo: the player appears when the ball has landed (that is when the music starts)
    if (regions.pv) regions.pv.hidden = !leads() || (inDisco() && vn === 'answering' && !landed);
    ensureMix();
    const mixMeta = viaServer ? JSON.stringify([m?.mix, playSource()]) : '';
    region('mix', `${vn}|${r.settings.music}|${viaServer ? mixKey(ms, m) : 'p2p'}`, () => {
      if (!viaServer) return vn === 'lobby' ? mixServerOnlyHtml() : '';
      return ms ? mixBlockHtml(ms, m, { inGame: vn !== 'lobby', music: r.settings.music, leader: true }) : '';
    });
    if (vn === 'lobby') {
      region('main', JSON.stringify([r.settings, r.players.length, mixMeta, leads()]), lobbyHtml);
      region('cta', JSON.stringify([r.players.length, r.settings, leads(), mixMeta]), () => (leads() ? lobbyCta() : ''));
    } else if (vn === 'answering' && kind === 'disco') {
      region('progress', JSON.stringify([sv.game.disco.progress]), () => `<h2 class="room-h">Voortgang</h2>${discoProgressHtml(sv)}`);
      const hv = session.hostView();
      region('own', `${dctl.key()}|${landed}`, () => (hv ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw antwoord, ${esc(hv.you.name)}</h2>${landed ? discoAnswerHtml(hv, dctl.local) : spinWaitHtml()}${hv.game?.mine ? discoCardHtml(hv.game.mine, { cat: landed ? hv.game.disco.cat : null, testid: 'host-disco-card', name: hv.you.name }) : ''}</section>` : ''));
      region('cta', JSON.stringify([sv.players, leads()]), () => (leads() ? revealCta(sv) : ''));
    } else if (vn === 'answering' && kind === 'quiz') {
      const now = serverNow();
      const q = sv.game.quiz;
      region('quiz', JSON.stringify([sv.game.round, q.options, q.deadline, q.answered, q.playing]), () => quizQuestionHtml(sv, { serverNow: now }));
      const hv = session.hostView();
      const hq = hv?.game?.quiz;
      if (quizSending != null && (hq?.choice != null || hv?.game?.round !== quizSending)) quizSending = null;
      region('own', JSON.stringify([hv?.game?.round, hq?.choice, !!hq?.deadline, quizLeft(hq, now) > 0, !!hv?.game?.mine, quizSending]), () => (hv ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw antwoord, ${esc(hv.you.name)}</h2>${quizQuestionHtml(hv, { selectable: true, serverNow: now, sending: quizSending != null, testid: 'quiz-own-question', own: true })}</section>` : ''));
      region('cta', JSON.stringify([sv.players, leads()]), () => (leads() ? revealCta(sv) : ''));
      reportPlaying();
    } else if (vn === 'answering') {
      const hv = session.hostView();
      region('own', `${ctl.key()}`, () => (hv ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw antwoord, ${esc(hv.you.name)}</h2>${answerPanelHtml(hv, ctl.choice)}</section>` : ''));
      region('cta', JSON.stringify([sv.players, leads()]), () => (leads() ? revealCta(sv) : ''));
    } else if (vn === 'revealed' && kind === 'quiz') {
      region('main', JSON.stringify([sv.game.quiz, sv.game.round]), () => `${quizRevealHtml(sv, { host: true })}`);
      const hv = session.hostView();
      region('own', JSON.stringify([hv?.game?.quiz?.reveal, hv?.game?.mine]), () => (hv?.game?.quiz?.reveal?.mine ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw antwoord</h2>${quizRevealHtml(hv, { onlyMine: true })}</section>` : ''));
      region('cta', JSON.stringify([sv.game.quiz.reveal?.last, leads()]), () => (leads() ? nextCta() : ''));
    } else if (vn === 'revealed' && kind === 'disco') {
      region('song', JSON.stringify([sv.game.reveal?.song]), () => songHtml(sv));
      region('progress', JSON.stringify([sv.game.disco.progress]), () => `<h2 class="room-h">Voortgang</h2>${discoProgressHtml(sv)}`);
      region('main', JSON.stringify([sv.game.reveal, sv.game.disco]), () => regieHtml(sv));
      const hv = session.hostView();
      region('own', JSON.stringify([hv?.game?.reveal?.mine, hv?.game?.disco, hv?.game?.mine]), () => (hv?.game?.mine ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw ronde, ${esc(hv.you.name)}</h2>${discoMyResultHtml(hv)}${ownCard(hv)}</section>` : ''));
      region('cta', JSON.stringify([sv.game.disco, sv.game.reveal?.roundWinners, left(r.game), leads()]), () => (leads() ? nextButtonHtml(sv, { left: left(r.game) }) : ''));
    } else if (vn === 'revealed') {
      region('main', JSON.stringify([r.game.results, r.game.round, sv.players]), () => revealedHtml(sv));
      const hv = session.hostView();
      region('own', JSON.stringify([hv?.game]), () => (hv?.game?.mine ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw ronde</h2>${myResultHtml(hv)}${ownCard(hv)}</section>` : ''));
      region('cta', JSON.stringify([r.game.roundWinners, left(r.game), leads()]), () => (leads() ? nextCta() : ''));
    } else if (vn === 'won') {
      region('main', JSON.stringify([r.game.winners, sv.players, leads(), sv.game.quiz?.ranking, sv.game.disco?.progress, session.hostView()?.game?.mine]), () => wonHtml(sv));
    }
  }

  /**
   * Quiz: tell the server the song plays here, so the thinking time starts. Again (at most
   * every 2 s) as long as the server's clock has not started, e.g. after a server restart.
   */
  function reportPlaying() {
    const r = session.room;
    const sv = spectator();
    if (!leads() || r?.phase !== 'answering' || r.game?.kind !== 'quiz' || sv?.game?.quiz?.startedAt) return;
    if (player.state.status !== 'playing') return;
    const key = `${r.code}:${r.game.round}`;
    if (reportedFor.key === key && Date.now() - reportedFor.at < 2000) return;
    if (session.quizPlaying?.(r.game.round)) reportedFor = { key, at: Date.now() };
  }

  // ---------- pieces ----------
  const left = (g) => (g.left ?? g.pile.length);

  /** Via the server: who leads, and the connection steps when the line is gone for a while. */
  function serverStatusHtml() {
    if (!viaServer) return '';
    const m = session.meta;
    let out = '';
    if (m && !m.leader) {
      out += `<div class="lead-banner" data-testid="room-lead-elsewhere">
        <p><b>${esc(m.leaderName)} heeft de leiding overgenomen.</b> De muziek speelt nu op die telefoon; daar tikt men ook op Onthul en Volgend nummer.</p>
        ${m.owner ? `<button class="btn btn-primary" type="button" data-action="reclaim" data-testid="room-reclaim">${icons.music}<span>Neem de leiding terug</span></button>` : ''}
      </div>`;
    }
    if (diagVisible(session.diag, session.status)) out += diagHtml(session.diag, { role: 'host', code: session.code });
    return out;
  }

  function connectingHtml() {
    const d = session.diag;
    const show = d && diagVisible(d, session.status);
    return `<div class="room-wait" data-testid="host-connecting">
      ${show ? '' : '<div class="room-spinner" aria-hidden="true"></div>'}
      <h2>${session.status === 'unreachable' ? 'Server niet bereikbaar' : session.code ? `Verbinden met kamer ${esc(session.code)}…` : 'Kamer maken…'}</h2>
      ${show ? diagHtml(d, { role: 'host', code: session.code }) : '<p class="muted">Even geduld, de server maakt de kamer klaar.</p>'}
    </div>`;
  }

  function statusHtml(sv) {
    const r = session.room;
    const offline = sv.players.filter((p) => !p.online).length;
    const roundInfo = r.game && r.phase !== 'lobby' && r.phase !== 'won' ? `<span class="room-round-chip" data-testid="room-round">${esc(gameName(r.game.kind))}, ronde ${r.game.round}</span>` : '';
    return `<div class="room-bar">
      ${connBadge(session.status, session.status === 'online' ? `Kamer open${offline ? ` · ${offline} offline` : ''}` : undefined)}
      ${roundInfo}
      ${r.phase !== 'lobby' ? `<button class="btn btn-small btn-ghost room-share" type="button" data-action="share" data-testid="room-share">${icons.users}<span>QR</span></button>` : ''}
    </div>${serverStatusHtml()}`;
  }

  function joinBoxHtml(code) {
    const link = roomLink(code);
    return `<div class="joinbox" data-testid="room-joinbox">
      <div class="joinbox-text">
        <p class="joinbox-kicker">Doe mee met code</p>
        <p class="joinbox-code" data-testid="room-code-big" aria-label="Kamercode ${[...code].join(' ')}">${esc(code)}</p>
        <p class="joinbox-help">Open TimeTunesr, tik op <b>Doe mee</b> en vul de code in. Of scan de QR-code.</p>
      </div>
      <a class="joinbox-qr" href="${esc(link)}" data-testid="room-qr" aria-label="QR-code: ${esc(link)}">${qrSvg(link)}</a>
      <p class="joinbox-link"><span data-testid="room-link">${esc(link)}</span></p>
    </div>`;
  }

  function sheetHtml(code) {
    return `<div class="sheet-backdrop" data-testid="join-sheet" data-action="sheet-close">
      <div class="sheet" role="dialog" aria-label="Meedoen met deze kamer">
        ${joinBoxHtml(code)}
        <button class="btn btn-primary" type="button" data-action="sheet-close" data-testid="join-sheet-close">${icons.check}<span>Klaar</span></button>
      </div>
    </div>`;
  }

  function playersBlock(sv) {
    const n = sv.players.length;
    const answering = session.room.phase === 'answering';
    const playing = sv.players.filter((p) => p.playing);
    const done = playing.filter((p) => p.answered).length;
    const head = answering
      ? `<h2 class="room-h" data-testid="room-answered" data-done="${done}" data-total="${playing.length}">Geantwoord: ${done} van ${playing.length}</h2>`
      : `<h2 class="room-h">Spelers <span class="muted">(${n})</span></h2>`;
    const empty = n === 0 ? '<p class="muted" data-testid="room-empty">Nog niemand. Laat iedereen de code invullen of de QR-code scannen.</p>' : '';
    return `${head}${empty}${n ? playersHtml(sv, { host: true, removable: true }) : ''}`;
  }

  function setupHtml() {
    const last = store.get(HOST_NAME_KEY, '') || '';
    const err = viaServer && session.error ? `<p class="warn" data-testid="host-error" data-code="${esc(session.error.code)}">${esc(session.error.message || 'Dat lukte niet.')}</p>` : '';
    return `<form class="setup host-setup" data-testid="host-setup-form" autocomplete="off">${err}
      <p class="lead">Iedereen speelt op zijn eigen telefoon. Dit toestel is de spelleider: het speelt de muziek (zet het op een speaker) en houdt de stand bij.</p>
      <fieldset>
        <legend>Speel je zelf mee?</legend>
        <label class="check-row"><input type="checkbox" name="plays" data-testid="host-plays"><span>Ja, ik speel mee op dit toestel</span></label>
        <input type="text" name="name" maxlength="24" placeholder="Jouw naam" value="${esc(last)}" data-testid="host-name" aria-label="Jouw naam" class="host-name">
        <p class="muted small">Je ziet dan je eigen kaart of tijdlijn onder de knoppen van de spelleider.</p>
      </fieldset>
      <button class="btn btn-primary btn-xl" type="submit" data-testid="host-create">${icons.plus}<span>Maak de kamer</span></button>
      <p class="muted small center">De telefoons verbinden via internet. Iedereen heeft dus verbinding nodig, maar niet hetzelfde wifi.</p>
      ${viaServer ? '' : '<p class="muted small center p2p-note" data-testid="multi-p2p-note">Er is geen server ingesteld: de telefoons verbinden dan rechtstreeks met elkaar. Op sommige netwerken lukt dat niet.</p>'}
    </form>`;
  }

  function lobbyHtml() {
    const s = session.room.settings;
    const opt = (val, title, sub) => `<label class="size-opt">
      <input type="radio" name="game" value="${val}" ${s.game === val ? 'checked' : ''} data-testid="room-game-${val}">
      <span class="size-box"><b>${title}</b><small>${sub}</small></span></label>`;
    return `<form class="setup room-settings" data-testid="room-settings" autocomplete="off">
      <fieldset>
        <legend>Welk spel?</legend>
        <div class="size-pick">
          <label class="size-opt room-disco-opt"><input type="radio" name="game" value="disco" ${s.game === 'disco' ? 'checked' : ''} ${viaServer ? '' : 'disabled'} data-testid="room-game-disco">
            <span class="size-box"><b>Discobingo</b><small>de discobal kiest de vraag, jij kiest je vakje op een 5×5-kaart</small></span></label>
          ${opt('bingo', 'Bingo', 'eigen bingokaart, eerst een volle rij')}
          ${opt('timeline', 'Tijdlijn', 'eigen tijdlijn, eerst het doel')}
          <label class="size-opt room-quiz-opt"><input type="radio" name="game" value="quiz" ${s.game === 'quiz' ? 'checked' : ''} ${viaServer ? '' : 'disabled'} data-testid="room-game-quiz">
            <span class="size-box"><b>Quiz</b><small>vier antwoorden per nummer, snelheid telt</small></span></label>
        </div>
        ${!viaServer ? '<p class="muted small" data-testid="room-quiz-server-only"><span data-testid="room-disco-server-only">Discobingo</span> en de quiz werken alleen via de kamerserver (die beoordeelt de antwoorden en houdt de klok bij), niet bij rechtstreeks verbinden.</p>' : ''}
        ${s.game === 'disco' ? discoLobbyHtml(s, { have: cards.length, mix: viaServer && s.music === 'mix' }) : s.game === 'quiz' ? quizSettingsHtml(s) : s.game === 'bingo' ? `<div class="size-pick room-sub">
          ${[[3, '3×3', 'snel potje'], [4, '4×4', 'standaard']].map(([n, t, sub]) => `<label class="size-opt"><input type="radio" name="size" value="${n}" ${s.size === n ? 'checked' : ''} data-testid="room-size-${n}"><span class="size-box"><b>${t}</b><small>${sub}</small></span></label>`).join('')}
        </div>` : `<div class="stepper room-sub">
          <button class="icon-btn" type="button" data-action="goal-minus" aria-label="Minder kaarten" data-testid="room-goal-minus">${icons.minus}</button>
          <output data-testid="room-goal-value"><b>${s.goal}</b> kaarten</output>
          <button class="icon-btn" type="button" data-action="goal-plus" aria-label="Meer kaarten" data-testid="room-goal-plus">${icons.plus}</button>
        </div><p class="muted small">Doel (standaard ${DEFAULT_GOAL}); de startkaart telt mee.</p>`}
      </fieldset>
      ${viaServer ? musicHtml() : ''}
    </form>`;
  }

  function quizSettingsHtml(s) {
    const pick = (name, list, cur, label, testid) => `<div class="seg room-seg" role="radiogroup">${list.map((v) => `<label class="seg-opt"><input type="radio" name="${name}" value="${v}" ${String(cur) === String(v) ? 'checked' : ''} data-testid="${testid}-${v}"><span>${label(v)}</span></label>`).join('')}</div>`;
    const types = { mix: 'Mix', year: 'Jaar', artist: 'Artiest', title: 'Titel' };
    const max = Math.min(s.questions, cards.length);
    const onlyYears = !quizTypes.artist || !quizTypes.title;
    return `<div class="room-sub room-quiz-settings" data-testid="room-quiz-settings">
      <p class="room-label">Aantal vragen</p>${pick('qcount', QUIZ_COUNTS, s.questions, (n) => `${n}`, 'room-quiz-count')}
      <p class="room-label">Soort vragen</p>${pick('qtype', Object.keys(types), s.qtype, (k) => types[k], 'room-quiz-type')}
      <p class="room-label">Bedenktijd</p>${pick('qtime', QUIZ_TIMES, s.think, (n) => `${n} s`, 'room-quiz-time')}
      <p class="muted small" data-testid="room-quiz-summary">${s.music === 'mix' && viaServer ? 'Muziek: <b>Mix van de groep</b>. De foute antwoorden bij artiest en titel komen uit jouw eigen muziek, zodat niemand vooraf de favorieten van een ander ziet.' : `Muziek: <b>${esc(deck.name || 'TimeTunesr-deck')}</b>. ${max < s.questions ? `Er staan maar ${cards.length} nummers in, dus ${max} vragen.` : `${max} vragen.`}`} Goed = 500 punten plus tot 500 voor snelheid, en een kleine bonus voor een reeks goede antwoorden.</p>
      ${onlyYears && s.qtype !== 'year' ? `<p class="warn small" data-testid="room-quiz-years-only">In deze muziek staan te weinig verschillende ${!quizTypes.artist ? 'artiesten' : 'titels'} voor vier antwoorden: die vragen worden jaarvragen.</p>` : ''}
    </div>`;
  }

  /** Via the server: the music of the game, the leader's own deck or the "Mix van de groep". */
  function musicHtml() {
    const r = session.room;
    const s = r.settings;
    const mix = session.meta?.mix;
    const src = playSource();
    const short = mixShortage(mix, s, r.players.length, src);
    const isMix = s.music === 'mix';
    const can = short.missing === 0;
    const extra = src === 'preview' && (mix?.total || 0) > (mix?.preview || 0)
      ? ` ${(mix.total - mix.preview)} zonder Apple Music-fragment tellen niet mee bij fragmenten van 30 seconden.` : '';
    return `<fieldset class="room-music" data-testid="room-music">
        <legend>Welke muziek?</legend>
        <div class="size-pick">
          <label class="size-opt"><input type="radio" name="music" value="deck" ${!isMix ? 'checked' : ''} data-testid="room-music-deck">
            <span class="size-box"><b>Jouw muziek</b><small>${esc(deck.name || 'TimeTunesr-deck')} · ${cards.length} nummers</small></span></label>
          <label class="size-opt"><input type="radio" name="music" value="mix" ${isMix ? 'checked' : ''} ${can || isMix ? '' : 'disabled'} data-testid="room-music-mix">
            <span class="size-box"><b>Mix van de groep</b><small data-testid="room-mix-have" data-have="${short.have}">${short.have} nummers van ${mix?.contributors || 0} ${mix?.contributors === 1 ? 'speler' : 'spelers'}</small></span></label>
        </div>
        ${can ? (isMix ? `<p class="muted small" data-testid="room-mix-ok">Genoeg nummers: de server stelt de lijst eerlijk samen uit ieders favorieten (dubbele één keer, zekere jaartallen eerst).${esc(extra)}</p>` : '')
    : `<p class="${isMix ? 'warn' : 'muted'} small mix-need" data-testid="room-mix-need" data-missing="${short.missing}">${isMix ? 'Te weinig nummers in de mix. ' : ''}Voor ${esc(gameName(s.game))}${s.game === 'bingo' ? ` ${s.size}×${s.size}` : s.game === 'quiz' ? ` (${s.questions} vragen)` : s.game === 'disco' ? '' : ` (doel ${s.goal})`} zijn er minstens ${short.need} nodig: nog ${short.missing}. Laat spelers op hun eigen telefoon <b>Doe mijn favorieten erbij</b> kiezen.${esc(extra)}</p>`}
      </fieldset>`;
  }

  function lobbyCta() {
    const r = session.room;
    const n = r.players.length;
    const isMix = viaServer && r.settings.music === 'mix';
    const serverOnly = r.settings.game === 'quiz' || r.settings.game === 'disco';
    const ok = n >= 1 && (serverOnly && !viaServer ? false
      : isMix ? mixShortage(session.meta?.mix, r.settings, n, playSource()).missing === 0
        : r.settings.game === 'quiz' ? cards.length >= QUIZ_MIN_SONGS
          : r.settings.game === 'disco' ? cards.length >= Math.max(DISCO_MIN_SONGS, n + 2) : cards.length >= n + 2);
    return `<div class="sticky-cta">
      <button class="btn btn-primary btn-xl" type="button" data-action="start" data-testid="room-start" ${ok ? '' : 'disabled'}>${icons.play}<span>${n ? `Start ${esc(gameName(r.settings.game))} (${n} ${n === 1 ? 'speler' : 'spelers'})` : 'Wacht op spelers'}</span></button>
    </div>`;
  }

  function revealCta(sv) {
    const playing = sv.players.filter((p) => p.playing);
    const online = playing.filter((p) => p.online);
    const ready = online.length > 0 && online.every((p) => p.answered);
    const done = playing.filter((p) => p.answered).length;
    return `<div class="sticky-cta">
      <button class="btn btn-primary btn-xl room-reveal ${ready ? 'is-ready' : ''}" type="button" data-action="reveal" data-testid="room-reveal" data-ready="${ready}">${icons.eye}<span>${ready ? 'Iedereen is klaar: onthul!' : `Onthul (${done}/${playing.length})`}</span></button>
    </div>`;
  }

  function hostResults(sv) {
    const g = session.room.game;
    return {
      ...sv,
      game: {
        ...sv.game,
        reveal: {
          ...sv.game.reveal,
          results: sv.game.reveal.results.map((x) => {
            const r = g.results[x.id];
            return { ...x, canOverride: !!r && !r.none && !r.pass, doubt: !!r?.doubt, typed: !!r?.typed };
          }),
        },
      },
    };
  }

  function revealedHtml(sv) {
    const rw = sv.game.reveal?.roundWinners || [];
    return `${songHtml(sv)}
      ${rw.length ? `<p class="room-bingo-call" data-testid="room-round-winners">${sv.game.kind === 'bingo' ? 'Bingo' : 'Doel gehaald'}: ${rw.map(esc).join(' & ')}!</p>` : ''}
      <h2 class="room-h">Wie zat goed?</h2>
      ${roundResultsHtml(hostResults(sv), { host: true })}
      <p class="muted small">Twijfel bij een getypte artiest of titel? Tik op <em>Toch goed</em> of <em>Toch fout</em>.</p>
      <h2 class="room-h">Tussenstand</h2>
      ${standingsHtml(sv)}`;
  }

  function ownCard(hv) {
    const g = hv.game;
    if (g.kind === 'disco') {
      const d = g.disco;
      const choosing = hv.phase === 'revealed' && g.reveal?.mine?.correct && !d.waitingForHost && d.choosable.length > 0;
      return `${discoCardHtml(g.mine, { mode: choosing ? 'choose' : 'show', choosable: d.choosable, choice: d.choice, cat: d.cat, testid: 'host-disco-card', name: hv.you?.name })}${cardStatsHtml(g.mine, d.win)}`;
    }
    if (g.kind === 'bingo') return viewBingoCard(hv, { highlight: g.reveal?.mine && !g.reveal.mine.none && !g.reveal.mine.pass ? g.reveal.mine.index : null });
    return `<details class="final-tl"><summary>Jouw tijdlijn · ${g.mine.timeline.length} van ${g.goal}</summary>${viewTimeline(g.mine.timeline)}</details>`;
  }

  function nextCta() {
    const g = session.room.game;
    if (g.kind === 'quiz') {
      const last = spectator()?.game?.quiz?.reveal?.last;
      return `<div class="sticky-cta">
      <button class="btn btn-primary btn-xl" type="button" data-action="next" data-testid="room-next">${last ? `${icons.trophy}<span>Naar het podium</span>` : `${icons.music}<span>Volgende vraag</span>`}</button>
    </div>`;
    }
    const win = g.roundWinners.length > 0;
    return `<div class="sticky-cta">
      <button class="btn btn-primary btn-xl" type="button" data-action="next" data-testid="room-next">${win ? `${icons.trophy}<span>Naar de uitslag</span>` : left(g) ? `${icons.music}<span>Volgend nummer</span>` : `${icons.trophy}<span>Nummers op: uitslag</span>`}</button>
    </div>`;
  }

  function wonHtml(sv) {
    const quiz = sv.game.kind === 'quiz';
    const hv = session.hostView();
    return `${confettiHtml()}
      ${quiz ? quizPodiumHtml(sv) : sv.game.kind === 'disco' ? `${winnerHtml(sv)}
      ${discoProgressHtml(sv)}
      ${hv?.game?.mine ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw kaart, ${esc(hv.you.name)}</h2>${ownCard(hv)}</section>` : ''}` : `${winnerHtml(sv)}
      ${standingsHtml(sv)}`}
      ${leads() ? `<div class="stack">
        <button class="btn btn-primary btn-xl" type="button" data-action="again" data-testid="room-again">${icons.restart}<span>${quiz ? 'Nog een quiz' : 'Nog een potje'}</span></button>
        <button class="btn btn-ghost" type="button" data-action="lobby" data-testid="room-to-lobby">${icons.users}<span>Ander spel kiezen</span></button>
      </div>` : ''}`;
  }

  // ---------- events ----------
  function guard(fn) {
    try { fn(); } catch (e) { toast(e.message, { kind: 'warn' }); }
  }

  function onClick(e) {
    const pick = e.target.closest('[data-action="quiz-pick"]');
    if (pick && root.contains(pick)) {
      const g = session.room?.game;
      if (!pick.disabled && g?.kind === 'quiz') {
        quizSending = g.round;
        guard(() => session.answer({ choice: Number(pick.dataset.choice) }));
        vibrate(20);
        draw();
      }
      return;
    }
    const sq = e.target.closest('[data-action="disco-stamp"]');
    if (sq && root.contains(sq)) {
      const hv = session.hostView();
      if (session.room?.phase === 'revealed' && hv?.game?.disco && Number(sq.dataset.index) !== hv.game.disco.choice) { guard(() => session.stamp(Number(sq.dataset.index))); vibrate(25); }
      return;
    }
    if (session.room?.phase === 'answering' && inDisco() && e.target.closest('[data-testid="host-own"]')) { if (dctl.onClick(e)) return; } else if (session.room?.phase === 'answering' && session.room.game?.kind !== 'quiz' && e.target.closest('[data-testid="host-own"]') && ctl.onClick(e)) return;
    const a = e.target.closest('[data-action]');
    if (!a || !root.contains(a)) return;
    const act = a.dataset.action;
    if (act.startsWith('pv-')) return; // the hidden player handles these
    switch (act) {
      case 'share': sheetOpen = true; draw(); break;
      case 'sheet-close':
        if (a.classList.contains('sheet-backdrop') && e.target !== a) return;
        sheetOpen = false; draw(); break;
      case 'goal-minus':
      case 'goal-plus':
        guard(() => session.setSettings({ goal: session.room.settings.goal + (act === 'goal-plus' ? 1 : -1) }));
        break;
      case 'start':
      case 'again':
        startedHere = true;
        player.unlock();
        guard(() => (viaServer ? session.start(cards, { mix: session.room?.settings.music === 'mix', play: playSource() }) : session.start(cards)));
        window.scrollTo(0, 0);
        break;
      case 'reveal':
        guard(() => session.reveal());
        vibrate(30);
        window.scrollTo(0, 0);
        break;
      case 'override': guard(() => session.override(a.dataset.id)); break;
      case 'disco-judge': guard(() => session.judge(a.dataset.id, a.dataset.ok === '1')); vibrate(20); break;
      case 'disco-doubts': {
        const el = root.querySelector('#disco-doubts');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); el.classList.remove('is-called'); void el.offsetWidth; el.classList.add('is-called'); }
        break;
      }
      case 'next':
        startedHere = true;
        guard(() => session.next());
        window.scrollTo(0, 0);
        break;
      case 'lobby': guard(() => session.toLobby()); break;
      case 'remove':
        if (window.confirm(`${a.dataset.name} uit de kamer verwijderen?`)) guard(() => session.remove(a.dataset.id));
        break;
      case 'retry': session.retry(); break;
      case 'copy-diag':
        session.copyDiag?.().then((ok) => toast(ok ? 'Diagnose gekopieerd. Plak hem in een bericht.' : 'Kopiëren lukte niet.', { kind: ok ? 'info' : 'warn' }));
        break;
      case 'reclaim': guard(() => session.reclaim()); break;
      case 'mix-share': ms?.share(); break;
      case 'mix-withdraw': ms?.withdraw(); break;
      case 'close-room':
        if (window.confirm('Kamer sluiten? Het spel stopt voor iedereen.')) { player.stop(); loadedFor = null; forgetMixShare(session.code); session.close(); }
        break;
      default:
    }
  }

  function onChange(e) {
    const t = e.target;
    if (onMixChange(ms, e)) { draw(); return; }
    if (t.name === 'music') guard(() => session.setSettings({ music: t.value === 'mix' ? 'mix' : 'deck' }));
    else if (t.name === 'game') guard(() => session.setSettings({ game: t.value }));
    else if (t.name === 'size') guard(() => session.setSettings({ size: Number(t.value) }));
    else if (t.name === 'qcount') guard(() => session.setSettings({ questions: Number(t.value) }));
    else if (t.name === 'qtype') guard(() => session.setSettings({ qtype: t.value }));
    else if (t.name === 'qtime') guard(() => session.setSettings({ think: Number(t.value) }));
    else if (t.name === 'win') guard(() => session.setSettings({ win: t.value }));
  }

  function onSubmit(e) {
    if (!e.target.matches('.host-setup')) return;
    e.preventDefault();
    const f = e.target;
    const plays = f.plays.checked;
    const nm = f.name.value.trim();
    if (plays && !nm) { toast('Vul je naam in, of speel niet mee.', { kind: 'warn' }); f.name.focus(); return; }
    if (nm) store.set(HOST_NAME_KEY, nm);
    // via the server a new room starts with Discobingo unless a game was chosen before
    if (viaServer) {
      const st = store.get(SETTINGS_KEY, {}) || {};
      if (!st.game) store.set(SETTINGS_KEY, { ...st, game: PREFERRED_GAME });
    }
    player.unlock();
    session.create({ hostPlays: plays, hostName: nm });
  }

  function onKey(e) {
    if (e.key === 'Escape' && sheetOpen) { sheetOpen = false; draw(); }
    if (inDisco()) dctl.onKeyDown(e); else ctl.onKeyDown(e);
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  const onInput = (e) => (inDisco() ? dctl.onInput(e) : ctl.onInput(e));
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);

  const releaseAwake = keepAwake(); // the host plays the music: keep the screen (and the connection) alive
  if (viaServer ? storedServerHost() : storedRoom()) session.resume();
  draw();
  // the connection steps count seconds while something is busy
  const ticker = viaServer ? setInterval(() => { if (session && (session.connecting || diagVisible(session.diag, session.status))) draw(); }, 1000) : 0;
  // the quiz clock runs on screen between server messages; when it runs out the buttons close
  const quizTicker = viaServer ? setInterval(() => {
    if (!session || !inQuiz() || session.room.phase !== 'answering') return;
    reportPlaying();
    if (tickQuizClocks(root, serverNow())) draw();
  }, 250) : 0;
  const offPlayer = player.subscribe(() => { if (session && inQuiz()) reportPlaying(); });

  window.__ttHost = { get session() { return session; } };

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInput);
    root.removeEventListener('keydown', onKey);
    releaseAwake();
    clearInterval(ticker);
    clearInterval(quizTicker);
    offPlayer();
    document.body.classList.remove('tt-quiz', 'tt-disco');
    stage?.destroy();
    if (unmountPv) unmountPv();
    unsub?.();
    ms?.destroy();
    session.destroy();
    session = null;
    unsub = null;
    player.stop();
  };
}
