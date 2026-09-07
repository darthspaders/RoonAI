"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDiscoveryNoveltyPolicy,
  previouslySuggestedDiscard,
  requestAllowsPreviousSuggestions
} = require("../src/discoveryNoveltyPolicy");

test("previous suggestion override phrases preserve existing intent matching", () => {
  assert.equal(requestAllowsPreviousSuggestions({ request: "show repeats" }), true);
  assert.equal(requestAllowsPreviousSuggestions({ mood: "same songs again" }), true);
  assert.equal(requestAllowsPreviousSuggestions({ request: "fresh progressive house" }), false);
});

test("previously suggested discard preserves track and appends status", () => {
  const result = previouslySuggestedDiscard(
    { artist: "A", title: "T", statusChecks: ["existing"] },
    { firstShownAt: "one", lastShownAt: "two", shownCount: 3 }
  );

  assert.equal(result.rejectedReason, "previously suggested");
  assert.equal(result.reason, "Previously suggested; held back for discovery novelty.");
  assert.deepEqual(result.history, { firstShownAt: "one", lastShownAt: "two", shownCount: 3 });
  assert.deepEqual(result.statusChecks, ["existing", "Previously suggested; held back"]);
});

test("novelty policy suppresses previous result tracks and updates diagnostics", () => {
  const previous = { firstShownAt: "one", lastShownAt: "two", shownCount: 2 };
  const policy = createDiscoveryNoveltyPolicy({
    discoveryHistory: {
      entryFor: (track) => track.title === "Old" ? previous : null
    }
  });

  const result = policy.suppressPreviouslySuggestedResultTracks({
    tracks: [
      { artist: "A", title: "Old" },
      { artist: "A", title: "New" }
    ],
    discarded: [{ title: "Existing" }],
    verification: { previouslySuggestedHeldBack: 1 }
  }, {});

  assert.deepEqual(result.tracks.map((track) => track.title), ["New"]);
  assert.deepEqual(result.discarded.map((track) => track.title), ["Old", "Existing"]);
  assert.equal(result.verification.previouslySuggestedHeldBack, 2);
  assert.equal(result.verification.freshnessGuardHeldBack, 1);
});

test("novelty policy keeps previous tracks when request allows repeats", () => {
  const policy = createDiscoveryNoveltyPolicy({
    discoveryHistory: {
      entryFor: () => ({ shownCount: 1 })
    }
  });
  const input = { tracks: [{ title: "Old" }] };

  assert.equal(policy.suppressPreviouslySuggestedResultTracks(input, { request: "include repeats" }), input);
});

test("fresh unseen tracks dedupes by candidate identities and removes previous suggestions", () => {
  const policy = createDiscoveryNoveltyPolicy({
    discoveryHistory: {
      entryFor: (track) => track.title === "Old" ? { shownCount: 1 } : null
    },
    candidateIdentityKeys: (track) => track.key ? [track.key] : []
  });

  const result = policy.freshUnseenTracks([
    { key: "one", title: "New" },
    { key: "one", title: "Duplicate" },
    { key: "two", title: "Old" },
    { artist: "A", title: "Fallback" }
  ]);

  assert.deepEqual(result.map((track) => track.title), ["New", "Fallback"]);
});
