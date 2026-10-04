"use strict";

const {
  cosineSimilarity,
  identityKeyFor,
  normalizeVector
} = require("./sonicEmbeddingStore");
const {
  evaluationArea,
  meanNormalizedVector,
  readFeedbackEmbeddings,
  splitHeldOut
} = require("./tasteClusterEvaluation");
const {
  mergeFeedbackEmbeddings,
  readSonicNeighborFeedbackEmbeddings,
  readSonicNeighborFeedbackReviews
} = require("./sonicNeighborFeedback");

const DEFAULT_TASTE_WEIGHT = 0.15;
const DEFAULT_MIN_POSITIVE = 3;
const DEFAULT_MIN_NEGATIVE = 2;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedFacet(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function selectionArea(track = {}) {
  if (!track || typeof track === "string") return "unclassified";
  const direct = cleanText(track.genre) || cleanText(track.subgenre);
  if (direct) return normalizedFacet(direct) || "unclassified";
  const metadata = track.metadata && typeof track.metadata === "object" ? track.metadata : {};
  return normalizedFacet(metadata.genre || metadata.subgenre || metadata.beatportGenre || metadata.beatportSubgenre || metadata.localFileGenre || metadata.localFileSubgenre) || "unclassified";
}

function areaLabel(area) {
  return cleanText(area).toLowerCase() || "unclassified";
}

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function safeWeight(value) {
  return Math.max(0, Math.min(0.5, Number.isFinite(Number(value)) ? Number(value) : DEFAULT_TASTE_WEIGHT));
}

function validRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    row && (row.label === "positive" || row.label === "negative") && normalizeVector(row.vector).length
  ));
}

