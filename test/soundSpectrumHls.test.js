"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events"), { PassThrough, Readable, Writable } = require("node:stream");
const { SoundSpectrum, createSoundSpectrumApi } = require("../src/soundSpectrum");
const { SoundSpectrumDelay } = require("../src/soundSpectrumDelay");
const A = "hls_viewer_A_123456789012345", B = "hls_viewer_B_123456789012345";
const selection = { action: "start", viewerId: A, visualizer: "whitecap", inputId: "mic", transport: "hls" };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  let now = 1000, selected, running = false;
  const calls = [], window = { pid: 123, windowHandle: "1234", width: 3840, height: 2160 };
  const hlsTransport = { inspect: async () => ({ available: true }),
    start: async value => { selected = value; calls.push({ hlsStart: value.profile }); value.onReady(); },
    stop: async () => { calls.push("hls-stop"); }, snapshot: () => ({ privatePath: "SECRET" }),
    readAsset: async name => ({ statusCode: 200, contentType: "ignored", headers: {},
      body: Buffer.from("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-PART:DURATION=0.2,URI=\"part_1.mp4\"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"part_2.mp4\"\nsegment_1.m4s\n") }),
    ...overrides.hlsTransport };
  const native = { inspect: async () => ({ visualizers: [{ id: "whitecap", available: true }], inputs: [{ id: "mic" }] }),
    start: async value => { running = true; calls.push({ nativeStart: value }); return { ...window }; },
    captureWindow: async () => ({ ...window }), captureIdentity: () => ({ ...window, owned: true }),
    status: () => ({ state: running ? "running" : "stopped", owned: running, pid: 123 }),
    stop: async () => { calls.push("native-stop"); running = false; }, ...overrides.native };
  const capture = { probeCaptureRuntime: async () => ({ available: true }), buildCaptureCommand: () => { throw Error("HLS must not launch JPEG"); } };
  const service = new SoundSpectrum({ native, capture, hlsTransport, clock: () => now, sweepMs: 0, onDiagnostic: () => {}, ...overrides, native, capture, hlsTransport });
  return { service, calls, hlsTransport, native, get selected() { return selected; }, advance: ms => now += ms };
}
async function start(t, overrides = {}, request = {}) {
  const f = fixture(overrides); t.after(() => f.service.close());
  await f.service.session({ ...selection, ...request }); await f.service.serial; return f;
}
async function http(f, name = "index.m3u8", options = {}) {
  const req = new EventEmitter(); req.method = options.method || "GET"; req.headers = options.headers || {};
  const res = new PassThrough(), chunks = [];
  res.headers = {}; res.setHeader = (key, value) => { res.headers[key] = value; };
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers); };
  res.on("data", value => chunks.push(value)); res.on("error", () => {});
  const url = new URL(`http://localhost:3777/api/soundspectrum/hls/${options.generation ?? f.service.generation}/${name}?viewerId=${options.viewerId ?? A}${options.query || ""}`);
  const api = createSoundSpectrumApi({ service: f.service, readJson: async () => options.body,
    sendJson: (response, code, value) => { response.writeHead(code, {}); response.end(JSON.stringify(value)); } });
  await api.handle(req, res, url); await flush();
  return { req, res, get body() { return Buffer.concat(chunks).toString(); } };
}

test("HLS inventory stays passive and unavailable helper failures preserve existing transports", async t => {
  for (const inspect of [async () => ({ available: true, privatePath: "SECRET" }), async () => { throw Error("SECRET"); }]) {
    const f = fixture({ hlsTransport: { inspect } }); t.after(() => f.service.close());
    const value = await f.service.status(A, true);
    assert.equal(value.state, "idle"); assert.equal(value.clients, 0); assert.equal(f.calls.length, 0);
    assert.equal(value.transports.find(item => item.id === "jpeg").available, true);
    assert.doesNotMatch(JSON.stringify(value), /SECRET/);
  }
});

test("HLS starts one exact 4K60 native capture at the selected bitrate and keeps delay unchanged", async t => {
  const delay = new SoundSpectrumDelay({ readFile: () => JSON.stringify({ version: 1, delayMs: 1450 }), apply: () => {}, persist: () => { throw Error("Must not save delay"); } });
  await delay.update({ action: "preview", delayMs: 1400, expectedRevision: 0, expectedInstanceId: delay.instanceId });
  const before = delay.snapshot(), f = fixture(); f.service.visualDelay = delay; t.after(() => f.service.close());
  await f.service.session({ ...selection, bitrateMbps: 50 }); await f.service.serial;
  const value = f.service.snapshot(A);
  assert.equal(value.state, "running"); assert.equal(value.videoTransport, "hls"); assert.equal(value.bitrateMbps, 50);
  assert.equal(value.videoStats.configuredBitrateMbps, 50); assert.equal(value.videoStats.targetFps, 60);
  assert.deepEqual(f.calls.find(value => value.nativeStart).nativeStart, { visualizer: "whitecap", inputId: "mic", targetFrameRate: 120, width: 3840, height: 2160, uniqueCaptureTitle: true, windowMode: "borderless-fullscreen" });
  assert.equal(f.selected.profile.targetBitrateMbps, 50); assert.equal(f.selected.profile.fps, 60);
  assert.equal(f.selected.isCurrent(), true); assert.deepEqual(await f.selected.observeWindow(), { pid: 123, windowHandle: "1234", width: 3840, height: 2160, owned: true });
  assert.deepEqual(delay.snapshot(), before);
});

