// Het decor van de Discobingo-video: een pure functie van de tijd. window.renderFrame(t) zet de juiste
// schermbeelden (uit de opname) in de laptop en de twee telefoons, de ondertitel, de tik-ringen en de kaders.
import { logoSvg } from '../js/ui.js';
import { SCENES, TITLE, END, CATS } from './scenes.js';

const $ = (id) => document.getElementById(id);
const TV = { x: 48 + 14, y: 96 + 14, s: 0.75 };
const PH = { a: { x: 1116 + 12, y: 96 + 12, s: 0.9 }, b: { x: 1516 + 12, y: 96 + 12, s: 0.9 } };
const ORIGIN = { host: TV, a: PH.a, b: PH.b };

const ev = await (await fetch('/__tmp/events.json', { cache: 'no-store' })).json();
$('titlecard').innerHTML = `<div class="logo">${logoSvg('logo')}</div><div class="word">${TITLE.word}</div><p class="tagline">${TITLE.tag}</p><span class="pill">${TITLE.pill}</span>`;
$('endcard').innerHTML = `<div class="logo">${logoSvg('logo')}</div><div class="word">${TITLE.word}</div><p class="endline">${END.line}</p><p class="url">${END.url}</p><span class="pill">${END.pill}</span>`;
$('tag-a').textContent = ev.players[0];
$('tag-b').textContent = ev.players[1];

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
  if (last && last.id === seg.id) { last.o1 = seg.o1; } else scenes.push({ id: seg.id, o0: seg.o0, o1: seg.o1 });
}
window.sceneList = scenes;

const find = (frames, t) => { // laatste beeld met tijd <= t
  let lo = 0; let hi = frames.length - 1; let ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (frames[mid][0] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return frames[ans][1];
};
const smooth = (x) => x * x * (3 - 2 * x);
const clamp = (x) => Math.max(0, Math.min(1, x));
const loaded = {};
async function setImg(key, t) {
  const name = find(ev.frames[key], t);
  if (loaded[key] === name) return;
  const img = $(`img-${key}`);
  img.src = `/__tmp/phone/${key}/${name}`;
  loaded[key] = name;
  try { await img.decode(); } catch { /* beeld ontbreekt: dan blijft het vorige staan */ }
}

const sceneDef = (id) => SCENES.find((s) => s.id === id);
const stepsTotal = SCENES.filter((s) => s.title).length;
function copyHtml(id) {
  const sc = sceneDef(id);
  const step = SCENES.filter((s) => s.title).findIndex((s) => s.id === id) + 1;
  const chips = sc.chips ? `<div class="chips">${CATS.map((c) => `<span class="lg" style="--c:${c.color}"><i></i>${c.label}</span>`).join('')}</div>` : '';
  return `<p class="kicker">Stap ${step} van ${stepsTotal}</p><div class="headrow"><div class="badge">${step}</div><h2 class="ctitle">${sc.title}</h2></div><p class="ccap">${sc.caption}</p>${chips}`;
}
let copyFor = null;

window.renderFrame = async (t) => {
  t = Math.min(t, DURATION - 0.001);
  const seg = timeline.find((s) => t >= s.o0 && t < s.o1) || timeline[timeline.length - 1];
  const scene = scenes.find((s) => s.id === seg.id);
  const isCard = seg.id === 'title' || seg.id === 'end';
  const fade = (a, b) => smooth(clamp((t - a) / 0.35)) * smooth(clamp((b - t) / 0.35));

  // schermen
  const src = seg.r0 != null ? seg.r0 + (t - seg.o0) * seg.speed : null;
  $('devices').style.opacity = isCard ? 0 : 1;
  $('titlecard').style.opacity = seg.id === 'title' ? (t < 0.2 ? 1 : smooth(clamp((seg.o1 - t) / 0.4))) : 0;
  $('endcard').style.opacity = seg.id === 'end' ? smooth(clamp((t - seg.o0) / 0.5)) : 0;
  if (seg.id === 'title') $('titlecard').style.opacity = Math.min(1, smooth(clamp((seg.o1 - t) / 0.4)) + (t < 0.05 ? 1 : 0));
  if (src != null) {
    // het eerste beeld van de rest: neem het laatste beeld van de opname als de tijd erna valt
    await Promise.all(['host', 'a', 'b'].map((k) => setImg(k, src)));
  } else if (seg.id === 'end') {
    await Promise.all(['host', 'a', 'b'].map((k) => setImg(k, ev.duration)));
  } else {
    await Promise.all(['host', 'a', 'b'].map((k) => setImg(k, 0)));
  }

  // ondertitel
  const sc = sceneDef(seg.id);
  const copy = $('copy');
  if (sc && sc.title) {
    if (copyFor !== seg.id) { copy.innerHTML = copyHtml(seg.id); copyFor = seg.id; }
    const next = scenes[scenes.indexOf(scene) + 1];
    const out = next && sceneDef(next.id)?.title ? scene.o1 : scene.o1 + 1; // laatste scène blijft staan
    copy.style.opacity = fade(scene.o0, out);
    copy.style.transform = `translateY(${(1 - smooth(clamp((t - scene.o0) / 0.4))) * 14}px)`;
  } else copy.style.opacity = 0;
  // "Even later…"
  const later = $('later');
  later.style.display = sc?.label ? 'block' : 'none';
  if (sc?.label) { $('later-text').textContent = sc.label; later.style.opacity = fade(scene.o0, scene.o1); }

  // tikken (tijden in opnametijd)
  for (const k of ['host', 'a', 'b']) $(`ring-${k}`).style.opacity = 0;
  if (src != null) {
    for (const tp of ev.taps) {
      const dt = src - tp.t;
      if (dt < -tp.lead || dt > 0.45) continue;
      const O = ORIGIN[tp.dev];
      const ring = $(`ring-${tp.dev}`);
      ring.style.left = `${O.x + tp.x * O.s}px`; ring.style.top = `${O.y + tp.y * O.s}px`;
      const ap = dt < 0 ? 1 - Math.abs(dt) / tp.lead : 1;
      ring.style.opacity = dt < 0 ? smooth(clamp(ap * 2.2)) : clamp(1 - (dt - 0.25) / 0.2);
      const [dot, burst] = ring.children;
      dot.style.transform = `scale(${dt < 0 ? 1.45 - 0.45 * ap : 0.85})`;
      burst.style.opacity = dt >= 0 ? clamp(1 - dt / 0.4) * 0.9 : 0;
      burst.style.transform = `scale(${dt >= 0 ? 0.9 + (dt / 0.4) * 1.3 : 1})`;
    }
  }
  // kaders (er kunnen er meer tegelijk in beeld zijn, bijvoorbeeld om elke telefoon)
  const hls = [...document.querySelectorAll('.hl')];
  let used = 0;
  if (src != null) {
    for (const h of ev.highlights) {
      if (src < h.t0 || src > h.t1) continue;
      const O = ORIGIN[h.dev];
      let el = hls[used];
      if (!el) { el = document.createElement('div'); el.className = 'hl'; $('devices').appendChild(el); hls.push(el); }
      used += 1;
      Object.assign(el.style, { left: `${O.x + h.x * O.s}px`, top: `${O.y + h.y * O.s}px`, width: `${h.w * O.s}px`, height: `${h.h * O.s}px` });
      el.style.opacity = smooth(clamp((src - h.t0) / 0.2)) * smooth(clamp((h.t1 - src) / 0.2));
    }
  }
  hls.slice(used).forEach((el) => { el.style.opacity = 0; });
};
window.stageReady = true;
await window.renderFrame(0);
