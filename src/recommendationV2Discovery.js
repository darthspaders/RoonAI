"use strict";

const { explicitTidalTrackId, tidalTrackIdFromUrl } = require("./tidalIdentity");
const { trackIdentityKey } = require("./musicMemoryStore");
const {
  readTasteClusterProfiles,
  scoreCandidateAgainstProfiles
} = require("./tasteClusterScoring");
const { identityKeyFor } = require("./sonicEmbeddingStore");

const DEFAULT_MODEL = "discogs-effnet";
const DEFAULT_MODEL_VERSION = "1";
const DEFAULT_MODE = "shadow";
const DEFAULT_WEIGHT = 0.18;
const DEFAULT_MIN_COVERAGE = 0.1;
const DEFAULT_MIN_SCORED = 5;
const DEFAULT_PRODUCTION_MODE = "off";
const DEFAULT_MAX_ADJUSTMENT = 0.08;
const MAX_CONFIGURED_ADJUSTMENT = 0.25;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeMode(value) {
  const mode = cleanText(value).toLowerCase();
  return ["off", "shadow", "rerank"].includes(mode) ? mode : DEFAULT_MODE;
}

function safeModelName(value) {
  return cleanText(value) || DEFAULT_MODEL;
}

function safeModelVersion(value) {
  return cleanText(value) || DEFAULT_MODEL_VERSION;
}

function candidateIdentityKeys(candidate = {}) {
  const keys = [];
  const add = value => {
    const key = cleanText(value);
    if (!key || keys.includes(key)) return;
    keys.push(key);
  };

  const explicitId = explicitTidalTrackId(candidate);
  if (explicitId) add(`tidal:${explicitId}`);
  add(candidate.identityKey || candidate.identity_key);
  const tidalUrl = candidate.tidal?.tidalUrl || candidate.tidalUrl;
  const urlId = tidalTrackIdFromUrl(tidalUrl);
  if (urlId) add(`tidal:${urlId}`);

  const memoryKey = trackIdentityKey(candidate);
  if (memoryKey) add(memoryKey);
  const normalizedKey = identityKeyFor(candidate);
  if (normalizedKey) add(normalizedKey);
  return keys;
}

function explicitGenreTerms(options = {}, profile = {}) {
  const fields = [
    options.genre,
    options.genres,
    profile.targetGenres,
    profile.requestedGenres,
    profile.intent?.genre,
    profile.promptIntent?.genre
  ];
  const terms = [];
  for (const field of fields) {
    const values = Array.isArray(field) ? field : [field];
    for (const value of values) {
      const text = normalize(value);
      if (!text) continue;
      for (const part of text.split(/\s*,\s*|\s*\/\s*|\s*\|\s*/).map(cleanText).filter(Boolean)) {
        if (part.length > 1 && !terms.includes(part)) terms.push(part);
      }
    }
  }
  return terms;
}

function clusterDescriptor(cluster = {}) {
  const key = cleanText(cluster.clusterKey).replace(/^metadata:/i, "");
  return normalize(key || cluster.clusterName || "");
}

