"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { confidenceForMatch, metadataCacheKey } = require("./metadataEnrichmentService");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const execFileAsync = promisify(execFile);
const LOCAL_LIBRARY_SCHEMA_VERSION = 1;
const DEFAULT_FFPROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_CONFIDENCE = 85;
const UNSAFE_BEATPORT_VERSION_PATTERN = /\b(?:remix|rework|reimagined|bootleg|flip|vip|live|acoustic|instrumental|dub\s+mix|re-edit|edit)\b/i;
const AUDIO_EXTENSIONS = new Set([
  ".aac", ".aiff", ".ape", ".dsf", ".dff", ".flac", ".m4a", ".mka", ".mp2", ".mp3",
  ".ogg", ".oga", ".opus", ".wav", ".wv"
]);

const SOURCE_PRIORITIES = {
  embedded: 100,
  "rabbit-hole-memory": 90,
  "rabbit-hole-cache": 89,
  beatport: 80,
  musicbrainz: 70,
  acoustid: 60,
  discogs: 50,
  tidal: 40,
  roon: 40
};

const COMPLETENESS_GROUPS = [
  { name: "identity", weight: 40, fields: ["artist", "title", "album", "durationMs"] },
  { name: "classification", weight: 25, fields: ["genre", "subgenre", "year"] },
  { name: "electronic", weight: 25, fields: ["label", "bpm", "keyName", "camelot"] },
  { name: "external", weight: 10, fields: ["isrc", "tidalId", "beatportId", "musicBrainzId", "discogsId"] }
];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

function normalizeArtistName(value) {
  return normalizeText(cleanText(value).replace(/\s*\([^)]*\)\s*$/g, " "));
}

function splitArtistCredits(value) {
  return Array.from(new Set(cleanText(value)
    .split(/\s+(?:and|feat\.?|featuring|with|vs\.?|versus)\s+|[,/&+|]+/i)
    .map(normalizeArtistName)
    .filter((part) => part && part.length > 1)))
    .sort();
}

function sameArtistCreditSet(localTrack = {}, candidate = {}) {
  const localArtists = splitArtistCredits(localTrack.artist);
  const candidateArtistText = candidate.artist || (Array.isArray(candidate.artists)
    ? candidate.artists.map((artist) => artist?.name || artist?.attributes?.name || artist).filter(Boolean).join(", ")
    : "");
  const candidateArtists = splitArtistCredits(candidateArtistText);
  return localArtists.length > 0
    && localArtists.length === candidateArtists.length
    && localArtists.every((artist, index) => artist === candidateArtists[index]);
}

function beatportTitleVersionMatch(localTrack = {}, candidate = {}) {
  if (cleanText(candidate.source).toLowerCase() !== "beatport") return null;
  const localTitle = normalizeText(localTrack.title);
  const candidateTitle = normalizeText(candidate.title);
  const candidateMix = normalizeText(candidate.mixName);
  if (!localTitle || !candidateTitle || !candidateMix || !localTitle.includes(candidateMix)) return null;
  const localBaseTitle = normalizeText(localTitle.replace(candidateMix, " "));
  if (localBaseTitle !== candidateTitle) return null;
  return {
    confidence: 99,
    reason: "exact artist, title and local version descriptor"
  };
}

function strictConfidenceForMatch(localTrack = {}, candidate = {}) {
  const trackIsrc = cleanIsrc(localTrack.isrc);
  const candidateIsrc = cleanIsrc(candidate.isrc);
  if (trackIsrc && candidateIsrc && trackIsrc === candidateIsrc) {
    return { confidence: 100, reason: "ISRC match" };
  }
  if (!sameArtistCreditSet(localTrack, candidate)) {
    return { confidence: 0, reason: "artist credit mismatch" };
  }
  const versionMatch = beatportTitleVersionMatch(localTrack, candidate);
  if (versionMatch) return versionMatch;
  return confidenceForMatch(localTrack, candidate);
}

function beatportVersionSafety(localTrack = {}, candidate = {}) {
  const titleSuffix = cleanText(candidate.title).match(/(?:\(([^)]*)\)|\[([^\]]*)\])\s*$/);
  const titleVersion = titleSuffix ? (titleSuffix[1] || titleSuffix[2] || "") : "";
  const candidateVersionText = cleanText([candidate.mixName, titleVersion].filter(Boolean).join(" "));
  if (!UNSAFE_BEATPORT_VERSION_PATTERN.test(candidateVersionText)) return { safe: true };

  const localIsrc = cleanIsrc(localTrack.isrc);
  const candidateIsrc = cleanIsrc(candidate.isrc);
  if (localIsrc && candidateIsrc && localIsrc === candidateIsrc) {
    return { safe: true, reason: "exact ISRC despite version descriptor" };
  }

  const candidateMix = normalizeText(candidate.mixName || titleVersion);
  const localTitle = normalizeText(localTrack.title);
  if (candidateMix && localTitle.includes(candidateMix)) {
    return { safe: true, reason: "local title carries the same version descriptor" };
  }

  return {
    safe: false,
    reason: "Beatport candidate uses an unsafe remix/edit/live version without exact local version evidence"
  };
}

