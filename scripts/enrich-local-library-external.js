"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("../src/config");
const { BeatportClient } = require("../src/beatportClient");
const { MusicBrainzLocalIndex } = require("../src/musicBrainzLocalIndex");
const { DiscogsClient } = require("../src/discogsClient");
const { DiscogsOAuth } = require("../src/discogsOAuth");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { acquireProcessLock } = require("../src/processLock");
const {
  LocalLibraryMetadataEnricher,
  LocalLibraryMetadataStore
} = require("../src/localLibraryMetadataEnrichment");

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const ELECTRONIC_HINTS = /\b(?:electronic|edm|house|techno|trance|dubstep|drum\s*(?:and|&)\s*bass|dnb|bass music|breaks|garage|dance|progressive|psy(?:trance|chedelic)|future bass|trap|downtempo|ambient|idm|electro|hardstyle|hardcore|jungle|electronica|disco|nu disco|minimal)\b/i;
const STRONG_NON_ELECTRONIC = /\b(?:rock|metal|pop|hip\s*hop|rap|classical|jazz|country|blues|folk|soul|r&b|reggae|soundtrack|spoken word|opera|christmas)\b/i;

function isLikelyElectronicRow(row = {}) {
  const text = [row.genre, row.subgenre, row.label, row.album, row.file_path].map(cleanText).join(" ");
  if (STRONG_NON_ELECTRONIC.test(text)) return false;
  if (ELECTRONIC_HINTS.test(text)) return true;
  return false;
}

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    providers: ["beatport", "musicbrainz", "discogs"],
    limit: 100,
    offset: 0,
    all: false,
    includeComplete: false,
    electronicOnly: false,
    write: false,
    minConfidence: config.localLibrary.minConfidence,
    report: path.join(__dirname, "..", "data", "local-library-external-enrichment.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--providers") args.providers = String(argv[++index] || "").split(",").map((item) => cleanText(item).toLowerCase()).filter(Boolean);
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++index]) || args.limit);
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--all") args.all = true;
    else if (arg === "--include-complete") args.includeComplete = true;
    else if (arg === "--electronic-only") args.electronicOnly = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--min-confidence") args.minConfidence = Math.max(0, Math.min(100, Number(argv[++index]) || args.minConfidence));
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  args.providers = Array.from(new Set(args.providers.filter((item) => ["beatport", "musicbrainz", "discogs"].includes(item))));
  return args;
}

function printHelp() {
  console.log(`Database-only external metadata enrichment for the existing local-library scan.

This command does not walk, hash, probe, decode, or modify audio files. It reuses
the 7,222 stored local-library rows, calls only the selected external providers,
and saves field-level evidence plus resumable checkpoints when --write is used.

Usage:
  npm run metadata:external -- --limit 100 --write
  npm run metadata:external -- --all --write

Options:
  --db PATH                  SQLite database path
  --providers LIST           beatport,musicbrainz,discogs (default: all three)
  --limit N                  rows to process (default: 100)
  --offset N                 skip rows in stable id order
  --all                      process all incomplete rows
  --include-complete         also revisit complete rows missing provider ids
  --electronic-only          restrict provider calls to likely electronic rows
  --write                    persist metadata/evidence/checkpoints
  --min-confidence N         automatic-match threshold
  --report PATH              JSON report path

Complete rows are skipped by default. Existing provider ids are not looked up
again, which keeps this pass focused on missing coverage and makes it restart-safe.
No audio tags are written.`);
}

function providerConfig(args) {
  const result = {};
  if (args.providers.includes("beatport")) result.beatport = new BeatportClient({ ...config.beatport, logger: console });
  if (args.providers.includes("musicbrainz")) result.musicBrainzIndex = new MusicBrainzLocalIndex({ ...config.musicBrainzLocal, logger: console });
  if (args.providers.includes("discogs")) {
    const oauth = new DiscogsOAuth({ ...config.discogs, tokenFile: config.discogs.oauthTokenFile, logger: console });
    result.discogs = new DiscogsClient({ ...config.discogs, oauth, logger: console });
  }
  return result;
}

function loadRows(db, args) {
  const completeness = args.includeComplete ? "" : "AND completeness_class <> 'complete'";
  const rows = db.prepare(`
    SELECT *
    FROM local_library_file
    WHERE status = 'processed'
      ${completeness}
    ORDER BY id ASC
  `).all();
  const selectedRows = args.electronicOnly ? rows.filter(isLikelyElectronicRow) : rows;
  return selectedRows.slice(args.offset, args.all ? undefined : args.offset + args.limit);
}

function providersForRow(row, providers, { electronicOnly = false } = {}) {
  return providers.filter((provider) => {
    if (provider === "beatport" && electronicOnly && !isLikelyElectronicRow(row)) return false;
    if (provider === "beatport" && cleanText(row.beatport_id)) return false;
    if (provider === "musicbrainz" && cleanText(row.musicbrainz_id)) return false;
    if (provider === "discogs" && cleanText(row.discogs_id)) return false;
    return Boolean(cleanText(row.artist) && cleanText(row.title));
  });
}

function unionProviderSet(existing, next) {
  return Array.from(new Set(`${existing || ""},${next.join(",")}`.split(",").map(cleanText).filter(Boolean))).sort().join(",");
}

