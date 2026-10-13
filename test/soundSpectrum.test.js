"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { SoundSpectrum, JpegFrames, createSoundSpectrumApi } = require("../src/soundSpectrum");
const { createFeedMux } = require("../src/soundSpectrumFeeds");
const { buildCaptureCommand } = require("../scripts/soundspectrum-capture.cjs");
const { PROFILES: OBS_PROVIDER_PROFILES } = require("../integrations/soundspectrum-obs-webrtc/index.cjs");
const A = "viewer_A_12345678901234567890", B = "viewer_B_12345678901234567890";
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const MUSIC = "feed:pre-hqplayer", PLAYER = "aa:bb:cc:dd:ee:ff";
const HQP_MUSIC = "feed:hqplayer-analysis", HQP_ZONE = "1601d935088f5a8521851f0b72f30228de66";

test("WhiteCap theme is validated, forwarded, reflected and included in shared-session identity", async t => {
  const f = fixture({ native: { inspect: async () => ({ visualizers: [{ id: "whitecap", available: true }], inputs: [{ id: "mic", name: "PC microphone" }],
    whitecapThemes: [{ id: "current", available: true }, { id: "nasa-layers", available: true }] }) } });
  t.after(() => f.service.close());
  const start = { action: "start", viewerId: A, visualizer: "whitecap", inputId: "mic", whitecapTheme: "nasa-layers" };
  await f.service.session(start); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  assert.equal(f.starts[0].whitecapTheme, "nasa-layers");
  assert.equal(f.service.snapshot(A).whitecapTheme, "nasa-layers");
  await assert.rejects(f.service.session({ ...start, action: "join", viewerId: B, whitecapTheme: "current", generation: f.service.generation }), /selection changed/);
  await assert.rejects(f.service.session({ ...start, viewerId: B, whitecapTheme: "current" }), /Stop the active visuals/);
  assert.equal(f.starts.length, 1);
  await f.service.session({ ...start, action: "join", viewerId: B, generation: f.service.generation });
  assert.equal(f.service.snapshot(B).viewerActive, true); assert.equal(f.starts.length, 1);
});

test("unavailable NASA collection cannot silently start the ordinary WhiteCap rotation", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "whitecap", inputId: "mic", whitecapTheme: "nasa-layers" }), /NASA layer collection is unavailable/);
  assert.equal(f.starts.length, 0); assert.equal(f.service.leases.size, 0);
});
function dualFeedFixture(options = {}) {
  const calls = [], failures = new Map();
  const entries = [MUSIC, HQP_MUSIC].map(id => {
    const overrides = id === HQP_MUSIC ? options.hqp || {} : options.lyrion || {};
    return { id, integration: {
      audioFeed: {
        inspect: async () => ({ id, kind: "music-feed", source: "untrusted-adapter-label", available: overrides.available !== false, reason: overrides.reason || "" }),
        snapshot: () => overrides.snapshot?.() || ({ state: "waiting", id }),
        validateStart: async selection => { calls.push({ action: "validate", id, selection }); if (overrides.validateStart) return overrides.validateStart(selection); if (id === HQP_MUSIC && selection.zoneId !== HQP_ZONE) throw Error("Configured HQPlayer zone changed"); },
        start: async selection => { calls.push({ action: "start", id, selection }); failures.set(id, selection.onFailure); await overrides.start?.(selection); },
        stop: async () => { calls.push({ action: "stop", id }); await overrides.stop?.(); }
      },
      additionalInputProvider: { list: async () => [{ id, kind: "music-feed" }], resolve: async () => null }
    } };
  });
  const { audioFeed } = createFeedMux(entries);
  const f = fixture({ ...options, audioFeed, native: {
    inspect: async () => ({ visualizers: ["aeon", "g-force", "whitecap"].map(id => ({ id, available: true })), inputs: [{ id: "mic" }], musicInputs: [MUSIC, HQP_MUSIC].map(id => ({ id, kind: "music-feed" })), noMicInputs: { aeon: [{ id: "generator:fluid", kind: "no-mic" }] } }),
    ...options.native
  } });
  return { ...f, calls, failures };
}
function musicFixture(options = {}) {
  const calls = []; let failure;
  const audioFeed = { inspect: async () => ({ id: MUSIC, kind: "music-feed", name: "Music feed (experimental)", available: true }),
    snapshot: () => ({ state: "waiting" }), start: async selected => { calls.push(selected.playerId); failure = selected.onFailure; }, stop: async () => { calls.push("stop"); }, ...options.audioFeed };
  const f = fixture({ ...options, audioFeed, native: {
    inspect: async () => ({ visualizers: ["aeon", "g-force", "whitecap"].map(id => ({ id, available: true })), inputs: [],
      musicInputs: [{ id: MUSIC, kind: "music-feed" }], noMicInputs: { aeon: [{ id: "generator:fluid", kind: "no-mic" }] } }), ...options.native } });
  return { ...f, calls, get failure() { return failure; } };
}
function fixture(options = {}) {
  const starts = [], children = []; let stops = 0, now = 1000;
  const native = { inspect: async () => ({ state: "stopped", visualizers: ["aeon", "g-force", "whitecap"].map(id => ({ id, name: id, available: true })), inputs: [{ id: "mic", name: "PC microphone" }] }),
    start: async selected => { starts.push(selected); return { windowHandle: "1234", pid: 123 }; }, stop: async () => { stops++; }, ...options.native };
  const capture = { probeCaptureRuntime: async () => ({ available: true }), buildCaptureCommand: params => { assert.equal(params.windowHandle, "1234"); return { command: "owned-window-capture", args: ["video-only"] }; }, ...options.capture };
  const service = new SoundSpectrum({ native, capture, clock: () => now, sweepMs: 0, onDiagnostic: () => {}, captureRecoveryDelayMs: 0, spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit("close", 0); }; children.push(child); return child;
  }, ...options, native, capture });
  return { service, starts, children, get stops() { return stops; }, advance: ms => { now += ms; } };
}

function fidelityJpeg({ width = 800, height = 450, depth = 8, factors = [0x22, 0x11, 0x11], marker = 0xc0 } = {}) {
  const segment = Buffer.alloc(10 + 3 * factors.length);
  segment[0] = 0xff; segment[1] = marker; segment.writeUInt16BE(8 + 3 * factors.length, 2);
  segment[4] = depth; segment.writeUInt16BE(height, 5); segment.writeUInt16BE(width, 7); segment[9] = factors.length;
  factors.forEach((factor, index) => { segment[10 + 3 * index] = index + 1; segment[11 + 3 * index] = factor; });
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, Buffer.from([0xff, 0xd9])]);
}
async function startFidelityFixture(t, options = {}) {
  const f = fixture({ ...options, native: { start: async () => ({ windowHandle: "1234", pid: 123, width: 800, height: 450 }), ...options.native } });
  t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(fidelityJpeg());
  return f;
}
const VIDEO_SDP = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n";
const RTC_RESOURCE = "resource_12345678901234567890";
function obsFixture(options = {}) {
  const calls = [], nativeStarts = []; let selected;
  const obsTransport = { inspect: async () => ({ available: true }),
    start: async params => { selected = params; calls.push("obs-start"); params.onReady(); },
    stop: async () => { calls.push("obs-stop"); }, releaseViewer: async params => { calls.push({ releaseViewer: params }); },
    signal: async params => { calls.push({ signal: params }); return params.method === "POST" ? { status: 201, sessionId: RTC_RESOURCE, body: VIDEO_SDP } : { status: 204, body: "" }; },
    ...options.obsTransport };
  const f = fixture({ ...options, obsTransport, native: {
    start: async params => { nativeStarts.push(params); calls.push("native-start"); return { pid: 123, windowHandle: "1234", width: params.width || 800, height: params.height || 450 }; },
    captureWindow: async () => ({ pid: 123, windowHandle: "1234", width: 1920, height: 1080 }),
    stop: async () => { calls.push("native-stop"); }, ...options.native
  } });
  return { ...f, calls, nativeStarts, get selected() { return selected; } };
}
async function startOBSFixture(t, options = {}) {
  const f = obsFixture(options); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic", transport: "obs-webrtc" });
  await f.service.serial; return f;
}

test("SRT joins the selected WhiteCap theme without replacing its renderer", async t => {
  const f = obsFixture({ native: { inspect: async () => ({ visualizers: [{ id: "whitecap", available: true }], inputs: [{ id: "mic", name: "PC microphone" }], whitecapThemes: [{ id: "nasa-layers", available: true }] }) },
    obsTransport: { inspect: async () => ({ available: true, srtExperiment: { available: true } }),
      srtConnection: async request => ({ url: "srt://192.168.1.2:8890?private", generation: request.generation, requestedLatencyMs: 250,
        videoProfile: { requestedBitrateMbps: 60, configuredBitrateMbps: 60, encoderMode: "shared-publisher", width: 1920, height: 1080, fps: 60 } }), releaseSrt: async () => {} } });
  t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "whitecap", inputId: "mic", transport: "obs-webrtc", whitecapTheme: "nasa-layers" }); await f.service.serial;
  await f.service.srtExperiment.start({ viewerId: "theme_srt_controller_123456789012345", generation: f.service.generation });
  assert.equal(f.service.whitecapTheme, "nasa-layers"); assert.equal(f.nativeStarts.length, 1);
});

test("native SRT lease keeps the exact publisher after browser Stop and expires without heartbeats", async t => {
  const SRT = "srt_controller_12345678901234567890", calls = [];
  const f = await startOBSFixture(t, {obsTransport: {
    inspect:async()=>({available:true,srtExperiment:{available:true}}),
    srtConnection:async request=>({url:"srt://192.168.1.2:8890?private",generation:request.generation,requestedLatencyMs:250,
      videoProfile:{requestedBitrateMbps:60,configuredBitrateMbps:60,encoderMode:"shared-publisher",width:1920,height:1080,fps:60}}),
    releaseSrt:async request=>calls.push(request)
  }});
  const generation = f.service.generation;
  await f.service.srtExperiment.start({viewerId:SRT,generation});
  await f.service.session({action:"stop",viewerId:A}); await f.service.serial;
  assert.equal(f.service.state,"running"); assert.equal(f.service.generation,generation);
  assert.equal(f.service.leases.size,1); assert.equal(f.calls.filter(value=>value==="obs-start").length,1); assert.equal(f.nativeStarts.length,1);
  f.advance(599999); f.service.sweep(); await f.service.serial; assert.equal(f.service.state,"running");
  f.advance(1); f.service.sweep(); await new Promise(resolve=>setImmediate(resolve)); await f.service.serial;
  assert.equal(f.service.state,"idle"); assert.equal(f.service.leases.size,0); assert.deepEqual(calls,[{viewerId:SRT,generation}]);
  assert.equal(f.calls.filter(value=>value==="obs-start").length,1); assert.equal(f.service.srtExperiment.status(SRT).state,"expired");
});

