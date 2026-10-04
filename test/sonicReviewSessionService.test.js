"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createSonicReviewSessionService } = require("../src/sonicReviewSessionService");

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE track_identity (
      id INTEGER PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      tidal_id TEXT,
      roon_identity TEXT,
      isrc TEXT,
      artist TEXT,
      title TEXT,
      mix_version TEXT,
      album TEXT,
      duration_ms INTEGER,
      observation_count INTEGER DEFAULT 0,
      provider_ids TEXT,
      normalized_artist TEXT,
      normalized_title TEXT,
      normalized_mix_version TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE beatport_enrichment (
      track_identity_id INTEGER PRIMARY KEY,
      beatport_track_id TEXT,
      genre TEXT,
      subgenre TEXT,
      bpm REAL,
      key_name TEXT,
      camelot TEXT,
      label TEXT,
      release_date TEXT,
      duration_ms INTEGER,
      isrc TEXT,
      beatport_url TEXT,
      raw_json TEXT
    );
    CREATE TABLE taste_feedback (
      id INTEGER PRIMARY KEY,
      track_identity_id INTEGER,
      rating TEXT
    );
    CREATE TABLE track_observation (
      id INTEGER PRIMARY KEY,
      track_identity_id INTEGER,
      source TEXT
    );
    CREATE TABLE sonic_neighbor_feedback (
      id INTEGER PRIMARY KEY,
      anchor_identity_key TEXT,
      candidate_identity_key TEXT,
      rating TEXT,
      note TEXT,
      source_label TEXT,
      model TEXT,
      model_version TEXT,
      created_at TEXT
    );
  `);
  return db;
}

function addMemoryTrack(db, id, identityKey, artist, title, options = {}) {
  db.prepare(`
    INSERT INTO track_identity
      (id, identity_key, tidal_id, artist, title, album, duration_ms, observation_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, identityKey, identityKey.startsWith("tidal:") ? identityKey.slice(6) : "", artist, title, options.album || "", options.durationMs || 300000, 1);
  if (options.genre) {
    db.prepare(`
      INSERT INTO beatport_enrichment
        (track_identity_id, beatport_track_id, genre, subgenre, bpm, key_name, camelot, label, release_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, options.beatportId || "bp-1", options.genre, options.subgenre || "", options.bpm || 122, options.key || "F minor", options.camelot || "4A", options.label || "Test Label", options.releaseDate || "2025-01-01");
  }
}

function candidate(identityKey, artist, title, similarity, extra = {}) {
  return {
    identityKey,
    artist,
    title,
    tidalId: identityKey.startsWith("tidal:") ? identityKey.slice(6) : "",
    ...extra,
    sonicNeighbor: {
      anchorIdentityKey: "tidal:anchor",
      rank: extra.rank || 1,
      similarity,
      model: "discogs-effnet",
      modelVersion: "1",
      selectionScore: similarity + 0.01,
      positiveSimilarity: 0.8,
      negativeSimilarity: 0.1,
      netMargin: 0.7,
      selectionMethod: "test"
    }
  };
}

function createService(db, overrides = {}, serviceOverrides = {}) {
  const engine = {
    generateSonicNeighborCandidates() {
      return {
        candidates: [
          candidate("tidal:reviewed", "Reviewed", "Already Heard", 0.99),
          candidate("tidal:fresh-a", "Fresh A", "One", 0.94, { genre: "Progressive House", subgenre: "Dark Progressive" }),
          candidate("tidal:fresh-b", "Fresh B", "Two", 0.91, { genre: "Progressive House" }),
          candidate("tidal:fresh-b", "Fresh B", "Two", 0.90, { genre: "Progressive House" })
        ],
        diagnostics: {
          source: "sonic-neighbor",
          returned: 4,
          duplicateCount: 1,
          budgetCost: { anchorLookups: 1, requestedNeighborRows: 12, returnedNeighborRows: 4 }
        }
      };
    },
    findStoredSonicProfile(track) {
      return {
        identityKey: track.identityKey,
        model: "discogs-effnet",
        modelVersion: "1",
        dimensions: 1280,
        sourceSha256: "test-sha",
        updatedAt: "2026-09-15T00:00:00.000Z",
        vector: Array(1280).fill(0.5)
      };
    },
    getSonicAnchorProfile() {
      return { profile: null };
    },
    saveSonicAnchorProfile(input) {
      return { profile: { identityKey: input.anchor.identityKey, genre: input.genre, subgenre: input.subgenre } };
    },
    findSonicNeighbors(track) {
      return { neighbors: [{ identityKey: `${track.identityKey}:nearby`, track: { artist: "Nearby", title: "Evidence" }, similarity: 0.7 }] };
    }
  };
  return createSonicReviewSessionService({
    db,
    recommendationEngine: { ...engine, ...overrides },
    ...serviceOverrides,
    clock: () => Date.parse("2026-09-15T12:00:00.000Z"),
    logger: null
  });
}

test("starts a persisted read-only session, suppresses reviewed/duplicate rows, and returns the first item", async () => {
  const db = createDb();
  addMemoryTrack(db, 1, "tidal:anchor", "Anchor Artist", "Anchor Track", { genre: "Progressive House" });
  addMemoryTrack(db, 2, "tidal:fresh-a", "Fresh A", "One", { genre: "Progressive House", subgenre: "Dark Progressive" });
  addMemoryTrack(db, 3, "tidal:fresh-b", "Fresh B", "Two", { genre: "Progressive House" });
  db.prepare(`INSERT INTO sonic_neighbor_feedback (anchor_identity_key, candidate_identity_key, rating, model, model_version) VALUES (?, ?, ?, ?, ?)`).run("tidal:anchor", "tidal:reviewed", "skip", "discogs-effnet", "1");

  const service = createService(db);
  const result = await service.startReviewSession({
    anchor: { identityKey: "tidal:anchor", artist: "Anchor Artist", title: "Anchor Track" },
    count: 3,
    queuePolicy: "STRONG_ONLY",
    noveltyPolicy: "PREFER_FRESH"
  });

  assert.equal(result.status, "READY");
  assert.equal(result.candidateCount, 2);
  assert.equal(result.currentItem.candidateIdentity, "tidal:fresh-a");
  assert.equal(result.completedCount, 0);
  assert.equal(result.queuedCount, 0);
  assert.equal(result.diagnostics.progressResumed, false);
  assert.equal(result.diagnostics.rejectionReasons["previously-reviewed-or-anchor"], 1);
  assert.equal(result.diagnostics.rejectionReasons.duplicate, 1);

  const next = service.getNextReviewItem(result.sessionId);
  assert.equal(next.item.candidateIdentity, "tidal:fresh-a");
  assert.equal(next.item.position, 1);
  assert.equal(next.item.sonicRelationship.cosineSimilarity, 0.94);
});

test("session generation uses asynchronous scoring and refreshes its standby snapshot for each request", async () => {
  const db = createDb();
  let standbyReads = 0;
  let standby = [candidate("tidal:1", "Artist A", "One", 0.9)];
  let ioRan = false;
  const service = createService(db, {
    generateSonicNeighborCandidates() { throw new Error("Live scoring must use the asynchronous path"); },
    async generateSonicNeighborCandidatesAsync() {
      setImmediate(() => { ioRan = true; });
      return { candidates: [
        candidate("tidal:1", "Artist A", "One", 0.9),
        candidate("tidal:2", "Artist B", "Two", 0.8),
        candidate("tidal:3", "Artist C", "Three", 0.7)
      ] };
    }
  }, { standbyStore: { read() { standbyReads++; return { candidates: standby }; } } });
  try {
    const first = await service.startReviewSession({ anchor: "tidal:anchor", count: 3, noveltyPolicy: "FRESH_ONLY" });
    assert.equal(ioRan, true);
    assert.equal(standbyReads, 1);
    assert.equal(first.candidateCount, 2);
    assert.equal(first.currentItem.candidateIdentity, "tidal:2");
    standby = [candidate("tidal:3", "Artist C", "Three", 0.7)];
    const second = await service.startReviewSession({ anchor: "tidal:anchor", count: 3, noveltyPolicy: "FRESH_ONLY" });
    assert.equal(standbyReads, 2);
    assert.equal(second.candidateCount, 2);
    assert.equal(second.currentItem.candidateIdentity, "tidal:1");
  } finally { db.close(); }
});

test("session state survives a service restart and pause/resume keeps the pointer stable", async () => {
  const db = createDb();
  db.prepare(`INSERT INTO sonic_neighbor_feedback (anchor_identity_key, candidate_identity_key, rating, model, model_version) VALUES (?, ?, ?, ?, ?)`).run("tidal:anchor", "tidal:reviewed", "skip", "discogs-effnet", "1");
  const service = createService(db);
  const created = await service.startReviewSession({ anchor: "tidal:anchor", count: 2 });
  const paused = service.pauseReviewSession(created.sessionId);
  assert.equal(paused.status, "PAUSED");

  const restarted = createService(db);
  const read = restarted.getReviewSession(created.sessionId);
  assert.equal(read.status, "PAUSED");
  assert.equal(read.currentIndex, 0);
  assert.equal(read.remainingCount, 2);
  assert.equal(restarted.getNextReviewItem(created.sessionId).item.candidateIdentity, "tidal:fresh-a");

  const resumed = restarted.resumeReviewSession(created.sessionId);
  assert.equal(resumed.status, "RUNNING");
  assert.equal(resumed.currentIndex, 0);
  assert.equal(resumed.currentItem.candidateIdentity, "tidal:fresh-a");
  assert.equal(restarted.listReviewSessions({ status: "RUNNING" }).sessions[0].sessionId, created.sessionId);
});

test("assistant context is compact, evidence-labeled, and never returns the stored raw vector", async () => {
  const db = createDb();
  addMemoryTrack(db, 1, "tidal:anchor", "Anchor Artist", "Anchor Track", { genre: "Progressive House", bpm: 122, label: "Test Label" });
  addMemoryTrack(db, 2, "tidal:fresh-a", "Fresh A", "One", { genre: "Progressive House", subgenre: "Dark Progressive", bpm: 124, label: "Test Label" });
  const service = createService(db, {
    generateSonicNeighborCandidates() {
      return { candidates: [candidate("tidal:fresh-a", "Fresh A", "One", 0.94, { genre: "Progressive House" })], diagnostics: { returned: 1, budgetCost: { returnedNeighborRows: 1 } } };
    }
  });
  const session = await service.startReviewSession({ anchor: { identityKey: "tidal:anchor", artist: "Anchor Artist", title: "Anchor Track" }, count: 1 });
  const context = service.getAssistantReviewContext(session.sessionId);
  assert.equal(context.anchor.genre, "Progressive House");
  assert.equal(context.candidate.subgenre, "Dark Progressive");
  assert.equal(context.sonicRelationship.cosineSimilarity, 0.94);
  assert.equal(context.candidate.existingSonicProfile.dimensions, 1280);
  assert.equal(context.candidate.existingSonicProfile.vector, undefined);
  assert.equal(context.schemaHints.rawEmbeddingsReturned, false);
  assert.match(context.evidenceSummary.text, /Similarity: 0.94/);
});

test("review schema exposes canonical IDs and production remains shadow-only", () => {
  const db = createDb();
  const service = createService(db);
  const schema = service.getReviewSchema();
  assert.ok(schema.profile.genreLane.some((entry) => entry.id === "genre:progressive-house"));
  assert.ok(schema.profile.moods.every((entry) => entry.id.startsWith("mood:")));
  assert.ok(schema.profile.tags.every((entry) => entry.id.startsWith("trait:")));
  assert.deepEqual(schema.profile.energy, { min: 1, max: 10, integer: true });
  assert.equal(schema.evidence.rawEmbeddingsReturned, false);
  assert.equal(schema.evidence.productionRecommendationWeightingChanged, false);
});

test("save, queue, rate, advance, and cancel stay session-scoped while preserving existing authorities", async () => {
  const db = createDb();
  db.prepare(`INSERT INTO sonic_neighbor_feedback (anchor_identity_key, candidate_identity_key, rating, model, model_version) VALUES (?, ?, ?, ?, ?)`).run("tidal:anchor", "tidal:reviewed", "skip", "discogs-effnet", "1");
  const queued = [];
  const rated = [];
  const service = createService(db, {}, {
    queueTracks: async (tracks, options) => {
      queued.push({ tracks, options });
      return { requested: tracks.length, queuedCount: 1, failedCount: 0, queued: [{ track: tracks[0] }] };
    },
    recordRating: async (track, rating) => {
      rated.push({ track, rating });
      return { rating };
    }
  });
  const session = await service.startReviewSession({
    anchor: "tidal:anchor",
    count: 2,
    queuePolicy: "STRONG_ONLY",
    reviewPolicy: "ASSISTANT_AUTO"
  });
  const saved = await service.saveReviewItem({
    sessionId: session.sessionId,
    decision: "STRONG_KEEP",
    confidence: 0.87,
    profile: {
      genreLane: "genre:progressive-house",
      subgenres: ["genre:dark-progressive"],
      energy: 7,
      moods: ["mood:hypnotic"],
      tags: ["trait:long-form"],
      preserveTraits: ["trait:bass-architecture"],
      avoidTraits: ["trait:festival-track"],
      similarityEmphasis: ["sonic:bass"]
    }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.session.completedCount, 1);
  assert.equal(saved.nextItem.candidateIdentity, "tidal:fresh-b");
  assert.equal(saved.globalTasteProfileUpdated, false);

  const queuedResult = await service.queueReviewItem({ sessionId: session.sessionId, candidateIdentity: "tidal:fresh-a", mode: "append" });
  assert.equal(queuedResult.ok, true);
  assert.equal(queuedResult.session.queuedCount, 1);
  assert.equal(queued[0].options.matchPolicy, "strict");
  assert.equal(queued[0].options.allowBridge, true);

  const advanced = await service.advanceReviewSession({ sessionId: session.sessionId });
  assert.equal(advanced.session.currentIndex, 1);
  assert.equal(advanced.session.skippedCount, 0);
  assert.equal(advanced.item.candidateIdentity, "tidal:fresh-b");

  const rating = await service.rateReviewItem({ sessionId: session.sessionId, rating: "LOVE" });
  assert.equal(rating.rating, "love");
  assert.equal(rated[0].rating, "love");
  const finished = await service.advanceReviewSession({ sessionId: session.sessionId });
  assert.equal(finished.session.status, "COMPLETED");
  assert.equal(finished.session.skippedCount, 1);

  const cancellable = await service.startReviewSession({ anchor: "tidal:anchor", count: 1 });
  const cancelled = service.cancelReviewSession(cancellable.sessionId);
  assert.equal(cancelled.status, "CANCELLED");
});
