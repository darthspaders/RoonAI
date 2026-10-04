"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  candidateIdentityKeys,
  discoverTracks
} = require("../src/discoveryEngine");

const OPTIONS = {
  request: "Find progressive trance tracks at least 7 minutes with hypnotic, melodic, driving energy and minimal vocals",
  genres: "progressive trance",
  count: 4,
  minDurationMinutes: 7,
  mood: "hypnotic, melodic, driving",
  scoringMode: "taste-guided"
};

function track(overrides = {}) {
  return {
    album: overrides.title,
    year: 2020,
    releaseDate: "2020-01-01",
    discoverySource: "deterministic admission fixture",
    ...overrides
  };
}

const CASES = [
  {
    id: "john-00-fleming-corruption",
    expected: "accepted",
    track: track({
      artist: "John 00 Fleming, Fuenka",
      title: "Corruption",
      label: "JOOF Recordings, UK",
      genre: [],
      durationMs: 17 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/416624238",
      query: "John 00 Fleming progressive trance"
    })
  },
  {
    id: "airwave-tunnel-of-freedom",
    expected: "accepted",
    track: track({
      artist: "Airwave",
      title: "Tunnel of Freedom",
      label: "Airwave Music",
      genre: ["Progressive Trance"],
      durationMs: 8 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/376896502",
      query: "Airwave progressive trance"
    })
  },
  {
    id: "solarstone-seven-cities",
    expected: "accepted",
    track: track({
      artist: "Solarstone",
      title: "Seven Cities",
      label: "Black Hole Recordings",
      genre: ["Progressive Trance"],
      durationMs: 7.5 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/16096144",
      query: "Solarstone progressive trance"
    })
  },
  {
    id: "forerunners-fear-is-the-mind-killer",
    expected: "accepted",
    track: track({
      artist: "Forerunners",
      title: "Fear Is the Mind Killer",
      label: "JOOF Recordings",
      genre: ["Progressive Trance"],
      durationMs: 8.5 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/179791105",
      query: "Forerunners progressive trance"
    })
  },
  {
    id: "geomagnetic-seo-sludge",
    expected: "rejected",
    rejectionStage: "catalogue-quality",
    track: track({
      artist: "Geomagnetic",
      title: "Top 100 Best Selling Chart Hits",
      label: "Generic Records",
      genre: ["Progressive Trance"],
      durationMs: 10 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/admission-bad-1",
      query: "progressive trance"
    })
  },
  {
    id: "fake-genre-artist",
    expected: "rejected",
    rejectionStage: "catalogue-quality",
    track: track({
      artist: "Progressive Trance",
      title: "Hypnotic Driving Music",
      label: "Generic Records",
      genre: ["Progressive Trance"],
      durationMs: 10 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/admission-bad-2",
      query: "progressive trance"
    })
  },
  {
    id: "short-track",
    expected: "rejected",
    rejectionStage: "duration-constraints",
    track: track({
      artist: "Airwave",
      title: "Short Build",
      label: "Airwave Music",
      genre: ["Progressive Trance"],
      durationMs: 6 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/admission-bad-3",
      query: "progressive trance"
    })
  },
  {
    id: "wrong-artist",
    expected: "rejected",
    rejectionStage: "identity-correctness",
    track: track({
      artist: "The Beatles",
      title: "Hey Jude",
      album: "Hey Jude",
      label: "Parlophone",
      genre: ["Rock"],
      durationMs: 7.2 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/admission-bad-4",
      query: "Solarstone progressive trance"
    })
  },
  {
    id: "continuous-compilation-copy",
    expected: "rejected",
    rejectionStage: "catalogue-quality",
    track: track({
      artist: "Gai Barone",
      title: "Pure Trance 4 Continuous Mix 1",
      album: "Pure Trance 4",
      label: "Black Hole Recordings",
      genre: ["Progressive Trance"],
      durationMs: 60 * 60 * 1000,
      tidalUrl: "https://tidal.com/browse/track/admission-bad-5",
      query: "progressive trance"
    })
  }
];

function resultFor(result, fixture) {
  const matches = [
    ...(result.tracks || []),
    ...(result.alternates || []),
    ...(result.discarded || [])
  ];
  return matches.find((candidate) => (
    candidate.artist === fixture.artist && candidate.title === fixture.title
  )) || null;
}

