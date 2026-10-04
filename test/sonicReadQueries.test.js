"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const { createSonicReviewSessionService } = require("../src/sonicReviewSessionService");

test("startup migration keeps live Sonic history lookups off full table scans", async () => {
  const memory = new MusicMemoryStore({ dbFile: ":memory:", logger: null });
  const database = memory.db;
  const engine = new RecommendationEngineV2({ enabled: false, logger: null });
  engine.enabled = engine.store.enabled = true;
  engine.store.db = database;
  engine.store.migrate();
  const tracks = [
    { tidalId: "1", artist: "Anchor Artist", title: "Anchor" },
    { tidalId: "2", artist: "Candidate Artist", title: "Candidate" }
  ];
  for (const track of tracks) {
    memory.rememberObservation(track, "library");
    memory.saveTasteFeedback(track, { rating: "love" });
    memory.saveBeatportEnrichment(track, { genre: "Progressive House", label: "Test Label" });
    engine.store.upsertEmbedding({ track, vector: [1, 0.1], model: "discogs-effnet", modelVersion: "1" });
  }
  // Exercise an existing database being upgraded, not only a fresh schema.
  for (const name of ["idx_track_identity_artist_folded", "idx_beatport_enrichment_label_time", "idx_track_observation_track_source", "idx_taste_feedback_track_id_rating"]) {
    database.exec(`DROP INDEX ${name}`);
  }
  memory.migrate();
  const observed = [];
  const db = {
    exec: sql => database.exec(sql),
    prepare(sql) {
      const statement = database.prepare(sql);
      const wrapper = {};
      for (const method of ["all", "get", "run"]) wrapper[method] = (...params) => {
        if (/^\s*SELECT/i.test(sql)) observed.push({ sql, params });
        return statement[method](...params);
      };
      return wrapper;
    }
  };
  engine.store.db = db;
  try {
    const service = createSonicReviewSessionService({ db, recommendationEngine: engine, logger: null });
    await service.startReviewSession({ anchor: { ...tracks[0], identityKey: "tidal:1" }, count: 1, noveltyPolicy: "ALLOW_KNOWN" });
    const checks = [
      { match: /GROUP_CONCAT\(DISTINCT tf.rating\)/, searched: /SEARCH tf\b/, scanned: /SCAN tf\b/ },
      { match: /WHERE LOWER\(TRIM\(label\)\)/, searched: /SEARCH beatport_enrichment\b/, scanned: /SCAN beatport_enrichment\b/ },
      { match: /WHERE ti.normalized_artist = \? OR/, searched: /SEARCH ti\b/, scanned: /SCAN ti\b/ },
      { match: /AS observation_sources/, searched: /SEARCH ob\b/, scanned: /SCAN (?:ob|fb)\b/ }
    ];
    for (const { match, searched, scanned } of checks) {
      const query = observed.find(({ sql }) => match.test(sql));
      assert.ok(query, `Live request did not exercise ${match}`);
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params).map(row => row.detail).join("\n");
      assert.match(plan, searched);
      assert.doesNotMatch(plan, scanned);
    }
  } finally {
    engine.store.db = null;
    memory.close();
  }
});
