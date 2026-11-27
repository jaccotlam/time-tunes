// Discobal: a 3D mirror ball on a 2D canvas that "lands" on a round category.
// Self-contained ES module, no dependencies, no external assets.
//
//   const ball = createDiscoBall(containerEl, { categories, size: 'auto', onLand, onPhase, turnWhenLanded });
//   ball.idle();                                  // slow rotation, all colours drifting
//   await ball.spinTo('artist', { duration });    // resolves true when landed, false if superseded
//   ball.show('artist');                          // landed state at once (no onLand, no pulse)
//   ball.destroy();
//
// Rendering: ~500 square facets in latitude rings, rotated about the vertical axis with a fixed
// tilt and perspective, back-face culled. Each facet is shaded as a flat mirror: its reflection
// vector samples a dark room with a few white spotlights (sharp glints) and four coloured lamps.
// Light spots on the back wall are beams reflected off the ball, so they sweep as it turns.

const TAU = Math.PI * 2;
const RINGS = 20;            // latitude rings -> ~510 facets, ~250 visible
const GAP = 0.13;            // grout between tiles, as a fraction of a tile
const TILT = 0.27;           // rad, camera looks slightly down on the ball
const CAM = 5;               // camera distance in ball radii
const BALL_R = 0.335;        // ball radius as a fraction of the canvas side
const LAND_ANGLE = 0.61;     // rotation the ball always comes to rest at (deterministic landing)
const IDLE_SPEED = 0.32;     // rad/s
const LANDED_SPEED = 0.2;    // rad/s, only with options.turnWhenLanded
const WINDUP_MS = 250;       // ease-in to full speed at the start of a spin
const SLOW_FRAME_MS = 22;    // adaptive resolution steps down above this (smoothed) frame time
const SPOTS = 84;
const MAX_GLINTS = 72;
const PULSE_MS = 950;

const DEFAULT_CATEGORIES = [
  { key: 'exact', label: 'Exact jaar', color: '#4fb3ff' },
  { key: 'artist', label: 'Artiest / band', color: '#ff5fa8' },
  { key: 'year', label: 'Jaartal (±2)', color: '#ffc649' },
  { key: 'title', label: 'Titel', color: '#2ed3c0' },
];

// White spotlights in the room (world directions + strength) and four coloured lamps.
const WHITE_LIGHTS = [
  [-0.42, 0.52, 0.74, 1.0], [0.50, 0.30, 0.81, 0.85], [0.08, -0.33, 0.94, 0.6],
  [-0.70, -0.22, 0.68, 0.6], [0.80, -0.38, 0.46, 0.55], [-0.12, 0.86, 0.50, 0.7],
  [0.30, 0.04, 0.95, 0.5], [-0.35, 0.10, 0.93, 0.45], [0.36, 0.62, 0.70, 0.6], [-0.55, 0.30, 0.78, 0.5],
  [0.20, -0.60, 0.77, 0.5], [0.62, -0.10, 0.78, 0.45],
];
// lamps k and k+4 share a colour (k = 0..3); the first four also light the room glow
const LAMPS = [[0.60, 0.50, 0.62], [-0.64, 0.44, 0.63], [-0.52, -0.54, 0.66], [0.56, -0.52, 0.64],
  [-0.05, -0.78, 0.62], [0.82, 0.05, 0.57], [0.02, 0.80, 0.60], [-0.84, -0.04, 0.54]];
const NL = LAMPS.length;
const WHITE_COS = Math.cos(12.5 * Math.PI / 180);
const LAMP_COS = Math.cos(36 * Math.PI / 180);

