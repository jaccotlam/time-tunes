import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCode, makeFreshCode, isValidCode, normalizeCode, peerIdForCode, joinUrl, CODE_ALPHABET,
} from '../../app/js/multi/code.js';
import {
  viewFor, parseMessage, encode, helloMessage, versionError, PROTOCOL_VERSION, MAX_MESSAGE_CHARS,
} from '../../app/js/multi/protocol.js';
import { createRoom, addPlayer, startGame, submitAnswer, reveal, nextRound, removePlayer } from '../../app/js/multi/game.js';
import { seededRandom } from '../../app/js/logic.js';

const cards = Array.from({ length: 40 }, (_, i) => ({
  id: `c${String(i + 1).padStart(3, '0')}`, year: 1961 + i, title: `Geheime titel ${i + 1}`, artist: `Geheime artiest ${i + 1}`,
  previewUrl: `https://example.invalid/${i + 1}.m4a`,
}));

test('kamercodes: 4 letters zonder verwarrende tekens', () => {
  assert.ok(!/[ILO01]/.test(CODE_ALPHABET));
  const rand = seededRandom(1);
  for (let i = 0; i < 500; i++) {
    const c = makeCode(rand);
    assert.match(c, /^[A-Z]{4}$/);
    assert.ok(isValidCode(c));
    assert.ok(![...c].some((ch) => 'ILO'.includes(ch)));
  }
  assert.equal(normalizeCode(' ab cd '), 'ABCD');
  assert.equal(normalizeCode('ab-cd'), 'ABCD');
  assert.equal(normalizeCode('https://x.y/app/#/kamer/WXYZ'), 'WXYZ');
  assert.equal(normalizeCode('ABIO'), null, 'I en O bestaan niet');
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode('ABCDE'), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(peerIdForCode('ABCD'), 'timetunesr-kamer-ABCD');
  assert.equal(peerIdForCode('ABCD', 'test-'), 'test-ABCD');
  assert.throws(() => peerIdForCode('nope'));
  assert.equal(joinUrl('https://x.y/app/#/', 'ABCD'), 'https://x.y/app/#/kamer/ABCD');
  let calls = 0;
  const taken = makeFreshCode(['AAAA'], () => (calls++ < 4 ? 0 : 0.99)); // eerste poging = AAAA (bezet), daarna nieuw
  assert.notEqual(taken, 'AAAA');
});

test('berichten: parse, onbekende types en te grote berichten weigeren', () => {
  assert.deepEqual(parseMessage(encode({ t: 'hello', v: 1 })), { t: 'hello', v: 1 });
  assert.equal(parseMessage('{"t":"state"}'), null, 'speler mag geen state sturen');
  assert.ok(parseMessage('{"t":"state"}', { from: 'host' }));
  assert.equal(parseMessage('geen json'), null);
  assert.equal(parseMessage({ x: 1 }), null);
  assert.equal(parseMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)), null);
  const h = helloMessage({ playerId: 'p', name: 'A', room: 'ABCD' });
  assert.equal(h.v, PROTOCOL_VERSION);
  assert.equal(versionError(PROTOCOL_VERSION - 1).code, 'version');
  assert.match(versionError(PROTOCOL_VERSION - 1).message, /Ververs/);
  assert.match(versionError(PROTOCOL_VERSION + 1).message, /spelleider/);
});

function setup(kind) {
  let r = createRoom({ code: 'ABCD', host: { id: 'host', name: 'Ilse' }, settings: { game: kind, size: 4, goal: 10 } });
  r = addPlayer(r, { id: 'a', name: 'Anouk' });
  r = addPlayer(r, { id: 'b', name: 'Bram' });
  return startGame(r, { cards, seed: 77 });
}

const secretsOf = (room) => {
  const s = room.game.songs[room.game.current];
  return [s.id, s.title, s.artist, s.previewUrl];
};

for (const kind of ['bingo', 'timeline']) {
  test(`${kind}: vóór de onthulling staat niets over het lopende nummer in de view van een speler`, () => {
    let r = setup(kind);
    for (let round = 0; round < 5; round++) {
      const secrets = secretsOf(r);
      const year = r.game.songs[r.game.current].year;
      if (kind === 'bingo') r = submitAnswer(r, 'a', { pass: true });
      else r = submitAnswer(r, 'a', { slot: 0 });
      for (const pid of ['a', 'b', 'host']) {
        const v = viewFor(r, pid, { a: true });
        const json = JSON.stringify(v);
        for (const s of secrets) assert.ok(!json.includes(s), `ronde ${round + 1}, ${pid}: "${s}" lekt niet`);
        assert.equal(v.game.reveal, null);
        assert.ok(!('current' in v.game) && !('songs' in v.game) && !('pile' in v.game));
        // het jaartal mag alleen voorkomen als het bij een eerder onthuld nummer hoort
        const own = kind === 'timeline' ? v.game.mine.timeline.map((x) => x.year) : v.game.mine.marks;
        if (json.includes(`"year":${year}`)) assert.ok(own.includes(year), 'jaar alleen van eigen, eerder onthulde kaarten');
      }
      // wat de speler wel ziet: eigen antwoord, wie al geantwoord heeft
      const va = viewFor(r, 'a', {});
      assert.ok(va.game.answer);
      assert.equal(va.players.find((p) => p.id === 'a').answered, true);
      assert.equal(va.players.find((p) => p.id === 'b').answered, false);
      assert.equal(viewFor(r, 'b', {}).game.answer, null, 'je ziet alleen je eigen antwoord');
      r = reveal(r);
      const after = viewFor(r, 'b', {});
      assert.deepEqual(Object.keys(after.game.reveal.song).sort(), ['artist', 'title', 'year']);
      assert.equal(after.game.reveal.song.title, secrets[1], 'na de onthulling wel');
      assert.ok(!JSON.stringify(after).includes(secrets[3]), 'nooit de previewUrl');
      r = nextRound(r);
      if (r.phase === 'won') break;
    }
  });
}

test('view: eigen kaart, andermans kaart niet; online-status; verwijderde speler', () => {
  let r = setup('bingo');
  const va = viewFor(r, 'a', { a: true, b: false, host: true });
  assert.equal(va.you.name, 'Anouk');
  assert.equal(va.game.mine.card.length, 16);
  assert.ok(!JSON.stringify(va).includes(JSON.stringify(r.game.per.b.card)), 'kaart van Bram zit er niet in');
  assert.equal(va.players.find((p) => p.id === 'b').online, false);
  assert.equal(va.players.find((p) => p.id === 'host').online, true);
  assert.equal(va.players.find((p) => p.id === 'host').host, true);
  r = removePlayer(r, 'b');
  const vb = viewFor(r, 'b', {});
  assert.equal(vb.you, null);
  assert.equal(vb.game.mine, null);
});
