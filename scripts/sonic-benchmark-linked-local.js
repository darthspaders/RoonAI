"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const {
  EssentiaDiscogsEffNetProvider,
  SonicEmbeddingEngine,
  SpectralBaselineProvider
} = require("../src/sonicEmbeddingEngine");
const { SonicEmbeddingStore, cosineSimilarity } = require("../src/sonicEmbeddingStore");
const { sourceMetadata, trackFromRow } = require("./sonic-analyze-linked-local");

const GROUP_ORDER = ["progressive", "bass", "tech-house", "psytrance", "rock", "other"];
const GROUP_TARGETS = {
  progressive: 10,
  bass: 10,
  "tech-house": 8,
  psytrance: 5,
  rock: 7,
  other: 10
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    result[key] = !next || next.startsWith("--") ? true : next;
    if (result[key] !== true) index += 1;
  }
  return result;
}

function groupForRow(row) {
  const text = `${cleanText(row.genre)} ${cleanText(row.subgenre)}`.toLowerCase();
  if (/progressive\s*(house|trance)|progressive psy/.test(text)) return "progressive";
  if (/dubstep|bass|drum\s*(?:&|and)?\s*bass|d\s*&\s*b|experimental|140\s*\/|future bass|trap/.test(text)) return "bass";
  if (/tech\s*house|minimal\s*\/\s*deep\s*tech/.test(text)) return "tech-house";
  if (/psy[- ]?trance|psychedelic/.test(text)) return "psytrance";
  if (/rock|metal|punk|grunge|alternative/.test(text)) return "rock";
  return "other";
}

function stableSort(rows, seed) {
  return [...rows].sort((left, right) => {
    const leftKey = crypto.createHash("sha256").update(`${seed}|${left.beatport_id}`).digest("hex");
    const rightKey = crypto.createHash("sha256").update(`${seed}|${right.beatport_id}`).digest("hex");
    return leftKey.localeCompare(rightKey) || Number(left.local_file_id) - Number(right.local_file_id);
  });
}

function readCandidateRows(db) {
  return db.prepare(`
    SELECT
      m.id AS local_file_id,
      m.file_path,
      m.file_hash,
      m.artist AS local_artist,
      m.title AS local_title,
      m.album AS local_album,
      m.duration_ms AS local_duration_ms,
      m.beatport_id,
      CAST(json_extract(m.field_sources_json, '$.beatportId.confidence') AS INTEGER) AS beatport_confidence,
      m.isrc AS local_isrc,
      m.genre,
      m.subgenre,
      m.label,
      m.bpm,
      m.key_name,
      m.year,
      l.link_status,
      l.confidence AS link_confidence,
      ti.identity_key,
      ti.artist AS identity_artist,
      ti.title AS identity_title,
      ti.album AS identity_album,
      ti.mix_version AS identity_mix_version,
      ti.tidal_id,
      ti.isrc AS identity_isrc,
      be.beatport_track_id AS enriched_beatport_id,
      be.genre AS beatport_genre,
      be.subgenre AS beatport_subgenre,
      be.label AS beatport_label,
      be.bpm AS beatport_bpm,
      be.key_name AS beatport_key,
      be.release_date AS beatport_release_date,
      be.duration_ms AS beatport_duration_ms
    FROM local_library_file m
    LEFT JOIN local_library_identity_link l ON l.local_file_id = m.id
    LEFT JOIN track_identity ti ON ti.id = l.track_identity_id
    LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    WHERE m.status = 'processed'
      AND NULLIF(TRIM(m.beatport_id), '') IS NOT NULL
      AND (l.local_file_id IS NULL OR l.link_status IN ('EXACT', 'HIGH_CONFIDENCE'))
    ORDER BY m.id ASC
  `).all();
}

function selectRows(rows, { limit = 50, seed = "rabbit-hole-local-sonic-benchmark-v1" } = {}) {
  const deduped = new Map();
  for (const row of rows) {
    const beatportId = cleanText(row.enriched_beatport_id || row.beatport_id);
    const resolvedPath = path.resolve(String(row.file_path || "").trim());
    if (!beatportId || !resolvedPath || !fs.existsSync(resolvedPath)) continue;
    const current = deduped.get(beatportId);
    const rank = row.link_status === "EXACT" ? 0 : row.link_status === "HIGH_CONFIDENCE" ? 1 : 2;
    const currentRank = current?.link_status === "EXACT" ? 0 : current?.link_status === "HIGH_CONFIDENCE" ? 1 : 2;
    if (!current || rank < currentRank || (rank === currentRank && Number(row.local_file_id) < Number(current.local_file_id))) deduped.set(beatportId, row);
  }
  const groups = new Map(GROUP_ORDER.map((group) => [group, []]));
  for (const row of deduped.values()) groups.get(groupForRow(row)).push(row);
  for (const group of GROUP_ORDER) groups.set(group, stableSort(groups.get(group), seed));

  const selected = [];
  const selectedIds = new Set();
  for (const group of GROUP_ORDER) {
    for (const row of groups.get(group).slice(0, GROUP_TARGETS[group])) {
      if (selected.length >= limit) break;
      const id = cleanText(row.enriched_beatport_id || row.beatport_id);
      selected.push({ ...row, benchmarkGroup: group, benchmarkSeed: seed });
      selectedIds.add(id);
    }
  }
  if (selected.length < limit) {
    const remainder = stableSort([...deduped.values()].filter((row) => !selectedIds.has(cleanText(row.enriched_beatport_id || row.beatport_id))), seed);
    for (const row of remainder) {
      if (selected.length >= limit) break;
      const id = cleanText(row.enriched_beatport_id || row.beatport_id);
      selected.push({ ...row, benchmarkGroup: groupForRow(row), benchmarkSeed: seed });
      selectedIds.add(id);
    }
  }
  return selected.slice(0, limit);
}

