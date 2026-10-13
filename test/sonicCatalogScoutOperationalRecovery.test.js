"use strict";

// Operational recovery evidence has two distinct scopes: real cache filesystem
// operations on owned temporary fixtures, and the unchanged worker's JavaScript
// state machine with fake child processes/timers. Nothing launches WSL or models.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream"), { createHash } = require("node:crypto");
const { SonicCatalogScoutCache, MODELS } = require("../src/sonicCatalogScoutCache");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { createPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function tree(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? tree(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]) : [];
}
function cacheFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-operational-recovery-")), privateRoot = path.join(temporary, "data"), directory = path.join(privateRoot, "cache");
  fs.mkdirSync(privateRoot);
  t.after(() => { const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); fs.rmSync(temporary, { recursive: true, force: true }); });
  const track = { identityKey: "tidal:123", tidalId: "123", artist: "Synthetic exact artist", title: "Synthetic cache fixture", mixVersion: "Original Mix", isrc: "USAAA2600123", durationMs: 360000 };
  const audioBytes = Buffer.from("synthetic exact preview fixture bytes; not decoded music"), source = freezeSonicSourceSnapshot({ track, audioBytes, sourceType: "beatport-preview", durationSeconds: 120,
    sourceTrack: { id: "1123", artist: track.artist, title: track.title, mixName: track.mixVersion, isrc: track.isrc, durationMs: track.durationMs }, allowVersionProxy: false });
  const receipts = Object.fromEntries(MODELS.map((analyzer, index) => {
    const spec = analysisSpec(analyzer), vector = Array(spec.dimensions).fill(0); vector[index] = 1;
    return [analyzer, createPrivateResultReceipt({ specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate, vector,
      audioDurationSeconds: source.durationSeconds, analyzedSeconds: 30, sourceCoverage: .25,
      segments: [{ start: 45, end: 75, vector: [...vector] }] }, spec, source)];
  }));
  const cache = new SonicCatalogScoutCache({ privateRoot, directory });
  return { temporary, privateRoot, directory, track, source, audioBytes, receipts, cache,
    get: (analyzer = MODELS[0]) => cache.get({ track, source, analyzer }),
    put: (analyzer = MODELS[0]) => cache.ingest({ track, source, analyzer, audioBytes, receipt: receipts[analyzer] }),
    resultFile: (analyzer = MODELS[0]) => path.join(directory, "results", `${source.sourceSha256}-${analysisSpec(analyzer).key}.json`) };
}
function workerHarness(t, options = {}) {
  const children = [], spawned = [], timers = new Set();
  class Child extends EventEmitter {
    constructor() {
      super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdin = new EventEmitter(); this.writes = []; this.kills = 0;
      this.stdin.write = text => { this.writes.push(JSON.parse(text)); return true; }; this.stdin.end = () => { this.stdinEnded = true; };
    }
    kill() { this.kills++; this.emit("exit", 0); return true; }
    send(message) { this.stdout.write(JSON.stringify(message) + "\n"); }
  }
  function spawn(command, args, settings) { const child = new Child(); spawned.push({ command, args, settings, child }); if (!args.includes("kill")) children.push(child); return child; }
  const module = { exports: {} }, file = path.resolve(__dirname, "../src/sonicAnalysisWorker.js");
  const scope = { module, exports: module.exports, __dirname: path.dirname(file), process: { platform: "win32", env: {} },
    require(name) { return name === "node:child_process" ? { spawn } : require(name); },
    setTimeout(fn, ms) { const timer = { fn, ms, unref() { return this; } }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), scope, { filename: file });
  const worker = new module.exports.SonicAnalysisWorker({ timeoutMs: 100, idleMs: 50, ...options });
  t.after(() => { worker.stop(); for (const row of spawned) { row.child.stdout.destroy(); row.child.stderr.destroy(); } });
  return { worker, children, spawned, timers, spec: { runtime: "mert2" },
    latest: () => children.at(-1), linuxKills: () => spawned.filter(row => row.args.includes("kill")),
    fire(ms) { const matches = [...timers].filter(timer => timer.ms === ms); assert.equal(matches.length, 1); timers.delete(matches[0]); matches[0].fn(); },
    finish(result = { fixture: true }) { const child = children.at(-1); child.send({ id: child.writes.at(-1).id, result }); } };
}

