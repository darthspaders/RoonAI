"use strict";

// Read-only development harness. The live app never imports this module.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { readModelMatrix, storedRankings, publicTrack, MODELS } = require("./sonicEnsembleEvaluation");
const { normalizeVector, cosineSimilarity } = require("./sonicEmbeddingStore");

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const BATCHES = Object.freeze([
  "blind:4ee4ce40-96da-4e0a-b421-491f7749603b",
  "blind:368e39af-69a2-4041-9fa8-a97cb0ca8775",
  "blind:9ccce33f-4cde-4760-9828-399d520b9f8a"
]);

function readDevelopmentSnapshot(db) {
  const batches = [], exposedIdentities = new Set(), exposedGroups = new Set(), exposedHashes = new Set();
  for (const batchId of BATCHES) {
    const row = db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(batchId);
    assert.ok(row, "A completed development batch is missing.");
    const plan = JSON.parse(row.private_plan_json);
    const groups = plan.groups.map(group => {
      const saved = db.prepare("SELECT item_index,candidate_identity_key,status,review_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index").all(group.sessionId);
      assert.equal(saved.length, group.candidates.length);
      const pairs = group.candidates.map((candidate, index) => {
        const item = saved[index], review = JSON.parse(item.review_json || "null");
        assert.equal(item.item_index, index);
        assert.equal(item.candidate_identity_key, candidate.track.identityKey);
        assert.equal(item.status, "REVIEWED");
        assert.equal(review?.reviewer, "human");
        assert.equal(review?.listened, true);
        assert.ok(["KEEP", "WRONG_LANE", "SKIP", "UNSURE"].includes(review.decision));
        return { identityKey: candidate.track.identityKey, decision: review.decision };
      });
      for (const track of [group.anchor, ...group.candidates.map(c => c.track)]) {
        exposedIdentities.add(track.identityKey); exposedGroups.add(recordingGroup(track));
      }
      return { anchor: publicTrack(group.anchor), batchId, pairs };
    });
    for (const clip of Object.values(plan.clips || {})) if (clip.sourceSha256) exposedHashes.add(clip.sourceSha256);
    batches.push({ batchId, groups });
  }
  const pilotTime = "2026-09-26T00:16:34.864Z";
  const pilots = db.prepare("SELECT manifest_json FROM sonic_analysis_pilot WHERE json_extract(manifest_json,'$.createdAt')=?").all(pilotTime);
  assert.equal(pilots.length, 1, "The original frozen source pilot is missing or ambiguous.");
  const manifest = JSON.parse(pilots[0].manifest_json);
  assert.equal(manifest.items.length, 200, "Choose the known completed 200-track pilot explicitly before changing this experiment.");
  const matrices = new Map(MODELS.map(id => [id, readModelMatrix(db, manifest, id)]));
  for (const matrix of matrices.values()) assert.equal(matrix.records.size, manifest.items.length, "Original pool coverage changed.");
  for (const item of manifest.items) assert.deepEqual(matrices.get(MODELS[0]).records.get(item.track.identityKey).evidence,
    matrices.get(MODELS[1]).records.get(item.track.identityKey).evidence, "Original model source or spans differ.");
  const poolTracks = new Map(manifest.items.map(item => [item.track.identityKey, item.track]));
  for (const batch of batches) for (const group of batch.groups) {
    const original = poolTracks.get(group.anchor.identityKey);
    assert.ok(original, "Development anchor is missing from the original pool.");
    assert.equal(original.artist, group.anchor.artist); assert.equal(original.title, group.anchor.title);
    group.anchor = publicTrack(original);
  }
  const eligible = manifest.items.filter(item => !exposedIdentities.has(item.track.identityKey)
    && !exposedGroups.has(item.recordingGroup || recordingGroup(item.track))
    && !exposedHashes.has(item.track.analysisLocal.sha256));
  // Reserve diverse, previously unheard recording groups before any label replay.
  const heldOut = [], lanes = new Set();
  for (const item of [...eligible].sort((a, b) => a.track.identityKey.localeCompare(b.track.identityKey))) {
    const lane = String(item.track.genre || "unknown").toLowerCase();
    if (lanes.has(lane)) continue;
    heldOut.push(publicTrack(item.track)); lanes.add(lane);
    if (heldOut.length === 6) break;
  }
  assert.equal(heldOut.length, 6, "Not enough independent held-out anchor groups.");
  const rows = batches.flatMap(batch => batch.groups);
  return { manifest, matrices, development: rows, heldOut, exposure: {
    pairs: rows.reduce((n, group) => n + group.pairs.length, 0), anchorCount: rows.length,
    identities: [...exposedIdentities].sort(), recordingGroups: [...exposedGroups].sort(), sourceHashes: [...exposedHashes].sort()
  } };
}

