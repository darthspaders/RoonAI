"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { recordingGroup } = require("../src/sonicAnalysisPilot");
const { rankSonicAnchorFit, MAX_FIT_ADJUSTMENT } = require("../src/sonicAnchorFit");

const analyzer = "mert-fullsong", specKey = analysisSpec(analyzer).key;
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const evidence = value => ({ sourceSha256: hash(value), spans: [[30, 60]] });
const anchor = () => ({ identityKey: "text:anchor", artist: "Anchor artist", title: "Anchor (Original Mix)", mixVersion: "Original Mix", genre: "Psy-Trance", label: "Anchor label" });
function candidate(rank, changes = {}) {
  const row = { track: { identityKey: `text:candidate-${rank}`, artist: `Artist ${rank}`, title: `Track ${rank} (Original Mix)`, mixVersion: "Original Mix", genre: "Techno", label: "Other label" }, rank, similarity: 0.9 - rank * 0.0002, evidence: evidence(`candidate-${rank}`), analyzer, specKey };
  return { ...row, ...changes, track: { ...row.track, ...changes.track } };
}
function input(candidates, changes = {}) {
  return { anchor: anchor(), analyzer, specKey, anchorEvidence: evidence("anchor"), candidates, ...changes };
}
function signal(track, source, value, unit, changes = {}) {
  return { value, unit, confidence: 1, provenance: { source: "audio-analysis", method: "fixture-measurement", version: "fixture-v1", identityKey: track.identityKey, sourceSha256: source.sourceSha256, spans: source.spans.map(span => [...span]) }, ...changes };
}
function allSignals(track, source, changes = {}) {
  return { tempo: signal(track, source, 130, "bpm"), rhythm: signal(track, source, "four-on-the-floor", "class-label"), energy: signal(track, source, 0.7, "normalized-0-1"), mood: signal(track, source, { bright: 0.8, dark: 0.2 }, "probability-distribution"), ...changes };
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("a bounded metadata branch can retrieve a close candidate outside the raw top twenty", () => {
  const rows = Array.from({ length: 32 }, (_, i) => candidate(i + 1));
  rows[20].track.genre = "Psy-Trance";
  const result = rankSonicAnchorFit(input(rows));
  const moved = result.shortlist[0];
  assert.equal(moved.rank, 21);
  assert.equal(moved.similarity, rows[20].similarity);
  assert.equal(moved.rawSimilarity, rows[20].similarity);
  assert.equal(moved.fitAdjustment, 0.0075);
  assert.deepEqual(moved.retrieval, { rawTopK: false, metadataBranch: true, reasons: ["sampling-style-match"] });
  assert.equal(result.diagnostics.rawRetrievedCount, 20);
  assert.equal(result.diagnostics.branchRetrievedCount, 1);
  assert.equal(result.retrievedCandidates.length, 21);
  assert.equal(result.shortlist.length, 3);
});

test("the style branch is capped at ten and deterministic under input permutation", () => {
  const rows = Array.from({ length: 40 }, (_, i) => candidate(i + 1));
  rows.slice(20).forEach(row => { row.track.genre = "Psy-Trance"; });
  const forward = rankSonicAnchorFit(input(rows));
  const reversed = rankSonicAnchorFit(input([...rows].reverse()));
  assert.equal(forward.diagnostics.branchRetrievedCount, 10);
  assert.equal(forward.retrievedCandidates.length, 30);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.retrievedCandidates.filter(row => row.retrieval.metadataBranch).map(row => row.rank), Array.from({ length: 10 }, (_, i) => i + 21));
});

