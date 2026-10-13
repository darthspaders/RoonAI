"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const STATES = new Set(["pending", "waiting_model", "running", "failed", "completed"]);
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const text = value => String(value ?? "").trim();
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

function feedbackRevisionKey(feedbackKey, entry) {
  return hash(JSON.stringify([feedbackKey, text(entry.updatedAt), text(entry.calibration?.recordedAt)]));
}

function eligibleFeedback(entry) {
  if (!entry || !entry.calibration || typeof entry.calibration !== "object" ||
      entry.isRadio || entry.isLiveRadio || !text(entry.artist) || !text(entry.title)) return false;
  return !text(entry.calibration.modelAction) || text(entry.calibration.modelAction).toLowerCase() === "unreviewed";
}

function validateStore(value) {
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const nonnegative = value => Number.isFinite(value) && value >= 0;
  if (!object(value) || value.version !== 1 || typeof value.paused !== "boolean" || !Array.isArray(value.items) || !nonnegative(value.nextRunAt)) {
    throw new Error("Retrospective review backlog is invalid; the existing file was preserved.");
  }
  const ids = new Set();
  for (const item of value.items) {
    if (!object(item) || !text(item.id) || ids.has(item.id) || !text(item.feedbackKey) || !STATES.has(item.state) ||
        !object(item.original) || !text(item.original.artist) || !text(item.original.title) || !object(item.original.calibration) ||
        !object(item.input) || !object(item.input.track) || !text(item.input.track.artist) || !text(item.input.track.title) ||
        !["original-request", "metadata-only"].includes(item.input.contextQuality) ||
        !Number.isInteger(item.failures) || item.failures < 0 || !Number.isInteger(item.attempts) || item.attempts < 0 ||
        !Number.isInteger(item.manualRetries) || item.manualRetries < 0 || !nonnegative(item.priorityAt) || !nonnegative(item.nextAttemptAt) ||
        !Number.isFinite(Date.parse(item.createdAt)) || item.id !== feedbackRevisionKey(item.feedbackKey, item.original) ||
        (item.state === "completed" && (!object(item.result) || !Number.isFinite(Date.parse(item.reviewedAt)) ||
          !text(item.provider) || !text(item.model) || item.accuracyEligible !== false ||
          !["original-request", "metadata-only"].includes(item.contextQuality)))) {
      throw new Error("Retrospective review backlog contains an invalid item; the existing file was preserved.");
    }
    ids.add(item.id);
    if (item.state === "completed") safeResult(item.result);
  }
  return value;
}

function safeInput(value) {
  if (!value || !value.track || !text(value.track.artist) || !text(value.track.title) ||
      !["original-request", "metadata-only"].includes(value.contextQuality)) {
    throw new Error("Retrospective review input is incomplete.");
  }
  const forbidden = new Set(["rating", "feedback", "calibration", "modelReview", "llmReview", "tasteProfile", "taste", "memory", "currentMemory"]);
  function clean(input) {
    if (Array.isArray(input)) return input.map(clean);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.entries(input).filter(([key]) => !forbidden.has(key)).map(([key, child]) => [key, clean(child)]));
  }
  return copy({ track: clean(value.track), options: clean(value.options || {}), contextQuality: value.contextQuality, snapshotAt: value.snapshotAt || null });
}

function safeResult(value) {
  if (!value || !Array.isArray(value.scores) || value.scores.length !== 1 || !value.scores[0] || typeof value.scores[0] !== "object") {
    throw new Error("Retrospective scorer did not return one validated candidate review.");
  }
  // The prompt may contain private request text. Persist only the normalized assessment.
  return copy(Object.fromEntries(["scores", "rawCount", "model", "contextQuality", "snapshotAt", "assessmentType"]
    .filter(key => value[key] !== undefined).map(key => [key, value[key]])));
}

