"use strict";

const { randomUUID } = require("node:crypto");
const { MODEL, MODEL_VERSION, coverageTrack, validCoverageEmbedding } = require("./sonicCoverageIdentity");
const { storedSonicIdentityMatches } = require("./sonicProfileIdentity");
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const integer = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.trunc(Number.isFinite(Number(value)) ? Number(value) : fallback)));
const DEFAULTS = { concurrency: 1, batchSize: 5, minIntervalMs: 2000, batchPauseMs: 5000, maxAttempts: 3, lazyEnabled: true, paused: false };

function consistentTidalIdentity(input = {}) {
  const track = input.track || input;
  // coverageTrack prefers explicit IDs. Check for contradictions first, so
  // normalizing a supplied identity cannot silently discard another track ID.
  const ids = [track.tidalId, track.tidal_id, track.tidalTrackId,
    track.tidal?.id, track.tidal?.trackId, track.tidal?.track_id]
    .map(value => String(value ?? "").trim()).filter(value => /^\d+$/.test(value));
  for (const value of [track.identityKey, track.identity_key]) {
    const id = String(value ?? "").trim().match(/^tidal:(\d+)$/i)?.[1];
    if (id) ids.push(id);
  }
  for (const value of [track.tidalUrl, track.tidal_url, track.tidal?.tidalUrl, track.tidal?.url]) {
    const id = String(value ?? "").match(/\/track\/(\d+)/i)?.[1];
    if (id) ids.push(id);
  }
  return new Set(ids).size <= 1;
}

