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

test("hardModelReject keeps ordinary and unclassified model rejections hard", () => {
  const r = reviewer();

  assert.equal(r.hardModelReject({
    rejected: true,
    finalScore: 70,
    rejectionReason: "compilation",
    scores: { genreConfidence: 60 }
  }), true);
  assert.equal(r.hardModelReject({
    rejected: true,
    finalScore: 40,
    rejectionReason: "SEO playlist filler",
    scores: { genreConfidence: 20 }
  }), true);
});

test("original-artist-only veto becomes a bounded warning for a named remix without replacing its other evidence", async () => {
  const track = { id: "90471480", artist: "Pendulum", title: "9,000 Miles (Eelke Kleijn Remix)", score: 80,
    scoreBreakdown: { total: 80, promptMatch: { percent: 85 }, tasteMatch: { percent: 75 }, matchGenre: "Progressive House", recommendationV2: { applied: true, sonicAdjustment: 6 } } };
  const original = structuredClone(track);
  const score = { trackId: track.id, rejected: true, rejectionBasis: ["original_artist_profile_mismatch"], rejectionReason: "Pendulum is not in the Progressive House taste profile.", finalScore: 5,
    genre: "Drum & Bass", scores: { promptMatch: 5, tasteMatch: 5, genreConfidence: 5 }, why: ["Original artist mismatch"] };
  const r = reviewer([score]);
  assert.equal(r.hardModelReject(score, track), false);
  const reviewed = await r.applyModelCandidateReview({ tracks: [track], alternates: [], discarded: [], verification: { requested: 1 } });
  const kept = reviewed.result.tracks[0];
  assert.equal(kept.score, 78);
  assert.deepEqual(kept.scoreBreakdown.promptMatch, original.scoreBreakdown.promptMatch);
  assert.deepEqual(kept.scoreBreakdown.tasteMatch, original.scoreBreakdown.tasteMatch);
  assert.equal(kept.scoreBreakdown.matchGenre, "Progressive House");
  assert.deepEqual(kept.scoreBreakdown.recommendationV2, original.scoreBreakdown.recommendationV2);
  assert.equal(kept.llmReview.rejected, false);
  assert.equal(kept.llmReview.reportedRejected, true);
  assert.match(kept.modelReview.reason, /weak signal only/);
  assert.equal(kept.modelReview.action, "warning");
  assert.equal(reviewed.review.rejected, 0);
  assert.equal(reviewed.review.audit.warningCount, 1);
  assert.equal(reviewed.result.discarded.length, 0);
  assert.deepEqual(track, original);
});

test("remix exception preserves independent rejection reasons, generic versions and known hard failures", () => {
  const r = reviewer();
  const track = { artist: "Pendulum", title: "9,000 Miles (Eelke Kleijn Remix)" };
  const score = { rejected: true, rejectionBasis: ["original_artist_profile_mismatch"] };
  for (const independent of ["version_mismatch", "duration_mismatch", "track_genre_mismatch", "vibe_mismatch", "catalogue_quality", "explicit_request_mismatch", "insufficient_evidence", "unknown_basis"]) {
    assert.equal(r.hardModelReject({ ...score, rejectionBasis: [...score.rejectionBasis, independent] }, track), true, independent);
  }
  assert.equal(r.hardModelReject({ ...score, rejectionBasis: [] }, track), true);
  assert.equal(r.hardModelReject(score, { ...track, title: "9,000 Miles (Remix)" }), true);
  assert.equal(r.hardModelReject(score, { ...track, title: "9,000 Miles (Original Mix)" }), true);
  assert.equal(r.hardModelReject(score, { ...track, mixVersion: "Original Mix" }), true);
  assert.equal(r.hardModelReject(score, { ...track, admissionDiagnostics: { durationConstraints: { hard: true, passed: false } } }), true);
});

test("a valid negative model judgment of the remix itself still removes the candidate", async () => {
  const track = { id: "remix", artist: "Outside Artist", title: "Track (Named Producer Remix)", score: 80 };
  const r = reviewer([{ trackId: "remix", rejected: true, rejectionBasis: ["vibe_mismatch"], rejectionReason: "Verified vocal version conflicts with the explicit instrumental-only request.", finalScore: 20 }]);
  const reviewed = await r.applyModelCandidateReview({ tracks: [track], alternates: [] });
  assert.equal(reviewed.result.tracks.length, 0);
  assert.equal(reviewed.result.discarded.length, 1);
  assert.equal(reviewed.review.rejected, 1);
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

test("applyModelCandidateReview fails closed when dropping rejects undershoots", async () => {
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

  assert.equal(reviewed.result.tracks.length, 0);
  assert.equal(reviewed.result.discarded.length, 1);
  assert.equal(reviewed.review.rejected, 1);
  assert.equal(reviewed.review.rejectedKept, 0);
});

test("applyModelCandidateReview records model rejection stage for duration diagnostics", async () => {
  const r = reviewer([{
    trackId: "drop",
    rejected: true,
    finalScore: 0,
    rejectionReason: "Compilation/DJ mix",
    scores: { genreConfidence: 0 }
  }]);
  const reviewed = await r.applyModelCandidateReview({
    tracks: [{
      id: "drop",
      tidalUrl: "https://tidal.com/browse/track/drop",
      artist: "Artist",
      title: "Long Radio Disc",
      durationMs: 8 * 60 * 1000,
      score: 80
    }],
    alternates: [],
    discarded: [],
    verification: {
      requested: 1,
      poolDiagnostics: {
        candidateAccumulation: {
          durationCandidates: [{
            key: "https://tidal.com/browse/track/drop",
            artist: "Artist",
            title: "Long Radio Disc",
            scoreBeforeRejection: 80,
            candidateAccumulation: { status: "selected", stage: "final-selection" }
          }]
        }
      }
    }
  }, {});

  const diagnostic = reviewed.result.verification.poolDiagnostics.candidateAccumulation.durationCandidates[0];
  assert.equal(diagnostic.candidateAccumulation.status, "dropped");
  assert.equal(diagnostic.candidateAccumulation.stage, "model-review");
  assert.match(diagnostic.droppedReason, /Compilation\/DJ mix/);
});
