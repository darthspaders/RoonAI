'use strict';

// Optional, removable HQPlayer analysis observer. Import and inspection do not
// connect a socket, start a child, open an audio client, or write private state.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const { MeterParser, MAX_WIRE_BYTES } = require('./protocol.cjs');
const { MAX_PCM_BYTES, OUTPUT_RATE } = require('./dsp.cjs');
const { PcmDelay } = require('../../src/soundSpectrumPcmDelay');

const INPUT = 'feed:hqplayer-analysis';
const SOURCE = 'roon-hqplayer';
const DATA = path.join(__dirname, '../../data/soundspectrum-hqplayer-feed');
const SETTINGS = path.join(DATA, 'settings.json');
const HOST = '127.0.0.1', PORT = 4322;
const MAX_PCM = OUTPUT_RATE * 4; // At most one second; trim to 250ms during reception.
const MAX_PENDING = 12, MAX_PENDING_SECONDS = 0.25, MAX_PENDING_BYTES = MAX_WIRE_BYTES;
const MAX_METADATA_FRAMES = 16, MAX_METADATA_MS = 500;
const MAX_SOURCE_INACTIVE_MS = 30000;
const MAX_ZONE_TRANSITION_MS = 30000, RECOVERY_HEALTH_MS = 3000, RECOVERY_GAP_MS = 1500;
const OUTPUT_STALL_MS = 2000, PACER_GAP_MS = 250;
const diagnosticZoneState = value => ['playing', 'paused', 'loading', 'stopped'].includes(value) ? value : 'unknown';
const OUTPUT_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'EIO', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT']);
const OUTPUT_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK']);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
const OWNER_BUSY = 'Another HQPlayer analysis owner is active, or its private lock needs cleanup.';
const MAX_OWNER_BYTES = 64 * 1024;
const validPid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ownerStamp = stat => [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs, stat.size].join(':');
const sameOwner = (a, b) => a.stamp === b.stamp && a.bytes.equals(b.bytes);

function processStatus(pid) {
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
}

function completeOwner(value) {
  if (!exactKeys(value, ['version', 'token', 'ownerPid', 'source', 'startedAt', 'children']) ||
      value.version !== 1 || value.source !== SOURCE || typeof value.token !== 'string' || !/^[a-f0-9]{48}$/.test(value.token) ||
      !validPid(value.ownerPid) || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 ||
      !Array.isArray(value.children) || value.children.length !== 2) return false;
  const roles = new Set(), pids = new Set([value.ownerPid]);
  for (const child of value.children) {
    if (!exactKeys(child, ['role', 'pid', 'executable', 'argv', 'launchedAt']) ||
        !['writer', 'analysis'].includes(child.role) || roles.has(child.role) || !validPid(child.pid) || pids.has(child.pid) ||
        typeof child.executable !== 'string' || child.executable.length > 4096 || /[\0\r\n]/.test(child.executable) ||
        !(path.isAbsolute(child.executable) || path.win32.isAbsolute(child.executable)) ||
        !Array.isArray(child.argv) || child.argv.length > 128 ||
        child.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || /\0/.test(arg)) ||
        !Number.isSafeInteger(child.launchedAt) || child.launchedAt < value.startedAt) return false;
    roles.add(child.role); pids.add(child.pid);
  }
  return true;
}

// A bounded, stable regular-file snapshot. Links, partial files, replacements
// and changes during a read are ownership uncertainty, never recovery evidence.
async function readOwnerSnapshot(file, io) {
  const before = await io.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_OWNER_BYTES)) throw Error(OWNER_BUSY);
  const handle = await io.open(file, 'r');
  try {
    if (ownerStamp(await handle.stat({ bigint: true })) !== ownerStamp(before)) throw Error(OWNER_BUSY);
    const bytes = Buffer.alloc(MAX_OWNER_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break; size += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), current = await io.lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || ownerStamp(after) !== ownerStamp(before) ||
        ownerStamp(current) !== ownerStamp(before) || size !== Number(before.size)) throw Error(OWNER_BUSY);
    return { stamp: ownerStamp(before), bytes: bytes.subarray(0, size) };
  } finally { await handle.close(); }
}

function stderrReason(text) {
  if (/AUDCLNT_E_DEVICE_IN_USE|device[^\n]{0,80}(?:already.*in use|in use)|0x8889000a/i.test(text)) return 'device-in-use';
  if (/AUDCLNT_E_DEVICE_INVALIDATED|device[^\n]{0,80}(?:unavailable|invalidated|not found)|failed to open[^\n]{0,80}(?:device|audio)/i.test(text)) return 'device-unavailable';
  if (/AUDCLNT_E_UNSUPPORTED_FORMAT|unsupported[^\n]{0,80}format|0x88890008/i.test(text)) return 'unsupported-format';
  if (/AUDCLNT_E_|wasapi[^\n]{0,80}error|AudioClient[^\n]{0,80}failed/i.test(text)) return 'audio-driver-error';
  if (/\bERROR\b|error:/i.test(text)) return 'pipeline-error';
  if (/\bWARNING\b|warning:/i.test(text)) return 'output-warning';
  return '';
}

async function readSettings(file = SETTINGS) {
  let settings;
  try { settings = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, enabled: false }; throw Error('The HQPlayer analysis settings need repair.'); }
  if (settings.version !== 1 || typeof settings.enabled !== 'boolean' ||
      settings.enabled && (!validId(settings.zoneId) || !validId(settings.outputId))) throw Error('The HQPlayer analysis settings need repair.');
  return settings;
}

function outputReason(reason) {
  if (reason === 'disabled') return 'HQPlayer music analysis is off.';
  if (/^listen-/.test(reason || '')) return 'Disable Windows Listen on the dedicated SoundSpectrum cable before using HQPlayer analysis.';
  if (/^cable-|^route-/.test(reason || '')) return 'The dedicated SoundSpectrum cable changed or is unavailable. Check the local analysis setup.';
  return 'The isolated SoundSpectrum audio output could not be verified.';
}

function lowerPriority(child) {
  if (child?.pid) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
}

function closeChild(child, worker = false) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return; done = true; clearTimeout(killTimer); clearTimeout(deadline);
      child.removeListener('close', onClose); error ? reject(error) : resolve();
    };
    const onClose = () => finish();
    child.once('close', onClose);
    const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, worker ? 250 : 0);
    const deadline = setTimeout(() => finish(Error('An owned visualizer analysis process did not close. Its private owner lock is retained.')), 1500);
    try {
      if (worker && child.connected) child.send({ type: 'close' }, () => {});
      else child.stdin?.destroy();
    } catch {}
  });
}

