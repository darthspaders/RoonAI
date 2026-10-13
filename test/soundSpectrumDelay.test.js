"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { SoundSpectrumDelay, persistSettings } = require("../src/soundSpectrumDelay");
const { PcmDelay } = require("../src/soundSpectrumPcmDelay");
const { createFeedMux } = require("../src/soundSpectrumFeeds");
const { SoundSpectrum, createSoundSpectrumApi } = require("../src/soundSpectrum");

const absent = () => { throw Object.assign(Error("not found"), { code: "ENOENT" }); };
const command = (delay, action, delayMs, extra = {}) => ({ action, delayMs, expectedRevision: delay.revision, expectedInstanceId: delay.instanceId, ...extra });
function removeTemporary(t, directory) {
  t.after(async () => {
    const target = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith("visual-delay-"));
    await fs.rm(target, { recursive: true, force: true });
  });
}

test("one global setting defaults to zero and previews without creating durable state", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "visual-delay-settings-"));
  removeTemporary(t, directory);
  const file = path.join(directory, "private", "delay.json"), applied = [];
  const delay = new SoundSpectrumDelay({ settingsPath: file, apply: value => applied.push(value) });
  assert.equal(delay.currentMs, 0); assert.equal(delay.savedMs, 0);
  assert.deepEqual(delay.snapshot().supportedVisualizers, ["aeon", "g-force", "whitecap"]);
  await delay.update(command(delay, "preview", 1250));
  assert.deepEqual(applied, [1250]); assert.equal(delay.savedMs, 0);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  await delay.update(command(delay, "save", 1250));
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).delayMs, 1250);
  const reloaded = new SoundSpectrumDelay({ settingsPath: file });
  assert.equal(reloaded.currentMs, 1250); assert.equal(reloaded.savedMs, 1250);
  assert.notEqual(reloaded.instanceId, delay.instanceId);
  await reloaded.update(command(reloaded, "preview", 0));
  assert.equal(reloaded.savedMs, 1250);
  await reloaded.update(command(reloaded, "save", 0));
  assert.equal(new SoundSpectrumDelay({ settingsPath: file }).currentMs, 0);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["delay.json"]);
});

test("failed save preserves acknowledged live value and previous durable value; retry is possible", async () => {
  const calls = []; let fail = true;
  const delay = new SoundSpectrumDelay({ readFile: absent, apply: value => calls.push(value), persist: async () => { if (fail) throw Error("private path"); } });
  await assert.rejects(delay.update(command(delay, "save", 2300)), error => error.statusCode === 500 && !error.message.includes("private path"));
  assert.equal(delay.currentMs, 2300); assert.equal(delay.savedMs, 0); assert.deepEqual(calls, [2300]);
  fail = false; await delay.update(command(delay, "save", 2300));
  assert.equal(delay.savedMs, 2300); assert.deepEqual(calls, [2300]);
});

test("atomic filesystem save failure preserves the previous saved file and removes temporary files", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "visual-delay-save-failure-"));
  removeTemporary(t, directory);
  const file = path.join(directory, "delay.json"), blocked = path.join(directory, "blocked.json");
  await persistSettings(file, 50); await fs.mkdir(blocked);
  const before = await fs.readFile(file);
  const delay = new SoundSpectrumDelay({ settingsPath: file, persist: async (_file, ms) => persistSettings(blocked, ms) });
  await assert.rejects(delay.update(command(delay, "save", 200)), { statusCode: 500 });
  assert.equal(delay.currentMs, 200); assert.equal(delay.savedMs, 50);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["blocked.json", "delay.json"]);
});

test("strict range/action/revision and old-instance conflicts never change the feed", async () => {
  const applied = [], delay = new SoundSpectrumDelay({ readFile: absent, apply: value => applied.push(value), persist: async () => {} });
  for (const value of [-1, 5001, 1.5, null, "100", NaN, Infinity]) {
    await assert.rejects(delay.update(command(delay, "preview", value)), { statusCode: 400 });
  }
  await assert.rejects(delay.update({ action: "preview", delayMs: 10 }), { statusCode: 400 });
  await assert.rejects(delay.update(command(delay, "reset", 0)), { statusCode: 400 });
  await assert.rejects(delay.update(command(delay, "preview", 10, { expectedRevision: 4 })), { statusCode: 409 });
  await assert.rejects(delay.update(command(delay, "preview", 10, { expectedInstanceId: "old-process" })), { statusCode: 409 });
  assert.deepEqual(applied, []);
  const unavailable = new SoundSpectrumDelay({ readFile: absent, available: false });
  await assert.rejects(unavailable.update(command(unavailable, "preview", 10)), { statusCode: 503 });
});

test("queued save cannot persist another view's preview; failures release serialization", async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const writes = [], delay = new SoundSpectrumDelay({ readFile: absent, persist: async (_file, value) => { writes.push(value); started(); await new Promise(resolve => { release = resolve; }); } });
  const saving = delay.update(command(delay, "save", 100)); await entered;
  const stale = delay.update({ action: "preview", delayMs: 300, expectedRevision: 0 });
  release(); await saving;
  await assert.rejects(stale, { statusCode: 409 });
  assert.deepEqual(writes, [100]); assert.equal(delay.currentMs, 100); assert.equal(delay.savedMs, 100);
  await delay.update(command(delay, "preview", 300)); assert.equal(delay.currentMs, 300);
});

