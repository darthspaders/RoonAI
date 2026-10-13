'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { HqplayerFeed, createIntegration, INPUT, HOST, PORT, MAX_PCM } = require('./index.cjs');
const { toneFrame } = require('./fixtures.cjs');
const { AnalysisDsp } = require('./dsp.cjs');

class FakeStream extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writableLength = 0; this.writableNeedDrain = false; this.writes = []; this.callbacks = []; }
  write(bytes, callback) { if (this.destroyed) throw Error('closed'); this.writes.push(Buffer.from(bytes)); this.callbacks.push(callback); return !this.writableNeedDrain; }
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
  const children = [], sockets = [], checked = []; let now = 1000, safe = true, cable = true, zoneState = 'playing';
  const output = { probeOutput: async () => ({ available: cable, reason: cable ? '' : 'listen-enabled' }),
    buildOutputCommand: () => ({ command: 'owned-output-test', args: [] }), validateOutput: async () => ({ available: cable, reason: cable ? '' : 'listen-enabled' }),
    createInputProvider: () => ({}) };
  const feed = new HqplayerFeed({ settingsPath, output, timers: false, clock: () => now, paceClock: () => now,
    requireZone: async (id, saved, runtime) => {
      checked.push({ id, outputId: saved.outputId, allowInactive: runtime?.allowInactive === true });
      if (!safe) throw Error('The exact Roon HQPlayer zone is no longer playing.');
      if (zoneState !== 'playing' && (!runtime?.allowInactive || !['loading', 'paused', 'stopped'].includes(zoneState))) {
        const error = Error('Play music in the exact Roon HQPlayer zone.');
        error.zoneState = ['playing', 'loading', 'paused', 'stopped'].includes(zoneState) ? zoneState : 'unknown'; throw error;
      }
      return options.explicitZoneFacts ? { state: zoneState } : undefined;
    },
    spawnImpl: (command, args) => { const child = new FakeChild(args.some(v => /dsp-worker/.test(v))); children.push(child); if (child.worker) queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; },
    socketFactory: o => { const socket = new FakeSocket(o); sockets.push(socket); return socket; }, ...options });
  t.after(async () => { await feed.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, settingsPath, settings, feed, output, children, sockets, checked,
    time: ms => { now += ms; }, zoneState: value => { zoneState = value; }, unsafe: () => { safe = false; }, cableUnsafe: () => { cable = false; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function completeWork(f, pcm = Buffer.alloc(4096, 10), type = 'pcm') {
  const work = f.feed.inflight; assert.ok(work, 'fixture has an in-flight batch');
  f.children[1].emit('message', { type, epoch: f.feed.epoch, sequence: work.sequence, pcm, resets: 0 });
}
function freshPcm(f) { f.sockets.at(-1).emit('data', toneFrame()); completeWork(f); }

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

function deadOwner() {
  return { version: 1, token: 'a'.repeat(48), ownerPid: 30101, source: 'roon-hqplayer', startedAt: 100,
    children: [
      { role: 'writer', pid: 30102, executable: path.join(os.tmpdir(), 'owned-output.exe'), argv: ['-q'], launchedAt: 101 },
      { role: 'analysis', pid: 30103, executable: process.execPath, argv: ['--max-old-space-size=64', path.join(__dirname, 'dsp-worker.cjs')], launchedAt: 102 }
    ] };
}

test('explicit Start recovers only a complete unchanged owner whose parent and both children are absent', async t => {
  const seen = [], f = await fixture(t, { processProbe: async pid => { seen.push(pid); return 'absent'; } });
  const stale = deadOwner(); await fs.writeFile(f.feed.ownerPath, JSON.stringify(stale));
  await f.feed.start({ zoneId: 'zone-one' });
  assert.deepEqual(seen, [30101, 30102, 30103, 30101, 30102, 30103]);
  const owner = JSON.parse(await fs.readFile(f.feed.ownerPath));
  assert.equal(owner.ownerPid, process.pid); assert.notEqual(owner.token, stale.token); assert.equal(f.children.length, 2);
  await assert.rejects(fs.access(f.feed.ownerPath + '.recovery'), { code: 'ENOENT' });
  await f.feed.stop(); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('inspection leaves a stale owner untouched without any process probe or reclamation', async t => {
  let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } });
  const bytes = JSON.stringify(deadOwner()); await fs.writeFile(f.feed.ownerPath, bytes);
  await f.feed.inspect(true); assert.equal(probes, 0); assert.equal(f.children.length, 0);
  assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes);
  await assert.rejects(fs.access(f.feed.ownerPath + '.recovery'), { code: 'ENOENT' });
});

test('live or reused parent/child PIDs and denied or unknown process checks keep complete ownership fenced', async t => {
  for (const pid of [30101, 30102, 30103]) for (const result of ['present', 'unknown', 'EPERM', 'unexpected-error']) {
    const f = await fixture(t, { processProbe: probed => {
      if (probed !== pid) return 'absent';
      if (result === 'EPERM' || result === 'unexpected-error') throw Object.assign(Error('probe denied'), { code: result });
      return result;
    } });
    const bytes = JSON.stringify(deadOwner()); await fs.writeFile(f.feed.ownerPath, bytes);
    await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
    assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes); assert.equal(f.children.length, 0);
    await assert.rejects(fs.access(f.feed.ownerPath + '.recovery'), { code: 'ENOENT' });
  }
});

