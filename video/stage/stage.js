// Decor van de uitlegvideo: alles in beeld behalve het telefoonscherm zelf.
// Geen CSS-animaties: elke stand is een pure functie van de tijd t (seconden), zodat
// 3-render.mjs frame voor frame een scherpe, schokvrije video kan maken.
//
// Invoer: ../__tmp/events.json (geschreven door 2-record.mjs) met de starttijden van de
// scènes, de tikken op het scherm en de lijst opgenomen telefoonframes.
import { loadDeck, faces } from './cards.js';
import { SCENES } from './scenes.js';
import { icons, logoSvg, wordmark } from '../js/ui.js';
import { sheetsHtml } from '../js/screens/print.js';

const E = await (await fetch('../__tmp/events.json', { cache: 'no-store' })).json();
const deck = await loadDeck();
const { TABLE, DIGITAL, PUBLIC_URL, PHONE } = E.config;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html = '') => { const n = document.createElement(tag); if (cls) n.className = cls; n.innerHTML = html; return n; };

// ---------- tijd-hulpjes ----------
const order = E.scenes.map((s) => s.id);
const startOf = Object.fromEntries(E.scenes.map((s) => [s.id, s.t]));
const S = (id) => startOf[id] ?? Infinity; // start van een scène
const END = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : (E.scenes[i + 1]?.t ?? E.duration); };
const M = (name) => E.marks[name] ?? Infinity; // los tijdstip uit de opname
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = {
  lin: (p) => p,
  out: (p) => 1 - (1 - p) ** 3,
  in: (p) => p ** 3,
  io: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - ((-2 * p + 2) ** 3) / 2),
  back: (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2,
};
const ramp = (t, a, b, e = ease.io) => (b <= a ? (t >= b ? 1 : 0) : e(clamp01((t - a) / (b - a))));
const pulse = (t, a, b, fadeIn = 0.25, fadeOut = 0.25) => ramp(t, a, a + fadeIn) * (1 - ramp(t, b - fadeOut, b));
/** Keyframes [[tijd, waarde, ease?], ...] -> functie van t. Onbekende tijdstippen (Infinity) vallen weg. */
function track(keys) {
  const k = keys.filter((x) => Number.isFinite(x[0]) || x[0] === -Infinity).sort((a, b) => a[0] - b[0]);
  return (t) => {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (t <= k[i][0]) return lerp(k[i - 1][1], k[i][1], (ease[k[i][2]] || ease.io)(clamp01((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]))));
    }
    return k[k.length - 1][1];
  };
}
const px = (v) => `${v.toFixed(2)}px`;

// ---------- titel- en slotkaart ----------
for (const id of ['title', 'end']) {
  $(`${id}-logo`).innerHTML = logoSvg('logo');
  $(`${id}-word`).innerHTML = wordmark();
}
const titleParts = [...$('titlecard').children];
const endParts = [...$('endcard').children];

// ---------- telefoon ----------
document.querySelector('.v-status-icons').innerHTML = `
  <svg width="18" height="14" viewBox="0 0 18 14"><g fill="#fff4e6"><rect x="0" y="9" width="3" height="5" rx="1"/><rect x="5" y="6" width="3" height="8" rx="1"/><rect x="10" y="3" width="3" height="11" rx="1"/><rect x="15" y="0" width="3" height="14" rx="1"/></g></svg>
  <svg width="26" height="14" viewBox="0 0 26 14"><rect x="1" y="1" width="21" height="12" rx="3.5" fill="none" stroke="#fff4e6" stroke-width="1.6"/><rect x="3.4" y="3.4" width="14" height="7.2" rx="1.8" fill="#fff4e6"/><rect x="23.4" y="4.6" width="2" height="4.8" rx="1" fill="#fff4e6"/></svg>`;
const screenImg = $('screen');
let currentFrame = '';
function frameAt(t) {
  const f = E.frames;
  let lo = 0; let hi = f.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f[mid][0] <= t + 0.004) lo = mid; else hi = mid - 1; }
  return f[lo][1];
}

