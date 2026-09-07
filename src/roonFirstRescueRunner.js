"use strict";

const yearRangeUtil = require("./yearRange");

function roonFirstResultIsEnough(result = {}, requestedCount = 8) {
  const kept = Array.isArray(result.tracks) ? result.tracks.length : 0;
  const requested = Math.max(1, Math.min(40, Number(requestedCount || 8)));
  const threshold = Math.min(requested, Math.max(6, Math.ceil(requested * 0.65)));
  return kept >= threshold;
}

function roonFirstSearchSettings(targetCount = 8, deepRoonSearch = false) {
  const target = Math.max(1, Math.min(40, Number(targetCount || 8)));
  if (deepRoonSearch) {
    return {
      candidateLimit: Math.min(1200, Math.max(target * 90, 750)),
      candidateLimitMax: 1500,
      maxQueries: Math.min(64, Math.max(36, target * 4)),
      searchLimit: 120,
      searchSummaryLimit: 48,
      enableArtistCrawl: true,
      artistCrawlSeedLimit: 4,
      artistCrawlCandidateLimit: Math.min(220, Math.max(target * 16, 120)),
      artistCrawlMaxMs: 10_000,
      artistCrawlTrackContainers: 2,
      artistCrawlAlbumContainers: 2,
      artistCrawlAlbumsPerArtist: 2,
      artistCrawlSimilarSeeds: 4,
      artistCrawlSimilarPerSeed: 2,
      artistCrawlTrackLoadCount: 60,
      artistCrawlAlbumLoadCount: 24,
      artistCrawlSimilarLoadCount: 20,
      artistFallbackSearchLimit: 70,
      verifyQueueActions: "",
      modelQueryLimit: 0
    };
  }

  return {
    candidateLimit: Math.min(180, Math.max(target * 10, target + 70)),
    candidateLimitMax: 240,
    maxQueries: Math.min(20, Math.max(12, target + 8)),
    searchLimit: 70,
    searchSummaryLimit: 24,
    enableArtistCrawl: true,
    artistCrawlSeedLimit: 2,
    artistCrawlCandidateLimit: Math.min(120, Math.max(target * 10, 60)),
    artistCrawlMaxMs: 5_000,
    artistCrawlTrackContainers: 1,
    artistCrawlAlbumContainers: 1,
    artistCrawlAlbumsPerArtist: 2,
    artistCrawlSimilarSeeds: 3,
    artistCrawlSimilarPerSeed: 2,
    artistCrawlTrackLoadCount: 50,
    artistCrawlAlbumLoadCount: 24,
    artistCrawlSimilarLoadCount: 20,
    artistFallbackSearchLimit: 50,
    verifyQueueActions: "",
    modelQueryLimit: 0
  };
}

