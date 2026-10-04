"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDiscoveryProfile,
  buildSearchQueries,
  discoverTracks,
  electronicDomainDriftReason,
  queryGenerationInfo,
  semanticOnlyQueryFor
} = require("../src/discoveryEngine");

function broadEdmOptions(overrides = {}) {
  return {
    request: "Queue me 20 badass tracks from any EDM lane",
    count: 20,
    llmSearchPlan: {
      candidateArtists: ["D-Nox", "Beckers", "Maze 28", "Space 92", "HI-LO"],
      candidateLabels: ["Drumcode", "KNTXT"],
      searchQueries: [
        "driving music underground",
        "driving music electronic",
        "night drive",
        "Space 92",
        "Drumcode"
      ]
    },
    ...overrides
  };
}

test("broad EDM intent is a hard electronic parent domain, not an artist seed", () => {
  const profile = buildDiscoveryProfile(broadEdmOptions());

  assert.equal(profile.isBroadElectronicDiscovery, true);
  assert.equal(profile.isOmnivoreDiscovery, false);
  assert.ok(profile.targetGenres.some((term) => /^edm$/i.test(term)));
  assert.equal(profile.requestedArtists.includes("any EDM lane"), false);
  assert.equal(profile.promptIntent.route, "genre");
  assert.equal(profile.intent.genreConstraint, "hard");
});

test("plain EDM option suppresses model activity phrases before query selection", () => {
  const options = broadEdmOptions({
    request: "Queue me 20 badass tracks",
    genres: "EDM",
    llmSearchPlan: {
      activityTerms: ["driving", "peak-time"],
      searchQueries: ["driving music underground", "night drive"]
    }
  });
  const profile = buildDiscoveryProfile(options);

  assert.equal(profile.promptIntent.route, "genre");
  assert.deepEqual(profile.promptIntent.activityTerms || [], []);
  assert.equal(semanticOnlyQueryFor("driving music underground", profile), true);
});

test("broad EDM candidate generation leads with trusted artists and labels", () => {
  const options = broadEdmOptions();
  const profile = buildDiscoveryProfile(options);
  const queries = buildSearchQueries(options, null, profile);

  assert.ok(queries.length > 0);
  assert.match(queries[0], /Space 92|HI-LO|Eli Brown|Layton Giordani|UMEK/i);
  assert.ok(queries.some((query) => /Drumcode|KNTXT/i.test(query)));
  assert.ok(!queries.some((query) => /driving music|night drive|road trip/i.test(query)));
  assert.ok(queries.every((query) => !semanticOnlyQueryFor(query, profile)));

  const first = queryGenerationInfo(queries[0], profile, options);
  assert.equal(first.seedType, "artist");
  assert.equal(first.priorityTier, 10);
});

test("taste-profile discovery uses learned anchors instead of turning the prose request into queries", () => {
  const options = {
    request: "find tracks that match my current taste profile, but go deeper, less obvious, and avoid repeats",
    genres: "",
    mood: "",
    scoringMode: "taste-guided",
    learnedTasteArtists: ["Guy J", "Mersiv", "The Crystal Method"],
    learnedTasteLabels: ["Anjunadeep", "Wakaan"]
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildSearchQueries(options, null, profile);

  assert.equal(profile.tasteProfileLed, true);
  assert.equal(profile.primaryTarget, "");
  assert.deepEqual(queries.slice(0, 3), ["Guy J", "Mersiv", "The Crystal Method"]);
  assert.ok(queries.some((query) => /^Anjunadeep(?: \d{4})?$/i.test(query)));
  assert.ok(queries.some((query) => /^Wakaan(?: \d{4})?$/i.test(query)));
  assert.ok(queries.some((query) => /^Guy J \d{4}$/i.test(query)));
  assert.equal(queries.some((query) => /match my current taste profile|go deeper|avoid repeats/i.test(query)), false);
  assert.equal(queryGenerationInfo(queries[0], profile, options).seedType, "artist");
  assert.equal(queryGenerationInfo(queries[0], profile, options).source, "learned taste artist seed");
});

test("neutral standby taste reservoirs suppress operational vibe language", () => {
  const profile = buildDiscoveryProfile({
    request: "Find tracks that fit my current Rabbit Hole taste profile. Standby pool: prioritize fresh adjacent artists and low-exposure catalog sources.",
    standbyPool: "true",
    standbyTasteReservoir: "true",
    learnedTasteArtists: ["Guy J"]
  });

  assert.equal(profile.standbyTasteReservoir, true);
  assert.deepEqual(profile.vibeTerms, []);
  assert.equal(profile.intent.requestedVibe, "not specified");
});

test("standby taste reservoirs crawl artist albums when the raw target is large", async () => {
  const albumCalls = [];
  const albumTrackOptions = [];
  const fakeTidal = {
    isConfigured: () => true,
    async getArtistAlbums(artist, options) {
      albumCalls.push(artist);
      assert.equal(options.limit, 12);
      return [{
        id: "anchor-album",
        artist,
        title: "New Album",
        label: "Anjunadeep",
        year: 2026,
        releaseDate: "2026-05-01"
      }];
    },
    async getAlbumTracks(_album, options) {
      albumTrackOptions.push(options);
      assert.equal(options.limit, 5);
      return [{
        artist: "Anchor Artist",
        title: "Long Form Signal",
        album: "New Album",
        label: "Anjunadeep",
        year: 2026,
        releaseDate: "2026-05-01",
        releaseEvidence: { albumYear: 2026, albumDate: "2026-05-01" },
        durationMs: 390000,
        tidalUrl: "https://tidal.com/browse/track/anchor-album"
      }];
    },
    async searchTracks() {
      return [];
    }
  };

  await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "use my taste profile",
      count: 25,
      standbyPool: "true",
      learnedTasteArtists: ["Anchor Artist"],
      learnedTasteLabels: ["Anjunadeep"]
    },
    history: null
  });

  assert.ok(albumCalls.some((artist) => /^anchor artist$/i.test(artist)));
  assert.ok(albumTrackOptions.length > 0);
});

