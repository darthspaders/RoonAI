'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { HqplayerFeed, createIntegration, INPUT, HOST, PORT, MAX_PCM } = require('./index.cjs');
const { toneFrame } = require('./fixtures.cjs');

class FakeStream extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writableLength = 0; this.writableNeedDrain = false; this.writes = []; }
  write(bytes) { if (this.destroyed) throw Error('closed'); this.writes.push(Buffer.from(bytes)); return !this.writableNeedDrain; }
  destroy() { this.destroyed = true; }
}
class FakeChild extends EventEmitter {
  constructor(worker) { super(); this.worker = worker; this.exitCode = null; this.signalCode = null; this.connected = worker;
    this.stdin = new FakeStream(); this.stderr = new FakeStream(); this.messages = []; this.kills = 0; }
  send(message, callback) { this.messages.push(message); callback?.(); if (message.type === 'close') this.kill(); return true; }
  kill() { if (this.exitCode !== null) return; this.kills++; this.connected = false; this.exitCode = 0; queueMicrotask(() => this.emit('close', 0)); }
}
class FakeSocket extends EventEmitter {
  constructor(options) { super(); this.options = options; this.destroyed = false; this.writes = 0; }
  setNoDelay() {} setTimeout(ms) { this.timeout = ms; }
  write() { this.writes++; throw Error('Receive-only connection wrote bytes.'); }
  destroy() { if (this.destroyed) return; this.destroyed = true; queueMicrotask(() => this.emit('close')); }
}

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hqp-analysis-')), settingsPath = path.join(dir, 'settings.json');
  const settings = { version: 1, enabled: true, zoneId: 'zone-one', outputId: 'output-one', route: { fingerprint: 'a'.repeat(64) } };
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  const children = [], sockets = [], checked = []; let now = 1000, safe = true, cable = true;
  const output = { probeOutput: async () => ({ available: cable, reason: cable ? '' : 'listen-enabled' }),
    buildOutputCommand: () => ({ command: 'owned-output-test', args: [] }), validateOutput: async () => ({ available: cable, reason: cable ? '' : 'listen-enabled' }),
    createInputProvider: () => ({}) };
  const feed = new HqplayerFeed({ settingsPath, output, timers: false, clock: () => now, paceClock: () => now,
    requireZone: async (id, saved) => { checked.push({ id, outputId: saved.outputId }); if (!safe) throw Error('The exact Roon HQPlayer zone is no longer playing.'); },
    spawnImpl: (command, args) => { const child = new FakeChild(args.some(v => /dsp-worker/.test(v))); children.push(child); if (child.worker) queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; },
    socketFactory: o => { const socket = new FakeSocket(o); sockets.push(socket); return socket; }, ...options });
  t.after(async () => { await feed.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, settingsPath, settings, feed, output, children, sockets, checked,
    time: ms => { now += ms; }, unsafe: () => { safe = false; }, cableUnsafe: () => { cable = false; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('default-off import, construction and inspection create no socket, child, owner or settings', async t => {
  const f = await fixture(t); await fs.unlink(f.settingsPath);
  const input = await f.feed.inspect(true); assert.equal(input.id, INPUT); assert.equal(input.source, 'roon-hqplayer'); assert.equal(input.available, false);
  assert.equal(f.children.length, 0); assert.equal(f.sockets.length, 0);
  await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
  await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /off/);
  const integration = createIntegration({ output: f.output, settingsPath: f.settingsPath }); assert.ok(integration.audioFeed); assert.equal(f.children.length, 0);
});

test('exact pinned Roon zone and output are required; Lyrion player IDs cannot substitute', async t => {
  const f = await fixture(t);
  await assert.rejects(f.feed.start({ zoneId: 'zone-two' }), /exact configured/);
  await assert.rejects(f.feed.start({ playerId: 'zone-one' }), /exact configured/);
  f.unsafe(); await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /no longer playing/);
  assert.equal(f.children.length, 0); assert.equal(f.sockets.length, 0);
  assert.equal(f.checked.at(-1).outputId, 'output-one');
});

test('explicit Start owns only receive-only meter 4322 and its writer/worker, then drained Stop removes ownership', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].options.host, HOST); assert.equal(f.sockets[0].options.port, PORT);
  assert.equal(f.sockets[0].writes, 0); assert.equal(f.children.length, 2);
  assert.equal(f.feed.snapshot().zoneId, 'zone-one'); assert.equal(Object.hasOwn(f.feed.snapshot(), 'playerId'), false);
  assert.equal((await f.feed.inspect(true)).zoneId, 'zone-one');
  await fs.access(f.feed.ownerPath); await f.feed.stop();
  assert.ok(f.children.every(c => c.exitCode === 0)); assert.equal(f.sockets[0].destroyed, true);
  assert.equal(f.feed.snapshot().bufferedBytes, 0); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('timed-out cleanup retains owned handles and lock for a later safe Stop retry', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const writer = f.children[0]; writer.kill = function() { this.kills++; };
  await assert.rejects(f.feed.stop(), /did not close/);
  assert.equal(f.feed.retiredChildren[0].child, writer); assert.equal(writer.kills, 1); await fs.access(f.feed.ownerPath);
  assert.equal(JSON.parse(await fs.readFile(f.feed.ownerPath)).children.length, 2);
  writer.kill = function() { this.kills++; this.exitCode = 0; queueMicrotask(() => this.emit('close', 0)); };
  await f.feed.stop(); assert.equal(writer.kills, 2); assert.equal(f.feed.retiredChildren.length, 0);
  await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('cancellation while a Roon guard is pending prevents later source/device startup', async t => {
  let resolveGuard; const f = await fixture(t, { requireZone: () => new Promise(resolve => { resolveGuard = resolve; }) });
  const pending = f.feed.start({ zoneId: 'zone-one' }); const rejected = assert.rejects(pending, /cancelled/);
  while (!resolveGuard) await turn(); await f.feed.stop(); resolveGuard(); await rejected;
  assert.equal(f.children.length, 0); assert.equal(f.sockets.length, 0); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('another owner or crash lock fails closed without being overwritten or stolen', async t => {
  const f = await fixture(t), foreign = { token: 'foreign', ownerPid: 12345 };
  await fs.writeFile(f.feed.ownerPath, JSON.stringify(foreign));
  await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.feed.ownerPath)), foreign); assert.equal(f.children.length, 0);
});

