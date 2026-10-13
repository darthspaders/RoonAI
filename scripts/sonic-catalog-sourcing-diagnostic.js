"use strict";
// New metadata/identity diagnostic only. Never downloads audio, encodes models,
// publishes reviews, queues tracks or changes production ranking.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const diverse = require("./sonic-catalog-scout-diverse");
const { normalizeBeatportTrack } = require("../src/beatportClient"), { canonicalTrack } = require("../src/sonicCatalogScoutCollector");
const { coarseCandidateReason } = require("../src/sonicCatalogScoutCoverageProbe");
const { scoreTidalIdentity } = require("../src/exactTrackVerification"), { matchBeatportVersionToTidal } = require("../src/beatportVersionMatch");
const { normalizeCatalogText, artistCreditSetKey, parseCanonicalCatalogIdentity } = require("../src/catalogIdentityNormalization");
const { recordingGroup } = require("../src/sonicAnalysisPilot");
const ROOT = path.resolve(__dirname, ".."), DIRECTORY = path.join(ROOT, "data/sonic-catalog-sourcing-diagnostic-20261008");
const SCRIPT = "scripts/sonic-catalog-sourcing-diagnostic.js", clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash("sha256").update(value).digest("hex"), read = file => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function update(file, value) { const temporary = file + "." + randomUUID() + ".tmp"; save(temporary, value); fs.renameSync(temporary, file); }
const text = value => typeof value === "string" ? value.trim() : "", id = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const GENRES = [{ genreId: "91", genreName: "Bass House" }, { genreId: "92", genreName: "Techno (Raw / Deep / Hypnotic)" }];
const DIAGNOSTIC_RECIPE = Object.freeze({ kind: "genuine-dj-chart-identity-diagnostic", genreIds: Object.freeze(["91", "92"]), chartListingCalls: 2,
  chartsPerGenre: 2, chartListingPage: 1, chartListingPerPage: 6, chartTrackCalls: 4, chartTrackPage: 1, chartTrackPerPage: 50, chartTrackMaxPages: 1,
  maximumIdentityAttempts: 16, maximumIdentityAttemptsPerGenre: 8, maxTidalQueriesPerSource: 3, maxTidalResultsPerQuery: 20, maxTidalDetailsPerSource: 3,
  maximumBeatportTransportCalls: 8, maximumBeatportRefreshAttempts: 1, maximumTidalApiTransportCalls: 120, maximumTidalAuthenticationCalls: 4,
  transportRetries: 0, modelRuns: 0, audioDownloads: 0, reviewPairs: 0, productionApplied: false });
