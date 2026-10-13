'use strict';

// Fully offline: every lifecycle dependency is injected. The mock owned feed
// uses the production PCM delay, but opens no socket, device, process or file.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createController, fetchVisualDelay } = require('./controller.cjs');
const { PcmDelay, SAMPLE_RATE, FRAME_BYTES } = require('../../src/soundSpectrumPcmDelay');

const native = { pid: 31415, executable: path.resolve('fixtures/G-Force Standalone.x64.exe'), startTimeTicks: '639004567890123456' };
const settings = { enabled: true, zoneId: 'a'.repeat(24), outputId: 'b'.repeat(24), route: { fingerprint: 'f'.repeat(64) } };
const nonce = number => number.toString(16).padStart(32, '0');
const request = (number, action = 'start') => ({ action, pid: native.pid, nonce: nonce(number) });
const facts = () => ({ connected: true, zones: [{ zone_id: settings.zoneId, state: 'playing', outputs: [{ output_id: settings.outputId }] }] });
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('The mocked controller operation did not reach its expected boundary.');
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Cancellation did not release the mocked provider read.')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

const BLOCK_FRAMES = SAMPLE_RATE * 20 / 1000;
function pcm(value, frames = BLOCK_FRAMES) {
  const result = Buffer.alloc(frames * FRAME_BYTES);
  for (let offset = 0; offset < result.length; offset += 2) result.writeInt16LE(value, offset);
  return result;
}

function harness(t, getVisualDelay) {
  const feeds = [], statuses = [], diagnostics = [], reads = [], deferredReads = [];
  const controller = createController({
    nativeIdentity: native, expectedExecutable: native.executable,
    nativeProbe: async () => native,
    competitors: async () => {},
    getRoonState: async () => facts(),
    loadSettings: async () => ({ ...settings }),
    publish: async value => { statuses.push(value); },
    publishDiagnostic: async value => { diagnostics.push(value); },
    getVisualDelay: async options => {
      assert.ok(options.signal instanceof AbortSignal);
      reads.push(options);
      return getVisualDelay(options, reads.length);
    },
    feedFactory: options => {
      const delay = new PcmDelay({ delayMs: options.visualDelayMs ?? 0 });
      const item = {
        initialDelayMs: options.visualDelayMs, delay, starts: 0, stops: 0,
        changes: [], writes: [], ownerToken: '', state: 'waiting', reason: 'Waiting for mocked analysis.',
        async start({ zoneId }) {
          await options.requireZone(zoneId, settings);
          delay.reset(); item.starts++; item.ownerToken = `offline-owner-${feeds.length}`;
          item.state = 'receiving'; item.reason = 'Receiving mocked analysis.';
        },
        async stop() {
          delay.reset(); item.stops++; item.ownerToken = ''; item.state = 'waiting';
        },
        setVisualDelayMs(value) { item.changes.push(value); return delay.setDelayMs(value); },
        write(input) {
          assert.ok(item.ownerToken, 'only a started mock owned feed can submit PCM');
          const output = delay.process(input); item.writes.push(Buffer.from(output)); return output;
        },
        snapshot() { return { state: item.state, reason: item.reason, visualDelay: delay.snapshot() }; }
      };
      feeds.push(item); return item;
    }
  });
  t.after(async () => {
    // Also release deliberately ignored-abort providers if a test assertion
    // fails; no failed test may leave cleanup awaiting an unresolved mock.
    for (const pending of deferredReads) pending.resolve({ currentMs: 0 });
    await controller.close();
  });
  return { controller, feeds, statuses, diagnostics, reads,
    deferredRead() { const pending = deferred(); deferredReads.push(pending); return pending; } };
}

test('native Start confirms the global delay before feed creation and delays actual mocked PCM', async t => {
  let pending, signal;
  const h = harness(t, options => { signal = options.signal; return pending.promise; });
  pending = h.deferredRead();
  assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 0 });
  const starting = h.controller.handle(request(1));
  await until(() => signal);
  assert.equal(h.feeds.length, 0, 'the provider read precedes actual feed creation/start');
  assert.equal(signal.aborted, false);
  pending.resolve({ currentMs: 20 }); await starting;
  assert.equal(h.feeds.length, 1); assert.equal(h.feeds[0].starts, 1);
  assert.equal(h.feeds[0].initialDelayMs, 20);
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 20 });
  assert.deepEqual(h.feeds[0].write(pcm(101)), pcm(0));
  assert.deepEqual(h.feeds[0].write(pcm(202)), pcm(101));
});

