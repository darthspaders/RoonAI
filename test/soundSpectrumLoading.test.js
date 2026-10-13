"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { SoundSpectrum } = require("../src/soundSpectrum");
const { createHQPlayerZoneGuard, createFeedMux } = require("../src/soundSpectrumFeeds");
const { HqplayerFeed, INPUT } = require("../integrations/soundspectrum-hqplayer-feed/index.cjs");
const { toneFrame } = require("../integrations/soundspectrum-hqplayer-feed/fixtures.cjs");

const ZONE = "1601aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OUTPUT = "1701bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VIEWERS = ["loading_viewer_A_123456789012345", "loading_viewer_B_123456789012345"];
const SDP = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n";
const PROFILE = { id: "4k60", width: 3840, height: 2160, targetFps: 60,
  targetBitrateMbps: 80, nativeWindowMode: "borderless-fullscreen" };
const turn = () => new Promise(resolve => setImmediate(resolve));

class FakeStream extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writableLength = 0; this.writableNeedDrain = false; this.writes = []; }
  write(bytes, callback) { assert.equal(this.destroyed, false); this.writes.push(Buffer.from(bytes)); queueMicrotask(() => callback?.()); return true; }
  destroy() { this.destroyed = true; }
}
class FakeChild extends EventEmitter {
  constructor(worker) {
    super(); this.worker = worker; this.exitCode = null; this.signalCode = null; this.connected = worker;
    // No PID: lowerPriority must never target a real process during this test.
    this.stdin = new FakeStream(); this.stderr = new FakeStream(); this.messages = []; this.kills = 0;
  }
  send(message, callback) { this.messages.push(message); callback?.(); if (message.type === "close") this.kill(); return true; }
  kill() { if (this.exitCode !== null) return; this.kills++; this.connected = false; this.exitCode = 0; queueMicrotask(() => this.emit("close", 0)); }
}
class FakeSocket extends EventEmitter {
  constructor(options) { super(); this.options = options; this.destroyed = false; }
  setNoDelay() {} setTimeout(ms) { this.timeout = ms; }
  write() { throw Error("The analysis connection must stay receive-only."); }
  destroy() { if (this.destroyed) return; this.destroyed = true; queueMicrotask(() => this.emit("close")); }
}

