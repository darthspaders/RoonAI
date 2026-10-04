"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const { SonicCoverageService } = require("../src/sonicCoverageService");
const { SonicAnalysisService } = require("../src/sonicAnalysisService");
const { analysisSpec, hash } = require("../src/sonicAnalysisSpec");
const { createRecommendationV2DiscoveryReranker } = require("../src/recommendationV2Discovery");
const { SonicEmbeddingEngine } = require("../src/sonicEmbeddingEngine");
const track = id => ({ identityKey: `tidal:${id}`, tidalId: String(id), artist: "Test artist", title: `Track ${id}`, score: 50 });
const result = spec => ({ specKey: spec.key, revision: spec.revision, sampleRate: spec.sampleRate,
  audioDurationSeconds: 60, analyzedSeconds: 30, sourceCoverage: .5,
  vector: Array.from({ length: spec.dimensions || 0 }, (_, i) => i === 0 ? 1 : 0), segments: [{ start: 15, end: 45 }] });
function fixture(t, handler = async (_, spec) => result(spec)) {
  const db = new DatabaseSync(":memory:");
  const embeddings = new SonicEmbeddingStore({ enabled: false });
  Object.assign(embeddings, { enabled: true, db }); embeddings.migrate();
  let now = 100000, calls = 0;
  const engine = { enabled: true, store: embeddings, provider: { name: "discogs-effnet", modelVersion: "1" },
    resolveTidalTrackReference: async x => x,
    analyzeBeatportPreviewForTidalTrack: async (value, options) => {
      assert.equal(options.allowVersionProxy, false);
      return options.analysisHandler(Buffer.from("verified-audio"), value, { sourceType: "beatport-preview", metadata: { partialPreview: true } });
    },
    prepareSonicAnchor: async value => {
      embeddings.upsertEmbedding({ track: value, model: "discogs-effnet", modelVersion: "1", vector: Array.from({length:1280},(_,i)=>Number(i===0)) });
      return { ready: true, prepared: true, identityKey: value.identityKey };
    } };
  const coverage = new SonicCoverageService({ db, recommendationEngine: engine, autoStart: false, clock: () => now, inventory: async function* () { yield track(90); } });
  const analysis = new SonicAnalysisService({ db, recommendationEngine: engine, coverage, worker: { run: (...args) => { calls++; return handler(...args); }, stop() {} } });
  const one = async () => { now += 10000; await coverage.pump(); await Promise.all(coverage.active.values()); };
  t.after(() => { analysis.close(); coverage.close(); db.close(); });
  return { db, embeddings, engine, coverage, analysis, one, advance: () => { now += 10000; }, calls: () => calls };
}

test("analysis deduplicates per spec, skips completed embeddings and reuses identical original audio across verified identities", async t => {
  const f = fixture(t);
  f.analysis.configure({ enabled: true, models: ["mert-fullsong", "mert-30s"] });
  assert.equal(f.analysis.enqueue([track(1)], { models: ["mert-fullsong"] }).queued, 1);
  assert.equal(f.analysis.enqueue([track(1)], { models: ["mert-fullsong"] }).inFlight, 1);
  await f.one();
  assert.equal(f.calls(), 1);
  assert.equal(f.analysis.enqueue([track(1)], { models: ["mert-fullsong"] }).embedded, 1);
  f.analysis.enqueue([track(2)], { models: ["mert-fullsong"] }); await f.one();
  assert.equal(f.calls(), 1, "content cache avoids repeated inference after exact source verification");
  f.analysis.enqueue([track(1)], { models: ["mert-30s"] }); await f.one();
  assert.equal(f.calls(), 2, "different checkpoints cannot reuse vectors");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_analysis_artifact").get().n, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_neighbor_feedback").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_anchor_profile").get().n, 0);
  assert.equal(f.embeddings.getEmbedding(track(1), { model: "discogs-effnet", modelVersion: "1" }), null);
});

test("optional analysis shares scheduler limits, pauses independently, and production lazy fill gets the next slot", async t => {
  let release;
  const f = fixture(t, async (_, spec) => { await new Promise(resolve => { release = resolve; }); return result(spec); });
  f.coverage.configure({ concurrency: 3 });
  f.analysis.configure({ enabled: true }); f.analysis.enqueue([track(1), track(2)]);
  await f.coverage.pump();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.advance(); await f.coverage.pump();
  assert.equal(f.coverage.active.size, 1, "only one optional model at a time even when legacy concurrency is higher");
  f.analysis.configure({ paused: true });
  f.coverage.enqueueMissing([track(3)]); f.advance(); await f.coverage.pump();
  release(); await Promise.all(f.coverage.active.values());
  assert.ok(f.embeddings.getEmbedding(track(3), { model: "discogs-effnet", modelVersion: "1" }));
  assert.equal(f.calls(), 1);
  f.analysis.cancel();
  assert.ok([track(1), track(2)].some(value => f.analysis.existing(value, analysisSpec("mert-fullsong").key)));
  assert.equal(f.analysis.status().queue.find(x => x.state === "cancelled").count, 1);
});

