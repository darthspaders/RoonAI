"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { namedRemixEvidence, compactReviewEvidence } = require("../src/candidateReviewEvidence");
const { buildDiscoveryProfile, rejectReason, admissionDiagnosticsFor, scoreBreakdownFor } = require("../src/discoveryEngine");

const remix = { artist: "Pendulum", title: "9,000 Miles (Eelke Kleijn Remix)", album: "The Reworks", label: "Earstorm", durationMs: 501000, query: "Eelke Kleijn progressive house" };
const options = { request: "Find progressive house tracks at least 7 minutes", genres: "progressive house" };

test("named remix context comes from a bounded version descriptor, not the original artist or search query", () => {
  for (const title of [remix.title, "9,000 Miles [Eelke Kleijn Extended Remix]", "9,000 Miles - Eelke Kleijn Remix"]) {
    const evidence = namedRemixEvidence({ ...remix, title });
    assert.equal(evidence.named, true);
    assert.deepEqual(evidence.remixers, ["Eelke Kleijn"]);
    assert.equal(evidence.versionConflict, false);
  }
  for (const title of ["9,000 Miles", "9,000 Miles (Original Mix)", "9,000 Miles (Extended Remix)", "9,000 Miles (Radio Remix)"]) {
    assert.equal(namedRemixEvidence({ ...remix, title }).named, false);
  }
  assert.equal(namedRemixEvidence({ title: "9,000 Miles", mixVersion: "Eelke Kleijn Remix" }).named, true);
  assert.equal(namedRemixEvidence({ title: "9,000 Miles (Remix)", remixers: [{ name: "Eelke Kleijn" }] }).named, true);
  assert.equal(namedRemixEvidence({ title: "9,000 Miles", remixers: [{ name: "Eelke Kleijn" }] }).named, false);
});

test("conflicting explicit remix/Original Mix and different remixer claims stay visible", () => {
  assert.equal(namedRemixEvidence({ ...remix, mixVersion: "Original Mix" }).versionConflict, true);
  assert.equal(namedRemixEvidence({ ...remix, mixVersion: "Someone Else Remix" }).versionConflict, true);
  assert.equal(namedRemixEvidence({ ...remix, remixers: [{ name: "Someone Else" }] }).versionConflict, true);
});

test("original artist genre tags are not presented as the remix's track genre", () => {
  const evidence = compactReviewEvidence({ ...remix, genre: "Progressive House", tidal: { artistGenres: ["Drum & Bass"] }, admissionDiagnostics: { candidateGenreEvidence: { official: ["Drum & Bass", "Progressive House"] } } });
  assert.deepEqual(evidence.genres, ["Progressive House"]);
  assert.deepEqual(evidence.original_artist_genres, ["Drum & Bass"]);
});

test("review retains the actual remixer scene evidence and exact minimum-duration meaning", () => {
  const profile = buildDiscoveryProfile(options);
  const track = { ...remix, scoreBreakdown: scoreBreakdownFor(remix, options, null, profile), admissionDiagnostics: admissionDiagnosticsFor(remix, options, profile) };
  const evidence = compactReviewEvidence(track, { artists: { eelke: { name: "Eelke Kleijn", score: 11 } } });
  assert.deepEqual(evidence.remix.remixers, ["Eelke Kleijn"]);
  assert.deepEqual(evidence.remix.taste, [{ name: "Eelke Kleijn", score: 11 }]);
  assert.ok(evidence.genre_evidence.some(item => item.source === "remixer" && item.genre === "progressive house"));
  assert.ok(evidence.genre_evidence.every(item => !item.source.startsWith("query")));
  assert.equal(evidence.duration_constraint.minimumMs, 420000);
  assert.equal(evidence.duration_constraint.passed, true);
  assert.deepEqual(evidence.sonic, { available: false, applied: false });
});

test("low-coverage or observation-only Sonic scores cannot enter model scoring context", () => {
  const sonic = { available: true, applied: false, reason: "scored-against-relevant-taste-cluster", sonicTasteSignal: 0.99, positiveSimilarity: 0.98, wouldBeFinalScore: 99, sonicAdjustment: 0, clusterName: "Progressive House" };
  const unavailable = compactReviewEvidence({ ...remix, recommendationV2: sonic }).sonic;
  assert.deepEqual(unavailable, { available: true, applied: false, reason: sonic.reason });
  const applied = compactReviewEvidence({ ...remix, recommendationV2: { ...sonic, applied: true, sonicAdjustment: 6 } }).sonic;
  assert.equal(applied.adjustment_already_in_current_score, 6);
  assert.equal(applied.sonicTasteSignal, undefined);
  assert.equal(applied.positiveSimilarity, undefined);
});

test("a learned original-artist exclusion cannot veto a supported named remix", () => {
  const request = { ...options, learnedGenreProfiles: { "progressive house": { name: "progressive house", parentGenres: ["house"], artists: ["Eelke Kleijn"], excludeArtists: ["Pendulum"] } } };
  const profile = buildDiscoveryProfile(request);
  assert.equal(rejectReason(remix, request, profile), "");
  const breakdown = scoreBreakdownFor(remix, request, null, profile);
  assert.ok(breakdown.genreInference.evidence.some(item => item.source === "remixer" && item.weight > 0));
  assert.ok(breakdown.genreInference.evidence.some(item => item.source === "original-artist-profile" && item.weight === -2));
  assert.match(rejectReason({ ...remix, title: "9,000 Miles (Original Mix)", query: "progressive house" }, request, profile), /corroborate|genre/i);
});

test("named remix credit alone cannot bypass missing genre support, duration or identity requirements", () => {
  assert.match(rejectReason({ ...remix, title: "9,000 Miles (Unknown Producer Remix)", query: "progressive house" }, options), /genre|corroborate/i);
  assert.match(rejectReason({ ...remix, durationMs: 300000 }, options), /below.*minimum/i);
  assert.match(rejectReason({ ...remix, title: "9,000 Miles (Eelke Kleijn Radio Edit)" }, options), /radio edit/i);
  const pure = { request: "Only tracks by Sasha", artistSeeds: ["Sasha"], scoringMode: "pure" };
  const profile = { ...buildDiscoveryProfile(pure), requestedArtists: ["Sasha"], scoringMode: "pure" };
  assert.match(rejectReason(remix, pure, profile), /Pure Search requested Sasha/i);
});

test("a trance-associated original artist does not veto a supported Progressive House remix", () => {
  const request = { ...options, request: "Only progressive house, no trance, at least 7 minutes" };
  const track = { ...remix, artist: "Armin van Buuren", title: "Fixture (Eelke Kleijn Remix)" };
  assert.equal(rejectReason(track, request), "");
  assert.match(rejectReason({ ...track, title: "Fixture (Original Mix)", query: "progressive house" }, request), /genre|corroborate/i);
});
