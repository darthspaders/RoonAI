"use strict";

const fs = require("fs");
const path = require("path");
const { trackKey } = require("./sessionStore");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalArtistName(value) {
  const text = cleanText(value).replace(/[‐‑‒–—−]/g, "-");
  if (normalize(text) === "d nox") return "D-Nox";
  return text;
}

function splitArtists(value) {
  return cleanText(value)
    .split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i)
    .map(canonicalArtistName)
    .filter((part) => part && part.length <= 60);
}

function labelFor(track = {}) {
  return cleanText(track.label || track.tidal?.label || "");
}

const AMBIGUOUS_SCENE_ANCHORS = new Set([
  "freedom fighters"
]);

function trustedSceneLabel(value) {
  return /\b(?:iboga|iono|nano|spin twist|blue tunes|digital om|techsafari|sacred technology|joof|tesseractstudio|shamanic tales|hommega|stereo society|dacru|sourcecode)\b/i.test(cleanText(value));
}

function shouldBlockArtistSignal(track = {}, delta = 0) {
  if (track.artistSignalBlocked) return true;
  if (delta >= 0) return false;
  if (trustedSceneLabel(labelFor(track))) return false;
  return splitArtists(track.artist).some((artist) => AMBIGUOUS_SCENE_ANCHORS.has(normalize(artist)));
}

function normalizeRating(value) {
  const rating = cleanText(value).toLowerCase();
  if (rating === "love") return "love";
  if (rating === "good" || rating === "up") return "good";
  if (rating === "ok" || rating === "okay") return "ok";
  if (rating === "wrong_genre" || rating === "wrong genre" || rating === "wrong" || rating === "not what i asked for" || rating === "not_asked") return "wrong_genre";
  if (rating === "reject_similar" || rating === "reject similar" || rating === "similar_bad" || rating === "similar") return "reject_similar";
  if (rating === "skip" || rating === "down") return "skip";
  if (rating === "never" || rating === "never again" || rating === "never_again") return "never";
  return "good";
}