test("the real Roon guard and analysis feed keep one OBS session through loading and require fresh analysis to resume", async t => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "rabbit-hole-loading-"));
  const settingsPath = path.join(directory, "settings.json");
  const settings = { version: 1, enabled: true, zoneId: ZONE, outputId: OUTPUT, route: { fingerprint: "a".repeat(64) } };
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  let now = 1000, zoneState = "loading", nativeRunning = false;
  const children = [], sockets = [], diagnostics = [], calls = [], readers = new Map();
  const requireZone = createHQPlayerZoneGuard(() => ({ connected: true,
    zones: [{ zone_id: ZONE, state: zoneState, outputs: [{ output_id: OUTPUT }] }] }));
  const output = {
    probeOutput: async () => ({ available: true }), validateOutput: async () => ({ available: true }),
    buildOutputCommand: () => ({ command: "fake-visualizer-output", args: [] })
  };
  const feed = new HqplayerFeed({ settingsPath, requireZone, output, timers: false, clock: () => now, paceClock: () => now,
    spawnImpl: (command, args) => {
      const child = new FakeChild(args.some(value => /dsp-worker/.test(value))); children.push(child);
      if (child.worker) queueMicrotask(() => child.emit("message", { type: "ready" }));
      return child;
    }, socketFactory: options => { const socket = new FakeSocket(options); sockets.push(socket); return socket; } });
  const { audioFeed } = createFeedMux([{ id: INPUT, integration: { audioFeed: feed, additionalInputProvider: {} } }]);
  const window = { pid: 123, windowHandle: "1234", width: PROFILE.width, height: PROFILE.height };
  const native = {
    inspect: async () => ({ visualizers: [{ id: "aeon", available: true }], inputs: [],
      musicInputs: [{ id: INPUT, kind: "music-feed", available: true }], noMicInputs: {} }),
    start: async selection => { calls.push({ action: "native-start", selection }); nativeRunning = true; return window; },
    stop: async () => { calls.push({ action: "native-stop" }); nativeRunning = false; },
    status: () => ({ state: nativeRunning ? "running" : "stopped", owned: nativeRunning, pid: nativeRunning ? window.pid : null }),
    captureWindow: async () => window
  };
  const obsTransport = {
    inspect: async () => ({ available: true, profile: PROFILE }),
    start: async params => { calls.push({ action: "obs-start", params }); params.onReady(); },
    stop: async () => { calls.push({ action: "obs-stop" }); readers.clear(); },
    releaseViewer: async ({ viewerId }) => { calls.push({ action: "reader-stop", viewerId }); readers.delete(viewerId); },
    signal: async params => {
      assert.equal(params.method, "POST"); const sessionId = "loading_reader_" + (readers.size + 1) + "_12345678901234567890";
      readers.set(params.viewerId, sessionId); calls.push({ action: "reader-start", viewerId: params.viewerId });
      return { status: 201, sessionId, body: SDP };
    }
  };
  const service = new SoundSpectrum({ native, audioFeed, obsTransport, clock: () => now, sweepMs: 0,
    capture: { probeCaptureRuntime: async () => ({ available: false }) },
    spawnImpl: () => { throw Error("OBS must not start a JPEG capture child."); }, onDiagnostic: entry => diagnostics.push(entry) });
  t.after(async () => {
    try { await service.close(); await feed.stop(); }
    finally {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith("rabbit-hole-loading-"));
      await fs.rm(resolved, { recursive: true, force: true });
    }
  });
  const selection = { visualizer: "aeon", inputId: INPUT, zoneId: ZONE, transport: "obs-webrtc" };
  await assert.rejects(service.session({ action: "start", viewerId: VIEWERS[0], ...selection }), /Play music/);
  assert.equal(children.length, 0); assert.equal(sockets.length, 0); assert.equal(service.leases.size, 0);

  zoneState = "playing";
  await service.session({ action: "start", viewerId: VIEWERS[0], ...selection }); await service.serial; await turn();
  const generation = service.generation, ownerToken = feed.ownerToken, writer = feed.writer, worker = feed.worker;
  const ownerBytes = await fs.readFile(feed.ownerPath), obsSession = service.obsSession;
  await service.session({ action: "join", viewerId: VIEWERS[1], generation, ...selection });
  for (const viewerId of VIEWERS) await service.signalWebRTC({ method: "POST", viewerId, generation, body: SDP });
  const originalReaders = [...readers];
  const startupCalls = calls.filter(call => /start$/.test(call.action)).length;
  const stopCalls = calls.filter(call => /stop$/.test(call.action)).length;
  function complete(pcm) {
    const work = feed.inflight; assert.ok(work, "a real protocol frame reached the mocked worker");
    worker.emit("message", { type: "pcm", epoch: feed.epoch, sequence: work.sequence, pcm, resets: 0 });
  }
  sockets[0].emit("data", toneFrame()); complete(Buffer.alloc(4096, 7));
  assert.equal(feed.state, "receiving");
  sockets[0].emit("data", toneFrame()); const staleSequence = feed.inflight.sequence;
  zoneState = "loading"; now += 4000; await feed.checkSafety();
  assert.equal(feed.state, "waiting"); assert.equal(feed.pcmSize, 0); assert.equal(feed.zonePlaybackState, "loading");
  const deadlineOrigin = feed.zoneTransitionAt;
  worker.emit("message", { type: "pcm", epoch: feed.epoch, sequence: staleSequence, pcm: Buffer.alloc(4096, 9), resets: 0 });
  assert.equal(feed.pcmSize, 0, "retired work cannot restore pre-boundary audio");
  sockets[0].emit("data", toneFrame()); complete(Buffer.alloc(4096, 11));
  assert.equal(feed.pcmSize, 0, "analysis received during loading is not playable");
  now += 20; feed.tick(); await turn();
  assert.ok(writer.stdin.writes.length > 0); assert.ok(writer.stdin.writes.at(-1).every(byte => byte === 0));

  async function remainsSameSession() {
    for (const viewerId of VIEWERS) {
      const status = await service.session({ action: "heartbeat", viewerId });
      assert.equal(status.state, "running"); assert.equal(status.generation, generation);
      assert.equal(status.viewerActive, true); assert.equal(status.zoneId, ZONE);
    }
    service.sweep(); await service.serial;
    assert.equal(service.obsSession, obsSession); assert.equal(service.captureWindow, window);
    assert.equal(feed.ownerToken, ownerToken); assert.equal(feed.writer, writer); assert.equal(feed.worker, worker);
    assert.deepEqual(await fs.readFile(feed.ownerPath), ownerBytes); assert.deepEqual([...readers], originalReaders);
    assert.equal(children.length, 2); assert.equal(sockets.length, 1); assert.ok(children.every(child => child.exitCode === null));
    assert.equal(calls.filter(call => /start$/.test(call.action)).length, startupCalls);
    assert.equal(calls.filter(call => /stop$/.test(call.action)).length, stopCalls);
    assert.equal(diagnostics.some(entry => entry.event === "session-failure"), false);
  }
  await remainsSameSession();
  zoneState = "playing"; now += 4000; await feed.checkSafety();
  assert.equal(feed.state, "waiting"); assert.equal(feed.zoneTransitionAt, deadlineOrigin);
  assert.equal(feed.pcmSize, 0, "playing alone must not replay stale audio");
  await remainsSameSession();
  sockets[0].emit("data", toneFrame()); complete(Buffer.alloc(4096, 13));
  assert.equal(feed.state, "receiving"); assert.equal(feed.zoneTransitionAt, null); assert.equal(feed.pcmSize, 4096);
  await remainsSameSession();

  // A truly unverified state remains terminal and cannot leak arbitrary state
  // text into the private failure diagnostic added for this regression.
  const untrustedState = "unknown-with-private-source-url";
  zoneState = untrustedState; now += 1000; await feed.checkSafety();
  await feed.failureCleanup; await turn(); await service.serial;
  assert.equal(service.state, "error"); assert.equal(service.leases.size, 0); assert.ok(service.generation > generation);
  assert.equal(nativeRunning, false); assert.equal(readers.size, 0); assert.ok(children.every(child => child.exitCode === 0));
  await assert.rejects(fs.access(feed.ownerPath), { code: "ENOENT" });
  const failure = diagnostics.find(entry => entry.event === "session-failure");
  assert.ok(failure); assert.equal(failure.zoneState, "unknown"); assert.equal(JSON.stringify(failure).includes(untrustedState), false);
});

test("session failure diagnostics retain only the bounded zone-state enum", async t => {
  for (const [zoneState, expected] of [["loading", "loading"], ["unknown", "unknown"],
    ["private-token-in-untrusted-zone-state", null], [{ privateToken: "must-not-be-logged" }, null]]) {
    const diagnostics = [];
    const service = new SoundSpectrum({ native: { stop: async () => {} }, capture: {}, sweepMs: 0,
      onDiagnostic: entry => diagnostics.push(entry) });
    t.after(() => service.close());
    service.fail(service.generation, Object.assign(Error("Expected test failure"), { zoneState }));
    await service.serial;
    const failure = diagnostics.find(entry => entry.event === "session-failure");
    assert.ok(failure); assert.equal(failure.zoneState, expected);
    assert.equal(JSON.stringify(failure).includes("private-token"), false);
    assert.equal(JSON.stringify(failure).includes("must-not-be-logged"), false);
  }
});
