'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createIntegration, PROFILE, ENCODER_BITRATE, checkPorts } = require('./index.cjs');
const VIEWER = 'viewer_abcdefghijklmnopqrstuv';
const identity = { pid: 510, windowHandle: '910', windowTitle: 'Rabbit Hole G-Force RH-7af40e64-8e98-4b2b-a9ed-83458e4c4723',
  windowClass: 'Owned:Class#1', executable: 'C:\\Program Files\\SoundSpectrum\\G-Force Standalone.x64.exe', startTimeTicks: '638980000000000000' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-srt600-offline-'));
  const gstreamer = path.join(root, 'gst', 'gst-launch-1.0.exe'), relay = path.join(root, 'relay', 'mediamtx.exe');
  for (const file of [gstreamer, relay]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'offline fixture; never executed'); }
  const config = { version: 2, gstreamerVersion: '1.26.11', gstreamerExecutable: gstreamer,
    lanAddress: '192.168.50.119', ports: { srt: 8891 }, adapterIndex: 0, adapterLuid: '64596', sendBufferBytes: 33554432 };
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(config));
  const pluginRoot = path.join(root, 'patched-plugin'), plugin = Buffer.from('offline patched SRT fixture; never loaded');
  await fs.mkdir(pluginRoot);
  await fs.writeFile(path.join(pluginRoot, 'gstsrt.dll'), plugin);
  await fs.writeFile(path.join(pluginRoot, 'backpressure-plugin.json'), JSON.stringify({ version: 1, revision: 'listener-backpressure-2',
    sha256: require('node:crypto').createHash('sha256').update(plugin).digest('hex') }));
  let now = 10000, active = true, geometry = { ...identity, width: 3840, height: 2160 }, bytes = 0;
  const calls = [], children = [], requests = [], timers = [], failures = [], diagnostics = [];
  const integration = createIntegration({ runtimeRoot: root, allowedExecutables: { gstreamer, relay }, clock: () => now,
    onDiagnostic: entry => { diagnostics.push(entry); overrides.onDiagnostic?.(entry); },
    probeRuntime: async (...args) => { calls.push('probe'); if (overrides.probeRuntime) return overrides.probeRuntime(...args); },
    checkPorts: async value => { calls.push('ports'); if (overrides.checkPorts) await overrides.checkPorts(value); },
    sleep: async ms => { now += ms; },
    setTimeoutImpl: (fn, ms) => { const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutImpl: timer => { if (timer) timer.cancelled = true; },
    spawnImpl: (executable, args, options) => {
      const child = new EventEmitter(); child.pid = 700 + children.length; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { calls.push({ handleKill: child.pid }); queueMicrotask(() => child.emit('exit', 0)); return true; };
      bytes = 0; children.push({ child, executable, args, options }); return child;
    },
    processAction: async (action, details) => {
      calls.push({ action, details });
      if (overrides.processAction) { const value = await overrides.processAction(action, details); if (value !== undefined) return value; }
      return action === 'identity' ? { pid: details.ProcessId, executable: details.ExpectedExecutable, startTimeTicks: '638980000000000000' } : { terminated: true };
    },
    listenerAction: async (action, details) => {
      calls.push({ action, details });
      if (overrides.listenerAction) { const value = await overrides.listenerAction(action, details); if (value !== undefined) return value; }
      if (!bytes) {
        if (!overrides.noCaps) children.at(-1).child.stdout.emit('data', Buffer.from('/GstPipeline:Owned/GstH264Parse:OwnedSrtParser.GstPad:src: caps = video/x-h264, profile=(string)high, level=(string)6.1, width=(int)3840, height=(int)2160\n'));
        if (!overrides.noBytes) { bytes = 10000; children.at(-1).child.stdout.emit('data', Buffer.from('/GstPipeline:Owned/GstIdentity:OwnedVideoBytes: last-message = chain *** (OwnedVideoBytes:sink) (10000 bytes, pts: 0)\n')); }
      }
      return { listening: true };
    }
  });
  t.after(async () => { await integration.stop({ viewerId: VIEWER, generation: 4 }).catch(() => {});
    const resolved = path.resolve(root); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rh-srt600-offline-'));
    await fs.rm(resolved, { recursive: true, force: true }); });
  const start = extra => integration.start({ viewerId: VIEWER, generation: 4, nativeIdentity: identity, observeWindow: async () => geometry,
    isCurrent: () => active, expiresAt: now + 600000, onFailure: error => failures.push(error.message), ...extra });
  return { integration, root, config, calls, children, requests, timers, failures, diagnostics, start, now: () => now,
    advance: ms => { now += ms; }, setBytes: value => { let remaining = value - bytes; bytes = value; while (remaining > 0) { const size = Math.min(remaining, 32000000); remaining -= size; children.at(-1).child.stdout.emit('data', Buffer.from(`/GstPipeline:Owned/GstIdentity:OwnedVideoBytes: last-message = chain *** (OwnedVideoBytes:sink) (${size} bytes, pts: 0)\n`)); } }, setGeometry: value => { geometry = value; }, deactivate: () => { active = false; },
    tick: async () => { const timer = timers.find(value => !value.cancelled && value.ms <= 2000); assert.ok(timer); timer.cancelled = true; await timer.fn(); } };
}

