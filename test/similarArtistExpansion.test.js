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
