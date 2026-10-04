"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const { SonicCoverageService } = require("../src/sonicCoverageService");
const { coverageTrack, validCoverageEmbedding } = require("../src/sonicCoverageIdentity");
const { createRecommendationV2DiscoveryReranker } = require("../src/recommendationV2Discovery");
const turn = () => new Promise(resolve => setImmediate(resolve));
const vector = () => Array.from({ length: 1280 }, (_, i) => i === 0 ? 1 : 0);
const track = id => ({ tidalId: String(id), artist: `Artist ${id}`, title: `Track ${id}`, score: 50 + Number(id) / 10 });

function fixture(t, { file = ":memory:", items = [], prepare, settings = {} } = {}) {
  const db = new DatabaseSync(file);
  const store = new SonicEmbeddingStore({ enabled: false });
  Object.assign(store, { enabled: true, db });
  store.migrate();
  const calls = [];
  let now = 100000;
  const engine = {
    enabled: true, provider: { name: "discogs-effnet", modelVersion: "1" }, store,
    resolveTidalTrackReference: async value => value,
    prepareSonicAnchor: async (value, options) => {
      calls.push(value.tidalId);
      assert.equal(options.allowVersionProxy, false);
      assert.equal(options.backgroundExtraction, true);
      if (prepare) await prepare(value, options);
      const stored = store.upsertEmbedding({ track: value, vector: vector(), model: "discogs-effnet", modelVersion: "1" });
      return { ready: true, prepared: true, identityKey: stored.identityKey };
    }
  };
  const service = new SonicCoverageService({ db, recommendationEngine: engine, autoStart: false, clock: () => now,
    settings, inventory: async function* () { yield* items; }, logger: null });
  t.after(() => { service.close(); db.close(); });
  const advance = (ms = 10000) => { now += ms; };
  const completeOne = async () => { advance(); await service.pump(); await Promise.all([...service.active.values()]); await turn(); };
  return { db, store, engine, service, calls, advance, completeOne };
}

test("coverage skips valid matching embeddings and does not accept wrong versions or malformed vectors", async t => {
  const f = fixture(t, { items: [track(1), track(2)] });
  f.store.upsertEmbedding({ track: track(1), vector: vector(), model: "discogs-effnet", modelVersion: "1" });
  f.store.upsertEmbedding({ track: track(2), vector: vector(), model: "discogs-effnet", modelVersion: "2" });
  f.service.startBackfill(); await f.service.scanInventory();
  assert.deepEqual(Object.fromEntries(Object.entries(f.service.status().job).filter(([key]) => ["totalEligible","alreadyEmbedded","preparedSuccessfully","failed","remaining"].includes(key))),
    { totalEligible: 2, alreadyEmbedded: 1, preparedSuccessfully: 0, failed: 0, remaining: 1 });
  await f.completeOne();
  assert.deepEqual(f.calls, ["2"]);
  assert.equal(validCoverageEmbedding({ model: "discogs-effnet", modelVersion: "1", dimensions: 1280, vector: Array(1280).fill(0) }), false);
  assert.equal(validCoverageEmbedding({ model: "discogs-effnet", modelVersion: "1", dimensions: 1280, vector: [NaN] }), false);
});

test("lazy work deduplicates simultaneous discoveries and outranks rated/bulk work within global rate and concurrency limits", async t => {
  const releases = new Map();
  const f = fixture(t, { items: [{ track: track(1), priority: 6 }, { track: track(2), priority: 1 }],
    settings: { concurrency: 2, minIntervalMs: 250, batchSize: 2, batchPauseMs: 1000 },
    prepare: value => new Promise(resolve => releases.set(value.tidalId, resolve)) });
  f.service.startBackfill(); await f.service.scanInventory();
  assert.equal(f.service.enqueueMissing([track(3)]).lazyFillQueuedCount, 1);
  assert.equal(f.service.enqueueMissing([track(3)]).lazyFillAlreadyInFlightCount, 1);
  await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["3"]);
  await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["3"], "the launch rate applies even with an empty concurrency slot");
  f.advance(250); await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["3", "2"]);
  f.service.enqueueMissing([track(4)]); f.advance(1000); await f.service.pump(); await turn();
  assert.equal(f.service.active.size, 2);
  releases.get("3")(); await turn();
  await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["3", "2", "4"]);
  releases.get("2")(); releases.get("4")();
  await Promise.all([...f.service.active.values()]);
  assert.equal(f.calls.filter(id => id === "3").length, 1);
});

