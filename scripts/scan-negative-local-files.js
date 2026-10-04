"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { DatabaseSync } = require("node:sqlite");
const { probeLocalAudio, trackFromFfprobe, walkAudioFiles } = require("../src/localLibraryMetadataEnrichment");
const { feedbackIdentityMatchesLocalFile } = require("./enrich-rated-local");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    root: config.localLibrary.root || "Z:\\Music",
    dbFile: config.musicMemory.dbFile,
    concurrency: 6,
    limit: 0,
    report: path.join(__dirname, "..", "data", "negative-local-file-scan.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = path.resolve(argv[++index] || "");
    else if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Math.min(12, Number(argv[++index]) || 6));
    else if (arg === "--limit") args.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Scan local embedded tags for explicit skip/never tracks.

Usage:
  npm run metadata:scan-negative -- --root Z:\\Music

The scan is read-only and does not hash files, write metadata, call network
providers, or analyze audio. Only identities with accepted Beatport evidence
are eligible for a sonic follow-up.
`);
}

function readTargets(db) {
  return db.prepare(`
    SELECT ti.id, ti.artist, ti.title, ti.mix_version AS mixVersion,
      ti.album, ti.tidal_id AS tidalId, ti.isrc,
      be.beatport_track_id AS beatportId, be.confidence AS beatportConfidence,
      be.genre, be.subgenre, be.label
    FROM track_identity ti
    JOIN taste_feedback tf ON tf.track_identity_id = ti.id
    JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    WHERE LOWER(REPLACE(tf.rating, ' ', '_')) IN ('dislike', 'skip', 'never', 'never_again', 'down')
      AND COALESCE(be.beatport_track_id, '') <> ''
      AND COALESCE(be.confidence, 0) >= 85
    GROUP BY ti.id
    ORDER BY ti.id
  `).all();
}

async function collectAudioFiles(root, limit = 0) {
  const files = [];
  for await (const filePath of walkAudioFiles(root)) {
    files.push(filePath);
    if (limit > 0 && files.length >= limit) break;
  }
  return files;
}

async function scanNegativeLocalFiles({
  root = config.localLibrary.root || "Z:\\Music",
  dbFile = config.musicMemory.dbFile,
  concurrency = 6,
  limit = 0,
  report = path.join(__dirname, "..", "data", "negative-local-file-scan.json"),
  logger = console,
  probe = probeLocalAudio
} = {}) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const targets = readTargets(db);
  db.close();
  const files = await collectAudioFiles(root, limit);
  const matches = [];
  const failures = [];
  let nextIndex = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const current = nextIndex++;
      if (current >= files.length) return;
      const filePath = files[current];
      try {
        const probeJson = await probe(filePath, {
          ffprobePath: config.localLibrary.ffprobePath || "ffprobe",
          timeoutMs: config.metadataEnrichment.timeoutMs
        });
        const metadata = trackFromFfprobe(filePath, probeJson);
        for (const target of targets) {
          if (feedbackIdentityMatchesLocalFile(target, metadata)) {
            matches.push({
              filePath,
              artist: metadata.artist,
              title: metadata.title,
              durationMs: metadata.durationMs,
              target: {
                identityId: Number(target.id),
                artist: target.artist,
                title: target.title,
                mixVersion: target.mixVersion,
                beatportId: target.beatportId,
                beatportConfidence: Number(target.beatportConfidence || 0),
                genre: target.genre,
                subgenre: target.subgenre,
                label: target.label
              }
            });
          }
        }
      } catch (error) {
        if (failures.length < 50) failures.push({ filePath, error: error.message });
      } finally {
        processed += 1;
        if (processed % 500 === 0) logger.log(`Negative local-file scan progress: ${processed}/${files.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, () => worker()));
  matches.sort((left, right) => left.filePath.localeCompare(right.filePath));
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: "explicit-skip-never-local-file-scan",
    options: { root: path.resolve(root), dbFile: path.resolve(dbFile), concurrency, limit },
    summary: {
      targetCount: targets.length,
      filesScanned: files.length,
      filesProcessed: processed,
      matches: matches.length,
      matchedTargets: new Set(matches.map((match) => match.target.identityId)).size,
      failures: failures.length
    },
    targets: targets.map((target) => ({
      identityId: Number(target.id),
      artist: target.artist,
      title: target.title,
      beatportId: target.beatportId,
      beatportConfidence: Number(target.beatportConfidence || 0)
    })),
    matches,
    failures
  };
  fs.mkdirSync(path.dirname(path.resolve(report)), { recursive: true });
  fs.writeFileSync(path.resolve(report), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  logger.log(JSON.stringify({ ...output.summary, report: path.resolve(report) }, null, 2));
  return output;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();
  else scanNegativeLocalFiles(args).catch((error) => {
    console.error(`negative local-file scan failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectAudioFiles,
  readTargets,
  scanNegativeLocalFiles
};
