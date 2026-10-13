"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { captureRetrospectiveInput, inputForFeedback } = require("../src/retrospectiveReviewInput");
const { feedbackCalibrationContext } = require("../src/feedbackContext");
const { TasteProfile } = require("../src/tasteProfile");
const { trackKey } = require("../src/sessionStore");

const track = { artist: "Ruben", title: "Track (Named Remix)", tidalUrl: "https://tidal.com/track/123", label: "Label", score: 42 };

test("review input removes feedback, scores, inferred evidence and current taste", () => {
  const input = captureRetrospectiveInput({ ...track, feedback: "love", tasteScore: 3,
    reason: "later target label", why: ["later reasoning"], modelReview: { action: "rejected" },
    scoreBreakdown: { total: 42 }, currentTaste: { liked: "Ruben" } },
  { request: "Progressive house", rating: "love", reason: "liked it", reference: "current taste", genres: "House" }, "2026-10-07T22:00:00Z");
  assert.deepEqual(input.options, { request: "Progressive house", genres: "House" });
  assert.equal(input.contextQuality, "original-request");
  assert.equal(input.track.id, track.tidalUrl);
  assert.doesNotMatch(JSON.stringify(input), /love|later|tasteScore|scoreBreakdown|currentTaste/);
});

test("older rows use only their saved facts and explicitly lack original request", () => {
  const input = inputForFeedback({ ...track, rating: "like", calibration: { reason: "feedback reason", modelAction: "unreviewed" }, updatedAt: "2026-10-07T22:00:00Z" });
  assert.equal(input.contextQuality, "metadata-only");
  assert.deepEqual(input.options, {});
  assert.equal(input.snapshotAt, "2026-10-07T22:00:00Z");
  assert.doesNotMatch(JSON.stringify(input), /feedback reason|unreviewed|like/);
  for (const updatedAt of [undefined, "invalid-date"]) {
    const unknown = inputForFeedback({ ...track, updatedAt });
    assert.equal(unknown.snapshotAt, null);
    assert.equal(unknown.contextQuality, "metadata-only");
    assert.deepEqual(unknown.options, {});
  }
});

test("same names never transfer request context across different provider recordings", () => {
  const original = { ...track, tidalId: "123" };
  const reviewInput = captureRetrospectiveInput(original, { request: "Frozen search" });
  assert.equal(inputForFeedback({ ...track, reviewInput }).contextQuality, "original-request");
  for (const changed of [
    { ...track, tidalUrl: "https://tidal.com/track/456" },
    { ...track, tidalId: "456" },
    { artist: track.artist, title: track.title },
    { ...track, tidalId: "456", tidalUrl: "https://tidal.com/track/123" }
  ]) assert.equal(inputForFeedback({ ...changed, reviewInput }).contextQuality, "metadata-only");
});

test("only an exact matching session contributes original discovery options", () => {
  const sessionStore = { read: () => ({ options: { request: "Original search", rating: "love" }, result: { tracks: [track] } }) };
  const context = feedbackCalibrationContext({ ...track, feedback: "love" }, { request: "Do not use feedback body", rating: "love" }, { sessionStore, trackKey });
  assert.equal(context.reviewInput.options.request, "Original search");
  assert.doesNotMatch(JSON.stringify(context.reviewInput), /love|feedback body/);
  const other = feedbackCalibrationContext({ artist: "Other", title: "Track" }, {}, { sessionStore, trackKey });
  assert.equal(other.reviewInput.contextQuality, "metadata-only");
  const mismatch = inputForFeedback({ ...track, reviewInput: captureRetrospectiveInput({ ...track, title: "Other" }, { request: "Wrong request" }) });
  assert.equal(mismatch.contextQuality, "metadata-only");
});

test("future feedback stores frozen safe review inputs while preserving original calibration", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-retrospective-input-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new TasteProfile(path.join(dir, "taste.json"));
  const context = feedbackCalibrationContext(track, {}, { sessionStore: { read: () => ({ options: { request: "Frozen search" }, result: { tracks: [track] } }) }, trackKey });
  const saved = store.record(track, "love", context).feedback;
  assert.equal(saved.rating, "love");
  assert.equal(saved.score, 42);
  assert.equal(saved.calibration.modelAction, "unreviewed");
  assert.equal(saved.calibration.likedLongShot, true);
  assert.equal(saved.reviewInput.options.request, "Frozen search");
  assert.equal(store.summary().calibration.reviewed, 0);
  assert.equal(store.summary().calibration.likedLongShots, 1);
  context.reviewInput.options.request = "Changed after save";
  assert.equal(store.read().feedback[trackKey(track)].reviewInput.options.request, "Frozen search");
});
