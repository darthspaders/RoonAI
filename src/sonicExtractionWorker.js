"use strict";

// Execute the existing FFmpeg -> PCM -> Essentia path off the HTTP/Roon thread.
// Only the parent writes the resulting fingerprint to the existing store.
const { parentPort, workerData } = require("node:worker_threads");
const { SonicEmbeddingEngine, EssentiaDiscogsEffNetProvider } = require("./sonicEmbeddingEngine");

if (parentPort) {
  let audio;
  try {
    audio = Buffer.from(workerData.audio);
    let embedding;
    const store = {
      getEmbedding: () => null,
      upsertEmbedding: value => {
        embedding = value;
        return { ...value, dimensions: value.vector.length, track: value.track };
      }
    };
    const sonic = new SonicEmbeddingEngine({ store, provider: new EssentiaDiscogsEffNetProvider(workerData.provider) });
    const result = sonic.analyzeBuffer(audio, workerData.track, workerData.options);
    parentPort.postMessage({ result, embedding });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code } });
  } finally {
    audio?.fill(0);
    parentPort.close();
  }
}
