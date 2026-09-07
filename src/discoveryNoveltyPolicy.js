"use strict";

function requestAllowsPreviousSuggestions(options = {}) {
  const text = `${options.request || ""} ${options.reference || ""} ${options.genres || ""} ${options.mood || ""}`;
  return /\b(?:allow repeats|include repeats|show repeats|reuse previous suggestions|include previous suggestions|include previously suggested|show previous suggestions|same tracks again|same songs again|rerun previous)\b/i.test(text);
}

function previouslySuggestedDiscard(track = {}, entry = null) {
  return {
    ...track,
    rejectedReason: "previously suggested",
    reason: "Previously suggested; held back for discovery novelty.",
    history: {
      firstShownAt: entry?.firstShownAt || "",
      lastShownAt: entry?.lastShownAt || "",
      shownCount: Number(entry?.shownCount || 0)
    },
    statusChecks: Array.from(new Set([
      ...(Array.isArray(track.statusChecks) ? track.statusChecks : []),
      "Previously suggested; held back"
    ]))
  };
}

function createDiscoveryNoveltyPolicy({
  discoveryHistory,
  candidateIdentityKeys = () => []
} = {}) {
  function previouslySuggestedTrack(track = {}) {
    return typeof discoveryHistory?.entryFor === "function" ? discoveryHistory.entryFor(track) : null;
  }

  function suppressPreviouslySuggestedResultTracks(result = {}, options = {}) {
    if (requestAllowsPreviousSuggestions(options)) return result;
    const tracks = [];
    const heldBack = [];

    for (const track of result.tracks || []) {
      const entry = previouslySuggestedTrack(track);
      if (entry) heldBack.push(previouslySuggestedDiscard(track, entry));
      else tracks.push(track);
    }

    if (!heldBack.length) return result;
    return {
      ...result,
      tracks,
      discarded: [...heldBack, ...(result.discarded || [])],
      verification: {
        ...(result.verification || {}),
        previouslySuggestedHeldBack: Number(result.verification?.previouslySuggestedHeldBack || 0) + heldBack.length,
        freshnessGuardHeldBack: heldBack.length
      }
    };
  }

  function freshUnseenTracks(tracks = []) {
    const seen = new Set();
    const fresh = [];
    for (const track of tracks || []) {
      const keys = candidateIdentityKeys(track);
      const key = keys[0] || `${track.artist || ""}|${track.title || ""}`.toLowerCase();
      if (!key || seen.has(key)) continue;
      for (const candidateKey of keys) seen.add(candidateKey);
      seen.add(key);
      if (previouslySuggestedTrack(track)) continue;
      fresh.push(track);
    }
    return fresh;
  }

  return {
    freshUnseenTracks,
    previouslySuggestedTrack,
    suppressPreviouslySuggestedResultTracks
  };
}

module.exports = {
  createDiscoveryNoveltyPolicy,
  previouslySuggestedDiscard,
  requestAllowsPreviousSuggestions
};
