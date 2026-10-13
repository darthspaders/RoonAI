"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelReviewBacklog } = require("../src/modelReviewBacklog");
const { createRetrospectiveModelHealth, createRetrospectiveScorer } = require("../src/modelReviewBacklogApi");
const { scoreRetrospectiveCandidate } = require("../src/llmClient");
const { memory } = require("../src/synapseMemory");
const runtime = require("../src/localModelRuntime");
const { TasteProfile } = require("../src/tasteProfile");
const { captureRetrospectiveInput } = require("../src/retrospectiveReviewInput");
const { trackKey } = require("../src/sessionStore");

for (const legacy of [false, true]) test(`backlog, frozen inputs, health and real scorer integrate safely (${legacy ? "undated legacy" : "matching request"})`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-backlog-integration-"));
  const config = { llmProvider: "lmstudio", openAiCompatibleBaseUrl: "http://localhost:19982/v1", openAiCompatibleModel: "family" };
  const profile = new TasteProfile(path.join(directory, "taste.json"));
  const track = { artist: "Catalog Artist", title: "Version (Remix)", tidalUrl: "https://tidal.com/track/123", tidalId: "123", durationMs: 480000, score: 42 };
  const saved = profile.record(track, "love", { reviewInput: captureRetrospectiveInput(track, { request: "Progressive house", years: [2025], genres: ["House"] }) });
  if (legacy) {
    const old = profile.read();
    delete old.feedback[trackKey(track)].updatedAt;
    delete old.feedback[trackKey(track)].calibration.recordedAt;
    delete old.feedback[trackKey(track)].reviewInput;
    profile.write(old);
  }
  const before = fs.readFileSync(profile.filePath, "utf8");
  const beforeCalibration = profile.summary().calibration;
  const requests = [];
  t.mock.method(memory, "context", () => { throw new Error("Current taste memory leaked into catch-up."); });
  t.mock.method(runtime, "resolveLocalModel", () => { throw new Error("Catch-up tried to resolve/load a model."); });
  t.mock.method(global, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    const row = { track_id: "123", rejected: false, rejection_reason: "", rejection_basis: [],
      scores: { prompt_match: legacy ? 0 : 75, taste_match: 0, freshness: legacy ? 0 : 70,
        artist_label_match: 60, length_preference: 90, genre_confidence: 70 },
      final_score: 72, genre: "House", why: ["Supplied version is a named remix."] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ candidates: [row] }) } }] }));
  });
  const backlog = new ModelReviewBacklog({ filePath: path.join(directory, "backlog.json"),
    listFeedback: () => profile.read().feedback,
    modelHealth: createRetrospectiveModelHealth({ openAiCompatibleProviders: new Set(["lmstudio"]),
      llmHealth: async () => ({ provider: "lmstudio", reachable: true, loaded: true, runtimeState: "loaded", model: "qwen-loaded:1" }) }),
    scoreReview: createRetrospectiveScorer(config, scoreRetrospectiveCandidate) });
  t.after(() => {
    backlog.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await backlog.requestReview();
  await backlog._runPromise;
  const status = backlog.status();
  assert.equal(status.completedCount, 1);
  assert.equal(status.failedCount, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, "qwen-loaded:1");
  assert.equal(requests[0].url, "http://localhost:19982/v1/chat/completions");
  assert.doesNotMatch(requests[0].body.messages[1].content, /"rating"|"love"|"current_score"|"tasteScore"|"scoreBreakdown"/);
  const review = status.recentResults[0];
  assert.equal(review.rating, saved.feedback.rating);
  assert.equal(review.originalScore, 42);
  assert.equal(review.originalModelAction, "unreviewed");
  assert.equal(review.accuracyEligible, false);
  assert.equal(review.result.scores[0].scores.tasteMatch, null);
  assert.equal(review.contextQuality, legacy ? "metadata-only" : "original-request");
  if (legacy) {
    assert.equal(review.result.scores[0].scores.promptMatch, null);
    assert.equal(review.result.scores[0].scores.freshness, null);
  }
  assert.equal(review.result.prompt, undefined);
  assert.equal(fs.readFileSync(profile.filePath, "utf8"), before);
  assert.deepEqual(profile.summary().calibration, beforeCalibration);
  await backlog.requestReview();
  await backlog._runPromise;
  assert.equal(requests.length, 1);
});