test("HLS bitrate defaults to 600 and rejects invalid selection before creating demand", async t => {
  const f = await start(t); assert.equal(f.selected.profile.targetBitrateMbps, 600);
  for (const bitrateMbps of [49, 601, 50.5, "600", null, Infinity, NaN]) {
    const g = fixture(); t.after(() => g.service.close());
    await assert.rejects(g.service.session({ ...selection, bitrateMbps }), /whole HLS bitrate/);
    assert.equal(g.service.leases.size, 0); assert.equal(g.calls.length, 0);
  }
});

test("HLS requests native capture headroom for each engine while keeping the output target at 60", async t => {
  for (const visualizer of ["aeon", "g-force", "whitecap"]) {
    const f = await start(t, { native: { inspect: async () => ({ visualizers: [{ id: visualizer, available: true }], inputs: [{ id: "mic" }] }) } }, { visualizer });
    assert.equal(f.calls.find(value => value.nativeStart).nativeStart.targetFrameRate, 120);
    assert.equal(f.selected.profile.fps, 60);
    assert.equal(f.selected.profile.targetFps, 60);
  }
});

test("unavailable HLS fails before native startup without a silent transport fallback", async t => {
  const f = fixture({ hlsTransport: { inspect: async () => ({ available: false }) } }); t.after(() => f.service.close());
  await assert.rejects(f.service.session(selection), /HLS transport is unavailable/);
  assert.equal(f.service.leases.size, 0); assert.equal(f.calls.length, 0);
});

test("HLS sharing requires exact generation, source and bitrate, while same-selection Start reuses the publisher", async t => {
  const f = await start(t, {}, { bitrateMbps: 250 }), generation = f.service.generation;
  for (const patch of [{ bitrateMbps: 251 }, { generation: generation + 1 }, { inputId: "other" }, { zoneId: "other" }]) {
    await assert.rejects(f.service.session({ ...selection, viewerId: B, action: "join", generation, bitrateMbps: 250, ...patch }), /selection changed/);
    assert.equal(f.service.leases.has(B), false);
  }
  await f.service.session({ ...selection, viewerId: B, action: "join", generation, bitrateMbps: 250 });
  await f.service.session({ ...selection, bitrateMbps: 250 }); await f.service.serial;
  assert.equal(f.calls.filter(value => value.hlsStart).length, 1); assert.equal(f.service.generation, generation);
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.state, "running"); assert.equal(f.service.leases.has(B), true);
  assert.equal(f.calls.filter(value => value === "hls-stop").length, 0);
});

test("explicit HLS bitrate replacement increments generation and fences old ready/failure callbacks", async t => {
  const f = await start(t), old = f.selected, generation = f.service.generation;
  await f.service.session({ ...selection, bitrateMbps: 100 }); await f.service.serial;
  old.onReady(); old.onFailure(); await f.service.serial;
  assert.equal(old.isCurrent(), false); await assert.rejects(old.observeWindow(), /changed/);
  assert.equal(f.service.state, "running"); assert.equal(f.service.generation, generation + 1);
  assert.equal(f.service.snapshot().bitrateMbps, 100); assert.equal(f.calls.filter(value => value.hlsStart).length, 2);
  const lastStop = f.calls.lastIndexOf("hls-stop"), nativeStop = f.calls.indexOf("native-stop", lastStop);
  assert.ok(lastStop >= 0 && nativeStop > lastStop);
});

test("Stop during pending HLS setup fences readiness and cleans owned helper before native", async t => {
  let selected, finish;
  const f = fixture({ hlsTransport: { start: value => { selected = value; return new Promise(resolve => { finish = resolve; }); } } });
  t.after(() => f.service.close());
  await f.service.session(selection); while (!finish) await flush();
  await f.service.session({ action: "stop", viewerId: A });
  assert.equal(selected.isCurrent(), false); selected.onReady(); finish(); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.service.leases.size, 0); assert.equal(f.service.hlsSession, null);
  assert.ok(f.calls.lastIndexOf("hls-stop") < f.calls.lastIndexOf("native-stop"));
});

test("HLS startup and live failures close their own native/media path with safe errors", async t => {
  const f = await start(t, { hlsTransport: { start: async () => { throw Error("PRIVATE command"); } } });
  await f.service.serial;
  assert.equal(f.service.state, "error"); assert.doesNotMatch(f.service.error, /PRIVATE/);
  assert.equal(f.service.leases.size, 0); assert.equal(f.service.hlsSession, null);
  const g = await start(t); g.selected.onFailure(); await g.service.serial;
  assert.equal(g.service.state, "error"); assert.equal(g.service.leases.size, 0);
});

