"use strict";

// Version/review context only. These helpers never resolve provider identity,
// infer audio, or create taste/review/embedding records.
const { classifyVersionText, versionDescriptorFromTitle, normalizeCatalogText, artistCreditSetKey } = require("./catalogIdentityNormalization");
const { artistIdentityKey } = require("./artistIdentity");

const ORIGINAL_ARTIST_BASIS = "original_artist_profile_mismatch";
const REJECTION_BASES = [ORIGINAL_ARTIST_BASIS, "remixer_mismatch", "track_genre_mismatch", "vibe_mismatch", "version_mismatch", "duration_mismatch", "release_mismatch", "explicit_request_mismatch", "catalogue_quality", "insufficient_evidence", "other"];
const ORIGINAL_ARTIST_PENALTY = 2;
const clean = (value, limit = 140) => typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/g, " ").trim().slice(0, limit) : "";
const unique = values => [...new Map(values.filter(Boolean).map(value => [normalizeCatalogText(value), value])).values()];
const names = value => (Array.isArray(value) ? value : value ? [value] : []).map(item => clean(typeof item === "object" ? item?.name : item)).filter(Boolean);

function remixerFromDescriptor(value) {
  const descriptor = clean(value);
  const match = descriptor.match(/^(.*?)\s+(?:(?:extended|radio|club|dub|vocal|instrumental)\s+)*(?:remix|rework)(?:\s+(?:extended|radio|club|dub|vocal|instrumental|mix|edit|version))*$/i)
    || descriptor.match(/^(?:remix|rework)\s+by\s+(.+)$/i);
  const name = clean(match?.[1]).replace(/['’]s$/i, "").trim();
  const meaningful = normalizeCatalogText(name).replace(/\b(?:original|extended|radio|club|dub|vocal|instrumental|mix|remix|rework|edit|version|official|vip|the)\b/g, "").trim();
  return /[\p{L}]/u.test(meaningful) ? name : "";
}

function titleVersion(title) {
  const parsed = versionDescriptorFromTitle(title);
  if (remixerFromDescriptor(parsed.label)) return parsed;
  // The shared identity parser deliberately leaves unbracketed named suffixes
  // conservative. Read a clearly delimited suffix for review context only.
  const suffix = clean(title, 300).split(/\s+[-–—]\s+/).slice(1).pop();
  return remixerFromDescriptor(suffix) ? classifyVersionText(suffix) : parsed;
}

function namedRemixEvidence(track = {}) {
  const descriptors = [
    { source: "title", ...titleVersion(track.title) },
    ...[track.mixVersion, track.mixName, track.version, track.tidal?.version].filter(value => clean(value)).map(value => ({ source: "version", ...classifyVersionText(value) }))
  ].filter(value => value.explicit);
  const named = descriptors.map(value => ({ name: remixerFromDescriptor(value.label), source: value.source })).filter(value => value.name);
  const explicitRemix = descriptors.some(value => /\b(?:remix|rework)\b/i.test(value.label));
  const providerNames = explicitRemix ? unique([...names(track.remixers), ...names(track.tidal?.remixers)]) : [];
  const remixers = unique([...named.map(value => value.name), ...providerNames]).slice(0, 4);
  const namedKeys = new Set(named.map(value => normalizeCatalogText(value.name)));
  const providerCreditConflict = named.length && providerNames.length && artistCreditSetKey(named.map(value => value.name)) !== artistCreditSetKey(providerNames);
  const versionConflict = namedKeys.size > 1 || Boolean(providerCreditConflict) || Boolean(remixers.length && descriptors.some(value => ["original", "live", "acoustic", "mixed", "remaster"].includes(value.kind)));
  return {
    named: explicitRemix && remixers.length > 0,
    remixers,
    version: descriptors.find(value => remixerFromDescriptor(value.label))?.label || descriptors[0]?.label || "",
    versionConflict,
    creditSource: named.length ? "explicit version descriptor" : providerNames.length ? "provider remixer credits" : ""
  };
}

function remixArtistOnlyPolicy(track = {}, score = {}) {
  if (!score.rejected || !Array.isArray(score.rejectionBasis) || !score.rejectionBasis.length || score.rejectionBasis.some(value => value !== ORIGINAL_ARTIST_BASIS)) return null;
  const remix = namedRemixEvidence(track);
  if (!remix.named || remix.versionConflict) return null;
  const admission = track.admissionDiagnostics || {};
  if (admission.hardFail || Object.values(admission).some(value => value?.hard === true && value.passed === false)) return null;
  return {
    rule: "named-remix-original-artist-soft",
    remixers: remix.remixers,
    penalty: ORIGINAL_ARTIST_PENALTY,
    reason: `Named remix by ${remix.remixers.join(" / ")}: original-artist taste mismatch is a weak signal only (-${ORIGINAL_ARTIST_PENALTY} points).`
  };
}

function compactReviewEvidence(track = {}, tasteProfile = {}) {
  const admission = track.admissionDiagnostics || {};
  const breakdown = track.scoreBreakdown || {};
  const remix = namedRemixEvidence(track);
  const directGenres = unique([
    ...names(track.genre), ...names(track.genres), ...names(track.subgenre),
    ...names(track.tidal?.genre), ...names(track.tidal?.genres)
  ]);
  const originalArtistGenres = unique([...names(track.tidal?.artistGenre), ...names(track.tidal?.artistGenres)]);
  const genres = unique([...directGenres, ...names(admission.candidateGenreEvidence?.official).filter(value =>
    !originalArtistGenres.some(genre => normalizeCatalogText(genre) === normalizeCatalogText(value)) || directGenres.some(genre => normalizeCatalogText(genre) === normalizeCatalogText(value))
  )]).slice(0, 5);
  const inference = breakdown.genreInference || {};
  const genreEvidence = (inference.evidence || admission.candidateGenreEvidence?.inferred || [])
    .filter(item => item && !item.queryOnly && !["query", "query-scene", "search query"].includes(item.source))
    .slice(0, 4).map(item => ({ source: clean(item.source, 32), evidence: clean(item.label, 100), genre: clean(item.genre, 60), corroborating: item.corroborating === true }));
  const tasteEntries = Object.values(tasteProfile.artists || {});
  const remixerTaste = remix.remixers.flatMap(name => {
    const key = artistIdentityKey(name);
    const entry = tasteEntries.find(item => item?.name && artistIdentityKey(item.name) === key);
    return entry && Number.isFinite(Number(entry.score)) ? [{ name, score: Number(entry.score) }] : [];
  });
  const sonic = track.recommendationV2 || breakdown.recommendationV2;
  const sonicEvidence = sonic ? {
    available: sonic.available === true,
    applied: sonic.applied === true,
    reason: clean(sonic.reason, 80),
    ...(sonic.available === true && sonic.applied === true ? {
      cluster: clean(sonic.clusterName, 70),
      adjustment_already_in_current_score: Number(sonic.sonicAdjustment) || 0
    } : {})
  } : { available: false, applied: false };
  const duration = admission.durationConstraints;
  return {
    version: remix.version,
    ...(remix.named ? { remix: { remixers: remix.remixers, credit_source: remix.creditSource, version_conflict: remix.versionConflict, taste: remixerTaste } } : {}),
    genres,
    ...(originalArtistGenres.length ? { original_artist_genres: originalArtistGenres.slice(0, 4) } : {}),
    genre_evidence: genreEvidence,
    ...(track.metadataEnrichment ? { enrichment: {
      source: clean(track.metadataEnrichment.source || track.metadataEnrichment.provider, 40),
      genre: clean(track.metadataEnrichment.genre, 80),
      label: clean(track.metadataEnrichment.label, 80),
      release: clean(track.metadataEnrichment.album || track.metadataEnrichment.releaseTitle, 100)
    } } : {}),
    ...(duration ? { duration_constraint: {
      ...duration.constraint,
      passed: duration.passed === true,
      reason: clean(duration.reason, 100)
    } } : {}),
    vibe_evidence: (breakdown.vibeInference?.evidence || []).filter(item => !item.queryOnly).slice(0, 2).map(item => clean(item.label, 90)),
    sonic: sonicEvidence
  };
}

module.exports = { REJECTION_BASES, ORIGINAL_ARTIST_PENALTY, namedRemixEvidence, remixArtistOnlyPolicy, compactReviewEvidence };
