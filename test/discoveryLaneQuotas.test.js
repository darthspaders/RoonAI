"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  artistDiversityAdjustmentFor,
  buildDiscoveryProfile,
  defaultPerRunArtistCap,
  noveltyBudgetFor,
  recentSuggestionNoveltyPenaltyFor,
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

test("lane quotas reserve slots for valid adjacent, label, and taste candidates", () => {
  const options = {
    request: "Find 8 adventurous electronic discoveries",
    count: "8",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const core = Array.from({ length: 10 }, (_, index) => candidate(index, { score: 100 - index }));
  const pool = [
    ...core,
    candidate(100, {
      score: 62,
      discoveryLane: "adjacent",
      discoverySource: "Adjacent lane search"
    }),
    candidate(101, {
      score: 61,
      label: "Small Room",
      discoverySource: "TIDAL search"
    }),
    candidate(102, {
      score: 60,
      discoverySource: "Liked artist expansion"
    })
  ];

  const selected = selectDiscoveryLaneCandidates(pool, 8, options, profile);
  const buckets = selected.tracks.map((track) => track.discoveryQuotaBucket);

  assert.equal(selected.tracks.length, 8);
  assert.ok(buckets.includes("adjacent"));
  assert.ok(buckets.includes("label"));
  assert.ok(buckets.includes("taste"));
  assert.equal(selected.quota.selected.adjacent, 1);
  assert.equal(selected.quota.selected.label, 1);
  assert.equal(selected.quota.selected.taste, 1);
});

test("small Taste Guided requests still reserve branch-out slots", () => {
  const options = {
    request: "Find 5 progressive house tracks this year",
    genres: "progressive house",
    years: "2026",
    count: "5",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const repeatedCore = Array.from({ length: 5 }, (_, index) => candidate(index, {
    artist: "Known Cluster",
    score: 100 - index
  }));
  const branchPool = [
    candidate(100, {
      artist: "New Label Artist",
      score: 71,
      label: "Small Room",
      discoverySource: "TIDAL search"
    }),
    candidate(101, {
      artist: "Neighbor Lane Artist",
      score: 70,
      discoveryLane: "adjacent",
      discoverySource: "Adjacent lane search"
    }),
    candidate(102, {
      artist: "Taste Adjacent Artist",
      score: 69,
      discoverySource: "Liked artist expansion"
    }),
    candidate(103, {
      artist: "Fresh Scene Artist",
      score: 68
    })
  ];

  const selected = selectDiscoveryLaneCandidates([...repeatedCore, ...branchPool], 5, options, profile);
  const buckets = selected.tracks.map((track) => track.discoveryQuotaBucket);
  const artists = new Set(selected.tracks.map((track) => track.artist));

  assert.equal(selected.tracks.length, 5);
  assert.equal(artists.size, 5);
  assert.ok(buckets.includes("label"));
  assert.ok(buckets.includes("adjacent"));
  assert.ok(buckets.includes("taste"));
});

test("Taste Guided separates similar branch sources from liked-artist taste fill", () => {
  const options = {
    request: "Find 8 progressive house discoveries this year",
    genres: "progressive house",
    years: "2026",
    count: "8",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const core = Array.from({ length: 8 }, (_, index) => candidate(index, {
    score: 98 - index
  }));
  const liked = Array.from({ length: 4 }, (_, index) => candidate(200 + index, {
    artist: `Liked Artist ${index}`,
    score: 99 - index,
    discoverySource: "Liked artist expansion"
  }));
  const similarBranch = candidate(300, {
    artist: "Adjacent Similar Artist",
    score: 63,
    discoverySource: "Similar artist"
  });

  const selected = selectDiscoveryLaneCandidates([...liked, ...core, similarBranch], 8, options, profile);
  const buckets = selected.tracks.map((track) => track.discoveryQuotaBucket);

  assert.equal(selected.tracks.length, 8);
  assert.equal(selected.quota.targets.branch, 1);
  assert.ok(buckets.includes("branch"));
  assert.ok(selected.tracks.some((track) => track.artist === "Adjacent Similar Artist"));
  assert.ok((selected.quota.selected.taste || 0) <= selected.quota.max.taste);
});

test("small Taste Guided requests cap repeated collaborator artists", () => {
  const options = {
    request: "Find 5 progressive house tracks this year",
    genres: "progressive house",
    years: "2026",
    count: "5",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const pool = [
    candidate(1, { artist: "Sunlounger, Zara Taylor, Forty Cats", score: 95 }),
    candidate(2, { artist: "Forty Cats", title: "Second Shared Artist", score: 94 }),
    candidate(3, { artist: "Nicolas Viana", score: 93 }),
    candidate(4, { artist: "Alisha, Kostya Outta, Greta Meier", score: 92 }),
    candidate(5, { artist: "Ezequiel Arias", score: 91 }),
    candidate(6, { artist: "Kamilo Sanclemente", score: 90 })
  ];

  const selected = selectDiscoveryLaneCandidates(pool, 5, options, profile);
  const fortyCatsCount = selected.tracks.filter((track) => /forty cats/i.test(track.artist)).length;

  assert.equal(selected.tracks.length, 5);
  assert.equal(fortyCatsCount, 1);
});

test("Explore count requests keep broad artist spread instead of repeating familiar anchors", () => {
  const options = {
    request: "Find 20 psychedelic cosmic hypnotic progressive house discoveries",
    genres: "progressive house",
    mood: "psychedelic cosmic hypnotic",
    count: "20",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const familiarRun = Array.from({ length: 8 }, (_, index) => candidate(index, {
    artist: "Repeated Anchor",
    title: `Known Pull ${index}`,
    album: `Known Pull ${index}`,
    score: 100 - index,
    scoreBreakdown: {
      artistDiversityAdjustment: -12,
      artistDiversityReasons: ["Repeated Anchor surfaced 12 prior tracks"]
    }
  }));
  const freshRun = Array.from({ length: 25 }, (_, index) => candidate(100 + index, {
    artist: `Fresh Artist ${index}`,
    title: `Fresh Signal ${index}`,
    album: `Fresh Signal ${index}`,
    score: 88 - index
  }));

  const selected = selectDiscoveryLaneCandidates([...familiarRun, ...freshRun], 20, options, profile);

  assert.equal(selected.tracks.length, 20);
  assert.equal(selected.tracks.filter((track) => track.artist === "Repeated Anchor").length, 1);
  assert.equal(new Set(selected.tracks.map((track) => track.artist)).size, 20);
});

test("recent suggestion novelty tax downranks overused labels and sources before selection", () => {
  const options = {
    request: "Find adventurous electronic discoveries",
    count: "1",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const now = Date.now();
  const history = {
    artistExposureFor() {
      return null;
    },
    labelExposureFor() {
      return {
        label: "Overused Label",
        trackCount: 5,
        shownCount: 7,
        lastShownAt: now - 1000,
        recent: true
      };
    },
    sourceExposureFor() {
      return {
        source: "Branch source search / branch",
        trackCount: 8,
        shownCount: 9,
        lastShownAt: now - 1000,
        recent: true
      };
    }
  };
  const stalePocket = candidate(1, {
    artist: "Stale Pocket Artist",
    label: "Overused Label",
    discoverySource: "Branch source search",
    discoveryLane: "branch",
    score: 99
  });
  const freshPocket = candidate(2, {
    artist: "Fresh Pocket Artist",
    label: "New Label",
    discoverySource: "Branch source search",
    discoveryLane: "branch",
    score: 91
  });
  const penalty = recentSuggestionNoveltyPenaltyFor(stalePocket, history, profile, options, now);
  const selected = selectDiscoveryLaneCandidates([
    { ...stalePocket, recentSuggestionPenalty: penalty.value },
    freshPocket
  ], 1, options, profile);

  assert.ok(penalty.components.label > 0);
  assert.ok(penalty.components.source > 0);
  assert.equal(selected.tracks[0].artist, "Fresh Pocket Artist");
});

test("per-run label and source caps prevent one pocket from flooding discovery results", () => {
  const options = {
    request: "Find 8 adventurous electronic discoveries",
    count: "8",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const floodLabel = Array.from({ length: 6 }, (_, index) => candidate(300 + index, {
    artist: `Flood Label Artist ${index}`,
    title: `Flood Label Track ${index}`,
    album: `Flood Label Album ${index}`,
    label: "Flood Label",
    score: 100 - index,
    discoverySource: "TIDAL search"
  }));
  const floodSource = Array.from({ length: 6 }, (_, index) => candidate(400 + index, {
    artist: `Flood Source Artist ${index}`,
    title: `Flood Source Track ${index}`,
    album: `Flood Source Album ${index}`,
    label: `Flood Source Label ${index}`,
    score: 94 - index,
    discoverySource: "Branch source search",
    discoveryLane: "branch"
  }));
  const freshCore = Array.from({ length: 8 }, (_, index) => candidate(500 + index, {
    artist: `Fresh Core Artist ${index}`,
    title: `Fresh Core Track ${index}`,
    album: `Fresh Core Album ${index}`,
    score: 80 - index
  }));

  const selected = selectDiscoveryLaneCandidates([...floodLabel, ...floodSource, ...freshCore], 8, options, profile);
  const floodLabelCount = selected.tracks.filter((track) => track.label === "Flood Label").length;
  const floodSourceCount = selected.tracks.filter((track) => track.discoverySource === "Branch source search").length;

  assert.equal(selected.tracks.length, 8);
  assert.equal(selected.quota.labelCap, 2);
  assert.equal(selected.quota.sourceCap, 2);
  assert.ok(floodLabelCount <= selected.quota.labelCap);
  assert.ok(floodSourceCount <= selected.quota.sourceCap);
  assert.ok(Number(selected.quota.capHeld?.total || 0) > 0);
  assert.ok(selected.quota.capHeld.label.some((item) => item.label === "Flood Label"));
  assert.ok(selected.quota.capHeld.source.some((item) => /Branch source search/.test(item.label)));
  assert.ok(selected.tracks.some((track) => /^Fresh Core Artist/.test(track.artist)));
});

test("source caps relax partially when a discovery pool would otherwise underfill", () => {
  const options = {
    request: "Find 5 adventurous electronic discoveries",
    count: "5",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const sourcePocket = Array.from({ length: 6 }, (_, index) => candidate(600 + index, {
    artist: `Single Source Artist ${index}`,
    title: `Single Source Track ${index}`,
    album: `Single Source Album ${index}`,
    label: `Single Source Label ${index}`,
    score: 100 - index,
    discoverySource: "Branch source search",
    discoveryLane: "branch"
  }));

  const selected = selectDiscoveryLaneCandidates(sourcePocket, 5, options, profile);
  const sourceCount = selected.tracks.filter((track) => track.discoverySource === "Branch source search").length;

  assert.equal(selected.quota.sourceCap, 2);
  assert.ok(selected.quota.labelSourceRelaxed > 0);
  assert.equal(sourceCount, selected.tracks.length);
  assert.ok(sourceCount > selected.quota.sourceCap);
  assert.ok(sourceCount < 5);
  assert.ok(Number(selected.quota.capHeld?.total || 0) > 0);
  const selectedLabels = new Set(selected.tracks.map((track) => `${track.artist} - ${track.title}`));
  assert.ok(selected.quota.capHeld.source.every((item) => !selectedLabels.has(item.candidate)));
});

test("lane quotas backfill from core when exploratory buckets are unavailable", () => {
  const options = {
    request: "Find 5 electronic discoveries",
    count: "5",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const pool = Array.from({ length: 5 }, (_, index) => candidate(index, { score: 90 - index }));

  const selected = selectDiscoveryLaneCandidates(pool, 5, options, profile);

  assert.equal(selected.tracks.length, 5);
  assert.deepEqual([...new Set(selected.tracks.map((track) => track.discoveryQuotaBucket))], ["core"]);
});

test("Pure Search does not reserve taste-led quota slots", () => {
  const options = {
    request: "Find 8 electronic discoveries",
    count: "8",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);
  const core = Array.from({ length: 8 }, (_, index) => candidate(index, { score: 100 - index }));
  const taste = candidate(200, {
    score: 99,
    discoverySource: "Liked artist expansion"
  });

  const selected = selectDiscoveryLaneCandidates([taste, ...core], 8, options, profile);

  assert.equal(selected.quota.targets.taste, 0);
  assert.equal(selected.tracks.some((track) => track.discoveryQuotaBucket === "taste"), false);
});

test("calibration risk can remove a reserved lane quota and backfill clean tracks", () => {
  const options = {
    request: "Find 8 adventurous electronic discoveries",
    count: "8",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const core = Array.from({ length: 10 }, (_, index) => candidate(index, { score: 90 - index }));
  const riskyAdjacent = candidate(300, {
    score: 99,
    discoveryLane: "adjacent",
    discoverySource: "Adjacent lane search"
  });
  const calibration = {
    lanes: [{
      lane: "adjacent",
      total: 3,
      modelMisses: 3,
      badBoosts: 2,
      promptMismatches: 2
    }]
  };

  const selected = selectDiscoveryLaneCandidates([riskyAdjacent, ...core], 8, options, profile, calibration);

  assert.equal(selected.tracks.length, 8);
  assert.equal(selected.quota.targets.adjacent, 0);
  assert.ok(selected.quota.calibrationAdjustments.some((item) => item.bucket === "adjacent"));
  assert.equal(selected.tracks.some((track) => track.discoveryQuotaBucket === "adjacent"), false);
  assert.equal(selected.tracks.filter((track) => track.discoveryQuotaBucket === "core").length, 8);
});

test("artist diversity downranks repeatedly surfaced artists in discovery modes", () => {
  const options = {
    request: "Find progressive house discoveries",
    genres: "progressive house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const history = {
    artistExposureFor() {
      return {
        artist: "Hobin Rude",
        trackCount: 6,
        shownCount: 9,
        recent: true
      };
    }
  };

  const adjustment = artistDiversityAdjustmentFor(
    { artist: "Hobin Rude", title: "Fresh Branch" },
    history,
    profile,
    options
  );

  assert.ok(adjustment.value < 0);
  assert.match(adjustment.reasons.join(" "), /surfaced 6 prior tracks/i);
});

test("artist diversity does not fight Similar Mode or exact requested artist searches", () => {
  const history = {
    artistExposureFor() {
      return {
        artist: "Hobin Rude",
        trackCount: 12,
        shownCount: 18,
        recent: true
      };
    }
  };
  const similarOptions = {
    request: "Find tracks like Hobin Rude",
    scoringMode: "similar"
  };
  const similarProfile = buildDiscoveryProfile(similarOptions);
  const pureOptions = {
    request: "Find tracks by Hobin Rude",
    scoringMode: "pure"
  };
  const pureProfile = {
    ...buildDiscoveryProfile(pureOptions),
    requestedArtists: ["Hobin Rude"]
  };

  assert.equal(artistDiversityAdjustmentFor({ artist: "Hobin Rude" }, history, similarProfile, similarOptions).value, 0);
  assert.equal(artistDiversityAdjustmentFor({ artist: "Hobin Rude" }, history, pureProfile, pureOptions).value, 0);
});

test("Taste Guided does not repeat one artist just to fill a thin discovery run", () => {
  const options = {
    request: "Find 5 progressive house discoveries this year",
    genres: "progressive house",
    years: "2026",
    count: "5",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const repeated = Array.from({ length: 6 }, (_, index) => candidate(index, {
    artist: "Repeated Favorite",
    title: `Known Shape ${index}`,
    score: 100 - index
  }));
  const fresh = candidate(100, {
    artist: "New Branch Artist",
    title: "Fresh Branch",
    score: 72
  });

  const selected = selectDiscoveryLaneCandidates([...repeated, fresh], 5, options, profile);

  assert.equal(defaultPerRunArtistCap(options, profile, 5), 1);
  assert.equal(selected.tracks.length, 2);
  assert.equal(selected.tracks.filter((track) => track.artist === "Repeated Favorite").length, 1);
  assert.equal(new Set(selected.tracks.map((track) => track.artist)).size, 2);
});

test("Taste Guided discovery keeps familiar taste as a small seasoning lane", () => {
  const options = {
    request: "Find 5 progressive house discoveries this year",
    genres: "progressive house",
    years: "2026",
    count: "5",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const tasteTracks = Array.from({ length: 3 }, (_, index) => candidate(index, {
    artist: `Known Artist ${index}`,
    title: `Known Taste ${index}`,
    discoverySource: "Liked artist expansion",
    score: 98 - index
  }));
  const branchTracks = Array.from({ length: 5 }, (_, index) => candidate(20 + index, {
    artist: `Branch Artist ${index}`,
    title: `Branch Track ${index}`,
    discoverySource: "Similar artist branch",
    discoveryLane: "branch",
    score: 90 - index
  }));

  const selected = selectDiscoveryLaneCandidates([...tasteTracks, ...branchTracks], 5, options, profile);
  const budget = noveltyBudgetFor(options, profile, 5);
  const tasteCount = selected.tracks.filter((track) => track.discoveryQuotaBucket === "taste").length;

  assert.equal(budget.artistCap, 1);
  assert.equal(selected.quota.targets.taste, 0);
  assert.equal(selected.quota.max.taste, 1);
  assert.ok(tasteCount <= 1);
  assert.ok(selected.tracks.filter((track) => track.discoveryQuotaBucket === "branch").length >= 1);
});

test("Similar Mode allows limited repeated artists because the request is artist-near", () => {
  const options = {
    request: "Find tracks like Repeated Favorite",
    count: "5",
    scoringMode: "similar"
  };
  const profile = buildDiscoveryProfile(options);
  const repeated = Array.from({ length: 6 }, (_, index) => candidate(index, {
    artist: "Repeated Favorite",
    title: `Related Shape ${index}`,
    score: 100 - index
  }));
  const fresh = candidate(100, {
    artist: "Near Neighbor",
    title: "Related Branch",
    score: 72
  });

  const selected = selectDiscoveryLaneCandidates([...repeated, fresh], 5, options, profile);
  const repeatedCount = selected.tracks.filter((track) => track.artist === "Repeated Favorite").length;

  assert.equal(defaultPerRunArtistCap(options, profile, 5), 2);
  assert.ok(repeatedCount > 1);
  assert.ok(repeatedCount < selected.tracks.length);
  assert.ok(selected.tracks.length >= 3);
});
