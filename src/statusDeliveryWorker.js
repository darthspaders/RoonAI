"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const { TasteProfile } = require("./tasteProfile");
const { SessionStore } = require("./sessionStore");
const { QueryYieldTracker } = require("./queryYieldTracker");
const { GenreProfileStore } = require("./genreProfileStore");
const { TrackMemory } = require("./trackMemory");
const { StandbyCandidateStore } = require("./standbyCandidateStore");
const { DiscoveryHistory } = require("./discoveryHistory");
const { ListeningHistory } = require("./listeningHistory");
const { FreshPool, FreshnessEvents } = require("./standbyFreshness");
const { candidateIdentityKeys, parseRequestedCount } = require("./discoveryEngine");
const { normalizeMatchText } = require("./tidalMatchRules");
const { mergeTrackLists } = require("./trackListMerge");
const { createDiscoveryResultVerification } = require("./discoveryResultVerification");
const { createStandbyRefreshService } = require("./standbyRefreshService");
const { summarizeStandbyFreshness } = require("./standbyDiscoveryPlanner");
const { sessionSnapshot } = require("./statusSnapshot");
const { MusicMemoryStore } = require("./musicMemoryStore");

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const version = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fileSignatures(files, { unboundedKeys = new Set() } = {}) {
  const entries = await Promise.all(Object.entries(files).map(async ([key, file]) => {
    try {
      const stat = await fs.stat(file, { bigint: true });
      if (!unboundedKeys.has(key) && stat.size > BigInt(MAX_SOURCE_BYTES)) throw Error("A saved status store exceeds the snapshot size limit.");
      return [key, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":")];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [key, "missing"];
    }
  }));
  return Object.fromEntries(entries);
}

function savedStatusSignatures(files, musicMemory) {
  const databaseFiles = musicMemory?.enabled && musicMemory.dbFile
    ? { musicMemory: musicMemory.dbFile, musicMemoryWal: musicMemory.dbFile + "-wal" } : {};
  // SQLite files are only statted here; their size does not imply a JSON
  // allocation. Do not observe SHM, whose read marks can change on a read.
  return fileSignatures({ ...files, ...databaseFiles }, { unboundedKeys: new Set(Object.keys(databaseFiles)) });
}

function createReadOnlyMusicMemoryStatus(options, { clock = Date.now } = {}) {
  let db = null, identity = null;
  const close = () => { const owned = db; db = null; identity = null; owned?.close(); };
  return { close, read(signature = "") {
    if (!options) { close(); return null; }
    if (!options.enabled) { close(); return { enabled: false, dbFile: options.dbFile }; }
    if (!options.dbFile || signature === "missing") { close(); throw Error("The music memory status database is unavailable."); }
    const nextIdentity = signature.split(":").slice(0, 2).join(":");
    if (db && identity !== nextIdentity) close();
    try {
      if (!db) {
        const { DatabaseSync } = require("node:sqlite");
        db = new DatabaseSync(options.dbFile, { readOnly: true });
        db.exec("PRAGMA query_only = ON");
        db.exec("PRAGMA busy_timeout = 1000");
        identity = nextIdentity;
      }
      db.exec("BEGIN");
      const status = MusicMemoryStore.prototype.status.call({ enabled: true, db, dbFile: options.dbFile, clock });
      db.exec("COMMIT");
      return status;
    } catch (error) {
      try { db?.exec("ROLLBACK"); } catch {}
      close();
      throw error;
    }
  } };
}

