"use strict";

function recordFeedbackAcrossStores({
  rating = "",
  track = {},
  calibrationContext = {},
  tasteProfile,
  genreProfileStore,
  sessionStore,
  trackMemory
} = {}) {
  const result = tasteProfile.record(track, rating, calibrationContext);
  const session = sessionStore.read();
  const genreProfiles = genreProfileStore.recordFeedback(session.options || {}, track, rating);
  sessionStore.updateFeedback(track, rating);
  trackMemory.updateFeedback(track, rating);
  return { ...result, genreProfiles };
}

module.exports = {
  recordFeedbackAcrossStores
};
