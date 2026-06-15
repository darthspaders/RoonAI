"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function trackLabel(track = {}) {
  const title = cleanText(track.title || track.name);
  const artist = cleanText(track.artist);
  if (title && artist) return `${title} - ${artist}`;
  return title || artist || "Unknown track";
}

function modelReviewReason(score = {}) {
  const why = Array.isArray(score.why) ? score.why.map(cleanText).filter(Boolean) : [];
  return cleanText(score.rejectionReason) || why[0] || "Model score adjustment";
}

function createModelReviewAudit() {
  return {
    boostedCount: 0,
    downrankedCount: 0,
    rejectedCount: 0,
    warningCount: 0,
    unchangedCount: 0,
    boosted: [],
    downranked: [],
    rejected: [],
    warnings: []
  };
}

function modelReviewAuditItem(track = {}, score = {}, beforeScore = 0, afterScore = null, action = "kept") {
  const before = clampScore(beforeScore);
  const after = afterScore === null ? null : clampScore(afterScore);
  return {
    trackId: cleanText(score.trackId),
    label: trackLabel(track),
    artist: cleanText(track.artist),
    title: cleanText(track.title || track.name),
    action,
    before,
    after,
    delta: after === null ? null : after - before,
    modelScore: clampScore(score.finalScore),
    genreConfidence: clampScore(score.scores?.genreConfidence),
    reason: modelReviewReason(score)
  };
}

function pushLimited(list, item, limit = 8) {
  if (list.length < limit) list.push(item);
}

function recordModelReviewAudit(audit = createModelReviewAudit(), item = {}, type = "unchanged", limit = 8) {
  if (type === "boosted") {
    audit.boostedCount += 1;
    pushLimited(audit.boosted, item, limit);
  } else if (type === "downranked") {
    audit.downrankedCount += 1;
    pushLimited(audit.downranked, item, limit);
  } else if (type === "rejected") {
    audit.rejectedCount += 1;
    pushLimited(audit.rejected, item, limit);
  } else if (type === "warning") {
    audit.warningCount += 1;
    pushLimited(audit.warnings, item, limit);
  } else {
    audit.unchangedCount += 1;
  }
  return audit;
}

function classifyModelReviewChange(score = {}, beforeScore = 0, afterScore = 0, hardRejected = false) {
  if (hardRejected) return "rejected";
  if (score.rejected) return "warning";
  const delta = clampScore(afterScore) - clampScore(beforeScore);
  if (delta >= 3) return "boosted";
  if (delta <= -3) return "downranked";
  return "unchanged";
}

module.exports = {
  createModelReviewAudit,
  classifyModelReviewChange,
  modelReviewAuditItem,
  recordModelReviewAudit
};
