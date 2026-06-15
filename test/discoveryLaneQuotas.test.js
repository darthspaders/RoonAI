"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
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