test("restart migration keeps old bulk counts and recovers an analysis committed before its acknowledgment", async t => {
  const f = fixture(t);
  f.coverage.startBackfill(); await f.coverage.scanInventory(); await f.one();
  f.analysis.configure({ enabled: true }); f.analysis.enqueue([track(1)]);
  const spec = analysisSpec("mert-fullsong");
  f.analysis.store.save(track(1), spec, hash("verified-audio"), result(spec));
  f.db.prepare("UPDATE sonic_coverage_work SET state='running',claim_token='dead' WHERE analyzer_key<>''").run();
  const before = f.coverage.status().job;
  f.coverage.close();
  const restarted = new SonicCoverageService({ db: f.db, recommendationEngine: f.engine, autoStart: false, clock: () => 999999 });
  restarted.analysis = f.analysis;
  await restarted.pump(); await Promise.all(restarted.active.values());
  assert.equal(f.calls(), 0);
  assert.equal(restarted.status().job.totalEligible, before.totalEligible);
  assert.equal(restarted.status().job.preparedSuccessfully, before.preparedSuccessfully);
  assert.equal(f.db.prepare("SELECT state FROM sonic_coverage_work WHERE analyzer_key<>''").get().state, "embedded");
  restarted.close();
});

test("discovery shadow queues without waiting, failures preserve scores/order, and later evidence is model-specific", async t => {
  const f = fixture(t);
  f.analysis.configure({ enabled: true, lazyEnabled: true });
  const base = { recommendationEngine: f.engine, enabled: true, productionMode: "blend", profilesProvider: () => [] };
  const original = createRecommendationV2DiscoveryReranker(base);
  const shadow = createRecommendationV2DiscoveryReranker({ ...base, analysisService: f.analysis });
  const tracks = [track(2), track(1)];
  const expected = original.rerankCandidates(tracks);
  const actual = shadow.rerankCandidates(tracks);
  assert.deepEqual(actual.candidates, expected.candidates);
  assert.equal(f.calls(), 0, "no extraction or model load on discovery's stack");
  assert.equal(actual.diagnostics.experimentalAnalysis.lazyFill.queued, 2);
  assert.equal(actual.diagnostics.experimentalAnalysis.productionApplied, false);
  await f.one(); await f.one();
  const next = f.analysis.observe(tracks, { anchor: track(1) });
  assert.equal(next.models[0].analyzedCount, 2);
  assert.equal(next.models[0].similarities[0].cosine, 1);
  const broken = createRecommendationV2DiscoveryReranker({ ...base, analysisService: { observe() { throw Error("optional model failed"); } } });
  assert.deepEqual(broken.rerankCandidates(tracks).candidates, expected.candidates);
  assert.equal(shadow.getConfig().maxAdjustment, .08);
});

test("artifacts reject incompatible vectors and provenance and compact evidence does not return vectors", t => {
  const f = fixture(t), spec = analysisSpec("mert-fullsong"), audioHash = hash("test");
  assert.throws(() => f.analysis.store.save(track(1), spec, audioHash, { ...result(spec), revision: "wrong" }), /provenance/);
  assert.throws(() => f.analysis.store.save(track(1), spec, audioHash, { ...result(spec), vector: [NaN] }), /embedding/);
  assert.throws(() => f.analysis.store.save(track(1), spec, audioHash, { ...result(spec), segments: [{ start: 0, end: 70 }] }), /timeline/);
  f.analysis.store.save(track(1), spec, audioHash, { ...result(spec), segments: [{ start: 15, end: 45, vector: result(spec).vector }] });
  assert.equal(JSON.stringify(f.analysis.evidence(track(1))).includes('"vector"'), false);
  assert.equal(f.analysis.evidence(track(1))[0].sourceCoverage, .5);
});

test("resource contention defers optional work while strict identity failures remain terminal", async t => {
  const f = fixture(t, async () => { throw Object.assign(Error("GPU occupied"), { code: "SONIC_RESOURCE_BUSY" }); });
  f.analysis.configure({ enabled: true }); f.analysis.enqueue([track(1)]);
  await f.one();
  const row = f.db.prepare("SELECT * FROM sonic_coverage_work WHERE analyzer_key<>''").get();
  assert.equal(row.state, "pending"); assert.ok(row.available_at > row.updated_at);
  f.engine.analyzeBeatportPreviewForTidalTrack = async () => { throw Object.assign(Error("Version mismatch"), { statusCode: 422 }); };
  f.db.prepare("UPDATE sonic_coverage_work SET available_at=0").run(); await f.one();
  assert.equal(f.analysis.status().queue[0].state, "failed");
});

