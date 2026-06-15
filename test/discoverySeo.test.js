"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDiscoveryProfile, rejectReason } = require("../src/discoveryEngine");

test("genre date catalogue filler is rejected as SEO sludge", () => {
  const options = {
    request: "Find adventurous melodic techno tracks",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Crizpy7",
    title: "C7 Deep Tech House Fusions 10-2025 Vi",
    album: "C7 Deep Tech House Fusions 10-2025",
    label: "Crizpy7",
    year: 2025,
    durationMs: 421000,
    query: "melodic techno 2025"
  }, options, profile);

  assert.match(reason, /seo genre\/date catalogue filler/i);
});

test("genre year mix compilation filler is rejected before scoring", () => {
  const options = {
    request: "Find 2026 deep house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Vocalo",
    title: "Deep House Mix 2026 Vol.2",
    album: "Ocean Breeze Grooves, Smooth Deep House Waves for Summer Nights & Beach Vibes",
    label: "Deep House Music",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 356000,
    query: "deep house 2026"
  }, options, profile);

  assert.match(reason, /catalogue filler/i);
});

test("requested genre must be corroborated by metadata, not only the search query", () => {
  const options = {
    request: "Find underground driving psytrance tracks from 2026",
    genres: "psytrance",
    mood: "underground, driving",
    years: "2026",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Ocean Trail",
    title: "At Your Feet",
    album: "Ocean Trail",
    label: "Ocean Trail",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 280000,
    query: "psytrance underground driving 2026"
  }, options, profile);

  assert.match(reason, /genre appears only in the search query/i);
});

test("known genre label can corroborate a genre even when the title has no genre words", () => {
  const options = {
    request: "Find psytrance from 2026",
    genres: "psytrance",
    years: "2026",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Liquid Soul",
    title: "Oblivion",
    album: "Oblivion",
    label: "Iboga Records",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 417000,
    query: "psytrance 2026"
  }, options, profile);

  assert.equal(reason, "");
});

test("adjacent lane query terms must be corroborated by metadata", () => {
  const options = {
    request: "Find psytrance from 2026",
    genres: "psytrance",
    years: "2026",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Soft Horizon",
    title: "Sunrise Steps",
    album: "Sunrise Steps",
    label: "",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 362000,
    discoveryLane: "adjacent",
    query: "goa trance 2026"
  }, options, profile);

  assert.match(reason, /adjacent-lane genre appears only in the search query/i);
});

test("progressive house scene labels still corroborate progressive house", () => {
  const options = {
    request: "Find progressive house from 2025",
    genres: "progressive house",
    years: "2025",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Romain Garcia",
    title: "Alone",
    album: "Alone",
    label: "Anjunadeep",
    year: 2025,
    releaseEvidence: { albumYear: true },
    durationMs: 204000,
    query: "progressive house 2025"
  }, options, profile);

  assert.equal(reason, "");
});
