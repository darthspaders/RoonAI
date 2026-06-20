"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  QueryYieldTracker,
  queryTemplate,
  rejectionBucketForReason
} = require("../src/queryYieldTracker");
const { discoverTracks } = require("../src/discoveryEngine");

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-query-yield-"));
  return path.join(dir, name);
}

test("query templates preserve genre shape while normalizing volatile years", () => {
  assert.equal(queryTemplate("Progressive Psytrance 2026"), "progressive psytrance {year}");
  assert.equal(queryTemplate("Deep House Mix 10-2025"), "deep house mix {n} {year}");
});

test("rejection bucket separates SEO sludge from genre mismatch", () => {
  assert.equal(rejectionBucketForReason("SEO genre/date catalogue filler"), "seo");
  assert.equal(rejectionBucketForReason("Requested genre appears only in the search query"), "genre");
});

test("records query yield and persists accepted, SEO, and genre rejection counts", () => {
  const tracker = new QueryYieldTracker(tempFile("yield.json"));
  const summary = tracker.recordRun([
    {
      query: "psytrance 2026",
      lane: "core",
      attempts: 1,
      returned: 6,
      accepted: 3,
      rejected: 1
    },
    {
      query: "deep house mix 2026",
      lane: "core",
      attempts: 1,
      returned: 8,
      rejected: 8,
      seoRejects: 8
    },
    {
      query: "goa trance 2026",
      lane: "adjacent",
      attempts: 1,
      returned: 4,
      rejected: 4,
      genreRejects: 4
    }
  ]);

  assert.equal(summary.attempted, 3);
  assert.equal(summary.accepted, 3);
  assert.equal(summary.seoRejects, 8);
  assert.equal(summary.genreRejects, 4);

  const stored = tracker.read();
  assert.equal(stored.entries["psytrance {year}"].accepted, 3);
  assert.equal(stored.entries["deep house mix {year}"].seoRejects, 8);
  assert.equal(stored.entries["goa trance {year}"].genreRejects, 4);
});

test("rankQueries promotes historically useful templates and demotes sludge", () => {
  const tracker = new QueryYieldTracker(tempFile("yield.json"));
  tracker.recordRun([
    {
      query: "psytrance 2026",
      lane: "core",
      attempts: 2,
      returned: 12,
      accepted: 6,
      rejected: 1
    },
    {
      query: "deep house mix 2026",
      lane: "core",
      attempts: 2,
      returned: 20,
      rejected: 20,
      seoRejects: 20
    }
  ]);

  const ranked = tracker.rankQueries([
    "deep house mix 2025",
    "unknown fresh query",
    "psytrance 2025"
  ], { lane: "core" });

  assert.equal(ranked.queries[0], "psytrance 2025");
  assert.equal(ranked.queries[2], "deep house mix 2025");
  assert.ok(ranked.adjustments.some((item) => item.template === "psytrance {year}" && item.quality > 0));
  assert.ok(ranked.adjustments.some((item) => item.template === "deep house mix {year}" && item.quality < 0));
});

test("rankQueries can prune historically bad templates when discovery asks for it", () => {
  const tracker = new QueryYieldTracker(tempFile("yield.json"));
  tracker.recordRun([
    {
      query: "deep house mix 2026",
      lane: "core",
      attempts: 3,
      returned: 24,
      rejected: 24,
      seoRejects: 24
    },
    {
      query: "psytrance 2026",
      lane: "core",
      attempts: 2,
      returned: 12,
      accepted: 5
    }
  ]);

  const ranked = tracker.rankQueries([
    "deep house mix 2025",
    "psytrance 2025"
  ], { lane: "core", prune: true });

  assert.deepEqual(ranked.queries, ["psytrance 2025"]);
  assert.equal(ranked.pruned.length, 1);
  assert.equal(ranked.pruned[0].template, "deep house mix {year}");
});

test("discovery uses query yield memory to reorder TIDAL search queries", async () => {
  const tracker = new QueryYieldTracker(tempFile("yield.json"));
  tracker.recordRun([
    {
      query: "bad query",
      lane: "core",
      attempts: 2,
      returned: 18,
      rejected: 18,
      seoRejects: 18
    },
    {
      query: "better query",
      lane: "core",
      attempts: 2,
      returned: 10,
      accepted: 5
    }
  ]);
  const searchOrder = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks(query) {
      searchOrder.push(query);
      if (query !== "better query") return [];
      return [{
        artist: "Useful Artist",
        title: "Useful Track",
        album: "Useful Track",
        label: "Useful Label",
        year: 2026,
        durationMs: 420000,
        tidalUrl: "https://tidal.com/browse/track/9001",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find a useful electronic track",
      count: "1",
      llmSearchPlan: {
        searchQueries: ["bad query", "better query"]
      }
    },
    history: null,
    queryYieldTracker: tracker
  });

  assert.equal(result.tracks.length, 1);
  assert.equal(searchOrder[0], "better query");
  assert.ok(result.verification.queryYield.adjustments.some((item) => item.query === "better query"));
});

test("discovery skips pruned query-yield templates before spending TIDAL crawl time", async () => {
  const tracker = new QueryYieldTracker(tempFile("yield.json"));
  tracker.recordRun([
    {
      query: "bad query",
      lane: "core",
      attempts: 3,
      returned: 24,
      rejected: 24,
      seoRejects: 24
    },
    {
      query: "better query",
      lane: "core",
      attempts: 2,
      returned: 10,
      accepted: 5
    }
  ]);
  const searchOrder = [];
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks(query) {
      searchOrder.push(query);
      if (query !== "better query") return [];
      return [{
        artist: "Useful Artist",
        title: "Useful Track",
        album: "Useful Track",
        label: "Useful Label",
        year: 2026,
        durationMs: 420000,
        tidalUrl: "https://tidal.com/browse/track/9001",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find a useful electronic track",
      count: "1",
      llmSearchPlan: {
        searchQueries: ["bad query", "better query"]
      }
    },
    history: null,
    queryYieldTracker: tracker
  });

  assert.equal(result.tracks.length, 1);
  assert.equal(searchOrder.includes("bad query"), false);
  assert.equal(result.verification.queryYield.prunedCount, 1);
});

test("discovery runs TIDAL search queries with conservative parallelism", async () => {
  let active = 0;
  let maxActive = 0;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return [];
    }
  };

  await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find electronic tracks",
      count: "3",
      llmSearchPlan: {
        searchQueries: ["one", "two", "three", "four"]
      }
    },
    history: null
  });

  assert.equal(maxActive, 2);
});
