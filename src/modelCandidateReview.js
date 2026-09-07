"use strict";

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

  function hardModelReject(score = {}) {
    if (!score.rejected) return false;
    const reason = normalizeMatchText(score.rejectionReason);
    if (!reason) return false;
    if (Number(score.finalScore || 0) >= 65 && Number(score.scores?.genreConfidence || 0) >= 55) return false;
    return /\b(?:playlist|compilation|seo|chart|karaoke|cover|tribute|live|remaster|reissue|anniversary|deluxe|archive|background|catalogue|filler|spam)\b/.test(reason);
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
        rejectionReason: score.rejectionReason
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

    function keepRejectedCandidate(record = {}) {
      const reviewedTrack = applyModelReview(record.track, record.score);
      const afterScore = Number(reviewedTrack.score || reviewedTrack.scoreBreakdown?.total || 0) || record.beforeScore;
      const item = modelReviewAuditItem(reviewedTrack, record.score, record.beforeScore, afterScore, "warning");
      recordModelReviewAudit(audit, item, "warning");
      rejectedKept += 1;
      return {
        ...reviewedTrack,
        modelRejectedKept: true,
        reason: `${reviewedTrack.reason || record.track.reason || "Model-reviewed candidate"}; model flagged candidate but it was kept because review would undershoot the requested count`,
        statusChecks: Array.from(new Set([
          ...(Array.isArray(reviewedTrack.statusChecks) ? reviewedTrack.statusChecks : []),
          `Model warning: ${item.reason}`,
          "Kept to satisfy requested count after model review"
        ])),
        modelReview: {
          action: "warning",
          before: item.before,
          after: item.after,
          delta: item.delta,
          modelScore: item.modelScore,
          genreConfidence: item.genreConfidence,
          reason: item.reason,
          keptAfterReject: true
        }
      };
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
        if (hardModelReject(score)) {
          const item = modelReviewAuditItem(track, score, beforeScore, null, "rejected");
          rejectedCandidates.push({ track, score, beforeScore, item, source, index });
          continue;
        }
        const reviewedTrack = applyModelReview(track, score);
        const afterScore = Number(reviewedTrack.score || reviewedTrack.scoreBreakdown?.total || 0) || beforeScore;
        const type = classifyModelReviewChange(score, beforeScore, afterScore, false);
        const item = modelReviewAuditItem(reviewedTrack, score, beforeScore, afterScore, type);
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

    const rescuedRejectIds = new Set();
    for (const record of rejectedCandidates.filter((item) => item.source === "track")) {
      if (!requestedCount || reviewedTracks.length >= requestedCount) break;
      if (hasSeenCandidate(record.track, selectedKeys)) continue;
      const rescued = keepRejectedCandidate(record);
      reviewedTracks.push(rescued);
      markSeenCandidate(rescued, selectedKeys);
      rescuedRejectIds.add(`${record.source}:${record.index}`);
    }

    for (const record of rejectedCandidates) {
      const id = `${record.source}:${record.index}`;
      if (!rescuedRejectIds.has(id)) discardRejectedCandidate(record);
    }

    return {
      result: {
        ...discovered,
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
