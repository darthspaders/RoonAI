"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { argumentsFor, codeReceipt, completeCollection, witnessRequest, assertCompleteLedger, SPEC, SOURCE_COUNT } = require("../scripts/sonic-catalog-verified-recovery-review");
const { createHash } = require("node:crypto");
const { wslPath } = require("../src/sonicAnalysisWorker");
const copy = value => JSON.parse(JSON.stringify(value));
function ledgerFixture() {
  const pool = { entries: Array.from({ length: SOURCE_COUNT }, (_, index) => ({ track: { identityKey: "tidal:" + (index + 1) }, source: { snapshotKey: "source:" + index } })) };
  const ledger = pool.entries.map((entry, index) => ({ analyzer: "mert-30s", identityKey: entry.track.identityKey, sourceSnapshotKey: entry.source.snapshotKey,
    submitted: true, acknowledged: true, status: "complete", requestId: "witness-" + index, submittedAt: "2026-10-09T03:00:00.000Z", receipt: { file: "fixture-" + index + ".json", sha256: "a".repeat(64) } }));
  return { pool, ledger };
}
test("verified preparation stages reject hidden options, destructive port collisions and undeclared stages", () => {
  assert.deepEqual(argumentsFor(["check"]), { stage: "check", port: 3791 });
  assert.deepEqual(argumentsFor(["serve", "--port", "3793"]), { stage: "serve", port: 3793 });
  for (const argv of [["resume"], ["encode", "--retry", "1"], ["serve", "--directory", "elsewhere"], ["serve", "--port", "3777"], ["serve", "--port", "3790"], ["serve", "--port", "NaN"], ["serve", "--port", "3791", "--access", "secret"]]) assert.throws(() => argumentsFor(argv));
});
test("the encoding declaration seals the actual review host and save/audio assets before inference", () => {
  const code = codeReceipt({ pins: () => ({ files: [] }), sha: bytes => createHash("sha256").update(bytes).digest("hex") });
  const paths = new Set(code.files.map(row => row.path));
  for (const file of ["scripts/sonic-catalog-verified-recovery-review.js", "scripts/sonic-catalog-verified-review-host.js", "scripts/sonic-catalog-verified-recovery-phone-gateway.js",
    "src/sonicCatalogVerifiedSource.js", "src/sonicCatalogVerifiedScouts.js", "src/sonicBlindReview.js",
    "src/sonicBlindAudio.js", "src/sonicReviewSessionService.js", "public/sonicBlindReview.js", "public/sonicBlindReview.css"])
    assert.ok(paths.has(file), `Missing actual preparation dependency: ${file}`);
  assert.equal(paths.size, code.files.length); assert.ok(code.files.length <= 100);
});
test("the default complete-collection gate reads the separate recovery runtime", () => {
  const runtimePath = require.resolve("../scripts/sonic-catalog-scout-verified-recovery"), previous = require.cache[runtimePath];
  const sentinel = new Error("Recovery runtime collection fixture");
  require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: { checkCollection() { throw sentinel; } } };
  try { assert.throws(() => completeCollection(), error => error === sentinel); }
  finally { if (previous) require.cache[runtimePath] = previous; else delete require.cache[runtimePath]; }
});
test("actual request witness rejects a changed source, model, request or worker", () => {
  const child = {}, worker = { child, pending: { id: "actual-request" } }, item = { submitted: false }, entry = { sourceFile: "C:/private/fixture.audio" };
  const message = { id: worker.pending.id, spec: SPEC, file: process.platform === "win32" ? wslPath(entry.sourceFile) : entry.sourceFile };
  witnessRequest(message, worker, child, item, entry);
  for (const changed of [{ ...message, id: "foreign-request" }, { ...message, file: "other.audio" }, { ...message, spec: { ...SPEC, repo: "different/model" } }]) assert.throws(() => witnessRequest(changed, worker, child, item, entry));
  assert.throws(() => witnessRequest(message, worker, {}, item, entry));
  assert.throws(() => witnessRequest(message, worker, child, { submitted: true }, entry));
});
test("only sixteen unique witnessed and acknowledged source receipts satisfy the encoding gate", () => {
  const { pool, ledger } = ledgerFixture(); assert.equal(assertCompleteLedger(ledger, pool), true);
  assert.throws(() => assertCompleteLedger(ledger.slice(0, 15), pool));
  assert.throws(() => assertCompleteLedger([...ledger, ledger[0]], pool));
  for (const change of [{ identityKey: ledger[1].identityKey }, { requestId: ledger[1].requestId }, { sourceSnapshotKey: "changed" }, { analyzer: "mert-fullsong" }, { submitted: false }, { acknowledged: false }, { status: "started" }, { submittedAt: "invalid" }, { receipt: { file: "fixture.json", sha256: "invalid" } }]) {
    const changed = copy(ledger); Object.assign(changed[0], change); assert.throws(() => assertCompleteLedger(changed, pool));
  }
});