test('private sender observations survive logging errors without exposing native warning text', async t => {
  const f = await fixture(t, { onDiagnostic: () => { throw Error('logger unavailable'); } });
  await f.start();
  const child = f.children[0].child;
  for (let i = 0; i < 20; i++) child.stderr.emit('data', Buffer.from('gst_srt_object_write_to_callers: Dropping caller 123: PRIVATE passphrase=SECRET srt://private-host\n'));
  assert.equal(f.integration.snapshot().state, 'ready');
  assert.equal(f.diagnostics.length, 8);
  assert.ok(f.diagnostics.every(entry => entry.event === 'caller-dropped' && entry.reason === 'other-send-error'));
  f.advance(16000); f.setBytes(2100000); await f.tick();
  assert.equal(f.integration.snapshot().state, 'ready');
  const progress = f.diagnostics.find(entry => entry.event === 'encoded-progress');
  assert.ok(progress); assert.equal(progress.encodedBytes, 2100000); assert.equal(progress.maximumAccessUnitBytes, 2090000);
  assert.equal(progress.encodedAgeMs, 0);
  await f.tick(); assert.equal(f.diagnostics.filter(entry => entry.event === 'encoded-progress').length, 1);
  f.advance(7000); await f.tick();
  assert.equal(f.diagnostics.filter(entry => entry.event === 'failure').length, 1);
  assert.equal(f.diagnostics.at(-1).failureCode, 'encoded-output-stale');
  assert.equal(f.diagnostics.at(-1).encodedAgeMs, 7000);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|SECRET|srt:\/\/|passphrase|viewerId|nativeIdentity/);
});

test('prolonged native send waits retain only bounded numeric observations and never change trial health', async t => {
  const f = await fixture(t, { onDiagnostic: () => { throw Error('logger unavailable'); } }); await f.start();
  const child = f.children[0].child;
  const observation = { waitMs: 1001, statsAvailable: true, socketState: 5, sendBufferBytes: 33553116,
    sendBufferMs: 1100, flightPackets: 128, flowPackets: 8192, ackTotal: 202, nakTotal: 3,
    retransTotal: 8, dropTotal: 10, uniqueBytes: 987654321 };
  const send = value => child.stderr.emit('data', Buffer.from('native warning RH_SRT_WAIT ' + JSON.stringify(value) + '\n'));
  for (const invalid of [{ ...observation, url: 'srt://PRIVATE?passphrase=SECRET' }, { ...observation, waitMs: -1 },
    { ...observation, uniqueBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...observation, statsAvailable: 1 },
    { ...observation, socketState: 'SECRET' }]) send(invalid);
  assert.equal(f.diagnostics.length, 0);
  const line = 'native warning RH_SRT_WAIT ' + JSON.stringify(observation) + '\n';
  child.stderr.emit('data', Buffer.from(line.slice(0, 50)));
  child.stderr.emit('data', Buffer.from(line.slice(50)));
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].event, 'sender-wait');
  for (const [key, value] of Object.entries(observation)) assert.equal(f.diagnostics[0][key], value);
  for (let n = 0; n < 130; n++) send(observation);
  assert.equal(f.diagnostics.length, 120);
  assert.equal(f.integration.snapshot().state, 'ready');
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|SECRET|passphrase|srt:\/\//);
});

