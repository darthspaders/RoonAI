"use strict";

const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");

const INDEX_VERSION = 1;
const DEFAULT_MAX_RESULTS = 8;
const MAX_OPEN_BUCKET_STREAMS = 64;

function finishScan(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

async function finishScanAsync(steps) {
  while (true) {
    await yieldToEventLoop();
    const step = steps.next();
    if (step.done) return step.value;
  }
}

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

  forEachBucketRecord(bucket, visitor) {
    return finishScan(this.bucketRecordSteps(bucket, visitor));
  }

  *bucketRecordSteps(bucket, visitor) {
    const file = path.join(this.indexDir, "buckets", `${safeFilePart(bucket)}.jsonl`);
    if (!fs.existsSync(file)) return 0;

    const descriptor = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let count = 0;
    let stopped = false;
    const logger = this.logger;

    const consume = function* (text) {
      remainder += text;
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          count += 1;
          if (visitor(JSON.parse(line)) === false) {
            stopped = true;
            return;
          }
        } catch (error) {
          logger?.debug?.("MusicBrainz local index malformed bucket row", {
            bucket,
            error: error.message
          });
        }
        if (count % 128 === 0) yield;
      }
    };

    try {
      while (!stopped) {
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        yield* consume(decoder.write(buffer.subarray(0, bytesRead)));
        yield;
      }
      if (!stopped) yield* consume(decoder.end());
      if (!stopped && remainder.trim()) {
        try {
          count += 1;
          visitor(JSON.parse(remainder));
        } catch (error) {
          this.logger?.debug?.("MusicBrainz local index malformed bucket row", {
            bucket,
            error: error.message
          });
        }
      }
    } catch (error) {
      this.logger?.debug?.("MusicBrainz local index bucket read failed", { bucket, error: error.message });
    } finally {
      fs.closeSync(descriptor);
    }
    return count;
  }

  readBucket(bucket) {
    const rows = [];
    this.forEachBucketRecord(bucket, (recording) => {
      rows.push(recording);
    });
    return rows;
  }

  readIsrcRefs(isrc) {
    return finishScan(this.isrcRefSteps(isrc));
  }

  *isrcRefSteps(isrc) {
    const clean = cleanIsrc(isrc);
    if (!clean) return [];
    const jsonFile = path.join(this.indexDir, "isrc", `${bucketForIsrc(clean)}.json`);
    const legacyMap = this.readJson(jsonFile, null);
    if (legacyMap) return Array.isArray(legacyMap[clean]) ? legacyMap[clean] : [];

    const jsonlFile = path.join(this.indexDir, "isrc", `${bucketForIsrc(clean)}.jsonl`);
    if (!fs.existsSync(jsonlFile)) return [];
    const refs = [];
    const descriptor = fs.openSync(jsonlFile, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let count = 0;
    const logger = this.logger;
    const consume = function* (text) {
      remainder += text;
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (cleanIsrc(row.isrc) === clean) refs.push(row);
        } catch (error) {
          logger?.debug?.("MusicBrainz local index malformed ISRC row", { isrc: clean, error: error.message });
        }
        if (++count % 128 === 0) yield;
      }
    };
    try {
      while (true) {
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        yield* consume(decoder.write(buffer.subarray(0, bytesRead)));
        yield;
      }
      yield* consume(decoder.end());
      if (remainder.trim()) {
        try {
          const row = JSON.parse(remainder);
          if (cleanIsrc(row.isrc) === clean) refs.push(row);
        } catch (error) {
          this.logger?.debug?.("MusicBrainz local index malformed ISRC row", { isrc: clean, error: error.message });
        }
      }
    } catch (error) {
      this.logger?.debug?.("MusicBrainz local index ISRC read failed", { isrc: clean, error: error.message });
      return [];
    } finally {
      fs.closeSync(descriptor);
    }
    return refs;
  }

  searchByIsrc(isrc) {
    return finishScan(this.isrcSearchSteps(isrc));
  }

  *isrcSearchSteps(isrc) {
    const clean = cleanIsrc(isrc);
    if (!clean) return [];
    const refs = yield* this.isrcRefSteps(clean);
    const out = [];
    for (const ref of refs) {
      yield* this.bucketRecordSteps(ref.bucket, (row) => {
        if (row.id !== ref.id || row.title !== ref.title) return;
        out.push(row);
        return false;
      });
    }
    return out;
  }

  searchRecordings(track = {}) {
    return finishScan(this.recordingSearchSteps(track));
  }

  // Live enrichment must release the event loop while scanning large title
  // buckets. Offline imports/evaluators retain the same synchronous results.
  searchRecordingsAsync(track = {}) {
    return finishScanAsync(this.recordingSearchSteps(track));
  }

  *recordingSearchSteps(track = {}) {
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

    for (const recording of (yield* this.isrcSearchSteps(track.isrc))) add(recording);
    yield* this.bucketRecordSteps(bucketForTitle(track.title), add);

    return candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, this.maxResults)
      .map((entry) => entry.recording);
  }

  searchRecordingsBatch(tracks = []) {
    if (!this.isAvailable()) return tracks.map(() => []);
    const results = tracks.map(() => []);
    const grouped = new Map();
    tracks.forEach((track, index) => {
      const title = normalizeText(track?.title);
      if (!title) return;
      const bucket = bucketForTitle(track.title);
      const titles = grouped.get(bucket) || new Map();
      const indexes = titles.get(title) || [];
      indexes.push(index);
      titles.set(title, indexes);
      grouped.set(bucket, titles);
    });

    // Read each large JSONL title bucket once for the whole batch. The old
    // per-track path is intentionally retained for callers that need a single
    // lookup, while bulk enrichment avoids rereading 1+ GB buckets thousands of
    // times for a mixed library.
    for (const [bucket, titles] of grouped.entries()) {
      const candidates = new Map();
      this.forEachBucketRecord(bucket, (recording) => {
        const title = normalizeText(recording?.title);
        const indexes = titles.get(title);
        if (!indexes) return;
        for (const index of indexes) {
          const trackCandidates = candidates.get(index) || [];
          const score = scoreRecording(tracks[index], recording);
          if (score > 0) trackCandidates.push({ recording, score });
          candidates.set(index, trackCandidates);
        }
      });
      for (const [index, entries] of candidates.entries()) {
        results[index].push(...entries
          .sort((left, right) => right.score - left.score)
          .slice(0, this.maxResults)
          .map((entry) => entry.recording));
      }
    }

    // ISRC lookups are already indexed and usually touch only a tiny bucket.
    // Add them to the title results and deduplicate by recording id.
    tracks.forEach((track, index) => {
      if (results[index].length || !cleanIsrc(track?.isrc)) return;
      const isrcRows = this.searchByIsrc(track?.isrc);
      if (!isrcRows.length) return;
      const seen = new Set(results[index].map((row) => row?.id).filter(Boolean));
      for (const row of isrcRows) {
        if (!seen.has(row?.id)) results[index].push(row);
        if (row?.id) seen.add(row.id);
      }
      results[index] = results[index].slice(0, this.maxResults);
    });
    return results;
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
