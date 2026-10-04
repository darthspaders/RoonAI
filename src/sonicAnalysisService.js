"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { specs, analysisSpec, hash } = require("./sonicAnalysisSpec");
const { SonicAnalysisStore } = require("./sonicAnalysisStore");
const { SonicAnalysisWorker } = require("./sonicAnalysisWorker");
const { coverageTrack } = require("./sonicCoverageIdentity");
const { identityKeyFor, cosineSimilarity } = require("./sonicEmbeddingStore");

class SonicAnalysisService {
  constructor({ db, recommendationEngine, coverage, worker = new SonicAnalysisWorker() }) {
    this.db = db; this.engine = recommendationEngine; this.coverage = coverage; this.worker = worker;
    this.store = new SonicAnalysisStore({ db, embeddingStore: recommendationEngine.store });
    db.exec("CREATE TABLE IF NOT EXISTS sonic_analysis_control(id INTEGER PRIMARY KEY CHECK(id=1),settings_json TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS sonic_analysis_pilot(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,manifest_json TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO sonic_analysis_control VALUES(1,?)").run(JSON.stringify({ enabled: false, paused: false, lazyEnabled: false, models: ["mert-fullsong"], queueLimit: 1500 }));
    this.settings = JSON.parse(db.prepare("SELECT settings_json FROM sonic_analysis_control WHERE id=1").get().settings_json);
    coverage.analysis = this;
  }
  enabledKeys() { return this.settings.enabled && !this.settings.paused ? this.settings.models.map(id => analysisSpec(id).key) : []; }
  existing(track, key) {
    const spec = analysisSpec(key), value = this.store.summary(track, spec);
    if (!value || (track?.analysisLocal && value.sourceSha256 !== track.analysisLocal.sha256)) return null;
    return value;
  }
  configure(input = {}) {
    const next = { ...this.settings };
    for (const field of ["enabled", "paused", "lazyEnabled"]) if (input[field] !== undefined) {
      if (typeof input[field] !== "boolean") throw new Error(`${field} must be boolean.`);
      next[field] = input[field];
    }
    if (input.models !== undefined) {
      if (!Array.isArray(input.models) || !input.models.length || input.models.length > specs.length) throw new Error("Select at least one known analyzer.");
      next.models = [...new Set(input.models.map(id => analysisSpec(id).id))];
    }
    this.settings = next;
    this.db.prepare("UPDATE sonic_analysis_control SET settings_json=? WHERE id=1").run(JSON.stringify(next));
    this.coverage.schedule();
    return this.status();
  }
  enqueue(candidates, { lazy = false, models = this.settings.models, source = "analysis-pilot", allowLocal = false } = {}) {
    const selected = [...new Set(models)].map(analysisSpec);
    if (!Array.isArray(candidates) || candidates.length > 500) throw new Error("Analysis batches accept at most 500 tracks.");
    const counts = { queued: 0, inFlight: 0, embedded: 0, failed: 0, ineligible: 0, queueFull: 0 };
    let depth = this.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_work WHERE analyzer_key<>'' AND state IN ('pending','running')").get().n;
    this.coverage.transaction(() => {
      for (const input of candidates) {
        const track = coverageTrack(input);
        if (!track) { counts.ineligible++; continue; }
        if (allowLocal && input.analysisLocal) track.analysisLocal = input.analysisLocal;
        for (const spec of selected) {
          if (depth >= this.settings.queueLimit) { counts.queueFull++; continue; }
          const state = this.coverage.enqueue(track, { analyzerKey: spec.key, source, lazy, priority: lazy ? 0 : 6 });
          counts[state]++;
          if (state === "queued") depth++;
        }
      }
    });
    this.coverage.schedule();
    return { ...counts, queueDepth: depth, productionApplied: false };
  }
  cancel() {
    this.db.prepare("UPDATE sonic_coverage_work SET state='cancelled' WHERE analyzer_key<>'' AND state='pending'").run();
    return this.configure({ paused: true });
  }
  recordPilot(manifest, models) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sonic_analysis_pilot VALUES(?,?,?)").run(id,new Date().toISOString(),JSON.stringify({ ...manifest, models, id }));
    return id;
  }
  resume({ retryFailed = false } = {}) {
    if (retryFailed) this.db.prepare("UPDATE sonic_coverage_work SET state='pending',attempts=0,available_at=0,last_error='' WHERE analyzer_key IN (SELECT value FROM json_each(?)) AND state='failed'").run(JSON.stringify(this.settings.models.map(id => analysisSpec(id).key)));
    return this.configure({ enabled: true, paused: false });
  }
  async prepare(track, key) {
    const spec = analysisSpec(key);
    const analyze = async (audio, canonical, provenance) => {
      const sourceHash = hash(audio), cached = this.store.artifact(spec, sourceHash);
      if (cached) return this.store.save(canonical, spec, sourceHash, cached, provenance);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbit-sonic-analysis-"));
      const file = path.join(directory, "original.audio");
      try {
        await fs.writeFile(file, audio);
        const result = await this.worker.run(file, spec);
        return this.store.save(canonical, spec, sourceHash, result, provenance);
      } finally { await fs.unlink(file).catch(() => {}); await fs.rmdir(directory).catch(() => {}); }
    };
    if (track.analysisLocal) {
      // Only the server-side pilot selector may supply this descriptor. Verify
      // file content again, so a replaced local file cannot inherit an identity.
      const { file, sha256, localFileId } = track.analysisLocal;
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbit-sonic-analysis-"));
      const snapshot = path.join(directory, "original.audio");
      try {
        await fs.copyFile(file, snapshot);
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(snapshot)) digest.update(chunk);
        if (digest.digest("hex") !== sha256) throw new Error("Verified local audio changed; revalidate identity before analysis.");
        const cached = this.store.artifact(spec, sha256);
        const result = cached || await this.worker.run(snapshot, spec);
        return this.store.save(track, spec, sha256, result, { sourceType: "verified-local-file", localFileId, partialPreview: false });
      } catch (error) {
        if (["ENOENT","EIO","EBUSY","ENOTCONN","ECONNRESET","ETIMEDOUT"].includes(error.code)) {
          error.message = `Audio source temporarily unavailable (network/local storage): ${error.message}`;
        }
        throw error;
      } finally { await fs.unlink(snapshot).catch(() => {}); await fs.rmdir(directory).catch(() => {}); }
    }
    return this.engine.analyzeBeatportPreviewForTidalTrack(track, { allowVersionProxy: false,
      analysisHandler: (audio, canonical, options) => analyze(audio, canonical, { sourceType: options.sourceType, ...options.metadata }) });
  }
  evidence(track) { return this.settings.models.map(id => this.store.get(track, analysisSpec(id), { compact: true })).filter(Boolean); }
  observe(candidates, { anchor = null } = {}) {
    if (!this.settings.enabled) return { mode: "off", productionApplied: false };
    const list = candidates.slice(0, 500);
    const models = this.settings.models.map(id => {
      const spec = analysisSpec(id), reference = anchor && spec.kind === "embedding" ? this.store.get(anchor, spec) : null;
      const available = list.map(track => ({ identityKey: identityKeyFor(track), value: this.existing(track, spec.key) })).filter(x => x.value);
      return { analyzer: id, modelVersion: spec.key, candidateCount: list.length, analyzedCount: available.length,
        coverage: list.length ? available.length / list.length : 0,
        ...(reference?.vector ? { anchorIdentityKey: identityKeyFor(anchor), similarities: available.slice(0,50).map(x => ({ identityKey: x.identityKey, cosine: cosineSimilarity(reference.vector, this.store.get(x.identityKey,spec)?.vector || []) })) } : {}) };
    });
    let lazyFill = null;
    if (this.settings.lazyEnabled && !this.settings.paused) lazyFill = this.enqueue(list, { lazy: true, source: "discovery-analysis" });
    return { mode: "shadow", productionApplied: false, models, lazyFill };
  }
  status() {
    const queue = this.db.prepare("SELECT analyzer_key AS specKey,state,COUNT(*) count FROM sonic_coverage_work WHERE analyzer_key<>'' GROUP BY analyzer_key,state").all();
    const counts = { totalEligible:0, alreadyEmbedded:0, preparedSuccessfully:0, failed:0, remaining:0, cancelled:0, active:0 };
    for (const row of queue) {
      counts.totalEligible += row.count;
      if (row.state === "embedded") counts.alreadyEmbedded += row.count;
      else if (row.state === "prepared") counts.preparedSuccessfully += row.count;
      else if (row.state === "failed") counts.failed += row.count;
      else if (row.state === "cancelled") counts.cancelled += row.count;
      else counts.remaining += row.count;
      if (row.state === "running") counts.active += row.count;
    }
    return { ok: true, mode: "shadow", productionApplied: false, settings: { ...this.settings }, analyzers: specs,
      queue, counts, countUnit: "track-and-analysis-spec", latestPilot: this.db.prepare("SELECT id,created_at AS createdAt FROM sonic_analysis_pilot ORDER BY created_at DESC LIMIT 1").get() || null,
      stored: this.db.prepare("SELECT spec_key AS specKey,COUNT(*) count FROM sonic_analysis_link GROUP BY spec_key").all(),
      recentFailures: this.db.prepare("SELECT analyzer_key AS specKey,last_error AS error,updated_at AS updatedAt FROM sonic_coverage_work WHERE analyzer_key<>'' AND state='failed' ORDER BY updated_at DESC LIMIT 5").all() };
  }
  close() { this.worker.stop(); }
}
module.exports = { SonicAnalysisService };
