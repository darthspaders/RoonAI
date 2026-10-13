"use strict";

const { rankSonicAnchorFit } = require("./sonicAnchorFit");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
const WAVEFORM_FEATURE_SPEC = deepFreeze({ key: "sonic-waveform-v2-24k-n2048-h240", version: 2, method: "gain-normalized-multiband-log-spectral-flux-autocorrelation",
  sampleRate: 24000, frameSize: 2048, hopSize: 240, window: "hann-symmetric", bandsHz: [[40, 200], [200, 2000], [2000, 10000]],
  tempoRangeBpm: [40, 240], tempoGridBpm: [40, 240, 1], logCompression: 100, noveltyLocalMeanFrames: 21, onsetPeakMinimum: 0.1,
  onsetRefractorySeconds: 0.1, phaseBins: 16, maximumTempoAlternatives: 5, autocorrelation: "overlap-normalized-centered-novelty; negative-values-zero",
  levelNormalization: "whole-excerpt-peak; no level-based preference", fullScaleExceedance: "diagnostic-only; abs(sample)>1; no clipping inference",
  inputFormats: ["flac", "dsf", "mp3", "wav"], minimumSeconds: 8, maximumSeconds: 30, decodeSampleTolerance: 1 });
const RHYTHM_COMPONENTS = deepFreeze({ onsetRateHz: 0.20, intervalCv: 0.10, phaseProfile: 0.20, periodicityPeak: 0.15, bandPulseStrength: 0.20, lowHighOnsetCorrelation: 0.15 });
const DYNAMICS_COMPONENTS = deepFreeze({ crestFactorDb: 0.50, rmsRangeDb: 0.50 });
const VARIANTS = deepFreeze({ "metadata-baseline": { rhythm: 0, dynamics: 0 }, "rhythm-only": { rhythm: 0.06, dynamics: 0 }, "dynamics-only": { rhythm: 0, dynamics: 0.04 }, combined: { rhythm: 0.06, dynamics: 0.04 } });
const WAVEFORM_FIT_RECIPE = deepFreeze({ version: 2, featureSpec: WAVEFORM_FEATURE_SPEC,
  retrieval: { scorer: "sealed-sonicAnchorFit-v1-metadata-only", rawTopK: 20, branchLimit: 10, finalCount: 3, identicalPoolAcrossVariants: true },
  variants: VARIANTS, maxAudioPenalty: 0.10, adjustment: "metadata adjustment minus fixed weighted waveform distances; no positive waveform bonus",
  rhythm: { weights: RHYTHM_COMPONENTS, onsetRateHz: "abs(a-b)/(a+b)", intervalCv: "abs(a-b)/(1+a+b)",
    phaseProfile: "minimum circular-shift L1 distance of two 16-bin normalized shares divided by two", periodicityPeak: "abs(a-b)",
    bandPulseStrength: "mean absolute difference of lowPulseStrength and highPulseStrength", lowHighOnsetCorrelation: "abs(a-b)/2" },
  dynamics: { weights: DYNAMICS_COMPONENTS, crestFactorDb: "abs(a-b)/(12+abs(a-b))", rmsRangeDb: "abs(a-b)/(12+abs(a-b))", fixedDbScale: 12 },
  gates: { receiptSchemaVersion: 1, featureSpecVersion: 2, gateVersion: "waveform-gates-v2", exactIdentityAndHash: true, spanToleranceSeconds: 0.000002,
    sampleRate: 24000, channels: 1, completeDecodeSampleTolerance: 1, silenceMustBeFalse: true, rhythmMinimumOnsets: 8,
    rhythmMinimumPeriodicity: 0.1, fullScaleExceedance: "finite fraction in [0,1], diagnostic only; no family veto", normalizedSharesTolerance: 0.001,
    physicalBounds: { onsetCount: "at most ceil(duration/onsetRefractorySeconds)+1", intervalCv: "at most sqrt(onsetCount)",
      crestFactorDb: "at most 10*log10(decoded sample count)", rmsRangeDb: "0..120 from the peak-normalized RMS floor of 1e-6" } },
  missing: "unavailable family contributes zero with no redistribution of its weight; coverage must be reported",
  unusedForScoring: ["tempoAlternatives", "tempoAutocorrelation", "tempoAmbiguityRatio", "octaveAmbiguous", "phaseConcentration", "lowHighPeakLagSeconds", "rmsVariationDb", "brightnessHz", "bandBalance", "rmsDbfs", "peakDbfs", "fullScaleExceedanceFraction"],
  interpretation: "Numerical descriptor distance only; not resolved beat/BPM, genre, groove, mood, perceived musical energy or calibrated confidence. No labels or global taste." });