class SignalMeter {
  constructor() { this.reset(); }
  reset() { this.samples = 0; this.squares = 0; this.peak = 0; this.nonzero = 0; this.clipped = 0; this.at = 0; this.last = null; }
  add(buffer, now) {
    for (let offset = 0; offset < buffer.length; offset += 2) {
      const n = buffer.readInt16LE(offset); this.samples++; this.squares += n * n;
      this.peak = Math.max(this.peak, Math.abs(n)); if (n) this.nonzero++; if (Math.abs(n) >= 32767) this.clipped++; this.at = now;
      if (this.samples === OUTPUT_RATE * 2) { this.last = this.measure(); this.samples = 0; this.squares = 0; this.peak = 0; this.nonzero = 0; this.clipped = 0; }
    }
  }
  measure() {
    const peak = this.peak / 32768, rms = this.samples ? Math.sqrt(this.squares / this.samples) / 32768 : 0;
    return { samples: this.samples, nonzeroSamples: this.nonzero, clippedSamples: this.clipped,
      peak, rms, peakDbfs: peak ? 20 * Math.log10(peak) : null, rmsDbfs: rms ? 20 * Math.log10(rms) : null, silent: rms < 0.0001, at: this.at };
  }
  snapshot(now) {
    const value = this.last || (this.samples ? this.measure() : null); if (!value) return null;
    const { at, ...result } = value; return { ...result, ageMs: Math.max(0, now - at) };
  }
}

