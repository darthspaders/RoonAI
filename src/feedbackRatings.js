"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRatingKey(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, " ")
    .trim();
}

const RATING_ALIASES = new Map([
  ["love", "love"],
  ["like", "like"],
  ["good", "good"],
  ["up", "good"],
  ["ok", "ok"],
  ["okay", "ok"],
  ["dislike", "dislike"],
  ["wrong_genre", "wrong_genre"],
  ["wrong genre", "wrong_genre"],
  ["wrong", "wrong_genre"],
  ["not what i asked for", "wrong_genre"],
  ["not_asked", "wrong_genre"],
  ["reject_similar", "reject_similar"],
  ["reject similar", "reject_similar"],
  ["similar_bad", "reject_similar"],
  ["similar", "reject_similar"],
  ["skip", "skip"],
  ["down", "skip"],
  ["never", "never"],
  ["never again", "never"],
  ["never_again", "never"]
]);

// These are the current user-facing choices. Legacy values remain recognized
// below so historical feedback and older clients continue to work.
const USER_RATING_VALUES = Object.freeze(["love", "like", "ok", "dislike", "never"]);
const POSITIVE_RATINGS = new Set(["love", "like", "good"]);
const NEGATIVE_RATINGS = new Set(["dislike", "wrong_genre", "reject_similar", "skip", "never"]);

function normalizeRating(value, { fallback = "ok" } = {}) {
  return RATING_ALIASES.get(normalizeRatingKey(value)) || fallback;
}

function isPositiveRating(value) {
  return POSITIVE_RATINGS.has(normalizeRating(value, { fallback: "" }));
}

function isNegativeRating(value) {
  return NEGATIVE_RATINGS.has(normalizeRating(value, { fallback: "" }));
}

module.exports = {
  isNegativeRating,
  isPositiveRating,
  normalizeRating,
  normalizeRatingKey,
  NEGATIVE_RATINGS,
  POSITIVE_RATINGS,
  RATING_ALIASES,
  USER_RATING_VALUES
};
