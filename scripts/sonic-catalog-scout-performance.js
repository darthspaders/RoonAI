"use strict";

// Private operational measurements on previously frozen exact previews. No
// provider clients, server imports, database writes or production configuration.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { assertSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { OwnedOperationalWorker, OWNERSHIP_SCRIPT } = require("../src/sonicCatalogScoutOperationalWorker");
const { SonicCatalogScoutCache } = require("../src/sonicCatalogScoutCache");
const { SonicCatalogScoutService } = require("../src/sonicCatalogScoutService");
const { createPrivateResultReceipt, readPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const { runOperationalDiscoveryPath } = require("../src/sonicCatalogScoutOperationalPath");
const { wslPath } = require("../src/sonicAnalysisWorker");

const ROOT = path.resolve(__dirname, ".."), DATA = path.join(ROOT, "data");
const DIRECTORY = path.join(DATA, "sonic-catalog-scout-performance-20261008");
const PARENT = path.join(DATA, "sonic-catalog-scout-catalog-v5-20261008");
const OPERATIONAL = path.join(DATA, "sonic-catalog-scout-operational-20261008");
const HELPER_PYTHON = "/usr/bin/python3", MODELS = ["mert-fullsong", "mert-30s"];
const LIMITS = Object.freeze({ "melodic-house": 6, "psy-trance": 4, "bass-house": 0, "hypnotic-techno": 2 });
const SELF = "scripts/sonic-catalog-scout-performance.js";
const sha = value => createHash("sha256").update(value).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = value => JSON.parse(JSON.stringify(value));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function update(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  save(temporary, value); fs.renameSync(temporary, file);
}
function safeWithin(root, file, allowMissing = false) {
  const base = fs.realpathSync(root), absolute = path.resolve(file), relative = path.relative(base, absolute);
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "Private path escaped its owner.");
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part); let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (allowMissing && error.code === "ENOENT") continue; throw error; }
    assert.ok(!stat.isSymbolicLink(), "Private paths must not contain links.");
    const actual = fs.realpathSync(current), inside = path.relative(base, actual);
    assert.ok(inside && inside !== ".." && !inside.startsWith(".." + path.sep) && !path.isAbsolute(inside));
  }
  return absolute;
}
const ownedPath = (file, missing = false) => safeWithin(DIRECTORY, file, missing);
function selectParentPool(pool) {
  assert.equal(pool?.version, 1); assert.equal(pool.kind, "catalog-scout-pilot-pool");
  assert.equal(pool.requests?.length, 4); assert.ok(Array.isArray(pool.entries) && pool.entries.length <= 100);
  const entries = new Map(pool.entries.map(entry => [entry.track?.identityKey, entry]));
  assert.equal(entries.size, pool.entries.length);
  const requests = pool.requests.map(row => {
    assert.ok(Object.hasOwn(LIMITS, row.requestId), "Unexpected parent request.");
    assert.ok(entries.has(row.anchorIdentityKey) && Array.isArray(row.candidateIdentityKeys));
    assert.ok(!row.options?.genres, "Sampling categories cannot manufacture hard requested genres.");
    assert.ok(row.candidateIdentityKeys.length >= LIMITS[row.requestId]);
    return { ...clone(row), candidateIdentityKeys: row.candidateIdentityKeys.slice(0, LIMITS[row.requestId]) };
  });
  assert.equal(new Set(requests.map(row => row.requestId)).size, 4);
  const identities = new Set(requests.flatMap(row => [row.anchorIdentityKey, ...row.candidateIdentityKeys]));
  assert.equal(identities.size, 16, "Reuse requires exactly four anchors plus twelve distinct candidates.");
  const selected = pool.entries.filter(entry => identities.has(entry.track.identityKey)).map(clone);
  assert.equal(selected.length, 16);
  for (const entry of selected) {
    assert.equal(entry.source?.sourceType, "beatport-preview");
    assertSonicSourceSnapshot(entry.source, { track: entry.track });
  }
  return { version: 1, kind: pool.kind, entries: selected, requests };
}
function pins() {
  const prior = read(path.join(OPERATIONAL, "collection-code-receipt.json")).files;
  assert.ok(Array.isArray(prior) && prior.length === 73, "Preserve the 73-pin operational declaration.");
  const files = prior.filter(row => row.path !== "scripts/sonic-catalog-scout-operational.js").map(clone);
  const seen = new Set(files.map(row => row.path)), pending = [SELF], walked = new Set();
  while (pending.length) {
    const file = pending.pop(); if (walked.has(file)) continue; walked.add(file);
    const absolute = safeWithin(ROOT, path.join(ROOT, file));
    if (!seen.has(file)) { files.push({ path: file, sha256: sha(fs.readFileSync(absolute)) }); seen.add(file); }
    const source = fs.readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/\brequire\(["'](\.[^"']+)["']\)/g)) {
      let dependency = path.resolve(path.dirname(absolute), match[1]); if (!path.extname(dependency)) dependency += ".js";
      safeWithin(ROOT, dependency);
      pending.push(path.relative(ROOT, dependency).split(path.sep).join("/"));
    }
  }
  assert.ok(files.length <= 100 && seen.size === files.length);
  for (const row of files) assert.equal(sha(fs.readFileSync(safeWithin(ROOT, path.join(ROOT, row.path)))), row.sha256, "Pinned code changed.");
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
function parentReceipt() {
  const plan = read(path.join(PARENT, "plan.json"));
  assert.equal(plan.version, 1); assert.equal(plan.productionApplied, false);
  assert.deepEqual(plan.models, MODELS.map(analysisSpec)); assert.equal(plan.code?.files?.length, 36);
  for (const name of ["pool", "request"]) assert.equal(plan[name + "Sha256"], sha(fs.readFileSync(path.join(PARENT, name + ".json"))));
  for (const row of plan.code.files) assert.equal(sha(fs.readFileSync(safeWithin(ROOT, path.join(ROOT, row.path)))), row.sha256, "Original 36 source pins changed.");
  return { directory: path.relative(DATA, PARENT), files: ["plan.json", "pool.json", "request.json", "production-snapshot.json"].map(name =>
    ({ name, sha256: sha(fs.readFileSync(safeWithin(PARENT, path.join(PARENT, name)))) })), originalCode: clone(plan.code),
    operationalCodeReceiptSha256: sha(fs.readFileSync(path.join(OPERATIONAL, "collection-code-receipt.json"))) };
}
function declaration() {
  return { version: 1, kind: "catalog-scout-performance-reused-previews", productionApplied: false,
    sourcePolicy: "Reuse deterministic exact Beatport previews from the completed prior v5 private pool; no source acquisition, substitutions or user local-library files.",
    selection: { method: "original-order-first-N", anchors: 4, candidatesByRequest: LIMITS, distinctSources: 16 },
    freshCatalogCoverageMeasured: false, musicQualityEvaluated: false, labelsUsedForSelection: false, heldOutValidation: false,
    models: MODELS, maximumConservativeAttempts: 42, expectedSubmittedPayloads: 38, completeSourceEncodesRequired: 32,
    missingFileFailures: 2, warmRepeats: 2, loadedTimeouts: 1, freshPostTimeoutRecoveries: 1, startupCancellationPayloads: 0,
    oneOwnedWorkerAtATime: true, crossProcessExclusiveLock: true, pauseIdleAndGpuGuardsRequired: true,
    helper: { python: HELPER_PYTHON, pidfdOpenRequired: true, pidfdSendSignalRequired: true, timeoutMs: 5000, maxBufferBytes: 131072 },
    measurementBoundary: "New process/model with already installed pinned weights; OS page cache is not evicted. Cold observe is a neutral miss and never starts inference.",
    discoveryBoundary: "Frozen response replay through existing pure discovery factories. No live provider searches, public playlist POST, queue or playback calls.",
    productionSnapshotPolicy: "Byte-identical prior v5 EffNet Blend 0.08 snapshot with an explicit digest receipt; no current database snapshot or label join." };
}
function initialize() {
  const data = fs.realpathSync(DATA); assert.equal(fs.lstatSync(data).isSymbolicLink(), false);
  safeWithin(DATA, DIRECTORY, true);
  if (!fs.existsSync(DIRECTORY)) fs.mkdirSync(DIRECTORY);
  assert.ok(fs.lstatSync(DIRECTORY).isDirectory() && !fs.lstatSync(DIRECTORY).isSymbolicLink());
  for (const name of ["predeclaration.json", "parent-receipt.json", "request.json", "pool.json", "plan.json", "production-snapshot.json"])
    assert.ok(!fs.existsSync(ownedPath(path.join(DIRECTORY, name), true)), "Preserve earlier initialization; do not overwrite.");
  for (const name of ["audio", "cache", "guards"]) {
    const directory = ownedPath(path.join(DIRECTORY, name), true);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    assert.equal(fs.readdirSync(directory).length, 0, "Performance directories must start empty.");
  }
  const receipt = parentReceipt(), pool = selectParentPool(read(path.join(PARENT, "pool.json"))), priorRequest = read(path.join(PARENT, "request.json"));
  save(path.join(DIRECTORY, "predeclaration.json"), declaration()); save(path.join(DIRECTORY, "parent-receipt.json"), receipt);
  for (const entry of pool.entries) {
    const bytes = fs.readFileSync(safeWithin(PARENT, path.resolve(PARENT, entry.sourceFile)));
    assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: bytes });
    const target = ownedPath(path.join(DIRECTORY, "audio", entry.source.sourceSha256 + ".audio"), true);
    if (fs.existsSync(target)) assert.equal(sha(fs.readFileSync(target)), entry.source.sourceSha256);
    else fs.writeFileSync(target, bytes, { flag: "wx" });
    entry.sourceFile = target;
  }
  const request = { version: 1, createdAt: new Date().toISOString(),
    recipe: { ...clone(priorRequest.recipe), kind: "catalog-scout-performance-reused-previews", maxSources: 16,
      maxCandidatesPerRequest: 6, models: MODELS.map(analysisSpec), productionApplied: false },
    requests: clone(pool.requests), tasteSnapshot: clone(priorRequest.tasteSnapshot), historySnapshot: clone(priorRequest.historySnapshot),
    labelsUsedForSelection: false, heldOutValidation: false, freshCatalogCoverageMeasured: false, musicQualityEvaluated: false, productionApplied: false,
    predeclarationSha256: sha(fs.readFileSync(path.join(DIRECTORY, "predeclaration.json"))),
    parentReceiptSha256: sha(fs.readFileSync(path.join(DIRECTORY, "parent-receipt.json"))) };
  save(path.join(DIRECTORY, "request.json"), request); save(path.join(DIRECTORY, "pool.json"), pool);
  const snapshot = fs.readFileSync(path.join(PARENT, "production-snapshot.json"));
  fs.writeFileSync(path.join(DIRECTORY, "production-snapshot.json"), snapshot, { flag: "wx" });
  save(path.join(DIRECTORY, "production-snapshot-receipt.json"), { version: 1, sha256: sha(snapshot), source: "prior-v5-byte-identical",
    parentSnapshotSha256: receipt.files.find(row => row.name === "production-snapshot.json").sha256, productionApplied: false });
  save(path.join(DIRECTORY, "initial-code-receipt.json"), pins());
  console.log(JSON.stringify({ initialized: true, reusedSources: 16, requests: 4, candidateCounts: LIMITS, freshCatalogCoverageMeasured: false, modelRequests: 0 }));
}
function seal() {
  assert.deepEqual(read(path.join(DIRECTORY, "initial-code-receipt.json")), pins());
  const request = read(path.join(DIRECTORY, "request.json")); assert.equal(request.predeclarationSha256, sha(fs.readFileSync(path.join(DIRECTORY, "predeclaration.json"))));
  save(path.join(DIRECTORY, "plan.json"), { version: 1, createdAt: new Date().toISOString(), models: MODELS.map(analysisSpec), code: pins(),
    requestSha256: sha(fs.readFileSync(path.join(DIRECTORY, "request.json"))), poolSha256: sha(fs.readFileSync(path.join(DIRECTORY, "pool.json"))),
    predeclarationSha256: request.predeclarationSha256, parentReceiptSha256: request.parentReceiptSha256,
    productionSnapshotReceiptSha256: sha(fs.readFileSync(path.join(DIRECTORY, "production-snapshot-receipt.json"))),
    maximumModelRuns: 42, expectedSubmittedPayloads: 38, completeSourceEncodesRequired: 32, productionApplied: false });
  check(); console.log(JSON.stringify({ sealed: true, reusedSources: 16, maximumAttempts: 42, expectedPayloads: 38 }));
}
function assertSource(entry) {
  const file = ownedPath(entry.sourceFile); assert.ok(fs.lstatSync(file).isFile());
  assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(file) });
}
function check() {
  const plan = read(ownedPath(path.join(DIRECTORY, "plan.json"))), request = read(ownedPath(path.join(DIRECTORY, "request.json")));
  assert.equal(plan.version, 1); assert.equal(plan.productionApplied, false); assert.equal(plan.maximumModelRuns, 42);
  assert.equal(plan.expectedSubmittedPayloads, 38); assert.equal(plan.completeSourceEncodesRequired, 32);
  assert.deepEqual(plan.models, MODELS.map(analysisSpec)); assert.deepEqual(plan.code, pins());
  // Explicit names avoid ambiguity between file spelling and seal keys.
  for (const [name, key] of [["request", "request"], ["pool", "pool"], ["predeclaration", "predeclaration"], ["parent-receipt", "parentReceipt"], ["production-snapshot-receipt", "productionSnapshotReceipt"]])
    assert.equal(plan[key + "Sha256"], sha(fs.readFileSync(ownedPath(path.join(DIRECTORY, name + ".json")))));
  assert.equal(request.predeclarationSha256, plan.predeclarationSha256); assert.equal(request.parentReceiptSha256, plan.parentReceiptSha256);
  assert.deepEqual(read(path.join(DIRECTORY, "predeclaration.json")), declaration());
  assert.deepEqual(read(path.join(DIRECTORY, "parent-receipt.json")), parentReceipt());
  const pool = read(path.join(DIRECTORY, "pool.json")), expected = selectParentPool(read(path.join(PARENT, "pool.json")));
  for (const entry of expected.entries) entry.sourceFile = path.join(DIRECTORY, "audio", entry.source.sourceSha256 + ".audio");
  assert.deepEqual(pool, expected, "Reused source order, descriptors or request membership changed.");
  assert.deepEqual(request.requests, pool.requests); assert.equal(request.recipe.scoutCount, 6); assert.equal(request.recipe.finalCount, 3);
  assert.equal(request.recipe.agreementWeight, 0); assert.equal(request.productionApplied, false); assert.equal(request.labelsUsedForSelection, false);
  const priorRequest = read(path.join(PARENT, "request.json"));
  assert.deepEqual(request.tasteSnapshot, priorRequest.tasteSnapshot); assert.deepEqual(request.historySnapshot, priorRequest.historySnapshot);
  const snapshotReceipt = read(path.join(DIRECTORY, "production-snapshot-receipt.json"));
  assert.equal(snapshotReceipt.sha256, sha(fs.readFileSync(ownedPath(path.join(DIRECTORY, "production-snapshot.json")))));
  assert.equal(snapshotReceipt.parentSnapshotSha256, snapshotReceipt.sha256);
  assert.equal(snapshotReceipt.productionApplied, false); assert.equal(snapshotReceipt.source, "prior-v5-byte-identical");
  for (const entry of pool.entries) assertSource(entry);
  return { plan, pool, request, productionSnapshot: read(path.join(DIRECTORY, "production-snapshot.json")) };
}
function guard(label, gpu = false) {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(DATA, "sonic-catalog-scout-state-20261008.cjs"), "guard"], { windowsHide: true, timeout: 25000, encoding: "utf8" }));
  assert.equal(result.guardPassed, true);
  if (gpu) { result.gpuFreeMiB = Number(execFileSync("nvidia-smi", ["--id=0", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10000, encoding: "utf8" }).trim()); assert.ok(result.gpuFreeMiB >= 6144); }
  save(path.join(DIRECTORY, "guards", label + "-" + Date.now() + "-" + randomUUID() + ".json"), result); return result;
}
function ownershipProbe(owner, operation, targets = []) {
  return new Promise((resolve, reject) => execFile("wsl.exe", ["-d", "Ubuntu", "--", HELPER_PYTHON, "-c", OWNERSHIP_SCRIPT, owner, operation, JSON.stringify(targets)],
    { windowsHide: true, timeout: 5000, maxBuffer: 131072 }, (error, stdout) => {
      if (error) return reject(new Error("System-Python owned process inspection failed."));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Owned process inspection returned malformed evidence.")); }
    }));
}
const ownership = { list: owner => ownershipProbe(owner, "list"), signal: (owner, targets, signal) => ownershipProbe(owner, signal, targets) };
function ownedWorker(timeoutMs = 120000) { return new OwnedOperationalWorker({ timeoutMs, ownership }); }
function assertFullyCold(cache, entries) {
  for (const entry of entries) {
    const state = cache.status({ track: entry.track, source: entry.source });
    assert.equal(state.jointReady, false); assert.equal(state.models.length, 2);
    for (const model of state.models) assert.equal(model.status, "cold", "Every source/model must start cold, including partial coverage.");
  }
}
function expectedFailure(error, role, submitted) {
  if (!submitted) return false;
  if (role === "missing-file") return error.code === "SONIC_ANALYSIS_FAILED";
  if (role === "loaded-timeout") return error.message === "Sonic analysis timed out." && !error.code;
  return false;
}
function submissionWitness(worker, item, file, spec, persist) {
  const child = worker.child, original = child?.stdin?.write;
  assert.equal(typeof original, "function");
  child.stdin.write = function (chunk, ...args) {
    assert.equal(worker.child, child); assert.equal(item.submitted, false);
    const message = JSON.parse(String(chunk)); assert.equal(message.id, worker.pending?.id);
    assert.deepEqual(message.spec, spec); assert.equal(message.file, process.platform === "win32" ? wslPath(file) : file);
    const result = original.call(this, chunk, ...args);
    item.submitted = true; item.requestId = message.id; item.submittedAt = new Date().toISOString(); persist(); return result;
  };
  return () => { child.stdin.write = original; };
}
async function pathProbe(label) {
  const { pool, request, productionSnapshot } = check();
  const service = new SonicCatalogScoutService({ privateRoot: DATA, projectRoot: ROOT, configFile: "sonic-catalog-scout-performance-20261008/probe-service-config.json" });
  if (service.settings.mode !== "observe") service.configure({ mode: "observe", selector: "mert-30s", pilotDirectory: path.basename(DIRECTORY) });
  assert.equal(service.settings.pilotDirectory, path.basename(DIRECTORY));
  const requests = [];
  for (const row of pool.requests) { const started = performance.now(); const result = await runOperationalDiscoveryPath({ pool, request: row,
    tasteSnapshot: request.tasteSnapshot, historySnapshot: request.historySnapshot, productionSnapshot, observer: service.observeCandidates.bind(service) });
    requests.push({ requestId: row.requestId, elapsedMs: performance.now() - started, ...result }); }
  check(); save(path.join(DIRECTORY, label + "-path.json"), { at: new Date().toISOString(), requests, productionApplied: false, freshCatalogCoverageMeasured: false, livePlaylistPostInvoked: false });
}
async function measure() {
  const { plan, pool } = check(); assert.ok(!fs.existsSync(path.join(DIRECTORY, "inference-attempts.json")), "Preserve earlier attempts; do not repeat measurement.");
  const capability = JSON.parse(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", HELPER_PYTHON, "-c", "import os,signal,json; print(json.dumps({'pidfdOpen':hasattr(os,'pidfd_open'),'pidfdSendSignal':hasattr(signal,'pidfd_send_signal')}))"], { windowsHide: true, timeout: 5000, maxBuffer: 131072, encoding: "utf8" }));
  assert.equal(capability.pidfdOpen, true); assert.equal(capability.pidfdSendSignal, true);
  save(path.join(DIRECTORY, "ownership-helper-capability.json"), { python: HELPER_PYTHON, ...capability });
  const cache = new SonicCatalogScoutCache({ directory: path.join(DIRECTORY, "cache"), maxSources: 16 }); assertFullyCold(cache, pool.entries);
  await pathProbe("cold");
  const attempts = [], measurements = [], attemptFile = path.join(DIRECTORY, "inference-attempts.json");
  const anchor = pool.entries.find(entry => entry.track.identityKey === pool.requests[0].anchorIdentityKey); assert.ok(anchor);
  const persist = () => fs.existsSync(attemptFile) ? update(attemptFile, attempts) : save(attemptFile, attempts);
  async function request(worker, analyzer, role, entry, file = entry?.sourceFile) {
    check(); guard(analyzer + "-" + role);
    const ready = await worker.awaitReady(); assert.equal(ready.ownerVerified, true);
    assert.ok(attempts.length < plan.maximumModelRuns);
    if (role === "missing-file") assert.ok(!fs.existsSync(file));
    const item = { analyzer, role, identityKey: entry?.track.identityKey || null, at: new Date().toISOString(), ready,
      status: "started", submitted: false, acknowledged: false }; attempts.push(item); persist();
    const spec = analysisSpec(analyzer), restore = submissionWitness(worker, item, file, spec, persist), started = performance.now();
    try {
      const result = await worker.run(file, spec); item.elapsedMs = performance.now() - started; item.acknowledged = true;
      assert.ok(!["missing-file", "loaded-timeout"].includes(role), "Failure probe unexpectedly encoded audio");
      assertSource(entry);
      const receipt = createPrivateResultReceipt(result, spec, entry.source); readPrivateResultReceipt(receipt, spec, entry.source);
      save(path.join(DIRECTORY, "result-" + attempts.length + ".json"), receipt);
      if (role === "source-encode") cache.ingest({ track: entry.track, source: entry.source, analyzer, receipt, audioBytes: fs.readFileSync(entry.sourceFile) });
      item.timings = result.timings; item.status = "complete"; return result;
    } catch (error) {
      item.elapsedMs = performance.now() - started; item.errorCode = error.code || "error";
      item.acknowledged = item.acknowledged || ["SONIC_ANALYSIS_FAILED", "SONIC_RESOURCE_BUSY"].includes(error.code) && item.submitted;
      const expected = expectedFailure(error, role, item.submitted); item.status = expected ? "expected-failure" : "failed";
      item.errorKind = role === "loaded-timeout" && expected ? "analysis-timeout" : error.code === "SONIC_ANALYSIS_FAILED" ? "worker-analysis-failure" : "unexpected-failure";
      if (!expected) throw error; return { errorKind: item.errorKind };
    } finally {
      restore();
      try { if (entry) assertSource(entry); check(); }
      catch (error) { item.status = "source-or-seal-integrity-failed"; throw error; }
      finally { persist(); console.log(JSON.stringify({ analyzer, role, status: item.status, attempts: attempts.length,
        submittedRequests: attempts.filter(row => row.submitted).length, elapsedMs: item.elapsedMs })); }
    }
  }
  // No payload is submitted in this cancellation probe; report if readiness won the race.
  { const before = guard("startup-cancel-before", true), worker = ownedWorker(); let proof;
    try { worker.start("mert2"); const deadline = Date.now() + 10000; let rows = [];
      while (Date.now() < deadline) { rows = await worker.ownedProcesses(); if (rows.length) break; await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.ok(rows.length, "Startup ownership tag was not observed");
      proof = { ownedProcessesObserved: rows.length, readyBeforeCancel: Boolean(worker.child?.linuxPid), submittedRequests: 0 }; worker.stop();
    } finally { proof = { ...proof, release: await worker.release() }; }
    const after = guard("startup-cancel-after", true); assert.ok(after.gpuFreeMiB >= before.gpuFreeMiB - 128);
    check(); save(path.join(DIRECTORY, "startup-cancellation.json"), { ...proof, beforeGpuFreeMiB: before.gpuFreeMiB, afterGpuFreeMiB: after.gpuFreeMiB }); }
  for (const analyzer of MODELS) {
    const before = guard(analyzer + "-before", true), worker = ownedWorker(); let recover = false; const started = performance.now();
    try {
      worker.start(analysisSpec(analyzer).runtime); await worker.awaitReady(); const readyMs = performance.now() - started;
      const failure = await request(worker, analyzer, "missing-file", null, path.join(DIRECTORY, "missing-source.audio")); assert.equal(failure.errorKind, "worker-analysis-failure");
      let cold;
      for (const entry of [anchor, ...pool.entries.filter(entry => entry !== anchor)]) { const result = await request(worker, analyzer, "source-encode", entry); if (entry === anchor) cold = result; }
      const warm = await request(worker, analyzer, "warm-repeat", anchor); assert.ok(cold.vector.every((value, index) => Math.abs(value - warm.vector[index]) < 1e-5));
      measurements.push({ analyzer, readyMs, cold: cold.timings, warm: warm.timings });
      if (analyzer === "mert-30s") { worker.timeoutMs = 1; const timed = await request(worker, analyzer, "loaded-timeout", anchor); assert.equal(timed.errorKind, "analysis-timeout"); recover = true; }
    } finally { measurements.push({ analyzer, release: await worker.release() }); }
    const after = guard(analyzer + "-after", true); assert.ok(after.gpuFreeMiB >= before.gpuFreeMiB - 128);
    if (recover) { const fresh = ownedWorker();
      try { fresh.start(analysisSpec(analyzer).runtime); await fresh.awaitReady(); const result = await request(fresh, analyzer, "post-timeout-recovery", anchor); measurements.push({ analyzer, recovery: result.timings }); }
      finally { measurements.push({ analyzer, recoveryRelease: await fresh.release() }); }
      const final = guard(analyzer + "-recovery-after", true); assert.ok(final.gpuFreeMiB >= before.gpuFreeMiB - 128); }
  }
  assert.equal(attempts.length, 38); assert.equal(attempts.filter(row => row.submitted).length, 38);
  assert.equal(attempts.filter(row => row.role === "source-encode" && row.status === "complete").length, 32);
  assert.equal(attempts.filter(row => row.status === "expected-failure").length, 3);
  for (const entry of pool.entries) { const state = cache.status({ track: entry.track, source: entry.source }); assert.equal(state.jointReady, true); for (const model of state.models) assert.equal(model.status, "warm"); }
  check(); await pathProbe("warm"); check();
  save(path.join(DIRECTORY, "model-performance.json"), { at: new Date().toISOString(), attempts: attempts.length,
    submittedRequests: attempts.filter(row => row.submitted).length, acknowledgedResponses: attempts.filter(row => row.acknowledged).length,
    sourceEncodes: 32, jointWarmSources: 16, modelSpaceCount: 2, measurements, productionApplied: false,
    freshCatalogCoverageMeasured: false, musicQualityEvaluated: false, coldMeans: declaration().measurementBoundary });
}
async function main(argv = process.argv.slice(2)) {
  assert.ok(argv.length === 1 && ["init", "seal", "measure"].includes(argv[0]));
  const file = path.join(DATA, "sonic-catalog-scout-pilot.lock"), token = randomUUID();
  save(file, { token, pid: process.pid, stage: argv[0], directory: DIRECTORY, at: new Date().toISOString() });
  try { if (argv[0] === "init") return initialize(); if (argv[0] === "seal") return seal(); return await measure(); }
  finally { assert.equal(read(file).token, token); fs.unlinkSync(file); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, selectParentPool, declaration, pins, parentReceipt, check, assertFullyCold, expectedFailure, submissionWitness, ownershipProbe };
