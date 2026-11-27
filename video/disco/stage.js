// Het decor van de Discobingo-video: een pure functie van de tijd. window.renderFrame(t) zet de juiste schermbeelden
// (uit de opname) in de vier schermen (tab 1 spelleider, tab 2 grote scherm, twee telefoons), in de opstelling van dat
// moment, met de ondertitel, de tik-ringen en de kaders.
import { logoSvg } from '../js/ui.js';
import { SCENES, TITLE, END } from './scenes.js';

const $ = (id) => document.getElementById(id);
const KEYS = ['host', 'tv', 'a', 'b'];

// ---- opstellingen: per scherm de linkerbovenhoek van het scherm (x, y) en de schaal `sf` (videopixels per CSS-pixel) ----
// Het grote scherm en de spelleider zijn 1280 x 720 CSS-px, een telefoon 390 x 850. De opname is op 0,8x (tv, laptop) en
// 0,9x (telefoon) gemaakt: in beeld nooit groter dan dat, dus altijd scherp. `copy` is de plek van de ondertitel.
const SMALL_HOST = { sf: 0.28, x: 1128, y: 136 };
const LAYOUTS = {
  // alleen de tab van de spelleider, in het midden (de tv is er nog niet)
  solo: { host: { sf: 0.68, x: 525, y: 130 }, tv: { hide: 1, sf: 0.68, x: 990, y: 130 }, a: { hide: 1, sf: 0.9, x: 1521, y: 100 }, b: { hide: 1, sf: 0.4, x: 1230, y: 440 }, copy: { w: 1800 } },
  // twee tabs naast elkaar (de telefoons zijn er nog niet)
  tabs: { host: { sf: 0.68, x: 60, y: 130 }, tv: { sf: 0.68, x: 990, y: 130 }, a: { hide: 1, sf: 0.9, x: 1521, y: 100 }, b: { hide: 1, sf: 0.4, x: 1230, y: 440 }, copy: { w: 1800 } },
  // het grote scherm groot, een telefoon groot; de tab van de spelleider en de andere telefoon klein ertussen
  play: { tv: { sf: 0.8, x: 60, y: 100 }, host: SMALL_HOST, b: { sf: 0.42, x: 1226, y: 440 }, a: { sf: 0.9, x: 1521, y: 100 }, copy: { w: 1040 } },
  // dezelfde, maar Bram staat groot en Anouk klein
  leave: { tv: { sf: 0.8, x: 60, y: 100 }, host: SMALL_HOST, a: { sf: 0.42, x: 1226, y: 440 }, b: { sf: 0.9, x: 1521, y: 100 }, copy: { w: 1040 } },
  // de tab van de spelleider groot (de Regie), de tv en Bram kleiner
  host: { host: { sf: 0.8, x: 60, y: 100 }, tv: { sf: 0.46, x: 1200, y: 134 }, b: { sf: 0.55, x: 1200, y: 520 }, a: { hide: 1, sf: 0.42, x: 1500, y: 520 }, copy: { w: 1040 } },
};
LAYOUTS.title = LAYOUTS.play; LAYOUTS.end = LAYOUTS.play;

const ev = await (await fetch('/__tmp/events.json', { cache: 'no-store' })).json();
$('titlecard').innerHTML = `<div class="logo">${logoSvg('logo')}</div><div class="word">${TITLE.word}</div><p class="tagline">${TITLE.tag}</p><span class="pill">${TITLE.pill}</span>`;
$('endcard').innerHTML = `<div class="logo">${logoSvg('logo')}</div><div class="word">${TITLE.word}</div><p class="endline">${END.line}</p><p class="url">${END.url}</p><p class="tip">${END.tip}</p><span class="pill">${END.pill}</span>`;
const NAMES = { a: ev.players[0], b: ev.players[1] };

// ---- montagelijst -> tijdlijn van de video ----
const rec = ev.edit.filter((e) => e.r0 != null);
const timeline = [];
let o = 0;
for (const e of ev.edit) {
  if (e.r0 == null) { timeline.push({ ...e, o0: o, o1: o + e.dur }); o += e.dur; continue; }
  const next = rec[rec.indexOf(e) + 1];
  const r1 = next ? next.r0 : ev.duration;
  const len = (r1 - e.r0) / e.speed;
  timeline.push({ ...e, r1, o0: o, o1: o + len });
  o += len;
}
export const DURATION = o;
window.videoDuration = DURATION;
window.timeline = timeline;

