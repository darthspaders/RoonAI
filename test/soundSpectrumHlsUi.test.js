"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), crypto = require("node:crypto");
const source = fs.readFileSync(require.resolve("../public/soundSpectrumHLS.js"), "utf8");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const players = [], frames = new Map(), timers = new Map(), painted = [], events = [], listeners = new Set();
  let id = 0, at = 0, mode = "windowed", geometry = 0, quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
  const video = { hidden: true, videoWidth: 1920, videoHeight: 1080, readyState: 2, currentTime: 0, srcObject: null,
    buffered: { length: 1, start: () => 0, end: () => 2 }, getVideoPlaybackQuality: () => quality,
    play: () => options.play?.() || Promise.resolve(), pause() {}, removeAttribute() {}, load() {},
    requestVideoFrameCallback: fn => { frames.set(++id, fn); return id; }, cancelVideoFrameCallback: key => frames.delete(key),
    getBoundingClientRect: () => { geometry++; return { width: 1200, height: 900 }; } };
  const backdrop = { hidden: true, width: 800, height: 450, getBoundingClientRect: () => { geometry++; return { width: 1600, height: 1000 }; },
    getContext: () => ({ drawImage: (...args) => { if (options.paintThrows) throw Error("Canvas unavailable"); painted.push(args); }, clearRect() {},
      getContextAttributes: () => ({ colorSpace: "srgb", colorType: "unorm8" }), imageSmoothingQuality: "low" }) };
  if (options.raf) { delete video.requestVideoFrameCallback; delete video.cancelVideoFrameCallback; }
  class Hls {
    static Events = Object.fromEntries(["MEDIA_ATTACHED", "MANIFEST_PARSED", "FRAG_LOADING", "FRAG_LOADED", "FRAG_BUFFERED", "BUFFER_CODECS", "ERROR"].map(name => [name, name]));
    static isSupported() { return options.supported !== false; }
    constructor(config) { if (options.constructorThrows) throw Error("Unavailable"); this.config = config; this.events = new Map(); this.latency = 0.8; players.push(this); }
    on(event, fn) { this.events.set(event, fn); }
    emit(event, data = {}) { this.events.get(event)?.(event, data); }
    attachMedia(value) { this.video = value; this.emit("MEDIA_ATTACHED"); }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyed = true; }
  }
  const document = { hidden: false, visibilityState: "visible", addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (name, fn) => listeners.delete(fn) };
  const context = { window: {}, document, Hls: options.missing ? undefined : Hls, location: { href: "http://localhost:3777/" }, URL, URLSearchParams, Request,
    performance: { now: () => at }, devicePixelRatio: 2, matchMedia: () => ({ matches: !!options.touch }),
    getComputedStyle: element => ({ objectFit: element === video ? "contain" : "cover", opacity: "0.8", filter: "none", imageRendering: "auto" }),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: key => timers.delete(key) };
  context.window = context; vm.runInNewContext(source, context);
  const media = context.createSoundSpectrumHLS({ video, backdrop, presentation: () => mode,
    onReady: value => { events.push({ ready: value }); options.onReady?.(value, media); }, onError: (reason, diagnostics) => events.push({ error: true, reason, diagnostics }), onStats: () => options.onStats?.(media) });
  function start() { media.start("viewer-1", "hls", 4); const player = players.at(-1); if (options.manualManifest !== true) player?.emit("MANIFEST_PARSED"); return player; }
  function frame(progress = true, metadata) { const [key, callback] = [...frames][0]; assert.ok(callback); frames.delete(key); if (progress) video.currentTime += 1 / 60; callback(at, metadata); }
  return { media, players, frames, timers, painted, video, backdrop, events, listeners, start, frame, context,
    advance: value => { at += value; }, presentation: value => { mode = value; }, geometry: () => geometry, quality: value => { quality = value; },
    visibility: value => { document.hidden = value === "hidden"; document.visibilityState = value; for (const listener of listeners) listener(); } };
}

