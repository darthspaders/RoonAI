"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { analyzeCollection, collectFromData, writeBackfill } = require("../scripts/backfill-music-memory");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-backfill-"));
}

function writeJson(dir, file, value) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
}

test("music memory backfill imports local stores idempotently", () => {
  const dir = tempDir();
  const dbFile = path.join(dir, "memory.sqlite");
  writeJson(dir, "track-memory.json", {
    entries: [{
      artist: "Ezequiel Arias",
      title: "Solar",
      album: "Solar",
      tidal: { id: "171847444", isrc: "GBEWA2100645", label: "Anjunadeep" },
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      seenCount: 3,
      feedback: "love"
    }]
  });
  writeJson(dir, "taste-profile.json", {
    feedback: {
      "https://tidal.com/browse/track/171847444": {
        rating: "love",
        artist: "Ezequiel Arias",
        title: "Solar",
        tidalUrl: "https://tidal.com/browse/track/171847444",
        calibration: { issue: "liked_longshot", source: "Taste Guided", recordedAt: "2026-01-01T00:00:00.000Z" },
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  });
  writeJson(dir, "metadata-enrichment-cache.json", {
    entries: [{
      status: "found",
      source: "beatport",
      id: "23107095",
      artist: "Ezequiel Arias",
      title: "Solar",
      genre: "Melodic House & Techno",
      beatport: { id: "23107095", genre: "Melodic House & Techno", subGenre: "Progressive House" },
      bpm: 123,
      keyName: "Gb Major",
      camelot: "2B",
      isrc: "GBEWA2100645",
      confidence: 100,
      updatedAt: "2026-01-01T00:00:01.000Z"
    }]
  });

  const collection = collectFromData(dir);
  const dryRun = analyzeCollection(collection);
  assert.equal(dryRun.uniqueIdentities, 1);
  assert.equal(dryRun.feedbackEvents, 2);
  assert.equal(dryRun.enrichmentRecords, 1);

  const first = writeBackfill(collection, dbFile);
  const second = writeBackfill(collection, dbFile);

  assert.equal(first.after.trackCount, 1);
  assert.equal(first.after.observationCount, 2);
  assert.equal(first.after.feedbackCount, 2);
  assert.equal(first.after.providerEnrichmentCount, 1);
  assert.equal(second.after.trackCount, second.before.trackCount);
  assert.equal(second.after.observationCount, second.before.observationCount);
  assert.equal(second.after.feedbackCount, second.before.feedbackCount);
  assert.equal(second.after.providerEnrichmentCount, second.before.providerEnrichmentCount);
});

test("music memory backfill source event ids are stable without source timestamps", () => {
  const dir = tempDir();
  writeJson(dir, "listening-history.json", {
    plays: [{
      artist: "Guy J",
      title: "Lost & Found",
      tidalId: "999"
    }]
  });

  const first = collectFromData(dir);
  const second = collectFromData(dir);

  assert.equal(first.observations.length, 1);
  assert.equal(first.observations[0].sourceEventId, second.observations[0].sourceEventId);
  assert.doesNotMatch(first.observations[0].sourceEventId, /\d{4}-\d{2}-\d{2}T/);
});
