"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  SonicEmbeddingStore,
  identityKeyFor,
  normalizeVector
} = require("./sonicEmbeddingStore");

const DEFAULT_MODEL = "spectral-baseline";
const DEFAULT_MODEL_VERSION = "1";
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_HOP_SIZE = 2048;
const DEFAULT_DISCOGS_EFFNET_MODEL = "discogs_track_embeddings-effnet-bs64-1";
const DEFAULT_DISCOGS_EFFNET_OUTPUT = "PartitionedCall:1";
const DEFAULT_DISCOGS_EFFNET_DIMENSIONS = 1280;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolveFilePath(filePath) {
  // Paths are not metadata: collapsing internal whitespace can turn a valid
  // Windows filename such as "Track  (Mixed).flac" into a different file.
  const value = String(filePath || "").trim();
  if (!value) throw new Error("An audio file path is required.");
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`Audio file was not found: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`Audio path is not a file: ${resolved}`);
  return resolved;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function sha256Buffer(value) {
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.from(value));
  return hash.digest("hex");
}

function elapsedMilliseconds(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function toWslPath(value) {
  const input = cleanText(value);
  const text = input && !path.isAbsolute(input) && !input.startsWith("/") ? path.resolve(input) : input;
  const match = text.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return text;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function chooseFfmpegPath(value = "") {
  const requested = cleanText(value || process.env.FFMPEG_PATH);
  if (requested) return requested;
  const candidates = [
    path.join(process.env.ProgramFiles || "", "ffmpeg", "bin", "ffmpeg.exe"),
    "C:\\ffmpeg\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "ffmpeg";
}

function decodeAudioSource(source, { ffmpegPath = "", sampleRate = DEFAULT_SAMPLE_RATE, maxSeconds = 900 } = {}) {
  const isBuffer = Buffer.isBuffer(source) || source instanceof Uint8Array;
  const resolved = isBuffer ? "transient audio stream" : resolveFilePath(source);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", isBuffer ? "pipe:0" : resolved,
    "-t", String(Math.max(1, Number(maxSeconds) || 900)),
    "-vn",
    "-ac", "1",
    "-ar", String(sampleRate),
    "-f", "f32le",
    "pipe:1"
  ];
  const spawnOptions = {
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true
  };
  if (isBuffer) spawnOptions.input = Buffer.from(source);
  const result = spawnSync(chooseFfmpegPath(ffmpegPath), args, spawnOptions);
  if (result.error) throw new Error(`FFmpeg could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = cleanText(result.stderr?.toString("utf8"));
    throw new Error(`FFmpeg could not decode ${resolved}${detail ? `: ${detail}` : "."}`);
  }
  if (!result.stdout?.length || result.stdout.length < 4) throw new Error(`FFmpeg returned no PCM audio for ${resolved}.`);
  const samples = new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
  return {
    samples: Array.from(samples),
    sampleRate,
    durationMs: Math.round((samples.length / sampleRate) * 1000)
  };
}

function decodeAudio(filePath, options = {}) {
  return decodeAudioSource(resolveFilePath(filePath), options);
}

function decodeAudioBuffer(audioBuffer, options = {}) {
  if (!(Buffer.isBuffer(audioBuffer) || audioBuffer instanceof Uint8Array) || !audioBuffer.length) {
    throw new Error("A non-empty audio buffer is required.");
  }
  return decodeAudioSource(audioBuffer, options);
}

function makeWindow(size) {
  return Array.from({ length: size }, (_, index) => 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (size - 1))));
}

function fftMagnitudes(input, window) {
  const size = input.length;
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let index = 0; index < size; index += 1) real[index] = input[index] * window[index];

  for (let index = 1, reverseIndex = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (reverseIndex & bit) {
      reverseIndex ^= bit;
      bit >>= 1;
    }
    reverseIndex ^= bit;
    if (index < reverseIndex) {
      const swapReal = real[index];
      real[index] = real[reverseIndex];
      real[reverseIndex] = swapReal;
      const swapImag = imag[index];
      imag[index] = imag[reverseIndex];
      imag[reverseIndex] = swapImag;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let currentReal = 1;
      let currentImag = 0;
      const half = length >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = (currentReal * real[odd]) - (currentImag * imag[odd]);
        const oddImag = (currentReal * imag[odd]) + (currentImag * real[odd]);
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = (currentReal * stepReal) - (currentImag * stepImag);
        currentImag = (currentReal * stepImag) + (currentImag * stepReal);
        currentReal = nextReal;
      }
    }
  }
  return Array.from({ length: size >> 1 }, (_, index) => Math.sqrt(real[index] ** 2 + imag[index] ** 2));
}

