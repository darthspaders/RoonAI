"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("../src/config");
const { BeatportClient } = require("../src/beatportClient");
const {
  EssentiaDiscogsEffNetProvider,
  SonicEmbeddingEngine,
  SpectralBaselineProvider
} = require("../src/sonicEmbeddingEngine");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function elapsedMilliseconds(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function usage() {
  console.log(`Beatport preview sonic provider benchmark

Runs spectral-baseline and Essentia Discogs-EffNet over Beatport previews.

  node scripts/sonic-beatport-benchmark.js [--limit 20]
    [--output .codex-verify/sonic-beatport-benchmark.json]
    [--db .codex-verify/sonic-beatport-benchmark.sqlite]
    [--queries "D-Nox|Progressive House,Alix Perez|Wubs & Dubs,Chris Lorenzo|Tech House,Astrix|Psytrance"]

The learned provider uses the configured Essentia WSL wrapper by default.`);
}

function parseQuerySpecs(value) {
  return String(value || "")
    .split(",")
    .map(cleanText)
    .filter(Boolean)
    .map((spec) => {
      const [query, group] = spec.split("|").map(cleanText);
      return { query, group: group || query };
    })
    .filter((spec) => spec.query);
}

async function collectTracks(beatport, querySpecs, limit) {
  const pools = [];
  const perQuery = Math.max(8, Math.ceil(limit / Math.max(1, querySpecs.length)) + 4);
  for (const spec of querySpecs) {
    const result = await beatport.searchTracks({ query: spec.query, perPage: perQuery });
    const tracks = result.tracks.filter((track) => track.id && track.previewUrl);
    pools.push({ ...spec, tracks });
  }

  // Search every lane first, then take one item per lane in round-robin order.
  // This keeps a prolific search lane from consuming the entire benchmark and
  // makes the genre-area comparison reproducible.
  const selected = [];
  const seen = new Set();
  for (let offset = 0; selected.length < limit; offset += 1) {
    let added = false;
    for (const pool of pools) {
      const track = pool.tracks[offset];
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      selected.push({ ...track, benchmarkGroup: pool.group, benchmarkQuery: pool.query });
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function benchmarkTrackIdentity(track) {
  return `beatport:${track.id}`;
}

function compactNeighbor(neighbor) {
  return {
    artist: neighbor.track?.artist || "",
    title: neighbor.track?.title || "",
    mixName: neighbor.track?.mixVersion || "",
    beatportId: neighbor.identityKey.replace(/^beatport:/i, ""),
    similarity: neighbor.similarity,
    provider: neighbor.model,
    modelVersion: neighbor.modelVersion
  };
}

function summarizeTimings(rows, field) {
  const values = rows.map((row) => Number(row.timings?.[field])).filter(Number.isFinite);
  return {
    count: values.length,
    averageMs: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
    minMs: values.length ? round(Math.min(...values)) : null,
    maxMs: values.length ? round(Math.max(...values)) : null
  };
}

function summarizeMetadata(rows, field) {
  const values = rows.map((row) => Number(row.learned?.metadata?.[field])).filter(Number.isFinite);
  return {
    count: values.length,
    averageMb: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    minMb: values.length ? round(Math.min(...values)) : null,
    maxMb: values.length ? round(Math.max(...values)) : null
  };
}

function sameGroupPrecision(rows, neighborLists, count) {
  const groups = new Map(rows.map((row) => [row.id, row.benchmarkGroup]));
  const values = [];
  for (const row of rows) {
    const neighbors = (neighborLists[row.id] || []).slice(0, count);
    if (!neighbors.length) continue;
    values.push(neighbors.filter((neighbor) => groups.get(neighbor.beatportId) === row.benchmarkGroup).length / neighbors.length);
  }
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : null;
}

async function main() {
  const input = argsFrom(process.argv.slice(2));
  if (input.help) return usage();
  const limit = Math.max(20, Math.min(100, Number(input.limit) || 20));
  const count = Math.max(1, Math.min(20, Number(input.count) || 20));
  const querySpecs = parseQuerySpecs(input.queries || "D-Nox|Progressive House,Alix Perez|Wubs & Dubs,Chris Lorenzo|Tech House,Astrix|Psytrance");
  const queries = querySpecs.map((spec) => spec.query);
  const outputPath = path.resolve(input.output || path.join(".codex-verify", "sonic-beatport-benchmark.json"));
  const dbFile = path.resolve(input.db || outputPath.replace(/\.json$/i, ".sqlite"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const beatport = new BeatportClient({ ...config.beatport, logger: console });
  if (!beatport.isConfigured()) throw new Error("Beatport is not configured. Enable Beatport and provide an OAuth access or refresh token.");
  const tracks = await collectTracks(beatport, querySpecs, limit);
  if (tracks.length < limit) {
    throw new Error(`Only ${tracks.length} Beatport previews were found; benchmark requires at least ${limit}. Try broader --queries or a larger Beatport page.`);
  }

  const store = new SonicEmbeddingStore({ enabled: true, dbFile, logger: console });
  const spectralProvider = new SpectralBaselineProvider({ ffmpegPath: config.recommendationV2.ffmpegPath });
  const learnedProvider = new EssentiaDiscogsEffNetProvider({ ...config.recommendationV2.essentia });
  if (!learnedProvider.status().available) throw new Error("Essentia Discogs-EffNet is not configured. Run the WSL setup or configure the learned provider command/model.");
  const spectral = new SonicEmbeddingEngine({ store, provider: spectralProvider, logger: console });
  const learned = new SonicEmbeddingEngine({ store, provider: learnedProvider, logger: console });
  const rows = [];

  try {
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const identityKey = benchmarkTrackIdentity(track);
      const trackForAnalysis = {
        identityKey,
        beatportTrackId: track.id,
        artist: track.artist,
        title: track.title,
        mixVersion: track.mixName,
        album: track.album,
        label: track.label,
        releaseDate: track.releaseDate,
        durationMs: track.durationMs,
        isrc: track.isrc
      };
      const downloadStartedAt = process.hrtime.bigint();
      const streamed = await beatport.fetchPreviewBuffer(track);
      const previewDownloadMs = elapsedMilliseconds(downloadStartedAt);
      let audioBuffer = streamed.buffer;
      try {
        const sourceMetadata = {
          sourceAudioType: "beatport-preview",
          sourceProvider: "beatport",
          sourceTrackId: track.id,
          beatportId: track.id,
          sourcePreviewUrl: streamed.previewUrl,
          sourceMatchType: "beatport-native-preview",
          analyzedDurationMs: streamed.previewDurationMs,
          analyzedAt: new Date().toISOString()
        };
        const spectralResult = spectral.analyzeBuffer(audioBuffer, trackForAnalysis, {
          sourceType: "beatport-preview-spectral-baseline",
          metadata: sourceMetadata
        });
        const learnedResult = learned.analyzeBuffer(audioBuffer, trackForAnalysis, {
          sourceType: "beatport-preview-discogs-effnet",
          metadata: sourceMetadata
        });
        rows.push({
          id: track.id,
          identityKey,
          benchmarkGroup: track.benchmarkGroup,
          benchmarkQuery: track.benchmarkQuery,
          artist: track.artist,
          title: track.title,
          mixName: track.mixName,
          label: track.label,
          genre: track.genre,
          bpm: track.bpm,
          durationMs: track.durationMs,
          previewDurationMs: streamed.previewDurationMs,
          previewBytes: streamed.bytes,
          previewUrl: streamed.previewUrl,
          timings: {
            previewDownloadMs: round(previewDownloadMs),
            spectralFfmpegDecodeMs: spectralResult.timings?.ffmpegDecodeMs ?? null,
            spectralEmbeddingMs: spectralResult.timings?.embeddingMs ?? null,
            spectralTotalMs: round(previewDownloadMs + Number(spectralResult.timings?.totalAnalysisMs || 0)),
            learnedFfmpegDecodeMs: learnedResult.timings?.ffmpegDecodeMs ?? null,
            learnedEmbeddingMs: learnedResult.timings?.embeddingMs ?? null,
            learnedTotalMs: round(previewDownloadMs + Number(learnedResult.timings?.totalAnalysisMs || 0))
          },
          spectral: {
            provider: spectralResult.model,
            modelVersion: spectralResult.modelVersion,
            dimensions: spectralResult.dimensions
          },
          learned: {
            provider: learnedResult.model,
            modelVersion: learnedResult.modelVersion,
            dimensions: learnedResult.dimensions,
            metadata: store.getEmbedding(identityKey, { model: learnedResult.model, modelVersion: learnedResult.modelVersion })?.track.metadata || {}
          }
        });
      } finally {
        if (audioBuffer) audioBuffer.fill(0);
        audioBuffer = null;
      }
      console.log(`[sonic-benchmark] ${index + 1}/${tracks.length} ${track.artist} - ${track.title}`);
    }

    const providerReports = {};
    for (const provider of ["spectral-baseline", "discogs-effnet"]) {
      const neighborLists = {};
      for (const row of rows) {
        const embedding = store.getEmbedding(row.identityKey, { model: provider, modelVersion: "1" });
        neighborLists[row.id] = embedding
          ? store.findNearest({
              track: row.identityKey,
              vector: embedding.vector,
              model: provider,
              modelVersion: "1",
              count,
              minSimilarity: -1
            }).map(compactNeighbor)
          : [];
      }
      const timingField = provider === "discogs-effnet" ? "learnedEmbeddingMs" : "spectralEmbeddingMs";
      providerReports[provider] = {
        dimensions: [...new Set(rows.map((row) => row[provider === "discogs-effnet" ? "learned" : "spectral"].dimensions))],
        meanEmbeddingMs: summarizeTimings(rows, timingField),
        meanFfmpegDecodeMs: summarizeTimings(rows, provider === "discogs-effnet" ? "learnedFfmpegDecodeMs" : "spectralFfmpegDecodeMs"),
        meanTotalMs: summarizeTimings(rows, provider === "discogs-effnet" ? "learnedTotalMs" : "spectralTotalMs"),
        workerPeakRssMb: provider === "discogs-effnet" ? summarizeMetadata(rows, "workerPeakRssMb") : null,
        sameBenchmarkGroupPrecisionAtK: sameGroupPrecision(rows, neighborLists, count),
        neighbors: neighborLists
      };
    }

    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      trackCount: rows.length,
      neighborCount: count,
      queries,
      querySpecs,
      environment: {
        platform: process.platform,
        node: process.version,
        hostRssMb: round(process.memoryUsage().rss / 1024 / 1024),
        wslEssentia: learnedProvider.status()
      },
      storage: { dbFile, persistent: true },
      providers: providerReports,
      tracks: rows
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: outputPath,
      dbFile,
      trackCount: rows.length,
      providers: Object.fromEntries(Object.entries(providerReports).map(([name, value]) => [name, {
        dimensions: value.dimensions,
        meanEmbeddingMs: value.meanEmbeddingMs.averageMs,
        meanFfmpegDecodeMs: value.meanFfmpegDecodeMs.averageMs,
        meanTotalMs: value.meanTotalMs.averageMs,
        sameBenchmarkGroupPrecisionAtK: value.sameBenchmarkGroupPrecisionAtK
      }]))
    }, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
