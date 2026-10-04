"use strict";

const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { identityKeyFor } = require("./sonicEmbeddingStore");
const {
  CHARACTERISTIC_ENTRIES,
  GENRE_ENTRIES,
  VIBE_ENTRIES
} = require("./musicOntology");

const SESSION_STATUSES = ["READY", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"];
const REVIEW_POLICIES = ["ASSISTANT_AUTO", "ASSISTANT_DRAFT", "HUMAN_CONFIRM_EACH"];
const QUEUE_POLICIES = ["NEVER", "ASK", "STRONG_ONLY", "KEEP_AND_STRONG", "ALL_VALID"];
const NOVELTY_POLICIES = ["FRESH_ONLY", "PREFER_FRESH", "ALLOW_KNOWN", "REDISCOVERY_OK"];
const MAX_SESSION_COUNT = 500;
const DEFAULT_MODEL = "discogs-effnet";
const DEFAULT_MODEL_VERSION = "1";

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function json(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function nowIso(clock) {
  return new Date(Number(clock())).toISOString();
}

function safeCount(value, fallback = 20) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_SESSION_COUNT, Math.trunc(number))) : fallback;
}

function safeLimit(value, fallback = 20) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(100, Math.trunc(number))) : fallback;
}

function unique(values = []) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function titleLabel(value) {
  return cleanText(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function canonicalSlug(value) {
  return normalized(value).replace(/\s+/g, "-");
}

function validOrDefault(value, allowed, fallback) {
  const text = cleanText(value).toUpperCase();
  return allowed.includes(text) ? text : fallback;
}

function scalar(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstNonEmpty(...values) {
  return values.find((value) => cleanText(value)) || "";
}

function trackDedupeKey(track = {}) {
  const identity = cleanText(track.identityKey || track.identity_key);
  if (identity) return `identity:${identity}`;
  const artist = normalized(track.artist);
  const title = normalized(track.title);
  const mix = normalized(track.mixVersion || track.mixName || track.version);
  return artist && title ? `track:${artist}|${title}|${mix}` : "";
}

function sameRecording(left = {}, right = {}) {
  const leftArtist = normalized(left.artist);
  const rightArtist = normalized(right.artist);
  const leftTitle = normalized(left.title);
  const rightTitle = normalized(right.title);
  if (!leftArtist || !rightArtist || !leftTitle || !rightTitle) return false;
  if (leftArtist !== rightArtist || leftTitle !== rightTitle) return false;
  const leftMix = normalized(left.mixVersion || left.mixName || left.version);
  const rightMix = normalized(right.mixVersion || right.mixName || right.version);
  return !leftMix || !rightMix || leftMix === rightMix;
}

function compactTrack(track = {}) {
  const tidalId = firstNonEmpty(track.tidalId, track.tidalTrackId, track.tidal_id);
  return {
    identityKey: firstNonEmpty(track.identityKey, track.identity_key) || (tidalId ? `tidal:${tidalId}` : ""),
    artist: cleanText(track.artist),
    title: cleanText(track.title),
    album: cleanText(track.album),
    mixVersion: firstNonEmpty(track.mixVersion, track.mixName, track.version),
    tidalId,
    tidalUrl: firstNonEmpty(track.tidalUrl, track.tidal_url) || (tidalId ? `https://tidal.com/browse/track/${tidalId}` : ""),
    beatportId: firstNonEmpty(track.beatportId, track.beatportTrackId, track.beatport_track_id),
    isrc: cleanText(track.isrc),
    durationMs: scalar(track.durationMs),
    genre: firstNonEmpty(track.genre, track.beatportGenre, track.beatport_genre),
    subgenre: firstNonEmpty(track.subgenre, track.beatportSubgenre, track.beatport_subgenre),
    label: firstNonEmpty(track.label, track.beatportLabel, track.beatport_label),
    releaseDate: firstNonEmpty(track.releaseDate, track.beatportReleaseDate, track.beatport_release_date),
    bpm: scalar(firstNonEmpty(track.bpm, track.beatportBpm, track.beatport_bpm)),
    key: firstNonEmpty(track.key, track.keyName, track.beatportKeyName, track.beatport_key_name),
    camelot: firstNonEmpty(track.camelot, track.beatportCamelot, track.beatport_camelot),
    year: scalar(track.year || track.releaseYear),
    discoverySource: cleanText(track.discoverySource),
    discoveryLane: cleanText(track.discoveryLane),
    shadowOnly: track.shadowOnly === undefined ? true : Boolean(track.shadowOnly),
    queueable: track.queueable === true
  };
}

function factsForTrack(track = {}) {
  const compact = compactTrack(track);
  const facts = {
    identity: compact.identityKey,
    artist: compact.artist,
    title: compact.title,
    album: compact.album,
    mixVersion: compact.mixVersion,
    tidalId: compact.tidalId,
    beatportId: compact.beatportId,
    isrc: compact.isrc,
    durationMs: compact.durationMs,
    genre: compact.genre,
    subgenre: compact.subgenre,
    label: compact.label,
    releaseDate: compact.releaseDate,
    bpm: compact.bpm,
    key: compact.key,
    camelot: compact.camelot
  };
  for (const [key, value] of Object.entries(facts)) {
    if (value === "" || value === null || value === undefined) delete facts[key];
  }
  if (Array.isArray(track.playlistMemberships) && track.playlistMemberships.length) {
    facts.playlistMemberships = unique(track.playlistMemberships).slice(0, 24);
  }
  return facts;
}

function relationshipFromCandidate(candidate = {}) {
  const relation = candidate.sonicNeighbor && typeof candidate.sonicNeighbor === "object"
    ? candidate.sonicNeighbor
    : {};
  const output = {
    cosineSimilarity: scalar(relation.similarity ?? candidate.similarity),
    rank: scalar(relation.rank ?? candidate.rank),
    model: cleanText(relation.model || candidate.model),
    modelVersion: cleanText(relation.modelVersion || candidate.modelVersion),
    selectionScore: scalar(relation.selectionScore),
    rawSimilarity: scalar(relation.rawSimilarity),
    positiveCentroidSimilarity: scalar(relation.positiveSimilarity),
    negativeCentroidSimilarity: scalar(relation.negativeSimilarity),
    netMargin: scalar(relation.netMargin),
    selectionMethod: cleanText(relation.selectionMethod),
    selectionArea: cleanText(relation.selectionArea),
    directReview: relation.directReview || null,
    adjustedScore: scalar(relation.adjustedScore ?? relation.recommendationScore),
    recommendationScore: scalar(relation.recommendationScore ?? relation.adjustedScore),
    secondStage: relation.secondStage || null
  };
  for (const [key, value] of Object.entries(output)) {
    if (value === "" || value === null || value === undefined) delete output[key];
  }
  return output;
}

function makeReviewSchema() {
  const entries = (values = [], prefix = "") => values.map((entry) => ({
    id: `${prefix}${canonicalSlug(entry.canonical)}`,
    label: titleLabel(entry.canonical),
    family: entry.family ? `${prefix}${canonicalSlug(entry.family)}` : undefined
  }));
  const characteristics = CHARACTERISTIC_ENTRIES.map((entry) => ({
    id: `trait:${canonicalSlug(entry.canonical)}`,
    label: titleLabel(entry.canonical),
    family: entry.family ? `trait:${canonicalSlug(entry.family)}` : undefined
  }));
  const similarityEmphasis = [
    ["sonic:arrangement", "Arrangement / Journey"],
    ["sonic:bass", "Bass / Low End"],
    ["sonic:rhythm", "Rhythm / Groove"],
    ["sonic:timbre", "Timbre / Texture"],
    ["sonic:vocal", "Vocal Presence"],
    ["sonic:atmosphere", "Atmosphere / Space"],
    ["sonic:tempo", "Tempo / Motion"]
  ].map(([id, label]) => ({ id, label }));
  return {
    ok: true,
    mode: "shadow",
    profile: {
      genreLane: entries(GENRE_ENTRIES, "genre:"),
      subgenreStyle: entries(GENRE_ENTRIES, "genre:"),
      energy: { min: 1, max: 10, integer: true },
      moods: entries(VIBE_ENTRIES, "mood:"),
      tags: characteristics,
      preserveTraits: characteristics,
      avoidTraits: characteristics,
      similarityEmphasis
    },
    decisions: ["KEEP", "STRONG_KEEP", "SKIP", "REVIEW_MANUALLY", "REJECT", "DUPLICATE", "AMBIGUOUS"],
    reviewPolicies: REVIEW_POLICIES,
    queuePolicies: QUEUE_POLICIES,
    noveltyPolicies: NOVELTY_POLICIES,
    evidence: {
      factsAreMetadata: true,
      sonicFeaturesAreIncludedOnlyWhenStored: true,
      rawEmbeddingsReturned: false,
      productionRecommendationWeightingChanged: false
    }
  };
}

function createSonicReviewSessionService({
  db,
  recommendationEngine,
  musicMemory = null,
  trackMemory = null,
  discoveryHistory = null,
  standbyStore = null,
  getCurrentTrack = null,
  queueTracks = null,
  recordRating = null,
  clock = Date.now,
  logger = console
} = {}) {
  if (!db) throw new Error("Sonic Review sessions require the Rabbit Hole memory database.");

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sonic_review_session (
        session_id TEXT PRIMARY KEY,
        anchor_identity_key TEXT NOT NULL,
        anchor_json TEXT NOT NULL,
        requested_count INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        queued_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        review_policy TEXT NOT NULL,
        queue_policy TEXT NOT NULL,
        profile_policy TEXT NOT NULL,
        novelty_policy TEXT NOT NULL,
        model TEXT NOT NULL,
        model_version TEXT NOT NULL,
        diagnostics_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sonic_review_session_status_updated
        ON sonic_review_session(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS sonic_review_session_item (
        session_id TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        candidate_identity_key TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        relation_json TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        decision TEXT,
        confidence REAL,
        review_json TEXT,
        queued_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, item_index),
        UNIQUE(session_id, candidate_identity_key),
        FOREIGN KEY(session_id) REFERENCES sonic_review_session(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sonic_review_session_item_candidate
        ON sonic_review_session_item(candidate_identity_key);
      CREATE TABLE IF NOT EXISTS sonic_review_session_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        item_index INTEGER,
        source TEXT NOT NULL,
        assistant TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sonic_review_session(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sonic_review_session_audit_session
        ON sonic_review_session_audit(session_id, id);
    `);
  }
  migrate();

  function sessionId() {
    return `sonic-review:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function rowToSession(row) {
    if (!row) return null;
    return {
      sessionId: cleanText(row.session_id),
      anchorIdentity: cleanText(row.anchor_identity_key),
      anchorContext: safeJsonParse(row.anchor_json, {}),
      requestedCount: Number(row.requested_count || 0),
      candidateCount: Number(row.candidate_count || 0),
      currentIndex: Number(row.current_index || 0),
      completedCount: Number(row.completed_count || 0),
      skippedCount: Number(row.skipped_count || 0),
      queuedCount: Number(row.queued_count || 0),
      failedCount: Number(row.failed_count || 0),
      status: cleanText(row.status),
      reviewPolicy: cleanText(row.review_policy),
      queuePolicy: cleanText(row.queue_policy),
      profilePolicy: cleanText(row.profile_policy),
      noveltyPolicy: cleanText(row.novelty_policy),
      model: cleanText(row.model),
      modelVersion: cleanText(row.model_version),
      diagnostics: safeJsonParse(row.diagnostics_json, {}),
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at),
      completedAt: cleanText(row.completed_at)
    };
  }

  function rowToItem(row) {
    if (!row) return null;
    return {
      sessionId: cleanText(row.session_id),
      index: Number(row.item_index || 0),
      candidateIdentity: cleanText(row.candidate_identity_key),
      candidate: safeJsonParse(row.candidate_json, {}),
      sonicRelationship: safeJsonParse(row.relation_json, {}),
      status: cleanText(row.status) || "PENDING",
      decision: cleanText(row.decision),
      confidence: scalar(row.confidence),
      review: safeJsonParse(row.review_json, null),
      queuedAt: cleanText(row.queued_at),
      error: cleanText(row.error),
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at)
    };
  }

  function readSession(id) {
    const row = db.prepare("SELECT * FROM sonic_review_session WHERE session_id = ? LIMIT 1").get(cleanText(id));
    if (!row) return null;
    const session = rowToSession(row);
    session.items = db.prepare("SELECT * FROM sonic_review_session_item WHERE session_id = ? ORDER BY item_index ASC").all(session.sessionId).map(rowToItem);
    return session;
  }

  function requireSession(id) {
    const session = readSession(id);
    if (!session) throw new Error(`Sonic Review session ${cleanText(id)} was not found.`);
    return session;
  }

  function audit(id, eventType, itemIndex, oldValue, newValue) {
    db.prepare(`
      INSERT INTO sonic_review_session_audit
        (session_id, event_type, item_index, source, assistant, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      eventType,
      Number.isFinite(Number(itemIndex)) ? Number(itemIndex) : null,
      "MCP",
      "Synapse",
      oldValue === undefined ? null : json(oldValue),
      newValue === undefined ? null : json(newValue),
      nowIso(clock)
    );
  }

  function readTrackRow(identityKey) {
    try {
      return db.prepare(`
        SELECT
          ti.*,
          be.beatport_track_id, be.genre AS beatport_genre, be.subgenre AS beatport_subgenre,
          be.bpm AS beatport_bpm, be.key_name AS beatport_key_name, be.camelot AS beatport_camelot,
          be.label AS beatport_label, be.release_date AS beatport_release_date,
          be.duration_ms AS beatport_duration_ms, be.isrc AS beatport_isrc,
          be.beatport_url, be.raw_json AS beatport_raw_json,
          (SELECT COUNT(*) FROM taste_feedback fb WHERE fb.track_identity_id = ti.id) AS feedback_count,
          (SELECT rating FROM taste_feedback fb WHERE fb.track_identity_id = ti.id ORDER BY fb.id DESC LIMIT 1) AS latest_rating,
          (SELECT GROUP_CONCAT(DISTINCT source) FROM track_observation ob WHERE ob.track_identity_id = ti.id) AS observation_sources
        FROM track_identity ti
        LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
        WHERE ti.identity_key = ?
        LIMIT 1
      `).get(identityKey) || null;
    } catch {
      return null;
    }
  }

  function trackFromMemoryRow(row) {
    if (!row) return {};
    return {
      identityKey: cleanText(row.identity_key),
      tidalId: cleanText(row.tidal_id),
      roonIdentity: cleanText(row.roon_identity),
      isrc: firstNonEmpty(row.isrc, row.beatport_isrc),
      artist: cleanText(row.artist),
      title: cleanText(row.title),
      mixVersion: cleanText(row.mix_version),
      album: cleanText(row.album),
      durationMs: scalar(firstNonEmpty(row.duration_ms, row.beatport_duration_ms)),
      beatportId: cleanText(row.beatport_track_id),
      genre: cleanText(row.beatport_genre),
      subgenre: cleanText(row.beatport_subgenre),
      bpm: scalar(row.beatport_bpm),
      key: cleanText(row.beatport_key_name),
      camelot: cleanText(row.beatport_camelot),
      label: cleanText(row.beatport_label),
      releaseDate: cleanText(row.beatport_release_date),
      tidalUrl: row.tidal_id ? `https://tidal.com/browse/track/${row.tidal_id}` : "",
      memory: {
        feedbackCount: Number(row.feedback_count || 0),
        latestRating: cleanText(row.latest_rating),
        observationSources: cleanText(row.observation_sources).split(",").filter(Boolean)
      }
    };
  }

  function trackFromStoredSonicProfile(stored) {
    const track = stored?.track && typeof stored.track === "object" ? stored.track : {};
    const metadata = track.metadata && typeof track.metadata === "object" ? track.metadata : {};
    return {
      ...track,
      identityKey: firstNonEmpty(track.identityKey, stored?.identityKey),
      beatportId: firstNonEmpty(track.beatportId, metadata.beatportId),
      genre: firstNonEmpty(track.genre, metadata.beatportGenre),
      subgenre: firstNonEmpty(track.subgenre, metadata.beatportSubgenre),
      label: firstNonEmpty(track.label, metadata.beatportLabel),
      bpm: scalar(firstNonEmpty(track.bpm, metadata.beatportBpm)),
      key: firstNonEmpty(track.key, metadata.beatportKey),
      releaseDate: firstNonEmpty(track.releaseDate, metadata.beatportReleaseDate),
      tidalId: firstNonEmpty(track.tidalId, metadata.tidalId),
      isrc: firstNonEmpty(track.isrc, metadata.isrc),
      durationMs: scalar(firstNonEmpty(track.durationMs, metadata.durationMs))
    };
  }

  function hydrateTrack(track = {}) {
    const supplied = typeof track === "object" ? track : {};
    const identityKey = identityKeyFor(supplied) || cleanText(supplied.identityKey);
    const row = identityKey ? readTrackRow(identityKey) : null;
    const memory = trackFromMemoryRow(row);
    let sonic = {};
    try {
      sonic = trackFromStoredSonicProfile(recommendationEngine?.findStoredSonicProfile?.(supplied) || null);
    } catch {
      sonic = {};
    }
    const merged = { ...sonic, ...memory, ...supplied };
    for (const key of ["artist", "title", "album", "mixVersion", "tidalId", "isrc", "genre", "subgenre", "label", "releaseDate", "key", "camelot", "tidalUrl"]) {
      if (!cleanText(merged[key]) && cleanText(memory[key])) merged[key] = memory[key];
      if (!cleanText(merged[key]) && cleanText(sonic[key])) merged[key] = sonic[key];
    }
    if (!merged.durationMs && memory.durationMs) merged.durationMs = memory.durationMs;
    if (!merged.durationMs && sonic.durationMs) merged.durationMs = sonic.durationMs;
    if (!merged.beatportId && memory.beatportId) merged.beatportId = memory.beatportId;
    if (!merged.beatportId && sonic.beatportId) merged.beatportId = sonic.beatportId;
    if (!merged.bpm && memory.bpm) merged.bpm = memory.bpm;
    if (!merged.bpm && sonic.bpm) merged.bpm = sonic.bpm;
    if (!merged.identityKey && identityKey) merged.identityKey = identityKey;
    if (!merged.tidalId && merged.identityKey?.startsWith("tidal:")) merged.tidalId = merged.identityKey.slice(6);
    if (!merged.tidalUrl && merged.tidalId) merged.tidalUrl = `https://tidal.com/browse/track/${merged.tidalId}`;
    return { ...merged, __memory: memory.memory || {} };
  }

  async function resolveAnchor(reference) {
    const requested = reference === undefined || reference === null ? "current" : reference;
    if (typeof requested === "string" && /^(?:current|now|playing)$/i.test(requested.trim())) {
      if (typeof getCurrentTrack !== "function") throw new Error("The current Roon track is unavailable.");
      const current = await getCurrentTrack();
      if (!current) throw new Error("There is no current Roon track to use as a Sonic Review anchor.");
      return hydrateTrack(current);
    }
    if (typeof requested === "string" && /^\d+$/.test(requested.trim())) {
      return hydrateTrack({ tidalId: requested.trim(), identityKey: `tidal:${requested.trim()}` });
    }
    if (typeof requested === "string" && /^(?:https?:\/\/)?(?:www\.)?tidal\.com\//i.test(requested.trim())) {
      if (typeof recommendationEngine?.resolveTidalTrackReference === "function") {
        return hydrateTrack(await recommendationEngine.resolveTidalTrackReference(requested));
      }
    }
    if (typeof requested === "string" && /^(?:tidal|roon|isrc|text|file|beatport):/i.test(requested.trim())) {
      return hydrateTrack({ identityKey: requested.trim() });
    }
    if (requested && typeof requested === "object") {
      const hasIdentity = Boolean(identityKeyFor(requested));
      if (!hasIdentity && typeof recommendationEngine?.resolveTidalTrackReference === "function" && (requested.tidalId || requested.tidalUrl || requested.tidal_id)) {
        return hydrateTrack(await recommendationEngine.resolveTidalTrackReference(requested));
      }
      return hydrateTrack(requested);
    }
    throw new Error("A Sonic Review anchor must be current, a TIDAL identity, or a normalized track object.");
  }

  function readPreviouslyReviewed(anchorIdentityKey) {
    const keys = new Set();
    try {
      for (const row of db.prepare("SELECT candidate_identity_key FROM sonic_neighbor_feedback WHERE anchor_identity_key = ?").all(anchorIdentityKey)) {
        if (cleanText(row.candidate_identity_key)) keys.add(cleanText(row.candidate_identity_key));
      }
      for (const row of db.prepare(`
        SELECT i.candidate_identity_key
        FROM sonic_review_session_item i
        JOIN sonic_review_session s ON s.session_id = i.session_id
        WHERE s.anchor_identity_key = ? AND i.status <> 'PENDING'
      `).all(anchorIdentityKey)) {
        if (cleanText(row.candidate_identity_key)) keys.add(cleanText(row.candidate_identity_key));
      }
    } catch {
      // The tables are created above, but a read-only session must fail closed
      // if an older database is temporarily unavailable.
    }
    return keys;
  }

  function standbyIdentityKeys() {
    return new Set((standbyStore?.read?.()?.candidates || [])
      .map((candidate) => identityKeyFor(candidate) || cleanText(candidate.identityKey))
      .filter(Boolean));
  }

  function exposureFor(track = {}, standbyKeys = null) {
    const identityKey = identityKeyFor(track) || cleanText(track.identityKey);
    const memory = track.__memory || {};
    const sources = new Set(Array.isArray(memory.observationSources) ? memory.observationSources : []);
    const history = discoveryHistory?.entryFor?.(track) || null;
    const trackEntry = trackMemory?.find?.(track) || null;
    const standbySeen = (standbyKeys || standbyIdentityKeys()).has(identityKey);
    const ratedBefore = Number(memory.feedbackCount || 0) > 0 || Boolean(cleanText(trackEntry?.feedback));
    const previouslyQueued = [...sources].some((source) => /queue|queued|manual/i.test(source));
    const playlistKnown = [...sources].some((source) => /playlist/i.test(source));
    const libraryKnown = [...sources].some((source) => /library|local|file|import/i.test(source));
    const previouslyDiscovered = Boolean(history);
    return {
      identityKey,
      previouslyQueued,
      previouslyDiscovered,
      standbySeen,
      playlistKnown,
      libraryKnown,
      ratedBefore,
      globalRating: cleanText(memory.latestRating || trackEntry?.feedback),
      known: previouslyQueued || previouslyDiscovered || standbySeen || playlistKnown || libraryKnown || ratedBefore,
      sources: [...sources].slice(0, 16)
    };
  }

  function sameArtist(anchor, candidate) {
    const left = normalized(anchor.artist);
    const right = normalized(candidate.artist);
    return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
  }

  function genreCompatible(anchor, candidate) {
    const left = normalized(anchor.genre || anchor.subgenre);
    const right = normalized(candidate.genre || candidate.subgenre);
    if (!left || !right) return true;
    return left === right || left.includes(right) || right.includes(left);
  }

  function currentItem(session) {
    return session.items.find((item) => item.index >= session.currentIndex && item.status === "PENDING") || null;
  }

  function compactItem(session, item) {
    if (!item) return null;
    return {
      sessionId: session.sessionId,
      index: item.index,
      position: item.index + 1,
      requestedCount: session.requestedCount,
      remainingCount: session.items.filter((entry) => entry.status === "PENDING").length,
      candidateIdentity: item.candidateIdentity,
      candidate: compactTrack(item.candidate),
      sonicRelationship: item.sonicRelationship || relationshipFromCandidate(item.candidate),
      reviewState: {
        status: item.status,
        decision: item.decision || null,
        confidence: item.confidence,
        queuedAt: item.queuedAt || null,
        error: item.error || null
      }
    };
  }

  function sessionSummary(session, includeDiagnostics = false) {
    const current = currentItem(session);
    const errors = session.items.filter((item) => item.error).slice(0, 20).map((item) => ({
      index: item.index,
      candidateIdentity: item.candidateIdentity,
      error: item.error
    }));
    const result = {
      sessionId: session.sessionId,
      anchorIdentity: session.anchorIdentity,
      anchor: compactTrack(session.anchorContext),
      requestedCount: session.requestedCount,
      candidateCount: session.candidateCount,
      currentIndex: session.currentIndex,
      completedCount: session.completedCount,
      skippedCount: session.skippedCount,
      queuedCount: session.queuedCount,
      failedCount: session.failedCount,
      remainingCount: session.items.filter((item) => item.status === "PENDING").length,
      status: session.status,
      reviewPolicy: session.reviewPolicy,
      queuePolicy: session.queuePolicy,
      profilePolicy: session.profilePolicy,
      noveltyPolicy: session.noveltyPolicy,
      model: session.model,
      modelVersion: session.modelVersion,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      completedAt: session.completedAt || null,
      currentReviewState: current ? compactItem(session, current).reviewState : null,
      errors
    };
    if (includeDiagnostics) result.diagnostics = session.diagnostics;
    return result;
  }

  function diagnosticsFor(generated, filters, progressResumed = false) {
    const sourceDiagnostics = generated?.diagnostics || {};
    return {
      source: "sonic-review-session",
      anchor: filters.anchorIdentityKey,
      query: filters.anchorIdentityKey,
      pageRequested: null,
      cursorRequested: null,
      nextPage: null,
      nextCursor: null,
      returnedCount: Number(sourceDiagnostics.returned || generated?.candidates?.length || 0),
      duplicateCount: Number(sourceDiagnostics.duplicateCount || filters.duplicateCount || 0),
      acceptedCount: filters.acceptedCount,
      rejectedCount: filters.rejectedCount,
      budgetCost: sourceDiagnostics.budgetCost || null,
      progressResumed,
      candidateGeneration: sourceDiagnostics,
      filters: {
        excludeKnown: filters.excludeKnown,
        excludeRated: filters.excludeRated,
        excludePreviouslyReviewed: filters.excludePreviouslyReviewed,
        excludeSameArtist: filters.excludeSameArtist,
        noveltyPolicy: filters.noveltyPolicy
      }
    };
  }

  async function startReviewSession(input = {}) {
    if (!recommendationEngine || typeof recommendationEngine.generateSonicNeighborCandidates !== "function") {
      throw new Error("Recommendation Engine v2 is not available for Sonic Review sessions.");
    }
    const requestedCount = safeCount(input.count ?? input.requestedCount ?? input.neighborCount, 20);
    const anchor = await resolveAnchor(input.anchor ?? input.track ?? input.reference ?? "current");
    const anchorIdentityKey = identityKeyFor(anchor);
    if (!anchorIdentityKey) throw new Error("The Sonic Review anchor has no safe stored identity.");
    const model = cleanText(input.model || input.provider) || DEFAULT_MODEL;
    const modelVersion = cleanText(input.modelVersion) || DEFAULT_MODEL_VERSION;
    const reviewPolicy = validOrDefault(input.reviewPolicy, REVIEW_POLICIES, "ASSISTANT_DRAFT");
    const queuePolicy = validOrDefault(input.queuePolicy, QUEUE_POLICIES, "ASK");
    const noveltyPolicy = validOrDefault(input.noveltyPolicy, NOVELTY_POLICIES, "PREFER_FRESH");
    const profilePolicy = cleanText(input.profilePolicy || "SHADOW_ONLY").toUpperCase() || "SHADOW_ONLY";
    const excludeKnown = input.excludeKnown === true;
    const excludeRated = input.excludeRated === true;
    const excludePreviouslyReviewed = input.excludePreviouslyReviewed !== false;
    const excludeSameArtist = input.excludeSameArtist === true;
    const generationCount = Math.max(requestedCount, Math.min(MAX_SESSION_COUNT, safeCount(input.neighborCount, requestedCount * 3)));
    const excluded = excludePreviouslyReviewed
      ? readPreviouslyReviewed(anchorIdentityKey)
      : new Set();
    excluded.add(anchorIdentityKey);
    let generated;
    try {
      const generate = recommendationEngine.generateSonicNeighborCandidatesAsync
        || recommendationEngine.generateSonicNeighborCandidates;
      generated = await generate.call(recommendationEngine, {
        anchor,
        count: generationCount,
        perAnchorCount: generationCount,
        model,
        modelVersion,
        minSimilarity: input.minimumSimilarity ?? input.minSimilarity,
        excludeIdentityKeys: [...excluded],
        discoveryIntent: input.discoveryIntent || "sonic-review",
        noveltyPolicy,
        crossGenreAllowed: input.crossGenreAllowed !== false
      });
    } catch (error) {
      error.statusCode = error.statusCode || 503;
      throw error;
    }
    const candidates = [];
    const seen = new Set();
    let duplicateCount = 0;
    let rejectedCount = 0;
    const rejectionReasons = {};
    const standbyKeys = standbyIdentityKeys();
    for (const rawCandidate of Array.isArray(generated?.candidates) ? generated.candidates : []) {
      await yieldToEventLoop();
      const candidate = hydrateTrack(rawCandidate);
      const key = identityKeyFor(candidate) || cleanText(candidate.identityKey);
      const dedupeKey = trackDedupeKey(candidate);
      const exposure = exposureFor(candidate, standbyKeys);
      let reason = "";
      if (!key) reason = "missing-identity";
      else if (excluded.has(key) && excludePreviouslyReviewed) reason = "previously-reviewed-or-anchor";
      else if (sameRecording(anchor, candidate)) reason = "anchor-duplicate";
      else if (seen.has(key) || (dedupeKey && seen.has(dedupeKey))) reason = "duplicate";
      else if (excludeSameArtist && sameArtist(anchor, candidate)) reason = "same-artist";
      else if (excludeRated && exposure.ratedBefore) reason = "rated-before";
      else if (excludeKnown && exposure.known) reason = "known-track";
      else if (noveltyPolicy === "FRESH_ONLY" && exposure.known) reason = "not-fresh";
      else if (input.crossGenreAllowed === false && !genreCompatible(anchor, candidate)) reason = "genre-drift";
      if (reason === "duplicate") duplicateCount += 1;
      if (reason) {
        rejectedCount += 1;
        rejectionReasons[reason] = Number(rejectionReasons[reason] || 0) + 1;
        continue;
      }
      seen.add(key);
      if (dedupeKey) seen.add(dedupeKey);
      candidates.push({
        ...candidate,
        identityKey: key,
        exposure,
        sonicNeighbor: rawCandidate.sonicNeighbor || relationshipFromCandidate(rawCandidate)
      });
      if (candidates.length >= requestedCount) break;
    }
    if (noveltyPolicy === "PREFER_FRESH") {
      candidates.sort((left, right) => Number(left.exposure?.known) - Number(right.exposure?.known)
        || Number(right.sonicNeighbor?.similarity ?? -1) - Number(left.sonicNeighbor?.similarity ?? -1));
    }
    const id = sessionId();
    const createdAt = nowIso(clock);
    const diagnostics = diagnosticsFor(generated, {
      anchorIdentityKey,
      acceptedCount: candidates.length,
      rejectedCount,
      duplicateCount,
      excludeKnown,
      excludeRated,
      excludePreviouslyReviewed,
      excludeSameArtist,
      noveltyPolicy
    });
    diagnostics.rejectionReasons = rejectionReasons;
    diagnostics.requestedCount = requestedCount;
    diagnostics.generatedCount = Array.isArray(generated?.candidates) ? generated.candidates.length : 0;
    diagnostics.generationCount = generationCount;
    const anchorContext = {
      ...compactTrack(anchor),
      facts: factsForTrack(anchor),
      existingSonicProfile: readExistingEmbeddingSummary(anchor, model, modelVersion),
      existingReviewProfile: readAnchorProfile(anchor)
    };
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`
        INSERT INTO sonic_review_session (
          session_id, anchor_identity_key, anchor_json, requested_count, candidate_count,
          current_index, completed_count, skipped_count, queued_count, failed_count,
          status, review_policy, queue_policy, profile_policy, novelty_policy,
          model, model_version, diagnostics_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'READY', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        anchorIdentityKey,
        json(anchorContext),
        requestedCount,
        candidates.length,
        reviewPolicy,
        queuePolicy,
        profilePolicy,
        noveltyPolicy,
        model,
        modelVersion,
        json(diagnostics),
        createdAt,
        createdAt
      );
      const insertItem = db.prepare(`
        INSERT INTO sonic_review_session_item
          (session_id, item_index, candidate_identity_key, candidate_json, relation_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `);
      for (const [index, candidate] of candidates.entries()) {
        insertItem.run(id, index, candidate.identityKey, json(candidate), json(relationshipFromCandidate(candidate)), createdAt, createdAt);
      }
      audit(id, "SESSION_CREATED", null, null, { anchorIdentityKey, requestedCount, candidateCount: candidates.length });
      audit(id, "ANCHOR_SELECTED", null, null, { anchorIdentityKey });
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    logger?.info?.("[sonic-review-session] created", { sessionId: id, anchorIdentityKey, requestedCount, candidateCount: candidates.length });
    return getReviewSession(id, { includeDiagnostics: true, includeCurrent: true, includeAnchorContext: true });
  }

  function readExistingEmbeddingSummary(track, model, modelVersion) {
    try {
      const stored = recommendationEngine?.findStoredSonicProfile?.(track, { model, modelVersion });
      if (!stored) return null;
      return {
        identityKey: cleanText(stored.identityKey),
        model: cleanText(stored.model),
        modelVersion: cleanText(stored.modelVersion),
        dimensions: Number(stored.dimensions || 0) || null,
        sourceSha256: cleanText(stored.sourceSha256),
        updatedAt: cleanText(stored.updatedAt)
      };
    } catch {
      return null;
    }
  }

  function readAnchorProfile(track) {
    try {
      return recommendationEngine?.getSonicAnchorProfile?.({ anchor: track })?.profile || null;
    } catch {
      return null;
    }
  }

  function getReviewSession(id, options = {}) {
    const session = requireSession(id);
    const result = sessionSummary(session, options.includeDiagnostics === true);
    if (options.includeCurrent !== false) result.currentItem = compactItem(session, currentItem(session));
    if (options.includeAnchorContext) result.anchorContext = session.anchorContext;
    return result;
  }

  function getNextReviewItem(id) {
    const session = requireSession(id);
    return {
      ok: true,
      session: sessionSummary(session, false),
      item: compactItem(session, currentItem(session))
    };
  }

  function candidateItem(session, candidateIdentity) {
    const wanted = cleanText(candidateIdentity);
    return session.items.find((item) => !wanted || item.candidateIdentity === wanted) || null;
  }

  function safeNeighborEvidence(track, model, modelVersion) {
    try {
      const result = recommendationEngine?.findSonicNeighbors?.(track, 3, {
        model,
        modelVersion,
        analyzeIfMissing: false
      });
      return Array.isArray(result?.neighbors) ? result.neighbors.slice(0, 3).map((neighbor) => ({
        identityKey: cleanText(neighbor.identityKey || identityKeyFor(neighbor.track || {})),
        track: factsForTrack(neighbor.track || {}),
        cosineSimilarity: scalar(neighbor.similarity),
        rank: scalar(neighbor.rank)
      })) : [];
    } catch {
      return [];
    }
  }

  function readCandidateReviews(anchorIdentityKey, candidateIdentityKey, model, modelVersion) {
    try {
      return db.prepare(`
        SELECT rating, note, source_label AS sourceLabel, model, model_version AS modelVersion, created_at AS createdAt
        FROM sonic_neighbor_feedback
        WHERE anchor_identity_key = ? AND candidate_identity_key = ?
          AND model = ? AND model_version = ?
        ORDER BY id DESC LIMIT 5
      `).all(anchorIdentityKey, candidateIdentityKey, model, modelVersion).map((row) => ({
        rating: cleanText(row.rating),
        note: cleanText(row.note),
        sourceLabel: cleanText(row.sourceLabel),
        model: cleanText(row.model),
        modelVersion: cleanText(row.modelVersion),
        createdAt: cleanText(row.createdAt)
      }));
    } catch {
      return [];
    }
  }

  function getAssistantReviewContext(id, candidateIdentity = "") {
    const session = requireSession(id);
    if (session.model === "blind-listening") {
      const item = candidateItem(session, candidateIdentity) || currentItem(session);
      return { ok:true, blind:true, sessionId:id, anchor:compactTrack(session.anchorContext), item:compactItem(session,item),
        evidenceSummary:"Blind human listening batch. No model scores or inferred audio judgments are supplied.",
        instruction:"Human listening batch. Model identities, scores and inferred profiles are withheld. Use the blind listening controls to record actual listening decisions." };
    }
    const item = candidateItem(session, candidateIdentity) || currentItem(session);
    if (!item) throw new Error("This Sonic Review session has no pending candidate.");
    const anchor = hydrateTrack(session.anchorContext);
    const candidate = hydrateTrack(item.candidate);
    const anchorFacts = factsForTrack(anchor);
    const candidateFacts = factsForTrack(candidate);
    const anchorProfile = readAnchorProfile(anchor);
    const candidateProfile = readExistingEmbeddingSummary(candidate, session.model, session.modelVersion);
    const anchorEvidence = safeNeighborEvidence(anchor, session.model, session.modelVersion);
    const candidateEvidence = safeNeighborEvidence(candidate, session.model, session.modelVersion);
    const sonicRelationship = relationshipFromCandidate(item.candidate);
    const novelty = exposureFor(candidate);
    const context = {
      ok: true,
      sessionId: session.sessionId,
      itemIndex: item.index,
      anchor: {
        ...anchorFacts,
        existingSonicProfile: readExistingEmbeddingSummary(anchor, session.model, session.modelVersion),
        existingReviewProfile: anchorProfile
      },
      candidate: {
        ...candidateFacts,
        knownState: novelty,
        existingSonicProfile: candidateProfile,
        existingReviewProfile: readAnchorProfile(candidate)
      },
      sonicRelationship,
      tasteRelationship: {
        selectionScore: sonicRelationship.selectionScore,
        positiveCentroidSimilarity: sonicRelationship.positiveCentroidSimilarity,
        negativeCentroidSimilarity: sonicRelationship.negativeCentroidSimilarity,
        netMargin: sonicRelationship.netMargin,
        selectionMethod: sonicRelationship.selectionMethod,
        selectionArea: sonicRelationship.selectionArea
      },
      neighborhoodEvidence: {
        aroundAnchor: anchorEvidence,
        aroundCandidate: candidateEvidence,
        sharedArtists: normalized(anchor.artist) && normalized(anchor.artist) === normalized(candidate.artist) ? [anchor.artist] : [],
        sharedLabels: anchor.label && candidate.label && normalized(anchor.label) === normalized(candidate.label) ? [anchor.label] : []
      },
      existingReviews: {
        anchorProfile,
        candidateNeighborReviews: readCandidateReviews(session.anchorIdentity, item.candidateIdentity, session.model, session.modelVersion)
      },
      schemaHints: {
        profilePolicy: session.profilePolicy,
        decisionValues: makeReviewSchema().decisions,
        energy: { min: 1, max: 10, integer: true },
        rawEmbeddingsReturned: false
      },
      evidenceSummary: generateSummaryObject(session, item, anchor, candidate, sonicRelationship, novelty)
    };
    try {
      if (recommendationEngine?.analysisEvidenceFor) context.experimentalAudioEvidence = {
        estimated: true, productionApplied: false,
        anchor: recommendationEngine.analysisEvidenceFor(anchor), candidate: recommendationEngine.analysisEvidenceFor(candidate)
      };
    } catch { /* Optional analysis never prevents a review. */ }
    return context;
  }

  function generateSummaryObject(session, item, anchor, candidate, relationship, novelty) {
    const shared = [];
    if (anchor.genre && candidate.genre && normalized(anchor.genre) === normalized(candidate.genre)) shared.push(anchor.genre);
    if (anchor.subgenre && candidate.subgenre && normalized(anchor.subgenre) === normalized(candidate.subgenre)) shared.push(anchor.subgenre);
    if (anchor.label && candidate.label && normalized(anchor.label) === normalized(candidate.label)) shared.push(`label:${anchor.label}`);
    return {
      anchor: `${anchor.genre || "Genre unknown"}${anchor.bpm ? `, ${anchor.bpm} BPM` : ""}${anchor.key ? `, ${anchor.key}` : ""}${anchor.label ? `, ${anchor.label}` : ""}`,
      candidate: `${candidate.genre || "Genre unknown"}${candidate.bpm ? `, ${candidate.bpm} BPM` : ""}${candidate.key ? `, ${candidate.key}` : ""}`,
      similarity: relationship.cosineSimilarity ?? null,
      sharedTraits: shared,
      knownState: novelty,
      position: item.index + 1,
      text: [
        `Anchor: ${anchor.artist || "Unknown artist"} — ${anchor.title || "Unknown title"}`,
        `Candidate: ${candidate.artist || "Unknown artist"} — ${candidate.title || "Unknown title"}`,
        `Similarity: ${relationship.cosineSimilarity ?? "unknown"}`,
        shared.length ? `Shared evidence: ${shared.join(", ")}` : "Shared metadata evidence: none recorded",
        `Known state: ${novelty.known ? "known/exposed" : "unseen in tracked sources"}`
      ].join("\n")
    };
  }

  function generateReviewContextSummary(id, candidateIdentity = "") {
    const context = getAssistantReviewContext(id, candidateIdentity);
    return { ok: true, sessionId: context.sessionId, itemIndex: context.itemIndex, summary: context.evidenceSummary };
  }

  function listReviewSessions(options = {}) {
    const limit = safeLimit(options.limit, 20);
    const status = cleanText(options.status).toUpperCase();
    const rows = status && SESSION_STATUSES.includes(status)
      ? db.prepare("SELECT * FROM sonic_review_session WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit)
      : db.prepare("SELECT * FROM sonic_review_session ORDER BY updated_at DESC LIMIT ?").all(limit);
    return {
      ok: true,
      sessions: rows.map((row) => {
        const session = rowToSession(row);
        const items = db.prepare("SELECT status, error FROM sonic_review_session_item WHERE session_id = ? ORDER BY item_index ASC").all(session.sessionId);
        return sessionSummary({
          ...session,
          items: items.map((item, index) => ({ index, status: cleanText(item.status), error: cleanText(item.error) }))
        }, false);
      })
    };
  }

  function updateSessionForItems(sessionId, { status = null, completedAt = undefined } = {}) {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'REVIEWED' THEN 1 ELSE 0 END) AS completedCount,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) AS skippedCount,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failedCount,
        SUM(CASE WHEN queued_at IS NOT NULL AND queued_at <> '' THEN 1 ELSE 0 END) AS queuedCount,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pendingCount
      FROM sonic_review_session_item
      WHERE session_id = ?
    `).get(sessionId) || {};
    const session = requireSession(sessionId);
    const nextStatus = status || (Number(counts.pendingCount || 0) === 0 ? "COMPLETED" : session.status);
    const nextCompletedAt = completedAt !== undefined
      ? completedAt
      : (nextStatus === "COMPLETED" ? (session.completedAt || nowIso(clock)) : null);
    db.prepare(`
      UPDATE sonic_review_session
      SET completed_count = ?, skipped_count = ?, queued_count = ?, failed_count = ?,
          status = ?, completed_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(
      Number(counts.completedCount || 0),
      Number(counts.skippedCount || 0),
      Number(counts.queuedCount || 0),
      Number(counts.failedCount || 0),
      nextStatus,
      nextCompletedAt,
      nowIso(clock),
      sessionId
    );
    return requireSession(sessionId);
  }

  function normalizedDecision(value) {
    const decision = cleanText(value).toUpperCase().replace(/[ -]+/g, "_");
    return makeReviewSchema().decisions.includes(decision) ? decision : "";
  }

  function normalizedProfile(profile = {}) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("A structured Sonic Review profile is required.");
    }
    const energy = profile.energy === undefined || profile.energy === null || profile.energy === ""
      ? null
      : Number(profile.energy);
    if (energy !== null && (!Number.isInteger(energy) || energy < 1 || energy > 10)) {
      throw new Error("Sonic Review profile energy must be an integer from 1 to 10.");
    }
    const list = (value, max = 24) => unique(Array.isArray(value) ? value : [value]).slice(0, max);
    return {
      genreLane: cleanText(profile.genreLane || profile.genre || profile.area),
      subgenres: list(profile.subgenres || profile.subgenre || profile.styles),
      energy,
      moods: list(profile.moods || profile.mood),
      tags: list(profile.tags),
      preserveTraits: list(profile.preserveTraits),
      avoidTraits: list(profile.avoidTraits),
      similarityEmphasis: list(profile.similarityEmphasis),
      note: cleanText(profile.note || profile.listeningNote || profile.comment)
    };
  }

  function itemStatusForDecision(decision) {
    return ["SKIP", "REJECT", "DUPLICATE", "AMBIGUOUS"].includes(decision) ? "SKIPPED" : "REVIEWED";
  }

  function failedItem(sessionId, item, error) {
    const timestamp = nowIso(clock);
    const message = cleanText(error?.message || error) || "Sonic Review item failed.";
    db.prepare(`
      UPDATE sonic_review_session_item
      SET status = 'FAILED', error = ?, updated_at = ?
      WHERE session_id = ? AND item_index = ?
    `).run(message, timestamp, sessionId, item.index);
    audit(sessionId, "CANDIDATE_FAILED", item.index, { status: item.status }, { status: "FAILED", reason: message });
    updateSessionForItems(sessionId);
    return {
      ok: false,
      session: sessionSummary(requireSession(sessionId), false),
      failedItem: { index: item.index, candidateIdentity: item.candidateIdentity, reason: message },
      nextItem: compactItem(requireSession(sessionId), currentItem(requireSession(sessionId)))
    };
  }

  async function saveReviewItem(input = {}) {
    const session = requireSession(input.sessionId);
    if (session.model === "blind-listening") throw new Error("Use the blind listening controls; this batch cannot write inferred profiles or ratings.");
    const item = candidateItem(session, input.candidateIdentity) || currentItem(session);
    if (!item) throw new Error("This Sonic Review session has no candidate to save.");
    const decision = normalizedDecision(input.decision);
    if (!decision) throw new Error("A valid Sonic Review decision is required.");
    let profile;
    try {
      profile = normalizedProfile(input.profile || {});
    } catch (error) {
      return failedItem(session.sessionId, item, error);
    }
    const confidence = input.confidence === undefined || input.confidence === null || input.confidence === ""
      ? null
      : Number(input.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      return failedItem(session.sessionId, item, new Error("Sonic Review confidence must be between 0 and 1."));
    }
    try {
      if (!recommendationEngine || typeof recommendationEngine.saveSonicAnchorProfile !== "function") {
        throw new Error("Recommendation Engine v2 cannot save Sonic Review profiles.");
      }
      const savedProfile = recommendationEngine.saveSonicAnchorProfile({
        anchor: item.candidate,
        genre: profile.genreLane,
        subgenre: profile.subgenres[0] || "",
        energy: profile.energy,
        mood: profile.moods.join(", "),
        tags: profile.tags,
        note: profile.note || cleanText(input.note),
        sourceLabel: "mcp-synapse-sonic-review",
        model: session.model,
        modelVersion: session.modelVersion,
        rawJson: {
          sessionId: session.sessionId,
          candidateIdentity: item.candidateIdentity,
          decision,
          confidence,
          profile,
          evidenceSummary: input.evidenceSummary || null
        }
      });
      const status = itemStatusForDecision(decision);
      const review = {
        decision,
        confidence,
        profile,
        note: cleanText(input.note || profile.note),
        evidenceSummary: input.evidenceSummary || null,
        savedProfile: savedProfile?.profile || null
      };
      const timestamp = nowIso(clock);
      db.prepare(`
        UPDATE sonic_review_session_item
        SET status = ?, decision = ?, confidence = ?, review_json = ?, error = '', updated_at = ?
        WHERE session_id = ? AND item_index = ?
      `).run(status, decision, confidence, json(review), timestamp, session.sessionId, item.index);
      audit(session.sessionId, "PROFILE_SAVED", item.index, item.review, review);
      audit(session.sessionId, "CANDIDATE_REVIEWED", item.index, { status: item.status }, { status, decision, confidence });
      updateSessionForItems(session.sessionId);
      const updated = requireSession(session.sessionId);
      return {
        ok: true,
        mode: "shadow",
        globalTasteProfileUpdated: false,
        productionApplied: false,
        session: sessionSummary(updated, false),
        item: compactItem(updated, updated.items.find((entry) => entry.index === item.index)),
        nextItem: compactItem(updated, currentItem(updated))
      };
    } catch (error) {
      return failedItem(session.sessionId, item, error);
    }
  }

  async function advanceReviewSession(input = {}) {
    let session = requireSession(input.sessionId);
    if (session.model === "blind-listening") throw new Error("Use the blind listening controls to advance this batch.");
    if (input.review && typeof input.review === "object") {
      await saveReviewItem({ ...input.review, sessionId: session.sessionId });
      session = requireSession(session.sessionId);
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) {
      return { ok: true, session: sessionSummary(session, false), item: null };
    }
    const pointerItem = session.items.find((entry) => entry.index === session.currentIndex) || null;
    const item = currentItem(session);
    if (pointerItem?.status === "PENDING" && input.skipCurrent !== false) {
      const timestamp = nowIso(clock);
      db.prepare(`
        UPDATE sonic_review_session_item
        SET status = 'SKIPPED', error = ?, updated_at = ?
        WHERE session_id = ? AND item_index = ? AND status = 'PENDING'
      `).run(cleanText(input.reason || "advanced-without-review"), timestamp, session.sessionId, pointerItem.index);
      audit(session.sessionId, "CANDIDATE_SKIPPED", pointerItem.index, { status: pointerItem.status }, { status: "SKIPPED", reason: input.reason || "advanced-without-review" });
    }
    const updatedBeforePointer = updateSessionForItems(session.sessionId, {
      status: session.status === "READY" ? "RUNNING" : null
    });
    const next = updatedBeforePointer.items.find((entry) => entry.status === "PENDING" && entry.index >= (session.currentIndex ?? 0));
    const currentIndex = next?.index ?? updatedBeforePointer.items.find((entry) => entry.status === "PENDING")?.index ?? updatedBeforePointer.candidateCount;
    const updatedAt = nowIso(clock);
    db.prepare("UPDATE sonic_review_session SET current_index = ?, updated_at = ? WHERE session_id = ?").run(currentIndex, updatedAt, session.sessionId);
    audit(session.sessionId, "SESSION_ADVANCED", item?.index ?? null, { currentIndex: session.currentIndex }, { currentIndex });
    const finalSession = requireSession(session.sessionId);
    return { ok: true, session: sessionSummary(finalSession, false), item: compactItem(finalSession, currentItem(finalSession)) };
  }

  function queuePolicyAllows(session, item) {
    const policy = session.queuePolicy;
    if (policy === "NEVER") return "This session queue policy is NEVER.";
    const decision = cleanText(item.decision).toUpperCase();
    if (!decision) return "Save a Sonic Review decision before queueing this item.";
    if (policy === "STRONG_ONLY" && decision !== "STRONG_KEEP") return "This session only queues STRONG_KEEP items.";
    if (policy === "KEEP_AND_STRONG" && !["KEEP", "STRONG_KEEP"].includes(decision)) return "This session only queues KEEP or STRONG_KEEP items.";
    if (policy === "ALL_VALID" && ["SKIP", "REJECT", "DUPLICATE", "AMBIGUOUS", "REVIEW_MANUALLY"].includes(decision)) return "This session only queues valid non-rejected decisions.";
    return "";
  }

  async function queueReviewItem(input = {}) {
    const session = requireSession(input.sessionId);
    const item = candidateItem(session, input.candidateIdentity) || currentItem(session);
    if (!item) throw new Error("This Sonic Review session has no candidate to queue.");
    const policyError = queuePolicyAllows(session, item);
    if (policyError) throw new Error(policyError);
    if (typeof queueTracks !== "function") throw new Error("The existing Roon queue service is not available.");
    const mode = ["append", "next"].includes(cleanText(input.mode).toLowerCase()) ? cleanText(input.mode).toLowerCase() : "append";
    const result = await queueTracks([item.candidate], {
      mode,
      zoneId: input.zoneId,
      preferExtendedMixes: input.preferExtendedMixes !== false,
      matchPolicy: "strict",
      allowBridge: true,
      source: "sonic-review-mcp"
    });
    const queuedCount = Number(result?.queuedCount || result?.queued?.length || 0);
    const timestamp = nowIso(clock);
    if (queuedCount > 0) {
      db.prepare("UPDATE sonic_review_session_item SET queued_at = ?, error = '', updated_at = ? WHERE session_id = ? AND item_index = ?").run(timestamp, timestamp, session.sessionId, item.index);
      audit(session.sessionId, "CANDIDATE_QUEUED", item.index, { queuedAt: item.queuedAt || null }, { queuedAt: timestamp, mode });
    } else {
      const reason = cleanText(result?.failed?.[0]?.reason || "Roon did not queue this item.");
      db.prepare("UPDATE sonic_review_session_item SET error = ?, updated_at = ? WHERE session_id = ? AND item_index = ?").run(`queue: ${reason}`, timestamp, session.sessionId, item.index);
      audit(session.sessionId, "CANDIDATE_QUEUE_FAILED", item.index, null, { reason });
    }
    const updated = updateSessionForItems(session.sessionId);
    return { ok: queuedCount > 0, mode: "shadow", queue: result, session: sessionSummary(updated, false), item: compactItem(updated, updated.items.find((entry) => entry.index === item.index)) };
  }

  async function rateReviewItem(input = {}) {
    if (requireSession(input.sessionId).model === "blind-listening") throw new Error("Blind listening decisions do not write global ratings.");
    const session = requireSession(input.sessionId);
    const item = candidateItem(session, input.candidateIdentity) || currentItem(session);
    if (!item) throw new Error("This Sonic Review session has no candidate to rate.");
    const aliases = { LOVE: "love", LIKE: "like", OKAY: "ok", OK: "ok", DISLIKE: "dislike", NEVER_AGAIN: "never" };
    const rating = aliases[cleanText(input.rating).toUpperCase().replace(/[ -]+/g, "_")];
    if (!rating) throw new Error("Rating must be LOVE, LIKE, OKAY, DISLIKE, or NEVER_AGAIN.");
    if (typeof recordRating !== "function") throw new Error("The existing Rabbit Hole rating service is not available.");
    const result = await recordRating(item.candidate, rating, { sessionId: session.sessionId, source: "MCP" });
    const previousReview = item.review || {};
    const review = { ...previousReview, rating };
    db.prepare("UPDATE sonic_review_session_item SET review_json = ?, updated_at = ? WHERE session_id = ? AND item_index = ?").run(json(review), nowIso(clock), session.sessionId, item.index);
    audit(session.sessionId, "RATING_WRITTEN", item.index, previousReview, { rating });
    const updated = requireSession(session.sessionId);
    return { ok: true, rating, ratingResult: result, session: sessionSummary(updated, false), item: compactItem(updated, updated.items.find((entry) => entry.index === item.index)) };
  }

  function cancelReviewSession(id) {
    const session = requireSession(id);
    if (session.model === "blind-listening") throw new Error("Close the blind listening batch to stop; saved progress is retained.");
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) return getReviewSession(id);
    const updatedAt = nowIso(clock);
    db.prepare("UPDATE sonic_review_session SET status = 'CANCELLED', updated_at = ? WHERE session_id = ?").run(updatedAt, session.sessionId);
    audit(session.sessionId, "SESSION_CANCELLED", null, { status: session.status }, { status: "CANCELLED" });
    return getReviewSession(session.sessionId);
  }

  function setSessionStatus(id, nextStatus) {
    const session = requireSession(id);
    if (session.model === "blind-listening") throw new Error("Close or reopen the blind listening batch to pause or resume.");
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) {
      throw new Error(`Sonic Review session is already ${session.status}.`);
    }
    const status = validOrDefault(nextStatus, SESSION_STATUSES, nextStatus);
    if (!SESSION_STATUSES.includes(status)) throw new Error(`Invalid Sonic Review session status: ${nextStatus}.`);
    const updatedAt = nowIso(clock);
    const diagnostics = {
      ...session.diagnostics,
      ...(status === "RUNNING" && session.status === "PAUSED" ? {
        progressResumed: true,
        resumedAt: updatedAt
      } : {})
    };
    db.prepare("UPDATE sonic_review_session SET status = ?, diagnostics_json = ?, updated_at = ? WHERE session_id = ?").run(status, json(diagnostics), updatedAt, session.sessionId);
    audit(session.sessionId, status === "PAUSED" ? "SESSION_PAUSED" : "SESSION_RESUMED", null, { status: session.status }, { status });
    return getReviewSession(session.sessionId, { includeDiagnostics: false, includeCurrent: true });
  }

  function pauseReviewSession(id) {
    return setSessionStatus(id, "PAUSED");
  }

  function resumeReviewSession(id) {
    return setSessionStatus(id, "RUNNING");
  }

  return {
    constants: {
      SESSION_STATUSES,
      REVIEW_POLICIES,
      QUEUE_POLICIES,
      NOVELTY_POLICIES
    },
    startReviewSession,
    getReviewSession,
    getNextReviewItem,
    getAssistantReviewContext,
    generateReviewContextSummary,
    getReviewSchema: () => makeReviewSchema(),
    listReviewSessions,
    pauseReviewSession,
    resumeReviewSession,
    saveReviewItem,
    advanceReviewSession,
    queueReviewItem,
    rateReviewItem,
    cancelReviewSession
  };
}

module.exports = {
  createSonicReviewSessionService,
  makeReviewSchema,
  SESSION_STATUSES,
  REVIEW_POLICIES,
  QUEUE_POLICIES,
  NOVELTY_POLICIES
};