function requestClusterHintProfiles(profiles = [], options = {}, profile = {}) {
  const request = normalize(options.request);
  if (!request) return [];
  const aliases = new Map([
    ["wubs", ["bass", "dubstep"]],
    ["dubs", ["bass", "dubstep"]],
    ["bass music", ["bass", "dubstep"]]
  ]);
  return profiles
    .filter(item => item?.positive || item?.negative)
    .map(item => {
      const descriptor = clusterDescriptor(item);
      const descriptorTokens = descriptor.split(" ").filter(token => token.length > 2);
      let score = 0;
      if (request.includes(descriptor)) score += descriptor === request ? 100 : 20;
      for (const token of descriptorTokens) {
        if (request.split(" ").includes(token)) score += 3;
      }
      for (const [hint, targets] of aliases.entries()) {
        if (!request.includes(hint)) continue;
        if (targets.some(target => descriptor === target || descriptor.startsWith(`${target} `))) score += 10;
      }
      return { item, score };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || clusterDescriptor(left.item).localeCompare(clusterDescriptor(right.item)))
    .slice(0, 4)
    .map(item => item.item);
}

function relevantProfiles(profiles = [], options = {}, profile = {}) {
  const mode = cleanText(profile.scoringMode || options.scoringMode || "taste-guided").toLowerCase();
  if (mode === "pure") return { profiles: [], requestedClusterKeys: [], reason: "pure-search-mode" };

  const terms = explicitGenreTerms(options, profile);
  if (!terms.length) {
    const hinted = requestClusterHintProfiles(profiles, options, profile);
    if (hinted.length) {
      return {
        profiles: hinted,
        requestedClusterKeys: hinted.map(item => cleanText(item.clusterKey)).filter(Boolean),
        reason: "request-cluster-hint"
      };
    }
    const artistLed = (profile.requestedArtists || []).length > 0 ||
      /\b(?:like|similar|sounds? like|remix(?:es)? of)\b/.test(normalize(options.request));
    if (artistLed) {
      return { profiles: [], requestedClusterKeys: [], reason: "artist-led-no-cluster-hint" };
    }
    return {
      profiles: profiles.filter(item => item?.positive || item?.negative),
      requestedClusterKeys: [],
      reason: "no-explicit-genre-lane"
    };
  }

  const ranked = profiles
    .filter(item => item?.positive || item?.negative)
    .map(item => {
      const descriptor = clusterDescriptor(item);
      let score = 0;
      for (const term of terms) {
        if (descriptor.includes(term)) score += descriptor === term ? 100 : 20;
        const termTokens = term.split(" ").filter(Boolean);
        const overlap = termTokens.filter(token => descriptor.split(" ").includes(token)).length;
        score += overlap;
      }
      return { item, score };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || clusterDescriptor(left.item).localeCompare(clusterDescriptor(right.item)));

  // If the library has an exact learned facet for the requested lane, do not
  // let a broad parent facet (for example `house` or `progressive`) outrank
  // it merely because its centroid happens to be a closer vector. Parent or
  // neighboring facets remain available only when no exact facet exists.
  const exact = ranked.filter(item => item.score >= 100);
  const selected = (exact.length ? exact : ranked).slice(0, 4).map(item => item.item);
  return {
    profiles: selected,
    requestedClusterKeys: selected.map(item => cleanText(item.clusterKey)).filter(Boolean),
    reason: selected.length ? "explicit-genre-lane" : "no-matching-taste-cluster"
  };
}

function configuredNumber(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function normalizeProductionMode(value) {
  const mode = cleanText(value).toLowerCase();
  return ["off", "observe", "blend"].includes(mode) ? mode : DEFAULT_PRODUCTION_MODE;
}

function configuredMaxAdjustment(value) {
  return configuredNumber(value, DEFAULT_MAX_ADJUSTMENT, 0, MAX_CONFIGURED_ADJUSTMENT);
}

function scoreValue(candidate = {}) {
  const value = Number(candidate.score ?? candidate.scoreBreakdown?.total ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function rankPositions(entries = [], scoreFor = () => 0) {
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const scoreDifference = Number(scoreFor(right.entry)) - Number(scoreFor(left.entry));
      return scoreDifference || left.index - right.index;
    });
  const positions = new Map();
  ranked.forEach((item, index) => positions.set(item.index, index + 1));
  return positions;
}

function createRecommendationV2DiscoveryReranker({
  recommendationEngine = null,
  db = null,
  enabled = false,
  mode = DEFAULT_MODE,
  model = DEFAULT_MODEL,
  modelVersion = DEFAULT_MODEL_VERSION,
  weight = DEFAULT_WEIGHT,
  minCoverage = DEFAULT_MIN_COVERAGE,
  minScored = DEFAULT_MIN_SCORED,
  productionMode = undefined,
  maxAdjustment = DEFAULT_MAX_ADJUSTMENT,
  profilesProvider = null,
  coverageService = null,
  analysisService = null,
  logger = console
} = {}) {
  const configuredMode = normalizeMode(mode);
  const configuredModel = safeModelName(model);
  const configuredModelVersion = safeModelVersion(modelVersion);
  const configuredWeight = configuredNumber(weight, DEFAULT_WEIGHT, 0, 1);
  const configuredMinCoverage = configuredNumber(minCoverage, DEFAULT_MIN_COVERAGE, 0, 1);
  const configuredMinScored = Math.max(1, Math.round(configuredNumber(minScored, DEFAULT_MIN_SCORED, 1, 100000)));
  const hasRuntimeProductionMode = productionMode !== undefined && productionMode !== null;
  let runtimeProductionMode = hasRuntimeProductionMode ? normalizeProductionMode(productionMode) : null;
  let runtimeMaxAdjustment = configuredMaxAdjustment(maxAdjustment);

  function baseDiagnostics(overrides = {}) {
    return {
      enabled: enabled === true,
      invoked: true,
      mode: configuredMode,
      productionMode: runtimeProductionMode || DEFAULT_PRODUCTION_MODE,
      applied: false,
      model: configuredModel,
      modelVersion: configuredModelVersion,
      weight: configuredWeight,
      maxAdjustment: runtimeMaxAdjustment,
      maxAdjustmentPoints: round(runtimeMaxAdjustment * 100, 3),
      minCoverage: configuredMinCoverage,
      minScored: configuredMinScored,
      candidateCount: 0,
      scoredCount: 0,
      coverage: 0,
      profileCount: 0,
      requestedClusterKeys: [],
      selectedClusters: [],
      adjustedCount: 0,
      orderingChanged: false,
      wouldChangeOrdering: false,
      missingEmbeddingCount: 0,
      lazyFillQueuedCount: 0,
      lazyFillAlreadyInFlightCount: 0,
      coverageThresholdMet: false,
      reason: "",
      ...overrides
    };
  }

  function readProfiles() {
    if (typeof profilesProvider === "function") return profilesProvider() || [];
    if (!db) return [];
    return readTasteClusterProfiles(db, {
      model: configuredModel,
      modelVersion: configuredModelVersion,
      status: ""
    });
  }

  function embeddingFor(candidate) {
    const store = recommendationEngine?.store;
    if (!store || typeof store.getEmbedding !== "function") return null;
    for (const identityKey of candidateIdentityKeys(candidate)) {
      const embedding = store.getEmbedding(identityKey, {
        model: configuredModel,
        modelVersion: configuredModelVersion
      });
      if (embedding?.vector?.length) return { ...embedding, identityKey };
    }
    return null;
  }

  function scoreCandidate(candidate, profiles) {
    const embedding = embeddingFor(candidate);
    if (!embedding) {
      return {
        available: false,
        reason: "no-stored-learned-embedding",
        embedding: null,
        selected: null
      };
    }
    if (!profiles.length) {
      return {
        available: false,
        reason: "no-relevant-taste-cluster-profile",
        embedding,
        selected: null
      };
    }
    const scored = scoreCandidateAgainstProfiles(embedding.vector, profiles);
    return {
      available: Boolean(scored.selected),
      reason: scored.selected ? "scored-against-relevant-taste-cluster" : "no-profile-score",
      embedding,
      selected: scored.selected,
      scores: scored.scores
    };
  }

  function candidateDiagnostic(candidate, score, applied = false, blendedScore = null, details = {}) {
    const currentScore = scoreValue(candidate);
    const originalScore = Number.isFinite(Number(details.originalScore)) ? Number(details.originalScore) : currentScore;
    const finalScore = Number.isFinite(Number(details.finalScore))
      ? Number(details.finalScore)
      : (applied && blendedScore !== null ? blendedScore : currentScore);
    const wouldBeFinalScore = Number.isFinite(Number(details.wouldBeFinalScore))
      ? Number(details.wouldBeFinalScore)
      : (blendedScore === null ? finalScore : blendedScore);
    const sonicAdjustment = Number.isFinite(Number(details.sonicAdjustment))
      ? Number(details.sonicAdjustment)
      : (applied ? finalScore - originalScore : 0);
    const selected = score.selected;
    return {
      available: Boolean(score.available),
      applied,
      reason: score.reason,
      identityKey: score.embedding?.identityKey || "",
      provider: configuredModel,
      model: configuredModel,
      modelVersion: configuredModelVersion,
      dimensions: score.embedding?.dimensions || 0,
      currentScore: round(currentScore, 3),
      originalScore: round(originalScore, 3),
      sonicAdjustment: round(sonicAdjustment, 3),
      finalScore: round(finalScore, 3),
      wouldBeFinalScore: round(wouldBeFinalScore, 3),
      rankingPositionChanged: Boolean(details.rankingPositionChanged),
      wouldChangeRankingPosition: Boolean(details.wouldChangeRankingPosition),
      rankBefore: details.rankBefore ?? null,
      rankAfter: details.rankAfter ?? null,
      wouldBeRankAfter: details.wouldBeRankAfter ?? null,
      ...(selected ? {
        clusterKey: selected.clusterKey,
        clusterName: selected.clusterName,
        positiveSimilarity: round(selected.positiveSimilarity, 6),
        negativeSimilarity: selected.negativeSimilarity === null ? null : round(selected.negativeSimilarity, 6),
        netMargin: round(selected.netMargin, 6),
        sonicTasteSignal: round(selected.rerankSignal, 6),
        evidence: selected.evidence || null,
        reviewSignals: selected.evidence ? {
          positiveFeedbackIdentityCount: Number(selected.evidence.positive?.feedbackIdentityCount || 0),
          negativeFeedbackIdentityCount: Number(selected.evidence.negative?.feedbackIdentityCount || 0),
          positiveEmbeddingIdentityCount: Number(selected.evidence.positive?.embeddingIdentityCount || 0),
          negativeEmbeddingIdentityCount: Number(selected.evidence.negative?.embeddingIdentityCount || 0)
        } : null,
        explanation: selected.explanation || "",
        ...(blendedScore === null ? {} : { blendedScore: round(blendedScore, 3) })
      } : {})
    };
  }

  function productionRerankCandidates(candidates = [], { options = {}, profile = {} } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    let diagnostics = baseDiagnostics({ candidateCount: list.length });
    if (enabled !== true) {
      return { candidates: list, diagnostics: { ...diagnostics, reason: "feature-disabled" } };
    }
    if (runtimeProductionMode === "off") {
      return { candidates: list, diagnostics: { ...diagnostics, reason: "mode-off" } };
    }
    if (!recommendationEngine?.store?.enabled) {
      return { candidates: list, diagnostics: { ...diagnostics, reason: "sonic-store-unavailable" } };
    }

    let profiles = [];
    try {
      profiles = readProfiles();
    } catch (error) {
      logger?.warn?.("Recommendation Engine v2 taste profiles unavailable during Sonic production scoring", { error: error.message });
      return { candidates: list, diagnostics: { ...diagnostics, reason: "taste-profile-read-failed", error: error.message } };
    }
    const relevant = relevantProfiles(profiles, options, profile);
    diagnostics = baseDiagnostics({
      candidateCount: list.length,
      profileCount: relevant.profiles.length,
      requestedClusterKeys: relevant.requestedClusterKeys,
      selectedClusters: relevant.profiles.map(item => ({
        clusterKey: item.clusterKey,
        clusterName: item.clusterName
      }))
    });
    if (!relevant.profiles.length) {
      return { candidates: list, diagnostics: { ...diagnostics, reason: relevant.reason } };
    }

    const scoredCandidates = list.map((candidate, index) => ({
      candidate,
      index,
      score: scoreCandidate(candidate, relevant.profiles)
    }));
    const available = scoredCandidates.filter(item => item.score.available);
    const coverage = list.length ? available.length / list.length : 0;
    const coverageThresholdMet = available.length >= configuredMinScored && coverage >= configuredMinCoverage;
    const missing = scoredCandidates.filter(item => item.score.reason === "no-stored-learned-embedding").map(item => item.candidate);
    let lazyFill = {};
    if (runtimeProductionMode === "blend" && configuredModel === "discogs-effnet" && configuredModelVersion === "1" && missing.length && coverageService) {
      try { lazyFill = coverageService.enqueueMissing(missing); }
      catch (error) {
        lazyFill = { lazyFillError: error.message };
        logger?.warn?.("Sonic coverage enqueue failed; current discovery scores are unchanged", { error: error.message });
      }
    }
    const shouldApply = runtimeProductionMode === "blend" && coverageThresholdMet;
    const originalRanks = rankPositions(scoredCandidates, item => scoreValue(item.candidate));
    const scoredWithAdjustments = scoredCandidates.map(item => {
      const originalScore = scoreValue(item.candidate);
      if (!item.score.available) {
        return {
          ...item,
          originalScore,
          sonicAdjustment: 0,
          wouldBeFinalScore: originalScore,
          finalScore: originalScore
        };
      }
      const signal = clamp(item.score.selected?.rerankSignal, 0, 1);
      const requestedAdjustment = (signal * 2 - 1) * runtimeMaxAdjustment * 100;
      const wouldBeFinalScore = clamp(originalScore + requestedAdjustment, 1, 100);
      const finalScore = shouldApply ? wouldBeFinalScore : originalScore;
      return {
        ...item,
        originalScore,
        sonicAdjustment: shouldApply ? finalScore - originalScore : 0,
        wouldBeFinalScore,
        finalScore
      };
    });
    const wouldBeRanks = rankPositions(scoredWithAdjustments, item => item.wouldBeFinalScore);
    const finalRanks = rankPositions(scoredWithAdjustments, item => item.finalScore);
    const next = scoredWithAdjustments.map(item => {
      const rankingPositionChanged = originalRanks.get(item.index) !== finalRanks.get(item.index);
      const wouldChangeRankingPosition = originalRanks.get(item.index) !== wouldBeRanks.get(item.index);
      const itemDiagnostics = candidateDiagnostic(
        item.candidate,
        item.score,
        shouldApply && item.score.available,
        shouldApply && item.score.available ? item.finalScore : null,
        {
          originalScore: item.originalScore,
          sonicAdjustment: item.sonicAdjustment,
          finalScore: item.finalScore,
          wouldBeFinalScore: item.wouldBeFinalScore,
          rankingPositionChanged,
          wouldChangeRankingPosition,
          rankBefore: originalRanks.get(item.index),
          rankAfter: finalRanks.get(item.index),
          wouldBeRankAfter: wouldBeRanks.get(item.index)
        }
      );
      const nextCandidate = {
        ...item.candidate,
        recommendationV2: itemDiagnostics
      };
      if (!shouldApply || !item.score.available) return nextCandidate;
      const adjustmentLabel = `${itemDiagnostics.sonicAdjustment >= 0 ? "+" : ""}${itemDiagnostics.sonicAdjustment.toFixed(1)} pts`;
      return {
        ...nextCandidate,
        score: round(item.finalScore, 3),
        scoreBreakdown: {
          ...(item.candidate.scoreBreakdown || {}),
          total: round(item.finalScore, 3),
          recommendationV2: itemDiagnostics
        },
        reason: [
          cleanText(item.candidate.reason),
          `Sonic Review blend ${adjustmentLabel} via ${itemDiagnostics.clusterName || "profile"}`
        ].filter(Boolean).join("; ")
      };
    });

    diagnostics = {
      ...diagnostics,
      scoredCount: available.length,
      coverage: round(coverage, 4),
      missingEmbeddingCount: missing.length,
      coverageThresholdMet,
      ...lazyFill,
      applied: shouldApply,
      adjustedCount: shouldApply ? available.length : 0,
      orderingChanged: scoredWithAdjustments.some(item => originalRanks.get(item.index) !== finalRanks.get(item.index)),
      wouldChangeOrdering: scoredWithAdjustments.some(item => originalRanks.get(item.index) !== wouldBeRanks.get(item.index)),
      reason: runtimeProductionMode === "observe"
        ? "observe-only"
        : coverageThresholdMet
          ? "coverage-threshold-met"
          : "coverage-threshold-not-met"
    };
    logger?.info?.("[sonic-production] scoring", {
      mode: runtimeProductionMode,
      candidateCount: diagnostics.candidateCount,
      scoredCount: diagnostics.scoredCount,
      coverage: diagnostics.coverage,
      applied: diagnostics.applied,
      orderingChanged: diagnostics.orderingChanged,
      wouldChangeOrdering: diagnostics.wouldChangeOrdering,
      adjustments: scoredWithAdjustments
        .filter(item => item.score.available)
        .map(item => ({
          identityKey: item.candidate.identityKey || item.candidate.id || "",
          originalScore: round(item.originalScore, 3),
          sonicAdjustment: round(item.wouldBeFinalScore - item.originalScore, 3),
          finalScore: round(item.finalScore, 3),
          wouldBeFinalScore: round(item.wouldBeFinalScore, 3)
        }))
    });
    return { candidates: next, diagnostics };
  }

  function rerankCandidates(candidates = [], { options = {}, profile = {} } = {}) {
    if (hasRuntimeProductionMode) {
      return productionRerankCandidates(candidates, { options, profile });
    }
    const list = Array.isArray(candidates) ? candidates : [];
    let diagnostics = baseDiagnostics({ candidateCount: list.length });
    if (enabled !== true) {
      return { candidates: list, diagnostics: { ...diagnostics, reason: "feature-disabled" } };
    }
    if (configuredMode === "off") {
      return { candidates: list, diagnostics: { ...diagnostics, reason: "mode-off" } };
    }
    if (!recommendationEngine?.store?.enabled) {
      return { candidates: list, diagnostics: { ...diagnostics, reason: "sonic-store-unavailable" } };
    }

    let profiles = [];
    try {
      profiles = readProfiles();
    } catch (error) {
      logger?.warn?.("Recommendation Engine v2 taste profiles unavailable during discovery", { error: error.message });
      return { candidates: list, diagnostics: { ...diagnostics, reason: "taste-profile-read-failed", error: error.message } };
    }
    const relevant = relevantProfiles(profiles, options, profile);
    diagnostics = baseDiagnostics({
      candidateCount: list.length,
      profileCount: relevant.profiles.length,
      requestedClusterKeys: relevant.requestedClusterKeys,
      selectedClusters: relevant.profiles.map(item => ({
        clusterKey: item.clusterKey,
        clusterName: item.clusterName
      }))
    });
    if (!relevant.profiles.length) {
      return { candidates: list, diagnostics: { ...diagnostics, reason: relevant.reason } };
    }

    const scoredCandidates = list.map(candidate => {
      const score = scoreCandidate(candidate, relevant.profiles);
      return { candidate, score };
    });
    const available = scoredCandidates.filter(item => item.score.available);
    const coverage = list.length ? available.length / list.length : 0;
    const shouldApply = configuredMode === "rerank"
      && available.length >= configuredMinScored
      && coverage >= configuredMinCoverage;
    const next = scoredCandidates.map(({ candidate, score }) => {
      if (!score.available) {
        return {
          ...candidate,
          recommendationV2: candidateDiagnostic(candidate, score, false)
        };
      }
      const currentScore = scoreValue(candidate);
      const sonicScore = clamp(score.selected?.rerankSignal, 0, 1) * 100;
      const blendedScore = currentScore * (1 - configuredWeight) + sonicScore * configuredWeight;
      const itemDiagnostics = candidateDiagnostic(candidate, score, shouldApply, blendedScore);
      if (!shouldApply) {
        return { ...candidate, recommendationV2: itemDiagnostics };
      }
      return {
        ...candidate,
        score: round(blendedScore, 3),
        scoreBreakdown: {
          ...(candidate.scoreBreakdown || {}),
          total: round(blendedScore, 3),
          recommendationV2: itemDiagnostics
        },
        recommendationV2: itemDiagnostics,
        reason: `${cleanText(candidate.reason)}; v2 sonic/taste rerank ${itemDiagnostics.clusterName || "profile"} ${Math.round(itemDiagnostics.sonicTasteSignal * 100)}%`
      };
    });

    diagnostics = {
      ...diagnostics,
      scoredCount: available.length,
      coverage: round(coverage, 4),
      applied: shouldApply,
      reason: shouldApply
        ? "coverage-threshold-met"
        : configuredMode === "shadow"
          ? "shadow-only"
          : "coverage-threshold-not-met"
    };
    return { candidates: next, diagnostics };
  }

  function getConfig() {
    return {
      enabled: enabled === true,
      productionMode: runtimeProductionMode || DEFAULT_PRODUCTION_MODE,
      maxAdjustment: runtimeMaxAdjustment,
      maxAdjustmentPoints: round(runtimeMaxAdjustment * 100, 3),
      runtimeMutable: true,
      scope: "ranking-modifier-only",
      model: configuredModel,
      modelVersion: configuredModelVersion,
      minCoverage: configuredMinCoverage,
      minScored: configuredMinScored,
      legacyMode: configuredMode,
      legacyWeight: configuredWeight
    };
  }

  function setProductionConfig({ mode, productionMode, maxAdjustment } = {}) {
    const nextMode = mode ?? productionMode;
    if (nextMode !== undefined) {
      const normalized = cleanText(nextMode).toLowerCase();
      if (!["off", "observe", "blend"].includes(normalized)) {
        throw new Error("Sonic production mode must be off, observe, or blend.");
      }
      runtimeProductionMode = normalized;
    }
    if (maxAdjustment !== undefined) {
      const numeric = Number(maxAdjustment);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_CONFIGURED_ADJUSTMENT) {
        throw new Error(`Sonic max adjustment must be between 0 and ${MAX_CONFIGURED_ADJUSTMENT}.`);
      }
      runtimeMaxAdjustment = numeric;
    }
    return getConfig();
  }

  return {
    config: {
      enabled: enabled === true,
      mode: configuredMode,
      productionMode: runtimeProductionMode || DEFAULT_PRODUCTION_MODE,
      model: configuredModel,
      modelVersion: configuredModelVersion,
      weight: configuredWeight,
      maxAdjustment: runtimeMaxAdjustment,
      minCoverage: configuredMinCoverage,
      minScored: configuredMinScored
    },
    getConfig,
    setProductionConfig,
    rerankCandidates: (candidates, context = {}) => {
      const result = rerankCandidates(candidates, context);
      if (analysisService) {
        try { result.diagnostics.experimentalAnalysis = analysisService.observe(candidates || [], { anchor: context.options?.anchorTrack || context.options?.anchor }); }
        catch (error) { result.diagnostics.experimentalAnalysis = { mode: "shadow", productionApplied: false, error: error.message }; }
      }
      return result;
    }
  };
}

module.exports = {
  DEFAULT_MAX_ADJUSTMENT,
  DEFAULT_MIN_COVERAGE,
  DEFAULT_MIN_SCORED,
  DEFAULT_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_VERSION,
  DEFAULT_WEIGHT,
  DEFAULT_PRODUCTION_MODE,
  MAX_CONFIGURED_ADJUSTMENT,
  candidateIdentityKeys,
  createRecommendationV2DiscoveryReranker,
  explicitGenreTerms,
  normalizeMode,
  normalizeProductionMode,
  relevantProfiles
};
