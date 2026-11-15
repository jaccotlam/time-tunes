// Decor van de uitlegvideo: alles in beeld behalve het telefoonscherm zelf.
// Geen CSS-animaties: elke stand is een pure functie van de tijd t (seconden), zodat
// 3-render.mjs frame voor frame een scherpe, schokvrije video kan maken.
//
// Invoer: ../__tmp/events.json (geschreven door 2-record.mjs) met de starttijden van de
// scènes, de tikken op het scherm en per telefoon de lijst opgenomen frames.
// Een scène die niet is opgenomen (TT_ONLY=...) heeft starttijd Infinity; het decor ervan blijft dan weg.
import { loadDeck, faces } from './cards.js';
import { SCENES } from './scenes.js';
import { icons, logoSvg, wordmark } from '../js/ui.js';
import { sheetsHtml, bingoSheetsHtml } from '../js/screens/print.js';
import { SQUARES } from '../js/bingo.js';

const E = await (await fetch('../__tmp/events.json', { cache: 'no-store' })).json();
const deck = await loadDeck();
const { TABLE, DIGITAL, MULTI, PLAYLIST, PUBLIC_URL, PHONE, SMALL_PHONE } = E.config;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html = '') => { const n = document.createElement(tag); if (cls) n.className = cls; n.innerHTML = html; return n; };

// ---------- tijd-hulpjes ----------
const order = E.scenes.map((s) => s.id);
const startOf = Object.fromEntries(E.scenes.map((s) => [s.id, s.t]));
const S = (id) => startOf[id] ?? Infinity; // start van een scène
const END = (id) => { const i = order.indexOf(id); return i < 0 ? Infinity : (E.scenes[i + 1]?.t ?? E.duration); };
const M = (name) => E.marks[name] ?? Infinity; // los tijdstip uit de opname
const HAS = (id) => id in startOf;
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
$('end-url').textContent = PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
const titleParts = [...$('titlecard').children];
const endParts = [...$('endcard').children];

// ---------- telefoon ----------
document.querySelector('.v-status-icons').innerHTML = `
  <svg width="18" height="14" viewBox="0 0 18 14"><g fill="#fff4e6"><rect x="0" y="9" width="3" height="5" rx="1"/><rect x="5" y="6" width="3" height="8" rx="1"/><rect x="10" y="3" width="3" height="11" rx="1"/><rect x="15" y="0" width="3" height="14" rx="1"/></g></svg>
  <svg width="26" height="14" viewBox="0 0 26 14"><rect x="1" y="1" width="21" height="12" rx="3.5" fill="none" stroke="#fff4e6" stroke-width="1.6"/><rect x="3.4" y="3.4" width="14" height="7.2" rx="1.8" fill="#fff4e6"/><rect x="23.4" y="4.6" width="2" height="4.8" rx="1" fill="#fff4e6"/></svg>`;
const screenImg = $('screen');
let currentFrame = '';
/** Het laatste frame van een telefoon op tijdstip t (frames = [[t, bestand], ...]). */
function frameAt(f, t) {
  let lo = 0; let hi = f.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f[mid][0] <= t + 0.004) lo = mid; else hi = mid - 1; }
  return f[lo][1];
}