function traceFor(result, fixture) {
  return (result.verification?.poolDiagnostics?.candidateAccumulation?.durationCandidates || [])
    .find((candidate) => candidate.artist === fixture.artist && candidate.title === fixture.title) || null;
}

function stageResult(result, caseDefinition) {
  const fixture = caseDefinition.track;
  const candidate = resultFor(result, fixture);
  const trace = traceFor(result, fixture);
  const admission = candidate?.admissionDiagnostics || {};
  const catalogue = admission.catalogueQuality || trace?.qualityResult?.catalogue || {};
  const identity = admission.identityCorrectness || trace?.qualityResult?.identity || {};
  const duration = admission.durationConstraints || trace?.durationResult || {};
  const genre = admission.genreLaneCompatibility || trace?.qualityResult?.genre || {};
  const finalSelected = (result.tracks || []).some((item) => (
    item.artist === fixture.artist && item.title === fixture.title
  ));
  const noveltyStatus = trace?.noveltyResult?.status || "";
  const noveltyPassed = trace
    ? ["fresh", "selected", "alternate", "selected-fallback"].includes(noveltyStatus)
      ? true
      : (noveltyStatus === "held-back" ? false : null)
    : null;
  const rejectionStage = candidate?.rejectionStage || trace?.droppedStage || admission.rejectionStage || "";
  const candidateAccumulationAccepted = trace
    ? trace.candidateAccumulationAccepted === true
    : Boolean(candidate && !candidate.rejectionStage);
  const rejectionReason = candidateAccumulationAccepted
    ? ""
    : (candidate?.reason || trace?.droppedReason || admission.hardFailReason || "");

  return {
    id: caseDefinition.id,
    artist: fixture.artist,
    title: fixture.title,
    expectedOutcome: caseDefinition.expected,
    catalogueQualityPassed: catalogue.passed === true,
    identityPassed: identity.passed === true,
    durationPassed: duration.passed === true || duration.status === "passed",
    genrePassed: genre.passed === true,
    noveltyPassed,
    candidateAccumulationAccepted,
    finalSelected,
    rejectionStage,
    rejectionReason
  };
}

test("deterministic Progressive Trance admission accepts known-good tracks and rejects controls", async () => {
  let searchCalls = 0;
  const result = await discoverTracks({
    tidal: {
      isConfigured: () => true,
      async searchTracks() {
        searchCalls += 1;
        throw new Error("direct admission harness must bypass TIDAL search planning");
      }
    },
    options: OPTIONS,
    history: null,
    directCandidates: CASES.map((item) => item.track)
  });

  assert.equal(searchCalls, 0);
  assert.equal(result.tracks.length, 4);

  const logs = CASES.map((item) => stageResult(result, item));
  for (const entry of logs) console.log(JSON.stringify(entry));

  const accepted = logs.filter((entry) => entry.expectedOutcome === "accepted");
  const rejected = logs.filter((entry) => entry.expectedOutcome === "rejected");
  assert.equal(accepted.filter((entry) => entry.candidateAccumulationAccepted).length, 4);
  assert.equal(accepted.filter((entry) => entry.finalSelected).length, 4);
  assert.equal(rejected.filter((entry) => !entry.candidateAccumulationAccepted && !entry.finalSelected).length, 5);
  assert.ok(rejected.every((entry) => entry.rejectionStage));
  assert.deepEqual(
    Object.fromEntries(rejected.map((entry) => [entry.id, entry.rejectionStage])),
    Object.fromEntries(CASES.filter((item) => item.expected === "rejected").map((item) => [item.id, item.rejectionStage]))
  );

  const pool = result.verification.poolDiagnostics.candidateAccumulation;
  assert.equal(pool.rawCandidates, CASES.length);
  assert.equal(pool.uniqueCandidatesBeforeSelection, 4);
  assert.equal(pool.validDurationCandidatesBeforeSelection, 4);
  assert.equal(pool.durationCandidates.length, 8);
  assert.equal(result.tracks.some((item) => /Top 100|Continuous Mix|Hey Jude|Hypnotic Driving Music/.test(item.title)), false);
  assert.equal(result.tracks.some((item) => item.durationMs < 7 * 60 * 1000), false);
  assert.equal(result.verification.poolDiagnostics.finalSelection.selected, 4);
  assert.equal(candidateIdentityKeys(result.tracks[0]).length > 0, true);
});
