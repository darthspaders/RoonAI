"use strict";

// Offline, read-only evaluation. Neither listening labels nor global ratings
// enter model retrieval/fusion. Labels are joined only after a shortlist exists.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { decodeVector, normalizeVector, cosineSimilarity } = require("./sonicEmbeddingStore");
const { fuseSonicRankings } = require("./sonicEnsemble");

const MODELS = Object.freeze(["mert-fullsong", "mert-30s"]);
const VARIANTS = Object.freeze([
  { id: "best-rank", method: "best-rank-agreement", agreementWeight: 0 },
  { id: "agreement-005", method: "best-rank-agreement", agreementWeight: 0.05 },
  { id: "agreement-010", method: "best-rank-agreement", agreementWeight: 0.1 },
  { id: "rrf-60", method: "rrf", rrfK: 60 }
]);

function publicTrack(track = {}) {
  const result = {};
  for (const key of ["identityKey", "artist", "title", "mixVersion", "album", "durationMs", "tidalId", "isrc", "genre", "subgenre", "label", "year", "releaseDate"]) {
    if (track[key] !== undefined) result[key] = track[key];
  }
  return result;
}

function validSpans(segments) {
  if (!Array.isArray(segments) || segments.length !== 1) return null;
  const spans = segments.map(segment => [segment.start, segment.end]);
  return spans.every(([start, end]) => Number.isFinite(start) && Number.isFinite(end)
    && start >= 0 && end > start && end - start <= 31) ? spans : null;
}

function readCompletedBatch(db, batchId) {
  const row = db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(batchId);
  if (!row) throw new Error("Unknown blind listening batch.");
  const plan = JSON.parse(row.private_plan_json);
  assert.equal(plan.version, 2, "Evaluation requires a fixed top-k blind batch.");
  assert.deepEqual([...plan.models].sort(), [...MODELS].sort(), "Evaluation requires both v2 checkpoints.");
  assert.ok(Number.isInteger(plan.evaluationTopK) && plan.evaluationTopK >= 1 && plan.evaluationTopK <= 10);
  assert.ok(Array.isArray(plan.groups) && plan.groups.length >= 1 && plan.groups.length <= 40);
  const statement = db.prepare("SELECT item_index,candidate_identity_key,status,review_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index");
  const groups = plan.groups.map(group => {
    const rows = statement.all(group.sessionId);
    assert.equal(rows.length, group.candidates.length, "Incomplete blind review.");
    const labels = new Map();
    const setLabel = (key, label) => {
      if (labels.has(key)) assert.equal(labels.get(key).decision, label.decision, "Conflicting alias judgments.");
      labels.set(key, label);
    };
    for (const [index, candidate] of group.candidates.entries()) {
      const item = rows[index];
      assert.equal(item.item_index, index);
      assert.equal(item.candidate_identity_key, candidate.track.identityKey, "Saved review candidate identity differs from the frozen nomination.");
      assert.equal(item.status, "REVIEWED", "Finish the blind batch before evaluating attribution.");
      const review = JSON.parse(item.review_json || "null");
      assert.ok(review && ["KEEP", "WRONG_LANE", "SKIP", "UNSURE"].includes(review.decision));
      assert.equal(review.reviewer, "human");
      if (review.decision !== "UNSURE") assert.equal(review.listened, true);
      for (const nomination of candidate.nominations) {
        assert.ok(MODELS.includes(nomination.analyzer));
        assert.equal(nomination.specKey, analysisSpec(nomination.analyzer).key, "Frozen analyzer specification changed.");
        assert.ok(nomination.rank >= 1 && nomination.rank <= plan.evaluationTopK);
        const key = nomination.identityKey || candidate.track.identityKey;
        const label = { decision: review.decision, candidate: publicTrack(candidate.track) };
        setLabel(key, label);
      }
      setLabel(candidate.track.identityKey, { decision: review.decision, candidate: publicTrack(candidate.track) });
    }
    for (const model of MODELS) {
      const ranks = group.candidates.flatMap(candidate => candidate.nominations.filter(n => n.analyzer === model).map(n => n.rank)).sort((a, b) => a - b);
      assert.deepEqual(ranks, Array.from({ length: plan.evaluationTopK }, (_, i) => i + 1));
    }
    return { ...group, labels };
  });
  assert.equal(groups.reduce((sum, group) => sum + group.candidates.length, 0), plan.count);
  const createdAt = plan.preparationRequest?.manifestCreatedAt;
  if (!createdAt) throw new Error("The batch must identify its frozen source pilot.");
  const pilots = db.prepare("SELECT manifest_json FROM sonic_analysis_pilot WHERE json_extract(manifest_json,'$.createdAt')=?").all(createdAt);
  assert.equal(pilots.length, 1, "Frozen source pilot missing or ambiguous.");
  const manifest = JSON.parse(pilots[0].manifest_json);
  assert.ok(Array.isArray(manifest.items) && manifest.items.length <= 500);
  assert.equal(new Set(manifest.items.map(item => item.track.identityKey)).size, manifest.items.length);
  return { plan, groups, manifest };
}