// ---------- tekst rechts ----------
const copy = $('copy');
const badgeHtml = (b) => (b === 'print' ? icons.print : b === 'check' ? icons.check : b);
const heads = []; // { el, t0, t1 }
const caps = []; //  { el, t0, t1, first }
{
  let run = null;
  for (const sc of SCENES) {
    if (!sc.title || !(sc.id in startOf)) { run = null; continue; }
    const key = `${sc.kicker}|${sc.badge}|${sc.title}`;
    const first = !run || run.key !== key;
    if (first) {
      const node = el('div', 'v-head', `<p class="v-kicker">${sc.kicker}</p><div class="v-headrow"><span class="v-badge ${/^\d$/.test(sc.badge) ? '' : 'is-teal'}">${badgeHtml(sc.badge)}</span><h1 class="v-title">${sc.title}</h1></div>`);
      copy.append(node);
      run = { key, el: node, t0: S(sc.id), t1: END(sc.id) };
      heads.push(run);
    } else run.t1 = END(sc.id);
    if (sc.caption) {
      const node = el('div', 'v-cap', `<p>${sc.caption}</p>${sc.chips ? `<div class="v-chips">${sc.chips.map((c) => `<span class="v-chip">${c}</span>`).join('')}</div>` : ''}`);
      copy.append(node);
      caps.push({ el: node, t0: S(sc.id), t1: END(sc.id), first });
    }
  }
}

// ---------- tafel ----------
const CARD = 62 * 96 / 25.4; // kaart op ware printgrootte in px (62 mm)
const SZ = 170; const GAP = 14; const CX = 700; const CY = 300;
const sc0 = SZ / CARD;
const tlx = (n, i) => CX + (i - (n - 1) / 2) * (SZ + GAP);
const WSZ = 104; const WGAP = 10;
const wsc = WSZ / CARD;
const wx = (i) => 585 + (i - 4.5) * (WSZ + WGAP);
const PILE = { x: 112, y: CY };
const HAND = { x: 22, y: 118, s: 0.8, r: -7 }; // kaart in de hand, voor de camera van de telefoon
const HOVER_Y = CY - 112;
const BIG = 1.45; // schaal van een kaart terwijl hij wordt omgedraaid (goed leesbaar)

function makeCard(id, parent) {
  const f = faces(deck.get(id), PUBLIC_URL);
  const node = el('div', 'v-card', `<div class="v-flip"><div class="v-face v-front">${f.front}</div><div class="v-face v-back">${f.back}</div></div>`);
  parent.append(node);
  return { id, node, flipEl: node.firstChild, faces: [...node.querySelectorAll('.v-face')] };
}
function place(c, { x, y, s = sc0, r = 0, flip = 0, lift = 0, op = 1, z = 10 }) {
  c.node.style.transform = `translate(${px(x)}, ${px(y)}) rotate(${r.toFixed(3)}deg) scale(${s.toFixed(4)})`;
  c.node.style.opacity = op.toFixed(3);
  c.node.style.zIndex = String(Math.round(z));
  c.node.style.visibility = op <= 0.001 || s <= 0.001 ? 'hidden' : 'visible';
  c.flipEl.style.transform = `rotateY(${flip.toFixed(2)}deg)`;
  const shadow = `0 ${px((3 + lift * 20) / s)} ${px((7 + lift * 34) / s)} rgba(0, 0, 0, ${(0.4 + lift * 0.12).toFixed(2)})`;
  for (const f of c.faces) f.style.boxShadow = shadow;
}

const pileEl = $('pile');
for (let i = 3; i >= 1; i--) {
  const b = el('div', 'v-blank');
  b.style.transform = `translate(${PILE.x + i * 3}px, ${PILE.y + i * 4}px) scale(${sc0})`;
  pileEl.append(b);
}
const pileTop = makeCard('106', pileEl); // blijft op de stapel liggen
place(pileTop, { x: PILE.x, y: PILE.y });

const cardsEl = $('cards');
const [idA, idB, idC] = TABLE.timeline;
const G = TABLE.good; const B = TABLE.bad;
const cards = Object.fromEntries([idA, idB, idC, B, G].map((id) => [id, makeCard(id, cardsEl)]));
const winOrder = [...TABLE.winner].sort((a, b) => deck.get(a).year - deck.get(b).year);
const winNew = TABLE.winner.filter((id) => ![idA, idB, idC, G].includes(id));
for (const id of winNew) cards[id] = makeCard(id, cardsEl);

