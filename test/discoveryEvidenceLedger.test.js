"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDiscoveryEvidenceLedger,
  discoverTracks
} = require("../src/discoveryEngine");

test("discovery evidence ledger explains kept candidates", async () => {
  let returned = false;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (returned) return [];
      returned = true;
      return [{
        artist: "Guy J",
        title: "Nirvana",
        album: "Nirvana",
        label: "Lost & Found",
        year: 2026,
        releaseDate: "2026-07-10",
        releaseEvidence: {
          albumDate: "2026-07-10",
          albumYear: 2026
        },
        durationMs: 481000,
        tidalUrl: "https://tidal.com/browse/track/1001",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 1 underground progressive house track from 2026",
      genres: "progressive house",
      years: "2026",
      mood: "underground",
      count: "1",
      llmSearchPlan: {
        searchQueries: ["Guy J Nirvana progressive house 2026"]
      }
    }
  });

  assert.equal(result.tracks.length, 1);
  const ledger = result.tracks[0].evidenceLedger;
  assert.equal(ledger.decision, "kept");
  assert.match(ledger.query.requested, /progressive house.*2026/i);
  assert.ok(ledger.proof.label.some((item) => /Lost & Found/i.test(item)));
  assert.ok(ledger.proof.genre.some((item) => /progressive/i.test(item)));
  assert.ok(ledger.proof.year.some((item) => /2026/i.test(item)));
  assert.ok(ledger.proof.novelty.some((item) => /not previously/i.test(item)));
  assert.equal(ledger.rejectedBecause.length, 0);
});

test("discovery evidence ledger explains discarded candidates", async () => {
  let returned = false;
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async getArtistAlbums() {
      return [];
    },
    async searchTracks(query) {
      if (returned) return [];
      returned = true;
      return [{
        artist: "Date Drift",
        title: "Old Signal",
        album: "Old Signal",
        label: "Example Music",
        year: 2020,
        releaseDate: "2020-03-01",
        releaseEvidence: {
          albumDate: "2020-03-01",
          albumYear: 2020
        },
        durationMs: 420000,
        tidalUrl: "https://tidal.com/browse/track/2002",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 1 progressive house track from 2026",
      genres: "progressive house",
      years: "2026",
      count: "1",
      llmSearchPlan: {
        searchQueries: ["progressive house 2026"]
      }
    }
  });

  assert.equal(result.tracks.length, 0);
  const discarded = result.discarded.find((item) => /outside 2026/i.test(item.reason || ""));
  assert.ok(discarded);
  assert.equal(discarded.evidenceLedger.decision, "discarded");
  assert.ok(discarded.evidenceLedger.rejectedBecause.some((item) => /outside 2026/i.test(item)));
  assert.ok(discarded.evidenceLedger.proof.year.some((item) => /misses 2026/i.test(item)));
});

test("discovery evidence ledger ignores quality tags as genre proof", () => {
  const ledger = buildDiscoveryEvidenceLedger({
    artist: "Steven Liquid",
    title: "Always Searching",
    album: "Reflections",
    label: "Ultimate House Records",
    year: 2023,
    durationMs: 347000,
    genres: ["HIRES_LOSSLESS"],
    score: 72,
    scoreBreakdown: {
      total: 72,
      genreMatch: 8,
      genreInference: {
        confidence: 0,
        evidence: []
      }
    }
  }, {
    options: {
      request: "Find chillout",
      genres: "chillout"
    },
    decision: "kept"
  });

  assert.doesNotMatch(ledger.proof.genre.join(" "), /HIRES|LOSSLESS/i);
});