test('incomplete, malformed and unfamiliar owner records cannot be reclaimed even when PIDs are absent', async t => {
  const mutations = [
    owner => { delete owner.children; }, owner => { owner.children.pop(); }, owner => { owner.children[0].pid = null; },
    owner => { owner.ownerPid = 0; }, owner => { owner.children[1].pid = owner.ownerPid; }, owner => { owner.children[1].role = 'writer'; },
    owner => { owner.children[0].executable = 'relative.exe'; }, owner => { owner.children[0].argv = 'not-an-array'; },
    owner => { owner.children[0].argv = [null]; }, owner => { owner.children[0].launchedAt = 50; },
    owner => { owner.version = 2; }, owner => { owner.source = 'lyrion'; }, owner => { owner.token = 'foreign'; },
    owner => { owner.unrecognized = true; }, owner => { owner.children[0].unrecognized = true; }
  ];
  for (const mutate of mutations) {
    let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } }), owner = deadOwner(); mutate(owner);
    const bytes = JSON.stringify(owner); await fs.writeFile(f.feed.ownerPath, bytes);
    await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
    assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes); assert.equal(probes, 0); assert.equal(f.children.length, 0);
  }
  for (const bytes of ['{partial', ' '.repeat(65537)]) {
    const f = await fixture(t, { processProbe: () => 'absent' }); await fs.writeFile(f.feed.ownerPath, bytes);
    await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
    assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes); assert.equal(f.children.length, 0);
  }
});

test('an existing recovery marker stays fail-closed regardless of its age or process status', async t => {
  let probes = 0; const f = await fixture(t, { processProbe: () => { probes++; return 'absent'; } });
  const bytes = JSON.stringify(deadOwner()), guard = JSON.stringify({ version: 1, token: 'old', ownerPid: 30104 });
  await fs.writeFile(f.feed.ownerPath, bytes); await fs.writeFile(f.feed.ownerPath + '.recovery', guard);
  await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes);
  assert.equal(await fs.readFile(f.feed.ownerPath + '.recovery', 'utf8'), guard); assert.equal(probes, 0); assert.equal(f.children.length, 0);
});

test('Stop during a pending stale-process check cancels reclamation and late source startup', async t => {
  let resolveProbe; const f = await fixture(t, { processProbe: () => new Promise(resolve => { resolveProbe = resolve; }) });
  const bytes = JSON.stringify(deadOwner()); await fs.writeFile(f.feed.ownerPath, bytes);
  const start = f.feed.start({ zoneId: 'zone-one' }), rejected = assert.rejects(start, /cancelled/);
  while (!resolveProbe) await turn(); const stop = f.feed.stop(); resolveProbe('absent'); await rejected; await stop;
  assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes); assert.equal(f.children.length, 0); assert.equal(f.sockets.length, 0);
  await assert.rejects(fs.access(f.feed.ownerPath + '.recovery'), { code: 'ENOENT' });
});

test('a parent or child that becomes live on the final check prevents stale recovery', async t => {
  for (const pid of [30101, 30102, 30103]) {
    const counts = new Map(), f = await fixture(t, { processProbe: probed => {
      counts.set(probed, (counts.get(probed) || 0) + 1);
      return probed === pid && counts.get(probed) === 2 ? 'present' : 'absent';
    } });
    const bytes = JSON.stringify(deadOwner()); await fs.writeFile(f.feed.ownerPath, bytes);
    await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
    assert.equal(await fs.readFile(f.feed.ownerPath, 'utf8'), bytes); assert.equal(f.children.length, 0);
  }
});

test('mutated or recreated owner records and replaced recovery guards are preserved', async t => {
  for (const change of ['owner-mutated', 'owner-recreated', 'guard-replaced']) {
    let changed = false, f;
    f = await fixture(t, { processProbe: async () => {
      if (!changed) {
        changed = true;
        if (change === 'owner-mutated') {
          const newer = deadOwner(); newer.token = 'b'.repeat(48); await fs.writeFile(f.feed.ownerPath, JSON.stringify(newer));
        } else if (change === 'owner-recreated') {
          await fs.rm(f.feed.ownerPath); await fs.writeFile(f.feed.ownerPath, JSON.stringify(deadOwner()));
        } else {
          await fs.rm(f.feed.ownerPath + '.recovery');
          await fs.writeFile(f.feed.ownerPath + '.recovery', JSON.stringify({ version: 1, token: 'replacement', ownerPid: 30104 }));
        }
      }
      return 'absent';
    } });
    await fs.writeFile(f.feed.ownerPath, JSON.stringify(deadOwner()));
    await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/); assert.equal(f.children.length, 0);
    const retained = JSON.parse(await fs.readFile(f.feed.ownerPath));
    assert.equal(retained.token, change === 'owner-mutated' ? 'b'.repeat(48) : 'a'.repeat(48));
    if (change === 'guard-replaced') assert.equal(JSON.parse(await fs.readFile(f.feed.ownerPath + '.recovery')).token, 'replacement');
    else await assert.rejects(fs.access(f.feed.ownerPath + '.recovery'), { code: 'ENOENT' });
  }
});

test('two simultaneous recovery claimers preserve exactly one newly acquired owner', async t => {
  let release, entered = false;
  const a = await fixture(t, { processProbe: () => { if (!entered) { entered = true; return new Promise(resolve => { release = resolve; }); } return 'absent'; } });
  const b = await fixture(t, { ownerPath: a.feed.ownerPath, processProbe: () => 'absent' });
  await fs.writeFile(a.feed.ownerPath, JSON.stringify(deadOwner()));
  const first = a.feed.start({ zoneId: 'zone-one' }); while (!release) await turn();
  await assert.rejects(b.feed.start({ zoneId: 'zone-one' }), /owner is active/); release('absent'); await first;
  const owner = JSON.parse(await fs.readFile(a.feed.ownerPath));
  assert.equal(owner.token, a.feed.ownerToken); assert.equal(a.children.length, 2); assert.equal(b.children.length, 0);
  await b.feed.stop(); assert.equal(JSON.parse(await fs.readFile(a.feed.ownerPath)).token, owner.token);
});