test('inspection is passive and requires pinned exact private preparation', async t => {
  const f = await fixture(t); assert.deepEqual(await f.integration.inspect(), { available: true, videoProfile: PROFILE });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.children, []); assert.deepEqual(f.requests, []);
  for (const value of [{ ...f.config, extra: true }, { ...f.config, gstreamerVersion: '1.28.0' }, { ...f.config, lanAddress: '0.0.0.0' },
    { ...f.config, ports: { rtsp: 8557, srt: 8891 } }, { ...f.config, adapterLuid: 'bad' }, { ...f.config, gstreamerExecutable: 'unknown.exe' }, { ...f.config, sendBufferBytes: 0 }, { ...f.config, version: 1 }]) {
    await fs.writeFile(path.join(f.root, 'runtime.json'), JSON.stringify(value)); assert.equal((await f.integration.inspect()).available, false);
    await assert.rejects(f.start(), /Prepare the isolated/);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.children, []);
});
test('the separate branch captures raw owned client pixels and configures decimal600 without padding or audio', async t => {
  const f = await fixture(t); const result = await f.start(); assert.equal(result.videoProfile.configuredBitrateMbps, 599.999488);
  assert.equal(ENCODER_BITRATE, 585937); assert.equal(result.videoProfile.requestedBitrateMbps, 600); assert.equal(result.videoProfile.videoBitrateMbps, null);
  const command = f.children[0].args.join(' ');
  assert.match(command, /d3d11screencapturesrc capture-api=wgc adapter=0 window-handle=910 window-capture-mode=client/);
  assert.ok(command.indexOf('width=3840,height=2160,framerate=60/1') < command.indexOf('d3d11convert'));
  assert.match(command, /nvd3d11h264enc.*rc-mode=cbr bitrate=585937/); assert.match(command, /mpegtsmux alignment=7.*srtsink.*mode=listener/);
  assert.doesNotMatch(command, /audio|decodebin|udpsrc|hqp|stream\.mp3|bitrate=600000|padding/);
  assert.equal(f.children[0].options.shell, false); assert.equal(f.children[0].options.windowsHide, true);
  assert.equal(f.calls.filter(value => value.action === 'identity').length, 2);
});

test('the backpressure plugin is hash-pinned and isolated from the shared capture runtime', async t => {
  const f = await fixture(t); await f.start();
  const env = f.children[0].options.env;
  assert.equal(env.GST_PLUGIN_PATH_1_0, path.join(f.root, 'patched-plugin'));
  assert.equal(env.GST_REGISTRY_1_0, path.join(f.root, 'patched-plugin', 'registry.bin'));
  assert.notEqual(env.GST_PLUGIN_SYSTEM_PATH_1_0, env.GST_PLUGIN_PATH_1_0);
  await f.integration.stop({ viewerId: VIEWER, generation: 4 });
  await fs.writeFile(path.join(f.root, 'patched-plugin', 'gstsrt.dll'), 'unexpected replacement');
  assert.equal((await f.integration.inspect()).available, false);
  await assert.rejects(f.start(), /does not match preparation/);
  assert.equal(f.children.length, 1);
});

test('unprepared or unrecognized plugin metadata cannot silently use the old sender', async t => {
  const f = await fixture(t), pinFile = path.join(f.root, 'patched-plugin', 'backpressure-plugin.json');
  const good = JSON.parse(await fs.readFile(pinFile, 'utf8'));
  for (const bad of [{ ...good, revision: 'unknown' }, { ...good, version: 2 }, { ...good, sha256: 'x'.repeat(64) }, { ...good, extra: true }]) {
    await fs.writeFile(pinFile, JSON.stringify(bad));
    assert.equal((await f.integration.inspect()).available, false);
    await assert.rejects(f.start(), /backpressure plugin/);
  }
  await fs.unlink(pinFile);
  assert.equal((await f.integration.inspect()).available, false);
  await assert.rejects(f.start()); assert.equal(f.children.length, 0);
});

