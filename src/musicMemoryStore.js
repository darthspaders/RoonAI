"use strict";

const fs = require("fs");
const path = require("path");
const { parseCanonicalCatalogIdentity } = require("./catalogIdentityNormalization");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const SCHEMA_VERSION = 3;
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

function normalizedTokens(value) {
  return Array.from(new Set(normalizeText(value).split(" ").filter(Boolean)));
}

function normalizedIdentityTitle(value) {
  return normalizeText(value)
    .replace(/\b(?:original|main|extended|radio|club|instrumental|mix|version|edit|remix|rework|dub|live|acoustic|unplugged)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactIdentityArtist(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function tokenSubset(smaller = [], larger = []) {
  const largerSet = new Set(larger);
  return smaller.length > 0 && smaller.every((token) => largerSet.has(token));
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
    playCount: Number(row.play_count || 0) || 0,
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
      this.db.exec("PRAGMA busy_timeout = 10000");
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
      CREATE INDEX IF NOT EXISTS idx_track_identity_normalized_title ON track_identity(normalized_title);
      CREATE INDEX IF NOT EXISTS idx_track_identity_artist_folded ON track_identity(LOWER(TRIM(artist)));

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

      CREATE INDEX IF NOT EXISTS idx_beatport_enrichment_label_time
        ON beatport_enrichment(LOWER(TRIM(label)), fetched_at DESC);

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

      CREATE INDEX IF NOT EXISTS idx_track_observation_track_source
        ON track_observation(track_identity_id, source);

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

      CREATE INDEX IF NOT EXISTS idx_taste_feedback_track_id_rating
        ON taste_feedback(track_identity_id, id DESC, rating);

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

      -- Status snapshots check the latest attempt per track/provider. Without
      -- this index, their correlated lookups block the Roon heartbeat as history grows.
      CREATE INDEX IF NOT EXISTS idx_enrichment_attempt_track_provider_time
        ON enrichment_attempt(track_identity_id, provider, fetched_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS sonic_analysis_request (
        track_identity_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        policy TEXT NOT NULL,
        required_source TEXT,
        beatport_track_id TEXT,
        source_audio_type TEXT,
        source_match_type TEXT,
        confidence INTEGER,
        reason TEXT,
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        fulfilled_at TEXT,
        raw_json TEXT,
        FOREIGN KEY(track_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS track_identity_alias (
        alias_identity_id INTEGER PRIMARY KEY,
        canonical_identity_id INTEGER NOT NULL,
        relation TEXT NOT NULL,
        confidence INTEGER,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(alias_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE,
        FOREIGN KEY(canonical_identity_id) REFERENCES track_identity(id) ON DELETE CASCADE,
        CHECK(alias_identity_id <> canonical_identity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_track_identity_alias_canonical
        ON track_identity_alias(canonical_identity_id);

      CREATE INDEX IF NOT EXISTS idx_sonic_analysis_request_status
        ON sonic_analysis_request(status, updated_at);
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
    this.reclassifyDeterministicSonicFailures();
  }

  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  reclassifyDeterministicSonicFailures() {
    if (!this.enabled || !this.db) return;
    this.db.prepare(`
      UPDATE sonic_analysis_request
      SET status = 'NEEDS_LOCAL_FILE',
          required_source = 'local_file',
          source_audio_type = '',
          source_match_type = 'BEATPORT_MATCH_REJECTED',
          reason = 'Previous Beatport candidate rejection was deterministic; local file required: ' || reason
      WHERE status = 'ANALYSIS_FAILED'
        AND (
          reason LIKE '%Beatport candidate was rejected%'
          OR reason LIKE '%artist credits do not match exactly%'
          OR reason LIKE '%base titles do not match%'
          OR reason LIKE '%Beatport track ID does not match%'
          OR raw_json LIKE '%Beatport candidate was rejected%'
        )
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
    if (!this.enabled || !this.db) return { enabled: false, dbFile: this.dbFile };
    const trackCount = this.db.prepare("SELECT COUNT(*) AS count FROM track_identity").get()?.count || 0;
    const beatportCount = this.db.prepare("SELECT COUNT(*) AS count FROM beatport_enrichment").get()?.count || 0;
    const observationCount = this.db.prepare("SELECT COUNT(*) AS count FROM track_observation").get()?.count || 0;
    const feedbackCount = this.db.prepare("SELECT COUNT(*) AS count FROM taste_feedback").get()?.count || 0;
    const providerEnrichmentCount = this.db.prepare("SELECT COUNT(*) AS count FROM provider_enrichment").get()?.count || 0;
    const enrichmentAttemptCount = this.db.prepare("SELECT COUNT(*) AS count FROM enrichment_attempt").get()?.count || 0;
    const sonicAnalysisRequestCount = this.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request").get()?.count || 0;
    const sonicNeedsLocalFileCount = this.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request WHERE status = 'NEEDS_LOCAL_FILE'").get()?.count || 0;
    const sonicAnalyzedCount = this.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request WHERE status LIKE 'ANALYZED%'").get()?.count || 0;
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
      sonicAnalysisRequestCount,
      sonicNeedsLocalFileCount,
      sonicAnalyzedCount,
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

  findValidatedTidalIdentities(track = {}, { limit = 24 } = {}) {
    if (!this.enabled || !this.db) return [];
    const requestedTitle = normalizedIdentityTitle(track.title || track.name);
    const requestedArtist = compactIdentityArtist(track.artist);
    if (!requestedTitle || !requestedArtist) return [];

    // This is intentionally a narrow lookup. It only returns identities that
    // already have a TIDAL id; the shared TIDAL identity scorer remains the
    // authority that decides whether a prior identity is safe to reuse.
    const rows = this.db.prepare(`
      SELECT
        ti.*,
        (
          SELECT pe.release_date
          FROM provider_enrichment pe
          WHERE pe.track_identity_id = ti.id
          ORDER BY pe.fetched_at DESC, pe.id DESC
          LIMIT 1
        ) AS provider_release_date,
        (
          SELECT pe.raw_json
          FROM provider_enrichment pe
          WHERE pe.track_identity_id = ti.id
          ORDER BY pe.fetched_at DESC, pe.id DESC
          LIMIT 1
        ) AS provider_raw_json,
        (
          SELECT be.release_date
          FROM beatport_enrichment be
          WHERE be.track_identity_id = ti.id
          LIMIT 1
        ) AS beatport_release_date
      FROM track_identity ti
      WHERE ti.tidal_id IS NOT NULL
        AND ti.tidal_id <> ''
        AND (
          ti.normalized_title = ?
          OR ti.normalized_title LIKE ?
          OR ? LIKE ti.normalized_title || '%'
        )
      ORDER BY ti.observation_count DESC, ti.last_seen_at DESC, ti.id DESC
      LIMIT ?
    `).all(
      requestedTitle,
      `${requestedTitle}%`,
      requestedTitle,
      Math.max(1, Math.min(100, Number(limit) || 24))
    );

    const requestedTitleTokens = new Set(requestedTitle.split(" ").filter(Boolean));
    return rows.map((row) => {
      const rootId = this.canonicalTrackIdentityId(row.id) || Number(row.id);
      const root = rootId && rootId !== Number(row.id)
        ? this.db.prepare("SELECT * FROM track_identity WHERE id = ? LIMIT 1").get(rootId)
        : row;
      const candidate = memoryTrackFromRow({
        ...(root || row),
        provider_release_date: row.provider_release_date,
        provider_raw_json: row.provider_raw_json,
        beatport_release_date: row.beatport_release_date
      });
      const candidateTitle = normalizedIdentityTitle(candidate.title);
      const candidateTitleTokens = new Set(candidateTitle.split(" ").filter(Boolean));
      const candidateArtist = compactIdentityArtist(candidate.artist);
      const titleMatches = candidateTitle === requestedTitle
        || candidateTitle.startsWith(`${requestedTitle} `)
        || requestedTitle.startsWith(`${candidateTitle} `);
      const artistMatches = candidateArtist === requestedArtist
        || candidateArtist.includes(requestedArtist)
        || requestedArtist.includes(candidateArtist);
      if (!titleMatches || !artistMatches || !requestedTitleTokens.size || !candidateTitleTokens.size) return null;
      const providerRaw = jsonParse(row.provider_raw_json, null) || {};
      const releaseDate = cleanText(
        row.provider_release_date ||
        row.beatport_release_date ||
        providerRaw.releaseDate || providerRaw.release_date ||
        providerRaw.albumYear || providerRaw.releaseYear
      );
      return {
        ...candidate,
        releaseDate,
        releaseYear: releaseDate,
        year: releaseDate,
        validatedIdentitySource: "music-memory-track-identity",
        validatedIdentityKey: cleanText(row.identity_key),
        validatedIdentityCanonicalKey: cleanText(root?.identity_key || row.identity_key),
        validatedObservationCount: Number(row.observation_count || 0) || 0
      };
    }).filter(Boolean);
  }

  canonicalTrackIdentityId(identityId) {
    if (!this.enabled || !this.db || !identityId) return Number(identityId || 0) || null;
    let currentId = Number(identityId) || 0;
    const visited = new Set();
    for (let depth = 0; currentId && depth < 8 && !visited.has(currentId); depth += 1) {
      visited.add(currentId);
      const link = this.db.prepare("SELECT canonical_identity_id FROM track_identity_alias WHERE alias_identity_id = ?").get(currentId);
      const nextId = Number(link?.canonical_identity_id || 0) || 0;
      if (!nextId || nextId === currentId) break;
      currentId = nextId;
    }
    return currentId || null;
  }

  findReversedRoonTrack(track = {}) {
    if (!this.enabled || !this.db) return null;
    const rawArtist = normalizeText(track.artist);
    const rawTitle = normalizeText(track.title);
    if (!rawArtist || !rawTitle) return null;

    // Roon's normal now-playing shape is title in two_line.line1 and artist
    // in two_line.line2. Some integrations occasionally deliver those fields
    // reversed. Only repair that case when the observed artist is an exact
    // match for a known TIDAL title and the observed title contains every
    // token of that track's known artist credit. This deliberately fails
    // closed when the evidence is ambiguous.
    const candidates = this.db.prepare(`
      SELECT ti.*
      FROM track_identity ti
      WHERE ti.tidal_id IS NOT NULL
        AND ti.tidal_id <> ''
        AND ti.normalized_title = ?
    `).all(rawArtist)
      .filter((row) => tokenSubset(normalizedTokens(row.normalized_artist), normalizedTokens(rawTitle)));
    if (!candidates.length) return null;

    const roots = new Map();
    for (const row of candidates) {
      const rootId = this.canonicalTrackIdentityId(row.id) || Number(row.id);
      if (!roots.has(rootId)) roots.set(rootId, row);
    }
    if (roots.size !== 1) return null;

    const row = Array.from(roots.values())[0];
    const canonicalId = this.canonicalTrackIdentityId(row.id) || Number(row.id);
    const canonicalRow = this.db.prepare("SELECT * FROM track_identity WHERE id = ? LIMIT 1").get(canonicalId);
    return canonicalRow || row;
  }

  reconcileReversedRoonTrack(track = {}) {
    if (!this.enabled || !this.db) return null;
    if (cleanTidalId(track.tidalId || track.tidal_id || track.tidalTrackId || track.tidalUrl)) return null;
    const canonicalRow = this.findReversedRoonTrack(track);
    if (!canonicalRow?.tidal_id) return null;
    const result = this.linkTrackIdentity(
      track,
      memoryTrackFromRow(canonicalRow),
      {
        relation: "REVERSED_ROON_METADATA",
        confidence: 99,
        source: "music_memory_identity_reconciliation",
        updatedAt: track.observedAt || track.updatedAt || ""
      }
    );
    if (!result || result.conflict) return null;
    return {
      ...result,
      canonicalTrack: memoryTrackFromRow(canonicalRow)
    };
  }

  linkTrackIdentity(aliasTrack = {}, canonicalTrack = {}, {
    relation = "CANONICAL_TIDAL",
    confidence = null,
    source = "metadata_enrichment",
    updatedAt = ""
  } = {}) {
    if (!this.enabled || !this.db) return null;
    const alias = this.upsertTrackIdentity({ ...aliasTrack, observedAt: updatedAt || undefined });
    const canonical = this.upsertTrackIdentity({ ...canonicalTrack, observedAt: updatedAt || undefined });
    if (!alias?.id || !canonical?.id) return null;
    const canonicalId = this.canonicalTrackIdentityId(canonical.id) || canonical.id;
    if (alias.id === canonicalId) return {
      linked: false,
      conflict: false,
      aliasIdentityKey: alias.identity_key,
      canonicalIdentityKey: canonical.identity_key
    };

    const existing = this.db.prepare("SELECT * FROM track_identity_alias WHERE alias_identity_id = ?").get(alias.id);
    if (existing && Number(existing.canonical_identity_id) !== canonicalId) {
      return {
        linked: false,
        conflict: true,
        aliasIdentityKey: alias.identity_key,
        canonicalIdentityKey: canonical.identity_key,
        existingCanonicalIdentityId: Number(existing.canonical_identity_id)
      };
    }

    this.mergeSonicAnalysisRequestIdentity(alias.id, canonicalId);
    const now = isoTime(updatedAt, this.clock());
    this.db.prepare(`
      INSERT INTO track_identity_alias (
        alias_identity_id, canonical_identity_id, relation, confidence, source,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_identity_id) DO UPDATE SET
        canonical_identity_id = excluded.canonical_identity_id,
        relation = excluded.relation,
        confidence = excluded.confidence,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(
      alias.id,
      canonicalId,
      cleanText(relation) || "ALIAS",
      Number(confidence || 0) || null,
      cleanText(source),
      now,
      now
    );
    const canonicalRow = this.db.prepare("SELECT * FROM track_identity WHERE id = ?").get(canonicalId);
    return {
      linked: true,
      conflict: false,
      aliasIdentityKey: alias.identity_key,
      canonicalIdentityKey: canonicalRow?.identity_key || canonical.identity_key,
      relation: cleanText(relation) || "ALIAS",
      confidence: Number(confidence || 0) || null
    };
  }

  mergeSonicAnalysisRequestIdentity(aliasIdentityId, canonicalIdentityId) {
    if (!this.enabled || !this.db || !aliasIdentityId || !canonicalIdentityId || aliasIdentityId === canonicalIdentityId) return;
    const aliasRequest = this.db.prepare("SELECT * FROM sonic_analysis_request WHERE track_identity_id = ?").get(aliasIdentityId);
    if (!aliasRequest) return;
    const canonicalRequest = this.db.prepare("SELECT * FROM sonic_analysis_request WHERE track_identity_id = ?").get(canonicalIdentityId);
    const priority = (status) => ({
      ANALYZED_BEATPORT_PREVIEW: 6,
      ANALYZING_BEATPORT_PREVIEW: 5,
      READY_BEATPORT_PREVIEW: 4,
      PENDING_METADATA: 3,
      NEEDS_LOCAL_FILE: 2,
      ANALYSIS_FAILED: 1
    }[cleanText(status).toUpperCase()] || 0);
    if (!canonicalRequest) {
      this.db.prepare(`
        INSERT INTO sonic_analysis_request (
          track_identity_id, status, policy, required_source, beatport_track_id,
          source_audio_type, source_match_type, confidence, reason,
          requested_at, updated_at, fulfilled_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        canonicalIdentityId,
        aliasRequest.status,
        aliasRequest.policy,
        aliasRequest.required_source,
        aliasRequest.beatport_track_id,
        aliasRequest.source_audio_type,
        aliasRequest.source_match_type,
        aliasRequest.confidence,
        aliasRequest.reason,
        aliasRequest.requested_at,
        aliasRequest.updated_at,
        aliasRequest.fulfilled_at,
        aliasRequest.raw_json
      );
    } else if (priority(aliasRequest.status) > priority(canonicalRequest.status)
      || (priority(aliasRequest.status) === priority(canonicalRequest.status)
        && String(aliasRequest.updated_at || "") > String(canonicalRequest.updated_at || ""))) {
      this.db.prepare(`
        UPDATE sonic_analysis_request SET
          status = ?, policy = ?, required_source = ?, beatport_track_id = ?,
          source_audio_type = ?, source_match_type = ?, confidence = ?, reason = ?,
          updated_at = ?, fulfilled_at = ?, raw_json = ?
        WHERE track_identity_id = ?
      `).run(
        aliasRequest.status,
        aliasRequest.policy,
        aliasRequest.required_source,
        aliasRequest.beatport_track_id,
        aliasRequest.source_audio_type,
        aliasRequest.source_match_type,
        aliasRequest.confidence,
        aliasRequest.reason,
        aliasRequest.updated_at,
        aliasRequest.fulfilled_at,
        aliasRequest.raw_json,
        canonicalIdentityId
      );
    }
    this.db.prepare("DELETE FROM sonic_analysis_request WHERE track_identity_id = ?").run(aliasIdentityId);
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

  saveSonicAnalysisRequest(track = {}, request = {}) {
    if (!this.enabled || !this.db) return null;
    const updatedAt = isoTime(request.updatedAt || request.requestedAt || request.createdAt, this.clock());
    const identity = this.upsertTrackIdentity({ ...track, observedAt: updatedAt });
    if (!identity?.id) return null;
    const canonicalIdentityId = this.canonicalTrackIdentityId(identity.id) || identity.id;
    const existing = this.db.prepare("SELECT * FROM sonic_analysis_request WHERE track_identity_id = ?").get(canonicalIdentityId);
    const requestedStatus = cleanText(request.status).toUpperCase() || "PENDING_METADATA";
    if (existing?.status?.startsWith("ANALYZED") && !request.force) return existing;
    const requestedAt = existing?.requested_at || updatedAt;
    const fulfilledAt = requestedStatus.startsWith("ANALYZED")
      ? (cleanText(request.fulfilledAt) || updatedAt)
      : (cleanText(request.fulfilledAt) || existing?.fulfilled_at || null);
    this.db.prepare(`
      INSERT INTO sonic_analysis_request (
        track_identity_id, status, policy, required_source, beatport_track_id,
        source_audio_type, source_match_type, confidence, reason,
        requested_at, updated_at, fulfilled_at, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_identity_id) DO UPDATE SET
        status = excluded.status,
        policy = excluded.policy,
        required_source = excluded.required_source,
        beatport_track_id = excluded.beatport_track_id,
        source_audio_type = excluded.source_audio_type,
        source_match_type = excluded.source_match_type,
        confidence = excluded.confidence,
        reason = excluded.reason,
        updated_at = excluded.updated_at,
        fulfilled_at = excluded.fulfilled_at,
        raw_json = excluded.raw_json
    `).run(
      canonicalIdentityId,
      requestedStatus,
      cleanText(request.policy) || "LIVE_BEATPORT_ONLY",
      cleanText(request.requiredSource) || "beatport_preview_or_local_file",
      cleanText(request.beatportTrackId),
      cleanText(request.sourceAudioType),
      cleanText(request.sourceMatchType),
      Number(request.confidence || 0) || null,
      cleanText(request.reason),
      requestedAt,
      updatedAt,
      fulfilledAt,
      jsonStringify(request.rawJson || request)
    );
    return this.db.prepare(`
      SELECT sar.*, ti.identity_key, ti.tidal_id, ti.roon_identity, ti.isrc, ti.artist, ti.title, ti.mix_version, ti.album, ti.duration_ms
      FROM sonic_analysis_request sar
      JOIN track_identity ti ON ti.id = sar.track_identity_id
      WHERE sar.track_identity_id = ?
    `).get(canonicalIdentityId) || null;
  }

  findSonicAnalysisRequest(track = {}) {
    if (!this.enabled || !this.db) return null;
    const identityKey = trackIdentityKey(track);
    if (!identityKey) return null;
    const identity = this.db.prepare("SELECT id FROM track_identity WHERE identity_key = ? LIMIT 1").get(identityKey);
    const canonicalIdentityId = this.canonicalTrackIdentityId(identity?.id);
    if (!canonicalIdentityId) return null;
    return this.db.prepare(`
      SELECT sar.*, ti.identity_key, ti.tidal_id, ti.roon_identity, ti.isrc, ti.artist, ti.title, ti.mix_version, ti.album, ti.duration_ms
      FROM sonic_analysis_request sar
      JOIN track_identity ti ON ti.id = sar.track_identity_id
      WHERE sar.track_identity_id = ?
      LIMIT 1
    `).get(canonicalIdentityId) || null;
  }

  sonicAnalysisRequirements({ status = "", limit = 100 } = {}) {
    if (!this.enabled || !this.db) return [];
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const cleanStatus = cleanText(status).toUpperCase();
    const rows = cleanStatus
      ? this.db.prepare(`
          SELECT sar.*, ti.identity_key, ti.tidal_id, ti.roon_identity, ti.isrc, ti.artist, ti.title, ti.mix_version, ti.album, ti.duration_ms
          FROM sonic_analysis_request sar
          JOIN track_identity ti ON ti.id = sar.track_identity_id
          WHERE sar.status = ?
          ORDER BY sar.updated_at ASC, sar.track_identity_id ASC
          LIMIT ?
        `).all(cleanStatus, safeLimit)
      : this.db.prepare(`
          SELECT sar.*, ti.identity_key, ti.tidal_id, ti.roon_identity, ti.isrc, ti.artist, ti.title, ti.mix_version, ti.album, ti.duration_ms
          FROM sonic_analysis_request sar
          JOIN track_identity ti ON ti.id = sar.track_identity_id
          ORDER BY sar.updated_at ASC, sar.track_identity_id ASC
          LIMIT ?
        `).all(safeLimit);
    return rows;
  }

  findBeatportEnrichment(track = {}) {
    return this.findBeatportEnrichmentCandidate(track)?.result || null;
  }

  findBeatportEnrichmentCandidate(track = {}) {
    const identityKey = trackIdentityKey(track);
    if (!this.enabled || !this.db || !identityKey) return null;
    const directRow = this.db.prepare(`
      SELECT be.*, ti.artist, ti.title, ti.mix_version
      FROM track_identity ti
      JOIN beatport_enrichment be ON be.track_identity_id = ti.id
      WHERE ti.identity_key = ?
    `).get(identityKey);
    if (directRow) {
      return {
        result: entryToBeatportResult(directRow),
        identityReuse: null
      };
    }

    const identity = this.db.prepare("SELECT * FROM track_identity WHERE identity_key = ? LIMIT 1").get(identityKey);
    if (!identity?.id) return null;
    const aliasLink = this.db.prepare(`
      SELECT relation, confidence, source
      FROM track_identity_alias
      WHERE alias_identity_id = ?
      LIMIT 1
    `).get(identity.id);
    const canonicalId = this.canonicalTrackIdentityId(identity.id);
    if (!aliasLink || !canonicalId || canonicalId === Number(identity.id)
      || cleanText(aliasLink.relation).toUpperCase() !== "CANONICAL_TIDAL"
      || Number(aliasLink.confidence || 0) < 80) {
      return null;
    }

    const canonical = this.db.prepare("SELECT * FROM track_identity WHERE id = ? LIMIT 1").get(canonicalId);
    if (!canonical?.tidal_id) return null;
    const requestedIdentity = parseCanonicalCatalogIdentity({
      title: identity.title,
      mixVersion: identity.mix_version
    });
    const canonicalIdentity = parseCanonicalCatalogIdentity({
      title: canonical.title,
      mixVersion: canonical.mix_version
    });
    if (!requestedIdentity.normalizedBaseTitle || requestedIdentity.normalizedBaseTitle !== canonicalIdentity.normalizedBaseTitle) {
      return null;
    }
    if (requestedIdentity.version.explicit) {
      const sameVersion = canonicalIdentity.version.explicit
        && requestedIdentity.version.kind === canonicalIdentity.version.kind
        && requestedIdentity.version.semantic === canonicalIdentity.version.semantic;
      if (!sameVersion) return null;
    } else if (!["none", "original", "alternate"].includes(canonicalIdentity.version.kind)) {
      return null;
    }

    const row = this.db.prepare(`
      SELECT be.*, ti.artist, ti.title, ti.mix_version
      FROM track_identity ti
      JOIN beatport_enrichment be ON be.track_identity_id = ti.id
      WHERE ti.id = ?
    `).get(canonicalId);
    if (!row) return null;
    const validationTrack = {
      tidalId: cleanTidalId(canonical.tidal_id),
      isrc: cleanIsrc(canonical.isrc),
      artist: cleanText(canonical.artist),
      title: cleanText(canonical.title),
      mixVersion: cleanText(canonical.mix_version),
      album: cleanText(canonical.album),
      durationMs: Number(canonical.duration_ms || 0) || null
    };
    return {
      result: entryToBeatportResult(row),
      identityReuse: {
        reused: true,
        source: "canonical-tidal-alias",
        relation: cleanText(aliasLink.relation),
        relationConfidence: Number(aliasLink.confidence || 0) || 0,
        aliasIdentityKey: cleanText(identity.identity_key),
        canonicalIdentityKey: cleanText(canonical.identity_key),
        canonicalTidalId: cleanTidalId(canonical.tidal_id),
        normalizedBaseTitle: canonicalIdentity.normalizedBaseTitle,
        validationTrack
      }
    };
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
      // The UI uses the five current ratings, but searches must include rows
      // written by older clients so a vocabulary migration does not hide
      // existing feedback.
      const feedbackAliases = {
        love: ["love"],
        like: ["like", "good", "up"],
        good: ["like", "good", "up"],
        ok: ["ok", "okay"],
        okay: ["ok", "okay"],
        dislike: ["dislike", "skip", "down"],
        skip: ["dislike", "skip", "down"],
        never: ["never", "never_again"],
        never_again: ["never", "never_again"]
      };
      const ratings = feedbackAliases[cleanFeedback] || [cleanFeedback];
      const placeholders = ratings.map(() => "?").join(", ");
      clauses.push(`EXISTS (SELECT 1 FROM taste_feedback fb WHERE fb.track_identity_id = ti.id AND LOWER(fb.rating) IN (${placeholders}))`);
      params.push(...ratings);
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
        SELECT track_identity_id, SUM(count) AS play_count
        FROM track_observation
        WHERE source IN ('now_playing', 'live_radio', 'roon_play', 'playback', 'played')
        GROUP BY track_identity_id
      ) pc ON pc.track_identity_id = ti.id
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
        pc.play_count,
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
    // Keep provider enrichment attached to the source track identity. Beatport
    // may return a more specific ISRC or mix name, but those provider fields
    // must not fork a text-only memory track into a second identity.
    const identity = this.upsertTrackIdentity(track);
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
