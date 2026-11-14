// Gedeelde hulpfuncties voor de video-scripts.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { ROOT, STAGE_DIR, TMP, FFMPEG } from './config.mjs';

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
      if (String(d).includes('draait op')) resolve({ url: `http://localhost:${port}/`, stop: () => proc.kill() });
    });
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`server gestopt (${code})`)));
  });
}

/** Chromium starten; extern verkeer (fragmenten) via de proxy als HTTPS_PROXY gezet is. */
export function launch(args = []) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', ...args],
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
