"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../src/config");
const { MusicMemoryStore, cleanIsrc, normalizeText, trackIdentityKey } = require("../src/musicMemoryStore");

const DATA_DIR = path.join(__dirname, "..", "data");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function eventIdPart(value) {
  return cleanText(value).replace(/[\s:|]+/g, "_") || "none";
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isoTime(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const text = cleanText(value);
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return new Date(fallback).toISOString();
}

function tidalIdFromUrl(value = "") {
  const match = cleanText(value).match(/tidal\.com\/(?:browse\/)?track\/(\d+)/i);
  return match ? match[1] : "";
}

function versionFromTitle(title = "") {
  const matches = [...cleanText(title).matchAll(/\(([^)]*\b(?:mix|remix|edit|version|dub|rework|rerub)[^)]*)\)/gi)];
  return cleanText(matches.at(-1)?.[1] || "");
}

function compactTrack(input = {}) {
  const tidal = input.tidal || {};
  const metadata = input.metadataEnrichment || input.metadata_enrichment || {};
  const beatport = input.beatport || metadata.beatport || {};
  const roon = input.roon || {};
  const tidalUrl = cleanText(input.tidalUrl || tidal.tidalUrl || metadata.tidalUrl);
  const tidalId = cleanText(input.tidalId || input.tidalTrackId || tidal.id || tidal.trackId || tidalIdFromUrl(tidalUrl));
  const title = cleanText(input.title || tidal.title || metadata.title || roon.match?.title);
  const artist = cleanText(input.artist || tidal.artist || metadata.artist || roon.match?.subtitle);
  return {
    tidalId,
    roonIdentity: cleanText(input.roonIdentity || input.queueToken || input.verifiedQueueToken || roon.itemKey || roon.match?.item_key),
    beatportTrackId: cleanText(input.beatportTrackId || beatport.id),
    musicBrainzId: cleanText(input.musicBrainzId || input.musicbrainz_id),
    discogsId: cleanText(input.discogsId || input.discogs_id),
    isrc: cleanIsrc(input.isrc || tidal.isrc || metadata.isrc || beatport.isrc),
    artist,
    title,
    mixName: cleanText(input.mixName || input.version || tidal.version || metadata.mixName || beatport.mixName || versionFromTitle(title)),
    album: cleanText(input.album || tidal.album || metadata.album),
    label: cleanText(input.label || tidal.label || metadata.label),
    releaseDate: cleanText(input.releaseDate || tidal.releaseDate || metadata.releaseDate),
    durationMs: Number(input.durationMs || tidal.durationMs || metadata.durationMs || beatport.durationMs || 0) || null
  };
}

function addTrack(collection, sourceFile, source, item, index, options = {}) {
  const track = compactTrack(item.track || item);
  const key = trackIdentityKey(track);
  if (!key) {
    collection.unmapped.push({ sourceFile, source, index, reason: "missing stable identity and artist/title", raw: item });
    return null;
  }
  const observedAt = isoTime(options.observedAt ?? item.at ?? item.timestamp ?? item.updatedAt ?? item.lastSeenAt ?? item.firstSeenAt);
  collection.tracks.push({
    key,
    track: {
      ...track,
      observedAt,
      firstSeenAt: item.firstSeenAt || observedAt,
      lastSeenAt: item.lastSeenAt || observedAt
    },
    sourceFile,
    raw: item,
    observedAt
  });
  if (source) {
    collection.observations.push({
      key,
      track,
      source,
      context: cleanText(options.context || item.discoveryLane || item.sourceType),
      observedAt,
      count: Math.max(1, Number(options.count || item.seenCount || 1) || 1),
      sourceEventId: `${sourceFile}:observation:${eventIdPart(source)}:${eventIdPart(index)}:${eventIdPart(key)}`,
      raw: item
    });
  }
  return track;
}

