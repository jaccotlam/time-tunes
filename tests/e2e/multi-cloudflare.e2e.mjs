// Smoke test of the Cloudflare version: `wrangler dev` runs the Worker of wrangler.jsonc
// locally (workerd): the app from app/ and the room server (Durable Object per room) on one
// address, like https://time-tunes.jaccotlam.workers.dev. Room, a player, one round, then
// wrangler is stopped and started again: the room comes back from Durable Object storage
// (the spelleider's backup is deleted first, so it can not be a restore from the phone).
// Then a short Quiz: a question closed by the server's timer (the Durable Object alarm) and a
// restart in the middle of a question (same question, the clock starts again with the music).
// Then a Discobingo round (answer judged by the Durable Object, a stamp) and a restart in the middle of round 2.
// Then the "Mix van de groep": the spelleider and a player add their favourites (fake Spotify
// and iTunes), wrangler restarts (the phones forget their own copy, so the songs can only come
// from Durable Object storage), and a game from the mix is played.
// Not part of `npm run test:e2e` (needs the workerd binary); run: npm run test:e2e:cf
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, assert, ROOT } from './helpers.mjs';
import { phone, createRoom, joinRoom, waitForPlayers, serverHost } from './multi-helpers.mjs';
import { installFakeItunes } from './fake-itunes.mjs';
import { mixPhone, ACCOUNTS, PLAYBACK, TOP, CLIENT_ID, shareFavourites, waitShared, myShared } from './multi-mix.e2e.mjs';
import { SERVER_PROTOCOL_VERSION } from '../../app/js/multi/server-protocol.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
const URL_ = `http://127.0.0.1:${PORT}`;

