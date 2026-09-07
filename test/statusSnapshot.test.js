"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  appSnapshot,
  sessionSnapshot
} = require("../src/statusSnapshot");

test("session snapshot syncs stored result verification with requested count", () => {
  const result = { tracks: [{ title: "One" }], verification: {} };
  const snapshot = sessionSnapshot({
    sessionStore: {
      read: () => ({ options: { count: 7 }, result })
    },
    parseRequestedCount: (options) => Number(options.count || 0),
    syncFinalResultVerification: (input, requested) => ({
      ...input,
      verification: { ...(input.verification || {}), requested }
    })
  });

  assert.equal(snapshot.result.verification.requested, 7);
});

test("app snapshot assembles status from current service summaries", () => {
  const snapshot = appSnapshot({
    latestResultSource: "exact_verification",
    latestBridgeSyncAlert: { id: "bridge-1" },
    sessionStore: {
      read: () => ({ options: {}, result: null })
    },
    parseRequestedCount: () => 0,
    syncFinalResultVerification: (input) => input,
    tasteProfile: {
      read: () => ({ feedback: { "artist|title": { rating: "good" } } }),
      summary: () => ({ feedbackCount: 1 })
    },
    genreProfileStore: { summary: () => ({ count: 2 }) },
    trackMemory: { summary: () => ({ count: 3 }) },
    standbyFreshSummary: () => ({ count: 4 }),
    queryYieldTracker: { summary: () => ({ queries: 5 }) },
    lastfm: { status: () => ({ configured: true }) },
    tidal: { status: () => ({ configured: true }) },
    tidalProfileMixes: { status: () => ({ connected: true }) },
    radioMetadataResolver: { status: () => ({ enabled: true }) },
    metadataEnrichment: { status: () => ({ cached: 6 }) },
    llmSnapshot: () => ({ provider: "test" }),
    modelRouter: { status: () => ({ tools: { count: 7 } }) },
    now: () => new Date("2026-01-02T03:04:05.000Z")
  });

  assert.equal(snapshot.latestResultSource, "exact_verification");
  assert.deepEqual(snapshot.bridgeSyncAlert, { id: "bridge-1" });
  assert.equal(snapshot.updatedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(snapshot.taste, { feedbackCount: 1 });
  assert.deepEqual(snapshot.feedback, { "artist|title": { rating: "good" } });
  assert.deepEqual(snapshot.mcp, { endpoint: "/mcp", connected: true, toolCount: 7 });
});
