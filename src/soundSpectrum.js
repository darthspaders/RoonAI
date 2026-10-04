"use strict";

const { spawn } = require("node:child_process");
const { FEED_SOURCES, validZoneId, createHQPlayerZoneGuard, createFeedMux } = require("./soundSpectrumFeeds");

const PRODUCTS = new Set(["aeon", "g-force", "whitecap"]);
const BOUNDARY = "rabbit-hole-soundspectrum";
const MAX_FRAME = 2 * 1024 * 1024;
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const FRAME_END = Buffer.from("\r\n");
const validViewer = value => typeof value === "string" && /^[a-zA-Z0-9_-]{20,100}$/.test(value);
function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

// Only JPEGs from our owned, window-specific capture process are accepted.
// Keep at most one bounded pending frame; a slow tablet never stalls capture.
class JpegFrames {
  constructor(onFrame) { this.parts = []; this.length = 0; this.active = false; this.seekFf = false; this.endsFf = false; this.onFrame = onFrame; }
  get buffer() { return this.length ? Buffer.concat(this.parts, this.length) : this.seekFf ? Buffer.from([0xff]) : Buffer.alloc(0); }
  append(part) {
    if (this.length + part.length > MAX_FRAME) throw problem("SoundSpectrum returned an oversized video frame.", 502);
    if (part.length) { this.parts.push(part); this.length += part.length; }
  }
  finish() {
    // Copy a fragmented JPEG once; a complete single-chunk JPEG needs no copy.
    const frame = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.length);
    this.parts = []; this.length = 0; this.active = false; this.endsFf = false;
    this.onFrame(frame);
  }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.active) {
        if (this.seekFf && chunk[offset] === 0xd8) {
          this.active = true; this.append(SOI); offset++;
        } else {
          const start = chunk.indexOf(SOI, offset);
          if (start < 0) { this.seekFf = chunk[chunk.length - 1] === 0xff; return; }
          this.active = true; offset = start;
        }
        this.seekFf = false;
      }
      if (offset >= chunk.length) return;
      if (this.endsFf && chunk[offset] === 0xd9) {
        this.append(chunk.subarray(offset, offset + 1)); offset++; this.finish(); continue;
      }
      const end = chunk.indexOf(EOI, offset);
      if (end < 0) {
        this.append(chunk.subarray(offset)); this.endsFf = chunk[chunk.length - 1] === 0xff; return;
      }
      this.append(chunk.subarray(offset, end + 2)); offset = end + 2; this.finish();
    }
  }
}

function multipartFrame(frame) {
  const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  return Buffer.concat([header, frame, FRAME_END]);
}

