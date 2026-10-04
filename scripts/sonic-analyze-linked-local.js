"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const config = require("../src/config");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { acquireProcessLock } = require("../src/processLock");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const { decodeAudio, sha256File } = require("../src/sonicEmbeddingEngine");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    dbFile: config.musicMemory.dbFile,
    limit: 4,
    offset: 0,
    source: "beatport-backed",
    feedbackOnly: false,
    execution: "auto",
    device: cleanText(config.recommendationV2.essentia.device) || "cpu",
    modelVersion: cleanText(config.recommendationV2.essentia.modelVersion) || "1",
    report: path.join(__dirname, "..", "data", "sonic-linked-local-discogs-effnet.json")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.dbFile = path.resolve(argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(1, Math.min(500, Number(argv[++index]) || 4));
    else if (arg === "--offset") args.offset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--source") args.source = cleanText(argv[++index] || args.source).toLowerCase();
    else if (arg === "--feedback-only") args.feedbackOnly = true;
    else if (arg === "--execution" || arg === "--mode") args.execution = cleanText(argv[++index] || args.execution).toLowerCase();
    else if (arg === "--device") args.device = cleanText(argv[++index] || args.device).toLowerCase();
    else if (arg === "--model-version") args.modelVersion = cleanText(argv[++index] || args.modelVersion);
    else if (arg === "--report") args.report = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  if (!["cpu", "cuda", "gpu"].includes(args.device)) throw new Error("--device must be cpu or cuda.");
  if (args.device === "gpu") args.device = "cuda";
  if (!["auto", "batch", "serial"].includes(args.execution)) throw new Error("--execution must be auto, batch, or serial.");
  if (!["beatport-backed", "local-file"].includes(args.source)) throw new Error("--source must be beatport-backed or local-file.");
  return args;
}

function printHelp() {
  console.log(`Analyze a bounded set of local-library rows with Discogs-EffNet.

Usage:
  npm run sonic:analyze:linked-local -- [--limit 50] [--device cpu|cuda]
    [--execution auto|batch|serial] [--feedback-only] [--source beatport-backed|local-file]

The default source is beatport-backed: only processed rows with a Beatport id are
eligible, an EXACT or HIGH_CONFIDENCE identity link is preferred, ambiguous or
conflicting links are excluded, and duplicate local copies of one Beatport id are
analyzed once. Use --source local-file for processed rows without Beatport coverage;
those rows are keyed by their stable SHA-256 file identity and analyzed from the
actual local file. Existing learned profiles for the same local file are skipped.
This command does not run discovery or write audio tags. The --feedback-only option
restricts selection to rows with stored feedback and an identity link.

The default auto execution uses one warm Essentia worker when the configured
provider is the standard WSL launcher. This avoids loading TensorFlow once per
track. Use --execution serial to force the original per-track path or --execution
batch to fail closed if the warm worker is unavailable.
`);
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

function toWslPath(value) {
  const input = cleanText(value);
  const absolute = input && !path.isAbsolute(input) && !input.startsWith("/") ? path.resolve(input) : input;
  const match = absolute.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return absolute;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("The Essentia batch worker returned no JSON.");
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* try the next JSON line */ }
    }
  }
  throw new Error("The Essentia batch worker did not return valid JSON.");
}

function batchExecutionSupported(essentia = config.recommendationV2.essentia) {
  return Boolean(
    /^wsl(?:\.exe)?$/i.test(path.basename(cleanText(essentia.command)))
      && (!Array.isArray(essentia.args) || essentia.args.length === 0)
      && cleanText(essentia.batchWrapperPath)
      && fs.existsSync(cleanText(essentia.batchWrapperPath))
  );
}

