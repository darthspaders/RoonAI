"use strict";

// Single-model, frozen-catalogue listening study. Providers, inference, database
// writes, publication and live production configuration belong to the caller.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createHash, randomUUID, randomInt } = require("node:crypto");
const { analysisSpec } = require("./sonicAnalysisSpec");
const verifiedSource = require("./sonicCatalogVerifiedSource");
const { recordingGroup } = require("./sonicAnalysisPilot");
const { validateStoredResult } = require("./sonicAnchorExperiment");
const verifiedScouts = require("./sonicCatalogVerifiedScouts");
const { finalizeCatalogScoutCandidates } = require("./sonicCatalogScoutFinalizer");
const { musicalNames } = require("./sonicCatalogReview");

const ROOT = path.resolve(__dirname, ".."), KIND = "catalog-verified-scout-quality";
const PURPOSE = "Judge how well each candidate fits beside this anchor.";
const ANALYZER = "mert-30s", SPEC = analysisSpec(ANALYZER);
const GENRES = Object.freeze({ "91": "Bass House", "92": "Techno (Raw / Deep / Hypnotic)" });
const REQUESTS = Object.freeze(["bass-house-1", "bass-house-2", "raw-techno-1", "raw-techno-2"]);
const REQUIRED_CODE = Object.freeze(["src/sonicCatalogVerifiedReview.js", "src/sonicCatalogVerifiedSource.js", "src/sonicCatalogVerifiedScouts.js", "src/sonicCatalogScoutFinalizer.js",
  "src/sonicAnalysisSpec.js", "src/sonicCandidateCorpus.js", "src/sonicAnchorExperiment.js", "src/sonicEnsembleEvaluation.js",
  "config/sonic-analyzers.json", "config/sonic-model-code-sha256.json"]);
const TRACK_FIELDS = ["identityKey", "tidalId", "artist", "title", "mixVersion", "album", "durationMs", "isrc", "genre", "subgenre",
  "label", "bpm", "key", "keyName", "camelot", "releaseDate", "year", "beatportTrackId"];
const METADATA_FIELDS = ["query", "discoverySource", "discoveryLane", "beatportGenre", "beatportSubgenre", "label", "bpm"];
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => hash(JSON.stringify(canonical(value)));
const isSha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fields(value, allowed, label) {
  assert.ok(plain(value) && Object.keys(value).every(key => allowed.includes(key)), `Invalid ${label} fields.`);
}
function text(value, label, limit = 4096) {
  assert.ok(typeof value === "string" && value.trim() && value.length <= limit && !/[\x00-\x1f]/.test(value), `Invalid ${label}.`); return value;
}
function trackView(value) {
  text(value?.identityKey, "catalog identity"); text(value.artist, "artist", 1000); text(value.title, "title", 1000);
  assert.ok(/^tidal:[1-9]\d*$/.test(value.identityKey) && String(value.tidalId) === value.identityKey.slice(6), "Exact canonical TIDAL identity is required.");
  for (const part of [value, value.tidal].filter(Boolean)) {
    assert.ok(plain(part));
    if (part.identityKey !== undefined) assert.equal(part.identityKey, value.identityKey, "Conflicting canonical identity.");
    for (const key of ["id", "tidalId", "tidalTrackId", "trackId"])
      if (part[key] !== undefined && part[key] !== null && part[key] !== "") assert.equal(String(part[key]), value.identityKey.slice(6), "Conflicting canonical provider ID.");
  }
  const result = clone(Object.fromEntries(TRACK_FIELDS.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
  assert.deepEqual(result, value, "Frozen canonical tracks cannot carry scores, review labels or source fields."); return result;
}
function insideFile(file, directory, label, maximum = 64 * 1024 * 1024) {
  text(file, label); const root = fs.realpathSync(directory), target = path.resolve(file), relative = path.relative(root, target);
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), `${label} escaped its private root.`);
  let current = root;
  for (const part of relative.split(path.sep)) { current = path.join(current, part); assert.ok(!fs.lstatSync(current).isSymbolicLink(), `${label} cannot use links.`); }
  const stat = fs.statSync(target); assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum, `${label} exceeds its file bound.`); return target;
}
function artifact(binding, artifactRoot) {
  fields(binding, ["file", "sha256"], "artifact binding"); assert.ok(isSha(binding.sha256));
  const file = insideFile(binding.file, path.join(artifactRoot, "data"), "frozen artifact"), bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), binding.sha256, "Frozen review artifact changed."); return JSON.parse(bytes);
}
function validateCode(code, artifactRoot = ROOT) {
  fields(code, ["files"], "code receipt"); assert.ok(Array.isArray(code.files) && code.files.length >= REQUIRED_CODE.length && code.files.length <= 100);
  const seen = new Set();
  for (const row of code.files) {
    fields(row, ["path", "sha256"], "code pin"); text(row.path, "code path");
    assert.ok(!path.isAbsolute(row.path) && !row.path.split(/[\\/]/).includes("..") && isSha(row.sha256) && !seen.has(row.path), "Invalid or duplicate code pin.");
    seen.add(row.path); assert.equal(hash(fs.readFileSync(insideFile(path.join(artifactRoot, row.path), artifactRoot, "frozen code", 8 * 1024 * 1024))), row.sha256, "Frozen review code changed.");
  }
  assert.ok(REQUIRED_CODE.every(file => seen.has(file)), "Pin the source, spec and actual finalizer dependencies."); return true;
}
function verifiedReviewCodeReceipt(artifactRoot = ROOT) {
  const pending = [...REQUIRED_CODE], files = [], seen = new Set();
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    const absolute = insideFile(path.join(artifactRoot, file), artifactRoot, "frozen code", 8 * 1024 * 1024);
    const bytes = fs.readFileSync(absolute); files.push({ path: file, sha256: hash(bytes) });
    for (const match of bytes.toString("utf8").matchAll(/\brequire\(["'](\.[^"']+)["']\)/g)) {
      let dependency = path.resolve(path.dirname(absolute), match[1]); if (!path.extname(dependency)) dependency += ".js";
      insideFile(dependency, artifactRoot, "code dependency", 8 * 1024 * 1024);
      pending.push(path.relative(artifactRoot, dependency).split(path.sep).join("/"));
    }
  }
  assert.ok(files.length <= 100); return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