function buildSonicNeighborSelectionModel(rows = [], {
  model = "discogs-effnet",
  modelVersion = "1",
  minPositiveExamples = DEFAULT_MIN_POSITIVE,
  minNegativeExamples = DEFAULT_MIN_NEGATIVE,
  tasteWeight = DEFAULT_TASTE_WEIGHT,
  source = "explicit-feedback-stored-embeddings",
  areaResolver = null,
  neighborFeedbackRows = []
} = {}) {
  const usableRows = validRows(rows);
  const minimumPositive = Math.max(1, Number(minPositiveExamples) || DEFAULT_MIN_POSITIVE);
  const minimumNegative = Math.max(1, Number(minNegativeExamples) || DEFAULT_MIN_NEGATIVE);
  const weight = safeWeight(tasteWeight);
  const grouped = new Map();
  for (const row of usableRows) {
    const area = areaLabel(evaluationArea(row) || selectionArea(row));
    if (area === "unclassified") continue;
    const entry = grouped.get(area) || { positive: [], negative: [] };
    entry[row.label].push(row);
    grouped.set(area, entry);
  }

  const areas = {};
  for (const [area, entry] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const positive = meanNormalizedVector(entry.positive.map((row) => row.vector));
    const negative = entry.negative.length >= minimumNegative
      ? meanNormalizedVector(entry.negative.map((row) => row.vector))
      : [];
    if (entry.positive.length < minimumPositive || !positive.length) continue;
    areas[area] = {
      area,
      positive,
      negative,
      positiveCount: entry.positive.length,
      negativeCount: entry.negative.length,
      negativeUsable: Boolean(negative.length),
      evidence: entry.positive.length + entry.negative.length
    };
  }

  const areaCount = Object.keys(areas).length;
  const modelState = {
    schemaVersion: 1,
    source,
    model: cleanText(model) || "discogs-effnet",
    modelVersion: cleanText(modelVersion) || "1",
    tasteWeight: weight,
    minPositiveExamples: minimumPositive,
    minNegativeExamples: minimumNegative,
    areas,
    enabled: areaCount > 0,
    summary: {
      trainingRows: usableRows.length,
      positiveRows: usableRows.filter((row) => row.label === "positive").length,
      negativeRows: usableRows.filter((row) => row.label === "negative").length,
      supportedAreaCount: areaCount,
      unsupportedAreaCount: Math.max(0, grouped.size - areaCount),
      globalCentroidUsed: false,
      directReviewCount: Array.isArray(neighborFeedbackRows) ? neighborFeedbackRows.length : 0,
      fallback: "raw-cosine"
    }
  };
  const anchorReviews = new Map();
  for (const review of Array.isArray(neighborFeedbackRows) ? neighborFeedbackRows : []) {
    if (!review?.anchorIdentityKey || !review?.candidateIdentityKey || !review?.label) continue;
    const byCandidate = anchorReviews.get(review.anchorIdentityKey) || new Map();
    byCandidate.set(review.candidateIdentityKey, review);
    anchorReviews.set(review.anchorIdentityKey, byCandidate);
  }

  function profileFor(anchorArea, candidateArea) {
    const anchor = areaLabel(anchorArea);
    const candidate = areaLabel(candidateArea);
    if (anchor === "unclassified") return null;
    if (anchor !== "unclassified" && candidate !== "unclassified" && anchor !== candidate) return null;
    return modelState.areas[candidate !== "unclassified" ? candidate : anchor] || null;
  }

  function areaFor(track) {
    const direct = selectionArea(track);
    if (direct !== "unclassified") return direct;
    if (typeof areaResolver === "function") {
      try {
        const resolved = normalizedFacet(areaResolver(track));
        if (resolved) return resolved;
      } catch {
        // Metadata lookup is optional; raw cosine remains the safe fallback.
      }
    }
    return direct;
  }

  function scoreNeighbor({
    anchor = {},
    candidate = {},
    anchorArea: suppliedAnchorArea = "",
    candidateArea: suppliedCandidateArea = "",
    anchorVector = [],
    candidateVector = [],
    rawSimilarity = null
  } = {}) {
    const resolvedAnchorArea = areaLabel(suppliedAnchorArea || areaFor(anchor));
    const resolvedCandidateArea = areaLabel(suppliedCandidateArea || areaFor(candidate));
    const anchorIdentityKey = identityKeyFor(anchor);
    const candidateIdentityKey = identityKeyFor(candidate);
    const directReview = anchorReviews.get(anchorIdentityKey)?.get(candidateIdentityKey) || null;
    const normalizedAnchor = normalizeVector(anchorVector);
    const normalizedCandidate = normalizeVector(candidateVector);
    const raw = Number.isFinite(Number(rawSimilarity))
      ? clamp(rawSimilarity)
      : (normalizedAnchor.length && normalizedCandidate.length
        ? cosineSimilarity(normalizedAnchor, normalizedCandidate)
        : null);
    const profile = profileFor(resolvedAnchorArea, resolvedCandidateArea);
    if (!profile || !normalizedCandidate.length) {
      const directAdjustment = directReview?.label === "positive" ? 0.05 : directReview?.label === "negative" ? -0.25 : 0;
      return {
        selectionScore: raw === null ? null : Number((raw + directAdjustment).toFixed(6)),
        rawSimilarity: raw,
        positiveSimilarity: null,
        negativeSimilarity: null,
        netMargin: null,
        selectionMethod: directReview
          ? `raw-cosine-plus-anchor-review-${directReview.label}`
          : !profile ? "raw-cosine-no-area-profile" : "raw-cosine-no-candidate-vector",
        area: profile?.area || null,
        areaMatched: Boolean(profile),
        directReview
      };
    }
    const positiveSimilarity = cosineSimilarity(normalizedCandidate, profile.positive);
    const negativeSimilarity = profile.negative.length
      ? cosineSimilarity(normalizedCandidate, profile.negative)
      : null;
    const netMargin = (positiveSimilarity ?? 0) - (negativeSimilarity ?? 0);
    // Keep the composite score unsaturated so close candidates remain
    // distinguishable in diagnostics. The taste adjustment itself is bounded
    // by the configured weight and the cosine-derived net margin.
    const directAdjustment = directReview?.label === "positive" ? 0.05 : directReview?.label === "negative" ? -0.25 : 0;
    const selectionScore = Number(((raw ?? 0) + (weight * netMargin) + directAdjustment).toFixed(6));
    return {
      selectionScore,
      rawSimilarity: raw,
      positiveSimilarity,
      negativeSimilarity,
      netMargin,
      selectionMethod: directReview
        ? `raw-cosine-plus-area-feedback-centroid-plus-anchor-review-${directReview.label}`
        : "raw-cosine-plus-area-feedback-centroid",
      area: profile.area,
      areaMatched: true,
      directReview,
      evidence: {
        positiveCount: profile.positiveCount,
        negativeCount: profile.negativeCount,
        negativeUsable: profile.negativeUsable
      }
    };
  }

  return {
    ...modelState,
    areaFor,
    scoreNeighbor,
    toJSON: () => modelState
  };
}

