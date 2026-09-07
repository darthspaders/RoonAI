"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  INDEX_VERSION,
  bucketForIsrc,
  bucketForTitle,
  cleanIsrc,
  cleanText,
  compactRecording,
  recordingsFromRelease
} = require("../src/musicBrainzLocalIndex");

function usage() {
  console.log([
    "Usage:",
    "  node scripts/import-musicbrainz-json.js <extracted-json-dump-dir> [--index-dir data/musicbrainz-index] [--limit N]",
    "",
    "Expected files are MusicBrainz JSON dump line files such as mbdump/recording and mbdump/release.",
    "The generated index is local runtime data and should stay under ignored data/."
  ].join("\n"));
}

function parseArgs(argv) {
  const args = { dumpDir: "", indexDir: path.join(__dirname, "..", "data", "musicbrainz-index"), limit: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value === "--index-dir") {
      args.indexDir = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (value === "--limit") {
      args.limit = Number(argv[index + 1] || 0) || 0;
      index += 1;
    } else if (!args.dumpDir) {
      args.dumpDir = path.resolve(value);
    }
  }
  if (!args.dumpDir && process.env.MUSICBRAINZ_JSON_DUMP_DIR) {
    args.dumpDir = path.resolve(process.env.MUSICBRAINZ_JSON_DUMP_DIR);
  }
  if (process.env.MUSICBRAINZ_INDEX_DIR && args.indexDir === path.join(__dirname, "..", "data", "musicbrainz-index")) {
    args.indexDir = path.resolve(process.env.MUSICBRAINZ_INDEX_DIR);
  }
  return args;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(fullPath));
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

function entityName(file) {
  const base = path.basename(file).replace(/\.(?:jsonl|ndjson|json)$/i, "");
  if (base === "recording" || base === "recordings") return "recording";
  if (base === "release" || base === "releases") return "release";
  return "";
}

function findEntityFiles(dumpDir) {
  const files = walk(dumpDir);
  return {
    recording: files.filter((file) => entityName(file) === "recording"),
    release: files.filter((file) => entityName(file) === "release")
  };
}

function ensureCleanIndexDir(indexDir) {
  fs.rmSync(indexDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(indexDir, "buckets"), { recursive: true });
  fs.mkdirSync(path.join(indexDir, "isrc"), { recursive: true });
}

class IndexWriter {
  constructor(indexDir) {
    this.indexDir = indexDir;
    this.bucketStreams = new Map();
    this.isrcStreams = new Map();
    this.entryCount = 0;
  }

  streamFor(map, dirName, bucket) {
    if (map.has(bucket)) {
      const stream = map.get(bucket);
      map.delete(bucket);
      map.set(bucket, stream);
      return stream;
    }
    while (map.size >= 64) {
      const [oldestBucket, oldestStream] = map.entries().next().value;
      map.delete(oldestBucket);
      oldestStream.end();
    }
    const file = path.join(this.indexDir, dirName, `${bucket}.jsonl`);
    const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    map.set(bucket, stream);
    return stream;
  }

  bucketStream(bucket) {
    return this.streamFor(this.bucketStreams, "buckets", bucket);
  }

  isrcStream(bucket) {
    return this.streamFor(this.isrcStreams, "isrc", bucket);
  }

  add(recording) {
    const bucket = bucketForTitle(recording.title);
    this.bucketStream(bucket).write(JSON.stringify(recording) + "\n");
    this.entryCount += 1;

    for (const isrc of Array.isArray(recording.isrcs) ? recording.isrcs : []) {
      const clean = cleanIsrc(isrc);
      if (!clean) continue;
      const isrcBucket = bucketForIsrc(clean);
      this.isrcStream(isrcBucket).write(JSON.stringify({
        isrc: clean,
        id: cleanText(recording.id),
        title: cleanText(recording.title),
        bucket
      }) + "\n");
    }
  }

  async close() {
    await Promise.all([...this.bucketStreams.values(), ...this.isrcStreams.values()].map((stream) => new Promise((resolve, reject) => {
      stream.end(resolve);
      stream.on("error", reject);
    })));
  }
}

async function processJsonLines(file, onEntry, { logger = console } = {}) {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let skipped = 0;
  for await (const line of rl) {
    lineNumber += 1;
    const text = line.trim();
    if (!text) continue;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch (error) {
      skipped += 1;
      if (skipped <= 10) {
        logger.warn(`${file}:${lineNumber} skipped malformed JSON row: ${error.message}`);
      }
      continue;
    }
    const keepGoing = await onEntry(entry);
    if (keepGoing === false) break;
  }
  return { skipped };
}

async function importMusicBrainzJson({ dumpDir, indexDir, limit = 0, logger = console } = {}) {
  if (!dumpDir || !fs.existsSync(dumpDir)) throw new Error("MusicBrainz JSON dump directory not found.");
  const files = findEntityFiles(dumpDir);
  if (!files.recording.length && !files.release.length) {
    throw new Error("No recording or release JSON dump files were found.");
  }

  ensureCleanIndexDir(indexDir);
  const writer = new IndexWriter(indexDir);
  let sourceRows = 0;
  let skippedRows = 0;

  const addRecording = (recording) => {
    if (limit && writer.entryCount >= limit) return false;
    if (!recording) return true;
    writer.add(recording);
    return true;
  };

  for (const file of files.recording) {
    logger.info(`Importing MusicBrainz recordings from ${file}`);
    const summary = await processJsonLines(file, (entry) => {
      sourceRows += 1;
      return addRecording(compactRecording(entry));
    }, { logger });
    skippedRows += summary.skipped;
    if (limit && writer.entryCount >= limit) break;
  }

  if (!limit || writer.entryCount < limit) {
    for (const file of files.release) {
      logger.info(`Importing MusicBrainz release tracks from ${file}`);
      const summary = await processJsonLines(file, (entry) => {
        sourceRows += 1;
        for (const recording of recordingsFromRelease(entry)) {
          if (!addRecording(recording)) break;
        }
        return !limit || writer.entryCount < limit;
      }, { logger });
      skippedRows += summary.skipped;
      if (limit && writer.entryCount >= limit) break;
    }
  }

  await writer.close();
  const manifest = {
    version: INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    dumpDir,
    sourceRows,
    skippedRows,
    entryCount: writer.entryCount
  };
  fs.writeFileSync(path.join(indexDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  importMusicBrainzJson(args)
    .then((manifest) => {
      console.log(`MusicBrainz local index built: ${manifest.entryCount} entries from ${manifest.sourceRows} source rows`);
      console.log(`Index: ${args.indexDir}`);
    })
    .catch((error) => {
      console.error(error.message);
      usage();
      process.exit(1);
    });
}

module.exports = {
  importMusicBrainzJson,
  parseArgs
};
