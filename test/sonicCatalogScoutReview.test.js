"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const { SonicBlindReview } = require("../src/sonicBlindReview");
const { createSonicReviewSessionService } = require("../src/sonicReviewSessionService");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus");
const { buildCatalogScoutReviewPlan, validateCatalogScoutReviewPlan, KIND, ARMS } = require("../src/sonicCatalogScoutReview");
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), clone = value => JSON.parse(JSON.stringify(value));
function wav(seconds = 30) {
  const samples = Math.round(seconds * 24000), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-scout-review-")), data = path.join(directory, "data"), cache = path.join(data, "wav");
  fs.mkdirSync(cache, { recursive: true });
  const db = new DatabaseSync(":memory:"), store = new SonicEmbeddingStore({ enabled: false }); Object.assign(store, { enabled: true, db }); store.migrate();
  const service = new SonicBlindReview(db, { cacheDirectory: cache, artifactRoot: directory });
  let profileWrites = 0;
  const legacy = createSonicReviewSessionService({ db, recommendationEngine: { saveSonicAnchorProfile() { profileWrites++; } }, logger: null });
  db.exec("CREATE TABLE taste_feedback (id INTEGER)");
  t.after(() => { db.close(); const relative = path.relative(os.tmpdir(), directory); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); fs.rmSync(directory, { recursive: true, force: true }); });
  const code = path.join(directory, "code.js"); fs.writeFileSync(code, "// sealed test finalizer\n");
  function entry(id) {
    const track = { identityKey: `tidal:${id}`, tidalId: String(id), artist: `Artist ${id}`, title: `Song ${id}`, mixVersion: "Original Mix", durationMs: 360000, isrc: `USAAA260${String(id).padStart(4, "0")}` };
    const bytes = Buffer.from(`exact-preview-${id}`), sourceFile = path.join(data, `${id}.audio`); fs.writeFileSync(sourceFile, bytes);
    const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds: 60,
      sourceTrack: { id: String(id + 1000), artist: track.artist, title: track.title, mixName: track.mixVersion, isrc: track.isrc, durationMs: track.durationMs }, allowVersionProxy: false });
    return { track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) }, source: clone(source), sourceFile };
  }
  const entries = [1, 2, 10, 11, 12, 13, 14, 15].map(entry), byId = new Map(entries.map(value => [value.track.identityKey, value]));
  const selected = ids => ids.map(id => ({ track: clone(byId.get(`tidal:${id}`).track), score: 80 - id }));
  const pool = { version: 1, kind: "catalog-scout-pilot-pool", entries,
    requests: [1, 2].map(id => ({ requestId: `request-${id}`, anchorIdentityKey: `tidal:${id}`, candidateIdentityKeys: [10, 11, 12, 13, 14, 15].map(n => `tidal:${n}`), options: { scoringMode: "similar", request: "Find similar tracks" } })) };
  const comparison = { version: 1, recipe: { kind: "catalog-scout-end-to-end", finalCount: 3, scoutCount: 6, agreementWeight: 0, productionApplied: false },
    code: { files: [{ path: "code.js", sha256: hash(fs.readFileSync(code)) }] },
    requests: pool.requests.map(request => ({ requestId: request.requestId, anchorIdentityKey: request.anchorIdentityKey, arms: {
      "current-production": { tracks: selected([10, 11, 12]) }, "mert-fullsong": { tracks: selected([10, 11, 13]) },
      "mert-30s": { tracks: selected([10, 14, 15]) }, ensemble: { tracks: selected([10, 13, 14]) } } })) };
  const poolFile = path.join(data, "pool.json"), comparisonFile = path.join(data, "comparison.json");
  const seal = () => { fs.writeFileSync(poolFile, JSON.stringify(pool)); fs.writeFileSync(comparisonFile, JSON.stringify(comparison));
    return { pool: { file: poolFile, sha256: hash(fs.readFileSync(poolFile)) }, comparison: { file: comparisonFile, sha256: hash(fs.readFileSync(comparisonFile)) } }; };
  const build = (extra = {}) => buildCatalogScoutReviewPlan({ roundId: "scout-test", ...seal(), ...extra }, { artifactRoot: directory });
  const prepare = plan => { for (const clip of Object.values(plan.clips)) { const bytes = wav(clip.end - clip.start); clip.wavSha256 = hash(bytes); fs.writeFileSync(path.join(cache, `${clip.clipId}.wav`), bytes); } return plan; };
  return { directory, data, cache, code, db, service, legacy, pool, comparison, build, prepare, seal, selected, profileWrites: () => profileWrites };
}
test("v5 derives only actual differing selections and freezes shuffled order without input mutation", t => {
  const f = fixture(t), before = clone({ pool: f.pool, comparison: f.comparison }), plan = f.build();
  assert.deepEqual({ pool: f.pool, comparison: f.comparison }, before); assert.equal(plan.version, 5); assert.equal(plan.kind, KIND);
  assert.equal(plan.count, 10); assert.equal(plan.excludedCommonPairs, 2); assert.equal(Object.keys(plan.clips).length, 7);
  assert.ok(plan.groups.every(group => group.candidates.every(candidate => candidate.track.identityKey !== "tidal:10")));
  assert.equal(validateCatalogScoutReviewPlan(plan, { artifactRoot: f.directory }), true);
  const altered = clone(plan); altered.groups[0].candidates.reverse(); assert.throws(() => validateCatalogScoutReviewPlan(altered, { artifactRoot: f.directory }), /plan identity/);
});
test("all-identical lists need no review and identical requests are omitted", t => {
  const f = fixture(t);
  for (const arm of ARMS) f.comparison.requests[1].arms[arm].tracks = f.selected([10, 11, 12]);
  const plan = f.build(); assert.equal(plan.anchorCount, 1); assert.equal(plan.requestCount, 2); assert.equal(plan.excludedCommonPairs, 4);
  for (const arm of ARMS) f.comparison.requests[0].arms[arm].tracks = f.selected([10, 11, 12]); assert.equal(f.build(), null);
});
test("partial arms retain missing slots without forced fillers or negative votes", t => {
  const f = fixture(t); f.pool.requests.splice(1); f.comparison.requests.splice(1);
  const arms = f.comparison.requests[0].arms;
  arms["current-production"].tracks = f.selected([10]); arms["mert-fullsong"].tracks = f.selected([11]); arms["mert-30s"].tracks = f.selected([10]); arms.ensemble.tracks = [];
  const plan = f.prepare(f.build()); assert.equal(plan.count, 2); assert.deepEqual(plan.armSlots, { "current-production": 1, "mert-fullsong": 1, "mert-30s": 1, ensemble: 0 });
  f.service.create(plan); for (const group of plan.groups) for (const [index] of group.candidates.entries()) f.service.save({ batchId: plan.batchId, sessionId: group.sessionId, index, decision: "KEEP", listened: true });
  const result = f.service.report(plan.batchId); assert.equal(result.ready, true); const ensemble = result.arms.find(arm => arm.analyzer === "ensemble");
  assert.equal(ensemble.missingSlots, 3); assert.equal(ensemble.differingNominations, 0); assert.equal(ensemble.decisions.WRONG_LANE, 0);
  assert.doesNotMatch(JSON.stringify(result), /keepRate|acceptanceRate|precision/i);
});
test("comparison, pool and code byte changes fail before publication", t => {
  const f = fixture(t), plan = f.prepare(f.build());
  const comparisonFile = plan.comparison.file, original = fs.readFileSync(comparisonFile); fs.appendFileSync(comparisonFile, " ");
  assert.throws(() => f.service.create(plan), /comparison or pool changed/); fs.writeFileSync(comparisonFile, original);
  fs.appendFileSync(f.code, "// altered\n"); assert.throws(() => f.service.create(plan), /code changed/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n, 0);
});
test("wrong final descriptors, candidate eligibility, duplicate or fabricated arm ranks are rejected", t => {
  for (const alter of [f => f.comparison.requests[0].arms["mert-fullsong"].tracks[0].track.mixVersion = "Named Other Remix",
    f => f.pool.requests[0].candidateIdentityKeys = ["tidal:15"], f => f.comparison.requests[0].arms.ensemble.tracks = f.selected([10, 10]),
    f => f.comparison.requests[0].arms.fake = { tracks: [] }, f => f.comparison.requests[0].arms.ensemble.tracks = f.selected([10, 11, 12, 13])]) {
    const f = fixture(t); alter(f); assert.throws(() => f.build());
  }
  const f = fixture(t), plan = f.build(), nomination = plan.groups[0].candidates[0].nominations[0]; nomination.rank = nomination.rank === 1 ? 2 : 1;
  assert.throws(() => validateCatalogScoutReviewPlan(plan, { artifactRoot: f.directory }), /arm ranks/);
});
test("exact-self, proxy sources and relabeled source evidence fail closed", t => {
  for (const alter of [f => f.pool.requests[0].candidateIdentityKeys.push("tidal:1"), f => f.pool.entries[0].source.allowVersionProxy = true,
    f => f.pool.entries[0].track.title = "Relabeled", f => f.pool.entries[0].verification.verified = false,
    f => f.pool.entries[0].source.spans = [[0, 30]]]) { const f = fixture(t); alter(f); assert.throws(() => f.build()); }
});
test("private files and code cannot escape the declared artifact root", t => {
  const f = fixture(t); f.pool.entries[0].sourceFile = __filename; assert.throws(() => f.build(), /private root/);
  f.pool.entries[0].sourceFile = path.join(f.data, "1.audio"); f.comparison.code.files[0].path = "../external.js"; assert.throws(() => f.build(), /code receipt/);
});
test("genuine catalog admission metadata stays independent of canonical source identity", t => {
  const f = fixture(t); f.pool.entries[0].metadata = { query: "first predeclared artist query", discoverySource: "TIDAL catalog", discoveryLane: "core", beatportGenre: "Bass House", beatportSubgenre: "Exact source subgenre", label: "Exact source label", bpm: 128 };
  const original = clone(f.pool.entries[0].track), plan = f.build(); assert.deepEqual(plan.groups[0].anchor, original);
  assert.equal(plan.groups[0].anchorReference.source.snapshotKey, f.pool.entries[0].source.snapshotKey);
  for (const bpm of [0, -1, null, "128", Infinity]) {
    const invalid = fixture(t); invalid.pool.entries[0].metadata = { bpm }; assert.throws(() => invalid.build(), /catalog bpm/);
  }
  assert.equal(plan.groups[0].anchor.genre, undefined);
});
test("publication verifies original source bytes and every prepared WAV atomically", t => {
  const f = fixture(t), plan = f.build(); assert.throws(() => f.service.create(plan), /prepared/);
  f.prepare(plan); const source = f.pool.entries[0].sourceFile, original = fs.readFileSync(source); fs.writeFileSync(source, "changed-source");
  assert.throws(() => f.service.create(plan), /bytes changed/); fs.writeFileSync(source, original);
  const clip = Object.values(plan.clips)[0], file = path.join(f.cache, `${clip.clipId}.wav`), bytes = fs.readFileSync(file); bytes[100] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => f.service.create(plan), /WAV changed/); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n, 0);
});
test("source/spec-like private attribution stays absent in public and legacy paths until completion", t => {
  const f = fixture(t), plan = f.prepare(f.build()), result = f.service.create(plan); assert.equal(result.batch.kind, KIND);
  assert.equal(f.service.report(plan.batchId).ready, false);
  const outputs = [result, f.service.report(plan.batchId), f.legacy.listReviewSessions(), ...plan.groups.flatMap(group => [
    f.legacy.getReviewSession(group.sessionId, { includeDiagnostics: true, includeCurrent: true, includeAnchorContext: true }),
    f.legacy.getNextReviewItem(group.sessionId), f.legacy.getAssistantReviewContext(group.sessionId)])];
  for (const output of outputs) assert.doesNotMatch(JSON.stringify(output), /tidal:\d|tidalId":"\d|isrc":"US|sourceFile|sourceSha256|sourceSnapshot|wavSha256|nominations|current-production|mert-fullsong|agreementWeight|comparison\.json|pool\.json/i);
  for (const group of result.batch.groups) { assert.equal(group.anchorAudio.start, 0); assert.equal(group.anchorAudio.end, 30); assert.equal(group.anchor.identityKey, undefined); for (const item of group.items) assert.equal(item.audio.start, 0); }
  assert.equal(f.profileWrites(), 0); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_neighbor_feedback").get().n, 0);
});
test("completed report requires human listening and reports only differing-subset counts", async t => {
  const f = fixture(t), plan = f.prepare(f.build()); f.service.create(plan);
  for (const group of plan.groups) for (const [index] of group.candidates.entries()) f.service.save({ batchId: plan.batchId, sessionId: group.sessionId, index,
    decision: index === 0 ? "UNSURE" : "KEEP", listened: index !== 0 });
  const report = f.service.report(plan.batchId); assert.equal(report.ready, true); assert.equal(report.comparisonScope, "differing-final-selections-only"); assert.equal(report.excludedCommonPairs, 2);
  for (const arm of report.arms) { assert.equal(arm.selectedSlots, 6); assert.equal(arm.differingNominations, 4); assert.equal(arm.omittedCommonNominations, 2); }
  assert.doesNotMatch(JSON.stringify(report), /keepRate|acceptanceRate|sourceSha256|sourceFile|agreementWeight|tidal:\d/i);
  const input = { batchId: plan.batchId, sessionId: plan.groups[0].sessionId, index: 0, decision: "UNSURE", listened: false };
  f.service.save(input); assert.equal(f.service.create(plan).batch.completed, 10);
  await assert.rejects(f.legacy.saveReviewItem({ ...input, profile: { energy: 3 } }), /blind listening/);
  await assert.rejects(f.legacy.rateReviewItem({ ...input, rating: "love" }), /global ratings/);
  f.db.prepare("UPDATE sonic_review_session_item SET review_json=? WHERE session_id=? AND item_index=0").run(JSON.stringify({ decision: "KEEP", listened: true, reviewer: "assistant" }), plan.groups[0].sessionId);
  assert.equal(f.service.report(plan.batchId).ready, false);
});
test("previous exposure excludes exact, recording-group and ISRC-alias anchors without changing prior rows", t => {
  const f = fixture(t), plan = f.prepare(f.build()), original = clone(plan.groups[0].anchor); original.identityKey = "text:old-alias"; original.artist = "Different catalog credit";
  const prior = { version: 2, groups: [{ anchor: original, anchorClip: "old", candidates: [] }], clips: { old: { sourceSha256: hash("old-other-source") } } };
  const json = JSON.stringify(prior); f.db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?,?,?)").run("blind:old", "old-key", json, "2026-10-01");
  assert.throws(() => f.service.create(plan), /unexposed/); assert.equal(f.db.prepare("SELECT private_plan_json FROM sonic_blind_review_batch WHERE batch_id='blind:old'").get().private_plan_json, json);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session").get().n, 0);
});
