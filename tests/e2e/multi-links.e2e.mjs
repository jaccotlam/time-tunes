// Several Spotify "links" (Client IDs) and the guests' own playlists in "Mix van de groep",
// through the real Node room server, phones of 360 px, the spelleider's screen 1280 px. A
// fake Spotify that answers per Client ID (Anouk is on link 1, Bram only on link 2: Spotify
// lets him log in through link 1 and then answers 403), a fake iTunes and a mocked
// MusicBrainz. The spelleider sets two named links in Instellingen; Anouk chooses link 1 and
// shares favourites; Bram chooses link 1, gets the friendly "Je staat niet op Link 1", picks
// link 2, then two of his own playlists, whose songs are checked (year at MusicBrainz, fragment
// at Apple) and shared; the lobby shows per link "1 van 5" and the mix counts; Discobingo from
// the mix plays songs of both. Then: a room with one link asks nothing; an app of before the
// links (from git) as a guest in a room with two links logs in with meta.spotifyClientId;
// the new app against a room server of before the links (from git): nothing new is sent; and
// links edited on a device with an account (real Node account server) reach the account, are
// still there after a reload and come to a second device.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, startServer, assert, OUT, ROOT } from './helpers.mjs';
import { startRoomServer, phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';

/** The app and room server as they were just before the links (v3-11 without Deezer). */
const OLD_REF = '588f0c3';
const SHOTS = process.env.LINKS_SHOTS || OUT;

const L1 = '11111111111111111111111111111111';
const L2 = '22222222222222222222222222222222';
const L3 = 'abcdefabcdefabcdefabcdefabcdefab';
const PLAYBACK = 'user-read-playback-state user-modify-playback-state';
const TOP = 'user-top-read';
const LISTS = 'playlist-read-private playlist-read-collaborative';

const PHONE = { viewport: { width: 360, height: 740 } };
const DESK = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

// ---------- the songs ----------
const WORDS = ['Zomer', 'Regen', 'Haven', 'Molen', 'Duin', 'Storm', 'Tulp', 'Gracht', 'Kade', 'Polder', 'Toren', 'Klomp',
  'Fiets', 'Brug', 'Sluis', 'Dijk', 'Wad', 'Schip', 'Anker', 'Meeuw', 'Schaats', 'Kerk', 'Plein', 'Markt', 'Bakker',
  'Kaas', 'Haring', 'Stroop', 'Wafel', 'Tram', 'Kanaal', 'Zeil', 'Vlag', 'Klok', 'Lamp', 'Deur', 'Raam', 'Zolder', 'Kelder', 'Tuin'];
const song = (w, i, who) => ({
  key: `${who}${i}`, title: `${w} ${who === 'a' ? 'Avond' : 'Nacht'}`, artist: `De ${w}${who === 'a' ? 'mannen' : 'vrouwen'}`,
  spotifyId: `${who}${w}${i}`.padEnd(22, 'q').slice(0, 22), year: 1960 + i, isrc: `NLB${who === 'a' ? 'AA' : 'BB'}${String(9000000 + i).padStart(7, '0')}`,
  spDate: `${2010 + (i % 9)}-01-01`, // Spotify: often the year of a remaster
});
const A_TOP = WORDS.slice(0, 16).map((w, i) => song(w, i, 'a'));
const B_SONGS = WORDS.map((w, i) => song(w, i, 'b'));
const B_LISTS = {
  bList1: { name: 'Bram zijn feest', owner: 'bram', tracks: B_SONGS.slice(0, 20) },
  bList2: { name: 'Samen met Sanne', owner: 'sanne', collaborative: true, tracks: B_SONGS.slice(20, 40) },
  bList3: { name: 'Gevolgd: Top 2000', owner: 'radio', tracks: B_SONGS.slice(0, 5) }, // not his: Spotify gives no songs
};
const NO_FRAGMENT = new Set(['bTram29', 'bKanaal30'].map((k) => k)); // two of Bram's songs are not on Apple Music
const onApple = (s) => !NO_FRAGMENT.has(`b${s.title.split(' ')[0]}${s.year - 1960}`);
let nextId = 7100000;
const CATALOG = [...A_TOP, ...B_SONGS.filter(onApple)].map((s) => {
  const trackId = nextId++;
  return {
    wrapperType: 'track', kind: 'song', trackId, artistName: s.artist, trackName: s.title, collectionName: `${s.title} (Single)`,
    releaseDate: `${s.year}-03-01T12:00:00Z`, previewUrl: `https://audio-ssl.itunes.apple.com/fake/${trackId}.m4a`, trackViewUrl: `https://music.apple.com/nl/album/fake/1?i=${trackId}`,
  };
});
const spTrack = (s) => ({ type: 'track', id: s.spotifyId, uri: `spotify:track:${s.spotifyId}`, name: s.title, duration_ms: 200000, artists: [{ name: s.artist }], album: { name: `${s.title} (Remastered)`, release_date: s.spDate }, external_ids: { isrc: s.isrc }, is_local: false });

const ACCOUNTS = {
  ilse: { id: 'ilse', on: [L1, L2], top: A_TOP.slice(0, 4), lists: {} },
  anouk: { id: 'anouk', on: [L1], top: A_TOP, lists: {} },
  bram: { id: 'bram', on: [L2], top: [], lists: B_LISTS },
  cas: { id: 'cas', on: [L1], top: A_TOP.slice(0, 12), lists: {} },
  eva: { id: 'eva', on: [L1], top: A_TOP.slice(4, 14), lists: {} },
};

/**
 * A fake Spotify for one phone: login (authorize + token) per Client ID; the Web API answers
 * 403 "User not registered in the Developer Dashboard" when the token belongs to an app whose
 * user list does not have this account (that is what Development Mode does).
 */
async function fakeSpotify(ctx, base, account, { seedToken = null } = {}) {
  const m = { calls: [], authorize: [], tokens: new Map(), n: 0 };
  if (seedToken) m.tokens.set(seedToken.token, seedToken.clientId);
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: body == null ? '' : JSON.stringify(body) });
  await ctx.route('https://accounts.spotify.com/authorize?**', (route) => {
    const u = new URL(route.request().url());
    m.authorize.push({ clientId: u.searchParams.get('client_id'), scope: u.searchParams.get('scope') });
    const target = `${base}?code=CODE-${m.authorize.length}&state=${encodeURIComponent(u.searchParams.get('state'))}`;
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><p>Spotify (nep)</p><script>location.replace(${JSON.stringify(target)})</script>` });
  });
  await ctx.route('https://accounts.spotify.com/api/token', (route) => {
    const body = new URLSearchParams(route.request().postData() || '');
    const cid = body.get('client_id');
    const token = `at-${account.id}-${++m.n}`;
    m.tokens.set(token, cid);
    const scope = m.authorize.filter((a) => a.clientId === cid).at(-1)?.scope || PLAYBACK;
    return json(route, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${m.n}`, scope });
  });
  await ctx.route('https://i.scdn.co/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#6a4"/></svg>' }));
  await ctx.route('https://api.spotify.com/v1/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,PUT,POST' } });
    const u = new URL(req.url());
    const path = u.pathname.replace('/v1', '');
    const token = String(req.headers().authorization || '').replace(/^Bearer /, '');
    const cid = m.tokens.get(token);
    m.calls.push({ path, cid });
    if (!cid) return json(route, 401, { error: { status: 401, message: 'The access token expired' } });
    if (!account.on.includes(cid)) return json(route, 403, { error: { status: 403, message: 'User not registered in the Developer Dashboard' } });
    if (path === '/me') return json(route, 200, { id: account.id, display_name: account.id, product: 'premium' });
    if (path === '/me/top/tracks') {
      const items = account.top.slice(0, Number(u.searchParams.get('limit')) || 20).map(spTrack);
      return json(route, 200, { items, total: items.length, limit: 50, offset: 0, next: null });
    }
    if (path === '/me/playlists') {
      return json(route, 200, {
        next: null,
        items: Object.entries(account.lists).map(([id, l]) => ({ id, name: l.name, owner: { id: l.owner }, collaborative: !!l.collaborative, items: { total: l.tracks.length }, images: [{ url: `https://i.scdn.co/image/${id}` }] })),
      });
    }
    const pm = path.match(/^\/playlists\/([^/]+)\/items$/);
    if (pm) {
      const l = account.lists[pm[1]];
      if (!l) return json(route, 404, { error: { status: 404, message: 'Not found' } });
      if (l.owner !== account.id && !l.collaborative) return json(route, 403, { error: { status: 403, message: 'Forbidden' } });
      const off = Number(u.searchParams.get('offset')) || 0;
      const lim = Math.min(Number(u.searchParams.get('limit')) || 50, 50);
      const items = l.tracks.slice(off, off + lim).map((t) => ({ item: spTrack(t) }));
      return json(route, 200, { items, total: l.tracks.length, offset: off, limit: lim, next: off + lim < l.tracks.length ? 'more' : null });
    }
    if (path === '/me/player/devices') return json(route, 200, { devices: [{ id: 'dev', name: 'Speaker', type: 'Speaker', is_active: true }] });
    if (path.startsWith('/me/player')) return req.method() === 'GET' ? json(route, 200, { is_playing: false, device: { id: 'dev', volume_percent: 50, supports_volume: true } }) : json(route, 204, null);
    if (path === '/search') return json(route, 200, { tracks: { items: [] } });
    return json(route, 404, { error: { status: 404, message: 'Service not found' } });
  });
  return m;
}

