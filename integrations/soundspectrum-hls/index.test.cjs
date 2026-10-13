'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createIntegration, normalizeProfile, buildPipeline, buildCaptureConfig, relayConfig, assetQuery, ASSET_NAME, BUFFER_BYTES, CAPTURE_VERSION, CAPTURE_PROTOCOL } = require('./index.cjs');
const helperVersion = { version: CAPTURE_VERSION, protocol: CAPTURE_PROTOCOL, gstreamerVersion: '1.26.11' };
const readyStatus = { event: 'ready', ...helperVersion, interval100ns: 10000, width: 3840, height: 2160, targetFps: 60 };
const frameStatus = (frames = 60, elapsedMs = 1000) => ({ event: 'stats', elapsedMs, frames, bytes: frames * 12000,
  captureFrames: frames + 4, copiedFrames: frames + 4, appsrcFrames: frames + 4, encoderFrames: frames,
  poolDrops: 0, appsrcDrops: 0, videorateDrops: 4, videorateDuplicates: 0, ptsErrors: 0 });
const native = () => ({ pid: 47, executable: 'C:\\Program Files (x86)\\SoundSpectrum\\WhiteCap\\WhiteCap Standalone.x64.exe',
  windowHandle: '1234', startTimeTicks: '638000000000000001', windowClass: 'OwnedNativeClass',
  windowTitle: 'Rabbit Hole WhiteCap RH-12345678-1234-1234-1234-123456789abc', width: 3840, height: 2160 });
