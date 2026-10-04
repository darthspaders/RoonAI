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

  function facetSeedArtists(options = {}, limit = 12) {
    const facets = Array.isArray(options.tasteFacets) ? options.tasteFacets : [];
    const candidates = [];
    // Take one anchor from each facet before taking second anchors. This keeps
    // Last.fm from seeing only the dominant global cluster when the library
    // contains genuinely different musical regions.
    for (let index = 0; index < 3; index += 1) {
      for (const facet of facets) {
        const evidence = Array.isArray(facet?.artistEvidence) ? facet.artistEvidence : [];
        const artists = evidence.length
          ? evidence.filter((item) => item?.similaritySafe !== false).map((item) => item?.name).filter(Boolean)
          : (Array.isArray(facet?.artists) ? facet.artists : []);
        if (artists[index]) candidates.push(artists[index]);
      }
    }
    return uniqueSeedArtists(candidates, limit);
  }

  function facetSeedContexts(options = {}) {
    const contexts = {};
    for (const facet of Array.isArray(options.tasteFacets) ? options.tasteFacets : []) {
      const context = cleanSeedText(facet?.name);
      if (!context) continue;
      const evidence = Array.isArray(facet?.artistEvidence) && facet.artistEvidence.length
        ? facet.artistEvidence.map((item) => item?.name)
        : (Array.isArray(facet?.artists) ? facet.artists : []);
      for (const artist of evidence) {
        const key = normalizeSeedText(artist);
        if (key && !contexts[key]) contexts[key] = context;
      }
    }
    return contexts;
  }

  async function withSimilarArtistSeeds(options = {}, requestedCount = 8) {
    if (/^(1|true|yes)$/i.test(String(options.skipSimilarArtistExpansion || ""))) {
      return {
        ...options,
        similarArtistExpansion: {
          enabled: false,
          reason: "Similar-artist expansion disabled for this independent search pass."
        }
      };
    }
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
    const tasteProfileMode = Boolean(
      profile.tasteProfileLed ||
      profile.promptIntent?.outsideTasteMode === "taste-profile"
    );
    const hardGenreRequest = Boolean(
      profile.targetGenres?.length &&
      profile.promptIntent?.genreConstraint === "hard" &&
      !profile.isOmnivoreDiscovery
    );
    const requestedArtists = profile.requestedArtists || [];
    if (hardGenreRequest && !requestedArtists.length) {
      return {
        ...options,
        similarArtistExpansion: {
          enabled: false,
          reason: "Hard genre requests keep learned taste as a soft ranking signal, but do not spend query budget on unverified learned/similar-artist seeds unless an artist was explicitly requested."
        }
      };
    }
    const tasteAnchorLimit = !hardGenreRequest && tasteProfileMode
      ? 8
      : !hardGenreRequest && profile.scoringMode === "taste-guided" && profile.hasExplicitDiscoveryIntent && !requestedArtists.length
        ? 6
      : (!hardGenreRequest && profile.scoringMode === "explore" ? 4 : 0);
    const tasteAnchors = tasteAnchorLimit && typeof tasteProfile.getTopArtists === "function"
      ? tasteProfile.getTopArtists(tasteAnchorLimit)
      : [];
    const baseArtists = uniqueSeedArtists([
      ...(tasteProfileMode ? facetSeedArtists(options, 12) : []),
      ...(tasteProfileMode && Array.isArray(options.learnedTasteArtists) ? options.learnedTasteArtists : []),
      ...baseArtistsForSimilarExpansion(options, 8),
      ...tasteAnchors
    ], 8).filter((artist) => !hardGenreRequest || requestedArtists.some((requested) => {
      const artistKey = normalizeSeedText(artist);
      const requestedKey = normalizeSeedText(requested);
      return artistKey === requestedKey || artistKey.includes(requestedKey) || requestedKey.includes(artistKey);
    }));
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
        rabbitHoleGraph.similarArtistsForSeeds(baseArtists.slice(0, 4), { config }, {
          seedLimit: 4,
          perSeed: 6,
          limit,
          // Last.fm can resolve common artist names to a different musical
          // identity. In taste-profile mode, validate a seed against the
          // facet it came from before expanding its external neighborhood.
          validateSeedContext: tasteProfileMode,
          seedContexts: facetSeedContexts(options),
          minMatchScore: tasteProfileMode ? 0.25 : 0
        }),
        timeoutMs,
        "Similar artist expansion timed out."
      );
      const similarArtistSeeds = [];
      const similarArtistEvidence = [];
      const seen = new Set((options.similarArtistSeeds || []).map(normalizeSeedText));
      for (const item of related || []) {
        const name = cleanSeedText(item.name);
        const key = normalizeSeedText(name);
        if (!key || seen.has(key) || genericSeedArtist(name)) continue;
        seen.add(key);
        similarArtistSeeds.push(name);
        similarArtistEvidence.push({
          name,
          matchScore: Number(item.matchScore || 0),
          seedArtist: cleanSeedText(item.seedArtist),
          source: cleanSeedText(item.source || "Last.fm similar")
        });
      }
      return {
        ...options,
        similarArtistSeeds: [
          ...(Array.isArray(options.similarArtistSeeds) ? options.similarArtistSeeds : []),
          ...similarArtistSeeds
        ],
        // Carry identity-validation failures into the direct catalog lane as
        // well. Rejecting an ambiguous Last.fm branch is not enough if the
        // same ambiguous artist is still queried directly by TIDAL.
        tasteSeedExclusions: [
          ...(Array.isArray(options.tasteSeedExclusions) ? options.tasteSeedExclusions : []),
          ...(Array.isArray(related?.seedValidation)
            ? related.seedValidation.filter((item) => item && item.accepted === false).map((item) => item.artist)
            : [])
        ].filter(Boolean),
        similarArtistEvidence: [
          ...(Array.isArray(options.similarArtistEvidence) ? options.similarArtistEvidence : []),
          ...similarArtistEvidence
        ],
        similarArtistExpansion: {
          enabled: true,
          source: "Last.fm artist.getsimilar",
          seeds: baseArtists.slice(0, 4),
          returned: similarArtistSeeds.length,
          artists: similarArtistSeeds,
          skippedSeeds: Array.isArray(related?.seedValidation)
            ? related.seedValidation.filter((item) => item && item.accepted === false)
            : []
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
