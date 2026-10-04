"use strict";

const { tidalTrackIdFromUrl } = require("./tidalIdentity");
const {
  normalizeCatalogText,
  splitCreditNames,
  artistCreditSetKey,
  artistCreditNormalizationRule,
  featuredArtistNames,
  stripFeaturedArtistText,
  normalizeAlbumFamily,
  parseCanonicalCatalogIdentity
} = require("./catalogIdentityNormalization");

function displayText(value) {
  return String(value || '').replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '$1');
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return normalizeCatalogText(displayText(value));
}

function artistCreditList(value) {
  const raw = Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === "string" ? [entry] : [entry?.name || entry?.artist || ""])
    : [value];
  return splitCreditNames(raw.map(displayText));
}

function artistNameKeys(value) {
  const normalized = normalize(value);
  return new Set([normalized, normalized.replace(/\s+/g, "")].filter(Boolean));
}

function artistCreditRelation(requested, candidate) {
  const artistValue = (track) => Array.isArray(track?.artists) && track.artists.length ? track.artists : track?.artist;
  const requestedCredits = artistCreditList(artistValue(requested));
  const candidateCredits = artistCreditList(artistValue(candidate));
  const requestedKeys = requestedCredits.map(artistNameKeys);
  const candidateKeys = candidateCredits.map(artistNameKeys);
  const requestedSetKey = artistCreditSetKey(requestedCredits);
  const candidateSetKey = artistCreditSetKey(candidateCredits);
  const requestedDisplayKey = [...new Set(requestedCredits.map(normalize))].sort().join("|");
  const candidateDisplayKey = [...new Set(candidateCredits.map(normalize))].sort().join("|");
  const trustedAliasValues = Array.isArray(requested?.artistAliases) ? requested.artistAliases : [];
  const trustedAliasVariants = trustedAliasValues
    .map((value) => ({
      value,
      key: artistCreditSetKey(value),
      displayKey: [...new Set(artistCreditList(value).map(normalize))].sort().join("|")
    }))
    .filter((variant) => variant.key && (variant.key !== requestedSetKey || variant.displayKey !== requestedDisplayKey));
  const aliasVariant = trustedAliasVariants.find((variant) =>
    variant.key === candidateSetKey && variant.displayKey === candidateDisplayKey
  ) || null;
  const exactOrder = requestedCredits.length === candidateCredits.length
    && requestedCredits.every((credit, index) => normalize(credit) === normalize(candidateCredits[index]));
  const exactSet = Boolean(requestedSetKey && requestedSetKey === candidateSetKey);
  const creditNormalizationRule = artistCreditNormalizationRule(requestedCredits, candidateCredits);
  const normalizedSet = exactSet;
  const requestedSet = new Set(requestedSetKey ? requestedSetKey.split("|") : []);
  const candidateSet = new Set(candidateSetKey ? candidateSetKey.split("|") : []);
  const requestedSubset = requestedSet.size > 0 && [...requestedSet].every((credit) => candidateSet.has(credit));
  const candidateSubset = candidateSet.size > 0 && [...candidateSet].every((credit) => requestedSet.has(credit));
  let type = "conflicting-artist-identity";
  if (exactOrder) type = "exact-artist-set";
  else if (exactSet && normalizedSet && creditNormalizationRule === "punctuation-and-spacing-fold") type = "alias-equivalent";
  else if (exactSet && normalizedSet) type = "reordered-equivalent";
  else if (aliasVariant) type = "alias-equivalent";
  else if (requestedSubset) type = "requested-artists-subset";
  else if (candidateSubset) type = "candidate-artists-subset";
  const matched = type !== "conflicting-artist-identity";
  const providerIdentityEvidence = {
    requestedArtistIds: [
      requested?.tidalArtistId,
      ...(Array.isArray(requested?.tidalArtistIds) ? requested.tidalArtistIds : []),
      requested?.beatportArtistId,
      ...(Array.isArray(requested?.beatportArtistIds) ? requested.beatportArtistIds : [])
    ].filter((id) => id !== null && id !== undefined && String(id).trim()).map(String),
    candidateArtistIds: [
      candidate?.tidalArtistId,
      ...(Array.isArray(candidate?.tidalArtistIds) ? candidate.tidalArtistIds : []),
      candidate?.beatportArtistId,
      ...(Array.isArray(candidate?.beatportArtistIds) ? candidate.beatportArtistIds : []),
      ...(Array.isArray(candidate?.artistIds) ? candidate.artistIds : []),
      ...(Array.isArray(candidate?.artists) ? candidate.artists.map((artist) => artist?.id) : [])
    ].filter((id) => id !== null && id !== undefined && String(id).trim()).map(String),
    matchedBy: aliasVariant
      ? requested?.artistAliasSource || "trusted-artist-alias"
      : exactOrder ? "exact-credit-order" : exactSet ? "normalized-credit-set" : matched ? type : ""
  };
  providerIdentityEvidence.matchedArtistIds = providerIdentityEvidence.candidateArtistIds
    .filter((id) => providerIdentityEvidence.requestedArtistIds.includes(id));
  return {
    type,
    matched,
    requestedCredits,
    candidateCredits,
    requestedSubset,
    candidateSubset,
    artistAliasApplied: Boolean(aliasVariant),
    aliasSource: aliasVariant ? (requested?.artistAliasSource || "trusted-artist-alias") : "",
    canonicalArtistCredits: artistCreditList(requested?.canonicalArtistIdentity || requested?.artist || requestedCredits),
    artistCreditNormalizationRule: creditNormalizationRule,
    providerIdentityEvidence
  };
}

function artists(value) {
  return artistCreditList(value).map(normalize).sort().join("|");
}

function parseTrack(input) {
  if (typeof input === "string") {
    const text = input.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    const match = text.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    return match ? { artist: match[1].trim(), title: match[2].trim() } : { title: text };
  }
  const track = { ...(input || {}) };
  track.artist = track.artist || (Array.isArray(track.artists) ? track.artists.map(a => typeof a === "string" ? a : a.name).filter(Boolean).join(", ") : "");
  track.title = track.title || track.name || "";
  const version = track.version || track.remix;
  if (version && !normalize(track.title).includes(normalize(version))) track.title += ` (${version})`;
  return track;
}

function exactIntent(input = {}) {
  const text = [input.request, input.message, input.reference].filter(Boolean).join("\n");
  if (input.intent?.type !== "exact_track_verification" && input.mode !== "exact_track_verification" &&
      !/\b(?:verify|verification|validate|check|confirm|make sure)\b/i.test(text)) return null;
  const tracks = Array.isArray(input.tracks) ? parseTrackList(input.tracks) : parseTrackList(input.tracks || text);
  return tracks.length ? { type: "exact_track_verification", tracks } : null;
}

