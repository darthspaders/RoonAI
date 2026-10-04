"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DiscogsClient, releaseTrackCandidate } = require("../src/discogsClient");

function tempCache() {
  return path.join(os.tmpdir(), `rabbit-hole-discogs-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function response(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "" },
    async json() { return payload; }
  };
}

test("Discogs release track candidate preserves release/master/version metadata", () => {
  const candidate = releaseTrackCandidate({
    id: 101,
    master_id: 202,
    title: "Dream On",
    year: 2026,
    released: "2026-09-11",
    artists: [{ name: "D-Nox" }, { name: "M.O.S." }],
    labels: [{ name: "Sprout", catno: "SPT176" }],
    genres: ["Electronic"],
    styles: ["Progressive House"],
    uri: "/release/101",
    tracklist: [{ position: "1", title: "Dream On (Extended Mix)", duration: "7:43", artists: [{ name: "D-Nox" }, { name: "M.O.S." }] }]
  }, { artist: "D-Nox, M.O.S.", title: "Dream On" });

  assert.equal(candidate.discogsId, "101");
  assert.equal(candidate.masterId, "202");
  assert.equal(candidate.label, "Sprout");
  assert.equal(candidate.catalogNumber, "SPT176");
  assert.equal(candidate.subgenre, "Progressive House");
  assert.equal(candidate.durationMs, 463000);
  assert.equal(candidate.matchType, "RELATED_VERSION");
  assert.match(candidate.id, /^101:/);
});

test("Discogs client searches releases, fetches tracklists, and caches the bounded result", async () => {
  const calls = [];
  const client = new DiscogsClient({
    token: "test-token",
    cacheFile: tempCache(),
    minIntervalMs: 0,
    maxResults: 2,
    maxReleaseLookups: 2,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/database/search")) return response({ results: [{ id: 101 }, { id: 102 }] });
      if (url.endsWith("/releases/101")) return response({
        id: 101,
        master_id: 202,
        title: "Dream On",
        year: 2026,
        released: "2026-09-11",
        artists: [{ name: "D-Nox" }],
        labels: [{ name: "Sprout", catno: "SPT176" }],
        genres: ["Electronic"],
        styles: ["Progressive House"],
        tracklist: [{ position: "1", title: "Dream On", duration: "7:43", artists: [{ name: "D-Nox" }] }]
      });
      return response({ id: 102, tracklist: [] });
    }
  });

  const first = await client.findTrack({ artist: "D-Nox", title: "Dream On" });
  assert.equal(first.discogsId, "101");
  assert.equal(first.catalogNumber, "SPT176");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.authorization, "Discogs token=test-token");
  assert.match(calls[0].options.headers["user-agent"], /RabbitHole/);

  const second = await client.findTrack({ artist: "D-Nox", title: "Dream On" });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 3);
});

test("unconfigured Discogs client fails closed without making requests", async () => {
  let called = false;
  const client = new DiscogsClient({ token: "", fetchImpl: async () => { called = true; return response({}); } });
  assert.equal(client.isConfigured(), false);
  assert.equal(await client.findTrack({ artist: "Artist", title: "Track" }), null);
  assert.equal(called, false);
});