function meanAndVariance(values) {
  if (!values.length) return [0, 0];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return [mean, variance];
}

function logBandEdges(binCount, bandCount) {
  const edges = [];
  const minBin = 1;
  for (let index = 0; index <= bandCount; index += 1) {
    const normalized = index / bandCount;
    edges.push(Math.max(minBin, Math.min(binCount - 1, Math.floor(minBin * ((binCount - 1) / minBin) ** normalized))));
  }
  return edges;
}

function spectralBaselineEmbedding(samples, sampleRate, {
  fftSize = DEFAULT_FFT_SIZE,
  hopSize = DEFAULT_HOP_SIZE,
  bandCount = 32
} = {}) {
  if (!Array.isArray(samples) || samples.length < fftSize) throw new Error("Audio is shorter than the embedding analysis window.");
  const window = makeWindow(fftSize);
  const edges = logBandEdges(fftSize >> 1, bandCount);
  const bands = Array.from({ length: bandCount }, () => []);
  const scalars = Array.from({ length: 8 }, () => []);
  const frame = new Array(fftSize).fill(0);
  const maxFrames = Math.max(1, Math.floor((samples.length - fftSize) / hopSize) + 1);
  const stride = Math.max(1, Math.ceil(maxFrames / 240));

  for (let start = 0; start + fftSize <= samples.length; start += hopSize * stride) {
    let energy = 0;
    let peak = 0;
    let crossings = 0;
    for (let index = 0; index < fftSize; index += 1) {
      const value = Number(samples[start + index]) || 0;
      frame[index] = value;
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
      if (index > 0 && ((samples[start + index - 1] < 0) !== (value < 0))) crossings += 1;
    }
    const magnitudes = fftMagnitudes(frame, window);
    let totalPower = 0;
    let weightedFrequency = 0;
    for (let index = 1; index < magnitudes.length; index += 1) {
      const power = magnitudes[index] ** 2;
      totalPower += power;
      weightedFrequency += power * ((index * sampleRate) / fftSize);
    }
    const centroid = totalPower > 0 ? weightedFrequency / totalPower : 0;
    let cumulative = 0;
    let rolloff = 0;
    for (let index = 1; index < magnitudes.length; index += 1) {
      cumulative += magnitudes[index] ** 2;
      if (cumulative >= totalPower * 0.85) {
        rolloff = (index * sampleRate) / fftSize;
        break;
      }
    }
    const logPowers = [];
    for (let band = 0; band < bandCount; band += 1) {
      const from = edges[band];
      const to = Math.max(from + 1, edges[band + 1]);
      let power = 0;
      let count = 0;
      for (let index = from; index < to && index < magnitudes.length; index += 1) {
        power += magnitudes[index] ** 2;
        count += 1;
      }
      const value = Math.log1p(power / Math.max(1, count));
      bands[band].push(value);
      logPowers.push(value);
    }
    const geometric = logPowers.reduce((sum, value) => sum + value, 0) / Math.max(1, logPowers.length);
    const arithmetic = Math.log1p(logPowers.reduce((sum, value) => sum + Math.expm1(value), 0) / Math.max(1, logPowers.length));
    scalars[0].push(Math.log1p(energy / fftSize));
    scalars[1].push(peak);
    scalars[2].push(crossings / fftSize);
    scalars[3].push(centroid / sampleRate);
    scalars[4].push(rolloff / sampleRate);
    scalars[5].push(geometric);
    scalars[6].push(arithmetic);
    scalars[7].push(peak / Math.max(1e-9, Math.sqrt(energy / Math.max(1, fftSize))));
  }

  const vector = [];
  for (const band of bands) vector.push(...meanAndVariance(band));
  for (const scalar of scalars) vector.push(...meanAndVariance(scalar));
  return normalizeVector(vector);
}

