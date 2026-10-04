"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { acquireProcessLock } = require("../src/processLock");
const { formatPolicy, writeFileTags } = require("../src/localLibraryMetadataTagWriter");

function usage() {
  console.log(`Rabbit Hole staged local-library tag writer

Dry-run (default):
  npm run metadata:write-tags -- --preview data/local-library-write-preview.json

Apply only the first ten safe-fill files:
  npm run metadata:write-tags -- --apply --limit 10

Options:
  --preview <path>       Write-preview JSON (default: data/local-library-write-preview.json)
  --report <path>        Result JSON report (default: timestamped under data/)
  --apply                Actually write the selected tags; otherwise dry-run
  --limit <n>            Maximum changed files (default 10; --apply refuses >10 without --force)
  --force                Allow more than ten files in one apply operation
  --ffmpeg <path>        FFmpeg executable path
  --ffprobe <path>       FFprobe executable path
  --help                 Show this help`);
}

function parseArgs(argv) {
  const args = {
    previewFile: path.join(__dirname, "..", "data", "local-library-write-preview.json"),
    reportFile: "",
    apply: false,
    limit: 10,
    force: false,
    ffmpegPath: process.env.LOCAL_LIBRARY_FFMPEG_PATH || "ffmpeg",
    ffprobePath: process.env.LOCAL_LIBRARY_FFPROBE_PATH || "ffprobe"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--preview") args.previewFile = path.resolve(argv[++index] || "");
    else if (arg === "--report") args.reportFile = path.resolve(argv[++index] || "");
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++index]) || args.limit);
    else if (arg === "--force") args.force = true;
    else if (arg === "--ffmpeg") args.ffmpegPath = argv[++index] || args.ffmpegPath;
    else if (arg === "--ffprobe") args.ffprobePath = argv[++index] || args.ffprobePath;
  }
  return args;
}

function defaultReportFile() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(__dirname, "..", "data", `local-library-tag-write-report-${stamp}.json`);
}

function loadCandidates(previewFile, limit) {
  const preview = JSON.parse(fs.readFileSync(previewFile, "utf8"));
  const candidates = [];
  const unsupported = [];
  for (const item of preview.items || []) {
    const safeChanges = (item.changes || []).filter((change) => change.decision === "safe_fill");
    if (!safeChanges.length) continue;
    if ((item.rowReasons || []).some((reason) => ["MISSING_IDENTITY", "UNRESOLVED_EXTERNAL_MATCH", "MULTIPLE_ACCEPTED_MUSICBRAINZ_CANDIDATES"].includes(reason))) continue;
    const policy = formatPolicy(item.file.filePath);
    if (policy.status !== "supported") {
      unsupported.push({ file: item.file, reason: policy.reason || "UNSUPPORTED_FORMAT" });
      continue;
    }
    candidates.push({
      file: item.file,
      completeness: item.completeness,
      changes: safeChanges
    });
    if (candidates.length >= limit) break;
  }
  return { preview, candidates, unsupported };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const reportFile = args.reportFile || defaultReportFile();
  const { preview, candidates, unsupported } = loadCandidates(args.previewFile, args.limit);
  if (args.apply && args.limit > 10 && !args.force) throw new Error("Staged apply is limited to 10 files. Add --force only after reviewing a smaller run.");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    sourcePreview: path.resolve(args.previewFile),
    policy: {
      selectedDecision: "safe_fill",
      skipsIdentityOrUnresolvedRows: true,
      audioCodecReencoded: false,
      writesOnlyWithExplicitApply: true,
      exactBinaryBackups: args.apply
    },
    summary: {
      candidates: candidates.length,
      unsupportedSkipped: unsupported.length,
      written: 0,
      skipped: Math.max(0, (preview.summary?.filesWithChanges || 0) - candidates.length),
      failed: 0
    },
    results: [],
    unsupported
  };
  if (!args.apply) {
    report.results = candidates.map((candidate) => ({ ...candidate, status: "would_write" }));
  } else {
    const lock = acquireProcessLock(path.join(__dirname, "..", "data", "local-library-metadata.lock"), "Local-library tag write-back");
    try {
      for (const candidate of candidates) {
        try {
          const result = await writeFileTags(candidate.file.filePath, candidate.changes, {
            ffmpegPath: args.ffmpegPath,
            ffprobePath: args.ffprobePath,
            backupDirectory: path.join(__dirname, "..", "data", "local-library-tag-write-backups"),
            journalPath: path.join(__dirname, "..", "data", "local-library-tag-write-journal.json"),
            expectedFileHash: candidate.file.fileHash,
            logger: console
          });
          report.results.push({ ...candidate, ...result });
          report.summary.written += 1;
        } catch (error) {
          report.results.push({ ...candidate, status: "failed", error: error.message });
          report.summary.failed += 1;
        }
      }
    } finally {
      lock.release();
    }
  }
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report.summary, mode: report.mode, reportFile }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    usage();
    process.exitCode = 1;
  });
}

module.exports = { defaultReportFile, loadCandidates, main, parseArgs };
