"use strict";

// The embedding is deliberately kept as the first-stage retrieval signal. This
// module is a pure, shadow-only usefulness filter/reranker for the retrieved
// rows. It must not be used to change production recommendation ordering.

const SECOND_STAGE_VERSION = "4";
const MAX_SOURCE_DURATION_MS = 45 * 60 * 1000;
const LONG_FORM_DURATION_MS = 8 * 60 * 1000;
const SHORT_FORM_DURATION_MS = 5 * 60 * 1000;
const LOW_SIMILARITY_CROSS_GENRE = 0.72;
const STRONG_CROSS_GENRE_SIMILARITY = 0.88;

const DEFAULT_SECOND_STAGE_CONFIG = Object.freeze({
  maxSourceDurationMs: MAX_SOURCE_DURATION_MS,
  lowSimilarityCrossGenre: LOW_SIMILARITY_CROSS_GENRE,
  strongCrossGenreSimilarity: STRONG_CROSS_GENRE_SIMILARITY,
  maxArrangementBonusWhenGenreRisk: 0,
  genreEvidenceBonusScale: Object.freeze({
    strong: 1,
    medium: 0.6,
    weak: 0.25,
    scene: 0.15
  }),
  genreAdjustments: Object.freeze({
    exact: 0.05,
    compatible: 0.06,
    adjacent: 0.01,
    uncertain: -0.08,
    "weak-conflict": -0.10,
    conflicting: -0.18,
    incompatible: -0.24
  })
});

function mergeSecondStageConfig(overrides = {}) {
  const value = overrides && typeof overrides === "object" ? overrides : {};
  const genreAdjustments = value.genreAdjustments && typeof value.genreAdjustments === "object"
    ? value.genreAdjustments
    : {};
  const genreEvidenceBonusScale = value.genreEvidenceBonusScale && typeof value.genreEvidenceBonusScale === "object"
    ? value.genreEvidenceBonusScale
    : {};
  return {
    ...DEFAULT_SECOND_STAGE_CONFIG,
    ...value,
    genreEvidenceBonusScale: {
      ...DEFAULT_SECOND_STAGE_CONFIG.genreEvidenceBonusScale,
      ...genreEvidenceBonusScale
    },
    genreAdjustments: {
      ...DEFAULT_SECOND_STAGE_CONFIG.genreAdjustments,
      ...genreAdjustments
    }
  };
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numberValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function round(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(/[,;|]/).map(cleanText).filter(Boolean);
}

function trackMetadata(track = {}) {
  if (!track || typeof track !== "object") return {};
  let nested = track.metadata;
  if (typeof nested === "string") {
    try { nested = JSON.parse(nested); } catch { nested = {}; }
  }
  return nested && typeof nested === "object" ? nested : {};
}

function field(track, ...names) {
  const metadata = trackMetadata(track);
  for (const name of names) {
    const direct = track?.[name];
    if (direct !== undefined && direct !== null && direct !== "") return direct;
    const nested = metadata[name];
    if (nested !== undefined && nested !== null && nested !== "") return nested;
  }
  return "";
}

function identityKey(track = {}) {
  return cleanText(field(track, "identityKey", "identity_key"));
}

function providerIdentity(track = {}) {
  const identity = identityKey(track);
  if (/^(?:tidal|beatport|isrc):/i.test(identity)) return identity;
  if (cleanText(field(track, "tidalId", "tidalTrackId", "tidal_id"))) return "tidal";
  if (cleanText(field(track, "beatportId", "beatportTrackId", "beatport_track_id"))) return "beatport";
  return "";
}

function genreValues(track = {}) {
  return [
    field(track, "genre"), field(track, "genres"),
    field(track, "subgenre"), field(track, "subgenres"),
    field(track, "beatportGenre", "beatport_genre"),
    field(track, "beatportSubgenre", "beatport_subgenre")
  ].flatMap(asArray).map(cleanText).filter(Boolean);
}

const GENERIC_GENRE_TERMS = new Set([
  "dance", "dance music", "electronic", "electronic music", "music", "various", "various artists", "other", "unknown"
]);

function genreEntriesFromObject(value, source) {
  if (!value || typeof value !== "object") return [];
  const values = (raw) => (Array.isArray(raw) ? raw : [raw]).flatMap((item) => {
    if (item && typeof item === "object") return [item.name || item.label || item.title || item.value || ""];
    return asArray(item);
  });
  return [
    ["genre", "genre"], ["genres", "genre"],
    ["subgenre", "subgenre"], ["subgenres", "subgenre"],
    ["beatportGenre", "genre"], ["beatport_genre", "genre"],
    ["beatportSubgenre", "subgenre"], ["beatport_subgenre", "subgenre"]
  ].flatMap(([name, kind]) => values(value[name]).map((rawValue) => ({
    value: cleanText(rawValue), kind, source
  })));
}

function usableGenreEntry(entry) {
  const value = cleanText(entry?.value);
  return value && !GENERIC_GENRE_TERMS.has(normalized(value)) ? { ...entry, value } : null;
}

function explicitGenreEvidence(track = {}) {
  const metadata = trackMetadata(track);
  const entries = [
    ...genreEntriesFromObject(track, "track-metadata"),
    ...genreEntriesFromObject(metadata, "stored-metadata"),
    ...genreEntriesFromObject(track.metadataEnrichment || track.metadata_enrichment, "provider-metadata"),
    ...genreEntriesFromObject(track.tidal, "tidal-metadata"),
    ...genreEntriesFromObject(metadata.tidal, "tidal-metadata"),
    ...genreEntriesFromObject(track.beatport, "beatport-metadata"),
    ...genreEntriesFromObject(metadata.beatport, "beatport-metadata")
  ];
  const dedupe = new Map();
  for (const entry of entries) {
    const value = cleanText(entry.value);
    if (!value) continue;
    const key = `${normalized(value)}|${entry.source}|${entry.kind}`;
    if (!dedupe.has(key)) dedupe.set(key, { ...entry, usable: Boolean(usableGenreEntry(entry)) });
  }
  return [...dedupe.values()];
}

function confidenceWeight(value) {
  const state = cleanText(value).toLowerCase();
  return {
    exact: 1,
    compatible: 0.82,
    adjacent: 0.62,
    uncertain: 0.25,
    conflicting: 0.15,
    incompatible: 0
  }[state] ?? 0.25;
}

function normalizeGenreEvidence(value, fallbackSource = "stored-evidence") {
  const entries = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.inferred)
    ? value.inferred
    : [];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [{ value: cleanText(entry), source: fallbackSource, confidence: "uncertain" }];
    if (!entry || typeof entry !== "object") return [];
    const rawValue = entry.value || entry.genre || entry.subgenre || entry.label;
    const cleanValue = cleanText(rawValue);
    return cleanValue ? [{
      value: cleanValue,
      source: cleanText(entry.source || entry.inferenceSource) || fallbackSource,
      confidence: cleanText(entry.confidence || entry.confidenceState).toLowerCase() || "uncertain"
    }] : [];
  });
}