// scène -> begin en einde (aaneengesloten stukken met dezelfde id horen bij elkaar)
const scenes = [];
for (const seg of timeline) {
  const last = scenes[scenes.length - 1];
  if (last && last.id === seg.id) { last.o1 = seg.o1; } else scenes.push({ id: seg.id, o0: seg.o0, o1: seg.o1, layout: seg.layout });
}
window.sceneList = scenes;

const find = (frames, t) => { // laatste beeld met tijd <= t
  let lo = 0; let hi = frames.length - 1; let ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (frames[mid][0] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return frames[ans][1];
};
const smooth = (x) => x * x * (3 - 2 * x);
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, k) => a + (b - a) * k;
const loaded = {};
async function setImg(key, t) {
  const name = find(ev.frames[key], t);
  if (loaded[key] === name) return;
  const img = $(`img-${key}`);
  img.src = `/__tmp/phone/${key}/${name}`;
  loaded[key] = name;
  try { await img.decode(); } catch { /* beeld ontbreekt: dan blijft het vorige staan */ }
}

const CSS = { host: { w: 1280, h: 720 }, tv: { w: 1280, h: 720 }, a: { w: 390, h: 850 }, b: { w: 390, h: 850 } };
/** Plek en doorzichtigheid van een scherm op tijd t: de opstelling van het huidige stuk, met een zachte overgang aan het begin. */
function place(key, seg, prev, t) {
  const to = LAYOUTS[seg.layout][key];
  const from = prev && prev.layout !== seg.layout ? LAYOUTS[prev.layout][key] : to;
  const k = from === to ? 1 : smooth(clamp((t - seg.o0) / 0.8));
  const f = from.hide ? { ...to, hide: 1 } : from;
  const g = to.hide ? { ...from, hide: 1 } : to;
  const a = from.hide ? to : f;
  const b = to.hide ? from : g;
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), sf: lerp(a.sf, b.sf, k), on: lerp(from.hide ? 0 : 1, to.hide ? 0 : 1, k) };
}
const rects = {};

const sceneDef = (id) => SCENES.find((s) => s.id === id);
const stepsTotal = Math.max(...SCENES.map((s) => s.step || 0));
function copyHtml(id) {
  const sc = sceneDef(id);
  return `<p class="kicker">Stap ${sc.step} van ${stepsTotal}</p><div class="headrow"><div class="badge">${sc.step}</div><h2 class="ctitle">${sc.title}</h2></div><p class="ccap">${sc.caption}</p>`;
}
let copyFor = null;

function tagText(key, sf) {
  if (key === 'tv') return sf >= 0.6 ? 'Groot scherm · tab 2 · op de tv' : 'Groot scherm · tab 2';
  if (key === 'host') return sf >= 0.6 ? 'Spelleider · tab 1 · laptop' : 'Spelleider · tab 1';
  return NAMES[key];
}

