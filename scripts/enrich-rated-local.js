"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { acquireProcessLock } = require("../src/processLock");
const {
  LocalLibraryMetadataEnricher,
  LocalLibraryMetadataStore,
  normalizeText
} = require("../src/localLibraryMetadataEnrichment");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    manifest: path.join(__dirname, "..", "data", "sonic-rated-manifest.json"),
    dbFile: config.musicMemory.dbFile,
    positive: 12,
    neutral: 5,
    negative: 7,
    providers: ["embedded", "memory", "cache"],
    write: false,
    report: path.join(__dirname, "..", "data", "sonic-rated-local-enrichment.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = path.resolve(argv[++index] || "");
    else if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--positive") args.positive = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--neutral") args.neutral = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--negative") args.negative = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--providers") args.providers = String(argv[++index] || "").split(",").map(cleanText).filter(Boolean);
    else if (arg === "--write") args.write = true;
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Enrich a balanced, feedback-labeled local sample without writing audio tags.

Usage:
  npm run metadata:enrich-rated -- --write

Defaults select 12 positive, 5 neutral, and 7 negative manifest tracks. The
selection is spread across Beatport genres, then processed through embedded
tags plus cached Rabbit Hole evidence. No network provider is used by default.
`);
}

function loadManifest(filePath) {
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(manifest.tracks)) throw new Error("Rated manifest has no tracks array.");
  return manifest;
}

function feedbackIdentityMatchesLocalFile(selected, metadata = {}) {
  const expectedTitle = normalizeText(selected.title);
  const actualTitle = normalizeText(metadata.title);
  const expectedArtist = normalizeText(selected.artist);
  const actualArtist = normalizeText(metadata.artist);
  if (!expectedTitle || !actualTitle || !expectedArtist || !actualArtist) return false;

  const titleMatches = expectedTitle === actualTitle
    || (expectedTitle.length >= 8 && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle)));
  const splitArtists = (value) => String(value || "")
    .split(/\s+(?:and|feat|featuring|with|vs|versus)\s+|[,/&+|]+/i)
    .map((part) => normalizeText(part).replace(/^the\s+/, "").replace(/\s+the$/, ""))
    .filter((part) => part && part !== "the")
    .sort();
  const expectedArtists = splitArtists(selected.artist);
  const actualArtists = splitArtists(metadata.artist);
  const sharedArtists = expectedArtists.filter((artist) => actualArtists.includes(artist));
  const artistMatches = expectedArtist === actualArtist
    || (sharedArtists.length > 0
      && sharedArtists.length === Math.min(expectedArtists.length, actualArtists.length));
  return titleMatches && artistMatches;
}

function beatportContext(db, manifestRow) {
  return db.prepare(`
    SELECT beatport_track_id, genre, subgenre, label, bpm, key_name
    FROM beatport_enrichment
    WHERE track_identity_id = ?
    LIMIT 1
  `).get(Number(manifestRow.id)) || {};
}

function balancedSelection(rows, limit, db) {
  const groups = new Map();
  for (const row of rows) {
    const beatport = beatportContext(db, row);
    if (!beatport.beatport_track_id) continue;
    const genre = cleanText(beatport.genre || beatport.subgenre || "Unknown");
    const group = groups.get(genre) || [];
    group.push({ ...row, beatport });
    groups.set(genre, group);
  }
  const groupList = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group.sort((left, right) => String(left.id).localeCompare(String(right.id))));
  const selected = [];
  while (selected.length < limit && groupList.some((group) => group.length)) {
    for (const group of groupList) {
      if (selected.length >= limit) break;
      const row = group.shift();
      if (row) selected.push(row);
    }
  }
  return selected;
}

function selectTracks(manifest, db, args) {
  const byLabel = new Map();
  for (const row of manifest.tracks) {
    const label = cleanText(row.label).toLowerCase();
    const group = byLabel.get(label) || [];
    group.push(row);
    byLabel.set(label, group);
  }
  const selected = [];
  for (const [label, limit] of [["positive", args.positive], ["neutral", args.neutral], ["negative", args.negative]]) {
    selected.push(...balancedSelection(byLabel.get(label) || [], limit, db)
      .map((row) => ({ ...row, selectionLabel: label })));
  }
  const seen = new Set();
  return selected.filter((row) => {
    if (seen.has(row.file)) return false;
    seen.add(row.file);
    return true;
  });
}

function summarizeResult(result, selected) {
  return {
    manifestId: String(selected.id),
    selectionLabel: selected.selectionLabel,
    feedbackCount: Number(selected.feedbackCount || 0),
    feedbackEvents: selected.feedbackEvents || [],
    filePath: result.filePath,
    fileHash: result.fileHash,
    artist: result.metadata?.artist || selected.artist,
    title: result.metadata?.title || selected.title,
    genre: result.metadata?.genre || selected.beatport?.genre || null,
    beatportId: result.metadata?.beatportId || selected.beatport?.beatport_track_id || null,
    completeness: result.completeness,
    providerSet: result.providerSet,
    acceptedMatchCount: (result.matches || []).filter((match) => match.accepted).length
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const manifestPath = path.resolve(args.manifest);
  if (!fs.existsSync(manifestPath)) throw new Error(`Rated manifest not found: ${manifestPath}`);

  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  if (!memory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  const localStore = new LocalLibraryMetadataStore({ musicMemory: memory, logger: console });
  const lock = args.write
    ? acquireProcessLock(path.join(__dirname, "..", "data", "local-library-metadata.lock"), "Rated local metadata enrichment")
    : null;
  try {
    const manifest = loadManifest(manifestPath);
    const selected = selectTracks(manifest, memory.db, args);
    const output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scope: "feedback-labeled-local-library-sample",
      options: {
        manifest: manifestPath,
        dbFile: args.dbFile,
        providers: args.providers,
        write: args.write,
        positive: args.positive,
        neutral: args.neutral,
        negative: args.negative
      },
      selection: { requested: args.positive + args.neutral + args.negative, selected: selected.length, byLabel: {} },
      results: [],
      rejections: [],
      failures: []
    };
    const enricher = new LocalLibraryMetadataEnricher({
      musicMemory: memory,
      store: localStore,
      cacheFile: config.metadataEnrichment.cacheFile,
      ffprobePath: process.env.LOCAL_LIBRARY_FFPROBE_PATH || "ffprobe",
      ffprobeTimeoutMs: config.metadataEnrichment.timeoutMs,
      minConfidence: config.metadataEnrichment.minConfidence,
      logger: console
    });
    for (const selectedRow of selected) {
      output.selection.byLabel[selectedRow.selectionLabel] = (output.selection.byLabel[selectedRow.selectionLabel] || 0) + 1;
      try {
        const filePath = path.resolve(selectedRow.file);
        const stat = await fs.promises.stat(filePath);
        const result = await enricher.enrichFile(filePath, { stat, providers: args.providers });
        if (!feedbackIdentityMatchesLocalFile(selectedRow, result.metadata)) {
          output.rejections.push({
            manifestId: String(selectedRow.id),
            selectionLabel: selectedRow.selectionLabel,
            filePath: selectedRow.file,
            reason: "embedded local artist/title does not match feedback identity",
            expected: { artist: selectedRow.artist, title: selectedRow.title },
            actual: { artist: result.metadata?.artist || null, title: result.metadata?.title || null }
          });
          continue;
        }
        if (args.write) localStore.saveResult(result, { providerSet: args.providers.join(",") });
        output.results.push(summarizeResult(result, selectedRow));
      } catch (error) {
        output.failures.push({ manifestId: String(selectedRow.id), selectionLabel: selectedRow.selectionLabel, filePath: selectedRow.file, error: error.message });
      }
    }
    output.summary = {
      selected: selected.length,
      processed: output.results.length,
      rejected: output.rejections.length,
      failed: output.failures.length,
      written: Boolean(args.write),
      providerSet: args.providers.join(",")
    };
    if (args.write) output.database = localStore.status();
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ summary: output.summary, selection: output.selection, report: args.report, database: output.database || "unchanged (dry run)" }, null, 2));
    if (output.failures.length) process.exitCode = 1;
  } finally {
    lock?.release();
    localStore.close();
    memory.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`rated local enrichment failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  feedbackIdentityMatchesLocalFile
};