function genreEvidenceFor(track = {}, { genreResolver = null, context = {} } = {}) {
  const explicit = explicitGenreEvidence(track);
  let inferred = [];
  if (typeof genreResolver === "function") {
    try {
      inferred = normalizeGenreEvidence(genreResolver({ track, ...context }), "stored-evidence");
    } catch {
      inferred = [];
    }
  }
  const familyEvidence = new Map();
  const add = (entry, isExplicit) => {
    const usable = usableGenreEntry(entry);
    if (!usable) return;
    const families = genreFamilies({ genre: usable.value });
    for (const family of families) {
      const weight = (isExplicit ? 1 : confidenceWeight(entry.confidence)) * (isExplicit ? 1 : 0.9);
      const current = familyEvidence.get(family) || { family, weight: 0, entries: [] };
      current.weight += weight;
      current.entries.push({ ...entry, family, explicit: isExplicit });
      familyEvidence.set(family, current);
    }
  };
  explicit.forEach((entry) => add(entry, true));
  inferred.forEach((entry) => add(entry, false));
  const families = [...familyEvidence.values()].sort((left, right) => right.weight - left.weight || left.family.localeCompare(right.family));
  const explicitFamilies = new Set(explicit.flatMap((entry) => genreFamilies({ genre: entry.value })));
  const inferredFamilies = new Set(inferred.flatMap((entry) => genreFamilies({ genre: entry.value })));
  const explicitFamilySets = explicit
    .map((entry) => new Set(genreFamilies({ genre: entry.value })))
    .filter((set) => set.size);
  const explicitConflict = explicitFamilySets.some((left, index) => explicitFamilySets
    .slice(index + 1)
    .some((right) => ![...left].some((family) => right.has(family))));
  const hasExplicit = explicitFamilies.size > 0;
  const hasInferred = inferredFamilies.size > 0;
  let confidence = "uncertain";
  if (hasExplicit && explicitConflict) confidence = "conflicting";
  else if (hasExplicit) confidence = "exact";
  else if (hasInferred) {
    const reliable = inferred.some((entry) => confidenceWeight(entry.confidence) >= confidenceWeight("compatible")
      && !["neighbor-metadata", "stored-evidence"].includes(entry.source));
    confidence = reliable ? "compatible" : "uncertain";
  }
  if (!hasExplicit && families.length > 1 && families[1].weight >= families[0].weight * 0.75) confidence = "conflicting";
  return {
    explicit,
    inferred,
    families: families.map((entry) => entry.family),
    familyEvidence: families.map(({ family, weight, entries }) => ({ family, weight: round(weight), entries })),
    sources: [...new Set(inferred.map((entry) => entry.source).filter(Boolean))],
    confidence,
    explicitConflict
  };
}

