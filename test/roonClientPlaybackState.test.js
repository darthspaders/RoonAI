"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { clearStoppedZoneNowPlaying, isStoppedZone } = require("../src/roonClient");

test("stopped zones do not retain stale now playing payloads", () => {
  const stopped = clearStoppedZoneNowPlaying({
    zone_id: "zone-1",
    state: "stopped",
    now_playing: {
      image_key: "old-cover",
      two_line: {
        line1: "Old Track",
        line2: "Old Artist"
      }
    }
  });

  assert.equal(stopped.now_playing, null);
});

test("paused and playing zones keep their current now playing payloads", () => {
  const nowPlaying = {
    image_key: "current-cover",
    two_line: {
      line1: "Current Track",
      line2: "Current Artist"
    }
  };

  const paused = clearStoppedZoneNowPlaying({
    zone_id: "zone-1",
    state: "paused",
    now_playing: nowPlaying
  });
  const playing = clearStoppedZoneNowPlaying({
    zone_id: "zone-1",
    state: "playing",
    now_playing: nowPlaying
  });

  assert.equal(paused.now_playing, nowPlaying);
  assert.equal(playing.now_playing, nowPlaying);
});

test("stopped zone detection is case-insensitive", () => {
  assert.equal(isStoppedZone({ state: "Stopped" }), true);
  assert.equal(isStoppedZone({ state: "playing" }), false);
});
