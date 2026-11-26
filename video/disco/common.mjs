// Gedeelde hulpjes voor de Discobingo-video: de eigen pagina's serveren en iTunes/geluid nabootsen.
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { DISCO_DIR, TMP } from './config.mjs';
import { ensureDir } from '../lib.mjs';
import { silentWav } from '../../tests/e2e/fake-itunes.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** video/disco/* onder <app>/__disco/*, opnamebestanden onder <app>/__tmp/* (zelfde origin als de app: huisstijl-CSS, ui.js). */
export async function serveDisco(context) {
  const serve = (prefix, dir) => context.route(`**/${prefix}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.split(`/${prefix}/`)[1] || '');
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'niet gevonden' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await serve('__disco', normalize(DISCO_DIR));
  await serve('__tmp', normalize(ensureDir(TMP)));
}

const WAV = silentWav();
/**
 * Geen geluid in de video, dus de muziek mag stilte zijn: de app krijgt voor elk nummer een
 * (stil) fragment en een lookup-antwoord. Zo hangt de opname niet af van iTunes of van het internet.
 * De app doet verder alles zoals normaal: het fragment laadt, speelt en loopt af.
 */
export async function fakeMusic(context) {
  await context.route('https://audio-ssl.itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  await context.route('https://itunes.apple.com/lookup?**', (route) => {
    const id = new URL(route.request().url()).searchParams.get('id') || '0';
    const results = id.split(',').map((x) => ({ wrapperType: 'track', kind: 'song', trackId: Number(x), previewUrl: `https://audio-ssl.itunes.apple.com/fake/${x}.m4a` }));
    return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ resultCount: results.length, results }) });
  });
}
