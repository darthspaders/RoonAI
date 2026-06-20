"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildDiscoveryProfile,
  rejectReason,
  releaseFilterRequiresVerification,
  scoreBreakdownFor
} = require("../src/discoveryEngine");
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

test("pure artist search rejects liked-artist drift", () => {
  const options = {
    request: "find more tracks lby Rafael Osmo",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);

  const wrongArtistReason = rejectReason({
    artist: "Guy J",
    title: "Surreal",
    album: "Early Morning",
    label: "Early Morning",
    durationMs: 486000,
    query: "Guy J progressive trance 2025"
  }, options, profile);
  const requestedArtistReason = rejectReason({
    artist: "Rafael Osmo",
    title: "Renaissance",
    album: "Renaissance",
    label: "Create Music",
    durationMs: 420000,
    query: "Rafael Osmo progressive trance 2025"
  }, options, profile);

  assert.match(wrongArtistReason, /pure search requested Rafael Osmo/i);
  assert.doesNotMatch(requestedArtistReason, /pure search requested/i);
});

test("pure artist search treats exact requested artist as the hard constraint", () => {
  const options = {
    request: "find more tracks by Rafael Osmo",
    genres: "progressive house, progressive trance, deep progressive",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Rafael Osmo",
    title: "Cure",
    album: "",
    label: "",
    durationMs: 420000,
    query: "Rafael Osmo progressive trance"
  }, options, profile);

  assert.equal(reason, "");
});

test("taste-guided artist queries can branch when scene metadata corroborates the result", () => {
  const options = {
    request: "Find fresh underground progressive house tracks released this year",
    genres: "progressive house",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Emi Galvan",
    title: "Everlong",
    album: "Everlong / Lies",
    label: "Mango Alley",
    year: 2026,
    releaseDate: "2026-02-13",
    releaseEvidence: { albumYear: 2026, albumDate: "2026-02-13" },
    durationMs: 470000,
    query: "Ruben Karapetyan 2026"
  }, options, profile);

  assert.equal(reason, "");
});

test("explicit release filters require verified release evidence", () => {
  const options = {
    request: "find tracks this year",
    genres: "progressive house",
    releasePreset: "thisYear",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);

  assert.equal(releaseFilterRequiresVerification(options), true);
  assert.equal(profile.hasExplicitDiscoveryIntent, true);

  const reason = rejectReason({
    artist: "Roger Martinez",
    title: "Unbelievable",
    album: "Unbelievable",
    label: "Some Label",
    durationMs: 420000,
    year: 2026,
    query: "Roger Martinez 2026",
    roon: { verified: true }
  }, options, profile);

  assert.match(reason, /No canonical TIDAL album\/track\/ISRC release year/i);
});

test("Taste Guided caps familiar artist boost when the prompt has explicit intent", () => {
  const options = {
    request: "find progressive house tracks this year",
    genres: "progressive house",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const taste = {
    adjustmentFor() {
      return { value: 12, reasons: ["Guy J +12"] };
    }
  };

  const breakdown = scoreBreakdownFor({
    artist: "Guy J",
    title: "A New Track",
    album: "A New Track",
    label: "Early Morning",
    durationMs: 420000,
    year: 2026,
    releaseDate: "2026-04-10",
    releaseEvidence: { albumDate: true },
    query: "Guy J 2026"
  }, options, taste, profile);

  assert.equal(profile.hasExplicitDiscoveryIntent, true);
  assert.equal(breakdown.tasteAdjustment, 4);
});