function rankingMetricsForQueries(queries = [], scoreField = "rawSimilarity") {
  const usable = queries.filter((query) => Array.isArray(query?.ranked) && query.ranked.length);
  if (!usable.length) return { queryCount: 0, precisionAt5: null, precisionAt10: null, precisionAt20: null, recallAt5: null, recallAt10: null, recallAt20: null, ndcgAt5: null, ndcgAt10: null, ndcgAt20: null, mrr: null };
  const metrics = { queryCount: usable.length };
  for (const requestedK of [5, 10, 20]) {
    let precision = 0;
    let recall = 0;
    let ndcg = 0;
    for (const query of usable) {
      const ranked = [...query.ranked].sort((left, right) => Number(right[scoreField] ?? -Infinity) - Number(left[scoreField] ?? -Infinity) || left.identityKey.localeCompare(right.identityKey));
      const k = Math.min(requestedK, ranked.length);
      const top = ranked.slice(0, k);
      const relevant = ranked.filter((row) => row.label === "positive").length;
      const hits = top.filter((row) => row.label === "positive").length;
      precision += k ? hits / k : 0;
      recall += relevant ? hits / relevant : 0;
      const dcg = top.reduce((sum, row, index) => sum + (row.label === "positive" ? 1 / Math.log2(index + 2) : 0), 0);
      const idealLength = Math.min(k, relevant);
      const ideal = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
      ndcg += ideal ? dcg / ideal : 0;
    }
    metrics[`precisionAt${requestedK}`] = Number((precision / usable.length).toFixed(4));
    metrics[`recallAt${requestedK}`] = Number((recall / usable.length).toFixed(4));
    metrics[`ndcgAt${requestedK}`] = Number((ndcg / usable.length).toFixed(4));
  }
  let mrr = 0;
  for (const query of usable) {
    const ranked = [...query.ranked].sort((left, right) => Number(right[scoreField] ?? -Infinity) - Number(left[scoreField] ?? -Infinity) || left.identityKey.localeCompare(right.identityKey));
    const firstRelevant = ranked.findIndex((row) => row.label === "positive");
    mrr += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1);
  }
  metrics.mrr = Number((mrr / usable.length).toFixed(4));
  return metrics;
}

