"use strict";

const { decodeVector } = require("./sonicEmbeddingStore");

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function ratingKey(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

function normalizeSonicNeighborRating(value) {
  const key = ratingKey(value);
  if (["keep", "k", "like", "good", "love", "up"].includes(key)) return "like";
  if (["skip", "s", "down", "dislike"].includes(key)) return "skip";
  if (["wrong_genre", "wrong", "g", "not_asked", "not_what_i_asked_for"].includes(key)) return "wrong_genre";
  if (["reject_similar", "reject", "similar_bad", "similar"].includes(key)) return "reject_similar";
  return "";
}

function ratingSet(value) {
  return new Set(String(value || "")
    .split(",")
    .map((rating) => normalizeSonicNeighborRating(rating))
    .filter(Boolean));
}

function feedbackLabel(ratings) {
  const values = ratings instanceof Set ? ratings : ratingSet(ratings);
  const positive = values.has("like");
  const negative = [...values].some((rating) => ["skip", "wrong_genre", "reject_similar"].includes(rating));
  if (positive && negative) return "conflict";
  if (positive) return "positive";
  if (negative) return "negative";
  return "other";
}

function readSonicNeighborFeedbackEmbeddings(db, { model = "discogs-effnet", modelVersion = "1" } = {}) {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare(`
      SELECT tsp.id AS embedding_id, tsp.identity_key, tsp.artist, tsp.title, tsp.model, tsp.model_version,
        tsp.dimensions, tsp.embedding_base64,
        COALESCE(MAX(NULLIF(snf.candidate_area, '')), be.genre, be.subgenre, '') AS feedback_area,
        GROUP_CONCAT(DISTINCT snf.rating) AS ratings,
        COUNT(*) AS review_count
      FROM track_sonic_profile tsp
      JOIN sonic_neighbor_feedback snf ON snf.candidate_identity_key = tsp.identity_key
      LEFT JOIN track_identity ti ON ti.identity_key = tsp.identity_key
      LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
      WHERE tsp.model = ? AND tsp.model_version = ?
      GROUP BY tsp.id, tsp.identity_key, tsp.artist, tsp.title, tsp.model, tsp.model_version,
        tsp.dimensions, tsp.embedding_base64, be.genre, be.subgenre
      ORDER BY tsp.id ASC
    `).all(cleanText(model) || "discogs-effnet", cleanText(modelVersion) || "1");
  } catch {
    return [];
  }
  return rows.map((row) => {
    const vector = decodeVector(row.embedding_base64);
    const ratings = ratingSet(row.ratings);
    return {
      identityId: Number(row.embedding_id || 0),
      identityKey: cleanText(row.identity_key),
      artist: cleanText(row.artist),
      title: cleanText(row.title),
      genre: cleanText(row.feedback_area),
      subgenre: "",
      ratings: [...ratings].sort(),
      label: feedbackLabel(ratings),
      feedbackSource: "sonic-neighbor-review",
      reviewCount: Number(row.review_count || 0),
      model: cleanText(row.model),
      modelVersion: cleanText(row.model_version),
      dimensions: Number(row.dimensions || vector.length),
      vector
    };
  }).filter((row) => row.identityId && row.identityKey && row.vector.length && row.label !== "conflict");
}

