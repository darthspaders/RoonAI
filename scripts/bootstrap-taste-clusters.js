"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const config = require("../src/config");
const {
  TasteClusterStore,
  bootstrapTasteClusters
} = require("../src/tasteClusterBootstrap");

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    limit: 0,
    offset: 0,
    minSupport: 2,
    maxClusters: 32,
    maxFacetsPerTrack: 3,
    membershipThreshold: 0.35,
    write: false,
    report: path.join(__dirname, "..", "data", "taste-clusters-bootstrap.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--min-support") args.minSupport = Math.max(1, Number(argv[++index]) || 2);
    else if (arg === "--max-clusters") args.maxClusters = Math.max(1, Number(argv[++index]) || 32);
    else if (arg === "--max-facets-per-track") args.maxFacetsPerTrack = Math.max(1, Number(argv[++index]) || 3);
    else if (arg === "--membership-threshold") args.membershipThreshold = Number(argv[++index]) || 0.35;
    else if (arg === "--write") args.write = true;
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: npm run taste:clusters -- [options]

Builds provisional overlapping metadata facets from local_library_file.
No write occurs unless --write is provided. This does not analyze audio or
change production discovery.

Options:
  --db PATH                    SQLite database path
  --limit N                    maximum processed local rows (0 = all)
  --offset N                   skip processed local rows first
  --min-support N              minimum tracks needed for a facet (default 2)
  --max-clusters N             maximum facets to retain (default 32)
  --max-facets-per-track N     maximum overlapping memberships (default 3)
  --membership-threshold N     relative membership cutoff (default 0.35)
  --write                      persist provisional cluster rows in SQLite
  --report PATH                JSON report path
`);
}

function readRows(db, { limit, offset }) {
  const rows = db.prepare(`
    SELECT id, artist, title, album, genre, subgenre, label, bpm, year,
      completeness_score, completeness_class
    FROM local_library_file
    WHERE status = 'processed'
    ORDER BY id ASC
  `).all();
  const sliced = rows.slice(offset, limit ? offset + limit : undefined);
  return sliced;
}

function reportForOutput(result, args, persisted = null) {
  return {
    ...result,
    options: {
      limit: args.limit,
      offset: args.offset,
      minSupport: args.minSupport,
      maxClusters: args.maxClusters,
      maxFacetsPerTrack: args.maxFacetsPerTrack,
      membershipThreshold: args.membershipThreshold,
      persisted: Boolean(persisted)
    },
    persistence: persisted
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const musicMemory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  if (!musicMemory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  try {
    const rows = readRows(musicMemory.db, args);
    const result = bootstrapTasteClusters(rows, {
      minSupport: args.minSupport,
      maxClusters: args.maxClusters,
      maxFacetsPerTrack: args.maxFacetsPerTrack,
      membershipThreshold: args.membershipThreshold
    });
    let persisted = null;
    if (args.write) {
      const clusterStore = new TasteClusterStore({ db: musicMemory.db, logger: console });
      persisted = clusterStore.replaceMetadataBootstrap(result);
    }
    const output = reportForOutput(result, args, persisted);
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      summary: output.summary,
      report: args.report,
      persisted: output.persistence
    }, null, 2));
  } finally {
    musicMemory.close();
  }
}

main();