// Tijdstippen van het verhaal op tafel.
const t2 = S('s2'); const t3 = S('s3'); const t4 = S('s4'); const t5 = S('s5'); const t5g = S('s5good');
const tb1 = S('s5next'); const tapB = M('scanTapB'); const dB = M('detectB'); const tb2 = S('s5bad'); const t6 = S('s6');
const gUp = t2 + 0.7; const gHand = t2 + 2.3; //   goede kaart: van de stapel naar de hand (voor de camera)
const bUp = tapB - 0.4; const bHand = tapB + 0.8; // foute kaart idem
const tOpen4 = t4 + 3.9; //  tijdlijn schuift open voor de goede kaart
const tOpen5 = dB + 1.9; //  ... en voor de foute kaart
const tClose = tb2 + 2.7; // foute kaart is weg: tijdlijn sluit weer
const tWin = t6 + 0.4; //    tijdlijn groeit naar tien kaarten
const POP0 = t6 + 1.0; const POP_STEP = 0.3;
const tAll = POP0 + (winNew.length - 1) * POP_STEP + 0.35;

// Plek van een kaart die al in de tijdlijn ligt, per fase.
const phases = [
  { t: -Infinity, d: 0.5, pos: (id) => ({ x: tlx(3, [idA, idB, idC].indexOf(id)), s: sc0 }) },
  { t: tOpen4, d: 0.5, pos: (id) => ({ x: tlx(4, [idA, G, idB, idC].indexOf(id)), s: sc0 }) },
  { t: tOpen5, d: 0.5, pos: (id) => ({ x: tlx(5, [idA, G, idB, idC, B].indexOf(id)), s: sc0 }) },
  { t: tClose, d: 0.5, pos: (id) => ({ x: tlx(4, [idA, G, idB, idC].indexOf(id)), s: sc0 }) },
  { t: tWin, d: 0.7, pos: (id) => ({ x: wx(winOrder.indexOf(id)), s: wsc }) },
].filter((p) => p.t === -Infinity || Number.isFinite(p.t));
function slot(id, t) {
  let cur = phases[0].pos(id);
  for (let i = 1; i < phases.length; i++) {
    const p = ramp(t, phases[i].t, phases[i].t + phases[i].d);
    if (p <= 0) break;
    const next = phases[i].pos(id);
    cur = { x: lerp(cur.x, next.x, p), s: lerp(cur.s, next.s, p) };
  }
  return cur;
}
const gap3 = (g) => tlx(3, g) - (SZ + GAP) / 2;
const endGap4 = tlx(4, 3) + (SZ + GAP) / 2;

// De goede kaart: stapel -> hand (scannen, luisteren) -> zoeken -> in de tijdlijn -> omdraaien.
const g = {
  x: track([[gUp, PILE.x], [gHand, HAND.x], [t4 + 0.5, HAND.x], [t4 + 1.5, gap3(3)], [t4 + 2.0, gap3(3)], [t4 + 2.6, gap3(2)], [t4 + 3.0, gap3(2)], [t4 + 3.6, gap3(1)], [t4 + 4.0, gap3(1)], [t4 + 4.6, tlx(4, 1)]]),
  y: track([[gUp, PILE.y], [gHand, HAND.y], [t4 + 0.5, HAND.y], [t4 + 1.5, HOVER_Y], [t4 + 4.0, HOVER_Y], [t4 + 4.6, CY, 'in'], [t5 + 0.3, CY], [t5 + 0.7, CY - 8], [t5g + 0.3, CY - 8], [t5g + 0.75, CY]]),
  s: track([[gUp, sc0], [gHand, HAND.s], [t4 + 4.0, HAND.s], [t4 + 4.6, sc0], [t5 + 0.3, sc0], [t5 + 0.7, BIG], [t5g + 0.3, BIG], [t5g + 0.75, sc0]]),
  r: track([[gUp, 0], [gHand, HAND.r], [t4 + 0.5, HAND.r], [t4 + 1.5, -3], [t4 + 4.0, -3], [t4 + 4.6, 0]]),
  lift: track([[gUp, 0], [gUp + 0.5, 1], [t4 + 4.0, 1], [t4 + 4.6, 0], [t5 + 0.3, 0], [t5 + 0.7, 1], [t5g + 0.3, 1], [t5g + 0.75, 0]]),
  flip: track([[t5 + 0.7, 0], [t5 + 1.5, 180]]),
};
// De foute kaart: zelfde route, maar achteraan gelegd; na het omdraaien uit het spel.
const bx0 = endGap4;
const b = {
  x: track([[bUp, PILE.x], [bHand, HAND.x], [dB + 0.9, HAND.x], [dB + 1.7, bx0], [tb2 + 0.25, bx0], [tb2 + 0.6, bx0 - 112], [tb2 + 2.5, bx0 - 112], [tb2 + 3.1, bx0 + 110, 'in']]),
  y: track([[bUp, PILE.y], [bHand, HAND.y], [dB + 0.9, HAND.y], [dB + 1.7, HOVER_Y], [dB + 2.0, HOVER_Y], [dB + 2.5, CY, 'in'], [tb2 + 0.25, CY], [tb2 + 0.6, CY - 8], [tb2 + 2.5, CY - 8], [tb2 + 3.1, CY + 250, 'in']]),
  s: track([[bUp, sc0], [bHand, HAND.s], [dB + 2.0, HAND.s], [dB + 2.5, sc0], [tb2 + 0.25, sc0], [tb2 + 0.6, BIG], [tb2 + 2.5, BIG], [tb2 + 3.1, sc0]]),
  r: track([[bUp, 0], [bHand, HAND.r], [dB + 0.9, HAND.r], [dB + 1.7, 3], [dB + 2.0, 3], [dB + 2.5, 0], [tb2 + 2.5, 0], [tb2 + 3.1, 26, 'in']]),
  lift: track([[bUp, 0], [bUp + 0.5, 1], [dB + 2.0, 1], [dB + 2.5, 0], [tb2 + 0.25, 0], [tb2 + 0.6, 1]]),
  flip: track([[tb2 + 0.6, 0], [tb2 + 1.3, 180]]),
  op: track([[tb2 + 2.6, 1], [tb2 + 3.1, 0]]),
};

