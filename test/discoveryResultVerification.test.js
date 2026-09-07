"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscoveryResultVerification } = require("../src/discoveryResultVerification");
const { candidateIdentityKeys } = require("../src/discoveryEngine");
const { normalizeMatchText } = require("../src/tidalMatchRules");

const verification = createDiscoveryResultVerification({
  candidateIdentityKeys,
  mergeTrackLists: (...lists) => lists.flat().filter(Boolean),
  normalizeMatchText
});

test("queueableStatusChecks normalizes Roon statuses without duplicating older Roon text", () => {
  assert.deepEqual(verification.queueableStatusChecks({
    roon: { verified: true, artistCreditConfirmed: "D-SHIFT" },
    statusChecks: ["Roon stale", "Exact artist credit old", "TIDAL exact"]
  }), [
    "Roon verified",
    "Roon queue action ready",
    "Exact artist credit confirmed: D-SHIFT",
    "TIDAL exact"
  ]);
});

test("roonVerificationTimeoutFallback keeps requested tracks and exposes honest fallback counters", () => {
  const result = verification.roonVerificationTimeoutFallback({
    tracks: [{ artist: "A", title: "One", statusChecks: ["Roon old", "TIDAL exact"] }],
    alternates: [{ artist: "B", title: "Two" }],
    discarded: [{ artist: "C", title: "Three" }],
    verification: { strategy: "tidal" }
  }, 1, new Error("slow"));

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].roon.verified, false);
  assert.deepEqual(result.tracks[0].statusChecks, [
    "Roon verification timed out",
    "Queue action will be checked when queued",
    "TIDAL exact"
  ]);
  assert.equal(result.verification.roonVerificationFallback, true);
  assert.equal(result.verification.generated, 2);
  assert.equal(result.alternates.length, 1);
});

test("tidalPlaylistBridgeResult flattens tracks and alternates into bridge-ready output", () => {
  const result = verification.tidalPlaylistBridgeResult({
    tracks: [{ title: "One", tidal: { id: "1" } }],
    alternates: [{ title: "Two" }],
    discarded: [{ title: "Three" }],
    verification: { strategy: "roon-verified", requested: 4, generated: 7, discarded: 1 }
  }, 8);

  assert.equal(result.verification.strategy, "tidal-catalog-playlist-bridge");
  assert.equal(result.verification.queueBridgeReady, true);
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.alternates, []);
  assert.equal(result.verification.kept, 2);
  assert.equal(result.verification.generated, 7);
});

test("syncFinalResultVerification updates counters and model-review diagnostics from final arrays", () => {
  const result = verification.syncFinalResultVerification({
    tracks: [{ title: "kept" }, { title: "soft", belowMinimum: true }],
    alternates: [{ title: "alt", belowMinimum: true }],
    discarded: [{ title: "bad" }],
    verification: {
      requested: 5,
      minScore: 75,
      generated: 1,
      modelCandidateReview: {
        rejected: 1,
        rejectedKept: 1,
        audit: { rejected: [{ artist: "A", title: "B", reason: "wrong" }] }
      },
      autoBroaden: { attempted: 1, added: 2, lanes: [{ label: "Branch-out" }] },
      poolDiagnostics: { notes: ["existing"], buckets: [] }
    }
  }, 5);

  assert.equal(result.verification.generated, 4);
  assert.equal(result.verification.kept, 2);
  assert.equal(result.verification.discarded, 1);
  assert.equal(result.verification.belowMinimumKept, 1);
  assert.equal(result.verification.belowMinimumAlternates, 1);
  assert.equal(result.verification.aboveMinimumKept, 1);
  assert.equal(result.verification.minScoreSoftFallback, true);
  assert.equal(result.verification.poolDiagnostics.retainedPool, 3);
  assert.equal(result.verification.poolDiagnostics.buckets[0].label, "Model rejected");
  assert.ok(result.verification.poolDiagnostics.notes.some((note) => /Adaptive retry ran 1 pass/.test(note)));
});

test("shouldRunRoonFirstRescue preserves empty-result trigger rules", () => {
  assert.equal(verification.shouldRunRoonFirstRescue({ tracks: [{ title: "ok" }] }), false);
  assert.equal(verification.shouldRunRoonFirstRescue({ tracks: [], verification: { roonFirstRescue: { attempted: true }, roonRejected: 1 } }), false);
  assert.equal(verification.shouldRunRoonFirstRescue({ tracks: [], verification: { roonRejected: 1 } }), true);
  assert.equal(verification.shouldRunRoonFirstRescue({ tracks: [], discarded: [{}], verification: {} }), true);
});
