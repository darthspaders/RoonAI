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

function normalizeRating(value) {
  const rating = cleanText(value).toLowerCase();
  if (rating === "love") return "love";
  if (rating === "good" || rating === "up") return "good";
  if (rating === "ok" || rating === "okay") return "ok";
  if (rating === "skip" || rating === "down") return "skip";
  if (rating === "never" || rating === "never again" || rating === "never_again") return "never";
  return "good";
}

function ratingDelta(value) {
  const rating = normalizeRating(value);
  if (rating === "love") return 3;
  if (rating === "good") return 1;
  if (rating === "ok") return 0.5;
  if (rating === "skip") return -1;
  if (rating === "never") return -3;
  return 0;
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
  for (const artist of splitArtists(track.artist)) {
    updateWeightedEntry(profile.artists, artist, delta);
  }
  const label = labelFor(track);
  if (label) updateWeightedEntry(profile.labels, label, delta);
}

function rebuildWeightedSignals(profile = {}) {
  const rebuilt = {
    ...profile,
    feedback: profile.feedback || {},
    candidates: profile.candidates || {},
    artists: {},
    labels: {}
  };

  for (const entry of Object.values(rebuilt.feedback)) {
    addTrackSignals(rebuilt, entry, ratingDelta(entry.rating));
  }
  for (const entry of Object.values(rebuilt.candidates)) {
    addTrackSignals(rebuilt, entry, 0.5);
  }

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
        artists: parsed.artists || {},
        labels: parsed.labels || {},
        updatedAt: parsed.updatedAt || null
      });
    } catch {
      return {
        feedback: {},
        candidates: {},
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

  record(track = {}, rating = "") {
    const normalizedRating = normalizeRating(rating);
    const key = trackKey(track);
    if (!key) throw new Error("Cannot record feedback without a track identity.");

    const profile = this.read();
    const previous = profile.feedback[key]?.rating;
    const previousDelta = previous ? ratingDelta(previous) : 0;
    const nextDelta = ratingDelta(normalizedRating);
    const delta = nextDelta - previousDelta;

    profile.feedback[key] = {
      rating: normalizedRating,
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      label: labelFor(track),
      tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl),
      updatedAt: new Date().toISOString()
    };

    for (const artist of splitArtists(track.artist)) {
      updateWeightedEntry(profile.artists, artist, delta);
    }
    const label = labelFor(track);
    if (label) updateWeightedEntry(profile.labels, label, delta);

    profile.updatedAt = new Date().toISOString();
    this.write(profile);
    return {
      feedback: profile.feedback[key],
      profile: this.summary(profile)
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

  summary(profile = this.read()) {
    return {
      updatedAt: profile.updatedAt,
      likedArtists: Object.values(profile.artists).filter((entry) => entry.score > 0).length,
      rejectedArtists: Object.values(profile.artists).filter((entry) => entry.score < 0).length,
      likedLabels: Object.values(profile.labels).filter((entry) => entry.score > 0).length,
      rejectedLabels: Object.values(profile.labels).filter((entry) => entry.score < 0).length,
      feedbackCount: Object.keys(profile.feedback).length,
      candidateSignals: Object.keys(profile.candidates || {}).length
    };
  }
}

module.exports = {
  TasteProfile,
  normalize,
  normalizeRating,
  splitArtists
};
