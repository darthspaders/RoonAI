"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runOperationalDiscoveryPath, createOperationalWriteGuard } = require("../src/sonicCatalogScoutOperationalPath");
const { candidateIdentityKeys, discoverTracks, buildDiscoveryProfile, artistKeysForCandidate,
  defaultPerRunArtistCap, selectDiscoveryLaneCandidates } = require("../src/discoveryEngine");
const { createDiscoveryOrchestration } = require("../src/discoveryOrchestration");
const { createDiscoveryResultVerification } = require("../src/discoveryResultVerification");
const { mergeTrackLists } = require("../src/trackListMerge");
const { normalizeMatchText } = require("../src/tidalMatchRules");
const { artistIdentityKey } = require("../src/artistIdentity");

const clone = value => structuredClone(value);
const OPTIONS = { request: "Find 3 progressive trance tracks at least 7 minutes", genres: "progressive trance",
  minDurationMinutes: 7, scoringMode: "taste-guided", count: 3 };
const row = (id, artist, title, extra = {}) => ({ identityKey: `tidal:${id}`, tidalId: String(id), id: String(id),
  tidalUrl: `https://tidal.com/browse/track/${id}`, artist, title, album: title,
  genre: ["Progressive Trance"], label: "Pure Trance", durationMs: 480000, year: 2025,
  releaseDate: "2025-01-01", query: "progressive trance", discoverySource: "frozen exact catalog", ...extra });
const rows = () => [row(1001, "Solarstone", "Seven Cities"), row(1002, "Airwave", "Tunnel of Freedom", { label: "Airwave Music" }),
  row(1003, "Forerunners", "Fear Is the Mind Killer", { label: "JOOF Recordings" }),
  row(1004, "John 00 Fleming, Fuenka", "Corruption", { label: "JOOF Recordings" })];
const identity = item => item.tidal?.identityKey || item.identityKey || `tidal:${item.tidal?.tidalId || item.id}`;
const ids = result => result.tracks.map(identity);
const all = result => [...result.tracks, ...result.alternates];
const bareResult = value => { const result = clone(value); delete result.verification.catalogScouts;
  delete result.verification.runtimeMs; return result; };
function freeze(value) { for (const item of Object.values(value || {})) if (item && typeof item === "object") freeze(item); return Object.freeze(value); }
function productionSnapshot(input = rows()) {
  const vector = axis => Array.from({ length: 1280 }, (_, index) => index === axis ? 1 : 0);
  return { model: "discogs-effnet", modelVersion: "1", mode: "blend", maxAdjustment: .08, minCoverage: 1, minScored: 2,
    profiles: [{ clusterId: "metadata:progressive trance", clusterKey: "metadata:progressive trance", clusterName: "progressive trance",
      model: "discogs-effnet", modelVersion: "1", positive: { vector: vector(0), feedbackIdentityCount: 4, embeddingIdentityCount: 4 },
      negative: { vector: vector(1), feedbackIdentityCount: 2, embeddingIdentityCount: 2 } }],
    embeddings: input.map((track, index) => [track.identityKey, { identityKey: track.identityKey, dimensions: 1280, vector: vector(index % 2) }]) };
}

