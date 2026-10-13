"use strict";

// Frozen-response replay of the discovery route's pure stages. Never import
// server/config or construct stores, providers, workers or a queue here.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const engine = require("./discoveryEngine");
const { mergeTrackLists } = require("./trackListMerge");
const { normalizeMatchText } = require("./tidalMatchRules");
const { tidalTrackIdFromUrl } = require("./tidalIdentity");
const yearRangeUtil = require("./yearRange");
const { exactIntent } = require("./exactTrackVerification");
const { GenreProfileStore } = require("./genreProfileStore");
const { createDiscoveryRequestPolicy } = require("./discoveryRequestPolicy");
const { createDiscoveryOrchestration } = require("./discoveryOrchestration");
const { createDiscoveryResultVerification } = require("./discoveryResultVerification");
const { createDiscoveryNoveltyPolicy } = require("./discoveryNoveltyPolicy");
const { createSimilarArtistExpansion } = require("./similarArtistExpansion");
const { createModelCandidateReviewer } = require("./modelCandidateReview");
const modelAudit = require("./modelReviewAudit");
const { createRoonQueueableFilter } = require("./roonQueueableFilter");
const { freezeTasteView } = require("./sonicEnsembleTasteShadow");
const { frozenHistory, frozenProductionReranker } = require("./sonicCatalogScoutFinalizer");

const clone = value => JSON.parse(JSON.stringify(value));
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const identity = track => String(track.identityKey || track.tidal?.identityKey ||
  engine.candidateIdentityKeys(track).find(key => /^tidal:\d+$/.test(key)) || "");
const counts = result => ({ selected: result.tracks?.length || 0, alternates: result.alternates?.length || 0,
  discarded: result.discarded?.length || 0 });
const EMPTY_TASTE = Object.freeze({ feedback: {}, candidates: {}, artists: {}, labels: {},
  calibration: { sources: [], lanes: [], labels: [] } });

function createOperationalWriteGuard() {
  const attempts = [];
  return {
    trap: name => () => {
      attempts.push(name);
      throw new Error(`Operational replay forbids mutation: ${name}.`);
    },
    snapshot: () => ({ attempts: [...attempts], mutationAttempts: attempts.length })
  };
}

function frozenGenreProfiles(snapshot, guard) {
  if (snapshot !== null) assert.ok(plain(snapshot), "Genre profile snapshot must be an object.");
  const view = Object.create(GenreProfileStore.prototype);
  view.profiles = clone(snapshot?.profiles || {});
  for (const method of ["load", "save", "recordFeedback"]) view[method] = guard.trap(`genreProfile.${method}`);
  return view;
}

function inputCandidates(pool, request) {
  const entries = Array.isArray(pool) ? pool : pool?.entries || pool?.items;
  assert.ok(Array.isArray(entries) && entries.length <= 100, "Frozen pool must contain at most 100 entries.");
  const byIdentity = new Map();
  for (const entry of entries) {
    const track = entry?.track || entry;
    assert.ok(plain(track) && /^tidal:[1-9]\d*$/.test(identity(track)), "Every frozen pool row needs an exact TIDAL identity.");
    // The existing alias helper trusts identityKey. Check every explicit
    // provider field independently rather than using that key as its own proof.
    const expectedId = identity(track).slice(6);
    for (const descriptor of [track, track.tidal].filter(Boolean)) {
      assert.ok(plain(descriptor), "Invalid frozen TIDAL descriptor.");
      if (descriptor.identityKey !== undefined) assert.equal(descriptor.identityKey, identity(track), "Conflicting frozen TIDAL identity.");
      for (const field of ["tidalId", "tidalTrackId", "id", "trackId"]) {
        if (descriptor[field] === undefined || descriptor[field] === null || descriptor[field] === "") continue;
        assert.equal(String(descriptor[field]), expectedId, "Conflicting explicit frozen TIDAL ID.");
      }
      for (const field of ["tidalUrl", "tidal_url"]) {
        if (descriptor[field] === undefined || descriptor[field] === null || descriptor[field] === "") continue;
        assert.equal(String(tidalTrackIdFromUrl(descriptor[field]) || ""), expectedId, "Conflicting explicit frozen TIDAL URL.");
      }
    }
    assert.ok(engine.candidateIdentityKeys(track).includes(identity(track)), "Frozen TIDAL identity conflicts with its descriptor.");
    assert.ok(!byIdentity.has(identity(track)), "Duplicate frozen pool identity.");
    const metadata = entry?.track ? entry.metadata || {} : {};
    const allowedMetadata = {};
    for (const key of ["query", "discoverySource", "discoveryLane", "beatportGenre", "beatportSubgenre", "label", "bpm"]) {
      if (metadata[key] === undefined) continue;
      assert.ok(key === "bpm" ? typeof metadata[key] === "number" && Number.isFinite(metadata[key]) && metadata[key] > 0 :
        typeof metadata[key] === "string", "Invalid frozen admission metadata.");
      allowedMetadata[key] = clone(metadata[key]);
    }
    byIdentity.set(identity(track), { ...clone(track), ...allowedMetadata });
  }
  const selected = request.candidateIdentityKeys || [...byIdentity.keys()].filter(key => key !== request.anchorIdentityKey);
  assert.ok(Array.isArray(selected) && selected.length <= 100 && new Set(selected).size === selected.length,
    "Invalid frozen eligible candidate identities.");
  assert.ok(!request.anchorIdentityKey || !selected.includes(request.anchorIdentityKey), "Anchor cannot be its own candidate.");
  return selected.map(key => {
    assert.ok(byIdentity.has(key), "Eligible candidate is missing from the frozen pool.");
    return byIdentity.get(key);
  });
}

