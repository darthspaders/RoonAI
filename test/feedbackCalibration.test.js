"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildDiscoveryProfile, scoreBreakdownFor } = require("../src/discoveryEngine");
const { TasteProfile, feedbackCalibrationEntry, rebuildCalibration } = require("../src/tasteProfile");
const { TrackMemory } = require("../src/trackMemory");

function tempTasteFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-calibration-"));
  return path.join(dir, "taste-profile.json");
}

function tempMemoryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-memory-"));
  return path.join(dir, "track-memory.json");
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

test("reject similar records targeted calibration without artist penalty", () => {
  const taste = new TasteProfile(tempTasteFile());
  const result = taste.record({
    artist: "KAI Music",
    title: "A New Birth (Emotional Melodic EDM / Progressive House)",
    label: "Generic Uploads",
    discoverySource: "TIDAL search",
    discoveryLane: "expanded",
    tidalUrl: "https://tidal.com/browse/track/generic-style-title",
    modelReview: {
      action: "unchanged",
      before: 45,
      after: 45,
      modelScore: 45,
      genreConfidence: 35,
      reason: "Weak prompt fit"
    }
  }, "reject_similar", {
    reason: "Risk: generic genre-title wording; weak prompt match"
  });
  const profile = taste.read();

  assert.equal(result.feedback.rating, "reject_similar");
  assert.equal(result.feedback.artistSignalBlocked, true);
  assert.equal(result.feedback.calibration.issue, "reject_similar");
  assert.match(result.feedback.calibration.reason, /generic genre-title/i);
  assert.equal(profile.calibration.total, 1);
  assert.equal(profile.calibration.modelMisses, 1);
  assert.equal(profile.calibration.recent[0].issue, "reject_similar");
  assert.equal(profile.artists["kai music"], undefined);
  assert.ok(profile.labels["generic uploads"].score < 0);
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
  assert.match(adjustment.reasons.join(" "), /feedback issues/i);
});

test("wrong-genre feedback calibrates future buckets even without model review", () => {
  const taste = new TasteProfile(tempTasteFile());
  taste.record({
    artist: "Mango",
    title: "Leben",
    label: "Unwanted Label",
    discoverySource: "Similar artist",
    discoveryLane: "core",
    tidalUrl: "https://tidal.com/browse/track/wrong-genre-unreviewed"
  }, "wrong_genre");

  const profile = taste.read();
  const adjustment = taste.calibrationAdjustmentFor({
    artist: "Another Artist",
    title: "Another Track",
    label: "Unwanted Label",
    discoverySource: "Similar artist",
    discoveryLane: "core"
  });

  assert.equal(profile.calibration.modelMisses, 0);
  assert.equal(profile.calibration.promptMismatches, 1);
  assert.ok(adjustment.value < 0);
  assert.match(adjustment.reasons.join(" "), /feedback issues/i);
});