function readModelMatrix(db, manifest, analyzer) {
  const spec = analysisSpec(analyzer);
  const statement = db.prepare(`SELECT l.identity_key,a.source_sha256,a.result_json,p.embedding_base64,p.dimensions,p.source_sha256 AS profile_hash
    FROM sonic_analysis_link l JOIN sonic_analysis_artifact a USING(artifact_key)
    JOIN track_sonic_profile p ON p.identity_key=l.identity_key AND p.model=? AND p.model_version=l.spec_key
    WHERE l.spec_key=? AND a.spec_key=l.spec_key`);
  const requested = new Map(manifest.items.map(item => [item.track.identityKey, item]));
  const records = new Map(), rejected = [];
  for (const row of statement.all(spec.repo, spec.key)) {
    const item = requested.get(row.identity_key);
    if (!item) continue;
    const result = JSON.parse(row.result_json);
    const vector = normalizeVector(decodeVector(row.embedding_base64));
    const spans = validSpans(result.segments);
    if (row.source_sha256 !== item.track.analysisLocal?.sha256 || row.profile_hash !== row.source_sha256
      || !/^[a-f0-9]{64}$/.test(row.source_sha256) || result.specKey !== spec.key
      || result.revision !== spec.revision || result.sampleRate !== spec.sampleRate
      || row.dimensions !== spec.dimensions || vector.length !== spec.dimensions || !spans) {
      rejected.push({ identityKey: row.identity_key, reason: "invalid-or-changed-model-source-evidence" });
      continue;
    }
    records.set(row.identity_key, { vector, evidence: { sourceSha256: row.source_sha256, spans } });
  }
  return { spec, records, rejected, missingCount: manifest.items.length - records.size };
}

function storedRankings(manifest, matrices, anchor, count) {
  const anchorItem = manifest.items.find(item => item.track.identityKey === anchor.identityKey);
  assert.ok(anchorItem, "Anchor missing from the frozen pool.");
  return MODELS.map(analyzer => {
    const { spec, records } = matrices.get(analyzer), query = records.get(anchor.identityKey);
    if (!query) return { analyzer, specKey: spec.key, status: "missing-anchor", candidates: [] };
    const group = anchorItem.recordingGroup || recordingGroup(anchorItem.track);
    const ranked = manifest.items.filter(item => {
      const record = records.get(item.track.identityKey);
      return record && item.track.identityKey !== anchor.identityKey
        && (item.recordingGroup || recordingGroup(item.track)) !== group
        && record.evidence.sourceSha256 !== query.evidence.sourceSha256;
    }).map(item => ({ track: publicTrack(item.track), similarity: cosineSimilarity(query.vector, records.get(item.track.identityKey).vector),
      evidence: records.get(item.track.identityKey).evidence }))
      .sort((a, b) => b.similarity - a.similarity || a.track.identityKey.localeCompare(b.track.identityKey));
    return { analyzer, specKey: spec.key, status: ranked.length ? "available" : "missing-candidates", anchorEvidence: query.evidence,
      candidates: ranked.slice(0, count).map((candidate, index) => ({ ...candidate, rank: index + 1 })) };
  });
}

function checkFrozenNominations(group, lists, plan) {
  for (const list of lists) {
    assert.equal(list.status, "available", "This completed replay needs both original model representations.");
    assert.equal(list.candidates.length, plan.evaluationTopK);
    for (const candidate of list.candidates) {
      const frozen = group.candidates.find(item => item.nominations.some(n => n.analyzer === list.analyzer
        && n.rank === candidate.rank && (n.identityKey || item.track.identityKey) === candidate.track.identityKey));
      assert.ok(frozen, "Recomputed top-k differs from the frozen reviewed nominations; do not substitute unjudged tracks.");
      const nomination = frozen.nominations.find(n => n.analyzer === list.analyzer && n.rank === candidate.rank);
      assert.ok(Math.abs(nomination.similarity - candidate.similarity) < 0.00001, "Frozen similarity changed.");
      const clip = plan.clips[frozen.clipId], anchorClip = plan.clips[group.anchorClip];
      assert.equal(candidate.evidence.sourceSha256, clip.sourceSha256);
      assert.deepEqual(candidate.evidence.spans, [[clip.start, clip.end]]);
      assert.equal(list.anchorEvidence.sourceSha256, anchorClip.sourceSha256);
      assert.deepEqual(list.anchorEvidence.spans, [[anchorClip.start, anchorClip.end]]);
    }
  }
}

