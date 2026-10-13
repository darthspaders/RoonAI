"use strict";
const { whitecapThemeSelection } = require("./soundSpectrumThemes");

const { spawn } = require("node:child_process");
const { FEED_SOURCES, validZoneId, createHQPlayerZoneGuard, createFeedMux } = require("./soundSpectrumFeeds");
const { SoundSpectrumDelay } = require("./soundSpectrumDelay");

const PRODUCTS = new Set(["aeon", "g-force", "whitecap"]);
const BOUNDARY = "rabbit-hole-soundspectrum";
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const TRANSPORTS = new Set(["jpeg", "obs-webrtc", "hls"]);
const hlsProfile = (bitrateMbps, targetFps = 60) => ({ id: "hls-4k" + targetFps, width: 3840, height: 2160, targetFps, fps: targetFps,
  targetBitrateMbps: bitrateMbps, bitrateMbps, nativeWindowMode: "borderless-fullscreen" });
const validHlsBitrate = value => Number.isSafeInteger(value) && value >= 50 && value <= 600;
const HLS_ASSET = /^[A-Za-z0-9_-]{1,128}\.(?:m3u8|mp4|m4s|ts)$/;
function hlsManifest(bytes, viewerId, generation) {
  // Up to 804 segments are retained for the 1 GB / 50 Mbps reserve.
  if (!Buffer.isBuffer(bytes) || bytes.length > 1048576) throw problem("The HLS playlist is unavailable.", 502);
  let text = bytes.toString("utf8");
  if (!text.startsWith("#EXTM3U") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw problem("The HLS playlist is unavailable.", 502);
  // MediaMTX seeds a new live playlist with missing-history placeholders.
  // A large live reserve can select one of these GAPs as its starting point;
  // paused startup then never advances to real media. Remove only this exact
  // leading relay padding and advance the sequence so real segment IDs stay
  // stable across playlist refreshes. Preserve gaps after real media begins.
  const padding = /(?:^#EXT-X-GAP\r?\n#EXTINF:[0-9]+(?:\.[0-9]+)?,[^\r\n]*\r?\ngap\.mp4(?:\r?\n|$))+/m.exec(text);
  if (padding && !text.slice(0, padding.index).split(/\r?\n/).some(line => line && !line.startsWith("#"))) {
    const count = (padding[0].match(/#EXT-X-GAP/g) || []).length;
    const sequence = /^#EXT-X-MEDIA-SEQUENCE:([0-9]+)\r?$/m.exec(text);
    const next = Number(sequence?.[1] || 0) + count;
    if (!Number.isSafeInteger(next)) throw problem("The HLS playlist is unavailable.", 502);
    text = text.slice(0, padding.index) + text.slice(padding.index + padding[0].length);
    text = sequence ? text.replace(/^#EXT-X-MEDIA-SEQUENCE:[0-9]+(?=\r?$)/m, "#EXT-X-MEDIA-SEQUENCE:" + next) :
      text.replace(/^#EXTM3U/, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:" + next);
  }
  const uri = name => {
    if (!HLS_ASSET.test(name)) throw problem("The HLS playlist contains an unsupported media reference.", 502);
    return `/api/soundspectrum/hls/${generation}/${name}?viewerId=${encodeURIComponent(viewerId)}`;
  };
  return Buffer.from(text.split(/\r?\n/).map(line => !line || line.startsWith("#") ? line.replace(/URI="([^"]*)"/g, (_all, name) => `URI="${uri(name)}"`) : uri(line)).join("\n"));
}
const OBS_PROFILES = Object.freeze({
  "1080p60": Object.freeze({ id: "1080p60", width: 1920, height: 1080, targetFps: 60, targetBitrateMbps: 25, nativeWindowMode: "windowed" }),
  "4k60": Object.freeze({ id: "4k60", width: 3840, height: 2160, targetFps: 60, targetBitrateMbps: 80, nativeWindowMode: "borderless-fullscreen" }),
  "4k60-60": Object.freeze({ id: "4k60-60", width: 3840, height: 2160, targetFps: 60, targetBitrateMbps: 60, nativeWindowMode: "borderless-fullscreen" })
});
function obsConfiguredProfile(value) {
  if (!value) return OBS_PROFILES["1080p60"];
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const id = value.id || "1080p60";
  if (!Object.hasOwn(OBS_PROFILES, id)) return null;
  const profile = OBS_PROFILES[id];
  if (!profile || ["width", "height", "targetFps", "targetBitrateMbps", "nativeWindowMode"].some(key => value[key] !== undefined && value[key] !== profile[key])) return null;
  return profile;
}
const validWebRTCSession = value => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const FRAME_END = Buffer.from("\r\n");
const STOP_REASONS = new Set(["user-stop", "pause", "pagehide", "view-hidden", "source-change", "selection-change", "media-error", "hls-buffer-limit", "hls-buffer-timeout", "heartbeat-error", "start-cancelled", "start-error", "lease-ended", "remote-ended"]);
const viewerVisibility = value => value === "hidden" ? "hidden" : value === "visible" ? "visible" : "unknown";
const diagnosticText = value => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(-500);
const VIDEO_STAT_LIMITS = Object.freeze({ frames: 2147483647, receivedFrames: 2147483647, decodedFrames: 2147483647,
  replacedFrames: 2147483647, busyDroppedFrames: 2147483647, backgroundFrames: 2147483647,
  receiveFps: 240, decodeFps: 240, displayedFps: 240, backgroundFps: 240,
  meanDecodeMs: 60000, meanPaintMs: 60000, meanRafWaitMs: 60000, maxPaintGapMs: 60000, lastPaintGapMs: 60000, hlsBufferSeconds: 600, hlsRequestedMB: 1000, hlsReserveSeconds: 600, hlsMaxBufferSeconds: 600, hlsLoadedBytes: 1000000000000, hlsMediaTime: 864000, hlsReadyState: 4, hlsDroppedFrames: 2147483647, hlsDropPercent: 100 });
function viewerVideoStats(value) {
  // Heartbeats are lease renewal first. Optional diagnostics accept only a
  // fixed set of finite scalars; never copy arbitrary browser request data.
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !["websocket", "mjpeg", "obs-webrtc", "hls", "webcodecs"].includes(value.transport)) return null;
    const result = { transport: value.transport };
    for (const [key, limit] of Object.entries({ wcBufferBytes: 1200000000, wcBufferSeconds: 600, wcRequestedMB: 1000, wcLoadedBytes: 1e12, wcDecodeQueue: 100, wcAheadSeconds: 600, wcTargetMs: 2000, wcLatenessMs: 60000, wcRetries: 1000000, wcRecoveries: 1000000, wcHttpStatus: 599, wcTargetFps: 120, wcPresentationHz: 360, wcStreamFps: 240 })) {
      if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) result[key] = Math.min(value[key], limit);
    }
    if (["playlist", "init", "segment"].includes(value.wcRequestKind)) result.wcRequestKind = value.wcRequestKind;
    if (["filling", "playing", "retrying", "recovering"].includes(value.wcBufferState)) result.wcBufferState = value.wcBufferState;
    for (const [key, limit] of Object.entries(VIDEO_STAT_LIMITS)) {
      const number = value[key];
      if (typeof number === "number" && Number.isFinite(number) && number >= 0) result[key] = Math.min(number, limit);
    }
    if (["filling", "playing", "idle"].includes(value.hlsBufferState)) result.hlsBufferState = value.hlsBufferState;
    if (["quota", "starved", "load", "append", "other"].includes(value.hlsLastError)) result.hlsLastError = value.hlsLastError;
    if (typeof value.hlsPaused === "boolean") result.hlsPaused = value.hlsPaused;
    if (typeof value.hlsSeeking === "boolean") result.hlsSeeking = value.hlsSeeking;
    if (["windowed", "player-fullscreen", "visualizer-fullscreen"].includes(value.presentation)) result.presentation = value.presentation;
    if (typeof value.coarsePointer === "boolean") result.coarsePointer = value.coarsePointer;
    if (["full", "windowed-touch"].includes(value.backdropProfile)) result.backdropProfile = value.backdropProfile;
    return result;
  } catch { return null; }
}
const validViewer = value => typeof value === "string" && /^[a-zA-Z0-9_-]{20,100}$/.test(value);
function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function fidelityResolution(value) {
  return Number.isInteger(value?.width) && value.width > 0 && value.width <= 32768 &&
    Number.isInteger(value?.height) && value.height > 0 && value.height <= 32768 ? { width: value.width, height: value.height } : null;
}
function fidelityOBSSnapshot(value, generation) {
  // These are cached provider observations, never runtime probes. Keep only
  // fixed scalar fields, and never promote OBS output settings to wire size.
  if (!value || value.transport !== "obs-webrtc" || value.state !== "running" || value.generation !== generation) return null;
  const timestamp = at => Number.isSafeInteger(at) && at >= 0 ? at : null;
  const source = value.captureSourceMeasurement === "obs-scene-item-source-size" ? fidelityResolution(value.captureSourceResolution) : null;
  const rate = value.bitrateMeasurement === "mediamtx-incoming-byte-counter-delta" && typeof value.payloadBitrateMbps === "number" &&
    Number.isFinite(value.payloadBitrateMbps) && value.payloadBitrateMbps >= 0 && value.payloadBitrateMbps <= 10000 ? value.payloadBitrateMbps : null;
  const windowMs = typeof value.bitrateWindowMs === "number" && Number.isFinite(value.bitrateWindowMs) && value.bitrateWindowMs > 0 && value.bitrateWindowMs <= 60000 ? value.bitrateWindowMs : null;
  const published = value.publishedFormat === "H264" && value.formatMeasurement === "mediamtx-published-track";
  return { sourceResolution: source, sourceObservedAt: source ? timestamp(value.sourceObservedAt) : null,
    outputSettingsResolution: fidelityResolution(value.outputSettingsResolution), published,
    payloadBitrateMbps: rate, bitrateWindowMs: rate === null ? null : windowMs, bitrateObservedAt: rate === null ? null : timestamp(value.bitrateObservedAt) };
}
function jpegFidelity(frame) {
  // Read the already-owned JPEG header only. Never open another media consumer
  // or decode/copy the image merely to show diagnostic dimensions.
  if (!Buffer.isBuffer(frame) || frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) return null;
  const end = Math.min(frame.length, 65536);
  for (let at = 2; at + 4 <= end;) {
    if (frame[at++] !== 0xff) return null;
    while (at < end && frame[at] === 0xff) at++;
    if (at >= end) return null;
    const marker = frame[at++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
    if (at + 2 > end) return null;
    const length = frame.readUInt16BE(at);
    if (length < 2 || at + length > end) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return null;
      const components = frame[at + 7];
      if (components < 1 || components > 4 || length !== 8 + 3 * components) return null;
      const resolution = fidelityResolution({ width: frame.readUInt16BE(at + 5), height: frame.readUInt16BE(at + 3) });
      if (!resolution) return null;
      const factors = Array.from({ length: components }, (_, index) => frame[at + 9 + 3 * index]);
      const chromaSubsampling = components === 1 ? "grayscale" : components === 3 && factors[1] === 0x11 && factors[2] === 0x11 ?
        ({ 0x22: "4:2:0", 0x21: "4:2:2", 0x11: "4:4:4" }[factors[0]] || "unknown") : "unknown";
      const bitDepth = frame[at + 2];
      return { resolution, bitDepth: [8, 12, 16].includes(bitDepth) ? bitDepth : null, chromaSubsampling };
    }
    at += length;
  }
  return null;
}

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
  constructor({ native, capture, audioFeed = null, obsTransport = null, hlsTransport = null, spawnImpl = spawn, clock = Date.now, leaseMs = 12000, sweepMs = 1000, startupMs = 15000, staleMs = 10000, captureRecoveryDelayMs = 250, onDiagnostic = entry => console.warn(`[soundspectrum-video] ${JSON.stringify(entry)}`), env = process.env } = {}) {
    this.native = native || require("./soundSpectrumNative").createSoundSpectrumNative();
    this.capture = capture || require("../scripts/soundspectrum-capture.cjs");
    this.audioFeed = audioFeed; this.playerId = ""; this.zoneId = ""; this.inputSource = "";
    this.obsTransport = obsTransport; this.transport = "jpeg"; this.obsSession = null;
    this.hlsTransport = hlsTransport; this.hlsSession = null; this.hlsBitrateMbps = 600; this.hlsTargetFps = 60; this.hlsReaders = new Set(); this.hlsActivity = new Map();
    this.obsConfiguredProfile = OBS_PROFILES["1080p60"]; this.activeOBSProfile = null;
    this.spawn = spawnImpl; this.clock = clock; this.leaseMs = leaseMs;
    this.startupMs = startupMs; this.staleMs = staleMs;
    this.captureRecoveryDelayMs = captureRecoveryDelayMs; this.onDiagnostic = onDiagnostic;
    this.captureWindow = null; this.captureRecovering = false; this.captureRecoveryUsed = false; this.captureHealthySince = null;
    this.videoFps = env.SOUNDSPECTRUM_VIDEO_FPS === "30" ? 30 : 60;
    this.leases = new Map(); this.leaseVisibility = new Map(); this.viewerPerformance = new Map(); this.nextViewerSlot = 0;
    this.pendingStarts = new Map(); this.clients = new Set(); this.generation = 0;
    this.srtExperiment = new (require("./soundSpectrumSrtExperiment").SoundSpectrumSrtExperiment)(this);
    this.state = "idle"; this.visualizer = "aeon"; this.whitecapTheme = "current"; this.inputId = ""; this.inputKind = ""; this.error = "";
    this.latest = null; this.frameAt = 0; this.child = null; this.closed = false; this.inputCheckAt = 0; this.inputCheck = null;
    this.serial = Promise.resolve(); this.inventory = null; this.inventoryAt = 0;
    this.videoObservers = new Set(); this.latestPacket = null;
    this.captureTimes = []; this.captureFrames = 0; this.captureBytes = 0; this.coalescedFrames = 0;
    this.mjpegFrames = 0; this.mjpegDroppedFrames = 0;
    this.captureObservedAt = null; this.fidelityNative = null; this.fidelityPending = null; this.fidelityByteSample = null;
    if (sweepMs) { this.timer = setInterval(() => this.sweep(), sweepMs); this.timer.unref?.(); }
  }
  async inspect(refresh = false) {
    if (!refresh && this.inventory && this.clock() - this.inventoryAt < 30000) return this.inventory;
    const [installed, runtime, musicInput, obs, hls] = await Promise.all([this.native.inspect(), this.capture.probeCaptureRuntime(), this.audioFeed?.inspect(refresh),
      this.obsTransport ? Promise.resolve().then(() => this.obsTransport.inspect()).catch(() => ({ available: false })) : null,
      this.hlsTransport ? Promise.resolve().then(() => this.hlsTransport.inspect()).catch(() => ({ available: false })) : null]);
    const obsProfile = obsConfiguredProfile(obs?.profile);
    if (obsProfile) this.obsConfiguredProfile = obsProfile;
    const reasons = { "runtime-missing": "The SoundSpectrum capture runtime is missing on the PC.", "element-missing": "The SoundSpectrum capture runtime needs repair.", "window-capture-unsupported": "This PC does not support SoundSpectrum window capture.", "runtime-unavailable": "The SoundSpectrum capture runtime could not be checked." };
    const candidates = Array.isArray(musicInput) ? musicInput : musicInput ? [musicInput] : [];
    const musicInputs = candidates.filter(input => Object.hasOwn(FEED_SOURCES, input.id) && input.kind === "music-feed").map(input => {
      const nativeMusic = installed.musicInputs?.find(item => item.id === input.id && item.kind === "music-feed");
      return { ...input, source: FEED_SOURCES[input.id],
        available: input.available === true && nativeMusic?.available !== false && !!nativeMusic,
        reason: input.reason || (!nativeMusic || nativeMusic.available === false ? "The verified SoundSpectrum recording input is unavailable. Refresh inputs after checking the local cable setup." : "") };
    });
    this.inventory = { visualizers: installed.visualizers || [], inputs: installed.inputs || [], noMicInputs: installed.noMicInputs || {}, musicInputs, supported: installed.supported !== false,
      whitecapThemes: installed.whitecapThemes || [{ id: "current", name: "Current custom theme", available: true }],
      captureAvailable: runtime.available === true && !installed.recoveryError,
      transports: [{ id: "jpeg", name: "JPEG", available: true }, { id: "obs-webrtc", name: "OBS / WebRTC (experimental)", available: obs?.available === true && !!obsProfile && !installed.recoveryError,
        profile: obsProfile ? { ...obsProfile } : null,
        reason: installed.recoveryError || (obs?.available === true ? "" : "The isolated OBS / WebRTC transport is unavailable. Check its local configuration.") },
        { id: "hls", name: "HLS / buffered video", available: hls?.available === true && !installed.recoveryError,
          profile: hlsProfile(600), minBitrateMbps: 50, maxBitrateMbps: 600,
          reason: installed.recoveryError || (hls?.available === true ? "" : "The isolated HLS transport is unavailable. Check its local configuration.") }],
      srtExperiment: { available: obs?.available === true && !!obsProfile && !installed.recoveryError && obs?.srtExperiment?.available === true,
        videoTargetsMbps: obs?.available === true && !!obsProfile && !installed.recoveryError && obs?.srtExperiment?.available === true ?
          [60, 600].filter(value => value === 60 ? obsProfile.targetBitrateMbps === 60 :
            obsProfile.width === 3840 && obsProfile.height === 2160 && obsProfile.targetFps === 60 && obs?.srtExperiment?.videoTargetsMbps?.includes(value)) : [],
        requestedLatencyMs: 250 },
      reason: installed.recoveryError || reasons[runtime.reason] || runtime.reason || "" };
    this.inventoryAt = this.clock();
    return this.inventory;
  }
  snapshot(viewerId) {
    const times = this.captureTimes, span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    const obsProfile = this.transport === "hls" ? hlsProfile(this.hlsBitrateMbps, this.hlsTargetFps) : this.activeOBSProfile || this.obsConfiguredProfile;
    const hlsMeasured = this.hlsMeasurements();
    return { state: this.state, visualizer: this.visualizer, whitecapTheme: this.whitecapTheme, inputId: this.inputId, inputKind: this.inputKind, inputSource: this.inputSource, playerId: this.playerId, zoneId: this.zoneId, error: this.error,
      ...(this.audioFeed ? { audioFeed: this.audioFeed.snapshot(this.inputId) } : {}),
      ...(this.visualDelay ? { visualDelay: this.visualDelay.snapshot() } : {}),
      generation: this.generation, clients: this.leases.size,
      transport: this.transport,
      videoTransport: ["obs-webrtc", "hls"].includes(this.transport) ? this.transport : this.videoTransport || this.preferredVideoTransport || "mjpeg",
      ...(this.transport === "hls" ? { bitrateMbps: this.hlsBitrateMbps, targetFps: this.hlsTargetFps } : {}),
      videoStats: ["obs-webrtc", "hls"].includes(this.transport) ? { targetFps: obsProfile.targetFps, width: obsProfile.width, height: obsProfile.height, quality: null, codec: "H.264", configured: true,
        qualityProfile: obsProfile.id, configuredBitrateMbps: obsProfile.targetBitrateMbps, nativeWindowMode: obsProfile.nativeWindowMode,
        captureFrames: null, captureBytes: null, duplicateFps: hlsMeasured?.duplicateFps ?? null, captureFps: hlsMeasured?.captureFps ?? null,
        ...(this.transport === "hls" ? { encodedFps: hlsMeasured?.encodedFps ?? null, frameRatesObservedAt: hlsMeasured?.observedAt ?? null } : {}),
        frameAgeMs: null, coalescedFrames: null, mjpegFrames: 0, mjpegDroppedFrames: 0 } : { targetFps: this.videoFps, width: 800, height: 450, quality: 65, captureFrames: this.captureFrames,
        captureBytes: this.captureBytes, captureFps: span ? (times.length - 1) * 1000 / span : null,
        frameAgeMs: this.latest ? Math.max(0, this.clock() - this.frameAt) : null,
        coalescedFrames: this.coalescedFrames, mjpegFrames: this.mjpegFrames, mjpegDroppedFrames: this.mjpegDroppedFrames },
      viewerActive: !!viewerId && (this.leases.get(viewerId) || 0) > this.clock(),
      ...(this.inventory || { visualizers: [], inputs: [], noMicInputs: {}, musicInputs: [], captureAvailable: false,
        transports: [{ id: "jpeg", name: "JPEG", available: true }, { id: "obs-webrtc", name: "OBS / WebRTC (experimental)", available: false, reason: "Refresh inputs to check the isolated transport." },
          { id: "hls", name: "HLS / buffered video", available: false, minBitrateMbps: 50, maxBitrateMbps: 600, reason: "Refresh inputs to check the isolated transport." }] }) };
  }
  async status(viewerId, refresh = false) { await this.inspect(refresh); return this.snapshot(viewerId); }
  fidelityIdentity() {
    const window = this.captureWindow;
    const source = this.transport === "obs-webrtc" ? this.obsSession?.ready && this.obsSession : this.transport === "hls" ? this.hlsSession?.ready && this.hlsSession : this.child;
    if (this.closed || this.state !== "running" || !source || !Number.isInteger(window?.pid) || window.pid <= 0 ||
        !/^\d{1,20}$/.test(String(window.windowHandle || "")) || ![...this.leases.values()].some(until => until > this.clock())) return null;
    return { generation: this.generation, child: source, pid: window.pid, handle: String(window.windowHandle) };
  }
  fidelityMatches(identity) {
    const current = this.fidelityIdentity();
    return !!current && current.generation === identity.generation && current.child === identity.child && current.pid === identity.pid && current.handle === identity.handle;
  }
  hlsMeasurements() {
    if (this.transport !== "hls" || typeof this.hlsTransport?.snapshot !== "function") return null;
    const identity = this.fidelityIdentity();
    if (!identity) return null;
    try {
      const value = this.hlsTransport.snapshot(), at = this.clock();
      if (!this.fidelityMatches(identity) || value?.state !== "ready" || value.ready !== true || value.generation !== identity.generation ||
          !Number.isSafeInteger(value.videoBitrateObservedAt) || value.videoBitrateObservedAt < 0 ||
          at - value.videoBitrateObservedAt < 0 || at - value.videoBitrateObservedAt > 6000) return null;
      const scalar = (value, maximum) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
      const payloadBitrateMbps = scalar(value.videoBitrateMbps, 10000), windowMs = scalar(value.videoBitrateWindowMs, 60000);
      return { duplicateFps: scalar(value.duplicateFps, 240), captureFps: scalar(value.captureFps, 240), encodedFps: scalar(value.encodedFps, 240), observedAt: value.videoBitrateObservedAt,
        payloadBitrateMbps, bitrateWindowMs: payloadBitrateMbps !== null && windowMs > 0 ? windowMs : null };
    } catch { return null; } // Cached diagnostics cannot disrupt the owned stream.
  }
  async observeFidelityNative(identity) {
    if (!identity || typeof this.native.captureWindow !== "function") return null;
    const cached = this.fidelityNative;
    if (cached && this.fidelityMatches(cached.identity) && this.clock() - cached.checkedAt >= 0 && this.clock() - cached.checkedAt < 2000) return cached.value;
    if (this.fidelityPending && this.fidelityMatches(this.fidelityPending.identity)) return this.fidelityPending.promise;
    const pending = { identity, promise: null };
    pending.promise = Promise.resolve().then(() => {
      if (!this.fidelityMatches(identity)) return null;
      // The existing helper observes GetClientRect for the exact owned PID and
      // start identity. It never resizes/restores a window or changes its input.
      return this.native.captureWindow();
    }).then(window => {
      if (!this.fidelityMatches(identity)) return null;
      const resolution = window?.pid === identity.pid && String(window.windowHandle || "") === identity.handle ? fidelityResolution(window) : null;
      const value = resolution ? { clientResolution: resolution, observedAt: this.clock(), measurement: "getclientrect-current" } : null;
      this.fidelityNative = { identity, checkedAt: this.clock(), value };
      return value;
    }).catch(() => {
      if (this.fidelityMatches(identity)) this.fidelityNative = { identity, checkedAt: this.clock(), value: null };
      return null;
    }).finally(() => { if (this.fidelityPending === pending) this.fidelityPending = null; });
    this.fidelityPending = pending;
    return pending.promise;
  }
  async fidelity() {
    const requestedIdentity = this.fidelityIdentity();
    const observed = await this.observeFidelityNative(requestedIdentity);
    const identity = this.fidelityIdentity(), active = !!identity;
    const native = requestedIdentity && this.fidelityMatches(requestedIdentity) ? observed : null;
    const at = this.clock(), obs = this.transport === "obs-webrtc", hls = this.transport === "hls", jpeg = active && !obs && !hls ? jpegFidelity(this.latest) : null;
    const obsProfile = this.activeOBSProfile || this.obsConfiguredProfile;
    const obsResolution = { width: obsProfile.width, height: obsProfile.height };
    let obsMeasured = null;
    if (obs && active && requestedIdentity && this.fidelityMatches(requestedIdentity) && typeof this.obsTransport?.snapshot === "function") {
      try {
        const cached = fidelityOBSSnapshot(this.obsTransport.snapshot(), identity.generation);
        if (this.fidelityMatches(identity)) obsMeasured = cached;
      } catch {} // Optional diagnostics must not affect the owned video feed.
    }
    let payloadBitrateMbps = null, bitrateWindowMs = null;
    const previous = this.fidelityByteSample;
    if (active && !obs && !hls && previous && this.fidelityMatches(previous.identity) && this.captureBytes >= previous.bytes) {
      const span = at - previous.at;
      // This is capture JPEG payload, before viewer-specific frame skipping.
      // It excludes multipart, WebSocket, TCP/IP and wireless overhead.
      if (span >= 1000 && span <= 30000) { payloadBitrateMbps = (this.captureBytes - previous.bytes) * 8 / span / 1000; bitrateWindowMs = span; }
    }
    if (!active || obs || hls) this.fidelityByteSample = null;
    else if (!previous || !this.fidelityMatches(previous.identity) || at - previous.at >= 1000 || at < previous.at || this.captureBytes < previous.bytes) {
      this.fidelityByteSample = { identity, bytes: this.captureBytes, at };
    }
    const hlsMeasured = hls ? this.hlsMeasurements() : null;
    if (hls) return { version: 1, state: this.state, generation: this.generation, transport: "hls",
      native: { clientResolution: native?.clientResolution || null, observedAt: native?.observedAt ?? null, measurement: native?.measurement || "unknown",
        windowMode: "borderless-fullscreen", lastCaptureClientResolution: active ? fidelityResolution(this.captureWindow) : null,
        lastCaptureObservedAt: active ? this.captureObservedAt : null, internalRenderTargetResolution: null },
      capture: { api: "windows-graphics-capture", surface: "owned-window-client", inputResolution: null,
        inputResolutionMeasurement: "unknown", inputObservedAt: null, sourceFormat: null, sourceColorSpace: null,
        sourceFormatMeasurement: "unknown", configuredResolution: { width: 3840, height: 2160 }, fps: hlsMeasured?.captureFps ?? null,
        fpsMeasurement: hlsMeasured?.captureFps != null ? "wgc-fresh-timestamp-counter-delta" : "unknown", fpsObservedAt: hlsMeasured?.captureFps != null ? hlsMeasured.observedAt : null },
      transmission: { resolution: null, configuredResolution: { width: 3840, height: 2160 }, resolutionMeasurement: "unknown",
        format: "video/H264", codec: "H.264", quality: null, qualityProfile: "hls-4k" + this.hlsTargetFps, configuredFps: this.hlsTargetFps, formatMeasurement: "configured-pipeline",
        bitDepth: null, chromaSubsampling: "unknown", sampleMeasurement: "unknown", configuredBitDepth: 8, configuredChromaSubsampling: "4:2:0",
        range: "limited", colorSpace: "Rec.709", colorimetry: null, matrix: "BT.709", primaries: "BT.709", colorMeasurement: "configured-pipeline",
        configuredBitrateMbps: this.hlsBitrateMbps, payloadBitrateMbps: hlsMeasured?.payloadBitrateMbps ?? null, bitrateWindowMs: hlsMeasured?.bitrateWindowMs ?? null,
        bitrateObservedAt: hlsMeasured?.payloadBitrateMbps != null ? hlsMeasured.observedAt : null,
        bitrateMeasurement: hlsMeasured?.payloadBitrateMbps != null ? "capture-h264-access-unit-byte-counter-delta" : "unknown", bitrateScope: "encoded-h264-video-payload", lastFrameBytes: null,
        fps: hlsMeasured?.encodedFps ?? null, fpsMeasurement: hlsMeasured?.encodedFps != null ? "capture-h264-access-unit-counter-delta" : "unknown",
        fpsObservedAt: hlsMeasured?.encodedFps != null ? hlsMeasured.observedAt : null } };
    return { version: 1, state: this.state, generation: this.generation, transport: this.transport,
      native: { clientResolution: native?.clientResolution || null, observedAt: native?.observedAt ?? null, measurement: native?.measurement || "unknown",
        windowMode: obs ? obsProfile.nativeWindowMode : "windowed",
        lastCaptureClientResolution: active ? fidelityResolution(this.captureWindow) : null, lastCaptureObservedAt: active ? this.captureObservedAt : null,
        internalRenderTargetResolution: null },
      capture: obs ? { api: "obs-window-capture", surface: "owned-window-client", inputResolution: obsMeasured?.sourceResolution || null,
        inputResolutionMeasurement: obsMeasured?.sourceResolution ? "obs-scene-item-source-size" : "unknown", inputObservedAt: obsMeasured?.sourceObservedAt ?? null, sourceFormat: null, sourceColorSpace: null,
        sourceFormatMeasurement: "unknown", configuredResolution: obsResolution } : { api: "windows-graphics-capture", surface: "owned-window-client", inputResolution: null,
        sourceFormat: "BGRA", sourceColorSpace: "sRGB", sourceFormatMeasurement: "capture-api-contract", configuredResolution: { width: 800, height: 450 } },
      transmission: obs ? { resolution: null, configuredResolution: obsResolution, qualityProfile: obsProfile.id, resolutionMeasurement: "unknown", format: "video/H264", codec: "H.264", quality: null,
        formatMeasurement: obsMeasured?.published ? "mediamtx-published-track" : "configured-pipeline", bitDepth: null, chromaSubsampling: "unknown", sampleMeasurement: "unknown", configuredBitDepth: 8, configuredChromaSubsampling: "4:2:0",
        range: "limited", colorSpace: "Rec.709", colorimetry: null, matrix: "BT.709", primaries: "BT.709", colorMeasurement: "configured-pipeline",
        outputSettingsResolution: obsMeasured?.outputSettingsResolution || null, outputSettingsMeasurement: obsMeasured?.outputSettingsResolution ? "obs-get-video-settings" : "unknown",
        configuredBitrateMbps: obsProfile.targetBitrateMbps, payloadBitrateMbps: obsMeasured?.payloadBitrateMbps ?? null, bitrateWindowMs: obsMeasured?.bitrateWindowMs ?? null,
        bitrateObservedAt: obsMeasured?.bitrateObservedAt ?? null, bitrateMeasurement: obsMeasured?.payloadBitrateMbps !== null && obsMeasured?.payloadBitrateMbps !== undefined ? "mediamtx-incoming-byte-counter-delta" : "unknown",
        bitrateScope: "publisher-stream-payload", lastFrameBytes: null } : { resolution: jpeg?.resolution || null, resolutionMeasurement: jpeg ? "jpeg-sof" : "unknown",
        format: "image/jpeg", quality: 65, formatMeasurement: "configured-pipeline", bitDepth: jpeg?.bitDepth ?? null,
        chromaSubsampling: jpeg?.chromaSubsampling || "unknown", sampleMeasurement: jpeg ? "jpeg-sof" : "unknown", configuredBitDepth: 8, configuredChromaSubsampling: "4:2:0",
        range: "full", colorSpace: "sRGB", colorimetry: "1:4:7:1", matrix: "BT.601", primaries: "BT.709", colorMeasurement: "configured-pipeline",
        payloadBitrateMbps, bitrateWindowMs, bitrateMeasurement: "capture-jpeg-byte-counter-delta", lastFrameBytes: active && this.latest ? this.latest.length : null } };
  }
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
  authorizeViewer(viewerId, expectedGeneration) {
    if (!validViewer(viewerId) || (this.leases.get(viewerId) || 0) <= this.clock()) throw problem("Select Start visuals before opening the video stream.", 403);
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.generation)) throw problem("The visualizer selection changed. Reconnect its video stream.", 409);
    if (!["starting", "running"].includes(this.state)) throw problem("SoundSpectrum video is unavailable. Select Start visuals to retry.", 409);
  }
  authorizeVideo(viewerId, expectedGeneration) {
    this.authorizeViewer(viewerId, expectedGeneration);
    if (this.transport !== "jpeg") throw problem("This visualizer uses OBS / WebRTC. Refresh its video connection.", 409);
    return { frame: this.latest, capturedAt: this.frameAt, generation: this.generation };
  }
  authorizeWebRTC(viewerId, generation) {
    if (!Number.isSafeInteger(generation)) throw problem("An exact visualizer generation is required.", 400);
    this.authorizeViewer(viewerId, generation);
    if (this.transport !== "obs-webrtc" || !this.obsSession?.ready || this.state !== "running" || !this.obsTransport?.signal) throw problem("OBS / WebRTC is not ready. Select Start visuals first.", 409);
  }
  authorizeHls(viewerId, generation) {
    if (!Number.isSafeInteger(generation)) throw problem("An exact visualizer generation is required.", 400);
    this.authorizeViewer(viewerId, generation);
    if (this.transport !== "hls" || this.state !== "running" || !this.hlsSession?.ready || !this.hlsTransport?.readAsset) throw problem("HLS is not ready. Select Start visuals first.", 409);
  }
  recordHlsControl(viewerId) {
    if (this.transport !== "hls") return;
    const previous = this.hlsActivity.get(viewerId);
    const activity = previous?.generation === this.generation ? previous : { generation: this.generation, mediaAt: null, renewedAt: null };
    activity.controlAt = this.clock(); this.hlsActivity.set(viewerId, activity);
  }
  renewHlsMedia(reader, chunk) {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.closed || !this.hlsReaders.has(reader) || reader.controller.signal.aborted ||
        reader.res.destroyed || reader.res.writableEnded || reader.body?.destroyed || this.transport !== "hls" || this.state !== "running" ||
        !this.hlsSession?.ready || this.hlsSession.stopping || this.hlsSession.generation !== reader.generation || reader.generation !== this.generation || this.leaseVisibility.get(reader.viewerId) !== "visible") return;
    const at = this.clock(), until = this.leases.get(reader.viewerId) || 0;
    if (until <= at) return;
    let activity = this.hlsActivity.get(reader.viewerId);
    if (activity?.generation !== this.generation) activity = { generation: this.generation, controlAt: null, renewedAt: null };
    activity.mediaAt = at; this.hlsActivity.set(reader.viewerId, activity);
    // Delivered bytes are demand even if browser control timers are delayed.
    // Headers, waiting preloads and hidden/retired viewers cannot keep it alive.
    if (activity.renewedAt === null || at - activity.renewedAt >= Math.min(1000, this.leaseMs / 4)) {
      this.leases.set(reader.viewerId, Math.max(until, at + this.leaseMs)); activity.renewedAt = at;
    }
  }
  closeHlsReaders(viewerId) {
    for (const reader of this.hlsReaders) if (!viewerId || reader.viewerId === viewerId) {
      this.hlsReaders.delete(reader); reader.controller.abort(); reader.body?.destroy?.(); reader.res.destroy();
    }
  }
  async hlsAsset(req, res, { viewerId, generation, name, query }) {
    this.authorizeHls(viewerId, generation);
    if (!HLS_ASSET.test(name)) throw problem("Unknown HLS media asset.", 404);
    if (this.hlsReaders.size >= 64 || [...this.hlsReaders].filter(reader => reader.viewerId === viewerId).length >= 16) throw problem("Too many pending HLS media requests.", 429);
    const forwarded = new URLSearchParams();
    for (const [key, value] of query) {
      if (key === "viewerId") continue;
      if ((key === "_HLS_msn" || key === "_HLS_part") && /^\d{1,12}$/.test(value) || key === "_HLS_skip" && ["YES", "v2"].includes(value)) forwarded.set(key, value);
      else throw problem("Invalid HLS media request.", 400);
    }
    const range = req.headers.range;
    if (range !== undefined && !/^bytes=\d{1,12}-\d{0,12}$/.test(range)) throw problem("Use a single bounded HLS byte range.", 416);
    if (range !== undefined) {
      const [first, last] = range.slice(6).split("-");
      if (last && Number(last) < Number(first)) throw problem("Use a single bounded HLS byte range.", 416);
    }
    const reader = { viewerId, generation, res, controller: new AbortController(), body: null };
    this.hlsReaders.add(reader);
    const done = () => { this.hlsReaders.delete(reader); reader.controller.abort(); reader.body?.destroy?.(); };
    req.once?.("aborted", done); res.once?.("close", done);
    try {
      let result;
      try { result = await this.hlsTransport.readAsset(name, { generation, query: forwarded, range, signal: reader.controller.signal }); }
      catch (error) { throw problem("The HLS media asset is unavailable.", error?.statusCode === 404 ? 404 : 502); }
      reader.body = result?.body;
      this.authorizeHls(viewerId, generation);
      if (reader.controller.signal.aborted) throw problem("The HLS media request ended.", 409);
      if (![200, 206].includes(result?.statusCode)) throw problem("The HLS media asset is unavailable.", result?.statusCode === 404 ? 404 : 502);
      const headers = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
      if (name.endsWith(".m3u8")) {
        const body = hlsManifest(result.body, viewerId, generation);
        headers["Content-Type"] = "application/vnd.apple.mpegurl"; headers["Content-Length"] = String(body.length);
        res.writeHead(200, headers); res.end(body); done(); return;
      }
      headers["Content-Type"] = name.endsWith(".ts") ? "video/mp2t" : "video/mp4";
      const upstream = result.headers || {};
      if (/^\d{1,12}$/.test(String(upstream["content-length"] || ""))) headers["Content-Length"] = String(upstream["content-length"]);
      if (/^bytes \d+-\d+\/(?:\d+|\*)$/.test(String(upstream["content-range"] || ""))) headers["Content-Range"] = upstream["content-range"];
      if (upstream["accept-ranges"] === "bytes") headers["Accept-Ranges"] = "bytes";
      if (!result.body || typeof result.body.pipe !== "function") throw problem("The HLS media asset is unavailable.", 502);
      result.body.once("error", () => { done(); res.destroy(); }); result.body.once("end", done);
      res.writeHead(result.statusCode, headers);
      result.body.on("data", chunk => this.renewHlsMedia(reader, chunk)); result.body.pipe(res);
    } catch (error) { done(); throw error; }
  }
  async signalWebRTC({ method, viewerId, generation, body = "", sessionId } = {}) {
    this.authorizeWebRTC(viewerId, generation);
    if (!["POST", "DELETE"].includes(method)) throw problem("Use POST or DELETE for WebRTC signaling.", 405);
    if (method === "POST" && (typeof body !== "string" || Buffer.byteLength(body) > MAX_SDP_BYTES || !/^v=0\r?\n/.test(body) || !/^m=video\s/m.test(body) || /^m=audio\s/m.test(body) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body))) throw problem("Use a bounded video-only SDP offer.");
    if (method === "DELETE" && !validWebRTCSession(sessionId)) throw problem("Invalid WebRTC session.");
    const owner = this.obsSession;
    let result;
    try { result = await this.obsTransport.signal({ method, viewerId, generation, body, sessionId }); }
    catch { throw problem("Could not complete the WebRTC video connection.", 502); }
    if (method === "DELETE") return { status: 204, headers: {}, body: "" };
    const resource = result?.sessionId;
    const clean = () => validWebRTCSession(resource) ? Promise.resolve().then(() => this.obsTransport.signal({ method: "DELETE", viewerId, generation, sessionId: resource, body: "" })).catch(() => {}) : Promise.resolve();
    try { this.authorizeWebRTC(viewerId, generation); if (this.obsSession !== owner) throw problem("The visualizer changed during WebRTC setup.", 409); }
    catch (error) { await clean(); throw error; }
    if (result?.status !== 201 || !validWebRTCSession(resource) || typeof result.body !== "string" || Buffer.byteLength(result.body) > MAX_SDP_BYTES || !/^v=0\r?\n/.test(result.body) || !/^m=video\s/m.test(result.body) || /^m=audio\s/m.test(result.body) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.body)) {
      await clean(); throw problem("OBS returned an invalid video-only WebRTC answer.", 502);
    }
    return { status: 201, headers: { "Content-Type": "application/sdp", Location: "/api/soundspectrum/webrtc?" + new URLSearchParams({ viewerId, generation: String(generation), sessionId: resource }) }, body: result.body };
  }
  releaseObsViewer(viewerId, generation = this.generation) {
    if (!this.obsSession || typeof this.obsTransport?.releaseViewer !== "function") return;
    // Reader cleanup does not interrupt the shared publisher or another lease.
    void Promise.resolve().then(() => this.obsTransport.releaseViewer({ viewerId, generation })).catch(() => {});
  }
  async session({ action, viewerId, visualizer, inputId, playerId, zoneId, whitecapTheme = "current", transport = "jpeg", bitrateMbps = 600, targetFps = 60, generation: expectedGeneration, visibility, reason, videoStats } = {}) {
    if (!validViewer(viewerId)) throw problem("Invalid visualizer viewer.");
    if (this.closed) throw problem("SoundSpectrum is shutting down.", 503);
    if (["start", "join"].includes(action) && transport === "hls" && ![60,120].includes(targetFps)) throw problem("Choose 60 or 120 fps.", 400);
    if (["start", "join"].includes(action) && transport === "hls" && !validHlsBitrate(bitrateMbps)) throw problem("Choose a whole HLS bitrate from 50 to 600 Mbps.", 400);
    if (action === "join") {
      whitecapTheme = whitecapThemeSelection(whitecapTheme, visualizer);
      if (this.state !== "running" || !Number.isSafeInteger(expectedGeneration) || expectedGeneration !== this.generation ||
          visualizer !== this.visualizer || whitecapTheme !== this.whitecapTheme || inputId !== this.inputId || transport !== this.transport || transport === "hls" && (bitrateMbps !== this.hlsBitrateMbps || targetFps !== this.hlsTargetFps) || (playerId || "") !== this.playerId || (zoneId || "") !== this.zoneId || ![...this.leases.values()].some(until => until > this.clock())) throw problem("The running visualizer selection changed. Refresh before joining it.", 409);
      if (this.leases.size >= 8 && !this.leases.has(viewerId)) throw problem("Too many visualizer viewers. Close another view first.", 429);
      this.leases.set(viewerId, this.clock() + this.leaseMs);
      this.leaseVisibility.set(viewerId, "visible");
      this.recordHlsControl(viewerId);
      return this.snapshot(viewerId);
    }
    if (action === "stop") {
      this.diagnostic({ event: "session-stop", generation: this.generation, nativePid: this.captureWindow?.pid || null,
        clients: this.leases.size, hadLease: (this.leases.get(viewerId) || 0) > this.clock(),
        reason: STOP_REASONS.has(reason) ? reason : "unknown", visibility: viewerVisibility(visibility),
        videoStats: (this.leases.get(viewerId) || 0) > this.clock() ? viewerVideoStats(videoStats) : null });
      this.pendingStarts.delete(viewerId);
      this.leases.delete(viewerId);
      this.leaseVisibility.delete(viewerId);
      this.viewerPerformance.delete(viewerId);
      this.hlsActivity.delete(viewerId);
      this.releaseObsViewer(viewerId);
      this.closeHlsReaders(viewerId);
      for (const client of this.clients) if (client.viewerId === viewerId) client.res.destroy();
      if (!this.leases.size && (["starting", "running"].includes(this.state) || this.hlsSession)) this.release("viewer-stop");
      return this.snapshot(viewerId);
    }
    if (action === "heartbeat") {
      if ((this.leases.get(viewerId) || 0) <= this.clock()) throw problem(this.state === "error" && this.error || "Visuals stopped. Select Start visuals to reconnect.", 409);
      const currentVisibility = viewerVisibility(visibility);
      // Chrome can cover the player when the user watches the native window.
      // Its hidden-page timers may run once a minute. Only an already-live
      // viewer can renew this bounded grace; no request can create a lease here.
      const duration = currentVisibility === "hidden" ? 90000 : this.leaseMs;
      this.leases.set(viewerId, this.clock() + duration);
      if (currentVisibility !== "unknown" && this.leaseVisibility.get(viewerId) !== currentVisibility) {
        this.diagnostic({ event: "viewer-visibility", generation: this.generation, nativePid: this.captureWindow?.pid || null,
          visibility: currentVisibility, leaseMs: duration, clients: this.leases.size });
      }
      this.leaseVisibility.set(viewerId, currentVisibility);
      this.recordHlsControl(viewerId);
      this.recordViewerPerformance(viewerId, currentVisibility, videoStats);
      return this.snapshot(viewerId);
    }
    if (action !== "start") throw problem("Unsupported visualizer action.");
    if (!PRODUCTS.has(visualizer)) throw problem("Choose Aeon, G-Force or WhiteCap.");
    whitecapTheme = whitecapThemeSelection(whitecapTheme, visualizer);
    if (!TRANSPORTS.has(transport)) throw problem("Choose JPEG, OBS / WebRTC or HLS.");
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
      if (whitecapTheme !== "current" && !inventory.whitecapThemes?.some(item => item.id === whitecapTheme && item.available)) throw problem("The NASA layer collection is unavailable on the PC. Refresh inputs after installation.", 503);
      if (transport === "jpeg" && !inventory.captureAvailable) throw problem(inventory.reason || "The SoundSpectrum video bridge is unavailable.", 503);
      if (transport === "obs-webrtc" && !inventory.transports?.some(item => item.id === transport && item.available)) throw problem("The isolated OBS / WebRTC transport is unavailable. Check its local configuration.", 503);
      if (transport === "hls" && !inventory.transports?.some(item => item.id === transport && item.available)) throw problem("The isolated HLS transport is unavailable. Check its local configuration.", 503);
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
    const obsProfile = transport === "obs-webrtc" ? obsConfiguredProfile(inventory.transports?.find(item => item.id === transport)?.profile) : null;
    const nativeProfile = transport === "hls" ? hlsProfile(bitrateMbps, targetFps) : obsProfile;
    if (transport === "obs-webrtc" && !obsProfile) throw problem("The isolated OBS quality profile is invalid.", 503);
    if (this.closed) throw problem("SoundSpectrum is shutting down.", 503);
    if (this.leases.size >= 8 && !this.leases.has(viewerId)) throw problem("Too many visualizer viewers. Close another view first.", 429);
    if (["starting", "running"].includes(this.state) && this.whitecapTheme !== whitecapTheme && [...this.leases].some(([id, until]) => id !== viewerId && until > this.clock())) throw problem("Stop the active visuals before changing the WhiteCap theme.", 409);
    if (["starting","running"].includes(this.state) && this.transport === "hls" && transport === "hls" && targetFps !== this.hlsTargetFps && [...this.leases].some(([id,until]) => id !== viewerId && until > this.clock())) throw problem("Stop the active visuals before changing the frame rate.", 409);
    this.leases.set(viewerId, this.clock() + this.leaseMs);
    this.leaseVisibility.set(viewerId, "visible");
    if (["running", "starting"].includes(this.state) && this.visualizer === visualizer && this.whitecapTheme === whitecapTheme && this.inputId === inputId && this.transport === transport && (transport !== "hls" || bitrateMbps === this.hlsBitrateMbps && targetFps === this.hlsTargetFps) && (!musicInput || this.playerId === (playerId || "") && this.zoneId === (zoneId || ""))) { this.recordHlsControl(viewerId); return this.snapshot(viewerId); }
    const generation = ++this.generation;
    this.closeHlsReaders();
    this.viewerPerformance.clear(); this.nextViewerSlot = 0;
    this.captureRecovering = false; this.captureRecoveryUsed = false; this.captureHealthySince = null;
    this.state = "starting"; this.visualizer = visualizer; this.transport = transport; this.inputId = inputId; this.inputKind = musicInput ? "music-feed" : noMicInput ? "no-mic" : "microphone";
    this.whitecapTheme = whitecapTheme;
    this.hlsActivity.clear(); this.recordHlsControl(viewerId);
    if (transport === "hls") { this.hlsBitrateMbps = bitrateMbps; this.hlsTargetFps = targetFps; }
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
        this.activeOBSProfile = obsProfile;
        if (musicInput) {
          await this.audioFeed.start({ inputId, playerId, zoneId, onFailure: error => { void this.fail(generation, error); } });
          if (generation !== this.generation || !this.leases.size || this.closed) { await this.audioFeed.stop(); return; }
        }
        const window = await this.native.start({ visualizer, inputId, ...(whitecapTheme !== "current" ? { whitecapTheme } : {}), ...(transport === "hls" ? { targetFrameRate: 120 } : {}), ...(nativeProfile ? { width: nativeProfile.width, height: nativeProfile.height, uniqueCaptureTitle: true,
          ...(nativeProfile.nativeWindowMode === "borderless-fullscreen" ? { windowMode: nativeProfile.nativeWindowMode } : {}) } : {}) });
        if (generation !== this.generation || !this.leases.size || this.closed) { await this.native.stop(); await this.audioFeed?.stop(); return; }
        if (transport === "obs-webrtc") await this.startOBS(window, generation);
        else if (transport === "hls") await this.startHls(window, generation, nativeProfile);
        else await this.startCapture(window, generation);
      } catch (error) { await this.fail(generation, error); }
    });
    return this.snapshot(viewerId);
  }
  async startOBS(window, generation) {
    const session = { generation, window, ready: false };
    this.obsSession = session; this.captureWindow = window; this.captureObservedAt = this.clock();
    this.fidelityNative = null; this.fidelityByteSample = null;
    this.captureTimes = []; this.captureFrames = this.captureBytes = this.coalescedFrames = this.mjpegFrames = this.mjpegDroppedFrames = 0;
    const isCurrent = () => {
      if (this.obsSession !== session || this.transport !== "obs-webrtc" || !this.captureSessionActive(generation)) return false;
      const status = this.native.status?.();
      return !status || status.state === "running" && status.owned === true && status.pid === window.pid;
    };
    try {
      await this.obsTransport.start({ window, nativeIdentity: this.native.captureIdentity?.(), generation, isCurrent, expectedProfileId: this.activeOBSProfile.id,
        observeWindow: async () => {
          if (!isCurrent()) throw Error("The owned renderer changed.");
          const observed = await this.native.captureWindow();
          if (!isCurrent() || observed?.pid !== window.pid || String(observed.windowHandle) !== String(window.windowHandle)) throw Error("The owned renderer changed.");
          return observed;
        },
        onReady: () => { if (!isCurrent()) return; session.ready = true; this.state = "running"; this.error = ""; this.videoState(); },
        onFailure: () => { if (this.obsSession === session && this.transport === "obs-webrtc" && this.captureSessionActive(generation)) void this.fail(generation, problem("The OBS video bridge stopped. Select Start visuals to retry.", 502)); }
      });
      if (this.captureSessionActive(generation) && (!isCurrent() || !session.ready)) throw Error("Publisher did not become ready.");
    } catch {
      if (this.captureSessionActive(generation)) throw problem("Could not start the isolated OBS / WebRTC video bridge. Check its local configuration.", 503);
    }
  }
  async startHls(window, generation, profile) {
    const nativeIdentity = this.native.captureIdentity?.();
    const session = { generation, window, nativeIdentity, ready: false };
    this.hlsSession = session; this.captureWindow = window; this.captureObservedAt = this.clock();
    this.fidelityNative = null; this.fidelityByteSample = null;
    const isCurrent = () => {
      if (this.hlsSession !== session || session.stopping || this.transport !== "hls" || !this.captureSessionActive(generation)) return false;
      const status = this.native.status?.();
      return !status || status.state === "running" && status.owned === true && status.pid === window.pid;
    };
    try {
      await this.hlsTransport.start({ window, nativeIdentity, generation, profile, isCurrent,
        observeWindow: async () => {
          if (!isCurrent()) throw Error("The owned renderer changed.");
          const observed = await this.native.captureWindow();
          const currentIdentity = this.native.captureIdentity?.();
          if (!isCurrent() || observed?.pid !== window.pid || String(observed.windowHandle) !== String(window.windowHandle) ||
              !nativeIdentity || !currentIdentity || ["pid", "windowHandle", "startTimeTicks", "executable", "windowTitle", "windowClass"].some(key => String(currentIdentity[key]) !== String(nativeIdentity[key]))) throw Error("The owned renderer changed.");
          return { ...currentIdentity, ...observed };
        },
        onReady: () => { if (!isCurrent()) return; session.ready = true; this.state = "running"; this.error = ""; this.videoState(); },
        onFailure: () => { if (isCurrent()) void this.fail(generation, problem("The HLS video bridge stopped. Select Start visuals to retry.", 502)); }
      });
      if (this.captureSessionActive(generation) && (!isCurrent() || !session.ready)) throw Error("HLS did not become ready.");
    } catch {
      if (this.captureSessionActive(generation)) throw problem("Could not start the isolated HLS video bridge. Check its local configuration.", 503);
    }
  }
  async startCapture(window, generation) {
    const command = this.capture.buildCaptureCommand({ windowHandle: window.windowHandle, width: 800, height: 450, fps: this.videoFps, quality: 65 });
    const child = this.spawn(command.command, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: command.env || process.env });
    this.child = child;
    this.captureWindow = window; this.captureHealthySince = null;
    this.captureObservedAt = this.clock(); this.fidelityNative = null; this.fidelityByteSample = null;
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
      const capturedAt = this.clock();
      if (this.captureHealthySince === null || capturedAt - this.frameAt > this.staleMs) this.captureHealthySince = capturedAt;
      this.latest = chunkFrame; this.latestPacket = this.clients.size ? multipartFrame(chunkFrame) : null; this.frameAt = capturedAt;
      // A failed retry cannot create a restart loop. A new budget is available
      // only after this capture has delivered frames for thirty seconds.
      if (this.captureRecoveryUsed && this.frameAt - this.captureHealthySince >= 30000) this.captureRecoveryUsed = false;
      this.captureTimes.push(this.frameAt); if (this.captureTimes.length > 120) this.captureTimes.shift();
      this.state = "running"; this.error = ""; clearTimeout(child.startDeadline);
      this.captureRecovering = false;
      this.emitVideo({ type: "frame", frame: chunkFrame, capturedAt: this.frameAt, generation });
      for (const client of this.clients) this.writeFrame(client, this.latestPacket);
    });
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    child.once("error", () => { void this.fail(generation, problem("Could not start the SoundSpectrum video bridge.", 503)); });
    child.once("close", (code, signal) => {
      clearTimeout(child.startDeadline);
      if (this.child === child && generation === this.generation) {
        this.captureClosed(child, generation, { code, signal, diagnostic });
      }
    });
    child.startDeadline = setTimeout(() => { void this.fail(generation, problem("SoundSpectrum did not produce video. Check the PC desktop session and try again.", 502)); }, this.startupMs);
    child.startDeadline.unref?.();
  }
  diagnostic(entry) {
    // Private server logging only; never include stderr in browser snapshots.
    try { this.onDiagnostic({ at: this.clock(), ...entry }); } catch {}
  }
  recordViewerPerformance(viewerId, visibility, value) {
    const stats = viewerVideoStats(value);
    if (!stats) return;
    const at = this.clock();
    if ((this.leases.get(viewerId) || 0) <= at) return;
    let entry = this.viewerPerformance.get(viewerId);
    if (!entry) {
      if (this.viewerPerformance.size >= 8) return;
      entry = { slot: ++this.nextViewerSlot, loggedAt: -Infinity };
      this.viewerPerformance.set(viewerId, entry);
    }
    // Mode changes appear on the next eligible sample, rather than allowing
    // fullscreen toggles or frequent heartbeats to flood the private log.
    if (at - entry.loggedAt < 15000) return;
    entry.loggedAt = at;
    const times = this.captureTimes, span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
    this.diagnostic({ event: "viewer-performance", generation: this.generation, viewerSlot: entry.slot, visibility,
      captureFps: span > 0 ? (times.length - 1) * 1000 / span : null,
      frameAgeMs: this.latest ? Math.max(0, at - this.frameAt) : null, ...stats });
  }
  captureClosed(child, generation, { code, signal, diagnostic }) {
    const expected = this.captureWindow;
    const blocked = /access|denied/i.test(diagnostic);
    // Windows reports native faults as high-bit process exit statuses, often
    // without a signal or stderr (for example 0xC0000005). Do not retry those.
    const windowsFault = Number.isInteger(code) && (code >>> 0) >= 0x80000000;
    const unsafe = blocked || !!signal || windowsFault || /DXGI_ERROR_DEVICE_|device.{0,20}(?:removed|lost|reset|hung)|0x887a000[567]|out of memory|0x8007000e/i.test(diagnostic);
    const message = blocked ? "Windows blocked capture of the SoundSpectrum window. Check the PC desktop session." : "The SoundSpectrum video bridge stopped. Select Start visuals to retry.";
    const retry = !unsafe && !this.captureRecoveryUsed && typeof this.native.captureWindow === "function" && Number.isInteger(expected?.pid) && expected.pid > 0;
    this.diagnostic({ event: "capture-exit", generation, pid: child.pid || null, nativePid: expected?.pid || null, code: code ?? null, signal: signal || null, retry, stderrTail: diagnostic.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(-2000) });
    if (!retry) { this.fail(generation, problem(message, 502)); return; }
    this.child = null; this.captureRecovering = true; this.captureRecoveryUsed = true;
    this.state = "starting"; this.error = ""; this.latest = null; this.latestPacket = null; this.frameAt = 0;
    for (const client of this.clients) client.pending = null;
    this.videoState();
    void this.enqueue(async () => {
      if (this.captureRecoveryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.captureRecoveryDelayMs));
      if (!this.captureSessionActive(generation)) return;
      try {
        // This validates only the existing PID/window. It never launches a
        // renderer, changes its size, enumerates audio, or restarts the feed.
        const window = await this.native.captureWindow();
        if (!this.captureSessionActive(generation)) return;
        if (window?.pid !== expected.pid || !window.windowHandle) throw Error("The owned visualizer window changed.");
        await this.startCapture(window, generation);
        this.diagnostic({ event: "capture-reconnect", generation, nativePid: window.pid });
      } catch {
        if (generation !== this.generation || this.closed) return;
        this.diagnostic({ event: "capture-reconnect-unavailable", generation, nativePid: expected.pid });
        this.fail(generation, problem(message, 502));
      }
    });
  }
  captureSessionActive(generation) {
    return generation === this.generation && !this.closed && [...this.leases.values()].some(until => until > this.clock());
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
    const hlsSession = this.hlsSession;
    if (hlsSession) { hlsSession.stopping = true; hlsSession.ready = false; }
    this.closeHlsReaders();
    // Retain ownership on failed helper cleanup so Stop or Start can retry.
    // Its native capture window and audio feed must outlive those helpers.
    if (hlsSession) {
      try { await this.hlsTransport.stop(); }
      catch { throw problem("The isolated HLS video bridge could not close cleanly. Select Stop visuals to retry.", 502); }
      if (this.hlsSession === hlsSession) this.hlsSession = null;
    }
    const child = this.child; this.child = null;
    const obsSession = this.obsSession; this.obsSession = null;
    this.activeOBSProfile = null;
    this.captureWindow = null; this.captureRecovering = false; this.captureRecoveryUsed = false; this.captureHealthySince = null;
    this.captureObservedAt = null; this.fidelityNative = null; this.fidelityByteSample = null;
    if (child) { clearTimeout(child.startDeadline); try { child.kill(); } catch {} }
    this.latest = null; this.latestPacket = null; this.frameAt = 0;
    for (const client of this.clients) client.pending = null;
    this.videoState();
    let obsFailure;
    if (obsSession) { try { await this.obsTransport.stop(); } catch { obsFailure = problem("The isolated OBS video bridge could not close cleanly.", 502); } }
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.audioFeed?.stop()),
      Promise.resolve().then(() => this.native.stop())
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (obsFailure) throw obsFailure;
    if (failure) throw failure.reason;
  }
  fail(generation, error) {
    if (generation !== this.generation || this.closed) return;
    this.diagnostic({ event: "session-failure", generation, state: this.state, nativePid: this.captureWindow?.pid || null,
      capturePid: this.child?.pid || null, clients: this.leases.size, frameAgeMs: this.latest ? Math.max(0, this.clock() - this.frameAt) : null,
      zoneState: ["playing", "paused", "loading", "stopped", "unknown"].includes(error?.zoneState) ? error.zoneState : null,
      reason: diagnosticText(error.message || "SoundSpectrum could not start.") });
    ++this.generation; this.state = "error"; this.error = error.message || "SoundSpectrum could not start.";
    this.closeHlsReaders();
    this.videoState();
    this.leases.clear(); this.leaseVisibility.clear(); this.viewerPerformance.clear(); this.hlsActivity.clear(); this.nextViewerSlot = 0;
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
    const cleanupGeneration = this.generation;
    void this.enqueue(() => this.cleanupOwned(cleanupGeneration));
  }
  release(reason = "unknown") {
    this.diagnostic({ event: "session-release", generation: this.generation, state: this.state, nativePid: this.captureWindow?.pid || null,
      capturePid: this.child?.pid || null, clients: this.leases.size, frameAgeMs: this.latest ? Math.max(0, this.clock() - this.frameAt) : null, reason });
    ++this.generation; this.state = "idle"; this.error = ""; this.latest = null; this.latestPacket = null;
    this.closeHlsReaders();
    this.hlsActivity.clear();
    this.viewerPerformance.clear(); this.nextViewerSlot = 0;
    this.videoState();
    for (const client of this.clients) client.res.destroy();
    this.clients.clear();
    const cleanupGeneration = this.generation;
    void this.enqueue(() => this.cleanupOwned(cleanupGeneration));
  }
  async cleanupOwned(generation = this.generation) {
    try { await this.stopOwned(); }
    catch (error) { if (generation === this.generation) { this.state = "error"; this.error = `SoundSpectrum could not close cleanly: ${error.message}`; } }
  }
  sweep() {
    const now = this.clock();
    this.srtExperiment.sweep();
    for (const [viewer, until] of this.leases) if (until <= now) {
      if (this.transport === "hls") {
        const activity = this.hlsActivity.get(viewer), readers = [...this.hlsReaders].filter(reader => reader.viewerId === viewer);
        const age = at => Number.isFinite(at) ? Math.max(0, now - at) : null;
        this.diagnostic({ event: "hls-lease-expired", generation: this.generation, visibility: viewerVisibility(this.leaseVisibility.get(viewer)),
          controlAgeMs: age(activity?.controlAt), mediaAgeMs: age(activity?.mediaAt), readers: readers.length, waitingReaders: readers.filter(reader => !reader.body).length });
      }
      this.releaseObsViewer(viewer); this.closeHlsReaders(viewer); this.leases.delete(viewer); this.leaseVisibility.delete(viewer); this.viewerPerformance.delete(viewer); this.hlsActivity.delete(viewer);
    }
    for (const client of this.clients) if (!this.leases.has(client.viewerId)) client.res.destroy();
    if (!this.leases.size && ["starting", "running"].includes(this.state)) this.release("lease-expired");
    else if (this.state === "running" && this.transport === "jpeg" && now - this.frameAt > this.staleMs) void this.fail(this.generation, problem("SoundSpectrum video stopped updating. Check the PC desktop and restart visuals.", 502));
    else if (this.state === "running" && ["obs-webrtc", "hls"].includes(this.transport) && this.native.status) {
      const native = this.native.status();
      if (native?.state !== "running" || native.owned !== true || native.pid !== this.captureWindow?.pid) void this.fail(this.generation, problem("The visualizer renderer stopped. Select Start visuals to retry.", 502));
    }
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
    this.closed = true; clearInterval(this.timer); this.pendingStarts.clear();
    await this.srtExperiment.close().catch(() => {});
    this.leases.clear(); this.leaseVisibility.clear(); this.viewerPerformance.clear(); this.release("shutdown");
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
  const visualDelay = new SoundSpectrumDelay();
  let obsTransport = null, hlsTransport = null;
  const optionalVideo = path.join(__dirname, "../integrations/soundspectrum-obs-webrtc/index.cjs");
  if (fs.existsSync(optionalVideo)) {
    try { obsTransport = require(optionalVideo).createIntegration(); }
    catch { console.warn("[soundspectrum] Optional OBS video transport is unavailable; JPEG remains available."); }
  }
  const optionalHls = path.join(__dirname, "../integrations/soundspectrum-hls/index.cjs");
  if (fs.existsSync(optionalHls)) {
    try { hlsTransport = require(optionalHls).createIntegration(); }
    catch { console.warn("[soundspectrum] Optional HLS transport is unavailable; existing transports remain available."); }
  }
  const entries = [];
  for (const [id, folder, options] of [
    ["feed:pre-hqplayer", "soundspectrum-audio-feed", {}],
    ["feed:hqplayer-analysis", "soundspectrum-hqplayer-feed", { requireZone: createHQPlayerZoneGuard(getRoonState) }]
  ]) {
    const optional = path.join(__dirname, `../integrations/${folder}/index.cjs`);
    if (!fs.existsSync(optional)) continue;
    try {
      entries.push({ id, integration: require(optional).createIntegration({ ...options, visualDelayMs: visualDelay.currentMs }) });
    } catch { console.warn("[soundspectrum] Optional music-feed module is unavailable; ordinary visualizer inputs remain available."); }
  }
  if (entries.length) {
    const integration = createFeedMux(entries);
    visualDelay.bind(ms => integration.audioFeed.setVisualDelayMs(ms));
    const native = require("./soundSpectrumNative").createSoundSpectrumNative({ additionalInputProvider: integration.additionalInputProvider });
    const service = new SoundSpectrum({ native, audioFeed: integration.audioFeed, obsTransport, hlsTransport });
    service.visualDelay = visualDelay;
    return service;
  }
  const service = new SoundSpectrum({ obsTransport, hlsTransport });
  service.visualDelay = visualDelay.bind(() => {}, false);
  return service;
}
async function readSDP(req) {
  if (!/^application\/sdp(?:;|$)/i.test(req.headers["content-type"] || "")) throw problem("Use application/sdp for WebRTC signaling.", 415);
  if (Number(req.headers["content-length"]) > MAX_SDP_BYTES) throw problem("The SDP offer is too large.", 413);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_SDP_BYTES) throw problem("The SDP offer is too large.", 413);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
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
      if (req.method === "GET" && route === "fidelity") return sendJson(res, 200, await service.fidelity());
      if (req.method === "GET" && route.startsWith("hls/")) {
        const match = /^hls\/(\d{1,10})\/([A-Za-z0-9_-]{1,128}\.(?:m3u8|mp4|m4s|ts))$/.exec(route);
        if (!match) return sendJson(res, 404, { error: "Unknown HLS media asset." });
        return await service.hlsAsset(req, res, { viewerId: url.searchParams.get("viewerId"), generation: Number(match[1]), name: match[2], query: url.searchParams });
      }
      if (route === "srt" && ["GET", "POST"].includes(req.method)) {
        res.setHeader("Cache-Control", "no-store, private");
        if (req.method === "GET") return sendJson(res, 200, service.srtExperiment.status(url.searchParams.get("viewerId")));
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "Use JSON for SRT experiment controls." });
        const request = await readJson(req);
        if (!["start", "stop"].includes(request?.action)) return sendJson(res, 400, { error: "Use Start or Stop for the SRT experiment." });
        return sendJson(res, 200, await service.srtExperiment[request.action](request));
      }
      if (route === "delay" && ["GET", "POST"].includes(req.method)) {
        if (!service.visualDelay) return sendJson(res, 503, { error: "The shared visual delay is unavailable." });
        if (req.method === "GET") return sendJson(res, 200, service.visualDelay.snapshot());
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "Use JSON for visual delay controls." });
        try { return sendJson(res, 200, await service.visualDelay.update(await readJson(req))); }
        catch (error) { return sendJson(res, error.statusCode || 500, { ...service.visualDelay.snapshot(), error: error.message }); }
      }
      if (req.method === "GET" && route === "video") return service.video(req, res, url.searchParams.get("viewerId"));
      if (["POST", "DELETE"].includes(req.method) && route === "webrtc") {
        const viewerId = url.searchParams.get("viewerId"), generationText = url.searchParams.get("generation");
        const generation = /^\d{1,10}$/.test(generationText || "") ? Number(generationText) : NaN;
        service.authorizeWebRTC(viewerId, generation);
        const body = req.method === "POST" ? await readSDP(req) : "";
        const signal = await service.signalWebRTC({ method: req.method, viewerId, generation, body, sessionId: url.searchParams.get("sessionId") });
        res.writeHead(signal.status, { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", ...signal.headers });
        return res.end(signal.body);
      }
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
