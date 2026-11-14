// Choose the music (#/playlists): the built-in deck or an own playlist; create
// playlists and import backups. Also receives shared links (#/pl/<payload>).
import * as store from '../playlists.js';
import * as itunes from '../itunes.js';
import { loadBuiltinDeck } from '../deck.js';
import {
  BUILTIN_ID, BUILTIN_NAME, NAME_MAX, MIN_TRACKS, readiness, decodeShare, importBackup, validYear,
} from '../playlist-logic.js';
import { icons, esc, toast } from '../ui.js';

export const name = 'playlists';

const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;
const uploadIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19.5h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const editIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

export function render(root, { params, navigate }) {
  if (params[0]) return renderImport(root, params[0], navigate);

  let builtinCount = null;
  let alive = true;

  function deckRow({ id, title, sub, warn = '', active, edit = false, check = 0 }) {
    return `<li class="pl-deck${active ? ' is-active' : ''}" data-testid="deck-option" data-deck-id="${esc(id)}">
      <button type="button" class="pl-pick" data-act="activate" data-id="${esc(id)}" data-testid="deck-pick" data-deck-id="${esc(id)}" aria-pressed="${active}">
        <span class="pl-radio" aria-hidden="true">${active ? icons.check : ''}</span>
        <span class="pl-pick-text"><b>${esc(title)}</b><small>${sub}</small>
          ${check ? `<small class="pl-warn-txt">${plural(check, 'jaar', 'jaren')} controleren</small>` : ''}
          ${warn ? `<small class="pl-warn-txt" data-testid="deck-too-small">${warn}</small>` : ''}</span>
        ${active ? '<span class="pill pill-on">Actief</span>' : ''}
      </button>
      ${edit ? `<a class="icon-btn" href="#/playlists/${esc(id)}" aria-label="Bewerk ${esc(title)}" data-testid="playlist-open" data-deck-id="${esc(id)}">${editIcon}</a>` : ''}
    </li>`;
  }

  function draw() {
    const active = store.getActiveId();
    const lists = store.all();
    const rows = [deckRow({
      id: BUILTIN_ID, title: BUILTIN_NAME, active: active === BUILTIN_ID,
      sub: `${builtinCount == null ? '…' : plural(builtinCount, 'kaart', 'kaarten')} · ingebouwd, ook als geprinte kaartjes`,
    })];
    for (const p of lists) {
      const n = store.playableCount(p);
      const r = readiness(n);
      const check = p.tracks.filter((t) => !t.yearSure || !validYear(t.year)).length;
      let warn = '';
      if (!r.timeline) warn = `Te weinig om te spelen (Tijdlijn ${MIN_TRACKS.timeline}, Bingo ${MIN_TRACKS.bingo})`;
      else if (!r.bingo) warn = `Genoeg voor Tijdlijn; Bingo vraagt er ${MIN_TRACKS.bingo}`;
      rows.push(deckRow({ id: p.id, title: p.name, active: active === p.id, sub: `${plural(p.tracks.length, 'nummer', 'nummers')} · eigen playlist`, warn, edit: true, check }));
    }
    root.innerHTML = `<section class="screen screen-playlists" data-testid="screen-playlists">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
        <h1 class="topbar-title">Muziek kiezen</h1>
        <span class="topbar-spacer"></span>
      </header>
      <p class="lead small-lead">Kies met welke muziek je speelt. Dat geldt voor scannen, Tijdlijn, Bingo en het printen van kaartjes.</p>
      <ul class="pl-decks" data-testid="deck-list">${rows.join('')}</ul>
      <form class="set-card pl-new" data-testid="playlist-new-form" autocomplete="off">
        <h2>Eigen playlist maken</h2>
        <div class="pl-search">
          <input type="text" name="name" maxlength="${NAME_MAX}" placeholder="Naam, bv. Feestje" aria-label="Naam van de nieuwe playlist" data-testid="playlist-new-name" enterkeyhint="done">
          <button class="btn btn-primary btn-small" type="submit" data-testid="playlist-create">${icons.plus}<span>Maak</span></button>
        </div>
        <p class="small muted">Daarna voeg je nummers toe: zoeken, een lijst plakken of een Spotify-playlist overnemen.</p>
      </form>
      <section class="set-card pl-backup">
        <h2>Back-up terugzetten</h2>
        <p class="small muted">Een bestand dat je eerder met <em>Exporteer</em> hebt bewaard. Er komt een nieuwe playlist bij; er wordt niets overschreven.</p>
        <label class="btn btn-ghost btn-small pl-file">${uploadIcon}<span>Kies een bestand</span>
          <input type="file" accept=".json,application/json" data-testid="playlist-import-file" class="sr-only"></label>
      </section>
      <a class="btn btn-ghost" href="#/" data-testid="playlists-home">${icons.home}<span>Naar start</span></a>
    </section>`;
  }

  async function importFile(file) {
    let json;
    try { json = JSON.parse(await file.text()); } catch { toast('Dit bestand is geen TimeTunesr-back-up.', { kind: 'warn' }); return; }
    const lists = importBackup(json);
    if (!lists.length) { toast('Geen playlist met nummers gevonden in dit bestand.', { kind: 'warn' }); return; }
    const total = lists.reduce((s, p) => s + p.tracks.length, 0);
    const names = lists.map((p) => `“${p.name}”`).join(', ');
    if (!window.confirm(`${lists.length === 1 ? 'Playlist' : 'Playlists'} ${names} (${plural(total, 'nummer', 'nummers')}) toevoegen aan dit toestel?`)) return;
    let last = null;
    for (const p of lists) {
      last = store.create(p.name, { tracks: p.tracks, nextN: p.nextN });
      if (!last) { toast('Opslaan lukte niet: de opslag van de browser is vol.', { kind: 'warn', ms: 5000 }); break; }
    }
    if (last) {
      toast(`${plural(lists.length, 'playlist', 'playlists')} teruggezet.`, { ms: 2400 });
      if (lists.length === 1) navigate(`#/playlists/${last.id}`);
      else draw();
    }
  }

  function onClick(e) {
    const a = e.target.closest('[data-act="activate"]');
    if (!a || !root.contains(a)) return;
    const id = store.setActive(a.dataset.id);
    const p = store.get(id);
    toast(`Je speelt nu met ${p ? `“${p.name}”` : 'het TimeTunesr-deck'}.`, { ms: 2200 });
    draw();
    root.querySelector(`[data-testid="deck-pick"][data-deck-id="${CSS.escape(id)}"]`)?.focus();
  }
  function onSubmit(e) {
    if (!e.target.matches('[data-testid="playlist-new-form"]')) return;
    e.preventDefault();
    const nm = e.target.elements.name.value.trim();
    if (!nm) { e.target.elements.name.focus(); toast('Geef je playlist eerst een naam.', { kind: 'warn' }); return; }
    const p = store.create(nm);
    if (!p) { toast('Opslaan lukte niet: de opslag van de browser is vol of uitgeschakeld.', { kind: 'warn', ms: 5000 }); return; }
    navigate(`#/playlists/${p.id}`);
  }
  function onChange(e) {
    if (e.target.matches('[data-testid="playlist-import-file"]') && e.target.files?.[0]) {
      importFile(e.target.files[0]);
      e.target.value = '';
    }
  }

  draw();
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  const unsub = store.subscribe(() => { if (alive) draw(); });
  loadBuiltinDeck().then((d) => { builtinCount = d.cards.length; if (alive) draw(); }).catch(() => {});

  return () => {
    alive = false;
    unsub();
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('change', onChange);
  };
}

