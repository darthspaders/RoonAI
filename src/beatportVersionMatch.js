"use strict";

const {
  normalizeCatalogText,
  splitCreditNames,
  featuredArtistNames,
  stripFeaturedArtistText,
  parseCanonicalCatalogIdentity,
  normalizeAlbumFamily,
  artistCreditSetKey,
  artistCreditKey,
  artistCreditNormalizationRule
} = require("./catalogIdentityNormalization");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return normalizeCatalogText(cleanText(value));
}

function normalizeArtist(value) {
  return normalizeText(value)
    .replace(/\b(?:featuring|feat|ft)\b/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArtistCredits(value) {
  return Array.from(new Set(splitCreditNames(value).map(normalizeText).filter(Boolean)));
}

function artistCreditsMatch(left, right) {
  const expected = normalizeArtistCredits(left);
  const actual = normalizeArtistCredits(right);
  return Boolean(expected.length && actual.length && artistCreditSetKey(expected) === artistCreditSetKey(actual));
}

function artistCreditRelation(left = {}, right = {}) {
  const leftValue = left && typeof left === "object" ? (left.artist || left.artists || "") : left;
  const rightValue = right && typeof right === "object" ? (right.artist || right.artists || "") : right;
  const expected = normalizeArtistCredits(leftValue);
  const actual = normalizeArtistCredits(rightValue);
  const expectedSet = new Set(expected.map(artistCreditKey));
  const actualSet = new Set(actual.map(artistCreditKey));
  const requestedSubset = expectedSet.size > 0 && [...expectedSet].every(name => actualSet.has(name));
  const candidateSubset = actualSet.size > 0 && [...actualSet].every(name => expectedSet.has(name));
  const aliasValues = Array.isArray(left.artistAliases) ? left.artistAliases : [];
  const candidateSet = artistCreditSetKey(actual);
  const aliasVariant = aliasValues
    .map((value) => ({ value, key: artistCreditSetKey(value) }))
    .find((variant) => variant.key && candidateSet === variant.key);
  const aliasApplied = !requestedSubset && Boolean(aliasVariant);
  return {
    type: aliasApplied ? "alias-equivalent"
      : requestedSubset && candidateSubset ? "equivalent-set"
      : requestedSubset ? "requested-artists-subset"
        : candidateSubset ? "candidate-artists-subset" : "conflicting-artist-identity",
    requestedSubset,
    candidateSubset,
    noConflict: requestedSubset || candidateSubset || Boolean(aliasApplied),
    requested: expected,
    candidate: actual,
    artistAliasApplied: Boolean(aliasApplied),
    aliasSource: aliasApplied ? (left.artistAliasSource || "trusted-artist-alias") : "",
    canonicalArtistCredits: expected,
    artistCreditNormalizationRule: aliasApplied
      ? "trusted-artist-alias"
      : artistCreditNormalizationRule(expected, actual),
    providerIdentityEvidence: {
      requestedArtistIds: [left.tidalArtistId, left.beatportArtistId, ...(left.tidalArtistIds || []), ...(left.beatportArtistIds || [])].filter(Boolean).map(String),
      candidateArtistIds: [right.tidalArtistId, right.beatportArtistId, ...(right.tidalArtistIds || []), ...(right.beatportArtistIds || []), ...(right.artistIds || [])].filter(Boolean).map(String),
      matchedBy: aliasApplied ? (left.artistAliasSource || "trusted-artist-alias") : requestedSubset && candidateSubset ? "canonical-credit-set" : "credit-component-overlap"
    }
  };
}

const VERSION_DESCRIPTOR_PATTERN = /\b(?:main\s+mix|main\s+version|extended\s+mix|extended\s+version|club\s+mix|club\s+version|original\s+mix|original\s+version)\b/gi;
const REJECTED_VERSION_PATTERN = /\b(?:radio\s+edit|remix|rework|reimagined|bootleg|flip|vip|live|acoustic|instrumental|dub\s+mix|re-edit|edit)\b/i;

function versionDescriptor(value, explicitMixName = "") {
  const parsed = parseCanonicalCatalogIdentity({ title: value, mixName: explicitMixName });
  return parsed.normalizedVersion;
}

function baseTitle(value, explicitMixName = "") {
  return parseCanonicalCatalogIdentity({ title: value, mixName: explicitMixName }).normalizedBaseTitle;
}

function versionFieldsAgree(track, expectedDescriptor) {
  const titleDescriptor = versionDescriptor(track.title || track.name || "");
  if (titleDescriptor && titleDescriptor !== expectedDescriptor) return false;
  return [track.mixVersion, track.mixName, track.version, track.remix]
    .filter(value => cleanText(value))
    .every(value => versionDescriptor("", value) === expectedDescriptor);
}

function isoDate(value) {
  const text = cleanText(value);
  const match = text.match(/\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
}

function normalizedIsrc(value) {
  return cleanText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function durationDeltaMs(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0 ? Math.abs(a - b) : null;
}

function beatportTitleWithMix(track = {}) {
  return cleanText([track.title, track.mixName].filter(Boolean).join(" "));
}

function yearValue(...values) {
  for (const value of values) {
    const match = String(value ?? "").match(/\b((?:19|20)\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function legacyEraEvidence(track = {}) {
  const releaseEvidence = track.releaseEvidence && typeof track.releaseEvidence === "object" ? track.releaseEvidence : {};
  const candidates = [
    ["supplied-release-year", [track.releaseYear, track.releaseDate, track.year]],
    ["supplied-album-year", [track.albumYear, typeof track.album === "object" ? track.album.year : ""]],
    ["tidal-recording-year", [track.recordingYear, track.originalReleaseYear, releaseEvidence.recordingYear]],
    ["tidal-catalog-year", [track.catalogReleaseYear, releaseEvidence.catalogReleaseYear]],
    ["isrc-year", [track.isrcYear, releaseEvidence.isrcYear]],
    ["beatport-original-release-year", [track.originalReleaseYear, track.recordingYear]],
    ["earliest-trusted-provider-appearance", [track.earliestTrustedProviderYear, track.firstTrustedProviderYear]]
  ];
  for (const [source, values] of candidates) {
    const year = yearValue(...values);
    if (year !== null) return { year, source };
  }
  return { year: null, source: "" };
}

function recordingForm(track = {}, descriptor = "") {
  const text = normalizeText(descriptor || beatportTitleWithMix(track));
  if (/\bradio\b|\bedit\b/.test(text)) return "radio-edit";
  if (/\bremix\b|\brework\b|\bbootleg\b|\bflip\b|\bvip\b/.test(text)) return "remix";
  if (/\bdub\b/.test(text)) return "dub";
  if (/\blive\b/.test(text)) return "live";
  const duration = Number(track.durationMs);
  if (Number.isFinite(duration) && duration >= 8 * 60 * 1000) return "long-form-club";
  if (Number.isFinite(duration) && duration > 0 && duration <= 5 * 60 * 1000) return "short-form";
  return descriptor ? "club-mix" : "unknown";
}

function legacyDiagnostics({ tidalTrack, beatportTrack, tidalArtist, beatportArtist, tidalTitle, beatportTitle,
  tidalFeaturedArtists, beatportFeaturedArtists, tidalDescriptor, beatportDescriptor, isrcMatch, deltaMs,
  canonicalVersionMatch = false, canonicalVersionRelation = "", albumFamilyAgreement = null,
  originalMixNormalizationApplied = false, originalMixNormalizationReason = "",
  strongIdentityOverrideApplied = false, strongIdentityOverrideReason = "", artistRelation = null, reasons }) {
  const tidalRecordingYear = yearValue(tidalTrack.recordingYear, tidalTrack.originalReleaseYear, tidalTrack.year, tidalTrack.releaseDate);
  const beatportRecordingYear = yearValue(beatportTrack.recordingYear, beatportTrack.originalReleaseYear, beatportTrack.year, beatportTrack.releaseDate);
  const tidalCatalogReleaseYear = yearValue(tidalTrack.catalogReleaseYear, tidalTrack.releaseYear, tidalTrack.releaseDate, tidalTrack.year);
  const beatportCatalogReleaseYear = yearValue(beatportTrack.catalogReleaseYear, beatportTrack.releaseYear, beatportTrack.releaseDate, beatportTrack.year);
  const eraDistance = tidalRecordingYear !== null && beatportRecordingYear !== null
    ? Math.abs(tidalRecordingYear - beatportRecordingYear) : null;
  const durationFormRelation = deltaMs === null ? "unknown"
    : deltaMs <= 5000 ? "same-form"
      : Math.max(Number(tidalTrack.durationMs) || 0, Number(beatportTrack.durationMs) || 0)
          / Math.max(1, Math.min(Number(tidalTrack.durationMs) || 0, Number(beatportTrack.durationMs) || 0)) >= 1.5
        ? "different-form" : "compatible-form";
  const tidalAlbumFamily = normalizeAlbumFamily(tidalTrack.album || tidalTrack.releaseTitle || "");
  const beatportAlbumFamily = normalizeAlbumFamily(beatportTrack.album || beatportTrack.releaseTitle || "");
  const expectedEra = legacyEraEvidence(tidalTrack);
  const candidateEra = legacyEraEvidence(beatportTrack);
  return {
    normalizedArtistKey: { tidal: tidalArtist, beatport: beatportArtist },
    normalizedBaseTitle: { tidal: tidalTitle, beatport: beatportTitle },
    normalizedFeaturedArtists: { tidal: tidalFeaturedArtists, beatport: beatportFeaturedArtists },
    requestedVersion: tidalDescriptor,
    candidateVersion: beatportDescriptor,
    canonicalVersionRelation: canonicalVersionMatch ? "same-version"
      : canonicalVersionRelation || (tidalDescriptor === beatportDescriptor ? "same-version"
        : !tidalDescriptor && beatportDescriptor === "original mix" ? "base-title-with-version-proxy"
          : "descriptor-difference"),
    recordingForm: { tidal: recordingForm(tidalTrack, tidalDescriptor), beatport: recordingForm(beatportTrack, beatportDescriptor) },
    recordingYear: { tidal: tidalRecordingYear, beatport: beatportRecordingYear },
    catalogReleaseYear: { tidal: tidalCatalogReleaseYear, beatport: beatportCatalogReleaseYear },
    reissueYear: { tidal: yearValue(tidalTrack.reissueYear, tidalTrack.reissueDate), beatport: yearValue(beatportTrack.reissueYear, beatportTrack.reissueDate) },
    eraDistance,
    durationDeltaMs: deltaMs,
    durationFormRelation,
    isrcAgreement: isrcMatch,
    normalizedAlbumFamily: { tidal: tidalAlbumFamily, beatport: beatportAlbumFamily },
    albumFamilyAgreement,
    originalMixNormalizationApplied,
    originalMixNormalizationReason,
    expectedLegacyEra: expectedEra.year,
    expectedLegacyEraSource: expectedEra.source,
    candidateEra: candidateEra.year,
    candidateEraSource: candidateEra.source,
    artistAliasApplied: Boolean(artistRelation?.artistAliasApplied),
    aliasSource: artistRelation?.aliasSource || "",
    canonicalArtistCredits: artistRelation?.canonicalArtistCredits || [],
    artistCreditNormalizationRule: artistRelation?.artistCreditNormalizationRule || "",
    providerIdentityEvidence: artistRelation?.providerIdentityEvidence || null,
    strongIdentityOverrideApplied,
    strongIdentityOverrideReason,
    canonicalGroupId: null,
    canonicalGroupType: null,
    why: reasons[0] || (isrcMatch ? "exact-identity-evidence" : "version-proxy-evidence")
  };
}

function matchBeatportVersionToTidal(tidalTrack = {}, beatportTrack = {}, {
  allowVersionProxy = true,
  requestedBeatportTrackId = ""
} = {}) {
  const tidalIdentity = parseCanonicalCatalogIdentity(tidalTrack);
  const beatportIdentity = parseCanonicalCatalogIdentity(beatportTrack);
  const tidalArtist = normalizeArtist(tidalTrack.artist);
  const beatportArtist = normalizeArtist(beatportTrack.artist);
  const tidalArtistCredits = normalizeArtistCredits(tidalTrack.artist);
  const beatportArtistCredits = normalizeArtistCredits(beatportTrack.artist);
  const tidalTitle = tidalIdentity.normalizedBaseTitle;
  const beatportTitle = beatportIdentity.normalizedBaseTitle;
  const tidalFeaturedArtists = tidalIdentity.normalizedFeaturedArtists;
  const beatportFeaturedArtists = beatportIdentity.normalizedFeaturedArtists;
  const beatportDescriptor = beatportIdentity.normalizedVersion;
  const tidalDescriptor = tidalIdentity.normalizedVersion;
  const exactArtistSetMatch = artistCreditsMatch(tidalTrack.artist, beatportTrack.artist);
  const artistRelation = artistCreditRelation(tidalTrack, beatportTrack);
  const artistMatch = exactArtistSetMatch || ["alias-equivalent", "equivalent-set", "reordered-equivalent"].includes(artistRelation.type);
  const artistMatchMethod = artistRelation.artistAliasApplied ? "trusted-artist-alias"
    : artistMatch && tidalArtist === beatportArtist ? "normalized-text"
      : artistMatch ? "normalized-credit-set" : "none";
  const titleMatch = Boolean(tidalTitle && beatportTitle && tidalTitle === beatportTitle);
  const labelMatch = Boolean(
    normalizeText(tidalTrack.label) &&
    normalizeText(beatportTrack.label) &&
    normalizeText(tidalTrack.label) === normalizeText(beatportTrack.label)
  );
  const releaseDateMatch = Boolean(
    isoDate(tidalTrack.releaseDate || tidalTrack.year) &&
    isoDate(beatportTrack.releaseDate || beatportTrack.year) &&
    isoDate(tidalTrack.releaseDate || tidalTrack.year) === isoDate(beatportTrack.releaseDate || beatportTrack.year)
  );
  const tidalIsrc = normalizedIsrc(tidalTrack.isrc);
  const beatportIsrc = normalizedIsrc(beatportTrack.isrc);
  const isrcMatch = Boolean(tidalIsrc && beatportIsrc && tidalIsrc === beatportIsrc);
  const expectedBeatportTrackId = cleanText(
    requestedBeatportTrackId ||
    tidalTrack.beatportTrackId ||
    tidalTrack.beatportId ||
    tidalTrack.beatport?.id
  );
  const beatportTrackId = cleanText(beatportTrack.id || beatportTrack.trackId || beatportTrack.beatportTrackId);
  const beatportTrackIdMatch = expectedBeatportTrackId
    ? Boolean(beatportTrackId && expectedBeatportTrackId === beatportTrackId)
    : null;
  const tidalEraEvidence = legacyEraEvidence(tidalTrack);
  const beatportEraEvidence = legacyEraEvidence(beatportTrack);
  const sameEra = tidalEraEvidence.year !== null && beatportEraEvidence.year !== null
    && Math.abs(tidalEraEvidence.year - beatportEraEvidence.year) <= 1;
  const deltaMs = durationDeltaMs(tidalTrack.durationMs, beatportTrack.durationMs);
  const tidalForm = recordingForm(tidalTrack, tidalDescriptor);
  const beatportForm = recordingForm(beatportTrack, beatportDescriptor);
  const durationFormRelation = deltaMs === null ? "unknown"
    : deltaMs <= 5000 ? "same-form"
      : tidalForm !== beatportForm && ((tidalForm === "long-form-club" && beatportForm === "short-form")
        || (tidalForm === "short-form" && beatportForm === "long-form-club")) ? "different-form" : "compatible-form";
  const durationFormCompatible = ["same-form", "compatible-form"].includes(durationFormRelation);
  const expectedVersionKind = tidalIdentity.versionKind;
  const candidateVersionKind = beatportIdentity.versionKind;
  const canonicalVersionMatch = Boolean(
    expectedVersionKind !== "none" && candidateVersionKind !== "none"
      && expectedVersionKind === candidateVersionKind
      && tidalIdentity.version.semantic === beatportIdentity.version.semantic
  );
  // A named remix can be the exact requested recording, but never a proxy for
  // an original or another remix. Keep every descriptor word (including edit /
  // extended) and require independent recording evidence and the same duration
  // form before making an exception to the non-proxy descriptor guard.
  const exactRemixIdentity = Boolean(
    expectedVersionKind === "remix" && candidateVersionKind === "remix"
      && tidalIdentity.version.semantic
      && tidalDescriptor === beatportDescriptor
      && versionFieldsAgree(tidalTrack, tidalDescriptor)
      && versionFieldsAgree(beatportTrack, beatportDescriptor)
      && isrcMatch && deltaMs !== null && deltaMs <= 5000
  );
  const originalEquivalent = (expectedVersionKind === "original" && candidateVersionKind === "none")
    || (expectedVersionKind === "none" && candidateVersionKind === "original");
  const strongOriginalEquivalence = originalEquivalent && titleMatch && durationFormCompatible && deltaMs !== null && deltaMs <= 5000
    && (isrcMatch || labelMatch || releaseDateMatch);
  const strongPlainEquivalence = tidalIdentity.versionKind === "none"
    && beatportIdentity.versionKind === "none"
    && titleMatch
    && durationFormCompatible
    && deltaMs !== null
    && deltaMs <= 5000
    && (isrcMatch || labelMatch || releaseDateMatch || sameEra);
  const explicitTrackIdEvidence = Boolean(expectedBeatportTrackId && beatportTrackIdMatch && artistMatch && titleMatch
    && beatportIdentity.versionKind === tidalIdentity.versionKind
    && !REJECTED_VERSION_PATTERN.test(beatportTitleWithMix(beatportTrack)));
  const strongIdentityOverrideApplied = !artistMatch && artistRelation.noConflict && isrcMatch && titleMatch
    && deltaMs !== null && deltaMs <= 5000 && durationFormCompatible;
  const strongIdentityOverrideReason = strongIdentityOverrideApplied
    ? "exact-isrc-base-title-duration-form-overrides-artist-credit-layout" : "";
  const reasons = [];
  const warnings = [];
  const legacyIdentity = () => legacyDiagnostics({
    tidalTrack,
    beatportTrack,
    tidalArtist,
    beatportArtist,
    tidalTitle,
    beatportTitle,
    tidalFeaturedArtists,
    beatportFeaturedArtists,
    tidalDescriptor,
    beatportDescriptor,
    isrcMatch,
    deltaMs,
    canonicalVersionMatch,
    canonicalVersionRelation: strongOriginalEquivalence ? "ORIGINAL_EQUIVALENT_TO_UNLABELED"
      : originalMixCatalogEquivalence ? "ORIGINAL_MIX_CATALOG_EQUIVALENT_TO_UNLABELED" : "",
    albumFamilyAgreement,
    originalMixNormalizationApplied: originalMixCatalogEquivalence,
    originalMixNormalizationReason: originalMixCatalogEquivalence ? "album-family-and-original-era-agree" : "",
    strongIdentityOverrideApplied,
    strongIdentityOverrideReason,
    artistRelation,
    reasons
  });

  if (!artistMatch && !strongIdentityOverrideApplied) reasons.push("artist credits do not match exactly");
  if (!titleMatch) reasons.push("base titles do not match");
  if (expectedBeatportTrackId && beatportTrackIdMatch === false) {
    reasons.push("Beatport track ID does not match the requested candidate");
  } else if (expectedBeatportTrackId && !beatportTrackId) {
    reasons.push("Beatport track ID was not returned for the requested candidate");
  }
  const rejectedCandidateDescriptor = REJECTED_VERSION_PATTERN.test(beatportTitleWithMix(beatportTrack));
  if (rejectedCandidateDescriptor && !exactRemixIdentity) {
    reasons.push("Beatport version contains a non-proxy edit/remix descriptor");
  }
  if (expectedVersionKind === "remix" && !exactRemixIdentity && !rejectedCandidateDescriptor) {
    reasons.push("requested remix version does not match the Beatport candidate exactly");
  }
  const albumFamilyAgreement = Boolean(
    tidalIdentity.normalizedAlbumFamily && beatportIdentity.normalizedAlbumFamily
      && tidalIdentity.normalizedAlbumFamily === beatportIdentity.normalizedAlbumFamily
  );
  const originalMixCatalogEquivalence = originalEquivalent
    && artistMatch
    && titleMatch
    && albumFamilyAgreement
    && sameEra
    && (deltaMs === null || (durationFormCompatible && deltaMs <= 5000))
    && !REJECTED_VERSION_PATTERN.test(beatportTitleWithMix(beatportTrack));
  const sameCanonicalVersionEvidence = canonicalVersionMatch && (labelMatch || releaseDateMatch)
    && deltaMs !== null && deltaMs <= 30_000;
  const exactEvidence = isrcMatch || sameCanonicalVersionEvidence || strongOriginalEquivalence
    || originalMixCatalogEquivalence || strongPlainEquivalence || explicitTrackIdEvidence;
  const artistEvidence = artistMatch || strongIdentityOverrideApplied;
  if (artistEvidence && titleMatch && exactEvidence && !reasons.length) {
    return {
      matched: true,
        relation: strongOriginalEquivalence || originalMixCatalogEquivalence || strongIdentityOverrideApplied ? "equivalent-recording" : "exact",
      confidence: "exact",
      score: 1,
      reasons: [
        isrcMatch ? "artist, canonical title, and ISRC match" : "artist, canonical title, version, release, and duration match",
        ...(beatportTrackIdMatch ? [`Beatport track ID ${beatportTrackId} resolved`] : [])
      ],
      warnings,
      diagnostics: {
        artistMatch,
        artistCreditRelation: artistRelation,
        strongIdentityOverrideApplied,
        strongIdentityOverrideReason,
        artistMatchMethod,
        tidalArtistCredits,
        beatportArtistCredits,
        artistAliasApplied: Boolean(artistRelation.artistAliasApplied),
        aliasSource: artistRelation.aliasSource || "",
        canonicalArtistCredits: artistRelation.canonicalArtistCredits || [],
        artistCreditNormalizationRule: artistRelation.artistCreditNormalizationRule || "",
        providerIdentityEvidence: artistRelation.providerIdentityEvidence || null,
        titleMatch,
        labelMatch,
        releaseDateMatch,
        isrcMatch,
        expectedBeatportTrackId,
        beatportTrackId,
        beatportTrackIdMatch,
        tidalDescriptor,
        beatportDescriptor,
        durationDeltaMs: deltaMs,
        canonicalVersionMatch,
        exactRemixIdentity,
        originalMixNormalizationApplied: originalMixCatalogEquivalence,
        originalMixNormalizationReason: originalMixCatalogEquivalence ? "album-family-and-original-era-agree" : "",
        canonicalVersionRelation: strongOriginalEquivalence ? "ORIGINAL_EQUIVALENT_TO_UNLABELED"
          : originalMixCatalogEquivalence ? "ORIGINAL_MIX_CATALOG_EQUIVALENT_TO_UNLABELED"
            : strongPlainEquivalence ? "PLAIN_SAME_FORM"
            : canonicalVersionMatch ? "same-version" : "",
        normalizedBaseTitle: { tidal: tidalTitle, beatport: beatportTitle },
        normalizedAlbumFamily: { tidal: tidalIdentity.normalizedAlbumFamily, beatport: beatportIdentity.normalizedAlbumFamily },
        albumFamilyAgreement,
        legacyIdentityDiagnostics: legacyDiagnostics({
          tidalTrack,
          beatportTrack,
          tidalArtist,
          beatportArtist,
          tidalTitle,
          beatportTitle,
          tidalFeaturedArtists,
          beatportFeaturedArtists,
          tidalDescriptor,
          beatportDescriptor,
          isrcMatch,
          deltaMs,
          canonicalVersionMatch,
          canonicalVersionRelation: strongOriginalEquivalence ? "ORIGINAL_EQUIVALENT_TO_UNLABELED"
            : originalMixCatalogEquivalence ? "ORIGINAL_MIX_CATALOG_EQUIVALENT_TO_UNLABELED" : "",
          albumFamilyAgreement,
          originalMixNormalizationApplied: originalMixCatalogEquivalence,
          originalMixNormalizationReason: originalMixCatalogEquivalence ? "album-family-and-original-era-agree" : "",
          strongIdentityOverrideApplied,
          strongIdentityOverrideReason,
          artistRelation,
          reasons
        })
      }
    };
  }

  const releaseEvidence = labelMatch || releaseDateMatch;
  const proxyDescriptor = ["extended", "original"].includes(beatportIdentity.versionKind)
    || beatportIdentity.versionKind === "alternate" && /\b(?:club|main)\b/.test(beatportDescriptor);
  const targetIsShortForm = tidalIdentity.versionKind === "none";
  if (allowVersionProxy && artistMatch && titleMatch && proxyDescriptor && targetIsShortForm && releaseEvidence && !reasons.length) {
    if (tidalIsrc && beatportIsrc && !isrcMatch) warnings.push("ISRC differs; this is a version proxy, not recording identity");
    if (deltaMs !== null && deltaMs > 30_000) warnings.push("durations differ materially; only the preview texture is being transferred");
    return {
      matched: true,
      relation: "version-proxy",
      confidence: labelMatch && releaseDateMatch ? "high" : "medium",
      score: labelMatch && releaseDateMatch ? 0.94 : 0.88,
      reasons: [
        artistMatchMethod === "normalized-credit-set" ? "artist credits match after punctuation/duplicate-credit normalization" : "artist credits match",
        "base titles match",
        `Beatport supplies ${beatportDescriptor}`,
        labelMatch ? "label matches" : "release date matches",
        ...(beatportTrackIdMatch ? [`Beatport track ID ${beatportTrackId} resolved`] : [])
      ],
      warnings,
      diagnostics: {
        artistMatch,
        artistCreditRelation: artistRelation,
        artistAliasApplied: Boolean(artistRelation.artistAliasApplied),
        aliasSource: artistRelation.aliasSource || "",
        canonicalArtistCredits: artistRelation.canonicalArtistCredits || [],
        artistCreditNormalizationRule: artistRelation.artistCreditNormalizationRule || "",
        providerIdentityEvidence: artistRelation.providerIdentityEvidence || null,
        artistMatchMethod,
        tidalArtistCredits,
        beatportArtistCredits,
        titleMatch,
        labelMatch,
        releaseDateMatch,
        isrcMatch,
        expectedBeatportTrackId,
        beatportTrackId,
        beatportTrackIdMatch,
        tidalDescriptor,
        beatportDescriptor,
        durationDeltaMs: deltaMs,
        originalMixNormalizationApplied: false,
        originalMixNormalizationReason: "",
        normalizedBaseTitle: { tidal: tidalTitle, beatport: beatportTitle },
        normalizedAlbumFamily: { tidal: tidalIdentity.normalizedAlbumFamily, beatport: beatportIdentity.normalizedAlbumFamily },
        albumFamilyAgreement,
        strongIdentityOverrideApplied: false,
        strongIdentityOverrideReason: "",
        legacyIdentityDiagnostics: legacyIdentity()
      }
    };
  }

  if (!reasons.length) reasons.push("no safe exact or version-proxy relationship was established");
  return {
    matched: false,
    relation: "rejected",
    confidence: "none",
    score: 0,
    reasons,
    warnings,
    diagnostics: {
      artistMatch,
      artistCreditRelation: artistRelation,
      artistAliasApplied: Boolean(artistRelation.artistAliasApplied),
      aliasSource: artistRelation.aliasSource || "",
      canonicalArtistCredits: artistRelation.canonicalArtistCredits || [],
      artistCreditNormalizationRule: artistRelation.artistCreditNormalizationRule || "",
      providerIdentityEvidence: artistRelation.providerIdentityEvidence || null,
      strongIdentityOverrideApplied,
      strongIdentityOverrideReason,
      artistMatchMethod,
      tidalArtistCredits,
      beatportArtistCredits,
      titleMatch,
      labelMatch,
      releaseDateMatch,
      isrcMatch,
      expectedBeatportTrackId,
      beatportTrackId,
      beatportTrackIdMatch,
      tidalDescriptor,
      beatportDescriptor,
      durationDeltaMs: deltaMs,
      exactRemixIdentity,
      originalMixNormalizationApplied: false,
      originalMixNormalizationReason: "",
      normalizedBaseTitle: { tidal: tidalTitle, beatport: beatportTitle },
      normalizedAlbumFamily: { tidal: tidalIdentity.normalizedAlbumFamily, beatport: beatportIdentity.normalizedAlbumFamily },
      albumFamilyAgreement,
      legacyIdentityDiagnostics: legacyIdentity()
    }
  };
}

function beatportCandidateRanking(tidalTrack = {}, beatportTrack = {}, options = {}) {
  const match = matchBeatportVersionToTidal(tidalTrack, beatportTrack, options);
  const tidalIdentity = parseCanonicalCatalogIdentity(tidalTrack);
  const beatportIdentity = parseCanonicalCatalogIdentity(beatportTrack);
  const requestedId = cleanText(options.requestedBeatportTrackId || tidalTrack.beatportTrackId || tidalTrack.beatportId || tidalTrack.beatport?.id);
  const candidateId = cleanText(beatportTrack.id || beatportTrack.trackId || beatportTrack.beatportTrackId);
  const titleMatch = tidalIdentity.normalizedBaseTitle && tidalIdentity.normalizedBaseTitle === beatportIdentity.normalizedBaseTitle;
  const relation = artistCreditRelation(tidalTrack, beatportTrack);
  const rejectedDescriptor = !(match.matched && match.diagnostics?.exactRemixIdentity)
    && /\b(?:remix|rework|bootleg|reconstructed|reconstruction|radio\s+edit|edit|vip|flip)\b/i.test(beatportTitleWithMix(beatportTrack));
  const tidalDuration = Number(tidalTrack.durationMs || 0);
  const beatportDuration = Number(beatportTrack.durationMs || 0);
  const durationDelta = tidalDuration > 0 && beatportDuration > 0 ? Math.abs(tidalDuration - beatportDuration) : null;
  const requestedEra = legacyEraEvidence(tidalTrack).year;
  const candidateEra = legacyEraEvidence(beatportTrack).year;
  const eraDistance = requestedEra !== null && candidateEra !== null ? Math.abs(requestedEra - candidateEra) : null;
  const albumMatch = Boolean(tidalIdentity.normalizedAlbumFamily && beatportIdentity.normalizedAlbumFamily
    && tidalIdentity.normalizedAlbumFamily === beatportIdentity.normalizedAlbumFamily);
  const isrcMatch = Boolean(normalizedIsrc(tidalTrack.isrc) && normalizedIsrc(tidalTrack.isrc) === normalizedIsrc(beatportTrack.isrc));
  const idMatch = Boolean(requestedId && candidateId && requestedId === candidateId);
  const explicitReject = Boolean(match.reasons?.some(reason => /non-proxy|track id does not match|artist credits do not match|base titles do not match/i.test(reason)));
  let score = match.matched ? Number(match.score || 0) * 1000 : 0;
  if (idMatch) score += 100000;
  if (isrcMatch) score += 50000;
  if (relation.noConflict) score += relation.artistAliasApplied ? 6500 : 8000;
  if (titleMatch) score += 7000;
  if (albumMatch) score += 3000;
  if (match.diagnostics?.canonicalVersionMatch) score += 2500;
  if (beatportIdentity.versionKind === "none" || beatportIdentity.versionKind === "original") score += 1800;
  if (durationDelta !== null) score += durationDelta <= 5000 ? 1800 : durationDelta <= 30000 ? 600 : -Math.min(2400, Math.round(durationDelta / 10000) * 100);
  if (eraDistance !== null) score += eraDistance <= 3 ? 900 : eraDistance <= 10 ? 300 : -Math.min(1800, eraDistance * 30);
  if (rejectedDescriptor) score -= 60000;
  if (explicitReject) score -= 25000;
  return {
    candidate: beatportTrack,
    match,
    score,
    safe: Boolean(match.matched),
    titleMatch,
    albumMatch,
    isrcMatch,
    beatportTrackIdMatch: idMatch,
    rejectedDescriptor,
    eraDistance,
    reasons: [
      ...(idMatch ? ["beatport-id-match"] : []),
      ...(isrcMatch ? ["isrc-match"] : []),
      ...(relation.noConflict ? [relation.artistAliasApplied ? "trusted-artist-alias" : "canonical-artist-set"] : []),
      ...(titleMatch ? ["base-title-match"] : []),
      ...(albumMatch ? ["album-family-match"] : []),
      ...(beatportIdentity.versionKind === "none" || beatportIdentity.versionKind === "original" ? ["original-or-plain-version"] : []),
      ...(rejectedDescriptor ? ["unsafe-remix-or-edit-descriptor"] : []),
      ...(eraDistance !== null && eraDistance <= 3 ? ["original-era-match"] : [])
    ]
  };
}

function rankBeatportCandidates(tidalTrack = {}, candidates = [], options = {}) {
  const evaluated = (Array.isArray(candidates) ? candidates : [])
    .filter(Boolean)
    .map(candidate => beatportCandidateRanking(tidalTrack, candidate, options))
    .sort((left, right) => right.score - left.score || String(left.candidate.id || "").localeCompare(String(right.candidate.id || "")));
  const safe = evaluated.filter(item => item.safe);
  return {
    best: safe[0]?.candidate || null,
    evaluated,
    safeCount: safe.length,
    selectedSafe: Boolean(safe[0]),
    selectionReasons: safe[0]?.reasons || []
  };
}

module.exports = {
  baseTitle,
  beatportTitleWithMix,
  matchBeatportVersionToTidal,
  normalizeArtist,
  normalizeArtistCredits,
  artistCreditRelation,
  beatportCandidateRanking,
  rankBeatportCandidates,
  normalizeText,
  versionDescriptor,
  parseCanonicalCatalogIdentity
};
