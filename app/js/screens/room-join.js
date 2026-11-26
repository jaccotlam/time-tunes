// "Samen spelen", the phone's way in (#/kamer, #/kamer/ABCD): the room code as four
// letter boxes, the idle disco ball on top, and the lobby's "Je doet mee!" with the other
// players popping in. Used by room-player.js; styles in css/join.css.
//
// The code boxes are one real <input> (data-testid "join-code") laid over four painted
// cells, so typing, pasting a code or a whole join link, backspace, autofill and screen
// readers all deal with a single ordinary text field.
import { CODE_LENGTH, CODE_ALPHABET } from '../multi/code.js';
import { CATEGORIES } from '../multi/disco.js';
import { createDiscoBall } from '../discoball.js';
import { esc, icons } from '../ui.js';
import { gameName, quizSettingsText } from './room-ui.js';
import { winText } from './room-disco.js';

/**
 * What is in the code field -> { value, bad, dropped }: upper case, letters only, at most
 * four; a pasted join link ".../#/kamer/ABCD" gives its code. `bad` = it holds a letter
 * that never occurs in a code (I, L, O); `dropped` = something that is not a letter was left out.
 */
export function cleanCodeTyping(raw) {
  const s = String(raw || '');
  const m = s.match(/#\/kamer\/([A-Za-z]{4})\b/);
  if (m) return { value: m[1].toUpperCase(), bad: false, dropped: false };
  const up = s.toUpperCase();
  const letters = up.replace(/[^A-Z]/g, '');
  const value = letters.slice(0, CODE_LENGTH);
  const dropped = /[^A-Z\s\-_.]/.test(up);
  return { value, bad: [...value].some((ch) => !CODE_ALPHABET.includes(ch)), dropped };
}

const cellsHtml = (value) => Array.from({ length: CODE_LENGTH }, (_, i) => {
  const ch = value[i] || '';
  return `<span class="code-cell${ch ? ' is-filled' : ''}${ch && !CODE_ALPHABET.includes(ch) ? ' is-bad' : ''}">${esc(ch)}</span>`;
}).join('');

function hintText({ bad, dropped }) {
  if (bad) return 'Een kamercode heeft geen I, L of O. Kijk nog eens op het scherm van de spelleider.';
  if (dropped) return 'Een kamercode bestaat alleen uit letters.';
  return '';
}

/** The code field: label, the four boxes over one input, a help line and a live hint. */
export function codeFieldHtml(value, { fromLink = false } = {}) {
  const c = cleanCodeTyping(value);
  return `<div class="join-field join-field-code">
    <label class="join-label" for="join-code">Kamercode</label>
    <div class="code-boxes${fromLink && c.value.length === CODE_LENGTH ? ' is-from-link' : ''}" data-len="${c.value.length}" data-testid="join-code-boxes">
      <input id="join-code" class="code-input" type="text" name="code" value="${esc(c.value)}" data-testid="join-code"
        autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="next"
        aria-describedby="join-code-help join-code-hint">
      <div class="code-cells" aria-hidden="true">${cellsHtml(c.value)}</div>
    </div>
    <p class="join-help" id="join-code-help">${fromLink && c.value.length === CODE_LENGTH ? `${icons.check}<span>Ingevuld via de QR-code of link.</span>` : '<span>Staat groot op het scherm van de spelleider.</span>'}</p>
    <p class="join-hint" id="join-code-hint" role="status" aria-live="polite">${esc(hintText(c))}</p>
  </div>`;
}

/**
 * After typing in the code input: clean it up and repaint the boxes in place (no redraw,
 * so the keyboard stays). Returns the clean value.
 */
export function onCodeInput(input) {
  const c = cleanCodeTyping(input.value);
  if (input.value !== c.value) input.value = c.value;
  caretToEnd(input);
  const boxes = input.closest('.code-boxes');
  if (boxes) {
    boxes.dataset.len = String(c.value.length);
    boxes.classList.remove('is-from-link', 'is-shake');
    const cells = boxes.querySelector('.code-cells');
    if (cells) cells.innerHTML = cellsHtml(c.value);
    const last = cells?.children[c.value.length - 1];
    if (last) last.classList.add('is-new');
  }
  const form = input.form;
  const hint = form?.querySelector('#join-code-hint');
  const text = hintText(c);
  if (hint && hint.textContent !== text) hint.textContent = text;
  return c;
}

/** The cells show the text as typed from the start: keep the (invisible) caret at the end. */
export function caretToEnd(input) {
  try { const n = input.value.length; input.setSelectionRange(n, n); } catch { /* ignore */ }
}

/** The idle disco ball over the join form and the lobby; one box that moves between views. */
export function createJoinHero() {
  const box = document.createElement('div');
  box.className = 'join-ball';
  box.dataset.testid = 'join-ball';
  const ball = createDiscoBall(box, { categories: CATEGORIES, size: 'auto' });
  ball.canvas.setAttribute('aria-hidden', 'true');
  ball.idle();
  return {
    box,
    place(slot) { if (slot && box.parentNode !== slot) slot.appendChild(box); },
    destroy() { ball.destroy(); box.remove(); },
  };
}

/** The chosen game and its settings, as in the lobby text ("Gekozen spel: Quiz (…)"). */
function gameOpts(s) {
  if (s.game === 'bingo') return [`${s.size}×${s.size}`];
  if (s.game === 'quiz') { const [n, t, ...kind] = quizSettingsText(s).split(', '); return [n, t, kind.join(', ')].filter(Boolean); }
  if (s.game === 'disco') return [`winnen met ${winText(s.win)}`];
  return [`doel ${s.goal} kaarten`];
}

/** The lobby on the phone: you are in, the game, and a hint that the host starts it. */
export function lobbyWaitHtml(v) {
  const s = v.settings;
  const opts = gameOpts(s);
  return `<div class="room-wait lobby-wait" data-testid="room-wait">
    <span class="room-check lobby-check" aria-hidden="true">${icons.check}</span>
    <h2 class="lobby-title">Je doet mee, <span class="lobby-name">${esc(v.you?.name || '')}</span>!</h2>
    <div class="lobby-game game-${esc(s.game)}">
      <span class="lobby-game-kicker">Gekozen spel</span>
      <b class="lobby-game-name">${esc(gameName(s.game))}</b>
      <span class="lobby-game-opts"><span class="sr-only">(</span>${opts.map((o, i) => `<span class="lobby-chip">${esc(o)}${i < opts.length - 1 ? '<span class="sr-only">,</span>' : ''}</span>`).join(' ')}<span class="sr-only">)</span></span>
    </div>
    ${s.music === 'mix' ? '<p class="muted lobby-mix" data-testid="room-music-is-mix">Muziek: <b>Mix van de groep</b>, de favorieten van de spelers.</p>' : ''}
    <p class="lobby-hint" data-testid="lobby-hint"><span class="lobby-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>De spelleider start zo het spel.</span></p>
    <p class="muted small lobby-awake">Je scherm blijft aan zolang je in de kamer bent (als je telefoon dat toestaat). Valt hij toch op slot, dan kom je vanzelf terug in het spel.</p>
  </div>`;
}

const AVATAR_COLORS = ['#ff5d73', '#ffc649', '#2ed3c0', '#4fb3ff', '#ff5fa8', '#b98cff', '#ff8a5c', '#3ddc8f'];
const avatarColor = (i) => AVATAR_COLORS[i % AVATAR_COLORS.length]; // join order: neighbours differ
const initial = (name) => esc(([...String(name || '?').trim()][0] || '?').toUpperCase());

/**
 * The players in the lobby as tiles (same testids and data as playersHtml). Tiles of players
 * not in `seen` yet pop in; `seen` (a Set of ids) is updated.
 */
export function lobbyPlayersHtml(view, seen) {
  const first = seen.size === 0;
  let k = 0;
  const tiles = view.players.map((p, i) => {
    const you = view.you && p.id === view.you.id;
    const fresh = !seen.has(p.id);
    seen.add(p.id);
    const delay = fresh && first ? ` style="--delay:${Math.min(k++, 8) * 70}ms"` : '';
    return `<li class="lp${p.online ? '' : ' is-offline'}${you ? ' is-you' : ''}${fresh ? ' is-new' : ''}"${delay} data-testid="room-player-${i}" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-online="${p.online}" data-answered="${p.answered}">
      <span class="lp-avatar" style="--av:${avatarColor(i)}" aria-hidden="true">${initial(p.name)}</span>
      <span class="lp-name">${esc(p.name)}${p.host ? ' <small>(spelleider)</small>' : ''}${you ? ' <small>(jij)</small>' : ''}${p.online ? '' : ' <small class="lp-off">offline</small>'}</span>
    </li>`;
  }).join('');
  const n = view.players.length;
  return `<h2 class="room-h lobby-players-h">Spelers <span class="lobby-count" data-testid="lobby-count">${n}</span></h2>
    <ul class="lobby-players" data-testid="room-players" aria-label="Spelers">${tiles}
      <li class="lp lp-next" aria-hidden="true"><span class="lp-avatar">${icons.plus}</span><span class="lp-name">Wie volgt?</span></li>
    </ul>`;
}
