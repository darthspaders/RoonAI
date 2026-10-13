"use strict";

const { analysisSpec } = require("./sonicAnalysisSpec");
const { recordingGroup } = require("./sonicAnalysisPilot");

const ANCHOR_FIT_VERSION = 1;
const MODELS = ["mert-fullsong", "mert-30s"];
const DEFAULT_OPTIONS = Object.freeze({ rawTopK: 20, branchLimit: 10, finalCount: 3 });
const MAX_FIT_ADJUSTMENT = 0.05;
const SIGNAL_WEIGHTS = Object.freeze({ tempo: 0.01, rhythm: 0.012, energy: 0.01, mood: 0.015 });
const PUBLIC_FIELDS = ["identityKey", "artist", "title", "mixVersion", "album", "tidalId", "isrc", "genre", "subgenre", "label", "durationMs"];
const text = value => typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/g, " ").trim() : "";
const normalized = value => text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const compareKey = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
function publicTrack(track) {
  if (!plain(track) || typeof track.identityKey !== "string" || !track.identityKey.trim() || !text(track.artist) || !text(track.title)) throw new Error("Anchor fit requires exact identities and complete versioned artist/title metadata.");
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (key === "identityKey") out[key] = track[key];
    else if (key === "durationMs") { if (Number.isFinite(track[key]) && track[key] > 0) out[key] = track[key]; }
    else if (text(track[key])) out[key] = text(track[key]);
  }
  return out;
}
function sourceEvidence(value, spec) {
  if (!plain(value) || !/^[a-f0-9]{64}$/i.test(value.sourceSha256 || "") || !Array.isArray(value.spans)
    || !value.spans.length || value.spans.length > spec.maxWindows
    || value.spans.some(span => !Array.isArray(span) || span.length !== 2 || !span.every(Number.isFinite)
      || span[0] < 0 || span[1] <= span[0] || span[1] - span[0] > spec.windowSeconds + 1)) throw new Error("Anchor fit requires exact model source and excerpt provenance.");
  return { sourceSha256: value.sourceSha256, spans: value.spans.map(span => [...span]) };
}
function exclusionSets(options) {
  const out = {};
  for (const key of ["excludeIdentityKeys", "excludeRecordingGroups", "excludeSourceSha256"]) {
    const values = options[key] === undefined ? [] : options[key];
    if (!Array.isArray(values) || values.length > 5000 || values.some(value => typeof value !== "string" || !value.trim())) throw new Error("Invalid anchor-fit exclusions.");
    if (key === "excludeSourceSha256" && values.some(value => !/^[a-f0-9]{64}$/i.test(value))) throw new Error("Invalid anchor-fit source exclusions.");
    out[key] = new Set(values.map(value => key === "excludeSourceSha256" ? value.toLowerCase() : value));
  }
  return out;
}
function styles(track, fitEvidence) {
  if (fitEvidence?.metadata?.styleAvailable === false) return [];
  return [...new Set([track.genre, track.subgenre, ...(Array.isArray(track.genres) ? track.genres : []), ...(Array.isArray(track.subgenres) ? track.subgenres : [])].map(normalized).filter(Boolean))];
}
function metadataHint(anchor, candidate, anchorFitEvidence, candidateFitEvidence) {
  const anchorStyles = styles(anchor, anchorFitEvidence), candidateStyles = styles(candidate, candidateFitEvidence);
  const styleMatch = anchorStyles.some(style => candidateStyles.includes(style));
  const artistAvailable = anchorFitEvidence?.metadata?.artistAvailable !== false && candidateFitEvidence?.metadata?.artistAvailable !== false;
  const labelAvailable = anchorFitEvidence?.metadata?.labelAvailable !== false && candidateFitEvidence?.metadata?.labelAvailable !== false;
  const artistMatch = artistAvailable && normalized(anchor.artist) === normalized(candidate.artist);
  const labelMatch = labelAvailable && Boolean(normalized(anchor.label)) && normalized(anchor.label) === normalized(candidate.label);
  const reasons = [];
  if (styleMatch) reasons.push("sampling-style-match");
  if (artistMatch) reasons.push("exact-artist-metadata-match");
  if (labelMatch) reasons.push("exact-label-metadata-match");
  return { adjustment: (styleMatch ? 0.0075 : 0) + (artistMatch ? 0.0035 : 0) + (labelMatch ? 0.002 : 0), reasons,
    style: { available: Boolean(anchorStyles.length && candidateStyles.length), matched: styleMatch, anchor: anchorStyles, candidate: candidateStyles },
    artist: { available: artistAvailable, matched: artistMatch },
    label: { available: labelAvailable && Boolean(normalized(anchor.label) && normalized(candidate.label)), matched: labelMatch },
    confidenceCalibrated: false, interpretation: "Soft catalogue/sampling hints only; never audio features, judgments or genre vetoes." };
}
function measuredSignal(name, supplied, track, evidence) {
  const unavailable = reason => ({ available: false, reason });
  const value = supplied?.[name];
  if (!value) return unavailable("missing-measured-evidence");
  const p = value.provenance;
  if (!plain(value) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0.7 || value.confidence > 1) return unavailable("missing-or-low-reported-confidence");
  if (!plain(p) || p.source !== "audio-analysis" || !text(p.method) || !text(p.version)
    || p.identityKey !== track.identityKey || typeof p.sourceSha256 !== "string"
    || p.sourceSha256.toLowerCase() !== evidence.sourceSha256.toLowerCase()
    || JSON.stringify(p.spans) !== JSON.stringify(evidence.spans)) return unavailable("unmatched-audio-feature-provenance");
  const unit = value.unit;
  let actual;
  if (name === "tempo" && unit === "bpm" && Number.isFinite(value.value) && value.value >= 30 && value.value <= 320) actual = value.value;
  else if (name === "energy" && unit === "normalized-0-1" && Number.isFinite(value.value) && value.value >= 0 && value.value <= 1) actual = value.value;
  else if (["mood", "rhythm"].includes(name) && unit === "class-label" && typeof value.value === "string" && value.value.trim() && value.value.length <= 200) actual = value.value;
  else if (["mood", "rhythm"].includes(name) && ["probability-distribution", "normalized-0-1-vector"].includes(unit) && plain(value.value)) {
    const keys = Object.keys(value.value).sort();
    if (!keys.length || keys.length > 32 || keys.some(key => !key || key.length > 100 || !Number.isFinite(value.value[key]) || value.value[key] < 0 || value.value[key] > 1)) return unavailable("invalid-measured-value");
    if (unit === "probability-distribution" && Math.abs(keys.reduce((sum, key) => sum + value.value[key], 0) - 1) > 0.001) return unavailable("invalid-measured-value");
    actual = Object.fromEntries(keys.map(key => [key, value.value[key]]));
  } else return unavailable("invalid-measured-unit-or-value");
  return { available: true, value: actual, unit, confidence: value.confidence,
    provenance: { source: p.source, method: text(p.method), version: text(p.version), identityKey: p.identityKey, sourceSha256: p.sourceSha256, spans: p.spans.map(span => [...span]) } };
}
function signalFit(name, anchorSignal, candidateSignal) {
  const unavailable = reason => ({ available: false, reason, adjustment: 0, anchor: anchorSignal, candidate: candidateSignal });
  if (!anchorSignal.available || !candidateSignal.available) return unavailable("missing-or-unusable-pair-evidence");
  if (anchorSignal.unit !== candidateSignal.unit || anchorSignal.provenance.method !== candidateSignal.provenance.method || anchorSignal.provenance.version !== candidateSignal.provenance.version) return unavailable("feature-spaces-do-not-match");
  const left = anchorSignal.value, right = candidateSignal.value;
  let compatibility;
  if (name === "tempo") compatibility = clamp(1 - Math.abs(Math.log2(left / right)) / Math.log2(1.25), 0, 1);
  else if (name === "energy") compatibility = 1 - Math.abs(left - right);
  else if (anchorSignal.unit === "class-label") compatibility = normalized(left) === normalized(right) ? 1 : 0;
  else {
    const keys = Object.keys(left);
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(right))) return unavailable("feature-dimensions-do-not-match");
    const distance = keys.reduce((sum, key) => sum + Math.abs(left[key] - right[key]), 0);
    compatibility = clamp(1 - distance / (anchorSignal.unit === "probability-distribution" ? 2 : keys.length), 0, 1);
  }
  return { available: true, compatibility, adjustment: SIGNAL_WEIGHTS[name] * (2 * compatibility - 1) * Math.min(anchorSignal.confidence, candidateSignal.confidence),
    anchor: anchorSignal, candidate: candidateSignal, confidenceCalibrated: false };
}

