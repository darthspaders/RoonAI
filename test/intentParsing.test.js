"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDiscoveryProfile,
  effectiveDiscoveryCount
} = require("../src/discoveryEngine");

function profileFor(request, extra = {}) {
  return buildDiscoveryProfile({
    request,
    scoringMode: "taste-guided",
    ...extra
  });
}

function hasTerm(profile, term) {
  return profile.targetGenres.includes(term);
}

function lacksTerm(profile, term) {
  return !profile.targetGenres.includes(term);
}

test("progressive psytrance stays in the psytrance lane", () => {
  const profile = profileFor("Find progressive psytrance");

  assert.equal(hasTerm(profile, "progressive psytrance"), true);
  assert.equal(hasTerm(profile, "psytrance"), true);
  assert.equal(lacksTerm(profile, "progressive house"), true);
  assert.equal(profile.isProgressiveTarget, false);
  assert.equal(profile.intent.progressiveBias, "off unless explicitly requested");
});

test("psychedelic trance is a psytrance genre phrase, not a 70s vibe", () => {
  const profile = profileFor("Find psychedelic trance");

  assert.equal(hasTerm(profile, "psytrance"), true);
  assert.equal(hasTerm(profile, "psychedelic trance"), true);
  assert.equal(lacksTerm(profile, "progressive house"), true);
  assert.deepEqual(profile.vibeTerms, []);
  assert.equal(profile.vibeSource, "not specified");
  assert.equal(profile.intent.requestedEraDateRange, "not specified");
});

test("progressive house remains a progressive-house target", () => {
  const profile = profileFor("Find progressive house");

  assert.equal(hasTerm(profile, "progressive house"), true);
  assert.equal(lacksTerm(profile, "psytrance"), true);
  assert.equal(profile.isProgressiveTarget, true);
  assert.equal(profile.intent.progressiveBias, "relevant to prompt");
});

test("tech house does not collapse into generic house", () => {
  const profile = profileFor("Find tech house");

  assert.equal(hasTerm(profile, "tech house"), true);
  assert.equal(lacksTerm(profile, "house"), true);
  assert.equal(profile.isProgressiveTarget, false);
});

test("melodic techno does not collapse into generic techno", () => {
  const profile = profileFor("Find melodic techno");

  assert.equal(hasTerm(profile, "melodic techno"), true);
  assert.equal(lacksTerm(profile, "techno"), true);
  assert.equal(profile.isProgressiveTarget, false);
});

test("psytrance with no vibe requested has no inferred mood", () => {
  const profile = profileFor("Find psytrance");

  assert.equal(hasTerm(profile, "psytrance"), true);
  assert.deepEqual(profile.vibeTerms, []);
  assert.equal(profile.vibeSource, "not specified");
  assert.equal(profile.intent.requestedVibe, "not specified");
});

test("psytrance with an explicit vibe keeps that vibe explicit", () => {
  const profile = profileFor("Find psytrance with a hypnotic driving vibe");

  assert.equal(hasTerm(profile, "psytrance"), true);
  assert.equal(profile.vibeTerms.includes("hypnotic"), true);
  assert.equal(profile.vibeTerms.includes("driving"), true);
  assert.equal(profile.vibeSource, "explicit");
  assert.equal(profile.intent.requestedVibeSource, "explicit");
});

test("pure search treats lby as by when extracting requested artist", () => {
  const profile = profileFor("find more tracks lby Rafael Osmo", {
    scoringMode: "pure"
  });

  assert.deepEqual(profile.requestedArtists, ["Rafael Osmo"]);
  assert.deepEqual(profile.seedArtists, ["Rafael Osmo"]);
  assert.equal(profile.tasteApplication, "not at all");
});

test("explicit small track counts stay exact in Taste Guided", () => {
  assert.equal(effectiveDiscoveryCount({
    request: "find 5 progressive house tracks this year",
    genres: "progressive house",
    years: "2026",
    scoringMode: "taste-guided"
  }), 5);

  assert.equal(effectiveDiscoveryCount({
    request: "find progressive house tracks this year",
    count: "5",
    genres: "progressive house",
    years: "2026",
    scoringMode: "taste-guided"
  }), 5);
});