test("sampling genre is soft, and a weak same-style candidate cannot displace a strong cross-genre fit", () => {
  const rows = [candidate(1, { similarity: 0.9, track: { genre: "Pop" } }), candidate(2, { similarity: 0.8 }), candidate(3, { similarity: 0.7 }), candidate(4, { similarity: 0.1, track: { genre: "Psy-Trance" } })];
  const result = rankSonicAnchorFit(input(rows, { options: { rawTopK: 3 } }));
  assert.equal(result.shortlist[0].track.genre, "Pop");
  assert.equal(result.shortlist[0].fitAdjustment, 0);
  assert.equal(result.excluded.length, 0);
  assert.ok(result.retrievedCandidates.some(row => row.rank === 4));
  assert.deepEqual(result.shortlist.map(row => row.rank), [1, 2, 3]);
});

test("catalogue BPM, mood and energy tags never become measured features", () => {
  const a = { ...anchor(), bpm: 130, energy: 0.8, mood: "dark", rhythm: "four-on-the-floor" };
  const row = candidate(1, { track: { bpm: 130, energy: 0.8, mood: "dark", rhythm: "four-on-the-floor" }, fitEvidence: { bpm: 130, energy: { value: 0.8 }, mood: { value: "dark" } } });
  const result = rankSonicAnchorFit(input([row], { anchor: a }));
  assert.equal(result.shortlist[0].fitAdjustment, 0);
  assert.equal(result.diagnostics.measuredSignalPairsUsed, 0);
  assert.ok(Object.values(result.shortlist[0].fit.signals).every(value => !value.available && value.adjustment === 0));
  assert.equal(result.diagnostics.anchorSignals.tempo.available, false);
});

test("matching measured spaces can contribute, with the combined adjustment capped at .05", () => {
  const a = anchor(), source = evidence("anchor");
  const row = candidate(1, { track: { artist: a.artist, genre: a.genre, label: a.label } });
  row.fitEvidence = allSignals(row.track, row.evidence);
  const result = rankSonicAnchorFit(input([row], { anchor: a, anchorEvidence: source, anchorFitEvidence: allSignals(a, source) }));
  assert.equal(result.shortlist[0].fitAdjustment, MAX_FIT_ADJUSTMENT);
  assert.equal(result.diagnostics.measuredSignalPairsUsed, 4);
  assert.equal(result.shortlist[0].fit.metadataAdjustment, 0.013);
  assert.equal(result.shortlist[0].fit.signals.tempo.compatibility, 1);
  assert.equal(result.diagnostics.confidenceCalibrated, false);
});

test("measured feature mismatches and unavailable confidence are neutral, not zero-valued measurements", () => {
  const a = anchor(), source = evidence("anchor"), rows = Array.from({ length: 5 }, (_, i) => candidate(i + 1));
  rows.forEach(row => { row.fitEvidence = { energy: signal(row.track, row.evidence, 0.8, "normalized-0-1") }; });
  rows[0].fitEvidence.energy.confidence = null;
  rows[1].fitEvidence.energy.confidence = 0.69;
  rows[2].fitEvidence.energy.provenance.sourceSha256 = hash("wrong source");
  rows[3].fitEvidence.energy.provenance.spans = [[35, 65]];
  rows[4].fitEvidence.energy.provenance.version = "different-feature-space";
  const result = rankSonicAnchorFit(input(rows, { anchorFitEvidence: { energy: signal(a, source, 0.8, "normalized-0-1") } }));
  assert.equal(result.diagnostics.measuredSignalPairsUsed, 0);
  assert.ok(result.retrievedCandidates.every(row => row.fitAdjustment === 0));
  assert.equal(result.retrievedCandidates[4].fit.signals.energy.reason, "feature-spaces-do-not-match");
});