test('plugin replacement after probing is caught before process launch', async t => {
  const f = await fixture(t, { probeRuntime: async config => { await fs.writeFile(config.srtPluginPath, 'changed during probe'); } });
  await assert.rejects(f.start(), /does not match preparation/);
  assert.equal(f.children.length, 0);
});
test('the read-only native listener is AES128-key protected with explicit private binding and32MiB sender buffer', async t => {
  const f = await fixture(t); const result = await f.start(), command = f.children[0].args.join(' ');
  assert.match(command, /srtsink uri=srt:\/\/192\.168\.50\.119:8891\?mode=listener&sndbuf=33554432&fc=32768&maxbw=85000000&payloadsize=1316&enforcedencryption=true/);
  assert.match(command, /latency=250 passphrase=[a-f0-9]{32} pbkeylen=16 wait-for-connection=false auto-reconnect=false/);
  assert.doesNotMatch(command, /rtsp|rtmp|publish|API|0\.0\.0\.0/); assert.equal(f.children.length, 1); assert.deepEqual(f.requests, []);
  const url = new URL(result.url); assert.equal(url.protocol, 'srt:'); assert.equal(url.searchParams.get('mode'), 'caller'); assert.equal(url.searchParams.get('latency'), '250');
  assert.equal(url.searchParams.get('pbkeylen'), '16'); assert.equal(url.searchParams.has('streamid'), false);
  assert.equal(url.searchParams.get('passphrase').length, 32); assert.ok(command.includes('passphrase=' + url.searchParams.get('passphrase')));
  assert.equal(result.latencyUnit, 'milliseconds'); assert.equal(result.client, 'larix-player');
  const listener = f.calls.find(value => value.action === 'listener').details;
  assert.deepEqual(listener, { ProcessId: 700, ExpectedExecutable: f.config.gstreamerExecutable, StartTimeTicks: '638980000000000000', LocalAddress: '192.168.50.119', LocalPort: 8891 });
  assert.doesNotMatch(JSON.stringify(f.integration.snapshot()), /192\.168|127\.0|rh-srt-|passphrase|password|url|pub-|read-/);
});
test('source ownership, window geometry, lifetime, generation and capability are required before starting helpers', async t => {
  const f = await fixture(t);
  for (const extra of [{ viewerId: 'bad' }, { generation: 0 }, { expiresAt: 610001 }, { expiresAt: 9999 },
    { nativeIdentity: { ...identity, windowHandle: '0' } }, { nativeIdentity: { ...identity, windowTitle: 'G-Force' } },
    { nativeIdentity: { ...identity, executable: 'C:\\Elsewhere\\Aeon Standalone.exe' } }]) await assert.rejects(f.start(extra), /exact bounded/);
  f.setGeometry({ ...identity, width: 1920, height: 1080 }); await assert.rejects(f.start(), /same actual 3840/);
  f.setGeometry({ ...identity, width: 3840, height: 2160, windowHandle: '911' }); await assert.rejects(f.start(), /same actual/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.children, []);
});
test('transport conflicts and runtime probe failure start no relay, encoder or owned listener', async t => {
  const f = await fixture(t); await assert.rejects(f.start({ forbiddenPorts: [8891] }), /conflict/); await assert.rejects(f.start({ lanAddress: '192.168.1.2' }), /conflict/);
  assert.deepEqual(f.calls, []); const g = await fixture(t, { probeRuntime: async () => { throw Error('offline missing encoder'); } });
  await assert.rejects(g.start(), /missing encoder/); assert.equal(g.children.length, 0); await assert.rejects(fs.stat(path.join(g.root, 'owner.lock')), { code: 'ENOENT' });
});
test('port probes bind only the exact LAN UDP address and always release handles', async () => {
  const values = [], handles = [];
  const handle = kind => { const h = new EventEmitter(); h.close = cb => { values.push({ closed: kind }); cb(); }; handles.push(h); return h; };
  await checkPorts({ ports: { srt: 8891 }, lanAddress: '192.168.50.119' }, {
    createSocket: () => { const h = handle('udp'); h.bind = (port, address, cb) => { values.push({ port, address }); cb(); }; return h; }
  });
  assert.deepEqual(values.filter(value => value.port), [{ port: 8891, address: '192.168.50.119' }]);
  assert.equal(values.filter(value => value.closed).length, 1);
});
test('Stop accepts only the exact owner/generation and releases encoder then relay', async t => {
  const f = await fixture(t); await f.start();
  assert.deepEqual(await f.integration.stop({ viewerId: 'another_abcdefghijklmnopqrstuv', generation: 4 }), { released: false });
  assert.deepEqual(await f.integration.stop({ viewerId: VIEWER, generation: 3 }), { released: false }); assert.deepEqual(await f.integration.stop(), { released: false });
  await assert.rejects(f.start(), /Stop the independent/); assert.equal(f.integration.snapshot().state, 'ready');
  assert.deepEqual(await f.integration.stop({ viewerId: VIEWER, generation: 4 }), { released: true });
  assert.deepEqual(f.calls.filter(value => value.action === 'terminate').map(value => value.details.ProcessId), [700]);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' }); assert.equal(f.integration.snapshot().state, 'idle'); assert.ok(f.timers.every(timer => timer.cancelled));
});
test('each completed trial rotates its private AES encryption key', async t => {
  const f = await fixture(t); const first = new URL((await f.start()).url); await f.integration.stop({ viewerId: VIEWER, generation: 4 });
  const second = new URL((await f.start()).url); assert.notEqual(first.searchParams.get('passphrase'), second.searchParams.get('passphrase'));
});
test('a changed generation or native geometry stops only the two independent helper identities', async t => {
  const f = await fixture(t); await f.start(); f.deactivate(); f.advance(2000); await f.tick();
  // A generation fence schedules cleanup asynchronously, then exact Stop joins it.
  await f.integration.stop({ viewerId: VIEWER, generation: 4 }); assert.equal(f.integration.snapshot().state, 'idle');
  assert.deepEqual(f.calls.filter(value => value.action === 'terminate').map(value => value.details.ProcessId), [700]);
  const g = await fixture(t); await g.start(); g.setGeometry({ ...identity, width: 1920, height: 1080 }); g.advance(2000); await g.tick();
  assert.equal(g.integration.snapshot().state, 'error'); assert.equal(g.failures.length, 1);
  assert.deepEqual(g.integration.snapshot().diagnostics, { failureCode: 'native-identity-lost', failureObservedAt: 12000, exitCode: null, signal: null });
});
test('the fixed original deadline aborts setup and cleanup without extending on monitor', async t => {
  const probe = deferred(); const f = await fixture(t, { probeRuntime: (_, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Error('cancelled'))); probe.resolve(); }) });
  const pending = f.start({ expiresAt: 10250 }); const rejection = assert.rejects(pending, /cancelled/); await probe.promise;
  assert.equal(f.timers[0].ms, 250); f.advance(250); const stop = f.timers[0].fn(); await rejection; await stop;
  assert.equal(f.children.length, 0); assert.equal(f.integration.snapshot().state, 'idle');
});
test('an explicit Stop racing startup prevents a stale URL and joins exact new helper cleanup', async t => {
  const entered = deferred(), response = deferred(); const f = await fixture(t, { listenerAction: async () => { entered.resolve(); return response.promise; } });
  const pending = f.start(), rejected = assert.rejects(pending, /generation ended/); await entered.promise;
  const stopped = f.integration.stop({ viewerId: VIEWER, generation: 4 }); response.resolve({ listening: true });
  await rejected; await stopped; assert.equal(f.integration.snapshot().state, 'idle'); assert.equal(f.children.length, 1);
});
test('an encodedAU counter alone cannot claimready without actualH264caps andownedUDP listener', async t => {
  for (const overrides of [{ noCaps: true }, { noBytes: true }, { listenerAction: async () => ({ listening: false }) }]) {
    const f = await fixture(t, overrides); await assert.rejects(f.start(), /owned SRT listener did not become ready/); assert.equal(f.integration.snapshot().state, 'idle'); assert.equal(f.children.length, 1);
  }
});
test('actual incoming video bytes and parser caps are measured independently from the configured target', async t => {
  const f = await fixture(t); await f.start(); f.children[0].child.stdout.emit('data', Buffer.from('/GstPipeline:Owned/GstH264Parse:OwnedSrtParser.GstPad:src: caps = video/x-h264, profile=(string)high, level=(string)6.1, width=(int)3840, height=(int)2160\n'));
  f.setBytes(10000 + 100000000); f.advance(2000); await f.tick(); const profile = f.integration.snapshot().videoProfile;
  assert.equal(profile.videoBitrateMbps, 400); assert.equal(profile.videoBitrateWindowMs, 2000); assert.equal(profile.videoBitrateObservedAt, 12000);
  assert.deepEqual(profile.observedCodec, { profile: 'high', level: '6.1', observedAt: 10000, measurement: 'gstreamer-h264parse-caps' });
  f.advance(6001); assert.equal(f.integration.snapshot().videoProfile.videoBitrateMbps, null);
});
test('no receiver counters or delivered bitrate are invented by a ready listener andencodedAU measurements', async t => {
  const f = await fixture(t); const result = await f.start(); assert.equal(new URL(result.url).searchParams.has('streamid'), false);
  f.setBytes(20000); f.advance(2000); await f.tick(); const snapshot = f.integration.snapshot();
  assert.equal(snapshot.readers, null); assert.deepEqual(snapshot.stats, []); assert.equal(snapshot.observedAt, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|rh-srt-|remoteAddr|passphrase/); f.advance(6001); assert.equal(f.integration.snapshot().readers, null); assert.deepEqual(f.integration.snapshot().stats, []);
});
test('without native receiver statistics, ordinary diagnostics retain source readiness andunknownreceiverstatus', async t => {
  const f = await fixture(t);
  await f.start();
  // Source output continues beyond five seconds with no receiver evidence;
  // nonfatal caller warnings cannot be promoted into encoder-failure claims.
  f.children[0].child.stderr.emit('data', Buffer.from('Dropping caller 5: Connection was broken\n'));
  for (let i = 1; i <= 8; i++) { f.setBytes(10000 + i * 10000); f.advance(2000); await f.tick(); }
  assert.equal(f.integration.snapshot().state, 'ready'); assert.equal(f.integration.snapshot().readers, null); assert.equal(f.failures.length, 0);
  assert.equal(f.calls.filter(value => value.action === 'terminate').length, 0); assert.equal(f.children[0].options.env.GST_DEBUG, 'srt*:2');
  assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: null, failureObservedAt: null, exitCode: null, signal: null });
});
test('failed exact cleanup preserves ownership and permits an explicit retry', async t => {
  let fail = true; const f = await fixture(t, { processAction: action => { if (action === 'terminate' && fail) throw Error('offline refused close'); } });
  await f.start(); await assert.rejects(f.integration.stop({ viewerId: VIEWER, generation: 4 }), /ownership record was preserved/);
  assert.equal(f.integration.snapshot().state, 'error'); assert.ok(await fs.stat(path.join(f.root, 'owner.lock'))); await assert.rejects(f.start(), /Stop the independent/);
  fail = false; await f.integration.stop({ viewerId: VIEWER, generation: 4 }); await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
});
test('an unverified spawned helper is terminated through its own Node handle, never an arbitrary PID', async t => {
  const f = await fixture(t, { processAction: (action, value) => action === 'identity' && value.ProcessId === 700 ? { pid: 999, executable: value.ExpectedExecutable, startTimeTicks: '638980000000000000' } : undefined });
  await assert.rejects(f.start(), /ownership could not be verified/); assert.deepEqual(f.calls.filter(value => value.handleKill), [{ handleKill: 700 }]); assert.equal(f.calls.filter(value => value.action === 'terminate').length, 0);
});
test('a private runtime ownership lock is never taken over or cleaned by a different owner', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'owner.lock'), 'other owner'); await assert.rejects(f.start(), /already has an owner/);
  assert.equal(await fs.readFile(path.join(f.root, 'owner.lock'), 'utf8'), 'other owner'); assert.equal(f.children.length, 0);
});