function trackForRow(row) {
  return {
    ...trackFromRow(row),
    beatportTrackId: cleanText(row.enriched_beatport_id || row.beatport_id),
    genre: cleanText(row.beatport_genre || row.genre),
    subgenre: cleanText(row.beatport_subgenre || row.subgenre),
    label: cleanText(row.beatport_label || row.label),
    bpm: Number(row.beatport_bpm || row.bpm || 0) || null,
    keyName: cleanText(row.beatport_key || row.key_name),
    benchmarkGroup: row.benchmarkGroup
  };
}

function compactNeighbor(entry) {
  return {
    artist: entry.track?.artist || "",
    title: entry.track?.title || "",
    beatportId: entry.track?.metadata?.beatportId || entry.identityKey.replace(/^beatport:/i, ""),
    similarity: round(entry.similarity, 6),
    provider: entry.model,
    modelVersion: entry.modelVersion,
    benchmarkGroup: entry.benchmarkGroup || ""
  };
}

function rankNeighbors(rows, profiles, provider, count) {
  const selected = rows.map((row) => ({
    ...row,
    identityKey: trackForRow(row).identityKey,
    profile: profiles.get(trackForRow(row).identityKey)
  })).filter((row) => row.profile?.vector?.length);
  const groups = new Map(rows.map((row) => [cleanText(row.enriched_beatport_id || row.beatport_id), row.benchmarkGroup]));
  const lists = {};
  for (const row of selected) {
    const sourceId = cleanText(row.enriched_beatport_id || row.beatport_id);
    lists[sourceId] = selected
      .filter((candidate) => candidate.identityKey !== row.identityKey)
      .map((candidate) => ({
        ...candidate,
        similarity: cosineSimilarity(row.profile.vector, candidate.profile.vector)
      }))
      .filter((candidate) => candidate.similarity !== null)
      .sort((left, right) => right.similarity - left.similarity || left.identityKey.localeCompare(right.identityKey))
      .slice(0, count)
      .map((candidate) => compactNeighbor({
        ...candidate.profile,
        identityKey: candidate.identityKey,
        similarity: candidate.similarity,
        track: { ...candidate.profile.track, metadata: { ...candidate.profile.track.metadata, beatportId: cleanText(candidate.enriched_beatport_id || candidate.beatport_id) } },
        benchmarkGroup: groups.get(cleanText(candidate.enriched_beatport_id || candidate.beatport_id))
      }));
  }
  return { lists, evaluated: selected.length };
}

function summarizeTimings(rows, provider) {
  const values = rows
    .filter((row) => !row.providers[provider]?.cached)
    .map((row) => row.providers[provider]?.timings?.totalAnalysisMs)
    .filter(Number.isFinite);
  return {
    count: values.length,
    cached: rows.filter((row) => row.providers[provider]?.cached).length,
    averageMs: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    minMs: values.length ? round(Math.min(...values)) : null,
    maxMs: values.length ? round(Math.max(...values)) : null
  };
}

function sameGroupPrecision(rows, neighborLists, count) {
  const groups = new Map(rows.map((row) => [
    cleanText(row.enriched_beatport_id || row.beatport_id || row.beatportId),
    row.benchmarkGroup
  ]));
  const values = [];
  for (const row of rows) {
    const id = cleanText(row.enriched_beatport_id || row.beatport_id || row.beatportId);
    const neighbors = (neighborLists[id] || []).slice(0, count);
    if (!neighbors.length) continue;
    values.push(neighbors.filter((neighbor) => groups.get(String(neighbor.beatportId)) === row.benchmarkGroup).length / neighbors.length);
  }
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : null;
}

function usage() {
  console.log(`Local-library sonic benchmark

Usage:
  npm run sonic:benchmark:local -- --limit 50 --count 10 --device cuda
  npm run sonic:benchmark:local -- --limit 50 --count 10 --device cuda --refresh

The same deterministic, stratified Beatport-backed local files are analyzed with
the 80-D spectral baseline and 1,280-D Discogs-EffNet. Neighbors are compared
within the same benchmark set so provider pool size does not bias the result.
Use --refresh to bypass existing profiles and record uncached analysis timings.`);
}

