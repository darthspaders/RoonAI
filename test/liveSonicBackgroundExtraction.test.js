"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MusicMemoryStore } = require("../src/musicMemoryStore");
const { LiveSonicAnalysisService, SONIC_STATUS } = require("../src/liveSonicAnalysisService");
const { RecommendationEngineV2 } = require("../src/recommendationEngineV2");
const { EssentiaDiscogsEffNetProvider } = require("../src/sonicEmbeddingEngine");

const TIDAL_ID = "91000001";
const BEATPORT_ID = "92000001";
const PREVIEW_URL = "https://example.test/beatport-preview.wav";
const MODEL = "discogs-effnet";

function syntheticWav() {
  const sampleRate = 16000;
  const wav = Buffer.alloc(44 + sampleRate * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(sampleRate * 2, 40);
  for (let index = 0; index < sampleRate; index += 1) {
    wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 12000), 44 + index * 2);
  }
  return wav;
}

async function fixture(t, { modelVersion = "1", dimensions = 1280 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbit-hole-live-sonic-worker-"));
  const state = { pending: null, engine: null, memory: null };
  t.after(async () => {
    // Wait for an owned extraction before closing its parent-side databases.
    await state.pending?.catch(() => {});
    state.engine?.store.close();
    state.memory?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const preview = syntheticWav();
  const previewSha256 = createHash("sha256").update(preview).digest("hex");
  const observed = {
    artist: "Regression Artist",
    title: "Background Extraction",
    album: "Regression Album",
    isrc: "ZZTEST2600001",
    durationMs: 180000,
    roonIdentity: "roon-live-background-extraction"
  };
  const beatport = { ...observed, id: BEATPORT_ID, confidence: 99 };
  const metadata = {
    ...observed,
    // Enrichment's id is a Beatport id, while its URL confirms the TIDAL id.
    id: BEATPORT_ID,
    tidalUrl: `https://tidal.com/browse/track/${TIDAL_ID}`,
    confidence: 99,
    beatport
  };
  let previewFetched;
  const fetched = new Promise(resolve => { previewFetched = resolve; });
  const calls = [];
  // Only the model process is simulated. FFmpeg and the real provider still
  // decode this WAV and must deliver exactly one second of mono float PCM.
  const slowModel = [
    "let bytes=0;process.stdin.on('data',chunk=>{bytes+=chunk.length;});",
    "process.stdin.on('end',()=>{if(bytes!==64000)process.exit(2);",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);",
    `process.stdout.write(JSON.stringify({vector:Array.from({length:${dimensions}},(_,i)=>i===0?1:0)}));});`
  ].join("");
  const provider = new EssentiaDiscogsEffNetProvider({
    command: process.execPath,
    args: ["-e", slowModel],
    sampleRate: 16000,
    modelVersion,
    expectedDimensions: dimensions,
    timeoutMs: 10000
  });
  state.engine = new RecommendationEngineV2({
    enabled: true,
    dbFile: path.join(directory, "sonic.sqlite"),
    embeddingProviderInstance: provider,
    beatportClient: {
      findTrack: async (track, options) => {
        calls.push({ track, options });
        assert.equal(track.id, TIDAL_ID);
        assert.equal(track.tidalId, TIDAL_ID);
        assert.equal(options.beatportTrackId, BEATPORT_ID);
        return beatport;
      },
      fetchPreviewBuffer: async () => {
        previewFetched();
        return {
          buffer: preview,
          bytes: preview.length,
          contentType: "audio/wav",
          previewUrl: PREVIEW_URL,
          previewDurationMs: 1000
        };
      }
    },
    logger: null
  });
  state.memory = new MusicMemoryStore({ dbFile: path.join(directory, "memory.sqlite"), logger: null });
  return { state, preview, previewSha256, observed, metadata, fetched, calls, modelVersion, dimensions };
}

async function assertPendingWhileTimerRuns(f) {
  await Promise.race([
    f.fetched,
    f.state.pending.then(() => { throw new Error("Analysis completed without fetching the fixture preview."); })
  ]);
  let timerRan = false;
  await new Promise(resolve => setTimeout(() => { timerRan = true; resolve(); }, 20));
  assert.equal(timerRan, true);
  assert.equal(f.state.engine.store.getEmbedding(`tidal:${TIDAL_ID}`, {
    model: MODEL, modelVersion: f.modelVersion
  }), null, "a main-thread timer runs before the slow learned extraction persists its profile");
  assert.equal(f.state.engine.sonic.backgroundExtractionActive, true);
  assert.ok(f.preview.some(byte => byte !== 0), "the owned preview remains available until extraction finishes");
}

function assertPersistedAnalysis(f, result) {
  const profile = f.state.engine.store.getEmbedding(`tidal:${TIDAL_ID}`, {
    model: MODEL, modelVersion: f.modelVersion
  });
  assert.ok(profile);
  assert.equal(result.ok, true);
  assert.equal(result.identityKey, `tidal:${TIDAL_ID}`);
  assert.equal(result.model, MODEL);
  assert.equal(result.modelVersion, f.modelVersion);
  assert.equal(result.dimensions, f.dimensions);
  assert.equal(result.relation, "exact");
  assert.equal(profile.vector.length, f.dimensions);
  assert.equal(profile.sourceSha256, f.previewSha256);
  assert.equal(profile.sampleRate, 16000);
  assert.equal(profile.audioDurationMs, 1000);
  assert.equal(profile.track.artist, f.observed.artist);
  assert.equal(profile.track.title, f.observed.title);
  assert.equal(profile.track.tidalId, TIDAL_ID);
  assert.equal(profile.track.isrc, f.observed.isrc);
  assert.deepEqual(result.track, profile.track, "the async API returns the same normalized track and provenance as storage");
  const metadata = profile.track.metadata;
  assert.equal(metadata.sourceType, "beatport-preview");
  assert.equal(metadata.sourceProvider, "beatport");
  assert.equal(metadata.sourceTrackId, BEATPORT_ID);
  assert.equal(metadata.canonicalProvider, "tidal");
  assert.equal(metadata.canonicalTrackId, TIDAL_ID);
  assert.equal(metadata.identityRelation, "exact");
  assert.equal(metadata.partialPreview, true);
  assert.equal(metadata.previewUrl, PREVIEW_URL);
  assert.equal(metadata.previewBytes, f.preview.length);
  assert.equal(metadata.previewContentType, "audio/wav");
  assert.equal(metadata.previewDurationMs, 1000);
  assert.ok(f.preview.every(byte => byte === 0), "the original fetched preview is cleared after awaiting analysis");
  assert.equal(f.state.engine.sonic.backgroundExtractionActive, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.engine.store.getEmbedding(`tidal:${BEATPORT_ID}`), null, "the Beatport id never becomes a TIDAL identity");
}

test("automatic live Essentia analysis stays responsive and preserves exact source identities without explicit extraction options", { timeout: 15000 }, async t => {
  if (spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0) return t.skip("FFmpeg is not installed");
  const f = await fixture(t);
  const service = new LiveSonicAnalysisService({
    enabled: true,
    autoAnalyze: true,
    musicMemory: f.state.memory,
    metadataEnrichment: { enrich: async () => f.metadata },
    recommendationEngine: f.state.engine,
    logger: null
  });
  f.state.pending = service.observe(f.observed);
  await assertPendingWhileTimerRuns(f);
  assert.equal(service.status().activeAnalyses, 1);
  assert.equal(service.status().pending, 1);
  assert.equal(f.state.memory.findSonicAnalysisRequest(f.observed).status, SONIC_STATUS.ANALYZING_BEATPORT_PREVIEW);
  const result = await f.state.pending;
  assert.equal(result.status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(result.analyzed, true);
  assertPersistedAnalysis(f, result.result);
  const request = f.state.memory.findSonicAnalysisRequest(f.observed);
  assert.equal(request.identity_key, `tidal:${TIDAL_ID}`);
  assert.equal(request.tidal_id, TIDAL_ID);
  assert.equal(request.beatport_track_id, BEATPORT_ID);
  assert.equal(request.status, SONIC_STATUS.ANALYZED_BEATPORT_PREVIEW);
  assert.equal(request.source_audio_type, "beatport_preview");
  assert.equal(f.state.memory.db.prepare("SELECT COUNT(*) AS count FROM sonic_analysis_request").get().count, 1);
  assert.equal(service.status().activeAnalyses, 0);
  assert.equal(service.status().pending, 0);
});

for (const configuration of [{ modelVersion: "1", dimensions: 1280 }, { modelVersion: "2", dimensions: 3 }]) {
  test(`direct Essentia preview analysis defaults to a responsive worker and retains provider version ${configuration.modelVersion}`, { timeout: 15000 }, async t => {
    if (spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0) return t.skip("FFmpeg is not installed");
    const f = await fixture(t, configuration);
    f.state.pending = f.state.engine.analyzeBeatportPreviewForTidalTrack({
      ...f.observed,
      id: TIDAL_ID,
      tidalId: TIDAL_ID,
      tidalUrl: f.metadata.tidalUrl,
      beatportTrackId: BEATPORT_ID
    });
    await assertPendingWhileTimerRuns(f);
    assertPersistedAnalysis(f, await f.state.pending);
  });
}