function parseHex(hex) {
  let h = String(hex || '#ffffff').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const css = (rgb, a = 1) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------- geometry (built once, unit sphere, deterministic) ----------
function buildFacets() {
  const rnd = mulberry32(0x0d15c0);
  const corners = []; const normals = []; const jitter = []; const tone = [];
  const dLat = Math.PI / RINGS;
  for (let ring = 0; ring < RINGS; ring++) {
    const lat0 = -Math.PI / 2 + ring * dLat;
    const latC = lat0 + dLat / 2;
    const count = Math.max(3, Math.round((TAU * Math.cos(latC)) / dLat));
    const dLon = TAU / count;
    const lonOff = rnd() * dLon;
    const la = lat0 + dLat * GAP * 0.5, lb = lat0 + dLat * (1 - GAP * 0.5);
    for (let k = 0; k < count; k++) {
      const lon0 = lonOff + k * dLon;
      const oa = lon0 + dLon * GAP * 0.5, ob = lon0 + dLon * (1 - GAP * 0.5);
      for (const [lat, lon] of [[la, oa], [la, ob], [lb, ob], [lb, oa]]) {
        corners.push(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      }
      const lonC = lon0 + dLon / 2;
      const n = [Math.cos(latC) * Math.sin(lonC), Math.sin(latC), Math.cos(latC) * Math.cos(lonC)];
      normals.push(n[0], n[1], n[2]);
      // real mirror balls have slightly misaligned tiles: that is what makes them sparkle
      const j = norm3([n[0] + (rnd() - 0.5) * 0.16, n[1] + (rnd() - 0.5) * 0.16, n[2] + (rnd() - 0.5) * 0.16]);
      jitter.push(j[0], j[1], j[2]);
      tone.push(rnd());
    }
  }
  return {
    count: tone.length,
    corners: new Float32Array(corners), normals: new Float32Array(normals),
    jitter: new Float32Array(jitter), tone: new Float32Array(tone),
  };
}

function buildSpots() {
  const rnd = mulberry32(0x5b075);
  const dir = new Float32Array(SPOTS * 3); const size = new Float32Array(SPOTS); const src = new Uint8Array(SPOTS);
  for (let i = 0; i < SPOTS; i++) {
    const lon = rnd() * TAU; const y = (rnd() * 2 - 1) * 0.58; const c = Math.sqrt(1 - y * y);
    dir[i * 3] = c * Math.sin(lon); dir[i * 3 + 1] = y; dir[i * 3 + 2] = c * Math.cos(lon);
    size[i] = 0.65 + rnd() * 0.7;
    src[i] = i % 5; // 0 = white spotlight, 1..4 = coloured lamp (colour group)
  }
  return { dir, size, src };
}

const GEO = buildFacets();
const SPOT_GEO = buildSpots();
const WL = WHITE_LIGHTS.map((l) => [...norm3(l), l[3]]);
const LP = LAMPS.map(norm3);

export function createDiscoBall(container, options = {}) {
  const cats = (options.categories && options.categories.length ? options.categories : DEFAULT_CATEGORIES)
    .map((c) => ({ key: c.key, label: c.label || c.key, color: c.color, rgb: parseHex(c.color) }));
  const NC = cats.length;
  const sizeOpt = options.size == null ? 'auto' : options.size;
  const onLand = typeof options.onLand === 'function' ? options.onLand : null;
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
  const turnWhenLanded = !!options.turnWhenLanded;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Discobal');
  canvas.style.display = 'block';
  canvas.style.maxWidth = '100%';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // ---------- state ----------
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(mq && mq.matches);
  let mode = 'idle';           // 'idle' | 'spin' | 'landed'
  let theta = reduced ? LAND_ANGLE : 0.2;
  let omega = 0;               // current angular speed (for motion streaks)
  let q = 0;                   // colour-cycle position of the lamps
  let target = -1, s = 0;      // landed category and its weight (0..1)
  let prev = -1, h = 0, h0 = 0, hT0 = 0; // previous solid colour fading out
  let spin = null;             // { t0, T, th0, dTh, resolve, timer, key }
  let pulseT0 = -1e9;
  let lastT = 0, raf = 0, destroyed = false;
  let learnedCap = 2;          // adaptive pixel-ratio cap (2 -> 1.5 -> 1), never raised again
  let prevFrameT = 0, frameEma = 0, slowFrames = 0;
  let pageVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  let onScreen = true;

  // per-frame colour buffers (preallocated)
  const lampW = new Float32Array(NL * NC);     // final category weights per lamp
  const lampRGB = new Float32Array(NL * 3);
  const keyW = new Float32Array(NC + 1);      // [white, cat0..]
  const keyRGB = new Float32Array(3);
  const ambRGB = new Float32Array(3);
  const glints = new Float32Array(MAX_GLINTS * 3);
  const colorCache = new Array(1 << 18);

  // ---------- sizing & sprites ----------
  let S = 0, dpr = 1, cssSize = 0, R = 0, cx = 0, cy = 0;
  let sprites = null;
  let BS = 0;
  const bg = document.createElement('canvas');
  const bctx = bg.getContext('2d');

  function makeCanvas(w, hgt) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(hgt || w)); return c; }

  function buildSprites() {
    const white = [1, 1, 0.96];
    const palette = [white, ...cats.map((c) => c.rgb)];
    // glints: four-ray star with a hot core
    const G = 96;
    const glint = palette.map((col, i) => {
      const c = makeCanvas(G); const g = c.getContext('2d'); const m = G / 2;
      const core = i === 0 ? white : mix(col, white, 0.45);
      let gr = g.createRadialGradient(m, m, 0, m, m, m * 0.5);
      gr.addColorStop(0, css(white, 1)); gr.addColorStop(0.18, css(core, 0.95));
      gr.addColorStop(0.5, css(col, 0.35)); gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr; g.fillRect(0, 0, G, G);
      const ray = (ang, len, wid) => {
        g.save(); g.translate(m, m); g.rotate(ang);
        const lg = g.createLinearGradient(-len, 0, len, 0);
        lg.addColorStop(0, css(col, 0)); lg.addColorStop(0.5, css(core, 0.95)); lg.addColorStop(1, css(col, 0));
        g.fillStyle = lg; g.beginPath();
        g.moveTo(-len, 0); g.lineTo(0, -wid); g.lineTo(len, 0); g.lineTo(0, wid); g.closePath(); g.fill();
        g.restore();
      };
      ray(0, m, G * 0.035); ray(Math.PI / 2, m, G * 0.035);
      ray(Math.PI / 4, m * 0.45, G * 0.02); ray(-Math.PI / 4, m * 0.45, G * 0.02);
      return c;
    });
    // light spots on the wall: soft-edged discs
    const P = 64;
    const spot = palette.map((col) => {
      const c = makeCanvas(P); const g = c.getContext('2d'); const m = P / 2;
      const gr = g.createRadialGradient(m, m, 0, m, m, m);
      gr.addColorStop(0, css(mix(col, white, 0.5), 0.95)); gr.addColorStop(0.3, css(mix(col, white, 0.15), 0.85));
      gr.addColorStop(0.55, css(col, 0.55)); gr.addColorStop(0.68, css(col, 0.12)); gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr; g.fillRect(0, 0, P, P);
      return c;
    });
    // coloured room glow around the ball
    const GR = Math.ceil(R * 1.5);
    const glow = palette.map((col) => {
      const c = makeCanvas(GR * 2); const g = c.getContext('2d');
      const gr = g.createRadialGradient(GR, GR, 0, GR, GR, GR);
      gr.addColorStop(0, css(col, 0.55)); gr.addColorStop(0.45, css(col, 0.3));
      gr.addColorStop(0.72, css(col, 0.09)); gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr; g.fillRect(0, 0, GR * 2, GR * 2);
      return c;
    });
    // sphere overlay: darker rim (the mirror reflects the dark room at grazing angles) + faint sheen
    const ra = R * CAM / Math.sqrt(CAM * CAM - 1);
    const OS = Math.ceil(ra * 2 + 4);
    const over = makeCanvas(OS); {
      const g = over.getContext('2d'); const m = OS / 2;
      let gr = g.createRadialGradient(m - ra * 0.12, m - ra * 0.18, ra * 0.35, m, m, ra);
      gr.addColorStop(0, 'rgba(10,4,20,0)'); gr.addColorStop(0.8, 'rgba(10,4,20,0.06)');
      gr.addColorStop(0.95, 'rgba(8,3,16,0.28)'); gr.addColorStop(1, 'rgba(6,2,12,0.45)');
      g.fillStyle = gr; g.beginPath(); g.arc(m, m, ra, 0, TAU); g.fill();
      gr = g.createRadialGradient(m - ra * 0.38, m - ra * 0.45, 0, m - ra * 0.38, m - ra * 0.45, ra * 0.6);
      gr.addColorStop(0, 'rgba(255,250,255,0.13)'); gr.addColorStop(1, 'rgba(255,250,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(m, m, ra, 0, TAU); g.fill();
    }
    // hanging cap (fixed: rotation is about the vertical axis)
    const capW = R * 0.2, capH = R * 0.13;
    const cap = makeCanvas(capW * 1.3 + 4, capH * 2.2 + 4); {
      const g = cap.getContext('2d'); const m = cap.width / 2; const top = 2 + capH * 0.25;
      let lg = g.createLinearGradient(m - capW / 2, 0, m + capW / 2, 0);
      lg.addColorStop(0, '#3b3346'); lg.addColorStop(0.3, '#e9e2f2'); lg.addColorStop(0.55, '#8d839c'); lg.addColorStop(1, '#2a2233');
      g.fillStyle = lg;
      g.beginPath();
      g.moveTo(m - capW * 0.32, top); g.lineTo(m + capW * 0.32, top);
      g.lineTo(m + capW * 0.5, top + capH); g.ellipse(m, top + capH, capW * 0.5, capH * 0.32, 0, 0, Math.PI);
      g.lineTo(m - capW * 0.32, top); g.closePath(); g.fill();
      g.fillStyle = '#d8d0e4'; g.beginPath(); g.ellipse(m, top, capW * 0.32, capH * 0.16, 0, 0, TAU); g.fill();
      // ring
      g.strokeStyle = '#cfc6dc'; g.lineWidth = Math.max(1, capW * 0.07);
      g.beginPath(); g.ellipse(m, top - capH * 0.35, capW * 0.12, capH * 0.32, 0, 0, TAU); g.stroke();
    }
    // soft round mask so glow and spots never show the square canvas edge
    const mask = makeCanvas(BS); {
      const g = mask.getContext('2d'); const m = BS / 2;
      const gr = g.createRadialGradient(m, m, BS * 0.34, m, m, BS * 0.5);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, BS, BS);
    }
    sprites = { mask, glint, spot, glow, over, overSize: OS, ra, cap, capH, white, colorCss: cats.map((c) => css(c.rgb, 1)) };
  }

  function measure() {
    let w = typeof sizeOpt === 'number' ? sizeOpt : container.clientWidth;
    if (!w || w < 40) w = 260;
    w = Math.round(w);
    const d = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1, resCap());
    if (w === cssSize && d === dpr && sprites) return false;
    cssSize = w; dpr = d;
    S = Math.round(w * dpr);
    canvas.width = S; canvas.height = S;
    canvas.style.width = w + 'px'; canvas.style.height = w + 'px';
    R = S * BALL_R; cx = S / 2; cy = S * 0.545;
    BS = Math.min(S, 300);
    bg.width = BS; bg.height = BS;
    buildSprites();
    return true;
  }

  const landedTurning = () => turnWhenLanded && !reduced;
  // a frozen landed ball is a single frame: always draw it at full resolution (deterministic look)
  function resCap() {
    if (mode === 'landed' && !landedTurning() && !animating(performance.now())) return 2;
    return learnedCap;
  }

  // ---------- colour state ----------
  function updateColours() {
    // cycling weights per lamp (each lamp a different colour, crossfading to the next)
    const sH = 1 - s, keepCycle = sH * (1 - h), keepPrev = sH * h;
    for (let k = 0; k < NL; k++) {
      const pos = q + (k % 4) * (NC / 4);
      const fl = Math.floor(pos);
      const f = smooth(0.55, 1, pos - fl);
      const i0 = ((fl % NC) + NC) % NC, i1 = (i0 + 1) % NC;
      let r = 0, g = 0, b = 0;
      for (let c = 0; c < NC; c++) {
        let w = 0;
        if (c === i0) w += (1 - f) * keepCycle;
        if (c === i1) w += f * keepCycle;
        if (c === prev) w += keepPrev;
        if (c === target) w += s;
        lampW[k * NC + c] = w;
        const col = cats[c].rgb; r += col[0] * w; g += col[1] * w; b += col[2] * w;
      }
      lampRGB[k * 3] = r; lampRGB[k * 3 + 1] = g; lampRGB[k * 3 + 2] = b;
    }
    // white spotlights take on the landed colour (kept light so glints still read as glints)
    keyW[0] = keepCycle;
    let r = keepCycle, g = keepCycle, b = keepCycle * 0.96;
    for (let c = 0; c < NC; c++) {
      let w = 0;
      if (c === prev) w += keepPrev;
      if (c === target) w += s;
      keyW[c + 1] = w;
      const col = cats[c].rgb;
      r += (col[0] * 0.7 + 0.3) * w; g += (col[1] * 0.7 + 0.3) * w; b += (col[2] * 0.7 + 0.3) * w;
    }
    keyRGB[0] = r; keyRGB[1] = g; keyRGB[2] = b;
    ambRGB[0] = (lampRGB[0] + lampRGB[3] + lampRGB[6] + lampRGB[9]) / 4;
    ambRGB[1] = (lampRGB[1] + lampRGB[4] + lampRGB[7] + lampRGB[10]) / 4;
    ambRGB[2] = (lampRGB[2] + lampRGB[5] + lampRGB[8] + lampRGB[11]) / 4; // lamps 4..7 repeat 0..3
  }

  function fill(r, g, b) {
    const ri = r >= 1 ? 63 : r <= 0 ? 0 : (r * 63 + 0.5) | 0;
    const gi = g >= 1 ? 63 : g <= 0 ? 0 : (g * 63 + 0.5) | 0;
    const bi = b >= 1 ? 63 : b <= 0 ? 0 : (b * 63 + 0.5) | 0;
    const key = (ri << 12) | (gi << 6) | bi;
    let str = colorCache[key];
    if (str === undefined) {
      str = 'rgb(' + ((ri * 255 / 63) | 0) + ',' + ((gi * 255 / 63) | 0) + ',' + ((bi * 255 / 63) | 0) + ')';
      colorCache[key] = str;
    }
    return str;
  }

  // ---------- render ----------
  function render(now) {
    if (!S) return;
    updateColours();
    const pe = now - pulseT0;
    const pulse = pe >= 0 && pe < PULSE_MS * 1.6 ? Math.exp(-pe / 260) : 0;
    const bright = 1 + pulse * 0.55;
    const ct = Math.cos(theta), st = Math.sin(theta), ca = Math.cos(TILT), sa = Math.sin(TILT);
    const blur = Math.min(3.2, Math.abs(omega) * 0.16);
    const sp = sprites;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // glow + wall spots go to a low-resolution layer (they are soft anyway): far less fill work
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
    bctx.globalAlpha = 1;
    bctx.clearRect(0, 0, BS, BS);
    bctx.setTransform(BS / S, 0, 0, BS / S, 0, 0);

    // room glow, one blob per lamp on its side of the ball
    bctx.globalCompositeOperation = 'lighter';
    const GRr = sp.glow[1].width / 2;
    const glowA = (0.7 + 0.35 * s) * (1 + pulse * 0.9);
    for (let k = 0; k < 4; k++) {
      const gx = cx + LP[k][0] * R * 0.32 - GRr, gy = cy - LP[k][1] * R * 0.32 - GRr;
      for (let c = 0; c < NC; c++) {
        const w = lampW[k * NC + c];
        if (w < 0.01) continue;
        bctx.globalAlpha = Math.min(1, w * glowA);
        bctx.drawImage(sp.glow[c + 1], gx, gy);
      }
    }

    // light spots on the back wall (reflected beams, they sweep with the rotation)
    const half = S / 2;
    bctx.globalCompositeOperation = 'source-over'; // additive overlaps would wash spots out to white
    const dir = SPOT_GEO.dir;
    for (let i = 0; i < SPOTS; i++) {
      const x = dir[i * 3], y = dir[i * 3 + 1], z = dir[i * 3 + 2];
      const x1 = x * ct + z * st, z1 = -x * st + z * ct;
      const y2 = y * ca - z1 * sa, z2 = y * sa + z1 * ca;
      if (z2 > 0.12) continue;
      // beams leaving the back of the ball land on the walls of the room around it; the polar
      // mapping squeezes the room into the square so the spots ring the ball instead of hiding
      const phi = Math.acos(-z2);           // angle away from straight behind the ball
      const sinPhi = Math.sqrt(x1 * x1 + y2 * y2) || 1e-6;
      const rho = R * (0.82 + 0.85 * phi / (Math.PI / 2)) / sinPhi;
      const px = cx + x1 * rho, py = cy - y2 * rho;
      const dx = (px - half) / half, dy = (py - half) / half;
      if (dx * dx + dy * dy >= 1) continue;
      const fade = smooth(0.12, -0.05, z2);
      const base = R * 0.13 * SPOT_GEO.size[i];
      const obl = phi / (Math.PI / 2);
      const w = base * (1 + obl * Math.abs(x1 / sinPhi) * 0.7) * (1 + blur * 0.9);
      const hh = base * (1 + obl * Math.abs(y2 / sinPhi) * 0.7);
      const srcI = SPOT_GEO.src[i];
      const a = fade * 0.75 * (1 + pulse * 0.6) / (1 + blur * 0.5);
      if (srcI === 0) {
        for (let c = 0; c <= NC; c++) {
          const ww = keyW[c]; if (ww < 0.01) continue;
          bctx.globalAlpha = Math.min(1, ww * a * 0.8);
          bctx.drawImage(sp.spot[c], px - w / 2, py - hh / 2, w, hh);
        }
      } else {
        const k = srcI - 1;
        for (let c = 0; c < NC; c++) {
          const ww = lampW[k * NC + c]; if (ww < 0.01) continue;
          bctx.globalAlpha = Math.min(1, ww * a);
          bctx.drawImage(sp.spot[c + 1], px - w / 2, py - hh / 2, w, hh);
        }
      }
    }

    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'destination-in';
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.drawImage(sp.mask, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(bg, 0, 0, S, S);

    // string
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const poleK = CAM / (CAM - sa);
    const poleY = cy - ca * R * poleK;
    ctx.strokeStyle = 'rgba(255,244,230,0.32)';
    ctx.lineWidth = Math.max(1, dpr * 1.1);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, poleY); ctx.stroke();

    // grout / ball body
    const ra = sp.ra;
    ctx.fillStyle = '#07030d';
    ctx.beginPath(); ctx.arc(cx, cy, ra * 0.997, 0, TAU); ctx.fill();

    // facets
    const N = GEO.count, nrm = GEO.normals, jit = GEO.jitter, cor = GEO.corners, tone = GEO.tone;
    const minZ = 1 / CAM + 0.004;
    const tintW = 0.28 + 0.5 * s;
    const silR = 0.80 * (1 - tintW) + ambRGB[0] * tintW;
    const silG = 0.77 * (1 - tintW) + ambRGB[1] * tintW;
    const silB = 0.93 * (1 - tintW) + ambRGB[2] * tintW;
    let gc = 0;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const nx = nrm[i3], ny = nrm[i3 + 1], nz = nrm[i3 + 2];
      const z1 = -nx * st + nz * ct;
      const wz = ny * sa + z1 * ca;
      if (wz < minZ) continue;
      const wx = nx * ct + nz * st;
      const wy = ny * ca - z1 * sa;
      // view vector from facet centre to camera
      let vx = -wx, vy = -wy, vz = CAM - wz;
      const vl = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx *= vl; vy *= vl; vz *= vl;
      // jittered tile normal in world space
      const jx = jit[i3], jy = jit[i3 + 1], jz = jit[i3 + 2];
      const jz1 = -jx * st + jz * ct;
      const mx = jx * ct + jz * st, my = jy * ca - jz1 * sa, mz = jy * sa + jz1 * ca;
      const d2 = 2 * (mx * vx + my * vy + mz * vz);
      const rx = d2 * mx - vx, ry = d2 * my - vy, rz = d2 * mz - vz;

      // dark room: a dim band where the lit walls are, darker ceiling, darker behind the ball
      const hb = ry + 0.1;
      const tn = tone[i];
      const room = Math.sin(rx * 7.3 + ry * 4.1 + 1.3) * Math.sin(ry * 6.2 - rz * 3.7 + rx * 1.9);
      // chrome: tiles facing the viewer reflect the (dimly lit) room behind the camera
      const face = wz * wz;
      let env = 0.1 + 0.24 * face + 0.3 / (1 + hb * hb * 22) * (0.4 + 0.6 * (rz > 0 ? rz : 0))
        + (room > 0 ? room * room * 0.24 : 0) + tn * tn * tn * 0.32;
      if (ry > 0.5) env *= 0.78;
      let r = env * silR, g = env * silG, b = env * silB;
      // rim light: grazing tiles catch a back light in the key colour
      const edge = 1 - wz;
      if (edge > 0.45) {
        const e = (edge - 0.45) / 0.55, rl = e * e * (0.25 + 0.55 * tn);
        r += keyRGB[0] * rl * 0.75 + ambRGB[0] * rl * 0.5;
        g += keyRGB[1] * rl * 0.75 + ambRGB[1] * rl * 0.5;
        b += keyRGB[2] * rl * 0.75 + ambRGB[2] * rl * 0.5;
      }

      // coloured lamps: the strongest one sets the tile colour, the others only add a little
      // (summing them all would wash overlapping colours out to white)
      let best = 0, bk = -1, lr = 0, lg = 0, lb = 0;
      for (let k = 0; k < NL; k++) {
        const L = LP[k];
        let t = (rx * L[0] + ry * L[1] + rz * L[2] - LAMP_COS) / (1 - LAMP_COS);
        if (t <= 0) continue;
        t = t * (2 - t) * (0.2 + 0.85 * ((tn * 7.31 + k * 0.37) % 1));
        lr += lampRGB[k * 3] * t; lg += lampRGB[k * 3 + 1] * t; lb += lampRGB[k * 3 + 2] * t;
        if (t > best) { best = t; bk = k; }
      }
      if (bk >= 0) {
        const o = bk * 3, rest = 0.22;
        r += lampRGB[o] * best * (1 - rest) + lr * rest;
        g += lampRGB[o + 1] * best * (1 - rest) + lg * rest;
        b += lampRGB[o + 2] * best * (1 - rest) + lb * rest;
      }
      let spec = 0;
      for (let k = 0; k < WL.length; k++) {
        const L = WL[k];
        const t = (rx * L[0] + ry * L[1] + rz * L[2] - WHITE_COS) / (1 - WHITE_COS);
        if (t <= 0) continue;
        const v = t * t * L[3];
        spec += v;
      }
      if (spec > 0) {
        const sv = spec * 1.7;
        r += keyRGB[0] * sv; g += keyRGB[1] * sv; b += keyRGB[2] * sv;
      }
      r *= bright; g *= bright; b *= bright;

      // project the four corners
      ctx.fillStyle = fill(r, g, b);
      ctx.beginPath();
      const c12 = i * 12;
      for (let v = 0; v < 4; v++) {
        const o = c12 + v * 3;
        const x = cor[o], y = cor[o + 1], z = cor[o + 2];
        const cz1 = -x * st + z * ct;
        const px = x * ct + z * st, py = y * ca - cz1 * sa, pz = y * sa + cz1 * ca;
        const k = R * CAM / (CAM - pz);
        if (v === 0) ctx.moveTo(cx + px * k, cy - py * k); else ctx.lineTo(cx + px * k, cy - py * k);
      }
      ctx.fill();

      if (spec > 0.22 && gc < MAX_GLINTS) {
        const k = R * CAM / (CAM - wz);
        glints[gc * 3] = cx + wx * k; glints[gc * 3 + 1] = cy - wy * k;
        glints[gc * 3 + 2] = (spec > 1.4 ? 1.4 : spec) * (0.4 + 0.6 * wz);
        gc++;
      }
    }

    // rim shading + sheen
    ctx.drawImage(sp.over, cx - sp.overSize / 2, cy - sp.overSize / 2);
    // cap on top
    ctx.drawImage(sp.cap, cx - sp.cap.width / 2, poleY - sp.capH * 0.25 - 2 - sp.capH * 0.55);

    // glints (sharp stars that twinkle as tiles pass through a spotlight)
    ctx.globalCompositeOperation = 'lighter';
    for (let g = 0; g < gc; g++) {
      const x = glints[g * 3], y = glints[g * 3 + 1], v = glints[g * 3 + 2];
      const sz = R * (0.2 + 0.5 * v) * (1 + pulse * 0.5);
      const w = sz * (1 + blur), hh = sz / (1 + blur * 0.35);
      const a = Math.min(1, 0.45 + v * 0.8);
      for (let c = 0; c <= NC; c++) {
        const ww = keyW[c]; if (ww < 0.01) continue;
        ctx.globalAlpha = ww * a;
        ctx.drawImage(sp.glint[c], x - w / 2, y - hh / 2, w, hh);
      }
    }

    // landed pulse ring
    if (pulse > 0 && target >= 0 && pe < PULSE_MS) {
      const p = pe / PULSE_MS;
      const e = 1 - (1 - p) * (1 - p) * (1 - p);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = sp.colorCss[target];
      const rr = reduced ? ra * 1.03 : ra * (1.02 + 0.42 * e);
      ctx.globalAlpha = 0.75 * (1 - p) * (1 - p);
      ctx.lineWidth = Math.max(1.5, R * 0.05 * (1 - p) + dpr);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 0.3 * (1 - p);
      ctx.lineWidth = R * 0.16 * (1 - p);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------- animation loop ----------
  function animating(now) {
    if (mode === 'spin') return true;
    if (mode === 'idle' && !reduced) return true;
    if (mode === 'landed' && landedTurning()) return true;
    if (h > 0) return true;
    return now - pulseT0 < PULSE_MS * 1.6;
  }

  function step(now) {
    let dt = (now - lastT) / 1000; lastT = now;
    if (!(dt > 0)) dt = 0; if (dt > 0.1) dt = 0.1;
    if (h0 > 0) {
      h = h0 * (1 - smooth(0, 1, (now - hT0) / 650));
      if (h <= 0.001) { h = 0; h0 = 0; prev = -1; }
    }
    if (mode === 'spin' && spin) {
      const p = clamp01((now - spin.t0) / spin.T);
      // velocity: smoothstep ramp up over the wind-up, then quadratic decay to rest at p = 1
      const a = spin.a;
      let pos, vel;
      if (p < a) {
        const x = p / a;
        pos = a * (x * x * x - 0.5 * x * x * x * x); vel = x * x * (3 - 2 * x);
      } else {
        const y = (1 - p) / (1 - a);
        pos = a / 2 + (1 - a) / 3 * (1 - y * y * y); vel = y * y;
      }
      const I = a / 2 + (1 - a) / 3;
      const nt = spin.th0 + spin.dTh * (p >= 1 ? 1 : pos / I);
      omega = reduced ? 0 : (spin.dTh * vel / I) / (spin.T / 1000);
      q += reduced ? 0 : (nt - theta) / Math.PI;
      theta = nt;
      s = reduced ? smooth(0, 1, p) : smooth(0.42, 0.93, p);
      if (p >= 1) land(now);
    } else if (mode === 'idle') {
      omega = reduced ? 0 : IDLE_SPEED;
      if (!reduced) { theta = (theta + IDLE_SPEED * dt) % TAU; q += dt * 0.22; }
    } else if (mode === 'landed' && landedTurning()) {
      omega = LANDED_SPEED;
      theta = (theta + LANDED_SPEED * dt) % TAU;
    } else {
      omega = 0;
    }
  }

  function frame(now) {
    raf = 0;
    if (destroyed) return;
    step(now);
    // adaptive resolution: smoothed frame time above SLOW_FRAME_MS for ~15 frames -> step down
    if (prevFrameT) {
      const d = now - prevFrameT;
      if (d < 250) {
        frameEma = frameEma ? frameEma * 0.85 + d * 0.15 : d;
        slowFrames = frameEma > SLOW_FRAME_MS ? slowFrames + 1 : 0;
        if (slowFrames >= 15 && dpr > 1) {
          learnedCap = dpr > 1.5 ? 1.5 : 1;
          slowFrames = 0; frameEma = 0;
        }
      }
    }
    prevFrameT = now;
    if (measure()) prevFrameT = 0;   // a resize/rebuild frame is not representative
    render(now);
    if (animating(now)) schedule();
    else if (measure()) render(now);   // back to full resolution for the frozen final frame
  }
  function schedule() {
    if (raf || destroyed || !pageVisible || !onScreen) return;
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    lastT = performance.now();
    prevFrameT = 0;
    if (!raf && pageVisible && onScreen) { measure(); render(lastT); schedule(); }
  }

  function setLabel(text) { canvas.setAttribute('aria-label', text); }
  function phase(name, key) { if (onPhase) { try { onPhase(name, key); } catch (e) { console.error(e); } } }

  function finishSpin(landed) {
    const sp = spin; spin = null;
    if (!sp) return;
    clearTimeout(sp.timer);
    sp.resolve(landed);
  }

  function land(now) {
    if (!spin) return;
    const key = spin.key;
    mode = 'landed';
    theta = LAND_ANGLE; s = 1; h = 0; h0 = 0; prev = -1; omega = 0;
    pulseT0 = now;
    setLabel('Discobal: ' + cats[target].label);
    finishSpin(true);
    phase('landed', key);
    if (onLand) { try { onLand(key); } catch (e) { console.error(e); } }
  }

  // fade whatever solid colour is showing into the new state
  function carryColour(now) {
    if (s > 0.001 && target >= 0) { prev = target; h0 = Math.max(s, h); }
    else if (h > 0.001) { h0 = h; }
    else { h0 = 0; prev = -1; }
    h = h0; hT0 = now; s = 0;
  }

  function indexOf(key) { return cats.findIndex((c) => c.key === key); }

  const api = {
    idle() {
      if (destroyed) return;
      finishSpin(false);
      const now = performance.now();
      if (mode !== 'idle') carryColour(now);
      mode = 'idle';
      setLabel('Discobal draait');
      phase('idle');
      kick();
    },
    spinTo(key, opts = {}) {
      if (destroyed) return Promise.resolve(false);
      const idx = indexOf(key);
      if (idx < 0) return Promise.reject(new Error('Onbekende categorie: ' + key));
      finishSpin(false);
      const now = performance.now();
      carryColour(now);
      target = idx;
      const T = reduced ? 600 : Math.max(800, Number(opts.duration) || 3800);
      let dTh;
      if (reduced) {
        dTh = ((LAND_ANGLE - theta) % TAU + TAU + Math.PI) % TAU - Math.PI; // shortest way, usually 0
      } else {
        const turns = T > 2500 ? 1.6 : 0.9;
        dTh = turns * TAU + (((LAND_ANGLE - theta - turns * TAU) % TAU) + TAU) % TAU;
      }
      mode = 'spin';
      setLabel('Discobal draait…');
      phase('spinning', key);
      return new Promise((resolve) => {
        spin = { t0: now, T, th0: theta, dTh, resolve, key, timer: 0, a: reduced ? 0 : Math.min(0.3, WINDUP_MS / T) };
        const mine = spin;
        // lands even if no frames are rendered (hidden tab, off screen)
        mine.timer = setTimeout(() => {
          if (spin === mine) { land(performance.now()); kick(); }
        }, T + 60);
        kick();
      });
    },
    show(key) {
      if (destroyed) return;
      const idx = indexOf(key);
      if (idx < 0) return;
      finishSpin(false);
      target = idx; s = 1; h = 0; h0 = 0; prev = -1;
      theta = LAND_ANGLE; omega = 0; mode = 'landed'; pulseT0 = -1e9;
      setLabel('Discobal: ' + cats[idx].label);
      phase('landed', key);
      kick();
    },
    destroy() {
      if (destroyed) return;
      finishSpin(false);
      destroyed = true;
      if (raf) cancelAnimationFrame(raf); raf = 0;
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      if (mq) { if (mq.removeEventListener) mq.removeEventListener('change', onMotion); else if (mq.removeListener) mq.removeListener(onMotion); }
      canvas.remove();
    },
    get canvas() { return canvas; },
    get phase() { return mode; },
    get pixelRatio() { return dpr; },   // current internal pixel ratio (adaptive), for diagnostics
  };

  // ---------- environment hooks ----------
  function onResize() { if (measure()) kick(); }
  function onVis() { pageVisible = document.visibilityState !== 'hidden'; if (pageVisible) kick(); }
  function onMotion() { reduced = !!mq.matches; kick(); }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', onMotion); else if (mq.addListener) mq.addListener(onMotion); }
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (onScreen) kick();
    })
    : null;
  if (io) io.observe(canvas);

  measure();
  setLabel('Discobal draait');
  kick();
  return api;
}
