'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable } = require('node:stream');
const { captureEnvironment } = require('../../scripts/soundspectrum-capture.cjs');
const execute = promisify(execFile);
const BUFFER_BYTES = 32000000;
const CAPTURE_VERSION = 'hls-wgc-3';
const CAPTURE_PROTOCOL = 1;
const DEFAULT_PROFILE = Object.freeze({ width: 3840, height: 2160, fps: 60, targetFps: 60, targetBitrateMbps: 600 });
const ASSET_NAME = /^[A-Za-z0-9_-]{1,128}\.(?:m3u8|mp4|m4s|ts)$/;
const failure = (message, statusCode = 503) => Object.assign(Error(message), { statusCode });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const token = () => crypto.randomBytes(16).toString('hex');
function normalizeProfile(value = DEFAULT_PROFILE) {
  if (!value || value.width !== 3840 || value.height !== 2160 || ![60,120].includes(value.fps ?? value.targetFps) ||
      value.targetFps !== undefined && value.targetFps !== (value.fps ?? value.targetFps) || !Number.isInteger(value.targetBitrateMbps) ||
      value.targetBitrateMbps < 50 || value.targetBitrateMbps > 600) throw failure('Choose 60 or 120 fps and an HLS bitrate from 50 to 600 Mbps.', 400);
  return { ...DEFAULT_PROFILE, fps: value.fps ?? value.targetFps, targetFps: value.fps ?? value.targetFps, targetBitrateMbps: value.targetBitrateMbps };
}
function validNative(value) {
  const title = /^Rabbit Hole (G-Force|Aeon|WhiteCap) RH-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.exec(value?.windowTitle || '');
  const exe = /^(G-Force|Aeon|WhiteCap) Standalone(?:\.x64)?\.exe$/i.exec(path.win32.basename(value?.executable || ''));
  return Number.isSafeInteger(value?.pid) && value.pid > 0 && /^\d{10,22}$/.test(String(value?.startTimeTicks)) &&
    /^\d{1,20}$/.test(String(value?.windowHandle)) && BigInt(value.windowHandle) > 0n && BigInt(value.windowHandle) <= 18446744073709551615n &&
    typeof value.windowClass === 'string' && value.windowClass && title && exe && title[1].toLowerCase() === exe[1].toLowerCase();
}
function assetQuery(value) {
  const input = value instanceof URLSearchParams ? value : new URLSearchParams(value || '');
  const result = new URLSearchParams();
  for (const [key, item] of input) {
    if (result.has(key) || !['_HLS_msn', '_HLS_part', '_HLS_skip'].includes(key) ||
        (key === '_HLS_skip' ? !['YES', 'v2'].includes(item) : !/^\d{1,12}$/.test(item))) throw failure('Invalid HLS media query.', 400);
    result.set(key, item);
  }
  return result.toString();
}
function relayConfig(session) {
  // Retain enough history for the largest selectable 1 GB reserve at this
  // bitrate, plus four segments. Keep the byte cost bounded across bitrates.
  const historySegments = Math.max(7, Math.ceil((8000 / (session.profile?.targetBitrateMbps || 600) + 0.8) / 0.2));
  return { logLevel: 'warn', logDestinations: ['stdout'], readTimeout: '10s', writeTimeout: '10s', writeQueueSize: 256,
    api: true, apiAddress: `127.0.0.1:${session.ports.api}`, apiAllowOrigins: [], metrics: false, pprof: false, playback: false,
    rtsp: false, rtmp: true, rtmpAddress: `127.0.0.1:${session.ports.rtmp}`, rtmpEncryption: 'no',
    webrtc: false, srt: false, moq: false,
    hls: true, hlsAddress: `127.0.0.1:${session.ports.hls}`, hlsAllowOrigins: [], hlsEncryption: false,
    hlsAlwaysRemux: true, hlsVariant: 'lowLatency', hlsSegmentCount: historySegments, hlsSegmentDuration: '200ms',
    hlsPartDuration: '100ms', hlsSegmentMaxSize: '64M', hlsMuxerCloseAfter: '10s', hlsCDNSecret: session.password,
    authMethod: 'internal', authInternalUsers: [{ user: session.user, pass: session.password, ips: ['127.0.0.1', '::1'],
      permissions: [{ action: 'publish', path: session.mediaPath }, { action: 'read', path: session.mediaPath }, { action: 'api' }] }],
    paths: { [session.mediaPath]: { source: 'publisher', overridePublisher: false, maxReaders: 8, record: false } } };
}
function buildPipeline(config, session) {
  // Retained for the explicit synthetic validator and historical orphan tests.
  // Live native capture uses the owned WGC helper below.
  if (!validNative(session.nativeIdentity)) throw failure('An exact owned HLS capture window is required.', 400);
  const rate = Math.round(session.profile.targetBitrateMbps * 1000000 / 1024);
  return ['--gst-disable-registry-update', '-v', 'd3d11screencapturesrc', 'capture-api=wgc', `adapter=${config.adapterIndex}`,
    `window-handle=${session.nativeIdentity.windowHandle}`, 'window-capture-mode=client', 'show-cursor=false',
    '!', `video/x-raw(memory:D3D11Memory),width=3840,height=2160,framerate=${session.profile.fps}/1`,
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=2', 'max-size-bytes=0', 'max-size-time=0',
    '!', 'd3d11convert', `adapter=${config.adapterIndex}`,
    '!', `video/x-raw(memory:D3D11Memory),format=NV12,width=3840,height=2160,framerate=${session.profile.fps}/1,pixel-aspect-ratio=1/1,colorimetry=bt709`,
    '!', 'nvd3d11h264enc', `name=HlsEncoder${session.epoch}`, 'preset=p5', 'tune=low-latency', 'rc-mode=cbr',
    `bitrate=${rate}`, `max-bitrate=${rate}`, `gop-size=${session.profile.fps / 5}`, 'bframes=0', 'rc-lookahead=0', 'multi-pass=disabled',
    'zerolatency=true', 'repeat-sequence-header=true', 'aud=true',
    '!', 'video/x-h264,profile=high,stream-format=byte-stream,alignment=au', '!', 'h264parse', 'config-interval=-1',
    '!', 'identity', 'name=OwnedHlsBytes', 'silent=false', '!', 'flvmux', 'streamable=true', '!', 'rtmp2sink',
    `location=rtmp://127.0.0.1:${session.ports.rtmp}/${session.mediaPath}?user=${session.user}&pass=${session.password}`,
    'sync=false', 'chunk-size=65536'];
}
function buildCaptureConfig(config, session) {
  if (!validNative(session.nativeIdentity) || !Number.isSafeInteger(session.owner?.pid) || session.owner.pid <= 0 ||
      !/^\d{10,22}$/.test(session.owner.startTimeTicks || '') || !samePath(session.owner.executable, process.execPath) ||
      !Number.isSafeInteger(config.adapterIndex) || config.adapterIndex < 0 || config.adapterIndex > 15 ||
      !Number.isSafeInteger(session.ports?.rtmp) || session.ports.rtmp < 1 || session.ports.rtmp > 65535 ||
      [session.mediaPath, session.user, session.password].some(value => !/^[a-f0-9]{32}$/.test(value || ''))) throw failure('An exact owned HLS capture configuration is required.');
  const profile = normalizeProfile(session.profile), native = session.nativeIdentity;
  const value = JSON.stringify({ protocol: CAPTURE_PROTOCOL, ownerPid: session.owner.pid,
    ownerExecutable: session.owner.executable, ownerStartTimeTicks: session.owner.startTimeTicks,
    nativePid: native.pid, nativeExecutable: native.executable, nativeStartTimeTicks: native.startTimeTicks,
    windowHandle: String(native.windowHandle), windowTitle: native.windowTitle, windowClass: native.windowClass,
    adapterIndex: config.adapterIndex, targetFps: profile.targetFps, bitrateMbps: profile.targetBitrateMbps, rtmpPort: session.ports.rtmp,
    mediaPath: session.mediaPath, user: session.user, password: session.password });
  if (Buffer.byteLength(value) > 16384) throw failure('The HLS capture configuration exceeded its bound.');
  return value + '\n';
}
async function processAction(action, details) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'process.ps1'), '-Action', action];
  for (const [key, value] of Object.entries(details)) args.push(`-${key}`, String(value));
  const result = await execute('powershell.exe', args, { windowsHide: true, timeout: 8000, maxBuffer: 65536 });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