const profile = rate => ({ width: 3840, height: 2160, fps: 60, targetBitrateMbps: rate });
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-hls-test-'));
  const gst = path.join(root, 'data/soundspectrum-gstreamer/1.26.11/bin/gst-launch-1.0.exe');
  const capture = path.join(root, 'data/soundspectrum-hls/native/hls-wgc.exe');
  const runtimeRoot = path.join(root, 'data/soundspectrum-hls');
  const calls = [], children = [], timers = [], requests = [];
  let at = 1000, current = true, observed = native(), fetchOverride;
  const processes = new Map();
  const opts = { appRoot: root, runtimeRoot, skipFileProbe: true, gracefulStopMs: 0,
    readRuntime: async () => ({ gstreamerVersion: '1.26.11', gstreamerExecutable: gst, adapterIndex: 0 }),
    execFileImpl: async (exe, args) => { calls.push({ kind: 'probe', exe, args }); return { stdout: args[0] === '--version' ? exe === gst ? 'GStreamer 1.26.11' : exe === capture ? JSON.stringify(helperVersion) : 'v1.21.1' : 'element available' }; },
    clock: () => at, sleep: async (ms, signal) => { at += ms; if (signal?.aborted) throw Error('aborted'); },
    setTimeoutImpl: fn => { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimeoutImpl: () => {},
    allocatePorts: async () => ({ rtmp: 18854, hls: 18888, api: 19997 }),
    spawnImpl: (exe, args, options) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 5000 + children.length;
      if (exe === capture && overrides.captureSpawnFailure) {
        delete child.pid; child.kill = () => { throw Error('No process was spawned'); };
        children.push({ child, exe, args, options }); queueMicrotask(() => child.emit('error', Error('fixture spawn failure'))); return child;
      }
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
      if (exe === capture) {
        child.stdin = new EventEmitter(); child.stdin.writable = true;
        child.stdin.write = config => { child.config = JSON.parse(config); for (const value of overrides.captureMessages || [readyStatus, frameStatus()]) child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); return true; };
        child.stdin.end = value => { calls.push({ kind: 'graceful-stop', pid: child.pid, value }); };
      }
      processes.set(child.pid, { child, exe }); children.push({ child, exe, args, options });
      return child;
    },
    processAction: async (action, details) => {
      calls.push({ kind: action, ...details });
      const entry = processes.get(details.ProcessId);
      if (action === 'terminate') { entry?.child.emit('exit', 0); return { terminated: true }; }
      if (details.ProcessId !== process.pid && !entry) return { exited: true };
      return { pid: details.ProcessId, executable: details.ExpectedExecutable, startTimeTicks: '638000000000000001' };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (fetchOverride) return fetchOverride(url, options);
      if (url.includes('/v3/')) return new Response('{}', { status: 200 });
      if (url.includes('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000000\nmain_stream.m3u8\n');
      if (url.includes('.m3u8')) return new Response('#EXTM3U\n#EXT-X-PART:DURATION=0.1,URI="part0.mp4"\n');
      return new Response(Buffer.from('media'), { status: 200, headers: { 'content-length': '5', 'x-secret': 'private' } });
    }, ...overrides };
  const integration = createIntegration(opts);
  t.after(async () => { await integration.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const start = extra => integration.start({ nativeIdentity: native(), generation: 3, observeWindow: async () => observed,
    isCurrent: () => current, profile: profile(600), ...extra });
  return { integration, start, root, runtimeRoot, gst, capture, calls, children, timers, requests, options: opts,
    advance: ms => { at += ms; }, invalidate: () => { current = false; }, observe: value => { observed = value; },
    fetch: fn => { fetchOverride = fn; } };
}

test('baseline profile accepts exact4K60 and integer50 through600; buffer units are decimal', () => {
  for (const rate of [50, 51, 200, 599, 600]) assert.equal(normalizeProfile(profile(rate)).targetBitrateMbps, rate);
  for (const rate of [49, 601, 50.5, '600', null, NaN]) assert.throws(() => normalizeProfile(profile(rate)));
  assert.throws(() => normalizeProfile({ ...profile(50), width: 1920 }));
  assert.throws(() => normalizeProfile({ ...profile(50), fps: 30 }));
  assert.equal(BUFFER_BYTES, 32000000);
});
test('legacy synthetic pipeline retains independent NVENC target and loopback RTMP only', () => {
  const session = { nativeIdentity: native(), epoch: 'a'.repeat(32), profile: profile(600), ports: { rtmp: 18854 }, mediaPath: 'test', user: 'u', password: 'p' };
  const args = buildPipeline({ adapterIndex: 0 }, session);
  assert.ok(args.includes('window-handle=1234')); assert.ok(args.includes('bitrate=585938')); assert.ok(args.includes('rtmp2sink')); assert.ok(args.includes('chunk-size=65536'));
  assert.ok(args.includes('gop-size=12')); assert.ok(!args.some(value => /srtsink|desktop|audiotestsrc/.test(value)));
  assert.throws(() => buildPipeline({ adapterIndex: 0 }, { ...session, nativeIdentity: { ...native(), pid: 0 } }));
});
test('relay exposes only loopback RTMP,HLS,API and disables unrelated protocols', () => {
  const value = relayConfig({ ports: { rtmp: 1, hls: 2, api: 3 }, user: 'u', password: 'p', mediaPath: 'm' });
  assert.deepEqual([value.rtmpAddress, value.hlsAddress, value.apiAddress], ['127.0.0.1:1', '127.0.0.1:2', '127.0.0.1:3']);
  assert.equal(value.hlsVariant, 'lowLatency'); assert.equal(value.hlsPartDuration, '100ms'); assert.equal(value.hlsSegmentCount, 71);
  for (const key of ['rtsp', 'webrtc', 'srt', 'moq', 'playback', 'metrics', 'pprof']) assert.equal(value[key], false);
  assert.equal(value.hlsCDNSecret, 'p');
});

test('relay history covers a 1 GB reserve plus recovery margin at every selectable bitrate', () => {
  for (let rate = 50; rate <= 600; rate++) {
    const value = relayConfig({ profile: profile(rate), ports: { rtmp: 1, hls: 2, api: 3 } });
    const seconds = value.hlsSegmentCount * 0.2;
    assert.ok(seconds >= 8000 / rate + 0.8 - 1e-9);
    assert.ok(seconds * rate / 8 <= 1075);
    assert.ok(value.hlsSegmentCount <= 804);
  }
});
test('asset paths and LL queries reject traversal,origin changes,duplicate and arbitrary parameters', () => {
  for (const value of ['../index.m3u8', 'x/y.m3u8', 'https://x/a.mp4', 'file.txt', 'a%2fb.mp4', 'a.mp4?x=1']) assert.equal(ASSET_NAME.test(value), false);
  assert.equal(assetQuery('_HLS_msn=42&_HLS_part=1&_HLS_skip=YES'), '_HLS_msn=42&_HLS_part=1&_HLS_skip=YES');
  for (const value of ['url=http://x', '_HLS_part=-1', '_HLS_part=1&_HLS_part=2', '_HLS_skip=bad']) assert.throws(() => assetQuery(value));
});
test('inspect is passive and caches probes; version mismatch is unavailable', async t => {
  const f = await fixture(t); assert.equal((await f.integration.inspect()).available, true); const probes = f.calls.length;
  assert.equal((await f.integration.inspect()).available, true); assert.equal(f.calls.length, probes); assert.equal(f.children.length, 0);
  await assert.rejects(fs.stat(f.runtimeRoot), { code: 'ENOENT' });
  const bad = await fixture(t, { execFileImpl: async () => ({ stdout: 'wrong version' }) }); assert.equal((await bad.integration.inspect()).available, false);
});
test('start observes exact native window, waits for media playlist and returns sanitized ready state', async t => {
  const f = await fixture(t); let ready = 0; const value = await f.start({ onReady: () => ready++ });
  assert.equal(value.ready, true); assert.equal(value.profile.targetBitrateMbps, 600); assert.equal(value.bufferBytes, 32000000); assert.equal(ready, 1);
  assert.equal(f.children.length, 2); assert.ok(f.requests.some(item => item.url.includes('main_stream.m3u8')));
  assert.equal(JSON.stringify(value).includes('password'), false); assert.equal(JSON.stringify(value).includes('127.0.0.1'), false);
  assert.ok(f.calls.filter(call => call.kind === 'identity' && call.ProcessId !== process.pid).every(call => call.ExpectedMarker));
  await assert.rejects(f.start(), /Stop the current/);
});
test('changed nativeidentity prevents capture and cleans its ownedlock', async t => {
  const f = await fixture(t); f.observe({ ...native(), windowHandle: '9876' });
  await assert.rejects(f.start(), /identity changed/); assert.equal(f.children.length, 0); assert.equal(f.integration.snapshot().state, 'idle');
});
test('stop kills owncapture before ownrelay and removes credentials and ownership', async t => {
  const f = await fixture(t); await f.start(); const result = await f.integration.stop(); assert.equal(result.released, true);
  const killed = f.calls.filter(call => call.kind === 'terminate'); assert.deepEqual(killed.map(call => call.ProcessId), [5001, 5000]);
  assert.ok(killed.every(call => call.StartTimeTicks && call.ExpectedMarker));
  await assert.rejects(fs.stat(path.join(f.runtimeRoot, 'owner.lock')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.runtimeRoot), []); assert.equal(f.integration.snapshot().state, 'idle');
});
test('readAsset forwards only safe mediaheaders and streams without buffering wholefragments', async t => {
  const f = await fixture(t); await f.start();
  const playlist = await f.integration.readAsset('index.m3u8', { generation: 3, query: '_HLS_msn=3&_HLS_part=1' });
  assert.ok(Buffer.isBuffer(playlist.body)); assert.equal(playlist.contentType, 'application/vnd.apple.mpegurl');
  const media = await f.integration.readAsset('part0.mp4', { generation: 3, range: 'bytes=0-4' });
  assert.equal(media.headers['x-secret'], undefined); assert.equal(media.headers['cache-control'], 'no-store');
  const chunks = []; for await (const chunk of media.body) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'media');
  assert.equal(f.requests.at(-1).options.headers.Range, 'bytes=0-4');
  assert.match(f.requests.at(-1).options.headers.Authorization, /^Bearer /);
  assert.match(f.requests.find(item => item.url.includes('/v3/')).options.headers.Authorization, /^Basic /);
  assert.equal(f.requests.at(-1).options.redirect, 'error');
  await assert.rejects(f.integration.readAsset('part0.mp4', { generation: 2 }), /no longer active/);
  await assert.rejects(f.integration.readAsset('../x', { generation: 3 }), /Invalid HLS asset/);
  await assert.rejects(f.integration.readAsset('part0.mp4', { generation: 3, range: 'bytes=0-4,5-6' }), /range/);
});
test('oversizedplaylist and unexpectedupstreamstatus are rejected without raw upstreamoutput', async t => {
  const f = await fixture(t); await f.start(); f.fetch(async () => new Response('x'.repeat(1048577)));
  await assert.rejects(f.integration.readAsset('index.m3u8', { generation: 3 }), /exceeded/);
  f.fetch(async () => new Response('SECRET', { status: 500 })); await assert.rejects(f.integration.readAsset('part0.mp4', { generation: 3 }), /could not serve/);
});
test('generation change during awaited media read is fenced', async t => {
  const f = await fixture(t); await f.start(); f.fetch(async () => { f.invalidate(); return new Response('media'); });
  await assert.rejects(f.integration.readAsset('part0.mp4', { generation: 3 }), /ended during/);
});
test('encoder exit invokes failure once and cleans onlyownedchildren', async t => {
  const f = await fixture(t); let failed = 0; await f.start({ onFailure: () => failed++ });
  f.children[1].child.emit('exit', 1); f.children[1].child.emit('error', Error('PRIVATE'));
  await f.integration.stop(); assert.equal(failed, 1); assert.equal(f.integration.snapshot().state, 'error');
  assert.deepEqual(f.calls.filter(call => call.kind === 'terminate').map(call => call.ProcessId), [5000]);
});
test('live owner prevents newhelpers and is neverterminated', async t => {
  const f = await fixture(t); await fs.mkdir(f.runtimeRoot, { recursive: true });
  await fs.writeFile(path.join(f.runtimeRoot, 'owner.lock'), JSON.stringify({ version: 1, epoch: 'a'.repeat(32),
    owner: { pid: process.pid, executable: process.execPath, startTimeTicks: '638000000000000001' } }));
  await assert.rejects(f.start(), /Another process owns/); assert.equal(f.children.length, 0); assert.equal(f.calls.some(call => call.kind === 'terminate'), false);
});
test('stale owner recovery skips exitedPIDs and verifies exactmarkers andticks', async t => {
  const f = await fixture(t); await fs.mkdir(f.runtimeRoot, { recursive: true });
  const epoch = 'b'.repeat(32), lock = { version: 1, epoch, owner: { pid: 99999, executable: process.execPath, startTimeTicks: '638000000000000001' } };
  await fs.writeFile(path.join(f.runtimeRoot, 'owner.lock'), JSON.stringify(lock));
  await fs.writeFile(path.join(f.runtimeRoot, 'owner.json'), JSON.stringify({ ...lock, processes: [{ pid: 88888, executable: f.gst,
    marker: `HlsEncoder${epoch}`, startTimeTicks: '638000000000000001' }] }));
  await f.start(); assert.equal(f.children.length, 2);
  const recovery = f.calls.find(call => call.kind === 'identity' && call.ProcessId === 88888);
  assert.equal(recovery.ExpectedMarker, `HlsEncoder${epoch}`); assert.equal(recovery.StartTimeTicks, '638000000000000001');
  assert.equal(f.calls.some(call => call.kind === 'terminate' && call.ProcessId === 88888), false);
});
test('failed capture termination still attempts relay, retains ownership, and allows cleanup retry', async t => {
  let failCapture = true, ownedAction;
  const attempted = [];
  const f = await fixture(t, { processAction: async (action, details) => {
    if (action === 'terminate') { attempted.push(details.ProcessId); if (details.ProcessId === 5001 && failCapture) throw Error('simulated capture termination failure'); }
    if (ownedAction) return ownedAction(action, details);
    return { pid: details.ProcessId, executable: details.ExpectedExecutable, startTimeTicks: '638000000000000001' };
  } });
  await f.start();
  ownedAction = async (action, details) => { const entry = f.children.find(item => item.child.pid === details.ProcessId); entry?.child.emit('exit', 0); return { terminated: true }; };
  await assert.rejects(f.integration.stop(), /could not all close/);
  assert.deepEqual(attempted, [5001, 5000]); assert.equal(f.integration.snapshot().state, 'stopping');
  assert.ok(await fs.stat(path.join(f.runtimeRoot, 'owner.lock')));
  failCapture = false; assert.equal((await f.integration.stop()).released, true);
  assert.deepEqual(attempted, [5001, 5000, 5001]);
  assert.equal(f.integration.snapshot().state, 'error');
  await assert.rejects(fs.stat(path.join(f.runtimeRoot, 'owner.lock')), { code: 'ENOENT' });
});
test('orphan recovery terminates only matching helper identity and skips reused process', async t => {
  const recoveryCalls = [];
  const f = await fixture(t, { processAction: async (action, details) => {
    recoveryCalls.push({ action, ...details });
    if (details.ProcessId === 99999) return { exited: true };
    if (details.ProcessId === 88889) return { identityChanged: true };
    if (action === 'terminate') return { terminated: true };
    return { pid: details.ProcessId, executable: details.ExpectedExecutable, startTimeTicks: '638000000000000001' };
  } });
  await fs.mkdir(f.runtimeRoot, { recursive: true });
  const epoch = 'c'.repeat(32), lock = { version: 1, epoch, owner: { pid: 99999, executable: process.execPath, startTimeTicks: '638000000000000001' } };
  await fs.mkdir(path.join(f.runtimeRoot, epoch)); await fs.writeFile(path.join(f.runtimeRoot, epoch, 'mediamtx.json'), '{}');
  await fs.writeFile(path.join(f.runtimeRoot, 'owner.lock'), JSON.stringify(lock));
  await fs.writeFile(path.join(f.runtimeRoot, 'owner.json'), JSON.stringify({ ...lock, processes: [
    { pid: 88889, executable: f.gst, marker: `HlsEncoder${epoch}`, startTimeTicks: '638000000000000001' },
    { pid: 88888, executable: f.gst, marker: `HlsEncoder${epoch}`, startTimeTicks: '638000000000000001' }
  ] }));
  await f.start();
  const terminated = recoveryCalls.filter(call => call.action === 'terminate');
  assert.deepEqual(terminated.map(call => call.ProcessId), [88888]); assert.equal(terminated[0].ExpectedMarker, `HlsEncoder${epoch}`);
  assert.equal(terminated[0].StartTimeTicks, '638000000000000001');
  await assert.rejects(fs.stat(path.join(f.runtimeRoot, epoch)), { code: 'ENOENT' });
});