test("[real file cache] cold startup and repeated misses create no cache or analysis work", t => {
  const f = cacheFixture(t), before = tree(f.privateRoot);
  for (const analyzer of MODELS) for (let index = 0; index < 3; index++) { const read = f.get(analyzer); assert.equal(read.status, "cold"); assert.equal(read.record, null); assert.equal(read.neutral, true); assert.equal(read.missingModelIsNegative, false); }
  assert.deepEqual(tree(f.privateRoot), before); assert.equal(fs.existsSync(f.directory), false);
});
test("[real file cache] interrupted exact source publication resumes idempotently without replacing its bytes", t => {
  const f = cacheFixture(t), sources = path.join(f.directory, "sources"); fs.mkdirSync(sources, { recursive: true });
  const audioFile = path.join(sources, `${f.source.sourceSha256}.audio`); fs.writeFileSync(audioFile, f.audioBytes, { flag: "wx" });
  assert.equal(f.get().reason, "incomplete-source-cache"); const before = hash(fs.readFileSync(audioFile));
  assert.equal(f.put().status, "warm"); assert.equal(hash(fs.readFileSync(audioFile)), before); assert.equal(f.get(MODELS[1]).reason, "model-not-cached");
  assert.equal(f.put(MODELS[1]).status, "warm"); const completed = tree(f.directory); assert.equal(f.put().created, false);
  assert.deepEqual(tree(f.directory), completed); assert.equal(f.cache.status({ track: f.track, source: f.source }).jointReady, true);
});
test("[real file cache] corrupt typed evidence is neutral and needs explicit isolated quarantine before recovery", t => {
  const f = cacheFixture(t); f.put(); f.put(MODELS[1]); const file = f.resultFile(), corrupted = Buffer.from("{interrupted typed receipt"); fs.writeFileSync(file, corrupted);
  assert.equal(f.get().status, "unavailable"); assert.equal(f.get().record, null); assert.equal(f.get(MODELS[1]).status, "warm");
  assert.throws(() => f.put()); assert.deepEqual(fs.readFileSync(file), corrupted);
  const quarantine = path.join(f.privateRoot, "quarantine"); fs.mkdirSync(quarantine); const archived = path.join(quarantine, "controlled-corrupt-receipt.json");
  assert.ok(path.relative(f.privateRoot, archived) && !path.relative(f.privateRoot, archived).startsWith("..")); fs.renameSync(file, archived);
  assert.equal(f.get().status, "cold"); assert.equal(f.put().status, "warm"); assert.deepEqual(fs.readFileSync(archived), corrupted); assert.equal(f.cache.status({ track: f.track, source: f.source }).jointReady, true);
});
test("[real file cache] changed source bytes cannot recover through silent overwrite or borrow the other model", t => {
  const f = cacheFixture(t); f.put(); f.put(MODELS[1]); const file = path.join(f.directory, "sources", `${f.source.sourceSha256}.audio`);
  fs.writeFileSync(file, "controlled wrong source bytes"); const before = hash(fs.readFileSync(file));
  for (const analyzer of MODELS) assert.equal(f.get(analyzer).status, "unavailable"); assert.throws(() => f.put()); assert.equal(hash(fs.readFileSync(file)), before);
});
test("[real file cache] a stale held lock prevents ingestion while readers remain warm and never remove ownership", t => {
  const f = cacheFixture(t); f.put(); const lock = path.join(f.directory, ".ingest.lock"), owner = JSON.stringify({ token: "controlled-fixture-owner", pid: 0 }); fs.writeFileSync(lock, owner, { flag: "wx" });
  assert.equal(f.get().status, "warm"); assert.equal(f.get(MODELS[1]).status, "cold"); assert.throws(() => f.put(MODELS[1]), /EEXIST/); assert.equal(fs.readFileSync(lock, "utf8"), owner);
  // This test created the lock. A real stale lock needs a separate ownership audit.
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, "controlled-fixture-owner"); fs.unlinkSync(lock); assert.equal(f.put(MODELS[1]).status, "warm");
});
test("[fake worker process] one pending request rejects concurrency without stopping the first request", async t => {
  const h = workerHarness(t), first = h.worker.run("C:/private/fixture.audio", h.spec), child = h.latest(); child.send({ ready: true, pid: 23001 });
  await assert.rejects(h.worker.run("C:/private/another.audio", { runtime: "mert1" }), /concurrency is limited to one/);
  assert.equal(h.children.length, 1); assert.equal(child.kills, 0); h.finish({ ok: true }); assert.deepEqual(JSON.parse(JSON.stringify(await first)), { ok: true }); assert.equal(h.worker.pending, null);
});
test("[fake worker process] post-ready timeout requests exact Linux PID cleanup and a fresh worker can recover", async t => {
  const h = workerHarness(t), first = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(first, /timed out/), child = h.latest(); child.send({ ready: true, pid: 23002 });
  h.fire(100); await rejected; assert.equal(h.worker.child, null); assert.equal(h.worker.pending, null); assert.equal(child.kills, 1); assert.equal(child.stdinEnded, true);
  assert.deepEqual(Array.from(h.linuxKills()[0].args), ["-d", "Ubuntu", "--", "kill", "-TERM", "23002"]);
  const recovery = h.worker.run("C:/private/fixture.audio", h.spec), next = h.latest(); assert.notEqual(next, child); next.send({ ready: true, pid: 23003 }); h.finish({ recovered: true }); assert.deepEqual(JSON.parse(JSON.stringify(await recovery)), { recovered: true });
});
test("[fake worker process] pre-ready timeout lacks exact Linux PID cleanup and is not an orphan-free proof", async t => {
  const h = workerHarness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(pending, /timed out/), child = h.latest();
  h.fire(100); await rejected; assert.equal(child.kills, 1); assert.equal(child.linuxPid, undefined); assert.equal(h.linuxKills().length, 0); assert.equal(h.worker.child, null);
});
test("[fake worker process] pre-ready wrapper exit also has no confirmed Linux PID available", async t => {
  const h = workerHarness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(pending, /worker exited/), child = h.latest();
  child.emit("exit", 1); await rejected; assert.equal(child.linuxPid, undefined); assert.equal(h.linuxKills().length, 0); assert.equal(h.worker.pending, null); assert.equal(h.worker.child, null);
});
test("[fake worker process] stale replies and old process exits cannot settle a replacement request", async t => {
  const h = workerHarness(t), first = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(first, /Analysis stopped/), old = h.latest(); old.send({ ready: true, pid: 23004 }); const oldId = old.writes[0].id;
  h.worker.stop(); await rejected; const fresh = h.worker.run("C:/private/fixture.audio", h.spec), next = h.latest(), freshId = h.worker.pending.id;
  old.send({ id: oldId, result: { stale: true } }); old.emit("exit", 1); next.send({ id: "unknown-request", result: { wrong: true } }); next.stdout.write("not-json\n");
  assert.equal(h.worker.pending.id, freshId); assert.equal(h.worker.child, next); next.send({ ready: true, pid: 23005 }); h.finish({ fresh: true }); assert.deepEqual(JSON.parse(JSON.stringify(await fresh)), { fresh: true });
});
test("[fake worker process] an error response retains the worker until idle cleanup or explicit release", async t => {
  const h = workerHarness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(pending, error => error.code === "SONIC_RESOURCE_BUSY"), child = h.latest(); child.send({ ready: true, pid: 23006 });
  child.send({ id: child.writes[0].id, error: { message: "Synthetic resource-busy probe", code: "SONIC_RESOURCE_BUSY" } }); await rejected;
  assert.equal(h.worker.pending, null); assert.equal(h.worker.child, child); assert.equal(child.kills, 0); assert.equal(h.timers.size, 1); h.fire(50);
  assert.equal(h.worker.child, null); assert.equal(child.kills, 1); assert.equal(h.linuxKills()[0].args.at(-1), "23006");
});
test("[fake worker process] explicit cancellation rejects pending work, clears timers and permits a fresh request", async t => {
  const h = workerHarness(t), pending = h.worker.run("C:/private/fixture.audio", h.spec), rejected = assert.rejects(pending, /Analysis stopped/), child = h.latest(); child.send({ ready: true, pid: 23007 });
  h.worker.stop(); await rejected; assert.equal(h.timers.size, 0); assert.equal(child.kills, 1); assert.equal(h.linuxKills().length, 1);
  const later = h.worker.run("C:/private/fixture.audio", h.spec); h.latest().send({ ready: true, pid: 23008 }); h.finish({ afterCancellation: true }); assert.deepEqual(JSON.parse(JSON.stringify(await later)), { afterCancellation: true });
});
