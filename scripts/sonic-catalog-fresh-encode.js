"use strict";
// Only eight presealed exact preview encodes, one pinned 30s model. Publication
// and user decisions are separate; this process owns no playback or live jobs.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto"), { performance } = require("node:perf_hooks");
const fresh = require("./sonic-catalog-scout-fresh");
const { ROOT, DIRECTORY, sha, read, save, update, ownedPath, withDb } = fresh;
const { analysisSpec } = require("../src/sonicAnalysisSpec"), SPEC = analysisSpec("mert-30s");
const { OwnedOperationalWorker, OWNERSHIP_SCRIPT } = require("../src/sonicCatalogScoutOperationalWorker");
const { assertSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { createPrivateResultReceipt, readPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const review = require("../src/sonicCatalogFreshReview");
function codeReceipt() {
  const rows = [...fresh.pins().files, ...review.freshReviewCodeReceipt().files, { path: "scripts/sonic-catalog-fresh-encode.js", sha256: sha(fs.readFileSync(__filename)) }], map = new Map();
  for (const row of rows) { if (map.has(row.path)) assert.equal(map.get(row.path).sha256, row.sha256); map.set(row.path, row); }
  assert.ok(map.size <= 100); return { files: [...map.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
const binding = name => ({ file: path.join(DIRECTORY, name), sha256: sha(fs.readFileSync(path.join(DIRECTORY, name))) });
function productionSnapshot(pool) {
  const before = read(path.join(DIRECTORY, "preservation-before.json")), { readTasteClusterProfiles } = require("../src/tasteClusterScoring"), { candidateIdentityKeys } = require("../src/recommendationV2Discovery"), { decodeVector } = require("../src/sonicEmbeddingStore");
  return withDb(db => ({ model: "discogs-effnet", modelVersion: "1", mode: before.production.productionMode, maxAdjustment: before.production.maxAdjustment, minCoverage: before.production.minCoverage, minScored: before.production.minScored,
    profiles: readTasteClusterProfiles(db, { model: "discogs-effnet", modelVersion: "1", status: "" }),
    embeddings: [...new Set(pool.entries.flatMap(entry => candidateIdentityKeys(entry.track)))].flatMap(identity => { const row = db.prepare("SELECT identity_key,dimensions,embedding_base64,source_sha256 FROM track_sonic_profile WHERE identity_key=? AND model='discogs-effnet' AND model_version='1'").get(identity); return row ? [[identity, { identityKey: row.identity_key, dimensions: row.dimensions, vector: decodeVector(row.embedding_base64), sourceSha256: row.source_sha256 }]] : []; })
  }));
}
function seal() {
  const pool = read(path.join(DIRECTORY, "scoped-pool.json")), request = read(path.join(DIRECTORY, "scoped-request.json"));
  review.validatePool(pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(pool, request);
  assert.equal(read(path.join(DIRECTORY, "scoped-coverage-audit.json")).scopeGate, true); assert.equal(pool.samplingScope, "raw-techno-only"); assert.equal(pool.entries.length, 8);
  const snapshot = productionSnapshot(pool); save(path.join(DIRECTORY, "production-snapshot.json"), snapshot);
  save(path.join(DIRECTORY, "encoding-plan.json"), { version: 1, at: new Date().toISOString(), model: SPEC, samplingScope: "raw-techno-only", maximumModelRuns: 8, sourceCount: 8,
    pool: binding("scoped-pool.json"), request: binding("scoped-request.json"), productionSnapshot: binding("production-snapshot.json"), coverage: binding("scoped-coverage-audit.json"), code: codeReceipt(), productionApplied: false });
  console.log(JSON.stringify({ sealed: true, sourceCount: 8, encoder: "mert-30s", maximumModelRuns: 8 }));
}
function check() {
  const plan = read(path.join(DIRECTORY, "encoding-plan.json")); assert.equal(plan.maximumModelRuns, 8); assert.equal(plan.samplingScope, "raw-techno-only"); assert.deepEqual(plan.model, SPEC); assert.equal(plan.productionApplied, false); assert.deepEqual(plan.code, codeReceipt());
  for (const key of ["pool", "request", "productionSnapshot", "coverage"]) { ownedPath(plan[key].file); assert.equal(sha(fs.readFileSync(plan[key].file)), plan[key].sha256); }
  const pool = read(plan.pool.file), request = read(plan.request.file); review.validatePool(pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(pool, request);
  return { plan, pool, request, productionSnapshot: read(plan.productionSnapshot.file) };
}
function ownershipProbe(owner, operation, targets = []) {
  return new Promise((resolve, reject) => execFile("wsl.exe", ["-d", "Ubuntu", "--", "/usr/bin/python3", "-c", OWNERSHIP_SCRIPT, owner, operation, JSON.stringify(targets)], { windowsHide: true, timeout: 5000, maxBuffer: 131072 }, (error, stdout) => {
    if (error) return reject(Error("Owned process inspection failed.")); try { resolve(JSON.parse(stdout)); } catch { reject(Error("Owned process inspection returned malformed evidence.")); }
  }));
}
const ownership = { list: owner => ownershipProbe(owner, "list"), signal: (owner, targets, signal) => ownershipProbe(owner, signal, targets) };
function gpuGuard(label) {
  const guard = fresh.guard(label); guard.gpuFreeMiB = Number(execFileSync("nvidia-smi", ["--id=0", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10000, encoding: "utf8" }).trim()); assert.ok(guard.gpuFreeMiB >= 6144);
  save(path.join(DIRECTORY, "guards", label + "-gpu-" + Date.now() + ".json"), guard); return guard;
}
async function encode() {
  const { plan, pool } = check(), ledgerFile = path.join(DIRECTORY, "inference-attempts.json"), ledger = [];
  assert.ok(!fs.existsSync(ledgerFile), "No repeat of an interrupted or completed encoding declaration");
  const before = gpuGuard("encoding-before"), worker = new OwnedOperationalWorker({ timeoutMs: 120000, ownership }); let ready, release;
  save(ledgerFile, ledger);
  try {
    worker.start(SPEC.runtime); ready = await worker.awaitReady(); assert.equal(ready.ownerVerified, true);
    for (const entry of pool.entries) {
      check(); fresh.guard("encode-" + (ledger.length + 1)); assert.ok(ledger.length < plan.maximumModelRuns);
      const item = { analyzer: "mert-30s", identityKey: entry.track.identityKey, sourceSnapshotKey: entry.source.snapshotKey, at: new Date().toISOString(), submitted: false, acknowledged: false, status: "started" };
      ledger.push(item); update(ledgerFile, ledger);
      const child = worker.child, original = child.stdin.write, { wslPath } = require("../src/sonicAnalysisWorker");
      child.stdin.write = function (chunk, ...args) {
        const message = JSON.parse(String(chunk)); assert.equal(worker.child, child); assert.equal(item.submitted, false); assert.equal(message.id, worker.pending?.id); assert.deepEqual(message.spec, SPEC); assert.equal(message.file, process.platform === "win32" ? wslPath(entry.sourceFile) : entry.sourceFile);
        const result = original.call(this, chunk, ...args); item.submitted = true; item.requestId = message.id; item.submittedAt = new Date().toISOString(); update(ledgerFile, ledger); return result;
      };
      const started = performance.now();
      try {
        const result = await worker.run(entry.sourceFile, SPEC); item.acknowledged = true;
        assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(ownedPath(entry.sourceFile)) });
        const receipt = createPrivateResultReceipt(result, SPEC, entry.source); readPrivateResultReceipt(receipt, SPEC, entry.source);
        const target = path.join(DIRECTORY, "result-" + ledger.length + ".json"); save(target, receipt);
        item.receipt = { file: target, sha256: sha(fs.readFileSync(target)) }; item.timings = result.timings; item.status = "complete";
      } catch (error) { item.status = "failed"; item.errorCode = error.code || "untyped-error"; throw error; }
      finally { child.stdin.write = original; item.elapsedMs = performance.now() - started; update(ledgerFile, ledger); check(); console.log(JSON.stringify({ encoder: "mert-30s", completed: ledger.filter(row => row.status === "complete").length, submitted: ledger.filter(row => row.submitted).length, elapsedMs: item.elapsedMs })); }
    }
  } finally {
    release = await worker.release(); save(path.join(DIRECTORY, "worker-release.json"), release);
    const after = gpuGuard("encoding-after"); assert.ok(after.gpuFreeMiB >= before.gpuFreeMiB - 128);
    save(path.join(DIRECTORY, "encoding-gpu-closure.json"), { beforeFreeMiB: before.gpuFreeMiB, afterFreeMiB: after.gpuFreeMiB, ready, release, restored: true });
  }
  check(); assert.equal(ledger.length, 8); assert.ok(ledger.every(row => row.submitted && row.acknowledged && row.status === "complete"));
  save(path.join(DIRECTORY, "encoding-audit.json"), { passed: true, sourceEncodes: 8, submitted: 8, acknowledged: 8, typedReceipts: 8, analyzer: "mert-30s", samplingScope: "raw-techno-only", localLibraryAudio: false, productionApplied: false });
}
async function select() {
  const { plan, pool, request, productionSnapshot: snapshot } = check(), ledger = read(path.join(DIRECTORY, "inference-attempts.json"));
  assert.equal(read(path.join(DIRECTORY, "encoding-audit.json")).passed, true);
  const receipts = new Map(ledger.map(row => { assert.equal(row.status, "complete"); ownedPath(row.receipt.file); assert.equal(sha(fs.readFileSync(row.receipt.file)), row.receipt.sha256); return [row.identityKey, read(row.receipt.file)]; }));
  const selections = await review.buildFreshCatalogScoutSelections({ pool, receipts, request, tasteSnapshot: request.tasteSnapshot, historySnapshot: request.historySnapshot, productionSnapshot: snapshot });
  check(); save(path.join(DIRECTORY, "selections.json"), selections);
  const reviewPlan = review.buildFreshCatalogReviewPlan({ roundId: "fresh-30s-20261008", title: "Fresh catalog listening review", pool: plan.pool, request: plan.request, selections: binding("selections.json") });
  assert.ok(reviewPlan, "No final selections; do not fabricate a review"); save(path.join(DIRECTORY, "review-plan.json"), reviewPlan);
  console.log(JSON.stringify({ reviewPrepared: true, anchors: reviewPlan.anchorCount, listeningPairs: reviewPlan.count, productionApplied: false }));
}
async function main(argv = process.argv.slice(2)) {
  assert.ok(argv.length === 1 && ["seal", "encode", "select"].includes(argv[0]));
  const lock = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID(); save(lock, { token, pid: process.pid, stage: argv[0], directory: DIRECTORY });
  try { if (argv[0] === "seal") return seal(); if (argv[0] === "encode") return await encode(); return await select(); }
  finally { assert.equal(read(lock).token, token); fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(() => { console.error("Fresh encoding stage failed; private receipts retained, no automatic retry."); process.exitCode = 1; });
module.exports = { main, check, codeReceipt };