const handEl = $('hand');
const brackets = el('div', 'v-brackets', '<i></i><i></i><i></i><i></i><b></b>');
handEl.append(brackets);
const markGood = el('div', 'v-mark is-good', icons.check);
const markBad = el('div', 'v-mark is-bad', icons.cross);
const ringGood = el('div', 'v-ring');
cardsEl.append(ringGood, markGood, markBad);
const caret = $('caret');
const counter = $('counter');
const confettiEl = $('confetti');
// vaste (herhaalbare) confetti
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const confetti = Array.from({ length: 54 }, (_, i) => {
  const n = el('i');
  n.style.background = ['var(--mustard)', 'var(--coral)', 'var(--teal)'][i % 3];
  confettiEl.append(n);
  return { n, x: 60 + rnd() * 1050, dx: (rnd() - 0.5) * 160, delay: rnd() * 0.9, dur: 1.5 + rnd() * 0.9, rot: 300 + rnd() * 700, h: 440 + rnd() * 120 };
});

function drawTable(t) {
  const table = $('table');
  const vis = ramp(t, S('intro') + 0.9, S('intro') + 1.5) * (1 - ramp(t, S('d1') - 0.4, S('d1') - 0.05));
  table.style.opacity = vis.toFixed(3);
  table.style.transform = `translateY(${px((1 - ramp(t, S('intro') + 0.9, S('intro') + 1.5, ease.out)) * 40)})`;
  handEl.style.opacity = vis.toFixed(3);
  if (vis <= 0) return;

  // stapel
  const pileOp = 1 - ramp(t, t6 + 0.15, t6 + 0.55);
  pileEl.style.opacity = pileOp.toFixed(3);
  $('pile-label').style.opacity = pileOp.toFixed(3);
  const wide = ramp(t, tWin, tWin + 0.7); // de tijdlijn krijgt de hele tafel
  $('axis').style.left = px(lerp(250, 30, wide));
  $('axis').style.width = px(lerp(890, 1110, wide));

  // kaarten die al open in de tijdlijn liggen
  for (const id of [idA, idB, idC]) {
    const p = slot(id, t);
    place(cards[id], { x: p.x, y: CY, s: p.s, flip: 180, z: 10 });
  }

  // goede kaart
  {
    const inHand = t > gHand && t < t4 + 0.5;
    const inRow = t >= t4 + 4.6;
    const p = inRow ? slot(G, t) : null;
    const big = g.s(t) / sc0; // 1 in de rij, >1 tijdens het omdraaien
    place(cards[G], {
      x: inRow ? p.x : g.x(t),
      y: g.y(t) + (inHand ? Math.sin(t * 2.3) * 4 : 0),
      s: inRow ? p.s * big : g.s(t),
      r: g.r(t) + (inHand ? Math.sin(t * 1.6) * 1.2 : 0),
      lift: g.lift(t), flip: g.flip(t),
      z: g.lift(t) > 0.01 ? 60 : (t < gUp ? 22 : 12),
    });
    // vinkje + groene rand zodra hij goed blijkt te liggen
    const pop = ramp(t, t5g + 0.7, t5g + 1.05, ease.back);
    const gone = 1 - ramp(t, tb1 + 0.2, tb1 + 0.7);
    const gx = inRow ? p.x : g.x(t);
    markGood.style.opacity = (clamp01(pop * 3) * gone).toFixed(3);
    markGood.style.transform = `translate(${px(gx + SZ / 2 - 8)}, ${px(CY - SZ / 2 + 8)}) scale(${Math.max(0, pop).toFixed(3)})`;
    markGood.style.zIndex = '70';
    ringGood.style.cssText = `opacity:${(ramp(t, t5g + 0.7, t5g + 1.0) * gone).toFixed(3)};width:${SZ + 16}px;height:${SZ + 16}px;transform:translate(${px(gx - SZ / 2 - 8)}, ${px(CY - SZ / 2 - 8)});border:5px solid var(--good);box-shadow:0 0 34px rgba(61,220,143,.55);z-index:11`;
  }

  // foute kaart
  {
    const inHand = t > bHand && t < dB + 0.9;
    const shake = t > tb2 + 1.45 && t < tb2 + 2.05 ? Math.sin((t - tb2 - 1.45) * 42) * 9 * (1 - (t - tb2 - 1.45) / 0.6) : 0;
    place(cards[B], {
      x: b.x(t) + shake,
      y: b.y(t) + (inHand ? Math.sin(t * 2.3) * 4 : 0),
      s: b.s(t), r: b.r(t) + (inHand ? Math.sin(t * 1.6) * 1.2 : 0),
      lift: b.lift(t), flip: b.flip(t), op: b.op(t),
      z: b.lift(t) > 0.01 ? 60 : 21,
    });
    const pop = ramp(t, tb2 + 1.45, tb2 + 1.8, ease.back);
    markBad.style.opacity = (clamp01(pop * 3) * b.op(t)).toFixed(3);
    markBad.style.transform = `translate(${px(b.x(t) + shake + 150)}, ${px(b.y(t) - 150)}) scale(${Math.max(0, pop).toFixed(3)})`;
    markBad.style.zIndex = '70';
  }

  // scan-hoekjes rond de kaart die voor de camera wordt gehouden
  {
    const a = pulse(t, gHand - 0.15, t3 + 0.3, 0.3, 0.3);
    const c = pulse(t, bHand - 0.15, dB + 0.3, 0.3, 0.3);
    const op = Math.max(a, c);
    const hit = Math.max(pulse(t, t3 - 0.05, t3 + 0.3, 0.1, 0.25), pulse(t, dB - 0.05, dB + 0.3, 0.1, 0.25));
    brackets.style.opacity = op.toFixed(3);
    brackets.style.transform = `translate(${px(HAND.x)}, ${px(HAND.y)}) rotate(${HAND.r}deg) scale(${(1 + hit * 0.12).toFixed(3)})`;
    brackets.lastChild.style.top = px(Math.sin(t * 3.4) * 70 - 2);
    brackets.lastChild.style.opacity = (1 - hit).toFixed(2);
  }

  // streepje op de plek waar de kaart boven hangt
  {
    const spots = [[t4 + 1.4, t4 + 2.1, gap3(3)], [t4 + 2.5, t4 + 3.1, gap3(2)], [t4 + 3.5, t4 + 4.05, gap3(1)], [dB + 1.6, dB + 2.05, endGap4]];
    let op = 0; let x = 0;
    for (const [a, z, gx] of spots) { const o = pulse(t, a, z, 0.12, 0.12); if (o > op) { op = o; x = gx; } }
    caret.style.opacity = op.toFixed(3);
    caret.style.transform = `translate(${px(x)}, ${px(CY)})`;
  }

  // de zes extra kaarten van de winnende tijdlijn
  let count = t >= t5g + 0.75 ? 4 : 3;
  winNew.forEach((id, k) => {
    const t0 = POP0 + k * POP_STEP;
    const p = ramp(t, t0, t0 + 0.35, ease.back);
    if (t >= t0 + 0.12) count += 1;
    place(cards[id], { x: wx(winOrder.indexOf(id)), y: CY, s: wsc * Math.max(0, p), flip: 180, op: t >= t0 ? 1 : 0, z: 14 });
  });
  const won = t >= tAll;
  counter.className = `v-counter${won ? ' is-won' : ''}`;
  const html = won ? `${icons.trophy}<span><b>10</b> van 10 kaarten: gewonnen!</span>` : `<span>Jouw tijdlijn: <b>${count}</b> van 10 kaarten</span>`;
  if (counter.dataset.html !== html) { counter.dataset.html = html; counter.innerHTML = html; }
  const bump = 1 + 0.16 * pulse(t, tAll, tAll + 0.5, 0.15, 0.3);
  counter.style.transform = `scale(${bump.toFixed(3)})`;
  counter.style.transformOrigin = '100% 50%';

  for (const c of confetti) {
    const p = (t - tAll - c.delay) / c.dur;
    if (!(p > 0 && p < 1)) { c.n.style.opacity = '0'; continue; }
    c.n.style.opacity = (p < 0.75 ? 1 : (1 - p) * 4).toFixed(2);
    c.n.style.transform = `translate(${px(c.x + c.dx * p)}, ${px(-10 + c.h * p * (0.55 + 0.45 * p))}) rotate(${(c.rot * p).toFixed(1)}deg)`;
  }
}