async function main() {
  const input = argsFrom(process.argv.slice(2));
  if (input.help) return usage();
  const limit = Math.max(20, Math.min(100, Number(input.limit) || 50));
  const count = Math.max(1, Math.min(20, Number(input.count) || 10));
  const seed = cleanText(input.seed || "rabbit-hole-local-sonic-benchmark-v1");
  const refresh = Boolean(input.refresh);
  const device = cleanText(input.device || config.recommendationV2.essentia.device || "cuda").toLowerCase() === "gpu" ? "cuda" : cleanText(input.device || config.recommendationV2.essentia.device || "cuda").toLowerCase();
  if (!["cpu", "cuda"].includes(device)) throw new Error("--device must be cpu or cuda.");
  const outputPath = path.resolve(input.output || path.join("data", "sonic-local-benchmark-50.json"));
  const memory = new MusicMemoryStore({ ...config.musicMemory, logger: console });
  if (!memory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  let rows;
  try {
    rows = selectRows(readCandidateRows(memory.db), { limit, seed });
  } finally {
    memory.close();
  }
  if (rows.length < limit) throw new Error(`Only ${rows.length} usable Beatport-backed local files were available; benchmark requires ${limit}.`);

  const store = new SonicEmbeddingStore({ enabled: true, dbFile: config.musicMemory.dbFile, logger: console });
  const spectralProvider = new SpectralBaselineProvider({ ffmpegPath: config.recommendationV2.ffmpegPath });
  const learnedProvider = new EssentiaDiscogsEffNetProvider({ ...config.recommendationV2.essentia, device });
  if (!learnedProvider.status().available) throw new Error("Essentia Discogs-EffNet is not configured.");
  const spectral = new SonicEmbeddingEngine({ store, provider: spectralProvider, logger: console });
  const learned = new SonicEmbeddingEngine({ store, provider: learnedProvider, logger: console });
  const results = [];
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const track = trackForRow(row);
      const filePath = path.resolve(String(row.file_path || "").trim());
      const metadata = {
        ...sourceMetadata(row),
        sourceAudioType: "local-file",
        sourceMatchType: "BEATPORT_BACKED_LOCAL_FILE",
        benchmarkGroup: row.benchmarkGroup,
        benchmarkSeed: seed,
        analyzedAt: new Date().toISOString()
      };
      const providers = {};
      for (const [name, engine] of [["spectral-baseline", spectral], ["discogs-effnet", learned]]) {
        const startedAt = process.hrtime.bigint();
        const result = engine.analyzeFile(filePath, track, {
          force: refresh,
          sourceType: `local-file-benchmark-${name}`,
          metadata
        });
        providers[name] = {
          model: result.model,
          modelVersion: result.modelVersion,
          dimensions: result.dimensions,
          cached: Boolean(result.cached),
          sourceSha256: result.sourceSha256,
          timings: result.timings || { totalAnalysisMs: round(elapsedMilliseconds(startedAt)) }
        };
      }
      results.push({
        beatportId: cleanText(row.enriched_beatport_id || row.beatport_id),
        localFileId: Number(row.local_file_id),
        filePath: row.file_path,
        identityKey: track.identityKey,
        artist: track.artist,
        title: track.title,
        genre: track.genre,
        subgenre: track.subgenre,
        benchmarkGroup: row.benchmarkGroup,
        providers
      });
      console.log(`[sonic-local-benchmark] ${index + 1}/${rows.length} ${track.artist} - ${track.title}`);
    }

    const providerReports = {};
    for (const provider of ["spectral-baseline", "discogs-effnet"]) {
      const profiles = new Map();
      for (const row of results) {
        const profile = store.getEmbedding(row.identityKey, { model: provider, modelVersion: "1" });
        if (profile) profiles.set(row.identityKey, profile);
      }
      const ranked = rankNeighbors(rows, profiles, provider, count);
      providerReports[provider] = {
        dimensions: [...new Set(results.map((row) => row.providers[provider].dimensions))],
        timing: summarizeTimings(results, provider),
        evaluatedTracks: ranked.evaluated,
        sameBenchmarkGroupPrecisionAtK: sameGroupPrecision(results, ranked.lists, count),
        neighbors: ranked.lists
      };
    }

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      selection: {
        requested: limit,
        selected: results.length,
        seed,
        groupTargets: GROUP_TARGETS,
        groupCounts: Object.fromEntries(GROUP_ORDER.map((group) => [group, results.filter((row) => row.benchmarkGroup === group).length]))
      },
      neighborCount: count,
      environment: {
        platform: process.platform,
        node: process.version,
        hostRssMb: round(process.memoryUsage().rss / 1024 / 1024),
        essentia: learnedProvider.status()
      },
      providers: providerReports,
      tracks: results,
      storage: store.status()
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      report: outputPath,
      selection: report.selection,
      providers: Object.fromEntries(Object.entries(providerReports).map(([name, value]) => [name, {
        dimensions: value.dimensions,
        timing: value.timing,
        evaluatedTracks: value.evaluatedTracks,
        sameBenchmarkGroupPrecisionAtK: value.sameBenchmarkGroupPrecisionAtK
      }]))
    }, null, 2));
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  GROUP_ORDER,
  GROUP_TARGETS,
  groupForRow,
  main,
  readCandidateRows,
  selectRows
};