function readSonicNeighborFeedbackReviews(db, { model = "discogs-effnet", modelVersion = "1" } = {}) {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare(`
      SELECT snf.id, snf.anchor_identity_key, snf.candidate_identity_key,
        snf.anchor_artist, snf.anchor_title, snf.candidate_artist, snf.candidate_title,
        snf.anchor_area, snf.candidate_area, snf.rating, snf.note, snf.source_event_id,
        snf.created_at, tsp.artist, tsp.title, tsp.embedding_base64
      FROM sonic_neighbor_feedback snf
      LEFT JOIN track_sonic_profile tsp
        ON tsp.identity_key = snf.candidate_identity_key
       AND tsp.model = ? AND tsp.model_version = ?
      WHERE snf.model = ? AND snf.model_version = ?
      ORDER BY snf.id ASC
    `).all(
      cleanText(model) || "discogs-effnet",
      cleanText(modelVersion) || "1",
      cleanText(model) || "discogs-effnet",
      cleanText(modelVersion) || "1"
    );
  } catch {
    return [];
  }
  return rows.map((row) => {
    const normalizedRating = normalizeSonicNeighborRating(row.rating);
    return {
      id: Number(row.id || 0),
      anchorIdentityKey: cleanText(row.anchor_identity_key),
      candidateIdentityKey: cleanText(row.candidate_identity_key),
      anchorArtist: cleanText(row.anchor_artist),
      anchorTitle: cleanText(row.anchor_title),
      candidateArtist: cleanText(row.candidate_artist || row.artist),
      candidateTitle: cleanText(row.candidate_title || row.title),
      anchorArea: cleanText(row.anchor_area),
      candidateArea: cleanText(row.candidate_area),
      rating: normalizedRating,
      label: normalizedRating === "like" ? "positive" : normalizedRating ? "negative" : "other",
      note: cleanText(row.note),
      sourceEventId: cleanText(row.source_event_id),
      createdAt: cleanText(row.created_at),
      vector: decodeVector(row.embedding_base64)
    };
  }).filter((row) => row.id && row.anchorIdentityKey && row.candidateIdentityKey && row.label !== "other");
}

function readSonicReviewSessionReviews(db, { model = "discogs-effnet", modelVersion = "1" } = {}) {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare(`
      SELECT s.session_id, s.anchor_identity_key, s.anchor_json,
        i.item_index, i.candidate_identity_key, i.candidate_json,
        i.decision, i.confidence, i.review_json, i.updated_at
      FROM sonic_review_session s
      JOIN sonic_review_session_item i ON i.session_id = s.session_id
      WHERE s.model = ? AND s.model_version = ?
        AND i.decision IS NOT NULL AND i.decision <> ''
      ORDER BY i.updated_at ASC, i.item_index ASC
    `).all(
      cleanText(model) || "discogs-effnet",
      cleanText(modelVersion) || "1"
    );
  } catch {
    return [];
  }
  const parse = (value, fallback = {}) => {
    try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
  };
  return rows.map((row) => {
    const decision = cleanText(row.decision).toUpperCase();
    const anchor = parse(row.anchor_json);
    const candidate = parse(row.candidate_json);
    const label = ["KEEP", "STRONG_KEEP"].includes(decision)
      ? "positive"
      : ["SKIP", "REJECT", "DUPLICATE"].includes(decision)
        ? "negative"
        : ["AMBIGUOUS", "REVIEW_MANUALLY"].includes(decision)
          ? "ambiguous"
          : "";
    const review = parse(row.review_json);
    return {
      id: `session:${cleanText(row.session_id)}:${Number(row.item_index || 0)}`,
      anchorIdentityKey: cleanText(row.anchor_identity_key),
      candidateIdentityKey: cleanText(row.candidate_identity_key),
      anchorArtist: cleanText(anchor.artist),
      anchorTitle: cleanText(anchor.title),
      candidateArtist: cleanText(candidate.artist),
      candidateTitle: cleanText(candidate.title),
      anchorArea: cleanText(anchor.genre || anchor.subgenre),
      candidateArea: cleanText(candidate.genre || candidate.subgenre),
      rating: decision,
      decision,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
      label,
      note: cleanText(review.note),
      createdAt: cleanText(row.updated_at),
      feedbackSource: "sonic-review-session"
    };
  }).filter((row) => row.anchorIdentityKey && row.candidateIdentityKey && row.label);
}

function mergeFeedbackEmbeddings(generalRows = [], sonicRows = []) {
  const rowsByIdentity = new Map((Array.isArray(generalRows) ? generalRows : []).map((row) => [row.identityKey, row]));
  for (const row of Array.isArray(sonicRows) ? sonicRows : []) {
    const existing = rowsByIdentity.get(row.identityKey);
    rowsByIdentity.set(row.identityKey, existing
      ? {
          ...existing,
          ...row,
          ratings: [...new Set([...(existing.ratings || []), ...(row.ratings || [])])].sort(),
          feedbackSource: "sonic-neighbor-review-overrides-general-for-selection"
        }
      : row);
  }
  return [...rowsByIdentity.values()];
}

module.exports = {
  feedbackLabel,
  mergeFeedbackEmbeddings,
  normalizeSonicNeighborRating,
  readSonicNeighborFeedbackEmbeddings,
  readSonicNeighborFeedbackReviews,
  readSonicReviewSessionReviews
};