// ---------- zonder kaarten: wie heeft de telefoon? ----------
const digital = $('digital');
digital.innerHTML = `<div class="v-players">${DIGITAL.names.map((n, i) => `<div class="v-player" data-i="${i}">
    <span class="v-turn">aan de beurt</span><span class="v-crown">${icons.trophy}</span>
    <div class="v-avatar">${n[0]}</div><div class="v-pname">${n}</div><div class="v-pscore"></div></div>`).join('')}</div>
  <div class="v-miniphone">${logoSvg('logo')}</div><p class="v-pass">Eén telefoon gaat rond</p>`;
const playerEls = [...digital.querySelectorAll('.v-player')];
const miniPhone = digital.querySelector('.v-miniphone');
const PLAYER_X = [360, 810];
const D = E.digital || { turns: [], scores: [], winner: null };
function drawDigital(t) {
  const vis = ramp(t, M('setup') + 0.1, M('setup') + 0.6) * (1 - ramp(t, S('p1') - 0.4, S('p1') - 0.05));
  digital.style.opacity = vis.toFixed(3);
  if (vis <= 0) return;
  // positie van de telefoon: glijdt bij elke beurtwissel naar de volgende speler
  let x = 585; let active = -1;
  for (const turn of D.turns) {
    const p = ramp(t, turn.t - 0.1, turn.t + 0.6);
    if (p <= 0) break;
    x = lerp(x, PLAYER_X[turn.player], p);
    if (p > 0.5) active = turn.player;
  }
  miniPhone.style.transform = `translate(${px(x)}, ${px(412)})`;
  const passOp = D.winner ? 1 - ramp(t, D.winner.t - 0.2, D.winner.t + 0.2) : 1;
  miniPhone.style.opacity = passOp.toFixed(3);
  digital.querySelector('.v-pass').style.opacity = passOp.toFixed(3);
  let scores = null;
  for (const s of D.scores) { if (s.t <= t) scores = s; }
  const winner = D.winner && t >= D.winner.t ? D.winner.player : -1;
  playerEls.forEach((p, i) => {
    // een speler verschijnt zodra zijn naam is ingevuld
    const born = ramp(t, M(`name${i}`) - 0.1, M(`name${i}`) + 0.35, ease.out);
    p.style.opacity = born.toFixed(3);
    p.style.transform = `translateY(${px((1 - born) * 30)})`;
    const on = winner >= 0 ? winner === i : active === i;
    p.style.borderColor = on ? 'var(--mustard)' : '';
    p.style.background = on ? 'rgba(255, 198, 73, .12)' : '';
    p.querySelector('.v-turn').style.opacity = on && winner < 0 ? '1' : '0';
    p.querySelector('.v-crown').style.opacity = winner === i ? ramp(t, D.winner.t, D.winner.t + 0.4).toFixed(3) : '0';
    const html = scores ? `<b>${scores.values[i]}</b> van ${scores.goal} kaarten` : '&nbsp;';
    const sEl = p.querySelector('.v-pscore');
    if (sEl.dataset.html !== html) { sEl.dataset.html = html; sEl.innerHTML = html; }
  });
}

