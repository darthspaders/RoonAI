'use strict';

// Explicit, bounded SRT trial only. Import/inspect never capture or open listeners.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const capture = require('../../scripts/soundspectrum-capture.cjs');
const execFileAsync = promisify(execFile);
const MAX_DURATION_MS = 600000, FRESH_MS = 6000;
// Pinned GStreamer 1.26.11 multiplies the documented kbit property by 1024.
// Stay below High level 6.1's 600,000,000-bit/s limit; never pad transport to it.
const ENCODER_BITRATE = 585937;
const SRT_PLUGIN_REVISION = 'listener-backpressure-2', SRT_PLUGIN_VERSION = '1.26.11.2';
const PROFILE = Object.freeze({ requestedBitrateMbps: 600, configuredBitrateMbps: ENCODER_BITRATE * 1024 / 1e6,
  encoderMode: 'independent-srt', width: 3840, height: 2160, fps: 60 });
const FAILURE_CODE = Symbol('independent SRT failure code');
const FAILURE_CODES = new Set(['child-exit', 'child-error', 'native-identity-lost', 'listener-lost', 'encoded-output-stale', 'send-buffer-full', 'monitor-error', 'cleanup-failed']);
const EXIT_SIGNALS = new Set(['SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2']);
const emptyDiagnostics = () => ({ failureCode: null, failureObservedAt: null, exitCode: null, signal: null });
const WAIT_STAT_KEYS = ['waitMs', 'socketState', 'sendBufferBytes', 'sendBufferMs', 'flightPackets', 'flowPackets',
  'ackTotal', 'nakTotal', 'retransTotal', 'dropTotal', 'uniqueBytes'];