class SpectralBaselineProvider {
  constructor({ ffmpegPath = "", sampleRate = DEFAULT_SAMPLE_RATE, maxSeconds = 900, fftSize = DEFAULT_FFT_SIZE, hopSize = DEFAULT_HOP_SIZE } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.sampleRate = sampleRate;
    this.maxSeconds = maxSeconds;
    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.name = DEFAULT_MODEL;
    this.modelVersion = DEFAULT_MODEL_VERSION;
  }

  status() {
    return {
      available: true,
      provider: this.name,
      model: this.name,
      modelVersion: this.modelVersion,
      note: "Deterministic spectral baseline for the Windows POC; not a neural audio embedding."
    };
  }

  extract(filePath) {
    const audio = decodeAudio(filePath, {
      ffmpegPath: this.ffmpegPath,
      sampleRate: this.sampleRate,
      maxSeconds: this.maxSeconds
    });
    return this.extractSamples(audio.samples, audio.sampleRate, { audioDurationMs: audio.durationMs });
  }

  extractSamples(samples, sampleRate = this.sampleRate, { audioDurationMs = null, metadata = {} } = {}) {
    return {
      vector: spectralBaselineEmbedding(samples, sampleRate, {
        fftSize: this.fftSize,
        hopSize: this.hopSize
      }),
      model: this.name,
      modelVersion: this.modelVersion,
      sampleRate,
      audioDurationMs,
      metadata: {
        provider: this.name,
        analysis: "windowed mono FFT spectral statistics",
        fftSize: this.fftSize,
        hopSize: this.hopSize,
        ...metadata
      }
    };
  }

  extractBuffer(audioBuffer) {
    const audio = decodeAudioBuffer(audioBuffer, {
      ffmpegPath: this.ffmpegPath,
      sampleRate: this.sampleRate,
      maxSeconds: this.maxSeconds
    });
    return this.extractSamples(audio.samples, audio.sampleRate, {
      audioDurationMs: audio.durationMs,
      metadata: { sourceType: "transient-audio-buffer" }
    });
  }
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("The configured embedding command returned no JSON.");
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* try the next JSON line */ }
    }
  }
  throw new Error("The configured embedding command did not return valid JSON.");
}

class JsonCommandEmbeddingProvider {
  constructor({ command = "", args = [], model = "external-audio", modelVersion = "1", timeoutMs = 900_000 } = {}) {
    this.command = cleanText(command);
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.name = cleanText(model) || "external-audio";
    this.modelVersion = cleanText(modelVersion) || "1";
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 900_000);
  }

  status() {
    return {
      available: Boolean(this.command),
      provider: "external-json-command",
      model: this.name,
      modelVersion: this.modelVersion,
      commandConfigured: Boolean(this.command)
    };
  }

  extract(filePath) {
    if (!this.command) throw new Error("No external embedding command is configured.");
    const args = this.args.map((arg) => arg.replace(/\{\{file\}\}/g, filePath).replace(/\{\{model\}\}/g, this.name));
    const result = spawnSync(this.command, args.length ? args : [filePath], {
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) throw new Error(`Embedding command failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Embedding command exited with ${result.status}: ${cleanText(result.stderr)}`);
    const payload = parseJsonOutput(result.stdout);
    const vector = payload?.embedding || payload?.vector || payload;
    const normalized = normalizeVector(vector);
    if (!normalized.length) throw new Error("Embedding command returned no finite vector.");
    return {
      ...payload,
      vector: normalized,
      model: cleanText(payload?.model) || this.name,
      modelVersion: cleanText(payload?.modelVersion || payload?.model_version) || this.modelVersion
    };
  }
}

