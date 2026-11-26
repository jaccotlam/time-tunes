// Gedeelde hulpfuncties voor de video-scripts.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ROOT, STAGE_DIR, TMP, FFMPEG, PUBLIC_URL, FPS } from './config.mjs';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export function ensureDir(dir) { mkdirSync(dir, { recursive: true }); return dir; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start de echte app (scripts/serve.mjs) op een vrije poort. */
export function startServer(port = 8100 + Math.floor(Math.random() * 800)) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '--port', String(port), '--host', '127.0.0.1'],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => {
      if (String(d).includes('draait op')) resolve({ url: `http://127.0.0.1:${port}/`, stop: () => proc.kill() });
    });
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`server gestopt (${code})`)));
  });
}

/** Chromium starten; extern verkeer (fragmenten) via de proxy als HTTPS_PROXY gezet is. */
export function launch(args = []) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    // LocalNetworkAccessChecks uit: de app draait in de opname onder het publieke adres (zie aliasPublic)
    // en moet dan nog steeds de lokale verbindingsserver van "Ieder een eigen telefoon" kunnen bereiken.
    args: ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb',
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights', ...args],
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

/**
 * Serveer video/stage/* onder <app>/__video/* en opnamebestanden onder <app>/__tmp/*.
 * Zo draaien de eigen pagina's op dezelfde origin als de app (en kunnen ze de
 * huisstijl-CSS, het deck en de QR-generator van de app zelf gebruiken) zonder
 * iets aan app/ of de server te veranderen.
 */
export async function serveStage(context) {
  const serve = (prefix, dir) => context.route(`**/${prefix}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.split(`/${prefix}/`)[1] || '');
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'niet gevonden' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await serve('__video', normalize(STAGE_DIR));
  await serve('__tmp', normalize(ensureDir(TMP)));
}

/**
 * Laat een browsercontext de lokale app zien onder het publieke adres (PUBLIC_URL). De bestanden
 * komen van de lokale server; er gaat niets naar de echte site. Zo staan in de video het echte
 * adres in de lobby, in de QR-codes en op het printscherm, en geen "127.0.0.1:8123".
 */
export async function aliasPublic(context, server) {
  const origin = new URL(PUBLIC_URL).origin;
  await context.route(`${origin}/**`, async (route) => {
    const url = route.request().url().split('#')[0];
    if (!url.startsWith(PUBLIC_URL)) return route.fulfill({ status: 404, body: 'niet gevonden' });
    try {
      const res = await fetch(server.url + url.slice(PUBLIC_URL.length));
      return await route.fulfill({ status: res.status, contentType: res.headers.get('content-type') || undefined, body: Buffer.from(await res.arrayBuffer()) });
    } catch { return route.abort().catch(() => {}); }
  });
  return PUBLIC_URL;
}

/**
 * Neem een pagina op als verliesvrije PNG-frames op ware pixelgrootte (viewport x deviceScaleFactor).
 * De CDP-screencast meldt alleen dát er iets veranderd is (zijn eigen beelden zijn altijd 1 CSS-px
 * per pixel en dus niet scherp op 1.1x of 0.9x); het beeld zelf komt van Page.captureScreenshot.
 * `now()` geeft de opnametijd in seconden. Geeft { frames: [[t, bestand]], pause, resume, setMode, stop }.
 *
 * setMode('cast') schakelt tijdelijk over op de beelden van de screencast zelf (PNG, 1 CSS-px per
 * pixel, het decor rekt ze op). Dat is voor het scanscherm: daar is de pagina zo druk met de camera
 * dat een screenshot 0,1 s kost (9 beelden per seconde), terwijl de screencast de 30 wel haalt.
 */
export async function capturePage(page, dir, prefix, now, { castFormat = 'png' } = {}) {
  ensureDir(dir);
  const cdp = await page.context().newCDPSession(page);
  const frames = []; const writes = [];
  let busy = false; let dirty = false; let active = true; let stopped = false; let lastData = ''; let lastT = -1; let error = null;
  let mode = 'shot'; let pending = null; let timer = null;
  const keep = (t, data) => {
    const name = `${prefix}${String(frames.length).padStart(6, '0')}.${mode === 'cast' && castFormat === 'jpeg' ? 'jpg' : 'png'}`;
    frames.push([Number(t.toFixed(4)), name]);
    writes.push(writeFile(join(dir, name), Buffer.from(data, 'base64')));
    lastT = t;
  };
  async function grab() {
    if (stopped || !active || mode !== 'shot') return;
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      do {
        dirty = false;
        const wait = lastT + 1 / FPS - 0.003 - now();
        if (wait > 0) await sleep(wait * 1000);
        if (stopped || !active || mode !== 'shot') break;
        const t = now();
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        if (mode !== 'shot') break; // intussen overgeschakeld: dit beeld is al ingehaald
        lastT = t;
        if (data !== lastData) { lastData = data; keep(t, data); }
      } while (dirty && !stopped && active);
    } catch (e) { if (!stopped) error = e; } finally { busy = false; }
  }
  cdp.on('Page.screencastFrame', (ev) => {
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    if (mode === 'shot') { grab(); return; }
    if (stopped || !active) return;
    // 'cast': bewaar het beeld van de screencast zelf, hoogstens 30 per seconde, en altijd het laatste van een beweging
    const t = now();
    clearTimeout(timer);
    if (t - lastT >= 1 / FPS - 0.004) { pending = null; keep(t, ev.data); } else {
      pending = [t, ev.data];
      timer = setTimeout(() => { if (pending && mode === 'cast' && !stopped) keep(...pending); pending = null; }, 45);
    }
  });
  const cast = (m) => cdp.send('Page.startScreencast', m === 'cast' ? { format: castFormat, ...(castFormat === 'jpeg' ? { quality: 92 } : {}), everyNthFrame: 1 } : { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  await cast(mode);
  await grab();
  return {
    frames,
    pause() { active = false; },
    resume() { active = true; grab(); },
    async setMode(m) {
      if (m === mode || stopped) return;
      clearTimeout(timer); pending = null;
      mode = m;
      lastData = '';
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cast(m);
      grab();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(writes);
      if (error) throw error;
    },
  };
}

export function ffmpeg(args, opts = {}) {
  return execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

/** ffmpeg dat PNG/JPEG-frames via stdin krijgt. */
export function ffmpegPipe(args) {
  const proc = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stopte met code ${code}`))));
  });
  const write = (buf) => new Promise((resolve, reject) => {
    proc.stdin.write(buf, (err) => (err ? reject(err) : resolve()));
  });
  const end = () => { proc.stdin.end(); return done; };
  return { write, end };
}
