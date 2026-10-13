'use strict';

// Explicit native-menu companion. This module does not own a renderer, change
// preferences, start playback, or start a feed merely by being imported.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHQPlayerZoneGuard, validZoneId } = require('../../src/soundSpectrumFeeds');
const { createIntegration, readSettings, SETTINGS } = require('../soundspectrum-hqplayer-feed/index.cjs');
const { validateDelayMs } = require('../../src/soundSpectrumPcmDelay');

const execFileAsync = promisify(execFile);
const PROJECT = path.resolve(__dirname, '../..');
const DATA = path.join(PROJECT, 'data/soundspectrum-hqplayer-native');
const SCRIPT = __filename;
const NATIVE_EXE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SoundSpectrum/G-Force/G-Force Standalone.x64.exe');
const WINDOW_HELPER = path.join(PROJECT, 'scripts/soundspectrum-window.ps1');
const STATUS_URL = 'http://127.0.0.1:3777/api/status/live';
const DELAY_URL = 'http://127.0.0.1:3777/api/soundspectrum/delay';
const MAX_DELAY_BODY = 4096;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_REQUEST = 512;
const MAX_OWNER = 16384;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TICKS = /^\d{10,22}$/;
const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000n;
const pidValid = value => Number.isSafeInteger(value) && value > 0;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sameIdentity = (a, b) => a && b && a.pid === b.pid && samePath(a.executable, b.executable) && String(a.startTimeTicks) === String(b.startTimeTicks);
const safeReason = value => String(value || 'HQPlayer analysis unavailable.').replace(/[\r\n\0]/g, ' ').slice(0, 350);

function parseRequest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_REQUEST || /[\0\uFFFD]/.test(text)) throw Error('Invalid native HQPlayer request.');
  const fields = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line) continue;
    const match = /^(action|pid|nonce)=([^\r\n]+)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) throw Error('Invalid native HQPlayer request.');
    fields[match[1]] = match[2];
  }
  if (!['start', 'stop'].includes(fields.action) || !/^[1-9]\d{0,9}$/.test(fields.pid || '') ||
      !pidValid(Number(fields.pid)) || !/^[a-f0-9]{32}$/.test(fields.nonce || '')) throw Error('Invalid native HQPlayer request.');
  return { action: fields.action, pid: Number(fields.pid), nonce: fields.nonce };
}

function formatStatus({ pid, nonce, state, reason }) {
  if (!pidValid(pid) || !/^[a-f0-9]{32}$/.test(nonce || '') || !['starting', 'receiving', 'waiting', 'error', 'stopped'].includes(state)) throw Error('Invalid native HQPlayer status.');
  return `pid=${pid}\nstate=${state}\nreason=${safeReason(reason)}\nnonce=${nonce}\n`;
}

