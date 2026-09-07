"use strict";

function createRadioEnrichmentService({
  cleanArtworkUrl,
  cleanHttpUrl,
  cleanRadioText,
  config,
  fetchJsonWithTimeout,
  parseRoonPresenceNowState,
  radioEnrichmentHasArtwork,
  radioEnrichmentKey,
  radioEnrichmentResultKey,
  radioMetadataResolver,
  radioTrackFromZone,
  scheduleBroadcast,
  tidal,
  tidalEnrichmentMatches
}) {
  const radioEnrichmentCache = new Map();

  async function lookupRoonPresenceRadioArtwork(lookup = {}, key = "") {
    const url = cleanHttpUrl(config.radioMetadata.roonPresenceNowStateUrl);
    if (!url || !key) return null;

    try {
      const { response, body } = await fetchJsonWithTimeout(url, {
        headers: { accept: "application/json" }
      }, Math.max(300, Math.min(5000, Number(config.radioMetadata.roonPresenceTimeoutMs || 1200))));
      if (!response.ok) return null;

      const mirror = parseRoonPresenceNowState(body);
      if (!mirror?.albumArtUrl || mirror.key !== key) return null;

      return {
        ...mirror,
        key,
        title: lookup.title,
        artist: lookup.artist
      };
    } catch {
      return null;
    }
  }

  function attachRadioEnrichment(state = {}) {
    return {
      ...state,
      zones: (state.zones || []).map((zone) => {
        const lookup = radioTrackFromZone(zone);
        const key = radioEnrichmentKey(lookup);
        const cached = key ? radioEnrichmentCache.get(key) : null;
        const cachedResult = cached?.result && radioEnrichmentResultKey(cached.result) === key ? cached.result : null;
        if (!lookup && !cached?.result) return zone;
        if (lookup?.catalogEnrichmentAllowed === false) return {
          ...zone,
          now_playing: {
            ...(zone.now_playing || {}),
            radio_lookup: lookup
          }
        };

        return {
          ...zone,
          now_playing: {
            ...(zone.now_playing || {}),
            radio_lookup: lookup,
            ...(cachedResult ? { radio_enrichment: cachedResult } : {})
          }
        };
      })
    };
  }

  function trimRadioEnrichmentCache(max = 200) {
    if (radioEnrichmentCache.size <= max) return;
    const entries = [...radioEnrichmentCache.entries()]
      .sort((left, right) => Number(left[1]?.updatedAt || 0) - Number(right[1]?.updatedAt || 0));
    for (const [key] of entries.slice(0, radioEnrichmentCache.size - max)) {
      radioEnrichmentCache.delete(key);
    }
  }

  function radioMetadataToEnrichment(lookup = {}, metadata = {}, tidalResult = null) {
    if (lookup?.catalogEnrichmentAllowed === false) return null;
    if (!metadata && !tidalResult) return null;

    const requiresExactMetadata = Boolean(cleanRadioText(lookup.artist) && cleanRadioText(lookup.title));
    const exactMetadata = metadata && (!requiresExactMetadata || tidalEnrichmentMatches(lookup, metadata)) ? metadata : null;
    const exactTidalResult = tidalResult && tidalEnrichmentMatches(lookup, tidalResult) ? tidalResult : null;
    if (metadata && requiresExactMetadata && !exactMetadata) {
      console.warn(`Ignoring loose radio metadata for ${lookup.artist} - ${lookup.title}: ${metadata.artist || "unknown artist"} - ${metadata.title || "unknown title"}`);
    }
    if (tidalResult && !exactTidalResult) {
      console.warn(`Ignoring loose radio TIDAL match for ${lookup.artist} - ${lookup.title}: ${tidalResult.artist} - ${tidalResult.title}`);
    }

    const imageUrl = cleanArtworkUrl(exactTidalResult?.imageUrl || exactMetadata?.albumArtUrl);
    const tidalUrl = cleanRadioText(exactTidalResult?.tidalUrl || exactTidalResult?.url || exactMetadata?.tidalUrl);
    const album = cleanRadioText(exactTidalResult?.album || exactMetadata?.album);
    const durationMs = Number(exactTidalResult?.durationMs || exactMetadata?.durationMs || 0) || lookup.durationMs || null;
    const radioTrackKey = radioEnrichmentKey(lookup);

    if (!imageUrl && !tidalUrl && !album && !durationMs && !exactTidalResult) return null;

    return {
      ...(exactTidalResult || {}),
      key: radioTrackKey,
      radioTrackKey,
      radioArtworkResolved: Boolean(imageUrl),
      title: cleanRadioText(exactTidalResult?.title || exactMetadata?.title || lookup.title),
      artist: cleanRadioText(exactTidalResult?.artist || exactMetadata?.artist || lookup.artist),
      album,
      durationMs,
      tidalUrl,
      url: tidalUrl,
      imageUrl,
      lookup,
      source: exactMetadata?.source ? `radio-${exactMetadata.source}` : (exactTidalResult ? "tidal-radio-enrichment" : "radio-metadata")
    };
  }

  async function resolveRadioEnrichment(lookup, key) {
    if (lookup?.catalogEnrichmentAllowed === false) return null;
    const roonPresence = await lookupRoonPresenceRadioArtwork(lookup, key);
    if (roonPresence) return radioMetadataToEnrichment(lookup, roonPresence, null);

    const metadataPromise = config.radioMetadata.enabled
      ? radioMetadataResolver.lookup(lookup, key).catch((error) => {
        console.warn("Radio metadata resolver failed", error.message);
        return null;
      })
      : Promise.resolve(null);
    const tidalPromise = tidal.isConfigured()
      ? tidal.verify(lookup, { strict: false }).catch((error) => {
        console.warn("Radio TIDAL enrichment failed", error.message);
        return null;
      })
      : Promise.resolve(null);

    const [metadata, tidalResult] = await Promise.all([metadataPromise, tidalPromise]);
    return radioMetadataToEnrichment(lookup, metadata, tidalResult);
  }

  function scheduleRadioEnrichment(state = {}) {
    if (!config.radioMetadata.enabled && !tidal.isConfigured()) return;

    for (const zone of state.zones || []) {
      const lookup = radioTrackFromZone(zone);
      const key = radioEnrichmentKey(lookup);
      if (!key) continue;
      if (lookup.catalogEnrichmentAllowed === false) {
        radioEnrichmentCache.delete(key);
        continue;
      }

      const cached = radioEnrichmentCache.get(key);
      const cachedResult = cached?.result || null;
      const cachedResultNeedsArtworkRetry = cachedResult &&
        !radioEnrichmentHasArtwork(cachedResult) &&
        Date.now() - Number(cached.updatedAt || 0) >= 8 * 1000;
      if (cached?.pending) continue;
      if (cachedResult && !cachedResultNeedsArtworkRetry) continue;
      if (cached?.error && Date.now() - Number(cached.updatedAt || 0) < 15 * 60 * 1000) continue;

      radioEnrichmentCache.set(key, {
        pending: true,
        lookup,
        ...(cachedResult ? { result: cachedResult } : {}),
        updatedAt: Date.now()
      });

      resolveRadioEnrichment(lookup, key)
        .then((result) => {
          const nextResult = result || cachedResult || null;
          radioEnrichmentCache.set(key, {
            lookup,
            result: nextResult,
            updatedAt: Date.now()
          });
          trimRadioEnrichmentCache();
          if (result && (!cachedResult || result.imageUrl !== cachedResult.imageUrl)) scheduleBroadcast();
        })
        .catch((error) => {
          radioEnrichmentCache.set(key, {
            lookup,
            error: error.message,
            updatedAt: Date.now()
          });
          trimRadioEnrichmentCache();
        });
    }
  }

  return {
    attachRadioEnrichment,
    lookupRoonPresenceRadioArtwork,
    radioEnrichmentCache,
    radioMetadataToEnrichment,
    resolveRadioEnrichment,
    scheduleRadioEnrichment,
    trimRadioEnrichmentCache
  };
}

module.exports = {
  createRadioEnrichmentService
};