test('live helper receives private configuration through stdin and only its epoch marker in argv', async t => {
  const f = await fixture(t); await f.start(); const entry = f.children[1], config = entry.child.config;
  assert.equal(entry.exe, f.capture); assert.match(entry.args[1], /^HlsEncoder[a-f0-9]{32}$/);
  assert.deepEqual(entry.args, ['--owned-hls', entry.args[1]]); assert.equal(entry.options.stdio[0], 'pipe');
  assert.equal(config.ownerPid, process.pid); assert.equal(config.ownerExecutable, process.execPath);
  assert.equal(config.nativePid, native().pid); assert.equal(config.windowTitle, native().windowTitle);
  assert.equal(config.bitrateMbps, 600); assert.equal(config.rtmpPort, 18854);
  for (const key of ['user', 'password', 'mediaPath']) {
    assert.match(config[key], /^[a-f0-9]{32}$/); assert.ok(!JSON.stringify(entry.args).includes(config[key]));
    assert.ok(!JSON.stringify(f.integration.snapshot()).includes(config[key]));
  }
});

test('capture config rejects invalid process identity and credentials before serialization', () => {
  const session = { nativeIdentity: native(), owner: { pid: process.pid, executable: process.execPath, startTimeTicks: '638000000000000001' },
    profile: profile(50), ports: { rtmp: 12345 }, user: 'a'.repeat(32), password: 'b'.repeat(32), mediaPath: 'c'.repeat(32) };
  assert.equal(JSON.parse(buildCaptureConfig({ adapterIndex: 0 }, session)).bitrateMbps, 50);
  for (const patch of [{ password: 'pass\nstop' }, { ports: { rtmp: 65536 } }, { owner: { ...session.owner, executable: 'other.exe' } },
    { nativeIdentity: { ...native(), startTimeTicks: '0' } }]) assert.throws(() => buildCaptureConfig({ adapterIndex: 0 }, { ...session, ...patch }));
});

