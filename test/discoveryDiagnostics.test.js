"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DiscoveryDiagnosticsStore, compactSonicRun, compactDiscoveryVerification } = require("../src/discoveryDiagnostics");

function fixture() {
  return {
    tracks: [{ artist: "A", title: "One", score: 48, tidal: { id: "1" }, vector: [1, 0], recommendationV2: {
      available: true, applied: true, reason: "scored-against-relevant-taste-cluster", identityKey: "tidal:1",
      originalScore: 40, sonicAdjustment: 8, finalScore: 48, wouldBeFinalScore: 48,
      rankBefore: 2, rankAfter: 1, wouldBeRankAfter: 1, embedding: [1, 0]
    } }],
    alternates: [],
    verification: { recommendationV2: { invoked: true, productionMode: "blend", applied: true, candidateCount: 5, scoredCount: 5, coverage: 1, minScored: 5, minCoverage: 0.1, maxAdjustmentPoints: 8, adjustedCount: 5, reason: "coverage-threshold-met" } }
  };
}

function storeFor(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-discovery-diagnostics-"));
  const file = path.join(directory, "runs.json");
  t.after(() => {
    for (const target of [file, `${file}.${process.pid}.tmp`]) if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.rmdirSync(directory);
  });
  return new DiscoveryDiagnosticsStore({ file, ...options });
}

test("completed Sonic diagnostics survive restart and can be read by run ID without changing scores", t => {
  const store = storeFor(t);
  const result = fixture();
  const before = structuredClone(result);
  const annotated = store.record({ request: "Test", count: 1 }, result);
  assert.deepEqual(result, before);
  assert.equal(annotated.tracks[0].score, 48);
  const restarted = new DiscoveryDiagnosticsStore({ file: store.file });
  const report = restarted.get({ runId: annotated.discoveryRunId });
  assert.equal(report.sonic.sonicInvoked, true);
  assert.equal(report.sonic.sonicBlendApplied, true);
  assert.equal(report.tracks[0].sonic.sonicDelta, 8);
  assert.equal(report.tracks[0].sonic.rankBefore, 2);
  assert.equal(report.tracks[0].sonic.rankAfter, 1);
  assert.doesNotMatch(JSON.stringify(report), /"vector"|"embedding"/);
  assert.equal(report.completedAt, annotated.discoveryCompletedAt);
});

test("the missing-profile run distinguishes invocation, zero adjustments and unavailable old rank fields", t => {
  const result = fixture();
  result.verification.recommendationV2 = { productionMode: "blend", applied: false, candidateCount: 11, scoredCount: 0, coverage: 0, minScored: 5, minCoverage: 0.1, reason: "coverage-threshold-not-met" };
  result.tracks[0].recommendationV2 = { available: false, applied: false, reason: "no-stored-learned-embedding", originalScore: 40, sonicAdjustment: 0, finalScore: 40 };
  const session = { updatedAt: "2026-09-17T19:05:15.436Z", options: { request: "Test" }, result };
  const store = storeFor(t, { sessionStore: { read: () => session } });
  const report = store.get();
  assert.equal(report.sonic.sonicInvoked, true);
  assert.equal(report.sonic.sonicBlendApplied, false);
  assert.equal(report.sonic.scoredCount, 0);
  assert.equal(report.tracks[0].sonic.sonicDelta, 0);
  assert.equal(report.tracks[0].sonic.rankBefore, null);
  assert.deepEqual(report.sonic.returnedUnscoredReasons, { "no-stored-learned-embedding": 1 });
  assert.equal(fs.existsSync(store.file), false, "diagnostics reads do not write files");
  assert.equal(report.completedAt, null, "old session timestamps are not discovery completion times");
  session.updatedAt = "2026-09-17T20:00:00.000Z";
  session.result.tracks[0].feedback = "like";
  assert.equal(store.get().runId, report.runId, "feedback updates do not change the historical run ID");
  store.record({}, fixture());
  assert.equal(store.get({ runId: report.runId }).sessionUpdatedAt, session.updatedAt);
});

