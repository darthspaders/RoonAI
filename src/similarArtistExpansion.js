"use strict";

function createSimilarArtistExpansion({
  buildDiscoveryProfile,
  config,
  lastfm,
  normalizeScoringMode,
  rabbitHoleGraph,
  tasteProfile,
  withTimeout
}) {
  function cleanSeedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeSeedText(value) {
    return cleanSeedText(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function splitSeedArtists(value) {
    return cleanSeedText(value)
      .split(/\s+(?:and|feat\.?|featuring|with)\s+|[,/&+|]+/i)
      .map(cleanSeedText)
      .filter((part) => part && part.length > 1 && part.length <= 80);
  }

  function genericSeedArtist(value = "") {
    const text = normalizeSeedText(value);
    return !text || /^(?:various artists?|unknown artist|unknown|n a|na|va|v a|soundtrack|house music|techno music|trance music|psytrance|ambient music|electronic dance music|edm|dance music)$/.test(text);
  }

  function requestUsesNowPlayingSeed(options = {}) {
    const request = cleanSeedText(options.request);
    const genres = cleanSeedText(options.genres);
    const text = normalizeSeedText(`${options.request || ""} ${options.reference || ""}`);
    if (!request && !genres) return true;
    return /\b(?:now playing|current roon|current track|current song|what is playing|this track|this song|use current|like this|like what is playing|around what is playing)\b/.test(text);
  }

  function referenceSeedArtists(reference = "", limit = 20) {
    const artists = [];
    for (const line of String(reference || "").split(/\r?\n/)) {
      const text = cleanSeedText(line);
      const match = text.match(/^(.+?)\s+-\s+(.+)$/);
      if (!match) continue;
      artists.push(...splitSeedArtists(match[1]));
      if (artists.length >= limit) break;
    }
    return artists.slice(0, limit);
  }

  function baseArtistsForSimilarExpansion(options = {}, limit = 8) {
    const plan = options.llmSearchPlan && typeof options.llmSearchPlan === "object" ? options.llmSearchPlan : {};
    const scoringMode = normalizeScoringMode(options);
    const candidates = [
      ...(Array.isArray(plan.seedArtists) ? plan.seedArtists : []),
      ...(scoringMode === "similar" && Array.isArray(plan.candidateArtists) ? plan.candidateArtists : []),
      ...referenceSeedArtists(options.reference, 20),
      ...(requestUsesNowPlayingSeed(options) ? [options.nowPlaying?.artist] : [])
    ];
    const seen = new Set();
    const result = [];
    for (const value of candidates) {
      for (const artist of splitSeedArtists(value)) {
        const key = normalizeSeedText(artist);
        if (!key || seen.has(key) || genericSeedArtist(artist)) continue;
        seen.add(key);
        result.push(artist);
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  function uniqueSeedArtists(values = [], limit = 8) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      for (const artist of splitSeedArtists(value)) {
        const key = normalizeSeedText(artist);
        if (!key || seen.has(key) || genericSeedArtist(artist)) continue;
        seen.add(key);
        result.push(artist);
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  async function withSimilarArtistSeeds(options = {}, requestedCount = 8) {
    if (normalizeScoringMode(options) === "pure") {
      return {
        ...options,
        similarArtistExpansion: {
          enabled: false,
          reason: "Pure Search keeps similar-artist expansion disabled so the prompt remains the hard constraint."
        }
      };
    }
    const status = lastfm.status();
    const profile = buildDiscoveryProfile(options);
    const tasteAnchorLimit = profile.scoringMode === "taste-guided" && profile.hasExplicitDiscoveryIntent && !(profile.requestedArtists || []).length
      ? 6
      : (profile.scoringMode === "explore" ? 4 : 0);
    const tasteAnchors = tasteAnchorLimit && typeof tasteProfile.getTopArtists === "function"
      ? tasteProfile.getTopArtists(tasteAnchorLimit)
      : [];
    const baseArtists = uniqueSeedArtists([
      ...baseArtistsForSimilarExpansion(options, 8),
      ...tasteAnchors
    ], 8);
    if (!baseArtists.length) {
      return {
        ...options,
        similarArtistExpansion: {
          enabled: false,
          reason: "No credible seed artists available for similar-artist expansion."
        }
      };
    }
    if (status.enabled === false || !status.apiKeyConfigured) {
      return {
        ...options,
        similarArtistExpansion: {
          enabled: false,
          seeds: baseArtists,
          reason: status.enabled === false ? "Last.fm lookup disabled." : "LASTFM_API_KEY is missing."
        }
      };
    }

    const limit = Math.max(4, Math.min(16, Math.ceil(Number(requestedCount || 8) * 0.75)));
    const timeoutMs = Math.max(1200, Math.min(4500, Number(config.lastfm.timeoutMs || 3500)));
    try {
      const related = await withTimeout(
        rabbitHoleGraph.similarArtistsForSeeds(baseArtists, { config }, {
          seedLimit: 4,
          perSeed: 6,
          limit
        }),
        timeoutMs,
        "Similar artist expansion timed out."
      );
      const similarArtistSeeds = [];
      const seen = new Set((options.similarArtistSeeds || []).map(normalizeSeedText));
      for (const item of related || []) {
        const name = cleanSeedText(item.name);
        const key = normalizeSeedText(name);
        if (!key || seen.has(key) || genericSeedArtist(name)) continue;
        seen.add(key);
        similarArtistSeeds.push(name);
      }
      return {
        ...options,
        similarArtistSeeds: [
          ...(Array.isArray(options.similarArtistSeeds) ? options.similarArtistSeeds : []),
          ...similarArtistSeeds
        ],
        similarArtistExpansion: {
          enabled: true,
          source: "Last.fm artist.getsimilar",
          seeds: baseArtists.slice(0, 4),
          returned: similarArtistSeeds.length,
          artists: similarArtistSeeds
        }
      };
    } catch (error) {
      return {
        ...options,
        similarArtistExpansion: {
          enabled: false,
          seeds: baseArtists.slice(0, 4),
          reason: error.message || "Similar artist expansion failed."
        }
      };
    }
  }

  return {
    baseArtistsForSimilarExpansion,
    cleanSeedText,
    genericSeedArtist,
    normalizeSeedText,
    referenceSeedArtists,
    requestUsesNowPlayingSeed,
    splitSeedArtists,
    uniqueSeedArtists,
    withSimilarArtistSeeds
  };
}

module.exports = {
  createSimilarArtistExpansion
};
