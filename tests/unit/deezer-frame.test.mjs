// The real Deezer transport (app/js/deezer.js jsonpTransport) against a fake page and a fake
// sandboxed frame: no browser, no network. Covers what a burst of timeouts does to the frame
// (each request belongs to its frame; an old frame's timeouts never kill a fresh one), the cap
// on requests waiting for an answer, replacing a frame after a malformed answer and after
// FRAME_MAX_REQUESTS requests, and the frame script's own URL check.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

/* ---------- a fake page with fake frames ---------- */
const listeners = [];
const frames = []; // every frame element the transport made, in order
let onNewFrame = null; // (el, index) -> called for every new frame (tests set how it answers)
globalThis.window = { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } };
const body = {
  appendChild(el) {
    el.parentNode = body;
    el.received = [];
    el.contentWindow = { postMessage: (msg) => { el.received.push(msg); el.onRequest?.(msg); } };
    frames.push(el);
    onNewFrame?.(el, frames.length - 1);
    // the frame script says it is ready (as FRAME_SCRIPT does)
    queueMicrotask(() => from(el, { tt: 'dz-ready' }));
  },
  removeChild(el) { el.parentNode = null; },
};
globalThis.document = {
  body,
  createElement: () => ({ dataset: {}, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null }),
};
/** A message from this frame to the page. */
function from(el, data) { for (const fn of listeners) fn({ source: el.contentWindow, data }); }
/** Answer a request of this frame with the JSON of a Deezer track. */
function answerTrack(el, req) {
  const id = Number(/\/track\/(\d+)/.exec(req.url)?.[1]);
  from(el, { tt: 'dz-res', id: req.id, ok: true, data: JSON.stringify({ id, title: `Song ${id}`, release_date: '1990-01-01', artist: { name: 'A' }, album: { title: 'B' } }) });
}
const alive = () => frames.filter((f) => f.parentNode);

const dz = await import('../../app/js/deezer.js');

const tick = () => new Promise((r) => setImmediate(r));
async function advance(ms, step = 25) {
  await tick();
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await tick(); }
}
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, reason: e.reason }));

beforeEach(() => {
  dz._reset();
  dz.setTransport(null); // the real JSONP transport
  frames.length = 0;
  onNewFrame = null;
});
const autoAnswer = (el) => { el.onRequest = (req) => queueMicrotask(() => answerTrack(el, req)); };

test('a burst of timeouts on a wedged frame: its requests fail together, the fresh frame lives and answers', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    // the first frame never answers (a wedged remote script); every later one answers at once
    onNewFrame = (el, i) => { if (i > 0) autoAnswer(el); };
    const results = Array.from({ length: 20 }, (_, i) => settle(dz.trackInfo(i + 1)));
    await advance(3000);
    // back-pressure: only a few requests wait for an answer at the same time
    assert.ok(frames[0].received.filter((m) => m.tt === 'dz-req').length <= 6, `at most 6 requests in flight (${frames[0].received.length})`);
    assert.ok(dz.inFlightCount() <= 6);
    await advance(20000);
    const out = await Promise.all(results);
    const failed = out.filter((r) => !r.ok);
    const onWedged = frames[0].received.filter((m) => m.tt === 'dz-req').length;
    assert.ok(onWedged <= 8, `the wedged frame only got the few requests in flight (and the ones sent while the first timed out): ${onWedged}`);
    assert.equal(failed.length, onWedged, `only the requests of the wedged frame fail (${JSON.stringify(failed)})`);
    assert.ok(failed.every((r) => r.code === 'timeout'), 'as timeouts');
    assert.equal(out.filter((r) => r.ok).length, 20 - onWedged, 'everything after it is answered by the fresh frame');
    assert.equal(frames.length, 2, `the wedged frame was replaced once, the fresh one never (${frames.length} frames)`);
    assert.equal(alive().length, 1);
    assert.equal(alive()[0], frames[1]);
    assert.equal(dz.inFlightCount(), 0);
  } finally { mock.timers.reset(); }
});

test('the timeouts of an old frame never count against the new one', async () => {
  dz._reset({ inFlight: 50 }); // many old requests in the air (as before the cap)
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const old = Array.from({ length: 9 }, (_, i) => settle(dz.trackInfo(i + 1)));
    await advance(9 * 125 + 50);
    assert.equal(frames.length, 1);
    await advance(12000 - 9 * 125 + 3 * 125); // the first three time out: the frame goes
    assert.equal(frames.length, 1, 'no new frame yet (nobody asked)');
    assert.equal(alive().length, 0);
    const r = await Promise.all(old);
    assert.ok(r.every((x) => !x.ok && x.code === 'timeout'), 'its other requests fail at once, not one by one');
    // a request on a fresh frame, answered a bit later than the old ones would have timed out
    const fresh = settle(dz.trackInfo(42));
    await advance(200);
    assert.equal(frames.length, 2);
    await advance(2000);
    assert.equal(frames[1].parentNode, body, 'the fresh frame is still there');
    answerTrack(frames[1], frames[1].received.find((m) => m.tt === 'dz-req'));
    const got = await fresh;
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.v.deezerId, 42);
  } finally { mock.timers.reset(); }
});

