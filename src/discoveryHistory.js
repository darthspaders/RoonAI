"use strict";

const fs = require("fs");
const path = require("path");
const {
  artistIdentityKey,
  artistIdentityKeysForTrack
} = require("./artistIdentity");
const {
  explicitTidalTrackId,
  tidalTrackIdFromUrl
} = require("./tidalIdentity");

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

function looksLikeGenreStyleDescriptor(value = "") {
  const raw = cleanText(value);
  const normalized = normalize(raw);
  if (!normalized) return false;
  const hasGenre = /\b(?:edm|electronic dance music|deep house|tech house|progressive house|melodic house|organic house|house|melodic techno|progressive techno|techno|progressive trance|psytrance|psy trance|trance|ambient|breaks|breakbeat|dubstep)\b/.test(normalized);
  const hasDescriptor = /\b(?:emotional|melodic|progressive|deep|organic|uplifting|dark|cinematic|driving|hypnotic|vocal|instrumental|club|dance|edm)\b/.test(normalized);
  const hasGenreSeparator = /[\/&|]/.test(raw) || /\b(?:and|x)\b/.test(normalized);
  return hasGenre && hasDescriptor && (hasGenreSeparator || /\bedm\b/.test(normalized));
}

function normalizeIdentityTitle(value = "") {
  const stripped = cleanText(value).replace(/\([^)]{8,160}\)|\[[^\]]{8,160}\]/g, (part) => (
    looksLikeGenreStyleDescriptor(part) ? " " : part
  ));
  return normalize(stripped);
}

function unique(values = []) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function historyKeysForTrack(track = {}) {
  const tidalUrl = cleanText(track.tidal?.tidalUrl || track.tidalUrl).toLowerCase();
  const tidalId = tidalTrackIdFromUrl(tidalUrl) || explicitTidalTrackId(track);
  const artist = normalize(track.artist || track.tidal?.artist);
  const title = normalize(track.title || track.tidal?.title);
  const identityTitle = normalizeIdentityTitle(track.title || track.tidal?.title);

  return unique([
    tidalId ? `tidal:${tidalId}` : "",
    tidalUrl,
    tidalUrl ? `url:${tidalUrl}` : "",
    artist && title ? `${artist}|${title}` : "",
    artist && identityTitle && identityTitle !== title ? `${artist}|${identityTitle}` : ""
  ]).filter((key) => key !== "|");
}