test("HLS starts only on request and uses the existing muted video and one decoded backdrop", async () => {
  const f = fixture({ touch: true }); assert.equal(f.players.length, 0); assert.equal(f.frames.size, 0);
  const player = f.start(); assert.equal(player.url, "http://localhost:3777/api/soundspectrum/hls/4/index.m3u8?viewerId=viewer-1");
  assert.equal(player.video, f.video); assert.equal(f.media.ready(), false);
  player.emit("MANIFEST_PARSED"); await flush(); f.frame();
  assert.equal(f.media.ready(), true); assert.equal(f.video.muted, true); assert.equal(f.video.autoplay, false); assert.equal(f.video.playsInline, true);
  assert.equal(f.painted[0][0], f.video); assert.equal(f.backdrop.width, 320); assert.equal(f.backdrop.height, 180);
  f.presentation("visualizer-fullscreen"); f.advance(17); f.frame(); assert.equal(f.backdrop.width, 1920); assert.equal(f.backdrop.height, 1080);
  f.presentation("windowed"); f.advance(17); f.frame(); assert.equal(f.backdrop.width, 320); assert.equal(f.players.length, 1);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 1);
  assert.doesNotMatch(source, /getUserMedia|captureStream|new Audio|createImageBitmap|new WebSocket|visualDelay|pcmDelay/);
});

test("buffer targets use decimal bytes, avoid the default 30-second minimum, and update without restarting", () => {
  const f = fixture(), player = f.start(); assert.equal(player.config.maxBufferSize, 32000000); assert.equal(player.config.backBufferLength, 0);
  assert.equal(player.config.maxBufferLength, 32 * 8 / 600 + 0.4); assert.equal(player.config.lowLatencyMode, false); assert.equal(player.config.enableWorker, true);
  assert.equal(f.media.bufferState().isMemoryCap, false); assert.equal(f.media.bufferState().estimatedSeconds, 32 * 8 / 600);
  for (const invalid of [0, 1001, NaN, Infinity, null, "32", 1.5]) assert.equal(f.media.setBufferTarget(invalid), false);
  for (const mb of [50, 75, 100, 250, 500, 750, 1000]) {
    f.media.setBufferTarget(mb);
    assert.equal(player.config.maxBufferSize, mb * 1000000);
    assert.equal(f.media.bufferState().estimatedSeconds, mb * 8 / 600);
    assert.equal(f.media.stats(false).hls.requestedBufferBytes, mb * 1000000);
    assert.equal(f.players.length, 1);
  }
  f.media.setBufferTarget(1); assert.equal(player.config.maxBufferSize, 1000000); assert.equal(player.config.maxBufferLength, 8 / 600 + 0.4);
  f.media.setBitrateTarget(50); assert.equal(player.config.maxBufferLength, 0.56);
  for (const invalid of [49, 601, "600", null, NaN, 50.5]) assert.equal(f.media.setBitrateTarget(invalid), false);
  assert.equal(f.players.length, 1); assert.equal(f.media.stats(false).hls.requestedBufferBytes, 1000000);
  f.media.stop(); assert.equal(f.media.bufferState().state, "idle"); f.start(); assert.equal(f.players[1].config.maxBufferSize, 1000000);
});

test("startup holds the video until a contiguous playback reserve exists", async () => {
  let plays = 0;
  const f = fixture({ manualManifest: true, play: () => { plays++; return Promise.resolve(); } });
  f.media.setBufferTarget(100); f.media.setBitrateTarget(600);
  let end = 0.2;
  f.video.buffered = { length: 1, start: () => 0, end: () => end };
  const player = f.start(); player.emit("MANIFEST_PARSED"); f.frame(false);
  assert.equal(plays, 0); assert.equal(f.media.ready(), false);
  assert.equal(f.media.stats(false).hls.playbackBufferState, "filling");
  end = 1.2; player.emit("FRAG_BUFFERED"); assert.equal(plays, 0);
  end = 1.4; player.emit("FRAG_BUFFERED"); await flush(); f.frame();
  assert.equal(plays, 1); assert.equal(f.media.ready(), true);
  assert.equal(f.media.stats(false).hls.playbackBufferState, "playing");
  assert.equal(f.timers.size, 0);
});

