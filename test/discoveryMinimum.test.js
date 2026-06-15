"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { discoverTracks } = require("../src/discoveryEngine");

test("minimum match is a soft floor when candidates are otherwise valid", async () => {
  const returned = new Set();
  const fakeTidal = {
    isConfigured() {
      return true;
    },
    async searchTracks(query) {
      if (returned.has("quiet-signal")) return [];
      returned.add("quiet-signal");
      return [{
        artist: "Leftfield Test",
        title: "Quiet Signal",
        album: "Signals",
        label: "",
        year: null,
        durationMs: 180000,
        tidalUrl: "https://tidal.com/browse/track/1001",
        query
      }];
    }
  };

  const result = await discoverTracks({
    tidal: fakeTidal,
    options: {
      request: "Find 2 music discoveries",
      count: "2",
      minScore: "experimental"
    },
    history: null,
    tasteProfile: null
  });

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].belowMinimum, true);
  assert.equal(result.verification.belowMinimumKept, 1);
  assert.equal(result.verification.aboveMinimumKept, 0);
  assert.equal(result.verification.minScoreSoftFallback, true);
  assert.equal(result.discarded.some((track) => /below minimum/i.test(track.reason || "")), false);
});
