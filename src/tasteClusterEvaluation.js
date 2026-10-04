"use strict";

const {
  cosineSimilarity,
  decodeVector,
  normalizeVector
} = require("./sonicEmbeddingStore");

const POSITIVE_RATINGS = new Set(["love", "like", "good", "up"]);
const NEGATIVE_RATINGS = new Set(["dislike", "skip", "never", "never_again", "down"]);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function meanNormalizedVector(vectors = []) {
  const valid = vectors.filter((vector) => Array.isArray(vector) && vector.length);
  if (!valid.length) return [];
  const dimensions = valid[0].length;
  if (valid.some((vector) => vector.length !== dimensions)) return [];
  const mean = Array.from({ length: dimensions }, () => 0);
  for (const vector of valid) {
    for (let index = 0; index < dimensions; index += 1) mean[index] += Number(vector[index]) || 0;
  }
  return normalizeVector(mean.map((value) => value / valid.length));
}

function ratingSet(value) {
  return new Set(String(value || "")
    .split(",")
    .map((rating) => cleanText(rating).toLowerCase().replace(/\s+/g, "_"))
    .filter(Boolean));
}

function feedbackLabel(ratings) {
  const values = ratings instanceof Set ? ratings : ratingSet(ratings);
  const positive = [...values].some((rating) => POSITIVE_RATINGS.has(rating));
  const negative = [...values].some((rating) => NEGATIVE_RATINGS.has(rating));
  if (positive && negative) return "conflict";
  if (positive) return "positive";
  if (negative) return "negative";
  return "other";
}

function readFeedbackEmbeddings(db, { model = "discogs-effnet", modelVersion = "1" } = {}) {
  const rows = db.prepare(`
    SELECT tsp.identity_key, tsp.artist, tsp.title, tsp.model, tsp.model_version,
      tsp.dimensions, tsp.embedding_base64,
      ti.id AS track_identity_id,
      be.genre, be.subgenre,
      GROUP_CONCAT(DISTINCT tf.rating) AS ratings
    FROM track_sonic_profile tsp
    JOIN track_identity ti ON ti.identity_key = tsp.identity_key
    LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    LEFT JOIN taste_feedback tf ON tf.track_identity_id = ti.id
    WHERE tsp.model = ? AND tsp.model_version = ?
    GROUP BY tsp.identity_key
    ORDER BY ti.id ASC
  `).all(cleanText(model) || "discogs-effnet", cleanText(modelVersion) || "1");
  return rows.map((row) => {
    const vector = decodeVector(row.embedding_base64);
    const ratings = ratingSet(row.ratings);
    return {
      identityId: Number(row.track_identity_id),
      identityKey: cleanText(row.identity_key),
      artist: cleanText(row.artist),
      title: cleanText(row.title),
      genre: cleanText(row.genre),
      subgenre: cleanText(row.subgenre),
      ratings: [...ratings].sort(),
      label: feedbackLabel(ratings),
      model: cleanText(row.model),
      modelVersion: cleanText(row.model_version),
      dimensions: Number(row.dimensions || vector.length),
      vector
    };
  }).filter((row) => row.identityId && row.identityKey && row.vector.length && row.label !== "conflict");
}

function splitHeldOut(rows = [], modulo = 5) {
  const safeModulo = Math.max(2, Number(modulo) || 5);
  const ordered = [...rows].sort((left, right) => left.identityId - right.identityId || left.identityKey.localeCompare(right.identityKey));
  const train = [];
  const test = [];
  ordered.forEach((row, index) => {
    if (index % safeModulo === 0) test.push(row);
    else train.push(row);
  });
  if (!test.length && train.length > 1) test.push(train.pop());
  return { train, test };
}

function profileContributorIds(profile) {
  const ids = profile?.metadata?.contributingTrackIdentityIds;
  return new Set(Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []);
}

function buildGlobalCentroids(trainRows = []) {
  return {
    positive: meanNormalizedVector(trainRows.filter((row) => row.label === "positive").map((row) => row.vector)),
    negative: meanNormalizedVector(trainRows.filter((row) => row.label === "negative").map((row) => row.vector))
  };
}

