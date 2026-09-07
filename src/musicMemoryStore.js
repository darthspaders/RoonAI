"use strict";

const fs = require("fs");
const path = require("path");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const SCHEMA_VERSION = 1;
const DEFAULT_BEATPORT_MISSING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

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

function cleanTidalId(value) {
  const text = cleanText(value);
  const match = text.match(/tidal\.com\/(?:browse\/)?track\/(\d+)/i);
  if (match) return match[1];
  return /^\d+$/.test(text) ? text : "";
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

function firstImageUrl(...values) {
  const stack = values.flat().filter(Boolean).map((value) => ({ value, direct: true }));
  const seen = new Set();
  while (stack.length) {
    const { value, direct } = stack.shift();
    if (!value) continue;
    if (typeof value === "string") {
      const text = cleanText(value);
      if (direct && /^https?:\/\//i.test(text)) return text;
      continue;
    }
    if (typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const key of ["imageUrl", "image_url", "sourceImageUrl", "source_image_url", "albumArtUrl", "coverImage", "cover_image"]) {
      if (value[key]) stack.push({ value: value[key], direct: true });
    }
    for (const key of ["image", "images", "cover", "artwork"]) {
      if (Array.isArray(value[key])) stack.push(...value[key].map((item) => ({ value: item, direct: true })));
      else if (value[key]) stack.push({ value: value[key], direct: true });
    }
    for (const key of ["album", "release"]) {
      if (Array.isArray(value[key])) stack.push(...value[key].map((item) => ({ value: item, direct: false })));
      else if (value[key]) stack.push({ value: value[key], direct: false });
    }
    if (direct) {
      for (const key of ["url", "href", "uri"]) {
        if (value[key]) stack.push({ value: value[key], direct: true });
      }
    }
  }
  return "";
}

function normalizeMixVersion(track = {}) {
  return cleanText(track.mixVersion || track.mixName || track.version);
}

function isoTime(value, fallback = Date.now()) {
  const raw = value ?? fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  const text = cleanText(raw);
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return new Date(Number(fallback)).toISOString();
}

function trackIdentityKey(track = {}) {
  const tidalId = cleanTidalId(track.tidalId || track.tidal_id || track.tidalTrackId || track.tidalUrl);
  if (tidalId) return `tidal:${tidalId}`;
  const roonIdentity = cleanText(track.roonIdentity || track.roon_identity || track.queueToken || track.item_key);
  if (roonIdentity) return `roon:${normalizeText(roonIdentity)}`;
  const isrc = cleanIsrc(track.isrc);
  if (isrc) return `isrc:${isrc}`;
  const artist = normalizeText(track.artist);
  const title = normalizeText(track.title);
  const version = normalizeText(normalizeMixVersion(track));
  return artist && title ? `text:${artist}|${title}|${version}` : "";
}

function trackProviderIds(track = {}) {
  const ids = {};
  const add = (key, value) => {
    const text = cleanText(value);
    if (text) ids[key] = text;
  };
  add("tidal", cleanTidalId(track.tidalId || track.tidal_id || track.tidalTrackId || track.tidalUrl || track.tidal?.id || track.tidal?.trackId || track.tidal?.tidalUrl));
  add("beatport", track.beatportTrackId || track.beatport_track_id || track.beatport?.id || track.metadataEnrichment?.beatport?.id);
  add("musicbrainz", track.musicBrainzId || track.musicbrainz_id || track.musicBrainz?.id);
  add("discogs", track.discogsId || track.discogs_id || track.discogs?.id);
  return ids;
}

function entryToBeatportResult(row = null) {
  if (!row) return null;
  if (!cleanText(row.beatport_track_id) && !cleanText(row.genre) && !cleanText(row.subgenre) && !Number(row.bpm || 0)) return null;
  const rawJson = jsonParse(row.raw_json, null);
  return {
    source: "beatport",
    id: cleanText(row.beatport_track_id),
    title: cleanText(row.title),
    mixName: cleanText(row.mix_version),
    artist: cleanText(row.artist),
    artists: jsonParse(row.artist_ids, []).map((id) => ({ id: cleanText(id) })).filter((item) => item.id),
    remixers: jsonParse(row.remixer_ids, []).map((id) => ({ id: cleanText(id) })).filter((item) => item.id),
    album: cleanText(row.release_title),
    label: cleanText(row.label),
    genre: cleanText(row.genre),
    subGenre: cleanText(row.subgenre),
    beatportTags: [row.genre, row.subgenre].map(cleanText).filter(Boolean),
    bpm: Number(row.bpm || 0) > 0 ? Number(row.bpm) : null,
    keyName: cleanText(row.key_name),
    camelot: cleanText(row.camelot),
    releaseDate: cleanText(row.release_date),
    year: cleanText(row.release_date),
    durationMs: Number(row.duration_ms || 0) > 0 ? Number(row.duration_ms) : null,
    isrc: cleanIsrc(row.isrc),
    beatportUrl: cleanText(row.beatport_url),
    releaseId: cleanText(row.release_id),
    rawJson
  };
}

function memoryTrackFromRow(row = {}) {
  const beatportRaw = jsonParse(row.beatport_raw_json, null);
  const providerRaw = jsonParse(row.provider_raw_json, null);
  const providerTags = jsonParse(row.provider_tags, []);
  const providerIds = jsonParse(row.provider_ids, {});
  const imageUrl = firstImageUrl(
    providerRaw?.imageUrl,
    providerRaw?.sourceImageUrl,
    providerRaw?.rawJson?.imageUrl,
    providerRaw?.rawJson?.sourceImageUrl,
    providerRaw?.rawJson?.image,
    providerRaw?.rawJson?.images,
    beatportRaw?.imageUrl,
    beatportRaw?.image,
    beatportRaw?.images,
    beatportRaw?.release?.imageUrl,
    beatportRaw?.release?.image,
    beatportRaw?.release?.images,
    beatportRaw?.release?.cover,
    beatportRaw?.release?.artwork
  );
  const feedbackRatings = cleanText(row.feedback_ratings);
  const latestBeatportStatus = cleanText(row.latest_beatport_status);
  return {
    id: Number(row.id || 0),
    identityKey: cleanText(row.identity_key),
    tidalId: cleanTidalId(row.tidal_id),
    tidalUrl: cleanTidalId(row.tidal_id) ? `https://tidal.com/browse/track/${cleanTidalId(row.tidal_id)}` : "",
    roonIdentity: cleanText(row.roon_identity),
    isrc: cleanIsrc(row.isrc || row.beatport_isrc || row.provider_isrc),
    artist: cleanText(row.artist),
    title: cleanText(row.title),
    mixVersion: cleanText(row.mix_version),
    album: cleanText(row.album || row.beatport_release_title || row.provider_release_title),
    durationMs: Number(row.duration_ms || row.beatport_duration_ms || row.provider_duration_ms || 0) || null,
    firstSeenAt: cleanText(row.first_seen_at),
    lastSeenAt: cleanText(row.last_seen_at),
    observationCount: Number(row.observation_count || 0) || 0,
    latestObservationAt: cleanText(row.latest_observation_at),
    latestObservationSource: cleanText(row.latest_observation_source),
    feedbackCount: Number(row.feedback_count || 0) || 0,
    feedbackRatings: feedbackRatings ? feedbackRatings.split(",").map(cleanText).filter(Boolean) : [],
    beatport: row.beatport_track_id ? {
      id: cleanText(row.beatport_track_id),
      genre: cleanText(row.beatport_genre),
      subGenre: cleanText(row.beatport_subgenre),
      bpm: Number(row.beatport_bpm || 0) || null,
      keyName: cleanText(row.beatport_key_name),
      camelot: cleanText(row.beatport_camelot),
      label: cleanText(row.beatport_label),
      releaseDate: cleanText(row.beatport_release_date),
      releaseId: cleanText(row.beatport_release_id),
      url: cleanText(row.beatport_url),
      fetchedAt: cleanText(row.beatport_fetched_at),
      confidence: Number(row.beatport_confidence || 0) || null
    } : null,
    provider: row.provider ? {
      name: cleanText(row.provider),
      trackId: cleanText(row.provider_track_id),
      genre: cleanText(row.provider_genre),
      subGenre: cleanText(row.provider_subgenre),
      tags: Array.isArray(providerTags) ? providerTags.map(cleanText).filter(Boolean) : [],
      label: cleanText(row.provider_label),
      releaseDate: cleanText(row.provider_release_date),
      releaseId: cleanText(row.provider_release_id),
      fetchedAt: cleanText(row.provider_fetched_at),
      confidence: Number(row.provider_confidence || 0) || null
    } : null,
    providerIds,
    imageUrl,
    beatportMissing: ["missing", "rate_limited", "failed"].includes(latestBeatportStatus),
    beatportRetryAt: cleanText(row.latest_beatport_retry_at),
    latestBeatportStatus
  };
}

class MusicMemoryStore {
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
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.logger?.warn?.("Rabbit Hole music memory disabled", { error: error.message });
      this.enabled = false;
      this.db = null;
    }
  }

  migrate() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS track_identity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_key TEXT NOT NULL UNIQUE,
        tidal_id TEXT,
        roon_identity TEXT,
        isrc TEXT,
        artist TEXT,
        title TEXT,
        mix_version TEXT,
        album TEXT,
        duration_ms INTEGER,
        provider_ids TEXT,
        normalized_artist TEXT,
        normalized_title TEXT,
        normalized_mix_version TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_track_identity_tidal_id ON track_identity(tidal_id);
      CREATE INDEX IF NOT EXISTS idx_track_identity_isrc ON track_identity(isrc);
      CREATE INDEX IF NOT EXISTS idx_track_identity_text ON track_identity(normalized_artist, normalized_title, normalized_mix_version);

      CREATE TABLE IF NOT EXISTS beatport_enrichment (
        track_identity_id INTEGER PRIMARY KEY,
        beatport_track_id TEXT,
        genre TEXT,
        subgenre TEXT,
        bpm REAL,
        key_name TEXT,
        camelot TEXT,
        label TEXT,
        release_title TEXT,
        release_date TEXT,
        release_id TEXT,
        artist_ids TEXT,
        remixer_ids TEXT,
        duration_ms INTEGER,
        isrc TEXT,
        beatport_url TEXT,
        confidence INTEGER,
        fetched_at TEXT NOT NULL,
        raw_json TEXT,
        FOREIGN KEY(track_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS track_observation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_identity_id INTEGER NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        context TEXT,
        observed_at TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        raw_json TEXT,
        FOREIGN KEY(track_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS taste_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_identity_id INTEGER NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        rating TEXT NOT NULL,
        context TEXT,
        source_label TEXT,
        prompt TEXT,
        score REAL,
        calibration_issue TEXT,
        created_at TEXT NOT NULL,
        raw_json TEXT,
        FOREIGN KEY(track_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_enrichment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_identity_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        provider_track_id TEXT,
        genre TEXT,
        subgenre TEXT,
        tags TEXT,
        bpm REAL,
        key_name TEXT,
        camelot TEXT,
        label TEXT,
        release_title TEXT,
        release_date TEXT,
        release_id TEXT,
        duration_ms INTEGER,
        isrc TEXT,
        confidence INTEGER,
        fetched_at TEXT NOT NULL,
        raw_json TEXT,
        FOREIGN KEY(track_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_provider_enrichment_track_provider ON provider_enrichment(track_identity_id, provider);

      CREATE TABLE IF NOT EXISTS enrichment_attempt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_identity_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        source_event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        confidence INTEGER,
        fetched_at TEXT NOT NULL,
        next_retry_at TEXT,
        error TEXT,
        raw_json TEXT,
        FOREIGN KEY(track_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE
      );
    `);
    this.addColumnIfMissing("track_identity", "album", "TEXT");
    this.addColumnIfMissing("track_identity", "duration_ms", "INTEGER");
    this.addColumnIfMissing("track_identity", "provider_ids", "TEXT");
    this.addColumnIfMissing("track_observation", "source_event_id", "TEXT");
    this.addColumnIfMissing("track_observation", "context", "TEXT");
    this.addColumnIfMissing("track_observation", "count", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("track_observation", "raw_json", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_track_observation_event ON track_observation(source_event_id)");
    this.db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    if (!this.enabled || !this.db) return { enabled: false, dbFile: this.dbFile };
    const trackCount = this.db.prepare("SELECT COUNT(*) AS count FROM track_identity").get()?.count || 0;
    const beatportCount = this.db.prepare("SELECT COUNT(*) AS count FROM beatport_enrichment").get()?.count || 0;
    const observationCount = this.db.prepare("SELECT COUNT(*) AS count FROM track_observation").get()?.count || 0;
    const feedbackCount = this.db.prepare("SELECT COUNT(*) AS count FROM taste_feedback").get()?.count || 0;
    const providerEnrichmentCount = this.db.prepare("SELECT COUNT(*) AS count FROM provider_enrichment").get()?.count || 0;
    const enrichmentAttemptCount = this.db.prepare("SELECT COUNT(*) AS count FROM enrichment_attempt").get()?.count || 0;
    const beatportMissingCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM enrichment_attempt ea
      WHERE ea.provider = 'beatport'
        AND ea.status IN ('missing', 'rate_limited', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM enrichment_attempt newer
          WHERE newer.track_identity_id = ea.track_identity_id
            AND newer.provider = ea.provider
            AND (newer.fetched_at > ea.fetched_at OR (newer.fetched_at = ea.fetched_at AND newer.id > ea.id))
        )
        AND NOT EXISTS (
          SELECT 1 FROM beatport_enrichment be
          WHERE be.track_identity_id = ea.track_identity_id
        )
    `).get()?.count || 0;
    const beatportRetryBlockedCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM enrichment_attempt ea
      WHERE ea.provider = 'beatport'
        AND ea.status IN ('missing', 'rate_limited', 'failed')
        AND ea.next_retry_at IS NOT NULL
        AND ea.next_retry_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM enrichment_attempt newer
          WHERE newer.track_identity_id = ea.track_identity_id
            AND newer.provider = ea.provider
            AND (newer.fetched_at > ea.fetched_at OR (newer.fetched_at = ea.fetched_at AND newer.id > ea.id))
        )
        AND NOT EXISTS (
          SELECT 1 FROM beatport_enrichment be
          WHERE be.track_identity_id = ea.track_identity_id
        )
    `).get(new Date(Number(this.clock())).toISOString())?.count || 0;
    return {
      enabled: true,
      dbFile: this.dbFile,
      schemaVersion: SCHEMA_VERSION,
      trackCount,
      beatportCount,
      observationCount,
      feedbackCount,
      providerEnrichmentCount,
      enrichmentAttemptCount,
      beatportMissingCount,
      beatportRetryBlockedCount
    };
  }

  upsertTrackIdentity(track = {}) {
    if (!this.enabled || !this.db) return null;
    const identityKey = trackIdentityKey(track);
    if (!identityKey) return null;
    const now = new Date(Number(this.clock())).toISOString();
    const firstSeenAt = isoTime(track.firstSeenAt || track.observedAt || track.updatedAt, this.clock());
    const lastSeenAt = isoTime(track.lastSeenAt || track.observedAt || track.updatedAt, this.clock());
    const payload = {
      identityKey,
      tidalId: cleanTidalId(track.tidalId || track.tidal_id || track.tidalTrackId || track.tidalUrl),
      roonIdentity: cleanText(track.roonIdentity || track.roon_identity || track.queueToken || track.item_key),
      isrc: cleanIsrc(track.isrc),
      artist: cleanText(track.artist),
      title: cleanText(track.title),
      mixVersion: normalizeMixVersion(track),
      album: cleanText(track.album || track.release || track.releaseTitle || track.tidal?.album),
      durationMs: Number(track.durationMs || track.duration_ms || track.lengthMs || track.tidal?.durationMs || 0) || null,
      providerIds: jsonStringify(trackProviderIds(track)),
      normalizedArtist: normalizeText(track.artist),
      normalizedTitle: normalizeText(track.title),
      normalizedMixVersion: normalizeText(normalizeMixVersion(track))
    };
    this.db.prepare(`
      INSERT INTO track_identity (
        identity_key, tidal_id, roon_identity, isrc, artist, title, mix_version, album, duration_ms, provider_ids,
        normalized_artist, normalized_title, normalized_mix_version, first_seen_at, last_seen_at, observation_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(identity_key) DO UPDATE SET
        tidal_id = COALESCE(NULLIF(excluded.tidal_id, ''), track_identity.tidal_id),
        roon_identity = COALESCE(NULLIF(excluded.roon_identity, ''), track_identity.roon_identity),
        isrc = COALESCE(NULLIF(excluded.isrc, ''), track_identity.isrc),
        artist = COALESCE(NULLIF(excluded.artist, ''), track_identity.artist),
        title = COALESCE(NULLIF(excluded.title, ''), track_identity.title),
        mix_version = COALESCE(NULLIF(excluded.mix_version, ''), track_identity.mix_version),
        album = COALESCE(NULLIF(excluded.album, ''), track_identity.album),
        duration_ms = COALESCE(excluded.duration_ms, track_identity.duration_ms),
        provider_ids = COALESCE(NULLIF(excluded.provider_ids, '{}'), track_identity.provider_ids),
        normalized_artist = COALESCE(NULLIF(excluded.normalized_artist, ''), track_identity.normalized_artist),
        normalized_title = COALESCE(NULLIF(excluded.normalized_title, ''), track_identity.normalized_title),
        normalized_mix_version = COALESCE(NULLIF(excluded.normalized_mix_version, ''), track_identity.normalized_mix_version),
        first_seen_at = MIN(track_identity.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(track_identity.last_seen_at, excluded.last_seen_at)
    `).run(
      payload.identityKey,
      payload.tidalId,
      payload.roonIdentity,
      payload.isrc,
      payload.artist,
      payload.title,
      payload.mixVersion,
      payload.album,
      payload.durationMs,
      payload.providerIds,
      payload.normalizedArtist,
      payload.normalizedTitle,
      payload.normalizedMixVersion,
      firstSeenAt || now,
      lastSeenAt || now
    );
    return this.db.prepare("SELECT * FROM track_identity WHERE identity_key = ?").get(identityKey);
  }

  rememberObservation(track = {}, source = "metadata_enrichment", options = {}) {
    const observedAt = isoTime(options.observedAt ?? track.observedAt ?? track.lastSeenAt ?? track.updatedAt, this.clock());
    const identity = this.upsertTrackIdentity({ ...track, observedAt });
    if (!identity?.id || !this.db) return null;
    const sourceEventId = cleanText(options.sourceEventId) || `${cleanText(source) || "unknown"}:${identity.identity_key}:${observedAt}`;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO track_observation (track_identity_id, source_event_id, source, context, observed_at, count, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.id,
      sourceEventId,
      cleanText(source) || "unknown",
      cleanText(options.context),
      observedAt,
      Math.max(1, Number(options.count || 1) || 1),
      options.rawJson ? jsonStringify(options.rawJson) : null
    );
    if (result.changes) {
      this.db.prepare("UPDATE track_identity SET observation_count = observation_count + ?, last_seen_at = ? WHERE id = ?").run(
        Math.max(1, Number(options.count || 1) || 1),
        observedAt,
        identity.id
      );
    }
    return identity;
  }

  saveTasteFeedback(track = {}, feedback = {}) {
    const createdAt = isoTime(feedback.createdAt || feedback.updatedAt || feedback.recordedAt, this.clock());
    const identity = this.upsertTrackIdentity({ ...track, observedAt: createdAt });
    if (!identity?.id || !this.db) return null;
    const sourceEventId = cleanText(feedback.sourceEventId) || `feedback:${identity.identity_key}:${createdAt}:${cleanText(feedback.rating)}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO taste_feedback (
        track_identity_id, source_event_id, rating, context, source_label, prompt, score,
        calibration_issue, created_at, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.id,
      sourceEventId,
      cleanText(feedback.rating),
      cleanText(feedback.context),
      cleanText(feedback.sourceLabel || feedback.source || feedback.discoverySource),
      cleanText(feedback.prompt || feedback.request),
      Number(feedback.score || 0) || null,
      cleanText(feedback.calibrationIssue || feedback.calibration?.issue),
      createdAt,
      jsonStringify(feedback.rawJson || feedback)
    );
    return identity;
  }

  saveProviderEnrichment(track = {}, provider = "", enrichment = {}) {
    const fetchedAt = isoTime(enrichment.fetchedAt || enrichment.updatedAt || enrichment.recordedAt, this.clock());
    const identity = this.upsertTrackIdentity({ ...track, observedAt: fetchedAt });
    if (!identity?.id || !this.db) return null;
    const cleanProvider = cleanText(provider || enrichment.provider || enrichment.source);
    const sourceEventId = cleanText(enrichment.sourceEventId) || `enrichment:${cleanProvider}:${identity.identity_key}:${fetchedAt}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO provider_enrichment (
        track_identity_id, provider, source_event_id, provider_track_id, genre, subgenre, tags,
        bpm, key_name, camelot, label, release_title, release_date, release_id,
        duration_ms, isrc, confidence, fetched_at, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.id,
      cleanProvider,
      sourceEventId,
      cleanText(enrichment.providerTrackId || enrichment.id || enrichment.trackId),
      cleanText(enrichment.genre),
      cleanText(enrichment.subGenre || enrichment.subgenre),
      jsonStringify(enrichment.tags || enrichment.beatportTags || enrichment.musicBrainzTags || []),
      Number(enrichment.bpm || 0) || null,
      cleanText(enrichment.keyName),
      cleanText(enrichment.camelot),
      cleanText(enrichment.label),
      cleanText(enrichment.album || enrichment.releaseTitle),
      cleanText(enrichment.releaseDate || enrichment.date),
      cleanText(enrichment.releaseId),
      Number(enrichment.durationMs || 0) || null,
      cleanIsrc(enrichment.isrc),
      Number(enrichment.confidence || 0) || null,
      fetchedAt,
      jsonStringify(enrichment.rawJson || enrichment)
    );
    return identity;
  }

  saveEnrichmentAttempt(track = {}, provider = "", attempt = {}) {
    const fetchedAt = isoTime(attempt.fetchedAt || attempt.updatedAt || attempt.recordedAt, this.clock());
    const identity = this.upsertTrackIdentity({ ...track, observedAt: fetchedAt });
    if (!identity?.id || !this.db) return null;
    const cleanProvider = cleanText(provider || attempt.provider || attempt.source);
    const sourceEventId = cleanText(attempt.sourceEventId) || `attempt:${cleanProvider}:${identity.identity_key}:${fetchedAt}:${cleanText(attempt.status)}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO enrichment_attempt (
        track_identity_id, provider, source_event_id, status, confidence, fetched_at, next_retry_at, error, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.id,
      cleanProvider,
      sourceEventId,
      cleanText(attempt.status),
      Number(attempt.confidence || 0) || null,
      fetchedAt,
      attempt.nextRetryAt ? isoTime(attempt.nextRetryAt, this.clock()) : null,
      cleanText(attempt.error || attempt.reason),
      jsonStringify(attempt.rawJson || attempt)
    );
    return identity;
  }

  findBeatportEnrichment(track = {}) {
    const identityKey = trackIdentityKey(track);
    if (!this.enabled || !this.db || !identityKey) return null;
    const row = this.db.prepare(`
      SELECT be.*, ti.artist, ti.title, ti.mix_version
      FROM track_identity ti
      JOIN beatport_enrichment be ON be.track_identity_id = ti.id
      WHERE ti.identity_key = ?
    `).get(identityKey);
    return entryToBeatportResult(row);
  }

  latestEnrichmentAttempt(track = {}, provider = "") {
    const identityKey = trackIdentityKey(track);
    const cleanProvider = cleanText(provider).toLowerCase();
    if (!this.enabled || !this.db || !identityKey || !cleanProvider) return null;
    return this.db.prepare(`
      SELECT ea.*
      FROM track_identity ti
      JOIN enrichment_attempt ea ON ea.track_identity_id = ti.id
      WHERE ti.identity_key = ?
        AND ea.provider = ?
      ORDER BY ea.fetched_at DESC, ea.id DESC
      LIMIT 1
    `).get(identityKey, cleanProvider) || null;
  }

  beatportLookupBlocked(track = {}, now = this.clock()) {
    const attempt = this.latestEnrichmentAttempt(track, "beatport");
    if (!attempt || !["missing", "rate_limited", "failed"].includes(cleanText(attempt.status))) return false;
    const nextRetryMs = Date.parse(attempt.next_retry_at || "");
    return Number.isFinite(nextRetryMs) && nextRetryMs > Number(now);
  }

  searchTracks({
    q = "",
    beatport = "",
    feedback = "",
    provider = "",
    limit = 50,
    offset = 0
  } = {}) {
    if (!this.enabled || !this.db) return {
      enabled: false,
      tracks: [],
      total: 0,
      limit: 0,
      offset: 0
    };
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const clauses = ["ti.artist <> ''", "ti.title <> ''"];
    const params = [];
    const query = cleanText(q);
    if (query) {
      const like = `%${query}%`;
      clauses.push(`(
        ti.artist LIKE ? OR ti.title LIKE ? OR ti.album LIKE ? OR ti.tidal_id LIKE ? OR ti.isrc LIKE ?
        OR be.beatport_track_id LIKE ? OR be.genre LIKE ? OR be.subgenre LIKE ? OR be.label LIKE ?
        OR pe.provider_track_id LIKE ? OR pe.genre LIKE ? OR pe.subgenre LIKE ? OR pe.label LIKE ? OR pe.tags LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like, like, like, like, like, like, like);
    }
    if (beatport === "has") clauses.push("be.track_identity_id IS NOT NULL");
    if (beatport === "missing") clauses.push("be.track_identity_id IS NULL");
    if (beatport === "retry-blocked") clauses.push("lba.status IN ('missing', 'rate_limited', 'failed') AND lba.next_retry_at > ?");
    if (beatport === "retry-blocked") params.push(new Date(Number(this.clock())).toISOString());
    const cleanProvider = cleanText(provider).toLowerCase();
    if (cleanProvider) {
      clauses.push("LOWER(pe.provider) = ?");
      params.push(cleanProvider);
    }
    const cleanFeedback = cleanText(feedback).toLowerCase();
    if (cleanFeedback === "any") clauses.push("tf.feedback_count > 0");
    else if (cleanFeedback) {
      clauses.push("EXISTS (SELECT 1 FROM taste_feedback fb WHERE fb.track_identity_id = ti.id AND LOWER(fb.rating) = ?)");
      params.push(cleanFeedback);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const fromSql = `
      FROM track_identity ti
      LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
      LEFT JOIN (
        SELECT provider_enrichment.*
        FROM provider_enrichment
        JOIN (
          SELECT track_identity_id, provider, MAX(fetched_at) AS fetched_at
          FROM provider_enrichment
          GROUP BY track_identity_id, provider
        ) latest ON latest.track_identity_id = provider_enrichment.track_identity_id
          AND latest.provider = provider_enrichment.provider
          AND latest.fetched_at = provider_enrichment.fetched_at
      ) pe ON pe.track_identity_id = ti.id
      LEFT JOIN (
        SELECT track_identity_id, MAX(observed_at) AS latest_observation_at
        FROM track_observation
        GROUP BY track_identity_id
      ) lo ON lo.track_identity_id = ti.id
      LEFT JOIN track_observation los ON los.track_identity_id = ti.id AND los.observed_at = lo.latest_observation_at
      LEFT JOIN (
        SELECT track_identity_id, COUNT(*) AS feedback_count, GROUP_CONCAT(DISTINCT rating) AS feedback_ratings
        FROM taste_feedback
        GROUP BY track_identity_id
      ) tf ON tf.track_identity_id = ti.id
      LEFT JOIN (
        SELECT enrichment_attempt.*
        FROM enrichment_attempt
        JOIN (
          SELECT track_identity_id, provider, MAX(fetched_at || ':' || printf('%010d', id)) AS latest_key
          FROM enrichment_attempt
          WHERE provider = 'beatport'
          GROUP BY track_identity_id, provider
        ) latest ON latest.track_identity_id = enrichment_attempt.track_identity_id
          AND latest.provider = enrichment_attempt.provider
          AND latest.latest_key = enrichment_attempt.fetched_at || ':' || printf('%010d', enrichment_attempt.id)
      ) lba ON lba.track_identity_id = ti.id
      ${where}
    `;
    const total = this.db.prepare(`SELECT COUNT(DISTINCT ti.id) AS count ${fromSql}`).get(...params)?.count || 0;
    const rows = this.db.prepare(`
      SELECT
        ti.*,
        be.beatport_track_id,
        be.genre AS beatport_genre,
        be.subgenre AS beatport_subgenre,
        be.bpm AS beatport_bpm,
        be.key_name AS beatport_key_name,
        be.camelot AS beatport_camelot,
        be.label AS beatport_label,
        be.release_title AS beatport_release_title,
        be.release_date AS beatport_release_date,
        be.release_id AS beatport_release_id,
        be.duration_ms AS beatport_duration_ms,
        be.isrc AS beatport_isrc,
        be.beatport_url,
        be.confidence AS beatport_confidence,
        be.fetched_at AS beatport_fetched_at,
        be.raw_json AS beatport_raw_json,
        pe.provider,
        pe.provider_track_id,
        pe.genre AS provider_genre,
        pe.subgenre AS provider_subgenre,
        pe.tags AS provider_tags,
        pe.label AS provider_label,
        pe.release_title AS provider_release_title,
        pe.release_date AS provider_release_date,
        pe.release_id AS provider_release_id,
        pe.duration_ms AS provider_duration_ms,
        pe.isrc AS provider_isrc,
        pe.confidence AS provider_confidence,
        pe.fetched_at AS provider_fetched_at,
        pe.raw_json AS provider_raw_json,
        lo.latest_observation_at,
        los.source AS latest_observation_source,
        tf.feedback_count,
        tf.feedback_ratings,
        lba.status AS latest_beatport_status,
        lba.next_retry_at AS latest_beatport_retry_at
      ${fromSql}
      GROUP BY ti.id
      ORDER BY ti.last_seen_at DESC, ti.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    return {
      enabled: true,
      q: query,
      beatport,
      feedback,
      provider: cleanProvider,
      total: Number(total || 0),
      limit: safeLimit,
      offset: safeOffset,
      tracks: rows.map(memoryTrackFromRow)
    };
  }

  saveBeatportEnrichment(track = {}, result = {}, { confidence = 0 } = {}) {
    if (!this.enabled || !this.db || !result) return null;
    const identity = this.upsertTrackIdentity({
      ...track,
      isrc: track.isrc || result.isrc,
      artist: track.artist || result.artist,
      title: track.title || result.title,
      mixVersion: track.mixVersion || result.mixName
    });
    if (!identity?.id) return null;
    const fetchedAt = new Date(Number(this.clock())).toISOString();
    const release = result.rawJson?.release && typeof result.rawJson.release === "object" ? result.rawJson.release : {};
    const artistIds = Array.isArray(result.artistIds)
      ? result.artistIds.map(cleanText).filter(Boolean)
      : Array.isArray(result.artists)
        ? result.artists.map((artist) => cleanText(artist.id || artist.artist_id)).filter(Boolean)
        : [];
    const remixerIds = Array.isArray(result.remixerIds)
      ? result.remixerIds.map(cleanText).filter(Boolean)
      : Array.isArray(result.remixers)
        ? result.remixers.map((artist) => cleanText(artist.id || artist.artist_id)).filter(Boolean)
        : [];
    this.db.prepare(`
      INSERT INTO beatport_enrichment (
        track_identity_id, beatport_track_id, genre, subgenre, bpm, key_name, camelot,
        label, release_title, release_date, release_id, artist_ids, remixer_ids,
        duration_ms, isrc, beatport_url, confidence, fetched_at, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_identity_id) DO UPDATE SET
        beatport_track_id = excluded.beatport_track_id,
        genre = excluded.genre,
        subgenre = excluded.subgenre,
        bpm = excluded.bpm,
        key_name = excluded.key_name,
        camelot = excluded.camelot,
        label = excluded.label,
        release_title = excluded.release_title,
        release_date = excluded.release_date,
        release_id = excluded.release_id,
        artist_ids = excluded.artist_ids,
        remixer_ids = excluded.remixer_ids,
        duration_ms = excluded.duration_ms,
        isrc = excluded.isrc,
        beatport_url = excluded.beatport_url,
        confidence = excluded.confidence,
        fetched_at = excluded.fetched_at,
        raw_json = excluded.raw_json
    `).run(
      identity.id,
      cleanText(result.id || result.beatportTrackId),
      cleanText(result.genre),
      cleanText(result.subGenre),
      Number(result.bpm || 0) || null,
      cleanText(result.keyName),
      cleanText(result.camelot),
      cleanText(result.label),
      cleanText(result.album || result.releaseTitle),
      cleanText(result.releaseDate),
      cleanText(result.releaseId || release.id),
      jsonStringify(artistIds),
      jsonStringify(remixerIds),
      Number(result.durationMs || 0) || null,
      cleanIsrc(result.isrc),
      cleanText(result.beatportUrl),
      Number(confidence || result.confidence || 0) || 0,
      fetchedAt,
      jsonStringify(result.rawJson || result)
    );
    return this.findBeatportEnrichment(track);
  }

  tracksMissingBeatportEnrichment(limit = 50) {
    if (!this.enabled || !this.db) return [];
    const now = new Date(Number(this.clock())).toISOString();
    return this.db.prepare(`
      SELECT ti.*
      FROM track_identity ti
      LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
      WHERE be.track_identity_id IS NULL
        AND ti.artist <> ''
        AND ti.title <> ''
        AND NOT EXISTS (
          SELECT 1 FROM enrichment_attempt ea
          WHERE ea.track_identity_id = ti.id
            AND ea.provider = 'beatport'
            AND ea.status IN ('missing', 'rate_limited', 'failed')
            AND ea.next_retry_at IS NOT NULL
            AND ea.next_retry_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM enrichment_attempt newer
              WHERE newer.track_identity_id = ea.track_identity_id
                AND newer.provider = ea.provider
                AND (newer.fetched_at > ea.fetched_at OR (newer.fetched_at = ea.fetched_at AND newer.id > ea.id))
            )
        )
      ORDER BY ti.last_seen_at DESC
      LIMIT ?
    `).all(now, Math.max(1, Math.min(500, Number(limit) || 50))).map((row) => ({
      tidalId: cleanTidalId(row.tidal_id),
      roonIdentity: cleanText(row.roon_identity),
      isrc: cleanIsrc(row.isrc),
      artist: cleanText(row.artist),
      title: cleanText(row.title),
      mixName: cleanText(row.mix_version),
      album: cleanText(row.album),
      durationMs: Number(row.duration_ms || 0) || null
    }));
  }
}

module.exports = {
  DEFAULT_BEATPORT_MISSING_RETRY_MS,
  MusicMemoryStore,
  cleanIsrc,
  cleanTidalId,
  normalizeText,
  trackIdentityKey
};