test('an ordinary wx claimant winning the recovery gap is never removed or overwritten', async t => {
  let f, claimed = false; const winner = { version: 1, token: 'c'.repeat(48), ownerPid: process.pid, source: 'roon-hqplayer', startedAt: 1000 };
  const ownerFs = { ...fs, rm: async (file, options) => {
    await fs.rm(file, options);
    if (!claimed && file === f.feed.ownerPath) { claimed = true; await fs.writeFile(file, JSON.stringify(winner), { flag: 'wx' }); }
  } };
  f = await fixture(t, { ownerFs, processProbe: () => 'absent' }); await fs.writeFile(f.feed.ownerPath, JSON.stringify(deadOwner()));
  await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.feed.ownerPath)), winner); assert.equal(f.children.length, 0);
  await assert.rejects(fs.access(f.feed.ownerPath + '.recovery'), { code: 'ENOENT' });
});

test('failed recovery-guard finalization closes the fresh owner handle and starts no children or socket', async t => {
  const handles = []; let f;
  const ownerFs = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args), record = { closed: false }; handles.push(record);
    const close = handle.close.bind(handle); handle.close = async () => { try { await close(); } finally { record.closed = true; } }; return handle;
  }, rm: async (file, options) => {
    if (file === f.feed.ownerPath + '.recovery') throw Object.assign(Error('guard removal denied'), { code: 'EPERM' });
    return fs.rm(file, options);
  } };
  f = await fixture(t, { ownerFs, processProbe: () => 'absent' }); await fs.writeFile(f.feed.ownerPath, JSON.stringify(deadOwner()));
  await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.ok(handles.length > 0); assert.ok(handles.every(record => record.closed));
  assert.equal(f.children.length, 0); assert.equal(f.sockets.length, 0);
  await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' }); await fs.access(f.feed.ownerPath + '.recovery');
});