test('capture rates come from monotonic helper samples and become unavailable when stale', async t => {
  const f = await fixture(t); await f.start(); assert.equal(f.integration.snapshot().encodedFps, null);
  // Delay delivery by a different duration; the 1s helper measurement is authoritative.
  f.advance(2400); f.children[1].child.stdout.emit('data', Buffer.from(JSON.stringify(frameStatus(120, 2000)) + '\n'));
  const value = f.integration.snapshot(); assert.equal(value.encodedFps, 60); assert.equal(value.captureFps, 60);
  assert.equal(value.videoBitrateMbps, 5.76);
  f.advance(6001); assert.equal(f.integration.snapshot().encodedFps, null); assert.equal(f.integration.snapshot().videoBitrateMbps, null);
});

test('invalid or regressing capture counters fail safely and cannot renew video freshness', async t => {
  for (const patch of [{ frames: 59 }, { bytes: -1 }, { elapsedMs: 1000 }, { ptsErrors: 1 }, { videorateDuplicates: 121 }, { captureFrames: 119 }]) {
    const f = await fixture(t); let failures = 0; await f.start({ onFailure: () => failures++ });
    f.children[1].child.stdout.emit('data', Buffer.from(JSON.stringify({ ...frameStatus(120, 2000), ...patch }) + '\n'));
    await f.integration.stop(); assert.equal(failures, 1); assert.equal(f.integration.snapshot().state, 'error');
  }
});

