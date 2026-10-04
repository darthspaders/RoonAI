"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createStatusDelivery, statusChunks } = require("../src/statusDelivery");
const { fileSignatures, savedStatusSignatures, createReadOnlyMusicMemoryStatus, buildStoredStatus, createStoredStatusCache, version } = require("../src/statusDeliveryWorker");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { appSnapshot } = require("../src/statusSnapshot");
const { TasteProfile } = require("../src/tasteProfile");
const { SessionStore } = require("../src/sessionStore");
const { QueryYieldTracker } = require("../src/queryYieldTracker");
const { GenreProfileStore } = require("../src/genreProfileStore");
const { TrackMemory } = require("../src/trackMemory");
const { StandbyCandidateStore } = require("../src/standbyCandidateStore");
const { DiscoveryHistory } = require("../src/discoveryHistory");
const { ListeningHistory } = require("../src/listeningHistory");
const { FreshPool, FreshnessEvents } = require("../src/standbyFreshness");
const { createStandbyRefreshService } = require("../src/standbyRefreshService");
const { summarizeStandbyFreshness } = require("../src/standbyDiscoveryPlanner");
const { candidateIdentityKeys, parseRequestedCount } = require("../src/discoveryEngine");
const { mergeTrackLists } = require("../src/trackListMerge");
const { normalizeMatchText } = require("../src/tidalMatchRules");
const { createDiscoveryResultVerification } = require("../src/discoveryResultVerification");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabbit-status-"));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const keys = ["session", "taste", "queryYield", "genreProfiles", "memory", "standby", "discoveryHistory", "listeningHistory", "standbyEvents"];
  const files = Object.fromEntries(keys.map(key => [key, path.join(root, key + ".json")]));
  const values = {
    session: { updatedAt: "2026-10-04T00:00:00.000Z", options: { count: 4 }, result: {
      tracks: [{ artist: "An Artist", title: "An Exact Track", tidal: { id: "123", verified: true, source: "tidal" },
        roon: { verified: true, queueAction: { item_key: "exact-source-key" } }, statusChecks: ["Exact source retained"] }],
      alternates: [{ artist: "Other", title: "Alternate", providerIds: { tidal: "456" } }], discarded: [],
      verification: { minScore: 60 }, debug: { sourceIdentity: "keep-every-field" }
    } },
    taste: { feedback: {}, candidates: {}, calibration: {}, artists: {}, labels: {} },
    queryYield: { entries: {} }, genreProfiles: { profiles: {} }, memory: { entries: [{ key: "exact", artist: "An Artist", title: "An Exact Track" }] },
    standby: { candidates: [] }, discoveryHistory: { entries: [] }, listeningHistory: { plays: [] }, standbyEvents: { entries: [] }
  };
  await Promise.all(keys.map(key => fs.writeFile(files[key], JSON.stringify(values[key]))));
  return { root, files, values, cleanup };
}
const decode = array => JSON.parse(Buffer.from(array).toString());
const decodeFragment = array => JSON.parse("{" + Buffer.from(array).toString() + "}");

test("status chunks preserve source fields, transfer buffer identity and valid empty objects", () => {
  const full = Buffer.from('"session":{"result":{"source":"tidal","id":"42"}}'), compact = Buffer.from('"sessionVersion":"v1","compact":true');
  const chunks = statusChunks({ zones: [{ now_playing: { source: "sxm", url: "sxm:52" } }] }, { latestResultSource: "discovery" }, { full, compact });
  assert.equal(chunks[1], full);
  assert.equal(JSON.parse(Buffer.concat(chunks)).app.session.result.id, "42");
  assert.deepEqual(JSON.parse(Buffer.concat(statusChunks({}, {}, { full: Buffer.alloc(0) }))), { app: {} });
  assert.deepEqual(JSON.parse(Buffer.concat(statusChunks({}, {}, { compact }, true))), { app: { sessionVersion: "v1", compact: true } });
});