test("aliases resolving to the same exact TIDAL identity share one preparation", async t => {
  let release;
  const f = fixture(t, { settings: { concurrency: 2 }, prepare: () => new Promise(resolve => { release = resolve; }) });
  f.engine.resolveTidalTrackReference = async () => track(99);
  f.service.enqueueMissing([{ ...track(1), tidalId: "", identityKey: "text:artist|track|" }, track(99)]);
  await f.service.pump(); await turn(); f.advance(); await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["99"]);
  release(); await Promise.all([...f.service.active.values()]);
});

test("crash recovery persists bulk progress and rechecks a fingerprint committed before its queue acknowledgment", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-coverage-test-"));
  const file = path.join(dir, "memory.sqlite");
  // Use explicit file cleanup; never recursively remove an inferred path.
  t.after(() => { for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); });
  const db = new DatabaseSync(file);
  const store = new SonicEmbeddingStore({ enabled: false });
  Object.assign(store, { enabled: true, db }); store.migrate();
  let calls = 0;
  const engine = { enabled: true, provider: { name: "discogs-effnet", modelVersion: "1" }, store,
    resolveTidalTrackReference: async x => x,
    prepareSonicAnchor: async () => { calls++; throw Error("must not repeat committed work"); } };
  const first = new SonicCoverageService({ db, recommendationEngine: engine, autoStart: false, inventory: async function* () { yield track(1); yield track(2); } });
  first.startBackfill(); await first.scanInventory();
  store.upsertEmbedding({ track: track(1), vector: vector(), model: "discogs-effnet", modelVersion: "1" });
  db.prepare("UPDATE sonic_coverage_work SET state='prepared' WHERE identity_key='tidal:1'").run();
  db.prepare("UPDATE sonic_coverage_work SET state='running',claim_token='dead-process' WHERE identity_key='tidal:2'").run();
  store.upsertEmbedding({ track: track(2), vector: vector(), model: "discogs-effnet", modelVersion: "1" });
  first.close(); db.close();
  const reopened = new DatabaseSync(file); store.db = reopened;
  const second = new SonicCoverageService({ db: reopened, recommendationEngine: engine, autoStart: false });
  assert.equal(second.status().job.preparedSuccessfully, 1);
  assert.equal(second.status().job.remaining, 1);
  await second.pump(); await Promise.all([...second.active.values()]);
  assert.equal(calls, 0);
  assert.equal(second.status().job.remaining, 0);
  assert.equal(second.status().job.totalEligible, 2);
  second.close(); reopened.close();
});

test("pause stops future starts, resume continues, cancel keeps completed embeddings", async t => {
  const f = fixture(t, { items: [track(1), track(2)] });
  f.service.startBackfill(); await f.service.scanInventory(); await f.completeOne();
  f.service.pause(); f.advance(); await f.service.pump();
  assert.deepEqual(f.calls, ["1"]);
  assert.equal(f.service.status().settings.paused, true);
  f.service.resume(); await f.completeOne();
  assert.deepEqual(f.calls, ["1", "2"]);
  f.service.enqueueMissing([track(3)]);
  f.service.cancel({ scope: "all" }); f.advance(); await f.service.pump();
  assert.equal(f.service.status().queueCounts.cancelled, 1);
  assert.ok(f.store.getEmbedding("tidal:1", { model: "discogs-effnet", modelVersion: "1" }));
});

