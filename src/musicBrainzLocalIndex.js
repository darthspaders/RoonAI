"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_VERSION = 1;
const DEFAULT_MAX_RESULTS = 8;
const MAX_OPEN_BUCKET_STREAMS = 64;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanIsrc(value) {
  return cleanText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function safeFilePart(value) {
  return cleanText(value).replace(/[^a-z0-9_-]/gi, "_") || "__";
}

function bucketForTitle(title) {
  const normalized = normalizeText(title).replace(/[^a-z0-9]/g, "");
  return safeFilePart((normalized || "__").slice(0, 2).padEnd(2, "_"));
}

function bucketForIsrc(isrc) {
  return safeFilePart(cleanIsrc(isrc).slice(0, 2).padEnd(2, "_"));
}

function splitArtists(value) {
  return cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with|vs\.?|versus)\s+|[,/&+|]+/i)
    .map(normalizeText)
    .filter((part) => part && part.length > 1);
}

function artistCreditText(credits = []) {
  return (Array.isArray(credits) ? credits : [])
    .map((credit) => cleanText(credit?.artist?.name || credit?.name))
    .filter(Boolean)
    .join(", ");
}

function normalizeArtistCredit(value) {
  if (Array.isArray(value)) {
    return value
      .map((credit) => {
        const name = cleanText(credit?.artist?.name || credit?.name || credit);
        if (!name) return null;
        return {
          name,
          artist: {
            id: cleanText(credit?.artist?.id),
            name
          }
        };
      })
      .filter(Boolean);
  }
  const name = cleanText(value);
  return name ? [{ name, artist: { id: "", name } }] : [];
}

function normalizeTagList(...values) {
  const seen = new Set();
  const out = [];
  for (const value of values.flat(Infinity)) {
    const name = cleanText(value?.name || value?.title || value?.value || value);
    const key = normalizeText(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name });
  }
  return out;
}

function normalizeRelease(release = {}) {
  const labels = Array.isArray(release["label-info"]) ? release["label-info"] : [];
  return {
    id: cleanText(release.id),
    title: cleanText(release.title),
    date: cleanText(release.date || release["first-release-date"]),
    "release-group": release["release-group"] ? {
      id: cleanText(release["release-group"].id),
      title: cleanText(release["release-group"].title || release.title)
    } : undefined,
    "label-info": labels.map((entry) => ({
      label: {
        id: cleanText(entry?.label?.id),
        name: cleanText(entry?.label?.name)
      }
    })).filter((entry) => entry.label.name || entry.label.id),
    genres: normalizeTagList(release.genres),
    tags: normalizeTagList(release.tags)
  };
}

function compactRecording(entry = {}) {
  const title = cleanText(entry.title);
  if (!title) return null;
  const artistCredit = normalizeArtistCredit(entry["artist-credit"] || entry.artist || entry.artistCredit);
  const releases = (Array.isArray(entry.releases) ? entry.releases : [])
    .map(normalizeRelease)
    .filter((release) => release.title || release.id);
  const isrcs = Array.from(new Set((Array.isArray(entry.isrcs) ? entry.isrcs : [entry.isrc])
    .map(cleanIsrc)
    .filter(Boolean)));
  return {
    id: cleanText(entry.id),
    title,
    length: Number(entry.length || entry.durationMs || 0) || undefined,
    isrcs,
    "artist-credit": artistCredit,
    releases,
    genres: normalizeTagList(entry.genres),
    tags: normalizeTagList(entry.tags)
  };
}

function recordingsFromRelease(release = {}) {
  const releaseShell = normalizeRelease(release);
  const releaseArtistCredit = release["artist-credit"] || release.artist || release.artistCredit || [];
  const out = [];
  for (const medium of Array.isArray(release.media) ? release.media : []) {
    for (const track of Array.isArray(medium.tracks) ? medium.tracks : []) {
      const recording = track.recording || {};
      const compact = compactRecording({
        ...recording,
        title: recording.title || track.title,
        length: recording.length || track.length,
        isrcs: recording.isrcs || track.isrcs,
        "artist-credit": recording["artist-credit"] || track["artist-credit"] || releaseArtistCredit,
        releases: [releaseShell],
        genres: [
          ...(Array.isArray(recording.genres) ? recording.genres : []),
          ...(Array.isArray(track.genres) ? track.genres : [])
        ],
        tags: [
          ...(Array.isArray(recording.tags) ? recording.tags : []),
          ...(Array.isArray(track.tags) ? track.tags : [])
        ]
      });
      if (compact) out.push(compact);
    }
  }
  return out;
}

