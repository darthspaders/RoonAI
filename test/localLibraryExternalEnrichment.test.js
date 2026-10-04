"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isLikelyElectronicRow,
  providersForRow,
  parseArgs
} = require("../scripts/enrich-local-library-external");

test("external enrichment electronic gate honors strong genre evidence over folder names", () => {
  assert.equal(isLikelyElectronicRow({ file_path: "Z:\\Music\\EDM Playlist\\track.flac", genre: "house" }), true);
  assert.equal(isLikelyElectronicRow({ file_path: "Z:\\Music\\EDM Playlist\\track.flac", genre: "alternative rock, pop" }), false);
  assert.equal(isLikelyElectronicRow({ file_path: "Z:\\Music\\Pink Floyd\\track.flac", genre: "progressive rock" }), false);
});

test("external enrichment skips provider ids and non-electronic Beatport rows", () => {
  const row = {
    artist: "Artist",
    title: "Song",
    genre: "Progressive House",
    file_path: "Z:\\Music\\House\\Song.flac",
    beatport_id: "bp-1",
    musicbrainz_id: "",
    discogs_id: ""
  };
  assert.deepEqual(providersForRow(row, ["beatport", "musicbrainz", "discogs"], { electronicOnly: true }), ["musicbrainz", "discogs"]);
  assert.deepEqual(providersForRow({ ...row, genre: "Progressive Rock", file_path: "Z:\\Music\\EDM Playlist\\Song.flac", beatport_id: "" }, ["beatport"], { electronicOnly: true }), []);
});

test("external enrichment parser supports full resumable provider passes", () => {
  const args = parseArgs(["--providers", "musicbrainz,beatport", "--all", "--electronic-only", "--write"]);
  assert.deepEqual(args.providers, ["musicbrainz", "beatport"]);
  assert.equal(args.all, true);
  assert.equal(args.electronicOnly, true);
  assert.equal(args.write, true);
});
