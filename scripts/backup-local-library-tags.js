"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function usage() {
  console.log(`Rabbit Hole local-library original-tag backup

Creates a JSON snapshot from the database-only scan. It never changes audio files:
  npm run metadata:backup-tags

Options:
  --db <path>       Rabbit Hole SQLite database path
  --report <path>   Output JSON path (default is timestamped under data/)
  --help            Show this help`);
}

function parseArgs(argv) {
  const args = { dbFile: config.musicMemory.dbFile, reportFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--report") args.reportFile = path.resolve(argv[++index] || "");
  }
  return args;
}

function defaultReportFile() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(__dirname, "..", "data", `local-library-original-tags-backup-${stamp}.json`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!DatabaseSync) throw new Error("This command requires Node.js node:sqlite support.");
  const reportFile = args.reportFile || defaultReportFile();
  const db = new DatabaseSync(args.dbFile, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, file_hash, file_path, file_size, file_modified_at, file_format,
        artist, title, album, raw_tags_json, last_scanned_at
      FROM local_library_file
      WHERE status = 'processed'
      ORDER BY file_path COLLATE NOCASE
    `).all();
    const entries = [];
    const changedOrMissing = [];
    for (const row of rows) {
      let current = null;
      try {
        const stat = fs.statSync(row.file_path);
        current = {
          size: Number(stat.size),
          modifiedAt: new Date(stat.mtimeMs).toISOString()
        };
      } catch (error) {
        changedOrMissing.push({ filePath: row.file_path, reason: `STAT_FAILED: ${error.message}` });
      }
      const unchanged = Boolean(current
        && current.size === Number(row.file_size)
        && current.modifiedAt === row.file_modified_at);
      if (current && !unchanged) {
        changedOrMissing.push({
          filePath: row.file_path,
          reason: "FILE_CHANGED_SINCE_SCAN",
          scanned: { size: Number(row.file_size), modifiedAt: row.file_modified_at },
          current
        });
      }
      let originalTags = {};
      try { originalTags = row.raw_tags_json ? JSON.parse(row.raw_tags_json) : {}; } catch { originalTags = {}; }
      entries.push({
        filePath: row.file_path,
        fileHash: row.file_hash,
        fileSize: Number(row.file_size) || null,
        fileModifiedAt: row.file_modified_at || null,
        fileFormat: row.file_format || null,
        artist: row.artist || null,
        title: row.title || null,
        album: row.album || null,
        originalTags,
        scannedAt: row.last_scanned_at || null,
        verifiedUnchangedSinceScan: unchanged
      });
    }
    const backup = {
      schemaVersion: 1,
      backupType: "database_snapshot_of_original_embedded_tags",
      generatedAt: new Date().toISOString(),
      sourceDatabase: path.resolve(args.dbFile),
      policy: {
        audioFilesWritten: false,
        tagsWritten: false,
        restoreReady: false,
        note: "This is the pre-write snapshot. A format-aware restore command will be added before any tag mutation is enabled."
      },
      summary: {
        filesScanned: rows.length,
        entriesWritten: entries.length,
        changedOrMissingCount: changedOrMissing.length
      },
      changedOrMissing,
      entries
    };
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...backup.summary, reportFile }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    usage();
    process.exitCode = 1;
  }
}

module.exports = { defaultReportFile, main, parseArgs };
