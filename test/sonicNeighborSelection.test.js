"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const {
  buildSonicNeighborSelectionModel,
  evaluateSonicNeighborSelection,
  rankingMetricsForQueries,
  selectionArea
} = require("../src/sonicNeighborSelection");

function tempDbFile() {
  return path.join(os.tmpdir(), `rabbit-hole-sonic-selection-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function cleanDb(file) {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

function row(identityKey, label, vector, genre = "House", identityId = Number(identityKey.replace(/\D/g, "")) || 1) {
  return { identityKey, identityId, label, vector, genre, subgenre: "", artist: label, title: identityKey };
}

test("selection model trains per-area positive and negative evidence without a global fallback", () => {
  const model = buildSonicNeighborSelectionModel([
    row("tidal:1", "positive", [1, 0]),
    row("tidal:2", "positive", [0.98, 0.2]),
    row("tidal:3", "positive", [0.95, 0.3]),
    row("tidal:4", "negative", [0, 1]),
    row("tidal:5", "negative", [0.2, 0.98])
  ], { minPositiveExamples: 3, minNegativeExamples: 2, tasteWeight: 0.2 });

  assert.equal(model.enabled, true);
  assert.equal(model.summary.globalCentroidUsed, false);
  assert.equal(model.summary.supportedAreaCount, 1);
  assert.equal(selectionArea({ metadata: { beatportGenre: "Deep House" } }), "deep house");
  const selected = model.scoreNeighbor({
    anchor: { genre: "House" },
    candidate: { genre: "House" },
    rawSimilarity: 0.75,
    candidateVector: [1, 0]
  });
  assert.equal(selected.selectionMethod, "raw-cosine-plus-area-feedback-centroid");
  assert.ok(selected.selectionScore > 0.75);
  const unsupported = model.scoreNeighbor({
    anchor: { genre: "Techno" },
    candidate: { genre: "Techno" },
    rawSimilarity: 0.75,
    candidateVector: [1, 0]
  });
  assert.equal(unsupported.selectionScore, 0.75);
  assert.equal(unsupported.selectionMethod, "raw-cosine-no-area-profile");
});

test("selection model never applies a house taste profile across a different candidate area", () => {
  const model = buildSonicNeighborSelectionModel([
    row("tidal:1", "positive", [1, 0]),
    row("tidal:2", "positive", [1, 0]),
    row("tidal:3", "positive", [0.99, 0.1]),
    row("tidal:4", "negative", [0, 1]),
    row("tidal:5", "negative", [0, 1])
  ]);
  const score = model.scoreNeighbor({
    anchor: { genre: "House" },
    candidate: { genre: "Techno" },
    rawSimilarity: 0.8,
    candidateVector: [1, 0]
  });
  assert.equal(score.selectionScore, 0.8);
  assert.equal(score.selectionMethod, "raw-cosine-no-area-profile");
  assert.equal(score.areaMatched, false);
});

test("unclassified feedback never becomes a global taste profile", () => {
  const model = buildSonicNeighborSelectionModel([
    row("tidal:1", "positive", [1, 0], ""),
    row("tidal:2", "positive", [1, 0], ""),
    row("tidal:3", "positive", [1, 0], ""),
    row("tidal:4", "negative", [0, 1], "")
  ]);
  assert.equal(model.summary.supportedAreaCount, 0);
  const score = model.scoreNeighbor({ rawSimilarity: 0.8, candidateVector: [1, 0] });
  assert.equal(score.selectionScore, 0.8);
  assert.equal(score.selectionMethod, "raw-cosine-no-area-profile");
});

test("anchor-specific sonic reviews boost a keep and demote a wrong-genre neighbor", () => {
  const model = buildSonicNeighborSelectionModel([], {
    neighborFeedbackRows: [
      { anchorIdentityKey: "tidal:anchor", candidateIdentityKey: "tidal:keep", label: "positive", rating: "like" },
      { anchorIdentityKey: "tidal:anchor", candidateIdentityKey: "tidal:bad", label: "negative", rating: "wrong_genre" }
    ]
  });
  const keep = model.scoreNeighbor({
    anchor: "tidal:anchor",
    candidate: "tidal:keep",
    rawSimilarity: 0.8,
    candidateVector: [1, 0]
  });
  const bad = model.scoreNeighbor({
    anchor: "tidal:anchor",
    candidate: "tidal:bad",
    rawSimilarity: 0.8,
    candidateVector: [1, 0]
  });
  assert.equal(keep.selectionScore, 0.85);
  assert.equal(bad.selectionScore, 0.55);
  assert.equal(keep.directReview.rating, "like");
  assert.equal(bad.directReview.rating, "wrong_genre");
});

test("held-out evaluator compares raw cosine with selector and only emits bounded previews", () => {
  const dbFile = tempDbFile();
  const memory = new MusicMemoryStore({ dbFile, logger: null });
  const sonic = new SonicEmbeddingStore({ dbFile, logger: null });
  try {
    for (let index = 1; index <= 12; index += 1) {
      const positive = index <= 8;
      const track = { tidalId: String(index), artist: positive ? "House Artist" : "Negative Artist", title: `Track ${index}` };
      memory.saveTasteFeedback(track, { rating: positive ? "good" : "never", sourceEventId: `selection-test:${index}` });
      memory.saveBeatportEnrichment(track, {
        id: `bp-${index}`,
        genre: "House",
        subGenre: "Deep House",
        artist: track.artist,
        title: track.title
      }, { confidence: 95 });
      memory.db.prepare("UPDATE track_identity SET artist = ?, title = ? WHERE tidal_id = ?").run(track.artist, track.title, String(index));
      sonic.upsertEmbedding({
        identityKey: `tidal:${index}`,
        track,
        model: "discogs-effnet",
        modelVersion: "1",
        vector: positive ? [1, 0.05 * index] : [0.05 * index, 1]
      });
    }
    const result = evaluateSonicNeighborSelection(memory.db, { splitModulo: 3, minPositiveExamples: 2, minNegativeExamples: 1, maxCandidatesPerQuery: 100 });
    assert.equal(result.selection.globalCentroidUsed, false);
    assert.ok(result.selection.train > 0);
    assert.ok(result.selection.positiveQueryCount > 0);
    assert.equal(result.queryPreviewCount, result.queryPreviews.length);
    assert.ok(result.queryPreviewCount <= 25);
    assert.ok(result.metrics.rawCosine.queryCount > 0);
    assert.ok(result.metrics.feedbackFacetSelector.queryCount > 0);
  } finally {
    memory.close();
    sonic.close();
    cleanDb(dbFile);
  }
});

test("query metrics are deterministic and do not pad beyond available candidates", () => {
  const queries = [{
    ranked: [
      { identityKey: "positive", label: "positive", rawSimilarity: 0.9, selectionScore: 0.7 },
      { identityKey: "negative", label: "negative", rawSimilarity: 0.8, selectionScore: 0.8 }
    ]
  }];
  const metrics = rankingMetricsForQueries(queries, "selectionScore");
  assert.equal(metrics.queryCount, 1);
  assert.equal(metrics.precisionAt5, 0.5);
  assert.equal(metrics.recallAt5, 1);
  assert.equal(metrics.mrr, 0.5);
});