class ModelReviewBacklog {
  constructor({ filePath, listFeedback, modelHealth, scoreReview, isForegroundBusy = () => false,
    now = Date.now, pollMs = 60_000, minimumIntervalMs = 30_000, onChange = () => {}, inputForFeedback } = {}) {
    if (!filePath || typeof listFeedback !== "function" || typeof modelHealth !== "function" || typeof scoreReview !== "function") {
      throw new Error("Retrospective backlog requires a file and explicit feedback, health, and scorer callbacks.");
    }
    this.filePath = filePath;
    this.listFeedback = listFeedback;
    this.modelHealth = modelHealth;
    this.scoreReview = scoreReview;
    this.isForegroundBusy = isForegroundBusy;
    this.now = now;
    this.pollMs = Math.max(1000, Number(pollMs) || 60_000);
    this.minimumIntervalMs = Math.max(30_000, Number(minimumIntervalMs) || 30_000);
    this.onChange = onChange;
    this.inputForFeedback = inputForFeedback || require("./retrospectiveReviewInput").inputForFeedback;
    this.store = { version: 1, paused: false, nextRunAt: 0, items: [] };
    this._diskHash = null;
    this._blocked = "";
    this._state = "idle";
    this._started = false;
    this._stopped = false;
    this._epoch = 0;
    this._deferUntil = 0;
    this._health = null;
    this._lastError = "";
    this._timer = null;
    this._runPromise = null;
    this._syncPromise = null;
    this._activeItem = null;
    this._controller = null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      this.store = validateStore(JSON.parse(raw));
      this._diskHash = hash(raw);
      for (const item of this.store.items) if (item.state === "running") {
        item.state = "pending";
        item.attempts = Math.max(0, item.attempts - 1);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this._block(error);
    }
  }

  _emit() { try { this.onChange(this.status()); } catch { /* UI notifications cannot break persistence. */ } }

  _block(error) {
    this._blocked = error?.message || String(error);
    this._state = "blocked";
    this._epoch += 1;
    this._controller?.abort();
    clearTimeout(this._timer);
    this._timer = null;
    this._emit();
  }

  _save() {
    if (this._blocked) return false;
    let temporary;
    try {
      let existing = null;
      try { existing = fs.readFileSync(this.filePath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing !== null) validateStore(JSON.parse(existing));
      if ((existing === null ? null : hash(existing)) !== this._diskHash) {
        throw new Error("Retrospective backlog changed outside this process; the existing file was preserved.");
      }
      validateStore(this.store);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      temporary = `${this.filePath}.${randomUUID()}.tmp`;
      const raw = JSON.stringify(this.store, null, 2);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filePath);
      this._diskHash = hash(raw);
      this._emit();
      return true;
    } catch (error) {
      if (temporary) try { fs.unlinkSync(temporary); } catch { /* Leave the existing backlog intact. */ }
      this._block(error);
      return false;
    }
  }

