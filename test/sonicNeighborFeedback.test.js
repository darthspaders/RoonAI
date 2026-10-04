"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const {
  normalizeSonicNeighborRating,
  readSonicNeighborFeedbackEmbeddings,
  readSonicReviewSessionReviews
} = require("../src/sonicNeighborFeedback");
const { createSonicReviewSessionService } = require("../src/sonicReviewSessionService");

function tempDbFile() {
  return path.join(os.tmpdir(), `rabbit-hole-sonic-neighbor-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function cleanDb(file) {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

test("sonic-neighbor review labels normalize without using the global feedback vocabulary", () => {
  assert.equal(normalizeSonicNeighborRating("K"), "like");
  assert.equal(normalizeSonicNeighborRating("skip"), "skip");
  assert.equal(normalizeSonicNeighborRating("wrong genre"), "wrong_genre");
  assert.equal(normalizeSonicNeighborRating("reject similar"), "reject_similar");
  assert.equal(normalizeSonicNeighborRating("unknown"), "");
});

test("persisted Sonic Review decisions are available as anchor-scoped calibration evidence", () => {
  const dbFile = tempDbFile();
  const memory = new MusicMemoryStore({ dbFile, logger: null });
  try {
    createSonicReviewSessionService({ db: memory.db, recommendationEngine: null, logger: null });
    memory.db.prepare(`
      INSERT INTO sonic_review_session
        (session_id, anchor_identity_key, anchor_json, requested_count, candidate_count,
         current_index, completed_count, skipped_count, queued_count, failed_count,
         status, review_policy, queue_policy, profile_policy, novelty_policy,
         model, model_version, diagnostics_json, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1, 1, 0, 0, 0, 'COMPLETED', 'ASSISTANT_DRAFT', 'ASK', 'SHADOW_ONLY', 'PREFER_FRESH', ?, ?, '{}', ?, ?)
    `).run(
      "sonic-review:test-session",
      "tidal:anchor",
      JSON.stringify({ artist: "Anchor", title: "Track", genre: "House" }),
      "discogs-effnet",
      "1",
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T00:00:01.000Z"
    );
    memory.db.prepare(`
      INSERT INTO sonic_review_session_item
        (session_id, item_index, candidate_identity_key, candidate_json, relation_json,
         status, decision, confidence, review_json, created_at, updated_at)
      VALUES (?, 0, ?, ?, '{}', 'REVIEWED', ?, ?, ?, ?, ?)
    `).run(
      "sonic-review:test-session",
      "tidal:candidate",
      JSON.stringify({ artist: "Candidate", title: "Track", genre: "House" }),
      "STRONG_KEEP",
      0.9,
      JSON.stringify({ note: "Useful groove" }),
      "2026-09-15T00:00:00.000Z",
      "2026-09-15T00:00:01.000Z"
    );
    const rows = readSonicReviewSessionReviews(memory.db, { model: "discogs-effnet", modelVersion: "1" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, "positive");
    assert.equal(rows[0].decision, "STRONG_KEEP");
    assert.equal(rows[0].confidence, 0.9);
    assert.equal(rows[0].anchorIdentityKey, "tidal:anchor");
  } finally {
    memory.close();
    cleanDb(dbFile);
  }
});

test("sonic-neighbor reviews persist separately and resume after restart", () => {
  const dbFile = tempDbFile();
  const memory = new MusicMemoryStore({ dbFile, logger: null });
  const engine = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  try {
    for (let index = 1; index <= 3; index += 1) {
      engine.store.upsertEmbedding({
        identityKey: `tidal:${1000 + index}`,
        track: { tidalId: `${1000 + index}`, artist: `Candidate ${index}`, title: "Track" },
        vector: [1, index / 10],
        model: "discogs-effnet",
        modelVersion: "1"
      });
    }

    const beforeGlobalFeedback = Number(memory.db.prepare("SELECT COUNT(*) AS count FROM taste_feedback").get().count || 0);
    const result = engine.recordSonicNeighborFeedback({
      feedback: [1, 2, 3].map((index) => ({
        anchor: { tidalId: "anchor-1", artist: "Anchor", title: "Anchor Track" },
        candidate: { tidalId: `${1000 + index}`, artist: `Candidate ${index}`, title: "Track" },
        rating: index === 3 ? "wrong_genre" : "K",
        candidateArea: "Progressive House",
        sourceEventId: `sonic-review:test:${index}`
      }))
    });
    assert.equal(result.inserted, 3);
    assert.equal(result.globalTasteProfileUpdated, false);
    assert.equal(Number(memory.db.prepare("SELECT COUNT(*) AS count FROM taste_feedback").get().count || 0), beforeGlobalFeedback);
    assert.equal(Number(memory.db.prepare("SELECT COUNT(*) AS count FROM sonic_neighbor_feedback").get().count || 0), 3);

    const rows = readSonicNeighborFeedbackEmbeddings(engine.store.db, { model: "discogs-effnet", modelVersion: "1" });
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((row) => row.label === "positive").length, 2);
    assert.equal(rows.filter((row) => row.label === "negative").length, 1);
    assert.equal(rows[0].genre, "Progressive House");
  } finally {
    engine.store.close();
    memory.close();
  }

  const resumed = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  try {
    assert.equal(Number(resumed.store.db.prepare("SELECT COUNT(*) AS count FROM sonic_neighbor_feedback").get().count || 0), 3);
    const rows = readSonicNeighborFeedbackEmbeddings(resumed.store.db, { model: "discogs-effnet", modelVersion: "1" });
    assert.equal(rows.length, 3);
  } finally {
    resumed.store.close();
    cleanDb(dbFile);
  }
});

test("recording sonic-neighbor feedback invalidates the selector cache and preserves area correction", () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  try {
    engine.store.upsertEmbedding({
      identityKey: "tidal:candidate",
      track: { tidalId: "candidate", artist: "Candidate", title: "Track" },
      vector: [1, 0],
      model: "discogs-effnet",
      modelVersion: "1"
    });
    assert.equal(engine.getSonicNeighborSelectionModel({ model: "discogs-effnet", modelVersion: "1" }), null);
    const result = engine.recordSonicNeighborFeedback({
      anchor: "tidal:anchor",
      candidate: { tidalId: "candidate", artist: "Candidate", title: "Track" },
      rating: "keep",
      candidateArea: "Progressive House",
      sourceEventId: "sonic-review:cache-invalidation"
    });
    assert.equal(result.inserted, 1);
    assert.equal(engine.sonicNeighborSelectionCache, null);
  } finally {
    engine.store.close();
    cleanDb(dbFile);
  }
});

test("sonic anchor profiles save, update, and resume without touching global taste", () => {
  const dbFile = tempDbFile();
  const engine = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  try {
    const first = engine.saveSonicAnchorProfile({
      anchor: { identityKey: "tidal:anchor-profile", artist: "Anchor", title: "Track" },
      genre: "Progressive House",
      subgenre: "Deep",
      energy: 8,
      mood: "Hypnotic",
      tags: "rolling, late-night, rolling",
      note: "Keep the groove patient.",
      sourceLabel: "test-sonic-review"
    });
    assert.equal(first.profile.identityKey, "tidal:anchor-profile");
    assert.deepEqual(first.profile.tags, ["rolling", "late-night"]);
    assert.equal(first.profile.energy, 8);
    assert.equal(first.globalTasteProfileUpdated, false);
    assert.equal(first.productionApplied, false);

    const updated = engine.saveSonicAnchorProfile({
      anchor: { identityKey: "tidal:anchor-profile", artist: "Anchor", title: "Track" },
      genre: "Progressive House",
      subgenre: "Melodic",
      energy: 7,
      mood: "Driving",
      tags: ["peak-time"],
      note: "Updated review note."
    });
    assert.equal(updated.profile.subgenre, "Melodic");
    assert.equal(updated.profile.energy, 7);
    assert.equal(updated.profile.note, "Updated review note.");
    assert.equal(Number(engine.store.db.prepare("SELECT COUNT(*) AS count FROM sonic_anchor_profile").get().count || 0), 1);
  } finally {
    engine.store.close();
  }

  const resumed = new RecommendationEngineV2({ enabled: true, dbFile, logger: null });
  try {
    const result = resumed.getSonicAnchorProfile({ anchor: "tidal:anchor-profile" });
    assert.equal(result.profile.subgenre, "Melodic");
    assert.equal(result.profile.mood, "Driving");
  } finally {
    resumed.store.close();
    cleanDb(dbFile);
  }
});