test("failed HLS Stop retains ownership and native audio until a later Stop verifies cleanup", async t => {
  const f = await start(t), old = f.selected, owner = f.service.hlsSession, window = f.service.captureWindow;
  let refuse = true, stops = 0, audioStops = 0;
  const nativeStops = f.calls.filter(value => value === "native-stop").length;
  f.service.audioFeed = { snapshot: () => ({}), stop: async () => { audioStops++; } };
  f.hlsTransport.stop = async () => { stops++; if (refuse) throw Error("PRIVATE termination detail"); };
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.state, "error"); assert.match(f.service.error, /Stop visuals to retry/); assert.doesNotMatch(f.service.error, /PRIVATE/);
  assert.equal(f.service.hlsSession, owner); assert.equal(owner.ready, false); assert.equal(owner.stopping, true);
  assert.equal(f.service.captureWindow, window); assert.equal(f.native.status().state, "running");
  assert.equal(audioStops, 0); assert.equal(f.calls.filter(value => value === "native-stop").length, nativeStops);
  old.onReady(); old.onFailure(); assert.equal(old.isCurrent(), false); assert.equal(owner.ready, false);
  refuse = false;
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(stops, 2); assert.equal(f.service.state, "idle"); assert.equal(f.service.hlsSession, null);
  assert.equal(f.service.captureWindow, null); assert.equal(audioStops, 1); assert.equal(f.native.status().state, "stopped");
});

test("a new HLS Start retries failed cleanup before capture and cannot revive an old media request", async t => {
  let finish;
  const f = await start(t, { hlsTransport: { readAsset: () => new Promise(resolve => { finish = resolve; }) } });
  const old = f.selected, generation = f.service.generation;
  const pending = http(f, "part.mp4"); while (!finish) await flush();
  let stops = 0;
  f.hlsTransport.stop = async () => { f.calls.push("hls-stop"); if (++stops === 1) throw Error("fixture stop failure"); };
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.state, "error"); assert.equal(f.service.hlsReaders.size, 0);
  await f.service.session({ ...selection, viewerId: B, bitrateMbps: 100 }); await f.service.serial;
  assert.equal(stops, 2); assert.equal(f.service.state, "running"); assert.ok(f.service.generation > generation);
  const cleanup = f.calls.lastIndexOf("hls-stop"), nextCapture = f.calls.findIndex((value, index) => index > cleanup && value.nativeStart);
  assert.ok(nextCapture > cleanup); assert.equal(f.calls.filter(value => value.hlsStart).length, 2);
  const body = new PassThrough(); finish({ statusCode: 200, body }); const result = await pending;
  assert.equal(result.res.destroyed, true); assert.equal(body.destroyed, true); assert.equal(f.service.hlsReaders.size, 0);
  old.onReady(); old.onFailure(); await f.service.serial;
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.state, "running"); assert.equal(f.service.snapshot().bitrateMbps, 100);
  assert.equal(f.service.leases.has(B), true); assert.equal(f.service.leases.has(A), false);
  assert.equal((await http(f, "index.m3u8", { generation, viewerId: A })).res.statusCode, 403);
});

test("a failed HLS cleanup retry prevents replacement capture and remains recoverable", async t => {
  const f = await start(t), owner = f.service.hlsSession;
  let refuse = true;
  f.hlsTransport.stop = async () => { if (refuse) throw Error("fixture stop failure"); };
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  await f.service.session({ ...selection, viewerId: B, bitrateMbps: 50 }); await f.service.serial; await f.service.serial;
  assert.equal(f.service.state, "error"); assert.equal(f.service.hlsSession, owner);
  assert.equal(f.calls.filter(value => value.nativeStart).length, 1); assert.equal(f.native.status().state, "running");
  assert.equal(f.service.leases.size, 0);
  refuse = false;
  await f.service.session({ action: "stop", viewerId: B }); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.service.hlsSession, null); assert.equal(f.native.status().state, "stopped");
});

test("shutdown reports incomplete HLS cleanup without looping or discarding ownership", async t => {
  const f = await start(t), owner = f.service.hlsSession;
  let refuse = true, stops = 0;
  f.hlsTransport.stop = async () => { stops++; if (refuse) throw Error("fixture stop failure"); };
  await f.service.close();
  assert.equal(stops, 1); assert.equal(f.service.state, "error"); assert.equal(f.service.hlsSession, owner);
  assert.equal(f.native.status().state, "running"); assert.match(f.service.error, /could not close cleanly/);
  refuse = false; await f.service.close();
  assert.equal(stops, 2); assert.equal(f.service.hlsSession, null); assert.equal(f.native.status().state, "stopped");
});

test("HLS hidden heartbeat grace and expiry use ordinary leases without media-request renewal", async t => {
  const f = await start(t); await f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden" });
  const until = f.service.leases.get(A); f.advance(89999);
  assert.equal((await http(f)).res.statusCode, 200); assert.equal(f.service.leases.get(A), until);
  f.advance(1); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.service.leases.size, 0);
  assert.equal((await http(f)).res.statusCode, 403);
});

test("visible HLS media sustains over five minutes without control heartbeats then expires after delivery stops", async t => {
  const diagnostics = [];
  const f = await start(t, { onDiagnostic: value => diagnostics.push(value),
    hlsTransport: { readAsset: async () => ({ statusCode: 200, body: Readable.from([Buffer.from("part")]) }) } });
  const generation = f.service.generation;
  for (let index = 0; index < 78; index++) {
    f.advance(4000); assert.equal((await http(f, `part_${index}.mp4`)).body, "part"); f.service.sweep();
    assert.equal(f.service.state, "running"); assert.equal(f.service.generation, generation);
  }
  assert.equal(f.calls.filter(value => value.nativeStart).length, 1); assert.equal(f.calls.filter(value => value.hlsStart).length, 1);
  f.advance(11999); f.service.sweep(); assert.equal(f.service.state, "running");
  f.advance(1); f.service.sweep(); await f.service.serial;
  assert.equal(f.service.state, "idle"); assert.equal(f.service.leases.size, 0); assert.equal(f.service.hlsActivity.size, 0);
  const expiry = diagnostics.filter(value => value.event === "hls-lease-expired");
  assert.equal(expiry.length, 1); assert.equal(expiry[0].controlAgeMs, 324000); assert.equal(expiry[0].mediaAgeMs, 12000);
  assert.equal(expiry[0].readers, 0); assert.equal(expiry[0].waitingReaders, 0);
  assert.ok(!JSON.stringify(expiry).includes(A)); assert.doesNotMatch(JSON.stringify(expiry), /viewerId|url|path/i);
});

