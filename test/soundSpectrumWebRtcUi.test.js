"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../public/soundSpectrumWebRTC.js"), "utf8");
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  const peers = [], requests = [], frames = new Map(), timers = new Map(), painted = [], events = [], statsQueries = [], visibilityListeners = new Set();
  let id = 0, at = 0, mode = "windowed", geometry = 0, paintMs = options.paintMs ?? 0;
  const video = { hidden: true, videoWidth: 1920, videoHeight: 1080, readyState: 2, currentTime: 0, srcObject: null, play: () => Promise.resolve(), pause() {}, removeAttribute() {},
    requestVideoFrameCallback: fn => { frames.set(++id, fn); return id; }, cancelVideoFrameCallback: key => frames.delete(key),
    getBoundingClientRect: () => { geometry++; return video.hidden ? { width: 0, height: 0 } : { width: 1200, height: 900 }; } };
  const backdrop = { hidden: true, width: 800, height: 450, getBoundingClientRect: () => { geometry++; return { width: 1600, height: 1000 }; },
    getContext: () => ({ drawImage: (...args) => { painted.push(args); at += paintMs; }, clearRect() {}, getContextAttributes: () => ({ colorSpace: "srgb", colorType: "unorm8" }), imageSmoothingQuality: "low" }) };
  if (options.raf) { delete video.requestVideoFrameCallback; delete video.cancelVideoFrameCallback; }
  const document = { hidden: false, visibilityState: "visible",
    addEventListener: (event, listener) => { if (event === "visibilitychange") visibilityListeners.add(listener); },
    removeEventListener: (event, listener) => { if (event === "visibilitychange") visibilityListeners.delete(listener); } };
  function receiver(overrides = {}) {
    const control = { supported: options.receiverSupported !== false, throws: options.receiverThrows === true, mismatch: options.receiverMismatch === true, ...overrides };
    const value = { targetWrites: [], control }; let target = null;
    if (control.supported) Object.defineProperty(value, "jitterBufferTarget", { configurable: true, get: () => target,
      set: requested => { value.targetWrites.push(requested); if (control.throws) throw Error("receiver rejected buffer target"); target = control.mismatch ? null : requested; } });
    return value;
  }
  class Peer {
    constructor(config) { this.config = config; this.transceivers = []; this.listeners = new Map(); this.iceGatheringState = options.gathering ? "gathering" : "complete"; this.connectionState = "new"; this.iceConnectionState = "new"; this.remotes = []; peers.push(this); }
    addTransceiver(kind, config) { const value = { kind, config, receiver: receiver() }; this.transceivers.push(value); return value; }
    async createOffer() { return { type: "offer", sdp: "v=0\r\na=recvonly\r\n" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remotes.push(value); }
    close() { this.closed = true; }
    addEventListener(event, fn) { this.listeners.set(event, fn); }
    removeEventListener(event, fn) { if (this.listeners.get(event) === fn) this.listeners.delete(event); }
    getStats() { const query = deferred(); statsQueries.push(query); return query.promise; }
  }
  class Stream { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } }
  const context = { window: {}, document, RTCPeerConnection: Peer, MediaStream: Stream, location: { href: "http://192.168.50.119:3777/" }, URL, URLSearchParams, AbortController, performance: { now: () => at },
    devicePixelRatio: 2, matchMedia: () => ({ matches: options.touch === true }),
    getComputedStyle: element => ({ objectFit: element === video ? "contain" : "cover", opacity: element === video ? "0.8" : "0.26", filter: element === video ? "none" : "blur(12px)", imageRendering: "auto" }),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: key => timers.delete(key),
    fetch: (url, config) => { const response = deferred(); requests.push({ url, config, ...response }); return response.promise; } };
  context.window = context; vm.runInNewContext(source, context);
  const media = context.createSoundSpectrumWebRTC({ video, backdrop, presentation: () => mode, onReady: value => events.push({ ready: value }), onError: () => events.push({ error: true }),
    onStats: () => options.onStats?.(media) });
  const response = (locationValue = "/api/soundspectrum/webrtc?sessionId=owned-session", text = "v=0\r\na=sendonly\r\n", ok = true) => ({ ok, headers: { get: () => locationValue }, text: async () => text });
  async function start() { const pending = media.start("viewer-1", "obs-webrtc", 4); await flush(); return { pending }; }
  async function connected() { const { pending } = await start(); requests[0].resolve(response()); await pending;
    const track = { kind: "video" }; peers[0].ontrack({ track }); await flush(); return track; }
  function frame(progress = true) { const [key, callback] = [...frames][0]; assert.ok(callback); frames.delete(key); if (progress) video.currentTime += 1 / 60; callback(at, { presentedFrames: 1 }); }
  return { media, peers, requests, frames, timers, painted, video, backdrop, context, events, statsQueries, response, start, connected, frame, visibilityListeners, receiver,
    advance: value => { at += value; }, presentation: value => { mode = value; }, geometry: () => geometry, paintCost: value => { paintMs = value; },
    visibility: value => { document.hidden = value === "hidden"; document.visibilityState = value; for (const listener of visibilityListeners) listener(); } };
}