async function readBounded(file, limit, { metadata = false } = {}) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat({ bigint: metadata });
    if (!stat.isFile() || stat.size > limit) throw Error('The native HQPlayer control file is invalid.');
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit) throw Error('The native HQPlayer control file is too large.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    // The mtime must belong to the same opened request, even if another explicit
    // menu choice atomically replaces request.txt while it is being read.
    return metadata ? { text, mtimeNs: stat.mtimeNs } : text;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

function requestIsFreshForNative(mtimeNs, startTimeTicks) {
  if (typeof mtimeNs !== 'bigint' || mtimeNs < 0n || !TICKS.test(String(startTimeTicks || ''))) return false;
  const ticks = BigInt(startTimeTicks);
  if (ticks < DOTNET_UNIX_EPOCH_TICKS) return false;
  // Windows DateTime uses 100ns ticks since year 1; filesystem mtimeNs uses
  // nanoseconds since 1970. Number conversion would lose native tick precision.
  return mtimeNs >= (ticks - DOTNET_UNIX_EPOCH_TICKS) * 100n;
}

async function atomicStatus(file, value) {
  const text = formatStatus(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// This private record deliberately excludes routes, device paths, raw stderr,
// owner tokens and source metadata. Only the request nonce correlates it with
// the native menu's request/status pair; it is never exposed by the app API.
function feedDiagnostic(request, snapshot, event, now = Date.now()) {
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const result = { version: 1, pid: request.pid, nonce: request.nonce, event, at: now,
    state: event === 'failure' ? 'error' : ['disabled', 'waiting', 'receiving', 'error'].includes(snapshot?.state) ? snapshot.state : 'unknown' };
  if (['confirmed', 'unknown'].includes(snapshot?.globalDelaySetting?.state) &&
      Number.isInteger(snapshot.globalDelaySetting.delayMs) && snapshot.globalDelaySetting.delayMs >= 0 && snapshot.globalDelaySetting.delayMs <= 5000) {
    result.globalDelaySetting = { state: snapshot.globalDelaySetting.state, delayMs: snapshot.globalDelaySetting.delayMs };
  }
  for (const key of ['analysisBytes', 'analysisFrames', 'pcmBytes', 'bufferedBytes', 'droppedAnalysisFrames', 'droppedPcmFrames', 'overlapResets', 'pcmAgeMs']) {
    if (nonnegative(snapshot?.[key]) || key === 'pcmAgeMs' && snapshot?.[key] === null) result[key] = snapshot[key];
  }
  for (const name of ['derivedSignal', 'submittedSignal']) {
    const source = snapshot?.[name];
    if (!source || typeof source !== 'object') continue;
    const signal = {};
    for (const key of ['samples', 'nonzeroSamples', 'clippedSamples', 'peak', 'rms', 'ageMs']) if (nonnegative(source[key])) signal[key] = source[key];
    for (const key of ['peakDbfs', 'rmsDbfs']) if (source[key] === null || typeof source[key] === 'number' && Number.isFinite(source[key])) signal[key] = source[key];
    if (typeof source.silent === 'boolean') signal.silent = source.silent;
    result[name] = signal;
  }
  const source = snapshot?.outputDiagnostic;
  if (source && typeof source === 'object') {
    const output = {};
    for (const key of ['writeCalls', 'writeCompletions', 'drainEvents', 'backpressureEvents', 'blockedMs', 'maxBlockedMs',
      'lastProgressAgeMs', 'writableBytes', 'peakWritableBytes', 'droppedOnBackpressureFrames', 'pacerGaps', 'maxPacerGapMs']) {
      if (nonnegative(source[key]) || key === 'lastProgressAgeMs' && source[key] === null) output[key] = source[key];
    }
    if (source.exitCode === null || Number.isSafeInteger(source.exitCode)) output.exitCode = source.exitCode;
    const categories = {
      signal: ['', 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK', 'OTHER'],
      errorCode: ['', 'EPIPE', 'ECONNRESET', 'EIO', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'UNKNOWN', 'BACKPRESSURE_TIMEOUT'],
      stderrReason: ['', 'device-unavailable', 'device-in-use', 'unsupported-format', 'audio-driver-error', 'pipeline-error', 'output-warning']
    };
    for (const [key, allowed] of Object.entries(categories)) if (allowed.includes(source[key])) output[key] = source[key];
    result.outputDiagnostic = output;
  }
  return result;
}

async function atomicDiagnostic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function fetchRoonFacts({ fetchImpl = fetch, timeoutMs = 2000, maxBytes = MAX_BODY } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(STATUS_URL, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw Error('Invalid Roon status.');
    const advertised = response.headers.get('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) throw Error('Roon status is too large.');
    const parts = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { controller.abort(); throw Error('Roon status is too large.'); }
      parts.push(Buffer.from(chunk));
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    if (typeof data.connected !== 'boolean' || !Array.isArray(data.zones) || data.zones.length > 512) throw Error('Invalid Roon zone facts.');
    // Keep no queue, source URL, title, token, artwork or other response data.
    return { connected: data.connected, zones: data.zones.map(zone => ({
      zone_id: zone.zone_id, state: zone.state,
      outputs: Array.isArray(zone.outputs) ? zone.outputs.map(output => ({ output_id: output.output_id })) : []
    })) };
  } catch { throw Error('Rabbit Hole Roon status is unavailable. Reconnect Roon, then choose HQPlayer Audio again.'); }
  finally { clearTimeout(timer); }
}

// The main service owns the shared setting, including its current unsaved
// preview. This read cannot alter playback, the renderer or the analysis lease.
async function fetchVisualDelay({ fetchImpl = fetch, timeoutMs = 2000, maxBytes = MAX_DELAY_BODY, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    if (controller.signal.aborted) throw Error('Cancelled.');
    const response = await fetchImpl(DELAY_URL, { method: 'GET', signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw Error('Invalid visual delay setting.');
    const advertised = response.headers.get('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) throw Error('Visual delay setting is too large.');
    const parts = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { controller.abort(); throw Error('Visual delay setting is too large.'); }
      parts.push(Buffer.from(chunk));
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    return { currentMs: validateDelayMs(data?.currentMs) };
  } catch { throw Error('The shared visual delay setting is unavailable.'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function probeNative(pid) {
  if (!pidValid(pid)) throw Error('The G-Force process is invalid.');
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOW_HELPER,
    '-Action', 'window', '-ProcessId', String(pid), '-ExpectedExecutable', NATIVE_EXE], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' });
  const info = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (info.exited || info.pid !== pid || !TICKS.test(info.startTimeTicks || '') || !info.window?.windowHandle) return null;
  return { pid, executable: NATIVE_EXE, startTimeTicks: String(info.startTimeTicks) };
}

// The installer invokes exactly "<node.exe>" "<controller.cjs>". Reading the
// second argument verifies a live lock belongs to this companion, not another
// Node service. Command-line text is never returned to the menu or logged.
function scriptArgument(commandLine) {
  const match = /^\s*(?:"[^"]*"|\S+)\s+(?:"([^"]+)"|(\S+))\s*$/.exec(commandLine || '');
  return match ? match[1] || match[2] : null;
}

async function probeOwner(pid) {
  if (!pidValid(pid)) return null;
  const script = `$taskProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue\nif ($null -ne $taskProcess) { $taskCim = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; @{pid=$taskProcess.Id; executable=$taskProcess.MainModule.FileName; startTimeTicks=$taskProcess.StartTime.ToUniversalTime().Ticks.ToString(); commandLine=$taskCim.CommandLine} | ConvertTo-Json -Compress }`;
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024, encoding: 'utf8' });
  if (!result.stdout.trim()) return null;
  const info = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  return { pid: info.pid, executable: info.executable, startTimeTicks: String(info.startTimeTicks), controllerPath: scriptArgument(info.commandLine) };
}

function competitorPaths(project = PROJECT, standalone = path.resolve(project, '../roon-visualizer')) {
  return [project, standalone].flatMap(root => [
    { file: path.join(root, 'data/soundspectrum-hqplayer-feed/owner.json'), ownFeed: root === project },
    { file: path.join(root, 'data/soundspectrum-audio-feed/demand.json.owner') },
    ...['aeon', 'g-force', 'whitecap'].map(product => ({ file: path.join(root, `data/soundspectrum-native/session-${product}.json`) }))
  ]);
}

async function assertNoCompetitors({ paths = competitorPaths(), ownToken = '', ownerPid = process.pid } = {}) {
  for (const entry of paths) {
    const text = await readBounded(entry.file, MAX_OWNER);
    if (text === null) continue;
    if (entry.ownFeed && ownToken) {
      let owner;
      try { owner = JSON.parse(text); } catch {}
      if (owner?.version === 1 && owner.token === ownToken && owner.ownerPid === ownerPid && owner.source === 'roon-hqplayer') continue;
    }
    throw Error('Another app owns SoundSpectrum visuals or its music feed. Stop those visuals before choosing HQPlayer Audio.');
  }
}

function validateOwner(value, controllerPath = SCRIPT) {
  if (value?.version !== 1 || !UUID.test(value.ownerId || '') || !pidValid(value.pid) || typeof value.executable !== 'string' || !value.executable ||
      !TICKS.test(String(value.startTimeTicks || '')) || !samePath(value.controllerPath, controllerPath)) throw Error('The native HQPlayer companion lock needs inspection; it was preserved.');
  return value;
}

async function acquireCompanionOwner({ ownerPath, identity, controllerPath = SCRIPT, probe = probeOwner }) {
  if (!pidValid(identity?.pid) || !TICKS.test(String(identity.startTimeTicks || '')) || !identity.executable || !samePath(identity.controllerPath, controllerPath)) throw Error('Could not verify the native HQPlayer companion process.');
  await fs.mkdir(path.dirname(ownerPath), { recursive: true });
  let handle;
  try { handle = await fs.open(ownerPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let record;
    try { record = validateOwner(JSON.parse(await readBounded(ownerPath, MAX_OWNER)), controllerPath); }
    catch { throw Error('The native HQPlayer companion lock needs inspection; it was preserved.'); }
    const live = await probe(record.pid);
    if (sameIdentity(record, live) && samePath(live.controllerPath, controllerPath) && samePath(live.executable, identity.executable)) return { duplicate: true };
    throw Error('The native HQPlayer companion lock is stale or unverified; it was preserved.');
  }
  const record = { version: 1, ownerId: crypto.randomUUID(), pid: identity.pid, executable: identity.executable,
    startTimeTicks: String(identity.startTimeTicks), controllerPath };
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  catch (error) {
    const a = await handle.stat().catch(() => null), b = await fs.stat(ownerPath).catch(() => null);
    if (a && b && a.dev === b.dev && a.ino === b.ino) await fs.unlink(ownerPath);
    await handle.close(); throw error;
  }
  return { duplicate: false, handle, record, ownerPath };
}

async function releaseCompanionOwner(owned) {
  if (!owned?.handle) return;
  try {
    const current = JSON.parse(await readBounded(owned.ownerPath, MAX_OWNER));
    const a = await owned.handle.stat(), b = await fs.stat(owned.ownerPath);
    if (current?.ownerId !== owned.record.ownerId || !sameIdentity(current, owned.record) || a.dev !== b.dev || a.ino !== b.ino) throw Error('The companion owner changed; its lock was preserved.');
    await fs.unlink(owned.ownerPath);
  } finally { await owned.handle.close(); owned.handle = null; }
}

function createController({ nativeIdentity, expectedExecutable = NATIVE_EXE, nativeProbe = probeNative,
  competitors = assertNoCompetitors, getRoonState = fetchRoonFacts, loadSettings = () => readSettings(SETTINGS),
  getVisualDelay = fetchVisualDelay,
  feedFactory = options => createIntegration({ ...options, settingsPath: SETTINGS }).audioFeed,
  publish = value => atomicStatus(path.join(DATA, 'status.txt'), value),
  publishDiagnostic = value => atomicDiagnostic(path.join(DATA, 'feed-diagnostic.json'), value) } = {}) {
  if (!pidValid(nativeIdentity?.pid) || !TICKS.test(String(nativeIdentity.startTimeTicks || '')) || !samePath(nativeIdentity.executable, expectedExecutable)) throw Error('A verified installed G-Force process is required.');
  let revision = 0, queue = Promise.resolve(), statusQueue = Promise.resolve(), feed = null, current = null, active = false, closed = false;
  let cleanupError = null, closePromise = null, tickPromise = null, pendingPlay = null;
  let diagnosticBusy = false, pendingDiagnostic = null, failedDiagnosticEpoch = -1;
  let visualDelayMs = 0, delaySettingState = 'unknown', delayRead = null;
  const seen = new Set();
  let lastStatus = null;
  const delayStatus = () => ({ state: delaySettingState, delayMs: visualDelayMs });
  const cancelDelayRead = () => delayRead?.controller.abort();
  const refreshDelay = async (epoch, candidate = null) => {
    if (closed || epoch !== revision) return;
    // A tick is already serialized; this also bounds reads across an explicit
    // new request while an older request is being cancelled.
    if (delayRead) await delayRead.promise;
    if (closed || epoch !== revision || candidate && (feed !== candidate || !active)) return;
    const controller = new AbortController();
    let cancel;
    const cancelled = new Promise(resolve => {
      cancel = () => resolve(null);
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const entry = { controller, promise: null };
    delayRead = entry;
    entry.promise = Promise.race([Promise.resolve().then(() => getVisualDelay({ signal: controller.signal })), cancelled])
      .then(value => {
        if (controller.signal.aborted || closed || epoch !== revision || candidate && (feed !== candidate || !active)) return;
        const next = validateDelayMs(value?.currentMs);
        if (candidate && next !== visualDelayMs) candidate.setVisualDelayMs(next);
        visualDelayMs = next; delaySettingState = 'confirmed';
      }).catch(() => {
        if (!controller.signal.aborted && !closed && epoch === revision && (!candidate || feed === candidate && active)) delaySettingState = 'unknown';
        // Retain the last confirmed delay (zero before the first successful
        // read). A service outage must not alter or stop the owned feed.
      }).finally(() => {
        controller.signal.removeEventListener('abort', cancel);
        if (delayRead === entry) delayRead = null;
      });
    await entry.promise;
  };
  const zoneGuard = createHQPlayerZoneGuard(getRoonState);
  const flushDiagnostic = () => {
    if (diagnosticBusy || !pendingDiagnostic) return;
    const entry = pendingDiagnostic; pendingDiagnostic = null;
    // A terminal diagnosis survives Stop/close. Obsolete active measurements
    // must not replace it after another explicit request changed the generation.
    if (entry.value.event === 'active' && entry.epoch !== revision) return;
    diagnosticBusy = true;
    void Promise.resolve().then(() => publishDiagnostic(entry.value)).catch(() => {}).finally(() => {
      diagnosticBusy = false; flushDiagnostic();
    });
  };
  const diagnose = (candidate, request, epoch, event, snapshot) => {
    if (closed || epoch !== revision || !request || failedDiagnosticEpoch === epoch) return;
    try {
      const value = feedDiagnostic(request, { ...(snapshot || candidate.snapshot()), globalDelaySetting: delayStatus() }, event);
      if (event === 'failure') failedDiagnosticEpoch = epoch;
      // At most one write and one pending record. A failure takes precedence over
      // periodic samples and is captured before our cleanup mutates the adapter.
      if (pendingDiagnostic?.value.event === 'failure' && event !== 'failure') return;
      pendingDiagnostic = { value, epoch }; flushDiagnostic();
    } catch { /* Diagnostic collection/writes never control the audio lifecycle. */ }
  };
  const output = (request, state, reason, epoch = revision) => {
    const task = statusQueue.then(async () => {
      if (!request || epoch !== revision) return;
      const value = { pid: request.pid, nonce: request.nonce, state, reason: safeReason(reason) };
      await publish(value); lastStatus = value;
    });
    statusQueue = task.catch(() => {});
    return task;
  };
  const nativeValid = async () => {
    try { return sameIdentity(nativeIdentity, await nativeProbe(nativeIdentity.pid)); }
    catch { return false; } // Unverifiable generations are never allowed to keep feeding audio.
  };
  const settingsPin = settings => Object.freeze({ enabled: settings?.enabled, zoneId: settings?.zoneId,
    outputId: settings?.outputId, fingerprint: settings?.route?.fingerprint });
  const matchesPin = (settings, pin) => settings?.enabled === true && pin.enabled === true &&
    settings.zoneId === pin.zoneId && settings.outputId === pin.outputId && settings.route?.fingerprint === pin.fingerprint;
  const runtimeGuard = async (zoneId, settings, epoch, pin = null) => {
    if (closed || epoch !== revision) throw Error('HQPlayer analysis start was cancelled.');
    if (pin && !matchesPin(settings, pin)) throw Error('The configured HQPlayer analysis source changed or was disabled.');
    if (!await nativeValid()) throw Error('The native G-Force window closed or changed.');
    await competitors({ ownToken: feed?.ownerToken || '' });
    const result = await zoneGuard(zoneId, settings);
    if (closed || epoch !== revision) throw Error('HQPlayer analysis start was cancelled.');
    // Recheck after the bounded Roon read, before the adapter can open its meter.
    if (!await nativeValid()) throw Error('The native G-Force window closed or changed.');
    await competitors({ ownToken: feed?.ownerToken || '' });
    if (closed || epoch !== revision) throw Error('HQPlayer analysis start was cancelled.');
    return result;
  };
  const initialReadiness = async (settings, epoch) => {
    if (closed || epoch !== revision) throw Error('HQPlayer analysis start was cancelled.');
    if (!settings?.enabled) throw Error('HQPlayer music analysis is off.');
    if (!validZoneId(settings.zoneId) || !validZoneId(settings.outputId)) throw Error('Choose the configured Roon HQPlayer zone for the music analysis feed.');
    if (!await nativeValid()) throw Error('The native G-Force window closed or changed.');
    await competitors({ ownToken: feed?.ownerToken || '' });
    const facts = await getRoonState();
    if (!facts?.connected) throw Error('Roon disconnected. Reconnect it before starting HQPlayer visuals.');
    const zone = facts.zones?.find(item => item.zone_id === settings.zoneId);
    if (!zone || !Array.isArray(zone.outputs) || zone.outputs.length !== 1 || zone.outputs[0]?.output_id !== settings.outputId) {
      throw Error('The configured Roon HQPlayer output is unavailable or grouped. Choose its original zone.');
    }
    if (!['paused', 'stopped', 'playing'].includes(zone.state)) throw Error('Play music in the configured Roon HQPlayer zone before starting visuals.');
    if (zone.state !== 'playing' && !/^[a-f0-9]{64}$/.test(settings.route?.fingerprint || '')) {
      throw Error('The dedicated SoundSpectrum cable is not configured. Check the local analysis setup.');
    }
    if (!await nativeValid()) throw Error('The native G-Force window closed or changed.');
    await competitors({ ownToken: feed?.ownerToken || '' });
    if (closed || epoch !== revision) throw Error('HQPlayer analysis start was cancelled.');
    return zone.state;
  };
  const stopOwned = async candidate => {
    active = false;
    try { if (candidate) await candidate.stop(); }
    catch (error) { cleanupError = error; throw error; }
  };
  const cancelNow = candidate => {
    // Attach a rejection handler immediately, even while another queued request
    // is awaiting a bounded device/status probe.
    try { return Promise.resolve(candidate?.stop()).then(() => null, error => error); }
    catch (error) { return Promise.resolve(error); }
  };
  const cleanupReason = 'Owned HQPlayer feed cleanup needs inspection. Choose another input before retrying; no restart was attempted.';
  const waitingReason = error => safeReason(error.message || error) + ' Choose HQPlayer Audio again to retry.';
  const recoverQueue = task => task.catch(async error => {
    // Even an unavailable status file must not leave an unreported feed alive.
    cleanupError = error; pendingPlay = null;
    try { await stopOwned(feed); } catch {}
  });
  const attemptStart = async (validated, epoch, { allowPending = false, pin = null } = {}) => {
    let candidate = null, failedDuringStart = false;
    try {
      await output(validated, 'starting', 'Checking the exact Roon HQPlayer zone and SoundSpectrum cable.', epoch);
      const settings = await loadSettings();
      if (!settings?.enabled || pin && !matchesPin(settings, pin)) throw Error('The configured HQPlayer analysis source changed or was disabled.');
      const originalPin = pin || settingsPin(settings);
      if (allowPending && await initialReadiness(settings, epoch) !== 'playing') {
        pendingPlay = { request: validated, epoch, pin: originalPin };
        await output(validated, 'waiting', 'Waiting for your selected HQPlayer zone to play. Keep HQPlayer Audio selected; choosing another input cancels.', epoch);
        return;
      }
      await runtimeGuard(settings.zoneId, settings, epoch, originalPin);
      if (closed || epoch !== revision) return;
      await refreshDelay(epoch);
      if (closed || epoch !== revision) return;
      candidate = feedFactory({ requireZone: (id, value) => runtimeGuard(id, value, epoch, originalPin), visualDelayMs });
      feed = candidate;
      await candidate.start({ zoneId: settings.zoneId, onFailure: error => {
        if (closed || epoch !== revision) return;
        failedDuringStart = true; active = false; pendingPlay = null;
        diagnose(candidate, validated, epoch, 'failure');
        // The adapter already initiated cleanup; retry only our cleanup so a
        // failed child termination remains a visible, blocking owned lease.
        const cleanup = stopOwned(candidate).then(
          () => output(validated, 'waiting', waitingReason(error), epoch),
          () => output(validated, 'error', cleanupReason, epoch));
        void cleanup.catch(() => {});
      } });
      if (closed || epoch !== revision) { await stopOwned(candidate); return; }
      const snapshot = candidate.snapshot();
      if (failedDuringStart || snapshot.state === 'error') {
        diagnose(candidate, validated, epoch, 'failure', snapshot);
        await stopOwned(candidate);
        await output(validated, 'waiting', waitingReason(snapshot.reason), epoch);
        return;
      }
      active = true;
      await output(validated, snapshot.state === 'receiving' ? 'receiving' : 'waiting', snapshot.reason, epoch);
    } catch (error) {
      if (epoch === revision) pendingPlay = null;
      if (candidate) diagnose(candidate, validated, epoch, 'failure');
      try { await stopOwned(candidate || feed); }
      catch { /* The owned lease remains and blocks any later Start. */ }
      if (!closed && epoch === revision) await output(validated, cleanupError ? 'error' : 'waiting', cleanupError ? cleanupReason : waitingReason(error), epoch);
    }
  };
  const handle = request => {
    if (closed) return Promise.reject(Error('The native HQPlayer companion has closed.'));
    const validated = parseRequest(`action=${request.action}\npid=${request.pid}\nnonce=${request.nonce}\n`);
    if (seen.has(validated.nonce)) return queue;
    seen.add(validated.nonce);
    if (validated.pid !== nativeIdentity.pid) return output(validated, 'error', 'HQPlayer Audio belongs to another native G-Force session.');
    const epoch = ++revision;
    current = validated; active = false; pendingPlay = null;
    cancelDelayRead();
    // Cancel an in-flight adapter start immediately, rather than allowing it to
    // open a meter after a Stop/new selection has already arrived.
    const cancelled = cancelNow(feed);
    const next = queue.then(async () => {
      const cancellationError = await cancelled;
      if (cancellationError) cleanupError = cancellationError;
      if (closed || epoch !== revision) return;
      if (validated.action === 'stop') {
        try {
          await stopOwned(feed); cleanupError = null;
          await output(validated, 'stopped', 'HQPlayer audio feed stopped.', epoch);
        } catch { await output(validated, 'error', cleanupReason, epoch); }
        return;
      }
      if (cleanupError) { await output(validated, 'error', cleanupReason, epoch); return; }
      await attemptStart(validated, epoch, { allowPending: true });
    });
    queue = recoverQueue(next);
    return queue;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true; ++revision;
    active = false; pendingPlay = null;
    cancelDelayRead();
    const cancelled = cancelNow(feed);
    closePromise = (async () => {
      await cancelled; await queue; await stopOwned(feed); cleanupError = null;
      if (current) await output(current, 'stopped', 'Native G-Force closed. HQPlayer audio feed stopped.');
    })();
    return closePromise;
  };
  const runTick = async () => {
    if (closed) return { closed: true };
    if (!await nativeValid()) { await close(); return { closed: true }; }
    if (closed) return { closed: true };
    if (pendingPlay) {
      const intent = pendingPlay;
      try {
        if (cleanupError) throw Error(cleanupReason);
        const settings = await loadSettings();
        if (!matchesPin(settings, intent.pin)) throw Error('The configured HQPlayer analysis source changed or was disabled.');
        const readiness = await initialReadiness(settings, intent.epoch);
        if (closed || intent.epoch !== revision || pendingPlay !== intent) return { closed };
        if (readiness !== 'playing') return { closed: false };
        // Consume this explicit choice once. A later pause/start failure never
        // recreates intent or resumes the feed without another menu selection.
        pendingPlay = null;
        const cancelled = cancelNow(feed);
        queue = recoverQueue(queue.then(async () => {
          const cancellationError = await cancelled;
          if (cancellationError) cleanupError = cancellationError;
          if (closed || intent.epoch !== revision) return;
          if (cleanupError) { await output(intent.request, 'error', cleanupReason, intent.epoch); return; }
          await attemptStart(intent.request, intent.epoch, { pin: intent.pin });
        }));
        await queue;
      } catch (error) {
        if (!closed && intent.epoch === revision && pendingPlay === intent) {
          pendingPlay = null;
          await output(intent.request, cleanupError ? 'error' : 'waiting', cleanupError ? cleanupReason : waitingReason(error), intent.epoch);
        }
      }
      return { closed };
    }
    if (active && feed && current) {
      const epoch = revision, candidate = feed, request = current;
      try { await competitors({ ownToken: candidate.ownerToken || '' }); }
      catch (error) {
        if (epoch !== revision || closed) return { closed };
        diagnose(candidate, request, epoch, 'failure');
        try { await stopOwned(candidate); } catch {}
        await output(request, cleanupError ? 'error' : 'waiting', cleanupError ? cleanupReason : waitingReason(error), epoch);
        return { closed: false };
      }
      if (epoch !== revision || closed || !active) return { closed };
      await refreshDelay(epoch, candidate);
      if (epoch !== revision || closed || !active || feed !== candidate) return { closed };
      const snapshot = candidate.snapshot();
      if (snapshot.state === 'error' || cleanupError) {
        diagnose(candidate, request, epoch, 'failure', snapshot);
        try { await stopOwned(candidate); } catch {}
        await output(request, cleanupError ? 'error' : 'waiting', cleanupError ? cleanupReason : waitingReason(snapshot.reason), epoch);
      } else {
        diagnose(candidate, request, epoch, 'active', snapshot);
        await output(request, snapshot.state === 'receiving' ? 'receiving' : 'waiting', snapshot.reason, epoch);
      }
    }
    return { closed: false };
  };
  const tick = () => {
    if (!tickPromise) tickPromise = runTick().finally(() => { tickPromise = null; });
    return tickPromise;
  };
  return { handle, tick, close, status: () => lastStatus, delayStatus };
}

async function main() {
  if (process.platform !== 'win32' || process.argv.length !== 2) throw Error('This native HQPlayer companion requires its fixed Windows launcher.');
  const requestPath = path.join(DATA, 'request.txt'), ownerPath = path.join(DATA, 'owner.json');
  const initial = await readBounded(requestPath, MAX_REQUEST, { metadata: true });
  const first = parseRequest(initial?.text);
  const identity = await probeOwner(process.pid);
  if (!identity || !samePath(identity.controllerPath, SCRIPT) || !samePath(identity.executable, process.execPath)) throw Error('The companion launcher identity could not be verified.');
  const owned = await acquireCompanionOwner({ ownerPath, identity });
  if (owned.duplicate) return;
  let controller, shuttingDown = false, cleanupSucceeded = false;
  const shutdown = () => { shuttingDown = true; void controller?.close().catch(() => {}); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  try {
    const nativeIdentity = await probeNative(first.pid);
    if (!nativeIdentity || !requestIsFreshForNative(initial.mtimeNs, nativeIdentity.startTimeTicks)) {
      throw Error('The native HQPlayer request is stale or could not be verified. Choose HQPlayer Audio again.');
    }
    controller = createController({ nativeIdentity });
    void controller.handle(first).catch(() => {});
    let lastSafety = 0;
    let safety = null, nativeClosed = false, safetyError = null;
    while (!shuttingDown) {
      const text = await readBounded(requestPath, MAX_REQUEST);
      if (text !== null) {
        let request;
        try { request = parseRequest(text); } catch { /* Ignore incomplete/invalid new requests; never alter a live feed. */ }
        if (request) void controller.handle(request).catch(() => {});
      }
      if (!safety && Date.now() - lastSafety >= 1000) {
        lastSafety = Date.now();
        safety = controller.tick().then(result => { nativeClosed = result.closed; }, error => { safetyError = error; }).finally(() => { safety = null; });
      }
      if (safetyError) throw safetyError;
      if (nativeClosed) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch (error) {
    await atomicStatus(path.join(DATA, 'status.txt'), { ...first, state: 'error', reason: safeReason(error.message) });
    throw error;
  } finally {
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    try { await controller?.close(); cleanupSucceeded = true; }
    finally { if (cleanupSucceeded) await releaseCompanionOwner(owned); else await owned.handle?.close(); }
  }
}

module.exports = { parseRequest, formatStatus, readBounded, requestIsFreshForNative, atomicStatus, atomicDiagnostic, feedDiagnostic, fetchRoonFacts, fetchVisualDelay, scriptArgument,
  competitorPaths, assertNoCompetitors, validateOwner, acquireCompanionOwner, releaseCompanionOwner,
  createController, sameIdentity, main };
if (require.main === module) main().catch(() => { process.exitCode = 1; });