function buildClusterCentroids(trainRows = [], profiles = []) {
  const byId = new Map(trainRows.map((row) => [row.identityId, row]));
  const grouped = new Map();
  for (const clusterProfile of Array.isArray(profiles) ? profiles : []) {
    const directions = clusterProfile?.positive || clusterProfile?.negative
      ? [clusterProfile.positive, clusterProfile.negative].filter(Boolean)
      : [clusterProfile];
    for (const profile of directions) {
      const ids = profileContributorIds(profile);
      const key = Number(clusterProfile.clusterId || profile.clusterId) || cleanText(clusterProfile.clusterKey || profile.clusterKey);
      const entry = grouped.get(key) || {
        clusterId: clusterProfile.clusterId || profile.clusterId,
        clusterKey: cleanText(clusterProfile.clusterKey || profile.clusterKey),
        clusterName: cleanText(clusterProfile.clusterName || profile.clusterName),
        positive: [],
        negative: []
      };
      const vectors = [...ids]
        .map((id) => byId.get(id))
        .filter((row) => row?.label === profile.direction)
        .map((row) => row.vector);
      if (profile.direction === "positive" || profile.direction === "negative") {
        entry[profile.direction] = meanNormalizedVector(vectors);
      }
      grouped.set(key, entry);
    }
  }
  return [...grouped.values()].filter((profile) => profile.positive.length || profile.negative.length);
}

function scoreCentroids(vector, positive = [], negative = []) {
  const candidate = normalizeVector(vector);
  if (!candidate.length) return null;
  const positiveSimilarity = positive.length ? cosineSimilarity(candidate, positive) : null;
  const negativeSimilarity = negative.length ? cosineSimilarity(candidate, negative) : null;
  if (positiveSimilarity === null && negativeSimilarity === null) return null;
  return {
    positiveSimilarity,
    negativeSimilarity,
    netMargin: (positiveSimilarity ?? 0) - (negativeSimilarity ?? 0),
    rerankSignal: Math.max(0, Math.min(1, 0.5 + (0.5 * ((positiveSimilarity ?? 0) - (negativeSimilarity ?? 0)))))
  };
}

function requestedClusterMatches(row, cluster) {
  const text = `${row.genre} ${row.subgenre}`.toLowerCase();
  const key = cleanText(cluster.clusterKey).replace(/^metadata:/i, "").toLowerCase();
  return Boolean(key && text.includes(key));
}

function evaluationArea(row) {
  return cleanText(row?.genre) || cleanText(row?.subgenre) || "unclassified";
}

