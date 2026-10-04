"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SonicEmbeddingStore,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  normalizeVector
} = require("../src/sonicEmbeddingStore");

function tempDbFile() {
  return path.join(os.tmpdir(), `rabbit-hole-sonic-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function cleanDb(file) {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

test("sonic vectors round-trip as normalized persistent data", () => {
  const dbFile = tempDbFile();
  const store = new SonicEmbeddingStore({ dbFile, logger: null, clock: () => 1_788_810_000_000 });
  const saved = store.upsertEmbedding({
    track: { artist: "Seed Artist", title: "Seed Track" },
    vector: [3, 4],
    model: "test-model",
    modelVersion: "1"
  });

  assert.deepEqual(saved.vector.map((value) => Number(value.toFixed(6))), [0.6, 0.8]);
  assert.equal(saved.dimensions, 2);
  assert.deepEqual(decodeVector(encodeVector(normalizeVector([3, 4]))).map((value) => Number(value.toFixed(6))), [0.6, 0.8]);
  assert.equal(store.status().embeddingCount, 1);
  store.close();

  const reopened = new SonicEmbeddingStore({ dbFile, logger: null });
  assert.equal(reopened.getEmbedding({ artist: "Seed Artist", title: "Seed Track" }).model, "test-model");
  reopened.close();
  cleanDb(dbFile);
});

test("nearest neighbors use cosine similarity and exclude the query track", () => {
  const dbFile = tempDbFile();
  const store = new SonicEmbeddingStore({ dbFile, logger: null });
  const model = { model: "test-model", modelVersion: "1" };
  store.upsertEmbedding({ ...model, track: { artist: "Seed Artist", title: "Seed Track" }, vector: [1, 0] });
  store.upsertEmbedding({ ...model, track: { artist: "Close Artist", title: "Close Track" }, vector: [0.98, 0.2] });
  store.upsertEmbedding({ ...model, track: { artist: "Far Artist", title: "Far Track" }, vector: [0, 1] });

  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  const neighbors = store.findNearest({ track: { artist: "Seed Artist", title: "Seed Track" }, ...model, count: 2 });
  assert.deepEqual(neighbors.map((item) => item.track.title), ["Close Track", "Far Track"]);
  assert.ok(neighbors[0].similarity > 0.9);
  assert.equal(neighbors.length, 2);
  store.close();
  cleanDb(dbFile);
});

test("sonic store backfills tidal_id for existing tidal-keyed profiles", () => {
  const dbFile = tempDbFile();
  const first = new SonicEmbeddingStore({ dbFile, logger: null });
  first.upsertEmbedding({
    identityKey: "tidal:777888999",
    track: { artist: "URL Artist", title: "URL Track" },
    vector: [1, 0],
    model: "test-model",
    modelVersion: "1"
  });
  first.close();

  const reopened = new SonicEmbeddingStore({ dbFile, logger: null });
  const row = reopened.db.prepare("SELECT tidal_id FROM track_sonic_profile WHERE identity_key = ?").get("tidal:777888999");
  assert.equal(row.tidal_id, "777888999");
  reopened.close();
  cleanDb(dbFile);
});
