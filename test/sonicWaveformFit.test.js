"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { rankSonicAnchorFit } = require("../src/sonicAnchorFit");
const { WAVEFORM_FEATURE_SPEC, WAVEFORM_FIT_RECIPE, rankSonicWaveformFit, compareSonicWaveformVariants } = require("../src/sonicWaveformFit");
const analyzer = "mert-fullsong", specKey = analysisSpec(analyzer).key;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const evidence = seed => ({ sourceSha256: hash(seed), spans: [[30, 60]] });
const anchor = () => ({ identityKey: "text:anchor", artist: "Anchor", title: "Anchor (Original Mix)", mixVersion: "Original Mix", genre: "Psy-Trance" });
function candidate(rank, changes = {}) {
  const row = { track: { identityKey: `text:candidate-${rank}`, artist: `Artist ${rank}`, title: `Track ${rank} (Original Mix)`, mixVersion: "Original Mix", genre: "Techno" }, analyzer, specKey, rank, similarity: 0.9 - rank * 0.001, evidence: evidence(rank) };
  return { ...row, ...changes, track: { ...row.track, ...changes.track } };
}
function input(rows, changes = {}) { return { anchor: anchor(), analyzer, specKey, anchorEvidence: evidence("anchor"), candidates: rows, ...changes }; }
function waveform(track, source) {
  return { version: 1, status: "ok", identityKey: track.identityKey, sourceSha256: source.sourceSha256, sourceType: "verified-local-file", spans: source.spans.map(span => [...span]),
    spec: clone(WAVEFORM_FEATURE_SPEC), decode: { sampleRate: 24000, channels: 1, samples: 720000, durationSeconds: 30, requestedDurationSeconds: 30, sourceByteLength: 12345, hashVerifiedPrePost: true, complete: true },
    descriptors: { rhythm: { onsetCount: 60, onsetRateHz: 2, periodicityPeak: 0.7, intervalCv: 0.1, phaseProfile: [1, ...Array(15).fill(0)],
      lowPulseStrength: 0.8, highPulseStrength: 0.2, lowHighOnsetCorrelation: 0.5, tempoAlternatives: [{ bpm: 120, autocorrelation: 0.7 }], tempoAutocorrelation: Array(201).fill(0.1), tempoAmbiguityRatio: 0.9, octaveAmbiguous: true, phaseConcentration: 1, lowHighPeakLagSeconds: 0 },
      dynamics: { crestFactorDb: 8, rmsRangeDb: 6, rmsVariationDb: 2, brightnessHz: 4000, bandBalance: [0.2, 0.5, 0.3] } },
    diagnostics: { silent: false, fullScaleExceedanceFraction: 0, fullScaleInterpretation: "floating-point mono may exceed full scale; not clipping proof", level: { rmsDbfs: -12, peakDbfs: -4 } },
    reliability: { usable: true, rhythmUsable: true, dynamicsUsable: true, calibrated: false, gateVersion: "waveform-gates-v2", flags: ["tempo-octave-ambiguity"] } };
}
function measuredInput(rows, changes = {}) {
  const value = input(rows, changes);
  value.anchorWaveform = waveform(value.anchor, value.anchorEvidence);
  value.candidates = rows.map(row => ({ ...row, waveform: waveform(row.track, row.evidence) }));
  return value;
}
function unlike(value) {
  const out = clone(value);
  Object.assign(out.descriptors.rhythm, { onsetCount: 300, onsetRateHz: 10, intervalCv: 3, phaseProfile: Array(16).fill(1 / 16), periodicityPeak: 0.1, lowPulseStrength: 0.1, highPulseStrength: 0.9, lowHighOnsetCorrelation: -1 });
  Object.assign(out.descriptors.dynamics, { crestFactorDb: 48, rmsRangeDb: 120 });
  return out;
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("the recipe freezes exact descriptors and four fixed modest penalty variants", () => {
  assert.deepEqual(WAVEFORM_FIT_RECIPE.variants, { "metadata-baseline": { rhythm: 0, dynamics: 0 }, "rhythm-only": { rhythm: 0.06, dynamics: 0 }, "dynamics-only": { rhythm: 0, dynamics: 0.04 }, combined: { rhythm: 0.06, dynamics: 0.04 } });
  assert.equal(WAVEFORM_FIT_RECIPE.maxAudioPenalty, 0.1);
  assert.equal(WAVEFORM_FIT_RECIPE.version, 2);
  assert.equal(WAVEFORM_FEATURE_SPEC.version, 2);
  assert.equal(WAVEFORM_FEATURE_SPEC.decodeSampleTolerance, 1);
  assert.ok(Object.isFrozen(WAVEFORM_FIT_RECIPE) && Object.isFrozen(WAVEFORM_FIT_RECIPE.featureSpec.bandsHz[0]));
  assert.deepEqual(clone(WAVEFORM_FIT_RECIPE), WAVEFORM_FIT_RECIPE);
});

test("identical measured descriptors preserve raw cosine and metadata scores", () => {
  const value = measuredInput([candidate(1), candidate(2), candidate(3)]);
  const result = rankSonicWaveformFit(value);
  assert.deepEqual(result.shortlist.map(row => row.rank), [1, 2, 3]);
  for (const row of result.shortlist) {
    assert.equal(row.waveform.rhythm.distance, 0);
    assert.equal(row.waveform.dynamics.distance, 0);
    assert.equal(row.waveform.audioPenalty, 0);
    assert.equal(row.fitScore, row.similarity);
    assert.equal(row.specKey, specKey);
    assert.deepEqual(row.evidence, value.candidates.find(x => x.rank === row.rank).evidence);
  }
  assert.equal(result.diagnostics.waveform.shortlistCoverage.rhythm.used, 3);
  assert.equal(result.diagnostics.waveform.shortlistCoverage.dynamics.used, 3);
});

test("numerical mismatches can rerank close candidates without mixing model vectors", () => {
  const value = measuredInput([candidate(1), candidate(2), candidate(3)]);
  value.candidates[0].waveform = unlike(value.candidates[0].waveform);
  const result = rankSonicWaveformFit(value);
  assert.deepEqual(result.shortlist.map(row => row.rank), [2, 3, 1]);
  const moved = result.shortlist[2];
  assert.ok(moved.waveform.audioPenalty > 0 && moved.waveform.audioPenalty <= 0.1);
  assert.equal(moved.metadataBaselineRank, 1);
  assert.equal(moved.rawRank, 1);
  assert.equal(moved.fitScore, moved.metadataFitScore - moved.waveform.audioPenalty);
  assert.equal(moved.similarity, value.candidates[0].similarity);
  assert.equal(result.diagnostics.crossModelVectorsMixed, false);
  const expected = moved.waveform.rhythm.distance * 0.06 + moved.waveform.dynamics.distance * 0.04;
  assert.equal(moved.waveform.audioPenalty, expected);
});

test("all ablations use the same frozen members and a fixed final three", () => {
  const rows = Array.from({ length: 35 }, (_, i) => candidate(i + 1));
  rows.slice(20).forEach(row => { row.track.genre = "Psy-Trance"; });
  const value = measuredInput(rows);
  value.candidates[0].waveform = unlike(value.candidates[0].waveform);
  const variants = compareSonicWaveformVariants(value);
  const members = result => result.retrievedCandidates.map(row => row.track.identityKey).sort();
  for (const [name, result] of Object.entries(variants)) {
    assert.equal(result.shortlist.length, 3);
    assert.equal(result.retrievedCandidates.length, 30);
    assert.deepEqual(members(result), members(variants["metadata-baseline"]));
    assert.equal(result.variant, name);
    assert.ok(result.retrievedCandidates.every(row => row.waveform.audioPenalty <= 0.1));
  }
  assert.ok(variants["metadata-baseline"].retrievedCandidates.every(row => row.waveform.audioPenalty === 0));
  assert.ok(variants["rhythm-only"].retrievedCandidates.every(row => row.waveform.dynamics.penalty === 0));
  assert.ok(variants["dynamics-only"].retrievedCandidates.every(row => row.waveform.rhythm.penalty === 0));
});

test("phase-share distance is rotation invariant and tempo alternatives are unresolved diagnostics", () => {
  const value = measuredInput([candidate(1)]), r = value.candidates[0].waveform.descriptors.rhythm;
  r.phaseProfile = [0, 0, 0, 1, ...Array(12).fill(0)];
  r.tempoAlternatives = [{ bpm: 240, autocorrelation: 0.9 }];
  r.tempoAutocorrelation = Array(201).fill(0.9);
  r.tempoAmbiguityRatio = 0.1;
  r.octaveAmbiguous = false;
  const row = rankSonicWaveformFit(value).shortlist[0];
  assert.equal(row.waveform.rhythm.distance, 0);
  assert.equal(row.waveform.rhythm.components.phaseProfile.distance, 0);
  assert.equal(row.waveform.descriptors.anchor.rhythm.diagnostics.octaveAmbiguous, true);
  assert.equal(row.waveform.descriptors.candidate.rhythm.diagnostics.octaveAmbiguous, false);
});

test("absolute mastering level, brightness and catalogue tags do not become energy preferences", () => {
  const value = measuredInput([candidate(1)]), wf = value.candidates[0].waveform;
  wf.diagnostics.level = { rmsDbfs: -60, peakDbfs: -40 };
  wf.descriptors.dynamics.brightnessHz = 100;
  wf.descriptors.dynamics.bandBalance = [1, 0, 0];
  wf.descriptors.dynamics.rmsVariationDb = 99;
  value.candidates[0].track.bpm = 240;
  value.candidates[0].track.energy = "intense";
  const result = rankSonicWaveformFit(value);
  assert.equal(result.shortlist[0].waveform.dynamics.distance, 0);
  assert.equal(result.shortlist[0].waveform.audioPenalty, 0);
  assert.equal(result.diagnostics.waveform.calibrationUsed, false);
});

test("missing families are neutral and weights are never redistributed", () => {
  const value = measuredInput([candidate(1)]);
  value.candidates[0].waveform = unlike(value.candidates[0].waveform);
  value.candidates[0].waveform.reliability.rhythmUsable = false;
  const combined = rankSonicWaveformFit(value), dynamics = rankSonicWaveformFit({ ...value, variant: "dynamics-only" });
  assert.equal(combined.shortlist[0].waveform.rhythm.penalty, 0);
  assert.equal(combined.shortlist[0].waveform.audioPenalty, dynamics.shortlist[0].waveform.audioPenalty);
  assert.equal(combined.diagnostics.waveform.shortlistCoverage.rhythm.missing, 1);
  assert.equal(combined.diagnostics.waveform.missingWeightRedistributed, false);
  const absent = rankSonicWaveformFit(input([candidate(1)]));
  assert.equal(absent.shortlist[0].fitScore, absent.shortlist[0].similarity);
  assert.equal(absent.shortlist[0].waveform.anchorEvidenceReason, "missing-waveform-evidence");
});

test("missing neutral receipts may outrank measured penalties, and coverage makes that visible", () => {
  const value = measuredInput([candidate(1), candidate(2)]);
  value.candidates[0].waveform = unlike(value.candidates[0].waveform);
  delete value.candidates[1].waveform;
  const result = rankSonicWaveformFit(value);
  assert.equal(result.shortlist[0].rank, 2);
  assert.equal(result.shortlist[0].waveform.audioPenalty, 0);
  assert.equal(result.diagnostics.waveform.shortlistCoverage.rhythm.missing, 1);
  assert.equal(result.diagnostics.waveform.shortlistCoverage.dynamics.missing, 1);
});

test("wrong source, identity, full feature spec, spans and decoding cannot enter scoring", () => {
  const corruptions = [
    wf => { wf.identityKey = "wrong-identity"; }, wf => { wf.sourceSha256 = hash("wrong-source"); },
    wf => { wf.spans = [[30.000003, 60]]; }, wf => { wf.spec.window = "wrong-window"; },
    wf => { delete wf.spec.logCompression; }, wf => { wf.spec.extraParameter = true; },
    wf => { wf.decode.hashVerifiedPrePost = false; }, wf => { wf.decode.complete = false; },
    wf => { wf.decode.samples -= 2; }, wf => { wf.decode.requestedDurationSeconds = 29; },
    wf => { wf.decode.channels = 2; }, wf => { wf.decode.sourceByteLength = 0; },
    wf => { wf.diagnostics.silent = true; }, wf => { wf.reliability.calibrated = true; },
    wf => { wf.reliability.gateVersion = "other-gates"; }, wf => { wf.status = "error"; },
    wf => { wf.sourceType = "remote-stream"; }, wf => { wf.sourceType = "beatport-preview"; }
  ];
  for (const corrupt of corruptions) {
    const value = measuredInput([candidate(1)]); value.candidates[0].waveform = unlike(value.candidates[0].waveform); corrupt(value.candidates[0].waveform);
    const row = rankSonicWaveformFit(value).shortlist[0];
    assert.equal(row.waveform.candidateEvidenceAvailable, false);
    assert.equal(row.waveform.audioPenalty, 0);
  }
});

test("span tolerance is below one sample, and previews retain partial-source diagnostics", () => {
  const value = measuredInput([candidate(1)]), wf = value.candidates[0].waveform;
  wf.spans = [[30.000001, 60.000001]];
  wf.sourceType = "beatport-preview";
  wf.sourceSnapshotKey = `sonic-source-v1-${hash("snapshot")}`;
  const row = rankSonicWaveformFit(value).shortlist[0];
  assert.equal(row.waveform.candidateEvidenceAvailable, true);
  assert.equal(row.waveform.sourceQuality.candidate.sourceType, "beatport-preview");
  assert.equal(row.waveform.sourceQuality.candidate.previewSource, true);
  assert.equal(row.waveform.sourceQuality.candidate.partialSource, true);
});

test("independent numerical family gates reject fabricated reliability flags", () => {
  const corruptions = [
    wf => { wf.descriptors.rhythm.onsetCount = 7; }, wf => { wf.descriptors.rhythm.periodicityPeak = 0.09; },
    wf => { wf.descriptors.rhythm.intervalCv = null; }, wf => { wf.descriptors.rhythm.intervalCv = 1e308; },
    wf => { wf.descriptors.rhythm.onsetRateHz = 99; }, wf => { wf.descriptors.rhythm.phaseProfile = Array(16).fill(1); },
    wf => { wf.descriptors.rhythm.lowPulseStrength = -1; }, wf => { wf.descriptors.rhythm.lowHighOnsetCorrelation = 2; }
  ];
  for (const corrupt of corruptions) {
    const value = measuredInput([candidate(1)]); corrupt(value.candidates[0].waveform);
    const row = rankSonicWaveformFit(value).shortlist[0];
    assert.equal(row.waveform.rhythm.available, false);
    assert.equal(row.waveform.rhythm.penalty, 0);
  }
  const value = measuredInput([candidate(1)]); value.candidates[0].waveform.diagnostics.fullScaleExceedanceFraction = NaN;
  const malformed = rankSonicWaveformFit(value).shortlist[0];
  assert.equal(malformed.waveform.rhythm.available, false);
  assert.equal(malformed.waveform.dynamics.available, false);
  const invalid = measuredInput([candidate(1)]); invalid.candidates[0].waveform.descriptors.dynamics.crestFactorDb = 1e308;
  assert.equal(rankSonicWaveformFit(invalid).shortlist[0].waveform.dynamics.available, false);
});

test("finite float downmix peaks above full scale preserve valid gain-invariant measurements", () => {
  const value = measuredInput([candidate(1)]);
  const reference = rankSonicWaveformFit(value);
  const wf = value.candidates[0].waveform;
  wf.diagnostics.level = { rmsDbfs: -5, peakDbfs: 3 };
  wf.diagnostics.fullScaleExceedanceFraction = 0.5;
  const result = rankSonicWaveformFit(value), row = result.shortlist[0];
  assert.equal(row.waveform.rhythm.available, true);
  assert.equal(row.waveform.dynamics.available, true);
  assert.equal(row.waveform.audioPenalty, 0);
  assert.equal(row.fitScore, reference.shortlist[0].fitScore);
  assert.equal(row.waveform.sourceQuality.candidate.fullScaleExceedanceFraction, 0.5);
  assert.equal(row.waveform.sourceQuality.candidate.fullScaleInterpretation, "floating-point mono may exceed full scale; not clipping proof");
  for (const fraction of [-0.01, 1.01, Infinity]) {
    wf.diagnostics.fullScaleExceedanceFraction = fraction;
    assert.equal(rankSonicWaveformFit(value).shortlist[0].waveform.candidateEvidenceAvailable, false);
  }
});

test("frozen retrieval preserves exact metadata-only members and exclusions without branch regeneration", () => {
  const rows = Array.from({ length: 35 }, (_, i) => candidate(i + 1));
  rows.slice(20).forEach(row => { row.track.genre = "Psy-Trance"; });
  const self = candidate(36, { track: { ...anchor() }, evidence: evidence("anchor") });
  const frozenRetrieval = rankSonicAnchorFit(input([...rows, self]));
  const featuresMap = new Map([[frozenRetrieval.anchor.identityKey, waveform(frozenRetrieval.anchor, frozenRetrieval.anchorEvidence)],
    ...frozenRetrieval.retrievedCandidates.map(row => [row.track.identityKey, waveform(row.track, row.evidence)])]);
  const result = rankSonicWaveformFit({ frozenRetrieval, featuresMap });
  assert.deepEqual(result.retrievedCandidates.map(row => [row.track.identityKey, row.retrieval, row.metadataFitScore]), frozenRetrieval.retrievedCandidates.map(row => [row.track.identityKey, row.retrieval, row.fitScore]));
  assert.deepEqual(result.excluded, frozenRetrieval.excluded);
  assert.equal(result.diagnostics.waveform.retrievedCoverage.rhythm.used, 30);
  assert.equal(result.diagnostics.retrievalFrozen, true);
  const bad = clone(frozenRetrieval); bad.retrievedCandidates[0].fitScore += 0.01;
  assert.throws(() => rankSonicWaveformFit({ frozenRetrieval: bad, featuresMap }));
  assert.throws(() => rankSonicWaveformFit({ frozenRetrieval, featuresMap, candidates: [candidate(1)] }));
  assert.throws(() => rankSonicWaveformFit({ frozenRetrieval, featuresMap, options: { excludeIdentityKeys: ["text:x"] } }));
});

test("labels and prior measured-fit fields cannot affect scoring; inputs stay untouched", () => {
  const value = measuredInput([candidate(1), candidate(2)]), before = JSON.stringify(value);
  freeze(value);
  const baseline = rankSonicWaveformFit(value);
  assert.equal(JSON.stringify(value), before);
  const dirty = clone(value);
  dirty.anchor.reviewDecision = "KEEP";
  for (const row of dirty.candidates) {
    row.reviewDecision = "WRONG_LANE";
    row.track.rating = "KEEP";
    row.track.privatePath = "private/source/file";
    row.waveform.reviewDecision = "KEEP";
    row.fitEvidence = { energy: { value: 0, confidence: 1 }, mood: "dark", metadata: {} };
  }
  const result = rankSonicWaveformFit(dirty);
  assert.deepEqual(result.shortlist.map(row => [row.track.identityKey, row.fitScore]), baseline.shortlist.map(row => [row.track.identityKey, row.fitScore]));
  assert.ok(!JSON.stringify(result).includes("private/source/file"));
  assert.equal(result.queueable, false);
  assert.equal(result.productionApplied, false);
  assert.equal(result.productionPromotionAllowed, false);
  assert.equal(result.diagnostics.measuredSignalPairsUsed, 0);
  assert.equal(result.diagnostics.waveform.reviewLabelsUsed, false);
  assert.ok(Object.isFrozen(result.shortlist[0].waveform.descriptors.candidate.rhythm.descriptors.phaseProfile));
});

test("hard recording/source exclusions precede waveform penalties and recipe parameters cannot be retuned", () => {
  const value = measuredInput([candidate(1, { evidence: evidence("anchor") }), candidate(2)]);
  const result = rankSonicWaveformFit(value);
  assert.equal(result.excluded[0].reason, "exact-self-source");
  assert.deepEqual(result.shortlist.map(row => row.rank), [2]);
  assert.equal(result.diagnostics.unfilled, 2);
  assert.throws(() => rankSonicWaveformFit({ ...value, variant: "chosen-after-labels" }));
  assert.throws(() => rankSonicWaveformFit({ ...value, options: { rawTopK: 100 } }));
  assert.throws(() => rankSonicWaveformFit({ ...value, options: { rhythmWeight: 0.2 } }));
  const mixed = clone(value); mixed.candidates[1].analyzer = "mert-30s";
  assert.throws(() => rankSonicWaveformFit(mixed));
});
