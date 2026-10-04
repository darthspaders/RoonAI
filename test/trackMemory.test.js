"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TrackMemory } = require("../src/trackMemory");

function fixture(t, entries = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-track-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "memory.json");
  fs.writeFileSync(file, JSON.stringify({ entries }));
  return { file, memory: new TrackMemory({ file }) };
}

function countScans(memory) {
  let scans = 0;
  const values = memory.entries.values.bind(memory.entries);
  memory.entries.values = () => { scans++; return values(); };
  return () => scans;
}

test("track memory exposes only explicitly validated TIDAL identities for resolver reuse", t => {
  const { memory } = fixture(t);
  memory.entries = new Map([
    ["validated", {
      artist: "Holden",
      title: "A Break in the Clouds",
      tidal: {
        verified: true,
        id: "2352515",
        artist: "James Holden",
        title: "A Break In The Clouds (Main Mix)",
        mixVersion: "Main Mix",
        releaseDate: "2004-01-01"
      }
    }],
    ["unverified", {
      artist: "Holden",
      title: "A Break in the Clouds",
      tidal: { id: "999", artist: "James Holden", title: "A Break In The Clouds" }
    }]
  ]);

  const matches = memory.findValidatedTidalIdentities({ artist: "Holden", title: "A Break in the Clouds" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].tidalId, "2352515");
  assert.equal(matches[0].validatedIdentitySource, "track-memory-validated-tidal");
});

test("find keeps exact source-key hits ahead of fuzzy matching without scanning", t => {
  const remembered = { key: "https://tidal.com/browse/track/42", title: "Exact source", artist: "Artist", tidal: { id: "42" } };
  const { memory } = fixture(t, [remembered]);
  const scans = countScans(memory);
  const match = memory.find({ tidalUrl: "https://tidal.com/browse/track/42" });
  assert.equal(match, memory.entries.get(remembered.key));
  assert.equal(match.tidal.id, "42");
  assert.equal(scans(), 0);
});

test("find skips impossible fuzzy queries while retaining TIDAL title and artist fallbacks", t => {
  const { memory } = fixture(t, [{ key: "saved", title: "Pulse (Main Mix)", artist: "James Holden", lastSeenAt: 3 }]);
  const scans = countScans(memory);
  for (const query of [{}, { title: "Pulse" }, { artist: "Holden" }, { title: "!!!", artist: "Holden" },
    { title: "Pulse", artist: "X" }, { title: "Pulse", tidal: { artist: "!" } },
    { title: " ", artist: "Holden", tidal: { title: "Pulse" } }]) {
    assert.equal(memory.find(query), null);
  }
  assert.equal(scans(), 0);
  assert.equal(memory.find({ tidal: { title: "Pulse", artist: "Holden" } }), memory.entries.get("saved"));
  assert.equal(scans(), 1);
});

test("fuzzy find retains the latest matching entry and stable insertion order on ties", t => {
  const { memory } = fixture(t, [
    { key: "old", title: "Pulse (Old Mix)", artist: "James Holden", lastSeenAt: 1, tidal: { id: "old-source" } },
    { key: "first-tie", title: "Pulse (Main Mix)", artist: "James Holden", lastSeenAt: 8, tidal: { id: "first-source" } },
    { key: "second-tie", title: "Pulse (Remix)", artist: "James Holden", lastSeenAt: 8, tidal: { id: "second-source" } }
  ]);
  assert.equal(memory.find({ title: "Pulse", artist: "Holden" }), memory.entries.get("first-tie"));
  assert.equal(memory.find({ title: "Pulse", artist: "Holden" }).tidal.id, "first-source");
});

test("repeated fuzzy hits and misses reuse their lookup without rescanning", t => {
  const { memory } = fixture(t, [{ key: "saved", title: "Pulse (Main Mix)", artist: "James Holden" }]);
  const scans = countScans(memory);
  const hit = { title: "Pulse", artist: "Holden" }, miss = { title: "Missing exact song", artist: "Unmatched artist" };
  const remembered = memory.find(hit);
  assert.equal(memory.find(miss), null);
  for (let index = 0; index < 10; index++) {
    assert.equal(memory.find({ ...hit }), remembered);
    assert.equal(memory.find({ ...miss }), null);
  }
  assert.equal(scans(), 2);
  assert.equal(memory.find({ ...miss, title: "Pulse", artist: "Holden" }), remembered);
});

test("fuzzy memo stays bounded and evicted misses are looked up again", t => {
  const { memory } = fixture(t);
  const scans = countScans(memory), query = { title: "Absent 0", artist: "Unknown Artist" };
  for (let index = 0; index < 150; index++) assert.equal(memory.find({ ...query, title: "Absent " + index }), null);
  assert.ok(memory.fuzzyLookups.size < 150);
  assert.equal(scans(), 150);
  assert.equal(memory.find(query), null);
  assert.equal(scans(), 151);
});

test("load and save invalidate cached fuzzy results, including external file replacements", t => {
  const { file, memory } = fixture(t, [{ key: "initial", title: "Pulse (Main Mix)", artist: "James Holden", lastSeenAt: 1 }]);
  const query = { title: "Pulse", artist: "Holden" }, initial = memory.find(query);
  memory.entries.set("newer", { key: "newer", title: "Pulse (Remix)", artist: "James Holden", lastSeenAt: 2 });
  memory.save();
  assert.notEqual(memory.find(query), initial);
  assert.equal(memory.find(query).key, "newer");
  assert.equal(memory.find({ title: "Future", artist: "Artist" }), null);
  fs.writeFileSync(file, JSON.stringify({ entries: [{ key: "replacement", title: "Future (Main Mix)", artist: "Artist", lastSeenAt: 3 }] }));
  memory.load();
  assert.equal(memory.find(query), null);
  assert.equal(memory.find({ title: "Future", artist: "Artist" }).key, "replacement");
  fs.unlinkSync(file);
  memory.load();
  assert.equal(memory.find({ title: "Future", artist: "Artist" }), null);
});

test("record, feedback and purge invalidate fuzzy hits and misses without changing stored identities", t => {
  const { file, memory } = fixture(t);
  const query = { title: "Pulse", artist: "Holden" };
  assert.equal(memory.find(query), null);
  const track = { title: "Pulse (Main Mix)", artist: "James Holden", tidal: { id: "42", tidalUrl: "https://tidal.com/browse/track/42" } };
  memory.record([track], 123);
  const first = memory.find(query);
  assert.equal(first.key, track.tidal.tidalUrl);
  memory.updateFeedback(track, "love");
  const rated = memory.find(query);
  assert.notEqual(rated, first);
  assert.equal(rated.feedback, "love");
  assert.equal(rated.tidal.id, "42");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["entries", "maxBytes", "updatedAt"]);
  assert.equal(stored.entries[0].key, track.tidal.tidalUrl);
  memory.purge();
  assert.equal(memory.find(query), null);
});