function createRoonFirstRescueRunner({
  roon,
  withTimeout,
  mergeTrackLists,
  parseRequestedCount,
  releaseFilterRequiresVerification,
  decorateRoonFirstResult,
  decorateRoonFirstTimeoutFallback
} = {}) {
  async function runRoonFirstRescue(baseResult = {}, options = {}, requestedCount = 8, budgets = {}, reason = "") {
    if (!options.zoneId) return baseResult;

    const deepRoonSearch = /^(1|true|yes)$/i.test(String(options.deepRoonSearch || ""));
    const rescueBudgetMs = deepRoonSearch
      ? Math.max(30_000, Math.min(38_000, Number(budgets.roonFirstTimeoutMs || 35_000)))
      : Math.max(14_000, Math.min(20_000, Number(budgets.roonFirstTimeoutMs || 16_000)));
    const rescueScoringBudgetMs = deepRoonSearch
      ? Math.max(10_000, Math.min(16_000, Math.floor(rescueBudgetMs / 2)))
      : Math.max(6_000, Math.min(10_000, Math.floor(rescueBudgetMs / 2)));
    const targetCount = Math.max(1, Math.min(40, Number(requestedCount || parseRequestedCount(options) || 8)));
    const searchSettings = roonFirstSearchSettings(targetCount, deepRoonSearch);
    const verifiedReleaseRequired = releaseFilterRequiresVerification(options, yearRangeUtil.parseYearRange(options));
    const rescueOptions = {
      ...options,
      reference: "",
      llmSearchPlan: null,
      llmCandidates: [],
      disableRoonLabelQueries: "true",
      allowRoonYearUnverifiedFallback: verifiedReleaseRequired ? "false" : "true"
    };
    let roonFirst = null;
    let decorated = null;

    try {
      roonFirst = await withTimeout(
        roon.discoverQueueableTracks(rescueOptions, options.zoneId, {
          targetCount,
          ...searchSettings
        }),
        rescueBudgetMs,
        deepRoonSearch ? "Deep Roon-first rescue took too long." : "Roon-first rescue took too long."
      );

      decorated = await withTimeout(
        decorateRoonFirstResult(roonFirst, rescueOptions),
        rescueScoringBudgetMs,
        deepRoonSearch ? "Deep Roon-first rescue scoring took too long." : "Roon-first rescue scoring took too long."
      );

      if (!decorated.tracks?.length) {
        return {
          ...baseResult,
          discarded: [...(baseResult.discarded || []), ...(decorated.discarded || [])],
          verification: {
            ...(baseResult.verification || {}),
            ...(decorated.verification?.artistCrawl ? { artistCrawl: decorated.verification.artistCrawl } : {}),
            ...(!decorated.verification?.artistCrawl && roonFirst.verification?.artistCrawl ? { artistCrawl: roonFirst.verification.artistCrawl } : {}),
            roonFirstRescue: {
              attempted: true,
              reason,
              phase: deepRoonSearch ? "deep" : "quick",
              deep: deepRoonSearch,
              kept: 0,
              candidates: decorated.verification?.freshRoonCandidates || roonFirst.verification?.candidates || 0,
              searches: roonFirst.verification?.searches || 0,
              candidateLimit: searchSettings.candidateLimit,
              searchLimit: searchSettings.searchLimit,
              maxQueries: searchSettings.maxQueries,
              previousHeldBack: decorated.verification?.previouslySuggestedHeldBack || 0,
              error: ""
            }
          }
        };
      }

      const discarded = [...(baseResult.discarded || []), ...(decorated.discarded || [])];
      return {
        ...decorated,
        discarded,
        verification: {
          ...(baseResult.verification || {}),
          ...(decorated.verification || {}),
          strategy: "roon-first-rescue-after-tidal",
          roonQueueable: true,
          roonStrict: true,
          generated: decorated.tracks.length + discarded.length,
          kept: decorated.tracks.length,
          discarded: discarded.length,
          originalTidalStrategy: baseResult.verification?.strategy || "",
          originalTidalDiscoveryError: baseResult.verification?.discoveryError || "",
          queryYield: baseResult.verification?.queryYield || decorated.verification?.queryYield,
          autoBroaden: baseResult.verification?.autoBroaden || decorated.verification?.autoBroaden,
          modelCandidateReview: baseResult.verification?.modelCandidateReview || decorated.verification?.modelCandidateReview,
          roonFirstRescue: {
            attempted: true,
            reason,
            phase: deepRoonSearch ? "deep" : "quick",
            deep: deepRoonSearch,
            kept: decorated.tracks.length,
            candidates: decorated.verification?.freshRoonCandidates || roonFirst.verification?.candidates || 0,
            searches: roonFirst.verification?.searches || 0,
            candidateLimit: searchSettings.candidateLimit,
            searchLimit: searchSettings.searchLimit,
            maxQueries: searchSettings.maxQueries,
            previousHeldBack: decorated.verification?.previouslySuggestedHeldBack || 0,
            queueActionPresumed: Boolean(roonFirst.verification?.roonQueueActionPresumed),
            yearUnverifiedFallback: Boolean(decorated.verification?.roonYearUnverifiedFallback),
            yearUnverifiedFallbackCount: Number(decorated.verification?.roonYearUnverifiedFallbackCount || 0),
            error: ""
          }
        }
      };
    } catch (error) {
      if (roonFirst && mergeTrackLists(roonFirst.tracks, roonFirst.alternates).length) {
        decorated = decorateRoonFirstTimeoutFallback(roonFirst, rescueOptions, error);
        const discarded = [...(baseResult.discarded || []), ...(decorated.discarded || [])];
        if (decorated.tracks?.length) {
          return {
            ...decorated,
            discarded,
            verification: {
              ...(baseResult.verification || {}),
              ...(decorated.verification || {}),
              strategy: "roon-first-rescue-after-tidal",
              roonQueueable: true,
              roonStrict: true,
              generated: decorated.tracks.length + discarded.length,
              kept: decorated.tracks.length,
              discarded: discarded.length,
              originalTidalStrategy: baseResult.verification?.strategy || "",
              originalTidalDiscoveryError: baseResult.verification?.discoveryError || "",
              queryYield: baseResult.verification?.queryYield || decorated.verification?.queryYield,
              autoBroaden: baseResult.verification?.autoBroaden || decorated.verification?.autoBroaden,
              modelCandidateReview: baseResult.verification?.modelCandidateReview || decorated.verification?.modelCandidateReview,
              roonFirstRescue: {
                attempted: true,
                reason,
                phase: deepRoonSearch ? "deep" : "quick",
                deep: deepRoonSearch,
                kept: decorated.tracks.length,
                candidates: decorated.verification?.freshRoonCandidates || roonFirst.verification?.candidates || 0,
                searches: roonFirst.verification?.searches || 0,
                candidateLimit: searchSettings.candidateLimit,
                searchLimit: searchSettings.searchLimit,
                maxQueries: searchSettings.maxQueries,
                previousHeldBack: decorated.verification?.previouslySuggestedHeldBack || 0,
                queueActionPresumed: Boolean(roonFirst.verification?.roonQueueActionPresumed),
                yearUnverifiedFallback: Boolean(decorated.verification?.roonYearUnverifiedFallback),
                yearUnverifiedFallbackCount: Number(decorated.verification?.roonYearUnverifiedFallbackCount || 0),
                scoringFallback: true,
                error: error.message
              }
            }
          };
        }

        return {
          ...baseResult,
          discarded,
          verification: {
            ...(baseResult.verification || {}),
            ...(decorated.verification?.artistCrawl ? { artistCrawl: decorated.verification.artistCrawl } : {}),
            ...(!decorated.verification?.artistCrawl && roonFirst.verification?.artistCrawl ? { artistCrawl: roonFirst.verification.artistCrawl } : {}),
            roonFirstScoringFallback: true,
            roonFirstScoringError: error.message,
            roonFirstRescue: {
              attempted: true,
              reason,
              phase: deepRoonSearch ? "deep" : "quick",
              deep: deepRoonSearch,
              kept: 0,
              candidates: decorated.verification?.freshRoonCandidates || roonFirst.verification?.candidates || 0,
              searches: roonFirst.verification?.searches || 0,
              candidateLimit: searchSettings.candidateLimit,
              searchLimit: searchSettings.searchLimit,
              maxQueries: searchSettings.maxQueries,
              previousHeldBack: decorated.verification?.previouslySuggestedHeldBack || 0,
              scoringFallback: true,
              error: error.message
            }
          }
        };
      }

      return {
        ...baseResult,
        verification: {
          ...(baseResult.verification || {}),
          roonFirstRescue: {
            attempted: true,
            reason,
            phase: deepRoonSearch ? "deep" : "quick",
            deep: deepRoonSearch,
            kept: 0,
            candidates: 0,
            searches: 0,
            candidateLimit: searchSettings.candidateLimit,
            searchLimit: searchSettings.searchLimit,
            maxQueries: searchSettings.maxQueries,
            error: error.message
          }
        }
      };
    }
  }

  async function runFreshRoonRescue(baseResult = {}, options = {}, requestedCount = 8, budgets = {}, reason = "") {
    const quick = await runRoonFirstRescue(baseResult, options, requestedCount, budgets, reason);
    if (roonFirstResultIsEnough(quick, requestedCount)) return quick;

    const quickKept = Array.isArray(quick.tracks) ? quick.tracks.length : 0;
    const quickRescue = quick.verification?.roonFirstRescue || {};
    const deepReason = `${reason} Deep fresh Roon search after quick pass kept ${quickKept}.`;
    const deep = await runRoonFirstRescue(
      quick,
      {
        ...options,
        deepRoonSearch: "true"
      },
      requestedCount,
      {
        ...budgets,
        roonFirstTimeoutMs: Math.max(45_000, Number(budgets.roonFirstTimeoutMs || 0))
      },
      deepReason
    );
    const deepKept = Array.isArray(deep.tracks) ? deep.tracks.length : 0;
    const selected = deepKept >= quickKept ? deep : quick;
    selected.verification = {
      ...(selected.verification || {}),
      roonFirstRescue: {
        ...(selected.verification?.roonFirstRescue || {}),
        quickKept,
        quickSearches: quickRescue.searches || 0,
        deepAttempted: true
      }
    };
    return selected;
  }

  return {
    runFreshRoonRescue,
    runRoonFirstRescue
  };
}

module.exports = {
  createRoonFirstRescueRunner,
  roonFirstResultIsEnough,
  roonFirstSearchSettings
};