function validateStoredResult(result, spec, source) {
  assert.ok(source && /^[a-f0-9]{64}$/.test(source.sourceSha256), "Invalid frozen source hash.");
  assert.ok(Number.isFinite(source.durationSeconds) && source.durationSeconds > 0 && source.durationSeconds <= 7200, "Invalid frozen source duration.");
  assert.equal(result.specKey, spec.key); assert.equal(result.revision, spec.revision); assert.equal(result.sampleRate, spec.sampleRate);
  assert.ok(Array.isArray(result.vector) && result.vector.length === spec.dimensions && result.vector.every(Number.isFinite), "Invalid private embedding.");
  const vector = normalizeVector(result.vector); assert.equal(vector.length, spec.dimensions);
  assert.ok(Array.isArray(result.segments) && result.segments.length === 1);
  const spans = result.segments.map(segment => [segment.start, segment.end]);
  assert.equal(spans.length, source.spans.length);
  spans.forEach(span => assert.ok(span.length === 2 && span.every(Number.isFinite) && span[0] >= 0 && span[1] > span[0]
    && span[1] <= source.durationSeconds + .001 && span[1] - span[0] <= 30.001, "Invalid stored audio spans."));
  // Both registry planners round to six decimals. Python's half-even rounding
  // and JS's rounding can differ by one microsecond, below a 24 kHz sample.
  // Preserve raw worker timestamps in the hashed result receipt and only
  // canonicalize evidence after this narrow source-bound check.
  spans.forEach((span, i) => span.forEach((value, j) => assert.ok(Number.isFinite(value) && Math.abs(value - source.spans[i][j]) <= 0.000002, "Frozen audio span changed.")));
  assert.ok(Math.abs(result.audioDurationSeconds - source.durationSeconds) < 0.001);
  const analyzed = spans.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.ok(Number.isFinite(result.analyzedSeconds) && Math.abs(result.analyzedSeconds - analyzed) < .001, "Invalid analyzed coverage.");
  assert.ok(Number.isFinite(result.sourceCoverage) && result.sourceCoverage > 0 && result.sourceCoverage <= 1.001
    && Math.abs(result.sourceCoverage - analyzed / result.audioDurationSeconds) < .0001, "Invalid source coverage.");
  for (const segment of result.segments) {
    assert.ok(Array.isArray(segment.vector) && segment.vector.length === spec.dimensions && segment.vector.every(Number.isFinite), "Invalid segment embedding.");
    const normalizedSegment = normalizeVector(segment.vector);
    assert.equal(normalizedSegment.length, spec.dimensions);
    assert.ok(cosineSimilarity(normalizedSegment, vector) > .99999, "Pooled embedding differs from its single segment.");
  }
  return { vector, evidence: { sourceSha256: source.sourceSha256, spans: source.spans.map(span => [...span]), actualSpans: spans,
    spanToleranceSeconds: 0.000002 } };
}

function grade(candidates, labels) {
  let kept = 0, wrongLane = 0, skipped = 0, unsure = 0, unjudged = 0;
  for (const candidate of candidates) {
    const decision = labels.get(candidate.track.identityKey);
    if (decision === "KEEP") kept++;
    else if (decision === "WRONG_LANE") wrongLane++;
    else if (decision === "SKIP") skipped++;
    else if (decision === "UNSURE") unsure++;
    else unjudged++;
  }
  return { returned: candidates.length, kept, wrongLane, skipped, unsure, unjudged,
    judged: kept + wrongLane + skipped, keepRateAmongJudged: kept + wrongLane + skipped ? kept / (kept + wrongLane + skipped) : null };
}

function createPrivateResultReceipt(result, spec, source) {
  assert.ok(/^sonic-source-v1-[a-f0-9]{64}$/.test(source?.snapshotKey || ""), "A frozen source snapshot receipt is required.");
  validateStoredResult(result, spec, source);
  return { version: 1, sourceSnapshotKey: source.snapshotKey, sourceSha256: source.sourceSha256,
    specKey: spec.key, revision: spec.revision, resultSha256: digest(JSON.stringify(result)), result };
}
function readPrivateResultReceipt(receipt, spec, source) {
  assert.ok(/^sonic-source-v1-[a-f0-9]{64}$/.test(source?.snapshotKey || ""), "A frozen source snapshot receipt is required.");
  assert.equal(receipt?.version, 1);
  assert.equal(receipt.sourceSnapshotKey, source.snapshotKey, "Cached result belongs to another source snapshot.");
  assert.equal(receipt.sourceSha256, source.sourceSha256, "Cached result belongs to another audio source.");
  assert.equal(receipt.specKey, spec.key); assert.equal(receipt.revision, spec.revision);
  assert.equal(receipt.resultSha256, digest(JSON.stringify(receipt.result)), "Cached result content changed.");
  validateStoredResult(receipt.result, spec, source);
  return receipt.result;
}

