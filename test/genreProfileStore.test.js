"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildDiscoveryProfile, rejectReason } = require("../src/discoveryEngine");
const { GenreProfileStore } = require("../src/genreProfileStore");

test("unknown child genre stays strict instead of collapsing to parent", () => {
  const options = {
    request: "Find swamp house tracks",
    genres: "swamp house",
    years: "2025",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);

  assert.equal(profile.targetGenres.includes("swamp house"), true);
  assert.equal(profile.targetGenres.includes("house"), false);
  assert.equal(profile.genreProfile.strict, true);
  assert.deepEqual(profile.genreProfile.parentGenres, ["house"]);
  assert.equal(profile.genreProfile.keywords.includes("swamp"), true);

  const genericHouseReason = rejectReason({
    artist: "Generic Club Artist",
    title: "House Motion",
    album: "House Motion",
    label: "Club House Records",
    genre: "House",
    year: 2025,
    releaseEvidence: { albumYear: true },
    durationMs: 390000,
    query: "swamp house 2025"
  }, options, profile);

  assert.match(genericHouseReason, /swamp house requested/i);
});

test("genre profile feedback promotes and prunes niche genre seeds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genre-profile-"));
  const store = new GenreProfileStore({ file: path.join(dir, "profiles.json") });
  const options = {
    request: "Find swamp house tracks",
    genres: "swamp house"
  };

  store.recordFeedback(options, {
    artist: "Bog Sequence",
    title: "Mire Jack",
    album: "Swamp Trax",
    label: "Wetland Acid"
  }, "love");
  store.recordFeedback(options, {
    artist: "Generic Club Artist",
    title: "House Motion",
    album: "House Motion",
    label: "Club House Records"
  }, "wrong_genre");

  const augmented = store.augmentOptions(options);
  const learned = augmented.learnedGenreProfiles["swamp house"];

  assert.ok(learned.artists.includes("Bog Sequence"));
  assert.ok(learned.labels.includes("Wetland Acid"));
  assert.ok(learned.excludeArtists.includes("Generic Club Artist"));
  assert.ok(learned.excludeLabels.includes("Club House Records"));
});