test("HLS manifests, status, failed responses, empty media and headers alone never renew a lease", async t => {
  const f = await start(t), until = f.service.leases.get(A);
  f.advance(1000); await http(f); await f.service.status(A); assert.equal(f.service.leases.get(A), until);
  for (const statusCode of [200, 404, 502]) {
    f.advance(1000); f.hlsTransport.readAsset = async () => ({ statusCode, body: Readable.from([]) });
    await http(f, "part.mp4"); assert.equal(f.service.leases.get(A), until);
  }
  f.advance(1000); f.hlsTransport.readAsset = async () => { throw Error("fixture unavailable"); };
  await http(f, "part.mp4"); await http(f, "part.mp4", { query: "&_HLS_msn=-1" }); assert.equal(f.service.leases.get(A), until);
  const body = new PassThrough(); f.hlsTransport.readAsset = async () => ({ statusCode: 206, body });
  f.advance(1000); const response = await http(f, "part.mp4"); body.write(Buffer.alloc(0));
  assert.equal(response.res.statusCode, 206); assert.equal(f.service.leases.get(A), until);
  f.advance(6000); f.service.sweep(); await f.service.serial;
  assert.equal(body.destroyed, true); assert.equal(response.res.destroyed, true); assert.equal(f.service.state, "idle");
});

test("a waiting HLS preload cannot extend its lease or revive it after expiry", async t => {
  let finish;
  const diagnostics = [], f = await start(t, { onDiagnostic: value => diagnostics.push(value),
    hlsTransport: { readAsset: () => new Promise(resolve => { finish = resolve; }) } });
  const until = f.service.leases.get(A);
  f.advance(11000); const pending = http(f, "part.mp4", { query: "&_HLS_msn=12&_HLS_part=1" }); while (!finish) await flush();
  assert.equal(f.service.leases.get(A), until);
  f.advance(1000); f.service.sweep(); await f.service.serial;
  const body = new PassThrough(); finish({ statusCode: 200, body }); const response = await pending;
  assert.equal(response.res.destroyed, true); assert.equal(body.destroyed, true); assert.equal(f.service.leases.size, 0);
  assert.equal(f.service.state, "idle"); assert.equal(f.service.hlsReaders.size, 0);
  const expiry = diagnostics.find(value => value.event === "hls-lease-expired");
  assert.equal(expiry.controlAgeMs, 12000); assert.equal(expiry.mediaAgeMs, null); assert.equal(expiry.waitingReaders, 1);
});

test("hidden HLS media cannot prolong hidden grace and visible control explicitly restores eligibility", async t => {
  const f = await start(t, { hlsTransport: { readAsset: async () => ({ statusCode: 200, body: Readable.from([Buffer.from("part")]) }) } });
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden" });
  const until = f.service.leases.get(A);
  for (let index = 0; index < 8; index++) { f.advance(10000); await http(f, "part.mp4"); assert.equal(f.service.leases.get(A), until); }
  f.advance(9999); await http(f, "part.mp4"); assert.equal(f.service.leases.get(A), until);
  f.advance(1); f.service.sweep(); await f.service.serial; assert.equal(f.service.state, "idle");
  await f.service.session(selection); await f.service.serial;
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "hidden" }); f.advance(10000);
  await f.service.session({ action: "heartbeat", viewerId: A, visibility: "visible" });
  const visibleUntil = f.service.leases.get(A); f.advance(4000); await http(f, "part.mp4");
  assert.equal(f.service.leases.get(A), visibleUntil + 4000);
});

test("old HLS bytes after Stop and same-viewer restart cannot renew the replacement generation", async t => {
  const body = new PassThrough(), f = await start(t, { hlsTransport: { readAsset: async () => ({ statusCode: 200, body }) } });
  const oldGeneration = f.service.generation, response = await http(f, "part.mp4");
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  await f.service.session(selection); await f.service.serial; const until = f.service.leases.get(A);
  f.advance(4000); body.emit("data", Buffer.from("retired bytes"));
  assert.equal(f.service.leases.get(A), until); assert.equal(f.service.hlsActivity.get(A).mediaAt, null);
  assert.equal(body.destroyed, true); assert.equal(response.res.destroyed, true);
  assert.equal((await http(f, "part.mp4", { generation: oldGeneration })).res.statusCode, 409);
  assert.equal(f.service.leases.get(A), until); assert.equal(f.service.state, "running");
});