/* ---------- receiving a shared playlist (#/pl/<payload>) ---------- */

function renderImport(root, payload, navigate) {
  const share = decodeShare(payload);
  let alive = true;
  let busy = false;
  let progress = '';
  const ctrl = new AbortController();

  function draw(extra = '') {
    if (!share) {
      root.innerHTML = `<section class="screen screen-center" data-testid="screen-playlist-import">
        <div class="panel"><h1>Link werkt niet</h1>
          <p data-testid="pl-import-invalid">Deze deel-link is beschadigd of onvolledig. Vraag de afzender om de link opnieuw te sturen.</p>
          <div class="stack"><a class="btn btn-primary" href="#/playlists">Naar je playlists</a></div></div></section>`;
      return;
    }
    const existing = store.findByShareId(share.shareId);
    const seen = existing?.partsSeen || [];
    const partTxt = share.total > 1 ? ` · code ${share.part} van ${share.total}` : '';
    const already = existing && share.total > 1 && seen.includes(share.part);
    root.innerHTML = `<section class="screen screen-center" data-testid="screen-playlist-import">
      <div class="panel pl-import">
        <h1>Playlist ontvangen</h1>
        <p class="pl-import-name"><b data-testid="pl-import-name">${esc(share.name)}</b><br><span class="muted" data-testid="pl-import-count">${plural(share.items.length, 'nummer', 'nummers')}${partTxt}</span></p>
        ${existing ? `<p class="small" data-testid="pl-import-existing">Je hebt deze playlist al: <b>${esc(existing.name)}</b> (${plural(existing.tracks.length, 'nummer', 'nummers')}). ${already ? 'Deze code is al eerder gescand.' : 'Nieuwe nummers komen erbij; jaren die je zelf hebt aangepast blijven staan.'}</p>`
    : '<p class="small">De titels worden opgehaald bij Apple Music. Je huidige muziek verandert niet: je kiest daarna zelf of je met deze playlist speelt.</p>'}
        ${progress ? `<p class="small" data-testid="pl-import-progress" role="status">${esc(progress)}</p>` : ''}
        ${extra}
        <div class="stack">
          <button class="btn btn-primary btn-xl" type="button" data-act="import" data-testid="pl-import-confirm" ${busy ? 'disabled' : ''}>${icons.plus}<span>${existing ? 'Voeg toe aan mijn playlist' : 'Zet op dit toestel'}</span></button>
          <a class="btn btn-ghost" href="#/" data-testid="pl-import-cancel">${icons.close}<span>Niet nu</span></a>
        </div>
      </div>
    </section>`;
  }

  async function doImport() {
    if (busy) return;
    busy = true;
    progress = 'Titels ophalen bij Apple Music…';
    draw();
    let found;
    try {
      found = await itunes.lookup(share.items.map((i) => i.itunesId), {
        signal: ctrl.signal,
        onProgress: (n, total) => { progress = `Titels ophalen: ${n} van ${total}…`; if (alive) draw(); },
      });
    } catch (e) {
      if (!alive || e.code === 'aborted') return;
      busy = false;
      progress = '';
      draw(`<p class="set-error" role="alert" data-testid="pl-import-error">${esc(itunes.errorMessage(e))}</p>`);
      return;
    }
    if (!alive) return;
    const tracks = [];
    let missing = 0;
    for (const it of share.items) {
      const r = found.get(it.itunesId);
      if (!r) { missing++; continue; }
      tracks.push({
        itunesId: it.itunesId, title: r.trackName, artist: r.artistName, album: r.collectionName || '',
        year: it.year, yearSure: true, previewUrl: r.previewUrl || null, trackViewUrl: r.trackViewUrl || null,
      });
    }
    let p = store.findByShareId(share.shareId);
    let added;
    if (p) {
      added = store.addTracks(p.id, tracks).added.length;
    } else {
      p = store.create(share.name, { tracks, shareId: share.shareId });
      if (!p) { busy = false; progress = ''; draw('<p class="set-error" role="alert">Opslaan lukte niet: de opslag van de browser is vol of uitgeschakeld.</p>'); return; }
      added = p.tracks.length;
    }
    const seen = [...new Set([...(store.get(p.id).partsSeen || []), share.part])];
    store.patchPlaylist(p.id, { partsSeen: seen, partsTotal: share.total });
    const left = share.total > 1 ? share.total - seen.filter((n) => n <= share.total).length : 0;
    let msg = `${plural(added, 'nummer', 'nummers')} toegevoegd aan “${p.name}”.`;
    if (missing) msg += ` ${plural(missing, 'nummer is', 'nummers zijn')} niet (meer) beschikbaar bij Apple Music.`;
    if (left) msg += ` Scan nog ${plural(left, 'code', 'codes')} voor de rest.`;
    toast(msg, { ms: 5000, kind: missing ? 'warn' : 'info' });
    navigate(`#/playlists/${p.id}`);
  }

  const onClick = (e) => { if (e.target.closest('[data-act="import"]')) doImport(); };
  draw();
  root.addEventListener('click', onClick);
  return () => {
    alive = false;
    ctrl.abort();
    root.removeEventListener('click', onClick);
  };
}
