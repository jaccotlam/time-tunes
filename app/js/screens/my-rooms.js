// Mijn kamers (#/account/kamers ...): "een kamer helemaal klaarzetten". A logged-in user sets a
// room up days before the party (name, game and its settings, music, plays along, the music
// source); its code, join link, QR code and big-screen link are final at once and can be shared
// or printed. On the day: Open makes this device the spelleider of that room (any device).
//   #/account/kamers               the list
//   #/account/kamers/nieuw         Klaarzetten (a new room)
//   #/account/kamers/CODE/bewerk   Bewerk
//   #/account/kamers/CODE/deel     Deel (link, QR, code, big-screen link; prints as a card)
import * as account from '../account.js';
import * as playlists from '../playlists.js';
import * as spotify from '../spotify.js';
import { loadBuiltinDeck } from '../deck.js';
import { BUILTIN_NAME, playlistDeck } from '../playlist-logic.js';
import { playableCards, normalizeSettings, PREFERRED_GAME } from '../multi/game.js';
import { DISCO_MIN_SONGS } from '../multi/disco.js';
import { QUIZ_COUNTS, QUIZ_TIMES, QUIZ_MIN_SONGS } from '../multi/quiz.js';
import { mixMinimum } from '../multi/mix.js';
import { storedServerHost, copyText } from '../multi/server-session.js';
import { DEFAULT_GOAL } from '../logic.js';
import { icons, esc, toast, store } from '../ui.js';
import { qrSvg, roomLink, appBase, gameName, quizSettingsText } from './room-ui.js';
import { discoLobbyHtml, winText } from './room-disco.js';
import { syncNow, accountData, PREPARED_DAYS } from './account-bits.js';
import { whenText } from './account.js';

export const name = 'my-rooms';

