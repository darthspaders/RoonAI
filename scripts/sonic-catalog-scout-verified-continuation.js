"use strict";

// A new, bounded catalogue declaration. The old completed study remains sealed.
// Providers are constructed only by auth/collect; publication and inference are
// separate stages. Every main-database read is query-only.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto"), { execFileSync } = require("node:child_process"), { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const old = require("./sonic-catalog-scout-fresh"), review = require("../src/sonicCatalogVerifiedReview");
const diagnostic = require("./sonic-catalog-sourcing-diagnostic"), { configureTidalNoRetry } = diagnostic;
const collector = require("../src/sonicCatalogVerifiedContinuationCollector");
const recovery = require("./sonic-catalog-scout-verified-recovery"), atomic = require("../src/sonicPrivateAtomicJson");
const { safeBeatportTransport, configureRecoveryTidalTransport, stopIfInfrastructure, closeInfrastructureCollection, safeException } = recovery;
const ROOT = path.resolve(__dirname, ".."), DIRECTORY = path.join(ROOT, "data/sonic-catalog-scout-verified-continuation-30s-20261008");
const SCRIPT = "scripts/sonic-catalog-scout-verified-continuation.js", IDLE_GUARD = "data/sonic-catalog-scout-state-20261008.cjs";
const ORIGINAL_DIRECTORY = "data/sonic-catalog-scout-verified-30s-20261008";
const RECOVERY_EVIDENCE_FILES = Object.freeze(["request.json", "collection.json", "coverage-audit.json", "collection-transport.json",
  "transport-health-predeclaration.json", "transport-health.json"].map(file => ORIGINAL_DIRECTORY + "/" + file));
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), read = file => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function update(file, value) { ownedPath(file); return atomic.updatePrivateJson(file, value); }
function ownedPath(file) {
  assert.ok(fs.lstatSync(DIRECTORY).isDirectory() && !fs.lstatSync(DIRECTORY).isSymbolicLink(), "The new private directory must be a real directory.");
  const root = fs.realpathSync(DIRECTORY), absolute = path.resolve(file), relative = path.relative(root, absolute);
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "The new run path escaped its private directory.");
  let current = root;
  for (const piece of relative.split(path.sep)) {
    current = path.join(current, piece);
    try { assert.ok(!fs.lstatSync(current).isSymbolicLink()); const rel = path.relative(root, fs.realpathSync(current)); assert.ok(rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return absolute;
}
function withDb(callback) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: true });
  db.exec("PRAGMA query_only=ON;BEGIN"); try { return callback(db); } finally { db.exec("ROLLBACK"); db.close(); }
}
function baseline() {
  const value = read(ownedPath(path.join(DIRECTORY, "preservation-before.json"))), snapshot = value.snapshot || value;
  assert.ok(snapshot.files && Object.keys(snapshot.files).length === 15 && snapshot.tables, "Capture the independent preservation baseline before mutating this run.");
  return snapshot;
}
function pins() {
  const rows = [...recovery.pins().files, ...old.pins().files, ...diagnostic.pins().files, ...review.verifiedReviewCodeReceipt().files,
    ...[SCRIPT, "src/sonicCatalogVerifiedContinuationCollector.js", "src/sonicPrivateAtomicJson.js", "src/sonicCatalogVerifiedSource.js", "scripts/sonic-catalog-sourcing-diagnostic.js", IDLE_GUARD].map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(ROOT, file))) }))];
  const map = new Map();
  for (const row of rows) { if (map.has(row.path)) assert.equal(map.get(row.path).sha256, row.sha256); map.set(row.path, row); }
  assert.ok(map.size <= 100); return { files: [...map.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
function guard(label) {
  baseline();
  let output;
  try { output = execFileSync(process.execPath, [path.join(ROOT, IDLE_GUARD), "guard"], { windowsHide: true, timeout: 30000, encoding: "utf8" }); }
  catch (error) { if (!error.stdout) throw Error("Idle inspection did not return usable safe evidence."); output = error.stdout; }
  const result = JSON.parse(String(output));
  save(ownedPath(path.join(DIRECTORY, "guards", label + "-" + Date.now() + ".json")), result);
  assert.equal(result.guardPassed, true, "Wait for existing playback and analysis to become idle; never stop them for this review.");
  return result;
}
const binding = name => { const file = ownedPath(path.join(DIRECTORY, name)); return { file, sha256: sha(fs.readFileSync(file)) }; };
function recoveryEvidence() {
  return RECOVERY_EVIDENCE_FILES.map(relative => { const file = path.join(ROOT, relative); assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()); return { file, sha256: sha(fs.readFileSync(file)) }; });
}
function exclusionsFrom(plans, collections, original, priorRequests = [], pools = []) {
  assert.ok(Array.isArray(plans) && Array.isArray(collections) && Array.isArray(original?.heldOut) && original.heldOut.length === 6);
  const tracks = plans.flatMap(plan => (plan.groups || []).flatMap(group => [group.anchor, ...(group.candidates || []).map(candidate => candidate.track)]));
  tracks.push(...[...collections, ...pools].flatMap(collection => (collection.entries || []).map(entry => entry.track)), ...priorRequests.flatMap(request => request.excluded || []));
  assert.ok(tracks.every(track => track?.identityKey && track.artist && track.title));
  const excluded = [...new Map(tracks.map(track => [JSON.stringify(track), track])).values()];
  const sourceIds = [], sourceHashes = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    if (value.sourceType === "beatport-preview") { if (value.sourceTrackId) sourceIds.push(String(value.sourceTrackId)); if (value.sourceSha256) sourceHashes.push(value.sourceSha256); }
    for (const item of Object.values(value)) walk(item);
  };
  [...plans, ...collections, ...pools].forEach(walk);
  const excludedBeatportTrackIds = [...new Set([...collections.flatMap(collection => (collection.attempts || []).map(row => String(row.beatportTrackId))),
    ...priorRequests.flatMap(request => request.excludedBeatportTrackIds || []).map(String), ...sourceIds, ...tracks.filter(track => track.beatportTrackId).map(track => String(track.beatportTrackId))])];
  assert.ok(excludedBeatportTrackIds.every(id => /^[1-9]\d*$/.test(id)));
  const heldOutHashes = original.heldOut.map(track => {
    const matches = original.originalManifest.items.filter(item => item.track.identityKey === track.identityKey); assert.equal(matches.length, 1);
    const value = matches[0].track.analysisLocal?.sha256; assert.match(value || "", /^[a-f0-9]{64}$/); return value;
  });
  const excludedSourceSha256 = [...new Set([...heldOutHashes, ...sourceHashes, ...plans.flatMap(plan => Object.values(plan.clips || {}).map(clip => clip.sourceSha256)),
    ...[...collections, ...pools].flatMap(collection => (collection.entries || []).map(entry => entry.source.sourceSha256)), ...priorRequests.flatMap(request => request.excludedSourceSha256 || [])])];
  assert.ok(excludedSourceSha256.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.ok(excluded.length <= 10000 && excludedBeatportTrackIds.length <= 10000 && excludedSourceSha256.length <= 10000);
  return { excluded, excludedBeatportTrackIds, excludedSourceSha256, heldOut: original.heldOut };
}
function readBound(value) {
  assert.ok(value && typeof value.file === "string" && /^[a-f0-9]{64}$/.test(value.sha256));
  const relative = path.relative(ROOT, fs.realpathSync(value.file)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.ok(fs.lstatSync(value.file).isFile() && !fs.lstatSync(value.file).isSymbolicLink());
  const bytes = fs.readFileSync(value.file); assert.ok(bytes.length <= 20 * 1024 * 1024); assert.equal(sha(bytes), value.sha256); return bytes;
}
function checkSeedFinalization() {
  const seedBinding = binding("continuation-seed.json"), finalizationBinding = binding("seed-finalization.json"), seedBytes = readBound(seedBinding), seed = JSON.parse(seedBytes);
  const finalization = read(finalizationBinding.file); assert.equal(finalization.version, 1); assert.deepEqual(finalization.seed, seedBinding);
  for (const key of ["originalCheckpoint", "originalCollection", "originalRequest", "originalDeclaration", "originalCode", "originalTransport"]) readBound(finalization[key]);
  assert.equal(finalization.sourceCount, 5); assert.equal(finalization.priorAttempts, 21); assert.equal(finalization.priorModelRuns, 0);
  assert.equal(finalization.priorReviewPublication, false); assert.equal(finalization.originalFilesChanged, false); assert.equal(finalization.interruptedSourceRetried, false);
  assert.equal(finalization.sourceProofsRevalidated, true); assert.equal(finalization.copiedAudioBytesUnchanged, true); assert.equal(finalization.productionApplied, false);
  assert.equal(finalization.sources.length, 5); const expected = JSON.parse(readBound(finalization.originalCheckpoint));
  expected.closed = true; expected.complete = false; Object.assign(expected.attempts.at(-1), { status: "unavailable", stage: "persistence", reason: "private-checkpoint-replace-interrupted" });
  for (const entry of expected.entries) {
    const records = finalization.sources.filter(row => row.identityKey === entry.track.identityKey && row.sourceSnapshotKey === entry.source.snapshotKey); assert.equal(records.length, 1);
    const record = records[0]; assert.equal(record.original.file, entry.sourceFile); assert.equal(record.original.sha256, entry.source.sourceSha256);
    assert.equal(record.copied.sha256, entry.source.sourceSha256); readBound(record.original); readBound(record.copied);
    entry.sourceFile = ownedPath(record.copied.file);
  }
  assert.deepEqual(seed, expected, "Only explicit checkpoint closing and unchanged-byte relocation may alter the seed.");
  assert.deepEqual(recovery.pins(), JSON.parse(readBound(finalization.originalCode)), "Frozen acquisition code changed.");
  const transport = JSON.parse(readBound(finalization.originalTransport)); assert.ok(!transport.infrastructureFailure);
  assert.ok([...transport.transport, ...transport.tidalRawTransport].every(row => row.status === 200));
  return { seed, seedBytes, seedBinding, finalization, finalizationBinding, transport };
}
function assertSeedMainFreshness(seed) {
  const plans = withDb(db => db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch").all().map(row => JSON.parse(row.private_plan_json)));
  const original = read(path.join(ROOT, "data/sonic-anchor-experiment-20261007/plan.json"));
  review.validateExclusions({ samplingScope: "two-genre", entries: seed.entries }, { samplingScope: "two-genre", ...exclusionsFrom(plans, [], original) });
}
function initialize() {
  baseline(); assert.ok(!fs.existsSync(path.join(DIRECTORY, "predeclaration.json")), "A declaration cannot be reopened or retried.");
  const context = checkSeedFinalization(), previousRequest = JSON.parse(readBound(context.finalization.originalRequest)); assertSeedMainFreshness(context.seed);
  const model = require("../src/sonicAnalysisSpec").analysisSpec("mert-30s"), declaration = { version: 1, createdAt: new Date().toISOString(),
    purpose: "Complete the same sixteen-source study while preserving five unjudged sources and never reacquiring prior attempted IDs",
    samplingScope: "two-genre", recipe: collector.CONTINUATION_COLLECTOR_RECIPE, models: [model], maximumModelRuns: 16, maximumBlindPairs: 12, maximumReviewSessions: 4,
    maximumSourceAttemptsCombined: 160, priorSourceAttempts: 21, maximumNewSourceAttempts: 139, carriedSources: 5, remainingSourcesRequired: 11,
    metadataCalls: 0, frozenMetadataPages: 6, cataloguePageNumbers: [2, 3, 4], maximumNewLocatorDetails: 80, maximumNewPreviews: 80,
    maximumCombinedBeatportTransportCalls: 200, maximumCombinedTidalApiTransportCalls: 1600, maximumCombinedTidalAuthenticationCalls: 12,
    maximumBeatportRefreshAttemptsCombined: 1, transportRetries: 0, transportFallback: false, maximumPreviewBytes: 20 * 1024 * 1024,
    continuationSeed: context.seedBinding, seedFinalization: context.finalizationBinding,
    infrastructureStop: "First non-2xx search,401/429/5xx,network/auth/circuit failure closes incomplete; detail404 stays a source rejection",
    locatorPolicy: "New unattempted Beatport ID only, after canonical admission; every frozen descriptor must match before transient preview URL use",
    atomicJsonPolicy: atomic.PRIVATE_JSON_POLICY, sourceBytesRetried: false, previousAttemptedSourcesRetried: false, labelsUsedForSelection: false,
    productionApplied: false, playbackInvoked: false, queueInvoked: false };
  const original = read(path.join(ROOT, "data/sonic-anchor-experiment-20261007/plan.json"));
  const exclusions = exclusionsFrom([], [context.seed], original, [previousRequest]);
  const request = { ...previousRequest, version: 1, createdAt: declaration.createdAt, recipe: { ...collector.CONTINUATION_COLLECTOR_RECIPE, models: [model], scoringYear: new Date().getFullYear() },
    requests: structuredClone(collector.CONTINUATION_COLLECTOR_REQUESTS), ...exclusions, continuationSeed: context.seedBinding, seedFinalization: context.finalizationBinding,
    predeclarationSha256: sha(Buffer.from(JSON.stringify(declaration, null, 2) + "\n")) };
  collector.validateContinuationCollectorRequest(request); collector.validateContinuationSeed(context.seedBytes, request);
  const view = { ...collector.continuationReviewRequest(request, context.seed), sourceRequest: { file: path.join(DIRECTORY, "request.json"), sha256: sha(Buffer.from(JSON.stringify(request, null, 2) + "\n")) } };
  save(ownedPath(path.join(DIRECTORY, "predeclaration.json")), declaration); save(ownedPath(path.join(DIRECTORY, "request.json")), request);
  save(ownedPath(path.join(DIRECTORY, "review-request.json")), view); save(ownedPath(path.join(DIRECTORY, "collection-code-receipt.json")), pins());
  console.log(JSON.stringify({ initialized: true, carriedSources: 5, remainingSources: 11, sourceAttemptsCombined: 160, newSourceAttempts: 139, metadataCalls: 0, exclusions: exclusions.excludedBeatportTrackIds.length }));
}
function checkDeclaration() {
  baseline(); const declaration = read(ownedPath(path.join(DIRECTORY, "predeclaration.json"))), request = read(ownedPath(path.join(DIRECTORY, "request.json"))), context = checkSeedFinalization();
  assert.equal(request.predeclarationSha256, binding("predeclaration.json").sha256); collector.validateContinuationCollectorRequest(request);
  assert.deepEqual(declaration.recipe, collector.CONTINUATION_COLLECTOR_RECIPE); assert.deepEqual(declaration.continuationSeed, context.seedBinding); assert.deepEqual(declaration.seedFinalization, context.finalizationBinding);
  assert.deepEqual(request.continuationSeed, context.seedBinding); assert.deepEqual(request.seedFinalization, context.finalizationBinding); collector.validateContinuationSeed(context.seedBytes, request);
  const inherited = JSON.parse(readBound(context.finalization.originalRequest)), original = read(path.join(ROOT, "data/sonic-anchor-experiment-20261007/plan.json"));
  const expectedExclusions = exclusionsFrom([], [context.seed], original, [inherited]);
  for (const key of ["excluded", "excludedBeatportTrackIds", "excludedSourceSha256", "heldOut"]) assert.deepEqual(request[key], expectedExclusions[key], "Bound prior exclusions changed: " + key);
  assert.deepEqual(pins(), read(ownedPath(path.join(DIRECTORY, "collection-code-receipt.json"))));
  const view = read(ownedPath(path.join(DIRECTORY, "review-request.json")));
  assert.deepEqual(view, { ...collector.continuationReviewRequest(request, context.seed), sourceRequest: binding("request.json") });
  assertSeedMainFreshness(context.seed); return { declaration, request, reviewRequest: view, ...context };
}
function provider() {
  const config = require("../src/config"), quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} };
  const beatport = new (require("../src/beatportClient").BeatportClient)({ ...config.beatport, logger: quiet, maxSearchPages: 1, maxSearchQueries: 1 });
  beatport.maxRetries = 0; beatport.getCachedJson = () => null; return { config, beatport };
}
async function authenticate() {
  const context = checkDeclaration(); guard("before-authentication"); const file = ownedPath(path.join(DIRECTORY, "authentication.json"));
  assert.ok(!fs.existsSync(file), "No repeat authentication declaration."); const { beatport } = provider(), before = beatport.store.read();
  const ledger = { version: 1, at: new Date().toISOString(), status: "started", refreshAttempts: context.transport.refreshAttempts,
    priorTransportCalls: (context.transport.priorTransportCalls || 0) + context.transport.transport.length, transport: [],
    before: { configured: beatport.isConfigured(), accessTokenStored: Boolean(before.accessToken), refreshTokenStored: Boolean(before.refreshToken), clientIdConfigured: Boolean(beatport.clientId), expired: Boolean(before.expiresAtMs && before.expiresAtMs <= Date.now()) } };
  save(file, ledger); safeBeatportTransport(beatport, ledger, () => update(file, ledger));
  try {
    const token = await beatport.getAccessToken(), after = beatport.store.read(); ledger.usable = Boolean(token && after.expiresAtMs > Date.now() + 60000);
    ledger.after = { accessTokenStored: Boolean(after.accessToken), refreshTokenStored: Boolean(after.refreshToken), expiresAt: after.expiresAtMs ? new Date(after.expiresAtMs).toISOString() : "", normalStoreChanged: sha(fs.readFileSync(beatport.store.file)) !== baseline().files["data/beatport-token.json"] };
    ledger.status = ledger.usable ? "ready-for-catalogue" : "authentication-unavailable";
  } catch { ledger.status = "authentication-unavailable"; ledger.usable = false; }
  if (!ledger.usable && !ledger.infrastructureFailure) ledger.infrastructureFailure = { kind: "authentication", reason: "authentication-unavailable", status: ledger.status, at: new Date().toISOString() };
  checkDeclaration(); update(file, ledger); console.log(JSON.stringify({ stage: "authentication", status: ledger.status, usable: ledger.usable, refreshAttempts: ledger.refreshAttempts, httpStatuses: ledger.transport.map(row => row.status) }));
}
const SAFE_FILESYSTEM_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EEXIST", "ENOENT", "ENOSPC", "EIO", "ENOTDIR", "EISDIR", "EINVAL", "EXDEV", "EROFS", "EMFILE", "ENFILE", "ENAMETOOLONG", "ELOOP"]);
function safeOperationalError(error) {
  return { kind: "private-persistence", code: /^PRIVATE_JSON_(?:PATH|SERIALIZATION|WRITE|REPLACE)_FAILED$/.test(error?.code || "") ? error.code : "PRIVATE_IO_FAILED",
    filesystemCode: SAFE_FILESYSTEM_CODES.has(error?.filesystemCode || error?.code) ? error.filesystemCode || error.code : "UNKNOWN",
    renameAttempts: Number.isInteger(error?.renameAttempts) && error.renameAttempts >= 0 && error.renameAttempts <= 5 ? error.renameAttempts : 0,
    checkpointRetained: error?.checkpointRetained === true };
}
function stopIfOperational(ledger) {
  if (ledger.operationalFailure) { const error = new Error("Private persistence stopped the collection without reacquisition."); error.code = "ECATALOGOPERATIONAL"; throw error; }
}
function seedTransportLedger(prior, auth) {
  return { version: 1, refreshAttempts: auth.refreshAttempts, priorTransportCalls: (prior.priorTransportCalls || 0) + prior.transport.length + auth.transport.length,
    priorTidalApiCalls: prior.tidalRawTransport.filter(row => row.kind !== "authentication").length,
    priorTidalAuthenticationCalls: prior.tidalRawTransport.filter(row => row.kind === "authentication").length,
    transport: [], tidalTransport: structuredClone(prior.tidalTransport), tidalRawTransport: structuredClone(prior.tidalRawTransport), previewCalls: prior.previewCalls || 0,
    newLocatorDetails: [], newPreviewCalls: 0, newMetadataCalls: 0 };
}
function continuationBeatportFacade(beatport, { request, seed, ledger, persist, getProgress }) {
  return { fetchPreviewBuffer: async (row, options) => {
    assert.ok(!request.excludedBeatportTrackIds.includes(row.id) && !seed.attempts.some(attempt => attempt.beatportTrackId === row.id), "Prior attempted IDs cannot be reacquired.");
    const attempt = getProgress().attempts.at(-1);
    assert.ok(attempt.beatportTrackId === row.id && attempt.stage === "preview" && attempt.canonicalLookups.some(lookup => lookup.status === "verified" && lookup.admission?.accepted), "A new locator requires canonical admission first.");
    assert.ok(ledger.newLocatorDetails.length < 80 && ledger.newPreviewCalls < 80, "Declared locator/preview budget exhausted.");
    const record = { beatportTrackId: row.id, status: "started" }; ledger.newLocatorDetails.push(record); persist(); let previewUrl;
    try { const detail = await beatport.getTrackById(row.id); previewUrl = collector.validateLocatorDetail(row, detail, seed.cutoffDate); record.status = "all-frozen-descriptors-verified"; }
    catch (error) { record.status = "unavailable-or-frozen-descriptor-conflict"; persist(); throw error; }
    persist(); ledger.newPreviewCalls++; persist(); return beatport.fetchPreviewBuffer({ ...row, previewUrl }, options);
  } };
}
function probe(file) {
  ownedPath(file); const { wslPath } = require("../src/sonicAnalysisWorker");
  const duration = Number(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" }).trim());
  assert.ok(duration >= 30 && duration <= 7200); return duration;
}
async function collect() {
  const context = checkDeclaration(), { request, reviewRequest, seed, seedBytes } = context, auth = read(ownedPath(path.join(DIRECTORY, "authentication.json"))); assert.equal(auth.usable, true, "Normal Beatport authentication is unavailable.");
  const file = ownedPath(path.join(DIRECTORY, "collection.json")), metricFile = ownedPath(path.join(DIRECTORY, "collection-transport.json"));
  assert.ok(!fs.existsSync(file) && !fs.existsSync(metricFile), "Do not retry a started or closed collection."); guard("before-collection");
  const { config, beatport } = provider(), ledger = seedTransportLedger(context.transport, auth); let lastProgress = null;
  const persistLedger = () => { stopIfOperational(ledger); try { update(metricFile, ledger); } catch (error) { ledger.operationalFailure = safeOperationalError(error); throw error; } };
  save(metricFile, ledger); safeBeatportTransport(beatport, ledger, persistLedger);
  const beatportFacade = continuationBeatportFacade(beatport, { request, seed, ledger, persist: persistLedger, getProgress: () => lastProgress });
  const tidal = configureRecoveryTidalTransport(new (require("../src/tidalVerifier").TidalVerifier)({ ...config.tidal, catalogPaginationFile: path.join(DIRECTORY, "tidal-pagination.json") }), ledger, persistLedger); assert.ok(tidal.isConfigured());
  const detail = tidal.withDetailYear.bind(tidal); let searchOnly = false;
  tidal.withDetailYear = async value => searchOnly ? value : detail(value);
  const tidalFacade = { searchTracks: async (...args) => { assert.equal(searchOnly, false); searchOnly = true; try { return await tidal.searchTracks(...args); } finally { searchOnly = false; } }, getTrack: (...args) => tidal.getTrack(...args) };
  let lastCount = 0, lastAttemptNotice = 0; const began = performance.now();
  let result;
  try { result = await collector.collectSonicCatalogVerifiedContinuationPool({ request, requestSha256: binding("request.json").sha256, seedBytes, beatport: beatportFacade, tidal: tidalFacade,
    saveAudio: async (bytes, { sourceSha256 }) => { assert.equal(sha(bytes), sourceSha256); const target = ownedPath(path.join(DIRECTORY, "audio", sourceSha256 + ".audio"));
      try { if (fs.existsSync(target)) assert.equal(sha(fs.readFileSync(target)), sourceSha256); else fs.writeFileSync(target, bytes, { flag: "wx" }); }
      catch (error) { ledger.operationalFailure = safeOperationalError(error); throw error; } return target; }, probeDuration: probe,
    persistProgress: async value => { lastProgress = structuredClone(value); stopIfOperational(ledger); try { if (fs.existsSync(file)) update(file, value); else save(file, value); }
      catch (error) { ledger.operationalFailure = safeOperationalError(error); throw error; } if (value.entries.length !== lastCount || value.attempts.length >= lastAttemptNotice + 10) {
      lastCount = value.entries.length; lastAttemptNotice = value.attempts.length; console.log(JSON.stringify({ verifiedSources: lastCount, attempts: value.attempts.length, modelRuns: 0 }));
    } stopIfInfrastructure(ledger); } }); }
  catch (error) {
    const base = lastProgress || read(file), progress = { ...base, closed: true, complete: false, aborted: true,
      ...(ledger.operationalFailure ? { operationalFailure: ledger.operationalFailure } : ledger.infrastructureFailure ? { infrastructureFailure: ledger.infrastructureFailure } : { operationalFailure: safeOperationalError(error) }) };
    let stoppedBinding;
    try { update(file, progress); stoppedBinding = binding("collection.json"); }
    catch { const stopped = ownedPath(path.join(DIRECTORY, "stopped-collection.json")); save(stopped, progress); stoppedBinding = binding("stopped-collection.json"); }
    const temporaries = fs.readdirSync(DIRECTORY).filter(name => /^collection(?:-transport)?\.json\.[a-f0-9-]{36}\.tmp$/.test(name)).map(name => binding(name));
    save(ownedPath(path.join(DIRECTORY, "operational-stop.json")), { version: 1, at: new Date().toISOString(), closedIncomplete: stoppedBinding,
      failure: progress.infrastructureFailure || progress.operationalFailure, retainedCheckpoints: temporaries, modelRuns: 0, productionApplied: false });
    result = { progress, complete: false, pool: null };
  }
  checkDeclaration(); assert.equal(result.progress.closed, true, "Collection must close before any inference declaration.");
  const fullGate = result.complete === true && result.progress.entries.length === 16 && result.progress.genres.every(genre => genre.anchorIdentityKeys.length === 2 && genre.candidateIdentityKeys.length === 6);
  const receipt = { version: 1, at: new Date().toISOString(), elapsedMs: performance.now() - began, complete: result.complete, fullGate,
    verifiedSources: result.progress.entries.length, strictExactSources: result.progress.entries.filter(entry => entry.source.version === 1).length,
    verifiedOriginalSources: result.progress.entries.filter(entry => entry.source.version === 2).length,
    attempts: result.progress.attempts.length, pages: result.progress.pages.length, genres: result.progress.genres.map(genre => ({ genreId: genre.genreId, anchors: genre.anchorIdentityKeys.length, candidates: genre.candidateIdentityKeys.length })),
    infrastructureFailure: ledger.infrastructureFailure || null, operationalFailure: ledger.operationalFailure || null, carriedSources: 5, newSourceAttempts: result.progress.attempts.length - 21,
    newMetadataCalls: 0, newLocatorDetails: ledger.newLocatorDetails.length, newPreviewCalls: ledger.newPreviewCalls,
    rawTidalApiCalls: ledger.tidalRawTransport.filter(row => row.kind !== "authentication").length,
    rawTidalAuthenticationCalls: ledger.tidalRawTransport.filter(row => row.kind === "authentication").length,
    implicitSearchDetailsDisabled: true, localLibraryAudio: false, chartRankingEvidence: false, productionApplied: false };
  save(ownedPath(path.join(DIRECTORY, "coverage-audit.json")), receipt);
  if (fullGate) {
    assert.ok(result.pool); const breadth = collector.validateVerifiedCollectionBreadth(result.progress, { requireComplete: true });
    save(ownedPath(path.join(DIRECTORY, "collection-evidence.json")), { version: 1, kind: "catalog-fresh-combined-evidence", runs: [{ declaration: binding("request.json"), collection: binding("collection.json") }] });
    const pool = { ...result.pool, samplingScope: "two-genre", collectionEvidence: binding("collection-evidence.json") };
    collector.validateContinuationExclusions(pool, request, seed); review.validatePool(pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(pool, reviewRequest); save(ownedPath(path.join(DIRECTORY, "pool.json")), pool);
    save(ownedPath(path.join(DIRECTORY, "breadth-audit.json")), { version: 1, passed: true, at: new Date().toISOString(), samplingScope: "two-genre", verifiedSources: 16, anchors: 4,
      request: binding("request.json"), collection: binding("collection.json"), pool: binding("pool.json"), collectionEvidence: binding("collection-evidence.json"),
      reviewRequest: binding("review-request.json"), continuationSeed: binding("continuation-seed.json"), seedFinalization: binding("seed-finalization.json"),
      validation: breadth ?? true, genres: receipt.genres, breadth: result.progress.breadth, localLibraryAudio: false, labelsUsedForSelection: false, productionApplied: false });
    checkCollection();
  }
  console.log(JSON.stringify(receipt));
}
function checkCollection() {
  const context = checkDeclaration(), { request: sourceRequest, reviewRequest: request, seed } = context, collection = read(ownedPath(path.join(DIRECTORY, "collection.json"))), coverage = read(ownedPath(path.join(DIRECTORY, "coverage-audit.json"))),
    breadthAudit = read(ownedPath(path.join(DIRECTORY, "breadth-audit.json"))), pool = read(ownedPath(path.join(DIRECTORY, "pool.json")));
  assert.equal(coverage.fullGate, true); assert.equal(collection.closed, true); assert.equal(collection.requestSha256, binding("request.json").sha256);
  assert.equal(breadthAudit.passed, true); assert.equal(breadthAudit.productionApplied, false); assert.equal(breadthAudit.verifiedSources, 16);
  for (const key of ["request", "collection", "pool", "collectionEvidence"]) assert.deepEqual(breadthAudit[key], binding({ request: "request.json", collection: "collection.json", pool: "pool.json", collectionEvidence: "collection-evidence.json" }[key]));
  for (const [key, file] of Object.entries({ reviewRequest: "review-request.json", continuationSeed: "continuation-seed.json", seedFinalization: "seed-finalization.json" })) assert.deepEqual(breadthAudit[key], binding(file));
  collector.validateContinuationProgress(collection, sourceRequest, binding("request.json").sha256, seed); collector.validateContinuationExclusions(pool, sourceRequest, seed);
  collector.validateVerifiedCollectionBreadth(collection, { requireComplete: true }); assert.deepEqual(breadthAudit.breadth, collection.breadth);
  assert.equal(coverage.verifiedSources, collection.entries.length);
  assert.equal(coverage.strictExactSources, collection.entries.filter(entry => entry.source.version === 1).length);
  assert.equal(coverage.verifiedOriginalSources, collection.entries.filter(entry => entry.source.version === 2).length);
  assert.equal(coverage.attempts, collection.attempts.length); assert.equal(coverage.pages, collection.pages.length);
  assert.deepEqual(coverage.genres, collection.genres.map(genre => ({ genreId: genre.genreId, anchors: genre.anchorIdentityKeys.length, candidates: genre.candidateIdentityKeys.length })));
  review.validatePool(pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(pool, request);
  return { pool, request, sourceRequest, collection, breadthAudit };
}
async function main(argv = process.argv.slice(2)) {
  const [stage] = argv; assert.ok(argv.length === 1 && ["init", "auth", "collect"].includes(stage)); baseline();
  const file = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID(); save(file, { token, pid: process.pid, stage: "verified-continuation-" + stage, directory: DIRECTORY, at: new Date().toISOString() });
  try { if (stage === "init") return initialize(); if (stage === "auth") return await authenticate(); return await collect(); }
  finally { assert.equal(read(file).token, token); fs.unlinkSync(file); }
}
if (require.main === module) main().catch(() => { console.error("Continuation catalogue stage failed; private safe evidence retained, no automatic retry."); process.exitCode = 1; });
module.exports = { main, initialize, authenticate, collect, checkDeclaration, checkCollection, exclusionsFrom, safeBeatportTransport,
  ownedPath, pins, guard, withDb, DIRECTORY, ROOT, sha, read, save, update,
  safeException, stopIfInfrastructure, configureRecoveryTidalTransport,
  checkSeedFinalization, assertSeedMainFreshness, readBound, safeOperationalError, seedTransportLedger, continuationBeatportFacade };