test('constant-rate pacing accepts counted short frame holds but rejects regressing hold counters', async t => {
  const f = await fixture(t); let failures = 0;
  await f.start({ onFailure: () => failures++ });
  const held = { ...frameStatus(120, 2000), captureFrames: 118, copiedFrames: 118,
    appsrcFrames: 118, videorateDuplicates: 2 };
  f.children[1].child.stdout.emit('data', Buffer.from(JSON.stringify(held) + '\n'));
  assert.equal(failures, 0); assert.equal(f.integration.snapshot().encodedFps, 60);
  f.children[1].child.stdout.emit('data', Buffer.from(JSON.stringify({ ...frameStatus(180, 3000), videorateDuplicates: 1 }) + '\n'));
  await f.integration.stop(); assert.equal(failures, 1);
});

test('readiness requires validated capture settings and progressing encoded media', async t => {
  for (const captureMessages of [[{ ...readyStatus, interval100ns: 160000 }], [frameStatus()], [readyStatus],
    [readyStatus, readyStatus], [readyStatus, { ...frameStatus(), videorateDuplicates: 61 }]]) {
    const f = await fixture(t, { captureMessages }); let ready = false;
    await assert.rejects(f.start({ onReady: () => { ready = true; } }));
    assert.equal(ready, false); assert.equal(f.integration.snapshot().ready, false);
    await assert.rejects(fs.stat(path.join(f.runtimeRoot, 'owner.lock')), { code: 'ENOENT' });
  }
});

