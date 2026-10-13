"use strict";

// Private, bounded experiment: freeze sources once, encode separately, replay.
// No server, playback, recommendation control, or runtime database writes.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { SonicAnalysisWorker, wslPath } = require("../src/sonicAnalysisWorker");
const { recordingGroup } = require("../src/sonicAnalysisPilot");
const { publicTrack, MODELS, protectedState } = require("../src/sonicEnsembleEvaluation");
const { digest, readDevelopmentSnapshot, validateStoredResult, createPrivateResultReceipt, readPrivateResultReceipt, evaluateAnchorExperiment, readPrivateResults } = require("../src/sonicAnchorExperiment");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FIT = Object.freeze({ rawTopK: 20, branchLimit: 10, finalCount: 3 });
function argumentsFor(argv) {
  const command = argv[0];
  if (!["init", "prepare", "analyze", "evaluate"].includes(command)) throw new Error("Use init|prepare|analyze|evaluate --output data/<fresh-experiment> [--supply <private-json>].");
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!["--output", "--supply"].includes(flag) || !value || value.startsWith("--") || options[flag]) throw new Error("Provide distinct --output and optional --supply arguments with values.");
    options[flag] = value;
  }
  if (!options["--output"]) throw new Error("A private experiment --output is required.");
  return { command, ...options };
}
function privateDirectory(value) {
  const directory = path.resolve(ROOT, value), data = fs.realpathSync(path.join(ROOT, "data"));
  const relative = path.relative(data, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Experiment output must be a child of private data/.");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor), actual = path.relative(data, real);
  if (actual.startsWith("..") || path.isAbsolute(actual)) throw new Error("Private output resolves outside data/.");
  return directory;
}
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
function childDirectory(directory, name, create = false) {
  const folder = path.join(directory, name);
  if (create) fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(folder)) {
    const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(folder));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Private artifact directory resolves outside this experiment.");
  }
  return folder;
}
function saveJson(file, value, exclusive = true) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) fs.writeFileSync(file, bytes, { flag: "wx" });
  else {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, file);
  }
}
function probeSourceDuration(file, config) {
  const args = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"];
  // MP3 duration estimates differ between builds. Use the analyzer's pinned
  // runtime probe, so the frozen center crop is the crop it actually encodes.
  const output = process.platform === "win32"
    ? execFileSync("wsl.exe", ["-d", "Ubuntu", "--", `${process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2"}/bin/ffprobe`, ...args, wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" })
    : execFileSync(config.localLibrary?.ffprobePath || "ffprobe", [...args, file], { timeout: 30000, encoding: "utf8" });
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) throw new Error("Invalid pinned-runtime source duration.");
  return duration;
}
function withSnapshot(callback) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const before = protectedState(db), snapshot = readDevelopmentSnapshot(db), result = callback(snapshot);
    assert.deepEqual(protectedState(db), before); db.exec("ROLLBACK");
    return result;
  } finally { db.close(); }
}
function checkPlan(snapshot, plan) {
  assert.equal(digest(JSON.stringify(snapshot.manifest)), plan.originalManifestDigest, "The frozen original pool changed.");
  assert.equal(digest(JSON.stringify(snapshot.development)), plan.developmentDigest, "Development reviews changed; initialize a new experiment.");
  assert.deepEqual(snapshot.heldOut, plan.heldOut, "Held-out selection changed.");
  assert.deepEqual(plan.models, MODELS.map(analysisSpec), "Model specifications changed.");
  assert.deepEqual(plan.fitOptions, DEFAULT_FIT, "The declared retrieval recipe changed.");
  assert.equal(plan.corpusLimit, 24); assert.equal(plan.maxPerAnchor, 4);
  assert.deepEqual(plan.catalogAnchors, snapshot.development.filter(group => group.batchId === "blind:9ccce33f-4cde-4760-9828-399d520b9f8a").map(group => group.anchor), "The catalog sampling anchors changed.");
  assert.equal(plan.sourcePolicy, "exact-TIDAL-identity; exact-Beatport-preview; one-frozen-byte-snapshot-for-both-models");
}
async function passiveRuntime(directory, label) {
  const endpoints = ["analysis", "coverage", "production-mode"];
  const rows = await Promise.all(endpoints.map(async endpoint => {
    const response = await fetch(`http://127.0.0.1:3777/api/recommendation-v2/${endpoint}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Runtime ${endpoint} check returned ${response.status}.`);
    return [endpoint, await response.json()];
  }));
  const receipt = { createdAt: new Date().toISOString(), ...Object.fromEntries(rows) };
  saveJson(path.join(directory, `${label}-runtime-${Date.now()}.json`), receipt);
  return receipt;
}
function init(directory) {
  if (fs.existsSync(directory)) throw new Error("Use a fresh experiment directory; existing work is never replaced.");
  const plan = withSnapshot(snapshot => ({ version: 1, createdAt: new Date().toISOString(), experimentId: randomUUID(),
    originalManifestDigest: digest(JSON.stringify(snapshot.manifest)), developmentDigest: digest(JSON.stringify(snapshot.development)),
    models: MODELS.map(analysisSpec), fitOptions: DEFAULT_FIT, corpusLimit: 24, maxPerAnchor: 4,
    development: snapshot.development, heldOut: snapshot.heldOut, exposure: snapshot.exposure,
    originalManifest: snapshot.manifest,
    catalogAnchors: snapshot.development.filter(group => group.batchId === "blind:9ccce33f-4cde-4760-9828-399d520b9f8a").map(group => group.anchor),
    productionApplied: false, sourcePolicy: "exact-TIDAL-identity; exact-Beatport-preview; one-frozen-byte-snapshot-for-both-models",
    labelPolicy: "development-only; labels joined after selection; six previously unexposed held-out anchors" }));
  fs.mkdirSync(directory, { recursive: true });
  saveJson(path.join(directory, "plan.json"), plan);
  console.log(JSON.stringify({ initialized: directory, developmentPairs: plan.exposure.pairs, heldOutAnchors: plan.heldOut.length, catalogLimit: plan.corpusLimit, productionApplied: false }));
}
async function prepare(directory, supplyFile) {
  const { freezeSonicSourceSnapshot, freezeSonicCandidateCorpus } = require("../src/sonicCandidateCorpus");
  const config = require("../src/config");
  const { TidalVerifier } = require("../src/tidalVerifier");
  const { BeatportClient } = require("../src/beatportClient");
  const { matchBeatportVersionToTidal } = require("../src/beatportVersionMatch");
  const { scoreTidalIdentity } = require("../src/exactTrackVerification");
  const plan = readJson(path.join(directory, "plan.json"));
  withSnapshot(snapshot => checkPlan(snapshot, plan));
  if (fs.existsSync(path.join(directory, "corpus.json"))) throw new Error("The frozen corpus already exists; analyze or evaluate it.");
  const tidal = new TidalVerifier({ ...config.tidal, catalogPaginationFile: path.join(directory, "tidal-catalog-pagination.json") });
  const quiet = { log() {}, info() {}, warn() {}, error() {} };
  const beatport = new BeatportClient({ ...config.beatport, logger: quiet });
  if (!tidal.isConfigured() || !beatport.isConfigured()) throw new Error("Configured catalog and preview providers are required.");
  const supply = supplyFile ? readJson(path.resolve(ROOT, supplyFile)) : null;
  const suppliedItems = Array.isArray(supply) ? supply : supply?.items;
  if (supply && !Array.isArray(suppliedItems)) throw new Error("Catalog supply must contain an items array.");
  const progressFile = path.join(directory, "source-preparation.json");
  const progress = fs.existsSync(progressFile) ? readJson(progressFile) : { candidates: [], attempts: [], queries: [] };
  const excludedIds = new Set(plan.originalManifest.items.map(item => item.track.identityKey));
  const excludedGroups = new Set(plan.originalManifest.items.map(item => item.recordingGroup || recordingGroup(item.track)));
  // Preserve the first pass, but allow retry of the corrected provider year=0
  // normalization error. Identity/version rejections remain terminal here.
  if (progress.attempts.some(row => row.reason === "Invalid source year.") && !fs.existsSync(path.join(directory, "source-preparation-initial.json")))
    saveJson(path.join(directory, "source-preparation-initial.json"), progress);
  const attempted = new Set(progress.attempts.filter(row => row.reason !== "Invalid source year.").map(row => `${row.anchorIdentityKey}|${row.identityKey}`));
  const accepted = new Set(progress.candidates.map(candidate => candidate.track.identityKey));
  childDirectory(directory, "audio", true);
  const mark = () => saveJson(progressFile, progress, false);
  for (const anchor of plan.catalogAnchors) {
    let count = progress.candidates.filter(candidate => candidate.provenance.anchorIdentityKey === anchor.identityKey).length;
    const candidates = [];
    if (suppliedItems) candidates.push(...suppliedItems.filter(item => (item.provenance?.anchorIdentityKey || item.sampling?.anchorIdentityKey) === anchor.identityKey));
    else {
      const queries = [...new Set([anchor.artist, ...anchor.artist.split(/\s*\/\s*|,\s*/)].filter(Boolean))].slice(0, 3);
      for (const query of queries) {
        const tracks = await tidal.searchTracks(query, { limit: 12, detailLimit: 0, pageCount: 1, rotateCatalog: false });
        progress.queries.push({ anchorIdentityKey: anchor.identityKey, query, returned: tracks.length });
        candidates.push(...tracks.map(track => ({ track, provenance: { anchorIdentityKey: anchor.identityKey, provider: "tidal", query, source: "catalog-search" } })));
        mark();
      }
    }
    // Bound requests per anchor, including failures. No provider pagination/backfill.
    for (const item of candidates.slice(0, 16)) {
      if (count >= plan.maxPerAnchor) break;
      const supplied = item.track || item, id = String(supplied.tidalId || supplied.id || "");
      if (!/^\d+$/.test(id)) continue;
      const key = `tidal:${id}`, attemptKey = `${anchor.identityKey}|${key}`;
      if (attempted.has(attemptKey) || accepted.has(key) || excludedIds.has(key) || excludedGroups.has(recordingGroup(supplied))) continue;
      attempted.add(attemptKey);
      const record = { anchorIdentityKey: anchor.identityKey, identityKey: key, status: "started" };
      progress.attempts.push(record); mark();
      try {
        const canonical = await tidal.getTrack(id, `${supplied.artist} ${supplied.title}`);
        assert.ok(canonical && scoreTidalIdentity(supplied, canonical).matched, "Current TIDAL identity did not confirm the cached/search candidate.");
        const track = { ...publicTrack(canonical), identityKey: key, tidalId: id };
        if (excludedGroups.has(recordingGroup(track))) { record.status = "original-recording-duplicate"; mark(); continue; }
        const requestedId = item.sourceHint?.sourceTrackId || supplied.beatportTrackId || supplied.metadata?.sourceTrackId || "";
        const sourceTrack = await beatport.findTrack(track, { beatportTrackId: requestedId, allowVersionProxy: false });
        assert.ok(sourceTrack, "No exact Beatport preview source.");
        const match = matchBeatportVersionToTidal(track, sourceTrack, { allowVersionProxy: false, requestedBeatportTrackId: requestedId });
        assert.ok(match.matched && match.relation === "exact", "Preview source is not the exact recording version.");
        const streamed = await beatport.fetchPreviewBuffer(sourceTrack, { maxBytes: 16 * 1024 * 1024 });
        const audio = streamed.buffer, sha = digest(audio), audioFile = path.join(directory, "audio", `${sha}.audio`);
        if (!fs.existsSync(audioFile)) fs.writeFileSync(audioFile, audio, { flag: "wx" });
        assert.equal(digest(fs.readFileSync(audioFile)), sha);
        const durationSeconds = probeSourceDuration(audioFile, config);
        const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: audio, durationSeconds, sourceTrack, allowVersionProxy: false });
        audio.fill(0);
        const genre = typeof sourceTrack.genre === "object" ? sourceTrack.genre.name : sourceTrack.genre;
        const label = typeof sourceTrack.label === "object" ? sourceTrack.label.name : sourceTrack.label;
        const enrichedTrack = { ...track, ...(genre ? { genre } : {}), ...(label ? { label } : {}) };
        progress.candidates.push({ track: enrichedTrack, verification: { provider: "tidal", verified: true, identityKey: key, canonicalTrack: track }, source,
          provenance: { ...item.provenance, anchorIdentityKey: anchor.identityKey, provider: "tidal", query: item.provenance?.query || `${anchor.genre || anchor.artist} (soft sampling)`, source: item.provenance?.source || (suppliedItems ? "exact-catalog-cache" : "catalog-search") } });
        record.status = "frozen-exact-preview"; accepted.add(key); count++;
        console.log(JSON.stringify({ sourceFrozen: key, anchor: anchor.title, progress: progress.candidates.length, limit: plan.corpusLimit }));
      } catch (error) { record.status = "unavailable-or-unverified"; record.reason = String(error.message).slice(0, 300); }
      mark();
    }
  }
  const corpus = freezeSonicCandidateCorpus({ anchors: plan.catalogAnchors, candidates: progress.candidates, limit: plan.corpusLimit,
    maxPerAnchor: plan.maxPerAnchor, excludeIdentityKeys: [...excludedIds],
    excludeRecordingGroups: [...excludedGroups], excludeSourceSha256: plan.originalManifest.items.map(item => item.track.analysisLocal.sha256), createdAt: plan.createdAt });
  if (!corpus.items.length) throw new Error("No exact catalog sources were available; source-preparation.json preserves diagnostics.");
  saveJson(path.join(directory, "corpus.json"), corpus);
  console.log(JSON.stringify({ frozenCatalogTracks: corpus.items.length, requested: plan.corpusLimit, sourceAttempts: progress.attempts.length, productionApplied: false }));
}
async function analyze(directory) {
  const { assertSonicSourceSnapshot, verifySonicCandidateCorpusCoverage } = require("../src/sonicCandidateCorpus");
  const plan = readJson(path.join(directory, "plan.json")), corpus = readJson(path.join(directory, "corpus.json"));
  withSnapshot(snapshot => checkPlan(snapshot, plan));
  verifySonicCandidateCorpusCoverage(corpus, MODELS.map(analyzer => ({ analyzer, specKey: analysisSpec(analyzer).key, records: [] })));
  const worker = new SonicAnalysisWorker();
  childDirectory(directory, "audio"); childDirectory(directory, "results", true);
  let completed = 0;
  try {
    for (const analyzer of MODELS) {
      const spec = analysisSpec(analyzer);
      for (const item of corpus.items) {
        assertSonicSourceSnapshot(item.source, { track: item.track });
        const audioFile = path.join(directory, "audio", `${item.source.sourceSha256}.audio`);
        assertSonicSourceSnapshot(item.source, { track: item.track, audioBytes: fs.readFileSync(audioFile) });
        const file = path.join(directory, "results", `${item.source.sourceSha256}-${spec.key}.json`);
        if (fs.existsSync(file)) { readPrivateResultReceipt(readJson(file), spec, item.source); completed++; continue; }
        const runtime = await passiveRuntime(directory, "analysis-guard");
        if (runtime.analysis.counts.active || runtime.analysis.counts.remaining) throw new Error("The live analysis queue has work; this private experiment will wait without changing it.");
        if (worker.device === "cuda") {
          const free = Number(execFileSync("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10000, encoding: "utf8" }).trim().split(/\r?\n/)[0]);
          if (!Number.isFinite(free) || free < 6144) throw new Error("Insufficient free GPU memory; the private experiment can resume without changing other jobs.");
        }
        const result = await worker.run(audioFile, spec);
        validateStoredResult(result, spec, item.source);
        assertSonicSourceSnapshot(item.source, { track: item.track, audioBytes: fs.readFileSync(audioFile) });
        saveJson(file, createPrivateResultReceipt(result, spec, item.source)); completed++;
        console.log(JSON.stringify({ analyzed: item.track.identityKey, analyzer, completed, total: corpus.items.length * MODELS.length, seconds: result.timings?.totalSeconds }));
      }
      worker.stop();
    }
  } finally { worker.stop(); }
  console.log(JSON.stringify({ completed, total: corpus.items.length * MODELS.length, runtimeDatabaseWrites: 0, productionApplied: false }));
}
function markdown(report) {
  const lines = ["# Anchor candidate experiment", "", `The pool has ${report.sourcePool.count} tracks: ${report.sourcePool.originalLocal} local originals and ${report.sourcePool.newJointlyEncoded} exact catalog previews encoded by both models.`, "",
    "This is a development replay. Unknown picks remain unjudged. Keep rates among partially judged shortlists cannot establish improvement.", "",
    "| Anchor | Model | Raw top-three: Keep / judged / unknown | Fit top-three: Keep / judged / unknown |", "|---|---|---:|---:|"];
  for (const group of report.development) for (const model of group.models) lines.push(`| ${group.anchor.artist} — ${group.anchor.title} | ${model.analyzer} | ${model.baselineLabels.kept} / ${model.baselineLabels.judged} / ${model.baselineLabels.unjudged} | ${model.fitLabels.kept} / ${model.fitLabels.judged} / ${model.fitLabels.unjudged} |`);
  lines.push("", "The internal retrieval window is twenty raw neighbors plus up to ten soft metadata candidates. Final output remains three per model. No development label enters retrieval or scoring.", "",
    "Audio rhythm, BPM, energy and mood fit are neutral in this first pass: existing emotion/SheetSage estimates do not supply calibrated confidence for those comparisons. The interface accepts measured, versioned, source-matched evidence when available.", "",
    "Six previously unexposed anchor recording groups were frozen before replay. They have no new human judgments; fresh blind listening is required.", "", ...report.limitations.map(item => `- ${item}`), "",
    "No production integration or runtime database writes. Exact sources, hashes, model specs, spans and retrieval reasons are preserved in the private JSON artifacts.", "");
  return lines.join("\n");
}
function evaluate(directory) {
  const { assertSonicSourceSnapshot, verifySonicCandidateCorpusCoverage } = require("../src/sonicCandidateCorpus");
  const plan = readJson(path.join(directory, "plan.json"));
  const corpusFile = path.join(directory, "corpus.json"), corpus = fs.existsSync(corpusFile) ? readJson(corpusFile) : null;
  if (corpus) {
    verifySonicCandidateCorpusCoverage(corpus, MODELS.map(analyzer => ({ analyzer, specKey: analysisSpec(analyzer).key, records: [] })));
    childDirectory(directory, "audio"); childDirectory(directory, "results");
    for (const item of corpus.items) {
      assertSonicSourceSnapshot(item.source, { track: item.track });
      assertSonicSourceSnapshot(item.source, { track: item.track, audioBytes: fs.readFileSync(path.join(directory, "audio", `${item.source.sourceSha256}.audio`)) });
    }
  }
  const fitReceiptFile = path.join(directory, "fit-spec.json"), fitCodeSha256 = digest(fs.readFileSync(path.join(ROOT, "src/sonicAnchorFit.js")));
  if (fs.existsSync(fitReceiptFile)) assert.equal(readJson(fitReceiptFile).codeSha256, fitCodeSha256, "Anchor-fit code changed; use a separate declared experiment.");
  else saveJson(fitReceiptFile, { codeSha256: fitCodeSha256, options: plan.fitOptions, declaredBeforeFirstReplay: true, createdAt: new Date().toISOString() });
  const results = corpus ? readPrivateResults(directory, corpus) : new Map();
  const report = withSnapshot(snapshot => {
    checkPlan(snapshot, plan);
    return evaluateAnchorExperiment(snapshot, { corpus, privateResults: results, fitOptions: plan.fitOptions });
  });
  report.fitRecipe = readJson(fitReceiptFile);
  const stem = `report-${Date.now()}`;
  saveJson(path.join(directory, `${stem}.json`), report); fs.writeFileSync(path.join(directory, `${stem}.md`), markdown(report), { flag: "wx" });
  console.log(JSON.stringify({ report: path.join(directory, `${stem}.md`), pool: report.sourcePool, coverage: report.coverage,
    developmentPairs: report.exposure.pairs, heldOutAnchors: report.heldOut.length, productionApplied: false }));
}
async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv), directory = privateDirectory(args["--output"]);
  if (args.command === "init") return init(directory);
  if (!fs.existsSync(directory)) throw new Error("Initialize this private experiment first.");
  const lock = path.join(directory, ".experiment.lock"), token = randomUUID();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token, command: args.command }), { flag: "wx" });
  try {
    if (args.command === "prepare") await prepare(directory, args["--supply"]);
    else if (args.command === "analyze") await analyze(directory);
    else evaluate(directory);
  } finally { if (readJson(lock).token === token) fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { argumentsFor, privateDirectory, probeSourceDuration, markdown, main };