test("WebRTC requires explicit Start and receives video only without media capture, JPEG, audio or a second decoder", async () => {
  const f = fixture(); assert.equal(f.peers.length, 0); assert.equal(f.requests.length, 0);
  await f.connected(); assert.equal(f.peers.length, 1);
  assert.equal(f.peers[0].transceivers[0].kind, "video"); assert.equal(f.peers[0].transceivers[0].config.direction, "recvonly");
  assert.equal(f.requests.length, 1); assert.match(f.requests[0].url, /^\/api\/soundspectrum\/webrtc\?viewerId=viewer-1&generation=4$/);
  assert.equal(f.requests[0].config.headers["Content-Type"], "application/sdp"); assert.match(f.requests[0].config.body, /recvonly/);
  assert.equal(f.media.ready(), false); f.frame(); assert.equal(f.media.ready(), true);
  assert.equal(f.video.hidden, false); assert.equal(f.video.muted, true); assert.equal(f.video.autoplay, true); assert.equal(f.video.playsInline, true);
  assert.equal(f.video.srcObject.getTracks().length, 1); assert.equal(f.painted[0][0], f.video);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 1);
  assert.doesNotMatch(source, /getUserMedia|captureStream|createImageBitmap|new WebSocket/);
});

test("fullscreen and Return keep one peer and reuse the foreground decoded video for the backdrop", async () => {
  const f = fixture({ touch: true }); await f.connected(); f.frame();
  assert.equal(f.backdrop.width, 320); assert.equal(f.backdrop.height, 180);
  f.presentation("visualizer-fullscreen"); f.advance(17); f.frame(); assert.equal(f.backdrop.width, 1920); assert.equal(f.backdrop.height, 1080);
  f.presentation("windowed"); f.advance(17); f.frame(); assert.equal(f.backdrop.width, 320);
  assert.ok(f.painted.every(args => args[0] === f.video)); assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.media.stats(false).frames, 3);
});

test("loaded hidden video retires its startup deadline without waiting for a suspended frame callback", async () => {
  const f = fixture(); await f.connected(); assert.equal(f.timers.size, 1); assert.equal(f.painted.length, 0);
  f.video.onloadeddata(); assert.equal(f.timers.size, 0); assert.equal(f.media.ready(), true); assert.equal(f.frames.size, 1);
  assert.equal(f.painted.length, 0); const loaded = f.video.onplaying; f.media.stop(); loaded();
  assert.equal(f.media.ready(), false); assert.equal(f.video.hidden, true); assert.equal(f.peers.length, 1);
});

test("Stop closes peer, video callback and exact remote resource and cannot be revived by a stale frame", async () => {
  const f = fixture(); const track = await f.connected(); f.frame(); const staleFrame = [...f.frames.values()][0];
  f.media.stop(); staleFrame(1000); await flush();
  assert.equal(f.peers[0].closed, true); assert.equal(f.video.srcObject, null); assert.equal(f.video.hidden, true); assert.equal(f.backdrop.hidden, true);
  assert.equal(track.onended, null); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.media.ready(), false);
  const cleanup = f.requests[1]; assert.equal(cleanup.config.method, "DELETE"); assert.equal(cleanup.config.keepalive, true);
  assert.match(cleanup.url, /sessionId=owned-session/); assert.match(cleanup.url, /viewerId=viewer-1/); assert.match(cleanup.url, /generation=4/);
  assert.equal(f.media.stats().fidelity.generation, null); assert.equal(f.media.stats().fidelity.decodedResolution, null);
});

test("a canceled late POST deletes its resource without applying an old answer or replacing the next peer", async () => {
  const f = fixture(); const first = await f.start(); f.media.stop(); const next = f.media.start("viewer-2", "obs-webrtc", 5); await flush();
  f.requests[0].resolve(f.response()); await first.pending;
  assert.equal(f.requests[2].config.method, "DELETE"); assert.match(f.requests[2].url, /viewerId=viewer-1/);
  assert.equal(f.peers[0].remotes.length, 0); assert.equal(f.peers[0].closed, true); assert.equal(f.peers[1].closed, undefined);
  f.requests[1].resolve(f.response("/api/soundspectrum/webrtc?sessionId=new-session")); await next;
  assert.equal(f.peers[1].remotes.length, 1); assert.equal(f.media.stats(false).transport, "obs-webrtc");
});

test("Stop after answer headers releases ownership once and fences a late answer body", async () => {
  const f = fixture(), body = deferred(); const { pending } = await f.start();
  f.requests[0].resolve({ ...f.response(), text: () => body.promise }); await flush(); f.media.stop(); body.resolve("v=0"); await pending;
  assert.equal(f.requests.filter(value => value.config.method === "DELETE").length, 1); assert.equal(f.peers[0].remotes.length, 0);
});

test("signaling rejects unowned resource locations and never sends cleanup to another origin or lease", async () => {
  for (const locationValue of ["https://other.example/api/soundspectrum/webrtc?sessionId=bad", "/other?sessionId=bad", "/api/soundspectrum/webrtc?sessionId=bad&viewerId=other", "/api/soundspectrum/webrtc?sessionId=bad&generation=99", ""]) {
    const f = fixture(); const { pending } = await f.start(); f.requests[0].resolve(f.response(locationValue)); await pending;
    assert.equal(f.peers[0].closed, true); assert.equal(f.requests.length, 1); assert.equal(f.events.at(-1).error, true); assert.equal(f.media.ready(), false);
  }
});

test("canceling incomplete ICE gathering closes its bounded listener without posting an obsolete offer", async () => {
  const f = fixture({ gathering: true }); const pending = f.media.start("viewer-1", "obs-webrtc", 4); await flush();
  assert.equal(f.peers[0].listeners.size, 1); assert.equal(f.requests.length, 0); f.media.stop(); await pending;
  assert.equal(f.peers[0].listeners.size, 0); assert.equal(f.peers[0].closed, true); assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
});

