"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { finalizeCatalogScoutCandidates, frozenHistory, frozenProductionReranker } = require("../src/sonicCatalogScoutFinalizer");
const { discoverTracks, buildDiscoveryProfile, artistKeysForCandidate, defaultPerRunArtistCap, selectDiscoveryLaneCandidates } = require("../src/discoveryEngine");
const { createDiscoveryOrchestration } = require("../src/discoveryOrchestration");
const { freezeTasteView } = require("../src/sonicEnsembleTasteShadow");
const { artistIdentityKey } = require("../src/artistIdentity");
const clone = value => structuredClone(value);
const OPTIONS = { request: "Find 3 progressive trance tracks at least 7 minutes", genres: "progressive trance", minDurationMinutes: 7, scoringMode: "taste-guided" };
const row = (id, artist, title, extra = {}) => ({ identityKey: `tidal:${id}`, tidalId: String(id), id: String(id), tidalUrl: `https://tidal.com/browse/track/${id}`,
  artist, title, album: title, genre: ["Progressive Trance"], label: "Pure Trance", durationMs: 480000, year: 2025, releaseDate: "2025-01-01", query: "progressive trance", discoverySource: "frozen exact catalog", ...extra });
const rows = () => [row(1001, "Solarstone", "Seven Cities"), row(1002, "Airwave", "Tunnel of Freedom", { label: "Airwave Music" }), row(1003, "Forerunners", "Fear Is the Mind Killer", { label: "JOOF Recordings" }), row(1004, "John 00 Fleming, Fuenka", "Corruption", { label: "JOOF Recordings" })];
const identity = item => item.tidal?.identityKey || item.identityKey || `tidal:${item.tidal?.tidalId || item.id}`;
const identities = items => items.map(identity);
function productionSnapshot(entries, overrides = {}) {
  const positive = Array(1280).fill(0), negative = Array(1280).fill(0); positive[0] = 1; negative[1] = 1;
  const profile = { clusterId: "metadata:progressive trance", clusterKey: "metadata:progressive trance", clusterName: "progressive trance", model: "discogs-effnet", modelVersion: "1",
    positive: { vector: positive, feedbackIdentityCount: 4, embeddingIdentityCount: 4 }, negative: { vector: negative, feedbackIdentityCount: 2, embeddingIdentityCount: 2 } };
  return { model: "discogs-effnet", modelVersion: "1", mode: "blend", maxAdjustment: .08, minCoverage: 1, minScored: 2, profiles: [profile],
    embeddings: entries.map(([key, axis]) => { const vector = Array(1280).fill(0); vector[axis] = 1; return [key, { identityKey: key, model: "discogs-effnet", modelVersion: "1", dimensions: 1280, vector }]; }), ...overrides };
}
const context = { options: { genre: "Progressive Trance" }, profile: { targetGenres: ["progressive trance"], scoringMode: "taste-guided" } };