function summarizeShortlist(candidates, labels, requestedCount) {
  const rows = candidates.map(candidate => {
    const keys = [candidate.track.identityKey, ...(candidate.nominations || []).map(n => n.identityKey).filter(Boolean)];
    const known = keys.map(key => labels.get(key)).filter(Boolean);
    const label = known[0];
    if (!label) throw new Error("A replay shortlisted an unjudged recording.");
    assert.ok(known.every(item => item.decision === label.decision), "Conflicting alias judgments.");
    return { ...candidate, decision: label.decision };
  });
  const judged = rows.filter(row => row.decision !== "UNSURE").length;
  const kept = rows.filter(row => row.decision === "KEEP").length;
  return { requested: requestedCount, returned: rows.length, judged, kept,
    wrongLane: rows.filter(row => row.decision === "WRONG_LANE").length,
    skipped: rows.filter(row => row.decision === "SKIP").length,
    unjudged: rows.length - judged, unfilled: requestedCount - rows.length,
    keepRate: judged ? kept / judged : null,
    firstChoice: rows.length ? { decision: rows[0].decision, kept: rows[0].decision === "KEEP" } : null,
    candidates: rows };
}

function aggregate(anchors, id) {
  const totals = { requested: 0, returned: 0, judged: 0, kept: 0, wrongLane: 0, skipped: 0, unjudged: 0, unfilled: 0, firstChoices: 0, firstChoicesJudged: 0, firstChoicesKept: 0 };
  for (const anchor of anchors) {
    const row = anchor.results[id];
    for (const key of ["requested", "returned", "judged", "kept", "wrongLane", "skipped", "unjudged", "unfilled"]) totals[key] += row[key];
    if (row.firstChoice) {
      totals.firstChoices++;
      if (row.firstChoice.decision !== "UNSURE") totals.firstChoicesJudged++;
      if (row.firstChoice.kept) totals.firstChoicesKept++;
    }
  }
  return { id, ...totals, keepRate: totals.judged ? totals.kept / totals.judged : null, fillRate: totals.requested ? totals.returned / totals.requested : null };
}

function protectedState(db) {
  const tables = ["taste_feedback", "sonic_neighbor_feedback", "sonic_anchor_profile", "sonic_blind_review_batch",
    "sonic_review_session", "sonic_review_session_item", "sonic_review_session_audit", "sonic_coverage_work"];
  return Object.fromEntries(tables.map(table => {
    const digest = createHash("sha256"); let count = 0;
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) { digest.update(JSON.stringify(row)); count++; }
    return [table, { count, digest: digest.digest("hex") }];
  }));
}

