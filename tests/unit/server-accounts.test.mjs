// Accounts on the room server (server/accounts.mjs, account-http.mjs, prepared.mjs through
// server/core.mjs) without any network: a fake clock and fake sockets. Sign-up / log-in /
// log-out, wrong passwords and the lockout, username rules, sessions (expiry, revocation),
// the recovery code, the data checks and the revision rule, prepared rooms, CORS, rate
// limits, persistence in a file, and that no password, hash or token ever leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomServer } from '../../server/core.mjs';
import { ROOM_IDLE_MS, PREPARED_IDLE_MS } from '../../server/room.mjs';
import {
  hashPassword, verifyPassword, timingSafeEqual, parseToken, usernameProblem, validateData, PBKDF2_ITERATIONS,
  SESSION_MS, LOGIN_FAILS, MAX_PREPARED_ROOMS, MAX_DATA_BYTES, MAX_PLAYLIST_BYTES,
} from '../../server/accounts.mjs';
import { SERVER_PROTOCOL_VERSION } from '../../app/js/multi/server-protocol.js';

const V = SERVER_PROTOCOL_VERSION;
const ORIGIN = 'http://localhost:8080';
const PW = 'geheim-wachtwoord-1';
const SPOTIFY = '0123456789abcdef0123456789abcdef';
const flush = () => new Promise((r) => setTimeout(r, 30));

function setup(opts = {}) {
  let t = 1_800_000_000_000;
  const logs = [];
  const core = createRoomServer({ now: () => t, iterations: 1000, log: (...a) => logs.push(a.map(String).join(' ')), ...opts });
  const call = async (method, path, body, { token, ip = '10.0.0.1', origin = ORIGIN, raw } = {}) => {
    const r = await core.http({ method, path, origin, ip, auth: token ? `Bearer ${token}` : '', body: raw ?? (body == null ? '' : JSON.stringify(body)) });
    return r;
  };
  return { core, call, logs, advance: (ms) => { t += ms; }, now: () => t };
}

async function signup(call, username = 'Ilse', password = PW, opts = {}) {
  const r = await call('POST', '/account/signup', { username, password }, opts);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const playlist = (id, updated, n = 2, extra = {}) => ({
  id, name: `Lijst ${id}`, created: 1, updated, nextN: n + 1,
  tracks: Array.from({ length: n }, (_, i) => ({ n: i + 1, itunesId: 100 + i, title: `T${i}`, artist: `A${i}`, album: '', year: 1980 + i, yearSure: true, previewUrl: `https://x.example/${i}.m4a`, trackViewUrl: null })),
  ...extra,
});

/** A fake WebSocket client of the room. */
function connect(core, code) {
  const up = core.upgrade({ path: `/rooms/${code}/ws`, origin: ORIGIN, ip: '10.0.0.9' });
  assert.ok(up.ok);
  const msgs = [];
  const p = { msgs, closed: null };
  p.conn = up.attach({ send: (text) => msgs.push(text === 'pong' ? 'pong' : JSON.parse(text)), close: (c, reason) => { p.closed = { c, reason }; } });
  p.send = (m) => p.conn.message(JSON.stringify(m));
  p.last = (t) => [...msgs].reverse().find((m) => m.t === t) || null;
  return p;
}

test('account: aanmaken, inloggen (hoofdletters maakt niet uit), gegevens ophalen, uitloggen', async () => {
  const { call } = setup();
  const a = await signup(call, 'Ilse_86');
  assert.match(a.token, /^tta1\.ilse_86\.[A-Za-z0-9_-]{43}$/);
  assert.match(a.recoveryCode, /^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/);
  assert.equal(a.account.username, 'Ilse_86'); // shown as typed
  const l = await call('POST', '/account/login', { username: 'ILSE_86', password: PW });
  assert.equal(l.status, 200);
  assert.notEqual(l.body.token, a.token);
  const g = await call('GET', '/account', null, { token: l.body.token });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.data, { spotifyClientId: '', playlists: [], deleted: {}, prefs: {} });
  assert.equal(g.body.rev, 1);
  assert.equal(g.body.account.sessions, 2);
  const out = await call('POST', '/account/logout', null, { token: l.body.token });
  assert.equal(out.status, 200);
  assert.equal((await call('GET', '/account', null, { token: l.body.token })).status, 401);
  assert.equal((await call('GET', '/account', null, { token: a.token })).status, 200, 'the other session stays');
  // no token, a broken one, a token of another name
  assert.equal((await call('GET', '/account')).body.code, 'session');
  assert.equal((await call('GET', '/account', null, { token: 'tta1.ilse_86.kapot' })).status, 401);
  assert.equal((await call('GET', '/account', null, { token: a.token.replace('ilse_86', 'iemand') })).status, 401);
});