const GENRE_FAMILIES = [
  ["drum-and-bass", /\b(?:drum n bass|drum and bass|dnb|jungle)\b/],
  ["hip-hop", /\b(?:hip hop|rap|trap)\b/],
  ["r-and-b", /\b(?:r&b|rnb|rhythm and blues)\b/],
  ["metal", /\bmetal\b/],
  ["rock", /\b(?:rock|indie rock|alternative)\b/],
  ["classical", /\b(?:classical|orchestral)\b/],
  ["jazz", /\bjazz\b/],
  ["country", /\bcountry\b/],
  ["soul-funk-disco", /\b(?:soul|funk|disco|nu disco)\b/],
  ["dubstep", /\bdubstep\b/],
  ["garage", /\b(?:garage|ukg|2 step)\b/],
  ["breakbeat", /\b(?:breakbeat|breaks)\b/],
  ["trance", /\btrance\b/],
  ["techno", /\btechno\b/],
  ["house", /\b(?:house|deep house|progressive house|tech house|electro house|melodic house)\b/],
  ["electronica", /\b(?:electronica|electronic|electro|idm|downtempo)\b/],
  ["ambient", /\b(?:ambient|drone|new age)\b/],
  ["pop", /\bpop\b/],
  ["latin", /\blatin\b/]
];

const ELECTRONIC_FAMILIES = new Set([
  "house", "techno", "trance", "electronica", "ambient", "garage",
  "breakbeat", "drum-and-bass", "dubstep"
]);

function genreFamilies(track = {}) {
  const values = genreValues(track).map(normalized).filter(Boolean);
  const families = new Set();
  for (const value of values) {
    for (const [family, pattern] of GENRE_FAMILIES) {
      if (pattern.test(value)) families.add(family);
    }
  }
  return [...families];
}

function sameFamilyOrAdjacent(left, right) {
  const overlap = left.some((family) => right.includes(family));
  if (overlap) return "compatible";
  if (left.some((family) => ELECTRONIC_FAMILIES.has(family))
    && right.some((family) => ELECTRONIC_FAMILIES.has(family))) return "adjacent";
  return "incompatible";
}

const GENRE_STRENGTH_RANK = Object.freeze({ weak: 1, medium: 2, strong: 3 });
const HIGH_QUALITY_GENRE_SOURCES = new Set([
  "tidal-metadata", "tidal-enrichment", "beatport-metadata", "beatport-enrichment",
  "stored-provider-enrichment", "sonic-review-profile", "sonic-review-session"
]);
const SUPPORTING_GENRE_SOURCES = new Set([
  "artist-history", "label-history", "reviewed-relationship", "sonic-review-session"
]);
const LOW_QUALITY_GENRE_SOURCES = new Set(["neighbor-metadata", "stored-evidence"]);
const SCENE_EVIDENCE_SOURCES = new Set([
  "artist-history", "label-history", "reviewed-relationship", "sonic-review-profile",
  "sonic-review-session", "neighbor-metadata"
]);

function evidenceEntries(evidence = {}) {
  return [
    ...(Array.isArray(evidence.explicit) ? evidence.explicit : []).map((entry) => ({ ...entry, explicit: true })),
    ...(Array.isArray(evidence.inferred) ? evidence.inferred : []).map((entry) => ({ ...entry, explicit: false }))
  ].filter((entry) => usableGenreEntry(entry) && genreFamilies({ genre: entry.value }).length);
}

function genreEvidenceStrength(evidence = {}) {
  const entries = evidenceEntries(evidence);
  const explicit = entries.filter((entry) => entry.explicit);
  const inferred = entries.filter((entry) => !entry.explicit);
  const highQuality = inferred.filter((entry) => HIGH_QUALITY_GENRE_SOURCES.has(cleanText(entry.source).toLowerCase())
    && confidenceWeight(entry.confidence) >= confidenceWeight("compatible"));
  const supporting = inferred.filter((entry) => SUPPORTING_GENRE_SOURCES.has(cleanText(entry.source).toLowerCase())
    && confidenceWeight(entry.confidence) >= confidenceWeight("uncertain"));
  const lowQuality = inferred.filter((entry) => LOW_QUALITY_GENRE_SOURCES.has(cleanText(entry.source).toLowerCase()));
  const sourceCount = new Set(entries.map((entry) => cleanText(entry.source).toLowerCase()).filter(Boolean)).size;
  let level = "weak";
  if (explicit.length || highQuality.length) level = "strong";
  else if (supporting.length >= 2 || (supporting.length && sourceCount >= 2)) level = "medium";
  return {
    level,
    score: level === "strong" ? 1 : level === "medium" ? 0.6 : 0.25,
    explicitCount: explicit.length,
    inferredCount: inferred.length,
    highQualityCount: highQuality.length,
    supportingCount: supporting.length,
    lowQualityCount: lowQuality.length,
    sourceCount
  };
}