function parseTrackList(input) {
  if (Array.isArray(input)) return input.every(item => typeof item === "string") ? parseTrackList(input.join("\n")) : input.flatMap(item => typeof item === "string" ? parseTrackList(item) : [parseTrack(item)]);
  const result = [];
  for (let line of String(input || "").split(/\r?\n|;/)) {
    line = line.trim();
    if (!line) continue;
    // Strip only explicit instruction prefixes; never infer an artist from prose.
    line = line.replace(/^(?:please\s+)?(?:verify|check|confirm|validate)\b[^:\n]*:\s*/i, "")
      .replace(/^(?:please\s+)?(?:verify|check|confirm|validate)\s+(?:(?:these|the|following|exact|tracks?|availability|of)\s+)*/i, "");
    const prose = /[.!?]\s+(?=(?:please\s+)?(?:preserve|do not|don't|keep|make sure|only queue|then queue|verify|check|return|report)\b)/i.exec(line);
    if (prose) line = line.slice(0, prose.index);
    const track = parseTrack(line);
    const valid = track.artist && track.title && !/\b(?:verify|verification|check|confirm|preserve|following|please|must|should)\b|^(?:do not|don't|keep|return|report|then)\b/i.test(track.artist);
    if (!valid) { if (result.length) break; continue; }
    result.push(track);
    if (prose) break;
  }
  return result;
}

function baseTitle(title) {
  return parseCanonicalCatalogIdentity({ title }).normalizedBaseTitle;
}

const VERSION_KINDS = [
  ["mixed", /\b(?:mixed|dj\s+mix|continuous\s+mix)\b/i],
  ["radio", /\b(?:radio\s+edit|radio\s+mix|radio)\b/i],
  ["remix", /\b(?:remix|rework|bootleg|flip|vip)\b/i],
  ["dub", /\bdub(?:\s+(?:mix|version|edit))?\b/i],
  ["orchestra", /\borchestra\s+(?:version|mix|edit)\b/i],
  ["alternate", /\b(?:main|am|pm|ambient|acapella|a\s+cappella)\s+(?:mix|version|edit)\b/i],
  ["extended", /\b(?:extended|club)\s+(?:mix|version|edit)\b|\bextended\b/i],
  ["original", /\b(?:original\s+mix|original\s+version|original)\b/i],
  ["live", /\b(?:live|concert|in\s+concert)\b/i],
  ["acoustic", /\b(?:acoustic|unplugged)\b/i],
  ["remaster", /\b(?:remaster(?:ed)?|anniversary\s+edition)\b/i],
  ["edit", /\bedit\b/i]
];

const GENERIC_VERSION_WORDS = new Set([
  "mix", "remix", "edit", "version", "extended", "original", "radio", "club",
  "dub", "instrumental", "vip", "orchestra", "main", "am", "pm", "ambient", "acapella", "cappella",
  "remaster", "remastered", "anniversary", "edition",
  "live", "acoustic", "unplugged", "rework", "bootleg", "flip", "mixed", "dj", "continuous"
]);

const IDENTITY_DISAMBIGUATION_DEFAULTS = Object.freeze({
  highConfidenceThreshold: 0.84,
  minimumConfidenceMargin: 0.08,
  alternateVersionThreshold: 0.84,
  legacyEraGapYears: 8,
  legacyOriginalYearCutoff: 2012,
  legacyPreferenceMargin: 0.05
});

function trackTitleText(track = {}) {
  const title = String(track.title || track.name || "").trim();
  const version = String(track.mixVersion || track.mixName || track.version || track.remix || "").trim();
  if (!version || normalize(title).includes(normalize(version))) return title;
  return `${title} (${version})`;
}

function versionInfo(track = {}) {
  return parseCanonicalCatalogIdentity(track).version;
}

function canonicalTitleIdentity(track = {}) {
  return parseCanonicalCatalogIdentity(track);
}

function versionRelation(requested, candidate) {
  const wanted = versionInfo(requested);
  const found = versionInfo(candidate);
  if (!wanted.explicit && !found.explicit) return { matched: true, relation: "same", requested: wanted, candidate: found };
  if (wanted.kind === "original" && !found.explicit) return {
    matched: true,
    relation: "ORIGINAL_EQUIVALENT_TO_UNLABELED",
    requested: wanted,
    candidate: found
  };
  if (!wanted.explicit && found.kind === "original") return { matched: true, relation: "base-title-with-version-proxy", requested: wanted, candidate: found };
  if (!wanted.explicit && found.kind === "extended") return { matched: true, relation: "unrequested-extended-version", requested: wanted, candidate: found };
  if (!wanted.explicit && ["orchestra", "alternate"].includes(found.kind)) return { matched: true, relation: "unrequested-alternate-version", requested: wanted, candidate: found };
  if (!wanted.explicit) return { matched: false, relation: "candidate-version-not-requested", requested: wanted, candidate: found };
  if (!found.explicit || wanted.kind !== found.kind) return { matched: false, relation: "version-kind-mismatch", requested: wanted, candidate: found };

  // Generic Original/Extended/Radio descriptors identify a version family.
  // Named remixes, DJ mixes and special versions must retain their descriptor
  // identity so a different recording is never silently substituted.
  const strictDescriptorKinds = new Set(["remix", "mixed", "dub", "orchestra", "alternate", "live", "acoustic", "remaster", "edit"]);
  const descriptorMatches = !strictDescriptorKinds.has(wanted.kind) ||
    (wanted.semantic && found.semantic ? wanted.semantic === found.semantic : wanted.normalized === found.normalized);
  return {
    matched: descriptorMatches,
    relation: descriptorMatches ? "same-version" : "version-descriptor-mismatch",
    requested: wanted,
    candidate: found
  };
}

function canonicalMainMixEvidence(requested = {}, candidate = {}, { artistRelation = null } = {}) {
  const requestedIdentity = parseCanonicalCatalogIdentity(requested);
  const candidateIdentity = parseCanonicalCatalogIdentity(candidate);
  const relation = artistRelation || artistCreditRelation(requested, candidate);
  const requestedAlbum = normalizeAlbumFamily(requested.album || requested.releaseTitle || requested.release?.title || "");
  const candidateAlbum = normalizeAlbumFamily(candidate.album || candidate.releaseTitle || candidate.release?.title || "");
  const candidateText = normalize([
    candidate.title,
    candidate.mixVersion,
    candidate.mixName,
    candidate.version,
    candidate.remix,
    candidate.album,
    candidate.releaseTitle
  ].filter(Boolean).join(" "));
  const unsafePrincipalDescriptor = /\b(?:remix|rework|reimagined|bootleg|flip|vip|extended|club|radio|edit|live|acoustic|instrumental|dub|orchestra|remaster)\b/i.test(candidateText);
  const requestedDuration = durationMsFor(requested);
  const candidateDuration = durationMsFor(candidate);
  const durationAgrees = requestedDuration === null || candidateDuration === null
    || Math.abs(requestedDuration - candidateDuration) <= 5000;
  const requestedYear = eraProfile(requested).comparisonYear;
  const candidateYear = eraProfile(candidate).comparisonYear;
  const eraAgrees = requestedYear === null || candidateYear === null || Math.abs(requestedYear - candidateYear) <= 3;
  const mainMixLabel = ["main mix", "main version"].includes(candidateIdentity.version.normalized);
  const principalAlbum = Boolean(candidateAlbum && candidateAlbum === candidateIdentity.normalizedBaseTitle);
  const supportedByRelease = candidateYear !== null && principalAlbum;
  const applied = !requestedIdentity.version.explicit
    && mainMixLabel
    && requestedIdentity.normalizedBaseTitle
    && requestedIdentity.normalizedBaseTitle === candidateIdentity.normalizedBaseTitle
    && relation.matched
    && !unsafePrincipalDescriptor
    && supportedByRelease
    && durationAgrees
    && eraAgrees;
  return {
    applied,
    reason: applied ? "main-mix-principal-release-evidence" : "",
    requestedVersionExplicit: requestedIdentity.version.explicit,
    candidateVersion: candidateIdentity.version.normalized,
    principalAlbum,
    supportedByRelease,
    durationAgrees,
    eraAgrees,
    unsafePrincipalDescriptor
  };
}

function durationMsFor(track = {}) {
  for (const key of ["durationMs", "duration_ms", "durationMilliseconds"]) {
    const value = Number(track[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const value = track.duration;
  if (typeof value === "string") {
    const iso = value.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    if (iso) return ((Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0)) * 1000;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds < 100000 ? seconds * 1000 : seconds;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? (number < 100000 ? number * 1000 : number) : null;
}

function normalizedDate(track = {}) {
  const value = String(track.releaseDate || track.release_date || "").trim();
  return value ? value.slice(0, 10) : "";
}

function yearFor(track = {}) {
  const year = Number(track.year || String(track.releaseDate || "").slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

function yearValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).match(/\b((?:19|20)\d{2})\b/);
  const year = Number(match?.[1] || value);
  return Number.isFinite(year) && year >= 1900 && year <= 2100 ? year : null;
}

function nestedValue(track, key) {
  const metadata = track?.metadata && typeof track.metadata === "object" ? track.metadata : {};
  const evidence = track?.releaseEvidence || track?.release_evidence;
  const release = evidence && typeof evidence === "object" ? evidence : {};
  return track?.[key] ?? metadata[key] ?? release[key];
}

function firstYear(...values) {
  for (const value of values) {
    const year = yearValue(value);
    if (year !== null) return year;
  }
  return null;
}

function eraProfile(track = {}) {
  const recordingYear = firstYear(
    nestedValue(track, "recordingYear"), nestedValue(track, "recording_year"),
    nestedValue(track, "originalReleaseYear"), nestedValue(track, "original_release_year"),
    nestedValue(track, "firstReleaseYear"), nestedValue(track, "first_release_year"),
    nestedValue(track, "recordingDate"), nestedValue(track, "recording_date"),
    nestedValue(track, "originalReleaseDate"), nestedValue(track, "original_release_date")
  );
  const isrcYear = firstYear(nestedValue(track, "isrcYear"), nestedValue(track, "isrc_year"));
  const catalogReleaseYear = firstYear(
    nestedValue(track, "catalogReleaseYear"), nestedValue(track, "catalog_release_year"),
    nestedValue(track, "releaseYear"), nestedValue(track, "release_year"),
    track.year, track.releaseDate, track.release_date
  );
  const explicitReissueYear = firstYear(
    nestedValue(track, "reissueYear"), nestedValue(track, "reissue_year"),
    nestedValue(track, "reissueDate"), nestedValue(track, "reissue_date")
  );
  const reissueYear = explicitReissueYear || (recordingYear && catalogReleaseYear && catalogReleaseYear > recordingYear + 1
    ? catalogReleaseYear : null);
  const eraText = cleanText(nestedValue(track, "recordingEra") || nestedValue(track, "era"));
  const eraMatch = eraText.match(/\b((?:19|20)\d{2})s\b/i);
  const eraReferenceYear = eraMatch ? Number(eraMatch[1]) + 4.5 : null;
  const comparisonYear = recordingYear || isrcYear || eraReferenceYear || catalogReleaseYear;
  const comparisonYearSource = recordingYear !== null ? "recording-year"
    : isrcYear !== null ? "isrc-year"
      : eraReferenceYear !== null ? "era-label"
        : catalogReleaseYear !== null ? "catalog-release-year" : "";
  return {
    recordingYear,
    isrcYear,
    catalogReleaseYear,
    reissueYear,
    eraText,
    eraReferenceYear,
    comparisonYear,
    comparisonYearSource
  };
}

function recordingForm(track = {}) {
  const version = versionInfo(track);
  if (["radio", "edit"].includes(version.kind)) return "radio-edit";
  if (version.kind === "remix") return "remix";
  if (version.kind === "dub") return "dub";
  if (version.kind === "live") return "live";
  if (version.kind === "acoustic") return "acoustic";
  if (version.kind === "remaster") return "remaster";
  if (version.kind === "mixed") return "mixed-dj-set";
  const duration = durationMsFor(track);
  if (duration !== null && duration >= 8 * 60 * 1000) return "long-form-club";
  if (duration !== null && duration <= 5 * 60 * 1000) return "short-form";
  return version.kind === "extended" || version.kind === "original" || version.kind === "alternate"
    ? "club-mix"
    : duration === null ? "unknown" : "mid-length";
}

function durationFormCompatibility(requested, candidate) {
  const requestedDuration = durationMsFor(requested);
  const candidateDuration = durationMsFor(candidate);
  const durationDeltaMs = requestedDuration !== null && candidateDuration !== null
    ? Math.abs(requestedDuration - candidateDuration) : null;
  const ratio = requestedDuration !== null && candidateDuration !== null && Math.min(requestedDuration, candidateDuration) > 0
    ? Math.max(requestedDuration, candidateDuration) / Math.min(requestedDuration, candidateDuration) : null;
  const requestedForm = recordingForm(requested);
  const candidateForm = recordingForm(candidate);
  let relation = "unknown";
  let adjustment = 0;
  if (durationDeltaMs !== null) {
    if (durationDeltaMs <= 5000) relation = "same-form";
    else if (ratio >= 2 || (requestedForm === "long-form-club" && candidateForm === "short-form")
      || (requestedForm === "short-form" && candidateForm === "long-form-club")) {
      relation = "different-form";
      adjustment = -0.16;
    } else if (ratio > 1.5) {
      relation = "different-form";
      adjustment = -0.08;
    } else relation = "compatible-form";
  }
  return {
    relation,
    adjustment,
    durationDeltaMs,
    ratio: ratio === null ? null : Number(ratio.toFixed(4)),
    requestedForm,
    candidateForm
  };
}

function eraCompatibility(requested, candidate) {
  const requestedEra = eraProfile(requested);
  const candidateEra = eraProfile(candidate);
  if (requestedEra.comparisonYear === null || candidateEra.comparisonYear === null) {
    return { ...requestedEra, candidate: candidateEra, eraDistance: null, adjustment: 0, reason: "era-evidence-unavailable" };
  }
  const eraDistance = Math.abs(requestedEra.comparisonYear - candidateEra.comparisonYear);
  const adjustment = eraDistance <= 3 ? 0.03 : eraDistance <= 7 ? 0 : eraDistance <= 15 ? -0.05 : eraDistance <= 25 ? -0.10 : -0.15;
  return {
    ...requestedEra,
    candidate: candidateEra,
    eraDistance,
    adjustment,
    reason: eraDistance <= 3 ? "recording-era-agrees" : eraDistance <= 7 ? "recording-era-compatible" : "recording-era-distance"
  };
}

function legacyIdentityDiagnosticsFor(requested, candidate, {
  requestedIdentity,
  candidateIdentity,
  versions,
  durationForm: durationFormResult,
  era,
  isrcMatch,
  albumFamilyAgreement = null,
  strongIdentityOverrideApplied = false,
  strongIdentityOverrideReason = "",
  artistRelation = null,
  canonicalMainMixApplied = false,
  canonicalMainMixReason = "",
  outcome = "",
  rejectionReason = ""
} = {}) {
  const requestedEra = era?.candidate ? era : eraCompatibility(requested, candidate);
  const requestedProfile = requestedEra.candidate ? requestedEra : eraProfile(requested);
  const candidateProfile = requestedEra.candidate || eraProfile(candidate);
  return {
    normalizedArtistKey: { requested: artists(requested.artist || requested.artists), candidate: artists(candidate.artist || candidate.artists) },
    requestedNormalizedArtistKey: artists(requested.artist || requested.artists),
    candidateNormalizedArtistKey: artists(candidate.artist || candidate.artists),
    artistAliasApplied: Boolean(artistRelation?.artistAliasApplied),
    aliasSource: artistRelation?.aliasSource || "",
    canonicalArtistCredits: artistRelation?.canonicalArtistCredits || [],
    artistCreditNormalizationRule: artistRelation?.artistCreditNormalizationRule || "",
    providerIdentityEvidence: artistRelation?.providerIdentityEvidence || null,
    normalizedBaseTitle: { requested: requestedIdentity.normalizedBaseTitle, candidate: candidateIdentity.normalizedBaseTitle },
    normalizedFeaturedArtists: {
      requested: requestedIdentity.normalizedFeaturedArtists,
      candidate: candidateIdentity.normalizedFeaturedArtists
    },
    requestedVersion: versions?.requested || requestedIdentity.version,
    candidateVersion: versions?.candidate || candidateIdentity.version,
    canonicalVersionRelation: versions?.relation || "",
    canonicalMainMixApplied,
    canonicalMainMixReason,
    recordingForm: {
      requested: durationFormResult?.requestedForm || recordingForm(requested),
      candidate: durationFormResult?.candidateForm || recordingForm(candidate)
    },
    recordingYear: { requested: requestedProfile.recordingYear, candidate: candidateProfile.recordingYear },
    expectedLegacyEra: requestedProfile.comparisonYear,
    expectedLegacyEraSource: requestedProfile.comparisonYearSource || "",
    candidateEra: candidateProfile.comparisonYear,
    candidateEraSource: candidateProfile.comparisonYearSource || "",
    catalogReleaseYear: { requested: requestedProfile.catalogReleaseYear, candidate: candidateProfile.catalogReleaseYear },
    reissueYear: { requested: requestedProfile.reissueYear, candidate: candidateProfile.reissueYear },
    eraDistance: era?.eraDistance ?? null,
    eraAdjustment: era?.adjustment ?? 0,
    durationDeltaMs: durationFormResult?.durationDeltaMs ?? null,
    durationFormRelation: durationFormResult?.relation || "unknown",
    isrcAgreement: isrcMatch,
    normalizedAlbumFamily: {
      requested: normalizeAlbumFamily(requested.album || requested.releaseTitle || requested.release?.title || ""),
      candidate: normalizeAlbumFamily(candidate.album || candidate.releaseTitle || candidate.release?.title || "")
    },
    albumFamilyAgreement,
    strongIdentityOverrideApplied,
    strongIdentityOverrideReason,
    canonicalGroupId: null,
    canonicalGroupType: null,
    why: outcome && !rejectionReason ? outcome : rejectionReason || outcome || "insufficient-identity-evidence"
  };
}

function metadataAgreement(left, right, field, normalizeValue = normalize) {
  const a = String(left?.[field] || "").trim();
  const b = String(right?.[field] || "").trim();
  if (!a || !b) return null;
  return normalizeValue(a) === normalizeValue(b);
}

function isrcKey(value) {
  return normalize(String(value || "")).replace(/\s+/g, "");
}

function tidalTrackIdFor(track = {}) {
  return String(
    track.tidalTrackId || track.tidalId || track.tidal_id || track.id ||
    tidalTrackIdFromUrl(track.tidalUrl || track.url) || ""
  ).trim();
}

function releaseAgreement(requested, candidate) {
  const requestedDate = normalizedDate(requested);
  const candidateDate = normalizedDate(candidate);
  if (requestedDate && candidateDate) return requestedDate === candidateDate;
  const requestedYear = yearFor(requested);
  const candidateYear = yearFor(candidate);
  return requestedYear && candidateYear ? requestedYear === candidateYear : null;
}

function scoreTidalIdentity(requested = {}, candidate = {}) {
  const requestedTitle = trackTitleText(requested);
  const candidateTitle = trackTitleText(candidate);
  const requestedTitleIdentity = canonicalTitleIdentity(requested);
  const candidateTitleIdentity = canonicalTitleIdentity(candidate);
  const requestedBaseTitle = requestedTitleIdentity.normalizedBaseTitle;
  const candidateBaseTitle = candidateTitleIdentity.normalizedBaseTitle;
  const normalizedBaseTitleMatch = Boolean(requestedBaseTitle && candidateBaseTitle && requestedBaseTitle === candidateBaseTitle);
  const fullTitleMatch = Boolean(requestedTitleIdentity.canonicalTitle && candidateTitleIdentity.canonicalTitle
    && requestedTitleIdentity.canonicalTitle === candidateTitleIdentity.canonicalTitle);
  const artistRelation = artistCreditRelation(requested, candidate);
  const versions = versionRelation(requested, candidate);
  const requestedTidalId = tidalTrackIdFor(requested);
  const candidateTidalId = tidalTrackIdFor(candidate);
  const tidalIdMatch = requestedTidalId && candidateTidalId ? requestedTidalId === candidateTidalId : null;
  const requestedBeatportId = String(requested.beatportTrackId || requested.beatportId || requested.beatport?.id || "").trim();
  const candidateBeatportId = String(candidate.beatportTrackId || candidate.beatportId || candidate.beatport?.id || "").trim();
  const beatportIdMatch = requestedBeatportId && candidateBeatportId ? requestedBeatportId === candidateBeatportId : null;
  const requestedIsrc = isrcKey(requested.isrc || requested.ISRC);
  const candidateIsrc = isrcKey(candidate.isrc || candidate.ISRC);
  const isrcMatch = requestedIsrc && candidateIsrc ? requestedIsrc === candidateIsrc : null;
  const requestedDuration = durationMsFor(requested);
  const candidateDuration = durationMsFor(candidate);
  const durationDeltaMs = requestedDuration !== null && candidateDuration !== null
    ? Math.abs(requestedDuration - candidateDuration) : null;
  const requestedAlbumFamily = normalizeAlbumFamily(requested.album || requested.releaseTitle || requested.release?.title || "");
  const candidateAlbumFamily = normalizeAlbumFamily(candidate.album || candidate.releaseTitle || candidate.release?.title || "");
  const albumAgreement = requestedAlbumFamily && candidateAlbumFamily
    ? requestedAlbumFamily === candidateAlbumFamily : null;
  const labelAgreement = metadataAgreement(requested, candidate, "label");
  const releaseDateAgreement = releaseAgreement(requested, candidate);
  const durationFormResult = durationFormCompatibility(requested, candidate);
  const era = eraCompatibility(requested, candidate);
  const originalVersionEquivalence = versions.relation === "ORIGINAL_EQUIVALENT_TO_UNLABELED";
  const canonicalMainMix = canonicalMainMixEvidence(requested, candidate, { artistRelation });
  const canonicalMainMixApplied = canonicalMainMix.applied;
  const effectiveVersions = canonicalMainMixApplied
    ? { ...versions, matched: true, relation: "CANONICAL_MAIN_MIX" }
    : versions;
  const strongOriginalVersionEvidence = originalVersionEquivalence && normalizedBaseTitleMatch
    && artistRelation.matched
    && (tidalIdMatch === true || (isrcMatch === true && durationDeltaMs !== null && durationDeltaMs <= 5000
      && ["same-form", "compatible-form"].includes(durationFormResult.relation)
      && [albumAgreement === true, labelAgreement === true, releaseDateAgreement === true, era.eraDistance === null || era.eraDistance <= 15]
        .filter(Boolean).length >= 2));
  const strongIdentityOverrideApplied = Boolean(
    isrcMatch === true && normalizedBaseTitleMatch && artistRelation.matched
      && !["exact-artist-set", "reordered-equivalent", "alias-equivalent"].includes(artistRelation.type)
      && durationDeltaMs !== null && durationDeltaMs <= 5000
      && ["same-form", "compatible-form"].includes(durationFormResult.relation)
  );

  let rejectionReason = "";
  let outcome = "";
  if (!normalizedBaseTitleMatch) {
    rejectionReason = "normalized-base-title-mismatch";
    outcome = "NOT_FOUND";
  } else if (!artistRelation.matched) {
    rejectionReason = "conflicting-artist-identity";
    outcome = "ARTIST_CONFLICT";
  } else if (!effectiveVersions.matched || (originalVersionEquivalence && !strongOriginalVersionEvidence)) {
    rejectionReason = originalVersionEquivalence && !strongOriginalVersionEvidence
      ? "original-version-equivalence-lacks-strong-recording-evidence" : effectiveVersions.relation;
    outcome = "VERSION_MISMATCH";
  } else if (isrcMatch === false) {
    rejectionReason = "isrc-conflict";
    outcome = "VERSION_MISMATCH";
  } else if (tidalIdMatch === false) {
    rejectionReason = "tidal-id-conflict";
    outcome = "UNSAFE_PROXY";
  }

  let confidenceScore = 0.46;
  confidenceScore += fullTitleMatch ? 0.22 : 0.14;
  if (artistRelation.type === "exact-artist-set") confidenceScore += 0.16;
  else if (artistRelation.type === "reordered-equivalent" || artistRelation.type === "alias-equivalent") confidenceScore += 0.14;
  else if (artistRelation.requestedSubset || artistRelation.candidateSubset) confidenceScore += 0.11;
  if (effectiveVersions.relation === "same") confidenceScore += 0.11;
  else if (effectiveVersions.relation === "same-version") confidenceScore += 0.12;
  else if (effectiveVersions.relation === "base-title-with-version-proxy") confidenceScore += 0.08;
  else if (canonicalMainMixApplied) confidenceScore += 0.10;
  else if (originalVersionEquivalence && strongOriginalVersionEvidence) confidenceScore += 0.12;
  if (isrcMatch === true) confidenceScore += 0.16;
  if (tidalIdMatch === true) confidenceScore += 0.08;
  if (durationDeltaMs !== null) confidenceScore += durationDeltaMs <= 5000 ? 0.06 : durationDeltaMs <= 30000 ? 0.02 : durationFormResult.adjustment;
  if (albumAgreement === true) confidenceScore += 0.05;
  if (labelAgreement === true) confidenceScore += 0.03;
  if (releaseDateAgreement === true) confidenceScore += 0.03;
  if (albumAgreement === false) confidenceScore -= 0.03;
  if (labelAgreement === false) confidenceScore -= 0.015;
  if (isrcMatch === false) confidenceScore -= 0.22;
  confidenceScore += era.adjustment;
  confidenceScore = Math.max(0, Math.min(1, confidenceScore));

  const matched = !outcome && confidenceScore >= 0.68;
  if (matched) {
    outcome = !requestedVersionIsExplicit(requested) && effectiveVersions.relation === "base-title-with-version-proxy"
      ? "VERIFIED_BASE_TITLE_WITH_VERSION_PROXY"
      : originalVersionEquivalence || canonicalMainMixApplied || strongIdentityOverrideApplied
        ? "VERIFIED_EQUIVALENT_RECORDING"
        : artistRelation.type === "exact-artist-set" && (fullTitleMatch || versions.relation === "same")
          ? "VERIFIED_EXACT" : "VERIFIED_EQUIVALENT_RECORDING";
  }
  if (!matched && !outcome) {
    rejectionReason = confidenceScore < 0.68 ? "insufficient-identity-evidence" : "unsafe-identity-proxy";
    outcome = "UNSAFE_PROXY";
  }

  const legacyIdentityDiagnostics = legacyIdentityDiagnosticsFor(requested, candidate, {
    requestedIdentity: requestedTitleIdentity,
    candidateIdentity: candidateTitleIdentity,
    versions: effectiveVersions,
    durationForm: durationFormResult,
    era,
    isrcMatch,
    albumFamilyAgreement: albumAgreement,
    strongIdentityOverrideApplied,
    strongIdentityOverrideReason: strongIdentityOverrideApplied
      ? "exact-isrc-base-title-duration-form-overrides-artist-credit-layout" : "",
    artistRelation,
    canonicalMainMixApplied,
    canonicalMainMixReason: canonicalMainMix.reason,
    outcome,
    rejectionReason
  });

  return {
    matched,
    outcome,
    confidenceScore: Number(confidenceScore.toFixed(4)),
    requestedVersion: versions.requested,
    candidateVersion: effectiveVersions.candidate,
    artistRelation,
    artistAliasApplied: Boolean(artistRelation.artistAliasApplied),
    aliasSource: artistRelation.aliasSource || "",
    canonicalArtistCredits: artistRelation.canonicalArtistCredits || [],
    artistCreditNormalizationRule: artistRelation.artistCreditNormalizationRule || "",
    providerIdentityEvidence: artistRelation.providerIdentityEvidence || null,
    normalizedBaseTitleMatch,
    fullTitleMatch,
    isrcMatch,
    tidalIdMatch,
    beatportIdMatch,
    durationDeltaMs,
    durationFormRelation: durationFormResult,
    recordingForm: { requested: recordingForm(requested), candidate: recordingForm(candidate) },
    eraDistance: era.eraDistance,
    eraAdjustment: era.adjustment,
    recordingYear: { requested: era.recordingYear, candidate: era.candidate.recordingYear },
    catalogReleaseYear: { requested: era.catalogReleaseYear, candidate: era.candidate.catalogReleaseYear },
    reissueYear: { requested: era.reissueYear, candidate: era.candidate.reissueYear },
    albumAgreement,
    normalizedAlbumFamily: {
      requested: requestedAlbumFamily,
      candidate: candidateAlbumFamily
    },
    albumFamilyAgreement: albumAgreement,
    labelAgreement,
    releaseDateAgreement,
    rejectionReason,
    strongIdentityOverrideApplied,
    strongIdentityOverrideReason: strongIdentityOverrideApplied
      ? "exact-isrc-base-title-duration-form-overrides-artist-credit-layout" : "",
    canonicalMainMixApplied,
    canonicalMainMixReason: canonicalMainMix.reason,
    reasons: [
      normalizedBaseTitleMatch ? "normalized-base-title-match" : "normalized-base-title-mismatch",
      artistRelation.type,
      effectiveVersions.relation,
      ...(strongIdentityOverrideApplied ? ["strong-isrc-identity-override"] : []),
      isrcMatch === true ? "isrc-match" : isrcMatch === false ? "isrc-conflict" : "isrc-not-available",
      tidalIdMatch === true ? "tidal-id-match" : tidalIdMatch === false ? "tidal-id-conflict" : "tidal-id-not-available",
      durationDeltaMs === null ? "duration-not-available" : durationDeltaMs <= 5000 ? "duration-close" : "duration-delta",
      era.reason
    ],
    tidalIdMatch,
    beatportIdMatch,
    legacyIdentityDiagnostics
  };
}

function requestedVersionIsExplicit(track = {}) {
  return versionInfo(track).explicit;
}

function exactMatch(requested, matched) {
  return scoreTidalIdentity(requested, matched).matched;
}

function candidateIdentitySummary(track = {}) {
  const credits = artistCreditList(Array.isArray(track.artists) && track.artists.length ? track.artists : track.artist);
  const titleIdentity = canonicalTitleIdentity(track);
  const era = eraProfile(track);
  return {
    id: String(track.id || track.tidalTrackId || ""),
    tidalTrackId: String(track.tidalTrackId || track.tidalId || track.id || ""),
    beatportTrackId: String(track.beatportTrackId || track.beatportId || track.beatport?.id || ""),
    tidalUrl: String(track.tidalUrl || track.url || ""),
    artist: String(track.artist || credits.join(", ") || ""),
    artistCredits: credits,
    title: String(track.title || track.name || ""),
    album: String(track.album || ""),
    mixVersion: String(track.mixVersion || track.mixName || track.version || ""),
    version: versionInfo(track),
    normalizedBaseTitle: titleIdentity.normalizedBaseTitle,
    normalizedArtistKey: artists(track.artist || track.artists),
    normalizedFeaturedArtists: titleIdentity.normalizedFeaturedArtists,
    normalizedAlbumFamily: titleIdentity.normalizedAlbumFamily,
    label: String(track.label || ""),
    releaseDate: String(track.releaseDate || ""),
    year: yearFor(track),
    recordingYear: era.recordingYear,
    catalogReleaseYear: era.catalogReleaseYear,
    reissueYear: era.reissueYear,
    candidateEra: era.comparisonYear,
    candidateEraSource: era.comparisonYearSource || "",
    recordingForm: recordingForm(track),
    durationMs: durationMsFor(track),
    isrc: String(track.isrc || "")
  };
}

function sameTidalRecordingReason(left, right) {
  if (!left || !right) return "";
  const leftId = String(left.id || left.tidalTrackId || "");
  const rightId = String(right.id || right.tidalTrackId || "");
  if (leftId && rightId && leftId === rightId) return "same-tidal-track-id";
  const evaluation = scoreTidalIdentity(left, right);
  const reverseEvaluation = scoreTidalIdentity(right, left);
  const leftVersion = versionInfo(left);
  const rightVersion = versionInfo(right);
  const versionCompatible = (leftVersion.kind === rightVersion.kind && leftVersion.semantic === rightVersion.semantic) ||
    (leftVersion.kind === "none" && rightVersion.kind === "original") ||
    (leftVersion.kind === "original" && rightVersion.kind === "none");
  const leftDuration = durationMsFor(left);
  const rightDuration = durationMsFor(right);
  const durationDelta = leftDuration !== null && rightDuration !== null
    ? Math.abs(leftDuration - rightDuration) : null;
  const leftIsrc = normalize(String(left.isrc || left.ISRC || "")).replace(/\s+/g, "");
  const rightIsrc = normalize(String(right.isrc || right.ISRC || "")).replace(/\s+/g, "");
  const era = eraCompatibility(left, right);
  const isrcCompatible = leftIsrc && rightIsrc && leftIsrc === rightIsrc
    && versionCompatible
    && (durationDelta === null || durationDelta <= 5000);
  if (isrcCompatible) return "same-isrc";
  const originalUnlabeled = (leftVersion.kind === "original" && rightVersion.kind === "none")
    || (leftVersion.kind === "none" && rightVersion.kind === "original");
  if (originalUnlabeled) return "";
  const leftAlbumFamily = normalizeAlbumFamily(left.album || left.releaseTitle || left.release?.title || "");
  const rightAlbumFamily = normalizeAlbumFamily(right.album || right.releaseTitle || right.release?.title || "");
  const albumConflict = leftAlbumFamily && rightAlbumFamily && leftAlbumFamily !== rightAlbumFamily
    && !isCompilationAlbum(left.album) && !isCompilationAlbum(right.album);
  if (albumConflict) return "";
  if (evaluation.normalizedBaseTitleMatch && reverseEvaluation.normalizedBaseTitleMatch &&
      evaluation.artistRelation.matched && reverseEvaluation.artistRelation.matched &&
      versionCompatible && durationDelta !== null && durationDelta <= 5000
      && (era.eraDistance === null || era.eraDistance <= 15)) {
    return "matching-base-title-artist-version-duration";
  }
  return "";
}

function sameTidalRecording(left, right) {
  return Boolean(sameTidalRecordingReason(left, right));
}

function isCompilationAlbum(album) {
  return /\b(?:compilation|various\s+artists|best\s+of|dj\s+mix|collection)\b/i.test(String(album || ""));
}

function isReissueLike(track = {}) {
  const text = [track.album, track.releaseTitle, track.title, track.version, track.mixVersion]
    .filter(Boolean).join(" ");
  return /\b(?:reissue|re-?issue|remaster(?:ed)?|anniversary|deluxe|expanded|reconstructed|reconstruction|reinterpretation)\b/i.test(text);
}

function canonicalTwelveInchClubEvidence(requested = {}, candidate = {}, peers = [], options = {}) {
  const requestedIdentity = parseCanonicalCatalogIdentity(requested);
  const candidateIdentity = parseCanonicalCatalogIdentity(candidate);
  const relation = artistCreditRelation(requested, candidate);
  const candidateVersion = candidateIdentity.version;
  const candidateAlbum = normalizeAlbumFamily(candidate.album || candidate.releaseTitle || candidate.release?.title || "");
  const requestedAlbum = normalizeAlbumFamily(requested.album || requested.releaseTitle || requested.release?.title || "");
  const candidateReleaseEvidence = candidate.releaseEvidence && typeof candidate.releaseEvidence === "object"
    ? candidate.releaseEvidence : {};
  const candidateYear = firstYear(
    candidateReleaseEvidence.recordingYear,
    candidateReleaseEvidence.trackYear,
    candidateReleaseEvidence.albumYear,
    candidate.recordingYear,
    candidate.originalReleaseYear,
    candidate.year,
    candidate.releaseDate
  );
  const requestedYear = eraProfile(requested).comparisonYear;
  const oldCutoff = Number(options.legacyOriginalYearCutoff || IDENTITY_DISAMBIGUATION_DEFAULTS.legacyOriginalYearCutoff);
  const candidateText = normalize([
    candidate.title,
    candidate.version,
    candidate.mixVersion,
    candidate.mixName,
    candidate.remix
  ].filter(Boolean).join(" "));
  const exactDescriptor = candidateVersion.kind === "extended" && candidateVersion.normalized === "12 club mix";
  const baseTitleMatches = Boolean(
    requestedIdentity.normalizedBaseTitle
      && requestedIdentity.normalizedBaseTitle === candidateIdentity.normalizedBaseTitle
  );
  const albumFamilyMatches = Boolean(
    candidateAlbum
      && candidateAlbum === candidateIdentity.normalizedBaseTitle
      && (!requestedAlbum || requestedAlbum === candidateAlbum)
  );
  const originalYearMatches = candidateYear !== null && (
    requestedYear === null
      ? candidateYear <= oldCutoff
      : Math.abs(candidateYear - requestedYear) <= 3
  );
  const duration = durationMsFor(candidate);
  const longFormClub = recordingForm(candidate) === "club-mix" && duration !== null && duration >= 6 * 60 * 1000;
  const unsafeDescriptor = /\b(?:remix|rework|reimagined|bootleg|flip|vip|dub|orchestra|live|acoustic|remaster|edit|radio)\b/i.test(candidateText);
  const conflictingCanonical = peers.some((peer) => {
    if (!peer || peer === candidate) return false;
    const kind = versionInfo(peer).kind;
    return kind === "none" || kind === "original";
  });
  const checks = [
    [exactDescriptor, "not-12-inch-club-mix"],
    [baseTitleMatches, "base-title-incompatible"],
    [relation.matched, "artist-identity-incompatible"],
    [originalYearMatches, "missing-original-release-year"],
    [albumFamilyMatches, "album-family-is-not-principal-release"],
    [longFormClub, "club-form-is-not-long-form"],
    [!unsafeDescriptor, "third-party-or-alternate-version-descriptor"],
    [!conflictingCanonical, "conflicting-canonical-plain-or-original-candidate"]
  ];
  const failed = checks.find(([passed]) => !passed);
  const applied = !failed;
  return {
    applied,
    reason: applied ? "12-inch-club-principal-release-evidence" : failed[1],
    candidateVersion: candidateVersion.normalized,
    candidateYear,
    requestedYear,
    baseTitleMatches,
    artistMatched: Boolean(relation.matched),
    artistRelation: relation.type,
    albumFamilyMatches,
    longFormClub,
    durationMs: duration,
    unsafeDescriptor,
    conflictingCanonical
  };
}

function canonicalArtistCreditPreference(requested = {}, candidate = {}, peers = []) {
  const candidateRelation = artistCreditRelation(requested, candidate);
  if (candidateRelation.type !== "exact-artist-set") {
    return { applied: false, reason: "candidate-is-not-principal-artist-credit", peerId: "" };
  }
  const candidateIdentity = parseCanonicalCatalogIdentity(candidate);
  const candidateVersion = versionInfo(candidate);
  const equivalentVersionKinds = new Set(["none", "original", "alternate"]);
  if (!equivalentVersionKinds.has(candidateVersion.kind)) {
    return { applied: false, reason: "candidate-version-is-not-canonical-credit-form", peerId: "" };
  }
  const candidateAlbum = normalizeAlbumFamily(candidate.album || candidate.releaseTitle || candidate.release?.title || "");
  const candidateYear = eraProfile(candidate).comparisonYear;
  const candidateLabel = normalize(candidate.label || candidate.publisher || "");
  const candidateDuration = durationMsFor(candidate);
  const candidateProviderArtistIds = new Set([
    ...(Array.isArray(candidate.artistIds) ? candidate.artistIds : []),
    ...(Array.isArray(candidate.tidalArtistIds) ? candidate.tidalArtistIds : []),
    ...(Array.isArray(candidate.artists) ? candidate.artists.map((artist) => artist?.id) : [])
  ].map(String).filter(Boolean));
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!peer || peer === candidate) continue;
    const peerRelation = artistCreditRelation(requested, peer);
    const peerVersion = versionInfo(peer);
    const peerIdentity = parseCanonicalCatalogIdentity(peer);
    const peerAlbum = normalizeAlbumFamily(peer.album || peer.releaseTitle || peer.release?.title || "");
    const peerYear = eraProfile(peer).comparisonYear;
    const peerLabel = normalize(peer.label || peer.publisher || "");
    const peerDuration = durationMsFor(peer);
    const peerProviderArtistIds = new Set([
      ...(Array.isArray(peer.artistIds) ? peer.artistIds : []),
      ...(Array.isArray(peer.tidalArtistIds) ? peer.tidalArtistIds : []),
      ...(Array.isArray(peer.artists) ? peer.artists.map((artist) => artist?.id) : [])
    ].map(String).filter(Boolean));
    const sameBase = Boolean(candidateIdentity.normalizedBaseTitle
      && candidateIdentity.normalizedBaseTitle === peerIdentity.normalizedBaseTitle);
    const sameCanonicalForm = equivalentVersionKinds.has(peerVersion.kind)
      && (candidateVersion.kind === peerVersion.kind
        || (candidateVersion.kind === "none" && peerVersion.kind === "original")
        || (candidateVersion.kind === "original" && peerVersion.kind === "none"));
    const sameReleaseFamily = Boolean(candidateAlbum && candidateAlbum === peerAlbum);
    const sameEra = candidateYear !== null && peerYear !== null && Math.abs(candidateYear - peerYear) <= 1;
    const sameLabel = !candidateLabel || !peerLabel || candidateLabel === peerLabel;
    const sameDuration = candidateDuration === null || peerDuration === null || Math.abs(candidateDuration - peerDuration) <= 5000;
    const samePrincipalArtistId = [...candidateProviderArtistIds].some((id) => peerProviderArtistIds.has(id));
    const candidateEvidence = scoreTidalIdentity(requested, candidate);
    const peerEvidence = scoreTidalIdentity(requested, peer);
    if (peerEvidence.isrcMatch === true && candidateEvidence.isrcMatch !== true) {
      return { applied: false, reason: "provider-isrc-lineage-preferred", peerId: String(peer.id || peer.tidalId || "") };
    }
    if (peerRelation.type === "requested-artists-subset"
      && sameBase && sameCanonicalForm
      && (sameReleaseFamily || (sameEra && samePrincipalArtistId))
      && (sameReleaseFamily ? sameLabel : samePrincipalArtistId)
      && sameDuration) {
      return {
        applied: true,
        reason: "principal-canonical-artist-credit",
        peerId: String(peer.id || peer.tidalId || "")
      };
    }
  }
  return { applied: false, reason: "no-equivalent-featured-credit-peer", peerId: "" };
}

function originalLineageEvidence(requested = {}, candidate = {}, options = {}) {
  const requestedYear = eraProfile(requested).comparisonYear;
  const candidateProfile = eraProfile(candidate);
  const candidateYear = candidateProfile.comparisonYear;
  const catalogReleaseYear = candidateProfile.catalogReleaseYear;
  const evidence = candidate.releaseEvidence && typeof candidate.releaseEvidence === "object"
    ? candidate.releaseEvidence : {};
  const recordingYear = firstYear(
    candidate.recordingYear,
    candidate.originalReleaseYear,
    evidence.recordingYear,
    evidence.trackYear,
    evidence.originalReleaseYear,
    evidence.originalReleaseDate
  );
  const baseTitle = parseCanonicalCatalogIdentity(candidate).normalizedBaseTitle;
  const requestedBaseTitle = parseCanonicalCatalogIdentity(requested).normalizedBaseTitle;
  const artistRelation = artistCreditRelation(requested, candidate);
  const albumFamily = normalizeAlbumFamily(candidate.album || candidate.releaseTitle || candidate.release?.title || "");
  const principalAlbum = Boolean(albumFamily && albumFamily === baseTitle);
  const alignedRecordingYear = requestedYear !== null && recordingYear !== null
    && Math.abs(recordingYear - requestedYear) <= 3;
  const alignedCatalogReleaseYear = requestedYear !== null && catalogReleaseYear !== null
    && Math.abs(catalogReleaseYear - requestedYear) <= 3;
  const catalogOriginalLineage = Boolean(
    alignedCatalogReleaseYear
      && baseTitle
      && baseTitle === requestedBaseTitle
      && artistRelation.matched
      && versionInfo(candidate).kind === "original"
      && !isCompilationAlbum(candidate.album || candidate.releaseTitle)
      && !isReissueLike(candidate)
  );
  const allowed = requestedYear === null || candidateYear === null || Math.abs(candidateYear - requestedYear) <= 3
    || Boolean(alignedRecordingYear)
    || catalogOriginalLineage;
  return {
    allowed,
    reason: catalogOriginalLineage
      ? "original-catalog-lineage-compatible"
      : allowed ? "original-lineage-compatible" : "original-version-lacks-requested-legacy-lineage",
    requestedYear,
    candidateYear,
    catalogReleaseYear,
    recordingYear,
    principalAlbum,
    alignedRecordingYear,
    alignedCatalogReleaseYear,
    catalogOriginalLineage,
    legacyOriginalYearCutoff: Number(options.legacyOriginalYearCutoff || IDENTITY_DISAMBIGUATION_DEFAULTS.legacyOriginalYearCutoff)
  };
}

function canonicalTieBreakPreference(requested = {}, candidate = {}, peers = []) {
  const evaluation = scoreTidalIdentity(requested, candidate);
  const artistCreditPreference = canonicalArtistCreditPreference(requested, candidate, peers);
  const candidateEra = eraProfile(candidate);
  const requestedEra = eraProfile(requested);
  const peerYears = [candidate, ...peers]
    .map((entry) => eraProfile(entry).comparisonYear)
    .filter((year) => year !== null);
  const earliestTrustedYear = peerYears.length ? Math.min(...peerYears) : null;
  const candidateCompilation = isCompilationAlbum(candidate.album || candidate.releaseTitle);
  const candidateReissue = isReissueLike(candidate) || Boolean(candidateEra.reissueYear);
  const candidateYear = candidateEra.comparisonYear;
  const sameOriginalLineage = candidateYear !== null && earliestTrustedYear !== null && candidateYear === earliestTrustedYear;
  const originalReleasePreferenceApplied = Boolean(!candidateCompilation && !candidateReissue && sameOriginalLineage);
  const compilationPenalty = candidateCompilation ? 0.24 : 0;
  const reissuePenalty = candidateReissue ? 0.16 : 0;
  let score = 0;
  const reasons = [];
  if (evaluation.albumAgreement === true) {
    score += 0.28;
    reasons.push("requested-album-family");
  }
  if (evaluation.artistRelation?.type === "exact-artist-set") {
    score += 0.18;
    reasons.push("canonical-artist-set");
  } else if (evaluation.artistRelation?.matched) {
    score += 0.08;
    reasons.push("trusted-artist-equivalence");
  }
  if (evaluation.isrcMatch === true) {
    score += 0.30;
    reasons.push("isrc-lineage");
  }
  if (evaluation.durationFormRelation?.relation === "same-form") {
    score += 0.10;
    reasons.push("duration-form");
  } else if (evaluation.durationFormRelation?.relation === "compatible-form") {
    score += 0.04;
    reasons.push("compatible-duration-form");
  }
  if (evaluation.labelAgreement === true) {
    score += 0.05;
    reasons.push("release-label");
  }
  if (evaluation.releaseDateAgreement === true) {
    score += 0.05;
    reasons.push("release-date");
  }
  if (!requestedVersionIsExplicit(requested) && canonicalVersionPreference(requested, candidate).rank === 0) {
    score += 0.08;
    reasons.push("plain-or-original-version");
  }
  if (sameOriginalLineage) {
    score += 0.12;
    reasons.push("earliest-trusted-lineage");
  }
  if (requestedEra.comparisonYear !== null && candidateYear !== null) {
    const distance = Math.abs(requestedEra.comparisonYear - candidateYear);
    if (distance <= 3) {
      score += 0.08;
      reasons.push("era-match");
    } else if (distance > 15) {
      score -= 0.08;
      reasons.push("modern-era-distance");
    }
  }
  if (candidateCompilation) reasons.push("compilation-penalty");
  if (candidateReissue) reasons.push("reissue-penalty");
  if (artistCreditPreference.applied) {
    score += 0.14;
    reasons.push(artistCreditPreference.reason);
  }
  score -= compilationPenalty + reissuePenalty;
  return {
    score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
    reasons: [...new Set(reasons)],
    originalReleasePreferenceApplied,
    compilationPenalty: Number(compilationPenalty.toFixed(4)),
    reissuePenalty: Number(reissuePenalty.toFixed(4)),
    artistCreditPreferenceApplied: artistCreditPreference.applied,
    artistCreditPreferenceReason: artistCreditPreference.reason,
    artistCreditPreferencePeerId: artistCreditPreference.peerId,
    lineageEvidence: {
      candidateYear,
      candidateYearSource: candidateEra.recordingYear !== null ? "recording-year" : candidateEra.catalogReleaseYear !== null ? "catalog-release-year" : "",
      requestedYear: requestedEra.comparisonYear,
      earliestTrustedYear,
      isrcMatch: evaluation.isrcMatch,
      albumAgreement: evaluation.albumAgreement,
      labelAgreement: evaluation.labelAgreement,
      releaseDateAgreement: evaluation.releaseDateAgreement,
      candidateCompilation,
      candidateReissue
    }
  };
}

function canonicalRecordingCandidate(group, requested = {}) {
  return [...group].sort((left, right) => {
    const leftTieBreak = canonicalTieBreakPreference(requested, left.entry, group.map(item => item.entry));
    const rightTieBreak = canonicalTieBreakPreference(requested, right.entry, group.map(item => item.entry));
    const leftVersion = canonicalVersionPreference(requested, left.entry).rank;
    const rightVersion = canonicalVersionPreference(requested, right.entry).rank;
    return rightTieBreak.score - leftTieBreak.score
      || leftVersion - rightVersion
      || right.evaluation.confidenceScore - left.evaluation.confidenceScore;
  })[0];
}

function legacyCanonicalPreference(requested, group, allGroups, options = {}) {
  const candidate = group.canonical.entry;
  const evaluation = group.canonical.evaluation;
  const candidateCompilation = isCompilationAlbum(candidate.album || candidate.releaseTitle);
  const candidateReissue = isReissueLike(candidate) || Boolean(eraProfile(candidate).reissueYear);
  const requestedEra = eraProfile(requested).comparisonYear;
  const candidateEra = eraProfile(candidate).comparisonYear;
  const oldCutoff = Number(options.legacyOriginalYearCutoff || IDENTITY_DISAMBIGUATION_DEFAULTS.legacyOriginalYearCutoff);
  const requestedLooksLegacy = requestedEra !== null && requestedEra <= oldCutoff;
  const oldYears = allGroups.map(item => eraProfile(item.canonical.entry).comparisonYear).filter(year => year !== null && year <= oldCutoff);
  const modernYears = allGroups.map(item => eraProfile(item.canonical.entry).comparisonYear).filter(year => year !== null && year > oldCutoff);
  const originalYear = oldYears.length ? Math.min(...oldYears) : null;
  const modernYear = modernYears.length ? Math.max(...modernYears) : null;
  const eraGapYears = originalYear !== null && modernYear !== null ? modernYear - originalYear : null;
  const candidateLineageYear = eraProfile(candidate).recordingYear ?? eraProfile(candidate).catalogReleaseYear;
  const candidateHasRequestedLegacyLineage = Boolean(
    requestedEra !== null
      && candidateLineageYear !== null
      && candidateLineageYear <= oldCutoff
      && Math.abs(candidateLineageYear - requestedEra) <= 3
  );
  const originalEraCandidate = Boolean(
    evaluation.artistRelation?.matched
      && (candidateHasRequestedLegacyLineage
        || (candidateEra !== null && candidateEra <= oldCutoff
          && (candidateEra === originalYear
            || (requestedEra !== null && Math.abs(candidateEra - requestedEra) <= 3))))
  );
  const modernReinterpretation = Boolean(
    candidateEra !== null && originalYear !== null
      && (candidateEra - originalYear >= Number(options.legacyEraGapYears || IDENTITY_DISAMBIGUATION_DEFAULTS.legacyEraGapYears)
        || (requestedEra !== null && candidateEra - requestedEra >= Number(options.legacyEraGapYears || IDENTITY_DISAMBIGUATION_DEFAULTS.legacyEraGapYears)))
      && !candidateHasRequestedLegacyLineage
      && (
        requestedLooksLegacy
        || candidateCompilation
        || candidateReissue
        || evaluation.artistRelation?.type !== "exact-artist-set"
      )
  );
  const modernReinterpretationPenalty = modernReinterpretation
    ? Math.min(0.24, 0.08 + Math.max(0, candidateEra - originalYear - 10) * 0.01) : 0;
  const additionalCredits = Math.max(0, (evaluation.artistRelation?.candidateCredits?.length || 0)
    - (evaluation.artistRelation?.requestedCredits?.length || 0));
  let score = evaluation.confidenceScore * 0.25;
  if (evaluation.artistRelation?.type === "exact-artist-set") score += 0.36;
  else if (evaluation.artistRelation?.matched) score += 0.12;
  if (requestedEra !== null && candidateEra !== null && Math.abs(requestedEra - candidateEra) <= 7) score += 0.20;
  else if (originalEraCandidate) score += 0.18;
  if (evaluation.albumFamilyAgreement === true || evaluation.albumAgreement === true) score += 0.14;
  if (evaluation.labelAgreement === true) score += 0.06;
  score += Math.max(0, 0.06 - additionalCredits * 0.02);
  if (candidateCompilation && !candidateHasRequestedLegacyLineage) score -= 0.12;
  score -= modernReinterpretationPenalty;
  return {
    score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
    originalEraCandidate,
    compilationPenalty: Number((candidateCompilation && !candidateHasRequestedLegacyLineage ? 0.12 : 0).toFixed(4)),
    modernReinterpretationPenalty: Number(modernReinterpretationPenalty.toFixed(4)),
    eraGapYears,
    requestedLooksLegacy,
    candidateEra,
    candidateLineageYear,
    candidateHasRequestedLegacyLineage,
    reason: modernReinterpretation ? "modern-reinterpretation-penalized" : originalEraCandidate ? "original-era-canonical-candidate" : "legacy-era-supporting-evidence"
  };
}

function normalizeDisambiguationOptions(options = {}) {
  const numberOrDefault = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    highConfidenceThreshold: Math.max(0, Math.min(1, numberOrDefault(options.highConfidenceThreshold, IDENTITY_DISAMBIGUATION_DEFAULTS.highConfidenceThreshold))),
    minimumConfidenceMargin: Math.max(0, Math.min(1, numberOrDefault(options.minimumConfidenceMargin ?? options.confidenceMargin, IDENTITY_DISAMBIGUATION_DEFAULTS.minimumConfidenceMargin))),
    alternateVersionThreshold: Math.max(0, Math.min(1, numberOrDefault(options.alternateVersionThreshold, IDENTITY_DISAMBIGUATION_DEFAULTS.alternateVersionThreshold))),
    legacyEraGapYears: Math.max(1, numberOrDefault(options.legacyEraGapYears, IDENTITY_DISAMBIGUATION_DEFAULTS.legacyEraGapYears)),
    legacyOriginalYearCutoff: Math.max(1900, numberOrDefault(options.legacyOriginalYearCutoff, IDENTITY_DISAMBIGUATION_DEFAULTS.legacyOriginalYearCutoff)),
    legacyPreferenceMargin: Math.max(0, Math.min(1, numberOrDefault(options.legacyPreferenceMargin, IDENTITY_DISAMBIGUATION_DEFAULTS.legacyPreferenceMargin)))
  };
}

function canonicalVersionPreference(requested, candidate) {
  if (requestedVersionIsExplicit(requested)) return { rank: 0, label: "explicit-version-request", kind: versionInfo(candidate).kind };
  const info = versionInfo(candidate);
  if (info.kind === "none") return { rank: 0, label: "plain-base-title", kind: info.kind };
  if (info.kind === "original") return { rank: 1, label: "original-version", kind: info.kind };
  const canonicalMainMix = canonicalMainMixEvidence(requested, candidate);
  if (canonicalMainMix.applied) return { rank: 2, label: "canonical-main-mix", kind: info.kind };
  if (info.kind === "extended") return { rank: 3, label: "extended-version-fallback", kind: info.kind };
  if (["orchestra", "alternate"].includes(info.kind)) return { rank: 4, label: "named-alternate-version", kind: info.kind };
  return { rank: 5, label: "non-canonical-version", kind: info.kind };
}

function canonicalizationReason(group) {
  const reasons = [...new Set(group.collapseReasons || [])];
  if (reasons.length) return reasons.join(",");
  return group.members.length > 1 ? "highest-identity-confidence" : "single-candidate-group";
}

function chooseExact(requested, candidates, options = {}) {
  const disambiguation = normalizeDisambiguationOptions(options);
  const unique = [...new Map((Array.isArray(candidates) ? candidates : []).map((track, index) => [
    String(track.id || track.tidalUrl || `${track.artist || ""}|${track.title || track.name || ""}|${index}`), track
  ])).values()];
  const evaluations = unique.map(entry => ({ entry, evaluation: scoreTidalIdentity(requested, entry) }));
  let accepted = evaluations.filter(item => item.evaluation.matched);

  const narrowBy = (predicate) => {
    const narrowed = accepted.filter(predicate);
    if (narrowed.length) accepted = narrowed;
  };
  const requestedIsrc = isrcKey(requested.isrc || requested.ISRC);
  if (requestedIsrc) narrowBy(({ entry }) => isrcKey(entry.isrc || entry.ISRC) === requestedIsrc);
  const requestedAlbumFamily = normalizeAlbumFamily(requested.album || requested.releaseTitle || requested.release?.title || "");
  if (requestedAlbumFamily) narrowBy(({ entry }) => normalizeAlbumFamily(entry.album || entry.releaseTitle || entry.release?.title || "") === requestedAlbumFamily);
  if (requested.releaseDate) narrowBy(({ entry }) => normalizedDate(entry) === normalizedDate(requested));
  if (requested.year) narrowBy(({ entry }) => yearFor(entry) === Number(requested.year));
  const requestedDuration = durationMsFor(requested);
  if (requestedDuration !== null) narrowBy(({ entry }) => durationMsFor(entry) !== null && Math.abs(durationMsFor(entry) - requestedDuration) <= 30000);

  const groups = [];
  for (const item of accepted.sort((left, right) => right.evaluation.confidenceScore - left.evaluation.confidenceScore)) {
    const group = groups.find(existing => sameTidalRecording(existing.members[0].entry, item.entry));
    if (group) {
      group.members.push(item);
      const reason = sameTidalRecordingReason(group.members[0].entry, item.entry);
      if (reason) group.collapseReasons.push(reason);
    } else groups.push({ members: [item], collapseReasons: [] });
  }
  const collapsedCount = groups.reduce((sum, group) => sum + Math.max(0, group.members.length - 1), 0);
  const diagnosticsFor = (item, group = null) => item ? {
    ...candidateIdentitySummary(item.entry),
    identityOutcome: item.evaluation.outcome,
    confidenceScore: item.evaluation.confidenceScore,
    rejectionReason: item.evaluation.rejectionReason,
    canonicalTieBreakScore: group?.canonicalTieBreak?.score ?? null,
    canonicalTieBreakReasons: group?.canonicalTieBreak?.reasons || [],
    artistCreditPreferenceApplied: Boolean(group?.canonicalTieBreak?.artistCreditPreferenceApplied),
    artistCreditPreferenceReason: group?.canonicalTieBreak?.artistCreditPreferenceReason || "",
    canonicalPrincipalReleaseApplied: Boolean(group?.versionPreference?.canonicalPrincipalReleaseApplied),
    canonicalPrincipalReleaseReason: group?.versionPreference?.canonicalPrincipalReleaseReason || "",
    originalReleasePreferenceApplied: Boolean(group?.canonicalTieBreak?.originalReleasePreferenceApplied),
    compilationPenalty: group?.canonicalTieBreak?.compilationPenalty ?? 0,
    reissuePenalty: group?.canonicalTieBreak?.reissuePenalty ?? 0,
    lineageEvidence: group?.canonicalTieBreak?.lineageEvidence || null,
    legacyIdentityDiagnostics: {
      ...item.evaluation.legacyIdentityDiagnostics,
      canonicalGroupId: group?.canonicalGroupId || item.evaluation.legacyIdentityDiagnostics?.canonicalGroupId || null,
      canonicalGroupType: group?.canonicalGroupType || item.evaluation.legacyIdentityDiagnostics?.canonicalGroupType || null,
      why: item.evaluation.rejectionReason || item.evaluation.outcome
    },
    identityDiagnostics: {
      requestedArtistCredits: item.evaluation.artistRelation.requestedCredits,
      candidateArtistCredits: item.evaluation.artistRelation.candidateCredits,
      artistOverlapType: item.evaluation.artistRelation.type,
      artistAliasApplied: Boolean(item.evaluation.artistAliasApplied),
      aliasSource: item.evaluation.aliasSource || "",
      canonicalArtistCredits: item.evaluation.canonicalArtistCredits || [],
      artistCreditNormalizationRule: item.evaluation.artistCreditNormalizationRule || "",
      providerIdentityEvidence: item.evaluation.providerIdentityEvidence || null,
      normalizedBaseTitleMatch: item.evaluation.normalizedBaseTitleMatch,
      requestedVersion: item.evaluation.requestedVersion,
      candidateVersion: item.evaluation.candidateVersion,
      isrcMatch: item.evaluation.isrcMatch,
      tidalIdMatch: item.evaluation.tidalIdMatch,
      beatportIdMatch: item.evaluation.beatportIdMatch,
      durationDeltaMs: item.evaluation.durationDeltaMs,
      albumAgreement: item.evaluation.albumAgreement,
      normalizedAlbumFamily: item.evaluation.normalizedAlbumFamily,
      albumFamilyAgreement: item.evaluation.albumFamilyAgreement,
      labelAgreement: item.evaluation.labelAgreement,
      releaseDateAgreement: item.evaluation.releaseDateAgreement,
      canonicalMainMixApplied: Boolean(item.evaluation.canonicalMainMixApplied),
      canonicalMainMixReason: item.evaluation.canonicalMainMixReason || "",
      strongIdentityOverrideApplied: item.evaluation.strongIdentityOverrideApplied,
      strongIdentityOverrideReason: item.evaluation.strongIdentityOverrideReason,
      candidateConfidenceScore: item.evaluation.confidenceScore,
      rejectionReason: item.evaluation.rejectionReason,
      legacyIdentityDiagnostics: {
        ...item.evaluation.legacyIdentityDiagnostics,
        canonicalGroupId: group?.canonicalGroupId || item.evaluation.legacyIdentityDiagnostics?.canonicalGroupId || null,
        canonicalGroupType: group?.canonicalGroupType || item.evaluation.legacyIdentityDiagnostics?.canonicalGroupType || null
      }
    }
  } : null;

  const canonicalGroups = groups.map(group => {
    const canonical = canonicalRecordingCandidate(group.members, requested);
    return {
      ...group,
      canonical,
      canonicalizationReason: canonicalizationReason(group),
      versionPreference: null
    };
  }).sort((left, right) => right.canonical.evaluation.confidenceScore - left.canonical.evaluation.confidenceScore)
    .map((group, index) => ({
      ...group,
      canonicalGroupId: `canonical-recording-${index + 1}`,
      canonicalGroupType: group.members.length > 1 ? "equivalent-recording" : "distinct-recording-form"
    }));
  const allCanonicalEntries = canonicalGroups.map(group => group.canonical.entry);
  canonicalGroups.forEach((group) => {
    const basePreference = canonicalVersionPreference(requested, group.canonical.entry);
    const principalEvidence = canonicalTwelveInchClubEvidence(
      requested,
      group.canonical.entry,
      allCanonicalEntries,
      disambiguation
    );
    const applied = principalEvidence.applied;
    group.versionPreference = {
      ...basePreference,
      rank: applied ? 2 : basePreference.rank,
      label: applied ? "canonical-12-inch-club-principal" : basePreference.label,
      canonicalPrincipalReleaseApplied: applied,
      canonicalPrincipalReleaseReason: principalEvidence.reason,
      canonicalPrincipalReleaseEvidence: principalEvidence
    };
  });
  canonicalGroups.forEach((group) => {
    group.canonicalTieBreak = canonicalTieBreakPreference(requested, group.canonical.entry, allCanonicalEntries);
  });
  const legacyPreferences = canonicalGroups.map(group => legacyCanonicalPreference(requested, group, canonicalGroups, disambiguation));
  canonicalGroups.forEach((group, index) => {
    group.legacyCanonical = legacyPreferences[index];
  });
  let decisionGroups = canonicalGroups;
  let legacyCanonicalPreferenceApplied = false;
  const hasOriginalAndModernCandidates = decisionGroups.some(group => group.legacyCanonical.originalEraCandidate)
    && decisionGroups.some(group => group.legacyCanonical.modernReinterpretationPenalty > 0);
  if (decisionGroups.length > 1 && hasOriginalAndModernCandidates) {
    const legacyOrdered = [...decisionGroups].sort((left, right) =>
      right.legacyCanonical.score - left.legacyCanonical.score
      || right.canonical.evaluation.confidenceScore - left.canonical.evaluation.confidenceScore);
    const preferred = legacyOrdered[0];
    const runner = legacyOrdered[1];
    if (preferred.legacyCanonical.originalEraCandidate
      && (preferred.legacyCanonical.score - runner.legacyCanonical.score >= disambiguation.legacyPreferenceMargin
        || preferred.canonical.evaluation.artistRelation.type === "exact-artist-set"
        || preferred.legacyCanonical.candidateHasRequestedLegacyLineage)) {
      decisionGroups = [preferred];
      legacyCanonicalPreferenceApplied = true;
    }
  }
  let versionPreferenceApplied = false;
  if (!requestedVersionIsExplicit(requested) && decisionGroups.length > 1) {
    const bestVersionRank = Math.min(...decisionGroups.map(group => group.versionPreference.rank));
    const versionGroups = decisionGroups.filter(group => group.versionPreference.rank === bestVersionRank);
    versionPreferenceApplied = versionGroups.length < decisionGroups.length;
    decisionGroups = versionGroups;
  }
  let canonicalTieBreakApplied = false;
  if (decisionGroups.length > 1) {
    const tieOrdered = [...decisionGroups].sort((left, right) =>
      right.canonicalTieBreak.score - left.canonicalTieBreak.score
      || right.canonical.evaluation.confidenceScore - left.canonical.evaluation.confidenceScore);
    const preferred = tieOrdered[0];
    const runner = tieOrdered[1];
    const confidenceClose = Math.abs(preferred.canonical.evaluation.confidenceScore - runner.canonical.evaluation.confidenceScore)
      < disambiguation.minimumConfidenceMargin;
    const tieBreakMargin = preferred.canonicalTieBreak.score - runner.canonicalTieBreak.score;
    if (confidenceClose
      && preferred.canonical.evaluation.confidenceScore >= disambiguation.highConfidenceThreshold
      && tieBreakMargin >= 0.12
       && (preferred.canonicalTieBreak.originalReleasePreferenceApplied
         || preferred.canonicalTieBreak.lineageEvidence.isrcMatch === true
         || preferred.canonicalTieBreak.reasons.includes("requested-album-family")
         || preferred.canonicalTieBreak.artistCreditPreferenceApplied)) {
      decisionGroups = [preferred];
      canonicalTieBreakApplied = true;
    }
  }
  const groupDiagnostics = canonicalGroups.map((group, index) => ({
    groupIndex: index,
    memberCount: group.members.length,
    collapsedCount: Math.max(0, group.members.length - 1),
    canonicalizationReason: group.canonicalizationReason,
    versionPreference: group.versionPreference,
    canonicalGroupId: group.canonicalGroupId,
    canonicalGroupType: group.canonicalGroupType,
    legacyCanonicalScore: group.legacyCanonical.score,
    legacyCompilationPenalty: group.legacyCanonical.compilationPenalty ?? 0,
    modernReinterpretationPenalty: group.legacyCanonical.modernReinterpretationPenalty,
    originalEraCandidate: group.legacyCanonical.originalEraCandidate,
    candidateLineageYear: group.legacyCanonical.candidateLineageYear ?? null,
    candidateHasRequestedLegacyLineage: Boolean(group.legacyCanonical.candidateHasRequestedLegacyLineage),
    eraGapYears: group.legacyCanonical.eraGapYears,
    legacyCanonicalPreferenceApplied,
    canonicalTieBreakScore: group.canonicalTieBreak.score,
    canonicalTieBreakReasons: group.canonicalTieBreak.reasons,
    originalReleasePreferenceApplied: group.canonicalTieBreak.originalReleasePreferenceApplied,
    compilationPenalty: group.canonicalTieBreak.compilationPenalty,
    reissuePenalty: group.canonicalTieBreak.reissuePenalty,
    lineageEvidence: group.canonicalTieBreak.lineageEvidence,
    artistCreditPreferenceApplied: Boolean(group.canonicalTieBreak.artistCreditPreferenceApplied),
    artistCreditPreferenceReason: group.canonicalTieBreak.artistCreditPreferenceReason || "",
    canonicalPrincipalReleaseApplied: Boolean(group.versionPreference.canonicalPrincipalReleaseApplied),
    canonicalPrincipalReleaseReason: group.versionPreference.canonicalPrincipalReleaseReason || "",
    canonicalPrincipalReleaseEvidence: group.versionPreference.canonicalPrincipalReleaseEvidence || null,
    canonicalTieBreakApplied,
    canonicalCandidate: diagnosticsFor(group.canonical, group),
    members: group.members.slice(0, 12).map(item => diagnosticsFor(item, group))
  }));
  const decisionTopGroup = decisionGroups[0] || null;
  const decisionRunnerUpGroup = decisionGroups[1] || null;
  const decisionTopScore = decisionTopGroup?.canonical?.evaluation?.confidenceScore ?? null;
  const decisionRunnerUpScore = decisionRunnerUpGroup?.canonical?.evaluation?.confidenceScore ?? null;
  const decisionConfidenceMargin = decisionTopScore !== null && decisionRunnerUpScore !== null
    ? Number((decisionTopScore - decisionRunnerUpScore).toFixed(4)) : null;
  const decisionOriginalLineage = decisionTopGroup
    ? originalLineageEvidence(requested, decisionTopGroup.canonical.entry, disambiguation)
    : null;
  const topGroup = canonicalGroups[0] || null;
  const runnerUpGroup = canonicalGroups[1] || null;
  const topScore = topGroup?.canonical?.evaluation?.confidenceScore ?? null;
  const runnerUpScore = runnerUpGroup?.canonical?.evaluation?.confidenceScore ?? null;
  const confidenceMargin = topScore !== null && runnerUpScore !== null ? Number((topScore - runnerUpScore).toFixed(4)) : null;
  const common = {
    candidatesCollapsedAsSameRecording: collapsedCount > 0,
    collapsedRecordingCount: collapsedCount,
    canonicalCandidateGroups: groupDiagnostics,
    expectedLegacyEra: eraProfile(requested).comparisonYear,
    expectedLegacyEraSource: eraProfile(requested).comparisonYearSource || "",
    versionPreferenceApplied,
    legacyCanonicalPreferenceApplied,
    canonicalTieBreakApplied,
    canonicalTieBreakScore: decisionTopGroup?.canonicalTieBreak?.score ?? null,
    canonicalTieBreakReasons: decisionTopGroup?.canonicalTieBreak?.reasons || [],
    artistCreditPreferenceApplied: Boolean(decisionTopGroup?.canonicalTieBreak?.artistCreditPreferenceApplied),
    artistCreditPreferenceReason: decisionTopGroup?.canonicalTieBreak?.artistCreditPreferenceReason || "",
    canonicalPrincipalReleaseApplied: Boolean(decisionTopGroup?.versionPreference?.canonicalPrincipalReleaseApplied),
    canonicalPrincipalReleaseReason: decisionTopGroup?.versionPreference?.canonicalPrincipalReleaseReason || "",
    canonicalPrincipalReleaseEvidence: decisionTopGroup?.versionPreference?.canonicalPrincipalReleaseEvidence || null,
    originalLineageEvidence: decisionOriginalLineage,
    originalReleasePreferenceApplied: Boolean(decisionTopGroup?.canonicalTieBreak?.originalReleasePreferenceApplied),
    compilationPenalty: decisionTopGroup?.canonicalTieBreak?.compilationPenalty ?? 0,
    reissuePenalty: decisionTopGroup?.canonicalTieBreak?.reissuePenalty ?? 0,
    lineageEvidence: decisionTopGroup?.canonicalTieBreak?.lineageEvidence || null,
    legacyCanonicalScore: decisionTopGroup?.legacyCanonical?.score ?? null,
    modernReinterpretationPenalty: decisionTopGroup?.legacyCanonical?.modernReinterpretationPenalty ?? 0,
    originalEraCandidate: decisionTopGroup?.legacyCanonical?.originalEraCandidate ?? false,
    eraGapYears: decisionTopGroup?.legacyCanonical?.eraGapYears ?? null,
    topCandidateScore: topScore,
    runnerUpScore,
    confidenceMargin
  };
  if (decisionGroups.length > 1) {
    if (decisionConfidenceMargin < disambiguation.minimumConfidenceMargin || decisionTopScore < disambiguation.highConfidenceThreshold) {
      return {
        status: "AMBIGUOUS",
        identityOutcome: "AMBIGUOUS",
        matches: decisionGroups.map(group => group.canonical.entry),
        candidateIdentities: decisionGroups.map(group => diagnosticsFor(group.canonical, group)),
        canonicalCandidateSelected: null,
        canonicalizationReason: "",
        ambiguityResolvedBy: "",
        finalIdentityOutcome: "AMBIGUOUS",
        ...common
      };
    }
  }
  if (decisionGroups.length >= 1) {
    const selectedGroup = decisionGroups[0];
    const selected = selectedGroup.canonical;
    if (!requestedVersionIsExplicit(requested) && selectedGroup.versionPreference.rank >= 3 && selected.evaluation.confidenceScore < disambiguation.alternateVersionThreshold) {
      return {
        status: "VERSION_MISMATCH",
        identityOutcome: "VERSION_MISMATCH",
        rejectionReason: "unrequested-version-below-safe-threshold",
        candidateIdentities: [diagnosticsFor(selected, selectedGroup)],
        canonicalCandidateSelected: diagnosticsFor(selected, selectedGroup),
        canonicalizationReason: selectedGroup.canonicalizationReason,
        ambiguityResolvedBy: "",
        finalIdentityOutcome: "VERSION_MISMATCH",
        ...common
      };
    }
    const ambiguityResolvedBy = legacyCanonicalPreferenceApplied
      ? "legacy-canonical-era-preference"
      : canonicalTieBreakApplied
      ? "canonical-lineage-tie-break"
      : versionPreferenceApplied
      ? "canonical-version-preference"
      : decisionGroups.length > 1
        ? "confidence-margin"
      : collapsedCount > 0
        ? "equivalent-recording-collapse"
        : "single-canonical-recording-group";
    return {
      status: "VERIFIED_TIDAL_ONLY",
      match: selected.entry,
      identityOutcome: selected.evaluation.outcome,
      confidenceScore: selected.evaluation.confidenceScore,
      identityDiagnostics: diagnosticsFor(selected, selectedGroup),
      candidateIdentities: [diagnosticsFor(selected, selectedGroup)],
      canonicalCandidateSelected: diagnosticsFor(selected, selectedGroup),
      canonicalizationReason: selectedGroup.canonicalizationReason,
      ambiguityResolvedBy,
      finalIdentityOutcome: selected.evaluation.outcome,
      ...common
    };
  }

  const related = evaluations.filter(item => item.evaluation.normalizedBaseTitleMatch && item.evaluation.artistRelation.matched);
  const conflicting = evaluations.filter(item => item.evaluation.normalizedBaseTitleMatch && item.evaluation.outcome === "ARTIST_CONFLICT");
  const mismatch = related.filter(item => ["VERSION_MISMATCH", "UNSAFE_PROXY"].includes(item.evaluation.outcome));
  const failureStatus = mismatch.length ? "VERSION_MISMATCH" : conflicting.length ? "ARTIST_CONFLICT" : "NOT_FOUND";
  return {
    status: failureStatus,
    identityOutcome: failureStatus,
    finalIdentityOutcome: failureStatus,
    candidateIdentities: (mismatch.length ? mismatch : conflicting.length ? conflicting : evaluations).slice(0, 12).map(diagnosticsFor),
    canonicalCandidateSelected: null,
    canonicalizationReason: "",
    ambiguityResolvedBy: "",
    ...common
  };
}

function exactIdentityDiagnostics(request, selected = null, status = "NOT_FOUND", searchVariants = []) {
  const first = Array.isArray(selected?.candidateIdentities) ? selected.candidateIdentities[0] : null;
  const evidence = first?.identityDiagnostics || {};
  const failureTypes = ["NOT_FOUND", "AMBIGUOUS", "VERSION_MISMATCH", "ARTIST_CONFLICT", "UNSAFE_PROXY"];
  return {
    failureType: failureTypes.includes(status) ? status : "",
    identityOutcome: selected?.identityOutcome || status,
    requested: {
      artist: String(request?.artist || ""),
      title: String(request?.title || ""),
      album: String(request?.album || ""),
      mixVersion: String(request?.mixVersion || request?.version || "")
    },
    expectedLegacyEra: selected?.expectedLegacyEra
      ?? evidence.expectedLegacyEra
      ?? selected?.legacySearchDiagnostics?.expectedLegacyEra
      ?? null,
    expectedLegacyEraSource: selected?.expectedLegacyEraSource
      || evidence.expectedLegacyEraSource
      || selected?.legacySearchDiagnostics?.expectedLegacyEraSource
      || "",
    requestedArtistCredits: evidence.requestedArtistCredits || artistCreditList(request?.artist),
    candidateArtistCredits: evidence.candidateArtistCredits || first?.artistCredits || [],
    artistOverlapType: evidence.artistOverlapType || "",
    artistAliasApplied: Boolean(evidence.artistAliasApplied ?? first?.legacyIdentityDiagnostics?.artistAliasApplied),
    aliasSource: evidence.aliasSource || first?.legacyIdentityDiagnostics?.aliasSource || "",
    canonicalArtistCredits: evidence.canonicalArtistCredits || first?.legacyIdentityDiagnostics?.canonicalArtistCredits || [],
    artistCreditNormalizationRule: evidence.artistCreditNormalizationRule || first?.legacyIdentityDiagnostics?.artistCreditNormalizationRule || "",
    providerIdentityEvidence: evidence.providerIdentityEvidence || first?.legacyIdentityDiagnostics?.providerIdentityEvidence || null,
    normalizedBaseTitleMatch: evidence.normalizedBaseTitleMatch ?? null,
    canonicalMainMixApplied: Boolean(evidence.canonicalMainMixApplied ?? first?.legacyIdentityDiagnostics?.canonicalMainMixApplied),
    canonicalMainMixReason: evidence.canonicalMainMixReason || first?.legacyIdentityDiagnostics?.canonicalMainMixReason || "",
    artistCreditPreferenceApplied: Boolean(selected?.artistCreditPreferenceApplied ?? first?.artistCreditPreferenceApplied),
    artistCreditPreferenceReason: selected?.artistCreditPreferenceReason || first?.artistCreditPreferenceReason || "",
    canonicalPrincipalReleaseApplied: Boolean(selected?.canonicalPrincipalReleaseApplied ?? first?.canonicalPrincipalReleaseApplied),
    canonicalPrincipalReleaseReason: selected?.canonicalPrincipalReleaseReason || first?.canonicalPrincipalReleaseReason || "",
    canonicalPrincipalReleaseEvidence: selected?.canonicalPrincipalReleaseEvidence || first?.canonicalPrincipalReleaseEvidence || null,
    originalLineageEvidence: selected?.originalLineageEvidence || first?.originalLineageEvidence || null,
    requestedVersion: evidence.requestedVersion || versionInfo(request),
    candidateVersion: evidence.candidateVersion || first?.version || null,
    isrcMatch: evidence.isrcMatch ?? null,
    tidalIdMatch: evidence.tidalIdMatch ?? null,
    beatportIdMatch: evidence.beatportIdMatch ?? null,
    durationDeltaMs: evidence.durationDeltaMs ?? null,
    albumAgreement: evidence.albumAgreement ?? null,
    normalizedAlbumFamily: evidence.normalizedAlbumFamily ?? first?.legacyIdentityDiagnostics?.normalizedAlbumFamily ?? null,
    albumFamilyAgreement: evidence.albumFamilyAgreement ?? first?.legacyIdentityDiagnostics?.albumFamilyAgreement ?? null,
    strongIdentityOverrideApplied: evidence.strongIdentityOverrideApplied ?? first?.legacyIdentityDiagnostics?.strongIdentityOverrideApplied ?? false,
    strongIdentityOverrideReason: evidence.strongIdentityOverrideReason || first?.legacyIdentityDiagnostics?.strongIdentityOverrideReason || "",
    labelAgreement: evidence.labelAgreement ?? null,
    releaseDateAgreement: evidence.releaseDateAgreement ?? null,
    candidateConfidenceScore: evidence.candidateConfidenceScore ?? selected?.confidenceScore ?? null,
    rejectionReason: evidence.rejectionReason || selected?.rejectionReason || "",
    legacyIdentityDiagnostics: evidence.legacyIdentityDiagnostics
      || first?.legacyIdentityDiagnostics
      || null,
    candidatesCollapsedAsSameRecording: Boolean(selected?.candidatesCollapsedAsSameRecording),
    collapsedRecordingCount: Number(selected?.collapsedRecordingCount || 0),
    canonicalCandidateGroups: Array.isArray(selected?.canonicalCandidateGroups) ? selected.canonicalCandidateGroups : [],
    canonicalCandidateSelected: selected?.canonicalCandidateSelected || null,
    canonicalizationReason: selected?.canonicalizationReason || "",
    canonicalFallbackAttempted: Boolean(selected?.canonicalFallbackAttempted),
    canonicalFallbackCandidates: Array.isArray(selected?.canonicalFallbackCandidates) ? selected.canonicalFallbackCandidates : [],
    canonicalFallbackOutcome: selected?.canonicalFallbackOutcome || "",
    validatedIdentityReuse: Boolean(selected?.validatedIdentityReuse || evidence.validatedIdentityReuse),
    validatedIdentitySource: selected?.validatedIdentitySource || evidence.validatedIdentitySource || "",
    validatedIdentityLookup: selected?.validatedIdentityLookup || null,
    validatedIdentityReuseDiagnostics: selected?.validatedIdentityReuseDiagnostics || null,
    legacySearchDiagnostics: selected?.legacySearchDiagnostics || null,
    versionPreferenceApplied: Boolean(selected?.versionPreferenceApplied),
    topCandidateScore: selected?.topCandidateScore ?? null,
    runnerUpScore: selected?.runnerUpScore ?? null,
    confidenceMargin: selected?.confidenceMargin ?? null,
    legacyCanonicalPreferenceApplied: Boolean(selected?.legacyCanonicalPreferenceApplied),
    legacyCanonicalScore: selected?.legacyCanonicalScore ?? null,
    modernReinterpretationPenalty: selected?.modernReinterpretationPenalty ?? 0,
    originalEraCandidate: selected?.originalEraCandidate ?? false,
    eraGapYears: selected?.eraGapYears ?? null,
    ambiguityResolvedBy: selected?.ambiguityResolvedBy || "",
    finalIdentityOutcome: selected?.finalIdentityOutcome || selected?.identityOutcome || status,
    candidateIdentities: Array.isArray(selected?.candidateIdentities)
      ? selected.candidateIdentities
      : Array.isArray(selected?.matches) ? selected.matches.map(candidateIdentitySummary) : [],
    identityRules: status === "AMBIGUOUS"
      ? ["multiple-exact-tidal-candidates", ...(selected?.candidatesCollapsedAsSameRecording ? ["canonical-recording-collapse-insufficient-to-resolve"] : [])]
      : status === "VERSION_MISMATCH"
        ? ["artist-and-base-title-matched", "requested-version-not-exact"]
      : status === "ARTIST_CONFLICT" ? ["normalized-base-title-matched", "artist-identity-conflict"]
          : status === "UNSAFE_PROXY" ? ["identity-evidence-below-safe-threshold"]
            : status === "NOT_FOUND" ? ["no-exact-tidal-candidate"] : [],
    searchVariants: Array.isArray(searchVariants) ? searchVariants : []
  };
}

function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
}

async function abortable(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      onAbort = () => reject(new Error("Verification timed out."));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

function combineLegacySearchDiagnostics(request = {}, packets = []) {
  const valid = packets.filter(packet => packet && typeof packet === "object");
  if (!valid.length) return null;
  const latest = valid[valid.length - 1];
  const combined = {
    ...latest,
    queriesAttempted: valid.flatMap(packet => Array.isArray(packet.queriesAttempted) ? packet.queriesAttempted : []),
    candidateCountPerQuery: valid.flatMap(packet => Array.isArray(packet.candidateCountPerQuery) ? packet.candidateCountPerQuery : []),
    topCandidatesBeforeFilter: [...new Map(valid.flatMap(packet => packet.topCandidatesBeforeFilter || []).map(candidate => [candidate.id || `${candidate.artist}|${candidate.title}`, candidate])).values()]
      .sort((left, right) => Number(right.retrievalScore || 0) - Number(left.retrievalScore || 0)).slice(0, 12),
    topCandidatesAfterFilter: [...new Map(valid.flatMap(packet => packet.topCandidatesAfterFilter || []).map(candidate => [candidate.id || `${candidate.artist}|${candidate.title}`, candidate])).values()]
      .sort((left, right) => Number(right.retrievalScore || 0) - Number(left.retrievalScore || 0)).slice(0, 12),
    candidatePreFilterCounts: {
      input: valid.reduce((sum, packet) => sum + Number(packet.candidatePreFilterCounts?.input || 0), 0),
      accepted: valid.reduce((sum, packet) => sum + Number(packet.candidatePreFilterCounts?.accepted || 0), 0),
      rejected: valid.reduce((sum, packet) => sum + Number(packet.candidatePreFilterCounts?.rejected || 0), 0),
      rejectionReasons: {}
    },
    reasonCorrectCandidateWasNotSelected: ""
  };
  for (const packet of valid) {
    for (const [reason, count] of Object.entries(packet.candidatePreFilterCounts?.rejectionReasons || {})) {
      combined.candidatePreFilterCounts.rejectionReasons[reason] = (combined.candidatePreFilterCounts.rejectionReasons[reason] || 0) + Number(count || 0);
    }
  }
  combined.reasonCorrectCandidateWasNotSelected = combined.candidatePreFilterCounts.accepted
    ? "retrieved candidates survived pre-filtering but none passed exact identity validation"
    : "all returned rows failed the artist/title pre-filter";
  return combined;
}

async function verifyExactTracks(body, { tidal, roon, logger = () => {} }) {
  const raw = parseTrackList(body.tracks || body.candidates || body.request || "");
  if (!Array.isArray(raw) || !raw.length) throw Object.assign(new Error("Provide at least one track to verify."), { statusCode: 400 });
  const requested = raw.slice(0, bounded(body.max, 40, 1, 40)).map(parseTrack);
  const results = new Array(requested.length);
  const timeoutMs = bounded(body.perTrackTimeoutMs, 12000, 100, 30000);
  const concurrency = bounded(body.concurrency, 3, 1, 4);
  const checkRoon = body.checkRoon === true || body.checkRoon === "true" || body.requireRoonQueueable === true || body.requireRoonQueueable === "true";
  let next = 0;
  async function verify(index) {
    const request = requested[index];
    const row = { index, input: request, requestedArtist: request.artist || "", requestedTitle: request.title || "", status: "NOT_FOUND", verdict: "unverified", usable: false, versionExact: false, queueable: null, confidence: 0, error: "", identityOutcome: "NOT_FOUND", identityDiagnostics: null, tidal: { verified: false }, roon: { checked: false, queueable: null } };
    const id = String(request.tidalTrackId || request.id || tidalTrackIdFromUrl(request.tidalUrl || request.url) || "");
    if (!(request.artist && request.title) && !/^\d+$/.test(id)) {
      return { ...row, status: "INVALID", verdict: "invalid", reasons: ["Track needs artist/title or a TIDAL track URL/id."], identityDiagnostics: { failureType: "INVALID", candidateIdentities: [], identityRules: ["missing-artist-title-or-tidal-id"] } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let selected;
    try {
      if (!tidal.isConfigured()) throw new Error("TIDAL catalogue verification is not configured.");
      const searchPlans = typeof tidal.exactSearchPlans === "function"
        ? tidal.exactSearchPlans(request, { strict: false })
        : [];
      const initialPlan = searchPlans[0] || null;
      const candidates = await abortable(tidal.searchExactCandidates(request, { id, searchPlan: initialPlan, signal: controller.signal, timeoutMs, logger }), controller.signal);
      const retrievalPackets = [candidates?.legacySearchDiagnostics].filter(Boolean);
      const identityRequest = typeof tidal.requestedTrackForIdentity === "function"
        ? tidal.requestedTrackForIdentity(request)
        : request;
      selected = request.artist && request.title ? chooseExact(identityRequest, candidates, {
        highConfidenceThreshold: body.identityHighConfidenceThreshold,
        confidenceMargin: body.identityConfidenceMargin,
        alternateVersionThreshold: body.identityAlternateVersionThreshold
      }) : candidates.length === 1 ? { status: "VERIFIED_TIDAL_ONLY", identityOutcome: "VERIFIED_EXACT", confidenceScore: 1, match: candidates[0] } : { status: "NOT_FOUND", identityOutcome: "NOT_FOUND", candidateIdentities: candidates.slice(0, 12).map(candidateIdentitySummary) };
      row.searchVariants = [id ? "tidal_id" : "exact_artist_title"];
      let canonicalFallbackAttempted = false;
      const canonicalFallbackCandidates = [];
      if (!id && ["NOT_FOUND", "VERSION_MISMATCH", "AMBIGUOUS"].includes(selected.status)) {
        canonicalFallbackAttempted = true;
        const plans = searchPlans.length ? searchPlans : [
          { searchStage: "exact-artist-base-title", query: `${request.artist || ""} ${baseTitle(request.title)}`, artistConstraintApplied: Boolean(request.artist), titleConstraintApplied: true },
          { searchStage: "artist-album-base-title", query: `${request.artist || ""} ${request.album || ""} ${baseTitle(request.title)}`, artistConstraintApplied: Boolean(request.artist), titleConstraintApplied: true, albumConstraintApplied: Boolean(request.album) },
          { searchStage: "artist-era-base-title", query: `${request.artist || ""} ${baseTitle(request.title)} ${request.recordingYear || request.originalReleaseYear || request.year || ""}`, artistConstraintApplied: Boolean(request.artist), titleConstraintApplied: true, eraConstraintApplied: Boolean(request.recordingYear || request.originalReleaseYear || request.year) },
          { searchStage: "title-only-fallback", query: request.title, titleConstraintApplied: true, titleOnlyFallback: true }
        ];
        const seenQueries = new Set();
        for (const plan of plans) {
          const label = plan.searchStage || "canonical-fallback";
          const queryOverride = cleanText(plan.query);
          if (!queryOverride) continue;
          const query = normalizeCatalogText(queryOverride);
          if (!query || seenQueries.has(query)) continue;
          seenQueries.add(query);
          if (query === normalizeCatalogText(`${request.artist || ""} ${request.title || ""}`)) continue;
          row.searchVariants.push(`canonical_fallback:${label}`);
          const fallbackTrack = { ...request, title: baseTitle(request.title) || request.title };
          const fallback = await abortable(tidal.searchExactCandidates(fallbackTrack, {
            queryOverride,
            searchPlan: plan,
            requestedTrack: request,
            signal: controller.signal,
            timeoutMs,
            logger: entry => logger({ ...entry, track: { artist: request.artist, title: request.title }, searchVariant: `canonical_fallback:${label}` })
          }), controller.signal);
          retrievalPackets.push(fallback?.legacySearchDiagnostics);
          canonicalFallbackCandidates.push({ label, query, returnedCount: fallback.length, candidateIds: fallback.map(candidate => String(candidate.id || "")).filter(Boolean) });
          selected = chooseExact(identityRequest, [...candidates, ...fallback], {
            highConfidenceThreshold: body.identityHighConfidenceThreshold,
            confidenceMargin: body.identityConfidenceMargin,
            alternateVersionThreshold: body.identityAlternateVersionThreshold
          });
          if (selected.match) break;
        }
      }
      if (!selected.match && typeof tidal.findValidatedIdentity === "function") {
        const validatedSelection = await tidal.findValidatedIdentity(request, {
          highConfidenceThreshold: body.identityHighConfidenceThreshold,
          confidenceMargin: body.identityConfidenceMargin,
          alternateVersionThreshold: body.identityAlternateVersionThreshold
        });
        if (validatedSelection?.match) {
          selected = {
            ...validatedSelection,
            validatedIdentityReuse: true,
            validatedIdentitySource: validatedSelection.validatedIdentitySource || "validated-identity-lookup",
            canonicalFallbackAttempted,
            canonicalFallbackCandidates,
            canonicalFallbackOutcome: "validated-identity-reuse",
            legacySearchDiagnostics: combineLegacySearchDiagnostics(request, retrievalPackets)
          };
        }
      }
      if (!selected.match && tidal.lastValidatedIdentityReuseDiagnostics) {
        selected = {
          ...selected,
          validatedIdentityLookup: tidal.lastValidatedIdentityLookup || null,
          validatedIdentityReuseDiagnostics: tidal.lastValidatedIdentityReuseDiagnostics
        };
      }
      selected = {
        ...selected,
        canonicalFallbackAttempted,
        canonicalFallbackCandidates,
        canonicalFallbackOutcome: selected.match ? "resolved" : selected.status,
        legacySearchDiagnostics: combineLegacySearchDiagnostics(request, retrievalPackets)
      };
    } catch (error) {
      return { ...row, status: "API_ERROR", verdict: "tidal_error", error: controller.signal.aborted ? "TIDAL verification timed out." : error.message, reasons: [controller.signal.aborted ? "TIDAL verification timed out." : error.message], identityDiagnostics: { failureType: "API_ERROR", candidateIdentities: [], identityRules: [controller.signal.aborted ? "tidal-verification-timeout" : "tidal-catalog-request-failed"] } };
    } finally { clearTimeout(timer); }
    row.status = selected.status;
    row.identityOutcome = selected.identityOutcome || selected.status;
    row.verdict = selected.status.toLowerCase();
    if (!selected.match) return {
      ...row,
      matches: selected.matches || [],
      identityDiagnostics: exactIdentityDiagnostics(request, selected, selected.status, row.searchVariants)
    };
    const track = selected.match;
    Object.assign(row, { track, matchedArtist: track.artist, matchedTitle: track.title, album: track.album, durationMs: track.durationMs, releaseDate: track.releaseDate, tidalTrackId: track.id, tidalUrl: track.tidalUrl, confidence: Number(selected.confidenceScore || 1), versionExact: selected.identityOutcome !== "VERIFIED_BASE_TITLE_WITH_VERSION_PROXY", usable: true, verdict: "verified", tidal: { verified: true, match: track } });
    row.identityDiagnostics = exactIdentityDiagnostics(request, selected, selected.status, row.searchVariants);
    const minDuration = Number(body.minDurationMs || Number(body.minDurationSeconds || 0) * 1000 || Number(body.minDurationMinutes || 0) * 60000);
    if (minDuration && !(track.durationMs >= minDuration)) return { ...row, usable: false, status: "DURATION_MISMATCH", verdict: "duration_too_short", identityDiagnostics: { failureType: "DURATION_MISMATCH", candidateIdentities: [candidateIdentitySummary(track)], identityRules: ["minimum-duration-rejected"] } };
    row.status = "TIDAL_VERIFIED_ROON_PENDING";
    row.roon = { checked: false, queueable: null, zoneId: body.zoneId || "", reason: "Exact TIDAL identity saved. Roon resolution has not been requested.", failureType: "not_checked" };
    return row;
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requested.length) }, async () => {
    while (next < requested.length) { const index = next++; results[index] = await verify(index); }
  }));
  const usable = results.filter(t => t.usable).map(t => ({ ...t.track, exactVerification: true }));
  const result = { mode: "exact_track_verification", latestResultSource: "exact_verification", requestedCount: raw.length, parsedCount: raw.length, checkedCount: results.length, truncated: raw.length > requested.length, verifiedCount: results.filter(t => t.tidal.verified).length, usableCount: usable.length, roonQueueableCount: 0, notFoundCount: results.filter(t => t.status === "NOT_FOUND").length, ambiguousCount: results.filter(t => t.status === "AMBIGUOUS").length, versionMismatchCount: results.filter(t => t.status === "VERSION_MISMATCH").length, artistConflictCount: results.filter(t => t.status === "ARTIST_CONFLICT").length, unsafeProxyCount: results.filter(t => t.status === "UNSAFE_PROXY").length, apiErrorCount: results.filter(t => t.status === "API_ERROR").length, errorCount: results.filter(t => t.status === "API_ERROR").length, tracks: results, usable };
  if (checkRoon) await require("./roonExactResolution").resolveVerifiedTracksForRoon(result, body, { roon, logger });
  return result;
}

const exactQueueTails = new WeakMap();
function queueExactTracks(result, input = {}, roon, dependencies = {}) {
  if (!result?.tracks) return Promise.reject(Object.assign(new Error("No saved exact verification result."), { statusCode: 400 }));
  const work = (exactQueueTails.get(result) || Promise.resolve()).catch(() => {}).then(() => queueExactBatch(result, input, roon, dependencies));
  exactQueueTails.set(result, work.catch(() => {}));
  return work;
}
async function queueExactBatch(result, input, roon, { save = () => {}, logger = () => {}, bridge } = {}) {
  if (input.mode && input.mode !== "append") throw Object.assign(new Error("Exact verified queue currently supports append only."), { statusCode: 400 });
  let rows = result.tracks.filter(row => row.usable && row.tidal?.verified);
  if (Array.isArray(input.trackIds)) rows = rows.filter(row => input.trackIds.map(String).includes(String(row.tidalTrackId)));
  rows = rows.slice(0, bounded(input.count, 40, 1, 40));
  if (!rows.length) throw Object.assign(new Error("No saved usable TIDAL-verified tracks."), { statusCode: 400 });
  const alreadyQueuedCount = rows.filter(row => row.queuedAt).length;
  const uncertain = rows.filter(row => row.queueAttemptedAt && !row.queuedAt);
  const pending = rows.filter(row => !row.queuedAt && !row.queueAttemptedAt);
  const zoneId = input.zoneId || pending[0]?.roon?.zoneId;
  const resolve = require("./roonExactResolution").resolveVerifiedTracksForRoon;
  await resolve(result, { ...input, zoneId, trackIds: pending.map(row => String(row.tidalTrackId)), allowBridge: input.allowBridge !== false }, { roon, save, logger, bridge });
  const ready = pending.filter(row => row.queueable === true && row.roon?.queueToken);
  const failed = [...pending.filter(row => !ready.includes(row)), ...uncertain].map(row => ({
    index: row.index, tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle,
    status: row.status, error: row.queueAttemptedAt ? "Previous queue action outcome is uncertain; inspect Roon before resending." : row.bridge?.reason || row.roon?.reason || row.status,
    bridge: row.bridge || null
  }));
  const queued = [];
  if (ready.length) {
    const tracks = ready.map(row => ({ ...row.track, exactVerification: true, verifiedQueueToken: row.roon.queueToken }));
    const response = await roon.queueTracks(tracks, zoneId, {
      mode: "append", targetCount: tracks.length, preferExtendedMixes: false,
      onQueueStart: (_track, index) => { ready[index].queueAttemptedAt = new Date().toISOString(); save(result); },
      onQueueResult: (index, ok) => {
        if (ok) { ready[index].queuedAt = new Date().toISOString(); ready[index].status = "ROON_QUEUED"; ready[index].queueable = false; }
        save(result);
      }
    });
    for (const item of response.queued || []) {
      const row = ready[item.index]; row.queuedAt ||= new Date().toISOString(); row.status = "ROON_QUEUED"; row.queueable = false;
      queued.push({ index: row.index, tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle, action: item.action });
    }
    for (const item of response.failed || []) {
      const row = ready[item.index]; failed.push({ index: row.index, tidalTrackId: row.tidalTrackId, artist: row.matchedArtist, title: row.matchedTitle, error: item.reason });
    }
  }
  result.roonQueueableCount = result.tracks.filter(row => row.queueable === true).length;
  save(result);
  return { source: "exact_verification", requestedToQueue: rows.length, alreadyQueuedCount, queued: queued.length, failed: failed.length,
    queuedCount: queued.length, failedCount: failed.length, queuedTracks: queued, failedTracks: failed };
}

module.exports = {
  displayText,
  normalize,
  artistCreditList,
  artistCreditRelation,
  artists,
  parseTrack,
  parseTrackList,
  exactIntent,
  exactMatch,
  baseTitle,
  versionInfo,
  canonicalTitleIdentity,
  durationMsFor,
  durationFormCompatibility,
  recordingForm,
  eraProfile,
  eraCompatibility,
  IDENTITY_DISAMBIGUATION_DEFAULTS,
  normalizeDisambiguationOptions,
  canonicalVersionPreference,
  canonicalMainMixEvidence,
  canonicalTwelveInchClubEvidence,
  scoreTidalIdentity,
  sameTidalRecording,
  chooseExact,
  candidateIdentitySummary,
  exactIdentityDiagnostics,
  verifyExactTracks,
  queueExactTracks
};
