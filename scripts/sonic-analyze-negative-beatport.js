"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const {
  BeatportClient,
  normalizeBeatportTrack
} = require("../src/beatportClient");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const {
  SonicEmbeddingEngine,
  EssentiaDiscogsEffNetProvider
} = require("../src/sonicEmbeddingEngine");
const {
  SonicEmbeddingStore,
  cosineSimilarity,
  normalizeVector
} = require("../src/sonicEmbeddingStore");
const { acquireProcessLock } = require("../src/processLock");

const DEFAULT_MODEL = "discogs-effnet";
const DEFAULT_MODEL_VERSION = "1";
const ACCEPTED_CONFIDENCE = 85;
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
    report: path.join(__dirname, "..", "data", "sonic-negative-beatport.json"),
    reportProvided: false,
    feedbackType: "negative",
    modelVersion: config.recommendationV2.essentia.modelVersion || DEFAULT_MODEL_VERSION,
    device: config.recommendationV2.essentia.device || "cpu",
    write: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(1, Math.min(50, Number(argv[++index]) || 50));
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--identity-ids" || arg === "--ids") args.identityIds = String(argv[++index] || "")
      .split(/[\s,]+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    else if (arg === "--report") {
      args.report = path.resolve(argv[++index] || "");
      args.reportProvided = true;
    }
    else if (arg === "--feedback") args.feedbackType = cleanText(argv[++index]).toLowerCase() || "negative";
    else if (arg === "--model-version") args.modelVersion = cleanText(argv[++index]) || DEFAULT_MODEL_VERSION;
    else if (arg === "--device") args.device = cleanText(argv[++index]).toLowerCase() || "cpu";
    else if (arg === "--write") args.write = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  args.feedbackType = args.feedbackType === "positive" ? "positive" : "negative";
  if (!args.reportProvided && args.feedbackType === "positive") {
    args.report = path.join(__dirname, "..", "data", "sonic-positive-beatport.json");
  }
  return args;
}

function usage() {
  console.log(`Analyze explicit feedback Beatport previews with Discogs-EffNet.

Usage:
  npm run sonic:analyze:negative-beatport -- --write --limit 50
  npm run sonic:analyze:positive-beatport -- --write --limit 50 --offset 50

Use --feedback positive|negative. Only identities with the selected explicit
feedback and persisted Beatport confidence >= ${ACCEPTED_CONFIDENCE} are
eligible. Use --identity-ids to target deliberate taste-area anchors.
Conflicting opposite feedback is excluded. The default is
read-only for storage; --write persists the learned embeddings and centroid
report.
`);
}

function normalizedFeedbackType(value) {
  return cleanText(value).toLowerCase() === "positive" ? "positive" : "negative";
}

