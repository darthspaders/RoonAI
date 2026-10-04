"use strict";

const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { identityKeyFor } = require("./sonicEmbeddingStore");
const {
  SECOND_STAGE_VERSION,
  mergeSecondStageConfig,
  scoreSonicNeighborSecondStage
} = require("./sonicNeighborSecondStage");

const DEFAULT_COUNT = 20;
const MAX_COUNT = 500;
const DEFAULT_MAX_ANCHORS = 8;
const DEFAULT_MAX_ROWS = 2_000;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeCount(value, fallback = DEFAULT_COUNT) {
  return Math.max(1, Math.min(MAX_COUNT, Number(value) || fallback));
}

function identityKeysFor(value = {}) {
  const values = [
    value?.identityKey,
    value?.identity_key,
    value?.tidalId,
    value?.tidalTrackId,
    value?.tidal?.id,
    value?.tidal?.trackId,
    value?.isrc,
    identityKeyFor(value)
  ];
  return Array.from(new Set(values.map(cleanText).filter(Boolean).map((value) => {
    if (/^\d+$/.test(value)) return `tidal:${value}`;
    return value;
  })));
}

function anchorList(input = {}) {
  const supplied = Array.isArray(input.anchors)
    ? input.anchors
    : Array.isArray(input.references)
      ? input.references
      : [];
  if (supplied.length) return supplied.filter(Boolean);
  const singular = input.anchor || input.track || input.reference || input.trackId;
  return singular ? [singular] : [];
}

function metadataValues(track = {}) {
  const metadata = track.metadata && typeof track.metadata === "object" ? track.metadata : {};
  return [
    track.genre,
    track.genres,
    track.subgenre,
    track.subgenres,
    metadata.genre,
    metadata.genres,
    metadata.subgenre,
    metadata.subgenres
  ].flat().map(cleanText).filter(Boolean);
}

function explicitGenreTerms(input = {}) {
  return [input.genre, input.genres, input.targetGenres, input.genreTerms]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(normalizedText)
    .filter(Boolean);
}

