"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");
const { SonicCoverageService } = require("../src/sonicCoverageService");
const { MODEL, MODEL_VERSION, DIMENSIONS, coverageTrack, validCoverageEmbedding } = require("../src/sonicCoverageIdentity");
const { createRecommendationV2DiscoveryReranker } = require("../src/recommendationV2Discovery");
const turn = () => new Promise(resolve => setImmediate(resolve));
const vector = () => Array.from({ length: DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
const track = id => ({ tidalId: String(id), artist: `Artist ${id}`, title: `Track ${id}`, score: 50 + Number(id) / 10 });

function fixture(t, { file = ":memory:", items = [], prepare, settings = {} } = {}) {
  const db = new DatabaseSync(file);
  const store = new SonicEmbeddingStore({ enabled: false });
  Object.assign(store, { enabled: true, db });
  store.migrate();
  const calls = [];
  let now = 100000;
  const engine = {
    enabled: true, provider: { name: MODEL, modelVersion: MODEL_VERSION }, store,
    resolveTidalTrackReference: async value => value,
    prepareSonicAnchor: async (value, options) => {
      calls.push(value.tidalId);
      assert.equal(options.allowVersionProxy, false);
      assert.equal(options.backgroundExtraction, true);
      if (prepare) await prepare(value, options);
      const stored = store.upsertEmbedding({ track: value, vector: vector(), metadata: { identityRelation: "exact" }, model: MODEL, modelVersion: MODEL_VERSION });
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
  f.store.upsertEmbedding({ track: track(1), vector: vector(), metadata: { identityRelation: "exact" }, model: MODEL, modelVersion: MODEL_VERSION });
  f.store.upsertEmbedding({ track: track(2), vector: vector(), metadata: { identityRelation: "exact" }, model: MODEL, modelVersion: "2" });
  f.service.startBackfill(); await f.service.scanInventory();
  assert.deepEqual(Object.fromEntries(Object.entries(f.service.status().job).filter(([key]) => ["totalEligible","alreadyEmbedded","preparedSuccessfully","failed","remaining"].includes(key))),
    { totalEligible: 2, alreadyEmbedded: 1, preparedSuccessfully: 0, failed: 0, remaining: 1 });
  await f.completeOne();
  assert.deepEqual(f.calls, ["2"]);
  assert.equal(validCoverageEmbedding({ model: MODEL, modelVersion: MODEL_VERSION, dimensions: DIMENSIONS, vector: Array(DIMENSIONS).fill(0) }), false);
  assert.equal(validCoverageEmbedding({ model: MODEL, modelVersion: MODEL_VERSION, dimensions: DIMENSIONS, vector: [NaN] }), false);
});

test("selecting FullSong leaves pending legacy EffNet coverage untouched", async t => {
  const f = fixture(t);
  f.service.enqueueMissing([track(321)]);
  f.engine.provider = { name: "m-a-p/MERT-v2-FullSong", modelVersion: "separate-spec" };
  await f.completeOne();
  assert.deepEqual(f.calls, []);
  assert.equal(f.db.prepare(`SELECT state FROM sonic_coverage_work WHERE identity_key='production:${MODEL_VERSION}:tidal:321'`).get().state, "pending");
  assert.equal(f.service.timer, null);
});

test("strict coverage ignores cached proxy and unproven profiles while retaining exact and equivalent recordings", async t => {
  const f = fixture(t);
  const relations = ["exact", "equivalent-recording", "version-proxy", "", "unverified"];
  for (const [index, relation] of relations.entries()) {
    const value = track(index + 1);
    f.store.upsertEmbedding({ track: value, vector: vector(), model: MODEL, modelVersion: MODEL_VERSION,
      metadata: { identityRelation: relation, sourceType: "beatport-preview-version-proxy" } });
    assert.equal(f.service.enqueue(value, { lazy: true }), index < 2 ? "embedded" : "queued");
  }
  f.store.upsertEmbedding({ track: track(6), vector: vector(), model: MODEL, modelVersion: MODEL_VERSION,
    metadata: { identityRelation: "exact", canonicalTrackId: "999" } });
  assert.equal(f.service.enqueue(track(6), { lazy: true }), "queued");
  assert.equal(f.service.existing(track(1)).track.metadata.identityRelation, "exact");
  assert.equal(f.service.existing(track(2)).track.metadata.identityRelation, "equivalent-recording");
  for (const id of [3, 4, 5, 6]) {
    assert.equal(f.service.existing(track(id)), null);
    assert.ok(f.store.getEmbedding(track(id)), "rejected profiles remain stored for an explicit source review");
  }
  await f.completeOne();
  assert.deepEqual(f.calls, ["3"]);
  assert.equal(f.service.existing(track(3)).track.metadata.identityRelation, "exact");
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
  const engine = { enabled: true, provider: { name: MODEL, modelVersion: MODEL_VERSION }, store,
    resolveTidalTrackReference: async x => x,
    prepareSonicAnchor: async () => { calls++; throw Error("must not repeat committed work"); } };
  const first = new SonicCoverageService({ db, recommendationEngine: engine, autoStart: false, inventory: async function* () { yield track(1); yield track(2); } });
  first.startBackfill(); await first.scanInventory();
  store.upsertEmbedding({ track: track(1), vector: vector(), metadata: { identityRelation: "exact" }, model: MODEL, modelVersion: MODEL_VERSION });
  db.prepare(`UPDATE sonic_coverage_work SET state='prepared' WHERE identity_key='production:${MODEL_VERSION}:tidal:1'`).run();
  db.prepare(`UPDATE sonic_coverage_work SET state='running',claim_token='dead-process' WHERE identity_key='production:${MODEL_VERSION}:tidal:2'`).run();
  store.upsertEmbedding({ track: track(2), vector: vector(), metadata: { identityRelation: "exact" }, model: MODEL, modelVersion: MODEL_VERSION });
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
  assert.ok(f.store.getEmbedding("tidal:1", { model: MODEL, modelVersion: MODEL_VERSION }));
});

test("lazy enqueue is nonblocking; low coverage preserves ordering and later discovery uses the prepared profiles with the same Blend cap", async t => {
  const f = fixture(t);
  const candidates = Array.from({ length: 5 }, (_, i) => track(i + 1));
  const reranker = createRecommendationV2DiscoveryReranker({ recommendationEngine: f.engine, enabled: true, productionMode: "blend",
    model: MODEL, modelVersion: MODEL_VERSION, minScored: 5, minCoverage: 0.1, maxAdjustment: 0.08, coverageService: f.service, logger: null,
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
  let row = f.db.prepare(`SELECT * FROM sonic_coverage_work WHERE identity_key='production:${MODEL_VERSION}:tidal:1'`).get();
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
  f.db.prepare(`UPDATE sonic_coverage_work SET state='running',claim_token='stale-owner' WHERE identity_key='production:${MODEL_VERSION}:tidal:1'`).run();
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

function memoryIdentity(db, value, seenAt) {
  // Only the verified production columns used by retry refresh are needed.
  // Every fixture remains in its own in-memory database.
  db.exec(`CREATE TABLE IF NOT EXISTS track_identity (
    identity_key TEXT PRIMARY KEY,tidal_id TEXT,artist TEXT,title TEXT,mix_version TEXT,
    album TEXT,isrc TEXT,duration_ms INTEGER,last_seen_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT OR REPLACE INTO track_identity(identity_key,tidal_id,artist,title,mix_version,album,isrc,duration_ms,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(value.identityKey || `tidal:${value.tidalId}`, value.tidalId, value.artist, value.title,
      value.mixVersion || "", value.album || "", value.isrc || "", value.durationMs || null, new Date(seenAt).toISOString());
}

test("reenqueue refreshes corrected same-ID metadata without retrying failed work or losing evidence", async t => {
  const stale = { ...track(1), title: "Track 1 (Stale caption)", mixVersion: "Stale caption", album: "Album", isrc: "USAAA2600001", durationMs: 420000, beatportTrackId: "81" };
  const f = fixture(t, { items: [stale] });
  f.service.startBackfill(); await f.service.scanInventory();
  const membership = f.db.prepare("SELECT * FROM sonic_coverage_job_item").all();
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',attempts=2,last_error='TIDAL did not confirm stale caption',available_at=700000`).run();
  const before = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  f.advance();
  const corrected = { ...track(1), mixVersion: "" };
  assert.equal(f.service.enqueue(corrected, { source: "discovery", metadataObservedAt: f.service.clock() }), "failed");
  const after = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  const metadata = JSON.parse(after.track_json);
  assert.equal(metadata.title, "Track 1");
  assert.equal(metadata.mixVersion, "", "an explicit same-ID correction can remove a stale descriptor");
  for (const key of ["album", "isrc", "durationMs", "beatportTrackId"]) assert.equal(metadata[key], stale[key]);
  for (const key of ["state", "attempts", "last_error", "available_at", "requested_at", "source"]) assert.equal(after[key], before[key]);
  assert.deepEqual(f.db.prepare("SELECT * FROM sonic_coverage_job_item").all(), membership);
  assert.equal(f.calls.length, 0);
  const audit = f.db.prepare("SELECT * FROM sonic_coverage_metadata_audit").get();
  assert.equal(audit.event, "metadata-refresh");
  assert.equal(audit.source, "enqueue:discovery");
  assert.equal(audit.previous_track_json, before.track_json);
  assert.equal(audit.track_json, after.track_json);
  assert.equal(audit.previous_attempts, 2);
  assert.equal(audit.previous_error, before.last_error);
  assert.equal(f.service.enqueue(corrected), "failed");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 1, "identical metadata is idempotent");
  f.advance();
  assert.equal(f.service.enqueueMissing([{ ...corrected, album: "New album" }]).lazyFillFailedCount, 1);
  assert.equal(JSON.parse(f.db.prepare(`SELECT track_json FROM sonic_coverage_work`).get().track_json).album, "New album");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 2, "refresh also works inside the existing lazy-enqueue transaction");
});

test("explicit retry refreshes newer same-ID memory metadata and retains failure history", async t => {
  const f = fixture(t, { items: [{ ...track(1), title: "Old caption", mixVersion: "Extended Mix", beatportTrackId: "81" }] });
  f.service.startBackfill(); await f.service.scanInventory();
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',attempts=3,last_error='Exact identity failed'`).run();
  memoryIdentity(f.db, { ...track(1), mixVersion: "Extended Mix", album: "Current album" }, 105000);
  const membership = f.db.prepare("SELECT * FROM sonic_coverage_job_item").all();
  f.advance(); f.service.resume({ retryFailed: true });
  const row = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  assert.equal(JSON.parse(row.track_json).title, "Track 1");
  assert.equal(JSON.parse(row.track_json).album, "Current album");
  assert.equal(JSON.parse(row.track_json).beatportTrackId, "81");
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, "");
  const audits = f.db.prepare("SELECT * FROM sonic_coverage_metadata_audit ORDER BY id").all();
  assert.deepEqual(audits.map(a => a.event), ["metadata-refresh", "retry"]);
  assert.ok(audits.every(a => a.previous_attempts === 3 && a.previous_error === "Exact identity failed"));
  assert.deepEqual(f.db.prepare("SELECT * FROM sonic_coverage_job_item").all(), membership);
  assert.equal(f.calls.length, 0, "resume only queues; it does not perform extraction inline");
  f.engine.resolveTidalTrackReference = async value => { assert.equal(value.title, "Track 1"); return value; };
  await f.completeOne();
  assert.deepEqual(f.calls, ["1"]);
});

test("retry cannot overwrite a corrected enqueue snapshot or a newer legacy snapshot with older memory", t => {
  const f = fixture(t);
  f.service.enqueueMissing([{ ...track(1), title: "Old caption" }]);
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',last_error='Original failure'`).run();
  f.advance(20000);
  f.service.enqueue({ ...track(1), title: "Corrected caption" }, { metadataObservedAt: f.service.clock() });
  memoryIdentity(f.db, { ...track(1), title: "Older memory caption" }, 110000);
  f.service.enqueueMissing([{ ...track(2), title: "Legacy newer caption", mixVersion: "Extended Mix" }]);
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',metadata_updated_at=0 WHERE identity_key='production:${MODEL_VERSION}:tidal:2'`).run();
  memoryIdentity(f.db, { ...track(2), title: "Older legacy memory" }, 119999);
  f.service.resume({ retryFailed: true });
  const rows = f.db.prepare(`SELECT * FROM sonic_coverage_work ORDER BY identity_key`).all();
  assert.deepEqual(rows.map(row => JSON.parse(row.track_json).title), ["Corrected caption", "Legacy newer caption"]);
  assert.equal(JSON.parse(rows[1].track_json).mixVersion, "Extended Mix");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit WHERE source='retry:track-identity'").get().n, 0);
});

test("metadata refresh rejects contradictory provider IDs and corroborating identifier changes", t => {
  const f = fixture(t);
  f.service.enqueue({ ...track(1), isrc: "USAAA2600001", beatportTrackId: "81" });
  const before = f.db.prepare(`SELECT track_json FROM sonic_coverage_work`).get().track_json;
  f.advance();
  for (const conflict of [{ identityKey: "tidal:2" }, { tidalTrackId: "2" }, { tidal: { id: "2" } },
    { tidalUrl: "https://tidal.com/browse/track/2" }, { identity_key: "tidal:2" }]) {
    assert.equal(f.service.enqueue({ ...track(1), title: "Replacement", ...conflict }), "ineligible");
  }
  for (const conflict of [{ isrc: "USAAA2600002" }, { beatportTrackId: "82" }]) {
    f.service.enqueue({ ...track(1), title: "Replacement", ...conflict }, { metadataObservedAt: f.service.clock() });
  }
  assert.equal(f.db.prepare(`SELECT track_json FROM sonic_coverage_work`).get().track_json, before);
  assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM sonic_coverage_work`).get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 0);
});

test("refresh leaves running, claimed, completed, analyzer and resolved-alias work untouched", t => {
  const f = fixture(t);
  for (const id of [1, 2, 3, 4, 5]) f.service.enqueue(track(id));
  f.db.prepare(`UPDATE sonic_coverage_work SET state='running',claim_token='live' WHERE identity_key='production:${MODEL_VERSION}:tidal:1'`).run();
  f.db.prepare(`UPDATE sonic_coverage_work SET claim_token='reserved' WHERE identity_key='production:${MODEL_VERSION}:tidal:2'`).run();
  f.store.upsertEmbedding({ track: track(3), vector: vector(), metadata: { identityRelation: "exact" }, model: MODEL, modelVersion: MODEL_VERSION });
  f.db.prepare(`UPDATE sonic_coverage_work SET state='prepared' WHERE identity_key='production:${MODEL_VERSION}:tidal:3'`).run();
  f.db.prepare(`UPDATE sonic_coverage_work SET analyzer_key='optional-model' WHERE identity_key='production:${MODEL_VERSION}:tidal:4'`).run();
  f.db.prepare(`UPDATE sonic_coverage_work SET resolved_identity_key='production:${MODEL_VERSION}:tidal:99' WHERE identity_key='production:${MODEL_VERSION}:tidal:5'`).run();
  const before = f.db.prepare(`SELECT identity_key,track_json FROM sonic_coverage_work ORDER BY identity_key`).all();
  f.advance();
  for (const id of [1, 2, 3, 4, 5]) f.service.enqueue({ ...track(id), title: `Corrected ${id}` }, { metadataObservedAt: f.service.clock() });
  assert.deepEqual(f.db.prepare(`SELECT identity_key,track_json FROM sonic_coverage_work ORDER BY identity_key`).all(), before);
  assert.ok(f.store.getEmbedding(track(3), { model: MODEL, modelVersion: MODEL_VERSION }));
  const alias = { artist: "Artist", title: "Original", mixVersion: "Original Mix", identityKey: "text:asserted-alias" };
  f.service.enqueue(alias);
  const aliasBefore = f.db.prepare(`SELECT track_json FROM sonic_coverage_work WHERE identity_key=?`).get(`production:${MODEL_VERSION}:${alias.identityKey}`).track_json;
  f.advance();
  f.service.enqueue({ ...alias, title: "Other recording", mixVersion: "Other Remix" }, { metadataObservedAt: f.service.clock() });
  assert.equal(f.db.prepare(`SELECT track_json FROM sonic_coverage_work WHERE identity_key=?`).get(`production:${MODEL_VERSION}:${alias.identityKey}`).track_json, aliasBefore);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 0);
});

test("retry refresh rejects inconsistent memory identity and remains scoped to eligible failed embedding work", t => {
  const f = fixture(t);
  f.service.enqueueMissing([track(1)]);
  f.service.enqueue(track(2));
  f.service.enqueue(track(3));
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',last_error='Keep evidence'`).run();
  f.db.prepare(`UPDATE sonic_coverage_work SET analyzer_key='optional-model' WHERE identity_key='production:${MODEL_VERSION}:tidal:3'`).run();
  memoryIdentity(f.db, { ...track(2), identityKey: "tidal:1", title: "Wrong provider ID" }, 110000);
  memoryIdentity(f.db, { ...track(2), title: "Outside retry scope" }, 110000);
  memoryIdentity(f.db, { ...track(3), title: "Optional analyzer" }, 110000);
  f.advance();
  f.service.resume({ retryFailed: true });
  const rows = f.db.prepare(`SELECT * FROM sonic_coverage_work ORDER BY identity_key`).all();
  assert.deepEqual(rows.map(row => JSON.parse(row.track_json).title), ["Track 1", "Track 2", "Track 3"]);
  assert.deepEqual(rows.map(row => row.state), ["pending", "failed", "failed"]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 1);
});

test("metadata refresh and its audit roll back together if persistence fails", t => {
  const f = fixture(t);
  f.service.enqueue(track(1));
  const before = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  f.advance();
  f.db.exec("CREATE TRIGGER reject_metadata_audit BEFORE INSERT ON sonic_coverage_metadata_audit BEGIN SELECT RAISE(ABORT,'audit rejected'); END");
  assert.throws(() => f.service.enqueue({ ...track(1), title: "Corrected caption" }, { metadataObservedAt: f.service.clock() }), /audit rejected/);
  assert.deepEqual(f.db.prepare(`SELECT * FROM sonic_coverage_work`).get(), before);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 0);
});

test("stale inventory and unknown reenqueues cannot replace corrections or lend request recency to metadata", async t => {
  const f = fixture(t, { items: [track(1), track(2)] });
  f.service.startBackfill(); await f.service.scanInventory();
  const jobId = f.service.latestJob().id;
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',last_error='Old failure'`).run();
  f.db.prepare(`UPDATE sonic_coverage_work SET metadata_updated_at=0 WHERE identity_key='production:${MODEL_VERSION}:tidal:2'`).run();
  f.advance();
  f.service.enqueue({ ...track(1), title: "Corrected caption" }, { metadataObservedAt: f.service.clock() });
  memoryIdentity(f.db, { ...track(1), title: "Newer local caption" }, 115000);
  memoryIdentity(f.db, { ...track(2), title: "Newer legacy caption" }, 115000);
  f.advance();
  for (const source of ["catalog", "sonic-anchor", "sonic-reviewed", "discovery-history", "playback-history",
    "standby-history", "track-memory", "global-rating", "discovery"]) {
    f.service.enqueue({ ...track(1), title: "Old inventory caption" }, { source, jobId, lazy: true });
  }
  f.service.enqueue({ ...track(1), title: "Unknown source caption" }, { lazy: true });
  f.service.enqueue({ ...track(1), title: "Older timestamp caption" }, { jobId, metadataObservedAt: 105000 });
  // A current route must retain an explicit historical metadata age, rather
  // than replacing it with today's receipt time. Freeze the legacy lower bound
  // before the lazy request timestamp is advanced.
  f.service.enqueueMissing([{ ...track(2), title: "Old candidate caption", metadataObservedAt: 90000 }]);
  const beforeRetry = f.db.prepare(`SELECT * FROM sonic_coverage_work ORDER BY identity_key`).all();
  assert.deepEqual(beforeRetry.map(row => JSON.parse(row.track_json).title), ["Corrected caption", "Track 2"]);
  assert.deepEqual(beforeRetry.map(row => row.metadata_updated_at), [110000, 100000]);
  assert.deepEqual(beforeRetry.map(row => row.requested_at), [120000, 120000]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit WHERE event='metadata-refresh'").get().n, 1);
  f.service.resume({ retryFailed: true });
  const afterRetry = f.db.prepare(`SELECT * FROM sonic_coverage_work ORDER BY identity_key`).all();
  assert.deepEqual(afterRetry.map(row => JSON.parse(row.track_json).title), ["Newer local caption", "Newer legacy caption"]);
  assert.deepEqual(afterRetry.map(row => row.metadata_updated_at), [115000, 115000]);
  assert.equal(f.calls.length, 0);
});

test("known-catalog inventory refresh pairs freshly read metadata with its own persisted observation time", async t => {
  const old = { ...track(1), title: "Cached inventory caption", mixVersion: "Extended Mix" };
  const f = fixture(t, { items: [old] });
  f.service.startBackfill(); await f.service.scanInventory();
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',last_error='Old failure'`).run();
  memoryIdentity(f.db, { ...track(1), title: "Current memory caption" }, 110000);
  f.advance(20000);
  f.service.enqueue(old, { source: "known-catalog", jobId: f.service.latestJob().id });
  const work = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  assert.equal(JSON.parse(work.track_json).title, "Current memory caption", "the cached input never borrows the newer row's timestamp");
  assert.equal(JSON.parse(work.track_json).mixVersion, "Extended Mix", "an empty memory field does not clear a recording descriptor");
  assert.equal(work.metadata_updated_at, 110000);
  assert.equal(work.state, "failed");
  assert.equal(work.last_error, "Old failure");
  assert.equal(f.db.prepare("SELECT source FROM sonic_coverage_metadata_audit").get().source, "enqueue:known-catalog");
});

test("current discovery refresh supplies observation provenance and respects an explicitly older metadata age", t => {
  const f = fixture(t);
  f.service.enqueueMissing([{ ...track(1), title: "Old discovery caption", mixVersion: "Stale caption" }]);
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',attempts=2,last_error='Original identity failure'`).run();
  f.advance();
  assert.equal(f.service.enqueueMissing([{ ...track(1), mixVersion: "" }]).lazyFillFailedCount, 1);
  let work = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  assert.equal(JSON.parse(work.track_json).title, "Track 1");
  assert.equal(JSON.parse(work.track_json).mixVersion, "");
  assert.equal(work.metadata_updated_at, 110000);
  assert.equal(work.state, "failed");
  assert.equal(work.attempts, 2);
  assert.equal(work.last_error, "Original identity failure");
  f.advance();
  f.service.enqueueMissing([{ ...track(1), title: "Old saved caption", metadataObservedAt: 100000 }]);
  work = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  assert.equal(JSON.parse(work.track_json).title, "Track 1");
  assert.equal(work.metadata_updated_at, 110000);
  assert.equal(work.requested_at, 120000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 1);
  assert.equal(f.calls.length, 0);
});

test("a newer identical metadata observation blocks an older different memory caption at retry", t => {
  const f = fixture(t);
  f.service.enqueueMissing([track(1)]);
  f.db.prepare(`UPDATE sonic_coverage_work SET state='failed',attempts=2,last_error='Original failure'`).run();
  const before = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  f.advance(20000);
  f.service.enqueueMissing([track(1)]);
  const confirmed = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  assert.equal(confirmed.metadata_updated_at, 120000);
  for (const key of ["track_json", "state", "attempts", "last_error"]) assert.equal(confirmed[key], before[key]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit").get().n, 0);
  memoryIdentity(f.db, { ...track(1), title: "Older memory caption" }, 110000);
  f.service.resume({ retryFailed: true });
  const retried = f.db.prepare(`SELECT * FROM sonic_coverage_work`).get();
  assert.equal(JSON.parse(retried.track_json).title, "Track 1");
  assert.equal(retried.metadata_updated_at, 120000);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit WHERE event='metadata-refresh'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sonic_coverage_metadata_audit WHERE event='retry'").get().n, 1);
  assert.equal(f.calls.length, 0);
});


test("legacy vectors and canceled legacy work never count as current MERT coverage", async t => {
  const f = fixture(t, {items:[track(1)]});
  f.store.upsertEmbedding({track:track(1),model:"discogs-effnet",modelVersion:"1",vector:Array(1280).fill(.1)});
  f.db.prepare("INSERT INTO sonic_coverage_work(identity_key,track_json,priority,source,state,requested_at,updated_at) VALUES(?, ?, 6, 'old', 'cancelled', 1, 1)").run("tidal:1",JSON.stringify(track(1)));
  f.service.startBackfill(); await f.service.scanInventory();
  assert.equal(f.service.status().job.remaining,1);
  assert.equal(f.service.status().job.alreadyEmbedded,0);
  await f.completeOne(); await f.completeOne();
  assert.equal(f.service.status().job.state,"completed");
  assert.equal(f.service.status().legacyQueueCounts.cancelled,1);
  assert.ok(f.store.getEmbedding(track(1),{model:"discogs-effnet",modelVersion:"1"}));
});

test("canceled bulk resumes missing MERT work and explicit anchors work while bulk is paused", async t => {
  const f=fixture(t,{items:[track(1),track(2)]});
  f.service.startBackfill(); await f.service.scanInventory(); f.service.cancel();
  assert.equal(f.service.status().job.state,"cancelled");
  assert.equal(f.service.status().job.remaining,2);
  f.service.pause();
  const result=await f.service.prepareOnDemand(track(1));
  assert.equal(result.ready,true);
  assert.equal(result.model,MODEL);
  assert.equal(f.service.status().settings.paused,true);
  f.service.resume(); await f.completeOne(); await f.completeOne();
  assert.equal(f.service.status().job.remaining,0);
  assert.equal(f.service.status().job.state,"completed");
  assert.deepEqual(f.calls,["1","2"]);
});

test("terminal failures cannot complete a job; retry persists reason and later succeeds", async t => {
  let broken=true;
  const f=fixture(t,{items:[track(1)],prepare:async()=>{if(broken)throw new Error("Verified source unavailable");}});
  f.service.startBackfill();await f.service.scanInventory();await f.completeOne();await f.completeOne();
  assert.equal(f.service.status().job.state,"failed");
  assert.match(f.service.status().recentFailures[0].error,/source unavailable/);
  assert.equal(f.service.status().job.preparedSuccessfully,0);
  broken=false;f.service.resume({retryFailed:true});await f.completeOne();await f.completeOne();
  assert.equal(f.service.status().job.state,"completed");
  assert.equal(f.service.status().job.failed,0);
});

test("recoverable failures expose retry timing and recover on the worker", async t => {
  let fail=true;
  const f=fixture(t,{prepare:async()=>{if(fail)throw Object.assign(new Error("Source timed out"),{statusCode:503});}});
  await assert.rejects(f.service.prepareOnDemand(track(1)),/timed out/);
  assert.equal(f.service.status().workStates.retrying,1);
  assert.match(f.service.status().retrying[0].error,/timed out/);
  fail=false;f.advance(31000);await f.completeOne();
  assert.ok(f.service.existing(track(1)));
});


test("production preparation prefers a verified local identity link and persists the current spec",async t=>{
 const f=fixture(t);f.db.exec("CREATE TABLE track_identity(id INTEGER,identity_key TEXT); CREATE TABLE local_library_file(id INTEGER,file_path TEXT,file_hash TEXT,status TEXT); CREATE TABLE local_library_identity_link(local_file_id INTEGER,track_identity_id INTEGER,link_status TEXT)");
 f.db.prepare("INSERT INTO track_identity VALUES(1,'tidal:1')").run();
 f.db.prepare("INSERT INTO local_library_file VALUES(7,'verified.flac',?,'processed')").run("a".repeat(64));
 f.db.exec("INSERT INTO local_library_identity_link VALUES(7,1,'EXACT')");
 let selected;
 f.service.analysis={prepare:async(value,key)=>{selected=value.analysisLocal;assert.equal(key,MODEL_VERSION);f.store.upsertEmbedding({track:value,model:MODEL,modelVersion:MODEL_VERSION,vector:vector(),sourceSha256:selected.sha256,metadata:{provenance:{sourceType:'verified-local-file',localFileId:7}}});return {prepared:true,identityKey:value.identityKey};}};
 const result=await f.service.prepareOnDemand(track(1));assert.equal(result.ready,true);assert.equal(selected.localFileId,7);assert.equal(f.calls.length,0);
});
