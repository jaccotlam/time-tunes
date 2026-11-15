// "Mix van de groep" in a server room: the counts everybody sees (never titles) and the
// panel "Doe mijn favorieten erbij" on every phone (players and the spelleider).
// Used by room-player.js and room-host.js; the work itself is in multi/mix-share.js.
import { icons, esc } from '../ui.js';
import { RANGES, SHARE_COUNTS, mixMinimum, rangeLabel } from '../multi/mix.js';
import * as top from '../spotify-top.js';
import * as spotify from '../spotify.js';

const spotifyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.2 9.6c3.4-1 6.9-.7 9.8.9M7.8 12.6c2.8-.8 5.6-.5 7.9.8M8.5 15.4c2.1-.5 4.1-.3 5.9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;

export const CONSENT = 'Je deelt een deel van je meest geluisterde nummers met deze kamer; de anderen zien ze pas als ze gespeeld worden.';

/** "Mix van de groep: 38 nummers van 3 spelers". */
export function mixCountsText(mix) {
  const total = mix?.total || 0;
  const n = mix?.contributors || 0;
  if (!total) return 'Mix van de groep: nog geen nummers';
  return `Mix van de groep: ${plural(total, 'nummer', 'nummers')} van ${plural(n, 'speler', 'spelers')}`;
}

export function mixCountsHtml(mix) {
  return `<p class="mix-counts" data-testid="mix-counts" data-total="${mix?.total || 0}" data-preview="${mix?.preview || 0}" data-contributors="${mix?.contributors || 0}">${icons.users}<span>${esc(mixCountsText(mix))}</span></p>`;
}

/** What redraws the panel: everything it shows. */
export function mixKey(ms, meta) {
  if (!ms) return '';
  const s = ms.state;
  return JSON.stringify([s.phase, s.error, s.done, s.total, s.tracks.length, s.skipped, s.range, s.count, meta?.mix, ms.problem()]);
}

/**
 * The panel of this phone. ms: createMixShare(); meta: the server's meta (mix counts);
 * inGame: a game is running (new songs count from the next game).
 */
