"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  mergeStandbyRefillPool,
  standbyFreshSourcePasses,
  summarizeStandbyFreshness
} = require("../src/standbyDiscoveryPlanner");

test("standby fresh source passes broaden a short visible pool without allowing repeats", () => {
  const passes = standbyFreshSourcePasses({
    request: "Find 2026 tracks that fit my taste",
    genres: "progressive house",
    mood: "hypnotic"
  }, {
    freshCount: 2,
    targetCount: 25
  });

  assert.equal(passes.length, 4);
  assert.deepEqual(passes.map((pass) => pass.id), [
    "clean-refill-wide-sources",
    "adjacent-artist-branches",
    "label-branches",
    "radio-bridge"
  ]);
  assert.ok(passes.every((pass) => pass.options.scoringMode === "explore"));
  assert.ok(passes.every((pass) => pass.options.allowPreviousSuggestions === ""));
  assert.ok(passes.every((pass) => pass.options.years === ""));
  assert.doesNotMatch(passes.map((pass) => pass.options.request).join("\n"), /\b2026\b/);
  assert.match(passes.map((pass) => pass.options.request).join("\n"), /Exclude previously suggested/i);
  assert.match(passes.map((pass) => pass.options.request).join("\n"), /Prefer a short clean pool/i);
  assert.doesNotMatch(passes.map((pass) => pass.options.request).join("\n"), /allow same artists when needed/i);
  const cleanRefill = passes[0];
  assert.match(cleanRefill.options.request, /Reject SEO playlist/i);
  assert.match(cleanRefill.options.request, /wellness, meditation, hypnosis/i);
  assert.match(cleanRefill.options.genres, /progressive breaks/i);
  assert.equal(cleanRefill.options.releasePreset, "");
  assert.equal(cleanRefill.options.releaseStartDate, "");
  assert.equal(cleanRefill.options.skipSimilarArtistExpansion, "true");
  assert.equal(cleanRefill.options.planOnlySearch, "true");
  assert.equal(cleanRefill.options.planQueryLimit, "18");
  assert.equal(cleanRefill.options.requirePlanQueryAnchor, "true");
  assert.equal(cleanRefill.timeoutMs, 18_000);
  assert.ok(Number(cleanRefill.options.count) > 25);
  assert.ok(cleanRefill.options.llmSearchPlan.candidateLabels.includes("Bedrock Records"));
  assert.doesNotMatch(cleanRefill.options.llmSearchPlan.searchQueries.join("\n"), /\bdeep cuts\b/i);
});

test("standby fresh source passes are skipped when the visible pool is full", () => {
  assert.deepEqual(standbyFreshSourcePasses({ count: "25" }, { freshCount: 25, targetCount: 25 }), []);
});

test("standby refill merge keeps the stronger existing pool when new discovery underfills", () => {
  const merged = mergeStandbyRefillPool({
    existingTracks: [
      { key: "old-1", title: "Old One" },
      { key: "old-2", title: "Old Two" },
      { key: "dupe", title: "Old Dupe" }
    ],
    newTracks: [
      { key: "new-1", title: "New One" },
      { key: "dupe", title: "New Dupe" }
    ],
    targetCount: 4
  });

  assert.deepEqual(merged.map((track) => track.title), ["Old One", "Old Two", "Old Dupe", "New One"]);
});

test("standby refill merge prefers a larger new pool", () => {
  const merged = mergeStandbyRefillPool({
    existingTracks: [
      { key: "old-1", title: "Old One" }
    ],
    newTracks: [
      { key: "new-1", title: "New One" },
      { key: "new-2", title: "New Two" },
      { key: "old-1", title: "New Duplicate" }
    ],
    targetCount: 3
  });

  assert.deepEqual(merged.map((track) => track.title), ["New One", "New Two", "New Duplicate"]);
});

test("standby freshness diagnostics count repeat suppression by source and lane", () => {
  const storedTracks = [
    { key: "a", artist: "A", title: "One", standbySource: "Standby discovery", standbyLane: "branch" },
    { key: "b", artist: "B", title: "Two", standbySource: "Standby discovery", standbyLane: "branch" },
    { key: "c", artist: "C", title: "Three", standbySource: "Standby label broadening", standbyLane: "label" }
  ];
  const visibleTracks = [storedTracks[2]];
  const summary = summarizeStandbyFreshness({
    storedTracks,
    visibleTracks,
    targetCount: 3,
    isPreviouslySuggested: (track) => track.key !== "c",
    keyForTrack: (track) => track.key
  });

  assert.equal(summary.stored, 3);
  assert.equal(summary.visible, 1);
  assert.equal(summary.filtered, 2);
  assert.equal(summary.previouslySuggested, 2);
  assert.deepEqual(summary.filteredBySource, [{ label: "Standby discovery", count: 2 }]);
  assert.deepEqual(summary.filteredByLane, [{ label: "branch", count: 2 }]);
  assert.deepEqual(summary.visibleBySource, [{ label: "Standby label broadening", count: 1 }]);
});