function metadataTime(value) {
  const time = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(time) && time > 0 ? Math.trunc(time) : 0;
}

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
      CREATE TABLE IF NOT EXISTS sonic_coverage_metadata_audit (
        id INTEGER PRIMARY KEY, identity_key TEXT NOT NULL, event TEXT NOT NULL,
        source TEXT NOT NULL, previous_track_json TEXT NOT NULL, track_json TEXT NOT NULL,
        previous_state TEXT NOT NULL, previous_attempts INTEGER NOT NULL,
        previous_error TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    // Additive migration: legacy identity keys, job membership and progress stay
    // untouched. Optional analyzers share this scheduler and its global limits.
    if (!db.prepare("PRAGMA table_info(sonic_coverage_work)").all().some(row => row.name === "analyzer_key")) {
      db.exec("ALTER TABLE sonic_coverage_work ADD COLUMN analyzer_key TEXT NOT NULL DEFAULT ''");
    }
    if (!db.prepare("PRAGMA table_info(sonic_coverage_work)").all().some(row => row.name === "metadata_updated_at")) {
      db.exec("ALTER TABLE sonic_coverage_work ADD COLUMN metadata_updated_at INTEGER NOT NULL DEFAULT 0");
    }
    for (const table of ["sonic_coverage_work", "sonic_coverage_job"]) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
      if (!columns.some(row => row.name === "model")) db.exec("ALTER TABLE " + table + " ADD COLUMN model TEXT NOT NULL DEFAULT 'discogs-effnet'");
      if (!columns.some(row => row.name === "model_version")) db.exec("ALTER TABLE " + table + " ADD COLUMN model_version TEXT NOT NULL DEFAULT '1'");
    }
    for (const spec of require("./sonicAnalysisSpec").specs) db.prepare("UPDATE sonic_coverage_work SET model=?,model_version=? WHERE analyzer_key=? AND (model<>? OR model_version<>?)").run(spec.repo, spec.key, spec.key, spec.repo, spec.key);
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

  latestJob() { return this.db.prepare("SELECT * FROM sonic_coverage_job WHERE model=? AND model_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(MODEL, MODEL_VERSION) || null; }

  existing(track, resolvedIdentity = "", analyzerKey = "") {
    if (analyzerKey) return this.analysis?.existing(resolvedIdentity || track, analyzerKey) || null;
    const embedding = this.engine?.store?.getEmbedding(resolvedIdentity || track, { model: MODEL, modelVersion: MODEL_VERSION });
    return validCoverageEmbedding(embedding) && storedSonicIdentityMatches(embedding, resolvedIdentity || track) ? embedding : null;
  }

  auditMetadata(work, nextJson, event, source) {
    this.db.prepare(`INSERT INTO sonic_coverage_metadata_audit(identity_key,event,source,previous_track_json,track_json,
      previous_state,previous_attempts,previous_error,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(work.identity_key, event, source, work.track_json, nextJson, work.state, work.attempts, work.last_error, this.clock());
  }

  refreshMetadata(work, candidate, { source, observedAt = 0, allowMixClear = false } = {}) {
    if (!work || work.analyzer_key || work.claim_token || this.active.has(work.identity_key)
      || !["pending", "failed", "cancelled"].includes(work.state)
      || !/^tidal:\d+$/.test(JSON.parse(work.track_json).identityKey)
      || (work.resolved_identity_key && work.resolved_identity_key !== JSON.parse(work.track_json).identityKey)
      || observedAt <= (work.metadata_updated_at || work.requested_at) || observedAt > this.clock()
      || !consistentTidalIdentity(candidate)) return false;
    let previous;
    try { previous = JSON.parse(work.track_json); } catch { return false; }
    const track = coverageTrack(candidate);
    const oldTrack = consistentTidalIdentity(previous) && coverageTrack(previous);
    if (!track || !oldTrack || track.identityKey !== oldTrack.identityKey
      || track.tidalId !== oldTrack.tidalId || this.existing(oldTrack, work.resolved_identity_key)) return false;
    const isrc = value => String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
    if ((track.isrc && oldTrack.isrc && isrc(track.isrc) !== isrc(oldTrack.isrc))
      || (track.beatportTrackId && oldTrack.beatportTrackId && track.beatportTrackId !== oldTrack.beatportTrackId)) return false;
    // Keep corroborating metadata when a fresh observation omits it. Core
    // title/version fields come from the same provider ID; TIDAL still confirms
    // them before preparation. A memory row is never identity authority.
    const next = { ...previous };
    for (const [key, value] of Object.entries(track)) {
      if (value !== "" && value !== null) next[key] = value;
    }
    for (const key of ["artist", "title"]) next[key] = track[key];
    const supplied = candidate.track || candidate;
    const explicitMix = ["mixVersion", "mixName", "version"].some(key => Object.hasOwn(supplied, key) && typeof supplied[key] === "string");
    if (track.mixVersion || (allowMixClear && explicitMix)) next.mixVersion = track.mixVersion;
    const nextJson = JSON.stringify(next);
    if (nextJson === work.track_json) {
      // A newer confirmation still establishes metadata age. Keep it without
      // duplicating change audit records or resetting any failure evidence.
      this.db.prepare(`UPDATE sonic_coverage_work SET metadata_updated_at=? WHERE identity_key=? AND track_json=?
        AND claim_token IS NULL AND analyzer_key='' AND state IN ('pending','failed','cancelled')
        AND metadata_updated_at<?`).run(observedAt, work.identity_key, work.track_json, observedAt);
      return false;
    }
    // A savepoint works both inside inventory/enqueue transactions and for a
    // standalone enqueue. Metadata and its prior failure evidence commit together.
    this.db.exec("SAVEPOINT sonic_coverage_metadata_refresh");
    try {
      const changed = this.db.prepare(`UPDATE sonic_coverage_work SET track_json=?,metadata_updated_at=?
        WHERE identity_key=? AND track_json=? AND claim_token IS NULL AND analyzer_key=''
        AND state IN ('pending','failed','cancelled')`).run(nextJson, observedAt, work.identity_key, work.track_json).changes;
      if (changed) this.auditMetadata(work, nextJson, "metadata-refresh", source);
      this.db.exec("RELEASE sonic_coverage_metadata_refresh");
      return Boolean(changed);
    } catch (error) {
      this.db.exec("ROLLBACK TO sonic_coverage_metadata_refresh");
      this.db.exec("RELEASE sonic_coverage_metadata_refresh");
      throw error;
    }
  }

  refreshRetryMetadata(work, source = "retry:track-identity") {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='track_identity'").get()) return false;
    const row = this.db.prepare(`SELECT identity_key AS identityKey,tidal_id AS tidalId,artist,title,
      mix_version AS mixVersion,album,isrc,duration_ms AS durationMs,last_seen_at AS lastSeenAt
      FROM track_identity WHERE identity_key=?`).get(JSON.parse(work.track_json).identityKey);
    const seenAt = row ? metadataTime(row.lastSeenAt) : 0;
    const metadataAt = work.metadata_updated_at || work.requested_at;
    if (!row || seenAt <= metadataAt || `tidal:${row.tidalId}` !== JSON.parse(work.track_json).identityKey) return false;
    // last_seen_at describes observations, not canonical verification: memory
    // can retain that MAX timestamp while older observations replace captions.
    // This bounded refresh therefore never bypasses the strict TIDAL resolver.
    return this.refreshMetadata(work, row, { source, observedAt: seenAt });
  }

  enqueue(trackInput, { priority = 6, source = "catalog", lazy = false, jobId = "", analyzerKey = "", metadataObservedAt } = {}) {
    if (!consistentTidalIdentity(trackInput)) return "ineligible";
    const track = coverageTrack(trackInput);
    if (!track) return "ineligible";
    if (analyzerKey && trackInput.analysisLocal) track.analysisLocal = trackInput.analysisLocal;
    const workKey = analyzerKey ? `analysis:${analyzerKey}:${require("./sonicAnalysisSpec").hash(track.identityKey + (track.analysisLocal?.sha256 || ""))}` : `production:${MODEL_VERSION}:${track.identityKey}`;
    const old = this.db.prepare("SELECT * FROM sonic_coverage_work WHERE identity_key=?").get(workKey);
    const cached = this.existing(track, old?.resolved_identity_key, analyzerKey);
    const now = this.clock();
    const observedAt = metadataTime(metadataObservedAt ?? (trackInput.track || trackInput).metadataObservedAt);
    if (!old) {
      this.db.prepare(`INSERT INTO sonic_coverage_work(identity_key,track_json,priority,source,lazy,state,requested_at,updated_at,analyzer_key,metadata_updated_at,model,model_version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(workKey, JSON.stringify(track), priority, source, Number(lazy), cached ? "embedded" : "pending", now, now, analyzerKey, observedAt && observedAt <= now ? observedAt : now, analyzerKey ? require("./sonicAnalysisSpec").analysisSpec(analyzerKey).repo : MODEL, analyzerKey || MODEL_VERSION);
    } else {
      // Re-reading inventory is not a new metadata observation. Historical and
      // unknown snapshots need explicit metadata age; their source name alone
      // cannot overwrite a correction. The current discovery route supplies an
      // observation receipt time. Known catalog rows use their persisted age.
      if (jobId && source === "known-catalog" && !observedAt) this.refreshRetryMetadata(old, "enqueue:known-catalog");
      else this.refreshMetadata(old, trackInput, { source: `enqueue:${source}`, observedAt, allowMixClear: !jobId });
      const state = cached && old.state !== "running" ? (old.state === "prepared" ? "prepared" : "embedded")
        : ["cancelled", "embedded", "prepared"].includes(old.state) && !cached ? "pending" : old.state;
      this.db.prepare(`UPDATE sonic_coverage_work SET priority=MIN(priority,?),lazy=MAX(lazy,?),
        metadata_updated_at=CASE WHEN metadata_updated_at=0 THEN requested_at ELSE metadata_updated_at END,
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
          const state = this.enqueue(track, { priority: 0, source: "discovery", lazy: true,
            metadataObservedAt: (track.track || track).metadataObservedAt ?? this.clock() });
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
    if (this.engine.provider?.name !== MODEL || String(this.engine.provider?.modelVersion) !== MODEL_VERSION) throw new Error("Coverage requires the pinned MERT-v2 FullSong provider.");
    this.configure(options);
    const current = this.latestJob();
    if (current && ["running", "paused"].includes(current.state)) return this.resume(options);
    const now = this.clock();
    this.db.prepare("INSERT INTO sonic_coverage_job(id,state,created_at,updated_at,model,model_version) VALUES(?,'running',?,?,?,?)").run(randomUUID(), now, now, MODEL, MODEL_VERSION);
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
    if (job && ["paused", "running", "cancelled", "failed"].includes(job.state)) {
      this.db.prepare("UPDATE sonic_coverage_job SET state='running',error='',updated_at=? WHERE id=?").run(this.clock(), job.id);
    }
    if (job?.state === "cancelled") this.db.prepare("UPDATE sonic_coverage_work SET state='pending' WHERE state='cancelled' AND identity_key IN (SELECT identity_key FROM sonic_coverage_job_item WHERE job_id=?)").run(job.id);
    if (retryFailed) {
      this.transaction(() => {
        const failed = this.db.prepare(`SELECT * FROM sonic_coverage_work WHERE analyzer_key='' AND model_version='${MODEL_VERSION}' AND state='failed'
          AND claim_token IS NULL AND (lazy=1 OR identity_key IN (SELECT identity_key FROM sonic_coverage_job_item WHERE job_id=?))`).all(job?.id || "");
        for (const work of failed) {
          this.refreshRetryMetadata(work);
          const current = this.db.prepare("SELECT * FROM sonic_coverage_work WHERE identity_key=?").get(work.identity_key);
          this.auditMetadata(current, current.track_json, "retry", "explicit-retry");
          this.db.prepare("UPDATE sonic_coverage_work SET state='pending',attempts=0,available_at=0,last_error='' WHERE identity_key=? AND state='failed' AND claim_token IS NULL").run(work.identity_key);
        }
        if (job?.state === "completed") this.db.prepare("UPDATE sonic_coverage_job SET state='running' WHERE id=?").run(job.id);
      });
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
      this.db.prepare(`UPDATE sonic_coverage_work SET state='cancelled' WHERE state='pending' AND ((analyzer_key='' AND model_version='${MODEL_VERSION}') OR ?) AND (lazy=0 OR ?)`).run(Number(scope === "all"), Number(scope === "all"));
      if (scope === "all") { this.settings.paused = true; this.persistSettings(); }
    });
    return this.status();
  }

  queueDepth() { return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM sonic_coverage_work WHERE analyzer_key='' AND model_version='${MODEL_VERSION}' AND state IN ('pending','running')`).get().n); }

  status() {
    const job = this.latestJob();
    const groups = job ? this.db.prepare(`SELECT w.state,i.initially_embedded,COUNT(*) AS n FROM sonic_coverage_job_item i
      JOIN sonic_coverage_work w USING(identity_key) WHERE job_id=? GROUP BY w.state,i.initially_embedded`).all(job.id) : [];
    const counts = { totalEligible: 0, alreadyEmbedded: 0, preparedSuccessfully: 0, failed: 0, remaining: 0 };
    for (const row of groups) {
      counts.totalEligible += row.n;
      if (row.state === "embedded" || (row.initially_embedded && row.state === "prepared")) counts.alreadyEmbedded += row.n;
      else if (row.state === "prepared") counts.preparedSuccessfully += row.n;
      else if (row.state === "failed") counts.failed += row.n;
      else counts.remaining += row.n;
    }
    return {
      legacyQueueCounts: Object.fromEntries(this.db.prepare("SELECT state,COUNT(*) n FROM sonic_coverage_work WHERE analyzer_key='' AND model_version<>? GROUP BY state").all(MODEL_VERSION).map(row => [row.state,row.n])),
      workerError: this.workerError || null,
      workStates: Object.fromEntries(this.db.prepare(`SELECT CASE WHEN state='pending' AND available_at>? THEN 'retrying' WHEN state='pending' THEN 'queued' ELSE state END AS status, COUNT(*) n FROM sonic_coverage_work WHERE analyzer_key='' AND model_version=? GROUP BY status`).all(this.clock(),MODEL_VERSION).map(row=>[row.status,row.n])),
      retrying: this.db.prepare("SELECT json_extract(track_json,'$.identityKey') identityKey,last_error error,available_at retryAt,attempts FROM sonic_coverage_work WHERE analyzer_key='' AND model_version=? AND state='pending' AND last_error<>'' ORDER BY updated_at DESC LIMIT 5").all(MODEL_VERSION),
      availability: !this.engine?.enabled || !this.engine?.store?.enabled ? "unavailable" : this.engine?.provider?.name === MODEL && this.engine?.provider?.modelVersion === MODEL_VERSION ? "available" : "unavailable",
      ok: true, model: MODEL, modelVersion: MODEL_VERSION, scope: "embedding-coverage-only",
      settings: { ...this.settings }, activeCount: [...this.active.keys()].filter(key => !key.startsWith("analysis:")).length,
      sharedActiveCount: this.active.size, queueDepth: this.queueDepth(),
      job: job ? { model: MODEL, modelVersion: MODEL_VERSION, id: job.id, state: job.state, inventoryComplete: Boolean(job.scan_complete), createdAt: job.created_at, updatedAt: job.updated_at, error: job.error, ...counts } : null,
      queueCounts: Object.fromEntries(this.db.prepare(`SELECT state,COUNT(*) AS n FROM sonic_coverage_work WHERE analyzer_key='' AND model_version='${MODEL_VERSION}' GROUP BY state`).all().map(row => [row.state, row.n])),
      recentFailures: this.db.prepare(`SELECT json_extract(track_json,'$.identityKey') AS identityKey,source,last_error AS error,attempts FROM sonic_coverage_work WHERE analyzer_key='' AND model_version='${MODEL_VERSION}' AND state='failed' ORDER BY updated_at DESC LIMIT 5`).all()
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
    // Reuse only an existing EXACT local identity link; filenames/titles cannot authorize a source.
    let local;
    if (this.analysis && this.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('local_library_file','local_library_identity_link','track_identity')").get().n === 3) {
      local = this.db.prepare(`SELECT m.file_path file,m.file_hash sha256,m.id localFileId FROM local_library_file m
        JOIN local_library_identity_link l ON l.local_file_id=m.id JOIN track_identity ti ON ti.id=l.track_identity_id
        WHERE ti.identity_key=? AND m.status='processed' AND l.link_status='EXACT' AND LENGTH(m.file_hash)=64
        AND NOT EXISTS(SELECT 1 FROM local_library_identity_link other WHERE other.local_file_id=m.id AND other.link_status<>'EXACT')
        ORDER BY m.id LIMIT 1`).get(resolved.identityKey);
    }
    const promise = local ? this.analysis.prepare({ ...resolved, analysisLocal: local }, MODEL_VERSION).then(result=>({...result,ready:true})) : this.engine.prepareSonicAnchor(resolved, {
      model: MODEL, modelVersion: MODEL_VERSION, allowVersionProxy: false,
      requireValidEmbedding: true, backgroundExtraction: true
    });
    this.preparing.set(resolved.identityKey, promise);
    try {
      const result = await promise;
      if (!result.ready || !this.existing(resolved, result.identityKey)) throw new Error("Preparation did not persist a valid matching MERT-v2 FullSong embedding.");
      return result;
    } finally { this.preparing.delete(resolved.identityKey); }
  }

  async prepareOnDemand(reference) {
    const stored = this.existing(reference);
    if (stored) return { ok: true, ready: true, prepared: false, identityKey: stored.identityKey,
      model: stored.model, modelVersion: stored.modelVersion, track: stored.track };
    const canonical = await this.engine.resolveTidalTrackReference(reference);
    const track = coverageTrack({ ...canonical, tidalId: canonical.tidalId || canonical.id });
    if (!track) throw new Error("No eligible exact track identity was resolved.");
    const key = `production:${MODEL_VERSION}:${track.identityKey}`;
    this.enqueue(track, { priority: 0, source: "sonic-review", lazy: true, metadataObservedAt: this.clock() });
    if (this.active.has(key)) await this.active.get(key);
    if (!this.existing(track)) {
      if (this.active.size >= this.settings.concurrency) throw Object.assign(new Error("Sonic worker busy; this anchor is queued. Retry shortly."), { statusCode: 503 });
      const work = this.db.prepare("SELECT * FROM sonic_coverage_work WHERE identity_key=?").get(key);
      if (work.state === "failed") this.auditMetadata(work, work.track_json, "retry", "explicit-anchor-retry");
      work.claim_token = randomUUID(); work.attempts = work.state === "failed" ? 1 : work.attempts + 1;
      this.db.prepare("UPDATE sonic_coverage_work SET state='running',attempts=?,claim_token=?,updated_at=? WHERE identity_key=?")
        .run(work.attempts, work.claim_token, this.clock(), key);
      const promise = this.processWork(work).finally(() => { this.active.delete(key); this.schedule(); });
      this.active.set(key, promise);
      await promise;
      if (!this.existing(track)) {
        const failed = this.db.prepare("SELECT * FROM sonic_coverage_work WHERE identity_key=?").get(key);
        throw Object.assign(new Error(failed.last_error || "Anchor preparation did not produce a valid embedding."), { statusCode: failed.state === "pending" ? 503 : 422 });
      }
    }
    const result = this.existing(track);
    return { ok: true, ready: true, identityKey: result.identityKey, model: result.model, modelVersion: result.modelVersion, prepared: true, track: result.track };
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
      const transient = !error.bandcamp && (resourceWait || [408, 429, 500, 502, 503, 504].includes(code) || /timeout|timed out|ECONN|fetch failed|network/i.test(errorText));
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
    // Only the current production namespace runs; legacy work stays preserved.
    // Optional analyzers share rate and concurrency limits.
    const productionEnabled = this.engine.provider?.name === MODEL && String(this.engine.provider?.modelVersion) === MODEL_VERSION;
    if (productionEnabled && !this.scanning) void this.scanInventory();
    if (this.active.size >= this.settings.concurrency) return;
    const control = this.db.prepare("SELECT next_start_at,batch_count FROM sonic_coverage_control WHERE id=1").get();
    if (control.next_start_at > this.clock()) { this.schedule(Math.min(60000, control.next_start_at - this.clock())); return; }
    const analyzerKeys = JSON.stringify(this.analysis?.enabledKeys() || []);
    const analysisIdle = !this.analysis?.worker?.pending && ![...this.active.keys()].some(key => key.startsWith("analysis:"));
    const eligible = `((w.analyzer_key='' AND w.model_version='${MODEL_VERSION}' AND ? AND ((lazy=1 AND ?) OR EXISTS(
      SELECT 1 FROM sonic_coverage_job_item i JOIN sonic_coverage_job j ON j.id=i.job_id
      WHERE i.identity_key=w.identity_key AND j.state='running' AND j.scan_complete=1)))
      OR (w.analyzer_key IN (SELECT value FROM json_each(?)) AND ?))`;
    const work = this.transaction(() => {
      const row = this.db.prepare(`SELECT w.* FROM sonic_coverage_work w WHERE state='pending' AND available_at<=? AND
        ${eligible}
        ORDER BY CASE WHEN analyzer_key='' AND lazy=1 THEN 0 WHEN analyzer_key<>'' AND lazy=1 THEN 1
          WHEN analyzer_key='' THEN 2 ELSE 3 END,
          CASE WHEN lazy=1 THEN requested_at END DESC,priority,analyzer_key,requested_at,identity_key LIMIT 1`)
        .get(this.clock(), Number(productionEnabled), Number(this.settings.lazyEnabled), analyzerKeys, Number(analysisIdle));
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
      const promise = this.processWork(work).catch(error => {
        this.workerError = error.message;
        this.logger?.error?.("Sonic coverage completion failed", { error: error.message });
        try { this.db.prepare("UPDATE sonic_coverage_work SET state='failed',claim_token=NULL,last_error=? WHERE identity_key=?").run("Worker persistence failure: " + error.message, work.identity_key); }
        catch { this.settings.paused = true; /* Expose workerError even if SQLite cannot accept a failure receipt. */ }
      })
        .finally(() => { this.active.delete(work.identity_key); this.schedule(); });
      this.active.set(work.identity_key, promise);
      this.schedule(this.settings.minIntervalMs);
    } else {
      const job = this.latestJob();
      if (job?.state === "running" && job.scan_complete && this.status().job.remaining === 0) {
        this.db.prepare("UPDATE sonic_coverage_job SET state=?,updated_at=? WHERE id=?").run(this.status().job.failed ? 'failed' : 'completed', this.clock(), job.id);
      }
      // Paused/cancelled bulk inventory must not cause a permanent polling
      // loop. Only retry eligible work; enqueue/resume/inventory completion
      // explicitly wake the scheduler when new work becomes available.
      const next = this.db.prepare(`SELECT MIN(w.available_at) AS at FROM sonic_coverage_work w WHERE state='pending' AND ${eligible}`)
        .get(Number(productionEnabled), Number(this.settings.lazyEnabled), analyzerKeys, Number(analysisIdle));
      if (next.at !== null) this.schedule(Math.max(50, Math.min(60000, next.at - this.clock())));
      else if (!analysisIdle) this.schedule(2000);
    }
  }

  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.scheduledAt = 0; }
}

module.exports = { SonicCoverageService, settingsFor };
