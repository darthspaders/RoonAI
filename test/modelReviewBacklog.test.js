"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelReviewBacklog } = require("../src/modelReviewBacklog");

const clone = value => JSON.parse(JSON.stringify(value));
const ready = { retrospectiveReady: true, provider: "lmstudio", model: "configured-model:1" };
const result = { prompt: "private request must not persist", scores: [{ trackId: "tidal:1", rejected: false,
  rejectionReason: "", finalScore: 64, scores: { tasteMatch: null, promptMatch: null, genreConfidence: 58 }, why: ["Limited catalog evidence"] }],
  rawCount: 1, model: "configured-model:1", contextQuality: "metadata-only", snapshotAt: null,
  assessmentType: "retrospective-catalog-request" };

function feedback(overrides = {}) {
  return { artist: "Artist", title: "Track", rating: "love", tidalUrl: "https://tidal.com/browse/track/1", score: 42,
    updatedAt: "2026-10-07T12:00:00.000Z", calibration: { recordedAt: "2026-10-07T12:00:00.000Z", modelAction: "unreviewed", score: 42 }, ...overrides };
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-model-backlog-test-"));
  const filePath = path.join(directory, "backlog.json");
  const state = { clock: Date.parse("2026-10-07T13:00:00.000Z"), feedback: { "tidal:1": feedback() }, health: ready,
    busy: false, healthCalls: 0, calls: [] };
  const callbacks = { filePath, now: () => state.clock, pollMs: 60_000, minimumIntervalMs: 30_000,
    listFeedback: () => state.feedback,
    modelHealth: async () => { state.healthCalls += 1; return state.health; },
    isForegroundBusy: () => state.busy,
    inputForFeedback: entry => ({ track: { artist: entry.artist, title: entry.title, tidalUrl: entry.tidalUrl }, options: {},
      contextQuality: "metadata-only", snapshotAt: null }),
    scoreReview: async args => { state.calls.push(args); return clone(result); }, ...overrides };
  const backlog = new ModelReviewBacklog(callbacks);
  t.after(() => {
    backlog.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { backlog, state, filePath, callbacks };
}

async function drain(backlog) {
  // The API returns before the model finishes. Settle only this fixture's injected scorer.
  await Promise.resolve();
  if (backlog._runPromise) await backlog._runPromise;
}

async function enteredScorer(predicate) {
  for (let turn = 0; turn < 10 && !predicate(); turn += 1) await Promise.resolve();
  assert.ok(predicate(), "the injected scorer must be entered before cancellation");
}

test("constructor is passive; sync persists immutable revisions and repeated sync/clicks do not repeat completed reviews", async t => {
  const { backlog, state, filePath } = fixture(t);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(state.healthCalls, 0);
  const original = clone(state.feedback);
  await Promise.all([backlog.sync(), backlog.sync()]);
  assert.equal(backlog.status().counts.total, 1);
  await Promise.all([backlog.requestReview(), backlog.requestReview(), backlog.requestReview()]);
  await drain(backlog);
  assert.equal(state.calls.length, 1);
  state.clock += 120_000;
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.feedback, original);
  assert.equal(backlog.status().state, "idle");
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.items[0].original, original["tidal:1"]);
  assert.equal(saved.items[0].result.prompt, undefined);
  assert.equal(saved.items[0].accuracyEligible, false);
  assert.equal(backlog.status().recentResults[0].originalScore, 42);
  assert.equal(backlog.status().recentResults[0].rating, "love");
});

test("unloaded or merely online models wait without attempts; explicit request works after reconnect", async t => {
  const { backlog, state, filePath } = fixture(t);
  state.health = { retrospectiveReady: false, online: true, loaded: true, provider: "lmstudio", model: "configured-model:1" };
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(backlog.status().state, "waiting_model");
  assert.equal(backlog.status().modelReady, false);
  assert.equal(state.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).items[0].attempts, 0);
  state.health = ready;
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls.length, 1);
  assert.equal(backlog.status().completedCount, 1);
});

test("model health is rechecked before each candidate and the 30 second interval survives repeated clicks", async t => {
  const { backlog, state } = fixture(t);
  state.feedback["tidal:2"] = feedback({ title: "Second", updatedAt: "2026-10-07T12:01:00.000Z" });
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls[0].input.track.title, "Second");
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls.length, 1);
  state.clock += 30_000;
  state.health = { ...ready, retrospectiveReady: false };
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls.length, 1);
  assert.equal(state.healthCalls, 2);
  assert.equal(backlog.status().counts.waiting_model, 1);
});

test("foreground work defers health and scoring, and automatic start does not load a model", async t => {
  const { backlog, state } = fixture(t);
  state.busy = true;
  backlog.start();
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(backlog.status().state, "foreground_busy");
  assert.equal(state.healthCalls, 0);
  assert.equal(state.calls.length, 0);
  state.busy = false;
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls.length, 1);
});