test('an unexpected encoder exit retains only its first safe cause after owned cleanup', async t => {
  const f = await fixture(t); await f.start(); f.advance(750);
  f.children[0].child.emit('exit', 3221225477, null);
  await f.integration.stop({ viewerId: VIEWER, generation: 4 });
  const expected = { failureCode: 'child-exit', failureObservedAt: 10750, exitCode: 3221225477, signal: null };
  assert.equal(f.integration.snapshot().state, 'error'); assert.deepEqual(f.integration.snapshot().diagnostics, expected);
  await assert.rejects(fs.stat(path.join(f.root, 'owner.lock')), { code: 'ENOENT' });
  assert.equal(f.failures.length, 1); assert.equal(f.calls.filter(value => value.action === 'terminate').length, 0);
  const altered = f.integration.snapshot(); altered.diagnostics.failureCode = 'changed';
  assert.deepEqual(f.integration.snapshot().diagnostics, expected);
  await f.start(); assert.equal(f.integration.snapshot().state, 'ready');
  assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: null, failureObservedAt: null, exitCode: null, signal: null });
});

test('child errors, raw stderr and unrecognized exit data never expose credentials or native errors', async t => {
  const secret = 'srt://private.test:8891?passphrase=never-retain-this';
  const f = await fixture(t); await f.start();
  f.children[0].child.stderr.emit('data', Buffer.from(secret + '\n')); f.children[0].child.emit('error', Object.assign(Error(secret), { code: secret }));
  await f.integration.stop({ viewerId: VIEWER, generation: 4 });
  assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: 'child-error', failureObservedAt: 10000, exitCode: null, signal: null });
  assert.doesNotMatch(JSON.stringify({ snapshot: f.integration.snapshot(), failures: f.failures }), /never-retain-this|private\.test|passphrase|stderr|argv/);
  const g = await fixture(t); await g.start(); g.children[0].child.emit('exit', secret, secret); await g.integration.stop({ viewerId: VIEWER, generation: 4 });
  assert.deepEqual(g.integration.snapshot().diagnostics, { failureCode: 'child-exit', failureObservedAt: 10000, exitCode: null, signal: null });
});

