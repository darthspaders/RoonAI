"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { acquireProcessLock } = require("../src/processLock");
const { restoreFileFromBackup } = require("../src/localLibraryMetadataTagWriter");

function usage() {
  console.log(`Rabbit Hole local-library exact-binary tag restore

Dry-run (default):
  npm run metadata:restore-tags -- --report data/local-library-tag-write-report-stage-10.json

Apply a restore from the exact originals retained by the staged writer:
  npm run metadata:restore-tags -- --apply --report data/local-library-tag-write-report-stage-10.json

Options:
  --report <path>        Tag-write report containing binary backup paths
  --output <path>        Restore result report (default: timestamped under data/)
  --apply                Actually restore files; otherwise dry-run
  --limit <n>            Maximum files to restore (default all in report)
  --force                Ignore current-hash mismatch (use only after review)
  --ffprobe <path>       FFprobe executable path
  --help                 Show this help`);
}

function parseArgs(argv) {
  const args = {
    reportFile: "",
    outputFile: "",
    apply: false,
    limit: 0,
    force: false,
    ffprobePath: process.env.LOCAL_LIBRARY_FFPROBE_PATH || "ffprobe"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--report") args.reportFile = path.resolve(argv[++index] || "");
    else if (arg === "--output") args.outputFile = path.resolve(argv[++index] || "");
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++index]) || 0);
    else if (arg === "--force") args.force = true;
    else if (arg === "--ffprobe") args.ffprobePath = argv[++index] || args.ffprobePath;
  }
  return args;
}

function defaultOutputFile() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(__dirname, "..", "data", `local-library-tag-restore-report-${stamp}.json`);
}

function loadRestoreCandidates(reportFile, limit) {
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const written = (report.results || []).filter((result) => result.status === "written" && result.backupPath);
  return {
    report,
    candidates: limit > 0 ? written.slice(0, limit) : written
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.reportFile) throw new Error("A staged tag-write report is required. Supply --report <path>.");
  const outputFile = args.outputFile || defaultOutputFile();
  const { candidates } = loadRestoreCandidates(args.reportFile, args.limit);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    sourceReport: path.resolve(args.reportFile),
    policy: {
      restoresExactBinaryBackups: true,
      requiresCurrentHashMatch: !args.force,
      writesOnlyWithExplicitApply: true
    },
    summary: { candidates: candidates.length, restored: 0, failed: 0 },
    results: []
  };
  if (!args.apply) {
    result.results = candidates.map((candidate) => ({
      file: candidate.file,
      backupPath: candidate.backupPath,
      expectedCurrentHash: candidate.afterHash,
      expectedRestoredHash: candidate.beforeHash,
      status: "would_restore"
    }));
  } else {
    const lock = acquireProcessLock(path.join(__dirname, "..", "data", "local-library-metadata.lock"), "Local-library tag restore");
    try {
      for (const candidate of candidates) {
        try {
          const restored = await restoreFileFromBackup(candidate.file.filePath, candidate.backupPath, {
            ffprobePath: args.ffprobePath,
            journalPath: path.join(__dirname, "..", "data", "local-library-tag-restore-journal.json"),
            expectedCurrentHash: args.force ? "" : candidate.afterHash,
            expectedRestoredHash: candidate.beforeHash,
            logger: console
          });
          result.results.push({ ...candidate, ...restored });
          result.summary.restored += 1;
        } catch (error) {
          result.results.push({ ...candidate, status: "failed", error: error.message });
          result.summary.failed += 1;
        }
      }
    } finally {
      lock.release();
    }
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...result.summary, mode: result.mode, outputFile }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    usage();
    process.exitCode = 1;
  });
}

module.exports = { defaultOutputFile, loadRestoreCandidates, main, parseArgs };
