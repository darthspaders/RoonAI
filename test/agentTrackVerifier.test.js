"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAgentTrackVerifier,
  minDurationMsFromVerificationBody,
  negativeFeedback,
  verificationVerdict
} = require("../src/agentTrackVerifier");

function immediateWithTimeout(promise) {
  return promise;
}

function createVerifier(overrides = {}) {
  const verifier = createAgentTrackVerifier({
    tidal: {
      isConfigured: () => true,
      getTrack: async () => ({
        id: "123",
        artist: "Artist",
        title: "Track",
        tidalUrl: "https://tidal.com/browse/track/123",
        durationMs: 420000
      }),
      ...overrides.tidal
    },
    roon: {
      canQueueTrack: async () => ({ success: true, action: "queue", match: { title: "Track" } }),
      ...overrides.roon
    },
    discoveryHistory: {
      entryFor: () => null,
      isRecent: () => false,
      ...overrides.discoveryHistory
    },
    trackMemory: {
      find: () => null,
      ...overrides.trackMemory
    },
    trackKey: (track) => String(track.tidalUrl || `${track.artist || ""}|${track.title || ""}`).toLowerCase(),
    findExactTidalCatalogueTrack: async () => ({
      id: "123",
      artist: "Artist",
      title: "Track",
      tidalUrl: "https://tidal.com/browse/track/123",
      durationMs: 420000
    }),
    withTimeout: immediateWithTimeout,
    roonMatchSummary: (match) => match ? { title: match.title || "" } : null,
    booleanFlag: (value) => /^(?:1|true|yes|on)$/i.test(String(value || "")),
    playlistVerifyTimeoutMs: 10000,
    ...overrides
  });
  return verifier;
}

test("duration options support milliseconds, seconds, and minutes", () => {
  assert.equal(minDurationMsFromVerificationBody({ minDurationMs: 12 }), 12);
  assert.equal(minDurationMsFromVerificationBody({ minDurationSeconds: 12 }), 12000);
  assert.equal(minDurationMsFromVerificationBody({ minDurationMinutes: 7 }), 420000);
});

test("negative feedback matches existing rejection labels", () => {
  assert.equal(negativeFeedback("wrong_genre"), true);
  assert.equal(negativeFeedback("reject_similar"), true);
  assert.equal(negativeFeedback("like"), false);
});

test("verification verdict preserves priority order", () => {
  assert.equal(verificationVerdict({ valid: false }), "invalid");
  assert.equal(verificationVerdict({ valid: true, duplicateOf: 0 }), "duplicate_input");
  assert.equal(verificationVerdict({
    valid: true,
    tidalResult: { error: "bad" },
    roonResult: {}
  }), "tidal_error");
});

test("agent verifier detects duplicate inputs before returning usable tracks", async () => {
  const verifier = createVerifier();
  const result = await verifier.verifyTracksForAgent({
    tracks: [
      { artist: "Artist", title: "Track" },
      { artist: "Artist", title: "Track" }
    ],
    allowKnown: true
  });

  assert.equal(result.checkedCount, 2);
  assert.equal(result.usableCount, 1);
  assert.equal(result.tracks[1].verdict, "duplicate_input");
  assert.equal(result.tracks[1].duplicateOf, 0);
});

test("agent verifier can require Roon queueability", async () => {
  const verifier = createVerifier({
    roon: {
      canQueueTrack: async () => ({ success: false, reason: "No queue action." })
    }
  });
  const result = await verifier.verifyTracksForAgent({
    tracks: [{ artist: "Artist", title: "Track" }],
    checkRoon: true,
    zoneId: "zone"
  });

  assert.equal(result.tracks[0].roon.checked, true);
  assert.equal(result.tracks[0].verdict, "not_queueable_in_roon");
  assert.match(result.tracks[0].reasons.join(" "), /No queue action/);
});

test("agent verifier reports known negative feedback unless repeats are allowed", async () => {
  const verifier = createVerifier({
    trackMemory: {
      find: () => ({ feedback: "wrong_genre", score: -1 })
    }
  });
  const blocked = await verifier.verifyTracksForAgent({
    tracks: [{ artist: "Artist", title: "Track" }]
  });
  const allowed = await verifier.verifyTracksForAgent({
    tracks: [{ artist: "Artist", title: "Track" }],
    allowKnown: true
  });

  assert.equal(blocked.tracks[0].verdict, "known_reject");
  assert.equal(blocked.tracks[0].memory.negativeFeedback, true);
  assert.equal(allowed.tracks[0].verdict, "verified");
}
);
