"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDiscoveryProfile,
  candidateIdentityKeys,
  rejectReason,
  scoreBreakdownFor
} = require("../src/discoveryEngine");

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

test("genre style parenthetical with ampersand is rejected as SEO sludge", () => {
  const options = {
    request: "Find underground melodic house tracks",
    genres: "melodic house",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Max Oazo, Moonessa",
    title: "Once Upon A Time (Melodic House & Techno Mix)",
    album: "Once Upon A Time (Melodic House & Techno Mix)",
    label: "Moonessa Music",
    durationMs: 328000,
    query: "melodic house underground"
  }, options, profile);

  assert.match(reason, /genre\/style descriptor keywords/i);
});

test("candidate identity collapses SEO genre parentheticals without collapsing remix titles", () => {
  const base = {
    artist: "Max Oazo, Moonessa",
    title: "Once Upon A Time"
  };
  const seoTitle = {
    artist: "Max Oazo, Moonessa",
    title: "Once Upon A Time (Melodic House & Techno Mix)"
  };
  const remixTitle = {
    artist: "DNA Presents",
    title: "Ecstasy (CM Low Gear Remix)"
  };
  const remixBase = {
    artist: "DNA Presents",
    title: "Ecstasy"
  };

  const baseKeys = new Set(candidateIdentityKeys(base));
  assert.ok(candidateIdentityKeys(seoTitle).some((key) => baseKeys.has(key)));
  assert.equal(candidateIdentityKeys(remixTitle).some((key) => candidateIdentityKeys(remixBase).includes(key)), false);
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

test("acid house requests reject generic house without acid evidence", () => {
  const options = {
    request: "Find acid house with organic textures and hypnotic rhythms",
    genres: "Acid house",
    years: "2020-2026",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);

  assert.equal(profile.targetGenres.includes("acid house"), true);
  assert.equal(profile.targetGenres.includes("house"), false);

  const reason = rejectReason({
    artist: "Sidney Charles",
    title: "House 2 Heal",
    album: "House 2 Heal",
    label: "Moxy Muzik",
    genre: "House",
    year: 2023,
    releaseEvidence: { albumYear: true },
    durationMs: 390000,
    query: "acid house 2023"
  }, options, profile);

  assert.match(reason, /acid house requested/i);
});

test("acid house requests accept acid or 303 metadata evidence", () => {
  const options = {
    request: "Find acid house with organic textures and hypnotic rhythms",
    genres: "Acid house",
    years: "2020-2026",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Tin Man",
    title: "Nonneo",
    album: "Acid Test 19",
    label: "Acid Test",
    genre: "Electronic",
    year: 2024,
    releaseEvidence: { albumYear: true },
    durationMs: 430000,
    query: "acid house 2024"
  }, options, profile);

  assert.equal(reason, "");
});

test("multi-genre music-channel artists are rejected as SEO sludge", () => {
  const options = {
    request: "Find acid house with organic textures and hypnotic rhythms",
    genres: "Acid house",
    years: "2020-2026",
    scoringMode: "pure"
  };
  const profile = buildDiscoveryProfile(options);

  const reason = rejectReason({
    artist: "Deep House Lounge, Minimal House Nation, Nightlife Music Zone",
    title: "The Hypnotic Collision of Our World",
    album: "Prime Evening: Cooling Down Until Tomorrow's Arrival",
    label: "Ethereal Rest Foundation",
    year: 2024,
    releaseEvidence: { albumYear: true },
    durationMs: 194000,
    query: "acid house hypnotic 2024"
  }, options, profile);

  assert.match(reason, /genre\/SEO catalogue filler/i);
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

test("requested vibe traits are weak when they only appear in the search query", () => {
  const options = {
    request: "Find psychedelic cosmic hypnotic progressive house tracks",
    genres: "progressive house",
    mood: "psychedelic cosmic hypnotic",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const breakdown = scoreBreakdownFor({
    artist: "Low Detail Artist",
    title: "Plain Horizon",
    album: "Plain Horizon",
    label: "Anjunadeep",
    genre: "Electronic",
    durationMs: 420000,
    query: "psychedelic cosmic hypnotic progressive house"
  }, options, null, profile);

  assert.equal(breakdown.vibeInference.queryOnly, true);
  assert.equal(breakdown.vibeInference.corroboratesRequested, false);
  assert.ok(breakdown.vibeInference.confidence <= 15);
  assert.ok(breakdown.vibeInference.evidence.every((item) => item.queryOnly));
});

test("requested vibe traits score higher when metadata corroborates them", () => {
  const options = {
    request: "Find psychedelic cosmic hypnotic progressive house tracks",
    genres: "progressive house",
    mood: "psychedelic cosmic hypnotic",
    scoringMode: "taste-guided"
  };
  const profile = buildDiscoveryProfile(options);
  const queryOnly = scoreBreakdownFor({
    artist: "Low Detail Artist",
    title: "Plain Horizon",
    album: "Plain Horizon",
    label: "Anjunadeep",
    genre: "Electronic",
    durationMs: 420000,
    query: "psychedelic cosmic hypnotic progressive house"
  }, options, null, profile);
  const metadata = scoreBreakdownFor({
    artist: "Deep Signal",
    title: "Cosmic Hypnotic Ritual",
    album: "Psychedelic Spacey Forms",
    label: "Anjunadeep",
    genre: ["Progressive House", "Cosmic"],
    durationMs: 444000,
    query: "progressive house"
  }, options, null, profile);

  assert.equal(metadata.vibeInference.queryOnly, false);
  assert.equal(metadata.vibeInference.corroboratesRequested, true);
  assert.ok(metadata.vibeInference.confidence >= queryOnly.vibeInference.confidence + 40);
  assert.ok(metadata.genreMatch > queryOnly.genreMatch);
  assert.match(metadata.vibeInference.summary, /cosmic|hypnotic|psychedelic/i);
});
