"use strict";

// A new, bounded catalogue declaration. The old completed study remains sealed.
// Providers are constructed only by auth/collect; publication and inference are
// separate stages. Every main-database read is query-only.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto"), { execFileSync } = require("node:child_process"), { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const old = require("./sonic-catalog-scout-fresh"), review = require("../src/sonicCatalogVerifiedReview");
const diagnostic = require("./sonic-catalog-sourcing-diagnostic"), { configureTidalNoRetry } = diagnostic;
const collector = require("../src/sonicCatalogVerifiedCollector");
const ROOT = path.resolve(__dirname, ".."), DIRECTORY = path.join(ROOT, "data/sonic-catalog-scout-verified-30s-20261008");
const SCRIPT = "scripts/sonic-catalog-scout-verified.js", IDLE_GUARD = "data/sonic-catalog-scout-state-20261008.cjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), read = file => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function update(file, value) { const temporary = file + "." + randomUUID() + ".tmp"; save(temporary, value); fs.renameSync(temporary, file); }
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
  const rows = [...old.pins().files, ...diagnostic.pins().files, ...review.verifiedReviewCodeReceipt().files,
    ...[SCRIPT, "src/sonicCatalogVerifiedCollector.js", "src/sonicCatalogVerifiedSource.js", "scripts/sonic-catalog-sourcing-diagnostic.js", IDLE_GUARD].map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(ROOT, file))) }))];
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
function initialize() {
  baseline(); assert.ok(!fs.existsSync(path.join(DIRECTORY, "predeclaration.json")), "A declaration cannot be reopened or retried.");
  const declaration = { version: 1, createdAt: new Date().toISOString(), purpose: "Fresh Bass House and raw techno fit using distinct albums and proved original recordings",
    samplingScope: "two-genre", recipe: collector.VERIFIED_COLLECTOR_RECIPE, models: [require("../src/sonicAnalysisSpec").analysisSpec("mert-30s")],
    maximumModelRuns: 16, maximumBlindPairs: 12, maximumReviewSessions: 4,
    completionGate: { verifiedSources: 16, freshAnchors: 4, sharedCandidatesPerGenre: 6, actualBeatportGenreIds: ["91", "92"], distinctAlbumsAndReleasesPerGenre: 8, disjointArtistIdsPerGenre: true },
    authentication: { normalTokenStore: true, normalClientId: true, maximumBeatportRefreshAttempts: 1, maximumBeatportTransportRetries: 0, safeHttpStatusReceipt: true },
    maximumBeatportTransportCalls: 200, maximumPreviewTransportCalls: 160, maximumPreviewBytes: 20 * 1024 * 1024, maximumTidalApiTransportCalls: 1600, maximumTidalAuthenticationCalls: 12,
    tidalTransportRetries: 0, tidal401Fallback: false, tidalDnsFallback: false,
    metadataPages: { genreIds: ["91", "92"], pages: [2, 3, 4], perPage: 100, maxPages: 1, maximumCalls: 6 },
    sourceAdmission: { originalEquivalentRequires: "same ISRC, full artist credits, canonical base title, TIDAL unlabeled/BP original, duration within one second, same album family/label/release date and both unchanged matchers matched", allowVersionProxy: false },
    exclusions: "All prior main and completed private review recordings, every prior v4/fresh/supplement/diverse/diagnostic attempt and collected source, and six reserved heldouts",
    genuineCatalogueListings: true, chartRankingEvidence: false, localLibraryAudio: false, labelsUsedForSelection: false, hardGenreConstraints: false,
    retriesOfFailedPriorRuns: false, productionApplied: false, playbackInvoked: false, queueInvoked: false };
  const mainPlans = withDb(db => db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch").all().map(row => JSON.parse(row.private_plan_json)));
  const privatePlan = read(path.join(ROOT, "data/sonic-catalog-scout-fresh-30s-20261008/review-plan.json"));
  const collections = ["data/sonic-catalog-scout-catalog-v4-20261008/collection.json", "data/sonic-catalog-scout-fresh-30s-20261008/collection.json",
    "data/sonic-catalog-scout-fresh-30s-20261008/supplement-collection.json", "data/sonic-catalog-scout-diverse-30s-20261008/collection.json", "data/sonic-catalog-sourcing-diagnostic-20261008/diagnostic.json"].map(file => read(path.join(ROOT, file)));
  assert.equal(collections.at(-2).closed, true); assert.equal(collections.at(-1).closed, true);
  const priorRequestFiles = ["data/sonic-catalog-scout-catalog-v4-20261008/request.json", "data/sonic-catalog-scout-fresh-30s-20261008/request.json", "data/sonic-catalog-scout-fresh-30s-20261008/supplement-request.json", "data/sonic-catalog-scout-diverse-30s-20261008/request.json", "data/sonic-catalog-sourcing-diagnostic-20261008/request.json"];
  const priorPoolFiles = ["data/sonic-catalog-scout-catalog-v4-20261008/pool.json", "data/sonic-catalog-scout-fresh-30s-20261008/scoped-pool.json", "data/sonic-catalog-scout-operational-20261008/pool.json"];
  const priorRequests = priorRequestFiles.map(file => read(path.join(ROOT, file))), pools = priorPoolFiles.filter(file => fs.existsSync(path.join(ROOT, file))).map(file => read(path.join(ROOT, file)));
  const diagnosticTracks = collections.at(-1).attempts.flatMap(attempt => attempt.canonicalLookups || []).filter(lookup => lookup.diagnostic?.canonicalTrack).map(lookup => lookup.diagnostic.canonicalTrack);
  priorRequests.push({ excluded: diagnosticTracks });
  const original = read(path.join(ROOT, "data/sonic-anchor-experiment-20261007/plan.json"));
  const history = new (require("../src/discoveryHistory").DiscoveryHistory)(), model = declaration.models[0];
  const request = { version: 1, createdAt: declaration.createdAt, samplingScope: "two-genre", recipe: { ...collector.VERIFIED_COLLECTOR_RECIPE, models: [model], scoringYear: new Date().getFullYear() },
    requests: JSON.parse(JSON.stringify(collector.VERIFIED_COLLECTOR_REQUESTS)), ...exclusionsFrom([...mainPlans, privatePlan], collections, original, priorRequests, pools),
    tasteSnapshot: new (require("../src/tasteProfile").TasteProfile)().read(),
    historySnapshot: { entries: history.uniqueEntries(), settings: Object.fromEntries(["recentWindowMs", "artistRecentWindowMs", "labelRecentWindowMs", "sourceRecentWindowMs"].map(key => [key, history[key]])) },
    labelsUsedForSelection: false, heldOutValidation: false, productionApplied: false, predeclarationSha256: sha(Buffer.from(JSON.stringify(declaration, null, 2) + "\n")) };
  collector.validateVerifiedCollectorRequest(request); const code = pins();
  save(ownedPath(path.join(DIRECTORY, "predeclaration.json")), declaration); save(ownedPath(path.join(DIRECTORY, "request.json")), request);
  save(ownedPath(path.join(DIRECTORY, "collection-code-receipt.json")), code);
  console.log(JSON.stringify({ initialized: true, sourceCap: 16, encoder: "mert-30s", maximumBlindPairs: 12, excludedHeldouts: 6, sourceAttempts: 160 }));
}
function checkDeclaration() {
  baseline(); const declaration = read(ownedPath(path.join(DIRECTORY, "predeclaration.json"))), request = read(ownedPath(path.join(DIRECTORY, "request.json")));
  assert.equal(request.predeclarationSha256, binding("predeclaration.json").sha256); collector.validateVerifiedCollectorRequest(request);
  assert.deepEqual(declaration.recipe, collector.VERIFIED_COLLECTOR_RECIPE); assert.deepEqual(pins(), read(ownedPath(path.join(DIRECTORY, "collection-code-receipt.json"))));
  assert.equal(declaration.maximumModelRuns, 16); assert.equal(declaration.maximumBlindPairs, 12); assert.equal(declaration.productionApplied, false);
  return { declaration, request };
}
function provider() {
  const config = require("../src/config"), quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} };
  const beatport = new (require("../src/beatportClient").BeatportClient)({ ...config.beatport, logger: quiet, maxSearchPages: 1, maxSearchQueries: 1 });
  beatport.maxRetries = 0; beatport.getCachedJson = () => null; return { config, beatport };
}
function safeBeatportTransport(beatport, ledger, persist) {
  const original = beatport.fetchImpl.bind(beatport), base = new URL(beatport.baseUrl).origin;
  beatport.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url)), kind = parsed.pathname.includes("/auth/o/token/") ? "authentication" : parsed.origin === base ? "catalogue" : "preview";
    assert.ok((ledger.priorTransportCalls || 0) + ledger.transport.length < 200, "Declared Beatport transport budget exhausted.");
    if (kind === "authentication") { assert.ok(ledger.refreshAttempts < 1, "Declared normal refresh budget exhausted."); ledger.refreshAttempts++; }
    if (kind === "preview") { assert.ok((ledger.previewCalls || 0) < 160, "Declared preview transport budget exhausted."); ledger.previewCalls = (ledger.previewCalls || 0) + 1; }
    const entry = { kind, method: String(options.method || "GET"), status: "started", at: new Date().toISOString() }; ledger.transport.push(entry); persist(); const began = performance.now();
    try { const response = await original(url, options); entry.status = response?.status || "no-response"; return response; }
    catch { entry.status = "transport-error"; throw Error("Beatport transport unavailable; safe evidence preserved."); }
    finally { entry.elapsedMs = performance.now() - began; persist(); }
  };
}
async function authenticate() {
  checkDeclaration(); guard("before-authentication"); const file = ownedPath(path.join(DIRECTORY, "authentication.json"));
  assert.ok(!fs.existsSync(file), "No repeat authentication declaration."); const { beatport } = provider(), before = beatport.store.read();
  const ledger = { version: 1, at: new Date().toISOString(), status: "started", refreshAttempts: 0, priorTransportCalls: 0, transport: [],
    before: { configured: beatport.isConfigured(), accessTokenStored: Boolean(before.accessToken), refreshTokenStored: Boolean(before.refreshToken), clientIdConfigured: Boolean(beatport.clientId), expired: Boolean(before.expiresAtMs && before.expiresAtMs <= Date.now()) } };
  save(file, ledger); safeBeatportTransport(beatport, ledger, () => update(file, ledger));
  try {
    const token = await beatport.getAccessToken(), after = beatport.store.read(); ledger.usable = Boolean(token && after.expiresAtMs > Date.now() + 60000);
    ledger.after = { accessTokenStored: Boolean(after.accessToken), refreshTokenStored: Boolean(after.refreshToken), expiresAt: after.expiresAtMs ? new Date(after.expiresAtMs).toISOString() : "", normalStoreChanged: sha(fs.readFileSync(beatport.store.file)) !== baseline().files["data/beatport-token.json"] };
    ledger.status = ledger.usable ? "ready-for-catalogue" : "authentication-unavailable";
  } catch { ledger.status = "authentication-unavailable"; ledger.usable = false; }
  checkDeclaration(); update(file, ledger); console.log(JSON.stringify({ stage: "authentication", status: ledger.status, usable: ledger.usable, refreshAttempts: ledger.refreshAttempts, httpStatuses: ledger.transport.map(row => row.status) }));
}
function probe(file) {
  ownedPath(file); const { wslPath } = require("../src/sonicAnalysisWorker");
  const duration = Number(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" }).trim());
  assert.ok(duration >= 30 && duration <= 7200); return duration;
}
async function collect() {
  const { request } = checkDeclaration(), auth = read(ownedPath(path.join(DIRECTORY, "authentication.json"))); assert.equal(auth.usable, true, "Normal Beatport authentication is unavailable.");
  const file = ownedPath(path.join(DIRECTORY, "collection.json")), metricFile = ownedPath(path.join(DIRECTORY, "collection-transport.json"));
  assert.ok(!fs.existsSync(file) && !fs.existsSync(metricFile), "Do not retry a started or closed collection."); guard("before-collection");
  const { config, beatport } = provider(), ledger = { version: 1, refreshAttempts: auth.refreshAttempts, priorTransportCalls: auth.transport.length, transport: [], tidalTransport: [] };
  save(metricFile, ledger); safeBeatportTransport(beatport, ledger, () => update(metricFile, ledger));
  const beatportFacade = { pagedTracks: async (...args) => {
    const before = ledger.transport.length, response = await beatport.pagedTracks(...args);
    assert.equal(response.pages?.length, 1);
    assert.ok(ledger.transport.slice(before).some(row => row.kind === "catalogue" && row.status === 200), "Catalogue listings require a real successful transport."); return response;
  }, fetchPreviewBuffer: (...args) => beatport.fetchPreviewBuffer(...args) };
  const tidal = configureTidalNoRetry(new (require("../src/tidalVerifier").TidalVerifier)({ ...config.tidal, catalogPaginationFile: path.join(DIRECTORY, "tidal-pagination.json") })); assert.ok(tidal.isConfigured());
  const detail = tidal.withDetailYear.bind(tidal), responseFn = tidal.fetchTidalResponse.bind(tidal); let searchOnly = false, apiCount = 0, authCount = 0;
  tidal.withDetailYear = async value => searchOnly ? value : detail(value);
  tidal.fetchTidalResponse = async (url, options, label) => {
    const route = new URL(url).pathname, kind = route.includes("searchResults") ? "search" : /^\/v2\//.test(route) ? "detail" : "authentication";
    if (kind === "authentication") assert.ok(++authCount <= 12); else assert.ok(++apiCount <= 1600);
    const row = { kind, status: "started" }; ledger.tidalTransport.push(row); update(metricFile, ledger); const began = performance.now();
    try { const response = await responseFn(url, options, label); row.status = response.status; return response; }
    catch { row.status = "transport-error"; throw Error("TIDAL transport unavailable; safe evidence preserved."); }
    finally { row.elapsedMs = performance.now() - began; update(metricFile, ledger); }
  };
  const tidalFacade = { searchTracks: async (...args) => { assert.equal(searchOnly, false); searchOnly = true; try { return await tidal.searchTracks(...args); } finally { searchOnly = false; } }, getTrack: (...args) => tidal.getTrack(...args) };
  let lastCount = 0, lastAttemptNotice = 0; const began = performance.now();
  const result = await collector.collectSonicCatalogVerifiedPool({ request, requestSha256: binding("request.json").sha256, beatport: beatportFacade, tidal: tidalFacade,
    saveAudio: async (bytes, { sourceSha256 }) => { assert.equal(sha(bytes), sourceSha256); const target = ownedPath(path.join(DIRECTORY, "audio", sourceSha256 + ".audio")); if (fs.existsSync(target)) assert.equal(sha(fs.readFileSync(target)), sourceSha256); else fs.writeFileSync(target, bytes, { flag: "wx" }); return target; }, probeDuration: probe,
    persistProgress: async value => { if (fs.existsSync(file)) update(file, value); else save(file, value); if (value.entries.length !== lastCount || value.attempts.length >= lastAttemptNotice + 10) {
      lastCount = value.entries.length; lastAttemptNotice = value.attempts.length; console.log(JSON.stringify({ verifiedSources: lastCount, attempts: value.attempts.length, modelRuns: 0 }));
    } } });
  checkDeclaration(); assert.equal(result.progress.closed, true, "Collection must close before any inference declaration.");
  const fullGate = result.complete === true && result.progress.entries.length === 16 && result.progress.genres.every(genre => genre.anchorIdentityKeys.length === 2 && genre.candidateIdentityKeys.length === 6);
  const receipt = { version: 1, at: new Date().toISOString(), elapsedMs: performance.now() - began, complete: result.complete, fullGate,
    verifiedSources: result.progress.entries.length, strictExactSources: result.progress.entries.filter(entry => entry.source.version === 1).length,
    verifiedOriginalSources: result.progress.entries.filter(entry => entry.source.version === 2).length,
    attempts: result.progress.attempts.length, pages: result.progress.pages.length, genres: result.progress.genres.map(genre => ({ genreId: genre.genreId, anchors: genre.anchorIdentityKeys.length, candidates: genre.candidateIdentityKeys.length })),
    implicitSearchDetailsDisabled: true, localLibraryAudio: false, chartRankingEvidence: false, productionApplied: false };
  save(ownedPath(path.join(DIRECTORY, "coverage-audit.json")), receipt);
  if (fullGate) {
    assert.ok(result.pool); const breadth = collector.validateVerifiedCollectionBreadth(result.progress, { requireComplete: true });
    save(ownedPath(path.join(DIRECTORY, "collection-evidence.json")), { version: 1, kind: "catalog-fresh-combined-evidence", runs: [{ declaration: binding("request.json"), collection: binding("collection.json") }] });
    const pool = { ...result.pool, samplingScope: "two-genre", collectionEvidence: binding("collection-evidence.json") };
    review.validatePool(pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(pool, request); save(ownedPath(path.join(DIRECTORY, "pool.json")), pool);
    save(ownedPath(path.join(DIRECTORY, "breadth-audit.json")), { version: 1, passed: true, at: new Date().toISOString(), samplingScope: "two-genre", verifiedSources: 16, anchors: 4,
      request: binding("request.json"), collection: binding("collection.json"), pool: binding("pool.json"), collectionEvidence: binding("collection-evidence.json"),
      validation: breadth ?? true, genres: receipt.genres, breadth: result.progress.breadth, localLibraryAudio: false, labelsUsedForSelection: false, productionApplied: false });
    checkCollection();
  }
  console.log(JSON.stringify(receipt));
}
function checkCollection() {
  const { request } = checkDeclaration(), collection = read(ownedPath(path.join(DIRECTORY, "collection.json"))), coverage = read(ownedPath(path.join(DIRECTORY, "coverage-audit.json"))),
    breadthAudit = read(ownedPath(path.join(DIRECTORY, "breadth-audit.json"))), pool = read(ownedPath(path.join(DIRECTORY, "pool.json")));
  assert.equal(coverage.fullGate, true); assert.equal(collection.closed, true); assert.equal(collection.requestSha256, binding("request.json").sha256);
  assert.equal(breadthAudit.passed, true); assert.equal(breadthAudit.productionApplied, false); assert.equal(breadthAudit.verifiedSources, 16);
  for (const key of ["request", "collection", "pool", "collectionEvidence"]) assert.deepEqual(breadthAudit[key], binding({ request: "request.json", collection: "collection.json", pool: "pool.json", collectionEvidence: "collection-evidence.json" }[key]));
  collector.validateVerifiedCollectionBreadth(collection, { requireComplete: true }); assert.deepEqual(breadthAudit.breadth, collection.breadth);
  assert.equal(coverage.verifiedSources, collection.entries.length);
  assert.equal(coverage.strictExactSources, collection.entries.filter(entry => entry.source.version === 1).length);
  assert.equal(coverage.verifiedOriginalSources, collection.entries.filter(entry => entry.source.version === 2).length);
  assert.equal(coverage.attempts, collection.attempts.length); assert.equal(coverage.pages, collection.pages.length);
  assert.deepEqual(coverage.genres, collection.genres.map(genre => ({ genreId: genre.genreId, anchors: genre.anchorIdentityKeys.length, candidates: genre.candidateIdentityKeys.length })));
  review.validatePool(pool, { artifactRoot: ROOT, requireBytes: true }); review.validateExclusions(pool, request);
  return { pool, request, collection, breadthAudit };
}
async function main(argv = process.argv.slice(2)) {
  const [stage] = argv; assert.ok(argv.length === 1 && ["init", "auth", "collect"].includes(stage)); baseline();
  const file = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID(); save(file, { token, pid: process.pid, stage: "verified-" + stage, directory: DIRECTORY, at: new Date().toISOString() });
  try { if (stage === "init") return initialize(); if (stage === "auth") return await authenticate(); return await collect(); }
  finally { assert.equal(read(file).token, token); fs.unlinkSync(file); }
}
if (require.main === module) main().catch(() => { console.error("Verified catalogue stage failed; private safe evidence retained, no automatic retry."); process.exitCode = 1; });
module.exports = { main, initialize, authenticate, collect, checkDeclaration, checkCollection, exclusionsFrom, safeBeatportTransport,
  ownedPath, pins, guard, withDb, DIRECTORY, ROOT, sha, read, save, update };