export function mixPanelHtml(ms, meta, { inGame = false } = {}) {
  const s = ms.state;
  const mineOnServer = meta?.mix?.mine ?? 0;
  const problem = ms.problem();
  let body;
  if (problem === 'no-client') {
    body = `<p class="mix-note" data-testid="mix-no-client">${esc(top.MESSAGES['no-client'])}</p>`;
  } else if (problem && s.phase === 'idle') {
    body = `<p class="mix-note" data-testid="mix-env">${esc(spotify.errorMessage(problem))}</p>`;
  } else if (s.phase === 'connecting') {
    body = '<p class="mix-note" data-testid="mix-connecting" role="status">Inloggen bij Spotify…</p>';
  } else if (s.phase === 'fetching') {
    body = `<p class="mix-note" data-testid="mix-fetching" role="status">Je meest geluisterde nummers ophalen bij Spotify (${esc(rangeLabel(s.range).toLowerCase())})…</p>`;
  } else if (s.phase === 'matching' || s.phase === 'done') {
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
    const running = s.phase === 'matching';
    body = `${running ? `<div class="pl-progress" data-testid="mix-progress" data-done="${s.done}" data-total="${s.total}" role="status">
        <div class="pl-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
        <p class="small">Fragment en jaartal zoeken bij Apple Music: ${s.done} van ${s.total} · ${plural(s.tracks.length, 'nummer', 'nummers')} gedeeld</p>
      </div>` : ''}
      <p class="mix-done" data-testid="mix-done" data-mine="${mineOnServer}">${icons.check}<span>Je deelt <b>${plural(mineOnServer, 'nummer', 'nummers')}</b> met deze kamer${running ? ' (er komen er nog bij)' : ''}.</span></p>
      ${s.skipped ? `<p class="small muted">${plural(s.skipped, 'nummer doet', 'nummers doen')} niet mee: geen jaartal gevonden.</p>` : ''}
      ${s.tracks.length ? `<details class="mix-mine" data-testid="mix-mine-list"><summary>Bekijk jouw nummers (alleen op dit toestel)</summary>
        <ul>${s.tracks.map((t) => `<li><b>${esc(t.title)}</b> · ${esc(t.artist)} · ${esc(t.year)}${t.yearSure ? '' : ' <small class="pl-warn-txt">jaar onzeker</small>'}${t.previewUrl || t.itunesId ? '' : ' <small class="muted">alleen via Spotify</small>'}</li>`).join('')}</ul></details>` : ''}
      <div class="mix-actions">
        <button class="btn btn-ghost btn-small" type="button" data-action="mix-withdraw" data-testid="mix-withdraw">${icons.close}<span>Trek mijn bijdrage in</span></button>
      </div>`;
  } else {
    const opt = (list, cur, label) => list.map((v) => `<option value="${esc(v.key ?? v)}" ${String(v.key ?? v) === String(cur) ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
    body = `<p class="mix-consent" data-testid="mix-consent">${esc(CONSENT)}</p>
      <div class="mix-form">
        <label class="pl-label">Periode
          <select data-testid="mix-range" data-mix="range">${opt(RANGES, s.range, (r) => r.label)}</select></label>
        <label class="pl-label">Aantal
          <select data-testid="mix-count" data-mix="count">${opt(SHARE_COUNTS, s.count, (n) => `${n} nummers`)}</select></label>
      </div>
      ${s.error ? `<p class="set-error" data-testid="mix-error" role="alert">${esc(s.error)}</p>` : ''}
      <button class="btn btn-secondary" type="button" data-action="mix-share" data-testid="mix-share">${spotifyIcon}<span>${s.phase === 'error' ? 'Probeer opnieuw' : 'Doe mijn favorieten erbij'}</span></button>
      <p class="small muted">De app kiest willekeurig ${s.count} nummers uit je top 50 bij Spotify, zoekt bij Apple Music het fragment en het jaartal op en stuurt ze naar de kamer zodra ze klaar zijn. Je logt zelf in bij Spotify; zolang de Spotify-app van de eigenaar in Development Mode staat, moet die jouw account eerst toevoegen (maximaal 5).</p>`;
  }
  if (s.error && s.phase !== 'error' && s.phase !== 'idle') body += `<p class="set-error" data-testid="mix-error" role="alert">${esc(s.error)}</p>`;
  return `<section class="mix-panel" data-testid="mix-panel" data-phase="${esc(s.phase)}">
    <h2 class="room-h">Jouw favorieten</h2>
    ${inGame ? '<p class="small muted" data-testid="mix-next-game">Nummers die je nu deelt, doen mee vanaf het volgende potje.</p>' : ''}
    ${body}
  </section>`;
}

/** Lobby (and during a game, folded away): counts + this phone's panel. */
export function mixBlockHtml(ms, meta, { inGame = false, music = 'deck' } = {}) {
  const head = `${mixCountsHtml(meta?.mix)}${music === 'mix' ? `<span class="pill pill-on" data-testid="mix-chosen">${inGame ? 'speelt nu' : 'gekozen'}</span>` : ''}`;
  if (!inGame) return `<div class="mix-block" data-testid="mix-block"><div class="mix-head">${head}</div>${mixPanelHtml(ms, meta, { inGame })}</div>`;
  const open = ['connecting', 'fetching', 'matching', 'error'].includes(ms.state.phase);
  return `<details class="mix-block" data-testid="mix-block" ${open ? 'open' : ''}>
    <summary><span class="mix-head">${head}</span><small class="mix-tap muted">Tik hier om (ook) je eigen favorieten te delen of in te trekken.</small></summary>
    ${mixPanelHtml(ms, meta, { inGame })}
  </details>`;
}

/** Without a room server (PeerJS): explain that the mix needs the server. */
export function mixServerOnlyHtml() {
  return '<p class="muted small mix-note" data-testid="mix-server-only">Mix van de groep (ieders meest geluisterde nummers uit Spotify) werkt alleen via de kamerserver, niet bij rechtstreeks verbinden.</p>';
}

/** How many songs the leader's choice still needs (0 = enough). */
export function mixShortage(mix, settings, players, source) {
  const have = source === 'spotify' ? mix?.total || 0 : mix?.preview || 0;
  const need = mixMinimum(settings, players);
  return { have, need, missing: Math.max(0, need - have) };
}

/** Handle a change of the period / number selects. True when handled. */
export function onMixChange(ms, e) {
  const t = e.target;
  if (!ms || !t.matches?.('[data-mix]')) return false;
  ms.setChoice(t.dataset.mix === 'range' ? { range: t.value } : { count: Number(t.value) });
  return true;
}