test("a gap cannot masquerade as a full reserve, even with a long later range", () => {
  let plays = 0;
  const f = fixture({ play: () => { plays++; return Promise.resolve(); } });
  f.video.currentTime = 1;
  f.video.buffered = { length: 2, start: i => i ? 5 : 0, end: i => i ? 15 : 1.1 };
  const player = f.start(); player.emit("FRAG_BUFFERED");
  assert.equal(plays, 0); assert.equal(f.media.ready(), false);
  f.video.currentTime = 5; player.emit("FRAG_BUFFERED"); assert.equal(plays, 1);
});

test("empty playback refills once; decode waiting with buffered video does not pause it", () => {
  let plays = 0;
  const f = fixture({ play: () => { plays++; return Promise.resolve(); } });
  const player = f.start(); f.frame(); assert.equal(plays, 1);
  f.video.onwaiting(); assert.equal(f.media.ready(), true);
  f.video.buffered = { length: 0 }; f.video.onwaiting(); f.video.onwaiting();
  assert.equal(f.media.ready(), true); assert.equal(plays, 1);
  assert.equal(f.media.stats(false).hls.playbackBufferState, "filling");
  f.video.buffered = { length: 1, start: () => 0, end: () => 2 };
  player.emit("FRAG_BUFFERED"); f.frame(); assert.equal(plays, 2);
  assert.equal(f.media.ready(), true); assert.equal(f.timers.size, 0);
});

test("increasing the live reserve waits; lowering it releases without recreating the player", () => {
  let plays = 0;
  const f = fixture({ play: () => { plays++; return Promise.resolve(); } });
  const player = f.start(); f.frame();
  f.video.buffered = { length: 1, start: () => 0, end: () => 1 };
  f.media.setBufferTarget(100); assert.equal(f.media.ready(), true);
  assert.equal(plays, 1); assert.equal(f.media.stats(false).hls.playbackBufferState, "filling");
  f.media.setBufferTarget(32); assert.equal(plays, 2);
  assert.equal(f.players.length, 1); assert.equal(player.destroyed, undefined);
  assert.equal(player.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(player.config.liveMaxLatencyDuration, Infinity);
});

test("stop fences an outstanding fill timer, events and rejected play promise", async () => {
  let reject, plays = 0;
  const f = fixture({ play: () => { plays++; return new Promise((_, r) => { reject = r; }); } });
  f.video.buffered = { length: 0 }; const player = f.start();
  const staleTimers = [...f.timers.values()].map(t => t.fn);
  f.media.stop(); for (const fn of staleTimers) fn(); player.emit("FRAG_BUFFERED");
  assert.equal(plays, 0); assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
  f.video.buffered = { length: 1, start: () => 0, end: () => 2 }; f.start();
  const oldReject = reject; f.media.stop(); f.start(); oldReject(Error("retired")); await flush();
  assert.equal(f.events.some(e => e.error), false); assert.equal(f.players.at(-1).destroyed, undefined);
});

test("largest low-bitrate reserve can fill for sixteen seconds but still has a finite deadline", () => {
  const f = fixture(); f.media.setBufferTarget(100); f.media.setBitrateTarget(50);
  f.video.buffered = { length: 0 }; f.start();
  const timeout = [...f.timers.values()].find(t => t.ms > 20000);
  assert.equal(timeout.ms, 42000); f.advance(17000);
  assert.equal(f.media.stats(false).hls.reserveTargetSeconds, 16);
  timeout.fn(); assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
  assert.equal(f.events.filter(e => e.error).length, 1);
});

test("the installed hls.js accepts the reserve configuration without conflicting latency controls", () => {
  const f = fixture(), player = f.start();
  const RealHls = require("../public/vendor/hls-1.7.3.min.js");
  const real = new RealHls(player.config);
  assert.equal(real.config.lowLatencyMode, false);
  assert.equal(real.config.liveSyncDuration, 32 * 8 / 600 + 0.4);
  real.destroy();
});

test("every playlist and fragment request remains on the authorized generation and origin", () => {
  const f = fixture(), player = f.start(), requests = [];
  const xhr = { open: (...args) => requests.push(args) };
  player.config.xhrSetup(xhr, "/api/soundspectrum/hls/4/segment-1.ts");
  assert.deepEqual(requests[0], ["GET", "http://localhost:3777/api/soundspectrum/hls/4/segment-1.ts?viewerId=viewer-1", true]);
  const request = player.config.fetchSetup({ url: "/api/soundspectrum/hls/4/child.m3u8?viewerId=viewer-1" }, { method: "GET" });
  assert.equal(request.credentials, "same-origin"); assert.equal(new URL(request.url).searchParams.getAll("viewerId").length, 1);
  for (const url of ["https://other.example/segment.ts", "/api/soundspectrum/hls/5/segment.ts", "/api/soundspectrum/hls/40/segment.ts",
    "/api/soundspectrum/hls/4/../segment.ts", "/api/soundspectrum/hls/4/segment.ts?viewerId=other", "http://user:pass@localhost:3777/api/soundspectrum/hls/4/a.ts"]) {
    assert.throws(() => player.config.xhrSetup(xhr, url), /HLS resource unavailable/);
    assert.throws(() => player.config.fetchSetup({ url }, {}), /HLS resource unavailable/);
  }
  assert.equal(requests.length, 1); f.media.stop();
  assert.throws(() => player.config.xhrSetup(xhr, player.url), /retired/);
});

test("Stop and replacement Start fence stale frames, HLS events, playback promises and startup timers", async () => {
  let reject; const f = fixture({ play: () => new Promise((_yes, no) => { reject = no; }) }), first = f.start();
  first.emit("MANIFEST_PARSED"); const staleFrame = [...f.frames.values()][0], staleLoaded = f.video.onloadeddata, staleTimeout = [...f.timers.values()][0].fn;
  const staleError = f.video.onerror; f.frame(); f.media.stop();
  assert.equal(first.destroyed, true); assert.equal(f.media.ready(), false); assert.equal(f.video.hidden, true); assert.equal(f.backdrop.hidden, true);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
  f.media.start("viewer-2", "hls", 5); const second = f.players[1]; staleFrame(1000); staleLoaded(); staleError(); staleTimeout(); reject(Error("old play failed"));
  first.emit("ERROR", { fatal: true, url: "private" }); first.emit("FRAG_LOADED", { frag: { stats: { loaded: 900 } } }); first.emit("MEDIA_ATTACHED"); await flush();
  assert.equal(second.destroyed, undefined); assert.equal(f.events.filter(value => value.error).length, 0);
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1); assert.equal(f.listeners.size, 1);
  assert.equal(f.media.stats().fidelity.generation, 5); assert.equal(f.media.stats(false).hls.loadedBytes, 0);
});