// request is a frozen pool request ({options,candidateIdentityKeys,...}), or
// plain normal request options. Snapshots must be captured explicitly by the
// caller. modelPlanResponse/modelReviewResponse/similarArtistResponse and
// queueabilityResponses are JSON fixtures, never live provider callbacks.
// observer is the only injected callback, matching the existing sync hook. It
// must be read-only; its effects require the caller's separate runtime audit.
async function runOperationalDiscoveryPath({ pool, request = {}, tasteSnapshot = null, historySnapshot = null,
  productionSnapshot = null, scrobbleSnapshot = null, genreProfileSnapshot = null,
  modelPlanResponse = null, modelReviewResponse = null, modelReviewFailure = false,
  similarArtistResponse = null, queueabilityResponses = null, observer = null,
  configSnapshot = {} } = {}) {
  assert.ok(plain(request), "A frozen discovery request must be an object.");
  assert.ok(observer === null || typeof observer === "function", "Observer must be a synchronous function.");
  for (const [name, value] of Object.entries({ tasteSnapshot, historySnapshot, productionSnapshot, scrobbleSnapshot,
    genreProfileSnapshot, modelPlanResponse, modelReviewResponse, queueabilityResponses, configSnapshot })) {
    assert.ok(value === null || plain(value), `${name} must be a JSON object.`);
  }
  assert.ok(similarArtistResponse === null || Array.isArray(similarArtistResponse), "Similar-artist response must be an array.");
  // Capture every JSON response before the first await, so later mutations by
  // the caller cannot change which evidence this run reads.
  tasteSnapshot = tasteSnapshot === null ? null : clone(tasteSnapshot);
  historySnapshot = historySnapshot === null ? null : clone(historySnapshot);
  productionSnapshot = productionSnapshot === null ? null : clone(productionSnapshot);
  scrobbleSnapshot = scrobbleSnapshot === null ? null : clone(scrobbleSnapshot);
  genreProfileSnapshot = genreProfileSnapshot === null ? null : clone(genreProfileSnapshot);
  modelPlanResponse = modelPlanResponse === null ? null : clone(modelPlanResponse);
  modelReviewResponse = modelReviewResponse === null ? null : clone(modelReviewResponse);
  queueabilityResponses = queueabilityResponses === null ? null : clone(queueabilityResponses);
  similarArtistResponse = similarArtistResponse === null ? null : clone(similarArtistResponse);
  const rows = inputCandidates(pool, clone(request));
  const guard = createOperationalWriteGuard(), trace = [];
  const push = (stage, status, details = {}) => trace.push({ stage, status, ...details });
  const config = { llmProvider: "frozen-response", lastfm: { timeoutMs: 3500 }, ...clone(configSnapshot) };
  const suppliedTaste = freezeTasteView(tasteSnapshot);
  // Explicit neutral snapshot only supplies the reviewer/artist-expansion read
  // interface. Missing taste is disclosed; admission still receives null.
  const taste = suppliedTaste || freezeTasteView(EMPTY_TASTE);
  const tasteProfile = { ...taste };
  for (const method of ["write", "save", "recordFeedback", "recordCalibration", "recordCandidate", "setRating"])
    tasteProfile[method] = guard.trap(`taste.${method}`);
  const history = frozenHistory(historySnapshot);
  if (history) for (const method of ["record", "save", "load"]) history[method] = guard.trap(`history.${method}`);
  const genreProfiles = frozenGenreProfiles(genreProfileSnapshot, guard);
  const requestPolicy = createDiscoveryRequestPolicy({ ...engine, config, normalizeMatchText,
    openAiCompatibleProviders: new Set(["openai-compatible", "lmstudio", "llamacpp", "vllm"]), yearRangeUtil });
  let options = clone(request.options || request);
  assert.equal(exactIntent(options), null, "Exact verification requests use a separate mutating route and are outside this replay.");
  options = requestPolicy.withNormalizedYearFilter(options);
  options.scoringMode = engine.normalizeScoringMode(options);
  options = genreProfiles.augmentOptions(options);
  const originalRequestedCount = engine.parseRequestedCount(options);
  const requestedCount = engine.effectiveDiscoveryCount(options, engine.buildDiscoveryProfile(options));
  assert.ok(Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 20,
    "Operational replay is bounded to 1–20 selected tracks.");
  options = { ...options, effectiveCount: requestedCount, originalRequestedCount };
  const catalogMode = requestPolicy.shouldSkipModelForCatalogSearch(options);
  const strictRoonMode = requestPolicy.isStrictRoonQueueMode(options);
  const budgets = requestPolicy.strictSearchBudgets(options, requestedCount);
  push("request-normalization", "executed", { requestedCount, originalRequestedCount, scoringMode: options.scoringMode,
    explicitGenres: String(options.genres || ""), catalogMode, strictRoonMode });
  const plan = catalogMode ? null : clone(modelPlanResponse?.plan || null);
  push("model-planning", catalogMode ? "policy-skipped" : modelPlanResponse ? "frozen-response" : "not-replayed");
  options = genreProfiles.augmentOptions({ ...options, llmSearchPlan: plan, llmCandidates: [] });
  if (!strictRoonMode) options.requireRoonQueueable = "";
  // The frozen seam intentionally cannot refetch prior suggestions outside
  // its exact pool. This restriction is reported below, not a live policy edit.
  options.allowPreviousFallback = false;
  const similar = createSimilarArtistExpansion({ buildDiscoveryProfile: engine.buildDiscoveryProfile,
    normalizeScoringMode: engine.normalizeScoringMode, config, tasteProfile,
    lastfm: { status: () => ({ enabled: similarArtistResponse !== null, apiKeyConfigured: similarArtistResponse !== null }) },
    rabbitHoleGraph: { similarArtistsForSeeds: async () => clone(similarArtistResponse || []) },
    withTimeout: async promise => promise });
  if (options.scoringMode !== "pure") options = await similar.withSimilarArtistSeeds(options, requestedCount);
  push("similar-artist-expansion", options.scoringMode === "pure" ? "policy-skipped" :
    similarArtistResponse !== null ? "frozen-response" : "not-replayed", {
    enabled: options.similarArtistExpansion?.enabled === true, added: options.similarArtistExpansion?.returned || 0 });
  const profile = engine.buildDiscoveryProfile(options);
  push("strict-roon-preflight", strictRoonMode && options.zoneId ? "not-replayed" : "policy-skipped");
  const scrobbleHistory = scrobbleSnapshot === null ? null : clone(scrobbleSnapshot);
  push("scrobble-history", scrobbleSnapshot === null ? "not-replayed" : "frozen-response", {
    checked: scrobbleHistory?.checked === true, available: !!scrobbleHistory?.checked && !scrobbleHistory?.error });
  const byId = new Map(rows.map(track => [String(track.tidalId || track.tidal?.id || track.id || ""), track]));
  const tidal = { isConfigured: () => true, getTrack: async id => clone(byId.get(String(id)) || null) };
  for (const method of ["searchTracks", "searchArtists", "getArtistTracks", "getArtistAlbums", "getAlbumTracks", "getSimilarArtists", "getPlaylists"])
    tidal[method] = guard.trap(`provider.${method}`);
  tidal.verify = guard.trap("provider.verify");
  for (const method of ["createPlaylist", "addPlaylistTracks", "queueTracks", "play"])
    tidal[method] = guard.trap(`tidal.${method}`);
  const discoverFrozen = args => engine.discoverTracks({ ...args, tidal, directCandidates: clone(rows),
    options: { ...args.options, allowPreviousFallback: false, discoveryRuntimeMs: 1000 }, queryYieldTracker: null });
  let result = await discoverFrozen({ options, history, tasteProfile: suppliedTaste, scrobbleHistory });
  push("catalogue-admission", "executed-frozen-pool", { inputCount: rows.length, ...counts(result) });
  const rerank = frozenProductionReranker(productionSnapshot);
  const orchestration = createDiscoveryOrchestration({ ...engine, mergeTrackLists, tidal, discoveryHistory: history,
    tasteProfile: suppliedTaste, queryYieldTracker: null, discoverTracks: discoverFrozen,
    withTimeout: async promise => promise,
    catalogScoutObserver: observer && ((candidates, context) => {
      const before = fingerprint(candidates);
      try {
        const observed = observer(candidates, context);
        if (observed?.then) throw new Error("Only a synchronous observation is supported.");
        push("catalog-scout-observation", "executed", { candidateCount: candidates.length, inputFingerprint: before,
          returnedCandidatesIgnored: true, productionApplied: false });
        return observed;
      } catch {
        push("catalog-scout-observation", "neutral-fallback", { inputFingerprint: before, productionApplied: false });
        throw new Error("Frozen catalog observation unavailable.");
      }
    }),
    recommendationV2Reranker: rerank && ((candidates, context) => {
      const before = fingerprint(candidates), scored = rerank(candidates, context);
      push("production-effnet", "executed-frozen-snapshot", { inputFingerprint: before,
        applied: scored.diagnostics?.applied === true, coverage: scored.diagnostics?.coverage ?? null });
      return scored;
    }),
    selectDiscoveryLaneCandidates: (...args) => {
      if (!observer) push("catalog-scout-observation", "not-configured", { productionApplied: false });
      if (!rerank) push("production-effnet", "not-replayed", { applied: false });
      const selected = engine.selectDiscoveryLaneCandidates(...args);
      push("lane-diversity-selection", "executed", { inputCount: args[0].length, selected: selected.tracks?.length || 0 });
      return selected;
    } });
  result = await orchestration.runAutoBroadenSearches(result, options, profile, requestedCount, scrobbleHistory, budgets);
  push("auto-broaden", "executed-frozen-pool", { attempted: result.verification?.autoBroaden?.attempted || 0,
    freshProviderCollection: false });
  let modelReview = { enabled: false, scored: 0, rejected: 0, replayed: false };
  if (modelReviewResponse !== null || modelReviewFailure) {
    const reviewer = createModelCandidateReviewer({ ...modelAudit, candidateIdentityKeys: engine.candidateIdentityKeys,
      config, mergeTrackLists, normalizeMatchText, tasteProfile,
      scoreCandidateBatch: async () => {
        if (modelReviewFailure) throw new Error("Frozen model review unavailable.");
        return clone(modelReviewResponse);
      } });
    try {
      const reviewed = await reviewer.applyModelCandidateReview(result, options);
      result = reviewed.result; modelReview = { ...reviewed.review, replayed: true };
      push("model-candidate-review", "executed-frozen-response", { scored: modelReview.scored, rejected: modelReview.rejected });
    } catch {
      modelReview = { enabled: true, scored: 0, rejected: 0, replayed: true, error: "Frozen model review unavailable." };
      push("model-candidate-review", "neutral-fallback");
    }
  } else push("model-candidate-review", "not-replayed");
  result = orchestration.rebalanceDiscoveryResult(result, options, profile, requestedCount);
  if (!trace.some(item => item.stage === "lane-diversity-selection")) {
    push("catalog-scout-observation", "empty-pool-skipped", { productionApplied: false });
    push("production-effnet", "empty-pool-skipped", { applied: false });
    push("lane-diversity-selection", "empty-pool-skipped", { inputCount: 0, selected: 0 });
  }
  const verification = createDiscoveryResultVerification({ candidateIdentityKeys: engine.candidateIdentityKeys,
    mergeTrackLists, normalizeMatchText });
  result = verification.syncFinalResultVerification(result, requestedCount);
  if (strictRoonMode) {
    assert.ok(options.zoneId, "Strict Roon replay requires a frozen zone ID.");
    assert.ok(queueabilityResponses !== null, "Strict Roon replay requires frozen queueability responses.");
    const roon = { canQueueTrack: async (track, _zone, policy) => {
      assert.equal(policy.allowBridge, false);
      return clone(queueabilityResponses[identity(track)] || { success: false, reason: "No frozen exact queueability response." });
    }, resolveDirectBridgeBatch: guard.trap("roon.resolveDirectBridgeBatch"), queue: guard.trap("roon.queue"), play: guard.trap("roon.play") };
    const queueFilter = createRoonQueueableFilter({ ...engine, ...verification, normalizeMatchText, roon, tidal, yearRangeUtil });
    // Do not accept an input's stale queue action as a newly checked result.
    const unverified = clone(result);
    for (const track of [...(unverified.tracks || []), ...(unverified.alternates || [])]) delete track.roon;
    result = await queueFilter.filterForRoonQueueable(unverified, options.zoneId, { ...options, allowBridge: false });
    push("queueability-filter", "executed-frozen-response", { checked: result.verification?.roonChecked || 0,
      directBridgeDisabled: true, ...counts(result) });
  } else {
    result = verification.tidalPlaylistBridgeResult(result, requestedCount);
    push("queueability-filter", "executed-bridge-annotation", { playlistCreated: false, ...counts(result) });
  }
  result = verification.syncFinalResultVerification(result, requestedCount);
  push("strict-roon-rescue", strictRoonMode && verification.shouldRunRoonFirstRescue(result) ? "not-replayed" : "policy-skipped");
  const novelty = createDiscoveryNoveltyPolicy({ discoveryHistory: history, candidateIdentityKeys: engine.candidateIdentityKeys });
  result = verification.syncFinalResultVerification(novelty.suppressPreviouslySuggestedResultTracks(result, options), requestedCount);
  push("final-novelty-guard", "executed", counts(result));
  const allowed = new Set(rows.flatMap(engine.candidateIdentityKeys));
  assert.ok([...(result.tracks || []), ...(result.alternates || [])].every(track =>
    engine.candidateIdentityKeys(track).some(key => allowed.has(key))), "Result escaped its frozen exact candidate pool.");
  push("persistence-and-broadcast", "blocked-boundary", { writes: 0, playback: 0 });
  const boundary = {
    kind: "frozen-discovery-operational-path", httpRouteExercised: false, liveProviderQueries: false,
    modelInference: false, liveScrobbleFetch: false, runtimeDatabaseWrites: 0, historyWrites: 0,
    queueWrites: 0, playbackActions: 0, productionApplied: false, coldRequestInferenceImplemented: false,
    sourceSeam: "directCandidates; exact frozen catalogue pool",
    tasteSnapshotAvailable: tasteSnapshot !== null, historySnapshotAvailable: historySnapshot !== null,
    productionSnapshotAvailable: productionSnapshot !== null, scrobbleSnapshotAvailable: scrobbleSnapshot !== null,
    modelReviewResponseAvailable: modelReviewResponse !== null, providerQueueResponsesReplayed: strictRoonMode,
    externalObserverEffectsAudited: false,
    observerBoundary: observer ? "caller-supplied synchronous read-only observer; audit its effects separately" : "not configured",
    historyDecayUsesWallClock: true, outOfPoolPreviousFallbackDisabled: true,
    unreplayed: ["HTTP authentication/request transport", "live catalogue queries and verification", "live model planning/review and timeouts",
      "live Last.fm history/similar-artist fetch", "query-yield persistence", "strict Roon preflight/rescue",
      "real provider queueability", "playlist/direct-bridge creation", "runtime persistence/broadcast", "on-demand cold catalogue inference"]
  };
  return { result, trace, boundary, modelReview, normalizedOptions: options,
    writeSafety: { ...guard.snapshot(), storesConstructed: 0, runtimeFilesRead: 0, analysisQueued: 0,
      counterScope: "module-owned factories and facades; external observer effects require separate audit" } };
}

module.exports = { createOperationalWriteGuard, runOperationalDiscoveryPath };