function addEnrichment(collection, sourceFile, provider, item, index) {
  const track = compactTrack(item.track || item);
  const key = trackIdentityKey(track);
  if (!key) {
    collection.unmapped.push({ sourceFile, source: `${provider}_enrichment`, index, reason: "enrichment missing track identity", raw: item });
    return;
  }
  const fetchedAt = isoTime(item.fetchedAt || item.updatedAt || item.artworkCheckedAt);
  collection.enrichments.push({
    key,
    track,
    provider,
    sourceEventId: `${sourceFile}:enrichment:${eventIdPart(provider)}:${eventIdPart(index)}:${eventIdPart(key)}`,
    fetchedAt,
    raw: item,
    data: {
      providerTrackId: cleanText(item.id || item.trackId || item.beatport?.id),
      genre: cleanText(item.genre || item.beatport?.genre),
      subGenre: cleanText(item.subGenre || item.subgenre || item.beatport?.subGenre),
      tags: item.beatportTags || item.musicBrainzTags || item.tags || [],
      bpm: item.bpm || item.beatport?.bpm,
      keyName: item.keyName || item.beatport?.keyName,
      camelot: item.camelot || item.beatport?.camelot,
      label: item.label,
      album: item.album,
      releaseDate: item.releaseDate,
      releaseId: item.releaseId,
      durationMs: item.durationMs,
      isrc: item.isrc || item.beatport?.isrc,
      confidence: item.confidence,
      rawJson: item
    }
  });
  if (provider === "beatport" || item.beatport) {
    collection.beatport.push({
      key,
      track,
      confidence: Number(item.confidence || 0),
      data: {
        id: cleanText(item.beatport?.id || item.id),
        artist: track.artist,
        title: track.title,
        mixName: track.mixName,
        genre: cleanText(item.beatport?.genre || item.genre),
        subGenre: cleanText(item.beatport?.subGenre || item.subGenre || item.subgenre),
        beatportTags: item.beatportTags || [item.beatport?.genre, item.beatport?.subGenre].filter(Boolean),
        bpm: item.beatport?.bpm || item.bpm,
        keyName: item.beatport?.keyName || item.keyName,
        camelot: item.beatport?.camelot || item.camelot,
        label: item.label,
        album: item.album,
        releaseDate: item.releaseDate,
        releaseId: item.releaseId,
        durationMs: item.durationMs,
        isrc: item.beatport?.isrc || item.isrc,
        beatportUrl: item.beatport?.url || item.beatportUrl,
        rawJson: item
      }
    });
  }
}

function addAttempt(collection, sourceFile, provider, item, index) {
  const track = compactTrack(item.track || item);
  const key = trackIdentityKey(track);
  if (!key) return;
  const status = cleanText(item.status) || "unknown";
  const fetchedAt = isoTime(item.updatedAt || item.fetchedAt);
  collection.attempts.push({
    key,
    track,
    provider,
    status,
    confidence: item.confidence,
    fetchedAt,
    nextRetryAt: item.nextRetryAt,
    error: item.error || item.reason || item.confidenceReason,
    sourceEventId: `${sourceFile}:attempt:${eventIdPart(provider)}:${eventIdPart(index)}:${eventIdPart(key)}:${eventIdPart(status)}`,
    raw: item
  });
}

function addFeedback(collection, sourceFile, item, keyHint, index) {
  const track = compactTrack(item.track || item);
  const key = trackIdentityKey(track) || cleanText(keyHint);
  if (!key || !trackIdentityKey(track)) {
    collection.unmapped.push({ sourceFile, source: "feedback", index, reason: "feedback missing track identity", raw: item });
    return;
  }
  const createdAt = isoTime(item.updatedAt || item.createdAt || item.calibration?.recordedAt);
  collection.feedback.push({
    key,
    track,
    rating: cleanText(item.rating || item.feedback),
    context: cleanText(item.context || item.sourceType || (item.isLiveRadio ? "live_radio" : item.isRadio ? "radio" : "")),
    sourceLabel: cleanText(item.discoverySource || item.source || item.calibration?.source),
    prompt: cleanText(item.prompt || item.request),
    score: item.score,
    calibrationIssue: cleanText(item.calibration?.issue),
    createdAt,
    sourceEventId: `${sourceFile}:feedback:${eventIdPart(index)}:${eventIdPart(key)}:${eventIdPart(item.rating || item.feedback)}`,
    raw: item
  });
}

