"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { importMusicBrainzJson } = require("../scripts/import-musicbrainz-json");
const { MusicBrainzLocalIndex, bucketForTitle, compactRecording, recordingsFromRelease } = require("../src/musicBrainzLocalIndex");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-mb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("local MusicBrainz index imports release tracks and searches by artist/title", async (t) => {
  const root = tempDir(t);
  const dump = path.join(root, "dump", "mbdump");
  const indexDir = path.join(root, "index");
  fs.mkdirSync(dump, { recursive: true });
  fs.writeFileSync(path.join(dump, "release"), JSON.stringify({
    id: "release-1",
    title: "Night Versions",
    date: "2026-02-01",
    "release-group": { id: "rg-1", title: "Night Versions" },
    "artist-credit": [{ artist: { id: "artist-1", name: "Avoure" } }],
    genres: [{ name: "progressive house" }],
    media: [{
      tracks: [{
        title: "U",
        length: 420000,
        recording: {
          id: "recording-1",
          title: "U",
          isrcs: ["USABC2600011"],
          tags: [{ name: "melodic house" }]
        }
      }]
    }]
  }) + "\n");

  const manifest = await importMusicBrainzJson({ dumpDir: path.join(root, "dump"), indexDir });
  assert.equal(manifest.entryCount, 1);

  const index = new MusicBrainzLocalIndex({ enabled: true, indexDir });
  const rows = index.searchRecordings({ artist: "Avoure", title: "U" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "recording-1");
  assert.equal(rows[0].releases[0].title, "Night Versions");
  assert.equal(rows[0].releases[0].genres[0].name, "progressive house");
});

test("local MusicBrainz index can search by ISRC outside title bucket", async (t) => {
  const root = tempDir(t);
  const dump = path.join(root, "dump", "mbdump");
  const indexDir = path.join(root, "index");
  fs.mkdirSync(dump, { recursive: true });
  fs.writeFileSync(path.join(dump, "recording"), JSON.stringify({
    id: "recording-2",
    title: "Tree",
    isrcs: ["NLXYZ2600007"],
    "artist-credit": [{ artist: { name: "Nopi" } }]
  }) + "\n");

  await importMusicBrainzJson({ dumpDir: path.join(root, "dump"), indexDir });
  const index = new MusicBrainzLocalIndex({ enabled: true, indexDir });
  const rows = index.searchRecordings({ artist: "Nopi", title: "Different Title", isrc: "NL-XYZ-26-00007" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Tree");
});

test("local MusicBrainz importer skips malformed dump rows", async (t) => {
  const root = tempDir(t);
  const dump = path.join(root, "dump", "mbdump");
  const indexDir = path.join(root, "index");
  fs.mkdirSync(dump, { recursive: true });
  fs.writeFileSync(path.join(dump, "recording"), [
    JSON.stringify({ id: "good-1", title: "Good", artist: "Artist" }),
    "{\"id\":\"bad\",\"title\":\"Broken",
    JSON.stringify({ id: "good-2", title: "Better", artist: "Artist" })
  ].join("\n"));

  const manifest = await importMusicBrainzJson({
    dumpDir: path.join(root, "dump"),
    indexDir,
    logger: { info: () => {}, warn: () => {} }
  });
  assert.equal(manifest.entryCount, 2);
  assert.equal(manifest.skippedRows, 1);
});

test("local MusicBrainz index is unavailable until manifest exists", (t) => {
  const dir = tempDir(t);
  const index = new MusicBrainzLocalIndex({ enabled: true, indexDir: dir });
  assert.equal(index.status().available, false);
  assert.deepEqual(index.searchRecordings({ artist: "A", title: "B" }), []);
});

test("compact helpers preserve MusicBrainz-shaped genre and release evidence", () => {
  const recording = compactRecording({
    id: "r",
    title: "Track",
    artist: "Artist",
    genres: [{ name: "progressive trance" }]
  });
  assert.equal(recording["artist-credit"][0].artist.name, "Artist");
  assert.equal(recording.genres[0].name, "progressive trance");

  const releaseRows = recordingsFromRelease({
    title: "Album",
    "artist-credit": [{ artist: { name: "Album Artist" } }],
    media: [{ tracks: [{ title: "Track", recording: { id: "r2", title: "Track" } }] }]
  });
  assert.equal(releaseRows[0].releases[0].title, "Album");
});

test("title buckets are stable and filesystem safe", () => {
  assert.equal(bucketForTitle("Élan!"), "el");
  assert.equal(bucketForTitle(""), "__");
});
