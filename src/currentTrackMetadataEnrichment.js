"use strict";

function createCurrentTrackMetadataEnrichment({
  cleanRadioText,
  config,
  metadataEnrichment,
  scheduleBroadcast,
  summarizeZoneTrack,
  onLiveTrackObserved = null
}) {
  function firstMetadataText(...values) {
    for (const value of values.flat()) {
      if (Array.isArray(value)) {
        const nested = firstMetadataText(...value);
        if (nested) return nested;
        continue;
      }
      if (value && typeof value === "object") {
        const nested = firstMetadataText(value.name, value.title, value.value, value.label);
        if (nested) return nested;
        continue;
      }
      const text = cleanRadioText(value);
      if (text) return text;
    }
    return "";
  }

  function firstMetadataYear(...values) {
    for (const value of values.flat()) {
      const text = firstMetadataText(value);
      const match = text.match(/\b(19\d{2}|20\d{2})\b/);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function roonExistingMetadata(zone = {}) {
    const now = zone.now_playing || {};
    const metadata = now.metadata || now.item || {};
    const album = metadata.album || now.album || {};
    const durationMs = now.length ? Number(now.length) * 1000 : null;
    return {
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
      releaseYear: firstMetadataYear(
        now.release_year,
        now.year,
        now.original_release_date,
        now.release_date,
        metadata.release_year,
        metadata.year,
        metadata.original_release_date,
        metadata.release_date,
        album.release_year,
        album.year,
        album.original_release_date,
        album.release_date
      ),
      releaseDate: firstMetadataText(
        now.original_release_date,
        now.release_date,
        metadata.original_release_date,
        metadata.release_date,
        album.original_release_date,
        album.release_date
      ),
      label: firstMetadataText(
        now.label,
        now.record_label,
        metadata.label,
        metadata.record_label,
        album.label,
        album.record_label
      ),
      genre: firstMetadataText(
        now.genre,
        now.genres,
        metadata.genre,
        metadata.genres,
        album.genre,
        album.genres
      )
    };
  }

  function metadataLookupTrackFromZone(zone = {}) {
    const now = zone.now_playing || {};
    const radioLookup = now.radio_lookup;
    const memoryTrack = radioLookup ? {} : (zone.memoryTrack || {});
    const memoryTidal = memoryTrack.tidal || {};
    if (radioLookup?.catalogEnrichmentAllowed === false) return null;

    const base = radioLookup?.artist && radioLookup?.title
      ? radioLookup
      : summarizeZoneTrack(zone);
    if (!base?.artist || !base?.title) return null;

    const existing = roonExistingMetadata(zone);
    const memoryReleaseYear = firstMetadataYear(
      memoryTrack.releaseYear,
      memoryTrack.year,
      memoryTrack.releaseDate,
      memoryTidal.releaseYear,
      memoryTidal.year,
      memoryTidal.releaseDate
    );
    const memoryReleaseDate = firstMetadataText(
      memoryTrack.releaseDate,
      memoryTidal.releaseDate
    );
    const memoryLabel = firstMetadataText(
      memoryTrack.label,
      memoryTidal.label
    );
    const memoryGenre = firstMetadataText(
      memoryTrack.genre,
      memoryTrack.genres,
      memoryTidal.genre,
      memoryTidal.genres
    );
    const memoryDurationMs = Number(memoryTrack.durationMs || memoryTidal.durationMs || 0);
    const tidalId = cleanRadioText(
      base.tidalId ||
      base.tidalTrackId ||
      now.tidal_id ||
      now.tidalId ||
      now.metadata?.tidal_id ||
      now.metadata?.tidalId ||
      memoryTrack.tidalId ||
      memoryTrack.tidal_id ||
      memoryTrack.tidalTrackId ||
      memoryTidal.id ||
      memoryTidal.tidalId ||
      memoryTidal.trackId ||
      ""
    );
    const isrc = cleanRadioText(
      base.isrc ||
      now.isrc ||
      now.metadata?.isrc ||
      memoryTrack.isrc ||
      memoryTidal.isrc ||
      ""
    );
    const identityFields = {
      ...(tidalId ? { tidalId } : {}),
      ...(isrc ? { isrc } : {}),
      ...(cleanRadioText(base.roonIdentity || now.item_key || now.itemKey || "") ? { roonIdentity: cleanRadioText(base.roonIdentity || now.item_key || now.itemKey || "") } : {})
    };
    return {
      artist: cleanRadioText(base.artist),
      title: cleanRadioText(base.title),
      album: cleanRadioText(base.album || now.three_line?.line3 || memoryTrack.album || memoryTidal.album || ""),
      ...identityFields,
      durationMs: existing.durationMs || (Number.isFinite(memoryDurationMs) && memoryDurationMs > 0 ? memoryDurationMs : null),
      releaseYear: existing.releaseYear || memoryReleaseYear,
      releaseDate: existing.releaseDate || memoryReleaseDate,
      label: existing.label || memoryLabel,
      genre: existing.genre || memoryGenre,
      isRadio: Boolean(radioLookup)
    };
  }

  function needsMetadataEnrichment(track = {}) {
    if (!track?.artist || !track?.title) return false;
    const beatport = track.metadataEnrichment?.beatport || {};
    const hasBeatportGenre = Boolean(beatport.genre || beatport.subGenre);
    return !track.durationMs || !track.releaseYear || !track.label || !track.genre || !hasBeatportGenre;
  }

  function attachMetadataEnrichment(state = {}) {
    if (!config.metadataEnrichment.enabled) return state;
    return {
      ...state,
      zones: (state.zones || []).map((zone) => {
        const lookup = metadataLookupTrackFromZone(zone);
        const cached = lookup ? metadataEnrichment.displayableCachedEntry(lookup) : null;
        if (!cached) return zone;
        if (metadataEnrichment.shouldBridgeCachedArtwork(cached)) {
          metadataEnrichment.bridgeCachedArtwork(lookup, cached)
            .then((updated) => {
              if (updated?.imageUrl && updated.imageUrl !== cached.imageUrl) scheduleBroadcast();
            })
            .catch(() => {});
        }
        return {
          ...zone,
          now_playing: {
            ...(zone.now_playing || {}),
            metadata_enrichment: cached
          }
        };
      })
    };
  }

  function scheduleMetadataEnrichment(state = {}) {
    for (const zone of state.zones || []) {
      const lookup = metadataLookupTrackFromZone(zone);
      if (lookup) {
        Promise.resolve(onLiveTrackObserved?.(lookup)).catch(() => {
          // Live sonic-source bookkeeping must never affect playback state.
        });
      }
    }
    if (!config.metadataEnrichment.enabled) return;
    for (const zone of state.zones || []) {
      const lookup = metadataLookupTrackFromZone(zone);
      if (!lookup || !needsMetadataEnrichment(lookup) || !metadataEnrichment.shouldLookup(lookup)) continue;
      metadataEnrichment.enrich(lookup)
        .then((entry) => {
          if (entry?.status === "found" && Number(entry.confidence || 0) >= metadataEnrichment.minConfidence) scheduleBroadcast();
        })
        .catch(() => {
          // The service records misses internally; playback state should stay uninterrupted.
        });
    }
  }

  return {
    attachMetadataEnrichment,
    firstMetadataText,
    firstMetadataYear,
    metadataLookupTrackFromZone,
    needsMetadataEnrichment,
    roonExistingMetadata,
    scheduleMetadataEnrichment
  };
}

module.exports = {
  createCurrentTrackMetadataEnrichment
};
