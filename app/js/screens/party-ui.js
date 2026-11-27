// "Samen spelen", the party extras as people see them: avatars, streak / joker / snelste marks,
// the reaction bar on the phones, reactions floating over the big screen (and, small, over the
// spelleider's tab), the avatar picker and the awards ("Prijsuitreiking"). Used by
// room-join.js, room-player.js, disco-phone.js, room-screen.js, room-host.js, room-ui.js and
// room-disco.js. Everything here renders only what a view already holds, so nothing of a
// running round can show before the reveal. Styles: css/party.css.
import { AVATARS, REACTIONS, REACT_GAP_MS, STREAK_SHOWN, avatarOf } from '../multi/party.js';
import { esc, vibrate } from '../ui.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- avatar ---------- */

/** The avatar of a player (anything with id / avatar): a round emoji badge. */
export function avatarHtml(p, { cls = '', testid = 'player-avatar' } = {}) {
  const a = avatarOf(p);
  return `<span class="av${cls ? ` ${cls}` : ''}" data-testid="${testid}" data-avatar="${esc(a)}" aria-hidden="true">${esc(a)}</span>`;
}

/** A random avatar for a phone that never picked one. */
export const randomAvatar = () => AVATARS[Math.floor(Math.random() * AVATARS.length)];

/** The picker: a bottom sheet with the 30 avatars; `current` is pressed. */
export function avatarSheetHtml(current, { title = 'Kies je avatar', sub = 'Zo zien de anderen je op hun telefoon en op het grote scherm.' } = {}) {
  return `<div class="av-sheet-wrap" data-testid="avatar-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="av-scrim" data-action="avatar-close"></div>
    <section class="av-sheet">
      <div class="av-sheet-head"><h2 class="av-sheet-title">${esc(title)}</h2>
        <button type="button" class="av-sheet-x" data-action="avatar-close" data-testid="avatar-sheet-close" aria-label="Sluiten">×</button></div>
      <p class="av-sheet-sub">${esc(sub)}</p>
      <div class="av-grid" data-testid="avatar-options" role="group" aria-label="Avatars">
        ${AVATARS.map((a) => `<button type="button" class="av-opt${a === current ? ' is-on' : ''}" data-action="avatar-pick" data-avatar="${esc(a)}" data-testid="avatar-option" aria-pressed="${a === current}" aria-label="Avatar ${esc(a)}">${esc(a)}</button>`).join('')}
      </div>
    </section>
  </div>`;
}

/* ---------- marks: streak, jokers, snelste ---------- */

/** 🔥3 from STREAK_SHOWN on ('' below). */
export function streakMark(n, { cls = '' } = {}) {
  if (!Number.isInteger(n) || n < STREAK_SHOWN) return '';
  return `<span class="pm pm-streak${cls ? ` ${cls}` : ''}" data-testid="streak-mark" data-streak="${n}" title="${n} op rij goed"><i aria-hidden="true">🔥</i>${n}</span>`;
}

/** Jokers in hand: 🃏 or 🃏×2 ('' without). */
export function jokerMark(n, { cls = '' } = {}) {
  if (!Number.isInteger(n) || n < 1) return '';
  return `<span class="pm pm-joker${cls ? ` ${cls}` : ''}" data-testid="joker-mark" data-jokers="${n}" title="${n === 1 ? '1 joker' : `${n} jokers`}"><i aria-hidden="true">🃏</i>${n > 1 ? `×${n}` : ''}<span class="sr-only">${n === 1 ? '1 joker' : `${n} jokers`}</span></span>`;
}

/** A joker earned or used in this round (from a reveal.results entry). */
export function jokerEventMark(r) {
  if (r?.jokerSpent) return '<span class="pm pm-joker is-spent" data-testid="joker-event" data-joker="spent" title="Joker ingezet"><i aria-hidden="true">🃏</i>ingezet</span>';
  if (r?.jokerEarned) return '<span class="pm pm-joker is-earned" data-testid="joker-event" data-joker="earned" title="Joker verdiend">+<i aria-hidden="true">🃏</i></span>';
  return '';
}