function trackKey(track = {}) {
  return historyKeysForTrack(track)[0] || "";
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
    this.maxEntries = Number(options.maxEntries ?? 0);
    this.recentWindowMs = Number(options.recentWindowMs || 1000 * 60 * 60 * 24 * 3);
    this.artistRecentWindowMs = Number(options.artistRecentWindowMs || 1000 * 60 * 60 * 24 * 14);
    this.labelRecentWindowMs = Number(options.labelRecentWindowMs || 1000 * 60 * 60 * 24 * 21);
    this.sourceRecentWindowMs = Number(options.sourceRecentWindowMs || 1000 * 60 * 60 * 24 * 21);
    this.entries = new Map();
    this.load();
  }

  load() {
    try {
      const json = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const entries = Array.isArray(json.entries) ? json.entries : [];
      this.entries = new Map();
      for (const entry of entries) {
        this.mapEntry({
          ...entry,
          keys: unique([entry.key, ...(Array.isArray(entry.keys) ? entry.keys : []), ...historyKeysForTrack(entry)])
        });
      }
    } catch {
      this.entries = new Map();
    }
  }

  mapEntry(entry = {}) {
    const key = cleanText(entry.key || "");
    const keys = unique([key, ...(Array.isArray(entry.keys) ? entry.keys : [])]);
    if (!key || !keys.length) return;
    const normalizedEntry = {
      ...entry,
      key,
      keys
    };
    for (const alias of keys) {
      this.entries.set(alias, normalizedEntry);
    }
  }

  uniqueEntries() {
    const byKey = new Map();
    for (const entry of this.entries.values()) {
      if (!entry?.key || byKey.has(entry.key)) continue;
      byKey.set(entry.key, entry);
    }
    return [...byKey.values()];
  }

  save() {
    let entries = this.uniqueEntries()
      .sort((left, right) => Number(right.lastShownAt || 0) - Number(left.lastShownAt || 0));
    if (Number.isFinite(this.maxEntries) && this.maxEntries > 0) {
      entries = entries.slice(0, this.maxEntries);
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      maxEntries: this.maxEntries || null,
      unlimited: !this.maxEntries,
      entries
    }, null, 2));
    this.entries = new Map();
    for (const entry of entries) this.mapEntry(entry);
  }

  isRecent(track, now = Date.now()) {
    const entry = this.entryFor(track);
    return Boolean(entry && now - Number(entry.lastShownAt || 0) < this.recentWindowMs);
  }

  entryFor(track) {
    for (const key of historyKeysForTrack(track)) {
      const entry = this.entries.get(key);
      if (entry) return entry;
    }
    return null;
  }

  fallbackCandidates({ limit = 80 } = {}) {
    return this.uniqueEntries()
      .sort((left, right) => Number(right.lastShownAt || 0) - Number(left.lastShownAt || 0))
      .slice(0, Math.max(1, Number(limit || 80)));
  }

  artistStats() {
    const stats = new Map();
    for (const entry of this.uniqueEntries()) {
      const artists = splitArtists(entry.artist);
      if (!artists.length) continue;
      for (const artist of artists) {
        const key = artistIdentityKey(artist);
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

  fieldStats(keyForEntry, labelForEntry) {
    const stats = new Map();
    for (const entry of this.uniqueEntries()) {
      const key = keyForEntry(entry);
      if (!key) continue;
      const previous = stats.get(key) || {
        key,
        name: labelForEntry(entry),
        trackCount: 0,
        shownCount: 0,
        lastShownAt: 0
      };
      previous.trackCount += 1;
      previous.shownCount += Math.max(1, Number(entry.shownCount || 1));
      previous.lastShownAt = Math.max(previous.lastShownAt, Number(entry.lastShownAt || 0));
      stats.set(key, previous);
    }
    return stats;
  }

  labelStats() {
    return this.fieldStats(
      (entry) => normalize(entry.label || entry.tidal?.label),
      (entry) => cleanText(entry.label || entry.tidal?.label)
    );
  }

  sourceStats() {
    return this.fieldStats(
      (entry) => normalize([entry.discoverySource, entry.discoveryLane].filter(Boolean).join(" | ")),
      (entry) => cleanText([entry.discoverySource, entry.discoveryLane].filter(Boolean).join(" / "))
    );
  }

  artistExposureFor(track = {}, now = Date.now()) {
    const artistKeys = artistIdentityKeysForTrack(track, splitArtists);
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

  labelExposureFor(track = {}, now = Date.now()) {
    const label = normalize(track.label || track.tidal?.label);
    if (!label) return null;
    const exposure = this.labelStats().get(label);
    if (!exposure) return null;
    return {
      ...exposure,
      label: exposure.name,
      recent: Boolean(exposure.lastShownAt && now - Number(exposure.lastShownAt || 0) < this.labelRecentWindowMs)
    };
  }

  sourceExposureFor(track = {}, now = Date.now()) {
    const sourceKey = normalize([track.discoverySource, track.discoveryLane].filter(Boolean).join(" | "));
    if (!sourceKey) return null;
    const exposure = this.sourceStats().get(sourceKey);
    if (!exposure) return null;
    return {
      ...exposure,
      source: exposure.name,
      recent: Boolean(exposure.lastShownAt && now - Number(exposure.lastShownAt || 0) < this.sourceRecentWindowMs)
    };
  }

  record(tracks, now = Date.now()) {
    for (const track of tracks || []) {
      const keys = historyKeysForTrack(track);
      const key = keys[0];
      if (!key || key === "|") continue;
      const prior = keys.map((candidateKey) => this.entries.get(candidateKey)).find(Boolean) || {};
      this.mapEntry({
        ...prior,
        key,
        keys: unique([...(Array.isArray(prior.keys) ? prior.keys : []), prior.key, ...keys]),
        artist: cleanText(track.artist) || prior.artist || "",
        title: cleanText(track.title) || prior.title || "",
        label: cleanText(track.label || track.tidal?.label) || prior.label || "",
        discoverySource: cleanText(track.discoverySource || track.tidal?.discoverySource) || prior.discoverySource || "",
        discoveryLane: cleanText(track.discoveryLane || track.discoveryQuotaBucket || track.tidal?.discoveryLane) || prior.discoveryLane || "",
        tidalUrl: cleanText(track.tidal?.tidalUrl || track.tidalUrl) || prior.tidalUrl || "",
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
