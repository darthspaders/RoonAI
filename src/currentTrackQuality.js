"use strict";

const { trackSourceQualityFromMetadata } = require("./tidalVerifier");

function trackHasTidalId(track = {}) {
  const direct = String(track.tidal?.id || track.tidalId || track.id || "").trim();
  if (direct && !/^https?:\/\//i.test(direct)) return true;
  const url = String(track.tidal?.tidalUrl || track.tidalUrl || track.url || "").trim();
  return /\/track\/[^/?#]+/i.test(url);
}

function extractTidalTrackId(track = {}) {
  const direct = String(track.tidal?.id || track.tidalId || track.id || track.trackId || "").trim();
  if (direct && !/^https?:\/\//i.test(direct)) return direct;
  const url = String(track.tidal?.tidalUrl || track.tidalUrl || track.url || "").trim();
  const match = url.match(/\/track\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function hasExplicitTidalPlaybackSource(track = {}, resolvedBy = "") {
  if (trackHasTidalId(track)) return true;
  if (/^(?:provided-tidal-id|tidal-detail)$/i.test(String(resolvedBy || ""))) return true;
  return [
    track.sourceType,
    track.provider,
    track.source,
    track.playbackProvider
  ].some((value) => /^tidal$/i.test(String(value || "").trim()));
}

function currentQualitySourceLabel(track = {}, resolvedBy = "", playbackSource = null) {
  if (hasExplicitTidalPlaybackSource(track, resolvedBy)) return "TIDAL";
  const sourceName = String(playbackSource?.sourceName || "").trim();
  if (playbackSource?.display || sourceName) return sourceName || "Roon";
  return "TIDAL";
}

function currentTrackPayload(track = {}, resolved = null) {
  const tidalMetadata = track.tidal && typeof track.tidal === "object" ? track.tidal : {};
  return {
    id: resolved?.id || extractTidalTrackId(track),
    title: resolved?.title || track.title || tidalMetadata.title || "",
    artist: resolved?.artist || track.artist || tidalMetadata.artist || "",
    album: resolved?.album || track.album || tidalMetadata.album || "",
    tidalUrl: resolved?.tidalUrl || track.tidalUrl || tidalMetadata.tidalUrl || ""
  };
}

function currentTrackQualityPayload(track = {}, resolved = null, resolvedBy = "", playbackSource = null) {
  const tidalMetadata = track.tidal && typeof track.tidal === "object" ? track.tidal : {};
  const preferPlaybackFormat = Boolean(playbackSource?.display && !hasExplicitTidalPlaybackSource(track, resolvedBy));
  const merged = {
    ...tidalMetadata,
    ...track,
    ...(resolved || {}),
    mediaTags: (resolved?.mediaTags && resolved.mediaTags.length) ? resolved.mediaTags : (tidalMetadata.mediaTags || track.mediaTags || []),
    audioQuality: resolved?.audioQuality || tidalMetadata.audioQuality || track.audioQuality || "",
    codec: preferPlaybackFormat ? (playbackSource.codec || resolved?.codec || tidalMetadata.codec || track.codec || "") : (resolved?.codec || tidalMetadata.codec || track.codec || playbackSource?.codec || ""),
    sampleRateKhz: preferPlaybackFormat ? (playbackSource.sampleRateKhz || resolved?.sampleRateKhz || tidalMetadata.sampleRateKhz || track.sampleRateKhz || null) : (resolved?.sampleRateKhz || tidalMetadata.sampleRateKhz || track.sampleRateKhz || playbackSource?.sampleRateKhz || null),
    bitDepth: preferPlaybackFormat ? (playbackSource.bitDepth || resolved?.bitDepth || tidalMetadata.bitDepth || track.bitDepth || null) : (resolved?.bitDepth || tidalMetadata.bitDepth || track.bitDepth || playbackSource?.bitDepth || null),
    channels: preferPlaybackFormat ? (playbackSource.channels || resolved?.channels || tidalMetadata.channels || track.channels || null) : (resolved?.channels || tidalMetadata.channels || track.channels || playbackSource?.channels || null)
  };
  const sourceLabel = currentQualitySourceLabel(track, resolvedBy, playbackSource);
  const quality = trackSourceQualityFromMetadata(merged, { source: sourceLabel });
  return {
    connected: true,
    resolvedBy,
    catalogSource: resolvedBy === "tidal-catalogue" ? "TIDAL" : "",
    ...quality,
    playbackSource: playbackSource ? {
      source: playbackSource.sourceName || "",
      sampleRateKhz: playbackSource.sampleRateKhz || null,
      bitDepth: playbackSource.bitDepth || null,
      channels: playbackSource.channels || null,
      display: playbackSource.display || ""
    } : null,
    track: currentTrackPayload(track, resolved)
  };
}

function hasProvidedTidalQuality(track = {}) {
  const tidalMetadata = track.tidal && typeof track.tidal === "object" ? track.tidal : {};
  const mediaTags = Array.isArray(tidalMetadata.mediaTags) ? tidalMetadata.mediaTags : (Array.isArray(track.mediaTags) ? track.mediaTags : []);
  return Boolean(
    trackHasTidalId(track) ||
    tidalMetadata.tidalUrl ||
    track.tidalUrl ||
    mediaTags.length ||
    tidalMetadata.audioQuality ||
    track.audioQuality ||
    tidalMetadata.sampleRateKhz ||
    track.sampleRateKhz ||
    tidalMetadata.bitDepth ||
    track.bitDepth
  );
}

function playbackSourceQualityPayload(track = {}, playbackSource = null, resolvedBy = "playback-source") {
  const source = playbackSource || {};
  const display = String(source.display || "").trim();
  const sampleRateKhz = Number(source.sampleRateKhz || 0) || null;
  const bitDepth = Number(source.bitDepth || 0) || null;
  const channels = Number(source.channels || 0) || null;
  const bitrate = Number(source.bitrate || 0) || null;
  const codec = String(source.codec || "").trim().toUpperCase();
  const sourceName = String(source.sourceName || "").trim();
  return {
    connected: true,
    resolvedBy,
    source: codec || sourceName.toUpperCase() || "ROON",
    codec,
    quality: "",
    mediaTags: [],
    audioQuality: "",
    sampleRateKhz,
    bitDepth,
    channels,
    bitrate,
    exact: Boolean(sampleRateKhz || display),
    display: display || "",
    playbackSource: source ? {
      source: sourceName,
      codec,
      sampleRateKhz,
      bitDepth,
      channels,
      bitrate,
      display
    } : null,
    track: currentTrackPayload(track)
  };
}

function fallbackQualityPayload(track = {}, playbackSource = null, resolvedBy = "") {
  if (hasProvidedTidalQuality(track)) {
    return currentTrackQualityPayload(track, null, resolvedBy || (trackHasTidalId(track) ? "provided-tidal-id" : "provided-metadata"), playbackSource);
  }
  return playbackSourceQualityPayload(track, playbackSource, resolvedBy || (playbackSource?.display ? "live-playback-source" : "provided-metadata"));
}

module.exports = {
  currentQualitySourceLabel,
  currentTrackPayload,
  currentTrackQualityPayload,
  extractTidalTrackId,
  fallbackQualityPayload,
  hasExplicitTidalPlaybackSource,
  hasProvidedTidalQuality,
  playbackSourceQualityPayload,
  trackHasTidalId
};
