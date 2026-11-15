// A song from Spotify (title, artist, Spotify's album year) -> its Apple Music fragment and
// the best year. Shared by the playlist screen (Spotify import, "Mijn meest geluisterd")
// and "Doe mijn favorieten erbij" in a room. Goes through the throttled iTunes queue
// (itunes.js); after a rate limit it waits and tries again.
import * as itunes from './itunes.js';
import { matchLine, pickYear } from './playlist-logic.js';

const WAIT_MS = 20000;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new itunes.ItunesError('aborted')); return; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new itunes.ItunesError('aborted')); }, { once: true });
});

/**
 * Look the song up at Apple Music. Resolves with
 * { itunesId, previewUrl, trackViewUrl, year, yearSure } or null (no trustworthy match).
 * `year`: the earliest release among results that are clearly the same recording, with
 * Spotify's album year (`t.year`) as one more candidate; yearSure=false means "controleer
 * het jaar". Rejects only with ItunesError('aborted').
 * onWait(ms): called when Apple asks to slow down (the caller may show that).
 */
export async function appleMatch(t, { signal, onWait } = {}) {
  const primary = String(t.artist || '').split(',')[0].trim();
  const title = String(t.title || '').replace(/\s+-\s+.*$/, '').replace(/[([].*?[)\]]/g, ' ');
  let results = [];
  for (let attempt = 0; ; attempt++) {
    try {
      results = await itunes.search(`${primary} ${title}`, { limit: 15, signal });
      break;
    } catch (e) {
      if (e.code === 'aborted') throw e;
      if ((e.code === 'rate' || e.code === 'unreachable') && attempt < 6) {
        const ms = Math.max(itunes.pausedFor(), WAIT_MS);
        onWait?.(ms);
        await sleep(ms, signal);
        continue;
      }
      results = [];
      break;
    }
  }
  const m = matchLine({ artist: primary, title: t.title, query: '' }, results);
  if (!m.best || m.score < 0.7) return null;
  const y = pickYear(m.best, results, t.year ? [t.year] : []);
  return {
    itunesId: Number(m.best.trackId),
    previewUrl: m.best.previewUrl || null,
    trackViewUrl: m.best.trackViewUrl || null,
    year: y.year ?? t.year ?? null,
    yearSure: !!(y.sure && m.status === 'found'),
  };
}