function ownedPath(file) {
  assert.ok(fs.lstatSync(DIRECTORY).isDirectory() && !fs.lstatSync(DIRECTORY).isSymbolicLink());
  const root = fs.realpathSync(DIRECTORY), absolute = path.resolve(file), relative = path.relative(root, absolute);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  let current = root;
  for (const piece of relative.split(path.sep)) { current = path.join(current, piece); if (fs.existsSync(current)) assert.ok(!fs.lstatSync(current).isSymbolicLink() && !path.relative(root, fs.realpathSync(current)).startsWith("..")); }
  return absolute;
}
function baseline() { const record = read(ownedPath(path.join(DIRECTORY, "preservation-before.json"))), snapshot = record.snapshot || record; assert.ok(snapshot.tables && snapshot.files && Object.keys(snapshot.files).length === 15); return snapshot; }
function pins() {
  const files = [...diverse.pins().files, { path: SCRIPT, sha256: sha(fs.readFileSync(__filename)) }];
  return { files: [...new Map(files.map(row => [row.path, row])).values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
function safeTrack(track) { return Object.fromEntries(["identityKey", "tidalId", "artist", "title", "mixVersion", "album", "isrc", "durationMs", "label", "genre", "subgenre", "year", "releaseDate"].filter(key => track[key] !== undefined).map(key => [key, clone(track[key])])); }
function validateRequest(request) {
  assert.equal(request?.version, 1); assert.deepEqual(request.recipe, DIAGNOSTIC_RECIPE);
  assert.ok(Array.isArray(request.excludedBeatportTrackIds) && request.excludedBeatportTrackIds.every(id) && request.excludedBeatportTrackIds.length <= 10000);
  assert.ok(Array.isArray(request.excluded) && request.excluded.length <= 10000 && Array.isArray(request.heldOut) && request.heldOut.length === 6);
  assert.ok([...request.excluded, ...request.heldOut].every(track => text(track.identityKey) && text(track.artist) && text(track.title)));
}
function matcherDiagnostic(requested, canonical, beatport) {
  const coarseReason = coarseCandidateReason(requested, canonical), score = scoreTidalIdentity(requested, canonical);
  const match = matchBeatportVersionToTidal(canonical, beatport, { allowVersionProxy: false, requestedBeatportTrackId: beatport.id });
  const verified = !coarseReason && score.matched && match.matched;
  const classification = verified && match.relation === "exact" ? "strict-exact" : verified && match.relation === "equivalent-recording" ? "verified-equivalent" : "rejected";
  const pick = (input, keys) => Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, clone(input[key])]));
  return { classification, coarseReason, canonicalTrack: safeTrack(canonical),
    tidal: pick(score, ["matched", "outcome", "rejectionReason", "reasons", "normalizedBaseTitleMatch", "fullTitleMatch", "isrcMatch", "durationDeltaMs", "albumFamilyAgreement", "labelAgreement", "releaseDateAgreement", "strongIdentityOverrideApplied", "canonicalMainMixApplied"]),
    beatport: { matched: match.matched, relation: match.relation, reasons: clone(match.reasons || []), diagnostics: pick(match.diagnostics || {}, ["artistMatch", "titleMatch", "isrcMatch", "durationDeltaMs", "canonicalVersionMatch", "exactRemixIdentity", "originalMixNormalizationApplied", "albumFamilyAgreement", "strongIdentityOverrideApplied", "beatportTrackIdMatch", "canonicalVersionRelation", "tidalDescriptor", "beatportDescriptor"]) },
    sourceCorpusEligible: classification === "strict-exact", diagnosticOnly: true, productionApplied: false };
}
function configureTidalNoRetry(tidal) {
  const json = tidal.fetchTidalJson.bind(tidal), fetch = tidal.fetchImpl.bind(tidal);
  // The normal JSON helper retries 429/401. Its transport also retries DNS and
  // falls back to node HTTP for DNS-coded errors. This instance does neither.
  tidal.fetchTidalJson = url => json(url, 2);
  tidal.fetchImpl = async (...args) => { try { return await fetch(...args); } catch { throw Error("TIDAL diagnostic transport unavailable."); } };
  return tidal;
}
function freezeRow(input, genre, cutoffDate) {
  const raw = input?.rawJson, actualGenre = raw?.genre || raw?.attributes?.genre; assert.ok(raw && String(actualGenre?.id) === genre.genreId && normalizeCatalogText(actualGenre?.name) === normalizeCatalogText(genre.genreName));
  const normalized = normalizeBeatportTrack(raw); assert.ok(id(normalized.id) && String(input.id) === normalized.id && normalized.genre === genre.genreName);
  const attributes = { ...(raw.attributes || {}), ...raw }; assert.ok([attributes.id, attributes.track_id, input.beatportTrackId].filter(value => value !== undefined && value !== "").every(value => String(value) === normalized.id));
  assert.equal(artistCreditSetKey(input.artist), artistCreditSetKey(normalized.artist));
  assert.ok(id(normalized.releaseId) && text(normalized.album) && text(normalized.artist) && text(normalized.title) && normalized.artistIds.length && normalized.artistIds.every(id) && new Set(normalized.artistIds).size === normalized.artistIds.length);
  const date = text(normalized.releaseDate).slice(0, 10); assert.match(date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date && date <= cutoffDate);
  const row = { id: normalized.id, artist: normalized.artist, title: normalized.title, genreId: genre.genreId, genre: normalized.genre, releaseId: normalized.releaseId, album: normalized.album, artistIds: clone(normalized.artistIds), releaseDate: date };
  for (const key of ["mixName", "isrc", "label", "durationMs"]) if (normalized[key] !== undefined && normalized[key] !== null && normalized[key] !== "") row[key] = clone(normalized[key]);
  row.catalogRecordKey = sha(JSON.stringify(row)); return row;
}
function orderedRows(pages, exclusions) {
  const records = new Map(), conflicts = new Set();
  for (const page of pages) for (const row of page.rows) { const previous = records.get(row.id); if (previous && previous.row.catalogRecordKey !== row.catalogRecordKey) conflicts.add(row.id); else if (!previous) records.set(row.id, { row, pageKey: page.pageKey }); }
  const releases = new Map();
  for (const item of records.values()) if (!conflicts.has(item.row.id) && !exclusions.includes(item.row.id)) { if (!releases.has(item.row.releaseId)) releases.set(item.row.releaseId, []); releases.get(item.row.releaseId).push(item); }
  const groups = [...releases].sort(([a], [b]) => numeric(a, b)).map(([, rows]) => rows.sort((a, b) => numeric(a.row.id, b.row.id))), result = [];
  for (let i = 0; groups.some(rows => rows[i]); i++) for (const rows of groups) if (rows[i]) result.push(rows[i]);
  return result;
}
function sameRecording(left, right) { return left.identityKey === right.identityKey || recordingGroup(left) === recordingGroup(right) || artistCreditSetKey(left.artist) === artistCreditSetKey(right.artist) && parseCanonicalCatalogIdentity(left).normalizedBaseTitle === parseCanonicalCatalogIdentity(right).normalizedBaseTitle || left.isrc && right.isrc && normalizeCatalogText(left.isrc) === normalizeCatalogText(right.isrc); }
async function collectSourcingDiagnostic({ request, requestSha256, beatport, tidal, persistProgress, now = () => new Date().toISOString() } = {}) {
  validateRequest(request); assert.match(requestSha256, /^[a-f0-9]{64}$/);
  for (const fn of [beatport?.getCharts, beatport?.pagedTracks, tidal?.searchTracks, tidal?.getTrack, persistProgress, now]) assert.equal(typeof fn, "function");
  const progress = { version: 1, kind: DIAGNOSTIC_RECIPE.kind, requestSha256, cutoffDate: now().slice(0, 10), chartListings: [], pages: [], attempts: [], modelRuns: 0, audioDownloads: 0, reviewPairs: 0, productionApplied: false };
  const mark = () => persistProgress(clone(progress));
  for (const genre of GENRES) {
    const listing = { ...genre, page: 1, perPage: 6, source: "genre-dj-charts", status: "started", charts: [] }; progress.chartListings.push(listing); await mark(); let response;
    try { response = await beatport.getCharts({ source: "genre", genreId: genre.genreId, page: 1, perPage: 6 }); assert.ok(Array.isArray(response?.charts)); }
    catch { listing.status = "unavailable"; listing.reason = "chart-listing-unavailable"; await mark(); continue; }
    const rows = new Map(); for (const chart of response.charts.slice(0, 6)) { const chartId = String(chart?.id || ""); if (id(chartId) && text(chart.title) && !rows.has(chartId)) rows.set(chartId, { id: chartId, title: text(chart.title), kind: "dj-chart" }); }
    listing.charts = [...rows.values()].sort((a, b) => numeric(a.id, b.id)).slice(0, 2); listing.status = "ready"; await mark();
  }
  for (const listing of progress.chartListings) for (const chart of listing.charts) {
    const page = { genreId: listing.genreId, genreName: listing.genreName, chartId: chart.id, chartTitle: chart.title, pageKey: listing.genreId + ":chart:" + chart.id, page: 1, perPage: 50, maxPages: 1, status: "started", rows: [], rejected: {} };
    progress.pages.push(page); await mark(); let response;
    try { response = await beatport.pagedTracks("/catalog/charts/" + chart.id + "/tracks/", { page: 1, perPage: 50, maxPages: 1 }); assert.ok(Array.isArray(response?.tracks)); }
    catch { page.status = "unavailable"; page.reason = "chart-tracks-unavailable"; await mark(); continue; }
    const rows = new Map(), conflicts = new Set();
    for (const input of response.tracks.slice(0, 50)) {
      try { const row = freezeRow(input, listing, progress.cutoffDate), old = rows.get(row.id); if (old && old.catalogRecordKey !== row.catalogRecordKey) conflicts.add(row.id); else if (!old) rows.set(row.id, row); }
      catch { page.rejected["invalid-wrong-genre-or-unreleased"] = (page.rejected["invalid-wrong-genre-or-unreleased"] || 0) + 1; }
    }
    page.conflictingTrackIds = [...conflicts].sort(numeric); for (const conflictingId of conflicts) rows.delete(conflictingId);
    page.rows = [...rows.values()].sort((a, b) => numeric(a.id, b.id)); page.status = "ready"; await mark();
  }
  progress.metadataGate = progress.chartListings.length === 2 && progress.chartListings.every(listing => listing.status === "ready" && listing.charts.length === 2) && progress.pages.length === 4 && progress.pages.every(page => page.status === "ready"); await mark();
  for (const genre of GENRES) {
    const pages = progress.pages.filter(page => page.genreId === genre.genreId && page.status === "ready"), conflicts = new Set(pages.flatMap(page => page.conflictingTrackIds || []));
    for (const { row, pageKey } of orderedRows(pages, request.excludedBeatportTrackIds)) {
      if (progress.attempts.length === 16 || progress.attempts.filter(attempt => attempt.genreId === genre.genreId).length === 8) break;
      if (conflicts.has(row.id) || progress.attempts.some(attempt => attempt.beatportTrackId === row.id)) continue;
      const attempt = { beatportTrackId: row.id, genreId: genre.genreId, pageKey, beatportTrack: clone(row), status: "started", tidalQueries: [], canonicalLookups: [] }; progress.attempts.push(attempt); await mark();
      const requested = { artist: row.artist, title: row.title, mixVersion: row.mixName || "", beatportTrackId: row.id, album: row.album, isrc: row.isrc, durationMs: row.durationMs, label: row.label, releaseDate: row.releaseDate };
      const base = parseCanonicalCatalogIdentity(requested).normalizedBaseTitle, queries = [...new Set([[row.artist, row.title, row.mixName], [row.artist, base], [base, row.mixName]].map(parts => parts.filter(Boolean).join(" ")).filter(Boolean))].slice(0, 3), examined = new Set();
      for (const query of queries) {
        if (attempt.canonicalLookups.length === 3) break;
        const search = { query, limit: 20, status: "started", candidateCount: 0, coarseRejections: {} }; attempt.tidalQueries.push(search); await mark(); let results;
        try { results = await tidal.searchTracks(query, { limit: 20, detailLimit: 0, fullPage: false, pageCount: 1, rotateCatalog: false }); assert.ok(Array.isArray(results)); }
        catch { search.status = "unavailable"; search.reason = "tidal-search-unavailable"; await mark(); continue; }
        search.status = "complete"; const candidates = [];
        for (const input of results.slice(0, 20)) { search.candidateCount++; try { const candidate = canonicalTrack(input), reason = coarseCandidateReason(requested, candidate);
          if (reason) { search.coarseRejections[reason] = (search.coarseRejections[reason] || 0) + 1; continue; }
          if (!examined.has(candidate.tidalId)) { examined.add(candidate.tidalId); candidates.push(candidate); }
        } catch { search.coarseRejections["malformed-tidal-identity"] = (search.coarseRejections["malformed-tidal-identity"] || 0) + 1; } }
        await mark(); candidates.sort((a, b) => numeric(a.tidalId, b.tidalId));
        for (const candidate of candidates) {
          if (attempt.canonicalLookups.length === 3) break;
          const lookup = { tidalId: candidate.tidalId, status: "started" }; attempt.canonicalLookups.push(lookup); await mark(); let canonical;
          try { canonical = canonicalTrack(await tidal.getTrack(candidate.tidalId, query)); assert.equal(canonical.tidalId, candidate.tidalId); }
          catch { lookup.status = "unavailable"; lookup.reason = "canonical-detail-unavailable-or-conflicting"; await mark(); continue; }
          if ([...request.excluded, ...request.heldOut].some(old => sameRecording(old, canonical))) { lookup.status = "excluded"; lookup.reason = "exposed-or-heldout-recording"; await mark(); continue; }
          try { lookup.diagnostic = matcherDiagnostic(requested, canonical, row); lookup.status = "classified"; }
          catch { lookup.status = "unavailable"; lookup.reason = "identity-diagnostic-unavailable"; }
          await mark();
        }
      }
      const classes = attempt.canonicalLookups.filter(lookup => lookup.status === "classified").map(lookup => lookup.diagnostic.classification);
      attempt.status = "complete"; attempt.classification = classes.includes("strict-exact") ? "strict-exact" : classes.includes("verified-equivalent") ? "verified-equivalent" : "rejected"; await mark();
    }
  }
  progress.closed = true; progress.summary = { metadataGate: progress.metadataGate, attempts: progress.attempts.length, genres: GENRES.map(genre => ({ genreId: genre.genreId,
    attempts: progress.attempts.filter(attempt => attempt.genreId === genre.genreId).length, classifications: progress.attempts.filter(attempt => attempt.genreId === genre.genreId).reduce((counts, attempt) => (counts[attempt.classification] = (counts[attempt.classification] || 0) + 1, counts), {}) })), modelRuns: 0, audioDownloads: 0, reviewPairs: 0, productionApplied: false };
  await mark(); return progress;
}
function initialize() {
  baseline(); assert.ok(!fs.existsSync(path.join(DIRECTORY, "request.json")));
  const latest = path.join(ROOT, "data/sonic-catalog-scout-diverse-30s-20261008"), previousRequest = read(path.join(latest, "request.json")), collection = read(path.join(latest, "collection.json")); assert.equal(collection.closed, true);
  const db = new DatabaseSync(path.join(ROOT, "data/rabbit-hole-memory.sqlite"), { readOnly: true }); db.exec("PRAGMA query_only=ON;BEGIN"); let plans;
  try { plans = db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch").all().map(row => JSON.parse(row.private_plan_json)); } finally { db.exec("ROLLBACK"); db.close(); }
  const original = read(path.join(ROOT, "data/sonic-anchor-experiment-20261007/plan.json")), exclusions = diverse.exclusionsFrom(plans, [collection], original, [previousRequest]);
  const declaration = { version: 1, at: new Date().toISOString(), purpose: "Genuine DJ-chart sourcing and exact recording identity diagnostic", recipe: DIAGNOSTIC_RECIPE,
    latestRequest: { file: path.join(latest, "request.json"), sha256: sha(fs.readFileSync(path.join(latest, "request.json"))) }, latestCollection: { file: path.join(latest, "collection.json"), sha256: sha(fs.readFileSync(path.join(latest, "collection.json"))) },
    normalAuthentication: true, localLibraryAudio: false, productionPromotionAllowed: false };
  const request = { version: 1, recipe: clone(DIAGNOSTIC_RECIPE), excludedBeatportTrackIds: exclusions.excludedBeatportTrackIds, excluded: exclusions.excluded.map(safeTrack), heldOut: exclusions.heldOut.map(safeTrack),
    excludedSourceSha256: exclusions.excludedSourceSha256, declarationSha256: sha(Buffer.from(JSON.stringify(declaration, null, 2) + "\n")) };
  validateRequest(request); save(ownedPath(path.join(DIRECTORY, "predeclaration.json")), declaration); save(ownedPath(path.join(DIRECTORY, "request.json")), request); save(ownedPath(path.join(DIRECTORY, "code-receipt.json")), pins());
  console.log(JSON.stringify({ initialized: true, excludedBeatportTrackIds: request.excludedBeatportTrackIds.length, maximumIdentityAttempts: 16, modelRuns: 0, audioDownloads: 0 })); return request;
}
function check() {
  baseline(); const request = read(ownedPath(path.join(DIRECTORY, "request.json"))), declaration = read(ownedPath(path.join(DIRECTORY, "predeclaration.json"))); validateRequest(request);
  assert.equal(request.declarationSha256, sha(fs.readFileSync(path.join(DIRECTORY, "predeclaration.json")))); assert.deepEqual(declaration.recipe, DIAGNOSTIC_RECIPE); assert.deepEqual(pins(), read(path.join(DIRECTORY, "code-receipt.json")));
  for (const binding of [declaration.latestRequest, declaration.latestCollection]) assert.equal(sha(fs.readFileSync(binding.file)), binding.sha256);
  return request;
}
async function run() {
  const request = check(), file = ownedPath(path.join(DIRECTORY, "diagnostic.json")), metricFile = ownedPath(path.join(DIRECTORY, "transport.json"));
  assert.ok(!fs.existsSync(file) && !fs.existsSync(metricFile), "Started diagnostics cannot be retried.");
  const config = require("../src/config"), quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} };
  const beatport = new (require("../src/beatportClient").BeatportClient)({ ...config.beatport, logger: quiet }); beatport.maxRetries = 0; beatport.getCachedJson = () => null;
  const ledger = { version: 1, beatport: [], tidal: [], refreshAttempts: 0, tidalApiCalls: 0, tidalAuthenticationCalls: 0 }; save(metricFile, ledger); const persistLedger = () => update(metricFile, ledger), original = beatport.fetchImpl.bind(beatport), base = new URL(beatport.baseUrl).origin;
  beatport.fetchImpl = async (url, options = {}) => { const parsed = new URL(String(url)); assert.equal(parsed.origin, base, "Only declared metadata origin is allowed.");
    const authentication = parsed.pathname.includes("/auth/o/token/"); assert.ok(ledger.beatport.length < 8); if (authentication) assert.ok(++ledger.refreshAttempts <= 1);
    const receipt = { kind: authentication ? "authentication" : "metadata", status: "started" }; ledger.beatport.push(receipt); persistLedger();
    try { const response = await original(url, options); receipt.status = response?.status || "no-response"; return response; } catch { receipt.status = "transport-error"; throw Error("Beatport metadata transport unavailable."); } finally { persistLedger(); } };
  const successful = async callback => { const before = ledger.beatport.length, response = await callback(); assert.ok(ledger.beatport.slice(before).some(receipt => receipt.kind === "metadata" && receipt.status === 200)); return response; };
  const beatportFacade = { getCharts: (...args) => successful(() => beatport.getCharts(...args)), pagedTracks: (...args) => successful(async () => { const response = await beatport.pagedTracks(...args); assert.equal(response.pages?.length, 1); return response; }) };
  const tidal = configureTidalNoRetry(new (require("../src/tidalVerifier").TidalVerifier)({ ...config.tidal, catalogPaginationFile: path.join(DIRECTORY, "tidal-pagination.json") })); assert.ok(tidal.isConfigured());
  const detail = tidal.withDetailYear.bind(tidal), responseFn = tidal.fetchTidalResponse.bind(tidal); let searchOnly = false;
  tidal.withDetailYear = async value => searchOnly ? value : detail(value);
  tidal.fetchTidalResponse = async (url, options, label) => { const route = new URL(url).pathname, kind = route.includes("searchResults") ? "search" : /^\/v2\//.test(route) ? "detail" : "authentication";
    if (kind === "authentication") assert.ok(++ledger.tidalAuthenticationCalls <= 4); else assert.ok(++ledger.tidalApiCalls <= 120);
    const receipt = { kind, status: "started" }; ledger.tidal.push(receipt); persistLedger();
    try { const response = await responseFn(url, options, label); receipt.status = response.status; return response; } catch { receipt.status = "transport-error"; throw Error("TIDAL metadata transport unavailable."); } finally { persistLedger(); } };
  const tidalFacade = { searchTracks: async (...args) => { assert.equal(searchOnly, false); searchOnly = true; try { return await tidal.searchTracks(...args); } finally { searchOnly = false; } }, getTrack: (...args) => tidal.getTrack(...args) };
  let lastNotice = 0;
  const progress = await collectSourcingDiagnostic({ request, requestSha256: sha(fs.readFileSync(path.join(DIRECTORY, "request.json"))), beatport: beatportFacade, tidal: tidalFacade,
    persistProgress: async value => { if (fs.existsSync(file)) update(file, value); else save(file, value); const completed = value.attempts.filter(attempt => attempt.status === "complete").length;
      if (completed >= lastNotice + 4) { lastNotice = completed; console.log(JSON.stringify({ diagnosticAttemptsCompleted: completed, maximumAttempts: 16, modelRuns: 0, audioDownloads: 0 })); } } });
  check(); console.log(JSON.stringify(progress.summary)); return progress;
}
async function main(argv = process.argv.slice(2)) {
  assert.ok(argv.length === 1 && ["init", "run"].includes(argv[0])); baseline();
  const lock = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID(); save(lock, { token, pid: process.pid, stage: "sourcing-diagnostic-" + argv[0], directory: DIRECTORY });
  try { return argv[0] === "init" ? initialize() : await run(); } finally { assert.equal(read(lock).token, token); fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(() => { console.error("Sourcing diagnostic stopped; safe private receipts retained, no automatic retry."); process.exitCode = 1; });
module.exports = { DIAGNOSTIC_RECIPE, collectSourcingDiagnostic, matcherDiagnostic, configureTidalNoRetry, validateRequest, initialize, run, main, DIRECTORY, ROOT, pins };
