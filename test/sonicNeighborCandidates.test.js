"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  candidateDedupeKey,
  catalogSludgeReason,
  generateSonicNeighborCandidates,
  generateSonicNeighborCandidatesAsync,
  genreMismatchReason
} = require("../src/sonicNeighborCandidates");

function neighbor(identityKey, artist, title, similarity, extra = {}) {
  return {
    identityKey,
    model: "discogs-effnet",
    modelVersion: "1",
    similarity,
    track: { identityKey, artist, title, ...extra }
  };
}

test("live sonic scoring lets I/O run between candidates and preserves the complete result", async () => {
  const neighbors = Array.from({ length: 12 }, (_, index) =>
    neighbor(`tidal:${index + 1}`, `Artist ${index}`, `Track ${index}`, 0.95 - index / 100, { genre: "Progressive House" }));
  const options = {
    neighborEngine: { findSonicNeighbors: () => ({ neighbors }) },
    input: { anchor: { identityKey: "tidal:anchor", genre: "Progressive House" }, count: 12 },
    selectionModel: { enabled: true, scoreNeighbor: ({ rawSimilarity }) => ({ selectionScore: rawSimilarity }) },
    logger: null
  };
  const expected = generateSonicNeighborCandidates(options);
  let scored = 0;
  let scoredWhenIoRan = null;
  const actual = await generateSonicNeighborCandidatesAsync({
    ...options,
    selectionModel: {
      ...options.selectionModel,
      scoreNeighbor(input) {
        scored++;
        if (scored === 1) setImmediate(() => { scoredWhenIoRan = scored; });
        return options.selectionModel.scoreNeighbor(input);
      }
    }
  });
  assert.deepEqual(actual, expected);
  assert.ok(scoredWhenIoRan > 0 && scoredWhenIoRan < neighbors.length, `I/O only ran after ${scoredWhenIoRan} candidates`);
  await assert.rejects(generateSonicNeighborCandidatesAsync({}), /neighbor engine is required/);
});

test("sonic neighbor candidate generation round-robins anchors and suppresses duplicates", () => {
  const calls = [];
  const engine = {
    findSonicNeighbors(input) {
      calls.push(input);
      return {
        neighbors: input.track === "text:anchor-a"
          ? [neighbor("tidal:1", "A", "One", 0.91), neighbor("tidal:2", "A", "Two", 0.82)]
          : [neighbor("tidal:3", "B", "Three", 0.90), neighbor("tidal:4", "B", "Four", 0.81)]
      };
    }
  };

  const result = generateSonicNeighborCandidates({
    neighborEngine: engine,
    input: {
      anchors: ["text:anchor-a", "text:anchor-b"],
      count: 4,
      model: "discogs-effnet",
      modelVersion: "1"
    },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["tidal:1", "tidal:3", "tidal:2", "tidal:4"]);
  assert.deepEqual(result.candidates.map((item) => item.sonicNeighbor.anchorIdentityKey), ["text:anchor-a", "text:anchor-b", "text:anchor-a", "text:anchor-b"]);
  assert.equal(result.diagnostics.acceptedCount, 4);
  assert.equal(result.diagnostics.duplicateCount, 0);
  assert.equal(result.diagnostics.mode, "shadow");
  assert.equal(result.diagnostics.secondStage.enabled, true);
  assert.equal(result.diagnostics.secondStage.firstStageSignal, "raw-cosine");
  assert.equal(result.diagnostics.secondStage.productionApplied, false);
  assert.equal(typeof result.candidates[0].sonicNeighbor.adjustedScore, "number");
  assert.equal(result.candidates[0].sonicNeighbor.secondStage.shadowOnly, true);
  assert.equal(result.candidates.every((item) => item.shadowOnly && item.queueable === false), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].analyzeIfMissing, false);
  assert.equal(calls[0].model, "discogs-effnet");
  assert.equal(calls[0].modelVersion, "1");
});

