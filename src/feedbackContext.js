"use strict";

function cleanRadioText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isRadioPlaybackTrack(track = {}) {
  const text = [
    track.sourceType,
    track.discoverySource,
    track.tidal?.source,
    track.playbackSource?.sourceName
  ].filter(Boolean).join(" ");
  return Boolean(track.isLiveRadio || track.isRadio || track.radio || /\bradio\b/i.test(text));
}

function sessionTrackFor(track = {}, { sessionStore, trackKey } = {}) {
  const key = trackKey?.(track);
  if (!key) return null;
  const session = sessionStore?.read?.() || {};
  const pools = [
    ...(session.result?.tracks || []),
    ...(session.result?.alternates || []),
    ...(session.result?.discarded || [])
  ];
  return pools.find((candidate) => trackKey(candidate) === key) || null;
}

function feedbackTrackWithSessionContext(track = {}, rating = "", { sessionStore, trackKey, ratingDelta } = {}) {
  const sessionTrack = sessionTrackFor(track, { sessionStore, trackKey }) || {};
  const merged = {
    ...sessionTrack,
    ...track,
    scoreBreakdown: track.scoreBreakdown || sessionTrack.scoreBreakdown || null,
    llmReview: track.llmReview || sessionTrack.llmReview || null,
    modelReview: track.modelReview || sessionTrack.modelReview || null,
    discoverySource: track.discoverySource || sessionTrack.discoverySource || "",
    discoveryLane: track.discoveryLane || sessionTrack.discoveryLane || "",
    tasteScore: ratingDelta?.(rating)
  };
  if (!isRadioPlaybackTrack(merged)) return merged;

  const source = cleanRadioText(merged.discoverySource);
  const lane = cleanRadioText(merged.discoveryLane);
  const statusChecks = Array.isArray(merged.statusChecks) ? merged.statusChecks : [];
  return {
    ...merged,
    sourceType: "radio",
    isRadio: true,
    isLiveRadio: merged.isLiveRadio !== false,
    discoverySource: !source || /^now playing$/i.test(source) ? "Live radio" : source,
    discoveryLane: lane || "radio",
    statusChecks: Array.from(new Set([...statusChecks, "Live radio feedback"]))
  };
}

function feedbackCalibrationContext(track = {}, request = {}) {
  const modelReview = track.modelReview || {};
  const llmReview = track.scoreBreakdown?.llmReview || track.llmReview || {};
  return {
    modelReview,
    modelAction: modelReview.action || "",
    beforeScore: modelReview.before,
    afterScore: modelReview.after,
    delta: modelReview.delta,
    score: track.score ?? track.scoreBreakdown?.total,
    modelScore: modelReview.modelScore ?? llmReview.finalScore,
    genreConfidence: modelReview.genreConfidence ?? llmReview.genreConfidence,
    promptMatch: track.promptMatch ?? track.scoreBreakdown?.promptMatch,
    tasteMatch: track.tasteMatch ?? track.scoreBreakdown?.tasteMatch,
    reason: request.reason || modelReview.reason || llmReview.rejectionReason || "",
    discoverySource: track.discoverySource || "",
    discoveryLane: track.discoveryLane || ""
  };
}

module.exports = {
  feedbackCalibrationContext,
  feedbackTrackWithSessionContext,
  isRadioPlaybackTrack,
  sessionTrackFor
};
