"use strict";

const fs = require("node:fs");
const path = require("node:path");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const config = require("../src/config");

const TECHNICAL_PATTERNS = [
  /copyright/i,
  /muted/i,
  /detected/i,
  /cleaned/i,
  /angle\s*\d+/i,
  /title\s*\d+/i,
  /(?:^|[\s._-])master(?:[\s._)\]-]|$)/i
];

const LONG_FORM_PATTERNS = [
  /continuous/i,
  /mixed\s+by/i,
  /radio\s+wonderland/i,
  /sunrise\s+set/i,
  /at\s+pompeii/i,
  /private\s+playlist/i,
  /\b(?:abgt|tritonia|wym)\s*\d+/i
];

const SPOKEN_PATTERNS = [
  /\bskit\b/i,
  /\binterlude\b/i,
  /\bspoken\b/i,
  /\bvoice\s*over\b/i
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    model: "discogs-effnet",
    modelVersion: "1",
    report: path.join(__dirname, "..", "data", "sonic-training-audit.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--model") args.model = cleanText(argv[++index]) || args.model;
    else if (arg === "--model-version") args.modelVersion = cleanText(argv[++index]) || args.modelVersion;
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function classifyRow(row) {
  const artist = cleanText(row.artist);
  const title = cleanText(row.title);
  const album = cleanText(row.album);
  const filePath = cleanText(row.file_path);
  const haystack = [artist, title, album, filePath].filter(Boolean).join(" ");
  const reasons = [];
  const addMatches = (patterns, code, label) => {
    if (patterns.some((pattern) => pattern.test(haystack))) reasons.push({ code, label });
  };

  if (!artist && !title) reasons.push({ code: "MISSING_IDENTITY", label: "missing artist and title" });
  addMatches(TECHNICAL_PATTERNS, "TECHNICAL_EXPORT", "technical/test/export marker");
  addMatches(LONG_FORM_PATTERNS, "LONG_FORM_OR_BROADCAST", "continuous, mixed, broadcast, or set-like marker");
  addMatches(SPOKEN_PATTERNS, "SPOKEN_OR_SKIT", "skit, interlude, spoken, or voice-over marker");

  const durationMs = Number(row.duration_ms || 0);
  if (durationMs >= 20 * 60 * 1000) reasons.push({ code: "LONG_DURATION", label: "duration is at least 20 minutes" });
  if (/^untitled(?:\s+\d+)?$/i.test(title)) reasons.push({ code: "UNRELIABLE_TITLE", label: "untitled title" });

  const highConfidenceCodes = new Set(["MISSING_IDENTITY", "TECHNICAL_EXPORT", "LONG_DURATION"]);
  const reviewCodes = new Set(["LONG_FORM_OR_BROADCAST", "SPOKEN_OR_SKIT", "UNRELIABLE_TITLE"]);
  const highConfidence = reasons.some((reason) => highConfidenceCodes.has(reason.code));
  const review = reasons.some((reason) => reviewCodes.has(reason.code));
  return {
    localFileId: Number(row.id),
    filePath,
    artist,
    title,
    album,
    durationMs: durationMs || null,
    hash: cleanText(row.file_hash),
    profileCount: Number(row.profile_count || 0),
    sonicProfilePresent: Number(row.profile_count || 0) > 0,
    disposition: highConfidence ? "EXCLUDE_FROM_TASTE_TRAINING_REVIEW" : review ? "REVIEW" : "KEEP_PENDING_QUALITATIVE_REVIEW",
    reasons
  };
}

function buildReport(db, args) {
  // `source_sha256` is not the primary lookup key on the sonic-profile table.
  // Load the small aggregate once instead of making SQLite repeatedly scan the
  // profile table for every local-library row.
  const profileCounts = new Map(
    db.prepare(`
      SELECT source_sha256, COUNT(id) AS profile_count
      FROM track_sonic_profile
      WHERE model = ?
        AND model_version = ?
        AND source_sha256 IS NOT NULL
      GROUP BY source_sha256
    `).all(args.model, args.modelVersion)
      .filter((row) => row.source_sha256)
      .map((row) => [String(row.source_sha256), Number(row.profile_count || 0)])
  );
  const rows = db.prepare(`
    SELECT f.id, f.file_path, f.file_hash, f.artist, f.title, f.album, f.duration_ms
    FROM local_library_file f
    WHERE f.status = 'processed'
    ORDER BY f.id ASC
  `).all();
  const candidates = rows.map((row) => classifyRow({
    ...row,
    profile_count: profileCounts.get(String(row.file_hash || "")) || 0
  }));
  const byDisposition = (value) => candidates.filter((candidate) => candidate.disposition === value).length;
  const byReason = new Map();
  for (const candidate of candidates) {
    for (const reason of candidate.reasons) byReason.set(reason.code, (byReason.get(reason.code) || 0) + 1);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    options: {
      dbFile: path.resolve(args.dbFile),
      model: args.model,
      modelVersion: args.modelVersion,
      readOnly: true,
      automaticExclusion: false
    },
    summary: {
      rowsScanned: candidates.length,
      profilesPresent: candidates.filter((candidate) => candidate.sonicProfilePresent).length,
      excludeFromTasteTrainingReview: byDisposition("EXCLUDE_FROM_TASTE_TRAINING_REVIEW"),
      review: byDisposition("REVIEW"),
      keepPendingQualitativeReview: byDisposition("KEEP_PENDING_QUALITATIVE_REVIEW"),
      reasonCounts: Object.fromEntries(Array.from(byReason.entries()).sort(([left], [right]) => left.localeCompare(right)))
    },
    policy: {
      purpose: "flag likely non-musical or technical material before taste-cluster training",
      excludedFromDatabase: false,
      excludedFromSonicStore: false,
      requiresHumanReview: true,
      note: "Rules are conservative heuristics. A flagged row remains available for identity, audit, and future review."
    },
    candidates
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: npm run sonic:audit:local -- [--db PATH] [--model NAME] [--model-version VERSION] [--report PATH]");
    return null;
  }
  if (!DatabaseSync) throw new Error("This command requires Node.js node:sqlite support.");
  const db = new DatabaseSync(args.dbFile, { readOnly: true });
  try {
    const report = buildReport(db, args);
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ summary: report.summary, report: args.report }, null, 2));
    return report;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`sonic training audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { classifyRow, buildReport, parseArgs, main };
