"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildDiscoveryProfile, rejectReason } = require("../src/discoveryEngine");
const { TasteProfile } = require("../src/tasteProfile");

function psyProfile() {
  const options = {
    request: "Find psytrance",
    scoringMode: "explore"
  };
  return {
    options,
    profile: buildDiscoveryProfile(options)
  };
}

function tempTasteFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-taste-"));
  return path.join(dir, "taste-profile.json");
}

test("scene artist name collision is rejected without scene metadata", () => {
  const { options, profile } = psyProfile();
  const reason = rejectReason({
    artist: "Freedom Fighters",
    title: "At Your Feet",
    album: "Freedom Fighters",
    label: "Freedom Fighters",
    durationMs: 280000,
    query: "Freedom Fighters psytrance 2025"
  }, options, profile);

  assert.match(reason, /artist name matches freedom fighters/i);
});

test("scene artist anchor is allowed with scene label corroboration", () => {
  const { options, profile } = psyProfile();
  const reason = rejectReason({
    artist: "Freedom Fighters",
    title: "Tribalistic",
    album: "Tribalistic",
    label: "Shamanic Tales",
    durationMs: 460000,
    query: "Freedom Fighters psytrance 2025"
  }, options, profile);

  assert.equal(reason, "");
});

test("never again on an ambiguous scene-anchor collision does not downrank the real artist", () => {
  const taste = new TasteProfile(tempTasteFile());
  const wrongTrack = {
    artist: "Freedom Fighters",
    title: "At Your Feet",
    album: "Freedom Fighters",
    label: "Freedom Fighters",
    tidalUrl: "https://tidal.com/browse/track/wrong-freedom-fighters"
  };

  const saved = taste.record(wrongTrack, "never");
  const profile = taste.read();
  const artistEntry = profile.artists.freedomfighters || profile.artists["freedom fighters"];
  const adjustment = taste.adjustmentFor({
    artist: "Freedom Fighters",
    title: "Tribalistic",
    label: "Shamanic Tales"
  });

  assert.equal(saved.feedback.rating, "never");
  assert.equal(saved.feedback.artistSignalBlocked, true);
  assert.equal(artistEntry, undefined);
  assert.equal(adjustment.value, 0);
  assert.equal(taste.getFeedbackFor(wrongTrack), "never");
});

test("wrong genre feedback records prompt mismatch without taste penalty", () => {
  const taste = new TasteProfile(tempTasteFile());
  const track = {
    artist: "Liquid Soul",
    title: "A Great Track For Another Prompt",
    label: "Iboga Records",
    tidalUrl: "https://tidal.com/browse/track/wrong-genre-example"
  };

  const saved = taste.record(track, "not what I asked for");
  const profile = taste.read();
  const adjustment = taste.adjustmentFor(track);

  assert.equal(saved.feedback.rating, "wrong_genre");
  assert.equal(saved.feedback.promptMismatch, true);
  assert.equal(saved.feedback.artistSignalBlocked, true);
  assert.equal(profile.artists["liquid soul"], undefined);
  assert.equal(profile.labels["iboga records"], undefined);
  assert.equal(adjustment.value, 0);
  assert.equal(taste.getFeedbackFor(track), "wrong_genre");
});
