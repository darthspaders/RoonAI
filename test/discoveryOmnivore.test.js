"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDiscoveryProfile,
  buildOmnivoreDiscoveryQueries,
  discoverTracks,
  rejectReason,
  scoreBreakdownFor,
  selectDiscoveryLaneCandidates
} = require("../src/discoveryEngine");

function candidate(index, overrides = {}) {
  return {
    artist: `Artist ${index}`,
    title: `Track ${index}`,
    album: `Album ${index}`,
    label: "",
    score: 95 - index,
    durationMs: 420000,
    tidal: { tidalUrl: `https://tidal.com/browse/track/${index}` },
    discoverySource: "TIDAL search",
    discoveryLane: "core",
    ...overrides
  };
}

test("any-genre discovery enables omnivore taste-bridge queries", () => {
  const options = {
    request: "Find me good music no matter what genre it is",
    count: "8",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildOmnivoreDiscoveryQueries(options, null, profile, 80);
  const serialized = queries.join("\n");

  assert.equal(profile.isOmnivoreDiscovery, true);
  assert.deepEqual(profile.targetGenres, []);
  assert.ok(queries.length >= 40);
  assert.match(serialized, /leftfield electronic|Ninja Tune/i);
  assert.match(serialized, /jazz fusion|Blue Note|ECM/i);
  assert.doesNotMatch(serialized, /dream pop|4AD|Domino|post rock|Constellation/i);
});

test("any-genre discovery ignores hallucinated model theme labels and artists", () => {
  const options = {
    request: "Find me 12 good tracks no matter what genre it is, avoid repeats, surprise me.",
    years: "2026",
    scoringMode: "taste-guided",
    llmSearchPlan: {
      intentRoute: "theme",
      themeTerms: ["new beginnings"],
      seedArtists: ["FKA twigs", "Tyler, the Creator", "Arlo Parks"],
      candidateLabels: ["4AD", "Domino", "XL Recordings"],
      searchQueries: ["new beginnings", "new beginnings indie electronic 2026"]
    }
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildOmnivoreDiscoveryQueries(options, null, profile, 40);

  assert.equal(profile.isOmnivoreDiscovery, true);
  assert.notEqual(profile.promptIntent.route, "theme");
  assert.deepEqual(profile.promptIntent.queryExpansions, []);
  assert.deepEqual(profile.seedArtists, []);
  assert.deepEqual(profile.requestedLabels, []);
  assert.match(queries.join("\n"), /Ninja Tune|Music From Memory|Blue Note/i);
  assert.doesNotMatch(queries.join("\n"), /new beginnings|4AD|Domino|FKA twigs|Tyler/i);
});

test("explicit indie wording opts into the vocal and band-adjacent omnivore lane", () => {
  const options = {
    request: "Find me good music in any genre, include some dream pop or indie electronic",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildOmnivoreDiscoveryQueries(options, null, profile, 90);

  assert.equal(profile.isOmnivoreDiscovery, true);
  assert.match(queries.join("\n"), /dream pop|4AD|Domino/i);
});

test("omnivore scoring rewards corroborated taste-bridge evidence and rejects drift", () => {
  const options = {
    request: "Find me 12 good tracks no matter what genre it is, avoid repeats, surprise me.",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const strongBridge = {
    artist: "Useful Leftfield Artist",
    title: "Useful Leftfield Track",
    album: "Useful Leftfield Album",
    label: "Ninja Tune",
    genre: "Electronic",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 390000,
    query: "Ninja Tune leftfield electronic 2026"
  };
  const drift = {
    artist: "Samantha Tonge",
    title: "Chapter 101 - The Time of My Life - The BRAND NEW escapist story of new beginnings and second chances from Samantha Tonge for 2026",
    album: "The Time of My Life - The BRAND NEW escapist story of new beginnings and second chances from Samantha Tonge for 2026 (Unabridged)",
    label: "Boldwood Books",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 181000,
    query: "new beginnings 2026"
  };

  assert.equal(rejectReason(strongBridge, options, profile), "");
  assert.ok(scoreBreakdownFor(strongBridge, options, null, profile).genreMatch >= 20);
  assert.match(rejectReason(drift, options, profile), /audiobook/i);
});

test("omnivore results need metadata corroboration, not just bridge words in the query", () => {
  const options = {
    request: "Find me 12 good tracks no matter what genre it is, avoid repeats, surprise me.",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const queryOnly = {
    artist: "Plain Result",
    title: "Untitled Motion",
    album: "Untitled Motion",
    label: "Plain Result",
    genre: "",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 410000,
    query: "Ninja Tune leftfield electronic 2026"
  };
  const corroborated = {
    ...queryOnly,
    artist: "Useful Leftfield Artist",
    title: "Useful Leftfield Track",
    album: "Useful Leftfield Album",
    label: "Ninja Tune",
    genre: "Electronic"
  };

  assert.match(rejectReason(queryOnly, options, profile), /metadata does not corroborate/i);
  assert.equal(rejectReason(corroborated, options, profile), "");
  assert.ok(scoreBreakdownFor(corroborated, options, null, profile).genreMatch > scoreBreakdownFor(queryOnly, options, null, profile).genreMatch);
});

test("omnivore quota keeps cross-genre candidates ahead of all-core monotony", () => {
  const options = {
    request: "Find 8 hidden gems in any genre",
    count: "8",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const core = Array.from({ length: 10 }, (_, index) => candidate(index, { score: 100 - index }));
  const omnivore = Array.from({ length: 4 }, (_, index) => candidate(100 + index, {
    artist: `Cross Genre Artist ${index}`,
    score: 70 - index,
    discoverySource: "Omnivore taste-bridge search",
    discoveryLane: "omnivore"
  }));

  const selected = selectDiscoveryLaneCandidates([...core, ...omnivore], 8, options, profile);

  assert.equal(selected.tracks.length, 8);
  assert.ok(selected.quota.targets.omnivore >= 2);
  assert.ok(selected.tracks.filter((track) => track.discoveryQuotaBucket === "omnivore").length >= 2);
});

test("omnivore selection spreads across bridge lanes instead of one dominant lane", () => {
  const options = {
    request: "Find 8 hidden gems in any genre, surprise me",
    count: "8",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const core = Array.from({ length: 5 }, (_, index) => candidate(index, { score: 68 - index }));
  const leftfield = Array.from({ length: 6 }, (_, index) => candidate(200 + index, {
    artist: `Leftfield Artist ${index}`,
    score: 100 - index,
    discoverySource: "Omnivore taste-bridge search",
    discoveryLane: "omnivore",
    discoveryOmnivoreLane: "leftfield-electronic"
  }));
  const bridgeVariety = [
    candidate(310, {
      artist: "Downtempo Artist",
      score: 74,
      discoverySource: "Omnivore taste-bridge search",
      discoveryLane: "omnivore",
      discoveryOmnivoreLane: "downtempo"
    }),
    candidate(311, {
      artist: "Breaks Artist",
      score: 73,
      discoverySource: "Omnivore taste-bridge search",
      discoveryLane: "omnivore",
      discoveryOmnivoreLane: "breaks"
    }),
    candidate(312, {
      artist: "Bass Artist",
      score: 72,
      discoverySource: "Omnivore taste-bridge search",
      discoveryLane: "omnivore",
      discoveryOmnivoreLane: "deep-bass"
    })
  ];

  const selected = selectDiscoveryLaneCandidates([...core, ...leftfield, ...bridgeVariety], 8, options, profile);
  const omnivoreLanes = selected.tracks
    .filter((track) => track.discoveryQuotaBucket === "omnivore")
    .map((track) => track.discoveryOmnivoreLane);

  assert.ok(new Set(omnivoreLanes).size >= 3);
  assert.ok(omnivoreLanes.filter((lane) => lane === "leftfield-electronic").length <= selected.quota.omnivoreLaneCap);
});

test("discoverTracks tags any-genre catalogue hits as omnivore results", async () => {
  const searchQueries = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks(query) {
      searchQueries.push(query);
      if (!/leftfield electronic|ninja tune/i.test(query)) return [];
      return [{
        artist: "Useful Leftfield Artist",
        title: "Useful Leftfield Track",
        album: "Useful Leftfield Album",
        label: "Ninja Tune",
        year: 2026,
        durationMs: 390000,
        tidalUrl: "https://tidal.com/browse/track/99001",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find me good music no matter what genre it is",
      count: "4",
      scoringMode: "taste-guided"
    },
    history: null,
    tasteProfile: null
  });

  assert.ok(searchQueries.some((query) => /leftfield electronic|ninja tune/i.test(query)));
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].discoveryLane, "omnivore");
  assert.equal(result.tracks[0].discoveryQuotaBucket, "omnivore");
  assert.match(result.tracks[0].reason, /cross-genre taste-bridge/i);
});
