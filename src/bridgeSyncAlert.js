"use strict";

function bridgeSyncEntriesFromResult(result = {}) {
  return [
    ...(Array.isArray(result.failedTracks) ? result.failedTracks : []),
    ...(Array.isArray(result.failed) ? result.failed : []),
    ...(Array.isArray(result.results) ? result.results : []),
    ...(Array.isArray(result.tracks) ? result.tracks : [])
  ].filter((item) => {
    const bridge = item?.bridge || item?.roon?.bridge || {};
    return Boolean(bridge.requiresManualRefresh || bridge.sync?.requiresManualRefresh);
  });
}

function bridgeSyncAlertFromEntries(entries = [], { id = "", createdAt = "" } = {}) {
  if (!entries.length) return null;
  return {
    id,
    createdAt,
    failedTracks: entries.map((item) => ({
      index: item.index,
      tidalTrackId: String(item.tidalTrackId || item.track?.tidalTrackId || item.track?.id || ""),
      artist: item.artist || item.track?.artist || item.requestedArtist || item.matchedArtist || "",
      title: item.title || item.track?.title || item.requestedTitle || item.matchedTitle || "",
      bridge: item.bridge || item.roon?.bridge || null
    }))
  };
}

function bridgeSyncAlertFromResult(result = {}, options = {}) {
  return bridgeSyncAlertFromEntries(bridgeSyncEntriesFromResult(result), options);
}

module.exports = {
  bridgeSyncAlertFromEntries,
  bridgeSyncAlertFromResult,
  bridgeSyncEntriesFromResult
};
