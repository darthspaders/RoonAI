"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function trackKey(track = {}) {
  return String(track.tidal?.tidalUrl || track.tidalUrl || `${track.artist || ""}|${track.title || ""}`)
    .toLowerCase()
    .trim();
}

class SessionStore {
  constructor(filePath = path.join(__dirname, "..", "data", "last-session.json")) {
    this.filePath = filePath;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return {
        updatedAt: null,
        options: {},
        result: null
      };
    }
  }

  save(options, result) {
    const session = {
      updatedAt: new Date().toISOString(),
      options: options || {},
      result: result || null
    };
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(session, null, 2));
    return session;
  }

  updateFeedback(track, rating) {
    const session = this.read();
    const key = trackKey(track);
    if (!key || !session.result?.tracks) return session;

    session.result.tracks = session.result.tracks.map((candidate) => (
      trackKey(candidate) === key ? { ...candidate, feedback: rating } : candidate
    ));
    session.updatedAt = new Date().toISOString();
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(session, null, 2));
    return session;
  }
}

module.exports = {
  SessionStore,
  trackKey
};
