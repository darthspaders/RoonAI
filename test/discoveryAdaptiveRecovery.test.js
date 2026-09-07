"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildAdaptiveRecoveryQueryFamilies,
  buildDiscoveryProfile,
  discoverTracks,
  laneQuotaShortfalls,
  shouldRunAdaptiveQueryRecovery
} = require("../src/discoveryEngine");

function validProgressiveTrack(index, query) {
  return {
    artist: `Recovery Scene Artist ${index}`,
    title: `Recovered Signal ${index}`,
    album: `Recovered Signal ${index}`,
    label: "Lost & Found",
    year: 2026,
    releaseDate: "2026-04-17",
    releaseEvidence: {
      albumDate: "2026-04-17",
      albumYear: 2026
    },
    durationMs: 468000,
    tidalUrl: `https://tidal.com/browse/track/980${index}`,
    query
  };
}

test("adaptive query recovery builds title and genre retry families", () => {
  const options = {
    request: "Find 5 underground progressive house tracks from 2026",
    genres: "progressive house",
    mood: "underground",
    years: "2026",
    count: "5",
    llmCandidates: [
      { artist: "Recovery Artist", title: "Moonlit Exit" }
    ]
  };
  const profile = buildDiscoveryProfile(options);
  const families = buildAdaptiveRecoveryQueryFamilies(options, null, profile, ["Guy J"], new Set());
  const serialized = JSON.stringify(families);

  assert.ok(families.some((family) => family.id === "exact-title"));
  assert.ok(families.some((family) => family.id === "genre-year"));
  assert.match(serialized, /Recovery Artist Moonlit Exit/);
  assert.match(serialized, /progressive house/i);
  assert.match(serialized, /2026/);
});

test("adaptive query recovery builds lane-specific branch families", () => {
  const genreOptions = {
    request: "Find 8 dark melodic techno discoveries from 2026",
    genres: "melodic techno",
    mood: "dark",
    years: "2026",
    count: "8",
    scoringMode: "explore",
    llmSearchPlan: {
      candidateArtists: ["Adriatique"],
      candidateLabels: ["Afterlife"]
    }
  };
  const genreProfile = buildDiscoveryProfile(genreOptions);
  const genreFamilies = buildAdaptiveRecoveryQueryFamilies(genreOptions, null, genreProfile, ["Tale Of Us"], new Set());
  const adjacent = genreFamilies.find((family) => family.id === "adjacent-lane");

  assert.ok(adjacent);
  assert.equal(adjacent.lane, "adjacent");
  assert.match(adjacent.queries.join(" "), /indie dance|dark disco|deep techno/i);

  const omnivoreOptions = {
    request: "Find 12 good tracks no matter what genre, avoid repeats, surprise me",
    count: "12",
    scoringMode: "explore"
  };
  const omnivoreProfile = buildDiscoveryProfile(omnivoreOptions);
  const omnivoreFamilies = buildAdaptiveRecoveryQueryFamilies(omnivoreOptions, null, omnivoreProfile, [], new Set());
  const omnivore = omnivoreFamilies.find((family) => family.id === "omnivore-branches");

  assert.ok(omnivore);
  assert.equal(omnivore.lane, "omnivore");
  assert.ok(omnivore.queries.length > 6);
});

test("adaptive query recovery triggers for thin or weak query pools", () => {
  assert.equal(shouldRunAdaptiveQueryRecovery({
    keptCount: 0,
    requestedCount: 5,
    usefulCandidateTarget: 40,
    queryYield: { attempted: 12, returned: 100, accepted: 0 },
    budgetAvailable: true
  }).run, true);

  assert.equal(shouldRunAdaptiveQueryRecovery({
    keptCount: 24,
    requestedCount: 5,
    usefulCandidateTarget: 40,
    queryYield: { attempted: 8, returned: 64, accepted: 14 },
    budgetAvailable: true
  }).run, false);

  const shortfalls = laneQuotaShortfalls(
    { core: 12, branch: 1, adjacent: 1 },
    { core: 40, branch: 0, adjacent: 1 }
  );
  const decision = shouldRunAdaptiveQueryRecovery({
    keptCount: 40,
    requestedCount: 8,
    usefulCandidateTarget: 40,
    queryYield: { attempted: 8, returned: 64, accepted: 24 },
    budgetAvailable: true,
    laneShortfalls: shortfalls
  });

  assert.equal(decision.run, true);
  assert.deepEqual(decision.lanes, ["branch"]);
  assert.match(decision.reason, /lane starvation: branch 0\/1/i);
});

test("adaptive query recovery rescues a valid candidate when normal search underfills", async () => {
  const searchCalls = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async verify() {
      return null;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      searchCalls.push(query);
      if (query === "Recovery Artist Moonlit Exit") {
        return [
          {
            ...validProgressiveTrack(1, query),
            artist: "Recovery Artist",
            title: "Moonlit Exit",
            album: "Moonlit Exit"
          },
          {
            artist: "Vocalo",
            title: "Progressive House Mix 2026 Vol.2",
            album: "Ocean Breeze Grooves, Smooth Progressive House Waves for Summer Nights & Beach Vibes",
            label: "Vocalo",
            year: 2026,
            releaseDate: "2026-10-01",
            releaseEvidence: {
              albumDate: "2026-10-01",
              albumYear: 2026
            },
            durationMs: 421000,
            tidalUrl: "https://tidal.com/browse/track/seo-1",
            query
          }
        ];
      }
      return [];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 2 underground progressive house tracks from 2026",
      genres: "progressive house",
      mood: "underground",
      years: "2026",
      count: "2",
      llmCandidates: [
        { artist: "Recovery Artist", title: "Moonlit Exit" }
      ],
      llmSearchPlan: {
        searchQueries: ["bad progressive house query"]
      }
    },
    history: null,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 1);
  assert.match(result.tracks[0].discoverySource, /Adaptive recovery: Exact title retry/);
  assert.equal(result.verification.queryRecovery.triggered, true);
  assert.equal(result.verification.queryRecovery.accepted, 1);
  assert.ok(result.verification.poolDiagnostics.queryRecovery.triggered);
  const exactTitleFamily = result.verification.poolDiagnostics.queryRecovery.families.find((family) => family.id === "exact-title");
  assert.ok(exactTitleFamily);
  assert.equal(exactTitleFamily.seoRejects, 1);
  assert.ok(searchCalls.includes("Recovery Artist Moonlit Exit"));
});

test("adaptive query recovery stays off when the initial pool is healthy", async () => {
  let firstSearch = true;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (!firstSearch) return [];
      firstSearch = false;
      return Array.from({ length: 24 }, (_, index) => validProgressiveTrack(index + 1, query));
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 3 underground progressive house tracks from 2026",
      genres: "progressive house",
      mood: "underground",
      years: "2026",
      count: "3",
      llmSearchPlan: {
        searchQueries: ["progressive house 2026"]
      }
    },
    history: null,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 3);
  assert.equal(result.verification.queryRecovery.triggered, false);
});