test('one work batch in flight and bounded latest pending frames tolerate a normal burst', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const bytes = toneFrame(); f.sockets[0].emit('data', Buffer.concat(Array.from({ length: 8 }, () => bytes)));
  const worker = f.children[1]; assert.equal(worker.messages.filter(m => m.type === 'frames').length, 1);
  f.sockets[0].emit('data', Buffer.concat(Array.from({ length: 24 }, () => bytes))); await turn();
  assert.ok(f.feed.pending.length <= 12); assert.ok(f.feed.pendingSeconds <= 0.2501); assert.ok(f.feed.droppedAnalysis > 0);
  const first = worker.messages.find(m => m.type === 'frames'); assert.equal(first.frames.length, 8);
  worker.emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: first.frames.at(-1).sequence, pcm: Buffer.alloc(8 * 1024 * 4), resets: 0 });
  assert.equal(worker.messages.filter(m => m.type === 'frames').length, 2); assert.ok(f.feed.pcmSize <= 44100);
  assert.equal(f.sockets[0].writes, 0);
});

test('recognizable transition metadata clears PCM, rejects stale work and resumes at valid 48k geometry', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.sockets[0].emit('data', toneFrame()); const old = f.feed.inflight;
  f.feed.pcm = [Buffer.alloc(4096, 10)]; f.feed.pcmSize = 4096;
  const transition = toneFrame(); transition.writeFloatLE(24000, 16);
  f.sockets[0].emit('data', transition); assert.equal(f.feed.pcmSize, 0); assert.equal(f.feed.metadataRun, 1);
  const diagnostic = f.feed.snapshot().analysisDiagnostic; assert.equal(diagnostic.rejectedHeader.bandwidth, 24000); assert.equal(diagnostic.discardedMetadataFrames, 1);
  f.sockets[0].emit('data', toneFrame({ rate: 48000 })); assert.equal(f.feed.metadataRun, 0); assert.equal(f.feed.meterFormat.sourceRate, 48000);
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: old.sequence, pcm: Buffer.alloc(4096, 5), resets: 0 });
  assert.equal(f.feed.pcmSize, 0); assert.equal(f.feed.inflight.sequence, 3);
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: 3, pcm: Buffer.alloc(4096, 5), resets: 1 });
  assert.equal(f.feed.pcmSize, 4096); assert.equal(f.feed.state, 'receiving'); assert.equal(f.sockets[0].writes, 0);
});

