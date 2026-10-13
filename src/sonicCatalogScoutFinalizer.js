"use strict";

const assert = require("node:assert/strict");
const { discoverTracks, buildDiscoveryProfile, artistKeysForCandidate, defaultPerRunArtistCap, selectDiscoveryLaneCandidates } = require("./discoveryEngine");
const { createDiscoveryOrchestration } = require("./discoveryOrchestration");
const { freezeTasteView } = require("./sonicEnsembleTasteShadow");
const { DiscoveryHistory } = require("./discoveryHistory");
const { createRecommendationV2DiscoveryReranker } = require("./recommendationV2Discovery");
const clone = value => JSON.parse(JSON.stringify(value));

function frozenHistory(snapshot) {
  if (!snapshot) return null;
  const view = Object.create(DiscoveryHistory.prototype);
  Object.assign(view, { maxEntries: 0, recentWindowMs: 259200000, artistRecentWindowMs: 1209600000,
    labelRecentWindowMs: 1814400000, sourceRecentWindowMs: 1814400000, ...snapshot.settings, entries: new Map() });
  for (const entry of snapshot.entries || []) view.mapEntry(clone(entry));
  for (const method of ["record", "save", "load"]) view[method] = () => { throw new Error("Frozen discovery history is read-only."); };
  return view;
}

function frozenProductionReranker(snapshot) {
  if (!snapshot) return null;
  assert.equal(snapshot.model, "discogs-effnet");
  assert.equal(snapshot.modelVersion, "1");
  const profiles = clone(snapshot.profiles || []), embeddings = new Map(clone(snapshot.embeddings || []));
  return createRecommendationV2DiscoveryReranker({ enabled: true, model: snapshot.model, modelVersion: snapshot.modelVersion,
    productionMode: snapshot.mode, maxAdjustment: snapshot.maxAdjustment, minCoverage: snapshot.minCoverage,
    minScored: snapshot.minScored, profilesProvider: () => profiles,
    recommendationEngine: { store: { enabled: true, getEmbedding: identity => clone(embeddings.get(identity) || null) } },
    coverageService: null, analysisService: null, logger: null }).rerankCandidates;
}

// Replay the real admission/scoring and orchestration functions on frozen
// catalogue rows. The provider facade can only return supplied exact rows;
// it cannot search, fetch, write history, enqueue analysis or trigger playback.
async function finalizeCatalogScoutCandidates(candidates, {
  options = {}, requestedCount = 3, tasteSnapshot = null, historySnapshot = null, productionSnapshot = null
} = {}) {
  assert.ok(Array.isArray(candidates) && candidates.length <= 100);
  assert.ok(Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 20);
  const rows = clone(candidates), byId = new Map(rows.map(row => [String(row.tidalId || row.tidal?.tidalId || row.id || ""), row]));
  const requestOptions = { ...clone(options), count: requestedCount, effectiveCount: requestedCount,
    originalRequestedCount: requestedCount, discoveryRuntimeMs: 1000, allowPreviousFallback: false };
  const tasteProfile = freezeTasteView(tasteSnapshot), history = frozenHistory(historySnapshot);
  const tidal = { isConfigured: () => true, searchTracks: async () => [], searchArtists: async () => [],
    getArtist: async () => null, getArtistTracks: async () => [], getArtistAlbums: async () => [],
    getAlbumTracks: async () => [], getSimilarArtists: async () => [], getPlaylists: async () => [],
    getTrack: async id => clone(byId.get(String(id)) || null), verify: async () => null };
  const admitted = await discoverTracks({ tidal, options: requestOptions, history, tasteProfile,
    scrobbleHistory: null, queryYieldTracker: null, directCandidates: rows });
  const mergeTrackLists = (...lists) => {
    const unique = new Map();
    for (const row of lists.flat().filter(Boolean)) {
      const identity = String(row.identityKey || row.tidal?.identityKey || (row.tidal?.tidalId ? `tidal:${row.tidal.tidalId}` : ""));
      const key = identity || `${row.artist}|${row.title}`;
      if (!unique.has(key)) unique.set(key, row);
    }
    return [...unique.values()];
  };
  const orchestration = createDiscoveryOrchestration({ artistKeysForCandidate, buildDiscoveryProfile,
    defaultPerRunArtistCap, mergeTrackLists, selectDiscoveryLaneCandidates, tasteProfile,
    recommendationV2Reranker: frozenProductionReranker(productionSnapshot) });
  const result = orchestration.rebalanceDiscoveryResult(admitted, requestOptions, buildDiscoveryProfile(requestOptions), requestedCount);
  return { ...result, verification: { ...result.verification, catalogScoutReplay: {
    frozenInputCount: rows.length, productionApplied: false, providersQueried: false,
    historyWrites: 0, analysisQueued: 0, scrobbleHistoryReplayed: false, modelReviewReplayed: false,
    providerQueueVerificationReplayed: false,
    boundary: "real catalogue admission, taste scoring, EffNet Blend and final lane/diversity selection; no queue verification" } } };
}

module.exports = { frozenHistory, frozenProductionReranker, finalizeCatalogScoutCandidates };
