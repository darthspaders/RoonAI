"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildDiscoveryProfile, scoreBreakdownFor } = require("../src/discoveryEngine");
const { TasteProfile, feedbackCalibrationEntry, rebuildCalibration } = require("../src/tasteProfile");

function tempTasteFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-calibration-"));
  return path.join(dir, "taste-profile.json");
}

test("feedback calibration marks wrong-genre model approvals as model misses without taste penalty", () => {
  const taste = new TasteProfile(tempTasteFile());
  const track = {
    artist: "Crizpy7",
    title: "C7 Deep Tech House Fusions 10-2025",
    label: "SEO Compilations",
    discoverySource: "TIDAL search",
    discoveryLane: "expanded",
    tidalUrl: "https://tidal.com/browse/track/seo-sludge",
    modelReview: {
      action: "boosted",
      before: 64,
      after: 72,
      delta: 8,
      modelScore: 78,
      genreConfidence: 55,
      reason: "Model thought metadata was close enough"
    }
  };

  const result = taste.record(track, "wrong_genre");
  const profile = taste.read();

  assert.equal(result.feedback.rating, "wrong_genre");
  assert.equal(profile.calibration.total, 1);
  assert.equal(profile.calibration.reviewed, 1);
  assert.equal(profile.calibration.promptMismatches, 1);
  assert.equal(profile.calibration.modelMisses, 1);
  assert.equal(profile.calibration.badBoosts, 1);
  assert.equal(profile.calibration.recent[0].issue, "wrong_genre");
  assert.equal(profile.artists.crizpy7, undefined);
  assert.equal(profile.labels["seo compilations"], undefined);
});

test("feedback calibration records liked tracks that the model downranked", () => {
  const detail = feedbackCalibrationEntry({
    artist: "Calecast",
    title: "Infinite Enclosure",
    discoverySource: "TIDAL search",
    modelReview: {
      action: "downranked",
      before: 78,
      after: 66,
      delta: -12,
      modelScore: 62,
      genreConfidence: 70
    }
  }, "love");

  const calibration = rebuildCalibration({
    "calecast|infinite enclosure": {
      artist: "Calecast",
      title: "Infinite Enclosure",
      rating: "love",
      calibration: detail,
      updatedAt: detail.recordedAt
    }
  });

  assert.equal(calibration.total, 1);
  assert.equal(calibration.reviewed, 1);
  assert.equal(calibration.modelMisses, 1);
  assert.equal(calibration.missedLikes, 1);
  assert.equal(calibration.recent[0].issue, "liked_downranked");
});

test("calibration adjustment is neutral when no bucket matches", () => {
  const taste = new TasteProfile(tempTasteFile());
  const adjustment = taste.calibrationAdjustmentFor({
    artist: "Unknown Artist",
    title: "Unknown Track",
    label: "Unknown Label",
    discoverySource: "Unseen source",
    discoveryLane: "core"
  });

  assert.deepEqual(adjustment, { value: 0, reasons: [] });
});

test("calibration dampens future candidates from repeatedly bad buckets", () => {
  const taste = new TasteProfile(tempTasteFile());
  taste.record({
    artist: "Crizpy7",
    title: "C7 Deep Tech House Fusions 10-2025",
    label: "SEO Compilations",
    discoverySource: "TIDAL search",
    discoveryLane: "expanded",
    tidalUrl: "https://tidal.com/browse/track/seo-sludge",
    modelReview: {
      action: "boosted",
      before: 64,
      after: 72,
      delta: 8,
      modelScore: 78,
      genreConfidence: 55
    }
  }, "wrong_genre");

  const adjustment = taste.calibrationAdjustmentFor({
    artist: "Another Artist",
    title: "Another SEO Track",
    label: "SEO Compilations",
    discoverySource: "TIDAL search",
    discoveryLane: "expanded"
  });

  assert.ok(adjustment.value < 0);
  assert.match(adjustment.reasons.join(" "), /feedback misses/i);
});

test("discovery scoring applies calibration as a separate soft adjustment", () => {
  const taste = new TasteProfile(tempTasteFile());
  taste.record({
    artist: "Crizpy7",
    title: "C7 Deep Tech House Fusions 10-2025",
    label: "SEO Compilations",
    discoverySource: "TIDAL search",
    discoveryLane: "expanded",
    tidalUrl: "https://tidal.com/browse/track/seo-sludge-score",
    modelReview: {
      action: "boosted",
      modelScore: 78,
      genreConfidence: 55
    }
  }, "wrong_genre");

  const options = {
    request: "Find deep tech house",
    genres: "deep tech house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const candidate = {
    artist: "Another Artist",
    title: "Deep Tech Utility",
    album: "Deep Tech Utility",
    label: "SEO Compilations",
    year: 2026,
    durationMs: 390000,
    query: "deep tech house 2026",
    discoverySource: "TIDAL search",
    discoveryLane: "expanded"
  };
  const base = scoreBreakdownFor(candidate, options, null, profile);
  const scored = scoreBreakdownFor(candidate, options, taste, profile);

  assert.ok(scored.calibrationAdjustment < 0);
  assert.ok(scored.total < base.total);
  assert.equal(scored.tasteAdjustment, base.tasteAdjustment);
});
