"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { rankSonicAnchorFit } = require("../src/sonicAnchorFit");
const { freezeSonicSourceSnapshot, freezeSonicCandidateCorpus, MODELS } = require("../src/sonicCandidateCorpus");
const { WAVEFORM_FEATURE_SPEC, WAVEFORM_FIT_RECIPE } = require("../src/sonicWaveformFit");
const { sameSpans, buildWaveformInputManifest, readWaveformRecords, pairwiseKnownOrder,
  evaluateWaveformExperiment, waveformMarkdown } = require("../src/sonicWaveformExperiment");
const { argumentsFor, codeReceipt, baseReceipts, localSourceDurations, checkSnapshot } = require("../scripts/sonic-waveform-experiment");
const { digest } = require("../src/sonicAnchorExperiment");

const hash = value => createHash("sha256").update(String(value)).digest("hex");
const track = id => ({ identityKey: `tidal:${id}`, tidalId: String(id), artist: `Artist ${id}`, title: `Recording ${id}`,
  durationMs: 360000, isrc: `USAAA2600${String(id).padStart(3, "0")}` });
const evidence = id => ({ sourceSha256: hash(id), spans: [[15, 45]] });

function waveform(item, changes = {}) {
  const seconds = item.spans[0][1] - item.spans[0][0];
  return { version: 1, status: "ok", identityKey: item.identityKey, sourceSha256: item.sourceSha256,
    sourceType: item.sourceType || "verified-local-file", spans: structuredClone(item.spans), spec: structuredClone(WAVEFORM_FEATURE_SPEC),
    ...(item.sourceSnapshotKey ? { sourceSnapshotKey: item.sourceSnapshotKey } : {}),
    decode: { sampleRate: 24000, channels: 1, samples: Math.round(seconds * 24000), durationSeconds: seconds,
      requestedDurationSeconds: seconds, complete: true, hashVerifiedPrePost: true, sourceByteLength: 12345 },
    reliability: { usable: true, rhythmUsable: true, dynamicsUsable: true, calibrated: false, gateVersion: WAVEFORM_FIT_RECIPE.gates.gateVersion, flags: [] },
    diagnostics: { silent: false, fullScaleExceedanceFraction: 0 }, descriptors: {
      rhythm: { onsetCount: 60, onsetRateHz: 2, intervalCv: .1, periodicityPeak: .8,
        phaseProfile: Array(16).fill(1 / 16), lowPulseStrength: .8, highPulseStrength: .8, lowHighOnsetCorrelation: .8 },
      dynamics: { crestFactorDb: 10, rmsRangeDb: 4 }
    }, ...changes };
}

function sourceFixture() {
  const anchor = track(1), candidate = track(100), source = freezeSonicSourceSnapshot({ track: candidate,
    sourceType: "beatport-preview", audioBytes: Buffer.from("one frozen preview"), durationSeconds: 120.032653,
    sourceTrack: { id: "10000", artist: candidate.artist, title: candidate.title, isrc: candidate.isrc, durationMs: candidate.durationMs },
    allowVersionProxy: false });
  const corpus = freezeSonicCandidateCorpus({ anchors: [anchor], candidates: [{ track: candidate, source,
    verification: { provider: "tidal", verified: true, identityKey: candidate.identityKey, canonicalTrack: candidate },
    provenance: { anchorIdentityKey: anchor.identityKey, provider: "tidal", query: "fixture", source: "catalog-search" } }], limit: 1, maxPerAnchor: 1 });
  const local = [track(1), track(2)].map(value => ({ ...value, analysisLocal: { sha256: hash(value.identityKey), file: `C:/private/${value.tidalId}.flac` } }));
  const matrices = new Map(MODELS.map(analyzer => [analyzer, { records: new Map(local.map(value => [value.identityKey,
    { evidence: { sourceSha256: value.analysisLocal.sha256, spans: [[45.016326, 75.01632599999999]] } }])) }]));
  const privateResults = new Map(MODELS.map(analyzer => {
    const spec = analysisSpec(analyzer), vector = Array(spec.dimensions).fill(0); vector[0] = 1;
    return [`${candidate.identityKey}|${analyzer}`, { specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate,
      audioDurationSeconds: source.durationSeconds, analyzedSeconds: 30, sourceCoverage: 30 / source.durationSeconds,
      vector, segments: [{ start: 45.016326, end: 75.01632599999999, vector: [...vector] }] }];
  }));
  return { snapshot: { manifest: { items: local.map(value => ({ track: value })) }, matrices }, corpus, privateResults,
    sourceDurations: new Map(local.map(value => [value.identityKey, 120.032653])), baseDirectory: "C:/private/experiment" };
}

