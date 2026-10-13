"use strict";

// Offline coordinator. No server imports, inference, provider lookups or writes.
const assert = require("node:assert/strict");
const path = require("node:path");
const { analysisSpec } = require("./sonicAnalysisSpec");
const { MODELS } = require("./sonicEnsembleEvaluation");
const { validateStoredResult, grade } = require("./sonicAnchorExperiment");
const { verifySonicCandidateCorpusCoverage } = require("./sonicCandidateCorpus");
const { WAVEFORM_FEATURE_SPEC, WAVEFORM_FIT_RECIPE, compareSonicWaveformVariants } = require("./sonicWaveformFit");

const sameSpans = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
  && left.every((span, i) => Array.isArray(span) && span.length === 2 && Array.isArray(right[i]) && right[i].length === 2
    && span.every((value, j) => Number.isFinite(value) && Math.abs(value - right[i][j]) <= .000002));

function buildWaveformInputManifest(snapshot, { corpus, privateResults, sourceDurations, baseDirectory, pathTransform = value => value }) {
  assert.ok(corpus && privateResults instanceof Map && sourceDurations instanceof Map);
  const coverage = verifySonicCandidateCorpusCoverage(corpus, MODELS.map(analyzer => ({ analyzer, specKey: analysisSpec(analyzer).key,
    records: corpus.items.map(item => {
      const record = validateStoredResult(privateResults.get(`${item.track.identityKey}|${analyzer}`), analysisSpec(analyzer), item.source);
      return { identityKey: item.track.identityKey, sourceSha256: record.evidence.sourceSha256, spans: record.evidence.spans,
        dimensions: analysisSpec(analyzer).dimensions, revision: analysisSpec(analyzer).revision, sampleRate: analysisSpec(analyzer).sampleRate };
    }) })));
  assert.equal(coverage.jointCoverage.length, corpus.items.length, "Both models need the entire frozen candidate corpus.");
  const items = snapshot.manifest.items.map(({ track }) => {
    const evidence = snapshot.matrices.get(MODELS[0]).records.get(track.identityKey)?.evidence;
    assert.ok(evidence, "Original source evidence is missing.");
    assert.deepEqual(evidence, snapshot.matrices.get(MODELS[1]).records.get(track.identityKey)?.evidence);
    assert.equal(evidence.sourceSha256, track.analysisLocal.sha256);
    const durationSeconds = sourceDurations.get(track.identityKey);
    assert.ok(Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 7200, "Stored source duration is missing.");
    assert.ok(evidence.spans.length === 1 && evidence.spans[0][1] <= durationSeconds + .000002);
    return { identityKey: track.identityKey, sourceSha256: evidence.sourceSha256, sourceType: "verified-local-file",
      audioPath: pathTransform(track.analysisLocal.file), spans: structuredClone(evidence.spans), durationSeconds };
  });
  for (const item of corpus.items) {
    const validated = MODELS.map(analyzer => validateStoredResult(privateResults.get(`${item.track.identityKey}|${analyzer}`), analysisSpec(analyzer), item.source));
    assert.deepEqual(validated[0].evidence.actualSpans, validated[1].evidence.actualSpans, "The two model excerpts differ.");
    assert.ok(sameSpans(validated[0].evidence.actualSpans, item.source.spans));
    items.push({ identityKey: item.track.identityKey, sourceSha256: item.source.sourceSha256, sourceType: "beatport-preview",
      sourceSnapshotKey: item.source.snapshotKey, audioPath: pathTransform(path.join(baseDirectory, "audio", `${item.source.sourceSha256}.audio`)),
      spans: structuredClone(item.source.spans), durationSeconds: item.source.durationSeconds });
  }
  assert.ok(items.length >= 1 && items.length <= 224);
  assert.equal(new Set(items.map(item => item.identityKey)).size, items.length);
  return { version: 1, items: items.sort((a, b) => a.identityKey.localeCompare(b.identityKey)) };
}

function readWaveformRecords(records, manifest) {
  assert.ok(Array.isArray(records) && records.length === manifest.items.length, "Require one completed feature receipt per frozen source.");
  const expected = new Map(manifest.items.map(item => [item.identityKey, item])), result = new Map();
  for (const record of records) {
    const item = expected.get(record?.identityKey);
    assert.ok(item && !result.has(record.identityKey), "Unexpected or duplicate feature identity.");
    assert.equal(record.version, 1); assert.ok(["ok", "unusable", "error"].includes(record.status));
    assert.equal(record.sourceSha256, item.sourceSha256, "Feature source hash changed.");
    assert.equal(record.sourceType, item.sourceType, "Feature source type changed.");
    assert.equal(record.sourceSnapshotKey, item.sourceSnapshotKey, "Feature source snapshot changed.");
    assert.ok(sameSpans(record.spans, item.spans), "Feature excerpt changed.");
    assert.deepEqual(record.spec, WAVEFORM_FEATURE_SPEC, "Feature recipe changed.");
    assert.ok(!Object.hasOwn(record, "audioPath"), "Feature receipts must not contain source paths.");
    result.set(item.identityKey, record);
  }
  return result;
}