function emptyCollection() {
  return {
    sources: [],
    tracks: [],
    observations: [],
    feedback: [],
    enrichments: [],
    beatport: [],
    attempts: [],
    unmapped: []
  };
}

function applyStrongIdentityAliases(c) {
  const tidalByIsrc = new Map();
  for (const item of c.tracks) {
    if (item.track.tidalId && item.track.isrc) tidalByIsrc.set(item.track.isrc, item.track.tidalId);
  }
  const apply = (item) => {
    if (!item?.track || item.track.tidalId || !item.track.isrc) return;
    const tidalId = tidalByIsrc.get(item.track.isrc);
    if (!tidalId) return;
    item.track = { ...item.track, tidalId };
    item.key = trackIdentityKey(item.track);
    if (item.sourceEventId) item.sourceEventId = item.sourceEventId.replace(/(?:isrc|text|roon)_[^:]+/, eventIdPart(item.key));
  };
  for (const list of [c.tracks, c.observations, c.feedback, c.enrichments, c.beatport, c.attempts]) {
    list.forEach(apply);
  }
  return c;
}

function collectFromData(dataDir = DATA_DIR) {
  const c = emptyCollection();
  const source = (name) => path.join(dataDir, name);
  const load = (name) => {
    const json = readJson(source(name));
    if (json) c.sources.push(name);
    return json;
  };

  const trackMemory = load("track-memory.json");
  asArray(trackMemory?.entries).forEach((entry, index) => {
    addTrack(c, "track-memory.json", "track_memory", entry, index, { observedAt: entry.lastSeenAt, count: entry.seenCount });
    if (entry.feedback) addFeedback(c, "track-memory.json", entry, entry.key, index);
  });

  const taste = load("taste-profile.json");
  Object.entries(taste?.feedback || {}).forEach(([key, entry], index) => addFeedback(c, "taste-profile.json", entry, key, index));
  Object.entries(taste?.candidates || {}).forEach(([key, entry], index) => addTrack(c, "taste-profile.json", "taste_candidate", entry, index, { observedAt: entry.savedAt, context: key }));

  const metadata = load("metadata-enrichment-cache.json");
  asArray(metadata?.entries).forEach((entry, index) => {
    addTrack(c, "metadata-enrichment-cache.json", "metadata_cache", entry, index, { observedAt: entry.updatedAt });
    if (entry.status === "found") addEnrichment(c, "metadata-enrichment-cache.json", entry.source || "metadata", entry, index);
    addAttempt(c, "metadata-enrichment-cache.json", entry.source || "metadata", entry, index);
  });

  const discovery = load("discovery-history.json");
  asArray(discovery?.entries).forEach((entry, index) => addTrack(c, "discovery-history.json", "discovery_history", entry, index, { observedAt: entry.lastSeenAt || entry.firstSeenAt }));

  const listening = load("listening-history.json");
  asArray(listening?.plays).forEach((play, index) => addTrack(c, "listening-history.json", play.isLiveRadio ? "live_radio" : "now_playing", play, index, { observedAt: play.at || play.lastSeenAt || play.timestamp }));

  const standbyActivity = load("standby-activity.json");
  asArray(standbyActivity?.entries).forEach((entry, index) => addTrack(c, "standby-activity.json", entry.kind || "standby_activity", entry, index, { observedAt: entry.at, context: entry.kind }));

  const standby = load("standby-candidates.json");
  asArray(standby?.candidates).forEach((entry, index) => addTrack(c, "standby-candidates.json", "standby_candidate", entry, index, { observedAt: entry.standbyUpdatedAt || standby.updatedAt, context: entry.standbyLane }));
  asArray(standby?.standbyHistory).forEach((history, hIndex) => {
    asArray(history.tracks).forEach((track, tIndex) => addTrack(c, "standby-candidates.json", "standby_history", track, `${hIndex}.${tIndex}`, { observedAt: history.timestamp, context: `rank:${track.rank || ""}` }));
  });

  const session = load("last-session.json");
  for (const field of ["tracks", "alternates", "discarded"]) {
    asArray(session?.result?.[field]).forEach((track, index) => addTrack(c, "last-session.json", `last_session_${field}`, track, index, { observedAt: session.updatedAt }));
  }

  const exact = load("last-exact-verification.json");
  asArray(exact?.tracks).forEach((row, index) => addTrack(c, "last-exact-verification.json", "exact_verification", row.track || row.tidal || row, index, { observedAt: exact.updatedAt }));
  asArray(exact?.usable).forEach((track, index) => addTrack(c, "last-exact-verification.json", "exact_usable", track, `usable.${index}`, { observedAt: exact.updatedAt }));

  const pending = load("exact-bridge-pending.json");
  asArray(pending?.tracks).forEach((row, index) => addTrack(c, "exact-bridge-pending.json", "exact_bridge_pending", row.track || row, index, { observedAt: pending.updatedAt }));

  const queueAttempts = load("queue-attempts.json");
  asArray(queueAttempts?.attempts).forEach((attempt, aIndex) => {
    asArray(attempt.requestedTracks).forEach((track, index) => addTrack(c, "queue-attempts.json", "queue_requested", track, `${aIndex}.requested.${index}`, { observedAt: attempt.at, context: attempt.source }));
    asArray(attempt.queuedTracks).forEach((track, index) => addTrack(c, "queue-attempts.json", "queued", track, `${aIndex}.queued.${index}`, { observedAt: attempt.at, context: attempt.source }));
    asArray(attempt.failedTracks).forEach((track, index) => addTrack(c, "queue-attempts.json", "queue_failed", track, `${aIndex}.failed.${index}`, { observedAt: attempt.at, context: attempt.source }));
  });

  const playlists = load("saved-playlist.json");
  asArray(playlists?.lists).forEach((list, lIndex) => {
    asArray(list.tracks).forEach((track, index) => addTrack(c, "saved-playlist.json", "saved_playlist", track, `${lIndex}.${index}`, { observedAt: track.updatedAt || list.updatedAt, context: list.name }));
  });

  const graph = load("rabbit-hole-cache.json");
  asArray(graph?.entries).forEach((entry, index) => {
    if (entry.graph?.seed) addTrack(c, "rabbit-hole-cache.json", "rabbit_hole_graph_seed", entry.graph.seed, index, { observedAt: entry.graph.updatedAt || entry.updatedAtMs });
  });

  const playlistCache = load("tidal-playlist-track-cache.json");
  asArray(playlistCache?.playlists).forEach((playlist, pIndex) => {
    const trackMaps = playlist.tracksByProviderId || [];
    for (const pair of trackMaps) {
      const id = Array.isArray(pair) ? pair[0] : "";
      const track = Array.isArray(pair) ? pair[1] : null;
      if (track) addTrack(c, "tidal-playlist-track-cache.json", "tidal_playlist_cache", { ...track, tidalId: id || track.id }, `${pIndex}.${id}`, { observedAt: playlist.updatedAt || playlistCache.updatedAt, context: playlist.playlistId });
    }
  });

  return applyStrongIdentityAliases(c);
}

