"use strict";

const { extractTidalTrackId } = require("./currentTrackQuality");

function metadataPlaylistMatch(candidate = {}, {
  cachedEntry = null,
  matches = () => false
} = {}) {
  const entries = [
    candidate.tidal,
    candidate.metadataEnrichment,
    candidate.metadata_enrichment,
    typeof cachedEntry === "function" ? cachedEntry(candidate) : cachedEntry
  ].filter((entry) => entry && typeof entry === "object");

  for (const entry of entries) {
    const normalized = {
      ...entry,
      artist: entry.artist || candidate.artist,
      title: entry.title || candidate.title,
      tidalUrl: entry.tidalUrl || entry.url || ""
    };
    const tidalId = extractTidalTrackId(normalized);
    if (!tidalId || !matches(candidate, normalized)) continue;
    return {
      ...candidate,
      artist: normalized.artist || candidate.artist,
      title: normalized.title || candidate.title,
      album: normalized.album || candidate.album || "",
      label: normalized.label || candidate.label || "",
      year: normalized.year || normalized.releaseYear || candidate.year || null,
      releaseDate: normalized.releaseDate || candidate.releaseDate || "",
      durationMs: normalized.durationMs || candidate.durationMs || null,
      id: tidalId,
      tidalId,
      tidal: normalized,
      tidalUrl: normalized.tidalUrl || `https://tidal.com/browse/track/${encodeURIComponent(tidalId)}`
    };
  }

  return null;
}

function compactVerifiedTrack(track = {}) {
  return {
    id: extractTidalTrackId(track),
    artist: String(track.artist || track.tidal?.artist || "").trim(),
    title: String(track.title || track.tidal?.title || "").trim(),
    album: String(track.album || track.tidal?.album || "").trim(),
    label: String(track.label || track.tidal?.label || "").trim(),
    year: track.year || track.releaseYear || track.tidal?.year || track.tidal?.releaseYear || null,
    releaseDate: String(track.releaseDate || track.tidal?.releaseDate || "").trim(),
    durationMs: Number.isFinite(Number(track.durationMs || track.tidal?.durationMs))
      ? Number(track.durationMs || track.tidal?.durationMs)
      : null,
    tidalUrl: String(track.tidalUrl || track.tidal?.tidalUrl || track.url || "").trim(),
    matchScore: Number.isFinite(Number(track.matchScore)) ? Number(track.matchScore) : null,
    audioQuality: String(track.audioQuality || track.tidal?.audioQuality || "").trim()
  };
}

function verificationTrackFromInput(input = {}) {
  if (typeof input === "string") {
    const parts = input.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    return parts.length >= 2
      ? { artist: parts[0], title: parts.slice(1).join(" - ") }
      : { title: input.trim() };
  }
  if (!input || typeof input !== "object") return {};
  const artist = input.artist || input.artists || input.artistName || input.tidal?.artist || "";
  return {
    ...input,
    artist: Array.isArray(artist) ? artist.join(", ") : String(artist || "").trim(),
    title: String(input.title || input.name || input.trackTitle || input.tidal?.title || "").trim(),
    album: String(input.album || input.albumTitle || input.release || input.tidal?.album || "").trim(),
    tidalUrl: String(input.tidalUrl || input.url || input.tidal?.tidalUrl || input.tidal?.url || "").trim()
  };
}

module.exports = {
  compactVerifiedTrack,
  metadataPlaylistMatch,
  verificationTrackFromInput
};
