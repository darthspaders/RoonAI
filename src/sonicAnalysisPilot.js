"use strict";
const { existsSync } = require("node:fs");
const { hash } = require("./sonicAnalysisSpec");
const normalize = x => String(x || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function recordingGroup(track) {
  // Evaluation grouping only. No identity merges. Keep the complete versioned
  // title in this conservative fallback; never discard remix/edit descriptors.
  return hash([normalize(track.artist), normalize(track.title), normalize(track.mixVersion)].join("|"));
}
function buildAnalysisPilot(db, { limit = 200 } = {}) {
  limit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200)));
  const rows = db.prepare(`SELECT ti.*,m.id AS local_file_id,m.file_path,m.file_hash,m.genre AS local_genre,
    (SELECT rating FROM taste_feedback f WHERE f.track_identity_id=ti.id ORDER BY created_at DESC,id DESC LIMIT 1) AS rating,
    EXISTS(SELECT 1 FROM sonic_neighbor_feedback f WHERE f.anchor_identity_key=ti.identity_key OR f.candidate_identity_key=ti.identity_key) AS reviewed
    FROM local_library_file m JOIN local_library_identity_link l ON l.local_file_id=m.id
    JOIN track_identity ti ON ti.id=l.track_identity_id
    WHERE m.status='processed' AND l.link_status='EXACT' AND LENGTH(m.file_hash)=64
      AND NOT EXISTS(SELECT 1 FROM local_library_identity_link other WHERE other.local_file_id=m.id AND other.link_status<>'EXACT')
    ORDER BY reviewed DESC,CASE WHEN rating IS NULL THEN 1 ELSE 0 END,ti.identity_key,m.id`).all();
  const identities = new Set(), groups = new Set(), buckets = new Map();
  for (const row of rows) {
    const track = { identityKey: row.identity_key, tidalId: row.tidal_id, artist: row.artist, title: row.title,
      album: row.album, mixVersion: row.mix_version, durationMs: row.duration_ms, isrc: row.isrc,
      genre: row.local_genre, analysisLocal: { file: row.file_path, sha256: row.file_hash, localFileId: row.local_file_id } };
    const group = recordingGroup(track);
    if (identities.has(track.identityKey) || groups.has(group) || !existsSync(row.file_path)) continue;
    identities.add(track.identityKey); groups.add(group);
    const polarity = /^(love|like|good|up)$/.test(row.rating) ? "positive" : /^(skip|dislike|wrong_genre|reject_similar|never|down)$/.test(row.rating) ? "negative" : row.rating ? "neutral" : "unrated";
    const lane = normalize(row.local_genre) || "unknown";
    const bucket = `${row.reviewed ? "reviewed" : polarity}:${lane}`;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ track, recordingGroup: group, rating: row.rating || null, labelSource: row.rating ? "stored-global-feedback" : null, lane });
  }
  const items = [];
  while (items.length < limit && [...buckets.values()].some(x => x.length)) {
    for (const bucket of buckets.values()) { if (bucket.length) items.push(bucket.shift()); if (items.length >= limit) break; }
  }
  return { version: 1, createdAt: new Date().toISOString(), selection: "exact-local-links-stratified-by-feedback-and-metadata-lane", items,
    notes: ["Metadata lanes are sampling strata, not listening ground truth.", "Global ratings do not label the musical relevance of every anchor/candidate pair.", "No identity records or review judgments are changed."] };
}
module.exports = { buildAnalysisPilot, recordingGroup };