test('nonregular owner paths and symbolic links are retained without a process check', async t => {
  let probes = 0; const directory = await fixture(t, { processProbe: () => { probes++; return 'absent'; } });
  await fs.mkdir(directory.feed.ownerPath);
  await assert.rejects(directory.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.equal((await fs.lstat(directory.feed.ownerPath)).isDirectory(), true); assert.equal(probes, 0);
  const link = await fixture(t, { processProbe: () => { probes++; return 'absent'; } }), target = path.join(link.dir, 'linked-owner.json');
  await fs.writeFile(target, JSON.stringify(deadOwner()));
  try { await fs.symlink(target, link.feed.ownerPath, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symbolic-link creation unavailable; nonregular directory fence verified.'); return; } throw error; }
  await assert.rejects(link.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.equal((await fs.lstat(link.feed.ownerPath)).isSymbolicLink(), true); assert.equal(probes, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(target)), deadOwner());
});

test('directory junctions and hard-linked ownership files cannot authorize recovery', async t => {
  let probes = 0; const options = { processProbe: () => { probes++; return 'absent'; } };
  const junction = await fixture(t, options), junctionTarget = path.join(junction.dir, 'junction-target');
  await fs.mkdir(junctionTarget); await fs.symlink(junctionTarget, junction.feed.ownerPath, 'junction');
  await assert.rejects(junction.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.equal((await fs.lstat(junction.feed.ownerPath)).isSymbolicLink(), true); assert.equal(probes, 0);
  const hard = await fixture(t, options), target = path.join(hard.dir, 'hard-linked-owner.json');
  await fs.writeFile(target, JSON.stringify(deadOwner())); await fs.link(target, hard.feed.ownerPath);
  await assert.rejects(hard.feed.start({ zoneId: 'zone-one' }), /owner is active/);
  assert.deepEqual(JSON.parse(await fs.readFile(target)), deadOwner()); assert.equal((await fs.stat(target)).nlink, 2);
  assert.equal(probes, 0); assert.equal(hard.children.length, 0); assert.equal(junction.children.length, 0);
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
  f.children[0].stdin.writableNeedDrain = true; f.feed.tick(); f.time(2001); f.feed.tick(); await turn(); await f.feed.failureCleanup;
  assert.equal(failures, 1); assert.equal(f.feed.state, 'error'); assert.ok(f.children.every(c => c.exitCode === 0));
  assert.equal(f.feed.snapshot().outputDiagnostic.errorCode, 'BACKPRESSURE_TIMEOUT');
  assert.ok(f.feed.snapshot().outputDiagnostic.maxBlockedMs > 2000);
  assert.equal(f.feed.snapshot().bufferedBytes, 0); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('a delayed pacer lets a queued drain run without treating unobserved time as output failure', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const stdin = f.children[0].stdin;
  stdin.writableNeedDrain = true; stdin.writableLength = 70000;
  f.feed.pcm = [Buffer.alloc(4096)]; f.feed.pcmSize = 4096;
  f.feed.tick(); f.time(2101); f.feed.tick();
  assert.ok(f.feed.outputDeferredCheck); assert.notEqual(f.feed.state, 'error');
  queueMicrotask(() => { stdin.writableNeedDrain = false; stdin.writableLength = 0; stdin.emit('drain'); });
  await turn();
  assert.notEqual(f.feed.state, 'error'); assert.equal(f.feed.outputDeferredCheck, null);
  const diagnostic = f.feed.snapshot().outputDiagnostic;
  assert.equal(diagnostic.drainEvents, 1); assert.equal(diagnostic.pacerGaps, 1);
  assert.equal(diagnostic.droppedOnBackpressureFrames, 1024); assert.equal(f.feed.pcmSize, 0);
  assert.equal(stdin.writes.length, 0); assert.equal(f.sockets[0].writes, 0);
});

test('a genuinely non-draining output still fails after two seconds of regular observations', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.children[0].stdin.writableNeedDrain = true; f.feed.tick();
  for (let index = 0; index < 101; index++) { f.time(20); f.feed.tick(); }
  await f.feed.failureCleanup;
  assert.equal(f.feed.state, 'error'); assert.equal(f.feed.snapshot().outputDiagnostic.pacerGaps, 0);
  assert.equal(f.feed.snapshot().outputDiagnostic.errorCode, 'BACKPRESSURE_TIMEOUT');
  assert.ok(f.children.every(child => child.exitCode === 0));
});

test('a wall-clock jump cannot expire the monotonic output blockage deadline', async t => {
  let wall = 1000;
  const f = await fixture(t, { clock: () => wall }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.children[0].stdin.writableNeedDrain = true; f.feed.tick(); wall += 3000; f.feed.tick();
  assert.notEqual(f.feed.state, 'error'); assert.equal(f.feed.snapshot().outputDiagnostic.blockedMs, 0);
  f.time(2101); f.feed.tick(); await turn(); await f.feed.failureCleanup;
  assert.equal(f.feed.snapshot().outputDiagnostic.errorCode, 'BACKPRESSURE_TIMEOUT');
});

test('write completion and falling pipe backlog each restart only the no-progress deadline', async t => {
  for (const kind of ['completion', 'backlog']) {
    const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
    const stdin = f.children[0].stdin;
    f.time(20); f.feed.tick(); assert.equal(stdin.callbacks.length, 1);
    stdin.writableNeedDrain = true; stdin.writableLength = 70000; f.feed.tick();
    f.time(1500);
    if (kind === 'completion') stdin.callbacks[0](); else stdin.writableLength = 60000;
    f.feed.tick(); f.time(1500); f.feed.tick();
    assert.notEqual(f.feed.state, 'error');
    assert.equal(f.feed.snapshot().outputDiagnostic.blockedMs, 1500);
    assert.equal(f.feed.snapshot().outputDiagnostic.writeCompletions, kind === 'completion' ? 1 : 0);
    f.time(501); f.feed.tick(); await turn(); await f.feed.failureCleanup;
    assert.equal(f.feed.state, 'error');
  }
});

test('recovering from backpressure discards old PCM and resumes at the current pace without a catch-up burst', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const stdin = f.children[0].stdin;
  f.feed.pcm = [Buffer.alloc(MAX_PCM, 10)]; f.feed.pcmSize = MAX_PCM;
  stdin.writableNeedDrain = true; f.feed.tick(); f.time(700); f.feed.tick();
  assert.equal(f.feed.pcmSize, 0); assert.equal(stdin.writes.length, 0);
  stdin.writableNeedDrain = false; stdin.emit('drain');
  f.feed.pcm = [Buffer.alloc(17640, 20)]; f.feed.pcmSize = 17640;
  f.time(20); f.feed.tick();
  assert.equal(stdin.writes.length, 1); assert.equal(stdin.writes[0].length, 3528);
  assert.equal(stdin.writes[0][0], 20); assert.equal(f.feed.snapshot().outputDiagnostic.droppedOnBackpressureFrames, MAX_PCM / 4);
});

test('old deferred checks and writer callbacks cannot disturb a new feed generation', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const old = f.children[0]; f.time(20); f.feed.tick();
  const checks = [];
  t.mock.method(global, 'setImmediate', callback => { const handle = { callback }; checks.push(handle); return handle; });
  old.stdin.writableNeedDrain = true; f.feed.tick(); f.time(2101); f.feed.tick(); assert.equal(checks.length, 1);
  await f.feed.stop(); await f.feed.start({ zoneId: 'zone-one' });
  const current = f.children[2], diagnostic = f.feed.outputDiagnostic;
  current.stdin.writableNeedDrain = true; f.feed.tick(); f.time(2101); f.feed.tick(); assert.equal(checks.length, 2);
  const deferred = f.feed.outputDeferredCheck;
  checks[0].callback(); old.stdin.callbacks[0](); old.stdin.emit('drain'); old.stderr.emit('data', Buffer.from('ERROR old device unavailable')); old.emit('close', 7, 'SIGKILL');
  assert.equal(f.feed.outputDeferredCheck, deferred); assert.equal(f.feed.outputDiagnostic, diagnostic);
  assert.equal(diagnostic.writeCompletions, 0); assert.equal(diagnostic.drainEvents, 0); assert.equal(diagnostic.stderrReason, ''); assert.equal(diagnostic.exitCode, null);
  assert.notEqual(f.feed.state, 'error');
  checks[1].callback(); await f.feed.failureCleanup; assert.equal(f.feed.state, 'error');
});

test('terminal writer diagnostics retain safe categories and omit raw device/path details', async t => {
  const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const writer = f.children[0];
  writer.stderr.emit('data', Buffer.from('ERROR device unavailable C:\\private\\secret.wav {deadbeef-dead-beef-dead-beefdeadbeef}'));
  writer.stdin.writableNeedDrain = true; writer.stdin.writableLength = 70000;
  f.feed.tick(); f.time(2101); f.feed.tick(); await turn(); await f.feed.failureCleanup;
  writer.stdin.emit('error', Object.assign(Error('cleanup C:\\private\\secret.wav'), { code: 'EPIPE' }));
  const diagnostic = f.feed.snapshot().outputDiagnostic, serialized = JSON.stringify(diagnostic);
  assert.equal(diagnostic.errorCode, 'BACKPRESSURE_TIMEOUT'); assert.equal(diagnostic.stderrReason, 'device-unavailable');
  assert.equal(diagnostic.writableBytes, 70000); assert.ok(diagnostic.blockedMs > 2000);
  assert.doesNotMatch(serialized, /private|secret|deadbeef|wav/i); assert.equal(f.feed.snapshot().bufferedBytes, 0);
  await f.feed.stop(); assert.deepEqual(f.feed.snapshot().outputDiagnostic, diagnostic);
  await f.feed.start({ zoneId: 'zone-one' }); assert.equal(f.feed.snapshot().outputDiagnostic.errorCode, '');
});

test('failed zone guard, disabled settings and unsafe Listen each stop the analysis without playback commands', async t => {
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

test('paused/stopped runtime waits preserve ownership and reject old or partial-frame audio before fresh recovery', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const epoch = f.feed.epoch, token = f.feed.ownerToken, writer = f.feed.writer, worker = f.feed.worker, socket = f.feed.socket;
  socket.emit('data', toneFrame()); const old = f.feed.inflight;
  f.feed.pcm = [Buffer.alloc(4096, 10)]; f.feed.pcmSize = 4096;
  f.zoneState('paused'); await f.feed.checkSafety();
  assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.pcmSize, 0); const deadline = f.feed.zoneTransitionAt;
  worker.emit('message', { type: 'pcm', epoch, sequence: old.sequence, pcm: Buffer.alloc(4096, 10) });
  socket.emit('data', toneFrame()); completeWork(f); assert.equal(f.feed.pcmSize, 0);
  f.zoneState('stopped'); f.time(11000); await f.feed.checkSafety(); f.feed.tick();
  assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.zoneTransitionAt, deadline);
  socket.emit('timeout'); assert.equal(socket.destroyed, false);
  const partial = toneFrame(); socket.emit('data', partial.subarray(0, 100));
  f.zoneState('playing'); await f.feed.checkSafety(); assert.equal(f.feed.zoneTransitionAt, deadline);
  socket.emit('data', partial.subarray(100)); completeWork(f);
  assert.equal(f.feed.pcmSize, 0); assert.equal(f.feed.state, 'waiting', 'old partial frame cannot end the transition');
  freshPcm(f); assert.equal(f.feed.state, 'receiving'); assert.equal(f.feed.zoneTransitionAt, null);
  assert.equal(f.feed.epoch, epoch); assert.equal(f.feed.ownerToken, token);
  assert.equal(f.feed.writer, writer); assert.equal(f.feed.worker, worker); assert.equal(f.feed.socket, socket);
  assert.equal(f.children.length, 2); assert.equal(f.sockets.length, 1); assert.equal(socket.writes, 0);
  f.time(20); f.feed.tick(); assert.equal(writer.stdin.writes.at(-1).length, 3528, 'resume has no catch-up burst');
});

test('loading keeps paced zero PCM on the same owned stream until fresh playing analysis arrives', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const epoch = f.feed.epoch, token = f.feed.ownerToken, writer = f.feed.writer, worker = f.feed.worker, socket = f.feed.socket;
  freshPcm(f); f.time(20); f.feed.tick(); assert.ok(writer.stdin.writes.at(-1).some(byte => byte !== 0));
  socket.emit('data', toneFrame()); const retired = f.feed.inflight;
  f.zoneState('loading'); await f.feed.checkSafety(); const deadline = f.feed.zoneTransitionAt;
  assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.pcmSize, 0);
  assert.equal(f.feed.snapshot().analysisDiagnostic.observedZoneState, 'loading');
  worker.emit('message', { type: 'pcm', epoch, sequence: retired.sequence, pcm: Buffer.alloc(4096, 10) });
  freshPcm(f); assert.equal(f.feed.pcmSize, 0, 'analysis arriving during loading remains muted');
  for (let tick = 0; tick < 3; tick++) {
    f.time(20); f.feed.tick();
    assert.equal(writer.stdin.writes.at(-1).length, 3528);
    assert.ok(writer.stdin.writes.at(-1).every(byte => byte === 0), 'the keepalive is digital silence on the visual output');
  }
  assert.equal(f.feed.snapshot().submittedSignal.silent, true);
  const partial = toneFrame(); socket.emit('data', partial.subarray(0, 100));
  f.zoneState('playing'); await f.feed.checkSafety();
  assert.equal(f.feed.zoneTransitionAt, deadline, 'playing state alone cannot clear the fresh-analysis deadline');
  socket.emit('data', partial.subarray(100)); completeWork(f);
  assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.pcmSize, 0, 'pre-resume partial analysis is rejected');
  f.time(20); f.feed.tick(); assert.ok(writer.stdin.writes.at(-1).every(byte => byte === 0));
  freshPcm(f); assert.equal(f.feed.state, 'receiving'); assert.equal(f.feed.zoneTransitionAt, null);
  assert.equal(f.feed.snapshot().analysisDiagnostic.observedZoneState, 'playing');
  f.time(20); f.feed.tick();
  assert.equal(writer.stdin.writes.at(-1).length, 3528); assert.ok(writer.stdin.writes.at(-1).some(byte => byte !== 0));
  assert.equal(f.feed.epoch, epoch); assert.equal(f.feed.ownerToken, token);
  assert.equal(f.feed.writer, writer); assert.equal(f.feed.worker, worker); assert.equal(f.feed.socket, socket);
  assert.equal(f.children.length, 2); assert.equal(f.sockets.length, 1); assert.equal(socket.writes, 0);
});

