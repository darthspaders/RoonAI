"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDiscoveryProfile, rejectReason } = require("../src/discoveryEngine");

function smithsOptions() {
  return {
    request: "music like The Smiths",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      seedArtists: ["The Smiths"],
      candidateArtists: ["The Cure", "The Chameleons", "Echo & the Bunnymen"],
      searchQueries: ["The Cure indie rock", "The Chameleons music The Smiths", "Echo & the Bunnymen post-punk"]
    }
  };
}

function check(track) {
  const options = smithsOptions();
  return rejectReason({ durationMs: 240000, year: 1987, ...track }, options, buildDiscoveryProfile(options));
}

test("an artist query for a model-planned artist rejects a different artist with a similar name", () => {
  const reason = check({
    artist: "Jah Cure",
    title: "Rock the Boat",
    album: "World Rebirth Riddim",
    label: "Rebirth Muzik",
    query: "The Cure indie rock"
  });

  assert.match(reason, /Search was for The Cure, but TIDAL returned Jah Cure\./);
});

test("an artist query for a model-planned artist rejects an unrelated keyword match", () => {
  const reason = check({
    artist: "Ludwig Goransson",
    title: "Can You Hear The Music",
    album: "Oppenheimer (Original Motion Picture Soundtrack)",
    label: "Universal Studios",
    query: "The Chameleons music The Smiths"
  });

  assert.match(reason, /Search was for The Chameleons, but TIDAL returned Ludwig Goransson\./);
});

test("an artist query keeps tracks by the artist it names", () => {
  const cure = check({
    artist: "The Cure",
    title: "Just like Heaven",
    album: "Kiss Me, Kiss Me, Kiss Me",
    label: "Fiction Records",
    query: "The Cure indie rock"
  });
  const bunnymen = check({
    artist: "Echo & the Bunnymen",
    title: "The Killing Moon",
    album: "Ocean Rain",
    label: "Korova",
    query: "Echo & the Bunnymen post-punk"
  });

  assert.doesNotMatch(cure, /Search was for/);
  assert.doesNotMatch(bunnymen, /Search was for/);
});

test("a cover titled made famous by the queried artist is rejected as a cover", () => {
  const reason = check({
    artist: "Twinkle Twinkle Little Rock Star",
    title: "Lovesong (made famous by The Cure)",
    album: "Lullaby Versions of ADELE",
    label: "Twinkle Twinkle Little Rock Star",
    query: "The Cure indie rock"
  });

  assert.equal(reason, "Cover/karaoke/tribute catalogue result.");
});
