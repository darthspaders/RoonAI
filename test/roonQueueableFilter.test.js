"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoonQueueableFilter } = require("../src/roonQueueableFilter");

function createFilter(overrides = {}) {
  const roon = overrides.roon || {
    async canQueueTrack(track) {
      return {
        success: true,
        action: `queue:${track.title}`,
        match: { title: track.title, subtitle: track.artist }
      };
    }
  };
  const tidal = overrides.tidal || {
    isConfigured: () => false,
    async verify() {
      return null;
    }
  };

  return createRoonQueueableFilter({
    allowsArtistRepeatFallback: overrides.allowsArtistRepeatFallback || (() => false),
    artistKeysForCandidate: overrides.artistKeysForCandidate || ((track = {}) => [String(track.artist || "").toLowerCase()].filter(Boolean)),
    buildDiscoveryProfile: overrides.buildDiscoveryProfile || (() => ({ intent: "test" })),
    candidateIdentityKeys: overrides.candidateIdentityKeys || ((track = {}) => [`${String(track.artist || "").toLowerCase()}|${String(track.title || "").toLowerCase()}`]),
    defaultPerRunArtistCap: overrides.defaultPerRunArtistCap || (() => Number.MAX_SAFE_INTEGER),
    minimumScoreFor: overrides.minimumScoreFor || (() => 0),
    normalizeMatchText: overrides.normalizeMatchText || ((value = "") => String(value || "").trim().toLowerCase()),
    queueableStatusChecks: overrides.queueableStatusChecks || (() => ["Roon queueable"]),
    rejectReason: overrides.rejectReason || (() => ""),
    requestPrefersExtendedMixes: overrides.requestPrefersExtendedMixes || (() => false),
    roon,
    roonMatchSummary: overrides.roonMatchSummary || ((match = null) => match ? { title: match.title, subtitle: match.subtitle } : null),
    tidal,
    yearRangeUtil: overrides.yearRangeUtil || {
      parseYearRange: () => null,
      yearFits: () => true
    }
  });
}

test("filterForRoonQueueable requires a zone id", async () => {
  const { filterForRoonQueueable } = createFilter();
  await assert.rejects(
    () => filterForRoonQueueable({ tracks: [{ artist: "A", title: "T" }] }, ""),
    /Select a Roon output zone first/
  );
});

test("filterForRoonQueueable preserves empty result counters", async () => {
  const { filterForRoonQueueable } = createFilter();
  const result = await filterForRoonQueueable({
    tracks: [],
    alternates: [],
    discarded: [{ title: "Rejected" }],
    verification: { generated: 4, discarded: 1 }
  }, "zone-a");

  assert.equal(result.tracks.length, 0);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.verification.roonChecked, 0);
  assert.equal(result.verification.generated, 4);
  assert.equal(result.verification.discarded, 1);
  assert.equal(Object.hasOwn(result, "alternates"), false);
});

test("filterForRoonQueueable accepts existing verified queue actions without another Roon check", async () => {
  let checks = 0;
  const { filterForRoonQueueable } = createFilter({
    roon: {
      async canQueueTrack() {
        checks += 1;
        return { success: false };
      }
    }
  });

  const result = await filterForRoonQueueable({
    requestedCount: 1,
    tracks: [{
      artist: "A",
      title: "T",
      roon: { verified: true, queueAction: "queue-token" }
    }],
    alternates: []
  }, "zone-a");

  assert.equal(checks, 0);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].roon.queueAction, "queue-token");
  assert.deepEqual(result.tracks[0].statusChecks, ["Roon queueable"]);
});

test("filterForRoonQueueable resolves strict failures through direct bridge when identity is available", async () => {
  const roon = {
    async canQueueTrack() {
      return {
        success: false,
        reason: "Direct search missed",
        match: { title: "Best", subtitle: "Artist" }
      };
    },
    async resolveDirectBridgeBatch(entries) {
      assert.equal(entries.length, 1);
      assert.equal(entries[0].mode, "queue");
      assert.equal(entries[0].policy, "strict");
      return [{
        index: entries[0].index,
        result: {
          success: true,
          queueToken: "bridge-token",
          match: { title: "Track", subtitle: "Artist" },
          bridge: { playlist: "Rabbit Hole Bridge" }
        }
      }];
    }
  };
  const { filterForRoonQueueable } = createFilter({ roon });

  const result = await filterForRoonQueueable({
    requestedCount: 1,
    tracks: [{ artist: "Artist", title: "Track", tidalTrackId: "123" }],
    alternates: []
  }, "zone-a");

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].roon.queueAction, "bridge-token");
  assert.equal(result.tracks[0].roon.queueToken, "bridge-token");
  assert.deepEqual(result.tracks[0].bridge, { playlist: "Rabbit Hole Bridge" });
  assert.equal(result.verification.roonRejected, 0);
});

test("verifyPlaylistWithRoon rejects progressive house lookups that resolve to known wrong-genre terms", async () => {
  const { verifyPlaylistWithRoon } = createFilter({
    tidal: {
      isConfigured: () => true,
      async verify() {
        return {
          artist: "Artist",
          title: "Uplifting Mix",
          album: "Trance Sessions",
          year: 2026,
          releaseDate: "2026-01-01"
        };
      }
    }
  });

  const result = await verifyPlaylistWithRoon({
    requestedCount: 1,
    tracks: [{ artist: "Artist", title: "Track" }]
  }, "zone-a", { genres: "progressive house" });

  assert.equal(result.tracks.length, 0);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0].reason, "TIDAL match appears outside progressive house.");
});