test("operational admission and final bridge match the real pure pipeline and expose the HTTP boundary", async () => {
  const input = [...rows(), row(2001, "Airwave", "Short Build", { durationMs: 240000 }),
    row(2002, "The Beatles", "Hey Jude", { genre: ["Rock"], label: "Parlophone", query: "Solarstone progressive trance" }),
    row(2003, "Geomagnetic", "Top 100 Best Selling Chart Hits", { label: "Generic Records" }),
    row(2004, "Excision", "Bass Lane", { genre: ["Dubstep"], label: "Subsidia" })];
  const replay = await runOperationalDiscoveryPath({ pool: input, request: OPTIONS });
  const options = { ...replay.normalizedOptions, discoveryRuntimeMs: 1000 };
  const admitted = await discoverTracks({ directCandidates: input, tidal: { isConfigured: () => true }, options });
  const orchestration = createDiscoveryOrchestration({ artistKeysForCandidate, buildDiscoveryProfile, defaultPerRunArtistCap,
    mergeTrackLists, selectDiscoveryLaneCandidates });
  const verification = createDiscoveryResultVerification({ candidateIdentityKeys, mergeTrackLists, normalizeMatchText });
  const expected = verification.tidalPlaylistBridgeResult(orchestration.rebalanceDiscoveryResult(admitted, options, buildDiscoveryProfile(options), 3), 3);
  assert.deepEqual(ids(replay.result), ids(expected));
  const failures = result => Object.fromEntries(result.discarded.filter(item =>
    ["Short Build", "Hey Jude", "Top 100 Best Selling Chart Hits", "Bass Lane"].includes(item.title)).map(item => [item.title, item.rejectionStage]));
  assert.deepEqual(failures(replay.result), failures(expected));
  assert.deepEqual(failures(replay.result), { "Short Build": "duration-constraints", "Hey Jude": "identity-correctness",
    "Top 100 Best Selling Chart Hits": "catalogue-quality", "Bass Lane": "genre-lane-compatibility" });
  assert.equal(replay.result.verification.queueBridge, "tidal-playlist"); assert.equal(replay.result.verification.kept, 3);
  assert.equal(replay.boundary.httpRouteExercised, false); assert.equal(replay.boundary.coldRequestInferenceImplemented, false);
  assert.ok(replay.boundary.unreplayed.includes("real provider queueability"));
  assert.equal(replay.boundary.tasteSnapshotAvailable, false); assert.equal(replay.boundary.productionSnapshotAvailable, false);
  assert.deepEqual(replay.writeSafety, { attempts: [], mutationAttempts: 0, storesConstructed: 0, runtimeFilesRead: 0, analysisQueued: 0,
    counterScope: "module-owned factories and facades; external observer effects require separate audit" });
});

test("actual frozen model-review rejection precedes observation and cannot be resurrected by an observer", async () => {
  let observed;
  const response = { rawCount: 4, scores: [{ trackId: "1001", finalScore: 1, scores: { genreConfidence: 5 },
    rejected: true, rejectionBasis: ["catalogue_quality"], rejectionReason: "Frozen independent quality objection" }] };
  const replay = await runOperationalDiscoveryPath({ pool: rows(), request: OPTIONS, modelReviewResponse: response,
    productionSnapshot: productionSnapshot(), observer: candidates => {
      observed = clone(candidates);
      return { candidates: [row(1001, "Solarstone", "Seven Cities", { score: 100 })], diagnostics: { mode: "observe", applied: true } };
    } });
  assert.ok(!observed.some(track => identity(track) === "tidal:1001"));
  assert.ok(!all(replay.result).some(track => identity(track) === "tidal:1001"));
  assert.equal(replay.modelReview.rejected, 1); assert.equal(replay.modelReview.audit.rejectedCount, 1);
  assert.equal(replay.result.verification.catalogScouts.applied, false);
  const stages = replay.trace.map(item => item.stage);
  assert.ok(stages.indexOf("model-candidate-review") < stages.indexOf("catalog-scout-observation"));
  assert.ok(stages.indexOf("catalog-scout-observation") < stages.indexOf("production-effnet"));
  assert.ok(stages.indexOf("production-effnet") < stages.indexOf("lane-diversity-selection"));
});