test("startup deadline and failed connection release their peer and require explicit retry without JPEG fallback", async () => {
  const f = fixture(); const { pending } = await f.start(); const timeout = [...f.timers.values()][0]; assert.equal(timeout.ms, 20000); timeout.fn();
  f.requests[0].resolve(f.response()); await pending; assert.equal(f.peers[0].closed, true); assert.equal(f.events.at(-1).error, true); assert.equal(f.peers.length, 1);
  const running = fixture(); await running.connected(); running.frame(); running.peers[0].connectionState = "disconnected"; running.peers[0].onconnectionstatechange();
  assert.equal(running.media.ready(), true); running.peers[0].connectionState = "failed"; running.peers[0].onconnectionstatechange();
  assert.equal(running.peers[0].closed, true); assert.equal(running.peers.length, 1); assert.equal(running.events.at(-1).error, true);
  assert.ok(running.requests.every(value => value.url.startsWith("/api/soundspectrum/webrtc?")));
});

test("accidental audio tracks are ignored and one video track alone enters the media element", async () => {
  const f = fixture(); const { pending } = await f.start(); f.requests[0].resolve(f.response()); await pending;
  f.peers[0].ontrack({ track: { kind: "audio" } }); assert.equal(f.video.srcObject, null); assert.equal(f.frames.size, 0);
  f.peers[0].ontrack({ track: { kind: "video" } }); await flush(); const stream = f.video.srcObject;
  f.peers[0].ontrack({ track: { kind: "video" } }); assert.equal(f.video.srcObject, stream); assert.equal(f.frames.size, 1);
});