const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const finite = value => typeof value === "number" && Number.isFinite(value);
const bounded = (value, low, high) => finite(value) && value >= low && value <= high;
const clamp01 = value => Math.max(0, Math.min(1, value));
const compareKey = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function shareVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(entry => bounded(entry, 0, 1))
    && Math.abs(value.reduce((sum, entry) => sum + entry, 0) - 1) <= WAVEFORM_FIT_RECIPE.gates.normalizedSharesTolerance;
}
function sameSpans(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((span, i) => Array.isArray(span) && span.length === 2
    && span.every((value, j) => finite(value) && Math.abs(value - right[i][j]) <= WAVEFORM_FIT_RECIPE.gates.spanToleranceSeconds));
}
function sourceSummary(waveform) {
  const sourceType = typeof waveform?.sourceType === "string" && /^[a-z0-9_-]{1,80}$/i.test(waveform.sourceType) ? waveform.sourceType : "unknown";
  return { sourceType, previewSource: /preview/i.test(sourceType), partialSource: /preview/i.test(sourceType) || waveform?.partialSource === true,
    flags: Array.isArray(waveform?.reliability?.flags) ? waveform.reliability.flags.filter(flag => typeof flag === "string" && /^[a-z0-9_-]{1,100}$/i.test(flag)).slice(0, 32) : [] };
}
function validateWaveform(waveform, track, evidence) {
  const summary = sourceSummary(waveform);
  const invalid = reason => ({ available: false, reason, source: summary, rhythm: { available: false, reason }, dynamics: { available: false, reason } });
  if (!plain(waveform)) return invalid("missing-waveform-evidence");
  if (waveform.version !== 1 || waveform.status !== "ok" || !plain(waveform.spec)
    || canonical(waveform.spec) !== canonical(WAVEFORM_FEATURE_SPEC)) return invalid("invalid-waveform-status-or-feature-spec");
  if (waveform.identityKey !== track.identityKey || typeof waveform.sourceSha256 !== "string"
    || waveform.sourceSha256.toLowerCase() !== evidence.sourceSha256.toLowerCase() || !sameSpans(waveform.spans, evidence.spans)) return invalid("unmatched-waveform-identity-source-or-span");
  if (!["verified-local-file", "beatport-preview"].includes(waveform.sourceType)
    || waveform.sourceSnapshotKey !== undefined && (typeof waveform.sourceSnapshotKey !== "string" || !/^sonic-source-v1-[a-f0-9]{64}$/.test(waveform.sourceSnapshotKey))
    || waveform.sourceType === "beatport-preview" && waveform.sourceSnapshotKey === undefined) return invalid("invalid-waveform-source-type-or-preview-snapshot");
  const decode = waveform.decode, quality = waveform.reliability, diagnostics = waveform.diagnostics;
  const requestedSeconds = evidence.spans.reduce((sum, span) => sum + span[1] - span[0], 0), expectedSamples = Math.round(requestedSeconds * WAVEFORM_FEATURE_SPEC.sampleRate);
  if (evidence.spans.length !== 1 || requestedSeconds < 8 || requestedSeconds > 30.000002
    || !plain(decode) || decode.sampleRate !== 24000 || decode.channels !== 1 || decode.complete !== true || decode.hashVerifiedPrePost !== true
    || !Number.isInteger(decode.samples) || decode.samples <= WAVEFORM_FEATURE_SPEC.frameSize || Math.abs(decode.samples - expectedSamples) > WAVEFORM_FEATURE_SPEC.decodeSampleTolerance
    || !finite(decode.durationSeconds) || Math.abs(decode.durationSeconds - decode.samples / 24000) > 1 / 24000
    || !finite(decode.requestedDurationSeconds) || Math.abs(decode.requestedDurationSeconds - requestedSeconds) > WAVEFORM_FIT_RECIPE.gates.spanToleranceSeconds
    || !Number.isInteger(decode.sourceByteLength) || decode.sourceByteLength <= 0) return invalid("invalid-or-incomplete-waveform-decode");
  if (!plain(quality) || quality.usable !== true || quality.calibrated !== false || quality.gateVersion !== WAVEFORM_FIT_RECIPE.gates.gateVersion
    || !plain(diagnostics) || diagnostics.silent !== false || !bounded(diagnostics.fullScaleExceedanceFraction, 0, 1)) return invalid("unusable-waveform-validity-gates");
  const descriptors = waveform.descriptors, rhythm = descriptors?.rhythm, dynamics = descriptors?.dynamics;
  const rhythmOkay = quality.rhythmUsable === true && plain(rhythm) && Number.isInteger(rhythm.onsetCount) && rhythm.onsetCount >= 8
    && rhythm.onsetCount <= Math.ceil(decode.durationSeconds / WAVEFORM_FEATURE_SPEC.onsetRefractorySeconds) + 1
    && bounded(rhythm.periodicityPeak, 0.1, 1) && finite(rhythm.onsetRateHz) && rhythm.onsetRateHz > 0 && rhythm.onsetRateHz <= 100
    && Math.abs(rhythm.onsetRateHz * decode.durationSeconds - rhythm.onsetCount) <= 1e-7
    && bounded(rhythm.intervalCv, 0, Math.sqrt(rhythm.onsetCount)) && shareVector(rhythm.phaseProfile, 16)
    && bounded(rhythm.lowPulseStrength, 0, 1) && bounded(rhythm.highPulseStrength, 0, 1) && bounded(rhythm.lowHighOnsetCorrelation, -1, 1);
  const dynamicsOkay = quality.dynamicsUsable === true && plain(dynamics)
    && bounded(dynamics.crestFactorDb, 0, 10 * Math.log10(decode.samples) + 1e-9) && bounded(dynamics.rmsRangeDb, 0, 120.000000001);
  const provenance = { identityKey: track.identityKey, sourceSha256: evidence.sourceSha256, spans: evidence.spans.map(span => [...span]), specKey: WAVEFORM_FEATURE_SPEC.key,
    ...summary, decode: { samples: decode.samples, durationSeconds: decode.durationSeconds, requestedDurationSeconds: decode.requestedDurationSeconds, complete: true, hashVerifiedPrePost: true },
    silent: false, fullScaleExceedanceFraction: diagnostics.fullScaleExceedanceFraction,
    fullScaleInterpretation: "floating-point mono may exceed full scale; not clipping proof", calibrated: false };
  return { available: true, source: provenance,
    rhythm: rhythmOkay ? { available: true, descriptors: { onsetCount: rhythm.onsetCount, onsetRateHz: rhythm.onsetRateHz, intervalCv: rhythm.intervalCv, phaseProfile: [...rhythm.phaseProfile], periodicityPeak: rhythm.periodicityPeak,
      lowPulseStrength: rhythm.lowPulseStrength, highPulseStrength: rhythm.highPulseStrength, lowHighOnsetCorrelation: rhythm.lowHighOnsetCorrelation },
      diagnostics: { octaveAmbiguous: typeof rhythm.octaveAmbiguous === "boolean" ? rhythm.octaveAmbiguous : null, tempoAmbiguityRatio: bounded(rhythm.tempoAmbiguityRatio, 0, 1) ? rhythm.tempoAmbiguityRatio : null } }
      : { available: false, reason: "unusable-or-invalid-rhythm-descriptors" },
    dynamics: dynamicsOkay ? { available: true, descriptors: { crestFactorDb: dynamics.crestFactorDb, rmsRangeDb: dynamics.rmsRangeDb } }
      : { available: false, reason: "unusable-or-invalid-dynamics-descriptors" } };
}
function circularShareDistance(left, right) {
  let distance = Infinity;
  for (let shift = 0; shift < left.length; shift++) distance = Math.min(distance, left.reduce((sum, value, i) => sum + Math.abs(value - right[(i + shift) % right.length]), 0) / 2);
  return clamp01(distance);
}
function compareFamily(family, anchor, candidate) {
  const left = anchor[family], right = candidate[family];
  if (!left.available || !right.available) return { available: false, distance: 0, reason: "missing-or-invalid-pair-family", anchorAvailable: left.available, candidateAvailable: right.available,
    anchorReason: left.reason || null, candidateReason: right.reason || null, components: {}, weightRedistributed: false };
  const a = left.descriptors, b = right.descriptors;
  const values = family === "rhythm" ? {
    onsetRateHz: Math.abs(a.onsetRateHz - b.onsetRateHz) / (a.onsetRateHz + b.onsetRateHz),
    intervalCv: Math.abs(a.intervalCv - b.intervalCv) / (1 + a.intervalCv + b.intervalCv),
    phaseProfile: circularShareDistance(a.phaseProfile, b.phaseProfile), periodicityPeak: Math.abs(a.periodicityPeak - b.periodicityPeak),
    bandPulseStrength: (Math.abs(a.lowPulseStrength - b.lowPulseStrength) + Math.abs(a.highPulseStrength - b.highPulseStrength)) / 2,
    lowHighOnsetCorrelation: Math.abs(a.lowHighOnsetCorrelation - b.lowHighOnsetCorrelation) / 2
  } : Object.fromEntries(Object.keys(DYNAMICS_COMPONENTS).map(key => { const delta = Math.abs(a[key] - b[key]); return [key, delta / (12 + delta)]; }));
  const weights = family === "rhythm" ? RHYTHM_COMPONENTS : DYNAMICS_COMPONENTS;
  const components = Object.fromEntries(Object.keys(values).map(key => [key, { distance: clamp01(values[key]), weight: weights[key], contribution: clamp01(values[key]) * weights[key] }]));
  return { available: true, distance: clamp01(Object.values(components).reduce((sum, item) => sum + item.contribution, 0)), components, weightRedistributed: false };
}
function metadataOnly(fitEvidence) {
  const metadata = {};
  for (const key of ["styleAvailable", "artistAvailable", "labelAvailable"]) if (typeof fitEvidence?.metadata?.[key] === "boolean") metadata[key] = fitEvidence.metadata[key];
  return { metadata };
}
function frozenMetadata(row) {
  const value = row.fit?.metadata;
  if (!plain(value) || !Array.isArray(value.reasons)) throw new Error("Frozen retrieval lacks sealed metadata diagnostics.");
  const weights = { "sampling-style-match": 0.0075, "exact-artist-metadata-match": 0.0035, "exact-label-metadata-match": 0.002 };
  if (new Set(value.reasons).size !== value.reasons.length || value.reasons.some(reason => !Object.hasOwn(weights, reason))) throw new Error("Invalid frozen metadata reasons.");
  const adjustment = value.reasons.reduce((sum, reason) => sum + weights[reason], 0);
  if (!finite(value.adjustment) || Math.abs(value.adjustment - adjustment) > 1e-12 || !finite(row.fitAdjustment) || Math.abs(row.fitAdjustment - adjustment) > 1e-12
    || row.fit.audioAdjustment !== 0 || !finite(row.fit.metadataAdjustment) || Math.abs(row.fit.metadataAdjustment - adjustment) > 1e-12
    || !finite(row.fitScore) || Math.abs(row.fitScore - row.similarity - adjustment) > 1e-12
    || !plain(row.fit.signals) || Object.values(row.fit.signals).some(signal => signal.available || signal.adjustment !== 0)) throw new Error("Frozen retrieval must contain unchanged metadata-only scores.");
  const style = value.style;
  const checked = (part, matched) => {
    if (!plain(part) || typeof part.available !== "boolean" || part.matched !== matched || matched && !part.available) throw new Error("Invalid frozen metadata availability.");
    return { available: part.available, matched };
  };
  const out = { adjustment: value.adjustment, reasons: [...value.reasons], style: checked(style, value.reasons.includes("sampling-style-match")),
    artist: checked(value.artist, value.reasons.includes("exact-artist-metadata-match")), label: checked(value.label, value.reasons.includes("exact-label-metadata-match")),
    confidenceCalibrated: false, interpretation: "Unchanged sealed soft metadata hints; no audio features or labels." };
  for (const key of ["anchor", "candidate"]) {
    if (!Array.isArray(style[key]) || style[key].some(entry => typeof entry !== "string" || entry.length > 200)) throw new Error("Invalid frozen style hints.");
    out.style[key] = [...style[key]];
  }
  return out;
}
function verifiedFrozenRetrieval(frozen) {
  if (!plain(frozen) || frozen.version !== 1 || frozen.mode !== "shadow" || frozen.queueable !== false || frozen.productionApplied !== false
    || frozen.productionPromotionAllowed !== false || frozen.configuration?.rawTopK !== 20 || frozen.configuration?.branchLimit !== 10 || frozen.configuration?.finalCount !== 3
    || !Array.isArray(frozen.retrievedCandidates) || frozen.retrievedCandidates.length > 30 || frozen.diagnostics?.reviewLabelsUsed !== false
    || frozen.diagnostics?.globalTasteUsed !== false || frozen.diagnostics?.crossModelVectorsMixed !== false || frozen.diagnostics?.measuredSignalPairsUsed !== 0) throw new Error("A sealed metadata-only twenty-plus-ten retrieval is required.");
  const rows = frozen.retrievedCandidates;
  // Audit every frozen member without re-selecting the metadata branch. Masking
  // metadata here validates only raw ranks, sources, identities and exclusions.
  const audited = rankSonicAnchorFit({ anchor: frozen.anchor, analyzer: frozen.analyzer, specKey: frozen.specKey, anchorEvidence: frozen.anchorEvidence,
    anchorFitEvidence: { metadata: { styleAvailable: false, artistAvailable: false, labelAvailable: false } },
    candidates: rows.map(row => ({ track: row.track, analyzer: row.analyzer, specKey: row.specKey, rank: row.rank, similarity: row.similarity, evidence: row.evidence,
      fitEvidence: { metadata: { styleAvailable: false, artistAvailable: false, labelAvailable: false } } })), options: { rawTopK: 100, branchLimit: 0 } });
  if (audited.excluded.length || audited.retrievedCandidates.length !== rows.length) throw new Error("Frozen retrieval contains excluded or duplicate recordings.");
  const byIdentity = new Map(audited.retrievedCandidates.map(row => [row.track.identityKey, row]));
  let rawCount = 0, branchCount = 0;
  const candidates = rows.map(row => {
    const safe = byIdentity.get(row.track.identityKey), metadata = frozenMetadata(row), retrieval = row.retrieval;
    if (!plain(retrieval) || typeof retrieval.rawTopK !== "boolean" || typeof retrieval.metadataBranch !== "boolean" || retrieval.rawTopK === retrieval.metadataBranch
      || !Array.isArray(retrieval.reasons) || canonical(retrieval.reasons) !== canonical(retrieval.rawTopK ? ["raw-cosine-top-k"] : metadata.reasons)
      || row.rawSimilarity !== row.similarity || !safe || row.analyzer !== frozen.analyzer || row.specKey !== frozen.specKey) throw new Error("Frozen retrieval provenance changed.");
    if (retrieval.rawTopK) rawCount++; else branchCount++;
    return { ...safe, fitAdjustment: row.fitAdjustment, fitScore: row.fitScore, fit: { ...safe.fit, metadata, metadataAdjustment: metadata.adjustment },
      retrieval: { rawTopK: retrieval.rawTopK, metadataBranch: retrieval.metadataBranch, reasons: [...retrieval.reasons] } };
  });
  if (rawCount > 20 || branchCount > 10 || branchCount && rawCount !== 20 || frozen.diagnostics.rawRetrievedCount !== rawCount
    || frozen.diagnostics.branchRetrievedCount !== branchCount || frozen.diagnostics.retrievedCount !== rows.length
    || candidates.some((row, i) => i && (candidates[i - 1].fitScore < row.fitScore || candidates[i - 1].fitScore === row.fitScore && candidates[i - 1].rank > row.rank))) throw new Error("Frozen retrieval counts or metadata ordering changed.");
  const rawRanks = candidates.filter(row => row.retrieval.rawTopK).map(row => row.rank);
  if (candidates.some(row => row.retrieval.metadataBranch && rawRanks.some(rank => rank > row.rank))) throw new Error("Frozen branch overlaps raw retrieval order.");
  const diagnostics = {};
  for (const key of ["rawCandidateCount", "eligibleCount", "excludedCount", "rawRetrievedCount", "branchRetrievedCount", "retrievedCount", "returnedCount", "unfilled"])
    if (Number.isInteger(frozen.diagnostics[key]) && frozen.diagnostics[key] >= 0) diagnostics[key] = frozen.diagnostics[key];
  if (!Array.isArray(frozen.excluded) || frozen.excluded.length !== frozen.diagnostics.excludedCount) throw new Error("Frozen exclusion receipt changed.");
  const excluded = frozen.excluded.map(row => {
    const checked = rankSonicAnchorFit({ anchor: frozen.anchor, analyzer: frozen.analyzer, specKey: frozen.specKey, anchorEvidence: frozen.anchorEvidence,
      anchorFitEvidence: { metadata: { styleAvailable: false, artistAvailable: false, labelAvailable: false } },
      candidates: [{ track: row.track, rank: row.rank, similarity: row.similarity, evidence: row.evidence, analyzer: row.analyzer, specKey: row.specKey,
        fitEvidence: { metadata: { styleAvailable: false, artistAvailable: false, labelAvailable: false } } }] });
    const safe = checked.excluded[0] || checked.retrievedCandidates[0];
    if (!safe || typeof row.reason !== "string" || !/^[a-z-]{1,80}$/.test(row.reason)) throw new Error("Invalid frozen exclusion receipt.");
    return { track: safe.track, analyzer: safe.analyzer, specKey: safe.specKey, rank: safe.rank, similarity: safe.similarity, evidence: safe.evidence, reason: row.reason };
  });
  return { ...audited, configuration: { rawTopK: 20, branchLimit: 10, finalCount: 3, maxFitAdjustment: 0.05 },
    shortlist: candidates.slice(0, 3), retrievedCandidates: candidates, excluded,
    diagnostics: { ...audited.diagnostics, ...diagnostics, retrievalFrozen: true, originalExclusionsPreservedBeforeFreeze: true } };
}

