"use strict";

// Additive evidence only. None of these fields select a playback identity or
// populate the legacy release_id column / Database grouping keys.
const { createHash } = require("node:crypto");
const text = value => value == null ? "" : String(value).trim();
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const refs = (resource, name) => {
  const data = resource?.relationships?.[name]?.data;
  return Array.isArray(data) ? data : data ? [data] : [];
};
const attributes = resource => ({ ...resource, ...resource?.attributes });

function captureTidalEvidence(track = {}, album = {}, document = {}) {
  const included = document.included || [];
  const resolve = reference => included.find(item => item.type === reference.type && text(item.id) === text(reference.id));
  const credits = resource => {
    if (Array.isArray(resource.artists)) return resource.artists.map(artist => ({ provider: "tidal", id: text(artist.id), name: text(artist.name), role: artist.role || null }));
    return refs(resource, "artists").map(reference => {
      const artist = attributes(resolve(reference) || {});
      return { provider: "tidal", id: text(reference.id), name: text(artist.name), role: reference.meta?.role || null };
    });
  };
  const trackData = attributes(track), releaseData = attributes(album);
  const albumReferences = [...refs(track, "albums"), ...refs(track, "album")];
  const releaseIds = [...new Set([...albumReferences.map(ref => text(ref.id)), text(album.id)].filter(Boolean))];
  const relevant = new Map();
  for (const resource of [track, album]) for (const name of ["artists", "coverArt", "albums", "album"]) {
    for (const reference of refs(resource, name)) {
      const item = resolve(reference);
      if (item) relevant.set(`${item.type}:${item.id}`, item);
    }
  }
  return {
    schemaVersion: 1, provider: "tidal", objectKind: "track", providerTrackId: text(track.id),
    originalTitle: text(trackData.title), originalVersion: text(trackData.version),
    trackCredits: credits(track), releaseIds,
    release: {
      id: text(album.id), title: text(releaseData.title), type: text(releaseData.albumType || album.attributes?.type),
      credits: credits(album), edition: text(releaseData.version),
      releaseDate: text(releaseData.releaseDate), originalReleaseDate: text(releaseData.originalReleaseDate),
      upc: text(releaseData.barcodeId || releaseData.upc), catalogNumber: text(releaseData.catalogNumber),
      label: releaseData.label || null, trackCount: positive(releaseData.numberOfItems || releaseData.numberOfTracks || releaseData.trackCount),
      volumeCount: positive(releaseData.numberOfVolumes), territory: text(releaseData.countryCode), format: text(releaseData.format)
    },
    membership: { state: "OBSERVED", disc: positive(trackData.volumeNumber || trackData.discNumber), position: positive(trackData.trackNumber), sequence: positive(trackData.trackNumber) },
    ambiguities: releaseIds.length > 1 ? ["multiple-provider-release-references"] : [],
    raw: { track, selectedAlbum: album, included: [...relevant.values()] }
  };
}

function captureProviderEvidence(provider, result = {}) {
  if (Array.isArray(result.sourceEvidence) && result.sourceEvidence.length) return result.sourceEvidence;
  if (!["tidal", "beatport", "musicbrainz", "discogs"].includes(provider)) return [];
  const raw = result.rawJson || result.raw || {};
  const release = result.providerRelease || raw.release || (typeof result.album === "object" ? result.album : {});
  const recordingId = provider === "musicbrainz" ? text(result.recordingId || result.musicBrainzId) : "";
  const providerTrackId = ["tidal", "beatport"].includes(provider) ? text(result.id || result.trackId) : "";
  return [{
    schemaVersion: 1, provider,
    objectKind: provider === "musicbrainz" ? "recording" : provider === "discogs" ? "release-appearance-claim" : "track",
    providerTrackId, recordingId,
    sourceObjectId: provider === "discogs" ? text(result.discogsId || result.releaseId) : recordingId || providerTrackId,
    originalTitle: text(result.title), originalVersion: text(result.mixName || result.mixVersion || result.version),
    trackCredits: result.artists || raw.artists || [],
    release: {
      id: text(result.releaseId || release.id), title: text(result.releaseTitle || (typeof result.album === "string" ? result.album : "") || release.title || release.name),
      type: text(release.releaseType || release.type), credits: release.artists || [],
      edition: text(release.version), releaseDate: text(result.releaseDate || release.date),
      originalReleaseDate: text(result.originalReleaseDate || release.originalReleaseDate),
      label: result.label || release.label || null, catalogNumber: text(result.catalogNumber || raw.catalog_number),
      upc: text(result.upc || release.upc), trackCount: positive(release.trackCount || release.track_count)
    },
    membership: { state: "UNRESOLVED", disc: result.discNumber || null, position: result.trackPosition || null },
    raw
  }];
}

function combineSourceEvidence(...entries) {
  const byHash = new Map();
  for (const entry of entries.filter(Boolean)) for (const evidence of entry.sourceEvidence || []) {
    const key = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    if (!byHash.has(key)) byHash.set(key, evidence);
  }
  return [...byHash.values()];
}

module.exports = { captureTidalEvidence, captureProviderEvidence, combineSourceEvidence };
