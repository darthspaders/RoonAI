"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { createHash } = require("node:crypto");
const { SonicCatalogScoutCache, MODELS } = require("../src/sonicCatalogScoutCache");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { createPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), clone = value => structuredClone(value);
function fixture(id = 123, bytes = Buffer.from(`original-exact-preview-${id}`)) {
  const track = { identityKey: `tidal:${id}`, tidalId: String(id), artist: "Exact artist", title: `Recording ${id}`, mixVersion: "Original Mix", durationMs: 360000, isrc: `GBKQU${id}` };
  const source = freezeSonicSourceSnapshot({ track, audioBytes: bytes, sourceType: "beatport-preview", durationSeconds: 120.032653,
    sourceTrack: { id: String(id + 100000), artist: track.artist, title: track.title, mixName: track.mixVersion, durationMs: track.durationMs, isrc: track.isrc }, allowVersionProxy: false });
  const receipts = Object.fromEntries(MODELS.map(analyzer => {
    const spec = analysisSpec(analyzer), vector = Array(spec.dimensions).fill(0); vector[analyzer === MODELS[0] ? 0 : 1] = 1;
    const result = { specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate, vector, audioDurationSeconds: source.durationSeconds,
      analyzedSeconds: 30, sourceCoverage: 30 / source.durationSeconds, segments: [{ start: source.spans[0][0] - .000001, end: source.spans[0][1] - .000001, vector: [...vector] }] };
    return [analyzer, createPrivateResultReceipt(result, spec, source)];
  }));
  return { track, source, audioBytes: bytes, receipts };
}
function cacheFixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-scout-cache-")), privateRoot = path.join(temporary, "data"), directory = path.join(privateRoot, "cache");
  fs.mkdirSync(privateRoot); t.after(() => { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temporary, { recursive: true, force: true }); });
  return { temporary, privateRoot, directory, cache: new SonicCatalogScoutCache({ privateRoot, directory, ...options }) };
}
const request = (f, analyzer = MODELS[0]) => ({ track: f.track, source: f.source, analyzer });
const input = (f, analyzer = MODELS[0]) => ({ ...request(f, analyzer), receipt: f.receipts[analyzer], audioBytes: f.audioBytes });
function tree(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tree(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]);
}

