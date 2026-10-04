"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const config = require("../src/config");
const { BeatportClient } = require("../src/beatportClient");
const { decodeAudioBuffer } = require("../src/sonicEmbeddingEngine");

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

function toWslPath(value) {
  const input = cleanText(value);
  const absolute = input && !path.isAbsolute(input) && !input.startsWith("/") ? path.resolve(input) : input;
  const match = absolute.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return absolute;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
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
    pools.push({ ...spec, tracks: result.tracks.filter((track) => track.id && track.previewUrl) });
  }
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

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* try the next line */ }
    }
  }
  throw new Error("The Essentia batch worker did not return valid JSON.");
}

function summarize(items, field) {
  const values = items.map((item) => Number(item[field])).filter(Number.isFinite);
  return {
    count: values.length,
    averageMs: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    minMs: values.length ? round(Math.min(...values)) : null,
    maxMs: values.length ? round(Math.max(...values)) : null
  };
}

function summarizeEmbedding(items) {
  const all = summarize(items, "embeddingMs");
  const steadyState = summarize(items.slice(1), "embeddingMs");
  return {
    ...all,
    firstTrackMs: items.length ? items[0].embeddingMs : null,
    steadyStateExcludingFirst: steadyState
  };
}

function runBatch({ wrapperPath, manifestPath, venv, device, modelPath }) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.platform === "win32" ? "wsl.exe" : "env", [
    "env",
    `RABBIT_HOLE_SONIC_ESSENTIA_DEVICE=${device}`,
    `RABBIT_HOLE_SONIC_ESSENTIA_VENV=${venv}`,
    `RABBIT_HOLE_SONIC_ESSENTIA_MODEL_PATH=${modelPath}`,
    "bash",
    toWslPath(wrapperPath),
    toWslPath(manifestPath)
  ], {
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw new Error(`Essentia ${device} batch worker failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Essentia ${device} batch worker exited with ${result.status}: ${cleanText(result.stderr)}`);
  return { ...parseJsonOutput(result.stdout), processMs: round(elapsedMilliseconds(startedAt)) };
}