test('repeated loading transitions keep one owner, writer, worker and receive-only socket', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const epoch = f.feed.epoch, token = f.feed.ownerToken, writer = f.feed.writer, worker = f.feed.worker, socket = f.feed.socket;
  for (let track = 0; track < 5; track++) {
    freshPcm(f); f.time(20); f.feed.tick();
    f.zoneState('loading'); await f.feed.checkSafety(); assert.equal(f.feed.state, 'waiting');
    const deadline = f.feed.zoneTransitionAt;
    f.time(1000); await f.feed.checkSafety(); f.feed.tick();
    assert.equal(f.feed.zoneTransitionAt, deadline); assert.ok(writer.stdin.writes.at(-1).every(byte => byte === 0));
    socket.emit('timeout'); assert.equal(socket.destroyed, false);
    f.zoneState('playing'); await f.feed.checkSafety(); freshPcm(f);
    assert.equal(f.feed.state, 'receiving'); assert.equal(f.feed.zoneTransitionAt, null);
    assert.equal(f.feed.epoch, epoch); assert.equal(f.feed.ownerToken, token);
    assert.equal(f.feed.writer, writer); assert.equal(f.feed.worker, worker); assert.equal(f.feed.socket, socket);
    assert.equal(f.children.length, 2); assert.equal(f.sockets.length, 1);
  }
  assert.equal(socket.writes, 0); assert.ok(f.children.every(child => child.kills === 0)); await fs.access(f.feed.ownerPath);
});

