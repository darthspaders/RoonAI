'use strict';

// Optional video transport. Import/inspect never start, probe, or capture anything.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const WebSocket = require('ws');
const execFileAsync = promisify(execFile);
const PROFILE = Object.freeze({ id: '1080p60', nativeWindowMode: 'windowed', width: 1920, height: 1080, targetFps: 60,
  format: 'H264', encoder: 'obs_nvenc_h264_tex', targetBitrateMbps: 25, bitDepth: 8, chromaSubsampling: '4:2:0',
  colorSpace: 'Rec.709', range: 'limited', measurement: 'configured-obs-profile' });
const PROFILES = Object.freeze({
  '1080p60': PROFILE,
  '4k60': Object.freeze({ ...PROFILE, id: '4k60', nativeWindowMode: 'borderless-fullscreen', width: 3840, height: 2160, targetBitrateMbps: 80 }),
  '4k60-60': Object.freeze({ ...PROFILE, id: '4k60-60', nativeWindowMode: 'borderless-fullscreen', width: 3840, height: 2160, targetBitrateMbps: 60 })
});
const validViewer = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{20,100}$/.test(value);
const validToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
const OBS_REQUEST_STAGES = Object.freeze({ GetVersion: 'obs-version', GetInputList: 'obs-inputs', GetSpecialInputs: 'obs-audio-inputs',
  GetVideoSettings: 'obs-video-settings', GetSceneList: 'obs-scenes', CreateInput: 'obs-create-input',
  GetInputPropertiesListPropertyItems: 'obs-window-selectors', SetInputSettings: 'obs-set-input', GetInputSettings: 'obs-check-input',
  SetSceneItemTransform: 'obs-set-transform', SetSceneItemEnabled: 'obs-enable-input', SetCurrentProgramScene: 'obs-program-scene',
  StartStream: 'obs-start-stream', GetSceneItemTransform: 'obs-source-geometry' });
const STARTUP_STAGES = new Set(['runtime', 'native-window', 'ownership', 'ports', 'profile', 'relay-launch', 'obs-launch',
  'obs-connect', 'publisher', ...Object.values(OBS_REQUEST_STAGES)]);
const token = () => crypto.randomBytes(24).toString('base64url');
const problem = (message, statusCode = 409) => Object.assign(Error(message), { statusCode, safeMessage: true });
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, file) => { const rel = path.relative(root, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const boundedText = (value, max = 256 * 1024) => typeof value === 'string' && Buffer.byteLength(value) <= max;
const OWNER_BUSY = 'The isolated video transport already has an owner. Inspect its private owner record before retrying.';
const MAX_OWNER_BYTES = 64 * 1024;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const ownerStamp = stat => [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs, stat.size].join(':');
const sameOwnerSnapshot = (a, b) => a.stamp === b.stamp && a.bytes.equals(b.bytes);
function processStatus(pid) {
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
}
async function ownerSnapshot(file, io) {
  const before = await io.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_OWNER_BYTES)) throw problem(OWNER_BUSY);
  const handle = await io.open(file, 'r');
  try {
    if (ownerStamp(await handle.stat({ bigint: true })) !== ownerStamp(before)) throw problem(OWNER_BUSY);
    const bytes = Buffer.alloc(MAX_OWNER_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break; size += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await io.lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || ownerStamp(after) !== ownerStamp(before) ||
        ownerStamp(current) !== ownerStamp(before) || size !== Number(before.size)) throw problem(OWNER_BUSY);
    return { stamp: ownerStamp(before), bytes: bytes.subarray(0, size) };
  } finally { await handle.close(); }
}
function completeOwnership(lock, record, config) {
  const identity = value => exactKeys(value, ['pid', 'executable', 'startTimeTicks']) && validPid(value.pid) &&
    typeof value.executable === 'string' && value.executable.length <= 4096 && !/[\0\r\n]/.test(value.executable) &&
    (path.isAbsolute(value.executable) || path.win32.isAbsolute(value.executable)) &&
    typeof value.startTimeTicks === 'string' && /^\d{10,22}$/.test(value.startTimeTicks);
  if (!exactKeys(lock, ['owner', 'epoch']) || !exactKeys(record, ['version', 'owner', 'processes', 'epoch']) ||
      record.version !== 1 || !validToken(lock.epoch) || lock.epoch !== record.epoch || !identity(lock.owner) || !identity(record.owner) ||
      lock.owner.pid !== record.owner.pid || lock.owner.startTimeTicks !== record.owner.startTimeTicks ||
      !samePath(lock.owner.executable, record.owner.executable) || !samePath(record.owner.executable, process.execPath) ||
      !Array.isArray(record.processes) || record.processes.length !== 2) return false;
  const pids = new Set([record.owner.pid]), expected = new Set([path.resolve(config.obsExecutable).toLowerCase(), path.resolve(config.relayExecutable).toLowerCase()]);
  for (const child of record.processes) {
    if (!identity(child) || pids.has(child.pid) || !expected.delete(path.resolve(child.executable).toLowerCase())) return false;
    pids.add(child.pid);
  }
  return expected.size === 0;
}
const encodeWindowPart = value => value.replace(/#/g, '#22').replace(/:/g, '#3A');
const correlatedNativeProduct = identity => {
  if (typeof identity?.windowTitle !== 'string' || typeof identity?.executable !== 'string') return false;
  const title = /^Rabbit Hole (G-Force|Aeon|WhiteCap) RH-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(identity?.windowTitle || '');
  const executable = /^(G-Force|Aeon|WhiteCap) Standalone(?:\.x64)?\.exe$/i.exec(path.win32.basename(identity?.executable || ''));
  // A unique title for one product must not authorize capturing another product.
  return Boolean(title && executable && title[1].toLowerCase() === executable[1].toLowerCase());
};
const privateIpv4 = value => net.isIP(value || '') === 4 && (value.startsWith('192.168.') || value.startsWith('10.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value));
const SRT_STAT_FIELDS = Object.freeze(['bytesSent', 'packetsSent', 'packetsRetrans', 'packetsSendLoss', 'packetsSendDrop',
  'outboundFramesDiscarded', 'mbpsSendRate', 'msRTT', 'msSendBuf', 'msSendTsbPdDelay', 'bytesAvailSendBuf']);
function srtConfiguration(value, ports) {
  if (value === undefined) return { enabled: false };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['enabled', 'port', 'latencyMs'].includes(key)) || typeof value.enabled !== 'boolean' ||
      value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || Object.values(ports).includes(value.port)) ||
      value.latencyMs !== undefined && value.latencyMs !== 250 || value.enabled && (value.port === undefined || value.latencyMs === undefined)) {
    throw problem('The isolated SRT experiment configuration is invalid.');
  }
  return value.enabled ? { enabled: true, port: value.port, latencyMs: value.latencyMs } : { enabled: false };
}
function srtSnapshot(config, session, now) {
  const enabled = config?.srtExperiment?.enabled === true;
  const ready = enabled && session?.ready === true && session.srtReady === true && !session.srtError;
  const measured = ready && session.srtObservedAt !== undefined && now >= session.srtObservedAt && now - session.srtObservedAt <= 6000;
  return { enabled, available: enabled, requestedLatencyMs: enabled ? config.srtExperiment.latencyMs : null,
    state: !enabled ? 'disabled' : session?.srtError ? 'error' : session?.srtChanging ? 'changing' : ready ? 'ready' : session && !session.ready ? 'starting' : 'idle',
    readers: measured ? session.srtStats.length : null, observedAt: ready ? session.srtObservedAt ?? null : null,
    stats: measured ? session.srtStats.map(value => ({ ...value })) : [] };
}
async function responseText(response, limit = 256 * 1024) {
  if (response.body === null) return '';
  const reader = response.body?.getReader?.();
  if (!reader) throw problem('The local relay did not return a bounded response stream.');
  const chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw problem('The local relay response is too large.'); chunks.push(Buffer.from(value)); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

class ObsClient {
  constructor({ port, password, socketImpl = WebSocket, signal }) { this.port = port; this.password = password; this.socketImpl = socketImpl; this.signal = signal; this.pending = new Map(); this.socket = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.socket = new this.socketImpl(`ws://127.0.0.1:${this.port}`, { maxPayload: 1024 * 1024, handshakeTimeout: 2000 });
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); this.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(this); };
      const abort = () => { this.close(); finish(problem('OBS startup was cancelled.')); };
      const timer = setTimeout(() => { this.close(); finish(problem('OBS control timed out.')); }, 4000);
      this.signal?.addEventListener('abort', abort, { once: true });
      if (this.signal?.aborted) return abort();
      ws.on('error', () => finish(problem('OBS control is not available.')));
      ws.on('close', () => { finish(problem('OBS control closed.')); for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(problem('OBS control closed.')); } this.pending.clear(); });
      ws.on('message', data => {
        let message; try { message = JSON.parse(String(data)); } catch { return; }
        if (message.op === 0) {
          if (message.d?.rpcVersion !== 1 || !message.d?.authentication) { this.close(); return finish(problem('The isolated OBS control identity is invalid.')); }
          const { salt, challenge } = message.d.authentication;
          if (!boundedText(salt, 256) || !boundedText(challenge, 256)) { this.close(); return finish(problem('The OBS authentication challenge is invalid.')); }
          const secret = crypto.createHash('sha256').update(this.password + salt).digest('base64');
          const authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
          ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication, eventSubscriptions: 0 } }));
        } else if (message.op === 2) finish();
        else if (message.op === 7) {
          const entry = this.pending.get(message.d?.requestId); if (!entry) return;
          this.pending.delete(message.d.requestId); clearTimeout(entry.timer);
          if (message.d.requestStatus?.result === true) entry.resolve(message.d.responseData || {});
          else {
            const error = problem('An isolated OBS configuration request failed.');
            if (Object.hasOwn(OBS_REQUEST_STAGES, entry.requestType)) error.obsRequestType = entry.requestType;
            const code = message.d.requestStatus?.code;
            if (Number.isInteger(code) && code >= 0 && code <= 10000) error.obsStatusCode = code;
            entry.reject(error);
          }
        }
      });
    });
  }
  request(requestType, requestData = {}, timeoutMs = 5000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.signal?.aborted || this.pending.size >= 16) return Promise.reject(problem('OBS control is unavailable.'));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(problem('The OBS request deadline is invalid.'));
    return new Promise((resolve, reject) => {
      const requestId = token(), timer = setTimeout(() => { this.pending.delete(requestId); reject(problem('OBS request timed out.')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, requestType });
      try { this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })); }
      catch { this.pending.delete(requestId); clearTimeout(timer); reject(problem('OBS request could not be sent.')); }
    });
  }
  close() { try { this.socket?.terminate(); } catch {} }
}

