const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LIMIT = 50;

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactTrack(track = {}) {
  return {
    artist: text(track.artist || track.tidal?.artist),
    title: text(track.title || track.tidal?.title),
    album: text(track.album || track.tidal?.album),
    tidalTrackId: text(track.tidalTrackId || track.tidal?.id || track.tidalId || track.id),
    isrc: text(track.isrc || track.tidal?.isrc),
    durationMs: Number(track.durationMs || track.tidal?.durationMs || 0) || 0,
    key: text(track.key)
  };
}

function compactResultRow(row = {}) {
  const track = compactTrack(row.track || {});
  return {
    index: Number.isFinite(Number(row.index)) ? Number(row.index) : null,
    track,
    action: text(row.action),
    reason: text(row.reason),
    failureType: text(row.failureType),
    resolutionMethod: text(row.resolutionMethod),
    match: row.match ? {
      title: text(row.match.title),
      artist: text(row.match.artist || row.match.subtitle),
      album: text(row.match.album)
    } : null,
    bridge: row.bridge ? {
      tidalTrackId: text(row.bridge.tidalTrackId),
      playlistId: text(row.bridge.playlistId),
      requiresManualRefresh: Boolean(row.bridge.requiresManualRefresh),
      syncSuccess: row.bridge.sync ? Boolean(row.bridge.sync.success) : null
    } : null,
    directFailure: row.directFailure ? {
      reason: text(row.directFailure.reason),
      failureType: text(row.directFailure.failureType),
      resolutionMethod: text(row.directFailure.resolutionMethod)
    } : null
  };
}

class QueueAttemptStore {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "queue-attempts.json");
    this.limit = Math.max(1, Number(options.limit || DEFAULT_LIMIT));
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        version: 1,
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : []
      };
    } catch {
      return { version: 1, attempts: [] };
    }
  }

  write(snapshot = { attempts: [] }) {
    const next = {
      version: 1,
      attempts: (Array.isArray(snapshot.attempts) ? snapshot.attempts : []).slice(-this.limit)
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(next, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
    return next;
  }

  record({ request = {}, result = {}, source = "" } = {}) {
    const snapshot = this.read();
    const requestedTracks = Array.isArray(request.tracks) ? request.tracks : [];
    const attempt = {
      at: new Date().toISOString(),
      source: text(source || request.source || request.caller || ""),
      zoneId: text(request.zoneId),
      mode: text(request.mode || "append"),
      matchPolicy: text(request.matchPolicy),
      allowBridge: request.allowBridge !== undefined ? Boolean(request.allowBridge) : null,
      requested: Number(result.requested || requestedTracks.length || 0) || 0,
      queuedCount: Number(result.queuedCount || 0) || 0,
      failedCount: Number(result.failedCount || 0) || 0,
      requestedTracks: requestedTracks.map(compactTrack),
      queued: (Array.isArray(result.queued) ? result.queued : []).map(compactResultRow),
      failed: (Array.isArray(result.failed) ? result.failed : []).map(compactResultRow),
      warning: text(result.warning)
    };
    return this.write({ attempts: [...snapshot.attempts, attempt] }).attempts.at(-1);
  }
}

module.exports = {
  QueueAttemptStore,
  compactTrack,
  compactResultRow
};