// Pure, per-model experiment. The caller supplies audited full-pool cosine
// rankings, not vectors or review labels. anchorFitEvidence takes precedence
// over anchor.fitEvidence. Only caller-reported measured confidence is usable.
function rankSonicAnchorFit({ anchor, analyzer, specKey, anchorEvidence, anchorFitEvidence = undefined, candidates = [], options = {} } = {}) {
  if (!MODELS.includes(analyzer) || specKey !== analysisSpec(analyzer).key) throw new Error("Anchor fit requires one exact supported MERT analyzer specification.");
  const allowed = ["rawTopK", "branchLimit", "finalCount", "excludeIdentityKeys", "excludeRecordingGroups", "excludeSourceSha256"];
  if (!plain(options) || Object.keys(options).some(key => !allowed.includes(key))) throw new Error("Invalid anchor-fit options.");
  const config = { ...DEFAULT_OPTIONS, ...options };
  if (!Number.isInteger(config.rawTopK) || config.rawTopK < 1 || config.rawTopK > 100 || !Number.isInteger(config.branchLimit) || config.branchLimit < 0 || config.branchLimit > 10 || config.finalCount !== 3) throw new Error("Anchor fit requires bounded raw retrieval, at most ten branch candidates and a fixed final three.");
  if (!Array.isArray(candidates) || candidates.length > 2000) throw new Error("Anchor fit requires a bounded full-pool ranking.");
  const spec = analysisSpec(analyzer), anchorTrack = publicTrack(anchor), source = sourceEvidence(anchorEvidence, spec);
  const anchorFit = anchorFitEvidence === undefined ? anchor.fitEvidence : anchorFitEvidence;
  const anchorSignals = Object.fromEntries(Object.keys(SIGNAL_WEIGHTS).map(name => [name, measuredSignal(name, anchorFit, anchorTrack, source)]));
  const excludedSets = exclusionSets(config), identities = new Set(), ranks = new Set();
  const ordered = candidates.map(entry => {
    if (!plain(entry) || entry.analyzer !== undefined && entry.analyzer !== analyzer || entry.specKey !== undefined && entry.specKey !== specKey
      || !Number.isInteger(entry.rank) || entry.rank < 1 || entry.rank > 2000 || ranks.has(entry.rank)
      || !Number.isFinite(entry.similarity) || entry.similarity < -1 || entry.similarity > 1) throw new Error("Anchor fit requires distinct valid raw ranks, cosine scores and model specifications.");
    const track = publicTrack(entry.track);
    if (identities.has(track.identityKey)) throw new Error("Anchor fit requires distinct exact input identities.");
    identities.add(track.identityKey); ranks.add(entry.rank);
    return { entry, track, evidence: sourceEvidence(entry.evidence, spec) };
  }).sort((left, right) => left.entry.rank - right.entry.rank);
  if (ordered.some((row, index) => index && ordered[index - 1].entry.similarity < row.entry.similarity)) throw new Error("Raw model rank order does not agree with cosine order.");
  const excluded = [], eligible = [], seenHashes = new Set(), seenGroups = new Set();
  const anchorGroup = recordingGroup(anchorTrack);
  for (const row of ordered) {
    const { entry, track, evidence } = row, hash = evidence.sourceSha256.toLowerCase(), group = recordingGroup(track);
    let reason = "";
    if (track.identityKey === anchorTrack.identityKey) reason = "exact-self-identity";
    else if (hash === source.sourceSha256.toLowerCase()) reason = "exact-self-source";
    else if (group === anchorGroup) reason = "exact-self-recording";
    else if (excludedSets.excludeIdentityKeys.has(track.identityKey)) reason = "explicit-identity-exclusion";
    else if (excludedSets.excludeSourceSha256.has(hash)) reason = "explicit-source-exclusion";
    else if (excludedSets.excludeRecordingGroups.has(group)) reason = "explicit-recording-exclusion";
    else if (seenHashes.has(hash)) reason = "duplicate-candidate-source";
    else if (seenGroups.has(group)) reason = "duplicate-candidate-recording";
    if (reason) { excluded.push({ track, analyzer, specKey, rank: entry.rank, similarity: entry.similarity, evidence, reason }); continue; }
    seenHashes.add(hash); seenGroups.add(group);
    const metadata = metadataHint(anchor, entry.track, anchorFit, entry.fitEvidence);
    const signals = Object.fromEntries(Object.keys(SIGNAL_WEIGHTS).map(name => [name, signalFit(name, anchorSignals[name], measuredSignal(name, entry.fitEvidence, track, evidence))]));
    const audioAdjustment = Object.values(signals).reduce((sum, signal) => sum + signal.adjustment, 0);
    const fitAdjustment = clamp(metadata.adjustment + audioAdjustment, -MAX_FIT_ADJUSTMENT, MAX_FIT_ADJUSTMENT);
    eligible.push({ track, analyzer, specKey, rank: entry.rank, similarity: entry.similarity, rawSimilarity: entry.similarity, evidence,
      fitAdjustment, fitScore: entry.similarity + fitAdjustment, fit: { metadata, signals, audioAdjustment, metadataAdjustment: metadata.adjustment },
      retrieval: { rawTopK: false, metadataBranch: false, reasons: [] }, shadowOnly: true, queueable: false });
  }
  const raw = eligible.slice(0, config.rawTopK);
  const branch = eligible.slice(config.rawTopK).filter(row => row.fit.metadata.reasons.length)
    .sort((left, right) => right.fit.metadataAdjustment - left.fit.metadataAdjustment || right.similarity - left.similarity || compareKey(left.track.identityKey, right.track.identityKey))
    .slice(0, config.branchLimit);
  for (const row of raw) row.retrieval = { rawTopK: true, metadataBranch: false, reasons: ["raw-cosine-top-k"] };
  for (const row of branch) row.retrieval = { rawTopK: false, metadataBranch: true, reasons: [...row.fit.metadata.reasons] };
  const retrievedCandidates = [...raw, ...branch].sort((left, right) => right.fitScore - left.fitScore || right.similarity - left.similarity || left.rank - right.rank || compareKey(left.track.identityKey, right.track.identityKey));
  return deepFreeze({ version: ANCHOR_FIT_VERSION, mode: "shadow", shadowOnly: true, productionApplied: false, productionPromotionAllowed: false, queueable: false,
    analyzer, specKey, anchor: anchorTrack, anchorEvidence: source, configuration: { rawTopK: config.rawTopK, branchLimit: config.branchLimit, finalCount: 3, maxFitAdjustment: MAX_FIT_ADJUSTMENT },
    formula: "raw per-model cosine + bounded metadata/measured-feature fit adjustment; not a calibrated similarity or confidence",
    shortlist: retrievedCandidates.slice(0, 3), retrievedCandidates, excluded,
    diagnostics: { rawCandidateCount: candidates.length, eligibleCount: eligible.length, excludedCount: excluded.length, rawRetrievedCount: raw.length, branchRetrievedCount: branch.length,
      retrievedCount: retrievedCandidates.length, returnedCount: Math.min(3, retrievedCandidates.length), unfilled: Math.max(0, 3 - retrievedCandidates.length),
      measuredSignalPairsUsed: retrievedCandidates.reduce((sum, row) => sum + Object.values(row.fit.signals).filter(signal => signal.available).length, 0),
      anchorSignals, reviewLabelsUsed: false, globalTasteUsed: false, crossModelVectorsMixed: false, confidenceCalibrated: false,
      limitations: ["Sampling style and artist/label metadata are soft hints, not listening truth or audio measurements.",
        "Missing, unconfident or unmatched measured features are neutral; catalogue tags never create rhythm, tempo, energy or mood values.",
        "Feature compatibility and the fixed weights are experimental; this does not validate queue quality, provider identity or discovery novelty.",
        "The caller must audit stored model rankings and reported audio-feature confidence; this pure module performs no lookup, inference or write."] } });
}

module.exports = { ANCHOR_FIT_VERSION, DEFAULT_OPTIONS, MAX_FIT_ADJUSTMENT, rankSonicAnchorFit };