function evaluateAnchorExperiment(snapshot, { corpus = null, privateResults = new Map(), fitOptions = {} } = {}) {
  const { rankSonicAnchorFit } = require("./sonicAnchorFit");
  const { verifySonicCandidateCorpusCoverage } = require("./sonicCandidateCorpus");
  let coverage = null, added = [];
  const matrices = new Map(MODELS.map(id => [id, { ...snapshot.matrices.get(id), records: new Map(snapshot.matrices.get(id).records) }]));
  if (corpus) {
    const lists = MODELS.map(analyzer => {
      const spec = analysisSpec(analyzer), records = [];
      for (const item of corpus.items) {
        const result = privateResults.get(`${item.track.identityKey}|${analyzer}`);
        if (!result) continue;
        const validated = validateStoredResult(result, spec, item.source);
        records.push({ identityKey: item.track.identityKey, sourceSha256: item.source.sourceSha256, spans: validated.evidence.spans,
          dimensions: spec.dimensions, revision: spec.revision, sampleRate: spec.sampleRate });
      }
      return { analyzer, specKey: spec.key, records };
    });
    coverage = verifySonicCandidateCorpusCoverage(corpus, lists);
    const joint = new Set(coverage.jointCoverage);
    added = corpus.items.filter(item => joint.has(item.track.identityKey));
    for (const item of added) for (const analyzer of MODELS) matrices.get(analyzer).records.set(item.track.identityKey,
      validateStoredResult(privateResults.get(`${item.track.identityKey}|${analyzer}`), analysisSpec(analyzer), item.source));
  }
  const manifest = { ...snapshot.manifest, items: [...snapshot.manifest.items, ...added.map(item => ({ track: item.track, recordingGroup: recordingGroup(item.track) }))] };
  const evaluate = (group, split) => {
    const rankings = storedRankings(manifest, matrices, group.anchor, manifest.items.length);
    const labels = new Map(group.pairs.map(pair => [pair.identityKey, pair.decision]));
    return { split, anchor: group.anchor, batchId: group.batchId || null, models: rankings.map(list => {
      const fitted = rankSonicAnchorFit({ anchor: group.anchor, analyzer: list.analyzer, specKey: list.specKey,
        anchorEvidence: list.anchorEvidence, candidates: list.candidates, options: fitOptions });
      const shortlist = fitted.shortlist;
      assert.ok(Array.isArray(shortlist), "Anchor-fit contract changed.");
      const baseline = list.candidates.slice(0, 3);
      return { analyzer: list.analyzer, specKey: list.specKey, baseline, fitted,
        baselineLabels: grade(baseline, labels), fitLabels: grade(shortlist, labels),
        retrievedLabels: grade(fitted.retrievedCandidates, labels) };
    }) };
  };
  return { version: 1, createdAt: new Date().toISOString(), mode: "development-shadow", productionApplied: false,
    sourcePool: { originalLocal: snapshot.manifest.items.length, newCatalogRequested: corpus?.items.length || 0, newJointlyEncoded: added.length,
      count: manifest.items.length, manifestCreatedAt: snapshot.manifest.createdAt, corpusKey: corpus?.corpusKey || null,
      privateTimestampToleranceSeconds: 0.000002, rawWorkerTimestampsPreserved: true },
    coverage, exposure: { pairs: snapshot.exposure.pairs, anchors: snapshot.exposure.anchorCount },
    features: { supportedMetadataHints: ["soft-metadata-style", "artist", "label"], audioRhythmTempoEnergyMood: "missing-confidence-neutral",
      note: "Cached emotion regression and SheetSage sections have no calibrated confidence for anchor fit; they are not promoted to BPM, rhythm or mood labels." },
    development: snapshot.development.map(group => evaluate(group, "development")),
    heldOut: snapshot.heldOut.map(anchor => evaluate({ anchor, pairs: [] }, "held-out-unjudged")),
    limitations: ["Existing judgments are development evidence. New candidates are unjudged, never counted as successes.",
      "Preview and local-original sources remain distinct. Mixed-source retrieval is exploratory; source/excerpt effects require controlled follow-up.",
      "Metadata retrieval hints are soft and can be wrong. No strict sampling-genre gate is applied.",
      "These fixed defaults were declared before replay; no weights are fitted using the saved judgments.",
      "No production promotion, new listening judgments or global taste learning occurs."] };
}

function readPrivateResults(directory, corpus) {
  const path = require("node:path"), results = new Map();
  const { assertSonicSourceSnapshot, verifySonicCandidateCorpusCoverage } = require("./sonicCandidateCorpus");
  verifySonicCandidateCorpusCoverage(corpus, MODELS.map(analyzer => ({ analyzer, specKey: analysisSpec(analyzer).key, records: [] })));
  const folder = path.join(directory, "results");
  if (fs.existsSync(folder)) {
    const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(folder));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Private result directory escaped the experiment.");
  }
  for (const item of corpus.items) for (const analyzer of MODELS) {
    assertSonicSourceSnapshot(item.source, { track: item.track });
    const spec = analysisSpec(analyzer), file = path.join(directory, "results", `${item.source.sourceSha256}-${spec.key}.json`);
    if (fs.existsSync(file)) results.set(`${item.track.identityKey}|${analyzer}`, readPrivateResultReceipt(JSON.parse(fs.readFileSync(file, "utf8")), spec, item.source));
  }
  return results;
}

module.exports = { BATCHES, digest, readDevelopmentSnapshot, validateStoredResult, createPrivateResultReceipt, readPrivateResultReceipt,
  grade, evaluateAnchorExperiment, readPrivateResults };
