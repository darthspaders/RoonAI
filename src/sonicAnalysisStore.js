"use strict";
const { identityKeyFor, normalizeVector } = require("./sonicEmbeddingStore");
const { hash } = require("./sonicAnalysisSpec");

// Additional derived evidence in the existing music-memory DB. No review,
// rating, identity, provider-metadata or taste tables are written here.
class SonicAnalysisStore {
  constructor({ db, embeddingStore }) {
    this.db = db;
    // Music memory and the embedding service normally own separate connections
    // to this same DB. Bind the existing store methods to this transaction's
    // connection; writing through the other handle would self-deadlock.
    this.embeddings = Object.assign(Object.create(embeddingStore), { db });
    db.exec(`CREATE TABLE IF NOT EXISTS sonic_analysis_artifact (
      artifact_key TEXT PRIMARY KEY, spec_key TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      spec_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(spec_key, source_sha256));
      CREATE TABLE IF NOT EXISTS sonic_analysis_link (
        identity_key TEXT NOT NULL, spec_key TEXT NOT NULL, artifact_key TEXT NOT NULL,
        provenance_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(identity_key,spec_key),
        FOREIGN KEY(artifact_key) REFERENCES sonic_analysis_artifact(artifact_key));
      CREATE INDEX IF NOT EXISTS idx_sonic_analysis_spec ON sonic_analysis_link(spec_key);`);
  }
  artifact(spec, sourceHash) {
    const row = this.db.prepare("SELECT * FROM sonic_analysis_artifact WHERE spec_key=? AND source_sha256=?").get(spec.key, sourceHash);
    return row ? { artifactKey: row.artifact_key, sourceSha256: row.source_sha256, ...JSON.parse(row.result_json) } : null;
  }
  summary(track, spec) {
    const row = this.db.prepare(`SELECT a.source_sha256 FROM sonic_analysis_link l
      JOIN sonic_analysis_artifact a USING(artifact_key)
      WHERE l.identity_key=? AND l.spec_key=? AND (?<> 'embedding' OR EXISTS(
        SELECT 1 FROM track_sonic_profile p WHERE p.identity_key=l.identity_key AND p.model=?
          AND p.model_version=l.spec_key AND p.dimensions=?))`).get(identityKeyFor(track),spec.key,spec.kind,spec.repo,spec.dimensions || 0);
    return row ? { sourceSha256:row.source_sha256, model:spec.repo, modelVersion:spec.key } : null;
  }
  get(track, spec, { compact = false } = {}) {
    const row = this.db.prepare(`SELECT a.*,l.provenance_json,l.updated_at FROM sonic_analysis_link l
      JOIN sonic_analysis_artifact a USING(artifact_key) WHERE l.identity_key=? AND l.spec_key=?`).get(identityKeyFor(track), spec.key);
    if (!row) return null;
    const result = JSON.parse(row.result_json);
    const shared = { analyzer: spec.id, model: spec.repo, modelVersion: spec.key, revision: spec.revision,
      sourceSha256: row.source_sha256, provenance: JSON.parse(row.provenance_json), updatedAt: row.updated_at,
      sampleRate: result.sampleRate, audioDurationSeconds: result.audioDurationSeconds,
      analyzedSeconds: result.analyzedSeconds, sourceCoverage: result.sourceCoverage,
      estimates: result.estimates, timings: result.timings, estimated: true, productionApplied: false };
    return compact ? { ...shared, segments: result.segments.map(({ vector, ...segment }) => segment).slice(0, 24) }
      : { ...result, ...shared };
  }
  save(track, spec, sourceHash, result, provenance = {}) {
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Analysis requires the original audio SHA-256.");
    const identity = identityKeyFor(track);
    if (!identity) throw new Error("Analysis requires a recording identity.");
    if (result.specKey !== spec.key || result.revision !== spec.revision || result.sampleRate !== spec.sampleRate) throw new Error("Analyzer returned mismatched provenance.");
    if (!Number.isFinite(result.audioDurationSeconds) || result.audioDurationSeconds <= 0 ||
      !Number.isFinite(result.analyzedSeconds) || result.analyzedSeconds <= 0 || result.analyzedSeconds > result.audioDurationSeconds + .01 ||
      !Number.isFinite(result.sourceCoverage) || result.sourceCoverage <= 0 || result.sourceCoverage > 1.001 ||
      !Array.isArray(result.segments) || !result.segments.length || result.segments.length > 128) throw new Error("Invalid analyzed audio spans.");
    for (const segment of result.segments) {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > result.audioDurationSeconds + .01) throw new Error("Invalid segment timeline.");
    }
    if (spec.kind === "embedding" && (result.vector?.length !== spec.dimensions || normalizeVector(result.vector).length !== spec.dimensions)) throw new Error("Invalid analyzer embedding.");
    if (spec.kind === "emotion" && !result.segments.every(x => [x.valence,x.arousal].every(Number.isFinite))) throw new Error("Invalid emotion estimates.");
    if (spec.kind === "structure" && (!Array.isArray(result.events) || !result.estimates)) throw new Error("Invalid structural estimates.");
    const payload = JSON.stringify(result);
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error("Analysis output exceeds the bounded artifact size.");
    const artifactKey = hash(`${spec.key}:${sourceHash}`), now = new Date().toISOString();
    this.db.exec("SAVEPOINT sonic_analysis_save");
    try {
      this.db.prepare("INSERT OR IGNORE INTO sonic_analysis_artifact VALUES(?,?,?,?,?,?)").run(artifactKey, spec.key, sourceHash, JSON.stringify(spec), payload, now);
      this.db.prepare(`INSERT INTO sonic_analysis_link VALUES(?,?,?,?,?) ON CONFLICT(identity_key,spec_key) DO UPDATE SET
        artifact_key=excluded.artifact_key,provenance_json=excluded.provenance_json,updated_at=excluded.updated_at`)
        .run(identity, spec.key, artifactKey, JSON.stringify(provenance), now);
      if (spec.kind === "embedding") this.embeddings.upsertEmbedding({ track, model: spec.repo, modelVersion: spec.key,
        vector: result.vector, sourceSha256: sourceHash, sampleRate: result.sampleRate,
        audioDurationMs: Math.round(result.audioDurationSeconds * 1000),
        metadata: { analysisSpec: spec, artifactKey, provenance, experimental: true, analyzedSeconds: result.analyzedSeconds } });
      this.db.exec("RELEASE sonic_analysis_save");
    } catch (error) { this.db.exec("ROLLBACK TO sonic_analysis_save; RELEASE sonic_analysis_save"); throw error; }
    return { identityKey: identity, prepared: true, artifactKey };
  }
}
module.exports = { SonicAnalysisStore };