test('child exit diagnostics admit only bounded numeric status and known signals', async t => {
  for (const [code, signal, expectedCode, expectedSignal] of [[-2147483648, 'SIGTERM', -2147483648, 'SIGTERM'],
    [4294967295, 'SIGKILL', 4294967295, 'SIGKILL'], [-2147483649, 'SIGBAD', null, null], [4294967296, null, null, null], [1.5, 'SIGSEGV', null, 'SIGSEGV']]) {
    const f = await fixture(t); await f.start(); f.children[0].child.emit('exit', code, signal); await f.integration.stop({ viewerId: VIEWER, generation: 4 });
    assert.equal(f.integration.snapshot().diagnostics.exitCode, expectedCode); assert.equal(f.integration.snapshot().diagnostics.signal, expectedSignal);
  }
});

test('a fragmented confirmed SRT send-buffer disconnect is retained even while the encoder produces video', async t => {
  const f = await fixture(t); await f.start(); f.advance(8500);
  assert.equal(f.children[0].options.env.GST_DEBUG, 'srt*:2');
  assert.equal(f.children[0].options.env.GST_DEBUG_NO_COLOR, '1');
  f.children[0].child.stderr.emit('data', Buffer.from('srt://private.test/?passphrase=never-retain\n0:00:08 WARN srtobject gstsrtobject.c:1817:gst_srt_object_write_to_callers:<srtsink0> Dropping caller 123: Non-blocking call failure: no buffer '));
  assert.equal(f.integration.snapshot().state, 'ready');
  f.setBytes(20000);
  f.children[0].child.stderr.emit('data', Buffer.from('available for sending\r\n'));
  await f.integration.stop({ viewerId: VIEWER, generation: 4 });
  assert.equal(f.integration.snapshot().state, 'error');
  assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: 'send-buffer-full', failureObservedAt: 18500, exitCode: null, signal: null });
  assert.equal(f.failures.length, 1);
  assert.equal(f.calls.filter(value => value.action === 'terminate').length, 1);
  assert.doesNotMatch(JSON.stringify({ status: f.integration.snapshot(), failures: f.failures }), /private\.test|never-retain|passphrase|Dropping caller/);
});

