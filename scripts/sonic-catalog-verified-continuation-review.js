"use strict";

// Additive preparation for one declared, complete, diverse two-genre study.
// No provider discovery, live-server imports, playback or runtime DB writes.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto"), { performance } = require("node:perf_hooks");
const { analysisSpec } = require("../src/sonicAnalysisSpec"), SPEC = analysisSpec("mert-30s");
const { OwnedOperationalWorker, OWNERSHIP_SCRIPT } = require("../src/sonicCatalogScoutOperationalWorker");
const { assertSonicSourceSnapshot, createVerifiedResultReceipt, readVerifiedResultReceipt } = require("../src/sonicCatalogVerifiedSource");
const review = require("../src/sonicCatalogVerifiedReview"), host = require("./sonic-catalog-verified-review-host");
const { validateWave } = require("./sonic-prepare-blind-review"), { wslPath } = require("../src/sonicAnalysisWorker");
const ROOT = path.resolve(__dirname, ".."), SCRIPT = "scripts/sonic-catalog-verified-continuation-review.js";
const SOURCE_COUNT = 16, ANCHOR_COUNT = 4, MAX_PAIRS = 12;
const STAGES = Object.freeze(["seal", "check", "encode", "select", "audio", "prepare", "serve"]);
const INPUTS = Object.freeze(["pool.json", "request.json", "review-request.json", "continuation-seed.json", "seed-finalization.json", "predeclaration.json", "collection-code-receipt.json", "collection.json", "collection-evidence.json", "coverage-audit.json", "breadth-audit.json", "preservation-before.json"]);
function runtime() { return require("./sonic-catalog-scout-verified-continuation"); }
function argumentsFor(argv) {
  const [stage, ...args] = argv; assert.ok(STAGES.includes(stage), "Choose a declared preparation stage.");
  const result = { stage, port: 3791 };
  if (args.length) { assert.equal(stage, "serve"); assert.equal(args.length, 2); assert.equal(args[0], "--port"); result.port = Number(args[1]); }
  assert.ok(Number.isInteger(result.port) && result.port >= 1024 && result.port <= 65535 && ![3777, 3789, 3790, 3797].includes(result.port), "Choose a separate localhost listening port.");
  return result;
}
function binding(name, rt = runtime()) { const file = rt.ownedPath(path.join(rt.DIRECTORY, name)); return { file, sha256: rt.sha(fs.readFileSync(file)) }; }
function codeReceipt(rt = runtime()) {
  const rows = [...rt.pins().files, ...review.verifiedReviewCodeReceipt().files, ...host.hostCode().files,
    ...[SCRIPT, "scripts/sonic-catalog-verified-continuation-phone-gateway.js"].map(file => ({ path: file, sha256: rt.sha(fs.readFileSync(path.join(ROOT, file))) }))], map = new Map();
  for (const row of rows) { if (map.has(row.path)) assert.equal(map.get(row.path).sha256, row.sha256); map.set(row.path, row); }
  assert.ok(map.size <= 100, "The frozen code receipt exceeds the existing review bound.");
  return { files: [...map.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
function completeCollection(rt = runtime()) {
  const context = rt.checkCollection();
  assert.ok(context.sourceRequest && context.request && context.sourceRequest !== context.request,
    "The continuation gate must separately verify the full source request and its five-source review exception view.");
  assert.equal(context.pool.samplingScope ?? "two-genre", "two-genre"); assert.equal(context.pool.entries.length, SOURCE_COUNT); assert.equal(context.pool.requests.length, ANCHOR_COUNT);
  review.validatePool(context.pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(context.pool, context.request);
  require("../src/sonicCatalogVerifiedCollector").validateVerifiedCollectionBreadth(context.collection, { requireComplete: true });
  const declaration = rt.read(path.join(rt.DIRECTORY, "predeclaration.json"));
  assert.equal(declaration.maximumModelRuns, SOURCE_COUNT); assert.equal(declaration.maximumBlindPairs, MAX_PAIRS); assert.equal(declaration.productionApplied, false);
  return context;
}
function productionSnapshot(pool, rt = runtime()) {
  const baseline = rt.read(path.join(rt.DIRECTORY, "preservation-before.json")), before = baseline.snapshot || baseline;
  const { readTasteClusterProfiles } = require("../src/tasteClusterScoring"), { candidateIdentityKeys } = require("../src/recommendationV2Discovery"), { decodeVector } = require("../src/sonicEmbeddingStore");
  return rt.withDb(db => ({ model: "discogs-effnet", modelVersion: "1", mode: before.production.productionMode, maxAdjustment: before.production.maxAdjustment, minCoverage: before.production.minCoverage, minScored: before.production.minScored,
    profiles: readTasteClusterProfiles(db, { model: "discogs-effnet", modelVersion: "1", status: "" }),
    embeddings: [...new Set(pool.entries.flatMap(entry => candidateIdentityKeys(entry.track)))].flatMap(identity => {
      const row = db.prepare("SELECT identity_key,dimensions,embedding_base64,source_sha256 FROM track_sonic_profile WHERE identity_key=? AND model='discogs-effnet' AND model_version='1'").get(identity);
      return row ? [[identity, { identityKey: row.identity_key, dimensions: row.dimensions, vector: decodeVector(row.embedding_base64), sourceSha256: row.source_sha256 }]] : [];
    })
  }));
}
function seal() {
  const rt = runtime(), { pool } = completeCollection(rt); rt.guard("before-verified-encoding-seal");
  assert.ok(!fs.existsSync(path.join(rt.DIRECTORY, "encoding-plan.json")), "Preserve the existing encoding declaration.");
  assert.ok(!fs.existsSync(path.join(rt.DIRECTORY, "inference-attempts.json")), "Do not reseal an attempted study.");
  rt.save(path.join(rt.DIRECTORY, "production-snapshot.json"), productionSnapshot(pool, rt));
  rt.save(path.join(rt.DIRECTORY, "encoding-plan.json"), { version: 1, at: new Date().toISOString(), model: SPEC, samplingScope: "two-genre", maximumModelRuns: SOURCE_COUNT, sourceCount: SOURCE_COUNT, maximumBlindPairs: MAX_PAIRS,
    inputs: Object.fromEntries(INPUTS.map(name => [name, binding(name, rt)])), productionSnapshot: binding("production-snapshot.json", rt), code: codeReceipt(rt), productionApplied: false });
  return { sealed: true, sourceCount: SOURCE_COUNT, encoder: "mert-30s", maximumModelRuns: SOURCE_COUNT, maximumBlindPairs: MAX_PAIRS };
}
function check() {
  const rt = runtime(), plan = rt.read(rt.ownedPath(path.join(rt.DIRECTORY, "encoding-plan.json")));
  assert.equal(plan.version, 1); assert.equal(plan.maximumModelRuns, SOURCE_COUNT); assert.equal(plan.sourceCount, SOURCE_COUNT); assert.equal(plan.maximumBlindPairs, MAX_PAIRS);
  assert.equal(plan.samplingScope, "two-genre"); assert.deepEqual(plan.model, SPEC); assert.equal(plan.productionApplied, false); assert.deepEqual(plan.code, codeReceipt(rt));
  assert.deepEqual(Object.keys(plan.inputs).sort(), [...INPUTS].sort());
  for (const [name, pinned] of [...Object.entries(plan.inputs), ["production-snapshot.json", plan.productionSnapshot]]) {
    assert.deepEqual(pinned, binding(name, rt), "A sealed study artifact changed.");
  }
  const context = completeCollection(rt); return { ...context, plan, productionSnapshot: rt.read(plan.productionSnapshot.file) };
}
function ownershipProbe(owner, operation, targets = []) {
  return new Promise((resolve, reject) => execFile("wsl.exe", ["-d", "Ubuntu", "--", "/usr/bin/python3", "-c", OWNERSHIP_SCRIPT, owner, operation, JSON.stringify(targets)], { windowsHide: true, timeout: 5000, maxBuffer: 131072 }, (error, stdout) => {
    if (error) return reject(Error("Owned process inspection failed.")); try { resolve(JSON.parse(stdout)); } catch { reject(Error("Owned process inspection returned malformed evidence.")); }
  }));
}
const ownership = { list: owner => ownershipProbe(owner, "list"), signal: (owner, targets, signal) => ownershipProbe(owner, signal, targets) };
function gpuGuard(label) {
  const rt = runtime(), receipt = rt.guard(label);
  receipt.gpuFreeMiB = Number(execFileSync("nvidia-smi", ["--id=0", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10000, encoding: "utf8" }).trim());
  assert.ok(receipt.gpuFreeMiB >= 6144); rt.save(rt.ownedPath(path.join(rt.DIRECTORY, "guards", label + "-gpu-" + Date.now() + ".json")), receipt); return receipt;
}
function witnessRequest(message, worker, child, item, entry) {
  assert.equal(worker.child, child); assert.equal(item.submitted, false); assert.equal(message.id, worker.pending?.id); assert.deepEqual(message.spec, SPEC);
  assert.equal(message.file, process.platform === "win32" ? wslPath(entry.sourceFile) : entry.sourceFile);
}
function assertCompleteLedger(ledger, pool) {
  assert.ok(Array.isArray(ledger) && ledger.length === SOURCE_COUNT && pool.entries.length === SOURCE_COUNT);
  const entries = new Map(pool.entries.map(entry => [entry.track.identityKey, entry])); assert.equal(entries.size, SOURCE_COUNT); const seen = new Set(), requests = new Set();
  for (const row of ledger) {
    const entry = entries.get(row.identityKey); assert.ok(entry && !seen.has(row.identityKey)); seen.add(row.identityKey);
    assert.equal(row.analyzer, "mert-30s"); assert.equal(row.sourceSnapshotKey, entry.source.snapshotKey);
    assert.equal(row.submitted, true); assert.equal(row.acknowledged, true); assert.equal(row.status, "complete");
    assert.ok(typeof row.requestId === "string" && row.requestId && !requests.has(row.requestId) && Number.isFinite(Date.parse(row.submittedAt)) && row.receipt?.file && /^[a-f0-9]{64}$/.test(row.receipt.sha256)); requests.add(row.requestId);
  }
  return true;
}
async function encode() {
  const rt = runtime(), { plan, pool } = check(), ledgerFile = path.join(rt.DIRECTORY, "inference-attempts.json"), ledger = [];
  assert.ok(!fs.existsSync(ledgerFile), "No repeat of an interrupted or completed encoding declaration.");
  const before = gpuGuard("verified-encoding-before"), worker = new OwnedOperationalWorker({ timeoutMs: 120000, ownership }); let ready;
  rt.save(ledgerFile, ledger);
  try {
    worker.start(SPEC.runtime); ready = await worker.awaitReady(); assert.equal(ready.ownerVerified, true);
    for (const entry of pool.entries) {
      check(); rt.guard("verified-encode-" + (ledger.length + 1)); assert.ok(ledger.length < plan.maximumModelRuns);
      const item = { analyzer: "mert-30s", identityKey: entry.track.identityKey, sourceSnapshotKey: entry.source.snapshotKey, at: new Date().toISOString(), submitted: false, acknowledged: false, status: "started" };
      ledger.push(item); rt.update(ledgerFile, ledger);
      const child = worker.child, original = child.stdin.write;
      child.stdin.write = function (chunk, ...args) {
        const message = JSON.parse(String(chunk)); witnessRequest(message, worker, child, item, entry);
        const result = original.call(this, chunk, ...args); item.submitted = true; item.requestId = message.id; item.submittedAt = new Date().toISOString(); rt.update(ledgerFile, ledger); return result;
      };
      const started = performance.now();
      try {
        const result = await worker.run(entry.sourceFile, SPEC); item.acknowledged = true;
        assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(rt.ownedPath(entry.sourceFile)) });
        const receipt = createVerifiedResultReceipt(result, SPEC, entry.source); readVerifiedResultReceipt(receipt, SPEC, entry.source);
        const target = rt.ownedPath(path.join(rt.DIRECTORY, "result-" + ledger.length + ".json")); rt.save(target, receipt);
        item.receipt = { file: target, sha256: rt.sha(fs.readFileSync(target)) }; item.timings = result.timings; item.status = "complete";
      } catch (error) { item.status = "failed"; item.errorCode = error.code || "untyped-error"; throw error; }
      finally { child.stdin.write = original; item.elapsedMs = performance.now() - started; rt.update(ledgerFile, ledger); check(); console.log(JSON.stringify({ encoder: "mert-30s", completed: ledger.filter(row => row.status === "complete").length, submitted: ledger.filter(row => row.submitted).length, elapsedMs: item.elapsedMs })); }
    }
  } finally {
    const release = await worker.release(); rt.save(path.join(rt.DIRECTORY, "worker-release.json"), release);
    const after = gpuGuard("verified-encoding-after"); assert.ok(after.gpuFreeMiB >= before.gpuFreeMiB - 128);
    rt.save(path.join(rt.DIRECTORY, "encoding-gpu-closure.json"), { beforeFreeMiB: before.gpuFreeMiB, afterFreeMiB: after.gpuFreeMiB, ready, release, restored: true });
  }
  check(); assertCompleteLedger(ledger, pool);
  rt.save(path.join(rt.DIRECTORY, "encoding-audit.json"), { passed: true, sourceEncodes: SOURCE_COUNT, submitted: SOURCE_COUNT, acknowledged: SOURCE_COUNT, typedReceipts: SOURCE_COUNT, analyzer: "mert-30s", samplingScope: "two-genre", localLibraryAudio: false, productionApplied: false });
}
async function select() {
  const rt = runtime(), { plan, pool, request, productionSnapshot: snapshot } = check(), ledger = rt.read(path.join(rt.DIRECTORY, "inference-attempts.json"));
  assert.equal(rt.read(path.join(rt.DIRECTORY, "encoding-audit.json")).passed, true); assertCompleteLedger(ledger, pool);
  assert.ok(!fs.existsSync(path.join(rt.DIRECTORY, "selections.json")), "Preserve the original frozen selections.");
  const receipts = new Map(ledger.map(row => {
    rt.ownedPath(row.receipt.file); assert.equal(rt.sha(fs.readFileSync(row.receipt.file)), row.receipt.sha256);
    const receipt = rt.read(row.receipt.file), entry = pool.entries.find(value => value.track.identityKey === row.identityKey); readVerifiedResultReceipt(receipt, SPEC, entry.source); return [row.identityKey, receipt];
  }));
  const selections = await review.buildVerifiedCatalogScoutSelections({ pool, receipts, request, tasteSnapshot: request.tasteSnapshot, historySnapshot: request.historySnapshot, productionSnapshot: snapshot, code: plan.code });
  check(); assert.equal(selections.requests.length, ANCHOR_COUNT); assert.ok(selections.requests.every(row => row.tracks.length > 0), "Every sampling anchor needs at least one actual final selection.");
  rt.save(path.join(rt.DIRECTORY, "selections.json"), selections);
  const reviewPlan = review.buildVerifiedCatalogReviewPlan({ roundId: "continuation-30s-20261008", title: "Fresh catalog listening review", pool: plan.inputs["pool.json"], request: plan.inputs["review-request.json"], selections: binding("selections.json", rt) });
  assert.ok(reviewPlan && reviewPlan.anchorCount === ANCHOR_COUNT && reviewPlan.count <= MAX_PAIRS && Object.keys(reviewPlan.clips).length <= SOURCE_COUNT, "No partial or fabricated review.");
  rt.save(path.join(rt.DIRECTORY, "review-plan.json"), reviewPlan);
  return { reviewPrepared: true, anchors: reviewPlan.anchorCount, listeningPairs: reviewPlan.count, productionApplied: false };
}
function validateReviewPlan(plan, options = {}) {
  const context = check(); assert.deepEqual(plan.pool, context.plan.inputs["pool.json"]); assert.deepEqual(plan.request, context.plan.inputs["review-request.json"]);
  assert.equal(plan.anchorCount, ANCHOR_COUNT); assert.ok(plan.count > 0 && plan.count <= MAX_PAIRS && Object.keys(plan.clips || {}).length <= SOURCE_COUNT);
  return review.validateVerifiedCatalogReviewPlan(plan, options);
}
function audio() {
  const rt = runtime(), planFile = path.join(rt.DIRECTORY, "review-plan.json"), plan = rt.read(planFile), cacheDirectory = path.join(rt.DIRECTORY, "blind-audio");
  assert.ok(!fs.existsSync(path.join(rt.DIRECTORY, "publication.json")), "An already published listening plan cannot be altered.");
  rt.withDb(db => validateReviewPlan(plan, { db, artifactRoot: ROOT }));
  rt.guard("before-verified-listening-audio"); fs.mkdirSync(cacheDirectory, { recursive: true }); rt.ownedPath(cacheDirectory);
  rt.save(path.join(rt.DIRECTORY, "review-plan-unprepared.json"), plan);
  for (const clip of Object.values(plan.clips)) {
    rt.ownedPath(clip.sourceFile); assert.equal(rt.sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256);
    const target = rt.ownedPath(path.join(cacheDirectory, clip.clipId + ".wav")); assert.ok(!fs.existsSync(target));
    execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffmpeg", "-v", "error", "-nostdin", "-i", wslPath(clip.sourceFile), "-ss", String(clip.start), "-t", String(clip.end - clip.start), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-n", wslPath(target)], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(rt.sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256); validateWave(target, clip); clip.wavSha256 = rt.sha(fs.readFileSync(target)); rt.update(planFile, plan);
  }
  rt.withDb(db => validateReviewPlan(plan, { db, requirePrepared: true, cacheDirectory, artifactRoot: ROOT }));
  rt.save(path.join(rt.DIRECTORY, "audio-preparation.json"), { passed: true, at: new Date().toISOString(), preparedClips: Object.keys(plan.clips).length, pairs: plan.count, format: "PCM16 mono 24000Hz", spanSeconds: 30, reviewPlanSha256: rt.sha(fs.readFileSync(planFile)), published: false, playbackInvoked: false, mainDatabaseWrites: 0 });
  return { audioPrepared: true, uniqueClips: Object.keys(plan.clips).length, pairs: plan.count, published: false };
}
function prepare() { const rt = runtime(); check(); rt.guard("before-verified-private-publication"); return host.prepareReview({ directory: rt.DIRECTORY, validatePlan: validateReviewPlan }); }
async function serve(port = 3791) { const rt = runtime(); check(); return host.startHost({ directory: rt.DIRECTORY, port, validatePlan: validateReviewPlan }); }
async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.stage === "check") { const context = check(); console.log(JSON.stringify({ valid: true, sources: context.pool.entries.length, maximumModelRuns: SOURCE_COUNT, productionApplied: false })); return; }
  if (options.stage === "serve") {
    const listening = await serve(options.port); console.log(JSON.stringify({ listeningHost: true, url: listening.url, count: listening.context.plan.count, productionApplied: false }));
    let stopping = false; const stop = async () => { if (stopping) return; stopping = true; try { await listening.close(); } catch { process.exitCode = 1; } }; process.once("SIGINT", stop); process.once("SIGTERM", stop); return;
  }
  const rt = runtime(), lock = options.stage === "audio" || options.stage === "prepare" ? path.join(ROOT, "data/sonic-blind-preparation.lock") : path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID();
  rt.save(lock, { token, pid: process.pid, stage: options.stage, directory: rt.DIRECTORY });
  try { const result = await ({ seal, encode, select, audio, prepare })[options.stage](); if (result) console.log(JSON.stringify(result)); }
  finally { assert.equal(rt.read(lock).token, token); fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(() => { console.error("The declared verified review stage failed; private receipts retained without an automatic retry."); process.exitCode = 1; });
module.exports = { main, argumentsFor, codeReceipt, completeCollection, check, seal, encode, select, audio, prepare, serve, validateReviewPlan, witnessRequest, assertCompleteLedger, SPEC, SOURCE_COUNT, ANCHOR_COUNT, MAX_PAIRS };
