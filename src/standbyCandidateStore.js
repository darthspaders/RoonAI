"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_TARGET_COUNT = 25;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function standbyTrackKey(track = {}) {
  const tidalId = cleanText(track.tidal?.id || track.tidalId || track.id || track.trackId);
  if (tidalId) return `tidal:${tidalId.toLowerCase()}`;
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl);
  if (tidalUrl) return `url:${tidalUrl.toLowerCase()}`;
  const artist = normalize(track.artist || track.tidal?.artist);
  const title = normalize(track.title || track.tidal?.title);
  return artist && title ? `${artist}|${title}` : "";
}

function scoreFor(track = {}) {
  const score = Number(track.score ?? track.scoreBreakdown?.total ?? 0);
  return Number.isFinite(score) ? score : 0;
}

function compactTrack(track = {}, previous = {}, context = {}, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const key = standbyTrackKey(track);
  const addedAt = Number(previous.standbyAddedAt || previous.addedAt || now);
  return {
    ...track,
    key,
    standbyAddedAt: addedAt,
    standbyUpdatedAt: now,
    standbyExpiresAt: now + ttlMs,
    standbyReason: cleanText(context.reason || previous.standbyReason || "background"),
    standbySource: cleanText(context.source || previous.standbySource || track.discoverySource || "Standby discovery"),
    standbyLane: cleanText(track.discoveryLane || previous.standbyLane || ""),
    _resultIndex: undefined
  };
}

function sortCandidates(left = {}, right = {}) {
  return scoreFor(right) - scoreFor(left) ||
    Number(right.standbyUpdatedAt || 0) - Number(left.standbyUpdatedAt || 0) ||
    cleanText(left.artist).localeCompare(cleanText(right.artist)) ||
    cleanText(left.title).localeCompare(cleanText(right.title));
}

class StandbyCandidateStore {
  constructor(options = {}) {
    this.file = options.file || path.join(__dirname, "..", "data", "standby-candidates.json");
    this.targetCount = Math.max(1, Number(options.targetCount || DEFAULT_TARGET_COUNT));
    this.ttlMs = Math.max(60_000, Number(options.ttlMs || DEFAULT_TTL_MS));
  }

  empty() {
    return {
      version: 1,
      enabled: true,
      targetCount: this.targetCount,
      ttlMs: this.ttlMs,
      updatedAt: "",
      refreshing: false,
      refreshStartedAt: "",
      lastRefreshAt: "",
      nextRefreshAt: "",
      lastError: "",
      lastRun: null,
      candidates: []
    };
  }

  read() {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...this.empty(),
        ...snapshot,
        targetCount: this.targetCount,
        ttlMs: this.ttlMs,
        candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates : []
      };
    } catch {
      return this.empty();
    }
  }

  write(snapshot = this.empty()) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const next = {
      ...this.empty(),
      ...snapshot,
      targetCount: this.targetCount,
      ttlMs: this.ttlMs,
      candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates : [],
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  activeCandidates(snapshot = this.read(), now = Date.now()) {
    return (snapshot.candidates || [])
      .filter((track) => standbyTrackKey(track) && Number(track.standbyExpiresAt || 0) > now)
      .sort(sortCandidates);
  }

  list(options = {}) {
    const limit = Math.max(1, Number(options.limit || this.targetCount));
    return this.activeCandidates().slice(0, limit);
  }

  readyCount() {
    return this.list({ limit: this.targetCount }).length;
  }

  refreshDue(intervalMs = 20 * 60 * 1000, now = Date.now()) {
    const snapshot = this.read();
    if (snapshot.refreshing) return false;
    if (this.readyCount() < this.targetCount) return true;
    return false;
  }

  add(tracks = [], context = {}) {
    const snapshot = this.read();
    const now = Date.now();
    const active = this.activeCandidates(snapshot, now);
    const byKey = new Map(active.map((track) => [standbyTrackKey(track), track]).filter(([key]) => key));

    for (const track of tracks || []) {
      const key = standbyTrackKey(track);
      if (!key) continue;
      byKey.set(key, compactTrack(track, byKey.get(key), context, now, this.ttlMs));
    }

    const candidates = [...byKey.values()].sort(sortCandidates).slice(0, this.targetCount);
    const next = this.write({
      ...snapshot,
      candidates
    });
    return {
      addedCount: candidates.length,
      targetCount: this.targetCount,
      tracks: candidates,
      summary: this.summary(next)
    };
  }

  remove(keys = []) {
    const keySet = new Set((keys || []).map(cleanText).filter(Boolean));
    const snapshot = this.read();
    const candidates = this.activeCandidates(snapshot)
      .filter((track) => !keySet.has(track.key || standbyTrackKey(track)) && !keySet.has(standbyTrackKey(track)));
    return this.summary(this.write({ ...snapshot, candidates }));
  }

  clear() {
    return this.summary(this.write({
      ...this.read(),
      candidates: [],
      lastError: "",
      lastRun: null
    }));
  }

  markRefreshStart(context = {}) {
    const startedAt = new Date().toISOString();
    return this.summary(this.write({
      ...this.read(),
      refreshing: true,
      refreshStartedAt: startedAt,
      lastError: "",
      lastRun: {
        reason: cleanText(context.reason || "background"),
        startedAt
      }
    }));
  }

  markRefreshEnd(result = {}) {
    const snapshot = this.read();
    const endedAt = new Date().toISOString();
    return this.summary(this.write({
      ...snapshot,
      refreshing: false,
      refreshStartedAt: "",
      lastRefreshAt: result.error ? snapshot.lastRefreshAt : endedAt,
      nextRefreshAt: result.nextRefreshAt || snapshot.nextRefreshAt || "",
      lastError: cleanText(result.error || ""),
      lastRun: {
        ...(snapshot.lastRun || {}),
        reason: cleanText(result.reason || snapshot.lastRun?.reason || "background"),
        endedAt,
        runtimeMs: Number(result.runtimeMs || 0),
        generated: Number(result.generated || 0),
        kept: Number(result.kept || 0),
        discarded: Number(result.discarded || 0),
        error: cleanText(result.error || "")
      }
    }));
  }

  summary(snapshot = this.read()) {
    const tracks = this.activeCandidates(snapshot).slice(0, this.targetCount);
    return {
      enabled: snapshot.enabled !== false,
      targetCount: this.targetCount,
      ttlMs: this.ttlMs,
      count: tracks.length,
      ready: tracks.length >= this.targetCount,
      refreshing: Boolean(snapshot.refreshing),
      refreshStartedAt: snapshot.refreshStartedAt || "",
      updatedAt: snapshot.updatedAt || "",
      lastRefreshAt: snapshot.lastRefreshAt || "",
      nextRefreshAt: tracks.length >= this.targetCount ? "" : snapshot.nextRefreshAt || "",
      lastError: snapshot.lastError || "",
      lastRun: snapshot.lastRun || null,
      tracks
    };
  }
}

module.exports = {
  StandbyCandidateStore,
  standbyTrackKey
};
