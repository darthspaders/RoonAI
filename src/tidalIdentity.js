"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tidalTrackIdFromUrl(value = "") {
  const match = cleanText(value).match(/\/track\/(\d+)/i);
  return match ? match[1] : "";
}

function normalizeTidalTrackUrl(value = "") {
  const url = cleanText(value);
  const trackId = tidalTrackIdFromUrl(url);
  if (/^https?:\/\/(?:www\.)?(?:listen\.)?tidal\.com\/(?:browse\/)?track\/\d+/i.test(url) && trackId) {
    return `https://tidal.com/browse/track/${trackId}`;
  }
  return url;
}

function explicitTidalTrackId(track = {}) {
  return [
    track.tidal?.id,
    track.tidal?.trackId,
    track.tidal?.track_id,
    track.tidalId,
    track.tidalTrackId,
    track.id,
    track.trackId
  ].map(cleanText).find((value) => /^\d+$/.test(value)) || "";
}

module.exports = {
  explicitTidalTrackId,
  normalizeTidalTrackUrl,
  tidalTrackIdFromUrl
};
