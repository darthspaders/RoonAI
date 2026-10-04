"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { trackIdentityKey } = require("./musicMemoryStore");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const SCHEMA_VERSION = 2;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return [...new Set(values.map(cleanText).filter(Boolean))].slice(0, 24);
}

function profileFromRow(row = {}) {
  return {
    identityKey: cleanText(row.anchor_identity_key),
    artist: cleanText(row.anchor_artist),
    title: cleanText(row.anchor_title),
    genre: cleanText(row.genre),
    subgenre: cleanText(row.subgenre),
    energy: Number(row.energy || 0) || null,
    mood: cleanText(row.mood),
    tags: normalizeTags(jsonParse(row.tags_json, [])),
    note: cleanText(row.note),
    sourceLabel: cleanText(row.source_label),
    model: cleanText(row.model),
    modelVersion: cleanText(row.model_version),
    createdAt: cleanText(row.created_at),
    updatedAt: cleanText(row.updated_at)
  };
}

function finiteVector(vector) {
  if (!vector || typeof vector[Symbol.iterator] !== "function") return [];
  const values = Array.from(vector, Number);
  return values.length && values.every(Number.isFinite) ? values : [];
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function normalizeVector(vector) {
  const values = finiteVector(vector);
  const norm = vectorNorm(values);
  if (!values.length || !Number.isFinite(norm) || norm <= 0) return [];
  return values.map((value) => value / norm);
}

function encodeVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

function decodeVector(value) {
  if (!value) return [];
  try {
    const buffer = Buffer.from(String(value), "base64");
    if (!buffer.length || buffer.length % 4 !== 0) return [];
    const array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    return Array.from(array);
  } catch {
    return [];
  }
}

function cosineSimilarity(left, right) {
  if (!left.length || left.length !== right.length) return null;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : null;
}

function identityKeyFor(value = {}) {
  if (typeof value === "string") {
    const text = cleanText(value);
    return /^(?:tidal|roon|isrc|text|file|beatport):/i.test(text) ? text : "";
  }
  return cleanText(value.identityKey || value.identity_key) || trackIdentityKey(value);
}

function trackFromRow(row = {}) {
  const metadata = jsonParse(row.metadata_json, {}) || {};
  return {
    identityKey: cleanText(row.identity_key),
    artist: cleanText(row.artist || metadata.artist),
    title: cleanText(row.title || metadata.title),
    album: cleanText(row.album || metadata.album),
    mixVersion: cleanText(row.mix_version || metadata.mixVersion),
    tidalId: cleanText(row.tidal_id || metadata.tidalId),
    isrc: cleanText(row.isrc || metadata.isrc),
    durationMs: Number(row.duration_ms || metadata.durationMs || 0) || null,
    sourcePath: cleanText(row.source_path || metadata.sourcePath),
    metadata
  };
}

class SonicEmbeddingStore {
  constructor({
    enabled = true,
    dbFile = path.join(__dirname, "..", "data", "rabbit-hole-memory.sqlite"),
    logger = console,
    clock = Date.now
  } = {}) {
    this.enabled = enabled !== false;
    this.dbFile = dbFile;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.db = null;
    if (this.enabled) this.open();
  }

  open() {
    try {
      if (!DatabaseSync) throw new Error("node:sqlite is not available in this Node runtime");
      fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.logger?.warn?.("Rabbit Hole sonic embedding store disabled", { error: error.message });
      this.enabled = false;
      this.db = null;
    }
  }

  migrate() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_sonic_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_key TEXT NOT NULL,
        tidal_id TEXT,
        isrc TEXT,
        artist TEXT,
        title TEXT,
        album TEXT,
        mix_version TEXT,
        duration_ms INTEGER,
        model TEXT NOT NULL,
        model_version TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding_base64 TEXT NOT NULL,
        source_path TEXT,
        source_sha256 TEXT,
        sample_rate INTEGER,
        audio_duration_ms INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(identity_key, model, model_version)
      );

      CREATE INDEX IF NOT EXISTS idx_track_sonic_profile_model
        ON track_sonic_profile(model, model_version);
      CREATE INDEX IF NOT EXISTS idx_track_sonic_profile_identity
        ON track_sonic_profile(identity_key);

      CREATE TABLE IF NOT EXISTS sonic_neighbor_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anchor_identity_key TEXT NOT NULL,
        candidate_identity_key TEXT NOT NULL,
        anchor_artist TEXT,
        anchor_title TEXT,
        candidate_artist TEXT,
        candidate_title TEXT,
        anchor_area TEXT,
        candidate_area TEXT,
        rating TEXT NOT NULL,
        note TEXT,
        source_event_id TEXT NOT NULL UNIQUE,
        source_label TEXT NOT NULL,
        model TEXT NOT NULL,
        model_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS sonic_anchor_profile (
        anchor_identity_key TEXT PRIMARY KEY,
        anchor_artist TEXT,
        anchor_title TEXT,
        genre TEXT,
        subgenre TEXT,
        energy INTEGER,
        mood TEXT,
        tags_json TEXT,
        note TEXT,
        source_label TEXT NOT NULL,
        model TEXT NOT NULL,
        model_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        raw_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sonic_anchor_profile_updated
        ON sonic_anchor_profile(updated_at);

      CREATE INDEX IF NOT EXISTS idx_sonic_neighbor_feedback_candidate
        ON sonic_neighbor_feedback(candidate_identity_key, model, model_version);
      CREATE INDEX IF NOT EXISTS idx_sonic_neighbor_feedback_anchor
        ON sonic_neighbor_feedback(anchor_identity_key, model, model_version);
    `);
    // Older live profiles were correctly keyed as tidal:<id> but could have
    // an empty dedicated tidal_id column when the source supplied only a URL.
    // Recover that unambiguous field without changing identity keys or vectors.
    this.db.prepare(`
      UPDATE track_sonic_profile
      SET tidal_id = substr(identity_key, 7)
      WHERE (tidal_id IS NULL OR tidal_id = '')
        AND identity_key LIKE 'tidal:%'
        AND length(substr(identity_key, 7)) > 0
        AND substr(identity_key, 7) NOT GLOB '*[^0-9]*'
    `).run();
  }

  close() {
    try {
      this.db?.close?.();
    } catch {
      // best effort
    }
    this.db = null;
  }

  status() {
    if (!this.enabled || !this.db) {
      return { enabled: false, dbFile: this.dbFile, schemaVersion: SCHEMA_VERSION, embeddingCount: 0, profileCount: 0, models: [] };
    }
    const embeddingCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM track_sonic_profile").get()?.count || 0);
    const profileCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM sonic_anchor_profile").get()?.count || 0);
    const models = this.db.prepare(`
      SELECT model, model_version AS modelVersion, dimensions, COUNT(*) AS count
      FROM track_sonic_profile
      GROUP BY model, model_version, dimensions
      ORDER BY model, model_version
    `).all().map((row) => ({
      model: cleanText(row.model),
      modelVersion: cleanText(row.modelVersion),
      dimensions: Number(row.dimensions || 0),
      count: Number(row.count || 0)
    }));
    return { enabled: true, dbFile: this.dbFile, schemaVersion: SCHEMA_VERSION, embeddingCount, profileCount, models };
  }

  saveSonicAnchorProfile({
    anchor = {},
    genre = "",
    subgenre = "",
    energy = null,
    mood = "",
    tags = [],
    note = "",
    sourceLabel = "rabbit-hole-sonic-review",
    model = "discogs-effnet",
    modelVersion = "1",
    createdAt = "",
    rawJson = {}
  } = {}) {
    if (!this.enabled || !this.db) throw new Error("Sonic embedding storage is disabled.");
    const anchorIdentityKey = identityKeyFor(anchor);
    if (!anchorIdentityKey) throw new Error("A sonic profile requires a stored track identity.");
    const anchorTrack = anchor && typeof anchor === "object" ? anchor : {};
    const cleanEnergy = String(energy ?? "").trim() === "" ? null : Math.max(1, Math.min(10, Math.round(Number(energy))));
    if (cleanEnergy !== null && !Number.isFinite(cleanEnergy)) throw new Error("Sonic profile energy must be a number from 1 to 10.");
    const cleanModel = cleanText(model) || "discogs-effnet";
    const cleanModelVersion = cleanText(modelVersion) || "1";
    const timestamp = cleanText(createdAt) || new Date(Number(this.clock())).toISOString();
    this.db.prepare(`
      INSERT INTO sonic_anchor_profile (
        anchor_identity_key, anchor_artist, anchor_title, genre, subgenre, energy,
        mood, tags_json, note, source_label, model, model_version, created_at, updated_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anchor_identity_key) DO UPDATE SET
        anchor_artist = excluded.anchor_artist,
        anchor_title = excluded.anchor_title,
        genre = excluded.genre,
        subgenre = excluded.subgenre,
        energy = excluded.energy,
        mood = excluded.mood,
        tags_json = excluded.tags_json,
        note = excluded.note,
        source_label = excluded.source_label,
        model = excluded.model,
        model_version = excluded.model_version,
        updated_at = excluded.updated_at,
        raw_json = excluded.raw_json
    `).run(
      anchorIdentityKey,
      cleanText(anchorTrack.artist),
      cleanText(anchorTrack.title),
      cleanText(genre),
      cleanText(subgenre),
      cleanEnergy,
      cleanText(mood),
      jsonStringify(normalizeTags(tags)),
      cleanText(note),
      cleanText(sourceLabel) || "rabbit-hole-sonic-review",
      cleanModel,
      cleanModelVersion,
      timestamp,
      timestamp,
      jsonStringify(rawJson)
    );
    return this.getSonicAnchorProfile(anchor);
  }

  getSonicAnchorProfile(anchor = {}) {
    if (!this.enabled || !this.db) return null;
    const identityKey = identityKeyFor(anchor);
    if (!identityKey) return null;
    const row = this.db.prepare("SELECT * FROM sonic_anchor_profile WHERE anchor_identity_key = ? LIMIT 1").get(identityKey);
    return row ? profileFromRow(row) : null;
  }

  saveSonicNeighborFeedback({
    anchor = {},
    candidate = {},
    rating = "",
    note = "",
    anchorArea = "",
    candidateArea = "",
    sourceEventId = "",
    sourceLabel = "sonic-neighbor-review",
    model = "discogs-effnet",
    modelVersion = "1",
    createdAt = "",
    rawJson = {}
  } = {}) {
    if (!this.enabled || !this.db) throw new Error("Sonic embedding storage is disabled.");
    const { normalizeSonicNeighborRating } = require("./sonicNeighborFeedback");
    const normalizedRating = normalizeSonicNeighborRating(rating);
    if (!normalizedRating) throw new Error("A sonic-neighbor rating must be keep, skip, wrong_genre, or reject_similar.");
    const anchorIdentityKey = identityKeyFor(anchor);
    const candidateIdentityKey = identityKeyFor(candidate);
    if (!anchorIdentityKey || !candidateIdentityKey) throw new Error("Sonic-neighbor feedback requires anchor and candidate identities.");
    if (anchorIdentityKey === candidateIdentityKey) throw new Error("Sonic-neighbor feedback cannot rate an anchor as its own neighbor.");
    const anchorTrack = anchor && typeof anchor === "object" ? anchor : {};
    const candidateTrack = candidate && typeof candidate === "object" ? candidate : {};
    const cleanModel = cleanText(model) || "discogs-effnet";
    const cleanModelVersion = cleanText(modelVersion) || "1";
    const timestamp = cleanText(createdAt) || new Date(Number(this.clock())).toISOString();
    const eventId = cleanText(sourceEventId) || `sonic-neighbor-feedback:${anchorIdentityKey}:${candidateIdentityKey}:${timestamp}`;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO sonic_neighbor_feedback (
        anchor_identity_key, candidate_identity_key, anchor_artist, anchor_title,
        candidate_artist, candidate_title, anchor_area, candidate_area, rating, note,
        source_event_id, source_label, model, model_version, created_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      anchorIdentityKey,
      candidateIdentityKey,
      cleanText(anchorTrack.artist),
      cleanText(anchorTrack.title),
      cleanText(candidateTrack.artist),
      cleanText(candidateTrack.title),
      cleanText(anchorArea),
      cleanText(candidateArea || candidateTrack.sonicNeighbor?.selectionArea || candidateTrack.genre || candidateTrack.metadata?.genre),
      normalizedRating,
      cleanText(note),
      eventId,
      cleanText(sourceLabel) || "sonic-neighbor-review",
      cleanModel,
      cleanModelVersion,
      timestamp,
      jsonStringify(rawJson)
    );
    return {
      id: Number(result?.lastInsertRowid || 0),
      inserted: Number(result?.changes || 0) > 0,
      anchorIdentityKey,
      candidateIdentityKey,
      rating: normalizedRating,
      sourceEventId: eventId,
      sourceLabel: cleanText(sourceLabel) || "sonic-neighbor-review",
      globalTasteProfileUpdated: false
    };
  }

  upsertEmbedding({
    track = {},
    identityKey = "",
    vector,
    model = "",
    modelVersion = "",
    sourcePath = "",
    sourceSha256 = "",
    sampleRate = null,
    audioDurationMs = null,
    metadata = {}
  } = {}) {
    if (!this.enabled || !this.db) throw new Error("Sonic embedding storage is disabled.");
    const normalized = normalizeVector(vector);
    if (!normalized.length) throw new Error("A non-empty finite embedding vector is required.");
    const resolvedIdentityKey = cleanText(identityKey) || identityKeyFor(track);
    if (!resolvedIdentityKey) throw new Error("A track identity is required before storing a sonic embedding.");
    const cleanModel = cleanText(model) || "unknown";
    const cleanModelVersion = cleanText(modelVersion) || "1";
    const now = new Date(Number(this.clock())).toISOString();
    const payload = {
      ...metadata,
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      album: cleanText(track.album),
      mixVersion: cleanText(track.mixVersion || track.mixName || track.version),
      tidalId: cleanText(track.tidalId || track.tidalTrackId),
      isrc: cleanText(track.isrc),
      durationMs: Number(track.durationMs || 0) || null,
      sourcePath: cleanText(sourcePath || track.sourcePath)
    };
    this.db.prepare(`
      INSERT INTO track_sonic_profile (
        identity_key, tidal_id, isrc, artist, title, album, mix_version, duration_ms,
        model, model_version, dimensions, embedding_base64, source_path, source_sha256,
        sample_rate, audio_duration_ms, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key, model, model_version) DO UPDATE SET
        tidal_id = COALESCE(NULLIF(excluded.tidal_id, ''), track_sonic_profile.tidal_id),
        isrc = COALESCE(NULLIF(excluded.isrc, ''), track_sonic_profile.isrc),
        artist = COALESCE(NULLIF(excluded.artist, ''), track_sonic_profile.artist),
        title = COALESCE(NULLIF(excluded.title, ''), track_sonic_profile.title),
        album = COALESCE(NULLIF(excluded.album, ''), track_sonic_profile.album),
        mix_version = COALESCE(NULLIF(excluded.mix_version, ''), track_sonic_profile.mix_version),
        duration_ms = COALESCE(excluded.duration_ms, track_sonic_profile.duration_ms),
        dimensions = excluded.dimensions,
        embedding_base64 = excluded.embedding_base64,
        source_path = COALESCE(NULLIF(excluded.source_path, ''), track_sonic_profile.source_path),
        source_sha256 = COALESCE(NULLIF(excluded.source_sha256, ''), track_sonic_profile.source_sha256),
        sample_rate = COALESCE(excluded.sample_rate, track_sonic_profile.sample_rate),
        audio_duration_ms = COALESCE(excluded.audio_duration_ms, track_sonic_profile.audio_duration_ms),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      resolvedIdentityKey,
      payload.tidalId,
      payload.isrc,
      payload.artist,
      payload.title,
      payload.album,
      payload.mixVersion,
      payload.durationMs,
      cleanModel,
      cleanModelVersion,
      normalized.length,
      encodeVector(normalized),
      payload.sourcePath,
      cleanText(sourceSha256),
      Number(sampleRate || 0) || null,
      Number(audioDurationMs || 0) || null,
      jsonStringify(payload),
      now,
      now
    );
    return this.getEmbedding(resolvedIdentityKey, { model: cleanModel, modelVersion: cleanModelVersion });
  }

  getEmbedding(trackOrIdentity, { model = "", modelVersion = "" } = {}) {
    if (!this.enabled || !this.db) return null;
    const identityKey = identityKeyFor(trackOrIdentity);
    if (!identityKey) return null;
    const clauses = ["identity_key = ?"];
    const params = [identityKey];
    if (cleanText(model)) {
      clauses.push("model = ?");
      params.push(cleanText(model));
    }
    if (cleanText(modelVersion)) {
      clauses.push("model_version = ?");
      params.push(cleanText(modelVersion));
    }
    const row = this.db.prepare(`SELECT * FROM track_sonic_profile WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT 1`).get(...params);
    if (!row) return null;
    const vector = decodeVector(row.embedding_base64);
    return {
      id: Number(row.id || 0),
      identityKey: cleanText(row.identity_key),
      model: cleanText(row.model),
      modelVersion: cleanText(row.model_version),
      dimensions: Number(row.dimensions || vector.length),
      vector,
      track: trackFromRow(row),
      sourceSha256: cleanText(row.source_sha256),
      sampleRate: Number(row.sample_rate || 0) || null,
      audioDurationMs: Number(row.audio_duration_ms || 0) || null,
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at)
    };
  }

  listEmbeddings({ model = "", modelVersion = "", limit = 10000 } = {}) {
    if (!this.enabled || !this.db) return [];
    const clauses = [];
    const params = [];
    if (cleanText(model)) {
      clauses.push("model = ?");
      params.push(cleanText(model));
    }
    if (cleanText(modelVersion)) {
      clauses.push("model_version = ?");
      params.push(cleanText(modelVersion));
    }
    const safeLimit = Math.max(1, Math.min(100000, Number(limit) || 10000));
    const rows = this.db.prepare(`SELECT * FROM track_sonic_profile ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id ASC LIMIT ?`).all(...params, safeLimit);
    return rows.map((row) => ({
      id: Number(row.id || 0),
      identityKey: cleanText(row.identity_key),
      model: cleanText(row.model),
      modelVersion: cleanText(row.model_version),
      dimensions: Number(row.dimensions || 0),
      vector: decodeVector(row.embedding_base64),
      track: trackFromRow(row),
      sourceSha256: cleanText(row.source_sha256),
      sampleRate: Number(row.sample_rate || 0) || null,
      audioDurationMs: Number(row.audio_duration_ms || 0) || null,
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at)
    }));
  }

  findNearest({
    track = null,
    vector = null,
    model = "",
    modelVersion = "",
    count = 20,
    excludeIdentityKeys = [],
    minSimilarity = -1,
    includeVector = false
  } = {}) {
    const source = vector === null || vector === undefined ? [] : finiteVector(vector);
    const storedReference = track && (!source.length || !model || !modelVersion) ? this.getEmbedding(track, { model, modelVersion }) : null;
    model = cleanText(model) || storedReference?.model || "";
    modelVersion = cleanText(modelVersion) || storedReference?.modelVersion || "";
    if (!model || !modelVersion) return []; // A naked vector cannot identify its embedding space.
    const reference = source.length ? normalizeVector(source) : normalizeVector(storedReference?.vector || []);
    if (!reference.length) return [];
    const referenceKey = identityKeyFor(track);
    const excluded = new Set((Array.isArray(excludeIdentityKeys) ? excludeIdentityKeys : []).map(cleanText).filter(Boolean));
    if (referenceKey) excluded.add(referenceKey);
    const safeCount = Math.max(1, Math.min(500, Number(count) || 20));
    const rows = this.listEmbeddings({ model, modelVersion, limit: 100000 });
    return rows
      .filter((entry) => !excluded.has(entry.identityKey))
      .map((entry) => ({
        ...entry,
        similarity: cosineSimilarity(reference, entry.vector)
      }))
      .filter((entry) => entry.similarity !== null && entry.similarity >= Number(minSimilarity))
      .sort((left, right) => right.similarity - left.similarity || left.identityKey.localeCompare(right.identityKey))
      .slice(0, safeCount)
      .map((entry) => ({
        identityKey: entry.identityKey,
        model: entry.model,
        modelVersion: entry.modelVersion,
        similarity: Math.round(entry.similarity * 1000000) / 1000000,
        dimensions: entry.dimensions,
        ...(includeVector ? { vector: entry.vector } : {}),
        track: entry.track,
        sourceSha256: entry.sourceSha256,
        sampleRate: entry.sampleRate,
        audioDurationMs: entry.audioDurationMs
      }));
  }
}

module.exports = {
  SCHEMA_VERSION,
  SonicEmbeddingStore,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  identityKeyFor,
  normalizeVector
};
