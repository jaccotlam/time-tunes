// "Samen spelen", player side (#/kamer, #/kamer/ABCD): join with a room code or link,
// then play on your own phone. Everything shown comes from the host (multi/protocol.js
// viewFor); before the reveal nothing about the running song reaches this phone.
import { normalizeCode } from '../multi/code.js';
import { createClientSession, storedJoin, forgetJoin } from '../multi/client-session.js';
import { cleanName } from '../multi/game.js';
import { icons, esc, toast, vibrate, store } from '../ui.js';
import {
  patch, connBadge, playersHtml, standingsHtml, answerPanelHtml, answerController, myResultHtml, songHtml,
  roundResultsHtml, winnerHtml, confettiHtml, viewBingoCard, viewTimeline, gameName,
  keepAwake,
} from './room-ui.js';

export const name = 'room-player';
const NAME_KEY = 'timetunesr.multiName.v1';

export function render(root, { params, navigate }) {
  const urlCode = normalizeCode(params?.[0] || '');
  const join = storedJoin();
  let session = null;
  let unsub = null;
  let viewName = null;
  let joinError = '';
  let lastPhaseKey = '';
  const regions = {};
  const keys = {};

  const ctl = answerController({
    getView: () => session?.view,
    send: (ans) => { session.answer(ans); vibrate(20); },
    refresh: () => draw(),
  });

  function start(code, nm) {
    session = createClientSession({ code, name: nm });
    unsub = session.subscribe(() => {
      const n = session.takeNotice();
      if (n) toast(n.message, { kind: 'warn' });
      draw();
    });
    session.start();
    draw();
  }

  function currentView() {
    if (!session) return 'join';
    if (session.error) return 'error';
    const v = session.view;
    if (!v) return 'connecting';
    return v.phase; // lobby | answering | revealed | won
  }

  function skeleton(vn) {
    const code = session?.code || urlCode || '';
    root.innerHTML = `<section class="screen screen-room view-${vn}" data-testid="screen-room-player" data-view="${vn}" data-code="${esc(code)}">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Naar start" data-testid="back-home">${icons.home}</a>
        <h1 class="topbar-title">${session ? `Kamer <span class="room-code-inline" data-testid="room-code">${esc(code)}</span>` : 'Doe mee'}</h1>
        ${session && !session.error ? '<button class="btn btn-small btn-ghost" type="button" data-action="leave" data-testid="room-leave">Verlaat</button>' : '<span class="topbar-spacer"></span>'}
      </header>
      <div class="room-status" data-region="status"></div>
      <div class="room-main" data-region="main"></div>
      <div class="room-side" data-region="players"></div>
    </section>`;
    for (const k of ['status', 'main', 'players']) { regions[k] = root.querySelector(`[data-region="${k}"]`); keys[k] = null; }
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
    const v = session?.view;
    const phaseKey = v ? `${v.phase}:${v.game?.round}` : '';
    if (phaseKey !== lastPhaseKey) {
      if (lastPhaseKey && v?.phase === 'revealed') vibrate(v.game.reveal?.mine?.correct ? [40, 40, 80] : [60]);
      if (lastPhaseKey && v?.phase === 'answering') vibrate(30);
      lastPhaseKey = phaseKey;
    }
    const st = session ? session.status : null;
    region('status', JSON.stringify([st, vn, session?.error?.code]), () => (session && !session.error ? statusHtml(st) : ''));
    region('players', JSON.stringify([vn, v?.players, v?.you?.id]), () => (v && !['join', 'error', 'connecting'].includes(vn) ? `<h2 class="room-h">Spelers</h2>${playersHtml(v)}` : ''));
    const build = { join: joinHtml, connecting: connectingHtml, error: errorHtml, lobby: lobbyHtml, answering: answeringHtml, revealed: revealedHtml, won: wonHtml }[vn];
    const mainKey = vn === 'answering' ? `a|${ctl.key()}|${!!session.pending}` : JSON.stringify([vn, joinError, v?.game, v?.settings, v?.you, session?.error, st === 'notfound']);
    region('main', mainKey, build);
  }

  function statusHtml(st) {
    return `${connBadge(st)}`;
  }

  // ---------- views ----------
  function joinHtml() {
    const code = urlCode || join?.code || '';
    const nm = (join && (!urlCode || join.code === urlCode) ? join.name : store.get(NAME_KEY, '')) || '';
    return `<form class="setup join-form" data-testid="join-form" autocomplete="off" novalidate>
      <p class="lead">Doe mee met een potje op de telefoon van de spelleider. Je speelt op je eigen telefoon; de muziek komt uit de speaker van de spelleider.</p>
      <fieldset>
        <legend>Kamercode</legend>
        <input class="code-input" type="text" name="code" maxlength="5" placeholder="ABCD" value="${esc(code)}" data-testid="join-code" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-label="Kamercode (4 letters)" enterkeyhint="next">
        <p class="muted small">Staat groot op het scherm van de spelleider. Of scan de QR-code met je camera.</p>
      </fieldset>
      <fieldset>
        <legend>Jouw naam</legend>
        <input type="text" name="name" maxlength="24" placeholder="Bijvoorbeeld Sam" value="${esc(nm)}" data-testid="join-name" autocomplete="nickname" autocapitalize="words" enterkeyhint="go" aria-label="Jouw naam">
      </fieldset>
      <p class="warn" data-testid="join-error" ${joinError ? '' : 'hidden'}>${esc(joinError)}</p>
      <button class="btn btn-primary btn-xl" type="submit" data-testid="join-submit">${icons.users}<span>Doe mee</span></button>
    </form>`;
  }

  function connectingHtml() {
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

  function errorHtml() {
    const e = session.error;
    const title = { version: 'Andere versie van de app', removed: 'Je bent verwijderd', closed: 'De kamer is gesloten', full: 'De kamer is vol', room: 'Kamer bestaat niet meer', replaced: 'Je speelt elders verder' }[e.code] || 'Dat lukte niet';
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
    const v = session.view;
    return `<div class="room-wait" data-testid="room-wait">
      <span class="room-check" aria-hidden="true">${icons.check}</span>
      <h2>Je doet mee, ${esc(v.you?.name || '')}!</h2>
      <p class="muted">Wacht tot de spelleider het spel start. Gekozen spel: <b>${esc(gameName(v.settings.game))}</b>${v.settings.game === 'bingo' ? ` (${v.settings.size}×${v.settings.size})` : ` (doel ${v.settings.goal} kaarten)`}.</p>
      <p class="muted small">Je scherm blijft aan zolang je in de kamer bent (als je telefoon dat toestaat). Valt hij toch op slot, dan kom je vanzelf terug in het spel.</p>
    </div>`;
  }

  function roundTitle(v) {
    const g = v.game;
    return `<p class="room-round" data-testid="room-round"><b>${esc(gameName(g.kind))}</b> · ronde ${g.round}${g.kind === 'timeline' ? ` · doel ${g.goal}` : ''}</p>`;
  }

  function answeringHtml() {
    const v = session.view;
    return `${roundTitle(v)}
      <div class="listen-hint" data-testid="listen-hint">${icons.music}<span>Luister naar de muziek bij de spelleider.</span></div>
      ${answerPanelHtml(v, ctl.choice, { sending: !!session.pending })}`;
  }

  function ownAfter(v) {
    const g = v.game;
    if (!g.mine) return '';
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
    const me = v.you && v.game.winnerIds.includes(v.you.id);
    return `${confettiHtml()}
      ${winnerHtml(v)}
      ${me ? '<p class="room-you-won" data-testid="room-you-won">Gefeliciteerd, jij hebt gewonnen!</p>' : ''}
      ${standingsHtml(v)}
      ${ownAfter(v)}
      <p class="muted center">Wacht tot de spelleider een nieuw potje start.</p>`;
  }

  // ---------- events ----------
  function onSubmit(e) {
    if (!e.target.matches('.join-form')) return;
    e.preventDefault();
    const f = e.target;
    const code = normalizeCode(f.code.value);
    const nm = cleanName(f.name.value, '');
    if (!code) { joinError = 'Vul de kamercode in: 4 letters, bijvoorbeeld KMRT.'; keys.main = null; draw(); f.code.focus(); return; }
    if (!nm) { joinError = 'Vul je naam in.'; keys.main = null; draw(); root.querySelector('[data-testid="join-name"]')?.focus(); return; }
    joinError = '';
    store.set(NAME_KEY, nm);
    store.set('timetunesr.multiJoin.v1', { code, name: nm });
    if (urlCode !== code) { navigate(`#/kamer/${code}`); return; }
    start(code, nm);
  }

  function onClick(e) {
    if (session?.view && ctl.onClick(e)) return;
    const a = e.target.closest('[data-action]');
    if (!a || !root.contains(a)) return;
    switch (a.dataset.action) {
      case 'leave':
        if (!window.confirm('Wil je de kamer verlaten? Je kunt later opnieuw meedoen, maar met een nieuwe kaart.')) return;
        session.leave();
        setTimeout(() => navigate('#/'), 250); // let the goodbye reach the host first
        break;
      case 'retry': session?.retry(); break;
      case 'reload': location.reload(); break;
      case 'other-code':
        if (session) { session.destroy(); unsub?.(); session = null; }
        forgetJoin();
        navigate('#/kamer');
        break;
      default:
    }
  }

  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  root.addEventListener('input', ctl.onInput);
  root.addEventListener('keydown', ctl.onKeyDown);

  const releaseAwake = keepAwake();
  // Back in the same room (reload, phone woke up, link opened again): join without asking.
  if (join && (urlCode ? join.code === urlCode : false)) start(join.code, join.name);
  else draw();

  // for tests / debugging: what this phone received from the host
  window.__ttRoom = { get session() { return session; } };

  return () => {
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', ctl.onInput);
    root.removeEventListener('keydown', ctl.onKeyDown);
    releaseAwake();
    unsub?.();
    session?.destroy();
  };
}
