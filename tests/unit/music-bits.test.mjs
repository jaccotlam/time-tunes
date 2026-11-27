import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPick, readPick, setPick, clearPick, markPicked, takePicked, isPlaylistLink, countLine, safeImage,
  yearsEta, etaText, readinessInfo, workLine, sourceLabel, rowMark, PICK_KEY, PICK_MAX_AGE_MS,
} from '../../app/js/screens/music-bits.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('pick mode: only a room code and our own lobby hash, not stale', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(cleanPick({ kind: 'room', code: 'ABCD', back: '#/spelleider', at: now }, now), { kind: 'room', code: 'ABCD', back: '#/spelleider', at: now });
  assert.equal(cleanPick({ kind: 'room', code: 'abcd', back: '#/spelleider', at: now }, now), null, 'code in capitals');
  assert.equal(cleanPick({ kind: 'room', code: 'ABCD', back: 'https://evil.example/', at: now }, now), null, 'never a foreign back link');
  assert.equal(cleanPick({ kind: 'room', code: 'ABCD', back: '#/spelleider', at: now - PICK_MAX_AGE_MS - 1 }, now), null, 'stale');
  assert.equal(cleanPick({ kind: 'other', code: 'ABCD', back: '#/spelleider', at: now }, now), null);
  assert.equal(cleanPick(null, now), null);
  assert.equal(cleanPick([], now), null);
});

test('pick mode: set, read, clear; the picked room is told once', () => {
  const s = memStorage();
  assert.equal(readPick(s), null);
  assert.ok(setPick({ kind: 'room', code: 'WXYZ', back: '#/spelleider' }, s));
  assert.equal(readPick(s).code, 'WXYZ');
  s.setItem(PICK_KEY, '{not json');
  assert.equal(readPick(s), null, 'broken storage: no pick');
  setPick({ kind: 'room', code: 'WXYZ', back: '#/spelleider' }, s);
  clearPick(s);
  assert.equal(readPick(s), null);
  markPicked('WXYZ', s);
  assert.equal(takePicked(s), 'WXYZ');
  assert.equal(takePicked(s), null, 'only once');
  markPicked('<script>', s);
  assert.equal(takePicked(s), null);
});

test('isPlaylistLink: links and long ids open a list, searches do not', () => {
  assert.equal(isPlaylistLink('https://www.deezer.com/nl/playlist/1266971851'), true);
  assert.equal(isPlaylistLink('deezer://www.deezer.com/playlist/123'), true);
  assert.equal(isPlaylistLink('1266971851'), true);
  assert.equal(isPlaylistLink('538'), false, 'Radio 538 is a search');
  assert.equal(isPlaylistLink('Top 40'), false);
  assert.equal(isPlaylistLink(''), false);
});

test('countLine and safeImage', () => {
  assert.equal(countLine(688, 'Deezer Charts'), '688 nummers · door Deezer Charts');
  assert.equal(countLine(1, ''), '1 nummer');
  assert.equal(countLine(null, 'Sanne'), 'door Sanne');
  assert.equal(safeImage('https://cdn-images.dzcdn.net/a.jpg'), 'https://cdn-images.dzcdn.net/a.jpg');
  assert.equal(safeImage('http://x/a.jpg'), null);
  assert.equal(safeImage('javascript:alert(1)'), null);
  assert.equal(safeImage('https://x/a.jpg" onerror="x'), null);
  assert.equal(safeImage(42), null);
});

test('waiting time for checked years: about 1.2 s per year, in words', () => {
  assert.equal(yearsEta(0, 30), 36);
  assert.equal(yearsEta(30, 30), 0);
  assert.equal(yearsEta(40, 30), 0);
  assert.equal(etaText(36), 'nog ongeveer 35 seconden');
  assert.equal(etaText(3), 'bijna klaar');
  assert.equal(etaText(12), 'nog ongeveer 10 seconden');
  assert.equal(etaText(150), 'nog ongeveer 3 minuten');
  assert.equal(etaText(70), 'nog ongeveer 1 minuut');
});

test('readinessInfo: one honest line and the way out', () => {
  const c = (total, inDeck, held = 0) => ({ total, playable: inDeck + held, inDeck, held });
  assert.equal(readinessInfo({ counts: c(0, 0) }).tone, 'warn');
  let r = readinessInfo({ counts: c(500, 500), source: 'spotify' });
  assert.match(r.text, /Klaar om te spelen via Spotify · 500 nummers/);
  r = readinessInfo({ counts: c(500, 480), source: 'preview' });
  assert.equal(r.text, 'Speelt met fragmenten: 480 van 500 nummers.');
  r = readinessInfo({ counts: c(500, 40, 400), source: 'spotify' });
  assert.equal(r.text, 'Speelt met 40 van 500 nummers; de rest wordt nog nagekeken.');
  assert.equal(r.tone, 'busy');
  // a Spotify list without fragments while Spotify is not the source: never a dead end
  r = readinessInfo({ counts: c(500, 0), source: 'preview', spotifyPlayable: 500, status: { appleTodo: 480, appleDone: 20 } });
  assert.equal(r.action, 'connect');
  assert.match(r.text, /Verbind Spotify, of wacht op de fragmenten: 20 van 500 gezocht/);
  // a catalogue list whose years are still coming
  r = readinessInfo({ counts: c(100, 1), source: 'preview', status: { yearsMissing: 99, pending: 99, ready: 1 } });
  assert.equal(r.action, 'wait');
  r = readinessInfo({ counts: c(10, 2), source: 'preview' });
  assert.match(r.text, /Te weinig speelbare nummers/);
  r = readinessInfo({ counts: c(100, 100), source: 'spotify', playNow: true, status: { yearsPending: 60 } });
  assert.match(r.text, /niet alle jaartallen zijn al nagekeken/);
});

test('workLine: the background work in one line', () => {
  assert.equal(workLine(null), '');
  assert.equal(workLine({ total: 500, yearsPending: 380, working: true, pending: 380 }), 'Jaartallen nakijken… 120 van 500');
  assert.equal(workLine({ total: 500, yearsPending: 380, working: true, pending: 380 }, { short: true }), 'jaren nakijken 120/500');
  assert.equal(workLine({ total: 500, yearsPending: 0, yearsMissing: 0, appleTodo: 480, appleDone: 20, working: true, pending: 480 }), 'Fragmenten zoeken… 20 van 500');
  assert.equal(workLine({ total: 500, yearsPending: 0, yearsMissing: 0, appleTodo: 0, working: false, pending: 0 }), '');
});

test('rowMark: a mark only where the player can act', () => {
  assert.equal(rowMark({ year: null }), 'missing');
  assert.equal(rowMark({ year: 1983, yearSure: true }), null);
  assert.equal(rowMark({ year: 1983, yearSure: false }), 'unsure', 'hand-made list: as before');
  assert.equal(rowMark({ year: 1983, yearSure: false }, { pending: true, fromSource: true }), null, 'catalogue year still being checked: the header says so');
  assert.equal(rowMark({ year: 1983, yearSure: false }, { pending: false, fromSource: true }), 'unsure', 'checked and still not sure');
  assert.equal(sourceLabel({ source: { kind: 'spotify' } }), 'Spotify');
  assert.equal(sourceLabel({ source: { kind: 'deezer' } }), 'Deezer');
  assert.equal(sourceLabel({}), 'eigen');
});
