const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { QueueAttemptStore } = require("../src/queueAttemptStore");

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-attempts-"));
  return new QueueAttemptStore({
    file: path.join(dir, "queue-attempts.json"),
    limit: 3,
    ...options
  });
}

test("queue attempt store keeps compact failed queue evidence", () => {
  const store = tempStore();
  const saved = store.record({
    request: {
      source: "standby",
      zoneId: "zone-1",
      mode: "append",
      matchPolicy: "strict",
      allowBridge: true,
      tracks: [{
        artist: "Nopi",
        title: "Tree (Mixed)",
        tidal: { id: "218394030", title: "Tree", artist: "Nõpi", isrc: "GBEWA2201467" },
        durationMs: 252000
      }]
    },
    result: {
      requested: 1,
      queuedCount: 0,
      failedCount: 1,
      failed: [{
        index: 0,
        track: { artist: "Nopi", title: "Tree (Mixed)", tidalTrackId: "218394030" },
        reason: "Roon did not find an exact artist/title match.",
        failureType: "version_mismatch",
        resolutionMethod: "roon_search",
        bridge: { tidalTrackId: "218394030", playlistId: "bridge", requiresManualRefresh: false, sync: { success: true } },
        directFailure: { reason: "direct miss", failureType: "not_found", resolutionMethod: "roon_search" }
      }]
    }
  });

  assert.equal(saved.source, "standby");
  assert.equal(saved.zoneId, "zone-1");
  assert.equal(saved.requestedTracks[0].tidalTrackId, "218394030");
  assert.equal(saved.requestedTracks[0].isrc, "GBEWA2201467");
  assert.equal(saved.failed[0].track.tidalTrackId, "218394030");
  assert.equal(saved.failed[0].bridge.syncSuccess, true);
  assert.equal(saved.failed[0].directFailure.failureType, "not_found");
});

test("queue attempt store caps retained attempts", () => {
  const store = tempStore({ limit: 2 });
  store.record({ request: { source: "one", tracks: [{ artist: "A", title: "One" }] }, result: { queuedCount: 1 } });
  store.record({ request: { source: "two", tracks: [{ artist: "B", title: "Two" }] }, result: { queuedCount: 1 } });
  store.record({ request: { source: "three", tracks: [{ artist: "C", title: "Three" }] }, result: { queuedCount: 1 } });

  const attempts = store.read().attempts;
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(attempt => attempt.source), ["two", "three"]);
});