function evaluationFixture() {
  const anchor = { ...track(1), genre: "sampling style" }, held = { ...track(2), genre: "sampling style" };
  const candidates = Array.from({ length: 22 }, (_, i) => ({ track: { ...track(100 + i), ...(i === 20 ? { genre: "sampling style" } : {}) },
    rank: i + 1, similarity: .9 - i * .001, evidence: evidence(100 + i) }));
  const models = value => MODELS.map(analyzer => ({ analyzer, specKey: analysisSpec(analyzer).key,
    fitted: rankSonicAnchorFit({ anchor: value, analyzer, specKey: analysisSpec(analyzer).key, anchorEvidence: evidence(value.tidalId), candidates }) }));
  const pairs = [
    { identityKey: "tidal:100", decision: "KEEP" }, { identityKey: "tidal:101", decision: "WRONG_LANE" },
    { identityKey: "tidal:102", decision: "SKIP" }, { identityKey: "tidal:104", decision: "UNSURE" }
  ];
  const development = [{ anchor, batchId: "fixture-development", pairs }];
  const baseline = { productionApplied: false, sourcePool: { count: 24 }, exposure: { pairs: pairs.length, heldOutAnchors: 1 },
    development: [{ split: "development", anchor, batchId: development[0].batchId, models: models(anchor) }],
    heldOut: [{ split: "held-out-unjudged", anchor: held, batchId: null, models: models(held) }] };
  const features = new Map([anchor, held, ...candidates.map(row => row.track)].map(value => [value.identityKey,
    waveform({ identityKey: value.identityKey, ...evidence(value.tidalId) })]));
  const different = features.get("tidal:100");
  Object.assign(different.descriptors.rhythm, { onsetCount: 270, onsetRateHz: 9, intervalCv: 3,
    phaseProfile: [1, ...Array(15).fill(0)], periodicityPeak: .1, lowPulseStrength: 0, highPulseStrength: 0, lowHighOnsetCorrelation: -1 });
  Object.assign(different.descriptors.dynamics, { crestFactorDb: 40, rmsRangeDb: 80 });
  features.get("tidal:103").status = "unusable";
  return { baseline, development, features };
}

test("waveform input uses the two frozen MERT crops and canonical preview spans without recomputing a center", () => {
  const f = sourceFixture(), before = structuredClone(f);
  const manifest = buildWaveformInputManifest(f.snapshot, { ...f, pathTransform: value => value.replace(/\\/g, "/").replace("C:/", "/mnt/c/") });
  assert.equal(manifest.items.length, 3);
  assert.deepEqual(manifest.items.map(item => item.identityKey), ["tidal:1", "tidal:100", "tidal:2"]);
  assert.deepEqual(manifest.items[0].spans, [[45.016326, 75.01632599999999]]);
  assert.deepEqual(manifest.items[1].spans, f.corpus.items[0].source.spans);
  assert.equal(manifest.items[1].sourceSnapshotKey, f.corpus.items[0].source.snapshotKey);
  assert.match(manifest.items[1].audioPath, /^\/mnt\/c\/private\/experiment[\\/]audio[\\/][a-f0-9]{64}\.audio$/);
  assert.equal(manifest.items[0].sourceType, "verified-local-file");
  assert.equal(manifest.items[1].sourceType, "beatport-preview");
  assert.deepEqual(f, before);
});