test("stored snapshot matches existing full snapshot helpers and never writes fixture files", async t => {
  const { files } = await fixture(t);
  const hashes = async () => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")])));
  const before = await hashes();
  const stored = buildStoredStatus({ files, targetCount: 3 });
  const tasteProfile = new TasteProfile(files.taste), discoveryHistory = new DiscoveryHistory({ file: files.discoveryHistory });
  const standbyStore = new StandbyCandidateStore({ file: files.standby, targetCount: 3 });
  const { standbyFreshSummary } = createStandbyRefreshService({
    candidateIdentityKeys, FreshPool, discoveryHistory, tasteProfile, standbyStore,
    listeningHistory: new ListeningHistory({ file: files.listeningHistory }), standbyEvents: new FreshnessEvents(files.standbyEvents),
    summarizeStandbyFreshness, previouslySuggestedTrack: track => discoveryHistory.entryFor(track), STANDBY_TARGET_COUNT: 3
  });
  const { syncFinalResultVerification } = createDiscoveryResultVerification({ candidateIdentityKeys, mergeTrackLists, normalizeMatchText });
  const original = appSnapshot({
    sessionStore: new SessionStore(files.session), tasteProfile, parseRequestedCount, syncFinalResultVerification,
    genreProfileStore: new GenreProfileStore({ file: files.genreProfiles }), trackMemory: new TrackMemory({ file: files.memory }),
    standbyFreshSummary, queryYieldTracker: new QueryYieldTracker(files.queryYield),
    lastfm: { status: () => ({}) }, tidal: { status: () => ({}) }, tidalProfileMixes: { status: () => ({}) },
    radioMetadataResolver: { status: () => ({}) }, metadataEnrichment: { status: () => ({}) }, llmSnapshot: () => ({})
  });
  for (const key of Object.keys(stored)) assert.deepEqual(stored[key], original[key], key);
  assert.equal(stored.session.result.tracks[0].roon.queueAction.item_key, "exact-source-key");
  assert.equal(stored.session.result.verification.requested, 4);
  assert.deepEqual(await hashes(), before);
});

test("worker serves full and compact fragments, refreshes same-timestamp replacements and deletion", async t => {
  const { files, values } = await fixture(t);
  const delivery = createStatusDelivery({ files }); t.after(() => delivery.close());
  const first = await delivery.read(), full = decodeFragment(first.full), compact = decodeFragment(first.compact);
  assert.deepEqual(compact.feedback, full.feedback);
  assert.deepEqual(compact.taste, full.taste);
  assert.equal(compact.session, undefined);
  assert.equal(compact.sessionVersion, first.sessionVersion);
  assert.equal(compact.sessionUpdatedAt, values.session.updatedAt);
  assert.equal(decode(first.session).sessionVersion, first.sessionVersion);
  assert.equal((await delivery.read()).full, first.full);
  values.session.result.debug.sourceIdentity = "replacement-keeps-same-updatedAt";
  const temp = files.session + ".new"; await fs.writeFile(temp, JSON.stringify(values.session)); await fs.rename(temp, files.session);
  const second = await delivery.read();
  assert.notEqual(second.sessionVersion, first.sessionVersion);
  assert.equal(decode(second.session).result.debug.sourceIdentity, "replacement-keeps-same-updatedAt");
  await fs.unlink(files.session);
  const deleted = await delivery.read();
  assert.equal(typeof deleted.sessionVersion, "string"); assert.notEqual(deleted.sessionVersion, second.sessionVersion);
  assert.equal(decode(deleted.session).result, null);
});

test("cache retries a store changed during build and expires time-dependent standby summaries", async () => {
  let now = 0, key = "before", builds = 0;
  const cache = createStoredStatusCache({ files: {}, clock: () => now, ttlMs: 100,
    signatures: async () => ({ session: key }), build: async () => {
      builds++; if (builds === 1) key = "after";
      return { session: { updatedAt: key, result: null }, standby: { count: builds } };
    } });
  const first = await cache.refresh(); assert.equal(builds, 2); assert.equal(first.sessionVersion, version("after"));
  assert.equal((await cache.refresh()).changed, false);
  now = 100; assert.equal((await cache.refresh()).changed, true); assert.equal(builds, 3);
});