/** ⚡ Snelste of the round. */
export const fastMark = ({ short = false } = {}) => `<span class="pm pm-fast" data-testid="fastest-mark" title="Als eerste goed"><i aria-hidden="true">⚡</i>${short ? '' : 'Snelste'}</span>`;

/** Everything one reveal.results entry earned this round (Discobingo; '' for the other games). */
export function resultMarks(r) {
  return `${r?.fastest ? fastMark() : ''}${streakMark(r?.streak)}${jokerEventMark(r)}`;
}

/* ---------- reactions: the bar on a phone ---------- */

/**
 * The reaction bar: six emoji, a tiny local echo on a tap, then a cool-down (the server's
 * REACT_GAP_MS) so a tap always gets an answer. `send(emoji)` -> true when sent. The bar may be
 * re-rendered at any time: html() draws the cool-down that is still running.
 */
export function createReactBar({ send, root = () => document }) {
  let until = 0;
  let timer = 0;
  const bars = () => [...(root()?.querySelectorAll?.('[data-testid="react-bar"]') || [])];
  function paint() {
    const cool = Date.now() < until;
    for (const b of bars()) {
      if (b.dataset.cooldown !== String(cool)) b.dataset.cooldown = String(cool);
      b.classList.toggle('is-cool', cool);
      if (cool) b.style.setProperty('--cool', `${Math.max(0, until - Date.now())}ms`);
    }
  }
  function echo(btn, emoji) {
    const bar = btn.closest('[data-testid="react-bar"]');
    if (!bar) return;
    const e = document.createElement('span');
    e.className = 'rxbar-echo';
    e.textContent = emoji;
    e.setAttribute('aria-hidden', 'true');
    const br = bar.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    e.style.left = `${r.left - br.left + r.width / 2}px`;
    bar.appendChild(e);
    const done = () => e.remove();
    e.addEventListener('animationend', done);
    setTimeout(done, 1400);
  }
  function nudge(bar) {
    if (!bar) return;
    bar.classList.remove('is-nudge');
    void bar.offsetWidth;
    bar.classList.add('is-nudge');
  }
  return {
    html({ cls = '', label = 'Reageer' } = {}) {
      const cool = Date.now() < until;
      return `<div class="rxbar${cls ? ` ${cls}` : ''}${cool ? ' is-cool' : ''}" data-testid="react-bar" data-cooldown="${cool}" role="group" aria-label="${esc(label)}"${cool ? ` style="--cool:${until - Date.now()}ms"` : ''}>
        ${REACTIONS.map((e) => `<button type="button" class="rxbar-btn" data-action="react" data-emoji="${esc(e)}" data-testid="react-btn" aria-label="Stuur ${esc(e)}">${esc(e)}</button>`).join('')}
      </div>`;
    },
    /** A tap on the page: true when it was a reaction button. */
    onClick(ev) {
      const b = ev.target.closest?.('[data-action="react"]');
      if (!b) return false;
      const bar = b.closest('[data-testid="react-bar"]');
      if (Date.now() < until) { nudge(bar); return true; }
      if (!send(b.dataset.emoji)) { nudge(bar); return true; }
      until = Date.now() + REACT_GAP_MS;
      vibrate(10);
      echo(b, b.dataset.emoji);
      paint();
      clearTimeout(timer);
      timer = setTimeout(paint, REACT_GAP_MS + 20);
      return true;
    },
    destroy() { clearTimeout(timer); },
  };
}

/* ---------- reactions: floating up over a screen ---------- */

/**
 * A layer in `host` where reactions float up from the bottom, each with the sender's avatar.
 * At most `max` at once (the oldest goes); lanes are picked at random among those that do not
 * cross anything `avoid()` returns (DOMRects: the song, the QR code). `small`: the spelleider's
 * tab (a corner, small and short). Reduced motion: a quiet fade in place. Only transform and
 * opacity are animated.
 */