test("standby album expansion rotates past artists already crawled in the refresh", async () => {
  const albumCalls = [];
  const fakeTidal = {
    isConfigured: () => true,
    async getArtistAlbums(artist) {
      albumCalls.push(artist);
      return [];
    },
    async searchTracks() {
      return [];
    }
  };

  await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "use my taste profile",
      count: 25,
      standbyPool: "true",
      learnedTasteArtists: ["Anchor Artist", "Second Artist"],
      discoveryExcludedExpansionArtists: ["Anchor Artist"]
    },
    history: null
  });

  assert.equal(albumCalls.some((artist) => /^anchor artist$/i.test(artist)), false);
  assert.ok(albumCalls.some((artist) => /^second artist$/i.test(artist)));
});

test("taste-profile plan-only refills reject prose fragments without a real anchor", () => {
  const options = {
    request: "Clean standby taste-profile refill pass: use learned artist and label anchors as soft multi-facet seeds.",
    standbyPool: "true",
    standbyTasteReservoir: "true",
    planOnlySearch: "true",
    learnedTasteArtists: ["Guy J"],
    learnedTasteLabels: ["Anjunadeep"],
    llmSearchPlan: {
      searchQueries: ["anchors as soft multi-facet seeds", "Guy J", "Anjunadeep"],
      candidateArtists: ["Guy J"],
      candidateLabels: ["Anjunadeep"]
    }
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildSearchQueries(options, null, profile);

  assert.deepEqual(queries, ["Guy J", "Anjunadeep"]);
});

test("taste-profile excludes an external identity that failed facet validation", () => {
  const options = {
    request: "use my taste profile",
    scoringMode: "taste-guided",
    tasteSeedExclusions: ["John Johnson"],
    learnedTasteArtists: ["John Johnson", "Lane 8"],
    learnedTasteLabels: ["Anjunadeep"]
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildSearchQueries(options, null, profile);

  assert.equal(queries.some((query) => /John Johnson/i.test(query)), false);
  assert.ok(queries.some((query) => /^Lane 8(?: \d{4})?$/i.test(query)));
});

test("hard Dubstep keeps compatible bass anchors and excludes unrelated learned artists", () => {
  const options = {
    request: "Find 30 dark dubstep tracks",
    genres: "dubstep",
    count: 30,
    llmSearchPlan: {
      candidateArtists: [
        "D-Nox",
        "Beckers",
        "Maze 28",
        "Jeremy Olander",
        "Quivver",
        "Tape B",
        "Of The Trees",
        "Alix Perez"
      ],
      searchQueries: [
        "D-Nox",
        "night drive dubstep",
        "Tape B",
        "Alix Perez"
      ]
    }
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildSearchQueries(options, null, profile);

  assert.ok(queries.some((query) => /^Tape B$/i.test(query)));
  assert.ok(queries.some((query) => /^Of The Trees$/i.test(query)));
  assert.ok(queries.some((query) => /^Alix Perez$/i.test(query)));
  assert.ok(!queries.some((query) => /D-Nox|Beckers|Maze 28|Jeremy Olander|Quivver/i.test(query)));
  assert.ok(!queries.some((query) => /night drive|road trip|driving music/i.test(query)));
});

test("EDM parent-domain gate rejects non-electronic catalog results before scoring", () => {
  const options = { genres: "EDM" };
  const profile = buildDiscoveryProfile(options);

  assert.match(electronicDomainDriftReason({
    artist: "Iron Man Soundtrack",
    title: "Driving with the Top Down",
    album: "Iron Man",
    genre: ["Soundtrack"]
  }, options, profile), /EDM parent domain/i);

  assert.equal(electronicDomainDriftReason({
    artist: "Space 92",
    title: "The Game",
    genre: ["Electronic"]
  }, options, profile), "");
});

test("query-selection debug diagnostics expose generation provenance", async () => {
  const searchOrder = [];
  const originalInfo = console.info;
  console.info = () => {};
  let result;
  try {
    result = await discoverTracks({
      tidal: {
        isConfigured: () => true,
        async searchTracks(query) {
          searchOrder.push(query);
          return [];
        }
      },
      options: {
        ...broadEdmOptions(),
        count: 1,
        debugQuerySelection: true
      },
      history: null
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(result.tracks.length, 0);
  assert.ok(searchOrder.length > 0);
  const diagnostic = result.verification.querySelectionDiagnostics[0];
  assert.equal(diagnostic.query, searchOrder[0]);
  assert.ok(["artist", "label", "genre", "exploratory", "semantic"].includes(diagnostic.seedType));
  assert.equal(typeof diagnostic.priorityTier, "number");
  assert.equal(typeof diagnostic.budgetPosition, "number");
  assert.equal(typeof diagnostic.historicalYieldContribution, "number");
  assert.equal(typeof diagnostic.currentIntentContribution, "number");
  assert.equal(typeof diagnostic.tasteContribution, "number");
  assert.equal(typeof diagnostic.budgetCost, "number");
});

test("catalog pagination is preserved in query-selection diagnostics", async () => {
  const originalInfo = console.info;
  console.info = () => {};
  let result;
  try {
    result = await discoverTracks({
      tidal: {
        isConfigured: () => true,
        async searchTracks(query, options) {
          options.onPagination({
            source: "searchTracks",
            anchor: query,
            query,
            requestedCursor: "cursor-one",
            requestedPage: null,
            nextCursor: "cursor-two",
            nextPage: null,
            returnedCount: 4,
            duplicateCount: 1,
            acceptedCount: 3,
            rejectedCount: 0,
            budgetCost: 1,
            progressResumed: true
          });
          return [];
        }
      },
      options: {
        ...broadEdmOptions(),
        count: 1,
        debugQuerySelection: true
      },
      history: null
    });
  } finally {
    console.info = originalInfo;
  }

  const diagnostic = result.verification.querySelectionDiagnostics.find((item) => item.catalogSource === "searchTracks");
  assert.ok(diagnostic);
  assert.equal(diagnostic.catalogAnchor, diagnostic.query);
  assert.equal(diagnostic.catalogRequestedCursor, "cursor-one");
  assert.equal(diagnostic.catalogNextCursor, "cursor-two");
  assert.equal(diagnostic.catalogReturnedCount, 4);
  assert.equal(diagnostic.catalogDuplicateCount, 1);
  assert.equal(diagnostic.catalogAcceptedCount, 3);
  assert.equal(diagnostic.catalogRejectedCount, 0);
  assert.equal(diagnostic.catalogBudgetCost, 1);
  assert.equal(diagnostic.catalogProgressResumed, true);
  assert.equal(result.verification.catalogPagination.length > 0, true);
});

test("hard-duration genre anchors survive historical low-yield pruning", async () => {
  const searchOrder = [];
  const queryYieldTracker = {
    rankQueries(queries) {
      const protectedQuery = queries.find((query) => query === "progressive trance");
      const remaining = queries.filter((query) => query !== protectedQuery);
      return {
        queries: remaining,
        ranked: remaining.map((query) => ({ query, score: 0 })),
        pruned: protectedQuery
          ? [{ query: protectedQuery, quality: -8, attempts: 3, rejected: 18, seoRejects: 18 }]
          : []
      };
    }
  };

  const result = await discoverTracks({
    tidal: {
      isConfigured: () => true,
      async searchTracks(query) {
        searchOrder.push(query);
        return [];
      }
    },
    options: {
      request: "Find 1 progressive trance track at least 7 minutes",
      genres: "progressive trance",
      count: 1,
      llmSearchPlan: { searchQueries: ["progressive trance", "unrelated semantic phrase"] }
    },
    history: null,
    queryYieldTracker
  });

  assert.equal(result.tracks.length, 0);
  assert.ok(searchOrder.includes("progressive trance"));
  assert.equal(result.verification.queryYield.prunedCount, 0);
  assert.ok(result.verification.querySelectionDiagnostics.some((item) => (
    item.query === "progressive trance" &&
    item.historicalYieldContribution === -8
  )));
});

test("hard-duration trusted label branches survive historical low-yield pruning", async () => {
  const searchOrder = [];
  const queryYieldTracker = {
    rankQueries(queries) {
      return {
        queries: [],
        ranked: [],
        pruned: queries.map((query) => ({
          query,
          quality: -12,
          attempts: 4,
          rejected: 24,
          seoRejects: 24
        }))
      };
    }
  };

  await discoverTracks({
    tidal: {
      isConfigured: () => true,
      async searchTracks(query) {
        searchOrder.push(query);
        return [];
      }
    },
    options: {
      request: "Find 1 progressive trance track at least 7 minutes",
      genres: "progressive trance",
      count: 1,
      minDurationMinutes: 7
    },
    history: null,
    queryYieldTracker
  });

  assert.ok(searchOrder.some((query) => /JOOF Recordings|Pure Trance|Coldharbour/i.test(query)));
});

test("progressive trance planning keeps trusted scene labels in the hard-duration lane", () => {
  const options = {
    request: "Find 10 progressive trance tracks at least 7 minutes",
    genres: "progressive trance",
    count: 10,
    minDurationMinutes: 7
  };
  const profile = buildDiscoveryProfile(options);
  const queries = buildSearchQueries(options, null, profile);

  assert.equal(profile.isProgressiveTranceTarget, true);
  assert.equal(profile.isProgressiveTarget, false);
  for (const label of ["JOOF Recordings", "Pure Trance", "Coldharbour", "Anjunabeats", "FSOE"]) {
    const normalizedLabel = label.toLowerCase();
    assert.ok(queries.some((query) => {
      const normalizedQuery = query.toLowerCase();
      return normalizedQuery === normalizedLabel || normalizedQuery === `${normalizedLabel} progressive trance`;
    }), `${label} branch was not planned`);
  }
  assert.equal(queries.some((query) => /^Sudbeat(?: progressive trance)?$/i.test(query)), false);
});

test("progressive trance uses the specialized planner order without changing the hard genre", async () => {
  const searched = [];
  const options = {
    request: "Find 10 progressive trance tracks at least 7 minutes",
    genres: "progressive trance",
    count: 10,
    minDurationMinutes: 7,
    mood: "hypnotic, melodic, driving",
    energy: "driving",
    vocals: "minimal"
  };
  const profile = buildDiscoveryProfile(options);

  const result = await discoverTracks({
    tidal: {
      isConfigured: () => true,
      async searchTracks(query) {
        searched.push(query);
        return [];
      }
    },
    options,
    history: null
  });

  assert.equal(profile.targetGenres[0], "progressive trance");
  assert.equal(profile.isProgressiveTranceTarget, true);
  assert.equal(profile.isProgressiveTarget, false);
  assert.equal(profile.isProgressivePlanningTarget, true);
  assert.equal(result.verification.plannerRoute, "specialized-progressive-trance");
  assert.equal(result.verification.profile.isProgressiveTranceTarget, true);
  assert.equal(result.verification.profile.isProgressiveTarget, false);
  assert.equal(result.verification.profile.isProgressivePlanningTarget, true);
  assert.ok(searched.length > 0);
  assert.ok(searched.slice(0, 4).every((query) => (
    queryGenerationInfo(query, profile, options).seedType === "artist"
  )));
  assert.equal(searched[4], "progressive trance");
  assert.ok(searched.some((query) => /Anjunabeats progressive trance/i.test(query)));
  assert.ok(result.verification.first10ExecutedQueries.length > 0);
  assert.equal(result.verification.first10ExecutedQueries[0].query, searched[0]);
  assert.equal(result.verification.first10ExecutedQueries[0].queryType, "artist");
});

test("per-refresh query exclusions move a refill to the next anchor family", async () => {
  const searched = [];
  const result = await discoverTracks({
    tidal: {
      isConfigured: () => true,
      async searchTracks(query) {
        searched.push(query);
        return [];
      }
    },
    options: {
      request: "use my taste profile",
      scoringMode: "taste-guided",
      learnedTasteArtists: ["Guy J", "Mersiv", "The Crystal Method"],
      learnedTasteLabels: ["Anjunadeep"],
      discoveryExcludedQueries: ["Guy J", "Mersiv"]
    },
    history: null
  });

  assert.equal(result.tracks.length, 0);
  assert.ok(searched.length > 0);
  assert.equal(searched.some((query) => /^(Guy J|Mersiv)$/i.test(query)), false);
  assert.ok(searched.some((query) => /The Crystal Method|Anjunadeep/i.test(query)));
});