class EssentiaDiscogsEffNetProvider {
  constructor({
    command = "",
    args = [],
    workerPath = "",
    wslWrapperPath = "",
    modelPath = "",
    modelName = DEFAULT_DISCOGS_EFFNET_MODEL,
    modelVersion = "1",
    output = DEFAULT_DISCOGS_EFFNET_OUTPUT,
    expectedDimensions = DEFAULT_DISCOGS_EFFNET_DIMENSIONS,
    sampleRate = DEFAULT_SAMPLE_RATE,
    ffmpegPath = "",
    device = "cpu",
    venv = "",
    maxSeconds = 900,
    timeoutMs = 900_000
  } = {}) {
    this.command = cleanText(command);
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.workerPath = cleanText(workerPath);
    this.wslWrapperPath = cleanText(wslWrapperPath);
    this.modelPath = cleanText(modelPath);
    this.name = "discogs-effnet";
    this.modelName = cleanText(modelName) || DEFAULT_DISCOGS_EFFNET_MODEL;
    this.modelVersion = cleanText(modelVersion) || "1";
    this.output = cleanText(output) || DEFAULT_DISCOGS_EFFNET_OUTPUT;
    this.expectedDimensions = Math.max(1, Number(expectedDimensions) || DEFAULT_DISCOGS_EFFNET_DIMENSIONS);
    this.sampleRate = Math.max(1, Number(sampleRate) || DEFAULT_SAMPLE_RATE);
    this.ffmpegPath = cleanText(ffmpegPath);
    this.device = cleanText(device).toLowerCase() || "cpu";
    this.venv = cleanText(venv);
    this.maxSeconds = Math.max(1, Number(maxSeconds) || 900);
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 900_000);
  }

  status() {
    const autoWsl = /^wsl(?:\.exe)?$/i.test(path.basename(this.command)) && !this.args.length && !this.modelPath;
    return {
      available: Boolean(this.command && (this.args.length || (this.workerPath && this.modelPath) || (autoWsl && this.wslWrapperPath))),
      provider: this.name,
      model: this.modelName,
      modelVersion: this.modelVersion,
      dimensions: this.expectedDimensions,
      sampleRate: this.sampleRate,
      commandConfigured: Boolean(this.command),
      workerConfigured: Boolean(this.workerPath),
      modelConfigured: Boolean(this.modelPath),
      wslAutoConfigured: autoWsl,
      device: this.device,
      venvConfigured: Boolean(this.venv),
      output: this.output,
      note: "Essentia TensorflowPredictEffnetDiscogs contrastive track embedding; PartitionedCall:1 only."
    };
  }

  workerArgs() {
    const autoWsl = /^wsl(?:\.exe)?$/i.test(path.basename(this.command)) && !this.args.length && !this.modelPath;
    const defaults = this.args.length
      ? this.args
      : autoWsl
        ? [
            "env",
            `RABBIT_HOLE_SONIC_ESSENTIA_DEVICE=${this.device}`,
            ...(this.venv ? [`RABBIT_HOLE_SONIC_ESSENTIA_VENV=${this.venv}`] : []),
            "bash",
            toWslPath(this.wslWrapperPath)
          ]
        : [
            this.workerPath,
            "--pcm-stdin",
            "--model", this.modelPath,
            "--model-name", this.modelName,
            "--output", this.output,
            "--expected-dimensions", String(this.expectedDimensions),
            "--sample-rate", String(this.sampleRate)
          ];
    const replacements = {
      "{{worker}}": this.workerPath,
      "{{model}}": this.modelPath,
      "{{modelPath}}": this.modelPath,
      "{{modelName}}": this.modelName,
      "{{modelVersion}}": this.modelVersion,
      "{{output}}": this.output,
      "{{dimensions}}": String(this.expectedDimensions),
      "{{sampleRate}}": String(this.sampleRate),
      "{{inputMode}}": "pcm-stdin"
    };
    return defaults.map((arg) => Object.entries(replacements).reduce((value, [from, to]) => value.replaceAll(from, to), String(arg)));
  }

  extractSamples(samples, sampleRate = this.sampleRate, { audioDurationMs = null, metadata = {} } = {}) {
    if (!this.status().available) throw new Error("Essentia Discogs-EffNet is not configured. Set the learned provider command, worker, and model path.");
    if (Number(sampleRate) !== this.sampleRate) throw new Error(`Essentia Discogs-EffNet expects ${this.sampleRate} Hz PCM, received ${sampleRate} Hz.`);
    if (!Array.isArray(samples) && !(samples instanceof Float32Array) && !(samples instanceof Float64Array)) throw new Error("PCM samples are required for Essentia Discogs-EffNet.");
    const values = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    if (!values.length) throw new Error("Essentia Discogs-EffNet received no PCM samples.");
    const input = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const result = spawnSync(this.command, this.workerArgs(), {
      input,
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) throw new Error(`Essentia Discogs-EffNet worker failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Essentia Discogs-EffNet worker exited with ${result.status}: ${cleanText(result.stderr)}`);
    const payload = parseJsonOutput(result.stdout);
    const vector = normalizeVector(payload?.vector || payload?.embedding || payload);
    if (!vector.length) throw new Error("Essentia Discogs-EffNet returned no finite embedding.");
    if (vector.length !== this.expectedDimensions) throw new Error(`Essentia Discogs-EffNet returned ${vector.length} dimensions; expected ${this.expectedDimensions} from ${this.output}.`);
    return {
      ...payload,
      vector,
      model: this.name,
      modelVersion: this.modelVersion,
      sampleRate: this.sampleRate,
      audioDurationMs,
      metadata: {
        ...(payload.metadata || {}),
        ...metadata,
        provider: this.name,
        modelName: this.modelName,
        modelVersion: this.modelVersion,
        modelPath: this.modelPath || payload.metadata?.modelPath || "",
        output: this.output,
        outputPurpose: "embeddings",
        expectedDimensions: this.expectedDimensions,
        inputSampleRate: this.sampleRate,
        inputChannels: 1,
        inputType: "mono-float32-pcm",
        aggregation: "mean over Essentia output patches"
      }
    };
  }

  extractBuffer(audioBuffer) {
    const audio = decodeAudioBuffer(audioBuffer, {
      ffmpegPath: this.ffmpegPath,
      sampleRate: this.sampleRate,
      maxSeconds: this.maxSeconds
    });
    return this.extractSamples(audio.samples, audio.sampleRate, { audioDurationMs: audio.durationMs });
  }

  extract(filePath) {
    const audio = decodeAudio(filePath, {
      ffmpegPath: this.ffmpegPath,
      sampleRate: this.sampleRate,
      maxSeconds: this.maxSeconds
    });
    return this.extractSamples(audio.samples, audio.sampleRate, { audioDurationMs: audio.durationMs });
  }
}