test("unsupported library, invalid inputs and constructor errors fail without a second transport", () => {
  for (const options of [{ missing: true }, { supported: false }, { constructorThrows: true }]) {
    const f = fixture(options); f.start(); assert.equal(f.media.ready(), false); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.events.filter(value => value.error).length, 1);
  }
  for (const args of [["viewer", "jpeg", 4], ["viewer", "hls", 0], ["viewer", "hls", "4"], ["bad&viewer", "hls", 4]]) {
    const f = fixture(); f.media.start(...args); assert.equal(f.players.length, 0); assert.equal(f.events.at(-1).error, true);
  }
});

test("recoverable HLS errors preserve playback; fatal errors and startup deadline retire once", () => {
  const f = fixture(), player = f.start(); player.emit("ERROR", { fatal: false }); assert.equal(player.destroyed, undefined);
  player.emit("ERROR", { fatal: true, details: "private URL" }); player.emit("ERROR", { fatal: true });
  assert.equal(player.destroyed, true); assert.equal(f.events.filter(value => value.error).length, 1); assert.equal(f.frames.size, 0);
  const next = f.start(), timer = [...f.timers.values()][0]; assert.equal(timer.ms, 20000); timer.fn();
  assert.equal(next.destroyed, true); assert.equal(f.timers.size, 0); assert.equal(f.players.length, 2);
});

