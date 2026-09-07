"use strict";

function createDiscoveryOrchestration({
  artistKeysForCandidate,
  autoBroadenSearchPasses,
  buildDiscoveryProfile,
  defaultPerRunArtistCap,
  discoverTracks,
  discoveryHistory,
  mergeTrackLists,
  queryYieldTracker,
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

  async function runAutoBroadenSearches(discovered = {}, baseOptions = {}, searchProfile = buildDiscoveryProfile(baseOptions), requestedCount = 8, scrobbleHistory = null, budgets = {}) {
    const passes = autoBroadenSearchPasses(baseOptions, searchProfile, discovered, requestedCount);
    const queryYieldHealth = passes.find((pass) => pass.queryYieldHealth)?.queryYieldHealth || null;
    const initialDiscoveryError = String(discovered.verification?.discoveryError || "");
    const initialTimedOut = /\b(?:timed out|took too long)\b/i.test(initialDiscoveryError);
    const runnablePasses = initialTimedOut
      ? passes.filter((pass) => pass.lane === "yield-retry" || pass.lane === "core-expanded").slice(0, 1)
      : passes;
    const summary = {
      enabled: true,
      attempted: 0,
      added: 0,
      poolBefore: discoveryPoolCount(discovered),
      poolAfter: discoveryPoolCount(discovered),
      targetPool: passes[0]?.targetPool || 0,
      planned: passes.map((pass) => ({
        lane: pass.lane,
        label: pass.label,
        stage: pass.stage || "",
        reason: pass.reason || ""
      })),
      initialTimeoutRetry: initialTimedOut && runnablePasses.length > 0,
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
      if (beforePool >= pass.targetPool && (current.tracks || []).length >= requestedCount) break;

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
        current = {
          ...current,
          tracks: mergeTrackLists(current.tracks, broadenedTracks),
          alternates: mergeTrackLists(current.alternates, broadenedAlternates),
          discarded: [...(current.discarded || []), ...(broadened.discarded || [])],
          verification: {
            ...(current.verification || {}),
            queryYield: mergeQueryYieldSummaries(current.verification?.queryYield, broadened.verification?.queryYield),
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
    const pool = mergeTrackLists(result.tracks || [], result.alternates || []);
    if (!pool.length) return result;

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

    const selectedArtistCount = new Set(selection.tracks.flatMap(artistKeysForCandidate)).size;
    const retainedArtistCount = new Set(pool.flatMap(artistKeysForCandidate)).size;

    return {
      ...result,
      tracks: selection.tracks,
      alternates: selection.alternates,
      verification: {
        ...(result.verification || {}),
        laneQuotas: selection.quota,
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