test("media cannot revive an expired or aborted HLS reader even before the next sweep", async t => {
  const bodies = [], f = await start(t, { hlsTransport: { readAsset: async () => {
    const body = new PassThrough(); bodies.push(body); return { statusCode: 200, body };
  } } });
  const first = await http(f, "part.mp4"), until = f.service.leases.get(A);
  first.req.emit("aborted"); f.advance(4000); bodies[0].emit("data", Buffer.from("aborted"));
  assert.equal(f.service.leases.get(A), until); assert.equal(f.service.hlsReaders.size, 0);
  await http(f, "part.mp4"); f.advance(8000); bodies[1].write("expired");
  assert.equal(f.service.leases.get(A), until); assert.equal(f.service.hlsActivity.get(A).mediaAt, null);
  f.service.sweep(); await f.service.serial; assert.equal(f.service.state, "idle"); assert.equal(bodies[1].destroyed, true);
});

test("HLS byte demand belongs only to its viewer and explicit Stop cannot be undone by media", async t => {
  const bodies = [], f = await start(t, { hlsTransport: { readAsset: async () => {
    const body = new PassThrough(); bodies.push(body); return { statusCode: 200, body };
  } } });
  await f.service.session({ ...selection, action: "join", viewerId: B, generation: f.service.generation });
  const untilB = f.service.leases.get(B); await http(f, "part.mp4");
  for (let index = 0; index < 3; index++) { f.advance(4000); bodies[0].write("part"); f.service.sweep(); }
  assert.equal(f.service.leases.has(B), false); assert.ok(f.service.leases.get(A) > untilB); assert.equal(f.service.state, "running");
  await f.service.session({ ...selection, action: "join", viewerId: B, generation: f.service.generation });
  const renewedB = f.service.leases.get(B);
  await f.service.session({ action: "stop", viewerId: A }); f.advance(4000); bodies[0].emit("data", Buffer.from("after Stop"));
  assert.equal(f.service.leases.has(A), false); assert.equal(f.service.leases.get(B), renewedB); assert.equal(f.service.state, "running");
});

test("HLS byte renewal preserves full media and pipe backpressure while limiting renewal writes", async t => {
  const expected = 8388608, source = Readable.from((function* () { for (let index = 0; index < 64; index++) yield Buffer.alloc(131072, 7); })());
  const f = await start(t, { hlsTransport: { readAsset: async () => ({ statusCode: 200, body: source }) } });
  let bytes = 0, writes = 0;
  const originalSet = f.service.leases.set.bind(f.service.leases);
  f.service.leases.set = (...args) => { writes++; return originalSet(...args); };
  f.advance(4000);
  const req = new EventEmitter(); req.headers = {};
  const res = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    assert.ok(chunk.every(value => value === 7)); bytes += chunk.length; setImmediate(callback);
  } }); res.writeHead = () => {};
  const finished = once(res, "finish");
  await f.service.hlsAsset(req, res, { viewerId: A, generation: f.service.generation, name: "part.mp4", query: new URLSearchParams() });
  assert.ok(bytes < expected); await finished;
  assert.equal(bytes, expected); assert.equal(res.writableFinished, true); assert.equal(writes, 1);
  assert.equal(f.service.hlsReaders.size, 0); assert.equal(f.service.state, "running");
});

test("HLS fidelity reports its own configured H264 capture and never labels it JPEG or OBS measurements", async t => {
  const f = await start(t, {}, { bitrateMbps: 333 }); const value = await f.service.fidelity();
  assert.equal(value.transport, "hls"); assert.equal(value.capture.api, "windows-graphics-capture");
  assert.deepEqual(value.transmission.configuredResolution, { width: 3840, height: 2160 });
  assert.equal(value.transmission.configuredBitrateMbps, 333); assert.equal(value.transmission.codec, "H.264");
  assert.equal(value.transmission.payloadBitrateMbps, null); assert.equal(value.transmission.resolution, null);
  assert.doesNotMatch(JSON.stringify(value), /jpeg|obs-|mediamtx|SECRET/);
});

test("HLS reports fresh same-generation capture and AU rates separately from configured output", async t => {
  let measured;
  const f = await start(t, { hlsTransport: { snapshot: () => measured } }, { bitrateMbps: 400 });
  measured = { state: "ready", ready: true, generation: f.service.generation, captureFps: 64, encodedFps: 60,
    videoBitrateMbps: 285.07, videoBitrateWindowMs: 1000, videoBitrateObservedAt: 1000, password: "SECRET" };
  const stats = f.service.snapshot(A).videoStats, fidelity = await f.service.fidelity();
  assert.equal(stats.targetFps, 60); assert.equal(stats.captureFps, 64); assert.equal(stats.encodedFps, 60);
  assert.equal(stats.frameRatesObservedAt, 1000);
  assert.equal(fidelity.capture.fps, 64); assert.equal(fidelity.capture.fpsMeasurement, "wgc-fresh-timestamp-counter-delta");
  assert.equal(fidelity.transmission.fps, 60); assert.equal(fidelity.transmission.fpsMeasurement, "capture-h264-access-unit-counter-delta");
  assert.equal(fidelity.transmission.configuredBitrateMbps, 400); assert.equal(fidelity.transmission.payloadBitrateMbps, 285.07);
  assert.equal(fidelity.transmission.bitrateWindowMs, 1000); assert.equal(fidelity.transmission.bitrateObservedAt, 1000);
  assert.equal(fidelity.transmission.bitrateMeasurement, "capture-h264-access-unit-byte-counter-delta");
  assert.equal(fidelity.transmission.bitrateScope, "encoded-h264-video-payload");
  assert.equal(fidelity.transmission.resolution, null, "rate counters do not prove bitstream dimensions");
  assert.doesNotMatch(JSON.stringify({ stats, fidelity }), /SECRET/);
  f.advance(6001);
  assert.equal(f.service.snapshot(A).videoStats.captureFps, null);
  assert.equal((await f.service.fidelity()).transmission.payloadBitrateMbps, null);
});