test("loaded hidden video clears its startup timer without waiting for presentation", () => {
  const f = fixture(); f.start(); f.visibility("hidden"); f.video.onloadeddata();
  assert.equal(f.media.ready(), true); assert.equal(f.timers.size, 0); assert.equal(f.painted.length, 0); assert.equal(f.frames.size, 1);
});

test("segment and playback measurements stay separate from decode counts and cheap stats avoid geometry", () => {
  const f = fixture(); f.quality({ totalVideoFrames: 100, droppedVideoFrames: 2 }); const player = f.start();
  player.emit("FRAG_LOADING"); f.advance(1000); player.emit("FRAG_LOADED", { frag: { stats: { loaded: 1000000 } } });
  player.emit("BUFFER_CODECS", { tracks: { video: { codec: "avc1.64003e", metadata: { width: 1920, height: 1080 } } } });
  f.quality({ totalVideoFrames: 160, droppedVideoFrames: 5 }); f.frame();
  const cheap = f.media.stats(false); assert.equal(f.geometry(), 0); assert.equal(cheap.hls.payloadMbps, 8); assert.equal(cheap.hls.loadedSegments, 1);
  assert.equal(cheap.hls.totalFrames, 60); assert.equal(cheap.hls.droppedFrames, 3); assert.equal(cheap.decodedFrames, null);
  assert.ok(cheap.hls.bufferedSeconds > 1.9); assert.equal(cheap.hls.latencySeconds, 0.8);
  const fidelity = f.media.stats().fidelity; assert.equal(fidelity.codec, "avc1.64003e"); assert.equal(fidelity.format, "HLS");
  assert.equal(fidelity.decodedResolution.width, 1920); assert.equal(fidelity.transmittedResolution.height, 1080);
  assert.equal(fidelity.displayedImageCssResolution.height, 675); assert.equal(fidelity.foregroundCanvasResolution, null);
  assert.match(fidelity.bitrateScope, /segment\/part payload/); assert.equal(f.geometry(), 2);
  f.media.stop(); assert.equal(f.media.stats(false).hls.droppedFrames, null); assert.equal(f.media.stats().fidelity.codec, null);
});

test("compositor counters measure 60 video fps when only 30 callbacks arrive and leave lease progress unchanged", () => {
  const f = fixture(); f.start(); f.frame(true, { presentedFrames: 0, presentationTime: 0 });
  assert.equal(f.media.stats(false).displayedFps, null);
  for (let index = 0; index < 30; index++) {
    f.advance(index % 3 === 2 ? 34 : 33); f.frame(true, { presentedFrames: (index + 1) * 2 });
  }
  const stats = f.media.stats(false);
  assert.equal(stats.frames, 31); assert.equal(stats.callbackFps, 30); assert.equal(stats.hls.callbackFps, 30);
  assert.equal(stats.displayedFps, 60); assert.equal(stats.hls.presentedFps, 60);
  assert.equal(stats.hls.presentationIntervalSeconds, 1); assert.equal(stats.hls.presentationSampleAgeMs, 0);
  assert.equal(stats.lastPaintGapMs, 34); assert.equal(stats.backgroundFrames, 31); assert.equal(f.geometry(), 0);
  f.advance(17); f.frame(true, { presentedFrames: 61 });
  const later = f.media.stats(false); assert.equal(later.displayedFps, 60); assert.equal(later.hls.presentationIntervalSeconds, 1);
  assert.equal(later.hls.presentationSampleAgeMs, 17); assert.equal(later.callbackFps, 30);
});

test("presentation timestamps distinguish callback delay and missing metadata never claims measured video fps", () => {
  const f = fixture(); f.start(); f.frame(true, { presentedFrames: 1, presentationTime: 0 });
  f.advance(1100); f.frame(true, { presentedFrames: 61, presentationTime: 1000 });
  assert.equal(f.media.stats(false).displayedFps, 60);
  assert.equal(f.media.stats(false).callbackFps, 1 / 1.1);
  f.advance(100); f.frame(); assert.equal(f.media.stats(false).displayedFps, null);
  assert.equal(f.media.stats(false).hls.presentationIntervalSeconds, null);
  for (const options of [{}, { raf: true }]) {
    const fallback = fixture(options); fallback.start(); fallback.frame(); fallback.advance(1000); fallback.frame();
    const stats = fallback.media.stats(false); assert.equal(stats.displayedFps, null); assert.equal(stats.hls.presentedFps, null);
    assert.equal(stats.callbackFps, 1); assert.equal(stats.hls.presentationSampleAgeMs, null);
  }
});

