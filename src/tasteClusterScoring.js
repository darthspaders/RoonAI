"use strict";

const {
  cosineSimilarity,
  decodeVector,
  normalizeVector
} = require("./sonicEmbeddingStore");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function readTasteClusterProfiles(db, {
  model = "discogs-effnet",
  modelVersion = "1",
  status = "ready"
} = {}) {
  const clauses = ["tcp.model = ?", "tcp.model_version = ?", "tcp.embedding_base64 IS NOT NULL"];
  const params = [cleanText(model) || "discogs-effnet", cleanText(modelVersion) || "1"];
  if (cleanText(status)) {
    clauses.push("tcp.status = ?");
    params.push(cleanText(status));
  }
  const rows = db.prepare(`
    SELECT tcp.id, tcp.cluster_id, tcp.direction, tcp.model, tcp.model_version,
      tcp.dimensions, tcp.embedding_base64, tcp.status,
      tcp.linked_identity_count, tcp.feedback_identity_count,
      tcp.embedding_identity_count, tcp.feedback_event_count,
      tcp.metadata_json, tc.cluster_key, tc.name AS cluster_name
    FROM taste_cluster_profile tcp
    JOIN taste_cluster tc ON tc.id = tcp.cluster_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY tc.name ASC, tcp.direction ASC
  `).all(...params);
  const grouped = new Map();
  for (const row of rows) {
    const vector = decodeVector(row.embedding_base64);
    if (!vector.length) continue;
    const key = Number(row.cluster_id);
    const profile = grouped.get(key) || {
      clusterId: key,
      clusterKey: cleanText(row.cluster_key),
      clusterName: cleanText(row.cluster_name),
      model: cleanText(row.model),
      modelVersion: cleanText(row.model_version),
      positive: null,
      negative: null
    };
    const direction = row.direction === "positive" ? "positive" : "negative";
    let metadata = {};
    try {
      metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    } catch {
      metadata = {};
    }
    profile[direction] = {
      profileId: Number(row.id),
      direction,
      vector,
      dimensions: Number(row.dimensions || vector.length),
      status: cleanText(row.status),
      linkedIdentityCount: Number(row.linked_identity_count || 0),
      feedbackIdentityCount: Number(row.feedback_identity_count || 0),
      embeddingIdentityCount: Number(row.embedding_identity_count || 0),
      feedbackEventCount: Number(row.feedback_event_count || 0),
      metadata
    };
    grouped.set(key, profile);
  }
  return Array.from(grouped.values());
}

function scoreCandidateAgainstCluster(vector, cluster) {
  const candidate = normalizeVector(vector);
  if (!candidate.length) throw new Error("A non-empty candidate embedding vector is required.");
  const positiveSimilarity = cluster.positive
    ? cosineSimilarity(candidate, cluster.positive.vector)
    : null;
  const negativeSimilarity = cluster.negative
    ? cosineSimilarity(candidate, cluster.negative.vector)
    : null;
  const netMargin = (positiveSimilarity ?? 0) - (negativeSimilarity ?? 0);
  const rerankSignal = clamp(0.5 + (0.5 * netMargin));
  const evidence = {
    positive: cluster.positive
      ? {
          similarity: positiveSimilarity,
          feedbackIdentityCount: cluster.positive.feedbackIdentityCount,
          embeddingIdentityCount: cluster.positive.embeddingIdentityCount
        }
      : null,
    negative: cluster.negative
      ? {
          similarity: negativeSimilarity,
          feedbackIdentityCount: cluster.negative.feedbackIdentityCount,
          embeddingIdentityCount: cluster.negative.embeddingIdentityCount
        }
      : null
  };
  return {
    clusterId: cluster.clusterId,
    clusterKey: cluster.clusterKey,
    clusterName: cluster.clusterName,
    model: cluster.model,
    modelVersion: cluster.modelVersion,
    positiveSimilarity,
    negativeSimilarity,
    netMargin,
    rerankSignal,
    evidence,
    explanation: positiveSimilarity === null && negativeSimilarity !== null
      ? "Negative sonic evidence is present; use as a bounded penalty, not a hard rejection."
      : positiveSimilarity !== null && negativeSimilarity !== null
        ? "Positive and negative sonic evidence are compared within this taste cluster."
        : "Only positive sonic evidence is available for this taste cluster."
  };
}

function scoreCandidateAgainstProfiles(vector, profiles, { requestedClusterKey = "" } = {}) {
  const scores = (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => profile?.positive || profile?.negative)
    .map((profile) => scoreCandidateAgainstCluster(vector, profile))
    .sort((left, right) => {
      const leftRequested = requestedClusterKey && left.clusterKey === requestedClusterKey ? 1 : 0;
      const rightRequested = requestedClusterKey && right.clusterKey === requestedClusterKey ? 1 : 0;
      return rightRequested - leftRequested
        || right.rerankSignal - left.rerankSignal
        || left.clusterKey.localeCompare(right.clusterKey);
    });
  return {
    requestedClusterKey: cleanText(requestedClusterKey),
    scores,
    selected: scores[0] || null,
    diagnostics: {
      profileCount: scores.length,
      hasRequestedCluster: Boolean(requestedClusterKey && scores.some((score) => score.clusterKey === requestedClusterKey)),
      selectionIsHardFilter: false
    }
  };
}

module.exports = {
  clamp,
  readTasteClusterProfiles,
  scoreCandidateAgainstCluster,
  scoreCandidateAgainstProfiles
};
