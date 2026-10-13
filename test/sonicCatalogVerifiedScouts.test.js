"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const source = require("../src/sonicCatalogVerifiedSource"), scouts = require("../src/sonicCatalogVerifiedScouts"), oldScouts = require("../src/sonicCatalogScouts");
const { analysisSpec } = require("../src/sonicAnalysisSpec");
function item(id, explicit = false) {
  const track = { identityKey: "tidal:" + id, tidalId: String(id), artist: "Artist " + id, title: "Signal " + id,
    album: "Release " + id, label: "Label " + id, releaseDate: "2026-01-01", isrc: "USAAA26" + String(id).padStart(5, "0"), durationMs: 360000 };
  if (explicit) track.mixVersion = "Original Mix";
  const snapshot = source.freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: Buffer.from("synthetic source " + id), durationSeconds: 120,
    sourceTrack: { id: String(10000 + id), artist: track.artist, title: track.title, mixName: "Original Mix", album: track.album,
      label: track.label, releaseDate: track.releaseDate, isrc: track.isrc, durationMs: 359500 }, allowVersionProxy: false });
  return { track, source: snapshot, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: track } };
}
function matrices(items, models = ["mert-30s"]) {
  return new Map(models.map(analyzer => { const spec = analysisSpec(analyzer); return [analyzer, { spec, records: new Map(items.map((item, i) => [item.track.identityKey,
    { identityKey: item.track.identityKey, analyzer, repo: spec.repo, specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate,
      dimensions: spec.dimensions, sourceSnapshotKey: item.source.snapshotKey, sourceSha256: item.source.sourceSha256, spans: item.source.spans,
      vector: Array.from({ length: spec.dimensions }, (_, j) => j === 0 ? 1 : j === 1 ? i / 10 : 0) }])) }]; }));
}
test("new scouts differ only by their source assertion import and preserve exact v1 results", () => {
  const originalText = fs.readFileSync(path.join(__dirname, "../src/sonicCatalogScouts.js"), "utf8");
  assert.equal(fs.readFileSync(path.join(__dirname, "../src/sonicCatalogVerifiedScouts.js"), "utf8"),
    originalText.replace('require("./sonicCandidateCorpus")', 'require("./sonicCatalogVerifiedSource")'));
  const values = [item(1, true), item(2, true), item(3, true)], anchor = values[0];
  const pool = scouts.freezeSonicCatalogScoutPool({ items: values.slice(1) });
  assert.deepEqual(pool, oldScouts.freezeSonicCatalogScoutPool({ items: values.slice(1) }));
  const options = { anchor, pool, matrices: matrices(values), selector: "mert-30s", mode: "observe", scoutCount: 6, finalCount: 3 };
  assert.deepEqual(scouts.buildSonicCatalogScouts(options), oldScouts.buildSonicCatalogScouts(options));
});
test("verified original v2 sources support one exact 30s space without negative missing FullSong votes", () => {
  const values = [item(1), item(2), item(3)], before = structuredClone(values), pool = scouts.freezeSonicCatalogScoutPool({ items: values });
  const result = scouts.buildSonicCatalogScouts({ anchor: values[0], pool, matrices: matrices(values), selector: "mert-30s", mode: "observe", scoutCount: 6, finalCount: 3 });
  assert.deepEqual(result.scouts.map(track => track.identityKey), ["tidal:2", "tidal:3"]);
  assert.equal(result.diagnostics.fallback, false); assert.equal(result.diagnostics.excludedSelfCount, 1); assert.equal(result.diagnostics.vectorSpacesMixed, false);
  assert.equal(result.diagnostics.missingCoverageIsNegative, false); assert.equal(result.productionApplied, false); assert.equal(result.queueable, false);
  assert.ok(result.scouts.every(track => track.sonicScout.nominations.length === 1 && track.sonicScout.nominations[0].analyzer === "mert-30s"));
  assert.doesNotMatch(JSON.stringify(result.scouts), /sourceSha256|equivalenceProof|sourceTrack|snapshotKey/); assert.deepEqual(values, before);
});
test("stale v2 evidence cannot enter a frozen pool or be borrowed by a different model record", () => {
  const values = [item(1), item(2), item(3)], pool = scouts.freezeSonicCatalogScoutPool({ items: values.slice(1) });
  const corrupt = structuredClone(values[1]); corrupt.source.equivalenceProof.durationDeltaMs = 0;
  assert.throws(() => scouts.freezeSonicCatalogScoutPool({ items: [corrupt] }));
  for (const field of ["sourceSnapshotKey", "sourceSha256", "specKey", "repo", "revision"]) {
    const matrix = matrices(values); matrix.get("mert-30s").records.get("tidal:2")[field] = "changed";
    assert.throws(() => scouts.buildSonicCatalogScouts({ anchor: values[0], pool, matrices: matrix, selector: "mert-30s", mode: "observe" }));
  }
  const cold = scouts.buildSonicCatalogScouts({ anchor: values[0], pool, matrices: new Map(), selector: "mert-30s", mode: "observe" });
  assert.equal(cold.scouts.length, 0); assert.equal(cold.diagnostics.neutral, true); assert.equal(cold.diagnostics.fallback, true);
});