/** About the height of one float (emoji + avatar + name) at 1080 px: its top rises this far above its path's end. */
const FLOAT_H = 130;

export function createFloatLayer(host, { max = 8, small = false, avoid = () => [], testid = 'screen-reaction', rise = 0.55 } = {}) {
  const layer = document.createElement('div');
  layer.className = `rx-layer${small ? ' is-small' : ''}`;
  layer.setAttribute('aria-hidden', 'true');
  layer.dataset.testid = small ? 'host-reactions' : 'screen-reactions';
  host.appendChild(layer);
  const live = [];
  let lastLanes = [];
  function lane() {
    const W = layer.clientWidth || innerWidth;
    const H = layer.clientHeight || innerHeight;
    if (small) return 0.15 + Math.random() * 0.7;
    const top = H * (1 - rise) - FLOAT_H; // the top of a float goes its own height above the end of its path
    const lr = layer.getBoundingClientRect();
    const blocks = (avoid() || []).filter(Boolean).map((r) => ({ l: r.left - lr.left, r: r.right - lr.left, t: r.top - lr.top, b: r.bottom - lr.top }))
      .filter((r) => r.b > top && r.t < H && r.r > r.l);
    const n = 14;
    const w = Math.min(W / n, 120);
    const ok = [];
    for (let i = 0; i < n; i++) {
      const x = (0.04 + (0.92 * (i + 0.5)) / n) * W;
      if (blocks.some((r) => x + w * 0.8 > r.l && x - w * 0.8 < r.r)) continue;
      ok.push(i);
    }
    const fresh = ok.filter((i) => !lastLanes.includes(i));
    const pool = fresh.length ? fresh : ok;
    if (!pool.length) return Math.random() < 0.5 ? 0.03 : 0.97; // everything blocked: the very edge
    const i = pool[Math.floor(Math.random() * pool.length)];
    lastLanes = [...lastLanes.slice(-4), i];
    return 0.04 + (0.92 * (i + 0.5)) / n;
  }
  return {
    el: layer,
    push(r) {
      if (!r || !layer.isConnected) return;
      while (live.length >= max) live.shift()?.remove();
      const f = document.createElement('div');
      f.className = `rx${reducedMotion() ? ' is-calm' : ''}`;
      f.dataset.testid = testid;
      f.dataset.emoji = r.emoji;
      f.dataset.from = r.name || '';
      f.dataset.id = r.id || '';
      f.style.left = `${(lane() * 100).toFixed(2)}%`;
      f.style.setProperty('--sway', `${(Math.random() * 2 - 1).toFixed(2)}`);
      f.style.setProperty('--dur', `${(small ? 2.2 : 3.4) + Math.random() * 0.8}s`);
      const av = avatarOf(r);
      f.innerHTML = `<span class="rx-in"><span class="rx-e">${esc(r.emoji)}</span><span class="rx-av">${esc(av)}</span>${small ? '' : `<span class="rx-name">${esc(r.name || '')}</span>`}</span>`;
      layer.appendChild(f);
      live.push(f);
      const done = () => { f.remove(); const k = live.indexOf(f); if (k >= 0) live.splice(k, 1); };
      f.addEventListener('animationend', (e) => { if (e.target === f) done(); });
      setTimeout(done, 6000);
    },
    /**
     * The things to avoid changed (a song card, an answer, the winner appeared): a float whose
     * remaining path now crosses one stops where it is and fades out quickly, while it is still
     * clear of it. Called by the screen after every redraw; cheap (at most `max` floats).
     */
    recheck() {
      if (!live.length || small) return;
      const blocks = (avoid() || []).filter((r) => r && r.width > 0 && r.height > 0);
      if (!blocks.length) return;
      const H = layer.clientHeight || innerHeight;
      const lr = layer.getBoundingClientRect();
      for (const f of live) {
        if (f.dataset.dodge) continue;
        const b = (f.firstElementChild || f).getBoundingClientRect();
        const pathTop = Math.min(b.top, lr.top + H * (1 - rise) - FLOAT_H);
        if (!blocks.some((r) => r.left < b.right && r.right > b.left && r.bottom > pathTop && r.top < b.bottom)) continue;
        f.dataset.dodge = '1';
        f.classList.add('is-dodge');
        setTimeout(() => { f.remove(); const k = live.indexOf(f); if (k >= 0) live.splice(k, 1); }, 320);
      }
    },
    clear() { for (const f of live.splice(0)) f.remove(); },
    destroy() { this.clear(); layer.remove(); },
  };
}

