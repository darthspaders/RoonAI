"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { StandbyCandidateStore, standbyTrackKey } = require("../src/standbyCandidateStore");

function tempStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standby-candidates-"));
  return new StandbyCandidateStore({
    file: path.join(dir, "standby.json"),
    targetCount: 3,
    ttlMs: 60_000,
    ...options
  });
}

test("standby pool dedupes tracks and keeps the highest scoring target set", () => {
  const store = tempStore();
  store.add([
    { artist: "Artist A", title: "One", score: 61 },
    { artist: "Artist B", title: "Two", score: 89 },
    { artist: "Artist C", title: "Three", score: 70 }
  ], { reason: "test" });

  store.add([
    { artist: "Artist A", title: "One", score: 92 },
    { artist: "Artist D", title: "Four", score: 72 }
  ], { reason: "refresh" });

  const summary = store.summary();
  assert.equal(summary.count, 3);
  assert.equal(summary.ready, true);
  assert.deepEqual(summary.tracks.map((track) => track.title), ["One", "Two", "Four"]);
  assert.equal(summary.tracks[0].score, 92);
});

test("standby pool drops expired candidates from summaries", () => {
  const store = tempStore({ ttlMs: 1 });
  store.add([{ artist: "Old Artist", title: "Old Track", score: 90 }]);
  const snapshot = store.read();
  snapshot.candidates[0].standbyExpiresAt = Date.now() - 1;
  store.write(snapshot);

  assert.equal(store.summary().count, 0);
  assert.equal(store.readyCount(), 0);
});

test("standby refresh status records success and errors", () => {
  const store = tempStore();
  const started = store.markRefreshStart({ reason: "manual" });
  assert.equal(started.refreshing, true);
  assert.equal(started.lastRun.reason, "manual");

  const finished = store.markRefreshEnd({
    reason: "manual",
    generated: 7,
    kept: 3,
    discarded: 4,
    runtimeMs: 1200
  });
  assert.equal(finished.refreshing, false);
  assert.equal(finished.lastError, "");
  assert.equal(finished.lastRun.kept, 3);

  const failed = store.markRefreshEnd({ reason: "background", error: "TIDAL unavailable" });
  assert.equal(failed.lastError, "TIDAL unavailable");
});

test("standby refresh is not due when the pool is full", () => {
  const store = tempStore();
  store.add([
    { artist: "Artist A", title: "One", score: 61 },
    { artist: "Artist B", title: "Two", score: 89 },
    { artist: "Artist C", title: "Three", score: 70 }
  ]);

  const snapshot = store.read();
  snapshot.lastRefreshAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  snapshot.nextRefreshAt = new Date(Date.now() + 60_000).toISOString();
  store.write(snapshot);

  const summary = store.summary();
  assert.equal(summary.ready, true);
  assert.equal(summary.nextRefreshAt, "");
  assert.equal(store.refreshDue(1), false);
});

test("standby track key prefers TIDAL identity", () => {
  assert.equal(standbyTrackKey({
    artist: "Artist",
    title: "Title",
    tidal: { id: "123" }
  }), "tidal:123");
  assert.equal(standbyTrackKey({
    artist: "Artist",
    title: "Title"
  }), "artist|title");
});
