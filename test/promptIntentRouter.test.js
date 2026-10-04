"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDiscoveryProfile,
  scoreBreakdownFor
} = require("../src/discoveryEngine");
const { routePromptIntent } = require("../src/promptIntentRouter");

test("theme prompt routes as open-ended theme discovery with light taste", () => {
  const profile = buildDiscoveryProfile({
    request: "find love songs about being apart",
    scoringMode: "taste-guided"
  });

  assert.equal(profile.promptIntent.route, "theme");
  assert.equal(profile.intent.searchRoute, "Theme First");
  assert.deepEqual(profile.targetGenres, []);
  assert.equal(profile.intent.requestedGenre, "open-ended");
  assert.equal(profile.intent.tasteInfluence, "lightly");
  assert.match(profile.intent.outsideTaste, /allowed/i);
  assert.equal(profile.intent.theme.includes("love"), true);
  assert.equal(profile.intent.theme.includes("being apart"), true);
  assert.equal(profile.vibeTerms.includes("emotional"), true);
});

test("pure search disables taste for theme prompts", () => {
  const profile = buildDiscoveryProfile({
    request: "find love songs about being apart",
    scoringMode: "pure"
  });

  assert.equal(profile.promptIntent.route, "theme");
  assert.equal(profile.intent.tasteInfluence, "not at all");
  assert.equal(profile.tasteApplication, "not at all");
});

test("prompt theme evidence affects scoring without requiring a genre", () => {
  const options = {
    request: "find love songs about being apart",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const breakdown = scoreBreakdownFor({
    artist: "Example Artist",
    title: "Far Away Love",
    album: "Long Distance",
    label: "Example Music",
    year: 2026,
    durationMs: 280000,
    query: "long distance love electronic"
  }, options, null, profile);

  assert.equal(breakdown.promptIntentEvidence.corroboratesRequested, true);
  assert.ok(breakdown.promptIntentEvidence.confidence >= 35);
  assert.ok(breakdown.genreMatch > 0);
  assert.ok(breakdown.promptMatch.percent >= 50);
});

test("explicit genre prompt still routes as genre-first", () => {
  const profile = buildDiscoveryProfile({
    request: "find progressive house",
    scoringMode: "taste-guided"
  });

  assert.equal(profile.promptIntent.route, "genre");
  assert.equal(profile.intent.searchRoute, "Genre First");
  assert.equal(profile.targetGenres.includes("progressive house"), true);
  assert.equal(profile.intent.progressiveBias, "relevant to prompt");
  assert.match(profile.intent.tastePolicy, /soft ranking|soft preference/i);
  assert.match(profile.intent.outsideTaste, /allowed/i);
});

test("a new explicit genre is not limited by the learned genre profile", () => {
  const profile = buildDiscoveryProfile({
    request: "discover future house",
    genres: "future house",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      tasteInfluence: "not at all",
      seedArtists: ["Progressive Taste Artist"],
      candidateArtists: ["Fresh Future House Artist"]
    }
  });

  assert.equal(profile.targetGenres.includes("future house"), true);
  assert.equal(profile.intent.tasteInfluence, "lightly");
  assert.match(profile.intent.tastePolicy, /never a genre whitelist/i);
  assert.match(profile.intent.outsideTaste, /allowed/i);
  assert.deepEqual(profile.seedArtists, ["Fresh Future House Artist"]);
});

test("outside-taste language keeps the genre but relaxes learned taste", () => {
  const profile = buildDiscoveryProfile({
    request: "find dark ambient outside my usual taste",
    scoringMode: "taste-guided"
  });

  assert.equal(profile.promptIntent.route, "genre");
  assert.equal(profile.targetGenres.includes("ambient"), true);
  assert.equal(profile.intent.tasteInfluence, "lightly");
  assert.match(profile.intent.outsideTaste, /allowed/i);
});

test("use-my-taste prompts stay cluster-led without turning taste into a hard whitelist", () => {
  const intent = routePromptIntent({
    request: "find tracks that match my current taste profile, but go deeper and avoid repeats",
    scoringMode: "taste-guided"
  });

  assert.equal(intent.allowOutsideTaste, false);
  assert.equal(intent.outsideTasteMode, "taste-profile");
  assert.equal(intent.tasteInfluence, "strongly");
  assert.match(intent.tastePolicy, /primary cluster guide/i);
  assert.match(intent.notes, /without becoming a hard whitelist/i);
});

test("radio-like standby wording does not become similarity intent", () => {
  const intent = routePromptIntent({
    request: "find tracks that fit my current Rabbit Hole taste profile; prefer radio-like sources and non-obvious discoveries",
    scoringMode: "taste-guided"
  });

  assert.equal(intent.outsideTasteMode, "taste-profile");
  assert.equal(intent.tasteInfluence, "strongly");
  assert.notEqual(intent.route, "similarity");
});

test("explicit branch-out language still opens taste-led discovery", () => {
  const intent = routePromptIntent({
    request: "use my taste profile but branch out into fresh artists",
    scoringMode: "taste-guided"
  });

  assert.equal(intent.allowOutsideTaste, true);
  assert.equal(intent.outsideTasteMode, "explicit");
});

test("router can consume local model theme hints as soft prompt intent", () => {
  const intent = routePromptIntent({
    request: "find songs about reconnection",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      intentRoute: "theme",
      themeTerms: ["reconnection", "coming back together"],
      allowOutsideTaste: true,
      tasteInfluence: "lightly"
    }
  });

  assert.equal(intent.route, "theme");
  assert.equal(intent.themeTerms.includes("reconnection"), true);
  assert.equal(intent.allowOutsideTaste, true);
  assert.equal(intent.tasteInfluence, "lightly");
});

test("open any-genre prompts do not accept hallucinated local model themes", () => {
  const intent = routePromptIntent({
    request: "Find me 12 good tracks no matter what genre it is, avoid repeats, surprise me.",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      intentRoute: "theme",
      themeTerms: ["new beginnings"],
      allowOutsideTaste: true
    }
  });

  assert.equal(intent.route, "open");
  assert.deepEqual(intent.themeTerms, []);
  assert.deepEqual(intent.queryExpansions, []);
});