test("pause aborts the signal, persists pause, and fences a scorer that completes late", async t => {
  let finish;
  let signal;
  const { backlog, state, callbacks, filePath } = fixture(t, { scoreReview: args => {
    signal = args.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  await backlog.requestReview();
  await enteredScorer(() => Boolean(signal));
  assert.equal(backlog.status().counts.running, 1);
  backlog.pause();
  assert.equal(signal.aborted, true);
  assert.equal(backlog.status().paused, true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).paused, true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).items[0].attempts, 0);
  finish(clone(result));
  await drain(backlog);
  assert.equal(backlog.status().completedCount, 0);
  assert.equal(backlog.status().counts.pending, 1);
  const restored = new ModelReviewBacklog(callbacks);
  t.after(() => restored.stop());
  assert.equal(restored.status().paused, true);
  assert.equal(restored.status().counts.pending, 1);
  assert.equal(state.feedback["tidal:1"].rating, "love");
});

test("foreground preemption fences late completion without durable pause and preserves single concurrency", async t => {
  let finish;
  const calls = [];
  const { backlog, state, filePath } = fixture(t, { scoreReview: args => {
    calls.push(args);
    return new Promise(resolve => { finish = resolve; });
  } });
  await backlog.requestReview();
  await enteredScorer(() => calls.length === 1);
  backlog.yieldToForeground();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(backlog.status().paused, false);
  await backlog.requestReview();
  assert.equal(calls.length, 1);
  finish(clone(result));
  await drain(backlog);
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(calls.length, 1);
  assert.equal(backlog.status().completedCount, 0);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).items[0].failures, 0);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).items[0].attempts, 0);
  state.clock += 30_000;
  await backlog.requestReview();
  await enteredScorer(() => calls.length === 2);
  assert.equal(calls.length, 2);
  finish(clone(result));
  await drain(backlog);
  assert.equal(backlog.status().completedCount, 1);
});

