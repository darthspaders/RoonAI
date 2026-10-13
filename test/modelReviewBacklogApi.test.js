"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRetrospectiveModelHealth, createRetrospectiveScorer, handleModelReviewBacklog } = require("../src/modelReviewBacklogApi");

test("worker model identity is adapted to the exact scorer model string", async () => {
  const config = { llmProvider: "lmstudio" };
  const input = { track: { id: "123" }, contextQuality: "metadata-only" };
  const signal = new AbortController().signal;
  let received;
  const score = createRetrospectiveScorer(config, async (...args) => { received = args; return "review"; });
  assert.equal(await score({ input, model: { provider: "lmstudio", model: "loaded-qwen" }, signal }), "review");
  assert.deepEqual(received, [config, { input, model: "loaded-qwen", signal }]);
});

test("catch-up requires actual loaded runtime evidence and never loads a model", async () => {
  const providers = new Set(["lmstudio", "openai-compatible"]);
  for (const data of [
    { provider: "lmstudio", reachable: true, loaded: true, model: "qwen" },
    { provider: "lmstudio", reachable: true, loaded: false, runtimeState: "not-loaded", model: "qwen" },
    { provider: "lmstudio", reachable: false, loaded: true, runtimeState: "loaded", model: "qwen" },
    { provider: "openrouter", reachable: true, loaded: true, runtimeState: "loaded", model: "cloud" }
  ]) {
    const health = createRetrospectiveModelHealth({ llmHealth: async () => data, openAiCompatibleProviders: providers });
    assert.equal((await health()).retrospectiveReady, false);
  }
  const health = createRetrospectiveModelHealth({ llmHealth: async () => ({ provider: "lmstudio", reachable: true, loaded: true, runtimeState: "loaded", model: "qwen", baseUrl: "private", token: "secret" }), openAiCompatibleProviders: providers });
  assert.deepEqual(await health(), { retrospectiveReady: true, provider: "lmstudio", model: "qwen" });
});

test("status is passive; only explicit review/pause routes request their own worker", async () => {
  const calls = [];
  const status = { state: "paused", paused: true };
  const backlog = { status: () => { calls.push("status"); return status; }, requestReview: async () => { calls.push("review"); return status; }, pause: () => { calls.push("pause"); return status; } };
  const options = { backlog, readJson: async () => { calls.push("body"); return {}; }, sendJson: (res, code, body) => calls.push([code, body]) };
  const route = (method, pathname) => handleModelReviewBacklog({ method }, {}, { pathname }, options);
  assert.equal(await route("GET", "/api/model-review/backlog"), true);
  assert.deepEqual(calls, ["status", [200, status]]);
  calls.length = 0;
  await route("POST", "/api/model-review/backlog/review");
  assert.deepEqual(calls, ["body", "review", [200, status]]);
  calls.length = 0;
  await route("POST", "/api/model-review/backlog/pause");
  assert.deepEqual(calls, ["body", "pause", [200, status]]);
  calls.length = 0;
  assert.equal(await route("GET", "/api/recommendation-v2/coverage"), false);
  assert.deepEqual(calls, []);
  await route("GET", "/api/model-review/backlog/review");
  assert.equal(calls[0][0], 405);
});