test('ordinary reader disconnects and stale sender warnings do not invent failures', async t => {
  const f = await fixture(t); await f.start();
  const exact = 'WARN srtobject gstsrtobject.c:1817:gst_srt_object_write_to_callers:<srtsink0> Dropping caller 123: Non-blocking call failure: no buffer available for sending\n';
  for (const line of ['Dropping caller 123: Non-blocking call failure: no buffer available for sending\n',
    exact.replace('Non-blocking call failure: no buffer available for sending', 'Connection was broken'),
    'private unrelated driver error\n', 'x'.repeat(20000) + '\n']) {
    f.children[0].child.stderr.emit('data', Buffer.from(line));
    assert.equal(f.integration.snapshot().state, 'ready');
  }
  await f.integration.stop({ viewerId: VIEWER, generation: 4 });
  await f.start();
  f.children[0].child.stderr.emit('data', Buffer.from(exact));
  assert.equal(f.integration.snapshot().state, 'ready'); assert.equal(f.failures.length, 0);
});

test('lost owned listener and rejected monitor observation have distinct bounded causes', async t => {
  for (const [result, code] of [[() => ({ listening: false }), 'listener-lost'], [() => { throw Error('private driver error'); }, 'monitor-error']]) {
    let fail = false; const f = await fixture(t, { listenerAction: () => fail ? result() : undefined });
    await f.start(); fail = true; f.advance(2000); await f.tick();
    assert.equal(f.integration.snapshot().state, 'error');
    assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: code, failureObservedAt: 12000, exitCode: null, signal: null });
    assert.doesNotMatch(JSON.stringify(f.integration.snapshot()), /private driver/); assert.equal(f.failures.length, 1);
  }
});

