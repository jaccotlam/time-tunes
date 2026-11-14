// "Samen spelen", host side (#/spelleider): make a room, show the code + QR, play the
// hidden song on this device (on a speaker), reveal, judge, next song. The host may play
// along on the same device; that panel is built from the same player view as a phone.
import * as player from '../player.js';
import { playableCards } from '../multi/game.js';
import { viewFor } from '../multi/protocol.js';
import { createHostSession, storedRoom } from '../multi/host-session.js';
import { DEFAULT_GOAL } from '../logic.js';
import { icons, esc, toast, vibrate, store } from '../ui.js';
import { playerViewHtml, mountPlayerView } from './playerview.js';
import {
  patch, connBadge, playersHtml, standingsHtml, answerPanelHtml, answerController, myResultHtml, songHtml,
  roundResultsHtml, winnerHtml, confettiHtml, viewBingoCard, viewTimeline, gameName, qrSvg, roomLink,
  keepAwake,
} from './room-ui.js';

export const name = 'room-host';
const SPECTATOR = '__host__';
const HOST_NAME_KEY = 'timetunesr.multiName.v1';

export function render(root, { deck }) {
  const cards = playableCards(deck.cards.filter((c) => c.previewUrl || c.itunesId || c.spotifyId));
  let session = createHostSession();
  let unsub = session.subscribe(() => draw());
  let viewName = null;
  let unmountPv = null;
  let loadedFor = null; // "round:cardId" loaded in the hidden player
  let startedHere = false; // a round started by a tap on this page may autoplay
  let sheetOpen = false;
  const regions = {};
  const keys = {};

  const ctl = answerController({
    getView: () => session.hostView(),
    send: (ans) => {
      try { session.answer(ans); vibrate(20); } catch (e) { toast(e.message, { kind: 'warn' }); }
    },
    refresh: () => draw(),
  });

  const spectator = () => viewFor(session.room, SPECTATOR, session.presence());

  function currentView() {
    const r = session.room;
    return r ? r.phase : 'setup';
  }

  function skeleton(vn) {
    if (unmountPv) { unmountPv(); unmountPv = null; }
    for (const k of Object.keys(regions)) delete regions[k];
    const r = session.room;
    const code = r?.code || '';
    const quit = r ? '<button class="btn btn-small btn-ghost" type="button" data-action="close-room" data-testid="host-close">Sluiten</button>' : '<span class="topbar-spacer"></span>';
    const body = {
      setup: '<div data-region="main"></div>',
      lobby: `<div data-region="status"></div><div data-region="join"></div><div data-region="players"></div><div data-region="main"></div><div data-region="cta"></div>`,
      answering: `<div data-region="status"></div>
        <div class="place-player" data-region="pv">${playerViewHtml({ compact: true })}</div>
        <div data-region="players"></div><div data-region="own"></div><div data-region="cta"></div>`,
      revealed: `<div data-region="status"></div><div data-region="main"></div>
        <div class="place-player" data-region="pv">${playerViewHtml({ compact: true })}</div>
        <div data-region="own"></div><div data-region="players"></div><div data-region="cta"></div>`,
      won: '<div data-region="status"></div><div data-region="main"></div><div data-region="players"></div>',
    }[vn];
    root.innerHTML = `<section class="screen screen-room screen-room-host view-${vn}" data-testid="screen-room-host" data-view="${vn}" data-code="${esc(code)}">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
        <h1 class="topbar-title">${r ? `Kamer <span class="room-code-inline" data-testid="room-code">${esc(code)}</span>` : 'Maak een kamer'}</h1>
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

  /** Keep the hidden player on the running song. */
  function syncAudio() {
    const r = session.room;
    const g = r?.game;
    if (!g || r.phase === 'won' || r.phase === 'lobby' || !g.current) {
      if (loadedFor) { player.stop(); loadedFor = null; }
      return;
    }
    const k = `${g.round}:${g.current}`;
    if (k === loadedFor) return;
    loadedFor = k;
    player.load(g.songs[g.current], { autoplay: startedHere });
    if (startedHere) player.play(); // inside the tap where possible (iOS)
    startedHere = false;
  }

  function draw() {
    const vn = currentView();
    if (vn !== viewName) { viewName = vn; skeleton(vn); window.scrollTo(0, 0); }
    syncAudio();
    ctl.sync();
    const r = session.room;
    root.querySelector('[data-testid="screen-room-host"]').dataset.code = r?.code || '';
    const codeEl = root.querySelector('[data-testid="room-code"]');
    if (codeEl && r && codeEl.textContent !== r.code) codeEl.textContent = r.code;
    if (!r) { region('main', 'setup', setupHtml); return; }
    const sv = spectator();
    region('status', JSON.stringify([session.status, r.code, r.phase, r.game?.round, r.game?.kind]), () => statusHtml(sv));
    region('join', JSON.stringify([r.code]), () => joinBoxHtml(r.code));
    region('players', JSON.stringify([sv.players, r.phase]), () => playersBlock(sv));
    region('sheet', JSON.stringify([sheetOpen, r.code]), () => (sheetOpen ? sheetHtml(r.code) : ''));
    if (vn === 'lobby') {
      region('main', JSON.stringify([r.settings, r.players.length]), lobbyHtml);
      region('cta', JSON.stringify([r.players.length, r.settings]), lobbyCta);
    } else if (vn === 'answering') {
      const hv = session.hostView();
      region('own', `${ctl.key()}`, () => (hv ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw antwoord, ${esc(hv.you.name)}</h2>${answerPanelHtml(hv, ctl.choice)}</section>` : ''));
      region('cta', JSON.stringify([sv.players]), () => revealCta(sv));
    } else if (vn === 'revealed') {
      region('main', JSON.stringify([r.game.results, r.game.round, sv.players]), () => revealedHtml(sv));
      const hv = session.hostView();
      region('own', JSON.stringify([hv?.game]), () => (hv?.game?.mine ? `<section class="host-own" data-testid="host-own"><h2 class="room-h">Jouw ronde</h2>${myResultHtml(hv)}${ownCard(hv)}</section>` : ''));
      region('cta', JSON.stringify([r.game.roundWinners, r.game.pile.length]), nextCta);
    } else if (vn === 'won') {
      region('main', JSON.stringify([r.game.winners, sv.players]), () => wonHtml(sv));
    }
  }

  // ---------- pieces ----------
  function statusHtml(sv) {
    const r = session.room;
    const offline = sv.players.filter((p) => !p.online).length;
    const roundInfo = r.game && r.phase !== 'lobby' && r.phase !== 'won' ? `<span class="room-round-chip" data-testid="room-round">${esc(gameName(r.game.kind))}, ronde ${r.game.round}</span>` : '';
    return `<div class="room-bar">
      ${connBadge(session.status, session.status === 'online' ? `Kamer open${offline ? ` · ${offline} offline` : ''}` : undefined)}
      ${roundInfo}
      ${r.phase !== 'lobby' ? `<button class="btn btn-small btn-ghost room-share" type="button" data-action="share" data-testid="room-share">${icons.users}<span>QR</span></button>` : ''}
    </div>`;
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
    return `<form class="setup host-setup" data-testid="host-setup-form" autocomplete="off">
      <p class="lead">Iedereen speelt op zijn eigen telefoon. Dit toestel is de spelleider: het speelt de muziek (zet het op een speaker) en houdt de stand bij.</p>
      <fieldset>
        <legend>Speel je zelf mee?</legend>
        <label class="check-row"><input type="checkbox" name="plays" data-testid="host-plays"><span>Ja, ik speel mee op dit toestel</span></label>
        <input type="text" name="name" maxlength="24" placeholder="Jouw naam" value="${esc(last)}" data-testid="host-name" aria-label="Jouw naam" class="host-name">
        <p class="muted small">Je ziet dan je eigen kaart of tijdlijn onder de knoppen van de spelleider.</p>
      </fieldset>
      <button class="btn btn-primary btn-xl" type="submit" data-testid="host-create">${icons.plus}<span>Maak de kamer</span></button>
      <p class="muted small center">De telefoons verbinden via internet. Iedereen heeft dus verbinding nodig, maar niet hetzelfde wifi.</p>
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
          ${opt('bingo', 'Bingo', 'eigen bingokaart, eerst een volle rij')}
          ${opt('timeline', 'Tijdlijn', 'eigen tijdlijn, eerst het doel')}
        </div>
        ${s.game === 'bingo' ? `<div class="size-pick room-sub">
          ${[[3, '3×3', 'snel potje'], [4, '4×4', 'standaard']].map(([n, t, sub]) => `<label class="size-opt"><input type="radio" name="size" value="${n}" ${s.size === n ? 'checked' : ''} data-testid="room-size-${n}"><span class="size-box"><b>${t}</b><small>${sub}</small></span></label>`).join('')}
        </div>` : `<div class="stepper room-sub">
          <button class="icon-btn" type="button" data-action="goal-minus" aria-label="Minder kaarten" data-testid="room-goal-minus">${icons.minus}</button>
          <output data-testid="room-goal-value"><b>${s.goal}</b> kaarten</output>
          <button class="icon-btn" type="button" data-action="goal-plus" aria-label="Meer kaarten" data-testid="room-goal-plus">${icons.plus}</button>
        </div><p class="muted small">Doel (standaard ${DEFAULT_GOAL}); de startkaart telt mee.</p>`}
      </fieldset>
    </form>`;
  }

  function lobbyCta() {
    const r = session.room;
    const n = r.players.length;
    const ok = n >= 1 && cards.length >= n + 2;
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
    if (g.kind === 'bingo') return viewBingoCard(hv, { highlight: g.reveal?.mine && !g.reveal.mine.none && !g.reveal.mine.pass ? g.reveal.mine.index : null });
    return `<details class="final-tl"><summary>Jouw tijdlijn · ${g.mine.timeline.length} van ${g.goal}</summary>${viewTimeline(g.mine.timeline)}</details>`;
  }

  function nextCta() {
    const g = session.room.game;
    const win = g.roundWinners.length > 0;
    return `<div class="sticky-cta">
      <button class="btn btn-primary btn-xl" type="button" data-action="next" data-testid="room-next">${win ? `${icons.trophy}<span>Naar de uitslag</span>` : g.pile.length ? `${icons.music}<span>Volgend nummer</span>` : `${icons.trophy}<span>Nummers op: uitslag</span>`}</button>
    </div>`;
  }

  function wonHtml(sv) {
    return `${confettiHtml()}
      ${winnerHtml(sv)}
      ${standingsHtml(sv)}
      <div class="stack">
        <button class="btn btn-primary btn-xl" type="button" data-action="again" data-testid="room-again">${icons.restart}<span>Nog een potje</span></button>
        <button class="btn btn-ghost" type="button" data-action="lobby" data-testid="room-to-lobby">${icons.users}<span>Ander spel kiezen</span></button>
      </div>`;
  }

  // ---------- events ----------
  function guard(fn) {
    try { fn(); } catch (e) { toast(e.message, { kind: 'warn' }); }
  }

  function onClick(e) {
    if (session.room?.phase === 'answering' && e.target.closest('[data-testid="host-own"]') && ctl.onClick(e)) return;
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
        guard(() => session.start(cards));
        window.scrollTo(0, 0);
        break;
      case 'reveal':
        guard(() => session.reveal());
        vibrate(30);
        window.scrollTo(0, 0);
        break;
      case 'override': guard(() => session.override(a.dataset.id)); break;
      case 'next':
        startedHere = true;
        guard(() => session.next());
        window.scrollTo(0, 0);
        break;
      case 'lobby': guard(() => session.toLobby()); break;
      case 'remove':
        if (window.confirm(`${a.dataset.name} uit de kamer verwijderen?`)) guard(() => session.remove(a.dataset.id));
        break;
      case 'close-room':
        if (window.confirm('Kamer sluiten? Het spel stopt voor iedereen.')) { player.stop(); loadedFor = null; session.close(); }
        break;
      default:
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === 'game') guard(() => session.setSettings({ game: t.value }));
    else if (t.name === 'size') guard(() => session.setSettings({ size: Number(t.value) }));
  }

  function onSubmit(e) {
    if (!e.target.matches('.host-setup')) return;
    e.preventDefault();
    const f = e.target;
    const plays = f.plays.checked;
    const nm = f.name.value.trim();
    if (plays && !nm) { toast('Vul je naam in, of speel niet mee.', { kind: 'warn' }); f.name.focus(); return; }
    if (nm) store.set(HOST_NAME_KEY, nm);
    player.unlock();
    session.create({ hostPlays: plays, hostName: nm });
  }

  function onKey(e) {
    if (e.key === 'Escape' && sheetOpen) { sheetOpen = false; draw(); }
    ctl.onKeyDown(e);
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', ctl.onInput);
  root.addEventListener('keydown', onKey);

  const releaseAwake = keepAwake(); // the host plays the music: keep the screen (and the connection) alive
  if (storedRoom()) session.resume();
  draw();

  window.__ttHost = { get session() { return session; } };

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', ctl.onInput);
    root.removeEventListener('keydown', onKey);
    releaseAwake();
    if (unmountPv) unmountPv();
    unsub?.();
    session.destroy();
    session = null;
    unsub = null;
    player.stop();
  };
}
