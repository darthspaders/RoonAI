"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSimilarArtistExpansion } = require("../src/similarArtistExpansion");

function createExpansion(overrides = {}) {
  return createSimilarArtistExpansion({
    buildDiscoveryProfile: overrides.buildDiscoveryProfile || (() => ({ scoringMode: "explore" })),
    config: overrides.config || { lastfm: { timeoutMs: 3500 } },
    lastfm: overrides.lastfm || { status: () => ({ enabled: true, apiKeyConfigured: true }) },
    normalizeScoringMode: overrides.normalizeScoringMode || ((options = {}) => options.scoringMode || "explore"),
    rabbitHoleGraph: overrides.rabbitHoleGraph || {
      similarArtistsForSeeds: async () => []
    },
    tasteProfile: overrides.tasteProfile || {
      getTopArtists: () => []
    },
    withTimeout: overrides.withTimeout || ((promise) => promise)
  });
}

test("similar artist expansion keeps pure search disabled", async () => {
  const expansion = createExpansion({
    normalizeScoringMode: () => "pure"
  });

  const result = await expansion.withSimilarArtistSeeds({ request: "Khen", scoringMode: "pure" }, 8);

  assert.equal(result.similarArtistExpansion.enabled, false);
  assert.equal(result.similarArtistExpansion.reason, "Pure Search keeps similar-artist expansion disabled so the prompt remains the hard constraint.");
});

test("similar artist expansion honors an independent-pass disable flag", async () => {
  let graphCalled = false;
  const expansion = createExpansion({
    rabbitHoleGraph: {
      similarArtistsForSeeds: async () => {
        graphCalled = true;
        return [{ name: "Should Not Be Queried" }];
      }
    }
  });

  const result = await expansion.withSimilarArtistSeeds({
    request: "use my taste profile",
    skipSimilarArtistExpansion: "true",
    learnedTasteArtists: ["Anchor"]
  }, 8);

  assert.equal(graphCalled, false);
  assert.equal(result.similarArtistExpansion.enabled, false);
  assert.match(result.similarArtistExpansion.reason, /independent search pass/i);
});

test("baseArtistsForSimilarExpansion uses plan, reference, and now playing seeds", () => {
  const expansion = createExpansion({
    normalizeScoringMode: () => "similar"
  });

  const artists = expansion.baseArtistsForSimilarExpansion({
    llmSearchPlan: {
      seedArtists: ["Guy J"],
      candidateArtists: ["Khen"]
    },
    reference: "D-Nox - Seven Hours\nVarious Artists - Ignored",
    request: "like this",
    nowPlaying: { artist: "Ezequiel Arias" }
  }, 8);

  assert.deepEqual(artists, ["Guy J", "Khen", "D-Nox", "Ezequiel Arias"]);
});

test("withSimilarArtistSeeds reports missing Last.fm key with selected seeds", async () => {
  const expansion = createExpansion({
    buildDiscoveryProfile: () => ({ scoringMode: "explore" }),
    lastfm: { status: () => ({ enabled: true, apiKeyConfigured: false }) },
    tasteProfile: { getTopArtists: () => ["Guy J"] }
  });

  const result = await expansion.withSimilarArtistSeeds({ request: "progressive house" }, 8);

  assert.equal(result.similarArtistExpansion.enabled, false);
  assert.deepEqual(result.similarArtistExpansion.seeds, ["Guy J"]);
  assert.equal(result.similarArtistExpansion.reason, "LASTFM_API_KEY is missing.");
});

test("hard genre requests do not seed similar-artist expansion from learned taste", async () => {
  let graphCalled = false;
  const expansion = createExpansion({
    buildDiscoveryProfile: () => ({
      scoringMode: "taste-guided",
      hasExplicitDiscoveryIntent: true,
      requestedArtists: [],
      targetGenres: ["dubstep"],
      promptIntent: { genreConstraint: "hard" },
      isOmnivoreDiscovery: false
    }),
    tasteProfile: { getTopArtists: () => ["D-Nox", "Maze 28"] },
    rabbitHoleGraph: {
      similarArtistsForSeeds: async () => {
        graphCalled = true;
        return [{ name: "D-Nox" }];
      }
    }
  });

  const result = await expansion.withSimilarArtistSeeds({ genres: "dubstep" }, 30);

  assert.equal(graphCalled, false);
  assert.equal(result.similarArtistExpansion.enabled, false);
  assert.match(result.similarArtistExpansion.reason, /Hard genre requests keep learned taste as a soft ranking signal/);
});

