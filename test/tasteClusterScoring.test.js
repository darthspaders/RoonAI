"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  scoreCandidateAgainstCluster,
  scoreCandidateAgainstProfiles
} = require("../src/tasteClusterScoring");

function cluster(overrides = {}) {
  return {
    clusterId: 1,
    clusterKey: "metadata:house",
    clusterName: "House",
    model: "discogs-effnet",
    modelVersion: "1",
    positive: { vector: [1, 0], feedbackIdentityCount: 4, embeddingIdentityCount: 4 },
    negative: { vector: [0, 1], feedbackIdentityCount: 3, embeddingIdentityCount: 3 },
    ...overrides
  };
}

test("cluster scorer exposes positive, negative, and net sonic signals", () => {
  const score = scoreCandidateAgainstCluster([1, 0], cluster());
  assert.equal(score.positiveSimilarity, 1);
  assert.equal(score.negativeSimilarity, 0);
  assert.equal(score.netMargin, 1);
  assert.equal(score.rerankSignal, 1);
  assert.match(score.explanation, /compared within this taste cluster/);
});

test("cluster scorer does not hard-filter when only negative evidence exists", () => {
  const score = scoreCandidateAgainstCluster([0, 1], cluster({ positive: null }));
  assert.equal(score.positiveSimilarity, null);
  assert.equal(score.negativeSimilarity, 1);
  assert.equal(score.rerankSignal, 0);
  assert.match(score.explanation, /bounded penalty/);
});

test("requested cluster is surfaced without removing other cluster signals", () => {
  const result = scoreCandidateAgainstProfiles([1, 0], [
    cluster({ clusterKey: "metadata:house" }),
    cluster({ clusterId: 2, clusterKey: "metadata:bass", clusterName: "Bass", positive: { vector: [0.8, 0.6], feedbackIdentityCount: 2, embeddingIdentityCount: 2 }, negative: null })
  ], { requestedClusterKey: "metadata:bass" });
  assert.equal(result.diagnostics.selectionIsHardFilter, false);
  assert.equal(result.scores.length, 2);
  assert.equal(result.selected.clusterKey, "metadata:bass");
});