// These constructors and helpers only read persisted state. This worker never
// starts a provider, refresh job, playback client, migration, or file writer.
function buildStoredStatus({ files, targetCount = 25 }) {
  const tasteProfile = new TasteProfile(files.taste);
  const sessionStore = new SessionStore(files.session);
  const queryYieldTracker = new QueryYieldTracker(files.queryYield);
  const genreProfileStore = new GenreProfileStore({ file: files.genreProfiles });
  const trackMemory = new TrackMemory({ file: files.memory });
  const standbyStore = new StandbyCandidateStore({ file: files.standby, targetCount });
  const discoveryHistory = new DiscoveryHistory({ file: files.discoveryHistory });
  const listeningHistory = new ListeningHistory({ file: files.listeningHistory });
  const standbyEvents = new FreshnessEvents(files.standbyEvents);
  const taste = tasteProfile.read();
  const stableTaste = { read: () => taste };
  const { syncFinalResultVerification } = createDiscoveryResultVerification({ candidateIdentityKeys, normalizeMatchText, mergeTrackLists });
  const { standbyFreshSummary } = createStandbyRefreshService({
    candidateIdentityKeys, FreshPool, discoveryHistory, listeningHistory,
    tasteProfile: stableTaste, standbyEvents, standbyStore, summarizeStandbyFreshness,
    previouslySuggestedTrack: track => discoveryHistory.entryFor(track), STANDBY_TARGET_COUNT: targetCount
  });
  return {
    session: sessionSnapshot({ sessionStore, syncFinalResultVerification, parseRequestedCount }),
    taste: tasteProfile.summary(taste), feedback: taste.feedback || {},
    genreProfiles: genreProfileStore.summary(), memory: trackMemory.summary(),
    standby: standbyFreshSummary(), queryYield: queryYieldTracker.summary()
  };
}

const encode = value => new TextEncoder().encode(JSON.stringify(value)).buffer;
const fragment = value => new TextEncoder().encode(JSON.stringify(value).slice(1, -1)).buffer;

function createStoredStatusCache({ files, musicMemory, targetCount = 25, clock = Date.now, ttlMs = 30000,
  signatures = () => savedStatusSignatures(files, musicMemory), build = () => buildStoredStatus({ files, targetCount }),
  readMusicMemoryStatus = () => null }) {
  let cachedVersion = "", builtAt = 0;
  return { async refresh() {
    // Recheck after derivation/serialization: an external replacement or a
    // concurrent feedback/save cannot publish an older snapshot as current.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await signatures(), snapshotVersion = version(before);
      if (snapshotVersion === cachedVersion && clock() - builtAt < ttlMs) return { changed: false, snapshotVersion };
      const stored = await build();
      const musicMemoryStatus = await readMusicMemoryStatus(before.musicMemory);
      const sessionVersion = version(before.session || "missing");
      const markers = { sessionVersion, sessionUpdatedAt: stored.session.updatedAt || null, snapshotVersion };
      const { session, ...metadata } = stored;
      const result = { changed: true, ...markers, musicMemory: musicMemoryStatus,
        full: fragment({ ...stored, ...markers }),
        compact: fragment({ ...metadata, ...markers, compact: true }),
        session: encode({ ...session, sessionVersion }) };
      const after = await signatures();
      if (version(after) !== snapshotVersion) continue;
      cachedVersion = snapshotVersion; builtAt = clock();
      return result;
    }
    throw Error("Saved status changed during its snapshot. Try again.");
  } };
}

if (parentPort && workerData?.statusDelivery) {
  const musicMemory = createReadOnlyMusicMemoryStatus(workerData.musicMemory);
  let closing = false;
  const cache = createStoredStatusCache({ ...workerData, readMusicMemoryStatus: signature => {
    if (closing) throw Error("Status delivery is shutting down.");
    return musicMemory.read(signature);
  } });
  parentPort.once("close", musicMemory.close);
  process.once("exit", musicMemory.close);
  parentPort.on("message", async message => {
    if (message?.type === "close") { closing = true; musicMemory.close(); parentPort.close(); return; }
    if (message?.type !== "refresh") return;
    try {
      const result = await cache.refresh();
      if (closing) return;
      const transfer = result.changed ? [result.full, result.compact, result.session] : [];
      parentPort.postMessage({ id: message.id, ...result }, transfer);
    } catch (error) {
      if (!closing) parentPort.postMessage({ id: message.id, error: error.message || "Saved status could not be read." });
    }
  });
}

module.exports = { fileSignatures, savedStatusSignatures, createReadOnlyMusicMemoryStatus, buildStoredStatus, createStoredStatusCache, version };