function compactSampleTrack(track = {}) {
  return {
    artist: track.artist || null,
    title: track.title || null,
    album: track.album || null,
    tidalId: track.tidalId || track.tidal?.id || null,
    isrc: track.isrc || track.tidal?.isrc || null,
    roonIdentity: track.roonIdentity || track.roon?.identity || null
  };
}

function analyzeCollection(c, options = {}) {
  const sampleLimit = Number.isFinite(options.sampleLimit) ? Math.max(0, options.sampleLimit) : 10;
  const unique = new Map();
  let duplicateTrackEvents = 0;
  const ambiguous = [];
  for (const item of c.tracks) {
    const previous = unique.get(item.key);
    if (previous) {
      duplicateTrackEvents += 1;
      const artistA = normalizeText(previous.track.artist);
      const artistB = normalizeText(item.track.artist);
      const titleA = normalizeText(previous.track.title);
      const titleB = normalizeText(item.track.title);
      if (artistA && artistB && titleA && titleB && (artistA !== artistB || titleA !== titleB)) {
        ambiguous.push({
          key: item.key,
          left: compactSampleTrack(previous.track),
          right: compactSampleTrack(item.track),
          sourceFile: item.sourceFile
        });
      }
    } else {
      unique.set(item.key, item);
    }
  }
  const enrichedKeys = new Set(c.enrichments.map((item) => item.key));
  return {
    sources: c.sources,
    tracksFound: c.tracks.length,
    uniqueIdentities: unique.size,
    duplicates: duplicateTrackEvents,
    ambiguousMatches: ambiguous.length,
    observations: c.observations.length,
    feedbackEvents: c.feedback.length,
    enrichmentRecords: c.enrichments.length,
    beatportRecords: c.beatport.length,
    enrichmentAttempts: c.attempts.length,
    unmapped: c.unmapped.length,
    tracksLackingEnrichment: [...unique.keys()].filter((key) => !enrichedKeys.has(key)).length,
    ambiguousSamples: ambiguous.slice(0, sampleLimit),
    unmappedSamples: c.unmapped.slice(0, sampleLimit).map((item) => ({
      sourceFile: item.sourceFile,
      source: item.source,
      index: item.index,
      reason: item.reason,
      track: compactSampleTrack(item.raw || item.track || {})
    }))
  };
}