test("stop cancels active work and a late result cannot be committed", async t => {
  let finish;
  let signal;
  const { backlog } = fixture(t, { scoreReview: args => {
    signal = args.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  await backlog.requestReview();
  await enteredScorer(() => Boolean(signal));
  backlog.stop();
  assert.equal(signal.aborted, true);
  finish(clone(result));
  await drain(backlog);
  assert.equal(backlog.status().completedCount, 0);
  assert.equal(backlog.status().state, "stopped");
});

test("revised feedback gets a separate deterministic item and newest revisions run first", async t => {
  const { backlog, state, filePath } = fixture(t);
  await backlog.sync();
  state.feedback["tidal:1"] = feedback({ rating: "dislike", title: "Revised", updatedAt: "2026-10-07T12:02:00.000Z",
    calibration: { recordedAt: "2026-10-07T12:02:00.000Z", modelAction: "unreviewed", score: 73 } });
  await backlog.sync();
  await backlog.sync();
  assert.equal(backlog.status().counts.total, 2);
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(state.calls[0].input.track.title, "Revised");
  assert.equal(backlog.status().recentResults[0].rating, "dislike");
  const items = JSON.parse(fs.readFileSync(filePath, "utf8")).items;
  assert.equal(items[0].original.rating, "love");
  assert.equal(items[1].original.rating, "dislike");
  assert.notEqual(items[0].id, items[1].id);
});

test("reviewed, radio, uncalibrated, and unnamed feedback are excluded", async t => {
  const { backlog, state } = fixture(t);
  state.feedback = { good: feedback(), missingAction: feedback({ calibration: { recordedAt: "2026-10-07T12:03:00Z" } }),
    reviewed: feedback({ calibration: { modelAction: "boosted" } }), radio: feedback({ isRadio: true }),
    live: feedback({ isLiveRadio: true }), noCalibration: feedback({ calibration: null }), unnamed: feedback({ title: "" }) };
  await backlog.sync();
  assert.equal(backlog.status().counts.total, 2);
});

test("scorer receives no human rating, calibration, taste, or memory; original accuracy stays unreviewed", async t => {
  const { backlog, state, filePath } = fixture(t, { inputForFeedback: entry => ({ track: { artist: entry.artist, title: entry.title,
    rating: entry.rating, calibration: entry.calibration, feedback: "love", modelReview: { action: "boosted" },
    nested: { taste: { score: 7 }, memory: "later feedback" } }, options: { request: "House", tasteProfile: { feedback: "love" } },
    contextQuality: "original-request", snapshotAt: "2026-10-07T11:00:00.000Z", rating: entry.rating }) });
  await backlog.requestReview();
  await drain(backlog);
  const input = state.calls[0].input;
  assert.deepEqual(Object.keys(input).sort(), ["contextQuality", "options", "snapshotAt", "track"]);
  assert.equal(input.track.rating, undefined);
  assert.equal(input.track.calibration, undefined);
  assert.equal(input.track.modelReview, undefined);
  assert.deepEqual(input.track.nested, {});
  assert.deepEqual(input.options, { request: "House" });
  const item = JSON.parse(fs.readFileSync(filePath, "utf8")).items[0];
  assert.equal(item.original.calibration.modelAction, "unreviewed");
  assert.equal(item.contextQuality, "original-request");
  assert.equal(item.accuracyEligible, false);
  assert.equal(state.feedback["tidal:1"].calibration.modelAction, "unreviewed");
});

test("three failures stop automatic attempts; manual retry resumes failures without redoing completed items", async t => {
  let failing = true;
  let calls = 0;
  const { backlog, state, filePath } = fixture(t, { scoreReview: async () => {
    calls += 1;
    if (failing) throw new Error("model response invalid");
    return clone(result);
  } });
  await backlog.requestReview();
  await drain(backlog);
  for (const advance of [30_000, 60_000]) {
    state.clock += advance;
    await backlog._kick();
  }
  assert.equal(calls, 3);
  assert.equal(backlog.status().failedCount, 1);
  state.clock += 300_000;
  await backlog._kick();
  assert.equal(calls, 3);
  failing = false;
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(calls, 4);
  assert.equal(backlog.status().completedCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).items[0].manualRetries, 1);
  state.clock += 60_000;
  await backlog.requestReview();
  await drain(backlog);
  assert.equal(calls, 4);
});

test("startup recovers an interrupted running item to pending without model calls", async t => {
  const { backlog, callbacks, filePath, state } = fixture(t);
  await backlog.sync();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  saved.items[0].state = "running";
  fs.writeFileSync(filePath, JSON.stringify(saved));
  const restored = new ModelReviewBacklog(callbacks);
  t.after(() => restored.stop());
  assert.equal(restored.status().counts.pending, 1);
  assert.equal(state.calls.length, 0);
  await restored.requestReview();
  await drain(restored);
  assert.equal(restored.status().completedCount, 1);
});

test("corrupt files block startup and external corruption blocks writes without overwriting evidence", async t => {
  const { backlog, callbacks, filePath, state } = fixture(t);
  const corrupt = "{invalid original bytes";
  fs.writeFileSync(filePath, corrupt);
  const blocked = new ModelReviewBacklog(callbacks);
  t.after(() => blocked.stop());
  blocked.start();
  await blocked.requestReview();
  assert.equal(blocked.status().state, "blocked");
  assert.equal(fs.readFileSync(filePath, "utf8"), corrupt);
  await backlog.sync();
  assert.equal(backlog.status().state, "blocked");
  assert.equal(fs.readFileSync(filePath, "utf8"), corrupt);
  assert.equal(state.calls.length, 0);
});

test("malformed completed snapshots block safely rather than throwing from status or overwriting the file", async t => {
  const { backlog, callbacks, filePath } = fixture(t);
  await backlog.requestReview();
  await drain(backlog);
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete saved.items[0].original.calibration;
  const originalBytes = JSON.stringify(saved);
  fs.writeFileSync(filePath, originalBytes);
  const restored = new ModelReviewBacklog(callbacks);
  t.after(() => restored.stop());
  assert.equal(restored.status().state, "blocked");
  restored.start();
  await restored.requestReview();
  assert.equal(fs.readFileSync(filePath, "utf8"), originalBytes);
});

test("restored retry schedules at its persisted due time and a paused queue polls at the normal interval", async t => {
  const { backlog, callbacks, filePath, state } = fixture(t);
  await backlog.sync();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  saved.items[0].nextAttemptAt = state.clock + 120_000;
  fs.writeFileSync(filePath, JSON.stringify(saved));
  const restored = new ModelReviewBacklog(callbacks);
  t.after(() => restored.stop());
  const scheduled = [];
  restored._started = true;
  restored._schedule = delay => scheduled.push(delay);
  await restored._kick();
  assert.equal(scheduled.at(-1), 120_000);
  assert.equal(state.healthCalls, 0);
  restored.pause();
  await restored._kick();
  assert.equal(scheduled.at(-1), 60_000);
});

test("restored input is sanitized again before scoring so later file fields cannot leak a human judgment", async t => {
  const { backlog, callbacks, filePath, state } = fixture(t);
  await backlog.sync();
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  saved.items[0].input.track.rating = "love";
  saved.items[0].input.track.calibration = { modelAction: "unreviewed" };
  saved.items[0].input.options.memory = "later feedback";
  fs.writeFileSync(filePath, JSON.stringify(saved));
  const restored = new ModelReviewBacklog(callbacks);
  t.after(() => restored.stop());
  await restored.requestReview();
  await drain(restored);
  assert.equal(state.calls[0].input.track.rating, undefined);
  assert.equal(state.calls[0].input.track.calibration, undefined);
  assert.equal(state.calls[0].input.options.memory, undefined);
});
