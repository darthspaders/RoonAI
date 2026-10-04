"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function createDiscoveryOrchestration({
  artistKeysForCandidate,
  autoBroadenSearchPasses,
  buildDiscoveryProfile,
  defaultPerRunArtistCap,
  discoverTracks,
  discoveryHistory,
  hardDurationConstraintFor,
  mergeTrackLists,
  queryYieldTracker,
  recommendationV2Reranker = null,
  selectDiscoveryLaneCandidates,
  shouldContinueAutoBroadenAfterError,
  tasteProfile,
  tidal,
  withTimeout
} = {}) {
  function discoveryPoolCount(result = {}) {
    return mergeTrackLists(result.tracks, result.alternates).length;
  }

  function mergeQueryYieldSummaries(base = {}, extra = {}) {
    if (!base?.recordCount && !extra?.recordCount) return base?.recordCount ? base : extra;
    const combineItems = (left = [], right = [], limit = 8) => [...left, ...right].slice(0, limit);
    return {
      enabled: Boolean(base.enabled || extra.enabled),
      attempted: Number(base.attempted || 0) + Number(extra.attempted || 0),
      returned: Number(base.returned || 0) + Number(extra.returned || 0),
      accepted: Number(base.accepted || 0) + Number(extra.accepted || 0),
      rejected: Number(base.rejected || 0) + Number(extra.rejected || 0),
      seoRejects: Number(base.seoRejects || 0) + Number(extra.seoRejects || 0),
      genreRejects: Number(base.genreRejects || 0) + Number(extra.genreRejects || 0),
      errorCount: Number(base.errorCount || 0) + Number(extra.errorCount || 0),
      recordCount: Number(base.recordCount || 0) + Number(extra.recordCount || 0),
      prunedCount: Number(base.prunedCount || 0) + Number(extra.prunedCount || 0),
      adjustments: combineItems(base.adjustments || [], extra.adjustments || []),
      pruned: combineItems(base.pruned || [], extra.pruned || [], 12),
      laneBudgetStops: combineItems(base.laneBudgetStops || [], extra.laneBudgetStops || [], 8),
      best: combineItems(base.best || [], extra.best || []),
      worst: combineItems(base.worst || [], extra.worst || []),
      error: base.error || extra.error || ""
    };
  }

  function annotateAutoBroadenTracks(list = [], pass = {}) {
    return list.map((track) => ({
      ...track,
      autoBroadened: true,
      discoverySource: track.discoverySource || pass.label || "Auto-broadened search",
      discoveryLane: track.discoveryLane || pass.lane || "core-expanded",
      statusChecks: Array.from(new Set([
        ...(Array.isArray(track.statusChecks) ? track.statusChecks : []),
        pass.label || "Auto-broadened search"
      ].filter(Boolean)))
    }));
  }

  function mergeDiscoveryPoolDiagnostics(base = {}, extra = {}, poolAfter = 0) {
    const baseAccumulation = base.candidateAccumulation || {};
    const extraAccumulation = extra.candidateAccumulation || {};
    const durationCandidates = new Map();
    for (const item of [
      ...(Array.isArray(baseAccumulation.durationCandidates) ? baseAccumulation.durationCandidates : []),
      ...(Array.isArray(extraAccumulation.durationCandidates) ? extraAccumulation.durationCandidates : [])
    ]) {
      const key = cleanText(item?.key || `${item?.artist || ""}|${item?.title || ""}`);
      if (key) durationCandidates.set(key, item);
    }
    const acceptedFamilies = new Map();
    for (const item of [
      ...(Array.isArray(base.acceptedQueryFamilies) ? base.acceptedQueryFamilies : []),
      ...(Array.isArray(extra.acceptedQueryFamilies) ? extra.acceptedQueryFamilies : [])
    ]) {
      const key = `${item?.lane || "core"}|${item?.source || "discovery"}|${item?.query || ""}`;
      const current = acceptedFamilies.get(key) || { ...item, accepted: 0 };
      current.accepted += Number(item?.accepted || 0);
      acceptedFamilies.set(key, current);
    }
    const mergedPool = Math.max(
      Number(poolAfter || 0),
      Number(baseAccumulation.uniqueCandidatesBeforeSelection || 0),
      Number(extraAccumulation.uniqueCandidatesBeforeSelection || 0)
    );
    return {
      ...base,
      ...extra,
      requested: Number(extra.requested || base.requested || 0),
      generated: Number(base.generated || 0) + Number(extra.generated || 0),
      kept: Number(poolAfter || extra.kept || base.kept || 0),
      alternates: Number(extra.alternates || base.alternates || 0),
      discarded: Number(base.discarded || 0) + Number(extra.discarded || 0),
      retainedPool: mergedPool,
      budgetExhausted: Boolean(base.budgetExhausted || extra.budgetExhausted),
      scoreFiltered: Number(base.scoreFiltered || 0) + Number(extra.scoreFiltered || 0),
      previousHeldBack: Number(base.previousHeldBack || 0) + Number(extra.previousHeldBack || 0),
      previousFallbackKept: Number(base.previousFallbackKept || 0) + Number(extra.previousFallbackKept || 0),
      candidateAccumulation: {
        ...baseAccumulation,
        ...extraAccumulation,
        rawCandidates: Number(baseAccumulation.rawCandidates || 0) + Number(extraAccumulation.rawCandidates || 0),
        uniqueCandidatesBeforeSelection: mergedPool,
        validDurationCandidatesBeforeSelection: durationCandidates.size || Math.max(
          Number(baseAccumulation.validDurationCandidatesBeforeSelection || 0),
          Number(extraAccumulation.validDurationCandidatesBeforeSelection || 0)
        ),
        duplicateCandidates: Number(baseAccumulation.duplicateCandidates || 0) + Number(extraAccumulation.duplicateCandidates || 0),
        invalidIdentityCandidates: Number(baseAccumulation.invalidIdentityCandidates || 0) + Number(extraAccumulation.invalidIdentityCandidates || 0),
        duplicateExamples: [
          ...(Array.isArray(baseAccumulation.duplicateExamples) ? baseAccumulation.duplicateExamples : []),
          ...(Array.isArray(extraAccumulation.duplicateExamples) ? extraAccumulation.duplicateExamples : [])
        ].slice(0, 8),
        durationCandidates: [...durationCandidates.values()].slice(0, 160)
      },
      acceptedQueryFamilies: [...acceptedFamilies.values()].slice(0, 80),
      searchStops: [
        ...(Array.isArray(base.searchStops) ? base.searchStops : []),
        ...(Array.isArray(extra.searchStops) ? extra.searchStops : [])
      ].slice(0, 240),
      catalogPagination: [
        ...(Array.isArray(base.catalogPagination) ? base.catalogPagination : []),
        ...(Array.isArray(extra.catalogPagination) ? extra.catalogPagination : [])
      ].slice(0, 160),
      deepCatalog: {
        ...(base.deepCatalog || {}),
        ...(extra.deepCatalog || {}),
        enabled: Boolean(base.deepCatalog?.enabled || extra.deepCatalog?.enabled),
        triggered: Boolean(base.deepCatalog?.triggered || extra.deepCatalog?.triggered),
        attempted: Number(base.deepCatalog?.attempted || 0) + Number(extra.deepCatalog?.attempted || 0),
        returned: Number(base.deepCatalog?.returned || 0) + Number(extra.deepCatalog?.returned || 0),
        accepted: Number(base.deepCatalog?.accepted || 0) + Number(extra.deepCatalog?.accepted || 0),
        duplicateCount: Number(base.deepCatalog?.duplicateCount || 0) + Number(extra.deepCatalog?.duplicateCount || 0),
        anchors: [
          ...(Array.isArray(base.deepCatalog?.anchors) ? base.deepCatalog.anchors : []),
          ...(Array.isArray(extra.deepCatalog?.anchors) ? extra.deepCatalog.anchors : [])
        ].slice(0, 8)
      },
      finalSelection: {
        ...(base.finalSelection || {}),
        ...(extra.finalSelection || {}),
        candidatesBeforeSelection: mergedPool,
        selected: Number(poolAfter || extra.selected || base.selected || 0),
        alternates: Number(extra.alternates || base.alternates || 0)
      }
    };
  }

  async function runAutoBroadenSearches(discovered = {}, baseOptions = {}, searchProfile = buildDiscoveryProfile(baseOptions), requestedCount = 8, scrobbleHistory = null, budgets = {}) {
    const passes = autoBroadenSearchPasses(baseOptions, searchProfile, discovered, requestedCount);
    const durationConstrainedGenreSearch = Boolean(
      typeof hardDurationConstraintFor === "function" &&
      hardDurationConstraintFor(baseOptions) &&
      searchProfile.targetGenres?.length
    );
    const durationTargetPool = durationConstrainedGenreSearch
      ? Math.max(requestedCount + 4, requestedCount * 2)
      : 0;
    const queryYieldHealth = passes.find((pass) => pass.queryYieldHealth)?.queryYieldHealth || null;
    const initialDiscoveryError = String(discovered.verification?.discoveryError || "");
    const initialTimedOut = /\b(?:timed out|took too long)\b/i.test(initialDiscoveryError);
    const runnablePasses = initialTimedOut
      ? passes.filter((pass) => pass.lane === "yield-retry" || pass.lane === "core-expanded").slice(0, 1)
      : (durationConstrainedGenreSearch ? passes.slice(0, 1) : passes);
    const summary = {
      enabled: true,
      attempted: 0,
      added: 0,
      poolBefore: discoveryPoolCount(discovered),
      poolAfter: discoveryPoolCount(discovered),
      targetPool: durationConstrainedGenreSearch
        ? durationTargetPool
        : (passes[0]?.targetPool || 0),
      planned: passes.map((pass) => ({
        lane: pass.lane,
        label: pass.label,
        stage: pass.stage || "",
        reason: pass.reason || ""
      })),
      initialTimeoutRetry: initialTimedOut && runnablePasses.length > 0,
      durationConstrainedGenreSearch,
      yieldAware: Boolean(queryYieldHealth?.retryNeeded),
      queryYieldHealth,
      lanes: [],
      errors: []
    };

    if (initialTimedOut && !runnablePasses.length) {
      return {
        ...discovered,
        verification: {
          ...(discovered.verification || {}),
          autoBroaden: {
            ...summary,
            enabled: false,
            skipped: true,
            reason: "Initial TIDAL discovery timed out; skipped auto-broaden retries to return control to the UI."
          }
        }
      };
    }

    if (!runnablePasses.length) {
      return {
        ...discovered,
        verification: {
          ...(discovered.verification || {}),
          autoBroaden: summary
        }
      };
    }

    let current = discovered;
    const perPassTimeoutMs = initialTimedOut
      ? Math.max(10_000, Math.min(16_000, Math.floor(Number(budgets.discoveryTimeoutMs || 30_000) / 3)))
      : Math.max(12_000, Math.min(60_000, Math.floor(Number(budgets.discoveryTimeoutMs || 30_000) / 2)));

    for (const pass of runnablePasses) {
      const beforePool = discoveryPoolCount(current);
      const effectiveTargetPool = durationConstrainedGenreSearch
        ? durationTargetPool
        : pass.targetPool;
      if (
        (current.tracks || []).length >= requestedCount ||
        (beforePool >= effectiveTargetPool && (current.tracks || []).length >= requestedCount)
      ) break;

      summary.attempted += 1;
      try {
        const broadened = await withTimeout(
          discoverTracks({
            tidal,
            options: {
              ...pass.options,
              discoveryRuntimeMs: Math.max(8_000, Math.min(30_000, perPassTimeoutMs - 2_000))
            },
            history: discoveryHistory,
            tasteProfile,
            scrobbleHistory,
            queryYieldTracker
          }),
          perPassTimeoutMs,
          `${pass.label} took too long.`
        );
        const broadenedTracks = annotateAutoBroadenTracks(broadened.tracks || [], pass);
        const broadenedAlternates = annotateAutoBroadenTracks(broadened.alternates || [], pass);
        const mergedTracks = mergeTrackLists(current.tracks, broadenedTracks);
        const mergedAlternates = mergeTrackLists(current.alternates, broadenedAlternates);
        const mergedPoolDiagnostics = mergeDiscoveryPoolDiagnostics(
          current.verification?.poolDiagnostics,
          broadened.verification?.poolDiagnostics,
          mergedTracks.length + mergedAlternates.length
        );
        current = {
          ...current,
          tracks: mergedTracks,
          alternates: mergedAlternates,
          discarded: [...(current.discarded || []), ...(broadened.discarded || [])],
          verification: {
            ...(current.verification || {}),
            queryYield: mergeQueryYieldSummaries(current.verification?.queryYield, broadened.verification?.queryYield),
            querySelectionDiagnostics: [
              ...(current.verification?.querySelectionDiagnostics || []),
              ...(broadened.verification?.querySelectionDiagnostics || [])
            ].slice(0, 160),
            tidalErrors: [
              ...(current.verification?.tidalErrors || []),
              ...(broadened.verification?.tidalErrors || [])
            ].slice(0, 24),
            poolDiagnostics: mergedPoolDiagnostics,
            autoBroaden: summary
          }
        };

        const afterPool = discoveryPoolCount(current);
        const added = Math.max(0, afterPool - beforePool);
        summary.added += added;
        summary.poolAfter = afterPool;
        summary.lanes.push({
          lane: pass.lane,
          label: pass.label,
          stage: pass.stage || "",
          reason: pass.reason,
          yieldAware: pass.lane === "yield-retry" || Boolean(pass.queryYieldHealth?.retryNeeded),
          generated: broadened.verification?.generated || 0,
          kept: broadened.tracks?.length || 0,
          alternates: broadened.alternates?.length || 0,
          added
        });
      } catch (error) {
        summary.errors.push({
          lane: pass.lane,
          label: pass.label,
          error: error.message
        });
        if (!shouldContinueAutoBroadenAfterError(error, {
          initialTimedOut,
          remainingPasses: Math.max(0, runnablePasses.length - summary.attempted),
          currentPool: discoveryPoolCount(current),
          requestedCount,
          poolBeforePass: beforePool,
          targetPool: pass.targetPool
        })) {
          break;
        }
      }
    }

    return {
      ...current,
      verification: {
        ...(current.verification || {}),
        autoBroaden: {
          ...summary,
          poolAfter: discoveryPoolCount(current)
        }
      }
    };
  }

  function rebalanceDiscoveryResult(result = {}, options = {}, profile = buildDiscoveryProfile(options), requestedCount = 8) {
    const originalPool = mergeTrackLists(result.tracks || [], result.alternates || []);
    if (!originalPool.length) return result;

    let pool = originalPool;
    let recommendationV2 = {
      enabled: false,
      invoked: false,
      applied: false,
      reason: "not-configured",
      candidateCount: originalPool.length,
      scoredCount: 0,
      coverage: 0
    };
    if (typeof recommendationV2Reranker === "function") {
      try {
        const reranked = recommendationV2Reranker(originalPool, {
          options,
          profile,
          requestedCount
        });
        if (Array.isArray(reranked?.candidates)) pool = reranked.candidates;
        if (reranked?.diagnostics) recommendationV2 = reranked.diagnostics;
      } catch (error) {
        recommendationV2 = {
          ...recommendationV2,
          invoked: true,
          reason: "rerank-failed",
          error: error.message
        };
      }
    }

    let calibration = null;
    try {
      calibration = typeof tasteProfile?.read === "function" ? tasteProfile.read().calibration : null;
    } catch {
      calibration = null;
    }

    const selection = selectDiscoveryLaneCandidates(pool, requestedCount, options, profile, calibration);
    const diagnostics = result.verification?.poolDiagnostics;
    const notes = Array.isArray(diagnostics?.notes) ? [...diagnostics.notes] : [];
    notes.push(`Final pool rebalanced for artist diversity: ${selection.tracks.length}/${pool.length} displayed before queue/playback verification.`);
    if (recommendationV2.enabled) {
      notes.push(recommendationV2.applied
        ? `Recommendation Engine v2 reranked ${recommendationV2.scoredCount}/${recommendationV2.candidateCount} candidates using ${recommendationV2.model} ${recommendationV2.modelVersion}.`
        : `Recommendation Engine v2 ${recommendationV2.mode || "shadow"} scored ${recommendationV2.scoredCount || 0}/${recommendationV2.candidateCount} candidates; existing ordering was preserved.`);
    }

    const selectedArtistCount = new Set(selection.tracks.flatMap(artistKeysForCandidate)).size;
    const retainedArtistCount = new Set(pool.flatMap(artistKeysForCandidate)).size;

    return {
      ...result,
      tracks: selection.tracks,
      alternates: selection.alternates,
      verification: {
        ...(result.verification || {}),
        laneQuotas: selection.quota,
        recommendationV2,
        perRunArtistCap: defaultPerRunArtistCap(options, profile, requestedCount),
        ...(diagnostics ? {
          poolDiagnostics: {
            ...diagnostics,
            notes: Array.from(new Set(notes.filter(Boolean))),
            lanes: {
              ...(diagnostics.lanes || {}),
              selected: selection.quota?.selected || {},
              available: selection.quota?.available || {},
              targets: selection.quota?.targets || {}
            },
            artistSpread: {
              ...(diagnostics.artistSpread || {}),
              selectedArtists: selectedArtistCount,
              retainedArtists: retainedArtistCount
            },
            finalSelection: {
              ...(diagnostics.finalSelection || {}),
              candidatesBeforeSelection: pool.length,
              selected: selection.tracks.length,
              alternates: selection.alternates.length,
              lostToSelection: Math.max(0, pool.length - selection.tracks.length - selection.alternates.length),
              diversityCapHeld: Number(
                selection.quota?.capHeld?.total ||
                diagnostics.finalSelection?.diversityCapHeld ||
                0
              )
            }
          }
        } : {})
      }
    };
  }

  return {
    annotateAutoBroadenTracks,
    discoveryPoolCount,
    mergeQueryYieldSummaries,
    rebalanceDiscoveryResult,
    runAutoBroadenSearches
  };
}

module.exports = {
  createDiscoveryOrchestration
};