test("invalid saved settings are explicit and can be replaced without auto applying a preset", async () => {
  const delay = new SoundSpectrumDelay({ readFile: () => '{"version":1,"delayMs":9000}', persist: async () => {} });
  assert.equal(delay.currentMs, 0); assert.match(delay.snapshot().settingsError, /could not be read/);
  await delay.update(command(delay, "save", 0)); assert.equal(delay.snapshot().settingsError, undefined);
});

function apiFixture(delay, service = {}) {
  service.visualDelay = delay; service.snapshot ||= () => ({});
  const api = createSoundSpectrumApi({ service, readJson: async request => request.body, sendJson: (response, status, body) => { response.status = status; response.body = body; } });
  return async (method, body, headers = {}) => {
    const response = { setHeader() {} };
    await api.handle({ method, body, headers: { "content-type": "application/json", ...headers }, socket: {} }, response, new URL("http://localhost/api/soundspectrum/delay"));
    return response;
  };
}

test("HTTP control path applies real PCM timing and reports conflict/save failures authoritatively", async () => {
  const ring = new PcmDelay();
  let failed = false;
  const delay = new SoundSpectrumDelay({ readFile: absent, apply: ms => ring.setDelayMs(ms), persist: async () => { if (failed) throw Error("disk"); } });
  const request = apiFixture(delay);
  assert.equal((await request("GET")).body.currentMs, 0);
  const input = Buffer.alloc(441 * 4, 7);
  assert.deepEqual(ring.process(input), input);
  const preview = await request("POST", command(delay, "preview", 10)); assert.equal(preview.status, 200);
  assert.deepEqual(ring.process(input), Buffer.alloc(input.length));
  assert.deepEqual(ring.process(Buffer.alloc(input.length)), input);
  const conflict = await request("POST", { action: "preview", delayMs: 500, expectedRevision: 0 });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.currentMs, 10);
  failed = true;
  const save = await request("POST", command(delay, "save", 20));
  assert.equal(save.status, 500); assert.equal(save.body.currentMs, 20); assert.equal(save.body.savedMs, 0);
  assert.equal((await request("POST", command(delay, "preview", 0), { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await request("POST", command(delay, "preview", 0), { "content-type": "text/plain" })).status, 415);
  assert.equal((await request("POST", command(delay, "preview", 0))).status, 200);
  assert.deepEqual(ring.process(input), input);
});

test("Aeon, G-Force and WhiteCap reuse one live delay and one feed, with no Remote delay", async t => {
  const id = "feed:hqplayer-analysis", zoneId = "1601d935088f5a8521851f0b72f30228de66", rings = [], nativeStarts = [];
  const ring = new PcmDelay(), feed = {
    inspect: async () => ({ id, kind: "music-feed", available: true }), snapshot: () => ({ state: "feeding", delayMs: ring.snapshot().delayMs }),
    setVisualDelayMs: ms => ring.setDelayMs(ms), validateStart: async () => {},
    start: async () => { ring.reset(); rings.push(ring); }, stop: async () => { ring.reset(); }
  };
  const { audioFeed } = createFeedMux([{ id, integration: { audioFeed: feed, additionalInputProvider: { list: async () => [], resolve: async () => null } } }]);
  const native = { inspect: async () => ({ visualizers: ["aeon", "g-force", "whitecap"].map(id => ({ id, available: true })), inputs: [], musicInputs: [{ id, kind: "music-feed", available: true }] }),
    start: async selection => { nativeStarts.push(selection); return { pid: 1, windowHandle: "1234", width: 1920, height: 1080 }; }, stop: async () => {} };
  const obsTransport = { inspect: async () => ({ available: true }), start: async options => options.onReady(), stop: async () => {}, releaseViewer: async () => {} };
  const service = new SoundSpectrum({ native, audioFeed, obsTransport, capture: { probeCaptureRuntime: async () => ({ available: true }) }, sweepMs: 0, onDiagnostic: () => {} });
  t.after(() => service.close());
  const delay = new SoundSpectrumDelay({ readFile: absent, persist: async () => {} }).bind(ms => audioFeed.setVisualDelayMs(ms));
  const request = apiFixture(delay, service);
  await request("POST", command(delay, "preview", 20));
  const input = Buffer.alloc(882 * 4, 11);
  for (const visualizer of ["aeon", "g-force", "whitecap"]) {
    await service.session({ action: "start", viewerId: "viewer_delay_12345678901234567890", visualizer, inputId: id, zoneId, transport: "obs-webrtc" });
    await service.serial;
    assert.equal(service.snapshot().visualDelay.currentMs, 20);
    assert.deepEqual(ring.process(input), Buffer.alloc(input.length));
    assert.deepEqual(ring.process(Buffer.alloc(input.length)), input);
    assert.equal(service.snapshot().videoStats.targetFps, 60);
  }
  assert.deepEqual(nativeStarts.map(selection => selection.visualizer), ["aeon", "g-force", "whitecap"]);
  assert.equal(rings.length, 3); assert.equal(new Set(rings).size, 1);
  await service.session({ action: "stop", viewerId: "viewer_delay_12345678901234567890" }); await service.serial;
  assert.deepEqual(ring.process(Buffer.alloc(input.length)), Buffer.alloc(input.length));
  assert.equal(delay.currentMs, 20);
});