test("constructing or reading a cold cache creates no files and never implies negative model evidence", t => {
  const c = cacheFixture(t), f = fixture(), before = tree(c.privateRoot), result = c.cache.get(request(f));
  assert.equal(result.status, "cold"); assert.equal(result.reason, "source-not-cached"); assert.equal(result.neutral, true); assert.equal(result.record, null); assert.equal(result.receipt, null);
  const status = c.cache.status({ track: f.track, source: f.source }); assert.equal(status.jointReady, false); assert.deepEqual(status.missingModels, MODELS); assert.equal(status.inferenceStarted, false);
  assert.equal(status.missingModelIsNegative, false); assert.deepEqual(tree(c.privateRoot), before); assert.equal(fs.existsSync(c.directory), false);
});
test("two warm spaces use one exact source and crop while retaining independent normalized vectors", t => {
  const c = cacheFixture(t), f = fixture(), before = clone(f);
  for (const analyzer of MODELS) { const put = c.cache.ingest(input(f, analyzer)); assert.equal(put.receiptCreated, true); assert.equal(put.sourceCreated, analyzer === MODELS[0]); assert.equal(put.runtimeDatabaseWrites, 0); }
  const records = MODELS.map(analyzer => c.cache.get(request(f, analyzer)));
  assert.ok(records.every(row => row.status === "warm" && !row.neutral && row.record.dimensions === 1024));
  for (const [index, row] of records.entries()) { const spec = analysisSpec(MODELS[index]); assert.equal(row.record.repo, spec.repo); assert.equal(row.record.specKey, spec.key); assert.equal(row.record.revision, spec.revision);
    assert.equal(row.record.identityKey, f.track.identityKey); assert.equal(row.record.sourceSnapshotKey, f.source.snapshotKey); assert.equal(row.record.sampleRate, 24000); assert.deepEqual(row.record.spans, f.source.spans);
    assert.deepEqual(row.receipt, f.receipts[MODELS[index]]); assert.ok(Object.isFrozen(row.record.vector)); }
  assert.notDeepEqual(records[0].record.vector, records[1].record.vector); assert.deepEqual(records[0].record.spans, records[1].record.spans);
  assert.deepEqual(c.cache.status({ track: f.track, source: f.source }).missingModels, []); assert.equal(c.cache.status({ track: f.track, source: f.source }).jointReady, true);
  assert.equal(tree(c.directory).filter(file => file.endsWith(".audio")).length, 1); assert.equal(tree(c.directory).filter(file => file.startsWith("results/")).length, 2); assert.deepEqual(clone(f), before);
});
test("a single warm model leaves the missing model cold and does not start its encoder", t => {
  const c = cacheFixture(t), f = fixture(); c.cache.ingest(input(f)); const before = tree(c.directory), status = c.cache.status({ track: f.track, source: f.source });
  assert.equal(status.status, "cold"); assert.equal(status.jointReady, false); assert.deepEqual(status.missingModels, [MODELS[1]]); assert.equal(status.models[1].reason, "model-not-cached");
  assert.equal(c.cache.get(request(f, MODELS[1])).record, null); assert.deepEqual(tree(c.directory), before);
});
test("ingestion is idempotent and never overwrites a different valid result for the same source and spec", t => {
  const c = cacheFixture(t), f = fixture(); c.cache.ingest(input(f)); const file = path.join(c.directory, "results", `${f.source.sourceSha256}-${analysisSpec(MODELS[0]).key}.json`), before = hash(fs.readFileSync(file));
  assert.equal(c.cache.ingest(input(f)).created, false);
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file)), null, 2) + "\n"); const formatted = hash(fs.readFileSync(file));
  assert.equal(c.cache.ingest(input(f)).created, false); assert.equal(hash(fs.readFileSync(file)), formatted);
  const changed = clone(f.receipts[MODELS[0]].result); changed.vector = Array(1024).fill(0); changed.vector[2] = 1; changed.segments[0].vector = [...changed.vector];
  assert.throws(() => c.cache.ingest({ ...input(f), receipt: createPrivateResultReceipt(changed, analysisSpec(MODELS[0]), f.source) }), /Conflicting/);
  assert.notEqual(formatted, before); assert.equal(hash(fs.readFileSync(file)), formatted); assert.equal(c.cache.get(request(f)).status, "warm"); assert.ok(tree(c.directory).every(file => !file.endsWith(".tmp")));
});
test("bytes, source, snapshot, model and output tampering fail before writing any new cache files", t => {
  const c = cacheFixture(t), f = fixture();
  const changes = [x => { x.audioBytes[0] ^= 1; }, x => { x.source.spans[0][0]++; }, x => { x.source.snapshotKey = `sonic-source-v1-${"a".repeat(64)}`; },
    x => { x.analyzer = "effnet-control"; }, x => { x.receipt.specKey = analysisSpec(MODELS[1]).key; }, x => { x.receipt.revision = "new-version"; },
    x => { x.receipt.result.vector[0] = .5; }, x => { x.track.mixVersion = "Named Remix"; }, x => { delete x.audioBytes; }];
  for (const change of changes) { const bad = clone(input(f)); change(bad); assert.throws(() => c.cache.ingest(bad)); assert.equal(fs.existsSync(c.directory), false); }
});
test("missing or corrupted audio, source metadata and typed results return neutral unavailable evidence", t => {
  const f = fixture();
  for (const kind of ["audio", "snapshot", "result"]) {
    const c = cacheFixture(t); c.cache.ingest(input(f));
    const file = kind === "audio" ? path.join(c.directory, "sources", `${f.source.sourceSha256}.audio`) : kind === "snapshot" ? path.join(c.directory, "sources", `${f.source.sourceSha256}.json`) : path.join(c.directory, "results", `${f.source.sourceSha256}-${analysisSpec(MODELS[0]).key}.json`);
    fs.writeFileSync(file, kind === "audio" ? "changed audio" : "{malformed-json"); const before = tree(c.directory), result = c.cache.get(request(f));
    assert.equal(result.status, "unavailable"); assert.equal(result.neutral, true); assert.equal(result.record, null); assert.equal(result.receipt, null); assert.deepEqual(tree(c.directory), before);
    assert.throws(() => c.cache.ingest(input(f)));
  }
  const c = cacheFixture(t); c.cache.ingest(input(f)); fs.unlinkSync(path.join(c.directory, "sources", `${f.source.sourceSha256}.audio`));
  assert.equal(c.cache.get(request(f)).reason, "incomplete-source-cache");
});
test("an internally plausible changed vector is unavailable when its original result digest no longer matches", t => {
  const c = cacheFixture(t), f = fixture(); c.cache.ingest(input(f)); const file = path.join(c.directory, "results", `${f.source.sourceSha256}-${analysisSpec(MODELS[0]).key}.json`), receipt = JSON.parse(fs.readFileSync(file));
  receipt.result.vector[0] = 0; receipt.result.vector[3] = 1; receipt.result.segments[0].vector = [...receipt.result.vector]; fs.writeFileSync(file, JSON.stringify(receipt));
  assert.equal(c.cache.get(request(f)).status, "unavailable"); assert.equal(c.cache.get(request(f)).record, null);
});
test("same audio labeled as another exact identity or named remix cannot reuse or replace the first snapshot", t => {
  const c = cacheFixture(t), f = fixture(); c.cache.ingest(input(f)); const renamed = fixture(456, f.audioBytes);
  assert.equal(renamed.source.sourceSha256, f.source.sourceSha256); assert.notEqual(renamed.source.snapshotKey, f.source.snapshotKey);
  assert.equal(c.cache.get(request(renamed)).status, "unavailable"); assert.throws(() => c.cache.ingest(input(renamed)), /Conflicting/); assert.equal(c.cache.get(request(f)).status, "warm");
  const named = { ...f.track, mixVersion: "Named Remix" }, source = freezeSonicSourceSnapshot({ track: named, audioBytes: f.audioBytes, sourceType: "beatport-preview", durationSeconds: f.source.durationSeconds,
    sourceTrack: { ...f.source.sourceTrack, mixName: "Named Remix" }, allowVersionProxy: false });
  assert.equal(c.cache.get({ track: named, source, analyzer: MODELS[0] }).status, "unavailable");
});
test("distinct named versions retain separate source hashes and cache entries", t => {
  const c = cacheFixture(t), first = fixture(), second = fixture(456); second.track.mixVersion = "Named Remix";
  second.source = freezeSonicSourceSnapshot({ track: second.track, audioBytes: second.audioBytes, sourceType: "beatport-preview", durationSeconds: 120.032653,
    sourceTrack: { ...second.source.sourceTrack, mixName: "Named Remix" }, allowVersionProxy: false });
  for (const model of MODELS) second.receipts[model] = createPrivateResultReceipt(second.receipts[model].result, analysisSpec(model), second.source);
  c.cache.ingest(input(first)); c.cache.ingest(input(second)); assert.equal(c.cache.get(request(first)).status, "warm"); assert.equal(c.cache.get(request(second)).status, "warm");
  assert.equal(tree(c.directory).filter(file => file.endsWith(".audio")).length, 2);
});
test("source capacity counts distinct sources, permits the second model, and rejects expansion without partial files", t => {
  const c = cacheFixture(t, { maxSources: 1 }), first = fixture(), second = fixture(456); c.cache.ingest(input(first)); c.cache.ingest(input(first, MODELS[1])); const before = tree(c.directory);
  assert.throws(() => c.cache.ingest(input(second)), /source limit/); assert.deepEqual(tree(c.directory), before); assert.equal(c.cache.get(request(second)).status, "cold");
  for (const maxSources of [0, 101, 1.5]) assert.throws(() => new SonicCatalogScoutCache({ privateRoot: c.privateRoot, directory: c.directory, maxSources }));
});
test("a held ingest lock prevents concurrent cache expansion and reads preserve its owner", t => {
  const c = cacheFixture(t), f = fixture(); c.cache.ingest(input(f));
  const lock = path.join(c.directory, ".ingest.lock"), owner = JSON.stringify({ token: "other-exact-owner", pid: 123 }); fs.writeFileSync(lock, owner);
  const before = tree(c.directory); assert.throws(() => c.cache.ingest(input(f, MODELS[1])), /EEXIST/);
  assert.equal(c.cache.get(request(f)).status, "warm"); assert.equal(c.cache.get(request(f, MODELS[1])).status, "cold");
  assert.equal(fs.readFileSync(lock, "utf8"), owner); assert.deepEqual(tree(c.directory), before);
});
test("unsafe cache roots and later junction substitutions fail closed without touching external files", t => {
  const c = cacheFixture(t), outside = path.join(c.temporary, "outside"); fs.mkdirSync(outside); const sentinel = path.join(outside, "sentinel.json"); fs.writeFileSync(sentinel, "preserve");
  for (const directory of [c.privateRoot, outside, "../outside"]) assert.throws(() => new SonicCatalogScoutCache({ privateRoot: c.privateRoot, directory }));
  fs.symlinkSync(outside, path.join(c.privateRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new SonicCatalogScoutCache({ privateRoot: c.privateRoot, directory: "escape/cache" }));
  const f = fixture(); c.cache.ingest(input(f)); const resultDirectory = path.join(c.directory, "results"); fs.renameSync(resultDirectory, path.join(c.directory, "preserved-results"));
  fs.symlinkSync(outside, resultDirectory, process.platform === "win32" ? "junction" : "dir");
  assert.equal(c.cache.get(request(f)).status, "unavailable"); assert.throws(() => c.cache.ingest(input(f))); assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve"); assert.deepEqual(fs.readdirSync(outside), ["sentinel.json"]);
});
test("oversized receipt files and unsupported source types remain unavailable instead of being consumed", t => {
  const c = cacheFixture(t), f = fixture(); c.cache.ingest(input(f)); const file = path.join(c.directory, "results", `${f.source.sourceSha256}-${analysisSpec(MODELS[0]).key}.json`);
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 32)); assert.equal(c.cache.get(request(f)).status, "unavailable");
  const source = freezeSonicSourceSnapshot({ track: f.track, audioBytes: f.audioBytes, sourceType: "verified-local-file", durationSeconds: 120.032653, localFileId: "exact-local-123", linkStatus: "EXACT" });
  assert.equal(c.cache.get({ track: f.track, source, analyzer: MODELS[0] }).status, "unavailable"); assert.throws(() => c.cache.ingest({ ...input(f), source }));
});
