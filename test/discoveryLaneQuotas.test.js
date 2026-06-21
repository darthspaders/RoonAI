"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  artistDiversityAdjustmentFor,
  buildDiscoveryProfile,
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