test("lazy enqueue is nonblocking; low coverage preserves ordering and later discovery uses the prepared profiles with the same Blend cap", async t => {
  const f = fixture(t);
  const candidates = Array.from({ length: 5 }, (_, i) => track(i + 1));
  const reranker = createRecommendationV2DiscoveryReranker({ recommendationEngine: f.engine, enabled: true, productionMode: "blend",
    minScored: 5, minCoverage: 0.1, maxAdjustment: 0.08, coverageService: f.service, logger: null,
    profilesProvider: () => [{ clusterKey: "metadata:progressive house", clusterName: "Progressive House", positive: { vector: vector(), feedbackIdentityCount: 5, embeddingIdentityCount: 5 } }] });
  const options = { options: { genre: "progressive house" }, profile: { targetGenres: ["progressive house"] } };
  const first = reranker.rerankCandidates(candidates, options);
  assert.equal(f.calls.length, 0, "discovery does not await or invoke audio preparation");
  assert.equal(first.diagnostics.missingEmbeddingCount, 5);
  assert.equal(first.diagnostics.lazyFillQueuedCount, 5);
  assert.equal(first.diagnostics.applied, false);
  assert.equal(first.diagnostics.coverageThresholdMet, false);
  assert.deepEqual(first.candidates.map(x => [x.tidalId,x.score]), candidates.map(x => [x.tidalId,x.score]));
  assert.equal(reranker.rerankCandidates(candidates, options).diagnostics.lazyFillAlreadyInFlightCount, 5);
  for (let i = 0; i < 5; i++) await f.completeOne();
  const next = reranker.rerankCandidates(candidates, options);
  assert.equal(next.diagnostics.scoredCount, 5);
  assert.equal(next.diagnostics.coverage, 1);
  assert.equal(next.diagnostics.coverageThresholdMet, true);
  assert.equal(next.diagnostics.applied, true);
  assert.ok(next.candidates.every(x => Math.abs(x.recommendationV2.sonicAdjustment) <= 8));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sonic_neighbor_feedback").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sonic_anchor_profile").get().n, 0);
});

test("coverage never interprets a memory or Beatport numeric ID as a TIDAL ID", () => {
  assert.equal(coverageTrack({ id: 555, beatportTrackId: "555", artist: "A", title: "Track" }).tidalId, "");
  assert.equal(coverageTrack({ ...track(5), identityKey: "text:old|key|" }).identityKey, "tidal:5");
});

test("pause during extraction lets only active work finish and does not poll paused bulk inventory", async t => {
  let release;
  const f = fixture(t, { items: [track(1), track(2)], prepare: () => new Promise(resolve => { release = resolve; }) });
  f.service.startBackfill(); await f.service.scanInventory();
  await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["1"]);
  f.service.pause();
  release(); await Promise.all([...f.service.active.values()]);
  f.advance(); await f.service.pump();
  assert.equal(f.service.status().job.preparedSuccessfully, 1);
  assert.equal(f.service.status().job.remaining, 1);
  assert.deepEqual(f.calls, ["1"]);
  // Bulk-only pause still permits lazy work, but should be idle when none exists.
  f.service.resume(); f.service.pause({ scope:"bulk" });
  const wakes = [];
  f.service.schedule = delay => wakes.push(delay);
  await f.service.pump();
  assert.deepEqual(wakes, []);
  f.service.enqueueMissing([track(3)]);
  assert.equal(wakes.length, 1);
  await f.service.pump(); await turn();
  assert.deepEqual(f.calls, ["1", "3"]);
  release(); await Promise.all([...f.service.active.values()]);
});

test("transient provider failures back off and stop at the retry limit; strict identity failures remain terminal", async t => {
  const f = fixture(t, { items:[track(1),track(2)], settings:{maxAttempts:2}, prepare: value => {
    throw Object.assign(new Error(value.tidalId === "1" ? "Provider rate limited" : "Exact version mismatch"), {statusCode:value.tidalId === "1" ? 429 : 422});
  } });
  f.service.startBackfill(); await f.service.scanInventory();
  await f.completeOne();
  let row = f.db.prepare("SELECT * FROM sonic_coverage_work WHERE identity_key='tidal:1'").get();
  assert.equal(row.state, "pending");
  assert.equal(row.available_at, 140000);
  await f.completeOne();
  assert.deepEqual(f.calls, ["1","2"]);
  assert.equal(f.service.status().job.failed, 1);
  await f.completeOne();
  assert.deepEqual(f.calls, ["1","2"], "no early retry during the backoff window");
  await f.completeOne();
  assert.deepEqual(f.calls, ["1","2","1"]);
  assert.equal(f.service.status().job.failed, 2);
  assert.equal(f.service.status().job.remaining, 0);
  assert.equal(f.service.enqueueMissing([track(1)]).lazyFillFailedCount, 1);
  f.service.resume({retryFailed:true});
  assert.equal(f.service.status().job.failed, 0);
  assert.equal(f.service.status().job.remaining, 2);
});

