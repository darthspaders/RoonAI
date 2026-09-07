"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  bridgeSyncAlertFromResult,
  bridgeSyncEntriesFromResult
} = require("../src/bridgeSyncAlert");

test("bridge sync alert extracts manual refresh entries from supported result arrays", () => {
  const result = {
    failedTracks: [{ index: 0, bridge: { requiresManualRefresh: true }, artist: "A", title: "One" }],
    failed: [{ index: 1, roon: { bridge: { sync: { requiresManualRefresh: true } } }, track: { artist: "B", title: "Two" } }],
    results: [{ index: 2, bridge: { requiresManualRefresh: false }, artist: "C", title: "Three" }],
    tracks: [{ index: 3, bridge: { requiresManualRefresh: true }, requestedArtist: "D", requestedTitle: "Four" }]
  };

  const entries = bridgeSyncEntriesFromResult(result);
  assert.equal(entries.length, 3);

  const alert = bridgeSyncAlertFromResult(result, {
    id: "alert-1",
    createdAt: "2026-01-02T03:04:05.000Z"
  });

  assert.equal(alert.id, "alert-1");
  assert.equal(alert.createdAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(alert.failedTracks.map((item) => [item.index, item.artist, item.title]), [
    [0, "A", "One"],
    [1, "B", "Two"],
    [3, "D", "Four"]
  ]);
});

test("bridge sync alert returns null when no manual refresh is required", () => {
  assert.equal(bridgeSyncAlertFromResult({ failed: [{ bridge: { requiresManualRefresh: false } }] }), null);
});
