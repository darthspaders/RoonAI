"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { BeatportClient } = require("../src/beatportClient");
const { MusicBrainzLocalIndex } = require("../src/musicBrainzLocalIndex");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { DiscogsClient } = require("../src/discogsClient");
const { DiscogsOAuth } = require("../src/discogsOAuth");
const { acquireProcessLock } = require("../src/processLock");
const {
  DEFAULT_MIN_CONFIDENCE,
  LocalLibraryMetadataEnricher,
  LocalLibraryMetadataStore,
  enrichLocalLibrary
} = require("../src/localLibraryMetadataEnrichment");

function usage() {
  console.log(`Rabbit Hole local-library metadata enrichment

Read-only preview (default):
  npm run metadata:library -- --root Z:\\Music --limit 25

Persist metadata in Rabbit Hole's database (still never writes audio tags):
  npm run metadata:library -- --root Z:\\Music --limit 25 --write

Options:
  --root <path>                    Audio-library root (required, or LOCAL_LIBRARY_ROOT)
  --limit <n>                      Files to inspect; defaults to 25
  --offset <n>                     Skip this many files in the selected scan order
  --all                            Process the complete root (requires --write)
  --write                          Save database rows and checkpoints
  --dry-run                        Do not save database rows (default)
  --no-resume                      Reprocess files already saved with the same stat/provider set
  --shuffle                        Deterministically spread a limited sample across the library
  --providers <list>               embedded,memory,cache,beatport,musicbrainz,discogs
  --db <path>                      Rabbit Hole database path
  --report <path>                  JSON report path
  --review                          Build a review queue from saved DB metadata (no scan)
  --review-limit <n>               Limit review items; default is all
  --ffprobe <path>                 FFprobe executable path
  --min-confidence <n>             External-match threshold (default ${DEFAULT_MIN_CONFIDENCE})
  --help                           Show this help

The pass is intentionally database-only. File tag write-back is not implemented.`);
}

function parseArgs(argv) {
  const args = {
    rootPath: process.env.LOCAL_LIBRARY_ROOT || "",
    limit: 25,
    offset: 0,
    all: false,
    write: false,
    resume: true,
    shuffle: false,
    review: false,
    reviewLimit: 0,
    providers: ["embedded", "memory", "cache"],
    dbFile: config.musicMemory.dbFile,
    reportFile: path.join(__dirname, "..", "data", "local-library-metadata-report.json"),
    ffprobePath: process.env.LOCAL_LIBRARY_FFPROBE_PATH || "ffprobe",
    minConfidence: DEFAULT_MIN_CONFIDENCE
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--root") args.rootPath = path.resolve(argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++index]) || args.limit);
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--all") args.all = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--dry-run") args.write = false;
    else if (arg === "--no-resume") args.resume = false;
    else if (arg === "--shuffle") args.shuffle = true;
    else if (arg === "--review") args.review = true;
    else if (arg === "--review-limit") args.reviewLimit = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--providers") args.providers = String(argv[++index] || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--report") args.reportFile = path.resolve(argv[++index] || "");
    else if (arg === "--ffprobe") args.ffprobePath = argv[++index] || args.ffprobePath;
    else if (arg === "--min-confidence") args.minConfidence = Math.max(0, Math.min(100, Number(argv[++index]) || args.minConfidence));
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.review && !args.rootPath) throw new Error("A library root is required. Supply --root Z:\\Music or set LOCAL_LIBRARY_ROOT.");
  if (args.all && !args.write) throw new Error("--all is blocked in read-only mode. Add --write only after reviewing a limited report.");
  if (args.review && args.write) throw new Error("--review is read-only and cannot be combined with --write.");
  if (args.providers.includes("beatport") && !config.beatport.enabled) {
    console.warn("Beatport is disabled in configuration; Beatport candidates will be recorded as unavailable.");
  }
  if (args.providers.includes("discogs") && !config.discogs.enabled) {
    console.warn("Discogs is disabled in configuration; Discogs candidates will be recorded as unavailable.");
  }

  const lock = args.write
    ? acquireProcessLock(path.join(__dirname, "..", "data", "local-library-metadata.lock"), "Local-library metadata enrichment")
    : null;
  let musicMemory;
  let localStore;
  try {
    if (!args.review && args.providers.includes("memory")) {
      musicMemory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
    }
    if (args.write || args.review) {
      localStore = new LocalLibraryMetadataStore({
        musicMemory,
        dbFile: args.dbFile,
        logger: console
      });
    }
    if (args.review) {
      const review = localStore.reviewQueue({ limit: args.reviewLimit });
      fs.mkdirSync(path.dirname(path.resolve(args.reportFile)), { recursive: true });
      fs.writeFileSync(path.resolve(args.reportFile), `${JSON.stringify(review, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ ...review, reportFile: path.resolve(args.reportFile) }, null, 2));
      return;
    }
    const beatport = args.providers.includes("beatport")
      ? new BeatportClient({ ...config.beatport, logger: console })
      : null;
    const musicBrainzIndex = args.providers.includes("musicbrainz")
      ? new MusicBrainzLocalIndex({ ...config.musicBrainzLocal, logger: console })
      : null;
    const discogsOAuth = args.providers.includes("discogs")
      ? new DiscogsOAuth({
        ...config.discogs,
        tokenFile: config.discogs.oauthTokenFile,
        logger: console
      })
      : null;
    const discogs = args.providers.includes("discogs")
      ? new DiscogsClient({ ...config.discogs, oauth: discogsOAuth, logger: console })
      : null;
    const enricher = new LocalLibraryMetadataEnricher({
      musicMemory,
      store: localStore,
      beatport,
      musicBrainzIndex,
      discogs,
      cacheFile: config.metadataEnrichment.cacheFile,
      ffprobePath: args.ffprobePath,
      ffprobeTimeoutMs: config.metadataEnrichment.timeoutMs,
      minConfidence: args.minConfidence,
      logger: console
    });
    const summary = await enrichLocalLibrary({
      rootPath: args.rootPath,
      enricher,
      store: localStore,
      providers: args.providers,
      limit: args.limit,
      offset: args.offset,
      all: args.all,
      resume: args.resume,
      shuffle: args.shuffle,
      dryRun: !args.write,
      reportFile: args.reportFile,
      logger: console
    });
    console.log(JSON.stringify({
      ...summary,
      database: args.write ? localStore.status() : "unchanged (read-only preview)"
    }, null, 2));
  } finally {
    localStore?.close();
    musicMemory?.close();
    lock?.release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    usage();
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, usage };
