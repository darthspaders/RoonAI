"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { batchExecutionSupported, parseArgs, readEligibleRows, sourceMetadata, trackFromRow } = require("../scripts/sonic-analyze-linked-local");

function testDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE local_library_file (
      id INTEGER PRIMARY KEY,
      file_path TEXT,
      file_hash TEXT,
      artist TEXT,
      title TEXT,
      album TEXT,
      duration_ms INTEGER,
      beatport_id TEXT,
      isrc TEXT,
      genre TEXT,
      subgenre TEXT,
      label TEXT,
      bpm REAL,
      key_name TEXT,
      year INTEGER,
      completeness_score INTEGER DEFAULT 0,
      field_sources_json TEXT,
      status TEXT
    );
    CREATE TABLE local_library_identity_link (
      local_file_id INTEGER,
      track_identity_id INTEGER,
      link_status TEXT,
      confidence INTEGER
    );
    CREATE TABLE track_identity (
      id INTEGER PRIMARY KEY,
      identity_key TEXT,
      artist TEXT,
      title TEXT,
      album TEXT,
      mix_version TEXT,
      tidal_id TEXT,
      isrc TEXT
    );
    CREATE TABLE beatport_enrichment (
      track_identity_id INTEGER,
      beatport_track_id TEXT,
      genre TEXT,
      subgenre TEXT,
      label TEXT,
      bpm REAL,
      key_name TEXT,
      release_date TEXT,
      duration_ms INTEGER
    );
    CREATE TABLE track_sonic_profile (
      identity_key TEXT,
      model TEXT,
      model_version TEXT,
      metadata_json TEXT,
      source_sha256 TEXT
    );
    CREATE TABLE taste_feedback (track_identity_id INTEGER);
  `);
  db.exec(`
    INSERT INTO local_library_file
      (id, file_path, file_hash, artist, title, album, duration_ms, beatport_id, isrc,
       genre, subgenre, label, bpm, key_name, year, field_sources_json, status)
    VALUES
      (1, 'Z:/a.flac', 'hash-a', 'Artist A', 'Track A', 'Album A', 180000, '101', '', 'Dubstep', '', 'Label A', 140, 'C Minor', 2025, '{"beatportId":{"confidence":90}}', 'processed'),
      (2, 'Z:/a-copy.flac', 'hash-a-copy', 'Artist A', 'Track A', 'Album A', 180000, '101', '', 'Dubstep', '', 'Label A', 140, 'C Minor', 2025, '{"beatportId":{"confidence":90}}', 'processed'),
      (3, 'Z:/b.flac', 'hash-b', 'Artist B', 'Track B', 'Album B', 200000, '102', '', 'Progressive House', '', 'Label B', 124, 'F Minor', 2025, '{"beatportId":{"confidence":100}}', 'processed'),
      (4, 'Z:/ambiguous.flac', 'hash-c', 'Artist C', 'Track C', 'Album C', 210000, '103', '', 'Tech House', '', 'Label C', 126, 'G Minor', 2025, '{"beatportId":{"confidence":90}}', 'processed'),
      (5, 'Z:/no-beatport.flac', 'hash-d', 'Artist D', 'Track D', 'Album D', 220000, '', '', 'Rock', '', '', 0, '', 2025, '{}', 'processed'),
      (6, 'Z:/already-profiled.flac', 'hash-e', 'Artist E', 'Track E', 'Album E', 230000, '104', '', 'Psytrance', '', 'Label E', 138, 'A Minor', 2025, '{"beatportId":{"confidence":90}}', 'processed');
    INSERT INTO local_library_identity_link VALUES (3, 3, 'EXACT', 100), (4, 4, 'AMBIGUOUS', 60);
    INSERT INTO track_identity VALUES (3, 'tidal:3', 'Artist B', 'Track B', 'Album B', '', '3', '');
    INSERT INTO track_identity VALUES (4, 'tidal:4', 'Artist C', 'Track C', 'Album C', '', '4', '');
    INSERT INTO track_sonic_profile (identity_key, model, model_version, metadata_json, source_sha256)
      VALUES ('beatport:104', 'discogs-effnet', '1', '{"beatportId":"104"}', 'hash-e');
  `);
  return db;
}

test("Beatport-backed local selection accepts no-link rows, dedupes IDs, and excludes ambiguous or profiled rows", () => {
  const db = testDatabase();
  const rows = readEligibleRows(db, { limit: 50, offset: 0, model: "discogs-effnet", modelVersion: "1" });
  assert.deepEqual(rows.map((row) => row.local_file_id), [1, 3]);
  assert.equal(trackFromRow(rows[0]).identityKey, "beatport:101");
  assert.equal(trackFromRow(rows[1]).identityKey, "tidal:3");
  assert.equal(sourceMetadata(rows[0]).localFileHash, "hash-a");
  assert.equal(sourceMetadata(rows[0]).sourceAudioType, "local-file");
  assert.equal(sourceMetadata(rows[0]).sourceMatchConfidence, 90);
});

test("local-file selection analyzes unprofiled rows without Beatport coverage using file identity", () => {
  const db = testDatabase();
  const rows = readEligibleRows(db, {
    source: "local-file",
    limit: 50,
    offset: 0,
    model: "discogs-effnet",
    modelVersion: "1"
  });
  assert.deepEqual(rows.map((row) => row.local_file_id), [5]);
  assert.equal(trackFromRow(rows[0], { source: "local-file" }).identityKey, "file:hash-d");
  assert.equal(sourceMetadata(rows[0], { source: "local-file" }).sourceMatchType, "LOCAL_FILE_METADATA_BACKED");
});

test("linked-local sonic runner defaults to safe auto warm execution and accepts explicit modes", () => {
  assert.equal(parseArgs([]).execution, "auto");
  assert.equal(parseArgs(["--execution", "serial"]).execution, "serial");
  assert.equal(parseArgs(["--mode", "batch", "--device", "gpu"]).execution, "batch");
  assert.equal(parseArgs(["--mode", "batch", "--device", "gpu"]).device, "cuda");
  assert.equal(parseArgs(["--source", "local-file"]).source, "local-file");
  assert.equal(parseArgs(["--limit", "999"]).limit, 500);
  assert.equal(typeof batchExecutionSupported(), "boolean");
  assert.throws(() => parseArgs(["--execution", "parallel"]), /auto, batch, or serial/);
});