test("input freeze fails on missing coverage, changed source evidence or differing model crops", () => {
  for (const mutate of [
    f => f.privateResults.delete(`tidal:100|${MODELS[1]}`),
    f => { f.snapshot.matrices.get(MODELS[1]).records.get("tidal:1").evidence.spans[0][0] += .000001; },
    f => { f.snapshot.manifest.items[0].track.analysisLocal.sha256 = hash("changed bytes"); },
    f => f.sourceDurations.delete("tidal:1"),
    f => { f.privateResults.get(`tidal:100|${MODELS[0]}`).segments[0].start += .000003; }
  ]) {
    const f = sourceFixture(); mutate(f);
    assert.throws(() => buildWaveformInputManifest(f.snapshot, f));
  }
});

test("feature receipts bind identity, source hash/type, full recipe and preview snapshot without source paths", () => {
  const f = sourceFixture(), manifest = buildWaveformInputManifest(f.snapshot, f);
  const records = manifest.items.map(item => waveform(item)), before = structuredClone(records);
  assert.equal(readWaveformRecords(records, manifest).size, 3); assert.deepEqual(records, before);
  for (const mutate of [
    rows => { rows[1].identityKey = "tidal:999"; }, rows => { rows[1].sourceSha256 = hash("swapped"); },
    rows => { rows[1].sourceType = "verified-local-file"; }, rows => { rows[1].sourceSnapshotKey = `sonic-source-v1-${hash("swapped")}`; },
    rows => { rows[1].spans[0][0] += .000003; }, rows => { rows[1].spec.logCompression++; },
    rows => { rows[1].audioPath = "C:/private/source.audio"; }, rows => { rows[1] = structuredClone(rows[0]); }
  ]) { const rows = structuredClone(records); mutate(rows); assert.throws(() => readWaveformRecords(rows, manifest)); }
  assert.throws(() => readWaveformRecords(records.slice(1), manifest), /one completed/);
});

test("microsecond span normalization is bounded separately from decoded PCM sample precision", () => {
  assert.equal(sameSpans([[45.016326, 75.01632599999999]], [[45.016327, 75.016327]]), true);
  assert.equal(sameSpans([[15.000003, 45]], [[15, 45]]), false);
  assert.equal(sameSpans([[15 + 1 / 24000, 45]], [[15, 45]]), false);
  assert.equal(sameSpans([[NaN, 45]], [[15, 45]]), false);
  const f = sourceFixture(), manifest = buildWaveformInputManifest(f.snapshot, f), records = manifest.items.map(item => waveform(item));
  records[1].spans[0][0] -= .000001;
  assert.equal(readWaveformRecords(records, manifest).size, 3);
  assert.equal(records[1].spans[0][0], manifest.items[1].spans[0][0] - .000001, "raw feature receipt remains unchanged");
});

test("failed and unusable measurements retain provenance and are counted as unavailable rather than missing receipts", () => {
  const f = sourceFixture(), manifest = buildWaveformInputManifest(f.snapshot, f), records = manifest.items.map(item => waveform(item));
  records[0] = { ...records[0], status: "error", descriptors: null, decode: null };
  records[1] = { ...records[1], status: "unusable", descriptors: null };
  const result = readWaveformRecords(records, manifest);
  assert.equal(result.get("tidal:1").status, "error"); assert.equal(result.get("tidal:100").status, "unusable");
});