test("sonic neighbor candidate generation deduplicates overlapping anchor rows", () => {
  const result = generateSonicNeighborCandidates({
    neighborEngine: {
      findSonicNeighbors: ({ track }) => ({
        neighbors: track === "tidal:anchor-a"
          ? [neighbor("tidal:shared", "Shared", "Track", 0.95)]
          : [neighbor("tidal:shared", "Shared", "Track", 0.94), neighbor("tidal:unique", "Unique", "Track", 0.80)]
      })
    },
    input: { anchors: ["tidal:anchor-a", "tidal:anchor-b"], count: 5 },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["tidal:shared", "tidal:unique"]);
  assert.equal(result.diagnostics.duplicateCount, 1);
  assert.equal(result.diagnostics.acceptedCount, 2);
  assert.equal(result.diagnostics.rejectedCount, 0);
});

test("sonic neighbor candidate generation suppresses text and TIDAL aliases without changing the selected identity", () => {
  const result = generateSonicNeighborCandidates({
    neighborEngine: {
      findSonicNeighbors: () => ({
        neighbors: [
          neighbor("text:artist|track|", "Alias Artist", "Alias Track", 0.95),
          neighbor("tidal:123", "Alias Artist", "Alias Track", 0.94),
          neighbor("tidal:124", "Alias Artist", "Alias Track (Extended Mix)", 0.93)
        ]
      })
    },
    input: { anchor: "tidal:anchor", count: 5 },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["text:artist|track|", "tidal:124"]);
  assert.equal(result.diagnostics.duplicateCount, 1);
  assert.equal(candidateDedupeKey({ artist: "Alias Artist", title: "Alias Track" }), "track:alias artist|alias track|");
});

test("sonic neighbor candidate generation keeps the requested count honest and applies safe quality gates", () => {
  const result = generateSonicNeighborCandidates({
    neighborEngine: {
      findSonicNeighbors: () => ({
        neighbors: [
          neighbor("tidal:good", "Good Artist", "Good Track", 0.92, { genre: "Progressive House" }),
          neighbor("tidal:sludge", "Various Artists", "Top 100 House Music 2024", 0.99, { genre: "House" }),
          neighbor("tidal:drift", "Drift Artist", "Drift Track", 0.88, { genre: "Country" })
        ]
      })
    },
    input: { anchor: "tidal:anchor", count: 10, genre: "Progressive House" },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["tidal:good"]);
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.diagnostics.rejectedCount, 2);
  assert.equal(result.diagnostics.rejected.some((item) => item.reason === "catalog-playlist-sludge"), true);
  assert.equal(result.diagnostics.rejected.some((item) => item.reason === "genre-drift"), true);
  assert.equal(result.diagnostics.rejected.every((item) => "rawSimilarity" in item), true);
  assert.equal(catalogSludgeReason({ artist: "Various Artists", title: "Top 100 House Music 2024" }), "catalog-playlist-sludge");
  assert.equal(genreMismatchReason({ genre: "Rock" }, { genre: "House" }), "genre-drift");
});

test("sonic neighbor candidate generation ranks by adjusted score and excludes suspicious source rows", () => {
  const result = generateSonicNeighborCandidates({
    neighborEngine: {
      findSonicNeighbors: () => ({
        neighbors: [
          neighbor("file:bad", "Tiestio", "Title2", 0.99, {
            genre: "Techno",
            durationMs: 128 * 60 * 1000,
            sourcePath: "C:/temp/title2.mp3"
          }),
          neighbor("tidal:good", "Good Artist", "Good Track", 0.81, {
            genre: "Techno",
            durationMs: 360000
          })
        ]
      })
    },
    input: {
      anchor: { identityKey: "tidal:anchor", artist: "Anchor", title: "Anchor", genre: "Techno", durationMs: 360000 },
      count: 5
    },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["tidal:good"]);
  assert.equal(result.diagnostics.secondStage.rejectedCount, 1);
  assert.equal(result.diagnostics.rejected[0].reason, "suspicious-source-metadata");
  assert.equal(result.diagnostics.rejected[0].rawSimilarity, 0.99);
  assert.equal(result.diagnostics.rejected[0].adjustedScore < 0.99, true);
});

test("sonic neighbor candidate generation honors exclusions and row budget without padding", () => {
  let calls = 0;
  const result = generateSonicNeighborCandidates({
    neighborEngine: {
      findSonicNeighbors: () => {
        calls += 1;
        return {
          neighbors: [
            neighbor("tidal:one", "One", "Track", 0.90),
            neighbor("tidal:two", "Two", "Track", 0.89),
            neighbor("tidal:three", "Three", "Track", 0.88)
          ]
        };
      }
    },
    input: {
      anchors: ["tidal:anchor-a", "tidal:anchor-b"],
      excludeIdentityKeys: ["tidal:excluded"],
      count: 5,
      maxRows: 2
    },
    logger: null
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["tidal:one", "tidal:two"]);
  assert.equal(result.diagnostics.budgetCost.exhausted, true);
  assert.equal(result.diagnostics.returned, 2);
});

test("sonic neighbor candidate generation reports anchor failures without contaminating other anchors", () => {
  const result = generateSonicNeighborCandidates({
    neighborEngine: {
      findSonicNeighbors: ({ track }) => {
        if (track === "tidal:missing") throw new Error("No stored sonic embedding exists");
        return { neighbors: [neighbor("tidal:good", "Good", "Track", 0.8)] };
      }
    },
    input: { anchors: ["tidal:missing", "tidal:ready"], count: 2 },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), ["tidal:good"]);
  assert.equal(result.diagnostics.anchorDiagnostics[0].error, "No stored sonic embedding exists");
  assert.equal(result.diagnostics.anchorDiagnostics[1].acceptedCount, 1);
});

test("sonic neighbor candidate generation uses a bounded per-anchor selector pool and preserves rotation", () => {
  const calls = [];
  const selectionModel = {
    enabled: true,
    source: "test-feedback-facet",
    summary: { trainingRows: 6, supportedAreaCount: 1 },
    scoreNeighbor({ candidate, rawSimilarity }) {
      const bonus = candidate.identityKey.endsWith("preferred") ? 0.2 : 0;
      return {
        selectionScore: rawSimilarity + bonus,
        rawSimilarity,
        positiveSimilarity: bonus ? 0.9 : 0.5,
        negativeSimilarity: 0.1,
        netMargin: bonus,
        selectionMethod: "raw-cosine-plus-area-feedback-centroid",
        area: "house",
        evidence: { positiveCount: 3, negativeCount: 2, negativeUsable: true }
      };
    }
  };
  const engine = {
    findSonicNeighbors(input) {
      calls.push(input);
      return {
        query: { track: input.track, vector: [1, 0] },
        neighbors: input.track === "tidal:anchor-a"
          ? [
              { ...neighbor("tidal:a-ordinary", "A", "Ordinary", 0.95), vector: [0.9, 0.1] },
              { ...neighbor("tidal:a-preferred", "A", "Preferred", 0.90), vector: [0.9, 0.1] }
            ]
          : [
              { ...neighbor("tidal:b-ordinary", "B", "Ordinary", 0.94), vector: [0.9, 0.1] },
              { ...neighbor("tidal:b-preferred", "B", "Preferred", 0.89), vector: [0.9, 0.1] }
            ]
      };
    }
  };
  const result = generateSonicNeighborCandidates({
    neighborEngine: engine,
    selectionModel,
    input: { anchors: ["tidal:anchor-a", "tidal:anchor-b"], count: 4, perAnchorCount: 2 },
    logger: null
  });

  assert.deepEqual(result.candidates.map((item) => item.identityKey), [
    "tidal:a-preferred", "tidal:b-preferred", "tidal:a-ordinary", "tidal:b-ordinary"
  ]);
  assert.equal(result.diagnostics.selection.enabled, true);
  assert.equal(result.diagnostics.selection.poolFactor, 4);
  assert.equal(calls[0].count, 8);
  assert.equal(calls[0].includeVector, true);
  assert.equal(result.candidates[0].sonicNeighbor.selectionMethod, "raw-cosine-plus-area-feedback-centroid");
  assert.equal(result.candidates.every((item) => item.shadowOnly && item.queueable === false), true);
});
