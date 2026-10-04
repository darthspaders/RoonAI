"use strict";

const WRITEBACK_PREVIEW_SCHEMA_VERSION = 1;

// This is intentionally a conservative preview policy. It describes the tags
// a future writer may fill; it does not perform any file I/O or tag mutation.
const TAG_FIELDS = [
  { field: "artist", tag: "ARTIST", aliases: ["artist", "artist name", "performer"], risk: "identity" },
  { field: "title", tag: "TITLE", aliases: ["title", "track title"], risk: "identity" },
  { field: "album", tag: "ALBUM", aliases: ["album", "release", "release title"], risk: "identity" },
  { field: "albumArtist", tag: "ALBUMARTIST", aliases: ["album artist", "albumartist", "album performer"], risk: "identity" },
  { field: "trackNumber", tag: "TRACKNUMBER", aliases: ["track", "track number", "tracknumber"], risk: "identity" },
  { field: "discNumber", tag: "DISCNUMBER", aliases: ["disc", "disc number", "discnumber", "disk"], risk: "identity" },
  { field: "releaseDate", tag: "DATE", aliases: ["date", "year", "original date", "original release date", "release date"], risk: "classification" },
  { field: "genre", tag: "GENRE", aliases: ["genre", "genres"], risk: "classification" },
  { field: "subgenre", tag: "SUBGENRE", aliases: ["subgenre", "sub genre", "style"], risk: "classification" },
  { field: "label", tag: "LABEL", aliases: ["label", "record label", "organization", "publisher"], risk: "classification" },
  { field: "bpm", tag: "BPM", aliases: ["bpm", "tempo"], risk: "technical" },
  { field: "keyName", tag: "INITIALKEY", aliases: ["key", "initial key", "initialkey"], risk: "technical" },
  { field: "camelot", tag: "CAMELOT", aliases: ["camelot", "camelot key"], risk: "technical" },
  { field: "isrc", tag: "ISRC", aliases: ["isrc", "isrcid"], risk: "identity" },
  { field: "catalogNumber", tag: "CATALOGNUMBER", aliases: ["catalog number", "catalog_number", "catalognumber", "catalog"], risk: "identity" }
];

const DB_FIELDS = {
  releaseDate: "release_date",
  albumArtist: "album_artist",
  trackNumber: "track_number",
  discNumber: "disc_number",
  keyName: "key_name",
  catalogNumber: "catalog_number",
  isrc: "isrc"
};

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function meaningful(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  const text = cleanText(value).toLowerCase();
  return Boolean(text) && !["null", "undefined", "[]", "{}"].includes(text);
}

function normalizeTagKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rawTagPresent(rawTags, aliases) {
  const keys = new Set(Object.keys(rawTags || {}).map(normalizeTagKey));
  return aliases.some((alias) => keys.has(normalizeTagKey(alias))
    && meaningful(rawTags[Object.keys(rawTags || {}).find((key) => normalizeTagKey(key) === normalizeTagKey(alias))]));
}

function rowMetadata(row) {
  const metadata = {};
  for (const definition of TAG_FIELDS) {
    const column = DB_FIELDS[definition.field] || definition.field;
    const value = row[column];
    if (meaningful(value)) metadata[definition.field] = value;
  }
  // DATE is represented in the DB by release_date and year. Prefer the full
  // release date, but retain the year as the useful fallback for tag preview.
  if (!meaningful(metadata.releaseDate) && meaningful(row.year)) metadata.releaseDate = row.year;
  return metadata;
}

function fieldSources(row) {
  return parseJson(row.field_sources_json, {}) || {};
}

function sourceInfo(row, field) {
  const source = fieldSources(row)[field];
  return {
    source: cleanText(source?.source).toLowerCase(),
    confidence: Number(source?.confidence) || 0,
    matchType: cleanText(source?.matchType),
    reason: cleanText(source?.reason)
  };
}

function unresolvedExternalMatch(db, fileId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM local_library_match
    WHERE local_file_id = ?
      AND accepted = 0
      AND provider IN ('beatport', 'musicbrainz', 'discogs')
      AND match_type IN ('AMBIGUOUS', 'ERROR', 'NOT_FOUND', 'UNAVAILABLE')
  `).get(fileId);
  return Number(row?.count || 0) > 0;
}

function multipleMusicBrainzCandidates(db, fileId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM local_library_match
    WHERE local_file_id = ? AND provider = 'musicbrainz' AND accepted = 1
  `).get(fileId);
  return Number(row?.count || 0) > 1;
}