test("inventory interrupted mid-scan resumes idempotently and cancelled scans cannot contaminate a new job", async t => {
  const f = fixture(t);
  let release;
  f.service.inventory = async function* () {
    for (let id=1; id<=26; id++) {
      if (id === 26) await new Promise(resolve => { release = resolve; });
      yield track(id);
    }
  };
  f.service.startBackfill();
  const interrupted = f.service.scanInventory();
  while (!release) await turn();
  f.service.pause(); release(); await interrupted;
  assert.equal(f.service.status().job.totalEligible, 25);
  assert.equal(f.service.status().job.inventoryComplete, false);
  f.service.inventory = async function* () { for (let id=1; id<=26; id++) yield track(id); };
  f.service.resume(); await f.service.scanInventory();
  assert.equal(f.service.status().job.totalEligible, 26);
  assert.equal(f.service.status().job.inventoryComplete, true);
  f.service.cancel();
  f.service.inventory = async function* () { await new Promise(resolve => { release = resolve; }); yield track(99); };
  f.service.startBackfill();
  const cancelledId = f.service.status().job.id;
  const cancelledScan = f.service.scanInventory();
  await turn(); f.service.cancel(); f.service.startBackfill();
  release(); await cancelledScan;
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sonic_coverage_job_item WHERE job_id=?").get(cancelledId).n, 0);
  assert.equal(f.service.status().job.totalEligible, 0);
  f.service.inventory = async function* () { yield track(3); };
  await f.service.scanInventory();
  assert.equal(f.service.status().job.totalEligible, 1);
});

test("a newly requested discovery track wakes a scheduler waiting on older retry work", async t => {
  let prepared;
  const observed = new Promise(resolve => { prepared = resolve; });
  const f = fixture(t, {prepare:prepared});
  f.service.autoStart = true;
  f.service.schedule(60000);
  f.service.enqueueMissing([track(1)]);
  let deadline;
  const outcome = await Promise.race([observed.then(() => "prepared"), new Promise(resolve => { deadline=setTimeout(() => resolve("still waiting"),2000); })]);
  clearTimeout(deadline);
  assert.equal(outcome,"prepared");
  await Promise.all([...f.service.active.values()]);
});

test("lazy work and a global pause survive owner replacement without a bulk job", async t => {
  const f = fixture(t,{settings:{concurrency:2,batchSize:3}});
  f.service.enqueueMissing([track(1)]);
  f.db.prepare("UPDATE sonic_coverage_work SET state='running',claim_token='stale-owner' WHERE identity_key='tidal:1'").run();
  f.service.pause(); f.service.close();
  const recovered = new SonicCoverageService({db:f.db,recommendationEngine:f.engine,autoStart:false});
  try {
    assert.equal(recovered.status().job,null);
    assert.equal(recovered.status().settings.paused,true);
    assert.equal(recovered.status().settings.concurrency,2);
    assert.equal(recovered.status().queueCounts.pending,1);
    await recovered.pump(); assert.equal(f.calls.length,0);
    assert.equal(recovered.enqueueMissing([track(1)]).lazyFillAlreadyInFlightCount,1);
    recovered.resume(); await recovered.pump(); await Promise.all([...recovered.active.values()]);
    assert.deepEqual(f.calls,["1"]);
    assert.equal(recovered.status().queueCounts.prepared,1);
  } finally { recovered.close(); }
});