function normalizeExistingTidalUrlIdentities(store) {
  const rows = store.db.prepare("SELECT * FROM track_identity WHERE tidal_id LIKE '%tidal.com/%' OR identity_key LIKE 'tidal:http%'").all();
  const updateChildTable = (table, sourceId, targetId) => {
    store.db.prepare(`UPDATE ${table} SET track_identity_id = ? WHERE track_identity_id = ?`).run(targetId, sourceId);
  };
  const mergeBeatport = (sourceId, targetId) => {
    const source = store.db.prepare("SELECT track_identity_id FROM beatport_enrichment WHERE track_identity_id = ?").get(sourceId);
    if (!source) return;
    const target = store.db.prepare("SELECT track_identity_id FROM beatport_enrichment WHERE track_identity_id = ?").get(targetId);
    if (target) store.db.prepare("DELETE FROM beatport_enrichment WHERE track_identity_id = ?").run(sourceId);
    else store.db.prepare("UPDATE beatport_enrichment SET track_identity_id = ? WHERE track_identity_id = ?").run(targetId, sourceId);
  };
  let normalized = 0;
  let merged = 0;
  let ambiguous = 0;
  for (const row of rows) {
    const tidalId = cleanText(row.tidal_id).match(/tidal\.com\/(?:browse\/)?track\/(\d+)/i)?.[1]
      || cleanText(row.identity_key).match(/tidal:https?:\/\/[^/]+\/(?:browse\/)?track\/(\d+)/i)?.[1]
      || "";
    if (!tidalId) {
      ambiguous += 1;
      continue;
    }
    const targetKey = `tidal:${tidalId}`;
    const target = store.db.prepare("SELECT * FROM track_identity WHERE identity_key = ? AND id <> ?").get(targetKey, row.id);
    if (!target) {
      store.db.prepare("UPDATE track_identity SET identity_key = ?, tidal_id = ? WHERE id = ?").run(targetKey, tidalId, row.id);
      normalized += 1;
      continue;
    }
    updateChildTable("track_observation", row.id, target.id);
    updateChildTable("taste_feedback", row.id, target.id);
    updateChildTable("provider_enrichment", row.id, target.id);
    updateChildTable("enrichment_attempt", row.id, target.id);
    mergeBeatport(row.id, target.id);
    store.db.prepare(`
      UPDATE track_identity
      SET
        roon_identity = COALESCE(NULLIF(roon_identity, ''), ?),
        isrc = COALESCE(NULLIF(isrc, ''), ?),
        artist = COALESCE(NULLIF(artist, ''), ?),
        title = COALESCE(NULLIF(title, ''), ?),
        mix_version = COALESCE(NULLIF(mix_version, ''), ?),
        album = COALESCE(NULLIF(album, ''), ?),
        duration_ms = COALESCE(duration_ms, ?),
        first_seen_at = MIN(first_seen_at, ?),
        last_seen_at = MAX(last_seen_at, ?)
      WHERE id = ?
    `).run(
      row.roon_identity || "",
      row.isrc || "",
      row.artist || "",
      row.title || "",
      row.mix_version || "",
      row.album || "",
      row.duration_ms || null,
      row.first_seen_at,
      row.last_seen_at,
      target.id
    );
    store.db.prepare("DELETE FROM track_identity WHERE id = ?").run(row.id);
    merged += 1;
  }
  return { normalized, merged, ambiguous };
}

