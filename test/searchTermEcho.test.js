"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDiscoveryProfile, rejectReason } = require("../src/discoveryEngine");

function gabrielOptions(overrides = {}) {
  return {
    request: "find tracks like Peter Gabriel - Solsbury Hill, but deeper and less obvious",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      intentRoute: "similarity",
      seedArtists: ["Peter Gabriel"],
      candidateArtists: ["Kate Bush", "Talking Heads"],
      targetGenres: ["progressive rock", "art rock"],
      vibeTerms: ["introspective", "melancholic"],
      themeTerms: ["introspective"],
      searchQueries: ["introspective", "art rock 1980s"]
    },
    ...overrides
  };
}

function check(track, options = gabrielOptions()) {
  return rejectReason({ durationMs: 240000, year: 2020, label: "Some Label", ...track }, options, buildDiscoveryProfile(options));
}

const ECHO = /only echoes the search term "introspective"/;

test("a track whose title is just a model-invented search term is rejected", () => {
  assert.match(check({ artist: "Oliver Tree", title: "Introspective", album: "Introspective", query: "introspective" }), ECHO);
  assert.match(check({ artist: "Sam Gellaitry", title: "INTROSPECTIVE", album: "INTROSPECTIVE", query: "introspective" }), ECHO);
});

test("a track whose artist name is or starts with the search term is rejected", () => {
  assert.match(check({ artist: "Introspective Sense", title: "Dark Power", album: "Dark Power", query: "introspective" }), ECHO);
  assert.match(check({ artist: "Introspective (PT)", title: "Divine Force (Original Mix)", album: "Divine Force", query: "introspective" }), ECHO);
  assert.match(check({ artist: "Introspective Release", title: "Restful ambitions 432Hz", album: "Restful", query: "introspective" }), ECHO);
});

test("a version suffix does not hide a title that is only the search term", () => {
  assert.match(check({ artist: "Someone", title: "Introspective (Original Mix)", album: "X", query: "introspective" }), ECHO);
});

test("a real result from the same search is not rejected for echoing it", () => {
  assert.doesNotMatch(check({ artist: "Kate Bush", title: "Flower Of The Mountain", album: "Director's Cut", query: "introspective" }), ECHO);
  assert.doesNotMatch(check({ artist: "Someone", title: "An Introspective Evening", album: "X", query: "introspective" }), ECHO);
});

test("a term the listener typed is not treated as an echo", () => {
  const options = gabrielOptions({ request: "introspective songs like Peter Gabriel" });
  assert.doesNotMatch(check({ artist: "Oliver Tree", title: "Introspective", album: "Introspective", query: "introspective" }, options), ECHO);
});

test("theme searches keep titles that name the theme", () => {
  const options = {
    request: "love songs about being apart",
    scoringMode: "taste-guided",
    llmSearchPlan: { intentRoute: "theme", themeTerms: ["love", "being apart"], searchQueries: ["missing you"] }
  };
  assert.doesNotMatch(check({ artist: "Someone", title: "Missing You", album: "X", query: "missing you" }, options), /only echoes the search term/);
});

test("artist-led searches are left to the artist identity check", () => {
  assert.doesNotMatch(check({ artist: "Kate Bush", title: "Kate Bush", album: "X", query: "Kate Bush art rock" }), /only echoes the search term/);
});