test("mismatching actual features can lower fit conservatively while preserving raw cosine", () => {
  const a = anchor(), source = evidence("anchor"), row = candidate(1);
  const anchorFitEvidence = { tempo: signal(a, source, 100, "bpm"), energy: signal(a, source, 1, "normalized-0-1"), rhythm: signal(a, source, "broken beat", "class-label"), mood: signal(a, source, { bright: 1, dark: 0 }, "probability-distribution") };
  row.fitEvidence = { tempo: signal(row.track, row.evidence, 200, "bpm"), energy: signal(row.track, row.evidence, 0, "normalized-0-1"), rhythm: signal(row.track, row.evidence, "four on the floor", "class-label"), mood: signal(row.track, row.evidence, { bright: 0, dark: 1 }, "probability-distribution") };
  const picked = rankSonicAnchorFit(input([row], { anchorFitEvidence })).shortlist[0];
  assert.ok(picked.fitAdjustment < 0 && picked.fitAdjustment >= -MAX_FIT_ADJUSTMENT);
  assert.equal(picked.similarity, row.similarity);
  assert.equal(picked.fit.signals.tempo.compatibility, 0);
  assert.equal(picked.fitScore, row.similarity + picked.fitAdjustment);
});

test("self, source and recording aliases cannot be rescued by fit or explicit metadata matches", () => {
  const a = anchor(), source = evidence("anchor");
  const rows = [
    candidate(1, { track: { identityKey: a.identityKey } }),
    candidate(2, { evidence: source }),
    candidate(3, { track: { ...a, identityKey: "tidal:anchor-alias" } }),
    candidate(4), candidate(5), candidate(6), candidate(7)
  ];
  rows[4].evidence = rows[3].evidence;
  rows[5].track = { ...rows[3].track, identityKey: "text:recording-alias" };
  const result = rankSonicAnchorFit(input(rows));
  assert.deepEqual(result.excluded.map(row => row.reason), ["exact-self-identity", "exact-self-source", "exact-self-recording", "duplicate-candidate-source", "duplicate-candidate-recording"]);
  assert.deepEqual(result.shortlist.map(row => row.rank), [4, 7]);
  assert.equal(result.diagnostics.unfilled, 1);
});

test("explicit identity, source and versioned recording exclusions are independent", () => {
  const rows = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const result = rankSonicAnchorFit(input(rows, { options: { excludeIdentityKeys: [rows[0].track.identityKey], excludeSourceSha256: [rows[1].evidence.sourceSha256.toUpperCase()], excludeRecordingGroups: [recordingGroup(rows[2].track)] } }));
  assert.deepEqual(result.excluded.map(row => row.reason), ["explicit-identity-exclusion", "explicit-source-exclusion", "explicit-recording-exclusion"]);
  assert.deepEqual(result.shortlist.map(row => row.rank), [4]);
});

test("named remix versions retain separate exact identities and sources", () => {
  const rows = [candidate(1, { track: { artist: "One artist", title: "A title (Original Mix)", mixVersion: "Original Mix" } }), candidate(2, { track: { artist: "One artist", title: "A title (Named Remix)", mixVersion: "Named Remix" } })];
  const result = rankSonicAnchorFit(input(rows));
  assert.equal(result.excluded.length, 0);
  assert.deepEqual(result.shortlist.map(row => row.track.mixVersion), ["Original Mix", "Named Remix"]);
  assert.notEqual(result.shortlist[0].evidence.sourceSha256, result.shortlist[1].evidence.sourceSha256);
});

test("metadata availability masks related-version fields without imposing a genre veto", () => {
  const rows = Array.from({ length: 22 }, (_, i) => candidate(i + 1));
  rows[20].track.genre = "Psy-Trance";
  rows[20].fitEvidence = { metadata: { styleAvailable: false } };
  rows[21].track.genre = "Psy-Trance";
  const result = rankSonicAnchorFit(input(rows));
  assert.equal(result.diagnostics.branchRetrievedCount, 1);
  assert.ok(!result.retrievedCandidates.some(row => row.rank === 21));
  assert.ok(result.retrievedCandidates.some(row => row.rank === 22));
  const noAnchorStyle = rankSonicAnchorFit(input(rows, { anchorFitEvidence: { metadata: { styleAvailable: false } } }));
  assert.equal(noAnchorStyle.diagnostics.branchRetrievedCount, 0);
});