function genreBonusEvidence(anchorStrength, candidateStrength, sceneEvidenceUsed = [], config = {}, relationship = "") {
  const scale = config.genreEvidenceBonusScale || DEFAULT_SECOND_STAGE_CONFIG.genreEvidenceBonusScale;
  const level = (strength) => cleanText(strength?.level).toLowerCase() || "weak";
  const anchorLevel = level(anchorStrength);
  const candidateLevel = level(candidateStrength);
  const weakerLevel = [anchorLevel, candidateLevel].sort((left, right) =>
    (GENRE_STRENGTH_RANK[left] || 1) - (GENRE_STRENGTH_RANK[right] || 1))[0];
  const weakerWeight = Number(scale[weakerLevel]);
  const sharedFamilyEvidenceWeight = Number.isFinite(weakerWeight)
    ? clamp(weakerWeight)
    : clamp(Math.min(anchorStrength?.score || 0.25, candidateStrength?.score || 0.25));
  const configuredSceneWeight = Number(scale.scene);
  const sceneStep = Number.isFinite(configuredSceneWeight) ? configuredSceneWeight : 0.15;
  const sceneEvidenceWeight = sceneEvidenceUsed.length
    ? clamp(Math.min(0.3, sceneEvidenceUsed.length * sceneStep))
    : 0;
  const combinedWeight = clamp(Math.min(1, sharedFamilyEvidenceWeight + sceneEvidenceWeight));
  let reason = "no-positive-genre-bonus";
  if (relationship === "exact" || relationship === "compatible" || relationship === "adjacent") {
    if (anchorLevel === "strong" && candidateLevel === "strong") reason = "strong-shared-genre-evidence";
    else if (sceneEvidenceWeight > 0) reason = "asymmetric-genre-evidence-softened-by-scene";
    else if (weakerLevel === "weak") reason = "weak-shared-family-evidence-scaled";
    else reason = "genre-evidence-strength-scaled";
  }
  return {
    anchor: anchorLevel,
    candidate: candidateLevel,
    sharedFamilyEvidenceWeight: round(sharedFamilyEvidenceWeight),
    sceneEvidenceWeight: round(sceneEvidenceWeight),
    combinedWeight: round(combinedWeight),
    reason
  };
}

function genreEvidenceValues(evidence = {}, sources = null) {
  const allowedSources = sources ? new Set(sources) : null;
  return evidenceEntries(evidence)
    .filter((entry) => !allowedSources || allowedSources.has(cleanText(entry.source).toLowerCase()))
    .map((entry) => normalized(entry.value))
    .filter(Boolean);
}

function hasSource(evidence = {}, source) {
  return (Array.isArray(evidence.sources) ? evidence.sources : [])
    .map((value) => cleanText(value).toLowerCase())
    .includes(source);
}

function sceneEvidenceFor(anchorGenre, candidateGenre, review, { anchorFamilies = [], candidateFamilies = [] } = {}) {
  const used = [];
  if (review?.evidence?.includes("positive-review-history")) used.push("positive-review-history");
  for (const source of ["artist-history", "label-history", "reviewed-relationship"]) {
    if (!hasSource(anchorGenre, source) || !hasSource(candidateGenre, source)) continue;
    const anchorValues = new Set(genreEvidenceValues(anchorGenre, [source]));
    if (genreEvidenceValues(candidateGenre, [source]).some((value) => anchorValues.has(value))) {
      used.push(`${source}-overlap`);
    }
  }
  if (hasSource(anchorGenre, "neighbor-metadata") && hasSource(candidateGenre, "neighbor-metadata")) {
    used.push("shared-neighbor-metadata");
  }
  const bothElectronic = anchorFamilies.some((family) => ELECTRONIC_FAMILIES.has(family))
    && candidateFamilies.some((family) => ELECTRONIC_FAMILIES.has(family));
  const sceneValues = [...genreEvidenceValues(anchorGenre), ...genreEvidenceValues(candidateGenre)];
  if (bothElectronic && sceneValues.some((value) => /\b(?:melodic|progressive|hypnotic|deep|dark)\b/.test(value))) {
    used.push("shared-melodic-progressive-neighborhood");
  } else if (bothElectronic && [...SCENE_EVIDENCE_SOURCES].some((source) => hasSource(anchorGenre, source))
    && [...SCENE_EVIDENCE_SOURCES].some((source) => hasSource(candidateGenre, source))) {
    used.push("shared-electronic-scene");
  }
  return [...new Set(used)];
}

function versionDescriptor(track = {}) {
  const text = normalized([
    field(track, "mixVersion", "mixName", "version"),
    field(track, "title")
  ].filter(Boolean).join(" "));
  const descriptors = [
    "extended", "radio", "original", "remix", "edit", "dub", "live",
    "acoustic", "instrumental", "club", "vip", "version", "mix"
  ];
  return descriptors.filter((descriptor) => text.includes(descriptor));
}