test('loading grace expires at thirty seconds without treating missing analysis as an earlier failure', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); let failure;
  await f.feed.start({ zoneId: 'zone-one', onFailure: error => { failure = error; } }); await turn();
  f.zoneState('loading'); await f.feed.checkSafety(); const deadline = f.feed.zoneTransitionAt;
  f.time(29999); await f.feed.checkSafety(); f.feed.tick();
  assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.zoneTransitionAt, deadline);
  assert.ok(f.children[0].stdin.writes.at(-1).every(byte => byte === 0));
  f.time(1); f.feed.tick(); await f.feed.failureCleanup;
  assert.equal(f.feed.state, 'error'); assert.match(f.feed.reason, /did not resume fresh/);
  assert.equal(failure.zoneState, 'loading');
  assert.equal(f.feed.snapshot().analysisDiagnostic.observedZoneState, 'loading');
  assert.equal(f.feed.snapshot().bufferedBytes, 0); assert.equal(f.feed.ownerToken, '');
  assert.ok(f.children.every(child => child.exitCode === 0)); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('zone transition deadline survives loading/paused/stopped flapping and playing without fresh PCM', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.zoneState('loading'); await f.feed.checkSafety(); const deadline = f.feed.zoneTransitionAt;
  for (const playback of ['playing', 'stopped', 'loading', 'paused', 'playing']) {
    f.time(5900); f.zoneState(playback); await f.feed.checkSafety(); f.feed.tick();
    assert.equal(f.feed.state, 'waiting'); assert.equal(f.feed.zoneTransitionAt, deadline);
  }
  f.time(500); f.sockets[0].emit('data', toneFrame()); completeWork(f); await f.feed.failureCleanup;
  assert.equal(f.feed.state, 'error'); assert.match(f.feed.reason, /did not resume fresh/);
  assert.equal(f.feed.snapshot().bufferedBytes, 0);
});

test('an old partial frame is fully validated but its DSP overlap cannot leak into the first accepted fresh frame', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const dsp = new AnalysisDsp(), worker = f.children[1], socket = f.sockets[0];
  const processBatch = () => {
    const batch = worker.messages.filter(message => message.type === 'frames').at(-1), results = batch.frames.map(frame => dsp.process(frame.bytes, frame.sequence));
    const pcm = Buffer.concat(results.map(result => result.pcm));
    worker.emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: batch.frames.at(-1).sequence, pcm, resets: results.filter(result => result.discontinuity).length });
    return { batch, pcm, results };
  };
  socket.emit('data', toneFrame({ bin: 100 })); processBatch();
  f.zoneState('paused'); await f.feed.checkSafety();
  const old = toneFrame({ bin: 100 }); socket.emit('data', old.subarray(0, 100));
  f.zoneState('playing'); await f.feed.checkSafety(); socket.emit('data', old.subarray(100));
  const rejected = processBatch(); assert.equal(f.feed.pcmSize, 0);
  const fresh = toneFrame({ bin: 20 }); socket.emit('data', fresh); const accepted = processBatch();
  assert.ok(accepted.batch.frames[0].sequence > rejected.batch.frames.at(-1).sequence + 1);
  assert.equal(accepted.results[0].discontinuity, true);
  assert.deepEqual(accepted.pcm, new AnalysisDsp().process(fresh, accepted.batch.frames[0].sequence).pcm);
  assert.deepEqual(f.feed.pcm[0], accepted.pcm); assert.equal(f.feed.state, 'receiving');
});

test('playing recovery waits for output validation and Stop fences a pending cable result', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.zoneState('paused'); await f.feed.checkSafety();
  let resolveCable; f.output.validateOutput = () => new Promise(resolve => { resolveCable = resolve; });
  f.zoneState('playing'); const checking = f.feed.checkSafety(); while (!resolveCable) await turn();
  freshPcm(f); assert.equal(f.feed.pcmSize, 0); assert.equal(f.feed.state, 'waiting');
  resolveCable({ available: true }); await checking;
  assert.equal(f.feed.state, 'waiting'); freshPcm(f); assert.equal(f.feed.state, 'receiving');
  resolveCable = null; const nextCheck = f.feed.checkSafety(); while (!resolveCable) await turn();
  await f.feed.stop(); resolveCable({ available: true }); await nextCheck;
  assert.equal(f.feed.ownerToken, ''); assert.equal(f.feed.runtimeVerifiedAt, null); assert.equal(f.children.length, 2);
});