function buildFilePreview(db, row, { minConfidence = 95 } = {}) {
  const rawTags = parseJson(row.raw_tags_json, {}) || {};
  const metadata = rowMetadata(row);
  const changes = [];
  const blockedFields = [];
  const existingFields = [];
  const rowReasons = [];
  const unresolved = unresolvedExternalMatch(db, row.id);
  const multipleMb = multipleMusicBrainzCandidates(db, row.id);

  if (!meaningful(row.artist) || !meaningful(row.title)) rowReasons.push("MISSING_IDENTITY");
  if (unresolved) rowReasons.push("UNRESOLVED_EXTERNAL_MATCH");
  if (multipleMb) rowReasons.push("MULTIPLE_ACCEPTED_MUSICBRAINZ_CANDIDATES");
  if (["poor", "partial"].includes(row.completeness_class)) rowReasons.push("INCOMPLETE_METADATA");

  for (const definition of TAG_FIELDS) {
    const value = metadata[definition.field];
    if (!meaningful(value)) continue;
    if (rawTagPresent(rawTags, definition.aliases)) {
      existingFields.push(definition.field);
      continue;
    }

    const evidence = sourceInfo(row, definition.field);
    const reasons = [];
    let decision = "safe_fill";
    if (definition.risk === "identity") {
      decision = "manual_review";
      reasons.push("IDENTITY_FIELD");
    }
    if (!evidence.source) {
      decision = "blocked";
      reasons.push("NO_FIELD_PROVENANCE");
    } else if (evidence.confidence < minConfidence) {
      decision = "manual_review";
      reasons.push("BELOW_AUTO_CONFIDENCE");
    }
    if (unresolved || multipleMb) {
      decision = decision === "blocked" ? decision : "manual_review";
      reasons.push(unresolved ? "UNRESOLVED_EXTERNAL_MATCH" : "MULTIPLE_ACCEPTED_MUSICBRAINZ_CANDIDATES");
    }
    if (evidence.matchType === "RELATED_VERSION") reasons.push("RELATED_VERSION_PROXY");

    changes.push({
      field: definition.field,
      tag: definition.tag,
      value,
      decision,
      reasons,
      source: evidence.source,
      confidence: evidence.confidence,
      matchType: evidence.matchType || null,
      evidenceReason: evidence.reason || null
    });
    if (decision !== "safe_fill") blockedFields.push(definition.field);
  }

  return {
    file: {
      id: row.id,
      fileHash: row.file_hash,
      filePath: row.file_path,
      format: row.file_format || null,
      artist: row.artist || null,
      title: row.title || null
    },
    completeness: {
      score: Number(row.completeness_score) || 0,
      classification: row.completeness_class || "poor"
    },
    rowReasons,
    changes,
    existingFields,
    blockedFields
  };
}

function buildMetadataWritePreview(db, { minConfidence = 95, limit = 0 } = {}) {
  if (!db?.prepare) throw new Error("A readable SQLite database is required.");
  const rows = db.prepare(`
    SELECT *
    FROM local_library_file
    WHERE status = 'processed'
    ORDER BY file_path COLLATE NOCASE
  `).all();
  const all = rows.map((row) => buildFilePreview(db, row, { minConfidence }));
  const items = all.filter((item) => item.changes.length > 0);
  const returned = limit > 0 ? items.slice(0, Math.max(1, Number(limit) || 1)) : items;
  const summary = {
    filesScanned: rows.length,
    filesWithChanges: items.length,
    safeFillFiles: items.filter((item) => item.changes.some((change) => change.decision === "safe_fill")).length,
    manualReviewFiles: items.filter((item) => item.changes.some((change) => change.decision === "manual_review")).length,
    blockedFiles: items.filter((item) => item.changes.some((change) => change.decision === "blocked")).length,
    safeFillChanges: items.reduce((count, item) => count + item.changes.filter((change) => change.decision === "safe_fill").length, 0),
    manualReviewChanges: items.reduce((count, item) => count + item.changes.filter((change) => change.decision === "manual_review").length, 0),
    blockedChanges: items.reduce((count, item) => count + item.changes.filter((change) => change.decision === "blocked").length, 0),
    returnedItems: returned.length
  };
  const byField = {};
  const bySource = {};
  for (const item of items) {
    for (const change of item.changes) {
      byField[change.field] = (byField[change.field] || 0) + 1;
      const sourceKey = change.source || "none";
      bySource[sourceKey] = (bySource[sourceKey] || 0) + 1;
    }
  }
  return {
    schemaVersion: WRITEBACK_PREVIEW_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    policy: {
      mode: "database_only_preview",
      minAutoConfidence: Math.max(0, Math.min(100, Number(minConfidence) || 95)),
      fillsOnlyMissingTags: true,
      overwritesExistingTags: false,
      writesAudioFiles: false,
      identityFieldsRequireManualReview: true,
      externalIdsAreDatabaseOnly: true
    },
    summary,
    byField,
    bySource,
    items: returned
  };
}

module.exports = {
  TAG_FIELDS,
  WRITEBACK_PREVIEW_SCHEMA_VERSION,
  buildFilePreview,
  buildMetadataWritePreview,
  rawTagPresent
};
