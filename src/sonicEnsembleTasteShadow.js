"use strict";

const { TasteProfile } = require("./tasteProfile");
const {
  buildDiscoveryProfile,
  rejectReason,
  admissionDiagnosticsFor,
  scoreBreakdownFor
} = require("./discoveryEngine");

// An offline diagnostic only. These points are an experimental rank feature,
// not the production Sonic Blend formula or a MERT taste-centroid score.
const SHADOW_FORMULA = "discovery-score + 7.2 * base-rank-score + 8 * agreement-bonus; rank feature capped at 8 points";
const PUBLIC_FIELDS = ["identityKey", "artist", "title", "mixVersion", "album", "tidalId", "isrc", "durationMs", "genre", "subgenre", "label", "year", "releaseDate"];
const SCORING_FIELDS = [...PUBLIC_FIELDS, "genres", "subgenres", "beatportGenre", "beatportSubgenre", "yearSource", "releaseEvidence", "query", "discoverySource", "discoveryLane"];
const NESTED_FIELDS = ["tidal", "beatport", "metadataEnrichment", "metadata_enrichment"];
const PRIVATE_VALUE = /(?:^[a-z]:[\\/]|^\\\\|^\/(?:home|users|mnt|tmp|var|etc|usr)\/|[a-f0-9]{64})/i;
const cleanText = value => String(value ?? "").replace(/\s+/g, " ").trim();
const publicValue = value => {
  const text = cleanText(value);
  return PRIVATE_VALUE.test(text) ? "" : text;
};
const round = value => Number(Number(value).toFixed(6));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const jsonClone = value => JSON.parse(JSON.stringify(value));
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function publicTrack(track = {}) {
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (track[key] === undefined || track[key] === null || track[key] === "") continue;
    if (["durationMs", "year"].includes(key)) {
      const number = Number(track[key]);
      if (Number.isFinite(number) && number > 0) out[key] = number;
    } else out[key] = publicValue(track[key]);
  }
  return out;
}
function scoringTrack(track) {
  const out = {};
  for (const key of SCORING_FIELDS) if (track[key] !== undefined) out[key] = jsonClone(track[key]);
  for (const key of NESTED_FIELDS) if (plainObject(track[key])) {
    out[key] = {};
    for (const name of SCORING_FIELDS) if (track[key][name] !== undefined) out[key][name] = jsonClone(track[key][name]);
  }
  return out;
}
function publicNominations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) throw new Error("Invalid ensemble nomination metadata.");
  return value.map(nomination => {
    if (!plainObject(nomination) || !["mert-fullsong", "mert-30s"].includes(nomination.analyzer)
      || !Number.isInteger(nomination.rank) || nomination.rank < 1 || nomination.rank > 100) throw new Error("Invalid ensemble nomination metadata.");
    const out = { analyzer: nomination.analyzer, rank: nomination.rank };
    for (const key of ["specKey", "identityKey"]) if (nomination[key] !== undefined) out[key] = publicValue(nomination[key]);
    if (nomination.similarity !== undefined) {
      if (typeof nomination.similarity !== "number" || !Number.isFinite(nomination.similarity) || nomination.similarity < -1 || nomination.similarity > 1) throw new Error("Invalid ensemble nomination similarity.");
      out.similarity = nomination.similarity;
    }
    return out;
  });
}