test("diagnostics read actual negotiated RTP rate and codec while cheap heartbeats avoid geometry reads", async () => {
  const f = fixture(); await f.connected(); f.frame(); f.media.stats(false); assert.equal(f.geometry(), 0); assert.equal(f.statsQueries.length, 1);
  const report = (timestamp, bytesReceived) => new Map([["in", { type: "inbound-rtp", kind: "video", id: "in", codecId: "codec", timestamp, bytesReceived, frameWidth: 1920, frameHeight: 1080,
    framesDecoded: 60, framesDropped: 2, framesPerSecond: 60, packetsLost: 1, jitter: .002, totalDecodeTime: .12, jitterBufferDelay: .3, jitterBufferEmittedCount: 60 }], ["codec", { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" }]]);
  f.statsQueries[0].resolve(report(1000, 1000)); await flush(); f.advance(1000); f.media.stats(false); assert.equal(f.statsQueries.length, 2);
  f.statsQueries[1].resolve(report(2000, 1001000)); await flush();
  const value = f.media.stats().fidelity;
  assert.equal(value.codec, "video/H264"); assert.equal(value.wireMbps, 8); assert.equal(value.averagingSeconds, 1);
  assert.equal(value.decodedResolution.width, 1920); assert.equal(value.foregroundCanvasResolution, null); assert.equal(value.displayedImageCssResolution.height, 675);
  assert.equal(value.displayDevicePixels.width, 2400); assert.equal(value.foregroundScale.deviceX, 1.25);
  assert.equal(value.rtc.meanDecodeMs, 2); assert.equal(value.rtc.meanJitterBufferMs, 5); assert.equal(value.rtc.framesDropped, 2); assert.equal(value.rtc.jitterMs, 2);
  assert.equal(value.canvasColorSpace, null); assert.equal(value.nativeColorSpace, "Unknown"); assert.match(value.decoderColorSpace, /not verified/);
  assert.equal(f.statsQueries.length, 2); assert.equal(f.geometry(), 2); assert.equal(f.peers.length, 1);
});

test("obsolete asynchronous statistics cannot restore measurements after Stop", async () => {
  const f = fixture(); await f.connected(); f.frame(); f.media.stats(false); f.media.stop();
  f.statsQueries[0].resolve(new Map([["in", { type: "inbound-rtp", kind: "video", codecId: "codec", timestamp: 10, bytesReceived: 20, frameWidth: 3840, frameHeight: 2160 }]])); await flush();
  const value = f.media.stats().fidelity; assert.equal(value.active, false); assert.equal(value.generation, null); assert.equal(value.transmittedResolution, null); assert.equal(value.codec, null);
});

test("visible frame waits are measured before recovery and the largest gap survives later heartbeat windows", async () => {
  const f = fixture(); await f.connected(); f.advance(5000);
  assert.equal(f.media.stats(false).lastPaintGapMs, null); assert.equal(f.media.stats(false).maxPaintGapMs, null);
  f.frame(); f.advance(17); f.frame(); f.advance(1500);
  let value = f.media.stats(false);
  assert.equal(value.lastPaintGapMs, 1500); assert.equal(value.maxPaintGapMs, 1500);
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 0);
  f.frame(); f.advance(17); f.frame(); value = f.media.stats(false);
  assert.equal(value.lastPaintGapMs, 17); assert.equal(value.maxPaintGapMs, 1500);
  for (let i = 0; i < 1000; i++) { f.advance(17); f.frame(); }
  value = f.media.stats(false);
  assert.equal(value.maxPaintGapMs, 1500); assert.equal(value.lastPaintGapMs, 17);
  assert.ok(value.displayedFps > 58 && value.displayedFps < 60);
  assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.geometry(), 0);
});

test("hidden and resume waits do not grow visible gap evidence or add timers", async () => {
  const f = fixture(); await f.connected(); f.frame(); f.advance(17); f.frame();
  assert.equal(f.visibilityListeners.size, 1); assert.equal(f.media.stats(false).maxPaintGapMs, 17);
  f.visibility("hidden"); f.advance(18000);
  let value = f.media.stats(false); assert.equal(value.lastPaintGapMs, null); assert.equal(value.maxPaintGapMs, 17);
  f.frame(); f.visibility("visible"); f.advance(3000);
  value = f.media.stats(false); assert.equal(value.lastPaintGapMs, null); assert.equal(value.maxPaintGapMs, 17);
  assert.equal(value.displayedFps, null);
  f.frame(); f.advance(33); f.frame(); value = f.media.stats(false);
  assert.equal(value.lastPaintGapMs, 33); assert.equal(value.maxPaintGapMs, 33);
  assert.equal(f.timers.size, 0); assert.equal(f.peers.length, 1);
  f.media.stop(); assert.equal(f.visibilityListeners.size, 0);
});

test("Stop and a new Start clear gap and paint samples without counting startup delay", async () => {
  const f = fixture({ paintMs: 4 }); await f.connected(); f.frame(); f.advance(900); f.media.stats(false);
  assert.equal(f.media.stats(false).maxPaintGapMs, 904); assert.equal(f.media.stats(false).meanPaintMs, 4);
  f.media.stop(); let value = f.media.stats(false);
  assert.equal(value.maxPaintGapMs, null); assert.equal(value.lastPaintGapMs, null); assert.equal(value.meanPaintMs, null);
  assert.equal(value.receivedFrames, null); assert.equal(value.decodedFrames, null); assert.equal(f.visibilityListeners.size, 0);
  const pending = f.media.start("viewer-2", "obs-webrtc", 5); await flush();
  f.requests.at(-1).resolve(f.response("/api/soundspectrum/webrtc?sessionId=next-owned-session")); await pending;
  f.peers.at(-1).ontrack({ track: { kind: "video" } }); await flush(); f.advance(12000);
  value = f.media.stats(false); assert.equal(value.maxPaintGapMs, null); assert.equal(value.lastPaintGapMs, null);
  f.frame(); value = f.media.stats(false);
  assert.equal(value.maxPaintGapMs, 4); assert.equal(value.lastPaintGapMs, 4); assert.equal(value.meanPaintMs, 4);
  assert.equal(f.visibilityListeners.size, 1); assert.equal(f.frames.size, 1);
});

test("RAF callbacks with unchanged video time do not conceal a stalled foreground", async () => {
  const f = fixture({ raf: true }); await f.connected(); f.frame();
  for (let i = 0; i < 10; i++) { f.advance(100); f.frame(false); }
  let value = f.media.stats(false);
  assert.equal(value.frames, 1); assert.equal(value.lastPaintGapMs, 1000); assert.equal(value.maxPaintGapMs, 1000);
  assert.equal(f.painted.length, 1); assert.equal(f.frames.size, 1);
  f.advance(17); f.frame(); f.advance(17); f.frame(); value = f.media.stats(false);
  assert.equal(value.lastPaintGapMs, 17); assert.equal(value.maxPaintGapMs, 1017);
  assert.equal(value.frames, 3); assert.equal(f.peers.length, 1);
});

test("decorative copy timing is bounded to 120 samples and leaves foreground and backdrop geometry unchanged", async () => {
  const f = fixture({ touch: true, paintMs: 6 }); await f.connected();
  for (let i = 0; i < 150; i++) { f.advance(17); f.frame(); }
  assert.equal(f.media.stats(false).meanPaintMs, 6); assert.equal(f.backdrop.width, 320); assert.equal(f.backdrop.height, 180);
  f.paintCost(2); f.presentation("visualizer-fullscreen");
  for (let i = 0; i < 120; i++) { f.advance(17); f.frame(); }
  assert.equal(f.media.stats(false).meanPaintMs, 2); assert.equal(f.backdrop.width, 1920); assert.equal(f.backdrop.height, 1080);
  assert.equal(f.painted.length, 270); assert.ok(f.painted.every(args => args[0] === f.video));
  assert.equal(f.video.hidden, false); assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.geometry(), 0);
});

test("received and decoded counters remain distinct and interval rates require a valid monotonic baseline", async () => {
  const f = fixture(); await f.connected(); f.frame();
  const report = (timestamp, received, decoded, id = "in") => new Map([[id, { type: "inbound-rtp", kind: "video", id,
    timestamp, bytesReceived: timestamp * 100, framesReceived: received, framesDecoded: decoded, framesPerSecond: 999 }]]);
  async function sample(timestamp, received, decoded, id) {
    f.media.stats(false); f.statsQueries.at(-1).resolve(report(timestamp, received, decoded, id)); await flush(); return f.media.stats(false);
  }
  let value = await sample(1000, 120, 100);
  assert.equal(value.receivedFrames, 120); assert.equal(value.decodedFrames, 100);
  assert.equal(value.receiveFps, null); assert.equal(value.decodeFps, null);
  f.advance(1000); value = await sample(2000, 170, 140);
  assert.equal(value.receiveFps, 50); assert.equal(value.decodeFps, 40);
  f.advance(1000); value = await sample(3000, 10, 5);
  assert.equal(value.receiveFps, null); assert.equal(value.decodeFps, null);
  f.advance(1000); value = await sample(4000, 20, 15);
  assert.equal(value.receiveFps, 10); assert.equal(value.decodeFps, 10);
  f.advance(1000); value = await sample(5000, 120, 100, "new-in");
  assert.equal(value.receiveFps, null); assert.equal(value.decodeFps, null);
  assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.geometry(), 0);
});