test("cache fails boundedly when saved stores keep changing", async () => {
  let key = 0, builds = 0;
  const cache = createStoredStatusCache({ files: {}, signatures: async () => ({ session: ++key }),
    build: async () => { builds++; return { session: { result: null } }; } });
  await assert.rejects(cache.refresh(), /changed during/); assert.equal(builds, 3);
});

test("signature checks observe replacement identity and reject oversized stores", async t => {
  const { files } = await fixture(t);
  const first = await fileSignatures(files);
  const bytes = await fs.readFile(files.taste), temp = files.taste + ".new";
  await fs.writeFile(temp, bytes); await fs.rename(temp, files.taste);
  assert.notEqual((await fileSignatures(files)).taste, first.taste);
  const handle = await fs.open(files.taste, "r+"); await handle.truncate(128 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(fileSignatures(files), /size limit/);
});

test("worker requests coalesce, ignore old epochs, recover failures and close pending work", async () => {
  const workers = [];
  class FakeWorker extends EventEmitter {
    unref() {} postMessage(message) { this.message = message; if (message.type === "close") { this.closed = true; this.emit("exit", 0); } } async terminate() { this.terminated = true; }
  }
  const delivery = createStatusDelivery({ files: {}, workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const a = delivery.read(), b = delivery.read(); assert.equal(a, b); assert.equal(workers.length, 1);
  workers[0].emit("message", { id: 0, error: "old epoch" });
  workers[0].emit("error", Error("failed")); await assert.rejects(a, /worker stopped/); await assert.rejects(b, /worker stopped/);
  const c = delivery.read(); assert.equal(workers.length, 2);
  workers[0].emit("message", { id: workers[0].message.id, error: "stale old worker" });
  const buffer = value => Uint8Array.from(Buffer.from(value)).buffer;
  workers[1].emit("message", { id: workers[1].message.id, changed: true, snapshotVersion: "v2", sessionVersion: "s2", full: buffer('"session":{}'), compact: buffer('"compact":true'), session: buffer('{}') });
  assert.equal((await c).snapshotVersion, "v2");
  const pending = delivery.read(); await delivery.close(); await assert.rejects(pending, /shutting down/);
  assert.equal(workers[1].closed, true); await assert.rejects(delivery.read(), /shutting down/);
});

test("a timed-out worker is terminated and the next status request can recover", async t => {
  const workers = [];
  class FakeWorker extends EventEmitter {
    unref() {} postMessage(message) { this.message = message; if (message.type === "close") { this.closed = true; this.emit("exit", 0); } } async terminate() { this.terminated = true; }
  }
  const delivery = createStatusDelivery({ files: {}, timeoutMs: 20,
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  // Keep this isolated fake-worker test alive while the production timeout is
  // deliberately unreferenced, as it is in a running HTTP server.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(async () => { clearTimeout(keepAlive); await delivery.close(); });
  await assert.rejects(delivery.read(), error => error.statusCode === 503 && /too long/.test(error.message));
  assert.equal(workers[0].terminated, true);
  const recovered = delivery.read();
  const buffer = value => Uint8Array.from(Buffer.from(value)).buffer;
  workers[1].emit("message", { id: workers[1].message.id, changed: true, snapshotVersion: "recovered",
    sessionVersion: "session", full: buffer('"session":{}'), compact: buffer('"compact":true'), session: buffer('{}') });
  assert.equal((await recovered).snapshotVersion, "recovered");
});

test("read-only SQL summary preserves the original counts and worker observes WAL changes", async t => {
  const { root, files, cleanup } = await fixture(t), dbFile = path.join(root, "memory.sqlite");
  const writer = new MusicMemoryStore({ dbFile, logger: null });
  assert.equal(writer.enabled, true);
  const reader = createReadOnlyMusicMemoryStatus({ enabled: true, dbFile });
  const delivery = createStatusDelivery({ files, musicMemory: { enabled: true, dbFile } });
  cleanup.push(async () => { await delivery.close(); reader.close(); writer.close(); });
  writer.rememberObservation({ artist: "Fixture", title: "First" }, "fixture", { sourceEventId: "first" });
  const sourceHashes = async () => Object.fromEntries(await Promise.all([dbFile, dbFile + "-wal"].map(async file =>
    [file, crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")])));
  const before = await sourceHashes();
  const signatures = await savedStatusSignatures(files, { enabled: true, dbFile });
  assert.deepEqual(reader.read(signatures.musicMemory), writer.status());
  const first = await delivery.read();
  assert.deepEqual(first.musicMemory, writer.status());
  assert.equal(decodeFragment(first.full).musicMemory, undefined);
  assert.deepEqual(await sourceHashes(), before);
  assert.equal((await delivery.read()).musicMemory, first.musicMemory);
  writer.rememberObservation({ artist: "Fixture", title: "Second" }, "fixture", { sourceEventId: "second" });
  const second = await delivery.read();
  assert.equal(second.musicMemory.trackCount, first.musicMemory.trackCount + 1);
  assert.notEqual(second.snapshotVersion, first.snapshotVersion);
  assert.equal(second.sessionVersion, first.sessionVersion);
  assert.deepEqual(second.musicMemory, writer.status());
});

test("SQL status opens no database when disabled and recovers missing or invalid files", async t => {
  const { root, cleanup } = await fixture(t), dbFile = path.join(root, "recover.sqlite");
  const disabled = createReadOnlyMusicMemoryStatus({ enabled: false, dbFile });
  assert.deepEqual(disabled.read(), { enabled: false, dbFile });
  assert.equal(createReadOnlyMusicMemoryStatus().read(), null);
  await assert.rejects(fs.stat(dbFile), { code: "ENOENT" });
  const reader = createReadOnlyMusicMemoryStatus({ enabled: true, dbFile }); cleanup.push(() => reader.close());
  assert.throws(() => reader.read("missing"), /unavailable/);
  await assert.rejects(fs.stat(dbFile), { code: "ENOENT" });
  await fs.writeFile(dbFile, "invalid database");
  assert.throws(() => reader.read("1:1"));
  await fs.unlink(dbFile);
  const writer = new MusicMemoryStore({ dbFile, logger: null }); cleanup.push(() => writer.close());
  assert.deepEqual(reader.read("2:2"), writer.status());
  assert.throws(() => reader.read("missing"), /unavailable/);
  assert.deepEqual(reader.read("2:2"), writer.status());
});

test("SQL status closes its previous connection when the database identity changes", async t => {
  const { root, cleanup } = await fixture(t), firstFile = path.join(root, "first.sqlite"), secondFile = path.join(root, "second.sqlite");
  const first = new MusicMemoryStore({ dbFile: firstFile, logger: null }), second = new MusicMemoryStore({ dbFile: secondFile, logger: null });
  second.rememberObservation({ artist: "Fixture", title: "Replacement" }, "fixture", { sourceEventId: "replacement" });
  const options = { enabled: true, dbFile: firstFile }, reader = createReadOnlyMusicMemoryStatus(options);
  cleanup.push(() => { reader.close(); first.close(); second.close(); });
  assert.equal(reader.read("1:1").trackCount, 0);
  options.dbFile = secondFile;
  assert.equal(reader.read("2:2").trackCount, 1);
  options.enabled = false;
  assert.deepEqual(reader.read("2:2"), { enabled: false, dbFile: secondFile });
  options.enabled = true;
  assert.equal(reader.read("2:2").trackCount, 1);
});

test("database signatures include WAL replacements without the JSON allocation size cap", async t => {
  const { root, files } = await fixture(t), dbFile = path.join(root, "large.sqlite");
  const handle = await fs.open(dbFile, "w"); await handle.truncate(128 * 1024 * 1024 + 1); await handle.close();
  const first = await savedStatusSignatures(files, { enabled: true, dbFile });
  assert.equal(first.musicMemoryWal, "missing");
  await fs.writeFile(dbFile + "-wal", "changed fixture WAL");
  const second = await savedStatusSignatures(files, { enabled: true, dbFile });
  assert.notEqual(second.musicMemoryWal, first.musicMemoryWal);
  assert.equal(Object.prototype.hasOwnProperty.call(second, "musicMemoryShm"), false);
  await assert.rejects(fileSignatures({ oversizedJson: dbFile }), /size limit/);
});
