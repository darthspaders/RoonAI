"use strict";

// A separately declared fresh catalogue run. No server imports or runtime writes
// beyond normal provider authentication; review publication is a separate gate.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto"), { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite"), { performance } = require("node:perf_hooks");
const ROOT = path.resolve(__dirname, ".."), DIRECTORY = path.join(ROOT, "data/sonic-catalog-scout-fresh-30s-20261008");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function update(file, value) { const temporary = file + "." + randomUUID() + ".tmp"; save(temporary, value); fs.renameSync(temporary, file); }
function ownedPath(file) {
  const root = fs.realpathSync(DIRECTORY), absolute = path.resolve(file), relative = path.relative(root, absolute);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  let current = root;
  for (const piece of relative.split(path.sep)) { current = path.join(current, piece); if (fs.existsSync(current)) assert.ok(!fs.lstatSync(current).isSymbolicLink() && !path.relative(root, fs.realpathSync(current)).startsWith("..")); }
  return absolute;
}
function withDb(callback) {
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: true });
  db.exec("PRAGMA query_only=ON;BEGIN"); try { return callback(db); } finally { db.exec("ROLLBACK"); db.close(); }
}
function pins() {
  const old = read(path.join(ROOT, "data/sonic-catalog-scout-operational-20261008/collection-code-receipt.json"));
  for (const row of old.files) assert.equal(sha(fs.readFileSync(path.join(ROOT, row.path))), row.sha256, "Prior code pin changed: " + row.path);
  return { files: [...old.files, { path: "scripts/sonic-catalog-scout-fresh.js", sha256: sha(fs.readFileSync(__filename)) }] };
}
function guard(label) {
  const result = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, "data/sonic-catalog-scout-state-20261008.cjs"), "guard"], { windowsHide: true, timeout: 25000, encoding: "utf8" }));
  assert.equal(result.guardPassed, true);
  save(ownedPath(path.join(DIRECTORY, "guards", label + "-" + Date.now() + ".json")), result);
  return result;
}
function initialize() {
  const { COVERAGE_PROBE_RECIPE, COVERAGE_PROBE_REQUESTS } = require("../src/sonicCatalogScoutCoverageProbe"), { analysisSpec } = require("../src/sonicAnalysisSpec");
  const declaration = {
    version: 1, createdAt: new Date().toISOString(), purpose: "Fresh Bass House and raw techno catalogue candidate-fit review",
    recipe: COVERAGE_PROBE_RECIPE, models: [analysisSpec("mert-30s")], maximumModelRuns: 16, maximumBlindPairs: 12,
    completionGate: { exactSources: 16, freshAnchors: 4, sharedCandidatesPerGenre: 6, actualBeatportGenreIds: ["91", "92"] },
    authentication: { normalTokenStore: true, normalClientId: true, maximumBeatportRefreshAttempts: 1, maximumBeatportTransportRetries: 0, safeHttpStatusReceipt: true },
    maximumTidalApiTransportCalls: 1728, maximumTidalAuthenticationCalls: 12,
    exclusions: "All prior Beatport attempts, prior review recordings and source hashes, and six reserved heldouts",
    localLibraryAudio: false, labelsUsedForSelection: false, hardGenreConstraints: false, retriesOfFailedPriorRuns: false,
    productionApplied: false, playbackInvoked: false, queueInvoked: false, maximumReviewSessions: 4
  };
  save(path.join(DIRECTORY, "predeclaration.json"), declaration);
  const prior = withDb(db => db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch").all().map(row => JSON.parse(row.private_plan_json)));
  const priorAttempts = read(path.join(ROOT, "data/sonic-catalog-scout-catalog-v4-20261008/collection.json")).attempts;
  const original = read(path.join(ROOT, "data/sonic-anchor-experiment-20261007/plan.json")), heldOut = original.heldOut;
  assert.equal(heldOut.length, 6);
  const heldOutHashes = heldOut.map(track => { const matches = original.originalManifest.items.filter(item => item.track.identityKey === track.identityKey); assert.equal(matches.length, 1); const hash = matches[0].track.analysisLocal?.sha256; assert.match(hash, /^[a-f0-9]{64}$/); return hash; });
  const history = new (require("../src/discoveryHistory").DiscoveryHistory)();
  const request = {
    version: 1, createdAt: new Date().toISOString(), recipe: { ...COVERAGE_PROBE_RECIPE, models: [analysisSpec("mert-30s")], scoringYear: new Date().getFullYear() },
    requests: JSON.parse(JSON.stringify(COVERAGE_PROBE_REQUESTS)),
    excludedBeatportTrackIds: [...new Set(priorAttempts.map(row => String(row.beatportTrackId)))],
    excluded: prior.flatMap(plan => plan.groups.flatMap(group => [group.anchor, ...group.candidates.map(candidate => candidate.track)])), heldOut,
    excludedSourceSha256: [...new Set([...heldOutHashes, ...prior.flatMap(plan => Object.values(plan.clips).map(clip => clip.sourceSha256))])],
    tasteSnapshot: new (require("../src/tasteProfile").TasteProfile)().read(),
    historySnapshot: { entries: history.uniqueEntries(), settings: Object.fromEntries(["recentWindowMs", "artistRecentWindowMs", "labelRecentWindowMs", "sourceRecentWindowMs"].map(key => [key, history[key]])) },
    labelsUsedForSelection: false, heldOutValidation: false, productionApplied: false,
    predeclarationSha256: sha(fs.readFileSync(path.join(DIRECTORY, "predeclaration.json")))
  };
  save(path.join(DIRECTORY, "request.json"), request); save(path.join(DIRECTORY, "collection-code-receipt.json"), pins());
  console.log(JSON.stringify({ initialized: true, sourceCap: 16, encoder: "mert-30s", maximumBlindPairs: 12, excludedHeldouts: 6 }));
}
function provider() {
  const config = require("../src/config"), quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} };
  const beatport = new (require("../src/beatportClient").BeatportClient)({ ...config.beatport, logger: quiet, maxSearchPages: 1, maxSearchQueries: 1 });
  beatport.maxRetries = 0; // Constructor's Number(0)||DEFAULT otherwise retains retries.
  return { config, beatport };
}
function safeBeatportTransport(beatport, ledger, persist) {
  const original = beatport.requestRaw.bind(beatport);
  beatport.requestRaw = async (url, options, settings) => {
    const kind = new URL(url).pathname.includes("/auth/o/token/") ? "authentication" : "catalogue";
    if (kind === "authentication") { assert.ok(ledger.refreshAttempts < 1, "Declared Beatport refresh budget exhausted"); ledger.refreshAttempts++; }
    assert.ok(ledger.transport.length < 110, "Declared Beatport transport budget exhausted");
    const entry = { kind, method: String(options?.method || "GET"), status: "started", at: new Date().toISOString() };
    ledger.transport.push(entry); persist(); const began = performance.now();
    try { const response = await original(url, options, settings); entry.status = response?.status || "no-response"; entry.cached = Boolean(response?.cached); return response; }
    catch { entry.status = "transport-error"; throw Error("Beatport transport failed; safe receipt preserved."); }
    finally { entry.elapsedMs = performance.now() - began; persist(); }
  };
}
async function authenticate() {
  assert.ok(fs.existsSync(path.join(DIRECTORY, "preservation-before.json")), "Capture preservation baseline before authentication");
  assert.deepEqual(pins(), read(path.join(DIRECTORY, "collection-code-receipt.json"))); guard("before-authentication");
  const file = path.join(DIRECTORY, "authentication.json"), { beatport } = provider(), before = beatport.store.read();
  const ledger = { version: 1, at: new Date().toISOString(), status: "started", refreshAttempts: 0, transport: [], before: { configured: beatport.isConfigured(), accessTokenStored: Boolean(before.accessToken), refreshTokenStored: Boolean(before.refreshToken), clientIdConfigured: Boolean(beatport.clientId), expired: Boolean(before.expiresAtMs && before.expiresAtMs <= Date.now()) } };
  save(file, ledger); safeBeatportTransport(beatport, ledger, () => update(file, ledger));
  try {
    const token = await beatport.getAccessToken(), after = beatport.store.read();
    ledger.usable = Boolean(token && after.expiresAtMs > Date.now() + 60000);
    ledger.after = { accessTokenStored: Boolean(after.accessToken), refreshTokenStored: Boolean(after.refreshToken), expiresAt: after.expiresAtMs ? new Date(after.expiresAtMs).toISOString() : "", normalStoreChanged: sha(fs.readFileSync(beatport.store.file)) !== read(path.join(DIRECTORY, "preservation-before.json")).files["data/beatport-token.json"] };
    ledger.status = ledger.usable ? "ready-for-catalogue" : "authentication-unavailable";
  } catch { ledger.status = "authentication-unavailable"; ledger.usable = false; }
  update(file, ledger); console.log(JSON.stringify({ stage: "authentication", status: ledger.status, usable: ledger.usable, refreshAttempts: ledger.refreshAttempts, httpStatuses: ledger.transport.map(entry => entry.status) }));
}
function probe(file) {
  ownedPath(file); const { wslPath } = require("../src/sonicAnalysisWorker");
  const duration = Number(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" }).trim());
  assert.ok(duration >= 30 && duration <= 7200); return duration;
}
async function collect() {
  const auth = read(path.join(DIRECTORY, "authentication.json")); assert.equal(auth.usable, true, "Normal Beatport authentication is unavailable; reconnect before a new declaration");
  const file = path.join(DIRECTORY, "collection.json"), requestFile = path.join(DIRECTORY, "request.json"), request = read(requestFile);
  assert.ok(!fs.existsSync(file), "This declaration cannot retry an earlier collection");
  assert.deepEqual(pins(), read(path.join(DIRECTORY, "collection-code-receipt.json"))); guard("before-collection");
  const { config, beatport } = provider(), metricFile = path.join(DIRECTORY, "collection-transport.json"), ledger = { version: 1, refreshAttempts: auth.refreshAttempts, transport: [], tidalTransport: [] };
  save(metricFile, ledger); safeBeatportTransport(beatport, ledger, () => update(metricFile, ledger));
  // Each page must have a successful real transport receipt; an empty wrapper
  // result with zero fetched pages cannot be called an empty catalogue.
  const beatportFacade = {
    getTrackFeed: async (...args) => { const response = await beatport.getTrackFeed(...args); assert.equal(response.pagination?.pageCount, 1, "Beatport feed unavailable"); assert.equal(response.pagination?.pages?.length, 1, "Beatport feed has no real page"); return response; },
    fetchPreviewBuffer: (...args) => beatport.fetchPreviewBuffer(...args)
  };
  const tidal = new (require("../src/tidalVerifier").TidalVerifier)({ ...config.tidal, catalogPaginationFile: path.join(DIRECTORY, "tidal-pagination.json") }); assert.ok(tidal.isConfigured());
  const originalDetail = tidal.withDetailYear.bind(tidal); let searchOnly = false, apiCount = 0, authCount = 0;
  tidal.withDetailYear = async result => searchOnly ? result : originalDetail(result);
  const responseFn = tidal.fetchTidalResponse.bind(tidal);
  tidal.fetchTidalResponse = async (url, options, label) => {
    const route = new URL(url).pathname, kind = route.includes("searchResults") ? "search" : /^\/v2\/tracks\//.test(route) ? "detail" : "authentication";
    if (kind === "authentication") assert.ok(++authCount <= 12); else assert.ok(++apiCount <= 1728);
    const entry = { kind, status: "started" }; ledger.tidalTransport.push(entry); update(metricFile, ledger); const began = performance.now();
    try { const response = await responseFn(url, options, label); entry.status = response.status; return response; }
    catch { entry.status = "transport-error"; throw Error("TIDAL transport unavailable; safe receipt preserved."); }
    finally { entry.elapsedMs = performance.now() - began; update(metricFile, ledger); }
  };
  const facade = { searchTracks: async (...args) => { assert.equal(searchOnly, false); searchOnly = true; try { return await tidal.searchTracks(...args); } finally { searchOnly = false; } }, getTrack: (...args) => tidal.getTrack(...args) };
  let lastCount = 0; const began = performance.now();
  const result = await require("../src/sonicCatalogScoutCoverageProbe").collectSonicCatalogScoutCoverageProbe({ request, requestSha256: sha(fs.readFileSync(requestFile)), beatport: beatportFacade, tidal: facade,
    saveAudio: async (bytes, { sourceSha256: hash }) => { assert.equal(sha(bytes), hash); const target = ownedPath(path.join(DIRECTORY, "audio", hash + ".audio")); if (fs.existsSync(target)) assert.equal(sha(fs.readFileSync(target)), hash); else fs.writeFileSync(target, bytes, { flag: "wx" }); return target; }, probeDuration: probe,
    persistProgress: async value => { if (fs.existsSync(file)) update(file, value); else save(file, value); if (value.entries.length !== lastCount) { lastCount = value.entries.length; console.log(JSON.stringify({ exactSources: lastCount, attempts: value.attempts.length, modelRuns: 0 })); } }
  });
  assert.deepEqual(pins(), read(path.join(DIRECTORY, "collection-code-receipt.json")));
  if (result.pool) save(path.join(DIRECTORY, "pool.json"), result.pool);
  const fullGate = result.complete === true && result.progress.entries.length === 16 && result.progress.genres.every(genre => genre.anchorIdentityKeys.length === 2 && genre.candidateIdentityKeys.length === 6);
  const receipt = { at: new Date().toISOString(), elapsedMs: performance.now() - began, complete: result.complete, fullGate, exactSources: result.progress.entries.length, attempts: result.progress.attempts.length, pages: result.progress.pages.length, genres: result.progress.genres.map(genre => ({ genreId: genre.genreId, anchors: genre.anchorIdentityKeys.length, candidates: genre.candidateIdentityKeys.length })), implicitSearchDetailsDisabled: true, productionApplied: false };
  save(path.join(DIRECTORY, "coverage-audit.json"), receipt); console.log(JSON.stringify(receipt));
}
async function main(argv = process.argv.slice(2)) {
  const [stage] = argv; assert.ok(argv.length === 1 && ["init", "auth", "collect"].includes(stage));
  const file = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID(); save(file, { token, pid: process.pid, stage, directory: DIRECTORY, createdAt: new Date().toISOString() });
  try { if (stage === "init") return initialize(); if (stage === "auth") return await authenticate(); return await collect(); }
  finally { assert.equal(read(file).token, token); fs.unlinkSync(file); }
}
if (require.main === module) main().catch(() => { console.error("Fresh catalogue stage failed; inspect private safe receipts. No automatic retry."); process.exitCode = 1; });
module.exports = { main, ownedPath, pins, guard, withDb, DIRECTORY, ROOT, sha, read, save, update };