test("unsupported RTC frame counters stay unknown rather than borrowing decoded frames or reported FPS", async () => {
  const f = fixture(); await f.connected(); f.frame(); f.media.stats(false);
  f.statsQueries[0].resolve(new Map([["in", { type: "inbound-rtp", kind: "video", id: "in", timestamp: 1000,
    framesDecoded: 40, framesPerSecond: 60 }]])); await flush();
  let value = f.media.stats(false);
  assert.equal(value.receivedFrames, null); assert.equal(value.decodedFrames, 40); assert.equal(value.receiveFps, null); assert.equal(value.decodeFps, null);
  f.advance(1000); f.media.stats(false);
  f.statsQueries[1].resolve(new Map([["in", { type: "inbound-rtp", kind: "video", id: "in", timestamp: 2000,
    framesDecoded: 90, framesPerSecond: 60 }]])); await flush(); value = f.media.stats(false);
  assert.equal(value.receivedFrames, null); assert.equal(value.receiveFps, null); assert.equal(value.decodeFps, 50);
  assert.equal(value.rtc.receivedBitrateMbps, null);
});

test("byte counter resets cannot invalidate otherwise monotonic received and decoded frame rates", async () => {
  const f = fixture(); await f.connected(); f.frame();
  const report = (timestamp, bytesReceived, framesReceived, framesDecoded) => new Map([["in", {
    type: "inbound-rtp", kind: "video", id: "in", timestamp, bytesReceived, framesReceived, framesDecoded }]]);
  f.media.stats(false); f.statsQueries[0].resolve(report(1000, 500000, 100, 90)); await flush();
  f.advance(1000); f.media.stats(false); f.statsQueries[1].resolve(report(2000, 100, 160, 145)); await flush();
  let value = f.media.stats(false);
  assert.equal(value.rtc.receivedBitrateMbps, null); assert.equal(value.receiveFps, 60); assert.equal(value.decodeFps, 55);
  f.advance(1000); f.media.stats(false); f.statsQueries[2].resolve(report(3000, 1000100, 220, 200)); await flush();
  value = f.media.stats(false); assert.equal(value.rtc.receivedBitrateMbps, 8); assert.equal(value.receiveFps, 60); assert.equal(value.decodeFps, 55);
});

test("a late old stats response cannot overwrite or release the new Start's pending diagnostic query", async () => {
  const f = fixture(); await f.connected(); f.frame(); f.media.stats(false); f.media.stop();
  const pending = f.media.start("viewer-2", "obs-webrtc", 5); await flush();
  f.requests.at(-1).resolve(f.response("/api/soundspectrum/webrtc?sessionId=next-owned-session")); await pending;
  f.peers.at(-1).ontrack({ track: { kind: "video" } }); await flush(); f.frame(); f.media.stats(false);
  assert.equal(f.statsQueries.length, 2);
  f.statsQueries[0].resolve(new Map([["old", { type: "inbound-rtp", kind: "video", id: "old", timestamp: 1000,
    framesReceived: 999, framesDecoded: 888 }]])); await flush(); f.advance(2000);
  let value = f.media.stats(false); assert.equal(f.statsQueries.length, 2); assert.equal(value.receivedFrames, null); assert.equal(value.decodedFrames, null);
  f.statsQueries[1].resolve(new Map([["new", { type: "inbound-rtp", kind: "video", id: "new", timestamp: 2000,
    framesReceived: 6, framesDecoded: 4 }]])); await flush(); value = f.media.stats(false);
  assert.equal(value.receivedFrames, 6); assert.equal(value.decodedFrames, 4); assert.equal(f.peers[1].closed, undefined);
});

test("slow or throwing RTC diagnostics cannot overlap queries, stop video or make synchronous heartbeat stats fail", async () => {
  const f = fixture(); await f.connected(); f.frame();
  assert.doesNotThrow(() => f.media.stats(false)); assert.equal(f.statsQueries.length, 1);
  f.advance(2000); assert.doesNotThrow(() => f.media.stats(false)); assert.equal(f.statsQueries.length, 1);
  f.statsQueries[0].reject(Error("diagnostic-only failure")); await flush();
  f.peers[0].getStats = () => { throw Error("unsupported diagnostic"); };
  assert.doesNotThrow(() => f.media.stats(false)); await flush();
  f.advance(17); f.frame(); assert.equal(f.media.ready(), true); assert.equal(f.frames.size, 1);
  assert.equal(f.peers[0].closed, undefined); assert.equal(f.requests.length, 1); assert.equal(f.events.filter(value => value.error).length, 0);
  assert.equal(f.geometry(), 0); assert.equal(f.timers.size, 0);
});