test("adding another same-dimension representation cannot change default neighbors or mix cosine spaces", t => {
  const f = fixture(t);
  const provider = { name: "discogs-effnet", modelVersion: "1", status: () => ({ available: true }) };
  const engine = new SonicEmbeddingEngine({ store: f.embeddings, provider });
  for (const id of [1,2]) f.embeddings.upsertEmbedding({ track: track(id), model: provider.name, modelVersion: "1", vector: [1,0] });
  for (const id of [1,3]) f.embeddings.upsertEmbedding({ track: track(id), model: "experimental", modelVersion: "other-space", vector: [1,0] });
  const neighbors = engine.findSonicNeighbors(track(1));
  assert.equal(neighbors.model, "discogs-effnet");
  assert.deepEqual(neighbors.neighbors.map(x=>x.identityKey), ["tidal:2"]);
  assert.equal(f.embeddings.findNearest({ vector: [1,0] }).length, 0);
  assert.deepEqual(f.embeddings.findNearest({ track: track(1), model: "experimental" }).map(x=>x.identityKey), ["tidal:3"]);
});

test("artifact and embedding commit atomically with the separate DB handles used by the live app", t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { SonicAnalysisStore } = require("../src/sonicAnalysisStore");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-analysis-db-")), file = path.join(directory,"test.sqlite");
  const embeddings = new SonicEmbeddingStore({ dbFile: file });
  const memory = new DatabaseSync(file); memory.exec("PRAGMA busy_timeout=50");
  const store = new SonicAnalysisStore({ db: memory, embeddingStore: embeddings });
  t.after(() => { memory.close(); embeddings.close(); for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory,name)); fs.rmdirSync(directory); });
  const spec = analysisSpec("mert-fullsong");
  store.save(track(1), spec, hash("audio"), result(spec));
  assert.ok(embeddings.getEmbedding(track(1), {model:spec.repo,modelVersion:spec.key}));
  assert.equal(store.get(track(1),spec).sourceSha256,hash("audio"));
  embeddings.enabled = false;
  assert.throws(() => store.save(track(2),spec,hash("different"),result(spec)), /disabled/);
  assert.equal(store.get(track(2),spec),null);
  assert.equal(memory.prepare("SELECT COUNT(*) n FROM sonic_analysis_artifact").get().n,1);
});

test("experimental diagnostics preserve an applied production Blend as well as its coverage fallback", t => {
  const f = fixture(t);
  f.embeddings.upsertEmbedding({ track: track(1), model:"discogs-effnet",modelVersion:"1",vector:[1,0] });
  const profile = { clusterKey:"metadata:progressive house",clusterName:"Progressive House",model:"discogs-effnet",modelVersion:"1",
    positive:{vector:[1,0],feedbackIdentityCount:4,embeddingIdentityCount:4},negative:null };
  for (const minScored of [1,5]) {
    const config = {recommendationEngine:f.engine,enabled:true,productionMode:"blend",minScored,profilesProvider:()=>[profile],logger:null};
    const context = {options:{genre:"Progressive House"},profile:{targetGenres:["progressive house"],scoringMode:"taste-guided"}};
    const expected = createRecommendationV2DiscoveryReranker(config).rerankCandidates([track(1),track(2)],context);
    const actual = createRecommendationV2DiscoveryReranker({...config,analysisService:{observe:()=>({mode:"shadow",productionApplied:false})}}).rerankCandidates([track(1),track(2)],context);
    assert.deepEqual(actual.candidates,expected.candidates);
    assert.equal(actual.diagnostics.applied,minScored===1);
  }
});

test("evaluation uses a common audio pool and never converts global likes into neighbor judgments", t => {
  const f = fixture(t), { compareAnalysis } = require("../src/sonicAnalysisEvaluation");
  const models = ["effnet-control","mert-fullsong"], manifest = {items:[1,2,3].map(id=>({track:track(id),rating:"love"}))};
  for (const model of models) {
    const spec = analysisSpec(model);
    for (const id of [1,2,3]) f.analysis.store.save(track(id),spec,hash(`${model==="mert-fullsong" && id===3 ? "different-audio" : "audio"}${id}`),result(spec));
  }
  const report = compareAnalysis(f.db,manifest,{models});
  assert.equal(report.commonAudioCandidateCount,2,"different previews cannot be compared as identical source evidence");
  assert.equal(report.productionPromotionAllowed,false);
  assert.equal(report.models[0].meanJudgedPrecisionAt10,null,"global love is not an anchor/candidate relevance label");
  assert.equal(report.models[0].meanJudgedCoverageAt10,0);
  assert.equal(report.models[0].anchors[0].neighbors.length,1);
  assert.equal(report.models[0].anchors[0].neighbors[0].storedNeighborRating,null);
});
