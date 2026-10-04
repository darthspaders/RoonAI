"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { SoundSpectrum, JpegFrames, createSoundSpectrumApi } = require("../src/soundSpectrum");
const { createFeedMux } = require("../src/soundSpectrumFeeds");
const A = "viewer_A_12345678901234567890", B = "viewer_B_12345678901234567890";
const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const MUSIC = "feed:pre-hqplayer", PLAYER = "aa:bb:cc:dd:ee:ff";
const HQP_MUSIC = "feed:hqplayer-analysis", HQP_ZONE = "1601d935088f5a8521851f0b72f30228de66";
function dualFeedFixture(options = {}) {
  const calls = [], failures = new Map();
  const entries = [MUSIC, HQP_MUSIC].map(id => {
    const overrides = id === HQP_MUSIC ? options.hqp || {} : options.lyrion || {};
    return { id, integration: {
      audioFeed: {
        inspect: async () => ({ id, kind: "music-feed", source: "untrusted-adapter-label", available: overrides.available !== false, reason: overrides.reason || "" }),
        snapshot: () => ({ state: "waiting", id }),
        validateStart: async selection => { calls.push({ action: "validate", id, selection }); if (overrides.validateStart) return overrides.validateStart(selection); if (id === HQP_MUSIC && selection.zoneId !== HQP_ZONE) throw Error("Configured HQPlayer zone changed"); },
        start: async selection => { calls.push({ action: "start", id, selection }); failures.set(id, selection.onFailure); await overrides.start?.(selection); },
        stop: async () => { calls.push({ action: "stop", id }); await overrides.stop?.(); }
      },
      additionalInputProvider: { list: async () => [{ id, kind: "music-feed" }], resolve: async () => null }
    } };
  });
  const { audioFeed } = createFeedMux(entries);
  const f = fixture({ audioFeed, native: {
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
  const service = new SoundSpectrum({ native, capture, clock: () => now, sweepMs: 0, spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit("close", 0); }; children.push(child); return child;
  }, ...options, native, capture });
  return { service, starts, children, get stops() { return stops; }, advance: ms => { now += ms; } };
}
class Response extends EventEmitter {
  constructor() { super(); this.headers = {}; this.chunks = []; this.writableLength = 0; this.block = false; }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); }
  write(chunk) { this.chunks.push(chunk); return !this.block; }
  destroy() { this.destroyed = true; this.emit("close"); }
}
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