function areaCounts(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    const area = evaluationArea(row);
    counts.set(area, (counts.get(area) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function scoreHeldOutRow(row, globalCentroids, clusterCentroids) {
  const global = scoreCentroids(row.vector, globalCentroids.positive, globalCentroids.negative);
  const requested = clusterCentroids.filter((cluster) => requestedClusterMatches(row, cluster));
  const candidates = (requested.length ? requested : clusterCentroids)
    .map((cluster) => ({
      ...cluster,
      score: scoreCentroids(row.vector, cluster.positive, cluster.negative)
    }))
    .filter((cluster) => cluster.score);
  candidates.sort((left, right) => right.score.netMargin - left.score.netMargin || left.clusterKey.localeCompare(right.clusterKey));
  const best = candidates[0] || null;
  return {
    identityId: row.identityId,
    identityKey: row.identityKey,
    artist: row.artist,
    title: row.title,
    genre: row.genre,
    subgenre: row.subgenre,
    label: row.label,
    globalScore: global,
    clusterScore: best?.score || null,
    clusterKey: best?.clusterKey || null,
    clusterName: best?.clusterName || null,
    clusterSelection: requested.length ? "metadata-requested-facet" : "best-available-facet",
    requestedClusterKeys: requested.map((cluster) => cluster.clusterKey)
  };
}

function dcg(relevances) {
  return relevances.reduce((sum, relevance, index) => sum + (Number(relevance) / Math.log2(index + 2)), 0);
}

function rankingMetrics(rows = [], scoreField = "globalScore", maxK = 20) {
  const ranked = rows
    .filter((row) => row[scoreField]?.rerankSignal !== undefined)
    .sort((left, right) => right[scoreField].rerankSignal - left[scoreField].rerankSignal || left.identityKey.localeCompare(right.identityKey));
  const relevantCount = rows.filter((row) => row.label === "positive").length;
  const metrics = {};
  for (const requestedK of [5, 10, 20]) {
    const k = Math.min(requestedK, Math.max(1, Number(maxK) || 20), ranked.length);
    const top = ranked.slice(0, k);
    const hits = top.filter((row) => row.label === "positive").length;
    const ideal = Array.from({ length: Math.min(k, relevantCount) }, () => 1);
    metrics[`precisionAt${requestedK}`] = k ? Number((hits / k).toFixed(4)) : null;
    metrics[`recallAt${requestedK}`] = relevantCount ? Number((hits / relevantCount).toFixed(4)) : null;
    metrics[`ndcgAt${requestedK}`] = dcg(top.map((row) => row.label === "positive" ? 1 : 0)) && ideal.length
      ? Number((dcg(top.map((row) => row.label === "positive" ? 1 : 0)) / dcg(ideal)).toFixed(4))
      : 0;
  }
  const firstRelevant = ranked.findIndex((row) => row.label === "positive");
  metrics.mrr = firstRelevant < 0 ? 0 : Number((1 / (firstRelevant + 1)).toFixed(4));
  metrics.rankedCount = ranked.length;
  metrics.relevantCount = relevantCount;
  return metrics;
}

function evaluateTasteClusters(db, {
  model = "discogs-effnet",
  modelVersion = "1",
  profiles = [],
  splitModulo = 5
} = {}) {
  const rows = readFeedbackEmbeddings(db, { model, modelVersion });
  const positiveSplit = splitHeldOut(rows.filter((row) => row.label === "positive"), splitModulo);
  const negativeSplit = splitHeldOut(rows.filter((row) => row.label === "negative"), splitModulo);
  const train = [...positiveSplit.train, ...negativeSplit.train];
  const heldOut = [...positiveSplit.test, ...negativeSplit.test]
    .sort((left, right) => left.identityId - right.identityId || left.identityKey.localeCompare(right.identityKey));
  const globalCentroids = buildGlobalCentroids(train);
  const clusterCentroids = buildClusterCentroids(train, profiles);
  const scored = heldOut.map((row) => scoreHeldOutRow(row, globalCentroids, clusterCentroids));
  const byArea = new Map();
  for (const row of scored) {
    const area = evaluationArea(row);
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(row);
  }
  const metricsByArea = Object.fromEntries([...byArea.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([area, rowsForArea]) => [area, {
      heldOut: rowsForArea.length,
      positive: rowsForArea.filter((row) => row.label === "positive").length,
      negative: rowsForArea.filter((row) => row.label === "negative").length,
      global: rankingMetrics(rowsForArea, "globalScore"),
      clusterAware: rankingMetrics(rowsForArea, "clusterScore")
    }]));
  return {
    schemaVersion: 1,
    model,
    modelVersion,
    splitModulo: Math.max(2, Number(splitModulo) || 5),
    selection: {
      analyzedFeedbackEmbeddings: rows.length,
      train: train.length,
      heldOut: heldOut.length,
      trainPositive: positiveSplit.train.length,
      heldOutPositive: positiveSplit.test.length,
      trainNegative: negativeSplit.train.length,
      heldOutNegative: negativeSplit.test.length,
      trainByArea: areaCounts(train),
      heldOutByArea: areaCounts(heldOut)
    },
    profileCount: clusterCentroids.length,
    metrics: {
      global: rankingMetrics(scored, "globalScore"),
      clusterAware: rankingMetrics(scored, "clusterScore"),
      byArea: metricsByArea
    },
    scored
  };
}

module.exports = {
  POSITIVE_RATINGS,
  NEGATIVE_RATINGS,
  meanNormalizedVector,
  feedbackLabel,
  readFeedbackEmbeddings,
  splitHeldOut,
  buildGlobalCentroids,
  buildClusterCentroids,
  scoreCentroids,
  scoreHeldOutRow,
  evaluationArea,
  areaCounts,
  rankingMetrics,
  evaluateTasteClusters
};