test("cold, failing and candidate-mutating observation preserve actual EffNet content, scores and order", async () => {
  const input = { pool: rows(), request: OPTIONS, productionSnapshot: productionSnapshot(), modelReviewResponse: { scores: [] } };
  const baseline = await runOperationalDiscoveryPath(input);
  const cold = await runOperationalDiscoveryPath({ ...input, observer: () => ({ candidates: [], diagnostics: { mode: "observe", reason: "cold-cache", available: false } }) });
  const altered = await runOperationalDiscoveryPath({ ...input, observer: candidates => ({ candidates: candidates.reverse().slice(0, 1),
    diagnostics: { mode: "blend", applied: true, productionApplied: true, productionPromotionAllowed: true } }) });
  const failed = await runOperationalDiscoveryPath({ ...input, observer: (candidates, context) => {
    candidates[0].score = 1; candidates.splice(1); context.options.genres = "rock"; throw new Error("private-path-detail");
  } });
  for (const result of [cold, altered, failed]) {
    assert.deepEqual(bareResult(result.result), bareResult(baseline.result));
    assert.equal(result.result.verification.catalogScouts.productionApplied, false);
    assert.notEqual(result.result.verification.catalogScouts.productionPromotionAllowed, true);
    assert.equal(result.boundary.modelInference, false); assert.equal(result.writeSafety.mutationAttempts, 0);
  }
  assert.equal(baseline.result.verification.recommendationV2.applied, true);
  assert.equal(baseline.result.verification.recommendationV2.maxAdjustmentPoints, 8);
  assert.equal(failed.result.verification.catalogScouts.fallback, true);
  assert.doesNotMatch(JSON.stringify(failed), /private-path-detail/);
  assert.equal(failed.trace.find(item => item.stage === "catalog-scout-observation").status, "neutral-fallback");
  assert.equal(cold.trace.find(item => item.stage === "catalog-scout-observation").inputFingerprint,
    baseline.trace.find(item => item.stage === "production-effnet").inputFingerprint);
});

test("model failure keeps the admitted pool and request untouched, with an explicit neutral fallback", async () => {
  const input = { pool: freeze(rows()), request: freeze(clone(OPTIONS)) }, before = clone(input);
  const baseline = await runOperationalDiscoveryPath(input), failed = await runOperationalDiscoveryPath({ ...input, modelReviewFailure: true });
  assert.deepEqual(bareResult(failed.result), bareResult(baseline.result)); assert.deepEqual(input, before);
  assert.equal(failed.modelReview.error, "Frozen model review unavailable.");
  assert.equal(failed.trace.find(item => item.stage === "model-candidate-review").status, "neutral-fallback");
});

test("frozen Last.fm and taste evidence use real scoring while supplied history retains novelty suppression", async () => {
  const input = rows(), tasteSnapshot = { feedback: {}, candidates: {}, artists: {
    [artistIdentityKey("Solarstone")]: { name: "Solarstone", score: 6 }, [artistIdentityKey("Airwave")]: { name: "Airwave", score: -6 }
  }, labels: {}, calibration: { sources: [], lanes: [], labels: [] } };
  const scrobbleSnapshot = { enabled: true, configured: true, apiKeyConfigured: true, usernameConfigured: true,
    usernameValid: true, checked: true, tracksByKey: { "tidal:1001": { plays: 4 } }, topArtistsByKey: {} };
  const snapshotBefore = clone({ tasteSnapshot, scrobbleSnapshot });
  const tasteOnly = await runOperationalDiscoveryPath({ pool: input, request: { ...OPTIONS, count: 4 }, tasteSnapshot });
  assert.ok(all(tasteOnly.result).find(item => identity(item) === "tidal:1001").scoreBreakdown.tasteAdjustment > 0);
  const replay = await runOperationalDiscoveryPath({ pool: input, request: { ...OPTIONS, count: 4 }, tasteSnapshot, scrobbleSnapshot });
  const track = all(replay.result).find(item => identity(item) === "tidal:1001");
  assert.ok(track.scoreBreakdown.lastfmAdjustment < 0);
  assert.ok(track.scoreBreakdown.tasteReasons.some(reason => reason.startsWith("Solarstone +")));
  assert.equal(replay.result.verification.lastfm.checked, true);
  assert.deepEqual({ tasteSnapshot, scrobbleSnapshot }, snapshotBefore);
  const now = Date.now(), historySnapshot = { entries: [{ key: "tidal:1001", keys: ["tidal:1001"], artist: "Solarstone", title: "Seven Cities", lastShownAt: now, shownCount: 2 }] };
  const historyBefore = clone(historySnapshot);
  const fresh = await runOperationalDiscoveryPath({ pool: input, request: OPTIONS, historySnapshot });
  assert.ok(!ids(fresh.result).includes("tidal:1001")); assert.deepEqual(historySnapshot, historyBefore);
  assert.equal(fresh.boundary.historyDecayUsesWallClock, true); assert.equal(fresh.boundary.historyWrites, 0);
});