// ---------- printen: de twee kanten van een vel ----------
const printEl = $('print');
{
  const first12 = [...deck.values()].sort((a, c) => a.id.localeCompare(c.id)).slice(0, 12);
  const tmp = el('div', '', sheetsHtml(first12, PUBLIC_URL));
  const pages = [...tmp.querySelectorAll('.sheet-page')];
  const labels = ['Voorkant', 'Achterkant'];
  pages.forEach((page, i) => {
    const wrap = el('div', 'v-sheet');
    wrap.append(page);
    printEl.append(wrap, el('div', 'v-sheet-label', labels[i]));
  });
  printEl.append(el('div', 'v-print-chips', ['A4, dubbelzijdig', '12 kaarten per vel', 'knip uit: 6,2 × 6,2 cm'].map((c) => `<span class="v-chip">${c}</span>`).join('')));
}
const sheetEls = [...printEl.querySelectorAll('.v-sheet')];
const sheetLabels = [...printEl.querySelectorAll('.v-sheet-label')];
const printChips = [...printEl.querySelectorAll('.v-print-chips .v-chip')];
const SHEET_SCALE = 0.4;
function drawPrint(t) {
  const vis = 1 - ramp(t, S('outro') - 0.4, S('outro') - 0.05);
  printEl.style.opacity = (t >= S('p1') ? vis : 0).toFixed(3);
  if (t < S('p1') || vis <= 0) return;
  [S('p1') + 0.5, S('p1') + 1.3].forEach((t0, i) => {
    const p = ramp(t, t0, t0 + 0.6, ease.out);
    const x = 10 + i * 364;
    sheetEls[i].style.opacity = p.toFixed(3);
    sheetEls[i].style.transform = `translate(${px(x)}, ${px(64 + (1 - p) * 50)}) rotate(${i ? 1.2 : -1.2}deg) scale(${SHEET_SCALE})`;
    sheetLabels[i].style.opacity = p.toFixed(3);
    sheetLabels[i].style.left = px(x - 31);
    sheetLabels[i].style.top = '10px';
  });
  printChips.forEach((c, i) => {
    const t0 = S('p2') + 0.4 + i * 0.5;
    const p = ramp(t, t0, t0 + 0.4, ease.out);
    c.style.opacity = p.toFixed(3);
    c.style.transform = `translateX(${px((1 - p) * 30)})`;
  });
}