test("prompt-only wrong-genre buckets stay visible in ranked calibration summary", () => {
  const feedback = {};
  for (let index = 0; index < 8; index += 1) {
    const detail = feedbackCalibrationEntry({
      artist: `Model Artist ${index}`,
      title: `Model Track ${index}`,
      label: `Model Label ${index}`,
      discoverySource: `Model Source ${index}`,
      discoveryLane: "core",
      modelReview: {
        action: "boosted",
        modelScore: 80
      }
    }, "skip");
    feedback[`model-${index}`] = {
      artist: `Model Artist ${index}`,
      title: `Model Track ${index}`,
      rating: "skip",
      calibration: detail,
      updatedAt: detail.recordedAt
    };
  }

  for (let index = 0; index < 2; index += 1) {
    const wrongGenreDetail = feedbackCalibrationEntry({
      artist: `Prompt Artist ${index}`,
      title: `Prompt Track ${index}`,
      label: "Prompt Label",
      discoverySource: "Prompt Source",
      discoveryLane: "core"
    }, "wrong_genre");
    feedback[`prompt-${index}`] = {
      artist: `Prompt Artist ${index}`,
      title: `Prompt Track ${index}`,
      rating: "wrong_genre",
      calibration: wrongGenreDetail,
      updatedAt: wrongGenreDetail.recordedAt
    };
  }

  const calibration = rebuildCalibration(feedback);
  const promptSource = calibration.sources.find((entry) => entry.source === "Prompt Source");
  assert.ok(promptSource);
  assert.equal(promptSource.issueCount, 2);
  assert.equal(promptSource.modelMisses, 0);
  assert.equal(promptSource.promptMismatches, 2);
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

test("liked long-shot feedback creates a future serendipity boost", () => {
  const taste = new TasteProfile(tempTasteFile());
  const result = taste.record({
    artist: "Ezequiel Arias",
    title: "You (Extended Mix)",
    label: "Anjunadeep",
    score: 52,
    discoverySource: "Similar artist branch",
    discoveryLane: "branch",
    tidalUrl: "https://tidal.com/browse/track/liked-long-shot"
  }, "love");
  const profile = taste.read();
  const adjustment = taste.serendipityAdjustmentFor({
    artist: "Folgar",
    title: "Promising Detour",
    label: "Anjunadeep",
    discoverySource: "Similar artist branch",
    discoveryLane: "branch"
  });

  assert.equal(result.feedback.calibration.issue, "liked_longshot");
  assert.equal(profile.calibration.likedLongShots, 1);
  assert.equal(profile.calibration.recent[0].issue, "liked_longshot");
  assert.ok(adjustment.value > 0);
  assert.match(adjustment.reasons.join(" "), /liked long shots/i);
});

test("feedback saved by TIDAL URL is found for now-playing artist and title", () => {
  const taste = new TasteProfile(tempTasteFile());
  taste.record({
    artist: "Tim Green",
    title: "Shiratani",
    tidalUrl: "https://tidal.com/browse/track/285143430"
  }, "love");

  assert.equal(taste.getFeedbackFor({
    artist: "Tim Green",
    title: "Shiratani"
  }), "love");
  assert.equal(taste.getFeedbackFor({
    metadataEnrichment: {
      artist: "TIM GREEN",
      title: "Shiratani",
      tidalUrl: "https://tidal.com/browse/track/285143430"
    }
  }), "love");
});

test("discovery scoring lifts verified sparse-metadata long shots", () => {
  const options = {
    request: "Find underground progressive house long shots",
    genres: "progressive house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const candidate = {
    artist: "Ezequiel Arias / Folgar",
    title: "You (Extended Mix)",
    album: "You",
    durationMs: 378000,
    query: "underground progressive house Ezequiel Arias Folgar",
    discoverySource: "Similar artist branch",
    discoveryLane: "branch",
    tidalUrl: "https://tidal.com/browse/track/serendipity-candidate",
    verificationSource: "tidal"
  };
  const scored = scoreBreakdownFor(candidate, options, null, profile);
  const categoryTotal = scored.freshness + scored.labelMatch + scored.artistMatch + scored.lengthPreference + scored.genreMatch;

  assert.ok(scored.serendipityAdjustment > 0);
  assert.match(scored.serendipityReasons.join(" "), /long shot/i);
  assert.equal(scored.total, categoryTotal + scored.tasteAdjustment + scored.calibrationAdjustment + scored.serendipityAdjustment);
});

test("pure search does not apply serendipity scoring", () => {
  const options = {
    request: "Find tracks by Ezequiel Arias",
    genres: "progressive house",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);
  const scored = scoreBreakdownFor({
    artist: "Ezequiel Arias",
    title: "You (Extended Mix)",
    album: "You",
    durationMs: 378000,
    query: "Ezequiel Arias You Extended Mix",
    discoverySource: "Similar artist branch",
    discoveryLane: "branch",
    tidalUrl: "https://tidal.com/browse/track/pure-search"
  }, options, null, profile);

  assert.equal(scored.serendipityAdjustment, 0);
});

test("live radio feedback is remembered as taste signal without discovery score", () => {
  const taste = new TasteProfile(tempTasteFile());
  const result = taste.record({
    artist: "Ancient Analog",
    title: "Medicine Drum",
    album: "Songs From A Vortex Named WEHO",
    sourceType: "radio",
    isRadio: true,
    isLiveRadio: true,
    discoverySource: "Live radio",
    discoveryLane: "radio"
  }, "love");
  const profile = taste.read();
  const feedback = Object.values(profile.feedback)[0];

  assert.equal(result.feedback.rating, "love");
  assert.equal(feedback.score, null);
  assert.equal(feedback.tasteScore, 3);
  assert.equal(feedback.sourceType, "radio");
  assert.equal(feedback.isLiveRadio, true);
  assert.equal(feedback.discoverySource, "Live radio");
  assert.equal(feedback.discoveryLane, "radio");
  assert.equal(profile.artists["ancient analog"].score, 3);
  assert.equal(profile.calibration.sources[0].source, "Live radio");
  assert.equal(profile.calibration.lanes[0].lane, "radio");
});

test("track memory preserves live radio feedback metadata and taste score", () => {
  const memory = new TrackMemory({ file: tempMemoryFile() });
  memory.updateFeedback({
    artist: "Ancient Analog",
    title: "Medicine Drum",
    album: "Songs From A Vortex Named WEHO",
    sourceType: "radio",
    isRadio: true,
    isLiveRadio: true,
    discoverySource: "Live radio",
    discoveryLane: "radio",
    playbackSource: {
      display: "MP3 44.1kHz 2ch 320kbps"
    }
  }, "skip");
  const entry = memory.find({
    artist: "Ancient Analog",
    title: "Medicine Drum"
  });

  assert.equal(entry.feedback, "skip");
  assert.equal(entry.tasteScore, -1);
  assert.equal(entry.sourceType, "radio");
  assert.equal(entry.isRadio, true);
  assert.equal(entry.isLiveRadio, true);
  assert.equal(entry.discoverySource, "Live radio");
  assert.equal(entry.discoveryLane, "radio");
  assert.equal(entry.playbackSource.display, "MP3 44.1kHz 2ch 320kbps");
});
