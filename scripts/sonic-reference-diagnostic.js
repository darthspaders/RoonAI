"use strict";

// Four private inference jobs and a read-only replay. Never imported by the app.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process"), { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { SonicAnalysisWorker, wslPath } = require("../src/sonicAnalysisWorker");
const { digest, readDevelopmentSnapshot, createPrivateResultReceipt, readPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const { assertSonicSourceSnapshot, verifySonicCandidateCorpusCoverage } = require("../src/sonicCandidateCorpus");
const { opaqueListeningIdentity, musicalNames } = require("../src/sonicCatalogReview");

const ROOT = path.resolve(__dirname, ".."), KIND = "accepted-reference-rank-diagnostic";
const MODELS = Object.freeze(["mert-fullsong", "mert-30s"]), ADDITIONS = Object.freeze(["tidal:62582289", "tidal:62582288"]);
const FIT = Object.freeze({ rawTopK: 20, branchLimit: 10, finalCount: 3 });
const CODE_FILES = Object.freeze(["scripts/sonic-reference-diagnostic.js", "src/sonicReferenceDiagnostic.js", "src/sonicAnchorFit.js",
  "src/sonicAnchorExperiment.js", "src/sonicCandidateCorpus.js", "src/sonicAnalysisSpec.js", "config/sonic-analyzers.json", "config/sonic-model-code-sha256.json",
  "src/sonicEnsembleEvaluation.js", "src/sonicEmbeddingStore.js", "src/sonicAnalysisPilot.js", "src/sonicAnalysisWorker.js",
  "src/sonicCatalogReview.js", "src/beatportVersionMatch.js", "src/sonicProfileIdentity.js", "src/musicMemoryStore.js",
  "src/sonicEnsemble.js", "src/catalogIdentityNormalization.js", "src/tidalIdentity.js",
  "scripts/sonic-analysis-wsl.sh", "scripts/sonic-analysis-worker.py", "scripts/sonic_analysis_audio.py"]);
const OWNER_FILES = Object.freeze(["data/soundspectrum-hqplayer-feed/owner.json", "data/soundspectrum-audio-feed/demand.json.owner",
  "data/soundspectrum-native/session-aeon.json", "data/soundspectrum-native/session-g-force.json", "data/soundspectrum-native/session-whitecap.json",
  "data/soundspectrum-obs-webrtc/owner.json", "data/soundspectrum-obs-webrtc/owner.lock", "data/soundspectrum-hqplayer-native/owner.json"]);
const TABLES = Object.freeze(["taste_feedback", "sonic_neighbor_feedback", "sonic_anchor_profile", "taste_cluster_profile", "sonic_analysis_control",
  "sonic_analysis_request", "sonic_analysis_link", "sonic_analysis_artifact", "sonic_blind_review_batch", "sonic_review_session",
  "sonic_review_session_item", "sonic_review_session_audit"]);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const moduleApi = () => require("../src/sonicReferenceDiagnostic");

function argumentsFor(argv) {
  const command = argv[0], values = {};
  assert.ok(["init", "analyze", "evaluate"].includes(command), "Use init|analyze|evaluate --output data/<private-diagnostic>.");
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    assert.ok(["--output", "--base", "--review", "--baseline"].includes(flag) && value && !value.startsWith("--") && !values[flag], "Provide distinct named arguments with values.");
    values[flag] = value;
  }
  assert.ok(values["--output"], "A private --output is required.");
  if (command === "init") assert.ok(values["--base"] && values["--review"] && /^report-\d+\.json$/.test(values["--baseline"] || ""), "Init requires explicit --base, --review and --baseline report filename.");
  else assert.ok(!values["--base"] && !values["--review"] && !values["--baseline"], "Analyze/evaluate reuse the sealed plan.");
  return { command, ...values };
}
function privateDirectory(value, root = ROOT) {
  assert.ok(typeof value === "string" && value, "Choose a private directory.");
  const data = fs.realpathSync(path.join(root, "data")), directory = path.resolve(root, value), relative = path.relative(data, directory);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Output must be a child of private data/.");
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = path.relative(data, fs.realpathSync(ancestor));
  assert.ok(!actual.startsWith("..") && !path.isAbsolute(actual), "Private directory resolves outside data/.");
  return directory;
}
function privateFile(directory, relative, mustExist = true) {
  const base = fs.realpathSync(directory), file = path.resolve(directory, relative), inside = path.relative(base, file);
  assert.ok(inside && !inside.startsWith("..") && !path.isAbsolute(inside), "Artifact path escaped its private directory.");
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = path.relative(base, fs.realpathSync(ancestor));
  assert.ok(actual && !actual.startsWith("..") && !path.isAbsolute(actual) || ancestor === directory && !mustExist, "Artifact resolves outside its private directory.");
  if (mustExist) assert.ok(fs.statSync(file).isFile(), "A frozen artifact file is required.");
  return file;
}
function codeReceipt() { return Object.fromEntries(CODE_FILES.map(file => [file, digest(fs.readFileSync(path.join(ROOT, file)))])); }
function artifactReceipt(directory, files) { return Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(privateFile(directory, file)))])); }
function resultName(item, analyzer) { return `${item.source.sourceSha256}-${analysisSpec(analyzer).key}.json`; }
function tableReceipt(db) {
  return Object.fromEntries(TABLES.map(table => {
    const { createHash } = require("node:crypto"), hash = createHash("sha256"); let count = 0;
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) { count++; hash.update(JSON.stringify(row)); }
    return [table, { count, sha256: hash.digest("hex") }];
  }));
}
function readReviews(db, plan) {
  assert.equal(plan.version, 4); assert.equal(plan.kind, "catalog-reference-coverage"); assert.equal(plan.count, 8);
  const stored = db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id=?").get(plan.batchId);
  assert.ok(stored); assert.deepEqual(JSON.parse(stored.private_plan_json), plan, "Frozen review plan changed.");
  return plan.groups.flatMap(group => {
    const rows = db.prepare("SELECT item_index,candidate_identity_key,candidate_json,status,review_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index").all(group.sessionId);
    assert.equal(rows.length, group.candidates.length);
    return rows.map((row, index) => {
      assert.equal(row.item_index, index); assert.equal(row.candidate_identity_key, opaqueListeningIdentity(plan.batchId, group.sessionId, "candidate", index));
      assert.deepEqual(JSON.parse(row.candidate_json), musicalNames(group.candidates[index].track));
      const review = JSON.parse(row.review_json || "null"); assert.equal(row.status, "REVIEWED"); assert.equal(review?.reviewer, "human"); assert.equal(review?.listened, true);
      assert.ok(["KEEP", "WRONG_LANE", "SKIP", "UNSURE"].includes(review.decision));
      return { sessionId: group.sessionId, index, status: row.status, review };
    });
  });
}
function assertAcceptedAdditions(plan, reviews) {
  const interlude = plan.groups.find(group => group.anchor.identityKey === "tidal:91463750");
  assert.ok(interlude, "The declared development anchor is missing.");
  for (const identityKey of ADDITIONS) {
    const index = interlude.candidates.findIndex(candidate => candidate.track.identityKey === identityKey);
    const row = reviews.find(review => review.sessionId === interlude.sessionId && review.index === index);
    assert.ok(index >= 0 && row?.status === "REVIEWED" && row.review?.reviewer === "human" && row.review.listened === true && row.review.decision === "KEEP", "Only the two accepted exact Interlude references may be added.");
  }
}
function withSnapshot(referencePlan, callback) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const before = tableReceipt(db), snapshot = readDevelopmentSnapshot(db), reviews = readReviews(db, referencePlan), result = callback(snapshot, reviews, before);
    assert.deepEqual(tableReceipt(db), before); db.exec("ROLLBACK"); return result;
  } finally { db.close(); }
}
function sourceFile(directory, item) {
  assertSonicSourceSnapshot(item.source, { track: item.track });
  const file = privateFile(directory, `audio/${item.source.sourceSha256}.audio`), bytes = fs.readFileSync(file);
  assertSonicSourceSnapshot(item.source, { track: item.track, audioBytes: bytes }); return file;
}
function receiptsFor(directory, corpus, allowMissingAdditions = false) {
  const receipts = new Map();
  for (const item of corpus.items) {
    sourceFile(directory, item);
    for (const analyzer of MODELS) {
      const relative = `results/${resultName(item, analyzer)}`, file = privateFile(directory, relative, false);
      if (!fs.existsSync(file)) { assert.ok(allowMissingAdditions && ADDITIONS.includes(item.track.identityKey), "A frozen inference receipt is missing."); continue; }
      const receipt = read(file); readPrivateResultReceipt(receipt, analysisSpec(analyzer), item.source); receipts.set(`${item.track.identityKey}|${analyzer}`, receipt);
    }
  }
  return receipts;
}
function validateRuntimeGuard(receipt, { minimumGpuMiB = 6144, expectedProduction } = {}) {
  assert.ok(Array.isArray(receipt.roonStates) && receipt.roonStates.length && receipt.roonStates.every(state => ["paused", "stopped"].includes(state)), "Roon must be paused or stopped.");
  assert.ok(Array.isArray(receipt.lyrionPlaying) && receipt.lyrionPlaying.every(value => value === false), "Lyrion playback must be stopped.");
  assert.ok(receipt.visual?.state === "idle" && receipt.visual.clients === 0, "Visualizer must be idle with no clients.");
  assert.ok(Array.isArray(receipt.markersPresent) && receipt.markersPresent.length === 0 && Array.isArray(receipt.nativeProcesses) && receipt.nativeProcesses.length === 0, "An audio or visualizer owner is active.");
  assert.equal(receipt.metadataActive, false, "Active metadata/visualizer ownership is unresolved.");
  assert.ok(receipt.analysis?.active === 0 && receipt.analysis.remaining === 0, "The main analysis queue must be empty.");
  assert.ok(receipt.production && typeof receipt.production === "object" && !Array.isArray(receipt.production) && Object.keys(receipt.production).length, "Production configuration is unavailable.");
  if (minimumGpuMiB) assert.ok(Number.isFinite(receipt.gpuFreeMiB) && receipt.gpuFreeMiB >= minimumGpuMiB, "At least 6144 MiB of free GPU memory is required.");
  if (expectedProduction) assert.deepEqual(receipt.production, expectedProduction, "Production configuration changed.");
  return true;
}
async function runtimeGuard({ minimumGpuMiB = 6144, expectedProduction } = {}) {
  const routes = ["/api/status", "/api/lyrion/players", "/api/soundspectrum/status", "/api/recommendation-v2/analysis", "/api/recommendation-v2/production-mode"];
  const [roon, lyrion, visual, analysis, production] = await Promise.all(routes.map(async route => {
    const response = await fetch(`http://127.0.0.1:3777${route}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, "A passive runtime guard is unavailable."); return response.json();
  }));
  assert.equal(process.platform, "win32", "This scoped diagnostic requires the configured Windows/WSL runtime.");
  const native = execFileSync("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'Aeon|G.?Force|WhiteCap|obs64|gst-launch|ffmpeg' } | Select-Object Name,ProcessId) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000, encoding: "utf8" }).trim();
  const metadata = path.join(ROOT, "data/soundspectrum-now-playing/now-playing.json");
  const receipt = { at: new Date().toISOString(), roonStates: roon.zones?.map(zone => zone.state), lyrionPlaying: lyrion.players?.map(player => player.playing),
    visual: { state: visual.state, clients: visual.clients }, markersPresent: OWNER_FILES.filter(file => fs.existsSync(path.join(ROOT, file))),
    nativeProcesses: native ? [].concat(JSON.parse(native)) : [], metadataActive: fs.existsSync(metadata) ? read(metadata).active : null,
    analysis: { active: analysis.counts?.active, remaining: analysis.counts?.remaining }, production: production.sonicProduction };
  if (minimumGpuMiB) receipt.gpuFreeMiB = Number(execFileSync("nvidia-smi", ["--id=0", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10000, encoding: "utf8" }).trim());
  validateRuntimeGuard(receipt, { minimumGpuMiB, expectedProduction }); return receipt;
}
function checkSnapshot(snapshot, reviews, plan) {
  assert.equal(digest(JSON.stringify(snapshot.manifest)), plan.originalManifestDigest); assert.equal(digest(JSON.stringify(snapshot.development)), plan.developmentDigest);
  assert.deepEqual(snapshot.heldOut, plan.heldOut); assert.equal(digest(JSON.stringify(reviews)), plan.reviewsDigest, "Human reference reviews changed; use a fresh diagnostic.");
}
function checkPlan(directory) {
  const plan = read(privateFile(directory, "plan.json")), base = privateDirectory(plan.baseDirectory), review = privateDirectory(plan.reviewDirectory);
  assert.equal(plan.version, 1); assert.equal(plan.kind, KIND); assert.deepEqual(plan.recipe, moduleApi().REFERENCE_DIAGNOSTIC_RECIPE);
  assert.deepEqual(plan.models, MODELS.map(analysisSpec)); assert.deepEqual(plan.fitOptions, FIT); assert.deepEqual(plan.additions, ADDITIONS);
  assert.equal(plan.maximumNewRuns, 4); assert.equal(plan.device, "cuda"); assert.equal(plan.minimumGpuMiB, 6144); assert.equal(plan.productionApplied, false); assert.equal(plan.labelsUsedForWeights, false);
  assert.deepEqual(plan.code, codeReceipt(), "Diagnostic code changed after sealing.");
  assert.deepEqual(plan.baseArtifacts, artifactReceipt(base, Object.keys(plan.baseArtifacts))); assert.deepEqual(plan.reviewArtifacts, artifactReceipt(review, Object.keys(plan.reviewArtifacts)));
  assert.equal(digest(fs.readFileSync(path.join(ROOT, "src/sonicAnchorFit.js"))), read(privateFile(base, "fit-spec.json")).codeSha256, "The sealed anchor-fit scorer changed.");
  const baseCorpus = read(privateFile(base, "corpus.json")), referencePlan = read(privateFile(review, "plan.json")), expandedCorpus = read(privateFile(directory, "corpus.json"));
  assert.equal(digest(fs.readFileSync(privateFile(directory, "corpus.json"))), plan.corpusFileSha256); assert.deepEqual(expandedCorpus, moduleApi().buildReferenceDiagnosticCorpus(baseCorpus, referencePlan));
  const receipts = receiptsFor(directory, expandedCorpus, true);
  for (const item of baseCorpus.items) for (const analyzer of MODELS) assert.equal(digest(fs.readFileSync(privateFile(directory, `results/${resultName(item, analyzer)}`))), plan.baseArtifacts[`results/${resultName(item, analyzer)}`], "An old receipt changed.");
  withSnapshot(referencePlan, (snapshot, reviews) => checkSnapshot(snapshot, reviews, plan));
  return { plan, base, review, baseCorpus, referencePlan, expandedCorpus, receipts };
}
async function init(directory, base, review, baselineFile) {
  assert.ok(!fs.existsSync(directory), "Use a fresh output; existing experiments are never replaced."); assert.ok(directory !== base && directory !== review && base !== review);
  const basePlan = read(privateFile(base, "plan.json")), baseCorpus = read(privateFile(base, "corpus.json")), baseline = read(privateFile(base, baselineFile)), referencePlan = read(privateFile(review, "plan.json"));
  assert.deepEqual(basePlan.models, MODELS.map(analysisSpec)); assert.deepEqual(basePlan.fitOptions, FIT); assert.equal(baseCorpus.items.length, 24); assert.equal(baseline.sourcePool.count, 224);
  assert.equal(digest(fs.readFileSync(path.join(ROOT, "src/sonicAnchorFit.js"))), read(privateFile(base, "fit-spec.json")).codeSha256);
  verifySonicCandidateCorpusCoverage(baseCorpus, MODELS.map(analyzer => ({ analyzer, specKey: analysisSpec(analyzer).key, records: [] })));
  const expanded = moduleApi().buildReferenceDiagnosticCorpus(baseCorpus, referencePlan); assert.equal(expanded.items.length, 26); assert.deepEqual(expanded.items.slice(0, 24), baseCorpus.items); assert.deepEqual(expanded.items.slice(24).map(item => item.track.identityKey), ADDITIONS);
  const oldReceipts = receiptsFor(base, baseCorpus), baseFiles = ["plan.json", "corpus.json", "fit-spec.json", baselineFile, ...baseCorpus.items.flatMap(item => MODELS.map(analyzer => `results/${resultName(item, analyzer)}`))]; assert.equal(oldReceipts.size, 48);
  const reviewFiles = ["plan.json", "collection.json", "request.json", "selection-amendment.json", "completed-results.json"];
  const frozen = withSnapshot(referencePlan, (snapshot, reviews, tables) => {
    assert.equal(digest(JSON.stringify(snapshot.manifest)), basePlan.originalManifestDigest); assert.equal(digest(JSON.stringify(snapshot.development)), basePlan.developmentDigest); assert.deepEqual(snapshot.heldOut, basePlan.heldOut);
    assertAcceptedAdditions(referencePlan, reviews);
    return { originalManifestDigest: basePlan.originalManifestDigest, developmentDigest: basePlan.developmentDigest, heldOut: snapshot.heldOut, reviewsDigest: digest(JSON.stringify(reviews)), tables };
  });
  const guard = await runtimeGuard({ minimumGpuMiB: 0 });
  const sources = expanded.items.map(item => {
    if (!ADDITIONS.includes(item.track.identityKey)) return { item, file: sourceFile(base, item) };
    const candidate = referencePlan.groups.flatMap(group => group.candidates).find(c => c.track.identityKey === item.track.identityKey), clip = referencePlan.clips[candidate.clipId];
    const file = privateFile(review, path.relative(review, clip.sourceFile)); assertSonicSourceSnapshot(item.source, { track: item.track, audioBytes: fs.readFileSync(file) }); return { item, file };
  });
  const plan = { version: 1, kind: KIND, createdAt: new Date().toISOString(), experimentId: randomUUID(), baseDirectory: path.relative(ROOT, base), reviewDirectory: path.relative(ROOT, review), baselineFile,
    recipe: moduleApi().REFERENCE_DIAGNOSTIC_RECIPE, models: MODELS.map(analysisSpec), fitOptions: FIT, additions: ADDITIONS, maximumNewRuns: 4, device: "cuda", minimumGpuMiB: 6144,
    baseArtifacts: artifactReceipt(base, baseFiles), reviewArtifacts: artifactReceipt(review, reviewFiles), code: codeReceipt(), ...frozen,
    productionBaseline: guard.production, selectionPolicy: "accepted development references only; no label-dependent scores or weight tuning", productionApplied: false, labelsUsedForWeights: false };
  fs.mkdirSync(directory); for (const name of ["audio", "results", "guards"]) fs.mkdirSync(path.join(directory, name));
  for (const { item, file } of sources) { const destination = privateFile(directory, `audio/${item.source.sourceSha256}.audio`, false); fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL); sourceFile(directory, item); }
  for (const item of baseCorpus.items) for (const analyzer of MODELS) fs.copyFileSync(privateFile(base, `results/${resultName(item, analyzer)}`), privateFile(directory, `results/${resultName(item, analyzer)}`, false), fs.constants.COPYFILE_EXCL);
  save(privateFile(directory, "corpus.json", false), expanded); plan.corpusFileSha256 = digest(fs.readFileSync(privateFile(directory, "corpus.json")));
  save(privateFile(directory, "plan.json", false), plan); save(privateFile(directory, "guards/init.json", false), guard);
  checkPlan(directory); console.log(JSON.stringify({ initialized: true, pool: 226, copiedOldReceipts: 48, newSources: 2, maximumNewRuns: 4, productionApplied: false }));
}
function workerPreflight(directory, items) {
  const prefix = process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  const files = items.map(item => ({ path: wslPath(sourceFile(directory, item)), sha256: item.source.sourceSha256, bytes: item.source.byteLength }));
  const code = "import sys,json,hashlib,pathlib\nitems=json.loads(sys.argv[1])\nassert len(items)==2\nfor item in items:\n p=pathlib.Path(item['path'])\n assert p.is_file() and p.stat().st_size==item['bytes']\n assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256']\nprint(json.dumps({'sources':len(items),'valid':True}))";
  const result = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", `${prefix}/bin/python`, "-c", code, JSON.stringify(files)], { windowsHide: true, timeout: 30000, encoding: "utf8", maxBuffer: 65536 });
  assert.deepEqual(JSON.parse(result), { sources: 2, valid: true });
}
async function releaseWorker(worker, child = worker.child) {
  const pid = child?.linuxPid; worker.stop();
  if (!child) return;
  assert.ok(Number.isSafeInteger(pid), "Owned worker identity is unavailable; stop before further inference.");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "kill", "-0", String(pid)], { windowsHide: true, timeout: 2000, stdio: "pipe" }); }
    catch (error) { if (/No such process/i.test(String(error.stderr || ""))) { await new Promise(resolve => setTimeout(resolve, 250)); return; } throw new Error("Owned worker release could not be confirmed."); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Owned worker is still present; no additional inference was started.");
}
async function analyze(directory) {
  const state = checkPlan(directory), items = state.expandedCorpus.items.filter(item => ADDITIONS.includes(item.track.identityKey)); assert.equal(items.length, 2); workerPreflight(directory, items);
  let completed = 0, cachedResults = 0, newRuns = 0;
  for (const analyzer of MODELS) for (const item of items) {
    const spec = analysisSpec(analyzer), file = privateFile(directory, `results/${resultName(item, analyzer)}`, false);
    if (fs.existsSync(file)) { sourceFile(directory, item); readPrivateResultReceipt(read(file), spec, item.source); completed++; cachedResults++; continue; }
    const guard = await runtimeGuard({ minimumGpuMiB: 6144, expectedProduction: state.plan.productionBaseline });
    save(privateFile(directory, `guards/${analyzer}-${item.source.sourceSha256}-${Date.now()}.json`, false), guard);
    const worker = new SonicAnalysisWorker({ device: "cuda" }); let ownedChild;
    try { const audio = sourceFile(directory, item), pending = worker.run(audio, spec); ownedChild = worker.child; const result = await pending; sourceFile(directory, item); save(file, createPrivateResultReceipt(result, spec, item.source)); completed++; newRuns++; }
    finally { await releaseWorker(worker, ownedChild); }
    console.log(JSON.stringify({ completed, cachedResults, newRuns, total: 4, analyzer, identityKey: item.track.identityKey, ownedWorkerReleased: true, runtimeDatabaseWrites: 0 }));
  }
  const final = checkPlan(directory); assert.equal(receiptsFor(directory, final.expandedCorpus).size, 52);
  save(privateFile(directory, `guards/after-analysis-${Date.now()}.json`, false), await runtimeGuard({ minimumGpuMiB: 0, expectedProduction: state.plan.productionBaseline }));
  console.log(JSON.stringify({ completed, cachedResults, newRuns, total: 4, privateReceipts: 52, productionApplied: false }));
}
function prepareReport(pureReport, provenance) {
  assert.equal(pureReport.kind, KIND); assert.equal(pureReport.productionApplied, false);
  assert.deepEqual(pureReport.recipe, moduleApi().REFERENCE_DIAGNOSTIC_RECIPE);
  const report = { ...pureReport, provenance };
  return { report, markdown: moduleApi().referenceDiagnosticMarkdown(report), summary: { sourcePools: report.recipe.sourcePools, coverage: report.coverage, productionApplied: false, runtimeDatabaseWrites: 0 } };
}
function evaluate(directory) {
  const state = checkPlan(directory), receipts = receiptsFor(directory, state.expandedCorpus); assert.equal(receipts.size, 52);
  const pureReport = withSnapshot(state.referencePlan, (snapshot, reviews) => { checkSnapshot(snapshot, reviews, state.plan); return moduleApi().evaluateReferenceDiagnostic(snapshot, { baseCorpus: state.baseCorpus,
    expandedCorpus: state.expandedCorpus, receipts, referencePlan: state.referencePlan, reviews, baselineReport: read(privateFile(state.base, state.plan.baselineFile)) }); });
  const { report, markdown, summary } = prepareReport(pureReport, { planSha256: digest(fs.readFileSync(privateFile(directory, "plan.json"))), code: state.plan.code, baseArtifacts: state.plan.baseArtifacts, reviewArtifacts: state.plan.reviewArtifacts });
  const stem = `report-${Date.now()}`; save(privateFile(directory, `${stem}.json`, false), report);
  fs.writeFileSync(privateFile(directory, `${stem}.md`, false), markdown, { flag: "wx" });
  console.log(JSON.stringify({ report: `${stem}.json`, ...summary }));
}
async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv), directory = privateDirectory(args["--output"]);
  if (args.command === "init") return init(directory, privateDirectory(args["--base"]), privateDirectory(args["--review"]), args["--baseline"]);
  assert.ok(fs.existsSync(directory), "Initialize the private diagnostic first."); const token = randomUUID(), lock = privateFile(directory, ".diagnostic.lock", false);
  save(lock, { token, pid: process.pid, command: args.command });
  try { if (args.command === "analyze") await analyze(directory); else evaluate(directory); }
  finally { if (read(lock).token === token) fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { argumentsFor, privateDirectory, privateFile, validateRuntimeGuard, codeReceipt, readReviews, assertAcceptedAdditions, prepareReport, checkPlan, main };
