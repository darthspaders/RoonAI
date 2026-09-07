"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelCandidateReviewer } = require("../src/modelCandidateReview");
const { candidateIdentityKeys } = require("../src/discoveryEngine");
const { normalizeMatchText } = require("../src/tidalMatchRules");
const {
  createModelReviewAudit,
  classifyModelReviewChange,
  modelReviewAuditItem,
  recordModelReviewAudit
} = require("../src/modelReviewAudit");

function reviewer(scores = []) {
  return createModelCandidateReviewer({
    candidateIdentityKeys,
    classifyModelReviewChange,
    config: { llmProvider: "test" },
    createModelReviewAudit,
    mergeTrackLists: (...lists) => lists.flat().filter(Boolean),
    modelReviewAuditItem,
    normalizeMatchText,
    recordModelReviewAudit,
    scoreCandidateBatch: async (_config, payload) => ({
      scores,
      rawCount: payload.tracks.length
    }),
    tasteProfile: { read: () => ({}) }
  });
}

test("applyModelReview preserves existing score blending and labels", () => {
  const reviewed = reviewer().applyModelReview({
    id: "1",
    artist: "A",
    title: "T",
    score: 80,
    why: ["existing"],
    scoreBreakdown: { total: 80 }
  }, {
    trackId: "1",
    finalScore: 60,
    genre: "progressive house",
    scores: { promptMatch: 70, tasteMatch: 92, genreConfidence: 40 },
    why: ["model reason"],
    rejected: false
  });

  assert.equal(reviewed.score, 70);
  assert.equal(reviewed.promptMatch.label, "Good");
  assert.equal(reviewed.tasteMatch.label, "Excellent");
  assert.equal(reviewed.matchGenre, "progressive house");
  assert.deepEqual(reviewed.why, ["model reason", "existing"]);
});

test("hardModelReject keeps strong genre-confidence warnings from becoming hard rejects", () => {
  const r = reviewer();

  assert.equal(r.hardModelReject({
    rejected: true,
    finalScore: 70,
    rejectionReason: "compilation",
    scores: { genreConfidence: 60 }
  }), false);
  assert.equal(r.hardModelReject({
    rejected: true,
    finalScore: 40,
    rejectionReason: "SEO playlist filler",
    scores: { genreConfidence: 20 }
  }), true);
});

test("applyModelCandidateReview discards hard rejects and backfills alternates", async () => {
  const r = reviewer([
    {
      trackId: "drop",
      rejected: true,
      finalScore: 20,
      rejectionReason: "SEO playlist filler",
      scores: { genreConfidence: 20 }
    },
    {
      trackId: "alt",
      rejected: false,
      finalScore: 88,
      genre: "progressive house",
      why: ["valid"],
      scores: { promptMatch: 90, tasteMatch: 80, genreConfidence: 85 }
    }
  ]);

  const reviewed = await r.applyModelCandidateReview({
    tracks: [{ id: "drop", artist: "A", title: "Drop", score: 70 }],
    alternates: [{ id: "alt", artist: "B", title: "Alt", score: 75 }],
    discarded: [],
    verification: { requested: 1 }
  }, {});

  assert.equal(reviewed.result.tracks.length, 1);
  assert.equal(reviewed.result.tracks[0].id, "alt");
  assert.equal(reviewed.result.tracks[0].modelReviewBackfill, true);
  assert.equal(reviewed.result.discarded.length, 1);
  assert.match(reviewed.result.discarded[0].reason, /Model rejected candidate/);
  assert.equal(reviewed.review.rejected, 1);
  assert.equal(reviewed.review.scored, 2);
});

test("applyModelCandidateReview keeps rejected tracks when dropping them would undershoot", async () => {
  const r = reviewer([
    {
      trackId: "drop",
      rejected: true,
      finalScore: 20,
      rejectionReason: "SEO playlist filler",
      scores: { genreConfidence: 20 }
    }
  ]);

  const reviewed = await r.applyModelCandidateReview({
    tracks: [{ id: "drop", artist: "A", title: "Drop", score: 70 }],
    alternates: [],
    discarded: [],
    verification: { requested: 1 }
  }, {});

  assert.equal(reviewed.result.tracks.length, 1);
  assert.equal(reviewed.result.tracks[0].modelRejectedKept, true);
  assert.equal(reviewed.review.rejected, 0);
  assert.equal(reviewed.review.rejectedKept, 1);
});