function evaluateSonicEnsemble(db, { batchId, tasteSnapshot = null } = {}) {
  const before = protectedState(db);
  const { plan, groups, manifest } = readCompletedBatch(db, batchId);
  const matrices = new Map(MODELS.map(model => [model, readModelMatrix(db, manifest, model)]));
  const { rankEnsembleTasteShadow } = require("./sonicEnsembleTasteShadow");
  const tasteSources = ["agreement-005", ...MODELS];
  const ids = [...MODELS, ...VARIANTS.map(v => v.id), ...tasteSources.map(id => id + "-taste"), ...tasteSources.map(id => id + "-stored-lane-gate")];
  const anchors = groups.map(group => {
    const anchor = publicTrack(manifest.items.find(item => item.track.identityKey === group.anchor.identityKey).track);
    const lists = storedRankings(manifest, matrices, anchor, plan.evaluationTopK);
    checkFrozenNominations(group, lists, plan);
    const results = {};
    for (const list of lists) results[list.analyzer] = summarizeShortlist(list.candidates.map(row => ({ track: row.track,
      nominations: [{ analyzer: list.analyzer, specKey: list.specKey, rank: row.rank, similarity: row.similarity }],
      baseRankScore: 1 / row.rank, agreement: false, agreementBonus: 0, ensembleScore: 1 / row.rank,
      shadowOnly: true, queueable: false })), group.labels, plan.evaluationTopK);
    const fused = new Map();
    for (const variant of VARIANTS) {
      const { id, ...options } = variant;
      const result = fuseSonicRankings({ anchor, lists, count: plan.evaluationTopK, ...options });
      fused.set(variant.id, result);
      results[variant.id] = { ...summarizeShortlist(result.candidates, group.labels, plan.evaluationTopK), diagnostics: result.diagnostics };
    }
    const enriched = candidates => candidates.map(candidate => ({ ...candidate, track: publicTrack(manifest.items.find(item => item.track.identityKey === candidate.track.identityKey).track) }));
    for (const id of tasteSources) {
      const candidates = id === "agreement-005" ? fused.get(id).unionCandidates : results[id].candidates.map(({ decision, ...candidate }) => candidate);
      for (const preset of [{ suffix: "-taste", options: { genres: "" } }, { suffix: "-stored-lane-gate", options: { genres: anchor.genre || "" } }]) {
        const tasteResult = rankEnsembleTasteShadow({ anchor, unionCandidates: enriched(candidates), count: plan.evaluationTopK, tasteSnapshot, options: preset.options });
        results[id + preset.suffix] = { ...summarizeShortlist(tasteResult.shortlist, group.labels, plan.evaluationTopK),
          exclusions: tasteResult.excluded, diagnostics: tasteResult.diagnostics };
      }
    }
    const zero = new Set(results["best-rank"].candidates.map(candidate => candidate.track.identityKey));
    const bonusChanges = VARIANTS.filter(v => v.agreementWeight > 0).map(v => ({ id: v.id,
      added: results[v.id].candidates.filter(candidate => !zero.has(candidate.track.identityKey)).map(candidate => candidate.track.identityKey),
      removed: results["best-rank"].candidates.filter(candidate => !results[v.id].candidates.some(row => row.track.identityKey === candidate.track.identityKey)).map(candidate => candidate.track.identityKey) }));
    return { anchor, storedLane: group.lane, uniqueReviewedPairs: group.candidates.length, results, bonusChanges };
  });
  assert.deepEqual(protectedState(db), before, "Evaluation changed protected database rows.");
  return { version: 1, createdAt: new Date().toISOString(), mode: "shadow", productionApplied: false, productionPromotionAllowed: false,
    batchId, status: "exploratory-completed-review-replay", source: { manifestCreatedAt: manifest.createdAt, poolTracks: manifest.items.length,
      anchorCount: anchors.length, retrievalTopK: plan.evaluationTopK, finalShortlistCount: plan.evaluationTopK,
      recomputedFrozenNominationsMatch: true, modelSpecs: MODELS.map(model => ({ analyzer: model, specKey: analysisSpec(model).key,
        model: analysisSpec(model).repo, windowSeconds: analysisSpec(model).windowSeconds })) },
    coverage: MODELS.map(model => ({ analyzer: model, available: matrices.get(model).records.size, missing: matrices.get(model).missingCount,
      rejected: matrices.get(model).rejected })),
    configurations: VARIANTS, tastePresets: [{ suffix: "-taste", hardRequestedGenre: false }, { suffix: "-stored-lane-gate", hardRequestedGenre: true, interpretation: "Diagnostic of treating sampling metadata as an explicit genre request, not the user's similarity request." }],
    summary: ids.map(id => aggregate(anchors, id)), anchors,
    isolation: { protectedDatabaseUnchanged: true, protectedTables: before, inferenceStarted: false, playbackStarted: false,
      reviewLabelsUsedForScoring: false, newHumanJudgments: false, productionRankingChanged: false },
    limitations: ["Exploratory replay of six already reviewed anchors from one frozen collection; no held-out performance claim.",
      "Agreement weights are declared comparisons, not fitted or promoted from these labels.",
      "Taste variants use frozen global taste and existing pure admission/base-scoring rules plus an experimental rank modifier; no review labels or MERT taste centroids.",
      "Incomplete pilot metadata and absent discovery/listening history limit the taste replay; it does not exercise full online discovery, provider verification or artist diversity.",
      "Both encoders use 30-second centered excerpts. Shared votes are correlated and cannot establish calibrated confidence."] };
}

module.exports = { MODELS, VARIANTS, publicTrack, readCompletedBatch, readModelMatrix, storedRankings, summarizeShortlist, aggregate, protectedState, evaluateSonicEnsemble };
