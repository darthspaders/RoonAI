"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.resolve(__dirname, "..");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
const { publicTrack } = require("../src/sonicEnsembleEvaluation");
const { freezeSonicSourceSnapshot, assertSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { SonicAnalysisWorker, wslPath } = require("../src/sonicAnalysisWorker");
const { createPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const MODELS = ["mert-fullsong", "mert-30s"];
const sha = value => createHash("sha256").update(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const update = (file, value) => { const temporary = file + "." + randomUUID() + ".tmp"; save(temporary, value); fs.renameSync(temporary, file); };
function directoryFor(value) {
  assert.ok(typeof value === "string" && /^data[\\/]sonic-catalog-scout-[a-z0-9-]+$/.test(value));
  const data = fs.realpathSync(path.join(ROOT, "data")), directory = path.resolve(ROOT, value);
  const relative = path.relative(data, directory); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  let ancestor = directory; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert.ok(!path.relative(data, fs.realpathSync(ancestor)).startsWith("..")); return directory;
}
function withDb(callback, writable = false) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: !writable });
  db.exec("PRAGMA busy_timeout=5000");
  if (!writable) db.exec("PRAGMA query_only=ON; BEGIN");
  try { return callback(db); } finally { if (!writable) db.exec("ROLLBACK"); db.close(); }
}
function init(directory) {
  assert.ok(!fs.existsSync(directory), "Use a fresh private pilot directory.");
  const priorPlans = withDb(db => db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch").all().map(row => JSON.parse(row.private_plan_json)));
  const excluded = priorPlans.flatMap(plan => plan.groups.flatMap(group => [group.anchor, ...group.candidates.map(candidate => candidate.track)]));
  const history = new (require("../src/discoveryHistory").DiscoveryHistory)();
  fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, "audio")); fs.mkdirSync(path.join(directory, "guards"));
  save(path.join(directory, "request.json"), { version: 1, createdAt: new Date().toISOString(),
    recipe: { kind: "catalog-scout-end-to-end", finalCount: 3, scoutCount: 6, agreementWeight: 0, maxCandidatesPerRequest: 12,
      maxSources: 100, maxAnchorAttempts: 4, maxCandidateAttempts: 18, maxQueriesPerRequest: 3,
      maxResultsPerQuery: 18, maxTidalQueriesPerSource: 3, maxTidalResultsPerQuery: 12,
      candidateProviderPolicy: "fixed Beatport artist pages resolved to exact canonical TIDAL recordings", scoringYear: new Date().getFullYear(),
      models: MODELS.map(analysisSpec), sourcePolicy: "one exact catalogue preview snapshot shared by both models", productionApplied: false },
    requests: [
      { requestId: "bass-house", anchorQuery: "Valentino Khan", queries: ["Valentino Khan", "Malaa", "Noizu"], lane: "Bass House" },
      { requestId: "melodic-house", anchorQuery: "anamē", queries: ["anamē", "Tinlicker", "Yotto"], lane: "Melodic House & Techno" },
      { requestId: "hypnotic-techno", anchorQuery: "Pablo G. Perspective", preferredAnchorTidalId: "175125760", queries: ["Pablo G.", "Oscar Mulero", "DVS1"], lane: "Techno" },
      { requestId: "psy-trance", anchorQuery: "Ace Ventura", queries: ["Ace Ventura", "Liquid Soul", "Astrix"], lane: "Psy-Trance" }
    ],
    excluded: excluded.map(track => ({ identityKey: track.identityKey, isrc: track.isrc || "", artist: track.artist, title: track.title, ...(track.mixVersion ? { mixVersion: track.mixVersion } : {}) })),
    excludedSourceSha256: [...new Set(priorPlans.flatMap(plan => Object.values(plan.clips).map(clip => clip.sourceSha256)))],
    tasteSnapshot: new (require("../src/tasteProfile").TasteProfile)().read(),
    historySnapshot: { entries: history.uniqueEntries(), settings: Object.fromEntries(["recentWindowMs", "artistRecentWindowMs", "labelRecentWindowMs", "sourceRecentWindowMs"].map(key => [key, history[key]])) },
    selectionPolicy: "fixed Beatport family pages; numeric BP identity order; first unexposed exact TIDAL preview anchor; round-robin artist pages for candidates; no labels or model ranks used",
    heldOutValidation: false, labelsUsedForSelection: false, productionApplied: false });
  console.log(JSON.stringify({ initialized: true, requests: 4, candidateCap: 48, sourceCap: 100 }));
}
function probe(file) {
  const runtime = "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  const seconds = Number(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", runtime + "/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" }).trim());
  assert.ok(Number.isFinite(seconds) && seconds >= 30 && seconds <= 7200); return seconds;
}
function extend(directory, base) {
  assert.ok(directory !== base && !fs.existsSync(directory));
  assert.ok(!fs.existsSync(path.join(base, "plan.json")) && !fs.existsSync(path.join(base, "inference-attempts.json")), "Only uninferred collection attempts can be extended.");
  const requestFile = path.join(base, "request.json"), progressFile = path.join(base, "collection.json"), request = read(requestFile), progress = read(progressFile);
  assert.equal(progress.requestSha256, sha(fs.readFileSync(requestFile)));
  request.recipe.maxAnchorAttempts = 18; request.recipe.maxCandidateAttempts = 36;
  request.collectionExtension = { reason: "exact catalog source coverage before any model ranking or listening", baseDirectory: path.relative(ROOT, base),
    requestSha256: sha(fs.readFileSync(requestFile)), collectionSha256: sha(fs.readFileSync(progressFile)), priorProviderAttempts: progress.attempts.length, priorModelRuns: 0 };
  fs.mkdirSync(directory); for (const folder of ["audio", "guards"]) fs.mkdirSync(path.join(directory, folder));
  for (const entry of progress.entries) {
    const relative = path.relative(fs.realpathSync(base), fs.realpathSync(entry.sourceFile)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const bytes = fs.readFileSync(entry.sourceFile); assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: bytes });
    entry.sourceFile = path.join(directory, "audio", entry.source.sourceSha256 + ".audio"); fs.writeFileSync(entry.sourceFile, bytes, { flag: "wx" });
  }
  save(path.join(directory, "request.json"), request); progress.requestSha256 = sha(fs.readFileSync(path.join(directory, "request.json")));
  save(path.join(directory, "collection.json"), progress); save(path.join(directory, "collection-code-receipt.json"), codeReceipt());
  console.log(JSON.stringify({ extended: true, frozenPagesReused: progress.pages.length, exactSourcesCopied: progress.entries.length, priorAttemptsCounted: progress.attempts.length,
    anchorAttemptCap: 18, candidateAttemptCap: 36, sourceCap: 100, modelRuns: 0 }));
}
function reuse(directory, base) {
  assert.ok(directory !== base && !fs.existsSync(directory));
  const parentPlan = read(path.join(base, "plan.json")), requestFile = path.join(base, "request.json"), poolFile = path.join(base, "pool.json");
  assert.equal(parentPlan.requestSha256, sha(fs.readFileSync(requestFile))); assert.equal(parentPlan.poolSha256, sha(fs.readFileSync(poolFile)));
  assert.deepEqual(parentPlan.models, MODELS.map(analysisSpec));
  for (const file of parentPlan.code.files) assert.equal(sha(fs.readFileSync(path.join(base, "code-snapshot", file.path))), file.sha256, "Preserve the superseded sealed code snapshot.");
  const request = read(requestFile), pool = read(poolFile), { SonicCatalogScoutCache } = require("../src/sonicCatalogScoutCache");
  const originalCache = new SonicCatalogScoutCache({ directory: path.join(base, "cache"), maxSources: 100 });
  assert.ok(pool.entries.every(entry => originalCache.status({ track: entry.track, source: entry.source }).jointReady));
  fs.mkdirSync(directory); for (const folder of ["audio", "guards", "cache"]) fs.mkdirSync(path.join(directory, folder));
  for (const entry of pool.entries) {
    const relative = path.relative(fs.realpathSync(base), fs.realpathSync(entry.sourceFile)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const bytes = fs.readFileSync(entry.sourceFile); assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: bytes });
    entry.sourceFile = path.join(directory, "audio", entry.source.sourceSha256 + ".audio"); fs.writeFileSync(entry.sourceFile, bytes, { flag: "wx" });
  }
  for (const row of pool.requests) delete row.options.genres;
  request.recipe.explicitGenrePolicy = "Sampling categories do not create user-requested hard genre constraints.";
  request.replayCorrection = { reason: "Remove the incorrectly invented hard genre constraint from plain anchor-similarity requests.",
    parentDirectory: path.relative(ROOT, base), requestSha256: parentPlan.requestSha256, poolSha256: parentPlan.poolSha256,
    parentPlanSha256: sha(fs.readFileSync(path.join(base, "plan.json"))), sourceChanges: 0, newModelRuns: 0, tasteHistoryChanges: 0, scoringWeightChanges: 0 };
  const copied = [];
  function copyCache(source, target) {
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      assert.ok(!item.isSymbolicLink()); const from = path.join(source, item.name), to = path.join(target, item.name);
      const relative = path.relative(fs.realpathSync(base), fs.realpathSync(from)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      if (item.isDirectory()) { fs.mkdirSync(to); copyCache(from, to); }
      else { assert.ok(item.isFile() && copied.length < 500); const bytes = fs.readFileSync(from); fs.writeFileSync(to, bytes, { flag: "wx" }); copied.push({ path: path.relative(directory, to), sha256: sha(bytes) }); }
    }
  }
  copyCache(path.join(base, "cache"), path.join(directory, "cache"));
  for (const file of ["production-snapshot.json", "collection-coverage.json"]) fs.copyFileSync(path.join(base, file), path.join(directory, file), fs.constants.COPYFILE_EXCL);
  save(path.join(directory, "request.json"), request); save(path.join(directory, "pool.json"), pool);
  save(path.join(directory, "cache-reuse-receipt.json"), { parentDirectory: path.relative(ROOT, base), copied, exactSources: pool.entries.length, warmModelReceipts: pool.entries.length * 2, newModelRuns: 0 });
  console.log(JSON.stringify({ reusedSources: pool.entries.length, reusedModelReceipts: pool.entries.length * 2, hardSamplingGenreRemoved: true, newModelRuns: 0 }));
}
function canonical(supplied) {
  const track = { ...publicTrack(supplied), tidalId: String(supplied.tidalId || supplied.id), identityKey: "tidal:" + String(supplied.tidalId || supplied.id) };
  for (const key of ["year"]) if (!Number.isInteger(track[key])) { const number = Number(String(track[key] || "").slice(0, 4)); if (number >= 1000) track[key] = number; else delete track[key]; }
  for (const key of Object.keys(track)) if (track[key] === null || track[key] === "") delete track[key];
  return track;
}
async function collect(directory) {
  const requestFile=path.join(directory,'request.json'), request=read(requestFile), file=path.join(directory,'collection.json');
  assert.ok(!fs.existsSync(path.join(directory,'pool.json')), 'The pool is already frozen.');
  const config=require('../src/config'), quiet={log(){},warn(){},info(){},error(){},debug(){}};
  const tidal=new (require('../src/tidalVerifier').TidalVerifier)({...config.tidal,catalogPaginationFile:path.join(directory,'tidal-pagination.json')});
  const beatport=new (require('../src/beatportClient').BeatportClient)({...config.beatport,logger:quiet,maxSearchPages:1,maxSearchQueries:1,maxRetries:0});
  const token=beatport.store.read(); beatport.accessToken=token.accessToken||beatport.accessToken; beatport.refreshToken=''; beatport.clientId='';
  beatport.store={read:()=>({}),save:()=>{throw Error('Private collection cannot rewrite Beatport authentication.');}};
  assert.ok(tidal.isConfigured()&&beatport.isConfigured());
  assert.ok(!token.expiresAtMs||token.expiresAtMs-Date.now()>30000,'Existing Beatport access token is expired.');
  const {collectSonicCatalogScoutPool}=require('../src/sonicCatalogScoutCollector');
  const result=await collectSonicCatalogScoutPool({request,requestSha256:sha(fs.readFileSync(requestFile)),progress:fs.existsSync(file)?read(file):null,beatport,tidal,
    saveAudio:bytes=>{const target=path.join(directory,'audio',sha(bytes)+'.audio');if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx'});assert.equal(sha(fs.readFileSync(target)),sha(bytes));return target;},
    probeDuration:probe,persistProgress:progress=>update(file,progress)});
  assert.equal(result.complete,true,'The bounded collection could not supply all four requests.');
  save(path.join(directory,'pool.json'),result.pool);
  console.log(JSON.stringify({frozen:true,requests:result.pool.requests.length,uniqueSources:result.pool.entries.length,candidateCounts:result.pool.requests.map(row=>({requestId:row.requestId,count:row.candidateIdentityKeys.length})),modelRuns:0}));
}

const CODE_FILES = ["scripts/sonic-catalog-scout-pilot.js", "public/sonicBlindReview.js", "src/sonicCatalogScoutCollector.js", "src/sonicCatalogScoutService.js", "src/server.js", "src/sonicCatalogScouts.js", "src/sonicCatalogScoutCache.js", "src/sonicCatalogScoutFinalizer.js",
  "src/sonicCatalogScoutReview.js", "src/sonicBlindReview.js", "src/discoveryEngine.js", "src/discoveryOrchestration.js", "src/tasteProfile.js",
  "src/discoveryHistory.js", "src/sonicEnsembleTasteShadow.js", "src/sonicEnsemble.js", "src/recommendationV2Discovery.js", "src/tasteClusterScoring.js",
  "src/sonicAnalysisWorker.js", "src/sonicAnchorExperiment.js", "src/sonicCandidateCorpus.js", "scripts/sonic-analysis-worker.py", "scripts/sonic_analysis_audio.py",
  "src/sonicAnalysisSpec.js", "src/sonicAnalysisPilot.js", "src/sonicEnsembleEvaluation.js", "src/catalogIdentityNormalization.js", "src/tidalIdentity.js", "src/musicMemoryStore.js",
  "src/exactTrackVerification.js", "src/beatportVersionMatch.js", "src/sonicEmbeddingStore.js", "scripts/sonic-prepare-blind-review.js",
  "scripts/sonic-analysis-wsl.sh", "config/sonic-analyzers.json", "config/sonic-model-code-sha256.json"];
const codeReceipt = () => ({ files: CODE_FILES.map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(ROOT, file))) })) });
function freezeCollection(directory) {
  const request = read(path.join(directory, "request.json")), progress = read(path.join(directory, "collection.json"));
  assert.equal(progress.requestSha256, sha(fs.readFileSync(path.join(directory, "request.json"))));
  assert.equal(progress.requests.length, request.requests.length, "Every requested anchor must have an actual frozen result.");
  assert.ok(progress.entries.length <= request.recipe.maxSources);
  for (const spec of request.requests) {
    const result = progress.requests.find(row => row.requestId === spec.requestId); assert.ok(result && progress.entries.some(entry => entry.track.identityKey === result.anchorIdentityKey));
    assert.equal(result.complete, result.candidateIdentityKeys.length >= 6); assert.ok(result.candidateIdentityKeys.length <= 12);
    for (const role of ["anchor", "candidate"]) assert.ok(progress.attempts.filter(row => row.requestId === spec.requestId && row.role === role).length <= request.recipe[role === "anchor" ? "maxAnchorAttempts" : "maxCandidateAttempts"]);
  }
  for (const entry of progress.entries) assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(entry.sourceFile) });
  save(path.join(directory, "pool.json"), { version: 1, kind: "catalog-scout-pilot-pool", entries: progress.entries,
    requests: progress.requests.map(({ complete, ...row }) => row) });
  save(path.join(directory, "collection-coverage.json"), { exactSources: progress.entries.length, complete: progress.requests.every(row => row.complete),
    requests: progress.requests.map(row => ({ requestId: row.requestId, eligibleCandidates: row.candidateIdentityKeys.length, adequatelyPopulated: row.complete })),
    providerAttempts: progress.attempts.length, sparseResultsPreserved: true, modelRuns: 0, productionApplied: false });
  console.log(JSON.stringify({ frozen: true, sources: progress.entries.length, candidateCounts: progress.requests.map(row => ({ requestId: row.requestId, count: row.candidateIdentityKeys.length })), collectionComplete: progress.requests.every(row => row.complete) }));
}
function seal(directory) {
  const file = path.join(directory, "plan.json"); assert.ok(!fs.existsSync(file), "A sealed pilot is never rewritten.");
  const poolFile = path.join(directory, "pool.json"), pool = read(poolFile); assert.equal(pool.requests.length, 4); assert.ok(pool.entries.length <= 100);
  const maximumModelRuns = read(path.join(directory, "request.json")).replayCorrection ? 0 : pool.entries.length * 2;
  save(file, { version: 1, createdAt: new Date().toISOString(), requestSha256: sha(fs.readFileSync(path.join(directory, "request.json"))), poolSha256: sha(fs.readFileSync(poolFile)),
    code: codeReceipt(), models: MODELS.map(analysisSpec), maximumModelRuns, productionApplied: false });
  console.log(JSON.stringify({ sealed: true, sources: pool.entries.length, maximumModelRuns }));
}
function checkPlan(directory) {
  const plan = read(path.join(directory, "plan.json")); assert.deepEqual(plan.code, codeReceipt(), "Code changed after pilot seal.");
  assert.deepEqual(plan.models, MODELS.map(analysisSpec));
  assert.equal(plan.requestSha256, sha(fs.readFileSync(path.join(directory, "request.json")))); assert.equal(plan.poolSha256, sha(fs.readFileSync(path.join(directory, "pool.json"))));
  const pool = read(path.join(directory, "pool.json"));
  assert.equal(plan.maximumModelRuns, read(path.join(directory, "request.json")).replayCorrection ? 0 : pool.entries.length * 2);
  for (const entry of pool.entries) { const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(entry.sourceFile)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(entry.sourceFile) }); }
  return { plan, pool };
}
function guard(directory, label, gpu = false) {
  const raw = execFileSync(process.execPath, [path.join(ROOT, "data/sonic-catalog-scout-state-20261008.cjs"), "guard"], { windowsHide: true, timeout: 20000, encoding: "utf8" });
  const value = JSON.parse(raw); assert.equal(value.guardPassed, true); if (gpu) {
    value.gpuFreeMiB = Number(execFileSync("nvidia-smi", ["--id=0", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10000, encoding: "utf8" }).trim()); assert.ok(value.gpuFreeMiB >= 6144);
  }
  save(path.join(directory, "guards", `${label}-${Date.now()}.json`), value); return value;
}
async function release(worker, child) {
  worker.stop();
  assert.ok(Number.isSafeInteger(child?.linuxPid), "Owned worker PID is required to confirm model release.");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "kill", "-0", String(child.linuxPid)], { windowsHide: true, timeout: 2000, stdio: "pipe" }); }
      catch (error) { if (/No such process/.test(String(error.stderr || ""))) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(resolve => setTimeout(resolve, 250)); continue;
      } throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error("Owned model worker release could not be confirmed.");
}
function workerPreflight(directory, entries) {
  assert.ok(!process.env.SONIC_ANALYSIS_ENV_ROOT, "Use the pinned worker runtime.");
  const runtime = "/home/darth/micromamba-root/envs/rabbit-hole-mert2";
  const sources = entries.map(entry => ({ path: wslPath(entry.sourceFile), sha256: entry.source.sourceSha256, bytes: entry.source.byteLength }));
  const code = "import sys,json,hashlib,pathlib,importlib.metadata\nitems=json.loads(sys.argv[1])\nassert 2<=len(items)<=100\nfor item in items:\n p=pathlib.Path(item['path'])\n assert p.is_file() and p.stat().st_size==item['bytes']\n assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256']\nprint(json.dumps({'valid':True,'sources':len(items),'versions':{name:importlib.metadata.version(name) for name in ['torch','transformers','numpy','soundfile']}}))";
  const result = JSON.parse(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", runtime + "/bin/python", "-c", code, JSON.stringify(sources)], { windowsHide: true, timeout: 30000, encoding: "utf8", maxBuffer: 65536 }));
  assert.equal(result.valid, true); assert.equal(result.sources, entries.length);
  save(path.join(directory, `preflight-${Date.now()}.json`), result);
}
async function analyze(directory) {
  const { plan, pool } = checkPlan(directory), { SonicCatalogScoutCache } = require("../src/sonicCatalogScoutCache");
  workerPreflight(directory, pool.entries);
  const cache = new SonicCatalogScoutCache({ directory: path.join(directory, "cache"), maxSources: 100 });
  const attemptsFile = path.join(directory, "inference-attempts.json"), attempts = fs.existsSync(attemptsFile) ? read(attemptsFile) : [];
  const cold = pool.entries.filter(entry => !cache.status({ track: entry.track, source: entry.source }).jointReady).length;
  let runs = 0, hits = 0;
  for (const analyzer of MODELS) {
    const spec = analysisSpec(analyzer), missing = pool.entries.filter(entry => cache.get({ track: entry.track, source: entry.source, analyzer }).status !== "warm");
    hits += pool.entries.length - missing.length; if (!missing.length) continue;
    const before = guard(directory, `${analyzer}-before`, true), worker = new SonicAnalysisWorker({ device: "cuda" }); let child;
    try {
      for (const entry of missing) {
        checkPlan(directory); guard(directory, `${analyzer}-${runs}-before`);
        assert.ok(attempts.length < plan.maximumModelRuns, "The sealed inference attempt cap is exhausted.");
        assert.ok(!attempts.some(row => row.analyzer === analyzer && row.identityKey === entry.track.identityKey), "An incomplete inference attempt needs investigation before retrying.");
        const attempt = { analyzer, identityKey: entry.track.identityKey, startedAt: new Date().toISOString(), status: "started" };
        attempts.push(attempt); update(attemptsFile, attempts); const began = Date.now();
        const pending = worker.run(entry.sourceFile, spec); child = worker.child; const result = await pending;
        assertSonicSourceSnapshot(entry.source, { track: entry.track, audioBytes: fs.readFileSync(entry.sourceFile) });
        cache.ingest({ track: entry.track, source: entry.source, analyzer, receipt: createPrivateResultReceipt(result, spec, entry.source), audioBytes: fs.readFileSync(entry.sourceFile) });
        attempt.status = "complete"; attempt.completedAt = new Date().toISOString(); attempt.elapsedMs = Date.now() - began; update(attemptsFile, attempts);
        runs++; console.log(JSON.stringify({ analyzer, completed: runs, cached: hits, total: pool.entries.length * 2, productionApplied: false }));
      }
    } finally { if (child) await release(worker, child); else worker.stop(); }
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = guard(directory, `${analyzer}-after`, true); assert.ok(after.gpuFreeMiB >= before.gpuFreeMiB - 128, "Worker memory did not return to baseline.");
  }
  checkPlan(directory); assert.ok(pool.entries.every(entry => cache.status({ track: entry.track, source: entry.source }).jointReady));
  save(path.join(directory, `encoding-${Date.now()}.json`), { completedAt: new Date().toISOString(), modelRuns: runs, cacheHits: hits, total: pool.entries.length * 2, coldSourcesBefore: cold,
    jointWarmSourcesAfter: pool.entries.length, allWorkersReleased: true, productionApplied: false });
}
async function compare(directory) {
  const { plan, pool } = checkPlan(directory), request = read(path.join(directory, "request.json"));
  const { SonicCatalogScoutCache } = require("../src/sonicCatalogScoutCache"), { freezeSonicCatalogScoutPool, buildSonicCatalogScouts } = require("../src/sonicCatalogScouts");
  const { finalizeCatalogScoutCandidates } = require("../src/sonicCatalogScoutFinalizer"), { readTasteClusterProfiles } = require("../src/tasteClusterScoring");
  const { decodeVector } = require("../src/sonicEmbeddingStore");
  const cache = new SonicCatalogScoutCache({ directory: path.join(directory, "cache"), maxSources: 100 });
  const snapshotFile = path.join(directory, "production-snapshot.json");
  if (!fs.existsSync(snapshotFile)) {
    const state = read(path.join(ROOT, "data/sonic-catalog-scout-20261008-before.json"));
    const { candidateIdentityKeys } = require("../src/recommendationV2Discovery");
    const snapshot = withDb(db => ({ model: "discogs-effnet", modelVersion: "1", mode: state.production.productionMode, maxAdjustment: state.production.maxAdjustment,
      minCoverage: state.production.minCoverage, minScored: state.production.minScored, profiles: readTasteClusterProfiles(db, { model: "discogs-effnet", modelVersion: "1", status: "" }),
      embeddings: [...new Set(pool.entries.flatMap(entry => candidateIdentityKeys(entry.track)))].flatMap(identity => { const row = db.prepare("SELECT identity_key,dimensions,embedding_base64,source_sha256 FROM track_sonic_profile WHERE identity_key=? AND model='discogs-effnet' AND model_version='1'").get(identity);
        return row ? [[identity, { identityKey: row.identity_key, dimensions: row.dimensions, vector: decodeVector(row.embedding_base64), sourceSha256: row.source_sha256 }]] : []; }) }));
    save(snapshotFile, snapshot);
  }
  const productionSnapshot = read(snapshotFile), output = { version: 1, evaluatedAt: new Date().toISOString(), recipe: request.recipe, code: plan.code, requests: [], productionApplied: false };
  assert.equal(productionSnapshot.mode, "blend"); assert.equal(new Date().getFullYear(), request.recipe.scoringYear);
  for (const item of pool.requests) {
    const anchor = pool.entries.find(entry => entry.track.identityKey === item.anchorIdentityKey), entries = item.candidateIdentityKeys.map(identity => pool.entries.find(entry => entry.track.identityKey === identity));
    const frozen = freezeSonicCatalogScoutPool({ items: entries });
    const matrices = new Map(MODELS.map(analyzer => [analyzer, { spec: analysisSpec(analyzer), records: new Map([anchor, ...frozen.items].map(entry => {
      const cached = cache.get({ track: entry.track, source: entry.source, analyzer }); assert.equal(cached.status, "warm"); return [entry.track.identityKey, cached.record]; })) }]));
    const context = { options: item.options, requestedCount: 3, tasteSnapshot: request.tasteSnapshot, historySnapshot: request.historySnapshot, productionSnapshot };
    const metadata = new Map(entries.map(entry => [entry.track.identityKey, entry.metadata || {}]));
    const final = async tracks => finalizeCatalogScoutCandidates(tracks.map(track => ({ ...track, ...metadata.get(track.identityKey) })), context);
    const arms = {}, summarize = result => ({ tracks: result.tracks.map(track => {
      const identity = canonical(track.tidal || track).identityKey, original = entries.find(entry => entry.track.identityKey === identity);
      assert.ok(original, "Final output escaped its frozen pool.");
      return { track: original.track, score: track.score, scoreBreakdown: track.scoreBreakdown };
    }),
      returnedCount: result.tracks.length, discardedCount: result.discarded?.length || 0, verification: result.verification });
    arms["current-production"] = summarize(await final(entries.map(entry => entry.track)));
    for (const selector of [...MODELS, "ensemble"]) {
      const scout = buildSonicCatalogScouts({ anchor, pool: frozen, matrices, selector, mode: "observe", scoutCount: 6, finalCount: 3, agreementWeight: 0 });
      assert.equal(scout.diagnostics.partialCoverage, false); arms[selector] = { ...summarize(await final(scout.scouts)), scoutDiagnostics: scout.diagnostics };
    }
    output.requests.push({ requestId: item.requestId, anchorIdentityKey: item.anchorIdentityKey, arms });
  }
  save(path.join(directory, "comparison.json"), output);
  console.log(JSON.stringify({ compared: output.requests.length, armCounts: output.requests.map(row => ({ requestId: row.requestId, counts: Object.fromEntries(Object.entries(row.arms).map(([arm, value]) => [arm, value.returnedCount])) })), productionApplied: false }));
}
function prepareReview(directory) {
  checkPlan(directory);
  const { buildCatalogScoutReviewPlan, validateCatalogScoutReviewPlan } = require("../src/sonicCatalogScoutReview");
  const file = path.join(directory, "review-plan.json");
  let plan = fs.existsSync(file) ? read(file) : buildCatalogScoutReviewPlan({ roundId: "catalog-scout-pilot-20261008",
    comparison: { file: path.join(directory, "comparison.json"), sha256: sha(fs.readFileSync(path.join(directory, "comparison.json"))) },
    pool: { file: path.join(directory, "pool.json"), sha256: sha(fs.readFileSync(path.join(directory, "pool.json"))) } });
  if (!plan) { save(path.join(directory, "no-differences.json"), { differingPairs: 0, productionApplied: false }); console.log(JSON.stringify({ differingPairs: 0, reviewRequired: false })); return; }
  if (!fs.existsSync(file)) save(file, plan);
  const cacheDirectory = path.join(ROOT, "data/sonic-blind-audio");
  withDb(db => validateCatalogScoutReviewPlan(plan, { db }));
  const { validateWave } = require("./sonic-prepare-blind-review");
  for (const clip of Object.values(plan.clips)) {
    const target = path.join(cacheDirectory, clip.clipId + ".wav");
    if (clip.wavSha256 && fs.existsSync(target)) {
      validateWave(target, clip);
      assert.equal(sha(fs.readFileSync(target)), clip.wavSha256);
    } else {
      const temporary = target + "." + randomUUID() + ".tmp.wav";
      assert.equal(sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256);
      execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffmpeg", "-v", "error", "-nostdin", "-i", wslPath(clip.sourceFile),
        "-ss", String(clip.start), "-t", String(clip.end - clip.start), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-y", wslPath(temporary)],
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
      validateWave(temporary, clip);
      if (fs.existsSync(target)) {
        assert.equal(sha(fs.readFileSync(temporary)), sha(fs.readFileSync(target)), "Existing WAV differs from the exact frozen decode.");
        fs.unlinkSync(temporary);
      } else fs.renameSync(temporary, target);
    }
    assert.equal(sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256);
    clip.wavSha256 = sha(fs.readFileSync(target)); update(file, plan);
  }
  withDb(db => validateCatalogScoutReviewPlan(plan, { db, requirePrepared: true, cacheDirectory }));
  console.log(JSON.stringify({ prepared: true, differingPairs: plan.count, requests: plan.anchorCount, uniqueClips: Object.keys(plan.clips).length, commonPairsOmitted: plan.excludedCommonPairs }));
}
function publish(directory) {
  checkPlan(directory); guard(directory, "before-publication");
  assert.ok(fs.existsSync(path.join(ROOT, "data/sonic-catalog-scout-20261008-after.json")), "Complete the protected-state audit before publishing new rows.");
  const plan = read(path.join(directory, "review-plan.json"));
  const { SonicBlindReview } = require("../src/sonicBlindReview");
  const result = withDb(db => new SonicBlindReview(db).create(plan), true);
  console.log(JSON.stringify({ published: true, batchId: result.batch.batchId, count: result.batch.count, completed: result.batch.completed,
    url: "http://127.0.0.1:3777/?sonicBlindBatch=" + encodeURIComponent(result.batch.batchId) }));
}
async function main(argv = process.argv.slice(2)) {
  const [stage, flag, output] = argv;
  assert.ok(flag === "--output" && (["extend", "reuse"].includes(stage) ? argv.length === 5 && argv[3] === "--from" : argv.length === 3)
    && ["init", "extend", "reuse", "collect", "freeze", "seal", "analyze", "compare", "review", "publish"].includes(stage));
  const directory = directoryFor(output);
  if (stage === "init") return init(directory);
  if (stage === "extend") return extend(directory, directoryFor(argv[4]));
  if (stage === "reuse") return reuse(directory, directoryFor(argv[4]));
  const lockFile = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID();
  save(lockFile, { token, pid: process.pid, stage, directory, createdAt: new Date().toISOString() });
  const blindLock = ["review", "publish"].includes(stage) ? path.join(ROOT, "data/sonic-blind-preparation.lock") : null;
  let ownsBlindLock = false;
  try {
    if (blindLock) { save(blindLock, { token, pid: process.pid, stage, directory }); ownsBlindLock = true; }
    if (stage === "collect") return await collect(directory); if (stage === "seal") return seal(directory);
    if (stage === "freeze") return freezeCollection(directory);
    if (stage === "analyze") return await analyze(directory); if (stage === "compare") return await compare(directory);
    if (stage === "review") return prepareReview(directory); return publish(directory);
  } finally {
    if (ownsBlindLock && read(blindLock).token === token) fs.unlinkSync(blindLock);
    if (read(lockFile).token === token) fs.unlinkSync(lockFile);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { directoryFor, withDb, canonical, codeReceipt, checkPlan, main };