window.renderFrame = async (t) => {
  t = Math.min(t, DURATION - 0.001);
  const idx = Math.max(0, timeline.findIndex((s) => t >= s.o0 && t < s.o1));
  const seg = timeline[idx] || timeline[timeline.length - 1];
  const prev = timeline[idx - 1] && timeline[idx - 1].r0 != null ? timeline[idx - 1] : null;
  const scene = scenes.find((s) => s.id === seg.id);
  const isCard = seg.id === 'title' || seg.id === 'end';
  const fade = (a, b) => smooth(clamp((t - a) / 0.35)) * smooth(clamp((b - t) / 0.35));

  // schermen: welk beeld
  const src = seg.r0 != null ? seg.r0 + (t - seg.o0) * seg.speed : null;
  $('devices').style.opacity = isCard ? 0 : 1;
  $('titlecard').style.opacity = seg.id === 'title' ? (t < 0.2 ? 1 : smooth(clamp((seg.o1 - t) / 0.4))) : 0;
  $('endcard').style.opacity = seg.id === 'end' ? smooth(clamp((t - seg.o0) / 0.5)) : 0;
  const at = src != null ? src : seg.id === 'end' ? ev.duration : 0;
  await Promise.all(KEYS.map((k) => setImg(k, at)));

  // schermen: waar en hoe groot
  for (const k of KEYS) {
    const p = place(k, seg, prev, t);
    const first = ev.frames[k][0][0];
    const shown = at >= first ? smooth(clamp((at - first) / 0.45)) : 0;
    const w = CSS[k].w * p.sf; const h = CSS[k].h * p.sf;
    const small = k === 'tv' || k === 'host' ? p.sf < 0.5 : p.sf < 0.5;
    const pad = small ? 7 : 12;
    const el = $(`dev-${k}`);
    el.style.setProperty('--pad', `${pad}px`);
    el.style.setProperty('--rr', `${small ? 14 : k === 'a' || k === 'b' ? 40 : 22}px`);
    el.style.setProperty('--ri', `${small ? 8 : k === 'a' || k === 'b' ? 30 : 12}px`);
    Object.assign(el.style, { left: `${p.x - pad}px`, top: `${p.y - pad}px`, width: `${w + 2 * pad}px`, height: `${h + 2 * pad}px`, opacity: p.on * shown });
    const tag = $(`tag-${k}`);
    tag.textContent = tagText(k, p.sf);
    tag.classList.toggle('is-small', small);
    Object.assign(tag.style, { left: `${p.x + w / 2}px`, top: `${p.y - pad - (small ? 36 : 46)}px`, opacity: p.on * shown });
    rects[k] = { x: p.x, y: p.y, sf: p.sf };
  }

  // ondertitel
  const sc = sceneDef(seg.id);
  const copy = $('copy');
  if (sc && sc.title) {
    if (copyFor !== seg.id) { copy.innerHTML = copyHtml(seg.id); copyFor = seg.id; }
    copy.style.width = `${LAYOUTS[scene.layout].copy.w}px`;
    const next = scenes[scenes.indexOf(scene) + 1];
    const out = next && sceneDef(next.id)?.title ? scene.o1 : scene.o1 + 1; // laatste scène blijft staan
    copy.style.opacity = fade(scene.o0, out);
    copy.style.transform = `translateY(${(1 - smooth(clamp((t - scene.o0) / 0.4))) * 14}px)`;
  } else copy.style.opacity = 0;

  // tikken (tijden in opnametijd)
  for (const k of ['host', 'a', 'b']) $(`ring-${k}`).style.opacity = 0;
  if (src != null) {
    for (const tp of ev.taps) {
      const dt = src - tp.t;
      if (dt < -tp.lead || dt > 0.45) continue;
      const R = rects[tp.dev];
      if (!R) continue;
      const ring = $(`ring-${tp.dev}`);
      const sz = clamp(R.sf * 1.5 + 0.3);
      ring.style.left = `${R.x + tp.x * R.sf}px`; ring.style.top = `${R.y + tp.y * R.sf}px`;
      const ap = dt < 0 ? 1 - Math.abs(dt) / tp.lead : 1;
      ring.style.opacity = (dt < 0 ? smooth(clamp(ap * 2.2)) : clamp(1 - (dt - 0.25) / 0.2)) * place(tp.dev, seg, prev, t).on;
      const [dot, burst] = ring.children;
      dot.style.transform = `scale(${(dt < 0 ? 1.45 - 0.45 * ap : 0.85) * sz})`;
      burst.style.opacity = dt >= 0 ? clamp(1 - dt / 0.4) * 0.9 : 0;
      burst.style.transform = `scale(${(dt >= 0 ? 0.9 + (dt / 0.4) * 1.3 : 1) * sz})`;
    }
  }
  // kaders (er kunnen er meer tegelijk in beeld zijn)
  const hls = [...document.querySelectorAll('.hl')];
  let used = 0;
  if (src != null) {
    for (const h of ev.highlights) {
      if (src < h.t0 || src > h.t1) continue;
      const R = rects[h.dev];
      let el = hls[used];
      if (!el) { el = document.createElement('div'); el.className = 'hl'; $('devices').appendChild(el); hls.push(el); }
      used += 1;
      Object.assign(el.style, { left: `${R.x + h.x * R.sf}px`, top: `${R.y + h.y * R.sf}px`, width: `${h.w * R.sf}px`, height: `${h.h * R.sf}px`, borderWidth: `${R.sf < 0.5 ? 3 : 4}px` });
      el.style.opacity = smooth(clamp((src - h.t0) / 0.2)) * smooth(clamp((h.t1 - src) / 0.2));
    }
  }
  hls.slice(used).forEach((el) => { el.style.opacity = 0; });
};
window.stageReady = true;
await window.renderFrame(0);
