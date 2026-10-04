"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHQPlayerZoneGuard, createFeedMux } = require("../src/soundSpectrumFeeds");

const LYRION = "feed:pre-hqplayer", HQP = "feed:hqplayer-analysis";
const ZONE = "1601d935088f5a8521851f0b72f30228de66", OUTPUT = "1701d935088f5a8521851f0b72f30228de66";
const SETTINGS = { zoneId: ZONE, outputId: OUTPUT };
const state = (overrides = {}) => ({ connected: true, zones: [{ zone_id: ZONE, display_name: "Renamed player", state: "playing", outputs: [{ output_id: OUTPUT, display_name: "Renamed output" }], now_playing: { source_url: "private-source" }, queue: { items: ["private-queue"] } }], ...overrides });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function entry(id, options = {}) {
  return { id, integration: {
    audioFeed: { inspect: async () => ({ id, name: id, kind: "music-feed", available: true }), snapshot: () => ({ state: "waiting", id }), validateStart: async () => {}, start: async () => {}, stop: async () => {}, ...options.audioFeed },
    additionalInputProvider: { list: async () => [{ id, name: id, kind: "music-feed" }], resolve: async selected => ({ id: selected, name: "Stereo Out (SoundSpectrum Audio Cable)", kind: "music-feed" }), ...options.provider }
  } };
}

test("HQPlayer guard uses pinned live output identity and returns no private playback data", async () => {
  let current = state(), reads = 0;
  const guard = createHQPlayerZoneGuard(() => { reads++; return current; });
  assert.deepEqual(await guard(ZONE, SETTINGS), { zone_id: ZONE, state: "playing", outputs: [{ output_id: OUTPUT }] });
  current = state({ connected: false, hqplayer: { active: true, signalPath: "Static HQPlayer prefix" } });
  await assert.rejects(guard(ZONE, SETTINGS), /disconnected/);
  assert.equal(reads, 2, "each validation reads current transport facts");
});

test("HQPlayer guard rejects malformed or unconfigured IDs before reading transport", async () => {
  let reads = 0;
  const guard = createHQPlayerZoneGuard(() => { reads++; return state(); });
  for (const [zoneId, settings] of [["HQPlayer", SETTINGS], [ZONE, { ...SETTINGS, zoneId: "1601ffffffffffffffffffffffffffff" }], [ZONE, { ...SETTINGS, outputId: "HQPlayer" }], [{ toString: () => ZONE }, SETTINGS]]) {
    await assert.rejects(guard(zoneId, settings), /configured Roon HQPlayer zone/);
  }
  assert.equal(reads, 0);
});

test("HQPlayer guard rejects stale display hints, grouped outputs, wrong output and paused playback", async () => {
  const good = state().zones[0];
  const invalid = [[], [{ ...good, outputs: [] }], [{ ...good, outputs: [good.outputs[0], { output_id: "another-output" }] }], [{ ...good, outputs: [{ output_id: "1701ffffffffffffffffffffffffffff", display_name: "HQPlayer", hqplayer: { active: true } }] }], [{ ...good, state: "paused" }], [{ ...good, state: "stopped" }]];
  for (const zones of invalid) {
    await assert.rejects(createHQPlayerZoneGuard(() => state({ zones }))(ZONE, SETTINGS), /unavailable|grouped|Play music/);
  }
});

test("feed inventory isolates one unavailable optional adapter and rejects its foreign IDs", async () => {
  const raw = [{ id: "exact-recording-device" }], calls = [];
  const mux = createFeedMux([
    entry(LYRION, { audioFeed: { inspect: () => { throw Error("Removed dependency"); } }, provider: { list: () => { throw Error("Removed dependency"); } } }),
    entry(HQP, { audioFeed: { inspect: async refresh => { calls.push(refresh); return { id: HQP, kind: "music-feed", source: "forged-source", available: true }; } }, provider: { list: async inputs => { assert.equal(inputs, raw); return [{ id: LYRION, kind: "music-feed" }, { id: HQP, kind: "music-feed" }, { id: "feed:arbitrary", kind: "music-feed" }]; } } })
  ]);
  assert.deepEqual(await mux.audioFeed.inspect(true), [{ id: HQP, kind: "music-feed", source: "roon-hqplayer", available: true }]);
  assert.deepEqual(await mux.additionalInputProvider.list(raw), [{ id: HQP, kind: "music-feed" }]);
  assert.deepEqual(calls, [true]);
});