test('graceful capture shutdown completes before relay termination without killing an exited process', async t => {
  const f = await fixture(t); await f.start();
  f.children[1].child.stdin.end = value => {
    assert.equal(value, 'stop\n'); f.calls.push({ kind: 'capture-stopped' }); f.children[1].child.emit('exit', 0);
  };
  await f.integration.stop();
  assert.deepEqual(f.calls.filter(call => call.kind === 'terminate').map(call => call.ProcessId), [5000]);
  assert.ok(f.calls.findIndex(call => call.kind === 'capture-stopped') < f.calls.findIndex(call => call.kind === 'terminate'));
});

test('stale output from an ended capture cannot mutate a replacement generation', async t => {
  const f = await fixture(t); await f.start(); const old = f.children[1].child;
  await f.integration.stop(); await f.start({ generation: 4 });
  old.stdout.emit('data', Buffer.from(JSON.stringify(frameStatus(10000, 10000)) + '\n'));
  assert.equal(f.integration.snapshot().generation, 4); assert.equal(f.integration.snapshot().encodedFps, null);
  assert.equal(f.integration.snapshot().ready, true);
});

test('capture build must match source and binary, and is reverified even after a cached inspect', async t => {
  const f = await fixture(t, { skipFileProbe: false });
  const source = path.join(f.root, 'integrations/soundspectrum-hls/native/hls-wgc.cpp');
  const relay = path.join(f.root, 'data/soundspectrum-obs-webrtc/mediamtx/mediamtx.exe');
  for (const file of [source, relay, f.gst, f.capture]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture'); }
  const hash = crypto.createHash('sha256').update('fixture').digest('hex');
  await fs.writeFile(path.join(path.dirname(f.capture), 'build.json'), JSON.stringify({ ...helperVersion, sourceSha256: hash, executableSha256: hash }));
  assert.equal((await f.integration.inspect()).available, true);
  await fs.writeFile(f.capture, 'changed');
  await assert.rejects(f.start(), /Rebuild/); assert.equal(f.children.length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'terminate').length, 0);
  await assert.rejects(fs.stat(path.join(f.runtimeRoot, 'owner.lock')), { code: 'ENOENT' });
});