test("HLS rejects stale, future, wrong-generation and malformed cached rate observations", async t => {
  let measured;
  const f = await start(t, { hlsTransport: { snapshot: () => measured } });
  const base = { state: "ready", ready: true, generation: f.service.generation, captureFps: 64, encodedFps: 60,
    videoBitrateMbps: 280, videoBitrateWindowMs: 1000, videoBitrateObservedAt: 1000 };
  for (const patch of [{ generation: f.service.generation - 1 }, { state: "stopping" }, { ready: false },
    { videoBitrateObservedAt: 1001 }, { videoBitrateObservedAt: null }, { videoBitrateObservedAt: -1 }]) {
    measured = { ...base, ...patch };
    const stats = f.service.snapshot(A).videoStats, value = await f.service.fidelity();
    assert.equal(stats.captureFps, null); assert.equal(stats.encodedFps, null);
    assert.equal(value.capture.fps, null); assert.equal(value.transmission.payloadBitrateMbps, null);
  }
  measured = { ...base, captureFps: Infinity, encodedFps: "60", videoBitrateMbps: -1, videoBitrateWindowMs: 100000 };
  assert.equal(f.service.snapshot(A).videoStats.captureFps, null);
  assert.equal(f.service.snapshot(A).videoStats.encodedFps, null);
  assert.equal((await f.service.fidelity()).transmission.payloadBitrateMbps, null);
  measured = { ...base, captureFps: 0, encodedFps: 0, videoBitrateMbps: 0 };
  assert.equal(f.service.snapshot(A).videoStats.encodedFps, 0);
  assert.equal((await f.service.fidelity()).transmission.payloadBitrateMbps, 0);
});

test("HLS cached diagnostic failures and ended sessions cannot probe or disrupt video", async t => {
  let reads = 0;
  const f = await start(t, { hlsTransport: { snapshot: () => { reads++; throw Error("SECRET"); } } });
  assert.equal(f.service.snapshot(A).videoStats.captureFps, null);
  assert.equal((await f.service.fidelity()).transmission.fps, null);
  assert.equal(f.service.state, "running");
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  const prior = reads;
  assert.equal(f.service.snapshot(A).videoStats.captureFps, null);
  assert.equal((await f.service.fidelity()).capture.fps, null);
  assert.equal(reads, prior, "idle diagnostics never read the provider or create demand");
});

test("HLS manifests rewrite segment lines and all quoted URI attributes with exact viewer and generation", async t => {
  const f = await start(t), result = await http(f), base = `/api/soundspectrum/hls/${f.service.generation}/`;
  assert.equal(result.res.statusCode, 200); assert.equal(result.res.headers["Cache-Control"], "no-store, private");
  for (const name of ["init.mp4", "part_1.mp4", "part_2.mp4", "segment_1.m4s"]) assert.ok(result.body.includes(base + name + "?viewerId=" + A));
  assert.equal(Number(result.res.headers["Content-Length"]), Buffer.byteLength(result.body));
  assert.equal(f.service.hlsReaders.size, 0);
});

test("HLS authorization rejects missing/stale leases, wrong generation and cross-origin requests before provider reads", async t => {
  let reads = 0;
  const f = await start(t, { hlsTransport: { readAsset: async () => { reads++; throw Error("Must not read"); } } });
  for (const options of [{ viewerId: "bad" }, { viewerId: B }, { generation: f.service.generation + 1 },
    { headers: { origin: "http://evil.example" } }, { headers: { "sec-fetch-site": "cross-site" } }]) {
    assert.ok([400, 403, 409].includes((await http(f, "index.m3u8", options)).res.statusCode));
  }
  assert.equal(reads, 0);
});

test("HLS rejects traversal, external manifest references, excessive manifests and invalid LL query values", async t => {
  const f = await start(t);
  for (const name of ["%2e%2e%2fsecret.ts", "sub/segment.ts", "index.txt", "segment.ts%00"]) assert.equal((await http(f, name)).res.statusCode, 404);
  for (const body of ["#EXTM3U\n../secret.ts\n", "#EXTM3U\n#EXT-X-MAP:URI=\"https://PRIVATE/a.mp4\"\n", "#EXTM3U\n" + "#".repeat(1048576), "not a playlist"]) {
    f.hlsTransport.readAsset = async () => ({ statusCode: 200, body: Buffer.from(body) });
    const value = await http(f); assert.equal(value.res.statusCode, 502); assert.doesNotMatch(value.body, /PRIVATE/);
  }
  for (const query of ["&_HLS_msn=-1", "&_HLS_part=1.5", "&_HLS_skip=bad", "&secret=PRIVATE"])
    assert.equal((await http(f, "index.m3u8", { query })).res.statusCode, 400);
});