test("finalizer retains the real normal admission stages for identity, catalog quality, hard duration and genre", async () => {
  const input = [...rows(), row(2001, "Airwave", "Short Build", { durationMs: 240000 }), row(2002, "The Beatles", "Hey Jude", { genre: ["Rock"], label: "Parlophone", query: "Solarstone progressive trance" }),
    row(2003, "Geomagnetic", "Top 100 Best Selling Chart Hits", { label: "Generic Records" }), row(2004, "Excision", "Bass Lane", { genre: ["Dubstep"], label: "Subsidia" })], before = clone(input);
  let searched = 0;
  const normal = await discoverTracks({ tidal: { isConfigured: () => true, searchTracks: async () => { searched++; throw new Error("No provider branch in a frozen replay"); } },
    directCandidates: input, options: { ...OPTIONS, count: 3, effectiveCount: 3, originalRequestedCount: 3, allowPreviousFallback: false } });
  const replay = await finalizeCatalogScoutCandidates(input, { options: OPTIONS, requestedCount: 3 });
  assert.equal(searched, 0); assert.equal(replay.tracks.length, 3); assert.deepEqual(input, before);
  const rejected = result => Object.fromEntries(result.discarded.filter(item => ["Short Build", "Hey Jude", "Top 100 Best Selling Chart Hits", "Bass Lane"].includes(item.title)).map(item => [item.title, item.rejectionStage]));
  assert.deepEqual(rejected(replay), rejected(normal));
  assert.deepEqual(rejected(replay), { "Short Build": "duration-constraints", "Hey Jude": "identity-correctness", "Top 100 Best Selling Chart Hits": "catalogue-quality", "Bass Lane": "genre-lane-compatibility" });
  assert.ok(replay.tracks.every(item => item.admissionDiagnostics.identityCorrectness.passed && item.admissionDiagnostics.catalogueQuality.passed && item.admissionDiagnostics.durationConstraints.passed && item.admissionDiagnostics.genreLaneCompatibility.passed));
  assert.ok(identities(replay.tracks).every(key => /^tidal:100[1-4]$/.test(key)));
});
test("frozen history preserves identity aliases and recency while rejecting every writable history method", () => {
  const now = Date.now(), snapshot = { settings: { recentWindowMs: 1000000 }, entries: [{ key: "tidal:1001", keys: ["tidal:1001", "solarstone|seven cities"], artist: "Solarstone", title: "Seven Cities", firstShownAt: now, lastShownAt: now, shownCount: 2 }] };
  const before = clone(snapshot), view = frozenHistory(snapshot); assert.equal(view.entryFor(rows()[0]).shownCount, 2); assert.equal(view.isRecent(rows()[0]), true);
  for (const method of ["record", "save", "load"]) assert.throws(() => view[method]([rows()[1]]), /read-only/);
  snapshot.entries[0].shownCount = 99; assert.equal(view.entryFor(rows()[0]).shownCount, 2); assert.deepEqual(view.uniqueEntries()[0], before.entries[0]);
});
test("history novelty is applied to frozen candidates without adding history entries or returning prior fallback rows", async () => {
  const now = Date.now(), input = rows(), historySnapshot = { entries: [{ key: "tidal:1001", keys: ["tidal:1001"], artist: "Solarstone", title: "Seven Cities", lastShownAt: now, shownCount: 2 },
    { key: "tidal:9999", keys: ["tidal:9999"], artist: "Prior artist", title: "Outside frozen input", lastShownAt: now, shownCount: 1 }] }, before = clone(historySnapshot);
  const result = await finalizeCatalogScoutCandidates(input, { options: OPTIONS, requestedCount: 3, historySnapshot });
  assert.equal(result.tracks.length, 3); assert.ok(!identities(result.tracks).includes("tidal:1001")); assert.ok(!identities([...result.tracks, ...result.alternates]).includes("tidal:9999"));
  assert.deepEqual(historySnapshot, before); assert.equal(result.verification.catalogScoutReplay.historyWrites, 0); assert.equal(result.verification.catalogScoutReplay.analysisQueued, 0);
});
test("final lane and artist diversity selection matches the existing orchestration helper", async () => {
  const input = [rows()[0], row(1005, "Solarstone", "Different Named Mix", { mixVersion: "Club Mix" }), row(1006, "Solarstone", "Another Recording"), ...rows().slice(1)], options = { ...OPTIONS, count: 3, effectiveCount: 3, originalRequestedCount: 3, allowPreviousFallback: false }, profile = buildDiscoveryProfile(options);
  const normal = await discoverTracks({ tidal: { isConfigured: () => true }, directCandidates: input, options });
  const mergeTrackLists = (...lists) => [...new Map(lists.flat().map(item => [identity(item), item])).values()];
  const orchestration = createDiscoveryOrchestration({ artistKeysForCandidate, buildDiscoveryProfile, defaultPerRunArtistCap, mergeTrackLists, selectDiscoveryLaneCandidates, tasteProfile: freezeTasteView(null) });
  const expected = orchestration.rebalanceDiscoveryResult(normal, options, profile, 3), actual = await finalizeCatalogScoutCandidates(input, { options: OPTIONS, requestedCount: 3 });
  assert.deepEqual(identities(actual.tracks), identities(expected.tracks)); assert.deepEqual(actual.verification.laneQuotas, expected.verification.laneQuotas);
  assert.equal(actual.tracks.length, 3); assert.equal(new Set(actual.tracks.map(item => item.artist)).size, 3); assert.equal(actual.verification.perRunArtistCap, 1);
});
test("derived frozen taste retains existing taste adjustments without recording new feedback", async () => {
  const input = rows(), tasteSnapshot = { feedback: {}, candidates: {}, artists: { [artistIdentityKey("Solarstone")]: { name: "Solarstone", score: 6 }, [artistIdentityKey("Airwave")]: { name: "Airwave", score: -6 } },
    labels: {}, calibration: { sources: [], lanes: [], labels: [] } }, before = clone(tasteSnapshot), options = { ...OPTIONS, count: 4, effectiveCount: 4, allowPreviousFallback: false };
  const normal = await discoverTracks({ tidal: { isConfigured: () => true }, options, directCandidates: input, tasteProfile: freezeTasteView(tasteSnapshot) });
  const result = await finalizeCatalogScoutCandidates(input, { options: OPTIONS, requestedCount: 4, tasteSnapshot });
  for (const key of ["tidal:1001", "tidal:1002"]) {
    const find = value => [...value.tracks, ...value.alternates].find(item => identity(item) === key);
    assert.ok(key === "tidal:1001" ? find(result).scoreBreakdown.tasteAdjustment > 0 : find(result).scoreBreakdown.tasteAdjustment < 0);
    assert.equal(find(result).scoreBreakdown.tasteAdjustment, find(normal).scoreBreakdown.tasteAdjustment);
  }
  assert.deepEqual(tasteSnapshot, before); assert.equal(result.verification.catalogScoutReplay.historyWrites, 0);
});
test("frozen EffNet Blend uses only supplied profiles and embeddings with the actual additive eight-point cap", () => {
  const snapshot = productionSnapshot([["tidal:1001", 0], ["tidal:1002", 1]]), before = clone(snapshot), rerank = frozenProductionReranker(snapshot), input = [row(1001, "Solarstone", "One", { score: 40 }), row(1002, "Airwave", "Two", { score: 41 })];
  const result = rerank(input, context); assert.equal(result.diagnostics.applied, true); assert.equal(result.diagnostics.productionMode, "blend"); assert.equal(result.diagnostics.coverage, 1);
  assert.deepEqual(result.candidates.map(item => item.score), [48, 33]); assert.deepEqual(result.candidates.map(item => item.recommendationV2.sonicAdjustment), [8, -8]);
  assert.ok(result.candidates.every(item => item.recommendationV2.model === "discogs-effnet" && item.recommendationV2.dimensions === 1280)); assert.deepEqual(snapshot, before);
});
test("frozen production reader cannot observe later mutations to the caller's profile or embedding arrays", () => {
  const snapshot = productionSnapshot([["tidal:1001", 0], ["tidal:1002", 1]]), rerank = frozenProductionReranker(snapshot), input = [row(1001, "Solarstone", "One", { score: 40 }), row(1002, "Airwave", "Two", { score: 41 })], first = rerank(input, context);
  snapshot.profiles[0].positive.vector[0] = 0; snapshot.profiles[0].positive.vector[5] = 1;
  snapshot.embeddings[0][1].vector[0] = 0; snapshot.embeddings[0][1].vector[1] = 1; snapshot.embeddings.push(["tidal:1003", snapshot.embeddings[0][1]]);
  assert.deepEqual(rerank(input, context), first);
});
test("missing production embeddings remain unscored and disclosed instead of becoming negative or fabricated control evidence", async () => {
  const input = rows().slice(0, 3), snapshot = productionSnapshot([["tidal:1001", 0]], { minCoverage: 1, minScored: 2 }), before = clone(snapshot);
  const baseline = await finalizeCatalogScoutCandidates(input, { options: OPTIONS, requestedCount: 3 }), result = await finalizeCatalogScoutCandidates(input, { options: OPTIONS, requestedCount: 3, productionSnapshot: snapshot });
  assert.deepEqual(identities(result.tracks), identities(baseline.tracks)); assert.deepEqual(result.tracks.map(item => item.score), baseline.tracks.map(item => item.score));
  assert.equal(result.verification.recommendationV2.scoredCount, 1); assert.equal(result.verification.recommendationV2.applied, false); assert.equal(result.verification.recommendationV2.coverage, .3333);
  assert.ok(result.tracks.filter(item => identity(item) !== "tidal:1001").every(item => item.recommendationV2.available === false && item.recommendationV2.sonicAdjustment === 0));
  assert.equal(result.verification.catalogScoutReplay.analysisQueued, 0); assert.deepEqual(snapshot, before);
});
test("bounded frozen replay makes no external network or queue request and states unreplayed verification limits", async t => {
  const previous = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error("Network access forbidden in frozen finalizer test"); }; t.after(() => { global.fetch = previous; });
  const result = await finalizeCatalogScoutCandidates(rows(), { options: OPTIONS, requestedCount: 3 }); assert.equal(calls, 0);
  assert.equal(result.verification.catalogScoutReplay.providersQueried, false); assert.equal(result.verification.catalogScoutReplay.historyWrites, 0); assert.equal(result.verification.catalogScoutReplay.analysisQueued, 0);
  assert.equal(result.verification.catalogScoutReplay.providerQueueVerificationReplayed, false); assert.equal(result.verification.catalogScoutReplay.productionApplied, false);
  await assert.rejects(() => finalizeCatalogScoutCandidates(Array(101).fill(rows()[0])), /Assertion/); await assert.rejects(() => finalizeCatalogScoutCandidates(rows(), { requestedCount: 21 }), /Assertion/);
  assert.throws(() => frozenProductionReranker({ model: "mert-30s", modelVersion: "2" }));
});