function evaluateSonicNeighborSelection(db, {
  model = "discogs-effnet",
  modelVersion = "1",
  splitModulo = 5,
  minPositiveExamples = DEFAULT_MIN_POSITIVE,
  minNegativeExamples = DEFAULT_MIN_NEGATIVE,
  tasteWeight = DEFAULT_TASTE_WEIGHT,
  maxCandidatesPerQuery = 10000
} = {}) {
  const rows = mergeFeedbackEmbeddings(
    readFeedbackEmbeddings(db, { model, modelVersion }),
    readSonicNeighborFeedbackEmbeddings(db, { model, modelVersion })
  );
  const neighborFeedbackRows = readSonicNeighborFeedbackReviews(db, { model, modelVersion });
  const positiveSplit = splitHeldOut(rows.filter((row) => row.label === "positive"), splitModulo);
  const negativeSplit = splitHeldOut(rows.filter((row) => row.label === "negative"), splitModulo);
  const train = [...positiveSplit.train, ...negativeSplit.train];
  const heldOut = [...positiveSplit.test, ...negativeSplit.test]
    .sort((left, right) => left.identityId - right.identityId || left.identityKey.localeCompare(right.identityKey));
  const selectionModel = buildSonicNeighborSelectionModel(train, {
    model,
    modelVersion,
    minPositiveExamples,
    minNegativeExamples,
    tasteWeight,
    source: "held-out-train-split-explicit-feedback",
    neighborFeedbackRows
  });
  const queries = heldOut
    .filter((row) => row.label === "positive")
    .map((anchor) => {
      const ranked = train
        .filter((candidate) => candidate.identityKey !== anchor.identityKey)
        .slice(0, Math.max(1, Number(maxCandidatesPerQuery) || 10000))
        .map((candidate) => {
          const rawSimilarity = cosineSimilarity(normalizeVector(anchor.vector), normalizeVector(candidate.vector));
          const selection = selectionModel.scoreNeighbor({
            anchor,
            candidate,
            anchorArea: evaluationArea(anchor),
            candidateArea: evaluationArea(candidate),
            anchorVector: anchor.vector,
            candidateVector: candidate.vector,
            rawSimilarity
          });
          return {
            identityKey: candidate.identityKey,
            artist: candidate.artist,
            title: candidate.title,
            genre: candidate.genre,
            subgenre: candidate.subgenre,
            label: candidate.label,
            rawSimilarity,
            selectionScore: selection.selectionScore,
            selectionMethod: selection.selectionMethod,
            area: selection.area
          };
        });
      return {
        anchorIdentityKey: anchor.identityKey,
        anchorArtist: anchor.artist,
        anchorTitle: anchor.title,
        anchorArea: evaluationArea(anchor),
        ranked
      };
    });
  const queryPreviews = queries.slice(0, 25).map((query) => {
    const sortBy = (field) => [...query.ranked]
      .sort((left, right) => Number(right[field] ?? -Infinity) - Number(left[field] ?? -Infinity) || left.identityKey.localeCompare(right.identityKey))
      .slice(0, 10)
      .map(({ identityKey, artist, title, genre, subgenre, label, rawSimilarity, selectionScore, selectionMethod, area }) => ({
        identityKey,
        artist,
        title,
        genre,
        subgenre,
        label,
        rawSimilarity,
        selectionScore,
        selectionMethod,
        area
      }));
    return {
      anchorIdentityKey: query.anchorIdentityKey,
      anchorArtist: query.anchorArtist,
      anchorTitle: query.anchorTitle,
      anchorArea: query.anchorArea,
      rawTop10: sortBy("rawSimilarity"),
      selectorTop10: sortBy("selectionScore")
    };
  });
  return {
    schemaVersion: 1,
    model: cleanText(model) || "discogs-effnet",
    modelVersion: cleanText(modelVersion) || "1",
    splitModulo: Math.max(2, Number(splitModulo) || 5),
    selection: {
      analyzedFeedbackEmbeddings: rows.length,
      train: train.length,
      heldOut: heldOut.length,
      trainPositive: positiveSplit.train.length,
      heldOutPositive: positiveSplit.test.length,
      trainNegative: negativeSplit.train.length,
      heldOutNegative: negativeSplit.test.length,
      positiveQueryCount: queries.length,
      supportedAreaCount: selectionModel.summary.supportedAreaCount,
      globalCentroidUsed: false,
      maxCandidatesPerQuery: Math.max(1, Number(maxCandidatesPerQuery) || 10000)
    },
    modelSummary: selectionModel.summary,
    metrics: {
      rawCosine: rankingMetricsForQueries(queries, "rawSimilarity"),
      feedbackFacetSelector: rankingMetricsForQueries(queries, "selectionScore")
    },
    areas: Object.values(selectionModel.areas).map(({ area, positiveCount, negativeCount, negativeUsable, evidence }) => ({ area, positiveCount, negativeCount, negativeUsable, evidence })),
    queryPreviewCount: queryPreviews.length,
    queryPreviews
  };
}

module.exports = {
  DEFAULT_TASTE_WEIGHT,
  DEFAULT_MIN_POSITIVE,
  DEFAULT_MIN_NEGATIVE,
  normalizedFacet,
  selectionArea,
  buildSonicNeighborSelectionModel,
  rankingMetricsForQueries,
  evaluateSonicNeighborSelection
};
