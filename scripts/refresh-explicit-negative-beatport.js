"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { BeatportClient } = require("../src/beatportClient");
const { confidenceForMatch } = require("../src/metadataEnrichmentService");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { acquireProcessLock } = require("../src/processLock");

const FEEDBACK_RATINGS = {
  negative: ["dislike", "skip", "never", "never_again", "down"],
  positive: ["love", "like", "good", "up"]
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    limit: 50,
    offset: 0,
    identityIds: [],
    feedbackType: "negative",
    includeAccepted: false,
    write: false,
    report: path.join(__dirname, "..", "data", "explicit-negative-beatport-refresh.json"),
    reportProvided: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(1, Math.min(50, Number(argv[++index]) || 50));
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--identity-ids" || arg === "--ids") args.identityIds = String(argv[++index] || "")
      .split(/[\s,]+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    else if (arg === "--feedback") args.feedbackType = cleanText(argv[++index]).toLowerCase() || "negative";
    else if (arg === "--include-accepted") args.includeAccepted = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--report") {
      args.report = path.resolve(argv[++index] || "");
      args.reportProvided = true;
    }
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  args.feedbackType = args.feedbackType === "positive" ? "positive" : "negative";
  if (!args.reportProvided && args.feedbackType === "positive") {
    args.report = path.join(__dirname, "..", "data", "explicit-positive-beatport-refresh.json");
  }
  return args;
}

function usage() {
  console.log(`Refresh Beatport evidence for explicit feedback identities.

Usage:
  npm run beatport:refresh-negative -- [--write] [--limit 50]
  npm run beatport:refresh-feedback -- --feedback positive [--write] [--limit 50]

Use --feedback positive|negative. Default is read-only and skips identities
that already have accepted Beatport metadata unless --include-accepted is set.
Use --identity-ids 964,1054 to target deliberate taste-area anchors.
Only strict artist/title matches with confidence >= 85 are saved when --write
is supplied. No audio files or local tags are changed.
`);
}

