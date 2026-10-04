'use strict';

// Removable experiment. Importing this module creates no socket, audio device,
// decoder, timer, or demand file. Only an explicit SoundSpectrum Start does so.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data/soundspectrum-audio-feed');
const SETTINGS = path.join(DATA, 'settings.json');
const DEMAND = path.join(DATA, 'demand.json');
const INPUT = 'feed:pre-hqplayer';
const MAX_ENCODED = 8 * 1024 * 1024;
const MAX_PCM = 8 * 1024 * 1024;
const PCM_RATE = 44100, FRAME_BYTES = 4, MAX_TICK_FRAMES = 4410;
const validPlayer = value => typeof value === 'string' && /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value);
function outputReason(reason) {
  if (reason === 'disabled') return 'The experimental music feed is off.';
  if (reason === 'listen-enabled' || reason === 'listen-unknown') return 'Disable Windows “Listen to this device” on the SoundSpectrum cable before using the music feed.';
  if (/^cable-/.test(reason || '') || reason === 'route-not-verified') return 'The dedicated SoundSpectrum cable changed or is unavailable. Check the local feed setup.';
  if (/^runtime-|^shared-wasapi-/.test(reason || '')) return 'The isolated audio-output runtime needs repair.';
  return 'The dedicated visualizer audio cable could not be verified.';
}

async function readSettings(file = SETTINGS) {
  try {
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    if (settings.version !== 1 || typeof settings.enabled !== 'boolean') throw Error('Invalid audio-feed settings.');
    const delayMs = Number(settings.delayMs || 0);
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw Error('Invalid visual delay.');
    return { ...settings, delayMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, enabled: false, delayMs: 0 };
    throw Error('The experimental audio-feed settings need repair.');
  }
}

function packet(header, payload = Buffer.alloc(0)) {
  const head = Buffer.from(JSON.stringify(header) + '\n');
  if (head.length > 1024 || payload.length > 32768) throw Error('Audio-copy packet is too large.');
  return Buffer.concat([head, payload]);
}

function parsePacket(buffer, remote, token, playerId) {
  if (remote.address !== '127.0.0.1' || buffer.length > 33792) return null;
  const separator = buffer.indexOf(10);
  if (separator < 0 || separator > 1024) return null;
  let header;
  try { header = JSON.parse(buffer.subarray(0, separator).toString('utf8')); } catch { return null; }
  if (header.v !== 1 || header.token !== token || header.playerId !== playerId ||
      typeof header.generation !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(header.generation) ||
      !Number.isSafeInteger(header.sequence) || header.sequence < 0 ||
      !['begin', 'data', 'end', 'status'].includes(header.type)) return null;
  return { header, payload: buffer.subarray(separator + 1) };
}

function buildDecodeCommand(settings, env = process.env) {
  return { command: settings.ffmpegExecutable || env.FFMPEG_PATH || 'ffmpeg',
    args: ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'flac', '-i', 'pipe:0',
      '-vn', '-ac', '2', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1'], env };
}

function lowerPriority(child) {
  if (!child.pid) return;
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
}

// One second of scalar measurements, with no retained audio. Byte counters alone
// cannot distinguish music from zero-filled PCM or an output path losing audio.
class PcmSignal {
  constructor() { this.reset(); }
  reset() {
    this.samples = 0; this.sumSquares = 0; this.peak = 0;
    this.nonzero = 0; this.clipped = 0; this.at = 0; this.last = null;
  }
  add(buffer, now) {
    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
      const value = buffer.readInt16LE(offset), magnitude = Math.abs(value);
      this.samples++; this.sumSquares += value * value;
      if (magnitude > this.peak) this.peak = magnitude;
      if (value) this.nonzero++;
      if (value === -32768 || value === 32767) this.clipped++;
      this.at = now;
      if (this.samples === PCM_RATE * 2) {
        this.last = this.measure();
        this.samples = 0; this.sumSquares = 0; this.peak = 0; this.nonzero = 0; this.clipped = 0;
      }
    }
  }
  measure() {
    const peak = this.peak / 32768, rms = this.samples ? Math.sqrt(this.sumSquares / this.samples) / 32768 : 0;
    return { samples: this.samples, nonzeroSamples: this.nonzero, clippedSamples: this.clipped,
      peak, rms, peakDbfs: peak ? 20 * Math.log10(peak) : null,
      rmsDbfs: rms ? 20 * Math.log10(rms) : null, silent: rms < 0.0001, measuredAt: this.at };
  }
  snapshot(now) {
    const value = this.last || (this.samples ? this.measure() : null);
    if (!value) return null;
    const { measuredAt, ...result } = value;
    return { ...result, ageMs: Math.max(0, now - measuredAt) };
  }
}

