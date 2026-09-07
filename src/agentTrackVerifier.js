"use strict";

const { extractTidalTrackId } = require("./currentTrackQuality");
const { normalizeMatchText, tidalPlaylistFallbackMatches } = require("./tidalMatchRules");
const { compactVerifiedTrack, verificationTrackFromInput } = require("./tidalTrackResolution");

function compactDiscoveryHistoryEntry(entry = null) {
  if (!entry) return null;
  return {
    firstShownAt: entry.firstShownAt || "",
    lastShownAt: entry.lastShownAt || "",
    shownCount: Number(entry.shownCount || 0),
    discoverySource: entry.discoverySource || "",
    discoveryLane: entry.discoveryLane || "",
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null
  };
}

function compactTrackMemoryEntry(entry = null) {
  if (!entry) return null;
  return {
    firstSeenAt: entry.firstSeenAt || "",
    lastSeenAt: entry.lastSeenAt || "",
    seenCount: Number(entry.seenCount || 0),
    feedback: entry.feedback || "",
    score: Number.isFinite(Number(entry.score || entry.tasteScore)) ? Number(entry.score || entry.tasteScore) : null
  };
}

function minDurationMsFromVerificationBody(body = {}) {
  const direct = Number(body.minDurationMs || body.minimumDurationMs || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const seconds = Number(body.minDurationSeconds || body.minimumDurationSeconds || 0);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const minutes = Number(body.minDurationMinutes || body.minimumDurationMinutes || 0);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  return 0;
}

function verificationIdentityKey(track = {}, trackKey = () => "") {
  return trackKey(track) || [
    normalizeMatchText(track.artist || track.tidal?.artist),
    normalizeMatchText(track.title || track.tidal?.title)
  ].filter(Boolean).join("|");
}

function negativeFeedback(feedback = "") {
  return /^(?:wrong_genre|skip|never|reject_similar|dislike)$/i.test(String(feedback || "").trim());
}

function verificationVerdict({
  valid,
  duplicateOf,
  tidalResult,
  roonResult,
  historyEntry,
  memoryEntry,
  allowKnown,
  minDurationMs,
  durationMs
}) {
  if (!valid) return "invalid";
  if (Number.isInteger(duplicateOf)) return "duplicate_input";
  if (tidalResult.error) return "tidal_error";
  if (tidalResult.configured && tidalResult.checked && !tidalResult.verified) return "not_found_in_tidal";
  if (minDurationMs && !durationMs) return "duration_unknown";
  if (minDurationMs && durationMs < minDurationMs) return "duration_too_short";
  if (roonResult.checked && roonResult.queueable === false) return "not_queueable_in_roon";
  if (!allowKnown && historyEntry) return "previously_suggested";
  if (!allowKnown && memoryEntry && negativeFeedback(memoryEntry.feedback)) return "known_reject";
  if (!allowKnown && memoryEntry) return "previously_seen";
  return tidalResult.verified || roonResult.queueable ? "verified" : "unverified";
}

function createAgentTrackVerifier({
  tidal,
  roon,
  discoveryHistory,
  trackMemory,
  trackKey,
  findExactTidalCatalogueTrack,
  withTimeout,
  roonMatchSummary,
  booleanFlag,
  playlistVerifyTimeoutMs
} = {}) {
  async function verifyTrackCandidate(candidate, context = {}) {
    const valid = Boolean(
      (candidate.artist && candidate.title) ||
      extractTidalTrackId(candidate)
    );
    const reasons = [];
    const tidalResult = {
      configured: tidal.isConfigured(),
      checked: false,
      verified: false,
      resolvedBy: "",
      match: null,
      error: ""
    };
    let verified = null;

    if (!valid) {
      reasons.push("Track needs artist/title or a TIDAL track URL/id.");
    } else if (!tidalResult.configured) {
      reasons.push("TIDAL catalogue verification is not configured.");
    } else {
      tidalResult.checked = true;
      try {
        const tidalId = extractTidalTrackId(candidate);
        if (tidalId) {
          verified = await withTimeout(
            tidal.getTrack(tidalId, `${candidate.artist || ""} ${candidate.title || ""}`.trim()),
            context.perTrackTimeoutMs,
            "TIDAL track-id verification took too long."
          );
          tidalResult.resolvedBy = "tidal-id";
          if (candidate.artist && candidate.title && !tidalPlaylistFallbackMatches(candidate, verified)) {
            reasons.push(`TIDAL id resolved to ${verified?.artist || "unknown artist"} - ${verified?.title || "unknown title"}, which does not match the requested track.`);
            verified = null;
          }
        } else {
          verified = await findExactTidalCatalogueTrack(candidate, {
            timeoutMs: context.perTrackTimeoutMs,
            limit: context.limit,
            maxQueries: context.maxQueries,
            message: "TIDAL exact candidate verification took too long."
          });
          tidalResult.resolvedBy = "tidal-exact";
        }
        tidalResult.verified = Boolean(verified);
        tidalResult.match = verified ? compactVerifiedTrack(verified) : null;
        if (!verified) reasons.push("No exact TIDAL catalogue match.");
      } catch (error) {
        tidalResult.error = error.message || "TIDAL verification failed.";
        reasons.push(tidalResult.error);
      }
    }

    const identityTrack = verified ? {
      ...candidate,
      ...verified,
      tidal: verified,
      tidalUrl: verified.tidalUrl || candidate.tidalUrl || ""
    } : candidate;
    const historyEntry = discoveryHistory.entryFor(identityTrack);
    const memoryEntry = trackMemory.find(identityTrack);
    const durationMs = Number(identityTrack.durationMs || verified?.durationMs || 0) || null;
    if (context.minDurationMs && !durationMs) {
      reasons.push(`No duration available to confirm at least ${Math.round(context.minDurationMs / 60000)} minutes.`);
    } else if (context.minDurationMs && durationMs < context.minDurationMs) {
      reasons.push(`Duration ${Math.round(durationMs / 1000)}s is below requested minimum ${Math.round(context.minDurationMs / 1000)}s.`);
    }

    const roonResult = {
      checked: false,
      queueable: null,
      action: "",
      match: null,
      reason: "",
      error: ""
    };
    if (context.checkRoon && valid) {
      if (!context.zoneId) {
        roonResult.reason = "No Roon zone was supplied for queueability verification.";
        reasons.push(roonResult.reason);
      } else {
        roonResult.checked = true;
        try {
          const queueCheck = await withTimeout(
            roon.canQueueTrack(identityTrack, context.zoneId, {
              preferExtendedMixes: context.preferExtendedMixes
            }),
            context.roonTimeoutMs,
            "Roon queueability verification took too long."
          );
          roonResult.queueable = Boolean(queueCheck.success);
          roonResult.action = queueCheck.action || "";
          roonResult.match = roonMatchSummary(queueCheck.match);
          roonResult.reason = queueCheck.reason || "";
          if (!roonResult.queueable) reasons.push(roonResult.reason || "Roon did not expose a usable queue action.");
        } catch (error) {
          roonResult.queueable = false;
          roonResult.error = error.message || "Roon queueability verification failed.";
          reasons.push(roonResult.error);
        }
      }
    }

    const verdict = verificationVerdict({
      valid,
      duplicateOf: context.duplicateOf,
      tidalResult,
      roonResult,
      historyEntry,
      memoryEntry,
      allowKnown: context.allowKnown,
      minDurationMs: context.minDurationMs,
      durationMs
    });
    const usable = verdict === "verified";
    return {
      index: context.index,
      input: compactVerifiedTrack(candidate),
      usable,
      verdict,
      reasons: Array.from(new Set(reasons.filter(Boolean))).slice(0, 8),
      duplicateOf: Number.isInteger(context.duplicateOf) ? context.duplicateOf : null,
      tidal: tidalResult,
      roon: roonResult,
      history: {
        previouslySuggested: Boolean(historyEntry),
        recent: Boolean(historyEntry && discoveryHistory.isRecent(identityTrack)),
        entry: compactDiscoveryHistoryEntry(historyEntry)
      },
      memory: {
        known: Boolean(memoryEntry),
        negativeFeedback: Boolean(memoryEntry && negativeFeedback(memoryEntry.feedback)),
        entry: compactTrackMemoryEntry(memoryEntry)
      },
      track: compactVerifiedTrack(identityTrack)
    };
  }

  async function verifyTracksForAgent(body = {}) {
    const rawTracks = Array.isArray(body.tracks)
      ? body.tracks
      : (Array.isArray(body.candidates) ? body.candidates : []);
    const max = Math.max(1, Math.min(40, Number(body.max || body.limit || rawTracks.length || 40)));
    const tracks = rawTracks.slice(0, max).map(verificationTrackFromInput);
    if (!tracks.length) {
      const error = new Error("Provide at least one track to verify.");
      error.statusCode = 400;
      throw error;
    }

    const startedAt = Date.now();
    const checkRoon = booleanFlag(body.checkRoon || body.requireRoonQueueable || body.roonQueueable);
    const contextBase = {
      allowKnown: booleanFlag(body.allowKnown || body.allowRepeats || body.allowPreviouslySuggested),
      checkRoon,
      zoneId: String(body.zoneId || body.zone_id || "").trim(),
      preferExtendedMixes: booleanFlag(body.preferExtendedMixes || body.prefer_extended_mixes),
      strict: booleanFlag(body.strict),
      minDurationMs: minDurationMsFromVerificationBody(body),
      perTrackTimeoutMs: Math.max(5_000, Math.min(30_000, Number(body.perTrackTimeoutMs || body.timeoutMs || playlistVerifyTimeoutMs))),
      roonTimeoutMs: Math.max(5_000, Math.min(30_000, Number(body.roonTimeoutMs || body.timeoutMs || 12_000))),
      limit: Math.max(1, Math.min(8, Number(body.searchLimit || 5))),
      maxQueries: Math.max(1, Math.min(8, Number(body.maxQueries || 4)))
    };
    const seen = new Map();
    const results = [];

    for (const [index, track] of tracks.entries()) {
      const key = verificationIdentityKey(track, trackKey);
      const duplicateOf = key && seen.has(key) ? seen.get(key) : null;
      if (key && !seen.has(key)) seen.set(key, index);
      results.push(await verifyTrackCandidate(track, {
        ...contextBase,
        index,
        duplicateOf
      }));
    }

    const usable = results.filter((result) => result.usable);
    const rejected = results.filter((result) => !result.usable);
    return {
      requestedCount: rawTracks.length,
      checkedCount: results.length,
      usableCount: usable.length,
      verifiedCount: results.filter((result) => result.tidal.verified || result.roon.queueable).length,
      rejectedCount: rejected.length,
      truncated: rawTracks.length > tracks.length,
      options: {
        checkRoon,
        zoneId: contextBase.zoneId,
        allowKnown: contextBase.allowKnown,
        minDurationMs: contextBase.minDurationMs,
        preferExtendedMixes: contextBase.preferExtendedMixes
      },
      tracks: results,
      usable: usable.map((result) => result.track),
      rejected: rejected.map((result) => ({
        index: result.index,
        track: result.track,
        verdict: result.verdict,
        reasons: result.reasons
      })),
      latencyMs: Date.now() - startedAt
    };
  }

  return {
    verifyTrackCandidate,
    verifyTracksForAgent
  };
}

module.exports = {
  compactDiscoveryHistoryEntry,
  compactTrackMemoryEntry,
  createAgentTrackVerifier,
  minDurationMsFromVerificationBody,
  negativeFeedback,
  verificationIdentityKey,
  verificationVerdict
};
