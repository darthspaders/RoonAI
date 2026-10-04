"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  feedbackLabel,
  meanNormalizedVector,
  buildClusterCentroids,
  evaluationArea,
  rankingMetrics,
  scoreCentroids,
  splitHeldOut
} = require("../src/tasteClusterEvaluation");

test("feedback labels distinguish positive, negative, and conflicts", () => {
  assert.equal(feedbackLabel(["love", "good"]), "positive");
  assert.equal(feedbackLabel(["skip"]), "negative");
  assert.equal(feedbackLabel(["love", "never"]), "conflict");
  assert.equal(feedbackLabel(["ok"]), "other");
});

test("held-out split is deterministic and keeps both partitions", () => {
  const rows = [1, 2, 3, 4, 5].map((identityId) => ({ identityId, identityKey: `tidal:${identityId}` }));
  const split = splitHeldOut(rows, 5);
  assert.deepEqual(split.test.map((row) => row.identityId), [1]);
  assert.deepEqual(split.train.map((row) => row.identityId), [2, 3, 4, 5]);
});

test("ranking metrics reward positive held-out rows", () => {
  const scored = [
    { identityKey: "a", label: "positive", globalScore: { rerankSignal: 0.9 } },
    { identityKey: "b", label: "negative", globalScore: { rerankSignal: 0.8 } },
    { identityKey: "c", label: "positive", globalScore: { rerankSignal: 0.7 } }
  ];
  const metrics = rankingMetrics(scored, "globalScore");
  assert.equal(metrics.precisionAt5, 0.6667);
  assert.equal(metrics.recallAt5, 1);
  assert.equal(metrics.mrr, 1);
});

test("centroid scoring keeps positive and negative evidence separate", () => {
  const positive = meanNormalizedVector([[1, 0], [1, 0]]);
  const negative = meanNormalizedVector([[0, 1], [0, 1]]);
  const score = scoreCentroids([1, 0], positive, negative);
  assert.equal(score.positiveSimilarity, 1);
  assert.equal(score.negativeSimilarity, 0);
  assert.equal(score.netMargin, 1);
});

test("cluster centroid builder adapts grouped positive and negative profiles", () => {
  const profiles = [{
    clusterId: 9,
    clusterKey: "metadata:house",
    clusterName: "House",
    positive: {
      direction: "positive",
      metadata: { contributingTrackIdentityIds: [1] }
    },
    negative: {
      direction: "negative",
      metadata: { contributingTrackIdentityIds: [2] }
    }
  }];
  const clusters = buildClusterCentroids([
    { identityId: 1, label: "positive", vector: [1, 0] },
    { identityId: 2, label: "negative", vector: [0, 1] }
  ], profiles);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].positive, [1, 0]);
  assert.deepEqual(clusters[0].negative, [0, 1]);
});

test("evaluation areas prefer genre, then subgenre, with an honest fallback", () => {
  assert.equal(evaluationArea({ genre: "Progressive House", subgenre: "" }), "Progressive House");
  assert.equal(evaluationArea({ genre: "", subgenre: "Deep Trance" }), "Deep Trance");
  assert.equal(evaluationArea({ genre: "", subgenre: "" }), "unclassified");
});
