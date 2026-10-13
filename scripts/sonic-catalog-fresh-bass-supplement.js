"use strict";
// Separate fixed cached-metadata leads, each freshly verified by exact provider
// IDs. Never retries the closed feed run and never consumes local audio.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto"), { execFileSync } = require("node:child_process");
const fresh = require("./sonic-catalog-scout-fresh"), { ROOT, DIRECTORY, sha, read, save, update, ownedPath } = fresh;
const { BeatportClient, normalizeBeatportTrack } = require("../src/beatportClient"), { canonicalTrack } = require("../src/sonicCatalogScoutCollector");
const { coarseCandidateReason } = require("../src/sonicCatalogScoutCoverageProbe"), { scoreTidalIdentity } = require("../src/exactTrackVerification");
const { matchBeatportVersionToTidal } = require("../src/beatportVersionMatch"), { freezeSonicSourceSnapshot, assertSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { recordingGroup } = require("../src/sonicAnalysisPilot"), { artistCreditSetKey, parseCanonicalCatalogIdentity } = require("../src/catalogIdentityNormalization");
const binding = name => ({ file: path.join(DIRECTORY, name), sha256: sha(fs.readFileSync(path.join(DIRECTORY, name))) });
const query = "Beatport genre91 cached lead freshly verified by exact track detail";
const work = track => artistCreditSetKey(track.artist) + "|" + parseCanonicalCatalogIdentity(track).normalizedBaseTitle;
function pins() { return { files: [...fresh.pins().files, { path: "scripts/sonic-catalog-fresh-bass-supplement.js", sha256: sha(fs.readFileSync(__filename)) }] }; }
function initialize() {
  const previous = read(path.join(DIRECTORY, "collection.json")), request = read(path.join(DIRECTORY, "request.json")), leads = read(path.join(DIRECTORY, "cached-bass-leads.json"));
  assert.equal(previous.entries.length, 8); assert.ok(previous.entries.every(entry => previous.catalogProvenance.find(row => row.identityKey === entry.track.identityKey).genreId === "92"));
  assert.ok(Array.isArray(leads.leads) && leads.leads.length <= 22 && leads.leads.length >= 8);
  const forbidden = new Set([...request.excludedBeatportTrackIds, ...previous.attempts.map(attempt => attempt.beatportTrackId)]);
  assert.ok(leads.leads.every(lead => !forbidden.has(lead.beatportTrackId)));
  const declaration = { version: 1, createdAt: new Date().toISOString(), purpose: "Complete missing Bass House coverage using a fixed list of older catalog metadata leads, freshly verified",
    priorFeedResult: binding("collection.json"), leads: binding("cached-bass-leads.json"), recipe: { maximumLeadAttempts: leads.leads.length, maximumExactSources: 8, maximumCanonicalDetailsPerLead: 1, maximumBeatportDetailsPerLead: 1, maximumSearchQueries: 0, maximumCombinedSourceAttempts: 96, maximumCombinedModelRuns: 16, analyzer: "mert-30s", anchors: 2, sharedCandidates: 6, allowVersionProxy: false },
    normalAuthentication: true, additionalBeatportRefreshAttempts: 0, transportRetries: 0, retriesOfPriorAttemptedTracks: false, localLibraryAudio: false, labelsUsedForSelection: false, productionApplied: false,
    excludedBeatportTrackIds: [...forbidden], excluded: request.excluded, heldOut: request.heldOut, excludedSourceSha256: [...request.excludedSourceSha256, ...previous.entries.map(entry => entry.source.sourceSha256)] };
  assert.ok(previous.attempts.length + leads.leads.length <= 96);
  save(path.join(DIRECTORY, "supplement-request.json"), declaration); save(path.join(DIRECTORY, "supplement-code-receipt.json"), pins());
  console.log(JSON.stringify({ declared: true, maximumLeadAttempts: leads.leads.length, maximumCombinedSourceAttempts: previous.attempts.length + leads.leads.length, freshAudioSourceCap: 8 }));
}
function excluded(track, request, others) {
  return [...request.excluded, ...request.heldOut, ...others.map(entry => entry.track)].some(old => old.identityKey === track.identityKey || recordingGroup(old) === recordingGroup(track) || work(old) === work(track) || old.isrc && track.isrc && old.isrc === track.isrc);
}
function probe(file) {
  const { wslPath } = require("../src/sonicAnalysisWorker"); ownedPath(file);
  const duration = Number(execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", wslPath(file)], { windowsHide: true, timeout: 30000, encoding: "utf8" }).trim()); assert.ok(duration >= 30 && duration <= 7200); return duration;
}
async function collect() {
  const requestFile = path.join(DIRECTORY, "supplement-request.json"), request = read(requestFile), progressFile = path.join(DIRECTORY, "supplement-collection.json"), leads = read(request.leads.file).leads;
  assert.ok(!fs.existsSync(progressFile), "Do not repeat a closed supplemental declaration"); assert.deepEqual(pins(), read(path.join(DIRECTORY, "supplement-code-receipt.json"))); assert.equal(sha(fs.readFileSync(request.leads.file)), request.leads.sha256); assert.equal(sha(fs.readFileSync(request.priorFeedResult.file)), request.priorFeedResult.sha256);
  fresh.guard("before-bass-supplement");
  const config = require("../src/config"), quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} }, beatport = new BeatportClient({ ...config.beatport, logger: quiet }); beatport.maxRetries = 0;
  const token = beatport.store.read(); assert.ok(token.accessToken && token.expiresAtMs > Date.now() + 60000);
  beatport.refreshAccessToken = async () => { throw Error("No supplemental refresh is declared"); };
  const tidal = new (require("../src/tidalVerifier").TidalVerifier)({ ...config.tidal, catalogPaginationFile: path.join(DIRECTORY, "supplement-tidal-pagination.json") }); assert.ok(tidal.isConfigured());
  const progress = { version: 1, kind: "catalog-fresh-cached-detail-supplement", requestSha256: sha(fs.readFileSync(requestFile)), attempts: [], entries: [], catalogProvenance: [], anchors: [], candidates: [], transport: [] };
  save(progressFile, progress); const persist = () => update(progressFile, progress), originalRaw = beatport.requestRaw.bind(beatport), originalTidal = tidal.fetchTidalResponse.bind(tidal);
  beatport.requestRaw = async (...args) => { const item = { provider: "beatport", kind: "exact-detail", status: "started" }; progress.transport.push(item); persist(); try { const response = await originalRaw(...args); item.status = response?.status || "no-response"; return response; } catch { item.status = "transport-error"; throw Error("provider-unavailable"); } finally { persist(); } };
  let apiCalls = 0, authenticationCalls = 0;
  tidal.fetchTidalResponse = async (url, ...args) => { const kind = /^\/v2\/tracks\//.test(new URL(url).pathname) ? "exact-detail" : "authentication"; if (kind === "exact-detail") assert.ok(++apiCalls <= 3 * leads.length); else assert.ok(++authenticationCalls <= 12); const item = { provider: "tidal", kind, status: "started" }; progress.transport.push(item); persist(); try { const response = await originalTidal(url, ...args); item.status = response.status; return response; } catch { item.status = "transport-error"; throw Error("provider-unavailable"); } finally { persist(); } };
  for (const lead of leads) {
    if (progress.entries.length === 8) break;
    assert.ok(!request.excludedBeatportTrackIds.includes(lead.beatportTrackId));
    const attempt = { beatportTrackId: lead.beatportTrackId, tidalId: lead.tidalId, role: progress.anchors.length < 2 ? "anchor" : "candidate", status: "started", at: new Date().toISOString() }; progress.attempts.push(attempt); persist();
    try {
      const fetched = await beatport.getTrackById(lead.beatportTrackId), raw = fetched?.rawJson;
      assert.ok(raw && String(raw.genre?.id || raw.attributes?.genre?.id) === "91", "wrong-actual-genre");
      const normalized = normalizeBeatportTrack(raw); assert.equal(normalized.id, lead.beatportTrackId); assert.equal(normalized.genre, "Bass House"); assert.ok(normalized.artistIds?.length && normalized.artistIds.every(id => /^[1-9]\d*$/.test(id)));
      attempt.freshBeatportRecord = { id: normalized.id, genreId: "91", raw, rawSha256: sha(Buffer.from(JSON.stringify(raw))) }; persist();
      const track = canonicalTrack(await tidal.getTrack(lead.tidalId, query)); assert.equal(track.tidalId, lead.tidalId);
      const requested = { artist: normalized.artist, title: normalized.title, mixVersion: normalized.mixName || "", beatportTrackId: normalized.id, isrc: normalized.isrc, durationMs: normalized.durationMs };
      assert.equal(coarseCandidateReason(requested, track), null, "canonical-descriptor-conflict");
      const match = matchBeatportVersionToTidal(track, normalized, { allowVersionProxy: false, requestedBeatportTrackId: normalized.id });
      assert.ok(scoreTidalIdentity(requested, track).matched && match.matched && match.relation === "exact", "strict-canonical-identity-or-version-rejected");
      assert.ok(!excluded(track, request, progress.entries), "exposed-heldout-or-duplicate-recording");
      if (attempt.role === "anchor") assert.ok(!progress.anchors.some(key => artistCreditSetKey(progress.entries.find(entry => entry.track.identityKey === key).track.artist) === artistCreditSetKey(track.artist)), "duplicate-anchor-artist");
      const fetchedAudio = await beatport.fetchPreviewBuffer(normalized, { maxBytes: 20 * 1024 * 1024 }), bytes = fetchedAudio?.buffer instanceof Uint8Array ? fetchedAudio.buffer : fetchedAudio;
      assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024);
      const sourceSha256 = sha(bytes); assert.ok(!request.excludedSourceSha256.includes(sourceSha256) && !progress.entries.some(entry => entry.source.sourceSha256 === sourceSha256), "excluded-or-duplicate-source");
      const sourceFile = ownedPath(path.join(DIRECTORY, "audio", sourceSha256 + ".audio")); if (fs.existsSync(sourceFile)) assert.equal(sha(fs.readFileSync(sourceFile)), sourceSha256); else fs.writeFileSync(sourceFile, bytes, { flag: "wx" });
      const durationSeconds = probe(sourceFile), source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds, sourceTrack: normalized, allowVersionProxy: false });
      const metadata = { query, discoverySource: "exact Beatport genre catalogue resolved to canonical TIDAL", discoveryLane: "core", beatportGenre: "Bass House" };
      if (normalized.subGenre) metadata.beatportSubgenre = normalized.subGenre; if (normalized.label) metadata.label = normalized.label; if (Number.isFinite(normalized.bpm) && normalized.bpm > 0) metadata.bpm = normalized.bpm;
      const entry = { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: JSON.parse(JSON.stringify(track)) }, source, sourceFile, metadata };
      assertSonicSourceSnapshot(source, { track, audioBytes: fs.readFileSync(sourceFile) }); progress.entries.push(entry);
      progress.catalogProvenance.push({ identityKey: track.identityKey, beatportTrackId: normalized.id, sourceSnapshotKey: source.snapshotKey, genreId: "91", genreName: "Bass House", artistIds: normalized.artistIds, pageKey: "91:cached-detail" });
      (attempt.role === "anchor" ? progress.anchors : progress.candidates).push(track.identityKey); attempt.status = "frozen-exact"; attempt.identityKey = track.identityKey;
    } catch (error) { attempt.status = "unavailable"; attempt.reason = ["wrong-actual-genre", "canonical-descriptor-conflict", "strict-canonical-identity-or-version-rejected", "exposed-heldout-or-duplicate-recording", "duplicate-anchor-artist", "excluded-or-duplicate-source"].includes(error.message) ? error.message : "exact-source-unavailable"; }
    persist(); console.log(JSON.stringify({ supplementalExactSources: progress.entries.length, attempts: progress.attempts.length, modelRuns: 0 }));
  }
  assert.deepEqual(pins(), read(path.join(DIRECTORY, "supplement-code-receipt.json")));
  progress.complete = progress.anchors.length === 2 && progress.candidates.length === 6; persist(); console.log(JSON.stringify({ supplementComplete: progress.complete, exactSources: progress.entries.length, attempts: progress.attempts.length }));
}
function combine() {
  const base = read(path.join(DIRECTORY, "collection.json")), extra = read(path.join(DIRECTORY, "supplement-collection.json")), request = read(path.join(DIRECTORY, "request.json"));
  assert.equal(extra.complete, true); assert.equal(extra.entries.length, 8); const techno = base.genres.find(genre => genre.genreId === "92"); assert.equal(techno.anchorIdentityKeys.length, 2); assert.equal(techno.candidateIdentityKeys.length, 6);
  const evidence = { version: 1, kind: "catalog-fresh-combined-evidence", runs: [{ declaration: binding("request.json"), collection: binding("collection.json") }, { declaration: binding("supplement-request.json"), collection: binding("supplement-collection.json") }] };
  save(path.join(DIRECTORY, "collection-evidence.json"), evidence);
  const entries = [...extra.entries, ...base.entries], requests = request.requests.map(spec => { const anchors = spec.genreId === "91" ? extra.anchors : techno.anchorIdentityKeys, candidates = spec.genreId === "91" ? extra.candidates : techno.candidateIdentityKeys, key = anchors[spec.anchorOrdinal - 1], anchor = entries.find(entry => entry.track.identityKey === key); return { requestId: spec.requestId, anchorIdentityKey: key, candidateIdentityKeys: candidates, options: { scoringMode: "similar", request: "Find tracks like " + anchor.track.artist + " — " + anchor.track.title, anchorTrack: anchor.track, count: 3, allowPreviousSuggestions: false, allowPreviousFallback: false } }; });
  const pool = { version: 1, kind: "catalog-scout-pilot-pool", entries, requests, catalogProvenance: [...extra.catalogProvenance, ...base.catalogProvenance], collectionEvidence: binding("collection-evidence.json") };
  require("../src/sonicCatalogFreshReview").validatePool(pool, { artifactRoot: ROOT, requireBytes: true });
  save(path.join(DIRECTORY, "combined-pool.json"), pool); save(path.join(DIRECTORY, "combined-request.json"), { ...request, collectionEvidence: binding("collection-evidence.json") });
  save(path.join(DIRECTORY, "combined-coverage-audit.json"), { version: 1, fullGate: true, exactSources: 16, anchors: 4, candidates: 12, samplingGenreIds: ["91", "92"], sourceAttempts: base.attempts.length + extra.attempts.length, feedRunPreserved: true, supplementRunPreserved: true, localLibraryAudio: false, productionApplied: false });
  console.log(JSON.stringify({ combinedFullGate: true, exactSources: 16, sourceAttempts: base.attempts.length + extra.attempts.length }));
}
async function main(argv = process.argv.slice(2)) {
  assert.ok(argv.length === 1 && ["init", "collect", "combine"].includes(argv[0])); const lock = path.join(ROOT, "data/sonic-catalog-scout-pilot.lock"), token = randomUUID(); save(lock, { token, pid: process.pid, stage: "supplement-" + argv[0] });
  try { if (argv[0] === "init") return initialize(); if (argv[0] === "collect") return await collect(); return combine(); } finally { assert.equal(read(lock).token, token); fs.unlinkSync(lock); }
}
if (require.main === module) main().catch(() => { console.error("Supplemental catalogue stage failed; safe receipts retained, no automatic retry."); process.exitCode = 1; });
module.exports = { main };