test("sampling categories never become explicit genre constraints and metadata cannot replace exact identity", async () => {
  const input = { entries: [{ track: row(1001, "Solarstone", "Seven Cities"), metadata: { beatportGenre: "Trance", label: "Exact label", identityKey: "tidal:999" } },
    { track: row(1002, "Airwave", "Tunnel of Freedom"), metadata: { beatportGenre: "Trance" } }] };
  const replay = await runOperationalDiscoveryPath({ pool: input, request: { samplingLane: "psy", options: { request: "Find 2 tracks like Airwave", count: 2, scoringMode: "similar" }, candidateIdentityKeys: ["tidal:1001", "tidal:1002"] } });
  assert.equal(replay.normalizedOptions.genres, undefined);
  assert.equal(replay.trace[0].explicitGenres, ""); assert.ok(all(replay.result).every(track => ["tidal:1001", "tidal:1002"].includes(identity(track))));
  const explicit = await runOperationalDiscoveryPath({ pool: rows(), request: { ...OPTIONS, genres: "progressive trance" } });
  assert.equal(explicit.trace[0].explicitGenres, "progressive trance");
});

test("strict queueability uses exact frozen responses and never runs the mutating direct bridge", async () => {
  const responses = Object.fromEntries(rows().map(track => [track.identityKey, { success: track.tidalId !== "1001",
    action: `frozen-action-${track.tidalId}`, match: { title: track.title, item_key: `frozen-${track.tidalId}` }, reason: "Frozen strict exact mismatch" }]));
  const replay = await runOperationalDiscoveryPath({ pool: rows(), request: { ...OPTIONS, strictRoonQueueable: true, zoneId: "frozen-zone", allowBridge: true }, queueabilityResponses: responses });
  assert.equal(replay.result.verification.roonStrict, true); assert.equal(replay.result.tracks.length, 3);
  assert.ok(!ids(replay.result).includes("tidal:1001")); assert.ok(replay.result.tracks.every(track => track.roon.verified));
  assert.ok(replay.result.discarded.some(track => identity(track) === "tidal:1001"));
  assert.equal(replay.trace.find(item => item.stage === "queueability-filter").directBridgeDisabled, true);
  assert.equal(replay.boundary.providerQueueResponsesReplayed, true); assert.equal(replay.boundary.queueWrites, 0);
  assert.equal(replay.trace.find(item => item.stage === "strict-roon-preflight").status, "not-replayed");
  assert.deepEqual(replay.writeSafety.attempts, []);
});

test("all network/process/file mutation is absent, write traps fail closed and unsafe requests are rejected", async t => {
  const fs = require("node:fs"), childProcess = require("node:child_process");
  const forbidden = [];
  for (const [owner, methods] of [[fs, ["readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync"]],
    [fs.promises, ["readFile", "writeFile", "appendFile", "mkdir", "rename", "unlink"]],
    [childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]]]) {
    for (const method of methods) {
      const original = owner[method];
      owner[method] = () => { forbidden.push(method); throw new Error(`Operational replay called forbidden ${method}`); };
      t.after(() => { owner[method] = original; });
    }
  }
  const previous = global.fetch; let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error("Operational replay must not fetch"); };
  t.after(() => { global.fetch = previous; });
  const result = await runOperationalDiscoveryPath({ pool: rows(), request: OPTIONS });
  assert.equal(fetched, 0); assert.equal(result.boundary.runtimeDatabaseWrites, 0);
  assert.deepEqual(forbidden, []);
  const guard = createOperationalWriteGuard();
  for (const method of ["history.record", "taste.recordFeedback", "roon.resolveDirectBridgeBatch", "tidal.createPlaylist", "session.save"])
    assert.throws(() => guard.trap(method)(), /forbids mutation/);
  assert.equal(guard.snapshot().mutationAttempts, 5);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: Array(101).fill(rows()[0]), request: OPTIONS }), /at most 100/);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: [rows()[0], rows()[0]], request: OPTIONS }), /Duplicate/);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: rows(), request: { options: OPTIONS, candidateIdentityKeys: ["tidal:999"] } }), /missing/);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: rows(), request: { options: OPTIONS, anchorIdentityKey: "tidal:1001", candidateIdentityKeys: ["tidal:1001"] } }), /own candidate/);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: rows(), request: { ...OPTIONS, count: 21 } }), /1–20/);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: rows(), request: { mode: "exact_track_verification", tracks: [rows()[0]] } }), /separate mutating route/);
  await assert.rejects(() => runOperationalDiscoveryPath({ pool: rows(), request: { ...OPTIONS, strictRoonQueueable: true, zoneId: "frozen" } }), /frozen queueability/);
});