function pairwiseKnownOrder(candidates, pairs) {
  const ranks = new Map(candidates.map((row, index) => [row.track.identityKey, index + 1]));
  const keep = pairs.filter(pair => pair.decision === "KEEP" && ranks.has(pair.identityKey));
  const rejected = pairs.filter(pair => ["WRONG_LANE", "SKIP"].includes(pair.decision) && ranks.has(pair.identityKey));
  let concordant = 0;
  for (const positive of keep) for (const negative of rejected) if (ranks.get(positive.identityKey) < ranks.get(negative.identityKey)) concordant++;
  return { compared: keep.length * rejected.length, concordant, discordant: keep.length * rejected.length - concordant,
    knownKeepRetrieved: keep.length, knownRejectedRetrieved: rejected.length,
    reviewedPairs: pairs.length, reviewedPairsRetrieved: pairs.filter(pair => ranks.has(pair.identityKey)).length,
    interpretation: "Same retrieved, judged KEEP-versus-rejected pairs only; unjudged and UNSURE excluded." };
}

function evaluateWaveformExperiment(baseline, { development, features }) {
  assert.equal(baseline.productionApplied, false); assert.ok(features instanceof Map);
  assert.equal(baseline.development.length, development.length);
  const variants = Object.keys(WAVEFORM_FIT_RECIPE.variants);
  const evaluate = (group, pairs) => {
    const labels = new Map(pairs.map(pair => [pair.identityKey, pair.decision]));
    return { split: group.split, anchor: group.anchor, batchId: group.batchId, reviewedPairs: pairs.length,
      models: group.models.map(model => {
        const ranked = compareSonicWaveformVariants({ anchor: group.anchor, analyzer: model.analyzer, specKey: model.specKey,
          anchorEvidence: model.fitted.anchorEvidence, anchorWaveform: features.get(group.anchor.identityKey),
          frozenRetrieval: model.fitted, featuresMap: features });
        assert.deepEqual(ranked["metadata-baseline"].shortlist.map(row => row.track.identityKey), model.fitted.shortlist.map(row => row.track.identityKey), "Metadata baseline changed.");
        const originalPool = model.fitted.retrievedCandidates.map(row => row.track.identityKey).sort();
        const baselineIds = new Set(model.fitted.shortlist.map(row => row.track.identityKey));
        return { analyzer: model.analyzer, specKey: model.specKey, retrievedCount: originalPool.length,
          variants: Object.fromEntries(variants.map(variant => {
            const fitted = ranked[variant];
            assert.deepEqual(fitted.retrievedCandidates.map(row => row.track.identityKey).sort(), originalPool, "Ablation candidate pool changed.");
            assert.equal(fitted.shortlist.length, 3, "Ablation must return exactly three.");
            const ids = new Set(fitted.shortlist.map(row => row.track.identityKey));
            const annotate = row => ({ identityKey: row.track.identityKey, artist: row.track.artist, title: row.track.title,
              decision: labels.get(row.track.identityKey) || "UNJUDGED" });
            return [variant, { shortlist: fitted.shortlist, labels: grade(fitted.shortlist, labels),
              pairwise: pairwiseKnownOrder(fitted.retrievedCandidates, pairs), quality: fitted.diagnostics.waveform,
              additions: fitted.shortlist.filter(row => !baselineIds.has(row.track.identityKey)).map(annotate),
              removals: model.fitted.shortlist.filter(row => !ids.has(row.track.identityKey)).map(annotate),
              knownPairRanks: pairs.map(pair => {
                const index = fitted.retrievedCandidates.findIndex(row => row.track.identityKey === pair.identityKey), row = fitted.retrievedCandidates[index];
                return { ...pair, rank: index + 1 || null, retrieved: Boolean(row), fitScore: row?.fitScore ?? null, rawSimilarity: row?.similarity ?? null,
                  familyCoverage: row ? Object.fromEntries(["rhythm", "dynamics"].map(family => [family, { available: row.waveform[family].available,
                    used: row.waveform[family].used, distance: row.waveform[family].distance, penalty: row.waveform[family].penalty,
                    anchorAvailable: row.waveform.descriptors.anchor[family].available, candidateAvailable: row.waveform.descriptors.candidate[family].available }])) : null };
              }) }];
          })) };
      }) };
  };
  const groups = baseline.development.map((group, index) => {
    const reference = development[index];
    assert.equal(group.anchor.identityKey, reference.anchor.identityKey); assert.equal(group.batchId, reference.batchId);
    return evaluate(group, reference.pairs);
  });
  const aggregate = MODELS.map(analyzer => ({ analyzer, variants: Object.fromEntries(variants.map(variant => {
    const rows = groups.map(group => group.models.find(model => model.analyzer === analyzer).variants[variant]);
    const counts = Object.fromEntries(["returned", "kept", "wrongLane", "skipped", "unsure", "unjudged", "judged"].map(key => [key, rows.reduce((sum, row) => sum + row.labels[key], 0)]));
    return [variant, { ...counts, keepRateAmongJudged: counts.judged ? counts.kept / counts.judged : null,
      pairwise: Object.fromEntries(["compared", "concordant", "discordant", "reviewedPairsRetrieved"].map(key => [key, rows.reduce((sum, row) => sum + row.pairwise[key], 0)])),
      changedAnchors: rows.filter(row => row.additions.length).length, addedKnownKeep: rows.flatMap(row => row.additions).filter(row => row.decision === "KEEP").length,
      removedKnownKeep: rows.flatMap(row => row.removals).filter(row => row.decision === "KEEP").length,
      addedUnjudged: rows.flatMap(row => row.additions).filter(row => row.decision === "UNJUDGED").length,
      reviewedPairCoverage: { total: rows.flatMap(row => row.knownPairRanks).length, retrieved: rows.flatMap(row => row.knownPairRanks).filter(pair => pair.retrieved).length,
        ...Object.fromEntries(["rhythm", "dynamics"].map(family => [family, { available: rows.flatMap(row => row.knownPairRanks).filter(pair => pair.familyCoverage?.[family].available).length,
          used: rows.flatMap(row => row.knownPairRanks).filter(pair => pair.familyCoverage?.[family].used).length }])) },
      shortlistQuality: Object.fromEntries(["rhythm", "dynamics"].map(family => [family, Object.fromEntries(["available", "used", "missing", "count"].map(key => [key, rows.reduce((sum, row) => sum + row.quality.shortlistCoverage[family][key], 0)]))])) }];
  })) }));
  return { version: 1, createdAt: new Date().toISOString(), mode: "offline-development-ablation", productionApplied: false,
    sourcePool: baseline.sourcePool, recipe: WAVEFORM_FIT_RECIPE, exposure: baseline.exposure, aggregate, development: groups,
    heldOut: baseline.heldOut.map(group => evaluate(group, [])),
    featureCoverage: { total: features.size, statuses: Object.fromEntries(["ok", "unusable", "error"].map(status => [status, [...features.values()].filter(record => record.status === status).length])),
      sourceTypes: Object.fromEntries(["verified-local-file", "beatport-preview"].map(type => [type, [...features.values()].filter(record => record.sourceType === type).length])),
      declaredFamilyValidity: Object.fromEntries(["rhythm", "dynamics"].map(family => [family, [...features.values()].filter(record => record.status === "ok" && record.reliability?.[`${family}Usable`] === true).length])),
      flags: Object.fromEntries([...new Set([...features.values()].flatMap(record => record.reliability?.flags || []))].sort().map(flag => [flag, [...features.values()].filter(record => record.reliability?.flags?.includes(flag)).length])) },
    limitations: ["The 75 saved judgments are development evidence, not independent validation. New nominations have no acceptance label.",
      "Pulse descriptors and waveform dynamics are numerical measurements, not genre, groove, mood, verified BPM or perceived musical energy.",
      "Missing descriptor families contribute zero penalty without redistributed weights and can outrank measured candidates. Pair coverage is explicit.",
      "Source type and excerpt location remain fixed but local originals and catalog previews have different audio domains.",
      "The six reserved anchors remain unjudged and do not cover the key psytrance/raw-techno failures. No fresh blind review or production promotion occurs."] };
}