test("review labels and private arbitrary fields do not influence fit; input is immutable and output frozen", () => {
  const rows = [candidate(1), candidate(2), candidate(3)];
  const original = input(rows), before = JSON.stringify(original);
  freeze(original);
  const baseline = rankSonicAnchorFit(original);
  assert.equal(JSON.stringify(original), before);
  const dirty = input(rows.map((row, i) => ({ ...row, rating: i ? "KEEP" : "WRONG_LANE", judgment: "WRONG_LANE", similarityAdjustment: 99, fitEvidence: { reviewDecision: "KEEP", mood: "dark" }, track: { ...row.track, reviewDecision: "KEEP", privatePath: "private/path", vectors: [1, 2], tasteScore: 100 } })), { anchor: { ...anchor(), reviewDecision: "KEEP", privatePath: "private/anchor", vectors: [1, 2] } });
  const result = rankSonicAnchorFit(dirty);
  assert.deepEqual(result.shortlist.map(row => [row.track.identityKey, row.fitScore]), baseline.shortlist.map(row => [row.track.identityKey, row.fitScore]));
  assert.ok(!JSON.stringify(result).includes("private/path"));
  assert.ok(!JSON.stringify(result).includes("private/anchor"));
  assert.equal(result.diagnostics.reviewLabelsUsed, false);
  assert.equal(result.diagnostics.globalTasteUsed, false);
  assert.equal(result.queueable, false);
  assert.equal(result.productionPromotionAllowed, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.shortlist) && Object.isFrozen(result.shortlist[0].evidence.spans[0]));
  assert.throws(() => { result.shortlist[0].track.title = "changed"; }, TypeError);
});

test("one model and exact spec/source/rank ordering are required", () => {
  const valid = () => input([candidate(1), candidate(2)]);
  const malformed = [
    () => { const x = valid(); x.specKey = "other-spec"; return x; },
    () => { const x = valid(); x.candidates[0].analyzer = "mert-30s"; return x; },
    () => { const x = valid(); x.candidates[0].specKey = analysisSpec("mert-30s").key; return x; },
    () => { const x = valid(); x.candidates[1].rank = 1; return x; },
    () => { const x = valid(); x.candidates[1].track.identityKey = x.candidates[0].track.identityKey; return x; },
    () => { const x = valid(); x.candidates[1].similarity = 1; return x; },
    () => { const x = valid(); x.candidates[0].similarity = NaN; return x; },
    () => { const x = valid(); x.candidates[0].evidence.spans = [[30, 300]]; return x; },
    () => { const x = valid(); x.anchorEvidence.sourceSha256 = "not-a-source"; return x; },
    () => { const x = valid(); x.options = { finalCount: 4 }; return x; },
    () => { const x = valid(); x.options = { branchLimit: 11 }; return x; },
    () => { const x = valid(); x.options = { reviewLabels: {} }; return x; }
  ];
  for (const make of malformed) assert.throws(() => rankSonicAnchorFit(make()));
  const short = rankSonicAnchorFit(input([candidate(1)], { analyzer: "mert-30s", specKey: analysisSpec("mert-30s").key, candidates: [candidate(1, { analyzer: "mert-30s", specKey: analysisSpec("mert-30s").key })] }));
  assert.equal(short.analyzer, "mert-30s");
  assert.equal(short.diagnostics.crossModelVectorsMixed, false);
});

test("without usable fit the raw baseline is preserved and missing slots are explicit", () => {
  const rows = [candidate(1, { similarity: 0.5 }), candidate(2, { similarity: 0.5 }), candidate(3, { similarity: -0.5 })];
  const result = rankSonicAnchorFit(input(rows.reverse()));
  assert.deepEqual(result.shortlist.map(row => row.rank), [1, 2, 3]);
  for (const picked of result.shortlist) {
    assert.equal(picked.fitScore, picked.similarity);
    assert.equal(picked.specKey, specKey);
    assert.deepEqual(picked.evidence, rows.find(row => row.rank === picked.rank).evidence);
  }
  const empty = rankSonicAnchorFit(input([]));
  assert.equal(empty.shortlist.length, 0);
  assert.equal(empty.diagnostics.unfilled, 3);
});