  _schedule(delay = this.pollMs) {
    if (!this._started || this._stopped || this._blocked) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.sync().then(() => this._kick()).catch(error => { this._lastError = error.message; this._schedule(); this._emit(); });
    }, Math.max(0, delay));
    this._timer.unref?.();
  }

  start() {
    if (this._started || this._blocked) return this.status();
    this._started = true;
    this._stopped = false;
    if (this._save()) this._schedule(0);
    return this.status();
  }

  stop() {
    this._started = false;
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    this._cancelActive();
    this._state = "stopped";
    this._emit();
    return this.status();
  }

  _cancelActive() {
    this._epoch += 1;
    this._controller?.abort();
    if (this._activeItem?.state === "running") {
      this._activeItem.state = "pending";
      this._activeItem.attempts = Math.max(0, this._activeItem.attempts - 1);
      this._activeItem.nextAttemptAt = Math.max(Number(this.store.nextRunAt || 0), this.now() + this.minimumIntervalMs);
      this._save();
    }
    this._activeItem = null;
    this._controller = null;
  }

  pause() {
    if (this._blocked) return this.status();
    this.store.paused = true;
    this._cancelActive();
    this._state = "paused";
    this._save();
    this._schedule();
    return this.status();
  }

  yieldToForeground() {
    if (this._blocked || this._stopped || this.store.paused) return this.status();
    this._cancelActive();
    this._deferUntil = this.now() + this.minimumIntervalMs;
    this.store.nextRunAt = Math.max(Number(this.store.nextRunAt || 0), this._deferUntil);
    this._state = "foreground_busy";
    this._save();
    this._schedule(this.pollMs);
    return this.status();
  }

  sync() {
    if (this._syncPromise) return this._syncPromise;
    this._syncPromise = (async () => {
      if (this._blocked) return this.status();
      const feedback = await this.listFeedback();
      const known = new Set(this.store.items.map(item => item.id));
      for (const [feedbackKey, entry] of Object.entries(feedback || {})) {
        if (!eligibleFeedback(entry)) continue;
        const id = feedbackRevisionKey(feedbackKey, entry);
        if (known.has(id)) continue;
        const original = copy(entry);
        const input = safeInput(this.inputForFeedback(copy(original)));
        this.store.items.push({ id, feedbackKey, original, input, state: "pending", failures: 0, attempts: 0,
          manualRetries: 0, priorityAt: timestamp(entry.updatedAt) || timestamp(entry.calibration.recordedAt),
          createdAt: new Date(this.now()).toISOString(), nextAttemptAt: 0, error: "" });
        known.add(id);
      }
      this._save();
      return this.status();
    })().finally(() => { this._syncPromise = null; });
    return this._syncPromise;
  }

  async requestReview() {
    await this.sync();
    if (this._blocked || this._stopped) return this.status();
    this.store.paused = false;
    // An explicit click rechecks availability immediately, retaining the model-use rate limit.
    this._deferUntil = 0;
    for (const item of this.store.items) if (item.state === "failed") {
      item.state = "pending";
      item.failures = 0;
      item.nextAttemptAt = 0;
      item.manualRetries += 1;
    }
    if (this._save()) { this._state = "pending"; this._kick(); }
    return this.status();
  }

  _kick() {
    if (this._runPromise) return this._runPromise;
    this._runPromise = this._runOne().catch(error => {
      this._lastError = error.message;
      this._deferUntil = this.now() + this.pollMs;
      this._emit();
    }).finally(() => {
      this._runPromise = null;
      this._activeItem = null;
      this._controller = null;
      const hasPending = this.store.items.some(item => ["pending", "waiting_model"].includes(item.state));
      const earliest = Math.min(...this.store.items.filter(item => ["pending", "waiting_model"].includes(item.state)).map(item => Number(item.nextAttemptAt || 0)));
      const due = Math.max(this._deferUntil, Number(this.store.nextRunAt || 0), Number.isFinite(earliest) ? earliest : 0);
      this._schedule(hasPending && !this.store.paused ? Math.max(1000, due - this.now()) : this.pollMs);
    });
    return this._runPromise;
  }

  async _runOne() {
    if (this._blocked || this._stopped || this.store.paused) return;
    const now = this.now();
    if (now < Math.max(this._deferUntil, Number(this.store.nextRunAt || 0))) return;
    const item = this.store.items.filter(value => ["pending", "waiting_model"].includes(value.state) && Number(value.nextAttemptAt || 0) <= now)
      .sort((a, b) => b.priorityAt - a.priorityAt || a.id.localeCompare(b.id))[0];
    if (!item) { this._state = "idle"; return; }
    const epoch = this._epoch;
    if (await this.isForegroundBusy()) {
      if (epoch !== this._epoch) return;
      this._state = "foreground_busy";
      this._deferUntil = this.now() + this.pollMs;
      this._emit();
      return;
    }
    let health;
    try { health = await this.modelHealth(); } catch (error) { this._lastError = error.message; health = null; }
    if (epoch !== this._epoch || this._blocked || this._stopped || this.store.paused) return;
    this._health = health;
    if (health?.retrospectiveReady !== true || !text(health.provider) || !text(health.model)) {
      for (const waiting of this.store.items) if (["pending", "waiting_model"].includes(waiting.state)) waiting.state = "waiting_model";
      this._state = "waiting_model";
      this._deferUntil = this.now() + this.pollMs;
      this._save();
      return;
    }
    if (await this.isForegroundBusy()) {
      if (epoch !== this._epoch) return;
      this._state = "foreground_busy";
      this._deferUntil = this.now() + this.pollMs;
      this._emit();
      return;
    }
    if (epoch !== this._epoch || this.store.paused || this._stopped || this._blocked) return;
    this._state = "running";
    this._activeItem = item;
    this._controller = new AbortController();
    item.state = "running";
    item.attempts += 1;
    this.store.nextRunAt = this.now() + this.minimumIntervalMs;
    if (!this._save()) return;
    const model = { provider: text(health.provider), model: text(health.model) };
    try {
      const result = safeResult(await this.scoreReview({ input: safeInput(item.input), model, signal: this._controller.signal }));
      if (epoch !== this._epoch || this._blocked || this._stopped || this.store.paused) return;
      Object.assign(item, { state: "completed", result, reviewedAt: new Date(this.now()).toISOString(),
        provider: model.provider, model: model.model, contextQuality: item.input.contextQuality, accuracyEligible: false, error: "" });
      this._lastError = "";
      this._state = "pending";
      this._save();
    } catch (error) {
      if (epoch !== this._epoch || this._blocked || this._stopped || this.store.paused) return;
      item.failures += 1;
      item.error = error?.message || String(error);
      item.state = item.failures >= 3 ? "failed" : "pending";
      item.nextAttemptAt = this.now() + Math.min(300_000, this.minimumIntervalMs * (2 ** (item.failures - 1)));
      this._deferUntil = item.nextAttemptAt;
      this._lastError = item.error;
      this._state = item.state === "failed" ? "idle" : "pending";
      this._save();
    }
  }

  status() {
    const counts = { pending: 0, running: 0, waiting_model: 0, failed: 0, completed: 0, total: this.store.items.length };
    for (const item of this.store.items) counts[item.state] += 1;
    const recentResults = this.store.items.filter(item => item.state === "completed")
      .sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt))).slice(0, 10)
      .map(item => ({ id: item.id, feedbackKey: item.feedbackKey, artist: item.original.artist, title: item.original.title,
        rating: item.original.rating, originalModelAction: item.original.calibration.modelAction || "unreviewed",
        originalScore: item.original.calibration.score ?? item.original.score ?? null,
        originalModelScore: item.original.calibration.modelScore ?? null, reviewedAt: item.reviewedAt,
        provider: item.provider, model: item.model, contextQuality: item.contextQuality, accuracyEligible: false, result: copy(item.result) }));
    const pendingCount = counts.pending + counts.waiting_model + counts.running;
    const workState = pendingCount ? (this._state === "idle" ? "pending" : this._state) : "idle";
    return { state: this._blocked ? "blocked" : this._stopped ? "stopped" : this.store.paused ? "paused" : counts.running ? "running" : workState,
      paused: this.store.paused, running: Boolean(this._runPromise && this._activeItem), counts, pendingCount,
      failedCount: counts.failed, completedCount: counts.completed, lastError: this._blocked || this._lastError,
      nextAttemptAt: pendingCount ? Math.max(this._deferUntil, Number(this.store.nextRunAt || 0)) : null,
      modelReady: this._health?.retrospectiveReady === true && Boolean(text(this._health.provider) && text(this._health.model)),
      model: this._health ? { provider: this._health.provider || "", model: this._health.model || "" } : null,
      contextNote: "Reviews made afterward are separate from original predictions and accuracy. Older feedback may have metadata-only context.",
      accuracyEligible: false, recentResults };
  }
}

module.exports = { ModelReviewBacklog, feedbackRevisionKey, eligibleFeedback };