function readTargets(db, limit, feedbackType = "negative", { offset = 0, identityIds = [] } = {}) {
  const type = normalizedFeedbackType(feedbackType);
  const ratings = FEEDBACK_RATINGS[type];
  const oppositeRatings = FEEDBACK_RATINGS[type === "positive" ? "negative" : "positive"];
  const selectedPlaceholders = ratings.map(() => "?").join(", ");
  const oppositePlaceholders = oppositeRatings.map(() => "?").join(", ");
  const safeIdentityIds = [...new Set((Array.isArray(identityIds) ? identityIds : [])
    .map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  const identityClause = safeIdentityIds.length
    ? `AND ti.id IN (${safeIdentityIds.map(() => "?").join(", ")})`
    : "";
  return db.prepare(`
    SELECT ti.id, ti.identity_key AS identityKey, ti.artist, ti.title,
      ti.mix_version AS mixVersion, ti.album, ti.tidal_id AS tidalId,
      ti.isrc, ti.duration_ms AS durationMs,
      be.beatport_track_id AS beatportId, be.genre, be.subgenre AS subGenre,
      be.label, be.confidence AS beatportConfidence, be.raw_json AS rawJson
    FROM track_identity ti
    JOIN taste_feedback tf ON tf.track_identity_id = ti.id
    JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    WHERE LOWER(REPLACE(tf.rating, ' ', '_')) IN (${selectedPlaceholders})
      AND COALESCE(be.confidence, 0) >= ?
      AND COALESCE(be.beatport_track_id, '') <> ''
      ${identityClause}
      AND NOT EXISTS (
        SELECT 1 FROM taste_feedback opposite
        WHERE opposite.track_identity_id = ti.id
          AND LOWER(REPLACE(opposite.rating, ' ', '_')) IN (${oppositePlaceholders})
      )
    GROUP BY ti.id
    ORDER BY ti.id
    LIMIT ? OFFSET ?
  `).all(...ratings, ACCEPTED_CONFIDENCE, ...safeIdentityIds, ...oppositeRatings, Math.max(1, Math.min(50, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
}

function parseBeatportTrack(row) {
  let raw = {};
  try {
    raw = JSON.parse(row.rawJson || "{}");
  } catch {
    raw = {};
  }
  const candidate = normalizeBeatportTrack(raw);
  return {
    ...candidate,
    id: cleanText(row.beatportId || candidate.id),
    genre: cleanText(candidate.genre || row.genre),
    subGenre: cleanText(candidate.subGenre || row.subGenre),
    label: cleanText(candidate.label || row.label)
  };
}

function trackForAnalysis(row, beatportTrack) {
  return {
    identityKey: cleanText(row.identityKey),
    tidalId: cleanText(row.tidalId),
    isrc: cleanText(row.isrc),
    artist: cleanText(row.artist),
    title: cleanText(row.title),
    mixVersion: cleanText(row.mixVersion),
    album: cleanText(row.album),
    durationMs: Number(row.durationMs || beatportTrack.durationMs || 0) || null,
    beatportTrackId: cleanText(beatportTrack.id)
  };
}

function feedbackLabels(db, identityId) {
  return db.prepare(`
    SELECT DISTINCT LOWER(REPLACE(rating, ' ', '_')) AS rating
    FROM taste_feedback
    WHERE track_identity_id = ?
    ORDER BY rating
  `).all(Number(identityId)).map((row) => cleanText(row.rating)).filter(Boolean);
}

function meanNormalizedVector(vectors) {
  const valid = vectors.filter((vector) => Array.isArray(vector) && vector.length);
  if (!valid.length) return [];
  const dimensions = valid[0].length;
  if (valid.some((vector) => vector.length !== dimensions)) return [];
  const mean = Array.from({ length: dimensions }, () => 0);
  for (const vector of valid) {
    for (let index = 0; index < dimensions; index += 1) mean[index] += Number(vector[index]) || 0;
  }
  return normalizeVector(mean.map((value) => value / valid.length));
}

function groupKey(row) {
  return cleanText(row.genre || row.subGenre) || "unclassified";
}

function buildCentroidReport(rows, model, modelVersion, feedbackType = "negative") {
  const type = normalizedFeedbackType(feedbackType);
  const analyzed = rows.filter((row) => row.embedding?.vector?.length);
  const overallVector = meanNormalizedVector(analyzed.map((row) => row.embedding.vector));
  const groups = new Map();
  for (const row of analyzed) {
    const key = groupKey(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const grouped = [...groups.entries()].map(([key, members]) => {
    const vector = meanNormalizedVector(members.map((row) => row.embedding.vector));
    return {
      key,
      count: members.length,
      vectorDimensions: vector.length,
      members: members.map((row) => ({
        identityId: row.identityId,
        identityKey: row.identityKey,
        artist: row.artist,
        title: row.title,
        beatportId: row.beatportId
      })),
      vector
    };
  }).sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  const pairwise = [];
  for (let left = 0; left < analyzed.length; left += 1) {
    for (let right = left + 1; right < analyzed.length; right += 1) {
      const similarity = cosineSimilarity(analyzed[left].embedding.vector, analyzed[right].embedding.vector);
      if (similarity !== null) pairwise.push(similarity);
    }
  }
  const pairwiseMean = pairwise.length
    ? pairwise.reduce((sum, value) => sum + value, 0) / pairwise.length
    : null;
  return {
    schemaVersion: 1,
    centroidType: `explicit-${type}-sonic-centroid`,
    model,
    modelVersion,
    dimensions: overallVector.length,
    source: "Beatport preview",
    feedback: FEEDBACK_RATINGS[type],
    count: analyzed.length,
    identityIds: analyzed.map((row) => row.identityId),
    meanPairwiseSimilarity: pairwiseMean === null ? null : Number(pairwiseMean.toFixed(6)),
    vector: overallVector,
    groups: grouped
  };
}

async function analyzeFeedbackBeatport({
  dbFile = config.musicMemory.dbFile,
  limit = 50,
  offset = 0,
  identityIds = [],
  report = path.join(__dirname, "..", "data", "sonic-negative-beatport.json"),
  modelVersion = DEFAULT_MODEL_VERSION,
  device = "cpu",
  feedbackType = "negative",
  write = false,
  logger = console
} = {}) {
  const type = normalizedFeedbackType(feedbackType);
  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile, logger });
  if (!memory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  // Keep the default invocation genuinely read-only. The analyzer persists
  // through its normal interface, so a dry-run gets an isolated in-memory
  // sonic store instead of writing temporary vectors into the production DB.
  const sonicStore = new SonicEmbeddingStore({ enabled: true, dbFile: write ? dbFile : ":memory:", logger });
  if (!sonicStore.db) throw new Error("Rabbit Hole sonic embedding store could not be opened.");
  const targets = readTargets(memory.db, limit, type, { offset, identityIds });
  const essentia = new EssentiaDiscogsEffNetProvider({
    ...config.recommendationV2.essentia,
    modelVersion,
    device
  });
  if (!essentia.status().available) {
    memory.close();
    sonicStore.close();
    throw new Error("Essentia Discogs-EffNet is not configured. Verify the WSL worker/model setup before running this bounded pass.");
  }
  const engine = new SonicEmbeddingEngine({ store: sonicStore, provider: essentia, logger });
  const beatport = new BeatportClient({ ...config.beatport, logger });
  const rows = [];
  try {
    for (const target of targets) {
      const base = {
        identityId: Number(target.id),
        identityKey: cleanText(target.identityKey),
        artist: cleanText(target.artist),
        title: cleanText(target.title),
        mixVersion: cleanText(target.mixVersion),
        beatportId: cleanText(target.beatportId),
        beatportConfidence: Number(target.beatportConfidence || 0),
        feedback: feedbackLabels(memory.db, target.id),
        genre: cleanText(target.genre),
        subGenre: cleanText(target.subGenre),
        label: cleanText(target.label),
        status: "pending"
      };
      let audioBuffer = null;
      try {
        const beatportTrack = parseBeatportTrack(target);
        if (!beatportTrack.id || beatportTrack.id !== base.beatportId) {
          throw new Error("Persisted Beatport identity did not include the expected track id.");
        }
        const streamed = await beatport.fetchPreviewBuffer(beatportTrack);
        audioBuffer = streamed.buffer;
        const analysisTrack = trackForAnalysis(target, beatportTrack);
        const startedAt = process.hrtime.bigint();
        const embedding = engine.analyzeBuffer(audioBuffer, analysisTrack, {
          sourceType: `beatport-preview-${type}-seed`,
          metadata: {
            sourceAudioType: "beatport-preview",
            sourceProvider: "beatport",
            sourceTrackId: beatportTrack.id,
            beatportId: beatportTrack.id,
            sourcePreviewUrl: streamed.previewUrl,
            sourceMatchType: "BEATPORT_NATIVE_PREVIEW",
            sourceMatchConfidence: base.beatportConfidence,
            analyzedDurationMs: streamed.previewDurationMs,
            analyzedAt: new Date().toISOString(),
            feedbackRole: `explicit-${type}`,
            analysisRole: `${type}-centroid-seed`,
            previewBytes: streamed.bytes,
            previewContentType: streamed.contentType
          }
        });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        base.status = "analyzed";
        base.preview = {
          bytes: streamed.bytes,
          durationMs: streamed.previewDurationMs,
          contentType: streamed.contentType,
          url: streamed.previewUrl
        };
        base.beatport = {
          id: beatportTrack.id,
          artist: beatportTrack.artist,
          title: beatportTrack.title,
          mixName: beatportTrack.mixName,
          genre: beatportTrack.genre,
          subGenre: beatportTrack.subGenre,
          label: beatportTrack.label,
          bpm: beatportTrack.bpm
        };
        base.embedding = {
          model: embedding.model,
          modelVersion: embedding.modelVersion,
          dimensions: embedding.dimensions,
          sourceSha256: embedding.sourceSha256,
          cached: Boolean(embedding.cached),
          timings: embedding.timings || null,
          elapsedMs: Number(elapsedMs.toFixed(2)),
          vector: sonicStore.getEmbedding(base.identityKey, {
            model: embedding.model,
            modelVersion: embedding.modelVersion
          })?.vector || []
        };
      } catch (error) {
        base.status = "failed";
        base.error = error.message;
      } finally {
        if (audioBuffer) audioBuffer.fill(0);
        audioBuffer = null;
      }
      if (base.status === "analyzed") base.embedding.persisted = Boolean(write);
      rows.push(base);
      logger.log(JSON.stringify({ identityId: base.identityId, artist: base.artist, title: base.title, status: base.status, dimensions: base.embedding?.dimensions || 0 }, null, 2));
    }
    const centroid = buildCentroidReport(rows, DEFAULT_MODEL, modelVersion, type);
    const output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scope: `explicit-${type}-beatport-preview-sonic-analysis`,
      options: { dbFile: path.resolve(dbFile), limit, offset, identityIds, modelVersion, device, feedbackType: type, write },
      provider: essentia.status(),
      summary: {
        targets: targets.length,
        analyzed: rows.filter((row) => row.status === "analyzed").length,
        failed: rows.filter((row) => row.status === "failed").length,
        persisted: rows.filter((row) => row.embedding?.persisted).length,
        centroidDimensions: centroid.dimensions,
        centroidCount: centroid.count
      },
      centroid,
      rows,
      beatportDiagnostics: beatport.diagnostics()
    };
    fs.mkdirSync(path.dirname(path.resolve(report)), { recursive: true });
    fs.writeFileSync(path.resolve(report), `${JSON.stringify(output, null, 2)}\n`, "utf8");
    logger.log(JSON.stringify({ ...output.summary, report: path.resolve(report), write }, null, 2));
    return output;
  } finally {
    memory.close();
    sonicStore.close();
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
  } else {
    let lock = null;
    try {
      if (args.write) lock = acquireProcessLock(path.join(__dirname, "..", "data", `sonic-${args.feedbackType}-beatport.lock`), `${args.feedbackType} Beatport sonic analysis`);
      analyzeFeedbackBeatport(args)
        .catch((error) => {
          console.error(`${args.feedbackType} Beatport sonic analysis failed: ${error.message}`);
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
  ACCEPTED_CONFIDENCE,
  buildCentroidReport,
  meanNormalizedVector,
  parseBeatportTrack,
  readTargets,
  analyzeNegativeBeatport: analyzeFeedbackBeatport,
  analyzeFeedbackBeatport,
  normalizedFeedbackType
};