function waveformMarkdown(report) {
  const lines = ["# Waveform anchor-fit experiment", "", `${report.sourcePool.count} fixed sources; ${report.exposure.pairs} development judgments; both MERT v2 models; same 20 + at most 10 retrieval; final three.`, "",
    "| Model | Variant | Known keep | Wrong lane | Unjudged | Known pair order | Changed anchors |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const model of report.aggregate) for (const [variant, row] of Object.entries(model.variants)) lines.push(`| ${model.analyzer} | ${variant} | ${row.kept} | ${row.wrongLane} | ${row.unjudged} | ${row.pairwise.concordant}/${row.pairwise.compared} | ${row.changedAnchors} |`);
  lines.push("", "Counts describe partially judged shortlists. They do not establish an acceptance rate for the new candidates.", "");
  for (const group of report.development.filter(group => group.batchId === "blind:9ccce33f-4cde-4760-9828-399d520b9f8a")) {
    lines.push(`## ${group.anchor.artist} — ${group.anchor.title}`, "");
    for (const model of group.models) for (const [variant, row] of Object.entries(model.variants)) lines.push(`- ${model.analyzer} / ${variant}: ${row.shortlist.map(candidate => `${candidate.track.artist} — ${candidate.track.title} [${group.reviewedPairs ? (row.knownPairRanks.find(pair => pair.identityKey === candidate.track.identityKey)?.decision || "UNJUDGED") : "UNJUDGED"}]`).join("; ")}`);
    lines.push("");
  }
  lines.push(...report.limitations.map(item => `- ${item}`), "");
  return lines.join("\n");
}

module.exports = { sameSpans, buildWaveformInputManifest, readWaveformRecords, pairwiseKnownOrder, evaluateWaveformExperiment, waveformMarkdown };