function ratingDelta(value) {
  const rating = normalizeRating(value);
  if (rating === "love") return 3;
  if (rating === "good") return 1;
  if (rating === "ok") return 0.5;
  if (rating === "reject_similar") return -1;
  if (rating === "skip") return -1;
  if (rating === "never") return -3;
  return 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function modelReviewFrom(track = {}, context = {}) {
  const explicitReview = context.modelReview || track.modelReview || {};
  const llmReview = track.scoreBreakdown?.llmReview || track.llmReview || {};
  const action = cleanText(
    context.modelAction ||
    explicitReview.action ||
    track.modelReviewAction ||
    ""
  ).toLowerCase();

  return {
    action: action || "unreviewed",
    before: numberOrNull(context.beforeScore ?? explicitReview.before),
    after: numberOrNull(context.afterScore ?? explicitReview.after),
    delta: numberOrNull(context.delta ?? explicitReview.delta),
    modelScore: numberOrNull(context.modelScore ?? explicitReview.modelScore ?? llmReview.finalScore),
    genreConfidence: numberOrNull(context.genreConfidence ?? explicitReview.genreConfidence ?? llmReview.genreConfidence),
    promptMatch: numberOrNull(context.promptMatch ?? track.promptMatch ?? track.scoreBreakdown?.promptMatch),
    tasteMatch: numberOrNull(context.tasteMatch ?? track.tasteMatch ?? track.scoreBreakdown?.tasteMatch),
    reason: cleanText(context.reason || explicitReview.reason || llmReview.rejectionReason)
  };
}

function feedbackCalibrationEntry(track = {}, rating = "", context = {}) {
  const normalizedRating = normalizeRating(rating);
  const review = modelReviewFrom(track, context);
  const source = cleanText(track.discoverySource || context.discoverySource || "Unknown source");
  const lane = cleanText(track.discoveryLane || context.discoveryLane || "unknown");
  const label = labelFor(track);
  const negativeFeedback = ["wrong_genre", "reject_similar", "skip", "never"].includes(normalizedRating);
  const positiveFeedback = ["love", "good"].includes(normalizedRating);
  const modelApproved = ["boosted", "unchanged", "warning"].includes(review.action) || Number(review.modelScore || 0) >= 70;
  const badBoost = negativeFeedback && review.action === "boosted";
  const promptMismatch = normalizedRating === "wrong_genre";
  const modelMiss = (negativeFeedback && modelApproved) || (positiveFeedback && ["downranked", "rejected"].includes(review.action));
  const missedLike = positiveFeedback && ["downranked", "rejected"].includes(review.action);

  return {
    rating: normalizedRating,
    modelAction: review.action,
    modelScore: review.modelScore,
    genreConfidence: review.genreConfidence,
    promptMatch: review.promptMatch,
    tasteMatch: review.tasteMatch,
    source,
    lane,
    label,
    promptMismatch,
    modelMiss,
    badBoost,
    missedLike,
    issue: promptMismatch
      ? "wrong_genre"
      : normalizedRating === "reject_similar"
        ? "reject_similar"
        : badBoost
          ? "bad_boost"
          : missedLike
            ? "liked_downranked"
            : (negativeFeedback && modelApproved ? "negative_model_approved" : ""),
    reason: review.reason,
    recordedAt: new Date().toISOString()
  };
}

function emptyCalibration() {
  return {
    total: 0,
    reviewed: 0,
    promptMismatches: 0,
    modelMisses: 0,
    badBoosts: 0,
    missedLikes: 0,
    ratingCounts: {},
    actionCounts: {},
    sources: [],
    lanes: [],
    labels: [],
    recent: [],
    updatedAt: null
  };
}

function increment(map, key, amount = 1) {
  const cleanKey = cleanText(key || "unknown");
  map[cleanKey] = Number(map[cleanKey] || 0) + amount;
}

function rebuildCalibration(feedback = {}) {
  const calibration = emptyCalibration();
  const sourceCounts = {};
  const laneCounts = {};
  const labelCounts = {};
  const recent = [];

  function addBucket(map, key, detail = {}) {
    const name = cleanText(key);
    if (!name) return;
    const entry = map[name] || { name, total: 0, modelMisses: 0, badBoosts: 0, promptMismatches: 0 };
    entry.total += 1;
    if (detail.modelMiss) entry.modelMisses += 1;
    if (detail.badBoost) entry.badBoosts += 1;
    if (detail.promptMismatch) entry.promptMismatches += 1;
    map[name] = entry;
  }

  for (const entry of Object.values(feedback || {})) {
    const detail = entry?.calibration;
    if (!detail) continue;

    calibration.total += 1;
    if (detail.modelAction && detail.modelAction !== "unreviewed") calibration.reviewed += 1;
    if (detail.promptMismatch) calibration.promptMismatches += 1;
    if (detail.modelMiss) calibration.modelMisses += 1;
    if (detail.badBoost) calibration.badBoosts += 1;
    if (detail.missedLike) calibration.missedLikes += 1;
    increment(calibration.ratingCounts, detail.rating);
    increment(calibration.actionCounts, detail.modelAction);

    const source = cleanText(detail.source || "Unknown source");
    addBucket(sourceCounts, source, detail);
    addBucket(laneCounts, detail.lane || "unknown", detail);
    addBucket(labelCounts, detail.label || entry.label, detail);

    if (detail.issue || detail.modelMiss || detail.promptMismatch) {
      recent.push({
        artist: cleanText(entry.artist),
        title: cleanText(entry.title),
        rating: detail.rating,
        modelAction: detail.modelAction,
        issue: detail.issue || (detail.modelMiss ? "model_miss" : "prompt_mismatch"),
        source,
        modelScore: detail.modelScore,
        genreConfidence: detail.genreConfidence,
        recordedAt: detail.recordedAt || entry.updatedAt || ""
      });
    }
  }

  const rankedBuckets = (map) => Object.values(map)
    .map((entry) => ({
      ...entry,
      missRate: entry.total ? Number((entry.modelMisses / entry.total).toFixed(2)) : 0
    }))
    .sort((left, right) => right.modelMisses - left.modelMisses || right.total - left.total || left.name.localeCompare(right.name))
    .slice(0, 8);
  calibration.sources = rankedBuckets(sourceCounts).map((entry) => ({ source: entry.name, ...entry }));
  calibration.lanes = rankedBuckets(laneCounts).map((entry) => ({ lane: entry.name, ...entry }));
  calibration.labels = rankedBuckets(labelCounts).map((entry) => ({ label: entry.name, ...entry }));
  calibration.recent = recent
    .sort((left, right) => String(right.recordedAt).localeCompare(String(left.recordedAt)))
    .slice(0, 10);
  calibration.updatedAt = calibration.recent[0]?.recordedAt || null;
  return calibration;
}

function calibrationBucketPenalty(entry = {}, weight = 1) {
  if (!entry) return 0;
  const total = Number(entry.total || 0);
  const misses = Number(entry.modelMisses || 0);
  const badBoosts = Number(entry.badBoosts || 0);
  const promptMismatches = Number(entry.promptMismatches || 0);
  if (!total || !misses) return 0;

  const missRate = misses / total;
  let penalty = misses >= 1 ? -1 : 0;
  if (total >= 2 && missRate >= 0.34) penalty -= 1;
  if (total >= 3 && missRate >= 0.5) penalty -= 1;
  if (badBoosts >= 2 || promptMismatches >= 2) penalty -= 1;
  return Math.round(penalty * weight);
}

function findCalibrationBucket(items = [], key = "", property = "name") {
  const wanted = normalize(key);
  if (!wanted) return null;
  return (items || []).find((item) => normalize(item[property] || item.name) === wanted) || null;
}

function updateWeightedEntry(map, name, delta) {
  const displayName = canonicalArtistName(name);
  const key = normalize(displayName);
  if (!key) return;
  const current = map[key] || { name: displayName, score: 0, up: 0, down: 0 };
  current.name = displayName || current.name;
  current.score += delta;
  if (delta > 0) current.up += 1;
  if (delta < 0) current.down += 1;
  map[key] = current;
}

function addTrackSignals(profile, track = {}, delta = 0) {
  if (!delta) return;
  if (!shouldBlockArtistSignal(track, delta)) {
    for (const artist of splitArtists(track.artist)) {
      updateWeightedEntry(profile.artists, artist, delta);
    }
  }
  const label = labelFor(track);
  if (label) updateWeightedEntry(profile.labels, label, delta);
}

function rebuildWeightedSignals(profile = {}) {
  const rebuilt = {
    ...profile,
    feedback: profile.feedback || {},
    candidates: profile.candidates || {},
    calibration: emptyCalibration(),
    artists: {},
    labels: {}
  };

  for (const entry of Object.values(rebuilt.feedback)) {
    addTrackSignals(rebuilt, entry, ratingDelta(entry.rating));
  }
  for (const entry of Object.values(rebuilt.candidates)) {
    addTrackSignals(rebuilt, entry, 0.5);
  }
  rebuilt.calibration = rebuildCalibration(rebuilt.feedback);

  return rebuilt;
}

class TasteProfile {
  constructor(filePath = path.join(__dirname, "..", "data", "taste-profile.json")) {
    this.filePath = filePath;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return rebuildWeightedSignals({
        feedback: parsed.feedback || {},
        candidates: parsed.candidates || {},
        calibration: parsed.calibration || emptyCalibration(),
        artists: parsed.artists || {},
        labels: parsed.labels || {},
        updatedAt: parsed.updatedAt || null
      });
    } catch {
      return {
        feedback: {},
        candidates: {},
        calibration: emptyCalibration(),
        artists: {},
        labels: {},
        updatedAt: null
      };
    }
  }

  write(profile) {
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(profile, null, 2));
    return profile;
  }

  record(track = {}, rating = "", context = {}) {
    const normalizedRating = normalizeRating(rating);
    const key = trackKey(track);
    if (!key) throw new Error("Cannot record feedback without a track identity.");

    const profile = this.read();
    const nextDelta = ratingDelta(normalizedRating);

    profile.feedback[key] = {
      rating: normalizedRating,
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      label: labelFor(track),
      tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl),
      promptMismatch: normalizedRating === "wrong_genre",
      artistSignalBlocked: normalizedRating === "wrong_genre" || normalizedRating === "reject_similar" || shouldBlockArtistSignal(track, nextDelta),
      calibration: feedbackCalibrationEntry(track, normalizedRating, context),
      updatedAt: new Date().toISOString()
    };

    profile.updatedAt = new Date().toISOString();
    const rebuilt = rebuildWeightedSignals(profile);
    this.write(rebuilt);
    return {
      feedback: rebuilt.feedback[key],
      profile: this.summary(rebuilt)
    };
  }

  recordCandidate(track = {}) {
    const key = trackKey(track);
    if (!key) throw new Error("Cannot record candidate signal without a track identity.");

    const profile = this.read();
    if (profile.candidates[key]) {
      return {
        candidate: profile.candidates[key],
        profile: this.summary(profile)
      };
    }

    const delta = 0.5;
    profile.candidates[key] = {
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      label: labelFor(track),
      tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl),
      savedAt: new Date().toISOString()
    };

    for (const artist of splitArtists(track.artist)) {
      updateWeightedEntry(profile.artists, artist, delta);
    }
    const label = labelFor(track);
    if (label) updateWeightedEntry(profile.labels, label, delta);

    profile.updatedAt = new Date().toISOString();
    this.write(profile);
    return {
      candidate: profile.candidates[key],
      profile: this.summary(profile)
    };
  }

  getFeedbackFor(track = {}) {
    const key = trackKey(track);
    const rating = key ? this.read().feedback[key]?.rating || "" : "";
    return rating ? normalizeRating(rating) : "";
  }

  getTopArtists(limit = 8) {
    return Object.values(this.read().artists)
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.up - left.up)
      .slice(0, limit)
      .map((entry) => entry.name);
  }

  adjustmentFor(track = {}) {
    const profile = this.read();
    let adjustment = 0;
    const reasons = [];

    for (const artist of splitArtists(track.artist)) {
      const entry = profile.artists[normalize(artist)];
      if (!entry?.score) continue;
      const value = Math.max(-8, Math.min(8, entry.score * 2));
      adjustment += value;
      reasons.push(`${entry.name} ${value > 0 ? "+" : ""}${value}`);
    }

    const label = labelFor(track);
    const labelEntry = label && profile.labels[normalize(label)];
    if (labelEntry?.score) {
      const value = Math.max(-6, Math.min(6, labelEntry.score * 2));
      adjustment += value;
      reasons.push(`${labelEntry.name} ${value > 0 ? "+" : ""}${value}`);
    }

    return {
      value: Math.max(-12, Math.min(12, adjustment)),
      reasons
    };
  }

  calibrationAdjustmentFor(track = {}) {
    const calibration = this.read().calibration || emptyCalibration();
    const reasons = [];
    let value = 0;

    const sourceEntry = findCalibrationBucket(calibration.sources, track.discoverySource || "Unknown source", "source");
    const laneEntry = findCalibrationBucket(calibration.lanes, track.discoveryLane || "unknown", "lane");
    const labelEntry = findCalibrationBucket(calibration.labels, labelFor(track), "label");
    const buckets = [
      ["source", sourceEntry, 1],
      ["lane", laneEntry, 0.75],
      ["label", labelEntry, 1.25]
    ];

    for (const [kind, entry, weight] of buckets) {
      const penalty = calibrationBucketPenalty(entry, weight);
      if (!penalty) continue;
      value += penalty;
      const name = entry.source || entry.lane || entry.label || entry.name || kind;
      reasons.push(`${kind} ${name} ${entry.modelMisses}/${entry.total} feedback misses ${penalty}`);
    }

    return {
      value: Math.max(-10, Math.min(0, value)),
      reasons: reasons.slice(0, 4)
    };
  }

  summary(profile = this.read()) {
    return {
      updatedAt: profile.updatedAt,
      likedArtists: Object.values(profile.artists).filter((entry) => entry.score > 0).length,
      rejectedArtists: Object.values(profile.artists).filter((entry) => entry.score < 0).length,
      likedLabels: Object.values(profile.labels).filter((entry) => entry.score > 0).length,
      rejectedLabels: Object.values(profile.labels).filter((entry) => entry.score < 0).length,
      feedbackCount: Object.keys(profile.feedback).length,
      candidateSignals: Object.keys(profile.candidates || {}).length,
      calibration: profile.calibration || rebuildCalibration(profile.feedback || {})
    };
  }
}

module.exports = {
  TasteProfile,
  feedbackCalibrationEntry,
  normalize,
  normalizeRating,
  rebuildCalibration,
  splitArtists
};