test("mux dispatches validation and native resolution only to the selected canonical adapter", async () => {
  const calls = [], raw = [{ id: "cable" }];
  const mux = createFeedMux([entry(LYRION, { audioFeed: { validateStart: () => { throw Error("Wrong adapter"); } }, provider: { resolve: () => { throw Error("Wrong adapter"); } } }), entry(HQP, { audioFeed: { validateStart: async selection => calls.push(selection) }, provider: { resolve: async (id, inputs) => { assert.equal(inputs, raw); return { id }; } } })]);
  await mux.audioFeed.validateStart({ inputId: HQP, zoneId: ZONE });
  assert.deepEqual(calls, [{ zoneId: ZONE }]);
  assert.deepEqual(await mux.additionalInputProvider.resolve(HQP, raw), { id: HQP });
  await assert.rejects(mux.audioFeed.validateStart({ inputId: "feed:forged" }), /unavailable/);
  await assert.rejects(mux.additionalInputProvider.resolve("feed:forged", raw), /unavailable/);
});

test("mux cannot launch a writer until every prior adapter finishes cleanup", async () => {
  const first = deferred(), second = deferred(), calls = [];
  const mux = createFeedMux([entry(LYRION, { audioFeed: { stop: async () => { calls.push("lyrion-stop"); await first.promise; } } }), entry(HQP, { audioFeed: { stop: async () => { calls.push("hqp-stop"); await second.promise; }, start: async selection => calls.push(selection) } })]);
  const start = mux.audioFeed.start({ inputId: HQP, zoneId: ZONE });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["lyrion-stop", "hqp-stop"]);
  first.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  second.resolve(); await start;
  assert.deepEqual(calls[2], { zoneId: ZONE });
});

test("mux attempts all cleanup after synchronous or asynchronous failure and refuses a new writer", async () => {
  for (const synchronous of [true, false]) {
    const calls = [], pending = deferred();
    const fail = () => { calls.push("failed-cleanup"); if (synchronous) throw Error("Cable writer did not close"); return Promise.reject(Error("Cable writer did not close")); };
    const mux = createFeedMux([entry(LYRION, { audioFeed: { stop: fail } }), entry(HQP, { audioFeed: { stop: async () => { calls.push("other-cleanup"); await pending.promise; }, start: async () => calls.push("unexpected-start") } })]);
    const start = mux.audioFeed.start({ inputId: HQP, zoneId: ZONE });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["failed-cleanup", "other-cleanup"]);
    pending.resolve(); await assert.rejects(start, /did not close/);
    assert.equal(calls.includes("unexpected-start"), false);
  }
});

test("mux construction and snapshots never activate optional sources", () => {
  let starts = 0;
  const mux = createFeedMux([entry(LYRION, { audioFeed: { start: () => starts++ } })]);
  assert.deepEqual(mux.audioFeed.snapshot(LYRION), { state: "waiting", id: LYRION });
  assert.equal(mux.audioFeed.snapshot(HQP).state, "waiting");
  assert.equal(starts, 0);
  assert.throws(() => createFeedMux([entry("feed:arbitrary")]), /exact/);
  assert.throws(() => createFeedMux([entry(LYRION), entry(LYRION)]), /exact/);
});

test("default installation tolerates either optional folder being absent or broken", async () => {
  const filename = path.resolve(__dirname, "../src/soundSpectrum.js"), source = fs.readFileSync(filename, "utf8");
  for (const available of [[], [LYRION], [HQP], [LYRION, HQP]]) {
    for (const broken of [null, HQP]) {
      const loaded = [], module = { exports: {} }, raw = [{ id: "cable" }];
      const load = name => {
        if (name === "node:fs") return { existsSync: target => available.includes(target.includes("soundspectrum-hqplayer-feed") ? HQP : LYRION) };
        if (name === "./soundSpectrumNative") return { createSoundSpectrumNative: options => ({ inspect: async () => ({ visualizers: [{ id: "aeon", available: true }], inputs: [{ id: "mic" }], musicInputs: await options?.additionalInputProvider?.list(raw) || [] }), stop: async () => {} }) };
        if (name === "../scripts/soundspectrum-capture.cjs") return { probeCaptureRuntime: async () => ({ available: true }) };
        if (name.includes("integrations")) { const id = name.includes("soundspectrum-hqplayer-feed") ? HQP : LYRION; loaded.push(id); if (id === broken) throw Error("Optional module missing dependency"); return { createIntegration: () => entry(id).integration }; }
        if (name === "./soundSpectrumFeeds") return require("../src/soundSpectrumFeeds");
        return require(name);
      };
      vm.runInNewContext(source, { require: load, module, exports: module.exports, __dirname: path.dirname(filename), Buffer, TextDecoder, process, console: { warn() {} }, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout });
      const api = module.exports.createSoundSpectrumApi({ readJson: async () => ({}), sendJson() {} });
      const inventory = await api.service.status();
      assert.deepEqual(Array.from(inventory.musicInputs, input => input.id), available.filter(id => id !== broken));
      assert.equal(inventory.inputs[0].id, "mic");
      assert.equal(api.service.state, "idle");
      assert.deepEqual(loaded, available);
      await api.service.close();
    }
  }
});