/** MusicBrainz: the first release of every ISRC of these songs is the original year. */
async function fakeMusicBrainz(ctx) {
  const stats = { isrc: 0 };
  const years = new Map([...A_TOP, ...B_SONGS].map((s) => [s.isrc, s.year]));
  await ctx.route('https://musicbrainz.org/**', (route) => {
    const u = new URL(route.request().url());
    const isrc = u.pathname.startsWith('/ws/2/isrc/') ? u.pathname.split('/').pop() : '';
    if (isrc) stats.isrc++;
    const y = years.get(isrc);
    return route.fulfill({
      status: y ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(y ? { recordings: [{ 'first-release-date': `${y}-05-01` }] } : { error: 'Not Found' }),
    });
  });
  return stats;
}

/** A phone (or the spelleider's screen) with its own account; `login`: already logged in with that Client ID. */
async function linkPhone(browser, rooms, base, account, { seed = null, own = null, login = null, desk = false } = {}) {
  const p = await phone(browser, rooms, { seed, ...(desk ? DESK : PHONE) });
  await installFakeItunes(p.context, { catalog: CATALOG });
  p.mb = await fakeMusicBrainz(p.context);
  const seedToken = login ? { token: `at-seed-${account.id}`, clientId: login } : null;
  p.sp = await fakeSpotify(p.context, base, account, { seedToken });
  await p.context.addInitScript(([cid, tok]) => {
    try {
      if (localStorage.getItem('timetunesr.e2eInit')) return;
      localStorage.setItem('timetunesr.e2eInit', '1');
      localStorage.setItem('timetunesr.itunesGap.v1', '30');
      localStorage.setItem('timetunesr.mbGap.v1', '20');
      if (cid) localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid));
      if (tok) localStorage.setItem('timetunesr.spotify.token.v1', JSON.stringify({ access_token: tok.token, refresh_token: 'rt', expires_at: Date.now() + 3600e3, scope: tok.scope, clientId: tok.clientId }));
    } catch { /* ignore */ }
  }, [own, seedToken ? { ...seedToken, scope: `${PLAYBACK} ${TOP} ${LISTS}` } : null]);
  return p;
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}
const counts = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="mix-counts"]');
  return el ? { total: Number(el.dataset.total), preview: Number(el.dataset.preview), contributors: Number(el.dataset.contributors) } : null;
});
const linkUse = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="mix-link-count"]')].map((e) => Number(e.dataset.n)));