test('account: gebruikersnaam-regels en dubbele namen (hoofdletterongevoelig)', async () => {
  const { call } = setup();
  for (const [name, why] of [['ab', 'kort'], ['a'.repeat(25), 'lang'], ['jan piet', 'spatie'], ['jöran', 'accent'], ['Admin', 'gereserveerd'], ['spelleider', 'gereserveerd'], ['', 'leeg']]) {
    const r = await call('POST', '/account/signup', { username: name, password: PW });
    assert.equal(r.status, 400, `${why}: ${name}`);
    assert.equal(r.body.code, 'username');
    assert.ok(r.body.message.length > 10);
  }
  assert.equal(usernameProblem('Jan-Piet_3'), null);
  await signup(call, 'Ilse');
  const again = await call('POST', '/account/signup', { username: 'iLSE', password: PW }, { ip: '10.0.0.2' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'taken');
  const short = await call('POST', '/account/signup', { username: 'Bram', password: 'kort' });
  assert.equal(short.status, 400);
  assert.match(short.body.message, /minstens 8/);
  assert.equal((await call('POST', '/account/signup', { username: 'Bram', password: 'x'.repeat(201) })).status, 400);
});

test('account: fout wachtwoord, blokkade na te veel pogingen en het einde daarvan', async () => {
  const { call, advance } = setup();
  await signup(call, 'Ilse');
  // an unknown name and a wrong password look exactly the same
  const unknown = await call('POST', '/account/login', { username: 'niemand', password: PW }, { ip: '10.0.0.5' });
  const wrong = await call('POST', '/account/login', { username: 'ilse', password: 'verkeerd1' }, { ip: '10.0.0.6' });
  assert.deepEqual([unknown.status, unknown.body], [wrong.status, wrong.body]);
  assert.deepEqual(wrong.body, { code: 'login', message: 'Gebruikersnaam of wachtwoord klopt niet.' });
  // from many addresses (so the per-IP limit does not kick in): the account itself locks
  for (let i = 1; i < LOGIN_FAILS.limit; i++) await call('POST', '/account/login', { username: 'ilse', password: 'verkeerd1' }, { ip: `10.1.0.${i}` });
  const locked = await call('POST', '/account/login', { username: 'ilse', password: PW }, { ip: '10.2.0.1' });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, 'locked');
  // an unknown name locks the same way, so a lock tells nothing about whether a name exists
  for (let i = 0; i < LOGIN_FAILS.limit; i++) await call('POST', '/account/login', { username: 'niemand', password: 'verkeerd1' }, { ip: `10.3.0.${i}` });
  const ghost = await call('POST', '/account/login', { username: 'niemand', password: PW }, { ip: '10.2.0.2' });
  assert.deepEqual([ghost.status, ghost.body], [locked.status, locked.body]);
  advance(LOGIN_FAILS.lockMs + 1000);
  const ok = await call('POST', '/account/login', { username: 'ilse', password: PW }, { ip: '10.2.0.3' });
  assert.equal(ok.status, 200, 'the lock ends by itself');
  // a successful login resets the count: one wrong try later does not lock again
  await call('POST', '/account/login', { username: 'ilse', password: 'verkeerd1' }, { ip: '10.2.0.4' });
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: PW }, { ip: '10.2.0.5' })).status, 200);
});

test('account: sessie verloopt na 90 dagen zonder gebruik, gebruik schuift het op; overal uitloggen', async () => {
  const { call, advance } = setup();
  const a = await signup(call, 'Ilse');
  const b = (await call('POST', '/account/login', { username: 'ilse', password: PW })).body.token;
  advance(SESSION_MS - 24 * 3600e3);
  assert.equal((await call('GET', '/account', null, { token: a.token })).status, 200, 'used on day 89: slides on');
  advance(2 * 24 * 3600e3);
  assert.equal((await call('GET', '/account', null, { token: a.token })).status, 200);
  assert.equal((await call('GET', '/account', null, { token: b })).status, 401, 'never used for 91 days');
  const c = (await call('POST', '/account/login', { username: 'ilse', password: PW })).body.token;
  const all = await call('POST', '/account/logout-all', null, { token: c });
  assert.equal(all.status, 200);
  assert.equal(all.body.revoked, 2);
  for (const t of [a.token, c]) assert.equal((await call('GET', '/account', null, { token: t })).status, 401);
});

