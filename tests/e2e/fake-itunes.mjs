// A small fake iTunes Search API (search + lookup) and fake preview audio for the
// playlist e2e tests: predictable results, counted requests, no network needed.

export function silentWav(seconds = 30) {
  const samples = 8000 * seconds;
  const b = Buffer.alloc(44 + samples, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(samples, 40);
  return b;
}
const WAV = silentWav();

let nextId = 7100000001;
const song = (artistName, trackName, collectionName, year) => {
  const trackId = nextId++;
  return {
    wrapperType: 'track', kind: 'song', trackId, artistName, trackName, collectionName,
    releaseDate: `${year}-03-01T12:00:00Z`,
    previewUrl: `https://audio-ssl.itunes.apple.com/fake/${trackId}.m4a`,
    trackViewUrl: `https://music.apple.com/nl/album/fake/1?i=${trackId}`,
  };
};

/** The fake catalogue, in "iTunes order" for searches. */
export const CATALOG = [
  song('ABBA', 'Dancing Queen', 'ABBA Gold: Greatest Hits', 1992),
  song('ABBA', 'Dancing Queen', 'Arrival', 1976),
  song('Karaoke Hits Band', 'Dancing Queen (Originally Performed by ABBA) [Karaoke Version]', 'Karaoke Classics', 2015),
  song('Queen', 'Bohemian Rhapsody', 'Greatest Hits', 1981),
  song('Queen', 'Bohemian Rhapsody', 'A Night At The Opera', 1975),
  song('Doe Maar', 'De Bom', 'Lijf aan Lijf', 1984),
  song('Golden Earring', 'Radar Love', 'Moontan', 1973),
  song('a-ha', 'Take On Me', 'Hunting High and Low', 1985),
  song('Nirvana', 'Smells Like Teen Spirit', 'Nevermind', 1991),
  song('Adele', 'Rolling in the Deep', '21', 2011),
  song('Michael Jackson', 'Billie Jean', 'Thriller', 1982),
  song('Toto', 'Africa', 'Toto IV', 1982),
  song('Dua Lipa', 'Levitating', 'Future Nostalgia', 2020),
  song('Whitney Houston', 'I Wanna Dance with Somebody (Who Loves Me)', 'Whitney', 1987),
  song('Whitney Houston', 'I Wanna Dance with Somebody (Live)', 'Live in Concert', 1993),
  song('Earth, Wind & Fire', 'September', 'The Best of Earth, Wind & Fire, Vol. 1', 1979),
  song('The Tribute Band', 'Africa', 'A Tribute to Toto', 2012),
];
export const byTitle = (t) => CATALOG.find((s) => s.trackName === t && !/Karaoke|Live|Tribute/.test(`${s.artistName} ${s.trackName}`));

const norm = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function installFakeItunes(ctx, { catalog = CATALOG } = {}) {
  const stats = { search: [], lookup: [], rate: 0, failNext: 0 };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'text/javascript; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await ctx.route('https://itunes.apple.com/**', (route) => {
    const u = new URL(route.request().url());
    if (stats.failNext > 0) { stats.failNext--; stats.rate++; return json(route, { errorMessage: 'rate' }, 429); }
    if (u.pathname === '/search') {
      const term = u.searchParams.get('term') || '';
      stats.search.push(term);
      const words = norm(term).split(' ').filter((w) => w && w !== 'and');
      const results = catalog.filter((s) => {
        const hay = ` ${norm(`${s.artistName} ${s.trackName} ${s.collectionName}`)} `;
        return words.every((w) => hay.includes(` ${w} `) || hay.includes(` ${w}`));
      }).slice(0, Number(u.searchParams.get('limit')) || 50);
      return json(route, { resultCount: results.length, results });
    }
    if (u.pathname === '/lookup') {
      const ids = String(u.searchParams.get('id') || '').split(',').map(Number);
      stats.lookup.push(ids);
      const results = catalog.filter((s) => ids.includes(s.trackId));
      return json(route, { resultCount: results.length, results });
    }
    return json(route, { resultCount: 0, results: [] });
  });
  await ctx.route('https://audio-ssl.itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  // The background worker (enrich.js) may also ask MusicBrainz (songs with an ISRC) and
  // Deezer: never the real services in a test. A suite can route these itself after this.
  await ctx.route('https://musicbrainz.org/**', (route) => {
    stats.musicbrainz = (stats.musicbrainz || 0) + 1;
    return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"Not Found"}' });
  });
  await ctx.route('https://api.deezer.com/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback') || 'cb';
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: `${/^dzcb[0-9a-z]+$/.test(cb) ? cb : 'cb'}({"error":{"type":"DataException","message":"no data","code":800}})` });
  });
  return stats;
}

/** Decode a QR code (svg.qr inside `selector`) in the page with the vendored jsQR. */
export async function decodeQr(page, selector) {
  return page.evaluate(async (sel) => {
    if (!window.jsQR) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/jsQR.js'; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const svg = document.querySelector(`${sel} svg.qr`);
    if (!svg) return null;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode();
    const size = 800;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const hit = window.jsQR(ctx.getImageData(0, 0, size, size).data, size, size);
    return hit ? hit.data : null;
  }, selector);
}