test("pair ordering uses only retrieved known KEEP versus rejected pairs, excluding unknown and UNSURE", () => {
  const candidates = [track(3), track(1), track(2), track(4), track(5)].map(value => ({ track: value }));
  const result = pairwiseKnownOrder(candidates, [
    { identityKey: "tidal:1", decision: "KEEP" }, { identityKey: "tidal:2", decision: "WRONG_LANE" },
    { identityKey: "tidal:3", decision: "SKIP" }, { identityKey: "tidal:4", decision: "UNSURE" },
    { identityKey: "tidal:99", decision: "KEEP" }
  ]);
  assert.equal(result.compared, 2); assert.equal(result.concordant, 1); assert.equal(result.discordant, 1);
  assert.equal(result.reviewedPairs, 5); assert.equal(result.reviewedPairsRetrieved, 4);
});

test("all four waveform ablations retain the sealed retrieval pool and final-three cap with measured penalties", () => {
  const f = evaluationFixture(), before = structuredClone(f), report = evaluateWaveformExperiment(f.baseline, f);
  assert.deepEqual(f, before); assert.equal(report.productionApplied, false);
  const variants = Object.keys(WAVEFORM_FIT_RECIPE.variants);
  for (const model of report.development[0].models) {
    assert.equal(model.retrievedCount, 21, "the same twenty raw plus one eligible metadata branch");
    assert.deepEqual(Object.keys(model.variants), variants);
    for (const result of Object.values(model.variants)) {
      assert.equal(result.shortlist.length, 3); assert.equal(result.knownPairRanks.length, 4);
      assert.equal(result.pairwise.compared, 2);
      assert.equal(result.quality.reviewLabelsUsed, false); assert.equal(result.quality.globalTasteUsed, false);
      assert.equal(result.quality.shortlistCoverage.rhythm.count, 3);
    }
    assert.deepEqual(model.variants["metadata-baseline"].shortlist.map(row => row.track.identityKey), ["tidal:100", "tidal:101", "tidal:102"]);
    assert.ok(model.variants.combined.shortlist.every(row => row.track.identityKey !== "tidal:100"), "matching candidate feature records actually reach scoring");
    assert.equal(model.variants.combined.labels.kept, 0); assert.equal(model.variants.combined.labels.unjudged, 1);
    assert.equal(model.variants.combined.labels.judged, 2); assert.equal(model.variants.combined.labels.keepRateAmongJudged, 0);
    assert.equal(model.variants.combined.quality.shortlistCoverage.rhythm.missing, 1);
    assert.equal(model.variants.combined.quality.shortlistCoverage.rhythm.used, 2);
  }
});

test("saved labels are joined after rankings and can change outcomes without changing any score or selection", () => {
  const f = evaluationFixture(), first = evaluateWaveformExperiment(f.baseline, f);
  f.development[0].pairs.forEach(pair => { pair.decision = "KEEP"; });
  const second = evaluateWaveformExperiment(f.baseline, f);
  const rankings = report => [...report.development, ...report.heldOut].map(group => group.models.map(model => Object.fromEntries(
    Object.entries(model.variants).map(([variant, result]) => [variant, result.shortlist]))));
  assert.deepEqual(rankings(first), rankings(second));
  assert.equal(first.aggregate[0].variants.combined.kept, 0); assert.equal(second.aggregate[0].variants.combined.kept, 2);
  assert.equal(second.aggregate[0].variants.combined.unjudged, 1);
});

test("floating mono full-scale exceedance remains diagnostic and cannot change family availability or scores", () => {
  const f = evaluationFixture(), first = evaluateWaveformExperiment(f.baseline, f);
  for (const record of f.features.values()) {
    record.diagnostics.fullScaleExceedanceFraction = .5;
    record.diagnostics.peakDbfs = 3;
  }
  const second = evaluateWaveformExperiment(f.baseline, f);
  for (let i = 0; i < first.development[0].models.length; i++) for (const variant of Object.keys(WAVEFORM_FIT_RECIPE.variants)) {
    const before = first.development[0].models[i].variants[variant], after = second.development[0].models[i].variants[variant];
    assert.deepEqual(after.shortlist.map(row => [row.track.identityKey, row.fitScore]), before.shortlist.map(row => [row.track.identityKey, row.fitScore]));
    assert.deepEqual(after.quality.shortlistCoverage, before.quality.shortlistCoverage);
    assert.equal(after.shortlist[0].waveform.sourceQuality.candidate.fullScaleExceedanceFraction, .5);
  }
});

