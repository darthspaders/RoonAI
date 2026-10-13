"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { argumentsFor, privateDirectory, privateFile, validateRuntimeGuard, readReviews, assertAcceptedAdditions, prepareReport } = require("../scripts/sonic-reference-diagnostic");
const { REFERENCE_DIAGNOSTIC_RECIPE } = require("../src/sonicReferenceDiagnostic");
const { opaqueListeningIdentity, musicalNames } = require("../src/sonicCatalogReview");
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const initArgs = ["init", "--output", "data/new-private", "--base", "data/base", "--review", "data/review", "--baseline", "report-1791422939688.json"];

test("CLI pins the input report at init and later stages reuse the sealed plan", () => {
  assert.deepEqual(argumentsFor(initArgs), { command: "init", "--output": "data/new-private", "--base": "data/base", "--review": "data/review", "--baseline": "report-1791422939688.json" });
  for (const command of ["analyze", "evaluate"]) assert.deepEqual(argumentsFor([command, "--output", "data/new-private"]), { command, "--output": "data/new-private" });
  for (const argv of [[], ["run", "--output", "data/x"], ["init", "--output", "data/x"], [...initArgs, "--models", "mert-30s"],
    [...initArgs, "--output", "data/other"], [...initArgs.slice(0, -1)], [...initArgs.slice(0, -1), "../report-123.json"],
    ["analyze", "--output", "data/x", "--base", "data/base"], ["evaluate", "--output"], ["evaluate", "--output", "--base"]]) assert.throws(() => argumentsFor(argv));
});

test("private artifact paths reject lexical and resolved escapes before opening files", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-reference-cli-"));
  t.after(() => { assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temporary, { recursive: true, force: true }); });
  const data = path.join(temporary, "data"), privateRoot = path.join(data, "private"), outside = path.join(temporary, "outside");
  fs.mkdirSync(privateRoot, { recursive: true }); fs.mkdirSync(outside); fs.writeFileSync(path.join(privateRoot, "plan.json"), "{}");
  assert.equal(privateDirectory("data/fresh", temporary), path.join(data, "fresh"));
  assert.equal(privateFile(privateRoot, "plan.json"), path.join(privateRoot, "plan.json"));
  assert.equal(privateFile(privateRoot, "results/new.json", false), path.join(privateRoot, "results/new.json"));
  for (const value of ["data", "../outside", outside]) assert.throws(() => privateDirectory(value, temporary));
  for (const value of ["../outside/file.json", outside, "."]) assert.throws(() => privateFile(privateRoot, value, false));
  fs.symlinkSync(outside, path.join(data, "escape"), process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(outside, path.join(privateRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => privateDirectory("data/escape/new", temporary), /outside/);
  assert.throws(() => privateFile(privateRoot, "escape/new.json", false), /outside/);
  fs.writeFileSync(path.join(outside, "receipt.json"), "{}");
  assert.throws(() => privateFile(privateRoot, "escape/receipt.json"), /outside/);
});

function idleGuard() {
  return { roonStates: ["paused", "stopped"], lyrionPlaying: [], visual: { state: "idle", clients: 0 }, markersPresent: [], nativeProcesses: [], metadataActive: false,
    analysis: { active: 0, remaining: 0 }, gpuFreeMiB: 6144, production: { model: "effnet-v1", enabled: true, maxAdjustment: .08 } };
}
test("runtime guards accept the exact GPU floor without changing unrelated existing work", () => {
  const receipt = idleGuard(), before = clone(receipt);
  receipt.backgroundCoverage = { active: 1, pending: 1974 }; receipt.otherGpuOwners = ["LM Studio"];
  assert.equal(validateRuntimeGuard(receipt, { expectedProduction: before.production }), true);
  assert.deepEqual(receipt.production, before.production); assert.equal(receipt.otherGpuOwners[0], "LM Studio");
  delete receipt.gpuFreeMiB; assert.equal(validateRuntimeGuard(receipt, { minimumGpuMiB: 0 }), true);
});
test("runtime guards fail closed on playback, visual ownership, active analysis or production drift", () => {
  const mutations = [r => { r.roonStates = []; }, r => { r.roonStates[0] = "playing"; }, r => { delete r.lyrionPlaying; }, r => { r.lyrionPlaying = [true]; },
    r => { r.visual.clients = 1; }, r => { r.visual.state = "running"; }, r => { r.markersPresent.push("owner.json"); }, r => { r.nativeProcesses.push({ ProcessId: 123 }); },
    r => { r.metadataActive = true; }, r => { r.metadataActive = null; }, r => { r.analysis.active = 1; }, r => { r.analysis.remaining = 1; },
    r => { r.gpuFreeMiB = 6143; }, r => { r.gpuFreeMiB = NaN; }, r => { delete r.gpuFreeMiB; }, r => { r.production.maxAdjustment = .1; },
    r => { r.production = {}; }, r => { delete r.production; }];
  for (const mutate of mutations) { const receipt = idleGuard(); mutate(receipt); assert.throws(() => validateRuntimeGuard(receipt, { expectedProduction: idleGuard().production })); }
});

function reviewedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sonic_blind_review_batch(batch_id TEXT,private_plan_json TEXT); CREATE TABLE sonic_review_session_item(session_id TEXT,item_index INTEGER,candidate_identity_key TEXT,candidate_json TEXT,status TEXT,review_json TEXT)");
  const plan = { version: 4, kind: "catalog-reference-coverage", count: 8, batchId: "blind:fixture", groups: ["tidal:91463750", "tidal:355413959"].map((identityKey, group) => ({
    anchor: { identityKey }, sessionId: `session:${group}`, candidates: ["tidal:62582289", "tidal:62582288", "tidal:392687743", "tidal:348255917"].map((candidate, index) => ({
      track: { identityKey: candidate, artist: "Exact artist", title: `Candidate ${index}`, mixVersion: "Original Mix", tidalId: candidate.slice(6) } })) })) };
  db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?)").run(plan.batchId, JSON.stringify(plan));
  for (const group of plan.groups) group.candidates.forEach((candidate, index) => {
    db.prepare("INSERT INTO sonic_review_session_item VALUES (?,?,?,?,?,?)").run(group.sessionId, index, opaqueListeningIdentity(plan.batchId, group.sessionId, "candidate", index),
      JSON.stringify(musicalNames(candidate.track)), "REVIEWED", JSON.stringify({ reviewer: "human", listened: true, decision: index < 3 ? "KEEP" : "WRONG_LANE", note: "Human note retained" }));
  });
  return { db, plan };
}
test("read-only review join verifies all eight opaque rows and preserves exact human notes", t => {
  const f = reviewedDatabase(); t.after(() => f.db.close());
  const before = f.db.prepare("SELECT * FROM sonic_review_session_item ORDER BY rowid").all(), reviews = readReviews(f.db, f.plan);
  assert.equal(reviews.length, 8); assert.ok(reviews.every(row => row.review.listened && row.review.reviewer === "human"));
  assert.equal(reviews[0].review.note, "Human note retained"); assertAcceptedAdditions(f.plan, reviews);
  assert.deepEqual(f.db.prepare("SELECT * FROM sonic_review_session_item ORDER BY rowid").all(), before);
});
test("changed private plan, musical identity, row position or unaudited review prevents initialization", () => {
  const changes = [
    db => db.exec("UPDATE sonic_blind_review_batch SET private_plan_json='{}'"),
    db => db.exec("UPDATE sonic_review_session_item SET candidate_identity_key='tidal:unblinded' WHERE rowid=1"),
    db => db.exec("UPDATE sonic_review_session_item SET candidate_json='{\"title\":\"Wrong mix\"}' WHERE rowid=1"),
    db => db.exec("UPDATE sonic_review_session_item SET item_index=9 WHERE rowid=1"),
    db => db.exec("UPDATE sonic_review_session_item SET status='PENDING' WHERE rowid=1"),
    db => db.exec("UPDATE sonic_review_session_item SET review_json='{\"reviewer\":\"automatic\",\"listened\":true,\"decision\":\"KEEP\"}' WHERE rowid=1"),
    db => db.exec("UPDATE sonic_review_session_item SET review_json='{\"reviewer\":\"human\",\"listened\":false,\"decision\":\"KEEP\"}' WHERE rowid=1")
  ];
  for (const change of changes) { const f = reviewedDatabase(); try { change(f.db); assert.throws(() => readReviews(f.db, f.plan)); } finally { f.db.close(); } }
});
test("accepted additions remain anchor-specific and cannot borrow Infinity judgments", t => {
  const f = reviewedDatabase(); t.after(() => f.db.close()); const reviews = readReviews(f.db, f.plan);
  reviews.find(row => row.sessionId === "session:0" && row.index === 0).review.decision = "WRONG_LANE";
  assert.equal(reviews.find(row => row.sessionId === "session:1" && row.index === 0).review.decision, "KEEP");
  assert.throws(() => assertAcceptedAdditions(f.plan, reviews), /accepted exact Interlude/);
});

test("CLI renders and envelops a deeply frozen backend report without inventing pool fields or success rates", () => {
  const row = { track: { title: "Human Intellect | DJ mix", mixVersion: "" }, judgment: { decision: "WRONG_LANE" }, rawRank: null, status: "not-in-pool", fittedRank: null, selected: false };
  const pure = freeze({ version: 1, kind: REFERENCE_DIAGNOSTIC_RECIPE.kind, recipe: REFERENCE_DIAGNOSTIC_RECIPE, productionApplied: false, referencePairs: 8,
    coverage: { catalogSources: 26, modelReceipts: 52, bothModelCoverage: true }, anchors: [{ anchor: { title: "Infinity" }, models: [{ analyzer: "mert-30s", variants: { baseline224: { references: [row] }, expanded226: { references: [row] } } }] }],
    limitations: ["Unjudged replacements are unknown outcomes."] });
  const before = clone(pure), provenance = { planSha256: "a".repeat(64), code: { "src/sonicAnchorFit.js": "b".repeat(64) } };
  const output = prepareReport(pure, provenance);
  assert.notEqual(output.report, pure); assert.deepEqual(pure, before); assert.equal(pure.provenance, undefined); assert.deepEqual(output.report.provenance, provenance);
  assert.deepEqual(output.summary.sourcePools, { originalLocal: 200, baselineCatalog: 24, expandedCatalog: 26, baseline: 224, expanded: 226 });
  assert.deepEqual(output.summary.coverage, pure.coverage); assert.equal(output.summary.runtimeDatabaseWrites, 0);
  assert.match(output.markdown, /Frozen224 versus expanded226/); assert.match(output.markdown, /Infinity/); assert.match(output.markdown, /WRONG_LANE \| — \| not-in-pool \| — \| no/);
  assert.doesNotMatch(JSON.stringify(output), /acceptanceRate|keepRate|sourcePool":/); assert.doesNotMatch(output.markdown, /undefined/);
  assert.equal(JSON.parse(JSON.stringify(output.report)).provenance.planSha256, provenance.planSha256);
});