test('a malformed answer from the frame: refused, and the frame is replaced', async () => {
  dz._reset({ gap: 0 });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const bads = [
      (req) => ({ tt: 'dz-res', id: req.id, ok: true, data: { id: 1 } }), // not a string
      (req) => ({ tt: 'dz-res', id: req.id, ok: true, data: 'x'.repeat(3_000_001) }), // too big
      (req) => ({ tt: 'dz-res', id: req.id, ok: true, data: '{not json' }),
      (req) => ({ tt: 'dz-res', id: req.id, ok: 'yes', data: '{}' }), // wrong shape
      (req) => ({ tt: 'dz-res', id: req.id, ok: false, data: { evil: 1 } }),
      () => 'just a string', // not our message at all
    ];
    for (const [i, bad] of bads.entries()) {
      const before = frames.length;
      const p = settle(dz.trackInfo(i + 1));
      await advance(50);
      const el = frames.at(-1);
      const req = el.received.find((m) => m.tt === 'dz-req');
      from(el, bad(req));
      const r = await p;
      assert.equal(r.ok, false, `case ${i}`);
      assert.equal(r.code, 'unavailable', `case ${i}`);
      assert.equal(el.parentNode, null, `case ${i}: the frame is gone`);
      assert.equal(frames.length, before + 1, `case ${i}: a new frame for this request`);
    }
    // a guess at an id we never made (the hostile script of the e2e test does this) is ignored:
    // the frame stays (it cannot hurt: nobody waits for that id)
    const p = settle(dz.trackInfo(77));
    await advance(50);
    const el = frames.at(-1);
    from(el, { tt: 'dz-res', id: 'guess0', ok: true, data: '{"id":1}' });
    assert.equal(el.parentNode, body);
    answerTrack(el, el.received.find((m) => m.tt === 'dz-req'));
    assert.equal((await p).v.deezerId, 77);
    // an error the frame script itself reports (no callback, network) is a normal failure
    const q = settle(dz.trackInfo(78));
    await advance(50);
    from(el, { tt: 'dz-res', id: el.received.filter((m) => m.tt === 'dz-req').at(-1).id, ok: false, data: 'nocallback' });
    assert.deepEqual(await q, { ok: false, code: 'unavailable', reason: 'nocallback' });
    assert.equal(el.parentNode, body, 'the frame stays');
  } finally { mock.timers.reset(); }
});

test('a frame is replaced after 200 requests; the old one finishes its own first', async () => {
  dz._reset({ gap: 0, inFlight: 50 });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const first = Array.from({ length: 199 }, (_, i) => dz.trackInfo(i + 1));
    await advance(50);
    autoAnswer(frames[0]);
    for (const m of frames[0].received.filter((x) => x.tt === 'dz-req')) answerTrack(frames[0], m);
    await Promise.all(first);
    // request 200 waits on the first frame; 201 goes to a new frame while 200 is still open
    frames[0].onRequest = null;
    const r200 = settle(dz.trackInfo(200));
    await advance(10);
    const r201 = settle(dz.trackInfo(201));
    await advance(50);
    assert.equal(frames.length, 2, 'a fresh frame after 200');
    assert.equal(frames[0].parentNode, body, 'the old one waits for its last request');
    answerTrack(frames[0], frames[0].received.filter((m) => m.tt === 'dz-req').at(-1));
    assert.equal((await r200).ok, true);
    assert.equal(frames[0].parentNode, null, 'and then goes');
    answerTrack(frames[1], frames[1].received.find((m) => m.tt === 'dz-req'));
    assert.equal((await r201).ok, true);
    assert.equal(frames[0].received.filter((m) => m.tt === 'dz-req').length, 200);
  } finally { mock.timers.reset(); }
});

test('frame script: only https://api.deezer.com/ URLs are loaded', () => {
  const scripts = [];
  const posted = [];
  let handler = null;
  const parent = { postMessage: (m, target) => posted.push({ m, target }) };
  const sandbox = {
    parent,
    addEventListener: (t, fn) => { if (t === 'message') handler = fn; },
    setTimeout: () => 0,
    document: { createElement: () => ({}), head: { appendChild: (s) => scripts.push(s.src) } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(dz._FRAME_SCRIPT, sandbox);
  const plain = (x) => JSON.parse(JSON.stringify(x)); // objects of the other realm
  assert.deepEqual(plain(posted.map((p) => p.m)), [{ tt: 'dz-ready' }]);
  const send = (url) => handler({ source: parent, origin: 'null', data: { tt: 'dz-req', id: 'r1', url, cb: 'dzcbabcdef' } });
  for (const evil of ['https://evil.example/x.js', 'http://api.deezer.com/track/1', 'https://api.deezer.com.evil.example/x', 'javascript:alert(1)', 'https://api.deezer.comx/']) {
    posted.length = 0;
    send(evil);
    assert.deepEqual(scripts, [], `not loaded: ${evil}`);
    assert.deepEqual(plain(posted[0]?.m), { tt: 'dz-res', id: 'r1', ok: false, data: 'url' }, evil);
  }
  send('https://api.deezer.com/track/1?output=jsonp&callback=dzcbabcdef');
  assert.deepEqual(scripts, ['https://api.deezer.com/track/1?output=jsonp&callback=dzcbabcdef']);
});
