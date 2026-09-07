"use strict";

const fs = require("fs");
const path = require("path");
const {
  isNegativeRating,
  isPositiveRating,
  normalizeRating
} = require("./feedbackRatings");

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

const PARENT_GENRE_TERMS = [
  "house",
  "techno",
  "trance",
  "ambient",
  "breaks",
  "breakbeat",
  "drum and bass",
  "dnb",
  "bass",
  "garage",
  "disco",
  "electro",
  "psytrance"
];

function parentGenreTermsFor(value = "") {
  const text = normalize(value);
  return PARENT_GENRE_TERMS.filter((term) => {
    const key = normalize(term);
    return text === key || text.includes(key);
  });
}

function explicitGenreKey(options = {}) {
  const raw = cleanText(options.genres || "");
  if (!raw) return "";
  const first = normalize(raw.split(/[,;|]/)[0]);
  if (!first || first.split(/\s+/).length > 5) return "";
  return parentGenreTermsFor(first).length ? first : "";
}

function splitArtists(value = "") {
  return cleanText(value)
    .split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i)
    .map(cleanText)
    .filter((part) => part && part.length <= 60);
}

function trackKey(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl);
  if (tidalUrl) return tidalUrl.toLowerCase();
  return `${normalize(track.artist)}|${normalize(track.title)}`;
}

function labelFor(track = {}) {
  return cleanText(track.label || track.tidal?.label || "");
}

function bump(map = {}, name = "", amount = 1) {
  const text = cleanText(name);
  const key = normalize(text);
  if (!key) return map;
  const entry = map[key] || { name: text, count: 0 };
  entry.name = entry.name || text;
  entry.count = Number(entry.count || 0) + amount;
  if (entry.count <= 0) {
    delete map[key];
    return map;
  }
  map[key] = entry;
  return map;
}

function applyFeedback(profile = {}, detail = {}, direction = 1) {
  const positive = ["love", "good"].includes(detail.rating);
  const negative = ["wrong_genre", "reject_similar", "skip", "never"].includes(detail.rating);
  if (positive) {
    profile.positiveCount = Math.max(0, Number(profile.positiveCount || 0) + direction);
    for (const artist of splitArtists(detail.artist)) bump(profile.artists, artist, direction);
    bump(profile.labels, detail.label, direction);
  } else if (negative) {
    profile.negativeCount = Math.max(0, Number(profile.negativeCount || 0) + direction);
    for (const artist of splitArtists(detail.artist)) bump(profile.excludeArtists, artist, direction);
    bump(profile.excludeLabels, detail.label, direction);
  }
}

function topNames(map = {}, limit = 24) {
  return Object.values(map || {})
    .filter((entry) => Number(entry.count || 0) > 0)
    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0) || String(left.name).localeCompare(String(right.name)))
    .slice(0, limit)
    .map((entry) => entry.name)
    .filter(Boolean);
}

class GenreProfileStore {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "genre-profiles.json");
    this.profiles = {};
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.profiles = parsed.profiles || {};
    } catch {
      this.profiles = {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      updatedAt: new Date().toISOString(),
      profiles: this.profiles
    }, null, 2));
  }

  compact(profile = {}) {
    return {
      key: profile.key,
      name: profile.name,
      parentGenres: profile.parentGenres || [],
      keywords: profile.keywords || [],
      artists: topNames(profile.artists, 24),
      labels: topNames(profile.labels, 24),
      excludeArtists: topNames(profile.excludeArtists, 24),
      excludeLabels: topNames(profile.excludeLabels, 24),
      positiveCount: Number(profile.positiveCount || 0),
      negativeCount: Number(profile.negativeCount || 0),
      feedbackCount: Object.keys(profile.feedback || {}).length
    };
  }

  augmentOptions(options = {}) {
    const key = explicitGenreKey(options);
    if (!key || !this.profiles[key]) return options;
    return {
      ...options,
      learnedGenreProfiles: {
        ...(options.learnedGenreProfiles || {}),
        [key]: this.compact(this.profiles[key])
      }
    };
  }

  recordFeedback(options = {}, track = {}, ratingValue = "") {
    const key = explicitGenreKey(options);
    if (!key) return this.summary();
    const rating = normalizeRating(ratingValue, { fallback: "" });
    const positive = isPositiveRating(rating);
    const negative = isNegativeRating(rating);
    if (!positive && !negative) return this.summary();

    const profile = this.profiles[key] || {
      key,
      name: key,
      parentGenres: parentGenreTermsFor(key),
      keywords: key.split(/\s+/).filter((token) => !parentGenreTermsFor(key).some((parent) => normalize(parent).split(/\s+/).includes(token))),
      artists: {},
      labels: {},
      excludeArtists: {},
      excludeLabels: {},
      feedback: {},
      positiveCount: 0,
      negativeCount: 0
    };

    profile.artists ||= {};
    profile.labels ||= {};
    profile.excludeArtists ||= {};
    profile.excludeLabels ||= {};
    profile.feedback ||= {};

    const feedbackKey = trackKey(track);
    if (feedbackKey && profile.feedback[feedbackKey]) {
      applyFeedback(profile, profile.feedback[feedbackKey], -1);
    }

    const detail = {
      rating,
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      label: labelFor(track),
      tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl),
      updatedAt: new Date().toISOString()
    };
    applyFeedback(profile, detail, 1);
    if (feedbackKey) profile.feedback[feedbackKey] = detail;

    profile.updatedAt = new Date().toISOString();
    this.profiles[key] = profile;
    this.save();
    return this.summary();
  }

  summary() {
    return {
      count: Object.keys(this.profiles).length,
      profiles: Object.values(this.profiles).map((profile) => this.compact(profile))
    };
  }
}

module.exports = {
  GenreProfileStore
};