test("independent600 native demand survives browser Stop beyond peer and browser lease timeouts with one exact HQPlayer source", async t => {
  for (const ending of ["stop", "expiry"]) {
    const SRT = "independent_srt_native_12345678901234567890", srtCalls = [], audioCalls = [];
    const profile = { requestedBitrateMbps: 600, configuredBitrateMbps: 599.999488, encoderMode: "independent-srt", width: 3840, height: 2160, fps: 60 };
    let independentActive = false;
    const f = obsFixture({ audioFeed: {
      inspect: async () => ({ id: HQP_MUSIC, kind: "music-feed", available: true }), snapshot: () => ({ state: "receiving", source: "roon-hqplayer", zoneId: HQP_ZONE }),
      validateStart: async selection => { assert.equal(selection.zoneId, HQP_ZONE); assert.equal(selection.playerId, undefined); },
      start: async selection => { audioCalls.push({ action: "start", inputId: selection.inputId, zoneId: selection.zoneId }); }, stop: async () => audioCalls.push({ action: "stop" })
    }, native: {
      inspect: async () => ({ visualizers: [{ id: "whitecap", available: true }], inputs: [], musicInputs: [{ id: HQP_MUSIC, kind: "music-feed", available: true }] }),
      status: () => ({ state: "running", pid: 123, owned: true }),
      captureWindow: async () => ({ pid: 123, windowHandle: "1234", width: 3840, height: 2160 })
    }, obsTransport: {
      inspect: async () => ({ available: true, profile: { ...OBS_PROVIDER_PROFILES["4k60-60"] }, srtExperiment: { available: true, videoTargetsMbps: [60, 600] } }),
      srtConnection: async request => { srtCalls.push({ action: "start", ...request }); independentActive = true;
        return { url: "srt://192.168.1.2:8891?private", generation: request.generation, requestedLatencyMs: 250, videoProfile: profile }; },
      releaseSrt: async request => { srtCalls.push({ action: "stop", ...request }); independentActive = false; },
      snapshot: () => ({ srtExperiment: { state: independentActive ? "ready" : "idle", videoProfile: profile, readers: null, stats: [] } })
    } });
    t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer: "whitecap", inputId: HQP_MUSIC, zoneId: HQP_ZONE, transport: "obs-webrtc" }); await f.service.serial;
    const generation = f.service.generation, obsSession = f.service.obsSession, nativeWindow = f.service.captureWindow;
    const initialAudioStops = audioCalls.filter(call => call.action === "stop").length;
    const receipt = await f.service.srtExperiment.start({ viewerId: SRT, generation, videoBitrateMbps: 600 });
    const originalDeadline = receipt.expiresAt;
    assert.deepEqual(srtCalls, [{ action: "start", viewerId: SRT, generation, videoBitrateMbps: 600, expiresAt: originalDeadline }]);
    await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
    for (const elapsed of [6000, 6001, 78000]) {
      f.advance(elapsed); f.service.sweep(); await new Promise(resolve => setImmediate(resolve)); await f.service.serial;
      assert.equal(f.service.state, "running", ending); assert.equal(f.service.generation, generation);
      assert.equal(f.service.obsSession, obsSession); assert.equal(f.service.captureWindow, nativeWindow); assert.equal(f.selected.isCurrent(), true);
      assert.equal(f.service.leases.size, 1); assert.equal(f.service.leases.get(SRT), originalDeadline); assert.equal(f.service.leases.has(A), false);
      assert.equal(f.service.srtExperiment.status(SRT).state, "ready"); assert.equal(f.service.srtExperiment.status(SRT).expiresAt, originalDeadline);
      assert.equal(f.service.inputId, HQP_MUSIC); assert.equal(f.service.inputSource, "roon-hqplayer"); assert.equal(f.service.zoneId, HQP_ZONE); assert.equal(f.service.playerId, "");
      assert.equal(f.nativeStarts.length, 1); assert.equal(f.calls.filter(value => value === "obs-start").length, 1);
      assert.equal(f.calls.filter(value => value === "obs-stop").length, 0); assert.equal(srtCalls.length, 1);
      assert.equal(audioCalls.filter(call => call.action === "start").length, 1); assert.equal(audioCalls.filter(call => call.action === "stop").length, initialAudioStops);
      assert.equal(f.service.activeOBSProfile.targetBitrateMbps, 60); assert.equal(f.children.length, 0);
    }
    if (ending === "stop") await f.service.srtExperiment.stop({ viewerId: SRT, generation });
    else {
      f.advance(originalDeadline - f.service.clock() - 1); f.service.sweep(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.service.state, "running"); assert.equal(srtCalls.length, 1);
      f.advance(1); f.service.sweep(); await new Promise(resolve => setImmediate(resolve));
    }
    await f.service.serial;
    assert.equal(f.service.state, "idle"); assert.equal(f.service.leases.size, 0); assert.equal(independentActive, false);
    assert.deepEqual(srtCalls[1], { action: "stop", viewerId: SRT, generation });
    assert.equal(f.service.srtExperiment.status(SRT).state, ending === "stop" ? "stopped" : "expired");
    assert.equal(f.calls.filter(value => value === "obs-start").length, 1); assert.equal(audioCalls.filter(call => call.action === "start").length, 1);
  }
});

test("shutdown refuses new visual starts while a native SRT reader is closing", async t => {
  const SRT="srt_shutdown_12345678901234567890"; let finish;
  const f=await startOBSFixture(t,{obsTransport:{
    inspect:async()=>({available:true,srtExperiment:{available:true}}),
    srtConnection:async request=>({url:"srt://192.168.1.2:8890?private",generation:request.generation,requestedLatencyMs:250,
      videoProfile:{requestedBitrateMbps:60,configuredBitrateMbps:60,encoderMode:"shared-publisher",width:1920,height:1080,fps:60}}),
    releaseSrt:()=>new Promise(resolve=>{finish=resolve;})
  }});
  await f.service.srtExperiment.start({viewerId:SRT,generation:f.service.generation});
  const closing=f.service.close(); while(!finish) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.service.closed,true);
  await assert.rejects(f.service.session({action:"start",viewerId:B,visualizer:"aeon",inputId:"mic",transport:"obs-webrtc"}),/shutting down/);
  finish(); await closing; assert.equal(f.service.leases.size,0); assert.equal(f.nativeStarts.length,1);
});

test("optional OBS inventory failures leave JPEG available without starting another transport", async t => {
  for (const obsTransport of [null, { inspect: async () => ({ available: false }) }, { inspect: async () => { throw Error("private configuration error"); } }]) {
    const f = fixture({ obsTransport }); t.after(() => f.service.close());
    const value = await f.service.status(); assert.equal(value.transports[0].id, "jpeg"); assert.equal(value.transports[0].available, true);
    assert.equal(value.transports[1].id, "obs-webrtc"); assert.equal(value.transports[1].available, false);
    assert.equal(JSON.stringify(value).includes("private configuration"), false); assert.equal(f.starts.length, 0); assert.equal(f.children.length, 0);
    await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic", transport: "obs-webrtc" }), /unavailable/);
    await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
    assert.equal(f.children.length, 1); assert.equal(f.service.transport, "jpeg");
  }
});

test("OBS starts one full HD G-Force renderer and publisher without a JPEG capture process", async t => {
  const f = await startOBSFixture(t, { capture: { probeCaptureRuntime: async () => ({ available: false }) } });
  assert.equal(f.service.state, "running"); assert.equal(f.children.length, 0); assert.equal(f.nativeStarts.length, 1);
  assert.deepEqual(f.nativeStarts[0], { visualizer: "g-force", inputId: "mic", width: 1920, height: 1080, uniqueCaptureTitle: true });
  assert.equal(f.service.snapshot(A).transport, "obs-webrtc"); assert.equal(f.service.snapshot(A).videoTransport, "obs-webrtc");
  assert.equal(f.service.snapshot(A).videoStats.captureFps, null); assert.equal(f.selected.isCurrent(), true);
  assert.throws(() => f.service.authorizeVideo(A), /OBS/);
  assert.throws(() => f.service.video({}, new Response(), A), /OBS/);
  await assert.rejects(f.service.session({ action: "join", viewerId: B, visualizer: "g-force", inputId: "mic", generation: f.service.generation }), /selection changed/);
  await f.service.session({ action: "join", viewerId: B, visualizer: "g-force", inputId: "mic", transport: "obs-webrtc", generation: f.service.generation });
  assert.equal(f.nativeStarts.length, 1); assert.equal(f.calls.filter(value => value === "obs-start").length, 1);
});

for (const profileId of ["4k60", "4k60-60"]) test(`${profileId} OBS starts the matching fullscreen native surface and keeps active diagnostics pinned`, async t => {
  let profile = { ...OBS_PROVIDER_PROFILES[profileId] }; const bitrate = profile.targetBitrateMbps;
  const f = await startOBSFixture(t, { obsTransport: { inspect: async () => ({ available: true, profile }) },
    native: { captureWindow: async () => ({ pid: 123, windowHandle: "1234", width: 3840, height: 2160 }) } });
  assert.equal(f.service.state, "running"); assert.equal(f.children.length, 0);
  assert.deepEqual(f.nativeStarts[0], { visualizer: "g-force", inputId: "mic", width: 3840, height: 2160, uniqueCaptureTitle: true, windowMode: "borderless-fullscreen" });
  assert.equal(f.selected.expectedProfileId, profileId);
  const stats = f.service.snapshot(A).videoStats;
  assert.equal(stats.width, 3840); assert.equal(stats.height, 2160); assert.equal(stats.configuredBitrateMbps, bitrate); assert.equal(stats.qualityProfile, profileId);
  profile = { id: "1080p60", width: 1920, height: 1080, targetFps: 60, targetBitrateMbps: 25, nativeWindowMode: "windowed" };
  await f.service.inspect(true);
  const fidelity = await f.service.fidelity();
  assert.deepEqual(fidelity.native.clientResolution, { width: 3840, height: 2160 });
  assert.equal(fidelity.native.windowMode, "borderless-fullscreen");
  assert.deepEqual(fidelity.transmission.configuredResolution, { width: 3840, height: 2160 });
  assert.equal(fidelity.transmission.configuredBitrateMbps, bitrate); assert.equal(fidelity.transmission.qualityProfile, profileId);
  assert.equal(fidelity.transmission.resolution, null);
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.snapshot().videoStats.width, 1920);
});

test("main and provider profile descriptors stay parallel including both rollback choices", async t => {
  for (const [id, bitrate] of [["1080p60", 25], ["4k60", 80], ["4k60-60", 60]]) {
    const profile = OBS_PROVIDER_PROFILES[id], f = obsFixture({ obsTransport: { inspect: async () => ({ available: true, profile }) } });
    t.after(() => f.service.close());
    const inventory = await f.service.status(); const descriptor = inventory.transports.find(value => value.id === "obs-webrtc");
    assert.equal(descriptor.available, true); assert.equal(descriptor.profile.id, id); assert.equal(descriptor.profile.targetBitrateMbps, bitrate);
    for (const key of ["id", "width", "height", "targetFps", "targetBitrateMbps", "nativeWindowMode"]) assert.equal(descriptor.profile[key], profile[key], id + "." + key);
    assert.equal(f.nativeStarts.length, 0); assert.equal(f.calls.length, 0, "inspection does not start a renderer or publisher");
  }
});

test("invalid OBS quality profiles cannot disturb a running JPEG renderer", async t => {
  for (const profile of [{ id: "lossless" }, { id: "constructor" }, { id: "toString" }, { id: "__proto__" },
    { id: "4k60", width: 800 }, { id: "4k60", targetBitrateMbps: 1000 },
    { id: "4k60-60", width: 1920 }, { id: "4k60-60", targetBitrateMbps: 80 }]) {
    const f = obsFixture({ obsTransport: { inspect: async () => ({ available: true, profile }) } }); t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
    f.children[0].stdout.write(JPEG); const generation = f.service.generation;
    await assert.rejects(f.service.session({ action: "start", viewerId: B, visualizer: "g-force", inputId: "mic", transport: "obs-webrtc" }), /unavailable/);
    assert.equal(f.service.generation, generation); assert.equal(f.children[0].killed, undefined);
    assert.equal(f.nativeStarts.length, 1); assert.equal(f.calls.includes("obs-start"), false);
  }
});

test("forged transport or unknown product selections cannot disturb a working JPEG viewer", async t => {
  const f = obsFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); const generation = f.service.generation;
  for (const [transport, visualizer] of [["obs-webrtc", "unknown"], ["obs-webrtc", "G-Force"], ["forged", "g-force"]]) {
    await assert.rejects(f.service.session({ action: "start", viewerId: B, transport, visualizer, inputId: "mic" }));
  }
  assert.equal(f.service.generation, generation); assert.equal(f.children[0].killed, undefined); assert.equal(f.nativeStarts.length, 1);
  assert.equal(f.calls.includes("obs-start"), false);
});

for (const profileId of ["4k60", "4k60-60"]) test(`all three visualizers use ${profileId} OBS and exact joins without a JPEG process`, async t => {
  const profile = OBS_PROVIDER_PROFILES[profileId];
  for (const visualizer of ["aeon", "g-force", "whitecap"]) {
    const f = obsFixture({ obsTransport: { inspect: async () => ({ available: true, profile }) } }); t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer, inputId: "mic", transport: "obs-webrtc" }); await f.service.serial;
    assert.equal(f.service.state, "running"); assert.equal(f.children.length, 0);
    assert.deepEqual(f.nativeStarts[0], { visualizer, inputId: "mic", width: 3840, height: 2160, uniqueCaptureTitle: true, windowMode: "borderless-fullscreen" });
    assert.equal(f.selected.expectedProfileId, profileId);
    assert.equal(f.service.snapshot(A).videoStats.qualityProfile, profileId); assert.equal(f.service.snapshot(A).videoStats.configuredBitrateMbps, profile.targetBitrateMbps);
    await f.service.session({ action: "join", viewerId: B, visualizer, inputId: "mic", transport: "obs-webrtc", generation: f.service.generation });
    assert.equal(f.nativeStarts.length, 1); assert.equal(f.calls.filter(value => value === "obs-start").length, 1);
    await assert.rejects(f.service.session({ action: "join", viewerId: B, visualizer: visualizer === "aeon" ? "whitecap" : "aeon", inputId: "mic", transport: "obs-webrtc", generation: f.service.generation }), /selection changed/);
  }
});

