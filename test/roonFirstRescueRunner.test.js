"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRoonFirstRescueRunner,
  roonFirstResultIsEnough,
  roonFirstSearchSettings
} = require("../src/roonFirstRescueRunner");

function immediateWithTimeout(promise) {
  return promise;
}

test("Roon-first enough threshold preserves existing 65 percent floor behavior", () => {
  assert.equal(roonFirstResultIsEnough({ tracks: Array.from({ length: 5 }) }, 8), false);
  assert.equal(roonFirstResultIsEnough({ tracks: Array.from({ length: 6 }) }, 8), true);
  assert.equal(roonFirstResultIsEnough({ tracks: Array.from({ length: 3 }) }, 3), true);
});

test("Roon-first search settings keep quick and deep budgets distinct", () => {
  const quick = roonFirstSearchSettings(8, false);
  const deep = roonFirstSearchSettings(8, true);

  assert.equal(quick.searchLimit, 70);
  assert.equal(quick.artistCrawlSeedLimit, 2);
  assert.equal(deep.searchLimit, 120);
  assert.equal(deep.artistCrawlSeedLimit, 4);
  assert.ok(deep.candidateLimit > quick.candidateLimit);
});

test("Roon-first rescue returns base result when no zone is supplied", async () => {
  const base = { tracks: [{ title: "Existing" }], verification: { strategy: "tidal" } };
  const runner = createRoonFirstRescueRunner({
    roon: { discoverQueueableTracks: async () => { throw new Error("must not call roon"); } },
    withTimeout: immediateWithTimeout,
    mergeTrackLists: (...lists) => lists.flat().filter(Boolean),
    parseRequestedCount: () => 8,
    releaseFilterRequiresVerification: () => false,
    decorateRoonFirstResult: async () => ({ tracks: [] }),
    decorateRoonFirstTimeoutFallback: () => ({ tracks: [] })
  });

  assert.equal(await runner.runRoonFirstRescue(base, {}, 8, {}, "reason"), base);
});

test("fresh Roon rescue deepens after an incomplete quick pass and keeps deeper result", async () => {
  const calls = [];
  const runner = createRoonFirstRescueRunner({
    roon: {
      discoverQueueableTracks: async (options, zoneId, settings) => {
        calls.push({ options, zoneId, settings });
        return {
          tracks: [{ title: options.deepRoonSearch ? "deep" : "quick" }],
          alternates: [],
          discarded: [],
          verification: { searches: options.deepRoonSearch ? 3 : 1 }
        };
      }
    },
    withTimeout: immediateWithTimeout,
    mergeTrackLists: (...lists) => lists.flat().filter(Boolean),
    parseRequestedCount: () => 10,
    releaseFilterRequiresVerification: () => false,
    decorateRoonFirstResult: async (roonResult, options) => ({
      ...roonResult,
      tracks: options.deepRoonSearch
        ? Array.from({ length: 7 }, (_, index) => ({ title: `deep-${index}` }))
        : Array.from({ length: 2 }, (_, index) => ({ title: `quick-${index}` })),
      discarded: [],
      verification: { freshRoonCandidates: options.deepRoonSearch ? 7 : 2 }
    }),
    decorateRoonFirstTimeoutFallback: () => ({ tracks: [] })
  });

  const result = await runner.runFreshRoonRescue({}, { zoneId: "zone" }, 10, {}, "reason");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].settings.searchLimit, 70);
  assert.equal(calls[1].options.deepRoonSearch, "true");
  assert.equal(calls[1].settings.searchLimit, 120);
  assert.equal(result.tracks.length, 7);
  assert.equal(result.verification.roonFirstRescue.quickKept, 2);
  assert.equal(result.verification.roonFirstRescue.deepAttempted, true);
});
