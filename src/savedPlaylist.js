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

class SavedPlaylist {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "saved-playlist.json");
    this.tracks = [];
    this.load();
  }

  load() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.tracks = Array.isArray(json.tracks) ? json.tracks : [];
    } catch {
      this.tracks = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ tracks: this.tracks }, null, 2));
  }

  list() {
    return this.tracks;
  }

  add(track = {}) {
    const key = trackKey(track);
    if (!key || key === "|") throw new Error("Cannot save a track without a title/artist or TIDAL URL.");
    const existing = this.tracks.find((candidate) => candidate.key === key);
    if (existing) return { added: false, track: existing, tracks: this.tracks };

    const saved = {
      key,
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      album: cleanText(track.album),
      year: track.year || null,
      releaseDate: track.releaseDate || track.tidal?.releaseDate || "",
      durationMs: track.durationMs || null,
      score: track.score || null,
      reason: cleanText(track.reason),
      tidal: track.tidal || null,
      savedAt: Date.now()
    };

    this.tracks.push(saved);
    this.save();
    return { added: true, track: saved, tracks: this.tracks };
  }

  remove(key) {
    const before = this.tracks.length;
    this.tracks = this.tracks.filter((track) => track.key !== key);
    if (this.tracks.length !== before) this.save();
    return { removed: this.tracks.length !== before, tracks: this.tracks };
  }
}

module.exports = {
  SavedPlaylist,
  trackKey
};
