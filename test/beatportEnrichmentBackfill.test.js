"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { jitterMs, runBeatportEnrichmentBackfill } = require("../scripts/beatport-enrichment-backfill");

test("Beatport enrichment backfill jitter stays near the configured delay", () => {
  for (let index = 0; index < 20; index += 1) {
    const value = jitterMs(2000, 0.2);
    assert.ok(value >= 1600);
    assert.ok(value <= 2400);
  }
});

test("Beatport enrichment backfill dry-run does not call Beatport", async () => {
  let called = false;
  const result = await runBeatportEnrichmentBackfill({
    dryRun: true,
    logger: { log: () => {} },
    store: {
      tracksMissingBeatportEnrichment: () => [{ artist: "Ezequiel Arias", title: "Solar" }]
    },
    beatport: {
      status: () => ({ diagnostics: {} }),
      findTrack: async () => {
        called = true;
      }
    }
  });

  assert.equal(result.scanned, 1);
  assert.equal(called, false);
});

test("Beatport enrichment backfill checks local DB before querying Beatport", async () => {
  let called = false;
  const saved = [];
  const result = await runBeatportEnrichmentBackfill({
    logger: { log: () => {} },
    store: {
      tracksMissingBeatportEnrichment: () => [{ artist: "Ezequiel Arias", title: "Solar" }],
      findBeatportEnrichment: () => null,
      saveBeatportEnrichment: (...args) => saved.push(["beatport", ...args]),
      saveProviderEnrichment: (...args) => saved.push(["provider", ...args]),
      saveEnrichmentAttempt: (...args) => saved.push(["attempt", ...args])
    },
    beatport: {
      status: () => ({ diagnostics: { requestCount: 1 } }),
      findTrack: async () => {
        called = true;
        return { id: "23107095", artist: "Ezequiel Arias", title: "Solar", genre: "Melodic House & Techno" };
      }
    },
    delayMs: 1,
    jitter: 0,
    limit: 1
  });

  assert.equal(called, true);
  assert.equal(result.enriched, 1);
  assert.equal(saved.length, 3);
});

test("Beatport enrichment backfill records missing tracks with retry window", async () => {
  const saved = [];
  const result = await runBeatportEnrichmentBackfill({
    logger: { log: () => {} },
    store: {
      tracksMissingBeatportEnrichment: () => [{ artist: "Not Beatport", title: "Kitchen Sink Ballad" }],
      findBeatportEnrichment: () => null,
      beatportLookupBlocked: () => false,
      saveEnrichmentAttempt: (...args) => saved.push(args)
    },
    beatport: {
      status: () => ({ diagnostics: {} }),
      findTrack: async () => null
    },
    missingRetryMs: 60_000,
    delayMs: 1,
    jitter: 0,
    limit: 1
  });

  assert.equal(result.missing, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].status, "missing");
  assert.ok(Date.parse(saved[0][2].nextRetryAt) > Date.parse(saved[0][2].fetchedAt));
});

test("Beatport enrichment backfill records exhausted 429 separately from missing", async () => {
  const saved = [];
  const error = Object.assign(new Error("Beatport metadata lookup returned HTTP 429"), {
    status: 429,
    retryAfterMs: 120_000
  });
  const result = await runBeatportEnrichmentBackfill({
    logger: { log: () => {} },
    store: {
      tracksMissingBeatportEnrichment: () => [{ artist: "Rate Limited", title: "Later" }],
      findBeatportEnrichment: () => null,
      beatportLookupBlocked: () => false,
      saveEnrichmentAttempt: (...args) => saved.push(args)
    },
    beatport: {
      status: () => ({ diagnostics: { status429Count: 1 } }),
      findTrack: async () => {
        throw error;
      }
    },
    missingRetryMs: 60_000,
    delayMs: 1,
    jitter: 0,
    limit: 1
  });

  assert.equal(result.failed, 1);
  assert.equal(saved[0][2].status, "rate_limited");
  assert.ok(Date.parse(saved[0][2].nextRetryAt) > Date.parse(saved[0][2].fetchedAt));
});
