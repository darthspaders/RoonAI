"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  scoreSonicNeighborSecondStage
} = require("../src/sonicNeighborSecondStage");

test("second-stage scorer rejects a malformed long-duration source while preserving raw cosine", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:amelie", artist: "Amelie Lens", title: "Anchor", genre: "Techno", durationMs: 360000 },
    candidate: {
      identityKey: "file:bad-tiesto",
      artist: "Tiestio",
      title: "Title2",
      genre: "Techno",
      durationMs: 128 * 60 * 1000,
      sourcePath: "C:/temp/title2.mp3"
    },
    rawSimilarity: 0.82
  });

  assert.equal(result.accepted, false);
  assert.equal(result.exclusionReason, "suspicious-source-metadata");
  assert.equal(result.rawSimilarity, 0.82);
  assert.equal(result.adjustedScore < 0.82, true);
  assert.equal(result.rulesFired.includes("source-duration-limit"), true);
  assert.equal(result.rulesFired.includes("generic-title"), true);
});

test("second-stage scorer reduces a high-cosine long-form progressive to short pop-house mismatch", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: {
      identityKey: "tidal:opus",
      artist: "Eric Prydz",
      title: "Opus",
      genre: "Progressive House",
      durationMs: 540000,
      mixVersion: "Original Mix"
    },
    candidate: {
      identityKey: "tidal:bad-habits",
      artist: "Ed Sheeran",
      title: "Bad Habits (MEDUZA Remix)",
      genre: "Pop House",
      durationMs: 210000,
      mixVersion: "Remix"
    },
    rawSimilarity: 0.84
  });

  assert.equal(result.accepted, true);
  assert.equal(result.rawSimilarity, 0.84);
  assert.equal(result.adjustedScore < 0.65, true);
  assert.equal(result.rulesFired.includes("long-form-vs-short-form"), true);
  assert.equal(result.rulesFired.includes("genre-lane-compatible"), true);
  assert.equal(result.penalties.some((item) => item.rule === "arrangement-duration"), true);
});

test("second-stage scorer rejects low-similarity cross-genre rows", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:justice", artist: "Justice", title: "Genesis", genre: "Electro House" },
    candidate: { identityKey: "tidal:nin", artist: "Nine Inch Nails", title: "The Hand That Feeds", genre: "Industrial Rock" },
    rawSimilarity: 0.68
  });

  assert.equal(result.accepted, false);
  assert.equal(result.exclusionReason, "low-sim-cross-genre");
  assert.equal(result.rawSimilarity, 0.68);
  assert.deepEqual(result.genreCompatibility.genreEvidenceStrength, { anchor: "strong", candidate: "strong" });
  assert.equal(result.genreCompatibility.genreConflictConfidence, "high");
  assert.equal(result.genreCompatibility.sceneSoftenedPenalty, false);
  assert.equal(result.rulesFired.includes("low-sim-cross-genre-rejected"), true);
});

test("review-history evidence is a bounded second-stage signal", () => {
  const keep = scoreSonicNeighborSecondStage({
    anchor: { artist: "A", title: "Anchor" },
    candidate: { identityKey: "tidal:keep", artist: "B", title: "Keep" },
    rawSimilarity: 0.7,
    reviewHistory: { decision: "STRONG_KEEP" }
  });
  const ambiguous = scoreSonicNeighborSecondStage({
    anchor: { artist: "A", title: "Anchor" },
    candidate: { identityKey: "tidal:ambiguous", artist: "B", title: "Ambiguous" },
    rawSimilarity: 0.7,
    reviewHistory: { decision: "AMBIGUOUS" }
  });

  assert.equal(keep.reviewHistory.evidence.includes("positive-review-history"), true);
  assert.equal(ambiguous.reviewHistory.evidence.includes("ambiguous-review-history"), true);
  assert.equal(keep.adjustedScore > ambiguous.adjustedScore, true);
  assert.equal(keep.shadowOnly, true);
  assert.equal(keep.productionApplied, false);
});

test("second-stage scorer honors fresh-only exposure without padding", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { artist: "A", title: "Anchor", genre: "Techno" },
    candidate: { identityKey: "tidal:known", artist: "B", title: "Known", genre: "Techno", previouslyQueued: true },
    rawSimilarity: 0.8,
    input: { discoveryIntent: "discovery", noveltyPolicy: "FRESH_ONLY" }
  });

  assert.equal(result.accepted, false);
  assert.equal(result.exclusionReason, "known-candidate-fresh-only");
  assert.equal(result.rulesFired.includes("fresh-only-known-candidate"), true);
});