function runEssentiaBatch({ manifestPath, args, essentia }) {
  const envArgs = [
    `RABBIT_HOLE_SONIC_ESSENTIA_DEVICE=${args.device}`,
    ...(cleanText(essentia.venv) ? [`RABBIT_HOLE_SONIC_ESSENTIA_VENV=${toWslPath(essentia.venv)}`] : []),
    ...(cleanText(essentia.modelPath) ? [`RABBIT_HOLE_SONIC_ESSENTIA_MODEL_PATH=${toWslPath(essentia.modelPath)}`] : []),
    ...(cleanText(essentia.modelName) ? [`RABBIT_HOLE_SONIC_ESSENTIA_MODEL_NAME=${cleanText(essentia.modelName)}`] : []),
    ...(cleanText(essentia.output) ? [`RABBIT_HOLE_SONIC_ESSENTIA_OUTPUT=${cleanText(essentia.output)}`] : []),
    `RABBIT_HOLE_SONIC_ESSENTIA_DIMENSIONS=${Number(essentia.expectedDimensions || 1280)}`,
    `RABBIT_HOLE_SONIC_ESSENTIA_SAMPLE_RATE=${Number(essentia.sampleRate || 16000)}`
  ];
  const command = cleanText(essentia.command) || "wsl.exe";
  const workerArgs = ["env", ...envArgs, "bash", toWslPath(essentia.batchWrapperPath), toWslPath(manifestPath)];
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(command, workerArgs, {
    encoding: "utf8",
    timeout: Math.max(30_000, Number(essentia.timeoutMs || 900_000)),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw new Error(`Essentia warm batch worker failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = cleanText(result.stderr);
    throw new Error(`Essentia warm batch worker exited with ${result.status}${detail ? `: ${detail}` : "."}`);
  }
  const payload = parseJsonOutput(result.stdout);
  if (!Array.isArray(payload.items)) throw new Error("Essentia warm batch worker returned no item results.");
  return { ...payload, processMs: round(elapsedMilliseconds(startedAt)) };
}

function readEligibleRows(db, {
  limit,
  offset,
  feedbackOnly = false,
  source = "beatport-backed",
  model = "discogs-effnet",
  modelVersion = "1"
}) {
  const sourceMode = cleanText(source).toLowerCase() || "beatport-backed";
  if (sourceMode === "local-file") {
    const rows = db.prepare(`
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
        l.track_identity_id,
        l.link_status,
        l.confidence AS link_confidence,
        ti.identity_key,
        ti.artist AS identity_artist,
        ti.title AS identity_title,
        ti.album AS identity_album,
        ti.mix_version AS identity_mix_version,
        ti.tidal_id,
        ti.isrc AS identity_isrc,
        NULL AS enriched_beatport_id,
        NULL AS beatport_genre,
        NULL AS beatport_subgenre,
        NULL AS beatport_label,
        NULL AS beatport_bpm,
        NULL AS beatport_key,
        NULL AS beatport_release_date,
        NULL AS beatport_duration_ms,
        m.completeness_score
      FROM local_library_file m
      LEFT JOIN local_library_identity_link l ON l.local_file_id = m.id
      LEFT JOIN track_identity ti ON ti.id = l.track_identity_id
      WHERE m.status = 'processed'
        AND COALESCE(m.file_path, '') <> ''
        AND COALESCE(m.file_hash, '') <> ''
        AND COALESCE(m.beatport_id, '') = ''
        AND NOT EXISTS (
          SELECT 1
          FROM track_sonic_profile existing
          WHERE existing.model = ?
            AND existing.model_version = ?
            AND existing.source_sha256 = m.file_hash
        )
        AND (? = 0 OR EXISTS (
          SELECT 1 FROM taste_feedback f WHERE f.track_identity_id = l.track_identity_id
        ))
      ORDER BY m.id ASC
    `).all(model, modelVersion, feedbackOnly ? 1 : 0);
    return rows.slice(offset, offset + limit);
  }
  const rows = db.prepare(`
    SELECT * FROM (
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
      l.track_identity_id,
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
      be.duration_ms AS beatport_duration_ms,
      ROW_NUMBER() OVER (
        PARTITION BY TRIM(m.beatport_id)
        ORDER BY CASE
          WHEN l.link_status = 'EXACT' THEN 0
          WHEN l.link_status = 'HIGH_CONFIDENCE' THEN 1
          WHEN l.link_status IS NULL THEN 2
          ELSE 3
        END, m.id ASC
      ) AS beatport_rank
    FROM local_library_file m
    LEFT JOIN local_library_identity_link l ON l.local_file_id = m.id
    LEFT JOIN track_identity ti ON ti.id = l.track_identity_id
    LEFT JOIN beatport_enrichment be ON be.track_identity_id = ti.id
    WHERE m.status = 'processed'
      AND COALESCE(m.beatport_id, '') <> ''
      AND (l.local_file_id IS NULL OR l.link_status IN ('EXACT', 'HIGH_CONFIDENCE'))
      AND NOT EXISTS (
        SELECT 1
        FROM track_sonic_profile existing
        WHERE existing.model = ?
          AND existing.model_version = ?
          AND (
            CAST(json_extract(existing.metadata_json, '$.beatportId') AS TEXT) = TRIM(m.beatport_id)
            OR existing.identity_key = CASE
              WHEN COALESCE(ti.identity_key, '') <> '' THEN ti.identity_key
              ELSE 'beatport:' || TRIM(m.beatport_id)
            END
          )
      )
      AND (? = 0 OR EXISTS (
        SELECT 1 FROM taste_feedback f WHERE f.track_identity_id = l.track_identity_id
      ))
    ) WHERE beatport_rank = 1
    ORDER BY local_file_id ASC
  `).all(model, modelVersion, feedbackOnly ? 1 : 0);
  return rows.slice(offset, offset + limit);
}

function createEngine(args) {
  const essentia = {
    ...config.recommendationV2.essentia,
    device: args.device,
    modelVersion: args.modelVersion
  };
  return new RecommendationEngineV2({
    enabled: true,
    dbFile: args.dbFile,
    embeddingProvider: "discogs-effnet",
    embeddingModelVersion: args.modelVersion,
    embeddingTimeoutMs: config.recommendationV2.embeddingTimeoutMs,
    ffmpegPath: config.recommendationV2.ffmpegPath,
    essentia,
    logger: console
  });
}

function resultBase(row, args) {
  return {
    localFileId: Number(row.local_file_id),
    filePath: row.file_path,
    artist: cleanText(row.identity_artist || row.local_artist),
    title: cleanText(row.identity_title || row.local_title),
    beatportId: cleanText(row.enriched_beatport_id || row.beatport_id),
    identityKey: trackFromRow(row, args).identityKey,
    genre: cleanText(row.beatport_genre || row.genre),
    linkStatus: cleanText(row.link_status),
    linkConfidence: Number(row.link_confidence || 0),
    beatportConfidence: Number(row.beatport_confidence || 0),
    provider: "discogs-effnet",
    modelVersion: args.modelVersion,
    device: args.device
  };
}

function preparePcmManifest(rows, args, tempDir) {
  const manifest = [];
  const prepared = new Map();
  const failures = [];
  const sampleRate = Number(config.recommendationV2.essentia.sampleRate || 16000);
  for (const row of rows) {
    const base = resultBase(row, args);
    const filePath = path.resolve(row.file_path);
    if (!fs.existsSync(filePath)) {
      failures.push({ ...base, error: "file-not-found" });
      continue;
    }
    try {
      const sourceSha256 = sha256File(filePath);
      const decodeStartedAt = process.hrtime.bigint();
      const decoded = decodeAudio(filePath, {
        ffmpegPath: config.recommendationV2.ffmpegPath,
        sampleRate,
        maxSeconds: config.recommendationV2.essentia.maxSeconds || 900
      });
      const ffmpegDecodeMs = round(elapsedMilliseconds(decodeStartedAt));
      const id = String(row.local_file_id);
      const pcmPath = path.join(tempDir, `${id}.f32`);
      const samples = Float32Array.from(decoded.samples);
      fs.writeFileSync(pcmPath, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
      manifest.push({ id, pcmPath: toWslPath(pcmPath), audioDurationMs: decoded.durationMs });
      prepared.set(id, { row, filePath, sourceSha256, ffmpegDecodeMs, audioDurationMs: decoded.durationMs });
      console.log(`[sonic-linked-local] prepared ${manifest.length}/${rows.length} ${base.artist} - ${base.title}`);
    } catch (error) {
      failures.push({ ...base, error: `pcm-prepare-failed: ${error.message}` });
    }
  }
  return { manifest, prepared, failures };
}

function persistWarmBatch(engine, args, prepared, worker, failures) {
  const results = [];
  const byId = new Map(worker.items.map((item) => [String(item.id), item]));
  const expectedDimensions = Number(config.recommendationV2.essentia.expectedDimensions || 1280);
  for (const [id, item] of prepared.entries()) {
    const row = item.row;
    const base = resultBase(row, args);
    const workerItem = byId.get(id);
    if (!workerItem) {
      failures.push({ ...base, error: "warm-worker-missing-result" });
      continue;
    }
    if (workerItem.error) {
      failures.push({ ...base, error: `embedding-failed: ${workerItem.error}` });
      continue;
    }
    if (!Array.isArray(workerItem.vector) || Number(workerItem.dimensions) !== expectedDimensions || workerItem.vector.length !== expectedDimensions) {
      failures.push({
        ...base,
        error: `embedding-invalid: expected ${expectedDimensions} dimensions, received ${workerItem.dimensions || workerItem.vector?.length || 0}`
      });
      continue;
    }
    try {
      const track = trackFromRow(row, args);
      const embeddingMs = Number(workerItem.embeddingMs || 0);
      const timings = {
        ffmpegDecodeMs: item.ffmpegDecodeMs,
        embeddingMs: round(embeddingMs),
        totalAnalysisMs: round(Number(item.ffmpegDecodeMs || 0) + embeddingMs),
        execution: "warm-batch",
        workerProcessMs: worker.processMs
      };
      const result = engine.storeExtraction({
        track,
        identityKey: track.identityKey,
        extraction: {
          vector: workerItem.vector,
          model: "discogs-effnet",
          modelVersion: args.modelVersion,
          sampleRate: Number(config.recommendationV2.essentia.sampleRate || 16000),
          audioDurationMs: Number(workerItem.audioDurationMs || item.audioDurationMs || 0) || null,
          metadata: {
            ...sourceMetadata(row, args),
            device: worker.device || args.device,
            batchExecution: "warm-worker",
            modelName: cleanText(config.recommendationV2.essentia.modelName),
            output: cleanText(config.recommendationV2.essentia.output),
            outputShape: workerItem.outputShape || null,
            normAfterL2: workerItem.normAfterL2 || null,
            workerPeakRssMb: workerItem.workerPeakRssMb || worker.workerPeakRssMb || null
          }
        },
        sourcePath: item.filePath,
        sourceSha256: item.sourceSha256,
        metadata: sourceMetadata(row, args),
        sourceType: args.source === "local-file" ? "local-file" : "local-file-beatport-backed",
        timings
      });
      results.push({ ...base, ...result, timings });
      console.log(JSON.stringify({ ok: true, ...base, cached: false, execution: "warm-batch", timings }));
    } catch (error) {
      failures.push({ ...base, error: `storage-failed: ${error.message}` });
    }
  }
  return results;
}

function summarizeRunTimings(results, elapsedMs) {
  const values = (field) => results
    .map((result) => Number(result.timings?.[field]))
    .filter(Number.isFinite);
  const average = (field) => {
    const items = values(field);
    return items.length ? round(items.reduce((sum, value) => sum + value, 0) / items.length) : null;
  };
  return {
    runElapsedMs: round(elapsedMs),
    averageFfmpegDecodeMs: average("ffmpegDecodeMs"),
    averageEmbeddingMs: average("embeddingMs"),
    averageTotalAnalysisMs: average("totalAnalysisMs"),
    successfulTracksPerMinute: elapsedMs > 0 ? round((results.length * 60_000) / elapsedMs, 2) : null
  };
}

function analyzeWarmBatch(rows, args, engine) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-sonic-linked-local-"));
  try {
    const prepared = preparePcmManifest(rows, args, tempDir);
    if (!prepared.manifest.length) return { results: [], failures: prepared.failures, worker: null };
    const manifestPath = path.join(tempDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(prepared.manifest, null, 2), "utf8");
    const worker = runEssentiaBatch({
      manifestPath,
      args,
      essentia: {
        ...config.recommendationV2.essentia,
        device: args.device,
        modelVersion: args.modelVersion
      }
    });
    const failures = [...prepared.failures];
    const results = persistWarmBatch(engine, args, prepared.prepared, worker, failures);
    return { results, failures, worker };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function trackFromRow(row, args = {}) {
  const sourceMode = cleanText(args.source).toLowerCase() || "beatport-backed";
  const beatportTrackId = cleanText(row.enriched_beatport_id || row.beatport_id);
  const identityKey = sourceMode === "local-file"
    ? (cleanText(row.file_hash) ? `file:${cleanText(row.file_hash)}` : "")
    : cleanText(row.identity_key)
      || (beatportTrackId ? `beatport:${beatportTrackId}` : "")
      || (cleanText(row.file_hash) ? `file:${cleanText(row.file_hash)}` : "");
  return {
    identityKey,
    artist: cleanText(sourceMode === "local-file" ? row.local_artist : (row.identity_artist || row.local_artist)),
    title: cleanText(sourceMode === "local-file" ? row.local_title : (row.identity_title || row.local_title)),
    album: cleanText(sourceMode === "local-file" ? row.local_album : (row.identity_album || row.local_album)),
    mixVersion: cleanText(sourceMode === "local-file" ? "" : row.identity_mix_version),
    tidalId: cleanText(row.tidal_id),
    isrc: cleanText(sourceMode === "local-file" ? row.local_isrc : (row.identity_isrc || row.local_isrc)),
    beatportTrackId: sourceMode === "local-file" ? "" : beatportTrackId,
    durationMs: Number(row.local_duration_ms || (sourceMode === "beatport-backed" ? row.beatport_duration_ms : 0) || 0) || null,
    filePath: cleanText(row.file_path)
  };
}

function sourceMetadata(row, args = {}) {
  const sourceMode = cleanText(args.source).toLowerCase() || "beatport-backed";
  const beatportId = cleanText(row.enriched_beatport_id || row.beatport_id);
  const identityKey = sourceMode === "local-file"
    ? (cleanText(row.file_hash) ? `file:${cleanText(row.file_hash)}` : "")
    : cleanText(row.identity_key) || (beatportId ? `beatport:${beatportId}` : "");
  if (sourceMode === "local-file") {
    return {
      localFileId: Number(row.local_file_id),
      sourceAudioType: "local-file",
      sourceMatchType: "LOCAL_FILE_METADATA_BACKED",
      sourceMatchConfidence: Number(row.completeness_score || 0),
      sonicProxyFor: identityKey,
      localFileHash: cleanText(row.file_hash),
      localFileGenre: cleanText(row.genre),
      localFileSubgenre: cleanText(row.subgenre),
      localFileLabel: cleanText(row.label),
      localFileBpm: Number(row.bpm || 0) || null,
      localFileKey: cleanText(row.key_name),
      localFileYear: Number(row.year || 0) || null,
      analysisSource: "local-library-file"
    };
  }
  return {
    localFileId: Number(row.local_file_id),
    beatportId,
    beatportGenre: cleanText(row.beatport_genre || row.genre),
    beatportSubgenre: cleanText(row.beatport_subgenre || row.subgenre),
    beatportLabel: cleanText(row.beatport_label || row.label),
    beatportBpm: Number(row.beatport_bpm || row.bpm || 0) || null,
    beatportKey: cleanText(row.beatport_key || row.key_name),
    beatportReleaseDate: cleanText(row.beatport_release_date),
    sourceAudioType: "local-file",
    sourceMatchType: "BEATPORT_BACKED_LOCAL_FILE",
    sourceMatchConfidence: Number(row.beatport_confidence || row.link_confidence || 0),
    sonicProxyFor: identityKey,
    localFileHash: cleanText(row.file_hash),
    previewSource: "beatport-metadata-backed-local-audio"
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const lockName = args.source === "local-file" ? "sonic-local-file.lock" : "sonic-linked-local.lock";
  const lock = acquireProcessLock(path.join(__dirname, "..", "data", lockName), "Local-library sonic analysis");
  process.once("exit", () => lock.release());

  const memory = new MusicMemoryStore({ ...config.musicMemory, dbFile: args.dbFile, logger: console });
  if (!memory.db) throw new Error("Rabbit Hole music-memory database could not be opened.");
  let rows;
  try {
    rows = readEligibleRows(memory.db, args);
  } finally {
    memory.close();
  }
  if (!rows.length) throw new Error(args.source === "local-file"
    ? "No unprofiled local-file library rows are available in the selected range."
    : "No safe Beatport-backed local-library rows are available in the selected range.");

  const engine = createEngine(args);
  const essentia = {
    ...config.recommendationV2.essentia,
    device: args.device,
    modelVersion: args.modelVersion
  };
  const shouldBatch = args.execution === "batch"
    || (args.execution === "auto" && batchExecutionSupported(essentia));
  if (args.execution === "batch" && !batchExecutionSupported(essentia)) {
    throw new Error("Warm Essentia batch execution is not configured. Set RABBIT_HOLE_SONIC_ESSENTIA_BATCH_WSL_WRAPPER and use the standard wsl.exe launcher.");
  }

  const runStartedAt = process.hrtime.bigint();
  let results = [];
  let failures = [];
  let executionMode = shouldBatch ? "warm-batch" : "serial";
  let worker = null;
  if (shouldBatch) {
    try {
      const batch = analyzeWarmBatch(rows, args, engine);
      results = batch.results;
      failures = batch.failures;
      worker = batch.worker;
    } catch (error) {
      if (args.execution === "batch") throw error;
      // Auto mode is allowed to fall back when the warm worker is unavailable;
      // this preserves the old resumable path on machines without WSL/CUDA.
      console.error(`[sonic-linked-local] warm batch unavailable; falling back to serial analysis: ${error.message}`);
      executionMode = "serial";
    }
  }
  if (executionMode === "serial") {
    for (const row of rows) {
      const filePath = path.resolve(row.file_path);
      const selectedTrack = trackFromRow(row, args);
      const base = resultBase(row, args);
      if (!fs.existsSync(filePath)) {
        failures.push({ ...base, error: "file-not-found" });
        continue;
      }
      try {
        const result = engine.analyzeFile(filePath, selectedTrack, {
          sourceType: args.source === "local-file" ? "local-file" : "local-file-beatport-backed",
          metadata: sourceMetadata(row, args)
        });
        results.push({ ...base, ...result });
        console.log(JSON.stringify({ ok: true, ...base, cached: Boolean(result.cached), execution: "serial", timings: result.timings || null }));
      } catch (error) {
        failures.push({ ...base, error: error.message });
        console.error(JSON.stringify({ ok: false, ...base, error: error.message }));
      }
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: args.source === "local-file"
      ? (args.feedbackOnly ? "bounded-feedback-local-file-library" : "bounded-local-file-library")
      : (args.feedbackOnly ? "bounded-feedback-beatport-backed-local-library" : "bounded-beatport-backed-local-library"),
    options: {
      dbFile: args.dbFile,
      limit: args.limit,
      offset: args.offset,
      source: args.source,
      feedbackOnly: args.feedbackOnly,
      execution: args.execution,
      executionMode,
      device: args.device,
      provider: "discogs-effnet",
      modelVersion: args.modelVersion,
      modelName: cleanText(config.recommendationV2.essentia.modelName),
      expectedDimensions: Number(config.recommendationV2.essentia.expectedDimensions || 1280),
      sampleRate: Number(config.recommendationV2.essentia.sampleRate || 16000)
    },
    selection: {
      eligibleRowsSelected: rows.length,
      distinctBeatportIdsSelected: args.source === "local-file"
        ? 0
        : new Set(rows.map((row) => cleanText(row.enriched_beatport_id || row.beatport_id)).filter(Boolean)).size,
      distinctLocalFilesSelected: rows.length,
      analyzed: results.length,
      failed: failures.length
    },
    results,
    failures,
    timing: summarizeRunTimings(results, elapsedMilliseconds(runStartedAt)),
    worker: worker ? {
      device: worker.device,
      modelReadyMs: worker.modelReadyMs,
      processMs: worker.processMs,
      workerPeakRssMb: worker.workerPeakRssMb,
      failedCount: worker.failedCount || 0
    } : null,
    storage: engine.store.status(),
    provider: engine.provider.status()
  };
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    selection: output.selection,
    execution: { requested: args.execution, mode: executionMode, worker: output.worker },
    report: args.report,
    storage: output.storage,
    provider: output.provider
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  batchExecutionSupported,
  cleanText,
  createEngine,
  parseJsonOutput,
  main,
  preparePcmManifest,
  parseArgs,
  printHelp,
  resultBase,
  readEligibleRows,
  runEssentiaBatch,
  sourceMetadata,
  trackFromRow
};