test('malformed and oversized helper output fails without throwing out of the event handler', async t => {
  for (const output of ['null\n', '[]\n', 'invalid\n', JSON.stringify({ event: 'unknown' }) + '\n', 'x'.repeat(65537)]) {
    const f = await fixture(t); let failed = 0; await f.start({ onFailure: () => failed++ });
    assert.doesNotThrow(() => f.children[1].child.stdout.emit('data', Buffer.from(output)));
    await f.integration.stop(); assert.equal(failed, 1); assert.equal(f.integration.snapshot().ready, false);
  }
});

test('spawn error without a PID or exit event releases ownership and still closes the earlier relay', async t => {
  const f = await fixture(t, { captureSpawnFailure: true });
  await assert.rejects(f.start(), /helper did not start/);
  assert.deepEqual(f.calls.filter(call => call.kind === 'terminate').map(call => call.ProcessId), [5000]);
  await assert.rejects(fs.stat(path.join(f.runtimeRoot, 'owner.lock')), { code: 'ENOENT' });
  assert.equal(f.integration.snapshot().ready, false);
});


test('large bounded playlists supporting 1 GB history pass through the provider', async t => {
  const f = await fixture(t); await f.start();
  const body = '#EXTM3U\n' + Array.from({ length: 804 }, (_, i) => '#EXT-X-PROGRAM-DATE-TIME:2026-10-10T00:00:00.000Z\n#EXTINF:0.200000,\n' + 'segment_'.repeat(4) + i + '.mp4\n').join('');
  assert.ok(Buffer.byteLength(body) > 65536);
  f.fetch(async () => new Response(body));
  const result = await f.integration.readAsset('index.m3u8', { generation: 3 }); assert.equal(result.body.toString(), body);
});

test('120 fps reaches the owned helper and requires matching readiness',async t=>{
 const messages=[{...readyStatus,targetFps:120},frameStatus(120)];
 const f=await fixture(t,{captureMessages:messages});await f.start({profile:{...profile(150),fps:120}});
 const encoder=f.children.find(c=>c.child.config);
 assert.equal(encoder.child.config.targetFps,120);assert.equal(f.integration.snapshot().profile.targetFps,120);
 encoder.child.stdout.emit('data',Buffer.from(JSON.stringify(frameStatus(240,2000))+'\n'));
 assert.equal(f.integration.snapshot().captureFps,120);assert.equal(f.integration.snapshot().encodedFps,120);
 assert.equal(f.integration.snapshot().duplicateFps,0);
});
test('120 profile cannot pass a helper configured for 60',async t=>{
 const f=await fixture(t); await assert.rejects(f.start({profile:{...profile(150),fps:120}}),/capture|changed|ready|configuration|HLS/i);
});
test('profile rejects contradictory fps fields',()=>{
 assert.throws(()=>normalizeProfile({...profile(150),fps:120,targetFps:60}));
 assert.equal(normalizeProfile({...profile(150),fps:120,targetFps:120}).fps,120);
});

test('120 fps rejects generated repeats instead of counting them as source frames',async t=>{
 const f=await fixture(t,{captureMessages:[{...readyStatus,targetFps:120},{...frameStatus(120),videorateDuplicates:1}]});
 await assert.rejects(f.start({profile:{...profile(150),fps:120}}),/HLS|capture|counter|changed/i);
});
