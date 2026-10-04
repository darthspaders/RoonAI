"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  candidateIdentityKeys,
  createRecommendationV2DiscoveryReranker,
  relevantProfiles
} = require("../src/recommendationV2Discovery");

function profile(clusterKey, vector, overrides = {}) {
  return {
    clusterId: clusterKey,
    clusterKey,
    clusterName: clusterKey.replace(/^metadata:/, ""),
    model: "discogs-effnet",
    modelVersion: "1",
    positive: { vector, feedbackIdentityCount: 4, embeddingIdentityCount: 4 },
    negative: null,
    ...overrides
  };
}

function engineWithEmbeddings(entries) {
  return {
    store: {
      enabled: true,
      getEmbedding(identityKey) {
        const entry = entries[identityKey];
        return entry ? {
          identityKey,
          model: "discogs-effnet",
          modelVersion: "1",
          dimensions: entry.vector.length,
          vector: entry.vector
        } : null;
      }
    }
  };
}

test("candidate identity resolution prefers the TIDAL identity used by stored profiles", () => {
  assert.deepEqual(
    candidateIdentityKeys({ id: "123", artist: "Artist", title: "Track", tidalUrl: "https://tidal.com/browse/track/123" }),
    ["tidal:123"]
  );
});

test("an explicit genre selects only matching taste-cluster profiles", () => {
  const selected = relevantProfiles([
    profile("metadata:progressive house", [1, 0]),
    profile("metadata:dubstep", [0, 1]),
    profile("metadata:house", [0.8, 0.2])
  ], { genre: "Dubstep" }, { targetGenres: ["dubstep"], scoringMode: "taste-guided" });
  assert.deepEqual(selected.requestedClusterKeys, ["metadata:dubstep"]);
  assert.equal(selected.profiles[0].clusterKey, "metadata:dubstep");
});

test("a Wubs and Dubs request can hint the bass cluster without making it a hard filter", () => {
  const selected = relevantProfiles([
    profile("metadata:progressive house", [1, 0]),
    profile("metadata:dubstep", [0, 1]),
    profile("metadata:bass", [0, 1])
  ], { request: "Find 30 Wubs & Dubs bangers" }, { scoringMode: "taste-guided" });
  assert.deepEqual(selected.requestedClusterKeys, ["metadata:bass", "metadata:dubstep"]);
});

test("artist-led similarity does not borrow an unrelated global taste cluster", () => {
  const selected = relevantProfiles([
    profile("metadata:progressive house", [1, 0]),
    profile("metadata:dubstep", [0, 1])
  ], { request: "Find something similar to Pink Floyd" }, {
    requestedArtists: ["Pink Floyd"],
    scoringMode: "taste-guided"
  });
  assert.equal(selected.reason, "artist-led-no-cluster-hint");
  assert.deepEqual(selected.profiles, []);
});

test("shadow mode records sonic evidence without changing discovery ordering", () => {
  const reranker = createRecommendationV2DiscoveryReranker({
    recommendationEngine: engineWithEmbeddings({ "tidal:1": { vector: [1, 0] } }),
    enabled: true,
    mode: "shadow",
    minScored: 1,
    profilesProvider: () => [profile("metadata:dubstep", [1, 0])]
  });
  const candidates = [
    { id: "1", artist: "A", title: "One", score: 40 },
    { id: "2", artist: "B", title: "Two", score: 90 }
  ];
  const result = reranker.rerankCandidates(candidates, {
    options: { genre: "Dubstep" },
    profile: { targetGenres: ["dubstep"], scoringMode: "taste-guided" }
  });
  assert.deepEqual(result.candidates.map(item => item.score), [40, 90]);
  assert.equal(result.diagnostics.applied, false);
  assert.equal(result.diagnostics.scoredCount, 1);
  assert.equal(result.candidates[0].recommendationV2.clusterKey, "metadata:dubstep");
});

