"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  autoBroadenSearchPasses,
  buildDiscoveryProfile,
  shouldContinueAutoBroadenAfterError
} = require("../src/discoveryEngine");

function fakeTracks(count) {
  return Array.from({ length: count }, (_, index) => ({
    artist: `Artist ${index}`,
    title: `Track ${index}`,
    tidal: { tidalUrl: `https://tidal.com/browse/track/${index}` }
  }));
}

test("auto broaden does not run when the candidate pool is already healthy", () => {
  const options = {
    request: "Find 30 new psytrance tracks",
    genres: "psytrance",
    count: "30",
    years: "2025-2026",
    requireRoonQueueable: "true"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, {
    tracks: fakeTracks(80),
    alternates: fakeTracks(80).map((track, index) => ({
      ...track,
      tidal: { tidalUrl: `https://tidal.com/browse/track/alt-${index}` }
    }))
  }, 30);

  assert.deepEqual(passes, []);
});

test("auto broaden preserves progressive psytrance as psytrance, not progressive house", () => {
  const options = {
    request: "Find 30 new progressive psytrance tracks from 2026",
    genres: "progressive psytrance",
    count: "30",
    years: "2026",
    requireRoonQueueable: "true"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, { tracks: [], alternates: [] }, 30);
  const serialized = JSON.stringify(passes).toLowerCase();

  assert.ok(passes.length >= 1);
  assert.ok(profile.targetGenres.some((term) => /progressive psytrance/i.test(term)));
  assert.ok(serialized.includes("progressive psytrance"));
  assert.equal(serialized.includes("progressive house"), false);
});

test("auto broaden does not invent 70s disco funk vibes for psychedelic trance", () => {
  const options = {
    request: "Find 20 psychedelic trance tracks from 2026",
    genres: "psychedelic trance",
    count: "20",
    years: "2026",
    requireRoonQueueable: "true"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, { tracks: [], alternates: [] }, 20);
  const serialized = JSON.stringify({ profile, passes }).toLowerCase();

  assert.ok(passes.length >= 1);
  assert.equal(profile.vibeSource, "not specified");
  assert.equal(/\bdisco\b/.test(serialized), false);
  assert.equal(/\bfunk\b/.test(serialized), false);
  assert.equal(passes.some((pass) => pass.lane === "relaxed-vibe"), false);
});

test("auto broaden carries explicit psytrance vibes separately from genre", () => {
  const options = {
    request: "Find 30 underground driving psytrance tracks from 2026",
    genres: "psytrance",
    mood: "underground, driving",
    count: "30",
    years: "2026",
    requireRoonQueueable: "true"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, { tracks: [], alternates: [] }, 30);
  const corePass = passes.find((pass) => pass.lane === "core-expanded");

  assert.equal(profile.vibeSource, "explicit");
  assert.deepEqual(profile.vibeTerms.slice(0, 2), ["underground", "driving"]);
  assert.ok(corePass);
  assert.ok(corePass.options.llmSearchPlan.vibeTerms.includes("underground"));
  assert.ok(corePass.options.llmSearchPlan.vibeTerms.includes("driving"));
});

test("auto broaden adds a yield-aware retry when query yield is weak", () => {
  const options = {
    request: "Find 30 underground driving psytrance tracks from 2026",
    genres: "psytrance",
    mood: "underground, driving",
    count: "30",
    years: "2026",
    requireRoonQueueable: "true"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, {
    tracks: fakeTracks(2),
    alternates: [],
    verification: {
      queryYield: {
        attempted: 8,
        returned: 42,
        accepted: 1,
        rejected: 40,
        seoRejects: 16,
        genreRejects: 12,
        errorCount: 0,
        recordCount: 8
      }
    }
  }, 30);
  const retry = passes[0];
  const serialized = JSON.stringify(retry).toLowerCase();

  assert.equal(retry.lane, "yield-retry");
  assert.equal(retry.queryYieldHealth.retryNeeded, true);
  assert.match(retry.reason, /query yield was weak/i);
  assert.ok(serialized.includes("psytrance"));
  assert.equal(serialized.includes("progressive house"), false);
});

test("auto broaden includes a scene branch-out retry before relaxing the request", () => {
  const options = {
    request: "Find 10 underground progressive house discoveries from 2026",
    genres: "progressive house",
    mood: "underground",
    count: "10",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, { tracks: fakeTracks(1), alternates: [] }, 10);
  const branch = passes.find((pass) => pass.lane === "branch-out");

  assert.ok(branch);
  assert.match(branch.stage, /branch-out/i);
  assert.match(branch.reason, /artists and labels/i);
  assert.equal(branch.options.adaptiveRetryStage, "scene-branch-out");
  assert.ok((branch.options.llmSearchPlan.searchQueries || []).length > 0);
});

test("auto broaden treats discovery timeout as weak yield", () => {
  const options = {
    request: "Find 10 psytrance tracks from 2026",
    genres: "psytrance",
    count: "10",
    years: "2026",
    requireRoonQueueable: "true"
  };
  const profile = buildDiscoveryProfile(options);
  const passes = autoBroadenSearchPasses(options, profile, {
    tracks: [],
    alternates: [],
    verification: {
      discoveryError: "TIDAL discovery took too long.",
      queryYield: {
        enabled: true,
        attempted: 0,
        accepted: 0,
        errorCount: 1
      }
    }
  }, 10);

  assert.equal(passes[0].lane, "yield-retry");
  assert.equal(passes[0].queryYieldHealth.retryNeeded, true);
  assert.match(passes[0].queryYieldHealth.summary, /took too long/i);
});

test("auto broaden continues after a retry timeout when the pool still undershot", () => {
  assert.equal(shouldContinueAutoBroadenAfterError(
    new Error("Yield-aware retry took too long."),
    {
      initialTimedOut: false,
      remainingPasses: 2,
      currentPool: 2,
      requestedCount: 8
    }
  ), true);
});

test("auto broaden stops timeout retry chaining once the requested count is met", () => {
  assert.equal(shouldContinueAutoBroadenAfterError(
    new Error("Yield-aware retry took too long."),
    {
      initialTimedOut: false,
      remainingPasses: 2,
      currentPool: 8,
      requestedCount: 8
    }
  ), false);
});