function cleanIsrc(value) {
  return cleanText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function jsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function jsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function durationMsFromCandidate(candidate = {}) {
  for (const key of ["durationMs", "duration_ms", "lengthMs", "length_ms"]) {
    const value = Number(candidate?.[key]);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  for (const key of ["duration", "length"]) {
    const value = Number(candidate?.[key]);
    if (Number.isFinite(value) && value > 0) return Math.round(value < 10_000 ? value * 1000 : value);
  }
  return null;
}

function isMeaningful(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  const text = cleanText(value);
  return Boolean(text) && !["[]", "{}", "null", "undefined"].includes(text.toLowerCase());
}

function positiveNumber(value) {
  const number = Number(String(value ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function firstText(...values) {
  for (const value of values.flat()) {
    if (isMeaningful(value)) return cleanText(value);
  }
  return "";
}

function firstYear(...values) {
  for (const value of values.flat()) {
    const match = cleanText(value).match(/\b((?:19|20)\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseNumberedTag(value) {
  const match = cleanText(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function normalizedTagMap(...sources) {
  const tags = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      const normalizedKey = normalizeText(key).replace(/ /g, "_");
      if (!normalizedKey || !isMeaningful(value) || tags[normalizedKey]) continue;
      tags[normalizedKey] = typeof value === "string" ? cleanText(value) : value;
    }
  }
  return tags;
}

function tagValue(tags, aliases) {
  for (const alias of aliases) {
    const value = tags[normalizeText(alias).replace(/ /g, "_")];
    if (isMeaningful(value)) return value;
  }
  return "";
}

function compactTags(tags = {}) {
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => {
    const text = cleanText(value);
    return [key, text.length > 4000 ? `${text.slice(0, 4000)}…` : text];
  }));
}

function trackFromFfprobe(filePath, probe = {}) {
  const format = probe.format || {};
  const audio = (Array.isArray(probe.streams) ? probe.streams : [])
    .find((stream) => stream?.codec_type === "audio") || {};
  // Format-level tags are the container's primary tags. Stream tags fill holes.
  const tags = normalizedTagMap(format.tags, audio.tags);
  const durationMs = positiveNumber(format.duration || audio.duration)
    ? Math.round(Number(format.duration || audio.duration) * 1000)
    : null;
  const releaseDate = firstText(
    tagValue(tags, ["date", "year", "original date", "original release date", "release date"])
  );
  const artist = firstText(tagValue(tags, ["artist", "artist name", "performer"]));
  const title = firstText(tagValue(tags, ["title", "track title"]));
  const album = firstText(tagValue(tags, ["album", "release", "release title"]));
  const albumArtist = firstText(tagValue(tags, ["album artist", "albumartist", "album performer"]));
  const isrc = cleanIsrc(tagValue(tags, ["isrc", "isrcid"]));
  return {
    filePath: path.resolve(filePath),
    artist,
    title,
    album,
    albumArtist,
    trackNumber: parseNumberedTag(tagValue(tags, ["track", "track number", "tracknumber"])),
    discNumber: parseNumberedTag(tagValue(tags, ["disc", "disc number", "discnumber", "disk"])),
    releaseDate,
    year: firstYear(releaseDate),
    genre: firstText(tagValue(tags, ["genre", "genres"])),
    subgenre: firstText(tagValue(tags, ["subgenre", "sub genre", "style"])),
    label: firstText(tagValue(tags, ["label", "record label", "organization", "publisher"])),
    bpm: positiveNumber(tagValue(tags, ["bpm", "tempo"])),
    keyName: firstText(tagValue(tags, ["key", "initial key", "initialkey"])),
    camelot: firstText(tagValue(tags, ["camelot", "camelot key"])),
    isrc,
    catalogNumber: firstText(tagValue(tags, ["catalog number", "catalog_number", "catalognumber", "catalog"])),
    durationMs,
    fileFormat: firstText(format.format_name, path.extname(filePath).slice(1).toLowerCase()),
    sampleRate: positiveNumber(audio.sample_rate),
    bitDepth: positiveNumber(audio.bits_per_raw_sample || audio.bits_per_sample),
    channels: positiveNumber(audio.channels),
    rawTags: compactTags(tags)
  };
}

async function probeLocalAudio(filePath, {
  ffprobePath = "ffprobe",
  timeoutMs = DEFAULT_FFPROBE_TIMEOUT_MS,
  execFileImpl = execFileAsync
} = {}) {
  const result = await execFileImpl(ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "--",
    filePath
  ], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: Math.max(1000, Number(timeoutMs) || DEFAULT_FFPROBE_TIMEOUT_MS)
  });
  const probe = JSON.parse(result.stdout || "{}");
  if (!(Array.isArray(probe.streams) && probe.streams.some((stream) => stream?.codec_type === "audio"))) {
    throw new Error("FFprobe found no audio stream.");
  }
  return probe;
}

function hashFile(filePath, { createReadStream = fs.createReadStream } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function* walkAudioFiles(rootPath) {
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkAudioFiles(fullPath);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield fullPath;
    }
  }
}

async function* shuffledAudioFiles(rootPath) {
  const files = [];
  for await (const filePath of walkAudioFiles(rootPath)) files.push(filePath);
  files.sort((left, right) => {
    const leftKey = crypto.createHash("sha256").update(left.toLowerCase()).digest("hex");
    const rightKey = crypto.createHash("sha256").update(right.toLowerCase()).digest("hex");
    return leftKey.localeCompare(rightKey);
  });
  yield* files;
}

function sourcePriority(source) {
  const clean = cleanText(source).toLowerCase();
  if (SOURCE_PRIORITIES[clean] !== undefined) return SOURCE_PRIORITIES[clean];
  if (clean.startsWith("rabbit-hole-memory")) return SOURCE_PRIORITIES["rabbit-hole-memory"];
  return 0;
}

function fieldValuesFromCandidate(candidate = {}) {
  const values = {
    artist: firstText(candidate.artist),
    title: firstText(candidate.title),
    album: firstText(candidate.album, candidate.releaseTitle, candidate.release),
    albumArtist: firstText(candidate.albumArtist),
    releaseDate: firstText(candidate.releaseDate, candidate.date),
    year: firstYear(candidate.year, candidate.releaseYear, candidate.releaseDate, candidate.date),
    genre: firstText(candidate.genre, Array.isArray(candidate.tags) ? candidate.tags.join(", ") : candidate.tags),
    subgenre: firstText(candidate.subgenre, candidate.subGenre),
    label: firstText(candidate.label),
    bpm: positiveNumber(candidate.bpm),
    keyName: firstText(candidate.keyName, candidate.key),
    camelot: firstText(candidate.camelot),
    isrc: cleanIsrc(candidate.isrc),
    catalogNumber: firstText(candidate.catalogNumber, candidate.catalog_number),
    durationMs: positiveNumber(candidate.durationMs || candidate.duration),
    tidalId: firstText(candidate.tidalId, candidate.tidalTrackId, candidate.tidal?.id),
    beatportId: firstText(candidate.beatportId, candidate.beatportTrackId, candidate.beatport?.id, candidate.id && candidate.source === "beatport" ? candidate.id : ""),
    musicBrainzId: firstText(candidate.musicBrainzId, candidate.musicbrainzId, candidate.musicbrainz_id),
    discogsId: firstText(candidate.discogsId, candidate.discogs_id)
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => isMeaningful(value)));
}

function evidence(source, values, {
  confidence = 0,
  matchType = "",
  raw = null,
  reason = ""
} = {}) {
  return {
    source: cleanText(source).toLowerCase(),
    confidence: Math.max(0, Math.min(100, Number(confidence) || 0)),
    matchType: cleanText(matchType),
    values: fieldValuesFromCandidate(values),
    raw,
    reason: cleanText(reason)
  };
}

function completenessFor(metadata = {}) {
  const groups = {};
  let score = 0;
  for (const group of COMPLETENESS_GROUPS) {
    const present = group.fields.filter((field) => isMeaningful(metadata[field])).length;
    const groupScore = present / group.fields.length;
    groups[group.name] = {
      present,
      total: group.fields.length,
      score: Math.round(groupScore * 100),
      fields: group.fields
    };
    score += group.weight * groupScore;
  }
  const rounded = Math.round(score);
  return {
    score: rounded,
    classification: rounded >= 85 ? "complete" : rounded >= 60 ? "mostly complete" : rounded >= 30 ? "partial" : "poor",
    groups
  };
}

function resolveMetadata(baseMetadata = {}, evidenceList = []) {
  const resolved = { ...baseMetadata };
  const selected = {};
  const allEvidence = [];
  for (const item of evidenceList) {
    if (!item?.source) continue;
    allEvidence.push(item);
    for (const [field, value] of Object.entries(item.values || {})) {
      if (!isMeaningful(value)) continue;
      const candidate = {
        value,
        source: item.source,
        confidence: item.confidence,
        matchType: item.matchType,
        raw: item.raw,
        reason: item.reason,
        rank: sourcePriority(item.source) * 1000 + item.confidence
      };
      if (!selected[field] || candidate.rank > selected[field].rank) selected[field] = candidate;
    }
  }
  for (const [field, item] of Object.entries(selected)) resolved[field] = item.value;
  const completeness = completenessFor(resolved);
  return {
    metadata: resolved,
    fieldSources: Object.fromEntries(Object.entries(selected).map(([field, item]) => [field, {
      source: item.source,
      confidence: item.confidence,
      matchType: item.matchType,
      reason: item.reason
    }])),
    completeness,
    evidence: allEvidence
  };
}

function matchTypeFor(localTrack, candidate, confidence) {
  if (confidence >= 100) return "EXACT";
  const localTitle = normalizeText(localTrack.title);
  const candidateTitle = normalizeText(candidate.title);
  if (confidence >= 95 && localTitle && candidateTitle && localTitle !== candidateTitle) return "RELATED_VERSION";
  if (confidence >= DEFAULT_MIN_CONFIDENCE) return "HIGH_CONFIDENCE";
  return "AMBIGUOUS";
}

function candidateRecord(provider, candidate, localTrack, minConfidence = DEFAULT_MIN_CONFIDENCE) {
  const confidenceInfo = strictConfidenceForMatch(localTrack, candidate);
  const matchType = matchTypeFor(localTrack, candidate, confidenceInfo.confidence);
  return {
    provider,
    artist: firstText(candidate.artist),
    title: firstText(candidate.title),
    confidence: confidenceInfo.confidence,
    matchType: confidenceInfo.confidence >= minConfidence ? matchType : "AMBIGUOUS",
    accepted: confidenceInfo.confidence >= minConfidence,
    reason: confidenceInfo.reason,
    raw: candidate
  };
}

function memoryEvidenceForTrack(musicMemory, track) {
  const db = musicMemory?.db;
  if (!db) return { evidence: [], matches: [] };
  const normalizedArtist = normalizeText(track.artist);
  const normalizedTitle = normalizeText(track.title);
  const isrc = cleanIsrc(track.isrc);
  if (!normalizedArtist && !normalizedTitle && !isrc) return { evidence: [], matches: [] };

  const rows = db.prepare(`
    SELECT *
    FROM track_identity
    WHERE (? <> '' AND isrc = ?)
       OR (? <> '' AND ? <> '' AND normalized_artist = ? AND normalized_title = ?)
    ORDER BY CASE WHEN ? <> '' AND isrc = ? THEN 0 ELSE 1 END, id
    LIMIT 8
  `).all(isrc, isrc, normalizedArtist, normalizedTitle, normalizedArtist, normalizedTitle, isrc, isrc);
  const allEvidence = [];
  const matches = [];
  for (const row of rows) {
    const rowIsrc = cleanIsrc(row.isrc);
    const exact = Boolean(isrc && rowIsrc && isrc === rowIsrc);
    const identity = {
      artist: row.artist,
      title: row.title,
      album: row.album,
      durationMs: row.duration_ms,
      isrc: row.isrc,
      tidalId: row.tidal_id
    };
    const providerIds = jsonParse(row.provider_ids, {});
    if (providerIds.beatport) identity.beatportId = providerIds.beatport;
    if (providerIds.musicbrainz) identity.musicBrainzId = providerIds.musicbrainz;
    if (providerIds.discogs) identity.discogsId = providerIds.discogs;
    allEvidence.push(evidence("rabbit-hole-memory", identity, {
      confidence: exact ? 100 : 95,
      matchType: exact ? "EXACT_MEMORY" : "MEMORY_MATCH",
      raw: row,
      reason: exact ? "ISRC matched existing Rabbit Hole identity" : "artist/title matched existing Rabbit Hole identity"
    }));
    const providers = db.prepare(`
      SELECT * FROM provider_enrichment
      WHERE track_identity_id = ?
      ORDER BY fetched_at DESC, id DESC
    `).all(row.id);
    for (const provider of providers) {
      allEvidence.push(evidence("rabbit-hole-memory", {
        artist: row.artist,
        title: row.title,
        album: provider.release_title,
        genre: provider.genre,
        subgenre: provider.subgenre,
        tags: provider.tags,
        bpm: provider.bpm,
        keyName: provider.key_name,
        camelot: provider.camelot,
        label: provider.label,
        releaseDate: provider.release_date,
        durationMs: provider.duration_ms,
        isrc: provider.isrc,
        beatportId: provider.provider === "beatport" ? provider.provider_track_id : "",
        musicBrainzId: provider.provider === "musicbrainz" ? provider.provider_track_id : "",
        discogsId: provider.provider === "discogs" ? provider.provider_track_id : ""
      }, {
        confidence: Number(provider.confidence || 90),
        matchType: `CACHED_${String(provider.provider || "provider").toUpperCase()}`,
        raw: provider,
        reason: `existing provider enrichment cached in Rabbit Hole (${provider.provider})`
      }));
    }
    matches.push({
      provider: "rabbit-hole-memory",
      artist: row.artist,
      title: row.title,
      confidence: exact ? 100 : 95,
      matchType: exact ? "EXACT" : "HIGH_CONFIDENCE",
      accepted: true,
      reason: exact ? "ISRC match" : "normalized artist/title match",
      raw: row
    });
  }
  return { evidence: allEvidence, matches };
}

function cachedMetadataEvidence(cacheFile, track) {
  if (!cacheFile || !fs.existsSync(cacheFile)) return { evidence: [], matches: [] };
  try {
    const payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const key = metadataCacheKey(track);
    const entry = (Array.isArray(payload?.entries) ? payload.entries : []).find((item) => item?.key === key);
    if (!entry || entry.status !== "found") return { evidence: [], matches: [] };
    return {
      evidence: [evidence("rabbit-hole-cache", entry, {
        confidence: Number(entry.confidence || 89),
        matchType: "CACHED_METADATA",
        raw: entry,
        reason: "existing Rabbit Hole metadata cache entry"
      })],
      matches: [{
        provider: "rabbit-hole-cache",
        artist: entry.artist,
        title: entry.title,
        confidence: Number(entry.confidence || 89),
        matchType: "HIGH_CONFIDENCE",
        accepted: true,
        reason: "existing metadata cache entry",
        raw: entry
      }]
    };
  } catch {
    return { evidence: [], matches: [] };
  }
}

function candidateToEvidence(provider, record, localTrack, minConfidence) {
  const match = candidateRecord(provider, record, localTrack, minConfidence);
  if (!match.accepted) return { evidence: [], matches: [match] };
  return {
    evidence: [evidence(provider, record, {
      confidence: match.confidence,
      matchType: match.matchType,
      raw: record,
      reason: match.reason
    })],
    matches: [match]
  };
}

function musicBrainzCandidate(recording = {}) {
  const credits = Array.isArray(recording["artist-credit"]) ? recording["artist-credit"] : [];
  const artist = credits.map((credit) => credit?.artist?.name || credit?.name).filter(Boolean).join(", ");
  const release = Array.isArray(recording.releases) ? recording.releases.find((item) => item?.id) || {} : {};
  const tags = [...(recording.genres || []), ...(recording.tags || []), ...(release.genres || []), ...(release.tags || [])]
    .map((item) => item?.name || item?.title || item?.value || item)
    .filter(Boolean);
  return {
    source: "musicbrainz",
    id: recording.id,
    musicBrainzId: recording.id,
    artist,
    title: recording.title,
    album: release.title,
    genre: tags.slice(0, 8).join(", "),
    releaseDate: release.date || release["first-release-date"],
    durationMs: recording.length
  };
}

function storedMetadataFromRow(row = {}) {
  return {
    filePath: path.resolve(row.file_path || ""),
    artist: cleanText(row.artist),
    title: cleanText(row.title),
    album: cleanText(row.album),
    albumArtist: cleanText(row.album_artist),
    trackNumber: Number(row.track_number || 0) || null,
    discNumber: Number(row.disc_number || 0) || null,
    releaseDate: cleanText(row.release_date),
    year: Number(row.year || 0) || null,
    genre: cleanText(row.genre),
    subgenre: cleanText(row.subgenre),
    label: cleanText(row.label),
    bpm: Number(row.bpm || 0) || null,
    keyName: cleanText(row.key_name),
    camelot: cleanText(row.camelot),
    isrc: cleanIsrc(row.isrc),
    catalogNumber: cleanText(row.catalog_number),
    tidalId: cleanText(row.tidal_id),
    beatportId: cleanText(row.beatport_id),
    musicBrainzId: cleanText(row.musicbrainz_id),
    discogsId: cleanText(row.discogs_id),
    durationMs: Number(row.duration_ms || 0) || null,
    fileFormat: cleanText(row.file_format),
    sampleRate: Number(row.sample_rate || 0) || null,
    bitDepth: Number(row.bit_depth || 0) || null,
    channels: Number(row.channels || 0) || null,
    rawTags: jsonParse(row.raw_tags_json, {}) || {}
  };
}

function storedMetadataEvidence(row = {}, metadata = {}) {
  const fieldSources = jsonParse(row.field_sources_json, {}) || {};
  const groups = new Map();
  for (const [field, sourceInfo] of Object.entries(fieldSources)) {
    if (!isMeaningful(metadata[field])) continue;
    const source = cleanText(sourceInfo?.source).toLowerCase() || "embedded";
    const key = [source, sourceInfo?.confidence || 100, sourceInfo?.matchType || "", sourceInfo?.reason || ""].join("|");
    const group = groups.get(key) || {
      source,
      confidence: Number(sourceInfo?.confidence || 100),
      matchType: cleanText(sourceInfo?.matchType) || "STORED_METADATA",
      reason: cleanText(sourceInfo?.reason) || "previously resolved local-library metadata",
      values: {}
    };
    group.values[field] = metadata[field];
    groups.set(key, group);
  }
  for (const [field, value] of Object.entries(metadata)) {
    if (!isMeaningful(value) || ["filePath", "rawTags"].includes(field)) continue;
    if ([...groups.values()].some((group) => Object.prototype.hasOwnProperty.call(group.values, field))) continue;
    const group = groups.get("embedded|100|STORED_METADATA|") || {
      source: "embedded",
      confidence: 100,
      matchType: "STORED_METADATA",
      reason: "previously resolved local-library metadata",
      values: {}
    };
    group.values[field] = value;
    groups.set("embedded|100|STORED_METADATA|", group);
  }
  return [...groups.values()].map((group) => evidence(group.source, group.values, group));
}

class LocalLibraryMetadataStore {
  constructor({
    musicMemory = null,
    dbFile = "",
    logger = console,
    clock = Date.now
  } = {}) {
    this.musicMemory = musicMemory;
    this.db = musicMemory?.db || null;
    this.ownsDb = false;
    this.dbFile = dbFile || musicMemory?.dbFile || "";
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    if (!this.db && this.dbFile) {
      if (!DatabaseSync) throw new Error("node:sqlite is not available in this Node runtime");
      fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 10000");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.ownsDb = true;
    }
    if (!this.db) throw new Error("A Rabbit Hole music-memory database is required.");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_library_file (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_hash TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        file_modified_at TEXT,
        file_format TEXT,
        sample_rate INTEGER,
        bit_depth INTEGER,
        channels INTEGER,
        duration_ms INTEGER,
        artist TEXT,
        title TEXT,
        album TEXT,
        album_artist TEXT,
        track_number INTEGER,
        disc_number INTEGER,
        release_date TEXT,
        year INTEGER,
        genre TEXT,
        subgenre TEXT,
        label TEXT,
        bpm REAL,
        key_name TEXT,
        camelot TEXT,
        isrc TEXT,
        catalog_number TEXT,
        tidal_id TEXT,
        beatport_id TEXT,
        musicbrainz_id TEXT,
        discogs_id TEXT,
        completeness_score INTEGER NOT NULL DEFAULT 0,
        completeness_class TEXT NOT NULL DEFAULT 'poor',
        field_sources_json TEXT,
        raw_tags_json TEXT,
        provider_set TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'processed',
        last_scanned_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_local_library_file_path ON local_library_file(file_path);
      CREATE INDEX IF NOT EXISTS idx_local_library_file_artist_title ON local_library_file(artist, title);

      CREATE TABLE IF NOT EXISTS local_metadata_field (
        local_file_id INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        field_value TEXT,
        source TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 0,
        match_type TEXT,
        reason TEXT,
        evidence_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(local_file_id, field_name, source),
        FOREIGN KEY(local_file_id) REFERENCES local_library_file(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS local_library_match (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_file_id INTEGER NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        artist TEXT,
        title TEXT,
        confidence INTEGER NOT NULL DEFAULT 0,
        match_type TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        candidate_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(local_file_id) REFERENCES local_library_file(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_library_match_review ON local_library_match(accepted, confidence);

      CREATE TABLE IF NOT EXISTS local_library_job (
        job_id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        options_json TEXT,
        status TEXT NOT NULL,
        files_seen INTEGER NOT NULL DEFAULT 0,
        files_processed INTEGER NOT NULL DEFAULT 0,
        files_skipped INTEGER NOT NULL DEFAULT 0,
        files_failed INTEGER NOT NULL DEFAULT 0,
        last_file_path TEXT,
        last_file_hash TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    // A file's content hash changes when metadata is written. The path is the
    // durable library identity for this table, so remove any stale hash row
    // before enforcing one row per path. This also repairs rows created by an
    // older writer that keyed only on file_hash.
    const duplicatePaths = this.db.prepare(`
      SELECT file_path, MAX(id) AS keep_id
      FROM local_library_file
      GROUP BY file_path
      HAVING COUNT(*) > 1
    `).all();
    const removeDuplicates = this.db.prepare("DELETE FROM local_library_file WHERE file_path = ? AND id <> ?");
    for (const duplicate of duplicatePaths) removeDuplicates.run(duplicate.file_path, duplicate.keep_id);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_local_library_file_path_unique ON local_library_file(file_path COLLATE NOCASE)");
  }

  close() {
    if (!this.ownsDb) return;
    try { this.db?.close?.(); } catch { /* best effort */ }
    this.db = null;
  }

  reusableFile(filePath, stat, providerSet) {
    const row = this.db.prepare(`
      SELECT * FROM local_library_file
      WHERE file_path = ? AND file_size = ? AND file_modified_at = ?
        AND status = 'processed'
      LIMIT 1
    `).get(path.resolve(filePath), Number(stat.size), new Date(stat.mtimeMs).toISOString());
    if (!row) return null;
    const wanted = new Set(String(providerSet || "").split(",").map(cleanText).filter(Boolean));
    const available = new Set(String(row.provider_set || "").split(",").map(cleanText).filter(Boolean));
    return [...wanted].every((provider) => available.has(provider)) ? row : null;
  }

  saveResult(result, { providerSet = "" } = {}) {
    const scannedAt = result.scannedAt || new Date(Number(this.clock())).toISOString();
    const metadata = result.metadata || {};
    const completeness = result.completeness || completenessFor(metadata);
    const sourcePath = path.resolve(result.filePath);
    // Tag edits and other legitimate file replacements change the hash while
    // keeping the same path. Remove the previous row before inserting the new
    // snapshot so the library cannot accumulate duplicate path records.
    this.db.prepare("DELETE FROM local_library_file WHERE file_path = ? AND file_hash <> ?").run(sourcePath, result.fileHash);
    this.db.prepare(`
      INSERT INTO local_library_file (
        file_hash, file_path, file_size, file_modified_at, file_format, sample_rate, bit_depth, channels,
        duration_ms, artist, title, album, album_artist, track_number, disc_number, release_date, year,
        genre, subgenre, label, bpm, key_name, camelot, isrc, catalog_number, tidal_id, beatport_id,
        musicbrainz_id, discogs_id, completeness_score, completeness_class, field_sources_json, raw_tags_json,
        provider_set, status, last_scanned_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        file_modified_at = excluded.file_modified_at,
        file_format = excluded.file_format,
        sample_rate = excluded.sample_rate,
        bit_depth = excluded.bit_depth,
        channels = excluded.channels,
        duration_ms = excluded.duration_ms,
        artist = excluded.artist,
        title = excluded.title,
        album = excluded.album,
        album_artist = excluded.album_artist,
        track_number = excluded.track_number,
        disc_number = excluded.disc_number,
        release_date = excluded.release_date,
        year = excluded.year,
        genre = excluded.genre,
        subgenre = excluded.subgenre,
        label = excluded.label,
        bpm = excluded.bpm,
        key_name = excluded.key_name,
        camelot = excluded.camelot,
        isrc = excluded.isrc,
        catalog_number = excluded.catalog_number,
        tidal_id = excluded.tidal_id,
        beatport_id = excluded.beatport_id,
        musicbrainz_id = excluded.musicbrainz_id,
        discogs_id = excluded.discogs_id,
        completeness_score = excluded.completeness_score,
        completeness_class = excluded.completeness_class,
        field_sources_json = excluded.field_sources_json,
        raw_tags_json = excluded.raw_tags_json,
        provider_set = excluded.provider_set,
        status = excluded.status,
        last_scanned_at = excluded.last_scanned_at,
        last_error = excluded.last_error
    `).run(
      result.fileHash, sourcePath, Number(result.fileSize) || null, result.modifiedAt || null, metadata.fileFormat || null,
      metadata.sampleRate || null, metadata.bitDepth || null, metadata.channels || null, metadata.durationMs || null,
      metadata.artist || null, metadata.title || null, metadata.album || null, metadata.albumArtist || null,
      metadata.trackNumber || null, metadata.discNumber || null, metadata.releaseDate || null, metadata.year || null,
      metadata.genre || null, metadata.subgenre || null, metadata.label || null, metadata.bpm || null,
      metadata.keyName || null, metadata.camelot || null, metadata.isrc || null, metadata.catalogNumber || null,
      metadata.tidalId || null, metadata.beatportId || null, metadata.musicBrainzId || null, metadata.discogsId || null,
      completeness.score, completeness.classification, jsonStringify(result.fieldSources || {}),
      jsonStringify(metadata.rawTags || {}), providerSet, result.status || "processed", scannedAt, result.error || null
    );
    const row = this.db.prepare("SELECT id FROM local_library_file WHERE file_hash = ?").get(result.fileHash);
    if (!row) throw new Error("Local-library metadata row could not be stored.");

    const fieldStatement = this.db.prepare(`
      INSERT INTO local_metadata_field (
        local_file_id, field_name, field_value, source, confidence, match_type, reason, evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_file_id, field_name, source) DO UPDATE SET
        field_value = excluded.field_value,
        confidence = excluded.confidence,
        match_type = excluded.match_type,
        reason = excluded.reason,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `);
    for (const item of result.evidence || []) {
      for (const [field, value] of Object.entries(item.values || {})) {
        if (!isMeaningful(value)) continue;
        fieldStatement.run(row.id, field, String(value), item.source, item.confidence || 0, item.matchType || "", item.reason || "", jsonStringify(item.raw), scannedAt);
      }
    }

    const matchStatement = this.db.prepare(`
      INSERT INTO local_library_match (
        local_file_id, source_event_id, provider, artist, title, confidence, match_type, accepted, reason, candidate_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_event_id) DO UPDATE SET
        confidence = excluded.confidence,
        match_type = excluded.match_type,
        accepted = excluded.accepted,
        reason = excluded.reason,
        candidate_json = excluded.candidate_json,
        created_at = excluded.created_at
    `);
    for (const match of result.matches || []) {
      const candidateKey = normalizeText(`${match.provider}|${match.artist}|${match.title}`);
      matchStatement.run(row.id, `local-match:${result.fileHash}:${candidateKey}`, match.provider, match.artist || null, match.title || null, match.confidence || 0, match.matchType || "", match.accepted ? 1 : 0, match.reason || "", jsonStringify(match.raw), scannedAt);
    }
    return row;
  }

  saveJob(job) {
    const now = new Date(Number(this.clock())).toISOString();
    this.db.prepare(`
      INSERT INTO local_library_job (
        job_id, root_path, options_json, status, files_seen, files_processed, files_skipped, files_failed,
        last_file_path, last_file_hash, started_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        files_seen = excluded.files_seen,
        files_processed = excluded.files_processed,
        files_skipped = excluded.files_skipped,
        files_failed = excluded.files_failed,
        last_file_path = excluded.last_file_path,
        last_file_hash = excluded.last_file_hash,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run(job.jobId, job.rootPath, jsonStringify(job.options || {}), job.status, job.filesSeen || 0, job.filesProcessed || 0, job.filesSkipped || 0, job.filesFailed || 0, job.lastFilePath || null, job.lastFileHash || null, job.startedAt || now, now, job.completedAt || null);
  }

  status() {
    const count = (sql) => Number(this.db.prepare(sql).get()?.count || 0);
    return {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      fileCount: count("SELECT COUNT(*) AS count FROM local_library_file"),
      processedCount: count("SELECT COUNT(*) AS count FROM local_library_file WHERE status = 'processed'"),
      ambiguousMatchCount: count("SELECT COUNT(*) AS count FROM local_library_match WHERE accepted = 0"),
      fieldEvidenceCount: count("SELECT COUNT(*) AS count FROM local_metadata_field"),
      jobCount: count("SELECT COUNT(*) AS count FROM local_library_job")
    };
  }

  reviewQueue({
    minDurationDeltaMs = 30_000,
    severeDurationDeltaMs = 120_000,
    limit = 0
  } = {}) {
    const safeMinDelta = Math.max(1_000, Number(minDurationDeltaMs) || 30_000);
    const safeSevereDelta = Math.max(safeMinDelta, Number(severeDurationDeltaMs) || 120_000);
    const files = this.db.prepare(`
      SELECT *
      FROM local_library_file
      WHERE status = 'processed'
      ORDER BY CASE completeness_class WHEN 'poor' THEN 0 WHEN 'partial' THEN 1 WHEN 'mostly complete' THEN 2 ELSE 3 END,
        completeness_score ASC, artist COLLATE NOCASE, title COLLATE NOCASE
    `).all();
    const matchesForFile = this.db.prepare(`
      SELECT *
      FROM local_library_match
      WHERE local_file_id = ?
      ORDER BY accepted DESC, confidence DESC, provider, id
    `);
    const items = [];
    let partialCount = 0;
    let mostlyCompleteCount = 0;
    let relatedVersionCount = 0;
    let severeVersionCount = 0;
    let multipleMusicBrainzCandidateCount = 0;
    let unresolvedExternalMatchCount = 0;

    const summarizeMatch = (row) => {
      const candidate = jsonParse(row.candidate_json, {}) || {};
      return {
        id: row.id,
        provider: row.provider,
        artist: row.artist || null,
        title: row.title || null,
        confidence: Number(row.confidence || 0),
        matchType: row.match_type || "",
        accepted: Boolean(row.accepted),
        reason: row.reason || "",
        providerId: firstText(candidate.id, candidate.beatportId, candidate.musicBrainzId, candidate.discogsId),
        isrc: cleanIsrc(candidate.isrc),
        mixName: firstText(candidate.mixName, candidate.mix_name),
        label: firstText(candidate.label),
        genre: firstText(candidate.genre, candidate.subGenre, candidate.subgenre),
        durationMs: durationMsFromCandidate(candidate),
        url: firstText(candidate.beatportUrl, candidate.discogsUrl, candidate.url)
      };
    };

    for (const file of files) {
      const rows = matchesForFile.all(file.id);
      const matches = rows.map(summarizeMatch);
      const acceptedExternal = matches.filter((match) => match.accepted && ["beatport", "musicbrainz", "discogs"].includes(match.provider));
      const rejectedExternal = matches.filter((match) => !match.accepted
        && ["beatport", "musicbrainz", "discogs"].includes(match.provider)
        && ["AMBIGUOUS", "ERROR", "UNAVAILABLE"].includes(match.matchType)
        && (!acceptedExternal.length || ["ERROR", "UNAVAILABLE"].includes(match.matchType)
          || ["poor", "partial"].includes(file.completeness_class)));
      const acceptedMusicBrainz = matches.filter((match) => match.provider === "musicbrainz" && match.accepted);
      const acceptedBeatport = matches.filter((match) => match.provider === "beatport" && match.accepted);
      const relatedVersions = [];
      for (const match of acceptedBeatport) {
        const localDurationMs = Number(file.duration_ms) > 0 ? Number(file.duration_ms) : null;
        const providerDurationMs = Number(match.durationMs) > 0 ? Number(match.durationMs) : null;
        const durationDeltaMs = localDurationMs && providerDurationMs
          ? Math.abs(providerDurationMs - localDurationMs)
          : null;
        if (match.matchType === "RELATED_VERSION" || (durationDeltaMs !== null && durationDeltaMs >= safeMinDelta)) {
          relatedVersions.push({
            ...match,
            localDurationMs,
            providerDurationMs,
            durationDeltaMs,
            severity: durationDeltaMs !== null && durationDeltaMs >= safeSevereDelta ? "high" : "review"
          });
        }
      }

      const reasons = [];
      if (["poor", "partial"].includes(file.completeness_class)) {
        partialCount += 1;
        reasons.push("INCOMPLETE_METADATA");
      } else if (file.completeness_class === "mostly complete") {
        mostlyCompleteCount += 1;
      }
      if (rejectedExternal.length) {
        unresolvedExternalMatchCount += 1;
        reasons.push("UNRESOLVED_EXTERNAL_MATCH");
      }
      if (acceptedMusicBrainz.length > 1) {
        multipleMusicBrainzCandidateCount += 1;
        reasons.push("MULTIPLE_ACCEPTED_MUSICBRAINZ_CANDIDATES");
      }
      if (relatedVersions.length) {
        relatedVersionCount += 1;
        if (relatedVersions.some((match) => match.severity === "high")) severeVersionCount += 1;
        reasons.push("RELATED_VERSION_REVIEW");
      }
      if (!reasons.length) continue;

      const priority = reasons.includes("INCOMPLETE_METADATA") || reasons.includes("UNRESOLVED_EXTERNAL_MATCH")
        ? "high"
        : relatedVersions.some((match) => match.severity === "high") ? "medium" : "low";
      items.push({
        reviewId: `local-review:${file.file_hash}`,
        priority,
        reasons,
        file: {
          id: file.id,
          fileHash: file.file_hash,
          filePath: file.file_path,
          artist: file.artist || null,
          title: file.title || null,
          album: file.album || null,
          durationMs: Number(file.duration_ms) || null,
          format: file.file_format || null
        },
        resolvedMetadata: {
          artist: file.artist || null,
          title: file.title || null,
          album: file.album || null,
          genre: file.genre || null,
          subgenre: file.subgenre || null,
          label: file.label || null,
          bpm: Number(file.bpm) || null,
          keyName: file.key_name || null,
          year: Number(file.year) || null,
          isrc: cleanIsrc(file.isrc),
          catalogNumber: file.catalog_number || null,
          beatportId: file.beatport_id || null,
          musicBrainzId: file.musicbrainz_id || null,
          discogsId: file.discogs_id || null
        },
        completeness: {
          score: Number(file.completeness_score) || 0,
          classification: file.completeness_class || "poor"
        },
        rejectedMatches: rejectedExternal,
        acceptedMatches: matches.filter((match) => match.accepted),
        relatedVersions
      });
    }

    const sortedItems = items.sort((left, right) => {
      const priority = { high: 0, medium: 1, low: 2 };
      return (priority[left.priority] - priority[right.priority])
        || (left.completeness.score - right.completeness.score)
        || left.file.filePath.localeCompare(right.file.filePath, undefined, { sensitivity: "base" });
    });
    const requestedLimit = Math.max(0, Number(limit) || 0);
    return {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      generatedAt: new Date(Number(this.clock())).toISOString(),
      criteria: {
        incompleteClasses: ["poor", "partial"],
        minDurationDeltaMs: safeMinDelta,
        severeDurationDeltaMs: safeSevereDelta,
        externalReviewMatchTypes: ["AMBIGUOUS", "ERROR", "UNAVAILABLE"]
      },
      summary: {
        filesScanned: files.length,
        reviewItems: sortedItems.length,
        returnedItems: requestedLimit ? Math.min(requestedLimit, sortedItems.length) : sortedItems.length,
        partialCount,
        mostlyCompleteCount,
        relatedVersionCount,
        severeVersionCount,
        multipleMusicBrainzCandidateCount,
        unresolvedExternalMatchCount
      },
      items: requestedLimit ? sortedItems.slice(0, requestedLimit) : sortedItems
    };
  }
}

class LocalLibraryMetadataEnricher {
  constructor({
    musicMemory = null,
    store = null,
    beatport = null,
    musicBrainzIndex = null,
    discogs = null,
    cacheFile = "",
    ffprobePath = "ffprobe",
    ffprobeTimeoutMs = DEFAULT_FFPROBE_TIMEOUT_MS,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
    logger = console,
    clock = Date.now,
    probe = probeLocalAudio,
    hash = hashFile
  } = {}) {
    this.musicMemory = musicMemory;
    this.store = store;
    this.beatport = beatport;
    this.musicBrainzIndex = musicBrainzIndex;
    this.discogs = discogs;
    this.cacheFile = cacheFile;
    this.ffprobePath = ffprobePath;
    this.ffprobeTimeoutMs = ffprobeTimeoutMs;
    this.minConfidence = Number(minConfidence) || DEFAULT_MIN_CONFIDENCE;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.probe = probe;
    this.hash = hash;
  }

  async enrichMetadataBase(base, {
    evidenceList = [],
    matches = [],
    providers = ["embedded", "memory", "cache"],
    musicBrainzRecordings = null
  } = {}) {
    const providerSet = Array.from(new Set(providers.map((item) => cleanText(item).toLowerCase()).filter(Boolean))).sort();
    const track = base;

    if (providerSet.includes("memory")) {
      const memory = memoryEvidenceForTrack(this.musicMemory, track);
      evidenceList.push(...memory.evidence);
      matches.push(...memory.matches);
    }
    if (providerSet.includes("cache")) {
      const cached = cachedMetadataEvidence(this.cacheFile, track);
      evidenceList.push(...cached.evidence);
      matches.push(...cached.matches);
    }
    if (providerSet.includes("beatport")) {
      if (!this.beatport?.isConfigured?.()) {
        matches.push({ provider: "beatport", confidence: 0, matchType: "UNAVAILABLE", accepted: false, reason: "Beatport is not configured", raw: null });
      } else if (track.artist && track.title) {
        try {
          const candidate = await this.beatport.findTrack(track);
          if (candidate) {
            const prepared = { ...candidate, source: "beatport", beatportId: candidate.id };
            const versionSafety = beatportVersionSafety(track, prepared);
            const result = versionSafety.safe
              ? candidateToEvidence("beatport", prepared, track, this.minConfidence)
              : {
                evidence: [],
                matches: [{
                  provider: "beatport",
                  artist: firstText(prepared.artist),
                  title: firstText(prepared.title),
                  confidence: 0,
                  matchType: "AMBIGUOUS",
                  accepted: false,
                  reason: versionSafety.reason,
                  raw: prepared
                }]
              };
            evidenceList.push(...result.evidence);
            matches.push(...result.matches);
          } else {
            matches.push({ provider: "beatport", confidence: 0, matchType: "NOT_FOUND", accepted: false, reason: "Beatport returned no candidate", raw: null });
          }
        } catch (error) {
          matches.push({ provider: "beatport", confidence: 0, matchType: "ERROR", accepted: false, reason: error.message, raw: null });
        }
      }
    }
    if (providerSet.includes("musicbrainz")) {
      const recordings = Array.isArray(musicBrainzRecordings)
        ? musicBrainzRecordings
        : this.musicBrainzIndex?.searchRecordings?.(track) || [];
      if (!recordings.length) {
        matches.push({ provider: "musicbrainz", confidence: 0, matchType: "NOT_FOUND", accepted: false, reason: "MusicBrainz local index returned no candidate", raw: null });
      } else {
        const candidates = recordings.slice(0, 8).map(musicBrainzCandidate);
        const ranked = candidates.map((candidate) => candidateRecord("musicbrainz", candidate, track, this.minConfidence))
          .sort((left, right) => right.confidence - left.confidence);
        matches.push(...ranked);
        const best = ranked.find((candidate) => candidate.accepted);
        if (best) {
          const record = candidates.find((candidate) => candidate.title === best.title && candidate.artist === best.artist) || candidates[0];
          evidenceList.push(evidence("musicbrainz", record, {
            confidence: best.confidence,
            matchType: best.matchType,
            raw: record,
            reason: best.reason
          }));
        }
      }
    }
    if (providerSet.includes("discogs")) {
      if (!this.discogs?.isConfigured?.()) {
        matches.push({ provider: "discogs", confidence: 0, matchType: "UNAVAILABLE", accepted: false, reason: "Discogs is not configured", raw: null });
      } else if (track.artist && track.title) {
        try {
          const candidate = await this.discogs.findTrack(track);
          if (candidate) {
            const prepared = { ...candidate, source: "discogs", discogsId: candidate.discogsId || candidate.releaseId };
            const result = candidateToEvidence("discogs", prepared, track, this.minConfidence);
            evidenceList.push(...result.evidence);
            matches.push(...result.matches);
          } else {
            matches.push({ provider: "discogs", confidence: 0, matchType: "NOT_FOUND", accepted: false, reason: "Discogs returned no high-confidence release track candidate", raw: null });
          }
        } catch (error) {
          matches.push({ provider: "discogs", confidence: 0, matchType: "ERROR", accepted: false, reason: error.message, raw: null });
        }
      }
    }

    const resolved = resolveMetadata(base, evidenceList);
    return {
      ...resolved,
      filePath: path.resolve(base.filePath || ""),
      fileHash: base.fileHash,
      fileSize: Number(base.fileSize) || 0,
      modifiedAt: base.modifiedAt || null,
      scannedAt: new Date(Number(this.clock())).toISOString(),
      providerSet: providerSet.join(","),
      matches,
      status: "processed"
    };
  }

  async enrichFile(filePath, { stat = null, providers = ["embedded", "memory", "cache"] } = {}) {
    const fileStat = stat || await fs.promises.stat(filePath);
    const fileHash = await this.hash(filePath);
    const probeJson = await this.probe(filePath, {
      ffprobePath: this.ffprobePath,
      timeoutMs: this.ffprobeTimeoutMs
    });
    const embedded = trackFromFfprobe(filePath, probeJson);
    const base = {
      ...embedded,
      fileHash,
      fileSize: Number(fileStat.size) || 0,
      modifiedAt: new Date(fileStat.mtimeMs).toISOString()
    };
    return this.enrichMetadataBase(base, {
      evidenceList: [evidence("embedded", embedded, {
        confidence: 100,
        matchType: "EMBEDDED",
        raw: { probe: probeJson, tags: embedded.rawTags },
        reason: "metadata read from the local audio container"
      })],
      providers
    });
  }

  async enrichStoredRow(row, {
    providers = ["beatport", "musicbrainz", "discogs"],
    musicBrainzRecordings = null
  } = {}) {
    const base = {
      ...storedMetadataFromRow(row),
      fileHash: cleanText(row.file_hash),
      fileSize: Number(row.file_size) || 0,
      modifiedAt: cleanText(row.file_modified_at)
    };
    return this.enrichMetadataBase(base, {
      evidenceList: storedMetadataEvidence(row, base),
      providers,
      musicBrainzRecordings
    });
  }
}

async function enrichLocalLibrary({
  rootPath,
  enricher,
  store = null,
  jobId = "",
  providers = ["embedded", "memory", "cache"],
  limit = 25,
  offset = 0,
  all = false,
  resume = true,
  shuffle = false,
  dryRun = true,
  reportFile = "",
  logger = console
} = {}) {
  const rootPathResolved = path.resolve(rootPath || "");
  if (!rootPathResolved || !fs.existsSync(rootPathResolved)) throw new Error(`Local library root not found: ${rootPathResolved}`);
  const providerSet = Array.from(new Set(providers.map((item) => cleanText(item).toLowerCase()).filter(Boolean))).sort();
  const resolvedJobId = cleanText(jobId) || `local-library:${crypto.createHash("sha256").update(rootPathResolved.toLowerCase()).digest("hex").slice(0, 16)}`;
  const startedAt = new Date().toISOString();
  const summary = {
    jobId: resolvedJobId,
    rootPath: rootPathResolved,
    providers: providerSet,
    dryRun,
    resume,
    offset: Math.max(0, Number(offset) || 0),
    limit: all ? "all" : Math.max(0, Number(limit) || 0),
    filesSeen: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    resumed: 0,
    ambiguousMatches: 0,
    samples: [],
    failures: [],
    ambiguousSamples: [],
    startedAt
  };
  const checkpoint = () => {
    if (!store || dryRun) return;
    store.saveJob({
      jobId: resolvedJobId,
      rootPath: rootPathResolved,
      options: { providers: providerSet, limit, offset, all, resume, shuffle },
      status: "running",
      filesSeen: summary.filesSeen,
      filesProcessed: summary.filesProcessed,
      filesSkipped: summary.filesSkipped,
      filesFailed: summary.filesFailed,
      lastFilePath: summary.lastFilePath,
      lastFileHash: summary.lastFileHash,
      startedAt
    });
  };
  checkpoint();

  const fileIterator = shuffle ? shuffledAudioFiles(rootPathResolved) : walkAudioFiles(rootPathResolved);
  let offsetRemaining = Math.max(0, Number(offset) || 0);
  for await (const filePath of fileIterator) {
    if (offsetRemaining > 0) {
      offsetRemaining -= 1;
      continue;
    }
    if (!all && summary.filesSeen >= Math.max(1, Number(limit) || 1)) break;
    summary.filesSeen += 1;
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (resume && store && !dryRun && store.reusableFile(filePath, stat, providerSet.join(","))) {
        summary.resumed += 1;
        summary.filesSkipped += 1;
        summary.lastFilePath = filePath;
        checkpoint();
        continue;
      }
      const result = await enricher.enrichFile(filePath, { stat, providers: providerSet });
      if (!dryRun && store) store.saveResult(result, { providerSet: providerSet.join(",") });
      summary.filesProcessed += 1;
      summary.lastFilePath = filePath;
      summary.lastFileHash = result.fileHash;
      summary.ambiguousMatches += result.matches.filter((match) => !match.accepted && ["AMBIGUOUS", "ERROR", "NOT_FOUND", "UNAVAILABLE"].includes(match.matchType)).length;
      if (summary.samples.length < 10) {
        summary.samples.push({
          filePath,
          fileHash: result.fileHash,
          artist: result.metadata.artist || null,
          title: result.metadata.title || null,
          album: result.metadata.album || null,
          genre: result.metadata.genre || null,
          label: result.metadata.label || null,
          completeness: result.completeness,
          fieldSources: result.fieldSources,
          matches: result.matches.map((match) => ({ provider: match.provider, artist: match.artist || null, title: match.title || null, confidence: match.confidence, matchType: match.matchType, accepted: match.accepted, reason: match.reason }))
        });
      }
      const ambiguous = result.matches.filter((match) => !match.accepted && ["AMBIGUOUS", "ERROR", "NOT_FOUND", "UNAVAILABLE"].includes(match.matchType));
      if (ambiguous.length && summary.ambiguousSamples.length < 10) summary.ambiguousSamples.push({ filePath, matches: ambiguous });
    } catch (error) {
      summary.filesFailed += 1;
      summary.lastFilePath = filePath;
      if (summary.failures.length < 20) summary.failures.push({ filePath, error: error.message });
      logger?.warn?.(`Local metadata enrichment failed for ${filePath}: ${error.message}`);
    }
    checkpoint();
  }

  summary.completedAt = new Date().toISOString();
  summary.status = summary.filesFailed ? "completed_with_errors" : "complete";
  if (store && !dryRun) {
    store.saveJob({
      jobId: resolvedJobId,
      rootPath: rootPathResolved,
      options: { providers: providerSet, limit, offset, all, resume, shuffle },
      status: summary.status,
      filesSeen: summary.filesSeen,
      filesProcessed: summary.filesProcessed,
      filesSkipped: summary.filesSkipped,
      filesFailed: summary.filesFailed,
      lastFilePath: summary.lastFilePath,
      lastFileHash: summary.lastFileHash,
      startedAt,
      completedAt: summary.completedAt
    });
  }
  if (reportFile) {
    fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
    fs.writeFileSync(path.resolve(reportFile), JSON.stringify(summary, null, 2));
  }
  return summary;
}

module.exports = {
  AUDIO_EXTENSIONS,
  COMPLETENESS_GROUPS,
  DEFAULT_MIN_CONFIDENCE,
  LOCAL_LIBRARY_SCHEMA_VERSION,
  LocalLibraryMetadataEnricher,
  LocalLibraryMetadataStore,
  cleanIsrc,
  beatportTitleVersionMatch,
  completenessFor,
  enrichLocalLibrary,
  evidence,
  hashFile,
  memoryEvidenceForTrack,
  normalizeText,
  probeLocalAudio,
  durationMsFromCandidate,
  resolveMetadata,
  reviewLocalLibraryMetadata: (store, options) => store.reviewQueue(options),
  shuffledAudioFiles,
  trackFromFfprobe,
  walkAudioFiles
};