/* ---------- awards ("Prijsuitreiking") ---------- */

/** The holders of an award: avatars and names. */
export function holdersHtml(holders, { you = null, big = false } = {}) {
  return `<span class="aw-holders${big ? ' is-big' : ''}">${holders.map((h) => `<span class="aw-holder${h.id === you ? ' is-you' : ''}" data-id="${esc(h.id)}">${avatarHtml(h, { cls: 'aw-av' })}<b>${esc(h.name)}</b>${h.id === you ? ' <small>(jij)</small>' : ''}</span>`).join('')}</span>`;
}

/** The awards as a compact list (phone winner moment, the spelleider's tab, the tv overview). */
export function awardsListHtml(awards, { you = null, testid = 'awards', itemTestid = 'award', cls = '' } = {}) {
  if (!awards?.length) return '';
  return `<ul class="aw-list${cls ? ` ${cls}` : ''}" data-testid="${testid}" data-n="${awards.length}">
    ${awards.map((a, i) => {
    const mine = !!you && a.holders.some((h) => h.id === you);
    return `<li class="aw-item${mine ? ' is-mine' : ''}" style="--i:${i}" data-testid="${itemTestid}" data-kind="${esc(a.kind)}" data-mine="${mine}" data-holders="${esc(a.holders.map((h) => h.name).join('|'))}">
      <span class="aw-emoji" aria-hidden="true">${esc(a.emoji)}</span>
      <span class="aw-body"><b class="aw-title">${esc(a.title)}</b>${holdersHtml(a.holders, { you })}<small class="aw-text">${esc(a.text)}</small></span>
    </li>`;
  }).join('')}
  </ul>`;
}

/** "Jij: Snelste vingers ⚡ en Langste reeks 🔥" ('' when the player won nothing). */
export function myAwardsLine(awards, you) {
  const mine = (awards || []).filter((a) => a.holders.some((h) => h.id === you));
  if (!mine.length) return '';
  const parts = mine.map((a) => `<b>${esc(a.title)}</b> ${esc(a.emoji)}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} en ${parts[parts.length - 1]}`;
  return `<p class="aw-mine" data-testid="my-awards" data-n="${mine.length}">Jij: ${list}</p>`;
}

/** One award on the big screen, in the spotlight (the ceremony shows them one at a time). */
export function awardSpotHtml(a, i, n) {
  return `<div class="aw-spot" data-testid="screen-award" data-kind="${esc(a.kind)}" data-index="${i}" data-holders="${esc(a.holders.map((h) => h.name).join('|'))}">
    <p class="aw-spot-kick">Prijsuitreiking <span>${i + 1} van ${n}</span></p>
    <span class="aw-spot-emoji" aria-hidden="true">${esc(a.emoji)}</span>
    <h2 class="aw-spot-title">${esc(a.title)}</h2>
    ${holdersHtml(a.holders, { big: true })}
    <p class="aw-spot-text">${esc(a.text)}</p>
    <span class="aw-spot-dots" aria-hidden="true">${Array.from({ length: n }, (_, k) => `<i class="${k === i ? 'on' : k < i ? 'was' : ''}"></i>`).join('')}</span>
  </div>`;
}