// The caller supplies the derived result of TasteProfile.read(), captured once.
// Raw JSON must first undergo that existing reader's signal reconstruction.
// No constructor, file read, or writable profile method is exposed here.
function freezeTasteView(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  if (!plainObject(snapshot)) throw new Error("A derived taste snapshot must be a JSON object.");
  const state = deepFreeze(jsonClone(snapshot));
  const view = { read: () => state };
  for (const name of ["adjustmentFor", "calibrationAdjustmentFor", "serendipityAdjustmentFor", "getFeedbackFor", "getTopArtists", "summary"]) {
    view[name] = (...args) => TasteProfile.prototype[name].apply(view, args);
  }
  return Object.freeze(view);
}
function admissionSummary(diagnostics) {
  const out = {};
  for (const key of ["identityCorrectness", "catalogueQuality", "durationConstraints", "genreLaneCompatibility", "vibeMoodCompatibility"]) {
    const value = diagnostics[key] || {};
    out[key] = { passed: value.passed === true, hard: value.hard === true, reason: publicValue(value.reason) };
    if (Number.isFinite(value.confidence)) out[key].confidence = value.confidence;
  }
  return out;
}
function metadataMissing(track) {
  const missing = [];
  if (!cleanText(track.label || track.tidal?.label)) missing.push("label");
  if (!Number(track.year) && !cleanText(track.releaseDate)) missing.push("release-year-or-date");
  if (!Number(track.durationMs || track.tidal?.durationMs)) missing.push("duration");
  if (!track.releaseEvidence) missing.push("canonical-release-evidence");
  if (!cleanText(track.genre) && !track.genres?.length) missing.push("genre");
  if (!NESTED_FIELDS.some(key => plainObject(track[key]) && Object.keys(track[key]).length)) missing.push("provider-metadata");
  return missing;
}
function rankEnsembleTasteShadow({ anchor = {}, unionCandidates = [], count = 3, tasteSnapshot = null, options = {} } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("Shadow shortlist count must be an integer from 1 to 50.");
  if (!plainObject(anchor) || !plainObject(options) || !Array.isArray(unionCandidates) || unionCandidates.length > 1000) throw new Error("Invalid frozen ensemble shadow inputs.");
  const frozenAnchor = scoringTrack(anchor);
  // The anchor's stored lane is sampling metadata, not an explicit user genre
  // constraint. Replay a hard lane only when the caller supplies options.genres.
  const requestOptions = deepFreeze(jsonClone({ scoringMode: "similar", request: "Find similar tracks", ...options }));
  const profile = buildDiscoveryProfile(requestOptions);
  const tasteView = freezeTasteView(tasteSnapshot);
  const identities = new Set(), candidates = [], excluded = [];
  let partialMetadataCount = 0;
  for (const entry of unionCandidates) {
    if (!plainObject(entry) || !plainObject(entry.track)) throw new Error("Every ensemble candidate needs an exact track object.");
    const track = scoringTrack(entry.track), identity = cleanText(track.identityKey);
    if (!identity || !cleanText(track.artist) || !cleanText(track.title) || identities.has(identity)) throw new Error("Shadow candidates require distinct exact identities, artists and versioned titles.");
    identities.add(identity);
    if (typeof entry.baseRankScore !== "number" || !Number.isFinite(entry.baseRankScore) || entry.baseRankScore < 0 || entry.baseRankScore > 1
      || typeof entry.agreementBonus !== "number" || !Number.isFinite(entry.agreementBonus) || entry.agreementBonus < 0 || entry.agreementBonus > 0.1
      || typeof entry.agreement !== "boolean" || !entry.agreement && entry.agreementBonus !== 0) throw new Error("Ensemble rank features must be bounded and exact-source agreement must be explicit.");
    const nominations = publicNominations(entry.nominations);
    const missingMetadata = metadataMissing(track);
    if (missingMetadata.length) partialMetadataCount++;
    const reason = rejectReason(track, requestOptions, profile);
    const admission = admissionSummary(admissionDiagnosticsFor(track, requestOptions, profile, { hardFailReason: reason }));
    if (reason) {
      excluded.push({ track: publicTrack(track), nominations, reason: publicValue(reason), admission, missingMetadata });
      continue;
    }
    const breakdown = scoreBreakdownFor(track, requestOptions, tasteView, profile, null);
    const baseDiscoveryScore = Number(breakdown.total);
    if (!Number.isFinite(baseDiscoveryScore)) throw new Error("Existing discovery scoring did not return a finite score.");
    const retrievalPoints = clamp(7.2 * entry.baseRankScore + 8 * entry.agreementBonus, 0, 8);
    candidates.push({
      track: publicTrack(track), nominations,
      baseDiscoveryScore: round(baseDiscoveryScore),
      tasteAdjustment: round(breakdown.tasteAdjustment || 0),
      calibrationAdjustment: round(breakdown.calibrationAdjustment || 0),
      serendipityAdjustment: round(breakdown.serendipityAdjustment || 0),
      retrievalPoints: round(retrievalPoints),
      baseRankScore: round(entry.baseRankScore), agreement: entry.agreement, agreementBonus: round(entry.agreementBonus),
      finalShadowScore: round(clamp(baseDiscoveryScore + retrievalPoints, 1, 100)),
      admission, missingMetadata, shadowOnly: true, queueable: false
    });
  }
  candidates.sort((a, b) => b.finalShadowScore - a.finalShadowScore || b.baseDiscoveryScore - a.baseDiscoveryScore || a.track.identityKey.localeCompare(b.track.identityKey));
  return {
    shadowOnly: true, productionApplied: false, productionPromotionAllowed: false, queueable: false,
    formula: SHADOW_FORMULA, anchor: publicTrack(frozenAnchor),
    shortlist: candidates.slice(0, count), candidates, excluded,
    diagnostics: {
      requestedCount: count, candidateCount: unionCandidates.length, admittedCount: candidates.length, excludedCount: excluded.length,
      returnedCount: Math.min(count, candidates.length), undershot: candidates.length < count,
      tasteSnapshotAvailable: Boolean(tasteView), tasteSnapshotStatus: tasteView ? "frozen-derived-snapshot" : "missing-taste-snapshot",
      partialMetadataCount, scoringMode: profile.scoringMode, requestedGenres: profile.targetGenres.map(publicValue),
      maxRetrievalPoints: 8, currentReviewLabelsUsed: false,
      fullProductionFiltersAvailable: false,
      limitations: [
        ...(!tasteView ? ["Global taste scoring is unavailable because no frozen taste snapshot was supplied."] : []),
        "Uses available frozen metadata; missing fields are not retrieved or invented.",
        "Provider queue verification, discovery novelty/history, Last.fm history and production Sonic Blend are not replayed.",
        "Freshness uses the existing scorer's current calendar year; this is an offline score diagnostic, not a production queue simulation.",
        "The experimental rank feature uses ranks and a bounded agreement bonus, not calibrated confidence or MERT taste centroids."
      ]
    }
  };
}

module.exports = { SHADOW_FORMULA, freezeTasteView, rankEnsembleTasteShadow };