test("observe mode computes capped Sonic diagnostics without changing scores", () => {
  const reranker = createRecommendationV2DiscoveryReranker({
    recommendationEngine: engineWithEmbeddings({
      "tidal:1": { vector: [1, 0] },
      "tidal:2": { vector: [0, 1] }
    }),
    enabled: true,
    productionMode: "observe",
    maxAdjustment: 0.08,
    minCoverage: 1,
    minScored: 2,
    profilesProvider: () => [profile("metadata:dubstep", [1, 0], {
      negative: { vector: [0, 1], feedbackIdentityCount: 2, embeddingIdentityCount: 2 }
    })]
  });
  const result = reranker.rerankCandidates([
    { id: "1", artist: "A", title: "One", score: 40 },
    { id: "2", artist: "B", title: "Two", score: 41 }
  ], {
    options: { genre: "Dubstep" },
    profile: { targetGenres: ["dubstep"], scoringMode: "taste-guided" }
  });
  assert.deepEqual(result.candidates.map(item => item.score), [40, 41]);
  assert.equal(result.diagnostics.productionMode, "observe");
  assert.equal(result.diagnostics.invoked, true);
  assert.equal(result.diagnostics.applied, false);
  assert.equal(result.diagnostics.orderingChanged, false);
  assert.equal(result.diagnostics.wouldChangeOrdering, true);
  assert.equal(result.candidates[0].recommendationV2.originalScore, 40);
  assert.equal(result.candidates[0].recommendationV2.sonicAdjustment, 0);
  assert.equal(result.candidates[0].recommendationV2.finalScore, 40);
  assert.equal(result.candidates[0].recommendationV2.wouldBeFinalScore, 48);
  assert.equal(result.candidates[0].recommendationV2.wouldChangeRankingPosition, true);
  assert.equal(result.candidates[0].recommendationV2.rankBefore, 2);
  assert.equal(result.candidates[0].recommendationV2.rankAfter, 2);
  assert.equal(result.candidates[0].recommendationV2.wouldBeRankAfter, 1);
  assert.equal(result.candidates[0].recommendationV2.evidence.positive.similarity, 1);
});

test("blend mode applies only the capped additive Sonic adjustment after coverage is met", () => {
  const reranker = createRecommendationV2DiscoveryReranker({
    recommendationEngine: engineWithEmbeddings({
      "tidal:1": { vector: [1, 0] },
      "tidal:2": { vector: [0, 1] }
    }),
    enabled: true,
    productionMode: "blend",
    maxAdjustment: 0.08,
    minCoverage: 1,
    minScored: 2,
    profilesProvider: () => [profile("metadata:dubstep", [1, 0], {
      negative: { vector: [0, 1], feedbackIdentityCount: 2, embeddingIdentityCount: 2 }
    })]
  });
  const result = reranker.rerankCandidates([
    { id: "1", artist: "A", title: "One", score: 40 },
    { id: "2", artist: "B", title: "Two", score: 41 }
  ], {
    options: { genre: "Dubstep" },
    profile: { targetGenres: ["dubstep"], scoringMode: "taste-guided" }
  });
  assert.equal(result.diagnostics.applied, true);
  assert.equal(result.diagnostics.adjustedCount, 2);
  assert.equal(result.candidates[0].score, 48);
  assert.equal(result.candidates[1].score, 33);
  assert.equal(result.candidates[0].recommendationV2.sonicAdjustment, 8);
  assert.equal(result.candidates[1].recommendationV2.sonicAdjustment, -8);
  assert.equal(result.candidates[0].recommendationV2.rankingPositionChanged, true);
  assert.equal(result.candidates[0].recommendationV2.rankBefore, 2);
  assert.equal(result.candidates[0].recommendationV2.rankAfter, 1);
  assert.equal(result.candidates[1].recommendationV2.rankBefore, 1);
  assert.equal(result.candidates[1].recommendationV2.rankAfter, 2);
  assert.equal(result.diagnostics.orderingChanged, true);
});

test("rerank mode blends scores only after the coverage threshold is met", () => {
  const reranker = createRecommendationV2DiscoveryReranker({
    recommendationEngine: engineWithEmbeddings({
      "tidal:1": { vector: [1, 0] },
      "tidal:2": { vector: [0, 1] }
    }),
    enabled: true,
    mode: "rerank",
    weight: 0.5,
    minCoverage: 0.5,
    minScored: 2,
    profilesProvider: () => [profile("metadata:dubstep", [1, 0], {
      negative: { vector: [0, 1], feedbackIdentityCount: 2, embeddingIdentityCount: 2 }
    })]
  });
  const result = reranker.rerankCandidates([
    { id: "1", artist: "A", title: "One", score: 40 },
    { id: "2", artist: "B", title: "Two", score: 90 }
  ], {
    options: { genre: "Dubstep" },
    profile: { targetGenres: ["dubstep"], scoringMode: "taste-guided" }
  });
  assert.equal(result.diagnostics.applied, true);
  assert.equal(result.candidates[0].recommendationV2.applied, true);
  assert.equal(result.candidates[0].score, 70);
  assert.equal(result.candidates[1].score, 45);
});

test("pure search mode keeps taste profiles out of the reranker", () => {
  const reranker = createRecommendationV2DiscoveryReranker({
    recommendationEngine: engineWithEmbeddings({ "tidal:1": { vector: [1, 0] } }),
    enabled: true,
    mode: "rerank",
    minScored: 1,
    profilesProvider: () => [profile("metadata:dubstep", [1, 0])]
  });
  const result = reranker.rerankCandidates([{ id: "1", artist: "A", title: "One", score: 40 }], {
    options: { genre: "Dubstep", scoringMode: "pure" },
    profile: { targetGenres: ["dubstep"], scoringMode: "pure" }
  });
  assert.equal(result.diagnostics.reason, "pure-search-mode");
  assert.equal(result.candidates[0].score, 40);
});
