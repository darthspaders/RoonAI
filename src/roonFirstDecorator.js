"use strict";

const yearRangeUtil = require("./yearRange");
const { requestAllowsPreviousSuggestions } = require("./discoveryNoveltyPolicy");
const { roonRescueSceneAnchor, scoreWithRoonFloor } = require("./roonRescuePolicy");

function sortCandidates(left, right) {
  return (
    Number(right.score || 0) - Number(left.score || 0) ||
    Number(right.durationMs || 0) - Number(left.durationMs || 0)
  );
}

function createRoonFirstDecorator(deps = {}) {
  const {
    buildDiscoveryProfile,
    releaseFilterRequiresVerification,
    parseRequestedCount,
    minimumScoreFor,
    minimumScoreLabel,
    mergeTrackLists,
    discoveryHistory,
    enrichRoonTracksOpportunistically,
    nearYearFallbackOptions,
    rejectReason,
    previouslyRecommendedArtistReason,
    scoreBreakdownFor,
    tasteProfile,
    belowMinimumSoftRejectReason,
    reasonFor,
    whyBulletsFor,
    discoveryStatusFor,
    queueableStatusChecks,
    diversifyCandidates,
    requestAllowsArtistCluster
  } = deps;

  async function decorateRoonFirstResult(roonResult, options = {}) {
    const yearRange = yearRangeUtil.parseYearRange(options);
    const scoringOptions = yearRange ? { ...options, years: yearRange.label } : options;
    const discoveryProfile = buildDiscoveryProfile(scoringOptions);
    const verifiedReleaseRequired = releaseFilterRequiresVerification(scoringOptions, yearRange);
    const allowRoonYearUnverified = !verifiedReleaseRequired &&
      /^(1|true|yes)$/i.test(String(options.allowRoonYearUnverifiedFallback || ""));
    const deepRoonSearch = /^(1|true|yes)$/i.test(String(options.deepRoonSearch || ""));
    const requestedCount = parseRequestedCount(options);
    const originalRequestedCount = Number(options.originalRequestedCount || 0) || requestedCount;
    const minScore = minimumScoreFor(scoringOptions);
    const strictFilteredRequest = Boolean(yearRange || minScore);
    const sourcePoolLimit = strictFilteredRequest
      ? (deepRoonSearch
        ? Math.min(650, Math.max(requestedCount + 180, requestedCount * 55))
        : (requestedCount <= 5 ? 14 : Math.min(180, Math.max(requestedCount + 60, requestedCount * 12))))
      : (deepRoonSearch
        ? Math.min(650, Math.max(requestedCount + 160, requestedCount * 50))
        : (requestedCount <= 5 ? 12 : Math.min(120, Math.max(requestedCount + 35, requestedCount * 8))));
    const scoringPoolLimit = strictFilteredRequest
      ? (deepRoonSearch
        ? Math.min(120, Math.max(requestedCount + 60, requestedCount * 12))
        : (requestedCount <= 5 ? 10 : Math.min(110, Math.max(requestedCount + 45, requestedCount * 9))))
      : (deepRoonSearch
        ? Math.min(160, Math.max(requestedCount + 70, requestedCount * 18))
        : (requestedCount <= 5 ? 8 : Math.min(80, Math.max(requestedCount + 25, requestedCount * 6))));
    const minScoreLabel = minimumScoreLabel(minScore);
    const discarded = [...(roonResult.discarded || [])];
    const allowPreviousSuggestions = requestAllowsPreviousSuggestions(scoringOptions) ||
      /^(1|true|yes)$/i.test(String(options.allowPreviousRoonRescueFallback || ""));
    const sourcePool = mergeTrackLists(roonResult.tracks, roonResult.alternates)
      .slice(0, sourcePoolLimit);
    const freshPool = [];
    const previousPool = [];
    for (const track of sourcePool) {
      if (discoveryHistory.entryFor(track)) previousPool.push(track);
      else freshPool.push(track);
    }

    const poolForScoring = allowPreviousSuggestions
      ? [...freshPool, ...previousPool].slice(0, scoringPoolLimit)
      : freshPool.slice(0, scoringPoolLimit);
    if (!allowPreviousSuggestions && previousPool.length) {
      for (const track of previousPool.slice(0, Math.min(previousPool.length, 120))) {
        discarded.push({
          ...track,
          reason: "Previously suggested; held back for discovery variety."
        });
      }
    }
    const enrichment = await enrichRoonTracksOpportunistically(poolForScoring, {
      requestedCount,
      deep: deepRoonSearch,
      strict: strictFilteredRequest
    });
    const enriched = enrichment.tracks;
    const freshDecorated = [];
    const previousDecorated = [];
    const scoreFiltered = [];
    let previouslySuggestedHeldBack = allowPreviousSuggestions ? 0 : previousPool.length;
    const relaxedYearOptions = nearYearFallbackOptions(scoringOptions, yearRange);
    const relaxedYearProfile = relaxedYearOptions ? buildDiscoveryProfile(relaxedYearOptions) : null;
    let nearYearFallbackUsed = false;
    let roonYearUnverifiedFallbackUsed = 0;

    for (const track of enriched) {
      let candidateTrack = track;
      let scoringTrack = {
        ...track,
        ...(track.tidal || {}),
        query: track.query || track.roon?.sourceQuery || "",
        roon: track.roon
      };
      let scoringOptionsForTrack = scoringOptions;
      let profileForTrack = discoveryProfile;
      const historyEntry = discoveryHistory.entryFor(scoringTrack);
      let rejection = (yearRange || track.tidal?.tidalUrl) ? rejectReason(scoringTrack, scoringOptionsForTrack, profileForTrack) : "";

      if (rejection && relaxedYearOptions) {
        const relaxedTrack = {
          ...scoringTrack,
          discoveryLane: "recent",
          discoverySource: "Roon recent-year fallback"
        };
        const relaxedRejection = rejectReason(relaxedTrack, relaxedYearOptions, relaxedYearProfile);
        if (!relaxedRejection) {
          candidateTrack = {
            ...track,
            discoveryLane: "recent",
            discoverySource: "Roon recent-year fallback"
          };
          scoringTrack = relaxedTrack;
          scoringOptionsForTrack = relaxedYearOptions;
          profileForTrack = relaxedYearProfile;
          rejection = "";
          nearYearFallbackUsed = true;
        }
      }

      if (rejection && allowRoonYearUnverified && track.roon?.verified && /^(?:No TIDAL release|No canonical TIDAL)/i.test(rejection)) {
        const noYearOptions = { ...scoringOptions, years: "" };
        const noYearProfile = buildDiscoveryProfile(noYearOptions);
        const fallbackTrack = {
          ...scoringTrack,
          discoveryLane: "roon-rescue",
          discoverySource: "Roon-first rescue"
        };
        const sceneAnchor = roonRescueSceneAnchor(fallbackTrack);
        const fallbackRejection = rejectReason(fallbackTrack, noYearOptions, noYearProfile);
        if (!fallbackRejection || sceneAnchor) {
          candidateTrack = {
            ...track,
            discoveryLane: "roon-rescue",
            discoverySource: "Roon-first rescue",
            releaseDateUnverified: true,
            roonRescueSceneAnchor: sceneAnchor || ""
          };
          scoringTrack = fallbackTrack;
          scoringOptionsForTrack = noYearOptions;
          profileForTrack = noYearProfile;
          rejection = "";
          roonYearUnverifiedFallbackUsed += 1;
        }
      }

      if (rejection) {
        discarded.push({
          ...candidateTrack,
          reason: rejection
        });
        continue;
      }

      const artistNoveltyReason = previouslyRecommendedArtistReason(scoringTrack, discoveryHistory, profileForTrack, scoringOptionsForTrack);
      if (artistNoveltyReason) {
        discarded.push({
          ...candidateTrack,
          reason: artistNoveltyReason
        });
        continue;
      }

      const rawBreakdown = scoreBreakdownFor(scoringTrack, scoringOptionsForTrack, tasteProfile, profileForTrack);
      const scoreBreakdown = scoreWithRoonFloor(rawBreakdown, candidateTrack);
      let belowMinimumReason = "";
      if (minScore && scoreBreakdown.total < minScore) {
        belowMinimumReason = `Discovery score ${scoreBreakdown.total} is below minimum ${minScoreLabel}.`;
        const filtered = {
          ...candidateTrack,
          score: scoreBreakdown.total,
          scoreBreakdown,
          belowMinimum: true,
          minimumScore: minScore,
          minimumScoreLabel: minScoreLabel,
          reason: belowMinimumReason
        };
        const softRejectReason = belowMinimumSoftRejectReason(filtered, profileForTrack);
        if (softRejectReason) {
          scoreFiltered.push({
            ...filtered,
            reason: softRejectReason
          });
          discarded.push({
            ...filtered,
            reason: softRejectReason
          });
          continue;
        }
        scoreFiltered.push(filtered);
        candidateTrack = {
          ...candidateTrack,
          belowMinimum: true,
          minimumScore: minScore,
          minimumScoreLabel: minScoreLabel
        };
      }

      const candidate = {
        ...candidateTrack,
        reason: `${reasonFor(scoringTrack, scoringOptionsForTrack, scoreBreakdown, profileForTrack)}${belowMinimumReason ? `; below ${minScoreLabel} floor` : ""}`,
        why: whyBulletsFor(scoringTrack, scoringOptionsForTrack, scoreBreakdown, historyEntry, profileForTrack),
        discoverySource: candidateTrack.discoverySource || "Roon search",
        score: scoreBreakdown.total,
        scoreBreakdown,
        statusChecks: queueableStatusChecks({
          ...candidateTrack,
          statusChecks: discoveryStatusFor(scoringTrack, historyEntry, discoveryHistory.isRecent(scoringTrack))
        }).concat([
          belowMinimumReason,
          candidateTrack.roonRescueSceneAnchor ? `Roon scene anchor: ${candidateTrack.roonRescueSceneAnchor}` : "",
          candidateTrack.releaseDateUnverified ? "Release date not verified by TIDAL" : ""
        ].filter(Boolean)),
        verificationSource: candidateTrack.verificationSource || "roon"
      };
      candidate.feedback = tasteProfile.getFeedbackFor(candidate);
      if (historyEntry && !allowPreviousSuggestions) {
        previousDecorated.push(candidate);
        previouslySuggestedHeldBack += 1;
        discarded.push({
          ...candidate,
          reason: "Previously suggested; held back for discovery variety."
        });
      } else {
        freshDecorated.push(candidate);
      }
    }

    freshDecorated.sort(sortCandidates);
    previousDecorated.sort(sortCandidates);
    const candidateOrder = allowPreviousSuggestions
      ? mergeTrackLists(freshDecorated, previousDecorated)
      : freshDecorated;
    const diversity = diversifyCandidates(candidateOrder, requestedCount, scoringOptions);
    const selected = diversity.tracks;
    const alternates = allowPreviousSuggestions
      ? diversity.alternates
      : mergeTrackLists(diversity.alternates, previousDecorated);
    const belowMinimumKept = selected.filter((track) => track.belowMinimum).length;
    const belowMinimumAlternates = alternates.filter((track) => track.belowMinimum).length;
    const aboveMinimumKept = minScore ? Math.max(0, selected.length - belowMinimumKept) : selected.length;

    return {
      requestedCount,
      tracks: selected,
      alternates,
      discarded,
      verification: {
        ...(roonResult.verification || {}),
        requested: requestedCount,
        originalRequested: originalRequestedCount,
        countExpanded: requestedCount !== originalRequestedCount,
        kept: selected.length,
        discarded: discarded.length,
        minScore,
        minScoreLabel,
        yearRange: yearRange?.label || "",
        scoreFiltered: scoreFiltered.length,
        belowMinimumKept,
        belowMinimumAlternates,
        aboveMinimumKept,
        minScoreSoftFallback: Boolean(minScore && belowMinimumKept),
        strategy: "roon-search-first",
        nearYearFallback: nearYearFallbackUsed,
        nearYearFallbackRange: nearYearFallbackUsed ? relaxedYearOptions?.years || "" : "",
        verifiedReleaseRequired,
        roonYearUnverifiedFallback: Boolean(roonYearUnverifiedFallbackUsed),
        roonYearUnverifiedFallbackCount: roonYearUnverifiedFallbackUsed,
        tidalEnriched: [...freshDecorated, ...previousDecorated].filter((track) => track.tidal?.tidalUrl).length,
        novelty: !allowPreviousSuggestions,
        previouslySuggestedAllowed: allowPreviousSuggestions,
        previouslySuggestedHeldBack,
        freshRoonCandidates: freshPool.length,
        previousRoonCandidates: previousPool.length,
        deepRoonSearch,
        sourcePoolLimit,
        scoringPoolLimit,
        tidalEnrichment: enrichment.stats,
        diversity: {
          enabled: true,
          artistSpread: diversity.artistSpread,
          albumSpread: diversity.albumSpread,
          artistClusterAllowed: requestAllowsArtistCluster(scoringOptions)
        },
        intent: discoveryProfile.intent,
        scoringMode: discoveryProfile.scoringMode
      }
    };
  }

  function decorateRoonFirstTimeoutFallback(roonResult = {}, options = {}, error = null) {
    const yearRange = yearRangeUtil.parseYearRange(options);
    const scoringOptions = yearRange ? { ...options, years: yearRange.label } : options;
    const discoveryProfile = buildDiscoveryProfile(scoringOptions);
    const verifiedReleaseRequired = releaseFilterRequiresVerification(scoringOptions, yearRange);
    const allowRoonYearUnverified = !verifiedReleaseRequired &&
      /^(1|true|yes)$/i.test(String(options.allowRoonYearUnverifiedFallback || ""));
    const deepRoonSearch = /^(1|true|yes)$/i.test(String(options.deepRoonSearch || ""));
    const requestedCount = parseRequestedCount(options);
    const originalRequestedCount = Number(options.originalRequestedCount || 0) || requestedCount;
    const minScore = minimumScoreFor(scoringOptions);
    const minScoreLabel = minimumScoreLabel(minScore);
    const allowPreviousSuggestions = requestAllowsPreviousSuggestions(scoringOptions) ||
      /^(1|true|yes)$/i.test(String(options.allowPreviousRoonRescueFallback || ""));
    const sourcePoolLimit = deepRoonSearch
      ? Math.min(220, Math.max(requestedCount + 90, requestedCount * 16))
      : Math.min(120, Math.max(requestedCount + 40, requestedCount * 8));
    const sourcePool = mergeTrackLists(roonResult.tracks, roonResult.alternates)
      .slice(0, sourcePoolLimit);
    const discarded = [...(roonResult.discarded || [])];
    const candidates = [];
    const scoreFiltered = [];
    let previouslySuggestedHeldBack = 0;
    let roonYearUnverifiedFallbackUsed = 0;

    for (const track of sourcePool) {
      const historyEntry = discoveryHistory.entryFor(track);
      if (historyEntry && !allowPreviousSuggestions) {
        previouslySuggestedHeldBack += 1;
        discarded.push({
          ...track,
          reason: "Previously suggested; held back for discovery variety."
        });
        continue;
      }

      let candidateTrack = {
        ...track,
        discoveryLane: track.discoveryLane || "roon-rescue",
        discoverySource: track.discoverySource || "Roon-first rescue"
      };
      let scoringTrack = {
        ...candidateTrack,
        ...(candidateTrack.tidal || {}),
        query: candidateTrack.query || candidateTrack.roon?.sourceQuery || "",
        roon: candidateTrack.roon
      };
      let scoringOptionsForTrack = scoringOptions;
      let profileForTrack = discoveryProfile;
      let rejection = rejectReason(scoringTrack, scoringOptionsForTrack, profileForTrack);

      if (rejection && allowRoonYearUnverified && candidateTrack.roon?.verified && /^(?:No TIDAL release|No canonical TIDAL)/i.test(rejection)) {
        const noYearOptions = { ...scoringOptions, years: "" };
        const noYearProfile = buildDiscoveryProfile(noYearOptions);
        const fallbackTrack = {
          ...scoringTrack,
          discoveryLane: "roon-rescue",
          discoverySource: "Roon-first rescue"
        };
        const sceneAnchor = roonRescueSceneAnchor(fallbackTrack);
        const fallbackRejection = rejectReason(fallbackTrack, noYearOptions, noYearProfile);
        if (!fallbackRejection || sceneAnchor) {
          candidateTrack = {
            ...candidateTrack,
            discoveryLane: "roon-rescue",
            discoverySource: "Roon-first rescue",
            releaseDateUnverified: true,
            roonRescueSceneAnchor: sceneAnchor || ""
          };
          scoringTrack = fallbackTrack;
          scoringOptionsForTrack = noYearOptions;
          profileForTrack = noYearProfile;
          rejection = "";
          roonYearUnverifiedFallbackUsed += 1;
        }
      }

      if (rejection) {
        discarded.push({
          ...candidateTrack,
          reason: rejection
        });
        continue;
      }

      const artistNoveltyReason = previouslyRecommendedArtistReason(scoringTrack, discoveryHistory, profileForTrack, scoringOptionsForTrack);
      if (artistNoveltyReason) {
        discarded.push({
          ...candidateTrack,
          reason: artistNoveltyReason
        });
        continue;
      }

      const rawBreakdown = scoreBreakdownFor(scoringTrack, scoringOptionsForTrack, tasteProfile, profileForTrack);
      const scoreBreakdown = scoreWithRoonFloor(rawBreakdown, candidateTrack);
      let belowMinimumReason = "";
      if (minScore && scoreBreakdown.total < minScore) {
        belowMinimumReason = `Discovery score ${scoreBreakdown.total} is below minimum ${minScoreLabel}.`;
        const filtered = {
          ...candidateTrack,
          score: scoreBreakdown.total,
          scoreBreakdown,
          belowMinimum: true,
          minimumScore: minScore,
          minimumScoreLabel: minScoreLabel,
          reason: belowMinimumReason
        };
        const softRejectReason = belowMinimumSoftRejectReason(filtered, profileForTrack);
        if (softRejectReason) {
          scoreFiltered.push({
            ...filtered,
            reason: softRejectReason
          });
          discarded.push({
            ...filtered,
            reason: softRejectReason
          });
          continue;
        }
        scoreFiltered.push(filtered);
        candidateTrack = {
          ...candidateTrack,
          belowMinimum: true,
          minimumScore: minScore,
          minimumScoreLabel: minScoreLabel
        };
      }

      const candidate = {
        ...candidateTrack,
        reason: `${reasonFor(scoringTrack, scoringOptionsForTrack, scoreBreakdown, profileForTrack)}; returned from Roon partial scoring fallback${belowMinimumReason ? `; below ${minScoreLabel} floor` : ""}`,
        why: whyBulletsFor(scoringTrack, scoringOptionsForTrack, scoreBreakdown, historyEntry, profileForTrack),
        score: scoreBreakdown.total,
        scoreBreakdown,
        statusChecks: queueableStatusChecks({
          ...candidateTrack,
          statusChecks: discoveryStatusFor(scoringTrack, historyEntry, discoveryHistory.isRecent(scoringTrack))
        }).concat([
          "Roon partial scoring fallback",
          belowMinimumReason,
          candidateTrack.roonRescueSceneAnchor ? `Roon scene anchor: ${candidateTrack.roonRescueSceneAnchor}` : "",
          candidateTrack.releaseDateUnverified ? "Release date not verified by TIDAL" : ""
        ].filter(Boolean)),
        verificationSource: candidateTrack.verificationSource || "roon"
      };
      candidate.feedback = tasteProfile.getFeedbackFor(candidate);
      candidates.push(candidate);
    }

    const sorted = candidates.sort(sortCandidates);
    const diversity = diversifyCandidates(sorted, requestedCount, scoringOptions);
    const selected = diversity.tracks;
    const belowMinimumKept = selected.filter((track) => track.belowMinimum).length;
    const belowMinimumAlternates = diversity.alternates.filter((track) => track.belowMinimum).length;
    const aboveMinimumKept = minScore ? Math.max(0, selected.length - belowMinimumKept) : selected.length;

    return {
      requestedCount,
      tracks: selected,
      alternates: diversity.alternates,
      discarded,
      verification: {
        ...(roonResult.verification || {}),
        requested: requestedCount,
        originalRequested: originalRequestedCount,
        countExpanded: requestedCount !== originalRequestedCount,
        kept: selected.length,
        discarded: discarded.length,
        minScore,
        minScoreLabel,
        yearRange: yearRange?.label || "",
        scoreFiltered: scoreFiltered.length,
        belowMinimumKept,
        belowMinimumAlternates,
        aboveMinimumKept,
        minScoreSoftFallback: Boolean(minScore && belowMinimumKept),
        strategy: "roon-search-first",
        roonFirstScoringFallback: true,
        roonFirstScoringError: error?.message || "Roon-first scoring took too long.",
        roonFirstScoringPartial: true,
        roonFirstScoringSourcePool: sourcePool.length,
        roonFirstScoringCandidates: candidates.length,
        nearYearFallback: false,
        verifiedReleaseRequired,
        roonYearUnverifiedFallback: Boolean(roonYearUnverifiedFallbackUsed),
        roonYearUnverifiedFallbackCount: roonYearUnverifiedFallbackUsed,
        tidalEnriched: 0,
        novelty: !allowPreviousSuggestions,
        previouslySuggestedAllowed: allowPreviousSuggestions,
        previouslySuggestedHeldBack,
        freshRoonCandidates: Math.max(0, sourcePool.length - previouslySuggestedHeldBack),
        previousRoonCandidates: previouslySuggestedHeldBack,
        deepRoonSearch,
        sourcePoolLimit,
        scoringPoolLimit: 0,
        diversity: {
          enabled: true,
          artistSpread: diversity.artistSpread,
          albumSpread: diversity.albumSpread,
          artistClusterAllowed: requestAllowsArtistCluster(scoringOptions)
        },
        intent: discoveryProfile.intent,
        scoringMode: discoveryProfile.scoringMode
      }
    };
  }

  return {
    decorateRoonFirstResult,
    decorateRoonFirstTimeoutFallback
  };
}

module.exports = {
  createRoonFirstDecorator
};
