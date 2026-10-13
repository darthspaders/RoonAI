"use strict";
// New explicit single-genre listening scope after closed, insufficient combined
// coverage. Preserves both failed runs and uses only the complete fresh genre.
const path = require("node:path"), fs = require("node:fs"), assert = require("node:assert/strict");
const fresh = require("./sonic-catalog-scout-fresh"), { DIRECTORY, ROOT, sha, read, save } = fresh;
const binding = name => ({ file: path.join(DIRECTORY, name), sha256: sha(fs.readFileSync(path.join(DIRECTORY, name))) });
function main() {
  const collection = read(path.join(DIRECTORY, "collection.json")), supplement = read(path.join(DIRECTORY, "supplement-collection.json")), original = read(path.join(DIRECTORY, "request.json"));
  assert.equal(read(path.join(DIRECTORY, "coverage-audit.json")).fullGate, false); assert.equal(supplement.complete, false);
  const genre = collection.genres.find(row => row.genreId === "92"); assert.equal(genre.anchorIdentityKeys.length, 2); assert.equal(genre.candidateIdentityKeys.length, 6);
  assert.equal(collection.entries.length, 8); assert.ok(collection.catalogProvenance.every(row => row.genreId === "92"));
  save(path.join(DIRECTORY, "scoped-declaration.json"), { version: 1, createdAt: new Date().toISOString(), samplingScope: "raw-techno-only", purpose: "Fresh techno excerpt candidate-fit listening; Bass House coverage is not established",
    sourceCount: 8, anchorCount: 2, sharedCandidates: 6, maximumModelRuns: 8, analyzer: "mert-30s", maximumBlindPairs: 6, maximumFinalPicksPerAnchor: 3,
    combinedGenreCoveragePassed: false, bassHouseCoveragePassed: false, originalFullGate: binding("coverage-audit.json"), closedFeedRun: binding("collection.json"), closedSupplementRun: binding("supplement-collection.json"),
    sourceSelection: "Entire predeclared complete genre92 sample; no listening labels or score tuning used to select sources", localLibraryAudio: false, heldOutValidation: false, productionApplied: false, productionPromotionAllowed: false });
  save(path.join(DIRECTORY, "scoped-collection-evidence.json"), { version: 1, kind: "catalog-fresh-combined-evidence", runs: [{ declaration: binding("request.json"), collection: binding("collection.json") }] });
  const requests = original.requests.filter(row => row.genreId === "92").map(spec => { const key = genre.anchorIdentityKeys[spec.anchorOrdinal - 1], anchor = collection.entries.find(entry => entry.track.identityKey === key); return { requestId: spec.requestId, anchorIdentityKey: key, candidateIdentityKeys: genre.candidateIdentityKeys, options: { scoringMode: "similar", request: "Find tracks like " + anchor.track.artist + " — " + anchor.track.title, anchorTrack: anchor.track, count: 3, allowPreviousSuggestions: false, allowPreviousFallback: false } }; });
  const pool = { version: 1, kind: "catalog-scout-pilot-pool", samplingScope: "raw-techno-only", entries: collection.entries, requests, catalogProvenance: collection.catalogProvenance, collectionEvidence: binding("scoped-collection-evidence.json") };
  require("../src/sonicCatalogFreshReview").validatePool(pool, { artifactRoot: ROOT, requireBytes: true });
  save(path.join(DIRECTORY, "scoped-pool.json"), pool); save(path.join(DIRECTORY, "scoped-request.json"), { ...original, samplingScope: "raw-techno-only", scopedDeclaration: binding("scoped-declaration.json") });
  save(path.join(DIRECTORY, "scoped-coverage-audit.json"), { version: 1, samplingScope: "raw-techno-only", scopeGate: true, originalCombinedFullGate: false, sourceCount: 8, anchorCount: 2, sharedCandidates: 6, maximumModelRuns: 8, maximumBlindPairs: 6, sourceAttemptsAcrossClosedRuns: collection.attempts.length + supplement.attempts.length, bassHouseCoveragePassed: false, productionApplied: false });
  console.log(JSON.stringify({ scopePrepared: true, freshSources: 8, anchors: 2, maximumBlindPairs: 6, bassHouseCoveragePassed: false }));
}
if (require.main === module) { try { main(); } catch { console.error("Fresh scoped declaration failed; earlier results preserved."); process.exitCode = 1; } }
module.exports = { main };