test('metadata transition recovery is bounded by frames and time, while unknown layout is immediately fatal', async t => {
  for (const kind of ['frames', 'time', 'layout']) {
    const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn(); const bytes = toneFrame();
    if (kind === 'layout') { bytes.writeUInt32LE(3, 4); f.sockets[0].emit('data', bytes); }
    else {
      bytes.writeFloatLE(24000, 16);
      if (kind === 'frames') { f.sockets[0].emit('data', Buffer.concat(Array.from({ length: 17 }, () => bytes))); await turn(); }
      else { f.sockets[0].emit('data', bytes); f.time(500); f.feed.tick(); }
    }
    await f.feed.failureCleanup; assert.equal(f.feed.state, 'error'); assert.equal(f.feed.snapshot().bufferedBytes, 0);
    assert.ok(f.children.every(c => c.exitCode === 0)); assert.ok(f.feed.lastRejectedHeader);
  }
});

test('a zero-bit source gap survives more than sixteen frames, stays silent and resumes known source audio', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.sockets[0].emit('data', toneFrame()); const old = f.feed.inflight;
  f.feed.pcm = [Buffer.alloc(4096, 10)]; f.feed.pcmSize = 4096;
  const inactive = toneFrame({ sourceBits: 0 }); f.sockets[0].emit('data', inactive);
  assert.equal(f.feed.pcmSize, 0); assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.sourceInactive, true);
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: old.sequence, pcm: Buffer.alloc(4096, 10), resets: 0 });
  const silentWork = f.feed.inflight;
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: silentWork.sequence, pcm: Buffer.alloc(4096), resets: 1 });
  assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.derivedSignal.snapshot(1000).silent, true);
  f.sockets[0].emit('data', Buffer.concat(Array.from({ length: 24 }, () => inactive))); await turn(); await turn();
  assert.ok(f.feed.inactiveSourceFrames >= 25); assert.equal(f.feed.metadataRun, 0); assert.equal(f.feed.state, 'waiting');
  const retired = f.feed.inflight;
  f.sockets[0].emit('data', toneFrame({ rate: 48000 })); assert.equal(f.feed.sourceInactive, false); assert.equal(f.feed.pcmSize, 0);
  f.children[1].emit('message', { type: 'failure', epoch: f.feed.epoch, sequence: retired.sequence });
  assert.equal(f.feed.state, 'waiting'); assert.ok(f.feed.inflight);
  const fresh = f.feed.inflight;
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: fresh.sequence, pcm: Buffer.alloc(4096, 10), resets: 1 });
  assert.equal(f.feed.state, 'receiving'); assert.equal(f.feed.pcmSize, 4096); assert.equal(f.feed.snapshot().analysisDiagnostic.inactiveHeader.sourceBits, 0);
});

test('zero-bit source recovery has a separate thirty-second deadline despite fresh frames', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const inactive = toneFrame({ sourceBits: 0 }); f.sockets[0].emit('data', inactive); let work = f.feed.inflight;
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: work.sequence, pcm: Buffer.alloc(4096), resets: 1 });
  f.time(29999); f.sockets[0].emit('data', inactive); work = f.feed.inflight;
  f.children[1].emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: work.sequence, pcm: Buffer.alloc(4096), resets: 0 });
  f.feed.tick(); assert.equal(f.feed.state, 'waiting'); f.time(1); f.feed.tick(); await f.feed.failureCleanup;
  assert.equal(f.feed.state, 'error'); assert.match(f.feed.reason, /resume source audio/); assert.ok(f.children.every(c => c.exitCode === 0));
});

test('a retired metadata batch failure cannot kill a recovered source but current malformed data fails closed', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.sockets[0].emit('data', toneFrame()); const retired = f.feed.inflight;
  const transition = toneFrame(); transition.writeFloatLE(24000, 16); f.sockets[0].emit('data', transition);
  f.sockets[0].emit('data', toneFrame({ rate: 48000 }));
  f.children[1].emit('message', { type: 'failure', epoch: f.feed.epoch, sequence: retired.sequence });
  assert.equal(f.feed.state, 'waiting'); const current = f.feed.inflight; assert.ok(current);
  f.children[1].emit('message', { type: 'failure', epoch: f.feed.epoch, sequence: current.sequence }); await f.feed.failureCleanup;
  assert.equal(f.feed.state, 'error'); assert.equal(f.feed.snapshot().bufferedBytes, 0);
});