class SonicEmbeddingEngine {
  constructor({ store = null, provider = null, logger = console, clock = Date.now } = {}) {
    this.store = store || new SonicEmbeddingStore();
    this.provider = provider || new SpectralBaselineProvider();
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : Date.now;
    this.backgroundExtractionActive = false;
  }

  status() {
    return {
      ...this.provider.status(),
      storage: this.store.status()
    };
  }

  storeExtraction({ track = {}, identityKey = "", extraction = {}, sourcePath = "", sourceSha256 = "", metadata = {}, sourceType = "", timings = null } = {}) {
    const resolvedIdentityKey = identityKey || identityKeyFor(track);
    if (!resolvedIdentityKey) throw new Error("A track identity is required before storing a sonic embedding.");
    const resolvedTrack = {
      ...track,
      durationMs: track.durationMs || extraction.audioDurationMs || null
    };
    const stored = this.store.upsertEmbedding({
      track: resolvedTrack,
      identityKey: resolvedIdentityKey,
      vector: extraction.vector,
      model: extraction.model,
      modelVersion: extraction.modelVersion,
      sourcePath,
      sourceSha256,
      sampleRate: extraction.sampleRate,
      audioDurationMs: extraction.audioDurationMs,
      metadata: {
        ...(extraction.metadata || {}),
        ...metadata,
        ...(sourceType ? { sourceType } : {})
      }
    });
    return {
      ok: true,
      identityKey: resolvedIdentityKey,
      track: stored.track,
      model: stored.model,
      modelVersion: stored.modelVersion,
      dimensions: stored.dimensions,
      sourcePath,
      sourceSha256,
      sampleRate: stored.sampleRate,
      audioDurationMs: stored.audioDurationMs,
      cached: false,
      ...(sourceType ? { sourceType } : {}),
      ...(timings ? { timings } : {})
    };
  }