function catalogSludgeReason(track = {}) {
  const text = normalizedText([
    track.artist,
    track.title,
    track.album,
    track.mixVersion,
    track.metadata?.artist,
    track.metadata?.title,
    track.metadata?.album
  ].filter(Boolean).join(" "));
  if (!text) return "missing-track-metadata";
  const rules = [
    [/\b(?:playlist|top 100|top 50|best of|greatest hits|chart hits|party hits)\b/, "catalog-playlist-sludge"],
    [/\b(?:audiobook|audio book|podcast|chapter|sound effects|white noise|sleep sounds|meditation sounds|karaoke)\b/, "non-music-catalog-sludge"],
    [/\b(?:genre|music)\s+(?:20\d{2}|19\d{2})\b/, "seo-catalog-sludge"],
    [/\b(?:official audio|lyrics video|full album|compilation album)\b/, "catalog-packaging-sludge"]
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function genreMismatchReason(track = {}, input = {}) {
  const requested = explicitGenreTerms(input);
  if (!requested.length) return "";
  const available = metadataValues(track).map(normalizedText);
  if (!available.length) return "";
  const matches = requested.some((requestedTerm) => available.some((availableTerm) => (
    availableTerm.includes(requestedTerm) || requestedTerm.includes(availableTerm)
  )));
  return matches ? "" : "genre-drift";
}

function candidateDedupeKey(track = {}) {
  const artist = normalizedText(track.artist || track.metadata?.artist);
  const title = normalizedText(track.title || track.metadata?.title);
  const mixVersion = normalizedText(track.mixVersion || track.mixName || track.metadata?.mixVersion);
  if (artist && title) return `track:${artist}|${title}|${mixVersion}`;
  return `identity:${cleanText(track.identityKey)}`;
}

function candidateFromNeighbor(neighbor = {}, anchor = {}, rank = 0, model = "", modelVersion = "", selection = null, secondStage = null) {
  const sourceTrack = neighbor.track && typeof neighbor.track === "object" ? neighbor.track : {};
  const identityKey = cleanText(neighbor.identityKey) || identityKeyFor(sourceTrack);
  if (!identityKey) return null;
  const anchorIdentityKey = identityKeysFor(anchor)[0] || identityKeyFor(anchor);
  const similarity = Number(neighbor.similarity);
  return {
    ...sourceTrack,
    identityKey,
    discoverySource: "Recommendation Engine v2 sonic neighbor",
    discoveryLane: "sonic-neighbor-shadow",
    verificationSource: "sonic-profile-shadow",
    shadowOnly: true,
    queueable: false,
    sonicNeighbor: {
      anchorIdentityKey,
      rank: rank + 1,
      similarity: Number.isFinite(similarity) ? similarity : null,
      model: cleanText(neighbor.model) || model,
      modelVersion: cleanText(neighbor.modelVersion) || modelVersion,
      ...(selection ? {
        selectionScore: selection.selectionScore,
        rawSimilarity: selection.rawSimilarity,
        positiveSimilarity: selection.positiveSimilarity,
        negativeSimilarity: selection.negativeSimilarity,
        netMargin: selection.netMargin,
        selectionMethod: selection.selectionMethod,
        selectionArea: selection.area,
        selectionEvidence: selection.evidence || null,
        directReview: selection.directReview
          ? {
              rating: selection.directReview.rating,
              label: selection.directReview.label,
              decision: selection.directReview.decision || "",
              confidence: selection.directReview.confidence ?? null,
              note: selection.directReview.note || "",
              createdAt: selection.directReview.createdAt || "",
              feedbackSource: selection.directReview.feedbackSource || ""
            }
          : null
        } : {}),
      ...(secondStage ? {
        adjustedScore: secondStage.adjustedScore,
        recommendationScore: secondStage.adjustedScore,
        secondStage: {
          version: secondStage.secondStageVersion,
          accepted: secondStage.accepted,
          rawSimilarity: secondStage.rawSimilarity,
          baseScore: secondStage.baseScore,
          adjustedScore: secondStage.adjustedScore,
          totalAdjustment: secondStage.totalAdjustment,
          bonuses: secondStage.bonuses,
          penalties: secondStage.penalties,
          rulesFired: secondStage.rulesFired,
          exclusionReason: secondStage.exclusionReason,
          metadataQuality: secondStage.metadataQuality,
          genreCompatibility: secondStage.genreCompatibility,
          arrangementCompatibility: secondStage.arrangementCompatibility,
          discoveryIntent: secondStage.discoveryIntent,
          reviewHistory: secondStage.reviewHistory,
          budgetCost: secondStage.budgetCost,
          shadowOnly: true,
          productionApplied: false
        }
      } : {})
    }
  };
}

function* sonicNeighborCandidateSteps({
  neighborEngine,
  input = {},
  logger = console,
  selectionModel = null,
  genreResolver = null
} = {}) {
  if (!neighborEngine || typeof neighborEngine.findSonicNeighbors !== "function") {
    throw new Error("A sonic neighbor engine is required.");
  }
  const anchors = anchorList(input);
  if (!anchors.length) throw new Error("At least one sonic-neighbor anchor is required.");

  const requestedCount = safeCount(input.count, DEFAULT_COUNT);
  const perAnchorCount = safeCount(input.perAnchorCount ?? input.anchorCount, requestedCount);
  const maxAnchors = Math.max(1, Math.min(DEFAULT_MAX_ANCHORS, Number(input.maxAnchors) || DEFAULT_MAX_ANCHORS));
  const maxRows = Math.max(1, Math.min(DEFAULT_MAX_ROWS, Number(input.maxRows) || DEFAULT_MAX_ROWS));
  const selectionEnabled = Boolean(selectionModel?.enabled && typeof selectionModel.scoreNeighbor === "function");
  const selectionPoolFactor = selectionEnabled
    ? Math.max(1, Math.min(8, Number(input.selectionPoolFactor) || 4))
    : 1;
  const lookupCount = selectionEnabled
    ? safeCount(input.selectionPoolCount, Math.max(perAnchorCount, perAnchorCount * selectionPoolFactor))
    : perAnchorCount;
  const selectedAnchors = anchors.slice(0, maxAnchors);
  const model = cleanText(input.model || input.provider);
  const modelVersion = cleanText(input.modelVersion);
  const secondStageConfig = mergeSecondStageConfig(input.secondStageConfig);
  const genreEvidenceCache = new Map();
  const resolveGenreEvidence = typeof genreResolver === "function"
    ? (request = {}) => {
        const track = request.track || {};
        const cacheKey = identityKeysFor(track)[0]
          || `text:${normalizedText(track.artist)}|${normalizedText(track.title)}|${normalizedText(track.mixVersion || track.mixName)}`;
        if (genreEvidenceCache.has(cacheKey)) return genreEvidenceCache.get(cacheKey);
        const evidence = genreResolver(request);
        genreEvidenceCache.set(cacheKey, evidence || {});
        return evidence || {};
      }
    : null;
  const excluded = new Set((Array.isArray(input.excludeIdentityKeys) ? input.excludeIdentityKeys : [])
    .map(cleanText)
    .filter(Boolean));
  for (const anchor of selectedAnchors) {
    for (const key of identityKeysFor(anchor)) excluded.add(key);
  }

  const diagnostics = {
    enabled: true,
    mode: "shadow",
    source: "sonic-neighbor",
    model,
    modelVersion,
    requested: requestedCount,
    perAnchorRequested: perAnchorCount,
    perAnchorLookupRequested: lookupCount,
    anchorCount: selectedAnchors.length,
    anchorsTruncated: Math.max(0, anchors.length - selectedAnchors.length),
    neighborRowsReturned: 0,
    duplicateCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    rejected: [],
    anchorDiagnostics: [],
    budgetCost: {
      maxAnchors,
      maxRows,
      anchorLookups: 0,
      requestedNeighborRows: 0,
      returnedNeighborRows: 0,
      exhausted: false
    },
    productionApplied: false,
    queueable: false,
    reason: "shadow-only-independent-source"
  };
  diagnostics.secondStage = {
    enabled: true,
    mode: "shadow",
    version: SECOND_STAGE_VERSION,
    firstStageSignal: "raw-cosine",
    productionApplied: false,
    rawSimilarityPreserved: true,
    rankedBy: "adjusted-score",
    evaluatedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    rulesFired: {},
    budgetCost: { metadataRules: 0, rawVectorRead: false },
    genreAdjustments: { ...secondStageConfig.genreAdjustments },
    maxArrangementBonusWhenGenreRisk: secondStageConfig.maxArrangementBonusWhenGenreRisk
  };
  diagnostics.selection = {
    enabled: selectionEnabled,
    method: selectionEnabled ? "raw-cosine-plus-area-feedback-centroid" : "raw-cosine",
    source: selectionEnabled ? selectionModel.source : "none",
    trainingRows: Number(selectionModel?.summary?.trainingRows || 0),
    supportedAreaCount: Number(selectionModel?.summary?.supportedAreaCount || 0),
    directReviewCount: Number(selectionModel?.summary?.directReviewCount || 0),
    globalCentroidUsed: false,
    poolFactor: selectionPoolFactor,
    fallback: "raw-cosine"
  };
  const lists = [];

  for (const anchor of selectedAnchors) {
    if (diagnostics.neighborRowsReturned >= maxRows) {
      diagnostics.budgetCost.exhausted = true;
      break;
    }
    const anchorIdentityKey = identityKeysFor(anchor)[0] || identityKeyFor(anchor) || "";
    const anchorDiagnostic = {
      source: "sonic-neighbor",
      anchorIdentityKey,
      query: anchorIdentityKey,
      requested: perAnchorCount,
      lookupRequested: lookupCount,
      returned: 0,
      duplicateCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      secondStageEvaluatedCount: 0,
      secondStageRejectedCount: 0,
      resumed: false,
      budgetCost: { neighborLookups: 1, requestedRows: lookupCount, returnedRows: 0 },
      error: ""
    };
    try {
      const result = neighborEngine.findSonicNeighbors({
        track: anchor,
        count: lookupCount,
        model,
        modelVersion,
        analyzeIfMissing: false,
        includeVector: selectionEnabled,
        minSimilarity: input.minSimilarity,
        excludeIdentityKeys: [...excluded]
      });
      yield;
      const returnedNeighbors = Array.isArray(result?.neighbors) ? result.neighbors : [];
      const remainingRows = Math.max(0, maxRows - diagnostics.neighborRowsReturned);
      const neighbors = returnedNeighbors.slice(0, remainingRows);
      anchorDiagnostic.returned = returnedNeighbors.length;
      anchorDiagnostic.budgetCost.returnedRows = neighbors.length;
      diagnostics.neighborRowsReturned += neighbors.length;
      diagnostics.budgetCost.anchorLookups += 1;
      diagnostics.budgetCost.requestedNeighborRows += lookupCount;
      diagnostics.budgetCost.returnedNeighborRows += neighbors.length;
      if (neighbors.length < returnedNeighbors.length) diagnostics.budgetCost.exhausted = true;
      const selectionAnchor = result?.query?.track || anchor;
      const rankedNeighbors = [];
      for (const [rawRank, neighbor] of neighbors.entries()) {
        const candidate = candidateFromNeighbor(neighbor, selectionAnchor, rawRank, model, modelVersion);
        const selection = selectionEnabled
          ? selectionModel.scoreNeighbor({
              anchor: selectionAnchor,
              candidate,
              anchorArea: typeof selectionModel.areaFor === "function" ? selectionModel.areaFor(selectionAnchor) : "",
              candidateArea: typeof selectionModel.areaFor === "function" ? selectionModel.areaFor(candidate) : "",
              anchorVector: result?.query?.vector || [],
              candidateVector: neighbor.vector || [],
              rawSimilarity: neighbor.similarity
            })
          : null;
        const secondStage = scoreSonicNeighborSecondStage({
          anchor: selectionAnchor,
          candidate: candidate || {},
          rawSimilarity: neighbor.similarity,
          selection,
          input,
          genreResolver: resolveGenreEvidence,
          neighborTracks: neighbors.map((item) => item.track || item)
        });
        diagnostics.secondStage.evaluatedCount += 1;
        diagnostics.secondStage.budgetCost.metadataRules += Number(secondStage.budgetCost?.metadataRules || 0);
        anchorDiagnostic.secondStageEvaluatedCount += 1;
        for (const rule of secondStage.rulesFired || []) {
          diagnostics.secondStage.rulesFired[rule] = Number(diagnostics.secondStage.rulesFired[rule] || 0) + 1;
        }
        if (!secondStage.accepted) {
          diagnostics.secondStage.rejectedCount += 1;
          anchorDiagnostic.secondStageRejectedCount += 1;
        }
        rankedNeighbors.push({
          neighbor,
          selection,
          secondStage,
          rawRank,
          rankScore: secondStage.adjustedScore ?? selection?.selectionScore ?? Number(neighbor.similarity)
        });
        yield;
      }
      rankedNeighbors.sort((left, right) => right.rankScore - left.rankScore
        || Number(right.neighbor.similarity) - Number(left.neighbor.similarity)
        || cleanText(left.neighbor.identityKey).localeCompare(cleanText(right.neighbor.identityKey)));
      lists.push({ anchor: selectionAnchor, anchorIdentityKey, neighbors: rankedNeighbors });
    } catch (error) {
      anchorDiagnostic.error = error.message;
      diagnostics.anchorDiagnostics.push(anchorDiagnostic);
      logger?.debug?.("Recommendation Engine v2 sonic-neighbor anchor failed", {
        anchor: anchorIdentityKey,
        error: error.message
      });
      continue;
    }
    diagnostics.anchorDiagnostics.push(anchorDiagnostic);
  }

  const candidates = [];
  const seen = new Set();
  const maxRounds = Math.max(0, ...lists.map(({ neighbors }) => neighbors.length));
  for (let round = 0; round < maxRounds && candidates.length < requestedCount; round += 1) {
    yield;
    for (const list of lists) {
      if (candidates.length >= requestedCount) break;
      const rankedNeighbor = list.neighbors[round];
      if (!rankedNeighbor) continue;
      const neighbor = rankedNeighbor.neighbor;
      const candidate = candidateFromNeighbor(
        neighbor,
        list.anchor,
        rankedNeighbor.rawRank,
        model,
        modelVersion,
        rankedNeighbor.selection,
        rankedNeighbor.secondStage
      );
      const identityKey = cleanText(candidate?.identityKey);
      const duplicateKey = candidateDedupeKey(candidate || {});
      const reason = !candidate
        ? "missing-identity"
        : excluded.has(identityKey)
            ? "excluded-identity"
            : seen.has(identityKey) || seen.has(duplicateKey)
              ? "duplicate"
            : rankedNeighbor.secondStage?.exclusionReason
              || catalogSludgeReason(candidate)
              || genreMismatchReason(candidate, input);
      if (reason === "duplicate") {
        diagnostics.duplicateCount += 1;
        const anchorDiagnostic = diagnostics.anchorDiagnostics.find((item) => item.anchorIdentityKey === list.anchorIdentityKey);
        if (anchorDiagnostic) anchorDiagnostic.duplicateCount += 1;
        continue;
      }
      if (reason) {
        diagnostics.rejectedCount += 1;
        const anchorDiagnostic = diagnostics.anchorDiagnostics.find((item) => item.anchorIdentityKey === list.anchorIdentityKey);
        if (anchorDiagnostic) anchorDiagnostic.rejectedCount += 1;
        if (reason !== "excluded-identity") {
          diagnostics.rejected.push({
            identityKey: identityKey || "",
            reason,
            anchorIdentityKey: list.anchorIdentityKey,
            rawSimilarity: rankedNeighbor.secondStage?.rawSimilarity ?? Number(neighbor.similarity),
            adjustedScore: rankedNeighbor.secondStage?.adjustedScore ?? null,
            rulesFired: rankedNeighbor.secondStage?.rulesFired || [],
            penalties: rankedNeighbor.secondStage?.penalties || [],
            bonuses: rankedNeighbor.secondStage?.bonuses || [],
            genreCompatibility: rankedNeighbor.secondStage?.genreCompatibility || null,
            arrangementCompatibility: rankedNeighbor.secondStage?.arrangementCompatibility || null
          });
        }
        continue;
      }
      seen.add(identityKey);
      seen.add(duplicateKey);
      candidates.push(candidate);
      diagnostics.acceptedCount += 1;
      diagnostics.secondStage.acceptedCount += 1;
      const anchorDiagnostic = diagnostics.anchorDiagnostics.find((item) => item.anchorIdentityKey === list.anchorIdentityKey);
      if (anchorDiagnostic) anchorDiagnostic.acceptedCount += 1;
    }
  }
  diagnostics.rejected = diagnostics.rejected.slice(0, 24);
  diagnostics.returned = candidates.length;
  diagnostics.budgetCost.exhausted = diagnostics.budgetCost.exhausted || (
    diagnostics.neighborRowsReturned >= maxRows && candidates.length < requestedCount
  );
  return { ok: true, candidates, diagnostics };
}

// The offline evaluator keeps its synchronous API. Live requests drain the
// same scoring steps with I/O turns so Roon heartbeats can run between rows.
function generateSonicNeighborCandidates(options = {}) {
  const steps = sonicNeighborCandidateSteps(options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

async function generateSonicNeighborCandidatesAsync(options = {}) {
  const steps = sonicNeighborCandidateSteps(options);
  while (true) {
    await yieldToEventLoop();
    const step = steps.next();
    if (step.done) return step.value;
  }
}

module.exports = {
  candidateFromNeighbor,
  candidateDedupeKey,
  catalogSludgeReason,
  generateSonicNeighborCandidates,
  generateSonicNeighborCandidatesAsync,
  genreMismatchReason,
  identityKeysFor
};
