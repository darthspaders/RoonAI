"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { buildFilePreview, buildMetadataWritePreview } = require("../src/localLibraryMetadataWritePreview");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE local_library_file (
      id INTEGER PRIMARY KEY, file_hash TEXT, file_path TEXT, file_format TEXT,
      artist TEXT, title TEXT, album TEXT, album_artist TEXT, track_number INTEGER,
      disc_number INTEGER, release_date TEXT, year INTEGER, genre TEXT, subgenre TEXT,
      label TEXT, bpm REAL, key_name TEXT, camelot TEXT, isrc TEXT, catalog_number TEXT,
      tidal_id TEXT, beatport_id TEXT, musicbrainz_id TEXT, discogs_id TEXT,
      completeness_score INTEGER, completeness_class TEXT, field_sources_json TEXT,
      raw_tags_json TEXT, status TEXT
    );
    CREATE TABLE local_library_match (
      local_file_id INTEGER, provider TEXT, match_type TEXT, accepted INTEGER
    );
  `);
  return db;
}

test("write preview fills only missing, high-confidence non-identity tags", () => {
  const db = makeDb();
  db.prepare(`INSERT INTO local_library_file VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, "a", "Z:\\Music\\one.flac", "flac", "Artist", "Track", "Album", "Artist", null, null,
    null, 2024, "Electronic", null, "", 124, "F Minor", "8A", "", "CAT-1", null, "bp-1", null, null,
    75, "mostly complete", JSON.stringify({ genre: { source: "beatport", confidence: 99, matchType: "HIGH_CONFIDENCE" }, bpm: { source: "beatport", confidence: 99, matchType: "HIGH_CONFIDENCE" }, artist: { source: "embedded", confidence: 100, matchType: "EMBEDDED" } }),
    JSON.stringify({ artist: "Artist", title: "Track", album: "Album", genre: "Electronic", bpm: "124", key: "F Minor", catalog: "CAT-1" }), "processed"
  );
  const item = buildFilePreview(db, db.prepare("SELECT * FROM local_library_file").get());
  assert.equal(item.changes.find((change) => change.field === "genre"), undefined);
  assert.equal(item.changes.find((change) => change.field === "bpm"), undefined);
  assert.equal(item.changes.find((change) => change.field === "albumArtist").decision, "blocked");
  db.close();
});

test("low-confidence metadata is manual review, not safe fill", () => {
  const db = makeDb();
  db.prepare(`INSERT INTO local_library_file VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, "b", "Z:\\Music\\two.flac", "flac", "Artist", "Track", "Album", null, null, null,
    null, null, null, null, "Label", 124, null, null, null, null, null, null, null, null,
    30, "partial", JSON.stringify({ label: { source: "rabbit-hole-memory", confidence: 90, matchType: "CACHED_BEATPORT" } }),
    JSON.stringify({ artist: "Artist", title: "Track", album: "Album" }), "processed"
  );
  const item = buildFilePreview(db, db.prepare("SELECT * FROM local_library_file").get());
  assert.equal(item.changes.find((change) => change.field === "label").decision, "manual_review");
  db.close();
});

test("preview reports summary without mutating the database", () => {
  const db = makeDb();
  const preview = buildMetadataWritePreview(db);
  assert.equal(preview.policy.writesAudioFiles, false);
  assert.equal(preview.summary.filesScanned, 0);
  db.close();
});