function baseTitle(track = {}) {
  return normalized(field(track, "title"))
    .replace(/\b(?:extended|radio|original|remix|edit|dub|live|acoustic|instrumental|club|vip|version|mix)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameRecording(anchor = {}, candidate = {}) {
  const anchorIsrc = normalized(field(anchor, "isrc"));
  const candidateIsrc = normalized(field(candidate, "isrc"));
  if (anchorIsrc && candidateIsrc && anchorIsrc === candidateIsrc) {
    const anchorVersions = versionDescriptor(anchor);
    const candidateVersions = versionDescriptor(candidate);
    if (anchorVersions.length && candidateVersions.length) return anchorVersions.join("|") === candidateVersions.join("|");
    return !anchorVersions.length && !candidateVersions.length;
  }
  const anchorArtist = normalized(field(anchor, "artist"));
  const candidateArtist = normalized(field(candidate, "artist"));
  const anchorTitle = baseTitle(anchor);
  const candidateTitle = baseTitle(candidate);
  if (!anchorArtist || !candidateArtist || !anchorTitle || !candidateTitle) return false;
  const anchorVersions = versionDescriptor(anchor);
  const candidateVersions = versionDescriptor(candidate);
  const sameVersion = anchorVersions.length && candidateVersions.length
    ? anchorVersions.join("|") === candidateVersions.join("|")
    : !anchorVersions.length && !candidateVersions.length;
  return anchorArtist === candidateArtist && anchorTitle === candidateTitle && sameVersion;
}

function durationMs(track = {}) {
  return numberValue(
    field(track, "audioDurationMs", "audio_duration_ms"),
    field(track, "durationMs", "duration_ms"),
    Number(field(track, "duration")) > 0 ? Number(field(track, "duration")) * 1000 : null
  );
}

function suspiciousMetadata(track = {}) {
  const artist = normalized(field(track, "artist"));
  const title = normalized(field(track, "title"));
  const sourcePath = normalized(field(track, "sourcePath", "source_path", "filePath", "file_path"));
  const suspiciousFields = [];
  if (/^(?:title|track|song|audio|file|unknown|untitled|artist|temp|copy)\d*$/.test(title)) suspiciousFields.push("generic-title");
  if (/^(?:artist|unknown|untitled|various artists)\d*$/.test(artist)) suspiciousFields.push("generic-artist");
  if (/\b(?:temp|tmp|unknown|untitled|incomplete|corrupt|download|copy)\b/.test(sourcePath)) suspiciousFields.push("suspicious-source-path");
  return suspiciousFields;
}

function metadataIntegrity(anchor = {}, candidate = {}) {
  const candidateArtist = cleanText(field(candidate, "artist"));
  const candidateTitle = cleanText(field(candidate, "title"));
  const metadata = trackMetadata(candidate);
  const issues = [];
  const suspicious = suspiciousMetadata(candidate);
  if (!candidateArtist) issues.push("missing-artist");
  if (!candidateTitle) issues.push("missing-title");
  if (!identityKey(candidate) && !field(candidate, "tidalId", "tidalTrackId", "tidal_id")) issues.push("missing-provider-identity");
  for (const [left, right, issue] of [
    [candidateArtist, cleanText(metadata.artist), "artist-metadata-conflict"],
    [candidateTitle, cleanText(metadata.title), "title-metadata-conflict"]
  ]) {
    if (left && right && normalized(left) !== normalized(right)) issues.push(issue);
  }
  const anchorArtist = normalized(field(anchor, "artist"));
  const candidateIsrc = normalized(field(candidate, "isrc"));
  const anchorIsrc = normalized(field(anchor, "isrc"));
  const strongIdentity = Boolean(providerIdentity(candidate) || candidateIsrc);
  let adjustment = 0;
  if (candidateArtist && candidateTitle) adjustment += 0.025;
  if (issues.includes("missing-artist") || issues.includes("missing-title")) adjustment -= 0.16;
  if (issues.some((issue) => issue.includes("metadata-conflict"))) adjustment -= 0.12;
  if (suspicious.length) adjustment -= 0.12;
  if (anchorArtist && candidateIsrc && anchorIsrc && anchorIsrc === candidateIsrc) issues.push("same-isrc");
  return {
    score: round(clamp(0.75 + adjustment, 0, 1)),
    adjustment: round(adjustment),
    issues: [...new Set(issues)],
    suspiciousFields: suspicious,
    identityConfidence: strongIdentity ? "provider-or-isrc" : candidateArtist && candidateTitle ? "metadata-only" : "low"
  };
}

function arrangementCompatibility(anchor = {}, candidate = {}) {
  const anchorDuration = durationMs(anchor);
  const candidateDuration = durationMs(candidate);
  const anchorVersion = versionDescriptor(anchor);
  const candidateVersion = versionDescriptor(candidate);
  const rules = [];
  let adjustment = 0;
  let form = "unknown";
  if (anchorDuration && candidateDuration) {
    const anchorLong = anchorDuration >= LONG_FORM_DURATION_MS;
    const candidateLong = candidateDuration >= LONG_FORM_DURATION_MS;
    const anchorShort = anchorDuration <= SHORT_FORM_DURATION_MS;
    const candidateShort = candidateDuration <= SHORT_FORM_DURATION_MS;
    if ((anchorLong && candidateShort) || (anchorShort && candidateLong)) {
      adjustment -= 0.24;
      rules.push("long-form-vs-short-form");
      form = "mismatched";
      const ratio = Math.max(anchorDuration, candidateDuration) / Math.min(anchorDuration, candidateDuration);
      if (ratio > 1.8) {
        adjustment -= 0.08;
        rules.push("duration-ratio-mismatch");
      }
    } else {
      const ratio = Math.max(anchorDuration, candidateDuration) / Math.min(anchorDuration, candidateDuration);
      if (ratio > 1.8) {
        adjustment -= 0.1;
        rules.push("duration-ratio-mismatch");
        form = "mismatched";
      } else if (ratio <= 1.3) {
        adjustment += 0.03;
        rules.push("duration-compatible");
        form = "compatible";
      } else {
        form = "different-but-plausible";
      }
    }
  }
  if (anchorVersion.includes("extended") && candidateVersion.some((item) => ["radio", "edit"].includes(item))) {
    adjustment -= 0.08;
    rules.push("extended-to-short-version-risk");
  }
  return {
    adjustment: round(adjustment),
    anchorDurationMs: anchorDuration,
    candidateDurationMs: candidateDuration,
    form,
    rules
  };
}

function reviewHistorySignal(selection, reviewHistory) {
  const direct = selection?.directReview || reviewHistory || null;
  if (!direct) return { adjustment: 0, label: "", decision: "", evidence: [] };
  const label = normalized(direct.label || direct.rating);
  const decision = cleanText(direct.decision).toUpperCase();
  if (["positive", "like", "keep", "strong_keep", "strong-keep"].includes(label)
    || ["KEEP", "STRONG_KEEP"].includes(decision)) {
    return { adjustment: 0.05, label, decision, evidence: ["positive-review-history"] };
  }
  if (["negative", "skip", "wrong_genre", "reject_similar", "reject", "duplicate"].includes(label)
    || ["SKIP", "REJECT", "DUPLICATE"].includes(decision)) {
    return { adjustment: -0.2, label, decision, evidence: ["negative-review-history"] };
  }
  if (["ambiguous", "review_manually"].includes(label)
    || ["AMBIGUOUS", "REVIEW_MANUALLY"].includes(decision)) {
    return { adjustment: -0.1, label, decision, evidence: ["ambiguous-review-history"] };
  }
  return { adjustment: 0, label, decision, evidence: [] };
}

function discoveryIntentSignal(anchor, candidate, input = {}) {
  const intent = normalized(input.discoveryIntent || input.intent || input.purpose || "discovery") || "discovery";
  const noveltyPolicy = cleanText(input.noveltyPolicy || "").toUpperCase();
  const known = Boolean(candidate.previouslyQueued || candidate.previouslyDiscovered || candidate.standbySeen
    || candidate.playlistKnown || candidate.libraryKnown || candidate.ratedBefore || candidate.known);
  const rules = [];
  let adjustment = 0;
  let exclusionReason = "";
  if (["discovery", "recommendation", "sonic review", "new neighbors", "new"].includes(intent)) {
    if (known && noveltyPolicy === "FRESH_ONLY") {
      exclusionReason = "known-candidate-fresh-only";
      rules.push("fresh-only-known-candidate");
    } else if (known) {
      adjustment -= 0.04;
      rules.push("known-candidate-novelty-penalty");
    }
  }
  if (intent.includes("texture") || intent.includes("sound")) {
    adjustment += 0.02;
    rules.push("texture-discovery-intent");
  }
  return { intent, noveltyPolicy, known, adjustment: round(adjustment), rules, exclusionReason };
}

function scoreSonicNeighborSecondStage({
  anchor = {},
  candidate = {},
  rawSimilarity = null,
  selection = null,
  reviewHistory = null,
  input = {},
  genreResolver = null,
  neighborTracks = [],
  secondStageConfig = null
} = {}) {
  const config = mergeSecondStageConfig(secondStageConfig || input.secondStageConfig);
  const raw = Number.isFinite(Number(rawSimilarity))
    ? clamp(rawSimilarity)
    : Number.isFinite(Number(selection?.rawSimilarity)) ? clamp(selection.rawSimilarity) : null;
  const baseRaw = raw === null ? 0 : raw;
  const metadata = metadataIntegrity(anchor, candidate);
  const arrangement = arrangementCompatibility(anchor, candidate);
  const genreContext = { anchor, candidate, neighborTracks };
  const anchorGenre = genreEvidenceFor(anchor, { genreResolver, context: { ...genreContext, subject: "anchor" } });
  const candidateGenre = genreEvidenceFor(candidate, { genreResolver, context: { ...genreContext, subject: "candidate" } });
  const anchorFamilies = anchorGenre.families;
  const candidateFamilies = candidateGenre.families;
  const anchorStrength = genreEvidenceStrength(anchorGenre);
  const candidateStrength = genreEvidenceStrength(candidateGenre);
  const sharedFamilies = anchorFamilies.filter((family) => candidateFamilies.includes(family));
  const conflictingFamilies = {
    anchorOnly: anchorFamilies.filter((family) => !candidateFamilies.includes(family)),
    candidateOnly: candidateFamilies.filter((family) => !anchorFamilies.includes(family))
  };
  const review = reviewHistorySignal(selection, reviewHistory);
  const sceneEvidenceUsed = sceneEvidenceFor(anchorGenre, candidateGenre, review, {
    anchorFamilies,
    candidateFamilies
  });
  const strengthRank = (strength) => GENRE_STRENGTH_RANK[strength?.level] || GENRE_STRENGTH_RANK.weak;
  const bothStrong = strengthRank(anchorStrength) >= GENRE_STRENGTH_RANK.strong
    && strengthRank(candidateStrength) >= GENRE_STRENGTH_RANK.strong;
  const eitherWeak = strengthRank(anchorStrength) <= GENRE_STRENGTH_RANK.weak
    || strengthRank(candidateStrength) <= GENRE_STRENGTH_RANK.weak;
  let genreRelationship = "uncertain";
  let genreConflictConfidence = "low";
  let sceneSoftenedPenalty = false;
  if (anchorFamilies.length && candidateFamilies.length && sharedFamilies.length) {
    genreRelationship = sameFamilyOrAdjacent(anchorFamilies, candidateFamilies);
    if (genreRelationship === "compatible" && !anchorGenre.explicitConflict && !candidateGenre.explicitConflict
      && anchorGenre.confidence === "exact" && candidateGenre.confidence === "exact"
      && anchorFamilies.length === candidateFamilies.length
      && anchorFamilies.every((family) => candidateFamilies.includes(family))) genreRelationship = "exact";
    if (anchorGenre.explicitConflict || candidateGenre.explicitConflict) {
      genreConflictConfidence = bothStrong ? "medium" : "low";
    }
  } else if (anchorFamilies.length && candidateFamilies.length) {
    const familyRelationship = sameFamilyOrAdjacent(anchorFamilies, candidateFamilies);
    if (eitherWeak) {
      genreRelationship = sceneEvidenceUsed.length ? "uncertain" : "weak-conflict";
      sceneSoftenedPenalty = sceneEvidenceUsed.length > 0;
    } else if (familyRelationship === "adjacent") {
      // House/techno/trance/electronica lanes can be intentionally adjacent;
      // strong evidence does not make every cross-family electronic pairing a
      // conflict.
      genreRelationship = "adjacent";
    } else if (bothStrong) {
      genreRelationship = "incompatible";
      genreConflictConfidence = "high";
    } else if (sceneEvidenceUsed.length) {
      genreRelationship = "weak-conflict";
      sceneSoftenedPenalty = true;
    } else {
      genreRelationship = "conflicting";
      genreConflictConfidence = "medium";
    }
  }
  if (["conflicting", "incompatible"].includes(genreRelationship)
    && genreConflictConfidence === "low") {
    genreConflictConfidence = bothStrong ? "high" : "medium";
  }
  const genreRules = [];
  const genreBaseAdjustment = Number(config.genreAdjustments[genreRelationship]) || 0;
  const genreBonusEvidenceDetails = genreBonusEvidence(
    anchorStrength,
    candidateStrength,
    sceneEvidenceUsed,
    config,
    genreRelationship
  );
  let genreAdjustment = genreBaseAdjustment > 0
    ? genreBaseAdjustment * genreBonusEvidenceDetails.combinedWeight
    : genreBaseAdjustment;
  if (genreBaseAdjustment > 0 && genreBonusEvidenceDetails.combinedWeight < 1) {
    genreRules.push(`genre-bonus-scaled:${round(genreBaseAdjustment)}->${round(genreAdjustment)}`);
  }
  let exclusionReason = "";
  if (genreRelationship === "exact") {
    genreRules.push("genre-lane-exact");
  } else if (genreRelationship === "compatible") {
    genreRules.push("genre-lane-compatible");
  } else if (genreRelationship === "adjacent") {
    genreRules.push("genre-lane-adjacent");
  } else if (genreRelationship === "uncertain") {
    genreRules.push("genre-lane-uncertain");
  } else if (genreRelationship === "weak-conflict") {
    genreRules.push("genre-lane-weak-conflict");
  } else if (genreRelationship === "conflicting") {
    genreRules.push("genre-lane-conflicting");
  } else if (genreRelationship === "incompatible") {
    if (raw !== null && raw < Number(config.lowSimilarityCrossGenre)) {
      exclusionReason = "low-sim-cross-genre";
      genreRules.push("low-sim-cross-genre-rejected");
    } else {
      genreRules.push("cross-genre-discovery-risk");
    }
  }
  if (arrangement.adjustment > Number(config.maxArrangementBonusWhenGenreRisk)
    && ["uncertain", "weak-conflict", "conflicting", "incompatible"].includes(genreRelationship)) {
    const before = arrangement.adjustment;
    arrangement.adjustment = round(Number(config.maxArrangementBonusWhenGenreRisk));
    arrangement.rules.push("duration-bonus-suppressed-by-genre-uncertainty");
    genreRules.push(`arrangement-bonus-capped:${round(before)}->${arrangement.adjustment}`);
  }
  const selectionAdjustment = Number.isFinite(Number(selection?.selectionScore)) && raw !== null
    ? Number(selection.selectionScore) - raw
    : 0;
  const ambiguousSelectionAdjustment = selection?.directReview
    && ["ambiguous", "review_manually"].includes(normalized(selection.directReview.label || selection.directReview.decision))
    ? review.adjustment
    : 0;
  const feedbackAdjustment = selection
    ? selectionAdjustment + ambiguousSelectionAdjustment
    : review.adjustment;
  const intent = discoveryIntentSignal(anchor, candidate, input);
  const candidateDuration = durationMs(candidate);
  const suspicious = metadata.suspiciousFields.length > 0;
  if (candidateDuration !== null && candidateDuration > Number(config.maxSourceDurationMs)) {
    exclusionReason = suspicious ? "suspicious-source-metadata" : "suspicious-duration";
    genreRules.push("source-duration-limit");
  }
  if (metadata.issues.includes("missing-artist") || metadata.issues.includes("missing-title")) {
    if (!exclusionReason && suspicious) exclusionReason = "suspicious-source-metadata";
  }
  if (sameRecording(anchor, candidate) && identityKey(anchor) && identityKey(candidate)
    && identityKey(anchor) !== identityKey(candidate)) {
    exclusionReason = exclusionReason || "known-duplicate-recording";
    metadata.issues.push("known-duplicate-recording");
  } else if (metadata.issues.includes("same-isrc")) {
    genreRules.push("known-version-relationship");
  }
  if (intent.exclusionReason) exclusionReason = exclusionReason || intent.exclusionReason;

  const bonuses = [];
  const penalties = [];
  const addComponent = (name, amount, reason) => {
    const value = Number(amount) || 0;
    if (!value) return;
    const entry = { rule: name, amount: round(value), reason };
    (value > 0 ? bonuses : penalties).push(entry);
  };
  addComponent("metadata-integrity", metadata.adjustment, metadata.issues.length ? metadata.issues.join(", ") : "artist/title identity is coherent");
  addComponent("genre-compatibility", genreAdjustment, genreRelationship);
  addComponent("arrangement-duration", arrangement.adjustment, arrangement.rules.join(", ") || "no duration evidence");
  addComponent("discovery-intent", intent.adjustment, intent.rules.join(", ") || intent.intent);
  addComponent("review-history", feedbackAdjustment, selection ? (selection.selectionMethod || "selection-model") : review.evidence.join(", "));

  const totalAdjustment = bonuses.reduce((sum, item) => sum + item.amount, 0)
    + penalties.reduce((sum, item) => sum + item.amount, 0);
  // Keep the additive composite unsaturated so close strong candidates remain
  // distinguishable. Raw cosine is still reported independently and every
  // component is bounded; this score is diagnostic/ranking-only in shadow.
  const adjustedScore = round(baseRaw + totalAdjustment);
  const rulesFired = [...new Set([
    ...metadata.issues,
    ...metadata.suspiciousFields,
    ...genreRules,
    ...arrangement.rules,
    ...intent.rules,
    ...review.evidence,
    ...(selection?.selectionMethod ? [selection.selectionMethod] : [])
  ])];
  return {
    secondStageVersion: SECOND_STAGE_VERSION,
    shadowOnly: true,
    productionApplied: false,
    accepted: !exclusionReason,
    rawSimilarity: raw,
    baseScore: round(baseRaw + feedbackAdjustment),
    adjustedScore,
    totalAdjustment: round(totalAdjustment),
    bonuses,
    penalties,
    rulesFired,
    exclusionReason,
    metadataQuality: metadata,
    genreCompatibility: {
      relationship: genreRelationship,
      confidence: { anchor: anchorGenre.confidence, candidate: candidateGenre.confidence },
      genreEvidenceStrength: {
        anchor: anchorStrength.level,
        candidate: candidateStrength.level
      },
      evidenceBalance: {
        anchor: anchorStrength,
        candidate: candidateStrength
      },
      anchorFamilies,
      candidateFamilies,
      sharedFamilies,
      conflictingFamilies,
      sceneEvidenceUsed,
      genreConflictConfidence,
      sceneSoftenedPenalty,
      explicitGenreMetadata: { anchor: anchorGenre.explicit, candidate: candidateGenre.explicit },
      inferredGenreMetadata: { anchor: anchorGenre.inferred, candidate: candidateGenre.inferred },
      inferenceSource: { anchor: anchorGenre.sources, candidate: candidateGenre.sources },
      familyEvidence: { anchor: anchorGenre.familyEvidence, candidate: candidateGenre.familyEvidence },
      adjustment: round(genreAdjustment),
      baseAdjustment: round(genreBaseAdjustment),
      sharedFamilyEvidenceWeight: genreBonusEvidenceDetails.sharedFamilyEvidenceWeight,
      sceneEvidenceWeight: genreBonusEvidenceDetails.sceneEvidenceWeight,
      finalGenreAdjustmentReason: genreBonusEvidenceDetails.reason,
      rules: genreRules
    },
    arrangementCompatibility: arrangement,
    discoveryIntent: intent,
    reviewHistory: {
      adjustment: round(feedbackAdjustment),
      direct: selection?.directReview || reviewHistory || null,
      evidence: review.evidence,
      selectionAdjustment: round(selectionAdjustment)
    },
    budgetCost: { metadataRules: rulesFired.length, rawVectorRead: false }
  };
}

module.exports = {
  SECOND_STAGE_VERSION,
  MAX_SOURCE_DURATION_MS,
  DEFAULT_SECOND_STAGE_CONFIG,
  mergeSecondStageConfig,
  scoreSonicNeighborSecondStage,
  explicitGenreEvidence,
  genreEvidenceFor,
  genreEvidenceStrength,
  genreFamilies,
  suspiciousMetadata
};