test('account: herstelcode zet een nieuw wachtwoord, beëindigt alle sessies en wordt vervangen', async () => {
  const { call } = setup();
  const a = await signup(call, 'Ilse');
  const bad = await call('POST', '/account/recover', { username: 'ilse', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', password: 'nieuw-wachtwoord' });
  assert.equal(bad.status, 401);
  const none = await call('POST', '/account/recover', { username: 'niemand', recoveryCode: a.recoveryCode, password: 'nieuw-wachtwoord' }, { ip: '10.0.0.7' });
  assert.deepEqual(none.body, bad.body, 'an unknown name answers the same');
  const r = await call('POST', '/account/recover', { username: 'ILSE', recoveryCode: a.recoveryCode.toLowerCase().replace(/-/g, ' '), password: 'nieuw-wachtwoord' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.recoveryCode, a.recoveryCode);
  assert.equal((await call('GET', '/account', null, { token: a.token })).status, 401, 'old sessions end');
  assert.equal((await call('GET', '/account', null, { token: r.body.token })).status, 200);
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: PW })).status, 401);
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: 'nieuw-wachtwoord' })).status, 200);
  const reuse = await call('POST', '/account/recover', { username: 'ilse', recoveryCode: a.recoveryCode, password: 'nog-een-wachtwoord' });
  assert.equal(reuse.status, 401, 'a used code does not work twice');
});

test('account: wachtwoord wijzigen logt de andere toestellen uit, dit toestel niet', async () => {
  const { call } = setup();
  const a = await signup(call, 'Ilse');
  const b = (await call('POST', '/account/login', { username: 'ilse', password: PW })).body.token;
  const wrong = await call('POST', '/account/password', { password: 'verkeerd1', newPassword: 'nieuw-wachtwoord' }, { token: a.token });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'password');
  assert.equal((await call('GET', '/account', null, { token: a.token })).status, 200, 'a wrong current password does not log out');
  const ch = await call('POST', '/account/password', { password: PW, newPassword: 'nieuw-wachtwoord' }, { token: a.token });
  assert.equal(ch.status, 200);
  assert.equal(ch.body.revoked, 1);
  assert.equal((await call('GET', '/account', null, { token: a.token })).status, 200);
  assert.equal((await call('GET', '/account', null, { token: b })).status, 401);
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: 'nieuw-wachtwoord' })).status, 200);
});

