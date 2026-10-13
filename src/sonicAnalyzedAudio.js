"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { wslPath } = require("./sonicAnalysisWorker");
const { MODEL, MODEL_VERSION, validCoverageEmbedding } = require("./sonicCoverageIdentity");
const { storedSonicIdentityMatches } = require("./sonicProfileIdentity");
const cache = path.join(__dirname, "..", "data", "sonic-analyzed-audio");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function retainSource(audio, directory = cache) {
  const sha256 = digest(audio), file = path.join(directory, `${sha256}.audio`);
  await fs.mkdir(directory, { recursive: true });
  try { await fs.writeFile(file, audio, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (digest(await fs.readFile(file)) !== sha256) throw new Error("Analyzed source cache hash mismatch.");
  return { file, sha256 };
}
class SonicAnalyzedAudio {
  constructor({ store, directory = cache, runner = execFile } = {}) { this.store = store; this.directory = directory; this.runner = runner; this.pending = new Map(); }
  async describe(identity) {
    const embedding = this.store.getEmbedding(identity, { model: MODEL, modelVersion: MODEL_VERSION });
    if (!validCoverageEmbedding(embedding) || !storedSonicIdentityMatches(embedding, identity)) return { status: "unavailable", reason: "No verified MERT-v2 FullSong embedding." };
    const metadata = embedding.track.metadata, provenance = metadata.provenance || metadata;
    const result = { status: "ready", model: embedding.model, modelVersion: embedding.modelVersion,
      dimensions: embedding.dimensions, generatedAt: embedding.updatedAt, sourceSha256: embedding.sourceSha256,
      artifactKey: metadata.artifactKey || embedding.sourceSha256, sourceType: provenance.sourceType || metadata.sourceType,
      revision: metadata.analysisSpec?.revision, analyzedSeconds: metadata.analyzedSeconds,
      selection: "Centered 30 seconds (or entire source if shorter), mono 24 kHz, from the hash-verified analyzed source. FullSong is the checkpoint name; this specification uses one excerpt." };
    const key = digest(`${MODEL_VERSION}:${embedding.sourceSha256}:center-wav-v1`);
    if (!this.pending.has(key)) this.pending.set(key, this.prepare(embedding, key).finally(() => this.pending.delete(key)));
    try { Object.assign(result, await this.pending.get(key), { url: `/api/recommendation-v2/sonic-review/audio?clipId=${key}` }); }
    catch (error) { result.status = "unavailable"; result.reason = error.message; }
    return result;
  }
  async prepare(embedding, key) {
    const receiptPath = path.join(this.directory, `${key}.json`), output = path.join(this.directory, `${key}.wav`);
    try {
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      if (digest(await fs.readFile(output)) === receipt.wavSha256 && receipt.sourceSha256 === embedding.sourceSha256) return receipt;
    } catch { /* Missing or invalid clip is regenerated only from verified original bytes. */ }
    const metadata = embedding.track.metadata, provenance = metadata.provenance || metadata;
    let source = path.join(this.directory, `${embedding.sourceSha256}.audio`), audio;
    try { audio = await fs.readFile(source); } catch {
      let original = embedding.track.sourcePath;
      if (!original && provenance.localFileId) original = this.store.db.prepare("SELECT file_path FROM local_library_file WHERE id=?").get(provenance.localFileId)?.file_path;
      if (original) {
        try { audio = await fs.readFile(original); } catch { throw new Error("The original analyzed local audio is unavailable."); }
      } else {
        // Recover only the exact stored analysis URL and require the original byte hash.
        const address = provenance.previewUrl || provenance.sourcePreviewUrl;
        let url; try { url = new URL(address); } catch { throw new Error("The original analyzed source was not retained and has no recoverable source URL."); }
        if (url.protocol !== "https:" || !["geo-samples.beatport.com", "samples.beatport.com"].includes(url.hostname)) throw new Error("Analyzed source unavailable locally; this source requires explicit reacquisition.");
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Original analyzed source unavailable (HTTP ${response.status}).`);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error("Analyzed source exceeds preview recovery size limit."); chunks.push(chunk); }
        audio = Buffer.concat(chunks);
      }
      if (digest(audio) !== embedding.sourceSha256) throw new Error("Source bytes changed since analysis; refusing to substitute different audio.");
      source = (await retainSource(audio, this.directory)).file;
    }
    if (digest(audio) !== embedding.sourceSha256) throw new Error("Analyzed source hash mismatch; preview unavailable.");
    const duration = metadata.audioDurationSeconds || embedding.audioDurationMs / 1000;
    if (!(duration > 0 && duration <= 7200)) throw new Error("Analyzed source duration is unavailable.");
    const seconds = Math.min(30, duration), start = Number(((duration - seconds) / 2).toFixed(6));
    const temp = path.join(this.directory, `${key}.${randomUUID()}.wav`);
    const args = ["-nostdin", "-v", "error", "-threads", "2", "-i", process.platform === "win32" ? wslPath(source) : source,
      "-ss", String(start), "-t", String(seconds), "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", process.platform === "win32" ? wslPath(temp) : temp];
    try {
      await this.runner(process.platform === "win32" ? "wsl.exe" : "ffmpeg", process.platform === "win32" ? ["-d", "Ubuntu", "--", `${process.env.SONIC_ANALYSIS_ENV_ROOT || "/home/darth/micromamba-root/envs/rabbit-hole-mert2"}/bin/ffmpeg`, ...args] : args, { timeout: 120000, windowsHide: true });
      const bytes = await fs.readFile(temp);
      const receipt = { sourceSha256: embedding.sourceSha256, wavSha256: digest(bytes), startSeconds: start, durationSeconds: seconds, model: MODEL, modelVersion: MODEL_VERSION };
      await fs.rename(temp, output); await fs.writeFile(receiptPath, JSON.stringify(receipt));
      return receipt;
    } catch (error) { throw new Error("Audio excerpt decoder failed: " + String(error.stderr || error.code || error.message).slice(0, 400));
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async serve(req, res, url) {
    const key = url.searchParams.get("clipId");
    if (!/^[a-f0-9]{64}$/.test(key || "")) { res.writeHead(404); return res.end(); }
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(this.directory, `${key}.json`), "utf8"));
      const bytes = await fs.readFile(path.join(this.directory, `${key}.wav`));
      if (digest(bytes) !== receipt.wavSha256) throw new Error("Preview cache changed.");
      const range = require("./sonicBlindAudio").byteRange(req.headers.range, bytes.length);
      if (!range) { res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }); return res.end(); }
      res.writeHead(range.partial ? 206 : 200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache", "Content-Length": range.end - range.start + 1,
        ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}` } : {}) });
      res.end(req.method === "HEAD" ? undefined : bytes.subarray(range.start, range.end + 1));
    } catch { res.writeHead(503); res.end("Analyzed audio unavailable. Refresh preview diagnostics to retry."); }
  }
}
module.exports = { SonicAnalyzedAudio, retainSource, digest };