test("held-out selections stay wholly unjudged and unknowns never enter acceptance denominators", () => {
  const f = evaluationFixture(), report = evaluateWaveformExperiment(f.baseline, f);
  for (const model of report.heldOut[0].models) for (const result of Object.values(model.variants)) {
    assert.equal(result.labels.kept, 0); assert.equal(result.labels.judged, 0); assert.equal(result.labels.unjudged, 3);
    assert.equal(result.labels.keepRateAmongJudged, null); assert.equal(result.pairwise.compared, 0);
    assert.deepEqual(result.knownPairRanks, []);
    assert.ok(result.additions.every(row => row.decision === "UNJUDGED"));
  }
  const text = waveformMarkdown(report);
  assert.match(text, /partially judged shortlists/); assert.match(text, /do not establish an acceptance rate/);
  assert.match(text, /not independent validation/); assert.match(text, /six reserved anchors remain unjudged/);
});

test("evaluation refuses changed development identity/batch alignment or a promoted baseline", () => {
  for (const mutate of [f => { f.development[0].anchor = { ...f.development[0].anchor, identityKey: "tidal:999" }; },
    f => { f.development[0].batchId = "another-batch"; }, f => { f.baseline.productionApplied = true; }]) {
    const f = evaluationFixture(); mutate(f); assert.throws(() => evaluateWaveformExperiment(f.baseline, f));
  }
});

test("CLI admits only bounded declared stages and a basename for the explicit frozen baseline", () => {
  assert.deepEqual(argumentsFor(["init", "--output", "data/waveform", "--base", "data/frozen", "--baseline", "report-123.json"]),
    { command: "init", "--output": "data/waveform", "--base": "data/frozen", "--baseline": "report-123.json" });
  assert.deepEqual(argumentsFor(["extract", "--output", "data/waveform"]), { command: "extract", "--output": "data/waveform" });
  assert.equal(argumentsFor(["init", "--output", "data/waveform", "--base", "data/frozen", "--baseline", "report-123.json",
    "--local-mount", "/mnt/rabbit-hole-waveform-source"])["--local-mount"], "/mnt/rabbit-hole-waveform-source");
  for (const args of [[], ["prepare", "--output", "data/waveform"], ["init", "--output", "data/waveform"],
    ["extract", "--output"], ["evaluate", "--output", "--base"], ["evaluate", "--output", "data/waveform", "--output", "data/other"],
    ["extract", "--output", "data/waveform", "--base", "data/frozen"],
    ["evaluate", "--output", "data/waveform", "--baseline", "report-1.json"],
    ["init", "--output", "data/waveform", "--base", "data/frozen", "--baseline", "../report-1.json"],
    ["extract", "--output", "data/waveform", "--workers", "100"],
    ["extract", "--output", "data/waveform", "--local-mount", "/mnt/rabbit-hole-waveform-source"]]) assert.throws(() => argumentsFor(args));
  for (const mount of ["/mnt", "/mnt/private/child", "/mnt/../other", "/tmp/private", "Z:/", "https://remote/source", "/mnt/private/"])
    assert.throws(() => argumentsFor(["init", "--output", "data/waveform", "--base", "data/frozen", "--baseline", "report-123.json", "--local-mount", mount]));
  const receipt = codeReceipt();
  assert.deepEqual(Object.keys(receipt), ["scripts/sonic-waveform-features.py", "src/sonicWaveformFit.js",
    "src/sonicWaveformExperiment.js", "scripts/sonic-waveform-experiment.js"]);
  assert.ok(Object.values(receipt).every(value => /^[a-f0-9]{64}$/.test(value)));
});