test("second-stage scorer separates same-recording duplicates from related versions", () => {
  const duplicate = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:anchor", artist: "Artist", title: "Track", isrc: "US-AAA-00-00001" },
    candidate: { identityKey: "file:alias", artist: "Artist", title: "Track", isrc: "US-AAA-00-00001" },
    rawSimilarity: 0.95
  });
  const version = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:anchor", artist: "Artist", title: "Track", isrc: "US-AAA-00-00001" },
    candidate: { identityKey: "tidal:remix", artist: "Artist", title: "Track (Remix)", isrc: "US-AAA-00-00001" },
    rawSimilarity: 0.9
  });

  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.exclusionReason, "known-duplicate-recording");
  assert.equal(version.accepted, true);
  assert.equal(version.exclusionReason, "");
  assert.equal(version.rulesFired.includes("same-isrc"), true);
});

test("sparse inferred genre evidence becomes a weak conflict instead of a hard mismatch", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:bicep", artist: "Bicep", title: "Apricots", genre: "Progressive House", durationMs: 300000 },
    candidate: { identityKey: "tidal:3lau", artist: "3LAU", title: "We Came To Bang", durationMs: 290000 },
    rawSimilarity: 0.876,
    genreResolver: ({ track }) => track.identityKey === "tidal:3lau"
      ? { inferred: [{ value: "Pop", source: "artist-history", confidence: "compatible" }] }
      : { inferred: [] }
  });

  assert.equal(result.genreCompatibility.relationship, "weak-conflict");
  assert.equal(result.genreCompatibility.confidence.candidate, "compatible");
  assert.deepEqual(result.genreCompatibility.genreEvidenceStrength, { anchor: "strong", candidate: "weak" });
  assert.equal(result.genreCompatibility.genreConflictConfidence, "low");
  assert.equal(result.genreCompatibility.inferredGenreMetadata.candidate[0].value, "Pop");
  assert.deepEqual(result.genreCompatibility.inferenceSource.candidate, ["artist-history"]);
  assert.equal(result.genreCompatibility.adjustment, -0.1);
  assert.equal(result.arrangementCompatibility.adjustment, 0);
  assert.equal(result.rulesFired.includes("genre-lane-weak-conflict"), true);
  assert.equal(result.rulesFired.includes("duration-bonus-suppressed-by-genre-uncertainty"), true);
  assert.equal(result.adjustedScore < result.rawSimilarity, true);
});

test("scene evidence softens asymmetric melodic-house and melodic-techno conflict", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: {
      identityKey: "tidal:nova",
      artist: "Tale Of Us",
      title: "Nova",
      durationMs: 420000
    },
    candidate: {
      identityKey: "tidal:upperground",
      artist: "ARTBAT",
      title: "Upperground",
      durationMs: 425000
    },
    rawSimilarity: 0.835,
    reviewHistory: { decision: "STRONG_KEEP" },
    genreResolver: ({ track }) => track.identityKey === "tidal:nova"
      ? { inferred: [{ value: "Progressive House", source: "artist-history", confidence: "uncertain" }] }
      : { inferred: [{ value: "Melodic Techno", source: "beatport-enrichment", confidence: "compatible" }] }
  });

  assert.equal(result.accepted, true);
  assert.equal(result.genreCompatibility.relationship, "uncertain");
  assert.deepEqual(result.genreCompatibility.genreEvidenceStrength, { anchor: "weak", candidate: "strong" });
  assert.equal(result.genreCompatibility.genreConflictConfidence, "low");
  assert.equal(result.genreCompatibility.sceneSoftenedPenalty, true);
  assert.equal(result.genreCompatibility.sceneEvidenceUsed.includes("shared-melodic-progressive-neighborhood"), true);
  assert.equal(result.genreCompatibility.adjustment, -0.08);
  assert.equal(result.arrangementCompatibility.adjustment, 0);
  assert.equal(result.adjustedScore < result.rawSimilarity, true);
});