async function allocatePorts() {
  const servers = [], ports = {};
  try {
    for (const kind of ['rtmp', 'hls', 'api']) {
      const server = net.createServer(); servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      ports[kind] = server.address().port;
    }
    return ports;
  } finally { await Promise.all(servers.map(server => new Promise(resolve => { if (server.listening) server.close(resolve); else resolve(); }))); }
}
function createIntegration(options = {}) {
  const appRoot = options.appRoot || path.resolve(__dirname, '../..');
  const runtimeRoot = options.runtimeRoot || path.join(appRoot, 'data/soundspectrum-hls');
  const gstreamer = path.join(appRoot, 'data/soundspectrum-gstreamer/1.26.11/bin/gst-launch-1.0.exe');
  const capture = path.join(appRoot, 'data/soundspectrum-hls/native/hls-wgc.exe');
  const relay = path.join(appRoot, 'data/soundspectrum-obs-webrtc/mediamtx/mediamtx.exe');
  const spawnImpl = options.spawnImpl || spawn, exec = options.execFileImpl || execute, fetchImpl = options.fetchImpl || fetch;
  const action = options.processAction || processAction, clock = options.clock || Date.now;
  const later = options.setTimeoutImpl || setTimeout, cancel = options.clearTimeoutImpl || clearTimeout;
  const sleep = options.sleep || ((ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(failure('HLS start was cancelled.', 409)); }
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  }));
  let current = null, lastFailure = null, cached = null;
  async function verifyCaptureBuild() {
    if (options.skipFileProbe) return;
    const source = path.join(appRoot, 'integrations/soundspectrum-hls/native/hls-wgc.cpp');
    const receipt = path.join(path.dirname(capture), 'build.json');
    for (const file of [source, capture, receipt]) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('The HLS capture build cannot be verified.');
    }
    if ((await fs.stat(receipt)).size > 32768) throw failure('The HLS capture build cannot be verified.');
    const build = JSON.parse(await fs.readFile(receipt, 'utf8'));
    const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    if (build.version !== CAPTURE_VERSION || build.protocol !== CAPTURE_PROTOCOL || build.gstreamerVersion !== '1.26.11' ||
        build.sourceSha256 !== await hash(source) || build.executableSha256 !== await hash(capture)) throw failure('Rebuild the owned HLS capture helper.');
  }
  async function config() {
    const value = options.readRuntime ? await options.readRuntime() : JSON.parse((await fs.readFile(path.join(appRoot, 'data/soundspectrum-srt-high-bitrate/runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (value.gstreamerVersion !== '1.26.11' || !samePath(value.gstreamerExecutable, gstreamer) ||
        !Number.isSafeInteger(value.adapterIndex) || value.adapterIndex < 0 || value.adapterIndex > 15) throw failure('Prepare the pinned HLS capture runtime first.');
    return { gstreamerExecutable: gstreamer, relayExecutable: relay, adapterIndex: value.adapterIndex };
  }
  async function inspect() {
    try {
      if (!cached || clock() - cached.at > 30000) {
        const value = await config();
        await verifyCaptureBuild();
        if (!options.skipFileProbe) for (const file of [gstreamer, relay]) { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('Pinned HLS runtime is unavailable.'); }
        const env = captureEnvironment(gstreamer, Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GST_|MTX_|RTSP_|RTMP_)/i.test(key))));
        const gst = await exec(gstreamer, ['--version'], { env, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
        const mtx = await exec(relay, ['--version'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
        if (!/GStreamer\s+1\.26\.11\b/.test(gst.stdout) || !/^v1\.21\.1\s*$/.test(mtx.stdout.trim())) throw failure('Pinned HLS runtime version changed.');
        const helper = JSON.parse((await exec(capture, ['--version'], { env, windowsHide: true, timeout: 10000, maxBuffer: 65536 })).stdout.trim());
        if (helper.version !== CAPTURE_VERSION || helper.protocol !== CAPTURE_PROTOCOL || helper.gstreamerVersion !== '1.26.11') throw failure('The owned HLS capture version changed.');
        const probe = path.join(path.dirname(gstreamer), 'gst-inspect-1.0.exe');
        for (const element of ['appsrc', 'd3d11convert', 'videorate', 'nvd3d11h264enc', 'h264parse', 'flvmux', 'rtmp2sink'])
          await exec(probe, [element], { env, windowsHide: true, timeout: 10000, maxBuffer: 524288 });
        cached = { at: clock(), config: value, env };
      }
      return { available: true, reason: '', profile: { ...DEFAULT_PROFILE }, bufferBytes: BUFFER_BYTES,
        bitrateRange: { min: 50, max: 600, step: 1 }, partDurationMs: 100, variant: 'low-latency-hls' };
    } catch { return { available: false, reason: 'Prepare the pinned GStreamer and MediaMTX HLS runtime.', profile: { ...DEFAULT_PROFILE }, bufferBytes: BUFFER_BYTES, bitrateRange: { min: 50, max: 600, step: 1 } }; }
  }
  function matches(session) { return current === session && !session.stopping && !session.failed && session.isCurrent(); }
  function guard(session) { if (!matches(session)) throw failure('The HLS visualizer session ended.', 409); }
  async function observe(session) {
    guard(session); const value = await session.observeWindow(); guard(session);
    const expected = session.nativeIdentity;
    if (!validNative(value) || value.pid !== expected.pid || value.startTimeTicks !== expected.startTimeTicks ||
        String(value.windowHandle) !== String(expected.windowHandle) || !samePath(value.executable, expected.executable) ||
        value.windowTitle !== expected.windowTitle || value.windowClass !== expected.windowClass || value.width !== 3840 || value.height !== 2160)
      throw failure('The HLS capture window identity changed.', 409);
  }
  async function privateRecord(name) {
    const file = path.join(runtimeRoot, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768) throw failure('The HLS ownership record cannot be verified.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  function allowedEntry(entry, epoch) {
    return entry && Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
      (([gstreamer, capture].some(file => samePath(entry.executable, file)) && entry.marker === `HlsEncoder${epoch}`) ||
       (samePath(entry.executable, relay) && entry.marker === path.join(runtimeRoot, epoch, 'mediamtx.json'))) &&
      (entry.startTimeTicks === undefined || /^\d{10,22}$/.test(entry.startTimeTicks));
  }
  async function recoverOrphans() {
    let lock; try { lock = await privateRecord('owner.lock'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (lock.version !== 1 || !/^[a-f0-9]{32}$/.test(lock.epoch || '') || !Number.isSafeInteger(lock.owner?.pid) ||
        !samePath(lock.owner?.executable, process.execPath) || !/^\d{10,22}$/.test(lock.owner?.startTimeTicks || '')) throw failure('HLS ownership recovery requires inspection.');
    const parent = await action('identity', { ProcessId: lock.owner.pid, ExpectedExecutable: lock.owner.executable, StartTimeTicks: lock.owner.startTimeTicks });
    if (!parent.exited && !parent.identityChanged) throw failure('Another process owns the HLS runtime.', 409);
    let record; try { record = await privateRecord('owner.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; record = { ...lock, processes: [] }; }
    if (record.epoch !== lock.epoch || !Array.isArray(record.processes) || record.processes.length > 2 || record.processes.some(entry => !allowedEntry(entry, lock.epoch))) throw failure('HLS helper ownership cannot be recovered safely.');
    for (const entry of [...record.processes].reverse()) {
      const identity = await action('identity', { ProcessId: entry.pid, ExpectedExecutable: entry.executable, ExpectedMarker: entry.marker, ...(entry.startTimeTicks ? { StartTimeTicks: entry.startTimeTicks } : {}) });
      if (identity.exited || identity.identityChanged) continue;
      const result = await action('terminate', { ProcessId: entry.pid, ExpectedExecutable: entry.executable, ExpectedMarker: entry.marker, StartTimeTicks: identity.startTimeTicks });
      if (!result.exited && !result.terminated) throw failure('An orphaned HLS helper could not close.');
    }
    // The validated random epoch confines cleanup to this abandoned generation.
    const abandonedDirectory = path.join(runtimeRoot, lock.epoch);
    await fs.unlink(path.join(abandonedDirectory, 'mediamtx.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(abandonedDirectory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    await fs.unlink(path.join(runtimeRoot, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(path.join(runtimeRoot, 'owner.lock'));
  }
  async function saveOwner(session) {
    await fs.writeFile(path.join(runtimeRoot, 'owner.json'), JSON.stringify({ version: 1, epoch: session.epoch, owner: session.owner,
      processes: session.processes.map(entry => ({ pid: entry.child.pid, executable: entry.executable, marker: entry.marker, ...(entry.identity ? { startTimeTicks: entry.identity.startTimeTicks } : {}) })) }));
  }
  function failSession(session, message) {
    if (session.stopping || session.failed || current !== session) return;
    session.failed = true; lastFailure = message;
    try { session.onFailure?.(failure(message, 502)); } catch {}
    void stopSession(session).catch(() => {});
  }
  function parseVideo(session, chunk) {
    if (!matches(session)) return;
    if (chunk.length > 65536) { failSession(session, 'The HLS capture status exceeded its bound.'); return; }
    const lines = (session.tail + chunk.toString()).split(/\r?\n/); session.tail = lines.pop();
    if (session.tail.length > 16384 || lines.some(line => line.length > 16384)) { failSession(session, 'The HLS capture status was invalid.'); return; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let value; try { value = JSON.parse(line); } catch { failSession(session, 'The HLS capture status was invalid.'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { failSession(session, 'The HLS capture status was invalid.'); return; }
      if (value.event === 'ready') {
        if (session.captureReady || value.version !== CAPTURE_VERSION || value.protocol !== CAPTURE_PROTOCOL || value.interval100ns !== 10000 ||
            value.width !== 3840 || value.height !== 2160 || value.targetFps !== session.profile.targetFps) { failSession(session, 'The HLS capture configuration was not verified.'); return; }
        session.captureReady = true;
      } else if (value.event === 'stats') {
        const names = ['frames', 'bytes', 'captureFrames', 'copiedFrames', 'appsrcFrames', 'encoderFrames',
          'poolDrops', 'appsrcDrops', 'videorateDrops', 'videorateDuplicates', 'ptsErrors'];
        if (!session.captureReady || names.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
            !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || (session.captureSample && value.elapsedMs <= session.captureSample.elapsedMs) ||
            value.frames < session.frames || value.bytes < session.bytes || value.captureFrames < session.captureFrames ||
            value.frames - value.videorateDuplicates > value.captureFrames || value.videorateDuplicates > value.encoderFrames || session.profile.targetFps === 120 && value.videorateDuplicates > 0 || value.ptsErrors > 0 ||
            (session.captureSample && names.some(key => value[key] < session.captureSample[key]))) { failSession(session, 'The HLS capture counters were invalid.'); return; }
        const prior = session.captureSample;
        if (prior) {
          const duration = value.elapsedMs - prior.elapsedMs;
          session.videoBitrateMbps = (value.bytes - prior.bytes) * 8 / duration / 1000;
          session.encodedFps = (value.frames - prior.frames) * 1000 / duration;
          session.captureFps = (value.captureFrames - prior.captureFrames) * 1000 / duration;
          session.duplicateFps = (value.videorateDuplicates - prior.videorateDuplicates) * 1000 / duration;
          session.videoBitrateWindowMs = duration;
          session.videoBitrateObservedAt = clock();
        }
        session.captureSample = Object.fromEntries([...names, 'elapsedMs'].map(key => [key, value[key]]));
        if (value.frames > session.frames && value.bytes > session.bytes) session.lastEncodedAt = clock();
        session.frames = value.frames; session.bytes = value.bytes; session.captureFrames = value.captureFrames;
      } else { failSession(session, 'The HLS capture helper failed.'); return; }
    }
  }
  async function launch(session, executable, args, marker, encoder) {
    guard(session);
    const child = spawnImpl(executable, args, { windowsHide: true, shell: false, cwd: path.dirname(executable), env: session.env, stdio: [encoder ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const entry = { child, executable, marker, encoder, exited: false, identity: null }; session.processes.push(entry);
    child.stdin?.on('error', () => { if (!session.stopping) failSession(session, 'The HLS capture control pipe closed.'); });
    child.stdout?.on('data', chunk => { if (encoder) parseVideo(session, chunk); });
    child.stderr?.on('data', () => {}); // Drain only. Native output can include credentials.
    child.once('exit', () => { entry.exited = true; failSession(session, 'The HLS video helper exited.'); });
    child.once('error', () => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) entry.exited = true;
      failSession(session, 'The HLS video helper could not run.');
    });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) { entry.exited = true; throw failure('An HLS helper did not start.'); }
    await saveOwner(session);
    const identity = await action('identity', { ProcessId: child.pid, ExpectedExecutable: executable, ExpectedMarker: marker });
    if (identity.exited || identity.identityChanged || identity.pid !== child.pid || !samePath(identity.executable, executable) || !/^\d{10,22}$/.test(identity.startTimeTicks || '')) throw failure('HLS helper ownership could not be verified.');
    entry.identity = identity; await saveOwner(session); guard(session);
    return entry;
  }
  function request(session, port, resource, extra = {}) {
    const authorization = port === session.ports.hls ? 'Bearer ' + session.password : 'Basic ' + Buffer.from(session.user + ':' + session.password).toString('base64');
    return fetchImpl(`http://127.0.0.1:${port}/${resource}`, { redirect: 'error', ...extra,
      headers: { Authorization: authorization, ...(extra.headers || {}) },
      signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(10000), ...(extra.signal ? [extra.signal] : [])]) });
  }
  async function playlist(session) {
    const response = await request(session, session.ports.hls, `${session.mediaPath}/index.m3u8`);
    if (!response.ok) { await response.body?.cancel(); return false; }
    const data = await boundedBody(response, 65536);
    const text = data.toString();
    if (!text.startsWith('#EXTM3U')) return false;
    if (/(?:#EXTINF|#EXT-X-PART:)/.test(text)) return true;
    const media = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
    if (!ASSET_NAME.test(media || '') || !media.endsWith('.m3u8')) return false;
    const child = await request(session, session.ports.hls, `${session.mediaPath}/${media}`);
    if (!child.ok) { await child.body?.cancel(); return false; }
    const childText = (await boundedBody(child, 65536)).toString();
    return childText.startsWith('#EXTM3U') && /(?:#EXTINF|#EXT-X-PART:)/.test(childText);
  }
  async function monitor(session) {
    if (!matches(session)) { await stopSession(session).catch(() => {}); return; }
    try {
      await observe(session);
      if (clock() - session.lastEncodedAt > 6000) throw failure('The HLS encoder stopped producing fresh video.');
    } catch { failSession(session, 'The HLS capture stopped producing fresh video.'); return; }
    session.timer = later(() => { void monitor(session); }, 2000); session.timer.unref?.();
  }
  async function start({ nativeIdentity, generation, observeWindow, isCurrent, onReady, onFailure, profile } = {}) {
    if (current) throw failure('Stop the current HLS transport before starting another.', 409);
    const selected = normalizeProfile(profile);
    if (!validNative(nativeIdentity) || !Number.isSafeInteger(generation) || generation < 1 || typeof observeWindow !== 'function' || typeof isCurrent !== 'function') throw failure('An exact current HLS visualizer session is required.', 400);
    const session = { nativeIdentity: { ...nativeIdentity }, generation, observeWindow, isCurrent, onReady, onFailure, profile: selected,
      epoch: token(), user: token(), password: token(), mediaPath: token(), processes: [], controller: new AbortController(), tail: '', bytes: 0, frames: 0,
      captureFrames: 0, captureReady: false, ready: false, failed: false };
    current = session; lastFailure = null;
    session.boot = (async () => {
      if (!(await inspect()).available) throw failure('The HLS runtime is unavailable.');
      await verifyCaptureBuild();
      session.config = { ...cached.config }; session.env = { ...cached.env, GST_DEBUG: '0' }; guard(session); await observe(session);
      await fs.mkdir(runtimeRoot, { recursive: true }); await recoverOrphans(); guard(session);
      session.owner = await action('identity', { ProcessId: process.pid, ExpectedExecutable: process.execPath });
      if (session.owner.pid !== process.pid || !/^\d{10,22}$/.test(session.owner.startTimeTicks || '') || !samePath(session.owner.executable, process.execPath)) throw failure('HLS application ownership could not be verified.');
      session.lock = await fs.open(path.join(runtimeRoot, 'owner.lock'), 'wx');
      await session.lock.writeFile(JSON.stringify({ version: 1, epoch: session.epoch, owner: session.owner })); await saveOwner(session);
      session.directory = path.join(runtimeRoot, session.epoch); await fs.mkdir(session.directory);
      session.ports = await (options.allocatePorts || allocatePorts)(); guard(session);
      const configFile = path.join(session.directory, 'mediamtx.json'); await fs.writeFile(configFile, JSON.stringify(relayConfig(session)));
      await launch(session, relay, [configFile], configFile, false);
      const relayDeadline = clock() + 15000;
      for (;;) {
        guard(session); let ready = false;
        try { const response = await request(session, session.ports.api, 'v3/config/global/get'); ready = response.ok; await response.body?.cancel(); } catch {}
        if (ready) break; if (clock() >= relayDeadline) throw failure('The private HLS relay did not become ready.'); await sleep(100, session.controller.signal);
      }
      await verifyCaptureBuild(); await observe(session);
      const encoder = await launch(session, capture, ['--owned-hls', `HlsEncoder${session.epoch}`], `HlsEncoder${session.epoch}`, true);
      encoder.child.stdin.write(buildCaptureConfig(session.config, session));
      const mediaDeadline = clock() + 30000;
      while (clock() < mediaDeadline) {
        guard(session); let ready = false; try { ready = session.captureReady && session.bytes > 0 && await playlist(session); } catch {}
        guard(session); if (ready) { session.ready = true; break; } await sleep(100, session.controller.signal);
      }
      if (!session.ready) throw failure('The HLS encoder and playlist did not become ready.');
      session.timer = later(() => { void monitor(session); }, 2000); session.timer.unref?.();
      const value = snapshot(); session.onReady?.(value); return value;
    })();
    try { return await session.boot; } catch (error) { await stopSession(session); throw error; }
  }
  function snapshot() {
    const session = current, fresh = session?.ready && clock() - session.videoBitrateObservedAt <= 6000;
    return { state: session?.stopping ? 'stopping' : session?.failed || !session && lastFailure ? 'error' : session?.ready ? 'ready' : session ? 'starting' : 'idle',
      ready: !!session?.ready && !session.stopping && !session.failed, generation: session?.generation ?? null,
      profile: { ...(session?.profile || DEFAULT_PROFILE) }, bufferBytes: BUFFER_BYTES, variant: 'low-latency-hls', playlist: 'index.m3u8',
      videoBitrateMbps: fresh ? session.videoBitrateMbps : null, videoBitrateObservedAt: fresh ? session.videoBitrateObservedAt : null,
      duplicateFps: fresh ? session.duplicateFps : null, encodedFps: fresh ? session.encodedFps : null, captureFps: fresh ? session.captureFps : null,
      videoBitrateWindowMs: fresh ? session.videoBitrateWindowMs : null,
      error: lastFailure || '' };
  }
  async function boundedBody(response, maximum) {
    const chunks = []; let length = 0;
    try { for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw failure('HLS playlist exceeded its bound.', 502); chunks.push(Buffer.from(chunk)); } }
    catch (error) { await response.body?.cancel?.().catch(() => {}); throw error; }
    return Buffer.concat(chunks, length);
  }
  async function readAsset(name, { generation, query, range, signal } = {}) {
    const session = current;
    if (!ASSET_NAME.test(name || '') || typeof name !== 'string') throw failure('Invalid HLS asset.', 400);
    if (!session?.ready || generation !== session.generation || !matches(session)) throw failure('The HLS session is no longer active.', 410);
    const suffix = assetQuery(query);
    if (range !== undefined && range !== '' && (typeof range !== 'string' || !/^bytes=\d{1,12}-\d{0,12}$/.test(range))) throw failure('Invalid HLS byte range.', 400);
    const response = await request(session, session.ports.hls, `${session.mediaPath}/${name}${suffix ? '?' + suffix : ''}`, { signal, headers: range ? { Range: range } : {} });
    if (!matches(session)) { await response.body?.cancel(); throw failure('The HLS session ended during media retrieval.', 410); }
    if (![200, 206, 304, 404, 410, 416].includes(response.status)) { await response.body?.cancel(); throw failure('The HLS media relay could not serve this request.', 502); }
    const contentType = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
    const headers = { 'content-type': contentType, 'cache-control': 'no-store' };
    for (const key of ['content-length', 'content-range', 'accept-ranges']) { const value = response.headers.get(key); if (value && /^[\w\s*/=.,-]{1,128}$/.test(value)) headers[key] = value; }
    if (name.endsWith('.m3u8')) {
      const body = await boundedBody(response, 1048576); guard(session); delete headers['content-length'];
      return { statusCode: response.status, contentType, headers, body };
    }
    return { statusCode: response.status, contentType, headers, body: response.body ? Readable.fromWeb(response.body) : Readable.from([]) };
  }
  async function stopSession(session) {
    if (session.stopPromise) return session.stopPromise;
    session.stopping = true; session.ready = false; session.controller.abort(); cancel(session.timer);
    session.stopPromise = (async () => {
      await session.boot?.catch(() => {});
      const cleanupErrors = [];
      for (const entry of [...session.processes].reverse()) if (!entry.exited) {
        try {
        if (entry.encoder && entry.child.stdin?.writable) {
          await new Promise(resolve => {
            let timer;
            const done = () => { clearTimeout(timer); entry.child.removeListener('exit', done); resolve(); };
            entry.child.once('exit', done); timer = setTimeout(done, options.gracefulStopMs ?? 4500);
            try { entry.child.stdin.end('stop\n'); } catch { done(); }
            if (entry.exited) done();
          });
        }
        if (entry.exited) continue;
        if (entry.identity) {
          const value = await action('terminate', { ProcessId: entry.child.pid, ExpectedExecutable: entry.executable, ExpectedMarker: entry.marker, StartTimeTicks: entry.identity.startTimeTicks });
          if (!value.terminated && !value.exited && !value.identityChanged) throw failure('An owned HLS helper could not close.', 502);
        } else {
          await new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); resolve(); }, timer = setTimeout(() => reject(failure('Owned HLS cleanup timed out.', 502)), 4000);
            entry.child.once('exit', done); if (!entry.child.kill()) { clearTimeout(timer); reject(failure('Owned HLS cleanup failed.', 502)); }
          });
        }
        entry.exited = true;
        } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length) throw failure('Owned HLS helpers could not all close.', 502);
      if (session.lock) {
        await session.lock.close();
        for (const name of ['owner.json', 'owner.lock']) await fs.unlink(path.join(runtimeRoot, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      if (session.directory) await fs.unlink(path.join(session.directory, 'mediamtx.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (session.directory) await fs.rmdir(session.directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      if (current === session) current = null;
      return { released: true };
    })().catch(error => { session.stopPromise = null; session.failed = true; lastFailure = 'Owned HLS cleanup needs a retry.'; throw error; });
    return session.stopPromise;
  }
  return { inspect, capability: inspect, start, stop: () => current ? stopSession(current) : Promise.resolve({ released: false }), snapshot, status: snapshot, readAsset };
}
module.exports = { createIntegration, normalizeProfile, buildPipeline, buildCaptureConfig, relayConfig, assetQuery, ASSET_NAME, BUFFER_BYTES, DEFAULT_PROFILE, CAPTURE_VERSION, CAPTURE_PROTOCOL };