function scopeConfiguration(samplingScope = "two-genre") {
  assert.equal(samplingScope, "two-genre", "The verified-source declaration requires both complete genres.");
  return { samplingScope, sourceCount: 16, requestCount: 4, requestIds: [...REQUESTS], genreIds: ["91", "92"] };
}
function recipe(samplingScope) { const scope = scopeConfiguration(samplingScope); return { kind: KIND, analyzer: ANALYZER, spec: clone(SPEC), scoutCount: 6, finalCount: 3, agreementWeight: 0,
  samplingScope: scope.samplingScope, sourceCount: scope.sourceCount, requestCount: scope.requestCount, candidatesPerSamplingGenre: 6, genreIds: scope.genreIds, labelsUsedForSelection: false,
  productionApplied: false, productionPromotionAllowed: false }; }
function validateCollectionEvidence(pool, artifactRoot) {
  const evidence = artifact(pool.collectionEvidence, artifactRoot);
  fields(evidence, ["version", "kind", "runs"], "combined collection evidence"); assert.equal(evidence.version, 1); assert.equal(evidence.kind, "catalog-fresh-combined-evidence");
  assert.ok(Array.isArray(evidence.runs) && evidence.runs.length >= 1 && evidence.runs.length <= 2);
  const collections = [], hashes = new Set();
  for (const run of evidence.runs) {
    fields(run, ["declaration", "collection"], "frozen collection run"); artifact(run.declaration, artifactRoot);
    assert.ok(!hashes.has(run.collection.sha256), "Duplicate collection evidence."); hashes.add(run.collection.sha256);
    const collection = artifact(run.collection, artifactRoot); assert.equal(collection.requestSha256, run.declaration.sha256, "Collection belongs to another declaration.");
    assert.ok(Array.isArray(collection.entries) && collection.entries.length <= 16 && Array.isArray(collection.catalogProvenance) && collection.catalogProvenance.length === collection.entries.length);
    collections.push(collection);
  }
  for (const entry of pool.entries) {
    const owners = collections.flatMap(collection => collection.entries.filter(row => row.track?.identityKey === entry.track.identityKey).map(row => ({ collection, row })));
    assert.equal(owners.length, 1, "Every combined source must have one frozen collection owner."); const owner = owners[0];
    for (const field of ["track", "verification", "source", "metadata"]) assert.deepEqual(entry[field], owner.row[field], "Combined source, version or metadata diverged from collection evidence.");
    const provenance = owner.collection.catalogProvenance.filter(row => row.identityKey === entry.track.identityKey);
    assert.equal(provenance.length, 1); assert.deepEqual(pool.catalogProvenance.find(row => row.identityKey === entry.track.identityKey), provenance[0], "Combined sampling provenance changed.");
  }
}
function validatePool(pool, { artifactRoot = ROOT, requireBytes = false } = {}) {
  fields(pool, ["version", "kind", "samplingScope", "entries", "requests", "catalogProvenance", "collectionEvidence"], "fresh catalog pool");
  const scope = scopeConfiguration(pool.samplingScope);
  assert.equal(pool.version, 1); assert.equal(pool.kind, "catalog-scout-pilot-pool");
  assert.ok(Array.isArray(pool.entries) && pool.entries.length === scope.sourceCount, "Fresh sampling requires the complete explicitly declared source count.");
  assert.ok(Array.isArray(pool.requests) && pool.requests.length === scope.requestCount && Array.isArray(pool.catalogProvenance) && pool.catalogProvenance.length === scope.sourceCount);
  const entries = new Map(), hashes = new Set(), recordings = new Set(), isrcs = new Set();
  for (const entry of pool.entries) {
    fields(entry, ["track", "verification", "source", "sourceFile", "metadata"], "fresh catalog entry"); const track = trackView(entry.track);
    fields(entry.verification, ["provider", "verified", "identityKey", "canonicalTrack"], "canonical verification");
    assert.equal(entry.verification.provider, "tidal"); assert.equal(entry.verification.verified, true); assert.equal(entry.verification.identityKey, track.identityKey);
    assert.deepEqual(trackView(entry.verification.canonicalTrack), track, "Canonical source recording changed.");
    verifiedSource.assertSonicSourceSnapshot(entry.source, { track });
    assert.ok(entry.source.sourceType === "beatport-preview" && ["exact", "equivalent-recording"].includes(entry.source.identityRelation) && entry.source.allowVersionProxy === false, "Verified reviews require bounded original-recording proofs.");
    assert.ok(entry.source.durationSeconds >= 30 && entry.source.spans.length === 1 && Math.abs(entry.source.spans[0][1] - entry.source.spans[0][0] - 30) <= .000002);
    const file = insideFile(entry.sourceFile, path.join(artifactRoot, "data"), "frozen preview", 20 * 1024 * 1024);
    if (requireBytes) verifiedSource.assertSonicSourceSnapshot(entry.source, { track, audioBytes: fs.readFileSync(file) });
    fields(entry.metadata, METADATA_FIELDS, "actual catalog metadata");
    for (const [key, value] of Object.entries(entry.metadata)) key === "bpm" ? assert.ok(Number.isFinite(value) && value > 0) : text(value, `catalog ${key}`, 1000);
    const group = recordingGroup(track), isrc = String(track.isrc || "").toUpperCase();
    assert.ok(!entries.has(track.identityKey) && !hashes.has(entry.source.sourceSha256) && !recordings.has(group) && (!isrc || !isrcs.has(isrc)), "Duplicate fresh recording identity, source or version.");
    entries.set(track.identityKey, clone(entry)); hashes.add(entry.source.sourceSha256); recordings.add(group); if (isrc) isrcs.add(isrc);
  }
  const provenance = new Map();
  for (const row of pool.catalogProvenance) {
    fields(row, ["identityKey", "beatportTrackId", "sourceSnapshotKey", "genreId", "genreName", "artistIds", "pageKey"], "actual catalog provenance");
    const entry = entries.get(row.identityKey); assert.ok(entry && !provenance.has(row.identityKey), "Missing or duplicate catalog provenance.");
    assert.ok(scope.genreIds.includes(row.genreId) && row.genreName === GENRES[row.genreId]
      && typeof row.pageKey === "string" && row.pageKey.match(new RegExp(`^${row.genreId}:catalogue:[234]$`)), "Actual declared catalogue page or genre changed.");
    assert.ok(Array.isArray(row.artistIds) && row.artistIds.length > 0 && row.artistIds.every(id => typeof id === "string" && /^[1-9]\d*$/.test(id)));
    assert.equal(row.beatportTrackId, entry.source.sourceTrackId); assert.equal(row.sourceSnapshotKey, entry.source.snapshotKey);
    // The identity snapshot deliberately omits genre. Keep actual page-derived
    // sampling evidence separate, bound to its exact provider track/source.
    assert.equal(entry.metadata.beatportGenre, row.genreName);
    assert.equal(entry.metadata.query, `Beatport genre ${row.genreId} catalogue page ${row.pageKey.split(":")[2]}`);
    assert.equal(entry.metadata.discoverySource, "verified Beatport genre catalogue resolved to canonical TIDAL");
    assert.equal(entry.metadata.discoveryLane, "core");
    if (entry.metadata.label !== undefined) assert.equal(entry.metadata.label, entry.source.sourceTrack.label, "Catalog label evidence changed.");
    provenance.set(row.identityKey, row);
  }
  const anchors = new Set(), candidates = new Set(), seenRequests = new Set(), shared = new Map();
  for (const row of pool.requests) {
    fields(row, ["requestId", "anchorIdentityKey", "candidateIdentityKeys", "options"], "fresh catalog request");
    assert.ok(scope.requestIds.includes(row.requestId) && !seenRequests.has(row.requestId)); seenRequests.add(row.requestId);
    const genreId = row.requestId.startsWith("bass-house-") ? "91" : "92", anchor = entries.get(row.anchorIdentityKey);
    assert.ok(anchor && !anchors.has(row.anchorIdentityKey)); anchors.add(row.anchorIdentityKey); assert.equal(provenance.get(row.anchorIdentityKey).genreId, genreId);
    assert.ok(Array.isArray(row.candidateIdentityKeys) && row.candidateIdentityKeys.length === 6 && new Set(row.candidateIdentityKeys).size === 6);
    if (shared.has(genreId)) assert.deepEqual(row.candidateIdentityKeys, shared.get(genreId), "Both anchors must use the same frozen six candidates per genre.");
    else shared.set(genreId, row.candidateIdentityKeys);
    for (const key of row.candidateIdentityKeys) { assert.ok(entries.has(key) && key !== row.anchorIdentityKey); assert.equal(provenance.get(key).genreId, genreId); candidates.add(key); }
    assert.ok(plain(row.options) && !Object.hasOwn(row.options, "genres") && !Object.hasOwn(row.options, "genre"), "Sampling metadata cannot create hard requested genres.");
    fields(row.options, ["scoringMode", "request", "anchorTrack", "count", "allowPreviousSuggestions", "allowPreviousFallback"], "frozen similar-track options");
    assert.equal(row.options.scoringMode, "similar"); assert.equal(row.options.count, 3); assert.deepEqual(trackView(row.options.anchorTrack), anchor.track);
    assert.equal(row.options.request, `Find tracks like ${anchor.track.artist} — ${anchor.track.title}`);
    assert.equal(row.options.allowPreviousSuggestions, false); assert.equal(row.options.allowPreviousFallback, false);
  }
  assert.equal(anchors.size, scope.requestCount); assert.equal(candidates.size, scope.genreIds.length * 6); assert.ok([...anchors].every(key => !candidates.has(key)));
  assert.deepEqual([...seenRequests].sort(), [...scope.requestIds].sort()); validateCollectionEvidence(pool, artifactRoot); return { entries, provenance };
}
function validateExclusions(pool, request) {
  assert.equal(request.samplingScope ?? "two-genre", pool.samplingScope ?? "two-genre", "Request and pool sampling scopes differ.");
  assert.ok(plain(request) && Array.isArray(request.heldOut) && request.heldOut.length === 6 && Array.isArray(request.excluded)
    && request.excluded.length <= 10000 && Array.isArray(request.excludedSourceSha256) && request.excludedSourceSha256.length <= 10000
    && Array.isArray(request.excludedBeatportTrackIds) && request.excludedBeatportTrackIds.length <= 10000,
  "Freeze held-out identities and source exclusions independently of the selected pool.");
  assert.ok(request.excludedSourceSha256.every(isSha));
  assert.ok(request.excludedBeatportTrackIds.every(id => typeof id === "string" && /^[1-9]\d*$/.test(id)));
  const forbidden = [...request.heldOut, ...request.excluded];
  for (const track of forbidden) { text(track?.identityKey, "excluded recording identity"); text(track.artist, "excluded artist"); text(track.title, "excluded title"); }
  for (const entry of pool.entries) {
    assert.ok(!request.excludedBeatportTrackIds.includes(entry.source.sourceTrackId)
      && !request.excludedBeatportTrackIds.includes(String(entry.track.beatportTrackId || "")), "Previously attempted Beatport source entered the verified pool.");
    assert.ok(!request.excludedSourceSha256.includes(entry.source.sourceSha256), "Excluded or held-out audio source entered the fresh pool.");
    assert.ok(!forbidden.some(track => track.identityKey === entry.track.identityKey || recordingGroup(track) === recordingGroup(entry.track)
      || track.isrc && entry.track.isrc && String(track.isrc).toUpperCase() === entry.track.isrc.toUpperCase()), "Excluded or held-out recording entered the fresh pool.");
  }
}
function validatedMatrices(pool, sourceEvidence) {
  assert.ok(Array.isArray(sourceEvidence) && sourceEvidence.length === pool.entries.length, "Every declared source needs its 30s typed receipt.");
  const entries = new Map(pool.entries.map(entry => [entry.track.identityKey, entry])), records = new Map();
  for (const evidence of sourceEvidence) {
    fields(evidence, ["identityKey", "sourceSnapshotKey", "receipt"], "single-model source evidence"); const entry = entries.get(evidence.identityKey);
    assert.ok(entry && !records.has(evidence.identityKey)); assert.equal(evidence.sourceSnapshotKey, entry.source.snapshotKey);
    const raw = verifiedSource.readVerifiedResultReceipt(evidence.receipt, SPEC, entry.source), result = validateStoredResult(raw, SPEC, entry.source);
    records.set(evidence.identityKey, { identityKey: evidence.identityKey, analyzer: ANALYZER, repo: SPEC.repo, specKey: SPEC.key,
      revision: SPEC.revision, sampleRate: SPEC.sampleRate, dimensions: SPEC.dimensions, sourceSnapshotKey: entry.source.snapshotKey,
      sourceSha256: entry.source.sourceSha256, spans: result.evidence.spans, vector: result.vector });
  }
  return new Map([[ANALYZER, { spec: SPEC, records }]]);
}
function rawScouts(pool, request, matrices) {
  const entries = new Map(pool.entries.map(entry => [entry.track.identityKey, entry])), anchor = entries.get(request.anchorIdentityKey);
  const selected = verifiedScouts.freezeSonicCatalogScoutPool({ items: request.candidateIdentityKeys.map(key => entries.get(key)) });
  assert.equal(selected.items.length, 6); assert.equal(selected.diagnostics.duplicates.length, 0);
  const records = new Map([request.anchorIdentityKey, ...request.candidateIdentityKeys].map(key => [key, matrices.get(ANALYZER).records.get(key)]));
  const result = verifiedScouts.buildSonicCatalogScouts({ anchor, pool: selected, matrices: new Map([[ANALYZER, { spec: SPEC, records }]]),
    selector: ANALYZER, mode: "observe", scoutCount: 6, finalCount: 3, agreementWeight: 0 });
  assert.equal(result.scouts.length, 6); assert.equal(result.diagnostics.fallback, false); assert.equal(result.diagnostics.vectorSpacesMixed, false);
  return result.scouts.map(track => { const nomination = track.sonicScout.nominations[0]; return { track: clone(entries.get(track.identityKey).track), rank: nomination.rank, similarity: nomination.similarity }; });
}
async function buildVerifiedCatalogScoutSelections({ pool, receipts, request = null, tasteSnapshot = null, historySnapshot = null, productionSnapshot = null,
  code = verifiedReviewCodeReceipt() } = {}, { artifactRoot = ROOT } = {}) {
  validatePool(pool, { artifactRoot, requireBytes: true }); validateCode(code, artifactRoot);
  if (request !== null) validateExclusions(pool, request);
  assert.ok(receipts instanceof Map && receipts.size === pool.entries.length, "Provide exactly the declared source count of typed MERT-30s receipts.");
  const sourceEvidence = pool.entries.map(entry => ({ identityKey: entry.track.identityKey, sourceSnapshotKey: entry.source.snapshotKey,
    receipt: clone(receipts.get(entry.track.identityKey)) }));
  const matrices = validatedMatrices(pool, sourceEvidence), entries = new Map(pool.entries.map(entry => [entry.track.identityKey, entry])), requests = [];
  for (const request of pool.requests) {
    const scouts = rawScouts(pool, request, matrices), candidates = scouts.map(row => ({ ...clone(row.track), ...clone(entries.get(row.track.identityKey).metadata) }));
    const finalized = await finalizeCatalogScoutCandidates(candidates, { options: clone(request.options), requestedCount: 3,
      tasteSnapshot: clone(tasteSnapshot), historySnapshot: clone(historySnapshot), productionSnapshot: clone(productionSnapshot) });
    assert.ok(Array.isArray(finalized.tracks) && finalized.tracks.length <= 3); const seen = new Set();
    const tracks = finalized.tracks.map(value => {
      const returned = value.tidal || value, key = returned.identityKey || (returned.tidalId || returned.id ? `tidal:${returned.tidalId || returned.id}` : ""), entry = entries.get(key);
      assert.ok(entry && scouts.some(row => row.track.identityKey === key) && !seen.has(key), "Actual finalizer returned a duplicate or foreign scout."); seen.add(key);
      for (const field of ["artist", "title", "mixVersion", "durationMs", "isrc"]) assert.deepEqual(returned[field] ?? "", entry.track[field] ?? "", "Actual finalizer changed the recording descriptor.");
      return { track: clone(entry.track) };
    });
    requests.push({ requestId: request.requestId, anchorIdentityKey: request.anchorIdentityKey, scouts, tracks, verification: clone(finalized.verification || {}) });
  }
  validatePool(pool, { artifactRoot, requireBytes: true }); validateCode(code, artifactRoot);
  return { version: 1, kind: KIND, recipe: recipe(pool.samplingScope), code: clone(code), requests, sourceEvidence,
    snapshotDigests: { taste: digest(tasteSnapshot), history: digest(historySnapshot), production: digest(productionSnapshot) },
    productionApplied: false, productionPromotionAllowed: false };
}
function readFrozen(poolBinding, selectionBinding, requestBinding, artifactRoot) {
  const pool = artifact(poolBinding, artifactRoot), selections = artifact(selectionBinding, artifactRoot);
  const samplingRequest = artifact(requestBinding, artifactRoot); validateExclusions(pool, samplingRequest);
  const { entries } = validatePool(pool, { artifactRoot });
  fields(selections, ["version", "kind", "recipe", "code", "requests", "sourceEvidence", "snapshotDigests", "productionApplied", "productionPromotionAllowed"], "frozen fresh selections");
  assert.equal(selections.version, 1); assert.equal(selections.kind, KIND); assert.deepEqual(selections.recipe, recipe(pool.samplingScope));
  assert.equal(selections.productionApplied, false); assert.equal(selections.productionPromotionAllowed, false); validateCode(selections.code, artifactRoot);
  fields(selections.snapshotDigests, ["taste", "history", "production"], "frozen policy snapshots"); assert.ok(Object.values(selections.snapshotDigests).every(isSha));
  const matrices = validatedMatrices(pool, selections.sourceEvidence); assert.ok(Array.isArray(selections.requests) && selections.requests.length === pool.requests.length);
  const requests = pool.requests.map(request => {
    const matches = selections.requests.filter(row => row.requestId === request.requestId); assert.equal(matches.length, 1);
    const result = matches[0]; fields(result, ["requestId", "anchorIdentityKey", "scouts", "tracks", "verification"], "finalized request");
    assert.equal(result.anchorIdentityKey, request.anchorIdentityKey); assert.deepEqual(result.scouts, rawScouts(pool, request, matrices), "Frozen MERT-30s scout ranks or similarities changed.");
    assert.ok(Array.isArray(result.tracks) && result.tracks.length <= 3 && plain(result.verification));
    const replay = result.verification.catalogScoutReplay;
    assert.ok(replay?.frozenInputCount === 6 && replay.productionApplied === false && replay.providersQueried === false
      && replay.historyWrites === 0 && replay.analysisQueued === 0, "The actual frozen discovery finalizer evidence is required.");
    const keys = new Set();
    for (const selected of result.tracks) { fields(selected, ["track"], "finalized track"); const key = selected.track?.identityKey;
      assert.ok(entries.has(key) && result.scouts.some(row => row.track.identityKey === key) && !keys.has(key), "Final selection is outside the six verified scouts."); keys.add(key);
      assert.deepEqual(trackView(selected.track), entries.get(key).track, "Frozen final version descriptor changed."); }
    return { ...request, anchor: entries.get(request.anchorIdentityKey), scouts: result.scouts, tracks: result.tracks };
  });
  return { pool, selections, entries, requests };
}
function clipFor(entry) {
  const [start, end] = entry.source.spans[0], clip = { start, end, sourceSha256: entry.source.sourceSha256, sourceFile: entry.sourceFile,
    sourceType: "beatport-preview", sourceSnapshotKey: entry.source.snapshotKey };
  return { ...clip, clipId: hash(JSON.stringify([clip.sourceSha256, start, end, "pcm_s16le-mono-24000-v1"])) };
}
function planIdentity(plan) {
  const frozen = clone(plan); delete frozen.planKey; delete frozen.preparationRequest; delete frozen.preparationRequestKey;
  for (const clip of Object.values(frozen.clips)) delete clip.wavSha256; return digest(frozen);
}
function shuffle(rows) { const result = [...rows]; for (let index = result.length - 1; index > 0; index--) { const other = randomInt(index + 1); [result[index], result[other]] = [result[other], result[index]]; } return result; }
function buildVerifiedCatalogReviewPlan({ roundId, title = "Fresh catalog listening review", pool, selections, request } = {}, { artifactRoot = ROOT } = {}) {
  assert.ok(typeof roundId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(roundId)); text(title, "review title", 120);
  const frozen = readFrozen(pool, selections, request, artifactRoot), groups = [], clips = {};
  for (const request of frozen.requests) {
    if (!request.tracks.length) continue;
    const anchorClip = clipFor(request.anchor); clips[anchorClip.clipId] = anchorClip;
    const candidates = shuffle(request.tracks.map((row, index) => {
      const entry = frozen.entries.get(row.track.identityKey), clip = clipFor(entry); clips[clip.clipId] ||= clip;
      const scout = request.scouts.find(value => value.track.identityKey === row.track.identityKey);
      return { track: clone(entry.track), clipId: clip.clipId, nominations: [{ analyzer: ANALYZER, rank: index + 1 }],
        retrieval: { analyzer: ANALYZER, specKey: SPEC.key, rank: scout.rank, similarity: scout.similarity },
        reference: { verification: clone(entry.verification), source: clone(entry.source) } };
    }));
    groups.push({ sessionId: `sonic-review:${randomUUID()}`, requestId: request.requestId, anchor: clone(request.anchor.track),
      anchorReference: { verification: clone(request.anchor.verification), source: clone(request.anchor.source) }, anchorClip: anchorClip.clipId, purpose: PURPOSE, candidates });
  }
  if (!groups.length) return null;
  const plan = { version: 7, kind: KIND, batchId: `blind:${randomUUID()}`, roundId, createdAt: new Date().toISOString(), title,
    models: [ANALYZER], count: groups.reduce((sum, group) => sum + group.candidates.length, 0), anchorCount: groups.length,
    requestCount: frozen.requests.length, selectedSlots: groups.reduce((sum, group) => sum + group.candidates.length, 0), pool: clone(pool), selections: clone(selections), request: clone(request),
    recipe: recipe(frozen.pool.samplingScope), groups, clips, method: "Verified catalogue preview anchors, including proof-backed original-to-unlabeled equivalent recordings; one pinned 30s model orders six candidates per anchor; existing frozen admission, taste and diversity select up to three; all final pairs shuffled once; single-arm descriptive listening only." };
  plan.planKey = planIdentity(plan); validateVerifiedCatalogReviewPlan(plan, { artifactRoot }); return plan;
}
function validateWave(file, clip) {
  const bytes = fs.readFileSync(file); assert.ok(bytes.length >= 44 && bytes.length <= 2 * 1024 * 1024);
  assert.equal(hash(bytes), clip.wavSha256, "Prepared fresh WAV changed."); assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length); let format = null, samples = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) { const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert.ok(start + size <= bytes.length); if (id === "fmt ") { assert.ok(size >= 16 && !format); format = [bytes.readUInt16LE(start), bytes.readUInt16LE(start + 2), bytes.readUInt32LE(start + 4), bytes.readUInt16LE(start + 14)]; }
    if (id === "data") { assert.equal(size % 2, 0); samples += size / 2; } offset = start + size + size % 2; }
  assert.deepEqual(format, [1, 1, 24000, 16]); assert.ok(samples > 0 && Math.abs(samples - Math.round((clip.end - clip.start) * 24000)) <= 1, "Prepared WAV differs from the frozen excerpt.");
}
function validateFreshness(plan, frozen, db) {
  const current = [...frozen.entries.values()];
  const conflicts = (entry, track, sourceHash) => entry.track.identityKey === track?.identityKey || entry.source.sourceSha256 === sourceHash
    || recordingGroup(entry.track) === recordingGroup(track || {}) || entry.track.isrc && track?.isrc && entry.track.isrc.toUpperCase() === track.isrc.toUpperCase();
  for (const row of db.prepare("SELECT batch_id,private_plan_json FROM sonic_blind_review_batch").all()) {
    if (row.batch_id === plan.batchId) continue; const prior = JSON.parse(row.private_plan_json);
    for (const group of prior.groups || []) for (const [track, clipId] of [[group.anchor, group.anchorClip], ...(group.candidates || []).map(candidate => [candidate.track, candidate.clipId])])
      assert.ok(!current.some(entry => conflicts(entry, track, prior.clips?.[clipId]?.sourceSha256)), "Fresh pool recordings must be unexposed across prior blind batches.");
  }
  const hasFeedback = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sonic_neighbor_feedback'").get());
  for (const entry of current) {
    assert.ok(!db.prepare("SELECT 1 FROM sonic_review_session_item WHERE candidate_identity_key=? AND review_json IS NOT NULL LIMIT 1").get(entry.track.identityKey), "Fresh pool recordings must be unjudged.");
    if (hasFeedback) assert.ok(!db.prepare("SELECT 1 FROM sonic_neighbor_feedback WHERE candidate_identity_key=? LIMIT 1").get(entry.track.identityKey), "Fresh pool recordings must be unjudged.");
  }
}
function validateVerifiedCatalogReviewPlan(plan, { db, requirePrepared = false, cacheDirectory = path.join(ROOT, "data/sonic-blind-audio"), artifactRoot = ROOT } = {}) {
  fields(plan, ["version", "kind", "batchId", "roundId", "createdAt", "title", "models", "count", "anchorCount", "requestCount", "selectedSlots", "pool", "selections", "request", "recipe", "groups", "clips", "method", "planKey", "preparationRequest", "preparationRequestKey"], "fresh review plan");
  assert.equal(plan.version, 7); assert.equal(plan.kind, KIND); assert.deepEqual(plan.models, [ANALYZER]);
  text(plan.batchId, "batch identity"); text(plan.title, "review title", 120); assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.roundId || "") && Number.isFinite(Date.parse(plan.createdAt)));
  const frozen = readFrozen(plan.pool, plan.selections, plan.request, artifactRoot), expected = frozen.requests.filter(request => request.tracks.length);
  assert.deepEqual(plan.recipe, recipe(frozen.pool.samplingScope));
  assert.ok(Array.isArray(plan.groups) && plan.groups.length > 0 && plan.groups.length === expected.length && plain(plan.clips));
  assert.equal(plan.anchorCount, plan.groups.length); assert.equal(plan.requestCount, frozen.requests.length); const used = new Set(), sessions = new Set(); let count = 0;
  plan.groups.forEach((group, index) => {
    fields(group, ["sessionId", "requestId", "anchor", "anchorReference", "anchorClip", "purpose", "candidates"], "fresh group"); const request = expected[index];
    assert.equal(group.requestId, request.requestId); assert.deepEqual(group.anchor, request.anchor.track); assert.equal(group.purpose, PURPOSE);
    assert.deepEqual(group.anchorReference, { verification: request.anchor.verification, source: request.anchor.source });
    text(group.sessionId, "session identity"); assert.ok(!sessions.has(group.sessionId)); sessions.add(group.sessionId);
    const validateClip = (clipId, entry) => { const clip = plan.clips[clipId]; fields(clip, ["start", "end", "sourceSha256", "sourceFile", "sourceType", "sourceSnapshotKey", "clipId", "wavSha256"], "fresh clip");
      const actual = { ...clip }; delete actual.wavSha256; assert.deepEqual(actual, clipFor(entry), "Exact source identity or excerpt changed."); assert.equal(clipId, clip.clipId); assert.ok(clip.wavSha256 === undefined || isSha(clip.wavSha256)); used.add(clipId); };
    validateClip(group.anchorClip, request.anchor); assert.ok(Array.isArray(group.candidates) && group.candidates.length === request.tracks.length); const keys = new Set();
    for (const candidate of group.candidates) {
      fields(candidate, ["track", "clipId", "nominations", "retrieval", "reference"], "fresh candidate"); const key = candidate.track?.identityKey, rank = request.tracks.findIndex(row => row.track.identityKey === key);
      assert.ok(rank >= 0 && !keys.has(key), "Frozen final membership changed."); keys.add(key); const entry = frozen.entries.get(key), scout = request.scouts.find(row => row.track.identityKey === key);
      assert.deepEqual(candidate.track, entry.track); assert.deepEqual(candidate.nominations, [{ analyzer: ANALYZER, rank: rank + 1 }]);
      assert.deepEqual(candidate.retrieval, { analyzer: ANALYZER, specKey: SPEC.key, rank: scout.rank, similarity: scout.similarity });
      assert.deepEqual(candidate.reference, { verification: entry.verification, source: entry.source }); validateClip(candidate.clipId, entry); count++;
    }
  });
  assert.ok(count > 0 && count <= frozen.requests.length * 3); assert.equal(plan.count, count); assert.equal(plan.selectedSlots, count); assert.deepEqual(Object.keys(plan.clips).sort(), [...used].sort());
  assert.equal(plan.planKey, planIdentity(plan), "Frozen fresh plan order or session identity changed."); if (db) validateFreshness(plan, frozen, db);
  if (requirePrepared) { assert.ok(db, "Publication requires review-state freshness checks."); validatePool(frozen.pool, { artifactRoot, requireBytes: true });
    for (const clip of Object.values(plan.clips)) { assert.ok(isSha(clip.wavSha256), "Prepare every fresh review WAV before publication."); validateWave(insideFile(path.join(cacheDirectory, clip.clipId + ".wav"), cacheDirectory, "prepared WAV", 2 * 1024 * 1024), clip); } }
  return true;
}
function getVerifiedCatalogReviewSnapshot(plan, db) {
  assert.ok(plan?.version === 7 && plan.kind === KIND && db && Array.isArray(plan.groups));
  let completed = 0, count = 0;
  const media = clipId => ({ url: `/api/recommendation-v2/sonic-review/blind/audio?batchId=${encodeURIComponent(plan.batchId)}&clipId=${encodeURIComponent(clipId)}`,
    start: 0, end: Math.round((plan.clips[clipId].end - plan.clips[clipId].start) * 1e6) / 1e6 });
  const groups = plan.groups.map((group, index) => {
    const saved = db.prepare("SELECT item_index,status,decision,review_json FROM sonic_review_session_item WHERE session_id=? ORDER BY item_index").all(group.sessionId);
    assert.equal(saved.length, group.candidates.length); const offset = count; count += saved.length;
    completed += saved.filter(row => row.status !== "PENDING").length;
    return { number: index + 1, sessionId: group.sessionId, anchor: musicalNames(group.anchor), purpose: PURPOSE, anchorAudio: media(group.anchorClip),
      items: saved.map(row => {
        const review = row.review_json ? JSON.parse(row.review_json) : null;
        const publicReview = review ? Object.fromEntries(["decision", "note", "listened", "reviewer", "evidence", "globalRatingChanged"]
          .filter(key => review[key] !== undefined).map(key => [key, review[key]])) : null;
        return { index: row.item_index, number: offset + row.item_index + 1, candidate: musicalNames(group.candidates[row.item_index].track),
          audio: media(group.candidates[row.item_index].clipId), status: row.status, decision: row.decision, review: publicReview };
      }) };
  });
  return { ok: true, batch: { batchId: plan.batchId, title: plan.title, kind: KIND, purpose: PURPOSE, count, anchorCount: groups.length,
    completed, remaining: count - completed, status: count === completed ? "COMPLETED" : "READY", groups, blind: true,
    productionApplied: false, globalRatingsChanged: false } };
}
function completedVerifiedCatalogReport(plan, snapshot) {
  const groups = snapshot?.groups; let remaining = 0;
  if (snapshot?.batchId !== plan.batchId || !Array.isArray(groups) || groups.length !== plan.groups.length) return { ok: true, ready: false, kind: KIND, productionPromotionAllowed: false };
  for (const [index, group] of groups.entries()) {
    if (group.sessionId !== plan.groups[index].sessionId || !Array.isArray(group.items) || group.items.length !== plan.groups[index].candidates.length) return { ok: true, ready: false, kind: KIND, productionPromotionAllowed: false };
    for (const item of group.items) if (item.status !== "REVIEWED" || item.review?.reviewer !== "human" || !["KEEP", "WRONG_LANE", "SKIP", "UNSURE"].includes(item.review?.decision)
      || item.review.decision !== "UNSURE" && item.review.listened !== true) remaining++;
  }
  if (remaining) return { ok: true, ready: false, remaining, kind: KIND, productionPromotionAllowed: false };
  const decisions = { KEEP: 0, WRONG_LANE: 0, SKIP: 0, UNSURE: 0 };
  const anchors = plan.groups.map((group, index) => { const counts = { KEEP: 0, WRONG_LANE: 0, SKIP: 0, UNSURE: 0 };
    for (const item of groups[index].items) { counts[item.review.decision]++; decisions[item.review.decision]++; }
    return { number: index + 1, anchor: musicalNames(group.anchor), selectedSlots: group.candidates.length, missingSlots: 3 - group.candidates.length, decisions: counts }; });
  return { ok: true, ready: true, batchId: snapshot.batchId, kind: KIND, purpose: PURPOSE, analyzer: ANALYZER,
    scope: "single-model-final-selections", samplingScope: plan.recipe.samplingScope, requestCount: plan.requestCount, anchorCount: plan.anchorCount, selectedSlots: plan.count,
    missingSlots: plan.requestCount * 3 - plan.count, decisions, anchors, productionApplied: false, productionPromotionAllowed: false, globalRatingsChanged: false,
    notes: ["Descriptive listening of verified catalogue previews, including proven original-recording equivalence, after one model orders the six candidates and the existing frozen finalizer selects; no baseline comparison or model winner.",
      "Missing final slots are not filled or counted as negative judgments. Uncertainty remains unresolved.",
      "Findings apply to the reviewed excerpt pairs; they do not establish full-recording quality, held-out performance or a production gain."] };
}
module.exports = { KIND, PURPOSE, ANALYZER, REQUIRED_CODE, recipe, verifiedReviewCodeReceipt, validatePool, validateExclusions,
  buildVerifiedCatalogScoutSelections, buildVerifiedCatalogReviewPlan, validateVerifiedCatalogReviewPlan,
  validateVerifiedCatalogScoutReviewPlan: validateVerifiedCatalogReviewPlan, getVerifiedCatalogReviewSnapshot, completedVerifiedCatalogReport };
