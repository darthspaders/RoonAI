"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync, backup } = require("node:sqlite");
const config = require("../src/config");
const { acquireProcessLock } = require("../src/processLock");
const { scanLocalMedia } = require("../src/localMediaInventory");
const { probeLocalAudio } = require("../src/localLibraryMetadataEnrichment");

async function main() {
  const args = process.argv.slice(2);
  const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : "";
  const rootPath = option("--root") || config.localLibrary.root;
  if (!rootPath) throw new Error("Specify --root or LOCAL_LIBRARY_ROOT.");
  const dbFile = path.resolve(option("--db") || config.musicMemory.dbFile);
  const lock = acquireProcessLock(`${dbFile}.local-media.lock`, "Local media inventory");
  let db;
  try {
    db = new DatabaseSync(dbFile); db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;");
    const backupFile = `${dbFile}.before-local-scan-${Date.now()}.bak`;
    await backup(db, backupFile);
    console.log(JSON.stringify({ backupFile, rootPath }));
    const report = await scanLocalMedia({ db, rootPath, probe: file => probeLocalAudio(file, { ffprobePath: config.localLibrary.ffprobePath }), onProgress: progress => console.log(JSON.stringify(progress)) });
    fs.writeFileSync(path.join(path.dirname(dbFile), "local-media-scan-report.json"), JSON.stringify(report, null, 2));
    if (report.status !== "complete") process.exitCode = 2;
  } finally { db?.close(); lock.release(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