test("all frozen responses are captured before awaits and unavailable data is never presented as fresh verification", async () => {
  const input = { pool: rows(), request: OPTIONS, productionSnapshot: productionSnapshot(),
    modelReviewResponse: { scores: [{ trackId: "1001", finalScore: 90, scores: { genreConfidence: 90 }, rejected: false }] } };
  const expected = await runOperationalDiscoveryPath(clone(input));
  const pending = runOperationalDiscoveryPath(input);
  input.pool[0].title = "Changed after capture";
  input.productionSnapshot.embeddings[0][1].vector.fill(0);
  input.modelReviewResponse.scores[0].rejected = true;
  input.request.genres = "rock";
  const actual = await pending;
  assert.deepEqual(bareResult(actual.result), bareResult(expected.result));
  assert.equal(actual.boundary.modelInference, false); assert.equal(actual.boundary.liveProviderQueries, false);
  assert.equal(actual.boundary.modelReviewResponseAvailable, true);
  const empty = await runOperationalDiscoveryPath({ pool: [], request: OPTIONS, observer: () => { throw new Error("Empty pool must not observe"); } });
  assert.equal(empty.result.tracks.length, 0);
  assert.equal(empty.trace.find(item => item.stage === "catalog-scout-observation").status, "empty-pool-skipped");
  assert.equal(empty.boundary.productionSnapshotAvailable, false);
});

test("the real similar-artist expansion consumes only explicit frozen model-plan and Last.fm responses", async () => {
  const response = [{ name: "Airwave", matchScore: .8, seedArtist: "Solarstone", source: "Frozen Last.fm artist.getsimilar" }];
  const replay = await runOperationalDiscoveryPath({ pool: rows(), request: { request: "Find 3 tracks like Solarstone", count: 3, scoringMode: "similar" },
    modelPlanResponse: { plan: { seedArtists: ["Solarstone"] } }, similarArtistResponse: response });
  assert.ok(replay.normalizedOptions.similarArtistSeeds.includes("Airwave"));
  assert.ok(replay.normalizedOptions.similarArtistEvidence.some(item => item.name === "Airwave" && item.matchScore === .8));
  assert.equal(replay.trace.find(item => item.stage === "model-planning").status, "frozen-response");
  assert.equal(replay.trace.find(item => item.stage === "similar-artist-expansion").status, "frozen-response");
  assert.equal(replay.boundary.liveScrobbleFetch, false); assert.equal(replay.boundary.liveProviderQueries, false);
});

test("supplied identity keys cannot hide conflicting explicit TIDAL IDs or URLs on either descriptor", async () => {
  const original = rows()[0];
  for (const extra of [{ tidalId: "999" }, { id: "999" }, { trackId: "999" }, { tidalTrackId: "999" },
    { tidalUrl: "https://tidal.com/browse/track/999" }, { tidal_url: "https://listen.tidal.com/track/999" },
    { tidal: { identityKey: "tidal:999" } }, { tidal: { id: "999" } }, { tidal: { tidalId: "999" } },
    { tidal: { tidalUrl: "https://tidal.com/browse/track/999" } }]) {
    await assert.rejects(() => runOperationalDiscoveryPath({ pool: [{ ...original, ...extra }], request: OPTIONS }), /Conflicting/);
  }
  const accepted = await runOperationalDiscoveryPath({ pool: [{ ...original, tidal: { id: "1001", tidalId: "1001",
    identityKey: "tidal:1001", tidalUrl: original.tidalUrl } }], request: { ...OPTIONS, count: 1 } });
  assert.deepEqual(ids(accepted.result), ["tidal:1001"]);
});
