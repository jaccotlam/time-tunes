#!/usr/bin/env node
// Link every card in app/data/deck.json to a Spotify track (writes the optional `spotifyId`).
// Uses the same matching rules as the app (app/js/spotify-match.js). Node 22, no dependencies.
//
//   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node tools/link-spotify.mjs [options]
//
// Options:
//   --dry-run          only report, do not change deck.json
//   --force            look up cards that already have a spotifyId as well
//   --only 001,042     only these card ids
//   --sure-only        write only sure matches (doubtful ones are reported, not written)
//   --report file.json also write the full report as JSON
//   --deck path        deck file (default app/data/deck.json)
//   --market NL        market for the search (default: the deck's country, else NL)
//   --delay 250        pause between API requests in ms
//
// Uses the Client Credentials flow (client secret needed, so run it on your own computer,
// never in the browser). Keep the secret out of git.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { rankTracks, bestMatch, searchQueries, isSpotifyId, MIN_TITLE, MIN_ARTIST, MIN_SCORE } from '../app/js/spotify-match.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';
const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
if (flag('help') || flag('h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const DRY = flag('dry-run');
const FORCE = flag('force');
const SURE_ONLY = flag('sure-only');
const ONLY = opt('only', '') ? new Set(opt('only', '').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const DECK = resolve(ROOT, opt('deck', 'app/data/deck.json'));
const REPORT = opt('report', '');
const DELAY = Math.max(0, Number(opt('delay', 250)) || 0);

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Zet eerst SPOTIFY_CLIENT_ID en SPOTIFY_CLIENT_SECRET (uit het Spotify-dashboard, Settings).');
  console.error('Voorbeeld: SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node tools/link-spotify.mjs --dry-run');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null;
async function getToken() {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Token aanvragen mislukt (${res.status} ${json.error || ''} ${json.error_description || ''}). Klopt de Client ID/secret?`);
  }
  token = json.access_token;
}

let lastCall = 0;
async function api(path, query) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastCall + DELAY - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    if (!token) await getToken();
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt === 6) throw e;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 401) { token = null; continue; } // expired: new token
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) || 2 ** attempt;
      console.warn(`  429 te veel verzoeken: ${after} s wachten…`);
      await sleep(after * 1000 + 250);
      continue;
    }
    if (res.status >= 500) { await sleep(1000 * attempt); continue; }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status} bij ${path}: ${JSON.stringify(json)}`);
    return json;
  }
  throw new Error(`Opgegeven na herhaalde fouten: ${path}`);
}

const describe = (t) => t && ({
  id: t.id, name: t.name, artists: (t.artists || []).map((a) => a.name).join(', '), album: t.album?.name || '',
});

async function lookup(card, market) {
  let best = null;
  let ranked = [];
  for (const q of searchQueries(card)) {
    const json = await api('/search', { q, type: 'track', limit: 10, market });
    const items = json?.tracks?.items || [];
    const m = bestMatch(card, items);
    const r = rankTracks(card, items);
    if (!ranked.length || (r[0] && r[0].score > ranked[0].score)) ranked = r;
    if (m) { best = m; ranked = r; break; }
  }
  return { best, ranked };
}

async function main() {
  const raw = readFileSync(DECK, 'utf8');
  const deck = JSON.parse(raw);
  const market = opt('market', deck.country || 'NL');
  const cards = (deck.cards || []).filter((c) => !ONLY || ONLY.has(String(c.id)));
  console.log(`${cards.length} kaarten, market ${market}${DRY ? ', dry-run (deck.json blijft ongewijzigd)' : ''}`);

  const report = [];
  let changed = 0;
  for (const card of cards) {
    if (isSpotifyId(card.spotifyId) && !FORCE) {
      report.push({ id: card.id, title: card.title, artist: card.artist, status: 'kept', spotifyId: card.spotifyId });
      continue;
    }
    let result;
    try {
      result = await lookup(card, market);
    } catch (e) {
      console.error(`  ${card.id} fout: ${e.message}`);
      report.push({ id: card.id, title: card.title, artist: card.artist, status: 'error', error: e.message });
      continue;
    }
    const { best, ranked } = result;
    const top = ranked[0];
    const second = ranked.find((r) => best && r.track.id !== best.id);
    const status = best ? (best.sure ? 'sure' : 'doubt') : 'none';
    const entry = {
      id: card.id, title: card.title, artist: card.artist, year: card.year, status,
      score: best?.score ?? top?.score ?? 0,
      spotify: best ? describe(ranked.find((r) => r.track.id === best.id).track) : null,
      flags: best?.flags || [],
      closest: !best && top ? { ...describe(top.track), score: top.score, title: +top.title.toFixed(2), artist: +top.artist.toFixed(2) } : null,
      runnerUp: second ? { ...describe(second.track), score: second.score } : null,
    };
    report.push(entry);
    const line = `${card.id} ${card.artist} - ${card.title}`;
    if (status === 'none') console.log(`  ✗ ${line}: geen betrouwbare match${top ? ` (dichtstbij: ${describe(top.track).artists} - ${top.track.name}, ${top.score})` : ''}`);
    else if (status === 'doubt') console.log(`  ? ${line} -> ${entry.spotify.artists} - ${entry.spotify.name} [${entry.spotify.album}] (${entry.score})`);
    else if (process.stdout.isTTY) process.stdout.write(`  ✓ ${line}\r`);

    const write = best && (status === 'sure' || !SURE_ONLY);
    if (write && card.spotifyId !== best.id) { // with --force, an existing id stays when nothing is found
      setSpotifyId(card, best.id);
      changed++;
    }
  }

  const count = (s) => report.filter((r) => r.status === s).length;
  console.log(`\nZeker: ${count('sure')}  Twijfel: ${count('doubt')}  Geen match: ${count('none')}  Al gekoppeld: ${count('kept')}  Fouten: ${count('error')}`);
  const doubts = report.filter((r) => r.status === 'doubt' || r.status === 'none');
  if (doubts.length) {
    console.log('\nControleer deze kaarten met de hand (zet zo nodig zelf "spotifyId" in deck.json):');
    for (const r of doubts) {
      const what = r.spotify ? `${r.spotify.artists} - ${r.spotify.name} [${r.spotify.album}] https://open.spotify.com/track/${r.spotify.id}` : 'niets gevonden';
      console.log(`  ${r.id}  ${r.artist} - ${r.title} (${r.year})  =>  ${what}  score ${r.score}${r.flags?.length ? ` (${r.flags.join(', ')})` : ''}`);
    }
  }
  if (REPORT) {
    writeFileSync(resolve(process.cwd(), REPORT), `${JSON.stringify({ market, thresholds: { MIN_TITLE, MIN_ARTIST, MIN_SCORE }, cards: report }, null, 2)}\n`);
    console.log(`\nRapport: ${REPORT}`);
  }
  if (DRY) {
    console.log(`\nDry-run: ${changed} kaart(en) zouden een spotifyId krijgen; deck.json is niet gewijzigd.`);
  } else if (changed) {
    writeFileSync(DECK, `${JSON.stringify(deck, null, 2)}\n`);
    console.log(`\n${changed} kaart(en) bijgewerkt in ${DECK}`);
  } else {
    console.log('\nNiets te wijzigen.');
  }
}

/** Put spotifyId right after itunesId so the deck stays readable. */
function setSpotifyId(card, id) {
  const entries = Object.entries(card).filter(([k]) => k !== 'spotifyId');
  const at = entries.findIndex(([k]) => k === 'itunesId');
  entries.splice(at >= 0 ? at + 1 : entries.length, 0, ['spotifyId', id]);
  for (const k of Object.keys(card)) delete card[k];
  Object.assign(card, Object.fromEntries(entries));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