test("switching G-Force to Aeon to WhiteCap keeps OBS and releases the previous publisher before opening the next window", async t => {
  const f = obsFixture(); t.after(() => f.service.close());
  for (const visualizer of ["g-force", "aeon", "whitecap"]) {
    const previousStarts = f.nativeStarts.length, previousGeneration = f.service.generation;
    const at = f.calls.length;
    await f.service.session({ action: "start", viewerId: A, visualizer, inputId: "mic", transport: "obs-webrtc" }); await f.service.serial;
    assert.equal(f.service.state, "running"); assert.equal(f.service.transport, "obs-webrtc");
    assert.equal(f.service.visualizer, visualizer); assert.equal(f.service.generation, previousGeneration + 1);
    assert.equal(f.nativeStarts.length, previousStarts + 1); assert.equal(f.children.length, 0);
    const calls = f.calls.slice(at);
    assert.ok(calls.indexOf("obs-stop") < calls.indexOf("native-start"));
    assert.ok(calls.indexOf("native-stop") < calls.indexOf("native-start"));
  }
});

test("OBS publisher closes before native and audio cleanup even when its cleanup fails", async t => {
  for (const fail of [false, true]) {
    const order = [];
    const f = await startOBSFixture(t, { obsTransport: { stop: async () => { order.push("publisher-stop"); if (fail) throw Error("private"); } },
      native: { stop: async () => { order.push("native-stop"); } }, audioFeed: { inspect: async () => null, snapshot: () => ({}), stop: async () => { order.push("audio-stop"); } } });
    order.length = 0;
    await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
    assert.deepEqual(order, ["publisher-stop", "audio-stop", "native-stop"]); assert.equal(f.selected.isCurrent(), false);
    assert.equal(f.service.state, fail ? "error" : "idle");
  }
});

test("Stop during pending OBS startup fences readiness and closes owned resources without JPEG fallback", async t => {
  let selected, finish;
  const f = obsFixture({ obsTransport: { start: params => { selected = params; return new Promise(resolve => { finish = resolve; }); } } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic", transport: "obs-webrtc" });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: A });
  assert.equal(selected.isCurrent(), false); selected.onReady(); finish(); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.children.length, 0); assert.equal(f.calls.filter(value => value === "obs-stop").length, 1);
});

test("OBS expiry and native departure stop the publisher while JPEG frame-age checks are bypassed", async t => {
  let state = "running";
  const f = await startOBSFixture(t, { native: { status: () => ({ state, pid: 123, owned: true }) } });
  f.advance(11000); await f.service.session({ action: "heartbeat", viewerId: A }); f.service.sweep();
  assert.equal(f.service.state, "running"); assert.equal(f.service.frameAt, 0);
  state = "cleanup-needed"; f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /renderer stopped/); assert.equal(f.calls.filter(value => value === "obs-stop").length, 1);
  const expired = await startOBSFixture(t); expired.advance(13000); expired.service.sweep(); await expired.service.serial;
  assert.equal(expired.service.state, "idle"); assert.equal(expired.calls.filter(value => value === "obs-stop").length, 1);
});

test("a late OBS failure cannot stop the replacement JPEG session", async t => {
  const f = await startOBSFixture(t); const old = f.selected;
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic", transport: "jpeg" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); old.onFailure(Error("late private failure"));
  assert.equal(f.service.state, "running"); assert.equal(f.service.transport, "jpeg"); assert.equal(f.children[0].killed, undefined);
  assert.equal(f.nativeStarts.length, 2); assert.deepEqual(f.nativeStarts[1], { visualizer: "g-force", inputId: "mic" });
});

test("late OBS cleanup failure cannot mark a queued replacement JPEG startup as failed", async t => {
  let rejectStop;
  const f = await startOBSFixture(t, { obsTransport: { stop: () => new Promise((_resolve, reject) => { rejectStop = reject; }) } });
  await f.service.session({ action: "stop", viewerId: A });
  while (!rejectStop) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic", transport: "jpeg" });
  rejectStop(Error("old publisher stop failed")); await f.service.serial;
  assert.equal(f.service.transport, "jpeg"); assert.equal(f.service.state, "starting"); assert.equal(f.service.error, "");
  f.children[0].stdout.write(JPEG); assert.equal(f.service.state, "running");
});

test("OBS startup failure closes owned resources and never silently changes to JPEG", async t => {
  const f = await startOBSFixture(t, { obsTransport: { start: async () => { throw Error("private service password or endpoint"); } } });
  assert.equal(f.service.state, "error"); assert.equal(f.children.length, 0); assert.equal(f.service.leases.size, 0);
  assert.equal(f.calls.filter(value => value === "obs-stop").length, 1); assert.equal(JSON.stringify(f.service.snapshot()).includes("password"), false);
});

test("OBS shares the exact HQPlayer analysis feed and accepts bounded browser telemetry", async t => {
  const diagnostics = [], publishers = [];
  const obsTransport = { inspect: async () => ({ available: true }), start: async selected => { publishers.push(selected); selected.onReady(); }, stop: async () => {} };
  const f = dualFeedFixture({ obsTransport, onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  const request = { action: "start", visualizer: "g-force", inputId: HQP_MUSIC, zoneId: HQP_ZONE, transport: "obs-webrtc" };
  await f.service.session({ ...request, viewerId: A }); await f.service.serial;
  await f.service.session({ ...request, viewerId: B }); await f.service.serial;
  assert.equal(publishers.length, 1); assert.equal(f.calls.filter(value => value.action === "start" && value.id === HQP_MUSIC).length, 1);
  assert.equal(f.children.length, 0); assert.equal(f.service.snapshot(B).zoneId, HQP_ZONE);
  await f.service.session({ action: "heartbeat", viewerId: A, videoStats: { transport: "obs-webrtc", displayedFps: 60, receivedFrames: 4, privateToken: "secret" } });
  const stats = diagnostics.find(value => value.event === "viewer-performance");
  assert.equal(stats.transport, "obs-webrtc"); assert.equal(stats.displayedFps, 60); assert.equal(stats.privateToken, undefined);
  await f.service.session({ action: "stop", viewerId: A }); assert.equal(f.service.state, "running");
});

test("OBS fidelity reports configuration separately from unmeasured H.264 frames", async t => {
  const f = await startOBSFixture(t); const value = await f.service.fidelity();
  assert.deepEqual(value.native.clientResolution, { width: 1920, height: 1080 }); assert.equal(value.native.internalRenderTargetResolution, null);
  assert.equal(value.capture.inputResolution, null); assert.equal(value.capture.api, "obs-window-capture"); assert.equal(value.transmission.format, "video/H264");
  assert.deepEqual(value.transmission.configuredResolution, { width: 1920, height: 1080 }); assert.equal(value.transmission.resolution, null);
  assert.equal(value.transmission.bitDepth, null); assert.equal(value.transmission.quality, null); assert.equal(value.transmission.payloadBitrateMbps, null);
  assert.equal(value.transmission.configuredBitrateMbps, 25);
});

test("OBS fidelity reads only cached same-generation measurements and keeps settings distinct from bitstream size", async t => {
  let snapshots = 0;
  const f = await startOBSFixture(t, { obsTransport: { snapshot: () => { snapshots++; return {
    transport: "obs-webrtc", state: "running", generation: f.service.generation,
    captureSourceResolution: { width: 1280, height: 720 }, captureSourceMeasurement: "obs-scene-item-source-size", sourceObservedAt: 990,
    outputSettingsResolution: { width: 1920, height: 1080 }, publishedFormat: "H264", formatMeasurement: "mediamtx-published-track",
    payloadBitrateMbps: 24.5, bitrateWindowMs: 2000, bitrateObservedAt: 995, bitrateMeasurement: "mediamtx-incoming-byte-counter-delta",
    sourcePath: "private-source", ownerToken: "private-token", profile: { password: "private-password" }
  }; } } });
  const value = await f.service.fidelity();
  assert.equal(snapshots, 1); assert.equal(f.calls.filter(entry => entry === "obs-start").length, 1);
  assert.deepEqual(value.native.clientResolution, { width: 1920, height: 1080 }); assert.equal(value.native.internalRenderTargetResolution, null);
  assert.deepEqual(value.capture.inputResolution, { width: 1280, height: 720 }); assert.equal(value.capture.inputResolutionMeasurement, "obs-scene-item-source-size");
  assert.equal(value.capture.inputObservedAt, 990); assert.deepEqual(value.transmission.outputSettingsResolution, { width: 1920, height: 1080 });
  assert.equal(value.transmission.outputSettingsMeasurement, "obs-get-video-settings"); assert.equal(value.transmission.resolution, null);
  assert.equal(value.transmission.formatMeasurement, "mediamtx-published-track"); assert.equal(value.transmission.bitDepth, null);
  assert.equal(value.transmission.payloadBitrateMbps, 24.5); assert.equal(value.transmission.bitrateWindowMs, 2000); assert.equal(value.transmission.bitrateObservedAt, 995);
  assert.equal(value.transmission.bitrateMeasurement, "mediamtx-incoming-byte-counter-delta"); assert.equal(value.transmission.bitrateScope, "publisher-stream-payload");
  assert.equal(JSON.stringify(value).includes("private-"), false);
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal((await f.service.fidelity()).capture.inputResolution, null); assert.equal(snapshots, 1);
});

test("OBS fidelity discards stale, unavailable and invalid cached provider observations", async t => {
  let cached = {};
  const f = await startOBSFixture(t, { obsTransport: { snapshot: () => { if (cached === null) throw Error("private diagnostic error"); return cached; } } });
  const measured = { transport: "obs-webrtc", state: "running", generation: f.service.generation,
    captureSourceResolution: { width: 1920, height: 1080 }, captureSourceMeasurement: "obs-scene-item-source-size", sourceObservedAt: 1000,
    outputSettingsResolution: { width: 1920, height: 1080 }, publishedFormat: "H264", formatMeasurement: "mediamtx-published-track",
    payloadBitrateMbps: 25, bitrateWindowMs: 2000, bitrateMeasurement: "mediamtx-incoming-byte-counter-delta" };
  for (const invalid of [null, { ...measured, generation: f.service.generation - 1 }, { ...measured, state: "starting" }, { ...measured, transport: "jpeg" }]) {
    cached = invalid; const value = await f.service.fidelity();
    assert.equal(value.capture.inputResolution, null); assert.equal(value.transmission.outputSettingsResolution, null);
    assert.equal(value.transmission.payloadBitrateMbps, null); assert.equal(value.transmission.formatMeasurement, "configured-pipeline");
  }
  cached = { ...measured, captureSourceResolution: { width: 1920, height: Infinity }, outputSettingsResolution: { width: -1, height: 1080 },
    publishedFormat: "private-codec", payloadBitrateMbps: Infinity };
  const value = await f.service.fidelity(); assert.equal(value.capture.inputResolution, null); assert.equal(value.capture.inputObservedAt, null);
  assert.equal(value.transmission.outputSettingsResolution, null); assert.equal(value.transmission.payloadBitrateMbps, null);
  assert.equal(value.transmission.formatMeasurement, "configured-pipeline"); assert.equal(f.service.state, "running");
});

test("WebRTC signaling validates exact leased viewers and sanitizes resource locations", async t => {
  const f = await startOBSFixture(t); const generation = f.service.generation;
  await assert.rejects(f.service.signalWebRTC({ method: "POST", viewerId: B, generation, body: VIDEO_SDP }), /Start visuals/);
  await assert.rejects(f.service.signalWebRTC({ method: "POST", viewerId: A, generation: generation + 1, body: VIDEO_SDP }), /selection changed/);
  await assert.rejects(f.service.signalWebRTC({ method: "POST", viewerId: A, generation, body: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }), /video-only/);
  await assert.rejects(f.service.signalWebRTC({ method: "POST", viewerId: A, generation, body: VIDEO_SDP + "a=" + "x".repeat(65536) }), /bounded/);
  assert.equal(f.calls.some(value => value.signal), false);
  const answer = await f.service.signalWebRTC({ method: "POST", viewerId: A, generation, body: VIDEO_SDP });
  assert.equal(answer.status, 201); assert.equal(answer.body, VIDEO_SDP);
  const location = new URL(answer.headers.Location, "http://localhost:3777"); assert.equal(location.pathname, "/api/soundspectrum/webrtc");
  assert.equal(location.searchParams.get("viewerId"), A); assert.equal(location.searchParams.get("generation"), String(generation));
  assert.equal(location.searchParams.get("sessionId"), RTC_RESOURCE);
  await assert.rejects(f.service.signalWebRTC({ method: "DELETE", viewerId: A, generation, sessionId: "http://private" }), /Invalid WebRTC/);
  assert.equal((await f.service.signalWebRTC({ method: "DELETE", viewerId: A, generation, sessionId: RTC_RESOURCE })).status, 204);
});

test("Stop fences a late WebRTC answer and cleans only its owned reader resource", async t => {
  let finish;
  const f = await startOBSFixture(t, { obsTransport: { signal: params => {
    f.calls.push({ signal: params }); return params.method === "POST" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ status: 204 });
  } } });
  const pending = f.service.signalWebRTC({ method: "POST", viewerId: A, generation: f.service.generation, body: VIDEO_SDP });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  finish({ status: 201, sessionId: RTC_RESOURCE, body: VIDEO_SDP }); await assert.rejects(pending);
  const deletes = f.calls.filter(value => value.signal?.method === "DELETE"); assert.equal(deletes.length, 1); assert.equal(deletes[0].signal.sessionId, RTC_RESOURCE);
});