test('account-gegevens: playlists, Spotify Client ID en voorkeuren veld voor veld gecontroleerd', async () => {
  const { call } = setup();
  const { token } = await signup(call, 'Ilse');
  let rev = 1;
  const save = (data, r = rev) => call('POST', '/account/data', { rev: r, data }, { token });
  const good = await save({ spotifyClientId: SPOTIFY.toUpperCase(), playlists: [playlist('p1', 10, 3, { extraField: 'weg', shareId: 'ab12' })], prefs: { hostName: '  Ilse  ', hostPlays: true, music: 'p1' } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  rev = good.body.rev;
  assert.equal(good.body.data.spotifyClientId, SPOTIFY);
  assert.equal(good.body.data.playlists[0].extraField, undefined, 'unknown fields are not stored');
  assert.equal(good.body.data.playlists[0].shareId, 'ab12');
  assert.deepEqual(good.body.data.prefs, { hostName: 'Ilse', hostPlays: true, music: 'p1' });
  const refused = [
    ['geen id', { playlists: [{ ...playlist('x', 1), id: '' }] }],
    ['ingebouwd deck', { playlists: [playlist('builtin', 1)] }],
    ['zelfde id', { playlists: [playlist('p1', 1), playlist('p1', 2)] }],
    ['nummer zonder id', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, title: 'x', year: 1990 }] }] }],
    ['dubbel kaartnummer', { playlists: [{ ...playlist('p2', 1), tracks: [...playlist('p2', 1).tracks, { ...playlist('p2', 1).tracks[0] }] }] }],
    ['http-adres', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, itunesId: 5, previewUrl: 'http://x.example/a' }] }] }],
    ['titel geen tekst', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, itunesId: 5, title: { a: 1 } }] }] }],
    ['geen datum', { playlists: [{ ...playlist('p2', 1), updated: 'gisteren' }] }],
    ['onbekend onderdeel', { tokens: {} }],
    ['token als Spotify', { spotifyClientId: 'BQDs9xY7tokenTokenTokenTokenTokenTokenToken' }],
    ['secret met voorvoegsel', { spotifyClientId: `secret:${SPOTIFY}` }],
    ['33 tekens', { spotifyClientId: `${SPOTIFY}0` }],
    ['voorkeur fout type', { prefs: { hostPlays: 'ja' } }],
    ['__proto__', JSON.parse(`{"prefs": {"__proto__": {"admin": true}}}`)],
    ['constructor in nummer', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, itunesId: 5, constructor: { x: 1 } }] }] }],
    ['deezer-id tekst', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, deezerId: '12' }] }] }],
    ['deezer-id negatief', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, itunesId: 5, deezerId: -3 }] }] }],
    ['isrc kapot', { playlists: [{ ...playlist('p2', 1), tracks: [{ n: 1, itunesId: 5, isrc: 'usrc1760783' }] }] }],
    ['herkomst onbekend', { playlists: [playlist('p2', 1, 2, { source: { kind: 'youtube', id: 'x', name: 'y' } })] }],
    ['herkomst spotify-id kapot', { playlists: [playlist('p2', 1, 2, { source: { kind: 'spotify', id: 'kort', name: 'y' } })] }],
    ['stub van onbekende playlist', { playlists: [{ id: 'nope', updated: 1, same: true }] }],
    ['te veel nummers', { playlists: [playlist('p2', 1, 2001)] }],
    ['een playlist te groot', { playlists: [{ ...playlist('p2', 1, 2000), tracks: playlist('p2', 1, 2000).tracks.map((t) => ({ ...t, title: 'T'.repeat(200), artist: 'A'.repeat(200), album: 'B'.repeat(200) })) }] }],
  ];
  for (const [why, data] of refused) {
    const r = await save(data);
    if (why === 'stub van onbekende playlist') { assert.equal(r.status, 409, why); assert.equal(r.body.code, 'conflict', why); continue; }
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.code, 'data', why);
    assert.ok(r.body.message, why);
  }
  assert.equal(({}).admin, undefined, 'nothing polluted');
  // too big in total: 413 (each playlist is fine on its own)
  const long = (id) => ({ ...playlist(id, 1, 2000), tracks: playlist(id, 1, 2000).tracks.map((t) => ({ ...t, previewUrl: null, title: `${'T'.repeat(150)}${t.n}`, artist: 'A'.repeat(60) })) });
  const big = Array.from({ length: 11 }, (_, i) => long(`b${i}`));
  assert.ok(JSON.stringify(big[0]).length < MAX_PLAYLIST_BYTES);
  const tooBig = await save({ playlists: big });
  assert.equal(tooBig.status, 413, JSON.stringify(tooBig.body).slice(0, 200));
  assert.ok(JSON.stringify(big).length > MAX_DATA_BYTES);
  // the account is unchanged after all refusals
  const g = await call('GET', '/account', null, { token });
  assert.equal(g.body.rev, rev);
  assert.equal(g.body.data.playlists.length, 1);
  // the raw body itself: not JSON, too large
  assert.equal((await call('POST', '/account/data', null, { token, raw: '{kapot' })).status, 400);
  assert.equal((await call('POST', '/account/data', null, { token, raw: 'x'.repeat(2 * MAX_DATA_BYTES) })).status, 413);
  assert.equal(validateData({ playlists: [] }).error, undefined);
});

test('account-gegevens: alleen opslaan met de nieuwste versie (rev); anders conflict met de actuele gegevens', async () => {
  const { call } = setup();
  const { token } = await signup(call, 'Ilse');
  const a = await call('POST', '/account/data', { rev: 1, data: { playlists: [playlist('p1', 10)] } }, { token });
  assert.equal(a.body.rev, 2);
  const stale = await call('POST', '/account/data', { rev: 1, data: { spotifyClientId: SPOTIFY } }, { token });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'conflict');
  assert.equal(stale.body.rev, 2);
  assert.equal(stale.body.data.playlists[0].id, 'p1', 'the conflict carries the current data to merge with');
  // one section at a time: what was not sent stays
  const b = await call('POST', '/account/data', { rev: 2, data: { spotifyClientId: SPOTIFY } }, { token });
  assert.equal(b.status, 200);
  assert.equal(b.body.data.playlists.length, 1);
  assert.equal((await call('POST', '/account/data', { data: {} }, { token })).status, 400, 'no rev');
});

