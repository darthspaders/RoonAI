"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JsonCommandEmbeddingProvider } = require("./sonicEmbeddingEngine");
const { SonicAnalysisWorker, wslPath } = require("./sonicAnalysisWorker");
const { analysisSpec } = require("./sonicAnalysisSpec");

// Preserve the tested specification and its separate vector namespace. The
// FullSong checkpoint currently receives a centered 30-second excerpt.
class SonicFullSongProvider extends JsonCommandEmbeddingProvider {
  constructor({ worker, device = process.env.SONIC_ANALYSIS_DEVICE || "cuda", timeoutMs = 540000 } = {}) {
    const spec = analysisSpec("mert-fullsong");
    const python = `${process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2"}/bin/python`;
    const script = path.join(__dirname, "..", "scripts", "sonic-mert-embed.py");
    super({ command: process.platform === "win32" ? "wsl.exe" : python,
      args: [...(process.platform === "win32" ? ["-d", "Ubuntu", "--", python, wslPath(script)] : [script]),
        "--spec", spec.id, "--device", device, "--file", "{{file}}"],
      model: spec.repo, modelVersion: spec.key, timeoutMs });
    this.spec = spec;
    this.expectedDimensions = spec.dimensions;
    this.analysisWorker = worker || new SonicAnalysisWorker({ device, timeoutMs });
  }
  status() {
    return { ...super.status(), provider: "mert-fullsong", revision: this.spec.revision,
      analyzedWindowSeconds: this.spec.windowSeconds, backgroundExtraction: true };
  }
  validate(result) {
    const norm = Array.isArray(result.vector) && result.vector.reduce((sum, n) => sum + n * n, 0);
    if (result.specKey !== this.spec.key || result.revision !== this.spec.revision
      || result.sampleRate !== this.spec.sampleRate || result.vector?.length !== this.expectedDimensions
      || !result.vector.every(Number.isFinite) || !Number.isFinite(norm) || norm <= 0
      || !(result.audioDurationSeconds > 0) || !(result.analyzedSeconds > 0)
      || result.analyzedSeconds > this.spec.windowSeconds + .01) {
      throw new Error("FullSong returned a fingerprint that does not match the pinned analysis specification.");
    }
    return { ...result, model: this.name, modelVersion: this.modelVersion,
      audioDurationMs: Math.round(result.audioDurationSeconds * 1000),
      metadata: { analysisSpec: this.spec, revision: this.spec.revision,
        audioDurationSeconds: result.audioDurationSeconds, segments: result.segments,
        analyzedSeconds: result.analyzedSeconds, sourceCoverage: result.sourceCoverage } };
  }
  extract(file) {
    return this.validate(super.extract(process.platform === "win32" ? wslPath(file) : file));
  }
  async extractBufferAsync(audio) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabbit-fullsong-"));
    const file = path.join(directory, "preview.audio");
    try {
      await require("./sonicAnalyzedAudio").retainSource(audio);
      await fs.writeFile(file, audio);
      return this.validate(await this.analysisWorker.run(file, this.spec));
    } finally {
      await fs.unlink(file).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  }
  close() { this.analysisWorker.stop(); }
}

module.exports = { SonicFullSongProvider };