test("releasing one OBS viewer cleans its readers and retains the shared publisher", async t => {
  const f = await startOBSFixture(t); const generation = f.service.generation;
  await f.service.session({ action: "join", viewerId: B, visualizer: "g-force", inputId: "mic", transport: "obs-webrtc", generation });
  await f.service.session({ action: "stop", viewerId: A }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.state, "running"); assert.equal(f.calls.includes("obs-stop"), false);
  assert.deepEqual(f.calls.find(value => value.releaseViewer)?.releaseViewer, { viewerId: A, generation });
});

test("WebRTC API reads bounded raw SDP and rejects cross-site requests before signaling", async t => {
  const f = await startOBSFixture(t); const generation = f.service.generation;
  let json;
  const api = createSoundSpectrumApi({ service: f.service, readJson: () => { throw Error("must not use JSON for SDP"); }, sendJson: (_res, code, body) => { json = { code, body }; } });
  const request = (body, headers = {}) => { const req = new PassThrough(); req.method = "POST"; req.headers = { "content-type": "application/sdp", ...headers }; req.socket = {}; req.end(body); return req; };
  const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } });
  const url = new URL(`http://localhost:3777/api/soundspectrum/webrtc?viewerId=${A}&generation=${generation}`);
  const res = response(); await api.handle(request(VIDEO_SDP), res, url);
  assert.equal(res.status, 201); assert.equal(res.body, VIDEO_SDP); assert.match(res.headers.Location, /^\/api\/soundspectrum\/webrtc\?/);
  await api.handle(request(VIDEO_SDP, { "sec-fetch-site": "cross-site" }), response(), url); assert.equal(json.code, 403);
  await api.handle(request(VIDEO_SDP, { "content-type": "application/json" }), response(), url); assert.equal(json.code, 415);
  await api.handle(request("x".repeat(65537)), response(), url); assert.equal(json.code, 413);
});

test("idle fidelity diagnostics never inspect, start, acquire capture or touch audio", async t => {
  let calls = 0;
  const unexpected = () => { calls++; throw Error("must not be called"); };
  const f = fixture({ native: { inspect: unexpected, start: unexpected, captureWindow: unexpected },
    capture: { probeCaptureRuntime: unexpected, buildCaptureCommand: unexpected }, audioFeed: { inspect: unexpected, snapshot: unexpected, start: unexpected, stop: async () => {} } });
  t.after(() => f.service.close());
  const value = await f.service.fidelity();
  assert.equal(calls, 0); assert.equal(f.children.length, 0); assert.equal(f.service.leases.size, 0);
  assert.equal(value.state, "idle"); assert.equal(value.native.clientResolution, null); assert.equal(value.transmission.resolution, null);
  assert.equal(value.transmission.payloadBitrateMbps, null);
});

test("fidelity reports observed client and JPEG dimensions separately from unknown internal targets", async t => {
  const f = await startFidelityFixture(t, { native: { captureWindow: async () => ({ pid: 123, windowHandle: "1234", width: 3840, height: 2095,
    windowTitle: "private title", executable: "C:\\private", audioInput: "private input" }) } });
  const leases = [...f.service.leases], children = f.children.length, stops = f.stops;
  const value = await f.service.fidelity();
  assert.deepEqual(value.native.clientResolution, { width: 3840, height: 2095 }); assert.equal(value.native.measurement, "getclientrect-current");
  assert.deepEqual(value.native.lastCaptureClientResolution, { width: 800, height: 450 }); assert.equal(value.native.lastCaptureObservedAt, 1000);
  assert.equal(value.native.internalRenderTargetResolution, null); assert.equal(value.capture.inputResolution, null);
  assert.deepEqual(value.transmission.resolution, { width: 800, height: 450 }); assert.equal(value.transmission.resolutionMeasurement, "jpeg-sof");
  assert.equal(value.transmission.bitDepth, 8); assert.equal(value.transmission.chromaSubsampling, "4:2:0");
  assert.equal(value.transmission.quality, 65); assert.equal(value.transmission.colorimetry, "1:4:7:1");
  assert.equal(value.transmission.colorMeasurement, "configured-pipeline"); assert.equal(value.capture.sourceFormatMeasurement, "capture-api-contract");
  assert.equal(JSON.stringify(value).includes("private"), false); assert.equal(JSON.stringify(value).includes("windowHandle"), false);
  assert.deepEqual([...f.service.leases], leases); assert.equal(f.children.length, children); assert.equal(f.stops, stops);
});

test("native fidelity observations coalesce and cache success or failure for two seconds", async t => {
  let calls = 0, finish;
  const f = await startFidelityFixture(t, { native: { captureWindow: () => { calls++; return new Promise(resolve => { finish = resolve; }); } } });
  const first = f.service.fidelity(), second = f.service.fidelity();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); finish({ pid: 123, windowHandle: "1234", width: 1920, height: 1080 });
  await Promise.all([first, second]);
  f.advance(1999); assert.equal((await f.service.fidelity()).native.observedAt, 1000); assert.equal(calls, 1);
  f.advance(1); f.service.native.captureWindow = async () => { calls++; throw Error("private native error"); };
  const value = await f.service.fidelity(); assert.equal(value.native.clientResolution, null); assert.equal(value.native.measurement, "unknown");
  await f.service.fidelity(); assert.equal(calls, 2); assert.equal(f.service.state, "running"); assert.equal(f.children[0].killed, undefined);
});

test("fidelity rejects a changed native identity without failing or restarting visuals", async t => {
  for (const changed of [{ pid: 999, windowHandle: "1234" }, { pid: 123, windowHandle: "5678" }, { pid: 123, windowHandle: "1234", width: "1920", height: 1080 }]) {
    const f = await startFidelityFixture(t, { native: { captureWindow: async () => ({ width: 1920, height: 1080, ...changed }) } });
    const value = await f.service.fidelity(); assert.equal(value.native.clientResolution, null);
    assert.equal(f.service.state, "running"); assert.equal(f.children.length, 1); assert.equal(f.children[0].killed, undefined);
  }
});

test("a slow native diagnostic cannot publish old dimensions after Stop or selection replacement", async t => {
  for (const action of ["stop", "switch"]) {
    let finish;
    const f = await startFidelityFixture(t, { native: { captureWindow: () => new Promise(resolve => { finish = resolve; }) } });
    const value = f.service.fidelity(); while (!finish) await new Promise(resolve => setImmediate(resolve));
    if (action === "stop") await f.service.session({ action: "stop", viewerId: A });
    else await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
    await f.service.serial;
    finish({ pid: 123, windowHandle: "1234", width: 3840, height: 2160 });
    const result = await value;
    assert.equal(result.generation, f.service.generation); assert.equal(result.native.clientResolution, null);
    assert.equal(f.service.fidelityNative, null); assert.equal(result.transmission.payloadBitrateMbps, null);
  }
});

test("fidelity measures capture JPEG payload bitrate and resets across capture recovery", async t => {
  const f = await startFidelityFixture(t, { native: { captureWindow: async () => ({ pid: 123, windowHandle: "1234", width: 800, height: 450 }) } });
  assert.equal((await f.service.fidelity()).transmission.payloadBitrateMbps, null);
  const bytes = fidelityJpeg().length;
  f.advance(2000); f.children[0].stdout.write(Buffer.concat([fidelityJpeg(), fidelityJpeg(), fidelityJpeg()]));
  const value = await f.service.fidelity();
  assert.equal(value.transmission.payloadBitrateMbps, bytes * 3 * 8 / 2000 / 1000); assert.equal(value.transmission.bitrateWindowMs, 2000);
  assert.equal(value.transmission.bitrateMeasurement, "capture-jpeg-byte-counter-delta");
  f.children[0].emit("close", 1, null); await f.service.serial; f.children[1].stdout.write(fidelityJpeg());
  assert.equal((await f.service.fidelity()).transmission.payloadBitrateMbps, null);
  f.advance(31000); await f.service.session({ action: "heartbeat", viewerId: A }).catch(() => {});
  assert.equal((await f.service.fidelity()).transmission.payloadBitrateMbps, null);
});

test("fidelity JPEG headers measure alternate precision and sampling and reject malformed headers", async t => {
  const f = await startFidelityFixture(t);
  for (const [frame, depth, sampling, resolution] of [
    [fidelityJpeg({ width: 960, height: 720, factors: [0x11, 0x11, 0x11] }), 8, "4:4:4", { width: 960, height: 720 }],
    [fidelityJpeg({ depth: 12, marker: 0xc2, factors: [0x21, 0x11, 0x11] }), 12, "4:2:2", { width: 800, height: 450 }],
    [fidelityJpeg({ factors: [0x11] }), 8, "grayscale", { width: 800, height: 450 }],
    [JPEG, null, "unknown", null], [Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff, 0xff, 0xd9]), null, "unknown", null]
  ]) {
    f.children[0].stdout.write(frame); const value = await f.service.fidelity();
    assert.equal(value.transmission.bitDepth, depth); assert.equal(value.transmission.chromaSubsampling, sampling); assert.deepEqual(value.transmission.resolution, resolution);
    assert.equal(value.transmission.configuredBitDepth, 8); assert.equal(value.transmission.configuredChromaSubsampling, "4:2:0");
  }
});

test("fidelity GET uses the passive service method and preserves cross-origin protection", async () => {
  let calls = 0, sent;
  const service = { fidelity: async () => { calls++; return { version: 1, native: { clientResolution: null } }; },
    inspect: () => { throw Error("not permitted"); }, status: () => { throw Error("not permitted"); } };
  const api = createSoundSpectrumApi({ service, sendJson: (_res, code, body) => { sent = { code, body }; } });
  const res = { setHeader() {} }, url = new URL("http://localhost:3777/api/soundspectrum/fidelity");
  await api.handle({ method: "GET", headers: {}, socket: {} }, res, url);
  assert.equal(calls, 1); assert.equal(sent.code, 200); assert.equal(sent.body.version, 1);
  await api.handle({ method: "GET", headers: { "sec-fetch-site": "cross-site" }, socket: {} }, res, url);
  assert.equal(calls, 1); assert.equal(sent.code, 403);
});

test("capture resize failure reconnects the same renderer and keeps the single music feed and viewers", async t => {
  const diagnostics = []; let windowChecks = 0;
  const f = musicFixture({ onDiagnostic: entry => diagnostics.push(entry), native: { captureWindow: async () => {
    windowChecks++; return { windowHandle: "1234", pid: 123, width: 3840, height: 2095 };
  } } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "start", viewerId: B, visualizer: "g-force", inputId: MUSIC, playerId: PLAYER });
  const generation = f.service.generation, stops = f.stops, calls = [...f.calls];
  const res = new Response(); f.service.video({}, res, A);
  f.children[0].stderr.write("ERROR: resize negotiation failed at C:\\private\\window-capture\n");
  f.children[0].emit("close", 1, null);
  assert.equal(f.service.state, "starting");
  await f.service.serial;
  assert.equal(windowChecks, 1); assert.equal(f.children.length, 2); assert.equal(f.starts.length, 1);
  assert.equal(f.stops, stops); assert.deepEqual(f.calls, calls); assert.equal(res.destroyed, undefined);
  assert.equal(f.service.generation, generation); assert.equal(f.service.leases.size, 2);
  f.children[1].stdout.write(JPEG);
  assert.equal(f.service.state, "running"); assert.equal(f.service.snapshot(B).viewerActive, true);
  assert.equal(diagnostics[0].event, "capture-exit"); assert.equal(diagnostics[0].code, 1); assert.equal(diagnostics[0].retry, true);
  assert.match(diagnostics[0].stderrTail, /negotiation/);
  assert.equal(JSON.stringify(f.service.snapshot()).includes("private"), false);
});