test('unsolicited or malformed worker replies cannot dereference missing work or disturb an active request', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn(); const worker = f.children[1];
  for (const type of ['pcm', 'failure']) assert.doesNotThrow(() => worker.emit('message', { type, epoch: f.feed.epoch }));
  assert.equal(f.feed.state, 'waiting'); f.sockets[0].emit('data', toneFrame()); const work = f.feed.inflight;
  for (const sequence of [undefined, NaN, Number.MAX_SAFE_INTEGER + 1, String(work.sequence)]) {
    assert.doesNotThrow(() => worker.emit('message', { type: 'failure', epoch: f.feed.epoch, sequence }));
    assert.equal(f.feed.inflight, work); assert.equal(f.feed.state, 'waiting');
  }
});

test('stale worker epochs and results from retired meter sockets cannot refill current PCM', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn(); f.sockets[0].emit('data', toneFrame());
  const work = f.feed.inflight, epoch = f.feed.epoch;
  f.feed.workerMessage({ type: 'pcm', epoch: epoch - 1, sequence: work.sequence, pcm: Buffer.alloc(4096), resets: 0 }, epoch);
  assert.equal(f.feed.pcmSize, 0);
  f.sockets[0].destroy(); await turn();
  f.feed.workerMessage({ type: 'pcm', epoch, sequence: work.sequence, pcm: Buffer.alloc(4096), resets: 0 }, epoch);
  assert.equal(f.feed.pcmSize, 0); assert.equal(f.feed.state, 'waiting');
});

test('pacing submits bounded elapsed-time PCM and drops only its stale disposable copy', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.feed.pcm = [Buffer.alloc(MAX_PCM, 10)]; f.feed.pcmSize = MAX_PCM;
  f.time(21); f.feed.tick(); assert.equal(f.children[0].stdin.writes.at(-1).length / 4, Math.floor(21 * 44.1));
  f.time(700); f.feed.tick(); assert.equal(f.children[0].stdin.writes.at(-1).length / 4, 4410); assert.ok(f.feed.droppedPcm > 0);
  assert.ok(f.feed.snapshot().submittedSignal.rms > 0); assert.equal(f.sockets[0].writes, 0);
});

test('output backpressure fails only this owned feed and calls failure once after cleanup', async t => {
  const f = await fixture(t); let failures = 0;
  await f.feed.start({ zoneId: 'zone-one', onFailure: () => { failures++; } }); await turn();
  f.children[0].stdin.writableNeedDrain = true; f.feed.tick(); f.time(2001); f.feed.tick(); await f.feed.failureCleanup;
  assert.equal(failures, 1); assert.equal(f.feed.state, 'error'); assert.ok(f.children.every(c => c.exitCode === 0));
  assert.equal(f.feed.snapshot().bufferedBytes, 0); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('pause/disconnect, disabled settings and unsafe Listen each stop the analysis without playback commands', async t => {
  const f = await fixture(t); let failures = 0;
  for (const kind of ['zone', 'settings', 'cable']) {
    const run = await fixture(t); await run.feed.start({ zoneId: 'zone-one', onFailure: () => { failures++; } }); await turn();
    if (kind === 'zone') run.unsafe();
    if (kind === 'settings') await fs.writeFile(run.settingsPath, JSON.stringify({ ...run.settings, enabled: false }));
    if (kind === 'cable') run.cableUnsafe();
    await run.feed.checkSafety(); await run.feed.failureCleanup;
    assert.equal(run.feed.state, 'error'); assert.equal(run.sockets[0].writes, 0); assert.ok(run.children.every(c => c.exitCode === 0));
  }
  assert.equal(failures, 3); assert.equal(f.children.length, 0);
});

test('missing analysis and excessive parser input fail with bounded cleanup', async t => {
  for (const kind of ['stale', 'overflow']) {
    const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
    if (kind === 'stale') { f.time(10001); f.feed.tick(); }
    else f.sockets[0].emit('data', Buffer.alloc(1024 * 1024 + 1));
    await f.feed.failureCleanup; assert.equal(f.feed.state, 'error'); assert.equal(f.feed.snapshot().bufferedBytes, 0);
  }
});

test('reconnection attempts are bounded and never enter the control channel', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  for (let i = 0; i < 4; i++) { f.sockets.at(-1).destroy(); await turn(); if (i < 3) f.feed.connect(f.feed.epoch); }
  await f.feed.failureCleanup; assert.equal(f.feed.state, 'error'); assert.equal(f.sockets.length, 4);
  assert.ok(f.sockets.every(s => s.options.port === 4322 && s.writes === 0));
});
