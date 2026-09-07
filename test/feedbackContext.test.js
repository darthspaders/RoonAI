"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  feedbackCalibrationContext,
  feedbackTrackWithSessionContext,
  sessionTrackFor
} = require("../src/feedbackContext");

const trackKey = (track = {}) => String(track.tidalUrl || `${track.artist || ""}|${track.title || ""}`).toLowerCase().trim();
const ratingDelta = (rating) => rating === "love" ? 2 : 0;

test("feedback context merges matching session track evidence before recording", () => {
  const sessionTrack = {
    artist: "Example Artist",
    title: "Example Track",
    discoverySource: "Similar artist",
    discoveryLane: "branch",
    scoreBreakdown: { total: 74 },
    modelReview: { action: "boosted", before: 65, after: 74 }
  };
  const sessionStore = {
    read: () => ({
      result: {
        tracks: [sessionTrack],
        alternates: [],
        discarded: []
      }
    })
  };

  assert.equal(sessionTrackFor({ artist: "Example Artist", title: "Example Track" }, { sessionStore, trackKey }), sessionTrack);

  const merged = feedbackTrackWithSessionContext(
    { artist: "Example Artist", title: "Example Track" },
    "love",
    { sessionStore, trackKey, ratingDelta }
  );

  assert.equal(merged.discoverySource, "Similar artist");
  assert.equal(merged.discoveryLane, "branch");
  assert.deepEqual(merged.scoreBreakdown, { total: 74 });
  assert.deepEqual(merged.modelReview, { action: "boosted", before: 65, after: 74 });
  assert.equal(merged.tasteScore, 2);
});

test("feedback context normalizes live radio feedback metadata", () => {
  const merged = feedbackTrackWithSessionContext(
    {
      artist: "Radio Artist",
      title: "Radio Track",
      isRadio: true,
      discoverySource: "Now playing",
      statusChecks: ["Existing check"]
    },
    "good",
    {
      sessionStore: { read: () => ({ result: null }) },
      trackKey,
      ratingDelta
    }
  );

  assert.equal(merged.sourceType, "radio");
  assert.equal(merged.isRadio, true);
  assert.equal(merged.isLiveRadio, true);
  assert.equal(merged.discoverySource, "Live radio");
  assert.equal(merged.discoveryLane, "radio");
  assert.deepEqual(merged.statusChecks, ["Existing check", "Live radio feedback"]);
});

test("feedback calibration context preserves model and score fields", () => {
  const context = feedbackCalibrationContext({
    score: 71,
    modelReview: {
      action: "boosted",
      before: 63,
      after: 71,
      delta: 8,
      modelScore: 78,
      genreConfidence: 55,
      reason: "model reason"
    },
    promptMatch: { percent: 66 },
    tasteMatch: { score: 2 },
    discoverySource: "TIDAL search",
    discoveryLane: "core"
  }, {
    reason: "user reason"
  });

  assert.equal(context.modelAction, "boosted");
  assert.equal(context.beforeScore, 63);
  assert.equal(context.afterScore, 71);
  assert.equal(context.delta, 8);
  assert.equal(context.score, 71);
  assert.equal(context.modelScore, 78);
  assert.equal(context.genreConfidence, 55);
  assert.deepEqual(context.promptMatch, { percent: 66 });
  assert.deepEqual(context.tasteMatch, { score: 2 });
  assert.equal(context.reason, "user reason");
  assert.equal(context.discoverySource, "TIDAL search");
  assert.equal(context.discoveryLane, "core");
});