test("a failed capture reconnect stops after its bounded attempt", async t => {
  const f = fixture({ native: { captureWindow: async () => ({ windowHandle: "1234", pid: 123 }) } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); f.children[0].emit("close", 1, null); await f.service.serial;
  f.children[1].stdout.write(JPEG); f.children[1].emit("close", 1, null); await f.service.serial;
  assert.equal(f.children.length, 2); assert.equal(f.service.state, "error"); assert.equal(f.service.leases.size, 0);
  assert.match(f.service.error, /video bridge stopped/);
});

test("capture retry budget renews only after thirty seconds of healthy frames", async t => {
  const f = fixture({ native: { captureWindow: async () => ({ windowHandle: "1234", pid: 123 }) } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); f.children[0].emit("close", 1, null); await f.service.serial;
  f.children[1].stdout.write(JPEG); assert.equal(f.service.captureRecoveryUsed, true);
  for (let second = 0; second < 29; second++) {
    f.advance(1000); f.children[1].stdout.write(JPEG);
    await f.service.session({ action: "heartbeat", viewerId: A });
  }
  f.advance(999); f.children[1].stdout.write(JPEG); assert.equal(f.service.captureRecoveryUsed, true);
  f.advance(1); f.children[1].stdout.write(JPEG); assert.equal(f.service.captureRecoveryUsed, false);
  f.children[1].emit("close", 1, null); await f.service.serial;
  assert.equal(f.children.length, 3); assert.equal(f.starts.length, 1);
});

test("capture never retries device reset, permissions, process signals or memory errors", async t => {
  for (const [stderr, signal] of [["DXGI_ERROR_DEVICE_REMOVED", null], ["device was lost", null], ["0x887A0005", null], ["access denied", null], ["out of memory", null], ["", "SIGSEGV"]]) {
    let checks = 0;
    const f = fixture({ native: { captureWindow: async () => { checks++; return { windowHandle: "1234", pid: 123 }; } } }); t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
    f.children[0].stdout.write(JPEG); f.children[0].stderr.write(stderr); f.children[0].emit("close", 1, signal); await f.service.serial;
    assert.equal(checks, 0); assert.equal(f.children.length, 1); assert.equal(f.service.state, "error");
  }
});

test("Windows fatal capture exit codes never trigger another graphics process", async t => {
  for (const code of [0xc0000005, 0xc0000409, 0xc0000017, -1073741819]) {
    let checks = 0; const diagnostics = [];
    const f = fixture({ onDiagnostic: entry => diagnostics.push(entry), native: { captureWindow: async () => { checks++; return { windowHandle: "1234", pid: 123 }; } } }); t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
    f.children[0].stdout.write(JPEG); f.children[0].emit("close", code, null); await f.service.serial;
    assert.equal(checks, 0); assert.equal(f.children.length, 1); assert.equal(f.service.state, "error");
    assert.equal(diagnostics[0].code, code); assert.equal(diagnostics[0].retry, false);
  }
});

test("expired viewer cannot reconnect capture while validation is pending", async t => {
  let finish;
  const f = fixture({ native: { captureWindow: () => new Promise(resolve => { finish = resolve; }) } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); f.children[0].emit("close", 1, null);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.advance(13000); finish({ windowHandle: "1234", pid: 123 }); await f.service.serial;
  assert.equal(f.children.length, 1); assert.equal(f.starts.length, 1);
  f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle");
});

test("a gone or changed native renderer is never relaunched by capture recovery", async t => {
  for (const captureWindow of [async () => { throw Error("Renderer exited"); }, async () => ({ windowHandle: "5678", pid: 999 })]) {
    const f = fixture({ native: { captureWindow } }); t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
    f.children[0].stdout.write(JPEG); f.children[0].emit("close", 1, null); await f.service.serial; await f.service.serial;
    assert.equal(f.children.length, 1); assert.equal(f.starts.length, 1); assert.equal(f.service.state, "error");
  }
});

test("Stop and selection changes fence a slow capture window validation", async t => {
  for (const action of ["stop", "switch"]) {
    let finish;
    const f = fixture({ native: { captureWindow: () => new Promise(resolve => { finish = resolve; }) } }); t.after(() => f.service.close());
    await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
    const old = f.children[0]; old.stdout.write(JPEG); old.emit("close", 1, null);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    if (action === "stop") await f.service.session({ action, viewerId: A });
    else await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
    finish({ windowHandle: "1234", pid: 123 }); await f.service.serial;
    assert.equal(f.children.length, action === "stop" ? 1 : 2);
    const state = f.service.state; old.stdout.write(JPEG); old.emit("close", 1, null);
    assert.equal(f.service.state, state); assert.equal(f.service.captureRecoveryUsed, false);
  }
});
class Response extends EventEmitter {
  constructor() { super(); this.headers = {}; this.chunks = []; this.writableLength = 0; this.block = false; }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); }
  write(chunk) { this.chunks.push(chunk); return !this.block; }
  destroy() { this.destroyed = true; this.emit("close"); }
}
test("service capture defaults to 60 fps and supports the explicit 30 fps rollback", async t => {
  for (const [setting, fps] of [[undefined, 60], ["60", 60], ["30", 30]]) {
    const commands = [];
    const f = fixture({ env: { SOUNDSPECTRUM_VIDEO_FPS: setting }, capture: { buildCaptureCommand: selection => {
      const command = buildCaptureCommand({ ...selection, executable: "C:\\capture-test\\bin\\gst-launch-1.0.exe" }, {});
      commands.push(command); return command;
    } } });
    t.after(() => f.service.close());
    assert.equal(f.service.snapshot().videoStats.targetFps, fps);
    assert.equal(f.starts.length, 0);
    await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
    await f.service.serial;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].fps, fps);
    assert.ok(commands[0].args.includes(`video/x-raw(memory:D3D11Memory),framerate=${fps}/1`));
    assert.deepEqual([commands[0].width, commands[0].height, commands[0].quality], [800, 450, 65]);
    f.children[0].stdout.write(JPEG);
    assert.equal(f.service.snapshot(A).state, "running");
    assert.equal(f.service.snapshot(A).videoStats.targetFps, fps);
  }
});

test("invalid video FPS settings retain the 60 fps service default without starting capture", async t => {
  for (const setting of ["", "0", "15", "31", "61", "30.0", " 30 ", "invalid"]) {
    const f = fixture({ env: { SOUNDSPECTRUM_VIDEO_FPS: setting } });
    t.after(() => f.service.close());
    assert.equal(f.service.snapshot().videoStats.targetFps, 60);
    assert.equal(f.starts.length, 0); assert.equal(f.children.length, 0);
  }
});

test("music feed starts explicitly for the selected player and shares one copy across viewers", async t => {
  const f = musicFixture(); t.after(() => f.service.close());
  const inventory = await f.service.status(); assert.equal(inventory.musicInputs[0].available, true); assert.equal(f.calls.length, 0);
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  assert.equal(f.calls.filter(value => value === PLAYER).length, 1); assert.equal(f.starts.length, 1);
  assert.equal(f.service.snapshot(B).inputKind, "music-feed"); assert.equal(f.service.snapshot(B).playerId, PLAYER);
  await f.service.session({ action: "stop", viewerId: A }); assert.equal(f.children[0].killed, undefined);
  await f.service.session({ action: "stop", viewerId: B }); await f.service.serial;
  assert.equal(f.calls.at(-1), "stop"); assert.equal(f.children[0].killed, true);
});

test("unavailable, forged and playerless music selections never launch the native renderer", async t => {
  const f = musicFixture({ audioFeed: { inspect: async () => ({ id: MUSIC, kind: "music-feed", available: false, reason: "Bridge needs restart" }) } }); t.after(() => f.service.close());
  await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }), /restart/);
  const g = musicFixture(); t.after(() => g.service.close());
  await assert.rejects(g.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC }), /connected Lyrion player/);
  await assert.rejects(g.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "arbitrary-cable", inputKind: "music-feed", playerId: PLAYER }), /available/);
  assert.equal(f.starts.length + g.starts.length, 0);
});

test("stopping a slow music launch cannot open native visuals after cancellation", async t => {
  let finish;
  const f = musicFixture({ audioFeed: { start: () => new Promise(resolve => { finish = resolve; }) } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: A }); finish(); await f.service.serial;
  assert.equal(f.starts.length, 0); assert.equal(f.children.length, 0); assert.equal(f.calls.at(-1), "stop");
});

test("late feed failure cannot stop a newer no-mic session", async t => {
  const f = musicFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  const oldFailure = f.failure;
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "generator:fluid" }); await f.service.serial;
  f.children.at(-1).stdout.write(JPEG); oldFailure(Error("old copy failed")); await f.service.serial;
  assert.equal(f.service.state, "running"); assert.equal(f.service.inputKind, "no-mic"); assert.equal(f.children.at(-1).killed, undefined);
});

test("a live copy failure releases all native viewers and surfaces its specific cause", async t => {
  const f = musicFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG); f.failure(Error("copy packet lost; playback continues")); await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /copy packet lost/);
  assert.equal(f.service.leases.size, 0); assert.equal(f.children[0].killed, true); assert.equal(f.calls.at(-1), "stop");
});

test("a disconnected selected player cannot tear down another viewer's working visuals", async t => {
  const f = musicFixture({ audioFeed: { validateStart: async () => { throw Error("Choose a connected Lyrion player first."); } } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "generator:fluid" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); const generation = f.service.generation;
  await assert.rejects(f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }), /connected Lyrion player/);
  assert.equal(f.service.generation, generation); assert.equal(f.service.state, "running"); assert.equal(f.children[0].killed, undefined);
  assert.equal(f.service.snapshot(A).viewerActive, true); assert.equal(f.service.snapshot(B).viewerActive, false);
});