// ---------- slot: drie beloftes ----------
const bulletsEl = $('bullets');
const outro = SCENES.find((s) => s.id === 'outro');
const bulletEls = outro.bullets.map((text, i) => {
  const n = el('div', 'v-bullet', `<i>${icons.check}</i><span>${text}</span>`);
  n.style.top = `${i * 140}px`;
  bulletsEl.append(n);
  return n;
});
bulletsEl.style.top = '330px';
function drawBullets(t) {
  const vis = 1 - ramp(t, S('end') - 0.05, S('end') + 0.35);
  bulletsEl.style.opacity = (t >= S('outro') ? vis : 0).toFixed(3);
  bulletEls.forEach((n, i) => {
    const t0 = S('outro') + 0.6 + i * 0.75;
    const p = ramp(t, t0, t0 + 0.45, ease.out);
    n.style.opacity = p.toFixed(3);
    n.style.transform = `translateX(${px((1 - p) * 40)})`;
  });
}

// ---------- alles samen ----------
const phone = $('phone');
const tapEl = $('tap');
const cutEl = $('cut');
const hlEl = $('hl');

function drawTitle(t) {
  const out = 1 - ramp(t, S('intro') - 0.45, S('intro') - 0.05);
  $('titlecard').style.opacity = out.toFixed(3);
  if (out <= 0) return;
  // logo en woordmerk staan er vanaf het eerste frame (bruikbaar als poster); de rest komt erbij
  const ins = [1, 1, ramp(t, 0.5, 1.0, ease.out), ramp(t, 1.2, 1.7, ease.out)];
  titleParts.forEach((p, i) => {
    p.style.opacity = ins[i].toFixed(3);
    p.style.transform = i === 0 ? `rotate(${(t * 24).toFixed(2)}deg) scale(${(1 + 0.04 * ramp(t, 0, 0.8, ease.out)).toFixed(3)})` : `translateY(${px((1 - ins[i]) * 20)})`;
  });
}
function drawEnd(t) {
  const p = ramp(t, S('end') + 0.3, S('end') + 0.85, ease.out);
  $('endcard').style.opacity = p.toFixed(3);
  if (p <= 0) return;
  endParts.forEach((n, i) => {
    const q = ramp(t, S('end') + 0.3 + i * 0.12, S('end') + 0.85 + i * 0.12, ease.out);
    n.style.opacity = q.toFixed(3);
    n.style.transform = i === 0 ? `rotate(${(t * 24).toFixed(2)}deg)` : `translateY(${px((1 - q) * 20)})`;
  });
}
function drawCopy(t) {
  for (const h of heads) {
    const p = ramp(t, h.t0 + 0.05, h.t0 + 0.45, ease.out);
    const o = p * (1 - ramp(t, h.t1 - 0.2, h.t1));
    h.el.style.opacity = o.toFixed(3);
    h.el.style.transform = `translateY(${px((1 - p) * 18)})`;
  }
  for (const c of caps) {
    const d = c.first ? 0.25 : 0.1;
    const p = ramp(t, c.t0 + d, c.t0 + d + 0.4, ease.out);
    const o = p * (1 - ramp(t, c.t1 - 0.2, c.t1));
    c.el.style.opacity = o.toFixed(3);
    c.el.style.transform = `translateY(${px((1 - p) * 18)})`;
  }
}
function drawPhone(t) {
  const inP = ramp(t, S('intro') + 0.1, S('intro') + 0.9, ease.out);
  const outP = ramp(t, S('end'), S('end') + 0.55, ease.in);
  phone.style.transform = `translate(${px(-outP * 700)}, ${px((1 - inP) * 1100)})`;
  phone.style.visibility = inP <= 0 || outP >= 1 ? 'hidden' : 'visible';

  // tik-indicator
  let op = 0; let x = 0; let y = 0; let scale = 1; let ring = 0;
  for (const tap of E.taps) {
    const lead = tap.lead ?? 0.45;
    if (t < tap.t - lead || t > tap.t + 0.5) continue;
    x = tap.x; y = tap.y;
    if (t < tap.t) { const p = ramp(t, tap.t - lead, tap.t - 0.08, ease.out); op = p; scale = 1.6 - 0.6 * p; } else {
      const p = (t - tap.t) / 0.5;
      op = 1 - ramp(t, tap.t + 0.2, tap.t + 0.5);
      scale = p < 0.2 ? 1 - 0.2 * (p / 0.2) : 0.8 + 0.2 * clamp01((p - 0.2) / 0.3);
      ring = p;
    }
  }
  for (const d of E.drags || []) {
    if (t < d.t0 - 0.3 || t > d.t1 + 0.25) continue;
    const p = ramp(t, d.t0, d.t1);
    x = d.x; y = lerp(d.y0, d.y1, p);
    op = ramp(t, d.t0 - 0.3, d.t0 - 0.05) * (1 - ramp(t, d.t1, d.t1 + 0.25));
    scale = 0.9; ring = 0;
  }
  tapEl.style.opacity = op.toFixed(3);
  tapEl.style.transform = `translate(${px(x * PHONE.scale)}, ${px(30 + y * PHONE.scale)})`;
  tapEl.firstChild.style.transform = `scale(${scale.toFixed(3)})`;
  tapEl.lastChild.style.opacity = ring > 0 ? (1 - ring).toFixed(3) : '0';
  tapEl.lastChild.style.transform = `scale(${(1 + ring * 1.5).toFixed(3)})`;

  // kader om een onderdeel van het scherm
  let hl = 0;
  for (const h of E.highlights || []) {
    const o = pulse(t, h.t0, h.t1, 0.3, 0.3);
    if (o <= hl) continue;
    hl = o;
    const pad = 5; const k = PHONE.scale;
    hlEl.style.left = px(h.x * k - pad); hlEl.style.top = px(30 + h.y * k - pad);
    hlEl.style.width = px(h.width * k + pad * 2 - 8); hlEl.style.height = px(h.height * k + pad * 2 - 8);
  }
  hlEl.style.opacity = hl.toFixed(3);

  let cut = 0;
  for (const c of E.cuts || []) cut = Math.max(cut, pulse(t, c.t0, c.t1, 0.25, 0.3));
  cutEl.style.opacity = cut.toFixed(3);
}

window.renderFrame = async (t) => {
  drawTitle(t); drawCopy(t); drawPhone(t); drawTable(t); drawDigital(t); drawPrint(t); drawBullets(t); drawEnd(t);
  const name = frameAt(t);
  if (name !== currentFrame) {
    currentFrame = name;
    screenImg.src = `../__tmp/phone/${name}`;
    await screenImg.decode();
  }
};

// Controle: past elke kop en ondertitel binnen de kolom?
window.stageWarnings = [];
await document.fonts.ready;
for (const h of heads) {
  const title = h.el.querySelector('.v-title');
  const row = h.el.querySelector('.v-headrow');
  if (row.scrollWidth > 1170) window.stageWarnings.push(`kop te breed (${row.scrollWidth}px): ${title.textContent}`);
}
for (const c of caps) {
  const p = c.el.querySelector('p');
  if (p.getBoundingClientRect().height > 43 * 1.3 * 2 + 4) window.stageWarnings.push(`ondertitel langer dan 2 regels: ${p.textContent}`);
}
await window.renderFrame(0);
window.stageReady = true;