// Pure rerank of the sealed retrieval pool. Receipts are caller-supplied; this
// function does not decode, look up metadata, infer, read labels or write files.
function rankSonicWaveformFit({ anchor, analyzer, specKey, anchorEvidence, anchorFitEvidence = undefined, anchorWaveform = null, candidates = [], frozenRetrieval = null, featuresMap = null, variant = "combined", options = {} } = {}) {
  if (!Object.hasOwn(VARIANTS, variant)) throw new Error("Unknown fixed waveform-fit variant.");
  if (!plain(options) || Object.keys(options).some(key => !["excludeIdentityKeys", "excludeRecordingGroups", "excludeSourceSha256"].includes(key))) throw new Error("Waveform ablations require the sealed twenty-plus-ten/final-three retrieval recipe.");
  if (!Array.isArray(candidates)) throw new Error("Waveform fit requires the audited candidate ranking.");
  if (frozenRetrieval && (candidates.length || Object.keys(options).length)) throw new Error("Frozen retrieval cannot be combined with a new candidate selection or exclusions.");
  const base = frozenRetrieval ? verifiedFrozenRetrieval(frozenRetrieval) : rankSonicAnchorFit({ anchor, analyzer, specKey, anchorEvidence, anchorFitEvidence: metadataOnly(anchorFitEvidence === undefined ? anchor?.fitEvidence : anchorFitEvidence),
    candidates: candidates.map(entry => ({ ...entry, fitEvidence: metadataOnly(entry?.fitEvidence) })), options });
  const featureFor = identity => featuresMap instanceof Map ? featuresMap.get(identity) : plain(featuresMap) && Object.hasOwn(featuresMap, identity) ? featuresMap[identity] : null;
  const anchorFeatures = validateWaveform(anchorWaveform || featureFor(base.anchor.identityKey), base.anchor, base.anchorEvidence);
  const original = new Map(candidates.map(entry => [entry.track.identityKey, entry]));
  const penalties = VARIANTS[variant];
  const retrievedCandidates = base.retrievedCandidates.map((row, index) => {
    const candidateFeatures = validateWaveform(featureFor(row.track.identityKey) || original.get(row.track.identityKey)?.waveform, row.track, row.evidence);
    const rhythm = compareFamily("rhythm", anchorFeatures, candidateFeatures), dynamics = compareFamily("dynamics", anchorFeatures, candidateFeatures);
    rhythm.enabled = penalties.rhythm > 0; dynamics.enabled = penalties.dynamics > 0;
    rhythm.used = rhythm.available && rhythm.enabled; dynamics.used = dynamics.available && dynamics.enabled;
    rhythm.penalty = rhythm.used ? rhythm.distance * penalties.rhythm : 0;
    dynamics.penalty = dynamics.used ? dynamics.distance * penalties.dynamics : 0;
    const audioPenalty = Math.min(WAVEFORM_FIT_RECIPE.maxAudioPenalty, rhythm.penalty + dynamics.penalty);
    return { ...row, rawRank: row.rank, metadataBaselineRank: index + 1, metadataFitScore: row.fitScore, metadataFitAdjustment: row.fitAdjustment,
      fitScore: row.fitScore - audioPenalty, fitAdjustment: row.fitAdjustment - audioPenalty,
      waveform: { variant, rhythm, dynamics, audioPenalty, sourceQuality: { anchor: anchorFeatures.source, candidate: candidateFeatures.source },
        anchorEvidenceAvailable: anchorFeatures.available, candidateEvidenceAvailable: candidateFeatures.available,
        anchorEvidenceReason: anchorFeatures.reason || null, candidateEvidenceReason: candidateFeatures.reason || null,
        descriptors: { anchor: { rhythm: anchorFeatures.rhythm, dynamics: anchorFeatures.dynamics }, candidate: { rhythm: candidateFeatures.rhythm, dynamics: candidateFeatures.dynamics } },
        calibrated: false, qualityMeans: "Decoded measurement validity only, not a probability or perceived fit." } };
  }).sort((left, right) => right.fitScore - left.fitScore || right.similarity - left.similarity || left.rank - right.rank || compareKey(left.track.identityKey, right.track.identityKey));
  const shortlist = retrievedCandidates.slice(0, 3);
  const coverage = rows => Object.fromEntries(["rhythm", "dynamics"].map(family => [family, { available: rows.filter(row => row.waveform[family].available).length,
    used: rows.filter(row => row.waveform[family].used).length, missing: rows.filter(row => !row.waveform[family].available).length, count: rows.length }]));
  return deepFreeze({ ...base, version: 1, variant, featureSpecKey: WAVEFORM_FEATURE_SPEC.key, recipe: WAVEFORM_FIT_RECIPE,
    formula: "sealed metadata-only score minus fixed weighted numerical waveform distances; no semantic or calibrated confidence",
    shortlist, retrievedCandidates, diagnostics: { ...base.diagnostics, waveform: { anchorAvailable: anchorFeatures.available, anchorReason: anchorFeatures.reason || null,
      anchorFamilyAvailability: { rhythm: anchorFeatures.rhythm.available, dynamics: anchorFeatures.dynamics.available }, retrievedCoverage: coverage(retrievedCandidates), shortlistCoverage: coverage(shortlist),
      maxAudioPenalty: 0.10, missingWeightRedistributed: false, calibrationUsed: false, reviewLabelsUsed: false, globalTasteUsed: false,
      limitations: ["Waveform descriptor distance is an experimental penalty, not genre/groove/mood or perceived musical energy.",
        "Missing or invalid families are neutral and may outrank measured penalized candidates; always inspect coverage.",
        "Preview/local source domain and unresolved tempo ambiguity remain diagnostic caveats.",
        "The same sealed retrieval pool is used for all fixed ablations; this does not establish candidate quality or queue readiness."] } } });
}
function compareSonicWaveformVariants(input) {
  return deepFreeze(Object.fromEntries(Object.keys(VARIANTS).map(variant => [variant, rankSonicWaveformFit({ ...input, variant })])));
}

module.exports = { WAVEFORM_FEATURE_SPEC, WAVEFORM_FIT_RECIPE, rankSonicWaveformFit, compareSonicWaveformVariants };