test("stop cancels music selection during connected-player validation", async t => {
  let finish;
  const f = musicFixture({ audioFeed: { validateStart: () => new Promise(resolve => { finish = resolve; }) } }); t.after(() => f.service.close());
  const start = f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: A }); finish(); await assert.rejects(start, /cancelled/);
  assert.equal(f.calls.length, 0); assert.equal(f.starts.length, 0); assert.equal(f.service.leases.size, 0);
});
test("JPEG parser handles split frames and multipart headers with bounded incomplete data", () => {
  const frames = [], parser = new JpegFrames(frame => frames.push(frame));
  const packet = Buffer.concat([Buffer.from("--boundary\r\nContent-Type: image/jpeg\r\n\r\n"), JPEG, Buffer.from("\r\n")]);
  for (const byte of packet) parser.push(Buffer.from([byte]));
  assert.deepEqual(frames, [JPEG]);
  parser.push(Buffer.alloc(3 * 1024 * 1024, 1)); assert.ok(parser.buffer.length <= 1);
  assert.throws(() => parser.push(Buffer.concat([JPEG.subarray(0, 2), Buffer.alloc(2 * 1024 * 1024)])), /oversized/);
});
test("native visuals start explicitly, become running after JPEG, and stop when the last lease leaves", async t => {
  const f = fixture(); t.after(() => f.service.close());
  assert.equal((await f.service.status()).state, "idle"); assert.equal(f.starts.length, 0);
  await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "virtual" }), /microphone/);
  const first = await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
  assert.equal(first.state, "starting"); await f.service.serial;
  assert.equal(f.starts.length, 1); f.children[0].stdout.write(JPEG);
  assert.equal(f.service.snapshot(A).state, "running"); assert.equal(f.service.snapshot(A).viewerActive, true);
  const res = new Response(); f.service.video({}, res, A);
  assert.match(res.headers["Content-Type"], /multipart/); assert.ok(Buffer.concat(res.chunks).includes(JPEG));
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.children[0].killed, true); assert.equal(res.destroyed, true);
});
test("viewer performance diagnostics accept bounded scalars without exposing identities or appearing in snapshots", async t => {
  const diagnostics = [], f = fixture({ onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); f.advance(20); f.children[0].stdout.write(JPEG);
  const result = await f.service.session({ action: "heartbeat", viewerId: A, visibility: "visible", videoStats: {
    transport: "websocket", presentation: "windowed", coarsePointer: true, backdropProfile: "windowed-touch",
    frames: 120, receiveFps: 48, decodeFps: 47, displayedFps: 35, backgroundFrames: 42, backgroundFps: 20,
    meanDecodeMs: 1.5, meanPaintMs: 0.7, meanRafWaitMs: 21, maxPaintGapMs: 900000,
    receivedFrames: 999999999999, decodedFrames: -1, replacedFrames: NaN, busyDroppedFrames: Infinity, lastPaintGapMs: "17",
    viewerId: A, url: "private-url", title: "private-track", audio: "private-audio" } });
  const entry = diagnostics.find(value => value.event === "viewer-performance");
  assert.deepEqual(entry, { at: 1020, event: "viewer-performance", generation: 1, viewerSlot: 1, visibility: "visible",
    captureFps: 50, frameAgeMs: 0, transport: "websocket", frames: 120, receivedFrames: 2147483647, backgroundFrames: 42,
    receiveFps: 48, decodeFps: 47, displayedFps: 35, backgroundFps: 20, meanDecodeMs: 1.5, meanPaintMs: 0.7,
    meanRafWaitMs: 21, maxPaintGapMs: 60000, presentation: "windowed", coarsePointer: true, backdropProfile: "windowed-touch" });
  assert.equal(result.viewerActive, true); assert.equal(f.starts.length, 1); assert.equal(f.children.length, 1);
  const logged = JSON.stringify(diagnostics), publicSnapshot = JSON.stringify(result);
  for (const secret of [A, "private-url", "private-track", "private-audio"]) assert.equal(logged.includes(secret), false);
  for (const privateField of ["viewerSlot", "displayedFps", "coarsePointer", "backdropProfile"]) assert.equal(publicSnapshot.includes(privateField), false);
});

test("optional missing or malformed viewer telemetry never interferes with heartbeat renewal", async t => {
  const diagnostics = [], f = fixture({ onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const throwing = Object.defineProperty({}, "transport", { get() { throw Error("unusable optional telemetry"); } });
  for (const videoStats of [undefined, null, 4, "private", [], { transport: "arbitrary-private-mode" }, throwing]) {
    f.advance(4000);
    const result = await f.service.session({ action: "heartbeat", viewerId: A, videoStats });
    assert.equal(result.viewerActive, true); assert.equal(f.service.leases.get(A), f.service.clock() + f.service.leaseMs);
  }
  assert.equal(f.service.viewerPerformance.size, 0);
  assert.equal(diagnostics.filter(entry => entry.event === "viewer-performance").length, 0);
  const result = await f.service.session({ action: "heartbeat", viewerId: A, videoStats: { transport: "websocket", receiveFps: NaN,
    presentation: "private-mode", coarsePointer: "private-device", backdropProfile: "private-profile", frames: -4 } });
  assert.equal(result.viewerActive, true);
  assert.deepEqual(diagnostics.at(-1), { at: f.service.clock(), event: "viewer-performance", generation: 1, viewerSlot: 1,
    visibility: "unknown", captureFps: null, frameAgeMs: 28000, transport: "websocket" });
});

test("viewer performance diagnostics are independently throttled across fullscreen transitions", async t => {
  const diagnostics = [], f = fixture({ onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "join", viewerId: B, generation: 1, visualizer: "g-force", inputId: "mic" });
  const heartbeat = (viewerId, presentation) => f.service.session({ action: "heartbeat", viewerId, videoStats: { transport: "websocket", presentation, displayedFps: 48 } });
  await heartbeat(A, "windowed"); await heartbeat(B, "player-fullscreen");
  for (const presentation of ["visualizer-fullscreen", "windowed", "player-fullscreen"]) { f.advance(4000); await heartbeat(A, presentation); await heartbeat(B, "windowed"); }
  assert.equal(diagnostics.filter(entry => entry.event === "viewer-performance").length, 2);
  f.advance(2999); await heartbeat(A, "visualizer-fullscreen");
  assert.equal(diagnostics.filter(entry => entry.event === "viewer-performance").length, 2);
  f.advance(1); await heartbeat(A, "visualizer-fullscreen"); await heartbeat(B, "windowed");
  assert.deepEqual(diagnostics.filter(entry => entry.event === "viewer-performance").map(entry => [entry.viewerSlot, entry.presentation]),
    [[1, "windowed"], [2, "player-fullscreen"], [1, "visualizer-fullscreen"], [2, "windowed"]]);
  assert.equal(f.starts.length, 1); assert.equal(f.children.length, 1);
});

test("private viewer diagnostic state stays within eight leases and clears on stop expiry generation failure and shutdown", async t => {
  const diagnostics = [], f = fixture({ staleMs: 120000, onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const heartbeat = viewerId => f.service.session({ action: "heartbeat", viewerId, videoStats: { transport: "websocket", presentation: "windowed" } });
  const viewers = [A, B, ...Array.from({ length: 6 }, (_, index) => "viewer_extra_12345678901234567890_" + index)];
  for (const viewerId of viewers) {
    if (viewerId !== A) await f.service.session({ action: "join", viewerId, generation: 1, visualizer: "g-force", inputId: "mic" });
    await heartbeat(viewerId);
  }
  assert.equal(f.service.viewerPerformance.size, 8);
  await assert.rejects(f.service.session({ action: "join", viewerId: "viewer_rejected_12345678901234567890", generation: 1, visualizer: "g-force", inputId: "mic" }), /Too many/);
  await assert.rejects(heartbeat("viewer_unknown_12345678901234567890"), /stopped/);
  assert.equal(f.service.viewerPerformance.size, 8);
  await f.service.session({ action: "stop", viewerId: B }); assert.equal(f.service.viewerPerformance.has(B), false);
  f.advance(8000); await heartbeat(A); f.advance(4000); f.service.sweep();
  assert.equal(f.service.viewerPerformance.size, 1); assert.equal(f.service.viewerPerformance.has(A), true);
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  assert.equal(f.service.viewerPerformance.size, 0); f.children.at(-1).stdout.write(JPEG); await heartbeat(A);
  assert.equal(diagnostics.filter(entry => entry.event === "viewer-performance").at(-1).viewerSlot, 1);
  f.service.fail(f.service.generation, Error("test failure")); await f.service.serial;
  assert.equal(f.service.viewerPerformance.size, 0);
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children.at(-1).stdout.write(JPEG); await heartbeat(A); await f.service.close();
  assert.equal(f.service.viewerPerformance.size, 0);
});

test("hidden viewer heartbeats keep the owned renderer alive across a throttled minute and expire after bounded silence", async t => {
  const diagnostics = [];
  const f = fixture({ staleMs: 120000, onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const generation = f.service.generation, stops = f.stops;
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden" });
  f.advance(61000); f.children[0].stdout.write(JPEG); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "running"); assert.equal(f.service.generation, generation); assert.equal(f.stops, stops);
  assert.equal(f.service.snapshot(A).viewerActive, true);
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden" });
  assert.deepEqual(diagnostics.filter(entry => entry.event === "viewer-visibility").map(entry => [entry.visibility, entry.leaseMs]), [["hidden", 90000]]);
  f.advance(90001); f.children[0].stdout.write(JPEG); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.children[0].killed, true); assert.equal(f.stops, stops + 1);
  assert.equal(f.service.leaseVisibility.size, 0);
  assert.equal(diagnostics.find(entry => entry.event === "session-release").reason, "lease-expired");
});

test("returning visible restores the ordinary short viewer lease", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden" });
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "visible" });
  f.advance(12001); f.children[0].stdout.write(JPEG); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.service.snapshot(A).viewerActive, false);
});

test("hidden heartbeats cannot create leases and caller durations or invalid visibility cannot extend them", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden", leaseMs: Infinity }), /stopped/);
  assert.equal(f.starts.length, 0); assert.equal(f.service.leases.size, 0);
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: { hidden: true }, leaseMs: Infinity });
  f.advance(12001); f.children[0].stdout.write(JPEG); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle");
});

test("private stop diagnostics identify lifecycle reasons without exposing viewer IDs or accepting arbitrary text", async t => {
  const diagnostics = [];
  const f = fixture({ onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const result = await f.service.session({ action: "stop", viewerId: A, reason: "pagehide", visibility: "hidden" }); await f.service.serial;
  const stop = diagnostics.find(entry => entry.event === "session-stop");
  assert.equal(stop.reason, "pagehide"); assert.equal(stop.visibility, "hidden"); assert.equal(stop.hadLease, true); assert.equal(stop.nativePid, 123);
  assert.equal(diagnostics.find(entry => entry.event === "session-release").reason, "viewer-stop");
  await f.service.session({ action: "stop", viewerId: B, reason: "arbitrary private text", visibility: "other" });
  assert.equal(diagnostics.at(-1).reason, "unknown"); assert.equal(diagnostics.at(-1).visibility, "unknown");
  assert.ok(!JSON.stringify(diagnostics).includes(A)); assert.ok(!JSON.stringify(diagnostics).includes("arbitrary private text"));
  assert.ok(!JSON.stringify(result).includes("session-stop"));
});

test("private failure diagnostics retain a bounded cause before cleanup closes the renderer", async t => {
  const diagnostics = [];
  const f = fixture({ onDiagnostic: entry => diagnostics.push(entry) }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  f.service.fail(f.service.generation, Error("capture parse failure")); await f.service.serial;
  const failure = diagnostics.find(entry => entry.event === "session-failure");
  assert.equal(failure.reason, "capture parse failure"); assert.equal(failure.nativePid, 123); assert.equal(failure.state, "running");
  assert.equal(f.service.state, "error"); assert.equal(f.service.leaseVisibility.size, 0);
});

test("two viewers share one renderer; switching rejects stale frames and preserves the second viewer", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  assert.equal(f.starts.length, 1);
  for (const id of ["g-force", "whitecap"]) {
    const old = f.children.at(-1);
    await f.service.session({ action: "start", viewerId: A, visualizer: id, inputId: "mic" }); await f.service.serial;
    old.stdout.write(JPEG); assert.equal(f.service.state, "starting");
    f.children.at(-1).stdout.write(JPEG); assert.equal(f.service.snapshot(B).visualizer, id);
  }
  await f.service.session({ action: "stop", viewerId: A }); assert.equal(f.service.state, "running");
  f.advance(13000); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle"); await assert.rejects(f.service.session({ action: "heartbeat", viewerId: B }), /stopped/);
});
test("stop during a slow native launch closes the owned window without starting capture", async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ native: { start: async () => pending } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
  await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: A }); finish({ windowHandle: "1234" }); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.children.length, 0); assert.ok(f.stops >= 2);
});
test("native failures clean up without deadlocking the startup queue", async t => {
  const f = fixture({ native: { start: async () => { throw new Error("Windows microphone is unavailable"); } } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
  await f.service.serial; await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /microphone/); assert.equal(f.service.leases.size, 0);
});
test("stop cancels a start that is still enumerating PC devices", async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ native: { inspect: async () => pending } }); t.after(() => f.service.close());
  const start = f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
  await f.service.session({ action: "stop", viewerId: A });
  finish({ visualizers: [{ id: "aeon", available: true }], inputs: [{ id: "mic" }] });
  await assert.rejects(start, /cancelled/); await f.service.serial;
  assert.equal(f.starts.length, 0); assert.equal(f.service.leases.size, 0);
});
test("native cleanup failures surface an error instead of leaving startup stuck", async t => {
  const f = fixture({ native: { stop: async () => { throw new Error("Close the manually opened window"); } } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" });
  await f.service.serial; await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /manually/); assert.equal(f.starts.length, 0);
});
test("a slow viewer drops frames while another viewer keeps receiving video", async t => {
  const f = fixture(); t.after(() => f.service.close());
  for (const viewerId of [A, B]) await f.service.session({ action: "start", viewerId, visualizer: "aeon", inputId: "mic" });
  await f.service.serial; f.children[0].stdout.write(JPEG);
  const slow = new Response(), fast = new Response(); slow.block = true;
  f.service.video({}, slow, A); f.service.video({}, fast, B);
  const before = slow.chunks.length; f.children[0].stdout.write(JPEG); f.children[0].stdout.write(JPEG);
  assert.equal(slow.chunks.length, before); assert.equal(fast.chunks.length, 3);
  assert.equal(f.service.state, "running");
});
test("disconnecting the exact microphone stops native capture instead of switching sources", async t => {
  const f = fixture({ native: { listAudioInputs: async () => [] }, staleMs: 30000 }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); f.advance(10500); f.service.sweep(); await f.service.inputCheck; await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /microphone disconnected/); assert.equal(f.children[0].killed, true);
  const replies = [];
  const api = createSoundSpectrumApi({ service: f.service, readJson: async req => req.body, sendJson: (_res, code, body) => replies.push({ code, body }) });
  const req = { method: "POST", headers: { "content-type": "application/json" }, body: { action: "heartbeat", viewerId: A } };
  const url = new URL("http://localhost/api/soundspectrum/session");
  await api.handle(req, new Response(), url);
  assert.equal(replies.at(-1).code, 409); assert.match(replies.at(-1).body.error, /microphone disconnected/);
  req.body.action = "stop"; await api.handle(req, new Response(), url);
  assert.equal(replies.at(-1).body.state, "error"); assert.match(replies.at(-1).body.error, /microphone disconnected/);
  assert.equal(f.starts.length, 1);
});
test("all native no-mic presets start without hardware and never poll a microphone", async t => {
  const products = ["aeon", "g-force", "whitecap"], modes = ["fluid", "high-energy", "chill"];
  const noMicInputs = Object.fromEntries(products.map(id => [id, modes.map(mode => ({ id: `generator:${mode}`, name: mode, kind: "no-mic" }))]));
  let microphoneChecks = 0;
  const f = fixture({ staleMs: 30000, native: {
    inspect: async () => ({ visualizers: products.map(id => ({ id, available: true })), inputs: [], noMicInputs }),
    listAudioInputs: async () => { microphoneChecks++; throw Error("There is no microphone"); }
  } }); t.after(() => f.service.close());
  const inventory = await f.service.status();
  assert.deepEqual(inventory.noMicInputs, noMicInputs); assert.equal(f.starts.length, 0);
  for (const visualizer of products) for (const mode of modes) {
    const inputId = `generator:${mode}`;
    await f.service.session({ action: "start", viewerId: A, visualizer, inputId }); await f.service.serial;
    f.children.at(-1).stdout.write(JPEG);
    const snapshot = f.service.snapshot(A);
    assert.equal(snapshot.state, "running"); assert.equal(snapshot.inputKind, "no-mic"); assert.equal(snapshot.inputId, inputId);
    assert.deepEqual(f.starts.at(-1), { visualizer, inputId });
    f.advance(10500); f.service.sweep(); await f.service.serial;
    assert.equal(f.service.state, "running");
  }
  assert.equal(microphoneChecks, 0);
  await assert.rejects(f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: "generator:unknown", inputKind: "no-mic" }), /available/);
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.ok(f.children.every(child => child.killed));
});
test("no-mic inputs are product-specific and changing to a microphone restores device checks", async t => {
  const f = fixture({ staleMs: 30000, native: {
    inspect: async () => ({ visualizers: ["aeon", "g-force"].map(id => ({ id, available: true })), inputs: [{ id: "mic", name: "PC microphone" }],
      noMicInputs: { aeon: [{ id: "generator:chill", name: "Chill", kind: "no-mic" }] } }),
    listAudioInputs: async () => []
  } }); t.after(() => f.service.close());
  await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "generator:chill" }), /available/);
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "generator:chill" }); await f.service.serial;
  f.children.at(-1).stdout.write(JPEG);
  assert.equal(f.service.snapshot(A).inputKind, "no-mic");
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic", inputKind: "no-mic" }); await f.service.serial;
  f.children.at(-1).stdout.write(JPEG);
  assert.equal(f.service.snapshot(A).inputKind, "microphone");
  f.advance(10500); f.service.sweep(); await f.service.inputCheck; await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /microphone disconnected/);
});
test("same-origin JSON controls reject cross-site requests and forged LAN TLS forwarding", async () => {
  let calls = 0; const payloads = [];
  const service = { status: async () => { calls++; return { state: "idle" }; }, session: async () => { calls++; return { state: "starting" }; }, snapshot: () => ({ state: "idle" }) };
  const api = createSoundSpectrumApi({ service, readJson: async () => ({ action: "start" }), sendJson: (_res, code, body) => payloads.push({ code, body }) });
  const url = new URL("http://player.example/api/soundspectrum/session");
  const req = { method: "POST", headers: { origin: "https://player.example", "content-type": "application/json", "x-forwarded-proto": "https" }, socket: { remoteAddress: "192.168.50.10" } };
  await api.handle(req, new Response(), url); assert.equal(payloads.at(-1).code, 403); assert.equal(calls, 0);
  req.socket.remoteAddress = "127.0.0.1"; await api.handle(req, new Response(), url); assert.equal(payloads.at(-1).code, 202);
  req.headers["content-type"] = "text/plain"; await api.handle(req, new Response(), url); assert.equal(payloads.at(-1).code, 415);
  req.headers["sec-fetch-site"] = "cross-site"; await api.handle(req, new Response(), url); assert.equal(payloads.at(-1).code, 403);
});