  analyzeFile(filePath, track = {}, options = {}) {
    const resolved = resolveFilePath(filePath);
    const sourceSha256 = sha256File(resolved);
    const resolvedTrack = {
      ...track,
      sourcePath: resolved
    };
    const identityKey = identityKeyFor(resolvedTrack) || `file:${sourceSha256}`;
    const cached = options.force ? null : this.store.getEmbedding(identityKey, {
      model: this.provider.name,
      modelVersion: this.provider.modelVersion
    });
    if (cached && cached.sourceSha256 === sourceSha256) {
      if (options.sourceType || Object.keys(options.metadata || {}).length) {
        this.store.upsertEmbedding({
          track: resolvedTrack,
          identityKey,
          vector: cached.vector,
          model: cached.model,
          modelVersion: cached.modelVersion,
          sourcePath: resolved,
          sourceSha256,
          sampleRate: cached.sampleRate,
          audioDurationMs: cached.audioDurationMs,
          metadata: {
            ...(cached.track?.metadata || {}),
            ...(options.metadata || {}),
            ...(options.sourceType ? { sourceType: options.sourceType } : {})
          }
        });
      }
      return {
        ok: true,
        identityKey,
        track: cached.track,
        model: cached.model,
        modelVersion: cached.modelVersion,
        dimensions: cached.dimensions,
        sourcePath: resolved,
        sourceSha256,
        sampleRate: cached.sampleRate,
        audioDurationMs: cached.audioDurationMs,
        cached: true,
        ...(options.sourceType ? { sourceType: options.sourceType } : {})
      };
    }
    let extraction;
    let timings = null;
    if (typeof this.provider.extractSamples === "function") {
      const analysisStartedAt = process.hrtime.bigint();
      const decodeStartedAt = process.hrtime.bigint();
      const decoded = decodeAudio(resolved, {
        ffmpegPath: this.provider.ffmpegPath || "",
        sampleRate: this.provider.sampleRate || DEFAULT_SAMPLE_RATE,
        maxSeconds: this.provider.maxSeconds || 900
      });
      const decodeMs = elapsedMilliseconds(decodeStartedAt);
      const embeddingStartedAt = process.hrtime.bigint();
      extraction = this.provider.extractSamples(decoded.samples, decoded.sampleRate, {
        audioDurationMs: decoded.durationMs
      });
      const embeddingMs = elapsedMilliseconds(embeddingStartedAt);
      timings = {
        ffmpegDecodeMs: Math.round(decodeMs * 100) / 100,
        embeddingMs: Math.round(embeddingMs * 100) / 100,
        totalAnalysisMs: Math.round(elapsedMilliseconds(analysisStartedAt) * 100) / 100
      };
    } else if (typeof this.provider.extract === "function") {
      extraction = this.provider.extract(resolved);
    } else {
      throw new Error("The configured embedding provider does not support file or PCM analysis.");
    }
    return this.storeExtraction({
      track: resolvedTrack,
      identityKey,
      extraction,
      sourcePath: resolved,
      sourceSha256,
      metadata: options.metadata || {},
      sourceType: options.sourceType || "",
      ...(timings ? { timings } : {})
    });
  }

  analyzeSamples(samples, sampleRate, track = {}, { sourceSha256 = "", metadata = {} } = {}) {
    if (!Array.isArray(samples) && !(samples instanceof Float32Array) && !(samples instanceof Float64Array)) {
      throw new Error("Decoded audio samples are required.");
    }
    if (!Number.isFinite(Number(sampleRate)) || Number(sampleRate) <= 0) throw new Error("A valid audio sample rate is required.");
    if (typeof this.provider.extractSamples !== "function") {
      throw new Error("The configured embedding provider does not support in-memory audio analysis. Use the spectral baseline or configure a stream-capable worker.");
    }
    const identityKey = identityKeyFor(track) || (track.artist && track.title ? identityKeyFor({
      ...track,
      identityKey: `text:${String(track.artist).toLowerCase()}|${String(track.title).toLowerCase()}`
    }) : "");
    if (!identityKey) throw new Error("A track identity is required before storing a sonic embedding.");
    const extraction = this.provider.extractSamples(samples, Number(sampleRate), { metadata });
    return this.storeExtraction({
      track,
      identityKey,
      extraction,
      sourceSha256,
      metadata,
      sourceType: metadata.sourceType || "transient-audio-samples"
    });
  }