const HOST_NAME_KEY = 'timetunesr.multiName.v1';
const screenLink = (code) => `${appBase()}#/scherm/${code}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dayFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long' });
const tvIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="4.5" width="19" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20.5h8M12 17v3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const editIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const trashIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const copyIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const doorOpenIcon = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13 3.5l6 2v13l-6 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="15.2" cy="12" r="1" fill="currentColor"/></svg>';
const QTYPES = { mix: 'Mix', year: 'Jaar', artist: 'Artiest', title: 'Titel' };

/** The last list from the server, so moving between list, Deel and Bewerk is instant. */
let cache = null; // { ok, rooms, max, at, user }
let justMade = ''; // code of the room that was just prepared (the Deel page says so)

/** Songs the lobby would count for this music (same filter as the host screen). */
const songCount = (cards) => playableCards((cards || []).filter((c) => c.previewUrl || c.itunesId || c.spotifyId)).length;

/** "Discobingo · winnen met 2 lijnen" */
export function gameSummary(s) {
  if (!s) return '';
  if (s.game === 'disco') return `Discobingo · winnen met ${winText(s.win)}`;
  if (s.game === 'bingo') return `Bingo · kaart van ${s.size}×${s.size}`;
  if (s.game === 'quiz') return `Quiz · ${quizSettingsText(s)}`;
  return `Tijdlijn · doel ${s.goal} kaarten`;
}

/** The music of a prepared room in words (the playlist by name when this device knows it). */
function musicName(m) {
  if (m === 'mix') return 'Mix van de groep';
  if (!m || m === 'deck') return BUILTIN_NAME;
  const p = playlists.get(m) || accountData()?.playlists?.find((x) => x.id === m);
  return p ? p.name : 'een playlist die niet meer bestaat';
}

export function render(root, { params = [], navigate }) {
  const sub = params[0] || '';
  const code = /^[A-Za-z]{4}$/.test(sub) ? sub.toUpperCase() : '';
  const mode = sub === 'nieuw' ? 'new' : code ? (params[1] === 'bewerk' ? 'edit' : 'share') : 'list';
  let alive = true;
  let data = cache && cache.user === account.current()?.username ? cache : null;
  let loading = false;
  let busy = ''; // code of the room an action is running for ('new' for the form)
  let cardErr = {}; // code -> { code, message }
  let confirmState = null; // { title, html, confirm, danger, resolve }
  let formErr = null;
  let form = null; // the prepare / edit form's values
  let builtin = null; // song count of the built-in deck (loaded once)

  const me = () => account.current();
  const room = (c) => data?.rooms?.find((r) => r.code === c) || null;

  /* ---------- the list ---------- */

  function badges(r) {
    const out = [];
    if (!r.exists) out.push('<span class="myroom-badge is-gone" data-testid="myroom-gone">Verlopen</span>');
    else {
      if (r.phase === 'answering' || r.phase === 'revealed') out.push('<span class="myroom-badge is-busy" data-testid="myroom-busy">Bezig</span>');
      if (r.leaderOnline) out.push('<span class="myroom-badge is-open" data-testid="myroom-open-elsewhere">Open op een toestel</span>');
    }
    return out.join('');
  }

  function roomCard(r) {
    const e = cardErr[r.code];
    const wait = r.exists && r.phase === 'lobby' && r.players > 0;
    const actions = r.exists
      ? `<button class="btn btn-primary myroom-open" type="button" data-act="open" data-code="${r.code}" data-testid="myroom-open" ${busy ? 'disabled' : ''}>${doorOpenIcon}<span>${busy === r.code ? 'Openen…' : 'Open'}</span></button>
        <div class="myroom-more">
          <a class="btn btn-small btn-ghost" href="#/account/kamers/${r.code}/deel" data-testid="myroom-share">${icons.share}<span>Deel</span></a>
          <a class="btn btn-small btn-ghost" href="#/account/kamers/${r.code}/bewerk" data-testid="myroom-edit">${editIcon}<span>Bewerk</span></a>
          <button class="btn btn-small btn-ghost" type="button" data-act="reset" data-code="${r.code}" data-testid="myroom-reset" ${busy ? 'disabled' : ''}>${icons.restart}<span>Opnieuw gebruiken</span></button>
          <button class="btn btn-small btn-ghost myroom-del" type="button" data-act="delete" data-code="${r.code}" data-testid="myroom-delete" ${busy ? 'disabled' : ''}>${trashIcon}<span>Verwijder</span></button>
        </div>`
      : `<div class="myroom-more">
          <button class="btn btn-small btn-primary" type="button" data-act="reset" data-code="${r.code}" data-testid="myroom-reset" ${busy ? 'disabled' : ''}>${icons.restart}<span>Opnieuw gebruiken</span></button>
          <button class="btn btn-small btn-ghost myroom-del" type="button" data-act="delete" data-code="${r.code}" data-testid="myroom-delete" ${busy ? 'disabled' : ''}>${trashIcon}<span>Verwijder</span></button>
        </div>`;
    const music = r.exists ? `${musicName(r.music)}${r.play === 'spotify' ? ' · via Spotify' : ''}${r.hostPlays ? ` · ${esc(r.hostName || 'jij')} speelt mee` : ''}` : '';
    return `<li class="myroom${r.exists ? '' : ' is-gone'}" data-testid="myroom" data-code="${r.code}" data-exists="${r.exists}" data-phase="${esc(r.phase || '')}">
      <div class="myroom-head">
        <div class="myroom-title"><h2 data-testid="myroom-name">${esc(r.name)}</h2><div class="myroom-badges">${badges(r)}</div></div>
        <p class="myroom-code" data-testid="myroom-code" aria-label="Kamercode ${[...r.code].join(' ')}">${esc(r.code)}</p>
      </div>
      ${r.exists ? `<p class="myroom-game" data-testid="myroom-game">${esc(gameSummary(r.settings))}</p>
      <p class="myroom-music" data-testid="myroom-music">${icons.music}<span>${esc(music)}</span></p>
      ${wait ? `<p class="myroom-wait" data-testid="myroom-waiting" data-count="${r.players}">${plural(r.players, 'speler wacht', 'spelers wachten')} al in de lobby</p>` : ''}
      <p class="myroom-meta" data-testid="myroom-meta">Laatst gebruikt ${esc(whenText(r.lastActive))} · staat klaar tot ${esc(dayFmt.format(new Date(r.expiresAt)))}</p>`
    : `<p class="myroom-meta" data-testid="myroom-meta">Deze kamer is ${PREPARED_DAYS} dagen niet gebruikt en is verlopen. <b>Opnieuw gebruiken</b> zet hem weer klaar, met dezelfde code als die nog vrij is.</p>`}
      ${e ? `<p class="acct-err" data-testid="myroom-error" data-code="${esc(e.code)}" role="alert">${esc(e.message)}</p>` : ''}
      <div class="myroom-actions">${actions}</div>
    </li>`;
  }

  function listHtml() {
    if (!data) {
      return `<p class="muted" data-testid="myrooms-loading" role="status">${loading ? 'Je kamers worden opgehaald…' : ''}</p>`;
    }
    if (!data.ok) {
      return `<div class="acct-save is-error" data-testid="myrooms-error" data-code="${esc(data.code)}" role="alert"><p>${esc(data.message || 'Je kamers konden niet worden opgehaald.')}</p>
        <button class="btn btn-small btn-ghost" type="button" data-act="reload" data-testid="myrooms-retry">${icons.restart}<span>Opnieuw</span></button></div>`;
    }
    const full = data.rooms.length >= data.max;
    const add = `<a class="btn btn-primary btn-xl${full ? ' is-disabled' : ''}" ${full ? 'aria-disabled="true"' : 'href="#/account/kamers/nieuw"'} data-testid="myrooms-new">${icons.plus}<span>Kamer klaarzetten</span></a>
      ${full ? `<p class="small muted" data-testid="myrooms-full">Je hebt er ${data.max} klaarstaan, het maximum. Verwijder er een om een nieuwe klaar te zetten.</p>` : ''}`;
    if (!data.rooms.length) {
      return `<div class="myrooms-empty" data-testid="myrooms-empty">
        <span class="myrooms-empty-mark" aria-hidden="true">${doorOpenIcon}</span>
        <p><b>Zet je kamer dagen van tevoren klaar.</b> Kies de naam, het spel en de muziek: de code, de QR-code en de link voor het grote scherm liggen dan al vast, om te delen of te printen.</p>
        <p class="muted">Op de dag zelf log je op elk toestel in en tik je hier op <b>Open</b>. Wie vroeg is, wacht al in de lobby.</p>
      </div>${add}`;
    }
    return `${add}<ul class="myrooms" data-testid="myrooms-list">${data.rooms.map(roomCard).join('')}</ul>
      <p class="small muted center">Een klaargezette kamer blijft ${PREPARED_DAYS} dagen na het laatste gebruik bestaan. Je kunt er ${data.max} hebben.</p>`;
  }

  /* ---------- the prepare / edit form ---------- */

  function defaultsFor(r) {
    if (r) {
      return {
        name: r.name, settings: normalizeSettings(r.settings), music: r.music || 'deck', play: r.play === 'spotify' ? 'spotify' : 'preview',
        hostPlays: !!r.hostPlays, hostName: r.hostName && r.hostName !== 'Spelleider' ? r.hostName : '',
      };
    }
    const active = playlists.getActiveId();
    return {
      name: '',
      settings: normalizeSettings({ game: PREFERRED_GAME }),
      music: playlists.get(active) ? active : 'deck',
      play: spotify.getSettings().source === 'spotify' ? 'spotify' : 'preview',
      hostPlays: false,
      hostName: store.get(HOST_NAME_KEY, '') || me()?.username || '',
    };
  }

  /** Songs in the chosen music (null while the built-in deck loads; mix: unknown in advance). */
  function haveFor(music) {
    if (music === 'mix') return null;
    if (music === 'deck') return builtin;
    const p = playlists.get(music);
    return p ? songCount(playlistDeck(p).cards) : null;
  }

  /** The songs-needed rule of the game, said the way the lobby says it. */
  function needHtml(s, music) {
    if (music === 'mix') {
      const need = mixMinimum(s, 1);
      return `<p class="muted small" data-testid="prep-need" data-mix="true">Met de <b>Mix van de groep</b> doen de spelers op hun eigen telefoon <b>Doe mijn favorieten erbij</b>. Voor ${esc(gameName(s.game))} zijn er minstens ${need} nummers nodig${s.game === 'disco' ? '' : ' (meer bij meer spelers)'}; in de lobby zie je hoeveel er al zijn.</p>`;
    }
    const have = haveFor(music);
    if (have == null) return '';
    if (s.game === 'disco') return ''; // discoLobbyHtml says it, exactly as in the lobby
    if (s.game === 'quiz') {
      const max = Math.min(s.questions, have);
      return have < QUIZ_MIN_SONGS
        ? `<p class="warn small" data-testid="prep-need" data-missing="${QUIZ_MIN_SONGS - have}">Voor de quiz zijn minstens ${QUIZ_MIN_SONGS} nummers nodig: nog ${QUIZ_MIN_SONGS - have}.</p>`
        : `<p class="muted small" data-testid="prep-need">${max < s.questions ? `Er staan maar ${have} nummers in, dus ${max} vragen.` : `${max} vragen.`}</p>`;
    }
    const players = Math.max(0, Math.min(12, have - 2));
    return players < 1
      ? `<p class="warn small" data-testid="prep-need" data-missing="${3 - have}">Te weinig nummers om te spelen: er zijn er minstens 3 nodig (twee meer dan het aantal spelers).</p>`
      : `<p class="muted small" data-testid="prep-need">${have} nummers: genoeg voor ${players === 12 ? 'een volle kamer (12 spelers)' : `${plural(players, 'speler', 'spelers')}`}.</p>`;
  }

  function gameSubHtml(s) {
    if (s.game === 'disco') return discoLobbyHtml(s, { have: haveFor(form.music) ?? DISCO_MIN_SONGS, mix: form.music === 'mix' });
    if (s.game === 'bingo') {
      return `<div class="size-pick room-sub" role="radiogroup" aria-label="Grootte van de bingokaart">
        ${[[3, '3×3', 'snel potje'], [4, '4×4', 'standaard']].map(([n, t, subt]) => `<label class="size-opt"><input type="radio" name="size" value="${n}" ${s.size === n ? 'checked' : ''} data-testid="prep-size-${n}"><span class="size-box"><b>${t}</b><small>${subt}</small></span></label>`).join('')}
      </div>`;
    }
    if (s.game === 'quiz') {
      const pick = (nm, list, cur, label, testid, aria) => `<div class="seg room-seg" role="radiogroup" aria-label="${aria}">${list.map((v) => `<label class="seg-opt"><input type="radio" name="${nm}" value="${v}" ${String(cur) === String(v) ? 'checked' : ''} data-testid="${testid}-${v}"><span>${label(v)}</span></label>`).join('')}</div>`;
      return `<div class="room-sub room-quiz-settings" data-testid="prep-quiz-settings">
        <p class="room-label">Aantal vragen</p>${pick('questions', QUIZ_COUNTS, s.questions, (n) => `${n}`, 'prep-quiz-count', 'Aantal vragen')}
        <p class="room-label">Soort vragen</p>${pick('qtype', Object.keys(QTYPES), s.qtype, (k) => QTYPES[k], 'prep-quiz-type', 'Soort vragen')}
        <p class="room-label">Bedenktijd</p>${pick('think', QUIZ_TIMES, s.think, (n) => `${n} s`, 'prep-quiz-time', 'Bedenktijd')}
        <p class="muted small">Goed = 500 punten plus tot 500 voor snelheid, en een kleine bonus voor een reeks goede antwoorden.</p>
      </div>`;
    }
    return `<div class="stepper room-sub">
        <button class="icon-btn" type="button" data-act="goal-minus" aria-label="Minder kaarten" data-testid="prep-goal-minus">${icons.minus}</button>
        <output data-testid="prep-goal-value" aria-live="polite"><b>${s.goal}</b> kaarten</output>
        <button class="icon-btn" type="button" data-act="goal-plus" aria-label="Meer kaarten" data-testid="prep-goal-plus">${icons.plus}</button>
      </div><p class="muted small">Doel (standaard ${DEFAULT_GOAL}); de startkaart telt mee.</p>`;
  }

  function formHtml() {
    const s = form.settings;
    const editing = mode === 'edit';
    const r = editing ? room(code) : null;
    const opt = (val, title, subt) => `<label class="size-opt"><input type="radio" name="game" value="${val}" ${s.game === val ? 'checked' : ''} data-testid="prep-game-${val}">
      <span class="size-box"><b>${title}</b><small>${subt}</small></span></label>`;
    const lists = playlists.all();
    // a playlist of the account that is not on this device (yet) stays selectable while editing
    const extra = form.music !== 'deck' && form.music !== 'mix' && !playlists.get(form.music) ? [{ id: form.music, name: musicName(form.music), missing: true }] : [];
    const musicOpt = (val, title, subt, testid) => `<label class="size-opt"><input type="radio" name="music" value="${esc(val)}" ${form.music === val ? 'checked' : ''} data-testid="${testid}">
      <span class="size-box"><b>${esc(title)}</b><small>${subt}</small></span></label>`;
    const busyGame = editing && r && (r.phase === 'answering' || r.phase === 'revealed');
    return `<form class="setup prep-form" data-testid="prep-form" autocomplete="off" novalidate>
      ${formErr ? `<p class="acct-err acct-err-form" data-testid="prep-error" data-code="${esc(formErr.code)}" role="alert">${esc(formErr.message)}</p>` : ''}
      ${busyGame ? '<p class="warn small" data-testid="prep-busy-note">Er loopt nu een spel in deze kamer. De naam kun je aanpassen; spel en muziek pas als het potje klaar is.</p>' : ''}
      <fieldset>
        <legend><label for="prep-name">Naam van de kamer</label></legend>
        <input id="prep-name" type="text" name="roomname" maxlength="40" placeholder="bv. Feest zaterdag" value="${esc(form.name)}" data-testid="prep-name" required aria-describedby="prep-name-hint" class="prep-name">
        <p class="muted small" id="prep-name-hint">Iedereen die meedoet ziet deze naam, ook op het grote scherm.</p>
      </fieldset>
      <fieldset>
        <legend>Welk spel?</legend>
        <div class="size-pick" role="radiogroup" aria-label="Welk spel?">
          <label class="size-opt room-disco-opt"><input type="radio" name="game" value="disco" ${s.game === 'disco' ? 'checked' : ''} data-testid="prep-game-disco">
            <span class="size-box"><b>Discobingo</b><small>de discobal kiest de vraag, jij kiest je vakje op een 5×5-kaart</small></span></label>
          ${opt('bingo', 'Bingo', 'eigen bingokaart, eerst een volle rij')}
          ${opt('timeline', 'Tijdlijn', 'eigen tijdlijn, eerst het doel')}
          <label class="size-opt room-quiz-opt"><input type="radio" name="game" value="quiz" ${s.game === 'quiz' ? 'checked' : ''} data-testid="prep-game-quiz">
            <span class="size-box"><b>Quiz</b><small>vier antwoorden per nummer, snelheid telt</small></span></label>
        </div>
        ${gameSubHtml(s)}
      </fieldset>
      <fieldset class="room-music">
        <legend>Welke muziek?</legend>
        <div class="size-pick prep-music" role="radiogroup" aria-label="Welke muziek?">
          ${musicOpt('deck', BUILTIN_NAME, `ingebouwd · ${builtin == null ? '…' : plural(builtin, 'nummer', 'nummers')}`, 'prep-music-deck')}
          ${lists.map((p) => musicOpt(p.id, p.name, `eigen playlist · ${plural(songCount(playlistDeck(p).cards), 'nummer', 'nummers')}`, `prep-music-${p.id}`)).join('')}
          ${extra.map((p) => musicOpt(p.id, p.name, 'playlist van je account, niet op dit toestel', `prep-music-${p.id}`)).join('')}
          ${musicOpt('mix', 'Mix van de groep', 'de favorieten van de spelers', 'prep-music-mix')}
        </div>
        ${needHtml(s, form.music)}
        ${lists.length ? '' : '<p class="muted small">Eigen muziek? Maak eerst een <a href="#/playlists">playlist</a>; die komt dan hier te staan.</p>'}
      </fieldset>
      <fieldset>
        <legend>Hoe klinkt de muziek?</legend>
        <div class="seg room-seg prep-play" role="radiogroup" aria-label="Hoe klinkt de muziek?">
          <label class="seg-opt"><input type="radio" name="play" value="preview" ${form.play !== 'spotify' ? 'checked' : ''} data-testid="prep-play-preview"><span>Fragmenten (30 s)</span></label>
          <label class="seg-opt"><input type="radio" name="play" value="spotify" ${form.play === 'spotify' ? 'checked' : ''} data-testid="prep-play-spotify"><span>Spotify</span></label>
        </div>
        <p class="muted small">${form.play === 'spotify'
    ? 'Hele nummers via Spotify (Premium). Het toestel waarop je de kamer opent moet met Spotify verbonden zijn; anders klinken de fragmenten van 30 seconden.'
    : 'Fragmenten van 30 seconden via Apple Music: geen account nodig.'}</p>
      </fieldset>
      <fieldset>
        <legend>Speel je zelf mee?</legend>
        <label class="check-row"><input type="checkbox" name="plays" ${form.hostPlays ? 'checked' : ''} data-testid="prep-host-plays"><span>Ja, ik speel mee op het toestel van de spelleider</span></label>
        <label class="prep-label" for="prep-host-name">Naam van de spelleider</label>
        <input id="prep-host-name" type="text" name="hostname" maxlength="24" placeholder="Jouw naam" value="${esc(form.hostName)}" data-testid="prep-host-name" class="host-name">
        <p class="muted small">Zo heet je in de kamer als je meespeelt, en zo zien spelers wie de leiding heeft.</p>
      </fieldset>
      <button class="btn btn-primary btn-xl" type="submit" data-testid="prep-save" ${busy ? 'disabled' : ''}>${editing ? icons.check : icons.plus}<span>${busy ? 'Even geduld…' : editing ? 'Bewaar' : 'Zet de kamer klaar'}</span></button>
      ${editing ? '' : `<p class="muted small center">De kamer bestaat meteen: de code ligt vast en blijft ${PREPARED_DAYS} dagen na het laatste gebruik geldig.</p>`}
    </form>`;
  }

  /* ---------- Deel ---------- */

  function shareHtml(r) {
    const join = roomLink(r.code);
    const scr = screenLink(r.code);
    const row = (label, value, act, testid, extra = '') => `<div class="share-row">
        <p class="share-row-label">${label}</p>
        <p class="share-row-value" data-testid="${testid}-value">${esc(value)}</p>
        <div class="share-row-btns"><button class="btn btn-small btn-ghost" type="button" data-act="${act}" data-testid="${testid}" aria-label="Kopieer: ${esc(label)}">${copyIcon}<span>Kopieer</span></button>${extra}</div>
      </div>`;
    return `${justMade === r.code ? `<p class="acct-sync" data-testid="share-made" role="status">${icons.check}<span><b>Je kamer staat klaar.</b> De code en de QR-code liggen vast: deel ze nu al, of print de kaart.</span></p>` : ''}
      <article class="share-card" data-testid="share-card" aria-labelledby="share-name">
        <p class="share-kicker">Doe mee met</p>
        <h2 class="share-name" id="share-name" data-testid="share-name">${esc(r.name)}</h2>
        <a class="share-qr" href="${esc(join)}" data-testid="share-qr" aria-label="QR-code om mee te doen: ${esc(join)}">${qrSvg(join)}</a>
        <p class="share-code-label">Kamercode</p>
        <p class="share-code" data-testid="share-code" aria-label="Kamercode ${[...r.code].join(' ')}">${esc(r.code)}</p>
        <p class="share-how">Scan de QR-code met je telefoon. Of open TimeTunesr, tik op <b>Doe mee</b> en vul de code in.</p>
        <p class="share-print-url">${esc(join)}</p>
      </article>
      <div class="share-rows set-card">
        ${row('Link om mee te doen', join, 'copy-join', 'share-copy-join')}
        ${row('Kamercode', r.code, 'copy-code', 'share-copy-code')}
        ${row('Groot scherm (tv of laptop)', scr, 'copy-screen', 'share-copy-screen', `<a class="btn btn-small btn-ghost" href="${esc(scr)}" target="_blank" rel="noopener" data-testid="share-open-screen">${tvIcon}<span>Open</span></a>`)}
        <p class="small muted">Het grote scherm kun je nu al openzetten: het toont de QR-code en wie er binnen is. Wie meedoet, wacht in de lobby tot jij de kamer opent en het spel start.</p>
      </div>
      <div class="acct-row share-actions">
        <button class="btn btn-primary" type="button" data-act="share-native" data-testid="share-send">${icons.share}<span>Deel de link</span></button>
        <button class="btn btn-ghost" type="button" data-act="print" data-testid="share-print">${icons.print}<span>Print de kaart</span></button>
      </div>`;
  }

  /* ---------- confirmation sheet ---------- */

  function ask({ title, html, confirm, danger = false, testid = 'myrooms-confirm' }) {
    return new Promise((resolve) => {
      confirmState = { title, html, confirm, danger, resolve, testid };
      drawSheet();
    });
  }
  function sheetHtml() {
    const c = confirmState;
    if (!c) return '';
    return `<div class="sheet-backdrop" data-act="confirm-no" data-testid="${c.testid}">
      <div class="sheet acct-sheet" role="alertdialog" aria-modal="true" aria-labelledby="mr-sheet-title" aria-describedby="mr-sheet-text">
        <h2 id="mr-sheet-title">${esc(c.title)}</h2>
        <div id="mr-sheet-text">${c.html}</div>
        <button class="btn ${c.danger ? 'btn-danger' : 'btn-primary'} btn-xl" type="button" data-act="confirm-yes" data-testid="myrooms-confirm-yes">${esc(c.confirm)}</button>
        <button class="btn btn-ghost" type="button" data-act="confirm-no" data-testid="myrooms-confirm-no">${icons.close}<span>Annuleer</span></button>
      </div>
    </div>`;
  }
  function drawSheet() {
    const s = root.querySelector('[data-slot="sheet"]');
    if (!s) return;
    s.innerHTML = sheetHtml();
    s.querySelector('[data-act="confirm-yes"]')?.focus();
  }
  function answer(yes) {
    const c = confirmState;
    if (!c) return;
    confirmState = null;
    drawSheet();
    c.resolve(yes);
  }

  /* ---------- drawing ---------- */

  function draw() {
    if (!alive) return;
    const y = window.scrollY;
    let title = 'Mijn kamers';
    let back = '#/account';
    let body;
    if (!me()) {
      body = `<div class="panel" data-testid="myrooms-login">
        <h2>Log in om kamers klaar te zetten</h2>
        <p>Met een account zet je een kamer dagen van tevoren klaar, en open je hem op de dag zelf op elk toestel.</p>
        <div class="stack"><a class="btn btn-primary" href="#/account" data-testid="myrooms-to-login">Inloggen of account maken</a></div>
      </div>`;
    } else if (mode === 'list') body = listHtml();
    else if (mode === 'share') {
      title = 'Deel je kamer'; back = '#/account/kamers';
      const r = room(code);
      body = r?.exists ? shareHtml(r) : data ? `<div class="panel" data-testid="myrooms-notfound"><h2>Kamer niet gevonden</h2><p>${r ? 'Deze kamer is verlopen. Zet hem in Mijn kamers opnieuw klaar.' : `Kamer ${esc(code)} staat niet (meer) in je account.`}</p><div class="stack"><a class="btn btn-primary" href="#/account/kamers">Naar Mijn kamers</a></div></div>` : listHtml();
    } else {
      title = mode === 'edit' ? 'Kamer bewerken' : 'Kamer klaarzetten'; back = '#/account/kamers';
      if (mode === 'edit' && !room(code)) body = data ? `<div class="panel" data-testid="myrooms-notfound"><h2>Kamer niet gevonden</h2><p>Kamer ${esc(code)} staat niet (meer) in je account.</p><div class="stack"><a class="btn btn-primary" href="#/account/kamers">Naar Mijn kamers</a></div></div>` : listHtml();
      else {
        if (!form) form = defaultsFor(mode === 'edit' ? room(code) : null);
        if (mode === 'new' && data?.ok && data.rooms.length >= data.max && !busy) {
          body = `<p class="warn" data-testid="prep-limit">Je hebt al ${data.max} kamers klaarstaan, het maximum. Verwijder er eerst een in <a href="#/account/kamers">Mijn kamers</a>.</p>`;
        } else body = formHtml();
      }
    }
    root.innerHTML = `<section class="screen screen-myrooms" data-testid="screen-myrooms" data-mode="${mode}">
      <header class="topbar">
        <a class="icon-btn" href="${back}" aria-label="Terug" data-testid="myrooms-back">${icons.back}</a>
        <h1 class="topbar-title">${title}</h1>
        <span class="topbar-spacer"></span>
      </header>
      ${mode === 'list' && me() ? `<p class="lead small-lead myrooms-who">Ingelogd als <b>${esc(me().username)}</b>.</p>` : ''}
      ${body}
      <div data-slot="sheet">${sheetHtml()}</div>
    </section>`;
    window.scrollTo(0, y);
  }

  /** Redraw the form, keeping the focus on the control that changed. */
  function redrawForm(focusName, focusValue) {
    draw();
    if (!focusName) return;
    const sel = focusValue != null ? `[name="${focusName}"][value="${CSS.escape(String(focusValue))}"]` : `[name="${focusName}"]`;
    root.querySelector(sel)?.focus({ preventScroll: true });
  }

  async function load() {
    if (!me()) return;
    loading = true;
    if (!data) draw();
    const r = await account.myRooms();
    loading = false;
    if (!alive) return;
    if (r.ok || !data) data = { ...r, at: Date.now(), user: me()?.username };
    if (r.ok) cache = data;
    if (!me()) { draw(); return; } // the session ended on the server
    if (mode === 'edit' && !form && room(code)) form = defaultsFor(room(code));
    // the form is not redrawn under somebody's fingers once it is there
    if (mode !== 'list' && form && root.querySelector('[data-testid="prep-form"]')) return;
    draw();
  }

  /* ---------- actions ---------- */

  function setRoom(r) {
    if (!data?.ok) return;
    const i = data.rooms.findIndex((x) => x.code === r.code);
    if (i >= 0) data.rooms[i] = r; else data.rooms.push(r);
    cache = data;
  }

  async function openFlow(c) {
    const r = room(c);
    if (!r) return;
    cardErr = {};
    const host = storedServerHost();
    const lines = [];
    if (host && host.code !== c) lines.push(`<p>Dit toestel is nu spelleider van kamer <b>${esc(host.code)}</b>. Als je <b>${esc(r.name)}</b> opent, laat dit toestel die kamer los: daar kun je hier dan niet meer bij.</p>`);
    if (r.leaderOnline) lines.push('<p>Deze kamer is nu open op een ander toestel. Open je hem hier, dan neemt dit toestel de leiding over; op het andere toestel stopt het spelleiderscherm.</p>');
    if (lines.length && !(await ask({ title: `${r.name} hier openen?`, html: lines.join(''), confirm: 'Open hier', testid: 'myrooms-open-confirm' }))) return;
    busy = c;
    draw();
    const o = await account.openRoom(c);
    if (!alive) return;
    if (!o.ok) {
      busy = '';
      if (o.code === 'gone') {
        setRoom({ code: c, name: r.name, exists: false, createdAt: r.createdAt });
        draw();
        if (await ask({ title: 'Deze kamer is verlopen', html: `<p><b>${esc(r.name)}</b> is te lang niet gebruikt en bestaat niet meer op de server. Met <b>Opnieuw gebruiken</b> zet je hem weer klaar met dezelfde instellingen (en dezelfde code, als die nog vrij is).</p>`, confirm: 'Opnieuw gebruiken' })) resetFlow(c, { skipAsk: true });
        return;
      }
      cardErr[c] = { code: o.code, message: o.message };
      draw();
      return;
    }
    const notes = [];
    if (o.music.kind === 'playlist' && o.music.missing) {
      // the room's playlist is in the account but not on this device yet: fetch it first
      await syncNow();
      if (playlists.get(o.music.id)) playlists.setActive(o.music.id);
      else notes.push('De playlist van deze kamer staat niet (meer) in je account. Kies in de lobby andere muziek.');
    }
    if (o.play && spotify.getSettings().source !== o.play) spotify.setSettings({ source: o.play });
    if (o.play === 'spotify' && !spotify.isConnected()) notes.push('Deze kamer speelt via Spotify, maar dit toestel is niet met Spotify verbonden: tot dan klinken de fragmenten.');
    busy = '';
    toast([`${o.room.name} staat open op dit toestel.`, ...notes].join(' '), { kind: notes.length ? 'warn' : 'info', ms: notes.length ? 7000 : 2600 });
    navigate('#/spelleider');
  }

  async function resetFlow(c, { skipAsk = false } = {}) {
    const r = room(c);
    if (!r) return;
    cardErr = {};
    if (!skipAsk) {
      const html = r.exists
        ? `<p>Iedereen gaat eruit en het spel wordt gewist${r.phase !== 'lobby' && r.phase ? ' (er loopt nu een spel)' : ''}. De naam, de instellingen, de muziek en de code <b>${esc(r.code)}</b> blijven, dus gedeelde links en QR-codes blijven werken.</p>`
        : `<p>De kamer wordt opnieuw klaargezet met dezelfde naam en instellingen. De code <b>${esc(r.code)}</b> blijft als die nog vrij is; anders krijgt de kamer een nieuwe code.</p>`;
      if (!(await ask({ title: `${r.name} opnieuw gebruiken?`, html, confirm: 'Opnieuw gebruiken', testid: 'myrooms-reset-confirm' }))) return;
    }
    busy = c;
    draw();
    const o = await account.resetRoom(c);
    busy = '';
    if (!alive) return;
    if (!o.ok) { cardErr[c] = { code: o.code, message: o.message }; draw(); return; }
    if (o.room.code !== c && data?.ok) data.rooms = data.rooms.filter((x) => x.code !== c);
    setRoom({ ...o.room, exists: true });
    toast(o.recreated ? `${o.room.name} staat weer klaar${o.room.code !== c ? `, met de nieuwe code ${o.room.code}` : ''}.` : `${o.room.name} is leeggemaakt en staat klaar voor een nieuw potje.`, { ms: 3200 });
    draw();
    load();
  }

  async function deleteFlow(c) {
    const r = room(c);
    if (!r) return;
    cardErr = {};
    const html = `<p>De kamer verdwijnt uit Mijn kamers. De code <b>${esc(r.code)}</b>, de link en de QR-code werken daarna niet meer${r.exists && r.players ? `; de ${plural(r.players, 'speler', 'spelers')} die er nu in ${r.players === 1 ? 'zit' : 'zitten'}, krijgen te zien dat de kamer is opgeheven` : ''}.</p>`;
    if (!(await ask({ title: `${r.name} verwijderen?`, html, confirm: 'Verwijder de kamer', danger: true, testid: 'myrooms-delete-confirm' }))) return;
    busy = c;
    draw();
    const o = await account.deleteRoom(c);
    busy = '';
    if (!alive) return;
    if (!o.ok && o.code !== 'gone' && o.code !== 'notfound') { cardErr[c] = { code: o.code, message: o.message }; draw(); return; }
    if (data?.ok) { data.rooms = data.rooms.filter((x) => x.code !== c); cache = data; }
    toast(`${r.name} is verwijderd.`, { ms: 2400 });
    draw();
    root.querySelector('[data-testid="myrooms-new"]')?.focus();
  }

  async function saveForm() {
    const f = root.querySelector('[data-testid="prep-form"]');
    if (!f) return;
    form.name = f.elements.roomname.value;
    form.hostName = f.elements.hostname.value;
    formErr = null;
    if (!form.name.trim()) {
      formErr = { code: 'name', message: 'Geef de kamer een naam, bijvoorbeeld “Feest zaterdag”.' };
      draw();
      root.querySelector('[data-testid="prep-name"]')?.focus();
      return;
    }
    if (form.hostPlays && !form.hostName.trim()) {
      formErr = { code: 'hostname', message: 'Vul je naam in, of speel niet mee.' };
      draw();
      root.querySelector('[data-testid="prep-host-name"]')?.focus();
      return;
    }
    const full = { name: form.name.trim(), settings: { ...form.settings }, music: form.music, play: form.play, hostPlays: form.hostPlays, hostName: form.hostName.trim() };
    delete full.settings.music; // the server derives settings.music from `music`
    let o;
    busy = 'new';
    draw();
    if (mode === 'edit') {
      // only what changed: a running game refuses a settings change, not a new name
      const was = defaultsFor(room(code));
      const patch = {};
      if (full.name !== was.name) patch.name = full.name;
      const strip = (s) => { const x = { ...s }; delete x.music; return JSON.stringify(x); };
      if (strip(form.settings) !== strip(was.settings)) patch.settings = full.settings;
      if (full.music !== was.music) patch.music = full.music;
      if (full.play !== was.play) patch.play = full.play;
      if (full.hostPlays !== was.hostPlays) patch.hostPlays = full.hostPlays;
      if (full.hostName !== was.hostName) patch.hostName = full.hostName;
      o = Object.keys(patch).length ? await account.updateRoom(code, patch) : { ok: true, room: room(code) };
    } else {
      o = await account.prepareRoom(full);
    }
    busy = '';
    if (!alive) return;
    if (!o.ok) {
      formErr = { code: o.code, message: o.message || 'Dat lukte niet.' };
      draw();
      root.querySelector('[data-testid="prep-error"]')?.scrollIntoView({ block: 'center' });
      return;
    }
    if (full.hostName) store.set(HOST_NAME_KEY, full.hostName);
    setRoom({ ...o.room, exists: true });
    if (mode === 'edit') { toast('Kamer bewaard.', { ms: 2000 }); navigate('#/account/kamers'); return; }
    justMade = o.room.code;
    navigate(`#/account/kamers/${o.room.code}/deel`);
  }

  async function share(kind) {
    const r = room(code);
    if (!r) return;
    const join = roomLink(r.code);
    if (kind === 'native') {
      const text = `Doe mee met ${r.name} in TimeTunesr: kamer ${r.code}`;
      if (navigator.share) {
        try { await navigator.share({ title: r.name, text, url: join }); return; } catch (e) { if (e?.name === 'AbortError') return; }
      }
      const ok = await copyText(`${text}\n${join}`);
      toast(ok ? 'Uitnodiging gekopieerd. Plak hem in de groepsapp.' : 'Kopiëren lukte niet.', { kind: ok ? 'info' : 'warn' });
      return;
    }
    const value = kind === 'join' ? join : kind === 'code' ? r.code : screenLink(r.code);
    const ok = await copyText(value);
    const what = { join: 'Link', code: 'Kamercode', screen: 'Link van het grote scherm' }[kind];
    toast(ok ? `${what} gekopieerd.` : 'Kopiëren lukte niet.', { kind: ok ? 'info' : 'warn' });
  }

  function onClick(e) {
    const a = e.target.closest('[data-act]');
    if (!a || !root.contains(a)) return;
    switch (a.dataset.act) {
      case 'open': openFlow(a.dataset.code); break;
      case 'reset': resetFlow(a.dataset.code); break;
      case 'delete': deleteFlow(a.dataset.code); break;
      case 'reload': data = null; load(); break;
      case 'confirm-yes': answer(true); break;
      case 'confirm-no':
        if (a.classList.contains('sheet-backdrop') && e.target !== a) return;
        answer(false);
        break;
      case 'goal-minus':
      case 'goal-plus':
        form.settings = normalizeSettings({ ...form.settings, goal: form.settings.goal + (a.dataset.act === 'goal-plus' ? 1 : -1) });
        keepTyped();
        redrawForm();
        root.querySelector(`[data-testid="prep-${a.dataset.act}"]`)?.focus({ preventScroll: true });
        break;
      case 'copy-join': share('join'); break;
      case 'copy-code': share('code'); break;
      case 'copy-screen': share('screen'); break;
      case 'share-native': share('native'); break;
      case 'print': window.print(); break;
      default:
    }
  }

  /** The text fields keep what was typed when a radio button redraws the form. */
  function keepTyped() {
    const f = root.querySelector('[data-testid="prep-form"]');
    if (!f) return;
    form.name = f.elements.roomname.value;
    form.hostName = f.elements.hostname.value;
  }

  function onChange(e) {
    const t = e.target;
    if (!form || !t.closest('[data-testid="prep-form"]')) return;
    keepTyped();
    const num = ['size', 'questions', 'think'];
    if (t.name === 'game' || t.name === 'win' || t.name === 'qtype' || num.includes(t.name)) {
      form.settings = normalizeSettings({ ...form.settings, [t.name]: num.includes(t.name) ? Number(t.value) : t.value });
    } else if (t.name === 'music') form.music = t.value;
    else if (t.name === 'play') form.play = t.value === 'spotify' ? 'spotify' : 'preview';
    else if (t.name === 'plays') { form.hostPlays = t.checked; return; } else return;
    redrawForm(t.name, t.value);
  }

  function onSubmit(e) {
    if (!e.target.matches('[data-testid="prep-form"]')) return;
    e.preventDefault();
    if (!busy) saveForm();
  }

  function onKey(e) {
    if (e.key === 'Escape' && confirmState) answer(false);
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKey);
  const offPl = playlists.subscribe(() => { if (alive && mode === 'list') draw(); });

  draw();
  load();
  if (mode === 'new' || mode === 'edit') {
    loadBuiltinDeck().then((d) => {
      builtin = songCount(d.cards);
      if (!alive || !form || !root.querySelector('[data-testid="prep-form"]')) return;
      const focusEl = document.activeElement;
      if (focusEl?.matches?.('input[type="text"]')) {
        // somebody is typing: only the count changes, the form stays as it is
        const small = root.querySelector('[data-testid="prep-music-deck"] + .size-box small');
        if (small) small.textContent = `ingebouwd · ${plural(builtin, 'nummer', 'nummers')}`;
        return;
      }
      const fname = focusEl?.name;
      const fval = focusEl?.type === 'radio' ? focusEl.value : null;
      keepTyped();
      redrawForm(fname, fval);
    }).catch(() => {});
  }

  return () => {
    alive = false;
    offPl();
    if (confirmState) confirmState.resolve(false);
    if (mode === 'share') justMade = '';
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('keydown', onKey);
  };
}