test("joining an exact running generation never enumerates, starts or switches native visuals", async t => {
  const f = musicFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG); const generation = f.service.generation;
  f.service.native.inspect = async () => { throw Error("Join must not enumerate devices"); };
  const selection = { action: "join", viewerId: B, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER, generation };
  const joined = await f.service.session(selection);
  assert.equal(joined.viewerActive, true); assert.equal(joined.generation, generation); assert.equal(f.starts.length, 1);
  for (const change of [{ generation: generation - 1 }, { visualizer: "whitecap" }, { playerId: "11:22:33:44:55:66" }, { inputId: "mic" }]) {
    await assert.rejects(f.service.session({ ...selection, ...change }), /selection changed/);
  }
  await f.service.session({ action: "stop", viewerId: B });
  assert.equal(f.service.snapshot(A).viewerActive, true); assert.equal(f.children[0].killed, undefined);
  f.advance(13000);
  await assert.rejects(f.service.session(selection), /selection changed/);
});

test("video authorization enforces the exact lease and optional generation without starting visuals", async t => {
  const f = fixture(); t.after(() => f.service.close());
  assert.throws(() => f.service.authorizeVideo(A), /Start visuals/);
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  assert.deepEqual(f.service.authorizeVideo(A, f.service.generation), { frame: JPEG, capturedAt: 1000, generation: f.service.generation });
  assert.throws(() => f.service.authorizeVideo(A, f.service.generation - 1), /selection changed/);
  assert.throws(() => f.service.authorizeVideo(B), /Start visuals/);
  f.advance(13000); assert.throws(() => f.service.authorizeVideo(A), /Start visuals/);
  assert.equal(f.starts.length, 1);
});

test("a 30-frame pipe catch-up presents only the newest complete JPEG to observers and MJPEG", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const events = []; const unsubscribe = f.service.onVideo(event => events.push(event)); t.after(unsubscribe);
  f.service.onVideo(() => { throw Error("A failing observer must not stop capture"); });
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  const res = new Response(); f.service.video({}, res, A);
  const frames = Array.from({ length: 30 }, (_, value) => Buffer.from([0xff, 0xd8, value, 0xff, 0xd9]));
  f.children[0].stdout.write(Buffer.concat(frames));
  const frameEvents = events.filter(event => event.type === "frame");
  assert.equal(frameEvents.length, 1); assert.deepEqual(frameEvents[0].frame, frames[29]);
  assert.equal(res.chunks.length, 1); assert.ok(res.chunks[0].includes(frames[29]));
  assert.equal(f.service.snapshot().videoStats.captureFrames, 30); assert.equal(f.service.snapshot().videoStats.coalescedFrames, 29);
  assert.ok(events.some(event => event.type === "state" && event.state === "starting"));
  unsubscribe(); f.children[0].stdout.write(JPEG);
  assert.equal(events.filter(event => event.type === "frame").length, 1);
  assert.equal(f.service.state, "running");
});

test("a blocked MJPEG viewer holds one latest packet and presents it immediately on drain", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  await f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const slow = new Response(), fast = new Response(); slow.block = true;
  f.service.video({}, slow, A); f.service.video({}, fast, B);
  assert.equal(slow.chunks[0], fast.chunks[0], "viewers share the same multipart allocation");
  const frames = Array.from({ length: 30 }, (_, value) => Buffer.from([0xff, 0xd8, value, 0xff, 0xd9]));
  for (const frame of frames) f.children[0].stdout.write(frame);
  const client = [...f.service.clients].find(value => value.viewerId === A);
  assert.equal(slow.chunks.length, 1); assert.equal(fast.chunks.length, 31);
  assert.equal(client.pending.packet, fast.chunks.at(-1)); assert.equal(f.service.snapshot().videoStats.mjpegDroppedFrames, 29);
  slow.block = false; slow.emit("drain");
  assert.equal(slow.chunks.length, 2); assert.equal(slow.chunks[1], fast.chunks.at(-1)); assert.equal(client.pending, null);
});

test("changing generation clears a blocked viewer's stale pending frame before drain", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "mic" }); await f.service.serial;
  f.children[0].stdout.write(JPEG); const res = new Response(); res.block = true; f.service.video({}, res, A);
  f.children[0].stdout.write(JPEG);
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: "mic" }); await f.service.serial;
  res.block = false; res.emit("drain"); assert.equal(res.chunks.length, 1);
  f.children.at(-1).stdout.write(JPEG); assert.equal(res.chunks.length, 2);
});

test("fragmented JPEG assembly retains complete markers and rejects oversized frames", () => {
  const frames = [], parser = new JpegFrames(frame => frames.push(frame));
  const large = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(128 * 1024, 7), Buffer.from([0xff, 0xd9])]);
  parser.push(Buffer.from([1, 2, 0xff])); parser.push(large.subarray(1, 111));
  for (let offset = 111; offset < large.length; offset += 257) parser.push(large.subarray(offset, offset + 257));
  assert.deepEqual(frames, [large]); assert.equal(parser.buffer.length, 0);
  parser.push(Buffer.from([0xff, 0xd8]));
  assert.throws(() => parser.push(Buffer.alloc(2 * 1024 * 1024, 1)), /oversized/);
});

test("video transport attaches once and exposes its preference without starting any renderer", async t => {
  const f = fixture(), server = new EventEmitter(); t.after(() => f.service.close());
  const api = createSoundSpectrumApi({ service: f.service, readJson: async () => ({}), sendJson: () => {} });
  const adapter = api.attachVideoTransport(server); t.after(() => adapter.close());
  assert.equal(api.attachVideoTransport(server), adapter); assert.equal(server.listenerCount("upgrade"), 1);
  assert.equal(f.service.snapshot().videoTransport, "websocket-ack-jpeg"); assert.equal(f.starts.length, 0);
});

test("Roon HQPlayer viewers share one canonical analysis feed and exact zone", async t => {
  const f = dualFeedFixture(); t.after(() => f.service.close());
  const inventory = await f.service.status();
  assert.deepEqual(inventory.musicInputs.map(input => input.source), ["lyrion", "roon-hqplayer"]);
  assert.equal(f.calls.length, 0, "inspection never starts or stops feeds");
  const selection = { action: "start", viewerId: A, visualizer: "whitecap", inputId: HQP_MUSIC, zoneId: HQP_ZONE, source: "lyrion", inputKind: "microphone" };
  await f.service.session(selection); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const generation = f.service.generation;
  await f.service.session({ ...selection, viewerId: B }); await f.service.serial;
  assert.equal(f.calls.filter(call => call.action === "start").length, 1);
  const call = f.calls.find(value => value.action === "start");
  assert.equal(call.id, HQP_MUSIC); assert.equal(call.selection.zoneId, HQP_ZONE); assert.equal(call.selection.playerId, undefined);
  assert.equal(f.starts.length, 1); assert.equal(f.service.generation, generation);
  const snapshot = f.service.snapshot(B);
  assert.equal(snapshot.inputSource, "roon-hqplayer"); assert.equal(snapshot.zoneId, HQP_ZONE); assert.equal(snapshot.playerId, ""); assert.equal(snapshot.audioFeed.id, HQP_MUSIC);
  await f.service.session({ action: "stop", viewerId: A });
  assert.equal(f.children[0].killed, undefined);
  await f.service.session({ action: "stop", viewerId: B }); await f.service.serial;
  assert.equal(f.children[0].killed, true);
});

function hqpTransitionFixture() {
  let state = "receiving";
  const f = dualFeedFixture({ hqp: { snapshot: () => ({
    id: HQP_MUSIC, state, source: "roon-hqplayer", zoneId: HQP_ZONE,
    reason: state === "waiting" ? "Waiting briefly for the same HQPlayer zone to resume." : "Fresh HQPlayer analysis is receiving."
  }) } });
  return { ...f, setFeedState: value => { state = value; } };
}