function startWrangler(persist) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist, '--log-level', 'warn'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', CI: '1' },
    });
    const t = setTimeout(() => reject(new Error('wrangler dev did not start')), 60000);
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${URL_}/health`);
        if (r.ok) { clearTimeout(t); clearInterval(poll); resolve(proc); }
      } catch { /* not yet */ }
    }, 500);
    proc.on('exit', (c) => { clearInterval(poll); clearTimeout(t); reject(new Error(`wrangler exited ${c}`)); });
  });
}
const stopWrangler = (proc) => new Promise((resolve) => {
  proc.removeAllListeners('exit');
  proc.once('exit', () => resolve());
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { resolve(); }
});

/**
 * 2000-song lists on the real Durable Objects: a room started with 2000 cards over the Worker's
 * WebSocket, and an account with three 2000-song lists (stored in pieces, chunkedStore) that
 * survives a restart of wrangler, then a delta save of one list.
 */
async function bigListsOnWorker() {
  const H_ = { origin: URL_, 'content-type': 'application/json' };
  const song = (i) => ({ n: i + 1, itunesId: 1422648000 + i, spotifyId: `4uLU6hMCjMI75M1A${String(i).padStart(6, '0')}`, deezerId: 3135000 + i, isrc: `NLA01${String(8000000 + i).slice(-7)}`, title: `Liedje nummer ${i + 1} (Radio Edit)`, artist: `Artiest ${i % 300} & De Band`, album: `Album ${i % 60}`, year: 1960 + (i % 60), yearSure: true });
  // a room with 2000 cards
  const made = await (await fetch(`${URL_}/rooms`, { method: 'POST', headers: H_, body: JSON.stringify({ v: SERVER_PROTOCOL_VERSION, id: 'bigowner1', name: 'Ilse', settings: { game: 'timeline' } }) })).json();
  const ws = new WebSocket(`${URL_.replace('http', 'ws')}/rooms/${made.code}/ws`);
  const got = [];
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (e) => { if (e.data !== 'pong') got.push(JSON.parse(e.data)); };
  ws.send(JSON.stringify({ t: 'hello', v: SERVER_PROTOCOL_VERSION, code: made.code, id: 'bigowner1', token: made.token }));
  const ws2 = new WebSocket(`${URL_.replace('http', 'ws')}/rooms/${made.code}/ws`);
  await new Promise((resolve, reject) => { ws2.onopen = resolve; ws2.onerror = reject; });
  ws2.send(JSON.stringify({ t: 'hello', v: SERVER_PROTOCOL_VERSION, code: made.code, id: 'bigplayer1', name: 'Sam' }));
  const ws3 = new WebSocket(`${URL_.replace('http', 'ws')}/rooms/${made.code}/ws`);
  await new Promise((resolve, reject) => { ws3.onopen = resolve; ws3.onerror = reject; });
  ws3.send(JSON.stringify({ t: 'hello', v: SERVER_PROTOCOL_VERSION, code: made.code, id: 'bigplayer2', name: 'Lisa' }));
  await new Promise((r) => setTimeout(r, 800));
  const { fitCards } = await import('../../app/js/multi/server-protocol.js');
  const { playlistDeck, cleanPlaylist } = await import('../../app/js/playlist-logic.js');
  const deck = playlistDeck(cleanPlaylist({ id: 'g', name: 'Groot', tracks: Array.from({ length: 2000 }, (_, i) => song(i)) }));
  const msg = JSON.stringify({ t: 'start', cards: fitCards(deck.cards).cards, mix: false, play: 'preview' });
  ws.send(msg);
  const t0 = Date.now();
  while (!got.some((m) => m.t === 'state' && m.lead?.room?.phase === 'answering') && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
  const st = got.filter((m) => m.t === 'state').pop();
  assert(st?.lead?.room?.phase === 'answering' && st.lead.song?.deezerId, `Worker: a game starts with 2000 cards (start message ${Math.round(Buffer.byteLength(msg) / 1024)} kB), the song carries its Deezer id (${JSON.stringify(got.find((m) => m.t === 'error') || '')})`);
  for (const w of [ws, ws2, ws3]) w.close();
  // an account with three 2000-song lists
  const signup = await (await fetch(`${URL_}/account/signup`, { method: 'POST', headers: H_, body: JSON.stringify({ username: 'grootlijst', password: 'geheim-wachtwoord-1' }) })).json();
  const auth = { ...H_, authorization: `Bearer ${signup.token}` };
  const lists = ['g1', 'g2', 'g3'].map((id, k) => ({ id, name: `Groot ${id}`, created: 1, updated: 10 + k, nextN: 2001, tracks: Array.from({ length: 2000 }, (_, i) => song(i)), source: { kind: 'deezer', id: '1266971851', name: 'Top' } }));
  const body = JSON.stringify({ rev: 1, data: { playlists: lists }, format: 2 });
  const saved = await fetch(`${URL_}/account/data`, { method: 'POST', headers: auth, body });
  const sv = await saved.json();
  assert(saved.status === 200 && sv.data?.playlists?.length === 3, `Worker: an account saves three 2000-song lists (${Math.round(body.length / 1024)} kB; ${saved.status} ${sv.message || ''})`);
  await stopWrangler(globalThis.__ttWrangler);
  globalThis.__ttWrangler = await startWrangler(globalThis.__ttPersist);
  const g = await (await fetch(`${URL_}/account`, { headers: auth })).json();
  assert(g.data?.playlists?.length === 3 && g.data.playlists.every((p) => p.tracks.length === 2000) && g.data.playlists[1].tracks[4].isrc, 'Worker: after a restart the account has its three lists of 2000 songs (Durable Object, in pieces)');
  const changed = { ...g.data.playlists[1], updated: 99, name: 'Anders' };
  const delta = JSON.stringify({ rev: g.rev, delta: true, format: 2, data: { playlists: [{ id: 'g1', updated: 10, same: true }, changed, { id: 'g3', updated: 12, same: true }] } });
  const d = await (await fetch(`${URL_}/account/data`, { method: 'POST', headers: auth, body: delta })).json();
  const g2 = await (await fetch(`${URL_}/account`, { headers: auth })).json();
  assert(d.delta === true && g2.data.playlists.map((p) => p.name).join() === 'Groot g1,Anders,Groot g3' && g2.data.playlists[0].tracks.length === 2000, `Worker: a delta save sends one list (${Math.round(delta.length / 1024)} kB) and keeps the others`);
  // an app of before (no format) that would save one of these lists shortened: refused, lists intact
  const old = await fetch(`${URL_}/account/data`, { method: 'POST', headers: auth, body: JSON.stringify({ rev: g2.rev, data: { playlists: g2.data.playlists.map((p) => ({ ...p, tracks: p.tracks.slice(0, 500) })) } }) });
  const ob = await old.json();
  const g3 = await (await fetch(`${URL_}/account`, { headers: auth })).json();
  assert(old.status === 400 && ob.code === 'oldapp' && g3.rev === g2.rev && g3.data.playlists.every((p) => p.tracks.length === 2000), `Worker: a save of an old app may not shorten the lists (${old.status} ${ob.message})`);
}

export default async function run() {
  const persist = mkdtempSync(join(tmpdir(), 'tt-wrangler-'));
  let wr = await startWrangler(persist);
  globalThis.__ttPersist = persist;
  const browser = await launch();
  const local = { kind: 'server', url: URL_ };
  try {
    const h = await (await fetch(`${URL_}/health`)).json();
    assert(h.ok && h.v === SERVER_PROTOCOL_VERSION, `Worker: /health answers (protocol ${h.v})`);
    const page = await (await fetch(`${URL_}/`)).text();
    assert(/<html/i.test(page) && /TimeTunesr/.test(page), 'Worker: the app page loads from the assets');
    assert((await fetch(`${URL_}/js/multi/game.js`)).ok, 'Worker: app files are served');
    const unknown = await fetch(`${URL_}/bestaat/niet`);
    assert(unknown.status === 404, 'Worker: an unknown path is a plain 404, not the room server');
    const evil = await fetch(`${URL_}/rooms`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{"v":1,"id":"owner01"}' });
    assert(evil.status === 403, 'Worker: other web sites are refused');

    const host = await phone(browser, local, { seed: 7 });
    const H = host.page;
    await H.goto(`${URL_}/#/spelleider`);
    const code = await createRoom(H);
    assert(true, `room ${code} in a Durable Object (app and server on one address)`);
    const P = (await phone(browser, local)).page;
    await joinRoom(P, `${URL_}/`, code, 'Sam');
    await waitForPlayers(H, 1);
    await H.getByTestId('room-game-bingo').check(); // the lobby now starts on Discobingo
    await H.getByTestId('room-size-3').check();
    await H.getByTestId('room-start').click();
    await P.locator('[data-testid="play-panel"]').waitFor({ timeout: 20000 });
    const song = (await serverHost(H)).song;
    const msgs = JSON.stringify(await P.evaluate(() => window.__ttRoom.session.received));
    assert(song?.title && !msgs.includes(song.title) && !msgs.includes(song.previewUrl), 'the song reaches the music phone only');
    await P.getByTestId('answer-pass').click();
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 20000 });
    await H.getByTestId('room-reveal').click();
    await P.locator('[data-view="revealed"]').first().waitFor({ timeout: 20000 });
    assert(true, 'one round over the Cloudflare version');
    const card = await P.evaluate(() => window.__ttRoom.session.view.game.mine.card.join());
    await H.getByTestId('room-next').click();
    await P.waitForFunction(() => window.__ttRoom.session.view?.game?.round === 2, null, { timeout: 20000 });

    // restart: the room must come back from Durable Object storage (no backup on the phone)
    await H.evaluate(() => localStorage.removeItem('timetunesr.multiServerBackup.v1'));
    await stopWrangler(wr);
    wr = await startWrangler(persist);
    const info = await (await fetch(`${URL_}/rooms/${code}`)).json();
    assert(info.exists === true && info.phase === 'answering', 'after the restart the room is still there (Durable Object storage)');
    await H.locator('[data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 40000 });
    await P.waitForFunction(() => window.__ttRoom.session.status === 'online' && window.__ttRoom.session.view?.game?.round === 2, null, { timeout: 40000 });
    assert(await P.evaluate(() => window.__ttRoom.session.view.game.mine.card.join()) === card, 'phones reconnect: same round, same card');
    await P.getByTestId('answer-pass').click();
    await H.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 20000 });
    await H.getByTestId('room-reveal').click();
    await P.locator('[data-view="revealed"]').first().waitFor({ timeout: 20000 });
    assert(true, 'the game goes on after the restart');

    // ---------- Quiz: the timer (Durable Object alarm) closes a question; restart mid-question ----------
    const qh = await phone(browser, local, { seed: 7 });
    await installFakeItunes(qh.context);
    const QH = qh.page;
    await QH.goto(`${URL_}/#/spelleider`);
    const qcode = await createRoom(QH);
    const qp = await phone(browser, local);
    await installFakeItunes(qp.context);
    const QP = qp.page;
    await joinRoom(QP, `${URL_}/`, qcode, 'Quinn');
    await waitForPlayers(QH, 1);
    await QH.getByTestId('room-game-quiz').check();
    await QH.getByTestId('room-quiz-time-15').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await QH.getByTestId('room-quiz-time-15').check();
    await QH.locator('[data-testid="room-quiz-time-15"]:checked').waitFor();
    await QH.getByTestId('room-start').click();
    const qround = async (r) => QP.waitForFunction((n) => { const v = window.__ttRoom?.session?.view; return v?.phase === 'answering' && v.game.round === n && v.game.quiz.deadline; }, r, { timeout: 30000 });
    await qround(1);
    await QP.getByTestId('quiz-option-0').click();
    await QP.locator('[data-view="revealed"]').first().waitFor({ timeout: 15000 });
    assert(true, 'quiz on Cloudflare: the only player answered, the question closes at once');
    await QH.getByTestId('room-next').click();
    await qround(2);
    const t0 = Date.now();
    await QP.locator('[data-view="revealed"]').first().waitFor({ timeout: 40000 });
    assert(Date.now() - t0 > 10000 && (await QP.evaluate(() => window.__ttRoom.session.view.game.quiz.reveal.mine.none)), `nobody answered: the Durable Object alarm closed the question after ${Math.round((Date.now() - t0) / 1000)} s`);
    await QH.getByTestId('room-next').click();
    await qround(3);
    await QH.evaluate(() => localStorage.removeItem('timetunesr.multiServerBackup.v1'));
    await stopWrangler(wr);
    wr = await startWrangler(persist);
    await QP.waitForFunction(() => { const s = window.__ttRoom.session; return s.status === 'online' && s.meta && s.view?.game?.round === 3 && s.view.phase === 'answering' && s.view.game.quiz.deadline; }, null, { timeout: 60000 });
    assert(true, 'after the restart: same question 3, the clock runs again (the music phone said so)');
    await QP.getByTestId('quiz-option-1').click();
    await QP.locator('[data-view="revealed"]').first().waitFor({ timeout: 15000 });
    assert((await QP.evaluate(() => window.__ttRoom.session.view.game.round)) === 3, 'question 3 answered and revealed after the restart');
    assert(QH.errors.length === 0 && QP.errors.length === 0, `no page errors in the quiz (${[...QH.errors, ...QP.errors].join('; ')})`);
    // ---------- Discobingo: a round, a stamp, and a restart in the middle of a round ----------
    const dh = await phone(browser, local, { seed: 7 });
    await installFakeItunes(dh.context);
    const DH = dh.page;
    await DH.goto(`${URL_}/#/spelleider`);
    const dcode = await createRoom(DH);
    const dp = await phone(browser, local);
    await installFakeItunes(dp.context);
    const DP = dp.page;
    await joinRoom(DP, `${URL_}/`, dcode, 'Dina');
    await waitForPlayers(DH, 1);
    assert(await DH.getByTestId('room-game-disco').isChecked(), 'Discobingo on Cloudflare: the lobby starts on Discobingo');
    await DH.getByTestId('room-start').click();
    const dround = (r) => DP.waitForFunction((n) => { const v = window.__ttRoom?.session?.view; return v?.phase === 'answering' && v.game.round === n && v.game.kind === 'disco'; }, r, { timeout: 30000 });
    const dright = async () => {
      const { song } = await serverHost(DH);
      const cat = (await DP.evaluate(() => window.__ttRoom.session.view.game.disco.cat));
      const ans = cat === 'decade' ? { decade: Math.floor(song.year / 10) * 10 } : cat === 'year' ? { guess: String(song.year) } : { text: cat === 'artist' ? song.artist : song.title };
      await DP.evaluate((a) => window.__ttRoom.session.answer(a), ans); // no waiting for the ball: the server takes the answer
      await DP.waitForFunction(() => window.__ttRoom.session.view.game.answer != null);
    };
    await dround(1);
    await dright();
    await DH.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });
    await DH.getByTestId('room-reveal').click();
    await DP.waitForFunction(() => window.__ttRoom.session.view.phase === 'revealed');
    const rv = await DP.evaluate(() => window.__ttRoom.session.view);
    assert(rv.game.reveal.mine.verdict === 'right' && rv.game.disco.choosable.length > 0, 'discobingo on Cloudflare: the answer is judged right by the Durable Object');
    const sqIdx = rv.game.disco.choosable[0];
    await DP.evaluate((i) => window.__ttRoom.session.stamp(i), sqIdx);
    await DP.waitForFunction((i) => window.__ttRoom.session.view.game.mine.marks[i] != null, sqIdx);
    assert(true, 'discobingo on Cloudflare: one reveal and one stamp');
    await DH.getByTestId('room-next').click();
    await dround(2);
    const before = await DP.evaluate(() => { const v = window.__ttRoom.session.view; return { cat: v.game.disco.cat, spin: v.game.disco.spin, marks: v.game.mine.marks, card: v.game.mine.card }; });
    await DH.evaluate(() => localStorage.removeItem('timetunesr.multiServerBackup.v1')); // so it can only come back from Durable Object storage
    await stopWrangler(wr);
    wr = await startWrangler(persist);
    await DP.waitForFunction(() => { const s = window.__ttRoom.session; return s.status === 'online' && s.meta && s.view?.game?.round === 2 && s.view.phase === 'answering'; }, null, { timeout: 60000 });
    const afterRestart = await DP.evaluate(() => { const v = window.__ttRoom.session.view; return { cat: v.game.disco.cat, marks: v.game.mine.marks, card: v.game.mine.card }; });
    assert(afterRestart.cat === before.cat && afterRestart.card.join() === before.card.join() && afterRestart.marks.join() === before.marks.join(), 'after the restart: same round, same category, same card, same stamp');
    await DH.waitForFunction(() => window.__ttHost.session.currentSong(), null, { timeout: 60000 });
    await dright();
    await DH.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 15000 });
    await DH.getByTestId('room-reveal').click();
    await DP.waitForFunction(() => window.__ttRoom.session.view.phase === 'revealed' && window.__ttRoom.session.view.game.reveal.mine.verdict === 'right');
    assert(true, 'discobingo on Cloudflare: round 2 survived the restart and was revealed');
    assert(DH.errors.length === 0 && DP.errors.length === 0, `no page errors in discobingo (${[...DH.errors, ...DP.errors].join('; ')})`);
    // ---------- Mix van de groep: contributions survive a restart (Durable Object storage) ----------
    const mh = await mixPhone(browser, local, `${URL_}/`, ACCOUNTS.ilse, { seed: 7, token: `${PLAYBACK} ${TOP}` });
    const MH = mh.page;
    await MH.goto(`${URL_}/#/spelleider`);
    const mcode = await createRoom(MH);
    const mp = await mixPhone(browser, local, `${URL_}/`, ACCOUNTS.bram, { token: `${PLAYBACK} ${TOP}` });
    const MP = mp.page;
    await joinRoom(MP, `${URL_}/`, mcode, 'Bram');
    await waitForPlayers(MH, 1);
    await MH.getByTestId('room-game-bingo').check(); // the lobby now starts on Discobingo
    await MH.getByTestId('room-size-3').check();
    await shareFavourites(MP);
    await shareFavourites(MH);
    await waitShared(MP, 10);
    await waitShared(MH, 10);
    const contributed = new Map([...(await myShared(MP)), ...(await myShared(MH))].map((t) => [t.spotifyId, t]));
    await MH.waitForFunction(() => document.querySelector('[data-testid="mix-counts"]')?.dataset.contributors === '2', null, { timeout: 20000 });
    const total = Number(await MH.getByTestId('mix-counts').getAttribute('data-total'));
    assert(total === contributed.size, `two phones added their favourites: ${total} songs in the Durable Object`);
    // the phones forget their own copy: after the restart the songs can only come from the server's storage
    for (const pg of [MH, MP]) { await pg.evaluate(() => localStorage.removeItem('timetunesr.mixShare.v1')); await pg.goto('about:blank'); }
    await stopWrangler(wr);
    wr = await startWrangler(persist);
    // the player comes back first: the spelleider's Spotify Client ID comes from Durable Object storage
    await MP.goto(`${URL_}/#/kamer/${mcode}`);
    await MP.waitForFunction((cid) => window.__ttRoom?.session?.meta?.spotifyClientId === cid, CLIENT_ID, { timeout: 40000 });
    assert(true, 'the spelleider\'s Spotify Client ID is kept with the room (Durable Object) and passed to the players');
    await MH.goto(`${URL_}/#/spelleider`);
    await MH.locator('[data-testid="screen-room-host"][data-view="lobby"] [data-testid="conn-status"][data-state="online"]').waitFor({ timeout: 40000 });
    await MH.waitForFunction((n) => Number(document.querySelector('[data-testid="mix-counts"]')?.dataset.total) === n, total, { timeout: 20000 });
    assert(true, `after the restart the room still has the ${total} contributed songs`);
    await MH.getByTestId('room-game-bingo').check();
    await MH.getByTestId('room-music-mix').check();
    await MP.getByTestId('room-music-is-mix').waitFor({ timeout: 20000 });
    await MH.getByTestId('room-start').click();
    await MP.locator('[data-testid="play-panel"]').waitFor({ timeout: 20000 });
    const ms = (await serverHost(MH)).song;
    assert(contributed.has(ms.spotifyId) && contributed.get(ms.spotifyId).title === ms.title, `a game from the mix: "${ms.title}" is a contributed song`);
    const pm = JSON.stringify(await MP.evaluate(() => window.__ttRoom.session.received));
    assert(![...contributed.values()].some((t) => pm.includes(JSON.stringify(t.title)) && t.spotifyId !== ms.spotifyId) && !pm.includes(JSON.stringify(ms.title)), 'nothing of the mix reached the player before the reveal');
    await MP.getByTestId('answer-pass').click();
    await MH.locator('[data-testid="room-reveal"][data-ready="true"]').waitFor({ timeout: 20000 });
    await MH.getByTestId('room-reveal').click();
    await MP.getByTestId('room-song-by').waitFor({ timeout: 20000 });
    assert(true, 'one round from the mix over the Cloudflare version, with whose favourite it was');
    assert(MH.errors.length === 0 && MP.errors.length === 0, `no page errors in the mix part (${[...MH.errors, ...MP.errors].join('; ')})`);
    globalThis.__ttWrangler = wr;
    await bigListsOnWorker();
    wr = globalThis.__ttWrangler;
    assert(H.errors.length === 0 && P.errors.length === 0, `no page errors (${[...H.errors, ...P.errors].join('; ')})`);
  } finally {
    await browser.close();
    await stopWrangler(wr);
    rmSync(persist, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
