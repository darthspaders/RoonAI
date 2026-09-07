"use strict";

function createRoonQueueableFilter({
  allowsArtistRepeatFallback,
  artistKeysForCandidate,
  buildDiscoveryProfile,
  candidateIdentityKeys,
  defaultPerRunArtistCap,
  minimumScoreFor,
  normalizeMatchText,
  queueableStatusChecks,
  rejectReason,
  requestPrefersExtendedMixes,
  roon,
  roonMatchSummary,
  tidal,
  yearRangeUtil
}) {
  function isReissueLike(result = {}) {
    const text = `${result.title || ""} ${result.album || ""}`.toLowerCase();
    return /\b(?:remaster(?:ed)?|re-?master(?:ed)?|reissue|anniversary|deluxe|expanded|restored|archive|classics?|retouch|alternative\s+version|alt(?:ernative)?\s+mix)\b/.test(text);
  }

  function embeddedYears(value) {
    return Array.from(String(value || "").matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1]));
  }

  function hasOutOfRangeEmbeddedYear(result = {}, range) {
    if (!range) return false;
    const years = embeddedYears(`${result.title || ""} ${result.album || ""}`);
    return years.some((year) => year < range.min || year > range.max);
  }

  function genreLooksWrong(track = {}, options = {}) {
    const genre = String(options.genres || options.request || "").toLowerCase();
    if (!genre.includes("progressive house")) return false;

    const text = `${track.artist || ""} ${track.title || ""} ${track.album || ""}`.toLowerCase();
    return /\b(?:trance|uplifting|psytrance|goa|techno|ambient|chillout|downtempo|breakbeat|drum\s*and\s*bass|dubstep)\b/.test(text);
  }

  async function verifyPlaylistWithRoon(playlist, zoneId, options = {}) {
    if (!zoneId) return playlist;

    const verified = [];
    const discarded = [];
    const targetCount = Number(playlist.requestedCount || options.count || playlist.tracks.length);
    const useTidal = tidal.isConfigured();
    const tidalErrors = [];
    const yearRange = yearRangeUtil.parseYearRange(options);

    for (const track of playlist.tracks) {
      if (verified.length >= targetCount) break;

      try {
        let tidalResult = null;
        if (useTidal) {
          try {
            tidalResult = await tidal.verify(track, { strict: Boolean(yearRange) });
          } catch (error) {
            tidalErrors.push(error.message);
          }
        }

        if (tidalResult) {
          if (genreLooksWrong({ ...track, ...tidalResult }, options)) {
            discarded.push({
              ...track,
              reason: "TIDAL match appears outside progressive house.",
              tidal: tidalResult
            });
            continue;
          }

          if (yearRange && isReissueLike(tidalResult)) {
            discarded.push({
              ...track,
              reason: `TIDAL match looks like a remaster/reissue, not a current release in ${yearRange.label}.`,
              tidal: tidalResult
            });
            continue;
          }

          if (yearRange && hasOutOfRangeEmbeddedYear(tidalResult, yearRange)) {
            discarded.push({
              ...track,
              reason: `TIDAL title/album references an older year outside ${yearRange.label}.`,
              tidal: tidalResult
            });
            continue;
          }

          if (yearRange?.dateSpecific && !tidalResult.releaseDate) {
            discarded.push({
              ...track,
              reason: `TIDAL verified the track but did not expose a release date for ${yearRange.label}.`,
              tidal: tidalResult
            });
            continue;
          }

          if (yearRange && !yearRange.dateSpecific && !tidalResult.year) {
            discarded.push({
              ...track,
              reason: `TIDAL verified the track but did not expose a release year for ${yearRange.label}.`,
              tidal: tidalResult
            });
            continue;
          }

          if (yearRange && !yearRangeUtil.yearFits(tidalResult.year, yearRange, tidalResult.releaseDate)) {
            discarded.push({
              ...track,
              reason: `TIDAL release ${tidalResult.releaseDate || tidalResult.year || "unknown"} is outside ${yearRange.label}.`,
              tidal: tidalResult
            });
            continue;
          }

          verified.push({
            ...track,
            artist: tidalResult.artist || track.artist,
            title: tidalResult.title || track.title,
            year: tidalResult.year || null,
            releaseDate: tidalResult.releaseDate || "",
            tidal: tidalResult,
            verificationSource: "tidal"
          });
          continue;
        }

        if (useTidal && yearRange) {
          discarded.push({
            ...track,
            reason: `Not verified in TIDAL with a release year inside ${yearRange.label}.`,
            tidal: { verified: false }
          });
          continue;
        }

        const search = await roon.search(track, zoneId);
        if (search.verified) {
          verified.push({
            ...track,
            roon: {
              verified: true,
              match: {
                title: search.match?.title,
                subtitle: search.match?.subtitle
              }
            },
            verificationSource: "roon"
          });
        } else {
          discarded.push({
            ...track,
            reason: useTidal ? "Not verified in TIDAL or Roon search" : "Not verified in Roon search",
            roon: {
              verified: false,
              match: search.match ? {
                title: search.match.title,
                subtitle: search.match.subtitle
              } : null
            }
          });
        }
      } catch (error) {
        discarded.push({
          ...track,
          reason: error.message,
          roon: { verified: false }
        });
      }
    }

    return {
      ...playlist,
      tracks: verified.slice(0, targetCount),
      discarded,
      verification: {
        enabled: true,
        tidal: useTidal,
        tidalError: tidalErrors[0] || "",
        yearRange: yearRange?.label || "",
        requested: targetCount,
        generated: playlist.tracks.length,
        kept: Math.min(verified.length, targetCount),
        discarded: discarded.length
      }
    };
  }

  async function filterForRoonQueueable(result, zoneId, options = {}) {
    if (!zoneId) {
      throw new Error("Select a Roon output zone first. Strict mode requires every TIDAL result to be verified and queueable in Roon.");
    }

    if (!result?.tracks?.length && !result?.alternates?.length) {
      const discarded = result?.discarded || [];
      if (result) delete result.alternates;
      return {
        ...(result || {}),
        tracks: result?.tracks || [],
        discarded,
        verification: {
          ...(result?.verification || {}),
          roonQueueable: true,
          roonStrict: true,
          roonChecked: 0,
          roonRejected: 0,
          roonCheckLimit: 0,
          kept: 0,
          generated: Number(result?.verification?.generated ?? discarded.length) || discarded.length,
          discarded: Number(result?.verification?.discarded ?? discarded.length) || discarded.length
        }
      };
    }

    const yearRange = yearRangeUtil.parseYearRange({ ...options, years: options.years || result.verification?.yearRange || "" });
    const scoringOptions = yearRange ? { ...options, years: yearRange.label } : options;
    const targetCount = Number(result.requestedCount || result.verification?.requested || result.tracks.length);
    const minScore = minimumScoreFor(scoringOptions);
    const strictFilteredRequest = Boolean(yearRange || minScore);
    const pool = [];
    const seen = new Set();
    for (const track of [...(result.tracks || []), ...(result.alternates || [])]) {
      const keys = candidateIdentityKeys(track);
      const key = keys[0] || `${normalizeMatchText(track.artist || "")}|${normalizeMatchText(track.title || "")}`;
      if (!key || seen.has(key) || keys.some((candidateKey) => seen.has(candidateKey))) continue;
      for (const candidateKey of keys) seen.add(candidateKey);
      seen.add(key);
      pool.push(track);
    }

    const accepted = [];
    const rejected = [];
    const deferredAccepted = [];
    const acceptedArtistCounts = new Map();
    const queueProfile = buildDiscoveryProfile(options);
    const artistCap = defaultPerRunArtistCap(options, queueProfile, targetCount);
    const allowQueueRepeatFallback = allowsArtistRepeatFallback(options, queueProfile);
    function wouldExceedArtistCap(track = {}) {
      if (!Number.isFinite(artistCap) || artistCap >= Number.MAX_SAFE_INTEGER) return false;
      const keys = artistKeysForCandidate(track);
      if (!keys.length) return false;
      return keys.some((key) => Number(acceptedArtistCounts.get(key) || 0) >= artistCap);
    }
    function rememberAcceptedArtist(track = {}) {
      if (!Number.isFinite(artistCap) || artistCap >= Number.MAX_SAFE_INTEGER) return;
      for (const key of artistKeysForCandidate(track)) {
        acceptedArtistCounts.set(key, Number(acceptedArtistCounts.get(key) || 0) + 1);
      }
    }
    function acceptQueueableTrack(track = {}) {
      if (wouldExceedArtistCap(track)) {
        deferredAccepted.push({
          ...track,
          statusChecks: Array.from(new Set([
            ...(Array.isArray(track.statusChecks) ? track.statusChecks : []),
            "Deferred behind fresher artists by Rabbit Hole artist-diversity cap"
          ]))
        });
        return false;
      }
      accepted.push(track);
      rememberAcceptedArtist(track);
      return true;
    }
    const bridgeEnabled = options.allowBridge !== false && Boolean(roon.resolveDirectBridgeBatch);
    const bridgePending = [];
    const roonSearchOptions = {
      preferExtendedMixes: requestPrefersExtendedMixes(options),
      matchPolicy: "strict",
      allowBridge: false
    };
    const maxChecks = Math.min(
      pool.length,
      strictFilteredRequest
        ? Math.min(180, Math.max(targetCount + 70, targetCount * 8))
        : Math.min(90, Math.max(targetCount + 36, targetCount * 5))
    );
    let checked = 0;

    for (const track of pool) {
      if (accepted.length >= targetCount) break;
      if (checked >= maxChecks) break;

      if (yearRange) {
        const candidateRange = track.discoveryLane === "recent" && result.verification?.nearYearFallbackRange
          ? yearRangeUtil.parseYearRange({ ...options, years: result.verification.nearYearFallbackRange })
          : yearRange;
        const candidateScoringOptions = candidateRange
          ? { ...options, years: candidateRange.label }
          : scoringOptions;
        const scoringTrack = {
          ...track,
          ...(track.tidal || {}),
          query: track.query || track.roon?.sourceQuery || "",
          roon: track.roon
        };
        const rejection = rejectReason(scoringTrack, candidateScoringOptions);
        if (rejection) {
          rejected.push({
            ...track,
            reason: rejection
          });
          continue;
        }
      }

      if (track.roon?.verified && track.roon?.queueAction) {
        acceptQueueableTrack({
          ...track,
          statusChecks: queueableStatusChecks(track)
        });
        continue;
      }

      checked += 1;
      try {
        const search = await roon.canQueueTrack(track, zoneId, roonSearchOptions);
        if (search.success) {
          acceptQueueableTrack({
            ...track,
            roon: {
              verified: true,
              match: roonMatchSummary(search.match),
              queueAction: search.action || ""
            },
            statusChecks: queueableStatusChecks(track)
          });
        } else {
          const rejection = {
            ...track,
            reason: search.reason || `Roon did not find an exact queueable match. Best result was ${search.match?.title || "none"}${search.match?.subtitle ? ` - ${search.match.subtitle}` : ""}.`,
            roon: {
              verified: false,
              match: roonMatchSummary(search.match)
            }
          };
          if (bridgeEnabled && (track.tidalTrackId || track.tidal?.id || track.isrc)) {
            bridgePending.push({ index: checked - 1, track, mode: "queue", policy: "strict", directFailure: rejection });
          } else {
            rejected.push(rejection);
          }
        }
      } catch (error) {
        rejected.push({
          ...track,
          reason: error.message,
          roon: { verified: false }
        });
      }
    }

    if (bridgeEnabled && accepted.length < targetCount && bridgePending.length) {
      let bridged = [];
      try {
        bridged = await roon.resolveDirectBridgeBatch(bridgePending, zoneId, {
          mode: "queue",
          bridgeSyncDelaysMs: options.bridgeSyncDelaysMs,
          bridgeLookupTimeoutMs: options.bridgeLookupTimeoutMs
        });
      } catch (error) {
        bridged = bridgePending.map(entry => ({ ...entry, result: { success: false, reason: error.message, failureType: "bridge_resolution_failed" } }));
      }
      const byIndex = new Map(bridged.map(entry => [entry.index, entry]));
      const processedBridge = new Set();
      for (const pending of bridgePending) {
        if (accepted.length >= targetCount) break;
        processedBridge.add(pending.index);
        const bridgeResult = byIndex.get(pending.index)?.result || {};
        if (bridgeResult.success && bridgeResult.queueToken) {
          acceptQueueableTrack({
            ...pending.track,
            roon: {
              verified: true,
              match: roonMatchSummary(bridgeResult.match),
              queueAction: bridgeResult.queueToken,
              queueToken: bridgeResult.queueToken,
              bridge: bridgeResult.bridge || null
            },
            bridge: bridgeResult.bridge || null,
            statusChecks: queueableStatusChecks(pending.track)
          });
        } else {
          rejected.push({
            ...pending.directFailure,
            reason: bridgeResult.reason || pending.directFailure.reason,
            roon: {
              ...(pending.directFailure.roon || {}),
              bridge: bridgeResult.bridge || null
            },
            bridge: bridgeResult.bridge || null
          });
        }
      }
      for (const pending of bridgePending) {
        if (!processedBridge.has(pending.index)) rejected.push(pending.directFailure);
      }
    }

    let relaxedDeferredCount = 0;
    if (allowQueueRepeatFallback && accepted.length < targetCount && deferredAccepted.length) {
      for (const track of deferredAccepted) {
        if (accepted.length >= targetCount) break;
        accepted.push({
          ...track,
          artistDiversityRelaxed: true,
          statusChecks: Array.from(new Set([
            ...(Array.isArray(track.statusChecks) ? track.statusChecks : []),
            "Artist diversity relaxed after queueable pool undershot"
          ]))
        });
        relaxedDeferredCount += 1;
      }
    }

    const deferredDiscarded = deferredAccepted.slice(relaxedDeferredCount).map((track) => ({
      ...track,
      reason: allowQueueRepeatFallback
        ? "Queueable match deferred by Rabbit Hole artist-diversity cap."
        : "Queueable match held back by novelty budget; repeated artists were not requested."
    }));
    const discarded = [...(result.discarded || []), ...rejected, ...deferredDiscarded];
    const belowMinimumKept = accepted.filter((track) => track.belowMinimum).length;
    const aboveMinimumKept = minScore ? Math.max(0, accepted.length - belowMinimumKept) : accepted.length;
    delete result.alternates;
    return {
      ...result,
      tracks: accepted,
      discarded,
      verification: {
        ...(result.verification || {}),
        roonQueueable: true,
        roonStrict: true,
        yearRange: yearRange?.label || result.verification?.yearRange || "",
        roonChecked: checked,
        roonRejected: rejected.length,
        roonCheckLimit: maxChecks,
        roonArtistDiversityDeferred: deferredAccepted.length,
        roonArtistDiversityRelaxed: accepted.filter((track) => track.artistDiversityRelaxed).length,
        roonArtistDiversityRepeatFallbackAllowed: allowQueueRepeatFallback,
        perRunArtistCap: artistCap,
        generated: accepted.length + discarded.length,
        kept: accepted.length,
        discarded: discarded.length,
        belowMinimumKept,
        aboveMinimumKept,
        minScoreSoftFallback: Boolean(minScore && belowMinimumKept)
      }
    };
  }

  return {
    filterForRoonQueueable,
    genreLooksWrong,
    hasOutOfRangeEmbeddedYear,
    isReissueLike,
    verifyPlaylistWithRoon
  };
}

module.exports = {
  createRoonQueueableFilter
};