function pruneDuplicateRows(store) {
  const prune = (table, columns) => {
    const rows = store.db.prepare(`SELECT id, source_event_id, ${columns.join(", ")} FROM ${table} ORDER BY id`).all();
    const seen = new Map();
    const deleteIds = [];
    const isPreferredEventId = (row) => !/\d{4}-\d{2}-\d{2}T\d{2}[:_]\d{2}[:_]\d{2}/.test(row.source_event_id || "")
      && /:(?:observation|feedback|enrichment|attempt):/.test(row.source_event_id || "");
    for (const row of rows) {
      const hash = crypto.createHash("sha256");
      columns.forEach((column) => {
        hash.update(String(row[column] ?? ""));
        hash.update("\0");
      });
      const key = hash.digest("hex");
      const previous = seen.get(key);
      if (!previous) {
        seen.set(key, row);
      } else if (isPreferredEventId(row) && !isPreferredEventId(previous)) {
        deleteIds.push(previous.id);
        seen.set(key, row);
      } else {
        deleteIds.push(row.id);
      }
    }
    if (deleteIds.length) {
      const statement = store.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      deleteIds.forEach((id) => statement.run(id));
    }
    return deleteIds.length;
  };
  const recalculateTrackIdentityStats = () => {
    const observedCounts = store.db.prepare(`
      SELECT track_identity_id, SUM(count) AS count
      FROM track_observation
      GROUP BY track_identity_id
    `).all();
    store.db.prepare("UPDATE track_identity SET observation_count = 0").run();
    const updateObservationCount = store.db.prepare("UPDATE track_identity SET observation_count = ? WHERE id = ?");
    observedCounts.forEach((row) => updateObservationCount.run(Number(row.count || 0), row.track_identity_id));

    const timestamps = [
      ...store.db.prepare("SELECT track_identity_id, observed_at AS ts FROM track_observation").all(),
      ...store.db.prepare("SELECT track_identity_id, created_at AS ts FROM taste_feedback").all(),
      ...store.db.prepare("SELECT track_identity_id, fetched_at AS ts FROM provider_enrichment").all(),
      ...store.db.prepare("SELECT track_identity_id, fetched_at AS ts FROM enrichment_attempt").all(),
      ...store.db.prepare("SELECT track_identity_id, fetched_at AS ts FROM beatport_enrichment").all()
    ];
    const byTrack = new Map();
    timestamps.forEach((row) => {
      if (!row.track_identity_id || !row.ts) return;
      const current = byTrack.get(row.track_identity_id) || { first: row.ts, last: row.ts };
      if (row.ts < current.first) current.first = row.ts;
      if (row.ts > current.last) current.last = row.ts;
      byTrack.set(row.track_identity_id, current);
    });
    const updateTimes = store.db.prepare("UPDATE track_identity SET first_seen_at = ?, last_seen_at = ? WHERE id = ?");
    byTrack.forEach((value, trackId) => updateTimes.run(value.first, value.last, trackId));
  };
  const removed = {
    normalizedTidalUrlIdentities: normalizeExistingTidalUrlIdentities(store),
    observations: prune("track_observation", ["track_identity_id", "source", "context", "count", "raw_json"]),
    feedback: prune("taste_feedback", ["track_identity_id", "rating", "context", "source_label", "prompt", "score", "calibration_issue", "raw_json"]),
    providerEnrichment: prune("provider_enrichment", ["track_identity_id", "provider", "provider_track_id", "genre", "subgenre", "tags", "bpm", "key_name", "camelot", "label", "release_title", "release_date", "release_id", "duration_ms", "isrc", "confidence", "raw_json"]),
    enrichmentAttempts: prune("enrichment_attempt", ["track_identity_id", "provider", "status", "confidence", "error", "raw_json"])
  };
  recalculateTrackIdentityStats();
  return removed;
}