test('fresh frames queued with an old partial prefix reset DSP history before later accepted PCM', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  const dsp = new AnalysisDsp(), worker = f.children[1], socket = f.sockets[0];
  const runBatch = () => {
    const batch = worker.messages.filter(message => message.type === 'frames').at(-1);
    const results = batch.frames.map(frame => dsp.process(frame.bytes, frame.sequence));
    const pcm = Buffer.concat(results.map(result => result.pcm));
    worker.emit('message', { type: 'pcm', epoch: f.feed.epoch, sequence: batch.frames.at(-1).sequence, pcm, resets: results.filter(result => result.discontinuity).length });
    return { batch, results, pcm };
  };
  f.zoneState('paused'); await f.feed.checkSafety();
  const old = toneFrame({ bin: 100 }), fresh = toneFrame({ bin: 20 }); socket.emit('data', old.subarray(0, 100));
  f.zoneState('playing'); await f.feed.checkSafety(); socket.emit('data', Buffer.concat([old.subarray(100), fresh]));
  const mixed = runBatch(); assert.equal(mixed.batch.frames.length, 2); assert.equal(f.feed.pcmSize, 0);
  assert.equal(mixed.results[1].discontinuity, true); assert.equal(f.feed.state, 'waiting');
  const clean = new AnalysisDsp(); clean.process(fresh, mixed.batch.frames[1].sequence);
  socket.emit('data', fresh); const accepted = runBatch();
  assert.deepEqual(accepted.pcm, clean.process(fresh, accepted.batch.frames[0].sequence).pcm);
  assert.deepEqual(f.feed.pcm[0], accepted.pcm); assert.equal(f.feed.state, 'receiving');
});

test('a clock adjustment cannot move the transition deadline, and genuine output stalls remain terminal', async t => {
  let wall = 1000, monotonic = 1000;
  const f = await fixture(t, { explicitZoneFacts: true, clock: () => wall, paceClock: () => monotonic });
  await f.feed.start({ zoneId: 'zone-one' }); await turn(); f.zoneState('paused'); await f.feed.checkSafety();
  wall += 60000; f.feed.tick(); assert.equal(f.feed.state, 'waiting');
  monotonic += 30000; f.feed.tick(); await f.feed.failureCleanup;
  assert.equal(f.feed.state, 'error'); assert.match(f.feed.reason, /did not resume fresh/);
  const blocked = await fixture(t, { explicitZoneFacts: true }); await blocked.feed.start({ zoneId: 'zone-one' }); await turn();
  blocked.zoneState('stopped'); await blocked.feed.checkSafety(); blocked.children[0].stdin.writableNeedDrain = true;
  blocked.feed.tick(); blocked.time(2101); blocked.feed.tick(); await turn(); await blocked.feed.failureCleanup;
  assert.equal(blocked.feed.state, 'error'); assert.equal(blocked.feed.outputDiagnostic.errorCode, 'BACKPRESSURE_TIMEOUT');
});

test('Start rejects loading/paused/stopped and legacy successful guards still mean playing', async t => {
  for (const playback of ['loading', 'paused', 'stopped']) {
    const f = await fixture(t, { explicitZoneFacts: true }); f.zoneState(playback);
    await assert.rejects(f.feed.start({ zoneId: 'zone-one' }), /Play music/);
    assert.equal(f.children.length, 0); assert.equal(f.sockets.length, 0);
  }
  const legacy = await fixture(t); await legacy.feed.start({ zoneId: 'zone-one' }); await turn();
  await legacy.feed.checkSafety(); freshPcm(legacy); assert.equal(legacy.feed.state, 'receiving');
  assert.equal(legacy.checked[0].allowInactive, false); assert.equal(legacy.checked.at(-1).allowInactive, true);
});

test('settings, disconnected zone and cable failures remain terminal inside a transition', async t => {
  for (const kind of ['zone', 'settings', 'cable']) {
    const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
    f.zoneState('stopped'); await f.feed.checkSafety();
    if (kind === 'zone') f.unsafe();
    if (kind === 'settings') await fs.writeFile(f.settingsPath, JSON.stringify({ ...f.settings, outputId: 'other-pinned-output' }));
    if (kind === 'cable') f.cableUnsafe();
    await f.feed.checkSafety(); await f.feed.failureCleanup;
    assert.equal(f.feed.state, 'error'); assert.equal(f.feed.ownerToken, ''); assert.ok(f.children.every(c => c.exitCode === 0));
  }
});

test('malformed metadata and current worker failures stay terminal while the zone is stopped', async t => {
  for (const kind of ['metadata', 'worker']) {
    const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
    f.zoneState('stopped'); await f.feed.checkSafety();
    if (kind === 'metadata') { const invalid = toneFrame(); invalid.writeFloatLE(24000, 16); f.sockets[0].emit('data', invalid); f.time(500); f.feed.tick(); }
    else { f.sockets[0].emit('data', toneFrame()); completeWork(f, undefined, 'failure'); }
    await f.feed.failureCleanup; assert.equal(f.feed.state, 'error'); assert.equal(f.feed.snapshot().bufferedBytes, 0);
  }
});