async function processAction(action, details) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'process.ps1'), '-Action', action];
  for (const [key, value] of Object.entries(details)) args.push(`-${key}`, String(value));
  const result = await execFileAsync('powershell.exe', args, { windowsHide: true, timeout: 8000, maxBuffer: 65536, encoding: 'utf8' });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
async function checkPorts(config, { createServer = () => net.createServer(), createSocket = () => dgram.createSocket('udp4') } = {}) {
  const handles = [];
  try {
    for (const port of [config.ports.obs, config.ports.http, config.ports.api]) {
      const server = createServer(); handles.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
    }
    const udp = createSocket(); handles.push(udp);
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(config.ports.udp, '0.0.0.0', resolve); });
  } catch { throw problem('An isolated visualizer transport port is already in use.'); }
  finally { await Promise.all(handles.map(handle => new Promise(resolve => { try { handle.close(resolve); } catch { resolve(); } }))); }
}
async function checkSrtPort(config, { createSocket = () => dgram.createSocket('udp4') } = {}) {
  const socket = createSocket();
  try { await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(config.srtExperiment.port, config.lanAddress, resolve); }); }
  catch { throw problem('The isolated SRT experiment port is already in use.'); }
  finally { await new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }); }
}
function relayConfig(config, session) {
  const srt = config.srtExperiment?.enabled === true;
  return { logLevel: 'warn', logDestinations: ['file'], logFile: session.relayLog, readTimeout: '5s', writeTimeout: '5s', writeQueueSize: 512,
    api: true, apiAddress: `127.0.0.1:${config.ports.api}`, apiAllowOrigins: [], metrics: false, pprof: false, playback: false,
    // Preparing the optional reader never opens a listener during ordinary WebRTC.
    rtsp: false, rtmp: false, hls: false, srt: false, ...(srt ? { srtAddress: `${config.lanAddress}:${config.srtExperiment.port}` } : {}), moq: false,
    webrtc: true, webrtcAddress: `127.0.0.1:${config.ports.http}`, webrtcAllowOrigins: [],
    webrtcLocalUDPAddress: `:${config.ports.udp}`, webrtcLocalTCPAddress: '', webrtcIPsFromInterfaces: false,
    webrtcAdditionalHosts: [config.lanAddress, '127.0.0.1'], webrtcICEServers2: [], webrtcHandshakeTimeout: '10s',
    authMethod: 'internal', authInternalUsers: [{ user: session.user, pass: session.password, ips: ['127.0.0.1', '::1'],
      permissions: [{ action: 'publish', path: session.path }, { action: 'read', path: session.path }, { action: 'api' }] },
      ...(srt ? [{ user: session.srtUser, pass: session.srtPassword, ips: [`${config.lanAddress.split('.').slice(0, 3).join('.')}.0/24`],
        permissions: [{ action: 'read', path: session.path }] }] : [])],
    paths: { [session.path]: { source: 'publisher', overridePublisher: false, maxReaders: 8, record: false,
      ...(srt ? { srtReadPassphrase: session.srtPassphrase } : {}) } } };
}
async function writeObsProfile(config, session) {
  const root = path.join(config.obsRoot, 'config', 'obs-studio'), profile = path.join(root, 'basic', 'profiles', 'RabbitHoleVisualizer');
  const quality = session.profile || PROFILE;
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(path.join(root, 'basic', 'scenes'), { recursive: true });
  await fs.mkdir(path.join(root, 'plugin_config', 'obs-websocket'), { recursive: true });
  const ini = `[General]\nName=Rabbit Hole Visualizer\n\n[Video]\nBaseCX=${quality.width}\nBaseCY=${quality.height}\nOutputCX=${quality.width}\nOutputCY=${quality.height}\nFPSType=0\nFPSCommon=${quality.targetFps}\nColorFormat=NV12\nColorSpace=709\nColorRange=Partial\nScaleType=lanczos\n\n[Output]\nMode=Advanced\nReconnect=false\nDynamicBitrate=false\n\n[AdvOut]\nEncoder=obs_nvenc_h264_tex\nAudioEncoder=ffmpeg_opus\nApplyServiceSettings=false\nRescale=false\nTrackIndex=1\nVodTrackEnabled=false\nTrack1Bitrate=64\nRecType=Standard\nRecEncoder=none\nRecAudioEncoder=ffmpeg_opus\nRecTracks=1\n\n[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n\n[Stream1]\nIgnoreRecommended=true\nWHIPSimulcastTotalLayers=1\n`;
  await fs.writeFile(path.join(profile, 'basic.ini'), ini);
  await fs.writeFile(path.join(profile, 'streamEncoder.json'), JSON.stringify({ rate_control: 'CBR', bitrate: quality.targetBitrateMbps * 1000, max_bitrate: quality.targetBitrateMbps * 1000, keyint_sec: 1,
    preset: 'p5', tune: 'll', multipass: 'disabled', profile: 'high', bf: 0, lookahead: false, adaptive_quantization: true, repeat_headers: true, device: -1 }));
  await fs.writeFile(path.join(profile, 'service.json'), JSON.stringify({ type: 'whip_custom', settings: { server: `http://127.0.0.1:${config.ports.http}/${session.path}/whip`, bearer_token: `${session.user}:${session.password}` } }));
  await fs.writeFile(path.join(root, 'global.ini'), '[General]\nFirstRun=false\nPre31Migrated=true\nEnableAutoUpdates=false\nLastVersion=537002496\n');
  await fs.writeFile(path.join(root, 'user.ini'), '[General]\nConfirmOnExit=false\n\n[Video]\nAdapterIdx=0\n\n[Basic]\nProfile=Rabbit Hole Visualizer\nProfileDir=RabbitHoleVisualizer\nSceneCollection=Rabbit Hole Visualizer\nSceneCollectionFile=RabbitHoleVisualizer\n\n[BasicWindow]\nPreviewEnabled=false\n');
  // No global audio devices and no audio-capable inputs in this scene collection.
  await fs.writeFile(path.join(root, 'basic', 'scenes', 'RabbitHoleVisualizer.json'), JSON.stringify({ name: 'Rabbit Hole Visualizer',
    current_scene: 'Rabbit Hole Visualizer', current_program_scene: 'Rabbit Hole Visualizer', scene_order: [{ name: 'Rabbit Hole Visualizer' }],
    sources: [{ name: 'Rabbit Hole Visualizer', id: 'scene', settings: { items: [] } }], desktop_audio_device1: null, desktop_audio_device2: null,
    aux_audio_device1: null, aux_audio_device2: null, aux_audio_device3: null, aux_audio_device4: null }));
  await fs.writeFile(path.join(root, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify({ first_load: false, server_enabled: true,
    server_port: config.ports.obs, alerts_enabled: false, auth_required: true, server_password: session.obsPassword }));
}

function createIntegration(options = {}) {
  const runtimeRoot = options.runtimeRoot || path.join(__dirname, '..', '..', 'data', 'soundspectrum-obs-webrtc');
  const spawnImpl = options.spawnImpl || spawn, action = options.processAction || processAction, portCheck = options.checkPorts || checkPorts;
  const srtPortCheck = options.checkSrtPort || checkSrtPort;
  const fetchImpl = options.fetchImpl || fetch, clock = options.clock || Date.now;
  const ownerFs = options.ownerFs || fs, processProbe = options.processProbe || processStatus;
  const startupDiagnostic = options.onStartupDiagnostic || (value => console.warn(`[soundspectrum-obs-webrtc] startup-failure stage=${value.stage} request=${value.obsRequestType || 'unknown'} code=${value.obsStatusCode ?? 'unknown'}`));
  const sleep = options.sleep || ((ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', abort); resolve(); } function abort() { clearTimeout(timer); reject(problem('Visualizer transport was cancelled.')); } signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }));
  const scheduleMonitor = options.setTimeoutImpl || setTimeout;
  const highBitrate = options.highBitrate || require('../soundspectrum-srt-high-bitrate/index.cjs').createIntegration({
    processAction: action, clock, ...(options.highBitrateOptions || {}) });
  let highAvailable = false;
  let current = null, epoch = 0;
  async function readConfig() {
    const value = JSON.parse((await fs.readFile(path.join(runtimeRoot, 'runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const qualityProfile = value.qualityProfile === undefined ? PROFILE.id : value.qualityProfile;
    if (value.version !== 1 || value.obsVersion !== '32.2.2' || value.mediaMtxVersion !== '1.21.1' || !inside(runtimeRoot, value.obsRoot) ||
      !inside(runtimeRoot, value.obsExecutable) || !inside(runtimeRoot, value.relayExecutable) || !samePath(value.obsExecutable, path.join(value.obsRoot, 'bin', '64bit', 'obs64.exe')) ||
      !privateIpv4(value.lanAddress) || typeof qualityProfile !== 'string' || !Object.hasOwn(PROFILES, qualityProfile) ||
      !value.ports || !['obs', 'http', 'api', 'udp'].every(key => Number.isInteger(value.ports[key]) && value.ports[key] >= 1024 && value.ports[key] <= 65535) || new Set(Object.values(value.ports)).size !== 4) throw problem('The isolated OBS transport configuration is invalid.');
    for (const file of [value.obsExecutable, value.relayExecutable]) { if (!(await fs.stat(file)).isFile() || !inside(runtimeRoot, await fs.realpath(file))) throw problem('The isolated video runtime is missing.'); }
    return { ...value, qualityProfile, srtExperiment: srtConfiguration(value.srtExperiment, value.ports) };
  }
  async function inspect() { try {
    const config = await readConfig(), high = await highBitrate.inspect().catch(() => ({ available: false }));
    highAvailable = high.available === true;
    return { available: true, reason: '', profile: { ...PROFILES[config.qualityProfile] }, srtExperiment: {
      ...srtSnapshot(config, null, clock()), videoTargetsMbps: videoTargets(config) } };
  } catch { return { available: false, reason: 'Prepare the separate OBS WebRTC runtime first.', profile: { ...PROFILE }, srtExperiment: { ...srtSnapshot(null, null, clock()), videoTargetsMbps: [] } }; } }
  function videoTargets(config) { return config?.srtExperiment?.enabled ? [60, ...(highAvailable && PROFILES[config.qualityProfile]?.width === 3840 ? [600] : [])] : []; }
  function sharedVideoProfile(session) { return { requestedBitrateMbps: 60, configuredBitrateMbps: session.profile.targetBitrateMbps,
    encoderMode: 'shared-publisher', width: session.profile.width, height: session.profile.height, fps: session.profile.targetFps,
    videoBitrateMbps: null, videoBitrateObservedAt: null, videoBitrateWindowMs: null, observedCodec: null }; }
  function experimentSnapshot(session) {
    const value = { ...srtSnapshot(session?.config, session, clock()), videoTargetsMbps: videoTargets(session?.config) };
    if (session?.srtVideoBitrateMbps === 600) { const high = highBitrate.snapshot(); return { ...value, ...high,
      state: session.srtError ? 'error' : session.srtChanging ? 'changing' : high.state }; }
    return { ...value, videoProfile: session ? sharedVideoProfile(session) : null };
  }
  const matches = session => current === session && !session.controller.signal.aborted && session.isCurrent?.() === true;
  function guard(session) { if (!matches(session)) throw problem('The visualizer transport session changed.'); }
  async function requestLocal(session, port, relative, init = {}, cleanup = false, onResponse = null, timeoutMs = 5000) {
    if (!cleanup) guard(session);
    if (typeof relative !== 'string' || !relative.startsWith('/') || relative.startsWith('//') || relative.includes('\\')) throw problem('Invalid local relay request.');
    const controller = new AbortController(), abort = () => controller.abort();
    if (!cleanup) session.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}${relative}`, { ...init, redirect: 'error', signal: controller.signal,
        headers: { ...init.headers, Authorization: `Bearer ${session.user}:${session.password}` } });
      // A created WHEP resource must be recorded before its body is read/validated.
      // Cancellation and oversized or malformed SDP then still have an owned DELETE target.
      onResponse?.(response);
      const length = Number(response.headers.get('content-length'));
      if (length > 256 * 1024) throw problem('The local relay response is too large.');
      const body = await responseText(response);
      if (!cleanup) guard(session);
      return { response, body };
    } finally { clearTimeout(timer); session.controller.signal.removeEventListener('abort', abort); }
  }
  async function saveOwner(session) { await fs.writeFile(path.join(runtimeRoot, 'owner.json'), JSON.stringify({ version: 1, owner: session.owner, processes: session.processes.map(item => item.identity || { pid: item.child.pid, executable: item.executable, pendingIdentity: true }), epoch: session.key })); }
  async function launch(session, executable, args, cwd) {
    guard(session);
    // MediaMTX environment overrides must not expand its prepared private listeners.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MTX_|RTSP_)/i.test(key)));
    const child = spawnImpl(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], shell: false, env });
    const entry = { child, executable, identity: null }; session.processes.push(entry);
    child.once('error', () => fail(session, 'The isolated video helper could not start.'));
    child.once('exit', () => { entry.exited = true; if (matches(session)) fail(session, 'The isolated video helper stopped.'); });
    if (!Number.isInteger(child.pid) || child.pid <= 0) throw problem('The isolated video helper did not start.');
    await saveOwner(session);
    const identity = await action('identity', { ProcessId: child.pid, ExpectedExecutable: executable });
    if (identity?.exited) entry.exited = true;
    if (!identity || identity.exited || identity.pid !== child.pid || !samePath(identity.executable, executable) || !/^\d{10,22}$/.test(String(identity.startTimeTicks))) throw problem('The isolated helper identity could not be verified.');
    entry.identity = identity;
    await saveOwner(session); guard(session); return child;
  }
  async function writeOwnership(session) {
    session.owner = await action('identity', { ProcessId: process.pid, ExpectedExecutable: process.execPath });
    guard(session);
    if (session.owner?.pid !== process.pid || !/^\d{10,22}$/.test(String(session.owner?.startTimeTicks || '')) || !samePath(session.owner.executable, process.execPath)) throw problem('Rabbit Hole ownership could not be verified.');
    await session.lock.writeFile(JSON.stringify({ owner: session.owner, epoch: session.key })); await saveOwner(session);
  }
  async function acquireOwner(session) {
    const file = path.join(runtimeRoot, 'owner.lock');
    try { session.lock = await ownerFs.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw problem(OWNER_BUSY);
      await recoverOwnership(session); return;
    }
    await writeOwnership(session);
  }
  async function recoverOwnership(session) {
    const file = path.join(runtimeRoot, 'owner.lock'), recordFile = path.join(runtimeRoot, 'owner.json'), recoveryFile = file + '.recovery';
    const guardBytes = Buffer.from(JSON.stringify({ version: 1, ownerPid: process.pid, epoch: session.key }));
    let recovery, recoverySnapshot;
    try {
      guard(session);
      try { recovery = await ownerFs.open(recoveryFile, 'wx', 0o600); }
      catch { throw problem(OWNER_BUSY); }
      await recovery.writeFile(guardBytes); await recovery.close(); recovery = null;
      recoverySnapshot = await ownerSnapshot(recoveryFile, ownerFs); guard(session);
      const oldLock = await ownerSnapshot(file, ownerFs), oldRecord = await ownerSnapshot(recordFile, ownerFs); guard(session);
      let lock, record;
      try { lock = JSON.parse(oldLock.bytes.toString('utf8')); record = JSON.parse(oldRecord.bytes.toString('utf8')); }
      catch { throw problem(OWNER_BUSY); }
      if (!completeOwnership(lock, record, session.config)) throw problem(OWNER_BUSY);
      const absent = async () => {
        for (const pid of [record.owner.pid, ...record.processes.map(child => child.pid)]) {
          let status; try { status = await processProbe(pid); } catch { status = 'unknown'; }
          guard(session); if (status !== 'absent') throw problem(OWNER_BUSY);
        }
      };
      const unchanged = async () => {
        if (!sameOwnerSnapshot(oldLock, await ownerSnapshot(file, ownerFs)) ||
            !sameOwnerSnapshot(oldRecord, await ownerSnapshot(recordFile, ownerFs))) throw problem(OWNER_BUSY);
        guard(session);
      };
      await absent(); await unchanged(); await absent(); await unchanged();
      if (!sameOwnerSnapshot(recoverySnapshot, await ownerSnapshot(recoveryFile, ownerFs))) throw problem(OWNER_BUSY); guard(session);
      // Keep the old lock fencing normal claims until its matching JSON is gone.
      // Once the lock is removed, never delete again: preserve any wx gap winner.
      await ownerFs.rm(recordFile); guard(session);
      if (!sameOwnerSnapshot(oldLock, await ownerSnapshot(file, ownerFs)) ||
          !sameOwnerSnapshot(recoverySnapshot, await ownerSnapshot(recoveryFile, ownerFs))) throw problem(OWNER_BUSY); guard(session);
      try { await ownerFs.lstat(recordFile); throw problem(OWNER_BUSY); }
      catch (error) { if (error.code !== 'ENOENT') throw error; } guard(session);
      await ownerFs.rm(file); guard(session);
      try { session.lock = await ownerFs.open(file, 'wx', 0o600); }
      catch { throw problem(OWNER_BUSY); }
      await writeOwnership(session);
    } catch (error) {
      guard(session);
      throw problem(OWNER_BUSY);
    } finally {
      await recovery?.close();
      if (recoverySnapshot) {
        try {
          const value = await ownerSnapshot(recoveryFile, ownerFs);
          if (sameOwnerSnapshot(recoverySnapshot, value) && value.bytes.equals(guardBytes)) await ownerFs.rm(recoveryFile);
        } catch (error) { if (error.code !== 'ENOENT') throw problem(OWNER_BUSY); }
      }
    }
  }
  async function observeNative(session) {
    guard(session); const value = await session.observeWindow(); guard(session);
    const identity = session.nativeIdentity;
    if (value?.pid !== identity.pid || String(value.windowHandle) !== String(identity.windowHandle) || value.windowTitle !== identity.windowTitle ||
      value.windowClass !== identity.windowClass || !Number.isInteger(value.width) || value.width <= 0 || !Number.isInteger(value.height) || value.height <= 0) throw problem('The exact owned native visualizer window changed.');
    session.nativeGeometry = { width: value.width, height: value.height }; return value;
  }
  async function configureObs(session, deadline) {
    const obs = session.obs, profile = session.profile;
    const request = (name, data, timeoutMs) => { session.startupStage = OBS_REQUEST_STAGES[name]; return obs.request(name, data, timeoutMs); };
    let version, notReady;
    // Authentication can finish before OBS loads the isolated scene collection.
    // Retry only this read-only NotReady probe; never replay configuration.
    while (clock() < deadline) {
      guard(session);
      try {
        version = await request('GetVersion', {}, Math.min(5000, Math.max(1, Math.floor(deadline - clock())))); guard(session);
        if (clock() >= deadline) throw problem('The isolated OBS control did not become ready.');
        break;
      } catch (error) {
        guard(session);
        if (error?.obsRequestType !== 'GetVersion' || error.obsStatusCode !== 207) throw error;
        notReady = error;
      }
      const remaining = deadline - clock();
      if (remaining <= 0) break;
      await sleep(Math.min(250, remaining), session.controller.signal); guard(session);
    }
    if (!version) throw notReady || problem('The isolated OBS control did not become ready.');
    if (version.obsVersion !== '32.2.2') throw problem('The isolated OBS version does not match the prepared runtime.');
    const list = await request('GetInputList'); guard(session);
    if (list.inputs?.length) throw problem('The isolated OBS scene unexpectedly contains existing inputs.');
    const audio = await request('GetSpecialInputs'); guard(session);
    if (Object.values(audio).some(Boolean)) throw problem('The isolated OBS profile has an audio device enabled.');
    const video = await request('GetVideoSettings'); guard(session);
    if (video.baseWidth !== profile.width || video.baseHeight !== profile.height || video.outputWidth !== profile.width || video.outputHeight !== profile.height || video.fpsNumerator !== profile.targetFps || video.fpsDenominator !== 1) throw problem('The isolated OBS video profile does not match the prepared profile.');
    session.video = { width: video.outputWidth, height: video.outputHeight };
    const created = await request('CreateInput', { sceneName: 'Rabbit Hole Visualizer', inputName: 'Owned SoundSpectrum window', inputKind: 'window_capture', inputSettings: { method: 2, priority: 0, cursor: false, capture_audio: false, client_area: true, force_sdr: true }, sceneItemEnabled: false }); guard(session);
    const native = await observeNative(session), expected = `${encodeWindowPart(native.windowTitle)}:${encodeWindowPart(native.windowClass)}:${encodeWindowPart(path.win32.basename(session.nativeIdentity.executable))}`;
    const props = await request('GetInputPropertiesListPropertyItems', { inputName: 'Owned SoundSpectrum window', propertyName: 'window' }); guard(session);
    const candidates = props.propertyItems?.filter(item => item.itemValue === expected && item.itemEnabled !== false) || [];
    if (candidates.length !== 1) throw problem('OBS could not uniquely select the exact owned native visualizer window.');
    await request('SetInputSettings', { inputName: 'Owned SoundSpectrum window', inputSettings: { window: expected, method: 2, priority: 0, cursor: false, capture_audio: false, client_area: true, force_sdr: true }, overlay: true }); guard(session);
    const settings = await request('GetInputSettings', { inputName: 'Owned SoundSpectrum window' }); guard(session);
    if (settings.inputSettings?.window !== expected || settings.inputSettings?.priority !== 0 || settings.inputSettings?.capture_audio !== false || settings.inputSettings?.client_area !== true || settings.inputSettings?.method !== 2 || settings.inputSettings?.cursor !== false || settings.inputSettings?.force_sdr !== true) throw problem('The OBS capture source did not retain its exact window selection.');
    session.inputWindow = expected; session.sceneItemId = created.sceneItemId;
    await request('SetSceneItemTransform', { sceneName: 'Rabbit Hole Visualizer', sceneItemId: created.sceneItemId,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 5, boundsWidth: profile.width, boundsHeight: profile.height } }); guard(session);
    await request('SetSceneItemEnabled', { sceneName: 'Rabbit Hole Visualizer', sceneItemId: created.sceneItemId, sceneItemEnabled: true }); guard(session);
    await request('SetCurrentProgramScene', { sceneName: 'Rabbit Hole Visualizer' }); guard(session);
    await request('StartStream'); guard(session);
  }
  async function publisher(session) {
    const revision = session.srtRevision;
    let result;
    try { result = await requestLocal(session, session.config.ports.api, `/v3/paths/get/${session.path}`); }
    catch (error) {
      // A scoped SRT toggle reloads MediaMTX's API server, but leaves its WHIP
      // publisher untouched. Fence that owned reload instead of declaring a
      // transport failure for its transient closed HTTP connection.
      if (!session.srtChanging && revision === session.srtRevision) throw error;
      await session.srtSerial; guard(session);
      result = await requestLocal(session, session.config.ports.api, `/v3/paths/get/${session.path}`);
    }
    const { response, body } = result;
    if (!response.ok) return null;
    let value; try { value = JSON.parse(body); } catch { return null; }
    if (value?.ready === true && Number.isSafeInteger(value.bytesReceived) && value.bytesReceived > 0 && value.tracks?.some(track => track === 'H264')) {
      session.publishedFormat = 'H264'; return value;
    }
    return null;
  }
  async function sampleSrt(session) {
    if (!session.config.srtExperiment.enabled || !session.srtReady || session.srtChanging || session.srtVideoBitrateMbps === 600) return;
    const revision = session.srtRevision;
    try {
      const { response, body } = await requestLocal(session, session.config.ports.api, '/v3/srt/conns/list?itemsPerPage=100&page=0', {}, false, null, 1000);
      if (!response.ok) return;
      const value = JSON.parse(body);
      if (!Array.isArray(value.items) || value.items.length > 100 || !Number.isSafeInteger(value.pageCount) || value.pageCount < 0 || value.pageCount > 1) return;
      if (!matches(session) || !session.srtReady || session.srtChanging || revision !== session.srtRevision) return;
      const readers = value.items.filter(item => item?.state === 'read' && item.path === session.path && item.user === session.srtUser);
      if (readers.length > 8) return;
      session.srtStats = readers.map((item, index) => {
        const stats = { slot: index + 1 };
        for (const field of SRT_STAT_FIELDS) {
          const numeric = ['mbpsSendRate', 'msRTT'].includes(field) ? Number.isFinite(item[field]) && item[field] <= 1e9 : Number.isSafeInteger(item[field]);
          // Pinned gosrt reports binary megabits; public/UI Mbps is decimal.
          stats[field] = numeric && item[field] >= 0 ? item[field] * (field === 'mbpsSendRate' ? 1048576 / 1e6 : 1) : null;
        }
        return stats;
      });
      session.srtObservedAt = clock();
    } catch {
      // Optional reader diagnostics never stop the shared encoded publisher.
    }
  }
  async function captureGeometry(session) {
    const value = await session.obs.request('GetSceneItemTransform', { sceneName: 'Rabbit Hole Visualizer', sceneItemId: session.sceneItemId }); guard(session);
    const transform = value.sceneItemTransform;
    if (!transform || ![transform.sourceWidth, transform.sourceHeight].every(dimension => Number.isInteger(dimension) && dimension > 0 && dimension <= 16384)) return false;
    session.captureSourceResolution = { width: transform.sourceWidth, height: transform.sourceHeight }; session.sourceObservedAt = clock();
    session.sceneTransform = { boundsType: typeof transform.boundsType === 'string' && transform.boundsType.startsWith('OBS_BOUNDS_') ? transform.boundsType : null };
    for (const field of ['scaleX', 'scaleY', 'boundsWidth', 'boundsHeight']) session.sceneTransform[field] = Number.isFinite(transform[field]) && transform[field] >= 0 && transform[field] <= 16384 ? transform[field] : null;
    return true;
  }
  function fail(session, message) { if (!matches(session) || session.failed) return; session.failed = true; try { session.onFailure?.(problem(message)); } catch {} void stopSession(session).catch(() => {}); }
  async function monitor(session) {
    if (!matches(session)) return;
    try {
      await observeNative(session);
      const settings = await session.obs.request('GetInputSettings', { inputName: 'Owned SoundSpectrum window' }); guard(session);
      if (settings.inputSettings?.window !== session.inputWindow || settings.inputSettings?.capture_audio !== false || settings.inputSettings?.priority !== 0 || settings.inputSettings?.method !== 2 || settings.inputSettings?.cursor !== false || settings.inputSettings?.force_sdr !== true || settings.inputSettings?.client_area !== true) throw problem('The owned window capture settings changed.');
      if (!await captureGeometry(session)) throw problem('The owned OBS window capture did not report an image surface.');
      const value = await publisher(session); guard(session);
      if (value && value.bytesReceived > session.lastBytes) { const now = clock(), elapsed = now - session.lastBytesAt; session.observedBitrateMbps = elapsed > 0 ? (value.bytesReceived - session.lastBytes) * 8 / elapsed / 1000 : null; session.bitrateWindowMs = elapsed > 0 ? elapsed : null; session.bitrateObservedAt = now; session.lastBytes = value.bytesReceived; session.lastBytesAt = now; }
      if (!value || clock() - session.lastBytesAt > 6000) throw problem('The isolated video publisher stopped producing frames.');
    } catch { return fail(session, 'The isolated OBS video feed stopped. Select Start visuals to retry.'); }
    await sampleSrt(session);
    // Rabbit Hole's existing viewer lease sweeper owns expiry and calls releaseViewer.
    // Expiring readers by age here would interrupt a healthy long-running viewer.
    for (const [id, reader] of session.readers) if (reader.released) await removeReader(session, id, reader);
    if (matches(session)) { session.timer = scheduleMonitor(() => monitor(session), 2000); session.timer.unref?.(); }
  }
  async function start({ window, nativeIdentity, observeWindow, generation, isCurrent, onReady, onFailure, expectedProfileId }) {
    if (current) throw problem('An isolated OBS video session is already active.');
    if (!Number.isInteger(generation) || generation < 1 || typeof isCurrent !== 'function' || typeof observeWindow !== 'function' ||
      !nativeIdentity || nativeIdentity.pid !== window?.pid || String(nativeIdentity.windowHandle) !== String(window?.windowHandle) ||
      !correlatedNativeProduct(nativeIdentity) || typeof nativeIdentity.windowClass !== 'string' || !nativeIdentity.windowClass ||
      !/^\d{10,22}$/.test(String(nativeIdentity.startTimeTicks || ''))) throw problem('An exact owned native capture identity is required.');
    const session = { key: token(), epoch: ++epoch, generation, nativeIdentity: { ...nativeIdentity }, observeWindow, isCurrent, onReady, onFailure,
      controller: new AbortController(), processes: [], readers: new Map(), pendingViewers: new Set(), user: 'rabbit-hole', password: token(), obsPassword: token(), path: `rh-${token()}`, timer: null, ready: false,
      srtUser: `srt-${token()}`, srtPassword: token(), srtPassphrase: crypto.randomBytes(16).toString('hex'), srtOwner: null,
      srtSerial: Promise.resolve(), srtRevision: 0, srtChanging: false, srtReady: false, srtError: false, srtStats: [] };
    current = session;
    session.boot = (async () => {
      session.startupStage = 'runtime';
      session.config = await readConfig(); session.profile = PROFILES[session.config.qualityProfile]; guard(session);
      if (expectedProfileId !== undefined && expectedProfileId !== session.profile.id) throw problem('The isolated OBS quality profile changed before startup.');
      const native4k = session.profile.width === 3840 && session.profile.height === 2160;
      session.startupStage = 'native-window';
      if (native4k) {
        if (window.width !== session.profile.width || window.height !== session.profile.height) throw problem('The 4K profile requires an actual 3840 by 2160 native client area; upscaling is disabled.');
        const initial = await observeNative(session);
        if (initial.width !== session.profile.width || initial.height !== session.profile.height) throw problem('The 4K profile requires an actual 3840 by 2160 native client area; upscaling is disabled.');
      }
      session.startupStage = 'ownership'; await acquireOwner(session); guard(session);
      session.startupStage = 'ports'; await portCheck(session.config); guard(session);
      session.startupStage = 'native-window'; await observeNative(session);
      session.startupStage = 'profile'; await writeObsProfile(session.config, session); guard(session);
      await fs.mkdir(path.join(runtimeRoot, 'logs'), { recursive: true }); guard(session); session.relayLog = path.join(runtimeRoot, 'logs', `relay-${session.key}.log`);
      const relayFile = path.join(runtimeRoot, 'mediamtx.json'); await fs.writeFile(relayFile, JSON.stringify(relayConfig(session.config, session))); guard(session);
      session.startupStage = 'relay-launch'; await launch(session, session.config.relayExecutable, [relayFile], path.dirname(session.config.relayExecutable));
      session.startupStage = 'obs-launch'; await launch(session, session.config.obsExecutable, ['--portable', '--multi', '--only-bundled-plugins', '--disable-updater', '--disable-shutdown-check', '--minimize-to-tray', '--profile', 'Rabbit Hole Visualizer', '--collection', 'Rabbit Hole Visualizer', '--websocket_ipv4_only'], path.dirname(session.config.obsExecutable));
      const deadline = clock() + 30000;
      session.startupStage = 'obs-connect';
      while (clock() < deadline) {
        guard(session);
        try { session.obs = options.createObsClient ? options.createObsClient(session) : new ObsClient({ port: session.config.ports.obs, password: session.obsPassword, signal: session.controller.signal }); await session.obs.connect(); break; }
        catch { session.obs?.close(); session.obs = null; await sleep(250, session.controller.signal); }
      }
      if (!session.obs) throw problem('The isolated OBS control did not become ready.'); guard(session);
      await configureObs(session, deadline);
      session.startupStage = 'publisher';
      while (clock() < deadline) { const value = await publisher(session); guard(session); if (value && await captureGeometry(session)) {
        if (native4k && (session.captureSourceResolution.width !== session.profile.width || session.captureSourceResolution.height !== session.profile.height)) throw problem('The initial OBS capture surface does not match the native 4K profile.');
        session.lastBytes = value.bytesReceived; session.lastBytesAt = clock(); session.ready = true; break;
      } await sleep(250, session.controller.signal); }
      if (!session.ready) throw problem('The isolated video publisher did not become ready.');
      guard(session); onReady?.(); guard(session); session.timer = scheduleMonitor(() => monitor(session), 2000); session.timer.unref?.();
      return snapshot();
    })();
    try { return await session.boot; }
    catch (error) {
      const diagnostic = { stage: STARTUP_STAGES.has(session.startupStage) ? session.startupStage : 'unknown' };
      if (Object.hasOwn(OBS_REQUEST_STAGES, error?.obsRequestType || '')) diagnostic.obsRequestType = error.obsRequestType;
      if (Number.isInteger(error?.obsStatusCode) && error.obsStatusCode >= 0 && error.obsStatusCode <= 10000) diagnostic.obsStatusCode = error.obsStatusCode;
      try { startupDiagnostic({ ...diagnostic }); } catch {}
      await stopSession(session);
      throw Object.assign(problem(error?.safeMessage ? error.message : 'The isolated visualizer transport could not start.'), diagnostic);
    }
  }
  function relayLocation(session, value) {
    if (!boundedText(value, 512)) throw problem('The relay did not return a reader session.');
    const base = `http://127.0.0.1:${session.config.ports.http}`, url = new URL(value, base);
    if (url.origin !== base || url.username || url.password || url.search || url.hash || !new RegExp(`^/${session.path}/whep/[a-zA-Z0-9_-]{16,128}$`).test(url.pathname)) throw problem('The relay returned an invalid reader session.');
    return url.pathname;
  }
  async function removeReader(session, id, reader) {
    if (session.readers.get(id) !== reader) return;
    reader.released = true;
    if (reader.removing) return reader.removing;
    reader.removing = (async () => {
      try { const { response } = await requestLocal(session, session.config.ports.http, reader.location, { method: 'DELETE' }, true);
        if (response.ok || response.status === 404) session.readers.delete(id);
      } catch {} finally { reader.removing = null; }
    })(); return reader.removing;
  }
  async function releaseViewer({ viewerId, generation } = {}) {
    const session = current; if (!session || session.generation !== generation) return;
    if (session.pendingViewers.has(viewerId)) session.revoked?.add(viewerId);
    await Promise.all([...session.readers].filter(([, reader]) => reader.viewerId === viewerId).map(([id, reader]) => removeReader(session, id, reader)));
  }
  async function signal({ method, viewerId, generation, body, sessionId }) {
    const session = current;
    if (!session || generation !== session.generation || !validViewer(viewerId)) throw problem('The owned WebRTC visualizer session is unavailable.');
    if (method === 'DELETE') {
      const reader = validToken(sessionId) ? session.readers.get(sessionId) : null;
      if (!reader || reader.viewerId !== viewerId) throw problem('The WebRTC reader does not belong to this viewer.');
      await removeReader(session, sessionId, reader); return { status: 204, body: '' };
    }
    if (!session.ready || !matches(session)) throw problem('The owned WebRTC visualizer session is unavailable.');
    if (method !== 'POST' || !boundedText(body, 128 * 1024) || !/^v=0\r?\n/.test(body) || !/^m=video /m.test(body) || /^m=audio (?!0 )/m.test(body)) throw problem('A video-only SDP offer is required.', 400);
    const otherViewers = new Set([...session.pendingViewers, ...[...session.readers.values()].map(reader => reader.viewerId)]); otherViewers.delete(viewerId);
    if (session.pendingViewers.has(viewerId) || otherViewers.size >= 8) throw problem('The WebRTC viewer limit has been reached.', 429);
    session.pendingViewers.add(viewerId); session.revoked ||= new Set(); session.revoked.delete(viewerId);
    let createdId = null, createdReader = null;
    try {
      await Promise.all([...session.readers].filter(([, reader]) => reader.viewerId === viewerId).map(([id, reader]) => removeReader(session, id, reader))); guard(session);
      if (session.revoked.has(viewerId)) throw problem('The WebRTC viewer was released during signaling.');
      if ([...session.readers.values()].some(reader => reader.viewerId === viewerId)) throw problem('The previous owned WebRTC reader could not be released.');
      const { response, body: answer } = await requestLocal(session, session.config.ports.http, `/${session.path}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body }, false, response => {
        if (response.status !== 201) return;
        const location = relayLocation(session, response.headers.get('location'));
        createdId = token(); createdReader = { viewerId, location, at: clock() }; session.readers.set(createdId, createdReader);
      });
      if (response.status !== 201 || !/^v=0\r?\n/.test(answer)) throw problem('The local relay could not establish video.');
      if (!matches(session) || session.revoked.has(viewerId)) throw problem('The WebRTC viewer was released during signaling.');
      return { status: 201, headers: { 'Content-Type': 'application/sdp' }, body: answer, sessionId: createdId };
    } catch (error) { if (createdId && createdReader) await removeReader(session, createdId, createdReader); throw error; }
    finally { session.pendingViewers.delete(viewerId); session.revoked.delete(viewerId); }
  }
  function enqueueSrt(session, operation) {
    session.srtPending = (session.srtPending || 0) + 1;
    session.srtChanging = true; session.srtRevision++;
    const pending = session.srtSerial.then(operation).finally(() => {
      session.srtPending--; session.srtChanging = session.srtPending > 0;
    });
    session.srtSerial = pending.catch(() => {});
    return pending;
  }
  async function toggleSrt(session, enabled, cleanup = false) {
    const { response } = await requestLocal(session, session.config.ports.api, '/v3/config/global/patch',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ srt: enabled }) }, cleanup);
    if (!response.ok) throw problem('The owned SRT listener could not be changed.');
    // MediaMTX acknowledges configuration before completing its reload. Its API
    // listener is recreated too; confirm the new state through a fresh response.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await requestLocal(session, session.config.ports.api, '/v3/config/global/get', {}, cleanup, null, 500);
        if (result.response.ok && JSON.parse(result.body)?.srt === enabled) return;
      } catch {}
      if (attempt < 4) await sleep(100, cleanup ? undefined : session.controller.signal);
    }
    throw problem('The owned SRT listener change could not be verified.');
  }
  async function srtConnection({ viewerId, generation, videoBitrateMbps = 60, expiresAt } = {}) {
    const session = current;
    if (![60, 600].includes(videoBitrateMbps)) throw problem('Choose the 60 or 600 Mbps SRT trial.', 400);
    if (!session || !session.ready || generation !== session.generation || !validViewer(viewerId) ||
        !session.config.srtExperiment.enabled || !matches(session)) throw problem('The owned SRT experiment is unavailable.');
    return enqueueSrt(session, async () => {
      guard(session);
      if (!session.ready || session.srtError) throw problem('Stop the current SRT experiment before trying again.');
      if (session.srtOwner && session.srtOwner !== viewerId) throw problem('Another viewer owns the SRT experiment.', 409);
      if (session.srtOwner && session.srtVideoBitrateMbps !== videoBitrateMbps) throw problem('Stop the current SRT trial before changing its video target.', 409);
      if (videoBitrateMbps === 600) {
        if (session.srtOwner && session.srtReady) throw problem('The independent SRT trial is already active.', 409);
        if (session.profile.width !== 3840 || session.profile.height !== 2160 || session.profile.targetFps !== 60) throw problem('The independent SRT trial requires an actual running 4K60 native window.');
        const high = await highBitrate.inspect(); guard(session);
        if (!high.available) throw problem('Prepare the isolated 600 Mbps SRT runtime first.');
        highAvailable = true; session.srtOwner = viewerId; session.srtVideoBitrateMbps = 600;
        try {
          const result = await highBitrate.start({ viewerId, generation, nativeIdentity: session.nativeIdentity,
            observeWindow: session.observeWindow, isCurrent: () => matches(session),
            expiresAt: expiresAt === undefined ? clock() + 600000 : expiresAt, lanAddress: session.config.lanAddress,
            forbiddenPorts: [...Object.values(session.config.ports), session.config.srtExperiment.port],
            onFailure: () => { if (current === session && session.srtOwner === viewerId && session.srtVideoBitrateMbps === 600) { session.srtError = true; session.srtReady = false; } } });
          guard(session); session.srtReady = true; return result;
        } catch (error) {
          // Join exact cleanup even if the generation ended just after its ready
          // response. Never orphan a new branch or touch OBS/the shared relay.
          try { await highBitrate.stop({ viewerId, generation }); session.srtOwner = null; session.srtReady = false; session.srtError = false; }
          catch { session.srtError = true; }
          throw error;
        }
      }
      session.srtVideoBitrateMbps = 60;
      if (!session.srtReady) {
        session.srtOwner = viewerId; session.srtObservedAt = undefined; session.srtStats = [];
        try {
          await srtPortCheck(session.config); guard(session);
          // Retain the owner if enable/rollback is uncertain; no successful Stop
          // or idle claim is allowed until closure is actually verified.
          session.srtReady = true;
          await toggleSrt(session, true); guard(session);
        } catch (error) {
          if (session.srtReady) {
            try { await toggleSrt(session, false, true); session.srtReady = false; }
            catch { session.srtError = true; throw problem('The owned SRT listener could not be closed. Retry Stop before starting another experiment.'); }
          }
          session.srtOwner = null;
          throw error;
        }
      }
      guard(session);
      const query = new URLSearchParams({ mode: 'caller', latency: String(session.config.srtExperiment.latencyMs), pbkeylen: '16',
        streamid: `read:${session.path}:${session.srtUser}:${session.srtPassword}`, passphrase: session.srtPassphrase });
      return { transport: 'srt', generation: session.generation, client: 'larix-player', latencyUnit: 'milliseconds',
        requestedLatencyMs: session.config.srtExperiment.latencyMs, url: `srt://${session.config.lanAddress}:${session.config.srtExperiment.port}?${query}`, videoProfile: sharedVideoProfile(session) };
    });
  }
  async function releaseSrt({ viewerId, generation } = {}) {
    const session = current;
    if (!session || generation !== session.generation || !validViewer(viewerId)) return { released: false };
    return enqueueSrt(session, async () => {
      if (session.srtOwner !== viewerId) return { released: false };
      if (session.srtVideoBitrateMbps === 600) {
        try { await highBitrate.stop({ viewerId, generation }); }
        catch { session.srtError = true; throw problem('An owned independent SRT helper could not close. Retry Stop before another trial.'); }
        session.srtReady = false; session.srtOwner = null; session.srtError = false; session.srtVideoBitrateMbps = null;
        session.srtObservedAt = undefined; session.srtStats = []; return { released: true };
      }
      try { await toggleSrt(session, false, true); }
      catch { session.srtError = true; throw problem('The owned SRT listener could not be closed. Retry Stop before starting another experiment.'); }
      session.srtReady = false; session.srtOwner = null; session.srtError = false;
      session.srtObservedAt = undefined; session.srtStats = [];
      return { released: true };
    });
  }
  async function stopSession(session) {
    if (session.stopPromise) return session.stopPromise;
    session.controller.abort(); clearTimeout(session.timer); session.ready = false;
    session.obs?.close();
    session.stopPromise = (async () => {
      // Startup can still be obtaining a spawned process identity or writing its private
      // profile. Wait for its bounded/cancelled work before deleting the ownership lock.
      await session.boot?.catch(() => {});
      await session.srtSerial;
      let independentCleanupFailed = false;
      if (session.srtVideoBitrateMbps === 600 && session.srtOwner) {
        try { await highBitrate.stop({ viewerId: session.srtOwner, generation: session.generation }); }
        catch { independentCleanupFailed = true; }
      }
      await Promise.all([...session.readers].map(([id, reader]) => removeReader(session, id, reader)));
      session.obs?.close();
      let cleanupFailed = false;
      for (const entry of [...session.processes].reverse()) if (!entry.exited) {
        try {
          if (entry.identity) await action('terminate', { ProcessId: entry.identity.pid, ExpectedExecutable: entry.identity.executable, StartTimeTicks: entry.identity.startTimeTicks });
          else {
            // Node owns this spawn's process handle; never kill an arbitrary PID.
            await new Promise((resolve, reject) => {
              const done = () => { clearTimeout(timer); resolve(); }, timer = setTimeout(() => { entry.child.removeListener('exit', done); reject(problem('The owned helper did not exit.')); }, 3000);
              entry.child.once('exit', done);
              try { if (!entry.child.kill()) { clearTimeout(timer); entry.child.removeListener('exit', done); reject(problem('The owned helper could not be released.')); } }
              catch (error) { clearTimeout(timer); entry.child.removeListener('exit', done); reject(error); }
            });
          }
        } catch { cleanupFailed = true; }
      }
      if (session.lock) { await session.lock.close().catch(() => {}); if (!cleanupFailed && !independentCleanupFailed) { await fs.unlink(path.join(runtimeRoot, 'owner.lock')).catch(() => {}); await fs.unlink(path.join(runtimeRoot, 'owner.json')).catch(() => {}); } }
      if (independentCleanupFailed) { session.srtError = true; session.stopPromise = null; throw problem('An owned independent SRT helper could not close. Retry Stop; its ownership record was preserved.'); }
      if (current === session) current = null;
      if (cleanupFailed) throw problem('An owned video helper could not be released. Its private ownership record was preserved.');
    })(); return session.stopPromise;
  }
  function snapshot() { return { transport: 'obs-webrtc', state: current?.ready ? 'running' : current ? 'starting' : 'idle', generation: current?.generation || null,
    profile: { ...(current?.profile || PROFILE) }, outputSettingsResolution: current?.ready ? current.video || null : null,
    nativeClientResolution: current?.ready ? current.nativeGeometry || null : null,
    captureSourceResolution: current?.ready ? current.captureSourceResolution || null : null,
    captureSourceMeasurement: 'obs-scene-item-source-size', sourceObservedAt: current?.ready ? current.sourceObservedAt || null : null,
    sceneTransform: current?.ready ? current.sceneTransform || null : null,
    publishedFormat: current?.ready ? current.publishedFormat || null : null, formatMeasurement: 'mediamtx-published-track',
    payloadBitrateMbps: current?.ready ? current.observedBitrateMbps ?? null : null, bitrateWindowMs: current?.ready ? current.bitrateWindowMs ?? null : null,
    bitrateObservedAt: current?.ready ? current.bitrateObservedAt ?? null : null, bitrateMeasurement: 'mediamtx-incoming-byte-counter-delta',
    srtExperiment: experimentSnapshot(current) }; }
  return { inspect, start, stop: () => current ? stopSession(current) : Promise.resolve(), signal, releaseViewer, srtConnection, releaseSrt, snapshot, fidelity: snapshot };
}
module.exports = { createIntegration, ObsClient, PROFILE, PROFILES, relayConfig, writeObsProfile, checkPorts, checkSrtPort };