// ---------- tekst rechts ----------
const copy = $('copy');
const badgeHtml = (b) => ({ print: icons.print, check: icons.check, music: icons.music }[b] || b);
const heads = []; // { el, t0, t1 }
const caps = []; //  { el, t0, t1, first }
{
  let run = null;
  for (const sc of SCENES) {
    if (!sc.title || !(sc.id in startOf)) { run = null; continue; }
    const key = `${sc.kicker}|${sc.badge}|${sc.title}`;
    const first = !run || run.key !== key;
    if (first) {
      const node = el('div', `v-head${sc.layout === 'trio' ? ' is-trio' : ''}`, `<p class="v-kicker">${sc.kicker}</p><div class="v-headrow"><span class="v-badge ${/^\d$/.test(sc.badge) ? '' : 'is-teal'}">${badgeHtml(sc.badge)}</span><h1 class="v-title">${sc.title}</h1></div>`);
      copy.append(node);
      run = { key, el: node, t0: S(sc.id), t1: END(sc.id) };
      heads.push(run);
    } else run.t1 = END(sc.id);
    if (sc.caption) {
      const node = el('div', `v-cap${sc.layout === 'trio' ? ' is-trio' : ''}`, `<p>${sc.caption}</p>${sc.chips ? `<div class="v-chips">${sc.chips.map((c) => `<span class="v-chip">${c}</span>`).join('')}</div>` : ''}`);
      copy.append(node);
      // chipMarks: elk kaartje licht op vanaf zijn tijdstip tot het volgende (gelijk met het kader op de telefoon)
      const chips = (sc.chipMarks || []).map((m, i) => ({ el: node.querySelectorAll('.v-chip')[i], t0: M(m), t1: M(sc.chipMarks[i + 1]) }));
      caps.push({ el: node, t0: S(sc.id), t1: END(sc.id), first, chips, trio: sc.layout === 'trio' });
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
const guess = el('div', 'v-guess', 'welk jaar?');
cardsEl.append(guess);
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
  const tableEnd = HAS('s6') ? END('s6') : END('modes');
  const vis = ramp(t, S('intro') + 0.9, S('intro') + 1.5) * (1 - ramp(t, tableEnd - 0.4, tableEnd - 0.05));
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
  if (!HAS('s2')) { // het verhaal met kaartjes is niet opgenomen: alleen de stapel en de drie open kaarten
    for (const id of [G, B, ...winNew]) place(cards[id], { x: 0, y: 0, op: 0 });
    counter.innerHTML = '<span>Jouw tijdlijn: <b>3</b> van 10 kaarten</span>';
    for (const c of confetti) c.n.style.opacity = '0';
    return;
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

  // "welk jaar?" bij de kaart zolang hij nog dicht is
  {
    const a = pulse(t, t3 + 0.5, t4 + 4.1, 0.3, 0.25);
    const c = pulse(t, dB + 0.4, dB + 2.1, 0.3, 0.25);
    const useB = c > a;
    const src = useB ? b : g;
    const wob = 1 + 0.05 * Math.sin(t * 5);
    guess.style.opacity = Math.max(a, c).toFixed(3);
    guess.style.transform = `translate(${px(src.x(t) - 20)}, ${px(src.y(t) - 132)}) scale(${wob.toFixed(3)})`;
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
const D = { turns: [], scores: [], winner: null, ...(E.digital || {}) };
function drawDigital(t) {
  const vis = ramp(t, M('setup') + 0.1, M('setup') + 0.6) * (1 - ramp(t, END('d3') - 0.4, END('d3') - 0.05));
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
  // het derde vel: de bingokaarten die ook op het printscherm van de telefoon staan (zelfde zaaiwaarde)
  const pb = E.print?.bingo || { seed: 1, size: 4 };
  const tmpBingo = el('div', '', bingoSheetsHtml(8, pb.size, pb.seed));
  const pages = [...tmp.querySelectorAll('.sheet-page'), tmpBingo.querySelector('.sheet-page')];
  const labels = ['Voorkant', 'Achterkant', 'Bingokaarten'];
  pages.forEach((page, i) => {
    const wrap = el('div', 'v-sheet');
    wrap.append(page);
    printEl.append(wrap, el('div', 'v-sheet-label', labels[i]));
  });
  printEl.append(el('div', 'v-print-chips', ['A4, dubbelzijdig', '12 kaartjes per vel', 'bingokaarten: 2 per vel'].map((c) => `<span class="v-chip">${c}</span>`).join('')));
}
const sheetEls = [...printEl.querySelectorAll('.v-sheet')];
const sheetLabels = [...printEl.querySelectorAll('.v-sheet-label')];
const printChips = [...printEl.querySelectorAll('.v-print-chips .v-chip')];
const SHEET_SCALE = 0.4;
function drawPrint(t) {
  const vis = 1 - ramp(t, END('p2') - 0.4, END('p2') - 0.05);
  printEl.style.opacity = (t >= S('p1') ? vis : 0).toFixed(3);
  if (t < S('p1') || vis <= 0) return;
  [S('p1') + 0.5, S('p1') + 1.3, S('p2') + 0.5].forEach((t0, i) => {
    const p = ramp(t, t0, t0 + 0.6, ease.out);
    const x = 62 + i * 364;
    sheetEls[i].style.opacity = p.toFixed(3);
    sheetEls[i].style.transform = `translate(${px(x)}, ${px(64 + (1 - p) * 50)}) rotate(${i === 1 ? 1.2 : -1.2}deg) scale(${SHEET_SCALE})`;
    sheetLabels[i].style.opacity = p.toFixed(3);
    sheetLabels[i].style.left = px(x - 31);
    sheetLabels[i].style.top = '10px';
  });
  printChips.forEach((c, i) => {
    const t0 = [S('p1') + 2.2, S('p1') + 2.7, S('p2') + 1.3][i];
    const p = ramp(t, t0, t0 + 0.4, ease.out);
    c.style.opacity = p.toFixed(3);
    c.style.transform = `translateY(${px((1 - p) * 20)})`;
  });
}

// ---------- alleen de app: bingo (de kaarten groot, gelijk met de telefoon) ----------
const bingoEl = $('bingo');
const BG = { size: 3, names: [], cards: [], years: {}, snaps: [], ...(E.bingo || {}) };
function bingoCardHtml(card, marks, { selected = null, winLine = null } = {}) {
  // zelfde opbouw en klassen als bingoCardHtml in app/js/screens/bingo.js (opmaak uit app/css/bingo.css)
  const cells = card.map((key, i) => {
    const sq = SQUARES[key];
    const stamped = marks[i] != null;
    const state = stamped ? 'stamped' : selected === i ? 'selected' : 'open';
    const stamp = stamped ? `<span class="bc-done"><span class="bc-stamp">${icons.check}</span><span class="bc-year">${BG.years[marks[i]] ?? ''}</span></span>` : '';
    return `<div class="bc kind-${sq.kind} is-${state}${winLine && winLine.includes(i) ? ' is-win' : ''}"><span class="bc-label">${sq.short || sq.label}</span><span class="bc-sub">${sq.sub}</span>${stamp}</div>`;
  }).join('');
  return `<div class="bingo-card size-${BG.size}" style="--n:${BG.size}">${cells}</div>`;
}
const B_SCALE = [1.5, 1.1];
const B_BOX = [{ x: 69, w: 554, h: 533 }, { x: 683, w: 418, h: 420 }];
const bPanels = BG.cards.map((card, i) => {
  const n = el('div', 'v-bpanel', `<div class="v-bhead"><span class="v-bavatar">${BG.names[i][0]}</span><span class="v-bname">${BG.names[i]}</span><span class="v-bchip"></span></div><div class="v-bcard"></div>`);
  n.style.cssText = `left:${B_BOX[i].x}px;width:${B_BOX[i].w}px;height:${B_BOX[i].h}px`;
  n.querySelector('.v-bcard').style.transform = `scale(${B_SCALE[i]})`;
  bingoEl.append(n);
  return { n, cardEl: n.querySelector('.v-bcard'), chip: n.querySelector('.v-bchip'), html: '', chipHtml: '' };
});
bingoEl.append(el('p', 'v-bnote', 'Iedereen heeft een andere kaart · één telefoon gaat rond'));
bingoEl.prepend(el('div', '', '')); // de confetti valt achter de kaarten langs, zodat namen en vakjes leesbaar blijven
bingoEl.firstChild.id = 'bingo-confetti';
const bingoConfetti = Array.from({ length: 48 }, (_, i) => {
  const n = el('i');
  n.style.background = ['var(--mustard)', 'var(--coral)', 'var(--teal)'][i % 3];
  bingoEl.firstChild.append(n);
  return { n, x: 60 + rnd() * 1050, dx: (rnd() - 0.5) * 160, delay: rnd() * 0.8, dur: 1.5 + rnd() * 0.9, rot: 300 + rnd() * 700, h: 440 + rnd() * 120 };
});
function drawBingo(t) {
  const vis = ramp(t, S('b1') + 0.4, S('b1') + 0.9) * (1 - ramp(t, END('b3') - 0.4, END('b3') - 0.05));
  bingoEl.style.opacity = vis.toFixed(3);
  if (vis <= 0) return;
  let snap = null; let prev = null;
  for (const s of BG.snaps) { if (s.t > t) break; prev = snap; snap = s; }
  const tWin = M('bingoWin');
  bPanels.forEach((p, i) => {
    const born = ramp(t, S('b1') + 0.4 + i * 0.25, S('b1') + 0.9 + i * 0.25, ease.out);
    p.n.style.opacity = born.toFixed(3);
    p.n.style.transform = `translateY(${px((1 - born) * 30)})`;
    const marks = snap ? snap.marks[i] : BG.cards[i].map(() => null);
    const mine = i === 0; // in de video is steeds Sanne (de eerste speler) aan de beurt
    const html = bingoCardHtml(BG.cards[i], marks, { selected: mine && snap ? snap.selected : null, winLine: mine && snap ? snap.winLine : null });
    if (p.html !== html) { p.html = html; p.cardEl.innerHTML = html; }
    let chip = ''; let cls = '';
    if (mine && snap) {
      const count = (m) => m.filter((x) => x != null).length;
      if (snap.winLine) { chip = `${icons.trophy}<span>BINGO!</span>`; cls = ' is-won'; }
      else if (snap.selected != null) chip = `claimt: ${SQUARES[BG.cards[0][snap.selected]].label}`;
      else if (prev && prev.selected != null && count(marks) > count(prev.marks[0])) { chip = `${icons.check}<span>goed: afgestempeld</span>`; cls = ' is-good'; }
      else chip = 'aan de beurt';
    }
    if (p.chipHtml !== chip + cls) { p.chipHtml = chip + cls; p.chip.innerHTML = chip; p.chip.className = `v-bchip${cls}`; }
    p.chip.style.opacity = chip ? '1' : '0';
    p.chip.style.transform = cls === ' is-won' ? `scale(${(1 + 0.18 * pulse(t, tWin, tWin + 0.6, 0.15, 0.35)).toFixed(3)})` : '';
    p.n.classList.toggle('is-turn', mine && !!snap);
  });
  for (const c of bingoConfetti) {
    const q = (t - tWin - c.delay) / c.dur;
    if (!(q > 0 && q < 1)) { c.n.style.opacity = '0'; continue; }
    c.n.style.opacity = (q < 0.75 ? 1 : (1 - q) * 4).toFixed(2);
    c.n.style.transform = `translate(${px(c.x + c.dx * q)}, ${px(-10 + c.h * q * (0.55 + 0.45 * q))}) rotate(${(c.rot * q).toFixed(1)}deg)`;
  }
}

// ---------- ieder een eigen telefoon: spelleider en spelers naast elkaar ----------
const FR = E.frames;
const TRIO_X = [267, 772, 1277];
const sphones = [['host', MULTI.host, 'speelt de muziek'], ['a', MULTI.names[0], ''], ['b', MULTI.names[1], '']]
  .filter(([key]) => FR[key]?.length).map(([key, name, sub], i) => {
    const n = el('div', 'v-sphone', `<span class="v-stag${i === 0 ? ' is-host' : ''}">${name}${sub ? `<small>${sub}</small>` : ''}</span>
      <div class="v-sscreen"><img alt=""><div class="v-stap"><i></i><b></b></div></div>`);
    $('trio').append(n);
    return { key, n, img: n.querySelector('img'), tap: n.querySelector('.v-stap'), cur: '' };
  });
/** Stand van de tik-indicator op een telefoon: { op, x, y, scale, ring } in CSS-px van die telefoon. */
function tapState(t, key) {
  let op = 0; let x = 0; let y = 0; let scale = 1; let ring = 0;
  for (const tap of E.taps) {
    if ((tap.phone || 'main') !== key) continue;
    const lead = tap.lead ?? 0.45;
    if (t < tap.t - lead || t > tap.t + 0.5) continue;
    x = tap.x; y = tap.y;
    if (t < tap.t) { const p = ramp(t, tap.t - lead, tap.t - 0.08, ease.out); op = p; scale = 1.6 - 0.6 * p; ring = 0; } else {
      const p = (t - tap.t) / 0.5;
      op = 1 - ramp(t, tap.t + 0.2, tap.t + 0.5);
      scale = p < 0.2 ? 1 - 0.2 * (p / 0.2) : 0.8 + 0.2 * clamp01((p - 0.2) / 0.3);
      ring = p;
    }
  }
  for (const d of E.drags || []) {
    if ((d.phone || 'main') !== key) continue;
    if (t < d.t0 - 0.3 || t > d.t1 + 0.25) continue;
    const p = ramp(t, d.t0, d.t1);
    x = d.x; y = lerp(d.y0, d.y1, p);
    op = ramp(t, d.t0 - 0.3, d.t0 - 0.05) * (1 - ramp(t, d.t1, d.t1 + 0.25));
    scale = 0.9; ring = 0;
  }
  return { op, x, y, scale, ring };
}
function drawTap(node, s, k, top) {
  node.style.opacity = s.op.toFixed(3);
  node.style.transform = `translate(${px(s.x * k)}, ${px(top + s.y * k)})`;
  node.firstChild.style.transform = `scale(${s.scale.toFixed(3)})`;
  node.lastChild.style.opacity = s.ring > 0 ? (1 - s.ring).toFixed(3) : '0';
  node.lastChild.style.transform = `scale(${(1 + s.ring * 1.5).toFixed(3)})`;
}
function drawTrio(t) {
  const a = M('trioIn'); const z = M('trioOut');
  sphones.forEach((p, i) => {
    const inP = ramp(t, a + 0.45 + i * 0.15, a + 1.15 + i * 0.15, ease.out);
    const outP = ramp(t, z + i * 0.06, z + 0.55 + i * 0.06, ease.in);
    const vis = inP > 0 && outP < 1;
    p.n.style.visibility = vis ? 'visible' : 'hidden';
    if (!vis) return;
    p.n.style.transform = `translate(${px(TRIO_X[i])}, ${px((1 - inP) * 900 + outP * 900)})`;
    drawTap(p.tap, tapState(t, p.key), SMALL_PHONE.scale, 24);
  });
}

// ---------- de muziek: fragment of heel nummer ----------
const musicEl = $('music');
musicEl.innerHTML = `
  <div class="v-tile" style="left:0;top:30px"><div class="v-tile-top"><span class="v-tile-ico">${icons.music}</span><span class="v-chip">standaard</span></div>
    <b>Fragment van 30 seconden</b><p>Geen account nodig.</p></div>
  <div class="v-tile is-teal" style="left:608px;top:30px"><div class="v-tile-top"><span class="v-tile-ico">${icons.music}</span><span class="v-chip is-quiet">als je wilt</span></div>
    <b>Hele nummers via Spotify</b><p>Met Spotify Premium. Eén keer koppelen bij Instellingen.</p></div>`;
const musicTiles = [...musicEl.querySelectorAll('.v-tile')];
function drawMusic(t) {
  const vis = 1 - ramp(t, END('set1') - 0.4, END('set1') - 0.05);
  musicEl.style.opacity = (t >= S('set1') ? vis : 0).toFixed(3);
  if (t < S('set1') || vis <= 0) return;
  const on = [[M('srcPreview'), M('srcSpotify')], [M('srcSpotify'), END('set1')]];
  musicTiles.forEach((n, i) => {
    const p = ramp(t, S('set1') + 0.3 + i * 0.3, S('set1') + 0.8 + i * 0.3, ease.out);
    n.style.opacity = p.toFixed(3);
    n.style.transform = `translateY(${px((1 - p) * 30)})`;
    n.classList.toggle('is-on', t >= on[i][0] && t < on[i][1]);
  });
}

// ---------- eigen playlist: de lijst groot, gelijk met de telefoon ----------
const playlistEl = $('playlist');
{
  // net als in de app staat het nieuwste nummer bovenaan
  const row = (tr, i, cls = '') => `<div class="v-pl-row${cls}"><i>${String(i + 1).padStart(3, '0')}</i><span>${tr.title}<small>${tr.artist}</small></span><b>${tr.year}</b></div>`;
  playlistEl.innerHTML = `<div class="v-pl">
      <div class="v-pl-head"><span class="v-tile-ico">${icons.music}</span><span class="v-pl-name">${PLAYLIST.name}</span><span class="v-pl-count"></span><span class="v-pl-active">Actief</span></div>
      ${row(PLAYLIST.expect, PLAYLIST.tracks.length, ' is-new')}${PLAYLIST.tracks.map((tr, i) => row(tr, i)).reverse().join('')}
    </div>
    <div class="v-pl-side"><h3>Nummers toevoegen</h3>
      <span class="v-chip">zoeken</span><span class="v-chip">een lijst plakken</span><span class="v-chip">Spotify-playlist overnemen</span>
      <h3 class="is-second">En verder</h3>
      <span class="v-chip">eigen kaartjes printen</span><span class="v-chip">delen via link of QR-code</span></div>`;
}
const plBox = playlistEl.querySelector('.v-pl');
const plNew = playlistEl.querySelector('.v-pl-row.is-new');
const plCount = playlistEl.querySelector('.v-pl-count');
const plActive = playlistEl.querySelector('.v-pl-active');
const plSide = [...playlistEl.querySelectorAll('.v-pl-side > *')];
function drawPlaylist(t) {
  const vis = 1 - ramp(t, END('pl3') - 0.4, END('pl3') - 0.05);
  playlistEl.style.opacity = (t >= S('pl1') ? vis : 0).toFixed(3);
  if (t < S('pl1') || vis <= 0) return;
  const born = ramp(t, S('pl1') + 0.3, S('pl1') + 0.8, ease.out);
  plBox.style.opacity = born.toFixed(3);
  plBox.style.transform = `translateY(${px((1 - born) * 30)})`;
  const added = ramp(t, M('added'), M('added') + 0.4, ease.out);
  plNew.style.height = px(62 * added);
  plNew.style.opacity = added.toFixed(3);
  plNew.style.borderTopWidth = added > 0 ? '2px' : '0';
  const n = PLAYLIST.tracks.length + (t >= M('added') ? 1 : 0);
  if (plCount.textContent !== `${n} nummers`) plCount.textContent = `${n} nummers`;
  plBox.classList.toggle('is-years', t >= M('years') && t < M('years') + 2.5);
  const act = ramp(t, M('active'), M('active') + 0.35, ease.back);
  plActive.style.opacity = clamp01(act * 3).toFixed(3);
  plActive.style.transform = `scale(${Math.max(0, act).toFixed(3)})`;
  plSide.forEach((c, i) => {
    const p = ramp(t, S('pl1') + 0.7 + i * 0.22, S('pl1') + 1.1 + i * 0.22, ease.out);
    c.style.opacity = p.toFixed(3);
    c.style.transform = `translateX(${px((1 - p) * 30)})`;
  });
  plSide[1].classList.toggle('is-on', t >= M('playlistOpen') + 0.6 && t < M('added') + 0.6); // "zoeken" is wat de telefoon nu laat zien
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
    const d = Math.abs(h.t0 - M('trioIn')) < 0.1 ? 0.35 : 0.05; // eerst zakt de hoofdtelefoon weg
    const p = ramp(t, h.t0 + d, h.t0 + d + 0.4, ease.out);
    const o = p * (1 - ramp(t, h.t1 - 0.2, h.t1));
    h.el.style.opacity = o.toFixed(3);
    h.el.style.transform = `translateY(${px((1 - p) * 18)})`;
  }
  for (const c of caps) {
    const d = Math.abs(c.t0 - M('trioIn')) < 0.1 ? 0.5 : c.first ? 0.25 : 0.1;
    const p = ramp(t, c.t0 + d, c.t0 + d + 0.4, ease.out);
    const o = p * (1 - ramp(t, c.t1 - 0.2, c.t1));
    c.el.style.opacity = o.toFixed(3);
    c.el.style.transform = `translateY(${px((1 - p) * 18)})`;
    for (const chip of c.chips) chip.el.classList.toggle('is-on', t >= chip.t0 && t < chip.t1);
  }
}
function drawPhone(t) {
  const inP = ramp(t, S('intro') + 0.1, S('intro') + 0.9, ease.out);
  const outP = ramp(t, S('end'), S('end') + 0.55, ease.in);
  // tijdens "Ieder een eigen telefoon" zakt de hoofdtelefoon weg en komen de drie kleinere omhoog
  const away = ramp(t, M('trioIn'), M('trioIn') + 0.5, ease.in) * (1 - ramp(t, M('trioOut') + 0.75, M('trioOut') + 1.35, ease.out));
  phone.style.transform = `translate(${px(-outP * 700)}, ${px((1 - inP) * 1100 + away * 1100)})`;
  phone.style.visibility = inP <= 0 || outP >= 1 || away >= 1 ? 'hidden' : 'visible';

  drawTap(tapEl, tapState(t, 'main'), PHONE.scale, 30); // tik-indicator

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
  drawTitle(t); drawCopy(t); drawPhone(t); drawTable(t); drawDigital(t); drawBingo(t); drawTrio(t); drawPrint(t);
  drawMusic(t); drawPlaylist(t); drawBullets(t); drawEnd(t);
  const jobs = [];
  const name = frameAt(FR.main, t);
  if (name !== currentFrame) {
    currentFrame = name;
    screenImg.src = `../__tmp/phone/main/${name}`;
    jobs.push(screenImg.decode());
  }
  for (const p of sphones) {
    if (p.n.style.visibility !== 'visible') continue;
    const f = frameAt(FR[p.key], t);
    if (f !== p.cur) { p.cur = f; p.img.src = `../__tmp/phone/${p.key}/${f}`; jobs.push(p.img.decode()); }
  }
  await Promise.all(jobs);
};

// Controle: past elke kop en ondertitel binnen de kolom?
window.stageWarnings = [];
await document.fonts.ready;
for (const h of heads) {
  const title = h.el.querySelector('.v-title');
  const row = h.el.querySelector('.v-headrow');
  const max = h.el.classList.contains('is-trio') ? 930 : 1170;
  if (row.scrollWidth > max) window.stageWarnings.push(`kop te breed (${row.scrollWidth}px): ${title.textContent}`);
}
for (const c of caps) {
  const p = c.el.querySelector('p');
  // naast de telefoon: 2 regels van 43 px; boven de drie telefoons: 3 regels van 36 px
  const max = c.trio ? 36 * 1.3 * 3 + 4 : 43 * 1.3 * 2 + 4;
  if (p.getBoundingClientRect().height > max) window.stageWarnings.push(`ondertitel langer dan ${c.trio ? 3 : 2} regels: ${p.textContent}`);
}
await window.renderFrame(0);
window.stageReady = true;
