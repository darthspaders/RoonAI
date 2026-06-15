"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { discoveryStatusFor } = require("../src/discoveryEngine");

test("discovery status does not imply Last.fm API key is disconnected", () => {
  const statuses = discoveryStatusFor({
    artist: "Jody Wisternoff",
    title: "The Sky Below",
    tidalUrl: "https://tidal.com/browse/track/example"
  });

  assert.equal(statuses.includes("Scrobble history not connected"), false);
  assert.equal(statuses.includes("Scrobble history not checked"), true);
});

test("discovery status reports Last.fm scrobble matches when history is checked", () => {
  const statuses = discoveryStatusFor({
    artist: "Jody Wisternoff",
    title: "The Sky Below",
    tidalUrl: "https://tidal.com/browse/track/example"
  }, null, false, {
    enabled: true,
    apiKeyConfigured: true,
    usernameConfigured: true,
    configured: true,
    checked: true,
    tracksByKey: {
      "jody wisternoff|the sky below": {
        plays: 3,
        artist: "Jody Wisternoff",
        title: "The Sky Below"
      }
    }
  });

  assert.equal(statuses.includes("Previously scrobbled 3x on Last.fm"), true);
});

test("discovery status reports Last.fm non-matches without penalizing the track", () => {
  const statuses = discoveryStatusFor({
    artist: "M.O.S.",
    title: "Favourite Colours"
  }, null, false, {
    enabled: true,
    apiKeyConfigured: true,
    usernameConfigured: true,
    configured: true,
    checked: true,
    tracksByKey: {}
  });

  assert.equal(statuses.includes("Not in recent Last.fm scrobbles"), true);
});