function writeBackfill(c, dbFile) {
  const store = new MusicMemoryStore({ dbFile, logger: console });
  const before = store.status();
  let prunedBefore = null;
  let prunedAfter = null;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    prunedBefore = pruneDuplicateRows(store);
    c.tracks.forEach((item) => store.upsertTrackIdentity(item.track));
    c.observations.forEach((item) => store.rememberObservation(item.track, item.source, {
      sourceEventId: item.sourceEventId,
      context: item.context,
      observedAt: item.observedAt,
      count: item.count,
      rawJson: item.raw
    }));
    c.feedback.forEach((item) => store.saveTasteFeedback(item.track, {
      sourceEventId: item.sourceEventId,
      rating: item.rating,
      context: item.context,
      sourceLabel: item.sourceLabel,
      prompt: item.prompt,
      score: item.score,
      calibrationIssue: item.calibrationIssue,
      createdAt: item.createdAt,
      rawJson: item.raw
    }));
    c.enrichments.forEach((item) => store.saveProviderEnrichment(item.track, item.provider, {
      ...item.data,
      sourceEventId: item.sourceEventId,
      fetchedAt: item.fetchedAt
    }));
    c.beatport.forEach((item) => store.saveBeatportEnrichment(item.track, item.data, { confidence: item.confidence }));
    c.attempts.forEach((item) => store.saveEnrichmentAttempt(item.track, item.provider, {
      sourceEventId: item.sourceEventId,
      status: item.status,
      confidence: item.confidence,
      fetchedAt: item.fetchedAt,
      nextRetryAt: item.nextRetryAt,
      error: item.error,
      rawJson: item.raw
    }));
    prunedAfter = pruneDuplicateRows(store);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    store.close();
    throw error;
  }
  const after = store.status();
  store.close();
  return { before, after, prunedBefore, prunedAfter };
}

function parseArgs(argv) {
  const args = { write: false, dataDir: DATA_DIR, dbFile: config.musicMemory.dbFile, sampleLimit: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--dry-run") args.write = false;
    else if (arg === "--data-dir") args.dataDir = path.resolve(argv[++index]);
    else if (arg === "--db") args.dbFile = path.resolve(argv[++index]);
    else if (arg === "--sample-limit") {
      const value = Number(argv[++index]);
      if (Number.isFinite(value)) args.sampleLimit = value;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const collection = collectFromData(args.dataDir);
  const dryRun = analyzeCollection(collection, { sampleLimit: args.sampleLimit });
  console.log(JSON.stringify({
    mode: args.write ? "write" : "dry-run",
    dataDir: args.dataDir,
    dbFile: args.dbFile,
    dryRun
  }, null, 2));
  if (!args.write) return;
  const write = writeBackfill(collection, args.dbFile);
  const rerun = writeBackfill(collection, args.dbFile);
  console.log(JSON.stringify({
    write,
    idempotencyCheck: {
      beforeSecondRun: rerun.before,
      afterSecondRun: rerun.after,
      duplicateGrowth: {
        tracks: rerun.after.trackCount - rerun.before.trackCount,
        observations: rerun.after.observationCount - rerun.before.observationCount,
        feedback: rerun.after.feedbackCount - rerun.before.feedbackCount,
        providerEnrichment: rerun.after.providerEnrichmentCount - rerun.before.providerEnrichmentCount,
        enrichmentAttempts: rerun.after.enrichmentAttemptCount - rerun.before.enrichmentAttemptCount
      }
    }
  }, null, 2));
}

if (require.main === module) main();

module.exports = {
  analyzeCollection,
  collectFromData,
  compactTrack,
  writeBackfill
};
