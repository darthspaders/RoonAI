"use strict";

const {
  currentTrackQualityPayload,
  extractTidalTrackId,
  fallbackQualityPayload,
  playbackSourceQualityPayload,
  trackHasTidalId
} = require("./currentTrackQuality");
const {
  baseTitleForMatch,
  normalizeMatchText,
  tidalEnrichmentMatches,
  tidalPlaylistFallbackMatches,
  weakTidalArtistHint
} = require("./tidalMatchRules");
const {
  metadataPlaylistMatch: buildMetadataPlaylistMatch
} = require("./tidalTrackResolution");

function createTidalLookupResolver({
  tidal,
  metadataEnrichment,
  hqplayerStatus,
  isRadioPlaybackTrack = () => false,
  withTimeout,
  qualityLookupTimeoutMs,
  playlistVerifyTimeoutMs,
  playlistFallbackTimeoutMs
} = {}) {
  async function currentPlaybackSourceQuality() {
    try {
      const status = typeof hqplayerStatus?.refreshNow === "function"
        ? await hqplayerStatus.refreshNow()
        : hqplayerStatus?.getStatus?.();
      const source = status?.source || null;
      return source?.sampleRateKhz ? source : null;
    } catch {
      return hqplayerStatus?.getStatus?.()?.source || null;
    }
  }

  async function findTidalPlaylistFallback(track = {}) {
    const title = String(track.title || "").trim();
    if (!title) return null;
    const artist = String(track.artist || "").trim();
    const titleBase = String(baseTitleForMatch(title) || "").trim();
    const weakArtist = weakTidalArtistHint(artist);
    const queries = Array.from(new Set([
      !weakArtist && artist ? `${artist} ${title}` : "",
      !weakArtist && artist ? `${title} ${artist}` : "",
      title,
      titleBase && normalizeMatchText(titleBase) !== normalizeMatchText(title) ? titleBase : ""
    ].filter(Boolean)));

    for (const query of queries.slice(0, 4)) {
      const results = await tidal.searchTracks(query, { limit: 8, detailLimit: 8 });
      const match = results.find((result) => tidalPlaylistFallbackMatches(track, result));
      if (match) return match;
    }

    return null;
  }

  async function findExactTidalCatalogueTrack(track = {}, {
    timeoutMs = playlistVerifyTimeoutMs,
    limit = 5,
    maxQueries = 6,
    message = "TIDAL exact catalogue lookup took too long."
  } = {}) {
    if (!tidal.isConfigured()) return null;
    const candidate = {
      ...track,
      artist: String(track.artist || track.tidal?.artist || "").trim(),
      title: String(track.title || track.tidal?.title || "").trim()
    };
    if (!candidate.artist || !candidate.title) return null;

    const verified = await withTimeout(
      tidal.findExactTrack(candidate, { strict: false, limit, includePageYear: false, maxQueries }),
      timeoutMs,
      message
    );
    return verified && tidalEnrichmentMatches(candidate, verified) ? verified : null;
  }

  function metadataPlaylistMatch(candidate = {}) {
    return buildMetadataPlaylistMatch(candidate, {
      cachedEntry: () => metadataEnrichment.displayableCachedEntry(candidate),
      matches: tidalPlaylistFallbackMatches
    });
  }

  async function resolveCurrentTrackQuality(track = {}) {
    const candidate = {
      ...track,
      artist: String(track.artist || track.tidal?.artist || "").trim(),
      title: String(track.title || track.tidal?.title || "").trim()
    };
    const playbackSource = await currentPlaybackSourceQuality();
    if (isRadioPlaybackTrack(candidate)) {
      return {
        ...playbackSourceQualityPayload(candidate, playbackSource, playbackSource?.display ? "live-playback-source" : "live-radio"),
        configured: tidal.isConfigured(),
        connected: true,
        reason: playbackSource?.display
          ? "Live radio quality comes from the active Roon/HQPlayer playback source."
          : "Waiting for live Roon/HQPlayer source format."
      };
    }

    const fallback = fallbackQualityPayload(candidate, playbackSource);
    const tidalId = extractTidalTrackId(candidate);

    if (!tidal.isConfigured()) {
      return {
        ...fallback,
        connected: false,
        configured: false,
        reason: fallback.display ? "" : "TIDAL catalogue verification is not configured."
      };
    }

    let resolved = null;
    let resolvedBy = "";
    let lookupError = "";
    try {
      if (tidalId) {
        resolved = await withTimeout(
          tidal.getTrack(tidalId, `${candidate.artist || ""} ${candidate.title || ""}`),
          qualityLookupTimeoutMs,
          "TIDAL catalogue detail lookup took too long."
        );
        resolvedBy = "tidal-detail";
      } else if (candidate.title && candidate.artist) {
        resolved = await findExactTidalCatalogueTrack(candidate, {
          timeoutMs: qualityLookupTimeoutMs,
          limit: 4,
          message: "TIDAL exact catalogue lookup took too long."
        });
        if (resolved) resolvedBy = "tidal-catalogue";
      }
    } catch (error) {
      lookupError = error.message || "TIDAL catalogue lookup failed.";
    }

    if (!resolved) {
      return {
        ...fallback,
        configured: true,
        connected: true,
        reason: lookupError || (fallback.display ? "" : "No exact TIDAL catalogue match for the current track.")
      };
    }

    return {
      ...currentTrackQualityPayload(candidate, resolved, resolvedBy, playbackSource),
      configured: true
    };
  }

  async function resolveTidalTrackForPlaylist(track = {}) {
    const candidate = {
      ...track,
      artist: String(track.artist || track.tidal?.artist || "").trim(),
      title: String(track.title || track.tidal?.title || "").trim()
    };
    if (!candidate.title || !candidate.artist) {
      const error = new Error("The current track needs both artist and title before it can be added to a TIDAL playlist.");
      error.statusCode = 400;
      throw error;
    }
    const cachedMetadataMatch = metadataPlaylistMatch(candidate);
    if (cachedMetadataMatch) {
      return { track: cachedMetadataMatch, resolvedBy: "metadata-enrichment-cache" };
    }
    if (trackHasTidalId(candidate)) {
      return { track: candidate, resolvedBy: "provided-tidal-id" };
    }
    if (!tidal.isConfigured()) {
      const error = new Error("The current track does not have a TIDAL ID, and TIDAL catalogue verification is not configured.");
      error.statusCode = 400;
      throw error;
    }

    let verified = null;
    let verifyError = null;
    try {
      verified = await findExactTidalCatalogueTrack(candidate, {
        timeoutMs: playlistVerifyTimeoutMs,
        limit: 4,
        maxQueries: 4,
        message: `TIDAL exact catalogue lookup took too long after ${Math.round(playlistVerifyTimeoutMs / 1000)}s.`
      });
    } catch (error) {
      verifyError = error;
    }

    if ((!verified || !tidalEnrichmentMatches(candidate, verified)) && !verifyError) {
      try {
        const fallback = await withTimeout(
          findTidalPlaylistFallback(candidate),
          playlistFallbackTimeoutMs,
          `TIDAL title fallback lookup took too long after ${Math.round(playlistFallbackTimeoutMs / 1000)}s.`
        );
        if (fallback) verified = fallback;
      } catch (error) {
        if (!verifyError) verifyError = error;
      }
    }

    if (!verified) {
      const error = new Error(verifyError?.message || `Could not find a TIDAL catalogue match for ${candidate.artist} - ${candidate.title}.`);
      error.statusCode = 400;
      throw error;
    }
    if (!tidalPlaylistFallbackMatches(candidate, verified)) {
      const error = new Error(`TIDAL found ${verified.artist || "unknown artist"} - ${verified.title || "unknown title"}, which does not exactly match the current track.`);
      error.statusCode = 400;
      throw error;
    }

    return {
      track: {
        ...candidate,
        artist: verified.artist || candidate.artist,
        title: verified.title || candidate.title,
        album: verified.album || candidate.album || "",
        tidal: verified,
        tidalUrl: verified.tidalUrl || candidate.tidalUrl || ""
      },
      resolvedBy: "tidal-catalogue"
    };
  }

  return {
    currentPlaybackSourceQuality,
    findExactTidalCatalogueTrack,
    findTidalPlaylistFallback,
    metadataPlaylistMatch,
    resolveCurrentTrackQuality,
    resolveTidalTrackForPlaylist
  };
}

module.exports = {
  createTidalLookupResolver
};
