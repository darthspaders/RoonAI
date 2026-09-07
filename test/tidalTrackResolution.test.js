"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compactVerifiedTrack,
  metadataPlaylistMatch,
  verificationTrackFromInput
} = require("../src/tidalTrackResolution");

test("metadata playlist match checks candidate stores in order and preserves matched TIDAL identity", () => {
  const candidate = {
    artist: "Artist",
    title: "Track",
    metadataEnrichment: {
      artist: "Wrong",
      title: "Track",
      tidalUrl: "https://tidal.com/browse/track/wrong"
    },
    metadata_enrichment: {
      artist: "Artist",
      title: "Track",
      album: "Album",
      label: "Label",
      releaseYear: 2026,
      durationMs: 360000,
      url: "https://tidal.com/browse/track/right"
    }
  };

  const result = metadataPlaylistMatch(candidate, {
    matches: (_track, verified) => verified.artist === "Artist"
  });

  assert.equal(result.id, "right");
  assert.equal(result.tidalId, "right");
  assert.equal(result.album, "Album");
  assert.equal(result.label, "Label");
  assert.equal(result.year, 2026);
  assert.equal(result.tidal.tidalUrl, "https://tidal.com/browse/track/right");
});

test("metadata playlist match can use a lazy cached entry fallback", () => {
  const result = metadataPlaylistMatch({ artist: "A", title: "T" }, {
    cachedEntry: () => ({ artist: "A", title: "T", id: "abc" }),
    matches: () => true
  });

  assert.equal(result.tidalUrl, "https://tidal.com/browse/track/abc");
});

test("compact verified track normalizes nested TIDAL metadata", () => {
  const compact = compactVerifiedTrack({
    tidal: {
      id: "123",
      artist: " Artist ",
      title: " Title ",
      album: " Album ",
      label: " Label ",
      releaseYear: 2025,
      durationMs: "420000",
      audioQuality: "LOSSLESS"
    },
    matchScore: "93"
  });

  assert.deepEqual(compact, {
    id: "123",
    artist: "Artist",
    title: "Title",
    album: "Album",
    label: "Label",
    year: 2025,
    releaseDate: "",
    durationMs: 420000,
    tidalUrl: "",
    matchScore: 93,
    audioQuality: "LOSSLESS"
  });
});

test("verification track input accepts strings, aliases, arrays, and nested TIDAL metadata", () => {
  assert.deepEqual(verificationTrackFromInput("Artist - Track - Extended Mix"), {
    artist: "Artist",
    title: "Track - Extended Mix"
  });

  assert.deepEqual(verificationTrackFromInput({
    artists: ["A", "B"],
    name: "Name",
    release: "Release",
    url: "https://tidal.com/browse/track/1"
  }), {
    artists: ["A", "B"],
    name: "Name",
    release: "Release",
    url: "https://tidal.com/browse/track/1",
    artist: "A, B",
    title: "Name",
    album: "Release",
    tidalUrl: "https://tidal.com/browse/track/1"
  });
});