const token = () => crypto.randomBytes(24).toString('base64url');
const problem = (message, statusCode = 503) => Object.assign(Error(message), { statusCode, safeMessage: true });
const validViewer = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{20,100}$/.test(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const privateIpv4 = value => typeof value === 'string' && net.isIP(value) === 4 && (value.startsWith('10.') || value.startsWith('192.168.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function senderEnvironment(config, baseEnv) {
  return { ...capture.captureEnvironment(config.gstreamerExecutable, baseEnv),
    // This overlay belongs only to the independent SRT helper. Never replace
    // the original capture/OBS runtime plugin or its shared registry.
    GST_PLUGIN_PATH_1_0: path.dirname(config.srtPluginPath),
    GST_REGISTRY_1_0: path.join(path.dirname(config.srtPluginPath), 'registry.bin'),
    GST_DEBUG: 'srt*:2', GST_DEBUG_NO_COLOR: '1' };
}
async function pluginBytes(file, limit) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit ||
      !samePath(await fs.realpath(file), file)) throw problem('The isolated SRT backpressure plugin is unavailable.');
  return fs.readFile(file);
}
async function verifyPlugin(config) {
  const bytes = await pluginBytes(config.srtPluginPath, 8 * 1024 * 1024);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== config.srtPluginSha256) throw problem('The isolated SRT backpressure plugin does not match preparation.');
}
function nativeIdentityValid(value) {
  const title = /^Rabbit Hole (G-Force|Aeon|WhiteCap) RH-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(value?.windowTitle || '');
  const executable = /^(G-Force|Aeon|WhiteCap) Standalone(?:\.x64)?\.exe$/i.exec(path.win32.basename(value?.executable || ''));
  return Number.isSafeInteger(value?.pid) && value.pid > 0 && /^\d{1,20}$/.test(String(value?.windowHandle)) &&
    BigInt(value.windowHandle) > 0n && BigInt(value.windowHandle) <= 18446744073709551615n &&
    /^\d{10,22}$/.test(String(value?.startTimeTicks)) && typeof value.windowClass === 'string' && value.windowClass &&
    !!title && !!executable && title[1].toLowerCase() === executable[1].toLowerCase();
}
function buildPipeline(config, session) {
  if (!nativeIdentityValid(session.nativeIdentity)) throw problem('An exact owned native capture identity is required.');
  return ['--gst-disable-registry-update', '-v',
    'd3d11screencapturesrc', 'capture-api=wgc', `adapter=${config.adapterIndex}`, `window-handle=${session.nativeIdentity.windowHandle}`, 'window-capture-mode=client', 'show-cursor=false',
    // Lock native source dimensions before conversion: no desktop or upscaling.
    '!', 'video/x-raw(memory:D3D11Memory),width=3840,height=2160,framerate=60/1',
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=2', 'max-size-bytes=0', 'max-size-time=0',
    '!', 'd3d11convert', `adapter=${config.adapterIndex}`,
    '!', 'video/x-raw(memory:D3D11Memory),format=NV12,width=3840,height=2160,framerate=60/1,pixel-aspect-ratio=1/1,colorimetry=bt709',
    '!', 'nvd3d11h264enc', 'name=OwnedSrtEncoder', 'preset=p5', 'tune=low-latency', 'rc-mode=cbr', `bitrate=${ENCODER_BITRATE}`, `max-bitrate=${ENCODER_BITRATE}`,
    'gop-size=60', 'bframes=0', 'rc-lookahead=0', 'multi-pass=disabled', 'zerolatency=true', 'repeat-sequence-header=true', 'aud=true',
    '!', 'video/x-h264,profile=high,stream-format=byte-stream,alignment=au',
    '!', 'h264parse', 'name=OwnedSrtParser', 'config-interval=-1',
    '!', 'video/x-h264,profile=high,stream-format=byte-stream,alignment=au',
    '!', 'identity', 'name=OwnedVideoBytes', 'silent=false',
    '!', 'mpegtsmux', 'alignment=7',
    '!', 'srtsink', `uri=srt://${config.lanAddress}:${config.ports.srt}?mode=listener&sndbuf=${config.sendBufferBytes}&fc=32768&maxbw=85000000&payloadsize=1316&enforcedencryption=true`,
    'latency=250', `passphrase=${session.passphrase}`, 'pbkeylen=16', 'wait-for-connection=false', 'auto-reconnect=false', 'sync=false', 'async=false'];
}
async function checkPorts(config, { createSocket = () => dgram.createSocket('udp4') } = {}) {
  const handles = [];
  try {
    const socket = createSocket(); handles.push(socket);
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(config.ports.srt, config.lanAddress, resolve); });
  } catch { throw problem('An independent SRT trial port is already in use.'); }
  finally { await Promise.all(handles.map(handle => new Promise(resolve => { try { handle.close(resolve); } catch { resolve(); } }))); }
}
async function processAction(action, details) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'process.ps1'), '-Action', action];
  for (const [key, value] of Object.entries(details)) args.push(`-${key}`, String(value));
  const result = await execFileAsync('powershell.exe', args, { windowsHide: true, timeout: 8000, maxBuffer: 65536, encoding: 'utf8' });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
