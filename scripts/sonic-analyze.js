"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const { BeatportClient } = require("../src/beatportClient");
const { TidalVerifier } = require("../src/tidalVerifier");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function usage() {
  console.log(`Rabbit Hole Recommendation Engine v2 sonic POC

Analyze one file:
  npm run sonic:analyze -- analyze --file <path> [--artist <name>] [--title <title>]

Analyze a directory:
  npm run sonic:analyze -- analyze --dir <path> [--limit 20]

Find neighbors:
  npm run sonic:analyze -- neighbors --file <path> [--count 20]
  npm run sonic:analyze -- neighbors --identity <tidal:123|beatport:123|text:artist|title> [--provider discogs-effnet|spectral-baseline] [--count 20]

Generate review-only neighbor candidates from one or more stored anchors:
  npm run sonic:analyze -- neighbor-candidates --identity <tidal:123,tidal:456> [--count 20]
  npm run sonic:analyze -- neighbor-candidates --identity <tidal:123> --genre "Progressive House"

Analyze a canonical TIDAL track using a matched Beatport preview (version proxy):
  npm run sonic:analyze -- beatport-tidal-analyze --url <tidal-track-url>

The default provider is a deterministic spectral baseline. Set
RABBIT_HOLE_SONIC_EMBEDDING_PROVIDER=external-json and configure the external
JSON worker when using Essentia or MERT.`);
}

function argsFrom(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function trackFromFile(filePath, input = {}) {
  const stem = path.basename(filePath, path.extname(filePath));
  const parts = stem.split(/\s+[-–—]\s+/);
  return {
    artist: cleanText(input.artist || (parts.length > 1 ? parts.shift() : "")),
    title: cleanText(input.title || parts.join(" - ") || stem),
    album: cleanText(input.album),
    tidalId: cleanText(input.tidalId || input["tidal-id"]),
    isrc: cleanText(input.isrc),
    filePath
  };
}

function audioFiles(directory, limit = 100) {
  const allowed = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".alac"]);
  const found = [];
  function visit(current) {
    if (found.length >= limit) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (found.length >= limit) break;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (allowed.has(path.extname(entry.name).toLowerCase())) found.push(child);
    }
  }
  visit(path.resolve(directory));
  return found;
}

function createEngine() {
  const tidal = new TidalVerifier({ ...config.tidal });
  const beatport = new BeatportClient({ ...config.beatport, logger: console });
  return new RecommendationEngineV2({
    enabled: true,
    dbFile: config.recommendationV2.dbFile,
    embeddingProvider: config.recommendationV2.embeddingProvider,
    ffmpegPath: config.recommendationV2.ffmpegPath,
    embeddingCommand: config.recommendationV2.embeddingCommand,
    embeddingArgs: config.recommendationV2.embeddingArgs,
    embeddingModel: config.recommendationV2.embeddingModel,
    embeddingModelVersion: config.recommendationV2.embeddingModelVersion,
    embeddingTimeoutMs: config.recommendationV2.embeddingTimeoutMs,
    essentia: config.recommendationV2.essentia,
    beatportClient: beatport,
    tidalClient: tidal,
    logger: console
  });
}

async function main() {
  const input = argsFrom(process.argv.slice(2));
  const command = cleanText(input._[0]).toLowerCase();
  if (!command || input.help) {
    usage();
    return;
  }
  const engine = createEngine();
  if (command === "analyze") {
    const files = input.dir
      ? audioFiles(input.dir, Math.max(1, Math.min(1000, Number(input.limit) || 100)))
      : [input.file].filter(Boolean).map((file) => path.resolve(file));
    if (!files.length) throw new Error("analyze requires --file or --dir with at least one audio file.");
    const results = files.map((file) => engine.analyzeFile(file, trackFromFile(file, input)));
    console.log(JSON.stringify({ ok: true, analyzed: results.length, results, status: engine.status() }, null, 2));
    return;
  }
  if (command === "neighbors") {
    const file = input.file ? path.resolve(input.file) : "";
    const reference = file
      ? trackFromFile(file, input)
      : cleanText(input.identity || input.track);
    if (!reference) throw new Error("neighbors requires --file or --identity.");
    const result = engine.findSonicNeighbors({
      track: reference,
      count: Number(input.count) || 20,
      model: cleanText(input.provider || input.model),
      modelVersion: cleanText(input["model-version"] || input.modelVersion),
      analyzeIfMissing: true,
      minSimilarity: input["min-similarity"] === undefined ? -1 : Number(input["min-similarity"])
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "neighbor-candidates" || command === "sonic-neighbor-candidates") {
    const file = input.file ? path.resolve(input.file) : "";
    const identityInput = cleanText(input.identities || input.identity || input.track);
    const anchors = file
      ? [trackFromFile(file, input)]
      : identityInput.split(",").map(cleanText).filter(Boolean);
    if (!anchors.length) throw new Error("neighbor-candidates requires --file or --identity/--identities.");
    const result = engine.generateSonicNeighborCandidates({
      anchors,
      count: Number(input.count) || 20,
      perAnchorCount: Number(input["per-anchor-count"] || input.perAnchorCount) || undefined,
      model: cleanText(input.provider || input.model),
      modelVersion: cleanText(input["model-version"] || input.modelVersion),
      minSimilarity: input["min-similarity"] === undefined ? undefined : Number(input["min-similarity"]),
      genre: input.genre,
      genres: input.genres ? String(input.genres).split(",").map(cleanText).filter(Boolean) : undefined
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "beatport-tidal-analyze") {
    const reference = cleanText(input.url || input["tidal-url"] || input.tidalUrl || input.id || input["tidal-id"]);
    if (!reference) throw new Error("beatport-tidal-analyze requires --url or --id.");
    const result = await engine.analyzeBeatportPreviewForTidalTrack(reference, {
      allowVersionProxy: input["allow-version-proxy"] !== false,
      maxBytes: input["max-bytes"] === undefined ? undefined : Number(input["max-bytes"])
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
