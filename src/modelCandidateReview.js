"use strict";
const { remixArtistOnlyPolicy } = require("./candidateReviewEvidence");

function createModelCandidateReviewer({
  candidateIdentityKeys,
  classifyModelReviewChange,
  config,
  createModelReviewAudit,
  mergeTrackLists,
  modelReviewAuditItem,
  normalizeMatchText,
  recordModelReviewAudit,
  scoreCandidateBatch,
  tasteProfile
} = {}) {
  function clampScore(value, min = 1, max = 100) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function llmScoreKey(track = {}) {
    const direct = track.tidal?.id || track.tidalId || track.id || track.trackId || track.tidal?.tidalUrl || track.tidalUrl;
    if (direct) return String(direct).trim();
    const keys = candidateIdentityKeys(track);
    return keys[0] || `${normalizeMatchText(track.artist)}|${normalizeMatchText(track.title)}`;
  }

  function scoreLabelForPercent(percent) {
    const score = Number(percent || 0);
    if (score >= 90) return "Excellent";
    if (score >= 80) return "Strong";
    if (score >= 70) return "Good";
    if (score >= 55) return "Loose";
    return "Weak";
  }

  function hardModelReject(score = {}, track = {}) {
    if (!score.rejected) return false;
    // Named remixes are not their original artist's usual production. Only
    // an explicitly artist-profile-only objection is advisory; unknown or
    // independent quality/version/request objections still fail closed.
    return !remixArtistOnlyPolicy(track, score);
  }

  function mergeWhy(existing = [], additions = []) {
    const seen = new Set();
    const merged = [];
    for (const item of [...additions, ...existing]) {
      const text = String(item || "").replace(/\s+/g, " ").trim();
      const key = normalizeMatchText(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      merged.push(text);
      if (merged.length >= 8) break;
    }
    return merged;
  }

  function applyModelReview(track = {}, score = {}) {
    if (!score || !score.trackId) return track;
    const remixPolicy = remixArtistOnlyPolicy(track, score);
    if (remixPolicy) {
      const existing = track.scoreBreakdown || {};
      const current = Number(track.score ?? existing.total);
      // Do not let scores derived from the same invalid artist veto re-enter
      // through genre confidence, prompt/taste percentages or the 22% blend.
      const adjusted = Number.isFinite(current) ? clampScore(current - remixPolicy.penalty) : track.score;
      const why = [remixPolicy.reason];
      const llmReview = {
        finalScore: score.finalScore,
        genreConfidence: score.scores?.genreConfidence,
        rejected: false,
        rejectionReason: "",
        rejectionBasis: score.rejectionBasis,
        reportedRejected: true,
        reportedRejectionReason: score.rejectionReason,
        policyAdjustment: remixPolicy
      };
      return {
        ...track,
        score: adjusted,
        scoreBreakdown: { ...existing, total: adjusted, llmReview, matchWhy: mergeWhy(existing.matchWhy || track.matchWhy || [], why) },
        matchWhy: mergeWhy(existing.matchWhy || track.matchWhy || [], why),
        why: mergeWhy(track.why || [], why),
        reason: track.reason ? `${track.reason}; named-remix model review` : "named-remix model review",
        llmReview
      };
    }
    const modelScores = score.scores || {};
    const existingBreakdown = track.scoreBreakdown || {};
    const promptPercent = clampScore(modelScores.promptMatch, 0, 100);
    const tastePercent = clampScore(modelScores.tasteMatch, 0, 100);
    const finalScore = clampScore(score.finalScore, 0, 100);
    const currentScore = Number(track.score || existingBreakdown.total || 0) || finalScore;
    const genreConfidence = clampScore(modelScores.genreConfidence, 0, 100);
    const scorePenalty = genreConfidence && genreConfidence < 50 ? 6 : 0;
    const blendedScore = clampScore((currentScore * 0.78) + (finalScore * 0.22) - scorePenalty);
    const modelWhy = mergeWhy(score.why || [], score.rejectionReason ? [`Model warning: ${score.rejectionReason}`] : []);
    const matchWhy = mergeWhy(existingBreakdown.matchWhy || track.matchWhy || [], modelWhy);
    const scoreBreakdown = {
      ...existingBreakdown,
      total: blendedScore,
      promptMatch: {
        ...(existingBreakdown.promptMatch || {}),
        percent: promptPercent,
        label: scoreLabelForPercent(promptPercent)
      },
      tasteMatch: {
        ...(existingBreakdown.tasteMatch || {}),
        percent: tastePercent,
        label: scoreLabelForPercent(tastePercent)
      },
      matchGenre: score.genre || existingBreakdown.matchGenre || track.matchGenre || "",
      matchWhy,
      llmReview: {
        finalScore,
        freshness: modelScores.freshness,
        artistLabelMatch: modelScores.artistLabelMatch,
        lengthPreference: modelScores.lengthPreference,
        genreConfidence,
        rejected: score.rejected,
        rejectionReason: score.rejectionReason,
        rejectionBasis: score.rejectionBasis
      }
    };
    return {
      ...track,
      score: blendedScore,
      scoreBreakdown,
      promptMatch: scoreBreakdown.promptMatch,
      tasteMatch: scoreBreakdown.tasteMatch,
      matchGenre: scoreBreakdown.matchGenre,
      matchWhy,
      why: mergeWhy(track.why || [], modelWhy),
      reason: track.reason ? `${track.reason}; model-reviewed` : "model-reviewed",
      llmReview: scoreBreakdown.llmReview
    };
  }

  async function applyModelCandidateReview(discovered = {}, options = {}) {
    const combined = mergeTrackLists(discovered.tracks, discovered.alternates).slice(0, 50);
    if (!combined.length) return {
      result: discovered,
      review: { enabled: false, scored: 0, rejected: 0, error: "No candidates to review." }
    };

    const review = await scoreCandidateBatch(config, {
      tracks: combined,
      options,
      tasteProfile: tasteProfile.read(),
      timeoutMs: Math.max(5_000, Math.min(60_000, Number(options.modelReviewTimeoutMs || 30_000)))
    });
    const scoreMap = new Map();
    for (const score of review.scores || []) {
      if (score.trackId) scoreMap.set(score.trackId, score);
    }

    let rejected = 0;
    let rejectedKept = 0;
    const audit = createModelReviewAudit();
    const discarded = [...(discovered.discarded || [])];
    const rejectedCandidates = [];
    const requestedCount = Math.max(0, Math.min(50, Number(
      discovered.verification?.requested ||
      discovered.requestedCount ||
      options.effectiveCount ||
      options.count ||
      0
    )));

    function hasSeenCandidate(track = {}, seen = new Set()) {
      const keys = candidateIdentityKeys(track);
      return keys.length && keys.some((key) => seen.has(key));
    }

    function markSeenCandidate(track = {}, seen = new Set()) {
      for (const key of candidateIdentityKeys(track)) seen.add(key);
    }

  function discardRejectedCandidate(record = {}) {
    rejected += 1;
    recordModelReviewAudit(audit, record.item, "rejected");
      discarded.push({
        ...record.track,
        llmReview: record.score,
      reason: `Model rejected candidate: ${record.score.rejectionReason || "low-confidence catalogue result"}`
    });
  }

  function annotatePoolDiagnosticsForModelRejects(discoveredResult = {}, records = []) {
    const poolDiagnostics = discoveredResult.verification?.poolDiagnostics;
    const durationCandidates = poolDiagnostics?.candidateAccumulation?.durationCandidates;
    if (!poolDiagnostics || !Array.isArray(durationCandidates) || !durationCandidates.length || !records.length) {
      return discoveredResult;
    }

    const rejectedByKey = new Map();
    for (const record of records) {
      const reason = `Model rejected candidate: ${record.score.rejectionReason || "low-confidence catalogue result"}`;
      for (const key of candidateIdentityKeys(record.track)) {
        rejectedByKey.set(key, { reason, score: record.beforeScore });
      }
    }

    const updatedDurationCandidates = durationCandidates.map((diagnostic) => {
      const rejection = rejectedByKey.get(String(diagnostic.key || "").trim().toLowerCase());
      if (!rejection) return diagnostic;
      return {
        ...diagnostic,
        scoreBeforeRejection: diagnostic.scoreBeforeRejection ?? rejection.score,
        candidateAccumulation: {
          status: "dropped",
          stage: "model-review",
          reason: rejection.reason
        },
        droppedStage: "model-review",
        droppedReason: rejection.reason
      };
    });

    return {
      ...discoveredResult,
      verification: {
        ...(discoveredResult.verification || {}),
        poolDiagnostics: {
          ...poolDiagnostics,
          candidateAccumulation: {
            ...(poolDiagnostics.candidateAccumulation || {}),
            durationCandidates: updatedDurationCandidates
          }
        }
      }
    };
  }

    function applyList(list = [], source = "track") {
      const next = [];
      for (const [index, track] of list.entries()) {
        const key = llmScoreKey(track);
        const score = scoreMap.get(key);
        if (!score) {
          next.push(track);
          continue;
        }
        const beforeScore = Number(track.score || track.scoreBreakdown?.total || 0) || Number(score.finalScore || 0) || 0;
        if (hardModelReject(score, track)) {
          const item = modelReviewAuditItem(track, score, beforeScore, null, "rejected");
          rejectedCandidates.push({ track, score, beforeScore, item, source, index });
          continue;
        }
        const reviewedTrack = applyModelReview(track, score);
        const afterScore = Number(reviewedTrack.score || reviewedTrack.scoreBreakdown?.total || 0) || beforeScore;
        const type = classifyModelReviewChange(score, beforeScore, afterScore, false);
        const policy = reviewedTrack.llmReview?.policyAdjustment;
        const auditScore = policy ? { ...score, rejectionReason: policy.reason } : score;
        const item = modelReviewAuditItem(reviewedTrack, auditScore, beforeScore, afterScore, type);
        recordModelReviewAudit(audit, item, type);
        next.push({
          ...reviewedTrack,
          modelReview: {
            action: type,
            before: item.before,
            after: item.after,
            delta: item.delta,
            modelScore: item.modelScore,
            genreConfidence: item.genreConfidence,
            reason: item.reason
          }
        });
      }
      return next;
    }

    const reviewedTracks = applyList(discovered.tracks, "track");
    const reviewedAlternates = applyList(discovered.alternates, "alternate");
    const selectedKeys = new Set();
    for (const track of reviewedTracks) markSeenCandidate(track, selectedKeys);

    const remainingAlternates = [];
    for (const alternate of reviewedAlternates) {
      if (requestedCount && reviewedTracks.length < requestedCount && !hasSeenCandidate(alternate, selectedKeys)) {
        reviewedTracks.push({
          ...alternate,
          modelReviewBackfill: true,
          statusChecks: Array.from(new Set([
            ...(Array.isArray(alternate.statusChecks) ? alternate.statusChecks : []),
            "Backfilled after model review"
          ]))
        });
        markSeenCandidate(alternate, selectedKeys);
      } else {
        remainingAlternates.push(alternate);
      }
    }

    for (const record of rejectedCandidates) {
      discardRejectedCandidate(record);
    }

    const diagnosticResult = annotatePoolDiagnosticsForModelRejects(discovered, rejectedCandidates);

    return {
      result: {
        ...diagnosticResult,
        tracks: reviewedTracks,
        alternates: remainingAlternates,
        discarded
      },
      review: {
        enabled: true,
        scored: scoreMap.size,
        rejected,
        rejectedKept,
        rawCount: review.rawCount || 0,
        audit,
        error: ""
      }
    };
  }

  return {
    applyModelCandidateReview,
    applyModelReview,
    clampScore,
    hardModelReject,
    llmScoreKey,
    mergeWhy,
    scoreLabelForPercent
  };
}

module.exports = {
  createModelCandidateReviewer
};