class SoundSpectrum {
  constructor({ native, capture, audioFeed = null, spawnImpl = spawn, clock = Date.now, leaseMs = 12000, sweepMs = 1000, startupMs = 15000, staleMs = 10000 } = {}) {
    this.native = native || require("./soundSpectrumNative").createSoundSpectrumNative();
    this.capture = capture || require("../scripts/soundspectrum-capture.cjs");
    this.audioFeed = audioFeed; this.playerId = ""; this.zoneId = ""; this.inputSource = "";
    this.spawn = spawnImpl; this.clock = clock; this.leaseMs = leaseMs;
    this.startupMs = startupMs; this.staleMs = staleMs;
    this.leases = new Map(); this.pendingStarts = new Map(); this.clients = new Set(); this.generation = 0;
    this.state = "idle"; this.visualizer = "aeon"; this.inputId = ""; this.inputKind = ""; this.error = "";
    this.latest = null; this.frameAt = 0; this.child = null; this.closed = false; this.inputCheckAt = 0; this.inputCheck = null;
    this.serial = Promise.resolve(); this.inventory = null; this.inventoryAt = 0;
    this.videoObservers = new Set(); this.latestPacket = null;
    this.captureTimes = []; this.captureFrames = 0; this.captureBytes = 0; this.coalescedFrames = 0;
    this.mjpegFrames = 0; this.mjpegDroppedFrames = 0;
    if (sweepMs) { this.timer = setInterval(() => this.sweep(), sweepMs); this.timer.unref?.(); }
  }
  async inspect(refresh = false) {
    if (!refresh && this.inventory && this.clock() - this.inventoryAt < 30000) return this.inventory;
    const [installed, runtime, musicInput] = await Promise.all([this.native.inspect(), this.capture.probeCaptureRuntime(), this.audioFeed?.inspect(refresh)]);
    const reasons = { "runtime-missing": "The SoundSpectrum capture runtime is missing on the PC.", "element-missing": "The SoundSpectrum capture runtime needs repair.", "window-capture-unsupported": "This PC does not support SoundSpectrum window capture.", "runtime-unavailable": "The SoundSpectrum capture runtime could not be checked." };
    const candidates = Array.isArray(musicInput) ? musicInput : musicInput ? [musicInput] : [];
    const musicInputs = candidates.filter(input => Object.hasOwn(FEED_SOURCES, input.id) && input.kind === "music-feed").map(input => {
      const nativeMusic = installed.musicInputs?.find(item => item.id === input.id && item.kind === "music-feed");
      return { ...input, source: FEED_SOURCES[input.id],
        available: input.available === true && nativeMusic?.available !== false && !!nativeMusic,
        reason: input.reason || (!nativeMusic || nativeMusic.available === false ? "The verified SoundSpectrum recording input is unavailable. Refresh inputs after checking the local cable setup." : "") };
    });
    this.inventory = { visualizers: installed.visualizers || [], inputs: installed.inputs || [], noMicInputs: installed.noMicInputs || {}, musicInputs, supported: installed.supported !== false,
      captureAvailable: runtime.available === true && !installed.recoveryError,
      reason: installed.recoveryError || reasons[runtime.reason] || runtime.reason || "" };
    this.inventoryAt = this.clock();
    return this.inventory;
  }
  snapshot(viewerId) {
    const times = this.captureTimes, span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    return { state: this.state, visualizer: this.visualizer, inputId: this.inputId, inputKind: this.inputKind, inputSource: this.inputSource, playerId: this.playerId, zoneId: this.zoneId, error: this.error,
      ...(this.audioFeed ? { audioFeed: this.audioFeed.snapshot(this.inputId) } : {}),
      generation: this.generation, clients: this.leases.size,
      videoTransport: this.videoTransport || this.preferredVideoTransport || "mjpeg",
      videoStats: { targetFps: 30, width: 800, height: 450, quality: 65, captureFrames: this.captureFrames,
        captureBytes: this.captureBytes, captureFps: span ? (times.length - 1) * 1000 / span : null,
        frameAgeMs: this.latest ? Math.max(0, this.clock() - this.frameAt) : null,
        coalescedFrames: this.coalescedFrames, mjpegFrames: this.mjpegFrames, mjpegDroppedFrames: this.mjpegDroppedFrames },
      viewerActive: !!viewerId && (this.leases.get(viewerId) || 0) > this.clock(),
      ...(this.inventory || { visualizers: [], inputs: [], noMicInputs: {}, musicInputs: [], captureAvailable: false }) };
  }
  async status(viewerId, refresh = false) { await this.inspect(refresh); return this.snapshot(viewerId); }
  enqueue(fn) {
    const pending = this.serial.then(fn);
    this.serial = pending.catch(() => {});
    return pending;
  }
  onVideo(listener) {
    if (typeof listener !== "function") throw TypeError("A video observer is required.");
    this.videoObservers.add(listener);
    return () => this.videoObservers.delete(listener);
  }
  emitVideo(event) {
    for (const observer of this.videoObservers) { try { observer(event); } catch {} }
  }
  videoState() { this.emitVideo({ type: "state", state: this.state, generation: this.generation, error: this.error, closed: this.closed }); }
  authorizeVideo(viewerId, expectedGeneration) {
    if (!validViewer(viewerId) || (this.leases.get(viewerId) || 0) <= this.clock()) throw problem("Select Start visuals before opening the video stream.", 403);
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.generation)) throw problem("The visualizer selection changed. Reconnect its video stream.", 409);
    if (!["starting", "running"].includes(this.state)) throw problem("SoundSpectrum video is unavailable. Select Start visuals to retry.", 409);
    return { frame: this.latest, capturedAt: this.frameAt, generation: this.generation };
  }
  async session({ action, viewerId, visualizer, inputId, playerId, zoneId, generation: expectedGeneration } = {}) {
    if (!validViewer(viewerId)) throw problem("Invalid visualizer viewer.");
    if (this.closed) throw problem("SoundSpectrum is shutting down.", 503);
    if (action === "join") {
      if (this.state !== "running" || !Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.generation ||
          visualizer !== this.visualizer || inputId !== this.inputId || (playerId || "") !== this.playerId || (zoneId || "") !== this.zoneId || ![...this.leases.values()].some(until => until > this.clock())) throw problem("The running visualizer selection changed. Refresh before joining it.", 409);
      if (this.leases.size >= 8 && !this.leases.has(viewerId)) throw problem("Too many visualizer viewers. Close another view first.", 429);
      this.leases.set(viewerId, this.clock() + this.leaseMs);
      return this.snapshot(viewerId);
    }
    if (action === "stop") {
      this.pendingStarts.delete(viewerId);
      this.leases.delete(viewerId);
      for (const client of this.clients) if (client.viewerId === viewerId) client.res.destroy();
      if (!this.leases.size && ["starting", "running"].includes(this.state)) this.release();
      return this.snapshot(viewerId);
    }
    if (action === "heartbeat") {
      if ((this.leases.get(viewerId) || 0) <= this.clock()) throw problem(this.state === "error" && this.error || "Visuals stopped. Select Start visuals to reconnect.", 409);
      this.leases.set(viewerId, this.clock() + this.leaseMs);
      return this.snapshot(viewerId);
    }
    if (action !== "start") throw problem("Unsupported visualizer action.");
    if (!PRODUCTS.has(visualizer)) throw problem("Choose Aeon, G-Force or WhiteCap.");
    if (this.pendingStarts.size >= 8 && !this.pendingStarts.has(viewerId)) throw problem("Too many pending visualizer requests.", 429);
    const request = {}; this.pendingStarts.set(viewerId, request);
    let inventory;
    try { inventory = await this.inspect(true); }
    catch (error) { if (this.pendingStarts.get(viewerId) === request) this.pendingStarts.delete(viewerId); throw error; }
    if (this.pendingStarts.get(viewerId) !== request) throw problem("Visuals start was cancelled.", 409);
    let noMicInput, musicInput;
    try {
      if (this.closed) throw problem("SoundSpectrum is shutting down.", 503);
      if (!inventory.visualizers?.some(item => item.id === visualizer && item.available)) throw problem("That SoundSpectrum visualizer is not installed on the PC.", 503);
      if (!inventory.captureAvailable) throw problem(inventory.reason || "The SoundSpectrum video bridge is unavailable.", 503);
      noMicInput = inventory.noMicInputs?.[visualizer]?.find(item => item.id === inputId && item.kind === "no-mic");
      musicInput = this.audioFeed && inventory.musicInputs?.find(item => item.id === inputId && item.kind === "music-feed");
      if (musicInput && !musicInput.available) throw problem(musicInput.reason || "The experimental music feed is unavailable.", 503);
      if (musicInput?.source === "roon-hqplayer") {
        if (!validZoneId(zoneId) || playerId) throw problem("Choose the configured Roon HQPlayer zone for the music analysis feed.");
      } else if (musicInput && (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(playerId || "") || zoneId)) throw problem("Choose a connected Lyrion player for the music feed.");
      if (!noMicInput && !musicInput && !inventory.inputs?.some(item => item.id === inputId)) throw problem("Choose an available no-mic preset or microphone on the Rabbit Hole PC.");
      if (musicInput) await this.audioFeed.validateStart?.({ inputId, playerId, zoneId });
      if (this.pendingStarts.get(viewerId) !== request) throw problem("Visuals start was cancelled.", 409);
    } catch (error) {
      if (this.pendingStarts.get(viewerId) === request) this.pendingStarts.delete(viewerId);
      throw error;
    }
    this.pendingStarts.delete(viewerId);
    if (this.closed) throw problem("SoundSpectrum is shutting down.", 503);
    if (this.leases.size >= 8 && !this.leases.has(viewerId)) throw problem("Too many visualizer viewers. Close another view first.", 429);
    this.leases.set(viewerId, this.clock() + this.leaseMs);
    if (["running", "starting"].includes(this.state) && this.visualizer === visualizer && this.inputId === inputId && (!musicInput || this.playerId === (playerId || "") && this.zoneId === (zoneId || ""))) return this.snapshot(viewerId);
    const generation = ++this.generation;
    this.state = "starting"; this.visualizer = visualizer; this.inputId = inputId; this.inputKind = musicInput ? "music-feed" : noMicInput ? "no-mic" : "microphone";
    this.inputSource = musicInput?.source || "";
    this.playerId = musicInput?.source === "lyrion" ? playerId : "";
    this.zoneId = musicInput?.source === "roon-hqplayer" ? zoneId : "";
    this.error = ""; this.latest = null; this.latestPacket = null; this.frameAt = 0;
    for (const client of this.clients) client.pending = null;
    this.videoState();
    void this.enqueue(async () => {
      try {
        await this.stopOwned();
        if (generation !== this.generation || !this.leases.size || this.closed) return;
        if (musicInput) {
          await this.audioFeed.start({ inputId, playerId, zoneId, onFailure: error => { void this.fail(generation, error); } });
          if (generation !== this.generation || !this.leases.size || this.closed) { await this.audioFeed.stop(); return; }
        }
        const window = await this.native.start({ visualizer, inputId });
        if (generation !== this.generation || !this.leases.size || this.closed) { await this.native.stop(); await this.audioFeed?.stop(); return; }
        await this.startCapture(window, generation);
      } catch (error) { await this.fail(generation, error); }
    });
    return this.snapshot(viewerId);
  }
  async startCapture(window, generation) {
    const command = this.capture.buildCaptureCommand({ windowHandle: window.windowHandle, width: 800, height: 450, fps: 30, quality: 65 });
    const child = this.spawn(command.command, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: command.env || process.env });
    this.child = child;
    this.captureTimes = []; this.captureFrames = 0; this.captureBytes = 0; this.coalescedFrames = 0;
    this.mjpegFrames = 0; this.mjpegDroppedFrames = 0;
    let diagnostic = "";
    let chunkFrame = null, chunkFrames = 0;
    const parser = new JpegFrames(frame => {
      if (this.child !== child || generation !== this.generation) return;
      chunkFrame = frame; chunkFrames++; this.captureFrames++; this.captureBytes += frame.length;
    });
    child.stdout.on("data", chunk => {
      if (this.child !== child || generation !== this.generation) return;
      chunkFrame = null; chunkFrames = 0;
      try { parser.push(chunk); } catch (error) { void this.fail(generation, error); return; }
      if (!chunkFrame) return;
      // A pipe read can contain stale catch-up frames. Present only its newest
      // complete JPEG, and share one multipart allocation across all viewers.
      this.coalescedFrames += chunkFrames - 1;
      this.latest = chunkFrame; this.latestPacket = this.clients.size ? multipartFrame(chunkFrame) : null; this.frameAt = this.clock();
      this.captureTimes.push(this.frameAt); if (this.captureTimes.length > 120) this.captureTimes.shift();
      this.state = "running"; this.error = ""; clearTimeout(child.startDeadline);
      this.emitVideo({ type: "frame", frame: chunkFrame, capturedAt: this.frameAt, generation });
      for (const client of this.clients) this.writeFrame(client, this.latestPacket);
    });
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    child.once("error", () => { void this.fail(generation, problem("Could not start the SoundSpectrum video bridge.", 503)); });
    child.once("close", () => {
      clearTimeout(child.startDeadline);
      if (this.child === child && generation === this.generation) {
        const message = /access|denied/i.test(diagnostic) ? "Windows blocked capture of the SoundSpectrum window. Check the PC desktop session." : "The SoundSpectrum video bridge stopped. Select Start visuals to retry.";
        void this.fail(generation, problem(message, 502));
      }
    });
    child.startDeadline = setTimeout(() => { void this.fail(generation, problem("SoundSpectrum did not produce video. Check the PC desktop session and try again.", 502)); }, this.startupMs);
    child.startDeadline.unref?.();
  }
  writeFrame(client, packet) {
    if (client.res.destroyed || client.res.writableEnded) { this.clients.delete(client); return; }
    if ((this.leases.get(client.viewerId) || 0) <= this.clock()) { client.res.destroy(); return; }
    if (client.res.writableLength > MAX_FRAME || this.clock() - client.sentAt > 10000 && client.blocked) { client.res.destroy(); return; }
    if (client.blocked) {
      if (client.pending) this.mjpegDroppedFrames++;
      client.pending = { packet, generation: this.generation }; return;
    }
    client.pending = null;
    client.sentAt = this.clock();
    this.mjpegFrames++;
    client.blocked = !client.res.write(packet);
  }
  video(req, res, viewerId) {
    this.authorizeVideo(viewerId);
    for (const client of this.clients) if (client.viewerId === viewerId) client.res.destroy();
    res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`, "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" });
    res.flushHeaders?.(); res.socket?.setNoDelay?.(true);
    const client = { viewerId, res, blocked: false, pending: null, sentAt: this.clock() };
    this.clients.add(client);
    res.on("drain", () => {
      client.blocked = false;
      const pending = client.pending; client.pending = null;
      if (pending?.generation === this.generation && this.clients.has(client)) this.writeFrame(client, pending.packet);
    });
    res.on("close", () => { this.clients.delete(client); });
    if (this.latest) { this.latestPacket ||= multipartFrame(this.latest); this.writeFrame(client, this.latestPacket); }
  }
  async stopOwned() {
    const child = this.child; this.child = null;
    if (child) { clearTimeout(child.startDeadline); try { child.kill(); } catch {} }
    this.latest = null; this.latestPacket = null; this.frameAt = 0;
    for (const client of this.clients) client.pending = null;
    this.videoState();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.audioFeed?.stop()),
      Promise.resolve().then(() => this.native.stop())
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  fail(generation, error) {
    if (generation !== this.generation || this.closed) return;
    ++this.generation; this.state = "error"; this.error = error.message || "SoundSpectrum could not start.";
    this.videoState();
    this.leases.clear();
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
    void this.enqueue(() => this.cleanupOwned());
  }
  release() {
    ++this.generation; this.state = "idle"; this.error = ""; this.latest = null; this.latestPacket = null;
    this.videoState();
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
    void this.enqueue(() => this.cleanupOwned());
  }
  async cleanupOwned() {
    try { await this.stopOwned(); }
    catch (error) { this.state = "error"; this.error = `SoundSpectrum could not close cleanly: ${error.message}`; }
  }
  sweep() {
    const now = this.clock();
    for (const [viewer, until] of this.leases) if (until <= now) this.leases.delete(viewer);
    for (const client of this.clients) if (!this.leases.has(client.viewerId)) client.res.destroy();
    if (!this.leases.size && ["starting", "running"].includes(this.state)) this.release();
    else if (this.state === "running" && now - this.frameAt > this.staleMs) void this.fail(this.generation, problem("SoundSpectrum video stopped updating. Check the PC desktop and restart visuals.", 502));
    if (this.state === "running" && this.inputKind === "microphone" && !this.inputCheck && now - this.inputCheckAt > 10000 && this.native.listAudioInputs) {
      const generation = this.generation, inputId = this.inputId;
      this.inputCheckAt = now;
      this.inputCheck = Promise.resolve().then(() => this.native.listAudioInputs()).then(inputs => {
        if (generation === this.generation && !inputs.some(input => input.id === inputId)) this.fail(generation, problem("The PC microphone disconnected. Reconnect it, refresh inputs and start visuals again.", 503));
      }).catch(() => { if (generation === this.generation) this.fail(generation, problem("The PC microphone could not be checked. Refresh inputs and start visuals again.", 503)); })
        .finally(() => { this.inputCheck = null; });
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.pendingStarts.clear(); this.leases.clear(); this.release();
    await this.serial;
  }
}

function requestOrigin(req, url) {
  const origin = new URL(url.origin);
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
  if (req.socket?.encrypted || local && /^https$/i.test(String(req.headers["x-forwarded-proto"] || "").trim())) origin.protocol = "https:";
  return origin.origin;
}
// This is the only installation hook. Deleting the experiment folder restores
// the ordinary microphone/generator service at the next main-app restart.
function createDefaultSoundSpectrum({ getRoonState } = {}) {
  const fs = require("node:fs"), path = require("node:path");
  const entries = [];
  for (const [id, folder, options] of [
    ["feed:pre-hqplayer", "soundspectrum-audio-feed", {}],
    ["feed:hqplayer-analysis", "soundspectrum-hqplayer-feed", { requireZone: createHQPlayerZoneGuard(getRoonState) }]
  ]) {
    const optional = path.join(__dirname, `../integrations/${folder}/index.cjs`);
    if (!fs.existsSync(optional)) continue;
    try {
      entries.push({ id, integration: require(optional).createIntegration(options) });
    } catch { console.warn("[soundspectrum] Optional music-feed module is unavailable; ordinary visualizer inputs remain available."); }
  }
  if (entries.length) {
    const integration = createFeedMux(entries);
    const native = require("./soundSpectrumNative").createSoundSpectrumNative({ additionalInputProvider: integration.additionalInputProvider });
    return new SoundSpectrum({ native, audioFeed: integration.audioFeed });
  }
  return new SoundSpectrum();
}
function createSoundSpectrumApi({ readJson, sendJson, getRoonState, service = createDefaultSoundSpectrum({ getRoonState }) }) {
  let videoAdapter;
  return { service, attachVideoTransport(server) {
    if (!videoAdapter) {
      videoAdapter = require("./soundSpectrumVideo").attachSoundSpectrumVideo(server, { service, requestOrigin });
      service.videoTransport = "websocket-ack-jpeg";
    }
    return videoAdapter;
  }, async handle(req, res, url) {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin && req.headers.origin !== requestOrigin(req, url)) return sendJson(res, 403, { error: "Open SoundSpectrum from the Rabbit Hole player." });
    const route = url.pathname.slice("/api/soundspectrum/".length);
    try {
      if (req.method === "GET" && route === "status") return sendJson(res, 200, await service.status(url.searchParams.get("viewerId"), url.searchParams.get("refresh") === "1"));
      if (req.method === "GET" && route === "video") return service.video(req, res, url.searchParams.get("viewerId"));
      if (req.method === "POST" && route === "session") {
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "Use JSON for visualizer controls." });
        const status = await service.session(await readJson(req));
        return sendJson(res, status.state === "starting" ? 202 : 200, status);
      }
      return sendJson(res, 404, { error: "Unknown SoundSpectrum endpoint." });
    } catch (error) { return sendJson(res, error.statusCode || 500, { ...service.snapshot(), error: error.message }); }
  } };
}

module.exports = { SoundSpectrum, JpegFrames, createSoundSpectrumApi, requestOrigin, validViewer };