test('encoded output watchdog preserves six-second threshold and its actual cause after cleanup', async t => {
  const f = await fixture(t); await f.start();
  f.advance(6000); await f.tick(); assert.equal(f.integration.snapshot().state, 'ready'); assert.equal(f.failures.length, 0);
  f.advance(1); await f.tick(); assert.equal(f.integration.snapshot().state, 'error');
  assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: 'encoded-output-stale', failureObservedAt: 16001, exitCode: null, signal: null });
  assert.equal(f.calls.filter(value => value.action === 'terminate').length, 1);
});

test('cleanup failure is recorded only when no earlier actual failure exists', async t => {
  for (const initialFailure of [false, true]) {
    let fail = true; const f = await fixture(t, { processAction: action => { if (action === 'terminate' && fail) throw Error('private cleanup detail'); } });
    await f.start();
    if (initialFailure) f.children[0].child.emit('error', Error('private encoder detail'));
    await assert.rejects(f.integration.stop({ viewerId: VIEWER, generation: 4 }), /ownership record was preserved/);
    const expected = { failureCode: initialFailure ? 'child-error' : 'cleanup-failed', failureObservedAt: 10000, exitCode: null, signal: null };
    assert.deepEqual(f.integration.snapshot().diagnostics, expected); assert.ok(await fs.stat(path.join(f.root, 'owner.lock')));
    fail = false; f.advance(2000); await f.integration.stop({ viewerId: VIEWER, generation: 4 });
    assert.deepEqual(f.integration.snapshot().diagnostics, expected); assert.equal(f.failures.length, 1);
    assert.doesNotMatch(JSON.stringify({ snapshot: f.integration.snapshot(), failures: f.failures }), /private cleanup|private encoder/);
  }
});

test('normal Stop, generation exit and fixed deadline do not invent an encoder failure', async t => {
  for (const reason of ['stop', 'generation', 'deadline']) {
    const f = await fixture(t); await f.start();
    if (reason === 'generation') { f.deactivate(); f.advance(2000); await f.tick(); }
    if (reason === 'deadline') { f.advance(600000); await f.timers[0].fn(); }
    await f.integration.stop({ viewerId: VIEWER, generation: 4 });
    assert.equal(f.integration.snapshot().state, 'idle'); assert.equal(f.failures.length, 0);
    assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: null, failureObservedAt: null, exitCode: null, signal: null });
  }
});

test('Stop during an in-flight monitor failure fences the obsolete completion', async t => {
  const entered = deferred(), response = deferred(); let wait = false;
  const f = await fixture(t, { listenerAction: () => { if (wait) { entered.resolve(); return response.promise; } } });
  await f.start(); wait = true; f.advance(2000); const monitoring = f.tick(); await entered.promise;
  const stopping = f.integration.stop({ viewerId: VIEWER, generation: 4 }); response.reject(Error('private stale listener failure'));
  await monitoring; await stopping; assert.equal(f.integration.snapshot().state, 'idle'); assert.equal(f.failures.length, 0);
  assert.deepEqual(f.integration.snapshot().diagnostics, { failureCode: null, failureObservedAt: null, exitCode: null, signal: null });
});
