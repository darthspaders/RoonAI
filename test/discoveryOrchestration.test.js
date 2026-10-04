"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscoveryOrchestration } = require("../src/discoveryOrchestration");

function orchestration(overrides = {}) {
  const mergeTrackLists = (...lists) => {
    const seen = new Set();
    const out = [];
    for (const track of lists.flat().filter(Boolean)) {
      const key = track.id || `${track.artist}|${track.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(track);
    }
    return out;
  };

  return createDiscoveryOrchestration({
    artistKeysForCandidate: (track = {}) => [track.artist || ""].filter(Boolean),
    autoBroadenSearchPasses: () => [],
    buildDiscoveryProfile: () => ({}),
    defaultPerRunArtistCap: () => 1,
    discoverTracks: async () => ({ tracks: [], alternates: [], discarded: [], verification: {} }),
    discoveryHistory: {},
    mergeTrackLists,
    queryYieldTracker: {},
    selectDiscoveryLaneCandidates: (pool, requestedCount) => ({
      tracks: pool.slice(0, requestedCount),
      alternates: pool.slice(requestedCount),
      quota: {
        selected: { core: Math.min(pool.length, requestedCount) },
        available: { core: pool.length },
        targets: { core: requestedCount }
      }
    }),
    shouldContinueAutoBroadenAfterError: () => false,
    tasteProfile: { read: () => ({ calibration: { buckets: [] } }) },
    tidal: {},
    withTimeout: (promise) => promise,
    ...overrides
  });
}

test("mergeQueryYieldSummaries preserves current additive query-yield counters", () => {
  const result = orchestration().mergeQueryYieldSummaries({
    enabled: true,
    attempted: 2,
    returned: 3,
    accepted: 1,
    recordCount: 1,
    best: ["a"]
  }, {
    attempted: 4,
    returned: 5,
    rejected: 2,
    errorCount: 1,
    recordCount: 2,
    best: ["b"],
    error: "x"
  });

  assert.equal(result.enabled, true);
  assert.equal(result.attempted, 6);
  assert.equal(result.returned, 8);
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 2);
  assert.equal(result.errorCount, 1);
  assert.equal(result.recordCount, 3);
  assert.deepEqual(result.best, ["a", "b"]);
  assert.equal(result.error, "x");
});

test("annotateAutoBroadenTracks preserves source, lane, and status checks", () => {
  const result = orchestration().annotateAutoBroadenTracks([
    { title: "One", statusChecks: ["Existing"] },
    { title: "Two", discoverySource: "Custom", discoveryLane: "custom" }
  ], { label: "Yield retry", lane: "yield-retry" });

  assert.equal(result[0].autoBroadened, true);
  assert.equal(result[0].discoverySource, "Yield retry");
  assert.equal(result[0].discoveryLane, "yield-retry");
  assert.deepEqual(result[0].statusChecks, ["Existing", "Yield retry"]);
  assert.equal(result[1].discoverySource, "Custom");
  assert.equal(result[1].discoveryLane, "custom");
});

test("runAutoBroadenSearches executes passes and merges diagnostics", async () => {
  const calls = [];
  const o = orchestration({
    autoBroadenSearchPasses: () => [{
      lane: "yield-retry",
      label: "Yield retry",
      reason: "thin pool",
      targetPool: 3,
      options: { request: "broaden" },
      queryYieldHealth: { retryNeeded: true }
    }],
    discoverTracks: async ({ options }) => {
      calls.push(options);
      return {
        tracks: [{ id: "new", artist: "B", title: "Two" }],
        alternates: [{ id: "alt", artist: "C", title: "Three" }],
        discarded: [{ id: "bad" }],
        verification: {
          generated: 3,
          queryYield: { recordCount: 1, attempted: 1, returned: 3 },
          poolDiagnostics: {
            candidateAccumulation: {
              rawCandidates: 3,
              uniqueCandidatesBeforeSelection: 1,
              validDurationCandidatesBeforeSelection: 1,
              durationCandidates: [{ key: "new", artist: "B", title: "Two" }]
            },
            acceptedQueryFamilies: [{ query: "branch", lane: "yield-retry", source: "retry", accepted: 1 }],
            searchStops: [{ query: "branch", reason: "page-available" }],
            deepCatalog: { enabled: true, triggered: true, attempted: 1, returned: 2, accepted: 1 }
          }
        }
      };
    }
  });

  const result = await o.runAutoBroadenSearches({
    tracks: [{ id: "old", artist: "A", title: "One" }],
    alternates: [],
    discarded: [],
    verification: { queryYield: { recordCount: 1, attempted: 1, returned: 1 } }
  }, {}, {}, 3, null, { discoveryTimeoutMs: 30000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].discoveryRuntimeMs, 13000);
  assert.deepEqual(result.tracks.map((track) => track.id), ["old", "new"]);
  assert.equal(result.alternates[0].autoBroadened, true);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.verification.queryYield.attempted, 2);
  assert.equal(result.verification.autoBroaden.attempted, 1);
  assert.equal(result.verification.autoBroaden.added, 2);
  assert.equal(result.verification.autoBroaden.yieldAware, true);
  assert.equal(result.verification.poolDiagnostics.candidateAccumulation.rawCandidates, 3);
  assert.equal(result.verification.poolDiagnostics.candidateAccumulation.uniqueCandidatesBeforeSelection, 3);
  assert.equal(result.verification.poolDiagnostics.candidateAccumulation.validDurationCandidatesBeforeSelection, 1);
  assert.equal(result.verification.poolDiagnostics.candidateAccumulation.durationCandidates.length, 1);
  assert.equal(result.verification.poolDiagnostics.deepCatalog.attempted, 1);
  assert.equal(result.verification.poolDiagnostics.searchStops.length, 1);
  assert.equal(result.verification.poolDiagnostics.acceptedQueryFamilies.length, 1);
});

test("hard-duration genre searches stop generic broadening once the requested pool is filled", async () => {
  let calls = 0;
  const o = orchestration({
    hardDurationConstraintFor: () => ({ minimumMs: 420000 }),
    autoBroadenSearchPasses: () => [
      { lane: "yield-retry", label: "Yield retry", targetPool: 110, options: {} },
      { lane: "branch-out", label: "Branch out", targetPool: 110, options: {} }
    ],
    discoverTracks: async () => {
      calls += 1;
      return { tracks: [], alternates: [], discarded: [], verification: {} };
    }
  });

  const result = await o.runAutoBroadenSearches({
    tracks: Array.from({ length: 10 }, (_, index) => ({ id: String(index), artist: `Artist ${index}`, title: `Track ${index}` })),
    alternates: [],
    discarded: [],
    verification: {}
  }, {}, { targetGenres: ["progressive trance"] }, 10, null, { discoveryTimeoutMs: 45000 });

  assert.equal(calls, 0);
  assert.equal(result.verification.autoBroaden.durationConstrainedGenreSearch, true);
  assert.equal(result.verification.autoBroaden.targetPool, 20);
});

test("rebalanceDiscoveryResult updates lane quota diagnostics from selected pool", () => {
  const result = orchestration().rebalanceDiscoveryResult({
    tracks: [
      { id: "1", artist: "A", title: "One" },
      { id: "2", artist: "B", title: "Two" }
    ],
    alternates: [{ id: "3", artist: "C", title: "Three" }],
    verification: { poolDiagnostics: { notes: ["existing"] } }
  }, {}, {}, 2);

  assert.deepEqual(result.tracks.map((track) => track.id), ["1", "2"]);
  assert.deepEqual(result.alternates.map((track) => track.id), ["3"]);
  assert.equal(result.verification.perRunArtistCap, 1);
  assert.equal(result.verification.poolDiagnostics.artistSpread.selectedArtists, 2);
  assert.equal(result.verification.poolDiagnostics.artistSpread.retainedArtists, 3);
  assert.ok(result.verification.poolDiagnostics.notes.some((note) => /Final pool rebalanced/.test(note)));
});

test("rebalanceDiscoveryResult runs the guarded v2 reranker before lane selection", () => {
  const calls = [];
  const o = orchestration({
    recommendationV2Reranker: (pool, context) => {
      calls.push({ pool, context });
      return {
        candidates: pool.map(track => ({ ...track, score: Number(track.score || 0) + 10 })),
        diagnostics: {
          enabled: true,
          mode: "shadow",
          applied: false,
          candidateCount: pool.length,
          scoredCount: 1,
          coverage: 0.5,
          model: "discogs-effnet",
          modelVersion: "1"
        }
      };
    },
    selectDiscoveryLaneCandidates: (pool, requestedCount) => ({
      tracks: pool.slice().sort((left, right) => right.score - left.score).slice(0, requestedCount),
      alternates: [],
      quota: { selected: {}, available: {}, targets: {} }
    })
  });
  const result = o.rebalanceDiscoveryResult({
    tracks: [{ id: "1", artist: "A", title: "One", score: 10 }],
    alternates: [{ id: "2", artist: "B", title: "Two", score: 30 }],
    verification: { poolDiagnostics: { notes: [] } }
  }, { genres: "Dubstep" }, { targetGenres: ["dubstep"] }, 1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.requestedCount, 1);
  assert.equal(result.tracks[0].id, "2");
  assert.equal(result.verification.recommendationV2.model, "discogs-effnet");
  assert.ok(result.verification.poolDiagnostics.notes.some(note => /Recommendation Engine v2 shadow/.test(note)));
});
