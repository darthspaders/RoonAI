"use strict";

const fs = require("fs");
const path = require("path");

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

function trackKey(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl);
  if (tidalUrl) return tidalUrl.toLowerCase();
  return `${normalize(track.artist)}|${normalize(track.title)}`;
}

function splitArtists(value) {
  return cleanText(value)
    .replace(/[â€â€‘â€’â€“â€”âˆ’]/g, "-")
    .split(/\s*(?:,|;|\/|&|\+|\band\b)\s*/i)
    .map(cleanText)
    .filter((part) => part && part.length <= 60);
}

class DiscoveryHistory {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "discovery-history.json");
    this.maxEntries = Number(options.maxEntries || 800);
    this.recentWindowMs = Number(options.recentWindowMs || 1000 * 60 * 60 * 24 * 3);
    this.artistRecentWindowMs = Number(options.artistRecentWindowMs || 1000 * 60 * 60 * 24 * 14);
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

  save() {
    const entries = [...this.entries.values()]
      .sort((left, right) => Number(right.lastShownAt || 0) - Number(left.lastShownAt || 0))
      .slice(0, this.maxEntries);

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ entries }, null, 2));
    this.entries = new Map(entries.map((entry) => [entry.key, entry]));
  }

  isRecent(track, now = Date.now()) {
    const entry = this.entries.get(trackKey(track));
    return Boolean(entry && now - Number(entry.lastShownAt || 0) < this.recentWindowMs);
  }

  entryFor(track) {
    return this.entries.get(trackKey(track)) || null;
  }

  fallbackCandidates({ limit = 80 } = {}) {
    return [...this.entries.values()]
      .sort((left, right) => Number(right.lastShownAt || 0) - Number(left.lastShownAt || 0))
      .slice(0, Math.max(1, Number(limit || 80)));
  }

  artistStats() {
    const stats = new Map();
    for (const entry of this.entries.values()) {
      const artists = splitArtists(entry.artist);
      if (!artists.length) continue;
      for (const artist of artists) {
        const key = normalize(artist);
        if (!key) continue;
        const previous = stats.get(key) || {
          artist,
          trackCount: 0,
          shownCount: 0,
          lastShownAt: 0
        };
        previous.trackCount += 1;
        previous.shownCount += Math.max(1, Number(entry.shownCount || 1));
        previous.lastShownAt = Math.max(previous.lastShownAt, Number(entry.lastShownAt || 0));
        stats.set(key, previous);
      }
    }
    return stats;
  }

  artistExposureFor(track = {}, now = Date.now()) {
    const artistKeys = splitArtists(track.artist).map(normalize).filter(Boolean);
    if (!artistKeys.length) return null;

    const stats = this.artistStats();
    const exposures = artistKeys.map((key) => stats.get(key)).filter(Boolean);
    if (!exposures.length) return null;

    const exposure = exposures
      .sort((left, right) => (
        Number(right.shownCount || 0) - Number(left.shownCount || 0) ||
        Number(right.trackCount || 0) - Number(left.trackCount || 0) ||
        Number(right.lastShownAt || 0) - Number(left.lastShownAt || 0)
      ))[0];

    return {
      ...exposure,
      recent: Boolean(exposure.lastShownAt && now - Number(exposure.lastShownAt || 0) < this.artistRecentWindowMs)
    };
  }

  record(tracks, now = Date.now()) {
    for (const track of tracks || []) {
      const key = trackKey(track);
      if (!key || key === "|") continue;
      const prior = this.entries.get(key) || {};
      this.entries.set(key, {
        key,
        artist: cleanText(track.artist),
        title: cleanText(track.title),
        tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl),
        firstShownAt: prior.firstShownAt || now,
        lastShownAt: now,
        shownCount: Number(prior.shownCount || 0) + 1
      });
    }
    this.save();
  }
}

module.exports = {
  DiscoveryHistory,
  trackKey
};