function createIntegration(options = {}) {
  const appRoot = path.join(__dirname, '..', '..'), runtimeRoot = options.runtimeRoot || path.join(appRoot, 'data', 'soundspectrum-srt-high-bitrate');
  const allowed = options.allowedExecutables || {
    gstreamer: path.join(appRoot, 'data', 'soundspectrum-gstreamer', '1.26.11', 'bin', 'gst-launch-1.0.exe') };
  const spawnImpl = options.spawnImpl || spawn, action = options.processAction || processAction, clock = options.clock || Date.now;
  const listenerAction = options.listenerAction || processAction, portCheck = options.checkPorts || checkPorts;
  const later = options.setTimeoutImpl || setTimeout, cancelTimer = options.clearTimeoutImpl || clearTimeout;
  const onDiagnostic = options.onDiagnostic || (entry => console.warn(`[soundspectrum-srt-sender] ${JSON.stringify(entry)}`));
  const sleep = options.sleep || ((ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(problem('The independent SRT trial was cancelled.')); }
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  }));
  let current = null, lastFailure = false, lastDiagnostics = emptyDiagnostics();
  function diagnostic(session, event, details = {}) {
    // Private, bounded numeric observations only. Native stderr and connection
    // capabilities never enter the persistent log or browser snapshots.
    const at = clock(), age = at - session.lastEncodedAt;
    try { onDiagnostic({ at, event, generation: session.generation, targetMbps: 600,
      encodedFrames: session.encodedFrames, encodedBytes: session.encodedBytes,
      maximumAccessUnitBytes: session.maximumAccessUnitBytes,
      encodedAgeMs: Number.isFinite(age) && age >= 0 ? age : null, ...details }); } catch {}
  }
  async function readConfig() {
    const value = JSON.parse((await fs.readFile(path.join(runtimeRoot, 'runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (!exactKeys(value, ['version', 'gstreamerVersion', 'gstreamerExecutable', 'lanAddress', 'ports', 'adapterIndex', 'adapterLuid', 'sendBufferBytes']) ||
        value.version !== 2 || value.gstreamerVersion !== '1.26.11' || !privateIpv4(value.lanAddress) || value.sendBufferBytes !== 33554432 ||
        !exactKeys(value.ports, ['srt']) || !Number.isSafeInteger(value.ports.srt) || value.ports.srt < 1024 || value.ports.srt > 65535 ||
        !Number.isSafeInteger(value.adapterIndex) || value.adapterIndex < 0 || value.adapterIndex > 16 ||
        typeof value.adapterLuid !== 'string' || !/^-?\d{1,20}$/.test(value.adapterLuid) || !samePath(value.gstreamerExecutable, allowed.gstreamer)) throw problem('Prepare the isolated 600 Mbps SRT runtime first.');
    for (const [file, expected] of [[value.gstreamerExecutable, allowed.gstreamer]]) {
      if (!(await fs.stat(file)).isFile() || !samePath(await fs.realpath(file), expected)) throw problem('The pinned independent SRT runtime is unavailable.');
    }
    const pluginRoot = path.join(runtimeRoot, 'patched-plugin');
    const pin = JSON.parse((await pluginBytes(path.join(pluginRoot, 'backpressure-plugin.json'), 2048)).toString('utf8'));
    if (!exactKeys(pin, ['version', 'revision', 'sha256']) || pin.version !== 1 || pin.revision !== SRT_PLUGIN_REVISION ||
        typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw problem('Prepare the isolated SRT backpressure plugin first.');
    const config = { ...value, srtPluginPath: path.join(pluginRoot, 'gstsrt.dll'), srtPluginSha256: pin.sha256 };
    await verifyPlugin(config);
    return config;
  }
  async function inspect() {
    try { await readConfig(); return { available: true, videoProfile: { ...PROFILE } }; }
    catch { return { available: false, videoProfile: { ...PROFILE }, reason: 'Prepare the isolated 600 Mbps SRT runtime first.' }; }
  }
  async function probeRuntime(config, signal) {
    if (options.probeRuntime) return options.probeRuntime(config, signal);
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GST_|MTX_|RTSP_)/i.test(key)));
    const env = senderEnvironment(config, baseEnv);
    for (const element of ['d3d11screencapturesrc', 'd3d11convert', 'nvd3d11h264enc', 'h264parse', 'identity', 'mpegtsmux', 'srtsink']) {
      const result = await execFileAsync(path.join(path.dirname(config.gstreamerExecutable), 'gst-inspect-1.0.exe'), [element],
        { env, windowsHide: true, signal, timeout: 8000, maxBuffer: 200000, encoding: 'utf8' });
      if (!/Version\s+1\.26\.11\b/.test(result.stdout) || element === 'd3d11screencapturesrc' && !result.stdout.includes('window-capture-mode') ||
          element === 'nvd3d11h264enc' && !new RegExp('adapter-luid[\\s\\S]{0,300}Default: ' + config.adapterLuid + '(?:\\s|$)').test(result.stdout)) {
        throw problem('The pinned independent capture or NVIDIA encoder does not match preparation.');
      }
      if (element === 'srtsink' && (!new RegExp('Version\\s+' + SRT_PLUGIN_VERSION.replaceAll('.', '\\.') + '(?:\\s|$)').test(result.stdout) ||
          !samePath(/^\s*Filename\s+(.+)$/m.exec(result.stdout)?.[1]?.trim(), config.srtPluginPath))) {
        throw problem('The independent SRT sender did not load its backpressure repair.');
      }
    }
  }
  const matches = session => current === session && !session.controller.signal.aborted && session.isCurrent() === true && clock() < session.expiresAt;
  function guard(session) { if (!matches(session)) throw problem('The independent SRT trial generation ended.', 409); }
  async function observeNative(session) {
    guard(session); const value = await session.observeWindow(); guard(session); const expected = session.nativeIdentity;
    if (!value || value.pid !== expected.pid || String(value.windowHandle) !== String(expected.windowHandle) ||
        value.windowTitle !== expected.windowTitle || value.windowClass !== expected.windowClass || value.width !== PROFILE.width || value.height !== PROFILE.height) {
      throw Object.assign(problem('The independent SRT trial requires the same actual 3840 by 2160 native window.'), { [FAILURE_CODE]: 'native-identity-lost' });
    }
    return value;
  }
  async function saveOwner(session) {
    await fs.writeFile(path.join(runtimeRoot, 'owner.json'), JSON.stringify({ version: 1, owner: session.owner, epoch: session.key,
      processes: session.processes.map(entry => entry.identity || { pid: entry.child.pid, executable: entry.executable, pendingIdentity: true }) }));
  }
  function parseOutput(session, chunk) {
    session.outputTail = (session.outputTail + chunk.toString()).slice(-32768);
    const lines = session.outputTail.split(/\r?\n/); session.outputTail = lines.pop();
    for (const line of lines) {
      if (line.includes('GstIdentity:OwnedVideoBytes') && line.includes('last-message = chain')) {
        const count = Number(/\((\d+) bytes/.exec(line)?.[1]);
        if (Number.isSafeInteger(count) && count > 0 && count < 64 * 1024 * 1024 && Number.isSafeInteger(session.encodedBytes + count)) {
          session.encodedBytes += count; session.encodedFrames++; session.lastEncodedAt = clock();
          session.maximumAccessUnitBytes = Math.max(session.maximumAccessUnitBytes, count);
        }
      }
      if (line.includes('OwnedSrtParser') && line.includes('GstPad:src') && line.includes('video/x-h264')) {
      const profile = /\bprofile=\(string\)([a-z0-9-]+)/.exec(line)?.[1], level = /\blevel=\(string\)(\d(?:\.\d)?)/.exec(line)?.[1];
      const width = Number(/\bwidth=\(int\)(\d+)/.exec(line)?.[1]), height = Number(/\bheight=\(int\)(\d+)/.exec(line)?.[1]);
      if (profile === 'high' && /^(?:[1-5](?:\.[0-9])?|6(?:\.[12])?)$/.test(level || '') && width === 3840 && height === 2160) {
        session.observedCodec = { profile, level, observedAt: clock(), measurement: 'gstreamer-h264parse-caps' };
      }
      }
    }
  }
  function parseSenderWarnings(session, chunk) {
    if (session.stopping || !matches(session)) return;
    // Keep only a bounded partial line in memory. Never publish native stderr,
    // which can include the connection key, addresses and process arguments.
    const lines = (session.stderrTail + chunk.toString()).slice(-8192).split(/\r?\n/);
    session.stderrTail = lines.pop();
    for (const line of lines) {
      const wait = /RH_SRT_WAIT (\{[^\r\n]{1,1024}\})\s*$/.exec(line);
      if (wait && session.senderWaitLogs < 120) {
        let observation;
        try { observation = JSON.parse(wait[1]); } catch {}
        if (exactKeys(observation, [...WAIT_STAT_KEYS, 'statsAvailable']) && typeof observation.statsAvailable === 'boolean' &&
            WAIT_STAT_KEYS.every(key => Number.isSafeInteger(observation[key]) && observation[key] >= 0)) {
          session.senderWaitLogs++;
          diagnostic(session, 'sender-wait', observation);
        }
      }
      if (line.includes('gst_srt_object_write_to_callers:') && /\bDropping caller \d+: /.test(line) && session.callerDropLogs < 8) {
        session.callerDropLogs++;
        diagnostic(session, 'caller-dropped', { reason:
          /Non-blocking call failure: no buffer available for sending\s*$/.test(line) ? 'send-buffer-full' :
          /socket failed during writable wait\s*$/.test(line) ? 'socket-error' : 'other-send-error' });
      }
      if (line.includes('gst_srt_object_write_to_callers:') &&
          /\bDropping caller \d+: Non-blocking call failure: no buffer available for sending\s*$/.test(line)) {
        // The listener has already disconnected its reader even though the
        // encoder is still producing bytes. Do not report a healthy trial.
        markFailure(session, 'send-buffer-full');
        void stopSession(session).catch(() => {});
        break;
      }
    }
  }
  async function launch(session, executable, args, isEncoder) {
    guard(session);
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MTX_|RTSP_|GST_)/i.test(key)));
    if (isEncoder) { await verifyPlugin(session.config); guard(session); }
    const env = isEncoder ? senderEnvironment(session.config, baseEnv) : baseEnv;
    const child = spawnImpl(executable, args, { cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', isEncoder ? 'pipe' : 'ignore', 'pipe'], shell: false, env });
    const entry = { child, executable, identity: null, exited: false }; session.processes.push(entry);
    child.stdout?.on('data', chunk => parseOutput(session, chunk));
    child.stderr?.on('data', chunk => parseSenderWarnings(session, chunk));
    child.once('error', () => { if (!session.stopping) { markFailure(session, 'child-error'); void stopSession(session).catch(() => {}); } });
    child.once('exit', (exitCode, signal) => { entry.exited = true; if (!session.stopping) { markFailure(session, 'child-exit', { exitCode, signal }); void stopSession(session).catch(() => {}); } });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw problem('An independent SRT helper did not start.');
    await saveOwner(session);
    const identity = await action('identity', { ProcessId: child.pid, ExpectedExecutable: executable });
    if (identity?.exited) entry.exited = true;
    if (!identity || identity.exited || identity.pid !== child.pid || !samePath(identity.executable, executable) || !/^\d{10,22}$/.test(String(identity.startTimeTicks))) throw problem('The independent helper ownership could not be verified.');
    entry.identity = identity; await saveOwner(session); guard(session);
  }
  function markFailure(session, failureCode, exit = {}) {
    if (!session.diagnostics.failureCode) {
      const now = clock();
      session.diagnostics = { failureCode: FAILURE_CODES.has(failureCode) ? failureCode : 'monitor-error',
        failureObservedAt: Number.isSafeInteger(now) && now > 0 ? now : null,
        exitCode: failureCode === 'child-exit' && Number.isSafeInteger(exit.exitCode) && exit.exitCode >= -2147483648 && exit.exitCode <= 4294967295 ? exit.exitCode : null,
        signal: failureCode === 'child-exit' && EXIT_SIGNALS.has(exit.signal) ? exit.signal : null };
    }
    if (session.failed) return;
    session.failed = true;
    diagnostic(session, 'failure', { failureCode: session.diagnostics.failureCode });
    try { session.onFailure?.(problem('The independent SRT encoder stopped. Stop this trial before trying again.', 502)); } catch {}
  }
  async function verifyListener(session) {
    guard(session); const entry = session.processes[0];
    const value = await listenerAction('listener', { ProcessId: entry.identity.pid, ExpectedExecutable: entry.identity.executable,
      StartTimeTicks: entry.identity.startTimeTicks, LocalAddress: session.config.lanAddress, LocalPort: session.config.ports.srt });
    guard(session); return value?.listening === true;
  }
  async function monitor(session) {
    if (!matches(session)) { void stopSession(session).catch(() => {}); return; }
    try {
      await observeNative(session); if (!await verifyListener(session)) throw Object.assign(problem('The independent SRT listener stopped.'), { [FAILURE_CODE]: 'listener-lost' }); guard(session);
      if (session.encodedBytes > session.lastBytes) {
        const now = clock(), windowMs = now - session.lastBytesAt;
        if (windowMs > 0) { session.videoBitrateMbps = (session.encodedBytes - session.lastBytes) * 8 / windowMs / 1000;
          session.videoBitrateObservedAt = now; session.videoBitrateWindowMs = windowMs; }
        session.lastBytes = session.encodedBytes; session.lastBytesAt = now;
      }
      if (clock() - session.lastEncodedAt > FRESH_MS) throw Object.assign(problem('The independent encoder stopped producing video.'), { [FAILURE_CODE]: 'encoded-output-stale' });
      if (clock() >= session.nextDiagnosticAt) {
        session.nextDiagnosticAt = clock() + 15000;
        diagnostic(session, 'encoded-progress', { encodedMbps: Number.isFinite(session.videoBitrateMbps) ? session.videoBitrateMbps : null });
      }
    } catch (error) { if (matches(session)) markFailure(session, error?.[FAILURE_CODE] || 'monitor-error'); await stopSession(session).catch(() => {}); return; }
    if (matches(session)) { session.timer = later(() => monitor(session), Math.min(2000, Math.max(1, session.expiresAt - clock()))); session.timer.unref?.(); }
    else await stopSession(session).catch(() => {});
  }
  async function start({ viewerId, generation, nativeIdentity, observeWindow, isCurrent, expiresAt, onFailure, forbiddenPorts = [], lanAddress }) {
    if (current) throw problem('Stop the independent SRT trial before starting another.', 409);
    if (!validViewer(viewerId) || !Number.isSafeInteger(generation) || generation < 1 || !nativeIdentityValid(nativeIdentity) ||
        typeof observeWindow !== 'function' || typeof isCurrent !== 'function' || !Number.isSafeInteger(expiresAt) || expiresAt <= clock() || expiresAt > clock() + MAX_DURATION_MS) throw problem('An exact bounded independent SRT trial is required.', 400);
    const session = { viewerId, generation, nativeIdentity: { ...nativeIdentity }, observeWindow, isCurrent, expiresAt, onFailure, controller: new AbortController(),
      key: token(), passphrase: crypto.randomBytes(16).toString('hex'),
      processes: [], ready: false, failed: false, diagnostics: emptyDiagnostics(), outputTail: '', stderrTail: '', encodedBytes: 0, encodedFrames: 0,
      maximumAccessUnitBytes: 0, callerDropLogs: 0, senderWaitLogs: 0, nextDiagnosticAt: clock() + 15000 };
    current = session; lastFailure = false; lastDiagnostics = emptyDiagnostics();
    // A fixed deadline also aborts setup; ordinary polling never extends it.
    session.expiryTimer = later(() => stopSession(session).catch(() => {}), Math.max(1, expiresAt - clock())); session.expiryTimer.unref?.();
    session.boot = (async () => {
      session.config = await readConfig(); guard(session); await observeNative(session);
      if (!Array.isArray(forbiddenPorts) || Object.values(session.config.ports).some(port => forbiddenPorts.includes(port)) ||
          lanAddress !== undefined && session.config.lanAddress !== lanAddress) throw problem('The independent SRT listeners conflict with the existing transport.');
      await probeRuntime(session.config, session.controller.signal); guard(session);
      try { session.lock = await fs.open(path.join(runtimeRoot, 'owner.lock'), 'wx'); }
      catch { throw problem('The independent SRT runtime already has an owner. Inspect its private ownership record.'); }
      session.owner = await action('identity', { ProcessId: process.pid, ExpectedExecutable: process.execPath });
      if (session.owner?.pid !== process.pid || !/^\d{10,22}$/.test(String(session.owner?.startTimeTicks)) || !samePath(session.owner.executable, process.execPath)) throw problem('Rabbit Hole ownership could not be verified.');
      await session.lock.writeFile(JSON.stringify({ owner: session.owner, epoch: session.key })); await saveOwner(session); guard(session);
      await portCheck(session.config); guard(session);
      const startupDeadline = Math.min(session.expiresAt, clock() + 30000);
      await observeNative(session);
      await launch(session, session.config.gstreamerExecutable, buildPipeline(session.config, session), true);
      while (clock() < startupDeadline) {
        guard(session); let listening = false; try { listening = await verifyListener(session); } catch {} guard(session);
        if (listening && session.encodedBytes > 0 && session.observedCodec) { session.lastBytes = session.encodedBytes; session.lastBytesAt = clock(); session.ready = true; break; }
        await sleep(100, session.controller.signal);
      }
      if (!session.ready) throw problem('The independent H.264 encoder and owned SRT listener did not become ready.');
      guard(session); session.timer = later(() => monitor(session), Math.min(2000, Math.max(1, expiresAt - clock()))); session.timer.unref?.();
      const query = new URLSearchParams({ mode: 'caller', latency: '250', pbkeylen: '16', passphrase: session.passphrase });
      return { transport: 'srt', generation, client: 'larix-player', latencyUnit: 'milliseconds', requestedLatencyMs: 250,
        url: `srt://${session.config.lanAddress}:${session.config.ports.srt}?${query}`, videoProfile: videoProfile(session) };
    })();
    try { return await session.boot; }
    catch (error) { await stopSession(session); throw error; }
  }
  function videoProfile(session) {
    const fresh = session?.ready && session.videoBitrateObservedAt !== undefined && clock() >= session.videoBitrateObservedAt && clock() - session.videoBitrateObservedAt <= FRESH_MS;
    return { ...PROFILE, videoBitrateMbps: fresh ? session.videoBitrateMbps : null, videoBitrateObservedAt: fresh ? session.videoBitrateObservedAt : null,
      videoBitrateWindowMs: fresh ? session.videoBitrateWindowMs : null, observedCodec: session?.ready && session.observedCodec ? { ...session.observedCodec } : null };
  }
  function snapshot() {
    const session = current;
    return { state: session?.failed || !session && lastFailure ? 'error' : session?.stopping ? 'stopping' : session?.ready ? 'ready' : session ? 'starting' : 'idle',
      videoProfile: videoProfile(session), readers: null, observedAt: null, stats: [], diagnostics: { ...(session?.diagnostics || lastDiagnostics) } };
  }
  async function stopSession(session) {
    if (session.stopPromise) return session.stopPromise;
    session.stopping = true; session.controller.abort(); cancelTimer(session.timer); cancelTimer(session.expiryTimer); session.ready = false;
    session.stopPromise = (async () => {
      await session.boot?.catch(() => {});
      let failed = false;
      for (const entry of [...session.processes].reverse()) if (!entry.exited) {
        try {
          if (entry.identity) {
            const result = await action('terminate', { ProcessId: entry.identity.pid, ExpectedExecutable: entry.identity.executable, StartTimeTicks: entry.identity.startTimeTicks });
            if (result?.terminated !== true && result?.exited !== true) throw problem('The owned independent helper did not close.');
            entry.exited = true;
          } else {
            await new Promise((resolve, reject) => {
              const done = () => { clearTimeout(timer); resolve(); }, timer = setTimeout(() => { entry.child.removeListener('exit', done); reject(problem('The spawned independent helper did not exit.')); }, 3000);
              entry.child.once('exit', done); try { if (!entry.child.kill()) { clearTimeout(timer); reject(problem('The spawned independent helper could not close.')); } }
              catch (error) { clearTimeout(timer); reject(error); }
            }); entry.exited = true;
          }
        } catch { failed = true; }
      }
      if (failed) { markFailure(session, 'cleanup-failed'); session.stopPromise = null; throw problem('An owned independent SRT helper could not close. Its ownership record was preserved.'); }
      if (session.lock) { await session.lock.close().catch(() => {}); await fs.unlink(path.join(runtimeRoot, 'owner.lock')).catch(() => {}); await fs.unlink(path.join(runtimeRoot, 'owner.json')).catch(() => {}); }
      if (current === session) { current = null; lastFailure = session.failed; lastDiagnostics = { ...session.diagnostics }; }
      return { released: true };
    })();
    return session.stopPromise;
  }
  async function stop({ viewerId, generation } = {}) {
    if (!current) return { released: false };
    if (viewerId !== current.viewerId || generation !== current.generation) return { released: false };
    return stopSession(current);
  }
  return { inspect, start, stop, snapshot };
}
module.exports = { createIntegration, PROFILE, ENCODER_BITRATE, buildPipeline, checkPorts, senderEnvironment, SRT_PLUGIN_REVISION };
