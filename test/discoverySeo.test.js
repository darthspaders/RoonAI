"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDiscoveryProfile, rejectReason, scoreBreakdownFor } = require("../src/discoveryEngine");

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

test("genre style descriptor title is rejected as SEO sludge", () => {
  const options = {
    request: "Find adventurous progressive house tracks",
    genres: "progressive house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "KAI Music",
    title: "A New Birth (Emotional Melodic EDM / Progressive House)",
    album: "A New Birth (Emotional Melodic EDM / Progressive House)",
    label: "",
    durationMs: 202000,
    query: "progressive house"
  }, options, profile);

  assert.match(reason, /genre\/style descriptor keywords/i);
});

test("functional music catalogue results are rejected as SEO sludge", () => {
  const options = {
    request: "Find progressive house tracks with great synths and basslines",
    genres: "progressive house",
    years: "2020-2026",
    mood: "hypnotic, driving",
    scoringMode: "explore"
  };
  const profile = buildDiscoveryProfile(options);
  const releaseEvidence = { albumYear: 2026, isrcYear: 2026 };
  const examples = [
    {
      artist: "Programming and Coding Music Club",
      title: "Progressive House Music for Programming",
      album: "Progressive House Music for Programming 2",
      label: "Silgoa",
      year: 2020,
      releaseEvidence
    },
    {
      artist: "RELAXING MUSIC, Sleeping Music, Studying Music For Focus",
      title: "Chakra Healing Music for Energy Balance and Deep Meditation",
      album: "Relaxing Music for Sleep, Meditation, Focus, Stress Relief, Anxiety Reduction, Inner Peace and Emotional Healing",
      label: "Neuroversal Studios",
      year: 2026,
      releaseEvidence
    },
    {
      artist: "Chill House Music Café, Chill Music House",
      title: "Midnight Chill House - Piano Deep House Instrumental for Late Night Café",
      album: "Deep Chill House Instrumental Music for Café and Relaxation",
      label: "Public Domain",
      year: 2026,
      releaseEvidence
    }
  ];

  for (const track of examples) {
    assert.match(rejectReason(track, options, profile), /functional\/background music/i);
  }
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
    genre: "Electronic",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 417000,
    query: "psytrance 2026"
  }, options, profile);

  assert.equal(reason, "");
});

test("genre inference treats vague official genre tags as weak hints", () => {
  const options = {
    request: "Find progressive house from 2025",
    genres: "progressive house",
    years: "2025",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const breakdown = scoreBreakdownFor({
    artist: "Romain Garcia",
    title: "Alone",
    album: "Alone",
    label: "Anjunadeep",
    genre: "Electronic",
    year: 2025,
    releaseEvidence: { albumYear: true },
    durationMs: 420000,
    query: "progressive house 2025"
  }, options, null, profile);

  assert.equal(breakdown.genreInference.weakOfficialGenre, true);
  assert.equal(breakdown.genreInference.corroboratesRequested, true);
  assert.ok(breakdown.genreInference.confidence >= 45);
  assert.ok(breakdown.genreMatch >= 10);
});

test("Darth ratings support genre inference but cannot rescue query-only genre evidence", () => {
  const options = {
    request: "Find underground driving psytrance tracks from 2026",
    genres: "psytrance",
    mood: "underground, driving",
    years: "2026",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const track = {
    artist: "Ocean Trail",
    title: "At Your Feet",
    album: "Ocean Trail",
    label: "Ocean Trail",
    genre: "Electronic",
    year: 2026,
    releaseEvidence: { albumYear: true },
    durationMs: 280000,
    query: "psytrance underground driving 2026"
  };
  const fakeTaste = {
    read() {
      return {
        artists: {
          "ocean trail": { name: "Ocean Trail", score: 10 }
        },
        labels: {},
        feedback: {},
        candidates: {}
      };
    }
  };
  const breakdown = scoreBreakdownFor(track, options, fakeTaste, profile);

  assert.equal(breakdown.genreInference.queryOnly, true);
  assert.equal(breakdown.genreInference.corroboratesRequested, false);
  assert.match(rejectReason(track, options, profile), /genre appears only in the search query/i);
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