  analyzeBuffer(audioBuffer, track = {}, options = {}) {
    if (typeof this.provider.extractBuffer !== "function" && typeof this.provider.extractSamples !== "function") {
      throw new Error("The configured embedding provider does not support in-memory audio analysis. Use the spectral baseline or configure a stream-capable worker.");
    }
    if (!(Buffer.isBuffer(audioBuffer) || audioBuffer instanceof Uint8Array) || !audioBuffer.length) {
      throw new Error("A non-empty audio buffer is required.");
    }
    const sourceSha256 = options.sourceSha256 || sha256Buffer(audioBuffer);
    const identityKey = identityKeyFor(track);
    if (!identityKey) throw new Error("A track identity is required before storing a sonic embedding.");
    const cached = this.store.getEmbedding(identityKey, {
      model: this.provider.name,
      modelVersion: this.provider.modelVersion
    });
    if (cached && cached.sourceSha256 === sourceSha256) {
      return {
        ok: true,
        identityKey,
        track: cached.track,
        model: cached.model,
        modelVersion: cached.modelVersion,
        dimensions: cached.dimensions,
        sourcePath: "",
        sourceSha256,
        sampleRate: cached.sampleRate,
        audioDurationMs: cached.audioDurationMs,
        cached: true,
        sourceType: "transient-audio-buffer"
      };
    }
    const analysisStartedAt = process.hrtime.bigint();
    let extraction;
    let decoded = null;
    let decodeMs = 0;
    let learnedEmbeddingMs = 0;
    if (typeof this.provider.extractSamples === "function") {
      const decodeStartedAt = process.hrtime.bigint();
      decoded = decodeAudioBuffer(audioBuffer, {
        ffmpegPath: this.provider.ffmpegPath || "",
        sampleRate: this.provider.sampleRate || DEFAULT_SAMPLE_RATE,
        maxSeconds: this.provider.maxSeconds || 900
      });
      decodeMs = elapsedMilliseconds(decodeStartedAt);
      const embeddingStartedAt = process.hrtime.bigint();
      extraction = this.provider.extractSamples(decoded.samples, decoded.sampleRate, {
        audioDurationMs: decoded.durationMs,
        metadata: options.metadata || {}
      });
      learnedEmbeddingMs = elapsedMilliseconds(embeddingStartedAt);
    } else {
      const embeddingStartedAt = process.hrtime.bigint();
      extraction = this.provider.extractBuffer(audioBuffer);
      learnedEmbeddingMs = elapsedMilliseconds(embeddingStartedAt);
    }
    return this.storeExtraction({
      track,
      identityKey,
      extraction,
      sourceSha256,
      metadata: options.metadata || {},
      sourceType: options.sourceType || "transient-audio-buffer",
      timings: {
        ffmpegDecodeMs: Math.round(decodeMs * 100) / 100,
        embeddingMs: Math.round(learnedEmbeddingMs * 100) / 100,
        totalAnalysisMs: Math.round(elapsedMilliseconds(analysisStartedAt) * 100) / 100
      }
    });
  }

