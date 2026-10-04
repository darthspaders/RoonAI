"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyRow } = require("../scripts/audit-sonic-training-candidates");

test("sonic-training audit flags technical or unidentified files for review", () => {
  const result = classifyRow({
    id: 1,
    file_path: "Z:\\Music\\Falls Away (Master) OPT.wav",
    file_hash: "a".repeat(64),
    artist: "",
    title: "",
    album: "",
    duration_ms: 300000,
    profile_count: 1
  });

  assert.equal(result.disposition, "EXCLUDE_FROM_TASTE_TRAINING_REVIEW");
  assert.ok(result.reasons.some((reason) => reason.code === "MISSING_IDENTITY"));
});

test("sonic-training audit keeps plausible music while surfacing mix cuts", () => {
  const result = classifyRow({
    id: 2,
    file_path: "Z:\\Music\\Artist\\Track.flac",
    file_hash: "b".repeat(64),
    artist: "Artist",
    title: "Track (Mixed by DJ)",
    album: "Compilation",
    duration_ms: 240000,
    profile_count: 0
  });

  assert.equal(result.disposition, "REVIEW");
  assert.ok(result.reasons.some((reason) => reason.code === "LONG_FORM_OR_BROADCAST"));
});

test("sonic-training audit does not flag an ordinary track", () => {
  const result = classifyRow({
    id: 3,
    file_path: "Z:\\Music\\Artist\\Track.flac",
    file_hash: "c".repeat(64),
    artist: "Artist",
    title: "Track",
    album: "Album",
    duration_ms: 360000,
    profile_count: 1
  });

  assert.equal(result.disposition, "KEEP_PENDING_QUALITATIVE_REVIEW");
  assert.deepEqual(result.reasons, []);
});
