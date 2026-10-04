"use strict";
const { specs, analysisSpec } = require("./sonicAnalysisSpec");
const { cosineSimilarity, decodeVector } = require("./sonicEmbeddingStore");
const { recordingGroup } = require("./sonicAnalysisPilot");
const positive = new Set(["love", "like", "keep", "strong_keep", "good"]);
const negative = new Set(["skip", "wrong_genre", "reject_similar", "reject", "dislike", "never"]);
const mean = values => values.length ? values.reduce((a,b) => a + b, 0) / values.length : null;
function ndcg(grades, ideal, k = 10) {
  const dcg = xs => xs.slice(0,k).reduce((sum,g,i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  const denominator = dcg(ideal);
  return denominator > 0 ? dcg(grades) / denominator : null;
}
function compareAnalysis(db, manifest, { models = ["effnet-control", "mert-fullsong", "mert-30s", "mert-330m"], anchorLimit = 30, anchorIdentityKeys = null } = {}) {
  const selected = models.map(analysisSpec);
  if (selected.some(spec => spec.kind !== "embedding")) throw new Error("Only compatible encoder experiments belong in cosine comparison.");
  const requested = manifest.items || [];
  const byModel = new Map();
  for (const spec of selected) {
    const records = new Map();
    const query = db.prepare(`SELECT p.embedding_base64,l.identity_key,a.source_sha256,a.result_json FROM sonic_analysis_link l
      JOIN sonic_analysis_artifact a USING(artifact_key)
      JOIN track_sonic_profile p ON p.identity_key=l.identity_key AND p.model=? AND p.model_version=l.spec_key
      WHERE l.spec_key=?`);
    for (const row of query.all(spec.repo, spec.key)) {
      const artifact = JSON.parse(row.result_json);
      records.set(row.identity_key, { vector: decodeVector(row.embedding_base64), hash: row.source_sha256,
        spans: artifact.segments.map(x => [x.start,x.end]), timings: artifact.timings });
    }
    byModel.set(spec.id, records);
  }
  const common = requested.filter(item => {
    const records = selected.map(spec => byModel.get(spec.id).get(item.track.identityKey));
    return records.every(Boolean) && records.every(x => x.hash === records[0].hash && JSON.stringify(x.spans) === JSON.stringify(records[0].spans));
  });
  const judgments = new Map();
  // Stored neighbor judgments are anchor-specific. Global likes are used only
  // to choose anchors, never to invent pairwise musical-relevance labels.
  for (const row of db.prepare("SELECT * FROM sonic_neighbor_feedback ORDER BY created_at,id").all()) {
    judgments.set(`${row.anchor_identity_key}|${row.candidate_identity_key}`, row);
  }
  const hasJudgment = item => [...judgments.values()].some(x => x.anchor_identity_key === item.track.identityKey);
  if (anchorIdentityKeys && anchorIdentityKeys.some(key => !common.some(item => item.track.identityKey === key))) {
    throw new Error("Every requested comparison anchor must have matching audio across all analyzers.");
  }
  const anchors = (anchorIdentityKeys ? anchorIdentityKeys.map(key => common.find(item => item.track.identityKey === key)) : [...common])
    .sort((a,b) => anchorIdentityKeys ? 0 : Number(hasJudgment(b)) - Number(hasJudgment(a)) || Number(positive.has(b.rating)) - Number(positive.has(a.rating)))
    .slice(0, Math.min(40, Math.max(1, anchorLimit)));
  const reports = selected.map(spec => {
    const matrix = byModel.get(spec.id);
    const rows = anchors.map(anchor => {
      const anchorKey = anchor.track.identityKey, query = matrix.get(anchorKey);
      const anchorGroup = anchor.recordingGroup || recordingGroup(anchor.track);
      const ranked = common.filter(x => x.track.identityKey !== anchorKey && (x.recordingGroup || recordingGroup(x.track)) !== anchorGroup && matrix.get(x.track.identityKey).hash !== query.hash)
        .map(item => ({ item, score: cosineSimilarity(query.vector, matrix.get(item.track.identityKey).vector), judgment: judgments.get(`${anchorKey}|${item.track.identityKey}`) }))
        .sort((a,b) => b.score - a.score || a.item.track.identityKey.localeCompare(b.item.track.identityKey));
      const top = ranked.slice(0,10), judged = top.filter(x => x.judgment && (positive.has(x.judgment.rating) || negative.has(x.judgment.rating)));
      const labeledRanking = ranked.filter(x => x.judgment && (positive.has(x.judgment.rating) || negative.has(x.judgment.rating)));
      const grades = labeledRanking.map(x => positive.has(x.judgment.rating) ? 1 : 0);
      return { anchor: anchor.track, judgedCount: judged.length,
        judgedPrecisionAt10: judged.length ? judged.filter(x => positive.has(x.judgment.rating)).length / judged.length : null,
        judgedCoverageAt10: top.length ? judged.length / top.length : 0,
        labeledOnlyNdcgAt10: ndcg(grades, [...grades].sort((a,b)=>b-a)),
        distinctArtistsAt10: new Set(top.map(x => x.item.track.artist)).size,
        wrongLaneJudgmentsAt10: judged.filter(x => x.judgment.rating === "wrong_genre").length,
        neighbors: top.map(x => ({ identityKey: x.item.track.identityKey, artist: x.item.track.artist, title: x.item.track.title,
          similarity: x.score, storedNeighborRating: x.judgment?.rating || null })) };
    });
    const times = common.map(item => matrix.get(item.track.identityKey).timings || {});
    return { analyzer: spec.id, specKey: spec.key, completedInManifest: requested.filter(x=>matrix.has(x.track.identityKey)).length,
      meanWarmSeconds: mean(times.filter(x=>x.loadSeconds===0).map(x=>x.totalSeconds)),
      maxGpuBytes: Math.max(0,...times.map(x=>x.peakGpuBytes||0)),
      meanJudgedPrecisionAt10: mean(rows.map(x=>x.judgedPrecisionAt10).filter(x=>x!==null)),
      meanJudgedCoverageAt10: mean(rows.map(x=>x.judgedCoverageAt10)), anchors: rows };
  });
  const judgedAnchors = reports[0]?.anchors.filter(x=>x.judgedCount>=5).length || 0;
  return { createdAt: new Date().toISOString(), productionPromotionAllowed: false,
    status: common.length < requested.length ? "analysis-incomplete" : judgedAnchors < 20 ? "needs-more-listening-judgments" : "ready-for-held-out-listening-review",
    requestedCount: requested.length, commonAudioCandidateCount: common.length, anchorCount: anchors.length,
    recordedPairJudgments: judgments.size, sufficientlyJudgedAnchors: judgedAnchors,
    models: reports, notes: ["All model comparisons use identical audio hashes, spans and candidate pools.",
      "Unjudged candidates are not assumed irrelevant; judged precision must be read alongside coverage.",
      "This is a frozen descriptive comparison, not a fitted taste model or a held-out quality claim.",
      "Long-context representations and structure/emotion estimates require separate listening evaluation; they are not averaged into cosine scores."] };
}
module.exports = { compareAnalysis, ndcg };