function readTargets(db, limit, feedbackType = "negative", { includeAccepted = false, offset = 0, identityIds = [] } = {}) {
  const type = feedbackType === "positive" ? "positive" : "negative";
  const ratings = FEEDBACK_RATINGS[type];
  const oppositeRatings = FEEDBACK_RATINGS[type === "positive" ? "negative" : "positive"];
  const selected = ratings.map(() => "?").join(", ");
  const opposite = oppositeRatings.map(() => "?").join(", ");
  const acceptedClause = includeAccepted
    ? ""
    : "AND (be.track_identity_id IS NULL OR be.confidence < 85 OR be.beatport_track_id IS NULL)";
  const safeIdentityIds = [...new Set((Array.isArray(identityIds) ? identityIds : [])
    .map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  const identityClause = safeIdentityIds.length
    ? `AND ti.id IN (${safeIdentityIds.map(() => "?").join(", ")})`
    : "";
  return db.prepare(`
    SELECT ti.id, ti.artist, ti.title, ti.mix_version AS mixVersion,
      ti.album, ti.tidal_id AS tidalId, ti.isrc
    FROM track_identity ti
    JOIN taste_feedback tf ON tf.track_identity_id = ti.id
    LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    WHERE LOWER(REPLACE(tf.rating, ' ', '_')) IN (${selected})
      ${acceptedClause}
      ${identityClause}
      AND NOT EXISTS (
        SELECT 1 FROM taste_feedback opposite
        WHERE opposite.track_identity_id = ti.id
          AND LOWER(REPLACE(opposite.rating, ' ', '_')) IN (${opposite})
      )
    GROUP BY ti.id
    ORDER BY ti.id
    LIMIT ? OFFSET ?
  `).all(...ratings, ...safeIdentityIds, ...oppositeRatings, Math.max(1, Math.min(50, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
}

function compactCandidate(candidate, confidence) {
  return {
    id: cleanText(candidate?.id),
    artist: cleanText(candidate?.artist),
    title: cleanText(candidate?.title),
    mixName: cleanText(candidate?.mixName),
    genre: cleanText(candidate?.genre),
    subgenre: cleanText(candidate?.subgenre),
    label: cleanText(candidate?.label),
    isrc: cleanText(candidate?.isrc),
    confidence: confidence.confidence,
    reason: confidence.reason
  };
}

async function refreshExplicitNegativeBeatport({
  dbFile = config.musicMemory.dbFile,
  limit = 50,
  offset = 0,
  identityIds = [],
  feedbackType = "negative",
  includeAccepted = false,
  write = false,
  report = path.join(__dirname, "..", "data", "explicit-negative-beatport-refresh.json"),
  logger = console
} = {}) {
  const type = feedbackType === "positive" ? "positive" : "negative";
  const store = new MusicMemoryStore({ ...config.musicMemory, dbFile, logger });
  if (!store.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  const targets = readTargets(store.db, limit, type, { includeAccepted, offset, identityIds });
  const beatport = new BeatportClient({ ...config.beatport, logger });
  const rows = [];
  try {
    for (const target of targets) {
      try {
        const candidate = await beatport.findTrack(target);
        const confidence = candidate
          ? confidenceForMatch(target, candidate)
          : { confidence: 0, reason: "no candidate" };
        const accepted = Boolean(candidate?.id && confidence.confidence >= 85);
        if (write && accepted) {
          store.saveBeatportEnrichment(target, candidate, { confidence: confidence.confidence });
          store.saveProviderEnrichment(target, "beatport", {
            ...candidate,
            providerTrackId: candidate.id,
            fetchedAt: new Date().toISOString()
          });
          store.saveEnrichmentAttempt(target, "beatport", {
            status: "found",
            confidence: confidence.confidence,
            fetchedAt: new Date().toISOString()
          });
        }
        rows.push({
          identityId: Number(target.id),
          artist: cleanText(target.artist),
          title: cleanText(target.title),
          accepted,
          persisted: Boolean(write && accepted),
          candidate: candidate ? compactCandidate(candidate, confidence) : null,
          reason: confidence.reason
        });
      } catch (error) {
        rows.push({
          identityId: Number(target.id),
          artist: cleanText(target.artist),
          title: cleanText(target.title),
          accepted: false,
          persisted: false,
          candidate: null,
          reason: error.message
        });
      }
    }
  } finally {
    store.close();
  }
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: `explicit-${type}-beatport-refresh`,
    options: { dbFile: path.resolve(dbFile), limit, offset, identityIds, feedbackType: type, includeAccepted, write },
    summary: {
      targets: rows.length,
      accepted: rows.filter((row) => row.accepted).length,
      persisted: rows.filter((row) => row.persisted).length,
      rejected: rows.filter((row) => !row.accepted).length
    },
    rows,
    beatportDiagnostics: beatport.status?.().diagnostics || null
  };
  fs.mkdirSync(path.dirname(path.resolve(report)), { recursive: true });
  fs.writeFileSync(path.resolve(report), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  logger.log(JSON.stringify({ ...output.summary, report: path.resolve(report), write }, null, 2));
  return output;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
  } else {
    let lock = null;
    try {
      if (args.write) lock = acquireProcessLock(path.join(__dirname, "..", "data", `beatport-${args.feedbackType}-refresh.lock`), `Explicit ${args.feedbackType} Beatport refresh`);
      refreshExplicitNegativeBeatport({ ...args, feedbackType: args.feedbackType })
        .catch((error) => {
          console.error(`explicit negative Beatport refresh failed: ${error.message}`);
          process.exitCode = 1;
        })
        .finally(() => lock?.release());
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  compactCandidate,
  readTargets,
  refreshExplicitNegativeBeatport,
  refreshExplicitFeedbackBeatport: refreshExplicitNegativeBeatport,
  FEEDBACK_RATINGS
};