test("base receipts detect cache changes and reject artifacts escaping the frozen private directory", t => {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, "sonic-waveform-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    assert.match(path.basename(directory), /^sonic-waveform-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = path.join(directory, "base"); fs.mkdirSync(path.join(base, "results"), { recursive: true });
  for (const file of ["plan.json", "corpus.json", "fit-spec.json", "report-123.json", "results/result-a.json", "results/result-b.json"])
    fs.writeFileSync(path.join(base, file), JSON.stringify({ file }));
  const before = baseReceipts(base, "report-123.json");
  assert.equal(Object.keys(before).length, 6);
  fs.writeFileSync(path.join(base, "results/result-a.json"), JSON.stringify({ changed: true }));
  assert.notEqual(baseReceipts(base, "report-123.json")["results/result-a.json"], before["results/result-a.json"]);
  fs.writeFileSync(path.join(directory, "outside.json"), "{}");
  assert.throws(() => baseReceipts(base, "../outside.json"), /escaped/);
  const escaped = path.join(directory, "escaped"), external = path.join(directory, "external");
  fs.mkdirSync(escaped); fs.mkdirSync(external); fs.writeFileSync(path.join(external, "result.json"), "{}");
  for (const file of ["plan.json", "corpus.json", "fit-spec.json", "report-123.json"])
    fs.writeFileSync(path.join(escaped, file), "{}");
  fs.symlinkSync(external, path.join(escaped, "results"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => baseReceipts(escaped, "report-123.json"), /escaped/);
});

test("stored local duration lookup is exact-spec and rejects ambiguous artifacts without decoding audio", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE sonic_analysis_link(identity_key TEXT,spec_key TEXT,artifact_key TEXT); CREATE TABLE sonic_analysis_artifact(artifact_key TEXT,spec_key TEXT,result_json TEXT)");
  const spec = analysisSpec(MODELS[0]), snapshot = { manifest: { items: [{ track: track(1) }] } };
  db.prepare("INSERT INTO sonic_analysis_link VALUES(?,?,?)").run("tidal:1", spec.key, "exact");
  db.prepare("INSERT INTO sonic_analysis_artifact VALUES(?,?,?)").run("exact", spec.key, JSON.stringify({ audioDurationSeconds: 120.032653 }));
  assert.equal(localSourceDurations(db, snapshot).get("tidal:1"), 120.032653);
  db.prepare("INSERT INTO sonic_analysis_link VALUES(?,?,?)").run("tidal:1", spec.key, "other");
  db.prepare("INSERT INTO sonic_analysis_artifact VALUES(?,?,?)").run("other", spec.key, JSON.stringify({ audioDurationSeconds: 120 }));
  assert.throws(() => localSourceDurations(db, snapshot), /Ambiguous/);
});

test("experiment freeze rejects changed labels, held-out anchors, model specs and retrieval settings", () => {
  const snapshot = { manifest: { version: 1, items: [] }, development: [{ pairs: [{ identityKey: "tidal:1", decision: "KEEP" }] }], heldOut: [track(9)] };
  const plan = { originalManifestDigest: digest(JSON.stringify(snapshot.manifest)), developmentDigest: digest(JSON.stringify(snapshot.development)),
    heldOut: structuredClone(snapshot.heldOut), models: MODELS.map(analysisSpec), fitOptions: { rawTopK: 20, branchLimit: 10, finalCount: 3 } };
  checkSnapshot(snapshot, plan);
  for (const mutate of [value => { value.development[0].pairs[0].decision = "WRONG_LANE"; },
    value => { value.heldOut[0].identityKey = "tidal:99"; }, value => { value.manifest.version = 2; }]) {
    const changed = structuredClone(snapshot); mutate(changed); assert.throws(() => checkSnapshot(changed, plan));
  }
  for (const mutate of [value => { value.models[0].revision = "another-model"; }, value => { value.fitOptions.finalCount = 6; }]) {
    const changed = structuredClone(plan); mutate(changed); assert.throws(() => checkSnapshot(snapshot, changed));
  }
});
