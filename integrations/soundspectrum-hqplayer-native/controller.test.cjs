'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  parseRequest, formatStatus, readBounded, requestIsFreshForNative, atomicStatus, atomicDiagnostic, feedDiagnostic, fetchRoonFacts,
  scriptArgument, assertNoCompetitors, acquireCompanionOwner, releaseCompanionOwner,
  createController
} = require('./controller.cjs');

const native = { pid: 31415, executable: path.resolve('fixtures/G-Force Standalone.x64.exe'), startTimeTicks: '639004567890123456' };
const settings = { enabled: true, zoneId: 'a'.repeat(24), outputId: 'b'.repeat(24), route: { fingerprint: 'f'.repeat(64) } };
const nonce = number => number.toString(16).padStart(32, '0');
const request = (number, action = 'start', pid = native.pid) => ({ action, pid, nonce: nonce(number) });
const facts = () => ({ connected: true, zones: [{ zone_id: settings.zoneId, state: 'playing', outputs: [{ output_id: settings.outputId }] }] });
const idleFacts = state => ({ connected: true, zones: [{ ...facts().zones[0], state }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function temporary(t) {
  const base = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'rh-native-feed-test-'));
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), base);
    assert.ok(path.basename(target).startsWith('rh-native-feed-test-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return directory;
}

function harness(overrides = {}) {
  const feeds = [], statuses = [], diagnostics = [];
  let observedFacts = facts(), observedNative = native, occupied = false, observedSettings = settings;
  const controller = createController({
    nativeIdentity: native, expectedExecutable: native.executable,
    nativeProbe: async () => observedNative,
    competitors: async () => { if (occupied) throw Error('Another visualizer owns the cable.'); },
    getRoonState: async () => observedFacts,
    getVisualDelay: async () => ({ currentMs: 0 }),
    loadSettings: async () => ({ ...observedSettings }),
    publish: async value => { statuses.push(value); },
    // Offline tests must never use the default publisher in the live data tree.
    publishDiagnostic: async value => { diagnostics.push(value); },
    feedFactory: options => {
      const item = { starts: 0, stops: 0, ownerToken: '', state: 'waiting', reason: 'Waiting for music analysis.', onFailure: null,
        async start({ zoneId, onFailure }) {
          item.starts++; item.onFailure = onFailure;
          await options.requireZone(zoneId, settings);
          item.ownerToken = crypto.randomBytes(24).toString('hex'); item.state = 'receiving'; item.reason = 'Receiving music analysis.';
        },
        async stop() { item.stops++; item.ownerToken = ''; item.state = 'waiting'; },
        snapshot() { return { state: item.state, reason: item.reason }; },
        async checkSafety() {
          try { await options.requireZone(settings.zoneId, settings); }
          catch (error) { item.state = 'error'; await item.stop(); item.onFailure(error); }
        }
      };
      feeds.push(item); return item;
    },
    ...overrides
  });
  return { controller, feeds, statuses, diagnostics,
    setFacts: value => { observedFacts = value; }, setNative: value => { observedNative = value; },
    setOccupied: value => { occupied = value; }, setSettings: value => { observedSettings = value; } };
}

test('control requests are explicit, strict, bounded and status reasons cannot add fields', () => {
  assert.deepEqual(parseRequest('action=start\npid=31415\nnonce=' + nonce(1) + '\n'), request(1));
  for (const text of ['action=resume\npid=1\nnonce=' + nonce(1), 'action=start\npid=0\nnonce=' + nonce(1),
    'action=start\npid=1\nnonce=bad', 'action=start\npid=1\nnonce=' + nonce(1) + '\npid=2',
    'action=start\npid=1\nnonce=' + nonce(1) + '\nurl=http://example.test', 'x'.repeat(513)]) {
    assert.throws(() => parseRequest(text), /Invalid/);
  }
  const status = formatStatus({ ...request(1), state: 'waiting', reason: 'paused\nstate=receiving\0' });
  assert.match(status, /reason=paused state=receiving /);
  assert.equal(status.split('\n').filter(line => line.startsWith('state=')).length, 1);
  assert.ok(Buffer.byteLength(status) < 2048);
});

test('bounded control-file reads reject oversized/invalid UTF-8; status replacement leaves no temp files', async t => {
  const directory = await temporary(t), file = path.join(directory, 'status.txt');
  assert.equal(await readBounded(file, 10), null);
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(readBounded(file, 10));
  await fs.writeFile(file, 'too large');
  await assert.rejects(readBounded(file, 3), /invalid/);
  await atomicStatus(file, { ...request(1), state: 'starting', reason: 'Starting' });
  await atomicStatus(file, { ...request(2), state: 'stopped', reason: 'Stopped' });
  assert.match(await readBounded(file, 2048), new RegExp('nonce=' + nonce(2)));
  assert.deepEqual(await fs.readdir(directory), ['status.txt']);
});

test('first launch rejects a request from before the native generation using exact Windows tick conversion', () => {
  const ticks = '639004567890123456';
  const nativeStartedNs = (BigInt(ticks) - 621355968000000000n) * 100n;
  assert.equal(requestIsFreshForNative(nativeStartedNs - 1n, ticks), false);
  assert.equal(requestIsFreshForNative(nativeStartedNs, ticks), true);
  assert.equal(requestIsFreshForNative(nativeStartedNs + 100n, ticks), true);
  for (const [mtime, invalidTicks] of [[Number(nativeStartedNs), ticks], [null, ticks], [-1n, ticks],
    [nativeStartedNs, 'not ticks'], [nativeStartedNs, '1000000000'], [nativeStartedNs, null]]) {
    assert.equal(requestIsFreshForNative(mtime, invalidTicks), false);
  }
});

test('request metadata comes from its own opened file and retains integer mtime precision', async t => {
  const directory = await temporary(t), file = path.join(directory, 'request.txt');
  const content = 'action=start\npid=31415\nnonce=' + nonce(1) + '\n';
  await fs.writeFile(file, content);
  const oldTime = new Date(Date.now() - 10000);
  await fs.utimes(file, oldTime, oldTime);
  const read = await readBounded(file, 512, { metadata: true });
  const expected = await fs.stat(file, { bigint: true });
  assert.equal(read.text, content); assert.equal(typeof read.mtimeNs, 'bigint'); assert.equal(read.mtimeNs, expected.mtimeNs);
  const recycledGenerationTicks = (621355968000000000n + expected.mtimeNs / 100n + 10000n).toString();
  assert.equal(requestIsFreshForNative(read.mtimeNs, recycledGenerationTicks), false);
  await fs.unlink(file); await fs.writeFile(file, content.replace(nonce(1), nonce(2)));
  assert.equal(read.text, content); assert.equal(read.mtimeNs, expected.mtimeNs);
  assert.equal(requestIsFreshForNative((await readBounded(file, 512, { metadata: true })).mtimeNs, recycledGenerationTicks), true);
});

test('Roon HTTP probe pins localhost, rejects redirects and retains only exact playback facts', async () => {
  const payload = { ...facts(), accessToken: 'private', source: 'private', zones: [{ ...facts().zones[0], queue: 'private',
    outputs: [{ output_id: settings.outputId, display_name: 'private' }], now_playing: { title: 'private' } }] };
  const result = await fetchRoonFacts({ fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3777/api/status/live'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(result, facts());
  await assert.rejects(fetchRoonFacts({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.test' } }) }), /unavailable/);
});

test('Roon HTTP probe aborts bounded requests and caps advertised and streamed bodies', async () => {
  await assert.rejects(fetchRoonFacts({ timeoutMs: 15, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) }), /unavailable/);
  for (const headers of [{ 'content-type': 'application/json', 'content-length': '1000' }, { 'content-type': 'application/json' }]) {
    await assert.rejects(fetchRoonFacts({ maxBytes: 20, fetchImpl: async () => new Response('x'.repeat(100), { headers }) }), /unavailable/);
  }
  await assert.rejects(fetchRoonFacts({ fetchImpl: async () => new Response(JSON.stringify({ connected: true, zones: [null] }), { headers: { 'content-type': 'application/json' } }) }), /unavailable/);
});

test('all competitor markers block; only this exact main feed token and PID are excluded', async t => {
  const directory = await temporary(t), file = path.join(directory, 'owner.json');
  const paths = [{ file, ownFeed: true }];
  await assertNoCompetitors({ paths });
  for (const content of ['', '{}', JSON.stringify({ version: 1, token: 'ours', ownerPid: 2, source: 'roon-hqplayer' })]) {
    await fs.writeFile(file, content);
    await assert.rejects(assertNoCompetitors({ paths, ownToken: 'ours', ownerPid: 1 }), /Another app/);
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
  await fs.writeFile(file, JSON.stringify({ version: 1, token: 'ours', ownerPid: 1, source: 'roon-hqplayer' }));
  await assertNoCompetitors({ paths, ownToken: 'ours', ownerPid: 1 });
  await assert.rejects(assertNoCompetitors({ paths: [{ file }], ownToken: 'ours', ownerPid: 1 }), /Another app/);
});

test('daemon lease requires the exact live controller generation; stale and invalid records are preserved', async t => {
  const directory = await temporary(t), ownerPath = path.join(directory, 'owner.json');
  const controllerPath = path.join(directory, 'controller.cjs');
  const identity = { pid: 123, executable: process.execPath, startTimeTicks: native.startTimeTicks, controllerPath };
  assert.equal(scriptArgument('"C:\\Node Folder\\node.exe" "C:\\App Folder\\controller.cjs"'), 'C:\\App Folder\\controller.cjs');
  assert.equal(scriptArgument('node.exe --eval private'), null);
  const owned = await acquireCompanionOwner({ ownerPath, identity, controllerPath });
  t.after(() => owned.handle?.close());
  assert.equal((await acquireCompanionOwner({ ownerPath, identity, controllerPath, probe: async () => identity })).duplicate, true);
  const original = await fs.readFile(ownerPath, 'utf8');
  for (const live of [null, { ...identity, startTimeTicks: '639004567890123457' }, { ...identity, controllerPath: path.join(directory, 'other.cjs') }]) {
    await assert.rejects(acquireCompanionOwner({ ownerPath, identity, controllerPath, probe: async () => live }), /stale or unverified/);
    assert.equal(await fs.readFile(ownerPath, 'utf8'), original);
  }
  await releaseCompanionOwner(owned); await releaseCompanionOwner(owned);
  await fs.writeFile(ownerPath, '{}');
  await assert.rejects(acquireCompanionOwner({ ownerPath, identity, controllerPath }), /inspection/);
  assert.equal(await fs.readFile(ownerPath, 'utf8'), '{}');
});

test('old daemon handle cannot remove a replacement owner even with the same process identity', async t => {
  const directory = await temporary(t), ownerPath = path.join(directory, 'owner.json'), controllerPath = path.join(directory, 'controller.cjs');
  const identity = { pid: 123, executable: process.execPath, startTimeTicks: native.startTimeTicks, controllerPath };
  const owned = await acquireCompanionOwner({ ownerPath, identity, controllerPath });
  await fs.unlink(ownerPath);
  const replacement = { ...owned.record, ownerId: crypto.randomUUID() };
  await fs.writeFile(ownerPath, JSON.stringify(replacement));
  await assert.rejects(releaseCompanionOwner(owned), /changed/);
  assert.deepEqual(JSON.parse(await fs.readFile(ownerPath, 'utf8')), replacement);
});

test('import/controller construction does not start audio; duplicate nonces never restart a feed', async t => {
  const h = harness(); t.after(() => h.controller.close());
  await h.controller.tick(); assert.equal(h.feeds.length, 0);
  await h.controller.handle(request(1)); await h.controller.handle(request(1));
  assert.equal(h.feeds.length, 1); assert.equal(h.feeds[0].starts, 1);
  assert.equal(h.controller.status().state, 'receiving');
  await h.controller.handle(request(2, 'stop'));
  assert.equal(h.controller.status().state, 'stopped');
  await h.controller.tick(); assert.equal(h.feeds.length, 1);
});

test('preflight rejects unavailable/grouped/wrong outputs and busy ownership without opening audio', async t => {
  for (const state of [{ ...facts(), connected: false }, { connected: true, zones: [] },
    { connected: true, zones: [{ ...facts().zones[0], outputs: [{ output_id: 'c'.repeat(24) }] }] },
    { connected: true, zones: [{ ...facts().zones[0], outputs: [...facts().zones[0].outputs, { output_id: 'c'.repeat(24) }] }] }]) {
    const h = harness({ getRoonState: async () => state }); t.after(() => h.controller.close());
    await h.controller.handle(request(1)); assert.equal(h.feeds.length, 0); assert.equal(h.controller.status().state, 'waiting');
  }
  const occupied = harness(); t.after(() => occupied.controller.close()); occupied.setOccupied(true);
  await occupied.controller.handle(request(1)); assert.equal(occupied.feeds.length, 0);
});

test('only an explicit paused or stopped selection waits for the exact zone and starts once when it plays', async t => {
  for (const state of ['paused', 'stopped']) {
    const h = harness(); t.after(() => h.controller.close()); h.setFacts(idleFacts(state));
    await h.controller.tick(); assert.equal(h.feeds.length, 0); assert.equal(h.controller.status(), null);
    await h.controller.handle(request(1));
    assert.equal(h.feeds.length, 0); assert.equal(h.controller.status().state, 'waiting');
    assert.match(h.controller.status().reason, /Keep HQPlayer Audio selected/);
    await h.controller.tick(); assert.equal(h.feeds.length, 0);
    h.setFacts(facts()); await h.controller.tick(); await h.controller.tick(); await h.controller.handle(request(1));
    assert.equal(h.feeds.length, 1); assert.equal(h.feeds[0].starts, 1); assert.equal(h.controller.status().nonce, nonce(1));
    assert.equal(h.controller.status().state, 'receiving');
  }
});

test('unsafe facts, competing owners and changed configured pins/cable cancel pending selection permanently', async t => {
  const cases = [
    h => h.setFacts({ ...facts(), connected: false }),
    h => h.setFacts({ connected: true, zones: [] }),
    h => h.setFacts({ connected: true, zones: [{ ...facts().zones[0], zone_id: 'c'.repeat(24) }] }),
    h => h.setFacts({ connected: true, zones: [{ ...facts().zones[0], outputs: [{ output_id: 'c'.repeat(24) }] }] }),
    h => h.setFacts({ connected: true, zones: [{ ...facts().zones[0], outputs: [...facts().zones[0].outputs, { output_id: 'c'.repeat(24) }] }] }),
    h => h.setFacts(idleFacts('loading')), h => h.setOccupied(true),
    h => h.setSettings({ ...settings, enabled: false }),
    h => h.setSettings({ ...settings, zoneId: 'c'.repeat(24) }),
    h => h.setSettings({ ...settings, outputId: 'c'.repeat(24) }),
    h => h.setSettings({ ...settings, route: { fingerprint: 'e'.repeat(64) } })
  ];
  for (const makeUnsafe of cases) {
    const h = harness(); t.after(() => h.controller.close()); h.setFacts(idleFacts('paused'));
    await h.controller.handle(request(1)); makeUnsafe(h); await h.controller.tick();
    assert.equal(h.feeds.length, 0); assert.match(h.controller.status().reason, /again to retry/);
    h.setFacts(facts()); h.setSettings(settings); h.setOccupied(false); await h.controller.tick();
    assert.equal(h.feeds.length, 0);
  }
});

test('disabled setup, missing cable fingerprint and unknown initial states never arm playback intent', async t => {
  for (const override of [h => h.setSettings({ ...settings, enabled: false }),
    h => h.setSettings({ ...settings, route: undefined }), h => h.setFacts(idleFacts('loading'))]) {
    const h = harness(); t.after(() => h.controller.close()); h.setFacts(idleFacts('paused')); override(h);
    await h.controller.handle(request(1)); h.setSettings(settings); h.setFacts(facts()); await h.controller.tick();
    assert.equal(h.feeds.length, 0); assert.match(h.controller.status().reason, /again to retry/);
  }
});

test('Stop or a newer native request cancels pending intent even during an in-flight playback check', async t => {
  const checking = deferred(), continueCheck = deferred();
  let state = idleFacts('paused'), hold = false;
  const h = harness({ getRoonState: async () => {
    if (hold) { checking.resolve(); await continueCheck.promise; }
    return state;
  } });
  t.after(() => h.controller.close());
  await h.controller.handle(request(1)); state = facts(); hold = true;
  const tick = h.controller.tick(); await checking.promise;
  await h.controller.handle(request(2, 'stop')); continueCheck.resolve(); await tick;
  assert.equal(h.feeds.length, 0); assert.equal(h.controller.status().nonce, nonce(2)); assert.equal(h.controller.status().state, 'stopped');
  hold = false; state = idleFacts('paused'); await h.controller.handle(request(3));
  await h.controller.handle(request(4)); state = facts(); await h.controller.tick();
  assert.equal(h.feeds.length, 1); assert.equal(h.controller.status().nonce, nonce(4));
});

test('native generation exit cancels a pending selection without opening a feed', async () => {
  const h = harness(); h.setFacts(idleFacts('paused')); await h.controller.handle(request(1));
  h.setNative({ ...native, startTimeTicks: '639004567890123457' });
  assert.deepEqual(await h.controller.tick(), { closed: true }); await h.controller.close();
  assert.equal(h.feeds.length, 0); assert.equal(h.controller.status().state, 'stopped');
});

test('pending choice is consumed once through all start guards and never retries a failed launch', async t => {
  let h, made = 0;
  h = harness({ feedFactory: options => {
    made++; h.setFacts(idleFacts('paused'));
    return { async start() { await options.requireZone(settings.zoneId, settings); }, async stop() {},
      snapshot: () => ({ state: 'receiving', reason: 'Receiving' }) };
  } });
  t.after(() => h.controller.close()); h.setFacts(idleFacts('stopped'));
  await h.controller.handle(request(1)); h.setFacts(facts()); await h.controller.tick();
  assert.equal(made, 1); assert.match(h.controller.status().reason, /again to retry/);
  h.setFacts(facts()); await h.controller.tick(); assert.equal(made, 1);
});

test('pending start rejects settings changed after playback readiness before adapter creation', async t => {
  let reads = 0;
  const h = harness({ loadSettings: async () => {
    reads++;
    return reads >= 3 ? { ...settings, route: { fingerprint: 'e'.repeat(64) } } : settings;
  } });
  t.after(() => h.controller.close()); h.setFacts(idleFacts('paused'));
  await h.controller.handle(request(1)); h.setFacts(facts()); await h.controller.tick();
  assert.equal(h.feeds.length, 0); assert.match(h.controller.status().reason, /changed or was disabled/);
  await h.controller.tick(); assert.equal(h.feeds.length, 0);
});

test('a feed started by pending intent still never resumes automatically after a later runtime pause', async t => {
  const h = harness(); t.after(() => h.controller.close()); h.setFacts(idleFacts('paused'));
  await h.controller.handle(request(1)); h.setFacts(facts()); await h.controller.tick();
  assert.equal(h.feeds.length, 1);
  h.setFacts(idleFacts('paused')); await h.feeds[0].checkSafety(); await settle();
  assert.match(h.controller.status().reason, /again to retry/);
  h.setFacts(facts()); await h.controller.tick(); assert.equal(h.feeds.length, 1);
});

test('native generation and competitor ownership are rechecked after the Roon read before feed creation', async t => {
  for (const failure of ['native', 'competitor']) {
    let h;
    h = harness({ getRoonState: async () => {
      if (failure === 'native') h.setNative({ ...native, startTimeTicks: '639004567890123457' });
      else h.setOccupied(true);
      return facts();
    } });
    t.after(() => h.controller.close());
    await h.controller.handle(request(1)); assert.equal(h.feeds.length, 0);
  }
});

test('Stop cancels an in-flight start and its old status cannot overwrite the new nonce', async t => {
  const started = deferred(), resume = deferred();
  let stopCount = 0;
  const h = harness({ feedFactory: options => ({ ownerToken: '',
    async start() { started.resolve(); await resume.promise; await options.requireZone(settings.zoneId, settings); },
    async stop() { stopCount++; resume.resolve(); }, snapshot: () => ({ state: 'receiving', reason: 'Receiving' })
  }) });
  t.after(() => h.controller.close());
  const first = h.controller.handle(request(1)); await started.promise;
  const second = h.controller.handle(request(2, 'stop')); await Promise.all([first, second]);
  assert.ok(stopCount >= 1); assert.equal(h.controller.status().nonce, nonce(2)); assert.equal(h.controller.status().state, 'stopped');
  const stoppedIndex = h.statuses.findIndex(item => item.nonce === nonce(2));
  assert.ok(h.statuses.slice(stoppedIndex).every(item => item.nonce === nonce(2)));
});

test('pause/disconnection safety failures wait until another explicit native selection', async t => {
  const h = harness(); t.after(() => h.controller.close());
  await h.controller.handle(request(1));
  h.setFacts({ ...facts(), connected: false }); await h.feeds[0].checkSafety(); await settle();
  assert.equal(h.controller.status().state, 'waiting');
  h.setFacts(facts()); await h.controller.tick(); await h.controller.handle(request(1));
  assert.equal(h.feeds.length, 1);
  await h.controller.handle(request(2)); assert.equal(h.feeds.length, 2); assert.equal(h.controller.status().state, 'receiving');
});

test('new competitor stops only this feed, then recovery still needs an explicit selection', async t => {
  const h = harness(); t.after(() => h.controller.close());
  await h.controller.handle(request(1)); h.setOccupied(true); await h.controller.tick();
  assert.equal(h.controller.status().state, 'waiting'); assert.ok(h.feeds[0].stops > 0);
  h.setOccupied(false); await h.controller.tick(); assert.equal(h.feeds.length, 1);
});

test('native generation exit closes the companion idempotently without creating another renderer', async () => {
  const h = harness(); await h.controller.handle(request(1)); h.setNative(null);
  assert.deepEqual(await h.controller.tick(), { closed: true });
  await h.controller.close(); await h.controller.close();
  assert.equal(h.controller.status().state, 'stopped'); assert.equal(h.feeds.length, 1);
  await assert.rejects(h.controller.handle(request(2)), /closed/);
});

test('cleanup failure blocks later Start until explicit Stop successfully cleans the owned lease', async () => {
  let failCleanup = false, made = 0;
  const h = harness({ feedFactory: () => { made++; return {
    ownerToken: 'ours', async start() {}, async stop() { if (failCleanup) throw Error('child alive'); },
    snapshot: () => ({ state: 'receiving', reason: 'Receiving' })
  }; } });
  try {
    await h.controller.handle(request(1)); failCleanup = true;
    await h.controller.handle(request(2, 'stop')); assert.equal(h.controller.status().state, 'error');
    failCleanup = false; await h.controller.handle(request(3)); assert.equal(made, 1); assert.equal(h.controller.status().state, 'error');
    await h.controller.handle(request(4, 'stop')); await h.controller.handle(request(5)); assert.equal(made, 2);
  } finally { failCleanup = false; await h.controller.close(); }
});

test('an adapter failure during Start cannot be resurrected by Start completing', async t => {
  const h = harness({ feedFactory: () => ({ ownerToken: '',
    async start({ onFailure }) { onFailure(Error('writer failed')); }, async stop() {},
    snapshot: () => ({ state: 'error', reason: 'writer failed' })
  }) });
  t.after(() => h.controller.close());
  await h.controller.handle(request(1)); await settle(); await h.controller.tick();
  assert.equal(h.controller.status().state, 'waiting');
});

test('a status write failure cleans its owned audio instead of silently leaving it running', async () => {
  let stops = 0;
  const h = harness({ publish: async value => { if (value.state === 'receiving') throw Error('disk unavailable'); },
    feedFactory: () => ({ async start() {}, async stop() { stops++; }, snapshot: () => ({ state: 'receiving' }) }) });
  try { await h.controller.handle(request(1)); assert.ok(stops > 0); }
  finally { await h.controller.close(); }
});

test('private diagnostic projects finite measurements and fixed categories without source or device secrets', () => {
  const value = feedDiagnostic(request(1), {
    state: 'receiving', reason: 'private device path', route: 'private route', ownerToken: 'private owner',
    analysisBytes: 42, analysisFrames: Infinity, pcmBytes: -1, pcmAgeMs: null,
    derivedSignal: { samples: 4, peak: 0.5, rmsDbfs: -22, peakDbfs: null, ageMs: NaN, silent: false, route: 'private' },
    outputDiagnostic: { writeCalls: 2, writeCompletions: 1, blockedMs: 17.5, lastProgressAgeMs: null,
      exitCode: -1, signal: 'SIGTERM', errorCode: 'BACKPRESSURE_TIMEOUT', stderrReason: 'device-unavailable',
      writableBytes: Infinity, peakWritableBytes: -3, pacerGaps: '2', stderr: 'private output', device: 'private device' }
  }, 'active', 123);
  assert.deepEqual(value, { version: 1, pid: native.pid, nonce: nonce(1), event: 'active', at: 123, state: 'receiving',
    analysisBytes: 42, pcmAgeMs: null, derivedSignal: { samples: 4, peak: 0.5, peakDbfs: null, rmsDbfs: -22, silent: false },
    outputDiagnostic: { writeCalls: 2, writeCompletions: 1, blockedMs: 17.5, lastProgressAgeMs: null,
      exitCode: -1, signal: 'SIGTERM', errorCode: 'BACKPRESSURE_TIMEOUT', stderrReason: 'device-unavailable' } });
  const unknown = feedDiagnostic(request(1), { state: 'private state', outputDiagnostic: {
    signal: 'private signal', errorCode: 'private code', stderrReason: 'private stderr' } }, 'failure', 124);
  assert.equal(unknown.state, 'error'); assert.deepEqual(unknown.outputDiagnostic, {});
  assert.doesNotMatch(JSON.stringify([value, unknown]), /private/);
});

test('atomic diagnostic replacement uses only its temporary fixture and leaves no temporary files', async t => {
  const directory = await temporary(t), file = path.join(directory, 'feed-diagnostic.json');
  const first = feedDiagnostic(request(1), { state: 'receiving', outputDiagnostic: { writeCalls: 4 } }, 'active', 1);
  const last = feedDiagnostic(request(1), { outputDiagnostic: { errorCode: 'EPIPE' } }, 'failure', 2);
  await atomicDiagnostic(file, first); await atomicDiagnostic(file, last);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), last);
  assert.deepEqual(await fs.readdir(directory), ['feed-diagnostic.json']);
});

test('diagnostic collection has no construction/start demand and publishes once per coalesced active tick', async t => {
  const checking = deferred(), release = deferred(); let hold = false;
  const h = harness({ competitors: async () => { if (hold) { checking.resolve(); await release.promise; } } });
  t.after(() => h.controller.close());
  await h.controller.tick(); await h.controller.handle(request(1)); await settle();
  assert.equal(h.diagnostics.length, 0); hold = true;
  const first = h.controller.tick(); await checking.promise;
  const second = h.controller.tick(); assert.equal(second, first);
  release.resolve(); await Promise.all([first, second]); await settle();
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.diagnostics[0].pid, native.pid); assert.equal(h.diagnostics[0].nonce, nonce(1));
  assert.equal(h.diagnostics[0].event, 'active'); assert.equal(h.diagnostics[0].state, 'receiving');
  await h.controller.handle(request(2, 'stop')); await h.controller.tick(); await settle();
  assert.equal(h.diagnostics.length, 1);
});

test('failed adapter measurement is captured once before cleanup and retained through Stop until a new active tick', async t => {
  const h = harness(); t.after(() => h.controller.close()); await h.controller.handle(request(1));
  const item = h.feeds[0]; let writeCalls = 17;
  item.snapshot = () => ({ state: item.state, outputDiagnostic: { writeCalls, errorCode: 'BACKPRESSURE_TIMEOUT' } });
  item.stop = async () => { item.stops++; item.ownerToken = ''; item.state = 'waiting'; writeCalls = 0; };
  item.state = 'error'; item.onFailure(Error('writer failed')); item.onFailure(Error('writer failed again'));
  await settle(); await h.controller.tick(); await settle();
  assert.equal(h.diagnostics.length, 1); assert.equal(h.diagnostics[0].event, 'failure');
  assert.equal(h.diagnostics[0].outputDiagnostic.writeCalls, 17); assert.equal(h.diagnostics[0].state, 'error');
  await h.controller.handle(request(2, 'stop')); await h.controller.tick(); await settle();
  assert.equal(h.diagnostics.length, 1); assert.equal(h.diagnostics[0].nonce, nonce(1));
  await h.controller.handle(request(3)); await h.controller.tick(); await settle();
  assert.equal(h.diagnostics.length, 2); assert.equal(h.diagnostics[1].event, 'active'); assert.equal(h.diagnostics[1].nonce, nonce(3));
});

test('slow diagnostic writes coalesce periodic samples and retain pending failure across Stop without delaying lifecycle', async () => {
  const writing = deferred(), calls = [];
  const h = harness({ publishDiagnostic: async value => { calls.push(value); if (calls.length === 1) await writing.promise; } });
  try {
    await h.controller.handle(request(1)); const item = h.feeds[0]; let writeCalls = 1;
    item.snapshot = () => ({ state: item.state, outputDiagnostic: { writeCalls } });
    await h.controller.tick(); await settle(); assert.equal(calls.length, 1);
    for (writeCalls = 2; writeCalls <= 4; writeCalls++) await h.controller.tick();
    assert.equal(calls.length, 1); assert.equal(item.stops, 0);
    writeCalls = 99; item.state = 'error'; item.onFailure(Error('writer failed'));
    await settle(); await h.controller.handle(request(2, 'stop')); await h.controller.close();
    assert.equal(h.controller.status().state, 'stopped'); assert.equal(calls.length, 1);
    writing.resolve(); await settle(); await settle();
    assert.equal(calls.length, 2); assert.equal(calls[1].event, 'failure');
    assert.equal(calls[1].nonce, nonce(1)); assert.equal(calls[1].outputDiagnostic.writeCalls, 99);
  } finally { writing.resolve(); await h.controller.close(); }
});

test('slow diagnostic writer keeps only the latest pending active sample', async t => {
  const writing = deferred(), calls = [];
  const h = harness({ publishDiagnostic: async value => { calls.push(value); if (calls.length === 1) await writing.promise; } });
  t.after(async () => { writing.resolve(); await h.controller.close(); });
  await h.controller.handle(request(1)); const item = h.feeds[0]; let writeCalls = 1;
  item.snapshot = () => ({ state: item.state, outputDiagnostic: { writeCalls } });
  await h.controller.tick(); await settle();
  for (writeCalls = 2; writeCalls <= 5; writeCalls++) await h.controller.tick();
  assert.equal(calls.length, 1); writing.resolve(); await settle(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[0].outputDiagnostic.writeCalls, 1); assert.equal(calls[1].outputDiagnostic.writeCalls, 5);
});

test('stale failure callbacks cannot overwrite a new request diagnostic', async t => {
  const h = harness(); t.after(() => h.controller.close()); await h.controller.handle(request(1));
  const old = h.feeds[0]; await h.controller.handle(request(2)); old.onFailure(Error('old writer failed'));
  await h.controller.tick(); await settle();
  assert.equal(h.diagnostics.length, 1); assert.equal(h.diagnostics[0].nonce, nonce(2)); assert.equal(h.diagnostics[0].event, 'active');
  assert.equal(h.controller.status().state, 'receiving'); assert.equal(h.feeds[1].stops, 0);
});

test('diagnostic publisher failure cannot stop or restart a receiving feed', async t => {
  let writes = 0;
  const h = harness({ publishDiagnostic: () => { writes++; throw Error('private disk failure'); } });
  t.after(() => h.controller.close()); await h.controller.handle(request(1));
  await h.controller.tick(); await settle(); await h.controller.tick(); await settle();
  assert.equal(writes, 2); assert.equal(h.feeds.length, 1); assert.equal(h.feeds[0].starts, 1); assert.equal(h.feeds[0].stops, 0);
  assert.equal(h.controller.status().state, 'receiving');
});
