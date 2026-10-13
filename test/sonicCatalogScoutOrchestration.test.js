"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscoveryOrchestration } = require("../src/discoveryOrchestration");
const { artistKeysForCandidate, buildDiscoveryProfile, defaultPerRunArtistCap, selectDiscoveryLaneCandidates } = require("../src/discoveryEngine");
const { frozenProductionReranker } = require("../src/sonicCatalogScoutFinalizer");

const clone = value => structuredClone(value);
const OPTIONS = { request: "Find progressive trance", genres: "progressive trance", scoringMode: "taste-guided" };
const vector = axis => Array.from({ length: 1280 }, (_, index) => index === axis ? 1 : 0);
const candidate = (id, score) => ({ identityKey: `tidal:${id}`, tidalId: String(id), artist: `Artist ${id}`, title: `Track ${id}`,
  genre: "Progressive Trance", label: "Pure Trance", durationMs: 480000, score, scoreBreakdown: { total: score }, discoveryLane: "core" });
function fixture(observer) {
  const calls = [], input = { tracks: [candidate(1, 50), candidate(2, 51)], alternates: [candidate(3, 52), candidate(4, 49)], verification: {} };
  const snapshot = { model: "discogs-effnet", modelVersion: "1", mode: "blend", maxAdjustment: .08, minCoverage: 1, minScored: 2,
    profiles: [{ clusterId: "metadata:progressive trance", clusterKey: "metadata:progressive trance", clusterName: "progressive trance", model: "discogs-effnet", modelVersion: "1",
      positive: { vector: vector(0), feedbackIdentityCount: 4, embeddingIdentityCount: 4 }, negative: { vector: vector(1), feedbackIdentityCount: 2, embeddingIdentityCount: 2 } }],
    embeddings: [1, 2, 3, 4].map(id => [`tidal:${id}`, { identityKey: `tidal:${id}`, dimensions: 1280, vector: vector(id % 2 ? 0 : 1) }]) };
  const rerank = frozenProductionReranker(snapshot);
  const orchestration = createDiscoveryOrchestration({ artistKeysForCandidate, buildDiscoveryProfile, defaultPerRunArtistCap,
    mergeTrackLists: (...lists) => [...new Map(lists.flat().map(track => [track.identityKey, track])).values()],
    selectDiscoveryLaneCandidates: (...args) => { calls.push("selection"); return selectDiscoveryLaneCandidates(...args); },
    tasteProfile: { read: () => ({ calibration: { sources: [], lanes: [], labels: [] } }) },
    recommendationV2Reranker: (...args) => { calls.push("effnet"); return rerank(...args); },
    ...(observer ? { catalogScoutObserver: (pool, context) => { calls.push("observer"); return observer(pool, context); } } : {}) });
  const options = clone(OPTIONS), before = clone({ input, options });
  return { input, options, before, calls, run: () => orchestration.rebalanceDiscoveryResult(input, options, buildDiscoveryProfile(options), 3) };
}
function withoutObservation(result) { const copy = clone(result); delete copy.verification.catalogScouts; return copy; }

test("catalog observation sees the admitted pool before EffNet and cannot replace its candidates", () => {
  let observed, context;
  const baseline = fixture().run(), observedRun = fixture((pool, details) => {
    observed = clone(pool); context = clone(details);
    return { candidates: [candidate(999, 100)], tracks: [], diagnostics: { mode: "observe", applied: false, productionApplied: false, observedCount: pool.length } };
  }), result = observedRun.run();
  assert.deepEqual(observedRun.calls, ["observer", "effnet", "selection"]);
  assert.deepEqual(observed.map(track => track.score), [50, 51, 52, 49]); assert.equal(context.requestedCount, 3);
  assert.deepEqual(context.options, OPTIONS); assert.deepEqual(withoutObservation(result), baseline);
  assert.deepEqual({ input: observedRun.input, options: observedRun.options }, observedRun.before);
  assert.equal(result.verification.catalogScouts.observedCount, 4); assert.equal(result.verification.catalogScouts.productionApplied, false);
});

test("filtered or reordered observation leaves actual EffNet Blend and final lane/diversity order unchanged", () => {
  const baseline = fixture().run(), observedRun = fixture(pool => ({ candidates: pool.slice(1).reverse().map(track => ({ ...track, score: 100 })),
    diagnostics: { mode: "observe", applied: false, productionApplied: false } })), result = observedRun.run();
  assert.equal(result.verification.recommendationV2.applied, true); assert.equal(result.verification.recommendationV2.productionMode, "blend");
  assert.equal(result.verification.recommendationV2.coverage, 1); assert.equal(result.verification.recommendationV2.maxAdjustmentPoints, 8);
  assert.deepEqual(result.tracks.map(track => [track.identityKey, track.score]), [["tidal:3", 60], ["tidal:1", 58], ["tidal:2", 43]]);
  assert.deepEqual(withoutObservation(result), baseline); assert.deepEqual(result.verification.laneQuotas, baseline.verification.laneQuotas);
});

test("observer failure falls back without changing candidates, EffNet scoring or final order", () => {
  const baseline = fixture().run(), observedRun = fixture(() => { throw new Error("private source path must not enter diagnostics"); }), result = observedRun.run();
  assert.deepEqual(observedRun.calls, ["observer", "effnet", "selection"]); assert.deepEqual(withoutObservation(result), baseline);
  assert.equal(result.verification.catalogScouts.fallback, true); assert.equal(result.verification.catalogScouts.reason, "scout-observation-unavailable");
  assert.equal(result.verification.catalogScouts.applied, false); assert.equal(result.verification.catalogScouts.productionApplied, false);
  assert.doesNotMatch(JSON.stringify(result.verification.catalogScouts), /private source path/);
});

test("absent observer preserves the prior output and introduces no observation diagnostics", () => {
  const original = fixture(), result = original.run(); assert.deepEqual(original.calls, ["effnet", "selection"]);
  assert.equal(Object.hasOwn(result.verification, "catalogScouts"), false);
  assert.deepEqual(result.tracks.map(track => track.identityKey), ["tidal:3", "tidal:1", "tidal:2"]);
  assert.deepEqual({ input: original.input, options: original.options }, original.before);
});

test("even a mutating observer that throws cannot alter the production pool or request", () => {
  const baseline = fixture().run(), observedRun = fixture((pool, context) => {
    pool[0].score = 1; pool[0].scoreBreakdown.total = 1; pool.splice(1);
    context.options.genres = "rock"; context.options.request = "Wrong request";
    throw new Error("Observer failed after modifying its private copy");
  }), result = observedRun.run();
  assert.deepEqual(withoutObservation(result), baseline); assert.deepEqual({ input: observedRun.input, options: observedRun.options }, observedRun.before);
  assert.equal(result.verification.catalogScouts.fallback, true);
});

test("observation diagnostics cannot claim that candidates were applied or promoted", () => {
  const baseline = fixture().run(), observedRun = fixture(() => ({ diagnostics: { mode: "blend", applied: true, productionApplied: true,
    productionPromotionAllowed: true, observedCount: 4 } })), result = observedRun.run();
  assert.deepEqual(withoutObservation(result), baseline); assert.equal(result.verification.catalogScouts.mode, "observe");
  assert.equal(result.verification.catalogScouts.applied, false); assert.equal(result.verification.catalogScouts.productionApplied, false);
  assert.notEqual(result.verification.catalogScouts.productionPromotionAllowed, true);
});
