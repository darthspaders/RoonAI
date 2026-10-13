"use strict";

// Private CPU-only follow-up. Does not import the server or write its database.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { digest, readDevelopmentSnapshot, readPrivateResults, evaluateAnchorExperiment } = require("../src/sonicAnchorExperiment");
const { MODELS, protectedState } = require("../src/sonicEnsembleEvaluation");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { wslPath } = require("../src/sonicAnalysisWorker");
const { privateDirectory } = require("./sonic-anchor-experiment");
const { WAVEFORM_FEATURE_SPEC, WAVEFORM_FIT_RECIPE } = require("../src/sonicWaveformFit");
const { buildWaveformInputManifest, readWaveformRecords, evaluateWaveformExperiment, waveformMarkdown } = require("../src/sonicWaveformExperiment");

const ROOT = path.resolve(__dirname, "..");
const MAX_CORPUS_SOURCE_BYTES = 16 * 1024 * 1024 * 1024;
const CODE_FILES = ["scripts/sonic-waveform-features.py", "src/sonicWaveformFit.js", "src/sonicWaveformExperiment.js", "scripts/sonic-waveform-experiment.js"];
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

function argumentsFor(argv) {
  const command = argv[0], values = {};
  assert.ok(["init", "extract", "evaluate"].includes(command), "Use init|extract|evaluate --output data/<fresh-experiment> [--base data/<frozen-base> --baseline report-<timestamp>.json --local-mount /mnt/<private-read-only-mount>].");
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    assert.ok(["--output", "--base", "--baseline", "--local-mount"].includes(flag) && value && !value.startsWith("--") && !values[flag], "Provide distinct named arguments with values.");
    values[flag] = value;
  }
  assert.ok(values["--output"], "A fresh private --output is required.");
  if (command === "init") {
    assert.ok(values["--base"] && /^report-\d+\.json$/.test(values["--baseline"] || ""), "Init requires an explicit frozen --base and --baseline report filename.");
    assert.ok(!values["--local-mount"] || /^\/mnt\/[a-zA-Z0-9_-]+$/.test(values["--local-mount"]), "An optional local source mount must be a direct /mnt/ child.");
  } else assert.ok(!values["--base"] && !values["--baseline"] && !values["--local-mount"], "Extract/evaluate reuse the frozen plan.");
  return { command, ...values };
}
function codeReceipt() {
  return Object.fromEntries(CODE_FILES.map(file => [file, digest(fs.readFileSync(path.join(ROOT, file)))]));
}
function withSnapshot(callback) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const before = protectedState(db), snapshot = readDevelopmentSnapshot(db), result = callback(snapshot, db, before);
    assert.deepEqual(protectedState(db), before); db.exec("ROLLBACK");
    return result;
  } finally { db.close(); }
}
function localSourceDurations(db, snapshot) {
  const values = new Map(), key = analysisSpec(MODELS[0]).key;
  const statement = db.prepare("SELECT a.result_json FROM sonic_analysis_link l JOIN sonic_analysis_artifact a USING(artifact_key) WHERE l.identity_key=? AND l.spec_key=? AND a.spec_key=l.spec_key");
  for (const item of snapshot.manifest.items) {
    const rows = statement.all(item.track.identityKey, key); assert.equal(rows.length, 1, "Ambiguous original source artifact.");
    values.set(item.track.identityKey, JSON.parse(rows[0].result_json).audioDurationSeconds);
  }
  return values;
}
function baseReceipts(directory, baseline) {
  const files = ["plan.json", "corpus.json", "fit-spec.json", baseline];
  const results = path.join(directory, "results");
  assert.ok(fs.existsSync(results));
  for (const file of fs.readdirSync(results).filter(file => file.endsWith(".json")).sort()) files.push(`results/${file}`);
  return Object.fromEntries(files.map(file => {
    const target = path.join(directory, file), relative = path.relative(fs.realpathSync(directory), fs.realpathSync(target));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Frozen base artifact escaped its private directory.");
    return [file, digest(fs.readFileSync(target))];
  }));
}
function checkSnapshot(snapshot, basePlan) {
  assert.equal(digest(JSON.stringify(snapshot.manifest)), basePlan.originalManifestDigest);
  assert.equal(digest(JSON.stringify(snapshot.development)), basePlan.developmentDigest);
  assert.deepEqual(snapshot.heldOut, basePlan.heldOut);
  assert.deepEqual(basePlan.models, MODELS.map(analysisSpec));
  assert.deepEqual(basePlan.fitOptions, { rawTopK: 20, branchLimit: 10, finalCount: 3 });
}
function checkPlan(directory) {
  const plan = readJson(path.join(directory, "plan.json")), base = privateDirectory(plan.baseDirectory);
  assert.deepEqual(plan.recipe, WAVEFORM_FIT_RECIPE, "Waveform recipe changed; use a fresh declared experiment.");
  assert.deepEqual(plan.code, codeReceipt(), "Waveform code changed; use a fresh declared experiment.");
  assert.deepEqual(plan.baseArtifacts, baseReceipts(base, plan.baselineFile), "The frozen prior experiment changed.");
  assert.equal(digest(fs.readFileSync(path.join(ROOT, "src/sonicAnchorFit.js"))), readJson(path.join(base, "fit-spec.json")).codeSha256, "The sealed metadata scorer changed.");
  assert.equal(digest(fs.readFileSync(path.join(directory, "input-manifest.json"))), plan.inputManifestSha256);
  withSnapshot(snapshot => checkSnapshot(snapshot, readJson(path.join(base, "plan.json"))));
  return { plan, base };
}
function pythonRun(args, onProgress = null) {
  const envRoot = process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  const script = path.join(ROOT, "scripts/sonic-waveform-features.py");
  const command = process.platform === "win32" ? "wsl.exe" : `${envRoot}/bin/python`;
  const argv = process.platform === "win32" ? ["-d", "Ubuntu", "--", `${envRoot}/bin/python`, "-u", wslPath(script), ...args] : ["-u", script, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "", count = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Bounded CPU extraction exceeded its 30 minute deadline.")); }, 30 * 60 * 1000);
    createInterface({ input: child.stdout }).on("line", line => {
      if (line.length > 32768) { child.kill(); return; }
      if (onProgress) {
        let value; try { value = JSON.parse(line); } catch { return; }
        if (typeof value.identityKey === "string" && ["ok", "error", "unusable"].includes(value.status)) onProgress({ completed: ++count, status: value.status });
      } else { output += line + "\n"; if (output.length > 32768) child.kill(); }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => { clearTimeout(timer); resolve({ code, output, stderr, completed: count }); });
  });
}
async function passiveRuntime(directory, name) {
  const receipt = { createdAt: new Date().toISOString() };
  for (const endpoint of ["analysis", "production-mode"]) {
    const response = await fetch(`http://127.0.0.1:3777/api/recommendation-v2/${endpoint}`, { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, `Passive runtime ${endpoint} check failed.`); receipt[endpoint] = await response.json();
  }
  save(path.join(directory, name), receipt); return receipt;
}
async function init(directory, base, baselineFile, localMount = null) {
  assert.ok(!fs.existsSync(directory), "Use a fresh private directory; never replace prior work.");
  assert.notEqual(directory, base);
  const basePlan = readJson(path.join(base, "plan.json")), corpus = readJson(path.join(base, "corpus.json")), baseline = readJson(path.join(base, baselineFile));
  assert.equal(baseline.sourcePool.count, 224); assert.equal(baseline.sourcePool.newJointlyEncoded, 24);
  assert.equal(digest(fs.readFileSync(path.join(ROOT, "src/sonicAnchorFit.js"))), readJson(path.join(base, "fit-spec.json")).codeSha256);
  const specification = await pythonRun(["--print-spec"]); assert.equal(specification.code, 0, "Pinned CPU extractor spec check failed.");
  const extractor = JSON.parse(specification.output); assert.deepEqual(extractor.spec, WAVEFORM_FEATURE_SPEC);
  const prepared = withSnapshot((snapshot, db, before) => {
    checkSnapshot(snapshot, basePlan);
    const privateResults = readPrivateResults(base, corpus);
    const manifest = buildWaveformInputManifest(snapshot, { corpus, privateResults, sourceDurations: localSourceDurations(db, snapshot), baseDirectory: base });
    const localDrives = [...new Set(manifest.items.filter(item => item.sourceType === "verified-local-file").map(item => /^([a-z]):[\\/]/i.exec(item.audioPath)?.[1].toLowerCase()))];
    if (localMount) assert.ok(process.platform === "win32" && localDrives.length === 1 && localDrives[0], "An explicit source mount needs one exact Windows source drive.");
    // Paths are private. Preflight all current files before starting the bounded batch.
    let corpusSourceBytes = 0;
    for (const item of manifest.items) {
      const stat = fs.statSync(item.audioPath); assert.ok(stat.isFile() && stat.size > 0 && stat.size <= extractor.bounds.maximumSourceBytes, "A frozen source is unavailable or exceeds the declared byte bound.");
      corpusSourceBytes += stat.size;
      if (process.platform === "win32") {
        item.audioPath = wslPath(item.audioPath);
        if (localMount && item.sourceType === "verified-local-file") item.audioPath = localMount + item.audioPath.slice(`/mnt/${localDrives[0]}`.length);
      }
    }
    assert.ok(corpusSourceBytes <= MAX_CORPUS_SOURCE_BYTES, "The fixed corpus exceeds the declared total source byte bound.");
    return { manifest, before, corpusSourceBytes, localDrives };
  });
  fs.mkdirSync(directory, { recursive: true });
  save(path.join(directory, "input-manifest.json"), prepared.manifest);
  const plan = { version: 1, createdAt: new Date().toISOString(), experimentId: randomUUID(),
    baseDirectory: path.relative(ROOT, base), baselineFile, baseArtifacts: baseReceipts(base, baselineFile),
    inputManifestSha256: digest(fs.readFileSync(path.join(directory, "input-manifest.json"))), sourceCount: prepared.manifest.items.length,
    recipe: WAVEFORM_FIT_RECIPE, extractor, code: codeReceipt(), declaredBeforeMusicExtractionAndLabelReplay: true,
    models: basePlan.models, developmentDigest: basePlan.developmentDigest, heldOut: basePlan.heldOut,
    ioBounds: { maximumCorpusSourceBytes: MAX_CORPUS_SOURCE_BYTES, corpusSourceBytes: prepared.corpusSourceBytes, maximumRuntimeMinutes: 30 },
    sourceAccess: { windowsLocalDrive: prepared.localDrives[0] || null, explicitPrivateLocalMount: localMount, mountCreatedByCli: false },
    productionApplied: false, labelsUsedForWeights: false };
  save(path.join(directory, "plan.json"), plan); save(path.join(directory, "before-protected.json"), prepared.before);
  console.log(JSON.stringify({ initialized: true, sourceCount: plan.sourceCount, variants: Object.keys(plan.recipe.variants), productionApplied: false }));
}
async function extract(directory) {
  const { plan } = checkPlan(directory), output = path.join(directory, "features.ndjson");
  assert.ok(!fs.existsSync(output), "Feature output already exists; evaluate it or initialize a separate declared experiment.");
  const transform = process.platform === "win32" ? wslPath : value => value;
  // Windows drive availability does not establish worker-side availability.
  const checked = await pythonRun(["--preflight", "--manifest", transform(path.join(directory, "input-manifest.json"))]);
  assert.equal(checked.code, 0, "Worker-side source preflight failed before extraction.");
  const preflight = JSON.parse(checked.output); assert.equal(preflight.sourceCount, plan.sourceCount); assert.equal(preflight.valid, true);
  assert.equal(preflight.sourceBytes, plan.ioBounds.corpusSourceBytes);
  save(path.join(directory, "source-preflight.json"), { ...preflight, createdAt: new Date().toISOString(), inputManifestSha256: plan.inputManifestSha256 });
  await passiveRuntime(directory, "before-extraction-runtime.json");
  const envRoot = process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  const result = await pythonRun(["--manifest", transform(path.join(directory, "input-manifest.json")), "--output", transform(output), "--ffmpeg", `${envRoot}/bin/ffmpeg`], progress => {
    if (progress.completed % 8 === 0 || progress.status !== "ok" || progress.completed === plan.sourceCount) console.log(JSON.stringify({ featureProgress: progress.completed, total: plan.sourceCount, status: progress.status, cpuOnly: true }));
  });
  await passiveRuntime(directory, "after-extraction-runtime.json");
  const records = fs.readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const features = readWaveformRecords(records, readJson(path.join(directory, "input-manifest.json")));
  assert.ok([0, 1].includes(result.code), "CPU extraction did not finish all bounded records.");
  save(path.join(directory, "feature-receipt.json"), { createdAt: new Date().toISOString(), inputManifestSha256: plan.inputManifestSha256,
    featureFileSha256: digest(fs.readFileSync(output)), records: features.size, exitCode: result.code, code: plan.code, cpuOnly: true, productionApplied: false });
  console.log(JSON.stringify({ extracted: features.size, errors: records.filter(record => record.status === "error").length, productionApplied: false }));
}
function evaluate(directory) {
  const { plan, base } = checkPlan(directory), featureFile = path.join(directory, "features.ndjson"), featureReceipt = readJson(path.join(directory, "feature-receipt.json"));
  assert.equal(featureReceipt.featureFileSha256, digest(fs.readFileSync(featureFile)), "Feature receipts changed.");
  assert.equal(featureReceipt.inputManifestSha256, plan.inputManifestSha256); assert.deepEqual(featureReceipt.code, plan.code);
  const features = readWaveformRecords(fs.readFileSync(featureFile, "utf8").trim().split("\n").map(line => JSON.parse(line)), readJson(path.join(directory, "input-manifest.json")));
  const corpus = readJson(path.join(base, "corpus.json")), prior = readJson(path.join(base, plan.baselineFile));
  const report = withSnapshot((snapshot, db, protectedReceipt) => {
    const baseline = evaluateAnchorExperiment(snapshot, { corpus, privateResults: readPrivateResults(base, corpus), fitOptions: readJson(path.join(base, "plan.json")).fitOptions });
    assert.deepEqual(baseline.development, prior.development, "Frozen metadata nominations changed.");
    assert.deepEqual(baseline.heldOut, prior.heldOut);
    const value = evaluateWaveformExperiment(baseline, { development: snapshot.development, features });
    value.protectedReceipt = protectedReceipt; return value;
  });
  report.provenance = { planSha256: digest(fs.readFileSync(path.join(directory, "plan.json"))), featureFileSha256: featureReceipt.featureFileSha256,
    baselineSha256: plan.baseArtifacts[plan.baselineFile], inputManifestSha256: plan.inputManifestSha256, code: plan.code };
  const stem = `report-${Date.now()}`; save(path.join(directory, `${stem}.json`), report);
  fs.writeFileSync(path.join(directory, `${stem}.md`), waveformMarkdown(report), { flag: "wx" });
  console.log(JSON.stringify({ report: `${stem}.md`, featureCoverage: report.featureCoverage, aggregate: report.aggregate, productionApplied: false }));
}
async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv), directory = privateDirectory(args["--output"]);
  if (args.command === "init") return init(directory, privateDirectory(args["--base"]), args["--baseline"], args["--local-mount"] || null);
  assert.ok(fs.existsSync(directory), "Initialize the private experiment first.");
  const lock = path.join(directory, ".experiment.lock"), token = randomUUID();
  save(lock, { token, pid: process.pid, command: args.command });
  try { if (args.command === "extract") await extract(directory); else evaluate(directory); }
  finally { if (readJson(lock).token === token) fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { argumentsFor, codeReceipt, localSourceDurations, baseReceipts, checkSnapshot, main };
