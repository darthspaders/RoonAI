"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizedTrackKey,
  normalizeTrackIdentityText
} = require("../src/trackIdentity");

test("track identity text matches track memory and graph normalization", () => {
  assert.equal(normalizeTrackIdentityText("M.Ö.S. & Friends"), "m o s and friends");
  assert.equal(normalizeTrackIdentityText("  City   Lights  "), "city lights");
});

test("normalized track key prefers TIDAL URL and falls back to artist title", () => {
  assert.equal(
    normalizedTrackKey({ tidalUrl: "HTTPS://TIDAL.COM/BROWSE/TRACK/123" }),
    "https://tidal.com/browse/track/123"
  );
  assert.equal(
    normalizedTrackKey({ artist: "M.Ö.S. & Friends", title: "City Lights" }),
    "m o s and friends|city lights"
  );
});
