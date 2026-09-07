"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeRating } = require("./feedbackRatings");
const {
  normalizedTrackKey,
  normalizeTrackIdentityText
} = require("./trackIdentity");

const DEFAULT_MAX_BYTES = 0;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return normalizeTrackIdentityText(value);
}

function splitArtists(value) {
  return cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
    .map(normalize)
    .filter((part) => part && part.length > 1);
}

function stripVersionText(value) {
  return cleanText(value)
    .replace(/\s*[\[(][^)\]]*\b(?:remix|mix|rework|rerub|dub|edit|version)\b[^)\]]*[\])]/gi, "")
    .trim();
}

function titleKeys(value) {
  return Array.from(new Set([
    normalize(value),
    normalize(stripVersionText(value))
  ].filter(Boolean)));
}

function trackKey(track = {}) {
  return normalizedTrackKey(track);
}

function normalizeMaxBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function feedbackScoreForRating(value = "") {
  const rating = normalizeRating(value, { fallback: "" });
  if (rating === "love") return 3;
  if (rating === "good") return 1;
  if (rating === "ok") return 0.5;
  if (rating === "skip") return -1;
  if (rating === "never") return -3;
  if (rating === "wrong_genre") return -1;
  return 0;
}

function trackMatches(left = {}, right = {}) {
  const leftTitles = titleKeys(left.title || left.tidal?.title);
  const rightTitles = titleKeys(right.title || right.tidal?.title);
  const titleMatch = leftTitles.some((leftTitle) => rightTitles.some((rightTitle) => (
    leftTitle === rightTitle || leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle)
  )));
  if (!titleMatch) return false;

  const leftArtists = splitArtists(left.artist || left.tidal?.artist);
  const rightArtists = splitArtists(right.artist || right.tidal?.artist);
  if (!leftArtists.length || !rightArtists.length) return false;
  return leftArtists.some((leftArtist) => rightArtists.some((rightArtist) => (
    leftArtist === rightArtist || leftArtist.includes(rightArtist) || rightArtist.includes(leftArtist)
  )));
}

function compactTrack(track = {}) {
  return {
    artist: cleanText(track.artist),
    title: cleanText(track.title),
    album: cleanText(track.album),
    label: cleanText(track.label || track.tidal?.label),
    year: track.year || null,
    releaseDate: track.releaseDate || track.tidal?.releaseDate || "",
    durationMs: track.durationMs || null,
    score: track.score || null,
    scoreBreakdown: track.scoreBreakdown || null,
    reason: cleanText(track.reason),
    why: Array.isArray(track.why) ? track.why.map(cleanText).filter(Boolean) : [],
    discoverySource: cleanText(track.discoverySource),
    discoveryLane: cleanText(track.discoveryLane),
    sourceType: cleanText(track.sourceType),
    isRadio: Boolean(track.isRadio),
    isLiveRadio: Boolean(track.isLiveRadio),
    playbackSource: track.playbackSource || null,
    tidal: track.tidal || null,
    roon: track.roon || null,
    statusChecks: Array.isArray(track.statusChecks) ? track.statusChecks.map(cleanText).filter(Boolean) : [],
    verificationSource: cleanText(track.verificationSource),
    tasteScore: Number.isFinite(Number(track.tasteScore)) ? Number(track.tasteScore) : null,
    feedback: cleanText(track.feedback)
  };
}

class TrackMemory {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "track-memory.json");
    this.maxBytes = normalizeMaxBytes(options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const entries = Array.isArray(json.entries) ? json.entries : [];
      this.entries = new Map(entries.map((entry) => [entry.key, entry]).filter(([key]) => key));
    } catch {
      this.entries = new Map();
    }
  }

  serialize(entries = [...this.entries.values()]) {
    return JSON.stringify({
      maxBytes: this.maxBytes,
      updatedAt: new Date().toISOString(),
      entries
    }, null, 2);
  }

  prune(entries = [...this.entries.values()]) {
    let pruned = entries
      .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0));
    if (!this.maxBytes) return pruned;
    while (pruned.length && Buffer.byteLength(this.serialize(pruned), "utf8") > this.maxBytes) {
      pruned = pruned.slice(0, -1);
    }
    return pruned;
  }

  save() {
    const entries = this.prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.serialize(entries));
    this.entries = new Map(entries.map((entry) => [entry.key, entry]));
  }

  record(tracks = [], now = Date.now(), options = {}) {
    const incrementSeen = options.incrementSeen !== false;
    for (const track of tracks || []) {
      const key = trackKey(track);
      if (!key || key === "|") continue;
      const previous = this.entries.get(key) || {};
      this.entries.set(key, {
        ...previous,
        ...compactTrack(track),
        key,
        firstSeenAt: previous.firstSeenAt || now,
        lastSeenAt: now,
        seenCount: Number(previous.seenCount || 0) + (incrementSeen ? 1 : 0),
        feedback: cleanText(track.feedback || previous.feedback)
      });
    }
    this.save();
    return this.summary();
  }

  updateFeedback(track = {}, rating = "") {
    const key = trackKey(track);
    if (!key || key === "|") return this.summary();
    const previous = this.entries.get(key) || compactTrack(track);
    const tasteScore = feedbackScoreForRating(rating);
    this.entries.set(key, {
      ...previous,
      ...compactTrack({ ...previous, ...track, tasteScore }),
      key,
      firstSeenAt: previous.firstSeenAt || Date.now(),
      lastSeenAt: Date.now(),
      seenCount: Number(previous.seenCount || 0),
      feedback: cleanText(rating)
    });
    this.save();
    return this.summary();
  }

  find(track = {}) {
    const key = trackKey(track);
    if (key && this.entries.has(key)) return this.entries.get(key);
    return [...this.entries.values()]
      .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0))
      .find((entry) => trackMatches(entry, track)) || null;
  }

  purge() {
    this.entries.clear();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.serialize([]));
    return this.summary();
  }

  summary() {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch {
      bytes = Buffer.byteLength(this.serialize(), "utf8");
    }
    return {
      count: this.entries.size,
      bytes,
      maxBytes: this.maxBytes,
      mb: Number((bytes / 1024 / 1024).toFixed(2)),
      maxMb: this.maxBytes ? Number((this.maxBytes / 1024 / 1024).toFixed(0)) : null,
      unlimited: !this.maxBytes
    };
  }
}

module.exports = {
  TrackMemory,
  trackKey
};