test("archive eviction never returns another run for an expired ID", t => {
  const store = storeFor(t, { maxRuns: 2 });
  const first = store.record({}, fixture());
  const second = store.record({}, fixture());
  const third = store.record({}, fixture());
  assert.equal(store.get().runId, third.discoveryRunId);
  assert.equal(store.get({ runId: second.discoveryRunId }).runId, second.discoveryRunId);
  assert.throws(() => store.get({ runId: first.discoveryRunId }), error => error.statusCode === 404);
});

test("saved reports bound selected and alternate payloads and retain separate counts", t => {
  const store = storeFor(t);
  const result = fixture();
  result.tracks = Array.from({ length: 40 }, () => result.tracks[0]);
  result.alternates = result.tracks;
  store.record({}, result);
  assert.equal(store.get().tracks.length, 10);
  assert.equal(store.get().alternates.length, 0);
  assert.equal(store.get().returned, 40);
  const full = store.get({ limit: 1000, includeAlternates: true });
  assert.equal(full.tracks.length, 40);
  assert.equal(full.alternates.length, 40);
});

test("unreached, off and observe Sonic stages never claim Blend was applied", () => {
  assert.equal(compactSonicRun({}).sonicInvoked, false);
  assert.equal(compactSonicRun({}).reason, "sonic-stage-not-reached");
  for (const productionMode of ["off", "observe"]) {
    const sonic = compactSonicRun({ verification: { recommendationV2: { invoked: true, productionMode, applied: false, reason: productionMode } } });
    assert.equal(sonic.sonicInvoked, true);
    assert.equal(sonic.sonicBlendApplied, false);
  }
});

test("an archive failure does not fail completed discovery or overwrite damaged history", t => {
  const store = storeFor(t, { logger: null });
  fs.writeFileSync(store.file, "invalid archive");
  const result = store.record({}, fixture());
  assert.equal(result.discoveryDiagnosticsPersisted, false);
  assert.equal(result.sonicDiagnostics.sonicBlendApplied, true);
  assert.equal(result.tracks[0].score, 48);
  assert.equal(fs.readFileSync(store.file, "utf8"), "invalid archive");
});

test("MCP verification bounds internal traces without changing counts, Sonic evidence or the full session", t => {
  const result = fixture();
  const traces = Array.from({ length: 158 }, () => ({ artist: "Example", privateTrace: "x".repeat(4000) }));
  result.verification.poolDiagnostics = {
    requested: 10, kept: 10, discarded: 559, budgetExhausted: false,
    candidateAccumulation: { rawCandidates: 591, freshCandidatesAfterNovelty: 14, durationCandidates: traces },
    querySelectionDiagnostics: traces
  };
  result.verification.querySelectionDiagnostics = Array.from({ length: 42 }, (_, i) => ({ query: `Query ${i}`, lane: "core", catalogPages: traces }));
  const before = JSON.stringify(result);
  const annotated = storeFor(t).record({}, result);
  const summary = annotated.mcpVerification;
  assert.equal(summary.diagnosticsDetail, "summary");
  assert.equal(summary.poolDiagnostics.discarded, 559);
  assert.equal(summary.poolDiagnostics.budgetExhausted, false);
  assert.equal(summary.poolDiagnostics.candidateAccumulation.durationCandidatesCount, 158);
  assert.equal(summary.querySelectionCount, 42);
  assert.equal(summary.querySelectionDiagnostics.length, 8);
  assert.deepEqual(summary.recommendationV2, result.verification.recommendationV2);
  assert.equal(JSON.stringify(result), before);
  assert.equal(annotated.verification, result.verification);
  assert.ok(JSON.stringify(summary).length < 5000);
  assert.doesNotMatch(JSON.stringify(summary), /privateTrace|catalogPages/);
  assert.deepEqual(compactDiscoveryVerification({}).querySelectionDiagnostics, []);
});