class AudioFeed {
  constructor({ settingsPath = SETTINGS, demandPath = DEMAND, output,
    bridgeStatus, requirePlayer, spawnImpl = spawn, socketFactory = () => dgram.createSocket('udp4'),
    clock = Date.now, paceClock = clock === Date.now ? () => performance.now() : clock,
    maxEncoded = MAX_ENCODED, maxPcm = MAX_PCM } = {}) {
    Object.assign(this, { settingsPath, demandPath, output, bridgeStatus, requirePlayer, clock, maxEncoded, maxPcm });
    this.spawn = spawnImpl; this.socketFactory = socketFactory;
    this.paceClock = paceClock;
    this.state = 'disabled'; this.reason = 'The experimental music feed is off.';
    this.epoch = 0; this.startRequest = 0; this.socket = null; this.writer = null; this.decoder = null;
    this.token = ''; this.playerId = ''; this.streamGeneration = '';
    this.encoded = []; this.encodedSize = 0; this.pcm = []; this.pcmSize = 0; this.pcmTail = Buffer.alloc(0);
    this.totalEncoded = 0; this.totalPcm = 0; this.droppedPcm = 0; this.packetAt = 0; this.pcmAt = 0;
    this.decodedSignal = new PcmSignal(); this.submittedSignal = new PcmSignal();
    this.inspectCache = null; this.inspectAt = 0; this.pendingEnd = false;
    this.retiredGenerations = new Set();
  }
  snapshot() {
    return { enabled: !!this.settings?.enabled, state: this.state, reason: this.reason, playerId: this.playerId,
      sourceKind: this.streamGeneration ? 'Lyrion bridge FLAC copy' : '', encodedBytes: this.totalEncoded,
      pcmBytes: this.totalPcm, bufferedBytes: this.encodedSize + this.pcmSize + (this.decoder?.stdin.writableLength || 0),
      droppedPcmFrames: this.droppedPcm, pcmAgeMs: this.pcmAt ? Math.max(0, this.clock() - this.pcmAt) : null,
      decodedSignal: this.decodedSignal.snapshot(this.clock()), submittedSignal: this.submittedSignal.snapshot(this.clock()),
      delayMs: this.settings?.delayMs || 0 };
  }
  async inspect(refresh = false) {
    if (!refresh && this.inspectCache && this.clock() - this.inspectAt < 10000) return this.inspectCache;
    let available = false, reason = 'The experimental music feed is off.';
    try {
      const settings = await readSettings(this.settingsPath); if (!this.token) this.settings = settings;
      if (settings.enabled) {
        const probe = await this.output.probeOutput({ settingsPath: this.settingsPath });
        if (!probe.available) reason = outputReason(probe.reason);
        else {
          const status = await this.bridgeStatus();
          available = Number(status?.version) === 1 && Number(status.loaded) === 1 && Number(status.configured) === 1;
          reason = available ? '' : 'The music-feed bridge needs installation and a one-time Lyrion restart.';
        }
      }
    } catch { reason = 'The experimental music feed could not be checked. Check its local setup.'; }
    if (!this.token && this.state !== 'error') {
      this.state = this.settings?.enabled ? 'waiting' : 'disabled';
      this.reason = available ? 'Select Start visuals to activate the experimental music feed.' : reason;
    }
    this.inspectCache = { id: INPUT, name: 'Music feed (experimental)', kind: 'music-feed', available, reason };
    this.inspectAt = this.clock();
    return this.inspectCache;
  }
  async ownDemand(port, epoch) {
    await fs.mkdir(path.dirname(this.demandPath), { recursive: true });
    if (epoch !== this.epoch) return;
    const token = this.token, ownerPath = this.demandPath + '.owner';
    let owner;
    try { owner = await fs.open(ownerPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error('Another music-feed owner is active, or its private lock needs cleanup. Close that view before retrying.');
      throw error;
    }
    this.ownerToken = token;
    try { await owner.writeFile(JSON.stringify({ version: 1, token, ownerPid: process.pid })); }
    finally { await owner.close(); }
    if (epoch !== this.epoch) {
      await this.removeOwner(token); return;
    }
    let previous;
    try { previous = JSON.parse(await fs.readFile(this.demandPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw Error('The music-feed demand file needs repair.'); }
    if (previous?.token && previous.token !== this.token && Number(previous.expiresAt) > this.clock()) throw Error('Another music-feed session is active. Close that view first.');
    if (epoch !== this.epoch) return;
    this.port = port;
    await this.renewDemand(epoch, true);
  }
  async renewDemand(epoch = this.epoch, initial = false) {
    if (!this.token || epoch !== this.epoch) return;
    const token = this.token;
    const saved = { version: 1, port: this.port, token: this.token, playerId: this.playerId,
      ownerPid: process.pid, expiresAt: this.clock() + 12000 };
    this.demandWrite = (this.demandWrite || Promise.resolve()).catch(() => {}).then(async () => {
      if (epoch !== this.epoch || token !== this.token) return;
      const temp = this.demandPath + '.' + token.slice(0, 12) + '.tmp';
      try {
        try {
          const previous = JSON.parse(await fs.readFile(this.demandPath, 'utf8'));
          if (previous.token !== token && !(initial && Number(previous.expiresAt) <= this.clock())) throw Error('The private audio-copy demand belongs to another session.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
        if (epoch === this.epoch && token === this.token) await fs.rename(temp, this.demandPath);
      } finally { await fs.rm(temp, { force: true }); }
    });
    return this.demandWrite;
  }
  async removeOwner(token) {
    if (!token) return;
    const ownerPath = this.demandPath + '.owner';
    try {
      const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
      if (owner.token === token) await fs.rm(ownerPath, { force: true });
    } catch {}
    if (this.ownerToken === token) this.ownerToken = '';
  }
  async validateStart({ playerId } = {}) {
    if (!validPlayer(playerId)) throw Error('Choose a connected Lyrion player for the music feed.');
    await this.requirePlayer(playerId);
  }
  async start({ playerId, onFailure = () => {} } = {}) {
    const request = ++this.startRequest;
    const checkRequest = () => { if (request !== this.startRequest) throw Error('The music-feed start was cancelled.'); };
    if (!validPlayer(playerId)) throw Error('Choose a connected Lyrion player for the music feed.');
    const readiness = await this.inspect(true);
    checkRequest();
    if (!readiness.available) throw Error(readiness.reason);
    await this.requirePlayer(playerId);
    checkRequest();
    await this.stop({ preserveStart: true });
    checkRequest();
    const epoch = ++this.epoch; this.onFailure = onFailure;
    this.settings = await readSettings(this.settingsPath);
    checkRequest();
    const probe = await this.output.probeOutput({ settingsPath: this.settingsPath });
    checkRequest();
    if (!probe.available) throw Error(outputReason(probe.reason));
    this.outputProbe = probe;
    const command = this.output.buildOutputCommand({ probe });
    this.token = crypto.randomBytes(32).toString('hex'); this.playerId = playerId;
    this.totalEncoded = 0; this.totalPcm = 0; this.droppedPcm = 0; this.packetAt = 0; this.pcmAt = 0;
    this.retiredGenerations.clear(); this.outputBlockedAt = 0; this.bridgeCheckAt = 0;
    this.state = 'waiting'; this.reason = 'Waiting for a supported Lyrion FLAC stream.';
    const socket = this.socketFactory(); this.socket = socket;
    socket.on('message', (buffer, remote) => {
      if (epoch !== this.epoch || this.socket !== socket) return;
      try { this.receive(buffer, remote, epoch); } catch { this.fail('The audio copy stopped. Start visuals again to retry.', epoch); }
    });
    socket.on('error', () => this.fail('The local audio-copy connection stopped.', epoch));
    try {
      await new Promise((resolve, reject) => {
        const onError = error => reject(error);
        socket.once('error', onError);
        socket.bind(0, '127.0.0.1', () => { socket.removeListener('error', onError); resolve(); });
      });
      checkRequest();
      // Keep a bounded kernel queue for FLAC bursts. Missing packets still fail
      // only this copy; the original bridge never waits or retries a send.
      socket.setRecvBufferSize?.(2 * 1024 * 1024);
      await this.ownDemand(socket.address().port, epoch);
      checkRequest();
      const writer = this.spawn(command.command, command.args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: command.env || process.env });
      this.writer = writer; lowerPriority(writer);
      this.paceAt = this.paceClock(); this.paceWritten = 0;
      writer.stdin.on('error', () => this.fail('The dedicated visualizer audio output stopped.', epoch));
      writer.stderr.on('data', () => {});
      writer.once('error', () => this.fail('Could not open the dedicated visualizer audio output.', epoch));
      writer.once('close', () => { if (this.writer === writer) this.fail('The dedicated visualizer audio output closed.', epoch); });
      this.pacer = setInterval(() => this.tick(epoch), 20); this.pacer.unref?.();
      this.renewTimer = setInterval(() => { void this.renewDemand(epoch).catch(() => this.fail('The audio-copy demand could not be renewed.', epoch)); }, 3000); this.renewTimer.unref?.();
      this.safetyTimer = setInterval(() => { void this.checkSafety(epoch); }, 1000); this.safetyTimer.unref?.();
    } catch (error) { if (epoch === this.epoch) await this.stop(); throw error; }
  }
  async checkSafety(epoch) {
    if (this.checking || epoch !== this.epoch) return;
    this.checking = true;
    try {
      const probe = await this.output.validateOutput(this.outputProbe, { settingsPath: this.settingsPath });
      if (epoch !== this.epoch) return;
      if (!probe.available) { this.fail(outputReason(probe.reason), epoch); return; }
      if (this.clock() - this.bridgeCheckAt >= 5000) {
        this.bridgeCheckAt = this.clock();
        const generation = this.streamGeneration;
        const status = await this.bridgeStatus();
        if (epoch !== this.epoch) return;
        if (Number(status?.loaded) !== 1 || Number(status?.configured) !== 1) { this.fail('The music-feed bridge is unavailable. Playback continues.', epoch); return; }
        if (generation !== this.streamGeneration) return;
        if (status.state === 'unsupported') {
          this.resetDecoder(); this.state = 'unsupported'; this.reason = 'This Lyrion playback route does not expose a supported FLAC copy.';
        } else if (this.state === 'unsupported') {
          this.state = 'waiting'; this.reason = 'Waiting for a supported Lyrion FLAC stream.';
        }
      }
    } catch { this.fail('The dedicated visualizer audio cable could not be checked.', epoch); }
    finally { this.checking = false; }
  }
  receive(buffer, remote, epoch = this.epoch) {
    const parsed = parsePacket(buffer, remote, this.token, this.playerId);
    if (!parsed) return;
    const { header, payload } = parsed;
    if (header.type === 'status') {
      if (header.state === 'unsupported') {
        this.resetDecoder(); this.state = 'unsupported'; this.reason = 'This Lyrion playback route does not expose a supported FLAC copy.';
      }
      return;
    }
    if (header.type === 'begin') {
      if (header.generation === this.streamGeneration || this.retiredGenerations.has(header.generation)) return;
      if (header.sequence !== 0 || header.format !== 'flac' || payload.length &&
          (payload.length < 42 || !payload.subarray(0, 4).equals(Buffer.from('fLaC')))) return;
      this.resetDecoder(); this.streamGeneration = header.generation; this.expectedSequence = 1;
      this.packetAt = this.clock(); this.readyAt = this.paceClock() + this.settings.delayMs;
      const command = buildDecodeCommand(this.settings);
      const decoder = this.spawn(command.command, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: command.env });
      this.decoder = decoder; lowerPriority(decoder);
      decoder.stdin.on('drain', () => { if (this.decoder === decoder) this.flushEncoded(epoch); });
      decoder.stdin.on('error', () => { if (this.decoder === decoder) this.fail('The separate audio-copy decoder stopped.', epoch); });
      decoder.stdout.on('data', chunk => { if (this.decoder === decoder && epoch === this.epoch) this.offerPcm(chunk); });
      decoder.stderr.on('data', () => {});
      decoder.once('error', () => { if (this.decoder === decoder) this.fail('Could not start the separate audio-copy decoder.', epoch); });
      decoder.once('close', code => {
        if (this.decoder !== decoder || epoch !== this.epoch) return;
        if (code) this.fail('The FLAC audio copy could not be decoded. Start visuals again to retry.', epoch);
        else { this.decoder = null; this.state = 'waiting'; this.reason = 'Waiting for the next supported Lyrion stream.'; }
      });
      this.state = 'waiting'; this.reason = 'Receiving the source copy; waiting for decoded audio.';
      this.offerEncoded(payload, epoch);
      return;
    }
    if (!this.decoder || header.generation !== this.streamGeneration) return;
    if (header.sequence !== this.expectedSequence) { this.fail('An audio-copy packet was lost. Playback continues; start visuals again to retry.', epoch); return; }
    this.expectedSequence++; this.packetAt = this.clock();
    if (header.type === 'data') this.offerEncoded(payload, epoch);
    else if (header.type === 'end') { this.pendingEnd = true; this.flushEncoded(epoch); }
  }
  offerEncoded(chunk, epoch) {
    if (!this.decoder || !chunk.length) return;
    const pending = this.encodedSize + this.decoder.stdin.writableLength;
    if (pending + chunk.length > this.maxEncoded) { this.fail('The audio copy fell behind. Playback continues; start visuals again to retry.', epoch); return; }
    this.encoded.push(Buffer.from(chunk)); this.encodedSize += chunk.length; this.totalEncoded += chunk.length;
    this.flushEncoded(epoch);
  }
  flushEncoded(epoch) {
    if (epoch !== this.epoch || !this.decoder || this.decoder.stdin.destroyed || this.decoder.stdin.writableNeedDrain) return;
    while (this.encoded.length) {
      const chunk = this.encoded.shift(); this.encodedSize -= chunk.length;
      if (!this.decoder.stdin.write(chunk)) break;
    }
    if (this.pendingEnd && !this.encoded.length) { this.pendingEnd = false; this.decoder.stdin.end(); }
  }
  offerPcm(chunk) {
    const joined = this.pcmTail.length ? Buffer.concat([this.pcmTail, chunk]) : chunk;
    const length = joined.length - joined.length % FRAME_BYTES;
    this.pcmTail = Buffer.from(joined.subarray(length));
    if (!length) return;
    if (this.pcmSize + length > this.maxPcm) { this.fail('The decoded audio copy exceeded its buffer. Playback continues.', this.epoch); return; }
    this.decodedSignal.add(joined.subarray(0, length), this.clock());
    this.pcm.push(Buffer.from(joined.subarray(0, length))); this.pcmSize += length; this.totalPcm += length; this.pcmAt = this.clock();
    // Backpressure stays entirely inside the disposable copy process.
    if (this.pcmSize > 512 * 1024) this.decoder?.stdout.pause();
    this.state = 'receiving'; this.reason = 'Music feed active. Visual timing is approximate.';
  }
  takePcm(bytes) {
    const result = Buffer.alloc(bytes); let offset = 0;
    while (offset < bytes && this.pcm.length) {
      const first = this.pcm[0], count = Math.min(first.length, bytes - offset);
      first.copy(result, offset, 0, count); offset += count; this.pcmSize -= count;
      if (count === first.length) this.pcm.shift(); else this.pcm[0] = first.subarray(count);
    }
    if (this.pcmSize < 256 * 1024) this.decoder?.stdout.resume();
    return result;
  }
  discardPcm(frames) {
    let bytes = Math.min(this.pcmSize, frames * FRAME_BYTES);
    this.droppedPcm += bytes / FRAME_BYTES;
    while (bytes && this.pcm.length) {
      const first = this.pcm[0], count = Math.min(first.length, bytes);
      bytes -= count; this.pcmSize -= count;
      if (count === first.length) this.pcm.shift(); else this.pcm[0] = first.subarray(count);
    }
    if (this.pcmSize < 256 * 1024) this.decoder?.stdout.resume();
  }
  tick(epoch) {
    if (epoch !== this.epoch || !this.writer || this.writer.stdin.destroyed) return;
    if (this.writer.stdin.writableNeedDrain || this.writer.stdin.writableLength > 65536) {
      if (!this.outputBlockedAt) this.outputBlockedAt = this.clock();
      if (this.clock() - this.outputBlockedAt > 2000) this.fail('The visualizer audio output fell behind. Playback continues.', epoch);
      return;
    }
    this.outputBlockedAt = 0;
    // Windows interval callbacks drift; calculate frames from monotonic elapsed
    // time so a 21 ms callback does not submit only 20 ms of source audio.
    let due = Math.floor(Math.max(0, this.paceClock() - this.paceAt) * PCM_RATE / 1000) - this.paceWritten;
    if (due <= 0) return;
    const firstMusicFrame = this.readyAt ? Math.ceil(Math.max(0, this.readyAt - this.paceAt) * PCM_RATE / 1000) : Infinity;
    if (due > PCM_RATE / 2) {
      // A renderer/device startup or busy desktop can stall a callback. Skip
      // available copy PCM for that gap and keep at most 100 ms timing debt.
      // No missing decoded samples are borrowed from the listening branch.
      const skipped = due - MAX_TICK_FRAMES;
      this.discardPcm(Math.max(0, this.paceWritten + skipped - Math.max(this.paceWritten, firstMusicFrame)));
      this.paceWritten += skipped; due -= skipped;
    }
    const frames = Math.min(due, MAX_TICK_FRAMES), count = frames * FRAME_BYTES;
    const silentFrames = Math.min(frames, Math.max(0, firstMusicFrame - this.paceWritten));
    const value = Buffer.alloc(count);
    if (silentFrames < frames) this.takePcm((frames - silentFrames) * FRAME_BYTES).copy(value, silentFrames * FRAME_BYTES);
    this.paceWritten += frames;
    try {
      this.writer.stdin.write(value);
      // Measures exactly the bytes accepted by this owned writer's stdin,
      // including underrun/delay silence; it does not claim endpoint delivery.
      this.submittedSignal.add(value, this.clock());
    } catch { this.fail('The visualizer audio output stopped.', epoch); }
    if (this.pcmAt && !this.pcmSize && this.clock() - this.pcmAt > 5000 && this.state === 'receiving') {
      this.state = 'waiting'; this.reason = 'Waiting for more audio from the selected Lyrion player.';
    }
  }
  resetDecoder() {
    if (this.streamGeneration) {
      this.retiredGenerations.add(this.streamGeneration);
      while (this.retiredGenerations.size > 64) this.retiredGenerations.delete(this.retiredGenerations.values().next().value);
    }
    const decoder = this.decoder; this.decoder = null;
    if (decoder) { try { decoder.kill(); } catch {} }
    this.streamGeneration = ''; this.expectedSequence = 0; this.encoded = []; this.encodedSize = 0;
    this.pcm = []; this.pcmSize = 0; this.pcmTail = Buffer.alloc(0); this.pendingEnd = false; this.readyAt = 0;
    this.decodedSignal.reset(); this.submittedSignal.reset();
    this.paceAt = this.paceClock(); this.paceWritten = 0;
  }
  fail(reason, epoch) {
    if (epoch !== this.epoch || this.state === 'error') return;
    this.state = 'error'; this.reason = reason;
    const callback = this.onFailure;
    this.failureCleanup = this.stop({ preserveError: true }).then(() => callback(new Error(reason))).catch(() => {});
  }
  async stop({ preserveError = false, preserveStart = false } = {}) {
    if (!preserveStart) ++this.startRequest;
    ++this.epoch; clearInterval(this.pacer); clearInterval(this.renewTimer); clearInterval(this.safetyTimer);
    this.pacer = null; this.renewTimer = null; this.safetyTimer = null;
    const token = this.token, ownerToken = this.ownerToken; this.token = ''; this.resetDecoder();
    const writer = this.writer; this.writer = null; if (writer) { try { writer.kill(); } catch {} }
    const socket = this.socket; this.socket = null; if (socket) { try { socket.close(); } catch {} }
    this.playerId = '';
    if (!preserveError) { this.state = this.settings?.enabled ? 'waiting' : 'disabled'; this.reason = this.settings?.enabled ? 'Select Start visuals to activate the experimental music feed.' : 'The experimental music feed is off.'; }
    const earlierCleanup = this.cleanupPromise, pendingWrite = this.demandWrite;
    this.cleanupPromise = (async () => {
      await earlierCleanup; await pendingWrite?.catch(() => {});
      if (token) {
        try { const saved = JSON.parse(await fs.readFile(this.demandPath, 'utf8')); if (saved.token === token) await fs.rm(this.demandPath, { force: true }); } catch {}
      }
      await this.removeOwner(ownerToken);
    })();
    await this.cleanupPromise;
  }
}

function createIntegration(options = {}) {
  const output = options.output || require('./audio-output.cjs');
  const { LyrionClient } = require('../../src/lyrionClient');
  const client = options.client || new LyrionClient({ fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(2000) }) });
  const settingsPath = options.settingsPath || SETTINGS;
  const audioFeed = new AudioFeed({ ...options, settingsPath, output,
    bridgeStatus: options.bridgeStatus || (() => client.rpc('', ['rhaudiofeed', 'status']).catch(() => null)),
    requirePlayer: options.requirePlayer || (playerId => client.requirePlayer(playerId)) });
  return { audioFeed, additionalInputProvider: output.createInputProvider({ settingsPath }) };
}

module.exports = { AudioFeed, createIntegration, readSettings, buildDecodeCommand, packet, parsePacket, validPlayer, INPUT, SETTINGS, DEMAND, MAX_ENCODED, MAX_PCM, PCM_RATE };
