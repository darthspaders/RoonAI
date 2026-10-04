"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { buildMetadataWritePreview } = require("../src/localLibraryMetadataWritePreview");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function usage() {
  console.log(`Rabbit Hole local-library tag write preview

Read-only command; no audio file or tag is modified:
  npm run metadata:write-preview -- --report data/local-library-write-preview.json

Options:
  --db <path>                Rabbit Hole SQLite database path
  --report <path>            JSON report path
  --min-confidence <n>      Auto-fill threshold (default 95)
  --limit <n>                Return only the first n changed files
  --help                     Show this help`);
}

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    reportFile: path.join(__dirname, "..", "data", "local-library-write-preview.json"),
    minConfidence: 95,
    limit: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--report") args.reportFile = path.resolve(argv[++index] || "");
    else if (arg === "--min-confidence") args.minConfidence = Math.max(0, Math.min(100, Number(argv[++index]) || args.minConfidence));
    else if (arg === "--limit") args.limit = Math.max(0, Number(argv[++index]) || 0);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!DatabaseSync) throw new Error("This command requires Node.js node:sqlite support.");
  const db = new DatabaseSync(args.dbFile, { readOnly: true });
  try {
    const preview = buildMetadataWritePreview(db, {
      minConfidence: args.minConfidence,
      limit: args.limit
    });
    fs.mkdirSync(path.dirname(args.reportFile), { recursive: true });
    fs.writeFileSync(args.reportFile, `${JSON.stringify(preview, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...preview.summary, reportFile: args.reportFile, policy: preview.policy }, null, 2));
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

module.exports = { main, parseArgs };