  async analyzeBufferAsync(audioBuffer, track = {}, options = {}) {
    if (!(this.provider instanceof EssentiaDiscogsEffNetProvider)) throw new Error("Background extraction requires the existing Discogs-EffNet provider.");
    if (!(Buffer.isBuffer(audioBuffer) || audioBuffer instanceof Uint8Array) || !audioBuffer.length) {
      throw new Error("A non-empty audio buffer is required.");
    }
    const sourceSha256 = options.sourceSha256 || sha256Buffer(audioBuffer);
    const identityKey = identityKeyFor(track);
    if (!identityKey) throw new Error("A track identity is required before storing a sonic embedding.");
    const cached = this.store.getEmbedding(identityKey, {
      model: this.provider.name, modelVersion: this.provider.modelVersion
    });
    if (cached && cached.sourceSha256 === sourceSha256) {
      return {
        ok: true, identityKey, track: cached.track, model: cached.model,
        modelVersion: cached.modelVersion, dimensions: cached.dimensions,
        sourcePath: "", sourceSha256, sampleRate: cached.sampleRate,
        audioDurationMs: cached.audioDurationMs, cached: true,
        sourceType: "transient-audio-buffer"
      };
    }
    if (this.backgroundExtractionActive) {
      throw Object.assign(new Error("A learned sonic extraction is already running. Retry after it finishes."), {
        code: "SONIC_RESOURCE_BUSY", statusCode: 503
      });
    }
    this.backgroundExtractionActive = true;
    try {
      const { Worker } = require("node:worker_threads");
      const message = await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "sonicExtractionWorker.js"), {
          workerData: { audio: audioBuffer, track, options, provider: { ...this.provider } }
        });
        let received = false;
        worker.once("message", payload => {
          received = true;
          if (payload.error) reject(Object.assign(new Error(payload.error.message), { code: payload.error.code }));
          else resolve(payload);
        });
        worker.once("error", reject);
        worker.once("exit", code => { if (!received) reject(new Error(`Sonic extraction worker exited before returning a fingerprint (${code}).`)); });
      });
      const embedding = message.embedding;
      const vector = embedding?.vector;
      const norm = Array.isArray(vector) ? vector.reduce((sum, value) => sum + value * value, 0) : 0;
      if (embedding?.identityKey !== identityKey || embedding?.sourceSha256 !== sourceSha256
        || embedding?.model !== this.provider.name || String(embedding?.modelVersion) !== this.provider.modelVersion
        || vector?.length !== this.provider.expectedDimensions || !vector.every(Number.isFinite)
        || !Number.isFinite(norm) || norm <= 0) {
        throw new Error("Discogs-EffNet returned an invalid fingerprint for the configured identity/model.");
      }
      const stored = this.store.upsertEmbedding(embedding);
      return { ...message.result, track: stored.track };
    } finally {
      this.backgroundExtractionActive = false;
    }
  }

  findSonicNeighbors(trackOrOptions, count = 20, options = {}) {
    const input = trackOrOptions && typeof trackOrOptions === "object" && !Array.isArray(trackOrOptions)
      ? trackOrOptions
      : { track: trackOrOptions };
    const reference = input.track || input;
    const safeCount = Math.max(1, Math.min(500, Number(input.count ?? count) || 20));
    const requestedModel = cleanText(input.model || input.provider || options.model || options.provider);
    const model = requestedModel || this.provider.name;
    const modelVersion = cleanText(input.modelVersion || options.modelVersion)
      || (!requestedModel || requestedModel === this.provider.name ? this.provider.modelVersion : "");
    const referenceText = typeof reference === "string" ? cleanText(reference) : "";
    const filePath = cleanText(reference?.filePath || reference?.path || (
      referenceText && !/^(?:tidal|roon|isrc|text|file|beatport):/i.test(referenceText) ? referenceText : ""
    ));
    let queryEmbedding = this.store.getEmbedding(reference, { model, modelVersion });
    let analyzed = null;
    if (!queryEmbedding && filePath && input.analyzeIfMissing !== false && options.analyzeIfMissing !== false) {
      analyzed = this.analyzeFile(filePath, typeof reference === "object" ? reference : {});
      queryEmbedding = this.store.getEmbedding(analyzed.identityKey, { model: analyzed.model, modelVersion: analyzed.modelVersion });
    }
    if (!queryEmbedding) {
      throw new Error("No stored sonic embedding exists for the requested track. Analyze a local audio file first.");
    }
    const neighbors = this.store.findNearest({
      track: queryEmbedding.identityKey,
      vector: queryEmbedding.vector,
      model: queryEmbedding.model,
      modelVersion: queryEmbedding.modelVersion,
      count: safeCount,
      excludeIdentityKeys: input.excludeIdentityKeys || options.excludeIdentityKeys || [],
      minSimilarity: input.minSimilarity ?? options.minSimilarity ?? -1,
      includeVector: input.includeVector === true || options.includeVector === true
    });
    const includeVector = input.includeVector === true || options.includeVector === true;
    return {
      ok: true,
      model: queryEmbedding.model,
      modelVersion: queryEmbedding.modelVersion,
      query: {
        identityKey: queryEmbedding.identityKey,
        track: queryEmbedding.track,
        analyzed,
        dimensions: queryEmbedding.dimensions,
        ...(includeVector ? { vector: queryEmbedding.vector } : {})
      },
      neighbors,
      diagnostics: {
        requested: safeCount,
        returned: neighbors.length,
        storage: this.store.status(),
        provider: this.provider.status()
      }
    };
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_MODEL_VERSION,
  DEFAULT_DISCOGS_EFFNET_DIMENSIONS,
  DEFAULT_DISCOGS_EFFNET_MODEL,
  DEFAULT_DISCOGS_EFFNET_OUTPUT,
  EssentiaDiscogsEffNetProvider,
  JsonCommandEmbeddingProvider,
  SonicEmbeddingEngine,
  SpectralBaselineProvider,
  decodeAudio,
  decodeAudioBuffer,
  resolveFilePath,
  sha256Buffer,
  sha256File,
  spectralBaselineEmbedding
};