async function main() {
  const input = argsFrom(process.argv.slice(2));
  if (input.help) {
    console.log("node scripts/sonic-beatport-warm-benchmark.js [--limit 20] [--output .codex-verify/sonic-beatport-warm-benchmark.json] [--cpu-venv PATH] [--gpu-venv PATH] [--model-path PATH]");
    return;
  }
  const cpuVenv = cleanText(input["cpu-venv"] || process.env.RABBIT_HOLE_SONIC_CPU_VENV) ||
    (process.platform === "win32" ? "" : path.join(os.homedir(), "rabbit-hole-sonic-venv"));
  const gpuVenv = cleanText(input["gpu-venv"] || process.env.RABBIT_HOLE_SONIC_GPU_VENV) ||
    (process.platform === "win32" ? "" : path.join(os.homedir(), "micromamba-root", "envs", "rabbit-hole-effnet-gpu"));
  if (!gpuVenv) throw new Error("Set --gpu-venv or RABBIT_HOLE_SONIC_GPU_VENV to your WSL Essentia environment before running this benchmark.");
  const limit = Math.max(20, Math.min(100, Number(input.limit) || 20));
  const querySpecs = parseQuerySpecs(input.queries || "D-Nox|Progressive House,Alix Perez|Wubs & Dubs,Chris Lorenzo|Tech House,Astrix|Psytrance");
  const outputPath = path.resolve(input.output || path.join(".codex-verify", "sonic-beatport-warm-benchmark.json"));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const beatport = new BeatportClient({ ...config.beatport, logger: console });
  if (!beatport.isConfigured()) throw new Error("Beatport is not configured. Enable Beatport and provide an OAuth access or refresh token.");
  const tracks = await collectTracks(beatport, querySpecs, limit);
  if (tracks.length < limit) throw new Error(`Only ${tracks.length} Beatport previews were found; benchmark requires at least ${limit}.`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-sonic-warm-"));
  try {
    const rows = [];
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const downloadStartedAt = process.hrtime.bigint();
      const streamed = await beatport.fetchPreviewBuffer(track);
      const previewDownloadMs = elapsedMilliseconds(downloadStartedAt);
      const decodeStartedAt = process.hrtime.bigint();
      const decoded = decodeAudioBuffer(streamed.buffer, {
        ffmpegPath: config.recommendationV2.ffmpegPath,
        sampleRate: 16000,
        maxSeconds: 900
      });
      const ffmpegDecodeMs = elapsedMilliseconds(decodeStartedAt);
      const pcmPath = path.join(tempDir, `${String(index + 1).padStart(3, "0")}-${track.id}.f32`);
      const samples = Float32Array.from(decoded.samples);
      fs.writeFileSync(pcmPath, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
      rows.push({
        id: String(track.id),
        artist: track.artist,
        title: track.title,
        benchmarkGroup: track.benchmarkGroup,
        benchmarkQuery: track.benchmarkQuery,
        previewDownloadMs: round(previewDownloadMs),
        ffmpegDecodeMs: round(ffmpegDecodeMs),
        audioDurationMs: decoded.durationMs,
        pcmPath: toWslPath(pcmPath)
      });
      if (streamed.buffer?.fill) streamed.buffer.fill(0);
      console.log(`[sonic-warm-benchmark] prepared ${index + 1}/${tracks.length} ${track.artist} - ${track.title}`);
    }
    const manifestPath = path.join(tempDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(rows, null, 2), "utf8");
    const wrapperPath = path.join(__dirname, "sonic-essentia-batch-wsl.sh");
    const modelPath = cleanText(input["model-path"] || process.env.RABBIT_HOLE_SONIC_ESSENTIA_MODEL_PATH) ||
      (process.platform === "win32" ? "" : path.join(os.homedir(), "rabbit-hole-sonic-models", "discogs_track_embeddings-effnet-bs64-1.pb"));
    const cpu = runBatch({
      wrapperPath,
      manifestPath,
      venv: cpuVenv,
      device: "cpu",
      modelPath
    });
    const gpu = runBatch({
      wrapperPath,
      manifestPath,
      venv: gpuVenv,
      device: "cuda",
      modelPath
    });

    const timing = (batch) => {
      const byId = new Map(batch.items.map((item) => [String(item.id), item]));
      const items = rows.map((row) => ({
        ...row,
        embeddingMs: byId.get(row.id)?.embeddingMs ?? null,
        workerPeakRssMb: byId.get(row.id)?.workerPeakRssMb ?? null,
        dimensions: byId.get(row.id)?.dimensions ?? null,
        normAfterL2: byId.get(row.id)?.normAfterL2 ?? null
      }));
      const download = summarize(items, "previewDownloadMs");
      const decode = summarize(items, "ffmpegDecodeMs");
      const embedding = summarize(items, "embeddingMs");
      return {
        device: batch.device,
        modelReadyMs: batch.modelReadyMs,
        processMs: batch.processMs,
        processOverheadMs: round(batch.processMs - batch.modelReadyMs - items.reduce((sum, item) => sum + Number(item.embeddingMs || 0), 0)),
        workerPeakRssMb: batch.workerPeakRssMb,
        previewDownloadMs: download,
        ffmpegDecodeMs: decode,
        embeddingMs: summarizeEmbedding(items),
        totalPerTrackWarmMs: round(download.averageMs + decode.averageMs + embedding.averageMs),
        items
      };
    };
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      trackCount: rows.length,
      querySpecs,
      model: {
        name: "discogs_track_embeddings-effnet-bs64-1",
        family: "Discogs-EffNet",
        output: "PartitionedCall:1",
        outputPurpose: "embeddings",
        dimensions: 1280,
        sampleRate: 16000,
        input: "mono float32 PCM",
        normalization: "L2 after mean over output patches"
      },
      environment: { platform: process.platform, node: process.version, hostRssMb: round(process.memoryUsage().rss / 1024 / 1024) },
      comparison: { cpu: timing(cpu), gpu: timing(gpu) },
      tracks: rows.map(({ pcmPath, ...row }) => row)
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: outputPath,
      trackCount: report.trackCount,
      cpu: {
        modelReadyMs: report.comparison.cpu.modelReadyMs,
        processMs: report.comparison.cpu.processMs,
        embeddingMs: report.comparison.cpu.embeddingMs.averageMs,
        totalPerTrackWarmMs: report.comparison.cpu.totalPerTrackWarmMs,
        workerPeakRssMb: report.comparison.cpu.workerPeakRssMb
      },
      gpu: {
        modelReadyMs: report.comparison.gpu.modelReadyMs,
        processMs: report.comparison.gpu.processMs,
        embeddingMs: report.comparison.gpu.embeddingMs.averageMs,
        totalPerTrackWarmMs: report.comparison.gpu.totalPerTrackWarmMs,
        workerPeakRssMb: report.comparison.gpu.workerPeakRssMb
      }
    }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