test("HQPlayer track-transition waiting preserves the leased renderer, video stream and feed", async t => {
  const f = hqpTransitionFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "whitecap", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  const capture = f.children[0]; capture.stdout.write(JPEG);
  const generation = f.service.generation;
  await f.service.session({ action: "join", viewerId: B, visualizer: "whitecap", inputId: HQP_MUSIC, zoneId: HQP_ZONE, generation });
  const video = new Response(); f.service.video({}, video, A);
  const startCount = f.calls.filter(call => call.action === "start").length, stopCount = f.calls.filter(call => call.action === "stop").length;
  for (const state of ["waiting", "waiting", "receiving"]) {
    f.setFeedState(state); f.advance(4000); capture.stdout.write(JPEG);
    for (const viewerId of [A, B]) {
      const heartbeat = await f.service.session({ action: "heartbeat", viewerId });
      assert.equal(heartbeat.viewerActive, true); assert.equal(heartbeat.generation, generation);
      assert.equal(heartbeat.state, "running"); assert.equal(heartbeat.audioFeed.state, state);
      assert.equal(heartbeat.inputId, HQP_MUSIC); assert.equal(heartbeat.zoneId, HQP_ZONE); assert.equal(heartbeat.error, "");
    }
    f.service.sweep(); await f.service.serial;
    const status = await f.service.status(A);
    assert.equal(status.audioFeed.state, state); assert.equal(status.clients, 2);
    assert.equal(status.generation, generation); assert.equal(status.viewerActive, true);
    assert.deepEqual(f.service.authorizeVideo(A, generation).frame, JPEG);
  }
  assert.equal(f.starts.length, 1); assert.equal(f.children.length, 1); assert.equal(capture.killed, undefined);
  assert.equal(f.calls.filter(call => call.action === "start").length, startCount);
  assert.equal(f.calls.filter(call => call.action === "stop").length, stopCount);
  assert.equal(video.destroyed, undefined); assert.equal(video.chunks.length, 4);
});

test("Stop and hidden-view lease release cancel HQPlayer waiting without a late restart", async t => {
  const f = hqpTransitionFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  const capture = f.children[0]; capture.stdout.write(JPEG);
  const generation = f.service.generation, lateFailure = f.failures.get(HQP_MUSIC);
  await f.service.session({ action: "join", viewerId: B, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE, generation });
  f.setFeedState("waiting");
  const videoA = new Response(), videoB = new Response(); f.service.video({}, videoA, A); f.service.video({}, videoB, B);
  const replies = [], api = createSoundSpectrumApi({ service: f.service, readJson: async req => req.body,
    sendJson: (_res, code, body) => replies.push({ code, body }) });
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: { action: "stop", viewerId: A } };
  const url = new URL("http://localhost/api/soundspectrum/session");
  // Hiding a view sends the same stop action as its explicit Stop control.
  await api.handle(request, new Response(), url); await f.service.serial;
  assert.equal(replies.at(-1).code, 200); assert.equal(videoA.destroyed, true);
  assert.equal(f.service.snapshot(B).viewerActive, true); assert.equal(capture.killed, undefined);
  request.body.viewerId = B;
  await api.handle(request, new Response(), url); await f.service.serial;
  const stoppedGeneration = f.service.generation;
  assert.equal(replies.at(-1).body.state, "idle"); assert.ok(stoppedGeneration > generation);
  assert.equal(f.service.leases.size, 0); assert.equal(capture.killed, true); assert.equal(videoB.destroyed, true);
  f.setFeedState("receiving"); capture.stdout.write(JPEG); lateFailure(Error("Retired waiting session failed")); await f.service.serial;
  assert.equal((await f.service.status(B)).state, "idle"); assert.equal(f.service.generation, stoppedGeneration);
  await assert.rejects(f.service.session({ action: "heartbeat", viewerId: B }), /stopped/);
  assert.throws(() => f.service.authorizeVideo(B), /Start visuals/);
  assert.equal(f.starts.length, 1); assert.equal(f.children.length, 1);
  assert.equal(f.calls.filter(call => call.action === "start").length, 1);
});

test("expired viewer leases make HQPlayer waiting final even if old analysis resumes", async t => {
  const f = hqpTransitionFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  const capture = f.children[0]; capture.stdout.write(JPEG);
  const generation = f.service.generation, lateFailure = f.failures.get(HQP_MUSIC);
  const video = new Response(); f.service.video({}, video, A); f.setFeedState("waiting");
  f.advance(12000); f.service.sweep(); await f.service.serial;
  const expiredGeneration = f.service.generation;
  assert.ok(expiredGeneration > generation); assert.equal(f.service.state, "idle"); assert.equal(f.service.leases.size, 0);
  assert.equal(capture.killed, true); assert.equal(video.destroyed, true);
  f.setFeedState("receiving"); capture.stdout.write(JPEG); lateFailure(Error("Expired waiting session failed")); await f.service.serial;
  assert.equal((await f.service.status(A)).state, "idle"); assert.equal(f.service.generation, expiredGeneration);
  await assert.rejects(f.service.session({ action: "heartbeat", viewerId: A }), /stopped/);
  assert.equal(f.starts.length, 1); assert.equal(f.children.length, 1);
  assert.equal(f.calls.filter(call => call.action === "start").length, 1);
});

test("switching sources during HQPlayer waiting cancels its generation and ignores late recovery", async t => {
  const f = hqpTransitionFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  const retiredCapture = f.children[0]; retiredCapture.stdout.write(JPEG);
  const generation = f.service.generation, lateFailure = f.failures.get(HQP_MUSIC);
  await f.service.session({ action: "join", viewerId: B, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE, generation });
  f.setFeedState("waiting");
  await f.service.session({ action: "start", viewerId: A, visualizer: "whitecap", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  const switchedGeneration = f.service.generation;
  assert.ok(switchedGeneration > generation); assert.equal(retiredCapture.killed, true);
  f.setFeedState("receiving"); retiredCapture.stdout.write(JPEG); lateFailure(Error("Retired HQPlayer transition failed")); await f.service.serial;
  assert.equal(f.service.state, "starting"); assert.equal(f.service.latest, null);
  const activeCapture = f.children[1]; activeCapture.stdout.write(JPEG);
  const heartbeat = await f.service.session({ action: "heartbeat", viewerId: B });
  assert.equal(heartbeat.generation, switchedGeneration); assert.equal(heartbeat.state, "running"); assert.equal(heartbeat.viewerActive, true);
  assert.equal(heartbeat.inputId, MUSIC); assert.equal(heartbeat.inputSource, "lyrion"); assert.equal(heartbeat.playerId, PLAYER); assert.equal(heartbeat.zoneId, "");
  assert.equal(activeCapture.killed, undefined); assert.equal(f.starts.length, 2); assert.equal(f.children.length, 2);
  assert.deepEqual(f.calls.filter(call => call.action === "start").map(call => call.id), [HQP_MUSIC, MUSIC]);
});

test("invalid HQPlayer source requests preserve another viewer's active Lyrion visualizer", async t => {
  const f = dualFeedFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const generation = f.service.generation, starts = f.calls.filter(call => call.action === "start").length, stops = f.calls.filter(call => call.action === "stop").length;
  for (const change of [{ zoneId: undefined }, { zoneId: "HQPlayer" }, { playerId: PLAYER }, { zoneId: "1601ffffffffffffffffffffffffffff" }, { inputId: "feed:invented", inputKind: "music-feed", playerId: PLAYER }]) {
    await assert.rejects(f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE, ...change }), /configured|Configured|available/);
  }
  assert.equal(f.service.generation, generation); assert.equal(f.service.state, "running"); assert.equal(f.service.inputSource, "lyrion");
  assert.equal(f.service.snapshot(A).viewerActive, true); assert.equal(f.service.snapshot(B).viewerActive, false); assert.equal(f.children[0].killed, undefined);
  assert.equal(f.calls.filter(call => call.action === "start").length, starts);
  assert.equal(f.calls.filter(call => call.action === "stop").length, stops);
});

test("unavailable analysis feed and cross-source player fields cannot launch a writer", async t => {
  const f = dualFeedFixture({ hqp: { available: false, reason: "Analysis feed disabled" } }); t.after(() => f.service.close());
  await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE }), /disabled/);
  await assert.rejects(f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER, zoneId: HQP_ZONE }), /Lyrion player/);
  assert.equal(f.calls.length, 0); assert.equal(f.starts.length, 0); assert.equal(f.service.leases.size, 0);
});

test("joining an analysis viewer requires its exact zone and never starts another feed", async t => {
  const f = dualFeedFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "g-force", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const selection = { action: "join", viewerId: B, visualizer: "g-force", inputId: HQP_MUSIC, zoneId: HQP_ZONE, generation: f.service.generation };
  const calls = f.calls.length;
  for (const change of [{ zoneId: "1601ffffffffffffffffffffffffffff" }, { zoneId: undefined }, { playerId: PLAYER }, { inputId: MUSIC }]) {
    await assert.rejects(f.service.session({ ...selection, ...change }), /selection changed/);
  }
  assert.equal(f.service.snapshot(B).viewerActive, false);
  assert.equal((await f.service.session(selection)).viewerActive, true);
  assert.equal(f.calls.length, calls); assert.equal(f.starts.length, 1);
});

test("switching sources preserves exact identity and ignores the old adapter's delayed failure", async t => {
  const f = dualFeedFixture(); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG);
  const staleFailure = f.failures.get(MUSIC), oldCapture = f.children[0];
  await f.service.session({ action: "start", viewerId: A, visualizer: "whitecap", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  f.children.at(-1).stdout.write(JPEG);
  staleFailure(Error("Old Lyrion copy failed")); await f.service.serial;
  assert.equal(oldCapture.killed, true); assert.equal(f.service.state, "running"); assert.equal(f.service.inputSource, "roon-hqplayer"); assert.equal(f.service.playerId, ""); assert.equal(f.service.zoneId, HQP_ZONE);
  assert.equal(f.children.at(-1).killed, undefined);
  const recent = f.calls.slice(f.calls.findLastIndex(call => call.action === "start" && call.id === MUSIC) + 1);
  const hqpStart = recent.findIndex(call => call.action === "start" && call.id === HQP_MUSIC);
  assert.ok(recent.slice(0, hqpStart).some(call => call.action === "stop" && call.id === MUSIC));
  assert.ok(recent.slice(0, hqpStart).some(call => call.action === "stop" && call.id === HQP_MUSIC));
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: "generator:fluid", zoneId: HQP_ZONE, playerId: PLAYER }); await f.service.serial;
  assert.equal(f.service.inputSource, ""); assert.equal(f.service.zoneId, ""); assert.equal(f.service.playerId, "");
  assert.equal(f.calls.filter(call => call.action === "start").length, 2);
});

test("stop cancels analysis selection during zone validation without disrupting current Lyrion visuals", async t => {
  let finish;
  const f = dualFeedFixture({ hqp: { validateStart: () => new Promise(resolve => { finish = resolve; }) } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: MUSIC, playerId: PLAYER }); await f.service.serial;
  f.children[0].stdout.write(JPEG); const generation = f.service.generation;
  const start = f.service.session({ action: "start", viewerId: B, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: B }); finish(); await assert.rejects(start, /cancelled/);
  assert.equal(f.service.generation, generation); assert.equal(f.service.snapshot(A).viewerActive, true); assert.equal(f.children[0].killed, undefined);
  assert.equal(f.calls.some(call => call.action === "start" && call.id === HQP_MUSIC), false);
});

test("stop during a pending HQPlayer feed launch prevents native/capture startup", async t => {
  let finish;
  const f = dualFeedFixture({ hqp: { start: () => new Promise(resolve => { finish = resolve; }) } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.service.session({ action: "stop", viewerId: A }); finish(); await f.service.serial;
  assert.equal(f.starts.length, 0); assert.equal(f.children.length, 0); assert.equal(f.service.state, "idle");
  assert.ok(f.calls.filter(call => call.action === "stop" && call.id === HQP_MUSIC).length >= 2);
});

test("feed cleanup failure still closes capture, every adapter and native renderer", async t => {
  for (const synchronous of [true, false]) {
    const calls = [];
    const audioFeed = { stop: () => { calls.push("adapter"); if (synchronous) throw Error("Cleanup failed"); return Promise.reject(Error("Cleanup failed")); }, snapshot: () => ({ state: "error" }) };
    const f = fixture({ audioFeed, native: { stop: async () => calls.push("native") } }); t.after(() => f.service.close());
    await assert.rejects(f.service.stopOwned(), /Cleanup failed/);
    assert.deepEqual(calls, ["adapter", "native"]);
  }
  let fail = false; const calls = [];
  const f = dualFeedFixture({ lyrion: { stop: () => { calls.push("lyrion"); if (fail) throw Error("Lyrion writer cleanup failed"); } }, hqp: { stop: () => calls.push("hqp") }, native: { stop: () => calls.push("native") } }); t.after(() => f.service.close());
  await f.service.session({ action: "start", viewerId: A, visualizer: "aeon", inputId: HQP_MUSIC, zoneId: HQP_ZONE }); await f.service.serial;
  f.children[0].stdout.write(JPEG); fail = true; calls.length = 0;
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.children[0].killed, true); assert.equal(f.service.state, "error"); assert.match(f.service.error, /cleanup failed/);
  assert.deepEqual(new Set(calls), new Set(["lyrion", "hqp", "native"])); assert.equal(f.service.leases.size, 0);
});
