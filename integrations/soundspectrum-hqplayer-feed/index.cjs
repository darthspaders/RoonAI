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

const INPUT = 'feed:hqplayer-analysis';
const SOURCE = 'roon-hqplayer';
const DATA = path.join(__dirname, '../../data/soundspectrum-hqplayer-feed');
const SETTINGS = path.join(DATA, 'settings.json');
const HOST = '127.0.0.1', PORT = 4322;
const MAX_PCM = OUTPUT_RATE * 4; // At most one second; trim to 250ms during reception.
const MAX_PENDING = 12, MAX_PENDING_SECONDS = 0.25, MAX_PENDING_BYTES = MAX_WIRE_BYTES;
const MAX_METADATA_FRAMES = 16, MAX_METADATA_MS = 500;
const MAX_SOURCE_INACTIVE_MS = 30000;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);

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
    clock = Date.now, paceClock = () => performance.now(), timers = true } = {}) {
    Object.assign(this, { requireZone, settingsPath, ownerPath, output, clock, paceClock, timers });
    this.spawn = spawnImpl; this.socketFactory = socketFactory;
    this.epoch = 0; this.startRequest = 0; this.state = 'disabled'; this.reason = 'HQPlayer music analysis is off.';
    this.zoneId = ''; this.ownerToken = ''; this.writer = null; this.worker = null; this.socket = null;
    this.parser = new MeterParser(); this.derivedSignal = new SignalMeter(); this.submittedSignal = new SignalMeter();
    this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0; this.pcm = []; this.pcmSize = 0;
    this.totalAnalysis = 0; this.totalFrames = 0; this.totalPcm = 0; this.droppedAnalysis = 0; this.droppedPcm = 0; this.overlapResets = 0;
    this.frameAt = 0; this.pcmAt = 0; this.sequence = 0; this.connectionGeneration = 0; this.inflight = null;
    this.analysisGeneration = 0; this.metadataRun = 0; this.metadataAt = 0; this.discardedMetadata = 0; this.lastRejectedHeader = null;
    this.sourceInactive = false; this.sourceInactiveAt = 0; this.inactiveSourceFrames = 0; this.lastInactiveHeader = null;
    this.inspectCache = null; this.inspectAt = 0;
    this.retiredChildren = []; this.retiredOwners = [];
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
      meterFormat: this.meterFormat || null, delayMs: 0,
      analysisDiagnostic: { discardedMetadataFrames: this.discardedMetadata, metadataRun: this.metadataRun, rejectedHeader: this.lastRejectedHeader,
        sourceInactive: this.sourceInactive, inactiveSourceFrames: this.inactiveSourceFrames,
        sourceInactiveAgeMs: this.sourceInactive ? Math.max(0, now - this.sourceInactiveAt) : null, inactiveHeader: this.lastInactiveHeader } };
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
      try { handle = await fs.open(this.ownerPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Error('Another HQPlayer analysis owner is active, or its private lock needs cleanup.'); throw error; }
      try { await handle.writeFile(JSON.stringify({ version: 1, token, ownerPid: process.pid, source: SOURCE, startedAt: this.clock() })); }
      finally { await handle.close(); }
    })();
    await this.ownershipPromise;
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
      this.derivedSignal.reset(); this.submittedSignal.reset(); this.paceAt = this.paceClock(); this.paceWritten = 0; this.startedAt = this.clock();
      const writer = this.spawn(command.command, command.args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: command.env || process.env });
      this.writer = writer; lowerPriority(writer);
      writer.stdin.on('error', () => { if (this.writer === writer) this.fail('The dedicated visualizer audio output stopped.', epoch); });
      writer.stderr.on('data', () => {});
      writer.once('error', () => { if (this.writer === writer) this.fail('Could not start the dedicated visualizer audio output.', epoch); });
      writer.once('close', () => { if (this.writer === writer) this.fail('The dedicated visualizer audio output closed.', epoch); });
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
    socket.on('timeout', () => { if (this.socket === socket) socket.destroy(); });
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
    for (const frame of frames) {
      const now = this.clock(), sequence = ++this.sequence;
      this.totalFrames++;
      if (frame.header.transition) {
        this.lastRejectedHeader = this.headerDiagnostic(frame.header, 'unusable-metadata');
        this.discardedMetadata++; this.metadataRun++;
        if (this.metadataRun === 1) this.metadataAt = now;
        while (this.pending.length) this.dropPending();
        this.clearPcm(); this.derivedSignal.reset(); this.analysisGeneration++;
        this.state = 'waiting'; this.reason = 'Waiting briefly for valid HQPlayer analysis after a format change.';
        if (this.metadataRun >= MAX_METADATA_FRAMES || now - this.metadataAt >= MAX_METADATA_MS) {
          this.fail('HQPlayer analysis metadata did not recover after a format change.', epoch); return;
        }
        continue;
      }
      this.metadataRun = 0; this.metadataAt = 0; this.frameAt = now;
      if (frame.header.sourceInactive !== this.sourceInactive) {
        while (this.pending.length) this.dropPending();
        this.clearPcm(); this.derivedSignal.reset(); this.analysisGeneration++;
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
      this.pending.push({ bytes: frame.bytes, sequence, at: now, seconds: frame.header.hopSeconds });
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
    this.inflight = { sequence: frames.at(-1).sequence, bytes: frames.reduce((n, frame) => n + frame.bytes.length, 0), at: this.clock(), connection: this.connectionGeneration, analysis: this.analysisGeneration };
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
    if (this.clock() - work.at <= 1000) {
      this.overlapResets += Number.isSafeInteger(message.resets) ? message.resets : 0;
      if (message.pcm.length) {
        if (this.pcmSize + message.pcm.length > MAX_PCM) this.discardPcm(Math.ceil((this.pcmSize + message.pcm.length - MAX_PCM) / 4));
        this.pcm.push(message.pcm); this.pcmSize += message.pcm.length; this.totalPcm += message.pcm.length; this.pcmAt = this.clock();
        if (this.pcmSize > OUTPUT_RATE) this.discardPcm(Math.ceil((this.pcmSize - OUTPUT_RATE) / 4));
        this.derivedSignal.add(message.pcm, this.clock());
        if (!this.sourceInactive) { this.state = 'receiving'; this.reason = 'HQPlayer analysis active. This derived visualization signal has approximate timing.'; }
      }
    }
    this.flushWork(epoch);
  }
  disconnected(epoch) {
    if (epoch !== this.epoch) return;
    this.connectionGeneration++; this.parser.clear(); this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0;
    this.analysisGeneration++; this.metadataRun = 0; this.metadataAt = 0;
    this.clearPcm(); this.sequence++; // Force overlap reset when a new socket produces its first frame.
    this.state = 'waiting'; this.reason = 'HQPlayer analysis disconnected. Waiting briefly to reconnect.';
    if (++this.reconnects > 3) { this.fail('HQPlayer music analysis disconnected. Start visuals again to retry.', epoch); return; }
    if (this.timers) { this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(epoch); }, this.reconnects * 500); this.reconnectTimer.unref?.(); }
  }
  clearPcm() { this.pcm = []; this.pcmSize = 0; this.paceAt = this.paceClock(); this.paceWritten = 0; this.outputBlockedAt = 0; }
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
    const now = this.clock();
    if (this.sourceInactive && now - this.sourceInactiveAt >= MAX_SOURCE_INACTIVE_MS) {
      this.fail('HQPlayer did not resume source audio. Start visuals again to retry.', epoch); return;
    }
    if (this.metadataRun && now - this.metadataAt >= MAX_METADATA_MS) {
      this.fail('HQPlayer analysis metadata did not recover after a format change.', epoch); return;
    }
    if (this.writer.stdin.writableNeedDrain || this.writer.stdin.writableLength > 65536) {
      this.outputBlockedAt ||= now;
      if (now - this.outputBlockedAt > 2000) this.fail('The visualizer analysis output fell behind.', epoch);
      return;
    }
    this.outputBlockedAt = 0;
    if (this.frameAt && now - this.frameAt > 1500 && this.state !== 'waiting') { this.clearPcm(); this.state = 'waiting'; this.reason = 'Waiting for fresh HQPlayer music analysis.'; }
    if (now - (this.frameAt || this.startedAt) > 10000) { this.fail('HQPlayer is not supplying fresh music analysis. Start visuals again to retry.', epoch); return; }
    if (this.inflight && now - this.inflight.at > 2000 || !this.workerReady && now - this.startedAt > 5000) { this.fail('Isolated HQPlayer analysis processing timed out.', epoch); return; }
    let due = Math.floor(Math.max(0, this.paceClock() - this.paceAt) * OUTPUT_RATE / 1000) - this.paceWritten;
    if (due <= 0) return;
    const cap = OUTPUT_RATE / 10;
    if (due > OUTPUT_RATE / 2) { const skipped = due - cap; this.discardPcm(skipped); this.paceWritten += skipped; due -= skipped; }
    const frames = Math.min(due, cap), pcm = this.takePcm(frames * 4); this.paceWritten += frames;
    try { this.writer.stdin.write(pcm); this.submittedSignal.add(pcm, now); }
    catch { this.fail('The dedicated visualizer analysis output stopped.', epoch); }
  }
  async checkSafety(epoch = this.epoch) {
    if (this.checking || epoch !== this.epoch || !this.ownerToken) return;
    const marker = {}; this.checking = marker;
    try {
      const settings = await readSettings(this.settingsPath); if (epoch !== this.epoch) return;
      if (!settings.enabled || settings.zoneId !== this.settings.zoneId || settings.outputId !== this.settings.outputId ||
          settings.route?.fingerprint !== this.settings.route?.fingerprint) throw Error('The configured HQPlayer analysis source changed or was disabled.');
      await this.requireZone(this.zoneId, settings); if (epoch !== this.epoch) return;
      const probe = await this.output.validateOutput(this.outputProbe, { settingsPath: this.settingsPath }); if (epoch !== this.epoch) return;
      if (!probe.available) throw Error(outputReason(probe.reason));
    } catch (error) { if (epoch === this.epoch) this.fail(error.message || 'The Roon HQPlayer analysis source could not be checked.', epoch); }
    finally { if (this.checking === marker) this.checking = null; }
  }
  fail(reason, epoch) {
    if (epoch !== this.epoch || this.state === 'error') return;
    this.state = 'error'; this.reason = reason; const callback = this.onFailure;
    this.failureCleanup = this.stop({ preserveError: true }).then(() => callback?.(Error(reason)), () => callback?.(Error(reason))).catch(() => {});
  }
  async stop({ preserveError = false, preserveStart = false } = {}) {
    if (!preserveStart) ++this.startRequest;
    ++this.epoch; clearInterval(this.pacer); clearInterval(this.safetyTimer); clearTimeout(this.reconnectTimer); clearImmediate(this.drainImmediate);
    this.pacer = null; this.safetyTimer = null; this.reconnectTimer = null; this.drainImmediate = null;
    const socket = this.socket; this.socket = null; socket?.destroy(); this.connectionGeneration++;
    const writer = this.writer, worker = this.worker, token = this.ownerToken, ownership = this.ownershipPromise;
    this.writer = null; this.worker = null; this.ownerToken = ''; this.workerReady = false; this.inflight = null; this.zoneId = '';
    this.checking = null;
    this.sourceInactive = false; this.sourceInactiveAt = 0;
    this.parser.clear(); this.pending = []; this.pendingBytes = 0; this.pendingSeconds = 0; this.clearPcm(); this.meterFormat = null;
    if (!preserveError) { this.state = this.settings?.enabled ? 'waiting' : 'disabled'; this.reason = this.settings?.enabled ? 'Select Start visuals for the configured Roon HQPlayer zone.' : 'HQPlayer music analysis is off.'; }
    const previous = this.cleanupPromise;
    this.cleanupPromise = (async () => {
      await previous?.catch(() => {}); await ownership?.catch(() => {});
      const candidates = [...this.retiredChildren, { child: writer, worker: false }, { child: worker, worker: true }].filter(item => item.child);
      const unique = [...new Map(candidates.map(item => [item.child, item])).values()];
      const owners = [...new Set([...this.retiredOwners, token].filter(Boolean))];
      const results = await Promise.allSettled(unique.map(item => closeChild(item.child, item.worker)));
      this.retiredChildren = unique.filter((item, i) => results[i].status === 'rejected'); this.retiredOwners = owners;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      for (const owner of owners) await this.removeOwner(owner);
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