test('active global changes update the same owned feed and preserve causal PCM ordering', async t => {
  let currentMs = 20;
  const h = harness(t, async () => ({ currentMs }));
  await h.controller.handle(request(1));
  const feed = h.feeds[0];
  assert.deepEqual(feed.write(pcm(101)), pcm(0));
  assert.deepEqual(feed.write(pcm(202)), pcm(101));
  currentMs = 40; await h.controller.tick();
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 40 });
  assert.equal(feed.delay.snapshot().delayMs, 40); assert.ok(feed.changes.includes(40));
  assert.deepEqual(feed.write(pcm(303)), pcm(0), 'increasing delay adds silence before pending PCM');
  assert.deepEqual(feed.write(pcm(404)), pcm(202), 'pending PCM survives the active increase');
  currentMs = 0; await h.controller.tick();
  assert.deepEqual(feed.write(pcm(505)), pcm(505), 'zero bypasses and discards the older pending branch');
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 0 });
  assert.equal(h.feeds.length, 1); assert.equal(feed.starts, 1); assert.equal(feed.stops, 0);
});

test('Stop and explicit restart reset queued native PCM while rereading the global setting', async t => {
  const h = harness(t, async () => ({ currentMs: 40 }));
  await h.controller.handle(request(1));
  const old = h.feeds[0];
  assert.deepEqual(old.write(pcm(111)), pcm(0));
  assert.deepEqual(old.write(pcm(222)), pcm(0));
  assert.ok(old.delay.snapshot().bufferedFrames > 0);
  await h.controller.handle(request(2, 'stop'));
  assert.equal(old.ownerToken, ''); assert.equal(old.delay.snapshot().bufferedFrames, 0);
  await h.controller.handle(request(3));
  assert.equal(h.reads.length, 2); assert.equal(h.feeds.length, 2);
  const fresh = h.feeds[1];
  assert.equal(fresh.initialDelayMs, 40);
  assert.deepEqual(fresh.write(pcm(333)), pcm(0));
  assert.deepEqual(fresh.write(pcm(444)), pcm(0));
  assert.deepEqual(fresh.write(pcm(555)), pcm(333), 'no old-session samples replay after restart');
});

test('provider failure keeps last confirmed native delay and its pending PCM without restarting', async t => {
  let unavailable = false;
  const h = harness(t, async () => {
    if (unavailable) throw Error('Mock global settings unavailable');
    return { currentMs: 20 };
  });
  await h.controller.handle(request(1)); const feed = h.feeds[0];
  assert.deepEqual(feed.write(pcm(111)), pcm(0));
  unavailable = true; await h.controller.tick();
  assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 20 });
  assert.equal(feed.delay.snapshot().delayMs, 20);
  assert.deepEqual(feed.write(pcm(222)), pcm(111));
  assert.equal(h.feeds.length, 1); assert.equal(feed.starts, 1); assert.equal(feed.stops, 0);
  unavailable = false; await h.controller.tick();
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 20 });
});

test('initial provider failure starts native visuals at unconfirmed zero without claiming confirmation', async t => {
  const h = harness(t, async () => { throw Error('Mock global settings unavailable'); });
  await h.controller.handle(request(1));
  assert.equal(h.feeds.length, 1); assert.equal(h.feeds[0].initialDelayMs, 0);
  assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 0 });
  assert.deepEqual(h.feeds[0].write(pcm(123)), pcm(123));
});

test('overlapping active ticks share one global read and apply its confirmed result once', async t => {
  let pending;
  const h = harness(t, async (_options, call) => call === 1 ? { currentMs: 20 } : pending.promise);
  pending = h.deferredRead(); await h.controller.handle(request(1));
  const first = h.controller.tick(), second = h.controller.tick();
  assert.equal(first, second);
  await until(() => h.reads.length === 2);
  await settle(); assert.equal(h.reads.length, 2);
  pending.resolve({ currentMs: 40 }); await Promise.all([first, second]);
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 40 });
  assert.equal(h.feeds[0].changes.filter(value => value === 40).length, 1);
});