/** An earlier version from git (`what`: 'app' or 'server'), unpacked in a temporary folder. Null when git can not give it. */
function oldTree(what) {
  const dir = mkdtempSync(join(tmpdir(), `tt-old-${what}-`));
  try {
    execSync(`git archive --format=tar ${OLD_REF} ${what === 'app' ? 'app' : 'server app/js'} | tar -x -C "${dir}"`, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  if (what === 'server') symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir'); // 'ws'
  return dir;
}
function run(cmd, args, ready) {
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], ...cmd });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes(ready)) resolve(proc); });
    proc.on('exit', (c) => reject(new Error(`exited ${c}`)));
  });
}

export default async function main() {
  const rooms = await startRoomServer();
  const server = await startServer();
  const base = server.url.replace('localhost', '127.0.0.1');
  const browser = await launch();
  const pages = [];
  const cleanup = [];
  try {
    // ---------- the spelleider sets two links in Instellingen ----------
    const host = await linkPhone(browser, rooms, base, ACCOUNTS.ilse, { seed: 11, own: L1, login: L1, desk: true });
    const H = host.page;
    pages.push(H);
    await H.goto(`${base}#/instellingen/spotify`);
    await H.getByTestId('spotify-links').waitFor();
    assert(await H.getByTestId('spotify-link-row').count() === 1 && await H.getByTestId('spotify-own-link').count() === 0, 'one Client ID: it is Link 1, nothing to choose');
    assert(/plek voor 5 mensen/.test(await H.getByTestId('spotify-links-explain').textContent()), 'the calm explanation: every link is a Spotify app with room for 5 people');
    await H.getByTestId('spotify-link-add').click();
    await H.getByTestId('spotify-link-new-id').fill('BQDs9xY7-not-a-client-id');
    await H.getByTestId('spotify-link-new-save').click();
    await H.getByTestId('spotify-link-new-msg').waitFor();
    assert(await H.getByTestId('spotify-link-row').count() === 1, 'something that is no Client ID is refused, with a message');
    await H.getByTestId('spotify-link-new-id').fill(L1.toUpperCase());
    await H.getByTestId('spotify-link-new-save').click();
    assert(/staat er al in/.test(await H.getByTestId('spotify-link-new-msg').textContent()), 'no duplicates');
    await H.getByTestId('spotify-link-new-id').fill(` ${L2} `);
    await H.getByTestId('spotify-link-new-name').fill('vrienden van ver weg <b>!</b>');
    await H.getByTestId('spotify-link-new-save').click();
    await H.locator('[data-testid="spotify-links"][data-count="2"]').waitFor();
    await H.locator('[data-testid="spotify-link-name"]').first().fill('familie');
    await H.locator('[data-testid="spotify-link-name"]').first().press('Enter');
    await H.waitForFunction(() => JSON.parse(localStorage.getItem('timetunesr.spotify.links.v1') || '[]')[0]?.name === 'familie');
    const stored = await H.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.spotify.links.v1')));
    assert(stored.length === 2 && stored[0].id === L1 && stored[1].id === L2 && stored[1].name.length <= 20 && !/[<>]/.test(stored[1].name), `two links stored, names plain and short (${JSON.stringify(stored.map((l) => l.name))})`);
    assert(await H.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.spotify.clientId.v1'))) === L1, 'the single Client ID stays and is the own link (Link 1)');
    assert(await H.locator('[data-testid="spotify-own-link"] option').count() === 2, '"Ik log zelf in via …" offers both');
    // the share link / QR per link
    await H.locator('[data-testid="spotify-link-share"]').nth(1).click();
    await H.getByTestId('spotify-share-sheet').waitFor();
    assert((await H.getByTestId('spotify-share-link').inputValue()).includes(`#/spotify-delen/${L2}`), 'link 2 has its own share link');
    await H.getByTestId('spotify-share-close').click();
    // shorten the name of link 2 for the screens
    await H.locator('[data-testid="spotify-link-name"]').nth(1).fill('vrienden');
    await H.locator('[data-testid="spotify-link-name"]').nth(1).press('Enter');
    await H.waitForFunction(() => JSON.parse(localStorage.getItem('timetunesr.spotify.links.v1') || '[]')[1]?.name === 'vrienden');
    await H.getByTestId('spotify-links').scrollIntoViewIfNeeded();
    await shot(H, 'links-01-settings-two-links');

    // ---------- the room carries the links ----------
    await H.goto(`${base}#/spelleider`);
    const code = await createRoom(H);
    await H.waitForFunction(() => window.__ttHost?.session?.meta?.spotifyLinks?.length === 2, null, { timeout: 15000 });
    const meta = (await serverHost(H)).meta;
    assert(meta.spotifyLinks[0].id === L1 && meta.spotifyLinks[0].name === 'familie' && meta.spotifyLinks[1].name === 'vrienden' && meta.spotifyClientId === L1, 'the room meta has both links (and spotifyClientId = the first, for older phones)');
    assert(meta.play === 'preview', 'and how the spelleider plays: 30-second fragments');

    const answerers = []; // the players of the room (they answer every Discobingo round)
    const anouk = await linkPhone(browser, rooms, base, ACCOUNTS.anouk);
    const bram = await linkPhone(browser, rooms, base, ACCOUNTS.bram);
    const A = anouk.page;
    const B = bram.page;
    pages.push(A, B);
    answerers.push(A, B);
    await joinRoom(A, base, code, 'Anouk', { via: 'link' });
    await joinRoom(B, base, code, 'Bram', { via: 'code' });
    await waitForPlayers(H, 2);
    await H.getByTestId('mix-link-use').waitFor();
    assert(JSON.stringify(await linkUse(H)) === '[0,0]', 'the lobby shows per link "0 van 5"');

    // ---------- Anouk: link 1, favourites ----------
    await A.getByTestId('mix-share').waitFor();
    assert(await A.getByTestId('mix-login-note').getAttribute('data-client') === 'links', 'the note says the guest logs in through one of the links');
    await A.getByTestId('mix-count').selectOption('15');
    await A.getByTestId('mix-share').click();
    await A.getByTestId('mix-link-choose').waitFor();
    const labels = await A.getByTestId('mix-link-option').allTextContents();
    assert(labels.length === 2 && labels[0].trim() === 'Link 1 · familie' && labels[1].trim() === 'Link 2 · vrienden', `first one clear question with a button per link (${labels.join(' / ')})`);
    await shot(A, 'links-02-phone-link-chooser');
    await A.locator('[data-testid="mix-link-option"][data-index="0"]').click();
    await A.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await A.locator('[data-testid="mix-panel"][data-phase="done"] [data-testid="mix-done"][data-mine="15"]').waitFor({ timeout: 40000 });
    assert(anouk.sp.authorize.length === 1 && anouk.sp.authorize[0].clientId === L1, 'Anouk logged in once, with link 1');
    assert(['user-top-read', 'playlist-read-private'].every((sc) => anouk.sp.authorize[0].scope.includes(sc)), 'one login asks for the top songs AND the playlists');
    await H.waitForFunction(() => JSON.stringify([...document.querySelectorAll('[data-testid="mix-link-count"]')].map((e) => Number(e.dataset.n))) === '[1,0]', null, { timeout: 15000 });
    assert(true, 'the lobby: Link 1: 1 van 5');

    // ---------- Bram: link 1 says no, link 2 works, two playlists ----------
    await B.getByTestId('mix-lists-open').waitFor();
    assert(/Kies uit mijn playlists/.test(await B.getByTestId('mix-lists-open').textContent()), '"Kies uit mijn playlists" next to the favourites');
    await B.getByTestId('mix-lists-open').click();
    await B.getByTestId('mix-link-choose').waitFor();
    await B.locator('[data-testid="mix-link-option"][data-index="0"]').click();
    await B.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await B.getByTestId('mix-link-refused').waitFor({ timeout: 20000 });
    const refused = await B.getByTestId('mix-link-refused').textContent();
    assert(/Je staat niet op Link 1\./.test(refused) && /Kies een andere link, of vraag de spelleider om je toe te voegen \(Spotify-dashboard → User Management\)/.test(refused), `the friendly "not on this link": "${refused.replace(/\s+/g, ' ').trim()}"`);
    assert(!/403|registered|Developer/i.test(refused), 'no technical error');
    assert(await B.evaluate(() => localStorage.getItem('timetunesr.spotify.token.v1')) === null, 'no broken token left behind');
    assert(await B.getByTestId('mix-link-other').count() === 1 && await B.getByTestId('mix-link-retry').count() === 1, 'the other link as a button, and "Probeer opnieuw"');
    await shot(B, 'links-03-phone-not-on-link');
    await B.getByTestId('mix-link-other').click();
    await B.waitForURL(`${base}#/kamer/${code}`, { timeout: 20000 });
    await B.getByTestId('mix-lists-picker').waitFor({ timeout: 20000 });
    await B.getByTestId('mix-lists-result').first().waitFor({ timeout: 15000 });
    assert(bram.sp.authorize.map((a) => a.clientId).join(',') === `${L1},${L2}`, 'Bram logged in with link 1, then link 2');
    const offered = await B.locator('[data-testid="mix-lists-result"]').evaluateAll((els) => els.map((e) => e.dataset.id));
    assert(offered.join(',') === 'bList1,bList2', `only his own and collaborative playlists are offered (${offered.join(', ')})`);
    await B.getByTestId('mix-lists-count').selectOption('25');
    await shot(B, 'links-04-phone-playlist-picker');
    await B.locator('[data-testid="mix-lists-result"][data-id="bList1"]').click();
    await B.getByTestId('mix-lists-add').click();
    await B.locator('[data-testid="mix-lists-result"][data-id="bList2"]').click();
    await B.locator('[data-testid="mix-panel"][data-mode="lists"][data-phase="done"]').waitFor({ timeout: 60000 });
    const shared = await B.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.mixLists.v1')).shared);
    assert(shared.length === 25, `25 checked songs shared (${shared.length})`);
    assert(shared.every((t) => t.previewUrl && t.itunesId), 'with the fragments every shared song has its Apple Music fragment');
    assert(shared.every((t) => B_SONGS.find((s) => s.spotifyId === t.spotifyId)?.year === t.year), 'every song has its checked year (MusicBrainz), not the remaster year of Spotify');
    const per = shared.reduce((o, t) => ({ ...o, [t.l]: (o[t.l] || 0) + 1 }), {});
    assert(per.bList1 >= 10 && per.bList2 >= 10, `spread over both lists (${JSON.stringify(per)})`);
    assert(bram.mb.isrc >= 25, 'the years were checked at MusicBrainz');
    const noFrag = await B.getByTestId('mix-lists-nofragment').count() ? Number(await B.getByTestId('mix-lists-nofragment').getAttribute('data-n')) : 0;
    const storedNoFrag = await B.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.mixLists.v1')).noFragment || 0);
    assert(noFrag === storedNoFrag, `songs without an Apple Music fragment are left out and the phone says how many (${noFrag})`);
    await H.waitForFunction(() => JSON.stringify([...document.querySelectorAll('[data-testid="mix-link-count"]')].map((e) => Number(e.dataset.n))) === '[1,1]', null, { timeout: 15000 });
    assert(true, 'the lobby: Link 1: 1 van 5 · Link 2: 1 van 5');
    await shot(B, 'links-05-phone-playlists-shared');
    await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '2', null, { timeout: 15000 });
    const c = await counts(H);
    assert(c.total === 40 && c.preview === 40, `the mix counts: ${c.total} songs of 2 players (only counts)`);
    const leak = (await H.evaluate(() => JSON.stringify(window.__ttHost.session.received.filter((m) => m.t === 'state')))).includes(shared[0].title);
    assert(!leak, 'no title reaches the spelleider before it is played');
    await H.getByTestId('mix-link-use').scrollIntoViewIfNeeded();
    await shot(H, 'links-06-host-lobby-counts');

    // ---------- an app of before the links, as a guest in the room with two links ----------
    const oldApp = oldTree('app');
    if (!oldApp) console.log(`  SKIPPED - ${OLD_REF} not in this git checkout: the old-app check did not run`);
    else {
      cleanup.push(() => rmSync(oldApp, { recursive: true, force: true }));
      const port = 8600 + Math.floor(Math.random() * 90);
      const proc = await run({}, [join(ROOT, 'scripts/serve.mjs'), '--port', String(port), '--host', '127.0.0.1', '--root', join(oldApp, 'app')], 'draait op');
      cleanup.push(() => proc.kill());
      const oldBase = `http://127.0.0.1:${port}/`;
      const eva = await linkPhone(browser, rooms, oldBase, ACCOUNTS.eva);
      pages.push(eva.page);
      answerers.push(eva.page);
      await joinRoom(eva.page, oldBase, code, 'Eva', { via: 'link' });
      await eva.page.getByTestId('mix-share').waitFor();
      assert(await eva.page.getByTestId('mix-link-choose').count() === 0, 'the old app knows no links: no question');
      await eva.page.getByTestId('mix-share').click();
      await eva.page.waitForURL(`${oldBase}#/kamer/${code}`, { timeout: 20000 });
      await eva.page.locator('[data-testid="mix-panel"][data-phase="done"]').waitFor({ timeout: 40000 });
      assert(eva.sp.authorize[0].clientId === L1, 'it logs in with meta.spotifyClientId (= link 1) and shares its favourites');
      await H.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '3', null, { timeout: 15000 });
      assert(true, 'the room counts the old app\'s songs too');
    }

    // ---------- Discobingo from the mix: songs of both come up ----------
    await H.getByTestId('room-game-disco').check();
    await H.getByTestId('room-music-mix').check();
    await H.locator('[data-testid="room-start"]:not([disabled])').waitFor({ timeout: 15000 });
    await H.getByTestId('room-start').click();
    const by = new Set();
    for (let round = 1; round <= 14 && !(by.has('Anouk') && by.has('Bram')); round++) {
      await H.waitForFunction((r) => window.__ttHost?.session?.room?.game?.round === r && !!window.__ttHost.session.currentSong(), round, { timeout: 30000 });
      const { song: s } = await serverHost(H);
      for (const n of s.by || []) by.add(n);
      assert(A_TOP.some((x) => x.spotifyId === s.spotifyId) || B_SONGS.some((x) => x.spotifyId === s.spotifyId), `round ${round}: a song of the mix (${(s.by || []).join(' & ')})`);
      for (const P of answerers) {
        await P.evaluate(() => { const v = window.__ttRoom.session.view; const cat = v?.game?.disco?.cat; window.__ttRoom.session.answer(cat === 'exact' || cat === 'year' ? { guess: '1901' } : { text: 'zzz onbekend' }); });
      }
      // everybody answered: the spelleider reveals (or the automatic reveal did already)
      await H.waitForFunction(() => window.__ttHost.session.room?.phase === 'revealed' || document.querySelector('[data-testid="room-reveal"][data-ready="true"]'), null, { timeout: 20000 });
      if (await H.locator('[data-testid="room-reveal"]').count() && (await serverHost(H)).room.phase !== 'revealed') await H.getByTestId('room-reveal').click().catch(() => {});
      await H.waitForFunction(() => window.__ttHost.session.room?.phase === 'revealed', null, { timeout: 15000 });
      if (by.has('Anouk') && by.has('Bram')) break;
      const next = H.getByTestId('room-next');
      await next.waitFor({ timeout: 15000 });
      await next.click();
      const dlg = H.getByTestId('disco-confirm-go');
      if (await dlg.count()) await dlg.click();
    }
    assert(by.has('Anouk') && by.has('Bram'), `songs of both came up (${[...by].join(', ')})`);

    // ---------- a room with one link asks nothing ----------
    const host2 = await linkPhone(browser, rooms, base, ACCOUNTS.ilse, { own: L1, login: L1, desk: true });
    pages.push(host2.page);
    await host2.page.goto(`${base}#/spelleider`);
    const code2 = await createRoom(host2.page);
    const cas = await linkPhone(browser, rooms, base, ACCOUNTS.cas);
    pages.push(cas.page);
    await joinRoom(cas.page, base, code2, 'Cas', { via: 'link' });
    await cas.page.getByTestId('mix-share').waitFor();
    assert(await cas.page.getByTestId('mix-login-note').getAttribute('data-client') === 'room', 'one link: the note is as before');
    await cas.page.getByTestId('mix-share').click();
    await cas.page.waitForURL(`${base}#/kamer/${code2}`, { timeout: 20000 });
    await cas.page.locator('[data-testid="mix-panel"][data-phase="done"]').waitFor({ timeout: 40000 });
    assert(cas.sp.authorize.length === 1 && cas.sp.authorize[0].clientId === L1, 'no question: straight to Spotify with the one link');
    assert(await host2.page.getByTestId('mix-link-use').count() === 0, 'and the lobby of a one-link room shows no link counts');

    // ---------- links edited on a device with an account reach the account ----------
    {
      const dev1 = await linkPhone(browser, rooms, base, ACCOUNTS.ilse, { own: L1, desk: true });
      const P = dev1.page;
      pages.push(P);
      await P.goto(`${base}#/instellingen/spotify`);
      await P.getByTestId('spotify-links').waitFor();
      const su = await P.evaluate(async (l) => {
        (await import('/js/spotify.js')).setLinks([{ id: l[0], name: 'familie' }, { id: l[1], name: '' }]);
        window.__acct = await import('/js/account.js');
        const r = await window.__acct.signUp('ilselinks', 'geheim-wachtwoord-1');
        await window.__acct.startAutoSave();
        return r.ok;
      }, [L1, L2]);
      assert(su, 'an account with two links (the first upload)');
      const idle = () => P.waitForFunction(() => { const s = window.__acct.status(); return !s.pending && !s.saving && !s.error; }, null, { timeout: 20000 });
      await P.reload();
      await P.getByTestId('spotify-links').waitFor();
      await P.evaluate(async () => { window.__acct = await import('/js/account.js'); await window.__acct.startAutoSave(); });
      // now the account holds a list: edit it in Instellingen (rename + add), the way the host does
      await P.locator('[data-testid="spotify-link-name"]').nth(1).fill('vrienden');
      await P.locator('[data-testid="spotify-link-name"]').nth(1).press('Enter');
      await P.getByTestId('spotify-link-add').click();
      await P.getByTestId('spotify-link-new-id').fill(L3);
      await P.getByTestId('spotify-link-new-name').fill('werk');
      await P.getByTestId('spotify-link-new-save').click();
      await P.locator('[data-testid="spotify-links"][data-count="3"]').waitFor();
      await P.waitForFunction(() => window.__acct.status().pending || window.__acct.status().saving || window.__acct.status().lastSync, null, { timeout: 10000 });
      await idle();
      await P.waitForFunction(async () => { const a = await window.__acct.fetchAccount(); return (a.data?.spotifyLinks || []).length === 3; }, null, { timeout: 20000 });
      const inAcct = await P.evaluate(async () => (await window.__acct.fetchAccount()).data.spotifyLinks);
      assert(JSON.stringify(inAcct) === JSON.stringify([{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }, { id: L3, name: 'werk' }]), `the edit reached the account (${JSON.stringify(inAcct.map((l) => l.name))})`);
      // a reload pulls the account again: the edit stays
      await P.reload();
      await P.getByTestId('spotify-links').waitFor();
      await P.evaluate(async () => { window.__acct = await import('/js/account.js'); await window.__acct.pull(); });
      const after = await P.evaluate(() => JSON.parse(localStorage.getItem('timetunesr.spotify.links.v1')));
      assert(after.map((l) => l.name).join(',') === 'familie,vrienden,werk', `still there after a reload and a pull (${after.map((l) => l.name).join(',')})`);
      assert(await P.locator('[data-testid="spotify-links"][data-count="3"]').count() === 1, 'and in Instellingen');
      // a second device logs in: it gets the edited list
      const dev2 = await linkPhone(browser, rooms, base, ACCOUNTS.ilse, { desk: true });
      pages.push(dev2.page);
      await dev2.page.goto(`${base}#/`);
      const got = await dev2.page.evaluate(async () => { const a = await import('/js/account.js'); const r = await a.logIn('ilselinks', 'geheim-wachtwoord-1'); return r.ok ? JSON.parse(localStorage.getItem('timetunesr.spotify.links.v1')) : r; });
      assert(Array.isArray(got) && got.map((l) => `${l.id.slice(0, 2)}:${l.name}`).join(',') === '11:familie,22:vrienden,ab:werk', `a second device gets it (${JSON.stringify(got)})`);
    }

    // ---------- the new app against a room server of before the links ----------
    const oldServer = oldTree('server');
    if (!oldServer) console.log(`  SKIPPED - ${OLD_REF} not in this git checkout: the old-server check did not run`);
    else {
      cleanup.push(() => rmSync(oldServer, { recursive: true, force: true }));
      const sport = 8700 + Math.floor(Math.random() * 90);
      const sproc = await run({ env: { ...process.env, PORT: String(sport), HOST: '127.0.0.1' } }, [join(oldServer, 'server/node.mjs')], 'luistert op poort');
      cleanup.push(() => sproc.kill());
      const oldRooms = { kind: 'server', url: `http://127.0.0.1:${sport}` };
      const host3 = await linkPhone(browser, oldRooms, base, ACCOUNTS.ilse, { own: L1, login: L1, desk: true });
      await host3.page.addInitScript(([l]) => { try { if (!localStorage.getItem('timetunesr.spotify.links.v1')) localStorage.setItem('timetunesr.spotify.links.v1', JSON.stringify(l)); } catch { /* ignore */ } }, [[{ id: L1, name: 'familie' }, { id: L2, name: 'vrienden' }]]);
      pages.push(host3.page);
      const sent = [];
      host3.page.on('websocket', (ws) => ws.on('framesent', (f) => { try { const m = JSON.parse(f.payload); if (m?.t) sent.push(m.t); } catch { /* ping */ } }));
      await host3.page.goto(`${base}#/spelleider`);
      const code3 = await createRoom(host3.page);
      const dirk = await linkPhone(browser, oldRooms, base, ACCOUNTS.cas);
      pages.push(dirk.page);
      await joinRoom(dirk.page, base, code3, 'Dirk', { via: 'link' });
      await dirk.page.getByTestId('mix-share').waitFor();
      assert(await dirk.page.getByTestId('mix-lists-open').count() === 1 && await dirk.page.getByTestId('mix-link-choose').count() === 0, 'an old server (with mix-lists, without links): "Kies uit mijn playlists" is offered, no link question');
      await dirk.page.getByTestId('mix-share').click();
      await dirk.page.waitForURL(`${base}#/kamer/${code3}`, { timeout: 20000 });
      await dirk.page.locator('[data-testid="mix-panel"][data-phase="done"]').waitFor({ timeout: 40000 });
      assert(dirk.sp.authorize[0].clientId === L1, 'an old server only knows spotifyClientId: the guest is not asked and logs in with link 1');
      assert(!sent.includes('links') && !sent.includes('link'), `nothing new is sent to an old server (${[...new Set(sent)].join(', ')})`);
      const errs = await dirk.page.evaluate(() => (window.__ttRoom?.session?.received || []).filter((m) => m.t === 'error').map((m) => m.code));
      assert(!errs.length, `no errors from the old server (${errs.join(', ')})`);
    }

    assert(pages.every((p) => !p.errors.length), `no page errors (${pages.flatMap((p) => p.errors).join('; ')})`);
  } finally {
    await browser.close();
    server.stop();
    for (const f of cleanup.reverse()) { try { f(); } catch { /* ignore */ } }
    await rooms.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