async function prepare(call, token, extra = {}) {
  const r = await call('POST', '/account/rooms', { name: 'Feest zaterdag', settings: { game: 'disco', win: 'line2' }, music: 'p1', play: 'preview', hostPlays: true, hostName: 'Ilse', ...extra }, { token });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.room;
}

test('klaargezette kamer: maken, lijst, naam openbaar, hoogstens 5, bewerken, verwijderen', async () => {
  const { call, core } = setup();
  const { token } = await signup(call, 'Ilse');
  const room = await prepare(call, token);
  assert.match(room.code, /^[A-Z]{4}$/);
  assert.equal(room.name, 'Feest zaterdag');
  assert.equal(room.settings.game, 'disco');
  assert.equal(room.settings.win, 'line2');
  assert.equal(room.settings.music, 'deck');
  assert.equal(room.music, 'p1');
  assert.equal(room.hostPlays, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.expiresAt - room.lastActive, PREPARED_IDLE_MS);
  const info = await call('GET', `/rooms/${room.code}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.name, 'Feest zaterdag', 'the name is public');
  assert.equal(JSON.stringify(info.body).includes('ilse'), false, 'nothing else of the account');
  for (let i = 1; i < MAX_PREPARED_ROOMS; i++) await prepare(call, token, { name: `Kamer ${i}`, music: 'mix' });
  const sixth = await call('POST', '/account/rooms', { name: 'Te veel' }, { token });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, 'limit');
  const list = await call('GET', '/account/rooms', null, { token });
  assert.equal(list.body.rooms.length, MAX_PREPARED_ROOMS);
  assert.equal(list.body.max, MAX_PREPARED_ROOMS);
  assert.equal(list.body.rooms[1].settings.music, 'mix');
  // edit
  const ed = await call('POST', `/account/rooms/${room.code}`, { name: 'Feest zondag', settings: { game: 'quiz' }, hostPlays: false, hostName: 'Ilse B' }, { token });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.room.name, 'Feest zondag');
  assert.equal(ed.body.room.settings.game, 'quiz');
  assert.equal(ed.body.room.hostPlays, false);
  assert.equal(core.rooms.get(room.code).state.room.players.length, 0, 'the host seat left with hostPlays off');
  assert.equal((await call('GET', `/rooms/${room.code}`)).body.name, 'Feest zondag');
  assert.equal((await call('POST', `/account/rooms/${room.code}`, { name: '' }, { token })).status, 400);
  // delete: the room is gone, a place is free again
  assert.equal((await call('POST', `/account/rooms/${room.code}/delete`, null, { token })).status, 200);
  assert.equal((await call('GET', `/rooms/${room.code}`)).status, 404);
  await prepare(call, token, { name: 'Weer plek' });
  assert.equal((await call('POST', `/account/rooms/${list.body.rooms[1].code}/delete`, null, { token })).status, 200);
  const badMusic = await call('POST', '/account/rooms', { name: 'x', music: '../../etc' }, { token });
  assert.equal(badMusic.status, 400);
});

test('klaargezette kamer: openen op een tweede toestel maakt dat de spelleider; het oude krijgt "replaced"', async () => {
  const { call, core } = setup();
  const { token } = await signup(call, 'Ilse');
  const room = await prepare(call, token, { hostPlays: false });
  // a guest joins early and waits in the lobby, seeing the room's name
  const guest = connect(core, room.code);
  guest.send({ t: 'hello', v: V, code: room.code, id: 'gast0001', name: 'Gast' });
  await flush();
  assert.equal(guest.last('state').meta.roomName, 'Feest zaterdag');
  const one = await call('POST', `/account/rooms/${room.code}/open`, null, { token });
  assert.equal(one.status, 200);
  assert.match(one.body.id, /^[A-Za-z0-9_-]{4,40}$/);
  const host1 = connect(core, room.code);
  host1.send({ t: 'hello', v: V, code: room.code, id: one.body.id, token: one.body.token });
  await flush();
  assert.equal(host1.last('welcome').owner, true);
  assert.ok(host1.last('state').lead, 'the leader part');
  // the second device (another login of the same account)
  const t2 = (await call('POST', '/account/login', { username: 'ilse', password: PW })).body.token;
  const two = await call('POST', `/account/rooms/${room.code}/open`, null, { token: t2 });
  assert.equal(two.status, 200);
  assert.equal(two.body.id, one.body.id, 'the same owner seat');
  assert.notEqual(two.body.token, one.body.token);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(host1.last('error')?.code, 'replaced');
  assert.equal(host1.closed?.reason, 'replaced');
  const host2 = connect(core, room.code);
  host2.send({ t: 'hello', v: V, code: room.code, id: two.body.id, token: two.body.token });
  await flush();
  assert.equal(host2.last('welcome').owner, true);
  assert.deepEqual(host2.last('state').lead.room.players.map((p) => p.id), ['gast0001'], 'the guest who waited is there');
  // the old token does not work any more
  const old = connect(core, room.code);
  old.send({ t: 'hello', v: V, code: room.code, id: one.body.id, token: one.body.token });
  await flush();
  assert.equal(old.last('error').code, 'token');
});

test('klaargezette kamer: opnieuw gebruiken leegt spelers en spel, code en instellingen blijven; sluiten doet hetzelfde', async () => {
  const { call, core } = setup();
  const { token } = await signup(call, 'Ilse');
  const room = await prepare(call, token, { hostPlays: true, settings: { game: 'bingo', size: 3 } });
  const o = (await call('POST', `/account/rooms/${room.code}/open`, null, { token })).body;
  const host = connect(core, room.code);
  host.send({ t: 'hello', v: V, code: room.code, id: o.id, token: o.token });
  const p = connect(core, room.code);
  p.send({ t: 'hello', v: V, code: room.code, id: 'speler01', name: 'Sanne' });
  await flush();
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, year: 1970 + i, title: `T${i}`, artist: `A${i}` }));
  host.send({ t: 'start', cards });
  await flush();
  assert.equal(core.rooms.get(room.code).state.room.phase, 'answering');
  const r = await call('POST', `/account/rooms/${room.code}/reset`, null, { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.room.code, room.code);
  assert.equal(r.body.room.phase, 'lobby');
  assert.equal(r.body.room.players, 0);
  assert.equal(r.body.room.settings.size, 3);
  await flush();
  assert.equal(p.last('error').code, 'closed');
  const st = core.rooms.get(room.code).state;
  assert.deepEqual(st.room.players.map((x) => x.id), [o.id], 'only the host seat (hostPlays)');
  assert.deepEqual(Object.keys(st.members), [o.id]);
  // the owner token of the last open still works
  const back = connect(core, room.code);
  back.send({ t: 'hello', v: V, code: room.code, id: o.id, token: o.token });
  await flush();
  assert.equal(back.last('welcome').owner, true);
  // "Sluit kamer" on the host screen empties a prepared room instead of ending it
  back.send({ t: 'close' });
  await flush();
  assert.equal(back.last('error').code, 'closed');
  assert.equal((await call('GET', `/rooms/${room.code}`)).status, 200);
  assert.equal((await call('GET', '/account/rooms', null, { token })).body.rooms[0].exists, true);
});

test('klaargezette kamer: leeft 30 dagen na de laatste activiteit; een gewone kamer zoals altijd', async () => {
  const { call, core, advance } = setup();
  const { token } = await signup(call, 'Ilse');
  const room = await prepare(call, token);
  const normal = core.http({ method: 'POST', path: '/rooms', origin: ORIGIN, ip: '10.0.0.1', body: JSON.stringify({ v: V, id: 'owner01', name: 'X' }) }).body;
  advance(ROOM_IDLE_MS + 60000);
  core.sweep();
  assert.equal((await call('GET', `/rooms/${normal.code}`)).status, 404, 'a normal room: as today');
  assert.equal((await call('GET', `/rooms/${room.code}`)).status, 200);
  advance(20 * 24 * 3600e3);
  core.sweep();
  // using it (open) counts as activity
  assert.equal((await call('POST', `/account/rooms/${room.code}/open`, null, { token })).status, 200);
  advance(PREPARED_IDLE_MS - 60000);
  core.sweep();
  assert.equal((await call('GET', `/rooms/${room.code}`)).status, 200);
  advance(120000);
  core.sweep();
  assert.equal((await call('GET', `/rooms/${room.code}`)).status, 404, 'expired after 30 idle days');
  const list = await call('GET', '/account/rooms', null, { token });
  assert.equal(list.body.rooms[0].exists, false);
  // "Nog een keer gebruiken" brings it back with the same code and settings
  const again = await call('POST', `/account/rooms/${room.code}/reset`, null, { token });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.recreated, true);
  assert.equal(again.body.room.code, room.code);
  assert.equal(again.body.room.settings.win, 'line2');
  assert.equal((await call('GET', `/rooms/${room.code}`)).body.name, 'Feest zaterdag');
});

test('klaargezette kamer: een ander account (of een gewone kamer met die code) kan er niets mee', async () => {
  const { call, core } = setup();
  const ilse = await signup(call, 'Ilse');
  const bram = await signup(call, 'Bram', PW, { ip: '10.0.0.2' });
  const room = await prepare(call, ilse.token);
  for (const [m, path, body] of [['POST', `/account/rooms/${room.code}`, { name: 'Van Bram' }], ['POST', `/account/rooms/${room.code}/open`], ['POST', `/account/rooms/${room.code}/reset`], ['POST', `/account/rooms/${room.code}/delete`]]) {
    const r = await call(m, path, body, { token: bram.token });
    assert.equal(r.status, 404, path);
    assert.equal(r.body.code, 'notfound');
  }
  assert.equal((await call('GET', '/account/rooms', null, { token: bram.token })).body.rooms.length, 0);
  assert.equal(core.rooms.get(room.code).state.prepared.name, 'Feest zaterdag');
  // the room's own owner path (restore) does not open it either
  const rs = core.http({ method: 'POST', path: `/rooms/${room.code}/restore`, origin: ORIGIN, ip: '10.0.0.3', body: JSON.stringify({ v: V, id: 'owner01', token: 'x'.repeat(32), snap: {} }) });
  assert.equal(rs.status, 409);
});

test('account verwijderen: wachtwoord nodig, kamers weg, naam weer vrij', async () => {
  const { call } = setup();
  const { token } = await signup(call, 'Ilse');
  const a = await prepare(call, token);
  const b = await prepare(call, token, { name: 'Tweede' });
  assert.equal((await call('POST', '/account/delete', { password: 'verkeerd1' }, { token })).status, 401);
  const d = await call('POST', '/account/delete', { password: PW }, { token });
  assert.equal(d.status, 200);
  assert.equal(d.body.rooms, 2);
  for (const c of [a.code, b.code]) assert.equal((await call('GET', `/rooms/${c}`)).status, 404);
  assert.equal((await call('GET', '/account', null, { token })).status, 401);
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: PW })).status, 401);
  await signup(call, 'ILSE');
});

test('account-routes: CORS als de rest van de server, limieten per IP-adres', async () => {
  const { call } = setup();
  const pre = await call('OPTIONS', '/account/login', null);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
  assert.match(pre.headers['access-control-allow-headers'], /authorization/);
  assert.equal((await call('POST', '/account/login', { username: 'ilse', password: PW }, { origin: 'https://kwaad.example' })).status, 403);
  assert.equal((await call('GET', '/account/onbekend')).status, 404);
  assert.equal((await call('GET', '/account/login')).status, 404, 'wrong method');
  const h = await call('GET', '/health');
  assert.ok(h.body.features.includes('accounts'));
  // sign-ups per IP
  for (let i = 0; i < 5; i++) await signup(call, `naam${i}`, PW, { ip: '10.9.9.9' });
  const sixth = await call('POST', '/account/signup', { username: 'naam9', password: PW }, { ip: '10.9.9.9' });
  assert.equal(sixth.status, 429);
  // failed logins per IP (spread over names, so no account lock): the address is refused
  let last;
  for (let i = 0; i < 31; i++) last = await call('POST', '/account/login', { username: `x${i}xx`, password: 'verkeerd1' }, { ip: '10.8.8.8' });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'ratelimit');
  assert.equal((await call('POST', '/account/login', { username: 'naam1', password: PW }, { ip: '10.8.8.7' })).status, 200, 'another address is fine');
});

test('account: wachtwoord, hash en token staan nooit in een antwoord of logregel', async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    const { call, core, logs } = setup();
    const answers = [];
    const c = async (...a) => { const r = await call(...a); answers.push(r); return r; };
    const s = (await c('POST', '/account/signup', { username: 'Ilse', password: PW })).body;
    await c('POST', '/account/login', { username: 'ilse', password: 'verkeerd-wachtwoord' });
    const t2 = (await c('POST', '/account/login', { username: 'ilse', password: PW })).body.token;
    await c('GET', '/account', null, { token: t2 });
    await c('POST', '/account/data', { rev: 1, data: { playlists: [playlist('p1', 1)] } }, { token: t2 });
    await c('POST', '/account/password', { password: PW, newPassword: 'tweede-wachtwoord' }, { token: t2 });
    const room = (await c('POST', '/account/rooms', { name: 'Feest' }, { token: t2 })).body.room;
    await c('GET', '/account/rooms', null, { token: t2 });
    await c('POST', `/account/rooms/${room.code}/reset`, null, { token: t2 });
    const rec = core.accounts.get('ilse');
    const secrets = [PW, 'verkeerd-wachtwoord', 'tweede-wachtwoord', rec.pw, rec.pw.split('$')[3], rec.rc, ...Object.keys(rec.sessions), s.token, t2, parseToken(t2).secret, s.recoveryCode];
    // the token answers (signup, login) carry their own token, nothing else does
    const tokenAnswers = new Set([answers[0], answers[2]]);
    for (const r of answers) {
      const text = JSON.stringify(r.body);
      for (const x of secrets) {
        if (tokenAnswers.has(r) && (x === s.token || x === t2 || x === parseToken(t2).secret || x === parseToken(s.token).secret || x === s.recoveryCode)) continue;
        assert.equal(text.includes(x), false, `leak in ${text.slice(0, 80)}`);
      }
      assert.equal(/pbkdf2/i.test(text), false);
    }
    for (const line of [...logs, ...lines]) for (const x of [...secrets, 'ilse']) assert.equal(line.includes(x), false, `log line leaks: ${line}`);
  } finally { Object.assign(console, orig); }
});

test('wachtwoord-hash: PBKDF2-SHA-256 met 100 000 rondes, constante-tijd vergelijken, geen hash zonder account', async () => {
  assert.equal(PBKDF2_ITERATIONS, 100000);
  const h = await hashPassword('correct horse');
  assert.match(h, /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(await hashPassword('correct horse'), h, 'a fresh salt each time');
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('Correct horse', h), false);
  assert.equal(await verifyPassword('correct horse', null), false, 'no account: the same work, false');
  // a stored hash claiming more rounds than Cloudflare allows is capped (no DoS by a forged record)
  assert.equal(await verifyPassword('x', h.replace('$100000$', '$999999$')), false);
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
  // every secret comparison goes through timingSafeEqual (no === on a hash)
  const src = readFileSync(new URL('../../server/accounts.mjs', import.meta.url), 'utf8');
  for (const fn of ['verifyPassword', 'op_recover', 'session(secret)']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n  }\n', src.indexOf(fn)) + 1);
    assert.match(body, /timingSafeEqual\(/, fn);
  }
});

test('Node: accounts en klaargezette kamers in een bestand overleven een herstart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-accounts-'));
  const file = join(dir, 'accounts.json');
  const one = setup({ accountsFile: file });
  const { token } = await signup(one.call, 'Ilse');
  await one.call('POST', '/account/data', { rev: 1, data: { spotifyClientId: SPOTIFY, playlists: [playlist('p1', 5)] } }, { token });
  const room = await prepare(one.call, token);
  const normal = one.core.http({ method: 'POST', path: '/rooms', origin: ORIGIN, ip: '10.0.0.1', body: JSON.stringify({ v: V, id: 'owner01', name: 'X' }) }).body;
  one.core.flush();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'only the owner may read it (password hashes)');
  assert.deepEqual(readdirSync(dir), ['accounts.json'], 'written atomically: no temp file left');
  const two = setup({ accountsFile: file });
  const g = await two.call('GET', '/account', null, { token });
  assert.equal(g.status, 200, 'the session survives too');
  assert.equal(g.body.data.spotifyClientId, SPOTIFY);
  assert.equal(g.body.data.playlists[0].id, 'p1');
  assert.equal((await two.call('POST', '/account/login', { username: 'ilse', password: PW })).status, 200);
  const info = await two.call('GET', `/rooms/${room.code}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.name, 'Feest zaterdag');
  assert.equal((await two.call('GET', `/rooms/${normal.code}`)).status, 404, 'a normal room stays memory only, as today');
  const o = await two.call('POST', `/account/rooms/${room.code}/open`, null, { token });
  assert.equal(o.status, 200);
  // a deleted room leaves the file
  await two.call('POST', `/account/rooms/${room.code}/delete`, null, { token });
  two.core.flush();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).rooms), []);
});