test("playback-quality intervals use total and dropped deltas, remain stable between samples and retain cumulative counts", () => {
  const f = fixture(); f.start(); f.quality({ totalVideoFrames: 100, droppedVideoFrames: 2 });
  assert.equal(f.media.stats(false).hls.playbackTotalFps, null);
  f.advance(1000); f.quality({ totalVideoFrames: 160, droppedVideoFrames: 8 });
  const stats = f.media.stats(false);
  assert.equal(stats.hls.playbackTotalFps, 60); assert.equal(stats.hls.playbackDroppedFps, 6);
  assert.equal(stats.hls.playbackDisplayedFps, 54); assert.equal(stats.hls.dropPercent, 10);
  assert.equal(stats.hls.playbackIntervalSeconds, 1); assert.equal(stats.hls.playbackSampleAgeMs, 0);
  assert.equal(stats.hls.totalFrames, 160); assert.equal(stats.hls.droppedFrames, 8); assert.equal(stats.hls.displayedFrames, 152);
  assert.equal(stats.displayedFps, null); assert.equal(f.geometry(), 0);
  f.advance(250); f.quality({ totalVideoFrames: 170, droppedVideoFrames: 8 });
  for (let index = 0; index < 4; index++) {
    const stable = f.media.stats(false).hls;
    assert.equal(stable.playbackTotalFps, 60); assert.equal(stable.playbackDroppedFps, 6); assert.equal(stable.dropPercent, 10);
    assert.equal(stable.playbackSampleAgeMs, 250); assert.equal(stable.playbackIntervalSeconds, 1);
  }
  f.advance(750); f.quality({ totalVideoFrames: 220, droppedVideoFrames: 8 });
  const clean = f.media.stats(false).hls; assert.equal(clean.playbackDisplayedFps, 60); assert.equal(clean.dropPercent, 0);
  assert.equal(clean.droppedFrames, 8); assert.equal(clean.playbackDroppedFps, 0);
  f.advance(1000); const stalled = f.media.stats(false).hls;
  assert.equal(stalled.playbackTotalFps, 0); assert.equal(stalled.playbackDisplayedFps, 0); assert.equal(stalled.playbackDroppedFps, 0);
  assert.equal(stalled.dropPercent, null); assert.equal(stalled.playbackSampleAgeMs, 0);
});

test("rate windows reset on visibility changes, reject counter regressions and expire stale presentation samples", () => {
  const f = fixture(); f.start();
  const sample = (presented, total, dropped = 0) => {
    f.quality({ totalVideoFrames: total, droppedVideoFrames: dropped }); f.frame(true, { presentedFrames: presented }); return f.media.stats(false);
  };
  sample(100, 100); f.advance(1000); assert.equal(sample(160, 160).displayedFps, 60);
  f.advance(3001); const stale = f.media.stats(false);
  assert.equal(stale.displayedFps, null); assert.equal(stale.callbackFps, null); assert.equal(stale.hls.presentationSampleAgeMs, 3001);
  f.visibility("hidden"); f.advance(10000);
  const hidden = sample(900, 900); assert.equal(hidden.displayedFps, null); assert.equal(hidden.hls.playbackTotalFps, null);
  assert.equal(hidden.hls.presentationSampleAgeMs, null); assert.equal(hidden.hls.playbackSampleAgeMs, null);
  f.visibility("visible"); assert.equal(f.media.stats(false).hls.playbackTotalFps, null);
  assert.equal(sample(1000, 1000).displayedFps, null); f.advance(1000); assert.equal(sample(1060, 1060).displayedFps, 60);
  f.advance(200); const regressed = sample(1, 1);
  assert.equal(regressed.displayedFps, null); assert.equal(regressed.hls.playbackTotalFps, null);
  assert.equal(regressed.hls.presentationIntervalSeconds, null); assert.equal(regressed.hls.playbackIntervalSeconds, null);
  f.advance(1000); const restored = sample(61, 61);
  assert.equal(restored.displayedFps, 60); assert.equal(restored.hls.playbackDisplayedFps, 60);
});

