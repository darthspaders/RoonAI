"use strict";

const { randomUUID } = require("node:crypto");
const { MODEL, MODEL_VERSION, coverageTrack, validCoverageEmbedding } = require("./sonicCoverageIdentity");
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number.isFinite(Number(value)) ? Number(value) : fallback)));
const DEFAULTS = { concurrency: 1, batchSize: 5, minIntervalMs: 2000, batchPauseMs: 5000, maxAttempts: 3, lazyEnabled: true, paused: false };

function settingsFor(input = {}, previous = DEFAULTS) {
  return {
    concurrency: integer(input.concurrency ?? previous.concurrency, 1, 1, 3),
    batchSize: integer(input.batchSize ?? previous.batchSize, 5, 1, 50),
    minIntervalMs: integer(input.minIntervalMs ?? previous.minIntervalMs, 2000, 250, 60000),
    batchPauseMs: integer(input.batchPauseMs ?? previous.batchPauseMs, 5000, 1000, 300000),
    maxAttempts: integer(input.maxAttempts ?? previous.maxAttempts, 3, 1, 5),
    lazyEnabled: input.lazyEnabled === undefined ? previous.lazyEnabled : input.lazyEnabled === true,
    paused: previous.paused === true
  };
}

class SonicCoverageService {
  constructor({ db, recommendationEngine, inventory, settings = {}, clock = Date.now, logger = console, autoStart = true } = {}) {
    if (!db) throw new Error("Sonic coverage requires the existing music-memory database.");
    this.db = db;
    this.engine = recommendationEngine;
    this.inventory = inventory;
    this.clock = clock;
    this.logger = logger;
    this.autoStart = autoStart;
    this.active = new Map();
    this.preparing = new Map();
    this.analysis = null;
    this.closed = false;
    this.scanning = false;
    this.timer = null;
    this.scheduledAt = 0;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sonic_coverage_control (
        id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL,
        next_start_at INTEGER NOT NULL DEFAULT 0, batch_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sonic_coverage_job (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, scan_complete INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS sonic_coverage_work (
        identity_key TEXT PRIMARY KEY, track_json TEXT NOT NULL, priority INTEGER NOT NULL,
        source TEXT NOT NULL, lazy INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        requested_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        claim_token TEXT, resolved_identity_key TEXT, last_error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_sonic_coverage_ready ON sonic_coverage_work(state, available_at, lazy, priority);
      CREATE TABLE IF NOT EXISTS sonic_coverage_job_item (
        job_id TEXT NOT NULL, identity_key TEXT NOT NULL, initially_embedded INTEGER NOT NULL,
        PRIMARY KEY(job_id, identity_key),
        FOREIGN KEY(job_id) REFERENCES sonic_coverage_job(id),
        FOREIGN KEY(identity_key) REFERENCES sonic_coverage_work(identity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_sonic_coverage_membership ON sonic_coverage_job_item(identity_key, job_id);
    `);
    // Additive migration: legacy identity keys, job membership and progress stay
    // untouched. Optional analyzers share this scheduler and its global limits.
    if (!db.prepare("PRAGMA table_info(sonic_coverage_work)").all().some(row => row.name === "analyzer_key")) {
      db.exec("ALTER TABLE sonic_coverage_work ADD COLUMN analyzer_key TEXT NOT NULL DEFAULT ''");
    }
    const persisted = db.prepare("SELECT * FROM sonic_coverage_control WHERE id=1").get();
    this.settings = settingsFor(persisted ? JSON.parse(persisted.settings_json) : settings);
    if (persisted) this.settings.paused = JSON.parse(persisted.settings_json).paused === true;
    db.prepare("INSERT OR IGNORE INTO sonic_coverage_control(id,settings_json) VALUES(1,?)").run(JSON.stringify(this.settings));
    // The server's existing process lock guarantees one owner. A killed owner
    // leaves claims recoverable; valid embeddings are rechecked before retry.
    db.prepare("UPDATE sonic_coverage_work SET state='pending',claim_token=NULL WHERE state='running'").run();
    if (autoStart) this.schedule();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  configure(input = {}) {
    this.settings = settingsFor(input, this.settings);
    this.persistSettings();
    this.schedule();
    return this.status();
  }

  persistSettings() {
    this.db.prepare("UPDATE sonic_coverage_control SET settings_json=? WHERE id=1").run(JSON.stringify(this.settings));
  }

  latestJob() { return this.db.prepare("SELECT * FROM sonic_coverage_job ORDER BY created_at DESC,rowid DESC LIMIT 1").get() || null; }

  existing(track, resolvedIdentity = "", analyzerKey = "") {
    if (analyzerKey) return this.analysis?.existing(resolvedIdentity || track, analyzerKey) || null;
    const embedding = this.engine?.store?.getEmbedding(resolvedIdentity || track, { model: MODEL, modelVersion: MODEL_VERSION });
    return validCoverageEmbedding(embedding) ? embedding : null;
  }

  enqueue(trackInput, { priority = 6, source = "catalog", lazy = false, jobId = "", analyzerKey = "" } = {}) {
    const track = coverageTrack(trackInput);
    if (!track) return "ineligible";
    if (analyzerKey && trackInput.analysisLocal) track.analysisLocal = trackInput.analysisLocal;
    const workKey = analyzerKey ? `analysis:${analyzerKey}:${require("./sonicAnalysisSpec").hash(track.identityKey + (track.analysisLocal?.sha256 || ""))}` : track.identityKey;
    const old = this.db.prepare("SELECT * FROM sonic_coverage_work WHERE identity_key=?").get(workKey);
    const cached = this.existing(track, old?.resolved_identity_key, analyzerKey);
    const now = this.clock();
    if (!old) {
      this.db.prepare(`INSERT INTO sonic_coverage_work(identity_key,track_json,priority,source,lazy,state,requested_at,updated_at,analyzer_key)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(workKey, JSON.stringify(track), priority, source, Number(lazy), cached ? "embedded" : "pending", now, now, analyzerKey);
    } else {
      const state = cached && old.state !== "running" ? (old.state === "prepared" ? "prepared" : "embedded")
        : ["cancelled", "embedded", "prepared"].includes(old.state) && !cached ? "pending" : old.state;
      this.db.prepare(`UPDATE sonic_coverage_work SET priority=MIN(priority,?),lazy=MAX(lazy,?),
        requested_at=CASE WHEN ? THEN ? ELSE requested_at END,state=?,updated_at=? WHERE identity_key=?`)
        .run(priority, Number(lazy), Number(lazy), now, state, now, workKey);
    }
    if (jobId) this.db.prepare("INSERT OR IGNORE INTO sonic_coverage_job_item(job_id,identity_key,initially_embedded) VALUES(?,?,?)")
      .run(jobId, workKey, Number(Boolean(cached)));
    if (cached) return "embedded";
    if (old && ["pending", "running"].includes(old.state)) return "inFlight";
    if (old?.state === "failed") return "failed";
    return "queued";
  }

  enqueueMissing(candidates = []) {
    const result = { lazyFillQueuedCount: 0, lazyFillAlreadyInFlightCount: 0, lazyFillFailedCount: 0, backfillQueueDepth: 0 };
    if (this.settings.lazyEnabled && !this.closed) {
      this.transaction(() => {
        for (const track of candidates) {
          const state = this.enqueue(track, { priority: 0, source: "discovery", lazy: true });
          if (state === "queued") result.lazyFillQueuedCount++;
          if (state === "inFlight") result.lazyFillAlreadyInFlightCount++;
          if (state === "failed") result.lazyFillFailedCount++;
        }
      });
      this.schedule();
    }
    result.backfillQueueDepth = this.queueDepth();
    return result;
  }

  startBackfill(options = {}) {
    if (!this.engine?.enabled || !this.engine?.store?.enabled) throw new Error("Sonic embedding storage is not enabled.");
    if (this.engine.provider?.name !== MODEL || String(this.engine.provider?.modelVersion) !== MODEL_VERSION) throw new Error("Coverage requires discogs-effnet v1.");
    this.configure(options);
    const current = this.latestJob();
    if (current && ["running", "paused"].includes(current.state)) return this.resume(options);
    const now = this.clock();
    this.db.prepare("INSERT INTO sonic_coverage_job(id,state,created_at,updated_at) VALUES(?,'running',?,?)").run(randomUUID(), now, now);
    this.settings.paused = false;
    this.persistSettings();
    this.schedule();
    return this.status();
  }

  pause({ scope = "all" } = {}) {
    const job = this.latestJob();
    if (job?.state === "running") this.db.prepare("UPDATE sonic_coverage_job SET state='paused',updated_at=? WHERE id=?").run(this.clock(), job.id);
    if (scope === "all") { this.settings.paused = true; this.persistSettings(); }
    return this.status();
  }

  resume({ retryFailed = false } = {}) {
    const job = this.latestJob();
    if (job && ["paused", "running"].includes(job.state)) {
      this.db.prepare("UPDATE sonic_coverage_job SET state='running',error='',updated_at=? WHERE id=?").run(this.clock(), job.id);
    }
    if (retryFailed) {
      this.db.prepare("UPDATE sonic_coverage_work SET state='pending',attempts=0,available_at=0,last_error='' WHERE analyzer_key='' AND state='failed' AND (lazy=1 OR identity_key IN (SELECT identity_key FROM sonic_coverage_job_item WHERE job_id=?))").run(job?.id || "");
      if (job?.state === "completed") this.db.prepare("UPDATE sonic_coverage_job SET state='running' WHERE id=?").run(job.id);
    }
    this.settings.paused = false;
    this.persistSettings();
    this.schedule();
    return this.status();
  }

  cancel({ scope = "bulk" } = {}) {
    const job = this.latestJob();
    this.transaction(() => {
      if (job && ["running", "paused"].includes(job.state)) this.db.prepare("UPDATE sonic_coverage_job SET state='cancelled',updated_at=? WHERE id=?").run(this.clock(), job.id);
      this.db.prepare("UPDATE sonic_coverage_work SET state='cancelled' WHERE state='pending' AND (analyzer_key='' OR ?) AND (lazy=0 OR ?)").run(Number(scope === "all"), Number(scope === "all"));
      if (scope === "all") { this.settings.paused = true; this.persistSettings(); }
    });
    return this.status();
  }

  queueDepth() { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM sonic_coverage_work WHERE analyzer_key='' AND state IN ('pending','running')").get().n); }

  status() {
    const job = this.latestJob();
    const groups = job ? this.db.prepare(`SELECT w.state,i.initially_embedded,COUNT(*) AS n FROM sonic_coverage_job_item i
      JOIN sonic_coverage_work w USING(identity_key) WHERE job_id=? GROUP BY w.state,i.initially_embedded`).all(job.id) : [];
    const counts = { totalEligible: 0, alreadyEmbedded: 0, preparedSuccessfully: 0, failed: 0, remaining: 0 };
    for (const row of groups) {
      counts.totalEligible += row.n;
      if (row.initially_embedded || row.state === "embedded") counts.alreadyEmbedded += row.n;
      else if (row.state === "prepared") counts.preparedSuccessfully += row.n;
      else if (row.state === "failed") counts.failed += row.n;
      else counts.remaining += row.n;
    }
    return {
      ok: true, model: MODEL, modelVersion: MODEL_VERSION, scope: "embedding-coverage-only",
      settings: { ...this.settings }, activeCount: [...this.active.keys()].filter(key => !key.startsWith("analysis:")).length,
      sharedActiveCount: this.active.size, queueDepth: this.queueDepth(),
      job: job ? { id: job.id, state: job.state, inventoryComplete: Boolean(job.scan_complete), createdAt: job.created_at, updatedAt: job.updated_at, error: job.error, ...counts } : null,
      queueCounts: Object.fromEntries(this.db.prepare("SELECT state,COUNT(*) AS n FROM sonic_coverage_work WHERE analyzer_key='' GROUP BY state").all().map(row => [row.state, row.n])),
      recentFailures: this.db.prepare("SELECT identity_key AS identityKey,source,last_error AS error,attempts FROM sonic_coverage_work WHERE analyzer_key='' AND state='failed' ORDER BY updated_at DESC LIMIT 5").all()
    };
  }

  schedule(delay = 50) {
    if (!this.autoStart || this.closed) return;
    const due = this.clock() + delay;
    if (this.timer && this.scheduledAt <= due) return;
    clearTimeout(this.timer);
    this.scheduledAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledAt = 0;
      this.pump().catch(error => this.logger?.warn?.("Sonic coverage scheduler failed", { error: error.message }));
    }, delay);
    this.timer.unref?.();
  }

  async scanInventory() {
    const job = this.latestJob();
    if (this.scanning || !job || job.state !== "running" || job.scan_complete || this.settings.paused || this.closed) return;
    this.scanning = true;
    try {
      let batch = [];
      const flush = () => this.transaction(() => {
        for (const item of batch) this.enqueue(item.track || item, { priority: item.priority || 6, source: item.source || "catalog", jobId: job.id });
        this.db.prepare("UPDATE sonic_coverage_job SET updated_at=? WHERE id=?").run(this.clock(), job.id);
        batch = [];
      });
      // Rescanning inventory after interruption is idempotent. Previously
      // queued/completed work and counts remain in SQLite throughout.
      for await (const item of this.inventory()) {
        const current = this.latestJob();
        if (this.closed || this.settings.paused || current?.id !== job.id || current.state !== "running") return;
        batch.push(item);
        if (batch.length >= 25) { flush(); await yieldTurn(); }
      }
      const current = this.latestJob();
      if (this.closed || this.settings.paused || current?.id !== job.id || current.state !== "running") return;
      if (batch.length) flush();
      this.db.prepare("UPDATE sonic_coverage_job SET scan_complete=1,updated_at=? WHERE id=?").run(this.clock(), job.id);
    } catch (error) {
      this.db.prepare("UPDATE sonic_coverage_job SET state='paused',error=?,updated_at=? WHERE id=?").run(error.message.slice(0,800), this.clock(), job.id);
    } finally { this.scanning = false; this.schedule(); }
  }

  async prepare(track) {
    // Resolve aliases through the same exact TIDAL service before sharing any
    // preparation promise. Never merge different mixes by artist/title alone.
    const canonical = await this.engine.resolveTidalTrackReference(track);
    const resolved = coverageTrack({ ...canonical, tidalId: canonical.tidalId || canonical.id });
    if (!resolved) throw new Error("The exact identity resolver returned no eligible track.");
    if (this.existing(resolved)) return { identityKey: resolved.identityKey, prepared: false };
    if (this.preparing.has(resolved.identityKey)) {
      const result = await this.preparing.get(resolved.identityKey);
      return { ...result, prepared: false };
    }
    const promise = this.engine.prepareSonicAnchor(resolved, {
      model: MODEL, modelVersion: MODEL_VERSION, allowVersionProxy: false,
      requireValidEmbedding: true, backgroundExtraction: true
    });
    this.preparing.set(resolved.identityKey, promise);
    try {
      const result = await promise;
      if (!result.ready || !this.existing(resolved, result.identityKey)) throw new Error("Preparation did not persist a valid matching Discogs-EffNet v1 embedding.");
      return result;
    } finally { this.preparing.delete(resolved.identityKey); }
  }

  async processWork(work) {
    let state, result, errorText = "", availableAt = 0;
    try {
      const track = JSON.parse(work.track_json);
      if (this.existing(track, work.resolved_identity_key, work.analyzer_key)) result = { prepared: false, identityKey: work.resolved_identity_key || track.identityKey };
      else result = work.analyzer_key ? await this.analysis.prepare(track, work.analyzer_key) : await this.prepare(track);
      state = result.prepared ? "prepared" : "embedded";
    } catch (error) {
      errorText = String(error.message || error).slice(0, 800);
      const code = Number(error.statusCode || error.status || 0);
      const resourceWait = error.code === "SONIC_RESOURCE_BUSY";
      const transient = resourceWait || [408, 429, 500, 502, 503, 504].includes(code) || /timeout|timed out|ECONN|fetch failed|network/i.test(errorText);
      state = transient && (resourceWait || work.attempts < this.settings.maxAttempts) ? "pending" : "failed";
      if (state === "pending") availableAt = this.clock() + Math.min(300000, 30000 * 2 ** (work.attempts - 1));
      if (resourceWait) availableAt = this.clock() + 60000;
    }
    if (!this.closed) this.db.prepare(`UPDATE sonic_coverage_work SET state=?,resolved_identity_key=COALESCE(?,resolved_identity_key),
      last_error=?,available_at=?,updated_at=?,claim_token=NULL WHERE identity_key=? AND claim_token=? AND state='running'`)
      .run(state, result?.identityKey || null, errorText, availableAt, this.clock(), work.identity_key, work.claim_token);
  }

  async pump() {
    if (this.closed || this.settings.paused) return;
    if (!this.scanning) void this.scanInventory();
    if (this.active.size >= this.settings.concurrency) return;
    const control = this.db.prepare("SELECT next_start_at,batch_count FROM sonic_coverage_control WHERE id=1").get();
    if (control.next_start_at > this.clock()) { this.schedule(Math.min(60000, control.next_start_at - this.clock())); return; }
    const analyzerKeys = JSON.stringify(this.analysis?.enabledKeys() || []);
    const analysisIdle = ![...this.active.keys()].some(key => key.startsWith("analysis:"));
    const eligible = `((w.analyzer_key='' AND ((lazy=1 AND ?) OR EXISTS(
      SELECT 1 FROM sonic_coverage_job_item i JOIN sonic_coverage_job j ON j.id=i.job_id
      WHERE i.identity_key=w.identity_key AND j.state='running' AND j.scan_complete=1)))
      OR (w.analyzer_key IN (SELECT value FROM json_each(?)) AND ?))`;
    const work = this.transaction(() => {
      const row = this.db.prepare(`SELECT w.* FROM sonic_coverage_work w WHERE state='pending' AND available_at<=? AND
        ${eligible}
        ORDER BY CASE WHEN analyzer_key='' AND lazy=1 THEN 0 WHEN analyzer_key<>'' AND lazy=1 THEN 1
          WHEN analyzer_key='' THEN 2 ELSE 3 END,
          CASE WHEN lazy=1 THEN requested_at END DESC,priority,analyzer_key,requested_at,identity_key LIMIT 1`)
        .get(this.clock(), Number(this.settings.lazyEnabled), analyzerKeys, Number(analysisIdle));
      if (!row) return null;
      row.claim_token = randomUUID();
      row.attempts++;
      this.db.prepare("UPDATE sonic_coverage_work SET state='running',attempts=?,claim_token=?,updated_at=? WHERE identity_key=?")
        .run(row.attempts, row.claim_token, this.clock(), row.identity_key);
      const batchCount = control.batch_count + 1;
      const boundary = batchCount >= this.settings.batchSize;
      this.db.prepare("UPDATE sonic_coverage_control SET next_start_at=?,batch_count=? WHERE id=1")
        .run(this.clock() + Math.max(this.settings.minIntervalMs, boundary ? this.settings.batchPauseMs : 0), boundary ? 0 : batchCount);
      return row;
    });
    if (work) {
      const promise = this.processWork(work).catch(error => this.logger?.warn?.("Sonic coverage completion failed", { error: error.message }))
        .finally(() => { this.active.delete(work.identity_key); this.schedule(); });
      this.active.set(work.identity_key, promise);
      this.schedule(this.settings.minIntervalMs);
    } else {
      const job = this.latestJob();
      if (job?.state === "running" && job.scan_complete && this.status().job.remaining === 0) {
        this.db.prepare("UPDATE sonic_coverage_job SET state='completed',updated_at=? WHERE id=?").run(this.clock(), job.id);
      }
      // Paused/cancelled bulk inventory must not cause a permanent polling
      // loop. Only retry eligible work; enqueue/resume/inventory completion
      // explicitly wake the scheduler when new work becomes available.
      const next = this.db.prepare(`SELECT MIN(w.available_at) AS at FROM sonic_coverage_work w WHERE state='pending' AND ${eligible}`)
        .get(Number(this.settings.lazyEnabled), analyzerKeys, Number(analysisIdle));
      if (next.at !== null) this.schedule(Math.max(50, Math.min(60000, next.at - this.clock())));
    }
  }

  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.scheduledAt = 0; }
}

module.exports = { SonicCoverageService, settingsFor };
