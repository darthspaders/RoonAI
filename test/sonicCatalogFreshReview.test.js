"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const { freezeSonicSourceSnapshot } = require("../src/sonicCandidateCorpus"), { analysisSpec } = require("../src/sonicAnalysisSpec");
const { createPrivateResultReceipt } = require("../src/sonicAnchorExperiment");
const { KIND, ANALYZER, freshReviewCodeReceipt, validatePool, buildFreshCatalogScoutSelections, buildFreshCatalogReviewPlan,
  validateFreshCatalogReviewPlan, getFreshCatalogReviewSnapshot, completedFreshCatalogReport } = require("../src/sonicCatalogFreshReview");
const ROOT = path.resolve(__dirname, ".."), clone = value => JSON.parse(JSON.stringify(value));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function wave(seconds = 30) {
  const samples = Math.round(seconds * 24000), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}
async function fixture(t, { cached = false, samplingScope } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-fresh-review-")), data = path.join(directory, "data"), wav = path.join(data, "wav");
  fs.mkdirSync(wav, { recursive: true });
  t.after(() => { const relative = path.relative(os.tmpdir(), directory); assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)); fs.rmSync(directory, { recursive: true, force: true }); });
  const code = freshReviewCodeReceipt();
  for (const row of code.files) { const file = path.join(directory, row.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(ROOT, row.path), file); }
  const groups = [{ genreId: "91", genreName: "Bass House", anchorIds: [1, 2], candidateIds: [10, 11, 12, 13, 14, 15] },
    { genreId: "92", genreName: "Techno (Raw / Deep / Hypnotic)", anchorIds: [101, 102], candidateIds: [110, 111, 112, 113, 114, 115] }];
  const pool = { version: 1, kind: "catalog-scout-pilot-pool", ...(samplingScope ? { samplingScope } : {}), entries: [], requests: [], catalogProvenance: [] }, receipts = new Map();
  for (const genre of samplingScope === "raw-techno-only" ? groups.slice(1) : groups) {
    const ids = [...genre.anchorIds, ...genre.candidateIds];
    ids.forEach((id, index) => {
      const track = { identityKey: `tidal:${id}`, tidalId: String(id), artist: `North Circuit ${id}`, title: `Signal ${id}`,
        mixVersion: "Original Mix", durationMs: 360000, isrc: `USAAA26${String(id).padStart(5, "0")}`, label: "Circuit Records" };
      const bytes = Buffer.from(`exact-preview-fixture-${id}`), sourceFile = path.join(data, `${id}.audio`); fs.writeFileSync(sourceFile, bytes);
      const source = freezeSonicSourceSnapshot({ track, sourceType: "beatport-preview", audioBytes: bytes, durationSeconds: 120.032653,
        sourceTrack: { id: String(id + 1000), artist: track.artist, title: track.title, mixName: track.mixVersion, durationMs: track.durationMs, isrc: track.isrc, label: track.label }, allowVersionProxy: false });
      const pageKey = cached && genre.genreId === "91" ? "91:cached-detail" : genre.genreId + ":top";
      pool.entries.push({ track, verification: { provider: "tidal", verified: true, identityKey: track.identityKey, canonicalTrack: clone(track) }, source: clone(source), sourceFile,
        metadata: { query: pageKey === "91:cached-detail" ? "Beatport genre91 cached lead freshly verified by exact track detail" : `Beatport genre ${genre.genreId} top page 1`,
          discoverySource: pageKey === "91:cached-detail" ? "fresh exact Beatport track detail resolved to canonical TIDAL" : "exact Beatport genre catalogue resolved to canonical TIDAL",
          discoveryLane: "core", beatportGenre: genre.genreName, label: track.label } });
      pool.catalogProvenance.push({ identityKey: track.identityKey, beatportTrackId: source.sourceTrackId, sourceSnapshotKey: source.snapshotKey,
        genreId: genre.genreId, genreName: genre.genreName, artistIds: [String(8000 + id)], pageKey });
      const vector = Array(1024).fill(0), axis = genre.genreId === "91" ? 0 : 2, second = index === 0 ? 0 : index * .04;
      vector[axis] = Math.sqrt(1 - second ** 2); vector[axis + 1] = second;
      const spec = analysisSpec(ANALYZER), result = { specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate,
        audioDurationSeconds: source.durationSeconds, analyzedSeconds: 30, sourceCoverage: 30 / source.durationSeconds, vector,
        segments: [{ start: source.spans[0][0] - .000001, end: source.spans[0][1] - .000001, vector: [...vector] }] };
      receipts.set(track.identityKey, createPrivateResultReceipt(result, spec, source));
    });
    genre.anchorIds.forEach((id, index) => { const anchor = pool.entries.find(entry => entry.track.identityKey === `tidal:${id}`).track;
      pool.requests.push({ requestId: (genre.genreId === "91" ? "bass-house-" : "raw-techno-") + (index + 1), anchorIdentityKey: anchor.identityKey,
        candidateIdentityKeys: genre.candidateIds.map(id => `tidal:${id}`), options: { scoringMode: "similar", request: `Find tracks like ${anchor.artist} — ${anchor.title}`,
          anchorTrack: clone(anchor), count: 3, allowPreviousSuggestions: false, allowPreviousFallback: false } }); });
  }
  const request = { version: 1, ...(samplingScope ? { samplingScope } : {}), heldOut: Array.from({ length: 6 }, (_, index) => ({ identityKey: `text:reserved-${index}`, artist: `Reserved ${index}`, title: `Reserved work ${index}` })), excluded: [], excludedSourceSha256: [] };
  const bind = (file, value) => { fs.writeFileSync(file, JSON.stringify(value)); return { file, sha256: hash(fs.readFileSync(file)) }; };
  const collectionFile = path.join(data, "collection-evidence.json");
  const bindCollections = () => {
    const chunks = cached ? [pool.entries.filter(entry => entry.metadata.beatportGenre !== "Bass House"), pool.entries.filter(entry => entry.metadata.beatportGenre === "Bass House")] : [pool.entries];
    const runs = chunks.map((entries, index) => { const declaration = bind(path.join(data, `declaration-${index}.json`), { version: 1, phase: index });
      const collection = bind(path.join(data, `collection-${index}.json`), { requestSha256: declaration.sha256, entries: clone(entries),
        catalogProvenance: clone(pool.catalogProvenance.filter(row => entries.some(entry => entry.track.identityKey === row.identityKey))) }); return { declaration, collection }; });
    pool.collectionEvidence = bind(collectionFile, { version: 1, kind: "catalog-fresh-combined-evidence", runs });
  };
  bindCollections();
  const selected = await buildFreshCatalogScoutSelections({ pool, receipts, request, code }, { artifactRoot: directory });
  const files = { pool: path.join(data, "pool.json"), selections: path.join(data, "selections.json"), request: path.join(data, "combined-request.json") };
  const bindings = () => ({ pool: bind(files.pool, pool), selections: bind(files.selections, selected), request: bind(files.request, request) });
  const build = () => buildFreshCatalogReviewPlan({ roundId: "fresh-test", ...bindings() }, { artifactRoot: directory });
  const prepare = plan => { for (const clip of Object.values(plan.clips)) { const bytes = wave(); clip.wavSha256 = hash(bytes); fs.writeFileSync(path.join(wav, clip.clipId + ".wav"), bytes); } return plan; };
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sonic_blind_review_batch(batch_id TEXT,private_plan_json TEXT); CREATE TABLE sonic_review_session_item(session_id TEXT,item_index INTEGER,candidate_identity_key TEXT,status TEXT,decision TEXT,review_json TEXT); CREATE TABLE sonic_neighbor_feedback(candidate_identity_key TEXT)");
  t.after(() => db.close());
  const seed = (plan, judged = false) => { for (const group of plan.groups) for (const [index] of group.candidates.entries()) db.prepare("INSERT INTO sonic_review_session_item VALUES (?,?,? ,?,?,?)").run(group.sessionId, index, "opaque:" + index, judged ? "REVIEWED" : "PENDING", judged ? "KEEP" : null,
    judged ? JSON.stringify({ decision: "KEEP", listened: true, reviewer: "human", evidence: "blind-listening", note: "", globalRatingChanged: false }) : null); };
  return { directory, data, wav, pool, receipts, request, selected, code, files, db, bind, bindCollections, bindings, build, prepare, seed };
}
test("single pinned 30s receipts feed the actual frozen finalizer, without input mutation or FullSong coverage", async t => {
  const f = await fixture(t), before = clone(f.pool);
  assert.equal(f.selected.recipe.analyzer, "mert-30s"); assert.deepEqual(f.selected.recipe.spec, analysisSpec("mert-30s"));
  assert.equal(f.selected.sourceEvidence.length, 16); assert.ok(f.selected.requests.every(row => row.scouts.length === 6 && row.tracks.length <= 3));
  assert.ok(f.selected.requests.every(row => row.verification.catalogScoutReplay.historyWrites === 0 && row.verification.catalogScoutReplay.providersQueried === false));
  assert.equal(f.selected.requests.reduce((sum, row) => sum + row.tracks.length, 0), 12);
  const repeat = await buildFreshCatalogScoutSelections({ pool: f.pool, receipts: f.receipts, request: f.request, code: f.code }, { artifactRoot: f.directory });
  assert.deepEqual(repeat.requests.map(row => ({ scouts: row.scouts, tracks: row.tracks })), f.selected.requests.map(row => ({ scouts: row.scouts, tracks: row.tracks })));
  assert.deepEqual(repeat.sourceEvidence, f.selected.sourceEvidence); assert.deepEqual(repeat.recipe, f.selected.recipe); assert.deepEqual(f.pool, before);
});
test("missing, other-model, changed-source and changed-span receipts fail before selection", async t => {
  const f = await fixture(t), key = f.pool.entries[0].track.identityKey, original = clone(f.receipts.get(key));
  for (const edit of [receipts => receipts.delete(key), receipts => receipts.get(key).specKey = analysisSpec("mert-fullsong").key,
    receipts => receipts.get(key).sourceSha256 = hash("different"), receipts => { const raw = receipts.get(key); raw.result.segments[0].start += .01; raw.resultSha256 = hash(JSON.stringify(raw.result)); }]) {
    const receipts = new Map([...f.receipts].map(([key, value]) => [key, clone(value)])); edit(receipts);
    await assert.rejects(buildFreshCatalogScoutSelections({ pool: f.pool, receipts, code: f.code }, { artifactRoot: f.directory }));
  }
  assert.deepEqual(f.receipts.get(key), original);
});
test("complete sixteen-source balanced sampling and actual genre provenance are mandatory", async t => {
  const f = await fixture(t);
  for (const edit of [pool => pool.entries.pop(), pool => pool.requests[0].candidateIdentityKeys.pop(), pool => pool.requests[1].candidateIdentityKeys.reverse(),
    pool => pool.catalogProvenance[0].genreId = "92", pool => pool.requests[0].options.genres = "bass house", pool => pool.entries[0].source.allowVersionProxy = true]) {
    const pool = clone(f.pool); edit(pool); assert.throws(() => validatePool(pool, { artifactRoot: f.directory }));
  }
});
test("two separately declared collection receipts permit truthful fresh verified cached-detail leads", async t => {
  const f = await fixture(t, { cached: true }), plan = f.build(); assert.equal(plan.count, 12); assert.equal(validateFreshCatalogReviewPlan(plan, { artifactRoot: f.directory }), true);
  const evidence = readFile(f.pool.collectionEvidence.file), source = evidence.runs[1].collection.file;
  fs.appendFileSync(source, " "); assert.throws(() => validateFreshCatalogReviewPlan(plan, { artifactRoot: f.directory }), /artifact changed/);
});
function readFile(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
test("frozen scout ranks, final membership, model spec and actual-finalizer proof cannot be relabeled", async t => {
  const f = await fixture(t), original = clone(f.selected);
  for (const edit of [selected => selected.requests[0].scouts[0].similarity += .01, selected => selected.requests[0].tracks[0].track.title = "Wrong Remix",
    selected => selected.requests[0].tracks[0] = { track: clone(f.pool.entries.find(entry => entry.track.identityKey === "tidal:110").track) },
    selected => selected.recipe.spec = analysisSpec("mert-fullsong"), selected => selected.requests[0].verification.catalogScoutReplay.historyWrites = 1]) {
    Object.assign(f.selected, clone(original)); edit(f.selected); assert.throws(() => f.build());
  }
});
test("held-out identity aliases, ISRC aliases and excluded bytes independently prevent publication", async t => {
  const f = await fixture(t), entry = f.pool.entries[0], before = clone(f.request);
  for (const edit of [request => request.heldOut[0] = clone(entry.track), request => request.excluded.push({ ...clone(entry.track), identityKey: "text:different" }),
    request => request.excluded.push({ identityKey: "text:alias", artist: "Different credit", title: "Different name", isrc: entry.track.isrc }), request => request.excludedSourceSha256.push(entry.source.sourceSha256)]) {
    Object.assign(f.request, clone(before)); edit(f.request); assert.throws(() => f.build(), /Excluded or held-out/);
  }
});
test("plan freezes candidate order, batch identity and session identities; preparing WAVs preserves its fingerprint", async t => {
  const f = await fixture(t), plan = f.build(), key = plan.planKey; f.prepare(plan); assert.equal(plan.planKey, key);
  assert.equal(validateFreshCatalogReviewPlan(plan, { db: f.db, requirePrepared: true, artifactRoot: f.directory, cacheDirectory: f.wav }), true);
  for (const edit of [plan => plan.groups[0].candidates.reverse(), plan => plan.groups[0].sessionId += "changed", plan => plan.batchId += "changed"]) {
    const altered = clone(plan); edit(altered); assert.throws(() => validateFreshCatalogReviewPlan(altered, { artifactRoot: f.directory }), /plan order or session/);
  }
});
test("publication checks original bytes, every WAV and query-only main review freshness without DB mutation", async t => {
  const f = await fixture(t), plan = f.build(); assert.throws(() => validateFreshCatalogReviewPlan(plan, { db: f.db, requirePrepared: true, artifactRoot: f.directory, cacheDirectory: f.wav }), /Prepare every/);
  f.prepare(plan); const source = f.pool.entries[0].sourceFile, bytes = fs.readFileSync(source); fs.writeFileSync(source, "changed-source");
  assert.throws(() => validateFreshCatalogReviewPlan(plan, { db: f.db, requirePrepared: true, artifactRoot: f.directory, cacheDirectory: f.wav }), /bytes changed/); fs.writeFileSync(source, bytes);
  const clip = Object.values(plan.clips)[0], wav = path.join(f.wav, clip.clipId + ".wav"), original = fs.readFileSync(wav), corrupted = Buffer.from(original); corrupted[100] ^= 1; fs.writeFileSync(wav, corrupted);
  assert.throws(() => validateFreshCatalogReviewPlan(plan, { db: f.db, requirePrepared: true, artifactRoot: f.directory, cacheDirectory: f.wav }), /WAV changed/); fs.writeFileSync(wav, original);
  const prior = { groups: [{ anchor: { ...clone(f.pool.entries[0].track), identityKey: "text:old" }, anchorClip: "old", candidates: [] }], clips: { old: { sourceSha256: hash("different-old-bytes") } } };
  f.db.prepare("INSERT INTO sonic_blind_review_batch VALUES (?,?)").run("blind:prior", JSON.stringify(prior)); f.db.exec("PRAGMA query_only=ON");
  const count = f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_item").get().n;
  assert.throws(() => validateFreshCatalogReviewPlan(plan, { db: f.db, requirePrepared: true, artifactRoot: f.directory, cacheDirectory: f.wav }), /unexposed/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_review_session_item").get().n, count);
});
test("public DTO and incomplete reports hide identities, providers, source offsets, model attribution and rankings", async t => {
  const f = await fixture(t), plan = f.build(); f.seed(plan); const snapshot = getFreshCatalogReviewSnapshot(plan, f.db);
  assert.equal(snapshot.batch.kind, KIND); assert.equal(snapshot.batch.count, 12); assert.equal(snapshot.batch.remaining, 12);
  for (const group of snapshot.batch.groups) { assert.equal(group.anchorAudio.start, 0); assert.equal(group.anchorAudio.end, 30); for (const item of group.items) assert.deepEqual([item.audio.start, item.audio.end], [0, 30]); }
  for (const value of [snapshot, completedFreshCatalogReport(plan, snapshot.batch)]) assert.doesNotMatch(JSON.stringify(value), /mert|tidal:\d|tidalId|sourceFile|sourceSha|sourceSnapshot|specKey|nominations|retrieval|similarity|"rank"|45\.016327/i);
  assert.equal(completedFreshCatalogReport(plan, snapshot.batch).ready, false);
});
test("completed report requires genuine humans, treats UNSURE as unresolved, and makes no comparison or rate claim", async t => {
  const f = await fixture(t), plan = f.build(); f.seed(plan, true); let snapshot = getFreshCatalogReviewSnapshot(plan, f.db).batch;
  let report = completedFreshCatalogReport(plan, snapshot); assert.equal(report.ready, true); assert.equal(report.analyzer, ANALYZER); assert.equal(report.decisions.KEEP, 12);
  assert.doesNotMatch(JSON.stringify(report), /keepRate|acceptanceRate|precision|"winner"|"baseline"|tidalId|sourceSha|specKey|"rank"/i);
  f.db.prepare("UPDATE sonic_review_session_item SET review_json=? WHERE session_id=? AND item_index=0").run(JSON.stringify({ reviewer: "assistant", decision: "KEEP", listened: true }), plan.groups[0].sessionId);
  assert.equal(completedFreshCatalogReport(plan, getFreshCatalogReviewSnapshot(plan, f.db).batch).ready, false);
  f.db.prepare("UPDATE sonic_review_session_item SET review_json=? WHERE session_id=? AND item_index=0").run(JSON.stringify({ reviewer: "human", decision: "UNSURE", listened: false }), plan.groups[0].sessionId);
  report = completedFreshCatalogReport(plan, getFreshCatalogReviewSnapshot(plan, f.db).batch); assert.equal(report.ready, true); assert.equal(report.decisions.UNSURE, 1); assert.equal(report.decisions.KEEP, 11);
  snapshot = getFreshCatalogReviewSnapshot(plan, f.db).batch; snapshot.groups[0].sessionId = "foreign"; assert.equal(completedFreshCatalogReport(plan, snapshot).ready, false);
});
test("honest partial finalization omits empty anchors and reports missing slots without fillers or failures", async t => {
  const f = await fixture(t); f.selected.requests[0].tracks = []; f.selected.requests[1].tracks.splice(1);
  const plan = f.build(); assert.equal(plan.anchorCount, 3); assert.equal(plan.count, 7); f.seed(plan, true);
  const report = completedFreshCatalogReport(plan, getFreshCatalogReviewSnapshot(plan, f.db).batch); assert.equal(report.missingSlots, 5); assert.equal(report.decisions.KEEP, 7); assert.equal(report.decisions.WRONG_LANE, 0);
  for (const row of f.selected.requests) row.tracks = []; assert.equal(f.build(), null);
});
test("explicit raw-techno scope requires exactly eight genre-92 sources and two bounded requests", async t => {
  const f = await fixture(t, { samplingScope: "raw-techno-only" }), plan = f.prepare(f.build());
  assert.equal(f.selected.sourceEvidence.length, 8); assert.equal(plan.recipe.samplingScope, "raw-techno-only"); assert.equal(plan.recipe.sourceCount, 8);
  assert.equal(plan.requestCount, 2); assert.equal(plan.count, 6); assert.equal(plan.recipe.genreIds.join(), "92");
  assert.equal(validateFreshCatalogReviewPlan(plan, { db: f.db, requirePrepared: true, artifactRoot: f.directory, cacheDirectory: f.wav }), true);
  f.seed(plan, true); const report = completedFreshCatalogReport(plan, getFreshCatalogReviewSnapshot(plan, f.db).batch);
  assert.equal(report.requestCount, 2); assert.equal(report.missingSlots, 0); assert.equal(report.decisions.KEEP, 6);
  const mismatched = clone(f.pool); delete mismatched.samplingScope; assert.throws(() => validatePool(mismatched, { artifactRoot: f.directory }), /complete explicitly declared source count/);
  f.request.samplingScope = "two-genre"; assert.throws(() => f.build(), /sampling scopes differ/);
  f.pool.samplingScope = "arbitrary-smaller-pool"; assert.throws(() => validatePool(f.pool, { artifactRoot: f.directory }), /explicitly bounded/);
});