test("invalid counters cannot produce NaN, negative, excessive or invented frame rates", () => {
  for (const invalid of [undefined, null, NaN, Infinity, -1, 1.5, "60"]) {
    const f = fixture(); f.start(); f.frame(true, { presentedFrames: 0 }); f.media.stats(false);
    f.advance(1000); f.frame(true, { presentedFrames: invalid }); f.quality({ totalVideoFrames: invalid, droppedVideoFrames: 0 });
    const stats = f.media.stats(false); assert.equal(stats.displayedFps, null); assert.equal(stats.hls.playbackTotalFps, null);
  }
  const f = fixture(); f.start(); f.frame(true, { presentedFrames: 0 }); f.media.stats(false);
  f.advance(1000); f.frame(true, { presentedFrames: 1000 }); f.quality({ totalVideoFrames: 1000, droppedVideoFrames: 0 });
  assert.equal(f.media.stats(false).displayedFps, null); assert.equal(f.media.stats(false).hls.playbackTotalFps, null);
  f.advance(1000); f.frame(true, { presentedFrames: 1060 }); f.quality({ totalVideoFrames: 1060, droppedVideoFrames: 0 });
  assert.equal(f.media.stats(false).displayedFps, 60); assert.equal(f.media.stats(false).hls.playbackTotalFps, 60);
  f.advance(100); f.quality({ totalVideoFrames: 1061, droppedVideoFrames: 5 });
  assert.equal(f.media.stats(false).hls.playbackDisplayedFps, null);
  f.advance(100); f.quality({ totalVideoFrames: 10, droppedVideoFrames: 11 });
  assert.equal(f.media.stats(false).hls.playbackTotalFps, null); assert.equal(f.media.stats(false).hls.displayedFrames, null);
});

test("replacement Start clears interval baselines and stale callbacks cannot populate the new viewer's rates", () => {
  const f = fixture(); f.start(); f.frame(true, { presentedFrames: 100 }); f.media.stats(false);
  f.advance(1000); f.frame(true, { presentedFrames: 160 }); f.quality({ totalVideoFrames: 60, droppedVideoFrames: 0 });
  assert.equal(f.media.stats(false).displayedFps, 60);
  const stale = [...f.frames.values()][0]; f.media.stop();
  for (const key of ["presentedFps", "callbackFps", "playbackTotalFps", "playbackDroppedFps", "playbackDisplayedFps", "dropPercent"]) assert.equal(f.media.stats(false).hls[key], null);
  f.start(); stale(2000, { presentedFrames: 220 });
  assert.equal(f.media.stats(false).displayedFps, null); assert.equal(f.media.stats(false).frames, 0);
  assert.equal(f.media.stats(false).hls.totalFrames, 0); assert.equal(f.frames.size, 1);
  f.frame(true, { presentedFrames: 1 }); f.advance(1000); f.frame(true, { presentedFrames: 61 });
  assert.equal(f.media.stats(false).displayedFps, 60);
});

test("RAF stalls remain visible, hidden time is excluded, and backdrop failure cannot stop video", () => {
  const f = fixture({ raf: true, paintThrows: true }); f.start(); f.frame();
  for (let i = 0; i < 10; i++) { f.advance(100); f.frame(false); }
  assert.equal(f.media.stats(false).frames, 1); assert.equal(f.media.stats(false).maxPaintGapMs, 1000); assert.equal(f.media.ready(), true);
  f.visibility("hidden"); f.advance(20000); assert.equal(f.media.stats(false).lastPaintGapMs, null);
  f.visibility("visible"); f.advance(1000); assert.equal(f.media.stats(false).lastPaintGapMs, null);
  f.frame(); f.advance(17); f.frame(); assert.equal(f.media.stats(false).maxPaintGapMs, 1000);
});