test('Stop cancels an ignored-abort startup read promptly and a late result cannot start a feed', async t => {
  let pending, signal;
  const h = harness(t, options => { signal = options.signal; return pending.promise; });
  pending = h.deferredRead(); const starting = h.controller.handle(request(1));
  await until(() => signal);
  const stopping = h.controller.handle(request(2, 'stop'));
  assert.equal(signal.aborted, true);
  await bounded(Promise.all([starting, stopping]));
  assert.equal(h.feeds.length, 0); assert.equal(h.controller.status().state, 'stopped');
  pending.resolve({ currentMs: 5000 }); await settle(); await settle();
  assert.equal(h.feeds.length, 0);
  assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 0 });
});

test('a new Start cancels the preceding ignored-abort read and fences its late global result', async t => {
  let pending, oldSignal;
  const h = harness(t, async (options, call) => {
    if (call === 1) { oldSignal = options.signal; return pending.promise; }
    return { currentMs: 40 };
  });
  pending = h.deferredRead(); const oldStart = h.controller.handle(request(1));
  await until(() => oldSignal);
  const replacement = h.controller.handle(request(2));
  assert.equal(oldSignal.aborted, true);
  await bounded(Promise.all([oldStart, replacement]));
  assert.equal(h.feeds.length, 1); assert.equal(h.feeds[0].initialDelayMs, 40);
  pending.resolve({ currentMs: 5000 }); await settle(); await settle();
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 40 });
  assert.equal(h.controller.status().nonce, nonce(2));
  assert.equal(h.feeds[0].delay.snapshot().delayMs, 40);
  assert.equal(h.feeds[0].changes.includes(5000), false);
});

test('an ignored-abort active read cannot change a stopped or replacement native session', async t => {
  let pending, oldSignal;
  const h = harness(t, async (options, call) => {
    if (call === 2) { oldSignal = options.signal; return pending.promise; }
    return { currentMs: call === 1 ? 20 : 40 };
  });
  pending = h.deferredRead(); await h.controller.handle(request(1));
  const old = h.feeds[0]; old.write(pcm(111));
  const ticking = h.controller.tick(); await until(() => oldSignal);
  const stopping = h.controller.handle(request(2, 'stop'));
  assert.equal(oldSignal.aborted, true);
  await bounded(Promise.all([ticking, stopping]));
  assert.equal(old.delay.snapshot().bufferedFrames, 0);
  await h.controller.handle(request(3)); const fresh = h.feeds[1];
  pending.resolve({ currentMs: 5000 }); await settle(); await settle();
  assert.deepEqual(h.controller.delayStatus(), { state: 'confirmed', delayMs: 40 });
  assert.equal(fresh.delay.snapshot().delayMs, 40); assert.equal(fresh.changes.includes(5000), false);
  assert.deepEqual(fresh.write(pcm(222)), pcm(0));
  assert.deepEqual(fresh.write(pcm(333)), pcm(0));
  assert.deepEqual(fresh.write(pcm(444)), pcm(222));
});

test('close cancels even an ignored-abort startup read and rejects further native requests', async t => {
  let pending, signal;
  const h = harness(t, options => { signal = options.signal; return pending.promise; });
  pending = h.deferredRead(); const starting = h.controller.handle(request(1));
  await until(() => signal);
  const closing = h.controller.close(); assert.equal(signal.aborted, true);
  await bounded(Promise.all([starting, closing]));
  pending.resolve({ currentMs: 2500 }); await settle(); await settle();
  assert.equal(h.feeds.length, 0);
  assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 0 });
  await assert.rejects(h.controller.handle(request(2)), /closed/);
});

test('an abort-aware provider cancellation never becomes a confirmed native setting', async t => {
  let signal;
  const h = harness(t, options => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      const error = Error('Mock read aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true }));
  });
  const starting = h.controller.handle(request(1)); await until(() => signal);
  const stopping = h.controller.handle(request(2, 'stop'));
  await bounded(Promise.all([starting, stopping]));
  assert.equal(signal.aborted, true); assert.equal(h.feeds.length, 0);
  assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 0 });
});

test('invalid injected global values preserve the last confirmed delay without changing queued PCM', async t => {
  for (const invalid of [undefined, null, -1, 5001, 1.5, '20', NaN, Infinity]) {
    let invalidRead = false;
    const h = harness(t, async () => ({ currentMs: invalidRead ? invalid : 20 }));
    await h.controller.handle(request(1)); const feed = h.feeds[0];
    assert.deepEqual(feed.write(pcm(111)), pcm(0));
    invalidRead = true; await h.controller.tick();
    assert.deepEqual(h.controller.delayStatus(), { state: 'unknown', delayMs: 20 });
    assert.equal(feed.delay.snapshot().delayMs, 20);
    assert.deepEqual(feed.write(pcm(222)), pcm(111));
    assert.equal(feed.stops, 0);
  }
});