function scoreRecording(track = {}, recording = {}) {
  const wantedTitle = normalizeText(track.title);
  const wantedArtists = splitArtists(track.artist);
  const wantedIsrc = cleanIsrc(track.isrc);
  const title = normalizeText(recording.title);
  const artists = splitArtists(artistCreditText(recording["artist-credit"]));
  const isrcs = (Array.isArray(recording.isrcs) ? recording.isrcs : []).map(cleanIsrc).filter(Boolean);

  let score = 0;
  if (wantedIsrc && isrcs.includes(wantedIsrc)) score += 1000;
  if (wantedTitle && title === wantedTitle) score += 300;
  else if (wantedTitle && title && (title.includes(wantedTitle) || wantedTitle.includes(title))) score += 120;
  if (wantedArtists.length && artists.some((actual) => wantedArtists.some((wanted) => actual === wanted))) score += 180;
  else if (!wantedArtists.length) score += 25;
  return score;
}

class MusicBrainzLocalIndex {
  constructor({
    enabled = false,
    indexDir = path.join(__dirname, "..", "data", "musicbrainz-index"),
    maxResults = DEFAULT_MAX_RESULTS,
    logger = console
  } = {}) {
    this.enabled = !!enabled;
    this.indexDir = indexDir;
    this.maxResults = Number(maxResults) || DEFAULT_MAX_RESULTS;
    this.logger = logger;
    this.manifest = this.readManifest();
  }

  manifestPath() {
    return path.join(this.indexDir, "manifest.json");
  }

  readManifest() {
    try {
      const file = this.manifestPath();
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      this.logger?.warn?.("MusicBrainz local index manifest could not be read", { error: error.message });
      return null;
    }
  }

  isAvailable() {
    return this.enabled && !!this.manifest && Number(this.manifest.version) === INDEX_VERSION;
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.isAvailable(),
      indexDir: this.indexDir,
      version: this.manifest?.version || null,
      entryCount: Number(this.manifest?.entryCount || 0),
      updatedAt: this.manifest?.updatedAt || ""
    };
  }

  readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      this.logger?.debug?.("MusicBrainz local index JSON read failed", { file, error: error.message });
      return fallback;
    }
  }

  readBucket(bucket) {
    const file = path.join(this.indexDir, "buckets", `${safeFilePart(bucket)}.jsonl`);
    if (!fs.existsSync(file)) return [];
    try {
      return fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      this.logger?.debug?.("MusicBrainz local index bucket read failed", { bucket, error: error.message });
      return [];
    }
  }

  readIsrcRefs(isrc) {
    const clean = cleanIsrc(isrc);
    if (!clean) return [];
    const jsonFile = path.join(this.indexDir, "isrc", `${bucketForIsrc(clean)}.json`);
    const legacyMap = this.readJson(jsonFile, null);
    if (legacyMap) return Array.isArray(legacyMap[clean]) ? legacyMap[clean] : [];

    const jsonlFile = path.join(this.indexDir, "isrc", `${bucketForIsrc(clean)}.jsonl`);
    if (!fs.existsSync(jsonlFile)) return [];
    const refs = [];
    try {
      for (const line of fs.readFileSync(jsonlFile, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (cleanIsrc(row.isrc) === clean) refs.push(row);
      }
    } catch (error) {
      this.logger?.debug?.("MusicBrainz local index ISRC read failed", { isrc: clean, error: error.message });
      return [];
    }
    return refs;
  }

  searchByIsrc(isrc) {
    const clean = cleanIsrc(isrc);
    if (!clean) return [];
    const refs = this.readIsrcRefs(clean);
    const out = [];
    for (const ref of refs) {
      const bucketRows = this.readBucket(ref.bucket);
      const match = bucketRows.find((row) => row.id === ref.id && row.title === ref.title);
      if (match) out.push(match);
    }
    return out;
  }

  searchRecordings(track = {}) {
    if (!this.isAvailable()) return [];
    const seen = new Set();
    const candidates = [];
    const add = (recording) => {
      if (!recording?.title) return;
      const key = `${recording.id || ""}|${normalizeText(artistCreditText(recording["artist-credit"]))}|${normalizeText(recording.title)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const score = scoreRecording(track, recording);
      if (score > 0) candidates.push({ recording, score });
    };

    for (const recording of this.searchByIsrc(track.isrc)) add(recording);
    for (const recording of this.readBucket(bucketForTitle(track.title))) add(recording);

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, this.maxResults)
      .map((entry) => entry.recording);
  }
}

module.exports = {
  INDEX_VERSION,
  MusicBrainzLocalIndex,
  bucketForTitle,
  bucketForIsrc,
  cleanIsrc,
  cleanText,
  compactRecording,
  normalizeText,
  recordingsFromRelease,
  scoreRecording
};