test('Stop during loading fences late guards, worker replies, socket events and output callbacks', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  f.zoneState('loading'); await f.feed.checkSafety();
  f.sockets[0].emit('data', toneFrame()); const pendingWork = f.feed.inflight;
  f.time(20); f.feed.tick(); const writer = f.children[0], worker = f.children[1];
  let resolveGuard; f.feed.requireZone = () => new Promise(resolve => { resolveGuard = resolve; });
  const checking = f.feed.checkSafety(); while (!resolveGuard) await turn();
  const oldEpoch = f.feed.epoch, oldSocket = f.sockets[0]; await f.feed.stop();
  resolveGuard({ state: 'playing' }); await checking;
  worker.emit('message', { type: 'pcm', epoch: oldEpoch, sequence: pendingWork.sequence, pcm: Buffer.alloc(4096, 10) });
  worker.emit('message', { type: 'ready' }); oldSocket.emit('data', toneFrame()); oldSocket.emit('timeout');
  writer.stdin.callbacks[0](); writer.stdin.emit('drain'); f.feed.connect(oldEpoch); f.feed.tick(oldEpoch); await turn();
  assert.equal(f.feed.ownerToken, ''); assert.equal(f.feed.writer, null); assert.equal(f.feed.zoneTransitionAt, null);
  assert.equal(f.feed.worker, null); assert.equal(f.feed.socket, null); assert.equal(f.feed.workerReady, false);
  assert.equal(f.children.length, 2); assert.equal(f.sockets.length, 1); assert.equal(f.feed.snapshot().bufferedBytes, 0);
  assert.ok(f.children.every(child => child.exitCode === 0)); await assert.rejects(fs.access(f.feed.ownerPath), { code: 'ENOENT' });
});

test('invalid runtime zone states fail closed and retain only sanitized diagnostics after cleanup', async t => {
  for (const playback of ['unknown', null, 'private-source?token=secret', { private: 'secret' }]) {
    const f = await fixture(t, { explicitZoneFacts: true }); let failure;
    await f.feed.start({ zoneId: 'zone-one', onFailure: error => { failure = error; } }); await turn();
    f.zoneState('loading'); await f.feed.checkSafety();
    f.feed.requireZone = async () => ({ state: playback });
    await f.feed.checkSafety(); await f.feed.failureCleanup;
    assert.equal(f.feed.state, 'error'); assert.equal(failure.zoneState, 'unknown');
    const diagnostic = f.feed.snapshot().analysisDiagnostic;
    assert.equal(diagnostic.observedZoneState, 'unknown'); assert.equal(diagnostic.rejectedZoneState, 'unknown');
    assert.doesNotMatch(JSON.stringify({ diagnostic, failure }), /private-source|secret|token/);
    assert.equal(f.feed.snapshot().bufferedBytes, 0); assert.ok(f.children.every(child => child.exitCode === 0));
    await f.feed.stop(); assert.equal(f.feed.snapshot().analysisDiagnostic.rejectedZoneState, 'unknown');
    f.feed.requireZone = async () => ({ state: 'playing' }); await f.feed.start({ zoneId: 'zone-one' });
    assert.equal(f.feed.snapshot().analysisDiagnostic.rejectedZoneState, null, 'a new owned session resets the prior rejection');
  }
});

test('rejected guards cannot copy arbitrary state values into retained or callback diagnostics', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); let failure;
  await f.feed.start({ zoneId: 'zone-one', onFailure: error => { failure = error; } }); await turn();
  f.zoneState('loading'); await f.feed.checkSafety();
  f.feed.requireZone = async () => { const error = Error('The zone state could not be verified.'); error.zoneState = 'private-source?token=secret'; throw error; };
  await f.feed.checkSafety(); await f.feed.failureCleanup;
  const diagnostic = f.feed.snapshot().analysisDiagnostic;
  assert.equal(failure.zoneState, 'unknown'); assert.equal(diagnostic.observedZoneState, 'unknown'); assert.equal(diagnostic.rejectedZoneState, 'unknown');
  assert.doesNotMatch(JSON.stringify({ diagnostic, failure }), /private-source|secret|token/);
  assert.equal(f.feed.ownerToken, ''); assert.ok(f.children.every(child => child.exitCode === 0));
});

test('separate outages regain their retry budget only after sustained fresh, verified PCM', async t => {
  const f = await fixture(t, { explicitZoneFacts: true }); await f.feed.start({ zoneId: 'zone-one' }); await turn();
  for (let outage = 0; outage < 5; outage++) {
    f.sockets.at(-1).destroy(); await turn(); assert.equal(f.feed.reconnects, 1); f.feed.connect(f.feed.epoch);
    await f.feed.checkSafety(); freshPcm(f); assert.equal(f.feed.reconnects, 1, 'one packet cannot reset retries');
    for (let second = 0; second < 3; second++) { f.time(1000); await f.feed.checkSafety(); freshPcm(f); }
    assert.equal(f.feed.reconnects, 0); assert.equal(f.feed.state, 'receiving');
  }
  assert.equal(f.children.length, 2); assert.equal(f.sockets.length, 6); assert.ok(f.sockets.every(socket => socket.writes === 0));
});

test('freshness gaps or unverified identity cannot reset retries or extend the normal no-data deadline', async t => {
  for (const kind of ['gap', 'unverified']) {
    const f = await fixture(t); await f.feed.start({ zoneId: 'zone-one' }); await turn();
    f.sockets[0].destroy(); await turn(); f.feed.connect(f.feed.epoch); freshPcm(f);
    for (let i = 0; i < 3; i++) {
      f.time(kind === 'gap' ? 1600 : 1000);
      if (kind === 'gap') await f.feed.checkSafety();
      freshPcm(f);
    }
    assert.equal(f.feed.reconnects, 1);
    f.time(10001); f.feed.tick(); await f.feed.failureCleanup;
    assert.equal(f.feed.state, 'error'); assert.match(f.feed.reason, /not supplying fresh/);
  }
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
