"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isNegativeRating,
  isPositiveRating,
  normalizeRating
} = require("../src/feedbackRatings");
const { ratingDelta } = require("../src/tasteProfile");
const { TrackMemory } = require("../src/trackMemory");

test("shared feedback rating normalization preserves canonical aliases", () => {
  assert.equal(normalizeRating("love"), "love");
  assert.equal(normalizeRating("like"), "like");
  assert.equal(normalizeRating("up"), "good");
  assert.equal(normalizeRating("okay"), "ok");
  assert.equal(normalizeRating("dislike"), "dislike");
  assert.equal(normalizeRating("wrong genre"), "wrong_genre");
  assert.equal(normalizeRating("not what i asked for"), "wrong_genre");
  assert.equal(normalizeRating("similar_bad"), "reject_similar");
  assert.equal(normalizeRating("down"), "skip");
  assert.equal(normalizeRating("never again"), "never");
});

test("shared feedback rating normalization preserves caller fallback behavior", () => {
  assert.equal(normalizeRating("unknown-input"), "ok");
  assert.equal(normalizeRating("unknown-input", { fallback: "good" }), "good");
  assert.equal(normalizeRating("unknown-input", { fallback: "" }), "");
});

test("shared feedback rating predicates classify canonical ratings", () => {
  assert.equal(isPositiveRating("love"), true);
  assert.equal(isPositiveRating("like"), true);
  assert.equal(isPositiveRating("good"), true);
  assert.equal(isPositiveRating("ok"), false);
  assert.equal(isNegativeRating("dislike"), true);
  assert.equal(isNegativeRating("wrong genre"), true);
  assert.equal(isNegativeRating("reject_similar"), true);
  assert.equal(isNegativeRating("skip"), true);
  assert.equal(isNegativeRating("never"), true);
});

test("new feedback vocabulary is intentionally conservative", () => {
  assert.equal(ratingDelta("love"), 3);
  assert.equal(ratingDelta("like"), 0.75);
  assert.equal(ratingDelta("good"), 0.75);
  assert.equal(ratingDelta("ok"), -0.25);
  assert.equal(ratingDelta("dislike"), -1.5);
  assert.equal(ratingDelta("never again"), -3);

  const memory = new TrackMemory({ file: "", maxBytes: 0 });
  memory.updateFeedback({ artist: "Example Artist", title: "Example Track" }, "dislike");
  const entry = memory.find({ artist: "Example Artist", title: "Example Track" });
  assert.equal(entry.feedback, "dislike");
  assert.equal(entry.tasteScore, -1.5);
});

test("okay is a slight negative memory signal without becoming a hard negative rating", () => {
  const memory = new TrackMemory({ file: "", maxBytes: 0 });
  memory.updateFeedback({ artist: "Example Artist", title: "Okay Track" }, "okay");
  const entry = memory.find({ artist: "Example Artist", title: "Okay Track" });
  assert.equal(entry.tasteScore, -0.25);
});

test("wrong genre remains neutral for taste but negative for track memory", () => {
  assert.equal(ratingDelta("wrong genre"), 0);

  const memory = new TrackMemory({ file: "", maxBytes: 0 });
  memory.updateFeedback({
    artist: "Example Artist",
    title: "Example Track"
  }, "wrong genre");

  const entry = memory.find({
    artist: "Example Artist",
    title: "Example Track"
  });
  assert.equal(entry.tasteScore, -1);
  assert.equal(entry.feedback, "wrong genre");
});
