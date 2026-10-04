"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { readCatalog, browseCatalog, publicRecord } = require("./databaseBrowserCatalog");

const db = new DatabaseSync(workerData.dbFile, { readOnly: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
let sonicDb = db;
if (workerData.sonicDbFile && workerData.sonicDbFile !== workerData.dbFile) {
  try { sonicDb = new DatabaseSync(workerData.sonicDbFile, { readOnly: true }); sonicDb.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;"); }
  catch { sonicDb = null; }
}
let snapshot = null;
let refreshedAt = 0;
let dataVersion = null;
parentPort.on("message", ({ id, action, query, refresh }) => {
  try {
    const version = db.prepare('PRAGMA data_version').get().data_version;
    if (!snapshot || version !== dataVersion || Date.now() - refreshedAt >= (refresh ? 1000 : 30_000)) {
      db.exec("BEGIN");
      let sonicTransaction = false;
      try {
        if (sonicDb && sonicDb !== db) { sonicDb.exec("BEGIN"); sonicTransaction = true; }
        snapshot = readCatalog(db, sonicDb); refreshedAt = Date.now();
        snapshot.localMedia = require('./localMediaInventory').readLocalMedia(db, sonicDb);
        try { snapshot.recordingGroups = require('./canonicalRecordingCatalog').readRecordingGroups(db); }
        catch { snapshot.recordingGroups = { groups: [], unavailable: true }; }
        require('./catalogBrowseGrouping').prepareBrowseGrouping(snapshot);
        dataVersion = version;
      } finally { db.exec("ROLLBACK"); if (sonicTransaction) sonicDb.exec("ROLLBACK"); }
    }
    const record = action === "detail" ? snapshot.records.find(record => record.id === Number(query.id)) : null;
    if (action === "detail" && !record) { parentPort.postMessage({ id, error: "This track is no longer in the database.", statusCode: 404 }); return; }
    parentPort.postMessage({ id, result: action === "detail" ? { track: publicRecord(record), generatedAt: snapshot.generatedAt } : browseCatalog(snapshot, query) });
  } catch (error) { parentPort.postMessage({ id, error: error.message, statusCode: 503 }); }
});