test("a Stop triggered by readiness cannot leave a frame loop behind", () => {
  const f = fixture({ onReady: (ready, media) => { if (ready) media.stop(); } }); f.start(); f.frame();
  assert.equal(f.media.ready(), false); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

test("short-part diagnostics count part bytes once and throttle notifications to one per second", () => {
  let notifications = 0; const f = fixture({ onStats: () => { notifications++; } }), player = f.start();
  notifications = 0; f.advance(1000); player.emit("FRAG_LOADING");
  for (let i = 0; i < 10; i++) {
    player.emit("FRAG_LOADED", { part: { stats: { loaded: 1000 } }, frag: { stats: { loaded: 1000 * (i + 1) } } }); f.advance(100);
  }
  assert.equal(notifications, 1); assert.equal(f.media.stats(false).hls.loadedParts, 10);
  assert.equal(f.media.stats(false).hls.loadedBytes, 10000); assert.equal(f.media.stats(false).hls.loadedSegments, 0);
  player.emit("BUFFER_CODECS", { video: { codec: "avc1.64003e" } }); assert.equal(notifications, 2);
  f.media.setBufferTarget(16); assert.equal(notifications, 3);
});

test("local hls.js distribution matches the pinned official package and includes its license", () => {
  const bytes = fs.readFileSync(require.resolve("../public/vendor/hls-1.7.3.min.js"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e");
  const Hls = require("../public/vendor/hls-1.7.3.min.js"); assert.equal(Hls.version, "1.7.3");
  assert.match(fs.readFileSync(require.resolve("../public/vendor/hls-1.7.3.LICENSE.txt"), "utf8"), /Apache License, Version 2\.0/);
});


test("1 GB at 50 Mbps fills for 160 seconds and resizing an active fill renews its deadline", () => {
  let plays = 0;
  const f = fixture({ play: () => { plays++; return Promise.resolve(); } });
  f.media.setBitrateTarget(50); f.video.buffered = { length: 0 }; const player = f.start();
  f.media.setBufferTarget(1000);
  assert.equal(player.config.maxBufferSize, 1000000000);
  assert.equal(player.config.maxBufferLength, 160.4);
  assert.equal(player.config.maxMaxBufferLength, 160.4);
  assert.equal([...f.timers.values()].filter(t => t.ms > 100).length, 1);
  assert.equal([...f.timers.values()].find(t => t.ms > 100).ms, 330000);
  const RealHls = require("../public/vendor/hls-1.7.3.min.js"), real = new RealHls(player.config); real.destroy();
  let end = 159.9; f.video.buffered = { length: 1, start: () => 0, end: () => end };
  f.advance(160000); player.emit("FRAG_BUFFERED"); assert.equal(plays, 0);
  end = 160.1; player.emit("FRAG_BUFFERED"); f.frame(); assert.equal(plays, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.media.ready(), true);
});

test("browser quota rejection during fill fails clearly and stale errors cannot stop a replacement", () => {
  const f = fixture(); f.media.setBufferTarget(1000); const player = f.start();
  player.emit("ERROR", { fatal: false, details: "bufferFullError" });
  assert.equal(f.events.at(-1).reason, "buffer-limit"); assert.equal(f.timers.size, 0);
  f.media.setBufferTarget(32); const replacement = f.start(); f.frame();
  player.emit("ERROR", { fatal: false, details: "bufferFullError" });
  assert.equal(f.media.ready(), true); assert.equal(replacement.destroyed, undefined);
});


test("HLS failure retains the final bounded playback observations before stop clears the receiver", () => {
  const f = fixture(); f.media.setBufferTarget(250); f.video.paused = true;
  const player = f.start(); player.emit("FRAG_LOADED", { payload: { byteLength: 12000000 } });
  player.emit("ERROR", { details: "bufferFullError", fatal: false });
  const report = f.events.at(-1).diagnostics;
  assert.equal(report.hlsRequestedMB, 250); assert.equal(report.hlsBufferSeconds, 2);
  assert.equal(report.hlsLoadedBytes, 12000000); assert.equal(report.hlsLastError, "quota");
  assert.equal(report.hlsBufferState, "filling"); assert.equal(report.hlsPaused, true);
  assert.equal(f.media.stats(false).transport, "idle");
});