function jobIdFor(args) {
  const key = `${args.dbFile}|${args.providers.join(",")}|${args.includeComplete ? "complete" : "incomplete"}|${args.electronicOnly ? "electronic" : "all"}`;
  return `local-library-external:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function countMatches(matches, target) {
  return matches.filter((match) => match.provider === target);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.write) throw new Error("This command is preview-only unless --write is supplied.");
  if (!args.providers.length) throw new Error("Select at least one provider.");

  const lock = acquireProcessLock(path.join(__dirname, "..", "data", "local-library-external.lock"), "Database-only external metadata enrichment");
  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  const store = new LocalLibraryMetadataStore({ musicMemory: memory, logger: console });
  try {
    const rows = loadRows(memory.db, args);
    const clients = providerConfig(args);
    const enricher = new LocalLibraryMetadataEnricher({
      musicMemory: memory,
      store,
      ...clients,
      cacheFile: config.metadataEnrichment.cacheFile,
      minConfidence: args.minConfidence,
      logger: console
    });
    let musicBrainzBatch = [];
    if (args.providers.includes("musicbrainz") && clients.musicBrainzIndex?.searchRecordingsBatch) {
      console.log(`[metadata-external] indexing MusicBrainz title buckets once for ${rows.length} rows`);
      musicBrainzBatch = clients.musicBrainzIndex.searchRecordingsBatch(rows.map((row) => ({
        artist: row.artist,
        title: row.title,
        isrc: row.isrc
      })));
      console.log(`[metadata-external] MusicBrainz batch lookup ready`);
    }
    const jobId = jobIdFor(args);
    const startedAt = new Date().toISOString();
    const summary = {
      schemaVersion: 1,
      jobId,
      dbFile: args.dbFile,
      providers: args.providers,
      includeComplete: args.includeComplete,
      electronicOnly: args.electronicOnly,
      offset: args.offset,
      limit: args.all ? "all" : args.limit,
      selected: rows.length,
      processed: 0,
      skipped: 0,
      failed: 0,
      providerCalls: Object.fromEntries(args.providers.map((provider) => [provider, 0])),
      acceptedMatches: Object.fromEntries(args.providers.map((provider) => [provider, 0])),
      ambiguousMatches: Object.fromEntries(args.providers.map((provider) => [provider, 0])),
      failures: [],
      samples: [],
      startedAt
    };
    const checkpoint = (status = "running", completedAt = null) => store.saveJob({
      jobId,
      rootPath: `database:${args.dbFile}`,
      options: {
        mode: "database-only",
        providers: args.providers,
        includeComplete: args.includeComplete,
        electronicOnly: args.electronicOnly,
        offset: args.offset,
        limit: args.limit,
        all: args.all
      },
      status,
      filesSeen: summary.processed + summary.skipped + summary.failed,
      filesProcessed: summary.processed,
      filesSkipped: summary.skipped,
      filesFailed: summary.failed,
      lastFilePath: summary.lastFilePath,
      lastFileHash: summary.lastFileHash,
      startedAt,
      completedAt
    });
    checkpoint();

    for (const [rowIndex, row] of rows.entries()) {
      const rowProviders = providersForRow(row, args.providers, { electronicOnly: args.electronicOnly });
      if (!rowProviders.length) {
        summary.skipped += 1;
        continue;
      }
      try {
        rowProviders.forEach((provider) => { summary.providerCalls[provider] += 1; });
        const result = await enricher.enrichStoredRow(row, {
          providers: rowProviders,
          musicBrainzRecordings: musicBrainzBatch[rowIndex] || null
        });
        store.saveResult(result, { providerSet: unionProviderSet(row.provider_set, rowProviders) });
        summary.processed += 1;
        for (const provider of rowProviders) {
          const matches = countMatches(result.matches, provider);
          summary.acceptedMatches[provider] += matches.filter((match) => match.accepted).length;
          summary.ambiguousMatches[provider] += matches.filter((match) => !match.accepted).length;
        }
        if (summary.samples.length < 20) {
          summary.samples.push({
            id: row.id,
            filePath: row.file_path,
            artist: result.metadata.artist || null,
            title: result.metadata.title || null,
            genre: result.metadata.genre || null,
            label: result.metadata.label || null,
            beatportId: result.metadata.beatportId || null,
            musicBrainzId: result.metadata.musicBrainzId || null,
            discogsId: result.metadata.discogsId || null,
            completeness: result.completeness,
            matches: result.matches.map((match) => ({
              provider: match.provider,
              confidence: match.confidence,
              matchType: match.matchType,
              accepted: match.accepted,
              reason: match.reason
            }))
          });
        }
        if (summary.processed % 25 === 0) console.log(`[metadata-external] processed ${summary.processed}/${rows.length}`);
      } catch (error) {
        summary.failed += 1;
        if (summary.failures.length < 50) summary.failures.push({ id: row.id, filePath: row.file_path, error: error.message });
        console.warn(`[metadata-external] failed ${row.file_path}: ${error.message}`);
      }
      summary.lastFilePath = row.file_path;
      summary.lastFileHash = row.file_hash;
      checkpoint();
    }

    summary.completedAt = new Date().toISOString();
    summary.status = summary.failed ? "completed_with_errors" : "complete";
    checkpoint(summary.status, summary.completedAt);
    fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
    fs.writeFileSync(path.resolve(args.report), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      status: summary.status,
      selected: summary.selected,
      processed: summary.processed,
      skipped: summary.skipped,
      failed: summary.failed,
      providerCalls: summary.providerCalls,
      acceptedMatches: summary.acceptedMatches,
      ambiguousMatches: summary.ambiguousMatches,
      report: path.resolve(args.report)
    }, null, 2));
    if (summary.failed) process.exitCode = 1;
  } finally {
    store.close();
    memory.close();
    lock.release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    printHelp();
    process.exitCode = 1;
  });
}

module.exports = {
  cleanText,
  jobIdFor,
  isLikelyElectronicRow,
  loadRows,
  main,
  parseArgs,
  printHelp,
  providersForRow,
  unionProviderSet
};
