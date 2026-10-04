"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_DISCOGS_EFFNET_DIMENSIONS,
  DEFAULT_DISCOGS_EFFNET_MODEL,
  DEFAULT_DISCOGS_EFFNET_OUTPUT,
  EssentiaDiscogsEffNetProvider,
  SonicEmbeddingEngine,
  resolveFilePath
} = require("../src/sonicEmbeddingEngine");
const { SonicEmbeddingStore } = require("../src/sonicEmbeddingStore");

function tempDbFile() {
  return path.join(os.tmpdir(), `rabbit-hole-sonic-engine-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function cleanDb(file) {
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
}

test("transient audio analysis stores the provider result and reuses its source hash", () => {
  const dbFile = tempDbFile();
  let extractionCount = 0;
  const provider = {
    name: "test-buffer-provider",
    modelVersion: "1",
    status: () => ({ available: true, provider: "test", model: "test-buffer-provider", modelVersion: "1" }),
    extractBuffer: (buffer) => {
      extractionCount += 1;
      assert.equal(Buffer.isBuffer(buffer), true);
      return {
        vector: [1, 0],
        model: "test-buffer-provider",
        modelVersion: "1",
        sampleRate: 16000,
        audioDurationMs: 2500,
        metadata: { providerTest: true }
      };
    }
  };
  const store = new SonicEmbeddingStore({ dbFile, logger: null });
  const engine = new SonicEmbeddingEngine({ store, provider, logger: null });
  const track = {
    identityKey: "text:buffer-artist|transient-track|",
    artist: "Artist",
    title: "Transient Track"
  };
  const audio = Buffer.from("fake-compressed-audio");

  const first = engine.analyzeBuffer(audio, track, { sourceType: "transient-audio-stream" });
  const second = engine.analyzeBuffer(audio, track, { sourceType: "transient-audio-stream" });

  assert.equal(first.cached, false);
  assert.equal(first.sourceType, "transient-audio-stream");
  assert.equal(first.audioDurationMs, 2500);
  assert.equal(second.cached, true);
  assert.equal(extractionCount, 1);
  assert.equal(store.status().embeddingCount, 1);
  assert.equal(
    store.getEmbedding("text:buffer-artist|transient-track|").track.title,
    "Transient Track"
  );

  store.close();
  cleanDb(dbFile);
});

test("audio file path resolution preserves repeated whitespace in Windows filenames", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-hole-path-"));
  const filePath = path.join(tempDir, "Track  (Mixed)  copy.flac");
  fs.writeFileSync(filePath, Buffer.from("placeholder"));
  assert.equal(resolveFilePath(filePath), path.resolve(filePath));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Discogs-EffNet provider pins the learned embedding output and accepts PCM", () => {
  const worker = [
    "process.stdin.resume();",
    "process.stdin.on('data', () => {});",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ vector: [3, 4, 0], metadata: { outputShape: [1, 3] } })));"
  ].join(" ");
  const provider = new EssentiaDiscogsEffNetProvider({
    command: process.execPath,
    args: ["-e", worker],
    expectedDimensions: 3,
    modelName: DEFAULT_DISCOGS_EFFNET_MODEL,
    output: DEFAULT_DISCOGS_EFFNET_OUTPUT,
    modelPath: "test-model.pb"
  });

  assert.equal(provider.status().available, true);
  assert.equal(provider.name, "discogs-effnet");
  assert.equal(provider.modelName, DEFAULT_DISCOGS_EFFNET_MODEL);
  assert.equal(provider.output, DEFAULT_DISCOGS_EFFNET_OUTPUT);
  assert.equal(DEFAULT_DISCOGS_EFFNET_DIMENSIONS, 1280);
  const result = provider.extractSamples(new Float32Array([0, 0.25, -0.25]), 16000);
  assert.deepEqual(result.vector.map((value) => Number(value.toFixed(6))), [0.6, 0.8, 0]);
  assert.equal(result.model, "discogs-effnet");
  assert.equal(result.metadata.outputPurpose, "embeddings");
  assert.equal(result.metadata.inputType, "mono-float32-pcm");
});

test("Discogs-EffNet WSL invocation forwards the selected device and virtual environment", () => {
  const provider = new EssentiaDiscogsEffNetProvider({
    command: "wsl.exe",
    wslWrapperPath: "C:\\rabbit-hole\\scripts\\sonic-essentia-wsl.sh",
    device: "cuda",
    venv: "/home/darth/micromamba-root/envs/rabbit-hole-effnet-gpu"
  });

  assert.deepEqual(provider.workerArgs().slice(0, 4), [
    "env",
    "RABBIT_HOLE_SONIC_ESSENTIA_DEVICE=cuda",
    "RABBIT_HOLE_SONIC_ESSENTIA_VENV=/home/darth/micromamba-root/envs/rabbit-hole-effnet-gpu",
    "bash"
  ]);
});