test("HLS forwards LL requests and a single byte range and streams media without exposing provider headers", async t => {
  let request;
  const f = await start(t, { hlsTransport: { readAsset: async (name, options) => {
    request = { name, ...options }; const body = new PassThrough(); setImmediate(() => body.end("abc"));
    return { statusCode: 206, headers: { "content-length": "3", "content-range": "bytes 0-2/3", "accept-ranges": "bytes", "private-url": "SECRET" }, body };
  } } });
  const result = await http(f, "part.mp4", { query: "&_HLS_msn=12&_HLS_part=2&_HLS_skip=YES", headers: { range: "bytes=0-2" } });
  assert.equal(result.res.statusCode, 206); assert.equal(result.body, "abc"); assert.equal(request.generation, f.service.generation);
  assert.equal(request.query.toString(), "_HLS_msn=12&_HLS_part=2&_HLS_skip=YES"); assert.equal(request.range, "bytes=0-2");
  assert.doesNotMatch(JSON.stringify(result.res.headers), /SECRET|private-url/);
});

test("a pending HLS asset cannot cross Stop/restart or recreate demand", async t => {
  let finish;
  const f = await start(t, { hlsTransport: { readAsset: () => new Promise(resolve => { finish = resolve; }) } });
  const fetching = http(f); while (!finish) await flush();
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  const body = new PassThrough(); finish({ statusCode: 200, body }); const result = await fetching;
  assert.equal(result.res.destroyed, true); assert.equal(body.destroyed, true); assert.equal(f.service.leases.size, 0);
  assert.equal(f.service.hlsReaders.size, 0);
});

test("Stop closes only that HLS viewer's in-flight streams while another viewer keeps capture", async t => {
  const bodies = [];
  const f = await start(t, { hlsTransport: { readAsset: async () => { const body = new PassThrough(); bodies.push(body); return { statusCode: 200, body }; } } });
  await f.service.session({ ...selection, viewerId: B, action: "join", generation: f.service.generation });
  const first = await http(f, "part.mp4"), second = await http(f, "part.mp4", { viewerId: B });
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(first.res.destroyed, true); assert.equal(bodies[0].destroyed, true);
  assert.equal(second.res.destroyed, false); assert.equal(bodies[1].destroyed, false); assert.equal(f.service.state, "running");
  assert.equal(f.service.hlsReaders.size, 1);
});

test("HLS media read failures are sanitized and invalid ranges never reach the helper", async t => {
  let reads = 0;
  const f = await start(t, { hlsTransport: { readAsset: async () => { reads++; throw Error("PRIVATE path or credentials"); } } });
  for (const range of ["bytes=5-1", "bytes=1-2,4-5", "bytes=-1", "SECRET"]) assert.equal((await http(f, "part.mp4", { headers: { range } })).res.statusCode, 416);
  assert.equal(reads, 0); const result = await http(f, "part.mp4");
  assert.equal(result.res.statusCode, 502); assert.doesNotMatch(result.body, /PRIVATE/); assert.equal(f.service.hlsReaders.size, 0);
});

test("HLS window observations merge verified process identity and reject a changed start identity", async t => {
  let ticks = "133800000000000000";
  const f = await start(t, { native: { captureIdentity: () => ({ pid: 123, windowHandle: "1234", startTimeTicks: ticks,
    executable: "WhiteCap Standalone.x64.exe", windowTitle: "owned-title", windowClass: "owned-class" }) } });
  const observed = await f.selected.observeWindow();
  assert.equal(observed.startTimeTicks, ticks); assert.equal(observed.executable, "WhiteCap Standalone.x64.exe");
  assert.equal(observed.width, 3840); ticks = "133800000000000001";
  await assert.rejects(f.selected.observeWindow(), /renderer changed/);
});

test("pending HLS media reads are bounded per viewer and Stop clears all owned requests", async t => {
  const bodies = [];
  const f = await start(t, { hlsTransport: { readAsset: async () => { const body = new PassThrough(); bodies.push(body); return { statusCode: 200, body }; } } });
  for (let index = 0; index < 16; index++) assert.equal((await http(f, "part.mp4")).res.statusCode, 200);
  assert.equal((await http(f, "part.mp4")).res.statusCode, 429); assert.equal(bodies.length, 16);
  await f.service.session({ action: "stop", viewerId: A }); await f.service.serial;
  assert.equal(f.service.hlsReaders.size, 0); assert.ok(bodies.every(body => body.destroyed));
});

test("HLS uses one exact configured music feed and never substitutes Lyrion and HQPlayer identities", async t => {
  const hqp = "feed:hqplayer-analysis", zone = "1601d935088f5a8521851f0b72f30228de66", feedCalls = [];
  const f = fixture({ native: { inspect: async () => ({ visualizers: [{ id: "whitecap", available: true }], musicInputs: [{ id: hqp, kind: "music-feed" }] }) },
    audioFeed: { inspect: async () => ({ id: hqp, kind: "music-feed", source: "untrusted-label", available: true }), snapshot: () => ({ state: "waiting" }),
      validateStart: async value => { assert.equal(value.zoneId, zone); assert.equal(value.playerId, undefined); },
      start: async value => { feedCalls.push(value); }, stop: async () => {} } });
  t.after(() => f.service.close());
  await assert.rejects(f.service.session({ ...selection, inputId: hqp, playerId: "aa:bb:cc:dd:ee:ff" }), /configured Roon HQPlayer zone/);
  assert.equal(f.service.leases.size, 0);
  await f.service.session({ ...selection, inputId: hqp, zoneId: zone }); await f.service.serial;
  await f.service.session({ ...selection, action: "join", viewerId: B, inputId: hqp, zoneId: zone, generation: f.service.generation });
  assert.equal(feedCalls.length, 1); assert.equal(feedCalls[0].inputId, hqp); assert.equal(feedCalls[0].zoneId, zone);
  assert.equal(f.service.snapshot().inputSource, "roon-hqplayer"); assert.equal(f.service.snapshot().playerId, "");
});