test("withSimilarArtistSeeds appends fresh related artists and skips duplicates", async () => {
  let graphSeeds = null;
  const expansion = createExpansion({
    buildDiscoveryProfile: () => ({ scoringMode: "taste-guided", hasExplicitDiscoveryIntent: true, requestedArtists: [] }),
    tasteProfile: { getTopArtists: () => ["Guy J"] },
    rabbitHoleGraph: {
      similarArtistsForSeeds: async (seeds, _config, options) => {
        graphSeeds = { seeds, options };
        return [{ name: "Khen" }, { name: "Guy J" }, { name: "Eli Nissan" }];
      }
    }
  });

  const result = await expansion.withSimilarArtistSeeds({
    request: "deep progressive",
    similarArtistSeeds: ["Khen"]
  }, 10);

  assert.deepEqual(graphSeeds.seeds, ["Guy J"]);
  assert.equal(graphSeeds.options.limit, 8);
  assert.deepEqual(result.similarArtistSeeds, ["Khen", "Guy J", "Eli Nissan"]);
  assert.equal(result.similarArtistExpansion.enabled, true);
  assert.deepEqual(result.similarArtistExpansion.seeds, ["Guy J"]);
  assert.deepEqual(result.similarArtistExpansion.artists, ["Guy J", "Eli Nissan"]);
});

test("taste-profile expansion uses structured facet artists as Last.fm seeds", async () => {
  let graphSeeds = null;
  const expansion = createExpansion({
    buildDiscoveryProfile: () => ({
      scoringMode: "taste-guided",
      tasteProfileLed: true,
      promptIntent: { outsideTasteMode: "taste-profile" },
      requestedArtists: [],
      isOmnivoreDiscovery: false
    }),
    tasteProfile: { getTopArtists: () => ["Global Anchor"] },
    rabbitHoleGraph: {
      similarArtistsForSeeds: async (seeds) => {
        graphSeeds = seeds;
        return [{ name: "Fresh Branch" }];
      }
    }
  });

  const result = await expansion.withSimilarArtistSeeds({
    request: "use my taste",
    scoringMode: "taste-guided",
    learnedTasteArtists: ["Bass Anchor", "Progressive Anchor"]
  }, 20);

  assert.deepEqual(graphSeeds, ["Bass Anchor", "Progressive Anchor", "Global Anchor"]);
  assert.deepEqual(result.similarArtistSeeds, ["Fresh Branch"]);
  assert.equal(result.similarArtistExpansion.enabled, true);
});

test("taste-profile expansion rotates one artist from each facet before global anchors", async () => {
  let graphSeeds = null;
  const expansion = createExpansion({
    buildDiscoveryProfile: () => ({
      scoringMode: "taste-guided",
      tasteProfileLed: true,
      promptIntent: { outsideTasteMode: "taste-profile" },
      requestedArtists: []
    }),
    tasteProfile: { getTopArtists: () => ["Global Anchor"] },
    rabbitHoleGraph: {
      similarArtistsForSeeds: async (seeds) => {
        graphSeeds = seeds;
        return [];
      }
    }
  });

  await expansion.withSimilarArtistSeeds({
    request: "use my taste",
    learnedTasteArtists: ["Progressive Anchor", "Bass Anchor"],
    tasteFacets: [
      { artists: ["House Anchor"] },
      { artists: ["Bass Facet Anchor"] },
      { artists: ["Rock Anchor"] }
    ]
  }, 20);

  assert.deepEqual(graphSeeds, ["House Anchor", "Bass Facet Anchor", "Rock Anchor", "Progressive Anchor"]);
});
