"use strict";

function createDiscoveryResultVerification({
  candidateIdentityKeys,
  mergeTrackLists,
  normalizeMatchText
} = {}) {
  function queueableStatusChecks(track = {}) {
    const checks = Array.isArray(track.statusChecks) ? track.statusChecks : [];
    const artistCreditStatus = track.roon?.artistCreditConfirmed
      ? `Exact artist credit confirmed: ${track.roon.artistCreditConfirmed}`
      : (track.roon?.verified ? "Broader Roon search match" : "");
    return Array.from(new Set([
      "Roon verified",
      track.roon?.queueActionPresumed ? "Queue action resolved when queued" : "Roon queue action ready",
      artistCreditStatus,
      ...checks.filter((status) => (
        !/^Roon\b/i.test(String(status || "")) &&
        !/^Exact artist credit/i.test(String(status || "")) &&
        !/^Broader Roon search match/i.test(String(status || ""))
      ))
    ].filter(Boolean)));
  }

  function roonVerificationTimeoutFallback(discovered = {}, requestedCount = 8, error = null) {
    const fallbackTracks = mergeTrackLists(discovered.tracks, discovered.alternates)
      .slice(0, Math.max(1, requestedCount))
      .map((track) => ({
        ...track,
        roon: {
          ...(track.roon || {}),
          verified: false
        },
        statusChecks: [
          "Roon verification timed out",
          "Queue action will be checked when queued",
          ...(Array.isArray(track.statusChecks) ? track.statusChecks.filter((status) => !/^Roon\b/i.test(String(status || ""))) : [])
        ]
      }));
    const discarded = discovered.discarded || [];
    return {
      ...discovered,
      tracks: fallbackTracks,
      alternates: mergeTrackLists(discovered.tracks, discovered.alternates)
        .filter((track) => !fallbackTracks.some((fallback) => candidateIdentityKeys(fallback).some((key) => candidateIdentityKeys(track).includes(key))))
        .slice(0, Math.max(80, requestedCount * 8)),
      discarded,
      verification: {
        ...(discovered.verification || {}),
        roonQueueable: false,
        roonStrict: true,
        roonVerificationError: error?.message || "Roon queue verification took too long.",
        roonVerificationFallback: true,
        kept: fallbackTracks.length,
        generated: fallbackTracks.length + discarded.length,
        discarded: discarded.length
      }
    };
  }

  function roonMatchSummary(match = null) {
    if (!match) return null;
    return {
      title: match.title || "",
      subtitle: match.subtitle || "",
      imageKey: match.image_key || "",
      key: match.item_key || "",
      hint: match.hint || ""
    };
  }

  function shouldRunRoonFirstRescue(result = {}) {
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    if (tracks.length) return false;
    const verification = result.verification || {};
    if (verification.roonFirstRescue?.attempted) return false;
    return Boolean(
      verification.discoveryError ||
      verification.roonRejected ||
      verification.queryYield?.errorCount ||
      verification.autoBroaden?.attempted ||
      (Array.isArray(result.discarded) && result.discarded.length)
    );
  }

  function tidalPlaylistBridgeResult(result = {}, requestedCount = 8) {
    const tracks = mergeTrackLists(result.tracks || [], result.alternates || []);
    const discarded = result.discarded || [];
    const sourceStrategy = String(result.verification?.strategy || "");
    const strategy = /roon-verified/i.test(sourceStrategy)
      ? "tidal-catalog-playlist-bridge"
      : (sourceStrategy || "tidal-catalog-playlist-bridge");
    return {
      ...result,
      tracks,
      alternates: [],
      verification: {
        ...(result.verification || {}),
        strategy,
        roonQueueable: false,
        roonStrict: false,
        queueBridge: "tidal-playlist",
        queueBridgeReason: "Strict Roon verification skipped; use Send to TIDAL to create a playable TIDAL playlist.",
        queueBridgeReady: tracks.some((track) => track?.tidal?.id || track?.tidalId || track?.tidal?.tidalUrl || track?.tidalUrl),
        requested: Number(result.verification?.requested || result.requestedCount || requestedCount),
        kept: tracks.length,
        generated: Number(result.verification?.generated || (tracks.length + discarded.length)),
        discarded: Number(result.verification?.discarded || discarded.length)
      }
    };
  }

  function compactDiagnosticText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function upsertDiagnosticBucket(buckets = [], label = "", count = 0, examples = []) {
    const safeLabel = compactDiagnosticText(label) || "Other discarded";
    const safeCount = Math.max(0, Number(count || 0));
    if (!safeCount) return Array.isArray(buckets) ? buckets : [];

    const next = Array.isArray(buckets) ? buckets.map((bucket) => ({ ...bucket })) : [];
    const key = normalizeMatchText(safeLabel);
    const index = next.findIndex((bucket) => normalizeMatchText(bucket.label) === key);
    const normalizedExamples = (examples || [])
      .map((item) => ({
        label: compactDiagnosticText(item.label || [item.artist, item.title].filter(Boolean).join(" - ")) || "Unknown candidate",
        reason: compactDiagnosticText(item.reason || "No reason provided")
      }))
      .filter((item) => item.label || item.reason)
      .slice(0, 3);

    if (index >= 0) {
      const existing = next[index];
      next[index] = {
        ...existing,
        count: Number(existing.count || 0) + safeCount,
        examples: [...(Array.isArray(existing.examples) ? existing.examples : []), ...normalizedExamples].slice(0, 3)
      };
    } else {
      next.push({
        label: safeLabel,
        count: safeCount,
        examples: normalizedExamples
      });
    }

    return next
      .sort((left, right) => Number(right.count || 0) - Number(left.count || 0) || String(left.label || "").localeCompare(String(right.label || "")))
      .slice(0, 8);
  }

  function syncFinalResultVerification(result = {}, requestedCount = 0) {
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    const alternates = Array.isArray(result.alternates) ? result.alternates : [];
    const discarded = Array.isArray(result.discarded) ? result.discarded : [];
    const verification = result.verification || {};
    const requested = Number(verification.requested || result.requestedCount || requestedCount || tracks.length || 0);
    const minScore = Number(verification.minScore || 0);
    const generated = Math.max(
      Number(verification.generated || 0),
      tracks.length + alternates.length + discarded.length
    );
    const belowMinimumKept = tracks.filter((track) => track.belowMinimum).length;
    const belowMinimumAlternates = alternates.filter((track) => track.belowMinimum).length;
    const aboveMinimumKept = minScore ? Math.max(0, tracks.length - belowMinimumKept) : tracks.length;
    const review = verification.modelCandidateReview || {};
    const audit = review.audit || {};
    const rejected = Number(review.rejected || 0);
    const rejectedKept = Number(review.rejectedKept || 0);
    let poolDiagnostics = verification.poolDiagnostics;

    if (poolDiagnostics && typeof poolDiagnostics === "object") {
      const notes = Array.isArray(poolDiagnostics.notes) ? [...poolDiagnostics.notes] : [];
      const autoBroaden = verification.autoBroaden || {};
      if (rejected) notes.push(`${rejected} candidate${rejected === 1 ? "" : "s"} removed by model review after initial pool scoring.`);
      if (rejectedKept) notes.push(`${rejectedKept} model-flagged candidate${rejectedKept === 1 ? "" : "s"} kept because the run would otherwise undershoot the requested count.`);
      if (autoBroaden.initialTimeoutRetry) notes.push("Initial discovery timed out; Rabbit Hole ran one guarded adaptive retry instead of requiring a second Generate press.");
      if (autoBroaden.attempted) {
        const lanes = (autoBroaden.lanes || [])
          .map((lane) => lane.label || lane.lane)
          .filter(Boolean)
          .slice(0, 4)
          .join(", ");
        notes.push(`Adaptive retry ran ${autoBroaden.attempted} pass${autoBroaden.attempted === 1 ? "" : "es"}${lanes ? `: ${lanes}` : ""}; ${autoBroaden.added || 0} candidate${autoBroaden.added === 1 ? "" : "s"} added.`);
      } else if (Array.isArray(autoBroaden.planned) && autoBroaden.planned.length) {
        notes.push(`Adaptive retry plan was ready (${autoBroaden.planned.map((pass) => pass.label || pass.lane).filter(Boolean).slice(0, 3).join(", ")}) but the initial pool was sufficient.`);
      }

      poolDiagnostics = {
        ...poolDiagnostics,
        requested,
        generated,
        kept: tracks.length,
        alternates: alternates.length,
        discarded: discarded.length,
        retainedPool: tracks.length + alternates.length,
        buckets: rejected
          ? upsertDiagnosticBucket(poolDiagnostics.buckets, "Model rejected", rejected, audit.rejected || [])
          : (Array.isArray(poolDiagnostics.buckets) ? poolDiagnostics.buckets : []),
        notes: Array.from(new Set(notes.filter(Boolean)))
      };
    }

    return {
      ...result,
      tracks,
      alternates,
      discarded,
      verification: {
        ...verification,
        requested,
        generated,
        kept: tracks.length,
        discarded: discarded.length,
        belowMinimumKept,
        belowMinimumAlternates,
        aboveMinimumKept,
        minScoreSoftFallback: Boolean(minScore && belowMinimumKept),
        ...(poolDiagnostics ? { poolDiagnostics } : {})
      }
    };
  }

  return {
    compactDiagnosticText,
    queueableStatusChecks,
    roonMatchSummary,
    roonVerificationTimeoutFallback,
    shouldRunRoonFirstRescue,
    syncFinalResultVerification,
    tidalPlaylistBridgeResult,
    upsertDiagnosticBucket
  };
}

module.exports = {
  createDiscoveryResultVerification
};