test("1 GB history playlists beyond 64 KB retain authorized child references", async t => {
  const f = await start(t);
  const names = Array.from({ length: 804 }, (_, i) => 'segment_'.repeat(4) + i + '.mp4');
  const body = '#EXTM3U\n' + names.map(name => '#EXT-X-PROGRAM-DATE-TIME:2026-10-10T00:00:00.000Z\n#EXTINF:0.200000,\n' + name + '\n').join('');
  assert.ok(Buffer.byteLength(body) > 65536);
  f.hlsTransport.readAsset = async () => ({ statusCode: 200, body: Buffer.from(body) });
  const result = await http(f); assert.equal(result.res.statusCode, 200);
  for (const name of names) assert.ok(result.body.includes('/api/soundspectrum/hls/' + f.service.generation + '/' + name + '?viewerId=' + A));
});


test("HLS playback observations and failure stops retain only bounded allowlisted fields", async t => {
  const diagnostics = [], f = await start(t, { onDiagnostic: e => diagnostics.push(e) });
  const videoStats = { transport: "hls", hlsRequestedMB: 99999, hlsBufferSeconds: 1.4, hlsLoadedBytes: 1234,
    hlsBufferState: "filling", hlsPaused: true, hlsSeeking: false, hlsLastError: "quota", privateUrl: "SECRET", hlsDropPercent: Infinity };
  await f.service.session({ action: "heartbeat", viewerId: A, videoStats });
  const beat = diagnostics.find(x => x.event === "viewer-performance");
  assert.equal(beat.hlsRequestedMB, 1000); assert.equal(beat.hlsBufferSeconds, 1.4);
  assert.equal(beat.hlsLastError, "quota"); assert.equal(beat.hlsDropPercent, undefined);
  await f.service.session({ action: "stop", viewerId: A, reason: "hls-buffer-timeout", videoStats });
  const stop = diagnostics.find(x => x.event === "session-stop");
  assert.equal(stop.reason, "hls-buffer-timeout"); assert.equal(stop.videoStats.hlsPaused, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET/);
  await f.service.session({ action: "stop", viewerId: A, videoStats });
  assert.equal(diagnostics.filter(x => x.event === "session-stop").at(-1).videoStats, null);
});


test("relay startup GAP padding is removed with stable media sequence and real timing", async t => {
  const f = await start(t), gap = '#EXT-X-GAP\n#EXTINF:0.20000,\ngap.mp4\n';
  for (const [sequence, count] of [[0, 7], [3, 4], [7, 0]]) {
    const body = '#EXTM3U\n#EXT-X-TARGETDURATION:0\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n#EXT-X-MAP:URI="init.mp4"\n' + gap.repeat(count) + '#EXTINF:0.20000,\nseg7.mp4\n#EXTINF:0.20000,\nseg8.mp4\n';
    f.hlsTransport.readAsset = async () => ({ statusCode: 200, body: Buffer.from(body) });
    const result = await http(f); assert.equal(result.res.statusCode, 200);
    assert.match(result.body, /#EXT-X-MEDIA-SEQUENCE:7\n/); assert.doesNotMatch(result.body, /GAP|gap.mp4/);
    assert.ok(result.body.includes('/seg7.mp4?viewerId=' + A)); assert.match(result.body, /#EXTINF:0.20000/);
  }
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.2,\nreal.mp4\n' + gap;
  f.hlsTransport.readAsset = async () => ({ statusCode: 200, body: Buffer.from(body) });
  assert.match((await http(f)).body, /#EXT-X-GAP/);
});

test('120 fps is an explicit generation identity and cannot join or replace another viewer at 60 fps', async t => {
 const f=await start(t,{}, {targetFps:120,bitrateMbps:150});
 assert.equal(f.selected.profile.fps,120); assert.equal(f.service.snapshot(A).videoStats.targetFps,120);
 assert.equal(f.calls.find(c=>c.nativeStart).nativeStart.targetFrameRate,120);
 const generation=f.service.generation;
 await assert.rejects(f.service.session({...selection,action:'join',viewerId:B,generation,bitrateMbps:150,targetFps:60}),/changed/);
 await assert.rejects(f.service.session({...selection,viewerId:B,bitrateMbps:150,targetFps:60}),/frame rate/);
 await f.service.session({...selection,action:'join',viewerId:B,generation,bitrateMbps:150,targetFps:120});
 assert.equal(f.service.generation,generation);
});
test('invalid frame rates create no demand and default remains 60',async t=>{
 const f=fixture();t.after(()=>f.service.close());
 for(const targetFps of [30,119,121,'120',null,NaN]) await assert.rejects(f.service.session({...selection,targetFps}),/60 or 120/);
 assert.equal(f.service.leases.size,0);assert.equal(f.calls.length,0);
});
