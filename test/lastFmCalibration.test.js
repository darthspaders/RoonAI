"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDiscoveryProfile, scoreBreakdownFor } = require("../src/discoveryEngine");

function historySnapshot(overrides = {}) {
  return {
    enabled: true,
    configured: true,
    apiKeyConfigured: true,
    usernameConfigured: true,
    usernameValid: true,
    checked: true,
    returned: 0,
    tracksByKey: {},
    topArtistsByKey: {},
    ...overrides
  };
}

test("recent Last.fm scrobbles downweight exact repeats", () => {
  const options = {
    request: "Find progressive house",
    genres: "progressive house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const track = {
    artist: "Jody Wisternoff",
    title: "The Sky Below",
    album: "The Sky Below",
    label: "Anjunadeep",
    year: 2025,
    durationMs: 420000,
    query: "progressive house 2025"
  };
  const base = scoreBreakdownFor(track, options, null, profile);
  const scored = scoreBreakdownFor(track, options, null, profile, historySnapshot({
    returned: 1,
    tracksByKey: {
      "jody wisternoff|the sky below": {
        artist: "Jody Wisternoff",
        title: "The Sky Below",
        plays: 3,
        nowPlaying: false
      }
    }
  }));

  assert.equal(scored.lastfmRecentRepeat, true);
  assert.ok(scored.lastfmAdjustment < 0);
  assert.ok(scored.total < base.total);
  assert.match(scored.tasteReasons.join(" "), /recent Last\.fm repeat/i);
});

test("Last.fm top artists lightly boost Taste Guided matches", () => {
  const options = {
    request: "Find melodic techno",
    genres: "melodic techno",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const scored = scoreBreakdownFor({
    artist: "Yotto",
    title: "Signal",
    album: "Signal",
    label: "Odd One Out",
    year: 2026,
    durationMs: 390000,
    query: "melodic techno 2026"
  }, options, null, profile, historySnapshot({
    topArtistsByKey: {
      yotto: {
        artist: "Yotto",
        plays: 90,
        rank: 4,
        period: "12month"
      }
    },
    topArtistsReturned: 1
  }));

  assert.equal(scored.lastfmAdjustment, 1);
  assert.match(scored.tasteReasons.join(" "), /long-term Last\.fm artist Yotto/i);
});

test("Pure Search ignores Last.fm taste calibration", () => {
  const options = {
    request: "Find melodic techno",
    genres: "melodic techno",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);
  const scored = scoreBreakdownFor({
    artist: "Yotto",
    title: "Signal",
    album: "Signal",
    label: "Odd One Out",
    year: 2026,
    durationMs: 390000,
    query: "melodic techno 2026"
  }, options, null, profile, historySnapshot({
    tracksByKey: {
      "yotto|signal": { artist: "Yotto", title: "Signal", plays: 2 }
    },
    topArtistsByKey: {
      yotto: { artist: "Yotto", plays: 90, rank: 4, period: "12month" }
    }
  }));

  assert.equal(scored.lastfmAdjustment, 0);
  assert.equal(scored.tasteAdjustment, 0);
  assert.equal(scored.tasteReasons.length, 0);
});

test("Explore Mode does not boost familiar Last.fm artists", () => {
  const options = {
    request: "Find adventurous electronic discoveries",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const scored = scoreBreakdownFor({
    artist: "Yotto",
    title: "Signal",
    album: "Signal",
    label: "Odd One Out",
    year: 2026,
    durationMs: 390000,
    query: "electronic 2026"
  }, options, null, profile, historySnapshot({
    topArtistsByKey: {
      yotto: { artist: "Yotto", plays: 90, rank: 4, period: "12month" }
    },
    topArtistsReturned: 1
  }));

  assert.equal(scored.lastfmAdjustment, -2);
  assert.match(scored.tasteReasons.join(" "), /Explore Mode/i);
});