test('global HTTP helper pins a local GET, forbids redirects and retains only the validated current delay', async () => {
  for (const currentMs of [0, 2500, 5000]) {
    let calls = 0;
    const result = await fetchVisualDelay({ fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:3777/api/soundspectrum/delay');
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      assert.equal(options.body, undefined); assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ currentMs, savedMs: 1000, secret: 'private', route: 'private' }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } });
    } });
    assert.equal(calls, 1); assert.deepEqual(result, { currentMs });
    assert.doesNotMatch(JSON.stringify(result), /savedMs|private|secret|route/);
  }
});

test('global HTTP helper rejects redirects, failed status and missing or incorrect content type', async () => {
  for (const response of [
    new Response('', { status: 302, headers: { location: 'https://example.test/private' } }),
    new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    new Response('{"currentMs":20}'),
    new Response('{"currentMs":20}', { headers: { 'content-type': 'text/plain' } }),
    { ok: true, redirected: true, headers: new Headers({ 'content-type': 'application/json' }) }
  ]) {
    await assert.rejects(fetchVisualDelay({ fetchImpl: async () => response }), /unavailable/);
  }
});

test('global HTTP helper rejects invalid JSON, invalid UTF-8 and noninteger or out-of-range settings', async () => {
  const invalidBodies = ['{', 'null', '{}', '{"currentMs":null}', '{"currentMs":"20"}',
    '{"currentMs":-1}', '{"currentMs":5001}', '{"currentMs":1.5}', '{"currentMs":true}', Buffer.from([0xff])];
  for (const body of invalidBodies) {
    await assert.rejects(fetchVisualDelay({ fetchImpl: async () => new Response(body,
      { headers: { 'content-type': 'application/json' } }) }), /unavailable/);
  }
});

test('global HTTP helper caps advertised and streamed bodies and aborts the oversized stream', async () => {
  for (const contentLength of ['4097', '-1', '1.5', 'invalid']) {
    let bodyRead = false;
    const response = { ok: true, redirected: false,
      headers: { get: name => name === 'content-type' ? 'application/json' : name === 'content-length' ? contentLength : null },
      get body() { bodyRead = true; throw Error('Oversized advertised body must not be read.'); } };
    await assert.rejects(fetchVisualDelay({ fetchImpl: async () => response }), /unavailable/);
    assert.equal(bodyRead, false);
  }
  let observedSignal;
  await assert.rejects(fetchVisualDelay({ fetchImpl: async (_url, options) => {
    observedSignal = options.signal;
    return { ok: true, redirected: false,
      headers: new Headers({ 'content-type': 'application/json', 'content-length': '1' }),
      body: (async function* () { yield Buffer.alloc(3000, 32); yield Buffer.alloc(1097, 32); })() };
  } }), /unavailable/);
  assert.equal(observedSignal.aborted, true, 'actual streamed length remains bounded despite a smaller advertised length');
  await assert.rejects(fetchVisualDelay({ maxBytes: 10, fetchImpl: async () => new Response('{"currentMs":20}',
    { headers: { 'content-type': 'application/json' } }) }), /unavailable/);
});

test('global HTTP helper aborts a bounded request and forwards external cancellation', async () => {
  let timeoutSignal;
  await assert.rejects(fetchVisualDelay({ timeoutMs: 15, fetchImpl: async (_url, options) => {
    timeoutSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('Mock timeout')), { once: true }));
  } }), /unavailable/);
  assert.equal(timeoutSignal.aborted, true);
  const cancellation = new AbortController(); let externalSignal;
  const reading = fetchVisualDelay({ signal: cancellation.signal, fetchImpl: async (_url, options) => {
    externalSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('Mock cancellation')), { once: true }));
  } });
  const rejected = assert.rejects(reading, /unavailable/);
  await until(() => externalSignal); cancellation.abort(); await bounded(rejected);
  assert.equal(externalSignal.aborted, true);
  const cancelled = new AbortController(); cancelled.abort(); let calls = 0;
  await assert.rejects(fetchVisualDelay({ signal: cancelled.signal, fetchImpl: async () => { calls++; } }), /unavailable/);
  assert.equal(calls, 0, 'already cancelled requests never invoke fetch');
});