const bufferReport = (timestamp, emitted, delay, target, minimum, id = "in") => new Map([[id, {
  type: "inbound-rtp", kind: "video", id, timestamp, jitterBufferEmittedCount: emitted,
  jitterBufferDelay: delay, jitterBufferTargetDelay: target, jitterBufferMinimumDelay: minimum
}]]);
async function bufferSample(f, report, elapsed = 0) {
  f.advance(elapsed); const before = f.statsQueries.length; f.media.stats(false);
  assert.equal(f.statsQueries.length, before + 1, "one bounded diagnostic query is started");
  f.statsQueries.at(-1).resolve(report); await flush(); return f.media.stats(false).rtc;
}
function assertNoBufferInterval(rtc) {
  for (const name of ["jitterBufferMs", "jitterBufferTargetMs", "jitterBufferMinimumMs", "bufferIntervalSeconds"]) assert.equal(rtc[name], null, name);
}
const assertNear = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${actual} is approximately ${expected}`);

test("250 ms is the initial video receiver request and starts no media until explicit Start", async () => {
  const f = fixture(); let state = f.media.bufferState();
  assert.equal(state.mode, "250ms"); assert.equal(state.requestedMs, 250); assert.equal(state.state, "idle"); assert.equal(state.supported, null);
  assert.equal(f.peers.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
  await f.connected(); f.frame(); state = f.media.bufferState();
  const receiver = f.peers[0].transceivers[0].receiver;
  assert.equal(receiver.jitterBufferTarget, 250); assert.ok(receiver.targetWrites.includes(250));
  assert.equal(state.mode, "250ms"); assert.equal(state.state, "applied"); assert.equal(state.supported, true);
  const rtc = f.media.stats(false).rtc;
  assert.equal(rtc.bufferMode, "250ms"); assert.equal(rtc.requestedBufferMs, 250);
  assert.equal(rtc.bufferTargetSupported, true); assert.equal(rtc.bufferTargetState, "applied");
  assertNoBufferInterval(rtc); assert.equal(rtc.sampleAgeMs, null);
  assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test("Automatic and 250 ms apply to an active receiver without creating another peer or signaling request", async () => {
  const f = fixture(); await f.connected(); f.frame(); const receiver = f.peers[0].transceivers[0].receiver;
  const beforeWrites = receiver.targetWrites.length;
  assert.notEqual(f.media.setBufferTarget(null), false); assert.equal(receiver.jitterBufferTarget, null);
  let state = f.media.bufferState(); assert.equal(state.mode, "automatic"); assert.equal(state.requestedMs, null); assert.equal(state.state, "applied");
  assert.notEqual(f.media.setBufferTarget(250), false); assert.equal(receiver.jitterBufferTarget, 250);
  state = f.media.bufferState(); assert.equal(state.mode, "250ms"); assert.equal(state.requestedMs, 250); assert.equal(state.state, "applied");
  assert.equal(receiver.targetWrites.length, beforeWrites + 2);
  assert.equal(f.media.ready(), true); assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.events.filter(event => event.error).length, 0);
});

test("Automatic selection survives Stop and applies to the replacement video receiver", async () => {
  const f = fixture(); assert.notEqual(f.media.setBufferTarget(null), false);
  assert.equal(f.media.bufferState().state, "idle"); await f.connected(); f.frame();
  const firstReceiver = f.peers[0].transceivers[0].receiver; assert.equal(firstReceiver.jitterBufferTarget, null);
  const beforeWrites = firstReceiver.targetWrites.length; f.media.stop();
  let state = f.media.bufferState(); assert.equal(state.mode, "automatic"); assert.equal(state.state, "idle"); assert.equal(state.supported, null);
  const pending = f.media.start("viewer-2", "obs-webrtc", 5); await flush();
  f.requests.at(-1).resolve(f.response("/api/soundspectrum/webrtc?sessionId=next-owned-session")); await pending;
  f.peers[1].ontrack({ track: { kind: "video" } }); await flush(); f.frame();
  const nextReceiver = f.peers[1].transceivers[0].receiver;
  assert.notEqual(nextReceiver, firstReceiver); assert.equal(nextReceiver.jitterBufferTarget, null); assert.ok(nextReceiver.targetWrites.includes(null));
  assert.equal(firstReceiver.targetWrites.length, beforeWrites); assert.equal(f.peers[0].closed, true);
  state = f.media.bufferState(); assert.equal(state.mode, "automatic"); assert.equal(state.state, "applied"); assert.equal(state.supported, true);
});

test("unsupported native receiver buffering is reported truthfully while video continues", async () => {
  const f = fixture({ receiverSupported: false }); await f.connected(); f.frame();
  let state = f.media.bufferState(); assert.equal(state.mode, "250ms"); assert.equal(state.state, "unsupported"); assert.equal(state.supported, false);
  const rtc = f.media.stats(false).rtc; assert.equal(rtc.bufferTargetSupported, false); assert.equal(rtc.bufferTargetState, "unsupported");
  assert.notEqual(f.media.setBufferTarget(null), false); state = f.media.bufferState();
  assert.equal(state.mode, "automatic"); assert.equal(state.state, "unsupported"); assert.equal(state.requestedMs, null);
  assert.equal(f.peers[0].transceivers[0].receiver.targetWrites.length, 0);
  f.advance(17); f.frame(); assert.equal(f.media.ready(), true); assert.equal(f.frames.size, 1); assert.equal(f.peers.length, 1);
  assert.equal(f.peers[0].closed, undefined); assert.equal(f.events.filter(event => event.error).length, 0);
});

test("native receiver setter exceptions and unmatched readback report rejection without stopping video", async () => {
  for (const option of [{ receiverThrows: true }, { receiverMismatch: true }]) {
    const f = fixture(option); await f.connected(); f.frame();
    let state = f.media.bufferState(); assert.equal(state.mode, "250ms"); assert.equal(state.state, "rejected"); assert.equal(state.supported, true);
    const rtc = f.media.stats(false).rtc; assert.equal(rtc.bufferTargetState, "rejected"); assert.equal(rtc.bufferTargetSupported, true);
    const receiver = f.peers[0].transceivers[0].receiver; receiver.control.throws = false; receiver.control.mismatch = false;
    assert.notEqual(f.media.setBufferTarget(null), false); state = f.media.bufferState(); assert.equal(state.state, "applied"); assert.equal(receiver.jitterBufferTarget, null);
    f.advance(17); f.frame(); assert.equal(f.media.ready(), true); assert.equal(f.peers[0].closed, undefined);
    assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.events.filter(event => event.error).length, 0);
  }
});

test("invalid buffer requests preserve the selected mode and native receiver target", async () => {
  const f = fixture(); await f.connected(); f.frame(); const receiver = f.peers[0].transceivers[0].receiver;
  const writes = receiver.targetWrites.length;
  for (const value of [undefined, "250", 0, -1, 500, NaN, Infinity, {}, false]) assert.equal(f.media.setBufferTarget(value), false);
  const state = f.media.bufferState(); assert.equal(state.mode, "250ms"); assert.equal(state.requestedMs, 250); assert.equal(state.state, "applied");
  assert.equal(receiver.jitterBufferTarget, 250); assert.equal(receiver.targetWrites.length, writes); assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1);
});

test("buffer measurements use interval counter differences rather than target readback or lifetime means", async () => {
  const f = fixture(); await f.connected(); f.frame();
  let rtc = await bufferSample(f, bufferReport(1000, 100, 10, 12, 2));
  assertNoBufferInterval(rtc); assert.equal(rtc.meanJitterBufferMs, 100); assert.equal(rtc.sampleAgeMs, 0);
  rtc = await bufferSample(f, bufferReport(2000, 160, 13, 27, 3.2), 1000);
  assert.equal(rtc.jitterBufferMs, 50); assert.equal(rtc.jitterBufferTargetMs, 250); assertNear(rtc.jitterBufferMinimumMs, 20);
  assert.equal(rtc.bufferIntervalSeconds, 1); assert.equal(rtc.meanJitterBufferMs, 81.25);
  assert.notEqual(rtc.jitterBufferMs, rtc.requestedBufferMs); assert.equal(rtc.requestedBufferMs, 250);
  f.advance(350); rtc = f.media.stats(false).rtc; assert.equal(rtc.sampleAgeMs, 350);
  assert.equal(f.geometry(), 0); assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test("optional target and minimum delay counters remain unknown while actual interval delay is measured", async () => {
  const f = fixture(); await f.connected(); f.frame();
  await bufferSample(f, bufferReport(1000, 100, 10, undefined, undefined));
  let rtc = await bufferSample(f, bufferReport(2000, 160, 13, undefined, undefined), 1000);
  assert.equal(rtc.jitterBufferMs, 50); assert.equal(rtc.jitterBufferTargetMs, null); assert.equal(rtc.jitterBufferMinimumMs, null);
  assert.equal(rtc.bufferIntervalSeconds, 1);
  rtc = await bufferSample(f, bufferReport(3000, undefined, 16, 30, 6), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(4000, 220, 19, 45, 7.2), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(5000, 280, 22, 60, 8.4), 1000); assert.equal(rtc.jitterBufferMs, 50);
  assert.equal(rtc.jitterBufferTargetMs, 250); assertNear(rtc.jitterBufferMinimumMs, 20);
});

test("a valid zero delay interval remains measured zero instead of unknown or requested 250 ms", async () => {
  const f = fixture(); await f.connected(); f.frame();
  await bufferSample(f, bufferReport(1000, 100, 0, 0, 0));
  const rtc = await bufferSample(f, bufferReport(2000, 160, 0, 0, 0), 1000);
  assert.equal(rtc.jitterBufferMs, 0); assert.equal(rtc.jitterBufferTargetMs, 0); assert.equal(rtc.jitterBufferMinimumMs, 0);
  assert.equal(rtc.bufferIntervalSeconds, 1); assert.equal(rtc.requestedBufferMs, 250); assert.equal(rtc.bufferTargetState, "applied");
});

test("a cumulative delay counter reset never emits a negative or mixed buffer interval and recovers from the new baseline", async () => {
  const f = fixture(); await f.connected(); f.frame();
  await bufferSample(f, bufferReport(1000, 100, 10, 12, 2));
  let rtc = await bufferSample(f, bufferReport(2000, 160, 1, 27, 3.2), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(3000, 220, 4, 42, 4.4), 1000);
  assert.equal(rtc.jitterBufferMs, 50); assert.equal(rtc.jitterBufferTargetMs, 250); assertNear(rtc.jitterBufferMinimumMs, 20);
  assert.equal(rtc.bufferIntervalSeconds, 1);
});

test("emitted counter resets, unchanged emission, timestamp resets and stream changes invalidate buffer intervals", async () => {
  const f = fixture(); await f.connected(); f.frame(); await bufferSample(f, bufferReport(1000, 100, 10, 12, 2));
  let rtc = await bufferSample(f, bufferReport(2000, 160, 13, 27, 3.2), 1000); assert.equal(rtc.jitterBufferMs, 50);
  rtc = await bufferSample(f, bufferReport(3000, 10, 1, 2, .2), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(4000, 70, 4, 17, 1.4), 1000); assert.equal(rtc.jitterBufferMs, 50);
  rtc = await bufferSample(f, bufferReport(5000, 70, 4, 17, 1.4), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(6000, 130, 7, 32, 2.6), 1000); assert.equal(rtc.jitterBufferMs, 50);
  rtc = await bufferSample(f, bufferReport(500, 190, 10, 47, 3.8), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(1500, 250, 13, 62, 5), 1000); assert.equal(rtc.jitterBufferMs, 50);
  rtc = await bufferSample(f, bufferReport(2500, 310, 16, 77, 6.2, "replacement-in"), 1000); assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(3500, 370, 19, 92, 7.4, "replacement-in"), 1000); assert.equal(rtc.jitterBufferMs, 50);
});

test("identical RTC timestamps cannot refresh cached measurement age or create a new interval", async () => {
  const f = fixture(); await f.connected(); f.frame(); await bufferSample(f, bufferReport(1000, 100, 10, 12, 2));
  let rtc = await bufferSample(f, bufferReport(2000, 160, 13, 27, 3.2), 1000); assert.equal(rtc.sampleAgeMs, 0);
  f.advance(450); assert.equal(f.media.stats(false).rtc.sampleAgeMs, 450);
  rtc = await bufferSample(f, bufferReport(2000, 160, 13, 27, 3.2), 550);
  assert.equal(rtc.sampleAgeMs, 1000); assertNoBufferInterval(rtc); f.advance(300); assert.equal(f.media.stats(false).rtc.sampleAgeMs, 1300);
  rtc = await bufferSample(f, bufferReport(3000, 220, 16, 42, 4.4), 700);
  assert.equal(rtc.sampleAgeMs, 0); assert.equal(rtc.jitterBufferMs, 50); assert.equal(rtc.bufferIntervalSeconds, 1);
});

test("a slow diagnostic result keeps its request age and an onStats cache read cannot start a recursive query loop", async () => {
  let notifications = 0, notifiedStats = null;
  const f = fixture({ onStats: media => { notifications++; notifiedStats = media.stats(false); } });
  await f.connected(); f.frame(); f.media.stats(false); assert.equal(f.statsQueries.length, 1);
  f.advance(3500); f.media.stats(false); assert.equal(f.statsQueries.length, 1);
  f.statsQueries[0].resolve(bufferReport(1000, 100, 10, 12, 2)); await flush();
  assert.equal(notifications, 1); assert.equal(f.statsQueries.length, 1);
  assert.equal(notifiedStats.rtc.sampleAgeMs, 3500); assertNoBufferInterval(notifiedStats.rtc);
  const rtc = f.media.stats(false).rtc; assert.equal(rtc.sampleAgeMs, 3500); assert.equal(f.statsQueries.length, 2);
  await flush(); assert.equal(notifications, 1); assert.equal(f.statsQueries.length, 2);
  assert.equal(f.media.ready(), true); assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 0); assert.equal(f.events.filter(event => event.error).length, 0);
});

test("changing buffer choice clears interval history and fences late statistics from the old choice", async () => {
  const f = fixture(); await f.connected(); f.frame(); await bufferSample(f, bufferReport(1000, 100, 10, 12, 2));
  let rtc = await bufferSample(f, bufferReport(2000, 160, 13, 27, 3.2), 1000); assert.equal(rtc.jitterBufferMs, 50);
  f.advance(1000); f.media.stats(false); const oldQuery = f.statsQueries.at(-1), queries = f.statsQueries.length;
  assert.notEqual(f.media.setBufferTarget(null), false); rtc = f.media.stats(false).rtc;
  assert.equal(rtc.bufferMode, "automatic"); assert.equal(rtc.requestedBufferMs, null); assertNoBufferInterval(rtc); assert.equal(rtc.sampleAgeMs, null);
  f.advance(1000); f.media.stats(false); assert.equal(f.statsQueries.length, queries, "choice changes do not overlap the outstanding query");
  oldQuery.resolve(bufferReport(3000, 220, 28, 99, 8)); await flush(); rtc = f.media.stats(false).rtc;
  assertNoBufferInterval(rtc); assert.equal(rtc.sampleAgeMs, null); assert.equal(rtc.bufferMode, "automatic");
  assert.equal(f.statsQueries.length, queries + 1);
  f.statsQueries.at(-1).resolve(bufferReport(4000, 280, 31, 102, 9.2)); await flush(); rtc = f.media.stats(false).rtc; assertNoBufferInterval(rtc);
  rtc = await bufferSample(f, bufferReport(5000, 340, 34, 105, 10.4), 1000);
  assert.equal(rtc.jitterBufferMs, 50); assert.equal(rtc.jitterBufferTargetMs, 50); assertNear(rtc.jitterBufferMinimumMs, 20);
  assert.equal(rtc.bufferMode, "automatic"); assert.equal(f.peers.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.media.ready(), true);
});

test("late old-peer buffer statistics cannot populate the replacement receiver cache", async () => {
  const f = fixture(); await f.connected(); f.frame(); f.media.stats(false); const oldQuery = f.statsQueries[0];
  f.media.stop(); const pending = f.media.start("viewer-2", "obs-webrtc", 5); await flush();
  f.requests.at(-1).resolve(f.response("/api/soundspectrum/webrtc?sessionId=next-owned-session")); await pending;
  f.peers[1].ontrack({ track: { kind: "video" } }); await flush(); f.frame(); f.media.stats(false); const newQuery = f.statsQueries[1];
  oldQuery.resolve(bufferReport(9000, 999, 999, 999, 999)); await flush(); f.advance(2000);
  let rtc = f.media.stats(false).rtc; assertNoBufferInterval(rtc); assert.equal(rtc.sampleAgeMs, null); assert.equal(f.statsQueries.length, 2);
  newQuery.resolve(bufferReport(1000, 100, 10, 12, 2)); await flush(); rtc = f.media.stats(false).rtc; assertNoBufferInterval(rtc);
  assert.equal(rtc.sampleAgeMs, 2000); assert.equal(rtc.bufferTargetState, "applied"); assert.equal(rtc.requestedBufferMs, 250);
  assert.equal(f.statsQueries.length, 3); f.statsQueries[2].resolve(bufferReport(2000, 160, 13, 27, 3.2)); await flush(); rtc = f.media.stats(false).rtc;
  assert.equal(rtc.jitterBufferMs, 50); assert.equal(rtc.jitterBufferTargetMs, 250);
  assert.equal(f.peers[0].closed, true); assert.equal(f.peers[1].closed, undefined); assert.equal(f.media.ready(), true);
});
