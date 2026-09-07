"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscoveryRequestPolicy } = require("../src/discoveryRequestPolicy");
const { normalizeMatchText } = require("../src/tidalMatchRules");
const yearRangeUtil = require("../src/yearRange");

function policy(overrides = {}) {
  return createDiscoveryRequestPolicy({
    buildDiscoveryProfile: (options = {}) => ({
      targetGenres: options.genreProfile ? [options.genreProfile] : []
    }),
    config: {
      llmProvider: "openai",
      openAiCompatibleBaseUrl: "",
      llmPlanningTimeoutMs: 0,
      ...(overrides.config || {})
    },
    minimumScoreFor: (options = {}) => Number(options.minimumScore || 0),
    normalizeMatchText,
    openAiCompatibleProviders: new Set(["openai-compatible", "openai_compatible", "lmstudio", "llamacpp"]),
    yearRangeUtil
  });
}

test("normal search budgets preserve short discovery and queue timeouts", () => {
  assert.deepEqual(policy().strictSearchBudgets({}, 8), {
    roonFirstTimeoutMs: 10000,
    modelTimeoutMs: 30000,
    discoveryTimeoutMs: 12000,
    roonQueueTimeoutMs: 10000
  });
});

test("configured planning timeout is clamped and overrides default budgets", () => {
  assert.equal(policy({ config: { llmPlanningTimeoutMs: 2000 } }).modelPlanningTimeoutBudget(30000), 8000);
  assert.equal(policy({ config: { llmPlanningTimeoutMs: 200000 } }).modelPlanningTimeoutBudget(30000), 180000);
});

test("local OpenAI-compatible providers preserve longer planning timeout floor", () => {
  const localPolicy = policy({
    config: {
      llmProvider: "lmstudio",
      openAiCompatibleBaseUrl: "http://127.0.0.1:1234"
    }
  });

  assert.equal(localPolicy.isLocalOpenAiCompatibleLlm(), true);
  assert.equal(localPolicy.modelPlanningTimeoutBudget(30000), 60000);
});

test("year filters are normalized and genre catalog searches skip model planning", () => {
  const p = policy();

  assert.deepEqual(p.withNormalizedYearFilter({ years: "2018 to 2020", request: "progressive house" }), {
    years: "2018-2020",
    request: "progressive house",
  });
  assert.equal(p.shouldSkipModelForCatalogSearch({ years: "2019", request: "progressive house" }), true);
  assert.equal(p.shouldSkipModelForCatalogSearch({ request: "progressive house" }), false);
});

test("strict Roon mode and strict catalog budgets preserve existing thresholds", () => {
  const p = policy();

  assert.equal(p.isStrictRoonQueueMode({ queueMode: "strict roon" }), true);
  assert.equal(p.isStrictRoonQueueMode({ strictRoonQueueable: "yes" }), true);

  assert.deepEqual(p.strictSearchBudgets({
    years: "2019",
    request: "progressive house",
    queueMode: "strict roon"
  }, 12), {
    roonFirstTimeoutMs: 19200,
    modelTimeoutMs: 30000,
    discoveryTimeoutMs: 108000,
    roonQueueTimeoutMs: 28800
  });
});

test("booleanFlag keeps narrow truthy aliases", () => {
  const p = policy();

  assert.equal(p.booleanFlag("true"), true);
  assert.equal(p.booleanFlag("yes"), true);
  assert.equal(p.booleanFlag("on"), false);
  assert.equal(p.booleanFlag("false"), false);
});
