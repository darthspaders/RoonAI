"use strict";
// Render only frozen 30s listening spans. No playback, main database writes,
// provider requests or model inference. A prepared plan is still unpublished.
const path = require("node:path"), fs = require("node:fs"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto"), { execFileSync } = require("node:child_process");
const fresh = require("./sonic-catalog-scout-fresh"), { ROOT, DIRECTORY, sha, read, save, update, ownedPath, withDb } = fresh;
const review = require("../src/sonicCatalogFreshReview"), { validateWave } = require("./sonic-prepare-blind-review"), { wslPath } = require("../src/sonicAnalysisWorker");
function main() {
  const planFile = path.join(DIRECTORY, "review-plan.json"), plan = read(planFile), lock = path.join(ROOT, "data/sonic-blind-preparation.lock"), token = randomUUID(), cacheDirectory = path.join(DIRECTORY, "blind-audio");
  assert.ok(!fs.existsSync(path.join(DIRECTORY, "publication.json")), "An already published listening plan cannot be altered");
  require("./sonic-catalog-fresh-encode").check(); withDb(db => review.validateFreshCatalogReviewPlan(plan, { db, artifactRoot: ROOT }));
  assert.equal(plan.recipe.samplingScope, "raw-techno-only"); assert.ok(plan.count <= 6 && Object.keys(plan.clips).length <= 8);
  save(lock, { token, pid: process.pid, directory: DIRECTORY, at: new Date().toISOString() });
  try {
    fresh.guard("before-listening-audio"); fs.mkdirSync(cacheDirectory, { recursive: true }); ownedPath(cacheDirectory);
    save(path.join(DIRECTORY, "review-plan-unprepared.json"), plan);
    for (const clip of Object.values(plan.clips)) {
      ownedPath(clip.sourceFile); assert.equal(sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256);
      const target = ownedPath(path.join(cacheDirectory, clip.clipId + ".wav")); assert.ok(!fs.existsSync(target));
      execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "/home/darth/micromamba-root/envs/rabbit-hole-mert2/bin/ffmpeg", "-v", "error", "-nostdin", "-i", wslPath(clip.sourceFile), "-ss", String(clip.start), "-t", String(clip.end - clip.start), "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-n", wslPath(target)], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
      assert.equal(sha(fs.readFileSync(clip.sourceFile)), clip.sourceSha256); validateWave(target, clip); clip.wavSha256 = sha(fs.readFileSync(target)); update(planFile, plan);
    }
    withDb(db => review.validateFreshCatalogReviewPlan(plan, { db, requirePrepared: true, cacheDirectory, artifactRoot: ROOT })); require("./sonic-catalog-fresh-encode").check();
    save(path.join(DIRECTORY, "audio-preparation.json"), { passed: true, at: new Date().toISOString(), preparedClips: Object.keys(plan.clips).length, pairs: plan.count, format: "PCM16 mono 24000Hz", spanSeconds: 30, reviewPlanSha256: sha(fs.readFileSync(planFile)), published: false, playbackInvoked: false, mainDatabaseWrites: 0 });
    console.log(JSON.stringify({ audioPrepared: true, uniqueClips: Object.keys(plan.clips).length, pairs: plan.count, published: false }));
  } finally { assert.equal(read(lock).token, token); fs.unlinkSync(lock); }
}
if (require.main === module) { try { main(); } catch { console.error("Fresh listening audio preparation failed; existing receipts retained."); process.exitCode = 1; } }
module.exports = { main };
