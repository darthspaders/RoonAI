"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const config = require("../src/config");
const {
  DEFAULT_PROFILE_MODEL,
  DEFAULT_PROFILE_MODEL_VERSION,
  TasteClusterStore,
  buildTasteClusterProfiles,
  linkLocalLibraryToTrackIdentities
} = require("../src/tasteClusterBootstrap");

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    limit: 0,
    offset: 0,
    model: DEFAULT_PROFILE_MODEL,
    modelVersion: DEFAULT_PROFILE_MODEL_VERSION,
    minEmbeddings: 2,
    includeExternalNegativeSeeds: false,
    includeExternalFeedbackSeeds: false,
    write: false,
    report: path.join(__dirname, "..", "data", "taste-cluster-profiles.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--model") args.model = String(argv[++index] || DEFAULT_PROFILE_MODEL).trim();
    else if (arg === "--model-version") args.modelVersion = String(argv[++index] || DEFAULT_PROFILE_MODEL_VERSION).trim();
    else if (arg === "--min-embeddings") args.minEmbeddings = Math.max(1, Number(argv[++index]) || 2);
    else if (arg === "--include-external-negative") args.includeExternalNegativeSeeds = true;
    else if (arg === "--include-external-feedback") args.includeExternalFeedbackSeeds = true;
    else if (arg === "--write") args.write = true;
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: npm run taste:profiles -- [options]

Links the selected local-library rows to stable Rabbit Hole identities, then
builds versioned positive/negative cluster-profile diagnostics from existing
feedback and already-stored sonic embeddings. No write occurs unless --write
is provided. This does not analyze audio or change production discovery.

Options:
  --db PATH              SQLite database path
  --limit N              maximum local rows (0 = all)
  --offset N             skip local rows first
  --model NAME           sonic provider/model (default discogs-effnet)
  --model-version NAME   provider model version (default 1)
  --min-embeddings N     minimum vectors needed for a ready centroid (default 2)
  --include-external-negative
                          include accepted Beatport-preview skip/never seeds
  --include-external-feedback
                          include accepted Beatport-preview positive/negative seeds
  --write                persist identity links and cluster profiles
  --report PATH          JSON report path
`);
}

function readRows(db, { limit, offset }) {
  const rows = db.prepare(`
    SELECT id, artist, title, album, genre, subgenre, label, bpm, year,
      completeness_score, completeness_class, isrc, tidal_id, beatport_id,
      musicbrainz_id, discogs_id
    FROM local_library_file
    WHERE status = 'processed'
    ORDER BY id ASC
  `).all();
  return rows.slice(offset, limit ? offset + limit : undefined);
}

function feedbackSummary(db, links) {
  const ids = links.map((link) => Number(link.trackIdentityId)).filter(Boolean);
  if (!ids.length) return { linkedIdentityCount: 0, feedbackIdentityCount: 0, positiveEvents: 0, negativeEvents: 0 };
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT track_identity_id, LOWER(REPLACE(rating, ' ', '_')) AS rating, COUNT(*) AS count
    FROM taste_feedback
    WHERE track_identity_id IN (${placeholders})
    GROUP BY track_identity_id, LOWER(REPLACE(rating, ' ', '_'))
  `).all(...ids);
  const byIdentity = new Map();
  for (const row of rows) {
    const item = byIdentity.get(Number(row.track_identity_id)) || { positive: 0, negative: 0, neutral: 0, wrongGenre: 0 };
    const count = Number(row.count || 0);
    if (["love", "like", "good", "up"].includes(row.rating)) item.positive += count;
    else if (["never", "never_again", "dislike", "skip"].includes(row.rating)) item.negative += count;
    else if (["ok", "okay"].includes(row.rating)) item.neutral += count;
    else if (row.rating === "wrong_genre") item.wrongGenre += count;
    byIdentity.set(Number(row.track_identity_id), item);
  }
  return {
    linkedIdentityCount: ids.length,
    feedbackIdentityCount: byIdentity.size,
    positiveEvents: Array.from(byIdentity.values()).reduce((sum, item) => sum + item.positive, 0),
    negativeEvents: Array.from(byIdentity.values()).reduce((sum, item) => sum + item.negative, 0),
    wrongGenreEvents: Array.from(byIdentity.values()).reduce((sum, item) => sum + item.wrongGenre, 0)
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
    const linked = linkLocalLibraryToTrackIdentities(musicMemory.db, rows);
    const clusterStore = new TasteClusterStore({ db: musicMemory.db, logger: console });
    const profiles = buildTasteClusterProfiles(musicMemory.db, {
      model: args.model,
      modelVersion: args.modelVersion,
      minEmbeddings: args.minEmbeddings,
      includeExternalNegativeSeeds: args.includeExternalNegativeSeeds,
      includeExternalFeedbackSeeds: args.includeExternalFeedbackSeeds,
      links: linked.links
    });
    const persisted = args.write
      ? {
          identityLinks: clusterStore.replaceIdentityLinks(linked.links),
          profiles: clusterStore.replaceProfiles(profiles)
        }
      : null;
    const output = {
      schemaVersion: profiles.schemaVersion,
      generatedAt: profiles.generatedAt,
      options: {
        limit: args.limit,
        offset: args.offset,
        model: args.model,
        modelVersion: args.modelVersion,
        minEmbeddings: args.minEmbeddings,
        includeExternalNegativeSeeds: args.includeExternalNegativeSeeds,
        includeExternalFeedbackSeeds: args.includeExternalFeedbackSeeds,
        persisted: Boolean(persisted)
      },
      linkSummary: linked.summary,
      feedbackSummary: feedbackSummary(musicMemory.db, linked.links.filter((link) => link.trackIdentityId)),
      profileSummary: profiles.summary,
      profiles: profiles.profiles,
      persistence: persisted
    };
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      linkSummary: output.linkSummary,
      feedbackSummary: output.feedbackSummary,
      profileSummary: output.profileSummary,
      report: args.report,
      persisted: output.persistence
    }, null, 2));
  } finally {
    musicMemory.close();
  }
}

main();