test("unknown genre is an uncertainty penalty and cannot receive a duration bonus", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:a", artist: "A", title: "Anchor", durationMs: 300000 },
    candidate: { identityKey: "tidal:b", artist: "B", title: "Candidate", durationMs: 310000 },
    rawSimilarity: 0.8,
    secondStageConfig: { genreAdjustments: { uncertain: -0.13 } }
  });

  assert.equal(result.genreCompatibility.relationship, "uncertain");
  assert.equal(result.genreCompatibility.adjustment, -0.13);
  assert.equal(result.arrangementCompatibility.adjustment, 0);
  assert.equal(result.rulesFired.includes("genre-lane-uncertain"), true);
  assert.equal(result.rulesFired.includes("duration-bonus-suppressed-by-genre-uncertainty"), true);
});

test("shared primary genre family prevents noisy secondary tags from creating strong conflict", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:a", artist: "A", title: "Anchor", genre: "House", durationMs: 300000 },
    candidate: { identityKey: "tidal:b", artist: "B", title: "Candidate", genre: "House", subgenre: "Industrial Rock", durationMs: 305000 },
    rawSimilarity: 0.84
  });

  assert.equal(result.genreCompatibility.relationship, "compatible");
  assert.equal(result.genreCompatibility.confidence.candidate, "conflicting");
  assert.deepEqual(result.genreCompatibility.sharedFamilies, ["house"]);
  assert.deepEqual(result.genreCompatibility.conflictingFamilies.candidateOnly, ["rock"]);
  assert.equal(result.genreCompatibility.genreConflictConfidence, "medium");
  assert.equal(result.genreCompatibility.sceneSoftenedPenalty, false);
  assert.equal(result.arrangementCompatibility.adjustment, 0.03);
  assert.equal(result.rulesFired.includes("genre-lane-compatible"), true);
});

test("genre compatibility uses the full bonus only when both sides have strong evidence", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { artist: "A", title: "Anchor", genre: "House, Techno" },
    candidate: { artist: "B", title: "Candidate", genre: "House" },
    rawSimilarity: 0.8
  });
  assert.equal(result.genreCompatibility.relationship, "compatible");
  assert.equal(result.genreCompatibility.adjustment, 0.06);
  assert.equal(result.genreCompatibility.sharedFamilyEvidenceWeight, 1);
  assert.equal(result.genreCompatibility.sceneEvidenceWeight, 0);
  assert.equal(result.genreCompatibility.finalGenreAdjustmentReason, "strong-shared-genre-evidence");
});

test("asymmetric medium/strong genre evidence receives a reduced compatibility bonus", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:medium", artist: "A", title: "Anchor" },
    candidate: { identityKey: "tidal:strong", artist: "B", title: "Candidate", genre: "House" },
    rawSimilarity: 0.8,
    genreResolver: ({ track }) => track.identityKey === "tidal:medium"
      ? { inferred: [
        { value: "House", source: "artist-history", confidence: "uncertain" },
        { value: "Tech House", source: "artist-history", confidence: "uncertain" }
      ] }
      : { inferred: [] }
  });
  assert.deepEqual(result.genreCompatibility.genreEvidenceStrength, { anchor: "medium", candidate: "strong" });
  assert.equal(result.genreCompatibility.adjustment, 0.036);
  assert.equal(result.genreCompatibility.sharedFamilyEvidenceWeight, 0.6);
  assert.equal(result.genreCompatibility.finalGenreAdjustmentReason, "genre-evidence-strength-scaled");
});

test("weak shared genre evidence stays near-neutral without scene support", () => {
  const result = scoreSonicNeighborSecondStage({
    anchor: { identityKey: "tidal:weak-a", artist: "A", title: "Anchor" },
    candidate: { identityKey: "tidal:weak-b", artist: "B", title: "Candidate" },
    rawSimilarity: 0.8,
    genreResolver: () => ({ inferred: [{ value: "House", source: "stored-evidence", confidence: "uncertain" }] })
  });
  assert.deepEqual(result.genreCompatibility.genreEvidenceStrength, { anchor: "weak", candidate: "weak" });
  assert.equal(result.genreCompatibility.adjustment, 0.015);
  assert.equal(result.genreCompatibility.sharedFamilyEvidenceWeight, 0.25);
  assert.equal(result.genreCompatibility.sceneEvidenceWeight, 0);
  assert.equal(result.genreCompatibility.finalGenreAdjustmentReason, "weak-shared-family-evidence-scaled");
  assert.equal(result.genreCompatibility.sceneEvidenceUsed.length, 0);
});