class HqplayerFeed {
  constructor({ requireZone, settingsPath = SETTINGS, ownerPath = path.join(path.dirname(settingsPath), 'owner.json'),
    output, spawnImpl = spawn, socketFactory = options => net.createConnection(options),
    clock = Date.now, paceClock = () => performance.now(), timers = true, visualDelayMs = 0,
    processProbe = processStatus, ownerFs = fs } = {}) {
    Object.assign(this, { requireZone, settingsPath, ownerPath, output, clock, paceClock, timers });
    this.processProbe = processProbe; this.ownerFs = ownerFs;
    this.spawn = spawnImpl; this.socketFactory = socketFactory;
    this.visualDelay = new PcmDelay({ delayMs: visualDelayMs });
    this.silenceDebtFrames = 0;
    this.epoch = 0; this.startRequest = 0; this.state = 'disabled'; this.reason = 'HQPlayer music analysis is off.';
    this.zoneId = ''; this.ownerToken = ''; this.writer = null; this.worker = null; this.socket = null;
    this.parser = new MeterParser(); this.derivedSignal = new SignalMeter(); this.submittedSignal = new SignalMeter();
    this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0; this.pcm = []; this.pcmSize = 0;
    this.totalAnalysis = 0; this.totalFrames = 0; this.totalPcm = 0; this.droppedAnalysis = 0; this.droppedPcm = 0; this.overlapResets = 0;
    this.frameAt = 0; this.pcmAt = 0; this.sequence = 0; this.connectionGeneration = 0; this.inflight = null;
    this.analysisGeneration = 0; this.metadataRun = 0; this.metadataAt = 0; this.discardedMetadata = 0; this.lastRejectedHeader = null;
    this.sourceInactive = false; this.sourceInactiveAt = 0; this.inactiveSourceFrames = 0; this.lastInactiveHeader = null;
    this.lastObservedZoneState = 'unknown'; this.lastRejectedZoneState = null;
    this.resetZoneRecovery();
    this.inspectCache = null; this.inspectAt = 0;
    this.retiredChildren = []; this.retiredOwners = [];
    this.claimedTokens = new Set();
    this.resetOutputDiagnostic();
  }
  snapshot() {
    const now = this.clock();
    return { enabled: !!this.settings?.enabled, state: this.state, reason: this.reason, source: SOURCE, zoneId: this.zoneId,
      sourceKind: 'HQPlayer derived music analysis', analysisBytes: this.totalAnalysis, analysisFrames: this.totalFrames,
      encodedBytes: this.totalAnalysis, pcmBytes: this.totalPcm,
      bufferedBytes: this.parser.bufferedBytes + this.pendingBytes + (this.inflight?.bytes || 0) + this.pcmSize + (this.writer?.stdin.writableLength || 0),
      droppedAnalysisFrames: this.droppedAnalysis, droppedPcmFrames: this.droppedPcm, overlapResets: this.overlapResets,
      pcmAgeMs: this.pcmAt ? Math.max(0, now - this.pcmAt) : null,
      derivedSignal: this.derivedSignal.snapshot(now), decodedSignal: this.derivedSignal.snapshot(now), submittedSignal: this.submittedSignal.snapshot(now),
      outputDiagnostic: { ...this.outputDiagnostic, lastProgressAgeMs: this.writer && this.outputProgressAt !== null
        ? Math.max(0, this.paceClock() - this.outputProgressAt) : this.outputDiagnostic.lastProgressAgeMs },
      meterFormat: this.meterFormat || null, delayMs: this.visualDelay.delayMs, visualDelay: this.visualDelay.snapshot(),
      analysisDiagnostic: { discardedMetadataFrames: this.discardedMetadata, metadataRun: this.metadataRun, rejectedHeader: this.lastRejectedHeader,
        sourceInactive: this.sourceInactive, inactiveSourceFrames: this.inactiveSourceFrames,
        sourceInactiveAgeMs: this.sourceInactive ? Math.max(0, now - this.sourceInactiveAt) : null, inactiveHeader: this.lastInactiveHeader,
        zoneState: this.ownerToken ? this.zonePlaybackState : null, observedZoneState: this.lastObservedZoneState, rejectedZoneState: this.lastRejectedZoneState,
        zoneTransitionAgeMs: this.zoneTransitionAt === null ? null : Math.max(0, this.paceClock() - this.zoneTransitionAt),
        reconnectAttempts: this.reconnects || 0 } };
  }
  async inspect(refresh = false) {
    if (!refresh && this.inspectCache && this.clock() - this.inspectAt < 10000) return this.inspectCache;
    let available = false, reason = 'HQPlayer music analysis is off.', settings;
    try {
      settings = await readSettings(this.settingsPath);
      if (!this.ownerToken) this.settings = settings;
      if (settings.enabled) { const probe = await this.output.probeOutput({ settingsPath: this.settingsPath }); available = probe.available === true; reason = available ? '' : outputReason(probe.reason); }
    } catch { reason = 'HQPlayer music analysis could not be checked. Check its local setup.'; }
    if (!this.ownerToken && this.state !== 'error') { this.state = settings?.enabled ? 'waiting' : 'disabled'; this.reason = available ? 'Select Start visuals for the configured Roon HQPlayer zone.' : reason; }
    this.inspectCache = { id: INPUT, name: 'HQPlayer music analysis (experimental)', kind: 'music-feed', source: SOURCE,
      zoneId: settings?.zoneId || '', available, reason }; this.inspectAt = this.clock(); return this.inspectCache;
  }
  async validateStart({ zoneId } = {}) {
    const settings = await readSettings(this.settingsPath);
    if (!settings.enabled) throw Error('HQPlayer music analysis is off.');
    if (!validId(zoneId) || zoneId !== settings.zoneId) throw Error('Choose the exact configured Roon HQPlayer zone for music analysis.');
    if (typeof this.requireZone !== 'function') throw Error('The Roon HQPlayer zone guard is unavailable.');
    await this.requireZone(zoneId, settings);
    return settings;
  }
  async acquireOwner(token, epoch) {
    this.ownerToken = token;
    this.ownershipPromise = (async () => {
      await fs.mkdir(path.dirname(this.ownerPath), { recursive: true }); if (epoch !== this.epoch) return;
      let handle;
      try { handle = await this.ownerFs.open(this.ownerPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.recoverOwner(token, epoch); return;
      }
      await this.writeOwner(handle, token);
    })();
    await this.ownershipPromise;
  }
  async writeOwner(handle, token) {
    try { await handle.writeFile(JSON.stringify({ version: 1, token, ownerPid: process.pid, source: SOURCE, startedAt: this.clock() })); }
    finally { await handle.close(); }
    this.claimedTokens.add(token);
  }
  async recoverOwner(token, epoch) {
    const io = this.ownerFs, guardPath = this.ownerPath + '.recovery';
    const check = () => { if (epoch !== this.epoch) throw Error('HQPlayer analysis start was cancelled.'); };
    const guardBytes = Buffer.from(JSON.stringify({ version: 1, token, ownerPid: process.pid }));
    let guard, guardSnapshot;
    try {
      check();
      try { guard = await io.open(guardPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Error(OWNER_BUSY); throw error; }
      await guard.writeFile(guardBytes); await guard.close(); guard = null;
      guardSnapshot = await readOwnerSnapshot(guardPath, io); check();
      const original = await readOwnerSnapshot(this.ownerPath, io); check();
      let owner; try { owner = JSON.parse(original.bytes.toString('utf8')); } catch { throw Error(OWNER_BUSY); }
      if (!completeOwner(owner)) throw Error(OWNER_BUSY);
      const pids = [owner.ownerPid, ...owner.children.map(child => child.pid)];
      const absent = async () => {
        for (const pid of pids) {
          let status; try { status = await this.processProbe(pid); } catch { status = 'unknown'; }
          check(); if (status !== 'absent') throw Error(OWNER_BUSY);
        }
      };
      await absent();
      if (!sameOwner(original, await readOwnerSnapshot(this.ownerPath, io))) throw Error(OWNER_BUSY); check();
      await absent();
      if (!sameOwner(original, await readOwnerSnapshot(this.ownerPath, io))) throw Error(OWNER_BUSY); check();
      if (!sameOwner(guardSnapshot, await readOwnerSnapshot(guardPath, io))) throw Error(OWNER_BUSY); check();
      await io.rm(this.ownerPath); check();
      // A normal wx claimant may win this gap. Never recover twice or remove
      // its replacement: keep that new claim and fail this Start closed.
      let claimed;
      try { claimed = await io.open(this.ownerPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Error(OWNER_BUSY); throw error; }
      await this.writeOwner(claimed, token);
    } catch (error) {
      if (epoch !== this.epoch) throw Error('HQPlayer analysis start was cancelled.');
      if (error.message === OWNER_BUSY) throw error;
      throw Error(OWNER_BUSY);
    } finally {
      await guard?.close();
      // Never remove somebody else's guard, including a replaced or mutated
      // file. A crash/unknown guard is retained for explicit local inspection.
      if (guardSnapshot) {
        try {
          const current = await readOwnerSnapshot(guardPath, io);
          if (sameOwner(guardSnapshot, current) && current.bytes.equals(guardBytes)) await io.rm(guardPath);
        } catch (error) { if (error.code !== 'ENOENT') throw Error(OWNER_BUSY); }
      }
    }
  }
  async recordChildren(token, epoch, command, writer, worker) {
    this.ownershipPromise = this.ownershipPromise.then(async () => {
      if (epoch !== this.epoch) return;
      const handle = await fs.open(this.ownerPath, 'r+');
      try {
        const owner = JSON.parse(await handle.readFile('utf8'));
        if (owner.token !== token) throw Error('The private HQPlayer analysis owner changed.');
        if (epoch !== this.epoch) return;
        owner.children = [
          { role: 'writer', pid: writer.pid || null, executable: command.command, argv: command.args, launchedAt: this.clock() },
          { role: 'analysis', pid: worker.pid || null, executable: process.execPath, argv: ['--max-old-space-size=64', path.join(__dirname, 'dsp-worker.cjs')], launchedAt: this.clock() }
        ];
        const bytes = Buffer.from(JSON.stringify(owner)); await handle.write(bytes, 0, bytes.length, 0); await handle.truncate(bytes.length);
      } finally { await handle.close(); }
    });
    await this.ownershipPromise;
  }
  async removeOwner(token) {
    if (!token) return;
    try { const owner = JSON.parse(await fs.readFile(this.ownerPath, 'utf8')); if (owner.token === token) await fs.rm(this.ownerPath, { force: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('The private HQPlayer analysis owner could not be cleaned up.'); }
  }
  async start({ zoneId, onFailure = () => {} } = {}) {
    const request = ++this.startRequest;
    await this.stop({ preserveStart: true });
    const epoch = this.epoch;
    const check = () => { if (request !== this.startRequest || epoch !== this.epoch) throw Error('HQPlayer analysis start was cancelled.'); };
    check();
    try {
      this.settings = await this.validateStart({ zoneId }); check();
      const probe = await this.output.probeOutput({ settingsPath: this.settingsPath }); check();
      if (!probe.available) throw Error(outputReason(probe.reason));
      await this.requireZone(zoneId, this.settings); check();
      const command = this.output.buildOutputCommand({ probe });
      const token = crypto.randomBytes(24).toString('hex');
      await this.acquireOwner(token, epoch); check();
      this.zoneId = zoneId; this.outputProbe = probe; this.onFailure = onFailure;
      this.state = 'waiting'; this.reason = 'Waiting for HQPlayer music analysis.';
      this.totalAnalysis = 0; this.totalFrames = 0; this.totalPcm = 0; this.droppedAnalysis = 0; this.droppedPcm = 0; this.overlapResets = 0;
      this.frameAt = 0; this.pcmAt = 0; this.sequence = 0; this.workerReady = false; this.reconnects = 0;
      this.analysisGeneration++; this.metadataRun = 0; this.metadataAt = 0; this.discardedMetadata = 0; this.lastRejectedHeader = null;
      this.sourceInactive = false; this.sourceInactiveAt = 0; this.inactiveSourceFrames = 0; this.lastInactiveHeader = null;
      this.resetZoneRecovery(); this.runtimeVerifiedAt = this.paceClock();
      this.lastObservedZoneState = 'playing'; this.lastRejectedZoneState = null;
      this.derivedSignal.reset(); this.submittedSignal.reset(); this.paceAt = this.paceClock(); this.paceWritten = 0; this.startedAt = this.clock();
      this.resetOutputDiagnostic();
      const writer = this.spawn(command.command, command.args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: command.env || process.env });
      this.writer = writer; lowerPriority(writer);
      const diagnostic = this.outputDiagnostic;
      writer.stdin.on('drain', () => {
        if (epoch !== this.epoch || this.writer !== writer || this.outputDiagnostic !== diagnostic) return;
        diagnostic.drainEvents++; this.outputProgress(writer, epoch);
      });
      writer.stdin.on('error', error => {
        if (this.outputDiagnostic === diagnostic && !diagnostic.errorCode) diagnostic.errorCode = OUTPUT_ERROR_CODES.has(error?.code) ? error.code : 'UNKNOWN';
        if (this.writer === writer && epoch === this.epoch) this.fail('The dedicated visualizer audio output stopped.', epoch);
      });
      writer.stderr.on('data', chunk => {
        if (this.outputDiagnostic !== diagnostic) return;
        this.outputStderrTail = (this.outputStderrTail + Buffer.from(chunk).subarray(-2048).toString('utf8')).slice(-2048);
        const reason = stderrReason(this.outputStderrTail);
        if (reason && (reason !== 'output-warning' || !diagnostic.stderrReason)) diagnostic.stderrReason = reason;
      });
      writer.once('error', error => {
        if (this.outputDiagnostic === diagnostic && !diagnostic.errorCode) diagnostic.errorCode = OUTPUT_ERROR_CODES.has(error?.code) ? error.code : 'UNKNOWN';
        if (this.writer === writer && epoch === this.epoch) this.fail('Could not start the dedicated visualizer audio output.', epoch);
      });
      writer.once('close', (code, signal) => {
        if (this.outputDiagnostic === diagnostic) {
          diagnostic.exitCode = Number.isSafeInteger(code) ? code : null;
          diagnostic.signal = signal ? (OUTPUT_SIGNALS.has(signal) ? signal : 'OTHER') : '';
        }
        if (this.writer === writer && epoch === this.epoch) this.fail('The dedicated visualizer audio output closed.', epoch);
      });
      const worker = this.spawn(process.execPath, ['--max-old-space-size=64', path.join(__dirname, 'dsp-worker.cjs')], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', env: process.env });
      this.worker = worker; lowerPriority(worker); worker.stderr.on('data', () => {});
      worker.on('message', message => { if (this.worker === worker && epoch === this.epoch) this.workerMessage(message, epoch); });
      worker.once('error', () => { if (this.worker === worker) this.fail('Could not start isolated HQPlayer analysis processing.', epoch); });
      worker.once('close', () => { if (this.worker === worker) this.fail('The isolated HQPlayer analysis process closed.', epoch); });
      await this.recordChildren(token, epoch, command, writer, worker); check();
      this.connect(epoch);
      if (this.timers) {
        this.pacer = setInterval(() => this.tick(epoch), 20); this.pacer.unref?.();
        this.safetyTimer = setInterval(() => { void this.checkSafety(epoch); }, 1000); this.safetyTimer.unref?.();
      }
    } catch (error) { if (epoch === this.epoch) await this.stop(); throw error; }
  }
  connect(epoch) {
    if (epoch !== this.epoch || !this.ownerToken) return;
    this.connectionGeneration++; const connection = this.connectionGeneration;
    let socket;
    try { socket = this.socketFactory({ host: HOST, port: PORT, readableHighWaterMark: 64 * 1024 }); }
    catch { this.disconnected(epoch); return; }
    this.socket = socket; socket.setNoDelay?.(true); socket.setTimeout?.(5000);
    // No write(), end(payload), control port or enable command anywhere here.
    socket.on('data', bytes => {
      if (epoch !== this.epoch || this.socket !== socket || connection !== this.connectionGeneration) return;
      try { this.parser.push(bytes); this.totalAnalysis += bytes.length; this.drainFrames(epoch, connection); }
      catch { this.fail('HQPlayer supplied unsupported or excessive analysis data.', epoch); }
    });
    socket.on('timeout', () => {
      if (epoch !== this.epoch || this.socket !== socket) return;
      if (this.zoneTransitionAt !== null && this.paceClock() - this.zoneTransitionAt < MAX_ZONE_TRANSITION_MS) return;
      socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (this.socket === socket && epoch === this.epoch) { this.socket = null; this.disconnected(epoch); } });
  }
  drainFrames(epoch, connection) {
    if (epoch !== this.epoch || connection !== this.connectionGeneration) return;
    clearImmediate(this.drainImmediate); this.drainImmediate = null;
    let frames;
    try { frames = this.parser.drain(8); }
    catch (error) {
      this.lastRejectedHeader = this.headerDiagnostic(error.header, error.code || 'invalid-framing');
      this.fail('HQPlayer supplied unsupported analysis framing.', epoch); return;
    }
    // A frame which began before a source boundary is still parsed/validated,
    // but it cannot produce resumed audio, including a previously partial frame.
    let frameStart = this.totalAnalysis - this.parser.bufferedBytes - frames.reduce((sum, frame) => sum + frame.bytes.length, 0);
    for (const frame of frames) {
      const now = this.clock();
      const playable = frameStart >= this.analysisBoundary && this.zonePlaybackState === 'playing';
      if (playable && this.resetBeforePlayable) { this.sequence++; this.resetBeforePlayable = false; }
      if (!playable) this.resetBeforePlayable = true;
      const sequence = ++this.sequence;
      frameStart += frame.bytes.length;
      this.totalFrames++;
      if (frame.header.transition) {
        this.lastRejectedHeader = this.headerDiagnostic(frame.header, 'unusable-metadata');
        this.discardedMetadata++; this.metadataRun++;
        if (this.metadataRun === 1) this.metadataAt = now;
        while (this.pending.length) this.dropPending();
        this.clearPcm(); this.derivedSignal.reset(); this.analysisGeneration++; this.resetRecoveryHealth();
        this.state = 'waiting'; this.reason = 'Waiting briefly for valid HQPlayer analysis after a format change.';
        if (this.metadataRun >= MAX_METADATA_FRAMES || now - this.metadataAt >= MAX_METADATA_MS) {
          this.fail('HQPlayer analysis metadata did not recover after a format change.', epoch); return;
        }
        continue;
      }
      this.metadataRun = 0; this.metadataAt = 0; this.frameAt = now;
      if (frame.header.sourceInactive !== this.sourceInactive) {
        while (this.pending.length) this.dropPending();
        this.clearPcm(); this.derivedSignal.reset(); this.analysisGeneration++; this.resetRecoveryHealth();
        this.sourceInactive = frame.header.sourceInactive; this.sourceInactiveAt = this.sourceInactive ? now : 0;
      }
      if (this.sourceInactive) {
        this.inactiveSourceFrames++; this.lastInactiveHeader = this.headerDiagnostic(frame.header, 'source-inactive');
        this.state = 'waiting'; this.reason = 'Waiting for HQPlayer source audio. Analysis is silent during the track transition.';
        if (now - this.sourceInactiveAt >= MAX_SOURCE_INACTIVE_MS) {
          this.fail('HQPlayer did not resume source audio. Start visuals again to retry.', epoch); return;
        }
      }
      this.meterFormat = { channels: frame.header.channels, bins: frame.header.bins, sourceBits: frame.header.sourceBits,
        sourceRate: frame.header.sourceRate, hop: frame.header.hop, hopSeconds: frame.header.hopSeconds };
      this.pending.push({ bytes: frame.bytes, sequence, at: now, seconds: frame.header.hopSeconds, playable });
      this.pendingBytes += frame.bytes.length; this.pendingSeconds += frame.header.hopSeconds;
      while (this.pending.length > MAX_PENDING || this.pendingSeconds > MAX_PENDING_SECONDS + 0.0001 || this.pendingBytes > MAX_PENDING_BYTES) this.dropPending();
    }
    this.flushWork(epoch);
    if (frames.length === 8) this.drainImmediate = setImmediate(() => this.drainFrames(epoch, connection));
  }
  headerDiagnostic(header, code) {
    if (!header) return { code };
    const result = { code };
    for (const field of ['version', 'channels', 'bins', 'sourceBits', 'bandwidth', 'hopSeconds', 'transformGain', 'reserved']) {
      result[field] = Number.isFinite(header[field]) ? header[field] : null;
    }
    return result;
  }
  dropPending() {
    const frame = this.pending.shift(); if (!frame) return;
    this.pendingBytes -= frame.bytes.length; this.pendingSeconds -= frame.seconds; this.droppedAnalysis++;
  }
  flushWork(epoch) {
    if (epoch !== this.epoch || this.inflight || !this.workerReady || !this.worker?.connected) return;
    while (this.pending.length && this.clock() - this.pending[0].at > 500) this.dropPending();
    if (!this.pending.length) return;
    const frames = this.pending; this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0;
    this.inflight = { sequence: frames.at(-1).sequence, bytes: frames.reduce((n, frame) => n + frame.bytes.length, 0), at: this.clock(), connection: this.connectionGeneration, analysis: this.analysisGeneration, playable: frames.every(frame => frame.playable) };
    try { this.worker.send({ type: 'frames', epoch, frames: frames.map(({ bytes, sequence }) => ({ bytes, sequence })) }, error => { if (error && epoch === this.epoch) this.fail('The isolated analysis work channel stopped.', epoch); }); }
    catch { this.fail('The isolated analysis work channel stopped.', epoch); }
  }
  workerMessage(message, epoch) {
    if (message?.type === 'ready') { this.workerReady = true; this.flushWork(epoch); return; }
    if (message?.epoch !== epoch) return;
    if (!['pcm', 'failure'].includes(message.type) || !this.inflight || !Number.isSafeInteger(message.sequence) || message.sequence !== this.inflight.sequence) return;
    const work = this.inflight; this.inflight = null;
    const current = work.connection === this.connectionGeneration && work.analysis === this.analysisGeneration;
    if (!current) { this.flushWork(epoch); return; }
    if (message.type === 'failure') { this.fail('HQPlayer supplied unsupported or invalid music analysis.', epoch); return; }
    if (!Buffer.isBuffer(message.pcm) || message.pcm.length > MAX_PCM_BYTES || message.pcm.length % 4) { this.fail('The isolated analysis process supplied invalid PCM.', epoch); return; }
    if (this.zoneTransitionExpired(epoch)) return;
    if (!work.playable || this.zonePlaybackState !== 'playing') { this.flushWork(epoch); return; }
    if (this.clock() - work.at <= 1000) {
      this.overlapResets += Number.isSafeInteger(message.resets) ? message.resets : 0;
      if (message.pcm.length) {
        if (this.pcmSize + message.pcm.length > MAX_PCM) this.discardPcm(Math.ceil((this.pcmSize + message.pcm.length - MAX_PCM) / 4));
        this.pcm.push(message.pcm); this.pcmSize += message.pcm.length; this.totalPcm += message.pcm.length; this.pcmAt = this.clock();
        if (this.pcmSize > OUTPUT_RATE) this.discardPcm(Math.ceil((this.pcmSize - OUTPUT_RATE) / 4));
        this.derivedSignal.add(message.pcm, this.clock());
        if (!this.sourceInactive) {
          this.zoneTransitionAt = null; this.recordRecoveryHealth();
          this.state = 'receiving'; this.reason = 'HQPlayer analysis active. This derived visualization signal has approximate timing.';
        }
      }
    }
    this.flushWork(epoch);
  }
  disconnected(epoch) {
    if (epoch !== this.epoch) return;
    this.connectionGeneration++; this.parser.clear(); this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0;
    this.analysisGeneration++; this.metadataRun = 0; this.metadataAt = 0;
    this.resetRecoveryHealth();
    this.clearPcm(); this.sequence++; // Force overlap reset when a new socket produces its first frame.
    this.state = 'waiting'; this.reason = 'HQPlayer analysis disconnected. Waiting briefly to reconnect.';
    if (++this.reconnects > 3) { this.fail('HQPlayer music analysis disconnected. Start visuals again to retry.', epoch); return; }
    if (this.timers) { this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(epoch); }, this.reconnects * 500); this.reconnectTimer.unref?.(); }
  }
  resetRecoveryHealth() { this.recoveryHealthyAt = null; this.recoveryLastPcmAt = null; }
  resetZoneRecovery() {
    this.zonePlaybackState = 'playing'; this.zoneTransitionAt = null; this.analysisBoundary = 0; this.resetBeforePlayable = false;
    this.runtimeVerifiedAt = null; this.resetRecoveryHealth();
  }
  zoneTransitionExpired(epoch) {
    if (this.zoneTransitionAt === null || this.paceClock() - this.zoneTransitionAt < MAX_ZONE_TRANSITION_MS) return false;
    this.fail('The configured Roon HQPlayer zone did not resume fresh music analysis. Start visuals again to retry.', epoch); return true;
  }
  updateZoneState(state, epoch) {
    // A successful legacy guard returns no facts and has already enforced its
    // own strict-playing policy. Only the explicit main guard permits a gap.
    const next = state === undefined ? 'playing' : state;
    this.lastObservedZoneState = diagnosticZoneState(next);
    if (!['playing', 'paused', 'loading', 'stopped'].includes(next)) {
      this.lastRejectedZoneState = this.lastObservedZoneState;
      throw Object.assign(Error('The configured Roon HQPlayer zone state could not be verified.'), { zoneState: this.lastObservedZoneState });
    }
    if (next !== 'playing' && this.zoneTransitionAt === null) this.zoneTransitionAt = this.paceClock();
    const changed = (this.zonePlaybackState === 'playing') !== (next === 'playing');
    this.zonePlaybackState = next;
    if (changed) {
      while (this.pending.length) this.dropPending();
      this.clearPcm(); this.derivedSignal.reset(); this.submittedSignal.reset();
      this.analysisGeneration++; this.sequence++; this.analysisBoundary = this.totalAnalysis; this.resetRecoveryHealth();
    }
    if (this.zoneTransitionAt !== null) {
      this.state = 'waiting'; this.reason = 'Waiting briefly for the configured Roon HQPlayer zone to resume music analysis.';
      this.zoneTransitionExpired(epoch);
    }
  }
  recordRecoveryHealth() {
    const now = this.paceClock();
    if (this.runtimeVerifiedAt === null || now - this.runtimeVerifiedAt > 2500) { this.resetRecoveryHealth(); return; }
    if (this.recoveryLastPcmAt === null || now - this.recoveryLastPcmAt > RECOVERY_GAP_MS) this.recoveryHealthyAt = now;
    this.recoveryLastPcmAt = now;
    if (now - this.recoveryHealthyAt >= RECOVERY_HEALTH_MS) this.reconnects = 0;
  }
  resetOutputDiagnostic() {
    clearImmediate(this.outputDeferredCheck); this.outputDeferredCheck = null;
    this.outputDiagnostic = { writeCalls: 0, writeCompletions: 0, drainEvents: 0, backpressureEvents: 0,
      blockedMs: 0, maxBlockedMs: 0, lastProgressAgeMs: null, writableBytes: 0, peakWritableBytes: 0,
      droppedOnBackpressureFrames: 0, pacerGaps: 0, maxPacerGapMs: 0, exitCode: null, signal: '', errorCode: '', stderrReason: '' };
    this.outputBlockedAt = null; this.outputProgressAt = null; this.outputProgressSerial = 0;
    this.outputWritableBytes = 0; this.outputPacerAt = null; this.outputStderrTail = '';
  }
  outputProgress(writer, epoch) {
    if (epoch !== this.epoch || this.writer !== writer) return;
    const now = this.paceClock();
    this.outputProgressAt = now; this.outputProgressSerial++;
    this.outputDiagnostic.lastProgressAgeMs = 0;
    if (this.outputBlockedAt !== null) this.outputBlockedAt = now;
    if (!this.outputIsBlocked(writer)) { this.outputBlockedAt = null; this.outputDiagnostic.blockedMs = 0; }
    clearImmediate(this.outputDeferredCheck); this.outputDeferredCheck = null;
  }
  outputIsBlocked(writer) { return writer.stdin.writableNeedDrain || writer.stdin.writableLength > 65536; }
  observeOutput(writer, epoch) {
    const bytes = Number.isFinite(writer.stdin.writableLength) ? Math.max(0, writer.stdin.writableLength) : 0;
    if (bytes < this.outputWritableBytes) this.outputProgress(writer, epoch);
    this.outputWritableBytes = bytes;
    this.outputDiagnostic.writableBytes = bytes;
    this.outputDiagnostic.peakWritableBytes = Math.max(this.outputDiagnostic.peakWritableBytes, bytes);
  }
  checkOutputStall(writer, epoch, diagnostic) {
    if (epoch !== this.epoch || this.writer !== writer || this.outputDiagnostic !== diagnostic || writer.stdin.destroyed) return;
    this.observeOutput(writer, epoch);
    if (!this.outputIsBlocked(writer)) { this.outputBlockedAt = null; diagnostic.blockedMs = 0; return; }
    diagnostic.blockedMs = this.outputBlockedAt === null ? 0 : Math.max(0, this.paceClock() - this.outputBlockedAt);
    diagnostic.maxBlockedMs = Math.max(diagnostic.maxBlockedMs, diagnostic.blockedMs);
    if (diagnostic.blockedMs > OUTPUT_STALL_MS) {
      diagnostic.errorCode = 'BACKPRESSURE_TIMEOUT';
      this.fail('The visualizer analysis output fell behind.', epoch);
    }
  }
  setVisualDelayMs(milliseconds, options) { return this.visualDelay.setDelayMs(milliseconds, options); }
  rebasePacer(now = this.paceClock()) {
    const skipped = Number.isFinite(this.paceAt) ? Math.max(0, Math.floor((now - this.paceAt) * OUTPUT_RATE / 1000) - this.paceWritten) : 0;
    this.visualDelay.skipFrames(skipped);
    this.paceAt = now; this.paceWritten = 0; this.silenceDebtFrames = 0;
  }
  clearPcm() {
    this.pcm = []; this.pcmSize = 0;
    // A source boundary drops unsynthesized/live work, but accepted delayed PCM
    // keeps draining through the same writer while fresh input becomes silence.
    if (this.writer) {
      const due = Math.max(0, Math.floor((this.paceClock() - this.paceAt) * OUTPUT_RATE / 1000) - this.paceWritten);
      this.silenceDebtFrames = Math.max(this.silenceDebtFrames, due);
    } else this.rebasePacer();
  }
  takeLivePcm(frames) {
    const silent = Math.min(frames, this.silenceDebtFrames); this.silenceDebtFrames -= silent;
    if (!silent) return this.takePcm(frames * 4);
    const result = Buffer.alloc(frames * 4);
    if (silent < frames) this.takePcm((frames - silent) * 4).copy(result, silent * 4);
    return result;
  }
  discardLiveFrames(frames) {
    const silent = Math.min(frames, this.silenceDebtFrames); this.silenceDebtFrames -= silent;
    this.discardPcm(frames - silent);
  }
  takePcm(bytes) {
    const result = Buffer.alloc(bytes); let offset = 0;
    while (offset < bytes && this.pcm.length) {
      const first = this.pcm[0], count = Math.min(first.length, bytes - offset); first.copy(result, offset, 0, count); offset += count; this.pcmSize -= count;
      if (count === first.length) this.pcm.shift(); else this.pcm[0] = first.subarray(count);
    }
    return result;
  }
  discardPcm(frames) {
    let bytes = Math.min(this.pcmSize, frames * 4); this.droppedPcm += bytes / 4;
    while (bytes && this.pcm.length) { const first = this.pcm[0], count = Math.min(first.length, bytes); bytes -= count; this.pcmSize -= count;
      if (count === first.length) this.pcm.shift(); else this.pcm[0] = first.subarray(count); }
  }
  tick(epoch = this.epoch) {
    if (epoch !== this.epoch || !this.writer || this.writer.stdin.destroyed) return;
    const writer = this.writer, diagnostic = this.outputDiagnostic, paceNow = this.paceClock();
    const gap = this.outputPacerAt === null ? 0 : Math.max(0, paceNow - this.outputPacerAt);
    this.outputPacerAt = paceNow;
    if (gap > PACER_GAP_MS) { diagnostic.pacerGaps++; diagnostic.maxPacerGapMs = Math.max(diagnostic.maxPacerGapMs, gap); }
    this.observeOutput(writer, epoch);
    const now = this.clock();
    if (this.zoneTransitionExpired(epoch)) return;
    if (this.recoveryLastPcmAt !== null && paceNow - this.recoveryLastPcmAt > RECOVERY_GAP_MS) this.resetRecoveryHealth();
    if (this.sourceInactive && now - this.sourceInactiveAt >= MAX_SOURCE_INACTIVE_MS) {
      this.fail('HQPlayer did not resume source audio. Start visuals again to retry.', epoch); return;
    }
    if (this.metadataRun && now - this.metadataAt >= MAX_METADATA_MS) {
      this.fail('HQPlayer analysis metadata did not recover after a format change.', epoch); return;
    }
    if (this.outputIsBlocked(writer)) {
      if (this.outputBlockedAt === null) { this.outputBlockedAt = paceNow; diagnostic.backpressureEvents++; }
      const discarded = this.pcmSize / 4; this.discardPcm(discarded); diagnostic.droppedOnBackpressureFrames += discarded;
      this.rebasePacer(paceNow);
      diagnostic.blockedMs = Math.max(0, paceNow - this.outputBlockedAt);
      diagnostic.maxBlockedMs = Math.max(diagnostic.maxBlockedMs, diagnostic.blockedMs);
      if (diagnostic.blockedMs > OUTPUT_STALL_MS && gap > PACER_GAP_MS) {
        // A late timer can run before already-queued pipe completion/drain.
        // Give that I/O one turn, then retain the same no-progress deadline.
        if (!this.outputDeferredCheck) {
          const deferred = setImmediate(() => {
            if (this.outputDeferredCheck !== deferred) return;
            this.outputDeferredCheck = null; this.checkOutputStall(writer, epoch, diagnostic);
          });
          this.outputDeferredCheck = deferred;
        }
      } else if (!this.outputDeferredCheck) this.checkOutputStall(writer, epoch, diagnostic);
      return;
    }
    this.outputBlockedAt = null; diagnostic.blockedMs = 0;
    if (this.frameAt && now - this.frameAt > 1500 && this.state !== 'waiting') { this.clearPcm(); this.state = 'waiting'; this.reason = 'Waiting for fresh HQPlayer music analysis.'; }
    if (this.zoneTransitionAt === null && now - (this.frameAt || this.startedAt) > 10000) { this.fail('HQPlayer is not supplying fresh music analysis. Start visuals again to retry.', epoch); return; }
    if (this.inflight && now - this.inflight.at > 2000 || !this.workerReady && now - this.startedAt > 5000) { this.fail('Isolated HQPlayer analysis processing timed out.', epoch); return; }
    let due = Math.floor(Math.max(0, this.paceClock() - this.paceAt) * OUTPUT_RATE / 1000) - this.paceWritten;
    if (due <= 0) return;
    const cap = OUTPUT_RATE / 10;
    if (due > OUTPUT_RATE / 2) { const skipped = due - cap; this.discardLiveFrames(skipped); this.visualDelay.skipFrames(skipped); this.paceWritten += skipped; due -= skipped; }
    const frames = Math.min(due, cap), pcm = this.visualDelay.process(this.takeLivePcm(frames)); this.paceWritten += frames;
    try {
      diagnostic.writeCalls++;
      writer.stdin.write(pcm, error => {
        if (epoch !== this.epoch || this.writer !== writer || this.outputDiagnostic !== diagnostic) return;
        if (error) {
          diagnostic.errorCode = OUTPUT_ERROR_CODES.has(error.code) ? error.code : 'UNKNOWN';
          this.fail('The dedicated visualizer analysis output stopped.', epoch); return;
        }
        diagnostic.writeCompletions++; this.outputProgress(writer, epoch);
      });
      this.outputWritableBytes = Number.isFinite(writer.stdin.writableLength) ? Math.max(0, writer.stdin.writableLength) : 0;
      diagnostic.writableBytes = this.outputWritableBytes; diagnostic.peakWritableBytes = Math.max(diagnostic.peakWritableBytes, this.outputWritableBytes);
      this.submittedSignal.add(pcm, now);
    }
    catch (error) {
      if (!diagnostic.errorCode) diagnostic.errorCode = OUTPUT_ERROR_CODES.has(error?.code) ? error.code : 'UNKNOWN';
      this.fail('The dedicated visualizer analysis output stopped.', epoch);
    }
  }
  async checkSafety(epoch = this.epoch) {
    if (this.checking || epoch !== this.epoch || !this.ownerToken) return;
    const marker = {}; this.checking = marker;
    try {
      const settings = await readSettings(this.settingsPath); if (epoch !== this.epoch) return;
      if (!settings.enabled || settings.zoneId !== this.settings.zoneId || settings.outputId !== this.settings.outputId ||
          settings.route?.fingerprint !== this.settings.route?.fingerprint) throw Error('The configured HQPlayer analysis source changed or was disabled.');
      const zone = await this.requireZone(this.zoneId, settings, { allowInactive: true }); if (epoch !== this.epoch) return;
      // Mute an allowed pause/loading gap immediately; resume only after the cable also
      // passes its existing exact-route/Listen guard.
      const zoneState = zone?.state;
      if (zoneState !== undefined && zoneState !== 'playing') this.updateZoneState(zoneState, epoch);
      if (epoch !== this.epoch) return;
      const probe = await this.output.validateOutput(this.outputProbe, { settingsPath: this.settingsPath }); if (epoch !== this.epoch) return;
      if (!probe.available) throw Error(outputReason(probe.reason));
      this.runtimeVerifiedAt = this.paceClock(); this.updateZoneState(zoneState, epoch);
    } catch (error) {
      if (epoch === this.epoch) {
        if (error && Object.hasOwn(error, 'zoneState')) {
          this.lastObservedZoneState = diagnosticZoneState(error.zoneState);
          this.lastRejectedZoneState = this.lastObservedZoneState;
        }
        this.fail(error.message || 'The Roon HQPlayer analysis source could not be checked.', epoch);
      }
    }
    finally { if (this.checking === marker) this.checking = null; }
  }
  fail(reason, epoch) {
    if (epoch !== this.epoch || this.state === 'error') return;
    this.state = 'error'; this.reason = reason; const callback = this.onFailure;
    // Capture the safe observed state before Stop resets live recovery state.
    const error = Object.assign(Error(reason), { zoneState: this.lastObservedZoneState });
    this.failureCleanup = this.stop({ preserveError: true }).then(() => callback?.(error), () => callback?.(error)).catch(() => {});
  }
  async stop({ preserveError = false, preserveStart = false } = {}) {
    if (!preserveStart) ++this.startRequest;
    this.visualDelay.reset();
    ++this.epoch; clearInterval(this.pacer); clearInterval(this.safetyTimer); clearTimeout(this.reconnectTimer); clearImmediate(this.drainImmediate);
    clearImmediate(this.outputDeferredCheck); this.outputDeferredCheck = null;
    if (this.outputProgressAt !== null) this.outputDiagnostic.lastProgressAgeMs = Math.max(0, this.paceClock() - this.outputProgressAt);
    this.outputBlockedAt = null;
    this.pacer = null; this.safetyTimer = null; this.reconnectTimer = null; this.drainImmediate = null;
    const socket = this.socket; this.socket = null; socket?.destroy(); this.connectionGeneration++;
    const writer = this.writer, worker = this.worker, token = this.ownerToken, ownership = this.ownershipPromise;
    this.writer = null; this.worker = null; this.ownerToken = ''; this.workerReady = false; this.inflight = null; this.zoneId = '';
    this.checking = null;
    this.sourceInactive = false; this.sourceInactiveAt = 0;
    this.resetZoneRecovery();
    this.parser.clear(); this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0; this.clearPcm(); this.visualDelay.reset(); this.meterFormat = null;
    if (!preserveError) { this.state = this.settings?.enabled ? 'waiting' : 'disabled'; this.reason = this.settings?.enabled ? 'Select Start visuals for the configured Roon HQPlayer zone.' : 'HQPlayer music analysis is off.'; }
    const previous = this.cleanupPromise;
    this.cleanupPromise = (async () => {
      await previous?.catch(() => {}); await ownership?.catch(() => {});
      const candidates = [...this.retiredChildren, { child: writer, worker: false }, { child: worker, worker: true }].filter(item => item.child);
      const unique = [...new Map(candidates.map(item => [item.child, item])).values()];
      const owners = [...new Set([...this.retiredOwners, token].filter(owner => this.claimedTokens.has(owner)))];
      const results = await Promise.allSettled(unique.map(item => closeChild(item.child, item.worker)));
      this.retiredChildren = unique.filter((item, i) => results[i].status === 'rejected'); this.retiredOwners = owners;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      for (const owner of owners) { await this.removeOwner(owner); this.claimedTokens.delete(owner); }
      this.retiredOwners = [];
    })();
    await this.cleanupPromise;
  }
}

function createIntegration(options = {}) {
  const output = options.output || require('./audio-output.cjs');
  const settingsPath = options.settingsPath || SETTINGS;
  const audioFeed = new HqplayerFeed({ ...options, settingsPath, output });
  return { audioFeed, additionalInputProvider: output.createInputProvider({ settingsPath }) };
}

module.exports = { HqplayerFeed, SignalMeter, createIntegration, readSettings, validId, INPUT, SOURCE, SETTINGS, HOST, PORT, MAX_PCM, closeChild };
